/**
 * The Office driver.
 *
 * Productivity-suite scenarios are not shell work, so this driver exposes a
 * small, discoverable command surface over a structured document model:
 *
 *   spreadsheets  `cells`, `get`, `set`, `formula`, `fill`, `select`, `format`
 *   documents     `append`, `heading`, `replace`, `insert`, `bullet`, `remove`
 *   mail          `mail list|read|send|reply|forward|flag|move`
 *
 * Every change mutates the same `OfficeState` the side panel renders, which is
 * what makes the "live document preview" next to the console possible — and
 * what the grader inspects afterwards.
 */

import { columnToIndex, computeCell, indexToColumn, parseCellRef } from "../formula";
import { createRegistry, createShell, formatRows, type CommandContext, type CommandSpec } from "../shell";
import type {
  Cell,
  CommandResult,
  EngineState,
  MailDoc,
  MailMessage,
  OfficeDoc,
  ShellDriver,
  Sheet,
  SpreadsheetDoc,
} from "../types";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0, refresh: true };
}

function bad(stderr: string, code = 1): CommandResult {
  return { stdout: "", stderr, exitCode: code };
}

function active(ctx: CommandContext): OfficeDoc | undefined {
  const name = ctx.state.office.activeDoc;
  return name ? ctx.state.office.docs[name] : undefined;
}

function docByName(state: EngineState, name: string): OfficeDoc | undefined {
  const direct = state.office.docs[name];
  if (direct) return direct;
  const lower = name.toLowerCase();
  return Object.values(state.office.docs).find(
    (doc) => doc.name.toLowerCase() === lower || doc.name.toLowerCase().startsWith(lower),
  );
}

function requireDoc<T extends OfficeDoc["type"]>(
  ctx: CommandContext,
  type: T,
): { doc: Extract<OfficeDoc, { type: T }> } | { error: CommandResult } {
  const doc = active(ctx);
  if (!doc) return { error: bad("No document is open. Run `docs` to see what is available, then `open <name>`.") };
  if (doc.type !== type) {
    return { error: bad(`The open document is a ${doc.type}. Run a command that matches it, or \`open\` another file.`) };
  }
  return { doc: doc as Extract<OfficeDoc, { type: T }> };
}

function activeSheet(doc: SpreadsheetDoc): Sheet {
  return doc.sheets[doc.activeSheet] ?? doc.sheets[0];
}

/** Parse `A1`, `$B$4`, `Sheet2!C7` into a cell reference on the right sheet. */
function resolveRef(doc: SpreadsheetDoc, raw: string): { sheet: Sheet; ref: string; error?: string } {
  const trimmed = raw.trim().replace(/\$/g, "");
  const bangIndex = trimmed.indexOf("!");
  if (bangIndex >= 0) {
    const sheetName = trimmed.slice(0, bangIndex);
    const ref = trimmed.slice(bangIndex + 1).toUpperCase();
    const sheet = doc.sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase());
    if (!sheet) return { sheet: activeSheet(doc), ref, error: `No sheet named "${sheetName}".` };
    return { sheet, ref };
  }
  return { sheet: activeSheet(doc), ref: trimmed.toUpperCase() };
}

interface Range {
  sheet: Sheet;
  refs: string[];
  error?: string;
}

function resolveRange(doc: SpreadsheetDoc, raw: string): Range {
  const parts = raw.split(":");
  if (parts.length === 1) {
    const single = resolveRef(doc, parts[0]);
    if (single.error) return { sheet: single.sheet, refs: [], error: single.error };
    if (!parseCellRef(single.ref)) return { sheet: single.sheet, refs: [], error: `"${raw}" is not a valid cell reference.` };
    return { sheet: single.sheet, refs: [single.ref] };
  }
  const from = resolveRef(doc, parts[0]);
  const to = resolveRef(doc, parts[1]);
  const a = parseCellRef(from.ref);
  const b = parseCellRef(to.ref);
  if (!a || !b) return { sheet: from.sheet, refs: [], error: `"${raw}" is not a valid range.` };
  const refs: string[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row += 1) {
    for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col += 1) {
      refs.push(`${indexToColumn(col)}${row + 1}`);
    }
  }
  return { sheet: from.sheet, refs };
}

