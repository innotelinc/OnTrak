/**
 * OnTrak Tix M4 tests: the rota, cover, and what changes hands.
 *
 * The value of a rota is that three questions stop being answered from memory —
 * who is on now, where nobody is on at all, and what the last person said. So the
 * tests are about the answers being derived from the shifts, and about the three
 * refusals that keep the answers honest: an overlapping window for one person, a
 * "shift" longer than a day, and a handoff with nothing written down.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m4-handoff.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  HANDOFF_MIN_NOTE,
  MAX_SHIFT_MINUTES,
  coverageAt,
  coverageGaps,
  coverageSummary,
  handoffDecision,
  outstandingFrom,
  rotaLoad,
  shiftConflict,
  shiftsOverlap,
  validateShift,
  type RotaShiftRecord,
} from "../src/lib/rota-rules";
import { MemoryRotaStore, RotaService } from "../src/lib/rota-service";
import { toHandoffRecord, toRotaShiftRecord, type HandoffRow, type RotaShiftRow } from "../src/lib/rota-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");
const ADMIN = { id: "admin-1", tenantId: "tenant-a", role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-a", role: "AGENT" as const };
const OTHER = { id: "agent-2", tenantId: "tenant-a", role: "AGENT" as const };
const REQUESTER = { id: "req-1", tenantId: "tenant-a", role: "REQUESTER" as const };
const NOW = "2026-09-20T12:00:00.000Z";

/** `2026-09-20T09:00:00.000Z` for a given day and hour. */
function at(day: number, hour: number): string {
  return `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function shift(overrides: Partial<RotaShiftRecord> = {}): RotaShiftRecord {
  return {
    id: "shift-1",
    tenantId: "tenant-a",
    queueId: null,
    userId: "agent-1",
    kind: "ON_CALL",
    startsAt: at(20, 9),
    endsAt: at(20, 17),
    note: null,
    createdBy: "admin-1",
    createdAt: NOW,
    ...overrides,
  };
}

let sequential = 0;

async function harness() {
  const audit = new AuditLog(sha256);
  const store = new MemoryRotaStore();
  const service = new RotaService(store, audit, { id: () => `rota-${++sequential}`, now: () => NOW });
  return { audit, store, service };
}

/* ------------------------------------------------------------------- the rules */

test("an overlapping window for the same person is a conflict, and a colleague is just a team", () => {
  const mine = shift({ id: "a", userId: "agent-1", startsAt: at(20, 9), endsAt: at(20, 17) });

  assert.equal(shiftsOverlap(mine, shift({ id: "b", startsAt: at(20, 16), endsAt: at(20, 20) })), true);
  // Touching ends are not an overlap: 17:00 handing over to 17:00 is a rota.
  assert.equal(shiftsOverlap(mine, shift({ id: "c", startsAt: at(20, 17), endsAt: at(20, 22) })), false);

  // Same person, same hours, different kind: still one person in two places.
  const clash = shiftConflict(
    { userId: "agent-1", startsAt: at(20, 12), endsAt: at(20, 14) },
    [mine, shift({ id: "other", userId: "agent-2", startsAt: at(20, 12), endsAt: at(20, 14) })],
  );
  assert.equal(clash?.id, "a");

  // A different person covering the same hours is not a conflict.
  assert.equal(
    shiftConflict({ userId: "agent-2", startsAt: at(20, 12), endsAt: at(20, 14) }, [mine]),
    null,
  );
});

test("a shift has to end after it starts, and cannot be an on-call week typed into one field", () => {
  assert.deepEqual(validateShift({ startsAt: at(20, 9), endsAt: at(20, 17) }), []);

  assert.match(validateShift({ startsAt: at(21, 9), endsAt: at(20, 17) })[0].message, /end after it starts/);
  assert.ok(validateShift({ startsAt: "", endsAt: at(20, 17) }).some((issue) => issue.field === "startsAt"));

  const week = validateShift({ startsAt: at(20, 0), endsAt: at(27, 0) });
  assert.match(week[0].message, new RegExp(`${MAX_SHIFT_MINUTES / 60} hours`));
});

test("cover right now is derived from the shifts, and names who to wake", () => {
  const shifts = [
    shift({ id: "work", userId: "agent-1", kind: "SHIFT", startsAt: at(20, 9), endsAt: at(20, 17) }),
    shift({ id: "call", userId: "agent-2", kind: "ON_CALL", startsAt: at(20, 0), endsAt: at(21, 0) }),
  ];

  const covered = coverageAt(shifts, at(20, 12));
  assert.equal(covered.covered, true);
  assert.deepEqual(covered.onCall.map((s) => s.userId), ["agent-2"]);
  assert.deepEqual(covered.reachable, ["agent-2", "agent-1"], "the pager comes first, then the desk");
  assert.match(coverageSummary(covered), /On call at .*agent-2/);

  // Working the desk is not cover at 03:00, and the summary says which it is.
  const nobody = coverageAt(shifts, at(21, 3));
  assert.equal(nobody.covered, false);
  assert.match(coverageSummary(nobody), /Nobody is on call/);
});

test("the gap list names the hours nobody holds the pager, and merges overlapping cover", () => {
  const shifts = [
    // Overlapping on-call windows: one handover, not a gap between two.
    shift({ id: "a", userId: "agent-1", startsAt: at(20, 9), endsAt: at(20, 18) }),
    shift({ id: "b", userId: "agent-2", startsAt: at(20, 16), endsAt: at(21, 9) }),
    // The 21st 09:00 → the 22nd 09:00 is uncovered on purpose.
    shift({ id: "c", userId: "agent-1", startsAt: at(22, 9), endsAt: at(22, 17) }),
    // Working hours do not count as cover overnight.
    shift({ id: "d", userId: "agent-2", kind: "SHIFT", startsAt: at(21, 9), endsAt: at(21, 17) }),
  ];

  const gaps = coverageGaps(shifts, at(20, 0), at(23, 0));
  assert.deepEqual(
    gaps.map((gap) => [gap.from, gap.to]),
    [
      [at(20, 0), at(20, 9)],
      [at(21, 9), at(22, 9)],
      [at(22, 17), at(23, 0)],
    ],
  );
  assert.equal(gaps[1].minutes, 24 * 60, "a day with nobody on call is a day, not a rounding");

  // A window with full cover reports nothing to fix.
  assert.deepEqual(coverageGaps([shift({ startsAt: at(20, 0), endsAt: at(21, 0) })], at(20, 0), at(21, 0)), []);
});

test("one name on every window is visible in the load, not just in the list", () => {
  const shifts = [
    shift({ id: "a", userId: "agent-1", startsAt: at(20, 0), endsAt: at(21, 0) }),
    shift({ id: "b", userId: "agent-1", startsAt: at(21, 0), endsAt: at(22, 0) }),
    shift({ id: "c", userId: "agent-2", startsAt: at(22, 0), endsAt: at(22, 6) }),
  ];

  const load = rotaLoad(shifts, at(20, 0), at(23, 0));
  assert.equal(load[0].userId, "agent-1");
  assert.equal(load[0].onCallMinutes, 48 * 60);
  assert.equal(load[0].overloaded, true, "more than half of the window's on-call hours");
  assert.equal(load[1].overloaded, false);
});

/* ------------------------------------------------------------------- the service */

test("publishing is a manager's act, double-booking is refused by name, and both ends are audited", async () => {
  const h = await harness();

  const denied = await h.service.addShift(AGENT, { userId: AGENT.id, startsAt: at(20, 9), endsAt: at(20, 17) });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.error, /publish the rota/);

  const first = await h.service.addShift(ADMIN, { userId: AGENT.id, startsAt: at(20, 9), endsAt: at(20, 17), note: "day cover" });
  assert.equal(first.ok, true);

  // The refusal names the shift it collides with, so somebody can act on it.
  const clash = await h.service.addShift(ADMIN, { userId: AGENT.id, startsAt: at(20, 16), endsAt: at(20, 20) });
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.match(clash.error, new RegExp(`${at(20, 9)} to ${at(20, 17)}`));

  // Somebody else at the same time is fine — that is a team.
  assert.equal((await h.service.addShift(ADMIN, { userId: OTHER.id, kind: "ON_CALL", startsAt: at(20, 16), endsAt: at(20, 20) })).ok, true);

  const removed = first.ok ? await h.service.removeShift(ADMIN, first.value.id) : null;
  assert.equal(removed?.ok, true);
  assert.equal((await h.service.removeShift(ADMIN, "made-up")).ok, false);

  const events = h.audit.snapshot().events.filter((event) => event.action.startsWith("rota."));
  assert.deepEqual(events.map((event) => event.action), ["rota.shift.add", "rota.shift.add", "rota.shift.remove"]);
  assert.equal(events[0].detail?.kind, "SHIFT");
});

test("a handoff needs somebody on duty and something written down, then survives as the record", async () => {
  const h = await harness();
  assert.equal((await h.service.addShift(ADMIN, { userId: AGENT.id, startsAt: at(20, 6), endsAt: at(20, 18) })).ok, true);

  // Not on duty, and not a manager: refused, and told who to hand over from.
  const notOnDuty = await h.service.recordHandoff(OTHER, { note: "nothing much happened today, honestly" });
  assert.equal(notOnDuty.ok, false);
  if (!notOnDuty.ok) assert.match(notOnDuty.error, new RegExp(AGENT.id));

  // On duty, but with nothing to say.
  const empty = await h.service.recordHandoff(AGENT, { note: "ok" });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /what the next person needs to know/);
  assert.ok(HANDOFF_MIN_NOTE > 2);

  const recorded = await h.service.recordHandoff(AGENT, {
    note: "Northwind's VPN ticket is waiting on their firewall vendor.",
    openTicketRefs: ["TIX-000123", "TIX-000123", "TIX-000131"],
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;

  assert.deepEqual(recorded.value.openTicketRefs, ["TIX-000123", "TIX-000131"], "references are deduped");
  assert.equal(recorded.value.fromUserId, AGENT.id);

  // A manager covering for somebody who went home is not a violation.
  assert.equal(
    (await h.service.recordHandoff(ADMIN, { note: "Covering the rest of the shift after the handover.", queueId: null })).ok,
    true,
  );

  const view = await h.service.view(ADMIN, { from: at(20, 0), to: at(21, 0) });
  assert.equal(view.ok, true);
  if (!view.ok) return;
  assert.equal(view.value.shifts.length, 1);
  // Both are on the page. Written in the same second, so the order between them
  // is insertion order rather than a meaningful "newest" — asserted as a set.
  assert.equal(view.value.handoffs.length, 2);
  assert.deepEqual(
    [...new Set(view.value.handoffs.map((handoff) => handoff.fromUserId))].sort(),
    ["admin-1", "agent-1"],
  );
  // Somebody is at the desk, but nobody holds the pager — the distinction the
  // coverage rules exist to make, and the reason `covered` is about on-call only.
  assert.equal(view.value.now.working.length, 1);
  assert.equal(view.value.now.covered, false);
  assert.ok(view.value.gaps.length > 0, "and the uncovered hours are named rather than implied");

  const events = h.audit.snapshot().events.filter((event) => event.action === "rota.handoff.record");
  assert.equal(events.length, 2);
  assert.equal(events[0].detail?.openTickets, 2, "the count is on the record, the references are on the row");
});

test("a handoff with no note is refused before anything is written", async () => {
  const h = await harness();
  const decision = handoffDecision({ actor: ADMIN, onDuty: [], onDutyNow: false, note: "  " });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /empty handoff/);

  // A requester does not hand work over at all, whatever the rota says.
  const requester = handoffDecision({ actor: REQUESTER, onDuty: [], onDutyNow: true, note: "a long enough note" });
  assert.equal(requester.allowed, false);

  // Handing to yourself is a no-op dressed as a handover.
  const toSelf = handoffDecision({ actor: AGENT, onDuty: [], onDutyNow: true, note: "a long enough note", toUserId: AGENT.id });
  assert.equal(toSelf.allowed, false);
});

test("the newest handoff is what the arriving shift inherits", () => {
  const handoffs = [
    {
      id: "h1",
      tenantId: "tenant-a",
      queueId: null,
      fromUserId: "agent-1",
      toUserId: "agent-2",
      note: "first",
      openTicketRefs: ["TIX-1", "TIX-2"],
      at: at(20, 9),
    },
    {
      id: "h2",
      tenantId: "tenant-a",
      queueId: null,
      fromUserId: "agent-2",
      toUserId: "agent-3",
      note: "second",
      openTicketRefs: ["TIX-2"],
      at: at(20, 17),
    },
  ];

  // TIX-1 did not survive the second handover: it was resolved or taken.
  assert.deepEqual(outstandingFrom(handoffs, ["TIX-1", "TIX-2", "TIX-3"]), ["TIX-2"]);
  assert.deepEqual(outstandingFrom([], ["TIX-1"]), [], "nothing written down means nothing inherited");
});

/* ------------------------------------------------------------------- the adapter */

test("the Prisma adapter keeps an overnight shift inside the window it straddles", async () => {
  const rows: RotaShiftRow[] = [
    {
      id: "shift-1",
      tenantId: "tenant-a",
      queueId: null,
      userId: "agent-1",
      kind: "ON_CALL",
      startsAt: new Date(at(20, 22)),
      endsAt: new Date(at(21, 6)),
      note: null,
      createdBy: "admin-1",
      createdAt: new Date(NOW),
    },
  ];

  const calls: unknown[] = [];
  const { PrismaRotaStore } = await import("../src/lib/rota-store-prisma");
  const store = new PrismaRotaStore({
    rotaShift: {
      findMany: async (args: unknown) => {
        calls.push(args);
        return rows;
      },
      findFirst: async () => rows[0],
      create: async () => rows[0],
      deleteMany: async () => ({ count: 1 }),
    },
    handoff: {
      findMany: async () => [],
      create: async () => ({}),
    },
  });

  const found = await store.listShifts("tenant-a", { from: at(21, 0), to: at(21, 12) });
  assert.equal(found.length, 1, "a shift that began the night before is still in this window");
  assert.equal(found[0].kind, "ON_CALL");

  const where = (calls[0] as { where: Record<string, unknown> }).where;
  assert.deepEqual(where.AND, [
    { startsAt: { lt: new Date(at(21, 12)) } },
    { endsAt: { gt: new Date(at(21, 0)) } },
  ]);

  const handoff = toHandoffRecord({
    id: "h1",
    tenantId: "tenant-a",
    queueId: null,
    fromUserId: "agent-1",
    toUserId: null,
    note: "note",
    openTicketRefs: ["TIX-1"],
    at: new Date(NOW),
  } satisfies HandoffRow);
  assert.equal(handoff.at, NOW);

  assert.equal(toRotaShiftRecord(rows[0]).startsAt, at(20, 22));
});
