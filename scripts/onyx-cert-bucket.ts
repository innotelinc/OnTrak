/**
 * Create the certificate bucket on ONYX, with this repository's own SigV4 code.
 *
 * `PUT /<bucket>` is the one step of the chain nothing else can do for itself: the chain
 * assumes the bucket exists, and an upload into a bucket that does not is a refusal an
 * operator reads as a bad credential. So this is the bootstrap, run once per ONYX, by
 * somebody who holds the ONYX key — and it signs with **the same code the chain uses**
 * (`sigv4Headers` in `certificate-chain.ts`), so a bucket that appears here is proof the
 * store accepts this implementation before a single certificate depends on it.
 *
 * Idempotent: a second `PUT` of the same bucket is answered by the store as an existing
 * bucket, and the run reports that rather than treating it as a failure.
 *
 *   npm run certs:bucket
 *
 * It reads the same `ONTRAK_ONYX_S3_*` settings as the deployment (see `.env.example`),
 * and refuses with the missing names rather than with a store's 403.
 */

import { chainConfigFromEnv, chainState } from "../src/lib/certificate-chain-rules";
import { sigv4Headers } from "../src/lib/certificate-chain";

async function main(): Promise<void> {
  const config = chainConfigFromEnv();
  const state = chainState(config);
  console.log("chain state:", state.kind, state.kind === "misconfigured" ? state.issues.join("; ") : "");

  if (config.onyxEndpoint === null || config.onyxAccessKey === null || config.onyxSecretKey === null) {
    throw new Error("ONYX is not configured");
  }

  const region = process.env.ONTRAK_ONYX_S3_REGION ?? "us-east-1";
  const bucketUrl = `${config.onyxEndpoint}/${config.onyxBucket}`;
  const empty = new Uint8Array();
  const sign = (method: string, url: string) =>
    sigv4Headers({
      method,
      url,
      region,
      service: "s3",
      accessKey: config.onyxAccessKey as string,
      secretKey: config.onyxSecretKey as string,
      payload: empty,
    });

  const put = async () => {
    const response = await fetch(bucketUrl, { method: "PUT", headers: { ...sign("PUT", bucketUrl), "content-length": "0" } });
    return { status: response.status, body: await response.text() };
  };

  // The second PUT is the *check*: a store that accepts this signature answers an existing
  // bucket with its own error rather than creating a second one, which is what makes this
  // safe to run again after the fact. It is also why the exit code matters — a bootstrap
  // that prints a red badge and exits 0 cannot be used by a script.
  const created = await put();
  const existing = created.status === 409 || created.body.includes("BucketAlreadyExists");
  if (created.status === 200 || created.status === 201) {
    console.log(`+ created   ${bucketUrl}`);
  } else if (existing) {
    console.log(`= already there  ${bucketUrl}`);
  } else {
    console.error(`! ONYX refused the bucket (HTTP ${created.status}): ${created.body.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const again = await put();
  console.log(`  second PUT -> ${again.status}${again.status === 409 || again.body.includes("BucketAlreadyExists") ? " (already there)" : ""}`);

  // And the store can be read back — the same credential, the other method.
  const root = `${config.onyxEndpoint}/`;
  const listed = await fetch(root, { method: "GET", headers: sign("GET", root) });
  const body = await listed.text();
  const seen = body.includes(config.onyxBucket);
  console.log(`  GET / -> ${listed.status}, lists ${config.onyxBucket}: ${seen ? "yes" : "no"}`);
  if (!seen) {
    console.error("! the bucket is not listed, so the chain would fail at its last step");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
