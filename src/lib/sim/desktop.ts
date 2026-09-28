/**
 * The Windows desktop surface.
 *
 * Everything here is deliberately pure and free of React so the browser, the
 * server and the tests all agree:
 *
 *   1. which scenarios open on a desktop,
 *   2. the command lines the desktop's buttons send, and
 *   3. the small pieces of view logic that would otherwise be trapped in JSX —
 *      the File Explorer name box and the floating window's drag/resize maths.
 *
 * A desktop click is not a second implementation of the machine — it emits the
 * cmdlet a technician would have typed and hands it to the same driver the
 * terminal uses. Keeping those strings here (rather than inline in JSX) means
 * the test that solves a desktop scenario runs the very same commands the
 * buttons send, so a wiring mistake fails `npm test` instead of a lesson.
 */

import { display, joinPath } from "./paths";
import type { EngineState, Platform, ScenarioDefinition, ScenarioSurface } from "./types";

/* -------------------------------------------------------------------------- */
/*  Which scenarios get a desktop                                             */
/* -------------------------------------------------------------------------- */

export function desktopSurface(platform: Platform, surface: ScenarioSurface | undefined): boolean {
  return platform === "WINDOWS" && surface === "desktop";
}

/** Scenario-level convenience wrapper for the pages that hold a definition. */
export function isDesktopScenario(definition: Pick<ScenarioDefinition, "platform" | "surface">): boolean {
  return desktopSurface(definition.platform, definition.surface);
}

/* -------------------------------------------------------------------------- */
/*  The command lines behind the buttons                                      */
/* -------------------------------------------------------------------------- */

/** Where the Windows Update policy the Settings app edits lives. */
export const UPDATE_POLICY_PATH = "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate";
export const UPDATE_POLICY_NAME = "NoAutoUpdate";

export const desktopCommands = {
  startService: (name: string) => `Start-Service -Name "${name}"`,
  stopService: (name: string) => `Stop-Service -Name "${name}"`,
  restartService: (name: string) => `Restart-Service -Name "${name}"`,
  setStartupType: (name: string, type: "Automatic" | "Manual" | "Disabled") =>
    `Set-Service -Name "${name}" -StartupType ${type}`,

  /** `0` lets Windows Update run again; `1` pauses it by policy. */
  setUpdatePolicy: (value: 0 | 1) =>
    `Set-ItemProperty -Path "${UPDATE_POLICY_PATH}" -Name ${UPDATE_POLICY_NAME} -Value ${value}`,

  setFirewallAction: (rule: string, action: "Block" | "Allow") =>
    `New-NetFirewallRule -DisplayName "${rule}" -Action ${action}`,
  setFirewallEnabled: (rule: string, enabled: boolean) =>
    `${enabled ? "Enable" : "Disable"}-NetFirewallRule -DisplayName "${rule}"`,

  setUserEnabled: (name: string, enabled: boolean) => `${enabled ? "Enable" : "Disable"}-LocalUser -Name "${name}"`,

  endProcess: (pid: number) => `Stop-Process -Id ${pid}`,

  /*
   * File work. File Explorer hands these the canonical virtual path it is
   * already showing; `display` turns it back into the `C:\...` a technician
   * would type, so the console history and the grader see the same cmdlet.
   */
  newFolder: (path: string) => `New-Item -ItemType Directory -Path "${display("WINDOWS", path)}"`,
  newFile: (path: string) => `New-Item -ItemType File -Path "${display("WINDOWS", path)}"`,
  renameItem: (path: string, newName: string) =>
    `Rename-Item -Path "${display("WINDOWS", path)}" -NewName "${newName}"`,

  /*
   * Cut/Paste. A folder is a valid `-Destination`, so the command is the same
   * whichever way the student pastes — PowerShell moves the item inside it.
   */
  moveItem: (from: string, to: string) =>
    `Move-Item -Path "${display("WINDOWS", from)}" -Destination "${display("WINDOWS", to)}"`,

  recordNote: (text: string) => `note ${text}`,
} as const;

/* -------------------------------------------------------------------------- */
/*  File Explorer's inline name box                                           */
/* -------------------------------------------------------------------------- */

export type NameDraftMode = "folder" | "file" | "rename";

/** The little inline form File Explorer shows for New folder / New file / Rename. */
export interface NameDraft {
  mode: NameDraftMode;
  value: string;
}

/**
 * Clean up a name typed into the box. Windows refuses `\` and `/` in a file
 * name, so they are dropped rather than sent to the driver as a path change.
 */
export function sanitizeName(value: string): string {
  return value.trim().replace(/[\\/]+/g, "");
}

/**
 * Turn the inline name box into the cmdlet File Explorer would have run.
 * Returns `null` when there is nothing to do — an empty (or separator-only)
 * name, or a rename with no selection — so the caller can just close the box.
 *
 * Keeping this here, rather than inline in the pane, is what lets a unit test
 * check the exact command a click sends without a DOM.
 */
export function nameDraftCommand(
  draft: NameDraft,
  location: { folder: string; selected: string | null },
): string | null {
  const name = sanitizeName(draft.value);
  if (!name) return null;
  if (draft.mode === "rename") {
    return location.selected ? desktopCommands.renameItem(location.selected, name) : null;
  }
  const target = joinPath("WINDOWS", location.folder, name);
  return draft.mode === "folder" ? desktopCommands.newFolder(target) : desktopCommands.newFile(target);
}

/* -------------------------------------------------------------------------- */
/*  Window frame geometry                                                     */
/* -------------------------------------------------------------------------- */

/** A floating window's position and size, in pixels against the wallpaper. */
export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The area a window floats inside. */
export interface FrameBounds {
  w: number;
  h: number;
}

export const FRAME_MIN_WIDTH = 260;
/** Kept in step with `initialFrameBox`'s height floor. */
export const FRAME_MIN_HEIGHT = 180;

/** Clamp `value` into `[min, max]`, tolerating an inverted (too small) range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Where a window opens: inset from the wallpaper's edges so icons stay visible. */
export function initialFrameBox(bounds: FrameBounds, inset = 16): FrameBox {
  return {
    x: inset,
    y: inset,
    w: Math.max(240, bounds.w - inset * 2),
    h: Math.max(200, bounds.h - inset * 2),
  };
}

/** Drag the title bar: follow the pointer, but never leave the wallpaper. */
export function moveFrame(box: FrameBox, dx: number, dy: number, bounds: FrameBounds): FrameBox {
  return {
    ...box,
    x: clamp(box.x + dx, 0, bounds.w - box.w),
    y: clamp(box.y + dy, 0, bounds.h - box.h),
  };
}

/** Drag the corner handle: resize, never below the minimum and never off-screen. */
export function resizeFrame(box: FrameBox, dx: number, dy: number, bounds: FrameBounds): FrameBox {
  return {
    ...box,
    w: clamp(box.w + dx, FRAME_MIN_WIDTH, bounds.w - box.x),
    h: clamp(box.h + dy, FRAME_MIN_HEIGHT, bounds.h - box.y),
  };
}

/** Does the machine currently have updates blocked by policy? */
export function updatesPaused(state: EngineState): boolean {
  const value = state.machine.registry.find(
    (entry) => entry.path.toLowerCase() === UPDATE_POLICY_PATH.toLowerCase() && entry.name.toLowerCase() === UPDATE_POLICY_NAME.toLowerCase(),
  );
  // A machine with no policy at all updates normally.
  return value ? String(value.value) !== "0" : false;
}
