/**
 * A small spreadsheet formula engine.
 *
 * Supports the functions a support-technician course actually exercises:
 * SUM, AVERAGE, COUNT, COUNTA, MIN, MAX, ROUND, IF, AND, OR, CONCAT /
 * CONCATENATE, TEXTJOIN, LEN, TRIM, UPPER, LOWER, VLOOKUP, TODAY, NOW.
 * Cell references (`B4`), absolute references (`$B$4`) and ranges (`B2:B9`)
 * all resolve against the live sheet.
 *
 * It is intentionally not a complete implementation of Excel — it is precise
 * about the subset it does support, which keeps grading deterministic.
 */

import type { Sheet } from "./types";

export class FormulaError extends Error {}

export function columnToIndex(column: string): number {
  let total = 0;
  for (const ch of column.toUpperCase()) {
    total = total * 26 + (ch.charCodeAt(0) - 64);
  }
  return total - 1;
}

export function indexToColumn(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface CellCoord {
  row: number; // 0-based
  col: number; // 0-based
}

export function parseCellRef(ref: string): CellCoord | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!match) return null;
  return { col: columnToIndex(match[1]), row: parseInt(match[2], 10) - 1 };
}

export function formatCellRef(coord: CellCoord): string {
  return `${indexToColumn(coord.col)}${coord.row + 1}`;
}

/** Values the evaluator passes around. */
type Value = number | string | boolean | null;

function toNumber(value: Value): number {
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const cleaned = value.replace(/[$,\s]/g, "").replace(/%$/, "");
  if (cleaned === "") return 0;
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function flatten(args: Value[][]): Value[] {
  return args.flat();
}

/* -------------------------------------------------------------------------- */
/*  Tokenizer / parser                                                        */
/* -------------------------------------------------------------------------- */

type Node =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "ref"; value: string }
  | { type: "range"; from: string; to: string }
  | { type: "call"; name: string; args: Node[] }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "unary"; op: string; operand: Node };

