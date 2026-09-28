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

/** Hand the browser to somebody else, the way two people share a desk. */
async function switchUser(page: Page, email: string): Promise<void> {
  await page.goto(url("/notifications"), { waitUntil: "load" });
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(/\/sign-in/, { timeout: 20_000 });
  await signIn(page, email);
}

const ADMIN = process.env.ONTRAK_TIX_ADMIN_EMAIL ?? "admin@acme.test";
const AGENT_NAME = "Sam Agent";

test.describe("OnTrak Tix desk", () => {
  test.skip(!BASE_URL, "set ONTRAK_TIX_BASE_URL to run the Tix sweep");

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  const staffPaths = [
    "/inbox",
    "/reports",
    "/notifications",
    "/canned",
    "/templates",
    "/inbox/new",
    "/security",
    "/incidents",
    "/incidents/templates",
    "/clients",
    "/time",
  ];

  test("a11y (browser): the public survey page passes WCAG A/AA with a token nobody holds", async ({ page }) => {
    // The one page in the product a stranger reaches: it still has to be readable.
    await auditPath(page, "/survey/not-a-real-token");
    await expect(page.locator("body")).toContainText("That survey link is not valid");
  });

  for (const path of staffPaths) {
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

  test("incidents: a regulatory clock is tracked, drafted, sent and acknowledged", async ({ page }) => {
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

    // A second duty is drafted from the regime's own words rather than typed:
    // the console offers the message with this incident's facts already in it.
    await card.getByRole("button", { name: "Track NIS2 incident notification" }).click();
    await expect(page.locator("body")).toContainText(/NIS2 incident notification is now tracked/, { timeout: 20_000 });
    const incidentDuty = card.locator("li").filter({ hasText: "NIS2 incident notification" }).first();
    await incidentDuty.getByText(/^Draft this notice/).click();
    await expect(incidentDuty).toContainText("Incident notification to the authority");
    const notice = incidentDuty.locator('textarea[name="message"]');
    await expect(notice).toHaveValue(/Incident notification — INC-\d+/);
    await expect(notice).toHaveValue(new RegExp(`Notification sweep ${stamp}`));

    await incidentDuty.getByPlaceholder("reference for this notice (optional)").fill("CSIRT-2026-0043");
    await incidentDuty.getByRole("button", { name: "Record this notice as sent" }).click();
    await expect(page.locator("body")).toContainText(/with the notice text on the record/, { timeout: 20_000 });
    // What went out is on the record, verbatim, next to the duty it answered.
    await expect(incidentDuty).toContainText("Notice text as sent");
    await expect(incidentDuty).toContainText("CSIRT-2026-0043");
    await expect(incidentDuty).toContainText(/Incident notification — INC-\d+/);
  });

  test("incidents: a draft the desk writes is offered on its duty", async ({ page }) => {
    // Write a draft of our own, aimed at a regime…
    await page.goto(url("/incidents/templates"), { waitUntil: "load" });
    const stamp = Date.now();
    const label = `Contract notice ${stamp}`;
    await page.getByLabel("Name").fill(label);
    await page.getByLabel("Who it goes to").selectOption("CLIENT");
    await page.getByRole("checkbox", { name: "Client contract breach notice" }).check();
    await page.getByLabel("Subject").fill(`Service notice — {{ref}} (${stamp})`);
    await page.getByLabel("Body").fill("Dear {{requester}},\n\n{{ref}} — we are responding. Contact {{author}} at {{tenant}}.");
    await page.getByLabel("What it must not forget (optional, one line)").fill("Say what is affected before saying what happened.");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.locator("body")).toContainText(`${label} can now be drafted on a duty.`, { timeout: 20_000 });
    await expect(page.locator("body")).toContainText("Say what is affected before saying what happened.");

    // …and see it offered first on an incident that owes that notice.
    await page.goto(url("/incidents"), { waitUntil: "load" });
    await page.getByLabel("Title").fill(`Draft sweep ${stamp}`);
    await page.getByLabel("Summary").fill("Exercises a desk's own notification draft.");
    await page.locator('select[name="impact"]').selectOption("EXTENSIVE");
    await page.locator('select[name="urgency"]').selectOption("CRITICAL");
    await page.getByRole("button", { name: "Declare incident" }).click();
    await expect(page.locator("body")).toContainText(/INC-\d+/, { timeout: 20_000 });

    const card = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Draft sweep ${stamp}`, exact: true }) })
      .first();
    await card.getByRole("button", { name: "Track Client contract breach notice" }).click();
    await expect(page.locator("body")).toContainText(/is now tracked/, { timeout: 20_000 });

    const duty = card.locator("li").filter({ hasText: "Client contract breach notice" }).first();
    await duty.getByText(/^Draft this notice/).click();
    await expect(duty).toContainText(label);
    // The desk's wording is offered ahead of the shipped one, and marked as theirs.
    await expect(duty).toContainText("yours");
    // Ours is offered first and the shipped one still follows it. (The draft is
    // retired at the end of this test, so the tenant stays free of sweep residue.)
    const drafts = duty.locator('textarea[name="message"]');
    await expect(drafts).toHaveCount(2);
    await expect(drafts.first()).toHaveValue(new RegExp(`Service notice — INC-\\d+ \\(${stamp}\\)`));
    await expect(drafts.first()).toHaveValue(/Contact .+ at Acme/);
    await expect(drafts.nth(1)).toHaveValue(/Service incident notice/);

    // Retiring the draft stops it being offered and leaves it readable, so a
    // notice that cited it stays explainable. (It also keeps this sweep from
    // piling drafts up in the demo tenant on every run.)
    await page.goto(url("/incidents/templates"), { waitUntil: "load" });
    const ours = page.locator("li").filter({ hasText: label }).first();
    await ours.getByRole("button", { name: "Retire" }).click();
    await expect(page.locator("body")).toContainText(`${label} retired.`, { timeout: 20_000 });
    await expect(page.locator("body")).toContainText("Retired");
    await expect(page.locator("li").filter({ hasText: label }).first()).toContainText("Offer again");

    // …and the duty it named goes back to the shipped wording, then records it.
    await page.goto(url("/incidents"), { waitUntil: "load" });
    const after = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Draft sweep ${stamp}`, exact: true }) })
      .first();
    const afterDuty = after.locator("li").filter({ hasText: "Client contract breach notice" }).first();
    await afterDuty.getByText(/^Draft this notice/).click();
    await expect(afterDuty).not.toContainText(label);
    await expect(afterDuty).toContainText("Service incident notice");

    // The shipped draft leaves a field only a person can fill, and the service
    // refuses to record it while that field is blank — in the browser's words,
    // not a stack trace. Filling it in is what makes it sendable.
    await afterDuty.getByRole("button", { name: "Record this notice as sent" }).first().click();
    await expect(page.locator("body")).toContainText(/Still to fill in: \{\{servicesAffected\}\}/, { timeout: 20_000 });

    const reopened = page
      .locator("li")
      .filter({ has: page.getByRole("heading", { name: `Draft sweep ${stamp}`, exact: true }) })
      .first()
      .locator("li")
      .filter({ hasText: "Client contract breach notice" })
      .first();
    // React does not own the `<details>` open flag, so a soft navigation can
    // leave the panel open — only click the summary when it is closed.
    const notice = reopened.locator('textarea[name="message"]').first();
    if (!(await notice.isVisible())) await reopened.getByText(/^Draft this notice/).click();
    await expect(notice).toBeVisible();
    await notice.fill((await notice.inputValue()).replace("{{servicesAffected}}", "mail and file services"));
    await reopened.getByRole("button", { name: "Record this notice as sent" }).first().click();
    await expect(page.locator("body")).toContainText(/with the notice text on the record/, { timeout: 20_000 });
    await expect(reopened).toContainText("Notice text as sent");
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

  test("clients: the console records a client, its promise, a contact and an acted-as window", async ({ page }) => {
    // The multi-client console is a manager's, so the seeded agent signs out of it.
    await switchUser(page, ADMIN);

    const stamp = Date.now();
    const name = `Northwind sweep ${stamp}`;
    await page.goto(url("/clients"), { waitUntil: "load" });
    expect(await page.getByRole("heading", { name: "Clients", exact: true }).count()).toBe(1);

    await page.getByLabel("New client").fill(name);
    await page.getByRole("button", { name: "Add client" }).click();
    await expect(page.locator("body")).toContainText(`${name} added.`, { timeout: 20_000 });

    const card = page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) }).first();
    await expect(card).toBeVisible();
    // The promise is stated per priority, and every rung says *which* policy
    // answered: a client with no policy of its own falls through to the desk's and
    // the console admits it rather than implying the promise is the client's.
    await expect(card).toContainText("the tenant's URGENT policy");
    await expect(card).toContainText("the tenant's fallback policy");

    // A contact, because a client nothing can reach is not a client.
    await card.getByLabel("Contact name").fill("Dana Reyes");
    await card.getByLabel("Email").fill(`dana.${stamp}@northwind.test`);
    await card.getByRole("button", { name: "Add contact" }).click();
    await expect(page.locator("body")).toContainText("Dana Reyes added as a contact.", { timeout: 20_000 });
    await expect(card).toContainText("1 contact");

    // Looking through the client's eyes takes a reason, says so while it is live,
    // and is a window somebody has to close again.
    await card.getByLabel("Reason to act as this client").fill("reproducing their complaint");
    await card.getByRole("button", { name: "Act as client" }).click();
    await expect(page.locator("body")).toContainText("Acting as the client until", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: `Acting as ${name}` })).toHaveCount(1);
    await expect(page.locator("body")).toContainText("reproducing their complaint");

    await page.getByRole("button", { name: "Stop acting as the client" }).click();
    await expect(page.locator("body")).toContainText("No longer acting as the client.", { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: `Acting as ${name}` })).toHaveCount(0);
  });

  test("clients: a client's work is in scope only for the people assigned to it", async ({ page }) => {
    await switchUser(page, ADMIN);
    await page.goto(url("/clients"), { waitUntil: "load" });

    const stamp = Date.now();
    const assigned = `Assigned sweep ${stamp}`;
    const other = `Other desk sweep ${stamp}`;
    for (const name of [assigned, other]) {
      await page.getByLabel("New client").fill(name);
      await page.getByRole("button", { name: "Add client" }).click();
      await expect(page.locator("body")).toContainText(`${name} added.`, { timeout: 20_000 });
    }

    // Put the seeded agent on one of them, and leave the other with nobody.
    const card = page.locator("li").filter({ has: page.getByRole("heading", { name: assigned, exact: true }) }).first();
    await card.getByLabel("Assign someone").selectOption({ label: `${AGENT_NAME} (AGENT)` });
    await card.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(page.locator("body")).toContainText("Assignment recorded.", { timeout: 20_000 });
    await expect(card).toContainText("Served by:");
    await expect(card).toContainText(AGENT_NAME);

    // Through the agent's eyes: the client they serve is here, the one they do not
    // is not, and the console offers them no way to change any of it.
    await switchUser(page, EMAIL);
    await page.goto(url("/clients"), { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: assigned, exact: true })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: other, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add client" })).toHaveCount(0);
    await expect(page.locator("body")).toContainText("You can see the clients in your scope but not change them.");
  });

  test("time: an hour is logged on a ticket, priced by a rate card, and frozen by the invoice that bills it", async ({ page }) => {
    // Money is a manager's: the seeded agent does not write rates or issue invoices.
    await switchUser(page, ADMIN);
    const stamp = Date.now();

    // A rate card for the desk's own work, which is what a ticket with no client
    // is. This is read back in the confirmation, so the ladder is visible.
    await page.goto(url("/clients"), { waitUntil: "load" });
    const deskCard = page.locator("section", { has: page.getByRole("heading", { name: "The desk's own rate card" }) });
    await deskCard.getByLabel("Card name").fill(`Desk standard ${stamp}`);
    await deskCard.getByLabel("Currency").fill("USD");
    await deskCard.getByLabel("Per hour").fill("145.00");
    await deskCard.getByLabel("Rounding").selectOption("15");
    await deskCard.getByRole("button", { name: /^(Set|Save) rate card$/ }).click();
    await expect(page.locator("body")).toContainText("145.00 USD/hour", { timeout: 20_000 });

    // A ticket of this sweep's own, so the hours it logs and bills cannot be
    // somebody else's work and the run stays repeatable.
    await page.goto(url("/inbox/new"), { waitUntil: "load" });
    await page.getByLabel("Subject").fill(`Time sweep ${stamp}`);
    await page.getByLabel("Description").fill("Exercises logging an hour and billing it.");
    await page.getByRole("button", { name: "Create ticket" }).click();
    await page.waitForURL(/\/inbox\/[^/?]+\?flash=/, { timeout: 20_000 });

    const timePanel = page.getByRole("region", { name: "Time on this ticket" });
    await timePanel.getByLabel("Minutes").fill("20");
    await timePanel.getByLabel("What was done (optional)").fill("sweep: rebuilt the print queue");
    await timePanel.getByRole("button", { name: "Log time" }).click();
    await expect(page.locator("body")).toContainText("20 minutes logged.", { timeout: 20_000 });
    // 20 minutes on a 15-minute increment is charged as 30, and the panel says so.
    await expect(timePanel).toContainText("billed 30m");

    // Issue the invoice for the desk's own time, over the period on screen.
    await page.goto(url("/time?client=desk"), { waitUntil: "load" });
    await expect(page.locator("body")).toContainText("sweep: rebuilt the print queue");
    await page.getByRole("button", { name: /Issue invoice for/ }).click();
    await expect(page.locator("body")).toContainText(/Invoice INV-\d+-[A-Z0-9]+ issued/, { timeout: 20_000 });

    // The reference is a link to a *read* of the invoice, and the hours it covered
    // are now frozen: correcting them is what a credit note is for.
    const issued = page.getByRole("link", { name: /Download INV-.* as CSV/ });
    await expect(issued).toHaveCount(1);
    await expect(page.locator("body")).toContainText(/On INV-\d+-[A-Z0-9]+: frozen/);

    const csv = await page.request.get(url((await issued.getAttribute("href")) as string));
    expect(csv.status()).toBe(200);
    const body = await csv.text();
    expect(body).toContain("Billed minutes");
    expect(body).toContain("30,0.50,");
    expect(body).not.toContain("$");
  });

  test("clients: a client is asked for a rating, and answers it from the link", async ({ page }) => {
    await switchUser(page, ADMIN);
    const stamp = Date.now();
    const name = `Rating sweep ${stamp}`;

    await page.goto(url("/clients"), { waitUntil: "load" });
    await page.getByLabel("New client").fill(name);
    await page.getByRole("button", { name: "Add client" }).click();
    await expect(page.locator("body")).toContainText(`${name} added.`, { timeout: 20_000 });

    const card = page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) }).first();
    await card.getByRole("button", { name: "Ask for a rating" }).click();
    await expect(page.locator("body")).toContainText("Survey link ready for that period", { timeout: 20_000 });
    await expect(card).toContainText("awaiting an answer");

    // The client's own person follows the link. No account, no sign-in: the token
    // is the whole credential, so this is the one page a stranger can answer.
    await card.getByRole("link", { name: "open the link they were sent" }).click();
    await page.waitForURL(/\/survey\//, { timeout: 20_000 });
    await expect(page.locator("body")).toContainText(`How was ${name}'s support between`);
    await page.getByRole("radio", { name: /5 — Very satisfied/ }).check();
    await page.getByLabel("Anything you want to add (optional)").fill("sweep: quick and clear");
    await page.getByRole("button", { name: "Send my answer" }).click();
    await expect(page.locator("body")).toContainText("Thank you — your answer is recorded.", { timeout: 20_000 });
    await expect(page.locator("body")).toContainText("quick and clear");

    // …and the desk sees it back on the client, with the score spelled out.
    await page.goto(url("/clients"), { waitUntil: "load" });
    const answered = page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) }).first();
    await expect(answered).toContainText("5/5 — Very satisfied");
    await expect(answered).toContainText("quick and clear");
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
