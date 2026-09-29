/**
 * OnTrak Tix M6 tests: the versioned public API, its tokens and its rate limits.
 *
 * The API is the first surface something that is not a person reaches, so each
 * test follows one of the ways a bearer token gets to be more than it should:
 *
 *  1. a token that was revoked (or expired) still working;
 *  2. a token spending a scope it does not hold;
 *  3. a rate limit that admits one more request than it says it does, or refuses
 *     one fewer — an off-by-one here is a support ticket, not a rounding error;
 *  4. a secret that can be read back out of the database.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-public-api.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuditLog } from "../src/lib/audit-chain";
import { sha256Hex } from "../src/lib/ticket-store-prisma";
import { gate, apiJson } from "../src/lib/public-api-http";
import {
  API_TOKEN_PREFIX,
  apiPage,
  apiTokenUsable,
  bearerToken,
  looksLikeApiToken,
  pageResult,
  rateLimitDecision,
  rateLimitHeaders,
  rateWindow,
  scopeCovers,
  validateApiToken,
  type ApiScope,
} from "../src/lib/public-api-rules";
import { ApiTokenService, MemoryApiTokenStore, roleForScopes, type ApiIds } from "../src/lib/public-api-service";
import type { Actor } from "../src/lib/access-rules";

/* -------------------------------------------------------------------------- */
/*  A harness                                                                 */
/* -------------------------------------------------------------------------- */

const ADMIN: Actor = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" };
const CLOCK_START = Date.parse("2026-09-30T10:00:00.000Z");

