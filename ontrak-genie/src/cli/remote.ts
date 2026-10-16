/**
 * `genie remote` — folders on other machines, repositories on GitHub, and Atlas.
 *
 * The console has had this since remote workspaces were added (`src/remote.ts`):
 * a folder mounted over SSH and made the working directory, so every tool and the
 * preview reach it through the jail that already exists; a GitHub repository
 * cloned with the caller's token and edited in place; and Atlas, the ecosystem's
 * Gitea forge, as an add-on. What none of it had was a way to do it without a
 * browser — which is the case a terminal is *for*, since the machine you are
 * connecting to is often the machine you are sitting at.
 *
 * This module is the terminal's side of those routes and **only** that side: the
 * mount, the clone, the credential store and the plan check all stay on the
 * server, over the same endpoints the console calls. Three things are this
 * module's own, and they are why it is a module rather than a switch statement:
 *
 *   - **The subcommand.** `genie remote clone owner/name` is read here, so the
 *     aliases are one table and an unknown word is a usage error listing what
 *     exists.
 *   - **The target.** `root@192.168.1.90:/srv/app` is the shape ssh itself uses,
 *     so it is the shape a person types; splitting it is this module's job, and
 *     the halves are *checked* by the server exactly as the console's fields are.
 *   - **The credential.** A secret is never a positional argument and never on the
 *     command line: `--key-file` names a file, and `--password-stdin` /
 *     `--token-stdin` read one pipe. `ps` shows neither — on a shared machine that
 *     is the difference between a tool and a habit.
 *   - **The run.** `genie remote run` starts what is in the working directory, so
 *     the project `new` or `clone` just produced is something you can use rather
 *     than something you have to go and find a start command for.
 *
 * There is one more thing worth stating, because it is the whole reason this is
 * usable at all: **the deployment's own Atlas credential needs no secret here**.
 * `genie remote atlas` connects with what the server already holds, so the common
 * case on this estate is one word.
 */

import fs from "node:fs/promises";

import type { GenieClient, RemoteForgeRow, RemoteSshRow } from "./client.js";
import type { Theme } from "./render.js";

/** A command line this module cannot carry out as written. Exit code 2. */
export class RemoteUsageError extends Error {}

export type RemoteSub = "list" | "ssh" | "disconnect" | "atlas" | "new" | "clone" | "run" | "push" | "pr";

const SUBCOMMANDS = new Map<string, RemoteSub>([
  ["list", "list"],
  ["ls", "list"],
  ["ssh", "ssh"],
  ["mount", "ssh"],
  ["disconnect", "disconnect"],
  ["unmount", "disconnect"],
  ["atlas", "atlas"],
  ["new", "new"],
  ["create", "new"],
  ["clone", "clone"],
  ["run", "run"],
  ["push", "push"],
  ["pr", "pr"],
  ["pull-request", "pr"],
]);

export interface RemoteInvocation {
  sub: RemoteSub;
  /** The words after the subcommand. */
  args: string[];
}

export interface RemoteOptions {
  /** Print the server's own payload instead of a sentence. */
  json: boolean;
  /** `--key-file`: a private key on disk, which is how ssh is normally given one. */
  keyFile?: string;
  /** `--password`: convenient and visible; the discouraged one. */
  password?: string;
  /** `--password-stdin`: read the password from a pipe. */
  passwordStdin: boolean;
  /** `--token-stdin` / `--token`: the same for a GitHub token. */
  token?: string;
  tokenStdin: boolean;
  /** `--port`: when it is not 22. */
  port?: number;
  /** `--dir`: where a clone lands. */
  dir?: string;
  /** `--branch`: what to check out, or what to open a pull request against. */
  branch?: string;
  /** `--github`: use GitHub's routes rather than the forge's. */
  github: boolean;
  /** `--command`: run this instead of what the project itself says to run. */
  command?: string;
}

export function parseRemoteCommand(rest: string[]): RemoteInvocation {
  const head = (rest[0] ?? "").toLowerCase();
  if (head === "") return { sub: "list", args: [] };
  const sub = SUBCOMMANDS.get(head);
  if (sub === undefined) {
    throw new RemoteUsageError(
      `unknown remote subcommand "${rest[0] ?? ""}" — try list, ssh, disconnect, atlas, new, clone, run, push or pr`,
    );
  }
  return { sub, args: rest.slice(1) };
}

/**
 * Read a whole `remote` line, flags included.
 *
 * The flags are read here as well as from the launch line because the REPL has no
 * flag parser of its own — `/remote clone owner/name --dir app` is a line somebody
 * typed, not this process's argv.
 */
