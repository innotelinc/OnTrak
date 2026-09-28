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
