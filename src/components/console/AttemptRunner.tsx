"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { OfficePanel } from "@/components/console/OfficePanel";
import { DesktopPane } from "@/components/console/DesktopPane";
import { abandonAttempt, autosaveAttempt, submitAttempt } from "@/app/actions/student";
import { createDriver } from "@/lib/sim/drivers";
import { isDesktopScenario } from "@/lib/sim/desktop";
import { toKey } from "@/lib/sim/paths";
import { writeEditedFile } from "@/lib/sim/vfs";
import { cn, formatDuration } from "@/lib/cn";
import { Badge, Button, Card, Input, ProgressBar, buttonClass } from "@/components/ui";
import { translate, type Locale } from "@/lib/i18n";
import { messagesFor } from "@/lib/locales";
import { useTranslator } from "@/lib/i18n-client";
import type { CommandResult, EngineState, ScenarioDefinition } from "@/lib/sim/types";

export interface AttemptRunnerProps {
  attempt: {
    id: string;
    status: string;
    expiresAt: string;
    startedAt: string;
    hintsUsed: string[];
    serverRemaining: number;
  };
  scenario: {
    id: string;
    title: string;
    objective: string;
    platform: string;
    engine: string;
    difficulty: string;
    timeLimitSec: number;
    passScore: number;
  };
  definition: ScenarioDefinition;
  initialState: EngineState;
  /** Assign the student has been given, if any. */
  assignment?: { instructions?: string | null; dueAt?: string | null } | null;
  /** The UI language, read from the locale cookie by the page. */
  locale?: Locale;
}

// xterm touches the browser-only `self` global at module scope, so it must never
// be evaluated on the server. Loading the pane client-side only keeps the page
// renderable during SSR and avoids a `ReferenceError: self is not defined`.
const TerminalPane = dynamic(() => import("@/components/console/Terminal").then((m) => m.TerminalPane), {
  ssr: false,
  loading: ConsoleLoading,
});

/** The client-only fallback shown while xterm loads. */
function ConsoleLoading() {
  const t = useTranslator();
  return (
    <div className="flex h-[26rem] items-center justify-center rounded-2xl border border-white/10 bg-[#141029] text-sm text-violet-200/70 lg:h-[34rem]">
      {t("console.loading")}
    </div>
  );
}

type Tab = "desktop" | "console" | "tasks" | "notes" | "docs" | "machine" | "help";

const PLATFORM_TONE: Record<string, "amber" | "sky" | "pink"> = {
  LINUX: "amber",
  WINDOWS: "sky",
  OFFICE: "pink",
};

/** Tab id plus the message key its label is translated from. */
const TAB_LABELS: [Tab, string][] = [
  ["desktop", "console.tab.desktop"],
  ["console", "console.tab.console"],
  ["tasks", "console.tab.tasks"],
  ["notes", "console.tab.notes"],
  ["docs", "console.tab.docs"],
  ["machine", "console.tab.machine"],
  ["help", "console.tab.help"],
];

/**
 * The countdown keeps its own state so the once-per-second tick re-renders only
 * this one line. When the tick lived in `AttemptRunner`, every second re-rendered
 * the console subtree too, which made the page look like it was refreshing under
 * the student's hands while they were typing.
 */
function Countdown({
  expiresAt,
  initialRemaining,
  running,
  onExpire,
}: {
  expiresAt: string;
  /** Server-computed second count, so the first paint matches on both sides. */
  initialRemaining: number;
  running: boolean;
  onExpire: () => void;
}) {
  const deadline = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(initialRemaining);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const expiredRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    expiredRef.current = false;
    const tick = () => {
      const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !expiredRef.current) {
        expiredRef.current = true;
        expireRef.current();
      }
    };
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [deadline, running]);

  return (
    <p
      role="timer"
      aria-live={running && remaining <= 60 ? "polite" : "off"}
      className={cn(
        "font-mono text-3xl font-semibold tabular-nums transition-colors",
        running && remaining <= 60 ? "text-pink" : "text-ink",
      )}
    >
      {running ? formatDuration(remaining) : "—"}
    </p>
  );
}

