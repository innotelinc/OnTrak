#!/usr/bin/env node
/**
 * `genie` — the OnTrak Genie console, in a terminal.
 *
 * The server was always meant to be driven by something that is not a tab
 * (`GET /api/approvals` says so); this is that driver. It is a **client**, not a
 * second agent: every turn, every tool call and every approval decision happens
 * on the server, and this renders them and answers the gate when it opens.
 *
 *   genie login                 sign in (browser-assisted)
 *   genie                       chat interactively
 *   genie ask "<task>"          one turn and exit
 *   genie sessions | skills | models | whoami | logout
 *
 * In the REPL, a line that starts with `/` is a CLI command (`/help` lists
 * them), a bare number picks a follow-up offered by the last turn, and anything
 * else is a task for the agent.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { GenieClient, GenieError, type ChatRequest, type PendingApproval } from "./client.js";
import { helpLines, matchCommands, parseCommand } from "./commands.js";
import { configPath, resolveTarget, skillDirs, writeConfig, type ResolvedTarget } from "./config.js";
import { emptyTurnSummary, reduceTurn, suggestFollowups, type TurnSummary } from "./followups.js";
import { LoginFailure, browserLogin, cookieLogin, tokenLogin } from "./login.js";
import {
  MarkdownStream,
  Spinner,
  Theme,
  banner,
  eventError,
  eventNotice,
  renderApproval,
  renderDiff,
  renderToolCall,
  renderToolResult,
  speaker,
  supportsColor,
  terminalWidth,
} from "./render.js";
import { composeSkillMessage, describeSkills, loadSkills, type Skill } from "./skills.js";
import type { AgentEvent } from "../agent.js";
import type { Session, SessionSummary } from "../store.js";

const VERSION = readVersion();

function readVersion(): string {
  try {
    const file = path.join(import.meta.dirname, "..", "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface CliArgs {
  command: string;
  rest: string[];
  url?: string;
  token?: string;
  cookie?: string;
  model?: string;
  session?: string;
  skill?: string;
  maxSteps?: number;
  json: boolean;
  yes: boolean;
  color: boolean;
  help: boolean;
  version: boolean;
}

/** A flag parser for the handful of flags this CLI has. No dependency, no surprises. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: "",
    rest: [],
    json: false,
    yes: false,
    color: true,
    help: false,
    version: false,
  };
  const takeValue = (flag: string, index: number): string => {
    const inline = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : undefined;
    if (inline !== undefined) return inline;
    return argv[index + 1] ?? "";
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (name) {
      case "--url":
        args.url = takeValue(arg, i);
        if (!arg.includes("=")) i += 1;
        break;
      case "--token":
        args.token = takeValue(arg, i);
        if (!arg.includes("=")) i += 1;
        break;
      case "--cookie":
        args.cookie = takeValue(arg, i);
        if (!arg.includes("=")) i += 1;
        break;
      case "--model":
      case "-m":
        args.model = takeValue(arg, i);
        if (!arg.includes("=")) i += 1;
        break;
      case "--session":
      case "-s":
        args.session = takeValue(arg, i);
        if (!arg.includes("=")) i += 1;
        break;
      case "--skill":
        args.skill = takeValue(arg, i);
        if (!arg.includes("=")) i += 1;
        break;
      case "--max-steps":
        args.maxSteps = Number.parseInt(takeValue(arg, i), 10);
        if (!arg.includes("=")) i += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--no-color":
        args.color = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        if (name.startsWith("-") && name !== "-") {
          // Unknown flags are a typo worth reporting rather than silently a task.
          throw new Error(`unknown option ${name}`);
        }
        if (args.command === "") args.command = arg;
        else args.rest.push(arg);
    }
  }
  return args;
}

const TOP_LEVEL_HELP = `genie ${VERSION} — OnTrak Genie from the terminal

usage:
  genie                        chat interactively
  genie ask "<task>"           run one turn and exit
  genie login                  sign in through the deployment (browser-assisted)
  genie logout                 forget the stored credential
  genie whoami                 show the server, identity and plan in force
  genie sessions [--json]      list chats
  genie skills                 list available skills
  genie models [filter]        list models the gateway advertises
  genie help                   this text

options:
  --url <origin>               deployment to dial (default from config, else :3400)
  --token <value>              WEB_TOKEN bearer
  --cookie <value>             paste a session cookie instead of signing in
  --model <id>                 model for this run
  --session <id>               continue an existing chat
  --skill <name>               apply a skill to the task
  --max-steps <n>              step budget for this run
  --yes                        approve gated actions without asking (non-interactive)
  --json                       machine-readable output where it applies
  --no-color                   plain output`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${TOP_LEVEL_HELP}\n`);
    return 2;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help || args.command === "help") {
    process.stdout.write(`${TOP_LEVEL_HELP}\n`);
    return 0;
  }

  // `login` is the one command that must work before there is a credential, so
  // it is dispatched on defaults rather than through the authorized path.
  if (args.command === "login") return await commandLogin(args);
  if (args.command === "logout") return commandLogout();

  const target = resolveTarget({ url: args.url, token: args.token });
  if (args.cookie !== undefined) target.cookie = args.cookie;
  const client = new GenieClient({ base: target.base, token: target.token, cookie: target.cookie });
  const theme = new Theme(args.color && supportsColor(process.stdout));

  switch (args.command) {
    case "":
      return await runRepl(client, target, args, theme);
    case "ask": {
      const task = args.rest.join(" ").trim();
      if (task === "") {
        process.stderr.write('ask needs a task: genie ask "run the tests"\n');
        return 2;
      }
      return await runOnce(client, args, theme, task);
    }
    case "whoami":
      return await commandWhoami(client, args);
    case "sessions":
      return await commandSessions(client, args);
    case "skills":
      return commandSkills(theme);
    case "models":
      return await commandModels(client, args);
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${TOP_LEVEL_HELP}\n`);
      return 2;
  }
}

// --- simple subcommands -----------------------------------------------------

async function commandLogin(args: CliArgs): Promise<number> {
  const target = resolveTarget({ url: args.url, token: args.token });
  try {
    if (args.token !== undefined && args.token !== "") {
      const result = await tokenLogin(target.base, args.token);
      process.stdout.write(`signed in as ${describe(result.identity)} (shared token)\n`);
      return 0;
    }
    if (args.cookie !== undefined && args.cookie !== "") {
      const result = await cookieLogin(target.base, args.cookie);
      process.stdout.write(`signed in as ${describe(result.identity)} (pasted session)\n`);
      return 0;
    }
    const result = await browserLogin(target.base, {
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`signed in as ${describe(result.identity)}\n`);
    process.stdout.write(`credential stored in ${readConfigPath()}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof LoginFailure ? error.message : (error as Error).message;
    process.stderr.write(`sign-in failed: ${message}\n`);
    return 1;
  }
}

function commandLogout(): number {
  writeConfig({ cookie: undefined, token: undefined });
  process.stdout.write("signed out — the stored credential was removed\n");
  return 0;
}

function describe(identity: { name: string; email: string }): string {
  if (identity.email !== "") return identity.email;
  if (identity.name !== "") return identity.name;
  return "an unnamed account";
}

function readConfigPath(): string {
  return configPath();
}

async function commandWhoami(client: GenieClient, args: CliArgs): Promise<number> {
  const [status, health] = await Promise.all([client.status(), client.health().catch(() => null)]);
  const payload = {
    server: client.origin,
    authenticated: status.authenticated,
    identity: status.identity,
    model: args.model ?? health?.model ?? null,
    modelSelection: health?.modelSelection ?? null,
    plan: health?.plan ?? null,
    approval: health?.approval?.mode ?? null,
    tenancy: health?.tenancy ?? false,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`server     ${client.origin}\n`);
    process.stdout.write(`identity   ${status.identity ? describe(status.identity) : "(none)"}\n`);
    process.stdout.write(`model      ${payload.model ?? "(unknown)"}${payload.modelSelection === "auto" ? " (auto)" : ""}\n`);
    process.stdout.write(`plan       ${payload.plan ?? "(unreported)"}\n`);
    process.stdout.write(`approval   ${payload.approval ?? "(unknown)"}\n`);
    process.stdout.write(`tenancy    ${payload.tenancy ? "on" : "off"}\n`);
  }
  return status.authenticated ? 0 : 1;
}

/** A stable one-based index for a chat list, so `/resume 2` means something. */
export function indexSessions(sessions: SessionSummary[]): Map<number, SessionSummary> {
  const map = new Map<number, SessionSummary>();
  sessions.forEach((session, index) => map.set(index + 1, session));
  return map;
}

