/**
 * Satisfaction survey (M1): the CSAT form a requester sees on a resolved ticket.
 *
 * Presentational. The action validates the score and the token server-side, so
 * a forged form cannot record a rating against someone else's ticket.
 */

import { CSAT_SCALE, satisfactionLabel, type CsatScore } from "../lib/csat-rules";
import type { SatisfactionRecord } from "../lib/csat-service";
import { surveyStatus } from "../lib/csat-service";

export function SatisfactionSurvey({
  survey,
  action,
  now,
}: {
  survey: SatisfactionRecord;
  action?: (formData: FormData) => Promise<void>;
  now: string;
}) {
  const status = surveyStatus(survey, now);

  if (status === "answered" && survey.score !== null) {
    return (
      <section aria-label="Satisfaction" className="rounded-xl2 border border-teal/40 bg-teal/10 p-5">
        <h2 className="font-display text-sm font-semibold text-teal">Thanks for your feedback</h2>
        <p className="mt-1 text-sm text-ink-soft">
          You rated this {survey.score}/5 — {satisfactionLabel(survey.score)}.
        </p>
        {survey.comment ? <p className="mt-1 text-sm text-ink-soft">“{survey.comment}”</p> : null}
      </section>
    );
  }

  if (status === "expired") {
    return (
      <section aria-label="Satisfaction" className="rounded-xl2 border border-line bg-surface p-5">
        <h2 className="font-display text-sm font-semibold text-ink">How did we do?</h2>
        <p className="mt-1 text-sm text-ink-faint">This survey has closed, but thank you for using the desk.</p>
      </section>
    );
  }

  return (
    <section aria-label="Satisfaction" className="rounded-xl2 border border-line bg-surface p-5">
      <h2 className="font-display text-sm font-semibold text-ink">How did we do?</h2>
      <p className="mt-1 text-sm text-ink-soft">This ticket is resolved. A quick rating helps the desk improve.</p>
      {action ? (
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="token" value={survey.token} />
          <fieldset className="flex flex-wrap gap-3">
            <legend className="sr-only">Rating from 1 to 5</legend>
            {CSAT_SCALE.map((score) => (
              <label key={score} className="flex items-center gap-1 text-sm text-ink-soft">
                <input type="radio" name="score" value={score} required /> {score}
                <span className="text-xs text-ink-faint">{satisfactionLabel(score as CsatScore)}</span>
              </label>
            ))}
          </fieldset>
          <label className="block text-xs text-ink-soft">
            Anything to add? (optional)
            <textarea
              name="comment"
              rows={2}
              maxLength={2_000}
              className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
          <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
            Send feedback
          </button>
        </form>
      ) : null}
    </section>
  );
}
