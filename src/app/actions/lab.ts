"use server";

/**
 * The lab's student actions, as the port's pages submit them.
 *
 * The Python portal took form POSTs and answered 303s with a flash cookie. This app does
 * the same job with server actions and a `?flash=`/`?error=` query, which is the idiom
 * every other action in this tree uses (`actions/student.ts`), so a lab page behaves like
 * the rest of the product rather than like an iframe of somebody else's portal.
 *
 * Five decisions are worth stating out loud, because each is a place a port goes wrong.
 *
 * **The student is their email.** The lab's store keys a session by a student name; the
 * family's unique key for a person is their email, and the completions door files results
 * against it. So the lab's "student" here *is* `user.email`, lowercased — one identity, so
 * the session a student starts and the attempt they are credited with cannot disagree.
 *
 * **Nothing is stored until Complete & End.** A check is a preview (`runChecks(session,
 * false)`) and a write-up can be previewed too; the lab is results-only, so a preview is
 * held in the redirect message and nowhere else. A draft is saved, because a reload must
 * not lose the typing, and a draft is not a grade (`store.ts`).
 *
 * **A submission with no control button is a save, not a hand-in.** `WRITEUP_ACTION`
 * decides which of the three buttons was pressed, defaulting to the non-destructive one: a
 * scripted POST must not grade and destroy the student's machine.
 *
 * **Provisioning runs after the response.** Cloning and booting a machine takes tens of
 * seconds and a server action must not hold the request open for it (this is the port's
 * §3/C4 in a different guise). `after()` is Next's own mechanism for work that outlives the
 * response, and the page polls `/api/v1/lab/sessions/<id>/status` meanwhile — exactly the
 * shape the Python's worker thread had.
 *
 * **The grade is filed once, in the family's ledger.** After `complete` succeeds the result
 * goes through `recordLabCompletion`, the same write the HTTP door uses, so the attempt,
 * certificate evidence and audit entry are identical whichever half of the port graded it.
 * A deployment that has not imported the lab's catalogue has no scenario row to file
 * against; the session is still graded and stored, and the student is told the result is
 * not in their record yet rather than being shown a success that is not one.
 */

import { after } from "next/server";
import { redirect } from "next/navigation";

import { requireSession } from "@/lib/auth";
import { labCompletionFrom, type LabCompletionFacts } from "@/lib/lab/completion";
import { recordLabCompletion, familyScenarioFor } from "@/lib/lab-completion-record";
import { WRITEUP_ACTION, missingRequired, ticketGradeSummaryLine } from "@/lib/lab/tickets";
import { scoreReportSummaryLine, type LabSession } from "@/lib/lab/models";
import { forgetPreview, previewKey, rememberPreview } from "@/lib/lab/preview";
import { ScenarioError } from "@/lib/lab/scenarios";
import { choose, historyFromSessions } from "@/lib/lab/selection";
import { labRuntimeForPage } from "@/lib/lab/service";
import type { LabRuntime } from "@/lib/lab/service";
import type { SessionManager } from "@/lib/lab/sessions";
import { SessionError } from "@/lib/lab/sessions";

/** The page a lab action sends a student back to when it cannot even find the session. */
const DASHBOARD = "/lab";

