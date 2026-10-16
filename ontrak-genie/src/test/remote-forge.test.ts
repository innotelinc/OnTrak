import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A forge the caller names — Gitea, which is what Atlas runs — and Atlas itself as
 * an add-on.
 *
 * These cases hold the parts that make the Atlas path what it claims to be:
 *
 *   * the address is validated rather than obeyed, so a `file:` or `ssh:` URL is
 *     refused and a credential cannot be smuggled inside one;
 *   * **the forge verifies the credential**, and the login it answers with is the
 *     one remembered — a clone URL carries a user name the server agreed to, not
 *     one somebody typed;
 *   * the deployment's own credential is the system path: it works with no billing
 *     configured at all, which is what makes Atlas usable on this estate;
 *   * a subscriber's plan is asked *before* the forge, so a refusal reads as an
 *     add-on rather than as a wrong password;
 *   * a clone rewrites `origin` to the plain URL, so `.git/config` holds no
 *     credential — and a push uses the one the session is holding.
 *
 * The settings are read once, at import, so this file sets them before it imports
 * anything: a local stub stands in for the forge, so nothing here reaches a real
 * Atlas.
 */

const WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "genie-forge-"));
const DATA = path.join(WORKSPACE, ".agent");

const ATLAS_PASSWORD = "atlas-system-password";

// A stub forge, standing in for Atlas's Gitea. Its URL is the deployment's
// `AGENT_ATLAS_URL`, so the *Atlas* path is exercised rather than a generic one.
const forge = http.createServer((req, res) => {
  const send = (status: number, body: unknown): void => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  };
  const authorization = req.headers.authorization ?? "";
  const authed = authorization === `Basic ${Buffer.from(`root:${ATLAS_PASSWORD}`).toString("base64")}`;

  if (req.url?.startsWith("/api/v1/user/repos") && req.method === "POST") {
    if (!authed) return send(401, "unauthorized");
    return send(201, {
      full_name: "root/created-on-atlas",
      html_url: "http://atlas.test/root/created-on-atlas",
      default_branch: "main",
    });
  }
  if (req.url?.startsWith("/api/v1/user") && req.method === "GET") {
    if (!authed) return send(401, "unauthorized");
    return send(200, { login: "root" });
  }
  send(404, "not found");
});
await new Promise<void>((resolve) => forge.listen(0, "127.0.0.1", resolve));
const forgeBase = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;

process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = DATA;
process.env.AGENT_ATLAS_URL = forgeBase;
process.env.AGENT_ATLAS_SSH_HOST = "192.168.1.90";
process.env.AGENT_ATLAS_USER = "root";
process.env.AGENT_ATLAS_PASSWORD = ATLAS_PASSWORD;
// Deliberately no Magnate: this is the system path, and it must work with no
// billing platform anywhere near it.
process.env.MAGNATE_ENTITLEMENTS_URL = "";
process.env.ENTITLEMENTS_API_TOKEN = "";

const {
  forgeApiUrl,
  forgeAuthHeader,
  forgeAuthenticatedUrl,
  forgeCloneUrl,
  forgeRepoPayload,
  forgeTokenHeader,
  forgeWebUrl,
  isForgeSecret,
  isForgeUser,
  normalizeRepoName,
  parseForgeRepo,
  parseForgeUser,
  parseGitHostUrl,
} = await import("../remote-rules.js");

const remote = await import("../remote.js");
const { cloneForge, connectForge, createForgeRepo, disconnectForge, listForgeClones, openForgePullRequest, pushForge, RemoteError } =
  remote;
type RemoteDeps = import("../remote.js").RemoteDeps;
type RemoteInvocation = import("../remote.js").RemoteInvocation;
type RemoteResult = import("../remote.js").RemoteResult;

const { atlasConfigured, atlasInfo, atlasVerdict } = await import("../atlas.js");
const { setSelectedWorkspace, selectedWorkspace } = await import("../scope.js");

