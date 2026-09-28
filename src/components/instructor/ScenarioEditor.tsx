"use client";

import { useMemo, useState } from "react";
import { saveScenario } from "@/app/actions/instructor";
import { CHECK_KINDS, validateDefinition } from "@/lib/validate";
import { TEMPLATES, serializeDefinition } from "@/lib/templates";
import { Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useTranslator } from "@/lib/i18n-client";
import type { Platform } from "@/lib/sim/types";

export interface ScenarioEditorProps {
  /** `null` when creating a new scenario. */
  scenarioId: string | null;
  initial: {
    title: string;
    slug: string;
    summary: string;
    difficulty: string;
    timeLimitSec: number;
    passScore: number;
    published: boolean;
    tags: string;
    definition: string;
  };
  softwareOptions: { id: string; name: string; platform: string; enabled: boolean; ready: boolean }[];
  selectedSoftwareIds: string[];
}

const CHECK_REFERENCE: { kind: string; hintKey: string }[] = [
  { kind: "file_exists / file_absent", hintKey: "editor.ref.path" },
  { kind: "file_contains", hintKey: "editor.ref.contains" },
  { kind: "file_not_contains", hintKey: "editor.ref.notContains" },
  { kind: "file_mode / file_owner", hintKey: "editor.ref.modeOwner" },
  { kind: "command_matched", hintKey: "editor.ref.command" },
  { kind: "command_sequence", hintKey: "editor.ref.sequence" },
  { kind: "service_state", hintKey: "editor.ref.service" },
  { kind: "user_exists / user_in_group", hintKey: "editor.ref.user" },
  { kind: "package_state", hintKey: "editor.ref.package" },
  { kind: "cron_matches", hintKey: "editor.ref.cron" },
  { kind: "firewall_rule", hintKey: "editor.ref.firewall" },
  { kind: "registry_value", hintKey: "editor.ref.registry" },
  { kind: "cell_equals / cell_style", hintKey: "editor.ref.cell" },
  { kind: "mail_sent / mail_flagged", hintKey: "editor.ref.mail" },
  { kind: "note_matches", hintKey: "editor.ref.note" },
];

