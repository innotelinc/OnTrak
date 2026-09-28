"use server";

/**
 * Client survey server actions (M4).
 *
 * Two halves with different rules, and the difference is the whole point:
 *
 *  - Asking is a staff act. `requestClientSurveyAction` starts from the signed-in
 *    actor, needs `client:manage`, and lands the desk back on the client's page.
 *  - **Answering is not.** `submitClientSurveyAction` reads no session at all —
 *    the token is the credential — because a client's director should not have to
 *    be provisioned in the desk's identity provider to say whether they are
 *    happy. It is the one write in the product that a stranger can reach, so it
 *    does exactly one thing: record the answer to the survey that token names.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireActor } from "../../lib/session";
import { clientSurveyServicesFor } from "../../lib/db";

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/** Ask a client's own people how the desk did over a period. */
export async function requestClientSurveyAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const clientId = text(formData, "clientId");
  if (!clientId) redirect("/clients?error=Choose+a+client+first.");

  const result = await clientSurveyServicesFor().request(actor, clientId, {
    periodStart: text(formData, "periodStart"),
    periodEnd: text(formData, "periodEnd"),
  });
  if (!result.ok) redirect(`/clients?error=${encodeURIComponent(result.error)}`);

  revalidatePath("/clients");
  redirect(`/clients?flash=${encodeURIComponent("Survey link ready for that period — send it to the client.")}`);
}

/** Answer a client survey from its link. No actor: the token is the credential. */
export async function submitClientSurveyAction(formData: FormData): Promise<void> {
  const token = text(formData, "token");
  const score = Number(formData.get("score"));
  const comment = String(formData.get("comment") ?? "").trim();

  const result = await clientSurveyServicesFor().submit(token, score, comment || undefined);
  const home = `/survey/${encodeURIComponent(token)}`;
  if (!result.ok) redirect(`${home}?error=${encodeURIComponent(result.error)}`);

  revalidatePath(home);
  redirect(`${home}?flash=${encodeURIComponent("Thank you — your answer is recorded.")}`);
}
