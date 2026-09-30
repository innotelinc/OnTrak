/**
 * Rota service (M4): publishing cover, answering who is on, and recording the
 * handover.
 *
 * Three decisions, each of which is a desk's scar tissue:
 *
 *  - **The rota is written by whoever runs the desk, read by everyone.** Reading
 *    it is how an agent finds out they are on call; writing it is a management
 *    act (`queue:manage`). An agent cannot publish themselves cover, and cannot
 *    quietly remove a shift they do not fancy.
 *  - **Overlap is refused at the point of writing, and the refusal names the
 *    shift.** A double-booked agent discovers it at 03:00 otherwise.
 *  - **A handoff is recorded against the shift that is on now.** Not against the
 *    actor's memory of it: the service resolves the current coverage, and a
 *    handoff from somebody who is not on duty is refused unless they run the
 *    desk. That is what makes the handoff list a record rather than a diary.
 */

import { randomUUID } from "node:crypto";

import { actorHasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  coverageAt,
  coverageGaps,
  handoffDecision,
  rotaLoad,
  shiftConflict,
  validateHandoff,
  validateShift,
  type CoverageAt,
  type CoverageGap,
  type HandoffRecord,
  type RotaLoad,
  type RotaShiftRecord,
  type ShiftKind,
} from "./rota-rules";
import type { ServiceResult } from "./ticket-service";

export interface RotaStore {
  listShifts(tenantId: string, filters?: { from?: string; to?: string; userId?: string; queueId?: string | null }): Promise<RotaShiftRecord[]>;
  findShift(tenantId: string, shiftId: string): Promise<RotaShiftRecord | null>;
  insertShift(record: RotaShiftRecord): Promise<void>;
  removeShift(tenantId: string, shiftId: string): Promise<void>;

  listHandoffs(tenantId: string, filters?: { queueId?: string | null; limit?: number }): Promise<HandoffRecord[]>;
  insertHandoff(record: HandoffRecord): Promise<void>;
}

export interface RotaIds {
  id(): string;
  now(): string;
}

export function systemRotaIds(): RotaIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

export interface ShiftInput {
  userId: string;
  queueId?: string | null;
  kind?: ShiftKind;
  startsAt: string;
  endsAt: string;
  note?: string | null;
}

export interface HandoffInput {
  queueId?: string | null;
  toUserId?: string | null;
  note: string;
  openTicketRefs?: readonly string[];
}

/** What the rota page shows. */
export interface RotaView {
  from: string;
  to: string;
  queueId: string | null;
  shifts: RotaShiftRecord[];
  now: CoverageAt;
  gaps: CoverageGap[];
  load: RotaLoad[];
  handoffs: HandoffRecord[];
}

export class RotaService {
  constructor(
    private readonly store: RotaStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: RotaIds = systemRotaIds(),
  ) {}

  /* -------------------------------------------------------------- reading */

  async view(
    actor: Actor,
    input: { from: string; to: string; queueId?: string | null; at?: string },
  ): Promise<ServiceResult<RotaView>> {
    if (!actorHasPermission(actor, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to the rota." };
    }
    if (!input.from || !input.to || input.from > input.to) {
      return { ok: false, error: "Give the window as two dates, from and to." };
    }

    const queueId = input.queueId ?? null;
    const [shifts, handoffs] = await Promise.all([
      this.store.listShifts(actor.tenantId, { from: input.from, to: input.to, queueId }),
      this.store.listHandoffs(actor.tenantId, { queueId, limit: 25 }),
    ]);

    const now = input.at ?? this.ids.now();
    return {
      ok: true,
      value: {
        from: input.from,
        to: input.to,
        queueId,
        shifts,
        now: coverageAt(shifts, now, queueId),
        gaps: coverageGaps(shifts, input.from, input.to, queueId),
        load: rotaLoad(shifts, input.from, input.to),
        handoffs,
      },
    };
  }

  /* -------------------------------------------------------------- writing */

  async addShift(actor: Actor, input: ShiftInput): Promise<ServiceResult<RotaShiftRecord>> {
    if (!actorHasPermission(actor, "queue:manage")) {
      return { ok: false, error: "You do not publish the rota." };
    }
    if (!input.userId) return { ok: false, error: "Choose who is covering." };

    const issues = validateShift({ startsAt: input.startsAt, endsAt: input.endsAt, note: input.note ?? null });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const startsAt = new Date(input.startsAt).toISOString();
    const endsAt = new Date(input.endsAt).toISOString();

    // Collisions are checked against the whole rota, not just the visible
    // window: a shift that overlaps one published for next month is still a
    // double-booking, and the person it double-books would find out at 03:00.
    const existing = await this.store.listShifts(actor.tenantId, { userId: input.userId });
    const conflict = shiftConflict({ userId: input.userId, startsAt, endsAt }, existing);
    if (conflict) {
      return {
        ok: false,
        error: `${input.userId} is already on ${conflict.kind === "ON_CALL" ? "call" : "shift"} from ${conflict.startsAt} to ${conflict.endsAt}.`,
      };
    }

    const record: RotaShiftRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      queueId: input.queueId ?? null,
      userId: input.userId,
      kind: input.kind ?? "SHIFT",
      startsAt,
      endsAt,
      note: input.note?.trim() ? input.note.trim() : null,
      createdBy: actor.id,
      createdAt: this.ids.now(),
    };

    await this.store.insertShift(record);
    await this.append(actor, "rota.shift.add", "rota-shift", record.id, {
      userId: record.userId,
      queueId: record.queueId,
      kind: record.kind,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
    });
    return { ok: true, value: record };
  }

