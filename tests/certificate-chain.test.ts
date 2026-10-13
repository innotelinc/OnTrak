/**
 * The certificate chain: AthenIQ issues, Signara signs, ONYX stores.
 *
 * What is being protected here is a trust claim, so the tests are about the three ways it
 * can quietly become false:
 *
 *  - a half-configured chain that *runs* — a certificate that is neither local nor signed,
 *    which is why a partial configuration is `misconfigured` and this file pins that it
 *    never reaches the network;
 *  - a sheet that is not a PDF — the signature is over these bytes, so an unreadable file
 *    is a signature on nothing;
 *  - a signed certificate that was never stored — the outcome has to say so, because
 *    "signed" and "signed and kept" are different facts to an operator.
 *
 * The Signara flow is exercised against a stub transport that records every request, so
 * the multipart upload, the signing-request body and the signature call are pinned to the
 * shapes Signara's own API documents.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sigv4Headers, submitCertificateToChain, type ChainFetch } from "../src/lib/certificate-chain";
import {
  certificateObjectKey,
  chainConfigFromEnv,
  chainState,
  describeChainOutcome,
  signaraRequestPayload,
  type CertificateChainConfig,
  type CertificateSheet,
} from "../src/lib/certificate-chain-rules";
import { pdfLiteral, renderCertificateSheet } from "../src/lib/certificate-sheet";

const SHEET: CertificateSheet = {
  learnerName: "Ada Lovelace",
  scenarioTitle: "Broken NIC on a branch server",
  platform: "linux",
  score: 9,
  maxScore: 10,
  completedAt: "2026-10-05T09:20:00.000Z",
  code: "ONTRAK-1A2B-3C4D-5E6F",
  issuer: "AthenIQ",
  verifyUrl: "https://its.ontrak.innotel.us/verify",
  skills: ["networking", "systemd"],
};

const FULL: Record<string, string> = {
  ONTRAK_SIGNARA_API_URL: "https://api.signara.example/",
  ONTRAK_SIGNARA_API_KEY: "sgn_test",
  ONTRAK_CERT_SIGNER_NAME: "D. Hunter",
  ONTRAK_CERT_SIGNER_EMAIL: "dhunter@innotel.us",
  ONTRAK_ONYX_S3_ENDPOINT: "http://192.168.1.60:2090",
  ONTRAK_ONYX_S3_ACCESS_KEY: "access",
  ONTRAK_ONYX_S3_SECRET_KEY: "secret",
};

const config = (env: Record<string, string> = FULL): CertificateChainConfig => chainConfigFromEnv(env);

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

test("chain: a deployment that has configured nothing keeps the local record only", () => {
  const empty = config({});
  assert.deepEqual(chainState(empty), { kind: "off" });
  // The defaults are still usable facts — an issuer of record and a verification
  // address — because the local certificate prints both whether the chain runs or not.
  assert.equal(empty.issuer, "AthenIQ");
  assert.equal(empty.onyxBucket, "ontrak-certificates");
  assert.deepEqual(
    chainState(config({ ONTRAK_SIGNARA_API_KEY: "" })),
    chainState(empty),
    "a blank value is unset",
  );
});

test("chain: a half-configured chain is refused and names every variable it is missing", () => {
  const partial = config({ ONTRAK_SIGNARA_API_URL: "https://api.signara.example" });
  const state = chainState(partial);
  assert.equal(state.kind, "misconfigured");
  const issues = state.kind === "misconfigured" ? state.issues.join("\n") : "";
  for (const name of [
    "ONTRAK_SIGNARA_API_KEY",
    "ONTRAK_CERT_SIGNER_NAME",
    "ONTRAK_CERT_SIGNER_EMAIL",
    "ONTRAK_ONYX_S3_ENDPOINT",
    "ONTRAK_ONYX_S3_ACCESS_KEY",
    "ONTRAK_ONYX_S3_SECRET_KEY",
  ]) {
    assert.ok(issues.includes(name), `the refusal does not name ${name}`);
  }
  // The variable that *is* set must not be reported as missing.
  assert.ok(!issues.includes("ONTRAK_SIGNARA_API_URL"), "a variable that is set was reported missing");
});

test("chain: all three legs named is the only state that runs", () => {
  assert.deepEqual(chainState(config()), { kind: "on" });
});

test("chain: the artifact's key is derivable from the printed sheet alone", () => {
  assert.equal(certificateObjectKey(SHEET), "certificates/2026/ontrak-1a2b-3c4d-5e6f");
  // A date the parser cannot read must not produce a key with a slash in a segment.
  assert.equal(
    certificateObjectKey({ code: "ONTRAK-0001", completedAt: "" }),
    "certificates/0000/ontrak-0001",
  );
});

test("chain: the signing request carries the deployment's signatory and nobody else", () => {
  const payload = signaraRequestPayload("doc-1", SHEET, { name: "D. Hunter", email: "dhunter@innotel.us" });
  assert.equal(payload.documentId, "doc-1");
  assert.equal(payload.mode, "SEQUENTIAL");
  // The learner is not a signer: the platform attests to the result.
  assert.equal(payload.sendInvites, false);
  const signers = payload.signers as { email: string; role: string; orderIndex: number }[];
  assert.equal(signers.length, 1);
  assert.equal(signers[0]!.role, "SIGNER");
  assert.ok(String(payload.message).includes("AthenIQ"), "the request does not say who issued it");
  assert.ok(String(payload.title).includes("Ada Lovelace"));
});

/* -------------------------------------------------------------------------- */
/*  The sheet                                                                 */
/* -------------------------------------------------------------------------- */

