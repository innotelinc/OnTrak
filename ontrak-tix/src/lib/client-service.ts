/**
 * Client service (M4): the clients a desk serves, the people at them, who on the
 * desk serves them, and the window in which somebody is looking through their
 * eyes.
 *
 * Two decisions worth stating out loud:
 *
 *  - **Reading is scoped, writing is managed.** Any staff member may read the
 *    clients they are in scope for (that is what makes the worklist make sense);
 *    creating a client, adding a contact, assigning an agent or starting an
 *    act-as window needs `client:manage`. The scope is computed here, once, from
 *    the assignments, so a page cannot forget it.
 *  - **Acting as a client is recorded twice.** The window is a row (so a page can
 *    show that somebody is in it, and a second one cannot start), and it is an
 *    audit event (so the chain says who looked, at which client, and why). An
 *    act-as that only lived in a cookie would be invisible to the record.
 */

import { randomUUID } from "node:crypto";

import { hasPermission, type Actor } from "./access-rules";
import type { AuditEventInput, AuditSink } from "./audit-chain";
import {
  actAsActive,
  actAsClientDecision,
  actAsExpiry,
  canSeeClient,
  clientScopeFor,
  validateClient,
  validateContact,
  type ClientActAsRecord,
  type ClientAssignmentRecord,
  type ClientRecord,
  type ClientScope,
  type ContactRecord,
} from "./client-rules";
import type { ServiceResult } from "./ticket-service";

export interface ClientStore {
  listClients(tenantId: string): Promise<ClientRecord[]>;
  findClient(tenantId: string, clientId: string): Promise<ClientRecord | null>;
  findClientByName(tenantId: string, name: string): Promise<ClientRecord | null>;
  insertClient(record: ClientRecord): Promise<void>;

  listContacts(tenantId: string, clientId?: string): Promise<ContactRecord[]>;
  findContactByEmail(tenantId: string, email: string): Promise<ContactRecord | null>;
  insertContact(record: ContactRecord): Promise<void>;

  listAssignments(tenantId: string, clientId?: string): Promise<ClientAssignmentRecord[]>;
  findAssignment(tenantId: string, clientId: string, userId: string): Promise<ClientAssignmentRecord | null>;
  insertAssignment(record: ClientAssignmentRecord): Promise<void>;
  removeAssignment(tenantId: string, clientId: string, userId: string): Promise<void>;

  listActAs(tenantId: string, actorId?: string): Promise<ClientActAsRecord[]>;
  findActAs(tenantId: string, sessionId: string): Promise<ClientActAsRecord | null>;
  insertActAs(record: ClientActAsRecord): Promise<void>;
  updateActAs(record: ClientActAsRecord): Promise<void>;
}

export interface ClientIds {
  id(): string;
  now(): string;
}

export function systemClientIds(): ClientIds {
  return { id: () => randomUUID(), now: () => new Date().toISOString() };
}

/** A client with everything the console shows about it. */
export interface ClientOverview {
  client: ClientRecord;
  contacts: ContactRecord[];
  assignments: ClientAssignmentRecord[];
}

export class ClientService {
  constructor(
    private readonly store: ClientStore,
    private readonly audit: AuditSink | null = null,
    private readonly ids: ClientIds = systemClientIds(),
  ) {}

  /* ------------------------------------------------------------- reading */

  /** The actor's scope, computed from the assignments on every call. */
  async scope(actor: Actor): Promise<ClientScope> {
    const assignments = await this.store.listAssignments(actor.tenantId);
    return clientScopeFor({ role: actor.role, userId: actor.id, assignments });
  }

  async canSee(actor: Actor, clientId: string): Promise<boolean> {
    return canSeeClient(await this.scope(actor), clientId);
  }

  /** The clients the actor may see, with their contacts and assignments. */
  async list(actor: Actor): Promise<ServiceResult<ClientOverview[]>> {
    if (!hasPermission(actor.role, "ticket:read:any")) {
      return { ok: false, error: "You do not have access to clients." };
    }

    const [clients, contacts, assignments, scope] = await Promise.all([
      this.store.listClients(actor.tenantId),
      this.store.listContacts(actor.tenantId),
      this.store.listAssignments(actor.tenantId),
      this.scope(actor),
    ]);

    const visible = clients.filter((client) => canSeeClient(scope, client.id));
    const ids = new Set(visible.map((client) => client.id));
    return {
      ok: true,
      value: visible.map((client) => ({
        client,
        contacts: contacts.filter((contact) => contact.clientId === client.id),
        assignments: assignments.filter((assignment) => assignment.clientId === client.id && ids.has(assignment.clientId)),
      })),
    };
  }

