"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/cn";
import { useTranslator } from "@/lib/i18n-client";
import type { CommandResult } from "@/lib/sim/types";

export interface TerminalPaneProps {
  /** Current prompt string, e.g. `student@server01:~$ `. */
  getPrompt: () => string;
  /**
   * Execute one command line and return its result.
   *
   * A sandboxed attempt answers with a promise — the command runs on the server — so the
   * prompt is held until it settles. Everything else answers immediately.
   */
  onCommand: (input: string) => CommandResult | Promise<CommandResult>;
  /** Text printed once when the session opens. */
  banner: string;
  /** Called when a command asks to open a file in the editor. */
  onOpenEditor?: (path: string) => void;
  /** Suggestions for tab completion (command names). */
  completions?: string[];
  /** Notified whenever a command finishes, so the side panel can refresh. */
  onActivity?: () => void;
  className?: string;
}

const THEME = {
  background: "#141029",
  foreground: "#ded8ff",
  cursor: "#a78bfa",
  cursorAccent: "#141029",
  selectionBackground: "#4c3fa8",
  black: "#2a2344",
  red: "#ff7a9c",
  green: "#5fe3b0",
  yellow: "#ffd479",
  blue: "#8ab4ff",
  magenta: "#d5a8ff",
  cyan: "#7ee6e0",
  white: "#e8e4ff",
  brightBlack: "#5a5180",
  brightRed: "#ff9db6",
  brightGreen: "#8bf0c9",
  brightYellow: "#ffe3a3",
  brightBlue: "#aecaff",
  brightMagenta: "#e5c7ff",
  brightCyan: "#a6f2ee",
  brightWhite: "#ffffff",
};

/** Extra keys that make a terminal usable on a phone keyboard. */
const QUICK_KEYS: { label: string; data: string; titleKey?: string }[] = [
  { label: "Tab", data: "\t", titleKey: "console.quickKey.complete" },
  { label: "Ctrl+C", data: "\u0003", titleKey: "console.quickKey.cancel" },
  { label: "↑", data: "\u001b[A", titleKey: "console.quickKey.previous" },
  { label: "↓", data: "\u001b[B", titleKey: "console.quickKey.next" },
  { label: "|", data: "|" },
  { label: "-", data: "-" },
  { label: "/", data: "/" },
  { label: "~", data: "~" },
  { label: "$", data: "$" },
  { label: "\\", data: "\\" },
];

