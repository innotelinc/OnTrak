/**
 * How the CLI looks.
 *
 * The console's whole argument is that an agent's work should be visible while
 * it happens; this is that argument in a terminal. Four things carry it:
 *
 *   - **Streamed text**, printed as it arrives rather than after the turn, so a
 *     long answer is readable while it is still being written.
 *   - **Tool cards** — a call, its arguments summarized to one line, and its
 *     result, so a turn reads as a sequence of decisions rather than a wall of
 *     output.
 *   - **A live diff** for the file a call is about to change, coloured add/del,
 *     printed *before* the result is used — the same promise the browser pane
 *     makes.
 *   - **A gate** that stops the turn and asks, rendered so a person can answer
 *     without leaving the keyboard.
 *
 * Everything degrades: with no colour (a pipe, `NO_COLOR`) the same lines are
 * emitted as plain text, and with no TTY the spinner is a single line rather
 * than a repainting one, because a spinner control code in a log file is noise.
 */

import type { AgentEvent } from "../agent.js";
import type { DiffLine, FileDiff } from "../diff.js";

export interface RenderOptions {
  color?: boolean;
  width?: number;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  underline: "\u001b[4m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  brightGreen: "\u001b[92m",
  brightRed: "\u001b[91m",
  brightYellow: "\u001b[93m",
  brightCyan: "\u001b[96m",
} as const;

type Code = keyof typeof ANSI;

/** Whether colour is worth emitting. `NO_COLOR` wins; `FORCE_COLOR` overrides a pipe. */
export function supportsColor(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

export function terminalWidth(fallback = 100): number {
  const columns = process.stdout.columns;
  if (typeof columns === "number" && columns >= 40) return columns;
  return fallback;
}

/** Greedy wrap that keeps existing newlines. Long words are left unbroken. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export class Theme {
  constructor(private readonly enabled: boolean) {}

  get on(): boolean {
    return this.enabled;
  }

  paint(code: Code, text: string): string {
    if (!this.enabled) return text;
    return `${ANSI[code]}${text}${ANSI.reset}`;
  }

  bold(text: string): string {
    return this.paint("bold", text);
  }
  dim(text: string): string {
    return this.paint("dim", text);
  }
  green(text: string): string {
    return this.paint("green", text);
  }
  red(text: string): string {
    return this.paint("red", text);
  }
  yellow(text: string): string {
    return this.paint("yellow", text);
  }
  cyan(text: string): string {
    return this.paint("cyan", text);
  }
  magenta(text: string): string {
    return this.paint("magenta", text);
  }
  gray(text: string): string {
    return this.paint("gray", text);
  }
}

/** A one-line summary of a tool call's arguments, for the card header. */
export function summarizeArgs(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    return null;
  };
  // The names are the ones `tools.ts` defines; a card headed by the wrong field
  // is worse than no summary at all, so they are pinned by a test.
  switch (name) {
    case "run_command":
      return pick("command") ?? "";
    case "read_file":
    case "write_file":
    case "edit_file":
      return pick("path") ?? "";
    case "list_dir":
      return pick("path") ?? ".";
    case "search_code":
      return [pick("pattern") ?? "", pick("path") ?? ""].filter(Boolean).join("  in ");
    default: {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          parts.push(`${key}=${String(value)}`);
        }
        if (parts.length >= 3) break;
      }
      return parts.join(" ");
    }
  }
}

