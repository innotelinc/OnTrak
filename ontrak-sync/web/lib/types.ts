/**
 * Types for the Ontrak Sync API.
 *
 * These mirror `backend/ontrak/api.py`. The one worth keeping in mind is
 * `Summary.unknown`: the dashboard shows it next to the pending count rather than
 * folding it in, because "we could not look" and "nothing to do" are the two
 * answers this tool exists to keep apart.
 */

export type Manager = "apt" | "snap" | "docker";

export type FindingStatus = "pending" | "approved" | "applied" | "failed" | "skipped";

/** The family's shared role vocabulary, as `backend/ontrak/identity.py` defines it. */
export type Role =
  | "ADMIN"
  | "SYSADMIN"
  | "ANALYST"
  | "TECHNICIAN"
  | "INSTRUCTOR"
  | "STUDENT";

/**
 * Capabilities, not roles, drive the interface.
 *
 * A page asking "is this person an ADMIN" has to be revisited every time the role
 * table changes; a page asking "may this person apply" does not. The server
 * enforces the same strings, so hiding a button and refusing the call cannot
 * drift apart.
 */
export type Capability =
  | "portal:view"
  | "sync:view"
  | "sync:scan"
  | "sync:approve"
  | "sync:apply"
  | "sync:configure"
  | "users:manage";

/** A product a role is sent to. Keys match the portal's catalogue. */
export type ProductKey = "its" | "tix" | "sentinel" | "sync";

export interface AppUser {
  id: number;
  username: string;
  email: string;
  display_name: string;
  role: Role;
  role_label: string;
  active: boolean;
  /** True when this account signs in through Cerulean and has no local password. */
  external: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  capabilities: Capability[];
  products: ProductKey[];
}

/**
 * What `/api/auth/me` returns: a person, or the deployment token's principal.
 *
 * The two branches are one union rather than two shapes with a flag, because a
 * component that renders a name should not have to decide which one it is holding.
 * The fields the service principal genuinely does not have are optional here and
 * checked with `isService` where the difference matters.
 */
export type Identity =
  | (AppUser & { via: "session" | "cookie"; service?: false })
  | {
      service: true;
      id?: number;
      username: string;
      display_name?: string;
      email?: string;
      role: "SERVICE";
      capabilities: Capability[];
      products: ProductKey[];
      via: "token";
    };

export interface MetaRole {
  name: Role;
  label: string;
  products: ProductKey[];
}

export interface Meta {
  service: string;
  version: string;
  hosts: { name: string; address: string; kind: string; ssh_user: string }[];
  scheduler_enabled: boolean;
  users_exist: boolean;
  sso: { enabled: boolean; provider: string; start_url: string };
  roles: MetaRole[];
}

export interface SignInResult {
  user: AppUser;
  token: string;
  expires_at: string;
}

export interface UserSession {
  id: number;
  user_id: number;
  username: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  address: string | null;
}

export interface Finding {
  id: number;
  manager: Manager;
  package: string;
  current: string | null;
  candidate: string | null;
  security: 0 | 1;
  status: FindingStatus;
  first_seen: string | null;
  last_seen: string | null;
  applied_at: string | null;
  detail: string | null;
  target_id: number;
  host: string;
  kind: string;
  target: string;
  target_error: string | null;
}

export interface Summary {
  hosts: number;
  reachable: number;
  targets: number;
  unscanned: number;
  pending: number;
  approved: number;
  failed: number;
  security: number;
  unknown: number;
  /** Hosts that installed a new kernel and have not restarted since. */
  reboot_required: number;
}

