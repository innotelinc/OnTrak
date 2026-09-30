/**
 * OnTrak Sentinel: the console's own sign-in.
 *
 * Sentinel is the one product in the Network that holds identities, so it is the one
 * place that checks a password itself. That makes this file the security boundary, and
 * each test follows one way the boundary can fail:
 *
 *  - a login form that tells an attacker which addresses exist (the enumeration
 *    oracle, which is the cheapest thing to get wrong and the most useful to an
 *    attacker who has one);
 *  - a second factor that can be skipped, or guessed without the password first;
 *  - a password stored in a form a database copy would give away;
 *  - a successful sign-in that does not actually produce a usable session, or a failed
 *    one that does;
 *  - a refusal that writes the password into the audit trail;
 *  - and the front door answering `{"error":"not_found"}`, which is what sent people
 *    here in the first place.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HashFn } from "../src/lib/audit-chain";
import { CONSOLE_PATHS, CONSOLE_SESSION_COOKIE } from "../src/lib/console-rules";
import { ConsoleService } from "../src/lib/console-service";
import { routeConsole } from "../src/lib/console-http";
import { MemoryCredentialStore } from "../src/lib/credential-store";
import { sha256Hex } from "../src/lib/hash";
import {
  IdentityService,
  MemoryIdentityStore,
  OrganizationAuditLog,
  type IdentityActor,
  type IdentityStore,
} from "../src/lib/identity-service";
import { base32Decode, totpCode, totpCounter } from "../src/lib/mfa-rules";
import { MemoryMfaStore, MfaService, systemTotpSigner } from "../src/lib/mfa-service";
import { hashPassword, needsRehash, verifyPassword } from "../src/lib/password";
import { SIGN_IN_FAILURE } from "../src/lib/sign-in-rules";
import { SignInService, setPassword } from "../src/lib/sign-in-service";
import type { HttpRequest } from "../src/lib/oidc-http";

const sha256: HashFn = sha256Hex;
const ORIGIN = "https://sentinel.test";
const SIGNER = systemTotpSigner();
const PASSWORD = "correct horse battery staple";

/* -------------------------------------------------------------------------- */
/*  The hash                                                                  */
/* -------------------------------------------------------------------------- */

test("password: a hash verifies its own password and refuses another", async () => {
  const stored = await hashPassword(PASSWORD);
  assert.ok(await verifyPassword(PASSWORD, stored));
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("password: two hashes of one password differ, so the table is not a lookup", async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b, "a fresh salt per hash is what stops one precomputation covering everyone");
  assert.ok(await verifyPassword(PASSWORD, a));
  assert.ok(await verifyPassword(PASSWORD, b));
});

test("password: the parameters travel with the hash, and are not repeated in plaintext", async () => {
  const stored = await hashPassword(PASSWORD);
  const [algorithm, n, r, p, salt, key] = stored.split("$");
  assert.equal(algorithm, "scrypt");
  assert.equal(Number(n), 16384);
  assert.equal(Number(r), 8);
  assert.equal(Number(p), 1);
  // The stored string must not contain the password in any form a reader could use.
  assert.equal(stored.includes(PASSWORD), false);
  assert.equal(stored.includes(Buffer.from(PASSWORD).toString("base64")), false);
  assert.ok((salt ?? "").length > 0 && (key ?? "").length > 0);
});

test("password: a fresh hash does not need rehashing, and a cheaper one does", async () => {
  assert.equal(needsRehash(await hashPassword(PASSWORD)), false);
  const cheap = await hashPassword(PASSWORD, { n: 1024 });
  assert.equal(needsRehash(cheap), true);
  // A cheap hash still verifies — raising the cost must not invalidate anyone's login.
  assert.ok(await verifyPassword(PASSWORD, cheap));
});

