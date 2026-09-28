import type { Metadata } from "next";
import type { Platform, SoftwarePackage } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { inventoryHealth, platformLabel } from "@/lib/availability";
import { createSoftware, deleteSoftware, downloadSoftware, setLicenseKey, setSoftwareEnabled, updateSoftware } from "@/app/actions/admin";
import { maskKey, maxUploadBytes } from "@/lib/storage";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, Toggle } from "@/components/ui";
import { cn, formatBytes, formatRelative } from "@/lib/cn";
import { getTranslator, type Translator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Software & OS" };

const PLATFORMS: Platform[] = ["LINUX", "WINDOWS", "OFFICE"];

export default async function SoftwarePage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  await requireSession();
  const t = await getTranslator();

  const health = await inventoryHealth();
  const grouped = PLATFORMS.map((platform) => ({
    platform,
    items: health.filter((entry) => entry.pkg.platform === platform),
  }));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow={t("software.eyebrow")} title={t("software.title")} description={t("software.description")} />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* ------------------------------------------------------------ list */}
        <div className="space-y-6">
          {health.length === 0 ? (
            <EmptyState title={t("software.empty.title")} description={t("software.empty.description")} />
          ) : (
            grouped.map(({ platform, items }) =>
              items.length === 0 ? null : (
                <section key={platform}>
                  <div className="flex items-center gap-3">
                    <h2 className="font-display text-lg font-semibold text-ink">{platformLabel(platform)}</h2>
                    <Badge
                      tone={platform === "LINUX" ? "amber" : platform === "WINDOWS" ? "sky" : "pink"}
                    >
                      {t("software.packages", { count: items.length })}
                    </Badge>
                  </div>

                  <ul className="mt-3 space-y-3">
                    {items.map(({ pkg, blockers, usedBy }) => (
                      <li key={pkg.id}>
                        <PackageCard pkg={pkg} blockers={blockers.map((blocker) => blocker.message)} usedBy={usedBy} t={t} />
                      </li>
                    ))}
                  </ul>
                </section>
              ),
            )
          )}
        </div>

        {/* ------------------------------------------------------------- add */}
        <Card className="h-fit lg:sticky lg:top-24">
          <h2 className="font-display text-base font-semibold text-ink">{t("software.addSoftware")}</h2>
          <p className="mt-1 text-xs text-ink-soft">
            {t("software.addSoftwareHint", { size: formatBytes(maxUploadBytes()) })}
          </p>

          <form action={createSoftware} className="mt-4 space-y-3.5">
            <Field label={t("software.name")} htmlFor="name">
              <Input id="name" name="name" placeholder="postfix" required />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("software.vendor")} htmlFor="vendor">
                <Input id="vendor" name="vendor" placeholder="Ubuntu" />
              </Field>
              <Field label={t("software.version")} htmlFor="version">
                <Input id="version" name="version" placeholder="3.8.6" />
              </Field>
            </div>

            <Field label={t("software.platform")} htmlFor="platform">
              <Select id="platform" name="platform" defaultValue="LINUX">
                {PLATFORMS.map((platform) => (
                  <option key={platform} value={platform}>
                    {platformLabel(platform)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t("software.flavour")} htmlFor="flavour" hint={t("software.optional")}>
              <Input id="flavour" name="flavour" placeholder="ubuntu-24.04 or win11-23h2" />
            </Field>

            <Field label={t("software.source")} htmlFor="source" hint={t("software.sourceHint")}>
              <Select id="source" name="source" defaultValue="INTERNAL">
                <option value="INTERNAL">{t("software.source.internal")}</option>
                <option value="UPLOAD">{t("software.source.upload")}</option>
                <option value="URL">{t("software.source.url")}</option>
              </Select>
            </Field>

            <Field label={t("software.downloadUrl")} htmlFor="sourceUrl" hint={t("software.downloadUrlHint")}>
              <Input id="sourceUrl" name="sourceUrl" type="url" placeholder="https://vendor.example/pkg.msi" />
            </Field>

            <Field label={t("software.installerFile")} htmlFor="file" hint={t("software.installerHint")}>
              <input
                id="file"
                name="file"
                type="file"
                className="w-full rounded-xl2 border border-dashed border-line bg-surface px-3 py-2.5 text-xs text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand"
              />
            </Field>

            <Field label={t("software.licenseType")} htmlFor="licenseType" hint={t("software.licenseTypeHint")}>
              <Select id="licenseType" name="licenseType" defaultValue="OPEN">
                <option value="OPEN">{t("software.license.open")}</option>
                <option value="EVALUATION">{t("software.license.evaluation")}</option>
                <option value="LICENSED">{t("software.license.licensed")}</option>
              </Select>
            </Field>

            <Field label={t("software.activationKey")} htmlFor="licenseKey" hint={t("software.keyHint")}>
              <Input id="licenseKey" name="licenseKey" placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={t("software.seats")} htmlFor="licenseSeats">
                <Input id="licenseSeats" name="licenseSeats" type="number" min={0} placeholder="25" />
              </Field>
              <Field label={t("software.expires")} htmlFor="licenseExpiresAt">
                <Input id="licenseExpiresAt" name="licenseExpiresAt" type="date" />
              </Field>
            </div>

            <Field label={t("software.descriptionLabel")} htmlFor="description">
              <Textarea id="description" name="description" className="min-h-16" placeholder={t("software.descriptionPlaceholder")} />
            </Field>

            <input type="hidden" name="enabled" value="on" />

            <Button type="submit" className="w-full">
              {t("software.addToInventory")}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function PackageCard({
  pkg,
  blockers,
  usedBy,
  t,
}: {
  pkg: SoftwarePackage;
  blockers: string[];
  usedBy: number;
  t: Translator;
}) {
  const ready = blockers.length === 0;
  const keyMasked = maskKey(pkg.licenseKey);

  return (
    <Card className={cn("p-0", !ready && "border-amber/35")}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-ink">
              {pkg.name}
              {pkg.version ? <span className="ml-1.5 font-mono text-xs text-ink-faint">{pkg.version}</span> : null}
            </h3>
            <Badge tone={pkg.enabled ? "teal" : "neutral"}>
              {pkg.enabled ? t("software.badge.enabled") : t("software.badge.disabled")}
            </Badge>
            <Badge tone={pkg.licenseType === "LICENSED" ? "amber" : "sky"}>
              {pkg.licenseType === "EVALUATION" ? t("software.badge.evaluation") : pkg.licenseType.toLowerCase()}
            </Badge>
            {ready ? (
              <Badge tone="teal">{t("software.badge.ready")}</Badge>
            ) : (
              <Badge tone="danger">{t("software.badge.issues", { count: blockers.length })}</Badge>
            )}
          </div>

          <p className="mt-2 text-xs text-ink-faint">
            {pkg.vendor ? `${pkg.vendor} · ` : ""}
            {pkg.source.toLowerCase()}
            {pkg.sourceUrl ? ` (${pkg.sourceUrl})` : ""}
            {pkg.uploadName ? ` · ${pkg.uploadName}` : ""}
            {pkg.sizeBytes ? ` · ${formatBytes(Number(pkg.sizeBytes))}` : ""}
            {pkg.licenseType === "LICENSED" ? t("software.keyShort", { key: keyMasked }) : ""}
            {pkg.licenseSeats ? t("software.seatCount", { count: pkg.licenseSeats }) : ""}
            {pkg.licenseExpiresAt
              ? t("software.expiresOn", { date: pkg.licenseExpiresAt.toISOString().slice(0, 10) })
              : ""}
          </p>
          <p className="mt-1 text-[11px] text-ink-faint">
            {t("software.usedBy", { count: usedBy, when: formatRelative(pkg.createdAt) })}
          </p>

          {blockers.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {blockers.map((message, index) => (
                <li key={index} className="text-xs text-pink">
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={setSoftwareEnabled}>
            <input type="hidden" name="id" value={pkg.id} />
            <input type="hidden" name="enabled" value={(!pkg.enabled).toString()} />
            <Button type="submit" variant={pkg.enabled ? "secondary" : "success"} size="sm">
              {pkg.enabled ? t("software.disable") : t("software.enable")}
            </Button>
          </form>
          {pkg.source === "URL" ? (
            <form action={downloadSoftware}>
              <input type="hidden" name="id" value={pkg.id} />
              <Button type="submit" variant="secondary" size="sm">
                {t("software.downloadNow")}
              </Button>
            </form>
          ) : null}
          <form action={deleteSoftware}>
            <input type="hidden" name="id" value={pkg.id} />
            <Button type="submit" variant="danger" size="sm">
              {t("software.delete")}
            </Button>
          </form>
        </div>
      </div>

      {/* Key + edit, collapsed by default so the list stays scannable */}
      <details className="border-t border-line">
        <summary className="cursor-pointer px-5 py-3 text-xs font-semibold text-ink-soft transition hover:text-brand">
          {t("software.keyAndDetails")}
        </summary>
        <div className="space-y-5 px-5 pb-5">
          <form action={setLicenseKey} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={pkg.id} />
            <Field label={t("software.storeKey")} htmlFor={`key-${pkg.id}`} className="min-w-56 flex-1">
              <Input
                id={`key-${pkg.id}`}
                name="licenseKey"
                placeholder={pkg.licenseKey ? keyMasked : "XXXX-XXXX-XXXX-XXXX"}
                autoComplete="off"
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm">
              {t("software.saveKey")}
            </Button>
            <p className="basis-full text-xs text-ink-faint">{t("software.storeKeyHint")}</p>
          </form>

          <form action={updateSoftware} className="space-y-3 border-t border-line pt-5">
            <input type="hidden" name="id" value={pkg.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("software.name")} htmlFor={`n-${pkg.id}`}>
                <Input id={`n-${pkg.id}`} name="name" defaultValue={pkg.name} />
              </Field>
              <Field label={t("software.version")} htmlFor={`v-${pkg.id}`}>
                <Input id={`v-${pkg.id}`} name="version" defaultValue={pkg.version ?? ""} />
              </Field>
              <Field label={t("software.vendor")} htmlFor={`vd-${pkg.id}`}>
                <Input id={`vd-${pkg.id}`} name="vendor" defaultValue={pkg.vendor ?? ""} />
              </Field>
              <Field label={t("software.flavour")} htmlFor={`f-${pkg.id}`}>
                <Input id={`f-${pkg.id}`} name="flavour" defaultValue={pkg.flavour ?? ""} />
              </Field>
              <Field label={t("software.platform")} htmlFor={`p-${pkg.id}`}>
                <Select id={`p-${pkg.id}`} name="platform" defaultValue={pkg.platform}>
                  {PLATFORMS.map((platform) => (
                    <option key={platform} value={platform}>
                      {platformLabel(platform)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("software.source")} htmlFor={`s-${pkg.id}`}>
                <Select id={`s-${pkg.id}`} name="source" defaultValue={pkg.source}>
                  <option value="INTERNAL">{t("software.shortInternal")}</option>
                  <option value="UPLOAD">{t("software.shortUpload")}</option>
                  <option value="URL">URL</option>
                </Select>
              </Field>
              <Field label={t("software.downloadUrl")} htmlFor={`u-${pkg.id}`}>
                <Input id={`u-${pkg.id}`} name="sourceUrl" defaultValue={pkg.sourceUrl ?? ""} />
              </Field>
              <Field
                label={t("software.installerFile")}
                htmlFor={`file-${pkg.id}`}
                hint={t("software.installerHint")}
              >
                <input
                  id={`file-${pkg.id}`}
                  name="file"
                  type="file"
                  className="w-full rounded-xl2 border border-dashed border-line bg-surface px-3 py-2.5 text-xs text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-brand-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand"
                />
              </Field>
              <Field label={t("software.licenseType")} htmlFor={`l-${pkg.id}`}>
                <Select id={`l-${pkg.id}`} name="licenseType" defaultValue={pkg.licenseType}>
                  <option value="OPEN">Open</option>
                  <option value="EVALUATION">Evaluation</option>
                  <option value="LICENSED">Licensed</option>
                </Select>
              </Field>
              <Field label={t("software.seats")} htmlFor={`se-${pkg.id}`}>
                <Input id={`se-${pkg.id}`} name="licenseSeats" type="number" min={0} defaultValue={pkg.licenseSeats ?? ""} />
              </Field>
              <Field label={t("software.expires")} htmlFor={`ex-${pkg.id}`}>
                <Input
                  id={`ex-${pkg.id}`}
                  name="licenseExpiresAt"
                  type="date"
                  defaultValue={pkg.licenseExpiresAt ? pkg.licenseExpiresAt.toISOString().slice(0, 10) : ""}
                />
              </Field>
            </div>

            <Field label={t("software.descriptionLabel")} htmlFor={`d-${pkg.id}`}>
              <Textarea id={`d-${pkg.id}`} name="description" defaultValue={pkg.description ?? ""} className="min-h-16" />
            </Field>

            <Field label={t("software.activationKey")} htmlFor={`k-${pkg.id}`} hint={t("software.keyKeepMasked")}>
              <Input id={`k-${pkg.id}`} name="licenseKey" defaultValue={keyMasked} autoComplete="off" />
            </Field>

            <Toggle
              name="enabled"
              defaultChecked={pkg.enabled}
              label={t("software.enabledForStudents")}
              description={t("software.enabledForStudentsHint")}
            />

            <Button type="submit" size="sm">
              {t("software.saveChanges")}
            </Button>
          </form>
        </div>
      </details>
    </Card>
  );
}
