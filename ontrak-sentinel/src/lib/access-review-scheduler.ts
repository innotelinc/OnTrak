/**
 * Access reviews (S2): the clock that opens the reviews a schedule promised.
 *
 * A schedule that is never ticked is a note in a table rather than an attestation, so
 * this is the part that makes “quarterly” mean something. It is small on purpose, and
 * every choice in it is about a failure that would be silent:
 *
 *  - **A failed tick is logged and the next one is due on time.** `tick` touches a
 *    database, an identity store and the evidence chain, and every one of those can
 *    fail. Letting the rejection escape a timer would end the process — a deployment
 *    that loses its scheduler to one bad night has no way to say so — and swallowing it
 *    silently would leave the register empty with nothing on the console explaining why.
 *    The error goes to the caller's log and the loop continues.
 *  - **Ticks do not overlap.** `tick` reads a schedule and advances `nextRunAt` after it
 *    has opened the review; a second pass that starts while the first is still on the
 *    database can read the same due row and would have to rely on `scheduleTick` to
 *    decline it. The running flag makes that a property of this loop rather than a hope
 *    about the store.
 *  - **The interval is configuration, and zero is off.** A deployment that would rather
 *    drive the tick from cron — or that wants no scheduled reviews at all — should not
 *    have to run a process it does not want. `null` from the env loader is that switch,
 *    and it is explicit: nothing here guesses a default that quietly opens reviews.
 *
 * The clock and the timer are injected, so the loop is testable without waiting.
 */

import type { AccessReviewService } from "./access-review-service";

/** The shortest tick this will honour. Below it, the timer is a busy loop. */
export const MIN_SCHEDULER_INTERVAL_MS = 30_000;

export interface AccessReviewSchedulerOptions {
  /** How often to look. At least `MIN_SCHEDULER_INTERVAL_MS`. */
  intervalMs: number;
  /** Called with each review opened, and with each failure. */
  log(message: string): void;
  /** Called when a tick throws. Defaults to `log`. */
  onError?(error: unknown): void;
  /** Epoch milliseconds, so a test can drive it. */
  now?: () => number;
  /**
   * The timer itself. Defaults to `setInterval`, and is injectable for the same reason
   * the clock is: a test that waits for a real five-millisecond interval is a test that
   * fails on a loaded machine, and a scheduler whose loop is only exercised by luck is
   * one whose loop is not exercised.
   */
  setTimer?: (callback: () => void, intervalMs: number) => { unref?: () => void };
  /** Defaults to `clearInterval`. */
  clearTimer?: (handle: unknown) => void;
}

export interface AccessReviewScheduler {
  /** Run one tick now. Never throws: failures are reported through the options. */
  runOnce(): Promise<void>;
  /** Stop the timer. Safe to call more than once. */
  stop(): void;
}

/**
 * What `SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES` means.
 *
 * `null` — nothing configured — is *off*, and that is the deliberate default. A tick
 * opens reviews in **every** organization in the deployment, so a product that opened
 * attestations nobody asked for on first boot would be doing so uninvited; the operator
 * who wants scheduled attestation turns it on, and one that leaves it off keeps every
 * path to an access review (opening one by hand, answering it, closing it) working.
 */
export function accessReviewIntervalMs(env: Record<string, string | undefined>): number | null {
  const raw = env.SENTINEL_ACCESS_REVIEW_INTERVAL_MINUTES?.trim();
  if (!raw) return null;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  // Clamped rather than refused: an operator who typed 0.1 meant “as often as you can”,
  // and the honest answer to that is the shortest tick this will honour. A value that
  // silently did nothing would be worse than one that runs at the floor and says so.
  return Math.max(MIN_SCHEDULER_INTERVAL_MS, Math.round(minutes * 60_000));
}

/**
 * Start the loop.
 *
 * The returned handle's `stop` clears the timer; a deployment's shutdown calls it so a
 * test or a restart does not leave a tick in flight against a closing client.
 */
export function startAccessReviewScheduler(
  service: Pick<AccessReviewService, "tick">,
  options: AccessReviewSchedulerOptions,
): AccessReviewScheduler {
  const now = options.now ?? Date.now;
  const reportError = options.onError ?? ((error: unknown) => options.log(`tick failed: ${describe(error)}`));
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    // Overlapping passes are refused here rather than left to the store: see the header.
    if (running) {
      options.log("the previous tick is still running, so this one was skipped");
      return;
    }
    running = true;
    try {
      const report = await service.tick(now());
      for (const opened of report.opened) {
        options.log(
          opened.missed > 1
            ? `opened ${opened.reviewId} for schedule ${opened.scheduleId}, ${opened.missed} intervals late`
            : `opened ${opened.reviewId} for schedule ${opened.scheduleId}`,
        );
      }
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
    }
  }

  // The interval is the caller's: the floor belongs to `accessReviewIntervalMs`, which is
  // the configuration path, and a deployment that wires this by hand is expected to know
  // what it is asking for. Clamping here as well would hide a mistake rather than refuse it.
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const timer = setTimer(() => {
    if (!stopped) void runOnce();
  }, options.intervalMs);
  // Do not hold the process open on a timer whose only job is to open reviews: a
  // deployment that has finished shutting down should exit.
  timer.unref?.();

  options.log(`scheduled attestation is on, every ${Math.round(options.intervalMs / 1000)}s`);

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
