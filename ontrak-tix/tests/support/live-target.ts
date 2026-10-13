/**
 * The address an opt-in live test is allowed to drive.
 *
 * The live tests in this directory are the only ones that write to a *running* desk:
 * they provision tenants, raise escalations, purge evidence files and push people to
 * a provider. They are opt-in through `ONTRAK_TIX_BASE_URL`, and that is enough for
 * a test — but not enough for the file it reads.
 *
 * `.env` is where a deployment records its own public name, and `ONTRAK_TIX_BASE_URL`
 * is one of the variables it holds: `https://tix.ontrak.innotel.us`, the desk's real
 * address. So on a machine with a filled-in `.env` — which is every machine that runs
 * the desk — the variable is *already set*, the live tests stop skipping, and
 * `npm test` provisions throwaway tenants on the production desk and purges artifacts
 * there. That is not a hypothesis; it is what a local run did, and the four failures it
 * produced looked like a code defect rather than the environment being read.
 *
 * CI has no `.env` (it is gitignored), so it never saw any of this and the failure only
 * ever appeared on the machines closest to production.
 *
 * So a live test asks this module first. Loopback is allowed, because that is a desk
 * somebody started on purpose to test against. Anything else is refused *unless* the
 * run says so out loud with {@link ALLOW_REMOTE_LIVE} — because a rehearsal desk on the
 * LAN is a legitimate target, and only the person running it knows which it is. The
 * refusal is a `skip`, not a failure: the suite is opt-in throughout, and a suite that
 * fails on a developer's machine for reading that machine's configuration is a suite
 * people learn to ignore. It is a loud skip, naming the address and the switch.
 */

/** Hosts that mean "the app on this machine". An IPv6 loopback arrives bracketed. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The switch that says a non-loopback address is a desk this run means to write to.
 * Deliberately its own variable, and deliberately not the base URL: the point is that
 * writing to a remote desk has to be *said*, in a second place, by a person.
 */
export const ALLOW_REMOTE_LIVE = "ONTRAK_TIX_LIVE_ALLOW_REMOTE";

/** The spellings of "yes" this reads, matching the product's other switches. */
function optedIn(): boolean {
  const value = (process.env[ALLOW_REMOTE_LIVE] ?? "").trim().toLowerCase();
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
 * Why a live test must not drive `url`, or null when it may.
 *
 * `variable` is the environment variable the address came from, so the refusal can name
 * the thing to change rather than just the host. An unset address is *not* a refusal —
 * "nothing configured" is the caller's own skip to explain, and this module only judges
 * addresses that exist.
 */
export function liveRefusal(variable: string, url: string | null | undefined): string | null {
  if (!url) return null;

  const host = hostOf(url);
  if (host === null) {
    return `refusing to drive ${variable}: "${url}" is not a URL this test can read.`;
  }
  if (LOOPBACK.has(host) || host.endsWith(".localhost")) return null;
  if (optedIn()) return null;

  return (
    `refusing to drive ${host}: a live test writes real rows, and that address is not this machine. ` +
    `Point ${variable} at a desk you started here (http://127.0.0.1:3001), or set ` +
    `${ALLOW_REMOTE_LIVE}=1 to say ${host} is a rehearsal desk you mean to write to.`
  );
}
