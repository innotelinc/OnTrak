/**
 * Live test: a lab reports a finished session to the *running* training app.
 *
 *   ONTRAK_LAB_LIVE=1 DATABASE_URL=postgresql://… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/lab-live.test.ts
 *
 * `tests/lab-completion.test.ts` proves the rulebook against fixtures — everything
 * except the app's own route, which needs a running server and a database.
 * `tests/result-filters.test.ts` proves the filters, but not that the query they
 * build selects the rows it claims to. This file is both of those parts: it boots
 * the app with an API token it sets itself, seeds a learner and a `lab`-tagged
 * scenario, and then reports a completion over HTTP exactly as OnTrak-dev would,
 * checking what the route *wrote* and what the feed then answers.
 *
 * It is opt-in twice over, like `tests/lti-live.test.ts`: `ONTRAK_LAB_LIVE=1` says
 * "start a server for this", and a reachable Postgres is required because a
 * completion writes an attempt, a check result and a certificate. Neither is true
 * in CI, so `npm test` skips it — and it removes everything it seeded, so a local
 * run leaves no trace.
 *
 * The assertions that matter most are the three a fixture test cannot make:
 * that `labSessionId` makes a retry idempotent, that the feed's `mode` filter
 * selects by grader against real rows, and that `passed` is decided by percentage
 * (an 8/10 attempt against a 70% mark passes — the bug this test was written to
 * catch).
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

const ENABLED = Boolean(process.env.ONTRAK_LAB_LIVE);
const PORT = Number(process.env.ONTRAK_LAB_LIVE_PORT ?? 3244);
const BASE = `http://127.0.0.1:${PORT}`;
const API_TOKEN = "lab-live-test-token-0123456789";
const AUTH_SECRET = "lab-live-test-secret-value-0123456789";

const LAB_DEFINITION = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  objective: "Fix the machine",
  brief: "A lab scenario graded on a live machine, not in the simulator.",
  tasks: ["Do the thing"],
  machine: { hostname: "workstation", user: "Administrator", os: "Windows 11", version: "23H2" },
  // Empty on purpose: the lab grades this one, so it is never published as simulated.
  checks: [],
};

async function reachable(): Promise<PrismaClient | null> {
  if (!process.env.DATABASE_URL) return null;
  const db = new PrismaClient();
  try {
    await db.$queryRaw`SELECT 1`;
    return db;
  } catch {
    await db.$disconnect().catch(() => undefined);
    return null;
  }
}

/**
 * Start the app the way a deployment would, with the token a lab reports with.
 *
 * `detached` so the whole process group can be signalled on the way out: `next dev`
 * is `npx` plus the server plus its workers, and killing only the wrapper leaves a
 * dev server holding the pipes — and the test process never exits.
 */
function startApp(): ChildProcess {
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      AUTH_SECRET,
      ONTRAK_API_TOKEN: API_TOKEN,
      ONTRAK_ISSUER: "Acme Training",
      ONTRAK_TRAINING_BASE_URL: BASE,
      // No webhook consumer: this test is about what the route writes, and an
      // unset URL keeps it from posting to somebody else's server.
      ONTRAK_WEBHOOK_URL: "",
      ONTRAK_WEBHOOK_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return child;
}

