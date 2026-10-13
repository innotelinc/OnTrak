/**
 * The OnTrak Sync mark: the family's shield with a cycle in it.
 *
 * One silhouette is shared by every product — the shield — and each carries a single
 * stroke of its own inside it. Sync's stroke is the cycle, because the product's whole
 * job is a fleet coming back to where it should be; the gradient runs from `--brand`
 * to `--tone-sync`, which is what makes this product's mark this product's.
 *
 * `gradientId` is a parameter rather than a constant because the mark is drawn twice
 * on the sign-in page — once in the masthead and once on the gate — and two elements
 * with the same `id` is a document that only works because the browser picked the
 * first one. `label` is the other half of that: the gate's mark is the only thing
 * naming the product there, so it is labelled; the masthead's sits beside the name in
 * text, so it is decoration.
 */

const SHIELD = "M24 4.5 L41 12 V27 C41 37.4 34 43 24 44.5 C14 43 7 37.4 7 27 V12 Z";

/** Two half-cycles, each with the arrowhead that says which way it goes. */
const CYCLE = [
  "M17 21 h9 q4 0 4 4",
  "M20 18 l-3 3 3 3",
  "M31 28 h-9 q-4 0 -4 -4",
  "M28 31 l3 -3 -3 -3",
];

function Shield({
  gradientId,
  className,
  label,
}: {
  gradientId: string;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={className ? `gate__mark-svg ${className}` : "gate__mark-svg"}
      viewBox="0 0 48 48"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--tone-sync)" />
        </linearGradient>
      </defs>
      <path d={SHIELD} fill={`url(#${gradientId})`} />
      {CYCLE.map((d) => (
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
    </svg>
  );
}

/** The gate mark: the shield and the cycle, above the product's name. */
export function SyncGateMark() {
  return <Shield gradientId="sync-gate-mark" label="OnTrak Sync" />;
}

/** The same mark for the masthead, where the name is already in text beside it. */
export function SyncMastheadMark() {
  return <Shield gradientId="sync-masthead-mark" className="masthead__mark" />;
}