/** `key=value` parser used by the mail commands. */
function pairs(args: string[]): { values: Map<string, string>; positional: string[] } {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of args) {
    const match = /^(--?)?([A-Za-z][\w-]*)=(.*)$/.exec(arg);
    if (match) {
      values.set(match[2].toLowerCase(), match[3].replace(/^["']|["']$/g, ""));
      continue;
    }
    positional.push(arg);
  }
  return { values, positional };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** Escape a literal string so it can be embedded in a `RegExp`. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMail(doc: MailDoc, id: string): MailMessage | undefined {
  return doc.messages.find((message) => message.id === id || message.subject.toLowerCase().includes(id.toLowerCase()));
}

let mailCounter = 0;
function nextMailId(): string {
  mailCounter += 1;
  return `M${1000 + mailCounter}`;
}

/* -------------------------------------------------------------------------- */
/*  Document navigation                                                       */
/* -------------------------------------------------------------------------- */

const docsCmd: CommandSpec = {
  name: "docs",
  aliases: ["files", "ls", "dir"],
  summary: "list the documents available in this scenario",
  run(ctx) {
    const entries = Object.values(ctx.state.office.docs);
    if (entries.length === 0) return ok("No documents in this scenario.");
    const rows: string[][] = [["Open", "Type", "Name", "Location"], ["----", "----", "----", "--------"]];
    for (const doc of entries) {
      rows.push([ctx.state.office.activeDoc === doc.name ? "*" : "", doc.type, doc.name, doc.location]);
    }
    return ok(formatRows(rows));
  },
};

const openCmd: CommandSpec = {
  name: "open",
  aliases: ["edit", "use"],
  summary: "open a document so other commands act on it",
  run(ctx) {
    const name = ctx.args.join(" ");
    if (!name) return bad("open: name a document, e.g. `open Q3 Budget.xlsx`");
    const doc = docByName(ctx.state, unquote(name));
    if (!doc) return bad(`open: no such document "${name}". Run \`docs\` for the list.`);
    ctx.state.office.activeDoc = doc.name;
    return ok(`Opened ${doc.name} (${doc.type}).`);
  },
};

const helpCmd: CommandSpec = {
  name: "help",
  aliases: ["man", "?"],
  summary: "show the available commands",
  run(_ctx, registry) {
    const groups: Record<string, string[]> = {
      Navigation: ["docs", "open"],
      Spreadsheet: ["cells", "get", "set", "formula", "clear", "fill", "select", "addsheet", "renamesheet", "format"],
      Document: ["show", "append", "heading", "bullet", "insert", "replace", "remove"],
      Mail: ["mail"],
      Notes: ["note", "notes"],
    };
    const lines = ["Office simulator — command reference", ""];
    for (const [group, names] of Object.entries(groups)) {
      lines.push(`${group}:`);
      for (const name of names) {
        const spec = registry.get(name);
        if (spec) lines.push(`  ${spec.name.padEnd(12)} ${spec.summary ?? ""}`);
      }
      lines.push("");
    }
    lines.push("Values: `set B2 1500`, `set A1 Total revenue`, `formula C2 =SUM(B2:B9)`");
    return ok(lines.join("\n"));
  },
};

/* -------------------------------------------------------------------------- */
/*  Spreadsheet                                                               */
/* -------------------------------------------------------------------------- */

const cellsCmd: CommandSpec = {
  name: "cells",
  aliases: ["grid", "view", "sheet"],
  summary: "print a grid of the active sheet",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const sheet = activeSheet(doc);
    const range = ctx.args[0] ? resolveRange(doc, ctx.args[0]) : null;
    if (range?.error) return bad(range.error);

    const used = Object.keys(sheet.cells).map((ref) => parseCellRef(ref)).filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
    const maxRow = range ? Math.max(...range.refs.map((r) => parseCellRef(r)?.row ?? 0)) : Math.max(4, ...used.map((u) => u.row));
    const maxCol = range ? Math.max(...range.refs.map((r) => parseCellRef(r)?.col ?? 0)) : Math.max(3, ...used.map((u) => u.col));

    const header = ["", ...Array.from({ length: maxCol + 1 }, (_, i) => indexToColumn(i))];
    const rows: string[][] = [header];
    for (let row = 0; row <= Math.min(maxRow, 60); row += 1) {
      const line = [String(row + 1)];
      for (let col = 0; col <= Math.min(maxCol, 20); col += 1) {
        line.push(computeCell(sheet, `${indexToColumn(col)}${row + 1}`, doc.sheets));
      }
      rows.push(line);
    }
    return ok(
      [
        `${doc.name} — sheet "${sheet.name}"`,
        "",
        formatRows(rows),
        "",
        "Tip: `get B2` or `set B2 1500` to work with a specific cell.",
      ].join("\n"),
    );
  },
};

const getCmd: CommandSpec = {
  name: "get",
  aliases: ["show-cell", "value"],
  summary: "read one cell (formulas are evaluated)",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const target = ctx.args[0];
    if (!target) return bad("get: name a cell, e.g. `get B2`");
    const { sheet, ref, error } = resolveRef(doc, target);
    if (error) return bad(error);
    const cell = sheet.cells[ref];
    if (!cell) return ok(`${ref} is empty.`);
    const value = computeCell(sheet, ref, doc.sheets);
    return ok(cell.f ? `${ref} = ${value}   [formula: =${cell.f}]` : `${ref} = ${value}`);
  },
};

const setCmd: CommandSpec = {
  name: "set",
  aliases: ["put", "type"],
  summary: "set a cell to a literal value or a formula",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [target, ...rest] = ctx.args;
    if (!target) return bad("set: use `set B2 1500`");
    const value = unquote(rest.join(" "));
    if (rest.length === 0) return bad("set: no value given");
    const { sheet, ref, error } = resolveRef(doc, target);
    if (error) return bad(error);
    if (!parseCellRef(ref)) return bad(`set: "${target}" is not a valid cell reference.`);

    if (value.startsWith("=")) {
      sheet.cells[ref] = { ...sheet.cells[ref], f: value.slice(1), v: undefined };
      return ok(`${ref} = ${computeCell(sheet, ref, doc.sheets)}   [formula: =${value.slice(1)}]`);
    }
    sheet.cells[ref] = { ...sheet.cells[ref], v: value, f: undefined };
    return ok(`${ref} = ${value}`);
  },
};

