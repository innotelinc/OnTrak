"use client";

import { useEffect } from "react";

/**
 * Registers the service worker after first paint.
 *
 * Registration is skipped in development so a stale cache can never confuse
 * work in progress, and it is a no-op on browsers without support.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* registration is best-effort: the app works fine without it */
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
