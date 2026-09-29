"use client";

/**
 * `/login` — the same panel the shell draws, on its own page.
 *
 * It exists so that a link, a bookmark, or the Cerulean SSO callback can name a
 * destination. The shell gates every other route with the identical component, so
 * there is one form and one set of decisions, not two that drift.
 */

import { useRouter } from "next/navigation";

import { LoginPanel } from "@/components/LoginPanel";
import { useSession } from "@/lib/session";

export default function LoginPage() {
  const { adopt } = useSession();
  const router = useRouter();

  return (
    <LoginPanel
      notice={null}
      onSignedIn={(user) => {
        adopt({ ...user, via: "cookie" });
        const next = new URLSearchParams(window.location.search).get("next") || "/";
        router.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
      }}
    />
  );
}
