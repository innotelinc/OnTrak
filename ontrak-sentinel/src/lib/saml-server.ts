/**
 * SAML assembly (S1): one place that turns a store into a ready SAML service.
 *
 * The same shape as `oidc-server.ts`, deliberately: `createSamlServices` builds a
 * stack over any store-shaped object, and `configureSaml`/`samlServices` bind the
 * one the process uses. Persistence lives behind the `SamlStore` port, so the
 * engine runs over Prisma, over `MemorySamlStore` in tests and in the in-memory
 * dev provider, and the service cannot tell them apart.
 *
 * The identity spine is passed in rather than rebuilt, so an SSO grant is judged
 * by the *same* session policy — and written to the *same* evidence chain — as
 * every other decision in the product.
 */

import type { HashFn } from "./audit-chain";
import type { AuditTrail, IdentityService } from "./identity-service";
import { SamlService, type SamlConfig, type SamlIds, type SamlStore } from "./saml-service";
import { PrismaSamlStore, type SamlPrismaClient } from "./saml-store-prisma";
import type { XmlSigner } from "./saml-sign";

export interface SamlServices {
  store: SamlStore;
  service: SamlService;
}

export function createSamlServices(
  store: SamlStore,
  spine: IdentityService,
  config: SamlConfig,
  audit: AuditTrail | null = null,
  ids?: SamlIds,
  hash?: HashFn,
  sign?: XmlSigner,
): SamlServices {
  return { store, service: new SamlService(store, spine, config, audit, ids, hash, sign) };
}

/** Build the whole stack over a Prisma client, for a deployment. */
export function createPrismaSamlServices(
  db: SamlPrismaClient,
  spine: IdentityService,
  config: SamlConfig,
  audit: AuditTrail | null = null,
  ids?: SamlIds,
  hash?: HashFn,
  sign?: XmlSigner,
): SamlServices {
  return createSamlServices(new PrismaSamlStore(db), spine, config, audit, ids, hash, sign);
}

let configured: SamlServices | null = null;

/** Bind the process-wide SAML stack, once, at server startup. */
export function configureSaml(
  store: SamlStore,
  spine: IdentityService,
  config: SamlConfig,
  audit?: AuditTrail | null,
  ids?: SamlIds,
  hash?: HashFn,
  sign?: XmlSigner,
): SamlServices {
  configured = createSamlServices(store, spine, config, audit, ids, hash, sign);
  return configured;
}

/** The configured stack. Throws when the server forgot to call `configureSaml`. */
export function samlServices(): SamlServices {
  if (!configured) {
    throw new Error("OnTrak Sentinel's SAML provider is not configured: call configureSaml(...) during startup.");
  }
  return configured;
}