export function AttemptRunner({ attempt, scenario, definition, initialState, assignment, locale = "en" }: AttemptRunnerProps) {
  const t = (key: string, vars?: Record<string, string | number>) => translate(messagesFor(locale), key, vars);
  // The engine state is intentionally mutated in place by the driver; React
  // re-renders are driven by an explicit revision counter.
  const stateRef = useRef<EngineState>(initialState);
  const hasDesktop = isDesktopScenario(definition);
  const tabs = TAB_LABELS.filter(
    ([id]) => (id === "desktop" ? hasDesktop : id !== "docs" || definition.platform === "OFFICE"),
  );
  const [revision, setRevision] = useState(0);
  // A desktop scenario opens on the desktop; everything else opens on the shell.
  const [tab, setTab] = useState<Tab>(hasDesktop ? "desktop" : "console");
  const [revealed, setRevealed] = useState<string[]>(attempt.hintsUsed);
  const [doneTasks, setDoneTasks] = useState<number[]>([]);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [editorText, setEditorText] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const notesCardRef = useRef<HTMLDivElement | null>(null);
  /** Set when a narrow-screen jump switches to the notes tab, so focus lands on
   *  the pad only after React has rendered it. */
  const pendingNotesFocus = useRef(false);

  const focusTab = useCallback((id: Tab) => {
    setTab(id);
    tabRefs.current[id]?.focus();
  }, []);

  // Roving-keyboard behaviour for the tab strip: arrows move, Home/End jump.
  const onTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, id: Tab) => {
      const index = tabs.findIndex(([tabId]) => tabId === id);
      if (index === -1) return;
      let next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      focusTab(tabs[next][0]);
    },
    [tabs, focusTab],
  );

  const driver = useMemo(
    () => createDriver(definition.engine, { user: definition.machine.user }),
    [definition.engine, definition.machine.user],
  );

  const commandNames = useMemo(() => driver.completions?.() ?? [], [driver]);
  const notices = stateRef.current.machine.notices;

  const bump = useCallback(() => {
    // Notices are transient: show them, then clear so they do not pile up.
    setRevision((value) => value + 1);
  }, []);

  const runCommand = useCallback(
    (input: string): CommandResult => {
      // Notices describe the command that just ran, so start each one clean.
      stateRef.current.machine.notices = [];
      return driver.run(input, stateRef.current);
    },
    [driver],
  );

  /* ---------------------------------------------------------------- timer */

  const finished = attempt.status !== "IN_PROGRESS";

  /* ------------------------------------------------------------- autosave */

  const persist = useCallback(async () => {
    if (attempt.status !== "IN_PROGRESS" || submittedRef.current) return;
    setSaveState("saving");
    try {
      const result = await autosaveAttempt({ attemptId: attempt.id, state: stateRef.current });
      setSaveState(result.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }, [attempt.id, attempt.status]);

  useEffect(() => {
    if (attempt.status !== "IN_PROGRESS") return;
    const handle = window.setInterval(() => {
      void persist();
    }, 20_000);
    return () => {
      window.clearInterval(handle);
      void persist();
    };
  }, [attempt.status, persist]);

  /* -------------------------------------------------------------- actions */

  async function finish(reason: "student" | "timeout") {
    setSubmitting(true);
    const payload = new FormData();
    payload.set("attemptId", attempt.id);
    payload.set("reason", reason);
    try {
      // Make sure the graded snapshot is the one on screen.
      await autosaveAttempt({ attemptId: attempt.id, state: stateRef.current });
    } catch {
      /* grading still runs against the last autosave */
    }
    await submitAttempt(payload);
  }

  function revealHint(id: string) {
    if (revealed.includes(id)) return;
    const next = [...revealed, id];
    setRevealed(next);
    // The penalty is applied during server-side grading from this list.
    stateRef.current.meta.hintsUsed = next;
    bump();
  }

  /** Notes double as an assessment artefact, so the pad writes straight to the
   *  same `machine.notes` array the `note` command and the grader read. */
  function addNote() {
    const text = noteDraft.trim();
    if (!text) return;
    stateRef.current.machine.notes.push(text);
    setNoteDraft("");
    bump();
  }

  function removeNote(index: number) {
    stateRef.current.machine.notes.splice(index, 1);
    bump();
  }

  /**
   * Bring the case-notes pad into view. On a large screen it is already on
   * screen beside the console or desktop, so this only scrolls to it; on a
   * narrow screen it lives behind the "Notes" tab, so we switch to it first and
   * focus the input once it has rendered.
   */
  function jumpToNotes() {
    const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
    if (wide) {
      notesCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      notesInputEl()?.focus();
    } else {
      pendingNotesFocus.current = true;
      setTab("notes");
    }
  }

  const notesInputEl = () => document.getElementById("attempt-notes-input") as HTMLInputElement | null;

  useEffect(() => {
    if (!pendingNotesFocus.current) return;
    pendingNotesFocus.current = false;
    notesCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    notesInputEl()?.focus();
  }, [tab]);

  function openEditor(path: string) {
    const entry = stateRef.current.vfs[toKey(definition.platform, path)];
    setEditorText(entry?.content ?? "");
    setEditorPath(path);
  }

  // The editor is a modal: move focus in on open, keep Tab inside it, close on
  // Escape, and hand focus back to whatever opened it.
  useEffect(() => {
    if (!editorPath) return;
    lastFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    editorTextareaRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditorPath(null);
        return;
      }
      if (event.key !== "Tab" || !editorRef.current) return;
      const focusable = editorRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      lastFocusRef.current?.focus();
    };
  }, [editorPath]);

  function saveEditor() {
    const path = editorPath;
    if (!path) return;
    // The shared helper keeps the editor's write identical to what the tests
    // exercise, and canonicalises the path the way every other lookup does.
    writeEditedFile(definition.platform, stateRef.current.vfs, path, editorText, definition.machine.user);
    setEditorPath(null);
    bump();
  }

  const penalty = (definition.hints ?? [])
    .filter((hint) => revealed.includes(hint.id))
    .reduce((sum, hint) => sum + (hint.penalty ?? 0), 0);

  const officeDocs = stateRef.current.office.docs;
  const isOffice = definition.platform === "OFFICE";

  /* ---------------------------------------------------------------- views */

  const tasksPanel = (
    <Card className="p-5">
      <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">{t("console.checklist")}</h3>
      <p className="mt-1 text-xs text-ink-faint">{t("console.checklistHint")}</p>
      <ul className="mt-4 space-y-2.5">
        {definition.tasks.map((task, index) => {
          const done = doneTasks.includes(index);
          return (
            <li key={task}>
              <button
                type="button"
                onClick={() => setDoneTasks((current) => (done ? current.filter((i) => i !== index) : [...current, index]))}
                className="flex w-full items-start gap-3 text-left"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition",
                    done ? "border-teal bg-teal text-white" : "border-line text-transparent",
                  )}
                >
                  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <span className={cn("text-sm", done ? "text-ink-faint line-through" : "text-ink-soft")}>{task}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-4">
        <ProgressBar
          value={(doneTasks.length / Math.max(1, definition.tasks.length)) * 100}
          tone="teal"
          label={t("console.progress")}
        />
      </div>
    </Card>
  );

  const notes = stateRef.current.machine.notes;

  const notesPanel = (
    <Card className="p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">
          {t("console.notes.title")}
        </h3>
        <span className="text-xs text-ink-faint">{t("console.notes.count", { count: notes.length })}</span>
      </div>
      <p className="mt-1 text-xs text-ink-faint">{t("console.notes.hint")}</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          addNote();
        }}
      >
        <Input
          type="text"
          value={noteDraft}
          onChange={(event) => setNoteDraft(event.target.value)}
          placeholder={t("console.notes.placeholder")}
          aria-label={t("console.notes.title")}
          id="attempt-notes-input"
        />
        <Button type="submit" size="sm" disabled={!noteDraft.trim()}>
          {t("console.notes.add")}
        </Button>
      </form>
      {notes.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">{t("console.notes.empty")}</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {notes.map((note, index) => (
            <li key={index} className="flex items-start gap-2 border-l-2 border-brand/40 pl-3">
              <span className="min-w-0 flex-1 text-sm text-ink-soft">{note}</span>
              <button
                type="button"
                onClick={() => removeNote(index)}
                aria-label={t("console.notes.remove")}
                className="shrink-0 rounded-md px-1.5 text-xs text-ink-faint transition hover:text-pink"
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );

  const machinePanel = (
    <Card className="p-5">
      <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">{t("console.machine")}</h3>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-faint">{t("console.machine.host")}</dt>
          <dd className="font-mono text-xs text-ink">{stateRef.current.machine.hostname}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-faint">{t("console.machine.system")}</dt>
          <dd className="max-w-[60%] text-right font-mono text-xs text-ink">{stateRef.current.machine.os.name}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-faint">{t("console.machine.signedIn")}</dt>
          <dd className="font-mono text-xs text-ink">{definition.machine.user}</dd>
        </div>
      </dl>

      {stateRef.current.machine.services.length > 0 ? (
        <>
          <h4 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("console.machine.services")}
          </h4>
          <ul className="space-y-1.5">
            {stateRef.current.machine.services.slice(0, 12).map((service) => (
              <li key={service.name} className="flex items-center gap-2 text-xs">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    service.active ? "bg-teal" : "bg-ink-faint/50",
                  )}
                />
                <span className="font-mono text-ink-soft">{service.name}</span>
                <span className="ml-auto text-ink-faint">
                  {service.active ? t("console.machine.running") : t("console.machine.stopped")}
                  {service.enabled ? t("console.machine.enabled") : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );

  const helpPanel = (
    <Card className="p-5">
      <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">{t("console.help")}</h3>
      <p className="mt-2 text-sm text-ink-soft">{t("console.help.body")}</p>
      <h4 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        {t("console.help.techniques")}
      </h4>
      <ul className="space-y-2 text-sm text-ink-soft">
        <li>{t("console.help.history")}</li>
        <li>{t("console.help.tab")}</li>
        <li>{t("console.help.ctrlC")}</li>
        <li>{t("console.help.pipes")}</li>
      </ul>
      <h4 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        {t("console.help.notes")}
      </h4>
      <p className="text-sm text-ink-soft">
        {stateRef.current.machine.notes.length === 0
          ? t("console.help.noNotes")
          : stateRef.current.machine.notes.map((note, index) => (
              <span key={index} className="block border-l-2 border-brand/40 pl-3 text-xs">
                {note}
              </span>
            ))}
      </p>
    </Card>
  );

  const hintsPanel =
    definition.hints && definition.hints.length > 0 ? (
      <Card className="p-5">
        <h3 className="font-display text-sm font-semibold tracking-wide text-ink uppercase">{t("console.hints")}</h3>
        <p className="mt-1 text-xs text-ink-faint">{t("console.hints.cost", { penalty })}</p>
        <ul className="mt-4 space-y-2.5">
          {definition.hints.map((hint) => {
            const shown = revealed.includes(hint.id);
            return (
              <li key={hint.id}>
                {shown ? (
                  <p className="rounded-xl2 border border-amber/25 bg-amber/10 px-3 py-2.5 text-sm text-ink-soft">
                    {hint.text}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => revealHint(hint.id)}
                    className="w-full rounded-xl2 border border-dashed border-line px-3 py-2.5 text-left text-sm text-ink-faint transition hover:border-amber/40 hover:text-amber"
                  >
                    {hint.penalty
                      ? t("console.hints.show", {
                          penalty: t("console.hints.points", {
                            count: hint.penalty,
                            plural: hint.penalty === 1 ? "" : "s",
                          }),
                        })
                      : t("console.hints.showNoPenalty")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    ) : null;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------ header */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={PLATFORM_TONE[definition.platform] ?? "brand"}>
                {t(
                  scenario.platform === "LINUX"
                    ? "console.platform.linux"
                    : scenario.platform === "WINDOWS"
                      ? "console.platform.windows"
                      : "console.platform.office",
                )}
              </Badge>
              <Badge tone="neutral">{scenario.difficulty.toLowerCase()}</Badge>
              <Badge tone={finished ? "neutral" : "teal"}>
                <span aria-hidden className={cn("size-1.5 rounded-full", finished ? "bg-ink-faint" : "animate-pulse bg-teal")} />
                {finished ? attempt.status.toLowerCase().replace("_", " ") : t("console.attemptRunning")}
              </Badge>
            </div>
            <h1 className="mt-3 font-display text-xl font-semibold text-ink sm:text-2xl">{scenario.title}</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-soft">{scenario.objective}</p>
            {assignment?.instructions ? (
              <p className="mt-2 rounded-xl2 border border-brand/20 bg-brand-soft/50 px-3 py-2 text-sm text-ink-soft">
                <span className="font-semibold text-brand">{t("console.instructorNote")} </span>
                {assignment.instructions}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col items-end gap-3">
            <div className="text-right">
              <p className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
                {t("console.timeRemaining")}
              </p>
              <Countdown
                expiresAt={attempt.expiresAt}
                initialRemaining={attempt.serverRemaining}
                running={!finished}
                onExpire={() => {
                  if (submittedRef.current) return;
                  submittedRef.current = true;
                  void finish("timeout");
                }}
              />
              <p className="text-[11px] text-ink-faint">
                {t("console.passLimit", {
                  pass: scenario.passScore,
                  limit: formatDuration(scenario.timeLimitSec),
                })}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={jumpToNotes}>
                {t("console.notes.jump")}
                {notes.length > 0 ? (
                  <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                    {notes.length}
                  </span>
                ) : null}
              </Button>
              <span className="text-[11px] text-ink-faint">
                {saveState === "saving"
                  ? t("console.save.saving")
                  : saveState === "saved"
                    ? t("console.save.saved")
                    : saveState === "error"
                      ? t("console.save.error")
                      : ""}
              </span>
              {!finished ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t("console.discardConfirm"))) {
                        const payload = new FormData();
                        payload.set("attemptId", attempt.id);
                        void abandonAttempt(payload);
                      }
                    }}
                  >
                    {t("console.discard")}
                  </Button>
                  <Button
                    variant="success"
                    onClick={() => {
                      if (window.confirm(t("console.submitConfirm"))) {
                        submittedRef.current = true;
                        void finish("student");
                      }
                    }}
                    disabled={submitting}
                  >
                    {submitting ? t("console.grading") : t("console.submit")}
                  </Button>
                </>
              ) : (
                <a href={`/student/results/${attempt.id}`} className={buttonClass("primary", "sm")}>
                  {t("console.viewReport")}
                </a>
              )}
            </div>
          </div>
        </div>

        {notices.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-2">
            {notices.slice(-4).map((notice, index) => (
              <li key={`${notice}-${index}`} className="rounded-full bg-teal/12 px-3 py-1 text-xs font-medium text-teal">
                {notice}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {/* -------------------------------------------------------------- tabs */}
      {/* A console scenario shows every pane at once on a large screen, so its
          tabs are mobile-only. A desktop scenario keeps its tabs at every width
          — otherwise a laptop would have no way back to the desktop. */}
      <div
        role="tablist"
        aria-label={t("console.workspace")}
        className={cn("flex items-center gap-1.5 overflow-x-auto", !hasDesktop && "lg:hidden")}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            id={`attempt-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => onTabKeyDown(event, id)}
            className={cn(
              "shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition",
              tab === id ? "gradient-brand text-white shadow-card" : "border border-line bg-surface text-ink-soft",
              // These panels are already on screen at this width.
              hasDesktop && id !== "desktop" && id !== "console" && "lg:hidden",
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------- panes */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div
          className={cn(
            "min-w-0 space-y-4",
            hasDesktop ? (tab === "console" ? "block" : "hidden") : tab !== "console" && "hidden lg:block",
          )}
        >
          <TerminalPane
            getPrompt={() => driver.prompt(stateRef.current)}
            onCommand={runCommand}
            banner={driver.banner(stateRef.current)}
            onOpenEditor={openEditor}
            completions={commandNames}
            onActivity={bump}
            className="h-[26rem] lg:h-[34rem]"
          />

          {isOffice ? (
            <div className={cn(tab === "console" || tab === "docs" ? "block" : "hidden lg:block")}>
              <OfficePanel
                docs={officeDocs}
                activeDoc={stateRef.current.office.activeDoc}
                onSelect={(name) => {
                  stateRef.current.office.activeDoc = name;
                  bump();
                }}
                revision={revision}
                className="h-[22rem]"
              />
            </div>
          ) : null}
        </div>

        {hasDesktop ? (
          <div className={cn("min-w-0 space-y-4", tab === "desktop" ? "block" : "hidden")}>
            <DesktopPane
              state={stateRef.current}
              revision={revision}
              onCommand={runCommand}
              onOpenEditor={openEditor}
              onOpenConsole={() => setTab("console")}
              signedInAs={definition.machine.user}
              className="h-[30rem] lg:h-[36rem]"
            />
          </div>
        ) : null}

        {/**
         * On a wide screen this column sits beside the console or desktop, so
         * its panels are readable without switching tabs. The case-notes pad
         * leads the column: it is the one scratch surface every scenario has,
         * and the header's "Case notes" button scrolls straight to it.
         */}
        <div
          className={cn(
            "space-y-4",
            hasDesktop
              ? tab === "desktop" || tab === "console"
                ? "hidden lg:block"
                : "block"
              : tab === "console" && "hidden lg:block",
          )}
        >
          {/* The notes pad is the one scratch surface every scenario has, so it
              leads the column and stays on screen at every tab on a wide
              viewport. */}
          <div ref={notesCardRef} className={cn(tab === "notes" || tab === "console" ? "block" : "hidden lg:block")}>
            {notesPanel}
          </div>
          <div className={cn(tab === "tasks" || tab === "console" ? "block" : "hidden lg:block")}>{tasksPanel}</div>
          <div className={cn(tab === "tasks" || tab === "help" || tab === "console" ? "block" : "hidden lg:block")}>
            {hintsPanel}
          </div>
          <div className={cn(tab === "machine" || tab === "console" ? "block" : "hidden lg:block")}>{machinePanel}</div>
          <div className={cn(tab === "help" || tab === "console" ? "block" : "hidden lg:block")}>{helpPanel}</div>
        </div>
      </div>

      {/* ------------------------------------------------------------- editor */}
      {editorPath ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label={t("console.editor.close")}
            className="absolute inset-0 bg-ink/50 backdrop-blur-sm"
            onClick={() => setEditorPath(null)}
          />
          <div
            ref={editorRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="attempt-editor-title"
            className="animate-pop relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl3 border border-line bg-surface shadow-lift"
          >
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
              <div>
                <h3 id="attempt-editor-title" className="font-display text-sm font-semibold text-ink">
                  {t("console.editor.title")}
                </h3>
                <p className="font-mono text-xs text-ink-faint">{editorPath}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditorPath(null)}>
                  {t("console.editor.cancel")}
                </Button>
                <Button size="sm" onClick={saveEditor}>
                  {t("console.editor.save")}
                </Button>
              </div>
            </div>
            <textarea
              ref={editorTextareaRef}
              aria-label={t("console.editor.contents", { path: editorPath })}
              value={editorText}
              onChange={(event) => setEditorText(event.target.value)}
              spellCheck={false}
              className="min-h-[24rem] flex-1 resize-none bg-[#141029] px-5 py-4 font-mono text-[13px] leading-relaxed text-[#ded8ff] outline-none"
            />
            <p className="border-t border-line px-5 py-2 text-xs text-ink-faint">{t("console.editor.footer")}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