function firstLine(text: string, max = 200): string {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? text;
  const flat = line.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The card header for a tool call: `◆ edit  src/app.ts`. */
export function renderToolCall(theme: Theme, event: Extract<AgentEvent, { type: "tool_call" }>): string {
  const summary = summarizeArgs(event.name, event.args);
  const head = `${theme.paint("brightCyan", "◆")} ${theme.bold(event.name)}`;
  return summary === "" ? head : `${head}  ${theme.gray(summary)}`;
}

/** The card footer for a result: ok/denied plus the first useful line. */
export function renderToolResult(
  theme: Theme,
  event: Extract<AgentEvent, { type: "tool_result" }>,
  width: number,
): string[] {
  const mark = event.ok ? theme.green("✓") : theme.red("✗");
  const body = firstLine(event.content, Math.max(40, width - 6));
  const lines = [`  ${mark} ${event.ok ? "" : theme.red("failed")}${event.ok ? "" : " "}${theme.gray(body)}`.trimEnd()];
  if (event.diff) lines.push(...renderDiff(theme, event.diff, width, 1));
  return lines;
}

/** A colourised unified diff, indented for nesting inside a card. */
export function renderDiff(theme: Theme, diff: FileDiff, width: number, indent = 0): string[] {
  const pad = " ".repeat(indent);
  const header =
    `${pad}${theme.bold(diff.path)} ` +
    `${theme.green(`+${diff.added}`)} ${theme.red(`-${diff.removed}`)}` +
    (diff.created ? ` ${theme.cyan("(new file)")}` : "");
  const lines = [header];
  const gutter = (line: DiffLine): string => {
    const oldNo = line.oldLine === null ? "" : String(line.oldLine);
    const newNo = line.newLine === null ? "" : String(line.newLine);
    return `${oldNo.padStart(4)} ${newNo.padStart(4)}`;
  };
  for (const hunk of diff.hunks) {
    lines.push(`${pad}${theme.gray(`@@ -${hunk.oldStart} +${hunk.newStart} @@`)}`);
    for (const line of hunk.lines) {
      const text = clip(line.text, Math.max(20, width - pad.length - 10));
      const gutterText = theme.gray(gutter(line));
      if (line.type === "add") lines.push(`${pad}${gutterText} ${theme.paint("brightGreen", `+${text}`)}`);
      else if (line.type === "del") lines.push(`${pad}${gutterText} ${theme.paint("brightRed", `-${text}`)}`);
      else lines.push(`${pad}${gutterText} ${theme.gray(` ${text}`)}`);
    }
  }
  if (diff.truncated) lines.push(`${pad}${theme.yellow("… diff truncated by the server")}`);
  return lines;
}

/** The approval box: what is being asked, and the diff if there is one. */
export function renderApproval(
  theme: Theme,
  event: Extract<AgentEvent, { type: "approval_request" }>,
  width: number,
): string[] {
  const inner = Math.max(30, width - 4);
  const top = theme.paint("brightYellow", `┌─ ${event.name} ${"─".repeat(Math.max(0, inner - event.name.length - 4))}┐`);
  const lines = [top];
  for (const part of wrap(event.summary, inner - 2)) {
    lines.push(`${theme.paint("brightYellow", "│")} ${part}`);
  }
  if (event.diff) {
    lines.push(`${theme.paint("brightYellow", "│")}`);
    for (const line of renderDiff(theme, event.diff, width, 2)) lines.push(`${theme.paint("brightYellow", "│")}${line.slice(1)}`);
  }
  lines.push(theme.paint("brightYellow", `└${"─".repeat(inner)}┘`));
  return lines;
}

export function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * A markdown-ish streamer for assistant text.
 *
 * The model writes markdown; a terminal shows it literally, so `**bold**` and
 * `` `code` `` arrive as punctuation and fenced blocks lose their framing. This
 * keeps just enough state — whether it is inside a fence — to render code
 * blocks as indented, dimmed blocks and inline code as its bare content, and
 * emits complete lines as they are completed so the text still streams.
 *
 * It deliberately does **not** buffer the whole answer: only the trailing,
 * not-yet-newline-terminated line is held, which is what keeps the output live.
 */
export class MarkdownStream {
  private buffer = "";
  private inFence = false;
  private wroteAnything = false;

  constructor(
    private readonly theme: Theme,
    private readonly write: (text: string) => void,
  ) {}

  get started(): boolean {
    return this.wroteAnything;
  }

  push(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Flush the trailing partial line. Safe to call once, at the end of a turn. */
  end(): void {
    if (this.buffer !== "") {
      this.line(this.buffer);
      this.buffer = "";
    }
    if (this.inFence) {
      this.write("\n");
      this.inFence = false;
    }
  }

  private line(raw: string): void {
    this.wroteAnything = true;
    const fence = /^\s*```/.test(raw);
    if (fence) {
      this.inFence = !this.inFence;
      const language = raw.replace(/^\s*```/, "").trim();
      if (this.inFence && language !== "") this.write(`${this.theme.gray(`  ┌ ${language}`)}\n`);
      else if (!this.inFence) this.write(`${this.theme.gray("  └")}\n`);
      return;
    }
    if (this.inFence) {
      this.write(`${this.theme.gray("  │ ")}${this.theme.dim(raw)}\n`);
      return;
    }
    this.write(`${inlineFormat(this.theme, raw)}\n`);
  }
}

