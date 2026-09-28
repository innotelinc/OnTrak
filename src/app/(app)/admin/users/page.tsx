import type { Metadata } from "next";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { createUser, deleteUser, updateUser } from "@/app/actions/admin";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, Card, Field, Input, Select, Stat } from "@/components/ui";
import { accentFor, cn, formatRelative, initials } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "People" };

const ROLE_TONE: Record<Role, "pink" | "brand" | "teal"> = {
  ADMIN: "pink",
  INSTRUCTOR: "brand",
  STUDENT: "teal",
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string; role?: string }>;
}) {
  const { flash, error, role } = await searchParams;
  const admin = await requireSession();
  const t = await getTranslator();
  const roleLabel = (value: Role) =>
    t(value === "ADMIN" ? "role.admin" : value === "INSTRUCTOR" ? "role.instructor" : "role.student");

  const [users, cohorts, counts] = await Promise.all([
    prisma.user.findMany({
      where: role && ["ADMIN", "INSTRUCTOR", "STUDENT"].includes(role) ? { role: role as Role } : {},
      include: {
        _count: { select: { attempts: true, memberships: true, scenariosAuthored: true } },
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
      take: 500,
    }),
    prisma.cohort.findMany({ select: { id: true, name: true, joinCode: true }, orderBy: { name: "asc" } }),
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
  ]);

  const countFor = (which: Role) => counts.find((entry) => entry.role === which)?._count._all ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("users.eyebrow")}
        title={t("users.title")}
        description={t("users.description")}
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label={t("users.stat.students")} value={countFor("STUDENT")} tone="teal" />
        <Stat label={t("users.stat.instructors")} value={countFor("INSTRUCTOR")} tone="brand" />
        <Stat label={t("users.stat.admins")} value={countFor("ADMIN")} tone="pink" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {(["", "STUDENT", "INSTRUCTOR", "ADMIN"] as const).map((value) => (
              <a
                key={value || "all"}
                href={value ? `/admin/users?role=${value}` : "/admin/users"}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-xs font-semibold transition",
                  (role ?? "") === value ? "gradient-brand text-white shadow-card" : "border border-line bg-surface text-ink-soft",
                )}
              >
                {value ? `${roleLabel(value)}s` : t("users.filterAll", { count: users.length })}
              </a>
            ))}
          </div>

          <ul className="mt-4 space-y-3">
            {users.map((user) => {
              const accent = accentFor(user.accent);
              return (
                <li key={user.id}>
                  <Card className={cn("p-5", !user.active && "opacity-75")}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          className={cn(
                            "flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                            accent.bg,
                            accent.text,
                          )}
                        >
                          {initials(user.name)}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate font-display text-base font-semibold text-ink">{user.name}</h3>
                            <Badge tone={ROLE_TONE[user.role]}>{roleLabel(user.role)}</Badge>
                            {user.active ? (
                              <Badge tone="teal">{t("users.active")}</Badge>
                            ) : (
                              <Badge tone="danger">{t("users.deactivated")}</Badge>
                            )}
                            {user.id === admin.id ? <Badge tone="lime">{t("users.you")}</Badge> : null}
                          </div>
                          <p className="mt-0.5 truncate text-xs text-ink-faint">{user.email}</p>
                          <p className="mt-1 text-[11px] text-ink-faint">
                            {t("users.counts", { attempts: user._count.attempts, classes: user._count.memberships })}
                            {user._count.scenariosAuthored > 0
                              ? t("users.scenariosAuthored", { count: user._count.scenariosAuthored })
                              : ""}
                            {t("users.lastSeen", {
                              when: user.lastLoginAt ? formatRelative(user.lastLoginAt) : t("users.never"),
                            })}
                          </p>
                        </div>
                      </div>

                      <form action={deleteUser}>
                        <input type="hidden" name="id" value={user.id} />
                        <Button type="submit" variant="danger" size="sm" disabled={user.id === admin.id}>
                          {t("users.delete")}
                        </Button>
                      </form>
                    </div>

                    <details className="mt-4">
                      <summary className="cursor-pointer text-xs font-semibold text-ink-soft transition hover:text-brand">
                        {t("users.editAccount")}
                      </summary>
                      <form action={updateUser} className="mt-3 grid gap-3 sm:grid-cols-2">
                        <input type="hidden" name="id" value={user.id} />
                        <Field label={t("users.name")} htmlFor={`n-${user.id}`}>
                          <Input id={`n-${user.id}`} name="name" defaultValue={user.name} />
                        </Field>
                        <Field label={t("users.role")} htmlFor={`r-${user.id}`}>
                          <Select id={`r-${user.id}`} name="role" defaultValue={user.role} disabled={user.id === admin.id}>
                            <option value="STUDENT">{t("role.student")}</option>
                            <option value="INSTRUCTOR">{t("role.instructor")}</option>
                            <option value="ADMIN">{t("role.admin")}</option>
                          </Select>
                        </Field>
                        <Field label={t("users.newPassword")} htmlFor={`pw-${user.id}`} hint={t("users.keepPassword")}>
                          <Input id={`pw-${user.id}`} name="password" type="password" autoComplete="new-password" placeholder="••••••••" />
                        </Field>
                        <label className="flex items-center gap-3 self-end rounded-xl2 border border-line bg-surface px-3.5 py-2.5">
                          <input
                            type="checkbox"
                            name="active"
                            defaultChecked={user.active}
                            disabled={user.id === admin.id}
                            className="size-4 accent-[var(--brand)]"
                          />
                          <span className="text-sm text-ink">{t("users.accountActive")}</span>
                        </label>
                        <div className="sm:col-span-2">
                          <Button type="submit" size="sm">
                            {t("users.saveChanges")}
                          </Button>
                        </div>
                      </form>
                    </details>
                  </Card>
                </li>
              );
            })}
          </ul>
        </div>

        <Card className="h-fit lg:sticky lg:top-24">
          <h2 className="font-display text-base font-semibold text-ink">{t("users.addPerson")}</h2>
          <p className="mt-1 text-xs text-ink-soft">{t("users.addPersonHint")}</p>

          <form action={createUser} className="mt-4 space-y-3.5">
            <Field label={t("users.fullName")} htmlFor="new-name">
              <Input id="new-name" name="name" placeholder="Priya Nair" required />
            </Field>
            <Field label={t("users.email")} htmlFor="new-email">
              <Input id="new-email" name="email" type="email" placeholder="priya@college.edu" required />
            </Field>
            <Field label={t("users.tempPassword")} htmlFor="new-password" hint={t("users.passwordMin")}>
              <Input id="new-password" name="password" type="password" autoComplete="new-password" required />
            </Field>
            <Field label={t("users.role")} htmlFor="new-role">
              <Select id="new-role" name="role" defaultValue="STUDENT">
                <option value="STUDENT">{t("role.student")}</option>
                <option value="INSTRUCTOR">{t("role.instructor")}</option>
                <option value="ADMIN">{t("role.admin")}</option>
              </Select>
            </Field>
            <Field label={t("users.addToClass")} htmlFor="new-cohort" hint={t("cohorts.optional")}>
              <Select id="new-cohort" name="cohortId" defaultValue="">
                <option value="">{t("users.noClass")}</option>
                {cohorts.map((cohort) => (
                  <option key={cohort.id} value={cohort.id}>
                    {cohort.name} ({cohort.joinCode})
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" className="w-full">
              {t("users.createAccount")}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
