/**
 * OnTrak Tix browser sweep.
 *
 * A second Playwright target, because Tix is a separate Next app with its own
 * sign-in and its own colour tokens — auditing the training app says nothing
 * about the desk. The spec signs in as the seeded agent and runs the same strict
 * axe rule set (WCAG A/AA, `color-contrast` included) over the staff surfaces,
 * then exercises the template prefill end-to-end.
 *
 * It is opt-in rather than automatic: Tix is only running when someone started
 * it, so with no `ONTRAK_TIX_BASE_URL` the whole file skips instead of failing
 * a checkout that never launched the second app.
 *
 *   ONTRAK_TIX_BASE_URL=http://127.0.0.1:3001 npm run test:e2e:tix
 */

import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AxeResults } from "axe-core";

const BASE_URL = process.env.ONTRAK_TIX_BASE_URL;
const EMAIL = process.env.ONTRAK_TIX_EMAIL ?? "agent@acme.test";
const PASSWORD = process.env.ONTRAK_TIX_PASSWORD ?? "ChangeMe123";

/** The Tix app is not under Playwright's `baseURL`, so build absolute URLs. */
function url(path: string): string {
  return `${BASE_URL}${path}`;
}

function report(violations: AxeResults["violations"]): string {
  return violations.map((violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`).join("\n");
}

async function audit(page: Page): Promise<AxeResults> {
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
}

async function auditPath(page: Page, path: string): Promise<void> {
  const response = await page.goto(url(path), { waitUntil: "load" });
  expect(response?.status() ?? 500, `${path} should not error`).toBeLessThan(400);
  const results = await audit(page);
  expect(results.violations, `violations on ${path}:\n${report(results.violations)}`).toEqual([]);
}

/** Sign in as the seeded agent, failing (not skipping) if the account is missing. */
async function signIn(page: Page, email: string = EMAIL): Promise<void> {
  await page.goto(url("/sign-in"), { waitUntil: "load" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((next) => !next.pathname.startsWith("/sign-in"), { timeout: 20_000 });
}

test.describe("OnTrak Tix desk", () => {
  test.skip(!BASE_URL, "set ONTRAK_TIX_BASE_URL to run the Tix sweep");

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  for (const path of ["/inbox", "/reports", "/notifications", "/canned", "/templates", "/inbox/new", "/security", "/incidents"]) {
    test(`a11y (browser): Tix ${path} passes WCAG A/AA`, async ({ page }) => {
      await auditPath(page, path);
    });
  }

  test("templates: using one prefills the new-ticket form", async ({ page }) => {
    await page.goto(url("/templates"), { waitUntil: "load" });
    expect(await page.getByRole("heading", { name: "Ticket templates" }).count()).toBe(1);

    // The seeded starter templates are listed, so a fresh desk is never empty.
    const useLinks = page.getByRole("link", { name: "Use" });
    expect(await useLinks.count()).toBeGreaterThan(0);
    await useLinks.first().click();

    await page.waitForURL(/\/inbox\/new\?template=/, { timeout: 20_000 });
    const subject = page.getByLabel("Subject");
    // Prefilled, and the placeholder is gone rather than left in the text.
    expect(await subject.inputValue()).not.toBe("");
    expect(await subject.inputValue()).not.toContain("{{");
    expect(await page.getByLabel("Description").inputValue()).not.toContain("{{");
  });

  test("security: a high alert opens an incident from the console", async ({ page }) => {
    await page.goto(url("/security"), { waitUntil: "load" });
    expect(await page.getByRole("heading", { name: "Security alerts" }).count()).toBe(1);

    const row = page.locator("li", { hasText: "ET SCAN Potential SSH Scan" });
    if ((await row.count()) === 0) test.skip(true, "no seeded demo alert to promote");

    // On a fresh seed the alert is below no bar and can be promoted; once it has
    // been, the row links its ticket instead — both are a pass, so a re-run of
    // the sweep does not flip the result.
    const promote = row.getByRole("button", { name: "Open incident" });
    if ((await promote.count()) > 0) {
      await promote.click();
      await expect(page.locator("body")).toContainText(/Incident TIX-\d+ opened/, { timeout: 20_000 });
    }
    await expect(row).toContainText(/Promoted to/);
  });

  test("incidents: declaring one starts its playbook, and the manifest downloads as JSON", async ({ page }) => {
    await page.goto(url("/incidents"), { waitUntil: "load" });
    expect(await page.getByRole("heading", { name: "Incidents", exact: true }).count()).toBe(1);

    // Fresh database: declare one straight from the console so the rest is deterministic.
    const link = page.getByRole("link", { name: /Download manifest/ }).first();
    if ((await link.count()) === 0) {
      await page.getByLabel("Title").fill(`Sweep incident ${Date.now()}`);
      await page.getByLabel("Summary").fill("Declared by the browser sweep to exercise the console and the manifest.");
      await page.getByRole("button", { name: "Declare incident" }).click();
      await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });
    }

    // Declaring auto-starts the playbook, so the console always shows its steps.
    expect(await page.getByRole("heading", { name: "Playbook" }).count()).toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: /Download manifest/ }).first()).toBeVisible();

    const href = await page.getByRole("link", { name: /Download manifest/ }).first().getAttribute("href");
    // The link is credentialed in the browser, so reuse the same session to fetch it.
    const response = await page.request.get(new URL(href!, url("/")).toString());
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["x-manifest-hash"]).toMatch(/^[0-9a-f]{64}$/);
    const manifest = (await response.json()) as { manifestHash: string; incident: { ref: string } };
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.incident.ref).toMatch(/^INC-/);

    // The signed Assurance Packet is the copy that leaves the building: it must
    // bundle the same manifest and carry its own digest and signature.
    const packetHref = await page.getByRole("link", { name: /Download assurance packet/ }).first().getAttribute("href");
    const packetResponse = await page.request.get(new URL(packetHref!, url("/")).toString());
    expect(packetResponse.status()).toBe(200);
    expect(packetResponse.headers()["x-packet-algorithm"]).toBe("HMAC-SHA256");
    expect(packetResponse.headers()["x-packet-hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(packetResponse.headers()["x-packet-signature"]).toMatch(/^[0-9a-f]{64}$/);
    const packet = (await packetResponse.json()) as {
      contentHash: string;
      evidenceManifestHash: string;
      custody: unknown[];
      audit: { head: string; verified: boolean; excerpt: unknown[] };
      policies: unknown[];
    };
    expect(packet.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // It commits to the very manifest the other endpoint handed out.
    expect(packet.evidenceManifestHash).toBe(manifest.manifestHash);
    expect(packet.audit.head).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.audit.verified).toBe(true);
    expect(packet.policies.length).toBeGreaterThan(0);
    expect(await packetResponse.headers()["content-disposition"]).toContain("-assurance-packet.json");
  });

  test("incidents: custody and a legal hold are recorded, and the packet follows them", async ({ page }) => {
    await page.goto(url("/incidents"), { waitUntil: "load" });

    // Declare one so the sweep does not depend on what earlier runs left behind.
    const stamp = Date.now();
    await page.getByLabel("Title").fill(`Custody sweep ${stamp}`);
    await page.getByLabel("Summary").fill("Exercises the chain of custody and the legal hold from the console.");
    await page.getByRole("button", { name: "Declare incident" }).click();
    await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });

    // Scope to the incident's own card: the timeline entries below it quote the
    // title too, so a plain text match would catch the nested list items.
    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Custody sweep ${stamp}`, exact: true }) })
      .first();
    await expect(card).toBeVisible();

    // Record a piece of evidence; recording it opens the custody trail. The
    // artifact-upload form also has a "Label", so scope to the evidence form.
    const evidenceForm = card.locator("form").filter({ has: page.getByRole("button", { name: "Record evidence" }) });
    await evidenceForm.getByLabel("Label").fill("Firewall log");
    await evidenceForm.getByLabel("Reference").fill("s3://evidence/sweep/fw.log");
    await evidenceForm.getByRole("button", { name: "Record evidence" }).click();
    await expect(card).toContainText("Firewall log");
    await expect(card).toContainText(/Custody: 1 entry, held by/);

    // Hand it to someone else; the trail grows and the timeline says why.
    await card.getByPlaceholder("hand to (person or team)").fill("forensics@acme.test");
    await card.getByPlaceholder("why it moved").fill("Handed to the forensics vendor");
    await card.getByRole("button", { name: "Hand off" }).click();
    await expect(card).toContainText("Custody: 2 entries, held by forensics@acme.test");
    await expect(card).toContainText("Handed to the forensics vendor");

    // A legal hold is placed, shown, and released — with a reason each way.
    await card.getByPlaceholder("why preservation is required").fill("Insurer asked us to preserve the record");
    await card.getByRole("button", { name: "Place legal hold" }).click();
    await expect(card).toContainText("in force");
    await expect(card).toContainText("Insurer asked us to preserve the record");

    await card.getByPlaceholder("why the hold is lifted").fill("Insurer withdrew the request");
    await card.getByRole("button", { name: "Release hold" }).click();
    await expect(card).toContainText("none");

    // The packet carries both, and the audit excerpt is anchored.
    const packetHref = await card.getByRole("link", { name: /Download assurance packet/ }).getAttribute("href");
    const packetResponse = await page.request.get(new URL(packetHref!, url("/")).toString());
    expect(packetResponse.status()).toBe(200);
    const packet = (await packetResponse.json()) as {
      recordHash: string;
      contentHash: string;
      signature: string;
      custody: { toActor: string }[];
      timeline: { kind: string }[];
      audit: { excerpt: { action: string }[]; verified: boolean };
    };
    expect(packet.custody.at(-1)?.toActor).toBe("forensics@acme.test");
    expect(packet.timeline.some((event) => event.kind === "custody")).toBe(true);
    expect(packet.timeline.some((event) => event.kind === "hold")).toBe(true);
    expect(packet.audit.verified).toBe(true);
    expect(packet.audit.excerpt.some((entry) => entry.action === "incident.packet.export") || packet.audit.excerpt.length > 0).toBe(
      true,
    );

    // Exporting again moves the chain on, so the packet differs — but the
    // incident record has not changed, and its digest says so. That is the
    // property that makes an archived packet comparable to a fresh one.
    const secondResponse = await page.request.get(new URL(packetHref!, url("/")).toString());
    const second = (await secondResponse.json()) as { recordHash: string; contentHash: string };
    expect(second.recordHash).toBe(packet.recordHash);
    expect(second.contentHash).not.toBe(packet.contentHash);
  });

  test("incidents: an artifact is stored under lock, and COMPLIANCE refuses to release it", async ({ page }) => {
    await page.goto(url("/incidents"), { waitUntil: "load" });

    const stamp = Date.now();
    await page.getByLabel("Title").fill(`Artifact sweep ${stamp}`);
    await page.getByLabel("Summary").fill("Exercises object-lock storage for evidence bytes from the console.");
    await page.getByRole("button", { name: "Declare incident" }).click();
    await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });

    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Artifact sweep ${stamp}`, exact: true }) })
      .first();
    await expect(card).toBeVisible();

    // With nothing stored, the panel says so rather than pretending.
    await expect(card).toContainText("No bytes stored");

    // The evidence form and the upload form both have a "Label", so scope to
    // the upload form rather than matching on the label text alone.
    const upload = card.locator("form").filter({ has: page.getByRole("button", { name: "Store artifact" }) });
    const bytes = Buffer.from(`sweep bundle ${stamp}`);
    await upload.getByLabel("Label").fill("Sweep bundle");
    // `exact` because the Kind select's FILE option is inside a label too.
    await upload.getByLabel("File", { exact: true }).setInputFiles({ name: "bundle.txt", mimeType: "text/plain", buffer: bytes });
    await upload.getByRole("button", { name: "Store artifact" }).click();

    // The flash names the mode and the date the lock expires…
    await expect(page.locator("body")).toContainText(/Artifact stored under COMPLIANCE retention until \d{4}-\d{2}-\d{2}/);
    // …and the console shows the lock itself, not just "we kept it".
    await expect(card).toContainText("Artifacts under lock");
    await expect(card).toContainText("COMPLIANCE until");
    await expect(card).toContainText("Sweep bundle");
    await expect(card).toContainText("text/plain");

    // Uploading the same bytes again is the same object, and says so.
    await upload.getByLabel("File", { exact: true }).setInputFiles({ name: "bundle.txt", mimeType: "text/plain", buffer: bytes });
    await upload.getByRole("button", { name: "Store artifact" }).click();
    await expect(page.locator("body")).toContainText(/already stored/);

    // Destroying evidence is deliberately stronger than recording it: an agent
    // cannot, and the refusal says why. The bytes are still there afterwards.
    await card.getByText("Remove the bytes…").click();
    await card.getByPlaceholder("why the bytes are going").fill("sweep cleanup");
    await card.getByRole("button", { name: "Remove bytes" }).click();
    await expect(page.locator("body")).toContainText(/needs an administrator/);
    await expect(card).toContainText("locked");
    await expect(card).not.toContainText("Bytes removed");

    // And an administrator still cannot shorten COMPLIANCE retention: the
    // refusal names the rule that holds it rather than failing vaguely.
    await signIn(page, "admin@acme.test");
    await page.goto(url("/incidents"), { waitUntil: "load" });
    const adminCard = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Artifact sweep ${stamp}`, exact: true }) })
      .first();
    await adminCard.getByText("Remove the bytes…").click();
    await adminCard.getByPlaceholder("why the bytes are going").fill("sweep cleanup, as an administrator");
    await adminCard.getByRole("button", { name: "Remove bytes" }).click();
    await expect(page.locator("body")).toContainText(/COMPLIANCE mode until/);
    await expect(adminCard).toContainText("locked");
    await expect(adminCard).not.toContainText("Bytes removed");
  });

  test("incidents: a regulatory clock is tracked, sent and acknowledged", async ({ page }) => {
    await page.goto(url("/incidents"), { waitUntil: "load" });

    // A SEV1 with extensive impact is the case every regime is suggested for.
    const stamp = Date.now();
    await page.getByLabel("Title").fill(`Notification sweep ${stamp}`);
    await page.getByLabel("Summary").fill("Exercises the regulatory notification clock from the console.");
    // By name, because "Impact" is a substring of the playbook's own labels.
    await page.locator('select[name="impact"]').selectOption("EXTENSIVE");
    await page.locator('select[name="urgency"]').selectOption("CRITICAL");
    await page.getByRole("button", { name: "Declare incident" }).click();
    await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });

    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Notification sweep ${stamp}`, exact: true }) })
      .first();
    await expect(card).toBeVisible();

    // The incident's own facts suggest the duties, each with its reason.
    await expect(card).toContainText("Suggested for this incident:");
    await expect(card).toContainText(/because a SEV1 incident is treated as significant under NIS2/);

    // Adopting one starts its clock and puts the deadline on the record.
    await card.getByRole("button", { name: "Track NIS2 early warning" }).click();
    await expect(page.locator("body")).toContainText(/NIS2 early warning is now tracked \(due /, { timeout: 20_000 });
    await expect(card).toContainText("NIS2 early warning");
    await expect(card).toContainText("pending");
    await expect(card).toContainText("clock: from declaration");
    await expect(card).toContainText(/due 20\d\d-/);
    // It is tracked now, so it is no longer offered as a suggestion.
    await expect(card.getByRole("button", { name: "Track NIS2 early warning" })).toHaveCount(0);

    // Sending it records the authority's reference; acknowledging closes it out.
    await card.getByPlaceholder("authority ref (optional)").fill("CSIRT-2026-0042");
    await card.getByRole("button", { name: "Mark sent" }).click();
    await expect(card).toContainText("sent");
    await expect(card).toContainText("CSIRT-2026-0042");
    await card.getByRole("button", { name: "Mark acknowledged" }).click();
    await expect(card).toContainText("acknowledged");
  });

  test("incidents: the phase ladder, the published review and the assembled timeline", async ({ page }) => {
    await page.goto(url("/incidents"), { waitUntil: "load" });

    const stamp = Date.now();
    await page.getByLabel("Title").fill(`Review sweep ${stamp}`);
    await page.getByLabel("Summary").fill("Walks the ladder, publishes the review and exercises the war-room timeline.");
    await page.getByRole("button", { name: "Declare incident" }).click();
    await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });

    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Review sweep ${stamp}`, exact: true }) })
      .first();
    await expect(card).toBeVisible();

    // The war-room timeline is assembled from the incident log *and* the audit
    // chain, so the declaration is one line attested by both sources.
    await expect(card).toContainText("War-room timeline");
    await expect(card).toContainText("corroborated");
    await expect(card).toContainText("audit chain");

    // A review cannot be published before the incident has been reviewed.
    await expect(card).toContainText("Move the incident to reviewed to publish its post-incident review.");

    // Staff it, then walk the ladder. A SEV2 or above needs two roles to triage.
    const roleForm = (name: string) => card.locator("form").filter({ has: page.getByLabel(name) });
    await roleForm("Incident commander").getByLabel("Incident commander").selectOption({ index: 1 });
    await roleForm("Incident commander").getByRole("button", { name: "Set" }).click();
    await expect(card).toContainText(/Incident commander: [A-Za-z]/);
    await roleForm("Scribe").getByLabel("Scribe").selectOption({ index: 1 });
    await roleForm("Scribe").getByRole("button", { name: "Set" }).click();

    for (const [phase, label] of [
      ["TRIAGED", "triaged"],
      ["CONTAINED", "contained"],
      ["ERADICATED", "eradicated"],
      ["RECOVERED", "recovered"],
      ["REVIEWED", "reviewed"],
    ] as const) {
      await card.getByRole("button", { name: `Move to ${label}` }).click();
      await expect(card).toContainText(phase, { timeout: 20_000 });
    }

    // Publishing creates work, not a document: an action with an owner and a date.
    await card.getByLabel("Findings").fill("A bastion host was scanned; nothing was accessed.");
    await card.locator('input[name="actionTitle-0"]').fill("Add the bastion to the SSH-scan rule");
    await card.locator('select[name="actionOwner-0"]').selectOption({ index: 1 });
    await card.locator('input[name="actionDue-0"]').fill("2026-12-01");
    await card.getByRole("button", { name: "Publish review" }).click();
    await expect(page.locator("body")).toContainText(/Review published with 1 action/, { timeout: 20_000 });
    await expect(card).toContainText("published");
    await expect(card).toContainText("Add the bastion to the SSH-scan rule");
    await expect(card).toContainText("due 2026-12-01");
    await expect(card).toContainText("0/1 actions closed");

    // Completing it settles the review, and the timeline records both.
    await card.getByPlaceholder("what was done (optional)").fill("Rule added in the IDS console");
    await card.getByRole("button", { name: "Complete action" }).click();
    await expect(card).toContainText("1/1 actions closed");
    await expect(card).toContainText("completed: Add the bastion to the SSH-scan rule");
  });

  test("packet verification: a reader with the file and the key can check it", async ({ page }) => {
    await page.goto(url("/incidents"), { waitUntil: "load" });

    // A fresh database may have no incident yet, so declare one to export from.
    if ((await page.getByRole("link", { name: /Download assurance packet/ }).count()) === 0) {
      await page.getByLabel("Title").fill(`Verifier sweep ${Date.now()}`);
      await page.getByLabel("Summary").fill("Gives the verifier a packet to check.");
      await page.getByRole("button", { name: "Declare incident" }).click();
      await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });
    }

    const href = await page.getByRole("link", { name: /Download assurance packet/ }).first().getAttribute("href");
    const packet = await (await page.request.get(new URL(href!, url("/")).toString())).text();
    expect(packet).toContain("\"signature\"");

    // The verification page is open on purpose — an auditor has no account here.
    await auditPath(page, "/verify");
    await expect(page.getByRole("heading", { name: "Verify an assurance packet" })).toBeVisible();

    await page.getByLabel("or paste it").fill(packet);
    await page.getByLabel("Signing key").fill(process.env.ONTRAK_TIX_ASSURANCE_KEY ?? "dev-assurance-key-9c3f1b7e2a5d8046");
    await page.getByRole("button", { name: "Verify packet" }).click();
    await expect(page.locator("body")).toContainText(/VERIFIED/, { timeout: 20_000 });
    await expect(page.locator("body")).toContainText(/record hash: [0-9a-f]{64}/);

    // A packet edited after it was signed fails, and says which digest failed.
    const edited = JSON.parse(packet) as { incident: { title: string } };
    edited.incident.title = "Something else entirely";
    await page.getByLabel("or paste it").fill(JSON.stringify(edited));
    await page.getByRole("button", { name: "Verify packet" }).click();
    await expect(page.locator("body")).toContainText(/The packet contents do not match its content hash/);
  });

  test("inbox: a requester cannot reach the staff worklist", async ({ page }) => {
    await page.goto(url("/notifications"), { waitUntil: "load" });
    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL(/\/sign-in/, { timeout: 20_000 });

    await page.getByLabel("Email").fill(process.env.ONTRAK_TIX_REQUESTER_EMAIL ?? "requester@acme.test");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/portal/, { timeout: 20_000 });

    await page.goto(url("/inbox"), { waitUntil: "load" });
    expect(new URL(page.url()).pathname).toBe("/portal");
  });
});

test.describe("OnTrak Tix identity administration", () => {
  test.skip(!BASE_URL, "set ONTRAK_TIX_BASE_URL to run the Tix sweep");

  const ADMIN = process.env.ONTRAK_TIX_ADMIN_EMAIL ?? "admin@acme.test";

  test("identity: an administrator sees the IdP connection form, WCAG A/AA clean", async ({ page }) => {
    await signIn(page, ADMIN);
    await auditPath(page, "/admin/identity");

    expect(await page.getByRole("heading", { name: "Identity", exact: true }).count()).toBe(1);
    // With no IdP yet, the form offers to configure one and says so plainly.
    await expect(page.locator("body")).toContainText("No identity provider is configured");
    // The redirect URI the IdP must register is spelled out, so setup is copy-paste.
    await expect(page.locator("body")).toContainText("/api/sso/callback");
    expect(await page.getByLabel("Role mappings").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Save connection" }).count()).toBe(1);
  });

  test("identity: a desk agent is turned away from tenant configuration", async ({ page }) => {
    await signIn(page); // the seeded agent, which lacks `tenant:manage`
    await page.goto(url("/admin/identity"), { waitUntil: "load" });
    expect(new URL(page.url()).pathname).toBe("/inbox");
  });
});
