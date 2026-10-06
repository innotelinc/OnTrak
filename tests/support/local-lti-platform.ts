/**
 * A real, minimal LTI 1.3 platform (LMS) for tests.
 *
 * `tests/lti.test.ts` proves the launch decisions against a fixture, which is
 * what makes the thirteen refusals cheap to state and cheap to read. It cannot
 * prove that the *routes* walk a platform's handshake, because a fixture never
 * sends a browser anywhere. This boots an actual platform on a loopback port and
 * signs actual launch assertions with a real key, so a test can drive the whole
 * flow the way an LMS does:
 *
 *   1. the tool starts a login and redirects the browser here;
 *   2. this platform answers with a `form_post` page carrying a signed `id_token`;
 *   3. the browser posts that to the tool's launch URL;
 *   4. a score written back through Assignment & Grade Services lands here.
 *
 * It is deliberately strict where a platform is strict — the authorization request
 * must name the registered client, `response_type=id_token`, `response_mode=form_post`
 * and a nonce — so "the tool sends a valid handshake" is proven rather than assumed.
 * Options let a test make it fail on purpose, so the refusals are proven too.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";

export interface LocalLtiPlatformOptions {
  /** The client id the platform registered with the tool. */
  clientId?: string;
  /** The deployment the platform will name in its launch. */
  deploymentId?: string;
  /** Claims merged into every launch assertion, for the failure cases. */
  claims?: Record<string, unknown>;
  /** Sign the assertion with a key the platform does *not* publish. */
  signWithUnpublishedKey?: boolean;
  /** Refuse the AGS token request, so a passback fails where a test wants it to. */
  refuseToken?: boolean;
  /**
   * The tool's public key, as an LMS holds it in its LTI registration. When set,
   * the token endpoint verifies the client assertion's signature, issuer, audience
   * and `kid` exactly as a real platform's would — so a passback test proves the
   * key registration and not merely that a request was sent.
   */
  clientKey?: { jwk: Record<string, unknown>; kid: string };
}

export interface LocalLtiPlatform {
  /** The issuer identifier, which is also this platform's base URL. */
  readonly issuer: string;
  readonly clientId: string;
  readonly deploymentId: string;
  readonly authorizationEndpoint: string;
  readonly jwksUri: string;
  readonly tokenEndpoint: string;
  /** The AGS line item a launch names, whose `/scores` this platform records. */
  readonly lineItem: string;
  /** Every score posted to the line item, in order. */
  readonly scores: Record<string, unknown>[];
  /** Calls to each endpoint, so a test can assert one happened (or did not). */
  readonly calls: { authorize: number; jwks: number; token: number; scores: number };
  /**
   * The hidden form the authorization page would auto-submit, as structured
   * fields. A test acts as the browser and POSTs these to the tool's launch URL.
   */
  launchFields(): { action: string; fields: Record<string, string> } | null;
  close(): Promise<void>;
}

export const LOCAL_LTI_CLIENT_ID = "ontrak-training-lti-test";
export const LOCAL_LTI_DEPLOYMENT_ID = "local-deployment-1";

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(text);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Start the platform on an ephemeral loopback port. Always `close()` it — the
 * test does so in a `finally`.
 */
