/**
 * The desktop surface renders.
 *
 * The attempt page server-renders the desktop before it becomes interactive, so
 * a render-time mistake there takes out the whole tab. This is a cheap guard for
 * that path: no DOM and no browser needed, and it uses the seeded file-work
 * scenario so the desktop icons come from a real definition.
 *
 * The interactive half — drag, resize, File Explorer buttons — is covered in
 * `sim.test.ts` by running the exact command lines those buttons send and by
 * unit-testing the geometry helpers, which is why no DOM harness is required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopPane } from "../src/components/console/DesktopPane";
import { LocaleProvider } from "../src/lib/i18n-client";
import { createInitialState } from "../src/lib/sim/state";
import { WINDOWS_DESKTOP_FILES_TEMPLATE } from "../src/lib/templates";
import type { CommandResult } from "../src/lib/sim/types";

function render(): string {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);
  return renderToStaticMarkup(
    createElement(DesktopPane, {
      state,
      revision: 0,
      onCommand: (): CommandResult => ({ stdout: "", stderr: "", exitCode: 0 }),
      onOpenEditor: () => undefined,
      onOpenConsole: () => undefined,
      signedInAs: definition.machine.user,
    }),
  );
}

test("desktop: the pane server-renders with its apps and desktop icons", () => {
  const html = render();

  for (const app of ["File Explorer", "Services", "Windows Update", "Windows Security", "Case Notes"]) {
    assert.ok(html.includes(app), `the desktop should offer ${app}`);
  }

  // The ticket's files sit on the signed-in account's desktop.
  assert.ok(html.includes("assistant.ini"), "the desktop should show the seeded files");
  assert.ok(html.includes("Start"), "the taskbar should render");
  assert.ok(html.includes("Administrator"), "the wallpaper should name the signed-in account");
});

test("desktop: the pane renders at the default `student` account too", () => {
  const definition = { ...WINDOWS_DESKTOP_FILES_TEMPLATE, machine: { ...WINDOWS_DESKTOP_FILES_TEMPLATE.machine, user: "student" } };
  const state = createInitialState(definition);

  const html = renderToStaticMarkup(
    createElement(DesktopPane, {
      state,
      revision: 0,
      onCommand: (): CommandResult => ({ stdout: "", stderr: "", exitCode: 0 }),
      onOpenEditor: () => undefined,
      onOpenConsole: () => undefined,
      signedInAs: definition.machine.user,
    }),
  );

  assert.ok(html.includes("student"));
});

test("desktop: the surface follows the active locale", () => {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);

  const html = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: "es",
      children: createElement(DesktopPane, {
        state,
        revision: 0,
        onCommand: (): CommandResult => ({ stdout: "", stderr: "", exitCode: 0 }),
        onOpenEditor: () => undefined,
        onOpenConsole: () => undefined,
        signedInAs: definition.machine.user,
      }),
    }),
  );

  assert.ok(html.includes("Explorador de archivos"), "app names are translated");
  assert.ok(html.includes("Inicio"), "the taskbar Start button is translated");
  assert.ok(!html.includes("File Explorer"), "English does not leak into the Spanish surface");
});
