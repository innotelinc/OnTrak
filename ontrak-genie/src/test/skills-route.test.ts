import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * Installing and removing a skill from the console.
 *
 * The read-only list has its own tests (`skills.test.ts`); what is new here is a
 * route that *writes*, and the interesting cases are the ones where a quiet
 * mistake costs something:
 *
 *   * an install lands in the caller's own slice and nowhere else;
 *   * a name from the web is a name, never a path;
 *   * removal refuses a directory this installer did not write — the one
 *     unrecoverable mistake a remove could make — and refuses anything outside
 *     the caller's own slice even when it *was* installed;
 *   * a repository that holds several skills says which, rather than installing
 *     the alphabetically first one.
 *
 * GitHub is faked by replacing `globalThis.fetch`, which is what the installer
 * calls when it is not handed a fetcher explicitly. The faked one hands every
 * request that is not a GitHub URL to the real `fetch`, so the test's own calls to
 * the console still work.
 *
 * Env is set before any module reads the config, exactly as `projects.test.ts`
 * does, so the account's skills land in a scratch directory.
 */

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "skills-route-"));
const workspace = path.join(scratch, "workspace");
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.AGENT_SANDBOX = "host";
process.env.WEB_TOKEN = "skills-route-token";
// No control plane, so this caller is the deployment itself and its slice is the
// shared one — the same directory a single-operator estate uses.
process.env.CONTROL_INTERNAL_TOKEN = "";
// Anonymous installs on purpose: the point is what the route does with the
// repository it was given, not which credential it had.
process.env.GITHUB_TOKEN = "";
process.env.AGENT_GIT_TOKEN = "";

const { createServer } = await import("../server.js");
const { ensureWorkspace } = await import("../workspace.js");
const { accountSkillsDir } = await import("../skill-roots.js");

await ensureWorkspace();

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(scratch, { recursive: true, force: true });
});

const ACCOUNT = accountSkillsDir();

/* ----------------------------------------------------------- fake GitHub --- */

const SKILL_MD = [
  "---",
  "name: hello-skill",
  "description: The house way to say hello, written down once.",
  "---",
  "",
  "# Hello",
  "",
  "Say hello, then stop.",
  "",
].join("\n");

const OTHER_MD = "---\nname: goodbye\ndescription: How to say goodbye.\n---\n\nWave.\n";

/** The repository's file list, as GitHub's tree endpoint answers it. */
const TREE = {
  tree: [
    { path: "README.md", type: "blob" },
    { path: "hello/SKILL.md", type: "blob" },
    { path: "hello/reference/notes.md", type: "blob" },
    { path: "goodbye/SKILL.md", type: "blob" },
  ],
};

const RAW: Record<string, string> = {
  "hello/SKILL.md": SKILL_MD,
  "hello/reference/notes.md": "more detail\n",
  "goodbye/SKILL.md": OTHER_MD,
};

const realFetch = globalThis.fetch;
let githubCalls = 0;

// `Parameters<typeof fetch>[0]` rather than the DOM global `RequestInfo`: this file
// is compiled in the image as well, where the type environment is whatever
// `@types/node` the install resolved, and a global that is not guaranteed there
// stops the *image* building rather than failing a test.
type FetchInput = Parameters<typeof fetch>[0];

globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.github.com/") && !url.startsWith("https://raw.githubusercontent.com/")) {
    return realFetch(input as FetchInput, init);
  }
  githubCalls += 1;

  if (url === "https://api.github.com/repos/acme/skill-repo") {
    return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
  }
  if (url.startsWith("https://api.github.com/repos/acme/skill-repo/git/trees/")) {
    return new Response(JSON.stringify(TREE), { status: 200 });
  }
  if (url.startsWith("https://raw.githubusercontent.com/acme/skill-repo/main/")) {
    const file = url.slice("https://raw.githubusercontent.com/acme/skill-repo/main/".length);
    const body = RAW[file];
    return body === undefined
      ? new Response("nope", { status: 404 })
      : new Response(body, { status: 200 });
  }
  // Anything else on GitHub: no such repository.
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
}) as typeof fetch;

/* -------------------------------------------------------------- helpers ---- */

const auth = { Authorization: "Bearer skills-route-token", "Content-Type": "application/json" };

interface SkillRow {
  name: string;
  description: string;
  dir: string | null;
  files: number;
  installed: boolean;
  removable: boolean;
  provenance?: { repo: string; ref: string; path: string };
}

async function listSkills(): Promise<SkillRow[]> {
  const response = await fetch(`${base}/api/skills`, { headers: auth });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { skills: SkillRow[]; account: string };
  assert.equal(body.account, ACCOUNT, "the route has to say which slice installs land in");
  return body.skills;
}

const exists = (target: string): Promise<boolean> =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

