import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * The account's slice of disk.
 *
 * The requirement this file exists for is blunt: two people signing in to one
 * deployment must not read, diff or delete each other's files, and must not see
 * each other's chats. Before `src/scope.ts` that was one shared workspace and one
 * shared session library, and every assertion below would have failed.
 *
 * Two things are being proven, and they pull in opposite directions, which is why
 * both are here:
 *
 *   * **Tenancy keys the disk.** An account resolves to its own root, its own
 *     chats and its own file history, and an id that tries to look like a path
 *     cannot escape the accounts directory or collide with another account.
 *   * **Single-operator mode is untouched.** With no control plane there is no
 *     account, `defaultScope()` applies, and every path resolves exactly where it
 *     did before this module existed — the shipped default.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-scope-"));

process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");
// No control plane: this file's subject is the scope, and the cases that need a
// plane pass one in.
process.env.CONTROL_PLANE_INTERNAL_URL = "";
process.env.CONTROL_INTERNAL_TOKEN = "";

const { config } = await import("../config.js");
const {
  accountDirName,
  accountScope,
  currentScope,
  defaultScope,
  resetScopeCache,
  runInScope,
  workspaceRoot,
} = await import("../scope.js");
const { resolveInWorkspace, WorkspaceError } = await import("../workspace.js");
const { createSession, getSession, listSessions, saveSession } = await import("../store.js");
const { listSnapshots, readSnapshot, saveSnapshot } = await import("../snapshots.js");
const { scopeFor } = await import("../tenancy.js");
type ControlPlaneConfig = import("../controlplane.js").ControlPlaneConfig;
type Session = import("../oidc.js").Session;

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/* ------------------------------------------------------- single-operator ---- */

test("with no control plane, the disk is shared exactly as it was", async (t) => {
  await t.test("the default scope is the configured workspace and data dir", () => {
    const scope = defaultScope();
    assert.equal(scope.userId, null);
    assert.equal(scope.root, config.workspace);
    assert.equal(scope.sessions, path.join(config.dataDir, "sessions"));
    assert.equal(scope.snapshots, path.join(config.dataDir, "snapshots"));
  });

  await t.test("a path outside any scope resolves against the shared root", () => {
    assert.equal(currentScope().userId, null);
    assert.equal(workspaceRoot(), workspace);
    assert.equal(resolveInWorkspace("src/app.ts"), path.join(workspace, "src/app.ts"));
    assert.throws(() => resolveInWorkspace("../outside.txt"), WorkspaceError);
  });

  await t.test("an unconfigured deployment opens the shared scope", async () => {
    const started = await scopeFor(null);
    assert.equal(started.ok, true);
    if (started.ok) assert.deepEqual(started.scope, defaultScope());
  });
});

/* ---------------------------------------------------------- the account ----- */

