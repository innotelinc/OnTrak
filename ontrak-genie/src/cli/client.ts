/**
 * The Genie API, from a terminal.
 *
 * A thin, dependency-free client over the same HTTP surface the browser console
 * uses. It exists because the server was already built to be driven by something
 * that is not a tab — `GET /api/approvals` says so in as many words — and the
 * only thing missing was the driver.
 *
 * Three properties are deliberate:
 *
 *   - **It owns no agent loop.** The turn, the tool dispatch and the gate all
 *     live on the server; this streams what the server decides and answers the
 *     gate when asked. A CLI that re-implemented any of it would be a second
 *     agent, and the two would drift.
 *   - **It speaks the JSON shapes the console speaks.** The types are imported
 *     from `agent.ts` and `store.ts` rather than re-declared, so a new event
 *     type is a compile error here, not a silently dropped frame.
 *   - **It has no runtime dependency.** `fetch` and the Web Streams API are in
 *     Node 20+, so SSE is parsed by hand, the same way the project parses its
 *     own JWTs by hand.
 */

import type { AgentEvent } from "../agent.js";
import type { ApprovalDecision } from "../approval.js";
import type { Session, SessionSummary } from "../store.js";

/** A refusal from the server, carrying the status so a caller can tell them apart. */
export class GenieError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GenieError";
  }

  /** A turn refused for want of a credential, which is the one worth re-signing-in for. */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export interface GenieClientOptions {
  /** Origin, no trailing slash, e.g. `https://genie.innotel.us`. */
  base: string;
  /** `WEB_TOKEN`, sent as a bearer. Mutually exclusive with `cookie` in practice. */
  token?: string;
  /** The signed-in session, sent as the console's own cookie. */
  cookie?: string;
  /** Per-request budget for the non-streaming calls. */
  timeoutMs?: number;
}

/** The fields a turn accepts. Mirrors `handleChat`'s body exactly. */
export interface ChatRequest {
  message: string;
  sessionId?: string;
  model?: string;
  fallbackModels?: string[];
  useOffline?: boolean;
  maxSteps?: number;
  projectId?: string;
}

export interface AuthStatus {
  oidc: boolean;
  authenticated: boolean;
  identity: { sub: string; email: string; name: string } | null;
}

export interface ServerHealth {
  /** Whatever the gateway probe returned, plus the fields the console reads. */
  ok?: boolean;
  model?: string;
  models?: string[];
  plan?: string;
  paid?: boolean;
  modelSelection?: "auto" | "manual";
  freeModels?: string[];
  autoModels?: string[];
  workspace?: string;
  workspaceBase?: string;
  sandbox?: unknown;
  approval?: { mode: string; maxLines: number; pending: number };
  limits?: { minSteps: number; maxSteps: number; defaultSteps: number };
  fallbackModels?: string[];
  modelHealth?: unknown;
  offline?: { url: string; models: string[] } | null;
  authRequired?: boolean;
  tenancy?: boolean;
  [key: string]: unknown;
}

export interface PendingApproval {
  id: string;
  name: string;
  summary: string;
  requestedAt: string;
  expiresAt: string;
}

export interface AccountUsage {
  tenancy: boolean;
  email?: string;
  allowed?: boolean;
  reasons?: string[];
  quota?: unknown;
  usageToday?: unknown;
  ceiling?: { limit: number; used: number; allowed: boolean } | null;
  error?: string;
}

export interface ShareRecord {
  id: string;
  sessionId: string;
  recipientEmail: string;
  createdAt: string;
  [key: string]: unknown;
}

/** What a streaming turn calls back with. The last three are terminal. */
export interface ChatHandlers {
  onEvent: (event: AgentEvent) => void;
  /** The server closed with `[DONE]`; `steps` is the last `done` frame's count. */
  onDone?: (steps: number) => void;
}

export class GenieClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(options: GenieClientOptions) {
    this.base = options.base.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (options.token) this.headers.Authorization = `Bearer ${options.token}`;
    if (options.cookie) this.headers.Cookie = `ontrak_genie_session=${encodeURIComponent(options.cookie)}`;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private readonly timeoutMs: number;

  /** The address this client dials, for messages and prompts. */
  get origin(): string {
    return this.base;
  }

  private url(pathname: string): string {
    return `${this.base}${pathname}`;
  }

