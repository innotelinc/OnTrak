import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Saving a project to a *new* repository.
 *
 * The direction every other repository test does not cover: the work is on this
 * disk and nowhere else, so "save it there" means create, commit, push — and then
 * keep working in the same directory. What is pinned here is the sequence and the
 * two fences: the credential travels in exactly one command (never into
 * `.git/config`), and a directory outside the sandbox is refused before git is
 * asked anything.
 *
 * The forge is a local stub standing in for Atlas's Gitea; GitHub is a fake
 * `fetch`, because the real one is somebody else's server and a test should never
 * reach it. The git port is a fake too, so the *commands* can be asserted rather
 * than the effects of a repository that happens to exist in CI.
 */

const WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "genie-publish-"));
const ATLAS_PASSWORD = "atlas-system-password";

const seen: { name: string; body: Record<string, unknown> }[] = [];

const forge = http.createServer((req, res) => {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const authed =
    (req.headers.authorization ?? "") === `Basic ${Buffer.from(`root:${ATLAS_PASSWORD}`).toString("base64")}`;

  if (req.url === "/api/v1/user/repos" && req.method === "POST") {
    if (!authed) return send(401, { message: "unauthorized" });
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const payload = JSON.parse(raw) as { name: string };
      seen.push({ name: payload.name, body: payload });
      if (payload.name === "taken") return send(422, { message: "repository already exists" });
      send(201, {
        full_name: `root/${payload.name}`,
        html_url: `http://atlas.test/root/${payload.name}`,
        default_branch: "main",
      });
    });
    return;
  }
  if (req.url === "/api/v1/user" && req.method === "GET") {
    if (!authed) return send(401, { message: "unauthorized" });
    return send(200, { login: "root" });
  }
  send(404, { message: "not found" });
});
await new Promise<void>((resolve) => forge.listen(0, "127.0.0.1", resolve));
const forgeBase = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;

process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = path.join(WORKSPACE, ".agent");
process.env.AGENT_ATLAS_URL = forgeBase;
process.env.AGENT_ATLAS_USER = "root";
process.env.AGENT_ATLAS_PASSWORD = ATLAS_PASSWORD;
process.env.MAGNATE_ENTITLEMENTS_URL = "";
process.env.ENTITLEMENTS_API_TOKEN = "";

const remote = await import("../remote.js");
const { connectForge, listForgeClones, publishProject, publishToForge, publishToGitHub, RemoteError, resetRemotes } =
  remote;
type RemoteDeps = import("../remote.js").RemoteDeps;
type RemoteInvocation = import("../remote.js").RemoteInvocation;
type RemoteResult = import("../remote.js").RemoteResult;

const GITHUB_TOKEN = "ghp_abcdefghijklmnop";

/** The git port: the commands are what get asserted, not a real repository. */
function gitFake(options: { repoExists?: boolean; commitOutput?: string } = {}) {
  const calls: string[] = [];
  const run = async (invocation: RemoteInvocation): Promise<RemoteResult> => {
    const command = invocation.command;
    calls.push(command);
    if (command === "git rev-parse --git-dir") {
      return { ok: options.repoExists === true, exitCode: options.repoExists === true ? 0 : 128, output: "" };
    }
    if (command === "git rev-parse --verify HEAD") return { ok: false, exitCode: 128, output: "" };
    if (command.startsWith("git -c user.name=")) {
      return options.commitOutput === undefined
        ? { ok: true, exitCode: 0, output: "[main (root-commit) abc1234] Initial commit\n" }
        : { ok: false, exitCode: 1, output: options.commitOutput };
    }
    if (command === "git rev-parse --short HEAD") return { ok: true, exitCode: 0, output: "abc1234\n" };
    if (command === "git ls-files") return { ok: true, exitCode: 0, output: "index.js\n.gitignore\n" };
    if (command === "git remote get-url origin") return { ok: false, exitCode: 2, output: "" };
    return { ok: true, exitCode: 0, output: "" };
  };
  return { run, calls };
}