export function parseRemoteLine(
  rest: string[],
  defaults: RemoteOptions,
): { invocation: RemoteInvocation; options: RemoteOptions } {
  const words: string[] = [];
  const options: RemoteOptions = { ...defaults };

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    const split = word.indexOf("=");
    const name = split === -1 ? word : word.slice(0, split);
    const inline = split === -1 ? undefined : word.slice(split + 1);
    const value = (): string => {
      const found = inline ?? rest[index + 1] ?? "";
      if (inline === undefined) index += 1;
      return found;
    };

    switch (name) {
      case "--key-file":
        options.keyFile = value();
        break;
      case "--password":
        options.password = value();
        break;
      case "--password-stdin":
        options.passwordStdin = true;
        break;
      case "--token":
        options.token = value();
        break;
      case "--token-stdin":
        options.tokenStdin = true;
        break;
      case "--port": {
        const parsed = Number.parseInt(value(), 10);
        if (!Number.isInteger(parsed)) throw new RemoteUsageError("`--port` needs a number");
        options.port = parsed;
        break;
      }
      case "--dir":
        options.dir = value();
        break;
      case "--branch":
        options.branch = value();
        break;
      case "--github":
        options.github = true;
        break;
      case "--command":
        options.command = value();
        break;
      default:
        if (name.startsWith("-") && name !== "-") {
          throw new RemoteUsageError(`unknown option ${name} for remote`);
        }
        words.push(word);
    }
  }

  return { invocation: parseRemoteCommand(words), options };
}

/**
 * Split `user@host:/path` into the three things the server checks separately.
 *
 * The port is deliberately *not* read out of the target: `host:2222:/path` is a
 * shape ssh accepts and a person does not mean, and the two halves of it are
 * ambiguous enough that guessing would connect somewhere unintended. `--port`
 * says it once, plainly.
 */
export function parseRemoteTarget(target: string): { user: string; host: string; path: string } {
  const at = target.indexOf("@");
  const slash = target.indexOf(":");
  if (at <= 0 || slash === -1 || slash < at) {
    throw new RemoteUsageError("a remote folder is named user@host:/absolute/path");
  }
  const user = target.slice(0, at);
  const host = target.slice(at + 1, slash);
  const remotePath = target.slice(slash + 1);
  if (host === "" || remotePath === "") {
    throw new RemoteUsageError("a remote folder is named user@host:/absolute/path");
  }
  return { user, host, path: remotePath };
}

