/**
 * LTI grade passback, against a real token endpoint.
 *
 * `tests/lti.test.ts` proves the *decisions* a passback makes — which refusals are
 * which sentence, and that the score body says `FullyGraded` — against fixtures.
 * What it cannot prove is the half that actually leaves the building: that this
 * deployment signs a client assertion the platform's token endpoint accepts, with
 * the key id the registration named, and then writes the score to the line item.
 * That is a signature, an audience, a `kid` and an HTTP POST, and it is where a
 * "the grades never reach the gradebook" report actually comes from.
 *
 * So this starts the same minimal platform the live test uses — including its
 * token endpoint, which verifies the assertion against the tool's public key the
 * way an LMS does — and drives `HttpLtiClient` through it. No database and no
 * opt-in: the platform is in-process, so this runs in `npm test`.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lti-passback.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

import { ltiClientFromConfig } from "../src/lib/lti-client";
import { agsScore, type LtiConfig } from "../src/lib/lti-rules";
import { startLocalLtiPlatform } from "./support/local-lti-platform";

const KEY_ID = "ontrak-training-1";

/** The score a graded attempt would pass back. */
const SCORE = agsScore({
  score: 8,
  maxScore: 10,
  subject: "lms-subject-1",
  gradedAt: "2026-10-05T09:20:01.000Z",
});

/** The registration a deployment holds once it is pointed at the platform. */
function configFor(
  platform: Awaited<ReturnType<typeof startLocalLtiPlatform>>,
  key: { privateKey: string } | null,
): LtiConfig {
  return {
    issuer: platform.issuer,
    clientId: platform.clientId,
    deploymentIds: [platform.deploymentId],
    authorizationEndpoint: platform.authorizationEndpoint,
    jwksUri: platform.jwksUri,
    tokenEndpoint: platform.tokenEndpoint,
    privateKey: key?.privateKey ?? null,
    keyId: key ? KEY_ID : null,
    defaultRole: "STUDENT",
  };
}

test("a grade reaches the platform when the deployment signs with the registered key", async () => {
  const tool = await generateKeyPair("RS256", { extractable: true });
  const platform = await startLocalLtiPlatform({
    clientKey: { jwk: await exportJWK(tool.publicKey), kid: KEY_ID },
  });
  try {
    const client = ltiClientFromConfig(configFor(platform, { privateKey: await exportPKCS8(tool.privateKey) }));
    assert.ok(client, "a configured deployment has a client");

    const result = await client.postScore({ lineItem: platform.lineItem, score: SCORE });

    assert.equal(result.ok, true, `expected the score to be accepted, got ${JSON.stringify(result)}`);
    assert.equal(platform.calls.token, 1, "the token was minted exactly once, per write");
    assert.equal(platform.calls.scores, 1, "the score was posted");
    assert.deepEqual(platform.scores[0], SCORE, "the platform recorded the score body verbatim");
  } finally {
    await platform.close();
  }
});

test("a key the platform was not registered with is refused, and reported rather than thrown", async () => {
  // The platform trusts a decoy; the tool signs with its own key. This is a
  // deployment that minted a passback key and never handed the public half over,
  // which is the single most common way a passback is silently dead.
  const decoy = await generateKeyPair("RS256");
  const tool = await generateKeyPair("RS256", { extractable: true });
  const platform = await startLocalLtiPlatform({
    clientKey: { jwk: await exportJWK(decoy.publicKey), kid: KEY_ID },
  });
  try {
    const client = ltiClientFromConfig(configFor(platform, { privateKey: await exportPKCS8(tool.privateKey) }));
    const result = await client!.postScore({ lineItem: platform.lineItem, score: SCORE });

    assert.equal(result.ok, false, "an unregistered key must not get a token");
    assert.equal(result.status, 401);
    assert.equal(platform.calls.scores, 0, "no score was posted without a token");
    assert.ok(result.error, "the refusal says something an operator can act on");
  } finally {
    await platform.close();
  }
});

test("a deployment with no passback key never calls the platform at all", async () => {
  const platform = await startLocalLtiPlatform();
  try {
    const client = ltiClientFromConfig(configFor(platform, null));
    const result = await client!.postScore({ lineItem: platform.lineItem, score: SCORE });

    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(platform.calls.token, 0, "a missing key is refused here, not discovered downstream");
    assert.match(result.error ?? "", /no platform credentials/i);
  } finally {
    await platform.close();
  }
});
