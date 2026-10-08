/**
 * The lab (OnTrak-dev) as a capability *this* app can offer — read once, from the
 * environment, and never guessed at.
 *
 * OnTrak grades simulated machines in the browser; the lab grades real ones it
 * stands up on a hypervisor. They are the same training done two ways, so a
 * student who belongs in one belongs in both — but the lab runs on a host this
 * deployment may not have, and it is a separate Python service rather than a
 * route in here. So the rule is deliberately conservative: **the lab is off
 * unless an operator turns it on and says where it is.** An unconfigured
 * deployment behaves exactly as it did before this file existed.
 *
 * Three decisions worth stating out loud.
 *
 * **Enabled and located are two facts, and both are required for a link.** A
 * deployment can set `ONTRAK_LAB_ENABLED` before it has an address, or set the
 * address before it wants students there; either way there is nothing safe to
 * render. `enabled` without a URL is reported as an issue rather than silently
 * drawing a dead link, which is the same stance the integrations panel takes.
 *
 * **The link carries no identity, on purpose.** The lab authenticates a student
 * through the family's own sign-in (see §6/C5 of the audit) — the deep link only
 * puts them in front of it. A query parameter carrying a subject or an address
 * would be a second, weaker identity path, and the one the family would then have
 * to trust.
 *
 * **A scenario is the lab's only when it says so.** The marker is a tag, because a
 * tag is what a scenario already carries and what an author can set today; nothing
 * here infers \"real machine\" from a platform or a title. Until a scenario is
 * tagged, no lab affordance is drawn — which is what makes this step revertable by
 * unsetting one variable.
 *
 * Pure — no fetch, no database — so every state is cheap to assert.
 */

/** The switch. Unset or false means the lab is not offered. */
export const LAB_ENABLED_ENV = "ONTRAK_LAB_ENABLED";
/** The lab's base address, e.g. `https://lab.ontrak.innotel.us`. */
export const LAB_URL_ENV = "ONTRAK_LAB_URL";
/** The tag a scenario carries when it is run on a real machine rather than simulated. */
export const LAB_SCENARIO_TAG = "lab";
/** Where a student lands in the lab: its dashboard, which lists and starts sessions. */
export const LAB_DASHBOARD_PATH = "/dashboard";

export interface LabConfig {
  /** Whether a lab affordance may be drawn at all. */
  enabled: boolean;
  /** The lab's origin, or `null` when it is off or misconfigured. */
  url: string | null;
  /** Why a configured value was refused, or why an enabled lab has nowhere to go. */
  issues: string[];
}

/**
 * One variable, unquoted.
 *
 * `.env` has three readers that disagree about quotes — compose unquotes,
 * `docker run --env-file` does not, and a shell that sources the file does — so a
 * value is stripped once here, the same convention the rest of the app uses.
 */
function read(env: Record<string, string | undefined>, name: string): string {
  const raw = (env[name] ?? "").trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).trim();
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).trim();
  return raw;
}

/** The truthy spellings the family's other switches accept. */
const TRUTHY = ["1", "true", "yes", "on"];

export function labConfigFromEnv(env: Record<string, string | undefined> = process.env): LabConfig {
  const enabled = TRUTHY.includes(read(env, LAB_ENABLED_ENV).toLowerCase());
  if (!enabled) return { enabled: false, url: null, issues: [] };

  const raw = read(env, LAB_URL_ENV);
  if (!raw) {
    return { enabled: true, url: null, issues: [`${LAB_URL_ENV} is not set, so there is no lab to open.`] };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { enabled: true, url: null, issues: [`${raw} is not an absolute URL.`] };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { enabled: true, url: null, issues: [`${raw} is not an http(s) URL.`] };
  }

  // The origin rather than the raw value: a base URL carrying a path or a trailing
  // slash would otherwise double a segment when the dashboard path is appended.
  return { enabled: true, url: parsed.origin, issues: [] };
}

/**
 * Where a student goes to run this scenario on a real machine, or `null` when the
 * lab is off or was configured in a way that leaves nowhere to go.
 *
 * The dashboard rather than a start URL, because the lab starts a session with a
 * POST against a scenario it has itself validated; a GET the portal invented would
 * either 405 or start something the lab never agreed to. The student arrives, the
 * lab signs them in against the same provider, and picks up where they left off.
 */
export function labSessionUrl(config: LabConfig): string | null {
  return config.enabled && config.url ? `${config.url}${LAB_DASHBOARD_PATH}` : null;
}

/**
 * Whether a scenario runs on a real machine.
 *
 * Exact, case-insensitive tag match — never a substring — so a scenario tagged
 * `cyber-lab` or `laboratory` is not quietly promoted onto a hypervisor it was
 * never written for.
 */
export function isLabScenario(tags: readonly string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.some((tag) => tag.trim().toLowerCase() === LAB_SCENARIO_TAG);
}

/**
 * Why a simulated attempt at this scenario must be refused, or `null` when it may start.
 *
 * The one thing a lab scenario cannot do here is be simulated, and the reason is a
 * fact about its definition rather than a policy: an imported lab scenario carries
 * **no checks** on purpose (see `lab-scenario-import.ts` — the lab grades its
 * objectives against a live machine, and nothing in its YAML says which live
 * condition an objective tests, so inventing checks would score a student on
 * something nobody authored). An attempt started anyway would grade nothing and
 * record a score, while `gradingModeForTags` labelled that record `lab` — because
 * the mode is read from this same tag. The evidence would then say a real machine
 * decided something no machine touched, which is the single failure §9/Q7 exists to
 * prevent.
 *
 * So this is the rule both halves of the seam ask: the student page asks it to know
 * which door to draw, and `startAttempt` asks it before creating anything, because a
 * rule only the page checks is a rule a POST can walk past.
 */
export function simulatedStartRefusal(tags: readonly string[] | null | undefined): string | null {
  if (!isLabScenario(tags)) return null;
  return (
    "This scenario is run and graded on a real machine in OnTrak Lab, and it has no " +
    "simulated checks, so there is nothing here to grade. Open it from the lab door instead."
  );
}
