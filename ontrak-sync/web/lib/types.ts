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
  targets: number;
  unscanned: number;
  pending: number;
  security: number;
  failed: number;
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
  description: string;
  next_runs: string[];
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
