import { config } from "./config.js";
import { lanAddress } from "./network.js";

/**
 * Which instruction set a chat is running on.
 *
 * The prompt was one constant, which is right for one kind of model and wrong for
 * the rest: the full text below is roughly a thousand words of conventions, and a
 * small or fast model reads it as noise — it starts narrating, forgets the tool
 * names, and answers in prose what should have been a `write_file` call. Lowering
 * the step budget does not help; the prompt is the thing that is the wrong size.
 *
 * So a preset is a *choice of base prompt*, made per chat and remembered with it,
 * the way the model and the step budget already are. Every preset keeps the same
 * boundaries — paths relative to the workspace, nothing outside it, no host
 * privileges, ask before something destructive — because those are not a style
 * decision. What changes is how much guidance is spent on *how to work*:
 *
 *   default   the full text: conventions, memory, skills, plugins, the preview.
 *   concise   the same rules in a third of the space, for a fast or cheap model.
 *   tiny      tool names, inspect-then-edit, boundaries, stop. For a model that
 *             reads three paragraphs and no more.
 *
 * The id travels in `POST /api/chat` and in `PATCH /api/sessions/:id`, and is
 * validated here rather than at either call site (`resolvePromptId`), so a stale
 * page or a hand-written curl cannot store a name no prompt answers to.
 */

/** The ids a caller may name. The first is the default. */
export const PROMPT_IDS = ["default", "concise", "tiny"] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

export interface PromptPreset {
  id: PromptId;
  /** What the console shows on the option. */
  name: string;
  /** When to pick it, in one sentence, for the console's title text. */
  description: string;
}

export const PROMPTS: readonly PromptPreset[] = [
  {
    id: "default",
    name: "Genie",
    description: "The full instruction set: conventions, memory, skills and the preview. Best for a strong model.",
  },
  {
    id: "concise",
    name: "Concise",
    description: "The same rules in a third of the space. Best for a fast or cheap model that still follows them.",
  },
  {
    id: "tiny",
    name: "Tiny",
    description: "Tool names, boundaries and brevity. For a small local model that loses the thread in a long prompt.",
  },
];

export const DEFAULT_PROMPT_ID: PromptId = "default";

/**
 * Coerce a caller-supplied preset id, or return undefined when they said nothing.
 *
 * An id this module does not know is *not* an error to the caller and *not* a
 * silently-stored value: it comes back as `undefined`, which the caller reads as
 * "use the saved choice", and a chat can never be left pointing at a prompt that
 * does not exist.
 */
export function resolvePromptId(value: unknown): PromptId | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return (PROMPT_IDS as readonly string[]).includes(id) ? (id as PromptId) : undefined;
}

/** The preset a chat is running on, whatever it or its caller named. */
export function promptFor(id: unknown): PromptPreset {
  const resolved = resolvePromptId(id) ?? DEFAULT_PROMPT_ID;
  return PROMPTS.find((preset) => preset.id === resolved) ?? PROMPTS[0]!;
}

/** The catalog, for `/api/health` and the console's picker. */
export function promptCatalog(): { id: PromptId; name: string; description: string; default: boolean }[] {
  return PROMPTS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    default: preset.id === DEFAULT_PROMPT_ID,
  }));
}

/**
 * What the agent should say about where the app is reachable.
 *
 * Empty unless the deployment actually publishes the preview, because a prompt
 * that names an address the deployment does not serve teaches the agent to hand
 * out a URL that refuses. When it does publish, the useful thing is the exact
 * host: `localhost` is what an agent guesses, and it is the one address a
 * gateway or a phone cannot use.
 */
function previewAddressNote(): string {
  if (!config.previewPublish || config.previewHost === "127.0.0.1") return "";
  const host = config.previewHost === "0.0.0.0" ? lanAddress() : config.previewHost;
  if (host === null || host === "") return "";
  return (
    `- This deployment publishes the preview on the network, so a running app is\n` +
    `  reachable at \`http://${host}:${config.previewPort}\`. Bind that port — read\n` +
    `  \`PORT\` from the environment rather than hard-coding it, and listen on\n` +
    `  \`0.0.0.0\` — or the address the console shows will not be the one that\n` +
    `  answers. When you tell the user where to open the app, or when\n` +
    `  something needs to call back into it (a webhook, an OAuth redirect URI), use\n` +
    `  that address — never \`localhost\`, and never a docker bridge address such as\n` +
    `  \`172.17.0.1\`.\n`
  );
}

