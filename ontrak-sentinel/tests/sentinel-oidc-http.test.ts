/**
 * OnTrak Sentinel S1 tests: the OIDC HTTP surface.
 *
 * `sentinel-oidc.test.ts` covers the decisions; these cover the wire. Each test
 * asks one of the questions an integrator actually hits: is discovery honest, is
 * the public key published, does an error go to the address the client
 * registered, does a code survive exactly one exchange, and does a token open the
 * userinfo endpoint and nothing else. The last test drives the same surface
 * through a real `node:http` socket, because a router that only works when a test
 * calls it directly is not an HTTP surface.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/lib/hash";
import type { HashFn } from "../src/lib/audit-chain";
import { IdentityService, MemoryIdentityStore, OrganizationAuditLog, type IdentityActor } from "../src/lib/identity-service";
import { generateSigningKey, oneKey, verifyJwt, type SigningKey } from "../src/lib/oidc-keys";
import { codeChallengeFor } from "../src/lib/oidc-rules";
import { MemoryOidcStore, OidcService, type OidcIds } from "../src/lib/oidc-service";
import { SESSION_COOKIE, SESSION_HEADER, routeOidc, type HttpRequest, type HttpResponse } from "../src/lib/oidc-http";
import { startOidcServer } from "../src/lib/oidc-server";

const sha256: HashFn = sha256Hex;
const ISSUER = "https://identity.acme.test";
const KEYS: SigningKey = generateSigningKey();
const VERIFIER = "3lR6kQz1vB9wS2pJ8nH4tY7cM0xG5dF1aK9eU2rT6bN8sW";

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  let clock = Date.parse("2026-09-28T09:00:00.000Z");
  let n = 0;
  const scope = `h${++harnessSeq}`;
  const ids = { id: () => `${scope}-id-${++n}`, now: () => new Date(clock).toISOString(), nowMs: () => clock };
  const spine = new IdentityService(identities, audit, ids);

  const oidcIds: OidcIds = {
    id: () => `${scope}-ev-${++n}`,
    clientId: () => `${scope}-client-${++n}`,
    code: () => `${scope}-code-${++n}`,
    token: () => `${scope}-token-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  };
  const oidc = new OidcService(new MemoryOidcStore(), identities, spine, { issuer: ISSUER, keys: oneKey(KEYS) }, audit, oidcIds, sha256);

  return { spine, oidc, identities, audit, advance: (seconds: number) => { clock += seconds * 1000; } };
}

/** A bootstrapped organization with a signed-in admin and one registered client. */
async function signedIn() {
  const h = harness();
  const created = await h.spine.bootstrapOrganization(
    "founder-1",
    { name: "Acme MSP", slug: `acme-${harnessSeq}-${Date.now()}` },
    { identifier: "admin@acme.test", displayName: "Ada Admin" },
  );
  assert.equal(created.ok, true, created.ok ? "" : created.error);
  if (!created.ok) throw new Error("unreachable");
  const actor: IdentityActor = { id: created.value.admin.id, organizationId: created.value.organization.id, role: "ADMIN" };

  await h.spine.setMfaEnrolled(actor, actor.id, true);
  const session = await h.spine.issueSession(actor.organizationId, actor.id);
  assert.equal(session.ok, true);
  if (!session.ok) throw new Error("unreachable");

  const client = await h.oidc.registerClient(actor, {
    name: "OnTrak Tix",
    redirectUris: ["https://tix.acme.test/api/sso/callback"],
    scopes: ["openid", "profile", "email", "roles"],
  });
  assert.equal(client.ok, true, client.ok ? "" : client.error);
  if (!client.ok) throw new Error("unreachable");

  return { ...h, actor, session: session.value, client: client.value, redirectUri: "https://tix.acme.test/api/sso/callback" };
}

type Signed = Awaited<ReturnType<typeof signedIn>>;

