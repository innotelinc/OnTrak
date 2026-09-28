import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { evaluateScenario, loadAvailabilityContext, platformLabel } from "@/lib/availability";
import { deleteScenario, duplicateScenario, setScenarioPublished } from "@/app/actions/instructor";
import { toDefinition } from "@/lib/scenarios";
import { totalPoints } from "@/lib/sim/grade";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, ButtonLink, Card, EmptyState } from "@/components/ui";
import { formatDuration, formatRelative } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Scenarios" };

export default async function ScenariosPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  const t = await getTranslator();

  const [context, scenarios] = await Promise.all([
    loadAvailabilityContext(),
    prisma.scenario.findMany({
      include: {
        software: { include: { softwarePackage: true } },
        author: { select: { name: true } },
        _count: { select: { attempts: true, assignments: true } },
      },
      orderBy: [{ updatedAt: "desc" }],
    }),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("scenarios.eyebrow")}
        title={t("scenarios.title")}
        description={t("scenarios.description")}
        actions={<ButtonLink href="/instructor/scenarios/new">{t("scenarios.new")}</ButtonLink>}
      />
      <Flash flash={flash} error={error} />

      {scenarios.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title={t("scenarios.empty.title")}
            description={t("scenarios.empty.description")}
            action={<ButtonLink href="/instructor/scenarios/new">{t("scenarios.empty.action")}</ButtonLink>}
          />
        </div>
      ) : (
        <ul className="mt-6 space-y-4">
          {scenarios.map((scenario) => {
            const availability = evaluateScenario(scenario, context);
            const definition = toDefinition(scenario);
            const points = totalPoints(definition);

            return (
              <li key={scenario.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={scenario.platform === "LINUX" ? "amber" : scenario.platform === "WINDOWS" ? "sky" : "pink"}>
                          {platformLabel(scenario.platform)}
                        </Badge>
                        <Badge tone="neutral">{scenario.difficulty.toLowerCase()}</Badge>
                        <Badge tone={scenario.published ? "teal" : "neutral"}>
                          {scenario.published ? t("instructor.badge.published") : t("instructor.badge.draft")}
                        </Badge>
                        {availability.available ? (
                          <Badge tone="teal">{t("instructor.badge.runnable")}</Badge>
                        ) : (
                          <Badge tone="danger">{t("scenarios.badge.blocked")}</Badge>
                        )}
                        <Badge tone="neutral">{formatDuration(scenario.timeLimitSec)}</Badge>
                        <Badge tone="neutral">
                          {t("scenarios.badge.pointsChecks", {
                            points,
                            plural: points === 1 ? "" : "s",
                            checks: definition.checks.length,
                          })}
                        </Badge>
                      </div>

                      <Link
                        href={`/instructor/scenarios/${scenario.id}`}
                        className="mt-3 block font-display text-lg font-semibold text-ink hover:text-brand"
                      >
                        {scenario.title}
                      </Link>
                      <p className="mt-1 max-w-3xl text-sm text-ink-soft">{scenario.summary}</p>

                      <p className="mt-2 text-xs text-ink-faint">
                        {t("scenarios.meta", {
                          author: scenario.author.name,
                          updated: formatRelative(scenario.updatedAt),
                        })}{" "}
                        ·{" "}
                        {t("scenarios.counts", {
                          attempts: scenario._count.attempts,
                          assignments: scenario._count.assignments,
                        })}
                      </p>

                      {!availability.available ? (
                        <ul className="mt-3 space-y-1.5">
                          {availability.blockers.map((blocker, index) => (
                            <li key={index} className="flex items-start gap-2 text-xs text-pink">
                              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-pink" />
                              {blocker.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {scenario.software.length > 0 ? (
                        <ul className="mt-3 flex flex-wrap gap-1.5">
                          {scenario.software.map((link) => (
                            <li
                              key={link.id}
                              className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-medium text-ink-soft"
                            >
                              {link.softwarePackage.name}
                              {link.softwarePackage.version ? ` ${link.softwarePackage.version}` : ""}
                              {link.softwarePackage.enabled ? "" : t("scenarios.softwareDisabled")}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-[11px] text-ink-faint">{t("scenarios.noSoftware")}</p>
                      )}
                    </div>

                    <div className="flex flex-col items-stretch gap-2 sm:items-end">
                      <form action={setScenarioPublished}>
                        <input type="hidden" name="id" value={scenario.id} />
                        <input type="hidden" name="published" value={(!scenario.published).toString()} />
                        <Button type="submit" variant={scenario.published ? "secondary" : "success"} size="sm" className="w-full">
                          {scenario.published ? t("scenarios.unpublish") : t("scenarios.publish")}
                        </Button>
                      </form>
                      <form action={duplicateScenario}>
                        <input type="hidden" name="id" value={scenario.id} />
                        <Button type="submit" variant="secondary" size="sm" className="w-full">
                          {t("scenarios.duplicate")}
                        </Button>
                      </form>
                      <form action={deleteScenario}>
                        <input type="hidden" name="id" value={scenario.id} />
                        <Button type="submit" variant="danger" size="sm" className="w-full">
                          {t("scenarios.delete")}
                        </Button>
                      </form>
                      <ButtonLink href={`/instructor/scenarios/${scenario.id}`} size="sm" className="w-full">
                        {t("scenarios.edit")}
                      </ButtonLink>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {user.role === "INSTRUCTOR" ? (
        <p className="mt-6 text-xs text-ink-faint">{t("scenarios.instructorNote")}</p>
      ) : null}
    </div>
  );
}