function fail(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

function done(path: string, message: string): never {
  redirect(`${path}?flash=${encodeURIComponent(message)}`);
}

/** The lab's own name for a student: the family's unique key for them. */
function studentKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The runtime, or a refusal the student can read.
 */
async function runtimeOrFail(path: string): Promise<LabRuntime> {
  const { runtime, reason } = await labRuntimeForPage();
  if (runtime === null) fail(path, reason ?? "OnTrak Lab is not available on this deployment.");
  return runtime;
}

/**
 * One session the caller may touch.
 *
 * **This is the one place ownership is decided.** Staff may act on any session (that is how
 * an instructor reaches a machine from the fleet page); a student is only ever handed their
 * own, and `getOwnedSession` is what refuses the rest. Every action below goes through
 * here, so a new one cannot forget the check and hand over somebody else's machine — the
 * mistake the Python's own `load_session` helper existed to prevent.
 */
async function sessionOrFail(runtime: LabRuntime, sessionId: number, path: string): Promise<LabSession> {
  const user = await requireSession();
  const staff = user.role === "INSTRUCTOR" || user.role === "ADMIN";
  try {
    return await runtime.manager.getOwnedSession(studentKey(user.email), sessionId, staff);
  } catch (error) {
    if (error instanceof SessionError) fail(path, error.message);
    throw error;
  }
}

function sessionPath(sessionId: number): string {
  return `/lab/sessions/${sessionId}`;
}

function sessionIdFrom(formData: FormData): number {
  const raw = String(formData.get("sessionId") ?? "").trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(DASHBOARD, "That session does not exist.");
  return parsed;
}

/**
 * The background half of starting a session.
 *
 * Detached on purpose and reported on the row: a failure here lands as the session's own
 * `error` state with the operator's message, which the page polls for — the same contract
 * the Python's worker thread had, because the failure happens long after the response.
 */
function provisionInBackground(manager: SessionManager, session: LabSession): void {
  after(async () => {
    try {
      await manager.provision(session);
    } catch (error) {
      // Provisioning already records its own failure on the row; this is the case where it
      // could not even do that (the database went away), and a log line is all that is left.
      console.error(`lab: provisioning session ${String(session.id)} failed`, error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Starting, and the session's own controls                                   */
/* -------------------------------------------------------------------------- */

export async function startLabSession(formData: FormData): Promise<void> {
  const user = await requireSession();
  const runtime = await runtimeOrFail(DASHBOARD);
  const student = studentKey(user.email);

  const scenarioId = String(formData.get("scenarioId") ?? "").trim();
  const workload = String(formData.get("workload") ?? "").trim();
  const limitRaw = String(formData.get("timeLimit") ?? "").trim();
  const limit = /^\d+$/.test(limitRaw) && Number(limitRaw) > 0 ? Number(limitRaw) : null;

  // Automatic assignment: "surprise me" picks from the range's own catalogue rather than
  // making a student choose their own fault. Off unless the settings say otherwise.
  let wanted = scenarioId;
  if (wanted === "" || wanted === "auto") {
    if (!runtime.settings.selection.autoAssign) fail(DASHBOARD, "Choose a scenario to start.");
    wanted = await chooseFor(runtime);
  }

  try {
    // Refuse a scenario this range cannot start *before* a session exists: provisioning
    // runs after the response, so without this the student's only clue would be an `error`
    // row carrying an operator's message, and a slot burned on a machine that never boots.
    const unavailable = await runtime.manager.scenarioAvailability(wanted, workload || null);
    if (unavailable) fail(DASHBOARD, unavailable);
    const session = await runtime.manager.createSession(student, wanted, {
      workload: workload || null,
      timeLimitMinutes: limit,
    });
    if (session.id === null) fail(DASHBOARD, "The session was created without a row to point at.");
    if (session.state === "error") fail(sessionPath(session.id), session.error.slice(0, 200));
    // A session already usable is resumed rather than re-provisioned: `createSession` is
    // idempotent per (student, scenario), which is what makes a reload cheap.
    if (session.state === "in_use" || session.state === "passed" || session.state === "ready") {
      done(sessionPath(session.id), "Session resumed.");
    }
    provisionInBackground(runtime.manager, session);
    done(sessionPath(session.id), "Preparing your machine...");
  } catch (error) {
    if (error instanceof SessionError || error instanceof ScenarioError) fail(DASHBOARD, error.message);
    throw error;
  }
}

/**
 * The range's own choice, from the ported selector.
 *
 * The history is the *whole* range's rather than this student's — that is the Python's own
 * `list_sessions(limit=500)` and it is deliberate: the point of the balanced strategy is to
 * spread a class across the catalogue, so what a student is offered depends on what
 * everybody has already been given.
 */
async function chooseFor(runtime: LabRuntime): Promise<string> {
  const sessions = await runtime.store.listSessions({ limit: 500 });
  const history = historyFromSessions(sessions.map((row) => ({ scenario_id: row.scenarioId })));
  const choice = choose(
    runtime.repository.list(),
    null,
    history,
    runtime.settings.selection.strategy,
    runtime.settings.selection.maxDifficulty,
    runtime.settings.selection.seed,
  );
  return choice.scenario.id;
}

export async function checkLabSession(formData: FormData): Promise<void> {
  const user = await requireSession();
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);

  if (session.state === "requested" || session.state === "allocating" || session.state === "provisioning") {
    done(sessionPath(sessionId), "The machine is still starting up.");
  }
  // `false`: nothing about a check is recorded. The lab is results-only, and only
  // Complete & End files anything — this preview is shown from process memory.
  const report = await runtime.manager.runChecks(session, false);
  if (report.error !== "") fail(sessionPath(sessionId), `Grading problem: ${report.error}`);
  rememberPreview(previewKey(studentKey(user.email), sessionId), { report });
  const verdict = report.resolved ? "Resolved" : "Not resolved yet";
  done(
    sessionPath(sessionId),
    `${verdict} — ${scoreReportSummaryLine(report)} (this attempt is not recorded; use Complete & End to submit)`,
  );
}

export async function setLabTimeLimit(formData: FormData): Promise<void> {
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const minutes = Number(String(formData.get("minutes") ?? ""));
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);
  try {
    await runtime.manager.setTimeLimit(session, minutes);
  } catch (error) {
    if (error instanceof SessionError) fail(sessionPath(sessionId), error.message);
    throw error;
  }
  done(sessionPath(sessionId), `Time limit set to ${minutes} minutes.`);
}

export async function revealLabHint(formData: FormData): Promise<void> {
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);
  const scenario = runtime.repository.get(session.scenarioId);

  // Hints are earned: the settings say so, and the lab's own rule is that a student tries
  // once before being told. It is checked here rather than only on the page because a POST
  // can walk past a hidden button.
  if (runtime.settings.portal.hintsRequireAttempt && session.checksRun === 0) {
    done(sessionPath(sessionId), "Try the ticket once and run a check first; hints unlock after your first attempt.");
  }
  if (session.hintLevel >= scenario.hints.length) {
    done(sessionPath(sessionId), "No more hints for this scenario.");
  }
  await runtime.manager.revealHint(session, scenario);
  done(sessionPath(sessionId), "Hint revealed.");
}

export async function resetLabSession(formData: FormData): Promise<void> {
  const user = await requireSession();
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);

  const instructor = user.role === "INSTRUCTOR" || user.role === "ADMIN";
  if (!runtime.settings.portal.allowSelfReset && !instructor) {
    done(sessionPath(sessionId), "Resetting is disabled; ask your instructor.");
  }
  try {
    const reset = await runtime.manager.reset(session);
    if (reset.state === "error") fail(sessionPath(sessionId), reset.error);
  } catch (error) {
    if (error instanceof SessionError) fail(sessionPath(sessionId), error.message);
    throw error;
  }
  done(sessionPath(sessionId), "Reset: you have a clean machine again.");
}

export async function extendLabSession(formData: FormData): Promise<void> {
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const minutes = Math.max(1, Math.min(Number(String(formData.get("minutes") ?? "15")), 240));
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);
  await runtime.manager.extend(session, minutes);
  done(sessionPath(sessionId), `Extended by ${minutes} minutes.`);
}

export async function endLabSession(formData: FormData): Promise<void> {
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);
  await runtime.manager.end(session);
  done(DASHBOARD, "Session ended and the machine was destroyed.");
}

