import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "./agent.js";
import { pendingApprovals, resolveApproval } from "./approval.js";
import { config } from "./config.js";
import { controlPlaneEnabled } from "./controlplane.js";
import { buildFileDiff } from "./diff.js";
import { modelHealth, startModelHealthLoop } from "./modelHealth.js";
import {
  abandonLogin,
  beginLogin,
  clearedCookie,
  completeLogin,
  LoginError,
  mintSession,
  oidcEnabled,
  redirectUri,
  sessionCookie,
  sessionFrom,
} from "./oidc.js";
import { gatewayHealth, listModels } from "./omniroute.js";
import { sandboxInfo } from "./sandbox.js";
import {
  runInScope,
  sandboxRoot,
  selectedWorkspace,
  setSelectedWorkspace,
  workspaceRoot,
} from "./scope.js";
import { dropSnapshot, listSnapshots, readSnapshot } from "./snapshots.js";
import { startSweep, sweepStale, sweepState } from "./sweep.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  MAX_STEPS,
  MIN_STEPS,
  normalizeFlag,
  normalizeMaxSteps,
  normalizeModelList,
  saveSession,
} from "./store.js";
import { beginTurn, countUsage, finishTurn, scopeFor, type TurnUsage } from "./tenancy.js";
import {
  deleteWorkspaceEntry,
  ensureWorkspace,
  isDirectory,
  listDirectory,
  listWorkspaceDirs,
  pathExists,
  readTextFile,
  resolveInBase,
  resolveInWorkspace,
  toRelFromBase,
  WorkspaceError,
} from "./workspace.js";

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(DIST_DIR, "..", "public");

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(
  req: http.IncomingMessage,
  limit = 1_000_000,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit);
  if (raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `invalid JSON: ${(error as Error).message}`);
  }
}

// --- static assets ----------------------------------------------------------

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/highlight.js": { file: "highlight.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  // The family theme, served inline rather than bundled: this app has no bundler, and
  // both files are byte-identical copies of `theme/unity-theme.{css,js}` checked by
  // `theme/tests/test_theme_copies.py`.
  "/unity-theme.css": { file: "unity-theme.css", type: "text/css; charset=utf-8" },
  "/unity-theme.js": { file: "unity-theme.js", type: "text/javascript; charset=utf-8" },
  // The sign-in gate. Public like the shell, and for the same reason: it is what
  // a signed-out visitor is sent to, so it cannot itself require a session. It is
  // a page rather than a redirect because it has to render the case where no
  // provider is configured at all — see `public/login.html`.
  "/login": { file: "login.html", type: "text/html; charset=utf-8" },
  "/login.html": { file: "login.html", type: "text/html; charset=utf-8" },
};

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;
  try {
    const body = await fs.readFile(path.join(PUBLIC_DIR, entry.file));
    res.writeHead(200, { "Content-Type": entry.type, "Content-Length": body.length });
    res.end(body);
    return true;
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`missing asset: ${entry.file}`);
    return true;
  }
}

// --- auth -------------------------------------------------------------------

/**
 * Who may call the API.
 *
 * In order: a valid session cookie when sign-in is configured, then the shared
 * bearer (the API path, and what a deployment with no identity provider uses),
 * and — only when neither is configured — the loopback trust this app started
 * with. That last case is intended rather than leftover: a laptop with no token
 * and a loopback bind is the default this ships with.
 *
 * The consequence worth stating: configuring sign-in refuses an unauthenticated
 * request even when `WEB_TOKEN` is empty. Turning OIDC on and leaving the bearer
 * unset must not leave the console open, which is exactly what the old `return
 * true` would have done.
 */
function isAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (config.webToken !== "") {
    if (req.headers.authorization === `Bearer ${config.webToken}`) return true;
    if (url.searchParams.get("token") === config.webToken) return true;
  }
  if (sessionFrom(req) !== null) return true;
  return config.webToken === "" && !oidcEnabled();
}

// --- auth routes ------------------------------------------------------------

/**
 * The sign-in endpoints. They are routed before the authorization check because
 * they are how authorization is obtained.
 *
 * `/api/auth/status` is deliberately unauthenticated and deliberately thin: the
 * console has to know whether to send somebody to the provider or to ask for a
 * token, and it cannot answer that question while unauthorized. It exposes a
 * boolean and, at most, the identity already carried by the caller's own cookie.
 */
