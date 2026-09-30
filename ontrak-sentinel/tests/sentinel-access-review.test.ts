/**
 * OnTrak Sentinel S2 tests: access reviews and scheduled attestation.
 *
 * The feature exists to answer a question provisioning cannot — *should these people
 * still have this access?* — and every way of getting it wrong is a way of answering
 * “yes” without anybody having looked:
 *
 *  1. an item nobody decided reads as approved (the default is `PENDING`, not `KEPT`);
 *  2. a review of nobody looks exactly like a review that passed;
 *  3. the list moves under the reviewer, so it can never be finished;
 *  4. a revocation is recorded but not carried out, and a leaver keeps signing in;
 *  5. a schedule that was missed opens thirty reviews and buries the one that matters.
 *
 * The success path is asserted down to the audit entries, because “who attested this,
 * and when?” is the only thing the record is for.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import {
  MAX_INTERVAL_DAYS,
  canClose,
  defaultDueAt,
  reviewProgress,
  reviewState,
  scheduleTick,
  validateReview,
  validateSchedule,
} from "../src/lib/access-review-rules";
import {
  AccessReviewService,
  MemoryAccessReviewStore,
  type AccessReviewIds,
  type OpenReviewInput,
} from "../src/lib/access-review-service";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import {
  MIN_SCHEDULER_INTERVAL_MS,
  accessReviewIntervalMs,
  startAccessReviewScheduler,
} from "../src/lib/access-review-scheduler";
import type { ScimService } from "../src/lib/scim-service";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole } from "../src/lib/console-http";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { MemoryMfaStore, MfaService } from "../src/lib/mfa-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;
const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;

function harness(groupMembers: Record<string, string[]> = {}) {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-09-30T09:00:00.000Z");
  let n = 0;
  const scope = `r${++seq}`;
  const ids: AccessReviewIds = {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const spine = new IdentityService(identities, audit, ids);
  const store = new MemoryAccessReviewStore(groupMembers);
  return {
    spine,
    identities,
    audit,
    store,
    ids,
    advanceDays: (days: number) => {
      clock += days * DAY_MS;
    },
    nowMs: () => clock,
  };
}

/** A `deprovisionForActor` that records being asked and can be told to refuse. */
function scimPort(outcome: { ok: boolean; error?: string } = { ok: true }) {
  const calls: { identityId: string; reason: string }[] = [];
  const port = {
    async deprovisionForActor(_actor: IdentityActor, identityId: string, reason: string) {
      calls.push({ identityId, reason });
      if (!outcome.ok) return { ok: false as const, error: outcome.error ?? "refused" };
      return { ok: true as const, value: { identity: { id: identityId } as never, sessionsEnded: 2 } };
    },
  } as unknown as Pick<ScimService, "deprovisionForActor">;
  return { calls, port };
}