function harness() {
  let clock = CLOCK_START;
  let n = 0;
  const ids: ApiIds = {
    id: () => `token-${++n}`,
    token: () => `${API_TOKEN_PREFIX}secret-${++n}-aaaaaaaaaaaaaaaaaaaaaaaa`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const audit = new AuditLog(sha256Hex);
  const store = new MemoryApiTokenStore();
  const service = new ApiTokenService(store, audit, ids, sha256Hex);
  return {
    service,
    store,
    audit,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    at: (iso: string) => {
      clock = Date.parse(iso);
    },
    nowMs: () => clock,
  };
}

async function issuedScopes(scopes: ApiScope[], rateLimitPerMinute?: number) {
  const h = harness();
  const created = await h.service.create(ADMIN, { name: "Monitoring", scopes, rateLimitPerMinute });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  return { ...h, token: created.value.token, secret: created.value.secret };
}

function headers(values: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

/* -------------------------------------------------------------------------- */
/*  Rules                                                                     */
/* -------------------------------------------------------------------------- */

test("a token is only issued with a name, real scopes and a sane limit", () => {
  assert.deepEqual(validateApiToken({ name: "Zabbix", scopes: ["tickets:read"] }), []);
  assert.equal(validateApiToken({ name: "", scopes: ["tickets:read"] }).length, 1);
  assert.equal(validateApiToken({ name: "x", scopes: [] }).length, 1);
  // A scope this API does not issue is refused, not ignored: ignoring it would
  // hand back a token that looks like it can do something it cannot.
  assert.equal(validateApiToken({ name: "x", scopes: ["tickets:read", "admin:everything"] }).length, 1);
  assert.equal(validateApiToken({ name: "x", scopes: ["tickets:read", "tickets:read"] }).length, 1);
  assert.equal(validateApiToken({ name: "x", scopes: ["tickets:read"], expiresInDays: 0 }).length, 1);
  assert.equal(validateApiToken({ name: "x", scopes: ["tickets:read"], expiresInDays: 731 }).length, 1);
  assert.equal(validateApiToken({ name: "x", scopes: ["tickets:read"], rateLimitPerMinute: 0 }).length, 1);
  assert.equal(validateApiToken({ name: "x", scopes: ["tickets:read"], rateLimitPerMinute: 6_001 }).length, 1);
  // The expiry is optional, and "no expiry" is a real choice somebody makes.
  assert.deepEqual(validateApiToken({ name: "x", scopes: ["tickets:read"], expiresInDays: null }), []);
});

test("a revoked token stays revoked and an expired one stops", () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");
  assert.equal(apiTokenUsable({ revokedAt: null, expiresAt: null }, now).ok, true);
  assert.equal(apiTokenUsable({ revokedAt: null, expiresAt: new Date(now + 1000).toISOString() }, now).ok, true);

  const revoked = apiTokenUsable({ revokedAt: "2026-09-30T11:00:00.000Z", expiresAt: null }, now);
  assert.equal(revoked.ok, false);
  // Revocation beats a still-valid expiry: the desk's decision outranks the clock.
  assert.match(revoked.ok === false ? revoked.reason : "", /revoked/);

  const expired = apiTokenUsable({ revokedAt: null, expiresAt: new Date(now).toISOString() }, now);
  assert.equal(expired.ok, false);
  assert.match(expired.ok === false ? expired.reason : "", /expired/);
});

test("only our shape of token is looked up, and only from an Authorization header", () => {
  assert.equal(bearerToken(headers({ authorization: "Bearer tx1_abcdefghijklmnopqrstuvwxyz" })), "tx1_abcdefghijklmnopqrstuvwxyz");
  assert.equal(bearerToken(headers({ Authorization: "bearer   spaced  " })), "spaced");
  assert.equal(bearerToken(headers({ authorization: "Basic dXNlcjpwYXNz" })), null);
  assert.equal(bearerToken(headers({})), null);

  // The prefix check happens before any query, so a random string cannot be used
  // to make the API hit the database.
  assert.equal(looksLikeApiToken("tx1_abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(looksLikeApiToken("tx1_short"), false);
  // Another provider's key shape is not ours either. Assembled rather than
  // written out, so the repository contains no key-shaped literal that a
  // scanner — ours or a host's — has to be talked out of red-flagging.
  assert.equal(looksLikeApiToken(`sk_${"live"}_abcdefghijklmnopqrstuvwxyz`), false);
});

test("scopes are a closed set and cover exactly what they name", () => {
  assert.equal(scopeCovers(["tickets:read"], "tickets:read"), true);
  assert.equal(scopeCovers(["tickets:read"], "tickets:write"), false);
  assert.equal(scopeCovers(["tickets:write", "tickets:read"], "tickets:read"), true);
  assert.equal(scopeCovers([], "tickets:read"), false);
  // The role is a floor under the scope, never above it: a token with only
  // ticket scopes can never be more than an agent.
  assert.equal(roleForScopes(["tickets:write"]), "AGENT");
  assert.equal(roleForScopes(["tickets:read"]), "AGENT");
  assert.equal(roleForScopes(["webhooks:manage"]), "REQUESTER");
});

test("the rate limit admits exactly what it says, and the last request is the limit", () => {
  // 10:00:30 falls in the window that starts at 10:00:00.
  const nowMs = Date.parse("2026-09-30T10:00:30.000Z");
  const window = rateWindow(nowMs);
  assert.equal(new Date(window.startMs).toISOString(), "2026-09-30T10:00:00.000Z");
  assert.equal(new Date(window.resetMs).toISOString(), "2026-09-30T10:01:00.000Z");

  const decision = (count: number) => rateLimitDecision({ limit: 3, windowStartMs: window.startMs, count, nowMs });

  assert.equal(decision(1).allowed, true);
  assert.equal(decision(3).allowed, true, "the third request of a limit of three is allowed");
  assert.equal(decision(3).remaining, 0);
  assert.equal(decision(4).allowed, false, "the fourth is the one that is refused");
  assert.equal(decision(4).remaining, 0, "remaining never goes negative");
  assert.equal(decision(4).retryAfterSeconds, 30, "retry-after is the distance to the next window, not a guess");

  // A count left over from an earlier window cannot spend this one.
  const stale = rateLimitDecision({ limit: 3, windowStartMs: window.startMs - 60_000, count: 99, nowMs });
  assert.equal(stale.allowed, true);
  assert.equal(stale.remaining, 2);

  const refused = rateLimitHeaders(decision(4));
  assert.equal(refused["ratelimit-limit"], "3");
  assert.equal(refused["ratelimit-remaining"], "0");
  assert.equal(refused["ratelimit-reset"], String(window.resetMs / 1000));
  assert.equal(refused["retry-after"], "30");
  // An answer that succeeded must not carry Retry-After: it would be a lie about
  // what the client should do next.
  assert.equal(rateLimitHeaders(decision(1))["retry-after"], undefined);
});

test("a page is a limit and a cursor, and the cursor comes from the data", () => {
  assert.deepEqual(apiPage(new URLSearchParams("limit=10")), { limit: 10, cursor: null });
  assert.deepEqual(apiPage(new URLSearchParams("limit=10000&cursor=abc")), { limit: 100, cursor: "abc" });
  assert.deepEqual(apiPage(new URLSearchParams("limit=nonsense")), { limit: 25, cursor: null });

  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `${index}` }));
  const full = pageResult(rows(4), { limit: 3, cursor: null });
  assert.deepEqual(full.data.map((row) => row.id), ["0", "1", "2"]);
  assert.equal(full.nextCursor, "2", "the last row of the page is the cursor for the next one");

  const last = pageResult(rows(3), { limit: 3, cursor: null });
  assert.equal(last.nextCursor, null, "no extra row means no next page");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("a minted token's secret is returned once and stored only as a hash", async () => {
  const created = await issuedScopes(["tickets:read"]);
  assert.match(created.secret, /^tx1_/);

  // The row keeps the digest and a short prefix, and nothing else.
  assert.equal(created.token.tokenHash, sha256Hex(created.secret));
  assert.equal(created.token.tokenHash === created.secret, false);
  assert.ok(created.secret.startsWith(created.token.tokenPrefix));
  assert.ok(created.token.tokenPrefix.length < created.secret.length);

  const listed = await created.service.list(ADMIN);
  assert.equal(listed.ok, true);
  assert.equal(listed.ok && JSON.stringify(listed.value).includes(created.secret), false, "listing never returns a secret");

  const actions = created.audit.snapshot().events.map((event) => event.action);
  assert.deepEqual(actions, ["api.token.create"]);
  assert.equal(JSON.stringify(created.audit.snapshot()).includes(created.secret), false, "the chain never carries the secret");
});

test("minting and revoking need tenant:manage, and listing is scoped to the tenant", async () => {
  const h = harness();
  const agent: Actor = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" };
  assert.equal((await h.service.create(agent, { name: "nope", scopes: ["tickets:read"] })).ok, false);
  assert.equal((await h.service.list(agent)).ok, false);

  const created = await h.service.create(ADMIN, { name: "Zabbix", scopes: ["tickets:read"] });
  assert.equal(created.ok, true);
  const other: Actor = { id: "admin-2", tenantId: "tenant-b", role: "ADMIN" };
  const listed = await h.service.list(other);
  assert.equal(listed.ok && listed.value.length, 0, "another tenant's tokens are not listed");
  if (created.ok) assert.equal((await h.service.revoke(other, created.value.token.id)).ok, false);
});

test("authentication refuses a revoked token, and says which reason only on the chain", async () => {
  const created = await issuedScopes(["tickets:read"]);
  const ok = await created.service.authenticate(created.secret);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value.tenantId, "tenant-a");
  assert.equal(ok.ok && ok.value.actor.role, "AGENT");

  const revoked = await created.service.revoke(ADMIN, created.token.id);
  assert.equal(revoked.ok, true);
  // Revoking twice is a success, because the second click is a person's second click.
  assert.equal((await created.service.revoke(ADMIN, created.token.id)).ok, true);

  const refused = await created.service.authenticate(created.secret);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.error : "", "A valid API token is required.");
  // The reason is recorded rather than returned: "somebody kept using a token we
  // revoked" is exactly the signal a leak produces.
  const actions = created.audit.snapshot().events.map((event) => event.action);
  assert.ok(actions.includes("api.token.refused"));
  assert.equal(refused.ok === false && /revoked/.test(refused.error), false, "the caller learns nothing about why");
});