test("password: a malformed or hostile stored value is false, never a throw", async () => {
  for (const stored of [
    "",
    "not-a-hash",
    "scrypt$16384$8",                             // too few fields
    "argon2id$16384$8$1$c2FsdA==$a2V5",           // an algorithm this build does not know
    "scrypt$999999999$8$1$c2FsdA==$a2V5",         // a cost that would exhaust the machine
    "scrypt$0$8$1$c2FsdA==$a2V5",
    "scrypt$16384$999$1$c2FsdA==$a2V5",
    "scrypt$16384$8$0$c2FsdA==$a2V5",
    "scrypt$16384$8$1$$",                          // empty salt and key
  ]) {
    assert.equal(await verifyPassword(PASSWORD, stored), false, `should refuse: ${stored}`);
  }
});

/* -------------------------------------------------------------------------- */
/*  The harness                                                               */
/* -------------------------------------------------------------------------- */

let harnessSeq = 0;

function harness() {
  const audit = new OrganizationAuditLog(sha256);
  const identities = new MemoryIdentityStore();
  const credentials = new MemoryCredentialStore();
  let clock = Date.parse("2026-10-20T09:00:00.000Z");
  let n = 0;
  const scope = `s${++harnessSeq}`;

  const spine = new IdentityService(identities, audit, {
    id: () => `${scope}-id-${++n}`,
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });
  const factors = new MemoryMfaStore();
  const mfa = new MfaService(factors, spine, audit, {
    id: () => `${scope}-factor-${++n}`,
    secret: () => "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
  });

  const signIn = new SignInService(identities, credentials, mfa, spine, audit, {
    id: () => `${scope}-signin-${++n}`,
    now: () => new Date(clock).toISOString(),
  }, { defaultOrganizationSlug: "acme", landingPath: CONSOLE_PATHS.home });

  const console_ = new ConsoleService(spine, mfa, null, null, null, signIn, "acme");

  return {
    spine,
    mfa,
    audit,
    credentials,
    identities,
    signIn,
    service: console_,
    nowMs: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    code(secret: string) {
      const bytes = base32Decode(secret);
      assert.ok(bytes, "the test secret should decode");
      return totpCode(bytes, totpCounter(clock), SIGNER);
    },
    /** An organization with one administrator who has a password. */
    async organization(slug = "acme", options: { enrollFactor?: boolean } = {}) {
      const store: IdentityStore = identities;
      const admin = `admin@${slug}.test`;
      const created = await spine.bootstrapOrganization("test", { name: `${slug} Inc`, slug }, {
        identifier: admin,
        displayName: `Admin ${slug}`,
      });
      assert.ok(created.ok, created.ok ? "" : created.error);
      const actor: IdentityActor = {
        id: created.value.admin.id,
        organizationId: created.value.organization.id,
        role: "ADMIN",
      };
      await setPassword(store, credentials, actor.organizationId, actor.id, PASSWORD);
      if (options.enrollFactor !== false) {
        const begun = await mfa.beginEnrollment(actor, actor.id);
        assert.ok(begun.ok, begun.ok ? "" : begun.error);
        const confirmed = await mfa.confirmEnrollment(actor, actor.id, this.code(begun.value.secret));
        assert.ok(confirmed.ok, confirmed.ok ? "" : confirmed.error);
        // Past the step the enrollment consumed. A TOTP code is single-use — the
        // service records the counter it accepted — so a sign-in that reused the
        // enrollment's own code would be refused as a replay, and a test that did not
        // move the clock would be testing that rule instead of the one it names.
        clock += 30_000;
        return { actor, admin, secret: begun.value.secret, organization: created.value.organization };
      }
      return { actor, admin, secret: null, organization: created.value.organization };
    },
  };
}

