import Link from "next/link";

import { clientSurveyServicesFor, prisma } from "../../../lib/db";
import { CSAT_SCALE, satisfactionLabel, type CsatScore } from "../../../lib/csat-rules";
import { clientSurveyStatus, surveyQuestion } from "../../../lib/client-survey-rules";
import { submitClientSurveyAction } from "../../actions/surveys";

export const metadata = { title: "How did we do?" };

/**
 * The client-facing survey (M4).
 *
 * Open on purpose, like the packet verifier: the person who signs an MSP's
 * invoices is usually not the person who raised the tickets, and asking them to
 * have an account would mean the question is answered by whoever happens to hold
 * one. The token in the URL is the credential and the whole of it — this page
 * reads no session, and the only thing it will do is record the answer.
 *
 * It shows the client's name and the period, because a survey that does not say
 * what it is about is a survey nobody trusts.
 */
export default async function ClientSurveyPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { token } = await params;
  const { flash, error } = await searchParams;

  const survey = await clientSurveyServicesFor().open(token);
  const status = survey ? clientSurveyStatus({ ...survey, score: survey.score }, new Date().toISOString()) : "expired";
  const [client, tenant] = survey
    ? await Promise.all([
        prisma.client.findFirst({ where: { id: survey.clientId, tenantId: survey.tenantId }, select: { name: true } }),
        prisma.tenant.findUnique({ where: { id: survey.tenantId }, select: { name: true } }),
      ])
    : [null, null];

  const shell = (children: React.ReactNode) => (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-10">
      <div className="space-y-1">
        <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{tenant?.name ?? "Support"}</p>
        <h1 className="font-display text-xl font-semibold text-ink">How did we do?</h1>
      </div>
      {children}
    </main>
  );

  if (!survey) {
    return shell(
      <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
        That survey link is not valid. Ask your support desk for a fresh one.
      </p>,
    );
  }

  return shell(
    <>
      <p className="text-sm text-ink-soft">
        {surveyQuestion(client?.name ?? "your", survey.periodStart, survey.periodEnd)}
      </p>

      {flash ? (
        <p className="rounded-xl2 border border-teal/40 bg-teal/10 px-4 py-3 text-sm text-teal">{flash}</p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl2 border border-pink/40 bg-pink/10 px-4 py-3 text-sm text-pink">
          {error}
        </p>
      ) : null}

      {status === "answered" ? (
        <section className="space-y-2 rounded-xl2 border border-line bg-surface p-5">
          <h2 className="font-display text-sm font-semibold text-ink">You rated us {survey.score}/5</h2>
          <p className="text-sm text-ink-soft">{satisfactionLabel(survey.score as CsatScore)}</p>
          {survey.comment ? <p className="text-sm text-ink">“{survey.comment}”</p> : null}
          <p className="text-xs text-ink-faint">
            Answered {survey.respondedAt}. This question is asked once for the period, so nothing else is needed.
          </p>
        </section>
      ) : status === "expired" ? (
        <p role="alert" className="rounded-xl2 border border-amber/40 bg-amber/10 px-4 py-3 text-sm text-amber">
          This survey link has expired. Ask your support desk for a fresh one — the period it asked about can be asked again
          with a new link.
        </p>
      ) : (
        <form action={submitClientSurveyAction} className="space-y-3 rounded-xl2 border border-line bg-surface p-5">
          <input type="hidden" name="token" value={survey.token} />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Your rating</legend>
            <div className="flex flex-wrap gap-3">
              {CSAT_SCALE.map((score) => (
                <label key={score} className="flex items-center gap-1.5 text-sm text-ink-soft">
                  <input type="radio" name="score" value={score} required />
                  {score} — {satisfactionLabel(score as CsatScore)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-medium text-ink">
            Anything you want to add (optional)
            <textarea
              name="comment"
              rows={3}
              className="mt-1 w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </label>
          <button type="submit" className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white">
            Send my answer
          </button>
          <p className="text-xs text-ink-faint">
            Asking is a courtesy, not a condition: answering is entirely your choice, and the link can be used once.
          </p>
        </form>
      )}

      <p className="text-xs text-ink-faint">
        <Link href="/sign-in" className="font-semibold text-brand hover:underline">
          Desk staff sign in here
        </Link>
        .
      </p>
    </>,
  );
}