/* -------------------------------------------------------------------------- */
/*  The write-up, and handing the session in                                   */
/* -------------------------------------------------------------------------- */

/** The answers the form carried, field by field, from the rubric the scenario declares. */
function writeUpValues(formData: FormData, fields: readonly { id: string }[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) values[field.id] = String(formData.get(field.id) ?? "");
  return values;
}

/**
 * Save the write-up as a draft, or mark a preview of it.
 *
 * Nothing here is recorded: the written ticket is graded when the session is handed in,
 * exactly like the machine state. The draft is kept so a reload does not lose the typing.
 */
export async function saveLabWriteUp(formData: FormData): Promise<void> {
  const user = await requireSession();
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);

  const form = runtime.manager.ticketFormFor(session);
  if (form === null) done(sessionPath(sessionId), "This scenario has no ticket form.");

  const values = writeUpValues(formData, form.fields);
  await runtime.manager.saveTicketDraft(session, values);
  if (String(formData.get(WRITEUP_ACTION) ?? "save") !== "preview") {
    done(sessionPath(sessionId), "Ticket saved as a draft.");
  }
  const grade = await runtime.manager.gradeTicket(session, values);
  if (grade === null) done(sessionPath(sessionId), "This scenario has no ticket form.");
  rememberPreview(previewKey(studentKey(user.email), sessionId), { grade });
  done(
    sessionPath(sessionId),
    `Write-up preview: ${ticketGradeSummaryLine(grade)} (not recorded — it is marked with the machine when you complete the session).`,
  );
}