function formatSessionRow(index: number, session: SessionSummary): string {
  const when = session.updatedAt.slice(0, 16).replace("T", " ");
  const flags = [session.archived ? "archived" : "", session.model ?? ""].filter(Boolean).join(" ");
  return `  ${String(index).padStart(3)}  ${when}  ${session.title.slice(0, 44).padEnd(44)} ${session.messageCount
    .toString()
    .padStart(3)} msg  ${session.id.slice(0, 8)}${flags === "" ? "" : `  (${flags})`}`;
}

async function commandSessions(client: GenieClient, args: CliArgs): Promise<number> {
  const sessions = await client.sessions();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    process.stdout.write("no chats yet\n");
    return 0;
  }
  const indexed = indexSessions(sessions);
  for (const [index, session] of indexed) process.stdout.write(`${formatSessionRow(index, session)}\n`);
  return 0;
}

function commandSkills(theme: Theme): number {
  const skills = loadSkills(skillDirs(process.cwd()));
  process.stdout.write(`${theme.bold("skills")}\n`);
  for (const line of describeSkills(skills)) process.stdout.write(`${line}\n`);
  return 0;
}

async function commandModels(client: GenieClient, args: CliArgs): Promise<number> {
  const { models, model, error } = await client.models();
  const filter = (args.rest[0] ?? "").toLowerCase();
  const shown = filter === "" ? models : models.filter((id) => id.toLowerCase().includes(filter));
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ model, models: shown }, null, 2)}\n`);
    return 0;
  }
  if (error !== undefined) process.stderr.write(`gateway catalog unavailable: ${error}\n`);
  process.stdout.write(`default model: ${model}\n`);
  for (const id of shown) process.stdout.write(`  ${id}\n`);
  if (shown.length === 0) process.stdout.write("  (no models matched)\n");
  return 0;
}

// --- one-shot turn ----------------------------------------------------------

/**
 * `genie ask` — one turn, no prompt loop.
 *
 * Approval is answered by `--yes` when given; otherwise a TTY is asked and a
 * non-TTY **denies**, because a pipe cannot consent and the safe default for an
 * unattended run is not to run the destructive thing.
 */
async function runOnce(client: GenieClient, args: CliArgs, theme: Theme, task: string): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    const text = applySkillIfAny(args, task);
    const { sessionId, ok } = await runTurn(client, rl, theme, {
      task: text,
      sessionId: args.session,
      model: args.model,
      maxSteps: args.maxSteps,
      approve: args.yes,
      interactive: process.stdin.isTTY === true,
    });
    process.stdout.write(`${theme.gray(sessionId === null ? "" : `chat ${sessionId.slice(0, 8)}`)}\n`);
    return ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${theme.red("error:")} ${(error as Error).message}\n`);
    return 1;
  } finally {
    rl.close();
  }
}

