import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Remote workspaces (v0.6): a folder on a server over SSH, and a repository on
 * GitHub — both with the **caller's** credential rather than the deployment's.
 *
 * These cases hold the parts that make that safe rather than merely workable:
 *
 *   * a host, a user and a path a caller supplies cannot become an argument, and a
 *     path with `..` or a relative path is refused before anything is dialled;
 *   * a deployment that names allowed hosts reaches those and nothing else;
 *   * a credential is never in a command line — the secret goes to `sshpass`
 *     through the environment — and a mount that was not left behind is an error,
 *     not a working directory;
 *   * a GitHub repository must be *on GitHub*, a clone lands inside the working
 *     directory and nowhere else, the clone command carries the token and
 *     `origin` does not, and a failure that echoes the token has it redacted;
 *   * the connections live in this process, keyed per account, and are gone when
 *     it stops.
 *
 * The workspace, the data directory and the host allowlist are read once, at
 * import, so this file sets them before it imports anything.
 */

const WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "genie-remote-"));
const DATA = path.join(WORKSPACE, ".agent");
process.env.AGENT_WORKSPACE = WORKSPACE;
process.env.AGENT_DATA_DIR = DATA;
process.env.AGENT_REMOTE_ALLOWED_HOSTS = "*.example.com,build.internal";
// Read once, at import, like every other setting — so the server this file starts
// is a gated one and the routes below are exercised through their real gate.
process.env.WEB_TOKEN = "test-token";

const {
  gitHubApiUrl,
  gitHubAuthenticatedUrl,
  gitHubCloneUrl,
  gitHubHeaders,
  gitHubSlug,
  gitHubUrl,
  hostAllowed,
  isGitHubToken,
  isRemoteRel,
  isSshHost,
  isSshUser,
  mountDirFor,
  normalizeRemotePath,
  parseGitHubSpec,
  parseSshPort,
  parseSshSpec,
  remoteId,
  remoteRel,
  shellQuote,
  sshLabel,
  sshMountEnv,
  sshTarget,
  sshfsCommand,
  unmountCommand,
} = await import("../remote-rules.js");

const remote = await import("../remote.js");
const {
  cloneGitHub,
  connectSsh,
  disconnectSsh,
  listGitHub,
  listSsh,
  openGitHubPullRequest,
  pushGitHub,
  remoteEnabled,
  RemoteError,
  resetRemoteSelection,
  resetRemotes,
  shutdownRemotes,
} = remote;
type RemoteDeps = import("../remote.js").RemoteDeps;
type RemoteInvocation = import("../remote.js").RemoteInvocation;
type RemoteResult = import("../remote.js").RemoteResult;

const { setSelectedWorkspace, selectedWorkspace } = await import("../scope.js");

// Assembled from fragments: a PEM block is key-shaped, and scripts/secret-scan.py
// flags that shape in tests as well, so a literal header here is a finding.
const PEM_BEGIN = ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END OPENSSH", "PRIVATE KEY-----"].join(" ");

const KEY = [
  PEM_BEGIN,
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  PEM_END,
].join("\n");