export interface Host {
  name: string;
  address: string;
  kind: string;
  ssh_user: string;
  reachable: 0 | 1;
  os: string | null;
  kernel: string | null;
  container_count: number;
  last_seen: string | null;
  error: string | null;
  /**
   * Whether the machine is waiting for a reboot.
   *
   * Three states and not two, mirroring `scanners.parse_reboot_state`: required,
   * asked-and-clear, and *asked and it could not tell* (`known` 0 with
   * `reboot_checked_at` set). A host that answered "nothing pending" is not the same
   * as one that was never asked, and the dashboard has to say which it is.
   */
  reboot_known: 0 | 1;
  reboot_required: 0 | 1;
  /** Package names, one per line, exactly as the host's own file listed them. */
  reboot_packages: string | null;
  reboot_checked_at: string | null;
  /**
   * When this reboot was first seen, and how many scans have reported it since.
   *
   * The age is the decision: a verdict that has stood for a week is a maintenance
   * window somebody missed, while one that appeared with this scan is ordinary.
   * The window opens on the first answer that says *required* and closes only on an
   * answer that says *clear* — a probe this code could not read neither opens nor
   * closes it, so the age survives a scan that learned nothing. `reboot_since` is
   * null whenever nothing is pending.
   */
  reboot_since: string | null;
  reboot_scans: number;
  targets: number;
  unscanned: number;
  pending: number;
  security: number;
  failed: number;
  /**
   * What the registry would not judge on this host's newest scan, by cause, plus the
   * history behind it. `null` when that scan refused nothing — which is not the same as
   * the host not having been scanned, and the target rows already say which of the two
   * it was.
   */
  registry_refusals: RegistryRefusals | null;
}

/**
 * One stored scan's refusals for a host: how many images went unjudged, and how many of
 * those were the registry throttling rather than refusing.
 */
export interface RegistryRefusalPoint {
  run_id: number;
  total: number;
  rate_limited: number;
}

export interface RegistryRefusals {
  /** The newest scan that recorded anything, by cause. */
  latest: Record<string, number>;
  latest_run: number;
  /** Scans in the window that saw at least one rate-limited image. */
  rate_limited_runs: number;
  /** How many stored runs the history spans. */
  window: number;
  /** The window, oldest first — the shape behind `latest`, for the sparkline. */
  series: RegistryRefusalPoint[];
}

export interface Target {
  id: number;
  host: string;
  kind: string;
  name: string;
  ref: string | null;
  discovered_at: string | null;
  last_scanned_at: string | null;
  error: string | null;
}

export interface Run {
  id: number;
  kind: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  findings: number;
  applied: number;
  failed: number;
  summary: string | null;
}

export interface Event {
  id: number;
  ts: string;
  level: string;
  target_id: number | null;
  run_id: number | null;
  /** Who caused it, when a person did. `null` for the timer and the probes. */
  actor: string | null;
  message: string;
}

export interface Policy {
  mode: "detect" | "auto";
  schedule: string;
  enabled: boolean;
  timezone: string;
  scopes: Manager[];
  security_only: boolean;
  window_start_hour: number | null;
  window_end_hour: number | null;
  max_concurrent: number;
  host_ids: number[];
  /** A change freeze, inclusive ISO dates (`YYYY-MM-DD`), or empty for none. */
  freeze_from: string;
  freeze_to: string;
  description: string;
  next_runs: string[];
}

/**
 * How one attempted roll ended, as `container_rolls.state` spells it.
 *
 * `rolled` and `untouched` are the two that do not hold a container back; the other
 * three do, and the distinction is deliberate — see `container_rolls` in the backend.
 * There is no "probably fine": a roll that could not be verified lands on one of the
 * bad two, because the cooldown and the block-after-failure rails both read this.
 */
export type RollState = "rolling" | "rolled" | "rolled-back" | "failed" | "untouched";

/**
 * Who fills the remit, as `ONTRAK_ROLLOUT_ADOPT` spells it.
 *
 * `off` is the shipped posture: the remit is exactly the list a person wrote, and an
 * unclaimed container is shown as `not owned`. `watched` adopts what the scans find and
 * rolls none of it until somebody says so. `unattended` adopts it and rolls it, which is
 * what makes the caps, the window, the freeze and the cooldown the whole of the bound on
 * an unattended restart.
 */
export type AdoptMode = "off" | "watched" | "unattended";

/**
 * A container taken out of the remit by hand.
 *
 * `Release` writes one of these, and on an adopting deployment it is what keeps the
 * decision standing: without it the next pass would find a container nobody owns and
 * claim it straight back. `Claim` removes it — a person saying "actually, yes" is a
 * later decision than the "no" it replaces.
 */
export interface RolloutOptOut {
  host: string;
  container: string;
  ref: string;
  reason: string;
  actor: string | null;
  created_at: string;
}

