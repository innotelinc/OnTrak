/**
 * The lab capability's facts, as the student page reads them.
 *
 * The lab runs real machines on a host this deployment may not have, so the thing
 * these tests pin down is *restraint*: an unconfigured deployment offers nothing, a
 * half-configured one is told so instead of handed a dead link, and a scenario that
 * never claimed to be a lab is never sent to one. The one way this goes wrong that
 * matters most is a link that looks configured and goes nowhere — the same failure
 * the tile table was built to avoid.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAB_DASHBOARD_PATH,
  LAB_SCENARIO_TAG,
  isLabScenario,
  labConfigFromEnv,
  labSessionUrl,
} from "../src/lib/lab-rules";

test("lab: off unless an operator turns it on", () => {
  const off = labConfigFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(off.url, null);
  assert.equal(labSessionUrl(off), null, "an unconfigured deployment offers nothing");

  // Setting only the address does not enable it: enabling is a decision, not a side
  // effect of knowing where the lab is.
  const addressOnly = labConfigFromEnv({ ONTRAK_LAB_URL: "https://lab.ontrak.innotel.us" });
  assert.equal(addressOnly.enabled, false);
  assert.equal(labSessionUrl(addressOnly), null);
});

test("lab: an enabled, located lab yields its dashboard", () => {
  const config = labConfigFromEnv({
    ONTRAK_LAB_ENABLED: "true",
    ONTRAK_LAB_URL: "https://lab.ontrak.innotel.us",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.url, "https://lab.ontrak.innotel.us");
  assert.deepEqual(config.issues, []);
  assert.equal(labSessionUrl(config), `https://lab.ontrak.innotel.us${LAB_DASHBOARD_PATH}`);
});

test("lab: a quoted value and a trailing slash are normalised to one origin", () => {
  const config = labConfigFromEnv({
    ONTRAK_LAB_ENABLED: "on",
    ONTRAK_LAB_URL: '"https://lab.example.test/"',
  });
  assert.equal(config.url, "https://lab.example.test");
  assert.equal(labSessionUrl(config), "https://lab.example.test/dashboard", "no doubled segment");
});

test("lab: enabled with nowhere to go is an issue, never a dead link", () => {
  const noUrl = labConfigFromEnv({ ONTRAK_LAB_ENABLED: "1" });
  assert.equal(noUrl.url, null);
  assert.equal(labSessionUrl(noUrl), null);
  assert.ok(noUrl.issues.length > 0, "the operator is told why, not left with a broken tile");

  const relative = labConfigFromEnv({ ONTRAK_LAB_ENABLED: "yes", ONTRAK_LAB_URL: "lab.example.test" });
  assert.equal(relative.url, null);
  assert.match(relative.issues[0], /not an absolute URL/);

  const wrongScheme = labConfigFromEnv({ ONTRAK_LAB_ENABLED: "true", ONTRAK_LAB_URL: "ftp://lab.test" });
  assert.equal(wrongScheme.url, null);
  assert.match(wrongScheme.issues[0], /not an http\(s\) URL/);
});

test("lab: a scenario runs on a real machine only when it is tagged, exactly", () => {
  assert.equal(LAB_SCENARIO_TAG, "lab");
  assert.equal(isLabScenario(["lab"]), true);
  assert.equal(isLabScenario(["linux", "Lab"]), true, "the tag is matched case-insensitively");
  assert.equal(isLabScenario(["  lab  "]), true, "and trimmed");
  assert.equal(isLabScenario([]), false);
  assert.equal(isLabScenario(null), false);
  assert.equal(isLabScenario(undefined), false);
  // Never a substring: `cyber-lab` is not the lab, and promoting it would send a
  // student to a hypervisor the scenario was never written for.
  assert.equal(isLabScenario(["cyber-lab"]), false);
  assert.equal(isLabScenario(["laboratory", "windows"]), false);
});

test("lab: the simulation path is unchanged for a scenario that does not claim the lab", () => {
  // The page asks both questions independently: the lab link is drawn from the tag,
  // and the simulated start is drawn for every scenario regardless.
  const config = labConfigFromEnv({ ONTRAK_LAB_ENABLED: "true", ONTRAK_LAB_URL: "https://lab.test" });
  assert.equal(isLabScenario(["linux", "basics"]), false, "no lab affordance for a simulated scenario");
  assert.equal(isLabScenario(["lab"]), true);
  // And the lab URL exists only when the deployment turned it on.
  assert.equal(labSessionUrl(config), "https://lab.test/dashboard");
});
