/**
 * The webhook's two promises: the same fact always looks the same, and a
 * consumer can tell a delivery that came from us from one that did not.
 *
 * Everything here runs against the rules module alone — no HTTP, no database —
 * because those are the properties that have to hold on *both* ends of the wire.
 * The transport's own behaviour (a refusal is an outcome, not a throw) is
 * exercised where it lives.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/webhook.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_CHECKS,
  SIGNATURE_TOLERANCE_SEC,
  WEBHOOK_EVENT_VERSION,
  buildGradedEvent,
  eventId,
  gradedEventInput,
  readWebhookEvent,
  signatureHeader,
  verifySignature,
  webhookBody,
  type GradedFactSource,
} from "../src/lib/webhook-rules";
import {
  HttpWebhookNotifier,
  MAX_TIMEOUT_MS,
  describeWebhook,
  notifierFromConfig,
  webhookConfigFromEnv,
} from "../src/lib/webhook-client";

const SOURCE: GradedFactSource = {
  attemptId: "att_1",
  status: "GRADED",
  learner: { id: "u1", email: "ada@acme.test", name: "Ada" },
  scenario: { id: "s1", title: "Fix a broken NIC", platform: "LINUX" },
  cohort: { id: "c1", name: "Autumn intake" },
  score: 8,
  maxScore: 10,
  passScore: 7,
  startedAt: "2026-10-05T09:00:00.000Z",
  submittedAt: "2026-10-05T09:20:00.000Z",
  gradedAt: "2026-10-05T09:20:01.000Z",
  timeSpentSec: 1200,
  certificate: { code: "ONTRAK-ABCD-EF01-2345", digest: "ab".repeat(32), issuedAt: "2026-10-05T09:20:01.000Z", revokedAt: null },
  checks: [
    { checkId: "c1", label: "Interface is up", passed: true, points: 4, maxPoints: 4 },
    { checkId: "c2", label: "Route is present", passed: false, points: 0, maxPoints: 6 },
  ],
};

test("webhook: a fact's id depends on the grading, not on the delivery", () => {
  const first = eventId("attempt.graded", "att_1", SOURCE.gradedAt);
  const again = eventId("attempt.graded", "att_1", SOURCE.gradedAt);
  assert.equal(first, again, "the same grading must keep its id so a retry is recognisable");
  assert.notEqual(first, eventId("attempt.graded", "att_2", SOURCE.gradedAt));
  assert.notEqual(first, eventId("attempt.graded", "att_1", "2026-10-06T09:20:01.000Z"));
  assert.match(first, /^evt_[0-9a-f]{24}$/);
});

test("webhook: the body is canonical, so the same fact signs the same way", () => {
  const event = buildGradedEvent(gradedEventInput(SOURCE), "2026-10-05T09:20:02.000Z");
  const body = webhookBody(event);
  assert.ok(body.startsWith("{"));

  // Rebuilt from a differently-ordered object, the bytes are identical: the
  // signature is over the canonical form, not over whatever order JSON.stringify
  // happened to walk the object in.
  const shuffled = JSON.parse(body) as Record<string, unknown>;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(shuffled).reverse()) reversed[key] = shuffled[key];
  assert.equal(webhookBody(reversed as never), body);

  const parsed = readWebhookEvent(JSON.parse(body));
  assert.equal(parsed?.id, event.id);
  assert.equal(parsed?.event, "attempt.graded");
  assert.equal(parsed?.version, 1);
  assert.equal(parsed?.data.attemptId, "att_1");
  assert.equal(parsed?.data.mode, "simulated", "a fact with no stated mode was graded by the simulator");
});

test("webhook: the payload always states which mode graded the attempt", () => {
  // Additive on purpose: a consumer must be able to read `mode`, but a change of
  // that shape does not move the version it already understands.
  assert.equal(WEBHOOK_EVENT_VERSION, 1);

  assert.equal(gradedEventInput(SOURCE).mode, "simulated");
  assert.equal(gradedEventInput({ ...SOURCE, mode: "lab" }).mode, "lab");
  // An unrecognised value is not promoted to the stronger claim.
  assert.equal(gradedEventInput({ ...SOURCE, mode: "real-vm" }).mode, "simulated");

  const lab = buildGradedEvent(gradedEventInput({ ...SOURCE, mode: "lab" }), "2026-10-05T09:20:02.000Z");
  assert.equal(readWebhookEvent(JSON.parse(webhookBody(lab)))?.data.mode, "lab");
});

test("webhook: reading a body that is not an event gives nothing back", () => {
  assert.equal(readWebhookEvent(null), null);
  assert.equal(readWebhookEvent("{}"), null);
  assert.equal(readWebhookEvent({ id: "x" }), null);
  assert.equal(readWebhookEvent({ id: "x", event: "attempt.graded", deliveredAt: "now", data: [] }), null);
  const ok = readWebhookEvent({ id: "x", event: "attempt.graded", deliveredAt: "now", data: {} });
  assert.equal(ok?.id, "x");
});

test("webhook: a signature is refused without the secret, and refused when stale", () => {
  const body = webhookBody(buildGradedEvent(gradedEventInput(SOURCE), "2026-10-05T09:20:02.000Z"));
  const now = 1_759_660_802;
  const header = signatureHeader("s3cret", now, body);
  assert.match(header, /^t=1759660802,sha256=[0-9a-f]{64}$/);

  assert.equal(verifySignature("s3cret", header, body, now), true);
  assert.equal(verifySignature("s3cret", header, body, now + SIGNATURE_TOLERANCE_SEC), true, "inside the window");
  assert.equal(verifySignature("other", header, body, now), false);
  assert.equal(verifySignature("s3cret", header, `${body} `, now), false, "a changed body is a different signature");
  assert.equal(
    verifySignature("s3cret", header, body, now + SIGNATURE_TOLERANCE_SEC + 1),
    false,
    "a replay from outside the window is refused even though the hmac is right",
  );
  assert.equal(verifySignature("s3cret", "sha256=deadbeef", body, now), false);
  assert.equal(verifySignature("s3cret", null, body, now), false);
  assert.equal(verifySignature("", header, body, now), false);
});

test("webhook: the timestamp cannot be edited to widen the replay window", () => {
  const body = "{}";
  const header = signatureHeader("s3cret", 1_000, body);
  const forged = header.replace("t=1000", "t=2000");
  assert.equal(verifySignature("s3cret", forged, body, 2_000), false);
});

test("webhook: passing is decided from the scenario's own pass mark", () => {
  const passed = gradedEventInput(SOURCE);
  assert.equal(passed.passed, true);
  assert.equal(passed.passScore, 7);

  const failed = gradedEventInput({ ...SOURCE, score: 6 });
  assert.equal(failed.passed, false);

  // A scenario nobody scored has not been passed by scoring zero.
  const unscored = gradedEventInput({ ...SOURCE, score: 0, maxScore: 0, passScore: 0 });
  assert.equal(unscored.passed, false);
});

test("webhook: an unset URL is a configuration, a missing secret is a refusal", () => {
  assert.equal(webhookConfigFromEnv({}), null);
  assert.equal(webhookConfigFromEnv({ ONTRAK_WEBHOOK_URL: "   " }), null);

  const unsigned = webhookConfigFromEnv({ ONTRAK_WEBHOOK_URL: "https://lms.example/hook" });
  assert.equal(unsigned?.secret, "");
  assert.equal(
    notifierFromConfig(unsigned),
    null,
    "an unsigned webhook is a body anybody on the path can rewrite, so it is not sent",
  );
  assert.match(describeWebhook(unsigned), /ONTRAK_WEBHOOK_SECRET/);
  assert.match(describeWebhook(null), /no webhook consumer/);

  const signed = webhookConfigFromEnv({
    ONTRAK_WEBHOOK_URL: "https://lms.example/hook",
    ONTRAK_WEBHOOK_SECRET: "s3cret",
    ONTRAK_WEBHOOK_TIMEOUT_MS: "999999999",
  });
  assert.equal(signed?.timeoutMs, MAX_TIMEOUT_MS, "a timeout bigger than the cap is the cap");
  assert.equal(notifierFromConfig(signed)?.name, "http");
});

test("webhook: the transport answers with an outcome instead of throwing", async () => {
  const event = buildGradedEvent(gradedEventInput(SOURCE), "2026-10-05T09:20:02.000Z");

  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const ok = new HttpWebhookNotifier("https://lms.example/hook", "s3cret", 1000, {
    now: () => 1_759_660_802_000,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return { ok: true, status: 202, text: async () => "" } as Response;
    }) as unknown as typeof fetch,
  });
  const accepted = await ok.send(event);
  assert.deepEqual(accepted, { ok: true, status: 202, error: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://lms.example/hook");
  assert.equal(seen[0].body, webhookBody(event), "the bytes sent are the bytes signed");

  const refused = new HttpWebhookNotifier("https://lms.example/hook", "s3cret", 1000, {
    fetchImpl: (async () => ({ ok: false, status: 500, text: async () => "no thanks" }) as Response) as typeof fetch,
  });
  const outcome = await refused.send(event);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 500);
  assert.match(outcome.error ?? "", /no thanks/);

  const down = new HttpWebhookNotifier("https://lms.example/hook", "s3cret", 1000, {
    fetchImpl: (async () => {
      throw new Error("getaddrinfo ENOTFOUND lms.example");
    }) as unknown as typeof fetch,
  });
  const unreachable = await down.send(event);
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.status, null);
  assert.match(unreachable.error ?? "", /ENOTFOUND/);
});

test("webhook: a huge check list cannot become a consumer's problem", () => {
  const many = Array.from({ length: MAX_CHECKS + 50 }, (_, index) => ({
    checkId: `c${index}`,
    label: `check ${index}`,
    passed: true,
    points: 1,
    maxPoints: 1,
  }));
  const event = gradedEventInput({ ...SOURCE, checks: many });
  assert.equal(event.checks.length, MAX_CHECKS);
  assert.equal(event.checks[0].checkId, "c0");
});
