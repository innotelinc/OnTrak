/**
 * The grading engine.
 *
 * Grading is a pure function of (scenario definition, final engine state), so a
 * submission is reproducible from its snapshot and instructors can re-grade
 * after fixing a typo in a check. Checks never look at timing, and never touch
 * the network, which keeps results stable across machines.
 */

import { computeCell, computeCellNumber } from "./formula";
import { baseName, display, homeFor, normalize, parseMode } from "./paths";
import { get, listDir } from "./vfs";
import type {
  CheckEvaluation,
  DocumentDoc,
  EngineState,
  MailDoc,
  OfficeDoc,
  Platform,
  ScenarioCheck,
  ScenarioDefinition,
  Sheet,
  GradeReport,
  SpreadsheetDoc,
} from "./types";

/* -------------------------------------------------------------------------- */
/*  Lookup helpers                                                            */
/* -------------------------------------------------------------------------- */

function findEntry(platform: Platform, state: EngineState, raw: string) {
  const candidates = [
    raw,
    normalize(platform, homeFor(platform), raw),
    normalize(platform, "/", raw),
    normalize(platform, state.machine.cwd, raw),
  ];
  for (const candidate of candidates) {
    const entry = get(platform, state.vfs, candidate);
    if (entry) return entry;
  }
  return undefined;
}

function showPath(platform: Platform, raw: string): string {
  return display(platform, normalize(platform, homeFor(platform), raw));
}

function testRegex(pattern: string, flags: string | undefined, value: string): boolean {
  try {
    return new RegExp(pattern, flags ?? "").test(value);
  } catch {
    return false;
  }
}

function normalizeServiceName(name: string): string {
  return name.replace(/\.service$/i, "").toLowerCase();
}

function findService(state: EngineState, name: string) {
  const needle = normalizeServiceName(name);
  return state.machine.services.find(
    (service) =>
      normalizeServiceName(service.name) === needle || (service.displayName ?? "").toLowerCase() === name.toLowerCase(),
  );
}

function findOfficeDoc(state: EngineState, name: string): OfficeDoc | undefined {
  const lower = name.toLowerCase();
  return (
    state.office.docs[name] ??
    Object.values(state.office.docs).find(
      (doc) => doc.name.toLowerCase() === lower || doc.name.toLowerCase().replace(/\.[a-z0-9]+$/, "") === lower,
    )
  );
}

function pickSheet(doc: SpreadsheetDoc, sheetName?: string): Sheet | undefined {
  if (!sheetName) return doc.sheets[doc.activeSheet] ?? doc.sheets[0];
  return doc.sheets.find((sheet) => sheet.name.toLowerCase() === sheetName.toLowerCase());
}

function documentText(doc: DocumentDoc): string {
  return doc.blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
        case "paragraph":
          return block.text;
        case "list":
          return block.items.join("\n");
        default:
          return block.rows.map((row) => row.join(" ")).join("\n");
      }
    })
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Individual checks                                                         */
/* -------------------------------------------------------------------------- */

interface Outcome {
  passed: boolean;
  detail: string;
}

