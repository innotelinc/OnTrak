/**
 * The portal's rules — pure, dependency-free, and unit-tested.
 *
 * This file is the *product decision* for the whole OnTrak family: which products
 * exist, who belongs in each, and what a person is shown when they arrive. It is
 * deliberately the only place that answers those questions, and it is deliberately
 * free of React, `fetch` and anything else, so the answer can be asserted in a
 * test rather than inferred from a screenshot.
 *
 * WHY THE PORTAL ROUTES BY ROLE AND NOT BY PERMISSION LIST
 * --------------------------------------------------------
 * Each product already enforces its own authorisation — the training range checks
 * the caller on every server action, the desk scopes an agent to their clients,
 * Sentinel owns the directory, and Sync checks a capability on every route. A
 * second authorisation system in the portal would be a second thing to be wrong,
 * and the more dangerous of the two would be the one people trusted.
 *
 * So the portal decides *where to send somebody*, never *what they may do there*.
 * A tile it declines to draw is a courtesy; the product it points at is still the
 * thing that refuses. The one exception is a tile for a product a person has no
 * business in at all — showing that is not merely useless, it teaches people that
 * the refusal they then get is normal.
 *
 * THE FOUR FAMILY ROLES, AND ONE VOCABULARY
 * -----------------------------------------
 * `ADMIN SYSADMIN ANALYST TECHNICIAN INSTRUCTOR STUDENT` is the same list
 * OnTrak Sync stores and OnTrak's training app maps its Authentik groups onto.
 * Authentik is the source of truth; this vocabulary is what the group names are
 * translated into, once, at the edge of the system.
 */

export type Role =
  | "ADMIN"
  | "SYSADMIN"
  | "ANALYST"
  | "TECHNICIAN"
  | "INSTRUCTOR"
  | "STUDENT";

/** The keys are also the subdomain labels — see `urlFor`. */
export type ProductKey = "its" | "tix" | "sentinel" | "sync" | "genie";

export interface Product {
  key: ProductKey;
  /** What it is called on the tile. */
  name: string;
  /** One line, in the product's own words, saying what it is for. */
  tagline: string;
  /** The role the tile is aimed at, for the ordering sentence. */
  audience: string;
  /** The subdomain label. `<label>.ontrak.innotel.us`, or the apex for the portal. */
  host: string;
  /** Which roles are shown this product. */
  roles: readonly Role[];
  /** A colour family, so the tiles are distinguishable at a glance. */
  tone: "training" | "desk" | "security" | "operations" | "agent";
  /**
   * Where to read a one-line status from, relative to the product's own origin.
   * Absent where the product has no unauthenticated endpoint to ask — and an
   * absent probe is reported as "not checked", never as "up", because a green
   * light nobody tested is worse than no light.
   */
  health?: string;
}

export const PRODUCTS: readonly Product[] = [
  {
    key: "its",
    name: "OnTrak IT Support Training",
    tagline:
      "Browser-based, automatically-graded practice: fix deliberately broken Linux, Windows and Office machines.",
    audience: "students and instructors",
    host: "its",
    roles: ["STUDENT", "INSTRUCTOR", "ADMIN"],
    tone: "training",
    health: "/health",
  },
  {
    key: "tix",
    name: "OnTrak Tix",
    tagline:
      "The service desk: tickets, SLAs, clients, billing, and insurance-grade incident evidence.",
    audience: "technicians",
    host: "tix",
    roles: ["TECHNICIAN", "ADMIN", "SYSADMIN"],
    tone: "desk",
    health: "/health",
  },
  {
    key: "sentinel",
    name: "OnTrak Sentinel",
    tagline:
      "Identity provider and intrusion detection: who somebody is, and whether they should be on the network.",
    audience: "analysts",
    host: "sentinel",
    roles: ["ANALYST", "ADMIN", "SYSADMIN"],
    tone: "security",
    health: "/health",
  },
  {
    key: "sync",
    name: "OnTrak Sync",
    tagline:
      "The Network's package and container update view, and the one place that installs what a person approved.",
    audience: "sysadmins",
    host: "sync",
    roles: ["SYSADMIN", "ADMIN"],
    tone: "operations",
    health: "/health",
  },
  {
    key: "genie",
    name: "OnTrak Genie",
    tagline:
      "The browser coding console: choose a folder, describe the change, and watch an agent read, edit and run code in it.",
    audience: "sysadmins and builders",
    host: "genie",
    // It can read, write and run code, so it is deliberately the narrowest
    // audience in the family rather than the widest.
    roles: ["SYSADMIN", "ADMIN"],
    tone: "agent",
    // Every product answers `/health` without a credential; the console is no
    // exception, and it reports without starting a turn or touching the gateway.
    health: "/health",
  },
];

/** The portal itself, for the address bar and for `redirect_uri`. */
export const PORTAL_KEY = "portal";

export const ROLES: readonly Role[] = [
  "ADMIN", "SYSADMIN", "ANALYST", "TECHNICIAN", "INSTRUCTOR", "STUDENT",
];

