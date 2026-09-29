/**
 * The same-origin bridge to the API.
 *
 * Behind the Cerulean edge the dashboard is reached at `sync.ontrak.innotel.us`
 * and the API is on a container address nobody outside the LAN can resolve.
 * Rather than publish the API on its own hostname — which would mean a second
 * certificate, a second origin, and a session cookie split across two names — the
 * dashboard forwards `/api/*` to the API container itself.
 *
 * Three things about this being correct rather than convenient:
 *
 *  * **The session cookie is `HttpOnly` and belongs to the dashboard's origin.**
 *    The browser attaches it to `/api/*`, this handler passes it through, the API
 *    authenticates it, and no JavaScript anywhere has ever seen the value.
 *  * **The SSO callback has to land here.** `redirect_uri` is registered in
 *    Cerulean as `https://sync.ontrak.innotel.us/api/auth/sso/callback`; the
 *    provider redirects the *browser* there, so it has to be this origin.
 *  * **Redirects are not followed.** The API answers a successful sign-in with a
 *    303 to the dashboard, and `fetch` following it would turn that into a 200
 *    whose body is the dashboard's HTML — the sign-in would appear to do nothing.
 *
 * It is only used when `NEXT_PUBLIC_ONTRAK_API` is empty. A deployment that names
 * an API address in the build still talks to it directly from the browser, which
 * is what a fresh install on the LAN does.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Where the API lives *from this container*.
 *
 * The fallback is the API **container's** name, not a compose service name:
 * `docker-compose.yml` calls the service `ontrak-api` and `docker-compose.all.yml`
 * calls it `sync-api`, and a deployment that has been started by something other
 * than the file in front of you answers to neither. The container name is the one
 * that does not change with the file, and a wrong guess here is expensive — the
 * dashboard reports a 504 and looks like the API is down, when the API is fine.
 */
function upstreamBase(): string {
  return (
    process.env.ONTRAK_API_INTERNAL ||
    process.env.NEXT_PUBLIC_ONTRAK_API ||
    "http://ontrak-sync-api:8420"
  ).replace(/\/$/, "");
}

/** Headers that describe the hop, not the request, and must not be forwarded. */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "content-length",
]);

async function proxy(request: NextRequest, path: string[]): Promise<Response> {
  const search = request.nextUrl.search;
  const target = `${upstreamBase()}/api/${path.map(encodeURIComponent).join("/")}${search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lowered = key.toLowerCase();
    if (!HOP_BY_HOP.has(lowered) && lowered !== "accept-encoding") headers.set(key, value);
  });
  // The API throttles sign-ins per address, and behind two proxies the socket
  // address is always a container. The chain is appended rather than replaced so
  // the API's left-most-of-X-Forwarded-For rule still sees the real caller.
  const forwardedFor = request.headers.get("x-forwarded-for");
  const address = request.headers.get("x-real-ip");
  if (address) {
    headers.set("x-forwarded-for", forwardedFor ? `${forwardedFor}, ${address}` : address);
  }

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { detail: "the Ontrak Sync API is not reachable from the dashboard" },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lowered = key.toLowerCase();
    if (!HOP_BY_HOP.has(lowered) && lowered !== "set-cookie") {
      responseHeaders.set(key, value);
    }
  });
  // `set-cookie` is a list and has to be copied whole, or the session cookie and
  // the cookie-clearing instruction on a sign-out become one header.
  const cookies = typeof upstream.headers.getSetCookie === "function"
    ? upstream.headers.getSetCookie()
    : [upstream.headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}

export async function PUT(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: NextRequest, context: Context) {
  return proxy(request, (await context.params).path);
}
