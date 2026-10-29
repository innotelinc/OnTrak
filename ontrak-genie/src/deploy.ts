import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { config } from "./config.js";
import { parseRepoSpec, redactToken, repoSlug } from "./repo-rules.js";
import { runShellCommand, type ShellResult } from "./shell.js";
import { isDirectory, pathExists, resolveInWorkspace, toRel } from "./workspace.js";

/**
 * Shipping the built app to a host, not just to a git remote.
 *
 * `ship` and `publish` answer "where is the source", and for this product that
 * has always been enough: the repository is the deliverable and the preview is
 * how you look at it. But the sentence a person actually says after the preview
 * works is "put it somewhere I can send this link", and that is a different
 * question — it needs the *built* output, the host's own API, and a credential
 * for that host.
 *
 * Three targets, chosen because they are the three ways a small app goes public
 * without a conversation with an account manager:
 *
 *   netlify        a zip upload to the site's deploy API
 *   vercel         an inline file list to the deployments API
 *   github-pages   the output committed to `gh-pages` and pushed over git
 *
 * They share one pipeline, and the sharing is the point: resolve the directory,
 * build it once, collect the built files once, then hand that same set to
 * whichever transport was asked for. A second implementation per host would mean
 * three answers to "what counts as the build output" and three places for the
 * upload to be quietly missing a file.
 *
 * **The build is not optional when the project has one.** Deploying a source tree
 * that needs a build produces a 404 with a green checkmark, so a project with a
 * `build` script is built, and a build that fails stops the deploy with its output
 * rather than shipping last week's `dist`.
 *
 * Nothing here reaches a host in a test: `deps.run` and `deps.fetch` are
 * injectable, which is how the zip, the file list and the push are checked
 * without a network or a credential.
 */

export type DeployTargetId = "netlify" | "vercel" | "github-pages";

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  /** Whether this deployment holds everything it needs without asking. */
  ready: boolean;
  /** What is missing, when it is not ready. */
  needs: string | null;
}

export interface DeployedFile {
  /** Path inside the deployed site, forward-slashed. */
  path: string;
  data: Buffer;
}

export interface DeployInput {
  target?: unknown;
  /** Sandbox-relative project directory; defaults to the selected workspace. */
  dir?: unknown;
  /** Project name, for the host's site name. Derived from the directory otherwise. */
  name?: unknown;
  /** `owner/name`, for GitHub Pages. */
  repo?: unknown;
  /** The caller's token for the chosen host, when the deployment has none. */
  token?: unknown;
  /** Explicit output directory, relative to `dir`. */
  output?: unknown;
  /** `false` deploys the directory as it is instead of building it. */
  build?: unknown;
  /** The commit message, for GitHub Pages. */
  message?: unknown;
}

export interface DeployResult {
  target: DeployTargetId;
  url: string;
  /** How many files were uploaded, and their total size. */
  files: number;
  bytes: number;
  /** Whether a build ran, and the tail of its output. */
  built: boolean;
  buildLog: string;
  /** The directory that was uploaded, workspace-relative. */
  output: string;
}

/** Injectable boundaries, so the pipeline is testable without a network. */
export interface DeployDeps {
  run: (options: { command: string; cwd: string; timeoutMs?: number }) => Promise<ShellResult>;
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
  ) => Promise<{ status: number; text: string }>;
}

const defaultDeps: DeployDeps = {
  run: (options) => runShellCommand(options),
  fetch: async (url, init) => {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      // `Uint8Array<ArrayBufferLike>` is a valid body at runtime but the DOM's
      // `BodyInit` type does not name it; the cast is the type system's, not ours.
      ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
      signal: AbortSignal.timeout(config.deployTimeoutMs),
    });
    return { status: response.status, text: await response.text() };
  },
};

/** Where each target's output ends up, and what it needs to get there. */
export function deployTargets(): DeployTarget[] {
  return [
    {
      id: "netlify",
      label: "Netlify",
      ready: config.netlifyToken !== "",
      needs: config.netlifyToken === "" ? "NETLIFY_TOKEN" : null,
    },
    {
      id: "vercel",
      label: "Vercel",
      ready: config.vercelToken !== "",
      needs: config.vercelToken === "" ? "VERCEL_TOKEN" : null,
    },
    {
      id: "github-pages",
      label: "GitHub Pages",
      // A repository is always named by the caller, so this one is usable with a
      // token it is handed even on a deployment that holds none.
      ready: true,
      needs: config.gitToken === "" ? "a GitHub token" : null,
    },
  ];
}