const formulaCmd: CommandSpec = {
  name: "formula",
  aliases: ["calc", "fx"],
  summary: "put a formula in a cell",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [target, ...rest] = ctx.args;
    if (!target) return bad("formula: use `formula C2 =SUM(B2:B9)`");
    const expression = unquote(rest.join(" ")).replace(/^=/, "");
    if (!expression) return bad("formula: no expression given");
    const { sheet, ref, error } = resolveRef(doc, target);
    if (error) return bad(error);
    if (!parseCellRef(ref)) return bad(`formula: "${target}" is not a valid cell reference.`);
    sheet.cells[ref] = { f: expression, style: sheet.cells[ref]?.style };
    const evaluated = computeCell(sheet, ref, doc.sheets);
    if (evaluated.startsWith("#") || /circular/i.test(evaluated)) {
      return bad(`formula error in ${ref}: ${evaluated}`);
    }
    return ok(`${ref} = ${evaluated}   [formula: =${expression}]`);
  },
};

const clearCmd: CommandSpec = {
  name: "clear",
  aliases: ["delete-cell", "erase"],
  summary: "clear a cell or range",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const target = ctx.args[0];
    if (!target) return bad("clear: name a cell or range, e.g. `clear A1:C4`");
    const range = resolveRange(doc, target);
    if (range.error) return bad(range.error);
    for (const ref of range.refs) delete range.sheet.cells[ref];
    return ok(`Cleared ${range.refs.length} cell(s).`);
  },
};

const fillCmd: CommandSpec = {
  name: "fill",
  aliases: ["autofill"],
  summary: "fill a range down with a value or formula",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [target, ...rest] = ctx.args;
    if (!target) return bad("fill: use `fill B2:B20 0`");
    const value = unquote(rest.join(" "));
    const range = resolveRange(doc, target);
    if (range.error) return bad(range.error);
    // A trailing `=` extends the formula at the top of the range downward.
    const top = range.refs[0];
    const template = range.sheet.cells[top];
    for (const ref of range.refs) {
      if (value === "=" && template?.f) {
        const shifted = shiftFormula(template.f, ref, top);
        range.sheet.cells[ref] = { f: shifted, style: template.style };
      } else if (value.startsWith("=")) {
        range.sheet.cells[ref] = { f: value.slice(1), style: range.sheet.cells[ref]?.style };
      } else {
        range.sheet.cells[ref] = { ...range.sheet.cells[ref], v: value, f: undefined };
      }
    }
    return ok(`Filled ${range.refs.length} cell(s) in ${range.sheet.name}.`);
  },
};

