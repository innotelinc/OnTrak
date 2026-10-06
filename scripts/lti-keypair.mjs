#!/usr/bin/env node
/**
 * Mint the keypair this deployment signs an LTI grade passback with.
 *
 * A launch and a passback are secured in opposite directions. On the way in, the
 * platform signs an assertion and *we* verify it against the platform's published
 * key set. On the way out, we prove who we are to the platform's token endpoint by
 * signing a client assertion with our own key — and the platform can only verify
 * that if it was handed the public half first.
 *
 * So there are two artifacts and they go to two places:
 *
 *   1. the private key goes in this deployment's `.env`, as the escaped one-line
 *      `ONTRAK_LTI_PRIVATE_KEY`, next to `ONTRAK_LTI_KEY_ID`;
 *   2. the public JWKS goes to whoever administers the LMS's LTI registration, so
 *      it can be pasted in under the same `ONTRAK_LTI_KEY_ID`.
 *
 * The key id is the join between the two: an assertion signed under a `kid` the
 * platform does not have is an assertion the platform refuses, and the failure
 * looks exactly like a wrong key.
 *
 * Nothing is written to disk — a key generator that quietly dropped a private key
 * in the repository's directory would be worse than printing it here, where the
 * operator decides where it lives. Without `ONTRAK_LTI_TOKEN_ENDPOINT` the pair is
 * still useful for registering the tool, but grade passback stays off (see
 * `docs/integrations.md`).
 *
 * Usage:
 *   node scripts/lti-keypair.mjs                 # key id: ontrak-training-1
 *   node scripts/lti-keypair.mjs --kid my-kid    # a chosen key id
 *   node scripts/lti-keypair.mjs --json          # the JWKS alone, for a pipeline
 *
 * `make lti-key` runs the first form.
 */

import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const kidFlag = args.indexOf("--kid");
const kid = (kidFlag >= 0 ? args[kidFlag + 1] : "") || process.env.ONTRAK_LTI_KEY_ID || "ontrak-training-1";
const tokenEndpoint =
  process.env.ONTRAK_LTI_TOKEN_ENDPOINT || "https://lms.example.edu/mod/lti/token.php";

const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const pem = await exportPKCS8(privateKey);
// One line for `.env`: the app accepts the escaped form and turns it back into the
// multi-line PEM before importing it (see `lti-client.ts`).
const escaped = pem.trim().replace(/\n/g, "\\n");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }] };

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(jwks)}\n`);
} else {
  process.stdout.write(
    [
      "# Minted an LTI grade-passback keypair. Nobody else has it; it is printed once.",
      `# Key id: ${kid}`,
      "#",
      "# 1. Paste these two lines into this deployment's .env and restart the app:",
      "",
      `ONTRAK_LTI_KEY_ID="${kid}"`,
      `ONTRAK_LTI_PRIVATE_KEY="${escaped}"`,
      "",
      "#    (ONTRAK_LTI_TOKEN_ENDPOINT is the platform's, not ours — it must already be",
      "#    set for the passback to be attempted:)",
      `ONTRAK_LTI_TOKEN_ENDPOINT="${tokenEndpoint}"`,
      "",
      "# 2. Give the LMS these public keys, under the key id above, so it can verify",
      "#    the assertion we sign. Paste the JSON into the registration's key set:",
      "",
      JSON.stringify(jwks, null, 2),
      "",
      "# Full instructions: docs/integrations.md, \"The grade goes back\".",
      "",
    ].join("\n"),
  );
}
