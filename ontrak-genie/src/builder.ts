/**
 * The Genie → factory handoff.
 *
 * Olympus manufactures an app from `build-requests/<name>.md`, a spec whose
 * headings mirror `factory/APP_SPEC_TEMPLATE.md` exactly: `make app SPEC=…`
 * builds it locally, and `.github/workflows/olympus-app-builder.yml` builds the
 * same file on push. Until now the only browser surface that could write one was
 * Studio (`web/studio/lib/factory-spec.ts`); this module is Genie's half of that
 * same bridge, so a session that produced something worth building becomes
 * factory input instead of stopping at the preview.
 *
 * Two rules, both borrowed from the sibling implementation because they are the
 * reason it works:
 *
 * 1. **Deterministic.** The spec is assembled from what is actually in the
 *    workspace — the file set, their sizes, the entry point, the test command —
 *    with no second model call. A handoff you cannot predict is a handoff you
 *    cannot review, and this file is meant to be read before anything is
 *    manufactured.
 * 2. **Genie never learns to build.** This module writes a *request*. It does not
 *    plan, package, publish, or run anything: `nextSteps` names the commands, and
 *    Olympus runs them.
 *
 * What it deliberately does NOT do is infer the operator's intent. "Core
 * Purpose", "Features" and the stack the factory should honour are decisions, not
 * observations, so an unstated one is marked as unstated rather than guessed —
 * a spec that states a stack the project was not built to is how the factory
 * builds the wrong thing.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { workspaceRoot } from "./scope.js";
import { isIgnoredDir, readTextFile } from "./workspace.js";

/**
 * Cap on the reference appendix. Past this the spec lists the files without their
 * contents: a spec that dwarfs what it specifies is worse than a short one, and
 * the factory builds from the spec, not from a code dump.
 */
export const MAX_APPENDIX_CHARS = 60_000;

/** Beyond this the walk stops. A workspace is not a filesystem survey. */
export const MAX_FILES = 4_000;
export const MAX_DEPTH = 12;

/**
 * A filename we are willing to write. Strict, because it becomes a path: no
 * separator, no dot except the extension, no leading dash. `specSlug` already
 * cannot produce anything else, so this is the assertion that keeps a future
 * edit to the slug rule from turning into a traversal.
 */
export const SPEC_FILENAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}\.md$/;

/** What the operator chose the build to be. Not inferred — see `detectStack`. */
export type ProjectKind = "app" | "website";

export type FactorySpecInput = {
  /** The app's name, as it should appear in `# Application Specification: …`. */
  name: string;
  /** One sentence. What the app is for. */
  purpose?: string;
  /** What it must do, one per line. */
  features?: string[];
  kind?: ProjectKind;
  /** Workspace file set, as `path` + `bytes`. */
  files?: WalkedFile[];
};

export type FactorySpec = {
  /** Suggested filename inside `build-requests/` — path-safe by construction. */
  filename: string;
  markdown: string;
  /**
   * What to do with it next, in order, as commands that work as written. Returned
   * beside the markdown rather than only inside it: the UI offers these as
   * actions, and an operator should not have to copy a command out of a document
   * the app just generated in order to run the app's own handoff.
   */
  nextSteps: string[];
};

export type FactoryWriteResult = {
  filename: string;
  /** Absolute path on this machine (a container path under compose). */
  path: string;
  bytes: number;
  /** True when an existing spec was replaced. */
  replaced: boolean;
  nextSteps: string[];
};

export type WalkedFile = { path: string; bytes: number };

/** A refusal the route can turn into a status. Never a crash. */
export class FactorySpecError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FactorySpecError";
  }
}

/* ---- naming -------------------------------------------------------------- */

/**
 * A `build-requests/` filename stem. Everything outside `[a-z0-9]` collapses to a
 * single dash, so the result cannot contain a separator, a dot, or a leading
 * dash.
 */
export function specSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");

  return slug || "genie-app";
}

/* ---- the file set ------------------------------------------------------- */

/**
 * Walk the workspace, skipping what the jail already ignores.
 *
 * Symlinks are not followed and not listed. The walk reads file contents into a
 * spec, so following one would let a link inside the workspace pull in text from
 * outside it — the same escape `resolveInWorkspace` refuses for a tool call, and
 * the jail has to mean the same thing here or it does not mean anything.
 */
