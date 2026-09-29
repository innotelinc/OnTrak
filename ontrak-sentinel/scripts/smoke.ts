/**
 * One full OIDC round trip against a running provider, asserted rather than
 * eyeballed.
 *
 * The unit suite tests the rules and the live store test tests the SQL, but
 * neither answers the question a deployment actually has: *does this thing sign
 * somebody in, over the wire, with the key it is holding right now?* This asks
 * that, and CI runs it against the built image so the answer cannot quietly
 * become no.
 *
 * It performs the whole authorization-code flow with PKCE and then verifies the ID
 * token's RS256 signature against the JWKS the provider itself serves — the same
 * thing a real client does, and the only check that catches a signing key which
 * changed under a client's feet.
 *
 *   node --import tsx scripts/smoke.ts --base http://127.0.0.1:8787 \
 *     --client <client id> --session <session id>
 *
 * The same three values are read from `SENTINEL_SMOKE_BASE`,
 * `SENTINEL_SMOKE_CLIENT` and `SENTINEL_SMOKE_SESSION`, which is how CI passes
 * them.
 *
 * `--session` is the bootstrap session `npm run serve` prints: authorize needs
 * somebody signed in, and the provider is the thing under test, so it cannot mint
 * its own session through the front door. The demo session is already past the
 * second-factor policy for exactly that reason.
 *
 * Exits 0 when every check passes, 1 on the first step that cannot continue, and
 * names the checks that failed.
 */

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

/* -------------------------------------------------------------------------- */
/*  Input                                                                     */
/* -------------------------------------------------------------------------- */

function option(name: string, fromEnv: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  const inline = index !== -1 ? process.argv[index + 1] : undefined;
  const value = inline ?? process.env[fromEnv]?.trim();
  if (!value) throw new Error(`Pass ${flag} <value> or set ${fromEnv}.`);
  return value;
}

const BASE = option("base", "SENTINEL_SMOKE_BASE").replace(/\/+$/, "");
const CLIENT = option("client", "SENTINEL_SMOKE_CLIENT");
const SESSION = option("session", "SENTINEL_SMOKE_SESSION");

/** The redirect the demo client is registered with. Never actually visited. */
const REDIRECT_URI = "http://127.0.0.1:8788/callback";

/* -------------------------------------------------------------------------- */
/*  Reporting                                                                 */
/* -------------------------------------------------------------------------- */

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  const suffix = detail ? ` — ${detail}` : "";
  if (ok) {
    console.log(`  ok    ${label}${suffix}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${suffix}`);
}

function step(name: string): void {
  console.log(`\n${name}`);
}

/* -------------------------------------------------------------------------- */
/*  HTTP                                                                      */
/* -------------------------------------------------------------------------- */

interface Discovery {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
}

/** The published key, plus whatever else the provider chose to include. The index
 *  signature is what lets it be handed straight to `createPublicKey` as a JWK. */
interface Jwk {
  [member: string]: unknown;
  kty?: string;
  alg?: string;
  kid?: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string;
  nonce?: string;
  exp?: number;
  sub?: string;
  amr?: string[];
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/* -------------------------------------------------------------------------- */
/*  The flow                                                                  */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(`provider: ${BASE}\nclient:   ${CLIENT}`);

  // ── 1. Discovery. Everything after this is built from what the provider says
  // about itself rather than from what this script has assumed.
  step("discovery");
  const discoveryResponse = await fetchJson(`${BASE}/.well-known/openid-configuration`);
  check("the discovery document is served", discoveryResponse.status === 200, `HTTP ${discoveryResponse.status}`);
  if (discoveryResponse.status !== 200) {
    fail();
    return;
  }

  const discovery = (discoveryResponse.body ?? {}) as Discovery;
  check("it advertises an issuer", Boolean(discovery.issuer), discovery.issuer ?? "");
  check(
    "the advertised issuer is where it is actually running",
    discovery.issuer === BASE,
    `issuer says ${discovery.issuer ?? "(nothing)"}`,
  );
  const endpoints: ReadonlyArray<readonly [string, string | undefined]> = [
    ["authorization_endpoint", discovery.authorization_endpoint],
    ["token_endpoint", discovery.token_endpoint],
    ["jwks_uri", discovery.jwks_uri],
    ["userinfo_endpoint", discovery.userinfo_endpoint],
  ];
  for (const [name, url] of endpoints) {
    check(`it advertises ${name}`, typeof url === "string" && url.length > 0, url ?? "");
  }
  if (failures > 0) {
    fail();
    return;
  }

