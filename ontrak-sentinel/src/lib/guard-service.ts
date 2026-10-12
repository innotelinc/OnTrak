/**
 * Guard ingest service (S3): who may send telemetry, and for which tenant.
 *
 * This is the smallest file in the milestone and it holds the one decision a detection
 * platform cannot get wrong: **ingestion is authenticated, and the tenant is not chosen by
 * the caller.**
 *
 * ```
 *   Authorization: Bearer <deployment token>      ← proves it is a deployment we issued to
 *   X-Sentinel-Organization: <slug>               ← says which tenant's telemetry this is
 * ```
 *
 * The token is compared in constant time, because a comparison that returns early on the
 * first wrong byte is a comparison an attacker can time. The slug is *looked up* rather
 * than trusted: an unknown organization is refused, so a sensor pointed at the wrong tenant
 * cannot file its events under a name that does not exist, and cannot reach one it was not
 * given.
 *
 * The honest limit is stated rather than buried: `SENTINEL_GUARD_ORGANIZATION` pins this
 * deployment's ingest to one organization, so a single-tenant installation cannot be
 * talked into another tenant by a header. Hosted multi-tenant ingestion wants a token per
 * organization and that is not built; where the env var is unset the header decides among
 * organizations the token's deployment can see.
 */

import { timingSafeEqual } from "node:crypto";

import type { IdentityStore, ServiceResult } from "./identity-service";
import type { DetectionService } from "./detection-service";
import type { EnforcementService } from "./enforcement-service";
import { rulebookVersion, type DetectionRule } from "./detection-rules";
import {
  containmentRefusal,
  containmentReply,
  mapDeskRole,
  readContainmentRequest,
  type ContainmentReply,
} from "./containment-rules";
import type { GuardEndpoints } from "./guard-http";

/** A rule as the rulebook endpoint reports it — no matchers, just what a reader needs. */
export interface RulebookEntry {
  id: string;
  version: number;
  name: string;
  severity: string;
  description: string;
  references: readonly string[];
  kind: string;
}

export interface GuardConfig {
  /** The deployment's ingest token. Absent means ingestion is not mounted at all. */
  token: string | null;
  /** The organization every ingest belongs to, when this deployment serves exactly one. */
  organizationSlug: string | null;
  /**
   * The token a containment request must present, or `null` to fall back to `token`.
   *
   * A separate credential because the two doors do different things: an ingest token is held
   * by every sensor in the estate, and one of those sensors must not be able to ask for a host
   * to be taken off the network. A deployment that keeps one credential for both is not
   * stopped from doing so — it simply inherits that property, and should know it does.
   */
  containmentToken?: string | null;
}

