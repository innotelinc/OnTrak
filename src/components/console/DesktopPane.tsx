"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { useTranslator } from "@/lib/i18n-client";
import { baseName, dirName, display } from "@/lib/sim/paths";
import {
  desktopCommands,
  initialFrameBox,
  moveFrame,
  nameDraftCommand,
  resizeFrame,
  sanitizeName,
  updatesPaused,
  UPDATE_POLICY_NAME,
  UPDATE_POLICY_PATH,
  type FrameBox,
} from "@/lib/sim/desktop";
import { listDir } from "@/lib/sim/vfs";
import { Button, Select } from "@/components/ui";
import type { CommandResult, EngineState, VfsEntry } from "@/lib/sim/types";

export interface DesktopPaneProps {
  /** The live machine state. The driver mutates it in place. */
  state: EngineState;
  /** Bumped by the runner after every simulated command. */
  revision: number;
  /**
   * Runs one command line through the same engine the console uses, so a click
   * and a keystroke are graded identically.
   */
  onCommand: (command: string) => CommandResult;
  /** Opens a file in the runner's text editor. */
  onOpenEditor: (path: string) => void;
  /** Hands the session over to the terminal. */
  onOpenConsole: () => void;
  /** Account the session runs as, so we never offer to disable ourselves. */
  signedInAs: string;
  className?: string;
}

type AppId = "explorer" | "services" | "updates" | "security" | "events" | "tasks" | "accounts" | "notes";

interface AppDefinition {
  id: AppId;
  /** Message key for the window title; translated where it is displayed. */
  nameKey: string;
  icon: string;
  /** Message key for the one-line description shown in the title bar. */
  blurbKey: string;
}

const APPS: AppDefinition[] = [
  { id: "explorer", nameKey: "desktop.app.explorer.name", icon: "🗂️", blurbKey: "desktop.app.explorer.blurb" },
  { id: "services", nameKey: "desktop.app.services.name", icon: "🖨️", blurbKey: "desktop.app.services.blurb" },
  { id: "updates", nameKey: "desktop.app.updates.name", icon: "🔄", blurbKey: "desktop.app.updates.blurb" },
  { id: "security", nameKey: "desktop.app.security.name", icon: "🛡️", blurbKey: "desktop.app.security.blurb" },
  { id: "events", nameKey: "desktop.app.events.name", icon: "📋", blurbKey: "desktop.app.events.blurb" },
  { id: "tasks", nameKey: "desktop.app.tasks.name", icon: "📈", blurbKey: "desktop.app.tasks.blurb" },
  { id: "accounts", nameKey: "desktop.app.accounts.name", icon: "👤", blurbKey: "desktop.app.accounts.blurb" },
  { id: "notes", nameKey: "desktop.app.notes.name", icon: "📝", blurbKey: "desktop.app.notes.blurb" },
];

/** The startup-type values stay canonical (the cmdlet takes them); labels translate. */
const STARTUP_TYPES = [
  { value: "Automatic", key: "desktop.startup.auto" },
  { value: "Manual", key: "desktop.startup.manual" },
  { value: "Disabled", key: "desktop.startup.disabled" },
] as const;
type StartupType = (typeof STARTUP_TYPES)[number]["value"];

function firstLine(text: string | undefined, fallback: string): string {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find(Boolean);
  return line ?? fallback;
}

function crumbs(path: string): { part: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((part, index) => ({
    part,
    path: `/${parts.slice(0, index + 1).join("/")}`,
  }));
}

function fileIcon(entry: VfsEntry): string {
  if (entry.type === "dir") return "📁";
  const name = baseName(entry.path).toLowerCase();
  if (/\.(png|jpe?g|bmp|gif)$/.test(name)) return "🖼️";
  if (/\.(log|txt|md|ini|json|xml)$/.test(name)) return "📄";
  if (/\.(exe|msi|dll)$/.test(name)) return "⚙️";
  return "📄";
}

function formatSize(entry: VfsEntry): string {
  if (entry.type === "dir") return "";
  if (entry.size < 1024) return `${entry.size} B`;
  return `${(entry.size / 1024).toFixed(1)} KB`;
}

