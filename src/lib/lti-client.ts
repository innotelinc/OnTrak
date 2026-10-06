/**
 * LTI client: the two network calls a launch needs, behind one seam.
 *
 * The decisions all live in `lti-rules.ts`; this module is what makes them
 * testable without an LMS. Two implementations ship:
 *
 *  - `HttpLtiClient` verifies a launch assertion against the platform's published
 *    JWKS (via `jose`) and writes a score back through Assignment & Grade
 *    Services, minting its own access token from a signed client assertion.
 *  - `MemoryLtiClient` answers from a fixture and records what it was asked to
 *    post, so the whole launch and passback path runs with no network.
 *
 * Two things are deliberate rather than incidental. **The launch is verified with
 * `jose`'s own issuer and audience checks** as well as the rules module's, because
 * a claim this module forgot to look at is exactly the one a forged launch would
 * use. And **a failed passback never throws**: a grade that reached the learner
 * here is a fact whether or not the platform accepted a copy of it.
 */

import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";

import {
  agsScoreUrl,
  agsTokenAssertion,
  agsTokenForm,
  LTI_AGS_SCORE_SCOPE,
  type LtiConfig,
} from "./lti-rules";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LaunchVerifyInput {
  idToken: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
}

export interface ScorePostInput {
  lineItem: string;
  score: Record<string, unknown>;
}

export interface LtiClient {
  /** The verified launch assertion's claims, ready for `extractLaunchClaims`. */
  verifyLaunch(input: LaunchVerifyInput): Promise<Record<string, unknown>>;
  /** Post a score to a line item. Resolves with the platform's status. */
  postScore(input: ScorePostInput): Promise<{ ok: boolean; status: number; error?: string }>;
}

/* -------------------------------------------------------------------------- */
/*  HTTP                                                                      */
/* -------------------------------------------------------------------------- */

export class HttpLtiClient implements LtiClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async verifyLaunch(input: LaunchVerifyInput): Promise<Record<string, unknown>> {
    const jwks = createRemoteJWKSet(new URL(input.jwksUri));
    const { payload } = await jwtVerify(input.idToken, jwks, {
      issuer: input.issuer,
      audience: input.clientId,
    });
    return payload as Record<string, unknown>;
  }

  /**
   * A score, over AGS.
   *
   * The access token is asked for per write rather than cached: the platform's
   * tokens are short-lived, and a cached one that expired is a grade that failed
   * silently an hour later.
   */
  async postScore(input: ScorePostInput): Promise<{ ok: boolean; status: number; error?: string }> {
    const config = this.config;
    if (!config?.tokenEndpoint || !config.privateKey || !config.keyId) {
      return { ok: false, status: 0, error: "This deployment has no platform credentials for grade passback." };
    }

    // A PEM pasted into an env var keeps its newlines only if they are escaped, so
    // both spellings are accepted; anything else fails to import, loudly.
    const key = await importPKCS8(config.privateKey.replace(/\\n/g, "\n"), "RS256");
    const nowSec = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT(
      agsTokenAssertion({
        issuer: config.clientId,
        clientId: config.clientId,
        audience: config.tokenEndpoint,
        jti: `${config.clientId}-${nowSec}-${Math.random().toString(36).slice(2, 10)}`,
        nowSec,
        ttlSec: 300,
      }),
    )
      .setProtectedHeader({ alg: "RS256", kid: config.keyId, typ: "JWT" })
      .sign(key);

    const tokenResponse = await this.fetchImpl(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(agsTokenForm(assertion, LTI_AGS_SCORE_SCOPE)).toString(),
    });
    if (!tokenResponse.ok) {
      return { ok: false, status: tokenResponse.status, error: `The platform refused an access token (${tokenResponse.status}).` };
    }
    const tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
    const token = typeof tokenBody.access_token === "string" ? tokenBody.access_token : "";
    if (!token) return { ok: false, status: tokenResponse.status, error: "The platform returned no access token." };

    const scoreResponse = await this.fetchImpl(agsScoreUrl(input.lineItem), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/vnd.ims.lis.v1.score+json",
        accept: "application/vnd.ims.lis.v1.score+json",
      },
      body: JSON.stringify(input.score),
    });
    if (!scoreResponse.ok) {
      return { ok: false, status: scoreResponse.status, error: `The platform refused the score (${scoreResponse.status}).` };
    }
    return { ok: true, status: scoreResponse.status };
  }

  /** The registration this client posts under. Set by `ltiClientFromConfig`. */
  private config: LtiConfig | null = null;

  withConfig(config: LtiConfig | null): this {
    this.config = config;
    return this;
  }
}

/* -------------------------------------------------------------------------- */
/*  Memory                                                                    */
/* -------------------------------------------------------------------------- */

/** What a memory client was asked to do, so a test can assert the write happened. */
export interface RecordedScore {
  lineItem: string;
  score: Record<string, unknown>;
  url: string;
}

export class MemoryLtiClient implements LtiClient {
  readonly scores: RecordedScore[] = [];

  constructor(
    private readonly fixture: {
      /** Launch assertions keyed by their token, as the platform would send them. */
      launches?: Record<string, Record<string, unknown>>;
      /** Force a verification failure, to exercise the refusal path. */
      verifyError?: string;
      /** Make the score write fail, to exercise the "graded anyway" path. */
      scoreError?: string;
      /** Whether a score write is accepted. */
      acceptScores?: boolean;
    } = {},
  ) {}

  async verifyLaunch(input: LaunchVerifyInput): Promise<Record<string, unknown>> {
    if (this.fixture.verifyError) throw new Error(this.fixture.verifyError);
    const payload = this.fixture.launches?.[input.idToken];
    if (!payload) throw new Error("That launch assertion could not be verified.");
    return payload;
  }

  async postScore(input: ScorePostInput): Promise<{ ok: boolean; status: number; error?: string }> {
    this.scores.push({ lineItem: input.lineItem, score: input.score, url: agsScoreUrl(input.lineItem) });
    if (this.fixture.scoreError) return { ok: false, status: 400, error: this.fixture.scoreError };
    return { ok: this.fixture.acceptScores !== false, status: this.fixture.acceptScores === false ? 403 : 200 };
  }
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/** An HTTP client bound to one registration, or `null` when LTI is off. */
export function ltiClientFromConfig(config: LtiConfig | null): LtiClient | null {
  if (!config) return null;
  return new HttpLtiClient().withConfig(config);
}
