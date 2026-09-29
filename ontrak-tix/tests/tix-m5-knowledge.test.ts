/**
 * OnTrak Tix M5 tests: the knowledge base and the suggestions built from it.
 *
 * The storage is ordinary; what matters is that the *right* article is offered
 * to the *right* person, because a wrong suggestion is worse than none: it
 * teaches a requester to stop reading them. So these cover validation, the
 * scoring, the public/private boundary, and who may write an article — not the
 * row it lands in.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m5-knowledge.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  articleExcerpt,
  articleHazards,
  parseTags,
  searchTerms,
  suggestArticles,
  validateArticle,
  type KnowledgeArticle,
} from "../src/lib/knowledge-rules";
import { MemoryKnowledgeStore, KnowledgeService } from "../src/lib/knowledge-service";
import { toArticleRecord, type KnowledgeArticleRow } from "../src/lib/knowledge-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const TENANT = "tenant-a";
const AGENT = { id: "agent-1", tenantId: TENANT, role: "AGENT" as const };
const REQUESTER = { id: "user-1", tenantId: TENANT, role: "REQUESTER" as const };
const NOW = "2026-09-21T12:00:00.000Z";

function article(overrides: Partial<KnowledgeArticle> = {}): KnowledgeArticle {
  return {
    id: "kb-1",
    tenantId: TENANT,
    title: "Reset your password",
    body: "Use the forgot-password link on the sign-in screen.",
    visibility: "PUBLIC",
    tags: ["password", "login"],
    createdBy: "admin-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

function harness(seed: readonly KnowledgeArticle[] = []) {
  const store = new MemoryKnowledgeStore();
  for (const record of seed) void store.insertArticle(record);
  const audit = new AuditLog(sha256);
  let n = 0;
  const service = new KnowledgeService(store, audit, { id: () => `kb-${++n}`, now: () => NOW });
  return { service, store, audit, events: () => audit.snapshot().events };
}

/* -------------------------------------------------------------------------- */
/*  What an article may be                                                    */
/* -------------------------------------------------------------------------- */

test("an article needs a title, a body and a visibility", () => {
  assert.equal(validateArticle({ body: "x", visibility: "PUBLIC" })[0].field, "title");
  assert.equal(validateArticle({ title: "T", visibility: "PUBLIC" })[0].field, "body");
  assert.equal(validateArticle({ title: "T", body: "x" })[0].field, "visibility");
  assert.deepEqual(validateArticle({ title: "T", body: "x", visibility: "PUBLIC" }), []);
});

test("a tag is checked while somebody is looking at the form", () => {
  const bad = validateArticle({ title: "T", body: "x", visibility: "PUBLIC", tags: ["a,b;c"] });
  assert.match(bad[0].message, /is not a tag/);

  const many = validateArticle({
    title: "T",
    body: "x",
    visibility: "PUBLIC",
    tags: Array.from({ length: 20 }, (_, index) => `tag${index}`),
  });
  assert.match(many[0].message, /at most/);

  assert.deepEqual(parseTags("vpn, network ,, printing"), ["vpn", "network", "printing"]);
});

test("a tagless article is flagged, because finding it is the hard part", () => {
  assert.ok(articleHazards({ tags: [] }).some((hazard) => /no tags/.test(hazard)));
  assert.deepEqual(articleHazards({ tags: ["vpn"] }), []);
});

/* -------------------------------------------------------------------------- */
/*  Finding one                                                               */
/* -------------------------------------------------------------------------- */

test("a query is about its words: stopwords and stubs are dropped", () => {
  assert.deepEqual(searchTerms("the VPN is not working for me"), ["vpn", "working"]);
  assert.deepEqual(searchTerms("a b c"), []);
});

test("title beats tags beats body, and only matches are returned", () => {
  const titled = article({ id: "kb-title", title: "VPN disconnects", body: "…" });
  const tagged = article({ id: "kb-tag", title: "Remote access", tags: ["vpn"], body: "…" });
  const bodied = article({ id: "kb-body", title: "Remote access", tags: [], body: "The vpn client…" });
  const unrelated = article({ id: "kb-none", title: "Printing", body: "Ink.", tags: [] });

  const results = suggestArticles([unrelated, bodied, tagged, titled], "vpn keeps dropping");

  assert.deepEqual(
    results.map((entry) => entry.article.id),
    ["kb-title", "kb-tag", "kb-body"],
    "most relevant first, and the unrelated article is absent",
  );
  assert.ok(results[0].score > results[1].score && results[1].score > results[2].score);
});