function stopApp(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function waitForApp(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the app never answered on /health");
}

async function reportCompletion(body: unknown, token = API_TOKEN): Promise<Response> {
  return fetch(`${BASE}/api/v1/lab/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("a lab completion is recorded once, filtered by mode, and graded by percentage", async (t) => {
  if (!ENABLED) {
    t.skip("set ONTRAK_LAB_LIVE=1 to run the live lab-completion test (it boots a server)");
    return;
  }
  const db = await reachable();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and apply the migrations");
    return;
  }

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const learnerEmail = `lab-live-${tag}@ontrak.local`;
  const labSlug = `lab-live-${tag}`;
  const simSlug = `sim-live-${tag}`;
  const sessionId = `sess-live-${tag}-1`;

  const instructor = await db.user.create({
    data: { email: `lab-live-instructor-${tag}@ontrak.local`, name: "Live Instructor", role: "INSTRUCTOR" },
  });
  const learner = await db.user.create({
    data: { email: learnerEmail, name: "Live Learner", role: "STUDENT" },
  });
  const labScenario = await db.scenario.create({
    data: {
      slug: labSlug,
      title: "Lab: live broken NIC",
      summary: "A lab scenario.",
      description: "A lab scenario graded on a live machine.",
      platform: "WINDOWS",
      engine: "powershell",
      definition: LAB_DEFINITION,
      tags: ["lab"],
      authorId: instructor.id,
    },
  });
  // A second scenario with the same shape but no `lab` tag, so the boundary's
  // refusal has something to refuse and the filter has something not to return.
  const simScenario = await db.scenario.create({
    data: {
      slug: simSlug,
      title: "Simulated: live broken NIC",
      summary: "A simulated scenario.",
      description: "A simulated scenario graded in the browser.",
      platform: "WINDOWS",
      engine: "powershell",
      definition: LAB_DEFINITION,
      tags: ["networking"],
      authorId: instructor.id,
    },
  });

  const app = startApp();
  try {
    await waitForApp(app);

    const body = {
      format: "ontrak.lab.completion/v1",
      sessionId,
      learnerEmail,
      scenarioSlug: labSlug,
      score: 8,
      maxScore: 10,
      passScore: 70,
      startedAt: "2026-10-05T09:00:00.000Z",
      completedAt: "2026-10-05T09:20:00.000Z",
      checks: [{ checkId: "nic-up", label: "NIC is up", passed: true, points: 4, maxPoints: 4 }],
    };

    // 1. The door is shut without the token, and shut with the wrong one.
    assert.equal((await reportCompletion(body, "")).status, 401, "no token is refused");
    assert.equal((await reportCompletion(body, "not-the-token")).status, 401, "a wrong token is refused");

    // 2. The completion is recorded.
    const created = await reportCompletion(body);
    assert.equal(created.status, 201, `expected 201, got ${created.status}: ${await created.clone().text()}`);
    const first = (await created.json()) as { ok: boolean; attemptId: string; created: boolean };
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.ok(first.attemptId);

    // 3. A retry is the *same* fact: same attempt id, nothing new written.
    const retried = await reportCompletion(body);
    assert.equal(retried.status, 200, "a duplicate is recognised, not created");
    const again = (await retried.json()) as { attemptId: string; created: boolean };
    assert.equal(again.attemptId, first.attemptId, "the retry answers with the attempt it already has");
    assert.equal(again.created, false);
    assert.equal(
      await db.attempt.count({ where: { labSessionId: sessionId } }),
      1,
      "one session id is one attempt",
    );

    // 4. What the route wrote: the mode, the outcome and the certificate.
    const row = await db.attempt.findUnique({
      where: { labSessionId: sessionId },
      select: {
        id: true,
        userId: true,
        scenarioId: true,
        status: true,
        gradingMode: true,
        score: true,
        maxScore: true,
        timeSpentSec: true,
        certificate: true,
        certificateIssuedAt: true,
        checkResults: { select: { checkId: true, passed: true } },
      },
    });
    assert.ok(row, "the attempt was written");
    assert.equal(row?.userId, learner.id, "the completion is filed against the learner it names");
    assert.equal(row?.scenarioId, labScenario.id, "and against the task it names");
    assert.equal(row?.status, "GRADED");
    assert.equal(row?.gradingMode, "lab", "the boundary records the lab as the grader");
    assert.equal(row?.score, 8);
    assert.equal(row?.maxScore, 10);
    assert.equal(row?.timeSpentSec, 1200, "20 minutes between start and completion");
    assert.deepEqual(row?.checkResults.map((check) => [check.checkId, check.passed]), [["nic-up", true]]);
    const certificate = row?.certificate as { mode?: string; percent?: number; digest?: string } | null;
    assert.equal(certificate?.mode, "lab", "the certificate says a live machine graded it");
    assert.equal(certificate?.percent, 80);
    assert.ok(certificate?.digest, "the certificate is a signed record");
    assert.ok(row?.certificateIssuedAt, "and it was issued");

    // 5. The evidence chain recorded the mode, not just the row.
    const audited = await db.auditLog.findFirst({
      where: { action: "attempt.lab_completion", targetId: first.attemptId },
      orderBy: { createdAt: "desc" },
    });
    const detail = (audited?.detail ?? {}) as { mode?: string; sessionId?: string };
    assert.equal(detail.mode, "lab");
    assert.equal(detail.sessionId, sessionId);

    // 6. The mode filter selects by grader against real rows — and the lab attempt
    //    is not in the simulated feed.
    const labFeed = await fetch(`${BASE}/api/v1/results?mode=lab`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert.equal(labFeed.status, 200);
    const labResults = (await labFeed.json()) as {
      results: { attemptId: string; mode: string; passed: boolean }[];
    };
    const ours = labResults.results.find((result) => result.attemptId === first.attemptId);
    assert.ok(ours, "the lab attempt is in the lab feed");
    assert.equal(ours?.mode, "lab");
    // 8/10 is 80%, which clears a 70% mark. Comparing a raw score to the percentage
    // mark said otherwise, which is the regression this line exists to catch.
    assert.equal(ours?.passed, true, "an 80% attempt clears a 70% mark");

    const simFeed = await fetch(`${BASE}/api/v1/results?mode=simulated`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    const simResults = (await simFeed.json()) as { results: { attemptId: string }[] };
    assert.equal(
      simResults.results.some((result) => result.attemptId === first.attemptId),
      false,
      "and it is not in the simulated feed",
    );

    // 7. The CSV carries the mode too, in the appended column.
    const csv = await fetch(`${BASE}/api/v1/results/export?mode=lab`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert.equal(csv.status, 200);
    const lines = (await csv.text()).split("\r\n");
    assert.ok(lines[0].endsWith(",mode"), "the mode is the last column");
    const line = lines.find((entry) => entry.startsWith(`${first.attemptId},`));
    assert.ok(line, "the lab attempt is in the CSV");
    assert.ok(line?.endsWith(",lab"), "and its mode cell says lab");
    assert.ok(line?.includes(",80,yes,"), "percent 80, passed yes");

    // 8. A body that cannot be placed is refused, with every problem named.
    const malformed = await reportCompletion({ sessionId: "has space", score: 1.5, completedAt: "nope" });
    assert.equal(malformed.status, 422);
    const reported = (await malformed.json()) as { error: string; issues: string[] };
    assert.ok(Array.isArray(reported.issues) && reported.issues.length >= 3, "every problem is listed");

    // 9. A completion filed against a task the lab does not own is refused: the
    //    task's declared mode and its evidence may not disagree.
    const wrongTask = await reportCompletion({ ...body, sessionId: `${sessionId}-2`, scenarioSlug: simSlug });
    assert.equal(wrongTask.status, 422);
    const refusal = (await wrongTask.json()) as { error: string };
    assert.match(refusal.error, /not a lab scenario/);
    assert.equal(
      await db.attempt.count({ where: { scenarioId: simScenario.id } }),
      0,
      "nothing was written against the simulated task",
    );
  } finally {
    stopApp(app);
    // Leave nothing behind. Deliveries and the audit trail have no cascade from the
    // attempt, so they go first; deleting the scenarios then cascades the attempts
    // and their check results; the users last.
    const attempts = await db.attempt.findMany({
      where: { labSessionId: { startsWith: `sess-live-${tag}` } },
      select: { id: true },
    });
    const attemptIds = attempts.map((attempt) => attempt.id);
    if (attemptIds.length > 0) {
      await db.webhookDelivery.deleteMany({ where: { attemptId: { in: attemptIds } } }).catch(() => undefined);
      await db.auditLog.deleteMany({ where: { targetId: { in: attemptIds } } }).catch(() => undefined);
    }
    await db.scenario.deleteMany({ where: { slug: { in: [labSlug, simSlug] } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: [learner.id, instructor.id] } } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