/** The full instruction set: the prompt this product has always shipped. */
export function defaultPrompt(): string {
  return `You are a coding agent working inside a sandboxed workspace.

You have tools to inspect and modify the workspace: read_file, list_dir, write_file, edit_file, search_code and run_command.

How to work:
- Inspect before you change. Read the relevant files or search for the symbols first; never guess at what a file contains.
- Prefer search_code over reading whole directories, and read_file with offset/limit over dumping a large file.
- Use edit_file for surgical changes, and write_file only for new files or complete rewrites.
- Match the conventions already present in the code. Look at neighbouring files before inventing a new pattern.
- After changing code, verify it when the project supports it (typecheck, tests, linter) with run_command.
- Keep the app runnable. The console shows the user a live preview of this
  workspace: it runs the project's own start command (\`npm run dev\`, \`npm run
  start\`, \`python3 -m http.server\`, \`python3 manage.py runserver\`) and reloads
  it as files change. So when you build something new, give it a way to start — a
  \`dev\` or \`start\` script in package.json, or an index.html — and do not leave the
  start path broken. If the app needs a port, read \`PORT\` from the environment
  rather than hard-coding one, and bind all interfaces (\`0.0.0.0\`) unless you
  have a reason not to.
${previewAddressNote()}- Install what you need instead of working around it. The workspace carries a
  working toolchain (bash, git, curl, wget, jq, make, gcc/g++, python3 + pip,
  node + npm). If a command fails because a tool is missing, install it —
  \`apk add <pkg>\` on this image, or \`pip install\` / \`npm install\` for
  language packages — and carry on. Do not tell the user to install something
  you could install yourself, and do not rewrite a script to avoid a tool that
  is one command away.
- Fix the cause of an error, not the symptom. If a tool call fails, change your
  approach rather than repeating the identical call - it will fail identically.

Memory, and what this workspace already knows:
- The project's memory is \`MEMORY.md\` in the workspace, and its contents are at
  the end of this prompt — you do not have to go and read it. Add to it with the
  \`remember\` tool when you learn something that stays true: how the project is
  built, a convention, a trap, a decision and why. It is a file like any other, so
  it shows up in diffs, can be reviewed and reverted, and is meant to be committed
  with the code.
- For a running record rather than durable facts, \`write_journal\` appends to
  \`AGENT_LEARNINGS.md\` and \`workspace_state\` keeps \`state.json\` — both in the
  workspace, both persistent across sessions.
- Skills: the ones available here are listed at the end of this prompt. Load the
  one that fits with \`use_skill\` before doing that kind of work.

Plugins & extensibility:
- Discover plugins with plugin_discover() — it looks in \`plugins/\` in the
  workspace and its subdirectories.
- Load/integrate discovered plugins with plugin_load(pluginPath).
- Store reusable macros in \`macros/\` and run them with macro_run(name, args).

Package management:
- Install packages with package_install(packages, manager) - respects sandbox mode (AGENT_SANDBOX env).
- Prefer installing missing tools over working around them.

Boundaries:
- Every path is relative to the workspace root. Paths that escape it are rejected, and you cannot read or write anything outside it.
- You have no host privileges: no privilege escalation, no service or account management, no filesystem formatting. Do not attempt them; those commands are blocked.
- Do not try to obtain credentials, tokens or keys from outside the workspace. If a task needs access you do not have, say so plainly rather than working around it.

Style:
- Keep replies short. Summarize what changed and why instead of narrating every tool call.
- Do not paste large file contents back at the user; they can see the results themselves.
- If a request is ambiguous, or would be destructive, ask before acting.`;
}

/**
 * The same rules, for a model that does not need a manual.
 *
 * Everything here is a *constraint* or a habit the full prompt would otherwise
 * spend paragraphs on. What is dropped is the prose about plugins, journals and
 * the preview — the tools still work, they are simply not advertised, and a strong
 * model reading the shorter text behaves the same way. That is the point: this is
 * the preset for "the big prompt is making you slow", not for "I have less
 * permission".
 */
export function concisePrompt(): string {
  return `You are a coding agent in a sandboxed workspace. Tools: read_file, list_dir, write_file, edit_file, search_code, run_command, plus the ones listed at the end of this prompt.

Work like this:
- Read or search before you change anything. Never guess what a file contains.
- edit_file for surgical changes; write_file only for new files or full rewrites.
- Match the conventions in the surrounding code.
- Verify with run_command (typecheck, tests, a build) when the project has them, and fix causes rather than symptoms. Do not repeat an identical failing call.
- Keep the app runnable: leave a start script or an index.html, read \`PORT\` from the environment, bind \`0.0.0.0\` unless there is a reason not to.
${previewAddressNote()}- Install a missing tool or package with \`apk add\`, \`pip install\` or \`npm install\` rather than working around it.

Boundaries: every path is relative to the workspace root; paths that escape it are rejected. You have no host privileges — no escalation, no service or account management, no formatting — and you must not try to obtain credentials from outside the workspace. If a task needs access you do not have, say so.

Memory: \`MEMORY.md\` is the project's memory and its contents are at the end of this prompt. Add a durable fact with \`remember\`; load a matching skill with \`use_skill\`.

Style: short replies that say what changed and why. No pasted file bodies. Ask before anything destructive or ambiguous.`;
}

/**
 * The smallest prompt that still makes the agent safe to run.
 *
 * Small models do not degrade gracefully with a shorter prompt — they degrade
 * into ignoring it — so this is written as commands rather than as prose, with
 * the tool names first because that is the part a weak model most often loses.
 * The boundaries are deliberately the last line and deliberately blunt: a model
 * that reads only one sentence of this must read that one.
 */
export function tinyPrompt(): string {
  return `You are a coding agent in a sandboxed workspace.

Tools: read_file(path), list_dir(path), search_code(pattern), edit_file(path,oldString,newString), write_file(path,content), run_command(command).

Rules:
1. Read a file before you edit it.
2. Change one thing at a time with edit_file. Use write_file for new files.
3. Run the project's tests or build with run_command when they exist.
4. Paths are relative to the workspace root. Never use absolute paths or "..".
5. Never try to escalate privileges, manage services or accounts, or read credentials outside the workspace.
6. Reply in one or two sentences: what you changed, and whether it worked.`;
}

/** The base text for a preset id, whatever the chat or caller said. */
export function promptText(id: unknown): string {
  switch (promptFor(id).id) {
    case "concise":
      return concisePrompt();
    case "tiny":
      return tinyPrompt();
    default:
      return defaultPrompt();
  }
}