/** A pair of fakes: the shell runner and the forge's HTTP surface. */
function fakeDeps(
  handlers: {
    run?: (invocation: RemoteInvocation) => Partial<RemoteResult>;
    fetchImpl?: typeof fetch;
    mounted?: () => boolean;
  } = {},
) {
  const calls: RemoteInvocation[] = [];
  const run = async (invocation: RemoteInvocation): Promise<RemoteResult> => {
    calls.push(invocation);
    const answer = handlers.run?.(invocation) ?? {};
    return {
      ok: answer.ok ?? true,
      exitCode: answer.exitCode ?? 0,
      output: answer.output ?? "",
      ...(answer.refused === undefined ? {} : { refused: answer.refused }),
    };
  };
  const viaStub: typeof fetch = async (input, init) => {
    // Straight to the stub, so a test that does not care about the answer still
    // talks to a real HTTP surface rather than to a second fake.
    const url = typeof input === "string" && input.startsWith("/") ? `${forgeBase}${input}` : input;
    return await fetch(url, init);
  };
  const deps: RemoteDeps = {
    run,
    mounted: async () => handlers.mounted?.() ?? true,
    fetchImpl: handlers.fetchImpl ?? viaStub,
  };
  return { deps, calls };
}

async function resetWorkdir(): Promise<void> {
  remote.resetRemotes();
  if (selectedWorkspace() !== "") await setSelectedWorkspace("");
}

/* -------------------------------------------------------------------------- */
/*  Pure rules                                                                */
/* -------------------------------------------------------------------------- */

test("a forge address is validated, not obeyed", () => {
  assert.equal(parseGitHostUrl("http://192.168.1.90:3000"), "http://192.168.1.90:3000");
  assert.equal(parseGitHostUrl("https://git.example.com/"), "https://git.example.com");
  assert.equal(parseGitHostUrl("  https://git.example.com/gitea/  "), "https://git.example.com/gitea");
  // A trailing API path is the same forge, not a different one.
  assert.equal(parseGitHostUrl("https://git.example.com/api/v1"), "https://git.example.com");
  assert.equal(parseGitHostUrl("https://git.example.com/gitea?x=1#y"), "https://git.example.com/gitea");

  for (const bad of [
    // A credential inside the address would end up in .git/config on the clone.
    "https://user:secret@git.example.com",
    // Neither is a forge this console has any business dialling.
    "file:///srv/git",
    "ssh://git@git.example.com:22/root",
    "git@github.com:acme/widgets.git",
    "git.example.com",
    "not a url",
    "",
    42,
    null,
  ]) {
    assert.equal(parseGitHostUrl(bad), null, `refused: ${JSON.stringify(bad)}`);
  }

  const ref = { owner: "root", name: "created-on-atlas" };
  assert.equal(forgeWebUrl("http://192.168.1.90:3000", ref), "http://192.168.1.90:3000/root/created-on-atlas");
  assert.equal(forgeCloneUrl("http://192.168.1.90:3000", ref), "http://192.168.1.90:3000/root/created-on-atlas.git");
  assert.equal(
    forgeAuthenticatedUrl("http://192.168.1.90:3000", ref, "root", "s3cr3t"),
    "http://root:s3cr3t@192.168.1.90:3000/root/created-on-atlas.git",
  );
  assert.equal(forgeAuthenticatedUrl("http://192.168.1.90:3000", ref, "root", ""), forgeCloneUrl("http://192.168.1.90:3000", ref));
  // The API is Gitea's, under whatever base the caller named.
  assert.equal(forgeApiUrl("http://192.168.1.90:3000", "user"), "http://192.168.1.90:3000/api/v1/user");
  assert.equal(
    forgeApiUrl("http://192.168.1.90:3000", "user", "repos"),
    "http://192.168.1.90:3000/api/v1/user/repos",
  );
  assert.equal(
    forgeApiUrl("http://192.168.1.90:3000", "repos", "root", "a b", "pulls"),
    "http://192.168.1.90:3000/api/v1/repos/root/a%20b/pulls",
  );
  // Both shapes Gitea accepts, and never a bare credential in a header nobody built.
  assert.equal(forgeAuthHeader("root", "s3cr3t"), `Basic ${Buffer.from("root:s3cr3t").toString("base64")}`);
  assert.equal(forgeTokenHeader("abc123"), "token abc123");
});

