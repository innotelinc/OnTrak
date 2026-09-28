/**
 * OnTrak Sentinel S0 tests.
 *
 * Covers the hash-chained audit spine (append, verify, tamper detection) and the
 * pure identity/session rules. Run with:
 *
 *   npx tsx --test ontrak-sentinel/tests/sentinel.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  appendAuditEvent,
  AuditLog,
  createAuditChain,
  GENESIS_HASH,
  stableStringify,
  verifyAuditChain,
  type AuditEventInput,
} from "../src/lib/audit-chain";
import {
  canApproveEnforcement,
  DEFAULT_IDENTITY_POLICY,
  sessionDecision,
  type IdentitySummary,
} from "../src/lib/identity-rules";

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

function event(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    id: "evt-1",
    at: "2026-09-26T10:00:00.000Z",
    actor: "admin@ontrak.local",
    action: "identity.create",
    targetType: "identity",
    targetId: "usr_1",
    detail: { role: "AGENT" },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  The audit spine                                                           */
/* -------------------------------------------------------------------------- */

test("audit: the first record links to genesis and each record links to the last", () => {
  let chain = createAuditChain();
  chain = appendAuditEvent(chain, event({ id: "evt-1" }), sha256);
  chain = appendAuditEvent(chain, event({ id: "evt-2", action: "session.grant" }), sha256);

  assert.equal(chain.events[0].seq, 1);
  assert.equal(chain.events[0].prevHash, GENESIS_HASH);
  assert.equal(chain.events[1].seq, 2);
  assert.equal(chain.events[1].prevHash, chain.events[0].recordHash);
  assert.equal(chain.head, chain.events[1].recordHash);
  assert.match(chain.events[0].recordHash, /^[0-9a-f]{64}$/);
});

test("audit: a well-formed chain verifies", () => {
  const log = new AuditLog(sha256);
  log.append(event({ id: "evt-1" }));
  log.append(event({ id: "evt-2" }));
  log.append(event({ id: "evt-3" }));
  assert.deepEqual(log.verify(), { ok: true, length: 3 });
});

test("audit: appending returns a new chain and never mutates the old one", () => {
  const first = appendAuditEvent(createAuditChain(), event({ id: "evt-1" }), sha256);
  const second = appendAuditEvent(first, event({ id: "evt-2" }), sha256);

  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 2);
  assert.notEqual(first.head, second.head);
});

test("audit: editing a record's contents breaks verification at that position", () => {
  const log = new AuditLog(sha256);
  log.append(event({ id: "evt-1" }));
  log.append(event({ id: "evt-2" }));
  log.append(event({ id: "evt-3" }));

  const tampered = log.snapshot();
  tampered.events[1] = { ...tampered.events[1], detail: { role: "ADMIN" } };

  const result = verifyAuditChain(tampered, sha256);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.brokenAt, 2);
  assert.match(result.ok === false ? result.reason : "", /tampered/);
});

test("audit: deleting a middle record breaks the chain", () => {
  const log = new AuditLog(sha256);
  log.append(event({ id: "evt-1" }));
  log.append(event({ id: "evt-2" }));
  log.append(event({ id: "evt-3" }));

  const tampered = log.snapshot();
  tampered.events.splice(1, 1); // drop the second record

  const result = verifyAuditChain(tampered, sha256);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.brokenAt, 2);
});

test("audit: a forged head is detected even when the records are intact", () => {
  const log = new AuditLog(sha256);
  log.append(event({ id: "evt-1" }));

  const tampered = log.snapshot();
  tampered.head = sha256("something else");

  const result = verifyAuditChain(tampered, sha256);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /head/);
});

test("audit: hashing is order-independent so equal content yields equal records", () => {
  const a = appendAuditEvent(
    createAuditChain(),
    event({ detail: { role: "AGENT", site: "hq" } }),
    sha256,
  );
  const b = appendAuditEvent(
    createAuditChain(),
    event({ detail: { site: "hq", role: "AGENT" } }),
    sha256,
  );
  assert.equal(a.events[0].recordHash, b.events[0].recordHash);
});

test("audit: stableStringify sorts keys and drops undefined", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(stableStringify([1, undefined, 3]), "[1,null,3]");
});

/* -------------------------------------------------------------------------- */
/*  Identity rules                                                            */
/* -------------------------------------------------------------------------- */

function identity(overrides: Partial<IdentitySummary> = {}): IdentitySummary {
  return { id: "usr_1", role: "AGENT", active: true, mfaEnrolled: true, ...overrides };
}

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

test("identity: a healthy session is active", () => {
  const session = { issuedAt: NOW - 1000, lastSeenAt: NOW - 1000 };
  assert.deepEqual(sessionDecision(identity(), session, DEFAULT_IDENTITY_POLICY, NOW), { active: true });
});

test("identity: deactivated, revoked and MFA-less sessions are refused", () => {
  const fresh = { issuedAt: NOW - 1000, lastSeenAt: NOW - 1000 };
  assert.equal(sessionDecision(identity({ active: false }), fresh, DEFAULT_IDENTITY_POLICY, NOW).active, false);
  assert.equal(
    sessionDecision(identity(), { ...fresh, revokedAt: NOW - 500 }, DEFAULT_IDENTITY_POLICY, NOW).active,
    false,
  );
  assert.equal(
    sessionDecision(identity({ mfaEnrolled: false }), fresh, DEFAULT_IDENTITY_POLICY, NOW).active,
    false,
  );
});

test("identity: absolute lifetime and idle timeout both expire a session", () => {
  const policy = { requireMfa: false, maxSessionSeconds: 3600, idleTimeoutSeconds: 600 };
  assert.equal(
    sessionDecision(identity(), { issuedAt: NOW - 3601 * 1000, lastSeenAt: NOW }, policy, NOW).active,
    false,
  );
  assert.equal(
    sessionDecision(identity(), { issuedAt: NOW - 1000, lastSeenAt: NOW - 601 * 1000 }, policy, NOW).active,
    false,
  );
});

test("identity: only administrators may approve a prevention action", () => {
  assert.equal(canApproveEnforcement("ADMIN"), true);
  assert.equal(canApproveEnforcement("AGENT"), false);
  assert.equal(canApproveEnforcement("SERVICE"), false);
  assert.equal(canApproveEnforcement("AUDITOR"), false);
});