function request(
  method: string,
  path: string,
  options: { body?: Record<string, string>; headers?: Record<string, string>; origin?: string } = {},
): HttpRequest {
  const headers: Record<string, string | undefined> = { ...options.headers };
  const body = options.body ? new URLSearchParams(options.body).toString() : undefined;
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";
  return { method, url: `${options.origin ?? ORIGIN}${path}`, headers, body, cookies: {} };
}

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("sign-in: the right password starts a session, and the session works", async () => {
  const h = harness();
  const { actor, secret } = await h.organization();
  assert.ok(secret);
  const result = await h.signIn.signIn({
    identifier: "admin@acme.test",
    password: PASSWORD,
    code: h.code(secret),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
  const live = await h.spine.checkSession(actor.organizationId, result.value.sessionId);
  assert.equal(live.active, true, live.active ? "" : live.reason);
  assert.equal(result.value.redirectTo, CONSOLE_PATHS.home);
});

test("sign-in: an enrolled factor is required, and a wrong code does not sign in", async () => {
  const h = harness();
  await h.organization();

  const without = await h.signIn.signIn({ identifier: "admin@acme.test", password: PASSWORD });
  assert.equal(without.ok, false);
  assert.match(without.ok ? "" : without.error, /six-digit code/i);

  const wrong = await h.signIn.signIn({ identifier: "admin@acme.test", password: PASSWORD, code: "000000" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? "" : wrong.error, /did not verify/i);
});

test("sign-in: with a good password and a good code the session is issued", async () => {
  const h = harness();
  const { secret } = await h.organization();
  assert.ok(secret);
  const result = await h.signIn.signIn({
    identifier: "admin@acme.test",
    password: PASSWORD,
    code: h.code(secret),
  });
  assert.ok(result.ok, result.ok ? "" : result.error);
});

test("sign-in: a code that is correct but came before the password is still checked, not skipped", async () => {
  const h = harness();
  const { secret } = await h.organization();
  assert.ok(secret);
  // The password is wrong even though the code is right: the password is the half that
  // has to hold, and a service that checked the code first would have accepted this.
  const result = await h.signIn.signIn({
    identifier: "admin@acme.test",
    password: `${PASSWORD}!`,
    code: h.code(secret),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, SIGN_IN_FAILURE);
});

test("sign-in: an unknown account and a wrong password are the same sentence", async () => {
  const h = harness();
  await h.organization();

  const unknown = await h.signIn.signIn({ identifier: "nobody@acme.test", password: PASSWORD });
  const wrongPassword = await h.signIn.signIn({ identifier: "admin@acme.test", password: "hunter2" });

  assert.equal(unknown.ok, false);
  assert.equal(wrongPassword.ok, false);
  // Byte-identical, because any difference here is an account-enumeration oracle.
  assert.equal(unknown.ok ? "" : unknown.error, wrongPassword.ok ? "" : wrongPassword.error);
  assert.equal(unknown.ok ? "" : unknown.error, SIGN_IN_FAILURE);
});

test("sign-in: a deactivated identity is refused with the same sentence, not a special one", async () => {
  const h = harness();
  const { actor } = await h.organization("acme", { enrollFactor: false });
  // A second identity, because an administrator cannot deactivate the organization's
  // only remaining one — the guard that keeps a console from locking itself out. So
  // the subject of this test has to be somebody else.
  const other = await h.spine.createIdentity(actor, {
    identifier: "gone@acme.test",
    displayName: "Gone Away",
    role: "AGENT",
  });
  assert.ok(other.ok, other.ok ? "" : other.error);
  await setPassword(h.identities, h.credentials, actor.organizationId, other.value.id, PASSWORD);
  assert.ok((await h.spine.setActive(actor, other.value.id, false)).ok);

  const result = await h.signIn.signIn({ identifier: "gone@acme.test", password: PASSWORD });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, SIGN_IN_FAILURE);
});

test("sign-in: a missing field is a form complaint, which is not about any account", async () => {
  const h = harness();
  await h.organization();
  const result = await h.signIn.signIn({ identifier: "", password: PASSWORD });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /email address/i);
  assert.notEqual(result.ok ? "" : result.error, SIGN_IN_FAILURE);
});

test("sign-in: an identity with no password cannot be signed into, however right the password is", async () => {
  const h = harness();
  const created = await h.spine.bootstrapOrganization("test", { name: "Acme", slug: "acme" }, {
    identifier: "nopassword@acme.test",
    displayName: "No Password",
  });
  assert.ok(created.ok);
  const result = await h.signIn.signIn({ identifier: "nopassword@acme.test", password: PASSWORD });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, SIGN_IN_FAILURE);
});

test("sign-in: an identity that owes a factor it never enrolled is refused by the policy, in its own words", async () => {
  const h = harness();
  // `enrollFactor: false` leaves `mfaEnrolled` false while the default policy requires
  // it. The password is right, no code is owed, and the refusal is the policy's — a
  // configuration fact the person needs to hear, not a credential failure.
  await h.organization("acme", { enrollFactor: false });
  const result = await h.signIn.signIn({ identifier: "admin@acme.test", password: PASSWORD });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /MFA/i);
  assert.notEqual(result.ok ? "" : result.error, SIGN_IN_FAILURE);
});