test("sheet: the bytes are a one-page PDF a reader can open", () => {
  const bytes = renderCertificateSheet(SHEET);
  const text = new TextDecoder("latin1").decode(bytes);

  assert.ok(text.startsWith("%PDF-1.4"), "the file is not a PDF");
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.ok(text.includes("/Type /Catalog") && text.includes("/Type /Page"), "the catalogue or the page is missing");
  assert.ok(text.includes("/MediaBox [0 0 792 612]"), "the page is not letter landscape");
  assert.ok(text.includes("startxref"), "there is no cross-reference pointer");

  // The offsets in the xref table are what a reader follows, so they have to point at
  // the objects they claim to. This is the one part of the format that is not cosmetic.
  const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1] ?? "-1");
  assert.ok(text.slice(startxref, startxref + 4) === "xref", `startxref points at ${startxref}, not the table`);
  const rows = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n /gm)].map((match) => Number(match[1]));
  assert.equal(rows.length, 6, "there are not six objects");
  for (const [index, offset] of rows.entries()) {
    assert.ok(
      text.slice(offset).startsWith(`${index + 1} 0 obj`),
      `object ${index + 1} is not at its own offset`,
    );
  }
});

test("sheet: it says who issued it, who it is for, and how to check it", () => {
  const text = new TextDecoder("latin1").decode(renderCertificateSheet(SHEET));
  for (const phrase of [
    "ATHENIQ",
    "CERTIFICATE OF COMPLETION",
    "Ada Lovelace",
    "Broken NIC on a branch server",
    "9 of 10 points",
    "90%",
    "October 5, 2026",
    "ONTRAK-1A2B-3C4D-5E6F",
    "https://its.ontrak.innotel.us/verify",
    "signed through Signara",
    "stored on ONYX",
  ]) {
    assert.ok(text.includes(phrase), `the sheet does not print ${phrase}`);
  }
});

test("sheet: a name cannot break the file it is written into", () => {
  assert.equal(pdfLiteral("Ada (Lovelace) \\ the 2nd"), "Ada \\(Lovelace\\) \\\\ the 2nd");
  // Accented letters survive as WinAnsi bytes; anything outside that set is dropped
  // rather than allowed to encode into a dictionary's delimiters.
  assert.equal(pdfLiteral("José"), "Jos\\351");
  assert.equal(pdfLiteral("Ada 🚀 Lovelace"), "Ada ? Lovelace");
  assert.equal(pdfLiteral("line\nbreak"), "line break");
});

