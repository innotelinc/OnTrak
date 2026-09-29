"use client";

import { useState } from "react";

/**
 * Sign out of the portal.
 *
 * It says "of the portal" in the tooltip because that is all it does: each product
 * behind a tile holds its own credential, and a button that claimed to sign
 * somebody out of four applications would be lying about three of them.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="ghost"
      disabled={busy}
      title="Clears this portal's session. Each product holds its own sign-in."
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/logout", { method: "POST" });
        } finally {
          window.location.assign("/");
        }
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