function applySkillIfAny(args: CliArgs, task: string): string {
  if (args.skill === undefined || args.skill === "") return task;
  const skills = loadSkills(skillDirs(process.cwd()));
  const wanted = args.skill.trim().toLowerCase();
  const skill =
    skills.find((entry) => entry.name === wanted) ??
    skills.find((entry) => entry.name.startsWith(wanted));
  if (skill === undefined) {
    throw new Error(`no skill named "${args.skill}" — try \`genie skills\``);
  }
  return composeSkillMessage(skill, task);
}

// --- the turn ---------------------------------------------------------------

interface TurnOptions {
  task: string;
  sessionId?: string;
  model?: string;
  maxSteps?: number;
  /** Answer every gate with approve without asking (non-interactive `--yes`). */
  approve: boolean;
  /** Whether a gate may be answered at the keyboard at all. */
  interactive: boolean;
}

interface TurnOutcome {
  sessionId: string | null;
  ok: boolean;
  summary: TurnSummary;
}

/**
 * Run a turn and render it.
 *
 * The events drive the output as they arrive. An `approval_request` does not
 * block the stream — the server parks the turn on a second connection — so the
 * decision is kicked off asynchronously and answered through
 * `POST /api/approvals/:id`, which is the same route the browser card uses.
 */
