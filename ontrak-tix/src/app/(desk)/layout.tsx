import Link from "next/link";
import type { ReactNode } from "react";

import { DeskNav, type NavGroup } from "../../components/DeskNav";
import { ThemeToggle } from "../../components/ThemeToggle";
import { signOutAction } from "../actions/session";
import { currentActor, currentSessionName } from "../../lib/session";
import { hasPermission } from "../../lib/access-rules";
import { notificationServicesFor } from "../../lib/db";

/**
 * The desk shell: the chrome every signed-in screen sits inside.
 *
 * A service desk is a place a person works all day, so the shell does the two
 * things that make that bearable: it shows the whole map of the product in a
 * permanent rail (grouped, with the current section marked), and it keeps the
 * controls that are not navigation — the theme switch, who you are, signing out —
 * out of the way in a top bar.
 *
 * It reads the actor only to choose the right navigation — staff get the desk,
 * requesters get the portal. Each page still calls `requireActor()` itself, so a
 * page can never be reached with a stale or absent session just because the shell
 * rendered.
 */
export default async function DeskLayout({ children }: { children: ReactNode }) {
  const [actor, name] = await Promise.all([currentActor(), currentSessionName()]);
  const isRequester = actor?.role === "REQUESTER";
  // Tenant-wide configuration is an administrator's view, not an agent's.
  const canManageTenant = actor ? hasPermission(actor.role, "tenant:manage") : false;
  // Staff-only, and only counted when there is somewhere to show it: the badge
  // is a courtesy, so a signed-out shell never touches the database.
  const unread = actor && !isRequester ? (await notificationServicesFor().listFor(actor)).unread : 0;

  const home = isRequester ? "/portal" : "/dashboard";

  const groups: NavGroup[] = isRequester
    ? [
        {
          title: "My requests",
          items: [
            { href: "/portal", label: "My tickets" },
            { href: "/portal/new", label: "New request" },
          ],
        },
      ]
    : [
        {
          title: "Work",
          items: [
            { href: "/dashboard", label: "Overview" },
            { href: "/inbox", label: "Inbox" },
            { href: "/inbox/new", label: "New ticket" },
            { href: "/handoff", label: "Handoff" },
          ],
        },
        {
          title: "Knowledge",
          items: [
            { href: "/knowledge", label: "Articles" },
            { href: "/canned", label: "Canned replies" },
            { href: "/templates", label: "Templates" },
            { href: "/macros", label: "Macros" },
            { href: "/rules", label: "Rules" },
          ],
        },
        {
          title: "Service",
          items: [
            { href: "/clients", label: "Clients" },
            { href: "/reports", label: "Reports" },
            { href: "/time", label: "Time" },
          ],
        },
        {
          title: "Operations",
          items: [
            { href: "/incidents", label: "Incidents" },
            { href: "/security", label: "Security" },
            { href: "/notifications", label: "Notifications", badge: unread },
          ],
        },
        ...(canManageTenant
          ? [
              {
                title: "Administration",
                items: [
                  { href: "/admin/identity", label: "Identity" },
                  { href: "/admin/forms", label: "Fields" },
                  { href: "/admin/integrations", label: "Integrations" },
                ],
              },
            ]
          : []),
      ];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1440px]">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line px-3 py-5 lg:flex">
        <Link href={home} className="px-3 pb-6 font-display text-lg font-semibold text-ink">
          OnTrak <span className="text-brand">Tix</span>
        </Link>
        <DeskNav groups={groups} />
        <div className="mt-auto px-3 pt-6 text-[11px] text-ink-faint">
          <a href="https://ontrak.innotel.us" className="hover:text-brand">
            OnTrak Unity ↗
          </a>
          <p className="mt-1">Innotel Labs · the Network</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur lg:px-6">
          <Link href={home} className="font-display text-lg font-semibold text-ink lg:hidden">
            OnTrak <span className="text-brand">Tix</span>
          </Link>

          {/* Small screens get the same map, folded into a disclosure. No JavaScript,
              so the navigation works even if the client bundle has not arrived. */}
          <details className="relative lg:hidden">
            <summary className="cursor-pointer list-none rounded-xl2 border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft">
              Menu
            </summary>
            <div className="absolute left-0 z-20 mt-2 w-60 rounded-xl2 border border-line bg-surface p-3 shadow-[var(--shadow-pop)]">
              <DeskNav groups={groups} label="Desk (small screen)" />
            </div>
          </details>

          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            {name ? (
              <>
                <span className="hidden text-xs text-ink-faint sm:inline">
                  Signed in as <strong className="font-semibold text-ink-soft">{name}</strong>
                </span>
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-brand hover:text-brand"
                  >
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <span className="text-xs text-ink-faint">Not signed in</span>
            )}
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 lg:px-6">{children}</main>
      </div>
    </div>
  );
}
