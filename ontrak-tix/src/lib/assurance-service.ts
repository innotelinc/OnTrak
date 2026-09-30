/**
 * Assurance Packet service (M3): turn an incident's record into one signed,
 * self-contained document.
 *
 * This is the last mile of the M3 promise. Everything it needs already exists —
 * the incident's facts, its playbook, its evidence manifest, its custody trail
 * and its hash-chained audit log — and this service's job is to assemble them
 * honestly rather than to embellish them:
 *
 *  - the packet cites the **whole** audit chain's head and length, and attaches
 *    the chain's own verification result, so a reader can tell a packet that was
 *    cut from an intact chain from one that was not;
 *  - the export is written **to that chain**, carrying the packet's digest, so
 *    "this packet existed" is evidence too;
 *  - a broken chain does not throw and does not block the export — the packet
 *    says `verified: false`, which is the useful answer. Refusing to produce a
 *    record because the record is damaged would hide the damage.
 *
 * The manifest is generated first and the chain read after it, so the packet and
 * the audit excerpt always agree about what had already happened.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import { verifyAuditChain, type AuditChain, type AuditEventInput, type AuditSink, type HashFn } from "./audit-chain";
import {
  AUDIT_EXPORT_KIND,
  buildAuditChainPacket,
  type AuditChainPacket,
} from "./audit-export-rules";
import {
  ASSURANCE_PACKET_VERSION,
  buildAssurancePacket,
  type AssurancePacket,
  type AssurancePacketInput,
  type PacketAuditEntry,
  type SignFn,
} from "./assurance-rules";
import type { IncidentDocsService } from "./incident-docs-service";
import type { IncidentRecord, IncidentStore } from "./incident-service";
import { sha256Hex } from "./ticket-store-prisma";
import type { ServiceResult } from "./ticket-service";

/** Reads a tenant's persisted audit chain exactly as stored, verified or not. */
export interface AssuranceAuditReader {
  read(tenantId: string): Promise<AuditChain>;
}

export interface AssuranceDeps {
  incidents: IncidentStore;
  docs: IncidentDocsService;
  auditReader: AssuranceAuditReader;
  sign: SignFn;
  /** Where the export is recorded. Optional so a read-only tool can skip it. */
  audit?: AuditSink | null;
  hash?: HashFn;
  now?: () => string;
}

export class AssuranceService {
  private readonly hash: HashFn;
  private readonly now: () => string;

  constructor(private readonly deps: AssuranceDeps) {
    this.hash = deps.hash ?? sha256Hex;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Assemble a signed packet for one incident. Staff-only: this is the copy that
   * leaves the building, so who pulled it is recorded.
   */
  async packet(actor: Actor, incidentId: string): Promise<ServiceResult<AssurancePacket>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to incidents." };
    }

    const incident = await this.deps.incidents.findIncident(actor.tenantId, incidentId);
    if (!incident) return { ok: false, error: "Incident not found." };

    // The manifest first: it is part of the packet, and it writes its own audit
    // event, so the chain read below already accounts for it.
    const manifest = await this.deps.docs.manifest(actor.tenantId, incidentId);
    if (!manifest.ok) return { ok: false, error: manifest.error };

    // The manifest already carries the timeline, so the only extra read is the
    // chain the packet anchors to.
    const chain = await this.deps.auditReader.read(actor.tenantId);

    const check = verifyAuditChain(chain, this.hash);
    const excerpt: PacketAuditEntry[] = chain.events
      .filter((event) => event.targetId === incidentId)
      .map(({ seq, at, actor: by, action, recordHash }) => ({ seq, at, actor: by, action, recordHash }));

    const input: AssurancePacketInput = {
      manifest: manifest.value,
      audit: {
        head: chain.head,
        length: chain.events.length,
        verified: check.ok,
        // The export event lands one past the head this packet cites.
        exportSeq: chain.events.length + 1,
        excerpt,
      },
      generatedAt: this.now(),
    };