interface Token {
  type: "number" | "string" | "ident" | "op" | "lparen" | "rparen" | "comma" | "colon";
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = "";
      i += 1;
      while (i < source.length && source[i] !== '"') {
        out += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ type: "string", value: out });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      let out = "";
      while (i < source.length && /[0-9.]/.test(source[i])) {
        out += source[i];
        i += 1;
      }
      tokens.push({ type: "number", value: out });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let out = "";
      while (i < source.length && /[A-Za-z0-9_$.]/.test(source[i])) {
        out += source[i];
        i += 1;
      }
      const upper = out.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({ type: "ident", value: upper });
      } else {
        tokens.push({ type: "ident", value: out });
      }
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i += 1;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "colon", value: ch });
      i += 1;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["<=", ">=", "<>"].includes(two)) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    throw new FormulaError(`Unexpected character '${ch}'`);
  }
  return tokens;
}

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type?: Token["type"]) => {
    const token = tokens[pos];
    if (!token) throw new FormulaError("Unexpected end of formula");
    if (type && token.type !== type) throw new FormulaError(`Expected ${type} but found '${token.value}'`);
    pos += 1;
    return token;
  };

  function parseComparison(): Node {
    let left = parseConcat();
    while (peek()?.type === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(peek().value)) {
      const op = eat("op").value;
      left = { type: "binary", op, left, right: parseConcat() };
    }
    return left;
  }

  function parseConcat(): Node {
    let left = parseAdditive();
    while (peek()?.type === "op" && peek().value === "&") {
      eat("op");
      left = { type: "binary", op: "&", left, right: parseAdditive() };
    }
    return left;
  }

  function parseAdditive(): Node {
    let left = parseMultiplicative();
    while (peek()?.type === "op" && ["+", "-"].includes(peek().value)) {
      const op = eat("op").value;
      left = { type: "binary", op, left, right: parseMultiplicative() };
    }
    return left;
  }

  function parseMultiplicative(): Node {
    let left = parsePower();
    while (peek()?.type === "op" && ["*", "/"].includes(peek().value)) {
      const op = eat("op").value;
      left = { type: "binary", op, left, right: parsePower() };
    }
    return left;
  }

  function parsePower(): Node {
    const left = parseUnary();
    if (peek()?.type === "op" && peek().value === "^") {
      eat("op");
      return { type: "binary", op: "^", left, right: parsePower() };
    }
    return left;
  }

  function parseUnary(): Node {
    const token = peek();
    if (token?.type === "op" && (token.value === "-" || token.value === "+")) {
      eat("op");
      return { type: "unary", op: token.value, operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const token = peek();
    if (!token) throw new FormulaError("Unexpected end of formula");

    if (token.type === "number") {
      eat();
      return { type: "number", value: Number(token.value) };
    }
    if (token.type === "string") {
      eat();
      return { type: "string", value: token.value };
    }
    if (token.type === "lparen") {
      eat("lparen");
      const inner = parseComparison();
      eat("rparen");
      if (peek()?.type === "op" && peek().value === "%") {
        eat("op");
        return { type: "binary", op: "/", left: inner, right: { type: "number", value: 100 } };
      }
      return inner;
    }
    if (token.type === "ident") {
      eat();
      if (peek()?.type === "lparen") {
        eat("lparen");
        const args: Node[] = [];
        if (peek()?.type !== "rparen") {
          for (;;) {
            args.push(parseComparison());
            if (peek()?.type === "comma") {
              eat("comma");
              continue;
            }
            break;
          }
        }
        eat("rparen");
        return { type: "call", name: token.value.toUpperCase(), args };
      }
      const upper = token.value.toUpperCase();
      if (upper === "TRUE") return { type: "bool", value: true };
      if (upper === "FALSE") return { type: "bool", value: false };
      if (peek()?.type === "colon") {
        eat("colon");
        const to = eat("ident").value;
        return { type: "range", from: token.value, to };
      }
      return { type: "ref", value: token.value };
    }
    throw new FormulaError(`Unexpected token '${token.value}'`);
  }

  const node = parseComparison();
  if (pos < tokens.length) throw new FormulaError("Trailing input in formula");
  return node;
}

/* -------------------------------------------------------------------------- */
/*  Evaluation                                                                */
/* -------------------------------------------------------------------------- */

export interface EvalContext {
  sheet: Sheet;
  /** Resolves sheet-qualified references such as `Sheet2!A1`. */
  sheets?: Sheet[];
  /** Cycle guard for nested cell references. */
  visiting?: Set<string>;
}

function lookupRaw(sheet: Sheet, ref: string): Value | undefined {
  const coord = parseCellRef(ref);
  if (!coord) return undefined;
  const cell = sheet.cells[formatCellRef(coord)];
  if (!cell) return undefined;
  if (cell.f !== undefined && cell.f !== "") {
    return evaluateFormula(cell.f, { sheet });
  }
  if (cell.v === undefined) return undefined;
  const numeric = Number(cell.v);
  return cell.v.trim() !== "" && !Number.isNaN(numeric) ? numeric : cell.v;
}

export function evaluateFormula(formula: string, ctx: EvalContext): number | string | boolean | null {
  const source = formula.startsWith("=") ? formula.slice(1) : formula;
  const ast = parse(lex(source));
  return evaluate(ast, ctx);
}

function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.type) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "bool":
      return node.value;
    case "ref": {
      const visiting = ctx.visiting ?? new Set<string>();
      const key = node.value.toUpperCase();
      if (visiting.has(key)) throw new FormulaError("Circular reference detected");
      const next = new Set(visiting).add(key);
      const raw = lookupRaw(ctx.sheet, node.value);
      if (raw === undefined) return null;
      if (typeof raw === "string" && raw.startsWith("=")) {
        return evaluateFormula(raw, { ...ctx, visiting: next });
      }
      return raw;
    }
    case "range": {
      const from = parseCellRef(node.from);
      const to = parseCellRef(node.to);
      if (!from || !to) throw new FormulaError("Invalid range");
      const values: Value[] = [];
      const rowStart = Math.min(from.row, to.row);
      const rowEnd = Math.max(from.row, to.row);
      const colStart = Math.min(from.col, to.col);
      const colEnd = Math.max(from.col, to.col);
      for (let r = rowStart; r <= rowEnd; r += 1) {
        for (let c = colStart; c <= colEnd; c += 1) {
          const raw = lookupRaw(ctx.sheet, formatCellRef({ row: r, col: c }));
          values.push(raw === undefined ? null : raw);
        }
      }
      return values as unknown as Value;
    }
    case "unary": {
      const value = toNumber(evaluate(node.operand, ctx));
      return node.op === "-" ? -value : value;
    }
    case "binary":
      return evaluateBinary(node, ctx);
    case "call":
      return evaluateCall(node, ctx);
    default:
      throw new FormulaError("Unsupported formula");
  }
}

