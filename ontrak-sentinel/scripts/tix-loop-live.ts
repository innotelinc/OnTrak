/**
 * Live cross-product check (S5): Sentinel and Tix, over real HTTP.
 *
 * This is the one thing neither product's own suite can answer, because the seam is *between*
 * them: does a body Sentinel's transport really sends, signed the way it really signs it, get
 * through the desk's reader and land as an alert — and does a containment request the desk
 * really makes reach Sentinel's rails and come back as a decision?
 *
 * It starts both surfaces on loopback with each product's **real** code: the sender
 * (`tix-alert-transport.ts`), the desk's reader (`sentinel-ingest.ts`), the connector and the
 * ingest service, Sentinel's guard router and `GuardService` over the real `EnforcementService`.
 * Each side is driven by the other's real client. The stores are in memory because this machine
 * has no scratch database to point at, which is stated rather than hidden: what it does *not*
 * exercise is Postgres and the two Next route files, and those are covered by `npm run check`
 * in each product.
 *
 *   npx tsx scripts/tix-loop-live.ts        # from ontrak-sentinel/, exit 0 = the loop closed
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";

// ── Sentinel ────────────────────────────────────────────────────────────────
import { DetectionService, MemoryAlertStore, type AlertRecord } from "../src/lib/detection-service.js";
import { EnforcementService, MemoryEnforcementStore } from "../src/lib/enforcement-service.js";
import { GUARD_PATHS, routeGuard } from "../src/lib/guard-http.js";
import { GuardService } from "../src/lib/guard-service.js";
import { IdentityService, MemoryIdentityStore } from "../src/lib/identity-service.js";
import { OrganizationAuditLog } from "../src/lib/identity-service.js";
import { DEFAULT_ENFORCEMENT_POLICY } from "../src/lib/enforcement-rules.js";
import { alertNotification } from "../src/lib/alert-notify.js";
import { sha256Hex } from "../src/lib/hash.js";
import { TixAlertTransport, sentinelSignature } from "../src/lib/tix-alert-transport.js";
import type { IndicatorMatch } from "../src/lib/threat-intel-rules.js";

// ── Tix ─────────────────────────────────────────────────────────────────────
import { AuditLog } from "../../ontrak-tix/src/lib/audit-chain";
import { MemorySecurityAlertStore, SecurityAlertService } from "../../ontrak-tix/src/lib/security-alert-service";
import { SecurityAlertConnector, connectorReply } from "../../ontrak-tix/src/lib/security-alert-connector";
import { authorizeIngest } from "../../ontrak-tix/src/lib/sentinel-ingest";
import { HttpSentinelContainment, SentinelContainmentService } from "../../ontrak-tix/src/lib/sentinel-containment";

const AT = "2026-10-27T09:00:00.000Z";
const SHARED = "desk-shared-secret";
const SIGNING = "desk-signing-secret";
const CONTAINMENT = "sentinel-containment-token";
const ORG_SLUG = "acme";
/** The tenant the slug `acme` resolves to. The route does this by looking the slug up. */
const TENANT = "tenant-a";

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

/* -------------------------------------------------------------------------- */
/*  The desk                                                                  */
/* -------------------------------------------------------------------------- */

const tixAudit = new AuditLog((input: string) => createHmac("sha256", "loop").update(input).digest("hex"));
const tixStore = new MemorySecurityAlertStore();
let tixAlertSeq = 0;
const tixAlerts = new SecurityAlertService(tixStore, tixAudit, { id: () => `tix-alert-${++tixAlertSeq}` });

/**
 * The desk's route, minus Next and Prisma.
 *
 * The order and the status codes are the real ones: authenticate, resolve the tenant, parse the
 * body, hand the payload to the connector and map the outcome onto a reply. What is stood in for
 * is the slug lookup (`acme` → the tenant this run uses) and the store.
 */
