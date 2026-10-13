import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The family's mark, and the range's stroke inside it.
 *
 * Every OnTrak product carries the same silhouette on its front door — the shield —
 * and one stroke of its own inside it, so the family is recognisable at a glance and
 * the product is still legible. The range's stroke is the tick, because a scenario is
 * answered by getting the job done; the gradient runs from `--brand` to `--tone-its`,
 * which is what makes this product's mark this product's.
 *
 * The geometry is deliberately the same numbers in all six products (see `.gate` in
 * the shared theme). A mark that is redesigned per product is a mark that drifts, and
 * the front door is the one screen nobody looks at closely enough to notice.
 */
const SHIELD = "M24 4.5 L41 12 V27 C41 37.4 34 43 24 44.5 C14 43 7 37.4 7 27 V12 Z";
const TICK = "M16 25 l4.5 4.5 L32.5 20.5";

/**
 * The shield and the tick.
 *
 * `gradientId` is a parameter rather than a constant because the mark is drawn twice
 * on the sign-in page — once in the masthead and once on the gate — and two elements
 * with the same `id` is a document that only works because the browser picked the
 * first one. `label` is the other half of that: the gate's mark is the only thing
 * naming the product there, so it is labelled; the masthead's sits beside the name in
 * text, so it is decoration.
 */
function Shield({
  gradientId,
  className,
  label,
}: {
  gradientId: string;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={cn("gate__mark-svg", className)}
      viewBox="0 0 48 48"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--tone-its)" />
        </linearGradient>
      </defs>
      <path d={SHIELD} fill={`url(#${gradientId})`} />
      <path
        d={TICK}
        fill="none"
        stroke="var(--brand-ink)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The gate mark: the shield and the tick above the product's name. */
export function ItsGateMark({ className }: { className?: string } = {}) {
  return (
    <Shield gradientId="its-gate-mark" className={className} label="OnTrak IT Support Training" />
  );
}

/** The same mark for the masthead, where the name is already in text beside it. */
export function ItsMastheadMark() {
  return <Shield gradientId="its-masthead-mark" className="masthead__mark" />;
}

/**
 * The mark for the app's own header, where it sits beside the product's name.
 *
 * It was a rounded badge with `</>` in it, which said "software" about a product that
 * teaches people to fix computers, and it was the only mark in the family that did not
 * belong to the family. It is the shield now, at the header's size.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-9 items-center justify-center", className)} aria-hidden>
      <Shield gradientId="its-shell-mark" className="size-9" />
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