    const packet = buildAssurancePacket(input, this.hash, this.deps.sign);

    if (this.deps.audit) {
      await this.deps.audit.append(packetAudit(incident, actor.id, packet, this.now()));
    }
    return { ok: true, value: packet };
  }

  /**
   * The tenant's whole audit trail as a signed packet (M6).
   *
   * The incident packet is one incident's slice of the chain; this is the chain. It is
   * gated on `audit:read` rather than `ticket:read:any`, because "may read this desk's
   * tickets" and "may take away the record of everything anybody did here" are
   * different questions and only one of them is an administrative act.
   *
   * A chain that does not verify is exported **anyway**, with `verified: false` inside
   * the signed anchor. Withholding a broken trail would be refusing the evidence at the
   * exact moment it matters, and the one failure that must not happen — a broken chain
   * presented as sound — is impossible because the flag is inside what the signature
   * covers. The export itself is then an audited act like any other.
   */
  async auditExport(actor: Actor): Promise<ServiceResult<AuditChainPacket>> {
    if (!hasPermission(actor.role, "audit:read")) {
      return { ok: false, error: "You do not have access to the audit trail." };
    }

    const chain = await this.deps.auditReader.read(actor.tenantId);
    const check = verifyAuditChain(chain, this.hash);

    // Every entry, oldest first, reduced to the fields the packet states — the payload
    // detail is deliberately left behind: an export is a record of *what happened*, and
    // widening it to whatever each event happened to carry is how a token or a note
    // ends up in a document that leaves the building.
    const entries: PacketAuditEntry[] = chain.events.map(({ seq, at, actor: by, action, recordHash }) => ({
      seq,
      at,
      actor: by,
      action,
      recordHash,
    }));

    const packet = buildAuditChainPacket(
      {
        tenantId: actor.tenantId,
        entries,
        audit: {
          head: chain.head,
          length: chain.events.length,
          verified: check.ok,
          // The export event lands one past the head this packet cites.
          exportSeq: chain.events.length + 1,
        },
        generatedAt: this.now(),
      },
      this.hash,
      this.deps.sign,
    );

    if (this.deps.audit) {
      await this.deps.audit.append(auditExportEvent(actor, packet, this.now()));
    }
    return { ok: true, value: packet };
  }
}

/** The audit event a tenant-wide export writes: the digest, so the copy can be cited. */
export function auditExportEvent(actor: Actor, packet: AuditChainPacket, at: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: actor.tenantId,
    at,
    actor: actor.id,
    action: "audit.chain.export",
    targetType: "tenant",
    targetId: actor.tenantId,
    detail: {
      kind: AUDIT_EXPORT_KIND,
      version: packet.version || ASSURANCE_PACKET_VERSION,
      entries: packet.entries.length,
      contentHash: packet.contentHash,
    },
  };
}

/** The audit event an export writes: the digest, so the packet can be cited. */
export function packetAudit(incident: IncidentRecord, actor: string, packet: AssurancePacket, at: string): AuditEventInput {
  return {
    id: randomUUID(),
    tenantId: incident.tenantId,
    at,
    actor,
    action: "incident.packet.export",
    targetType: "incident",
    targetId: incident.id,
    detail: {
      ref: incident.ref,
      version: packet.version || ASSURANCE_PACKET_VERSION,
      contentHash: packet.contentHash,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  In-memory reader (tests and local work)                                   */
/* -------------------------------------------------------------------------- */

export class MemoryAssuranceAuditReader implements AssuranceAuditReader {
  constructor(private readonly chains = new Map<string, AuditChain>()) {}

  /** Test helper: point a tenant at a chain, verified or deliberately broken. */
  set(tenantId: string, chain: AuditChain): void {
    this.chains.set(tenantId, chain);
  }

  async read(tenantId: string): Promise<AuditChain> {
    return structuredClone(this.chains.get(tenantId) ?? { events: [], head: "0".repeat(64) });
  }
}