test("an account gets its own root, and it is not reachable by naming it", async (t) => {
  await t.test("two accounts are two directories, under the configured workspace", () => {
    const first = accountScope("u-1");
    const second = accountScope("u-2");
    assert.equal(first.userId, "u-1");
    assert.notEqual(first.root, second.root);
    assert.equal(path.dirname(path.dirname(first.root)), workspace);
    assert.equal(path.basename(path.dirname(first.root)), "accounts");
    assert.notEqual(first.sessions, second.sessions);
    assert.notEqual(first.snapshots, second.snapshots);
  });

  await t.test("an id that looks like a path does not become one", () => {
    // The whole point: this value came from another service, so it is data. If it
    // could name a path, `../../..` would be a workspace boundary that is only as
    // good as the control plane's input validation.
    const hostile = [
      "../../etc/passwd",
      "..",
      ".",
      "",
      "/abs/path",
      "a/b",
      "a\\b",
      "u-1\n../2",
      "...",
      "....//....//tmp",
    ];

    for (const id of hostile) {
      const scope = accountScope(id);
      const relative = path.relative(path.join(workspace, "accounts"), scope.root);
      assert.ok(
        relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
        `${JSON.stringify(id)} escaped to ${scope.root}`,
      );
      // And it is a single path segment: nothing that sanitized to a separator or
      // a dot-run may nest.
      assert.equal(path.dirname(relative), ".", `${JSON.stringify(id)} nested at ${relative}`);
      assert.ok(!relative.includes(path.sep), `${JSON.stringify(id)} contains a separator`);
    }
  });

  await t.test("ids that sanitize alike do not share a directory", () => {
    // `a/b` and `a-b` both sanitize to `a-b`. Merging them would be a quieter bug
    // than any traversal, so the digest in the name is what keeps them apart.
    assert.notEqual(accountDirName("a/b"), accountDirName("a-b"));
    assert.notEqual(accountDirName("u.1"), accountDirName("u-1"));
    assert.equal(accountDirName("u-1"), accountDirName("u-1"), "the same id is stable");
  });

  await t.test("inside a scope, every path is the account's", async () => {
    const scope = accountScope("u-1");
    await runInScope(scope, async () => {
      assert.equal(workspaceRoot(), scope.root);
      assert.equal(resolveInWorkspace("notes.txt"), path.join(scope.root, "notes.txt"));
      assert.equal(resolveInWorkspace("."), scope.root);
      assert.throws(() => resolveInWorkspace("../other-account/notes.txt"), WorkspaceError);
    });

    // And nothing leaks afterwards: the context is the request's, not the
    // process's.
    assert.equal(currentScope().userId, null);
    assert.equal(workspaceRoot(), workspace);
  });

  await t.test("the scope's directories exist by the time a request runs", async () => {
    const scope = accountScope("u-created");
    await runInScope(scope, async () => {
      assert.equal((await fs.stat(scope.root)).isDirectory(), true);
      assert.equal((await fs.stat(scope.sessions)).isDirectory(), true);
      assert.equal((await fs.stat(scope.snapshots)).isDirectory(), true);
    });
  });
});

/* ------------------------------------------------------------- the disk ----- */

test("two accounts do not share a chat list or a file history", async (t) => {
  const first = accountScope("u-1");
  const second = accountScope("u-2");

  t.beforeEach(() => resetScopeCache());

  await t.test("a chat written in one account is absent from the next", async () => {
    let id = "";
    await runInScope(first, async () => {
      const session = createSession();
      id = session.id;
      session.title = "mine";
      session.messages = [{ role: "user", content: "hi" }];
      await saveSession(session);
      assert.equal((await listSessions()).length, 1);
    });

    await runInScope(second, async () => {
      assert.deepEqual(await listSessions(), [], "a stranger's chat list must be empty");
      assert.equal(await getSession(id), null, "and their chat is not readable by id either");
    });

    // The conversation really is on disk, in the first account's library.
    await runInScope(first, async () => {
      assert.equal((await listSessions())[0]?.id, id);
    });
  });

  await t.test("file history is per account, not per relative path", async () => {
    // The same relative path in two accounts is two different files. Hashing only
    // the relative path would have made the second one diff against a stranger's
    // baseline.
    await runInScope(first, async () => {
      await saveSnapshot("index.html", "<h1>first</h1>");
      assert.equal((await readSnapshot("index.html"))?.content, "<h1>first</h1>");
      assert.deepEqual([...(await listSnapshots()).keys()], ["index.html"]);
    });

    await runInScope(second, async () => {
      assert.equal(await readSnapshot("index.html"), null);
      assert.equal((await listSnapshots()).size, 0);
    });
  });
});

/* ------------------------------------------------------------ over the wire - */

test("a signed-in request opens that account's workspace", async (t) => {
  const PLANE: ControlPlaneConfig = { url: "http://127.0.0.1:1", token: "plane-token" };
  const session: Session = {
    sub: "sub-1",
    email: "dev@innotel.us",
    name: "Dev",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  await t.test("a plane configured without sign-in is refused, not served the shared disk", async () => {
    const started = await scopeFor(null, PLANE);
    assert.equal(started.ok, false);
    if (!started.ok) {
      assert.equal(started.status, 401);
      assert.match(started.message, /Sign in/);
    }
  });

  await t.test("a session with no subject is refused the same way", async () => {
    const started = await scopeFor({ ...session, sub: "" }, PLANE);
    assert.equal(started.ok, false);
  });

  await t.test("a plane that cannot be reached opens nothing", async () => {
    // An unreachable plane must not fall back to the shared workspace: that is the
    // leak this closes, and would be worse than refusing.
    const started = await scopeFor(session, PLANE);
    assert.equal(started.ok, false);
    if (!started.ok) {
      assert.equal(started.status, 503);
      assert.match(started.message, /no workspace was opened/);
    }
  });
});
