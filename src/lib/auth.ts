import "server-only";

import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { SESSION_COOKIE, cookieIsSecure, parseCookieSecurity } from "./auth-rules";
import { prisma } from "./db";
import type { Role } from "@prisma/client";

export { ACCENT_COLORS, hashPassword, pickAccent, verifyPassword } from "./auth-hash";
// Re-exported so callers keep importing the session cookie from where it is used.
export { SESSION_COOKIE };

const ALGORITHM = "HS256";

/**
 * The deployment's signing key. Exported so the single sign-on round trip is
 * signed with the same secret as the session it eventually issues — one secret to
 * rotate, not two.
 */
export function sessionSigningKey(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 16) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Copy .env.example to .env and set a long random value.",
    );
  }
  return new TextEncoder().encode(value);
}

function sessionTtlSeconds(): number {
  const parsed = Number(process.env.SESSION_TTL_SECONDS ?? "604800");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 604800;
}

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                  */
/* -------------------------------------------------------------------------- */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  accent: string;
  /// The tenancy this person belongs to; every scoped read uses it (see lib/tenancy.ts).
  organizationId: string | null;
  /// The platform operator, who creates tenancies for specialised training programs.
  platformAdmin: boolean;
}

/**
 * What a session token carries.
 *
 * Deliberately *not* `SessionUser`: the token signs who someone is, and the tenancy they
 * belong to is read from the database on every request instead. A person moved from one
 * organisation to another — or made an operator — would otherwise keep the old answer
 * until their cookie expired, which is exactly the bug a multi-tenant deployment cannot
 * afford.
 */
export interface SessionClaims {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export async function createSession(user: SessionClaims): Promise<void> {
  const ttl = sessionTtlSeconds();
  const token = await new SignJWT({ email: user.email, role: user.role, name: user.name })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(sessionSigningKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await sessionCookieSecure(),
    path: "/",
    maxAge: ttl,
  });
}

/**
 * Whether the cookie this request is about to receive may be restricted to TLS.
 *
 * `X-Forwarded-Proto` is what a TLS terminator sets; a connection that reached this
 * process directly has nothing to say, which is answered as "not https".
 */
async function sessionCookieSecure(): Promise<boolean> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-proto");
  const scheme = forwarded ? forwarded.split(",")[0].trim() : null;
  return cookieIsSecure(parseCookieSecurity(process.env.AUTH_COOKIE_SECURE), scheme);
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Verify a raw JWT — shared with middleware, which runs on the edge runtime. */
export async function verifySessionToken(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: [ALGORITHM] });
    if (!payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

/** The current user, or null when signed out. Safe to call from any server component. */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const claims = await verifySessionToken(token);
  if (!claims) return null;

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      accent: true,
      active: true,
      organizationId: true,
      platformAdmin: true,
    },
  });
  if (!user || !user.active) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    accent: user.accent,
    organizationId: user.organizationId,
    platformAdmin: user.platformAdmin,
  };
}

/** Throwing variant for pages and actions that require a signed-in user. */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

/* -------------------------------------------------------------------------- */
/*  Authorisation                                                             */
/* -------------------------------------------------------------------------- */

export const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  INSTRUCTOR: "/instructor",
  STUDENT: "/student",
};

export function hasRole(user: SessionUser | null, ...roles: Role[]): boolean {
  return Boolean(user && roles.includes(user.role));
}

export function isStaff(user: SessionUser | null): boolean {
  return hasRole(user, "ADMIN", "INSTRUCTOR");
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  INSTRUCTOR: "Instructor",
  STUDENT: "Student",
};