function authorizeUrl(s: Signed, overrides: Record<string, string> = {}, base = ISSUER): string {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: s.client.clientId,
    redirect_uri: s.redirectUri,
    scope: "openid profile email roles",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge: codeChallengeFor(VERIFIER, sha256),
    code_challenge_method: "S256",
    ...overrides,
  };
  return `${base}/oauth2/authorize?${new URLSearchParams(params)}`;
}

function get(url: string, options: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}): HttpRequest {
  return { method: "GET", url, headers: options.headers ?? {}, cookies: options.cookies };
}

function formPost(url: string, form: Record<string, string>): HttpRequest {
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  };
}

function locationOf(response: HttpResponse): URL {
  return new URL(String(response.headers.location ?? ""));
}

function tokenForm(s: Signed, code: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: "authorization_code",
    client_id: s.client.clientId,
    code,
    redirect_uri: s.redirectUri,
    code_verifier: VERIFIER,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Discovery and keys                                                        */
/* -------------------------------------------------------------------------- */

test("discovery advertises the endpoints a client needs, and only GET reaches it", async () => {
  const s = await signedIn();
  const response = await routeOidc(get(`${ISSUER}/.well-known/openid-configuration`), s.oidc);

  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-type"]), /application\/json/);
  const doc = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(doc.issuer, ISSUER);
  assert.equal(doc.authorization_endpoint, `${ISSUER}/oauth2/authorize`);
  assert.equal(doc.jwks_uri, `${ISSUER}/.well-known/jwks.json`);

  const wrongMethod = await routeOidc({ ...get(`${ISSUER}/.well-known/openid-configuration`), method: "POST" }, s.oidc);
  assert.equal(wrongMethod.status, 405);
  assert.match(String(wrongMethod.headers.allow ?? ""), /GET/);
});

test("the JWKS publishes the public half of the signing key, and is cacheable", async () => {
  const s = await signedIn();
  const response = await routeOidc(get(`${ISSUER}/.well-known/jwks.json`), s.oidc);

  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as { keys: Record<string, unknown>[] };
  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0].kty, "RSA");
  assert.equal(body.keys[0].alg, "RS256");
  assert.equal(body.keys[0].use, "sig");
  // The public part only: a private key would carry a `d`.
  assert.equal(body.keys[0].d, undefined);
  assert.match(String(response.headers["cache-control"] ?? ""), /max-age/);
});

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

test("a good authorization request is answered with a redirect carrying the code and state", async () => {
  const s = await signedIn();
  const response = await routeOidc(get(authorizeUrl(s), { cookies: { [SESSION_COOKIE]: s.session.id } }), s.oidc);

  assert.equal(response.status, 302);
  const location = locationOf(response);
  assert.equal(`${location.origin}${location.pathname}`, s.redirectUri);
  assert.ok(location.searchParams.get("code"));
  assert.equal(location.searchParams.get("state"), "state-1");
});

test("the session may also arrive as a header, for a server that calls us directly", async () => {
  const s = await signedIn();
  const response = await routeOidc(get(authorizeUrl(s), { headers: { [SESSION_HEADER]: s.session.id } }), s.oidc);
  assert.equal(response.status, 302);
  assert.ok(locationOf(response).searchParams.get("code"));
});

test("an error is only ever redirected to a redirect URI we registered", async () => {
  const s = await signedIn();
  const response = await routeOidc(
    get(authorizeUrl(s, { redirect_uri: "https://evil.test/callback" }), { cookies: { [SESSION_COOKIE]: s.session.id } }),
    s.oidc,
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.location, undefined, "an unrecognised URI must not receive a redirect");
  assert.match(response.body, /not one this client registered/);
});

test("a missing session is reported as login_required to the client that asked", async () => {
  const s = await signedIn();
  const response = await routeOidc(get(authorizeUrl(s)), s.oidc);

  assert.equal(response.status, 302);
  const location = locationOf(response);
  assert.equal(`${location.origin}${location.pathname}`, s.redirectUri);
  assert.equal(location.searchParams.get("error"), "login_required");
  assert.equal(location.searchParams.get("state"), "state-1");
  assert.equal(location.searchParams.get("code"), null);
});

