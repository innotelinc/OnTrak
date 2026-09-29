/**
 * The family's default hash.
 *
 * One definition, used for three different jobs: the evidence chains, the PKCE
 * code challenge, and looking an access token up without storing the token.
 * They want the same thing — SHA-256 — and three copies of it would be three
 * places to get a digest subtly wrong.
 *
 * It lives beside the pure modules rather than inside one of them, because
 * `audit-chain.ts` and `oidc-rules.ts` are deliberately free of Node built-ins:
 * they take a `HashFn` so the same logic runs in a server, in a worker and in a
 * test. This file is where the real one comes from.
 */

import { createHash } from "node:crypto";

import type { HashFn } from "./audit-chain";

export const sha256Hex: HashFn = (input) => createHash("sha256").update(input).digest("hex");
