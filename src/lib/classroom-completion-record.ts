/**
 * A finished classroom lesson, written into the family's own ledger.
 *
 * This is the body of `POST /api/v1/classroom/completions`. The classroom grades
 * its own quizzes and reports the outcome; this module is the half that makes it a
 * **training record**: a row in this deployment's database, a completion record
 * stored on it when it passed, and an audit entry saying what arrived.
 *
 * IDEMPOTENT BY `completionId`. A classroom may be interrupted between finishing a
 * lesson and reporting it, so it may send the same completion twice; the unique
 * `completionId` makes a retry recognised (the row it already has) rather than a
 * second record. A concurrent duplicate loses the unique race and is answered the
 * same way, so the database — not a read-then-write check — decides the winner.
 *
 * THE RECORD IS STORED, NOT DERIVED. `certificatePatchFor` issues one exactly when
 * the reported score clears the reported pass mark (`score-rules.ts`), and the
 * record lands in the same write as the row. Re-delivering a completion therefore
 * returns the code the learner was already handed, even if the classroom's title or
 * score moved afterwards — the same reason an attempt stores its certificate.
 *
 * NO SCENARIO IS INVENTED. A classroom lesson is not a scenario this app graded, so
 * the completion carries the course and lesson references it came from and the
 * certificate names the course as its task. Creating a scenario row per generated
 * lesson would put machine-made exercises into the catalog, the analytics and every
 * assignment picker, which is a worse lie than a record that says what it is.
 */

import { Prisma } from "@prisma/client";

import { recordAudit } from "@/lib/audit";
import { certificatePatchFor } from "@/lib/certificates";
import { certificateCode, type CompletionRecord } from "@/lib/credentials";
import { prisma } from "@/lib/db";
import {
  classroomCertificateFacts,
  classroomPassScore,
  classroomTimeSpentSec,
  type ClassroomCompletion,
} from "@/lib/classroom-completion-rules";

export type ClassroomCompletionWrite =
  | {
      ok: true;
      id: string;
      created: boolean;
      /**
       * The stored completion record when the lesson passed, and the short code
       * derived from it, both read back off the row.
       *
       * They travel with the answer because "verifiable" has to be usable: the
       * classroom hands the learner the record, the learner pastes it into
       * `/verify`, and a retry gets the same record the first delivery issued
       * rather than a re-issued one. A failing lesson carries neither.
       */
      record: CompletionRecord | null;
      code: string | null;
    }
  /** A refusal the caller turns into its own status code: 422 for data. */
  | { ok: false; status: number; error: string };

/**
 * The record a row already holds, and its code.
 *
 * A stored JSON column is not a `CompletionRecord` to TypeScript, so the cast is
 * here and nowhere else; `certificateCode` is pure over the record's digest, so a
 * row written by an earlier build still yields the code the learner was given.
 */
function heldRecord(value: unknown): { record: CompletionRecord | null; code: string | null } {
  if (typeof value !== "object" || value === null) return { record: null, code: null };
  const record = value as CompletionRecord;
  return { record, code: certificateCode(record) };
}

export async function recordClassroomCompletion(
  completion: ClassroomCompletion,
): Promise<ClassroomCompletionWrite> {
  // Idempotency first, before anything is resolved: a retry must get the same
  // answer even if the learner's name or the classroom's title changed since the
  // first delivery. The certificate stored then is the one the learner holds.
  const existing = await prisma.classroomCompletion.findUnique({
    where: { completionId: completion.completionId },
    select: { id: true, certificate: true },
  });
  if (existing) {
    return { ok: true, id: existing.id, created: false, ...heldRecord(existing.certificate) };
  }

  const learner = await prisma.user.findUnique({
    where: { email: completion.learnerEmail },
    select: { id: true, name: true },
  });
  if (!learner) {
    return { ok: false, status: 422, error: `No account uses ${completion.learnerEmail}.` };
  }

  const facts = classroomCertificateFacts(completion, learner);
  const certificate = certificatePatchFor(facts, null, completion.completedAt);

  let id: string;
  try {
    const row = await prisma.classroomCompletion.create({
      data: {
        completionId: completion.completionId,
        userId: learner.id,
        courseRef: completion.courseRef,
        courseTitle: completion.courseTitle,
        lessonRef: completion.lessonRef,
        lessonTitle: completion.lessonTitle,
        score: completion.score,
        maxScore: completion.maxScore,
        passScore: classroomPassScore(completion),
        startedAt: completion.startedAt,
        completedAt: completion.completedAt,
        // A wrong clock cannot overflow the column; see the rule.
        timeSpentSec: classroomTimeSpentSec(completion.startedAt, completion.completedAt),
        ...certificate,
      },
      select: { id: true },
    });
    id = row.id;
  } catch (error) {
    // A concurrent delivery of the same completion lost the unique race. The row it
    // collided with is the one this request means, so answer with it rather than
    // failing a duplicate that is not the classroom's fault.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.classroomCompletion.findUnique({
        where: { completionId: completion.completionId },
        select: { id: true, certificate: true },
      });
      if (raced) return { ok: true, id: raced.id, created: false, ...heldRecord(raced.certificate) };
    }
    throw error;
  }

  await recordAudit({
    actorId: null,
    action: "classroom.completion",
    targetType: "classroom_completion",
    targetId: id,
    detail: {
      completionId: completion.completionId,
      courseRef: completion.courseRef,
      courseTitle: completion.courseTitle,
      lessonRef: completion.lessonRef,
      lessonTitle: completion.lessonTitle,
      score: completion.score,
      maxScore: completion.maxScore,
      passScore: classroomPassScore(completion),
      // Whether a record was handed out, not the record itself: the audit chain is
      // a log of decisions, and the certificate is stored on the row it belongs to.
      certificateIssued: certificate.certificate !== undefined,
    },
  });

  const stored = heldRecord(certificate.certificate);
  return { ok: true, id, created: true, record: stored.record, code: stored.code };
}
