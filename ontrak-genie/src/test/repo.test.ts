import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Repository-aware workspaces (v0.4).
 *
 * The roadmap asked for Gitea/Atlas as the *source* of a workspace: clone a
 * repository, work on a branch, open a pull request. These cases hold the parts
 * that make that safe rather than merely workable:
 *
 *   * a repository is named `owner/name` and a pasted URL's host is discarded, so a
 *     caller can never point the console at a host of their choosing;
 *   * a clone lands inside the account's working directory and nowhere else, and an
 *     existing non-empty directory is refused rather than clobbered;
 *   * the credential is supplied per command and is **never** written into the
 *     workspace — after a clone, `origin` is the plain URL;
 *   * a git error that echoes the token is redacted before it is returned.
 *
 * The host, token and workspace are read once, at import, so this file sets them
 * before it imports anything.
 */

const WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "genie-repo-"));
process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = path.join(WORKSPACE, ".agent");
process.env.AGENT_GIT_BASE_URL = "https://git.example.com";
process.env.AGENT_GIT_TOKEN = "s3cr3t-token";

const {
  apiBaseFor,
  authenticatedCloneUrl,
  branchNameFor,
  cloneUrlFor,
  isBranchName,
  parsePullRequest,
  parseRepoSpec,
  pullRequestApiUrl,
  pullRequestPayload,
  redactToken,
  repoSlug,
  slugify,
} = await import("../repo-rules.js");
const { cloneRepository, createBranch, detectRepoRef, gitConfigured, gitInfo, openPullRequest, pushBranch, RepoError } =
  await import("../repo.js");
type GitResult = import("../repo.js").GitResult;

/** A runner that records every command and answers from a handler. */
function fakeRunner(handler: (command: string) => Partial<GitResult> = () => ({})) {
  const calls: { command: string; cwd: string }[] = [];
  const run = async (command: string, cwd: string): Promise<GitResult> => {
    calls.push({ command, cwd });
    const answer = handler(command);
    return {
      ok: answer.ok ?? true,
      exitCode: answer.exitCode ?? 0,
      output: answer.output ?? "",
      ...(answer.refused === undefined ? {} : { refused: answer.refused }),
    };
  };
  return { run, calls };
}

/* -------------------------------------------------------------------------- */
/*  Pure rules                                                                */
/* -------------------------------------------------------------------------- */