/**
 * One container this deployment has been given — a `(host, image ref)` remit.
 *
 * `container` is the incus container Docker runs in, or `""` when Docker runs on the
 * host itself; the pair with `host` is what the scan's finding rows are keyed on, which
 * is why it is here and not derived from the ref.
 */
export interface RolloutTarget {
  host: string;
  container: string;
  ref: string;
  project: string;
  service: string;
  /** False means watched, not rolled: findings are still raised, a person still clicks. */
  auto: boolean;
  window_start_hour: number | null;
  window_end_hour: number | null;
  cooldown_hours: number | null;
  note: string;
  created_by: string;
  created_at: string;
  last_rolled_at: string | null;
  /** Set when a failed roll is holding this container back until somebody clears it. */
  blocked_reason: string;
  /** Derived from the cooldown by the API, so the page need not do the arithmetic. */
  next_eligible_at: string | null;
}

/** One attempted roll: what was running, what it was asked to become, and how it ended. */
export interface ContainerRoll {
  id: number;
  run_id: number | null;
  host: string;
  container: string;
  /** The container's own name, as the Docker daemon knows it. */
  name: string;
  ref: string;
  project: string;
  service: string;
  from_image_id: string;
  to_image_id: string;
  state: RollState;
  /** The daemon's own words, or the reason the rail refused. */
  reason: string;
  trigger: string;
  actor: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  cleared_at: string | null;
}

/** What `GET /api/rollouts` returns: the remit, the history, and the rails in force. */
export interface Rollouts {
  /** The kill switch. `false` with a full remit is a prepared deployment, not a current one. */
  enabled: boolean;
  /** Who fills the remit — see `AdoptMode`. Sent so the page need not guess from an empty list. */
  adopt: AdoptMode;
  targets: RolloutTarget[];
  rolls: ContainerRoll[];
  /** The containers taken out of the remit by hand, and staying out. */
  optouts: RolloutOptOut[];
  limits: {
    max_per_run: number;
    max_per_host: number;
    cooldown_hours: number;
    health_grace_seconds: number;
    protected_refs: string[];
  };
}

/**
 * One decision out of a rollout pass, as the run reported it.
 *
 * `code` is the machine-readable refusal (`not-owned`, `outside-window`, `rolling`) and
 * `detail` the sentence for it, so a pass that did nothing can still say *which* nothing
 * for every container it looked at rather than only the ones it moved.
 */
export interface RollDecision {
  host: string;
  name: string;
  ref: string;
  code: string;
  detail: string;
}

/** What `POST /api/rollouts/run` returns. */
export interface RollPassResult {
  run_id: number | null;
  rolled: number;
  rolled_back: number;
  failed: number;
  skipped: number;
  summary: string;
  messages: string[];
  decisions?: RollDecision[];
  /** How many containers the pass claimed for itself, on an adopting deployment. */
  adopted?: number;
  /** How many it left alone because somebody had taken them out by hand. */
  kept_out?: number;
}

/**
 * What `POST /api/rollouts/undo` returns.
 *
 * The undo is written as a row of its own, so `roll_id` here is the *undo's* id and not
 * the one that was passed in. `held` says whether the container is now blocked from the
 * next pass, which is the half of the answer an operator has to know about.
 */
export interface RollUndoResult {
  ok: boolean;
  roll_id?: number;
  state?: RollState;
  detail?: string;
  held?: boolean;
  /** Set when the undo was refused (`ok: false`) — e.g. a roll that never landed. */
  error?: string;
}

export interface ScanResult {
  run_id: number;
  targets: number;
  scanned: number;
  findings: number;
  status: string;
  summary: string;
  hosts: {
    host: string;
    target: string;
    kind: string;
    findings: number;
    scanned: boolean;
    managers: Record<string, string>;
    errors: string[];
  }[];
}

export interface ApplyResult {
  run_id: number | null;
  applied: number;
  failed: number;
  manual: string[];
  messages: string[];
  summary: string;
}

/**
 * The result of approving. An approval on its own carries only `approved`; when it
 * also applied (`apply: true`, which is what the buttons send), the apply fields are
 * present and `summary` is set — see `asApplyResult`.
 */
export interface ApproveResult {
  approved: number;
  applied?: number;
  failed?: number;
  manual?: string[];
  messages?: string[];
  summary?: string;
  run_id?: number | null;
}