async function runTurn(
  client: GenieClient,
  rl: readline.Interface,
  theme: Theme,
  options: TurnOptions,
): Promise<TurnOutcome> {
  const width = terminalWidth();
  const summary = emptyTurnSummary();
  let sessionId = options.sessionId ?? null;
  let ok = true;
  const decisions: Promise<void>[] = [];
  const spinner = new Spinner(theme, process.stdout.isTTY === true, (text) => process.stderr.write(text));
  const markdown = new MarkdownStream(theme, (text) => process.stdout.write(text));

  process.stdout.write(`\n${speaker(theme, "genie")}\n`);
  spinner.start("thinking…");

  const request: ChatRequest = { message: options.task };
  if (sessionId !== null) request.sessionId = sessionId;
  if (options.model !== undefined) request.model = options.model;
  if (options.maxSteps !== undefined) request.maxSteps = options.maxSteps;

  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once("SIGINT", onInterrupt);

  try {
    await client.chat(
      request,
      {
        onEvent: (event) => {
          sessionId = applyEvent(event, summary, {
            theme,
            width,
            spinner,
            markdown,
            decisions,
            client,
            rl,
            approve: options.approve,
            interactive: options.interactive,
          }) ?? sessionId;
          if (event.type === "error") ok = false;
        },
      },
      controller.signal,
    );
  } catch (error) {
    spinner.stop();
    markdown.end();
    if (error instanceof GenieError) {
      process.stdout.write(`${eventError(theme, error.message)}\n`);
      if (error.unauthorized) {
        process.stdout.write(`${theme.gray("  run `genie login` to sign in, then try again.")}\n`);
      }
    } else {
      process.stdout.write(`${eventError(theme, (error as Error).message)}\n`);
    }
    ok = false;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    spinner.stop();
    markdown.end();
    await Promise.allSettled(decisions);
  }

  return { sessionId, ok, summary };
}

interface EventContext {
  theme: Theme;
  width: number;
  spinner: Spinner;
  markdown: MarkdownStream;
  decisions: Promise<void>[];
  client: GenieClient;
  rl: readline.Interface;
  approve: boolean;
  interactive: boolean;
}

/**
 * Render one event. Returns a session id when the stream told us one.
 *
 * Kept as one function so the mapping from event to output is readable in one
 * place — which is the whole product argument, applied to the CLI's own code.
 */
function applyEvent(event: AgentEvent, summary: TurnSummary, ctx: EventContext): string | null {
  const { theme, width, spinner, markdown } = ctx;
  reduceTurn(summary, event);
  switch (event.type) {
    case "session":
      spinner.stop();
      process.stdout.write(`${theme.gray(`· chat ${event.id.slice(0, 8)}`)}\n`);
      return event.id;
    case "step":
      spinner.update(`step ${event.index}/${event.of}`);
      return null;
    case "text":
      spinner.stop();
      markdown.push(event.text);
      return null;
    case "draft": {
      spinner.stop();
      if (event.started) {
        markdown.end();
        process.stdout.write(
          `${theme.gray("· writing")} ${theme.bold(event.path ?? event.name)}${event.streamed ? "" : theme.gray(" (one frame)")}\n`,
        );
      }
      return null;
    }
    case "tool_call": {
      spinner.stop();
      markdown.end();
      process.stdout.write(`\n${renderToolCall(theme, event)}\n`);
      return null;
    }
    case "tool_result": {
      for (const line of renderToolResult(theme, event, width)) process.stdout.write(`${line}\n`);
      return null;
    }
    case "approval_request": {
      spinner.stop();
      markdown.end();
      ctx.decisions.push(answerApproval(ctx, event));
      return null;
    }
    case "approval_result":
      return null;
    case "gateway":
      process.stdout.write(`${eventNotice(theme, `gateway ${event.mode}: ${event.model}`)}\n`);
      return null;
    case "notice":
      process.stdout.write(`${eventNotice(theme, event.text)}\n`);
      return null;
    case "error":
      spinner.stop();
      markdown.end();
      process.stdout.write(`${eventError(theme, event.message)}\n`);
      return null;
    case "done":
      spinner.stop();
      markdown.end();
      return null;
    default:
      return null;
  }
}