export function TerminalPane({
  getPrompt,
  onCommand,
  banner,
  onOpenEditor,
  completions = [],
  onActivity,
  className,
}: TerminalPaneProps) {
  const t = useTranslator();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bufferRef = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const [ready, setReady] = useState(false);

  // Keep the latest callbacks without re-creating the terminal.
  const apiRef = useRef({ getPrompt, onCommand, onOpenEditor, onActivity, completions });
  apiRef.current = { getPrompt, onCommand, onOpenEditor, onActivity, completions };

  // The opening banner is printed exactly once, so it is captured on the first
  // render instead of being read from props. Rebuilding the terminal to print a
  // new banner would throw away the line the student is halfway through typing.
  const initialBannerRef = useRef(banner);

  const writePrompt = useCallback(() => {
    termRef.current?.write(`\r\n${apiRef.current.getPrompt()}`);
  }, []);

  const redrawLine = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Redraw the prompt + buffer, then clear anything left over.
    term.write(`\r\x1b[K${apiRef.current.getPrompt()}${bufferRef.current}`);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "var(--font-mono-code), ui-monospace, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0.2,
      scrollback: 4000,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* the container may not be measured yet; the ResizeObserver retries */
    }

    termRef.current = term;
    fitRef.current = fit;
    setReady(true);

    term.write(initialBannerRef.current.replace(/\n/g, "\r\n"));
    term.write(`\r\n${apiRef.current.getPrompt()}`);

    const runLine = async (line: string) => {
      const input = line.trim();
      if (input === "") {
        term.write("\r\n");
        writePrompt();
        return;
      }

      historyRef.current.push(input);
      historyIndexRef.current = null;

      busyRef.current = true;
      let result: CommandResult;
      try {
        // A sandboxed driver resolves this after the server has run the line; the keystroke
        // handler ignores input while `busyRef` is set, so the prompt waits for it.
        result = await apiRef.current.onCommand(input);
      } catch (error) {
        result = { stdout: "", stderr: `Internal simulator error: ${(error as Error).message}`, exitCode: 1 };
      }
      busyRef.current = false;

      if (result.clear) {
        term.clear();
        term.write("\x1b[2J\x1b[H");
        term.write(apiRef.current.getPrompt());
        apiRef.current.onActivity?.();
        return;
      }

      const text = [result.stdout, result.stderr].filter(Boolean).join("\r\n");
      if (text) term.write(`\r\n${text.replace(/\n/g, "\r\n")}`);

      if (result.openEditor) {
        apiRef.current.onOpenEditor?.(result.openEditor);
      }

      writePrompt();
      apiRef.current.onActivity?.();
    };

    const complete = () => {
      const buffer = bufferRef.current;
      const parts = buffer.split(/\s+/);
      const pwd = apiRef.current.getPrompt();
      void pwd;
      if (parts.length > 1) {
        // Path completion: offer nothing rather than something wrong.
        return;
      }
      const matches = apiRef.current.completions.filter((name) => name.toLowerCase().startsWith(buffer.toLowerCase()));
      if (matches.length === 1) {
        bufferRef.current = matches[0];
        redrawLine();
        return;
      }
      if (matches.length > 1) {
        term.write(`\r\n${matches.join("   ").replace(/\n/g, "\r\n")}`);
        writePrompt();
      }
    };

    const disposable = term.onData((data) => {
      if (busyRef.current) return;

      switch (data) {
        case "\r": {
          const line = bufferRef.current;
          bufferRef.current = "";
          term.write("\r\n");
          void runLine(line);
          return;
        }
        case "\u007f": {
          if (bufferRef.current.length > 0) {
            bufferRef.current = bufferRef.current.slice(0, -1);
            // Rub out the last character in place.
            term.write("\b \b");
          }
          return;
        }
        case "\u0003": {
          bufferRef.current = "";
          term.write("^C");
          writePrompt();
          return;
        }
        case "\t": {
          complete();
          return;
        }
        case "\u001b[A": {
          const history = historyRef.current;
          if (history.length === 0) return;
          const index = historyIndexRef.current === null ? history.length - 1 : Math.max(0, historyIndexRef.current - 1);
          historyIndexRef.current = index;
          bufferRef.current = history[index];
          redrawLine();
          return;
        }
        case "\u001b[B": {
          const history = historyRef.current;
          if (history.length === 0 || historyIndexRef.current === null) return;
          const next = historyIndexRef.current + 1;
          if (next >= history.length) {
            historyIndexRef.current = null;
            bufferRef.current = "";
          } else {
            historyIndexRef.current = next;
            bufferRef.current = history[next];
          }
          redrawLine();
          return;
        }
        case "\u000c": {
          term.clear();
          term.write(apiRef.current.getPrompt() + bufferRef.current);
          return;
        }
        default: {
          // Ignore escape sequences we do not handle (arrows left/right, etc).
          if (data.startsWith("\u001b")) return;
          const printable = data.replace(/[\u0000-\u001f\u007f]/g, "");
          if (!printable) return;
          bufferRef.current += printable;
          term.write(printable);
        }
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore transient measurement failures */
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      disposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The terminal is created once; everything mutable is read through apiRef
    // and the banner through initialBannerRef, so no prop change can rebuild it.
  }, [redrawLine, writePrompt]);

  useLayoutEffect(() => {
    if (!ready) return;
    const handle = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
    }, 60);
    return () => window.clearTimeout(handle);
  }, [ready]);

  const sendKey = (data: string) => {
    // Reuse the same path the keyboard takes so history and completion work.
    if (data === "\t") {
      const buffer = bufferRef.current;
      const matches = completions.filter((name) => name.toLowerCase().startsWith(buffer.toLowerCase()));
      if (matches.length === 1) {
        bufferRef.current = matches[0];
        redrawLine();
      }
      return;
    }
    if (data === "\u0003") {
      bufferRef.current = "";
      termRef.current?.write("^C");
      writePrompt();
      return;
    }
    if (data === "\u001b[A" || data === "\u001b[B") {
      const history = historyRef.current;
      if (history.length === 0) return;
      const index = data === "\u001b[A"
        ? historyIndexRef.current === null
          ? history.length - 1
          : Math.max(0, historyIndexRef.current - 1)
        : (historyIndexRef.current ?? history.length - 1) + 1;
      if (index >= history.length) {
        bufferRef.current = "";
        historyIndexRef.current = null;
      } else {
        historyIndexRef.current = index;
        bufferRef.current = history[index];
      }
      redrawLine();
      return;
    }
    bufferRef.current += data;
    termRef.current?.write(data);
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl2 border border-[#2c2350] bg-[#141029]", className)}>
      <div className="flex items-center gap-2 border-b border-white/8 bg-white/4 px-4 py-2.5">
        <span aria-hidden className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span aria-hidden className="size-2.5 rounded-full bg-[#febc2e]" />
        <span aria-hidden className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono text-[11px] tracking-wide text-white/50 select-none">
          {t("console.sessionNote")}
        </span>
      </div>

      <div
        ref={hostRef}
        role="application"
        aria-label={t("console.aria")}
        className="min-h-[18rem] flex-1 px-3 py-2 sm:min-h-[24rem]"
        onClick={() => termRef.current?.focus()}
      />

      <div className="flex items-center gap-1.5 overflow-x-auto border-t border-white/8 bg-white/4 px-3 py-2 lg:hidden">
        {QUICK_KEYS.map((key) => {
          const title = key.titleKey ? t(key.titleKey) : undefined;
          return (
          <button
            key={key.label}
            type="button"
            title={title}
            aria-label={title ? `${key.label}: ${title}` : key.label}
            onClick={() => sendKey(key.data)}
            className="shrink-0 rounded-lg border border-white/12 bg-white/8 px-3 py-1.5 font-mono text-xs text-white/85 transition active:scale-95 active:bg-white/20"
          >
            {key.label}
          </button>
          );
        })}
      </div>
    </div>
  );
}
