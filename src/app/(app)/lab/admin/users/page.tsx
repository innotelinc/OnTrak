import Link from "next/link";
import type { Metadata } from "next";
import type { Role } from "@prisma/client";

import { prisma } from "@/lib/db";
import { ROLE_LABELS } from "@/lib/auth";
import { requireLabStaff } from "@/lib/lab-admin-access";
import { LabAdminPanel } from "@/components/lab/LabAdminPanel";
import { Badge, Card, EmptyState, SectionHeading, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";

export const metadata: Metadata = { title: "Lab — accounts" };

/**
 * Who can sign in, and the role each account carries.
 *
 * This is `admin.py`'s `/admin/users` with its write half removed, and the removal is the
 * port's decision rather than an omission (§3/C2). The lab's own SQLite `users` table is
 * superseded by the app's identity: a person is an account here, their role comes from the
 * family's vocabulary, and both are re-read on every sign-in. So there is nothing this page
 * could change that would not be a *second* writable account surface — exactly the "two
 * sources of truth" the consolidation audit refuses, and the more dangerous of the two would
 * be whichever people trusted.
 *
 * The writable surface stays the app's own `/admin/users`, where the roles, activation and
 * cohort membership that the training half already depends on are managed. This page names
 * that door for an administrator and, for an instructor, says plainly which role can open it —
 * rather than drawing controls that would be refused.
 *
 * It needs no runtime at all: accounts belong to the deployment, not to a lab, so the section
 * reads the same whether or not this deployment serves machines.
 */
export default async function LabAdminUsersPage() {
  const staff = await requireLabStaff();

  const [accounts, counts] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, active: true, updatedAt: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      take: 500,
    }),
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
  ]);

  const countFor = (role: Role) => counts.find((entry) => entry.role === role)?._count._all ?? 0;
  const deactivated = accounts.filter((account) => !account.active).length;

  return (
    <LabAdminPanel
      section="users"
      title="Accounts"
      description="The people who can sign in to this deployment, and the role each one carries."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Students" value={String(countFor("STUDENT"))} tone="teal" />
        <Stat label="Instructors" value={String(countFor("INSTRUCTOR"))} tone="brand" />
        <Stat label="Administrators" value={String(countFor("ADMIN"))} tone="pink" />
        <Stat label="Deactivated" value={String(deactivated)} />
      </div>

      <Card className="space-y-3">
        <SectionHeading
          title="Where a role is changed"
          description="One place, so an offboarding cannot half-happen."
        />
        <p className="text-xs text-ink-soft">
          {staff.role === "ADMIN" ? (
            <>
              Roles, activation and cohorts are managed in the app&apos;s own{" "}
              <Link href="/admin/users" className="font-semibold text-brand hover:underline">
                People page
              </Link>
              . This panel is read-only on purpose: the lab files its results against the account
              this deployment already has, so a second place to change one would be a second place
              for the two to disagree.
            </>
          ) : (
            <>
              Roles and activation are managed by an administrator on the app&apos;s People page.
              This panel is read-only on purpose — the lab files its results against the account
              this deployment already has, so there is one place a role is changed.
            </>
          )}
        </p>
      </Card>

      <Card className="space-y-3">
        <SectionHeading
          title="Everyone"
          description={`${accounts.length} account${accounts.length === 1 ? "" : "s"}, administrators first.`}
        />
        {accounts.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            description="Accounts appear the first time their owner signs in, or when a roster is imported."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every account on this deployment</caption>
              <thead>
                <tr className="text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-4 font-semibold">Name</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Email</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Role</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">State</th>
                  <th scope="col" className="py-2 font-semibold">Last change</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id} className="border-t border-line">
                    <td className="py-2 pr-4 font-semibold text-ink">{account.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-ink-soft">{account.email}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={account.role === "ADMIN" ? "pink" : account.role === "INSTRUCTOR" ? "brand" : "teal"}>
                        {ROLE_LABELS[account.role]}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {account.active ? (
                        <span className="text-ink-soft">can sign in</span>
                      ) : (
                        <span className="text-pink">deactivated</span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs text-ink-faint">
                      {formatDateTime(account.updatedAt.toISOString())}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </LabAdminPanel>
  );
}
