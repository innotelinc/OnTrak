/**
 * Identity service assembly (S0): one place that turns a Prisma client into a
 * ready-to-use `IdentityService`.
 *
 * The server configures the client once at startup (`configureIdentities`) and
 * then asks for `identityServices()`; tests build their own stack with
 * `createIdentityServices` and a fake client. Nothing here decides anything —
 * the isolation boundary, the session policy and the evidence chain all live in
 * `identity-service.ts` and the modules it reads.
 */

import type { AuditSink, HashFn } from "./audit-chain";
import { PrismaIdentityStore, PrismaOrganizationAuditTrail, sha256Hex, type IdentityPrismaClient } from "./identity-store-prisma";
import { IdentityService, type AuditTrail, type IdentityIds, type IdentityStore } from "./identity-service";
import { MfaService, type MfaIds, type MfaStore } from "./mfa-service";
import {
  PrismaMfaStore,
  PrismaWebAuthnChallengeStore,
  type MfaPrismaClient,
  type WebAuthnChallengePrismaClient,
} from "./mfa-store-prisma";
import {
  WebAuthnService,
  type WebAuthnChallengeStore,
  type WebAuthnConfig,
  type WebAuthnIds,
} from "./webauthn-service";

/** The identity spine. */
export interface IdentityServices {
  store: IdentityStore;
  audit: AuditTrail;
  service: IdentityService;
}

/**
 * The second factor, beside the spine rather than inside it.
 *
 * `MfaService` calls `IdentityService.setMfaEnrolled` instead of writing the flag
 * itself, so there is one writer of the field every session decision reads — and
 * the factor store keeps its own client interface, so widening it never ripples
 * into every fake that implements the identity port.
 */
export interface MfaServices {
  store: MfaStore;
  service: MfaService;
}

/**
 * Build a full service stack over a Prisma client (or any client-shaped fake).
 *
 * The audit trail is durable here rather than in-memory, because that is the
 * difference between an evidence log and a log of the current process: it is
 * written to the same database as the identities it describes, one hash chain
 * per organization.
 */
export function createIdentityServices(
  db: IdentityPrismaClient,
  ids?: IdentityIds,
  hash: HashFn = sha256Hex,
): IdentityServices {
  const store = new PrismaIdentityStore(db);
  const audit = new PrismaOrganizationAuditTrail(db, hash);
  return { store, audit, service: new IdentityService(store, audit, ids) };
}

/** Build the MFA stack over its own client and the spine it reports the flag to. */
export function createMfaServices(
  db: MfaPrismaClient,
  identities: Pick<IdentityService, "setMfaEnrolled">,
  audit: AuditSink | null = null,
  ids?: MfaIds,
): MfaServices {
  const store = new PrismaMfaStore(db);
  return { store, service: new MfaService(store, identities, audit, ids) };
}

/**
 * The WebAuthn stack: the security keys, and the challenges they answer.
 *
 * Separate from `MfaServices` because it needs its own client — the challenge table
 * — and because a deployment may run TOTP without a relying party configured (no
 * console origin). Where it does run, both factor kinds write through the *same*
 * flag: this is handed the spine, not a second copy of the enrolled state.
 */
export interface WebAuthnServices {
  challenges: WebAuthnChallengeStore;
  service: WebAuthnService;
}

export function createWebAuthnServices(
  db: MfaPrismaClient & WebAuthnChallengePrismaClient,
  factors: MfaStore,
  identities: Pick<IdentityService, "setMfaEnrolled" | "identity">,
  config: WebAuthnConfig,
  audit: AuditSink | null = null,
  ids?: WebAuthnIds,
): WebAuthnServices {
  const challenges = new PrismaWebAuthnChallengeStore(db);
  return { challenges, service: new WebAuthnService(factors, challenges, identities, config, audit, ids) };
}

let configured: IdentityServices | null = null;
let configuredMfa: MfaServices | null = null;
let configuredWebAuthn: WebAuthnServices | null = null;

/** Bind the process-wide Prisma client, once, at server startup. */
export function configureIdentities(db: IdentityPrismaClient, ids?: IdentityIds, hash?: HashFn): IdentityServices {
  configured = createIdentityServices(db, ids, hash);
  return configured;
}

/** The configured stack. Throws when the server forgot to call `configureIdentities`. */
export function identityServices(): IdentityServices {
  if (!configured) {
    throw new Error("OnTrak Sentinel is not configured: call configureIdentities(prisma) during startup.");
  }
  return configured;
}

/** Bind the process-wide MFA client, once, at server startup. */
export function configureMfa(
  db: MfaPrismaClient,
  identities: Pick<IdentityService, "setMfaEnrolled">,
  audit: AuditSink | null = null,
  ids?: MfaIds,
): MfaServices {
  configuredMfa = createMfaServices(db, identities, audit, ids);
  return configuredMfa;
}

/** The configured MFA stack. Throws when the server forgot to call `configureMfa`. */
export function mfaServices(): MfaServices {
  if (!configuredMfa) {
    throw new Error("OnTrak Sentinel is not configured: call configureMfa(prisma, identities) during startup.");
  }
  return configuredMfa;
}

/** Bind the process-wide WebAuthn stack, once, at server startup. */
export function configureWebAuthn(
  db: MfaPrismaClient & WebAuthnChallengePrismaClient,
  factors: MfaStore,
  identities: Pick<IdentityService, "setMfaEnrolled" | "identity">,
  config: WebAuthnConfig,
  audit: AuditSink | null = null,
  ids?: WebAuthnIds,
): WebAuthnServices {
  configuredWebAuthn = createWebAuthnServices(db, factors, identities, config, audit, ids);
  return configuredWebAuthn;
}

/** The configured WebAuthn stack. Throws when the server forgot to call `configureWebAuthn`. */
export function webAuthnServices(): WebAuthnServices {
  if (!configuredWebAuthn) {
    throw new Error("OnTrak Sentinel is not configured: call configureWebAuthn(prisma, ...) during startup.");
  }
  return configuredWebAuthn;
}