async function handleAuthRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const { pathname } = url;

  if (pathname === "/api/auth/status" && req.method === "GET") {
    const session = sessionFrom(req);
    sendJson(res, 200, {
      oidc: oidcEnabled(),
      // Without sign-in configured this mirrors the server: a token or a
      // loopback caller is as authorized as it gets.
      authenticated: session !== null || (config.webToken === "" && !oidcEnabled()),
      identity:
        session === null ? null : { sub: session.sub, email: session.email, name: session.name },
    });
    return true;
  }

  if (pathname === "/api/auth/login" && req.method === "GET") {
    if (!oidcEnabled()) throw new HttpError(404, "sign-in is not configured");
    res.writeHead(302, { Location: await beginLogin() });
    res.end();
    return true;
  }

  if (pathname === "/api/auth/callback" && req.method === "GET") {
    if (!oidcEnabled()) throw new HttpError(404, "sign-in is not configured");
    const state = url.searchParams.get("state") ?? "";
    const refusal = url.searchParams.get("error");
    if (refusal !== null) {
      abandonLogin(state);
      throw new HttpError(401, `the provider refused the sign-in: ${refusal}`);
    }

    let identity;
    try {
      identity = await completeLogin(url.searchParams.get("code") ?? "", state);
    } catch (failure) {
      // A sign-in that did not work is a 401, not a 500 — but a provider that
      // could not be reached is a 502, and conflating the two sends the operator
      // to the wrong thing. The state is already spent either way.
      const status = failure instanceof LoginError ? 401 : 502;
      throw new HttpError(status, (failure as Error).message);
    }

    res.writeHead(302, { Location: "/", "Set-Cookie": sessionCookie(mintSession(identity)) });
    res.end();
    return true;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": clearedCookie() });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

// --- chat (SSE) -------------------------------------------------------------

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const message = typeof body.message === "string" ? body.message : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const model = typeof body.model === "string" && body.model !== "" ? body.model : undefined;
  const fallbackModels = normalizeModelList(body.fallbackModels);
  const useOffline = normalizeFlag(body.useOffline);
  const maxSteps = normalizeMaxSteps(body.maxSteps);

  if (message.trim() === "") throw new HttpError(400, "message is required");

  /*
   * Tenancy, before anything is spent: which account this turn belongs to, and
   * whether it may spend at all. A refusal belongs here rather than inside the
   * stream — the model pool has not been touched yet, and a 401 or a 429 is a
   * clearer answer than an SSE frame saying the same thing. Nothing about the
   * chat is created until the turn is allowed to run.
   */
  const started = await beginTurn(sessionFrom(req));
  if (!started.ok) throw new HttpError(started.status, started.message);
  const { turn } = started;

  let usage: TurnUsage = { tokensIn: 0, tokensOut: 0, requests: 0 };

  let session = sessionId === "" ? null : await getSession(sessionId);
  if (session === null) {
    session = createSession();
    await saveSession(session);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  // Keeps intermediaries from closing an idle stream during a long tool call.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  try {
    for await (const event of runAgent({
      session,
      userMessage: message,
      model,
      fallbackModels,
      useOffline,
      maxSteps,
      // The account's own key when a control plane resolved one; otherwise
      // undefined, and the shared key applies exactly as it did before.
      apiKey: turn.apiKey,
      onUsage: (reported, model) => {
        usage = countUsage(reported, usage, model);
      },
      signal: controller.signal,
    })) {
      send(event);
    }
  } catch (error) {
    send({ type: "error", message: (error as Error).message });
  } finally {
    clearInterval(heartbeat);
    res.write("data: [DONE]\n\n");
    res.end();
    /*
     * The ledger write, after the answer has been sent and never awaited: the turn
     * is already paid for, so a control plane that is slow or down must not hold
     * up a reply the user already has. `finishTurn` swallows its own transport
     * errors for the same reason.
     */
    void finishTurn(turn, usage);
  }
}

// --- routing ----------------------------------------------------------------

