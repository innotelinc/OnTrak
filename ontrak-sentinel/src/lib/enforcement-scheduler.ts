/**
 * Enforcement (S4): the clock that lifts what its own deadline reached.
 *
 * An enforcement action carries a TTL so that "reversible by default" is a mechanism
 * rather than a promise — but a TTL is only a mechanism if *something* reads it. Without
 * this loop, a block applied with a one-hour lifetime would stand until a person noticed,
 * which is exactly the outage the TTL exists to bound. So this is the part that makes the
 * deadline mean something, and it is small on purpose.
 *
 * Four choices, each about a failure that would otherwise be silent:
 *
 *  - **On by default, and that is the opposite of the access-review scheduler.** An
 *    attestation nobody asked for should not appear on its own, so that loop is off unless a
 *    deployment asks. An *expiry* nobody asked for is the safe direction: the alternative to
 *    running is a block that outlives its own stated lifetime. The interval defaults to a
 *    minute and `SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES=0` is the explicit off switch.
 *  - **A failed sweep is logged and the next one is due on time.** `sweepExpired` touches a
 *    database and the evidence chain, and either can fail. Letting a rejection escape the
 *    timer would end the process; swallowing it silently would leave an action in force past
 *    its deadline with nothing on the console explaining why. The error goes to the caller's
 *    log and the loop continues.
 *  - **Sweeps do not overlap.** A second pass that started while the first was still writing
 *    could read the same due action and rely on `lift`'s own state check to decline it; the
 *    running flag makes non-overlap a property of this loop rather than a hope about the
 *    store.
 *  - **The clock and the timer are injected**, so the loop is tested without waiting — the
 *    same seam `access-review-scheduler.ts` takes, for the same reason.
 */

import type { EnforcementService } from "./enforcement-service";

/** The shortest interval this will honour. Below it, the timer is a busy loop. */
export const MIN_ENFORCEMENT_SWEEP_INTERVAL_MS = 10_000;

/** What a deployment that has not configured one gets: a minute. */
export const DEFAULT_ENFORCEMENT_SWEEP_INTERVAL_MS = 60_000;

export interface EnforcementSchedulerOptions {
  /** How often to sweep. At least `MIN_ENFORCEMENT_SWEEP_INTERVAL_MS`. */
  intervalMs: number;
  /** Called with what each sweep lifted, and with each failure. */
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

export interface EnforcementScheduler {
  /** Run one sweep now. Never throws: failures are reported through the options. */
  runOnce(): Promise<void>;
  /** Stop the timer. Safe to call more than once. */
  stop(): void;
}

/**
 * What `SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES` means.
 *
 * Unset is **on**, at a minute — see the header for why expiry defaults the other way from
 * scheduled attestation. An explicit `0`, a negative number or anything unparseable is
 * **off**, which is the operator saying they will drive the sweep themselves; a positive
 * value is honoured down to the floor, and clamped rather than refused because an operator
 * who typed `0.1` meant “as often as you can” and the honest answer is the shortest sweep
 * this will run.
 */
export function enforcementSweepIntervalMs(env: Record<string, string | undefined>): number | null {
  const raw = env.SENTINEL_ENFORCEMENT_SWEEP_INTERVAL_MINUTES?.trim();
  if (raw === undefined || raw === "") return DEFAULT_ENFORCEMENT_SWEEP_INTERVAL_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(MIN_ENFORCEMENT_SWEEP_INTERVAL_MS, Math.round(minutes * 60_000));
}

/**
 * Start the loop.
 *
 * The returned handle's `stop` clears the timer; a deployment's shutdown calls it so a test
 * or a restart does not leave a sweep in flight against a closing client.
 */
export function startEnforcementScheduler(
  service: Pick<EnforcementService, "sweepExpired">,
  options: EnforcementSchedulerOptions,
): EnforcementScheduler {
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
      if (report.lifted.length > 0) {
        options.log(
          `lifted ${report.lifted.length} action(s) whose deadline had passed: ${report.lifted.join(", ")}`,
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
  // Do not hold the process open on a timer whose only job is to lift expired actions.
  timer.unref?.();

  options.log(`expiry sweep is on, every ${Math.round(options.intervalMs / 1000)}s`);

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