/** A GitHub that answers from a script rather than from the internet. */
function githubFake(script: { status: number; body: unknown }[]) {
  const requests: { url: string; method: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    const next = script.shift() ?? { status: 500, body: { message: "unscripted" } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, requests };
}

function depsWith(git: { run: (invocation: RemoteInvocation) => Promise<RemoteResult> }, fetchImpl: typeof fetch): RemoteDeps {
  return { run: git.run, mounted: async () => true, fetchImpl };
}

/** A project on disk, with the dependencies an install would have left behind. */
async function projectWith(name: string, options: { installed?: boolean } = {}): Promise<string> {
  const dir = path.join(WORKSPACE, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.js"), "console.log(1);\n", "utf8");
  if (options.installed === true) {
    await fs.mkdir(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
  }
  return dir;
}

test("a project is pushed to a new GitHub repository, with the token in one command only", async () => {
  resetRemotes();
  const dir = await projectWith("widgets", { installed: true });
  const git = gitFake();
  const github = githubFake([
    { status: 201, body: { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets", default_branch: "main" } },
  ]);

  const published = await publishToGitHub(
    { name: "widgets", dir: "widgets", token: GITHUB_TOKEN, description: "uploaded as a zip" },
    depsWith(git, github.fetchImpl),
  );

  assert.equal(published.target, "github");
  assert.equal(published.repo, "acme/widgets");
  assert.equal(published.url, "https://github.com/acme/widgets");
  assert.equal(published.branch, "main");
  assert.equal(published.commit, "abc1234");
  assert.equal(published.files, 2);
  assert.equal(published.existing, false);

  // The repository is created empty: a README would already be a commit, and the
  // project's first push would then be refused for having diverged.
  assert.equal(github.requests[0]?.url, "https://api.github.com/user/repos");
  assert.deepEqual(JSON.parse(github.requests[0]?.body ?? "{}"), {
    name: "widgets",
    private: true,
    auto_init: false,
    description: "uploaded as a zip",
  });

  // The order: start the repository, name the branch, stage, commit with an
  // identity of our own, point origin at the *plain* URL, then push once.
  // Every value that reaches a command is shell-quoted, including the branch name
  // the deployment configures.
  assert.equal(git.calls.includes("git init -b 'main'"), true);
  assert.equal(git.calls.includes("git branch -M 'main'"), true);
  assert.equal(git.calls.includes("git add -A"), true);
  assert.equal(
    git.calls.some((command) => command.startsWith("git -c user.name=") && command.includes("commit -m")),
    true,
    "the commit carries its own identity",
  );
  assert.equal(git.calls.includes("git remote add origin 'https://github.com/acme/widgets.git'"), true);
  // The order is not decoration: `origin` cannot be added before the commit has
  // made a repository to add it to. The fakes above would happily agree with the
  // wrong order, so the order is asserted rather than assumed.
  const initAt = git.calls.indexOf("git init -b 'main'");
  const commitAt = git.calls.findIndex((command) => command.startsWith("git -c user.name="));
  const originAt = git.calls.indexOf("git remote add origin 'https://github.com/acme/widgets.git'");
  const pushAt = git.calls.findIndex((command) => command.startsWith("git push "));
  assert.equal(initAt < commitAt && commitAt < originAt && originAt < pushAt, true, git.calls.join(" | "));

  const push = git.calls.find((command) => command.startsWith("git push "));
  assert.equal(push !== undefined, true);
  assert.equal(push?.includes(GITHUB_TOKEN), true, "the credential travels with the one command that needs it");
  assert.equal(push?.includes("main:refs/heads/main"), true);
  assert.equal(push?.includes(`${GITHUB_TOKEN}@`) && push?.includes("x-access-token"), true);
  // …and nowhere else: `origin` is the plain URL.
  assert.equal(
    git.calls.some((command) => command.startsWith("git remote add") && command.includes(GITHUB_TOKEN)),
    false,
  );

  // The dependencies an install left behind are kept out of the commit, and the
  // file that does it is reported.
  assert.equal(published.ignoreFile, true);
  const ignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
  assert.equal(ignore.includes("node_modules/"), true);
  assert.equal(ignore.includes(".venv/"), false, "nothing is ignored that is not there");
  assert.equal(ignore.startsWith("#"), true);
});

test("the token comes from the caller, and a session that has none is told so", async () => {
  resetRemotes();
  await projectWith("no-token");
  const git = gitFake();
  const github = githubFake([]);

  await assert.rejects(
    () => publishToGitHub({ name: "no-token", dir: "no-token" }, depsWith(git, github.fetchImpl)),
    (error: unknown) => error instanceof RemoteError && /GitHub token is required/.test(error.message),
  );
  assert.equal(github.requests.length, 0, "nothing is dialled without a credential");
  assert.equal(git.calls.length, 0, "and no repository is started either");
});

test("a repository that already exists is pushed into rather than refused", async () => {
  resetRemotes();
  await projectWith("existing");
  const git = gitFake();
  const github = githubFake([
    { status: 422, body: { message: "Repository creation failed.", errors: [{ message: "name already exists" }] } },
    { status: 200, body: { login: "acme" } },
  ]);

  const published = await publishToGitHub(
    { name: "existing", dir: "existing", token: GITHUB_TOKEN },
    depsWith(git, github.fetchImpl),
  );
  assert.equal(published.existing, true);
  assert.equal(published.repo, "acme/existing");
  assert.equal(github.requests[1]?.url, "https://api.github.com/user");
  assert.equal(git.calls.some((command) => command.startsWith("git push ")), true);
});

test("an upload with no files says there is nothing to publish", async () => {
  resetRemotes();
  await projectWith("empty");
  const git = gitFake({ commitOutput: "nothing to commit, working tree clean\n" });
  const github = githubFake([{ status: 201, body: { full_name: "acme/empty", html_url: "https://github.com/acme/empty" } }]);

  await assert.rejects(
    () => publishToGitHub({ name: "empty", dir: "empty", token: GITHUB_TOKEN }, depsWith(git, github.fetchImpl)),
    /nothing to publish/,
  );
});

test("a project is saved to Atlas with the deployment's own credential", async () => {
  resetRemotes();
  seen.length = 0;
  await projectWith("atlas-app", { installed: true });
  const git = gitFake();

  // The system path: the deployment's Atlas credential, with no billing behind it.
  await connectForge({ useSystem: true }, depsWith(git, fetch));
  const published = await publishToForge(
    { name: "atlas-app", dir: "atlas-app", description: "an uploaded project" },
    depsWith(git, fetch),
  );

  assert.equal(published.target, "forge");
  assert.equal(published.repo, "root/atlas-app");
  // The forge's own answer for where the repository lives wins over one we build.
  assert.equal(published.url, "http://atlas.test/root/atlas-app");
  assert.equal(seen[0]?.name, "atlas-app");
  assert.deepEqual(seen[0]?.body, {
    name: "atlas-app",
    private: true,
    auto_init: false,
    default_branch: "main",
    description: "an uploaded project",
  });

  assert.equal(git.calls.includes(`git remote add origin '${forgeBase}/root/atlas-app.git'`), true);
  const push = git.calls.find((command) => command.startsWith("git push "));
  assert.equal(push?.includes(`root:${ATLAS_PASSWORD}@`), true);

  // The session now holds the clone, which is what "and carry on working" means:
  // a push and a pull request from here need nothing further.
  assert.deepEqual(
    listForgeClones().map((clone) => clone.repo),
    ["root/atlas-app"],
  );
});

test("Atlas works with no connection first, when the deployment holds a credential", async () => {
  resetRemotes();
  seen.length = 0;
  await projectWith("unattended", { installed: true });
  const git = gitFake();

  // No `connectForge`: the deployment's own Atlas credential is the system path.
  const published = await publishToForge({ name: "unattended", dir: "unattended" }, depsWith(git, fetch));
  assert.equal(published.repo, "root/unattended");
  assert.equal(seen.length, 1);

  // …and it is remembered, so the push that comes next finds it rather than
  // asking the person to sign in to something they never named.
  assert.deepEqual(
    listForgeClones().map((clone) => clone.repo),
    ["root/unattended"],
  );
});

test("a forge that already has the name is pushed into", async () => {
  resetRemotes();
  await projectWith("taken");
  const git = gitFake();
  await connectForge({ useSystem: true }, depsWith(git, fetch));

  const published = await publishToForge({ name: "taken", dir: "taken" }, depsWith(git, fetch));
  assert.equal(published.existing, true);
  assert.equal(published.repo, "root/taken");
  assert.equal(git.calls.some((command) => command.startsWith("git push ")), true);
});

test("a directory outside the sandbox is refused before anything runs", async () => {
  resetRemotes();
  const git = gitFake();
  const github = githubFake([{ status: 201, body: { full_name: "acme/x" } }]);

  for (const dir of ["../escape", "/etc", "nested/../../out"]) {
    await assert.rejects(
      () => publishToGitHub({ name: "x", dir, token: GITHUB_TOKEN }, depsWith(git, github.fetchImpl)),
      (error: unknown) => error instanceof RemoteError && /outside the workspace/.test(error.message),
      `refused: ${dir}`,
    );
  }
  assert.equal(git.calls.length, 0);
  assert.equal(github.requests.length, 0);
});

test("a target has to be named, and only the two that exist", async () => {
  resetRemotes();
  await assert.rejects(() => publishProject({ target: "gitlab" }), /"github" or "atlas"/);
  await assert.rejects(() => publishProject({}), /"github" or "atlas"/);
});

// The stub forge is a real listener, so it has to be closed or the test run never
// ends: the same reason `remote-forge.test.ts` does this.
test.after(async () => {
  await new Promise<void>((resolve) => forge.close(() => resolve()));
});

test("a project with no installed dependencies gets no .gitignore written for it", async () => {
  resetRemotes();
  const dir = await projectWith("clean");
  const git = gitFake();
  const github = githubFake([{ status: 201, body: { full_name: "acme/clean", html_url: "https://github.com/acme/clean" } }]);

  const published = await publishToGitHub({ name: "clean", dir: "clean", token: GITHUB_TOKEN }, depsWith(git, github.fetchImpl));
  assert.equal(published.ignoreFile, false);
  await assert.rejects(() => fs.stat(path.join(dir, ".gitignore")), "their project is left as it was");
});
