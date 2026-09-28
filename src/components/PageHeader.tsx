import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0 max-w-2xl">
        {eyebrow ? (
          <p className="mb-1 font-display text-xs font-semibold tracking-[0.18em] text-brand uppercase">{eyebrow}</p>
        ) : null}
        <h1 className="font-display text-2xl font-semibold text-balance text-ink sm:text-3xl">{title}</h1>
        {description ? <p className="mt-1.5 text-sm text-ink-soft">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Messages carried back from a server action through the query string.
 * Simple, bookmarkable and works without any client-side state.
 */
export function Flash({ flash, error }: { flash?: string | string[]; error?: string | string[] }) {
  const okMessage = Array.isArray(flash) ? flash[0] : flash;
  const errorMessage = Array.isArray(error) ? error[0] : error;
  if (!okMessage && !errorMessage) return null;

  return (
    <div className="mt-5 space-y-2">
      {errorMessage ? (
        <div className="animate-rise rounded-xl2 border border-pink/35 bg-pink/12 px-4 py-3 text-sm text-ink">
          <span className="font-semibold text-pink">Could not do that. </span>
          {errorMessage}
        </div>
      ) : null}
      {okMessage ? (
        <div className="animate-rise rounded-xl2 border border-teal/35 bg-teal/12 px-4 py-3 text-sm text-ink">
          <span className="font-semibold text-teal">Done. </span>
          {okMessage}
        </div>
      ) : null}
    </div>
  );
}