/* -------------------------------------------------------------------------- */
/*  The chain, against a stub transport                                       */
/* -------------------------------------------------------------------------- */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/** A transport that answers the three Signara calls and the two ONYX PUTs. */
function stub(options: { failAt?: "upload" | "request" | "sign"; onyxStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl: ChainFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const json = (status: number, body: unknown) => ({
      status,
      json: async () => body,
      bytes: async () => new Uint8Array(),
    });

    if (url.endsWith("/api/v1/documents/upload")) {
      if (options.failAt === "upload") return json(403, { message: "Invalid API key" });
      return json(201, { id: "doc-123" });
    }
    if (url.endsWith("/api/v1/signatures/requests")) {
      if (options.failAt === "request") return json(422, { detail: "no signers" });
      return json(201, { id: "req-456", signers: [{ token: "sgn_tok" }] });
    }
    if (url.includes("/signatures/public/")) {
      if (options.failAt === "sign") return json(409, { error: "already signed" });
      return json(200, { ok: true });
    }
    if (url.includes("/api/v1/documents/doc-123/download")) {
      return { status: 200, json: async () => ({}), bytes: async () => new TextEncoder().encode("%PDF-1.4 signed") };
    }
    if (init.method === "PUT") {
      const status = options.onyxStatus ?? 200;
      return json(status, status >= 300 ? { error: "denied" } : {});
    }
    return json(404, {});
  };
  return { calls, fetchImpl };
}

test("chain: a certificate is uploaded, requested, signed, and stored twice", async () => {
  const { calls, fetchImpl } = stub();
  const outcome = await submitCertificateToChain(SHEET, { fetchImpl, config: config() });

  assert.deepEqual(outcome, {
    kind: "signed",
    documentId: "doc-123",
    requestId: "req-456",
    objectKey: "certificates/2026/ontrak-1a2b-3c4d-5e6f",
    pdfKey: "certificates/2026/ontrak-1a2b-3c4d-5e6f.pdf",
  });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    [
      "POST /api/v1/documents/upload",
      "POST /api/v1/signatures/requests",
      "POST /api/v1/signatures/public/sgn_tok/sign",
      "GET /api/v1/documents/doc-123/download",
      "PUT /ontrak-certificates/certificates/2026/ontrak-1a2b-3c4d-5e6f.pdf",
      "PUT /ontrak-certificates/certificates/2026/ontrak-1a2b-3c4d-5e6f.json",
    ],
  );

  // Every Signara call is a machine call, authenticated as one.
  for (const call of calls.filter((entry) => entry.url.includes("signara"))) {
    assert.equal(call.headers["X-API-Key"], "sgn_test", `${call.url} is not authenticated`);
  }

  // The upload is a real multipart body carrying the PDF.
  const upload = calls[0]!;
  assert.match(upload.headers["content-type"]!, /^multipart\/form-data; boundary=----ontrak/);
  const uploaded = new TextDecoder("latin1").decode(upload.body!);
  assert.ok(uploaded.includes('name="file"; filename="certificates-2026-ontrak-1a2b-3c4d-5e6f.pdf"'));
  assert.ok(uploaded.includes("application/pdf"));
  assert.ok(uploaded.includes("%PDF-1.4"), "the multipart body does not carry the sheet");
  assert.ok(uploaded.includes('name="title"'), "the document has no title");
  assert.ok(uploaded.includes("AthenIQ"), "the description does not name the issuer");

  // The signing request is the JSON Signara documents.
  const request = JSON.parse(new TextDecoder().decode(calls[1]!.body!)) as Record<string, unknown>;
  assert.equal(request.documentId, "doc-123");
  assert.equal(calls[1]!.headers["content-type"], "application/json");
  assert.deepEqual(new TextDecoder().decode(calls[2]!.body!), '{"type":"TYPED","signatureData":"D. Hunter"}');

  // ONYX is authenticated as a SigV4 client, with the payload hashed.
  for (const call of calls.filter((entry) => entry.method === "PUT")) {
    assert.match(call.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=access\/\d{8}\/us-east-1\/s3\/aws4_request/);
    assert.ok(call.headers["x-amz-content-sha256"]!.length === 64);
    assert.ok(call.headers["content-type"]!.includes("application/"));
  }

  // The stored artifact is what Signara handed back, and the record beside it is the
  // provenance an auditor asks for.
  const artifact = new TextDecoder().decode(calls[4]!.body!);
  assert.equal(artifact, "%PDF-1.4 signed");
  const provenance = JSON.parse(new TextDecoder().decode(calls[5]!.body!)) as Record<string, unknown>;
  assert.equal(provenance.format, "ontrak.certificate-chain/v1");
  assert.equal(provenance.issuer, "AthenIQ");
  assert.equal(provenance.certificate, SHEET.code);
  assert.deepEqual(provenance.onyx, {
    bucket: "ontrak-certificates",
    artifact: "certificates/2026/ontrak-1a2b-3c4d-5e6f.pdf",
    artifactKind: "signed",
  });
  assert.equal(
    (provenance.signara as { evidence: string }).evidence,
    "https://api.signara.example/api/v1/signatures/requests/req-456/evidence",
  );
});

