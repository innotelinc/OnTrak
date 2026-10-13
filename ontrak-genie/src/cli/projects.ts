/**
 * `genie projects` — the saved workspace projects, and their portable bundles.
 *
 * The console has had both halves of this since they were written: a project is a
 * *named directory* kept in the sandbox (`src/projects.ts`), and a bundle is one
 * project as a *single file* you can keep, hand to somebody, or take to another
 * deployment (`src/project-archive.ts`). What neither had was a way to do it
 * without a browser — which is exactly the case a bundle matters most for, since
 * moving a project between deployments and into version control is a thing you do
 * from a shell.
 *
 * This module is the terminal's side of those routes and **only** that side:
 * every decision about what a project is, where it lives and what may be bundled
 * stays on the server, over the same endpoints the console calls. Three things
 * here are the CLI's own, and they are the reason this is a module rather than a
 * switch statement in `main.ts`:
 *
 *   - **The subcommand.** `genie projects new "My App"` is read here, so the
 *     aliases (`save`, `ls`, `rm`) are one table rather than a chain of `if`s, and
 *     a subcommand nobody defined is a usage error with the list of what exists.
 *   - **Naming a project.** A person reading a list counts rows (`genie projects
 *     open 2`), and also knows what they called the thing (`genie projects open
 *     "My App"`). Both are resolved here — the same bargain `/resume` makes with
 *     a chat — because the ids are uuids and nobody types a uuid.
 *   - **The file.** Export writes a bundle somewhere and import reads one from
 *     somewhere; `-` means stdout and stdin respectively, so a bundle can be piped
 *     between two deployments without a temporary file.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { GenieClient } from "./client.js";
import type { Theme } from "./render.js";
import type { ProjectView } from "../projects.js";

/** A command line this module cannot carry out as written. Exit code 2. */
export class ProjectUsageError extends Error {}

export type ProjectSub = "list" | "new" | "open" | "rename" | "remove" | "export" | "import";

/**
 * Every spelling that resolves to a subcommand. `save` is `new` said plainly,
 * which is the word for what it does.
 *
 * A Map rather than an object literal because the key is the user's word: on an
 * object, `genie projects constructor` would find `Object.prototype.constructor`
 * and every subcommand called `toString` would be "supported".
 */
const SUBCOMMANDS = new Map<string, ProjectSub>([
  ["list", "list"],
  ["ls", "list"],
  ["new", "new"],
  ["save", "new"],
  ["create", "new"],
  ["add", "new"],
  ["open", "open"],
  ["use", "open"],
  ["rename", "rename"],
  ["mv", "rename"],
  ["remove", "remove"],
  ["rm", "remove"],
  ["delete", "remove"],
  ["export", "export"],
  ["import", "import"],
]);

export interface ProjectsInvocation {
  sub: ProjectSub;
  /** The words after the subcommand. */
  args: string[];
}

/**
 * Read `genie projects …` into a subcommand.
 *
 * Bare `genie projects` lists, because the useful thing to do with the noun on
 * its own is see it. Anything else must be a word in the table.
 */
export function parseProjectsCommand(rest: string[]): ProjectsInvocation {
  const head = (rest[0] ?? "").toLowerCase();
  if (head === "") return { sub: "list", args: [] };
  const sub = SUBCOMMANDS.get(head);
  if (sub === undefined) {
    throw new ProjectUsageError(
      `unknown projects subcommand "${rest[0] ?? ""}" — try list, new, open, rename, remove, export or import`,
    );
  }
  return { sub, args: rest.slice(1) };
}

/**
 * The project an argument names: `3` is the third row of the list, `"My App"` is
 * the name, and a full id or an unambiguous prefix of one is the project itself.
 *
 * Deliberately forgiving about case on the name, because the name is the thing a
 * person remembers, and deliberately strict about ambiguity on an id prefix: two
 * matches is not a guess worth making when `genie projects` prints the list.
 */
