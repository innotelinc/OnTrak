"use client";

import { useMemo, useState } from "react";
import { computeCell, indexToColumn, parseCellRef } from "@/lib/sim/formula";
import { cn } from "@/lib/cn";
import { useTranslator } from "@/lib/i18n-client";
import type { DocumentDoc, MailDoc, OfficeDoc, SlideDoc, SpreadsheetDoc } from "@/lib/sim/types";

export interface OfficePanelProps {
  docs: Record<string, OfficeDoc>;
  activeDoc?: string;
  onSelect: (name: string) => void;
  /** Bumped by the runner so formulas recalculate after each command. */
  revision: number;
  className?: string;
}

/**
 * A read-only window onto the documents the student is editing.
 *
 * The console is where the work happens; this panel is the "what you just did"
 * feedback loop, which matters a lot on a phone where a wall of spreadsheet
 * text would be miserable to read.
 */
export function OfficePanel({ docs, activeDoc, onSelect, revision, className }: OfficePanelProps) {
  const t = useTranslator();
  const names = Object.keys(docs);
  const current = (activeDoc && docs[activeDoc]) || (names[0] ? docs[names[0]] : undefined);

  if (!current) {
    return (
      <div className={cn("rounded-xl2 border border-line bg-surface p-6 text-sm text-ink-soft", className)}>
        {t("office.empty")}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl2 border border-line bg-surface", className)}>
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line bg-surface-muted/60 px-2 py-2">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            className={cn(
              "shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              name === current.name ? "bg-surface text-brand shadow-card" : "text-ink-soft hover:text-ink",
            )}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <DocView doc={current} revision={revision} />
      </div>
    </div>
  );
}

function DocView({ doc, revision }: { doc: OfficeDoc; revision: number }) {
  switch (doc.type) {
    case "spreadsheet":
      return <SpreadsheetView doc={doc} revision={revision} />;
    case "document":
      return <DocumentView doc={doc} revision={revision} />;
    case "mail":
      return <MailView doc={doc} revision={revision} />;
    case "slides":
      return <SlidesView doc={doc} />;
    default:
      return null;
  }
}