function deskHandler(request: IncomingMessage, body: string, respond: (status: number, value: unknown) => void): void {
  const headers = { get: (name: string) => (request.headers[name.toLowerCase()] as string | undefined) ?? null };

  const authorization = authorizeIngest({
    headers,
    rawBody: body,
    nowSeconds: Math.floor(Date.now() / 1000),
    sharedSecret: SHARED,
    signingSecret: SIGNING,
  });
  if (!authorization.ok) {
    respond(401, { error: authorization.error });
    return;
  }

  if (headers.get("x-ontrak-tenant") !== ORG_SLUG) {
    respond(400, { error: "Missing tenant (use ?tenant=<slug> or the x-ontrak-tenant header)." });
    return;
  }

  let payload: unknown = null;
  try {
    payload = body === "" ? null : JSON.parse(body);
  } catch {
    respond(400, { error: "Expected a JSON body." });
    return;
  }

  void new SecurityAlertConnector(tixAlerts, TENANT)
    .receive(payload)
    .then((outcome) => {
      const reply = connectorReply(outcome);
      respond(reply.status, { ...reply.body, mode: authorization.mode });
    })
    .catch((error: unknown) => respond(500, { error: String(error) }));
}

/* -------------------------------------------------------------------------- */
/*  Sentinel                                                                  */
/* -------------------------------------------------------------------------- */

let spineSeq = 0;
const sentinelAudit = new OrganizationAuditLog(sha256Hex);
/** One entity store, read by the spine, the detector and the guard — as the deployment wires it. */
const entities = new MemoryIdentityStore();
const sentinelSpine = new IdentityService(entities, sentinelAudit, {
  id: () => `live-${++spineSeq}`,
  now: () => AT,
  nowMs: () => Date.parse(AT),
});
const detection = new DetectionService(new MemoryAlertStore(), entities, sentinelAudit);

