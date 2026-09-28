/**
 * The API client.
 *
 * The token is kept in `localStorage` rather than a cookie on purpose: this is an
 * internal tool reached over the LAN, the API authenticates with a bearer header
 * rather than a session, and a cookie would imply CSRF protection that does not
 * exist here. The token is compared with a constant-time comparison on the server,
 * so the only thing it must not do is end up in a URL or a log — which is why it
 * is never put in a query string.
 *
 * `ApiError` carries the status so callers can distinguish the two failures that
 * matter: 401 means the token is wrong, and anything else is the estate's problem.
 */

import type {
  ApplyResult, Event, Finding, Host, Policy, Run, ScanResult, Summary, Target,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_ONTRAK_API?.replace(/\/$/, "") || "http://localhost:8420";

const TOKEN_KEY = "ontrak.token";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }

  /** The 422 body from the settings form, as a flat list of complaints. */
  get problems(): string[] {
    const detail = this.detail as { problems?: string[]; detail?: { problems?: string[] } } | null;
    if (!detail) return [];
    if (Array.isArray(detail.problems)) return detail.problems;
    if (detail.detail && Array.isArray(detail.detail.problems)) return detail.detail.problems;
    return [this.message];
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch (cause) {
    // A network failure is not an auth failure; saying so saves the operator from
    // re-entering a token that was never the problem.
    throw new ApiError(0, `cannot reach the Ontrak Sync API at ${API_BASE}`);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const detail = (payload as { detail?: unknown } | null)?.detail ?? payload;
    throw new ApiError(response.status, detail);
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  health: () => request<{ status: string; scheduler: boolean; last_fired_at: string | null }>("/api/health"),

  summary: () => request<Summary>("/api/summary"),
  hosts: () => request<{ hosts: Host[] }>("/api/hosts"),
  host: (name: string) =>
    request<{ host: Host; targets: (Target & { findings: Finding[] })[] }>(
      `/api/hosts/${encodeURIComponent(name)}`,
    ),
  targets: (host?: string) =>
    request<{ targets: Target[] }>(host ? `/api/targets?host=${encodeURIComponent(host)}` : "/api/targets"),
  findings: (params: {
    status?: string; manager?: string; host?: string; security_only?: boolean; limit?: number;
  } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "" && value !== false) query.set(key, String(value));
    }
    const suffix = query.toString() ? `?${query}` : "";
    return request<{ findings: Finding[]; count: number }>(`/api/findings${suffix}`);
  },
  runs: (limit = 40) => request<{ runs: Run[] }>(`/api/runs?limit=${limit}`),
  events: (limit = 200) => request<{ events: Event[] }>(`/api/events?limit=${limit}`),

  approve: (body: { ids?: number[]; all_pending?: boolean; security_only?: boolean }) =>
    post<{ approved: number }>("/api/findings/approve", body),
  skip: (body: { ids?: number[]; all_pending?: boolean; security_only?: boolean }) =>
    post<{ skipped: number }>("/api/findings/skip", body),

  scan: (hosts: string[] = []) => post<ScanResult>("/api/scan", { hosts }),
  apply: (body: { ids?: number[]; all_approved?: boolean } = { all_approved: true }) =>
    post<ApplyResult>("/api/apply", body),

  policy: () => request<Policy>("/api/settings"),
  savePolicy: (body: Record<string, unknown>) =>
    request<Policy>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  previewPolicy: (body: Record<string, unknown>) =>
    post<{ valid: boolean; problems: string[]; description: string; next_runs: string[] }>(
      "/api/settings/preview",
      body,
    ),
};