/** A bootstrapped organization, an administrator, some people, and the service. */
async function ready(
  options: { groupMembers?: Record<string, string[]>; scim?: { ok: boolean; error?: string }; people?: string[] } = {},
) {
  const h = harness(options.groupMembers ?? {});
  const created = await h.spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `acme-${seq}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const admin: IdentityActor = {
    id: created.value.admin.id,
    organizationId: created.value.organization.id,
    role: "ADMIN",
  };

  const people: IdentityActor[] = [];
  for (const identifier of options.people ?? ["desk-1@acme.test", "desk-2@acme.test"]) {
    const made = await h.spine.createIdentity(admin, { identifier, displayName: identifier.split("@")[0] });
    assert.equal(made.ok, true, made.ok ? "" : made.error);
    if (!made.ok) throw new Error("unreachable");
    people.push({ id: made.value.id, organizationId: admin.organizationId, role: "AGENT" });
  }

  const scim = scimPort(options.scim ?? { ok: true });
  const service = new AccessReviewService(h.store, h.identities, scim.port, h.audit, h.ids);
  return { ...h, ...scim, admin, people, service, orgId: admin.organizationId };
}

type Ready = Awaited<ReturnType<typeof ready>>;

/** Open an organization-wide review of everybody, due in a fortnight. */
async function openReview(r: Ready, overrides: Partial<OpenReviewInput> = {}) {
  const opened = await r.service.open(r.admin, {
    name: "Quarter end",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: r.admin.id,
    ...overrides,
  });
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  if (!opened.ok) throw new Error("unreachable");
  return opened.value;
}

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

test("a review is refused until it says who, about whom and by when", () => {
  const now = Date.parse("2026-09-30T09:00:00.000Z");
  const good = {
    name: "Quarter end",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: "person-1",
    dueAtMs: now + DAY_MS,
  };
  assert.deepEqual(validateReview(good, now), []);

  assert.equal(validateReview({ ...good, name: "  " }, now).length, 1);
  assert.equal(validateReview({ ...good, scopeKind: "EVERYONE" }, now).length, 1);
  // A group review with no group would resolve to nobody — and a review of nobody is
  // indistinguishable from one that passed.
  assert.equal(validateReview({ ...good, scopeKind: "GROUP", scopeValue: "" }, now).length, 1);
  assert.deepEqual(validateReview({ ...good, scopeKind: "GROUP", scopeValue: "group-1" }, now), []);
  assert.equal(validateReview({ ...good, reviewerId: "" }, now).length, 1);
  // A deadline in the past means the review is late the moment it opens, so the lateness
  // signal stops meaning anything on day one.
  assert.equal(validateReview({ ...good, dueAtMs: now - 1 }, now).length, 1);
});

test("a schedule's interval is bounded, and an interval of zero is refused", () => {
  const now = Date.parse("2026-09-30T09:00:00.000Z");
  const good = {
    name: "Quarterly",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: "person-1",
    intervalDays: 90,
    firstRunAtMs: now,
  };
  assert.deepEqual(validateSchedule(good, now), []);

  // Zero would open a review on every tick: a denial of service written as a setting.
  assert.equal(validateSchedule({ ...good, intervalDays: 0 }, now).length, 1);
  assert.equal(validateSchedule({ ...good, intervalDays: -7 }, now).length, 1);
  assert.equal(validateSchedule({ ...good, intervalDays: 1.5 }, now).length, 1);
  assert.equal(validateSchedule({ ...good, intervalDays: MAX_INTERVAL_DAYS + 1 }, now).length, 1);
  assert.deepEqual(validateSchedule({ ...good, intervalDays: MAX_INTERVAL_DAYS }, now), []);
  assert.equal(validateSchedule({ ...good, reviewerId: "" }, now).length, 1);
});

test("being late is derived from the clock, and a finished review is not late", () => {
  const now = Date.parse("2026-09-30T09:00:00.000Z");
  assert.equal(reviewState("OPEN", now + DAY_MS, now), "OPEN");
  assert.equal(reviewState("OPEN", now - 1, now), "OVERDUE");
  // Reporting a completed review as overdue forever would bury the question a reader
  // actually has, which is whether it is finished.
  assert.equal(reviewState("COMPLETED", now - 1, now), "COMPLETED");
  assert.equal(reviewState("CANCELLED", now - 1, now), "CANCELLED");
});

test("an undecided item is not an approval, and an unknown value counts as undecided", () => {
  const progress = reviewProgress([
    { decision: "KEPT" },
    { decision: "REVOKED" },
    { decision: "PENDING" },
    // A row this code does not understand must never be counted as somebody having
    // approved it.
    { decision: "something-else" },
  ]);
  assert.deepEqual(progress, { total: 4, kept: 1, revoked: 1, pending: 2 });
});

test("a review can still be closed with items unattested, but not twice", () => {
  assert.equal(canClose("OPEN").ok, true);
  assert.equal(canClose("COMPLETED").ok, false);
  assert.equal(canClose("CANCELLED").ok, false);
});

test("a schedule that was missed by months opens one review, not thirty", () => {
  const next = Date.parse("2026-09-01T00:00:00.000Z");
  const now = Date.parse("2026-09-30T09:00:00.000Z");

  const tick = scheduleTick({ enabled: true, nextRunAtMs: next, intervalDays: 1 }, now);
  assert.equal(tick.open, true);
  // 30 days late on a daily interval: the count is reported, and it is not multiplied
  // into thirty reviews that would bury the one that matters.
  assert.equal(tick.missed, 30);
  // And the next slot is in the future, so a second tick in the same second does not
  // open a second review.
  assert.ok(tick.nextRunAtMs > now);
  assert.equal(scheduleTick({ enabled: true, nextRunAtMs: tick.nextRunAtMs, intervalDays: 1 }, now).open, false);

  assert.equal(scheduleTick({ enabled: true, nextRunAtMs: now + DAY_MS, intervalDays: 1 }, now).open, false);
  assert.equal(scheduleTick({ enabled: false, nextRunAtMs: now - DAY_MS, intervalDays: 1 }, now).open, false);
});

/* -------------------------------------------------------------------------- */
/*  Opening a review                                                          */
/* -------------------------------------------------------------------------- */

test("opening a review snapshots the roster, and every item starts undecided", async () => {
  const r = await ready({ people: ["a@acme.test", "b@acme.test", "c@acme.test"] });
  const view = await openReview(r);

  // The administrator is a person with access too, so they are on it: a review that
  // exempted its own author would be the first thing an auditor asks about.
  assert.equal(view.progress.total, 4);
  assert.equal(view.progress.pending, 4);
  assert.equal(view.progress.kept, 0);
  assert.equal(view.state, "OPEN");
  assert.ok(view.items.every((item) => item.decision === "PENDING"));
  assert.ok(view.items.every((item) => item.identity !== null), "the items name real people");

  const actions = r.audit.trail(r.orgId).map((event) => event.action);
  assert.ok(actions.includes("access.review.open"));
});

test("a scope that resolves to nobody is refused rather than opened empty", async () => {
  const r = await ready({ groupMembers: { "group-empty": [] } });
  const refused = await r.service.open(r.admin, {
    name: "Empty group",
    scopeKind: "GROUP",
    scopeValue: "group-empty",
    reviewerId: r.admin.id,
  });

  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /resolves to nobody/);
  // Nothing was written: an empty review in a list reads exactly like one that passed.
  assert.deepEqual(await r.service.reviews(r.admin).then((list) => list.ok && list.value.length), 0);
});

test("a group review covers the group's active members only", async () => {
  const r = await ready({ groupMembers: { "group-desk": [] } });
  // The group is seeded with the two agents, not the administrator.
  const desk = r.people.map((person) => person.id);
  const store = new MemoryAccessReviewStore({ "group-desk": desk });
  const service = new AccessReviewService(store, r.identities, scimPort().port, r.audit, r.ids);

  const opened = await service.open(r.admin, {
    name: "Desk access",
    scopeKind: "GROUP",
    scopeValue: "group-desk",
    reviewerId: r.admin.id,
  });
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  if (!opened.ok) throw new Error("unreachable");
  assert.equal(opened.value.progress.total, 2);
  assert.deepEqual(
    opened.value.items.map((item) => item.identityId).sort(),
    [...desk].sort(),
  );
});

test("a deactivated identity is not on the list", async () => {
  const r = await ready({ people: ["a@acme.test", "b@acme.test"] });
  const leaver = r.people[1];
  const off = await r.spine.setActive(r.admin, leaver.id, false);
  assert.equal(off.ok, true);

  const view = await openReview(r);
  // No access to attest to, and including them would make every review permanently
  // larger than the roster — which is how a review gets abandoned.
  assert.equal(view.progress.total, 2, "the administrator and the one active agent");
  assert.equal(view.items.some((item) => item.identityId === leaver.id), false);
});

test("the list is a snapshot: somebody added later is not on it", async () => {
  const r = await ready({ people: ["a@acme.test"] });
  const view = await openReview(r);
  assert.equal(view.progress.total, 2);

  const joiner = await r.spine.createIdentity(r.admin, { identifier: "new@acme.test", displayName: "New" });
  assert.equal(joiner.ok, true);

  // A list that grew when somebody was hired could never be finished — the reviewer
  // would be attesting to a moving population.
  const later = await r.service.view(r.admin, view.review.id);
  assert.equal(later.ok, true);
  assert.equal(later.ok && later.value.progress.total, 2);
  assert.equal(later.ok && later.value.items.some((item) => item.identityId === (joiner.ok ? joiner.value.id : "")), false);
});

test("opening and scheduling are administrator work; answering is the reviewer's", async () => {
  const r = await ready();
  const agent = r.people[0];

  const denied = await r.service.open(agent, {
    name: "Sneaky",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: agent.id,
  });
  assert.equal(denied.ok, false);
  assert.equal((await r.service.schedules(agent)).ok, false);
  assert.equal((await r.service.createSchedule(agent, { name: "X", scopeKind: "ORGANIZATION", reviewerId: agent.id })).ok, false);

  // A review assigned to somebody who does not exist, or to a leaver, is one nobody
  // could answer and nothing would say so.
  const unknown = await r.service.open(r.admin, {
    name: "Ghost",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: "not-a-person",
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok === false ? unknown.error : "", /not an identity/);
});

/* -------------------------------------------------------------------------- */
/*  Answering a review                                                        */
/* -------------------------------------------------------------------------- */

test("the reviewer's decision is recorded with who made it and when", async () => {
  const r = await ready({ people: ["a@acme.test"] });
  const view = await openReview(r);

  const subject = view.items[0];
  const attested = await r.service.attest(r.admin, view.review.id, subject.identityId, "KEPT", "still on the desk");
  assert.equal(attested.ok, true, attested.ok ? "" : attested.error);
  if (!attested.ok) throw new Error("unreachable");

  const item = attested.value.items.find((entry) => entry.identityId === subject.identityId);
  assert.equal(item?.decision, "KEPT");
  assert.equal(item?.decidedBy, r.admin.id);
  assert.equal(item?.note, "still on the desk");
  assert.ok(item?.decidedAt);
  assert.deepEqual(attested.value.progress, { total: 2, kept: 1, revoked: 0, pending: 1 });

  const entry = r.audit.trail(r.orgId).find((event) => event.action === "access.review.attest");
  assert.ok(entry, "the attestation is on the evidence chain");
  assert.equal((entry.detail as Record<string, unknown>).identityId, subject.identityId);
});

test("pending is a state, not a decision somebody can set", async () => {
  const r = await ready();
  const view = await openReview(r);
  const refused = await r.service.attest(r.admin, view.review.id, view.items[0].identityId, "PENDING");
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /before anybody answers/);

  const nonsense = await r.service.attest(r.admin, view.review.id, view.items[0].identityId, "APPROVED");
  assert.equal(nonsense.ok, false);
});

test("somebody who is not the reviewer cannot answer, and an administrator can", async () => {
  const r = await ready();
  // The administrator reviews, but a second administrator is the one who answers.
  const other = await r.spine.createIdentity(r.admin, { identifier: "second-admin@acme.test", displayName: "Second" });
  assert.equal(other.ok, true);
  if (!other.ok) throw new Error("unreachable");

  const view = await openReview(r, { reviewerId: other.value.id });
  const agent = r.people[0];
  const subject = view.items.find((item) => item.identityId === agent.id);
  assert.ok(subject);

  const denied = await r.service.attest(agent, view.review.id, subject.identityId, "KEPT");
  assert.equal(denied.ok, false);
  assert.match(denied.ok === false ? denied.error : "", /not the reviewer/);

  const allowed = await r.service.attest(r.admin, view.review.id, subject.identityId, "KEPT");
  assert.equal(allowed.ok, true, allowed.ok ? "" : allowed.error);
});

test("an identity that is not on the list cannot be attested, and a closed review takes no more answers", async () => {
  const r = await ready();
  const view = await openReview(r);
  const outsider = await r.spine.createIdentity(r.admin, { identifier: "outside@acme.test", displayName: "Outside" });
  assert.equal(outsider.ok, true);
  if (!outsider.ok) throw new Error("unreachable");

  const notOnList = await r.service.attest(r.admin, view.review.id, outsider.value.id, "KEPT");
  assert.equal(notOnList.ok, false);
  assert.match(notOnList.ok === false ? notOnList.error : "", /not on this review/);

  const closed = await r.service.close(r.admin, view.review.id);
  assert.equal(closed.ok, true, closed.ok ? "" : closed.error);

  const tooLate = await r.service.attest(r.admin, view.review.id, view.items[0].identityId, "KEPT");
  assert.equal(tooLate.ok, false);
  assert.match(tooLate.ok === false ? tooLate.error : "", /closed/);
});

test("a revocation is carried out through the deprovisioning path", async () => {
  const r = await ready();
  const view = await openReview(r);
  const subject = view.items.find((item) => item.identityId === r.people[0].id);
  assert.ok(subject);

  const revoked = await r.service.attest(r.admin, view.review.id, subject.identityId, "REVOKED", "handed their work over");
  assert.equal(revoked.ok, true, revoked.ok ? "" : revoked.error);

  // The decision goes through the same door a SCIM `active:false` uses — sessions and
  // tokens included — rather than inventing a second way to switch somebody off.
  assert.deepEqual(
    r.calls.map((call) => call.identityId),
    [subject.identityId],
  );
  assert.match(r.calls[0].reason, /no longer warranted/);
});

test("a revocation that cannot be carried out records nothing", async () => {
  const r = await ready({ scim: { ok: false, error: "the last administrator cannot be deactivated" } });
  const view = await openReview(r);
  const subject = view.items[0];

  const refused = await r.service.attest(r.admin, view.review.id, subject.identityId, "REVOKED");
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /last administrator/);

  // The important half: nothing was written, so the register never claims a person lost
  // access they still have.
  const after = await r.service.view(r.admin, view.review.id);
  assert.equal(after.ok && after.value.items.find((item) => item.identityId === subject.identityId)?.decision, "PENDING");
});

test("a deployment that cannot deprovision refuses a revocation rather than recording it", async () => {
  const r = await ready();
  const store = new MemoryAccessReviewStore();
  const service = new AccessReviewService(store, r.identities, null, r.audit, r.ids);

  const opened = await service.open(r.admin, {
    name: "No teeth",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: r.admin.id,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");

  const refused = await service.attest(r.admin, opened.value.review.id, opened.value.items[0].identityId, "REVOKED");
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.error : "", /cannot deprovision/);

  // A KEPT decision is still fine: only the destructive one needs the door.
  const kept = await service.attest(r.admin, opened.value.review.id, opened.value.items[0].identityId, "KEPT");
  assert.equal(kept.ok, true, kept.ok ? "" : kept.error);
});

/* -------------------------------------------------------------------------- */
/*  Closing                                                                   */
/* -------------------------------------------------------------------------- */

test("closing reports what was never attested", async () => {
  const r = await ready({ people: ["a@acme.test"] });
  const view = await openReview(r);
  const kept = await r.service.attest(r.admin, view.review.id, view.items[0].identityId, "KEPT");
  assert.equal(kept.ok, true);

  // Closing with an item still pending is allowed — see `canClose` — and the entry says
  // how many were never looked at, which is the number an auditor wants.
  const closed = await r.service.close(r.admin, view.review.id);
  assert.equal(closed.ok, true, closed.ok ? "" : closed.error);
  if (!closed.ok) throw new Error("unreachable");
  assert.equal(closed.value.review.status, "COMPLETED");
  assert.equal(closed.value.progress.pending, 1);

  const entry = r.audit.trail(r.orgId).find((event) => event.action === "access.review.close");
  assert.ok(entry);
  assert.deepEqual((entry.detail as Record<string, unknown>).unattested, 1);
  assert.deepEqual((entry.detail as Record<string, unknown>).kept, 1);

  assert.equal((await r.service.close(r.admin, view.review.id)).ok, false, "and it cannot be closed twice");
});

test("cancelling keeps the record of what was asked", async () => {
  const r = await ready();
  const view = await openReview(r);
  const cancelled = await r.service.cancel(r.admin, view.review.id);
  assert.equal(cancelled.ok, true, cancelled.ok ? "" : cancelled.error);
  assert.equal(cancelled.ok && cancelled.value.review.status, "CANCELLED");
  // The items survive: a review that was opened and abandoned is exactly what a register
  // is for.
  assert.equal(cancelled.ok && cancelled.value.items.length, view.items.length);
  assert.ok(r.audit.trail(r.orgId).some((event) => event.action === "access.review.cancel"));
});

/* -------------------------------------------------------------------------- */
/*  Scheduled attestation                                                     */
/* -------------------------------------------------------------------------- */

test("a due schedule opens its review, in the system's name and not a person's", async () => {
  const r = await ready();
  const created = await r.service.createSchedule(r.admin, {
    name: "Quarterly desk review",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: r.admin.id,
    intervalDays: 90,
    firstRunAtMs: r.nowMs() + DAY_MS,
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");

  // Nothing is due yet, so the tick is a no-op rather than an early review.
  assert.deepEqual((await r.service.tick(r.nowMs())).opened, []);

  r.advanceDays(2);
  const report = await r.service.tick(r.nowMs());
  assert.equal(report.opened.length, 1);
  assert.deepEqual(report.opened[0].missed, 1);

  const reviews = await r.service.reviews(r.admin);
  assert.equal(reviews.ok, true);
  assert.equal(reviews.ok && reviews.value.length, 1);
  assert.equal(reviews.ok && reviews.value[0].review.scheduleId, created.value.id);
  assert.ok(reviews.ok && reviews.value[0].review.name.startsWith("Quarterly desk review"));
  // Everybody active: the two agents and the administrator whose name is on it.
  assert.equal(reviews.ok && reviews.value[0].progress.total, 3);

  // The entry names the system, because an attestation nobody signed is the thing this
  // feature exists to prevent — the same is true of the review nobody asked for by name.
  const entry = r.audit.trail(r.orgId).find((event) => event.action === "access.review.open");
  assert.equal(entry?.actor, "system:access-review-scheduler");

  // And the schedule has moved on, so the next tick is quiet.
  assert.deepEqual((await r.service.tick(r.nowMs())).opened, []);
  const schedules = await r.service.schedules(r.admin);
  assert.equal(schedules.ok && schedules.value[0].lastRunAt !== null, true);
});

test("a schedule whose scope has emptied is skipped and still advances", async () => {
  const r = await ready({ groupMembers: { "group-gone": [] } });
  const store = new MemoryAccessReviewStore({ "group-gone": [] });
  const service = new AccessReviewService(store, r.identities, scimPort().port, r.audit, r.ids);

  const created = await service.createSchedule(r.admin, {
    name: "Group review",
    scopeKind: "GROUP",
    scopeValue: "group-gone",
    reviewerId: r.admin.id,
    intervalDays: 30,
    firstRunAtMs: r.nowMs(),
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");

  assert.deepEqual((await service.tick(r.nowMs())).opened, []);
  // Skipping without advancing would turn an empty group into a review every tick for
  // the rest of the deployment's life.
  const schedules = await service.schedules(r.admin);
  assert.equal(schedules.ok && Date.parse(schedules.value[0].nextRunAt) > r.nowMs(), true);
  assert.deepEqual((await service.tick(r.nowMs())).opened, []);
  assert.ok(r.audit.trail(r.orgId).some((event) => event.action === "access.review.schedule.empty"));
});

test("a paused schedule does not open anything, and resumes where it was", async () => {
  const r = await ready();
  const created = await r.service.createSchedule(r.admin, {
    name: "Monthly",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: r.admin.id,
    intervalDays: 30,
    firstRunAtMs: r.nowMs() + DAY_MS,
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");

  const paused = await r.service.setScheduleEnabled(r.admin, created.value.id, false);
  assert.equal(paused.ok, true, paused.ok ? "" : paused.error);
  assert.equal(paused.ok && paused.value.enabled, false);

  r.advanceDays(10);
  assert.deepEqual((await r.service.tick(r.nowMs())).opened, []);

  // Pausing does not move `nextRunAt`, so resuming does not silently skip a period —
  // the tick finds it due and opens one review, which is the point of `scheduleTick`.
  const resumed = await r.service.setScheduleEnabled(r.admin, created.value.id, true);
  assert.equal(resumed.ok && resumed.value.nextRunAt, created.value.nextRunAt);
  assert.equal((await r.service.tick(r.nowMs())).opened.length, 1);
});

test("a schedule is named once, and removing it keeps the reviews it opened", async () => {
  const r = await ready();
  const input = {
    name: "Annual",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: r.admin.id,
    intervalDays: 365,
    firstRunAtMs: r.nowMs() + DAY_MS,
  };
  const created = await r.service.createSchedule(r.admin, input);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");

  const clash = await r.service.createSchedule(r.admin, input);
  assert.equal(clash.ok, false);
  assert.match(clash.ok === false ? clash.error : "", /already exists/);

  r.advanceDays(2);
  assert.equal((await r.service.tick(r.nowMs())).opened.length, 1);

  const removed = await r.service.removeSchedule(r.admin, created.value.id);
  assert.equal(removed.ok, true, removed.ok ? "" : removed.error);
  assert.deepEqual(await r.service.schedules(r.admin).then((list) => list.ok && list.value.length), 0);

  // The review it opened is evidence and stays; the pointer to the schedule is what goes.
  const reviews = await r.service.reviews(r.admin);
  assert.equal(reviews.ok && reviews.value.length, 1);
  assert.equal(reviews.ok && reviews.value[0].review.scheduleId, created.value.id);
});

test("a default window gives a review a real deadline", () => {
  const now = Date.parse("2026-09-30T09:00:00.000Z");
  assert.ok(defaultDueAt(now) > now);
  assert.equal(defaultDueAt(now, 7), now + 7 * DAY_MS);
});

/* -------------------------------------------------------------------------- */
/*  The scheduler                                                             */
/* -------------------------------------------------------------------------- */

test("scheduled attestation is off until somebody turns it on", () => {
  // Off is the default on purpose: a tick opens reviews in every organization in the
  // deployment, so a product that did that uninvited on first boot would be writing
  // attestations nobody asked for.
  assert.equal(accessReviewIntervalMs({}), null);
  assert.equal(accessReviewIntervalMs({ SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES: "  " }), null);
  assert.equal(accessReviewIntervalMs({ SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES: "0" }), null);
  assert.equal(accessReviewIntervalMs({ SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES: "-60" }), null);
  assert.equal(accessReviewIntervalMs({ SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES: "often" }), null);

  assert.equal(accessReviewIntervalMs({ SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES: "60" }), 60 * 60_000);
  // A fractional minute means “as often as you can”, and the honest answer is the floor.
  assert.equal(accessReviewIntervalMs({ SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES: "0.1" }), MIN_SCHEDULER_INTERVAL_MS);
});

/** A `tick` that resolves when the test says so, and counts being called. */
function gatedTick() {
  const calls: number[] = [];
  let release: (report: { opened: never[] }) => void = () => {};
  let gate = new Promise<{ opened: never[] }>((resolve) => (release = resolve));
  const service = {
    async tick(nowMs: number) {
      calls.push(nowMs);
      return gate;
    },
  };
  return {
    calls,
    service,
    open() {
      release({ opened: [] });
      gate = new Promise<{ opened: never[] }>((resolve) => (release = resolve));
    },
  };
}

function quietLog() {
  const lines: string[] = [];
  return { lines, log: (message: string) => lines.push(message) };
}

test("a tick that is already running is skipped rather than stacked", async () => {
  const ticks = gatedTick();
  const log = quietLog();
  const scheduler = startAccessReviewScheduler(ticks.service, { intervalMs: 50_000, log: log.log, now: () => 1 });
  scheduler.stop();

  // Two passes at once: `tick` reads a due schedule and advances it afterwards, so a
  // second pass in flight could read the same row.
  const first = scheduler.runOnce();
  await scheduler.runOnce();
  assert.deepEqual(ticks.calls, [1]);
  assert.ok(log.lines.some((line) => /still running/.test(line)));

  ticks.open();
  await first;
  assert.deepEqual(ticks.calls, [1]);
});

test("a failed tick is reported and does not take the loop with it", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const scheduler = startAccessReviewScheduler(
    {
      async tick() {
        calls += 1;
        if (calls === 1) throw new Error("the database went away");
        return { opened: [] };
      },
    },
    { intervalMs: 50_000, log: () => {}, onError: (error) => errors.push(error) },
  );
  scheduler.stop();

  // The rejection must not escape: an unhandled one inside a timer ends the process, and
  // a deployment that lost its scheduler overnight has no way to say so.
  await scheduler.runOnce();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /database went away/);

  // And the next tick still happens.
  await scheduler.runOnce();
  assert.equal(calls, 2);
});

test("what a tick opened is said out loud, including how late it was", async () => {
  const log = quietLog();
  const scheduler = startAccessReviewScheduler(
    {
      async tick() {
        return {
          opened: [
            { scheduleId: "s-1", reviewId: "r-1", missed: 1 },
            { scheduleId: "s-2", reviewId: "r-2", missed: 4 },
          ],
        };
      },
    },
    { intervalMs: 50_000, log: log.log },
  );
  scheduler.stop();

  await scheduler.runOnce();
  const opened = log.lines.filter((line) => line.startsWith("opened "));
  assert.equal(opened.length, 2);
  assert.match(opened[0], /opened r-1 for schedule s-1$/);
  // The number of intervals a shutdown swallowed is worth knowing even though it is not
  // multiplied into reviews.
  assert.match(opened[1], /4 intervals late/);
});

/** A timer a test fires by hand, so the loop is exercised without waiting for a clock. */
function manualTimer() {
  const callbacks: (() => void)[] = [];
  let cleared = 0;
  return {
    callbacks,
    cleared: () => cleared,
    setTimer: (callback: () => void) => {
      callbacks.push(callback);
      return { unref: () => {} };
    },
    clearTimer: () => {
      cleared += 1;
    },
    /** Let the queued tick's promise settle. */
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("the loop ticks on its own, and stop() ends it", async () => {
  const timer = manualTimer();
  let calls = 0;
  const scheduler = startAccessReviewScheduler(
    {
      async tick() {
        calls += 1;
        return { opened: [] };
      },
    },
    { intervalMs: 60_000, log: () => {}, setTimer: timer.setTimer, clearTimer: timer.clearTimer },
  );

  // The loop is started, so the timer is armed and ticking is a matter of firing it.
  assert.equal(timer.callbacks.length, 1);
  timer.callbacks[0]();
  await timer.flush();
  timer.callbacks[0]();
  await timer.flush();
  assert.equal(calls, 2);

  scheduler.stop();
  assert.equal(timer.cleared(), 1, "stop clears the interval");
  assert.equal(calls, 2, "nothing ticks after stop");
  scheduler.stop();
});

/* -------------------------------------------------------------------------- */
/*  The console (S2)                                                          */
/* -------------------------------------------------------------------------- */

const CONSOLE_ORIGIN = "https://id.sentinel.test";

/**
 * A console over the same deployment, signed in as the administrator.
 *
 * The console is wired with the real spine and the real access-review service, so what the
 * routes render is what the product would render; the only stub is the WebAuthn slot this
 * deployment does not configure.
 */
async function consoleHarness(options: { people?: string[]; groupMembers?: Record<string, string[]>; scim?: { ok: boolean; error?: string } } = {}) {
  const r = await ready(options);
  assert.ok((await r.spine.setMfaEnrolled(r.admin, r.admin.id, true)).ok);
  const session = await r.spine.issueSession(r.admin.organizationId, r.admin.id);
  assert.equal(session.ok, true, session.ok ? "" : session.error);
  if (!session.ok) throw new Error("unreachable");

  const service = new ConsoleService(
    r.spine,
    new MfaService(new MemoryMfaStore(), r.spine),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    r.service,
  );
  return { ...r, sessionId: session.value.id, console: service };
}

function consoleRequest(
  method: string,
  path: string,
  options: { sessionId?: string | null; body?: string } = {},
): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  const cookies: Record<string, string> = {};
  if (options.sessionId) cookies[CONSOLE_SESSION_COOKIE] = options.sessionId;
  if (options.body) headers["content-type"] = "application/x-www-form-urlencoded";
  return { method, url: `${CONSOLE_ORIGIN}${path}`, headers, body: options.body, cookies };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

test("console: the register is behind a session, and a deployment with no review store says so", async () => {
  const h = await consoleHarness();

  const anonymous = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.reviews), h.console);
  assert.equal(anonymous.status, 303, "a register of attestations is not a public page");
  assert.equal(anonymous.headers.location, CONSOLE_PATHS.signIn);

  const bare = new ConsoleService(h.spine, new MfaService(new MemoryMfaStore(), h.spine));
  const refused = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.reviews, { sessionId: h.sessionId }), bare);
  assert.equal(refused.status, 400);
  assert.match(refused.body, /Access reviews are not available/);

  // A decision cannot be smuggled in as a read: the POST paths do not answer GET.
  const wrongVerb = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.reviewAttest, { sessionId: h.sessionId }), h.console);
  assert.equal(wrongVerb.status, 405);
  assert.equal(wrongVerb.headers.allow, "POST");
});

test("console: a review is opened, answered and closed, and a revocation is carried out", async () => {
  const h = await consoleHarness({ people: ["desk-1@acme.test", "desk-2@acme.test"] });
  const { sessionId, admin, people } = h;

  const opened = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewOpen, {
      sessionId,
      body: form({ name: "Quarter end", scopeKind: "ORGANIZATION", scopeValue: "", reviewerId: admin.id, windowDays: "14" }),
    }),
    h.console,
  );
  assert.equal(opened.status, 303, "opening a review is a state change, so it redirects");
  assert.match(String(opened.headers.location), /Opened%20Quarter%20end|Opened\+Quarter\+end/);

  const listed = await h.service.reviews(admin);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  const reviewId = listed.value[0]!.review.id;
  // Everybody active, the administrator included: a review that skipped the person who
  // opened it would be attesting to a subset nobody chose.
  assert.equal(listed.value[0]!.progress.pending, 3);

  const page = await routeConsole(consoleRequest("GET", `${CONSOLE_PATHS.reviews}?review=${encodeURIComponent(reviewId)}`, { sessionId }), h.console);
  assert.equal(page.status, 200);
  assert.match(page.body, /Quarter end/);
  assert.match(page.body, /never decided/);
  assert.match(page.body, />Keep</, "a decision that keeps access is offered");
  assert.match(page.body, />Revoke</, "and one that revokes it is beside it, not behind a menu");

  // Pending is what an item is before anybody answers it, not something to set.
  const pending = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewAttest, { sessionId, body: form({ reviewId, identityId: people[0]!.id, decision: "PENDING" }) }),
    h.console,
  );
  assert.equal(pending.status, 400);

  const kept = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewAttest, { sessionId, body: form({ reviewId, identityId: people[0]!.id, decision: "KEPT" }) }),
    h.console,
  );
  assert.equal(kept.status, 303);

  const revoked = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewAttest, { sessionId, body: form({ reviewId, identityId: people[1]!.id, decision: "REVOKED" }) }),
    h.console,
  );
  assert.equal(revoked.status, 303);
  assert.equal(h.calls.length, 1, "a revocation goes through the deprovisioning path");
  assert.equal(h.calls[0]!.identityId, people[1]!.id);
  assert.match(h.calls[0]!.reason, /no longer warranted/);

  const closed = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewClose, { sessionId, body: form({ reviewId }) }),
    h.console,
  );
  assert.equal(closed.status, 303);
  const after = await h.service.view(admin, reviewId);
  assert.ok(after.ok, after.ok ? "" : after.error);
  assert.equal(after.value.review.status, "COMPLETED");
  assert.equal(after.value.progress.kept, 1);
  assert.equal(after.value.progress.revoked, 1);
  assert.equal(after.value.progress.pending, 1, "closing does not turn an undecided item into a decision");
});

test("console: schedules are created, paused and removed, and the pause does not skip a period", async () => {
  const h = await consoleHarness();
  const { sessionId, admin } = h;

  const made = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewSchedule, {
      sessionId,
      body: form({ name: "Quarterly", scopeKind: "ORGANIZATION", scopeValue: "", reviewerId: admin.id, intervalDays: "90" }),
    }),
    h.console,
  );
  assert.equal(made.status, 303);

  const listed = await h.service.schedules(admin);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  const scheduleId = listed.value[0]!.id;
  const dueBefore = listed.value[0]!.nextRunAt;

  const paused = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewScheduleToggle, { sessionId, body: form({ scheduleId, enabled: "0" }) }),
    h.console,
  );
  assert.equal(paused.status, 303);
  const afterPause = await h.service.schedules(admin);
  assert.ok(afterPause.ok);
  assert.equal(afterPause.value[0]!.enabled, false);
  assert.equal(afterPause.value[0]!.nextRunAt, dueBefore, "pausing does not move the next run");

  const removed = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewScheduleRemove, { sessionId, body: form({ scheduleId }) }),
    h.console,
  );
  assert.equal(removed.status, 303);
  const left = await h.service.schedules(admin);
  assert.ok(left.ok);
  assert.equal(left.value.length, 0);
});

test("console: a reviewer who does not administer the register reaches only their review", async () => {
  const h = await consoleHarness({ people: ["desk-1@acme.test"] });
  const reviewer = h.people[0]!;

  // Somebody else opens a review with this person as its reviewer.
  assert.ok((await h.spine.setMfaEnrolled(h.admin, reviewer.id, true)).ok);
  const opened = await h.service.open(h.admin, {
    name: "Desk access",
    scopeKind: "ORGANIZATION",
    scopeValue: "",
    reviewerId: reviewer.id,
  });
  assert.ok(opened.ok, opened.ok ? "" : opened.error);
  if (!opened.ok) throw new Error("unreachable");
  const reviewId = opened.value.review.id;

  const session = await h.spine.issueSession(h.admin.organizationId, reviewer.id);
  assert.ok(session.ok, session.ok ? "" : session.error);
  if (!session.ok) throw new Error("unreachable");
  const theirs = session.value.id;

  // The register is administrators' work, and this reviewer is not one.
  const register = await routeConsole(consoleRequest("GET", CONSOLE_PATHS.reviews, { sessionId: theirs }), h.console);
  assert.equal(register.status, 403);

  // But the review they were named on is theirs to answer, and the page offers the decision.
  const page = await routeConsole(
    consoleRequest("GET", `${CONSOLE_PATHS.reviews}?review=${encodeURIComponent(reviewId)}`, { sessionId: theirs }),
    h.console,
  );
  assert.equal(page.status, 200);
  assert.match(page.body, />Keep</);
  assert.match(page.body, /Desk access/);

  const kept = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewAttest, { sessionId: theirs, body: form({ reviewId, identityId: reviewer.id, decision: "KEPT" }) }),
    h.console,
  );
  assert.equal(kept.status, 303, "an attestation names the person who made it, and they may");

  // Somebody who is neither an administrator nor the reviewer may not answer it at all.
  const bystander = await h.spine.createIdentity(h.admin, { identifier: "bystander@acme.test", displayName: "Bea" });
  assert.ok(bystander.ok, bystander.ok ? "" : bystander.error);
  if (!bystander.ok) throw new Error("unreachable");
  // Enrolled, so the only thing refusing them is the review's rule rather than the session policy.
  assert.ok((await h.spine.setMfaEnrolled(h.admin, bystander.value.id, true)).ok);
  const strangerSession = await h.spine.issueSession(h.admin.organizationId, bystander.value.id);
  assert.ok(strangerSession.ok, strangerSession.ok ? "" : strangerSession.error);
  if (!strangerSession.ok) throw new Error("unreachable");
  const refused = await routeConsole(
    consoleRequest("POST", CONSOLE_PATHS.reviewAttest, {
      sessionId: strangerSession.value.id,
      body: form({ reviewId, identityId: h.admin.id, decision: "KEPT" }),
    }),
    h.console,
  );
  assert.equal(refused.status, 400, "answering a review is the reviewer's, or an administrator's");
  assert.match(refused.body, /not the reviewer/);
});
