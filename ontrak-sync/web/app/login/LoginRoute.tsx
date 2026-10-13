"use client";

/**
 * The panel, plus the one decision that belongs to this route rather than to the panel:
 * where to send somebody once they are in.
 *
 * It is split out of `page.tsx` so that file can be a server component: the masthead
 * above the gate prints the family's own address, and that is a server-side variable
 * which a client component cannot read without disagreeing with the server's markup.
 */

import { useRouter } from "next/navigation";

import { LoginPanel } from "@/components/LoginPanel";
import { useSession } from "@/lib/session";

export function LoginRoute() {
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

export default LoginRoute;