export async function walkWorkspace(
  root: string,
  options: { maxFiles?: number; maxDepth?: number } = {},
): Promise<WalkedFile[]> {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const found: WalkedFile[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= maxFiles) return;

    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable subtree: skip it rather than fail the export.
    }

    for (const dirent of dirents) {
      if (found.length >= maxFiles) return;
      // Dotfiles are the workspace's own machinery (`.git`, `.agent`, editor
      // state), not part of the app being described.
      if (dirent.name.startsWith(".")) continue;

      const child = path.join(dir, dirent.name);
      if (dirent.isSymbolicLink()) continue;

      if (dirent.isDirectory()) {
        if (isIgnoredDir(dirent.name)) continue;
        await visit(child, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;

      let bytes = 0;
      try {
        bytes = (await fs.stat(child)).size;
      } catch {
        continue;
      }
      found.push({ path: relativePath(root, child), bytes });
    }
  }

  await visit(root, 0);

  // Sorted, so the same workspace always produces the same spec — the whole
  // point of not asking a model.
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

function relativePath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/* ---- inference ---------------------------------------------------------- */

function matches(files: WalkedFile[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file.path.toLowerCase()));
}

/**
 * The file to open first, which depends on what the build is.
 *
 * A full-stack app has no page to open — nothing runs its client until it is
 * packaged — so the file that matters is the interface and, second, the data
 * model the API is derived from. A website's is its page. `index.html` is checked
 * last for both: it is also what a build made before either contract existed
 * looks like, and an exported spec should say what it is rather than claim the
 * build is empty.
 */
export function entryPoint(files: WalkedFile[], kind: ProjectKind = "app"): string | null {
  const first = (pattern: RegExp) => files.find((file) => pattern.test(file.path))?.path ?? null;

  const client = first(/(^|\/)src\/App\.(tsx|jsx)$/i);
  if (client) return client;
  if (kind === "app") {
    const schema = first(/(^|\/)server\/schema\.sql$/i);
    if (schema) return schema;
  }

  return first(/(^|\/)index\.html?$/i) ?? first(/\.html?$/i);
}

/**
 * The stack the factory should build to. The kind is stated first and
 * unconditionally: it is not inferred from file names because it is not an
 * inference — it is what the operator chose, and the factory has to honour it (a
 * website needs packaging; an app must not get it).
 */
export function detectStack(files: WalkedFile[], kind: ProjectKind): string[] {
  const stack: string[] = [];

  if (kind === "website") {
    stack.push("Static site — packaged to `dist/`, no server process");
  }

  if (matches(files, /(^|\/)package\.json$/)) stack.push("Node.js (`package.json` present)");
  if (matches(files, /(^|\/)tsconfig\.json$/)) stack.push("TypeScript");
  if (matches(files, /(^|\/)requirements\.txt$/) || matches(files, /\.py$/)) stack.push("Python");
  if (matches(files, /\.html?$/)) stack.push("HTML");
  if (matches(files, /\.css$/)) stack.push("CSS");
  if (matches(files, /\.(js|mjs|cjs|jsx|ts|tsx)$/)) stack.push("JavaScript / TypeScript");
  if (matches(files, /\.(sql|db|sqlite)$/)) stack.push("SQL / SQLite");
  if (matches(files, /\.(json|ya?ml|toml)$/)) stack.push("Config (JSON / YAML / TOML)");

  // The kind line above is what the operator chose; this is what the files say,
  // and with no files it says nothing. Claiming a stack from an empty workspace is
  // the one case where guessing is worse than admitting the gap — the factory
  // would manufacture something nobody described.
  if (files.length === 0) {
    stack.push("Not inferred from the file set — no files found, confirm before manufacturing");
  }

  return stack;
}

/**
 * What the factory should run to prove the app works.
 *
 * Derived from the files that are actually present rather than stated, because
 * this is an observation and not a decision: a command the workspace cannot run
 * is a criterion that fails for a reason that has nothing to do with the app.
 */