export function findProject(wanted: string, projects: ProjectView[]): ProjectView | null {
  const target = wanted.trim();
  if (target === "") return null;

  if (/^\d+$/.test(target)) {
    const row = projects[Number.parseInt(target, 10) - 1];
    if (row !== undefined) return row;
    // A project may be *called* "2026", so a number that is not a row falls
    // through to the name rather than being refused for being made of digits.
  }

  const lower = target.toLowerCase();
  const byName = projects.find((project) => project.name.trim().toLowerCase() === lower);
  if (byName !== undefined) return byName;

  const byId = projects.find((project) => project.id === target);
  if (byId !== undefined) return byId;

  const prefixed = projects.filter((project) => project.id.startsWith(target));
  return prefixed.length === 1 ? (prefixed[0] as ProjectView) : null;
}

/** One row of the list, in the shape `sessions` already prints one in. */
export function formatProjectRow(index: number, project: ProjectView): string {
  const notes = [
    project.description,
    project.active ? "open" : "",
    project.exists ? "" : "folder missing",
  ].filter((note) => note !== "");
  return (
    `  ${String(index).padStart(3)}  ${project.name.slice(0, 36).padEnd(36)} ` +
    `${project.id.slice(0, 8)}  ${project.dir}${notes.length === 0 ? "" : `  (${notes.join(", ")})`}`
  );
}

export interface ProjectOptions {
  /** Print the server's own payload instead of a sentence. */
  json: boolean;
  /** `--out`: where an exported bundle is written. `-` is stdout. */
  out?: string;
  /** `--files`: with `remove`, delete the project's folder as well as the entry. */
  deleteFiles: boolean;
}

/**
 * A whole `projects` line: the subcommand, and the two flags it takes.
 *
 * The flags are read here as well as from the launch line because the REPL has no
 * flag parser of its own — `/projects export --out bundle.json` is a line somebody
 * typed, not this process's argv. If this did not read it, the file name would be
 * taken for the name of a project and reported as one that does not exist, which
 * is a worse answer than the one the same words get from the shell.
 */
export function parseProjectsLine(rest: string[], defaults: ProjectOptions): {
  invocation: ProjectsInvocation;
  options: ProjectOptions;
} {
  const words: string[] = [];
  let out = defaults.out;
  let deleteFiles = defaults.deleteFiles;

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    const split = word.indexOf("=");
    const name = split === -1 ? word : word.slice(0, split);
    const inline = split === -1 ? undefined : word.slice(split + 1);

    if (name === "--out" || name === "-o") {
      const value = inline ?? rest[index + 1] ?? "";
      if (inline === undefined) index += 1;
      if (value.trim() === "") {
        throw new ProjectUsageError("`--out` needs a file: --out <file>, or --out - for stdout");
      }
      out = value;
      continue;
    }
    if (name === "--files") {
      deleteFiles = true;
      continue;
    }
    // A bare `-` is not a flag here: it is how export says stdout and import says
    // stdin.
    if (name.startsWith("-") && name !== "-") {
      throw new ProjectUsageError(`unknown option ${name} for projects`);
    }
    words.push(word);
  }

  return { invocation: parseProjectsCommand(words), options: { ...defaults, out, deleteFiles } };
}

interface Context {
  client: GenieClient;
  theme: Theme;
  options: ProjectOptions;
  write: (line: string) => void;
}

/**
 * Run one `genie projects …` command. Returns the process exit code.
 *
 * A `ProjectUsageError` means the command line could not be carried out as
 * written — an unknown subcommand, a name that matches nothing, a file that is
 * not there. Everything else (a refusal from the server) is the caller's to
 * report, which is why it is left to propagate.
 */
export async function runProjects(
  client: GenieClient,
  theme: Theme,
  invocation: ProjectsInvocation,
  options: ProjectOptions,
): Promise<number> {
  const ctx: Context = { client, theme, options, write: (line) => process.stdout.write(`${line}\n`) };
  switch (invocation.sub) {
    case "list":
      return await listSaved(ctx);
    case "new":
      return await saveNew(ctx, invocation.args);
    case "open":
      return await openSaved(ctx, invocation.args);
    case "rename":
      return await renameSaved(ctx, invocation.args);
    case "remove":
      return await forget(ctx, invocation.args);
    case "export":
      return await writeBundle(ctx, invocation.args);
    case "import":
      return await readBundle(ctx, invocation.args);
  }
}

/* ----------------------------------------------------------------- verbs -- */

