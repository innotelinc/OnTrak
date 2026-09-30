/**
 * OnTrak Sentinel S3 tests: who an alert may be handed to, and what the record keeps.
 *
 * The queue shipped with everything an operator needs to *read* an incident and nothing saying
 * who is holding it, so the working practice was "one alert at a time, by whoever gets there
 * first" — which is how two people acknowledge the same incident and neither investigates it.
 * What these tests pin is the set of answers that would let the field *look* implemented while
 * leaving that problem in place:
 *
 *  - **A machine account cannot own an incident, and neither can somebody who has been switched
 *    off.** The second is the quieter failure of the two: an alert assigned to a leaver still
 *    shows a name, so it is invisible to the "unassigned" queue and nobody ever picks it up.
 *    Offboarding already ends that person's sessions and revokes their tokens; this is the same
 *    fact one level out.
 *  - **The picker and the service are the same rule.** A page offering a name the service then
 *    refuses makes the refusal read as a bug in triage rather than as a rule about people, and
 *    sends the operator after the wrong problem. So the options are asserted to be exactly the
 *    identities the refusal accepts.
 *  - **Another organization's identity is absent, not forbidden** — the answer the spine gives
 *    everywhere else, and the only one a caller can act on without learning that the other
 *    tenant exists.
 *  - **The owner survives the mapper in both directions**, and clearing it is *written through*:
 *    an `undefined` that reaches Prisma as "leave it alone" would silently keep a name on an
 *    alert somebody deliberately gave back to the queue, and a row written before the columns
 *    existed has to read as unowned rather than as `undefined`.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { assignableIdentities, assignmentRefusal } from "../src/lib/alert-assignment-rules";
import { toAlertCreate, toAlertRecord, toAlertUpdate, type AlertRow } from "../src/lib/alert-store-prisma";
import type { IdentityRecord } from "../src/lib/identity-rules";

const AT = Date.parse("2026-10-31T09:00:00.000Z");
const AT_ISO = new Date(AT).toISOString();

function identity(over: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    id: "identity-1",
    organizationId: "org-1",
    identifier: "sam@acme.test",
    displayName: "Sam Reed",
    externalId: null,
    kind: "HUMAN",
    role: "AGENT",
    active: true,
    mfaEnrolled: true,
    createdAt: AT_ISO,
    updatedAt: AT_ISO,
    ...over,
  };
}

function alertRow(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    organizationId: "org-1",
    ruleId: "SG-SIG-001",
    ruleVersion: 1,
    ruleName: "Connection to a plaintext management service",
    severity: "HIGH",
    state: "NEW",
    dedupeKey: "SG-SIG-001@1|203.0.113.7|0",
    groupKey: "203.0.113.7",
    sourceAddress: "203.0.113.7",
    identityId: "identity-1",
    identityLabel: "sam@acme.test",
    device: null,
    asset: "web-01",
    firstSeenAt: new Date(AT),
    lastSeenAt: new Date(AT),
    occurrences: 3,
    evidence: [],
    threatIntel: [],
    note: null,
    assigneeId: null,
    assigneeLabel: null,
    assignedAt: null,
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    ...over,
  };
}

test("assignment: only an active human can be handed an alert, and each refusal says which it is", () => {
  assert.equal(assignmentRefusal(identity()), null, "an ordinary person is who the field is for");
  assert.match(
    assignmentRefusal(null) ?? "",
    /not an identity in this organization/,
    "another tenant's identity is absent rather than forbidden",
  );
  assert.match(assignmentRefusal(identity({ active: false })) ?? "", /deactivated/);
  assert.match(assignmentRefusal(identity({ kind: "SERVICE", identifier: "connector-bot" })) ?? "", /service identity/);

  // A switched-off connector is refused for the reason that matters most, and the wording says
  // so: an alert that *looks* owned is worse than one nobody has picked up yet.
  assert.match(assignmentRefusal(identity({ kind: "SERVICE", active: false })) ?? "", /deactivated/);
});

test("assignment: the picker is built from the refusal, so it cannot offer what the service rejects", () => {
  const roster = [
    identity({ id: "i-zoe", displayName: "Zoe", identifier: "zoe@acme.test" }),
    identity({
      id: "i-bot",
      displayName: "Connector Bot",
      identifier: "connector-bot",
      kind: "SERVICE",
      role: "SERVICE",
    }),
    identity({ id: "i-leaver", displayName: "Lee Ver", identifier: "lee@acme.test", active: false }),
    identity({ id: "i-abe", displayName: "Abe", identifier: "abe@acme.test" }),
  ];

  const options = assignableIdentities(roster);
  assert.deepEqual(
    options.map((option) => option.label),
    ["Abe", "Zoe"],
    "sorted by name, because a picker is read by a person",
  );
  assert.equal(options.some((option) => option.id === "i-bot"), false, "a machine account cannot own an incident");
  assert.equal(options.some((option) => option.id === "i-leaver"), false, "and neither can somebody who has left");

  // The two statements are one statement: everything offered is something the rule accepts.
  for (const option of options) {
    const found = roster.find((entry) => entry.id === option.id) ?? null;
    assert.equal(assignmentRefusal(found), null, `${option.label} is offered but would be refused`);
  }

  // The identifier carries an identity created without a display name.
  assert.deepEqual(assignableIdentities([identity({ displayName: "" })]).map((option) => option.label), [
    "sam@acme.test",
  ]);
  assert.deepEqual(assignableIdentities([]), [], "a roster nobody can be drawn from is an empty picker");
});

test("assignment: the owner crosses the mapper in both directions, and clearing it is written through", () => {
  const row = alertRow({ assigneeId: "identity-1", assigneeLabel: "Sam Reed", assignedAt: new Date(AT) });
  const record = toAlertRecord(row);
  assert.equal(record.assigneeId, "identity-1");
  assert.equal(record.assigneeLabel, "Sam Reed");
  assert.equal(record.assignedAt, AT_ISO);

  // The create path carries it too, so an alert written with an owner keeps one.
  assert.equal(toAlertCreate(record).assigneeId, "identity-1");
  assert.equal(toAlertUpdate(record).assigneeId, "identity-1");
  assert.equal(toAlertUpdate(record).assignedAt?.toISOString(), AT_ISO);

  // Clearing it reaches the database as null rather than as an absent field. Prisma reads
  // `undefined` as "leave this column alone", which would keep a name on an alert somebody
  // deliberately gave back to the queue — the one thing this column is for.
  const cleared = toAlertUpdate({ ...record, assigneeId: null, assigneeLabel: null, assignedAt: null });
  assert.equal(cleared.assigneeId, null);
  assert.equal(cleared.assigneeLabel, null);
  assert.equal(cleared.assignedAt, null);
});

test("assignment: a row written before the columns existed reads as unowned, not as undefined", () => {
  // What a build that predates the migration hands to the mapper: the columns are simply not
  // there. `undefined` would reach the page as the string \"undefined\" on a row that is fine.
  const { assigneeId, assigneeLabel, assignedAt, ...legacy } = alertRow();
  assert.equal(assigneeId, null);
  assert.equal(assigneeLabel, null);
  assert.equal(assignedAt, null);

  const record = toAlertRecord(legacy as AlertRow);
  assert.equal(record.assigneeId, null);
  assert.equal(record.assigneeLabel, null);
  assert.equal(record.assignedAt, null);
});
