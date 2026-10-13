/**
 * The address an end-to-end sweep is allowed to drive.
 *
 * The two browser sweeps under `tests/browser/` are the only specs here that drive a
 * *real* deployment: they sign in, file tickets, declare incidents, store evidence and
 * claim a rollout remit. Every one of those is a write. They are opt-in through a base
 * URL — `ONTRAK_TIX_BASE_URL`, `ONTRAK_SYNC_BASE_URL` — and that is enough for a test
 * but not enough for the file the variable also lives in.
 *
 * `.env` is where a deployment records its own addresses, and this repository's root
 * `.env` holds the desk's real one: `ONTRAK_TIX_BASE_URL="https://tix.ontrak.innotel.us"`.
 * So a shell that has sourced it — which is how a person runs a command against this
 * deployment — turns a sweep into a production write, and the sweep looks like it passed.
 * The unit-level live files had exactly this bug and it is fixed there
 * (`ontrak-tix/tests/support/live-target.ts`); this is the same rule for the browser
 * surface, which reaches further because it drives the UI rather than the API.
 *
 * Loopback is allowed, because that is a deployment somebody started on purpose to sweep.
 * Anything else is refused unless the run says so out loud with
 * {@link ALLOW_REMOTE} — a rehearsal box on the LAN is a legitimate target, and only the
 * person running it knows which it is.
 *
 * The refusal is a `skip`, not a failure, matching the sweeps' own opt-in design: a suite
 * that fails on a checkout for reading that checkout's configuration is one people learn
 * to ignore. It is a loud skip, naming the address and the switch.
 *
 * This is deliberately *not* copied to the Sync and Sentinel suites, because neither reads
 * an address this repository records: no `.env` sets `ONTRAK_SYNC_BASE_URL`, and Sentinel's
 * live test reads `DATABASE_URL`, which no `.env` sets. Their address has to be named by
 * the operator, which is already the deliberate act this guard exists to require.
 */

/** Hosts that mean "the app on this machine". An IPv6 loopback arrives bracketed. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The switch that says a non-loopback address is a deployment this run means to write to.
 * Its own variable, and deliberately not the base URL: writing to a remote deployment has
 * to be *said*, in a second place, by a person.
 */
export const ALLOW_REMOTE = "ONTRAK_E2E_ALLOW_REMOTE";

/** The spellings of "yes" this reads, matching the family's other switches. */
function optedIn(): boolean {
  const value = (process.env[ALLOW_REMOTE] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** The hostname of a URL, without IPv6 brackets and lower-cased, or null if unreadable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why a sweep must not drive `url`, or null when it may.
 *
 * `variable` is the environment variable the address came from, so the refusal can name
 * the thing to change rather than just the host. An unset address is *not* a refusal —
 * "nothing configured" is the spec's own skip to explain, and this only judges addresses
 * that exist.
 */
export function liveRefusal(variable: string, url: string | null | undefined): string | null {
  if (!url) return null;

  const host = hostOf(url);
  if (host === null) {
    return `refusing to drive ${variable}: "${url}" is not a URL this sweep can read.`;
  }
  if (LOOPBACK.has(host) || host.endsWith(".localhost")) return null;
  if (optedIn()) return null;

  return (
    `refusing to drive ${host}: this sweep signs in and writes, and that address is not this machine. ` +
    `Point ${variable} at a deployment you started here, or set ${ALLOW_REMOTE}=1 to say ` +
    `${host} is a rehearsal deployment you mean to write to.`
  );
}