function SpreadsheetView({ doc, revision }: { doc: SpreadsheetDoc; revision: number }) {
  const t = useTranslator();
  const sheet = doc.sheets[doc.activeSheet] ?? doc.sheets[0];
  const [selected, setSelected] = useState("A1");

  const { rows, cols } = useMemo(() => {
    void revision; // recompute whenever the engine state changes
    const used = Object.keys(sheet?.cells ?? {})
      .map((ref) => parseCellRef(ref))
      .filter((ref): ref is { row: number; col: number } => Boolean(ref));
    const rows = Math.min(30, Math.max(6, ...used.map((u) => u.row + 1)) + 1);
    const cols = Math.min(12, Math.max(4, ...used.map((u) => u.col + 1)) + 1);
    return { rows, cols };
  }, [sheet, revision]);

  if (!sheet) return <p className="text-sm text-ink-soft">{t("office.noSheets")}</p>;

  const grid: (string | null)[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: (string | null)[] = [];
    for (let col = 0; col < cols; col += 1) {
      const ref = `${indexToColumn(col)}${row + 1}`;
      const cell = sheet.cells[ref];
      if (!cell) {
        line.push(null);
        continue;
      }
      const value = computeCell(sheet, ref, doc.sheets);
      const style = cell.style ?? {};
      const numeric = Number(value.replace(/[$,\s]/g, ""));
      const isNumber = value !== "" && !Number.isNaN(numeric);
      line.push(
        style.format === "currency" && isNumber
          ? `$${numeric.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : isNumber && style.format === "percent"
            ? `${numeric}%`
            : value,
      );
    }
    grid.push(line);
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        <span className="font-semibold text-ink-soft">{sheet.name}</span>
        <span>·</span>
        <span>{t("office.cells", { count: Object.keys(sheet.cells).length })}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[11.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface-muted px-2 py-1 text-ink-faint font-normal" />
              {Array.from({ length: cols }, (_, col) => (
                <th key={col} className="bg-surface-muted px-2 py-1 font-normal text-ink-faint">
                  {indexToColumn(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((line, row) => (
              <tr key={row}>
                <th className="sticky left-0 bg-surface-muted px-2 py-1 font-normal text-ink-faint">{row + 1}</th>
                {line.map((value, col) => {
                  const ref = `${indexToColumn(col)}${row + 1}`;
                  const style = sheet.cells[ref]?.style;
                  const hasFormula = Boolean(sheet.cells[ref]?.f);
                  return (
                    <td
                      key={col}
                      onClick={() => setSelected(ref)}
                      title={hasFormula ? `=${sheet.cells[ref]?.f}` : undefined}
                      style={style?.fill ? { backgroundColor: style.fill } : undefined}
                      className={cn(
                        "cursor-default border border-line px-2 py-1 whitespace-nowrap",
                        selected === ref && "ring-2 ring-brand/50 ring-inset",
                        style?.bold && "font-bold",
                        style?.italic && "italic",
                        hasFormula && "bg-teal/8 text-teal",
                        !value && "text-ink-faint/40",
                      )}
                    >
                      {value === null ? "" : value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        {t("office.formulaHint")} <span className="font-mono text-ink-soft">{selected}</span>
      </p>
    </div>
  );
}

function DocumentView({ doc, revision }: { doc: DocumentDoc; revision: number }) {
  const t = useTranslator();
  void revision;
  return (
    <article className="mx-auto max-w-[46rem] rounded-lg border border-line bg-surface px-6 py-6 shadow-card">
      <p className="mb-4 font-mono text-[11px] text-ink-faint">{doc.name}</p>
      {doc.blocks.length === 0 ? (
        <p className="text-sm text-ink-faint italic">{t("office.emptyDocument")}</p>
      ) : (
        <div className="space-y-2.5">
          {doc.blocks.map((block, index) => {
            if (block.kind === "heading") {
              const sizes = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"];
              return (
                <h3
                  key={index}
                  className={cn("font-display font-semibold text-ink", sizes[Math.min(block.level, 6) - 1])}
                >
                  {block.text}
                </h3>
              );
            }
            if (block.kind === "list") {
              return (
                <ul key={index} className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              );
            }
            if (block.kind === "table") {
              return (
                <table key={index} className="w-full border-collapse text-sm">
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className={cn("border border-line px-2 py-1", rowIndex === 0 && block.header && "bg-surface-muted font-semibold")}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            }
            return (
              <p key={index} className="text-sm leading-relaxed text-ink-soft">
                {block.text}
              </p>
            );
          })}
        </div>
      )}
    </article>
  );
}

function MailView({ doc, revision }: { doc: MailDoc; revision: number }) {
  const t = useTranslator();
  void revision;
  const folders = ["inbox", "sent", "drafts", "archive"] as const;
  const [folder, setFolder] = useState<(typeof folders)[number]>("inbox");
  const [open, setOpen] = useState<string | null>(null);

  const messages = doc.messages.filter((message) => message.folder === folder);
  const selected = messages.find((message) => message.id === open);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-center gap-1.5">
        {folders.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => {
              setFolder(name);
              setOpen(null);
            }}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              folder === name ? "bg-brand-soft text-brand" : "text-ink-soft hover:bg-surface-muted",
            )}
          >
            {t(`office.folder.${name}`)}
            <span className="ml-1.5 text-ink-faint">
              {doc.messages.filter((message) => message.folder === name).length}
            </span>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl2 border border-line p-4">
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="mb-3 text-xs font-semibold text-brand hover:underline"
          >
            {t("office.backTo", { folder: t(`office.folder.${folder}`) })}
          </button>
          <h4 className="font-display text-base font-semibold text-ink">{selected.subject}</h4>
          <p className="mt-1 text-xs text-ink-faint">
            {t("office.fromTo", { from: selected.from, to: selected.to.join(", ") })}
          </p>
          <p className="mt-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft">{selected.body}</p>
          {selected.flagged ? (
            <p className="mt-4 text-xs font-semibold text-amber">{t("office.flagged")}</p>
          ) : null}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-auto">
          {messages.length === 0 ? (
            <li className="rounded-xl2 border border-dashed border-line px-4 py-8 text-center text-sm text-ink-faint">
              {t("office.nothingIn", { folder: t(`office.folder.${folder}`) })}
            </li>
          ) : (
            messages.map((message) => (
              <li key={message.id}>
                <button
                  type="button"
                  onClick={() => setOpen(message.id)}
                  className={cn(
                    "w-full rounded-xl2 border border-line px-3.5 py-2.5 text-left transition hover:border-brand/40",
                    !message.read && "bg-brand-soft/40",
                  )}
                >
                  <span className="flex items-center gap-2">
                    {message.flagged ? <span className="text-amber">★</span> : null}
                    <span className={cn("truncate text-sm", message.read ? "text-ink-soft" : "font-semibold text-ink")}>
                      {message.subject}
                    </span>
                    {!message.read ? <span className="ml-auto size-2 shrink-0 rounded-full bg-brand" /> : null}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-faint">
                    {message.id} · {message.from}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function SlidesView({ doc }: { doc: SlideDoc }) {
  return (
    <div className="space-y-3">
      {doc.slides.map((slide, index) => (
        <div key={index} className="rounded-xl2 border border-line p-4">
          <h4 className="font-display text-base font-semibold text-ink">
            {index + 1}. {slide.title}
          </h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {slide.bullets.map((bullet, bulletIndex) => (
              <li key={bulletIndex}>{bullet}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
