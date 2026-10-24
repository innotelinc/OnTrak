import { rememberSession } from "./sessions.js";

const RUN_GRACE_MS = 5_000;
const IDLE_ABORT_MS = 10_000;

/** turn key -> run */
const runs = new Map();

/**
 * One agent turn, shared by every racer that asked for it.
 *
 * `append` is the only way text joins the answer: it notifies each attached
 * response, and a response that has gone away is handled by its own close
 * listener rather than here.
 */
export function createRun(fields) {
  const run = {
    ...fields,
    text: "",
    done: false,
    sessionId: "",
    controller: null,
    timer: null,
    idleTimer: null,
    listeners: new Set(),
    resolve: null,
  };
  run.finished = new Promise((resolve) => {
    run.resolve = resolve;
  });
  run.append = (text) => append(run, text);
  runs.set(run.key, run);
  return run;
}

export function runFor(key) {
  return runs.get(key);
}

function append(run, text) {
  if (typeof text !== "string" || text === "" || run.done) return;
  run.text += text;
  for (const listener of run.listeners) {
    try {
      listener();
    } catch {
      // A browser that went away is handled by the close listener.
    }
  }
}

export function finish(run) {
  if (run.done) return;
  run.done = true;
  if (run.timer) clearTimeout(run.timer);
  if (run.idleTimer) clearTimeout(run.idleTimer);
  if (run.sessionId) rememberSession(run.sessionKey, run.sessionId);
  for (const listener of run.listeners) {
    try {
      listener();
    } catch {
      // As above: the detached listener is not this run's problem.
    }
  }
  run.resolve();
  setTimeout(() => {
    if (runs.get(run.key) === run) runs.delete(run.key);
  }, RUN_GRACE_MS).unref?.();
}

export function detach(run, listener) {
  run.listeners.delete(listener);
  if (run.listeners.size > 0 || run.done) return;
  // Every racer has gone (the winner exited early, or Stop was pressed). Give a
  // straggler a moment to join, then stop paying for a turn nobody is reading.
  run.idleTimer = setTimeout(() => {
    if (run.listeners.size === 0 && !run.done) {
      try {
        run.controller?.abort();
      } catch {
        // Already finished.
      }
    }
  }, IDLE_ABORT_MS);
  run.idleTimer.unref?.();
}

/** Test hook: stop every in-flight turn and forget the registry. */
export function abortRuns() {
  for (const run of runs.values()) {
    try {
      run.controller?.abort();
    } catch {
      // Already gone.
    }
  }
  runs.clear();
}