/** A pair of fakes: the shell runner and the "is it really mounted?" probe. */
function fakeDeps(
  handlers: {
    run?: (invocation: RemoteInvocation) => Partial<RemoteResult>;
    mounted?: (mountPoint: string) => boolean | Promise<boolean>;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const calls: RemoteInvocation[] = [];
  // The fake models the mount table the way the real one behaves: `sshfs` puts a
  // mount there, an unmount takes it away. A fake that always answered "mounted"
  // would hide the stale-mount cleanup, and one that never did would fail every
  // connect.
  let live = false;
  const run = async (invocation: RemoteInvocation): Promise<RemoteResult> => {
    calls.push(invocation);
    const answer = handlers.run?.(invocation) ?? {};
    const result: RemoteResult = {
      ok: answer.ok ?? true,
      exitCode: answer.exitCode ?? 0,
      output: answer.output ?? "",
      ...(answer.refused === undefined ? {} : { refused: answer.refused }),
    };
    if (result.ok && invocation.command.startsWith("sshfs ")) live = true;
    if (invocation.command.includes("fusermount")) live = false;
    return result;
  };
  const mounted = async (mountPoint: string): Promise<boolean> =>
    handlers.mounted === undefined ? live : await handlers.mounted(mountPoint);
  const deps: RemoteDeps = {
    run,
    mounted,
    fetchImpl:
      handlers.fetchImpl ?? ((async () => {
        throw new Error("no request was expected");
      }) as unknown as typeof fetch),
  };
  return { deps, calls };
}

/** Back to the sandbox root, so one case cannot inherit another's working directory. */
async function resetWorkdir(): Promise<void> {
  resetRemotes();
  if (selectedWorkspace() !== "") await setSelectedWorkspace("");
}

/** The connection directories one account has credentials in, sorted. */
async function credentialsDirs(): Promise<string[]> {
  const entries = await fs.readdir(path.join(DATA, "remote", "shared"), { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => entry.name).sort();
}

/* -------------------------------------------------------------------------- */
/*  Pure rules: what a caller may name                                        */
/* -------------------------------------------------------------------------- */

test("a remote folder is named host, user and an absolute path", () => {
  assert.deepEqual(parseSshSpec({ host: "dev.example.com", user: "deploy", path: "/srv/app" }), {
    host: "dev.example.com",
    port: 22,
    user: "deploy",
    path: "/srv/app",
  });
  assert.deepEqual(parseSshSpec({ host: "dev.example.com", port: "2222", user: "deploy", path: "/srv/app/" }), {
    host: "dev.example.com",
    port: 2222,
    user: "deploy",
    path: "/srv/app",
  });
  // A bracketed IPv6 literal, and a path with the spaces a real project has.
  assert.deepEqual(parseSshSpec({ host: "[::1]", user: "root", path: "/srv/my app" }), {
    host: "[::1]",
    port: 22,
    user: "root",
    path: "/srv/my app",
  });

  for (const bad of [
    { host: "-oProxyCommand=curl evil", user: "deploy", path: "/srv/app" },
    { host: "host name", user: "deploy", path: "/srv/app" },
    { host: "user@host", user: "deploy", path: "/srv/app" },
    { host: "a..b", user: "deploy", path: "/srv/app" },
    { host: "dev.example.com", user: "-oProxyCommand=x", path: "/srv/app" },
    { host: "dev.example.com", user: "deploy", path: "relative/app" },
    { host: "dev.example.com", user: "deploy", path: "/srv/../../etc" },
    { host: "dev.example.com", user: "deploy", path: "/srv/app\nrm -rf /" },
    { host: "dev.example.com", user: "deploy", path: "" },
    { host: "dev.example.com", user: "deploy", path: "/srv/app", port: "abc" },
    { host: "dev.example.com", user: "deploy", path: "/srv/app", port: 0 },
    { host: "dev.example.com", user: "deploy", path: "/srv/app", port: 70000 },
    null,
    "dev.example.com:/srv/app",
  ]) {
    assert.equal(parseSshSpec(bad), null, `refused: ${JSON.stringify(bad)}`);
  }

  assert.equal(isSshHost("dev.example.com"), true);
  assert.equal(isSshHost("[fe80::1]"), true);
  assert.equal(isSshHost("192.168.1.20"), true);
  assert.equal(isSshHost("bad host"), false);
  assert.equal(isSshUser("deploy-user"), true);
  assert.equal(isSshUser("-deploy"), false);
  assert.equal(parseSshPort(undefined), 22);
  assert.equal(parseSshPort("22"), 22);
  assert.equal(parseSshPort("0"), null);
  assert.equal(normalizeRemotePath("/srv//app"), "/srv/app");
  assert.equal(normalizeRemotePath("/srv/app/.."), null);
});

test("an allowlist narrows the hosts a deployment reaches, and an empty one allows anything", () => {
  assert.equal(hostAllowed("anything.internal", []), true);
  assert.equal(hostAllowed("dev.example.com", ["*.example.com"]), true);
  assert.equal(hostAllowed("example.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("BUILD.INTERNAL", ["build.internal"]), true);
  assert.equal(hostAllowed("other.host", ["build.internal", "*.example.com"]), false);
  assert.equal(hostAllowed("[::1]", ["*.example.com", "::1"]), true);
});

test("a connection's id is a name the sandbox can hold, and its directory is a dot-directory", () => {
  const spec = { host: "dev.example.com", port: 22, user: "deploy", path: "/srv/app" };
  const other = { host: "dev.example.com", port: 22, user: "deploy", path: "/srv/other" };
  assert.equal(remoteId(spec), remoteId({ ...spec }));
  assert.notEqual(remoteId(spec), remoteId(other));
  assert.match(remoteId(spec), /^dev\.example\.com-[0-9a-f]{10}$/);
  // A bracketed IPv6 literal still produces a directory name with nothing a path
  // could use in it.
  assert.match(remoteId({ ...spec, host: "[::1]" }), /^[A-Za-z0-9.-]+-[0-9a-f]{10}$/);

  assert.equal(remoteRel(spec), `.remotes/${remoteId(spec)}`);
  assert.equal(mountDirFor("/sandbox", "abc"), path.join("/sandbox", ".remotes", "abc"));
  assert.equal(isRemoteRel(".remotes/x"), true);
  assert.equal(isRemoteRel(".remotes"), true);
  assert.equal(isRemoteRel("project"), false);
  assert.equal(isRemoteRel("project/.remotes"), false);

  assert.equal(sshTarget(spec), "deploy@dev.example.com:/srv/app");
  assert.equal(sshLabel(spec), "deploy@dev.example.com:/srv/app");
  assert.equal(sshLabel({ ...spec, port: 2222 }), "deploy@dev.example.com:2222:/srv/app");
});

test("the mount command pins the host key, uses the caller's key, and never holds a secret", () => {
  const spec = { host: "dev.example.com", port: 2222, user: "deploy", path: "/srv/my app" };
  const keyed = sshfsCommand(spec, {
    mountPoint: "/sandbox/.remotes/dev-1",
    keyFile: "/data/remote/shared/dev-1/id_key",
    knownHostsFile: "/data/remote/known_hosts",
  });
  assert.match(keyed, /^sshfs 'deploy@dev\.example\.com:\/srv\/my app' '\/sandbox\/\.remotes\/dev-1' -p 2222/);
  assert.match(keyed, /-o 'IdentityFile=\/data\/remote\/shared\/dev-1\/id_key'/);
  assert.match(keyed, /-o 'IdentitiesOnly=yes'/);
  assert.match(keyed, /-o 'BatchMode=yes'/, "no secret means no prompt to answer");
  assert.match(keyed, /-o 'StrictHostKeyChecking=accept-new'/);
  assert.match(keyed, /-o 'UserKnownHostsFile=\/data\/remote\/known_hosts'/);
  assert.match(keyed, /-o 'dir_cache=no'/, "a remote tree that changes underneath us is not cached");

  const withSecret = sshfsCommand(spec, {
    mountPoint: "/sandbox/.remotes/dev-1",
    secret: true,
    knownHostsFile: "/data/remote/known_hosts",
  });
  assert.match(withSecret, /-o 'ssh_command=sshpass -e ssh'/);
  assert.doesNotMatch(withSecret, /BatchMode/, "sshpass exists to answer the prompt BatchMode would forbid");
  assert.doesNotMatch(withSecret, /IdentityFile/, "no key means no key file");

  assert.deepEqual(sshMountEnv("hunter2"), { SSHPASS: "hunter2" });
  assert.deepEqual(sshMountEnv(""), {});
  assert.deepEqual(sshMountEnv(undefined), {});
  assert.equal(
    unmountCommand("/sandbox/.remotes/dev-1"),
    "fusermount3 -u '/sandbox/.remotes/dev-1' || fusermount -u '/sandbox/.remotes/dev-1' || umount '/sandbox/.remotes/dev-1'",
  );
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});

test("a repository must be on GitHub, and the token goes in the clone URL, not in the config", () => {
  assert.deepEqual(parseGitHubSpec("acme/widgets"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseGitHubSpec("  acme/widgets.git "), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseGitHubSpec("github.com/acme/widgets"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseGitHubSpec("https://github.com/acme/widgets"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseGitHubSpec("git@github.com:acme/widgets.git"), { owner: "acme", name: "widgets" });
  assert.deepEqual(parseGitHubSpec("ssh://git@github.com/acme/widgets"), { owner: "acme", name: "widgets" });

  // A different host is refused rather than quietly cloned from GitHub.
  for (const bad of [
    "https://gitlab.com/acme/widgets",
    "https://evil.example/acme/widgets",
    "git@bitbucket.org:acme/widgets.git",
    "widgets",
    "a/b/c",
    "acme/..",
    "acme/wid gets",
    42,
    null,
  ]) {
    assert.equal(parseGitHubSpec(bad), null, `refused: ${JSON.stringify(bad)}`);
  }

  const ref = { owner: "acme", name: "widgets" };
  assert.equal(gitHubSlug(ref), "acme/widgets");
  assert.equal(gitHubUrl(ref), "https://github.com/acme/widgets");
  assert.equal(gitHubCloneUrl(ref), "https://github.com/acme/widgets.git");
  assert.match(gitHubAuthenticatedUrl(ref, "ghp_abc12345"), /^https:\/\/x-access-token:ghp_abc12345@github\.com\/acme\/widgets\.git$/);
  assert.equal(gitHubAuthenticatedUrl(ref, ""), gitHubCloneUrl(ref));
  assert.equal(gitHubApiUrl(ref, "pulls"), "https://api.github.com/repos/acme/widgets/pulls");
  assert.equal(gitHubApiUrl(ref), "https://api.github.com/repos/acme/widgets");

  const headers = gitHubHeaders("ghp_abc12345");
  assert.equal(headers.Authorization, "Bearer ghp_abc12345");
  assert.equal(headers["User-Agent"], "ontrak-genie");

  assert.equal(isGitHubToken("ghp_abc12345"), true);
  assert.equal(isGitHubToken("github_pat_11ABC"), true);
  for (const bad of ["", "short", "has space", "line\nbreak", 42, null]) {
    assert.equal(isGitHubToken(bad), false, `refused: ${JSON.stringify(bad)}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  Mounting a remote folder                                                  */
/* -------------------------------------------------------------------------- */

test("connecting mounts under the sandbox, keeps the key private, and moves the working directory", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();

  const info = await connectSsh(
    { host: "dev.example.com", user: "deploy", path: "/srv/app", key: KEY },
    deps,
  );

  assert.equal(info.rel, `.remotes/${info.id}`);
  assert.equal(info.mountPoint, path.join(WORKSPACE, ".remotes", info.id));
  assert.equal(info.auth, "key");
  assert.equal(info.label, "deploy@dev.example.com:/srv/app");

  const mount = calls[0];
  assert.match(mount?.command ?? "", /^sshfs 'deploy@dev\.example\.com:\/srv\/app'/);
  assert.equal(mount?.cwd, WORKSPACE);
  assert.deepEqual(mount?.env, {}, "a key needs no environment secret");

  // The key is a file only because sshfs must read one, and only this process can.
  const keyFile = path.join(DATA, "remote", "shared", info.id, "id_key");
  assert.equal(await fs.readFile(keyFile, "utf8"), `${KEY}\n`);
  assert.equal(((await fs.stat(keyFile)).mode & 0o777).toString(8), "600");

  // And the agent now works *there*.
  assert.equal(selectedWorkspace(), info.rel);
  const listed = await listSsh(deps);
  assert.deepEqual(listed.map((row) => row.rel), [info.rel]);
  assert.equal(listed[0]?.live, true);
});

test("a password reaches the mount through the environment, never the command line", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();

  const info = await connectSsh(
    { host: "dev.example.com", user: "deploy", path: "/srv/app", password: "hunter2" },
    deps,
  );

  assert.equal(info.auth, "password");
  assert.deepEqual(calls[0]?.env, { SSHPASS: "hunter2" });
  assert.doesNotMatch(calls[0]?.command ?? "", /hunter2/);
  // Nothing was written to disk for a password.
  const entries = await fs.readdir(path.join(DATA, "remote", "shared", info.id)).catch(() => []);
  assert.deepEqual(entries, []);
});

test("a password wins over a key when both are given, and the key is not written", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();

  const info = await connectSsh(
    { host: "dev.example.com", user: "deploy", path: "/srv/app", key: KEY, password: "hunter2" },
    deps,
  );

  assert.equal(info.auth, "password");
  assert.deepEqual(calls[0]?.env, { SSHPASS: "hunter2" });
  // The key is neither offered to sshfs nor left on disk for it to pick up: a
  // connection that authenticates by password must not carry one at all.
  assert.doesNotMatch(calls[0]?.command ?? "", /IdentityFile/);
  assert.doesNotMatch(calls[0]?.command ?? "", /hunter2/);
  const entries = await fs.readdir(path.join(DATA, "remote", "shared", info.id)).catch(() => []);
  assert.deepEqual(entries, [], "nothing was written for the key either");
});

test("a host outside the allowlist, a missing credential, and a bad key are all refused before anything runs", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();
  const before = await credentialsDirs();

  await assert.rejects(
    () => connectSsh({ host: "elsewhere.net", user: "deploy", path: "/srv/app", password: "x" }, deps),
    /AGENT_REMOTE_ALLOWED_HOSTS/,
  );
  await assert.rejects(
    () => connectSsh({ host: "dev.example.com", user: "deploy", path: "/srv/app" }, deps),
    /private key or a password/,
  );
  await assert.rejects(
    () => connectSsh({ host: "dev.example.com", user: "deploy", path: "/srv/app", key: "not a key" }, deps),
    /does not look like a private key/,
  );
  await assert.rejects(
    () => connectSsh({ host: "dev.example.com", user: "deploy", path: "relative/app", password: "x" }, deps),
    /host, user/,
  );

  assert.equal(calls.length, 0, "nothing was dialled");
  // And no credential was written for a connection that was never made.
  assert.deepEqual(await credentialsDirs(), before);
});

test("a mount that is not there afterwards is a failure, and the key file goes with it", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps({ mounted: () => false });

  await assert.rejects(
    () => connectSsh({ host: "dev.example.com", user: "deploy", path: "/srv/app", key: KEY }, deps),
    /nothing is reachable at it/,
  );
  assert.equal(selectedWorkspace(), "", "the agent was not pointed at a dead directory");
  assert.deepEqual(await listSsh(deps), []);
  // The key file went with the failure: a mount that did not happen keeps no
  // credential.
  const id = remoteId({ host: "dev.example.com", port: 22, user: "deploy", path: "/srv/app" });
  assert.equal(await fs.stat(path.join(DATA, "remote", "shared", id)).catch(() => null), null);
  assert.ok(calls.some((call) => call.command.startsWith("fusermount3 -u")));
});

test("a failed sshfs reports why, with any secret in the output redacted", async () => {
  await resetWorkdir();
  const { deps } = fakeDeps({
    run: () => ({ ok: false, exitCode: 255, output: "Permission denied (publickey,password). password hunter2" }),
  });
  await assert.rejects(
    () => connectSsh({ host: "dev.example.com", user: "deploy", path: "/srv/app", password: "hunter2" }, deps),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /could not mount deploy@dev\.example\.com:\/srv\/app/);
      assert.match(error.message, /\*\*\*/);
      assert.doesNotMatch(error.message, /hunter2/);
      return true;
    },
  );
});

test("connecting twice is refused, and disconnecting leaves the sandbox", async () => {
  await resetWorkdir();
  const { deps } = fakeDeps();
  const input = { host: "dev.example.com" as const, user: "deploy", path: "/srv/app", password: "hunter2" };
  const info = await connectSsh(input, deps);
  await assert.rejects(() => connectSsh(input, deps), /already connected/);

  const removed = await disconnectSsh(info.id, deps);
  assert.deepEqual(removed, { id: info.id, rel: info.rel });
  assert.deepEqual(await listSsh(deps), []);
  assert.equal(selectedWorkspace(), "", "the working directory went back to the sandbox");
  await assert.rejects(() => disconnectSsh(info.id, deps), /no such connection/);
});

test("a saved session and a restart do not leave the agent in a mount that is gone", async () => {
  await resetWorkdir();
  const { deps } = fakeDeps();
  const info = await connectSsh(
    { host: "dev.example.com", user: "deploy", path: "/srv/app", password: "hunter2" },
    deps,
  );
  assert.equal(selectedWorkspace(), info.rel);

  // The process forgets its mounts (a restart), but the saved choice is on disk.
  resetRemotes();
  assert.equal(await resetRemoteSelection(), info.rel);
  assert.equal(selectedWorkspace(), "");
  assert.equal(await resetRemoteSelection(), null);
});

test("shutdown unmounts everything and forgets the credentials", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();
  const info = await connectSsh(
    { host: "dev.example.com", user: "deploy", path: "/srv/app", password: "hunter2" },
    deps,
  );
  await shutdownRemotes(deps);

  assert.deepEqual(await listSsh(deps), []);
  assert.ok(calls.some((call) => call.command.startsWith("fusermount3 -u")));
  assert.equal(await fs.stat(path.join(DATA, "remote", "shared", info.id)).catch(() => null), null);
});

/* -------------------------------------------------------------------------- */
/*  GitHub                                                                    */
/* -------------------------------------------------------------------------- */

test("cloning lands in the working directory, carries the token, and does not keep it", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();

  const info = await cloneGitHub({ repo: "acme/widgets", token: "ghp_abc12345" }, deps);

  assert.equal(info.repo, "acme/widgets");
  assert.equal(info.rel, "widgets");
  assert.equal(info.url, "https://github.com/acme/widgets");
  assert.equal(info.credential, true);
  assert.equal(selectedWorkspace(), "widgets", "the agent works in the clone, so the preview runs it");

  const clone = calls[0];
  assert.match(clone?.command ?? "", /git clone 'https:\/\/x-access-token:ghp_abc12345@github\.com\/acme\/widgets\.git'/);
  const setUrl = calls.find((call) => call.command.startsWith("git remote set-url origin"));
  assert.match(setUrl?.command ?? "", /'https:\/\/github\.com\/acme\/widgets\.git'/);
  assert.doesNotMatch(setUrl?.command ?? "", /ghp_abc12345/);

  // The listing says a credential is held, and never what it is.
  const listed = listGitHub();
  assert.equal(listed[0]?.credential, true);
  assert.doesNotMatch(JSON.stringify(listed), /ghp_abc12345/);
});

test("a public clone needs no token, and an off-GitHub or escaping target is refused before git runs", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();

  const info = await cloneGitHub({ repo: "acme/public", token: "" }, deps);
  assert.equal(info.credential, false);
  assert.doesNotMatch(calls[0]?.command ?? "", /x-access-token/);

  const before = calls.length;
  await assert.rejects(() => cloneGitHub({ repo: "https://gitlab.com/acme/widgets", token: "ghp_abc12345" }, deps), /owner\/name/);
  await assert.rejects(() => cloneGitHub({ repo: "acme/widgets", dir: "../escape", token: "ghp_abc12345" }, deps), /outside the workspace/);
  await assert.rejects(() => cloneGitHub({ repo: "acme/widgets", token: "nope" }, deps), /does not look like a GitHub token/);
  assert.equal(calls.length, before, "git was never asked to write anything");
});

test("a clone onto a directory with something in it, and a failed clone, are refused with the token redacted", async () => {
  await resetWorkdir();
  await fs.mkdir(path.join(WORKSPACE, "taken"), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE, "taken", "file.txt"), "keep me\n");
  const { deps } = fakeDeps();
  await assert.rejects(() => cloneGitHub({ repo: "acme/widgets", dir: "taken", token: "ghp_abc12345" }, deps), /already something/);
  assert.equal(await fs.readFile(path.join(WORKSPACE, "taken", "file.txt"), "utf8"), "keep me\n");

  const failing = fakeDeps({
    run: () => ({ ok: false, exitCode: 128, output: "fatal: could not read from https://x-access-token:ghp_abc12345@github.com" }),
  });
  await assert.rejects(
    () => cloneGitHub({ repo: "acme/private", token: "ghp_abc12345" }, failing.deps),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.message, /\*\*\*/);
      assert.doesNotMatch(error.message, /ghp_abc12345/);
      return true;
    },
  );
});

test("a push uses the credential this session holds, and refuses without one", async () => {
  await resetWorkdir();
  const { deps, calls } = fakeDeps();
  await cloneGitHub({ repo: "acme/widgets", token: "ghp_abc12345" }, deps);

  const pushed = await pushGitHub({ branch: "genie/fix-the-thing" }, deps);
  assert.deepEqual(pushed, { branch: "genie/fix-the-thing", repo: "acme/widgets" });
  const push = calls.find((call) => call.command.startsWith("git push"));
  assert.match(push?.command ?? "", /git push 'https:\/\/x-access-token:ghp_abc12345@github\.com\/acme\/widgets\.git' 'genie\/fix-the-thing'/);

  // A branch name is validated before anything is pushed.
  await assert.rejects(() => pushGitHub({ branch: "bad..name" }, deps), /valid branch/);

  // With no connection and no token, a push is refused rather than attempted.
  await resetWorkdir();
  const { deps: bare, calls: bareCalls } = fakeDeps();
  await assert.rejects(() => pushGitHub({ branch: "main" }, bare), /not a clone of a repository on github\.com/);
  await assert.rejects(
    () => pushGitHub({ branch: "main", repo: "acme/widgets" }, bare),
    /no GitHub credential is held/,
  );
  assert.equal(bareCalls.filter((call) => call.command.startsWith("git push")).length, 0, "nothing was pushed");
});

test("a pull request goes to GitHub's API with the token this session holds", async () => {
  await resetWorkdir();
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFake = (async (url: string | URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 12, html_url: "https://github.com/acme/widgets/pull/12", state: "open" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const { deps } = fakeDeps({ fetchImpl: fetchFake });
  await cloneGitHub({ repo: "acme/widgets", token: "ghp_abc12345" }, deps);

  const pr = await openGitHubPullRequest({ title: "Fix the thing", head: "genie/fix-the-thing", body: "why" }, deps);
  assert.equal(pr.number, 12);
  assert.equal(pr.repo, "acme/widgets");
  assert.equal(pr.base, "main");

  assert.equal(seen[0]?.url, "https://api.github.com/repos/acme/widgets/pulls");
  assert.equal((seen[0]?.init.headers as Record<string, string>).Authorization, "Bearer ghp_abc12345");
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
    title: "Fix the thing",
    head: "genie/fix-the-thing",
    base: "main",
    body: "why",
  });
});

test("a refused pull request surfaces GitHub's own answer, and a token is required", async () => {
  await resetWorkdir();
  const refusing = fakeDeps({
    fetchImpl: (async () =>
      ({ ok: false, status: 422, text: async () => "Validation Failed" }) as unknown as Response) as unknown as typeof fetch,
  });
  const { deps } = fakeDeps();
  await cloneGitHub({ repo: "acme/widgets", token: "ghp_abc12345" }, refusing.deps);
  await assert.rejects(
    () => openGitHubPullRequest({ title: "x", head: "genie/x" }, refusing.deps),
    /HTTP 422.*Validation Failed/,
  );

  await resetWorkdir();
  await assert.rejects(
    () => openGitHubPullRequest({ repo: "acme/widgets", title: "x", head: "genie/x" }, deps),
    /token is required/,
  );
  await assert.rejects(() => openGitHubPullRequest({ title: "x", head: "genie/x" }, deps), /owner\/name/);
});

/* -------------------------------------------------------------------------- */
/*  The HTTP surface                                                          */
/* -------------------------------------------------------------------------- */

test("the remote routes report, refuse and authorize like the rest of the API", async () => {
  await resetWorkdir();
  const { ensureWorkspace } = await import("../workspace.js");
  await ensureWorkspace();
  const { createServer } = await import("../server.js");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
  const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

  try {
    assert.equal((await fetch(`${base}/api/remote`)).status, 401);

    // A connection made through the module is what the route reports.
    const { deps } = fakeDeps();
    const mounted = await connectSsh(
      { host: "dev.example.com", user: "deploy", path: "/srv/app", password: "hunter2" },
      deps,
    );
    const listed = (await (await fetch(`${base}/api/remote`, { headers: auth })).json()) as {
      enabled: boolean;
      allowedHosts: string[];
      ssh: { rel: string; label: string }[];
      github: unknown[];
    };
    assert.equal(listed.enabled, true);
    assert.deepEqual(listed.allowedHosts, ["*.example.com", "build.internal"]);
    assert.equal(listed.ssh[0]?.rel, mounted.rel);
    assert.equal(listed.ssh[0]?.label, "deploy@dev.example.com:/srv/app");
    assert.deepEqual(listed.github, []);

    // A refused connection is the caller's problem, not a server fault.
    const refused = await fetch(`${base}/api/remote/ssh`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ host: "elsewhere.net", user: "deploy", path: "/srv/app", password: "x" }),
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /AGENT_REMOTE_ALLOWED_HOSTS/);

    const offHost = await fetch(`${base}/api/remote/github/clone`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ repo: "https://gitlab.com/acme/widgets", token: "ghp_abc12345" }),
    });
    assert.equal(offHost.status, 400);

    // And disconnecting through the route takes the mount out of the listing.
    const disconnected = await fetch(`${base}/api/remote/ssh/disconnect`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: mounted.id }),
    });
    assert.equal(disconnected.status, 200);
    const after = (await (await fetch(`${base}/api/remote`, { headers: auth })).json()) as { ssh: unknown[] };
    assert.deepEqual(after.ssh, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("remote work is on by default", () => {
  assert.equal(remoteEnabled(), true);
});
