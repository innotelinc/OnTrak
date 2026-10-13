/**
 * The certificate chain: AthenIQ issues it, Signara signs it, ONYX stores it.
 *
 * The local half of a lab certificate is `certificates.ts` — a completion record with a
 * code anybody can paste into `/verify`. That is enough for the deployment that issued it
 * and not enough for the family, because a credential is only worth what somebody outside
 * the issuing database will accept. So this is the other half: the sheet becomes a PDF,
 * Signara signs it with its own audit trail, and the signed artifact goes to ONYX, where
 * it outlives the attempt, the scenario and this container.
 *
 * WHY THIS DEPLOYMENT DRIVES IT. AthenIQ is the issuer of record — enrolment there is what
 * entitles a learner to this range, and its certificate bridge is what signs *course*
 * completions. A lab session is not a course completion: it is this product's grade of a
 * live machine, reported by the lab over `/api/v1/lab/completions`. Routing it through
 * AthenIQ's bridge would mean writing into another product's LMS tables to describe work
 * that product never saw. Instead the range submits the record straight to Signara and
 * stores the result itself, and `ONTRAK_CERT_ISSUER` keeps AthenIQ's name on the
 * credential it is entitled through.
 *
 * WHAT IT WILL NOT DO. It will not decide whether anybody passed. The completion is
 * written first, in its own transaction; this runs after it, and every outcome — signed,
 * signed-but-unstored, refused, misconfigured — is a value the caller records rather than
 * an exception that could fail a learner's result. A certificate that could not be signed
 * is an operator's problem; a completion that was rolled back because Signara was down is
 * a learner's. The two must not be the same failure.
 */

import { createHash, createHmac } from "node:crypto";

import {
  certificateObjectKey,
  chainConfigFromEnv,
  chainState,
  signaraDocumentTitle,
  signaraRequestMessage,
  signaraRequestPayload,
  type CertificateChainConfig,
  type CertificateSheet,
  type ChainOutcome,
} from "./certificate-chain-rules";
import { renderCertificateSheet } from "./certificate-sheet";

/** A response, narrowed to what this file reads — so a test can hand in a stub. */
export interface ChainResponse {
  status: number;
  json: () => Promise<unknown>;
  bytes: () => Promise<Uint8Array>;
}

export type ChainFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<ChainResponse>;

/** The real transport. `node:fetch` is the runtime's, so nothing is vendored for it. */
export const realChainFetch: ChainFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    // Wrapped in a Blob rather than handed over as bytes: a multipart upload of a PDF must
    // not be a string — the encoder would write UTF-8 over a Latin-1 file and corrupt it —
    // and a Blob is what this runtime's `fetch` types accept for a binary body. The cast
    // is the lib's `BlobPart` not admitting a `Uint8Array` whose buffer might be shared;
    // nothing here ever allocates one, and a `Blob` takes the view as-is.
    body: init.body ? new Blob([init.body as unknown as BlobPart]) : undefined,
    // A certificate is not a cache entry, and neither is a signature.
    cache: "no-store",
  });
  return {
    status: response.status,
    json: async () => {
      const text = await response.text();
      if (text.trim() === "") return {};
      try {
        return JSON.parse(text);
      } catch {
        return { error: text.slice(0, 300) };
      }
    },
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
  };
};

/* -------------------------------------------------------------------------- */
/*  Signara                                                                    */
/* -------------------------------------------------------------------------- */