test("a private article is never suggested to a requester, but a staff search sees it", () => {
  const visible = article({ id: "kb-public", title: "VPN from home", visibility: "PUBLIC" });
  const internal = article({ id: "kb-private", title: "VPN concentrator runbook", visibility: "PRIVATE" });

  const publicResults = suggestArticles([visible, internal], "vpn", { includePrivate: false });
  assert.deepEqual(publicResults.map((entry) => entry.article.id), ["kb-public"]);

  const staffResults = suggestArticles([visible, internal], "vpn", { includePrivate: true });
  assert.deepEqual(staffResults.map((entry) => entry.article.id).sort(), ["kb-private", "kb-public"]);
});

test("an empty or irrelevant query suggests nothing rather than everything", () => {
  assert.deepEqual(suggestArticles([article()], "the a of"), []);
  assert.deepEqual(suggestArticles([article()], "printer jam"), []);
});

test("a suggestion can be read in place, but not as an essay", () => {
  assert.equal(articleExcerpt("short body"), "short body");
  const long = articleExcerpt("x".repeat(400), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("…"));
});

/* -------------------------------------------------------------------------- */
/*  Who may write one                                                         */
/* -------------------------------------------------------------------------- */

test("writing an article is a staff act; reading the library is not a requester's", async () => {
  const h = harness();

  const denied = await h.service.create(REQUESTER, { title: "T", body: "x", visibility: "PUBLIC" });
  assert.equal(denied.ok, false);

  const created = await h.service.create(AGENT, { title: "T", body: "x", visibility: "PRIVATE" });
  assert.ok(created.ok);

  assert.equal((await h.service.list(REQUESTER)).ok, false);
  assert.ok((await h.service.list(AGENT)).ok);
});

test("two articles cannot share a title, whatever the case", async () => {
  const h = harness();
  unwrap(await h.service.create(AGENT, { title: "Reset your password", body: "x", visibility: "PUBLIC" }));
  const clash = await h.service.create(AGENT, { title: "reset YOUR password", body: "y", visibility: "PUBLIC" });
  assert.equal(clash.ok, false);
});

test("publishing is its own event, not an ordinary edit", async () => {
  const h = harness();
  const created = unwrap(await h.service.create(AGENT, { title: "VPN", body: "x", visibility: "PRIVATE" }));
  unwrap(await h.service.update(AGENT, created.id, { visibility: "PUBLIC" }));
  unwrap(await h.service.update(AGENT, created.id, { body: "y" }));
  unwrap(await h.service.remove(AGENT, created.id));

  assert.deepEqual(h.events().map((event) => event.action), [
    "knowledge.create",
    "knowledge.publish",
    "knowledge.update",
    "knowledge.remove",
  ]);
  assert.equal(h.audit.verify().ok, true);
});

test("a public article is published on creation, because it is readable at once", async () => {
  const h = harness();
  unwrap(await h.service.create(AGENT, { title: "VPN", body: "x", visibility: "PUBLIC" }));
  assert.equal(h.events()[0].action, "knowledge.publish");
});

/* -------------------------------------------------------------------------- */
/*  Scoping and the store                                                     */
/* -------------------------------------------------------------------------- */

test("a suggestion path carries the visibility rule, not the caller", async () => {
  const h = harness([
    article({ id: "kb-public", title: "VPN from home", visibility: "PUBLIC" }),
    article({ id: "kb-private", title: "VPN concentrator runbook", visibility: "PRIVATE" }),
  ]);

  // A requester's path has no actor at all, and still cannot see the private one.
  const publicResults = await h.service.suggestPublic(TENANT, "vpn");
  assert.deepEqual(publicResults.map((entry) => entry.article.id), ["kb-public"]);

  const staffResults = await h.service.suggestForStaff(AGENT, "vpn");
  assert.ok(staffResults.ok);
  assert.equal(staffResults.value.length, 2);

  assert.equal((await h.service.suggestForStaff(REQUESTER, "vpn")).ok, false);
});

test("another tenant's article is simply absent", async () => {
  const h = harness([article({ tenantId: "tenant-b" })]);
  assert.equal(unwrap(await h.service.list(AGENT)).length, 0);
  assert.equal(await h.service.find(TENANT, "kb-1"), null);
});

test("the Prisma row maps to a domain record, and an unknown visibility is safe", () => {
  const row: KnowledgeArticleRow = {
    id: "kb-1",
    tenantId: TENANT,
    title: "VPN from home",
    body: "Install the client.",
    visibility: "PUBLIC",
    tags: ["vpn", "remote"],
    createdBy: "admin-1",
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  const record = toArticleRecord(row);
  assert.equal(record.visibility, "PUBLIC");
  assert.equal(record.createdAt, NOW);
  assert.deepEqual(record.tags, ["vpn", "remote"]);

  // Anything that is not PUBLIC is private: the safe side of the boundary.
  assert.equal(toArticleRecord({ ...row, visibility: "SOMETHING_NEW" }).visibility, "PRIVATE");
});