test("a repository is named owner/name, and a pasted URL loses its host", () => {
  assert.deepEqual(parseRepoSpec("acme/widgets"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseRepoSpec("  acme/widgets.git  "), { owner: "acme", name: "widgets" });
  // A URL is reduced to the same form: the host in it is discarded, never dialled.
  assert.deepEqual(parseRepoSpec("https://evil.example/acme/widgets"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseRepoSpec("git@github.com:acme/widgets.git"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseRepoSpec("ssh://git@host/acme/widgets"), { owner: "acme", name: "widgets" });

  for (const bad of ["", "   ", "widgets", "a/b/c", "../etc", "acme/..", "acme/wid gets", "acme/../widgets", 42, null]) {
    assert.equal(parseRepoSpec(bad), null, `refused: ${String(bad)}`);
  }
  assert.equal(repoSlug({ owner: "acme", name: "widgets" }), "acme/widgets");
});

test("clone and API URLs are built from the configured base, not the caller", () => {
  const ref = { owner: "acme", name: "widgets" };
  assert.equal(cloneUrlFor("https://git.example.com/", ref), "https://git.example.com/acme/widgets.git");
  const auth = authenticatedCloneUrl("https://git.example.com", ref, "tok");
  assert.match(auth, /^https:\/\/oauth2:tok@git\.example\.com\/acme\/widgets\.git$/);
  assert.equal(authenticatedCloneUrl("https://git.example.com", ref, ""), "https://git.example.com/acme/widgets.git");
  assert.equal(apiBaseFor("https://git.example.com"), "https://git.example.com/api/v1");
  assert.equal(apiBaseFor("https://git.example.com/api/v1"), "https://git.example.com/api/v1");
  assert.equal(pullRequestApiUrl("https://git.example.com", ref), "https://git.example.com/api/v1/repos/acme/widgets/pulls");
});

test("a branch name is the console's, slugged, and bounded", () => {
  assert.equal(slugify("Fix the VPN!!"), "fix-the-vpn");
  assert.equal(branchNameFor("Fix the VPN", "a1b2"), "genie/fix-the-vpn-a1b2");
  // An empty title falls back to a readable one; a title that slugs to nothing
  // still yields a usable name.
  assert.equal(branchNameFor("", "a1b2"), "genie/agent-changes-a1b2");
  assert.equal(branchNameFor("!!!", ""), "genie/work");
  // Non-alphanumerics in the suffix are dropped, and the name never ends in a hyphen.
  assert.equal(branchNameFor("x", "a-1!"), "genie/x-a1");

  assert.equal(isBranchName("genie/fix-the-vpn"), true);
  assert.equal(isBranchName("main"), true);
  for (const bad of ["", "-leading", "bad..range", "has space", "a/../b", 12, null]) {
    assert.equal(isBranchName(bad), false, `refused: ${String(bad)}`);
  }
});

test("a pull-request payload carries only what it was given, and the response is read structurally", () => {
  assert.deepEqual(pullRequestPayload({ title: "Fix", head: "genie/x", base: "main" }), {
    title: "Fix",
    head: "genie/x",
    base: "main",
  });
  assert.deepEqual(pullRequestPayload({ title: "Fix", head: "genie/x", base: "main", body: "why" }), {
    title: "Fix",
    head: "genie/x",
    base: "main",
    body: "why",
  });
  assert.deepEqual(parsePullRequest({ number: 7, html_url: "https://git.example.com/pulls/7", state: "open" }), {
    number: 7,
    url: "https://git.example.com/pulls/7",
    state: "open",
  });
  assert.deepEqual(parsePullRequest(null), { number: null, url: null, state: null });
  assert.deepEqual(parsePullRequest({ number: "7" }), { number: null, url: null, state: null });
});

test("a token is redacted out of anything returned to a caller", () => {
  assert.equal(redactToken("fatal: https://oauth2:s3cr3t-token@host/x.git denied", "s3cr3t-token"), "fatal: https://oauth2:***@host/x.git denied");
  assert.equal(redactToken("no secret here", "s3cr3t-token"), "no secret here");
  assert.equal(redactToken("anything", ""), "anything");
});

/* -------------------------------------------------------------------------- */
/*  Operations, against fakes                                                 */
/* -------------------------------------------------------------------------- */

test("the git host is configured from the environment", () => {
  assert.equal(gitConfigured(), true);
  assert.deepEqual(gitInfo(), { base: "https://git.example.com", token: true, defaultBranch: "main" });
});

test("clone lands in the workspace and rewrites origin to the plain URL", async () => {
  const { run, calls } = fakeRunner();
  const result = await cloneRepository({ spec: "acme/widgets" }, run);

  assert.equal(result.repo, "acme/widgets");
  assert.equal(result.rel, "widgets");
  assert.equal(result.branch, null);
  // The clone carried the credential...
  assert.match(calls[0]?.command ?? "", /git clone 'https:\/\/oauth2:s3cr3t-token@git\.example\.com\/acme\/widgets\.git'/);
  // ...and the remote was rewritten so the workspace holds no token.
  const setUrl = calls.find((call) => call.command.startsWith("git remote set-url origin"));
  assert.match(setUrl?.command ?? "", /'https:\/\/git\.example\.com\/acme\/widgets\.git'/);
  assert.doesNotMatch(setUrl?.command ?? "", /s3cr3t-token/);
  // The clone ran inside the account's working directory.
  assert.equal(calls[0]?.cwd, WORKSPACE);
});

test("a clone into a path outside the workspace is refused before git runs", async () => {
  const { run, calls } = fakeRunner();
  await assert.rejects(() => cloneRepository({ spec: "acme/widgets", dir: "../escape" }, run), RepoError);
  assert.equal(calls.length, 0, "git was never asked to write anything");
});

test("a clone onto an existing non-empty directory is refused", async () => {
  await fs.mkdir(path.join(WORKSPACE, "taken"), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE, "taken", "file.txt"), "keep me\n");
  const { run } = fakeRunner();
  await assert.rejects(() => cloneRepository({ spec: "acme/widgets", dir: "taken" }, run), /already something/);
  assert.equal(await fs.readFile(path.join(WORKSPACE, "taken", "file.txt"), "utf8"), "keep me\n");
});

test("a clone with a named branch checks it out, and refuses a bad name", async () => {
  const { run, calls } = fakeRunner();
  const result = await cloneRepository({ spec: "acme/widgets", dir: "withbranch", branch: "develop" }, run);
  assert.equal(result.branch, "develop");
  assert.ok(calls.some((call) => call.command === "git checkout 'develop'"));

  const { run: run2 } = fakeRunner();
  await assert.rejects(
    () => cloneRepository({ spec: "acme/widgets", dir: "badbranch", branch: "bad..range" }, run2),
    /valid branch/,
  );
});

test("a failed clone reports the failure with the token redacted", async () => {
  const { run } = fakeRunner((command) =>
    command.startsWith("git clone")
      ? { ok: false, exitCode: 128, output: "fatal: could not read from https://oauth2:s3cr3t-token@git.example.com" }
      : {},
  );
  await assert.rejects(
    () => cloneRepository({ spec: "acme/widgets", dir: "private" }, run),
    (error: unknown) => {
      assert.ok(error instanceof RepoError);
      assert.match(error.message, /\*\*\*/);
      assert.doesNotMatch(error.message, /s3cr3t-token/);
      return true;
    },
  );
});

test("a branch is derived from a title, or taken as given and validated", async () => {
  const { run, calls } = fakeRunner();
  const derived = await createBranch({ title: "Add the thing", suffix: "abcd" }, run);
  assert.equal(derived.branch, "genie/add-the-thing-abcd");
  assert.ok(calls.some((call) => call.command === "git checkout -b 'genie/add-the-thing-abcd'"));

  const explicit = await createBranch({ name: "feature/manual" }, run);
  assert.equal(explicit.branch, "feature/manual");

  await assert.rejects(() => createBranch({ name: "bad name" }, run), /valid branch/);
});

test("a push reads the repository from origin and supplies the credential inline", async () => {
  const { run, calls } = fakeRunner((command) =>
    command.startsWith("git remote get-url")
      ? { output: "https://git.example.com/acme/widgets.git\n" }
      : {},
  );
  const result = await pushBranch({ branch: "genie/work" }, run);
  assert.equal(result.repo, "acme/widgets");
  assert.equal(result.branch, "genie/work");
  const push = calls.find((call) => call.command.startsWith("git push"));
  assert.match(push?.command ?? "", /git push 'https:\/\/oauth2:s3cr3t-token@git\.example\.com\/acme\/widgets\.git' 'genie\/work'/);
});

test("a push in a directory that is not a clone is refused", async () => {
  const { run } = fakeRunner((command) =>
    command.startsWith("git remote get-url") ? { ok: false, output: "fatal: not a git repository" } : {},
  );
  await assert.rejects(() => pushBranch({ branch: "main" }, run), /not a clone/);
});

test("a pull request is opened against the API with the token and the branch", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFake = (async (url: string | URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 12, html_url: "https://git.example.com/acme/widgets/pulls/12", state: "open" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const { run } = fakeRunner();
  const pr = await openPullRequest(
    { spec: "acme/widgets", title: "Fix the thing", head: "genie/fix", body: "why" },
    run,
    fetchFake,
  );

  assert.equal(pr.number, 12);
  assert.equal(pr.state, "open");
  assert.equal(pr.base, "main", "the configured default base");
  assert.equal(seen[0]?.url, "https://git.example.com/api/v1/repos/acme/widgets/pulls");
  assert.equal((seen[0]?.init.headers as Record<string, string>).Authorization, "token s3cr3t-token");
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
    title: "Fix the thing",
    head: "genie/fix",
    base: "main",
    body: "why",
  });
});

test("a refused pull request surfaces the API's answer", async () => {
  const fetchFake = (async () =>
    ({
      ok: false,
      status: 422,
      text: async () => "branch not found",
    }) as unknown as Response) as unknown as typeof fetch;
  const { run } = fakeRunner();
  await assert.rejects(
    () => openPullRequest({ spec: "acme/widgets", title: "x", head: "genie/x" }, run, fetchFake),
    /HTTP 422.*branch not found/,
  );
});

test("the working directory's repository is read back from origin", async () => {
  const { run } = fakeRunner((command) =>
    command.startsWith("git remote get-url") ? { output: "https://git.example.com/acme/widgets.git\n" } : {},
  );
  assert.deepEqual(await detectRepoRef(run), { owner: "acme", name: "widgets" });

  const { run: bare } = fakeRunner(() => ({ ok: false, output: "fatal: no remote" }));
  assert.equal(await detectRepoRef(bare), null);
});
