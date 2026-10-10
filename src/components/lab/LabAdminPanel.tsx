import Link from "next/link";
import type { ReactNode } from "react";

import { ADMIN_SECTIONS } from "@/lib/lab/admin";
import { Alert } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/cn";

/**
 * The panel's chrome: a page header, the section nav, and the page.
 *
 * Presentational on purpose — it takes what it draws and reads nothing — so the nav and the
 * "not running here" state can be rendered with no server, no database and no runtime behind
 * them, which is what lets an accessibility sweep reach them (the same reason the write-up
 * form and the console panel are presentational).
 */
export function LabAdminPanel({
  section,
  title,
  description,
  actions,
  children,
}: {
  section: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader eyebrow="OnTrak Lab · Admin" title={title} description={description} actions={actions} />
      <LabAdminNav current={section} />
      {children}
    </div>
  );
}

/**
 * The section nav.
 *
 * `aria-current="page"` rather than a colour alone: the panel is read at 3am by whoever is on
 * call, and "which of these six am I looking at" must not depend on being able to tell two
 * teals apart.
 */
export function LabAdminNav({ current }: { current: string }) {
  return (
    <nav aria-label="Lab admin sections" className="flex flex-wrap gap-1.5">
      {ADMIN_SECTIONS.map((section) => {
        const active = section.id === current;
        return (
          <Link
            key={section.id}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition",
              active
                ? "border-brand/40 bg-brand/12 text-brand"
                : "border-line text-ink-soft hover:border-brand/30 hover:text-brand",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * What the panel shows when this deployment does not serve the lab here.
 *
 * The reason is the runtime's own sentence (or the door's), never a stack trace: a
 * deployment that links to a peer lab, or one that has not set its guest password, must read
 * as a fact about the deployment rather than as a broken page.
 */
export function LabOff({ reason }: { reason: string | null }) {
  return (
    <Alert tone="amber" title="OnTrak Lab is not running on this deployment">
      {reason ?? "This deployment does not run OnTrak Lab here."}
    </Alert>
  );
}
