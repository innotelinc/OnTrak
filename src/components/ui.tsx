import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/* -------------------------------------------------------------------------- */
/*  Surfaces                                                                  */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className,
  style,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag className={cn("card-surface rounded-xl3 p-6", className)} style={style}>
      {children}
    </Tag>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="max-w-2xl">
        {eyebrow ? (
          <p className="mb-1 font-display text-xs font-semibold tracking-[0.18em] text-brand uppercase">{eyebrow}</p>
        ) : null}
        <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-1.5 text-sm text-ink-soft">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Buttons                                                                   */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "gradient-brand text-white shadow-card hover:shadow-lift hover:brightness-105 active:brightness-95 border-transparent",
  secondary:
    "bg-surface text-ink border-line hover:border-brand/45 hover:text-brand hover:bg-brand-soft/60",
  ghost: "bg-transparent text-ink-soft border-transparent hover:bg-surface-muted hover:text-ink",
  danger: "bg-pink/12 text-pink border-pink/30 hover:bg-pink/20",
  success: "bg-teal/14 text-teal border-teal/30 hover:bg-teal/22",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5 rounded-full",
  md: "px-4.5 py-2.5 text-sm gap-2 rounded-full",
  lg: "px-6 py-3 text-base gap-2.5 rounded-full",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn(
    "inline-flex items-center justify-center border font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className,
  prefetch,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  prefetch?: boolean;
}) {
  return (
    <Link href={href} prefetch={prefetch} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*  Badges & pills                                                            */
/* -------------------------------------------------------------------------- */

export type Tone = "brand" | "pink" | "amber" | "teal" | "sky" | "lime" | "neutral" | "danger";

const TONES: Record<Tone, string> = {
  brand: "bg-brand/12 text-brand border-brand/22",
  pink: "bg-pink/14 text-pink border-pink/25",
  amber: "bg-amber/18 text-amber border-amber/28",
  teal: "bg-teal/14 text-teal border-teal/26",
  sky: "bg-sky/14 text-sky border-sky/26",
  lime: "bg-lime/20 text-lime border-lime/30",
  neutral: "bg-surface-muted text-ink-soft border-line",
  danger: "bg-pink/14 text-pink border-pink/30",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return <span className={cn("inline-block size-1.5 rounded-full", className)} aria-hidden />;
}

/* -------------------------------------------------------------------------- */
/*  Data display                                                              */
/* -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  hint,
  tone = "brand",
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  return (
    <div className="card-surface rounded-xl2 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{label}</p>
        {icon ? <span className={cn("rounded-full border p-1.5", TONES[tone])}>{icon}</span> : null}
      </div>
      <p className="mt-2 font-display text-3xl font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = "brand",
  className,
  label,
}: {
  value: number;
  tone?: Tone;
  className?: string;
  /** Accessible name; falls back to a generic one so the bar is never unlabelled. */
  label?: string;
}) {
  const fill: Record<Tone, string> = {
    brand: "gradient-brand",
    pink: "bg-pink",
    amber: "bg-amber",
    teal: "bg-teal",
    sky: "bg-sky",
    lime: "bg-lime",
    neutral: "bg-ink-faint",
    danger: "bg-pink",
  };
  const clamped = Math.round(Math.max(0, Math.min(100, value)));
  return (
    <div
      role="progressbar"
      aria-label={label ?? "Progress"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={cn("h-2.5 w-full overflow-hidden rounded-full bg-surface-muted", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", fill[tone])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl3 border border-dashed border-line bg-surface/60 px-6 py-14 text-center">
      {icon ? <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">{icon}</div> : null}
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      {description ? <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">{description}</p> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Alert({
  tone = "brand",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded-xl2 border px-4 py-3 text-sm", TONES[tone])} role="status">
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className={cn(title && "mt-1", "text-ink-soft")}>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Form controls                                                             */
/* -------------------------------------------------------------------------- */

const CONTROL =
  "w-full rounded-xl2 border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint transition focus:border-brand/50 focus:bg-surface focus:outline-none disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <label className={cn("block", className)} htmlFor={htmlFor}>
      <span className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-ink">{label}</span>
        {hint ? <span className="text-xs text-ink-faint">{hint}</span> : null}
      </span>
      {children}
      {error ? <span className="mt-1.5 block text-xs font-medium text-pink">{error}</span> : null}
    </label>
  );
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, "min-h-28 resize-y font-mono text-[13px] leading-relaxed", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL, "cursor-pointer appearance-none bg-[length:14px] pr-9", className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({
  name,
  defaultChecked,
  label,
  description,
  disabled,
}: {
  name: string;
  defaultChecked?: boolean;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl2 border border-line bg-surface p-4 transition hover:border-brand/30",
        "has-checked:border-brand/40 has-checked:bg-brand-soft/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} className="peer sr-only" />
      <span
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-line bg-surface-muted transition",
          "peer-checked:border-brand peer-checked:bg-brand peer-checked:[&>span]:translate-x-4.5",
        )}
      >
        <span className="absolute top-0.5 left-0.5 size-4.5 rounded-full bg-surface shadow-sm transition-transform duration-200" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-soft">{description}</span> : null}
      </span>
    </label>
  );
}
