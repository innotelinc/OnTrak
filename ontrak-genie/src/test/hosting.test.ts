import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Publish & host.
 *
 * The two things that must not be wrong: the price the console quotes, and where
 * "buy" sends the buyer. Both are read from Magnate when it answers and fall back
 * to what the plan ships with when it does not, so this pins the fallback path —
 * a billing platform that is down must still leave publishing legible — and the
 * URL derivation that turns the entitlements endpoint into a signup link.
 */
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "hosting-test-"));
process.env.AGENT_WORKSPACE = path.join(scratch, "workspace");
process.env.AGENT_DATA_DIR = path.join(scratch, ".agent");
// An endpoint that will never answer, so the plan read takes its fallback path.
process.env.MAGNATE_ENTITLEMENTS_URL = "http://127.0.0.1:9/api/entitlements";
process.env.MAGNATE_GENIE_PLAN = "genie";

const { FALLBACK_PLAN, hostingInfo, hostingPlan, resetPlanCache, subscribeUrl } = await import(
  "../hosting.js"
);

test("the shipped price", async (t) => {
  await t.test("is $5/month and $50/year", () => {
    assert.equal(FALLBACK_PLAN.priceMonthlyCents, 500);
    assert.equal(FALLBACK_PLAN.priceYearlyCents, 5000);
  });

  await t.test("stands in when Magnate cannot be reached", async () => {
    resetPlanCache();
    const plan = await hostingPlan();
    assert.equal(plan.slug, "genie");
    assert.equal(plan.priceMonthlyCents, 500);
    assert.equal(plan.priceYearlyCents, 5000);
  });
});

test("where buying sends the buyer", async (t) => {
  await t.test("is Magnate's signup page for this plan", () => {
    assert.equal(subscribeUrl(), "http://127.0.0.1:9/signup?plan=genie");
  });

  await t.test("hosting info carries it, and the plan price", async () => {
    resetPlanCache();
    const info = await hostingInfo("");
    assert.equal(info.plan.priceMonthlyCents, 500);
    assert.equal(info.plan.priceYearlyCents, 5000);
    assert.match(info.subscribeUrl, /\/signup\?plan=genie$/);
    // Publishing is off unless an operator turns it on, and an off panel says so
    // rather than reporting an error.
    assert.equal(info.enabled, false);
    assert.deepEqual(info.previews, []);
  });
});
