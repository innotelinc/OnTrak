/**
 * LTI 1.3: launching this product from somebody else's LMS.
 *
 * A launch is the one request in this product that arrives from a system the
 * deployment does not own, carrying an assertion it did not ask for, on behalf of
 * a person it has never seen. So the tests here are mostly refusals: a launch from
 * another platform, for another client, with the wrong nonce, in a deployment that
 * is not registered, of a message type this product does not offer. Each one is a
 * sentence a person can act on, and each one is cheaper to catch here than in a
 * support ticket about an LMS that "does not work with OnTrak".
 *
 * Everything runs against the rules module and the memory client — no HTTP, no
 * database, no LMS.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lti.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LTI_AGS_SCORE_SCOPE,
  LTI_CLAIM,
  LTI_LAUNCH_PATH,
  LTI_MESSAGE_TYPES,
  LTI_VERSION,
  agsScore,
  agsScoreUrl,
  agsTokenAssertion,
  agsTokenForm,
  buildLtiLoginUrl,
  extractLaunchClaims,
  launchFactsExpired,
  ltiConfigFromEnv,
  ltiConfigWarning,
  ltiLaunchFacts,
  ltiRedirectUri,
  ltiRoleOf,
  ltiStateExpired,
  mayWriteScore,
  passbackRefusal,
  readLtiLogin,
  roleReason,
  type ExpectedLaunch,
  type LtiConfig,
} from "../src/lib/lti-rules";
import { MemoryLtiClient } from "../src/lib/lti-client";
import { launchAuthorization, ltiExternalId, ltiLaunchAudit } from "../src/lib/lti-service";

const ISSUER = "https://lms.example.edu";
const CLIENT_ID = "ontrak-training";

const CONFIG: LtiConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  deploymentIds: ["7"],
  authorizationEndpoint: `${ISSUER}/mod/lti/auth.php`,
  jwksUri: `${ISSUER}/mod/lti/certs.php`,
  tokenEndpoint: `${ISSUER}/mod/lti/token.php`,
  // A stand-in for a PEM: nothing here imports it, and a literal key marker in a
  // tracked file is exactly what the repository's secret scan refuses.
  privateKey: "escaped-pem-placeholder",
  keyId: "kid-1",
  defaultRole: "STUDENT",
};

const EXPECTED: ExpectedLaunch = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  nonce: "nonce-1",
  deploymentIds: ["7"],
  defaultRole: "STUDENT",
};

/** A launch assertion as the platform would send it. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "learner-1",
    nonce: "nonce-1",
    email: "Ada@Acme.Test",
    name: "Ada Lovelace",
    [LTI_CLAIM.version]: LTI_VERSION,
    [LTI_CLAIM.deploymentId]: "7",
    [LTI_CLAIM.messageType]: LTI_MESSAGE_TYPES.resourceLink,
    [LTI_CLAIM.targetLinkUri]: "https://training.example/api/lti/launch",
    [LTI_CLAIM.resourceLink]: { id: "rl-1", title: "Fix a broken NIC" },
    [LTI_CLAIM.context]: { id: "course-42", title: "Autumn intake", label: "CS101" },
    [LTI_CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    [LTI_CLAIM.agsEndpoint]: {
      scope: ["https://purl.imsglobal.org/spec/lti-ags/scope/lineitem", LTI_AGS_SCORE_SCOPE],
      lineitem: "https://lms.example.edu/lineitems/9",
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

test("lti: an unconfigured deployment has no platform at all, and that is not an error", () => {
  const result = ltiConfigFromEnv({});
  assert.equal(result.enabled, false);
  assert.equal(result.config, null);
  assert.deepEqual(result.issues, []);
});

test("lti: a registration missing half of itself is an issue, not a silent fallback", () => {
  const result = ltiConfigFromEnv({ ONTRAK_LTI_ISSUER: ISSUER, ONTRAK_LTI_CLIENT_ID: CLIENT_ID });
  assert.equal(result.enabled, true);
  assert.equal(result.config, null);
  // Both endpoints come from the platform, not from discovery: LTI 1.3 has none.
  assert.ok(result.issues.some((issue) => issue.includes("ONTRAK_LTI_AUTHORIZATION_ENDPOINT")));
  assert.ok(result.issues.some((issue) => issue.includes("ONTRAK_LTI_JWKS_URI")));
});

test("lti: a token endpoint with no private key is said out loud, because the grade is silently lost", () => {
  const result = ltiConfigFromEnv({
    ONTRAK_LTI_ISSUER: ISSUER,
    ONTRAK_LTI_CLIENT_ID: CLIENT_ID,
    ONTRAK_LTI_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
    ONTRAK_LTI_JWKS_URI: `${ISSUER}/jwks`,
    ONTRAK_LTI_TOKEN_ENDPOINT: `${ISSUER}/token`,
  });
  assert.equal(result.config, null, "an unusable registration is refused rather than half-used");
  assert.ok(result.issues.some((issue) => issue.includes("ONTRAK_LTI_PRIVATE_KEY")));
});

test("lti: a half-wired registration is a boot warning, and a working one says nothing", () => {
  // An unconfigured deployment is quiet: no platform is the ordinary case, not a
  // mistake, and a warning here would train an operator to ignore the line.
  assert.equal(ltiConfigWarning({}), null);

  const complete = ltiConfigWarning({
    ONTRAK_LTI_ISSUER: ISSUER,
    ONTRAK_LTI_CLIENT_ID: CLIENT_ID,
    ONTRAK_LTI_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
    ONTRAK_LTI_JWKS_URI: `${ISSUER}/jwks`,
  });
  assert.equal(complete, null, "a complete registration prints nothing");

  const half = ltiConfigWarning({ ONTRAK_LTI_ISSUER: ISSUER, ONTRAK_LTI_CLIENT_ID: CLIENT_ID });
  assert.ok(half, "a registration missing its endpoints is said out loud");
  assert.match(half!, /ONTRAK_LTI_AUTHORIZATION_ENDPOINT/);

  // The passback key is the case this exists for: the launch works, the grade is
  // silently lost, and nothing else in the deployment mentions it.
  const noKey = ltiConfigWarning({
    ONTRAK_LTI_ISSUER: ISSUER,
    ONTRAK_LTI_CLIENT_ID: CLIENT_ID,
    ONTRAK_LTI_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
    ONTRAK_LTI_JWKS_URI: `${ISSUER}/jwks`,
    ONTRAK_LTI_TOKEN_ENDPOINT: `${ISSUER}/token`,
  });
  assert.ok(noKey, "a token endpoint with no key is said out loud");
  assert.match(noKey!, /ONTRAK_LTI_PRIVATE_KEY/);
});

test("lti: the boot hook prints the warning once, naming what is wrong", async () => {
  const { register } = await import("../src/instrumentation");
  const warnings: string[] = [];
  const original = console.warn;
  const saved = { ...process.env };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    process.env.NEXT_RUNTIME = "nodejs";

    delete process.env.ONTRAK_LTI_ISSUER;
    delete process.env.ONTRAK_LTI_CLIENT_ID;
    await register();
    assert.equal(warnings.length, 0, "an unconfigured deployment boots silently");

    process.env.ONTRAK_LTI_ISSUER = ISSUER;
    process.env.ONTRAK_LTI_CLIENT_ID = CLIENT_ID;
    await register();
    assert.equal(warnings.length, 1, "a broken registration is said exactly once");
    assert.match(warnings[0], /ONTRAK_LTI_AUTHORIZATION_ENDPOINT/);
  } finally {
    console.warn = original;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test("lti: a complete registration is read, with its deployments and its default role", () => {
  const result = ltiConfigFromEnv({
    ONTRAK_LTI_ISSUER: `${ISSUER}/`,
    ONTRAK_LTI_CLIENT_ID: CLIENT_ID,
    ONTRAK_LTI_DEPLOYMENT_IDS: "7, 9",
    ONTRAK_LTI_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
    ONTRAK_LTI_JWKS_URI: `${ISSUER}/jwks`,
    ONTRAK_LTI_DEFAULT_ROLE: "INSTRUCTOR",
  });
  assert.equal(result.enabled, true);
  assert.equal(result.config?.issuer, ISSUER, "a trailing slash is not part of an issuer");
  assert.deepEqual(result.config?.deploymentIds, ["7", "9"]);
  assert.equal(result.config?.defaultRole, "INSTRUCTOR");
  assert.equal(result.config?.tokenEndpoint, null, "no token endpoint means launches still work");
});

/* -------------------------------------------------------------------------- */
/*  Step one: the platform's login initiation                                  */
/* -------------------------------------------------------------------------- */