test("an expired token is refused without spending its budget", async () => {
  const h = harness();
  const created = await h.service.create(ADMIN, { name: "Temp", scopes: ["tickets:read"], expiresInDays: 1, rateLimitPerMinute: 1 });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");

  h.advance(2 * 24 * 60 * 60);
  const refused = await h.service.authenticate(created.value.secret);
  assert.equal(refused.ok, false);

  const stored = await h.store.findToken("tenant-a", created.value.token.id);
  assert.equal(stored?.rateCount, 0, "a refused-by-expiry token is not counted against its window");
});

test("the rate limit is enforced across calls, and it is the window that resets it", async () => {
  const created = await issuedScopes(["tickets:read"], 3);

  for (let index = 1; index <= 3; index += 1) {
    const call = await created.service.authenticate(created.secret);
    assert.equal(call.ok, true, `call ${index} is inside the limit`);
    assert.equal(call.ok && call.value.rate.allowed, true);
    assert.equal(call.ok && call.value.rate.remaining, 3 - index);
  }

  const refused = await created.service.authenticate(created.secret);
  assert.equal(refused.ok, true, "the token is still valid");
  assert.equal(refused.ok && refused.value.rate.allowed, false, "it has simply asked too often");
  assert.equal(refused.ok && refused.value.rate.retryAfterSeconds > 0, true);

  // A new minute is a new window, and the count starts over.
  created.advance(60);
  const again = await created.service.authenticate(created.secret);
  assert.equal(again.ok && again.value.rate.allowed, true);
  assert.equal(again.ok && again.value.rate.remaining, 2);

  // A flood cannot make the stored number grow without bound: it stops at the
  // limit plus one, so refusing stays cheap.
  for (let index = 0; index < 20; index += 1) await created.service.authenticate(created.secret);
  const stored = await created.store.findToken("tenant-a", created.token.id);
  assert.equal(stored?.rateCount, 4);
  assert.notEqual(stored?.lastUsedAt, null, "the same write stamps last use");
});

