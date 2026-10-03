/**
 * The API client.
 *
 * TWO DEPLOYMENTS, ONE CLIENT
 * ---------------------------
 * The dashboard is reached two ways and this module has to serve both without a
 * build-time switch:
 *
 *  * **Same-origin, behind the Cerulean edge** (`https://sync.ontrak.innotel.us`).
 *    `NEXT_PUBLIC_ONTRAK_API` is unset, so requests go to `/api/...` on this
 *    origin and `app/api/[...path]/route.ts` forwards them to the API container.
 *    The session is an `HttpOnly` cookie the browser attaches itself, so there is
 *    nothing in JavaScript for a cross-site script to steal, and every write
 *    carries the CSRF header the API insists on for cookie-authenticated calls.
 *
 *  * **Cross-origin, on the LAN** (`http://192.168.1.21:8420`). The address is in
 *    `NEXT_PUBLIC_ONTRAK_API` and the session token is kept in `localStorage`.
 *    This is the mode that made the service useful from a workstation before the
 *    edge existed, and it is still what a fresh install gets.
 *
 * `ApiError` carries the status so callers can distinguish the three failures that
 * matter: 401 means "sign in", 403 means "signed in and not allowed", and anything
 * else is the Network's problem. A dashboard that renders the same page for all
 * three is a dashboard whose operator cannot tell a rotated credential from a
 * broken host.
 */

import type {
  ApplyResult, ApproveResult, AppUser, Event, Identity, Finding, Host, Meta, Policy, Run,
  ScanResult, SignInResult, Summary, Target, UserSession,
} from "./types";

/**
 * The apply half of an approve response, or null when the call only recorded the
 * decision. The pages render it with the same panel as a standalone apply.
 */
export function asApplyResult(result: ApproveResult): ApplyResult | null {
  if (result.summary === undefined) return null;
  return {
    run_id: result.run_id ?? null,
    applied: result.applied ?? 0,
    failed: result.failed ?? 0,
    manual: result.manual ?? [],
    messages: result.messages ?? [],
    summary: result.summary,
  };
}

/** Empty means "this origin" — see the header. */
export const API_BASE = (process.env.NEXT_PUBLIC_ONTRAK_API || "").replace(/\/$/, "");

/** True when the browser talks to the API on another origin with a bearer token. */
export const CROSS_ORIGIN = API_BASE !== "";

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
  /** Seconds the server asked us to wait, from `Retry-After`. 0 when absent. */
  readonly retryAfter: number;

  constructor(status: number, detail: unknown, retryAfter = 0) {
    super(typeof detail === "string" ? detail : `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }

  /** 401: present a credential. */
  get unauthorized(): boolean {
    return this.status === 401;
  }

  /** 403: you are signed in and this is not yours. Never redirect to login for it. */
  get forbidden(): boolean {
    return this.status === 403;
  }

  /** The 422 body from a form, as a flat list of complaints. */
  get problems(): string[] {
    const detail = this.detail as
      | { problems?: string[]; detail?: { problems?: string[] } }
      | null;
    if (!detail) return [];
    if (Array.isArray(detail.problems)) return detail.problems;
    if (detail.detail && Array.isArray(detail.detail.problems)) return detail.detail.problems;
    return [this.message];
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  // Sent on every call, not only on writes: the API ignores it on a GET, and a
  // header that is only sometimes present is a header somebody forgets on the one
  // request that needed it.
  headers.set("X-Ontrak-CSRF", "1");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      // The cookie path needs this; `same-origin` is the default anyway, so this
      // only matters in the cross-origin deployment, where a cookie is not used.
      credentials: "same-origin",
    });
  } catch {
    // A network failure is not an auth failure; saying so saves the operator from
    // re-entering a credential that was never the problem.
    throw new ApiError(0, API_BASE
      ? `cannot reach the Ontrak Sync API at ${API_BASE}`
      : "cannot reach the Ontrak Sync API through this address");
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
    // `Retry-After` is what turns a lockout from "it failed again" into "wait
    // 30 seconds", and the login form counts it down. Browsers only expose the
    // header on a same-origin response, which is the arrangement the lockout is
    // actually reached in.
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    throw new ApiError(response.status, detail,
                       Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0);
  }
  return payload as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

export const api = {
  // ── before sign-in ────────────────────────────────────────────────────────
  meta: () => request<Meta>("/api/meta"),
  health: () => request<{ status: string; scheduler: boolean; last_fired_at: string | null }>(
    "/api/health"),

  // ── identity ──────────────────────────────────────────────────────────────
  signIn: async (username: string, password: string): Promise<SignInResult> => {
    const result = await post<SignInResult>("/api/auth/login", { username, password });
    // Kept only for the cross-origin deployment; the cookie deployment ignores it
    // and the value is the caller's own session either way.
    setToken(result.token);
    return result;
  },
  signOut: async (): Promise<void> => {
    try {
      await post<{ signed_out: boolean }>("/api/auth/logout");
    } finally {
      // Clear locally even when the call fails: a sign-out that leaves the
      // credential behind is not a sign-out.
      setToken("");
    }
  },
  me: () => request<Identity>("/api/auth/me"),
  changePassword: (current_password: string, new_password: string) =>
    post<{ changed: boolean; sessions_revoked: boolean }>("/api/auth/password",
      { current_password, new_password }),

  /** Where to send the browser to start the Cerulean handshake. */
  ssoStartUrl: (next = "/") =>
    `${API_BASE}/api/auth/sso/start?next=${encodeURIComponent(next)}`,

  // ── people ────────────────────────────────────────────────────────────────
  users: () => request<{ users: AppUser[] }>("/api/users"),
  createUser: (body: {
    username: string; password?: string; email?: string; display_name?: string;
    role: string; active?: boolean;
  }) => post<AppUser>("/api/users", body),
  updateUser: (id: number, body: {
    email?: string; display_name?: string; role?: string; active?: boolean; password?: string;
  }) => put<AppUser>(`/api/users/${id}`, body),
  deleteUser: (id: number) => del<{ deleted: boolean }>(`/api/users/${id}`),

  sessions: () => request<{ sessions: UserSession[]; scope: "all" | "own" | "none" }>(
    "/api/sessions"),
  revokeSession: (id: number) => del<{ revoked: boolean }>(`/api/sessions/${id}`),

  // ── Network ────────────────────────────────────────────────────────────────
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

  // `apply: true` records the decision and installs it in one call — the buttons
  // send it, so "Approve" is the whole action rather than half of one.
  approve: (body: {
    ids?: number[]; all_pending?: boolean; security_only?: boolean; apply?: boolean;
  }) => post<ApproveResult>("/api/findings/approve", body),
  skip: (body: { ids?: number[]; all_pending?: boolean; security_only?: boolean }) =>
    post<{ skipped: number }>("/api/findings/skip", body),

  scan: (hosts: string[] = []) => post<ScanResult>("/api/scan", { hosts }),
  apply: (body: { ids?: number[]; all_approved?: boolean } = { all_approved: true }) =>
    post<ApplyResult>("/api/apply", body),

  policy: () => request<Policy>("/api/settings"),
  savePolicy: (body: Record<string, unknown>) => put<Policy>("/api/settings", body),
  previewPolicy: (body: Record<string, unknown>) =>
    post<{ valid: boolean; problems: string[]; description: string; next_runs: string[] }>(
      "/api/settings/preview",
      body,
    ),
};