let modelCache: { at: number; models: string[] } | null = null;

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (pathname === "/api/health" && method === "GET") {
    const health = await gatewayHealth();
    const sandbox = await sandboxInfo();
    return sendJson(res, 200, {
      ...health,
      model: config.model,
      // The caller's own root, which is the deployment's when tenancy is off.
      workspace: workspaceRoot(),
      /** The sandbox the chosen directory lives inside; shown by the picker. */
      workspaceBase: sandboxRoot(),
      sandbox,
      approval: {
        mode: config.approval,
        maxLines: config.approvalMaxLines,
        pending: pendingApprovals(),
      },
      limits: { minSteps: MIN_STEPS, maxSteps: MAX_STEPS, defaultSteps: config.maxSteps },
      /** Chain used when a chat has not saved one of its own. */
      fallbackModels: config.fallbackModels,
      /** Whether the chain's entries could make a tool call, and when last asked. */
      modelHealth: modelHealth(),
      /** Present only when an offline gateway is configured. */
      offline:
        config.offlineUrl === ""
          ? null
          : { url: config.offlineUrl, models: config.offlineModels },
      authRequired: config.webToken !== "",
      /** True when turns are attributed and quota-gated through the control plane. */
      tenancy: controlPlaneEnabled(),
    });
  }

  if (pathname === "/api/models" && method === "GET") {
    // Cache briefly: the gateway's catalog is large and static in practice.
    if (modelCache === null || Date.now() - modelCache.at > 60_000) {
      try {
        modelCache = { at: Date.now(), models: await listModels() };
      } catch (error) {
        return sendJson(res, 200, { models: [], error: (error as Error).message });
      }
    }
    return sendJson(res, 200, { models: modelCache.models, model: config.model });
  }

  if (pathname === "/api/models/sweep" && method === "GET") {
    // `stale` is derived rather than stored, so the report on disk keeps its own
    // shape and an old one keeps its original verdicts.
    return sendJson(res, 200, { sweep: { ...sweepState(), stale: sweepStale() } });
  }

  if (pathname === "/api/models/sweep" && method === "POST") {
    // A catalog sweep is a burst of requests against someone else's gateway, so it
    // only ever starts because a person asked for it - and never twice at once.
    const payload = await readJson(req);
    const all = payload.all === true || payload.all === "true";
    if (sweepState().running) return sendJson(res, 409, { sweep: sweepState() });
    try {
      return sendJson(res, 202, { sweep: await startSweep(all) });
    } catch (error) {
      throw new HttpError(502, (error as Error).message);
    }
  }

  if (pathname === "/api/sessions" && method === "GET") {
    return sendJson(res, 200, { sessions: await listSessions() });
  }

  if (pathname === "/api/sessions" && method === "POST") {
    const session = createSession();
    await saveSession(session);
    return sendJson(res, 201, { session });
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1] ?? "");
    if (method === "GET") {
      const session = await getSession(id);
      if (session === null) throw new HttpError(404, "session not found");
      return sendJson(res, 200, { session });
    }
    if (method === "PATCH") {
      // Remembers the per-chat model and step budget without starting a turn.
      const session = await getSession(id);
      if (session === null) throw new HttpError(404, "session not found");
      const payload = await readJson(req);
      if (typeof payload.model === "string" && payload.model !== "") session.model = payload.model;
      const fallbacks = normalizeModelList(payload.fallbackModels);
      if (fallbacks !== undefined) session.fallbackModels = fallbacks;
      const offline = normalizeFlag(payload.useOffline);
      if (offline !== undefined) session.useOffline = offline;
      const steps = normalizeMaxSteps(payload.maxSteps);
      if (steps !== undefined) session.maxSteps = steps;
      await saveSession(session);
      return sendJson(res, 200, {
        session: {
          id: session.id,
          model: session.model,
          fallbackModels: session.fallbackModels,
          useOffline: session.useOffline,
          maxSteps: session.maxSteps,
        },
      });
    }
    if (method === "DELETE") {
      const removed = await deleteSession(id);
      return sendJson(res, removed ? 200 : 404, { removed });
    }
  }

  /*
   * The folder picker. It answers where the agent is working, which directories
   * beside that one can be chosen, and how to make a new one — all of it inside
   * the sandbox, because a picker that could name a path outside the mount would
   * hand the agent the host.
   */
  if (pathname === "/api/workspace" && method === "GET") {
    return sendJson(res, 200, {
      base: sandboxRoot(),
      rel: selectedWorkspace(),
      cwd: workspaceRoot(),
      dirs: await listWorkspaceDirs(),
    });
  }

  if (pathname === "/api/workspace" && method === "POST") {
    const payload = await readJson(req);
    const rel = typeof payload.path === "string" ? payload.path : "";
    // Resolving against the sandbox is the validation: an absolute path or a
    // `..` is refused here, before anything is stored.
    const abs = resolveInBase(rel);
    if (!(await isDirectory(abs))) throw new HttpError(400, "that is not a directory");
    const chosen = toRelFromBase(abs);
    await setSelectedWorkspace(chosen === "." ? "" : chosen);
    // The running request is still in the scope it began in, so the reply names
    // where the *next* request will work rather than re-reading the old scope.
    return sendJson(res, 200, {
      rel: selectedWorkspace(),
      cwd: path.join(sandboxRoot(), selectedWorkspace()),
      dirs: await listWorkspaceDirs(),
    });
  }

  if (pathname === "/api/workspace/mkdir" && method === "POST") {
    const payload = await readJson(req);
    // A name, not a path: a new folder is made *in the directory the agent is
    // already working in*, so there is no path here to get wrong, and the fence
    // that applies to a tool's write applies to this too.
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name === "") throw new HttpError(400, "a folder name is required");
    if (name.includes("/") || name.includes("\\")) {
      throw new HttpError(400, "a folder name cannot contain a path separator");
    }
    if (name === "." || name === "..") throw new HttpError(400, "that is not a folder name");
    const abs = resolveInWorkspace(name);
    if (await pathExists(abs)) throw new HttpError(409, "something with that name is already there");
    await fs.mkdir(abs, { recursive: true });
    return sendJson(res, 201, { name, dirs: await listWorkspaceDirs() });
  }

  if (pathname === "/api/files" && method === "GET") {
    const rel = url.searchParams.get("path") ?? ".";
    const entries = await listDirectory(resolveInWorkspace(rel));
    // Mark anything the agent has written, so the tree shows where to look.
    const changed = await listSnapshots();
    return sendJson(res, 200, {
      path: rel,
      entries: entries.map((entry) => ({ ...entry, changed: changed.has(entry.path) })),
    });
  }

  if (pathname === "/api/file" && method === "GET") {
    const rel = url.searchParams.get("path") ?? "";
    const file = await readTextFile(resolveInWorkspace(rel));
    const snapshot = await readSnapshot(rel);
    return sendJson(res, 200, { path: rel, ...file, hasHistory: snapshot !== null });
  }

  if (pathname === "/api/file/diff" && method === "GET") {
    // The file as it is now, against the last version the agent changed.
    const rel = url.searchParams.get("path") ?? "";
    const snapshot = await readSnapshot(rel);
    if (snapshot === null) return sendJson(res, 200, { path: rel, diff: null });

    const current = await readTextFile(resolveInWorkspace(rel));
    const diff = buildFileDiff(rel, snapshot.content, current.content, {
      created: snapshot.content === "" && current.content !== "",
    });
    return sendJson(res, 200, {
      path: rel,
      savedAt: snapshot.savedAt,
      truncatedFile: current.truncated,
      diff,
    });
  }

  if (pathname === "/api/file/diff" && method === "POST") {
    /*
     * Diff a body the caller is still writing (a `draft`) against the file on
     * disk. The baseline has to be the file as it stands rather than a snapshot:
     * when a chat writes the same file twice, the second draft is replacing the
     * first write, which is what is on disk by then.
     */
    const payload = await readJson(req, 8_000_000);
    const rel = typeof payload.path === "string" ? payload.path : "";
    const after = typeof payload.content === "string" ? payload.content : "";
    const abs = resolveInWorkspace(rel);

    let before = "";
    if (await pathExists(abs)) {
      try {
        before = (await readTextFile(abs)).content;
      } catch {
        // A binary or unreadable file cannot be diffed as text; say nothing
        // rather than inventing a baseline.
        return sendJson(res, 200, { path: rel, diff: null });
      }
    }

    const diff = buildFileDiff(rel, before, after, { created: before === "" && after !== "" });
    return sendJson(res, 200, { path: rel, diff });
  }

  if (pathname === "/api/file" && method === "DELETE") {
    const rel = url.searchParams.get("path") ?? "";
    const abs = resolveInWorkspace(rel);
    if (!(await pathExists(abs))) return sendJson(res, 404, { removed: false, path: rel });

    const bytes = await deleteWorkspaceEntry(abs);
    // The history of a file that no longer exists would make its next version
    // look like a change to a stranger, so it goes with the file.
    await dropSnapshot(rel);
    return sendJson(res, 200, { removed: true, path: rel, bytes });
  }

  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
  if (approvalMatch && method === "POST") {
    const id = decodeURIComponent(approvalMatch[1] ?? "");
    const payload = await readJson(req);
    const decision = payload.decision === "approve" ? "approve" : payload.decision === "deny" ? "deny" : null;
    if (decision === null) throw new HttpError(400, 'decision must be "approve" or "deny"');
    const resolved = resolveApproval(id, decision);
    // 404 means the turn already finished or timed out; the UI just shows that.
    return sendJson(res, resolved ? 200 : 404, { resolved });
  }

  if (pathname === "/api/chat" && method === "POST") {
    return await handleChat(req, res);
  }

  throw new HttpError(404, "not found");
}

