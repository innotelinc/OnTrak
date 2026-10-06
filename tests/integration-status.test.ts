/**
 * The integrations panel's facts, as the control room reads them.
 *
 * The console is where an operator finds out that a deployment is not configured the
 * way they think it is, so what these tests pin down is the *reading*, not the markup:
 * three states, the URLs a registration is actually reached at, and — the one that
 * matters most on a page somebody can screenshot — that a shared secret is reported as
 * the name of a variable and never as its value.
 *
 * The states are the routes' states: `incomplete` is the case where the rules module
 * refuses the configuration outright, so `/api/lti/*` and `/api/sso/*` answer `503`.
 * Painting a refused registration as "configured but degraded" would be the console
 * telling an operator something the deployment does not do.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { integrationStatuses, type IntegrationStatus } from "../src/lib/integration-status";
import { LTI_JWKS_PATH, LTI_LAUNCH_PATH, LTI_LOGIN_PATH } from "../src/lib/lti-rules";
import { SCIM_PATHS, SCIM_TOKEN_ENV } from "../src/lib/scim-rules";

const ISSUER = "https://lms.example.edu";

function statusOf(id: IntegrationStatus["id"], env: Record<string, string | undefined>): IntegrationStatus {
  const found = integrationStatuses(env).find((entry) => entry.id === id);
  assert.ok(found, `no status was reported for ${id}`);
  return found;
}

function detail(status: IntegrationStatus, key: string): string | undefined {
  return status.details.find((entry) => entry.key === key)?.value;
}

test("status: an empty environment leaves all three off, and only SCIM still has endpoints", () => {
  const statuses = integrationStatuses({});
  assert.deepEqual(
    statuses.map((entry) => [entry.id, entry.state]),
    [
      ["sso", "off"],
      ["lti", "off"],
      ["scim", "off"],
    ],
  );
  // With no provider and no platform there is nothing to name but the fact that it is off.
  assert.deepEqual(statusOf("sso", {}).details, []);
  assert.deepEqual(statusOf("lti", {}).details, []);
  assert.deepEqual(statusOf("sso", {}).issues, []);
  assert.deepEqual(statusOf("lti", {}).issues, []);

  // SCIM is the exception, and deliberately: the endpoints exist whether or not a
  // token does — `ServiceProviderConfig` answers without one — so an operator adding a
  // connector needs them even before the token is set.
  const scim = statusOf("scim", {});
  assert.equal(detail(scim, "usersPath"), SCIM_PATHS.users);
  assert.equal(detail(scim, "groupsPath"), SCIM_PATHS.groups);
  assert.equal(detail(scim, "tokenEnv"), SCIM_TOKEN_ENV);
});

test("status: a registration the routes refuse reads as misconfigured, with the reason", () => {
  const lti = statusOf("lti", { ONTRAK_LTI_ISSUER: ISSUER, ONTRAK_LTI_CLIENT_ID: "ontrak-training" });
  assert.equal(lti.state, "incomplete");
  // No URLs, because there is nothing to hand a platform: the routes answer 503.
  assert.deepEqual(lti.details, []);
  assert.ok(lti.issues.some((issue) => issue.includes("ONTRAK_LTI_AUTHORIZATION_ENDPOINT")));

  const sso = statusOf("sso", { ONTRAK_OIDC_ISSUER: ISSUER });
  assert.equal(sso.state, "incomplete");
  assert.deepEqual(sso.details, []);
  assert.ok(sso.issues.some((issue) => issue.includes("ONTRAK_OIDC_CLIENT_ID")));
});

test("status: a ready registration names who it trusts and where it is reached", () => {
  const lti = statusOf("lti", {
    ONTRAK_LTI_ISSUER: ISSUER,
    ONTRAK_LTI_CLIENT_ID: "ontrak-training",
    ONTRAK_LTI_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
    ONTRAK_LTI_JWKS_URI: `${ISSUER}/jwks`,
  });
  assert.equal(lti.state, "ready");
  assert.deepEqual(lti.issues, []);
  assert.equal(detail(lti, "issuer"), ISSUER);
  assert.equal(detail(lti, "clientId"), "ontrak-training");
  // The three URLs an operator copies into the platform's tool form.
  assert.equal(detail(lti, "launchPath"), LTI_LAUNCH_PATH);
  assert.equal(detail(lti, "loginPath"), LTI_LOGIN_PATH);
  assert.equal(detail(lti, "keySetPath"), LTI_JWKS_PATH);
  // Launch-only: the scenarios open, the grades stay here. Empty is what the page
  // renders as "not set", which is the honest reading of a missing value.
  assert.equal(detail(lti, "passback"), "");
  assert.equal(detail(lti, "keyId"), "");

  const sso = statusOf("sso", {
    ONTRAK_OIDC_ISSUER: ISSUER,
    ONTRAK_OIDC_CLIENT_ID: "ontrak",
    ONTRAK_OIDC_ALLOWED_DOMAINS: "ontrak.local",
  });
  assert.equal(sso.state, "ready");
  assert.equal(detail(sso, "issuer"), ISSUER);
  assert.equal(detail(sso, "clientId"), "ontrak");
  assert.equal(detail(sso, "allowedDomains"), "ontrak.local");
  // Unset means any domain the provider will authenticate, which reads as empty.
  const openToAnyDomain = statusOf("sso", { ONTRAK_OIDC_ISSUER: ISSUER, ONTRAK_OIDC_CLIENT_ID: "ontrak" });
  assert.equal(detail(openToAnyDomain, "allowedDomains"), "");
});

test("status: the session token and client secret are reported as variables, never as values", () => {
  const token = "integration-status-token-0123456789abcdef";
  const secret = "integration-status-client-secret-0123456789";
  const privateKey = "escaped-pem-placeholder-0123456789";
  const statuses = integrationStatuses({
    ONTRAK_SCIM_TOKEN: token,
    ONTRAK_OIDC_ISSUER: ISSUER,
    ONTRAK_OIDC_CLIENT_ID: "ontrak",
    ONTRAK_OIDC_CLIENT_SECRET: secret,
    ONTRAK_LTI_ISSUER: ISSUER,
    ONTRAK_LTI_CLIENT_ID: "ontrak-training",
    ONTRAK_LTI_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
    ONTRAK_LTI_JWKS_URI: `${ISSUER}/jwks`,
    ONTRAK_LTI_KEY_ID: "ontrak-training-1",
    ONTRAK_LTI_PRIVATE_KEY: privateKey,
  });

  // A token being set is what turns directory sync on — and the panel says which
  // variable holds it rather than what it holds.
  assert.equal(statusOf("scim", { ONTRAK_SCIM_TOKEN: token }).state, "ready");
  assert.equal(detail(statusOf("scim", { ONTRAK_SCIM_TOKEN: token }), "tokenEnv"), SCIM_TOKEN_ENV);

  // The whole rendered reading, checked for secrets: the console is a page an
  // operator can screenshot, paste into a ticket or read over somebody's shoulder.
  const rendered = JSON.stringify(statuses);
  for (const forbidden of [token, secret, privateKey]) {
    assert.equal(rendered.includes(forbidden), false, "a secret must never reach the console");
  }
  // And the key id *is* shown, which is the deliberate half of that rule: it is a name
  // the platform also holds, and an operator comparing the two sides needs it.
  const lti = statuses.find((entry) => entry.id === "lti")!;
  assert.equal(lti.state, "ready");
  assert.equal(detail(lti, "keyId"), "ontrak-training-1");
});
