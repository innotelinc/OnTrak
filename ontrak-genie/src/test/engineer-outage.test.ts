import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * An unreachable control plane: the console renders, a spend is refused.
 *
 * These are different questions and get different answers. Reading a balance is
 * something a page does on load, so an outage must not blank the page — the status
 * comes back ungated with the reason. Spending is a decision about somebody's
 * money, so it throws and the caller surfaces a retry, rather than silently
 * charging nobody and letting the work continue on an unrecorded project.
 *
 * The port is 9 (discard): nothing listens, and the connection is refused rather
 * than hanging, so the test proves failopen-vs-throw and not the timeout.
 *
 * Separate from `engineer.test.ts` because `config.ts` reads the environment once.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "engineer-outage-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
process.env.CONTROL_PLANE_INTERNAL_URL = "http://127.0.0.1:9";
process.env.CONTROL_INTERNAL_TOKEN = "internal-token-for-tests";

const { CreditError, chargeProject, creditStatusFor } = await import("../engineer.js");

test("a balance during an outage is ungated with a reason, so the page still renders", async () => {
  const status = await creditStatusFor("atheniq@innotel.us");
  assert.equal(status.gated, false);
  assert.equal(status.allowed, true);
  assert.match(status.reason, /could not reach the control plane/);
});

test("a spend during an outage throws, so the caller can retry it", async () => {
  await assert.rejects(chargeProject("atheniq@innotel.us", "proj-3"), (error: unknown) => {
    assert.equal(error instanceof CreditError, true);
    assert.match((error as Error).message, /could not reach the control plane/);
    return true;
  });
});
