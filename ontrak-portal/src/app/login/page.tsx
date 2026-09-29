import { redirect } from "next/navigation";

import { SignInForm } from "@/components/SignInForm";
import { portalConfig, ssoConfigured } from "@/lib/config";
import { readSession } from "@/lib/session";

/**
 * The sign-in page.
 *
 * A server component so the session can be read before anything renders: somebody
 * who is already signed in and lands here is sent to the dashboard rather than
 * shown a form that would ask them for a password they have already given.
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
    <SignInForm
      ssoEnabled={ssoConfigured(config)}
      providerName={config.providerName}
      error={params.error ?? null}
    />
  );
}