const TARGET_IDS: readonly DeployTargetId[] = ["netlify", "vercel", "github-pages"];

function normalizeTarget(value: unknown): DeployTargetId | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  if (id === "") return null;
  const aliases: Record<string, DeployTargetId> = {
    netlify: "netlify",
    vercel: "vercel",
    "github-pages": "github-pages",
    ghpages: "github-pages",
    "gh-pages": "github-pages",
    github: "github-pages",
  };
  return aliases[id] ?? null;
}

/** The name a site gets when the caller named none: the directory's own. */
function siteNameFrom(dir: string, requested: unknown): string {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const source = raw !== "" ? raw : path.basename(dir);
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (slug !== "") return slug;
  return `genie-${Date.now().toString(36)}`;
}

/** The tail of a long output, which is where a build's error actually is. */
function tail(text: string, limit = 3000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}

/** Directories a build writes its output to, in the order they are tried. */
const OUTPUT_CANDIDATES = ["dist", "build", "out", ".output/public"];

/**
 * Find the built output.
 *
 * An explicit `output` wins and is checked, because a wrong one must be an error
 * rather than a silent fallback to uploading the source. Otherwise the common
 * output directories are tried, and a directory that is already a static site
 * (`index.html` at its root) is its own output — which is the case for the
 * projects this console builds most often.
 */
async function resolveOutput(dir: string, requested: unknown): Promise<string> {
  if (typeof requested === "string" && requested.trim() !== "") {
    // Relative to the project, not to the workspace root: "dist" beside the
    // package.json is what a person means. Resolved through the workspace fence so
    // `../` cannot point the upload at a directory outside it.
    const joined = path.join(toRel(dir), requested.trim());
    const explicit = resolveInWorkspace(joined);
    if (!(await isDirectory(explicit))) throw new DeployError(`${requested.trim()} is not a directory`);
    return explicit;
  }

  const candidate = async (rel: string): Promise<string | null> => {
    const abs = path.join(dir, rel);
    return (await isDirectory(abs)) ? abs : null;
  };

  /*
   * A build output directory wins over an `index.html` at the root, because a
   * project that has both is a project whose root `index.html` is a *source* (a
   * Vite or Next template) and whose real site is in `dist`. Deploying the root
   * would publish an unbuilt page with none of its assets.
   */
  for (const rel of OUTPUT_CANDIDATES) {
    const found = await candidate(rel);
    if (found === null) continue;
    const entries = await fs.readdir(found).catch(() => []);
    if (entries.length > 0) return found;
  }
  // No build output at all: a plain static site is its own output.
  if (await pathExists(path.join(dir, "index.html"))) return dir;
  throw new DeployError(
    "there is no built output to deploy: no index.html here and no dist, build or out directory. " +
      "Build the project first, or pass the output directory.",
  );
}

/**
 * Build the project when it has a build script.
 *
 * The package manager is inferred from the lockfile that is present rather than
 * assumed to be npm: a pnpm project built with `npm run build` can install the
 * wrong tree, and the failure would look like a broken app rather than a wrong
 * command.
 */
