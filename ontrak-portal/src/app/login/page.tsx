import { redirect } from "next/navigation";

import { SignInPanel } from "@/components/SignInPanel";
import { portalConfig, ssoConfigured } from "@/lib/config";
import { readSession } from "@/lib/session";

/**
 * The sign-in page. OnTrak Unity, and nothing else on it.
 *
 * A server component so the session can be read before anything renders: somebody
 * who is already signed in and lands here is sent to the dashboard rather than
 * shown a button for a handshake they have already completed.
 *
 * The refusal reason arrives as `?error=`, which is why the callback redirects to
 * this page rather than returning JSON — the thing that always reaches that URL is
 * a browser.
 */

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const session = await readSession();
  const params = await searchParams;
  if (session) {
    redirect(params.next && params.next.startsWith("/") && !params.next.startsWith("//")
      ? params.next
      : "/");
  }

  const config = portalConfig();
  return (
    <SignInPanel ssoEnabled={ssoConfigured(config)} error={params.error ?? null} />
  );
}