/** The order roles are ranked in when a group list maps to more than one. */
const ROLE_RANK: Record<Role, number> = {
  STUDENT: 0, INSTRUCTOR: 1, TECHNICIAN: 2, ANALYST: 3, SYSADMIN: 4, ADMIN: 5,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Coerce anything to a role, failing towards the *least* privileged one.
 *
 * A missing or misspelled role in an assertion is a configuration fault, and the
 * safe response to a fault is to grant nothing, not everything.
 */
export function asRole(value: unknown, fallback: Role = "STUDENT"): Role {
  if (typeof value !== "string") return fallback;
  const upper = value.trim().toUpperCase();
  return isRole(upper) ? upper : fallback;
}

export function product(key: string): Product | null {
  return PRODUCTS.find((entry) => entry.key === key) ?? null;
}

/**
 * The address of a product.
 *
 * `baseDomain` is configuration and defaults to the Network's real name, so a
 * deployment that has not been told otherwise still produces a link that resolves
 * rather than a relative path that silently 404s on the portal's own origin.
 */
export function urlFor(entry: Product, baseDomain = "ontrak.innotel.us", secure = true): string {
  return `${secure ? "https" : "http"}://${entry.host}.${baseDomain}`;
}

/** The products a role belongs in, in catalogue order. */
export function productsFor(role: Role): Product[] {
  return PRODUCTS.filter((entry) => entry.roles.includes(role));
}

export function canOpen(role: Role, key: ProductKey): boolean {
  const entry = product(key);
  return entry !== null && entry.roles.includes(role);
}

/**
 * Where a person should be sent by default.
 *
 * The *most specific* product for the role rather than the first match: an
 * administrator belongs everywhere, and landing them on the training range when
 * they came to do Network maintenance is landing them in the wrong application.
 * `workspaces` lists the product keys a person is here for, most-preferred first,
 * and the catalogue order is the tie-break.
 */
export function landingFor(role: Role, preferred: readonly ProductKey[] = []): Product | null {
  const allowed = productsFor(role);
  if (allowed.length === 0) return null;
  for (const key of preferred) {
    const match = allowed.find((entry) => entry.key === key);
    if (match) return match;
  }
  // With one product there is no choice to make; with several, prefer the one
  // whose audience names this role rather than the one it merely tolerates.
  const specific = allowed.find((entry) => entry.audience.startsWith(
    role.toLowerCase().replace("sysadmin", "sysadmins")));
  return specific ?? allowed[0];
}

/**
 * Map a provider's groups to a family role.
 *
 * The highest-ranked match wins, not the first: Authentik returns group lists in
 * no guaranteed order, and "first match" would make somebody's role depend on a
 * sort. Returning the matched group lets the UI say *why* a person has the role
 * they do, which is the question an administrator asks when the answer looks
 * wrong.
 */
export function roleFromGroups(
  groups: readonly string[],
  mappings: Record<string, Role>,
  fallback: Role = "STUDENT",
): { role: Role; matched: string | null } {
  let best: { role: Role; matched: string } | null = null;
  for (const group of groups) {
    const key = group.trim().toLowerCase();
    const mapped = mappings[key];
    if (!mapped) continue;
    if (best === null || ROLE_RANK[mapped] > ROLE_RANK[best.role]) {
      best = { role: mapped, matched: group };
    }
  }
  return best ?? { role: fallback, matched: null };
}

/**
 * Parse `ONTRAK_PORTAL_ROLE_MAPPINGS` — one `group=ROLE` per line.
 *
 * The same syntax as the training app's and OnTrak Sync's, because an operator
 * who has configured one OnTrak product should not have to learn a second one for
 * the next. An unknown role name is dropped, never guessed: a typo that silently
 * granted ADMIN is worse than a typo that grants nothing.
 */
export function parseRoleMappings(raw: string): Record<string, Role> {
  const mappings: Record<string, Role> = {};
  for (const line of (raw || "").split(/[\n,]/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const group = trimmed.slice(0, index).trim().replace(/^["']|["']$/g, "").toLowerCase();
    const role = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "").toUpperCase();
    if (group && isRole(role)) mappings[group] = role;
  }
  return mappings;
}

/** A tile as the dashboard renders it. */
export interface Tile {
  key: ProductKey;
  name: string;
  tagline: string;
  url: string;
  tone: Product["tone"];
  /** The product this person is mainly here for; drawn first and marked. */
  primary: boolean;
  health: string | null;
}

/**
 * The dashboard for a role.
 *
 * An empty array is a legitimate answer and the page has to say so in words. A
 * grid of nothing reads as a broken portal; "your account has no product yet, ask
 * an administrator to put you in a group" is the actual situation, and the person
 * reading it can act on it.
 */
export function tilesFor(
  role: Role,
  options: { baseDomain?: string; secure?: boolean; preferred?: readonly ProductKey[] } = {},
): Tile[] {
  const landing = landingFor(role, options.preferred ?? []);
  return productsFor(role).map((entry) => ({
    key: entry.key,
    name: entry.name,
    tagline: entry.tagline,
    url: urlFor(entry, options.baseDomain ?? "ontrak.innotel.us", options.secure ?? true),
    tone: entry.tone,
    primary: landing !== null && landing.key === entry.key,
    health: entry.health ?? null,
  }));
}

/**
 * One product's liveness, as the dashboard knows it. `unknown` is a first-class
 * answer here too: "we could not ask" is not "it is down", and the dashboard must
 * never paint the two the same.
 */
export type ReachabilityLike = "up" | "down" | "unknown";

export interface FleetStatusEntry {
  reachability: ReachabilityLike;
  detail: string;
}

export interface FleetAttention extends FleetStatusEntry {
  key: ProductKey;
  name: string;
}

export interface FleetSummary {
  total: number;
  up: number;
  down: number;
  unknown: number;
  /** Products that are not answering, worst first — down before not-checked. */
  attention: FleetAttention[];
  /** One sentence for the top of the dashboard. */
  headline: string;
}

/** Down sorts before unknown: a fact before an absence. */
function attentionRank(reachability: ReachabilityLike): number {
  return reachability === "down" ? 0 : reachability === "unknown" ? 1 : 2;
}

/**
 * Roll a set of tiles and their statuses into one sentence and one list.
 *
 * The dashboard draws a light per tile, which answers "is this one up". A person
 * arriving at the front door asks the other question first — "is the family
 * healthy" — and reading four lights to answer it is the work this does for them.
 * It is pure so the sentence cannot disagree with the lights: both are computed
 * from the same map, and a product with no entry counts as *not checked* rather
 * than as up, because a green light nobody tested is the failure the family was
 * built to remove.
 */
export function summarizeFleet(
  tiles: readonly Pick<Tile, "key" | "name">[],
  statuses: ReadonlyMap<string, FleetStatusEntry | undefined>,
): FleetSummary {
  let up = 0;
  let down = 0;
  let unknown = 0;
  const attention: FleetAttention[] = [];

  for (const tile of tiles) {
    const status = statuses.get(tile.key);
    if (!status) {
      unknown += 1;
      attention.push({ key: tile.key, name: tile.name, reachability: "unknown", detail: "not checked" });
      continue;
    }
    if (status.reachability === "up") {
      up += 1;
      continue;
    }
    if (status.reachability === "down") down += 1;
    else unknown += 1;
    attention.push({ key: tile.key, name: tile.name, reachability: status.reachability, detail: status.detail });
  }

  attention.sort((a, b) => attentionRank(a.reachability) - attentionRank(b.reachability));

  const total = tiles.length;
  let headline: string;
  if (total === 0) headline = "no products for this role";
  else if (down === 0 && unknown === 0) headline = `all ${total} product${total === 1 ? "" : "s"} answering`;
  else if (up === 0 && down === 0) headline = "no product could be checked";
  else headline = `${up} of ${total} answering · ${down} not answering · ${unknown} not checked`;

  return { total, up, down, unknown, attention, headline };
}

/**
 * The groups a session carries, and the role they produce *now*.
 *
 * The signed cookie holds the groups the provider sent at sign-in, plus the role that
 * was derived from them at the time. Keeping the role there was the bug: a *role* is a
 * derived value, so a long-lived cookie holding one is a cache with no invalidation.
 * Add somebody to `ontrak-admins` after they signed in and they stayed a STUDENT for
 * the rest of the cookie's twelve hours, with nothing on any page explaining why.
 *
 * So the derivation lives here, as a pure function of (groups, mapping, fallback), and
 * `readSession` calls it on every read. A mapping change takes effect on the next page
 * load. Only a change to *whose groups somebody is in* needs a fresh handshake, because
 * only the provider knows that — which is what the masthead's "Refresh permissions" is
 * for.
 *
 * The session's stored role is the fallback when the re-derivation finds nothing: a
 * session minted before this existed, or by the Sync or break-glass paths (which have
 * no groups at all) still has to work. `null` means "leave it alone", so a caller does
 * not accidentally demote somebody to the default on an empty group list.
 */
export function roleForGroups(
  groups: readonly string[],
  mappings: Record<string, Role>,
  fallback: Role,
): { role: Role; matched: string | null } | null {
  if (groups.length === 0) return null;
  return roleFromGroups(groups, mappings, fallback);
}

/**
 * Whether re-deriving would change anything.
 *
 * Separate from the derivation so `readSession` can return the *same object* on the
 * overwhelmingly common no-op path — a new object per request would make every server
 * component downstream see a changed dependency for no reason.
 */
export function roleChanged(
  before: { role: Role; matched_group?: string | null },
  after: { role: Role; matched: string | null },
): boolean {
  return after.role !== before.role || after.matched !== (before.matched_group ?? null);
}

/** What the page says when a person belongs nowhere yet. */
export function emptyStateFor(role: Role): string {
  return role === "STUDENT"
    ? "Your account is signed in but is not in a class yet. An instructor or an "
      + "administrator needs to add you to a cohort in the training range."
    : `No product is mapped to the ${role} role in this deployment. An administrator `
      + "can grant one in Cerulean (the identity provider), where group membership "
      + "decides the role.";
}
