/**
 * A re-grade, through the real server action.
 *
 * `tests/certificates.test.ts` covers the *decision* — issue, keep or revoke — as
 * a pure function. This spec covers the wiring that cannot: a signed-in
 * instructor clicking **Re-grade now** on a real attempt, and the certificate
 * issued for it being revoked because the corrected grading no longer passes.
 *
 * It brings its own attempt rather than re-grading the seeded one, so a run never
 * costs the demo its certificate (`a11y.spec.ts` audits that page), and it removes
 * the attempt again afterwards. Like the a11y sweep it skips, rather than fails,
 * when the demo accounts or the seed are not there.
 */

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import { certificateForAttempt } from "../../src/lib/certificates";

const PASSWORD = process.env.ONTRAK_A11Y_PASSWORD ?? "ontrak-demo";
const STUDENT_EMAIL = process.env.ONTRAK_A11Y_EMAIL ?? "student@ontrak.local";
const INSTRUCTOR_EMAIL = process.env.ONTRAK_A11Y_INSTRUCTOR_EMAIL ?? "instructor@ontrak.local";

/** Unique to this spec, so a parallel a11y run never collides with it. */
const FIXTURE_ID = "regrade-spec-attempt";
const SEEDED_SCENARIO = "first-line-mailbox-triage";

const prisma = new PrismaClient();

async function signIn(page: Page, email: string): Promise<boolean> {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }).catch(() => undefined);
  return !page.url().includes("/login");
}

/**
 * Plant a graded pass: a stored certificate and **no snapshot**, so a re-grade
 * scores the attempt from an empty machine and the pass it was certified on falls
 * away. Returns the scenario's pass mark, or `null` when the demo is not seeded.
 */
async function plantCertifiedAttempt(): Promise<number | null> {
  const student = await prisma.user.findUnique({ where: { email: STUDENT_EMAIL }, select: { id: true, name: true } });
  const scenario = await prisma.scenario.findUnique({
    where: { slug: SEEDED_SCENARIO },
    select: { id: true, title: true, platform: true, passScore: true, tags: true },
  });
  if (!student || !scenario) return null;

  const gradedAt = new Date(Date.now() - 60 * 60 * 1000);
  const record = certificateForAttempt({
    learnerId: student.id,
    learnerName: student.name,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    platform: scenario.platform,
    score: 12,
    maxScore: 12,
    passScore: scenario.passScore,
    completedAt: gradedAt,
    skills: scenario.tags,
  });

  await prisma.attempt.deleteMany({ where: { id: FIXTURE_ID } });
  await prisma.attempt.create({
    data: {
      id: FIXTURE_ID,
      userId: student.id,
      scenarioId: scenario.id,
      status: "GRADED",
      startedAt: gradedAt,
      expiresAt: new Date(gradedAt.getTime() + 30 * 60 * 1000),
      submittedAt: gradedAt,
      gradedAt,
      timeSpentSec: 900,
      score: 12,
      maxScore: 12,
      seed: "regrade-spec",
      certificate: record as unknown as Prisma.InputJsonValue,
      certificateIssuedAt: gradedAt,
      certificateRevokedAt: null,
    },
  });

  return scenario.passScore;
}

test.afterAll(async () => {
  // Deleting the attempt cascades to the check results the re-grade wrote.
  await prisma.attempt.deleteMany({ where: { id: FIXTURE_ID } });
  await prisma.$disconnect();
});

test.describe("re-grading a certified attempt", () => {
  test("a re-grade that fails the attempt revokes its certificate", async ({ page }) => {
    test.skip(!(await signIn(page, INSTRUCTOR_EMAIL)), "no seeded instructor account");

    const passScore = await plantCertifiedAttempt();
    test.skip(passScore === null, `no seeded "${SEEDED_SCENARIO}" scenario to grade against`);

    // An instructor can see it and re-grade it in the first place.
    await page.goto(`/instructor/attempts/${FIXTURE_ID}`, { waitUntil: "load" });
    const regrade = page.getByRole("button", { name: /re-?grade now/i });
    await expect(regrade).toBeVisible();
    await regrade.click();

    await page.waitForLoadState("load");
    await expect(page.getByText(/certificate issued for this attempt has been revoked/i)).toBeVisible({
      timeout: 20_000,
    });

    const stored = await prisma.attempt.findUnique({
      where: { id: FIXTURE_ID },
      select: {
        score: true,
        maxScore: true,
        certificate: true,
        certificateIssuedAt: true,
        certificateRevokedAt: true,
      },
    });

    expect(stored?.certificateRevokedAt).not.toBeNull();
    // The record itself is kept: the artifact the learner holds stays intact, and
    // it is the revocation that says the pass no longer stands.
    expect(stored?.certificate).not.toBeNull();
    expect(stored?.certificateIssuedAt).not.toBeNull();
    // The score the re-grade computed is what decided the revocation.
    const percent = ((stored?.score ?? 0) / (stored?.maxScore || 1)) * 100;
    expect(percent).toBeLessThan(passScore ?? 70);

    // And the report shows the revocation rather than hiding it.
    await page.goto(`/student/results/${FIXTURE_ID}`, { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: /certificate revoked/i })).toBeVisible();
    await expect(page.getByText(/no longer stands/i)).toBeVisible();
  });
});