test("a request without PKCE is refused, with a description a reader can act on", async () => {
  const s = await signedIn();
  const response = await routeOidc(
    get(authorizeUrl(s, { code_challenge: "", code_challenge_method: "" }), { cookies: { [SESSION_COOKIE]: s.session.id } }),
    s.oidc,
  );

  assert.equal(response.status, 302);
  assert.equal(locationOf(response).searchParams.get("error"), "invalid_request");
  assert.match(locationOf(response).searchParams.get("error_description") ?? "", /PKCE/);
});

/* -------------------------------------------------------------------------- */
/*  The token endpoint                                                        */
/* -------------------------------------------------------------------------- */

async function authorized(s: Signed): Promise<string> {
  const response = await routeOidc(get(authorizeUrl(s), { cookies: { [SESSION_COOKIE]: s.session.id } }), s.oidc);
  const code = locationOf(response).searchParams.get("code");
  assert.ok(code);
  return code as string;
}

test("a code exchanges for a bearer token and an ID token signed for the client", async () => {
  const s = await signedIn();
  const code = await authorized(s);
  const response = await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code)), s.oidc);

  assert.equal(response.status, 200);
  assert.match(String(response.headers["cache-control"] ?? ""), /no-store/);
  const body = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 3600);
  assert.equal(body.scope, "openid profile email roles");

  const verified = verifyJwt(String(body.id_token), KEYS, { issuer: ISSUER, audience: s.client.clientId });
  assert.equal(verified.ok, true, verified.ok ? "" : verified.reason);
  if (verified.ok) {
    assert.equal(verified.claims.sub, s.actor.id);
    assert.equal(verified.claims.email, "admin@acme.test");
  }
});

test("a code is worth exactly one exchange", async () => {
  const s = await signedIn();
  const code = await authorized(s);
  assert.equal((await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code)), s.oidc)).status, 200);

  const replay = await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code)), s.oidc);
  assert.equal(replay.status, 400);
  assert.equal((JSON.parse(replay.body) as { error: string }).error, "invalid_grant");
});

test("a wrong verifier leaves the code spent, rather than offering a second guess", async () => {
  const s = await signedIn();
  const code = await authorized(s);
  const wrong = `${VERIFIER.slice(0, -1)}X`;

  const refused = await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code, { code_verifier: wrong })), s.oidc);
  assert.equal(refused.status, 400);
  assert.equal((JSON.parse(refused.body) as { error: string }).error, "invalid_grant");

  // The code is gone even though the exchange failed: that is the whole point of
  // spending it first.
  const second = await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code)), s.oidc);
  assert.equal(second.status, 400);
});

test("a code expires after a minute", async () => {
  const s = await signedIn();
  const code = await authorized(s);
  s.advance(61);
  const expired = await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code)), s.oidc);
  assert.equal(expired.status, 400);
  assert.match((JSON.parse(expired.body) as { error_description: string }).error_description, /expired/);
});

test("the token endpoint insists on POST and on a form body", async () => {
  const s = await signedIn();
  assert.equal((await routeOidc(get(`${ISSUER}/oauth2/token`), s.oidc)).status, 405);

  const wrongType = await routeOidc(
    { method: "POST", url: `${ISSUER}/oauth2/token`, headers: { "content-type": "application/json" }, body: "{}" },
    s.oidc,
  );
  assert.equal(wrongType.status, 400);
  assert.equal((JSON.parse(wrongType.body) as { error: string }).error, "invalid_request");
});

test("an unknown client is refused as a client error, not a grant error", async () => {
  const s = await signedIn();
  const response = await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, "any-code", { client_id: "nope" })), s.oidc);
  assert.equal(response.status, 401);
  assert.equal((JSON.parse(response.body) as { error: string }).error, "invalid_client");
});