test("lti: a login from somebody else's platform is refused before anything is started", () => {
  const foreign = readLtiLogin(
    new URLSearchParams({ iss: "https://other.example.edu", login_hint: "42" }),
    CONFIG,
  );
  assert.equal(foreign.ok, false);
  assert.match(foreign.ok === false ? foreign.reason : "", /not the one this deployment registered/);

  const anonymous = readLtiLogin(new URLSearchParams({ iss: ISSUER }), CONFIG);
  assert.equal(anonymous.ok, false, "a launch with nobody to sign in has no login_hint");

  const wrongClient = readLtiLogin(
    new URLSearchParams({ iss: ISSUER, login_hint: "42", client_id: "somebody-else" }),
    CONFIG,
  );
  assert.equal(wrongClient.ok, false);

  const wrongDeployment = readLtiLogin(
    new URLSearchParams({ iss: ISSUER, login_hint: "42", deployment_id: "99" }),
    CONFIG,
  );
  assert.equal(wrongDeployment.ok, false);
});

test("lti: a login this deployment's platform sent is read whole", () => {
  const read = readLtiLogin(
    new URLSearchParams({
      iss: ISSUER,
      login_hint: "42",
      client_id: CLIENT_ID,
      deployment_id: "7",
      target_link_uri: "https://training.example/api/lti/launch",
      lti_message_hint: "opaque-1",
    }),
    CONFIG,
  );
  assert.equal(read.ok, true);
  assert.equal(read.ok ? read.request.loginHint : "", "42");
  assert.equal(read.ok ? read.request.deploymentId : "", "7");
});