export function verificationCriteria(files: WalkedFile[], kind: ProjectKind): string[] {
  const criteria: string[] = [];

  const nodeProject = matches(files, /(^|\/)package\.json$/);
  const pythonProject = matches(files, /(^|\/)requirements\.txt$/) || matches(files, /\.py$/);

  if (nodeProject) {
    criteria.push("`npm install` completes");
    if (matches(files, /(^|\/)tsconfig\.json$/)) criteria.push("`npm run typecheck` completes");
    criteria.push("`npm test` completes");
  }
  if (pythonProject) criteria.push("`python3 -m unittest` completes");

  if (criteria.length === 0) {
    // No runner in the file set. The honest criterion for a static build is that
    // it renders, which is what a website is for.
    criteria.push(
      kind === "website"
        ? "the built page renders at 360px and 1440px with no console errors"
        : "Not derived — no test runner in the file set, confirm before manufacturing",
    );
  }

  const entry = entryPoint(files, kind);
  if (entry && kind === "website") criteria.push(`the page served from \`${entry}\` renders`);

  return criteria;
}

/* ---- assembly ----------------------------------------------------------- */

function bytesLabel(count: number): string {
  if (count < 1024) return `${count} B`;
  return `${(count / 1024).toFixed(1)} KB`;
}

/**
 * Read what can be read, until the appendix cap is reached. Files are taken in
 * the walk's order (already sorted), so a truncated appendix is truncated the
 * same way every time.
 *
 * A binary or oversized file is listed and skipped rather than included: this is
 * reference material, and a spec full of `\u0000` helps nobody.
 */
async function appendix(
  root: string,
  files: WalkedFile[],
  limit: number,
): Promise<{ text: string; included: number; skipped: number }> {
  const chunks: string[] = [];
  let used = 0;
  let included = 0;
  let skipped = 0;

  for (const file of files) {
    const block = (body: string) =>
      `### \`${file.path}\` (${bytesLabel(file.bytes)})\n\n\`\`\`\n${body.trimEnd()}\n\`\`\`\n`;

    if (used >= limit) {
      skipped += 1;
      continue;
    }

    let content: string;
    try {
      const read = await readTextFile(path.join(root, file.path), 40_000);
      if (read.truncated) {
        // A truncated file is not the file. List it, do not quote it.
        skipped += 1;
        continue;
      }
      content = read.content;
    } catch {
      skipped += 1;
      continue;
    }

    if (used + content.length > limit) {
      skipped += 1;
      continue;
    }

    chunks.push(block(content));
    used += content.length;
    included += 1;
  }

  if (chunks.length === 0) return { text: "", included: 0, skipped };

  const note =
    skipped > 0
      ? `\n_${included} of ${files.length} file(s) quoted; ${skipped} listed in the index but not quoted (binary, oversized, or past the ${Math.round(limit / 1000)}k appendix cap)._\n`
      : "";

  return { text: chunks.join("\n") + note, included, skipped };
}

/**
 * Assemble the spec. Deterministic: the same workspace and the same stated intent
 * always produce the same bytes.
 */