export function ScenarioEditor({
  scenarioId,
  initial,
  softwareOptions,
  selectedSoftwareIds,
}: ScenarioEditorProps) {
  const t = useTranslator();
  const [definitionText, setDefinitionText] = useState(initial.definition);
  const [selected, setSelected] = useState<string[]>(selectedSoftwareIds);
  const [referenceOpen, setReferenceOpen] = useState(false);

  /** Has the author touched the JSON since the page opened? */
  const dirty = definitionText !== initial.definition;

  /**
   * Validation runs in the browser, so the author gets feedback as they type.
   * It is the exact function the server uses before saving, which means what
   * you see here is what you get.
   */
  const validation = useMemo(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(definitionText);
    } catch (error) {
      return { parseError: (error as Error).message, result: null as ReturnType<typeof validateDefinition> | null };
    }
    return { parseError: null, result: validateDefinition(parsed) };
  }, [definitionText]);

  const result = validation.result;
  const errors = result?.issues.filter((issue) => issue.level === "error") ?? [];
  const warnings = result?.issues.filter((issue) => issue.level === "warning") ?? [];

  function loadTemplate(which: Platform) {
    // Loading a starter replaces the whole definition, so make sure the author
    // has not just lost edits they spent time on.
    if (dirty && !window.confirm(t("editor.confirmReplace"))) {
      return;
    }
    setDefinitionText(serializeDefinition(TEMPLATES[which]));
  }

  function formatJson() {
    try {
      setDefinitionText(JSON.stringify(JSON.parse(definitionText), null, 2));
    } catch {
      /* the validation panel already explains the parse failure */
    }
  }

  const toggleSoftware = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  };

  return (
    <form action={saveScenario} className="space-y-6">
      {scenarioId ? <input type="hidden" name="id" value={scenarioId} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/* ---------------------------------------------------------- left */}
        <div className="space-y-6">
          <Card>
            <h2 className="font-display text-lg font-semibold text-ink">{t("editor.catalogDetails")}</h2>
            <p className="mt-1 text-sm text-ink-soft">{t("editor.catalogHint")}</p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label={t("editor.title")} htmlFor="title" className="sm:col-span-2">
                <Input
                  id="title"
                  name="title"
                  defaultValue={initial.title}
                  placeholder={t("editor.titlePlaceholder")}
                  required
                />
              </Field>

              <Field label={t("editor.slug")} htmlFor="slug" hint={t("editor.slugHint")}>
                <Input id="slug" name="slug" defaultValue={initial.slug} placeholder={t("editor.slugPlaceholder")} />
              </Field>

              <Field label={t("editor.difficulty")} htmlFor="difficulty">
                <Select id="difficulty" name="difficulty" defaultValue={initial.difficulty}>
                  <option value="FOUNDATION">{t("editor.difficulty.foundation")}</option>
                  <option value="INTERMEDIATE">{t("editor.difficulty.intermediate")}</option>
                  <option value="ADVANCED">{t("editor.difficulty.advanced")}</option>
                  <option value="EXPERT">{t("editor.difficulty.expert")}</option>
                </Select>
              </Field>

              <Field label={t("editor.timeLimit")} htmlFor="timeLimitSec" hint={t("editor.seconds")}>
                <Input
                  id="timeLimitSec"
                  name="timeLimitSec"
                  type="number"
                  min={60}
                  max={28800}
                  step={30}
                  defaultValue={initial.timeLimitSec}
                />
              </Field>

              <Field label={t("editor.passMark")} htmlFor="passScore" hint={t("editor.percent")}>
                <Input id="passScore" name="passScore" type="number" min={0} max={100} defaultValue={initial.passScore} />
              </Field>

              <Field label={t("editor.summary")} htmlFor="summary" className="sm:col-span-2" hint={t("editor.summaryHint")}>
                <Input id="summary" name="summary" defaultValue={initial.summary} />
              </Field>

              <Field label={t("editor.tags")} htmlFor="tags" hint={t("editor.tagsHint")}>
                <Input id="tags" name="tags" defaultValue={initial.tags} placeholder={t("editor.tagsPlaceholder")} />
              </Field>

              <Field label={t("editor.visibility")} htmlFor="published">
                <label className="flex items-center gap-3 rounded-xl2 border border-line bg-surface px-3.5 py-2.5">
                  <input
                    id="published"
                    name="published"
                    type="checkbox"
                    defaultChecked={initial.published}
                    className="size-4 accent-[var(--brand)]"
                  />
                  <span className="text-sm text-ink">{t("editor.published")}</span>
                </label>
              </Field>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-ink">{t("editor.definition")}</h2>
                <p className="mt-1 text-sm text-ink-soft">{t("editor.definitionHint")}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["LINUX", "WINDOWS", "OFFICE"] as Platform[]).map((which) => (
                  <Button key={which} type="button" variant="secondary" size="sm" onClick={() => loadTemplate(which)}>
                    {t("editor.starter", {
                      platform: which === "LINUX" ? "Linux" : which === "WINDOWS" ? "Windows" : "Office",
                    })}
                  </Button>
                ))}
                <Button type="button" variant="ghost" size="sm" onClick={formatJson}>
                  {t("editor.tidyJson")}
                </Button>
              </div>
            </div>

            <textarea
              name="definition"
              value={definitionText}
              onChange={(event) => setDefinitionText(event.target.value)}
              spellCheck={false}
              className="mt-4 min-h-[32rem] w-full resize-y rounded-xl2 border border-line bg-[#141029] px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[#ded8ff] outline-none focus:border-brand/50"
            />
            <p className="mt-2 text-xs text-ink-faint">{t("editor.tip")}</p>
          </Card>
        </div>

        {/* --------------------------------------------------------- right */}
        <div className="space-y-6">
          <Card className={cn(errors.length > 0 ? "border-pink/35" : "border-teal/30")}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-base font-semibold text-ink">{t("editor.validation")}</h2>
              <Badge tone={validation.parseError || errors.length > 0 ? "danger" : "teal"}>
                {validation.parseError
                  ? t("editor.invalidJson")
                  : errors.length > 0
                    ? t("editor.errorCount", { count: errors.length })
                    : t("editor.readyToSave")}
              </Badge>
            </div>

            {validation.parseError ? (
              <p className="mt-3 rounded-xl2 border border-pink/30 bg-pink/10 px-3 py-2 text-sm text-ink-soft">
                {validation.parseError}
              </p>
            ) : null}

            {result ? (
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl2 bg-surface-muted px-2 py-2.5">
                  <dt className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                    {t("editor.stat.checks")}
                  </dt>
                  <dd className="font-display text-xl font-semibold text-ink">{result.definition?.checks.length ?? 0}</dd>
                </div>
                <div className="rounded-xl2 bg-surface-muted px-2 py-2.5">
                  <dt className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                    {t("editor.stat.points")}
                  </dt>
                  <dd className="font-display text-xl font-semibold text-ink">{result.totalPoints}</dd>
                </div>
                <div className="rounded-xl2 bg-surface-muted px-2 py-2.5">
                  <dt className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                    {t("editor.stat.warnings")}
                  </dt>
                  <dd className="font-display text-xl font-semibold text-amber">{warnings.length}</dd>
                </div>
              </dl>
            ) : null}

            <ul className="mt-4 space-y-2 text-sm">
              {errors.slice(0, 8).map((issue, index) => (
                <li key={`e${index}`} className="rounded-xl2 border border-pink/25 bg-pink/8 px-3 py-2 text-ink-soft">
                  {issue.field ? <span className="font-mono text-xs text-pink">{issue.field} · </span> : null}
                  {issue.message}
                </li>
              ))}
              {warnings.slice(0, 6).map((issue, index) => (
                <li key={`w${index}`} className="rounded-xl2 border border-amber/25 bg-amber/8 px-3 py-2 text-ink-soft">
                  {issue.field ? <span className="font-mono text-xs text-amber">{issue.field} · </span> : null}
                  {issue.message}
                </li>
              ))}
              {errors.length > 8 ? (
                <li className="px-1 text-xs text-ink-faint">
                  {t("editor.moreErrors", { count: errors.length - 8 })}
                </li>
              ) : null}
              {warnings.length > 6 ? (
                <li className="px-1 text-xs text-ink-faint">
                  {t("editor.moreWarnings", { count: warnings.length - 6 })}
                </li>
              ) : null}
              {result && result.issues.length === 0 ? (
                <li className="rounded-xl2 border border-teal/25 bg-teal/8 px-3 py-2 text-ink-soft">
                  {t("editor.allPass")}
                </li>
              ) : null}
            </ul>
          </Card>

          <Card>
            <h2 className="font-display text-base font-semibold text-ink">{t("editor.requiredSoftware")}</h2>
            <p className="mt-1 text-xs text-ink-soft">{t("editor.requiredSoftwareHint")}</p>

            {softwareOptions.length === 0 ? (
              <p className="mt-3 rounded-xl2 border border-dashed border-line px-3 py-3 text-xs text-ink-faint">
                {t("editor.noSoftware")}
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {softwareOptions.map((option) => (
                  <li key={option.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-xl2 border border-line px-3 py-2.5 transition hover:border-brand/30",
                        !option.ready && "opacity-70",
                      )}
                    >
                      <input
                        type="checkbox"
                        name="softwareIds"
                        value={option.id}
                        checked={selected.includes(option.id)}
                        onChange={() => toggleSoftware(option.id)}
                        className="mt-0.5 size-4 accent-[var(--brand)]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{option.name}</span>
                        <span className="block text-[11px] text-ink-faint">
                          {option.platform.toLowerCase()}
                          {option.enabled ? "" : t("editor.option.disabled")}
                          {option.ready ? t("editor.option.ready") : t("editor.option.notProvisioned")}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <button
              type="button"
              onClick={() => setReferenceOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span className="font-display text-base font-semibold text-ink">{t("editor.checkReference")}</span>
              <span className="text-xs font-semibold text-brand">
                {referenceOpen ? t("editor.hide") : t("editor.show", { count: CHECK_KINDS.length })}
              </span>
            </button>
            {referenceOpen ? (
              <ul className="mt-3 space-y-2 text-xs">
                {CHECK_REFERENCE.map((entry) => (
                  <li key={entry.kind} className="rounded-xl2 bg-surface-muted px-3 py-2">
                    <code className="font-mono font-semibold text-brand">{entry.kind}</code>
                    <span className="mt-0.5 block text-ink-soft">{t(entry.hintKey)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <div className="sticky bottom-4">
            <Button type="submit" size="lg" className="w-full" disabled={!result?.ok}>
              {scenarioId ? t("editor.saveChanges") : t("editor.create")}
            </Button>
            <p className="mt-2 text-center text-[11px] text-ink-faint">
              {result?.ok ? t("editor.willSave") : t("editor.fixErrors")}
            </p>
          </div>
        </div>
      </div>
    </form>
  );
}
