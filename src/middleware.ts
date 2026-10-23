import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

import { labHostPath } from "@/lib/lab-rules";

/**
 * Edge middleware guarding the role-scoped areas.
 *
 * It only reads the signed session cookie's role claim — no database access, so
 * it stays fast on every request. Server components still fetch the real user
 * (and therefore catch deactivated accounts); this is the outer fence, not the
 * only one.
 */

const SESSION_COOKIE = "ontrak_training_session";

/** path prefix -> roles allowed in. */
const GUARDS: { prefix: string; roles: string[] }[] = [
  { prefix: "/admin", roles: ["ADMIN"] },
  { prefix: "/instructor", roles: ["ADMIN", "INSTRUCTOR"] },
  { prefix: "/student", roles: ["ADMIN", "INSTRUCTOR", "STUDENT"] },
  // A printable certificate is only ever shown inside a session; which attempt a
  // student may open is decided by the page, not by the role.
  { prefix: "/certificate", roles: ["ADMIN", "INSTRUCTOR", "STUDENT"] },
];

const ROLE_HOME: Record<string, string> = {
  ADMIN: "/admin",
  INSTRUCTOR: "/instructor",
  STUDENT: "/student",
};

async function readSession(token: string | undefined): Promise<{ userId: string; role: string } | null> {
  if (!token) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.role !== "string") return null;
    return { userId: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // A deployment that serves the lab on its own name (see `labHostFromEnv`) answers the
  // lab's routes at that host's root. A rewrite, not a redirect: the browser stays on
  // `lab.example.test`, and the sign-in round trip it may trigger comes back to the same
  // address. The lab's own pages decide who may see them, so the role fence below is
  // skipped for them — `/lab/admin` already refuses anyone who is not staff.
  const labPath = labHostPath(request.headers.get("host"), pathname);
  if (labPath) {
    const url = request.nextUrl.clone();
    url.pathname = labPath;
    return NextResponse.rewrite(url);
  }

  const guard = GUARDS.find((entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`));
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);

  // Signed-in users have no business on the login screen.
  if ((pathname === "/login" || pathname === "/register") && session) {
    return NextResponse.redirect(new URL(ROLE_HOME[session.role] ?? "/student", request.url));
  }

  if (!guard) return NextResponse.next();

  if (!session) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  if (!guard.roles.includes(session.role)) {
    // Send people to the area they are actually allowed into.
    return NextResponse.redirect(new URL(ROLE_HOME[session.role] ?? "/student", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // The lab's own host is served from its root; these are the paths that have to reach
    // the middleware for that rewrite to happen. `/admin/:path*` is already below.
    "/",
    "/lessons/:path*",
    "/sessions/:path*",
    "/admin/:path*",
    "/instructor/:path*",
    "/student/:path*",
    "/certificate/:path*",
    "/login",
    "/register",
  ],
};
