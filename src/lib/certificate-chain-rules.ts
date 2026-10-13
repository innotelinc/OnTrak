/**
 * The rules of the certificate chain, as pure functions.
 *
 * A lab certificate is not finished when the completion record is stored. The family's
 * trust chain says what happens to it next, and the three legs are three different
 * systems: **AthenIQ issues** it (the learning platform whose enrolment granted the
 * range), **Signara signs** it (the stack's only document-signing surface), and **ONYX
 * stores** the signed artifact (the stack's only object storage). This deployment drives
 * that chain itself — see `certificate-chain.ts` for the network half — and this file is
 * everything about it that can be decided from arguments: what the environment says, what
 * the chain is allowed to do, what the sheet says, and what the signing request looks
 * like.
 *
 * Being configured is not the same as being usable, and the difference is the whole
 * reason `chainState` exists. A deployment that has set a Signara URL and no API key has
 * not configured the chain: it has configured half of it, and a chain that runs half-way
 * produces a certificate that is neither local nor signed. So a partial configuration is
 * `misconfigured` — with the environment variables named — rather than `on`, and the
 * completion path refuses to start the chain rather than starting it to fail an upload.
 *
 * The chain is deliberately off by default. A deployment that has not asked for it keeps
 * exactly the behaviour it had: the completion record, the code a learner can paste into
 * `/verify`, and nothing else. Turning it on is an operator naming three systems.
 */

/** The signer of record, and where each leg lives. Everything here comes from the environment. */
export interface CertificateChainConfig {
  /** Signara's API base, e.g. `https://api.signara.innotel.us`. */
  signaraUrl: string | null;
  /** Signara's machine key — `X-API-Key`, created in its portal as an API key. */
  signaraKey: string | null;
  /** Who signs, as the signing request names them. A person, not the product. */
  signerName: string | null;
  signerEmail: string | null;
  /** ONYX's S3 surface: endpoint, the pair's own key, and the bucket certificates live in. */
  onyxEndpoint: string | null;
  onyxAccessKey: string | null;
  onyxSecretKey: string | null;
  onyxBucket: string;
  /**
   * Who *issued* the certificate.
   *
   * `AthenIQ`, by default and by design: OnTrak owns the range, but the entitlement and
   * the credential are the learning platform's. The issuer is printed on the sheet and
   * recorded with the chain's outcome, so a certificate that leaks out of this
   * deployment still says whose it is.
   */
  issuer: string;
  /** Where a verifier is sent, so the sheet carries the way to check itself. */
  verifyUrl: string;
}

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim().replace(/^["']|["']$/g, "");
  return trimmed === "" ? null : trimmed;
};

export function chainConfigFromEnv(env: Record<string, string | undefined> = process.env): CertificateChainConfig {
  return {
    signaraUrl: clean(env.ONTRAK_SIGNARA_API_URL)?.replace(/\/+$/, "") ?? null,
    signaraKey: clean(env.ONTRAK_SIGNARA_API_KEY),
    signerName: clean(env.ONTRAK_CERT_SIGNER_NAME),
    signerEmail: clean(env.ONTRAK_CERT_SIGNER_EMAIL),
    onyxEndpoint: clean(env.ONTRAK_ONYX_S3_ENDPOINT)?.replace(/\/+$/, "") ?? null,
    onyxAccessKey: clean(env.ONTRAK_ONYX_S3_ACCESS_KEY),
    onyxSecretKey: clean(env.ONTRAK_ONYX_S3_SECRET_KEY),
    onyxBucket: clean(env.ONTRAK_ONYX_S3_BUCKET) ?? "ontrak-certificates",
    issuer: clean(env.ONTRAK_CERT_ISSUER) ?? "AthenIQ",
    verifyUrl: clean(env.ONTRAK_TRAINING_VERIFY_URL) ?? "https://its.ontrak.innotel.us/verify",
  };
}

/**
 * What the chain may do here, read from the configuration.
 *
 *  - `off`       nothing is set, and the deployment keeps the local record only.
 *  - `on`        all three legs are named; the chain runs.
 *  - `misconfigured`  some of it is set. The `issues` name the variables that are
 *                missing, because "the certificate was not signed" without that is a
 *                support ticket rather than a fix.
 */
export type ChainState =
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "misconfigured"; issues: string[] };

export function chainState(config: CertificateChainConfig): ChainState {
  const set = {
    signaraUrl: config.signaraUrl !== null,
    signaraKey: config.signaraKey !== null,
    signerName: config.signerName !== null,
    signerEmail: config.signerEmail !== null,
    onyxEndpoint: config.onyxEndpoint !== null,
    onyxAccessKey: config.onyxAccessKey !== null,
    onyxSecretKey: config.onyxSecretKey !== null,
  };

  // Nothing at all is set — the ordinary case for a deployment that has not adopted the
  // chain. Not an error, and not worth a warning on every completion.
  if (Object.values(set).every((value) => !value)) return { kind: "off" };

  const issues: string[] = [];
  const want = (present: boolean, name: string, why: string) => {
    if (!present) issues.push(`${name} is not set, so ${why}`);
  };
  want(set.signaraUrl, "ONTRAK_SIGNARA_API_URL", "there is nowhere to send the certificate to be signed");
  want(set.signaraKey, "ONTRAK_SIGNARA_API_KEY", "Signara would answer the upload as a stranger");
  want(set.signerName, "ONTRAK_CERT_SIGNER_NAME", "the signing request would have nobody to sign it");
  want(set.signerEmail, "ONTRAK_CERT_SIGNER_EMAIL", "the signing request would have nobody to sign it");
  want(set.onyxEndpoint, "ONTRAK_ONYX_S3_ENDPOINT", "a signed certificate would have nowhere to live");
  want(set.onyxAccessKey, "ONTRAK_ONYX_S3_ACCESS_KEY", "ONYX would refuse the upload");
  want(set.onyxSecretKey, "ONTRAK_ONYX_S3_SECRET_KEY", "ONYX would refuse the upload");

  return issues.length > 0 ? { kind: "misconfigured", issues } : { kind: "on" };
}