export async function startLocalLtiPlatform(options: LocalLtiPlatformOptions = {}): Promise<LocalLtiPlatform> {
  const clientId = options.clientId ?? LOCAL_LTI_CLIENT_ID;
  const deploymentId = options.deploymentId ?? LOCAL_LTI_DEPLOYMENT_ID;
  const published = await generateKeyPair("RS256");
  const decoy = await generateKeyPair("RS256");
  const signingKey: CryptoKey = options.signWithUnpublishedKey ? decoy.privateKey : published.privateKey;
  const kid = "local-lti-1";
  const publicJwk = { ...(await exportJWK(published.publicKey)), kid, alg: "RS256", use: "sig" };

  const scores: Record<string, unknown>[] = [];
  const calls = { authorize: 0, jwks: 0, token: 0, scores: 0 };

  let issuer = "";
  let lineItem = "";
  let accessToken = "";
  // The last authorization request's redirect target and signed assertion, kept so
  // a test can act as the browser that would have posted the form.
  let pending: { action: string; fields: Record<string, string> } | null = null;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: "server_error", error_description: String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/jwks") {
      calls.jwks += 1;
      return send(response, 200, { keys: [publicJwk] });
    }

    if (path === "/authorize") {
      calls.authorize += 1;
      const params = url.searchParams;
      if (params.get("client_id") !== clientId) return send(response, 400, { error: "invalid_client" });
      const redirectUri = params.get("redirect_uri");
      if (!redirectUri) return send(response, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
      if (params.get("response_type") !== "id_token") return send(response, 400, { error: "unsupported_response_type" });
      if (params.get("response_mode") !== "form_post") return send(response, 400, { error: "invalid_request", error_description: "form_post is required" });
      const nonce = params.get("nonce") ?? "";
      if (!nonce) return send(response, 400, { error: "invalid_request", error_description: "nonce is required" });
      const state = params.get("state") ?? "";

      const idToken = await new SignJWT({
        nonce,
        sub: "lms-subject-1",
        email: "lms.learner@ontrak.local",
        name: "Lena LMS",
        "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
        "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
        "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deploymentId,
        "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": redirectUri,
        "https://purl.imsglobal.org/spec/lti/claim/resource_link": { id: "rl-1", title: "Fix a broken NIC" },
        "https://purl.imsglobal.org/spec/lti/claim/context": { id: "course-42", title: "Autumn intake", label: "CS101" },
        "https://purl.imsglobal.org/spec/lti/claim/roles": [
          "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
        ],
        "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint": {
          scope: [
            "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
            "https://purl.imsglobal.org/spec/lti-ags/scope/score",
          ],
          lineitem: lineItem,
        },
        ...options.claims,
      })
        .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signingKey);

      pending = { action: redirectUri, fields: { id_token: `${idToken}`, state } };

      // The page a browser would render: an auto-submitting form. A test reads the
      // fields and posts them itself, which is exactly what the browser does.
      const form = (action: string, fields: Record<string, string>) =>
        `<form method="post" action="${escapeHtml(action)}">` +
        Object.entries(fields)
          .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
          .join("") +
        `</form>`;
      return send(response, 200, `<!doctype html><html><body>${form(pending.action, pending.fields)}</body></html>`, "text/html");
    }

    if (path === "/token" && request.method === "POST") {
      calls.token += 1;
      const form = await readForm(request);
      if (form.get("grant_type") !== "client_credentials") return send(response, 400, { error: "unsupported_grant_type" });
      const assertion = form.get("client_assertion");
      if (!assertion) return send(response, 400, { error: "invalid_client", error_description: "no client assertion" });
      if (options.refuseToken) return send(response, 401, { error: "invalid_client" });
      if (options.clientKey) {
        // Exactly what an LMS's token endpoint checks: it verifies the signature
        // against the key it was registered with, requires the assertion to name
        // this platform as its audience and this client as its issuer, and matches
        // the `kid` so a tool that rotated its key without re-registering is told.
        try {
          const key = await importJWK(options.clientKey.jwk as Parameters<typeof importJWK>[0], "RS256");
          const { protectedHeader } = await jwtVerify(assertion, key, {
            issuer: clientId,
            audience: `${issuer}/token`,
          });
          if (protectedHeader.kid !== options.clientKey.kid) {
            throw new Error(`unknown key id ${protectedHeader.kid ?? "(none)"}`);
          }
        } catch (error) {
          return send(response, 401, {
            error: "invalid_client",
            error_description: `the client assertion was rejected: ${(error as Error).message}`,
          });
        }
      }
      accessToken = `ags-token-${calls.token}`;
      return send(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 300 });
    }

    if (path === "/ags/lineitems/9/scores" && request.method === "POST") {
      calls.scores += 1;
      const authorization = request.headers.authorization ?? "";
      if (authorization !== `Bearer ${accessToken}` || !accessToken) {
        return send(response, 401, { error: "invalid_token" });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      scores.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/vnd.ims.lis.v1.score+json" });
      response.end(JSON.stringify({ status: "recorded" }));
      return;
    }

    send(response, 404, { error: "not_found", error_description: path });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;
  lineItem = `${issuer}/ags/lineitems/9`;

  return {
    get issuer() {
      return issuer;
    },
    clientId,
    deploymentId,
    get lineItem() {
      return lineItem;
    },
    authorizationEndpoint: `${issuer}/authorize`,
    jwksUri: `${issuer}/jwks`,
    tokenEndpoint: `${issuer}/token`,
    scores,
    calls,
    launchFields: () => pending,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
