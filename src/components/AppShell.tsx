"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "@/app/actions/auth";
import { Logo } from "@/components/Logo";
import { LocaleToggle } from "@/components/LocaleToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { accentFor, cn, initials } from "@/lib/cn";
import { translate, type Locale } from "@/lib/i18n";
import { messagesFor } from "@/lib/locales";
import { Badge } from "@/components/ui";

export interface NavItem {
  href: string;
  /** Message key, translated at render time. */
  label: string;
  /** Inline SVG path data for a 24x24 stroked icon. */
  icon: string;
  /** Message key for the nav group. */
  group: string;
}

const ICONS = {
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  software: "M12 3l8 4v6c0 4-3.4 7-8 8-4.6-1-8-4-8-8V7z",
  users: "M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1.5a4 4 0 0 0-3-3.87M16.5 3.6a4 4 0 0 1 0 7.75",
  scenarios: "M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4v5h5M8 13h8M8 17h5",
  classes: "M12 4 3 8l9 4 9-4-9-4zM6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5",
  attempts: "M9 4h6v3H9zM6 4h1M17 4h1a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M9 13l2 2 4-4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  play: "M7 4l12 8-12 8z",
  shield: "M12 3l8 4v6c0 4-3.4 7-8 8-4.6-1-8-4-8-8V7zM9.5 12l2 2 3.5-4",
};

const STAFF_NAV: NavItem[] = [
  { href: "/instructor", label: "nav.overview", icon: ICONS.grid, group: "nav.teaching" },
  { href: "/instructor/scenarios", label: "nav.scenarios", icon: ICONS.scenarios, group: "nav.teaching" },
  { href: "/instructor/cohorts", label: "nav.classes", icon: ICONS.classes, group: "nav.teaching" },
  { href: "/instructor/attempts", label: "nav.attempts", icon: ICONS.attempts, group: "nav.teaching" },
  { href: "/instructor/analytics", label: "nav.analytics", icon: ICONS.chart, group: "nav.teaching" },
  { href: "/student", label: "nav.practice", icon: ICONS.play, group: "nav.teaching" },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "nav.controlRoom", icon: ICONS.grid, group: "nav.administration" },
  { href: "/admin/software", label: "nav.software", icon: ICONS.software, group: "nav.administration" },
  { href: "/admin/users", label: "nav.people", icon: ICONS.users, group: "nav.administration" },
  { href: "/admin/audit", label: "nav.audit", icon: ICONS.shield, group: "nav.administration" },
];

const STUDENT_NAV: NavItem[] = [
  { href: "/student", label: "nav.myScenarios", icon: ICONS.play, group: "nav.training" },
  { href: "/student/results", label: "nav.myResults", icon: ICONS.chart, group: "nav.training" },
];

export function navForRole(role: string): NavItem[] {
  if (role === "ADMIN") return [...ADMIN_NAV, ...STAFF_NAV];
  if (role === "INSTRUCTOR") return STAFF_NAV;
  return STUDENT_NAV;
}

interface AppShellProps {
  user: { id: string; name: string; email: string; role: string; accent: string };
  locale: Locale;
  children: React.ReactNode;
}

export function AppShell({ user, locale, children }: AppShellProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const messages = messagesFor(locale);
  const t = (key: string) => translate(messages, key);
  const items = navForRole(user.role);
  const accent = accentFor(user.accent);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isActive = (href: string) => pathname === href || (href !== "/student" && href !== "/admin" && href !== "/instructor" && pathname.startsWith(`${href}/`));

  const groups = [...new Set(items.map((item) => item.group))];

  const nav = (
    <nav className="space-y-6">
      {groups.map((group) => (
        <div key={group}>
          <p className="mb-2 px-3 font-display text-[11px] font-semibold tracking-[0.16em] text-ink-faint uppercase">
            {t(group)}
          </p>
          <ul className="space-y-1">
            {items
              .filter((item) => item.group === group)
              .map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-xl2 px-3 py-2.5 text-sm font-medium transition",
                        active
                          ? "bg-brand-soft text-brand shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--brand)_22%,transparent)]"
                          : "text-ink-soft hover:bg-surface-muted hover:text-ink",
                      )}
                    >
                      <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        className={cn("size-4.5 shrink-0", active ? "text-brand" : "text-ink-faint")}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d={item.icon} />
                      </svg>
                      {t(item.label)}
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const roleLabel =
    user.role === "ADMIN" ? t("role.admin") : user.role === "INSTRUCTOR" ? t("role.instructor") : t("role.student");

  return (
    <div className="relative flex min-h-dvh">
      <div className="mesh-bg pointer-events-none fixed inset-x-0 top-0 h-96 opacity-40" aria-hidden />

      {/* Desktop sidebar */}
      <aside className="relative z-20 hidden w-64 shrink-0 border-r border-line bg-surface/70 px-4 py-5 backdrop-blur lg:flex lg:flex-col">
        <Logo subtitle="IT support training" />
        <div className="mt-8 flex-1 overflow-y-auto">{nav}</div>
        <div className="mt-6 rounded-xl2 border border-line bg-surface-muted/60 p-3">
          <p className="text-[11px] leading-relaxed text-ink-faint">{t("shell.disclaimer")}</p>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="animate-pop relative h-full w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-surface px-4 py-5">
            <div className="mb-6 flex items-center justify-between">
              <Logo subtitle="IT support training" />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-line p-2 text-ink-soft hover:text-brand"
                aria-label="Close navigation"
              >
                <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            {nav}
          </div>
        </div>
      ) : null}

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-xl2 border border-line bg-surface p-2 text-ink-soft transition hover:text-brand lg:hidden"
            aria-label="Open navigation"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>

          <Logo subtitle="IT support" className="lg:hidden" />

          <div className="ml-auto flex items-center gap-2.5">
            <LocaleToggle locale={locale} label={t("shell.language")} />
            <Badge tone={user.role === "ADMIN" ? "pink" : user.role === "INSTRUCTOR" ? "brand" : "teal"} className="hidden sm:inline-flex">
              {roleLabel}
            </Badge>
            <ThemeToggle />
            <div className="flex items-center gap-2.5 rounded-full border border-line bg-surface py-1 pr-1 pl-1.5">
              <span className={cn("flex size-8 items-center justify-center rounded-full text-xs font-bold", accent.bg, accent.text)}>
                {initials(user.name)}
              </span>
              <span className="hidden max-w-32 truncate text-xs font-semibold text-ink sm:block">{user.name}</span>
              <form action={signOut}>
                <button
                  type="submit"
                  className="rounded-full p-1.5 text-ink-faint transition hover:bg-pink/12 hover:text-pink"
                  aria-label={t("shell.signOut")}
                  title={t("shell.signOut")}
                >
                  <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 17l5-5-5-5M20 12H9M12 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h6" />
                  </svg>
                </button>
              </form>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