  // ── 2. Keys, fetched before the token so the verification below is against
  // what a client would hold, not against the private key this run knows.
  step("jwks");
  const jwksResponse = await fetchJson(String(discovery.jwks_uri));
  const keys = ((jwksResponse.body ?? {}) as { keys?: Jwk[] }).keys ?? [];
  check("at least one signing key is published", keys.length > 0, `${keys.length} key(s)`);
  check("every published key is RSA/RS256", keys.length > 0 && keys.every((k) => k.kty === "RSA" && k.alg === "RS256"));
  check(
    "every key is named, so a rotation is addressable",
    keys.length > 0 && keys.every((k) => typeof k.kid === "string" && k.kid.length > 0),
  );

  // ── 3. Authorize. PKCE for real, and the redirect is deliberately not
  // followed: the code in the Location header is the point.
  step("authorize");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");

  const authorizationUrl = new URL(String(discovery.authorization_endpoint));
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", CLIENT);
  authorizationUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizationUrl.searchParams.set("scope", "openid profile email roles");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const authorized = await fetch(authorizationUrl, {
    redirect: "manual",
    headers: { "X-Sentinel-Session": SESSION },
  });
  const location = authorized.headers.get("location") ?? "";
  check(
    "authorize answers with a redirect carrying a code",
    authorized.status === 302 && location.includes("code="),
    `HTTP ${authorized.status}`,
  );
  if (failures > 0) {
    fail();
    return;
  }

  const returned = new URL(location);
  const code = returned.searchParams.get("code") ?? "";
  check("the state comes back unchanged", returned.searchParams.get("state") === state);

  // ── 4. Token. The exchange is what proves the PKCE verifier was bound to the
  // code the browser received.
  step("token");
  const tokenResponse = await fetch(String(discovery.token_endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT,
      code_verifier: verifier,
    }),
  });
  const tokenText = await tokenResponse.text();
  let tokens: TokenResponse = {};
  try {
    tokens = JSON.parse(tokenText) as TokenResponse;
  } catch {
    // Left empty so the next check reports the status and the body below.
  }
  check("the code exchanges for tokens", tokenResponse.status === 200, `HTTP ${tokenResponse.status}`);
  if (tokenResponse.status !== 200) {
    console.log(`        body: ${tokenText.slice(0, 300)}`);
    fail();
    return;
  }
  check("an access token is issued", Boolean(tokens.access_token));
  check("an ID token is issued", Boolean(tokens.id_token));
  check("it is a bearer token", tokens.token_type?.toLowerCase() === "bearer", tokens.token_type ?? "");

  const parts = String(tokens.id_token).split(".");
  check("the ID token is a compact JWS with three parts", parts.length === 3);
  if (parts.length !== 3) {
    fail();
    return;
  }
  const [header, payload, signature] = parts;
  const headerJson = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { kid?: string; alg?: string };
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdTokenClaims;

  // ── 5. Verify. This is the check that matters: it fails if the provider is
  // signing with anything other than the key it just published.
  step("verify the ID token");
  check("the JWS header names RS256", headerJson.alg === "RS256", headerJson.alg ?? "");
  check("the JWS header names a key identifier", Boolean(headerJson.kid), headerJson.kid ?? "");
  const jwk = keys.find((key) => key.kid === headerJson.kid);
  check("that key is in the published JWKS", Boolean(jwk), headerJson.kid ?? "");

  if (jwk) {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const verified = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"));
    check("the RS256 signature verifies against the served JWKS", verified);
  }

  check("the issuer claim is the advertised issuer", claims.iss === discovery.issuer, claims.iss ?? "");
  check("the audience is the client that asked", claims.aud === CLIENT, claims.aud ?? "");
  check("the nonce is the one this run sent", claims.nonce === nonce);
  check(
    "the token has not already expired",
    typeof claims.exp === "number" && claims.exp * 1000 > Date.now(),
    claims.exp ? new Date(claims.exp * 1000).toISOString() : "",
  );
  check("it names a subject", typeof claims.sub === "string" && claims.sub.length > 0);

  // ── 6. The session policy. A provider whose purpose is enforced MFA should say
  // so in the token; without it a relying party cannot decide anything from the
  // assertion beyond who the subject is.
  step("second factor");
  const amr = claims.amr ?? [];
  check("the token records how the subject authenticated", amr.length > 0, amr.join("+"));

  fail();
}

function fail(): void {
  console.log("");
  if (failures > 0) {
    console.error(`smoke: ${failures} check(s) failed against ${BASE}`);
    process.exit(1);
  }
  console.log(`smoke: full authorization-code round trip verified against ${BASE}`);
}

main().catch((error) => {
  console.error(`smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