/** Shift relative references in a formula as it is copied from `from` to `to`. */
function shiftFormula(formula: string, to: string, from: string): string {
  const target = parseCellRef(to);
  const origin = parseCellRef(from);
  if (!target || !origin) return formula;
  const rowDelta = target.row - origin.row;
  const colDelta = target.col - origin.col;
  return formula.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g, (match, colAbs: string, col: string, rowAbs: string, row: string) => {
    const nextCol = colAbs ? col : indexToColumn(columnToIndex(col) + colDelta);
    const nextRow = rowAbs ? row : String(Number(row) + rowDelta);
    return `${colAbs}${nextCol}${rowAbs}${nextRow}`;
  });
}

const selectCmd: CommandSpec = {
  name: "select",
  aliases: ["switch-sheet"],
  summary: "choose the active worksheet",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const name = ctx.args.join(" ");
    if (!name) return bad(`select: name a sheet. Available: ${doc.sheets.map((s) => s.name).join(", ")}`);
    const index = doc.sheets.findIndex((sheet) => sheet.name.toLowerCase() === unquote(name).toLowerCase());
    if (index < 0) return bad(`select: no sheet named "${name}". Available: ${doc.sheets.map((s) => s.name).join(", ")}`);
    doc.activeSheet = index;
    return ok(`Active sheet is now "${doc.sheets[index].name}".`);
  },
};

const addSheetCmd: CommandSpec = {
  name: "addsheet",
  aliases: ["newsheet"],
  summary: "add a worksheet",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const name = unquote(ctx.args.join(" "));
    if (!name) return bad("addsheet: name the new sheet");
    if (doc.sheets.some((sheet) => sheet.name.toLowerCase() === name.toLowerCase())) {
      return bad(`addsheet: a sheet named "${name}" already exists.`);
    }
    doc.sheets.push({ name, cells: {} });
    doc.activeSheet = doc.sheets.length - 1;
    return ok(`Added sheet "${name}".`);
  },
};

const renameSheetCmd: CommandSpec = {
  name: "renamesheet",
  summary: "rename a worksheet",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [from, to] = ctx.args;
    if (!from || !to) return bad("renamesheet: use `renamesheet Sheet1 Summary`");
    const sheet = doc.sheets.find((s) => s.name.toLowerCase() === unquote(from).toLowerCase());
    if (!sheet) return bad(`renamesheet: no sheet named "${from}".`);
    sheet.name = unquote(to);
    return ok(`Renamed sheet to "${sheet.name}".`);
  },
};

const formatCmd: CommandSpec = {
  name: "format",
  aliases: ["style"],
  summary: "apply formatting to a range",
  run(ctx) {
    const result = requireDoc(ctx, "spreadsheet");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [target, ...styles] = ctx.args;
    if (!target || styles.length === 0) return bad("format: use `format B2:B20 currency` or `format A1 bold`");
    const range = resolveRange(doc, target);
    if (range.error) return bad(range.error);
    for (const ref of range.refs) {
      const cell: Cell = range.sheet.cells[ref] ?? {};
      for (const style of styles) {
        const key = style.toLowerCase();
        if (key === "bold" || key === "italic") cell.style = { ...cell.style, [key]: true };
        else if (["text", "number", "currency", "percent", "date"].includes(key)) {
          cell.style = { ...cell.style, format: key as NonNullable<Cell["style"]>["format"] };
        } else if (key.startsWith("fill:")) {
          cell.style = { ...cell.style, fill: key.slice(5) };
        } else if (key.startsWith("nobold")) {
          cell.style = { ...cell.style, bold: false };
        } else {
          return bad(`format: unknown style "${style}".`);
        }
      }
      range.sheet.cells[ref] = cell;
    }
    return ok(`Applied ${styles.join(", ")} to ${range.refs.length} cell(s).`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Word-processing documents                                                 */
/* -------------------------------------------------------------------------- */

const showDocCmd: CommandSpec = {
  name: "show",
  aliases: ["read", "body", "paragraphs"],
  summary: "print the document body with line numbers",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    if (doc.blocks.length === 0) return ok(`${doc.name} is empty. Use \`append <text>\` to start writing.`);
    const lines = doc.blocks.map((block, index) => {
      const label = `${index}`.padStart(3);
      switch (block.kind) {
        case "heading":
          return `${label}  ${"#".repeat(block.level)} ${block.text}`;
        case "paragraph":
          return `${label}  ${block.text}`;
        case "list":
          return `${label}  ${block.items.map((item) => `• ${item}`).join("\n     ")}`;
        default:
          return `${label}  [table ${block.rows.length}x${block.rows[0]?.length ?? 0}]`;
      }
    });
    return ok([`${doc.name} (${doc.blocks.length} blocks)`, "", ...lines].join("\n"));
  },
};

const appendCmd: CommandSpec = {
  name: "append",
  aliases: ["add", "paragraph", "write", "type"],
  summary: "append a paragraph",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const text = unquote(ctx.args.join(" "));
    if (!text) return bad("append: give some text, e.g. `append Escalate to tier 2 if unresolved.`");
    doc.blocks.push({ kind: "paragraph", text });
    return ok(`Added paragraph at position ${doc.blocks.length - 1}.`);
  },
};

const headingCmd: CommandSpec = {
  name: "heading",
  aliases: ["title", "h1"],
  summary: "append a heading",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const levelArg = ctx.args[0]?.match(/^h?([1-6])$/i);
    const level = levelArg ? Number(levelArg[1]) : 1;
    const text = unquote((levelArg ? ctx.args.slice(1) : ctx.args).join(" "));
    if (!text) return bad("heading: give the heading text");
    doc.blocks.push({ kind: "heading", text, level });
    return ok(`Added heading "${text}" (level ${level}).`);
  },
};

