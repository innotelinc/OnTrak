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
import type { ProjectView } from "../projects.js";
import type { Session, SessionSummary } from "../store.js";

/**
 * A project export or import carries every file in the project, so it is the one
 * call here that is not a small JSON exchange. The budget is the same order as
 * the server's own body limit rather than the 15s a status call gets, because a
 * timeout on a bundle would be a failure invented by the client.
 */
const BUNDLE_TIMEOUT_MS = 120_000;

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
  /** Present on the recipient's list: who shared it with them. */
  ownerEmail?: string;
  createdAt: string;
  [key: string]: unknown;
}

/** One proposed file in a pending change set. */
export interface StagedEntry {
  path: string;
  kind: "create" | "overwrite" | "edit";
  added: number;
  removed: number;
}

export interface PendingChangeSet {
  id: string;
  createdAt: string;
  entries: StagedEntry[];
}

/** `GET /api/changes` — the pending set, and the server's own one-line summary. */
export interface ChangesPayload {
  changeSet: PendingChangeSet | null;
  summary: string;
}

export interface ApplyResult {
  applied: number;
  paths: string[];
  id: string;
}

/** What `GET /api/projects` answers with: the list, and which one is open. */
export interface ProjectsPayload {
  base: string;
  /** Sandbox-relative directory the agent is working in ("" when it is not a project). */
  active: string;
  projects: ProjectView[];
}

/** One project as one portable file (`GET /api/projects/:id/export`). */
export interface ProjectBundle {
  /** The name a download would use — a slug, never a path. */
  filename: string;
  /** The encoded bundle itself. */
  content: string;
  files: number;
  /** Relative paths deliberately left out (ignored and symlinked entries). */
  skipped: string[];
}

/** What loading a bundle produced. */
export interface ProjectLoad {
  project: ProjectView;
  files: number;
  skipped: string[];
}

/* --- remote workspaces (v0.6) ------------------------------------------------ */

/** One mounted folder, as `GET /api/remote` reports it. */
export interface RemoteSshRow {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  path: string;
  /** Sandbox-relative directory it is mounted at. */
  rel: string;
  mountPoint: string;
  auth: "key" | "password";
  connectedAt: string;
  /** Whether the mount is still answering — re-checked when the list is read. */
  live: boolean;
}

/** One GitHub clone the session holds a token for. */
export interface RemoteGithubRow {
  repo: string;
  rel: string;
  url: string;
  branch: string | null;
  /** True when a token is held; the token itself is never sent. */
  credential: boolean;
  connectedAt: string;
}

/** One forge (Gitea) connection. */
export interface RemoteForgeRow {
  host: string;
  label: string;
  user: string;
  credential: boolean;
  /** True when the credential is the deployment's own, not the caller's. */
  system: boolean;
  connectedAt: string;
}

/** One clone made from a forge. */
export interface RemoteForgeClone {
  repo: string;
  rel: string;
  url: string;
  branch: string | null;
}

/** Atlas, and whether this account's plan includes it. */
export interface RemoteAtlasInfo {
  url: string;
  configured: boolean;
  sshHost: string;
  systemUser: string;
  systemCredential: boolean;
  /** null when the plan could not be checked — which is not a refusal. */
  entitled: boolean | null;
  reason: string;
  signupUrl: string;
}

/** Everything `GET /api/remote` answers with: one round trip for one feature. */
export interface RemoteList {
  enabled: boolean;
  allowedHosts: string[];
  ssh: RemoteSshRow[];
  github: RemoteGithubRow[];
  forge: RemoteForgeRow[];
  forgeClones: RemoteForgeClone[];
  atlas: RemoteAtlasInfo;
}

/**
 * The running app, as `POST /api/preview/start` and `GET /api/preview` report it.
 *
 * The same shape the console's preview pane reads, because it is the same route:
 * a project created or cloned from Atlas is run here the way any other project is.
 */
