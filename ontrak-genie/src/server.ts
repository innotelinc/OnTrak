import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent } from "./agent.js";
import { listPendingApprovals, pendingApprovals, resolveApproval } from "./approval.js";
import {
  previewDialHost,
  previewEvents,
  previewPort,
  previewStatus,
  recheckPreview,
  startPreview,
  stopPreview,
} from "./preview.js";
import { config } from "./config.js";
import { controlPlaneEnabled, readControlPlaneConfig, reportControlPlaneOutage } from "./controlplane.js";
import { buildFileDiff } from "./diff.js";
import { modelHealth, startModelHealthLoop } from "./modelHealth.js";
import { autoFreeChain } from "./modelSelect.js";
import {
  abandonLogin,
  beginLogin,
  clearedCookie,
  completeLogin,
  LoginError,
  mintSession,
  oidcEnabled,
  redirectUri,
  safeReturnTo,
  sessionCookie,
  sessionFrom,
} from "./oidc.js";
import { gatewayHealth, listModels } from "./omniroute.js";
import {
  hostingInfo,
  publish as publishWorkspace,
  stopHosting,
  unpublish as unpublishWorkspace,
} from "./hosting.js";
import {
  createPreview,
  getPreview,
  hostingEnabled,
  listPreviews,
  previewEnabled,
  previewForHost,
  previewLabelFromHost,
  previewPublic,
  proxyPreview as proxyHostingPreview,
  proxyUpgrade,
  removePreview,
  startPreviewSweepLoop,
  stopPreview as stopHostingPreview,
  sweepPreviews,
} from "./preview-hosting.js";
import {
  createProject as createWorkspaceProject,
  deleteProject as deleteWorkspaceProject,
  listProjects,
  openProject as openWorkspaceProject,
  ProjectError,
  updateProject as updateWorkspaceProject,
} from "./projects.js";
import { sandboxInfo } from "./sandbox.js";
import { backendLabel, runShellCommand } from "./shell.js";
import {
  currentScope,
  runInScope,
  sandboxRoot,
  selectedWorkspace,
  setSelectedWorkspace,
  workspaceRoot,
} from "./scope.js";
import {
  readShared,
  revokeShare,
  shareReadableBy,
  shareSession,
  sharesByOwner,
  sharesForRecipient,
  summarizeShare,
} from "./sharing.js";
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
  normalizeProjectId,
  normalizeTitle,
  saveSession,
} from "./store.js";
import {
  accessForCaller,
  accountUsage,
  beginTurn,
  countUsage,
  finishTurn,
  modelAccessFor,
  resetCallerCache,
  scopeFor,
  type TurnUsage,
} from "./tenancy.js";
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

/**
 * Forward one request to the workspace's dev server.
 *
 * A straight byte pipe, because the response is whatever the project serves:
 * HTML, a bundle, an image, an event stream. Nothing here parses it, which is
 * what keeps the preview honest — a header the app set is a header the browser
 * sees, and a status it returned is the status the pane acted on.
 *
 * `503` when nothing is running is a real answer, not an error: it is what the
 * pane shows before somebody starts the app.
 */
/**
 * Move a document's root-relative URLs under `/preview/`.
 *
 * The app is proxied on a prefix, but it was written to be served at a root: a
 * Vite or CRA page asks for `/assets/app.js`, which the browser then fetches from
 * *this* server's root and gets a 404. Rewriting the document's own attributes is
 * what puts those requests back on the app. Only the page itself is touched —
 * every script it loads then resolves its own imports against `/preview/`, which
 * is already correct.
 *
 * Deliberately shallow: attributes only, no CSS, no `srcset`, no string surgery
 * inside scripts. Anything beyond this is a rewrite engine, and a rewrite engine
 * is a thing that breaks pages in ways nobody can debug.
 */
function prefixRootUrls(html: string): string {
  return html.replace(
    /\b(src|href|action|poster)\s*=\s*(["'])\/(?!\/|preview\/)/gi,
    (_match, attribute: string, quote: string) => `${attribute}=${quote}/preview/`,
  );
}

/** A document larger than this is streamed through unrewritten rather than buffered. */
const HTML_REWRITE_LIMIT = 4 * 1024 * 1024;

/**
 * The app's own paths, forwarded as they were asked for.
 *
 * A rewrite of the document's attributes cannot reach a URL a bundle builds at
 * runtime: Vite asks for `/@vite/client`, Next for `/_next/webpack-hmr`, and a
 * dynamic import is a string a build step produced. Those requests arrive at
 * *this* origin's root, where the console lives, so the console answers them —
 * with its own 404, which is the blank page the pane used to show.
 *
 * So when nothing else claims a path, the running app does. The console's own
 * routes are a closed set and they are matched first: the shell, its assets, the
 * gate, `/health` and everything under `/api/` and `/preview/`. What is left is
 * the app's namespace, and forwarding it unchanged is what makes a framework's
 * absolute URLs work through a proxy at all.
 *
 * While a preview is running the console therefore has no 404 page — a typo
 * reaches the app and gets the app's answer. That is the trade, and it is the
 * right way round: a preview that renders is what was asked for.
 */
function proxyAppRoot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  return forwardToApp(req, res, `${url.pathname}${url.search ?? ""}`, false);
}

function proxyPreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  // `/preview/foo` is `/foo` to the app: it was written to be served at its own
  // root, and a dev server that expected a prefix would not be a dev server.
  const rest = url.pathname.replace(/^\/preview/, "") || "/";
  return forwardToApp(req, res, `${rest}${url.search ?? ""}`, true);
}

function forwardToApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: string,
  rewriteDocument: boolean,
): Promise<void> {
  const port = previewPort();
  if (port === null) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No preview is running yet. Start the app, then reload this pane.\n");
    return Promise.resolve();
  }

  // Where the app actually is, which is not always loopback: a deployment can
  // bind the preview to the LAN address it publishes.
  const dial = previewDialHost();

  return new Promise<void>((resolve) => {
    const upstream = http.request(
      {
        host: dial,
        port,
        path: target,
        method: req.method,
        headers: { ...req.headers, host: `${dial}:${port}` },
      },
      (answer) => {
        const type = String(answer.headers["content-type"] ?? "");
        const rewritable =
          rewriteDocument &&
          type.includes("text/html") &&
          answer.headers["content-encoding"] === undefined;
        if (!rewritable) {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
          answer.on("end", resolve);
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let flushed = false;
        const flushAsIs = (): void => {
          if (flushed) return;
          flushed = true;
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          for (const chunk of chunks) res.write(chunk);
        };
        answer.on("data", (chunk: Buffer) => {
          if (flushed) {
            res.write(chunk);
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
          // Too big to hold, and holding it is the only way to rewrite it: send
          // what has arrived and get out of the way.
          if (size > HTML_REWRITE_LIMIT) flushAsIs();
        });
        answer.on("end", () => {
          if (flushed) {
            res.end();
          } else {
            const headers = { ...answer.headers };
            const body = Buffer.from(prefixRootUrls(Buffer.concat(chunks).toString("utf8")), "utf8");
            /*
             * The body is no longer the one the app sent, so neither of its
             * length headers can be trusted. A dev server usually answers with
             * `chunked` rather than a length, and the two cannot be sent
             * together, so `chunked` goes and a measured length takes its place.
             */
            delete headers["content-length"];
            delete headers["transfer-encoding"];
            headers["content-length"] = String(body.length);
            res.writeHead(answer.statusCode ?? 502, headers);
            res.end(body);
          }
          resolve();
        });
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("The preview is not reachable — the app may have exited (see its output).\n");
      resolve();
    });
    req.pipe(upstream);
  });
}

/**
 * A websocket, forwarded to the running app.
 *
 * This is what a development server's own hot reload actually is: Vite's client
 * opens `ws://…/` and Next's opens `/_next/webpack-hmr`, and both are absolute
 * paths on this origin. Without this they get a socket the console never answers,
 * and the app's console fills with a reconnect loop that looks like a bug in the
 * app rather than a limitation of the preview.
 *
 * The handshake is written out by hand rather than through `http.request`
 * because an upgrade is not a request/response pair: the headers go upstream, and
 * from then on the two sockets are one pipe.
 */
function proxyAppUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  url: URL,
): void {
  const port = previewPort();
  if (port === null) {
    socket.destroy();
    return;
  }

  const prefixed = url.pathname === "/preview" || url.pathname.startsWith("/preview/");
  const rest = prefixed ? url.pathname.replace(/^\/preview/, "") || "/" : url.pathname;
  const target = `${rest}${url.search ?? ""}`;

  const dial = previewDialHost();
  const upstream = net.connect({ host: dial, port }, () => {
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: `${dial}:${port}`,
    };
    const lines = [`GET ${target} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    // Bytes the parser already read past the headers still belong to the stream.
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
}

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
 * Who answered a prompt, for the decision log.
 *
 * A signed-in caller is named by their identity; a bare bearer is the shared
 * token and can only be called that; loopback with neither is this machine. The
 * point is that the log never implies a person answered when none did — an
 * unattended approval is exactly the case worth being able to spot.
 */
function approvalActor(req: http.IncomingMessage): string {
  const session = sessionFrom(req);
  if (session !== null) return session.email !== "" ? session.email : `oidc:${session.sub}`;
  if (config.webToken !== "") return "shared-token";
  return "local";
}

/**
 * Who is asking, as sharing needs to know them.
 *
 * The account id comes from the request's slice (what tenancy resolved) and the
 * address from the session, and the two answer different questions: the id says
 * which *disk* a share reads from, the address says which human it was made for.
 * In single-operator mode there is no id, which is exactly why sharing degrades to
 * "nothing to share with" rather than to a second, weaker permission.
 */
function viewerOf(req: http.IncomingMessage): { userId: string | null; email: string } {
  const session = sessionFrom(req);
  return { userId: currentScope().userId, email: session?.email ?? "" };
}

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
    /*
     * The answer has to agree with `isAuthorized`, or the console lies to
     * itself. The case that does not: a deployment with **both** sign-in and
     * `WEB_TOKEN` configured. A caller holding the token is authorized, but
     * reporting `authenticated: false` sent the shell to the gate, which
     * offered a sign-in that a token holder does not need — a lockout dressed
     * as a redirect. So the token is checked here the same way it is there.
     */
    const tokenHeld =
      config.webToken !== "" &&
      (req.headers.authorization === `Bearer ${config.webToken}` ||
        url.searchParams.get("token") === config.webToken);
    sendJson(res, 200, {
      oidc: oidcEnabled(),
      // Without sign-in configured this mirrors the server: a token or a
      // loopback caller is as authorized as it gets.
      authenticated: session !== null || tokenHeld || (config.webToken === "" && !oidcEnabled()),
      identity:
        session === null ? null : { sub: session.sub, email: session.email, name: session.name },
    });
    return true;
  }

  if (pathname === "/api/auth/login" && req.method === "GET") {
    if (!oidcEnabled()) throw new HttpError(404, "sign-in is not configured");
    // `next` comes from the gate, which got it from the page that bounced the
    // visitor. It is normalized to a path on this origin before it is kept.
    res.writeHead(302, {
      Location: await beginLogin(safeReturnTo(url.searchParams.get("next")), req.headers.host),
    });
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

    let completed;
    try {
      completed = await completeLogin(url.searchParams.get("code") ?? "", state);
    } catch (failure) {
      // A sign-in that did not work is a 401, not a 500 — but a provider that
      // could not be reached is a 502, and conflating the two sends the operator
      // to the wrong thing. The state is already spent either way.
      const status = failure instanceof LoginError ? 401 : 502;
      throw new HttpError(status, (failure as Error).message);
    }

    // Back to the page the visitor asked for rather than always the root, which
    // is what a link into a deep page expects of a sign-in.
    res.writeHead(302, {
      Location: completed.returnTo,
      "Set-Cookie": sessionCookie(mintSession(completed.identity)),
    });
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

// --- preview claims (server-to-server) --------------------------------------

/**
 * A paid subscriber's custom preview name, claimed by Magnate after checkout.
 *
 * This route is authorized by its own bearer (`PREVIEW_CLAIM_TOKEN`) rather than
 * the console's session or `WEB_TOKEN`, because the caller is another service
 * and not a person at a browser. When no token is configured the function
 * declines and the request falls through to the ordinary authorization, so an
 * unconfigured deployment is not left with a route that answers to anyone.
 */
async function handlePreviewClaim(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const token = config.previewClaimToken;
  if (token === "" || req.headers.authorization !== `Bearer ${token}`) return false;
  if (!hostingEnabled()) throw new HttpError(404, "preview hosting is not enabled");

  const payload = await readJson(req);
  const name = typeof payload.name === "string" ? payload.name : "";
  const user = typeof payload.user === "string" ? payload.user : "";
  const command = typeof payload.command === "string" ? payload.command : undefined;
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : undefined;
  try {
    const preview = await createPreview({ name, user, command, cwd });
    sendJson(res, 201, { preview: previewPublic(preview) });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message });
  }
  return true;
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
  // The same plan the gate just read, so the model and the key agree on who pays.
  const autoFree = accessForCaller(turn.caller).auto;

  let usage: TurnUsage = { tokensIn: 0, tokensOut: 0, requests: 0 };

  // A chat started while a project is open is tagged with it, so the project can
  // list the work done against it. Only applied when the chat is *created* —
  // reopening an existing chat must not move it to whichever project is on
  // screen, which would rewrite history as you browse.
  const projectId = normalizeProjectId(body.projectId);
  let session = sessionId === "" ? null : await getSession(sessionId);
  if (session === null) {
    session = createSession();
    if (projectId !== undefined && projectId !== null) session.projectId = projectId;
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
      // An account without a paid plan is served the automatic free pool (see
      // `modelSelect.ts`), so a model it sent is ignored rather than refused: the
      // picker is hidden for exactly this caller, and a page that was open before
      // the plan changed could still be holding one. The choice is made from the
      // plan the turn gate already read, so the picker and the chain cannot
      // disagree about who is allowed to choose.
      model: autoFree ? undefined : model,
      fallbackModels: autoFree ? undefined : fallbackModels,
      autoFree,
      useOffline,
      maxSteps,
      // The account's own key when a control plane resolved one; otherwise
      // undefined, and the shared key applies exactly as it did before.
      apiKey: turn.apiKey,
      /*
       * The key may have been rotated since this process last resolved the
       * account (it is cached for minutes), and a 401 proves it has: drop the
       * cache so the next turn asks the plane again instead of replaying a dead
       * key until the entry expires. Nothing is lost when it was not stale — the
       * resolve is one cheap request, and only a turn that already failed.
       */
      onGatewayAuthFailure: () => resetCallerCache(),
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
    // Whether this caller chooses a model, from the plan the control plane holds.
    // Never throws: an unreachable plane reads as free/auto, which is the safe
    // direction (see `modelAccessFor`).
    const access = await modelAccessFor(sessionFrom(req));
    return sendJson(res, 200, {
      ...health,
      model: config.model,
      /** The account's plan, and what it means for choosing a model. */
      plan: access.plan,
      paid: access.paid,
      modelSelection: access.auto ? "auto" : "manual",
      /** The curated free pool, and the chain an automatic turn would use now. */
      freeModels: config.freeModels,
      autoModels: autoFreeChain(),
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

  if (pathname === "/api/account/usage" && method === "GET") {
    // What this account has spent, and the ceiling it is measured against
    // (v0.3). The console shows it beside the status rows; a deployment with no
    // control plane has no account to read, which is an answer rather than an
    // error — the row then says so instead of failing.
    const usage = await accountUsage(sessionFrom(req));
    if (!usage.ok) {
      return sendJson(res, usage.status === 404 ? 200 : usage.status, {
        tenancy: controlPlaneEnabled(),
        error: usage.message,
      });
    }
    return sendJson(res, 200, {
      tenancy: true,
      email: usage.email,
      allowed: usage.usage.allowed,
      reasons: usage.usage.reasons,
      quota: usage.usage.quota,
      usageToday: usage.usage.usageToday,
      /**
       * The bound *Genie* enforces, beside the plane's plan (v1.0). `limit: 0`
       * means this deployment enforces none, which the console says rather than
       * implying a ceiling that is not there.
       */
      ceiling: usage.ceiling,
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
    // A chat started from a project carries that tag so the project can list its
    // work; one started anywhere else simply has none.
    const payload: Record<string, unknown> = await readJson(req).catch(
      () => ({}) as Record<string, unknown>,
    );
    const projectId = normalizeProjectId(payload.projectId);
    if (projectId !== undefined && projectId !== null) session.projectId = projectId;
    await saveSession(session);
    return sendJson(res, 201, { session });
  }

  /*
   * Shared transcripts (v0.4). Sharing is one chat's record handed to a
   * colleague: the routes below create it, list it from both sides, read it
   * read-only, and withdraw it. The chat route above deliberately knows nothing
   * about shares — a shared id is not in the recipient's own store, so a turn
   * against one is refused by the same code that refuses an unknown chat, which
   * is what keeps a share from becoming a way to run as somebody else.
   */
  const shareCreateMatch = /^\/api\/sessions\/([^/]+)\/share$/.exec(pathname);
  if (shareCreateMatch && method === "POST") {
    const id = decodeURIComponent(shareCreateMatch[1] ?? "");
    const viewer = viewerOf(req);
    if (viewer.userId === null) {
      throw new HttpError(400, "this deployment has no accounts to share with");
    }
    const payload = await readJson(req);
    const outcome = await shareSession({
      sessionId: id,
      ownerId: viewer.userId,
      ownerEmail: viewer.email,
      recipientEmail: typeof payload.email === "string" ? payload.email : "",
      // Ownership is the *recipient-visible* question here: a session that is not
      // in this account's own store is not this account's to share, and a share
      // is created from what is.
      owned: (await getSession(id)) !== null,
    });
    if (!outcome.ok) throw new HttpError(outcome.status, outcome.message);
    return sendJson(res, outcome.existing ? 200 : 201, {
      share: outcome.share,
      existing: outcome.existing,
    });
  }

  if (pathname === "/api/shares" && method === "GET") {
    const viewer = viewerOf(req);
    // Both sides in one answer: the person who shared wants to see what they
    // handed over as much as the person who received it. Empty rather than a
    // refusal in single-operator mode, where there is nobody to share with.
    const sharedWithMe = await Promise.all(
      (await sharesForRecipient(viewer.email)).map(summarizeShare),
    );
    const sharedByMe =
      viewer.userId === null ? [] : await sharesByOwner(viewer.userId);
    return sendJson(res, 200, { sharedWithMe, sharedByMe });
  }

  const shareMatch = /^\/api\/shares\/([^/]+)$/.exec(pathname);
  if (shareMatch) {
    const id = decodeURIComponent(shareMatch[1] ?? "");
    const viewer = viewerOf(req);
    if (method === "GET") {
      const share = await shareReadableBy(id, viewer);
      if (share === null) throw new HttpError(404, "share not found");
      const session = await readShared(share);
      if (session === null) throw new HttpError(404, "the owner has removed this chat");
      // Read-only, and said so in the shape: the transcript travels, the
      // recipient's own store does not gain a session to continue.
      return sendJson(res, 200, { share, session, readOnly: true });
    }
    if (method === "DELETE") {
      const removed = await revokeShare(id, viewer);
      if (removed === null) throw new HttpError(404, "share not found");
      return sendJson(res, 200, { removed: true });
    }
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
      // Remembers the per-chat model, name and step budget without starting a
      // turn. Naming and archiving are here rather than on routes of their own
      // because they are edits to the same record the settings already edit, and
      // one endpoint means one read-modify-write instead of a race between two.
      const session = await getSession(id);
      if (session === null) throw new HttpError(404, "session not found");
      const payload = await readJson(req);
      const title = normalizeTitle(payload.title);
      if (title !== undefined) session.title = title;
      const archived = normalizeFlag(payload.archived);
      if (archived !== undefined) {
        session.archived = archived;
        if (archived) session.archivedAt = new Date().toISOString();
        else delete session.archivedAt;
      }
      // An account on the automatic model has no choice to save: its model and
      // chain are chosen per turn, so a stored one would be written and then
      // ignored. The write is skipped rather than refused — the response still
      // reports the settings in force, and the UI hides the controls for exactly
      // this caller (`/api/health` says so), so a request reaching here is a stale
      // page rather than a person being told no.
      const access = await modelAccessFor(sessionFrom(req));
      if (!access.auto) {
        if (typeof payload.model === "string" && payload.model !== "") session.model = payload.model;
        const fallbacks = normalizeModelList(payload.fallbackModels);
        if (fallbacks !== undefined) session.fallbackModels = fallbacks;
      }
      const offline = normalizeFlag(payload.useOffline);
      if (offline !== undefined) session.useOffline = offline;
      const steps = normalizeMaxSteps(payload.maxSteps);
      if (steps !== undefined) session.maxSteps = steps;
      // `null` clears the tag; an absent key leaves it as it is.
      const projectId = normalizeProjectId(payload.projectId);
      if (projectId === null) delete session.projectId;
      else if (projectId !== undefined) session.projectId = projectId;
      await saveSession(session);
      return sendJson(res, 200, {
        session: {
          id: session.id,
          title: session.title,
          ...(session.archived !== undefined ? { archived: session.archived } : {}),
          ...(session.archivedAt !== undefined ? { archivedAt: session.archivedAt } : {}),
          ...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
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

  /*
   * Saved workspace projects (`src/projects.ts`).
   *
   * A project is a named, kept directory: creating one makes the directory and
   * remembers it, opening one makes it the account's working directory through
   * the *same* mechanism the folder picker uses, and deleting one can keep the
   * files or remove them, because "stop listing this" and "throw this away" are
   * different decisions. Every path goes through `projects.ts`, which fences it
   * to the sandbox, so a name can never become a path.
   */
  if (pathname === "/api/projects" && method === "GET") {
    return sendJson(res, 200, {
      base: sandboxRoot(),
      active: selectedWorkspace(),
      projects: await listProjects(selectedWorkspace()),
    });
  }

  if (pathname === "/api/projects" && method === "POST") {
    const payload = await readJson(req);
    try {
      const project = await createWorkspaceProject({
        name: payload.name,
        description: typeof payload.description === "string" ? payload.description : undefined,
        open: payload.open === true || payload.open === "true",
      });
      return sendJson(res, 201, { project, dirs: await listWorkspaceDirs() });
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(400, error.message);
      throw error;
    }
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1] ?? "");
    if (method === "PATCH") {
      const payload = await readJson(req);
      try {
        const project = await updateWorkspaceProject(id, {
          name: typeof payload.name === "string" ? payload.name : undefined,
          description: typeof payload.description === "string" ? payload.description : undefined,
        });
        if (project === null) throw new HttpError(404, "project not found");
        return sendJson(res, 200, { project });
      } catch (error) {
        if (error instanceof ProjectError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (method === "DELETE") {
      const removeDirectory =
        url.searchParams.get("files") === "delete" || url.searchParams.get("files") === "1";
      const removed = await deleteWorkspaceProject(id, removeDirectory);
      return sendJson(res, removed ? 200 : 404, { removed, files: removeDirectory });
    }
  }

  const projectOpenMatch = /^\/api\/projects\/([^/]+)\/open$/.exec(pathname);
  if (projectOpenMatch && method === "POST") {
    const id = decodeURIComponent(projectOpenMatch[1] ?? "");
    const project = await openWorkspaceProject(id);
    if (project === null) throw new HttpError(404, "project not found");
    return sendJson(res, 200, {
      project,
      rel: selectedWorkspace(),
      cwd: workspaceRoot(),
      dirs: await listWorkspaceDirs(),
    });
  }

  /*
   * The console's terminal.
   *
   * It runs through the *same* executor as the agent's `run_command`
   * (`src/shell.ts`), which is the whole design: the command guard, the sandbox
   * decision and the process-group kill are not re-implemented here, so a person
   * typing into the console cannot reach anywhere the model could not, and the
   * two can never drift apart. What it is not is an interactive shell — one
   * command in, its combined output out — and it says so rather than pretending
   * to be a PTY it cannot be over one HTTP request.
   *
   * It sits behind the same authorization gate as every other /api route, and the
   * cwd is resolved through `resolveInWorkspace`, so the fence around the account's
   * workspace applies to it exactly as it does to the agent.
   */
  if (pathname === "/api/terminal" && method === "POST") {
    const payload = await readJson(req, 64_000);
    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (command === "") throw new HttpError(400, "a command is required");
    if (command.length > 8_000) throw new HttpError(400, "that command is too long to run");

    const relCwd = typeof payload.cwd === "string" && payload.cwd.trim() !== "" ? payload.cwd : ".";
    const cwd = resolveInWorkspace(relCwd);
    const timeoutMs = typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined;

    const result = await runShellCommand({ command, cwd, timeoutMs });
    // A refusal is the caller's problem, not a server fault: 400, with the reason
    // in the same field the UI already prints errors from.
    const status = result.refused === undefined ? 200 : 400;
    return sendJson(res, status, {
      command,
      cwd: relCwd,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      where: backendLabel(result.backend),
      output: result.output,
      ...(result.refused === undefined ? {} : { error: result.refused }),
    });
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

  /*
   * The running app, and the three things a console needs to do with it: ask
   * what is up, start it, stop it. The bytes themselves are proxied under
   * `/preview/` (see `proxyPreview`) rather than here, because they are not the
   * API — they are whatever the project serves.
   */
  if (pathname === "/api/preview" && method === "GET") {
    // A start that found the server still building answered `pending`; asking the
    // port once per read is what turns that into the app, or into the failure it
    // really was. The pane polls this, so the whole thing costs one connect.
    await recheckPreview();
    return sendJson(res, 200, previewStatus());
  }

  if (pathname === "/api/preview/start" && method === "POST") {
    const payload = await readJson(req).catch(() => ({}) as Record<string, unknown>);
    const status = await startPreview({
      command: typeof payload.command === "string" ? payload.command : undefined,
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      port: typeof payload.port === "number" ? payload.port : undefined,
    });
    return sendJson(res, 200, status);
  }

  if (pathname === "/api/preview/stop" && method === "POST") {
    return sendJson(res, 200, await stopPreview());
  }

  /*
   * "The files changed" as a stream, so the pane reloads the app the moment it
   * is edited rather than when somebody notices. Debounced here rather than in
   * the browser: one save fires several events, and the point of the stream is
   * to be cheap.
   */
  if (pathname === "/api/preview/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const events = previewEvents();
    let pending: NodeJS.Timeout | null = null;
    const onChange = (): void => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        res.write(`data: ${JSON.stringify({ type: "change" })}\n\n`);
      }, 250);
    };
    events.on("change", onChange);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      events.off("change", onChange);
      clearInterval(keepAlive);
      if (pending !== null) clearTimeout(pending);
    });
    return;
  }

  /*
   * What the gate is waiting on.
   *
   * The browser learns about a prompt from the turn's own SSE stream; a driver
   * that is not watching one has no way to. This is that way - it lists the same
   * prompts the cards show, so a CI job or a CLI can decide on what a person
   * would have seen, then answer the same POST below.
   */
  if (pathname === "/api/approvals" && method === "GET") {
    return sendJson(res, 200, { pending: listPendingApprovals() });
  }

  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
  if (approvalMatch && method === "POST") {
    const id = decodeURIComponent(approvalMatch[1] ?? "");
    const payload = await readJson(req);
    const decision = payload.decision === "approve" ? "approve" : payload.decision === "deny" ? "deny" : null;
    if (decision === null) throw new HttpError(400, 'decision must be "approve" or "deny"');
    const resolved = resolveApproval(id, decision, approvalActor(req));
    // 404 means the turn already finished or timed out; the UI just shows that.
    return sendJson(res, resolved ? 200 : 404, { resolved });
  }

  if (pathname === "/api/previews" && method === "GET") {
    return sendJson(res, 200, {
      enabled: hostingEnabled(),
      domain: config.previewDomain,
      scheme: config.previewScheme,
      portStart: config.previewPortStart,
      portEnd: config.previewPortEnd,
      previews: (await listPreviews()).map(previewPublic),
    });
  }

  if (pathname === "/api/previews" && method === "POST") {
    if (!hostingEnabled()) throw new HttpError(404, "preview hosting is not enabled");
    const payload = await readJson(req);
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const command = typeof payload.command === "string" && payload.command !== "" ? payload.command : undefined;
    const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : workspaceRoot();
    const port = typeof payload.port === "number" ? payload.port : undefined;
    // A custom name is a paid entitlement, so a caller that names one carries the
    // identity it is checked against — the same field `POST /api/previews/claim`
    // supplies. An auto `p<port>` address needs no identity and ignores it.
    const user = typeof payload.user === "string" ? payload.user : "";
    const account = typeof payload.account === "string" && payload.account !== "" ? payload.account : (currentScope().userId ?? "");
    try {
      const preview = await createPreview({
        name,
        port,
        command,
        cwd,
        account,
        ...(user === "" ? {} : { user }),
      });
      return sendJson(res, 201, { preview: previewPublic(preview) });
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  }

  const previewMatch = /^\/api\/previews\/([^/]+)$/.exec(pathname);
  if (previewMatch) {
    const name = decodeURIComponent(previewMatch[1] ?? "");
    if (method === "GET") {
      const preview = await getPreview(name);
      if (preview === null) throw new HttpError(404, "preview not found");
      return sendJson(res, 200, { preview: previewPublic(preview) });
    }
    if (method === "DELETE") {
      const removed = await removePreview(name);
      return sendJson(res, removed ? 200 : 404, { removed });
    }
  }

  const previewStopMatch = /^\/api\/previews\/([^/]+)\/stop$/.exec(pathname);
  if (previewStopMatch && method === "POST") {
    const name = decodeURIComponent(previewStopMatch[1] ?? "");
    const stopped = await stopHostingPreview(name);
    return sendJson(res, stopped ? 200 : 404, { stopped });
  }

  /*
   * Publish & host — the console's view of the registry above.
   *
   * `/api/previews` is the registry; this is the *bargain* around it: what
   * publishing costs, whether this caller may hold a name, where to buy the plan,
   * and the one call that starts an address. The identity an entitlement is
   * checked against is the signed-in account's email, because that is the key
   * Magnate's subscription is stored under.
   */
  if (pathname === "/api/hosting" && method === "GET") {
    const viewer = viewerOf(req);
    return sendJson(res, 200, await hostingInfo(viewer.email !== "" ? viewer.email : (viewer.userId ?? "")));
  }

  if (pathname === "/api/hosting" && method === "POST") {
    const payload = await readJson(req);
    const viewer = viewerOf(req);
    try {
      const result = await publishWorkspace({
        name: typeof payload.name === "string" ? payload.name : undefined,
        command: typeof payload.command === "string" ? payload.command : undefined,
        account: currentScope().userId ?? "",
        user: viewer.email !== "" ? viewer.email : (viewer.userId ?? ""),
      });
      return sendJson(res, 201, result);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  }

  const hostingStopMatch = /^\/api\/hosting\/([^/]+)\/stop$/.exec(pathname);
  if (hostingStopMatch && method === "POST") {
    const name = decodeURIComponent(hostingStopMatch[1] ?? "");
    const stopped = await stopHosting(name);
    return sendJson(res, stopped ? 200 : 404, { stopped });
  }

  const hostingMatch = /^\/api\/hosting\/([^/]+)$/.exec(pathname);
  if (hostingMatch && method === "DELETE") {
    const name = decodeURIComponent(hostingMatch[1] ?? "");
    const removed = await unpublishWorkspace(name);
    return sendJson(res, removed ? 200 : 404, { removed });
  }

  if (pathname === "/api/chat" && method === "POST") {
    return await handleChat(req, res);
  }

  throw new HttpError(404, "not found");
}

/**
 * The liveness path the family portal probes to draw this product's status light.
 *
 * Unauthenticated by design: asking the Network "are you there" must not need a
 * credential the portal would have to hold, which is why every member of the
 * family answers on this one path.
 */
export const HEALTH_PATH = "/health";

/**
 * Build the HTTP server without binding it.
 *
 * Kept separate from the listener below so a test can start one on an ephemeral
 * port; importing this module must never claim the real one.
 */
export function createServer(): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      try {
        /*
         * Preview routing comes first, before liveness and before the API gate:
         * on a preview host every path — `/`, `/api/...`, an asset URL — belongs
         * to the preview server, and the Host is what says which. Reaching the
         * console's own routes on a preview address would be wrong in a way the
         * browser cannot see, so an address with no registration says so instead
         * of falling through to this console.
         */
        if (previewEnabled()) {
          const preview = await previewForHost(req.headers.host);
          if (preview !== null) {
            proxyHostingPreview(req, res, preview);
            return;
          }
          if (previewLabelFromHost(req.headers.host) !== null) {
            sendJson(res, 404, { error: "no preview is registered at this address" });
            return;
          }
        }

        // Liveness, answered before the API gate: it takes no session, no bearer
        // and no gateway, so a gateway that is down cannot make the console look
        // like it is.
        if (url.pathname === HEALTH_PATH && (req.method === "GET" || req.method === "HEAD")) {
          const body = JSON.stringify({ status: "ok", service: "ontrak-genie" });
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            ...(req.method === "HEAD" ? {} : { "Content-Length": Buffer.byteLength(body) }),
          });
          res.end(req.method === "HEAD" ? undefined : body);
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          if (await handleAuthRoutes(req, res, url)) return;
          if (url.pathname === "/api/previews/claim" && req.method === "POST") {
            if (await handlePreviewClaim(req, res)) return;
          }
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
        /*
         * The running app, proxied rather than iframed from somewhere else.
         *
         * Same origin on purpose: the app's own fetch and cookies then behave
         * in the preview exactly as they will when it is deployed, and the pane
         * does not need a second host, port or certificate. It is gated exactly
         * like the API — running code is not a public asset — and resolved
         * through the caller's scope, so one account's preview can never be
         * reached with another's request.
         */
        if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
          if (!isAuthorized(req, url)) throw new HttpError(401, "unauthorized");
          const previewScope = await scopeFor(sessionFrom(req));
          if (!previewScope.ok) throw new HttpError(previewScope.status, previewScope.message);
          await runInScope(previewScope.scope, () => proxyPreview(req, res, url));
          return;
        }

        if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;

        /*
         * Last, and only while an app is running: anything the console did not
         * claim belongs to the app. Gated the same way `/preview/` is, because
         * this is the same code being reached by a different path.
         */
        if (previewPort() !== null) {
          if (!isAuthorized(req, url)) throw new HttpError(401, "unauthorized");
          const appScope = await scopeFor(sessionFrom(req));
          if (!appScope.ok) throw new HttpError(appScope.status, appScope.message);
          await runInScope(appScope.scope, () => proxyAppRoot(req, res, url));
          return;
        }

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

  /*
   * Two previews share this one socket, and the Host decides which owns it.
   *
   * A Genie preview-hosting address (`p<port>.genie.innotel.us`, or a claimed
   * name) is routed straight to the port it names. `upgrade` never reaches the
   * request handler, so the same Host-to-port decision has to be made here —
   * otherwise a dev server's HMR connects to this console instead of to the
   * server it belongs to. Everything else is the console's own live preview: the
   * request carries the same cookie or token as the page that opened it, so it is
   * authorized the same way.
   */
  server.on("upgrade", (req, socket, head) => {
    const duplex = socket as net.Socket;

    // The console's own live preview (see `AGENT_PREVIEW_*`): a single dev
    // server proxied under `/preview/`. Reached when no preview-hosting address
    // matches the Host.
    const appUpgrade = (): void => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        try {
          if (previewPort() === null || url.pathname.startsWith("/api/")) {
            duplex.destroy();
            return;
          }
          if (!isAuthorized(req, url)) {
            duplex.destroy();
            return;
          }
          const scope = await scopeFor(sessionFrom(req));
          if (!scope.ok) {
            duplex.destroy();
            return;
          }
          await runInScope(scope.scope, async () => proxyAppUpgrade(req, duplex, head, url));
        } catch {
          duplex.destroy();
        }
      })();
    };

    if (previewEnabled()) {
      void previewForHost(req.headers.host).then((preview) => {
        if (preview === null) {
          appUpgrade();
          return;
        }
        proxyUpgrade(req, socket, head, preview);
      });
      return;
    }
    appUpgrade();
  });

  return server;
}

// --- entrypoint -------------------------------------------------------------

const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await ensureWorkspace();
  // Check the chain on a timer, so a model that has quietly stopped working is
  // visible in the UI before it costs a turn.
  startModelHealthLoop();

  // A control-plane outage is reported on the next call that succeeds, but a
  // console nobody is using makes no such call — and that is precisely when the
  // window would go unmentioned. The timer retries a recorded outage until the
  // plane accepts it; there is usually nothing pending, so it does nothing.
  if (controlPlaneEnabled() && config.controlPlaneOutageReportIntervalMs > 0) {
    const plane = readControlPlaneConfig();
    if (plane !== null) {
      setInterval(
        () => void reportControlPlaneOutage(plane),
        config.controlPlaneOutageReportIntervalMs,
      ).unref();
    }
  }

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
    if (previewEnabled()) {
      console.log(
        `  previews  https://*.${config.previewDomain} -> ${config.previewBackendHost}:${config.previewPortStart}-${config.previewPortEnd}`,
      );
      console.log(
        config.previewFreeTtlMs > 0
          ? `  previews  free addresses expire after ${Math.round(config.previewFreeTtlMs / 60_000)} min`
          : "  previews  free addresses do not expire",
      );
      // First, whatever outlived its TTL while the process was down: the timer
      // below only runs from here on, and a restart must not grant an amnesty.
      void sweepPreviews().then((removed) => {
        if (removed > 0) console.log(`  previews  swept ${removed} expired address(es)`);
      });
      // And keep enforcing it while the process is up, so a free address's port
      // comes back on time rather than at the next restart.
      startPreviewSweepLoop();
    }
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