/** Render the gate, decide it, and tell the server. */
async function answerApproval(
  ctx: EventContext,
  event: Extract<AgentEvent, { type: "approval_request" }>,
): Promise<void> {
  const { theme, width, client, rl } = ctx;
  for (const line of renderApproval(theme, event, width)) process.stdout.write(`${line}\n`);

  let decision: "approve" | "deny" = "deny";
  if (ctx.approve) {
    decision = "approve";
    process.stdout.write(`${theme.gray("  auto-approved (--yes)")}\n`);
  } else if (!ctx.interactive) {
    process.stdout.write(`${theme.gray("  denied: no terminal to ask, and --yes was not given")}\n`);
  } else {
    const answer = (await question(rl, `${theme.yellow("approve?")} [y/N] `)).trim().toLowerCase();
    decision = answer === "y" || answer === "yes" ? "approve" : "deny";
  }

  try {
    const resolved = await client.decide(event.id, decision);
    process.stdout.write(
      `${resolved ? (decision === "approve" ? theme.green("✓ approved") : theme.red("✗ denied")) : theme.gray("the prompt already closed")}\n\n`,
    );
  } catch (error) {
    process.stdout.write(`${eventError(theme, `could not answer the prompt: ${(error as Error).message}`)}\n`);
  }
}

// --- the REPL ---------------------------------------------------------------

interface ReplState {
  sessionId: string | null;
  model?: string;
  maxSteps?: number;
  lastMessage: string | null;
  followups: string[];
  sessionIndex: Map<number, SessionSummary>;
}