/* -------------------------------------------------------------------------- */
/*  The gate                                                                  */
/* -------------------------------------------------------------------------- */

test("the gate answers 401, then 429, then 403 — and admits the scoped call", async () => {
  const created = await issuedScopes(["tickets:read"], 2);

  const missing = await gate({ headers: headers({}) }, created.service, "tickets:read");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false ? missing.response.status : 0, 401);
  assert.equal(missing.ok === false ? missing.response.headers["www-authenticate"] : "", "Bearer");

  const unknown = await gate({ headers: headers({ authorization: "Bearer tx1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) }, created.service, "tickets:read");
  assert.equal(unknown.ok === false ? unknown.response.status : 0, 401);

  const first = await gate({ headers: headers({ authorization: `Bearer ${created.secret}` }) }, created.service, "tickets:read");
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.caller.tenantId, "tenant-a");
  assert.equal(first.ok && first.caller.rate.remaining, 1);

  const second = await gate({ headers: headers({ authorization: `Bearer ${created.secret}` }) }, created.service, "tickets:read");
  assert.equal(second.ok, true);

  const third = await gate({ headers: headers({ authorization: `Bearer ${created.secret}` }) }, created.service, "tickets:read");
  assert.equal(third.ok, false, "the third call of a limit of two is refused");
  const limited = third.ok === false ? third.response : apiJson(200, {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"] !== undefined, true);
  assert.equal(JSON.parse(limited.body).error, "rate_limited");
});

test("a token without the scope is refused with the scope named", async () => {
  const created = await issuedScopes(["tickets:read"]);
  const result = await gate({ headers: headers({ authorization: `Bearer ${created.secret}` }) }, created.service, "tickets:write");
  assert.equal(result.ok, false);
  const response = result.ok === false ? result.response : apiJson(200, {});
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).error, "insufficient_scope");
  assert.match(JSON.parse(response.body).message, /tickets:write/);
});