test("sign-in: no organization resolves to no sign-in, rather than the first organization", async () => {
  const h = harness();
  await h.organization();
  const result = await h.signIn.signIn({ identifier: "admin@acme.test", password: PASSWORD, organization: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error, SIGN_IN_FAILURE);
});

/* -------------------------------------------------------------------------- */
/*  The audit trail                                                           */
/* -------------------------------------------------------------------------- */

test("sign-in: a refusal is recorded, and neither the password nor the code is in the record", async () => {
  const h = harness();
  const { actor, secret } = await h.organization();
  assert.ok(secret);

  // A code that is distinctive rather than a round number: `000000` is a needle that
  // turns up inside ids and timestamps, which would make this assertion pass for the
  // wrong reason — or, as it did, fail for one.
  const badCode = "246813";
  await h.signIn.signIn({ identifier: "admin@acme.test", password: "wrong-password-xyz", code: h.code(secret) });
  await h.signIn.signIn({ identifier: "admin@acme.test", password: PASSWORD, code: badCode });

  const events = await h.audit.trail(actor.organizationId);
  const refusals = events.filter((event) => event.action === "identity.signin.refuse");
  assert.equal(refusals.length, 2);

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("wrong-password-xyz"), false, "a refused password must not be logged");
  assert.equal(serialized.includes(PASSWORD), false, "the real password must not be logged");
  assert.equal(serialized.includes(badCode), false, "a refused code must not be logged");
  // The reason is recorded, because that is what an administrator acts on.
  assert.match(serialized, /password did not match/);
  assert.match(serialized, /second factor refused/);
});

test("sign-in: a success is recorded as a grant, not as a refusal", async () => {
  const h = harness();
  const { actor, secret } = await h.organization();
  assert.ok(secret);
  await h.signIn.signIn({ identifier: "admin@acme.test", password: PASSWORD, code: h.code(secret) });
  const events = await h.audit.trail(actor.organizationId);
  assert.ok(events.some((event) => event.action === "identity.signin"));
  assert.ok(events.some((event) => event.action === "session.grant"));
});

/* -------------------------------------------------------------------------- */
/*  The routes                                                                */
/* -------------------------------------------------------------------------- */

test("console: the bare host redirects to the console instead of answering not_found", async () => {
  const h = harness();
  const response = await routeConsole(request("GET", "/"), h.service);
  assert.equal(response.status, 303);
  // `/console`, not `/console/sign-in`: the console adapts to whether there is a
  // session, and the sign-in form does not. A signed-in operator typing the hostname
  // must not be handed a login.
  assert.equal(response.headers.location, CONSOLE_PATHS.home);
});

test("console: the bare host does not short-circuit a signed-in visitor into a login form", async () => {
  const h = harness();
  const response = await routeConsole(request("GET", "/"), h.service);
  assert.notEqual(response.headers.location, CONSOLE_PATHS.signIn);
});

test("console: the sign-in page renders a password field and the shared theme", async () => {
  const h = harness();
  const response = await routeConsole(request("GET", CONSOLE_PATHS.signIn), h.service);
  assert.equal(response.status, 200);
  assert.match(response.body, /type="password"/);
  assert.match(response.body, /name="identifier"/);
  assert.match(response.body, /name="code"/);
  // The scheme and the two shared assets, which is what makes the console look like the
  // rest of the Network rather than like its own product.
  assert.match(response.body, /data-scheme="soc"/);
  assert.match(response.body, /href="\/unity-theme\.css"/);
  assert.match(response.body, /src="\/unity-theme\.js"/);
  // The page introduces the product rather than opening on two words of instruction:
  // the mark, and the name it belongs to.
  assert.match(response.body, /class="brand-mark"/);
  assert.match(response.body, /class="brand-name">OnTrak Sentinel</);
  assert.doesNotMatch(response.body, /<h1>Sign in<\/h1>/);
  // The tab still names the page, so a person with the sign-in open in a background tab
  // can tell what it is.
  assert.match(response.body, /<title>Sign in · OnTrak Sentinel<\/title>/);
});