test("lti: the authorization request is an OIDC handshake this product started", () => {
  const url = new URL(
    buildLtiLoginUrl(CONFIG, {
      loginHint: "42",
      targetLinkUri: "https://training.example/api/lti/launch",
      messageHint: "opaque-1",
      state: "state-1",
      nonce: "nonce-1",
      redirectUri: ltiRedirectUri("https://training.example"),
    }),
  );
  assert.equal(url.origin + url.pathname, `${ISSUER}/mod/lti/auth.php`);
  const params = url.searchParams;
  // form_post is not a preference: a fragment would put an ID token in a URL.
  assert.equal(params.get("response_mode"), "form_post");
  assert.equal(params.get("response_type"), "id_token");
  // prompt=none is what makes it a launch rather than a second sign-in.
  assert.equal(params.get("prompt"), "none");
  assert.equal(params.get("scope"), "openid");
  assert.equal(params.get("client_id"), CLIENT_ID);
  assert.equal(params.get("redirect_uri"), `https://training.example${LTI_LAUNCH_PATH}`);
  assert.equal(params.get("state"), "state-1");
  assert.equal(params.get("nonce"), "nonce-1");
  assert.equal(params.get("login_hint"), "42");
  assert.equal(params.get("lti_message_hint"), "opaque-1");
});