async function runBuild(
  dir: string,
  requested: unknown,
  deps: DeployDeps,
): Promise<{ built: boolean; log: string }> {
  if (requested === false || requested === "false") return { built: false, log: "" };
  const manifest = path.join(dir, "package.json");
  if (!(await pathExists(manifest))) return { built: false, log: "" };

  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(await fs.readFile(manifest, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return { built: false, log: "" };
  }
  if (typeof scripts.build !== "string" || scripts.build.trim() === "") return { built: false, log: "" };

  const manager = (await pathExists(path.join(dir, "pnpm-lock.yaml")))
    ? "pnpm run build"
    : (await pathExists(path.join(dir, "yarn.lock")))
      ? "yarn build"
      : (await pathExists(path.join(dir, "bun.lockb")))
        ? "bun run build"
        : "npm run build";

  const result = await deps.run({ command: manager, cwd: dir, timeoutMs: config.deployBuildTimeoutMs });
  if (result.refused !== undefined) throw new DeployError(`the build was refused: ${result.refused}`);
  if (!result.ok || result.timedOut) {
    throw new DeployError(
      `the build failed, so nothing was deployed:\n${tail(result.output) || "(no output)"}`,
    );
  }
  return { built: true, log: tail(result.output) };
}

/** Directories that are never part of a deployed site. */
const SKIP_ENTRIES = new Set([".git", ".agent", "node_modules", "__pycache__", ".venv", ".gopath", ".cargo"]);

/**
 * Read the output into memory, once, for every transport.
 *
 * Bounded: a site that is larger than the ceiling is refused with its size rather
 * than uploaded until a host rejects it halfway. Symlinks are skipped rather than
 * followed, so a link out of the output cannot pull a file from outside the
 * workspace into a published site.
 */
export async function collectFiles(
  root: string,
): Promise<{ files: DeployedFile[]; bytes: number }> {
  const files: DeployedFile[] = [];
  let bytes = 0;

  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_ENTRIES.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;

      const data = await fs.readFile(childAbs).catch(() => null);
      if (data === null) continue;
      bytes += data.length;
      if (bytes > config.deployMaxBytes) {
        throw new DeployError(
          `the built site is larger than ${Math.round(config.deployMaxBytes / (1024 * 1024))} MB; ` +
            "deploy it from CI, or raise AGENT_DEPLOY_MAX_BYTES",
        );
      }
      if (files.length >= 5000) {
        throw new DeployError("the built site has more than 5000 files; deploy it from CI instead");
      }
      files.push({ path: childRel, data });
    }
  };

  await walk(root, "");
  if (files.length === 0) throw new DeployError("the output directory is empty, so there is nothing to deploy");
  return { files, bytes };
}

// --- zip (stored) -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP with every entry stored, not deflated.
 *
 * Netlify's deploy API takes a zip and nothing else, and this repository has a
 * zip *reader* (`src/zip.ts`) but no writer — a dependency for one `POST` would be
 * a dependency in the image and in every future audit of it. A stored archive is
 * valid ZIP that every unzipper reads; it is larger than a compressed one, which
 * is the trade for sixty lines and no new module.
 */
export function zipStore(files: readonly DeployedFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, file.data);
    centrals.push(central);
    offset += local.length + size;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

// --- transports -------------------------------------------------------------