function compareValues(left: Value, right: Value): number {
  if (typeof left === "string" || typeof right === "string") {
    return String(left ?? "").localeCompare(String(right ?? ""));
  }
  return toNumber(left) - toNumber(right);
}

function evaluateBinary(node: Extract<Node, { type: "binary" }>, ctx: EvalContext): Value {
  const left = evaluate(node.left, ctx);
  const right = evaluate(node.right, ctx);

  switch (node.op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "^": {
      const a = toNumber(left);
      const b = toNumber(right);
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new FormulaError("#DIV/0!");
          return a / b;
        default:
          return a ** b;
      }
    }
    case "&":
      return `${left ?? ""}${right ?? ""}`;
    case "=":
      return compareValues(left, right) === 0;
    case "<>":
      return compareValues(left, right) !== 0;
    case "<":
      return compareValues(left, right) < 0;
    case ">":
      return compareValues(left, right) > 0;
    case "<=":
      return compareValues(left, right) <= 0;
    case ">=":
      return compareValues(left, right) >= 0;
    default:
      throw new FormulaError(`Unsupported operator '${node.op}'`);
  }
}

function asArray(value: Value): Value[] {
  return Array.isArray(value) ? (value as unknown as Value[]) : [value];
}

function numericArgs(node: Extract<Node, { type: "call" }>, ctx: EvalContext): number[] {
  const out: number[] = [];
  for (const arg of node.args) {
    for (const value of asArray(evaluate(arg, ctx))) {
      if (value === null || value === "") continue;
      out.push(toNumber(value));
    }
  }
  return out;
}

