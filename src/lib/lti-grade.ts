/**
 * Grade passback: the half of LTI that makes it worth launching from an LMS.
 *
 * A launch that only signs somebody in is a doorway; what an instructor actually
 * asked for is that the result of the work comes back to the gradebook they are
 * already using. So a graded attempt that began as a launch writes its score to
 * the line item the platform named.
 *
 * Three rules shape this, and they are the same three the webhook path follows:
 *
 *  * **The attempt carries the context, not the session.** Grading happens later,
 *    and an instructor may be the one re-grading, so the line item has to be a
 *    property of the attempt.
 *  * **A missing passback never fails the grading.** A learner's score is real
 *    whether or not somebody else's server accepted a copy of it.
 *  * **A passback that cannot happen says why.** No line item, no scope, no
 *    credentials: three different facts to an operator, so they get three
 *    different sentences (`passbackRefusal`).
 */

import { prisma } from "./db";
import { HttpLtiClient, type LtiClient } from "./lti-client";
import {
  activeLtiConfig,
  agsScore,
  isLtiLaunchFacts,
  launchFactsExpired,
  passbackRefusal,
  type LtiConfig,
  type LtiLaunchFacts,
} from "./lti-rules";

export interface LtiPassbackRuntime {
  client: LtiClient;
  /** `null` when the deployment has no token endpoint or key: launches still work. */
  config: LtiConfig | null;
}

/**
 * The runtime, from the environment.
 *
 * Built once and memoised because it holds no per-request state but does hold a
 * registration; `resetLtiRuntime` exists so a test can change the environment and
 * see the change, which is the same shape the webhook runtime uses.
 */
let cached: { runtime: LtiPassbackRuntime | null } | null = null;

export function ltiRuntime(): LtiPassbackRuntime | null {
  if (cached) return cached.runtime;
  const config = activeLtiConfig();
  const runtime = config ? { client: new HttpLtiClient(), config } : null;
  cached = { runtime };
  return runtime;
}

export function resetLtiRuntime(): void {
  cached = null;
}

export type PassbackStatus = "SKIPPED" | "DELIVERED" | "FAILED";

export interface PassbackOutcome {
  status: PassbackStatus;
  /** Why nothing was written, or why the write failed. Never a success message. */
  reason: string | null;
}

/**
 * Write a graded attempt's score back to the platform that launched it.
 *
 * Resolves with what happened rather than throwing, because every caller is a
 * grading path that has already finished its actual job.
 */
export async function passBackScore(
  attemptId: string,
  runtime: LtiPassbackRuntime | null = ltiRuntime(),
): Promise<PassbackOutcome> {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      score: true,
      maxScore: true,
      gradedAt: true,
      submittedAt: true,
      startedAt: true,
      ltiLaunch: true,
    },
  });
  if (!attempt) return { status: "SKIPPED", reason: "That attempt no longer exists." };

  const raw = attempt.ltiLaunch;
  const facts: LtiLaunchFacts | null = isLtiLaunchFacts(raw) ? raw : null;
  const refusal = passbackRefusal(facts, Boolean(runtime?.config?.tokenEndpoint && runtime?.config?.privateKey));
  if (refusal || !facts?.lineItem) return { status: "SKIPPED", reason: refusal ?? "Nothing to send." };
  if (launchFactsExpired(facts, new Date().toISOString())) {
    return { status: "SKIPPED", reason: "This attempt was launched too long ago for the platform's context to still apply." };
  }
  if (!runtime) return { status: "SKIPPED", reason: "This deployment does not have a learning platform configured." };

  const gradedAt = (attempt.gradedAt ?? attempt.submittedAt ?? attempt.startedAt).toISOString();
  const posted = await runtime.client.postScore({
    lineItem: facts.lineItem,
    score: agsScore({
      score: attempt.score,
      maxScore: attempt.maxScore,
      subject: facts.subject,
      gradedAt,
    }),
  });

  return posted.ok
    ? { status: "DELIVERED", reason: null }
    : { status: "FAILED", reason: posted.error ?? `The platform answered ${posted.status}.` };
}

/**
 * Pass a grade back without ever letting it break the grading.
 *
 * The counterpart of `announceGraded` for the platform the attempt came from, and
 * the same contract: the score here is already saved, so anything that goes wrong
 * out there is a log line.
 */
export async function announceScore(attemptId: string): Promise<void> {
  try {
    const outcome = await passBackScore(attemptId);
    if (outcome.status === "FAILED") {
      console.warn(`[lti] a score for ${attemptId} was refused: ${outcome.reason ?? "no reason given"}`);
    }
  } catch (error) {
    console.error("[lti] could not pass a score back", error);
  }
}
