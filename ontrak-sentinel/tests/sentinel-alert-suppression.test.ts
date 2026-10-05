/**
 * OnTrak Sentinel S4 tests: the mute — the windows in which a known detection is not raised.
 *
 * Delivery stops a raised alert going unheard; this stops a known one being raised at all, so
 * the cases are chosen around the ways a mute becomes a *detection gap* rather than a
 * maintenance window:
 *
 *  - **A mute has to name something.** An empty matcher would silence everything, so it is
 *    refused rather than accepted as "any" — the one rule a person creates by accident is the
 *    one that switches the detector off.
 *  - **A mute has to end,** and the window is capped, because a suppression with no end is a
 *    gap nobody remembers creating.
 *  - **A silence is recorded, not forgotten.** A suppressed detection lands on the evidence
 *    chain with the window that caught it, because an absence is indistinguishable from a rule
 *    that stopped firing.
 *  - **Outside its window a rule is inert,** and a window that has not begun does not mute.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { RecordingAlertNotifier } from "../src/lib/alert-notify";
import {
  MemorySuppressionStore,
  SuppressionService,
} from "../src/lib/alert-suppression-service";
import {
  SUPPRESSION_MAX_HOURS,
  activeSuppressions,
  describeMatcher,
  emptyMatcher,
  matchSuppression,
  normalizeMatcher,
  suppressionActive,
  suppressionIssue,
  suppressionMatches,
  type SuppressionRule,
} from "../src/lib/alert-suppression-rules";
import { DetectionService, MemoryAlertStore } from "../src/lib/detection-service";
import { DETECTION_RULES } from "../src/lib/detection-rules";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
} from "../src/lib/identity-service";

const sha256: HashFn = sha256Hex;
const AT = Date.parse("2026-11-01T09:00:00.000Z");
const ISO = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

function makeIds(tag: string, startMs: number) {
  let clock = startMs;
  let n = 0;
  return {
    id: () => `${tag}-${++n}`,
    now: () => ISO(clock),
    nowMs: () => clock,
    advance(ms: number) {
      clock += ms;
    },
  };
}

function rule(over: Partial<SuppressionRule> = {}): SuppressionRule {
  return {
    id: "sup_1",
    organizationId: "org_1",
    name: "patch window",
    matcher: { ...emptyMatcher(), ruleIds: ["SG-BEH-002"] },
    startsAt: ISO(AT),
    endsAt: ISO(AT + HOUR),
    createdById: "id_admin",
    createdByLabel: "Ana",
    createdAt: ISO(AT),
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

test("a mute has to name something, and has to end", () => {
  const window = { startsAt: ISO(AT), endsAt: ISO(AT + HOUR) };

  assert.match(
    String(suppressionIssue({ name: "  ", matcher: { ...emptyMatcher(), assets: ["a"] }, ...window })),
    /name/,
  );
  // The one rule a person makes by accident: it would silence every detection.
  assert.match(
    String(suppressionIssue({ name: "all", matcher: emptyMatcher(), ...window })),
    /name something/,
  );
  assert.match(
    String(suppressionIssue({ name: "x", matcher: { ...emptyMatcher(), assets: ["a"] }, startsAt: "nope", endsAt: ISO(AT + HOUR) })),
    /start/,
  );
  assert.match(
    String(suppressionIssue({ name: "x", matcher: { ...emptyMatcher(), assets: ["a"] }, startsAt: ISO(AT), endsAt: ISO(AT - 1) })),
    /end after/,
  );
  assert.match(
    String(
      suppressionIssue({
        name: "x",
        matcher: { ...emptyMatcher(), assets: ["a"] },
        startsAt: ISO(AT),
        endsAt: ISO(AT + (SUPPRESSION_MAX_HOURS + 1) * HOUR),
      }),
    ),
    /at most/,
  );

  // A week exactly is allowed; a blank entry in a list is dropped, not counted as a dimension.
  assert.equal(
    suppressionIssue({
      name: "x",
      matcher: { ...emptyMatcher(), assets: ["a"] },
      startsAt: ISO(AT),
      endsAt: ISO(AT + SUPPRESSION_MAX_HOURS * HOUR),
    }),
    null,
  );
  assert.equal(normalizeMatcher({ ...emptyMatcher(), assets: [" ", "a", "a"] }).assets.length, 1);
});

test("a window mutes inside itself, across every dimension it names", () => {
  const r = rule({
    matcher: { ...emptyMatcher(), ruleIds: ["SG-BEH-002"], sourceAddresses: ["203.0.113.0/24"] },
  });

  // Half-open: it covers its start and not its end, so two windows can meet without overlapping.
  assert.equal(suppressionActive(r, ISO(AT - 1)), false);
  assert.equal(suppressionActive(r, ISO(AT)), true);
  assert.equal(suppressionActive(r, ISO(AT + HOUR)), false);
  assert.deepEqual(activeSuppressions([r], ISO(AT)), [r]);
  assert.deepEqual(activeSuppressions([r], ISO(AT + HOUR)), []);

  const candidate = {
    ruleId: "SG-BEH-002",
    sourceAddress: "203.0.113.9",
    asset: null,
    device: null,
    identityId: null,
  };

  // A CIDR names a range, so the mute covers the /24 without enumerating it.
  assert.equal(suppressionMatches(r, candidate), true);
  // Dimensions are an AND: the right rule from the wrong address is not muted…
  assert.equal(suppressionMatches(r, { ...candidate, sourceAddress: "198.51.100.7" }), false);
  // …and neither is the right address from a different rule.
  assert.equal(suppressionMatches(r, { ...candidate, ruleId: "SG-SCAN-001" }), false);
  // A dimension that is empty means "any", but a missing value never matches a named one.
  const broad = rule({ matcher: { ...emptyMatcher(), assets: ["auth-service"] } });
  assert.equal(suppressionMatches(broad, { ...candidate, asset: "auth-service" }), true);
  assert.equal(suppressionMatches(broad, { ...candidate, asset: null }), false);

  assert.equal(matchSuppression(candidate, [r], ISO(AT))?.rule.id, "sup_1");
  assert.equal(matchSuppression(candidate, [r], ISO(AT + HOUR)), null, "outside the window it is inert");

  // The first match wins, so overlapping windows are decided by the list and not by a map.
  const first = rule({ id: "first" });
  const second = rule({ id: "second" });
  assert.equal(matchSuppression(candidate, [first, second], ISO(AT))?.rule.id, "first");

  assert.equal(describeMatcher(r.matcher), "rule SG-BEH-002 and address 203.0.113.0/24");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("the service stores a window, audits it, and removes it", async () => {
  const store = new MemorySuppressionStore();
  const audit = new OrganizationAuditLog(sha256);
  const service = new SuppressionService(store, audit, makeIds("s", AT));
  const by = { identityId: "id_admin", label: "Ana" };

  const added = await service.add(
    "org_1",
    {
      name: "Feb patch window",
      matcher: { ...emptyMatcher(), sourceAddresses: ["203.0.113.0/24"] },
      startsAt: ISO(AT),
      endsAt: ISO(AT + HOUR),
    },
    by,
  );
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.value.createdByLabel, "Ana");

  assert.equal((await service.list("org_1")).length, 1);
  assert.equal(
    audit.trail("org_1").filter((event) => event.action === "guard.suppression.created").length,
    1,
  );

  // An unusable draft is refused by name, and stores nothing.
  const bad = await service.add(
    "org_1",
    { name: "all", matcher: emptyMatcher(), startsAt: ISO(AT), endsAt: ISO(AT + 1000) },
    by,
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /name something/);
  assert.equal((await service.list("org_1")).length, 1);

  // The query the pipeline reads answers only what is in force.
  assert.equal((await service.activeSuppressions("org_1", AT)).length, 1);
  assert.equal((await service.activeSuppressions("org_1", AT + HOUR)).length, 0);

  const removed = await service.remove("org_1", added.value.id, by);
  assert.equal(removed.ok, true);
  assert.equal((await service.list("org_1")).length, 0);
  assert.equal(
    audit.trail("org_1").filter((event) => event.action === "guard.suppression.removed").length,
    1,
  );
  // Removing it twice is refused by name rather than silently succeeding — a second removal is
  // usually somebody looking at a stale page.
  assert.equal((await service.remove("org_1", added.value.id, by)).ok, false);
  // Another organization's windows are not this one's.
  assert.deepEqual(await service.list("org_2"), []);
});

/* -------------------------------------------------------------------------- */
/*  The pipeline                                                              */
/* -------------------------------------------------------------------------- */

