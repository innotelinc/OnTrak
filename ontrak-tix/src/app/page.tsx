import { redirect } from "next/navigation";

import { currentActor } from "../lib/session";

/** Send a signed-in caller to the desk or the portal; everyone else to sign-in. */
export default async function Home() {
  const actor = await currentActor();
  if (!actor) redirect("/sign-in");
  redirect(actor.role === "REQUESTER" ? "/portal" : "/inbox");
}