/* -------------------------------------------------------------------------- */
/*  Step three: the assertion                                                 */
/* -------------------------------------------------------------------------- */

test("lti: a valid launch becomes a person, a course and a line item", () => {
  const result = extractLaunchClaims(payload(), EXPECTED);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { launch } = result;
  assert.equal(launch.subject, "learner-1");
  assert.equal(launch.email, "ada@acme.test", "the platform's address is normalised the way ours are");
  assert.equal(launch.name, "Ada Lovelace");
  assert.equal(launch.localRole, "STUDENT");
  assert.equal(launch.roleMapped, true);
  assert.equal(launch.resourceLink.id, "rl-1");
  assert.equal(launch.context.id, "course-42");
  assert.equal(launch.lineItem, "https://lms.example.edu/lineitems/9");
  assert.equal(mayWriteScore(launch.agsScopes), true);
});

test("lti: every claim that could make a launch somebody else's is checked", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ iss: "https://other.example.edu" }, /not issued by/],
    [{ aud: "somebody-else" }, /different client/],
    [{ aud: ["somebody-else", "another"] }, /different client/],
    [{ azp: "somebody-else" }, /authorized for a different client/],
    [{ nonce: "nonce-2" }, /did not match the request/],
    [{ [LTI_CLAIM.deploymentId]: undefined }, /named no deployment/],
    [{ [LTI_CLAIM.deploymentId]: "99" }, /Deployment "99" is not registered/],
    [{ [LTI_CLAIM.version]: "1.1.0" }, /Only LTI 1\.3\.0/],
    [{ [LTI_CLAIM.messageType]: LTI_MESSAGE_TYPES.deepLinking }, /Deep linking/],
    [{ [LTI_CLAIM.messageType]: "LtiSubmissionReviewRequest" }, /can only launch a resource link/],
    [{ sub: undefined }, /named nobody/],
    [{ email: undefined }, /did not send an email address/],
    [{ email: "not-an-address" }, /did not send an email address/],
    [{ [LTI_CLAIM.resourceLink]: {} }, /named no resource link/],
  ];

  for (const [overrides, expected] of cases) {
    const result = extractLaunchClaims(payload(overrides), EXPECTED);
    assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(overrides)}`);
    assert.match(result.ok === false ? result.reason : "", expected);
  }
});

test("lti: an audience that is a list containing us is a valid launch", () => {
  const result = extractLaunchClaims(payload({ aud: ["another-client", CLIENT_ID], azp: CLIENT_ID }), EXPECTED);
  assert.equal(result.ok, true);
});

test("lti: the LIS role decides the local role, and the more capable role wins a tie", () => {
  const learner = "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner";
  const instructor = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";
  const admin = "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator";
  const unknown = "http://purl.imsglobal.org/vocab/lis/v2/membership#Proctor";

  assert.deepEqual(ltiRoleOf([learner]), { role: "STUDENT", mapped: true });
  assert.deepEqual(ltiRoleOf([instructor]), { role: "INSTRUCTOR", mapped: true });
  assert.deepEqual(ltiRoleOf([admin]), { role: "ADMIN", mapped: true });
  assert.deepEqual(
    ltiRoleOf([learner, instructor]),
    { role: "INSTRUCTOR", mapped: true },
    "an instructor is also a member of the course, and taking their own courses away would be the wrong reading",
  );
  // LIS grows its vocabulary; a product that refused on a new value would break on
  // somebody else's release.
  assert.deepEqual(ltiRoleOf([unknown], "INSTRUCTOR"), { role: "INSTRUCTOR", mapped: false });
});

test("lti: a launch with no recognised role says so rather than pretending it matched", () => {
  const result = extractLaunchClaims(payload({ [LTI_CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Proctor"] }), {
    ...EXPECTED,
    defaultRole: "INSTRUCTOR",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.launch.localRole, "INSTRUCTOR");
  assert.equal(result.launch.roleMapped, false);
  assert.match(roleReason(result.launch), /no role this deployment recognises/);
});

test("lti: the custom claim survives as strings, so a deployment can hang its own names on a link", () => {
  const result = extractLaunchClaims(
    payload({ [LTI_CLAIM.custom]: { ontrak_assignment: "assign-3", count: 4, empty: "  " } }),
    EXPECTED,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.launch.custom : null, { ontrak_assignment: "assign-3", count: "4" });
});

/* -------------------------------------------------------------------------- */
/*  Assignment & Grade Services                                                */
/* -------------------------------------------------------------------------- */

test("lti: a score is addressed to the line item, as a complete grade", () => {
  assert.equal(agsScoreUrl("https://lms.example.edu/lineitems/9/"), "https://lms.example.edu/lineitems/9/scores");

  const body = agsScore({
    score: 8,
    maxScore: 10,
    subject: "learner-1",
    gradedAt: "2026-10-05T12:00:00.000Z",
  });
  assert.deepEqual(body, {
    userId: "learner-1",
    scoreGiven: 8,
    scoreMaximum: 10,
    // Without these two a platform holds the score as provisional and it never
    // reaches the gradebook.
    activityProgress: "Completed",
    gradingProgress: "FullyGraded",
    timestamp: "2026-10-05T12:00:00.000Z",
  });
});

test("lti: the token that authorizes a score is a signed assertion this deployment mints", () => {
  const assertion = agsTokenAssertion({
    issuer: CLIENT_ID,
    clientId: CLIENT_ID,
    audience: `${ISSUER}/token`,
    jti: "jti-1",
    nowSec: 1_700_000_000,
    ttlSec: 300,
  });
  assert.deepEqual(assertion, {
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: `${ISSUER}/token`,
    jti: "jti-1",
    iat: 1_700_000_000,
    exp: 1_700_000_300,
  });

  const form = agsTokenForm("signed.assertion");
  assert.equal(form.grant_type, "client_credentials");
  assert.equal(form.client_assertion, "signed.assertion");
  assert.equal(form.scope, LTI_AGS_SCORE_SCOPE);
});

test("lti: three different reasons a grade stays here, said as three different sentences", () => {
  const facts = ltiLaunchFacts(
    (() => {
      const result = extractLaunchClaims(payload(), EXPECTED);
      if (!result.ok) throw new Error(result.reason);
      return result.launch;
    })(),
    "2026-10-05T09:00:00.000Z",
  );

  assert.match(passbackRefusal(null, true) ?? "", /did not come from a learning platform/);
  assert.match(passbackRefusal({ ...facts, lineItem: null }, true) ?? "", /nowhere to send it/);
  assert.match(passbackRefusal({ ...facts, agsScopes: [] }, true) ?? "", /did not grant the score scope/);
  assert.match(passbackRefusal(facts, false) ?? "", /no platform credentials/);
  assert.equal(passbackRefusal(facts, true), null);
});

/* -------------------------------------------------------------------------- */
/*  The context an attempt inherits                                            */
/* -------------------------------------------------------------------------- */

test("lti: a launch context is dated, so yesterday's launch cannot attach a course somebody left", () => {
  const launch = extractLaunchClaims(payload(), EXPECTED);
  assert.equal(launch.ok, true);
  if (!launch.ok) return;

  const facts = ltiLaunchFacts(launch.launch, "2026-10-05T09:00:00.000Z");
  assert.equal(facts.subject, "learner-1");
  assert.equal(facts.email, "ada@acme.test");
  assert.equal(facts.contextId, "course-42");
  assert.equal(facts.resourceLinkId, "rl-1");
  assert.equal(launchFactsExpired(facts, "2026-10-05T09:30:00.000Z"), false);
  assert.equal(launchFactsExpired(facts, "2026-10-05T11:00:00.000Z"), true);
});

test("lti: the handshake state cannot be resumed later, and cannot be half-read", () => {
  const state = { state: "s", nonce: "n", returnTo: "/student", at: "2026-10-05T09:00:00.000Z" };
  assert.equal(ltiStateExpired(state, "2026-10-05T09:05:00.000Z"), false);
  assert.equal(ltiStateExpired(state, "2026-10-05T09:20:00.000Z"), true);
});

/* -------------------------------------------------------------------------- */
/*  The account a launch lands on                                              */
/* -------------------------------------------------------------------------- */

test("lti: the platform's subject is namespaced, because two platforms both start at 1", () => {
  const launch = extractLaunchClaims(payload(), EXPECTED);
  assert.equal(launch.ok, true);
  if (!launch.ok) return;

  assert.equal(ltiExternalId(launch.launch), `lti:${ISSUER}#learner-1`);

  const other = "https://another.example.edu";
  const first = extractLaunchClaims(payload({ iss: ISSUER, sub: "1" }), EXPECTED);
  const second = extractLaunchClaims(payload({ iss: other, sub: "1" }), { ...EXPECTED, issuer: other });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(
    ltiExternalId(first.launch),
    ltiExternalId(second.launch),
    "one platform's subject 1 is not another platform's subject 1",
  );

  const authorization = launchAuthorization(launch.launch);
  assert.equal(authorization.email, "ada@acme.test");
  assert.equal(authorization.role, "STUDENT");
});