async function main(): Promise<void> {
  const created = await sentinelSpine.bootstrapOrganization(
    "test",
    { name: "Acme Inc", slug: ORG_SLUG },
    { identifier: "admin@acme.test", displayName: "Admin Acme" },
  );
  if (!created.ok) throw new Error(created.error);
  const organizationId = created.value.organization.id;

  let enforcementSeq = 0;
  const enforcement = new EnforcementService(new MemoryEnforcementStore(), sentinelAudit, {
    id: () => `act-${++enforcementSeq}`,
    now: () => AT,
  });
  await enforcement.setPolicy(organizationId, { ...DEFAULT_ENFORCEMENT_POLICY }, { identityId: "root", label: "Root" });

  const guard = new GuardService(
    detection,
    entities,
    { token: "sensor-token", organizationSlug: ORG_SLUG, containmentToken: CONTAINMENT },
    enforcement,
  );

  /* ---- the two surfaces --------------------------------------------------- */

  const desk = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      deskHandler(request, Buffer.concat(chunks).toString("utf8"), (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      });
    });
  });
  await new Promise<void>((resolve) => desk.listen(0, "127.0.0.1", resolve));
  const deskUrl = `http://127.0.0.1:${(desk.address() as { port: number }).port}/api/security/ingest`;

  const sentinel = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const origin = `http://127.0.0.1:${(sentinel.address() as { port: number }).port}`;
      void routeGuard(
        {
          method: request.method ?? "GET",
          url: `${origin}${request.url ?? "/"}`,
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value[0] : value ?? "",
            ]),
          ),
          body: Buffer.concat(chunks).toString("utf8"),
        },
        guard,
      ).then((answer) => {
        response.writeHead(answer.status, answer.headers as Record<string, string>);
        response.end(answer.body);
      });
    });
  });
  await new Promise<void>((resolve) => sentinel.listen(0, "127.0.0.1", resolve));
  const sentinelOrigin = `http://127.0.0.1:${(sentinel.address() as { port: number }).port}`;

  try {
    /* ---- direction 1: Sentinel raises, the desk records -------------------- */
    console.log("\nSentinel → Tix: a raised alert, delivered and read");
    const transport = new TixAlertTransport({
      url: deskUrl,
      tenant: ORG_SLUG,
      token: SHARED,
      signingSecret: SIGNING,
      nowSeconds: () => Math.floor(Date.now() / 1000),
    });

    const indicator = (id: string): IndicatorMatch => ({
      indicator: {
        id,
        kind: "IPV4",
        value: "203.0.113.7",
        wildcard: false,
        source: "acme-feed",
        confidence: 80,
        severity: "HIGH",
        labels: [],
        expiresAt: null,
        firstSeenAt: Date.parse(AT),
      },
      field: "sourceAddress",
      attribute: null,
      observable: "203.0.113.7",
      escalates: true,
    });

    const alert: AlertRecord = {
      id: "sentinel-alert-1",
      organizationId,
      ruleId: "SG-BEH-002",
      ruleVersion: 1,
      ruleName: "Failed sign-ins followed by a success from one address",
      severity: "CRITICAL",
      state: "NEW",
      dedupeKey: "SG-BEH-002@1|203.0.113.7|1",
      groupKey: "203.0.113.7",
      sourceAddress: "203.0.113.7",
      identityId: null,
      identityLabel: "ada@acme.test",
      device: "idp-01",
      asset: "auth-service",
      firstSeenAt: AT,
      lastSeenAt: AT,
      occurrences: 6,
      evidence: [],
      threatIntel: [indicator("ioc-1"), indicator("ioc-2")],
      note: null,
      assigneeId: null,
      assigneeLabel: null,
      assignedAt: null,
      createdAt: AT,
      updatedAt: AT,
    };

    const delivered = await transport.notify(alertNotification(alert));
    check("the desk accepted the delivery", delivered.ok, delivered.ok ? "" : delivered.error);

    const held = await tixAlerts.list(TENANT);
    check("the alert landed once", held.length === 1, `held ${held.length}`);
    const row = held[0];
    check("filed as the family's own source", row?.source === "SENTINEL", String(row?.source));
    check("the corpus it was judged by survived the crossing", row?.rulebookVersion?.length === 12, String(row?.rulebookVersion));
    check(
      "the ATT&CK techniques were derived from the rule and kept",
      JSON.stringify(row?.techniques) === '["T1110","T1078"]',
      JSON.stringify(row?.techniques),
    );
    check("the indicator count survived", row?.threatIntelCount === 2, String(row?.threatIntelCount));
    check("de-duplicated on Sentinel's own alert id", row?.dedupeKey === "SENTINEL:id:sentinel-alert-1", String(row?.dedupeKey));
    check("the source address is the alert's subject", row?.sourceIp === "203.0.113.7", String(row?.sourceIp));
    check("a repeat is one row", (await transport.notify(alertNotification(alert))).ok && (await tixAlerts.list(TENANT)).length === 1);
    check("the first sighting is on the desk's chain", tixAudit.snapshot().events.some((event) => event.action === "security.alert.ingest"));

    // A body signed with the wrong secret never reaches the reader.
    const body = JSON.stringify({ vendor: "OnTrak Sentinel", signature: "SG-BEH-002", occurredAt: AT });
    const forged = await fetch(deskUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SHARED}`,
        "x-ontrak-tenant": ORG_SLUG,
        "x-ontrak-signature": sentinelSignature("not-the-secret", Math.floor(Date.now() / 1000), body),
        "x-ontrak-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body,
    });
    check("a delivery signed with the wrong secret is a 401", forged.status === 401, String(forged.status));

    // The desk's older channel still works: a bearer with no signature is the shared-secret path.
    const bearer = await fetch(deskUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SHARED}`, "x-ontrak-tenant": ORG_SLUG },
      body: JSON.stringify({ vendor: "Snort", signature: "ET-SCAN-1", severity: "medium", occurredAt: AT }),
    });
    check("and the shared-secret path every other sensor uses is untouched", bearer.status === 202, String(bearer.status));

    /* ---- direction 2: the desk asks, Sentinel's rails decide ---------------- */
    console.log("\nTix → Sentinel: a containment request, and its answer");
    const containment = new SentinelContainmentService(
      tixAlerts,
      new HttpSentinelContainment({ baseUrl: sentinelOrigin, token: CONTAINMENT, organization: ORG_SLUG }),
      tixAudit,
    );

    const asked = await containment.request({
      tenantId: TENANT,
      alertId: held[0]!.id,
      reason: "Credential stuffing from this address against the auth service.",
      requestedBy: { id: "u-1", label: "Ada Lovelace", role: "AGENT" },
    });
    check("the desk got an answer rather than an error", asked.ok, asked.ok ? "" : asked.error);
    check("which is pending, because a desk may ask and not approve", asked.ok && asked.value.state === "PENDING", asked.ok ? asked.value.state : "");
    check(
      "and says so in the operator's own sentence",
      asked.ok && /waiting for a Sentinel administrator/.test(asked.value.message),
      asked.ok ? asked.value.message : "",
    );

    const actions = await enforcement.list(organizationId);
    const action = actions[0];
    check("Sentinel recorded a real proposal", action !== undefined);
    check("against the address the alert named", action?.targets[0]?.value === "203.0.113.7", JSON.stringify(action?.targets));
    check("with the block being the action for an address", action?.action === "BLOCK", String(action?.action));
    check("the desk's own alert is the detection behind it", action?.alertId === held[0]!.id, String(action?.alertId));
    check("the requester is namespaced, so it can never collide", action?.requestedById === "tix:u-1", String(action?.requestedById));
    check("the desk's person is named on the seal", action?.requestedByLabel === "Ada Lovelace (OnTrak Tix)", String(action?.requestedByLabel));
    check("the desk's alert knows where it stands", (await tixAlerts.get(TENANT, held[0]!.id))?.containmentState === "PENDING");
    check("and Sentinel's action id is on the desk's row", (await tixAlerts.get(TENANT, held[0]!.id))?.containmentActionId === action?.id);
    check("the ask is on the desk's chain", tixAudit.snapshot().events.some((event) => event.action === "security.containment.pending"));

    // A second administrator approves it in Sentinel, and only then is the block real.
    const approved = await enforcement.approve({
      organizationId,
      actionId: action!.id,
      approver: { identityId: "admin-2", label: "Second Admin", role: "ADMIN" },
    });
    check("a *different* Sentinel administrator approves it", approved.ok, approved.ok ? "" : approved.error);
    check("and only then is it in force", approved.ok && approved.value.action.state === "ACTIVE", approved.ok ? approved.value.action.state : "");

    // A rail refusing is an outcome the desk reads, not an error it retries.
    await enforcement.setPolicy(
      organizationId,
      { ...DEFAULT_ENFORCEMENT_POLICY, protectedTargets: ["198.51.100.9"], maxTargets: 3 },
      { identityId: "root", label: "Root" },
    );
    const current = await tixAlerts.get(TENANT, held[0]!.id);
    await tixStore.update({ ...current!, sourceIp: "198.51.100.9" });
    const refused = await containment.request({
      tenantId: TENANT,
      alertId: held[0]!.id,
      reason: "Contain the source.",
      requestedBy: { id: "u-1", label: "Ada Lovelace", role: "AGENT" },
    });
    check("a rail refusing comes back as an outcome", refused.ok && refused.value.state === "REFUSED", refused.ok ? refused.value.state : "");
    check("with Sentinel's own sentence about the safe-list", refused.ok && /safe-list/.test(refused.value.message), refused.ok ? refused.value.message : "");
    check("and the refusal is on the desk's chain too", tixAudit.snapshot().events.some((event) => event.action === "security.containment.refused"));

    /* ---- the other surface ------------------------------------------------- */
    console.log("\nSentinel's guard surface");
    const rulebook = await fetch(`${sentinelOrigin}${GUARD_PATHS.rules}`);
    const book = (await rulebook.json()) as { rulebookVersion: string; rules: unknown[] };
    check("the rulebook is readable", rulebook.status === 200, String(rulebook.status));
    check("and names the corpus", /^[0-9a-f]{12}$/.test(book.rulebookVersion), book.rulebookVersion);
    check("with every shipped rule", book.rules.length === detection.rulebook().length, `${book.rules.length}`);

    const noToken = await fetch(`${sentinelOrigin}${GUARD_PATHS.containment}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        alertId: "x",
        action: "BLOCK",
        targets: [{ kind: "ADDRESS", value: "1.2.3.4" }],
        reason: "r",
        requestedBy: { id: "u", label: "U", role: "ADMIN" },
      }),
    });
    check("a containment request with no token is a 401", noToken.status === 401, String(noToken.status));

    // A role this build cannot map is refused by name rather than defaulted to something powerful.
    const unmappable = await fetch(`${sentinelOrigin}${GUARD_PATHS.containment}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CONTAINMENT}` },
      body: JSON.stringify({
        alertId: held[0]!.id,
        action: "BLOCK",
        targets: [{ kind: "ADDRESS", value: "203.0.113.7" }],
        reason: "r",
        requestedBy: { id: "u-9", label: "Someone Else", role: "SUPERUSER" },
      }),
    });
    check("an unmappable desk role is refused", unmappable.status === 400, String(unmappable.status));
    check(
      "with a sentence naming the role",
      /SUPERUSER/.test(await unmappable.clone().text()),
    );
  } finally {
    desk.close();
    sentinel.close();
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} check(s) failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("The loop closed: Sentinel delivered, the desk recorded, the desk asked, Sentinel decided.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
