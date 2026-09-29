"use client";

/**
 * `/login/break-glass` — the local fallback, deliberately unlinked.
 *
 * OnTrak Sync is single sign-on only. This page exists because "the identity
 * provider is down" must not also mean "the operator cannot see the Network", and it
 * is kept off the navigation, out of the sign-in screen, and out of search engines
 * because a fallback that is easy to reach stops being a fallback.
 *
 * The shell lets this route through unsigned (`Shell` treats it like `/login`),
 * which is the only way a break-glass door can work at all.
 */

import { useRouter } from "next/navigation";

import { LoginPanel } from "@/components/LoginPanel";
import { useSession } from "@/lib/session";

export default function BreakGlassLoginPage() {
  const { adopt } = useSession();
  const router = useRouter();

  return (
    <LoginPanel
      mode="local"
      notice={null}
      onSignedIn={(user) => {
        adopt({ ...user, via: "cookie" });
        const next = new URLSearchParams(window.location.search).get("next") || "/";
        router.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
      }}
    />
  );
}
