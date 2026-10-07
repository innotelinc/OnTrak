/**
 * Signing the CLI in.
 *
 * Three ways in, in the order they are reached for:
 *
 *   1. **`genie login`** — the deployment's own OIDC sign-in with the answer
 *      handed to a loopback listener on this machine (`/api/auth/cli`). One
 *      command, the browser does the work, and the session lands where it is
 *      needed without crossing an origin.
 *   2. **`genie login --cookie <value>`** — paste a session from a browser that
 *      is already signed in. The escape hatch when the CLI is somewhere a
 *      browser is not, or the deployment has no loopback reachable.
 *   3. **`genie login --token <WEB_TOKEN>`** — the deployment's shared bearer,
 *      for a laptop with no sign-in configured at all.
 *
 * Whatever arrives is **verified before it is stored**: `GET /api/auth/status`
 * is asked with the credential, and only a `200` saying `authenticated: true`
 * is written to the config file. A credential that does not work is a message,
 * not a file that fails on the next command.
 */

import http from "node:http";
import { spawn } from "node:child_process";

import { GenieClient, type AuthStatus } from "./client.js";
import { normalizeUrl, writeConfig } from "./config.js";

export interface Identity {
  sub: string;
  email: string;
  name: string;
}

export interface LoginResult {
  identity: Identity;
  /** What was stored, so the caller can say which kind of credential it is. */
  kind: "session" | "token";
}

export class LoginFailure extends Error {}

/** Ask the server who this credential is. Throws when it is not accepted. */
export async function verifyCredential(
  base: string,
  credential: { token?: string; cookie?: string },
): Promise<AuthStatus> {
  const client = new GenieClient({ base, ...credential });
  let status: AuthStatus;
  try {
    status = await client.status();
  } catch (error) {
    throw new LoginFailure(
      `cannot reach ${base}: ${(error as Error).message}`,
    );
  }
  if (!status.authenticated) {
    const hint = status.oidc
      ? "this deployment requires sign-in; run `genie login`"
      : "the credential was not accepted";
    throw new LoginFailure(hint);
  }
  return status;
}

/** Open a URL in the platform's browser, best effort. Never throws. */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // A machine with no browser is expected; the URL was printed anyway.
  }
}

/** The page the browser lands on: hand the fragment to the CLI, then say so. */
const LOOPBACK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Genie CLI sign-in</title>
<style>
 body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b1020;color:#e7e9f3}
 .card{max-width:32rem;padding:2rem;border:1px solid #2b3358;border-radius:12px;background:#131a33}
 h1{margin:0 0 .5rem;font-size:1.1rem}code{color:#8be9fd}
</style></head>
<body><div class="card"><h1>Genie CLI sign-in</h1><p id="msg">Completing…</p></div>
<script>
const params = new URLSearchParams(location.hash.replace(/^#/, ""));
const token = params.get("genie_token");
const msg = document.getElementById("msg");
if (!token) {
  msg.textContent = "No credential was returned. Start again with <code>genie login</code>.";
} else {
  fetch("/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
    .then((r) => r.json())
    .then((r) => {
      msg.innerHTML = r.ok
        ? "Signed in as <b>" + (r.email || "you") + "</b>. You can close this tab."
        : "The CLI refused the credential: " + (r.error || "unknown reason");
      history.replaceState(null, "", location.pathname);
    })
    .catch((e) => { msg.textContent = "Could not reach the CLI on this machine: " + e.message; });
}
</script></body></html>`;

/**
 * The loopback handoff: listen, send the browser to the deployment, wait.
 *
 * The listener binds `127.0.0.1` on an ephemeral port and serves two things: the
 * page above, and the `/token` call that page makes. The server it is registered
 * with is told only the port, and it redirects only to that port on loopback —
 * so this cannot be used to deliver somebody else's session anywhere.
 */
export async function browserLogin(
  base: string,
  options: { timeoutMs?: number; open?: boolean; log?: (line: string) => void } = {},
): Promise<LoginResult> {
  const origin = normalizeUrl(base);
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const { server, port, waitForToken } = await startLoopback((token) =>
    verifyCredential(origin, { cookie: token }),
  );
  const start = `${origin}/api/auth/cli?port=${port}`;

  try {
    log(`opening ${start}`);
    log("if the browser does not open, visit that address; the CLI is listening on 127.0.0.1:" + port);
    if (options.open !== false) openBrowser(start);
    const { cookie, status } = await withTimeout(waitForToken(), timeoutMs);
    writeConfig({ url: origin, cookie, token: undefined });
    return { identity: identityOf(status), kind: "session" };
  } finally {
    server.close();
  }
}

/** Store a pasted session cookie after checking it works. */
export async function cookieLogin(base: string, cookie: string): Promise<LoginResult> {
  const origin = normalizeUrl(base);
  const status = await verifyCredential(origin, { cookie: cookie.trim() });
  writeConfig({ url: origin, cookie: cookie.trim() });
  return { identity: identityOf(status), kind: "session" };
}

/** Store a shared bearer after checking it works. */
export async function tokenLogin(base: string, token: string): Promise<LoginResult> {
  const origin = normalizeUrl(base);
  const status = await verifyCredential(origin, { token: token.trim() });
  writeConfig({ url: origin, token: token.trim() });
  return { identity: identityOf(status), kind: "token" };
}

function identityOf(status: AuthStatus): Identity {
  return status.identity ?? { sub: "", email: "", name: "token holder" };
}

interface Loopback {
  server: http.Server;
  port: number;
  waitForToken: () => Promise<{ cookie: string; status: AuthStatus }>;
}

/**
 * A one-shot local listener.
 *
 * It answers exactly one successful handoff and then rejects further ones, so a
 * second tab cannot replay the exchange. Failures do not resolve the promise, so
 * a bad token leaves the listener waiting for the real one.
 */
function startLoopback(
  verify: (token: string) => Promise<AuthStatus>,
): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let settle: ((value: { cookie: string; status: AuthStatus }) => void) | null = null;
    let rejectOnce: ((reason: Error) => void) | null = null;
    const result = new Promise<{ cookie: string; status: AuthStatus }>((res, rej) => {
      settle = res;
      rejectOnce = rej;
    });
    let consumed = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(LOOPBACK_PAGE);
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          void (async () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let token = "";
            try {
              token = String((JSON.parse(body) as { token?: unknown }).token ?? "");
            } catch {
              token = "";
            }
            if (token === "" || consumed) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "no credential" }));
              return;
            }
            try {
              const status = await verify(token);
              consumed = true;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, email: status.identity?.email ?? "" }));
              settle?.({ cookie: token, status });
            } catch (error) {
              // Not stored, and the listener stays up: a wrong paste is retried
              // by signing in again in the same tab.
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: (error as Error).message }));
            }
          })();
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.on("error", (error) => rejectOnce?.(error as Error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectOnce?.(new Error("could not bind a loopback port"));
        return;
      }
      resolve({ server, port: address.port, waitForToken: () => result });
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new LoginFailure("timed out waiting for the browser sign-in")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}