const bulletCmd: CommandSpec = {
  name: "bullet",
  aliases: ["li", "list-item"],
  summary: "append a bullet list item",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const text = unquote(ctx.args.join(" "));
    if (!text) return bad("bullet: give the item text");
    const last = doc.blocks[doc.blocks.length - 1];
    if (last?.kind === "list") last.items.push(text);
    else doc.blocks.push({ kind: "list", items: [text] });
    return ok(`Added bullet "${text}".`);
  },
};

const insertCmd: CommandSpec = {
  name: "insert",
  summary: "insert a paragraph before an existing block",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const index = Number(ctx.args[0]);
    const text = unquote(ctx.args.slice(1).join(" "));
    if (Number.isNaN(index)) return bad("insert: use `insert 2 <text>`");
    if (!text) return bad("insert: give the text to insert");
    if (index < 0 || index > doc.blocks.length) return bad(`insert: position must be between 0 and ${doc.blocks.length}.`);
    doc.blocks.splice(index, 0, { kind: "paragraph", text });
    return ok(`Inserted paragraph at position ${index}.`);
  },
};

const replaceCmd: CommandSpec = {
  name: "replace",
  aliases: ["sub", "find-replace"],
  summary: "find and replace text throughout the document",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [needle, ...replacementParts] = ctx.args;
    if (!needle || replacementParts.length === 0) return bad("replace: use `replace old new`");
    const replacement = unquote(replacementParts.join(" "));
    const target = unquote(needle);
    let count = 0;
    const walk = (text: string): string => {
      if (!text.toLowerCase().includes(target.toLowerCase())) return text;
      count += (text.toLowerCase().match(new RegExp(escapeRegex(target.toLowerCase()), "g")) ?? []).length;
      return text.replace(new RegExp(escapeRegex(target), "gi"), replacement);
    };
    doc.blocks = doc.blocks.map((block) => {
      if (block.kind === "paragraph" || block.kind === "heading") return { ...block, text: walk(block.text) };
      if (block.kind === "list") return { ...block, items: block.items.map(walk) };
      return { ...block, rows: block.rows.map((row) => row.map(walk)) };
    });
    if (count === 0) return bad(`replace: "${target}" was not found in ${doc.name}.`);
    return ok(`Replaced ${count} occurrence(s) of "${target}".`);
  },
};

const removeBlockCmd: CommandSpec = {
  name: "remove",
  aliases: ["del-paragraph"],
  summary: "delete a block by its line number",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const index = Number(ctx.args[0]);
    if (Number.isNaN(index) || index < 0 || index >= doc.blocks.length) {
      return bad(`remove: give a block number between 0 and ${Math.max(0, doc.blocks.length - 1)}.`);
    }
    const [removed] = doc.blocks.splice(index, 1);
    return ok(`Removed block ${index} (${removed.kind}).`);
  },
};