/** Bold, inline code and headings, applied to one already-complete line. */
export function inlineFormat(theme: Theme, line: string): string {
  if (line.startsWith("# ")) return theme.bold(line.slice(2));
  if (line.startsWith("## ")) return theme.bold(line.slice(3));
  if (line.startsWith("### ")) return theme.cyan(line.slice(4));
  if (/^\s*[-*] /.test(line)) return line.replace(/^(\s*)([-*]) /, (_m, space: string) => `${space}${theme.cyan("•")} `);
  let out = line;
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => theme.cyan(code));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => theme.bold(bold));
  return out;
}

/**
 * One repainting line while something is in flight.
 *
 * With no TTY it prints once and stays quiet, because the control characters
 * that make a spinner pleasant in a terminal make a log file unreadable.
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private active = false;
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(
    private readonly theme: Theme,
    private readonly isTty: boolean,
    private readonly write: (text: string) => void = (text) => process.stderr.write(text),
  ) {}

  start(label: string): void {
    if (this.active) return;
    this.active = true;
    if (!this.isTty) return;
    if (!this.theme.on) {
      // No colour but a TTY: still show progress, just not the frames.
      this.timer = setInterval(() => {
        this.write(`\r${label}`);
      }, 1000);
      return;
    }
    this.timer = setInterval(() => {
      const glyph = Spinner.FRAMES[this.frame % Spinner.FRAMES.length] ?? "*";
      this.frame += 1;
      this.write(`\r${this.theme.cyan(glyph)} ${this.theme.gray(label)}`);
    }, 80);
  }

  update(label: string): void {
    if (!this.active || !this.isTty) return;
    this.write(`\r\u001b[2K${this.theme.cyan("⠿")} ${this.theme.gray(label)}`);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTty) this.write("\r\u001b[2K");
  }
}

/** The banner shown when `genie` starts with no task. */
export function banner(theme: Theme, origin: string, model: string, identity: string): string[] {
  const line = "─".repeat(Math.min(56, terminalWidth(60)));
  return [
    theme.paint("brightCyan", theme.on ? "◆" : "*") + " " + theme.bold("OnTrak Genie") + "  " + theme.gray("your wish is my command"),
    theme.gray(line),
    `  ${theme.gray("server")}   ${origin}`,
    `  ${theme.gray("identity")} ${identity}`,
    `  ${theme.gray("model")}    ${model}`,
    theme.gray(line),
    theme.gray("  Type a task, or /help for commands. Ctrl-C twice to exit."),
    "",
  ];
}

/** A dimmed section label (`▸ you`, `▸ genie`). */
export function speaker(theme: Theme, who: "you" | "genie"): string {
  return who === "you" ? theme.bold(theme.cyan("▸ you")) : theme.bold(theme.magenta("▸ genie"));
}

export function eventNotice(theme: Theme, text: string): string {
  return `${theme.gray("·")} ${theme.gray(text)}`;
}

export function eventError(theme: Theme, message: string): string {
  return `${theme.red("✗")} ${theme.red(message)}`;
}