/**
 * Build the HTTP server without binding it.
 *
 * Kept separate from the listener below so a test can start one on an ephemeral
 * port; importing this module must never claim the real one.
 */
export function createServer(): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      try {
        if (url.pathname.startsWith("/api/")) {
          if (await handleAuthRoutes(req, res, url)) return;
          if (!isAuthorized(req, url)) throw new HttpError(401, "unauthorized");
          /*
           * Whose workspace this request is, decided before routing so that every
           * route agrees: the tree, a file read, a diff, the session list and an
           * export all resolve paths through the account's own slice rather than
           * the deployment's shared one. With no control plane configured this is
           * the shared scope, exactly as before.
           *
           * A refusal here is the same posture as the turn gate's: tenancy needs
           * sign-in, because the control plane keys accounts on the OIDC subject
           * and a shared bearer carries no subject to key on. Serving the shared
           * workspace instead would be the leak this exists to close.
           */
          const scope = await scopeFor(sessionFrom(req));
          if (!scope.ok) throw new HttpError(scope.status, scope.message);
          await runInScope(scope.scope, () => handleApi(req, res, url));
          return;
        }
        if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = error instanceof HttpError ? error.status : error instanceof WorkspaceError ? 400 : 500;
        sendJson(res, status, { error: (error as Error).message });
      }
    })();
  });
}

