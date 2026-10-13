import Link from "next/link";
import { cn } from "@/lib/cn";

/** The OnTrak IT Support Training gate mark: a laptop screen with a check — hands-on IT
 * support training, plain and simple. Flat, 48×48, brand-toned, the same style every
 * OnTrak product carries on its login. */
export function ItsGateMark({ className }: { className?: string } = {}) {
  return (
    <svg
      className={cn("gate__mark-svg", className)}
      viewBox="0 0 48 48"
      role="img"
      aria-label="OnTrak IT Support Training"
      width="44"
      height="44"
    >
      <defs>
        <linearGradient id="its-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--tone-its)" />
        </linearGradient>
      </defs>
      <path
        d="M10 11 h28 a3 3 0 0 1 3 3 v19 a3 3 0 0 1 -3 3 h-28 a3 3 0 0 1 -3 -3 v-19 a3 3 0 0 1 3 -3 z"
        fill="url(#its-mark)"
      />
      <path
        d="M17 22.5 l4 4 l6.5 -7.5"
        fill="none"
        stroke="var(--brand-ink)"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 36 h30 v2.5 h-30 z"
        fill="none"
        stroke="var(--brand-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex size-9 items-center justify-center rounded-2xl gradient-brand text-white shadow-card",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.5 8 4.8 12l3.7 4" />
        <path d="m15.5 8 3.7 4-3.7 4" />
        <path d="M13.4 5.5 10.6 18.5" />
      </svg>
    </span>
  );
}

export function Logo({
  href = "/",
  name = "OnTrak IT Support Training",
  subtitle,
  className,
}: {
  href?: string;
  name?: string;
  subtitle?: string;
  className?: string;
}) {
  return (
    <Link href={href} className={cn("group inline-flex items-center gap-3", className)}>
      <LogoMark className="transition-transform duration-300 group-hover:-rotate-6" />
      <span className="leading-tight">
        <span className="block font-display text-base font-semibold text-ink">{name}</span>
        {subtitle ? <span className="block text-[11px] font-medium tracking-wide text-ink-faint uppercase">{subtitle}</span> : null}
      </span>
    </Link>
  );
}