test("lti: a launch is audited with the platform, the course and the resource link", () => {
  const launch = extractLaunchClaims(payload(), EXPECTED);
  assert.equal(launch.ok, true);
  if (!launch.ok) return;

  const audit = ltiLaunchAudit(launch.launch, {
    user: {
      id: "u1",
      email: "ada@acme.test",
      name: "Ada",
      role: "STUDENT",
      active: true,
      accent: "violet",
      externalId: "lti:x#1",
    },
    provisioned: true,
    roleChanged: false,
    note: null,
  });
  assert.equal(audit.action, "auth.lti_launch");
  assert.equal(audit.targetId, "u1");
  assert.equal(audit.detail.platform, ISSUER);
  assert.equal(audit.detail.resourceLink, "rl-1");
  assert.equal(audit.detail.context, "course-42");
  assert.equal(audit.detail.provisioned, true);
  assert.equal(audit.detail.gradePassback, true);
});

/* -------------------------------------------------------------------------- */
/*  The client seam                                                            */
/* -------------------------------------------------------------------------- */

test("lti: the memory client verifies a known assertion and records what it is asked to post", async () => {
  const client = new MemoryLtiClient({ launches: { "assertion-1": payload() } });

  const claims = await client.verifyLaunch({
    idToken: "assertion-1",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    jwksUri: `${ISSUER}/jwks`,
  });
  assert.equal(claims.sub, "learner-1");

  await assert.rejects(() => client.verifyLaunch({ idToken: "forged", issuer: ISSUER, clientId: CLIENT_ID, jwksUri: `${ISSUER}/jwks` }));

  const posted = await client.postScore({
    lineItem: "https://lms.example.edu/lineitems/9",
    score: agsScore({ score: 8, maxScore: 10, subject: "learner-1", gradedAt: "2026-10-05T12:00:00.000Z" }),
  });
  assert.equal(posted.ok, true);
  assert.equal(client.scores.length, 1);
  assert.equal(client.scores[0]?.url, "https://lms.example.edu/lineitems/9/scores");
  assert.equal(client.scores[0]?.score.scoreGiven, 8);
});

test("lti: a platform that refuses the write is an outcome, not a thrown error", async () => {
  const client = new MemoryLtiClient({ acceptScores: false });
  const posted = await client.postScore({ lineItem: "https://lms.example.edu/lineitems/9", score: {} });
  assert.equal(posted.ok, false);
  assert.equal(posted.status, 403);
});
