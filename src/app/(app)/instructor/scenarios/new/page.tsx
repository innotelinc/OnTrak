import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { evaluatePackage } from "@/lib/availability";
import { blankDefinition, serializeDefinition, TEMPLATES, TEMPLATE_CHOICES } from "@/lib/templates";
import { ScenarioEditor } from "@/components/instructor/ScenarioEditor";
import { PageHeader } from "@/components/PageHeader";
import { ButtonLink, Card } from "@/components/ui";
import { currentLocale, getTranslator } from "@/lib/i18n-server";
import { LocaleProvider } from "@/lib/i18n-client";
import type { Platform } from "@/lib/sim/types";

export const metadata: Metadata = { title: "New scenario" };


export default async function NewScenarioPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; blank?: string }>;
}) {
  const { template, blank } = await searchParams;
  await requireSession();
  const t = await getTranslator();
  const locale = await currentLocale();

  const software = await prisma.softwarePackage.findMany({ orderBy: [{ platform: "asc" }, { name: "asc" }] });
  const softwareOptions = software.map((pkg) => ({
    id: pkg.id,
    name: pkg.name,
    platform: pkg.platform,
    enabled: pkg.enabled,
    ready: evaluatePackage(pkg).length === 0,
  }));

  const requested = (template ?? "").toUpperCase();
  const choice = TEMPLATE_CHOICES.find((entry) => entry.key === requested);
  const wantsEditor = Boolean(choice) || blank !== undefined;
  const platform: Platform = choice?.platform ?? "LINUX";
  const definition =
    blank !== undefined && !choice ? blankDefinition(platform) : (choice?.definition ?? TEMPLATES.LINUX);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow={t("scenarios.eyebrow")}
        title={wantsEditor ? t("scenarios.new.title") : t("scenarios.new.templateTitle")}
        description={
          wantsEditor ? t("scenarios.new.description") : t("scenarios.new.templateDescription")
        }
        actions={
          <ButtonLink href="/instructor/scenarios" variant="secondary">
            {t("scenarios.back")}
          </ButtonLink>
        }
      />

      {wantsEditor ? (
        <div className="mt-6">
          <LocaleProvider locale={locale}>
          <ScenarioEditor
            scenarioId={null}
            initial={{
              title: definition.objective,
              slug: "",
              summary: definition.objective,
              difficulty: "INTERMEDIATE",
              timeLimitSec: 1800,
              passScore: 70,
              published: false,
              tags: "",
              definition: serializeDefinition(definition),
            }}
            softwareOptions={softwareOptions}
            selectedSoftwareIds={[]}
          />
          </LocaleProvider>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {TEMPLATE_CHOICES.map((entry) => (
            <Card key={entry.key} className="flex flex-col">
              <h2 className="font-display text-lg font-semibold text-ink">{entry.title}</h2>
              <p className="mt-2 flex-1 text-sm text-ink-soft">{entry.blurb}</p>
              <ul className="mt-4 space-y-1 text-xs text-ink-faint">
                <li>{t("scenarios.new.checks", { count: entry.definition.checks.length })}</li>
                <li>{t("scenarios.new.tasks", { count: entry.definition.tasks.length })}</li>
                <li>
                  {t("scenarios.new.points", {
                    points: Math.round(entry.definition.checks.reduce((sum, c) => sum + (c.points ?? 1), 0)),
                  })}
                </li>
                {entry.definition.surface === "desktop" ? <li>{t("scenarios.new.desktop")}</li> : null}
              </ul>
              <div className="mt-5 flex flex-wrap gap-2">
                <ButtonLink href={`/instructor/scenarios/new?template=${entry.key}`} size="sm">
                  {t("scenarios.new.use")}
                </ButtonLink>
                <ButtonLink
                  href={`/instructor/scenarios/new?blank=1&template=${entry.key}`}
                  variant="secondary"
                  size="sm"
                >
                  {t("scenarios.new.blank")}
                </ButtonLink>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