/**
 * Hand the session in — or save, or preview, from the same form.
 *
 * One form with three submitting buttons, because nested forms are not a thing and
 * duplicating every field for a second button would be worse. `WRITEUP_ACTION` says which
 * one it was — not `action`, which is a field scenarios define themselves.
 */
export async function completeLabSession(formData: FormData): Promise<void> {
  const user = await requireSession();
  const runtime = await runtimeOrFail(DASHBOARD);
  const sessionId = sessionIdFrom(formData);
  const session = await sessionOrFail(runtime, sessionId, DASHBOARD);

  if (session.completedAt !== "") {
    done(sessionPath(sessionId), "That session is already handed in.");
  }

  const form = runtime.manager.ticketFormFor(session);
  let values: Record<string, string> | undefined;
  if (form !== null) {
    values = writeUpValues(formData, form.fields);
    const action = String(formData.get(WRITEUP_ACTION) ?? "save");
    if (action === "save" || action === "preview") {
      await runtime.manager.saveTicketDraft(session, values);
      if (action === "save") done(sessionPath(sessionId), "Write-up saved as a draft.");
      const previewed = await runtime.manager.gradeTicket(session, values);
      if (previewed !== null) {
        rememberPreview(previewKey(studentKey(user.email), sessionId), { grade: previewed });
      }
      done(
        sessionPath(sessionId),
        `Write-up preview: ${
          previewed === null ? "no rubric" : ticketGradeSummaryLine(previewed)
        } (not recorded — it is marked with the machine when you hand the session in).`,
      );
    }
    // A blank required field is a submit-by-mistake, not a zero: send it back so the
    // student loses nothing but a click.
    const missing = missingRequired(form, values);
    if (missing.length > 0) {
      await runtime.manager.saveTicketDraft(session, values);
      done(sessionPath(sessionId), `Your write-up is missing: ${missing.join(", ")}. Nothing was submitted.`);
    }
  }

  const scenario = runtime.repository.get(session.scenarioId);
  const report = await runtime.manager.complete(session, values);
  // The session has a stored result now, so its preview must go: two answers to the same
  // question is one too many, and the page reads the stored one from here on.
  forgetPreview(previewKey(studentKey(user.email), sessionId));
  if (report.error !== "") fail(sessionPath(sessionId), `Could not grade: ${report.error}`);

  const filed = await fileCompletion(user.email, session, report, scenario);
  const verdict = report.resolved ? "passed" : "not passed";
  done(
    sessionPath(sessionId),
    `Submitted — ${scoreReportSummaryLine(report)} (${verdict}). Your machine has been destroyed.${filed}`,
  );
}

/**
 * Put the grade in the family's ledger, and say what happened if it could not go.
 *
 * The lab's own store already has the result — this is the *family's* copy, which is what
 * an instructor's results view and a certificate read. Two ordinary reasons it cannot be
 * filed, and both are told to the student rather than swallowed: this deployment has not
 * imported the lab's catalogue (so no scenario row to file against), and a learner row
 * that no longer exists.
 */
async function fileCompletion(
  email: string,
  session: LabSession,
  report: LabCompletionFacts["report"],
  scenario: LabCompletionFacts["scenario"],
): Promise<string> {
  const familyScenario = await familyScenarioFor(session.scenarioId);
  if (familyScenario === null) {
    return " Your grade is recorded in OnTrak Lab, but not in your transcript yet: this deployment has not imported the lab's catalogue (`npm run lab:import`).";
  }
  const completion = labCompletionFrom({
    session,
    scenario,
    report,
    learnerEmail: email,
    familyScenarioId: familyScenario.id,
  });
  const wrote = await recordLabCompletion(completion);
  if (!wrote.ok) return ` It was stored in OnTrak Lab, but not in your transcript: ${wrote.error}`;
  return wrote.created ? "" : " (Your transcript already had this session, so nothing was filed twice.)";
}