async function listSaved(ctx: Context): Promise<number> {
  const { projects, active, base } = await ctx.client.projects();
  if (ctx.options.json) {
    ctx.write(JSON.stringify(projects, null, 2));
    return 0;
  }
  if (projects.length === 0) {
    ctx.write(ctx.theme.gray('no projects yet — `genie projects new "My App"` saves one'));
    return 0;
  }
  projects.forEach((project, index) => ctx.write(formatProjectRow(index + 1, project)));
  ctx.write(
    ctx.theme.gray(
      `  ${projects.length} project(s) in ${base} — ` +
        (active === "" ? "none of them is open" : `open: ${active}`),
    ),
  );
  return 0;
}

/**
 * Save a project, and open it.
 *
 * Opening is not a second decision here: the console creates and opens in one
 * gesture (`POST /api/projects { open: true }`), and a project saved to be worked
 * in but not worked in would be a surprise of the CLI's own invention.
 */
async function saveNew(ctx: Context, args: string[]): Promise<number> {
  const name = args.join(" ").trim();
  if (name === "") throw new ProjectUsageError('a project needs a name: genie projects new "My App"');

  const project = await ctx.client.createProject(name, { open: true });
  if (ctx.options.json) {
    ctx.write(JSON.stringify(project, null, 2));
    return 0;
  }
  ctx.write(`${ctx.theme.green("saved")} ${ctx.theme.bold(project.name)}  ${project.dir}`);
  ctx.write(ctx.theme.gray(`  the agent now works in ${project.path}`));
  return 0;
}

async function openSaved(ctx: Context, args: string[]): Promise<number> {
  const wanted = args.join(" ").trim();
  const usage = "genie projects open <name|number|id>";
  const target = await resolveProject(ctx, wanted, usage);

  const project = await ctx.client.openProject(target.id);
  if (ctx.options.json) {
    ctx.write(JSON.stringify(project, null, 2));
    return 0;
  }
  ctx.write(`${ctx.theme.green("open")} ${ctx.theme.bold(project.name)}  ${ctx.theme.gray(project.path)}`);
  if (!project.exists) {
    ctx.write(ctx.theme.yellow("  that folder is not there any more — saving a project does not create it again"));
  }
  return 0;
}

async function renameSaved(ctx: Context, args: string[]): Promise<number> {
  const [wanted, ...rest] = args;
  const name = rest.join(" ").trim();
  const usage = 'genie projects rename <name|number|id> "<new name>"';
  if (wanted === undefined || name === "") throw new ProjectUsageError(`usage: ${usage}`);

  const target = await resolveProject(ctx, wanted, usage);
  const project = await ctx.client.updateProject(target.id, { name });
  if (ctx.options.json) {
    ctx.write(JSON.stringify(project, null, 2));
    return 0;
  }
  ctx.write(`${ctx.theme.green("renamed")} ${target.name} → ${ctx.theme.bold(project.name)}`);
  return 0;
}

/**
 * Forget a project — and only its folder when asked.
 *
 * Removing the entry and deleting the work are separate decisions, so they are
 * separate spellings: `remove` unlists, `remove --files` also deletes. The
 * default is the one that cannot lose anything.
 */
async function forget(ctx: Context, args: string[]): Promise<number> {
  const wanted = args.join(" ").trim();
  const usage = "genie projects remove <name|number|id> [--files]";
  const target = await resolveProject(ctx, wanted, usage);

  const removed = await ctx.client.deleteProject(target.id, ctx.options.deleteFiles);
  if (ctx.options.json) {
    ctx.write(JSON.stringify({ removed, files: ctx.options.deleteFiles, project: target }, null, 2));
    return 0;
  }
  if (!removed) {
    ctx.write(ctx.theme.gray(`${target.name} was already gone`));
    return 0;
  }
  ctx.write(`${ctx.theme.green("forgot")} ${ctx.theme.bold(target.name)}`);
  ctx.write(
    ctx.theme.gray(
      ctx.options.deleteFiles
        ? "  its folder went with it"
        : `  its folder is untouched (${target.dir}) — add --files to delete that too`,
    ),
  );
  if (target.active) {
    ctx.write(ctx.theme.yellow("  that was the working directory — open another project before the next turn"));
  }
  return 0;
}

