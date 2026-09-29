"use client";

/**
 * The desk navigation.
 *
 * A service desk has one job above all others: making it obvious where the work is.
 * The old header was a single flat row of fifteen links, which is the shape that
 * makes a desk feel like a pile — everything equally loud, nothing findable. So the
 * links are grouped by what a person is doing (work, knowledge, service,
 * operations, administration) and the current section is highlighted.
 *
 * The highlight is the reason this is a client component: `usePathname` is the only
 * way to know which link is current, and being able to see that at a glance is
 * worth the small amount of JavaScript. Everything else about the shell is server
 * rendered.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  /** A count worth surfacing next to the link (unread notifications, say). */
  badge?: number;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export function DeskNav({ groups, label = "Desk" }: { groups: NavGroup[]; label?: string }) {
  const pathname = usePathname();

  // The active link is the *most specific* one that matches, so `/inbox/new` lights
  // "New ticket" rather than "Inbox" — comparing on prefix length is what makes a
  // nested route resolve to the right entry instead of all of its ancestors.
  const active = groups
    .flatMap((group) => group.items.map((item) => item.href))
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav aria-label={label} className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = item.href === active;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex items-center gap-2 rounded-xl2 px-3 py-1.5 text-sm ${
                      isActive
                        ? "bg-brand-soft font-semibold text-brand"
                        : "text-ink-soft hover:bg-surface-muted hover:text-ink"
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.badge && item.badge > 0 ? (
                      <span className="ml-auto rounded-full bg-attention/15 px-1.5 text-[11px] font-semibold text-attention">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