async function runRepl(
  client: GenieClient,
  target: ResolvedTarget,
  args: CliArgs,
  theme: Theme,
): Promise<number> {
  const state: ReplState = {
    sessionId: args.session ?? null,
    model: args.model,
    maxSteps: args.maxSteps,
    lastMessage: null,
    followups: [],
    sessionIndex: new Map(),
  };

  // Say hello only when there is a credential to say it with; otherwise point at
  // the sign-in rather than failing on the first task.
  if (!target.hasCredential) {
    const status = await client.status().catch(() => null);
    if (status === null || !status.authenticated) {
      process.stdout.write(
        `${theme.yellow("not signed in")} — run ${theme.bold("genie login")} (the server is ${client.origin})\n`,
      );
      return 1;
    }
  }

  const health = await client.health().catch(() => null);
  const status = await client.status().catch(() => null);
  const identity = status?.identity ? describe(status.identity) : "signed in";
  const model =
    state.model ?? health?.model ?? "(server default)";
  for (const line of banner(theme, client.origin, model, identity)) process.stdout.write(`${line}\n`);

  const skills = loadSkills(skillDirs(process.cwd()));
  if (skills.length > 0) {
    process.stdout.write(`${theme.gray(`  ${skills.length} skill(s) available — /skills to list`)}\n\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY === true,
    // Tab completion from the same command table `/help` is drawn from, so the
    // palette can never offer something that does not exist.
    completer: (line: string) => {
      const matches = matchCommands(line.trimStart());
      // A skill is completed from the loaded playbooks rather than the table.
      if (/^\/skill\s+\S*$/.test(line.trimStart())) {
        const prefix = line.trimStart().replace(/^\/skill\s+/, "");
        const names = skills
          .filter((skill) => skill.name.startsWith(prefix.toLowerCase()))
          .map((skill) => `/skill ${skill.name}`);
        return [names, line];
      }
      return [
        matches.map((command) => `/${command.name}`),
        line,
      ];
    },
  });

  // A pending `question` callback never fires when stdin ends (a pipe, or
  // Ctrl-D), so the close event resolves it with a sentinel and the loop exits
  // instead of hanging on a prompt nobody can answer.
  const EOF = "\u0000genie-eof";
  let closed = false;
  let pending: ((value: string) => void) | null = null;
  rl.on("close", () => {
    closed = true;
    pending?.(EOF);
    pending = null;
  });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      if (closed) {
        resolve(EOF);
        return;
      }
      pending = resolve;
      rl.question(prompt, (answer) => {
        pending = null;
        resolve(answer);
      });
    });

  let interrupted = 0;
  process.on("SIGINT", () => {
    interrupted += 1;
    if (interrupted >= 2) {
      process.stdout.write("\n");
      rl.close();
      return;
    }
    process.stdout.write(`\n${theme.gray("(press Ctrl-C again to exit)")}\n`);
  });

  try {
    for (;;) {
      const line = (await ask(`${speaker(theme, "you")} `)).trim();
      interrupted = 0;
      if (closed || line === EOF) break;
      if (line === "") continue;

      // A bare number picks one of the last turn's follow-ups — the terminal's
      // version of clicking a suggestion.
      if (/^\d+$/.test(line) && state.followups.length > 0) {
        const chosen = state.followups[Number.parseInt(line, 10) - 1];
        if (chosen !== undefined) {
          await turn(client, rl, theme, state, chosen, args);
          continue;
        }
      }

      const parsed = parseCommand(line);
      if (parsed !== null) {
        const quit = await handleCommand(client, rl, theme, state, args, parsed, skills);
        if (quit) break;
        continue;
      }

      await turn(client, rl, theme, state, line, args);
    }
  } finally {
    rl.close();
  }
  return 0;
}

async function turn(
  client: GenieClient,
  rl: readline.Interface,
  theme: Theme,
  state: ReplState,
  task: string,
  args: CliArgs,
): Promise<void> {
  let message = task;
  if (state.sessionId === null) {
    // Create the chat up front so its id is stable across turns and a crash does
    // not orphan the transcript.
    try {
      const session = await client.createSession();
      state.sessionId = session.id;
    } catch (error) {
      process.stdout.write(`${eventError(theme, (error as Error).message)}\n`);
      return;
    }
  }
  if (message.trim() === "") return;

  const outcome = await runTurn(client, rl, theme, {
    task: message,
    sessionId: state.sessionId ?? undefined,
    model: state.model,
    maxSteps: state.maxSteps,
    approve: false,
    interactive: process.stdout.isTTY === true,
  });
  if (outcome.sessionId !== null) state.sessionId = outcome.sessionId;
  state.lastMessage = message;

  // Persist the model on the chat so reopening it from the browser keeps it.
  if (state.model !== undefined && state.sessionId !== null) {
    await client.patchSession(state.sessionId, { model: state.model }).catch(() => undefined);
  }

  state.followups = suggestFollowups(outcome.summary);
  if (state.followups.length > 0) {
    process.stdout.write(`\n${theme.gray("next:")}\n`);
    state.followups.forEach((suggestion, index) => {
      process.stdout.write(`  ${theme.cyan(String(index + 1))}  ${suggestion}\n`);
    });
    process.stdout.write(`${theme.gray("  press 1-3, or type your own task")}\n\n`);
  }
}

interface CommandResult {
  /** True when the REPL should exit. */
  quit: boolean;
}

async function handleCommand(
  client: GenieClient,
  rl: readline.Interface,
  theme: Theme,
  state: ReplState,
  args: CliArgs,
  parsed: NonNullable<ReturnType<typeof parseCommand>>,
  skills: Skill[],
): Promise<boolean> {
  const { command, args: argv, rest } = parsed;
  switch (command.name) {
    case "help":
      for (const line of helpLines()) process.stdout.write(`${line}\n`);
      process.stdout.write("\n");
      return false;
    case "quit":
      return true;
    case "clear":
      process.stdout.write("\u001b[2J\u001b[H");
      return false;
    case "new": {
      const session = await client.createSession();
      state.sessionId = session.id;
      state.followups = [];
      process.stdout.write(`${theme.gray(`new chat ${session.id.slice(0, 8)}`)}\n`);
      return false;
    }
    case "sessions": {
      const sessions = await client.sessions();
      state.sessionIndex = indexSessions(sessions);
      if (sessions.length === 0) {
        process.stdout.write(`${theme.gray("no chats yet")}\n`);
        return false;
      }
      for (const [index, session] of state.sessionIndex) {
        const current = session.id === state.sessionId ? theme.cyan("*") : " ";
        process.stdout.write(`${current}${formatSessionRow(index, session).slice(1)}\n`);
      }
      return false;
    }
    case "resume": {
      const wanted = argv[0] ?? "";
      if (wanted === "") {
        process.stdout.write(`${theme.gray("usage: /resume <id|number>")}\n`);
        return false;
      }
      const id = resolveSessionId(wanted, state);
      if (id === null) {
        process.stdout.write(`${theme.red(`no chat matches "${wanted}"`)}\n`);
        return false;
      }
      const session = await client.session(id);
      state.sessionId = session.id;
      state.model = session.model;
      printTranscript(theme, session);
      return false;
    }
    case "rename": {
      if (state.sessionId === null) {
        process.stdout.write(`${theme.gray("no chat yet")}\n`);
        return false;
      }
      if (rest === "") {
        process.stdout.write(`${theme.gray("usage: /rename <title>")}\n`);
        return false;
      }
      await client.patchSession(state.sessionId, { title: rest });
      process.stdout.write(`${theme.gray(`renamed to "${rest}"`)}\n`);
      return false;
    }
    case "archive":
    case "unarchive": {
      if (state.sessionId === null) return false;
      await client.patchSession(state.sessionId, { archived: command.name === "archive" });
      process.stdout.write(`${theme.gray(`${command.name}d`)}\n`);
      return false;
    }
    case "delete": {
      const id = argv[0] === undefined ? state.sessionId : resolveSessionId(argv[0], state);
      if (id === null) {
        process.stdout.write(`${theme.gray("nothing to delete")}\n`);
        return false;
      }
      const answer = (await question(rl, `${theme.red(`delete chat ${id.slice(0, 8)}?`)} [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write(`${theme.gray("kept")}\n`);
        return false;
      }
      await client.deleteSession(id);
      if (id === state.sessionId) state.sessionId = null;
      process.stdout.write(`${theme.gray("deleted")}\n`);
      return false;
    }
    case "model": {
      if (argv.length === 0) {
        process.stdout.write(`${theme.gray(`model: ${state.model ?? "(server default)"}`)}\n`);
        return false;
      }
      state.model = argv[0];
      if (state.sessionId !== null) await client.patchSession(state.sessionId, { model: state.model });
      process.stdout.write(`${theme.gray(`model set to ${state.model}`)}\n`);
      return false;
    }
    case "models": {
      await commandModels(client, { ...args, rest: argv });
      return false;
    }
    case "steps": {
      if (argv.length === 0) {
        process.stdout.write(`${theme.gray(`steps: ${state.maxSteps ?? "(server default)"}`)}\n`);
        return false;
      }
      const value = Number.parseInt(argv[0] ?? "", 10);
      if (!Number.isFinite(value)) {
        process.stdout.write(`${theme.gray("usage: /steps <n>")}\n`);
        return false;
      }
      state.maxSteps = value;
      if (state.sessionId !== null) await client.patchSession(state.sessionId, { maxSteps: value });
      process.stdout.write(`${theme.gray(`step budget set to ${value}`)}\n`);
      return false;
    }
    case "offline": {
      if (state.sessionId === null) return false;
      const value = argv[0] === "on" ? true : argv[0] === "off" ? false : undefined;
      if (value === undefined) {
        process.stdout.write(`${theme.gray("usage: /offline on|off")}\n`);
        return false;
      }
      await client.patchSession(state.sessionId, { useOffline: value });
      process.stdout.write(`${theme.gray(`offline gateway ${value ? "allowed" : "refused"}`)}\n`);
      return false;
    }
    case "pending": {
      await listApprovals(client, theme);
      return false;
    }
    case "approve":
    case "deny": {
      await decideApproval(client, theme, argv[0], command.name === "approve" ? "approve" : "deny");
      return false;
    }
    case "skills":
      for (const line of describeSkills(skills)) process.stdout.write(`${line}\n`);
      return false;
    case "skill": {
      const name = argv[0] ?? "";
      const skill =
        skills.find((entry) => entry.name === name.toLowerCase()) ??
        skills.find((entry) => entry.name.startsWith(name.toLowerCase()));
      if (skill === undefined) {
        process.stdout.write(`${theme.red(`no skill named "${name}"`)} — /skills lists them\n`);
        return false;
      }
      const task = rest.replace(/^\S+\s*/, "");
      await turn(client, rl, theme, state, composeSkillMessage(skill, task), args);
      return false;
    }
    case "usage": {
      const usage = await client.usage();
      if (usage.tenancy !== true) {
        process.stdout.write(`${theme.gray("this deployment has no account to read usage from")}\n`);
        return false;
      }
      process.stdout.write(
        `  ${theme.gray("account")}  ${usage.email ?? "?"}\n` +
          `  ${theme.gray("allowed")}  ${usage.allowed ? theme.green("yes") : theme.red("no")}\n` +
          (usage.ceiling ? `  ${theme.gray("ceiling")}  ${usage.ceiling.used}/${usage.ceiling.limit}\n` : ""),
      );
      return false;
    }
    case "whoami": {
      await commandWhoami(client, { ...args, json: false });
      return false;
    }
    case "last": {
      process.stdout.write(
        state.lastMessage === null ? `${theme.gray("nothing sent yet")}\n` : `${state.lastMessage}\n`,
      );
      return false;
    }
    default:
      process.stdout.write(`${theme.gray(`/${command.name} is not wired up yet`)}\n`);
      return false;
  }
}