/** One line on stdin. Used for a password or a token, and nothing else. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

interface Context {
  client: GenieClient;
  theme: Theme;
  options: RemoteOptions;
  write: (line: string) => void;
}

export async function runRemote(
  client: GenieClient,
  theme: Theme,
  invocation: RemoteInvocation,
  options: RemoteOptions,
): Promise<number> {
  const ctx: Context = { client, theme, options, write: (line) => process.stdout.write(`${line}\n`) };
  switch (invocation.sub) {
    case "list":
      return await listRemotes(ctx);
    case "ssh":
      return await connectFolder(ctx, invocation.args);
    case "disconnect":
      return await disconnectFolder(ctx, invocation.args);
    case "atlas":
      return await connectAtlas(ctx);
    case "new":
      return await createProject(ctx, invocation.args);
    case "clone":
      return await cloneRepository(ctx, invocation.args);
    case "run":
      return await runProject(ctx, invocation.args);
    case "push":
      return await pushBranch(ctx, invocation.args);
    case "pr":
      return await openPullRequest(ctx, invocation.args);
  }
}

async function listRemotes(ctx: Context): Promise<number> {
  const info = await ctx.client.remotes();
  if (ctx.options.json) {
    ctx.write(JSON.stringify(info, null, 2));
    return 0;
  }
  if (!info.enabled) {
    ctx.write(ctx.theme.gray("remote workspaces are switched off on this deployment (AGENT_REMOTE_ENABLED=false)"));
    return 0;
  }

  const rows: string[] = [];
  for (const connection of info.ssh) rows.push(formatSshRow(connection));
  for (const connection of info.github) {
    rows.push(`  github  ${connection.repo}  ${connection.rel}${connection.branch ? `  (${connection.branch})` : ""}`);
  }
  for (const forge of info.forge) {
    rows.push(`  forge   ${forge.label} as ${forge.user}${forge.system ? "  (this deployment's credential)" : ""}`);
  }
  for (const clone of info.forgeClones) {
    rows.push(`  forge   ${clone.repo}  ${clone.rel}${clone.branch ? `  (${clone.branch})` : ""}`);
  }

  if (rows.length === 0) {
    ctx.write(ctx.theme.gray("nothing is connected — `genie remote ssh user@host:/path`, or `genie remote atlas`"));
  } else {
    for (const row of rows) ctx.write(row);
  }

  const atlas = info.atlas;
  if (!atlas.configured) {
    ctx.write(ctx.theme.gray("Atlas: not configured on this deployment"));
  } else {
    const state =
      atlas.entitled === true
        ? "your plan includes it"
        : atlas.entitled === false
          ? "your plan does not include it"
          : atlas.systemCredential
            ? "this deployment has its own credential"
            : atlas.reason || "the plan could not be checked";
    ctx.write(ctx.theme.gray(`Atlas: ${atlas.url} — ${state}`));
  }
  return 0;
}

function formatSshRow(connection: RemoteSshRow & { live?: boolean }): string {
  const state = connection.live === false ? "  (not answering)" : "";
  return `  ssh     ${connection.label}  ${connection.rel}${state}`;
}

async function connectFolder(ctx: Context, args: string[]): Promise<number> {
  const target = args[0] ?? "";
  if (target === "") throw new RemoteUsageError("a remote folder is named user@host:/absolute/path");
  const parsed = parseRemoteTarget(target);

  // A key is read from a file rather than typed here, because a key *is* a file
  // everywhere else and a private key pasted into a shell history is a private key
  // that has to be replaced.
  let key = "";
  if (ctx.options.keyFile !== undefined && ctx.options.keyFile !== "") {
    key = await fs.readFile(ctx.options.keyFile, "utf8").catch(() => {
      throw new RemoteUsageError(`could not read the key file ${ctx.options.keyFile}`);
    });
  }
  let password = ctx.options.password ?? "";
  if (ctx.options.passwordStdin) password = await readStdin();
  if (key === "" && password === "") {
    throw new RemoteUsageError("a key or a password is required: --key-file <path>, or --password-stdin");
  }

  const result = await ctx.client.connectSshFolder({
    host: parsed.host,
    user: parsed.user,
    path: parsed.path,
    ...(ctx.options.port === undefined ? {} : { port: ctx.options.port }),
    ...(key === "" ? {} : { key }),
    ...(password === "" ? {} : { password }),
  });
  if (ctx.options.json) {
    ctx.write(JSON.stringify(result, null, 2));
    return 0;
  }
  ctx.write(`${result.connection.label} is mounted at ${result.rel} — the agent works there now.`);
  ctx.write(ctx.theme.gray(`  ${result.cwd}`));
  return 0;
}

async function disconnectFolder(ctx: Context, args: string[]): Promise<number> {
  const wanted = (args[0] ?? "").toLowerCase();
  const info = await ctx.client.remotes();
  const connection = info.ssh.find(
    (row, index) =>
      row.id === args[0] ||
      String(index + 1) === wanted ||
      row.label.toLowerCase() === wanted ||
      row.rel.toLowerCase() === wanted ||
      row.label.toLowerCase().includes(wanted),
  );
  if (connection === undefined) {
    throw new RemoteUsageError(
      wanted === ""
        ? "which folder? `genie remote` lists them, and a row number, label or id works"
        : `no connected folder matches "${args[0] ?? ""}"`,
    );
  }
  const removed = await ctx.client.disconnectSshFolder(connection.id);
  ctx.write(`${connection.label} is disconnected, and its key is gone (${removed.rel}).`);
  return 0;
}

async function connectAtlas(ctx: Context): Promise<number> {
  // The deployment's own credential: no secret on this command line, and the
  // system path is not gated on a plan (`src/atlas.ts`).
  const info = await ctx.client.connectForge({ useSystem: true });
  if (ctx.options.json) {
    ctx.write(JSON.stringify(info, null, 2));
    return 0;
  }
  ctx.write(`connected to ${info.label} as ${info.user}${info.system ? " (this deployment's credential)" : ""}`);
  return 0;
}

async function createProject(ctx: Context, args: string[]): Promise<number> {
  const name = args[0] ?? "";
  if (name === "") throw new RemoteUsageError('a project needs a name: genie remote new "my-project"');
  const created = await ctx.client.createForgeProject({ name });
  if (ctx.options.json) {
    ctx.write(JSON.stringify(created, null, 2));
    return 0;
  }
  ctx.write(`${created.connection.repo} is created and cloned into ${created.rel} — the agent works there now.`);
  ctx.write(ctx.theme.gray(`  ${created.connection.web}`));
  return 0;
}

async function cloneRepository(ctx: Context, args: string[]): Promise<number> {
  const repo = args[0] ?? "";
  if (repo === "") throw new RemoteUsageError("a repository is named owner/name");
  const options = {
    repo,
    ...(ctx.options.dir === undefined ? {} : { dir: ctx.options.dir }),
    ...(ctx.options.branch === undefined ? {} : { branch: ctx.options.branch }),
  };

  if (ctx.options.github) {
    let token = ctx.options.token ?? "";
    if (ctx.options.tokenStdin) token = await readStdin();
    const cloned = await ctx.client.cloneGithubRepo({ ...options, token });
    if (ctx.options.json) {
      ctx.write(JSON.stringify(cloned, null, 2));
      return 0;
    }
    ctx.write(`${cloned.connection.repo} is cloned into ${cloned.rel} — the agent works there now.`);
    return 0;
  }

  const cloned = await ctx.client.cloneForgeRepo(options);
  if (ctx.options.json) {
    ctx.write(JSON.stringify(cloned, null, 2));
    return 0;
  }
  ctx.write(`${cloned.connection.repo} is cloned into ${cloned.rel} — the agent works there now.`);
  ctx.write(ctx.theme.gray(`  ${cloned.connection.url}`));
  return 0;
}

/**
 * Run what is in the working directory.
 *
 * The half that makes `genie remote new` something you can *use*: the repository
 * is created and cloned by the two commands above, and this starts it. The command
 * is the project's own unless `--command` says otherwise, because a project cloned
 * from a forge knows how it starts and a person who has just created one does not
 * have to look it up. It blocks the way the console's pane does not: the terminal
 * prints where the app is, and the server owns the process.
 */
