/**
 * Ticket service assembly (M0): one place that turns a Prisma client into a
 * ready-to-use `TicketService`.
 *
 * The app layer configures the client once at startup (`configureTickets`) and
 * server actions then call `ticketServices()` without knowing how the store or
 * the audit sink are built. Nothing here decides anything — that all lives in
 * `ticket-service.ts` and the rules modules.
 */

import { PrismaAuditSink, PrismaTicketStore, sha256Hex, type TicketPrismaClient } from "./ticket-store-prisma";
import { TicketService, type IdSource, type TicketStore } from "./ticket-service";
import type { RuleIntake } from "./rule-intake";
import type { MacroIntake } from "./macro-intake";
import type { AuditSink } from "./audit-chain";

export interface TicketServices {
  store: TicketStore;
  audit: AuditSink;
  service: TicketService;
}

/** Build a full service stack over a Prisma client (or any client-shaped fake). */
export function createTicketServices(
  db: TicketPrismaClient,
  ids?: IdSource,
  rules: RuleIntake | null = null,
  macros: MacroIntake | null = null,
): TicketServices {
  const store = new PrismaTicketStore(db);
  const audit = new PrismaAuditSink(db, sha256Hex);
  return { store, audit, service: new TicketService(store, audit, ids, rules, macros) };
}

let configured: TicketServices | null = null;

/**
 * Bind the process-wide Prisma client. Called once from the tix app bootstrap;
 * tests build their own stack with `createTicketServices` instead. The rules
 * engine is optional here so a deployment (or a test) without one behaves
already as it did before rules existed.
 */
export function configureTickets(
  db: TicketPrismaClient,
  ids?: IdSource,
  rules: RuleIntake | null = null,
  macros: MacroIntake | null = null,
): TicketServices {
  configured = createTicketServices(db, ids, rules, macros);
  return configured;
}

/** The configured service stack. Throws when the app forgot to call `configureTickets`. */
export function ticketServices(): TicketServices {
  if (!configured) {
    throw new Error("OnTrak Tix is not configured: call configureTickets(prisma) during startup.");
  }
  return configured;
}