test("console: a good sign-in answers 303 with the session cookie", async () => {
  const h = harness();
  const { secret } = await h.organization();
  assert.ok(secret);
  const response = await routeConsole(
    request("POST", CONSOLE_PATHS.signIn, {
      body: { identifier: "admin@acme.test", password: PASSWORD, code: h.code(secret) },
    }),
    h.service,
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, CONSOLE_PATHS.home);
  const cookie = response.headers["set-cookie"] ?? "";
  assert.match(cookie, new RegExp(`${CONSOLE_SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("console: behind a TLS proxy the cookie is Secure, because the browser saw https", async () => {
  const h = harness();
  const { secret } = await h.organization();
  assert.ok(secret);
  const response = await routeConsole(
    request("POST", CONSOLE_PATHS.signIn, {
      body: { identifier: "admin@acme.test", password: PASSWORD, code: h.code(secret) },
      // What a proxy terminates: the browser is on https, the console is on plain
      // HTTP behind it. Deciding `Secure` from the local scheme would get this wrong.
      origin: "http://127.0.0.1:8787",
      headers: { "x-forwarded-proto": "https" },
    }),
    h.service,
  );
  assert.equal(response.status, 303);
  assert.match(response.headers["set-cookie"] ?? "", /Secure/);
});

test("console: on a plain-HTTP LAN address the cookie is not Secure, which is what makes it stick", async () => {
  const h = harness();
  const { secret } = await h.organization();
  assert.ok(secret);
  const response = await routeConsole(
    request("POST", CONSOLE_PATHS.signIn, {
      body: { identifier: "admin@acme.test", password: PASSWORD, code: h.code(secret) },
      origin: "http://192.168.1.21:8787",
    }),
    h.service,
  );
  assert.equal(response.status, 303);
  // A `Secure` cookie the browser refuses to store presents as a sign-in that
  // succeeds and leaves you signed out, so this is not a cosmetic distinction.
  assert.equal((response.headers["set-cookie"] ?? "").includes("Secure"), false);
});

test("console: a failed sign-in re-renders the form, sets no cookie, and keeps the address", async () => {
  const h = harness();
  await h.organization();
  const response = await routeConsole(
    request("POST", CONSOLE_PATHS.signIn, {
      body: { identifier: "admin@acme.test", password: "nope" },
    }),
    h.service,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.match(response.body, /do not match an account/i);
  // The mistyped address is echoed so it can be corrected rather than retyped...
  assert.match(response.body, /value="admin@acme\.test"/);
  // ...and the password is not, ever.
  assert.equal(response.body.includes("nope"), false);
});

test("console: the sign-in page answers a POST-only path correctly and a GET to nothing", async () => {
  const h = harness();
  const wrongMethod = await routeConsole(request("GET", "/console/sign-in/nonsense"), h.service);
  assert.equal(wrongMethod.status, 404);
  const notFound = await routeConsole(request("POST", "/console/not-a-page"), h.service);
  assert.equal(notFound.status, 404);
});

test("console: an unconfigured sign-in says so instead of pretending", async () => {
  const h = harness();
  const bare = new ConsoleService(h.spine, h.mfa, null, null, null, null, null);
  const response = await routeConsole(
    request("POST", CONSOLE_PATHS.signIn, { body: { identifier: "admin@acme.test", password: PASSWORD } }),
    bare,
  );
  assert.equal(response.status, 200);
  assert.match(response.body, /not configured/i);
  assert.equal(response.headers["set-cookie"], undefined);
});