  async removeShift(actor: Actor, shiftId: string): Promise<ServiceResult<RotaShiftRecord>> {
    if (!actorHasPermission(actor, "queue:manage")) {
      return { ok: false, error: "You do not publish the rota." };
    }
    const shift = await this.store.findShift(actor.tenantId, shiftId);
    if (!shift) return { ok: false, error: "That shift is not on this desk's rota." };

    await this.store.removeShift(actor.tenantId, shiftId);
    await this.append(actor, "rota.shift.remove", "rota-shift", shiftId, {
      userId: shift.userId,
      kind: shift.kind,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
    });
    return { ok: true, value: shift };
  }

  /**
   * Record a handover. The shift on now is resolved here rather than trusted
   * from a form, so "who was on when this was written" is a fact on the record.
   */
  async recordHandoff(actor: Actor, input: HandoffInput): Promise<ServiceResult<HandoffRecord>> {
    const issues = validateHandoff({ note: input.note, openTicketRefs: input.openTicketRefs ?? [] });
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const queueId = input.queueId ?? null;
    const now = this.ids.now();
    const onDuty = await this.store.listShifts(actor.tenantId, { from: now, to: now, queueId });
    const coverage = coverageAt(onDuty, now, queueId);

    const decision = handoffDecision({
      actor,
      onDuty: [...onDuty].filter((shift) => shift.userId !== actor.id).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      onDutyNow: onDuty.some((shift) => shift.userId === actor.id),
      note: input.note,
      toUserId: input.toUserId ?? null,
    });
    if (!decision.allowed) return { ok: false, error: decision.reason };

    const record: HandoffRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      queueId,
      fromUserId: actor.id,
      toUserId: input.toUserId?.trim() ? input.toUserId.trim() : (coverage.reachable.find((id) => id !== actor.id) ?? null),
      note: input.note.trim(),
      openTicketRefs: [...new Set((input.openTicketRefs ?? []).map((ref) => ref.trim()).filter(Boolean))],
      at: now,
    };

    await this.store.insertHandoff(record);
    await this.append(actor, "rota.handoff.record", "handoff", record.id, {
      queueId: record.queueId,
      toUserId: record.toUserId,
      openTickets: record.openTicketRefs.length,
      noteChars: record.note.length,
    });
    return { ok: true, value: record };
  }

  private async append(actor: Actor, action: string, targetType: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.audit) return;
    const event: AuditEventInput = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      at: this.ids.now(),
      actor: actor.id,
      action,
      targetType,
      targetId,
      detail,
    };
    await this.audit.append(event);
  }
}

/** An in-memory store, used by tests and local development. */
export class MemoryRotaStore implements RotaStore {
  private readonly shifts = new Map<string, RotaShiftRecord>();
  private readonly handoffs = new Map<string, HandoffRecord>();

  async listShifts(
    tenantId: string,
    filters: { from?: string; to?: string; userId?: string; queueId?: string | null } = {},
  ): Promise<RotaShiftRecord[]> {
    return [...this.shifts.values()]
      .filter((shift) => shift.tenantId === tenantId)
      .filter((shift) => filters.userId === undefined || shift.userId === filters.userId)
      .filter((shift) => filters.queueId === undefined || shift.queueId === filters.queueId)
      .filter((shift) => filters.from === undefined || shift.endsAt > filters.from)
      .filter((shift) => filters.to === undefined || shift.startsAt < filters.to)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((shift) => structuredClone(shift));
  }

  async findShift(tenantId: string, shiftId: string): Promise<RotaShiftRecord | null> {
    const found = this.shifts.get(shiftId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async insertShift(record: RotaShiftRecord): Promise<void> {
    this.shifts.set(record.id, structuredClone(record));
  }

  async removeShift(tenantId: string, shiftId: string): Promise<void> {
    const found = this.shifts.get(shiftId);
    if (found && found.tenantId === tenantId) this.shifts.delete(shiftId);
  }

  async listHandoffs(tenantId: string, filters: { queueId?: string | null; limit?: number } = {}): Promise<HandoffRecord[]> {
    const rows = [...this.handoffs.values()]
      .filter((handoff) => handoff.tenantId === tenantId)
      .filter((handoff) => filters.queueId === undefined || handoff.queueId === filters.queueId)
      .sort((a, b) => b.at.localeCompare(a.at));
    return rows.slice(0, filters.limit ?? rows.length).map((handoff) => structuredClone(handoff));
  }

  async insertHandoff(record: HandoffRecord): Promise<void> {
    this.handoffs.set(record.id, structuredClone(record));
  }
}
