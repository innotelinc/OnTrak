import Link from "next/link";
import { cn } from "@/lib/cn";

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