async function install(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/skills`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

/* --------------------------------------------------------------- checks ---- */

test("a repository that is not owner/repo is refused before anything is dialled", async () => {
  const before = githubCalls;
  const refused = await install({ repo: "https://gitlab.com/acme/skill-repo" });
  assert.equal(refused.status, 400);
  assert.match(String(refused.payload.error), /owner\/repo/);
  assert.equal(githubCalls, before, "a refused name has to cost no request");

  for (const repo of ["", "acme", "../..", 42, "acme/skill-repo/extra"]) {
    const answer = await install({ repo });
    assert.equal(answer.status, 400, `${JSON.stringify(repo)} should be refused`);
  }
});

test("a repository holding several skills says which, and installs the one named", async () => {
  const ambiguous = await install({ repo: "acme/skill-repo" });
  assert.equal(ambiguous.status, 400);
  assert.match(String(ambiguous.payload.error), /several skills/);
  assert.match(String(ambiguous.payload.error), /--path/);
  assert.equal(await exists(path.join(ACCOUNT, "hello")), false, "a refused install writes nothing");

  const installed = await install({ repo: "acme/skill-repo", path: "hello" });
  assert.equal(installed.status, 201);
  const skill = installed.payload.installed as { name: string; files: number; repo: string; ref: string };
  // The directory is named for what was chosen, the *skill* for what its own front
  // matter says — `hello-skill` here. Both matter: the first is where it lives, the
  // second is what the model is offered and what a caller names to remove it.
  assert.equal(skill.name, "hello-skill");
  assert.equal(await exists(path.join(ACCOUNT, "hello")), true);
  assert.equal(skill.files, 2, "the playbook and the file beside it");
  assert.equal(skill.repo, "acme/skill-repo");
  assert.equal(skill.ref, "main");

  // On disk where the loader will find it, as a directory with provenance.
  assert.equal(await exists(path.join(ACCOUNT, "hello", "SKILL.md")), true);
  assert.equal(await exists(path.join(ACCOUNT, "hello", "reference", "notes.md")), true);
  const provenance = JSON.parse(
    await fs.readFile(path.join(ACCOUNT, "hello", ".source.json"), "utf8"),
  ) as { repo: string; files: number };
  assert.equal(provenance.repo, "acme/skill-repo");
  assert.equal(provenance.files, 2);
});

test("the list reports the install as installed, and as this caller's to remove", async () => {
  const skills = await listSkills();
  const hello = skills.find((entry) => entry.name === "hello-skill");
  assert.ok(hello !== undefined, "the installed skill has to be listed");
  assert.equal(hello.installed, true);
  assert.equal(hello.removable, true);
  assert.equal(hello.dir, path.join(ACCOUNT, "hello"));
  assert.equal(hello.provenance?.repo, "acme/skill-repo");
  assert.match(hello.description, /house way to say hello/);
});

test("a hand-written directory is not this installer's to remove", async () => {
  const byHand = path.join(ACCOUNT, "by-hand");
  await fs.mkdir(byHand, { recursive: true });
  await fs.writeFile(path.join(byHand, "SKILL.md"), "---\nname: by-hand\n---\n\nMine.\n");

  const skills = await listSkills();
  const row = skills.find((entry) => entry.name === "by-hand");
  assert.ok(row !== undefined);
  assert.equal(row.removable, false, "no provenance means no remove button");

  const refused = await fetch(`${base}/api/skills/by-hand`, { method: "DELETE", headers: auth });
  assert.equal(refused.status, 400);
  assert.match(String(((await refused.json()) as { error: string }).error), /\.source\.json/);
  assert.equal(await exists(path.join(byHand, "SKILL.md")), true, "and the directory survives");
});

test("a deployment's own skill cannot be removed from the console", async () => {
  // Not installed by the route, and not in the caller's slice either: the account
  // directory has no such skill, so this is a refusal rather than a delete.
  const deployment = path.join(process.env.AGENT_DATA_DIR as string, "skills");
  const theirs = path.join(deployment, "operator-skill");
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(theirs, "SKILL.md"), "---\nname: operator-skill\n---\n\nTheirs.\n");
  await fs.writeFile(path.join(theirs, ".source.json"), JSON.stringify({ repo: "acme/skill-repo" }));

  const refused = await fetch(`${base}/api/skills/operator-skill`, { method: "DELETE", headers: auth });
  assert.equal(refused.status, 400);
  assert.equal(await exists(path.join(theirs, "SKILL.md")), true, "the deployment keeps its skill");
});

test("a name is a name, never a path", async () => {
  const outside = path.join(scratch, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "keep.txt"), "keep\n");

  // Encoded, so the name arrives as written rather than being normalised away
  // before it is routed — the shape a traversal would use, and the one that proves
  // the slugging rather than the URL parser is what keeps it a name.
  for (const name of ["%2E%2E%2F%2E%2E%2Foutside", "%2Fetc%2Fpasswd", "%20%20", "...."] ) {
    const response = await fetch(`${base}/api/skills/${name}`, { method: "DELETE", headers: auth });
    assert.equal(response.status, 400, `${name} should be refused`);
  }
  // A dot-segment never reaches the route at all: the URL parser collapses it, so
  // the answer is "no such route". Either way it is a refusal rather than a delete,
  // and the point of both cases is the same: nothing outside was touched.
  for (const path_ of ["..", "%2E%2E"]) {
    const response = await fetch(`${base}/api/skills/${path_}`, { method: "DELETE", headers: auth });
    assert.equal(response.status, 404, path_);
  }
  assert.equal(await exists(path.join(outside, "keep.txt")), true, "nothing outside was touched");
});

test("removing a skill this route installed removes exactly that directory", async () => {
  const removed = await fetch(`${base}/api/skills/hello`, { method: "DELETE", headers: auth });
  assert.equal(removed.status, 200);
  const body = (await removed.json()) as { removed: boolean; name: string; files: number };
  assert.equal(body.removed, true);
  assert.equal(body.name, "hello");
  assert.equal(body.files, 3, "the playbook, the reference file and the provenance");

  assert.equal(await exists(path.join(ACCOUNT, "hello")), false);
  const skills = await listSkills();
  assert.equal(skills.some((entry) => entry.name === "hello-skill"), false);
  assert.equal(skills.some((entry) => entry.name === "by-hand"), true, "and only that one went");

  // Removing it twice is a refusal, not a crash.
  const again = await fetch(`${base}/api/skills/hello`, { method: "DELETE", headers: auth });
  assert.equal(again.status, 400);
});