/* -------------------------------------------------------------------------- */
/*  The sheet                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the sheet prints, and everything the chain records about it. */
export interface CertificateSheet {
  learnerName: string;
  /** The scenario's own title — the work, not the course. */
  scenarioTitle: string;
  platform: string;
  score: number;
  maxScore: number;
  /** ISO-8601 UTC, as the completion record carries it. */
  completedAt: string;
  /** The code the learner holds, e.g. `ONTRAK-XXXX-XXXX-XXXX`. */
  code: string;
  issuer: string;
  verifyUrl: string;
  skills: readonly string[];
}

/** A percentage, rounded the way the report screen rounds it. */
export function sheetPercent(sheet: Pick<CertificateSheet, "score" | "maxScore">): number {
  if (sheet.maxScore <= 0) return 0;
  return Math.round((sheet.score / sheet.maxScore) * 100);
}

/**
 * Where the artifact lives in ONYX.
 *
 * `certificates/<year>/<code>.pdf`, with the code lower-cased and stripped to what an S3
 * key can hold. The code rather than the attempt id, because the code is the thing a
 * human has in hand: an operator asked to find a certificate straight from a printed
 * sheet can construct the key without the database.
 */
export function certificateObjectKey(sheet: Pick<CertificateSheet, "code" | "completedAt">): string {
  const year = (sheet.completedAt || "").slice(0, 4) || "0000";
  const code = sheet.code.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `certificates/${year}/${code}`;
}

/** The Signara document's title, and the sentence its signing request carries. */
export function signaraDocumentTitle(sheet: CertificateSheet): string {
  return `${sheet.scenarioTitle} — Certificate of Completion (${sheet.learnerName})`;
}

export function signaraRequestMessage(sheet: CertificateSheet): string {
  return (
    `A lab-graded completion certificate issued by ${sheet.issuer}: ` +
    `${sheet.learnerName} completed "${sheet.scenarioTitle}" on ${sheet.platform} ` +
    `with ${sheet.score}/${sheet.maxScore} (${sheetPercent(sheet)}%).`
  );
}

/** The signing-request body Signara's API takes, as documented in its `docs/API.md`. */
export function signaraRequestPayload(
  documentId: string,
  sheet: CertificateSheet,
  signer: { name: string; email: string },
): Record<string, unknown> {
  return {
    documentId,
    title: signaraDocumentTitle(sheet),
    message: signaraRequestMessage(sheet),
    mode: "SEQUENTIAL",
    // The signer is the deployment's own signatory, not the learner: this is the
    // platform attesting to a result, and sending the learner an invitation to sign
    // their own certificate would be the wrong ceremony entirely.
    sendInvites: false,
    signers: [{ email: signer.email, name: signer.name, role: "SIGNER", orderIndex: 0 }],
  };
}

/* -------------------------------------------------------------------------- */
/*  The outcome                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What happened to a certificate on its way down the chain.
 *
 * Recorded rather than thrown, because every one of these is a fact an operator needs:
 * a certificate signed and stored is evidence, a certificate signed but not stored is an
 * ONYX credential to fix, and a certificate the chain refused is a Signara key. The
 * completion itself has already been written by the time any of this runs — the chain
 * never decides whether a learner passed.
 */
export type ChainOutcome =
  | { kind: "off" }
  | { kind: "misconfigured"; issues: string[] }
  /** Signara signed it and the artifact is on ONYX. */
  | { kind: "signed"; documentId: string; requestId: string; objectKey: string; pdfKey: string }
  /** Signed, but the artifact could not be stored — named so somebody can finish the job. */
  | { kind: "signed-unstored"; documentId: string; requestId: string; reason: string }
  /** Refused, with the reason from whichever leg said no. */
  | { kind: "refused"; step: "upload" | "request" | "sign"; reason: string };

/** One line for the audit log, and for the operator reading it. */
export function describeChainOutcome(outcome: ChainOutcome): string {
  switch (outcome.kind) {
    case "off":
      return "The certificate chain is off, so the certificate stands locally only.";
    case "misconfigured":
      return `The certificate chain is misconfigured: ${outcome.issues.join("; ")}.`;
    case "signed":
      return `Signed by Signara (request ${outcome.requestId}) and stored on ONYX at ${outcome.objectKey}.`;
    case "signed-unstored":
      return `Signed by Signara (request ${outcome.requestId}) but not stored on ONYX: ${outcome.reason}`;
    case "refused":
      return `The certificate chain refused at the ${outcome.step} step: ${outcome.reason}`;
  }
}