/**
 * Write a project out as one bundle.
 *
 * With no name, the open project is exported, which is the case you are in when
 * you are working and think "let me keep this". `-o -` puts the bundle itself on
 * stdout and the sentence about it on stderr, so `genie projects export -o - >
 * my-project.genie-project.json` writes the file with the file and nothing else.
 */
async function writeBundle(ctx: Context, args: string[]): Promise<number> {
  const wanted = args.join(" ").trim();
  const usage = "genie projects export [name|number|id] [--out <file>]";
  const target = await resolveProject(ctx, wanted, usage);

  const bundle = await ctx.client.exportProject(target.id);
  const summary = {
    project: target.name,
    filename: bundle.filename,
    files: bundle.files,
    skipped: bundle.skipped,
  };

  if (ctx.options.out === "-") {
    process.stdout.write(bundle.content);
    process.stderr.write(`${describeExport(summary)}\n`);
    return 0;
  }

  const destination = ctx.options.out ?? bundle.filename;
  try {
    await fs.writeFile(destination, bundle.content, "utf8");
  } catch (error) {
    throw new ProjectUsageError(`cannot write ${destination}: ${(error as Error).message}`);
  }

  if (ctx.options.json) {
    ctx.write(JSON.stringify({ ...summary, path: path.resolve(destination) }, null, 2));
    return 0;
  }
  ctx.write(`${ctx.theme.green("wrote")} ${path.resolve(destination)}`);
  ctx.write(ctx.theme.gray(`  ${describeExport(summary)}`));
  return 0;
}

function describeExport(summary: { project: string; files: number; skipped: string[] }): string {
  const skipped =
    summary.skipped.length === 0 ? "" : `; left out ${summary.skipped.length}: ${summary.skipped.join(", ")}`;
  return `${summary.project}: ${summary.files} file(s)${skipped}`;
}

/**
 * Load a bundle as a new project, and open it.
 *
 * The bundle is whatever the server was handed, so a bundle exported from another
 * deployment loads here unchanged; a name already in use gets a count rather than
 * overwriting anything, which is the server's rule and not re-stated here.
 */
async function readBundle(ctx: Context, args: string[]): Promise<number> {
  const source = args.join(" ").trim();
  if (source === "") {
    throw new ProjectUsageError("usage: genie projects import <file>  (use - to read a bundle from stdin)");
  }

  let content: string;
  try {
    content = source === "-" ? await readStdin() : await fs.readFile(source, "utf8");
  } catch (error) {
    throw new ProjectUsageError(`cannot read ${source}: ${(error as Error).message}`);
  }

  const loaded = await ctx.client.importProject(content, { open: true });
  if (ctx.options.json) {
    ctx.write(JSON.stringify(loaded, null, 2));
    return 0;
  }
  ctx.write(`${ctx.theme.green("loaded")} ${ctx.theme.bold(loaded.project.name)}  ${loaded.project.dir}`);
  ctx.write(ctx.theme.gray(`  ${loaded.files} file(s) in ${loaded.project.path}`));
  if (loaded.skipped.length > 0) {
    ctx.write(ctx.theme.gray(`  the bundle had left out: ${loaded.skipped.join(", ")}`));
  }
  return 0;
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * The project an argument names, or the open one when nothing was named.
 *
 * Named almost anywhere the empty case is legitimate — `export` on its own means
 * "the one I am in". When there is nothing to fall back to, the message says what
 * to type instead of reporting a null.
 */
async function resolveProject(ctx: Context, wanted: string, usage: string): Promise<ProjectView> {
  const { projects } = await ctx.client.projects();
  if (wanted === "") {
    if (projects.length === 0) {
      throw new ProjectUsageError('no projects are saved yet — `genie projects new "My App"` saves one');
    }
    const active = projects.find((project) => project.active);
    if (active !== undefined) return active;
    throw new ProjectUsageError(`no project is open, so name one: ${usage}`);
  }
  const found = findProject(wanted, projects);
  if (found === null) {
    throw new ProjectUsageError(`no project matches "${wanted}" — \`genie projects\` lists them`);
  }
  return found;
}

/** Everything on stdin, so a bundle can be piped between deployments. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
