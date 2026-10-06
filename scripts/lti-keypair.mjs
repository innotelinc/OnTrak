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
 *   node scripts/lti-keypair.mjs                 # mint: key id ontrak-training-1
 *   node scripts/lti-keypair.mjs --kid my-kid    # mint under a chosen key id
 *   node scripts/lti-keypair.mjs --json          # the minted JWKS alone
 *   node scripts/lti-keypair.mjs --from-env      # the public half of the deployed key
 *   node scripts/lti-keypair.mjs --from-env --pem  # ...as a PEM, for Moodle
 *
 * `--from-env` reads `ONTRAK_LTI_PRIVATE_KEY` — from the environment, or from this
 * checkout's `.env` when it is not exported — and prints the JWKS to hand an LMS.
 * Re-registering a key a deployment already holds therefore never means minting a
 * second one, which would leave the two sides disagreeing. It uses only Node's
 * built-in crypto, so it runs wherever the key already lives.
 *
 * Two LMSes want the same key in two shapes. Most take a **JWKS**; Moodle's manual
 * tool form takes a **PEM public key** under "Public key type: RSA key" instead, so
 * both are printed, and `--pem` asks for the PEM alone (see docs/moodle-lti.md).
 *
 * `make lti-key` runs the first form; `make lti-key ARGS=--from-env` the last.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A setting, from the environment first and this checkout's `.env` second.
 *
 * `.env` here is the deployment's own file, not a template: the point of reading
 * it is that an operator does not have to export a key they already have on disk.
 */
function setting(name) {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const line = text.split("\n").find((entry) => entry.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch {
    // No .env at all — an environment-only deployment.
  }
  return "";
}

const args = process.argv.slice(2);
const kidFlag = args.indexOf("--kid");
const kid = (kidFlag >= 0 ? args[kidFlag + 1] : "") || setting("ONTRAK_LTI_KEY_ID") || "ontrak-training-1";
const tokenEndpoint = setting("ONTRAK_LTI_TOKEN_ENDPOINT") || "https://lms.example.edu/mod/lti/token.php";

/** The public JWKS an LMS is given, from a private PEM. Pure Node crypto, no jose. */
function publicJwks(privatePem) {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: "jwk" });
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}

/** The same public half as an SPKI PEM, the shape Moodle's "RSA key" field wants. */
function publicPem(privatePem) {
  return createPublicKey(createPrivateKey(privatePem))
    .export({ type: "spki", format: "pem" })
    .trim();
}

if (args.includes("--from-env")) {
  // Republish the public half of the key this deployment already holds.
  const pem = setting("ONTRAK_LTI_PRIVATE_KEY").replace(/\\n/g, "\n").trim();
  if (!pem) {
    process.stderr.write(
      "ONTRAK_LTI_PRIVATE_KEY is not set, here or in .env, so there is no key to publish.\n",
    );
    process.exit(1);
  }
  const output = args.includes("--pem") ? publicPem(pem) : JSON.stringify(publicJwks(pem), null, 2);
  process.stdout.write(`${output}\n`);
  process.exit(0);
}

const jsonOnly = args.includes("--json");
const { exportJWK, exportPKCS8, generateKeyPair } = await import("jose");

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
      "#    Some platforms — Moodle among them — take the key as a PEM instead of a",
      "#    JWKS: choose \"Public key type: RSA key\" and paste this:",
      "",
      publicPem(pem),
      "",
      "# Re-print this block for a key already in .env with:",
      "#   make lti-key ARGS=--from-env            # the JWKS",
      "#   make lti-key ARGS=\"--from-env --pem\"   # the PEM",
      "",
      "# Full instructions: docs/integrations.md, \"The grade goes back\".",
      "",
    ].join("\n"),
  );
}