async function runProject(ctx: Context, args: string[]): Promise<number> {
  const command = ctx.options.command ?? (args.length === 0 ? undefined : args.join(" ").trim());
  const status = await ctx.client.runProject(command === undefined || command === "" ? {} : { command });

  if (ctx.options.json) {
    ctx.write(JSON.stringify(status, null, 2));
    return 0;
  }
  if (status.error !== null) {
    ctx.write(status.error);
    return 1;
  }
  const where = status.command === null ? "the project" : `\`${status.command}\``;
  ctx.write(`running ${where} in ${status.cwd ?? "."} — the console reaches it at ${status.url}`);
  if (status.address !== null) ctx.write(ctx.theme.gray(`  published at ${status.address}`));
  if (status.pending === true) {
    ctx.write(ctx.theme.gray("  it has not answered yet; it is still starting"));
  }
  if (status.port !== null) ctx.write(ctx.theme.gray(`  listening on port ${status.port}`));
  return 0;
}

async function pushBranch(ctx: Context, args: string[]): Promise<number> {
  const branch = args[0] ?? "";
  if (branch === "") throw new RemoteUsageError("which branch? genie remote push <branch>");
  const result = ctx.options.github
    ? await ctx.client.pushGithubBranch({ branch })
    : await ctx.client.pushForgeBranch({ branch });
  ctx.write(`pushed ${result.branch} to ${result.repo}`);
  return 0;
}

async function openPullRequest(ctx: Context, args: string[]): Promise<number> {
  const head = args[0] ?? "";
  if (head === "") throw new RemoteUsageError("a branch to merge from is required: genie remote pr <head> [--branch <base>]");
  const title = args.slice(1).join(" ").trim() || `Agent changes to ${head}`;
  const base = ctx.options.branch;
  const input = { title, head, ...(base === undefined ? {} : { base }) };

  const pr = ctx.options.github ? await ctx.client.openGithubPullRequest(input) : await ctx.client.openForgePullRequest(input);
  ctx.write(
    pr.url ? `pull request #${pr.number ?? ""} opened: ${pr.url}` : `pull request opened on ${pr.repo} (${pr.head} → ${pr.base})`,
  );
  return 0;
}

/** The `remote` rows of `genie help`, defined beside the commands they describe. */
export function remoteHelpLines(): string[] {
  return [
    "  genie remote                         what is connected, and where Atlas is",
    "  genie remote ssh user@host:/path     mount a folder over SSH and work in it",
    "      --port <n>  --key-file <path>  --password-stdin",
    "  genie remote disconnect <which>       unmount it, and remove the key it held",
    "  genie remote atlas                    connect to Atlas with this deployment's credential",
    "  genie remote new \"<name>\"             create the repository on the forge, clone it, work in it",
    "  genie remote clone <owner/name>       clone a repository (--github for GitHub, --token-stdin for a token)",
    "  genie remote run [command]            run the project here (--command to say it yourself)",
    "  genie remote push <branch>            push a branch (--github for GitHub)",
    "  genie remote pr <head> [title…]        open a pull request (--branch <base>, --github)",
  ];
}