/** Constant-time, and length-safe: `timingSafeEqual` refuses buffers of different sizes. */
function tokensMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) {
    // Still compare something of the right length, so a wrong-length guess costs the same
    // as a wrong-byte one.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearer(value: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

export class GuardService implements GuardEndpoints {
  constructor(
    private readonly detection: DetectionService,
    /** Read-only, for turning a slug into an organization the same way a login does. */
    private readonly organizations: Pick<IdentityStore, "findOrganizationBySlug">,
    private readonly config: GuardConfig,
    /**
     * Prevention, so another product can ask for an action. Optional and last: a deployment
     * with no enforcement service still ingests telemetry, and the containment path says so
     * rather than answering as though it did something.
     */
    private readonly enforcement: EnforcementService | null = null,
  ) {}

  /** Whether this deployment accepts telemetry at all. */
  enabled(): boolean {
    return this.config.token !== null && this.config.token.length > 0;
  }

  /** Whether this deployment accepts containment requests. */
  containmentEnabled(): boolean {
    const token = this.config.containmentToken ?? this.config.token;
    return token !== null && token.length > 0;
  }

  /**
   * The rule set's own id, reported beside the rules so a sensor platform is reconciled
   * against a *corpus* and not only a list of rules.
   */
  rulebookVersion(): string {
    return rulebookVersion(this.detection.rulebook());
  }

  rulebook(): RulebookEntry[] {
    return this.detection.rulebook().map((rule: DetectionRule) => ({
      id: rule.id,
      version: rule.version,
      name: rule.name,
      severity: rule.severity,
      description: rule.description,
      references: rule.references,
      kind: rule.detection.kind,
    }));
  }

  async ingest(input: {
    authorization: string;
    organization: string;
    payload: unknown;
    at: number;
  }): Promise<ServiceResult<{ accepted: number; rejected: { reason: string }[]; alerts: { id: string; ruleId: string; severity: string; created: boolean }[] }>> {
    if (!this.enabled()) return { ok: false, error: "This deployment does not accept telemetry." };

    const presented = bearer(input.authorization);
    // One sentence for "no token" and "wrong token" alike: telling a probe which half it
    // got right is telling it something it does not need to know.
    if (!presented || !tokensMatch(this.config.token!, presented)) {
      return { ok: false, error: "The ingest token is not valid." };
    }

    const slug = (this.config.organizationSlug ?? input.organization).trim();
    if (!slug) return { ok: false, error: "Name the organization this telemetry belongs to." };
    const organization = await this.organizations.findOrganizationBySlug(slug);
    if (!organization) return { ok: false, error: `No organization has the slug “${slug}”.` };

    const body = input.payload as { source?: unknown; sensor?: unknown; events?: unknown; event?: unknown };
    const source = typeof body.source === "string" ? body.source.trim().toUpperCase() : "";
    if (!source) return { ok: false, error: "Name the source these events came from." };

    const sensor = typeof body.sensor === "string" && body.sensor.trim() ? body.sensor.trim() : "unattributed";
    const payloads = Array.isArray(body.events) ? body.events : body.event !== undefined ? [body.event] : null;
    if (!payloads) return { ok: false, error: "Send an `events` array (or a single `event`)." };

    const ingested = await this.detection.ingest(organization.id, source, payloads, { sensor, at: input.at });
    if (!ingested.ok) return ingested;

    return {
      ok: true,
      value: {
        accepted: ingested.value.accepted,
        rejected: ingested.value.rejected,
        alerts: ingested.value.alerts.map((alert) => ({
          id: alert.id,
          ruleId: alert.ruleId,
          severity: alert.severity,
          created: alert.created,
        })),
      },
    };
  }

  /**
   * Turn another product's request into a proposal on this deployment's rails.
   *
   * The order is deliberate and is the whole security property of this path: authenticate,
   * read the request, and only then let the rails decide. Nothing here can grant what
   * `decideEnforcement` would refuse — a desk request is judged by the same safe-list, the
   * same blast-radius cap, the same hourly limit and the same second-approver rule as a
   * console proposal, and the identity is namespaced (`tix:<id>`) so a desk administrator is
   * never mistaken for the Sentinel administrator who approves it.
   *
   * A refusal comes back as `REFUSED` with the rails' own sentence rather than as an error,
   * because it is an *outcome* the desk should record and show: somebody asked for a block and
   * a rail stopped it, which is exactly what an incident review wants to read.
   */
  async containment(input: {
    authorization: string;
    organization: string;
    body: unknown;
  }): Promise<ServiceResult<ContainmentReply>> {
    if (!this.containmentEnabled()) {
      return { ok: false, error: "This deployment accepts no containment token, so it cannot be asked to act." };
    }

    const presented = bearer(input.authorization);
    // One sentence for "no token" and "wrong token" alike, exactly as ingest does.
    const expected = (this.config.containmentToken ?? this.config.token)!;
    if (!presented || !tokensMatch(expected, presented)) {
      return { ok: false, error: "The containment token is not valid." };
    }

    const read = readContainmentRequest(input.body);
    if (!read.ok) return { ok: false, error: read.error };

    if (this.enforcement === null) {
      return { ok: false, error: "This deployment runs no enforcement service, so it cannot contain anything." };
    }

    const slug = (this.config.organizationSlug ?? input.organization).trim();
    if (!slug) return { ok: false, error: "Name the organization this request belongs to." };
    const organization = await this.organizations.findOrganizationBySlug(slug);
    if (!organization) return { ok: false, error: `No organization has the slug “${slug}”.` };

    // `mapDeskRole` already refused an unmappable role while reading, so this cannot be null;
    // the guard is here so a later edit to the reader cannot quietly make it possible.
    const role = mapDeskRole(read.value.requestedBy.role);
    if (role === null) {
      return { ok: false, error: `“${read.value.requestedBy.role}” is not a role prevention may be asked under.` };
    }

    const applied = await this.enforcement.apply({
      organizationId: organization.id,
      proposal: {
        action: read.value.action,
        targets: read.value.targets,
        alertId: read.value.alertId,
        reason: read.value.reason,
        requestedBy: {
          // Namespaced so a desk identity can never equal a Sentinel one: the second-approver
          // rail asks for a *different* administrator, and this makes that true by
          // construction rather than by a mapping table somebody has to maintain.
          identityId: `tix:${read.value.requestedBy.id}`,
          label: `${read.value.requestedBy.label} (OnTrak Tix)`,
          role,
        },
      },
      detectedAt: read.value.detectedAt,
    });

    if (!applied.ok) return { ok: true, value: containmentRefusal(applied.error) };

    return {
      ok: true,
      value: containmentReply({
        gate: applied.value.gate,
        actionId: applied.value.action.id,
        state: applied.value.action.state,
      }),
    };
  }
}