  /**
   * One JSON call. A non-2xx becomes a `GenieError` carrying the server's own
   * message: the API answers refusals with `{error}` and the reason is more
   * useful than the status, which is why it is preferred over a generic string.
   */
  private async json<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(pathname), {
        ...init,
        headers: { ...this.headers, ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GenieError(0, unreachable(this.base, error));
    }
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }
    if (!response.ok) {
      throw new GenieError(response.status, messageOf(body, response.status), body);
    }
    return body as T;
  }

  status(): Promise<AuthStatus> {
    return this.json<AuthStatus>("/api/auth/status");
  }

  health(): Promise<ServerHealth> {
    return this.json<ServerHealth>("/api/health");
  }

  async models(): Promise<{ models: string[]; model: string; error?: string }> {
    return this.json("/api/models");
  }

  async usage(): Promise<AccountUsage> {
    return this.json("/api/account/usage");
  }

  async sessions(): Promise<SessionSummary[]> {
    const { sessions } = await this.json<{ sessions: SessionSummary[] }>("/api/sessions");
    return sessions;
  }

  async session(id: string): Promise<Session> {
    const { session } = await this.json<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`);
    return session;
  }

  async createSession(projectId?: string): Promise<Session> {
    const { session } = await this.json<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(projectId === undefined ? {} : { projectId }),
    });
    return session;
  }

  /** Rename, archive and the per-chat settings all go through one PATCH. */
  async patchSession(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.json(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.json(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async approvals(): Promise<PendingApproval[]> {
    const { pending } = await this.json<{ pending: PendingApproval[] }>("/api/approvals");
    return pending;
  }

  async decide(id: string, decision: Extract<ApprovalDecision, "approve" | "deny">): Promise<boolean> {
    const { resolved } = await this.json<{ resolved: boolean }>(
      `/api/approvals/${encodeURIComponent(id)}`,
      { method: "POST", body: JSON.stringify({ decision }) },
    );
    return resolved;
  }

  async shares(): Promise<{ sharedWithMe: ShareRecord[]; sharedByMe: ShareRecord[] }> {
    return this.json("/api/shares");
  }

  async shareSession(sessionId: string, email: string): Promise<ShareRecord> {
    const { share } = await this.json<{ share: ShareRecord }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/share`,
      { method: "POST", body: JSON.stringify({ email }) },
    );
    return share;
  }

  /**
   * Run one turn and stream its events.
   *
   * The body is an SSE stream of `data: <AgentEvent>` frames ended by `[DONE]`,
   * which is what `handleChat` writes. Frames are parsed incrementally rather
   * than by `response.json()`, because the whole point of the stream is that an
   * event arrives before the next one exists — a buffered read would turn a live
   * tool call into a batch delivered at the end.
   *
   * A turn that is refused *before* the stream opens (no account, over quota)
   * comes back as a plain HTTP error, which is why the status is checked first;
   * a refusal *during* the turn arrives as an `error` event and is handed to the
   * caller rather than thrown, so the transcript keeps whatever came before it.
   */
  async chat(request: ChatRequest, handlers: ChatHandlers, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.url("/api/chat"), {
        method: "POST",
        headers: { ...this.headers, Accept: "text/event-stream" },
        body: JSON.stringify(request),
        signal: signal ?? null,
      });
    } catch (error) {
      if (signal?.aborted) return;
      throw new GenieError(0, unreachable(this.base, error));
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep it as text */
      }
      throw new GenieError(response.status, messageOf(body, response.status), body);
    }
    if (response.body === null) {
      throw new GenieError(response.status, "the server opened a stream with no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let steps = 0;
    let finished = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; a partial frame stays in the
        // buffer rather than being parsed as if it were whole.
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const payload = dataOf(frame);
          if (payload === "[DONE]") {
            finished = true;
            break;
          }
          if (payload !== null) {
            const event = parseEvent(payload);
            if (event !== null) {
              if (event.type === "done") steps = event.steps;
              handlers.onEvent(event);
            }
          }
          split = buffer.indexOf("\n\n");
        }
        if (finished) break;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    handlers.onDone?.(steps);
  }
}

/** The `data:` payload of one SSE frame, or null for a comment/heartbeat. */
export function dataOf(frame: string): string | null {
  const lines = frame.split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // heartbeat
    if (!line.startsWith("data:")) continue;
    parts.push(line.slice("data:".length).replace(/^ /, ""));
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/** Parse a frame payload into an event, ignoring anything malformed. */
export function parseEvent(payload: string): AgentEvent | null {
  try {
    const parsed = JSON.parse(payload) as AgentEvent;
    return typeof parsed === "object" && parsed !== null && "type" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

function messageOf(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error !== "") return error;
  }
  if (typeof body === "string" && body.trim() !== "") return body.trim().slice(0, 300);
  return `the server answered ${status}`;
}

function unreachable(base: string, error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause;
  const detail = cause?.code ?? (error as Error).message;
  return `cannot reach Genie at ${base} (${detail})`;
}
