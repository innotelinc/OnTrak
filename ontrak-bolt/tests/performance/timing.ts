/**
 * Timing helpers for the benchmarks.
 *
 * These files assert wall-clock budgets, and they run beside up to nineteen other
 * jsdom workers. On a two-core runner that means a frame can be preempted for longer
 * than the budget while the code under test is fast, and a cold first pass pays for
 * JIT and module init that no later pass pays again. Both have shown up here as red
 * builds whose only cause was the machine: one frame out of fifty at 17.2 ms against
 * a 16.67 ms budget, and shiki's first `codeToHtml` — grammar and theme loading —
 * measured as if it were a highlight.
 *
 * So a measurement warms up first, and a budget is judged on the median sample (the
 * frame a visitor actually experiences) together with the share of samples that
 * missed it — not on the single worst sample, which is the runner's rather than the
 * component's. A real regression moves the whole distribution and fails both.
 */

/** Iterations discarded before timing: the first pass is init, not steady state. */
export const WARMUP_ITERATIONS = 5;

/** The share of frames that may miss the budget: the 60fps rule, "under 5% dropped". */
export const MAX_OVERSHOOT_SHARE = 0.05;

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** The share of `values` that took longer than `budget`, between 0 and 1. */
export function overshootShare(values: readonly number[], budget: number): number {
  if (values.length === 0) {
    return 0;
  }

  return values.filter((value) => value > budget).length / values.length;
}

/**
 * Time `iterations` calls, in milliseconds each, after `warmup` untimed ones.
 *
 * The warm-up calls receive the same `iteration` numbers the measurement starts with,
 * so both passes render the same thing and the discarded work is genuinely the same
 * shape as the work being timed.
 */
export function timeIterations(
  fn: (iteration: number) => void,
  iterations: number,
  warmup: number = WARMUP_ITERATIONS,
): number[] {
  for (let i = 0; i < warmup; i++) {
    fn(i);
  }

  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn(i);
    samples.push(performance.now() - start);
  }

  return samples;
}