test("a forge user and secret are checked before anything is dialled with them", () => {
  assert.equal(isForgeUser("root"), true);
  assert.equal(isForgeUser("dev.user-1"), true);
  for (const bad of ["", "has space", "a/b", "user@host", "-leading", 42, null]) {
    assert.equal(isForgeUser(bad), false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(isForgeSecret("hunter2"), true);
  assert.equal(isForgeSecret("ghp_abc12345"), true);
  for (const bad of ["", "   ", "has space", "line\nbreak", "x".repeat(600), 42, null]) {
    assert.equal(isForgeSecret(bad), false, `refused: ${JSON.stringify(bad)}`);
  }

  assert.equal(normalizeRepoName("my-project"), "my-project");
  // Surrounding whitespace is a paste artifact and is trimmed; a space *inside*
  // the name is not a name, and neither is a dot-name.
  assert.equal(normalizeRepoName("  spaced  "), "spaced");
  assert.equal(normalizeRepoName("my project"), null);
  assert.equal(normalizeRepoName(".."), null);
  assert.equal(normalizeRepoName(""), null);

  assert.deepEqual(forgeRepoPayload({ name: "p", private: true, autoInit: true }), {
    name: "p",
    private: true,
    auto_init: true,
    default_branch: "main",
  });
  assert.deepEqual(forgeRepoPayload({ name: "p", description: "why", private: false, autoInit: false }), {
    name: "p",
    private: false,
    auto_init: false,
    default_branch: "main",
    description: "why",
  });

  assert.equal(parseForgeUser({ login: "root" }), "root");
  assert.equal(parseForgeUser({ username: "root" }), "root");
  assert.equal(parseForgeUser({}), null);
  assert.deepEqual(parseForgeRepo({ full_name: "root/x", html_url: "http://a/x", default_branch: "main" }), {
    fullName: "root/x",
    htmlUrl: "http://a/x",
    branch: "main",
  });
  assert.deepEqual(parseForgeRepo(null), { fullName: null, htmlUrl: null, branch: null });
});

/* -------------------------------------------------------------------------- */
/*  Atlas as an add-on                                                        */
/* -------------------------------------------------------------------------- */

test("Atlas is reported as configured, with the deployment's own credential", async () => {
  assert.equal(atlasConfigured(), true);
  const info = await atlasInfo(null);
  assert.equal(info.url, forgeBase);
  assert.equal(info.sshHost, "192.168.1.90");
  assert.equal(info.systemUser, "root");
  assert.equal(info.systemCredential, true);
  // No Magnate configured, so there is no plan to check — and that is not a "no".
  assert.equal(info.entitled, null);
  assert.equal(info.signupUrl, "");
});

test("the verdict for a caller is the plan, unless the deployment has its own credential", () => {
  const base = {
    url: "http://atlas.test",
    configured: true,
    sshHost: "",
    systemUser: "root",
    systemCredential: true,
    entitled: null,
    reason: "",
    signupUrl: "https://magnate.test/signup?plan=atlas",
  };

  // The system path is the operator's own access: no plan involved.
  assert.deepEqual(atlasVerdict(base, true), { ok: true });
  // With a subscriber plan, either credential works.
  assert.deepEqual(atlasVerdict({ ...base, entitled: true }, false), { ok: true });
  // A plan that says no is refused, and says where to subscribe.
  const refused = atlasVerdict({ ...base, entitled: false, reason: "not subscribed" }, false);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.message : "", /add-on/);
  assert.match(refused.ok === false ? refused.message : "", /not subscribed/);
  assert.match(refused.ok === false ? refused.message : "", /signup\?plan=atlas/);

  // A plan that could not be checked falls back to the deployment's credential...
  assert.deepEqual(atlasVerdict({ ...base, entitled: null }, false), { ok: true });
  // ...and is a refusal when there is none.
  const unchecked = atlasVerdict({ ...base, entitled: null, systemCredential: false, systemUser: "" }, false);
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.ok === false ? unchecked.message : "", /could not be checked/);

  // Nothing configured at all is the first thing said.
  const unconfigured = atlasVerdict({ ...base, configured: false }, false);
  assert.match(unconfigured.ok === false ? unconfigured.message : "", /AGENT_ATLAS_URL/);
});

