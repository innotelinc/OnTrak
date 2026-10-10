/**
 * Threat intelligence (S3): the clock that prunes the indicators whose date has passed.
 *
 * An indicator carries an expiry so that "curation is a gift with a date on it" is a
 * mechanism rather than a hope — an address is reassigned, a domain is re-registered, and a
 * list nobody pruned reports the innocent for years. The *matcher* is what keeps that
 * promise (`matchEvent` refuses an expired indicator however confident the feed was); this
 * loop is what keeps the list itself readable, and it is small on purpose.
 *
 * Four choices, each about a failure that would otherwise be silent:
 *
 *  - **On by default, at an hour, and the interval is the one number that differs from the
 *    enforcement sweep's.** That sweep lifts a block, whose absence is an outage, so it runs
 *    every minute; this prunes rows the detector already refuses, so a minute would be churn
 *    for nothing and an hour is enough for a list that changes when somebody publishes a
 *    feed. `SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES=0` is the explicit off switch, for a
 *    deployment that would rather drive the prune itself — the rows it leaves are inert.
 *  - **A failed sweep is logged and the next one is due on time.** `sweepExpired` writes to
 *    a database and to the evidence chain, and either can fail. Letting a rejection escape
 *    the timer would end the process; swallowing it silently would leave an expired list
 *    growing with nothing on the console explaining why. The error goes to the caller's log
 *    and the loop continues.
 *  - **Sweeps do not overlap.** A second pass that started while the first was still writing
 *    could read the same row; the running flag makes non-overlap a property of this loop
 *    rather than a hope about the store — and `sweepExpired` prunes row by row, so the
 *    window is a whole sweep wide, not one query.
 *  - **The clock and the timer are injected**, so the loop is tested without waiting — the
 *    same seam `enforcement-scheduler.ts` and `access-review-scheduler.ts` take, for the
 *    same reason.
 */

import type { ThreatIntelService } from "./threat-intel-service";

/** The shortest interval this will honour. Below it, the timer is a busy loop. */
export const MIN_INTEL_SWEEP_INTERVAL_MS = 10_000;

/** What a deployment that has not configured one gets: an hour. */
export const DEFAULT_INTEL_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface ThreatIntelSchedulerOptions {
  /** How often to sweep. At least `MIN_INTEL_SWEEP_INTERVAL_MS`. */
  intervalMs: number;
  /** Called with what each sweep pruned, and with each failure. */
  log(message: string): void;
  /** Called when a sweep throws. Defaults to `log`. */
  onError?(error: unknown): void;
  /** Epoch milliseconds, so a test can drive it. */
  now?: () => number;
  /** The timer itself. Defaults to `setInterval`; injectable so a test need not wait. */
  setTimer?: (callback: () => void, intervalMs: number) => { unref?: () => void };
  /** Defaults to `clearInterval`. */
  clearTimer?: (handle: unknown) => void;
}

export interface ThreatIntelScheduler {
  /** Run one sweep now. Never throws: failures are reported through the options. */
  runOnce(): Promise<void>;
  /** Stop the timer. Safe to call more than once. */
  stop(): void;
}

/**
 * What `SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES` means.
 *
 * Unset is **on**, at an hour: the alternative to pruning is a list that keeps rows whose
 * date has passed, which the console's counts still report as watched. An explicit `0`, a
 * negative number or anything unparseable is **off** — the operator saying they will prune
 * themselves — and a positive value is honoured down to the floor, clamped rather than
 * refused because an operator who typed `0.1` meant "as often as you can" and the honest
 * answer is the shortest sweep this will run.
 */
export function intelSweepIntervalMs(env: Record<string, string | undefined>): number | null {
  const raw = env.SENTINEL_INTEL_SWEEP_INTERVAL_MINUTES?.trim();
  if (raw === undefined || raw === "") return DEFAULT_INTEL_SWEEP_INTERVAL_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(MIN_INTEL_SWEEP_INTERVAL_MS, Math.round(minutes * 60_000));
}

/**
 * Start the loop.
 *
 * The returned handle's `stop` clears the timer; a deployment's shutdown calls it so a test
 * or a restart does not leave a sweep in flight against a closing client.
 */
export function startThreatIntelScheduler(
  service: Pick<ThreatIntelService, "sweepExpired">,
  options: ThreatIntelSchedulerOptions,
): ThreatIntelScheduler {
  const reportError = options.onError ?? ((error: unknown) => options.log(`sweep failed: ${describe(error)}`));
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    // Overlapping passes are refused here rather than left to the store: see the header.
    if (running) {
      options.log("the previous sweep is still running, so this one was skipped");
      return;
    }
    running = true;
    try {
      const report = await service.sweepExpired();
      if (report.pruned.length > 0) {
        options.log(
          `pruned ${report.pruned.length} indicator(s) whose expiry had passed: ${report.pruned.join(", ")}`,
        );
      }
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
    }
  }

  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const timer = setTimer(() => {
    if (!stopped) void runOnce();
  }, options.intervalMs);
  // Do not hold the process open on a timer whose only job is to prune a list.
  timer.unref?.();

  options.log(`the indicator sweep is on, every ${Math.round(options.intervalMs / 1000)}s`);

  return {
    runOnce,
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}

/** An error, as one line for a log. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