/* -------------------------------------------------------------------------- */
/*  Userinfo                                                                  */
/* -------------------------------------------------------------------------- */

test("userinfo answers with the subject the ID token named, and nothing without a token", async () => {
  const s = await signedIn();
  const code = await authorized(s);
  const tokens = JSON.parse((await routeOidc(formPost(`${ISSUER}/oauth2/token`, tokenForm(s, code)), s.oidc)).body) as {
    access_token: string;
  };

  const ok = await routeOidc(get(`${ISSUER}/oauth2/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } }), s.oidc);
  assert.equal(ok.status, 200);
  const claims = JSON.parse(ok.body) as Record<string, unknown>;
  assert.equal(claims.sub, s.actor.id, "the subject must be the same value the ID token carried");
  assert.equal(claims.email, "admin@acme.test");

  const missing = await routeOidc(get(`${ISSUER}/oauth2/userinfo`), s.oidc);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers["www-authenticate"], "Bearer");

  const bogus = await routeOidc(get(`${ISSUER}/oauth2/userinfo`, { headers: { authorization: "Bearer not-a-token" } }), s.oidc);
  assert.equal(bogus.status, 401);
  assert.equal((JSON.parse(bogus.body) as { error: string }).error, "invalid_token");
});

test("an unknown path is a 404, not a redirect", async () => {
  const s = await signedIn();
  const response = await routeOidc(get(`${ISSUER}/admin/shutdown`), s.oidc);
  assert.equal(response.status, 404);
  assert.equal(response.headers.location, undefined);
});

/* -------------------------------------------------------------------------- */
/*  The socket                                                                */
/* -------------------------------------------------------------------------- */

test("the node adapter serves the same surface over a real socket", async () => {
  const s = await signedIn();
  const { server, url } = await startOidcServer(s.oidc, { port: 0 });
  try {
    const discovery = await fetch(`${url}/.well-known/openid-configuration`);
    assert.equal(discovery.status, 200);
    assert.equal(((await discovery.json()) as { issuer: string }).issuer, ISSUER);

    // A client whose callback is *this* server, so following the redirect is safe
    // and the final URL is exactly where the code was delivered. Registered after
    // the server started, which is fine: the provider reads the store per request.
    const callback = `${url}/callback`;
    const local = await s.oidc.registerClient(s.actor, {
      name: "Socket client",
      redirectUris: [callback],
      scopes: ["openid", "profile", "email", "roles"],
    });
    assert.equal(local.ok, true, local.ok ? "" : local.error);
    if (!local.ok) throw new Error("unreachable");

    const authorize = await fetch(authorizeUrl(s, { client_id: local.value.clientId, redirect_uri: callback }, url), {
      headers: { [SESSION_HEADER]: s.session.id },
    });
    assert.equal(authorize.status, 404, "following the redirect lands on a path we do not route");
    const code = new URL(authorize.url).searchParams.get("code");
    assert.ok(code, "the redirect should have carried a code");

    const token = await fetch(`${url}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams(
        tokenForm(s, code as string, { client_id: local.value.clientId, redirect_uri: callback }),
      ),
    });
    assert.equal(token.status, 200);
    const tokens = (await token.json()) as { access_token: string };

    const userinfo = await fetch(`${url}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(userinfo.status, 200);
    assert.equal(((await userinfo.json()) as { sub: string }).sub, s.actor.id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the health path answers without a credential, for the family's status light", async () => {
  const s = await signedIn();
  const { server, url } = await startOidcServer(s.oidc, { port: 0 });
  try {
    // No session, no bearer: the portal's probe holds neither.
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok", service: "ontrak-sentinel" });

    // The probe may use HEAD; a `HEAD /health` is the same answer with no body.
    const head = await fetch(`${url}/health`, { method: "HEAD" });
    assert.equal(head.status, 200);

    // A path that merely starts with the health path is not it.
    const notIt = await fetch(`${url}/health/extra`);
    assert.equal(notIt.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