test("chain: a refusal names the step that refused, and never reaches ONYX", async () => {
  for (const [failAt, step] of [
    ["upload", "upload"],
    ["request", "request"],
    ["sign", "sign"],
  ] as const) {
    const { calls, fetchImpl } = stub({ failAt });
    const outcome = await submitCertificateToChain(SHEET, { fetchImpl, config: config() });
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.kind === "refused" ? outcome.step : "", step);
    assert.ok(
      !calls.some((call) => call.method === "PUT"),
      `a refusal at ${failAt} still wrote to ONYX`,
    );
    // The reason is the provider's own words, not a bare status.
    assert.ok(outcome.kind === "refused" && outcome.reason.length > 0);
  }
});

test("chain: a signed certificate ONYX refuses is reported as unstored, not as signed", async () => {
  const { fetchImpl } = stub({ onyxStatus: 403 });
  const outcome = await submitCertificateToChain(SHEET, { fetchImpl, config: config() });
  assert.equal(outcome.kind, "signed-unstored");
  assert.equal(outcome.kind === "signed-unstored" ? outcome.requestId : "", "req-456");
  assert.match(outcome.kind === "signed-unstored" ? outcome.reason : "", /ONYX answered 403/);
  assert.match(describeChainOutcome(outcome), /not stored on ONYX/);
});

test("chain: a misconfigured chain reaches nothing at all", async () => {
  const { calls, fetchImpl } = stub();
  const outcome = await submitCertificateToChain(SHEET, {
    fetchImpl,
    config: config({ ONTRAK_SIGNARA_API_URL: "https://api.signara.example" }),
  });
  assert.equal(outcome.kind, "misconfigured");
  assert.equal(calls.length, 0, "a half-configured chain called out anyway");
  assert.match(describeChainOutcome(outcome), /ONTRAK_SIGNARA_API_KEY/);
});

test("chain: an unconfigured deployment does no work and reports none", async () => {
  const { calls, fetchImpl } = stub();
  const outcome = await submitCertificateToChain(SHEET, { fetchImpl, config: config({}) });
  assert.deepEqual(outcome, { kind: "off" });
  assert.equal(calls.length, 0);
  assert.match(describeChainOutcome(outcome), /stands locally only/);
});

/* -------------------------------------------------------------------------- */
/*  The signature itself                                                      */
/* -------------------------------------------------------------------------- */

test("sigv4: the signature is deterministic for a fixed clock, and moves with the payload", () => {
  const at = new Date("2026-10-13T06:00:00.000Z");
  const sign = (payload: string, secretKey = "secret") =>
    sigv4Headers({
      method: "PUT",
      url: "http://192.168.1.60:2090/ontrak-certificates/certificates/2026/ontrak-1a2b.pdf",
      region: "us-east-1",
      service: "s3",
      accessKey: "access",
      secretKey,
      payload: new TextEncoder().encode(payload),
      contentType: "application/pdf",
      at,
    });

  const first = sign("a signed certificate");
  // Every header the specification requires is present, and the signed-header list is
  // sorted and complete — a header sent but not signed is a header an attacker owns.
  assert.equal(first.host, "192.168.1.60:2090");
  assert.equal(first["x-amz-date"], "20261013T060000Z");
  assert.equal(
    first.authorization!.split("SignedHeaders=")[1]!.split(",")[0],
    "content-type;host;x-amz-content-sha256;x-amz-date",
  );

  // Same request, same signature; different payload, different signature. This is the
  // property the whole scheme rests on, and the one a refactor breaks silently.
  assert.deepEqual(sign("a signed certificate"), first);
  assert.notEqual(sign("a different certificate").authorization, first.authorization);
  assert.notEqual(sign("a signed certificate", "another-secret").authorization, first.authorization);
});
