import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { evaluatePackage, evaluateScenario, loadAvailabilityContext } from "@/lib/availability";
import { toDefinition } from "@/lib/scenarios";
import { serializeDefinition } from "@/lib/templates";
import { createAssignment, deleteAssignment, detachSoftware } from "@/app/actions/instructor";
import { ScenarioEditor } from "@/components/instructor/ScenarioEditor";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, ButtonLink, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { formatDateTime, formatRelative } from "@/lib/cn";
import { currentLocale, getTranslator } from "@/lib/i18n-server";
import { LocaleProvider } from "@/lib/i18n-client";

export const metadata: Metadata = { title: "Edit scenario" };

export default async function EditScenarioPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { id } = await params;
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();
  const locale = await currentLocale();

  const scenario = await prisma.scenario.findUnique({
    where: { id },
    include: {
      software: { include: { softwarePackage: true } },
      assignments: {
        include: {
          cohort: { select: { id: true, name: true } },
          student: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      author: { select: { name: true } },
      _count: { select: { attempts: true } },
    },
  });
  if (!scenario) notFound();

  const [software, cohorts, context] = await Promise.all([
    prisma.softwarePackage.findMany({ orderBy: [{ platform: "asc" }, { name: "asc" }] }),
    prisma.cohort.findMany({
      where: user.role === "ADMIN" ? {} : { instructorId: user.id },
      orderBy: { name: "asc" },
    }),
    loadAvailabilityContext(),
  ]);

  const students = await prisma.user.findMany({
    where: { role: "STUDENT", active: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
    take: 500,
  });

  const availability = evaluateScenario(scenario, context);
  const definition = toDefinition(scenario);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow={`${scenario.platform.toLowerCase()} · ${scenario.author.name}`}
        title={scenario.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={scenario.published ? "teal" : "neutral"}>
              {scenario.published ? t("instructor.badge.published") : t("instructor.badge.draft")}
            </Badge>
            <Badge tone={availability.available ? "teal" : "danger"}>
              {availability.available ? t("instructor.badge.runnable") : t("scenarios.badge.blocked")}
            </Badge>
            <Badge tone="neutral">{scenario._count.attempts} attempt(s)</Badge>
            <span className="text-xs text-ink-faint">
              {t("scenarios.detail.updated", { when: formatRelative(scenario.updatedAt) })}
            </span>
          </span>
        }
        actions={
          <>
            <ButtonLink href={`/instructor/scenarios`} variant="secondary" size="sm">
              {t("scenarios.detail.all")}
            </ButtonLink>
            <ButtonLink href={`/instructor/attempts?scenarioId=${scenario.id}`} variant="secondary" size="sm">
              {t("scenarios.detail.attempts")}
            </ButtonLink>
          </>
        }
      />
      <Flash flash={flash} error={error} />

      {!availability.available ? (
        <Card className="mt-5 border-pink/35">
          <h2 className="font-display text-sm font-semibold text-ink">{t("scenarios.detail.notAvailable")}</h2>
          <ul className="mt-2 space-y-1.5">
            {availability.blockers.map((blocker, index) => (
              <li key={index} className="text-sm text-ink-soft">
                · {blocker.message}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-faint">{t("scenarios.detail.notAvailableHint")}</p>
        </Card>
      ) : null}

      <div className="mt-6">
        <LocaleProvider locale={locale}>
        <ScenarioEditor
          scenarioId={scenario.id}
          initial={{
            title: scenario.title,
            slug: scenario.slug,
            summary: scenario.summary,
            difficulty: scenario.difficulty,
            timeLimitSec: scenario.timeLimitSec,
            passScore: scenario.passScore,
            published: scenario.published,
            tags: scenario.tags.join(", "),
            definition: serializeDefinition(definition),
          }}
          softwareOptions={software.map((pkg) => ({
            id: pkg.id,
            name: pkg.name,
            platform: pkg.platform,
            enabled: pkg.enabled,
            ready: evaluatePackage(pkg).length === 0,
          }))}
          selectedSoftwareIds={scenario.software.map((link) => link.softwarePackageId)}
        />
        </LocaleProvider>
      </div>

      {/* --------------------------------------------------------- assignments */}
      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-ink">{t("scenarios.detail.assignments")}</h2>
        <p className="text-sm text-ink-soft">{t("scenarios.detail.assignmentsHint")}</p>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Card className="p-0">
            {scenario.assignments.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-soft">{t("scenarios.detail.notAssigned")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {scenario.assignments.map((assignment) => (
                  <li key={assignment.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">
                        {assignment.cohort
                          ? t("scenarios.detail.class", { name: assignment.cohort.name })
                          : t("scenarios.detail.student", { name: assignment.student?.name ?? "—" })}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {assignment.dueAt
                          ? t("scenarios.detail.due", { when: formatDateTime(assignment.dueAt) })
                          : t("scenarios.detail.noDeadline")}{" "}
                        ·{" "}
                        {assignment.timeLimitSec
                          ? t("scenarios.detail.minLimit", { minutes: Math.round(assignment.timeLimitSec / 60) })
                          : t("scenarios.detail.scenarioLimit")}{" "}
                        ·{" "}
                        {assignment.maxAttempts > 0
                          ? t("scenarios.detail.attemptCap", { count: assignment.maxAttempts })
                          : t("scenarios.detail.unlimited")}{" "}
                        ·{" "}
                        {t("scenarios.detail.created", { when: formatRelative(assignment.createdAt) })}
                      </p>
                      {assignment.instructions ? (
                        <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{assignment.instructions}</p>
                      ) : null}
                    </div>
                    <form action={deleteAssignment}>
                      <input type="hidden" name="id" value={assignment.id} />
                      <Button type="submit" variant="danger" size="sm">
                        {t("scenarios.detail.remove")}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h3 className="font-display text-base font-semibold text-ink">{t("scenarios.detail.newAssignment")}</h3>
            <form action={createAssignment} className="mt-4 space-y-3.5">
              <input type="hidden" name="scenarioId" value={scenario.id} />

              <Field label={t("scenarios.detail.classLabel")} htmlFor="cohortId">
                <Select id="cohortId" name="cohortId" defaultValue="">
                  <option value="">{t("scenarios.detail.noClassOption")}</option>
                  {cohorts.map((cohort) => (
                    <option key={cohort.id} value={cohort.id}>
                      {cohort.name} ({cohort.joinCode})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("scenarios.detail.orStudent")} htmlFor="studentId">
                <Select id="studentId" name="studentId" defaultValue="">
                  <option value="">{t("scenarios.detail.pickStudent")}</option>
                  {students.map((student) => (
                    <option key={student.id} value={student.id}>
                      {student.name} ({student.email})
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={t("scenarios.detail.deadline")} htmlFor="dueAt" hint={t("scenarios.detail.optional")}>
                <Input id="dueAt" name="dueAt" type="datetime-local" />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t("scenarios.detail.timeLimit")} htmlFor="assignLimit" hint={t("scenarios.detail.minutes")}>
                  <Input
                    id="assignLimit"
                    name="timeLimitMinutes"
                    type="number"
                    min={0}
                    step={1}
                    placeholder={t("scenarios.detail.scenarioDefault")}
                  />
                </Field>
                <Field label={t("scenarios.detail.maxAttempts")} htmlFor="maxAttempts" hint={t("scenarios.detail.unlimitedHint")}>
                  <Input id="maxAttempts" name="maxAttempts" type="number" min={0} defaultValue={0} />
                </Field>
              </div>

              <Field label={t("scenarios.detail.note")} htmlFor="instructions">
                <Textarea
                  id="instructions"
                  name="instructions"
                  className="min-h-20"
                  placeholder={t("scenarios.detail.notePlaceholder")}
                />
              </Field>

              <Button type="submit" className="w-full">
                {t("scenarios.detail.createAssignment")}
              </Button>
              <p className="text-center text-[11px] text-ink-faint">{t("scenarios.detail.choose")}</p>
            </form>
          </Card>
        </div>

        {scenario.software.length > 0 ? (
          <Card className="mt-6 p-0">
            <div className="border-b border-line px-5 py-3">
              <h3 className="font-display text-sm font-semibold text-ink">{t("scenarios.detail.requiredSoftware")}</h3>
            </div>
            <ul className="divide-y divide-line">
              {scenario.software.map((link) => {
                const blockers = evaluatePackage(link.softwarePackage);
                return (
                  <li key={link.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">
                        {link.softwarePackage.name}
                        {link.softwarePackage.version ? ` ${link.softwarePackage.version}` : ""}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {link.softwarePackage.platform.toLowerCase()} · {link.softwarePackage.source.toLowerCase()} ·{" "}
                        {link.softwarePackage.licenseType.toLowerCase()}
                        {blockers.length > 0 ? ` · ${blockers[0].message}` : ""}
                      </p>
                    </div>
                    <form action={detachSoftware}>
                      <input type="hidden" name="scenarioId" value={scenario.id} />
                      <input type="hidden" name="softwarePackageId" value={link.softwarePackageId} />
                      <Button type="submit" variant="secondary" size="sm">
                        {t("scenarios.detail.detach")}
                      </Button>
                    </form>
                  </li>
                );
              })}
            </ul>
            <p className="border-t border-line px-5 py-3 text-xs text-ink-faint">
              {t("scenarios.detail.requirementsHint")}{" "}
              <Link href="/admin/software" className="font-semibold text-brand hover:underline">
                {t("scenarios.detail.manageInventory")} →
              </Link>
            </p>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
