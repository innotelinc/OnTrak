"use client";

/**
 * The small shared pieces: status pills, manager tags, timestamps.
 *
 * All of them live here so a status word is coloured in one place. When each page
 * chooses its own colour for "failed", one of them eventually picks amber and the
 * dashboard stops being readable at a glance — which is the only reason a
 * dashboard exists.
 */

import type { FindingStatus, Manager } from "@/lib/types";

const STATUS_LABEL: Record<FindingStatus, string> = {
  pending: "pending",
  approved: "approved",
  applied: "applied",
  failed: "failed",
  skipped: "skipped",
};

export function StatusPill({ status }: { status: FindingStatus }) {
  return <span className={`pill pill--${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function ManagerTag({ manager }: { manager: Manager | string }) {
  return <span className="faint mono">{manager}</span>;
}

/** A target's scan state. `unknown` is a real answer, not a missing one. */
export function ScanPill({ scanned, managers }: { scanned: boolean; managers?: Record<string, string> }) {
  if (!scanned) {
    const states = new Set(Object.values(managers ?? {}));
    const label = states.has("error") || states.has("timeout") ? "failed" : "unknown";
    return <span className={`pill pill--${label === "failed" ? "bad" : "unknown"}`}>{label}</span>;
  }
  const partial = Object.values(managers ?? {}).some((state) => state === "partial");
  return <span className={`pill pill--${partial ? "partial" : "ok"}`}>{partial ? "partial" : "ok"}</span>;
}

export function SecurityPill() {
  return <span className="pill pill--security">security</span>;
}

export function ReachablePill({ reachable }: { reachable: 0 | 1 }) {
  return reachable
    ? <span className="pill pill--ok">reachable</span>
    : <span className="pill pill--bad">unreachable</span>;
}

/** ISO timestamp → "2h ago (14:03)", so both the age and the instant are visible. */
export function When({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="faint">never</span>;
  const then = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(then.getTime())) return <span className="faint">{value}</span>;
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000);
  const units: [number, string][] = [[86400, "d"], [3600, "h"], [60, "m"]];
  let age = `${Math.floor(seconds)}s`;
  for (const [size, suffix] of units) {
    if (seconds >= size) {
      age = `${Math.floor(seconds / size)}${suffix}`;
      break;
    }
  }
  const clock = then.toISOString().slice(11, 16);
  return (
    <span className="nowrap" title={then.toISOString()}>
      {age} ago <span className="faint">({clock})</span>
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function LoadError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div className="note note--bad">Could not load this view: {message}</div>;
}