/**
 * A clickable Windows 11 desktop.
 *
 * Nothing here re-implements the machine: every button runs the PowerShell
 * cmdlet a technician would have typed, through the same driver instance the
 * terminal uses. That keeps one source of truth for grading, and it means a
 * student can finish a desktop scenario entirely by clicking — or drop into the
 * console tab and type the same work.
 */
export function DesktopPane({
  state,
  revision,
  onCommand,
  onOpenEditor,
  onOpenConsole,
  signedInAs,
  className,
}: DesktopPaneProps) {
  const t = useTranslator();
  const [openApp, setOpenApp] = useState<AppId | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [toast, setToast] = useState<{ key: number; tone: "ok" | "error"; text: string } | null>(null);

  const [explorerPath, setExplorerPath] = useState(() => state.machine.cwd);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * Cut/Paste in File Explorer. A cut item stays put until it is pasted, and
   * `pasteHere` only runs once the student has navigated somewhere else.
   */
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  /**
   * An in-progress name for the New folder / New file / Rename box. A little
   * inline form beats `window.prompt`, which browsers block and which a phone
   * keyboard makes painful.
   */
  const [draft, setDraft] = useState<{ mode: "folder" | "file" | "rename"; value: string } | null>(null);

  const toastKey = useRef(0);

  const run = (command: string, okMessage?: string): boolean => {
    const result = onCommand(command);
    toastKey.current += 1;
    if ((result.exitCode ?? 0) !== 0) {
      setToast({ key: toastKey.current, tone: "error", text: firstLine(result.stderr, t("desktop.commandFailed", { command })) });
      return false;
    }
    setToast({ key: toastKey.current, tone: "ok", text: okMessage ?? firstLine(result.stdout, t("desktop.ran", { command })) });
    return true;
  };

  // The explorer starts in the signed-in account's profile, not wherever the
  // console last ran `cd`.
  const home =
    state.machine.users.find((user) => user.name.toLowerCase() === signedInAs.toLowerCase())?.home ??
    state.machine.cwd;

  const entries = useMemo(
    () =>
      listDir("WINDOWS", state.vfs, explorerPath).filter((entry) => {
        const name = baseName(entry.path);
        return !name.startsWith("$") && !name.startsWith(".");
      }),
    // `revision` changes whenever a command has run, which is exactly when the
    // listing can have changed.
    [state.vfs, explorerPath, revision],
  );

  const desktopItems = useMemo(
    () =>
      listDir("WINDOWS", state.vfs, `${state.machine.cwd}/Desktop`).filter(
        (entry) => !baseName(entry.path).startsWith("."),
      ),
    [state.vfs, state.machine.cwd, revision],
  );

  const updatePolicy = state.machine.registry.find(
    (value) =>
      value.path.toLowerCase() === UPDATE_POLICY_PATH.toLowerCase() &&
      value.name.toLowerCase() === UPDATE_POLICY_NAME.toLowerCase(),
  );
  const updatesBlocked = updatesPaused(state);

  const openEntry = (entry: VfsEntry) => {
    if (entry.type === "dir") {
      setExplorerPath(entry.path);
      setSelected(null);
      return;
    }
    onOpenEditor(display("WINDOWS", entry.path));
  };

  const openAppById = (id: AppId) => {
    setOpenApp(id);
    setStartOpen(false);
  };

  /** Turn the inline name box into the cmdlet File Explorer would have run. */
  const submitDraft = () => {
    if (!draft) return;
    const command = nameDraftCommand(draft, { folder: explorerPath, selected });
    if (!command) {
      setDraft(null);
      return;
    }
    const name = sanitizeName(draft.value);
    if (draft.mode === "rename") {
      if (run(command, t("desktop.renamed", { name }))) setSelected(null);
    } else {
      run(command, t("desktop.createdName", { name }));
    }
    setDraft(null);
  };

  /** Where the cut item came from — pasting back into it would be a no-op. */
  const clipboardFolder = clipboard ? dirName("WINDOWS", clipboard) : null;

  const cutSelected = () => {
    if (!selected) return;
    setClipboard(selected);
    toastKey.current += 1;
    setToast({
      key: toastKey.current,
      tone: "ok",
      text: t("desktop.cutToast", { name: baseName(selected) }),
    });
  };

  const pasteHere = () => {
    if (!clipboard || clipboardFolder === explorerPath) return;
    if (run(desktopCommands.moveItem(clipboard, explorerPath), t("desktop.moved", { name: baseName(clipboard) }))) {
      setClipboard(null);
      setSelected(null);
    }
  };

  const current = openApp ? APPS.find((app) => app.id === openApp) : undefined;
  const atDriveRoot = /^\/[a-z]:$/.test(explorerPath);

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden rounded-xl3 border border-line bg-[#0f1a33] shadow-card",
        className,
      )}
    >
      {/* ------------------------------------------------------- wallpaper */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(120%_120%_at_15%_0%,#1d4ed8_0%,#0b1f4b_45%,#081026_100%)]">
        {current ? (
          <WindowFrame
            key={current.id}
            icon={current.icon}
            title={t(current.nameKey)}
            blurb={t(current.blurbKey)}
            onMinimize={() => setOpenApp(null)}
            onClose={() => setOpenApp(null)}
          >
              {/* ------------------------------------------------ explorer */}
              {openApp === "explorer" ? (
                <div className="flex min-h-full flex-col">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" disabled={atDriveRoot} onClick={() => setExplorerPath(dirName("WINDOWS", explorerPath))}>
                      {t("desktop.up")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setExplorerPath(home)}>
                      {t("desktop.home")}
                    </Button>
                    <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs">
                      {crumbs(explorerPath).map((crumb, index, all) => (
                        <span key={crumb.path} className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setExplorerPath(crumb.path)}
                            className={cn(
                              "rounded px-1.5 py-0.5 font-mono transition hover:bg-brand-soft/50",
                              index === all.length - 1 ? "text-ink" : "text-ink-soft",
                            )}
                          >
                            {index === 0 ? t("desktop.localDisk", { drive: crumb.part.toUpperCase() }) : crumb.part}
                          </button>
                          {index < all.length - 1 ? <span className="text-ink-faint">›</span> : null}
                        </span>
                      ))}
                    </nav>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setDraft({ mode: "folder", value: "" })}>
                        {t("desktop.newFolder")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setDraft({ mode: "file", value: "" })}>
                        {t("desktop.newFile")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!selected}
                        onClick={() => setDraft({ mode: "rename", value: selected ? baseName(selected) : "" })}
                      >
                        {t("desktop.rename")}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={!selected} onClick={cutSelected}>
                        {t("desktop.cut")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!clipboard || clipboardFolder === explorerPath}
                        title={clipboard ? t("desktop.moveInto", { path: display("WINDOWS", clipboard) }) : t("desktop.cutFirst")}
                        onClick={pasteHere}
                      >
                        {t("desktop.paste")}
                      </Button>
                    </div>
                  </div>

                  {draft ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitDraft();
                      }}
                      className="mt-3 flex flex-wrap items-center gap-2 rounded-xl2 border border-brand/30 bg-brand-soft/30 p-2"
                    >
                      <label className="text-xs font-semibold text-brand" htmlFor="explorer-name">
                        {draft.mode === "rename" ? t("desktop.newName") : draft.mode === "folder" ? t("desktop.newFolderName") : t("desktop.newFileName")}
                      </label>
                      <input
                        id="explorer-name"
                        autoFocus
                        value={draft.value}
                        onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                        placeholder={draft.mode === "file" ? t("desktop.placeholderFile") : t("desktop.placeholderFolder")}
                        spellCheck={false}
                        className="min-w-40 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-brand/50"
                      />
                      <Button size="sm" type="submit" disabled={draft.value.trim().length === 0}>
                        {draft.mode === "rename" ? t("desktop.rename") : t("desktop.create")}
                      </Button>
                      <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(null)}>
                        {t("desktop.cancel")}
                      </Button>
                    </form>
                  ) : null}

                  <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl2 border border-line">
                    {entries.length === 0 ? (
                      <li className="px-3 py-6 text-center text-sm text-ink-faint">{t("desktop.folderEmpty")}</li>
                    ) : (
                      entries.map((entry) => (
                        <li key={entry.path}>
                          <button
                            type="button"
                            onClick={() => setSelected(entry.path)}
                            onDoubleClick={() => openEntry(entry)}
                            className={cn(
                              "flex w-full items-center gap-3 px-3 py-2 text-left transition",
                              selected === entry.path ? "bg-brand-soft/60" : "hover:bg-surface-muted/70",
                            )}
                          >
                            <span aria-hidden className="text-base leading-none">
                              {fileIcon(entry)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-ink">{baseName(entry.path)}</span>
                            <span className="hidden w-20 shrink-0 text-right text-xs text-ink-faint sm:block">
                              {entry.type === "dir" ? t("desktop.folder") : formatSize(entry)}
                            </span>
                            <span className="hidden w-40 shrink-0 text-right text-xs text-ink-faint md:block">
                              {new Date(entry.mtime).toLocaleString()}
                            </span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>

                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={!selected}
                      onClick={() => {
                        const entry = entries.find((item) => item.path === selected);
                        if (entry) openEntry(entry);
                      }}
                    >
                      {t("desktop.open")}
                    </Button>
                    <span className="text-xs text-ink-faint">
                      {selected ? display("WINDOWS", selected) : t("desktop.selectItem")}
                    </span>
                    {clipboard ? (
                      <span className="text-xs text-amber">
                        {t("desktop.cutLabel", { path: display("WINDOWS", clipboard) })}
                        {clipboardFolder === explorerPath ? t("desktop.pasteElsewhere") : ""}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* ------------------------------------------------ services */}
              {openApp === "services" ? (
                <ul className="space-y-2">
                  {state.machine.services.map((service) => (
                    <li key={service.name} className="rounded-xl2 border border-line bg-surface-muted/40 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          aria-hidden
                          className={cn("size-2 shrink-0 rounded-full", service.active ? "bg-teal" : "bg-ink-faint/50")}
                        />
                        <span className="font-mono text-xs text-ink-soft">{service.name}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">{service.displayName ?? service.name}</span>
                        <span className={cn("text-xs font-semibold", service.active ? "text-teal" : "text-ink-faint")}>
                          {service.active ? t("desktop.running") : t("desktop.stopped")}
                        </span>
                      </div>
                      {service.description ? <p className="mt-1 text-xs text-ink-faint">{service.description}</p> : null}
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="success" disabled={service.active} onClick={() => run(desktopCommands.startService(service.name), t("desktop.started", { name: service.name }))}>
                          {t("desktop.start")}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={!service.active} onClick={() => run(desktopCommands.stopService(service.name), t("desktop.stoppedService", { name: service.name }))}>
                          {t("desktop.stop")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => run(desktopCommands.restartService(service.name), t("desktop.restarted", { name: service.name }))}>
                          {t("desktop.restart")}
                        </Button>
                        <label className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
                          {t("desktop.startupType")}
                          <Select
                            className="w-36"
                            value={service.startupType ?? "Manual"}
                            onChange={(event) => {
                              const value = event.target.value as StartupType;
                              const label = t(STARTUP_TYPES.find((type) => type.value === value)?.key ?? "desktop.startup.manual");
                              run(
                                desktopCommands.setStartupType(service.name, value),
                                t("desktop.startupSet", { name: service.name, type: label.toLowerCase() }),
                              );
                            }}
                          >
                            {STARTUP_TYPES.map((type) => (
                              <option key={type.value} value={type.value}>
                                {t(type.key)}
                              </option>
                            ))}
                          </Select>
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* ------------------------------------------------- updates */}
              {openApp === "updates" ? (
                <div className="space-y-3">
                  <div className="rounded-xl2 border border-line bg-surface-muted/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-ink">{t("desktop.updates.title")}</p>
                        <p className="mt-1 text-xs text-ink-faint">
                          {updatesBlocked ? t("desktop.updates.blocked") : t("desktop.updates.normal")}
                        </p>
                      </div>
                      <span className={cn("size-2.5 shrink-0 rounded-full", updatesBlocked ? "bg-amber" : "bg-teal")} />
                    </div>
                    <p className="mt-3 font-mono text-[11px] break-all text-ink-faint">
                      {UPDATE_POLICY_PATH}\NoAutoUpdate = {updatePolicy ? String(updatePolicy.value) : t("desktop.updates.notSet")}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={!updatesBlocked}
                        onClick={() => run(desktopCommands.setUpdatePolicy(0), t("desktop.updates.cleared"))}
                      >
                        {t("desktop.updates.receive")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={updatesBlocked}
                        onClick={() => run(desktopCommands.setUpdatePolicy(1), t("desktop.updates.paused"))}
                      >
                        {t("desktop.updates.pause")}
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-ink-faint">{t("desktop.updates.note")}</p>
                </div>
              ) : null}

              {/* ------------------------------------------------ security */}
              {openApp === "security" ? (
                <ul className="space-y-2">
                  {state.machine.firewall.length === 0 ? (
                    <li className="rounded-xl2 border border-line px-3 py-6 text-center text-sm text-ink-faint">
                      {t("desktop.security.none")}
                    </li>
                  ) : null}
                  {state.machine.firewall.map((rule) => (
                    <li key={rule.name} className="rounded-xl2 border border-line bg-surface-muted/40 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{rule.name}</span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                            rule.action === "allow" ? "bg-amber/15 text-amber" : "bg-teal/15 text-teal",
                          )}
                        >
                          {rule.action === "allow" ? t("desktop.allow") : t("desktop.block")}
                        </span>
                        <span className="text-xs text-ink-faint">
                          {rule.direction === "in" ? t("desktop.inbound") : t("desktop.outbound")} · {rule.protocol.toUpperCase()}
                          {rule.port ? ` ${rule.port}` : ""} · {rule.enabled ? t("desktop.enabled") : t("desktop.disabled")}
                        </span>
                      </div>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={rule.action === "deny"}
                          onClick={() => run(desktopCommands.setFirewallAction(rule.name, "Block"), t("desktop.blockedTraffic", { name: rule.name }))}
                        >
                          {t("desktop.block")}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={rule.action === "allow"}
                          onClick={() => run(desktopCommands.setFirewallAction(rule.name, "Allow"), t("desktop.allowedTraffic", { name: rule.name }))}
                        >
                          {t("desktop.allow")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!rule.enabled}
                          onClick={() => run(desktopCommands.setFirewallEnabled(rule.name, false), t("desktop.ruleDisabled", { name: rule.name }))}
                        >
                          {t("desktop.disableRule")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={rule.enabled}
                          onClick={() => run(desktopCommands.setFirewallEnabled(rule.name, true), t("desktop.ruleEnabled", { name: rule.name }))}
                        >
                          {t("desktop.enableRule")}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* -------------------------------------------------- events */}
              {openApp === "events" ? (
                <ul className="space-y-2">
                  {state.machine.events.length === 0 ? (
                    <li className="rounded-xl2 border border-line px-3 py-6 text-center text-sm text-ink-faint">
                      {t("desktop.events.empty")}
                    </li>
                  ) : null}
                  {[...state.machine.events].reverse().map((event) => (
                    <li key={`${event.at}-${event.id}-${event.source}`} className="rounded-xl2 border border-line bg-surface-muted/40 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase",
                            event.level === "error" ? "bg-pink/15 text-pink" : event.level === "warning" ? "bg-amber/15 text-amber" : "bg-brand-soft text-brand",
                          )}
                        >
                          {event.level}
                        </span>
                        <span className="text-sm font-medium text-ink">{event.source}</span>
                        <span className="text-xs text-ink-faint">{t("desktop.eventId", { id: event.id })}</span>
                        <span className="ml-auto text-xs text-ink-faint">{new Date(event.at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1.5 text-sm text-ink-soft">{event.message}</p>
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* --------------------------------------------------- tasks */}
              {openApp === "tasks" ? (
                <div className="overflow-hidden rounded-xl2 border border-line">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-surface-muted/60 text-xs text-ink-faint uppercase">
                      <tr>
                        <th className="px-3 py-2 font-semibold">{t("desktop.pid")}</th>
                        <th className="px-3 py-2 font-semibold">{t("desktop.process")}</th>
                        <th className="hidden px-3 py-2 font-semibold sm:table-cell">{t("desktop.user")}</th>
                        <th className="px-3 py-2 text-right font-semibold">{t("desktop.cpu")}</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/60">
                      {state.machine.processes.map((process) => (
                        <tr key={process.pid}>
                          <td className="px-3 py-2 font-mono text-xs text-ink-faint">{process.pid}</td>
                          <td className="px-3 py-2 text-ink">{baseName(process.command.split(" ")[0])}</td>
                          <td className="hidden px-3 py-2 text-xs text-ink-faint sm:table-cell">{process.user}</td>
                          <td className="px-3 py-2 text-right text-xs text-ink-faint">{process.cpu.toFixed(2)}</td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => run(desktopCommands.endProcess(process.pid), t("desktop.processEnded", { pid: process.pid }))}
                            >
                              {t("desktop.endTask")}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* ------------------------------------------------ accounts */}
              {openApp === "accounts" ? (
                <ul className="space-y-2">
                  {state.machine.users.map((user) => {
                    const self = user.name.toLowerCase() === signedInAs.toLowerCase();
                    return (
                      <li key={user.name} className="flex flex-wrap items-center gap-3 rounded-xl2 border border-line bg-surface-muted/40 p-3">
                        <span aria-hidden className="text-base leading-none">
                          👤
                        </span>
                        <span className="font-mono text-xs text-ink-soft">{user.name}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                          {user.groups.join(", ")}
                          {self ? t("desktop.thisSession") : ""}
                        </span>
                        <span className={cn("text-xs font-semibold", user.enabled === false ? "text-ink-faint" : "text-teal")}>
                          {user.enabled === false ? t("desktop.accountDisabled") : t("desktop.accountEnabled")}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={user.enabled === false || self}
                          onClick={() => run(desktopCommands.setUserEnabled(user.name, false), t("desktop.userDisabled", { name: user.name }))}
                        >
                          {t("desktop.disable")}
                        </Button>
                        <Button
                          size="sm"
                          variant="success"
                          disabled={user.enabled !== false}
                          onClick={() => run(desktopCommands.setUserEnabled(user.name, true), t("desktop.userEnabled", { name: user.name }))}
                        >
                          {t("desktop.enable")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {/* --------------------------------------------------- notes */}
              {openApp === "notes" ? (
                <div className="space-y-3">
                  <textarea
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    placeholder={t("desktop.notes.placeholder")}
                    spellCheck={false}
                    className="min-h-28 w-full resize-y rounded-xl2 border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-brand/50"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={noteDraft.trim().length === 0}
                      onClick={() => {
                        if (run(desktopCommands.recordNote(noteDraft.trim()), t("desktop.notes.recorded"))) setNoteDraft("");
                      }}
                    >
                      {t("desktop.notes.save")}
                    </Button>
                    <span className="text-xs text-ink-faint">{t("desktop.notes.hint")}</span>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{t("desktop.notes.title")}</h4>
                    <ul className="mt-2 space-y-1.5">
                      {state.machine.notes.length === 0 ? (
                        <li className="text-sm text-ink-faint">{t("desktop.notes.empty")}</li>
                      ) : (
                        state.machine.notes.map((note, index) => (
                          <li key={index} className="border-l-2 border-brand/40 pl-3 text-sm text-ink-soft">
                            {note}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                </div>
              ) : null}
          </WindowFrame>
        ) : (
          /* ---------------------------------------------------- desktop */
          <div className="absolute inset-0 flex flex-col p-4">
            <div className="flex flex-wrap gap-2">
              {APPS.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => openAppById(app.id)}
                  className="flex w-24 flex-col items-center gap-1.5 rounded-xl2 p-2 text-center transition hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
                >
                  <span aria-hidden className="text-2xl leading-none">
                    {app.icon}
                  </span>
                  <span className="text-[11px] leading-tight font-medium text-white/90">{t(app.nameKey)}</span>
                </button>
              ))}

              {desktopItems.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onDoubleClick={() => openEntry(entry)}
                  onClick={() => openEntry(entry)}
                  className="flex w-24 flex-col items-center gap-1.5 rounded-xl2 p-2 text-center transition hover:bg-white/10"
                  title={display("WINDOWS", entry.path)}
                >
                  <span aria-hidden className="text-2xl leading-none">
                    {fileIcon(entry)}
                  </span>
                  <span className="text-[11px] leading-tight font-medium text-white/90">{baseName(entry.path)}</span>
                </button>
              ))}
            </div>

            <p className="mt-auto text-[11px] text-white/60">
              {t("desktop.footer", { os: state.machine.os.name, user: signedInAs })}
            </p>
          </div>
        )}

        {/* -------------------------------------------------------- toast */}
        {toast ? (
          <Toast
            key={toast.key}
            tone={toast.tone}
            text={toast.text}
            onDone={() => setToast((value) => (value && value.key === toast.key ? null : value))}
          />
        ) : null}
      </div>

      {/* ---------------------------------------------------------- start */}
      {startOpen ? (
        <div className="absolute bottom-14 left-3 z-20 w-64 overflow-hidden rounded-xl3 border border-line bg-surface shadow-lift">
          <p className="border-b border-line px-3 py-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {t("desktop.allApps")}
          </p>
          <ul className="max-h-64 overflow-auto py-1">
            {APPS.map((app) => (
              <li key={app.id}>
                <button
                  type="button"
                  onClick={() => openAppById(app.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-brand-soft/50"
                >
                  <span aria-hidden className="text-base leading-none">
                    {app.icon}
                  </span>
                  <span className="text-sm text-ink">{t(app.nameKey)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setStartOpen(false);
              onOpenConsole();
            }}
            className="flex w-full items-center gap-3 border-t border-line px-3 py-2 text-left transition hover:bg-brand-soft/50"
          >
            <span aria-hidden className="text-base leading-none">
              ⌨️
            </span>
            <span className="text-sm text-ink">{t("desktop.terminalPowerShell")}</span>
          </button>
        </div>
      ) : null}

      {/* -------------------------------------------------------- taskbar */}
      <div className="flex items-center gap-2 border-t border-white/10 bg-[#0b1f4b]/90 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => setStartOpen((open) => !open)}
          className={cn(
            "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition",
            startOpen ? "bg-white/20" : "hover:bg-white/10",
          )}
        >
          <span aria-hidden className="grid grid-cols-2 gap-0.5">
            <span className="size-1.5 bg-white/90" />
            <span className="size-1.5 bg-white/90" />
            <span className="size-1.5 bg-white/90" />
            <span className="size-1.5 bg-white/90" />
          </span>
          {t("desktop.startMenu")}
        </button>

        {current ? (
          <button
            type="button"
            onClick={() => setOpenApp(null)}
            className="flex max-w-[10rem] items-center gap-2 truncate rounded-lg bg-white/15 px-3 py-1.5 text-sm text-white"
          >
            <span aria-hidden className="leading-none">
              {current.icon}
            </span>
            <span className="truncate">{t(current.nameKey)}</span>
          </button>
        ) : null}

        <button
          type="button"
          onClick={onOpenConsole}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-white/85 transition hover:bg-white/10"
        >
          <span aria-hidden className="leading-none">
            ⌨️
          </span>
          <span className="hidden sm:inline">{t("desktop.terminal")}</span>
        </button>

        <TaskbarClock />
      </div>
    </div>
  );
}

/** The clock keeps its own state so its tick never re-renders the desktop. */
function TaskbarClock() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const render = () =>
      setLabel(
        `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}  ${new Date().toLocaleDateString()}`,
      );
    render();
    const handle = window.setInterval(render, 30_000);
    return () => window.clearInterval(handle);
  }, []);

  return (
    <span className="ml-auto text-right text-xs leading-tight text-white/85 tabular-nums" suppressHydrationWarning>
      {label ?? ""}
    </span>
  );
}

function Toast({ tone, text, onDone }: { tone: "ok" | "error"; text: string; onDone: () => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const handle = window.setTimeout(() => doneRef.current(), 4500);
    return () => window.clearTimeout(handle);
  }, []);

  return (
    <div
      role="status"
      className={cn(
        "animate-pop absolute right-3 bottom-3 z-30 max-w-sm rounded-xl2 border px-3 py-2 text-xs shadow-lift",
        tone === "ok" ? "border-teal/30 bg-teal/15 text-teal" : "border-pink/30 bg-pink/15 text-pink",
      )}
    >
      {text}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The window frame                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A floating desktop window.
 *
 * Drag the title bar to move it and, on a screen wide enough for a mouse, drag
 * the corner to resize. Pointer events mean a touch drag on a phone behaves the
 * same as a mouse drag; only the resize handle is hidden on small screens.
 *
 * Windows are a view only — nothing here touches the simulated machine.
 */
function WindowFrame({
  icon,
  title,
  blurb,
  onMinimize,
  onClose,
  children,
}: {
  icon: string;
  title: string;
  blurb: string;
  onMinimize: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useTranslator();
  const frameRef = useRef<HTMLElement>(null);
  const [box, setBox] = useState<FrameBox | null>(null);
  const [dragging, setDragging] = useState<"move" | "resize" | null>(null);
  const gesture = useRef<{ mode: "move" | "resize"; startX: number; startY: number; box: FrameBox } | null>(null);

  // The area the window floats inside — the desktop wallpaper. Windows are
  // positioned in pixels against it so dragging stays predictable.
  const measure = useCallback((): { w: number; h: number } => {
    const rect = frameRef.current?.offsetParent?.getBoundingClientRect();
    return { w: rect?.width ?? 720, h: rect?.height ?? 480 };
  }, []);

  // Open inset from the edges, so the wallpaper and its icons stay visible. The
  // window stays invisible until this runs, so there is no flash of a wrong
  // size; `useEffect` (rather than the layout variant) keeps server rendering
  // quiet, since this pane is server-rendered before it becomes interactive.
  useEffect(() => {
    setBox(initialFrameBox(measure()));
  }, [measure]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active) return;
      const bounds = measure();
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      // The maths lives in `desktop.ts` so it can be unit-tested without a DOM.
      setBox(
        active.mode === "move"
          ? moveFrame(active.box, dx, dy, bounds)
          : resizeFrame(active.box, dx, dy, bounds),
      );
    };
    const end = () => {
      gesture.current = null;
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [measure]);

  const begin = (mode: "move" | "resize") => (event: ReactPointerEvent) => {
    if (!box || event.button !== 0) return;
    event.preventDefault();
    gesture.current = { mode, startX: event.clientX, startY: event.clientY, box };
    setDragging(mode);
  };

  return (
    <section
      ref={frameRef}
      style={box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-xl2 border border-line bg-surface shadow-lift",
        box ? null : "inset-0 opacity-0",
        dragging ? "select-none" : null,
      )}
    >
      <header
        onPointerDown={begin("move")}
        className={cn(
          "flex touch-none items-center gap-2 border-b border-line bg-surface-muted/70 px-3 py-2",
          dragging === "move" ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <span aria-hidden className="text-base leading-none">
          {icon}
        </span>
        <h3 className="truncate font-display text-sm font-semibold text-ink">{title}</h3>
        <span className="hidden truncate text-xs text-ink-faint sm:inline">{blurb}</span>
        <div className="ml-auto flex items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            title={t("desktop.minimize")}
            aria-label={t("desktop.minimizeTitle", { title })}
            onClick={onMinimize}
            className="rounded-lg px-2 py-1 text-sm text-ink-faint transition hover:bg-surface-muted hover:text-ink"
          >
            ▁
          </button>
          <button
            type="button"
            title={t("desktop.close")}
            aria-label={t("desktop.closeTitle", { title })}
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-ink-faint transition hover:bg-pink/15 hover:text-pink"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>

      <button
        type="button"
        aria-label={t("desktop.resize")}
        title={t("desktop.dragToResize")}
        onPointerDown={begin("resize")}
        className="absolute right-0 bottom-0 hidden size-5 cursor-nwse-resize touch-none md:block"
      >
        <span aria-hidden className="absolute right-1 bottom-1 size-2.5 border-r-2 border-b-2 border-ink-faint/60" />
      </button>
    </section>
  );
}