async function jsonOf(response: { status: number; text: string }, what: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text) as unknown;
  } catch {
    throw new DeployError(`${what} answered HTTP ${response.status} with a body that is not JSON: ${response.text.slice(0, 300)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    const record = parsed as { message?: unknown; error?: unknown; errors?: unknown };
    const detail = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : response.text.slice(0, 300);
    throw new DeployError(`${what} refused the deploy (HTTP ${response.status}): ${detail}`);
  }
  return parsed as Record<string, unknown>;
}

async function deployNetlify(
  files: readonly DeployedFile[],
  name: string,
  token: string,
  deps: DeployDeps,
): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  let siteId = config.netlifySiteId;

  if (siteId === "") {
    // No site configured: create one. A name that is taken comes back as an
    // error, which is the honest answer — reusing somebody else's site because
    // the slug matched would deploy into a project this caller does not own.
    const created = await jsonOf(
      await deps.fetch("https://api.netlify.com/api/v1/sites", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
      "Netlify",
    );
    siteId = typeof created.id === "string" ? created.id : "";
    if (siteId === "") throw new DeployError("Netlify created no site id, so there is nothing to deploy to");
  }

  const zip = zipStore(files);
  const deployed = await jsonOf(
    await deps.fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: new Uint8Array(zip),
    }),
    "Netlify",
  );

  const url = [deployed.ssl_url, deployed.deploy_ssl_url, deployed.url].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
  );
  if (url === undefined) throw new DeployError("Netlify accepted the deploy but returned no URL");
  return url;
}

async function deployVercel(
  files: readonly DeployedFile[],
  name: string,
  token: string,
  deps: DeployDeps,
): Promise<string> {
  const inlineBytes = files.reduce((total, file) => total + file.data.length, 0);
  if (inlineBytes > 4_000_000) {
    throw new DeployError(
      "Vercel's create-deployment API accepts 4 MB of inline files; this site is larger. " +
        "Deploy it from CI with the Vercel CLI, or deploy to Netlify.",
    );
  }

  const deployed = await jsonOf(
    await deps.fetch("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        target: "production",
        files: files.map((file) => ({ file: file.path, data: file.data.toString("base64") })),
      }),
    }),
    "Vercel",
  );

  const raw = typeof deployed.url === "string" ? deployed.url : "";
  if (raw === "") throw new DeployError("Vercel accepted the deploy but returned no URL");
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

async function deployGitHubPages(
  files: readonly DeployedFile[],
  repo: string,
  token: string,
  message: string,
  deps: DeployDeps,
): Promise<string> {
  const ref = parseRepoSpec(repo);
  if (ref === null) throw new DeployError("repo must be owner/name of a GitHub repository");

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "genie-pages-"));
  try {
    for (const file of files) {
      const target = path.join(scratch, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.data);
    }

    const steps: { command: string; what: string }[] = [
      { command: "git init -q", what: "initialise the output repository" },
      { command: "git add -A", what: "stage the built files" },
      {
        command:
          `git -c user.name="Genie" -c user.email="genie@users.noreply.github.com" ` +
          `-c commit.gpgsign=false commit -q -m ${shq(message)}`,
        what: "commit the built files",
      },
    ];
    for (const step of steps) {
      const result = await deps.run({ command: step.command, cwd: scratch, timeoutMs: config.deployTimeoutMs });
      if (result.refused !== undefined) throw new DeployError(`could not ${step.what}: ${result.refused}`);
      if (!result.ok) throw new DeployError(`could not ${step.what}: ${redactToken(result.output.trim(), token)}`);
    }

    const url = `https://x-access-token:${token}@github.com/${repoSlug(ref)}.git`;
    const pushed = await deps.run({
      command: `git push -q --force ${shq(url)} HEAD:refs/heads/gh-pages`,
      cwd: scratch,
      timeoutMs: config.deployTimeoutMs,
    });
    if (pushed.refused !== undefined) throw new DeployError(`could not push gh-pages: ${pushed.refused}`);
    if (!pushed.ok) {
      throw new DeployError(`could not push gh-pages: ${redactToken(pushed.output.trim(), token)}`);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  return `https://${ref.owner}.github.io/${ref.name}/`;
}

/** Single-quote a value for a shell, so a message or a URL cannot be read as code. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build, collect, and hand the output to one host.
 *
 * The target is required rather than defaulted: this publishes a URL on the
 * public internet, and "whichever host happens to be configured" is not a choice
 * a person made. The caller's token wins over the deployment's, so a user who
 * holds their own credential can deploy to their own account without an operator
 * changing `NETLIFY_TOKEN` for everybody.
 */
export async function deploy(input: DeployInput, deps: DeployDeps = defaultDeps): Promise<DeployResult> {
  const target = normalizeTarget(input.target);
  if (target === null) {
    throw new DeployError(
      `target must be one of ${TARGET_IDS.join(", ")}` +
        (typeof input.target === "string" && input.target.trim() !== "" ? ` (got "${input.target}")` : ""),
    );
  }

  const dirRel = typeof input.dir === "string" && input.dir.trim() !== "" ? input.dir.trim() : ".";
  const dir = resolveInWorkspace(dirRel);
  if (!(await isDirectory(dir))) throw new DeployError(`${dirRel} is not a directory`);

  const name = siteNameFrom(dir, input.name);
  const token =
    typeof input.token === "string" && input.token.trim() !== ""
      ? input.token.trim()
      : target === "netlify"
        ? config.netlifyToken
        : target === "vercel"
          ? config.vercelToken
          : config.gitToken;
  if (token === "") {
    throw new DeployError(
      target === "netlify"
        ? "no Netlify token: set NETLIFY_TOKEN, or pass one with the request"
        : target === "vercel"
          ? "no Vercel token: set VERCEL_TOKEN, or pass one with the request"
          : "no GitHub token: set AGENT_GIT_TOKEN, or pass one with the request",
    );
  }

  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (target === "github-pages" && parseRepoSpec(repo) === null) {
    throw new DeployError("GitHub Pages needs repo=owner/name");
  }

  const { built, log } = await runBuild(dir, input.build, deps);
  const output = await resolveOutput(dir, input.output);
  const { files, bytes } = await collectFiles(output);

  const message =
    typeof input.message === "string" && input.message.trim() !== ""
      ? input.message.trim()
      : `Deploy ${name} from Genie`;

  const url =
    target === "netlify"
      ? await deployNetlify(files, name, token, deps)
      : target === "vercel"
        ? await deployVercel(files, name, token, deps)
        : await deployGitHubPages(files, repo, token, message, deps);

  return {
    target,
    url,
    files: files.length,
    bytes,
    built,
    buildLog: log,
    output: toRel(output),
  };
}
