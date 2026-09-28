"use server";

import { redirect } from "next/navigation";

import { destroyTixSession } from "../../lib/session";

/** Clear the session cookie and return to the sign-in screen. */
export async function signOutAction(): Promise<void> {
  await destroyTixSession();
  redirect("/sign-in");
}