function evaluateCheck(check: ScenarioCheck, def: ScenarioDefinition, state: EngineState): Outcome {
  const platform = def.platform;

  switch (check.kind) {
    case "file_exists": {
      const entry = findEntry(platform, state, check.path);
      return {
        passed: Boolean(entry),
        detail: entry
          ? check.successDetail ?? `Found ${showPath(platform, check.path)}.`
          : check.failureDetail ?? `Expected a file at ${showPath(platform, check.path)}, but nothing is there.`,
      };
    }

    case "file_absent": {
      const entry = findEntry(platform, state, check.path);
      return {
        passed: !entry,
        detail: entry
          ? check.failureDetail ?? `${showPath(platform, check.path)} still exists.`
          : check.successDetail ?? `${showPath(platform, check.path)} no longer exists.`,
      };
    }

    case "file_contains": {
      const entry = findEntry(platform, state, check.path);
      if (!entry) {
        return {
          passed: check.mustExist === false,
          detail: check.mustExist === false
            ? check.successDetail ?? `${showPath(platform, check.path)} does not exist.`
            : check.failureDetail ?? `${showPath(platform, check.path)} does not exist, so its contents could not be checked.`,
        };
      }
      const matched = testRegex(check.pattern, check.flags, entry.content ?? "");
      return {
        passed: matched,
        detail: matched
          ? check.successDetail ?? `${showPath(platform, check.path)} contains the expected content.`
          : check.failureDetail ?? `${showPath(platform, check.path)} does not contain /${check.pattern}/.`,
      };
    }

    case "file_not_contains": {
      const entry = findEntry(platform, state, check.path);
      if (!entry) {
        return {
          passed: check.mustExist === false,
          detail: check.mustExist === false
            ? check.successDetail ?? `${showPath(platform, check.path)} does not exist.`
            : check.failureDetail ?? `${showPath(platform, check.path)} does not exist, so its contents could not be checked.`,
        };
      }
      const matched = testRegex(check.pattern, check.flags, entry.content ?? "");
      return {
        passed: !matched,
        detail: matched
          ? check.failureDetail ?? `${showPath(platform, check.path)} still contains /${check.pattern}/.`
          : check.successDetail ?? `${showPath(platform, check.path)} no longer contains /${check.pattern}/.`,
      };
    }

    case "file_mode": {
      const entry = findEntry(platform, state, check.path);
      if (!entry) {
        return { passed: false, detail: check.failureDetail ?? `${showPath(platform, check.path)} does not exist.` };
      }
      const expected = parseMode(check.mode);
      const passed = (entry.mode & 0o7777) === expected;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${showPath(platform, check.path)} has the expected mode.`
          : check.failureDetail ?? `Expected ${showPath(platform, check.path)} to be ${check.mode}, found ${(entry.mode & 0o7777).toString(8).padStart(4, "0")}.`,
      };
    }

    case "file_owner": {
      const entry = findEntry(platform, state, check.path);
      if (!entry) {
        return { passed: false, detail: check.failureDetail ?? `${showPath(platform, check.path)} does not exist.` };
      }
      const ownerOk = !check.owner || entry.owner.toLowerCase() === check.owner.toLowerCase();
      const groupOk = !check.group || entry.group.toLowerCase() === check.group.toLowerCase();
      return {
        passed: ownerOk && groupOk,
        detail:
          ownerOk && groupOk
            ? check.successDetail ?? `${showPath(platform, check.path)} has the expected ownership.`
            : check.failureDetail ?? `Expected owner ${check.owner ?? "unchanged"}/${check.group ?? "unchanged"}, found ${entry.owner}/${entry.group}.`,
      };
    }

    case "dir_exists": {
      const entry = findEntry(platform, state, check.path);
      const passed = entry?.type === "dir";
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${showPath(platform, check.path)} is a directory.`
          : check.failureDetail ?? `Expected a directory at ${showPath(platform, check.path)}.`,
      };
    }

    case "command_matched": {
      const matches = state.machine.history.filter((entry) => testRegex(check.pattern, check.flags, entry.input));
      const required = check.minMatches ?? 1;
      const passed = matches.length >= required;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `Ran the expected command (${matches.length} match${matches.length === 1 ? "" : "es"}).`
          : check.failureDetail ?? `Never ran a command matching /${check.pattern}/ — expected at least ${required}.`,
      };
    }

    case "command_sequence": {
      const commands = state.machine.history.map((entry) => entry.input);
      let cursor = 0;
      for (const pattern of check.patterns) {
        const index = commands.findIndex((command, i) => i >= cursor && testRegex(pattern, check.flags, command));
        if (index < 0) {
          return {
            passed: false,
            detail: check.failureDetail ?? `The command sequence is incomplete: no match for /${pattern}/ after step ${cursor}.`,
          };
        }
        cursor = index + 1;
      }
      return { passed: true, detail: check.successDetail ?? "Ran the required steps in order." };
    }

    case "service_state": {
      const service = findService(state, check.name);
      if (!service) {
        return { passed: false, detail: check.failureDetail ?? `There is no service called ${check.name}.` };
      }
      const activeOk = check.active === undefined || service.active === check.active;
      const enabledOk = check.enabled === undefined || service.enabled === check.enabled;
      const passed = activeOk && enabledOk;
      const observed = [service.active ? "running" : "stopped", service.enabled ? "enabled" : "disabled"].join(", ");
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${check.name} is ${observed} as required.`
          : check.failureDetail ?? `Expected ${check.name} to be ${[check.active !== undefined ? (check.active ? "running" : "stopped") : null, check.enabled !== undefined ? (check.enabled ? "enabled" : "disabled") : null].filter(Boolean).join(", ")} but it was ${observed}.`,
      };
    }

    case "package_state": {
      const pkg = state.machine.packages.find((entry) => entry.name.toLowerCase() === check.name.toLowerCase());
      const installed = pkg?.installed ?? false;
      const expected = check.installed ?? true;
      return {
        passed: installed === expected,
        detail:
          installed === expected
            ? check.successDetail ?? `${check.name} is ${expected ? "installed" : "not installed"} as required.`
            : check.failureDetail ?? `Expected ${check.name} to be ${expected ? "installed" : "removed"}, but it is ${installed ? "installed" : "not installed"}.`,
      };
    }

    case "user_exists": {
      const user = state.machine.users.find((entry) => entry.name.toLowerCase() === check.name.toLowerCase());
      const exists = Boolean(user);
      const expected = check.exists ?? true;
      return {
        passed: exists === expected,
        detail:
          exists === expected
            ? check.successDetail ?? `Account ${check.name} is ${expected ? "present" : "absent"} as required.`
            : check.failureDetail ?? `Expected account ${check.name} to ${expected ? "exist" : "not exist"}.`,
      };
    }

    case "user_in_group": {
      const user = state.machine.users.find((entry) => entry.name.toLowerCase() === check.name.toLowerCase());
      if (!user) return { passed: false, detail: check.failureDetail ?? `Account ${check.name} does not exist.` };
      const passed = user.groups.some((group) => group.toLowerCase() === check.group.toLowerCase());
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${check.name} is a member of ${check.group}.`
          : check.failureDetail ?? `${check.name} is not in ${check.group} (current groups: ${user.groups.join(", ") || "none"}).`,
      };
    }

    case "user_detail": {
      const user = state.machine.users.find((entry) => entry.name.toLowerCase() === check.name.toLowerCase());
      if (!user) return { passed: false, detail: check.failureDetail ?? `Account ${check.name} does not exist.` };
      const actual = (user[check.field] ?? "") as string;
      const expected = check.field === "home" ? normalize(platform, homeFor(platform), check.equals) : check.equals;
      const passed = check.field === "home" ? normalize(platform, homeFor(platform), actual) === expected : actual === check.equals;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${check.name}'s ${check.field} is correct.`
          : check.failureDetail ?? `Expected ${check.name}'s ${check.field} to be "${check.equals}", found "${actual}".`,
      };
    }

    case "cron_matches": {
      const lines = state.machine.cron.map((entry) => `${entry.schedule} ${entry.command}`);
      const passed = lines.some((line) => testRegex(check.pattern, check.flags, line));
      return {
        passed,
        detail: passed
          ? check.successDetail ?? "Found the expected scheduled job."
          : check.failureDetail ?? `No scheduled job matches /${check.pattern}/.`,
      };
    }

    case "firewall_rule": {
      const rule = state.machine.firewall.find((entry) => entry.name.toLowerCase() === check.name.toLowerCase());
      if (!rule) {
        const expected = check.exists ?? true;
        return {
          passed: !expected,
          detail: expected
            ? check.failureDetail ?? `There is no firewall rule called "${check.name}".`
            : check.successDetail ?? `Firewall rule "${check.name}" is absent.`,
        };
      }
      const existsOk = (check.exists ?? true) === true;
      const actionOk = check.action === undefined || rule.action === check.action;
      const portOk = check.port === undefined || rule.port === check.port;
      const passed = existsOk && actionOk && portOk;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `Firewall rule "${check.name}" is configured correctly.`
          : check.failureDetail ?? `Firewall rule "${check.name}" is ${rule.action} on port ${rule.port ?? "any"}, expected ${check.action ?? "to exist"}${check.port ? ` on ${check.port}` : ""}.`,
      };
    }

    case "registry_value": {
      const normal = check.path.replace(/:\s*/g, "\\").replace(/\\+$/, "");
      const entry = state.machine.registry.find(
        (value) => value.path.toLowerCase() === normal.toLowerCase() && value.name.toLowerCase() === check.name.toLowerCase(),
      );
      if (!entry) {
        return { passed: false, detail: check.failureDetail ?? `Registry value ${check.path}\\${check.name} was not set.` };
      }
      const passed = String(entry.value).toLowerCase() === String(check.equals).toLowerCase();
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `Registry value ${check.name} is ${check.equals}.`
          : check.failureDetail ?? `Expected ${check.path}\\${check.name} to be ${check.equals}, found ${entry.value}.`,
      };
    }

    case "share_exists": {
      const share = state.machine.shares.find((entry) => entry.name.toLowerCase() === check.name.toLowerCase());
      const expected = check.exists ?? true;
      const exists = Boolean(share);
      return {
        passed: exists === expected,
        detail: exists === expected
          ? check.successDetail ?? `Share "${check.name}" is ${expected ? "present" : "absent"} as required.`
          : check.failureDetail ?? `Expected share "${check.name}" to ${expected ? "exist" : "not exist"}.`,
      };
    }

    case "hostname_equals": {
      const passed = state.machine.hostname.toLowerCase() === check.value.toLowerCase();
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `The hostname is ${check.value}.`
          : check.failureDetail ?? `Expected hostname ${check.value}, found ${state.machine.hostname}.`,
      };
    }

    case "note_matches": {
      const passed = state.machine.notes.some((note) => testRegex(check.pattern, check.flags, note));
      return {
        passed,
        detail: passed
          ? check.successDetail ?? "Your case notes record the expected finding."
          : check.failureDetail ?? `Your case notes do not mention /${check.pattern}/. Use \`note <text>\` to record your finding.`,
      };
    }

    // ---- Office ----------------------------------------------------------
    case "cell_equals": {
      const doc = findOfficeDoc(state, check.doc);
      if (!doc || doc.type !== "spreadsheet") {
        return { passed: false, detail: check.failureDetail ?? `There is no spreadsheet called "${check.doc}".` };
      }
      const sheet = pickSheet(doc, check.sheet);
      if (!sheet) return { passed: false, detail: check.failureDetail ?? `There is no sheet called "${check.sheet}".` };
      const actualText = computeCell(sheet, check.cell.toUpperCase(), doc.sheets);
      const actualNumber = computeCellNumber(sheet, check.cell.toUpperCase(), doc.sheets);
      const expectedNumber = typeof check.equals === "number" ? check.equals : Number(String(check.equals).replace(/[$,\s]/g, ""));
      const tolerance = check.tolerance ?? 0;
      const numericMatch = actualNumber !== null && !Number.isNaN(expectedNumber) && Math.abs(actualNumber - expectedNumber) <= tolerance;
      const textMatch = actualText.trim().toLowerCase() === String(check.equals).trim().toLowerCase();
      const passed = numericMatch || textMatch;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${check.cell.toUpperCase()} holds the expected value.`
          : check.failureDetail ?? `Expected ${check.cell.toUpperCase()} to be "${check.equals}", found "${actualText}".`,
      };
    }

    case "cell_formula_contains": {
      const doc = findOfficeDoc(state, check.doc);
      if (!doc || doc.type !== "spreadsheet") {
        return { passed: false, detail: check.failureDetail ?? `There is no spreadsheet called "${check.doc}".` };
      }
      const sheet = pickSheet(doc, check.sheet);
      const cell = sheet?.cells[check.cell.toUpperCase()];
      if (!cell?.f) {
        return { passed: false, detail: check.failureDetail ?? `${check.cell.toUpperCase()} does not contain a formula.` };
      }
      const passed = testRegex(check.pattern, check.flags, cell.f);
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${check.cell.toUpperCase()} uses the expected formula.`
          : check.failureDetail ?? `${check.cell.toUpperCase()} formula "${cell.f}" does not match /${check.pattern}/.`,
      };
    }

    case "cell_style": {
      const doc = findOfficeDoc(state, check.doc);
      if (!doc || doc.type !== "spreadsheet") {
        return { passed: false, detail: check.failureDetail ?? `There is no spreadsheet called "${check.doc}".` };
      }
      const sheet = pickSheet(doc, check.sheet);
      const style = sheet?.cells[check.cell.toUpperCase()]?.style ?? {};
      const mismatches: string[] = [];
      if (check.bold !== undefined && Boolean(style.bold) !== check.bold) mismatches.push("bold");
      if (check.italic !== undefined && Boolean(style.italic) !== check.italic) mismatches.push("italic");
      if (check.format !== undefined && style.format !== check.format) mismatches.push(`${check.format} number format`);
      const passed = mismatches.length === 0;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${check.cell.toUpperCase()} has the expected formatting.`
          : check.failureDetail ?? `${check.cell.toUpperCase()} is missing: ${mismatches.join(", ")}.`,
      };
    }

    case "doc_contains": {
      const doc = findOfficeDoc(state, check.doc);
      if (!doc || doc.type !== "document") {
        return { passed: false, detail: check.failureDetail ?? `There is no document called "${check.doc}".` };
      }
      const passed = testRegex(check.pattern, check.flags, documentText(doc));
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${doc.name} contains the expected text.`
          : check.failureDetail ?? `${doc.name} does not contain /${check.pattern}/.`,
      };
    }

    case "doc_heading": {
      const doc = findOfficeDoc(state, check.doc);
      if (!doc || doc.type !== "document") {
        return { passed: false, detail: check.failureDetail ?? `There is no document called "${check.doc}".` };
      }
      const headings = doc.blocks.filter(
        (block) => block.kind === "heading" && (check.level === undefined || block.level === check.level),
      );
      const passed = headings.some((block) => block.kind === "heading" && testRegex(check.pattern, check.flags, block.text));
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `${doc.name} has the expected heading.`
          : check.failureDetail ?? `No heading in ${doc.name} matches /${check.pattern}/.`,
      };
    }

    case "sheet_exists": {
      const doc = findOfficeDoc(state, check.doc);
      if (!doc || doc.type !== "spreadsheet") {
        return { passed: false, detail: check.failureDetail ?? `There is no spreadsheet called "${check.doc}".` };
      }
      const passed = doc.sheets.some((sheet) => sheet.name.toLowerCase() === check.sheet.toLowerCase());
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `Sheet "${check.sheet}" exists.`
          : check.failureDetail ?? `There is no sheet named "${check.sheet}".`,
      };
    }

    case "mail_sent": {
      const mail = findMailDoc(state);
      if (!mail) return { passed: false, detail: check.failureDetail ?? "No mailbox found in this scenario." };
      const candidates = mail.messages.filter((message) => message.folder === "sent" || message.folder === "drafts");
      const hit = candidates.find((message) => {
        const toOk = message.to.some((address) => address.toLowerCase().includes(check.to.toLowerCase()));
        const subjectOk = !check.subjectPattern || testRegex(check.subjectPattern, check.flags, message.subject);
        const bodyOk = !check.bodyPattern || testRegex(check.bodyPattern, check.flags, message.body);
        return toOk && subjectOk && bodyOk;
      });
      return {
        passed: Boolean(hit),
        detail: hit
          ? check.successDetail ?? `Sent the expected message to ${check.to}.`
          : check.failureDetail ?? `No outgoing message to "${check.to}"${check.subjectPattern ? ` with a subject matching /${check.subjectPattern}/` : ""} was found.`,
      };
    }

    case "mail_flagged": {
      const mail = findMailDoc(state);
      if (!mail) return { passed: false, detail: check.failureDetail ?? "No mailbox found in this scenario." };
      const hit = mail.messages.find((message) => testRegex(check.subjectPattern, check.flags, message.subject));
      if (!hit) {
        return { passed: false, detail: check.failureDetail ?? `No message matching /${check.subjectPattern}/ was found.` };
      }
      const passed = hit.flagged === check.flagged;
      return {
        passed,
        detail: passed
          ? check.successDetail ?? `"${hit.subject}" is correctly ${check.flagged ? "flagged" : "unflagged"}.`
          : check.failureDetail ?? `Expected "${hit.subject}" to be ${check.flagged ? "flagged for follow-up" : "unflagged"}.`,
      };
    }

    default: {
      const exhaustive: never = check;
      void exhaustive;
      return { passed: false, detail: "Unsupported check type." };
    }
  }
}

