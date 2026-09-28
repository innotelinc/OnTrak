export type ClassValue = string | number | null | false | undefined | ClassValue[];

/** Join class names, dropping falsy values. Deliberately dependency-free. */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) out.push(nested);
      continue;
    }
    out.push(String(value));
  }
  return out.join(" ");
}

/** Deterministic accent for avatars and labels, keyed off a stable string. */
export const ACCENTS: Record<string, { bg: string; text: string; ring: string; dot: string }> = {
  violet: { bg: "bg-brand/12", text: "text-brand", ring: "ring-brand/25", dot: "bg-brand" },
  pink: { bg: "bg-pink/14", text: "text-pink", ring: "ring-pink/25", dot: "bg-pink" },
  amber: { bg: "bg-amber/16", text: "text-amber", ring: "ring-amber/25", dot: "bg-amber" },
  teal: { bg: "bg-teal/14", text: "text-teal", ring: "ring-teal/25", dot: "bg-teal" },
  sky: { bg: "bg-sky/14", text: "text-sky", ring: "ring-sky/25", dot: "bg-sky" },
  lime: { bg: "bg-lime/18", text: "text-lime", ring: "ring-lime/25", dot: "bg-lime" },
};

export function accentFor(name: string) {
  return ACCENTS[name] ?? ACCENTS.violet;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function formatRelative(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - value.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return value.toISOString().slice(0, 10);
}

export function formatDateTime(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  return value.toISOString().slice(0, 16).replace("T", " ");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