/** `application/pdf` in a multipart body, by hand: `FormData` is not in every runtime this runs in. */
export function multipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; bytes: Uint8Array },
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
        `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The reason a Signara response carries, or its status when it carries none.
 *
 * A refused certificate is only useful if the operator is told *why*, so the provider's
 * own sentence is preferred over its status, and its status over nothing: Signara is a
 * NestJS service, and its refusals arrive as
 * `{ statusCode, error: "FORBIDDEN", message: ["No active tenant. Join or create an
 * organization to use this endpoint."] }` — where the sentence that says what to do is
 * in `message`, as an **array**, and `error` is only the HTTP word for it. Reading the
 * array first is the difference between a recorded reason somebody can act on and
 * "FORBIDDEN (403)", which is a reason to go and reproduce the call by hand.
 */
function reasonFrom(status: number, body: unknown): string {
  const record = asRecord(body);
  const listed = Array.isArray(record.message)
    ? record.message.filter((entry): entry is string => typeof entry === "string").join("; ")
    : "";
  const named = listed || textOf(record.message) || textOf(record.detail) || textOf(record.error);
  return named === "" ? `Signara answered ${status}` : `${named} (${status})`;
}

/* -------------------------------------------------------------------------- */
/*  ONYX — S3, signed by hand                                                  */
/* -------------------------------------------------------------------------- */

const sha256HexOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const hmac = (key: Uint8Array | string, value: string): Uint8Array =>
  createHmac("sha256", key).update(value, "utf8").digest();

/**
 * The SigV4 headers for one request, as the specification defines them.
 *
 * Implemented rather than imported because the SDK would be a large dependency in a
 * deploy path for two PUTs, and because SigV4 is a short, fully specified chain of
 * hashes: the test beside this file pins it against the specification's own example.
 * Payload hashing is on, and the payload is what is actually sent.
 */
export function sigv4Headers(input: {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  payload: Uint8Array;
  contentType?: string;
  /** Fixed clock, so the signature can be tested. */
  at?: Date;
}): Record<string, string> {
  const url = new URL(input.url);
  const at = input.at ?? new Date();
  const stamp = at.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8);

  const payloadHash = sha256HexOf(input.payload);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };
  if (input.contentType) headers["content-type"] = input.contentType;

  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signed.join(";");
  const canonicalRequest = [
    input.method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256HexOf(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, date), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** One object on ONYX, verbatim. */
export async function putOnyxObject(
  config: CertificateChainConfig,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  fetchImpl: ChainFetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (config.onyxEndpoint === null || config.onyxAccessKey === null || config.onyxSecretKey === null) {
    return { ok: false, reason: "ONYX is not configured" };
  }
  // Path-style: `/<bucket>/<key>` on the endpoint the operator named. The platform's own
  // store is reached at `http://<host>:2090` on the LAN, and a bucket in the path is what
  // that surface expects.
  const url = `${config.onyxEndpoint}/${config.onyxBucket}/${key}`;
  const headers = sigv4Headers({
    method: "PUT",
    url,
    region: process.env.ONTRAK_ONYX_S3_REGION ?? "us-east-1",
    service: "s3",
    accessKey: config.onyxAccessKey,
    secretKey: config.onyxSecretKey,
    payload: bytes,
    contentType,
  });

  try {
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "content-type": contentType, "content-length": String(bytes.length) },
      body: bytes,
    });
    if (response.status >= 300) {
      return { ok: false, reason: `ONYX answered ${response.status}` };
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/* -------------------------------------------------------------------------- */
/*  The chain                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run one certificate down the chain.
 *
 * Steps in the order the family's documentation names them (AthenIQ's
 * `docs/Integrations.md`, §Signara): upload the sheet as a document, create the signing
 * request with the deployment's signatory as the only signer, sign it with the token the
 * request carries, then keep the signed artifact and its provenance on ONYX.
 *
 * The provenance record is stored beside the PDF on purpose. A signed PDF proves what it
 * says; it does not say which request produced it or where the evidence lives, and the
 * two questions an auditor asks are exactly those.
 */
export async function submitCertificateToChain(
  sheet: CertificateSheet,
  options: { fetchImpl?: ChainFetch; config?: CertificateChainConfig } = {},
): Promise<ChainOutcome> {
  const config = options.config ?? chainConfigFromEnv();
  const state = chainState(config);
  if (state.kind === "off") return { kind: "off" };
  if (state.kind === "misconfigured") return { kind: "misconfigured", issues: state.issues };

  const fetchImpl = options.fetchImpl ?? realChainFetch;
  const base = config.signaraUrl as string;
  const apiKey = config.signaraKey as string;
  const signer = { name: config.signerName as string, email: config.signerEmail as string };
  const sheetBytes = renderCertificateSheet(sheet);
  const objectKey = certificateObjectKey(sheet);

  // 1. The document. Multipart, because a file is what Signara takes.
  const boundary = `----ontrak${sha256HexOf(sheetBytes).slice(0, 24)}`;
  const uploadBody = multipartBody(
    boundary,
    {
      title: signaraDocumentTitle(sheet),
      description: signaraRequestMessage(sheet),
      tags: "ontrak,training,certificate,lab",
    },
    { field: "file", filename: `${objectKey}.pdf`.replace(/\//g, "-"), contentType: "application/pdf", bytes: sheetBytes },
  );
  const uploaded = await fetchImpl(`${base}/api/v1/documents/upload`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "content-type": `multipart/form-data; boundary=${boundary}` },
    body: uploadBody,
  });
  const uploadDoc = await uploaded.json();
  if (uploaded.status >= 300) {
    return { kind: "refused", step: "upload", reason: reasonFrom(uploaded.status, uploadDoc) };
  }
  const documentId = textOf(asRecord(uploadDoc).id);
  if (documentId === "") {
    return { kind: "refused", step: "upload", reason: "Signara stored no document id" };
  }

  // 2. The signing request: the deployment's signatory, and nobody else.
  const requested = await fetchImpl(`${base}/api/v1/signatures/requests`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(signaraRequestPayload(documentId, sheet, signer))),
  });
  const requestBody = await requested.json();
  if (requested.status >= 300) {
    return { kind: "refused", step: "request", reason: reasonFrom(requested.status, requestBody) };
  }
  const requestId = textOf(asRecord(requestBody).id);
  let signerToken = textOf(asRecord((asRecord(requestBody).signers as unknown[])?.[0]).token);

  // The token is often minted at creation and sometimes only readable afterwards, which is
  // a difference the bridge this follows already accounts for.
  if (signerToken === "" && requestId !== "") {
    const refetched = await fetchImpl(`${base}/api/v1/signatures/requests/${requestId}`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
    });
    const again = await refetched.json();
    signerToken = textOf(asRecord((asRecord(again).signers as unknown[])?.[0]).token);
  }
  if (requestId === "" || signerToken === "") {
    return { kind: "refused", step: "request", reason: "Signara minted no signer token for the request" };
  }

  // 3. The signature.
  const signed = await fetchImpl(`${base}/api/v1/signatures/public/${signerToken}/sign`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ type: "TYPED", signatureData: signer.name })),
  });
  if (signed.status >= 300) {
    return { kind: "refused", step: "sign", reason: reasonFrom(signed.status, await signed.json()) };
  }

  // 4. ONYX. The signed document when Signara will hand it back, the sheet it signed when
  //    it will not: storing the wrong bytes is better than storing none, and the record
  //    below says which of the two this is.
  let artifact = sheetBytes;
  let artifactKind = "sheet";
  const downloaded = await fetchImpl(`${base}/api/v1/documents/${documentId}/download`, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });
  if (downloaded.status < 300) {
    const bytes = await downloaded.bytes();
    if (bytes.length > 0) {
      artifact = bytes;
      artifactKind = "signed";
    }
  }

  const record = new TextEncoder().encode(
    JSON.stringify(
      {
        format: "ontrak.certificate-chain/v1",
        issuer: config.issuer,
        certificate: sheet.code,
        learner: { name: sheet.learnerName },
        scenario: { title: sheet.scenarioTitle, platform: sheet.platform },
        outcome: { score: sheet.score, maxScore: sheet.maxScore, completedAt: sheet.completedAt },
        signara: {
          documentId,
          requestId,
          signer: { name: signer.name, email: signer.email },
          evidence: `${base}/api/v1/signatures/requests/${requestId}/evidence`,
        },
        onyx: { bucket: config.onyxBucket, artifact: `${objectKey}.pdf`, artifactKind },
        verifyUrl: sheet.verifyUrl,
      },
      null,
      2,
    ),
  );

  const stored = await putOnyxObject(config, `${objectKey}.pdf`, artifact, "application/pdf", fetchImpl);
  if (!stored.ok) {
    return { kind: "signed-unstored", documentId, requestId, reason: stored.reason };
  }
  const storedRecord = await putOnyxObject(config, `${objectKey}.json`, record, "application/json", fetchImpl);
  if (!storedRecord.ok) {
    return { kind: "signed-unstored", documentId, requestId, reason: storedRecord.reason };
  }

  return { kind: "signed", documentId, requestId, objectKey, pdfKey: `${objectKey}.pdf` };
}
