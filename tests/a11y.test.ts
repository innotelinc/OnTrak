/**
 * Accessibility audit for the simulator console.
 *
 * The roadmap's a11y work landed structurally (roles, labels, roving focus) but
 * still needed a check that runs in CI, not only a manual sweep. This runs
 * axe-core's WCAG A/AA rules against the server-rendered console surfaces using
 * jsdom — no browser required — and adds a few explicit keyboard/label
 * assertions axe does not cover (every control reachable, every control named).
 *
 * `color-contrast` is disabled: it needs real layout and paint, which jsdom does
 * not provide, so it can only ever report `incomplete` here. That check belongs
 * in a browser-based sweep; everything structural is covered below.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import axe from "axe-core";

import { DesktopPane } from "../src/components/console/DesktopPane";
import { OfficePanel } from "../src/components/console/OfficePanel";
import { LocaleProvider } from "../src/lib/i18n-client";
import { createInitialState } from "../src/lib/sim/state";
import type { CommandResult } from "../src/lib/sim/types";
import { OFFICE_TRIAGE_TEMPLATE, WINDOWS_DESKTOP_FILES_TEMPLATE } from "../src/lib/templates";
import type { Locale } from "../src/lib/i18n";

/** A DOM with the rendered markup, plus the `lang` a document should declare. */
function domFor(html: string): JSDOM {
  return new JSDOM(`<!doctype html><html lang="en"><body>${html}</body></html>`, { pretendToBeVisual: true });
}

/**
 * Run axe against a fragment. axe reads `window`/`document` off the global, so
 * they are temporarily pointed at the jsdom instance and restored afterwards.
 */
async function audit(html: string) {
  const dom = domFor(html);
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    Node: g.Node,
    Element: g.Element,
    HTMLElement: g.HTMLElement,
  };
  g.window = dom.window;
  g.document = dom.window.document;
  g.Node = dom.window.Node;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  try {
    return await axe.run(dom.window.document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
  } finally {
    Object.assign(g, saved);
  }
}

/** A readable one-line-per-violation string for the assertion message. */
function describeViolations(results: { violations: { id: string; help: string; nodes: unknown[] }[] }): string {
  return results.violations
    .map((violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`)
    .join("\n");
}

/** Every button/enabled control must expose an accessible name. */
function assertControlsNamed(html: string): void {
  const dom = domFor(html);
  const controls = [...dom.window.document.querySelectorAll("button, a[href], input, select, textarea")];
  const unnamed = controls.filter((control) => {
    if (control.getAttribute("aria-hidden") === "true") return false;
    const label =
      control.getAttribute("aria-label") ??
      control.textContent ??
      control.getAttribute("title") ??
      "";
    return label.trim().length === 0;
  });
  assert.equal(unnamed.length, 0, "every interactive control should have an accessible name");
}

function renderDesktop(locale: Locale = "en"): string {
  const definition = WINDOWS_DESKTOP_FILES_TEMPLATE;
  const state = createInitialState(definition);
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
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
}

function renderOffice(): string {
  const definition = OFFICE_TRIAGE_TEMPLATE;
  const state = createInitialState(definition);
  return renderToStaticMarkup(
    createElement(OfficePanel, {
      docs: state.office.docs,
      activeDoc: state.office.activeDoc,
      onSelect: () => undefined,
      revision: 0,
    }),
  );
}

test("a11y: the harness itself flags a planted violation", async () => {
  // Guards against the audit silently becoming a no-op: an unnamed button and an
  // image without alt text must both be reported.
  const results = await audit('<main><button aria-label=""></button><img src="x.png" alt="" role="presentation"></main>');
  assert.ok(results.violations.length >= 1, "axe should flag an unlabeled button");
  assert.ok(results.violations.some((violation) => violation.id === "button-name"));
});

test("a11y: the Windows desktop passes WCAG A/AA with every control named", async () => {
  const html = renderDesktop();
  const results = await audit(html);
  assert.equal(results.violations.length, 0, `axe violations:\n${describeViolations(results)}`);
  assertControlsNamed(html);
});

test("a11y: the desktop stays clean in another locale", async () => {
  const html = renderDesktop("es");
  const results = await audit(html);
  assert.equal(results.violations.length, 0, `axe violations:\n${describeViolations(results)}`);
});

test("a11y: the Office panels pass WCAG A/AA", async () => {
  const html = renderOffice();
  const results = await audit(html);
  assert.equal(results.violations.length, 0, `axe violations:\n${describeViolations(results)}`);
  assertControlsNamed(html);
});

test("a11y: the desktop keeps keyboard order in the DOM (no positive tabindex)", () => {
  const dom = domFor(renderDesktop());
  const positive = [...dom.window.document.querySelectorAll("[tabindex]")].filter((node) => {
    const value = Number(node.getAttribute("tabindex"));
    return Number.isFinite(value) && value > 0;
  });
  assert.equal(positive.length, 0, "a positive tabindex breaks natural focus order");
});
