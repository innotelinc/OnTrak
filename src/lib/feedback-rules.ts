/**
 * Trainee and employer feedback on a funded class (RFQ §4.5).
 *
 * "CommCorp expects to collect feedback from trainees on course quality and from employers on
 * training impact", and the provider's part in that is to facilitate access — "which may include
 * distributing surveys or sharing contact information consistent with applicable privacy
 * requirements". The instruments and the timing are "defined at contracting", so nothing here is
 * a refusal: a class with no survey recorded is a class the provider has not yet been given the
 * instrument for, and the honest thing to do is say so rather than invent one.
 *
 * What this module does own is that an address pasted into either field is an address before it
 * is a link — the same four refusals as any other stored URL (`link-rules.ts`). A survey URL is
 * the one field on a class that a *learner* is handed, so a `javascript:` one would be run with
 * a learner's own session.
 */

import { httpLink, httpLinkRefusal } from "./link-rules";

export interface ClassFeedback {
  traineeSurveyUrl: string | null;
  employerSurveyUrl: string | null;
}

/** The two addresses, validated for rendering. Null means "not recorded, or not usable". */
export function feedbackLinks(feedback: ClassFeedback): { trainee: string | null; employer: string | null } {
  return {
    trainee: httpLink(feedback.traineeSurveyUrl),
    employer: httpLink(feedback.employerSurveyUrl),
  };
}

/**
 * What §4.5 expects of this class and has not been recorded, in words.
 *
 * Sentences rather than `RuleProblem`s on purpose: nothing here blocks anything. They are the
 * lines a provider reads to see which half of the feedback loop it still owes, and they name
 * whose feedback each one is.
 */
export function feedbackGaps(feedback: ClassFeedback): string[] {
  const gaps: string[] = [];
  const trainee = (feedback.traineeSurveyUrl ?? "").trim();
  const employer = (feedback.employerSurveyUrl ?? "").trim();

  if (trainee === "") {
    gaps.push(
      "No trainee survey is recorded for this class; CommCorp collects feedback on course quality, and the funder's instruments are set at contracting.",
    );
  } else if (httpLink(trainee) === null) {
    gaps.push(`The trainee survey address was refused: ${httpLinkRefusal(trainee, "trainee survey")}`);
  }

  if (employer === "") {
    gaps.push(
      "No employer survey is recorded for this class; the sponsoring employer's view of the training's impact is the funder's other half of §4.5.",
    );
  } else if (httpLink(employer) === null) {
    gaps.push(`The employer survey address was refused: ${httpLinkRefusal(employer, "employer survey")}`);
  }

  return gaps;
}

/**
 * One line for a class card: what is missing, or that nothing is.
 *
 * Separate from `feedbackGaps` so a page has one sentence to print and a test has a bare list to
 * assert on — a banner that has to read "there is nothing wrong" out of an empty array is how
 * an empty array gets mistaken for "not checked yet".
 */
export function feedbackSummary(feedback: ClassFeedback): string {
  const gaps = feedbackGaps(feedback);
  if (gaps.length > 0) return gaps.join(" ");
  return "Both surveys are recorded: send the trainee survey to the learners and the employer survey to the sponsor, and keep the results where the funder's monitoring can see them (§4.8).";
}

/** Which subject a survey field is, for the refusal messages. */
export const TRAINEE_SURVEY_SUBJECT = "trainee survey";
export const EMPLOYER_SURVEY_SUBJECT = "employer survey";
