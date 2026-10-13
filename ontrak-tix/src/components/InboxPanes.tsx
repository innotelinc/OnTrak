"use client";

/**
 * The inbox pair: the worklist and the ticket, and the divider between them that a person
 * can actually move.
 *
 * The two panes answer different questions at different sizes — a dispatcher watching a rush
 * wants fifteen rows and does not care about the conversation; an agent reading a long thread
 * wants the width — so the split is not a fixed ratio. It starts at the desk's own 60/40,
 * follows the screen (`--inbox-list` is a percentage, so a wider monitor means wider panes
 * without anything here knowing the pixel count), and once somebody drags it, that is the
 * ratio on their next visit too.
 *
 * Three deliberate details:
 *
 *  - **The drag is a real control, not a mouse trick.** The divider is focusable, is a
 *    `separator` to a screen reader, reports its position as a percentage, and answers the
 *    arrow keys — so the layout is adjustable with a keyboard as well as a pointer.
 *  - **Below the pair breakpoint there is no divider at all.** The panes stack, and a
 *    horizontal resize made in a stacked layout would be a control for nothing.
 *  - **The ratio is stored per browser, not per user.** It is a preference about this screen
 *    on this machine, and putting it in the database would mean a migration and a write on
 *    every drag for something nobody else ever needs to read.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/** The share of the width the worklist starts with — the desk's existing 1.5fr/1fr. */
const DEFAULT_SPLIT = 0.6;
/** Kept narrow enough that neither pane can be dragged away entirely. */
const MIN_SPLIT = 0.25;
const MAX_SPLIT = 0.8;
/** One arrow press, and one with Shift held. */
const STEP = 0.02;
const COARSE_STEP = 0.08;
const STORAGE_KEY = "ontrak.tix.inbox.split";

function clamp(value: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
}

function storedSplit(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : null;
  } catch {
    // A browser with storage switched off is a browser with the default split, not an error.
    return null;
  }
}

export interface InboxPanesProps {
  /** The worklist. */
  list: ReactNode;
  /** The selected ticket, or the note that says to select one. */
  detail: ReactNode;
}

export function InboxPanes({ list, detail }: InboxPanesProps) {
  // Rendered server-side at the default and corrected after mount, so the markup a browser
  // gets first never depends on a value the server cannot know.
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const container = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ startX: number; startSplit: number; width: number } | null>(null);

  useEffect(() => {
    const remembered = storedSplit();
    if (remembered !== null) setSplit(remembered);
  }, []);

  const remember = useCallback((value: number) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Remembering is a courtesy; a full or forbidden store must not break the drag.
    }
  }, []);

  const move = useCallback(
    (value: number) => {
      const next = clamp(value);
      setSplit(next);
      return next;
    },
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startSplit: split, width: box.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.width === 0) return;
    move(current.startSplit + (event.clientX - current.startX) / current.width);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    remember(split);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? COARSE_STEP : STEP;
    const moves: Record<string, number> = {
      ArrowLeft: split - step,
      ArrowRight: split + step,
      Home: MIN_SPLIT,
      End: MAX_SPLIT,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    remember(move(target));
  };

  return (
    <div
      ref={container}
      className="grid gap-5 xl:gap-0 xl:[grid-template-columns:minmax(0,var(--inbox-list))_0.75rem_minmax(0,1fr)]"
      style={{ "--inbox-list": `${(split * 100).toFixed(2)}%` } as CSSProperties}
    >
      <div className="min-w-0 xl:pr-4">{list}</div>

      {/* The divider. Its column is a fixed sliver of width; the line inside is what moves. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the worklist"
        aria-valuenow={Math.round(split * 100)}
        aria-valuemin={Math.round(MIN_SPLIT * 100)}
        aria-valuemax={Math.round(MAX_SPLIT * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className="group hidden cursor-col-resize touch-none items-stretch justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand xl:flex"
      >
        <span className="w-px bg-line transition-colors group-hover:bg-brand group-focus-visible:bg-brand" />
      </div>

      <div className="min-w-0 xl:pl-4">{detail}</div>
    </div>
  );
}