// --- entrypoint -------------------------------------------------------------

const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await ensureWorkspace();
  // Check the chain on a timer, so a model that has quietly stopped working is
  // visible in the UI before it costs a turn.
  startModelHealthLoop();
  const server = createServer();

  server.listen(config.port, config.host, () => {
    const health = `${config.gatewayUrl} (model: ${config.model})`;
    console.log("coding agent ready");
    console.log(`  ui        http://${config.host}:${config.port}`);
    console.log(`  gateway   ${health}`);
    console.log(`  workspace ${config.workspace}`);
    if (controlPlaneEnabled()) {
      console.log("  tenancy   one workspace per account, under accounts/<account>/");
    }
    if (config.webToken !== "") console.log("  auth      bearer token required");
    if (oidcEnabled()) console.log(`  auth      sign-in via ${config.oidcIssuer} -> ${redirectUri()}`);
    console.log(
      config.healthIntervalMs > 0
        ? `  health    checking the chain every ${Math.round(config.healthIntervalMs / 60_000)} min`
        : "  health    chain check off",
    );

    // Anyone who can reach this port can edit files and run code, so a
    // non-loopback bind without a token is worth shouting about.
    const loopback =
      config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";
    if (!loopback && config.webToken === "" && !oidcEnabled()) {
      console.warn(
        `  warning   HOST=${config.host} exposes this agent beyond localhost with no WEB_TOKEN. ` +
          "Anyone who can reach the port can read, edit and run code. Set WEB_TOKEN to require a token.",
      );
    }

    void sandboxInfo().then((sandbox) => {
      console.log(`  sandbox   ${sandbox.backend} - ${sandbox.detail}`);
    });

    void gatewayHealth().then((result) => {
      if (result.ok) {
        console.log(`  status    gateway reachable, ${result.modelCount} models available`);
      } else {
        console.warn(`  status    gateway unreachable - ${(result.error ?? "unknown error").split("\n")[0]}`);
      }
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
