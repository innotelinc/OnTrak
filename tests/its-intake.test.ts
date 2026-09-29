/**
 * Accepting a practice scenario from the desk.
 *
 * The interesting cases are the refusals. A draft arrives over HTTP from another
 * product, so this end re-validates everything rather than trusting the desk that
 * wrote it, and a body with no steps has to be turned away — a draft an instructor
 * cannot turn into a scenario is a row that sits in the queue looking like work.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/its-intake.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bearerToken,
  readScenarioDraft,
  serviceTokenMatches,
} from "../src/lib/its-intake-rules";

const GOOD = {
  ticketRef: "TIX-000042",
  title: "Reissue an expired VPN certificate",
  summary: "A learner is handed a gateway whose certificate has lapsed.",
  description: "## Briefing\n\nThe VPN client refuses to connect.",
  engine: "bash",
  difficulty: "ADVANCED",
  objectives: ["Find the expired certificate", "Reissue and reload"],
  steps: [{ objective: "Confirm the expiry", actions: ["openssl x509 -noout -dates -in vpn.crt"], check: "In the past." }],
  tags: ["vpn", "pki"],
};

test("intake: a well-formed draft is read, and the ticket it came from is kept", () => {
  const parsed = readScenarioDraft(GOOD);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.sourceRef, "TIX-000042");
  assert.equal(parsed.value.source, "tix");
  assert.equal(parsed.value.engine, "bash");
  assert.equal(parsed.value.difficulty, "ADVANCED");
  assert.equal(parsed.value.steps.length, 1);
});

test("intake: the desk's own field name is accepted, and so is the plain one", () => {
  const parsed = readScenarioDraft({ ...GOOD, ticketRef: undefined, sourceRef: "TIX-000099" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.sourceRef, "TIX-000099");
});

test("intake: a draft with no steps, no title or a foreign engine is refused", () => {
  assert.equal(readScenarioDraft({ ...GOOD, steps: [] }).ok, false);
  assert.equal(readScenarioDraft({ ...GOOD, steps: [{ objective: "x", actions: [] }] }).ok, false);
  assert.equal(readScenarioDraft({ ...GOOD, title: "   " }).ok, false);
  assert.equal(readScenarioDraft({ ...GOOD, engine: "cobol" }).ok, false);
  assert.equal(readScenarioDraft({ ...GOOD, ticketRef: undefined, sourceRef: undefined }).ok, false);
  assert.equal(readScenarioDraft("not an object").ok, false);
  assert.equal(readScenarioDraft(null).ok, false);
  assert.equal(readScenarioDraft([GOOD]).ok, false);
});

test("intake: an unknown difficulty falls back rather than refusing the draft", () => {
  const parsed = readScenarioDraft({ ...GOOD, difficulty: "IMPOSSIBLE" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // A difficulty is a judgement an instructor can move; losing the whole draft over
  // it would be worse than defaulting and letting them set it.
  assert.equal(parsed.value.difficulty, "INTERMEDIATE");
});

test("intake: a missing description falls back to the summary", () => {
  const parsed = readScenarioDraft({ ...GOOD, description: undefined });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.description, GOOD.summary);
});

test("intake: the token comparison is exact, and a missing either side never matches", () => {
  assert.equal(serviceTokenMatches("s3cret", "s3cret"), true);
  assert.equal(serviceTokenMatches("s3cret", "s3cre"), false);
  assert.equal(serviceTokenMatches("s3cret", "s3cret2"), false);
  assert.equal(serviceTokenMatches("", "s3cret"), false);
  assert.equal(serviceTokenMatches(null, "s3cret"), false);
  assert.equal(serviceTokenMatches("s3cret", null), false);
  assert.equal(serviceTokenMatches("s3cret", ""), false);
});

test("intake: the bearer header is read the way a client sends it", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer  abc123  "), "abc123");
  assert.equal(bearerToken("Basic abc123"), null);
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken("Bearer "), null);
});