export async function buildFactorySpec(
  input: FactorySpecInput,
  options: { root?: string; files?: WalkedFile[] } = {},
): Promise<FactorySpec> {
  const name = input.name.trim();
  if (name === "") throw new FactorySpecError("a name is required", 400);

  const kind: ProjectKind = input.kind === "website" ? "website" : "app";
  const root = options.root ?? workspaceRoot();
  const files = options.files ?? (await walkWorkspace(root));

  const purpose = input.purpose?.trim() ?? "";
  const features = (input.features ?? []).map((line) => line.trim()).filter((line) => line !== "");
  const entry = entryPoint(files, kind);

  const lines: string[] = [];
  lines.push(`# Application Specification: ${name}`);
  lines.push("");
  lines.push("## 🎯 Core Purpose");
  lines.push(
    purpose !== ""
      ? purpose
      : "Not stated — the operator must describe this in one sentence before manufacturing.",
  );
  lines.push("");

  lines.push("## 🧰 Tech Stack");
  for (const item of detectStack(files, kind)) lines.push(`- ${item}`);
  lines.push(
    `- ${kind === "website" ? "Website" : "Application"} — the kind this request was exported as, and what the factory packages it as`,
  );
  if (entry) lines.push(`- Entry point: \`${entry}\``);
  lines.push("");

  lines.push("## 🛠️ Key Features & Pages");
  if (features.length > 0) {
    features.forEach((feature, index) => lines.push(`${index + 1}. **Feature ${index + 1}**: ${feature}`));
  } else {
    lines.push(
      "1. **Not listed**: the operator must fill these in. This section is not inferred from the file set — the files say what was written, not what it is for.",
    );
  }
  lines.push("");

  lines.push("## 🚦 Verification Criteria");
  for (const item of verificationCriteria(files, kind)) lines.push(`- ${item}`);
  lines.push("");

  // The index is what makes the spec reviewable without the workspace in front of
  // you: every file, in order, with its size.
  lines.push("---");
  lines.push("");
  lines.push("## File index");
  lines.push("");
  if (files.length === 0) {
    lines.push("_The workspace was empty when this request was exported._");
  } else {
    for (const file of files) lines.push(`- \`${file.path}\` — ${bytesLabel(file.bytes)}`);
  }
  lines.push("");

  const quoted = await appendix(root, files, MAX_APPENDIX_CHARS);
  if (quoted.text !== "") {
    lines.push("## Reference: current file contents");
    lines.push("");
    lines.push(
      "Quoted from the workspace as it stood when this request was exported. This is the starting point the factory replaces, not the app it must produce.",
    );
    lines.push("");
    lines.push(quoted.text);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `_Exported by OnTrak Genie from a workspace. ${files.length} file(s) indexed` +
      (quoted.included > 0 ? `, ${quoted.included} quoted` : "") +
      ". The factory builds from this document, not from the workspace._",
  );
  lines.push("");

  const filename = `${specSlug(name)}.md`;
  if (!SPEC_FILENAME_PATTERN.test(filename)) {
    // Unreachable while `specSlug` is what it is. Asserted anyway, because this
    // string becomes a path and an unreachable branch is cheaper than a traversal.
    throw new FactorySpecError(`refusing to write an unsafe filename: ${filename}`, 500);
  }

  return { filename, markdown: lines.join("\n"), nextSteps: nextStepsFor(filename) };
}

function nextStepsFor(filename: string): string[] {
  return [
    `Place the spec in Olympus as \`build-requests/${filename}\``,
    `Manufacture it: \`make app SPEC=build-requests/${filename}\``,
    `Or push it — \`.github/workflows/olympus-app-builder.yml\` builds \`build-requests/*.md\` on push`,
  ];
}

/* ---- writing ------------------------------------------------------------ */

/**
 * Write the spec into the configured factory directory.
 *
 * The directory is never derived from the workspace: Genie does not assume where
 * Olympus lives, so an unconfigured deployment returns the spec instead of
 * guessing at a path. An existing spec is refused unless `overwrite` is set, which
 * keeps a hand-edited request from being silently replaced by its own export.
 */
export async function writeFactorySpec(
  dir: string,
  spec: FactorySpec,
  options: { overwrite?: boolean } = {},
): Promise<FactoryWriteResult> {
  if (!SPEC_FILENAME_PATTERN.test(spec.filename)) {
    throw new FactorySpecError(`refusing to write an unsafe filename: ${spec.filename}`, 500);
  }

  const target = path.join(path.resolve(dir), spec.filename);
  // Belt and braces: even with a safe filename, the resolved target must stay in
  // the directory the deployment named.
  const base = path.resolve(dir);
  if (target !== path.join(base, spec.filename) || path.dirname(target) !== base) {
    throw new FactorySpecError("refusing to write outside the factory directory", 400);
  }

  let existed = false;
  try {
    await fs.access(target);
    existed = true;
  } catch {
    existed = false;
  }

  if (existed && options.overwrite !== true) {
    throw new FactorySpecError(
      `${spec.filename} already exists in the factory directory; pass overwrite to replace it`,
      409,
    );
  }

  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(target, spec.markdown, "utf8");

  return {
    filename: spec.filename,
    path: target,
    bytes: Buffer.byteLength(spec.markdown, "utf8"),
    replaced: existed,
    nextSteps: spec.nextSteps,
  };
}
