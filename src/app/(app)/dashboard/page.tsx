import { redirect } from "next/navigation";
import { requireSession, ROLE_HOME } from "@/lib/auth";

/**
 * Single entry point that sends each role to its own home.
 *
 * The PWA manifest points here, so installing the app always lands people
 * somewhere sensible regardless of what they were last doing.
 */
export default async function DashboardPage() {
  const user = await requireSession();
  redirect(ROLE_HOME[user.role]);
}
