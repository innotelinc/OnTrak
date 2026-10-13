/**
 * The family's mark, drawn once for the whole portal.
 *
 * One silhouette — the shield — at every product, with that product's own single
 * stroke inside it: the family is recognisable at a glance and the product is still
 * legible. The gradient runs from `--brand` to the product's own tone, which is what
 * makes six identical shapes six different marks.
 *
 * It lives in one file because the same mark is drawn in three places here (the
 * masthead, the sign-in gate, and a tile for every product the person's role can
 * reach), and three hand-written copies of a shield is how a family ends up with
 * three slightly different shields. The geometry is deliberately the same numbers in
 * all six OnTrak products, not just this one.
 */

/** Product key → the tone token its gradient ends on, and the stroke inside it. */
const MARKS = {
  /** The front door's own stroke: the heartbeat. */
  unity: {
    tone: "unity",
    label: "OnTrak Unity",
    strokes: ["M13.5 24.5 h6 l2.8 -7.2 4.4 14.4 2.9 -7.2 h5"],
  },
  /** A scenario is answered by getting the job done: the tick. */
  training: {
    tone: "its",
    label: "OnTrak IT Support Training",
    strokes: ["M16 25 l4.5 4.5 L32.5 20.5"],
  },
  /** A ticket is a conversation somebody has to answer. */
  desk: {
    tone: "tix",
    label: "OnTrak Tix",
    strokes: [
      "M15.5 19 h17 a3.5 3.5 0 0 1 3.5 3.5 v6 a3.5 3.5 0 0 1 -3.5 3.5 h-8.5 l-5.5 4.5 v-4.5 h-3 a3.5 3.5 0 0 1 -3.5 -3.5 v-6 a3.5 3.5 0 0 1 3.5 -3.5 z",
    ],
  },
  /** Watching the wire and raising what it finds: the sweep. */
  security: {
    tone: "sentinel",
    label: "OnTrak Sentinel",
    strokes: ["M24 15.5 a8.5 8.5 0 1 0 8.5 8.5", "M24 24 l5.5 -5.5"],
    dot: { cx: 24, cy: 24, r: 1.7 },
  },
  /** A fleet coming back to where it should be: the cycle. */
  operations: {
    tone: "sync",
    label: "OnTrak Sync",
    strokes: ["M17 21 h9 q4 0 4 4", "M20 18 l-3 3 3 3", "M31 28 h-9 q-4 0 -4 -4", "M28 31 l3 -3 -3 -3"],
  },
  /** Whatever somebody asks for, in one shape. */
  agent: {
    tone: "genie",
    label: "OnTrak Genie",
    strokes: ["M24 15 l2.6 6.4 6.4 2.6 -6.4 2.6 -2.6 6.4 -2.6 -6.4 -6.4 -2.6 6.4 -2.6 z"],
  },
  /**
   * The simulated range's real-machine sibling: a terminal, with a prompt waiting.
   *
   * The lab is the one product here whose mark is not a shape *about* the work but the
   * surface the work happens on, because that is what it is — the same scenario the
   * tick above describes, run on a machine instead of in a browser. Its tone is its
   * own (`--tone-lab`) rather than the training range's violet-on-shield, so a tile
   * for each is legible side by side.
   */
  lab: {
    tone: "lab",
    label: "OnTrak Lab",
    strokes: [
      "M15.5 18.5 h17 a2.5 2.5 0 0 1 2.5 2.5 v8 a2.5 2.5 0 0 1 -2.5 2.5 h-17 a2.5 2.5 0 0 1 -2.5 -2.5 v-8 a2.5 2.5 0 0 1 2.5 -2.5 z",
      "M18 23 l2.6 2.4 -2.6 2.4",
      "M24 27.8 h7",
    ],
  },
} as const;

export type ProductKey = keyof typeof MARKS;

/** Every product this file knows how to draw, for a caller that has a list. */
export const PRODUCT_KEYS = Object.keys(MARKS) as ProductKey[];

const SHIELD = "M24 4.5 L41 12 V27 C41 37.4 34 43 24 44.5 C14 43 7 37.4 7 27 V12 Z";

export function ProductMark({
  product,
  id,
  className,
  label = true,
}: {
  product: ProductKey;
  /**
   * A DOM id to build the gradient's id from.
   *
   * Required rather than generated: the same mark is drawn once per tile and once in
   * the masthead, and two `<linearGradient>` elements with the same id is a document
   * that only renders correctly because the browser picked the first one.
   */
  id: string;
  className?: string;
  /**
   * Whether the mark is the thing naming the product.
   *
   * True on a tile or a gate, where it is the only label; false beside the product's
   * name in text, where a second label is just a repetition a screen reader reads
   * twice.
   */
  label?: boolean;
}) {
  const mark = MARKS[product];
  const gradientId = `${id}-gradient`;
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      role={label ? "img" : undefined}
      aria-label={label ? mark.label : undefined}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor={`var(--tone-${mark.tone})`} />
        </linearGradient>
      </defs>
      <path d={SHIELD} fill={`url(#${gradientId})`} />
      {mark.strokes.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="var(--brand-ink)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {"dot" in mark && mark.dot ? (
        <circle cx={mark.dot.cx} cy={mark.dot.cy} r={mark.dot.r} fill="var(--brand-ink)" />
      ) : null}
    </svg>
  );
}