export interface PreviewStatus {
  running: boolean;
  /** The command that was started, or the one that would be. */
  command: string | null;
  cwd: string | null;
  port: number | null;
  /** Where the console reaches it, relative to the deployment (`/preview/`). */
  url: string;
  /** The LAN address, when the deployment publishes the port. */
  address: string | null;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
  log: string;
  /** Up, but not answering yet — a framework still building. */
  pending?: boolean;
  /** True when the command was worked out from the project rather than named. */
  detected?: boolean;
}

/** A created or opened pull request, however the host named its fields. */
export interface RemotePullRequest {
  number: number | null;
  url: string | null;
  state: string | null;
  repo: string;
  head: string;
  base: string;
}

/** What a clone (or a created repository) answered with. */
export interface RemoteCloneResult {
  rel: string;
  cwd?: string;
  connection: {
    repo: string;
    rel: string;
    url: string;
    web?: string;
    branch: string | null;
    credential?: boolean;
  };
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

  /** Withdraw a share. Either side may end one; the server decides which way. */
  async unshare(id: string): Promise<boolean> {
    const { removed } = await this.json<{ removed: boolean }>(
      `/api/shares/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return removed;
  }

  /**
   * What propose mode is holding, in the caller's own workspace.
   *
   * The same document the console's review panel reads, so a change set approved
   * in one place is the change set the other sees — there is one pending set per
   * process, not one per client.
   */
  async changes(): Promise<ChangesPayload> {
    return this.json<ChangesPayload>("/api/changes");
  }

  async applyChanges(): Promise<ApplyResult> {
    return this.json<ApplyResult>("/api/changes/apply", { method: "POST" });
  }

  async discardChanges(): Promise<boolean> {
    const { discarded } = await this.json<{ discarded: boolean }>("/api/changes/discard", {
      method: "POST",
    });
    return discarded;
  }

  /** Every saved project, and which directory is currently the working one. */
  projects(): Promise<ProjectsPayload> {
    return this.json<ProjectsPayload>("/api/projects");
  }

  /**
   * Save a project: a name, and the directory the server derives from it.
   *
   * `open` is passed through rather than decided here — the console opens what it
   * creates and so does the CLI, but the default belongs on the server, which is
   * the only place that knows what the working directory is right now.
   */
  async createProject(
    name: string,
    options: { description?: string; open?: boolean } = {},
  ): Promise<ProjectView> {
    const { project } = await this.json<{ project: ProjectView }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(options.description === undefined ? {} : { description: options.description }),
        open: options.open === true,
      }),
    });
    return project;
  }

  /** Make a project the account's working directory. */
  async openProject(id: string): Promise<ProjectView> {
    const { project } = await this.json<{ project: ProjectView }>(
      `/api/projects/${encodeURIComponent(id)}/open`,
      { method: "POST" },
    );
    return project;
  }

  /** Rename a project, or change its note. */
  async updateProject(id: string, patch: { name?: string; description?: string }): Promise<ProjectView> {
    const { project } = await this.json<{ project: ProjectView }>(
      `/api/projects/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    return project;
  }

  /** Forget a project. `deleteFiles` also removes its directory. */
  async deleteProject(id: string, deleteFiles = false): Promise<boolean> {
    const query = deleteFiles ? "?files=delete" : "";
    const { removed } = await this.json<{ removed: boolean }>(
      `/api/projects/${encodeURIComponent(id)}${query}`,
      { method: "DELETE" },
    );
    return removed;
  }

  /** A project as one portable file. */
  exportProject(id: string): Promise<ProjectBundle> {
    return this.json<ProjectBundle>(`/api/projects/${encodeURIComponent(id)}/export`, {
      signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
    });
  }

  /**
   * Load a bundle as a *new* project.
   *
   * The bundle is the request body — it is posted as the file's own text, so
   * nothing re-escapes it, which is what makes the bytes the console downloads
   * and the bytes this sends the same bytes.
   */
  importProject(content: string, options: { name?: string; open?: boolean } = {}): Promise<ProjectLoad> {
    const query = new URLSearchParams();
    if (options.name !== undefined && options.name !== "") query.set("name", options.name);
    if (options.open === true) query.set("open", "1");
    const encodedQuery = query.toString();
    const suffix = encodedQuery === "" ? "" : `?${encodedQuery}`;
    return this.json<ProjectLoad>(`/api/projects/import${suffix}`, {
      method: "POST",
      body: content,
      signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
    });
  }

  /* --- remote workspaces (v0.6) ------------------------------------------- */

  /** The mounts, the clones, the forges and what Atlas is, in one call. */
  remotes(): Promise<RemoteList> {
    return this.json<RemoteList>("/api/remote");
  }

  /** Mount a folder over SSH and make it the working directory. */
  connectSshFolder(input: {
    host: string;
    user: string;
    path: string;
    port?: number;
    key?: string;
    passphrase?: string;
    password?: string;
  }): Promise<{ rel: string; cwd: string; connection: RemoteSshRow }> {
    return this.json("/api/remote/ssh", { method: "POST", body: JSON.stringify(input) });
  }

  /** Unmount a folder, and remove the key the session was holding for it. */
  disconnectSshFolder(id: string): Promise<{ id: string; rel: string }> {
    return this.json("/api/remote/ssh/disconnect", { method: "POST", body: JSON.stringify({ id }) });
  }

  /**
   * Connect to a forge.
   *
   * `useSystem` asks for the deployment's own Atlas credential, which is the one
   * shape that needs no secret here and is not gated on a plan.
   */
  connectForge(input: {
    url?: string;
    user?: string;
    secret?: string;
    useSystem?: boolean;
  }): Promise<RemoteForgeRow & { url: string }> {
    return this.json("/api/remote/forge/connect", { method: "POST", body: JSON.stringify(input) });
  }

  /** Create a repository on the forge, clone it, and work in it. */
  createForgeProject(input: {
    name: string;
    description?: string;
    url?: string;
    private?: boolean;
    autoInit?: boolean;
  }): Promise<RemoteCloneResult> {
    return this.json("/api/remote/forge/create", { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
  }

  /** Clone a repository from the forge into the working directory. */
  cloneForgeRepo(input: { repo: string; url?: string; dir?: string; branch?: string }): Promise<RemoteCloneResult> {
    return this.json("/api/remote/forge/clone", { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
  }

  /**
   * Run the project's own dev server — the console's "run", over the same route.
   *
   * No command means the server works one out from the project (`npm run dev`, a
   * `manage.py`, a static site), which is what makes a project cloned from a forge
   * runnable without naming anything.
   */
  runProject(input: { command?: string; cwd?: string; port?: number } = {}): Promise<PreviewStatus> {
    return this.json<PreviewStatus>("/api/preview/start", {
      method: "POST",
      body: JSON.stringify(input),
      // A project's first start includes its install in the worst case, so this
      // waits longer than a normal call rather than lying about a slow build.
      signal: AbortSignal.timeout(120_000),
    });
  }

  pushForgeBranch(input: { branch: string; dir?: string; url?: string }): Promise<{ branch: string; repo: string }> {
    return this.json("/api/remote/forge/push", { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
  }

  openForgePullRequest(input: {
    title: string;
    head: string;
    base?: string;
    body?: string;
    repo?: string;
    url?: string;
  }): Promise<RemotePullRequest> {
    return this.json("/api/remote/forge/pr", { method: "POST", body: JSON.stringify(input) });
  }

  /** Clone a GitHub repository with a token, and work in it. */
  cloneGithubRepo(input: {
    repo: string;
    dir?: string;
    branch?: string;
    token?: string;
  }): Promise<RemoteCloneResult> {
    return this.json("/api/remote/github/clone", { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
  }

  pushGithubBranch(input: { branch: string; dir?: string; repo?: string; token?: string }): Promise<{ branch: string; repo: string }> {
    return this.json("/api/remote/github/push", { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(120_000) });
  }

  openGithubPullRequest(input: {
    title: string;
    head: string;
    base?: string;
    body?: string;
    repo?: string;
    token?: string;
  }): Promise<RemotePullRequest> {
    return this.json("/api/remote/github/pr", { method: "POST", body: JSON.stringify(input) });
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
