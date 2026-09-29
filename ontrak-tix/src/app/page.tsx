import { redirect } from "next/navigation";

import { currentActor } from "../lib/session";

/**
 * Send a signed-in caller to the desk overview or the requester portal; everyone
 * else to sign-in.
 *
 * Staff land on the overview rather than straight on the inbox: the first question
 * of a shift is "what happened while I was away?", and the inbox cannot answer it.
 */
export default async function Home() {
  const actor = await currentActor();
  if (!actor) redirect("/sign-in");
  redirect(actor.role === "REQUESTER" ? "/portal" : "/dashboard");
}
