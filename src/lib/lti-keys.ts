/**
 * The tool's own public key set — the half of the keypair an LMS needs.
 *
 * A launch and a passback are secured in opposite directions, which is the thing
 * that is easy to get half-right. The platform signs the assertion and *we* verify
 * it against the platform's published keys; to write a score we sign a client
 * assertion with **our** key, and the platform can only check it if it was handed
 * our public half first.
 *
 * There are two ways to hand it over, and this module exists so the deployment can
 * offer the better one. Pasting a PEM (or a JWKS document) into the platform's tool
 * configuration makes a *copy*, and a copy is a thing that drifts: the key is
 * rotated here, nobody remembers to paste the new one there, and the failure is a
 * grade that never arrives. Serving the key set from a stable URL means the
 * deployment always publishes the key it actually holds — and a rotation that keeps
 * the same key id needs no change on the platform's side at all.
 *
 * The public half is derived rather than stored, which is the point: there is
 * exactly one copy of the secret, in `ONTRAK_LTI_PRIVATE_KEY`, and this is a pure
 * function of it. Node's built-in crypto does that, so nothing here needs `jose`,
 * and the output is byte-identical to `make lti-key ARGS=--from-env` — the two ways
 * of registering the key cannot disagree.
 *
 * **Nothing private can leave through here.** The public half is a separate
 * `KeyObject` (`createPublicKey`), so the JWK it exports has no `d`, `p` or `q` to
 * leak: a key set is fetched over the network by definition.
 */

import { createPrivateKey, createPublicKey, type JsonWebKey } from "node:crypto";

/** One published key: the public JWK, tagged with the `kid` the platform looks up. */
export type PublishedJwk = JsonWebKey & { kid: string; alg: string; use: string };

export interface ToolJwks {
  keys: PublishedJwk[];
}

/**
 * The public key set for a private PEM and the key id it is registered under.
 *
 * Returns `null` when the key cannot be read or the key id is missing, because a
 * key set that is published without a usable key is worse than none: the platform
 * fetches it, finds something it cannot verify with, and reports a signature
 * failure rather than a missing key.
 *
 * The PEM is accepted in either spelling. An env var cannot hold real newlines, so
 * a deployment pastes the escaped form and the signer turns it back
 * (`lti-client.ts` does the same), and a caller reading the key from a file passes
 * the literal form.
 */
export function toolJwks(privateKeyPem: string, keyId: string): ToolJwks | null {
  const pem = privateKeyPem.replace(/\\n/g, "\n").trim();
  const kid = keyId.trim();
  if (!pem || !kid) return null;

  try {
    // The public half, as its own key object: the private material is not reachable
    // from what gets exported, rather than being deleted from it.
    const publicJwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
    return { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] };
  } catch {
    // Not a PEM this runtime understands.
    return null;
  }
}
