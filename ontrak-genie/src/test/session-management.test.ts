import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * The housekeeping a chat list needs: a name that is yours, and putting a
 * finished chat away (v0.3).
 *
 * Both are edits to the record the console already reads and writes, so what is
 * worth asserting is not the round trip — it is the two ways each could quietly
 * do the wrong thing. A title has to be flattened and bounded, because it is
 * rendered into a one-line list and an unbounded or multi-line one would push
 * everything else out of it. Archiving has to touch *nothing but the flag*,
 * because the whole reason it is not deletion is that the transcript stays.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "genie-sessions-"));

process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_DATA_DIR = path.join(workspace, ".agent");

const {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  normalizeTitle,
  saveSession,
  setSessionArchived,
} = await import("../store.js");

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

test("cleaning a chat title", async (t) => {
  await t.test("flattens whitespace, so a name cannot break the list it is drawn in", () => {
    assert.equal(normalizeTitle("  a  two\nline  name "), "a two line name");
  });

  await t.test("says nothing rather than setting a blank name", () => {
    // Absent is what keeps a rename from silently clearing the title: the route
    // treats `undefined` as "not asked", and only a real string as an edit.
    assert.equal(normalizeTitle("   "), undefined);
    assert.equal(normalizeTitle("\n\t"), undefined);
    assert.equal(normalizeTitle(undefined), undefined);
    assert.equal(normalizeTitle(42), undefined);
    assert.equal(normalizeTitle({ title: "x" }), undefined);
  });

  await t.test("bounds the length, at the same size a derived title is cut to", () => {
    const long = "x".repeat(300);
    assert.equal(normalizeTitle(long)?.length, 64);
    assert.equal(normalizeTitle("y".repeat(64))?.length, 64);
  });
});

test("putting a chat away", async (t) => {
  await t.test("an archive is a flag on the chat, not a place on disk", async () => {
    const session = createSession();
    session.messages = [{ role: "user", content: "the work that was done" }];
    await saveSession(session);

    const archived = await setSessionArchived(session.id, true);
    assert.equal(archived?.archived, true);
    assert.equal(typeof archived?.archivedAt, "string");

    // The transcript is exactly as it was: that is what makes this reversible by
    // the person who owns the chat rather than only by an administrator.
    const readBack = await getSession(session.id);
    assert.equal(readBack?.messages.length, 1);
    assert.equal(readBack?.messages[0]?.content, "the work that was done");
    assert.equal(readBack?.title, "New chat");
  });

  await t.test("it is listed, and says it is archived", async () => {
    const session = createSession();
    await saveSession(session);
    await setSessionArchived(session.id, true);

    const listed = await listSessions();
    const row = listed.find((entry) => entry.id === session.id);
    assert.equal(row?.archived, true);
    assert.equal(typeof row?.archivedAt, "string");
  });

  await t.test("bringing it back clears the timestamp with the flag", async () => {
    const session = createSession();
    await saveSession(session);
    await setSessionArchived(session.id, true);
    await setSessionArchived(session.id, false);

    const readBack = await getSession(session.id);
    assert.equal(readBack?.archived, false);
    // A stale `archivedAt` would describe an archive that is not in force.
    assert.equal(readBack?.archivedAt, undefined);
  });

  await t.test("an unknown chat is reported as missing rather than created", async () => {
    assert.equal(await setSessionArchived("00000000-0000-4000-8000-000000000000", true), null);
  });

  await t.test("deleting still removes it outright", async () => {
    const session = createSession();
    await saveSession(session);
    assert.equal(await deleteSession(session.id), true);
    assert.equal(await getSession(session.id), null);
  });
});
