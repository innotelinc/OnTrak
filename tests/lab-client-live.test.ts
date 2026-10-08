/**
 * Live test: the lab's *own* client reports to the running app.
 *
 *   ONTRAK_LAB_CLIENT_LIVE=1 DATABASE_URL=postgresql://… \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/lab-client-live.test.ts
 *
 * Two suites already cover the halves of this boundary: `tests/lab-live.test.ts`
 * drives the route with `fetch` and a JSON body it writes itself, and the client's
 * 28 unittest cases cover its payload against a stubbed transport. Neither proves
 * the thing that actually has to work, which is that the client's real request
 * arrives, is understood, and is mapped back to the right outcome. That is this
 * file: it boots the app, seeds a learner and a `lab`-tagged scenario, and runs
 * `integrations/lab-completion-client/tests/live_probe.py` as a subprocess, using
 * only the client's public API — the same interface a lab host installs.
 *
 * Opt-in twice over, like the other live tests: `ONTRAK_LAB_CLIENT_LIVE=1` says
 * "start a server for this", and a reachable Postgres is required because a
 * completion writes an attempt, a check result and a certificate. `python3` has to
 * exist as well, and the test says so rather than failing obscurely. `npm test`
 * skips it, and it removes everything it seeds.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

const ENABLED = Boolean(process.env.ONTRAK_LAB_CLIENT_LIVE);
const PORT = Number(process.env.ONTRAK_LAB_CLIENT_LIVE_PORT ?? 3245);
const BASE = `http://127.0.0.1:${PORT}`;
const API_TOKEN = "lab-client-live-token-0123456789";
const AUTH_SECRET = "lab-client-live-secret-value-0123456789";
const CLIENT_DIR = `${process.cwd()}/integrations/lab-completion-client`;
const PROBE = `${CLIENT_DIR}/tests/live_probe.py`;

const LAB_DEFINITION = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Fix the machine",
  brief: "A lab scenario graded on a live machine, not in the simulator.",
  tasks: ["Do the thing"],
  machine: { hostname: "server01", user: "student", os: "Ubuntu 24.04.2 LTS", version: "24.04" },
  // Empty on purpose: the lab grades this one.
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

function pythonAvailable(): boolean {
  return spawnSync("python3", ["--version"]).status === 0;
}

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
      // No webhook consumer: this test is about what the client sends and what
      // the route writes, not about a second delivery.
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

interface ProbeOutcome {
  ok: boolean;
  attempt_id?: string;
  created?: boolean;
  status: number;
  error?: string;
  issues?: string[];
  detail?: string;
}

/** One run of the shipping client, as a lab host would invoke it. */
function probe(session: string, slug: string, email: string, token = API_TOKEN): ProbeOutcome {
  const run = spawnSync("python3", [PROBE, CLIENT_DIR, BASE, session, slug, email, token], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const last = (run.stdout ?? "").trim().split("\n").at(-1) ?? "";
  assert.notEqual(last, "", `the client printed nothing; stderr was:\n${run.stderr}`);
  const outcome = JSON.parse(last) as ProbeOutcome;
  assert.equal(run.status, 0, `the client crashed rather than answering:\n${outcome.detail ?? run.stderr}`);
  return outcome;
}

test("the lab's own client reports a completion to the running app, once", async (t) => {
  if (!ENABLED) {
    t.skip("set ONTRAK_LAB_CLIENT_LIVE=1 to run the live lab-client test (it boots a server)");
    return;
  }
  const db = await reachable();
  if (!db) {
    t.skip("no Postgres reachable — set DATABASE_URL and apply the migrations");
    return;
  }
  if (!pythonAvailable()) {
    t.skip("no python3 on PATH — the lab's client is Python, so this one needs it");
    return;
  }

  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const sessionId = `sess-pyc-${tag}`;
  const learnerEmail = `lab-client-${tag}@ontrak.local`;
  const slug = `lab-client-${tag}`;
  let child: ChildProcess | null = null;
  let instructorId: string | null = null;
  let learnerId: string | null = null;

  try {
    const instructor = await db.user.create({
      data: { email: `lab-client-instructor-${tag}@ontrak.local`, name: "Client Instructor", role: "INSTRUCTOR" },
    });
    instructorId = instructor.id;
    const learner = await db.user.create({
      data: { email: learnerEmail, name: "Client Learner", role: "STUDENT" },
    });
    learnerId = learner.id;
    await db.scenario.create({
      data: {
        slug,
        title: "Lab: live broken NIC",
        summary: "A lab scenario.",
        description: "A lab scenario graded on a live machine.",
        platform: "LINUX",
        engine: "bash",
        definition: LAB_DEFINITION,
        tags: ["lab"],
        authorId: instructor.id,
      },
    });

    child = startApp();
    await waitForApp(child);

    // 1. A first delivery is created, and the client reads the attempt it made.
    const first = probe(sessionId, slug, learnerEmail);
    assert.equal(first.ok, true, `the client reported a failure: ${JSON.stringify(first)}`);
    assert.equal(first.status, 201, "a first delivery is a creation");
    assert.equal(first.created, true);
    assert.ok(first.attempt_id, "the client read the attempt id off the body");

    // 2. The same session reported again is recognised, not duplicated: the
    //    session id is the idempotency key, which is what makes a lab's retry safe.
    const second = probe(sessionId, slug, learnerEmail);
    assert.equal(second.status, 200, `expected the retry to be recognised: ${JSON.stringify(second)}`);
    assert.equal(second.created, false);
    assert.equal(second.attempt_id, first.attempt_id, "one attempt per session id");

    // 3. A wrong token is the client's own refusal class, derived from the real 401.
    const refused = probe(`sess-pyc-bad-${tag}`, slug, learnerEmail, "not-the-token");
    assert.equal(refused.ok, false, `expected a refusal: ${JSON.stringify(refused)}`);
    assert.equal(refused.error, "refused");
    assert.equal(refused.status, 401);

    // 4. What the route wrote, one row for the session however often it was sent.
    const rows = await db.attempt.findMany({
      where: { labSessionId: sessionId },
      select: { gradingMode: true, status: true, score: true, maxScore: true, certificate: true },
    });
    assert.equal(rows.length, 1, "one row for the session, however many times it was reported");
    assert.equal(rows[0].gradingMode, "lab", "the client's completion is recorded as a lab grading");
    assert.equal(rows[0].status, "GRADED");
    assert.equal(rows[0].score, 8);
    assert.equal(rows[0].maxScore, 10);

    // The stored column *is* the completion record (see certificate-rules.ts).
    const certificate = rows[0].certificate as { mode?: string; percent?: number; digest?: string } | null;
    assert.equal(certificate?.mode, "lab", "the certificate says a live machine graded it");
    assert.equal(certificate?.percent, 80);
    assert.ok(certificate?.digest, "the certificate is a signed record");
  } finally {
    stopApp(child ?? ({ pid: undefined } as ChildProcess));
    // Leave nothing behind. Deliveries and the audit trail have no cascade from the
    // attempt, so they go first; deleting the scenario then cascades the attempt and
    // its check results; the users last.
    const seeded = await db.attempt
      .findMany({ where: { labSessionId: { startsWith: "sess-pyc-" } }, select: { id: true } })
      .catch(() => []);
    const attemptIds = seeded.map((attempt) => attempt.id);
    if (attemptIds.length > 0) {
      await db.webhookDelivery.deleteMany({ where: { attemptId: { in: attemptIds } } }).catch(() => undefined);
      await db.auditLog.deleteMany({ where: { targetId: { in: attemptIds } } }).catch(() => undefined);
    }
    await db.scenario.deleteMany({ where: { slug } }).catch(() => undefined);
    await db.user
      .deleteMany({ where: { id: { in: [learnerId, instructorId].filter((id): id is string => Boolean(id)) } } })
      .catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