  /** The window this actor has open, if any — expired ones read as closed. */
  async activeActAs(actor: Actor): Promise<ClientActAsRecord | null> {
    const now = this.ids.now();
    const mine = await this.store.listActAs(actor.tenantId, actor.id);
    return mine.find((record) => actAsActive(record, now)) ?? null;
  }

  /* ------------------------------------------------------------ writing */

  async create(actor: Actor, input: { name: string }): Promise<ServiceResult<ClientRecord>> {
    const denied = this.manageable(actor);
    if (denied) return denied;

    const issues = validateClient(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const name = input.name.trim();
    if (await this.store.findClientByName(actor.tenantId, name)) {
      return { ok: false, error: `A client called “${name}” already exists.` };
    }

    const client: ClientRecord = { id: this.ids.id(), tenantId: actor.tenantId, name, createdAt: this.ids.now() };
    await this.store.insertClient(client);
    await this.append(actor, "client.create", "client", client.id, { name });
    return { ok: true, value: client };
  }

  async addContact(actor: Actor, clientId: string, input: { name: string; email: string }): Promise<ServiceResult<ContactRecord>> {
    const denied = this.manageable(actor);
    if (denied) return denied;

    const client = await this.store.findClient(actor.tenantId, clientId);
    if (!client) return { ok: false, error: "Client not found." };

    const issues = validateContact(input);
    if (issues.length > 0) return { ok: false, error: issues[0].message };

    const email = input.email.trim();
    const clash = await this.store.findContactByEmail(actor.tenantId, email);
    if (clash) {
      return {
        ok: false,
        error: clash.clientId === clientId ? `${email} is already a contact of this client.` : `${email} is already a contact at another client.`,
      };
    }

    const contact: ContactRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId,
      name: input.name.trim(),
      email,
      createdAt: this.ids.now(),
    };
    await this.store.insertContact(contact);
    await this.append(actor, "client.contact.add", "client", clientId, { contactId: contact.id, email });
    return { ok: true, value: contact };
  }