async function pipelineHarness(notifier: RecordingAlertNotifier | null = null) {
  const audit = new OrganizationAuditLog(sha256);
  const entities = new MemoryIdentityStore();
  const store = new MemoryAlertStore();
  const ids = makeIds("p", AT);
  const spine = new IdentityService(entities, audit, ids);
  const suppressions = new SuppressionService(new MemorySuppressionStore(), audit, ids);
  // Positional, like the deployment's wiring: the feed and the transport have to be named to
  // reach the suppression source, which is deliberately last.
  const detection = new DetectionService(
    store,
    entities,
    audit,
    DETECTION_RULES,
    ids,
    sha256,
    null,
    notifier,
    suppressions,
  );

  const created = await spine.bootstrapOrganization(
    "test",
    { name: "Mute Inc", slug: "mute" },
    { identifier: "admin@mute.test", displayName: "Admin" },
  );
  assert.ok(created.ok, created.ok ? "" : created.error);
  const organizationId = created.value.organization.id;
  const actor: IdentityActor = { id: created.value.admin.id, organizationId, role: "ADMIN" };
  return { audit, detection, ids, suppressions, organizationId, actor };
}

const authEvent = (outcome: string, at: number, sourceAddress = "203.0.113.7") => ({
  kind: "AUTH",
  src_ip: sourceAddress,
  dst_ip: "10.0.0.5",
  dst_port: 443,
  timestamp: at,
  outcome,
  device: "idp-01",
  asset: "auth-service",
});