const tableCmd: CommandSpec = {
  name: "table",
  summary: "append a table parsed from pipe-separated rows",
  run(ctx) {
    const result = requireDoc(ctx, "document");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const raw = unquote(ctx.args.join(" "));
    if (!raw) return bad("table: pass rows as `table Header A | Header B ; value 1 | value 2`");
    const rows = raw.split(";").map((row) => row.split("|").map((cell) => cell.trim()));
    doc.blocks.push({ kind: "table", rows, header: true });
    return ok(`Added a ${rows.length}-row table.`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Mail                                                                      */
/* -------------------------------------------------------------------------- */

const mailCmd: CommandSpec = {
  name: "mail",
  aliases: ["mails", "inbox", "email"],
  summary: "list, read, send, reply to and organize mail",
  run(ctx) {
    const result = requireDoc(ctx, "mail");
    if ("error" in result) return result.error;
    const doc = result.doc;
    const [action = "list", ...rest] = ctx.args;
    const { values, positional } = pairs(rest);

    switch (action.toLowerCase()) {
      case "list":
      case "ls": {
        const folder = (values.get("folder") ?? positional[0] ?? "inbox").toLowerCase() as MailMessage["folder"];
        const messages = doc.messages.filter((message) => message.folder === folder);
        if (messages.length === 0) return ok(`No messages in ${folder}.`);
        const rows: string[][] = [["", "ID", "From", "Received", "Subject"], ["", "--", "----", "--------", "-------"]];
        for (const message of messages) {
          rows.push([
            message.flagged ? "!" : message.read ? "" : "•",
            message.id,
            message.from,
            new Date(message.at).toISOString().slice(0, 16).replace("T", " "),
            message.subject,
          ]);
        }
        return ok([`${ctx.state.office.user.email} — ${folder}`, "", formatRows(rows)].join("\n"));
      }
      case "read":
      case "open": {
        const message = findMail(doc, positional[0] ?? values.get("id") ?? "");
        if (!message) return bad(`mail read: no message matching "${positional[0] ?? values.get("id") ?? ""}".`);
        message.read = true;
        return ok(
          [
            `From:    ${message.from}`,
            `To:      ${message.to.join("; ")}`,
            message.cc?.length ? `Cc:      ${message.cc.join("; ")}` : "",
            `Subject: ${message.subject}`,
            `Flagged: ${message.flagged ? "yes" : "no"}`,
            "",
            message.body,
            message.attachments?.length ? `\nAttachments: ${message.attachments.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
      case "send": {
        const to = values.get("to") ?? positional[0];
        const subject = values.get("subject") ?? "No subject";
        const body = values.get("body") ?? positional.slice(1).join(" ") ?? "";
        if (!to) return bad('mail send: specify a recipient, e.g. `mail send to=it@ontrak.local subject="Ticket #4471" body="..."`');
        const message: MailMessage = {
          id: nextMailId(),
          from: ctx.state.office.user.email,
          to: to.split(/[;,]/).map((a) => a.trim()),
          cc: values.get("cc")?.split(/[;,]/).map((a) => a.trim()),
          subject,
          body,
          at: Date.now(),
          read: true,
          flagged: values.get("flag") === "true",
          folder: "sent",
          attachments: values.get("attach")?.split(","),
        };
        doc.messages.push(message);
        return ok(`Message sent to ${message.to.join(", ")} (id ${message.id}).`);
      }
      case "reply": {
        const original = findMail(doc, positional[0] ?? values.get("id") ?? "");
        if (!original) return bad("mail reply: name the message to reply to.");
        const body = values.get("body") ?? positional.slice(1).join(" ");
        if (!body) return bad("mail reply: include body=...");
        const message: MailMessage = {
          id: nextMailId(),
          from: ctx.state.office.user.email,
          to: [original.from],
          subject: original.subject.startsWith("RE:") ? original.subject : `RE: ${original.subject}`,
          body,
          at: Date.now(),
          read: true,
          flagged: false,
          folder: "sent",
        };
        doc.messages.push(message);
        return ok(`Reply sent to ${original.from} (id ${message.id}).`);
      }
      case "forward": {
        const original = findMail(doc, positional[0] ?? "");
        if (!original) return bad("mail forward: name the message to forward.");
        const to = values.get("to") ?? positional[1];
        if (!to) return bad("mail forward: include to=...");
        const message: MailMessage = {
          id: nextMailId(),
          from: ctx.state.office.user.email,
          to: to.split(/[;,]/).map((a) => a.trim()),
          subject: original.subject.startsWith("FW:") ? original.subject : `FW: ${original.subject}`,
          body: values.get("body") ?? `Forwarding for your attention.\n\n--- Original message ---\n${original.body}`,
          at: Date.now(),
          read: true,
          flagged: false,
          folder: "sent",
        };
        doc.messages.push(message);
        return ok(`Forwarded to ${message.to.join(", ")} (id ${message.id}).`);
      }
      case "flag":
      case "unflag": {
        const message = findMail(doc, positional[0] ?? "");
        if (!message) return bad(`mail ${action}: no message matching "${positional[0] ?? ""}".`);
        message.flagged = action.toLowerCase() === "flag";
        return ok(`Message ${message.id} ${message.flagged ? "flagged" : "unflagged"}.`);
      }
      case "mark": {
        const message = findMail(doc, positional[0] ?? "");
        if (!message) return bad("mail mark: no matching message.");
        message.read = (positional[1] ?? "read").toLowerCase() !== "unread";
        return ok(`Message ${message.id} marked ${message.read ? "read" : "unread"}.`);
      }
      case "move":
      case "archive": {
        const message = findMail(doc, positional[0] ?? "");
        if (!message) return bad("mail move: no matching message.");
        const folder = (action.toLowerCase() === "archive" ? "archive" : positional[1] ?? "archive") as MailMessage["folder"];
        if (!["inbox", "sent", "drafts", "archive"].includes(folder)) {
          return bad("mail move: folder must be one of inbox, sent, drafts, archive.");
        }
        message.folder = folder;
        return ok(`Message ${message.id} moved to ${folder}.`);
      }
      default:
        return bad(`mail: unknown action "${action}". Try list, read, send, reply, forward, flag, move.`);
    }
  },
};

/* -------------------------------------------------------------------------- */
/*  Notes                                                                     */
/* -------------------------------------------------------------------------- */

const noteCmd: CommandSpec = {
  name: "note",
  aliases: ["remark"],
  summary: "record a finding in your case notes",
  run(ctx) {
    const text = unquote(ctx.args.join(" "));
    if (!text) return bad("note: write something, e.g. `note Root cause: mailbox quota exceeded`");
    ctx.state.machine.notes.push(text);
    return ok(`Noted (${ctx.state.machine.notes.length} entries).`);
  },
};

const notesCmd: CommandSpec = {
  name: "notes",
  aliases: ["my-notes"],
  summary: "review your case notes",
  run(ctx) {
    if (ctx.state.machine.notes.length === 0) return ok("No notes yet. Use `note <text>` to record a finding.");
    return ok(ctx.state.machine.notes.map((note, index) => `${index + 1}. ${note}`).join("\n"));
  },
};

/* -------------------------------------------------------------------------- */
/*  Registry                                                                  */
/* -------------------------------------------------------------------------- */

export const officeCommands: CommandSpec[] = [
  helpCmd,
  docsCmd,
  openCmd,
  cellsCmd,
  getCmd,
  setCmd,
  formulaCmd,
  clearCmd,
  fillCmd,
  selectCmd,
  addSheetCmd,
  renameSheetCmd,
  formatCmd,
  showDocCmd,
  appendCmd,
  headingCmd,
  bulletCmd,
  insertCmd,
  replaceCmd,
  removeBlockCmd,
  tableCmd,
  mailCmd,
  noteCmd,
  notesCmd,
];

export function createOfficeDriver(): ShellDriver {
  const registry = createRegistry(officeCommands);
  let cachedState: EngineState | undefined;
  let shell: ReturnType<typeof createShell> | undefined;

  return {
    id: "office",
    platform: "OFFICE",
    banner() {
      return [
        "Office simulator ready.",
        "",
        "Type `docs` to list the files in this scenario, then `open <name>`.",
        "Type `help` for the full command reference.",
      ].join("\n");
    },
    prompt(state) {
      const name = state.office.activeDoc ?? "no document";
      return `${name}> `;
    },
    run(input, state) {
      if (!shell || cachedState !== state) {
        cachedState = state;
        shell = createShell({ platform: "OFFICE", state, commands: registry, user: state.office.user.name });
      }
      return shell.run(input);
    },
    completions() {
      return officeCommands.flatMap((command) => [command.name, ...(command.aliases ?? [])]).sort();
    },
  };
}

export const officeRegistry = () => createRegistry(officeCommands);
export const officeCommandNames = () => officeCommands.map((command) => command.name);