function resolveSessionId(wanted: string, state: ReplState): string | null {
  if (/^\d+$/.test(wanted)) {
    const session = state.sessionIndex.get(Number.parseInt(wanted, 10));
    if (session !== undefined) return session.id;
  }
  // A full id, or an unambiguous prefix of one.
  const all = [...state.sessionIndex.values()];
  const exact = all.find((session) => session.id === wanted);
  if (exact !== undefined) return exact.id;
  const prefixed = all.filter((session) => session.id.startsWith(wanted));
  if (prefixed.length === 1) return (prefixed[0] as SessionSummary).id;
  if (prefixed.length === 0) return /^[0-9a-f-]{8,}$/.test(wanted) ? wanted : null;
  return null;
}

/** Print a saved transcript, so `/resume` shows where the chat left off. */
function printTranscript(theme: Theme, session: Session): void {
  process.stdout.write(`\n${theme.gray(`chat ${session.id.slice(0, 8)} · ${session.title}`)}\n`);
  const visible = session.messages.filter((message) => message.role === "user" || message.role === "assistant");
  if (visible.length === 0) {
    process.stdout.write(`${theme.gray("(empty)")}\n\n`);
    return;
  }
  for (const message of visible) {
    const who = message.role === "user" ? speaker(theme, "you") : speaker(theme, "genie");
    const body = typeof message.content === "string" ? message.content : "";
    const first = body.split("\n").slice(0, 6).join("\n");
    const more = body.split("\n").length > 6 ? theme.gray(`\n  … ${body.split("\n").length - 6} more line(s)`) : "";
    process.stdout.write(`${who} ${first}${more}\n`);
    if (message.diff) {
      for (const line of renderDiff(theme, message.diff, terminalWidth(), 2)) process.stdout.write(`${line}\n`);
    }
  }
  process.stdout.write(`${theme.gray(`(${session.messages.length} message(s) stored)`)}\n\n`);
}

async function listApprovals(client: GenieClient, theme: Theme): Promise<void> {
  const pending: PendingApproval[] = await client.approvals();
  if (pending.length === 0) {
    process.stdout.write(`${theme.gray("nothing is waiting for approval")}\n`);
    return;
  }
  for (const entry of pending) {
    process.stdout.write(`  ${theme.bold(entry.id)}  ${entry.name}\n    ${entry.summary}\n    expires ${entry.expiresAt}\n`);
  }
}

async function decideApproval(
  client: GenieClient,
  theme: Theme,
  id: string | undefined,
  decision: "approve" | "deny",
): Promise<void> {
  let target = id;
  if (target === undefined) {
    const pending = await client.approvals();
    const first = pending[0];
    if (first === undefined) {
      process.stdout.write(`${theme.gray("nothing is waiting for approval")}\n`);
      return;
    }
    target = first.id;
  }
  const resolved = await client.decide(target, decision);
  process.stdout.write(
    resolved ? `${theme.gray(`${decision}d ${target}`)}\n` : `${theme.gray("that prompt has already closed")}\n`,
  );
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

// Run when invoked as a program, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
