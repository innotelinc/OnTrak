/**
 * What a portal deployment is.
 *
 * Everything here is an environment variable with a working default, because the
 * failure this avoids is the boring one: a service that will not start because a
 * variable somebody forgot is not in `.env`. The exception is the signing secret,
 * which has no default — a session cookie signed with a public placeholder is a
 * session cookie anybody can mint.
 *
 * Two of these are addresses the *browser* uses, not this process:
 * `ONTRAK_PORTAL_PUBLIC_URL` (this portal, and therefore its registered redirect
 * URI) and `ONTRAK_PORTAL_BASE_DOMAIN` (the family's names). Getting those wrong
 * produces a handshake that dies at the provider after the password has been
 * typed, which is the worst place to find out.
 */

import { parseRoleMappings, type Role } from "./portal-rules";

function env(name: string, fallback = ""): string {
  const raw = (process.env[name] ?? fallback).trim();
  // `.env` has three readers and they do not agree about quotes: compose
  // unquotes, `docker run --env-file` does not, and a shell that sources the file
  // does. Stripping them here is what makes a quoted cron-like value or a URL with
  // a shell-hostile character behave the same for all three.
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function list(name: string): string[] {
  return env(name).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export interface PortalConfig {
  /** The identity provider (Cerulean's Authentik). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  providerName: string;
  scopes: string;
  defaultRole: Role;
  roleMappings: Record<string, Role>;
  allowedDomains: string[];
  /** This portal, as the browser reaches it. The redirect URI is built from it. */
  publicUrl: string;
  /** The family's base domain: `<product>.<base domain>`. */
  baseDomain: string;
  secureLinks: boolean;
  /** Secret that signs the session cookie and the SSO state. No default. */
  sessionSecret: string;
  /** OnTrak Sync, which the portal uses as the identity authority for a local sign-in. */
  syncApiUrl: string;
  /**
   * The deployment token, used **server-side only** for the one thing the portal
   * does on somebody's behalf: reading and changing the account table on the
   * people page, which only an ADMIN can open. It is never sent to a browser, and
   * the page that uses it is gated by the same role rule as everything else.
   */
  syncApiToken: string;
  /** The break-glass portal account, for when the provider and Sync are both down. */
  breakGlassUser: string;
  breakGlassPassword: string;
}

export function portalConfig(): PortalConfig {
  const publicUrl = env("ONTRAK_PORTAL_PUBLIC_URL").replace(/\/+$/, "");
  const baseDomain = env("ONTRAK_PORTAL_BASE_DOMAIN", "ontrak.innotel.us").replace(/\.+$/, "");
  return {
    issuer: env("ONTRAK_OIDC_ISSUER").replace(/\/+$/, ""),
    clientId: env("ONTRAK_OIDC_CLIENT_ID"),
    clientSecret: env("ONTRAK_OIDC_CLIENT_SECRET"),
    providerName: env("ONTRAK_OIDC_PROVIDER_NAME", "Cerulean"),
    scopes: env("ONTRAK_OIDC_SCOPES", "openid profile email groups"),
    defaultRole: (env("ONTRAK_OIDC_DEFAULT_ROLE", "STUDENT").toUpperCase() as Role),
    roleMappings: parseRoleMappings(env("ONTRAK_OIDC_ROLE_MAPPINGS")),
    allowedDomains: list("ONTRAK_OIDC_ALLOWED_DOMAINS"),
    publicUrl,
    baseDomain,
    // The scheme follows the deployment rather than being assumed: a portal served
    // over plain HTTP on a LAN address must link to plain HTTP, or every tile is a
    // dead link with a certificate error.
    secureLinks: publicUrl ? publicUrl.startsWith("https://") : true,
    sessionSecret: env("ONTRAK_PORTAL_SESSION_SECRET"),
    syncApiUrl: env("ONTRAK_SYNC_API_URL", "http://ontrak-sync-api:8420").replace(/\/+$/, ""),
    syncApiToken: env("ONTRAK_SYNC_API_TOKEN"),
    breakGlassUser: env("ONTRAK_PORTAL_ADMIN_USER"),
    breakGlassPassword: env("ONTRAK_PORTAL_ADMIN_PASSWORD"),
  };
}

/** Whether the SSO button may be drawn. A button that cannot complete is worse than none. */
export function ssoConfigured(config: PortalConfig): boolean {
  return Boolean(config.issuer && config.clientId);
}

/**
 * The registered redirect URI.
 *
 * Empty when no public URL is set, rather than defaulted to `localhost`: a
 * redirect URI that only works on the machine the portal runs on is a
 * configuration that appears to work right up until it is deployed, and the
 * provider compares this byte for byte.
 */
export function redirectUri(config: PortalConfig = portalConfig()): string {
  if (!config.publicUrl) return "";
  return `${config.publicUrl}/api/sso/callback`;
}

export function sessionCookieSecure(config: PortalConfig = portalConfig()): boolean {
  return config.publicUrl.toLowerCase().startsWith("https://");
}

/**
 * An absolute URL on this portal, for a redirect the *browser* will follow.
 *
 * `ONTRAK_PORTAL_PUBLIC_URL` when it is set, and only otherwise the origin Next
 * derived from the request. The derived origin is the address the terminator used,
 * not the one the person typed — behind Nginx Proxy Manager it is the container's
 * own `0.0.0.0:3300`, and a browser handed that cannot get back to the login page.
 * Falling back to the request keeps a deployment with no public URL configured
 * working locally, which is the only case where the derived origin is right.
 */
export function portalUrl(requestUrl: string, path: string,
                          config: PortalConfig = portalConfig()): URL {
  const base = config.publicUrl || new URL(requestUrl).origin;
  return new URL(path, base);
}