/* -------------------------------------------------------------------------- */
/*  Connecting to the forge                                                   */
/* -------------------------------------------------------------------------- */

test("connecting to Atlas uses the deployment's credential when none is typed", async () => {
  await resetWorkdir();
  const { deps } = fakeDeps();
  const info = await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, deps);

  assert.equal(info.host, forgeBase);
  assert.equal(info.user, "root");
  assert.equal(info.credential, true);
  assert.equal(info.system, false);
});

test("the login the forge answers with is the one remembered, not the one typed", async () => {
  await resetWorkdir();
  const seen: string[] = [];
  const { deps } = fakeDeps({
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return {
        ok: true,
        status: 200,
        json: async () => ({ login: "root" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  const info = await connectForge({ url: "http://atlas.test:3000", user: "someone", secret: "s3cr3t" }, deps);
  assert.equal(info.user, "root");
  assert.equal(seen.length, 1, "the credential was verified exactly once");
});

test("a bad address, a leaked-looking secret and a refused credential are refused", async () => {
  await resetWorkdir();
  const { deps } = fakeDeps();

  await assert.rejects(() => connectForge({ url: "file:///srv/git", user: "root", secret: "x" }, deps), /http\(s\) address/);
  await assert.rejects(() => connectForge({ url: "http://atlas.test", user: "root", secret: "two words" }, deps), /whitespace/);
  await assert.rejects(() => connectForge({ url: "http://atlas.test", user: "bad user", secret: "x" }, deps), /user name/);

  // The forge itself refuses it, and the secret is redacted out of what it echoed.
  const refused = fakeDeps({
    fetchImpl: (async () =>
      ({ ok: false, status: 401, text: async () => `denied: ${ATLAS_PASSWORD}` }) as unknown as Response) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => connectForge({ url: "http://atlas.test:3000", user: "root", secret: ATLAS_PASSWORD }, refused.deps),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /\*\*\*/);
      assert.doesNotMatch(error.message, /atlas-system-password/);
      return true;
    },
  );
});

test("asking for the system credential works directly, and is refused when there is none", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();
  const info = await connectForge({ url: forgeBase, useSystem: true }, deps);
  assert.equal(info.system, true);
  assert.equal(info.user, "root");
  assert.equal(calls.length, 0, "the system path runs no commands of its own");

  // A host the deployment has no credential for is not silently borrowed from.
  await assert.rejects(() => connectForge({ url: "http://elsewhere.test:3000", useSystem: true }, deps), /no Atlas credential/);
});

/* -------------------------------------------------------------------------- */
/*  Cloning, creating, pushing and opening a pull request                     */
/* -------------------------------------------------------------------------- */

test("a clone from the forge carries the credential and does not keep it", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();
  await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, deps);
  calls.length = 0;

  const cloned = await cloneForge({ repo: "root/widgets" }, deps);
  assert.equal(cloned.repo, "root/widgets");
  assert.equal(cloned.rel, "widgets");
  assert.equal(cloned.url, `${forgeBase}/root/widgets`);
  assert.equal(selectedWorkspace(), "widgets");

  assert.match(calls[0]?.command ?? "", /git clone 'http:\/\/root:atlas-system-password@/);
  const setUrl = calls.find((call) => call.command.startsWith("git remote set-url origin"));
  assert.match(setUrl?.command ?? "", /git remote set-url origin 'http:\/\/127\.0\.0\.1:/);
  assert.doesNotMatch(setUrl?.command ?? "", /atlas-system-password/);

  // The clone is remembered, and the listing never carries the secret.
  const clones = listForgeClones();
  assert.equal(clones[0]?.repo, "root/widgets");
  assert.doesNotMatch(JSON.stringify(clones), /atlas-system-password/);
});

test("creating a project on the forge creates it and works in it in one step", async () => {
  await resetWorkdir();
  const posted: { url: string; body: unknown; authorization: string | undefined }[] = [];
  const { deps, calls } = fakeDeps({
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      // The credential is verified first, as it is for every connect.
      if (String(url).endsWith("/api/v1/user")) {
        return { ok: true, status: 200, json: async () => ({ login: "root" }) } as unknown as Response;
      }
      posted.push({
        url: String(url),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      return {
        ok: true,
        status: 201,
        json: async () => ({ full_name: "root/created-on-atlas", html_url: `${forgeBase}/root/created-on-atlas`, default_branch: "main" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, deps);
  posted.length = 0;

  const created = await createForgeRepo({ name: "created-on-atlas", description: "a new project" }, deps);
  assert.equal(created.repo, "root/created-on-atlas");
  assert.equal(created.rel, "created-on-atlas");
  assert.equal(created.web, `${forgeBase}/root/created-on-atlas`);

  assert.equal(posted[0]?.url, `${forgeBase}/api/v1/user/repos`);
  assert.equal(posted[0]?.authorization, forgeAuthHeader("root", ATLAS_PASSWORD));
  assert.deepEqual(posted[0]?.body, {
    name: "created-on-atlas",
    private: true,
    auto_init: true,
    default_branch: "main",
    description: "a new project",
  });

  // And it was cloned and made the working directory, so a preview can run it.
  const clone = calls.find((call) => call.command.startsWith("git clone"));
  assert.match(clone?.command ?? "", /git clone .*created-on-atlas\.git'/);
  assert.equal(selectedWorkspace(), "created-on-atlas");
});

test("a clone named the way a person sees it is found after the selection moved into it", async () => {
  /*
   * Creating a project clones it *and makes it the working directory*, so the name
   * a person reads in the panel — `created-on-atlas` — now resolves one level
   * deeper than it did when the clone landed. A push that names that clone has to
   * find the credential for the directory it was remembered at, not the directory
   * the same words point at afterwards; otherwise a push from inside a project the
   * session is holding reports "not a clone of a repository".
   */
  await resetWorkdir();
  const { deps, calls } = fakeDeps({
    fetchImpl: (async (url: string | URL) => {
      const path = String(url).replace(forgeBase, "");
      if (path === "/api/v1/user") {
        return { ok: true, status: 200, json: async () => ({ login: "root" }) } as unknown as Response;
      }
      if (path === "/api/v1/user/repos") {
        return {
          ok: true,
          status: 201,
          json: async () => ({ full_name: "root/created-on-atlas", html_url: `${forgeBase}/root/created-on-atlas`, default_branch: "main" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ number: 3, html_url: `${forgeBase}/root/created-on-atlas/pulls/3`, title: "Fix the thing" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, deps);
  const created = await createForgeRepo({ name: "created-on-atlas" }, deps);
  assert.equal(created.rel, "created-on-atlas");
  assert.equal(selectedWorkspace(), "created-on-atlas", "the clone is where the agent works now");

  const pushed = await pushForge({ branch: "genie/fix-the-thing", dir: created.rel }, deps);
  assert.equal(pushed.repo, "root/created-on-atlas");
  assert.match(
    calls.find((call) => call.command.startsWith("git push"))?.command ?? "",
    /git push 'http:\/\/root:atlas-system-password@/,
    "and it carries the credential the session holds",
  );

  // The pull request names the same clone, and has to resolve it the same way.
  const pr = await openForgePullRequest(
    { dir: created.rel, title: "Fix the thing", head: "genie/fix-the-thing" },
    deps,
  );
  assert.equal(pr.repo, "root/created-on-atlas");
});

test("a name the forge already has, and a bad name, are refused", async () => {
  await resetWorkdir();
  const conflict = fakeDeps({
    fetchImpl: (async (url: string | URL) =>
      String(url).endsWith("/api/v1/user")
        ? ({ ok: true, status: 200, json: async () => ({ login: "root" }) } as unknown as Response)
        : ({ ok: false, status: 409, text: async () => "repository already exists" } as unknown as Response)) as unknown as typeof fetch,
  });
  await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, conflict.deps);
  await assert.rejects(() => createForgeRepo({ name: "taken" }, conflict.deps), /already has a repository called taken/);

  const { deps, calls } = fakeDeps();
  await assert.rejects(() => createForgeRepo({ name: "has space" }, deps), /letters, digits, dots/);
  assert.equal(
    calls.filter((call) => call.command.startsWith("git clone")).length,
    0,
    "a name is validated before git is asked to write anything",
  );
});

test("a push uses the credential the session holds, and stops when the forge is disconnected", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();
  await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, deps);
  await cloneForge({ repo: "root/widgets" }, deps);

  const pushed = await pushForge({ branch: "genie/fix-the-thing" }, deps);
  assert.equal(pushed.repo, "root/widgets");
  assert.match(
    calls.find((call) => call.command.startsWith("git push"))?.command ?? "",
    /git push 'http:\/\/root:atlas-system-password@.*genie\/fix-the-thing'/,
  );

  // Disconnecting forgets the credential and the pairing, so a push says so
  // rather than failing on a remote that would prompt.
  disconnectForge(forgeBase);
  assert.deepEqual(listForgeClones(), []);
  await assert.rejects(() => pushForge({ branch: "main" }, deps), /connect to the forge first/);
});

test("a pull request is opened on the forge's own API", async () => {
  await resetWorkdir();
  const seen: { url: string; init: RequestInit }[] = [];
  const { deps } = fakeDeps({
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/user")) {
        return { ok: true, status: 200, json: async () => ({ login: "root" }) } as unknown as Response;
      }
      seen.push({ url: String(url), init: init ?? {} });
      return {
        ok: true,
        status: 201,
        json: async () => ({ number: 3, html_url: `${forgeBase}/root/widgets/pulls/3`, state: "open" }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  await connectForge({ url: forgeBase, user: "root", secret: ATLAS_PASSWORD }, deps);
  await cloneForge({ repo: "root/widgets" }, deps);

  const pr = await openForgePullRequest({ title: "Fix the thing", head: "genie/fix-the-thing", body: "why" }, deps);
  assert.equal(pr.number, 3);
  assert.equal(pr.repo, "root/widgets");
  assert.equal(pr.base, "main");
  assert.equal(seen[0]?.url, `${forgeBase}/api/v1/repos/root/widgets/pulls`);
  assert.equal((seen[0]?.init.headers as Record<string, string>).Authorization, forgeAuthHeader("root", ATLAS_PASSWORD));
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
    title: "Fix the thing",
    head: "genie/fix-the-thing",
    base: "main",
    body: "why",
  });
});

/* -------------------------------------------------------------------------- */
/*  The HTTP surface, against the stub Atlas                                  */
/* -------------------------------------------------------------------------- */

test("the remote panel reports Atlas, and the forge routes work end to end", async () => {
  await resetWorkdir();
  const { ensureWorkspace } = await import("../workspace.js");
  await ensureWorkspace();
  const { createServer } = await import("../server.js");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const listed = (await (await fetch(`${base}/api/remote`)).json()) as {
      enabled: boolean;
      atlas: { url: string; sshHost: string; systemUser: string; systemCredential: boolean };
      forge: unknown[];
    };
    assert.equal(listed.enabled, true);
    assert.equal(listed.atlas.url, forgeBase);
    assert.equal(listed.atlas.sshHost, "192.168.1.90");
    assert.equal(listed.atlas.systemUser, "root");
    assert.equal(listed.atlas.systemCredential, true);
    assert.deepEqual(listed.forge, []);

    // Connecting through the route reaches the *real* forge, which is the stub: a
    // wrong credential is refused by it, and a right one is verified by it.
    const bad = await fetch(`${base}/api/remote/forge/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: forgeBase, user: "root", secret: "wrong" }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /refused that credential: HTTP 401/);

    const good = await fetch(`${base}/api/remote/forge/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: forgeBase, useSystem: true }),
    });
    assert.equal(good.status, 201);
    const connected = (await good.json()) as { host: string; user: string; system: boolean };
    assert.equal(connected.host, forgeBase);
    assert.equal(connected.user, "root");
    assert.equal(connected.system, true);

    const listedAgain = (await (await fetch(`${base}/api/remote`)).json()) as { forge: { user: string }[] };
    assert.equal(listedAgain.forge[0]?.user, "root");

    const removed = await fetch(`${base}/api/remote/forge/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: forgeBase }),
    });
    assert.equal(removed.status, 200);
    const after = (await (await fetch(`${base}/api/remote`)).json()) as { forge: unknown[] };
    assert.deepEqual(after.forge, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.after(async () => {
  await new Promise<void>((resolve) => forge.close(() => resolve()));
});