const credentialStuffing = () => [
  ...Array.from({ length: 5 }, (_, index) => authEvent("failure", AT + index * 1_000)),
  authEvent("success", AT + 6_000),
];

test("a muted detection is recorded on the chain and not raised", async () => {
  const h = await pipelineHarness();
  const added = await h.suppressions.add(
    h.organizationId,
    {
      name: "our scanner",
      matcher: { ...emptyMatcher(), sourceAddresses: ["203.0.113.7"] },
      startsAt: ISO(AT - 60_000),
      endsAt: ISO(AT + HOUR),
    },
    { identityId: h.actor.id, label: "Admin" },
  );
  assert.ok(added.ok, added.ok ? "" : added.error);

  const ingested = await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), {
    sensor: "idp-collector",
  });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);

  assert.equal(ingested.value.alerts.length, 0, "not raised");
  assert.equal(ingested.value.suppressed.length, 1);
  assert.equal(ingested.value.suppressed[0]?.ruleId, "SG-BEH-002");
  assert.equal(ingested.value.suppressed[0]?.name, "our scanner");

  const alerts = await h.detection.alerts(h.actor);
  assert.ok(alerts.ok, alerts.ok ? "" : alerts.error);
  assert.equal(alerts.value.length, 0, "nothing is in the queue");

  // Recorded rather than forgotten: a review can still see what was silenced, and by which
  // window — an absence would read as a rule that stopped firing.
  const rows = h.audit.trail(h.organizationId).filter((event) => event.action === "guard.detection.suppressed");
  assert.equal(rows.length, 1);
  const detail = rows[0]?.detail as { reason?: string; ruleId?: string };
  assert.equal(detail.ruleId, "SG-BEH-002");
  assert.match(String(detail.reason), /our scanner/);
});

test("a window that has not begun does not mute, and one that has ended does not either", async () => {
  const h = await pipelineHarness();
  await h.suppressions.add(
    h.organizationId,
    {
      name: "later",
      matcher: { ...emptyMatcher(), ruleIds: ["SG-BEH-002"] },
      startsAt: ISO(AT + 60_000),
      endsAt: ISO(AT + HOUR),
    },
    { identityId: h.actor.id, label: "Admin" },
  );

  const ingested = await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), {
    sensor: "idp-collector",
  });
  assert.ok(ingested.ok, ingested.ok ? "" : ingested.error);
  assert.equal(ingested.value.alerts.length, 1, "still raised");
  assert.equal(ingested.value.suppressed.length, 0);
  assert.equal(
    h.audit.trail(h.organizationId).filter((event) => event.action === "guard.detection.suppressed").length,
    0,
  );
});

test("a suppressed detection is not delivered, because it was never raised", async () => {
  const notifier = new RecordingAlertNotifier();
  const h = await pipelineHarness(notifier);
  await h.suppressions.add(
    h.organizationId,
    {
      name: "our scanner",
      matcher: { ...emptyMatcher(), sourceAddresses: ["203.0.113.7"] },
      startsAt: ISO(AT - 60_000),
      endsAt: ISO(AT + HOUR),
    },
    { identityId: h.actor.id, label: "Admin" },
  );

  await h.detection.ingest(h.organizationId, "SYSLOG", credentialStuffing(), { sensor: "idp-collector" });
  assert.equal(notifier.delivered.length, 0, "no alert, so nothing to tell anybody about");
});