  /** Put an agent on a client. The assignment is the scope, so it is audited. */
  async assign(actor: Actor, clientId: string, userId: string): Promise<ServiceResult<ClientAssignmentRecord>> {
    const denied = this.manageable(actor);
    if (denied) return denied;

    const client = await this.store.findClient(actor.tenantId, clientId);
    if (!client) return { ok: false, error: "Client not found." };

    if (await this.store.findAssignment(actor.tenantId, clientId, userId)) {
      return { ok: false, error: "That person already serves this client." };
    }

    const assignment: ClientAssignmentRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId,
      userId,
      assignedBy: actor.id,
      assignedAt: this.ids.now(),
    };
    await this.store.insertAssignment(assignment);
    await this.append(actor, "client.assign", "client", clientId, { userId, assignedBy: actor.id });
    return { ok: true, value: assignment };
  }

  async unassign(actor: Actor, clientId: string, userId: string): Promise<ServiceResult<ClientAssignmentRecord>> {
    const denied = this.manageable(actor);
    if (denied) return denied;

    const existing = await this.store.findAssignment(actor.tenantId, clientId, userId);
    if (!existing) return { ok: false, error: "That person does not serve this client." };

    await this.store.removeAssignment(actor.tenantId, clientId, userId);
    await this.append(actor, "client.unassign", "client", clientId, { userId });
    return { ok: true, value: existing };
  }

  /**
   * Open an act-as window. The decision is `actAsClientDecision`'s — permission,
   * scope, a reason, and no window already open — and the window is a row plus an
   * audit event, so "who looked through this client's eyes, and why" has answers.
   */
  async startActingAs(actor: Actor, clientId: string, reason: string): Promise<ServiceResult<ClientActAsRecord>> {
    const now = this.ids.now();
    const [scope, active] = await Promise.all([this.scope(actor), this.activeActAs(actor)]);

    const decision = actAsClientDecision({
      role: actor.role,
      scope,
      clientId,
      reason,
      active: active ? { clientId: active.clientId, expiresAt: active.expiresAt } : null,
      now,
    });
    if (!decision.allowed) return { ok: false, error: decision.reason };

    const session: ClientActAsRecord = {
      id: this.ids.id(),
      tenantId: actor.tenantId,
      clientId,
      actorId: actor.id,
      reason: reason.trim(),
      startedAt: now,
      expiresAt: actAsExpiry(now),
      endedAt: null,
      endReason: null,
    };
    await this.store.insertActAs(session);
    await this.append(actor, "client.act_as.start", "client", clientId, {
      sessionId: session.id,
      reason: session.reason,
      expiresAt: session.expiresAt,
    });
    return { ok: true, value: session };
  }

  async endActingAs(actor: Actor, sessionId: string, endReason = ""): Promise<ServiceResult<ClientActAsRecord>> {
    if (!hasPermission(actor.role, "client:manage")) {
      return { ok: false, error: "You do not manage clients." };
    }

    const session = await this.store.findActAs(actor.tenantId, sessionId);
    if (!session) return { ok: false, error: "That act-as window is not open." };
    if (session.actorId !== actor.id) return { ok: false, error: "That window belongs to somebody else." };
    if (session.endedAt) return { ok: false, error: "That window is already closed." };

    const next: ClientActAsRecord = {
      ...session,
      endedAt: this.ids.now(),
      endReason: endReason.trim() || null,
    };
    await this.store.updateActAs(next);
    await this.append(actor, "client.act_as.end", "client", session.clientId, {
      sessionId: session.id,
      reason: session.reason,
      endReason: next.endReason,
    });
    return { ok: true, value: next };
  }

  /* ------------------------------------------------------------ internals */

  private manageable(actor: Actor): { ok: false; error: string } | null {
    if (!hasPermission(actor.role, "client:manage")) return { ok: false, error: "You do not manage clients." };
    return null;
  }

  private async append(
    actor: Actor,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
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
export class MemoryClientStore implements ClientStore {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly contacts = new Map<string, ContactRecord>();
  private readonly assignments = new Map<string, ClientAssignmentRecord>();
  private readonly windows = new Map<string, ClientActAsRecord>();

  async listClients(tenantId: string): Promise<ClientRecord[]> {
    return [...this.clients.values()]
      .filter((client) => client.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((client) => structuredClone(client));
  }

  async findClient(tenantId: string, clientId: string): Promise<ClientRecord | null> {
    const found = this.clients.get(clientId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async findClientByName(tenantId: string, name: string): Promise<ClientRecord | null> {
    const found = [...this.clients.values()].find(
      (client) => client.tenantId === tenantId && client.name.toLowerCase() === name.toLowerCase(),
    );
    return found ? structuredClone(found) : null;
  }

  async insertClient(record: ClientRecord): Promise<void> {
    this.clients.set(record.id, structuredClone(record));
  }

  async listContacts(tenantId: string, clientId?: string): Promise<ContactRecord[]> {
    return [...this.contacts.values()]
      .filter((contact) => contact.tenantId === tenantId && (clientId === undefined || contact.clientId === clientId))
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((contact) => structuredClone(contact));
  }

  async findContactByEmail(tenantId: string, email: string): Promise<ContactRecord | null> {
    const found = [...this.contacts.values()].find(
      (contact) => contact.tenantId === tenantId && contact.email.toLowerCase() === email.toLowerCase(),
    );
    return found ? structuredClone(found) : null;
  }

  async insertContact(record: ContactRecord): Promise<void> {
    this.contacts.set(record.id, structuredClone(record));
  }

  async listAssignments(tenantId: string, clientId?: string): Promise<ClientAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.tenantId === tenantId && (clientId === undefined || assignment.clientId === clientId))
      .map((assignment) => structuredClone(assignment));
  }

  async findAssignment(tenantId: string, clientId: string, userId: string): Promise<ClientAssignmentRecord | null> {
    const found = [...this.assignments.values()].find(
      (assignment) => assignment.tenantId === tenantId && assignment.clientId === clientId && assignment.userId === userId,
    );
    return found ? structuredClone(found) : null;
  }

  async insertAssignment(record: ClientAssignmentRecord): Promise<void> {
    this.assignments.set(record.id, structuredClone(record));
  }

  async removeAssignment(tenantId: string, clientId: string, userId: string): Promise<void> {
    for (const [id, assignment] of this.assignments) {
      if (assignment.tenantId === tenantId && assignment.clientId === clientId && assignment.userId === userId) {
        this.assignments.delete(id);
      }
    }
  }

  async listActAs(tenantId: string, actorId?: string): Promise<ClientActAsRecord[]> {
    return [...this.windows.values()]
      .filter((record) => record.tenantId === tenantId && (actorId === undefined || record.actorId === actorId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((record) => structuredClone(record));
  }

  async findActAs(tenantId: string, sessionId: string): Promise<ClientActAsRecord | null> {
    const found = this.windows.get(sessionId);
    return found && found.tenantId === tenantId ? structuredClone(found) : null;
  }

  async insertActAs(record: ClientActAsRecord): Promise<void> {
    this.windows.set(record.id, structuredClone(record));
  }

  async updateActAs(record: ClientActAsRecord): Promise<void> {
    this.windows.set(record.id, structuredClone(record));
  }
}
