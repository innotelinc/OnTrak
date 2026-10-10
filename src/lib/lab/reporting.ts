/**
 * The lab's stored results, gathered for the pages and the exports.
 *
 * The store's own contract returns one student's results at a time (`resultsForStudent`),
 * which is right for the student-facing pages and wrong for a class view: an instructor's
 * fleet page and both CSV exports need every result on the deployment. Rather than teach
 * each of those three callers to fan out over the roster — and then disagree about which
 * students count, or about the order — the fan-out lives here once.
 *
 * The student list is derived from the *sessions*, not from the users table, and that is
 * deliberate: a lab result exists only because a session did, so the sessions are the
 * complete roster of everybody who has ever used the range, including a student whose
 * account was later removed from the family's users table. The lab's own removal path is a
 * session delete, which takes its results with it (`store-prisma.ts`), so this cannot
 * report a person who has no business in the list.
 */

import type { ResultRow } from "./portal";
import type { LabRuntime } from "./service";

/** Every stored result on this deployment, newest session order not guaranteed. */
export async function classResults(runtime: LabRuntime): Promise<ResultRow[]> {
  const sessions = await runtime.store.listSessions({ limit: 1000 });
  const students = [...new Set(sessions.map((session) => session.student))];

  const rows: ResultRow[] = [];
  for (const student of students) {
    for (const report of await runtime.store.resultsForStudent(student)) {
      rows.push({
        student,
        scenarioId: report.scenarioId,
        score: report.score,
        machineScore: report.machineScore,
        ticketScore: report.ticketScore,
        ticketWeight: report.ticketWeight,
        resolved: report.resolved,
        createdAt: report.createdAt,
      });
    }
  }
  return rows;
}

/** One student's results, as the export and the dashboard read them. */
export async function studentResults(runtime: LabRuntime, student: string): Promise<ResultRow[]> {
  const reports = await runtime.store.resultsForStudent(student.trim().toLowerCase());
  return reports.map((report) => ({
    student: student.trim().toLowerCase(),
    scenarioId: report.scenarioId,
    score: report.score,
    machineScore: report.machineScore,
    ticketScore: report.ticketScore,
    ticketWeight: report.ticketWeight,
    resolved: report.resolved,
    createdAt: report.createdAt,
  }));
}
