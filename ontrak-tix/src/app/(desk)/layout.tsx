import Link from "next/link";
import type { ReactNode } from "react";

import { signOutAction } from "../actions/session";
import { currentActor, currentSessionName } from "../../lib/session";
import { hasPermission } from "../../lib/access-rules";
import { notificationServicesFor } from "../../lib/db";

/**
 * The desk shell: the chrome every signed-in screen sits inside.
 *
 * It reads the actor only to choose the right navigation — staff get the desk,
 * requesters get the portal. Each page still calls `requireActor()` itself, so
 * a page can never be reached with a stale or absent session just because the
 * shell rendered.
 */
export default async function DeskLayout({ children }: { children: ReactNode }) {
  const [actor, name] = await Promise.all([currentActor(), currentSessionName()]);
  const isRequester = actor?.role === "REQUESTER";
  // Tenant-wide configuration is an administrator's view, not an agent's.
  const canManageTenant = actor ? hasPermission(actor.role, "tenant:manage") : false;
  // Staff-only, and only counted when there is somewhere to show it: the bell
  // is a courtesy, so a signed-out shell never touches the database.
  const unread = actor && !isRequester ? (await notificationServicesFor().listFor(actor)).unread : 0;

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-4 border-b border-line pb-4">
        <Link href={isRequester ? "/portal" : "/inbox"} className="font-display text-lg font-semibold text-ink">
          OnTrak <span className="text-brand">Tix</span>
        </Link>
        <nav aria-label="Desk" className="flex items-center gap-4 text-sm font-semibold text-ink-soft">
          {isRequester ? (
            <>
              <Link href="/portal" className="hover:text-brand">
                My tickets
              </Link>
              <Link href="/portal/new" className="hover:text-brand">
                New request
              </Link>
            </>
          ) : (
            <>
              <Link href="/inbox" className="hover:text-brand">
                Inbox
              </Link>
              <Link href="/inbox/new" className="hover:text-brand">
                New ticket
              </Link>
              <Link href="/reports" className="hover:text-brand">
                Reports
              </Link>
              <Link href="/time" className="hover:text-brand">
                Time
              </Link>
              <Link href="/canned" className="hover:text-brand">
                Canned
              </Link>
              <Link href="/templates" className="hover:text-brand">
                Templates
              </Link>
              <Link href="/knowledge" className="hover:text-brand">
                Knowledge
              </Link>
              <Link href="/rules" className="hover:text-brand">
                Rules
              </Link>
              <Link href="/macros" className="hover:text-brand">
                Macros
              </Link>
              <Link href="/security" className="hover:text-brand">
                Security
              </Link>
              <Link href="/incidents" className="hover:text-brand">
                Incidents
              </Link>
              <Link href="/clients" className="hover:text-brand">
                Clients
              </Link>
              <Link href="/handoff" className="hover:text-brand">
                Handoff
              </Link>
              {canManageTenant ? (
                <>
                  <Link href="/admin/identity" className="hover:text-brand">
                    Identity
                  </Link>
                  <Link href="/admin/forms" className="hover:text-brand">
                    Fields
                  </Link>
                  <Link href="/admin/integrations" className="hover:text-brand">
                    Integrations
                  </Link>
                </>
              ) : null}
              <Link href="/notifications" className="hover:text-brand">
                Notifications
                {unread > 0 ? (
                  <span className="ml-1.5 rounded-full bg-amber/10 px-1.5 py-0.5 text-[11px] font-semibold text-amber">{unread}</span>
                ) : null}
              </Link>
            </>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-ink-faint">
          {name ? <span>Signed in as {name}</span> : <span>Not signed in</span>}
          {name ? (
            <form action={signOutAction}>
              <button type="submit" className="font-semibold text-brand hover:underline">
                Sign out
              </button>
            </form>
          ) : null}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
