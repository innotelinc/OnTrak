import Link from "next/link";
import type { Metadata } from "next";
import type { Platform } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { evaluateScenario, inventoryHealth, loadAvailabilityContext, platformLabel } from "@/lib/availability";
import { togglePlatform } from "@/app/actions/admin";
import { recentAudit } from "@/lib/audit";
import { integrationStatuses } from "@/lib/integration-status";
import { capabilities } from "@/lib/capabilities";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, ButtonLink, buttonClass, Card, Stat } from "@/components/ui";
import { cn, formatBytes } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";
import { maskKey } from "@/lib/storage";

export const metadata: Metadata = { title: "Control room" };

const PLATFORM_BLURB: Record<Platform, string> = {
  LINUX: "admin.platform.linux",
  WINDOWS: "admin.platform.windows",
  OFFICE: "admin.platform.office",
};

const PLATFORM_ACCENT: Record<Platform, string> = {
  LINUX: "from-amber/25 to-amber/5 text-amber",
  WINDOWS: "from-sky/25 to-sky/5 text-sky",
  OFFICE: "from-pink/25 to-pink/5 text-pink",
};

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const admin = await requireSession();
  const t = await getTranslator();

  const [toggles, context, health, scenarios, users, attempts, audit] = await Promise.all([
    prisma.platformToggle.findMany(),
    loadAvailabilityContext(),
    inventoryHealth(),
    prisma.scenario.findMany({
      include: { software: { include: { softwarePackage: true } } },
    }),
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    prisma.attempt.count(),
    recentAudit(8),
  ]);

  const platforms: Platform[] = ["LINUX", "WINDOWS", "OFFICE"];
  const integrations = integrationStatuses();
  const familyCapabilities = capabilities();
  const toggleFor = (platform: Platform) => toggles.find((toggle) => toggle.platform === platform);
  const availability = scenarios.map((scenario) => evaluateScenario(scenario, context));
  const runnable = availability.filter((entry) => entry.available).length;
  const blocked = availability.length - runnable;
  const totalUsers = users.reduce((sum, group) => sum + group._count._all, 0);
  const brokenPackages = health.filter((entry) => entry.blockers.length > 0);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("admin.eyebrow")}
        title={t("admin.title")}
        description={t("admin.description")}
        actions={<ButtonLink href="/admin/software">{t("nav.software")}</ButtonLink>}
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t("admin.stat.runnable")}
          value={runnable}
          hint={t("admin.stat.blockedHint", { count: blocked })}
          tone={blocked === 0 ? "teal" : "amber"}
        />
        <Stat
          label={t("admin.stat.packages")}
          value={health.length}
          hint={t("admin.stat.attentionHint", { count: brokenPackages.length })}
          tone="brand"
        />
        <Stat label={t("admin.stat.accounts")} value={totalUsers} hint={t("admin.stat.accountsHint")} tone="sky" />
        <Stat label={t("admin.stat.attempts")} value={attempts} hint={t("admin.stat.attemptsHint")} tone="pink" />
      </div>

      {/* ------------------------------------------------------ platform switches */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-semibold text-ink">{t("admin.platformSwitches")}</h2>
        <p className="text-sm text-ink-soft">{t("admin.platformSwitchesHint")}</p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {platforms.map((platform) => {
            const toggle = toggleFor(platform);
            const enabled = toggle?.enabled ?? true;
            const count = scenarios.filter((scenario) => scenario.platform === platform).length;
            return (
              <Card key={platform} className="relative overflow-hidden">
                <span
                  className={cn("absolute -top-12 -right-10 size-32 rounded-full bg-gradient-to-br opacity-70", PLATFORM_ACCENT[platform])}
                  aria-hidden
                />
                <div className="relative">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-display text-lg font-semibold text-ink">{platformLabel(platform)}</h3>
                    <Badge tone={enabled ? "teal" : "danger"}>
                      {enabled ? t("admin.badge.enabled") : t("admin.badge.disabled")}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">{t(PLATFORM_BLURB[platform])}</p>
                  <p className="mt-2 text-xs text-ink-faint">{t("admin.platformCount", { count })}</p>

                  <form action={togglePlatform} className="mt-4 space-y-3">
                    <input type="hidden" name="platform" value={platform} />
                    <input type="hidden" name="enabled" value={(!enabled).toString()} />
                    <input
                      name="note"
                      defaultValue={toggle?.note ?? ""}
                      placeholder={t("admin.reasonPlaceholder")}
                      className="w-full rounded-xl2 border border-line bg-surface px-3 py-2 text-xs text-ink placeholder:text-ink-faint"
                    />
                    <Button type="submit" variant={enabled ? "danger" : "success"} size="sm" className="w-full">
                      {enabled
                        ? t("admin.disable", { platform: platformLabel(platform) })
                        : t("admin.enable", { platform: platformLabel(platform) })}
                    </Button>
                  </form>

                  {toggle?.note ? (
                    <p className="mt-2 text-[11px] text-ink-faint">{t("admin.note", { note: toggle.note })}</p>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------ integrations */}
      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-ink">{t("admin.integrations")}</h2>
        <p className="text-sm text-ink-soft">{t("admin.integrationsHint")}</p>

        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {integrations.map((integration) => (
            <Card key={integration.id}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-base font-semibold text-ink">
                  {t(`admin.integration.${integration.id}`)}
                </h3>
                <Badge
                  tone={integration.state === "ready" ? "teal" : integration.state === "incomplete" ? "danger" : "neutral"}
                >
                  {t(`admin.integration.state.${integration.state}`)}
                </Badge>
              </div>

              {integration.state === "off" ? (
                <p className="mt-2 text-xs text-ink-soft">{t(`admin.integration.off.${integration.id}`)}</p>
              ) : null}

              {integration.details.length > 0 ? (
                <dl className="mt-3 space-y-1.5 border-t border-line pt-3">
                  {integration.details.map((detail) => (
                    <div key={detail.key} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <dt className="text-xs text-ink-faint">{t(`admin.integration.${detail.key}`)}</dt>
                      <dd className="font-mono text-xs text-ink-soft">
                        {detail.value || t("admin.integration.notSet")}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {integration.issues.length > 0 ? (
                <div className="mt-3 border-t border-line pt-3">
                  <p className="text-xs text-pink">{t("admin.integration.incompleteHint")}</p>
                  <ul className="mt-1.5 space-y-1">
                    {integration.issues.map((issue, index) => (
                      <li key={index} className="font-mono text-[11px] text-pink">
                        {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ capabilities */}
      <section className="mt-10">
        <h2 className="font-display text-lg font-semibold text-ink">{t("admin.capabilities")}</h2>
        <p className="text-sm text-ink-soft">{t("admin.capabilitiesHint")}</p>

        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {familyCapabilities.map((entry) => (
            <Card key={entry.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-base font-semibold text-ink">
                  {t(`admin.capability.${entry.id}.name`)}
                </h3>
                {/* `off` is a state of its own: a product this deployment does not run
                    is a normal thing to see, not the red of one that was refused. */}
                <Badge
                  tone={entry.off ? "neutral" : entry.url === null ? "danger" : entry.named ? "teal" : "neutral"}
                >
                  {t(
                    entry.off
                      ? "admin.capability.state.off"
                      : entry.url === null
                        ? "admin.capability.state.unreachable"
                        : entry.named
                          ? "admin.capability.state.named"
                          : "admin.capability.state.family",
                  )}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-ink-soft">{t(`admin.capability.${entry.id}.tagline`)}</p>
              {entry.url ? (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonClass("secondary", "sm"), "mt-3")}
                >
                  {t("admin.capability.open")}
                </a>
              ) : (
                <p className="mt-3 font-mono text-[11px] text-pink">
                  {entry.note ?? t("admin.capability.state.unreachable")}
                </p>
              )}
              {entry.url ? (
                <p className="mt-2 font-mono text-[11px] break-all text-ink-faint">{entry.url}</p>
              ) : null}
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------ provisioning */}
      <section className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div>
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-ink">{t("admin.inventoryHealth")}</h2>
              <p className="text-sm text-ink-soft">{t("admin.inventoryHealthHint")}</p>
            </div>
            <Link href="/admin/software" className="text-sm font-semibold text-brand hover:underline">
              {t("admin.manage")} →
            </Link>
          </div>

          {health.length === 0 ? (
            <Card className="mt-3 p-5 text-sm text-ink-soft">{t("admin.emptyInventory")}</Card>
          ) : (
            <Card className="mt-3 overflow-hidden p-0">
              <ul className="divide-y divide-line">
                {health.slice(0, 8).map(({ pkg, blockers, usedBy }) => (
                  <li key={pkg.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">
                          {pkg.name}
                          {pkg.version ? ` ${pkg.version}` : ""}
                        </span>
                        <Badge tone={pkg.platform === "LINUX" ? "amber" : pkg.platform === "WINDOWS" ? "sky" : "pink"}>
                          {platformLabel(pkg.platform)}
                        </Badge>
                        <Badge tone={pkg.enabled ? "teal" : "neutral"}>{pkg.enabled ? "enabled" : "disabled"}</Badge>
                        <Badge tone={pkg.licenseType === "LICENSED" ? "amber" : "neutral"}>
                          {pkg.licenseType.toLowerCase().replace("_", " ")}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-ink-faint">
                        {pkg.source.toLowerCase()} ·{" "}
                        {pkg.sizeBytes ? formatBytes(Number(pkg.sizeBytes)) : t("admin.noPayload")} ·{" "}
                        {t("admin.usedBy", { count: usedBy })}
                        {pkg.licenseType === "LICENSED" ? ` · ${t("admin.licenseKey", { key: maskKey(pkg.licenseKey) })}` : ""}
                      </p>
                      {blockers.length > 0 ? (
                        <ul className="mt-1.5 space-y-1">
                          {blockers.map((blocker, index) => (
                            <li key={index} className="text-xs text-pink">
                              {blocker.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <Link href="/admin/software" className="text-xs font-semibold text-brand hover:underline">
                      {t("admin.fix")}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">{t("admin.recentActivity")}</h2>
            {audit.length === 0 ? (
              <Card className="mt-3 p-5 text-sm text-ink-soft">{t("admin.nothingRecorded")}</Card>
            ) : (
              <Card className="mt-3 overflow-hidden p-0">
                <ul className="divide-y divide-line">
                  {audit.map((entry) => (
                    <li key={entry.id} className="px-4 py-3">
                      <p className="text-xs font-semibold text-ink">{entry.action}</p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {entry.actor?.name ?? "system"} · {entry.targetType}
                        {entry.targetId ? ` · ${entry.targetId.slice(0, 12)}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <Link href="/admin/audit" className="mt-2 inline-block text-sm font-semibold text-brand hover:underline">
              {t("admin.fullAudit")} →
            </Link>
          </div>

          <Card>
            <h2 className="font-display text-base font-semibold text-ink">
              {t("admin.signedInAs", { name: admin.name })}
            </h2>
            <p className="mt-2 text-sm text-ink-soft">{t("admin.signedInAsHint")}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <ButtonLink href="/admin/users" variant="secondary" size="sm">
                {t("admin.people")}
              </ButtonLink>
              <ButtonLink href="/instructor/scenarios" variant="secondary" size="sm">
                {t("admin.scenarios")}
              </ButtonLink>
              <ButtonLink href="/student" variant="secondary" size="sm">
                {t("admin.practice")}
              </ButtonLink>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