function evaluateCall(node: Extract<Node, { type: "call" }>, ctx: EvalContext): Value {
  const name = node.name;
  switch (name) {
    case "SUM":
      return numericArgs(node, ctx).reduce((a, b) => a + b, 0);
    case "PRODUCT":
      return numericArgs(node, ctx).reduce((a, b) => a * b, 1);
    case "AVERAGE":
    case "AVG": {
      const values = numericArgs(node, ctx);
      if (values.length === 0) throw new FormulaError("#DIV/0!");
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    case "COUNT":
      return numericArgs(node, ctx).length;
    case "COUNTA": {
      let count = 0;
      for (const arg of node.args) {
        for (const value of asArray(evaluate(arg, ctx))) {
          if (value !== null && value !== "") count += 1;
        }
      }
      return count;
    }
    case "COUNTIF": {
      if (node.args.length < 2) throw new FormulaError("COUNTIF needs two arguments");
      const range = asArray(evaluate(node.args[0], ctx));
      const criteria = evaluate(node.args[1], ctx);
      return range.filter((value) => matchesCriteria(value, criteria)).length;
    }
    case "MIN":
      return Math.min(...numericArgs(node, ctx));
    case "MAX":
      return Math.max(...numericArgs(node, ctx));
    case "ROUND": {
      const value = toNumber(evaluate(node.args[0], ctx));
      const digits = node.args[1] ? toNumber(evaluate(node.args[1], ctx)) : 0;
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    }
    case "ABS":
      return Math.abs(toNumber(evaluate(node.args[0], ctx)));
    case "INT":
      return Math.trunc(toNumber(evaluate(node.args[0], ctx)));
    case "SQRT":
      return Math.sqrt(toNumber(evaluate(node.args[0], ctx)));
    case "IF": {
      const condition = evaluate(node.args[0], ctx);
      const truthy = typeof condition === "boolean" ? condition : toNumber(condition) !== 0;
      if (truthy) return node.args[1] ? evaluate(node.args[1], ctx) : true;
      return node.args[2] ? evaluate(node.args[2], ctx) : false;
    }
    case "IFERROR": {
      try {
        return evaluate(node.args[0], ctx);
      } catch {
        return node.args[1] ? evaluate(node.args[1], ctx) : "";
      }
    }
    case "AND":
      return flatten(node.args.map((a) => asArray(evaluate(a, ctx)))).every((v) =>
        typeof v === "boolean" ? v : toNumber(v) !== 0,
      );
    case "OR":
      return flatten(node.args.map((a) => asArray(evaluate(a, ctx)))).some((v) =>
        typeof v === "boolean" ? v : toNumber(v) !== 0,
      );
    case "NOT":
      return !evaluate(node.args[0], ctx);
    case "CONCAT":
    case "CONCATENATE":
      return flatten(node.args.map((a) => asArray(evaluate(a, ctx))))
        .map((v) => (v === null ? "" : String(v)))
        .join("");
    case "TEXTJOIN": {
      const delimiter = String(evaluate(node.args[0], ctx) ?? "");
      const ignoreEmpty = Boolean(evaluate(node.args[1], ctx));
      const values = flatten(node.args.slice(2).map((a) => asArray(evaluate(a, ctx)))).map((v) =>
        v === null ? "" : String(v),
      );
      return values.filter((v) => (ignoreEmpty ? v !== "" : true)).join(delimiter);
    }
    case "LEN":
      return String(evaluate(node.args[0], ctx) ?? "").length;
    case "TRIM":
      return String(evaluate(node.args[0], ctx) ?? "").trim().replace(/\s+/g, " ");
    case "UPPER":
      return String(evaluate(node.args[0], ctx) ?? "").toUpperCase();
    case "LOWER":
      return String(evaluate(node.args[0], ctx) ?? "").toLowerCase();
    case "LEFT":
      return String(evaluate(node.args[0], ctx) ?? "").slice(0, toNumber(evaluate(node.args[1], ctx)));
    case "RIGHT": {
      const text = String(evaluate(node.args[0], ctx) ?? "");
      const count = toNumber(evaluate(node.args[1], ctx));
      return count <= 0 ? "" : text.slice(-count);
    }
    case "MID": {
      const text = String(evaluate(node.args[0], ctx) ?? "");
      const start = toNumber(evaluate(node.args[1], ctx));
      const count = toNumber(evaluate(node.args[2], ctx));
      return text.substr(Math.max(0, start - 1), count);
    }
    case "VLOOKUP": {
      const needle = evaluate(node.args[0], ctx);
      const table = asArray(evaluate(node.args[1], ctx));
      const colIndex = toNumber(evaluate(node.args[2], ctx)) - 1;
      // Reconstruct a grid from the flat range using the sheet geometry.
      const rangeArg = node.args[1];
      if (rangeArg.type !== "range") throw new FormulaError("VLOOKUP needs a range");
      const from = parseCellRef(rangeArg.from);
      const to = parseCellRef(rangeArg.to);
      if (!from || !to) throw new FormulaError("VLOOKUP range is invalid");
      const width = Math.abs(to.col - from.col) + 1;
      const rows: Value[][] = [];
      for (let i = 0; i < table.length; i += width) rows.push(table.slice(i, i + width));
      const hit = rows.find((row) => String(row[0] ?? "") === String(needle ?? ""));
      if (!hit) throw new FormulaError("#N/A");
      return hit[colIndex] ?? null;
    }
    case "TODAY": {
      const now = new Date();
      return `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
    }
    case "NOW":
      return new Date().toISOString();
    default:
      throw new FormulaError(`Unknown function '${name}'`);
  }
}

function matchesCriteria(value: Value, criteria: Value): boolean {
  if (typeof criteria === "string") {
    const match = /^(>=|<=|<>|>|<|=)?(.*)$/.exec(criteria);
    if (match) {
      const [, op = "=", operandRaw] = match;
      const operand = operandRaw.trim();
      const numericOperand = Number(operand);
      const asNumber = !Number.isNaN(numericOperand) && operand !== "";
      const left = asNumber ? toNumber(value) : String(value ?? "");
      const right = asNumber ? numericOperand : operand;
      switch (op) {
        case ">":
          return left > right;
        case "<":
          return left < right;
        case ">=":
          return left >= right;
        case "<=":
          return left <= right;
        case "<>":
          return left !== right;
        default:
          return String(value ?? "").toLowerCase() === String(right).toLowerCase();
      }
    }
  }
  return String(value ?? "") === String(criteria ?? "");
}

/** Compute a cell's display value, following formulas and references. */
export function computeCell(sheet: Sheet, ref: string, sheets?: Sheet[]): string {
  const cell = sheet.cells[ref];
  if (!cell) return "";
  if (cell.f !== undefined && cell.f !== "") {
    try {
      const value = evaluateFormula(cell.f, { sheet, sheets: sheets ?? [sheet] });
      if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
      }
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      return value === null ? "" : String(value);
    } catch (error) {
      return error instanceof FormulaError ? error.message : "#ERROR!";
    }
  }
  return cell.v ?? "";
}

/** Numeric view of a cell, or null when it is not a number. */
export function computeCellNumber(sheet: Sheet, ref: string, sheets?: Sheet[]): number | null {
  const text = computeCell(sheet, ref, sheets);
  if (text === "") return null;
  const cleaned = text.replace(/[$,\s%]/g, "");
  const value = Number(cleaned);
  return Number.isNaN(value) ? null : value;
}
