/**
 * Tests for `pickRedirectUri` — which of a deployment's names a sign-in uses.
 *
 * The provider matches the redirect URI byte for byte, so a deployment reachable
 * at more than one name lists them all and the browser's `Host` header decides.
 * This is pure, so it needs no provider and no environment: the configured list
 * and the host are the whole input.
 */

import assert from "node:assert/strict";
import test from "node:test";

const { pickRedirectUri } = await import("../oidc.js");

const BOTH = [
  "https://genie.ontrak.innotel.us/api/auth/callback",
  "https://genie.innotel.us/api/auth/callback",
].join(",");

test("picks the configured redirect URI matching the browser's host", () => {
  assert.equal(pickRedirectUri(BOTH, "genie.innotel.us", 3400), "https://genie.innotel.us/api/auth/callback");
  assert.equal(
    pickRedirectUri(BOTH, "genie.ontrak.innotel.us", 3400),
    "https://genie.ontrak.innotel.us/api/auth/callback",
  );
});

test("matches on the hostname, ignoring a port and any case", () => {
  assert.equal(pickRedirectUri(BOTH, "genie.innotel.us:443", 3400), "https://genie.innotel.us/api/auth/callback");
  assert.equal(
    pickRedirectUri(BOTH, "GENIE.ONTRAK.INNOTEL.US", 3400),
    "https://genie.ontrak.innotel.us/api/auth/callback",
  );
});

test("an unlisted or absent host falls back to the first configured URI", () => {
  assert.equal(
    pickRedirectUri(BOTH, "elsewhere.example", 3400),
    "https://genie.ontrak.innotel.us/api/auth/callback",
  );
  assert.equal(
    pickRedirectUri(BOTH, undefined, 3400),
    "https://genie.ontrak.innotel.us/api/auth/callback",
  );
});

test("a single configured URI is used as-is whatever the host", () => {
  const single = "https://genie.innotel.us/api/auth/callback";
  assert.equal(pickRedirectUri(single, "genie.ontrak.innotel.us", 3400), single);
  assert.equal(pickRedirectUri(single, undefined, 3400), single);
});

test("nothing configured (or only blanks) falls back to loopback", () => {
  assert.equal(pickRedirectUri("", "genie.innotel.us", 3400), "http://127.0.0.1:3400/api/auth/callback");
  assert.equal(pickRedirectUri("  ,  ", "genie.innotel.us", 3400), "http://127.0.0.1:3400/api/auth/callback");
});