function findMailDoc(state: EngineState): MailDoc | undefined {
  return Object.values(state.office.docs).find((doc): doc is MailDoc => doc.type === "mail");
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                    */
/* -------------------------------------------------------------------------- */

export function gradeAttempt(def: ScenarioDefinition, state: EngineState, passScore = 70): GradeReport {
  const results: CheckEvaluation[] = def.checks.map((check) => {
    const outcome = evaluateCheck(check, def, state);
    const maxPoints = check.points ?? 1;
    return {
      checkId: check.id,
      label: check.label,
      kind: check.kind,
      passed: outcome.passed,
      points: outcome.passed ? maxPoints : 0,
      maxPoints,
      detail: outcome.detail,
    };
  });

  const penalty = (def.hints ?? [])
    .filter((hint) => state.meta.hintsUsed.includes(hint.id))
    .reduce((sum, hint) => sum + (hint.penalty ?? 0), 0);

  const rawScore = results.reduce((sum, result) => sum + result.points, 0);
  const maxScore = results.reduce((sum, result) => sum + result.maxPoints, 0);
  const score = Math.max(0, rawScore - penalty);
  const percent = maxScore === 0 ? 100 : Math.round((score / maxScore) * 100);

  return {
    results,
    score,
    maxScore,
    percent,
    passed: percent >= passScore,
    penalty,
  };
}

/** Convenience for the review UI: list the checks that a submission missed. */
export function missedChecks(report: GradeReport): CheckEvaluation[] {
  return report.results.filter((result) => !result.passed);
}

/** Total available points, used when authoring a new scenario. */
export function totalPoints(def: ScenarioDefinition): number {
  return def.checks.reduce((sum, check) => sum + (check.points ?? 1), 0);
}

/** Short human-readable summary of a directory, used by admin tooling. */
export function describeDirectory(platform: Platform, state: EngineState, path: string): string {
  const root = normalize(platform, homeFor(platform), path);
  const children = listDir(platform, state.vfs, root);
  return children.map((child) => `${baseName(child.path)}${child.type === "dir" ? "/" : ""}`).join("  ");
}
