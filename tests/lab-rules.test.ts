/**
 * The lab capability's facts, as the student page reads them.
 *
 * The lab runs real machines on a host this deployment may not have, so the thing
 * these tests pin down is *restraint*: an unconfigured deployment offers nothing, a
 * half-configured one is told so instead of handed a dead link, and a scenario that
 * never claimed to be a lab is never sent to one. The one way this goes wrong that
 * matters most is a link that looks configured and goes nowhere — the same failure
 * the tile table was built to avoid.
 *
 * The file also holds *who may read* the lab's two variables, because restraint is not a
 * property of one file: the control room's capabilities panel read `ONTRAK_LAB_URL` itself
 * and offered `lab.<base domain>` as the lab's address in every deployment, which is a
 * link to a product nobody had deployed, while this reader said the lab was off. Two
 * files, two answers, and the panel's own comment forbids exactly that for Sentinel. So
 * the readers are a list (`LAB_READERS`), the list is checked against the tree, and a
 * third one has to say why it is not a second copy of the rule.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  LAB_DASHBOARD_PATH,
  LAB_IN_APP_PATH,
  LAB_SCENARIO_TAG,
  isLabScenario,
  simulatedStartRefusal,
  labConfigFromEnv,
  labDoor,
  labDoorFromEnv,
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

/*
 * ── who may read the lab's two facts ───────────────────────────────────────
 *
 * The lab is a peer deployment, so "does this deployment want a lab" and "where is it"
 * are two facts that have to mean the same thing in every product that asks — and the
 * way that stops being true is a second reader. There was one: the control room's
 * capabilities panel read `ONTRAK_LAB_URL` itself and offered `lab.<base domain>` as the
 * lab's address in any deployment, which is a link to a product nobody had deployed, and
 * it is the drift the panel's own comment forbids for Sentinel ("adding it here would be
 * a second reader of the same variable, and the two would drift"). The portal is a
 * second reader by necessity — it is independently deployable and cannot import
 * `src/lib/lab-rules.ts` — so the rule is not "one file", it is "one reader per package,
 * and this list says which".
 */

/** The files that own the lab's variables: the training app's reader, and the portal's. */
const LAB_READERS = ["src/lib/lab-rules.ts", "ontrak-portal/src/lib/config.ts"];

/** What a line says when it names the lab's variables without deciding what they mean. */
const EXEMPT = "lab-rule-exempt:";

/** The two facts. Naming either outside a reader is how a second reader begins. */
const SIGNS = [/ONTRAK_LAB_ENABLED/, /ONTRAK_LAB_URL/, /ONTRAK_LAB_IN_APP/];

/** Directories that are not application source, or are another tree's business. */
const NOT_SOURCE = new Set([
  "node_modules", ".git", ".next", "dist", "tests", "__pycache__", ".venv",
]);

/** Every `.ts`/`.tsx`/`.mjs`/`.js`/`.py` under a directory, minus the trees above. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return NOT_SOURCE.has(entry.name) ? [] : sourceFiles(path.join(dir, entry.name));
    }
    return /\.(tsx?|mjs|js|py)$/.test(entry.name) ? [path.join(dir, entry.name)] : [];
  });
}

/** Prose about the variables is not a read of them. Both languages' comment markers. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") ||
    trimmed.startsWith("#");
}

/** Each line that names one of the lab's variables, as `path:line: source`. */
function namingLinesIn(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      isComment(line) || !SIGNS.some((sign) => sign.test(line))
        ? []
        : [`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`],
    );
}

test("lab: the walk reads the tree it claims to guard", () => {
  // A walk that silently found nothing would pass the check below by defining it away, so
  // it has to prove it saw the source *and* both readers in it.
  const files = sourceFiles(process.cwd());
  assert.ok(files.length >= 400, `the walk found only ${files.length} source files`);

  for (const reader of LAB_READERS) {
    const full = path.join(process.cwd(), reader);
    assert.ok(files.includes(full), `the walk must include ${reader}, which owns the rule`);
    assert.ok(
      namingLinesIn(full).length > 0,
      `${reader} no longer names the lab's variables, so this guard would pass by finding nothing`,
    );
  }
});

test("lab: no package reads the lab's variables outside its own reader", () => {
  const readers = LAB_READERS.map((file) => path.join(process.cwd(), file));
  const offenders = sourceFiles(process.cwd())
    .filter((file) => !readers.includes(file))
    .flatMap(namingLinesIn)
    .filter((line) => !line.includes(EXEMPT));

  assert.deepEqual(
    offenders,
    [],
    "what OnTrak Lab's variables mean is decided by `src/lib/lab-rules.ts`, and for its own " +
      "package by `ontrak-portal/src/lib/config.ts`. A second reader drifts from the first, and " +
      "it drifts towards drawing a link or a light for a product the deployment does not run. A " +
      `file that genuinely must name them marks the line "${EXEMPT} <reason>":\n` +
      offenders.join("\n"),
  );
});

test("lab: every exemption says why it is not a second reader", () => {
  const excuses = sourceFiles(process.cwd())
    .flatMap(namingLinesIn)
    .filter((line) => line.includes(EXEMPT))
    .filter((line) => line.slice(line.indexOf(EXEMPT) + EXEMPT.length).trim().length < 10);

  assert.deepEqual(excuses, [], `an exemption has to say why: ${excuses.join(", ")}`);
});

/*
 * ── which door, from three facts ───────────────────────────────────────────
 *
 * The lab's address used to be all there was: a peer deployment on its own host, linked
 * to. The port put the control plane *here*, so "a lab" and "somebody else's lab" came
 * apart and the page that draws the door needs one answer rather than three variables.
 * `labDoor` is that answer, and these are its cases — including the one that matters
 * most: a stated address that was refused is still a refusal, even when this app could
 * serve a lab of its own, because an operator who set a variable and was told nothing
 * about it will believe it took effect.
 */

test("lab: the door is off until a deployment asks for a lab at all", () => {
  assert.deepEqual(labDoorFromEnv({}), { kind: "off" });
  // An address without the switch asks for nothing: it is where a lab *would* be.
  assert.deepEqual(labDoorFromEnv({ ONTRAK_LAB_URL: "https://lab.example.test" }), { kind: "off" });
  // The two switches answer two questions, so a contradictory pair resolves toward the
  // one that names *this* app rather than the one that names somebody else's host.
  assert.deepEqual(
    labDoorFromEnv({ ONTRAK_LAB_ENABLED: "false", ONTRAK_LAB_IN_APP: "1" }),
    { kind: "in-app", href: LAB_IN_APP_PATH },
  );
});

test("lab: a named peer is the door, address for address", () => {
  const door = labDoorFromEnv({ ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: "https://lab.example.test/" });
  assert.deepEqual(door, { kind: "external", url: `https://lab.example.test${LAB_DASHBOARD_PATH}` });
});

test("lab: with no address, the in-app switch serves this app's own lab", () => {
  const door = labDoorFromEnv({ ONTRAK_LAB_ENABLED: "on", ONTRAK_LAB_IN_APP: "true" });
  assert.deepEqual(door, { kind: "in-app", href: LAB_IN_APP_PATH });
  assert.equal(LAB_IN_APP_PATH, "/lab");
  // Enabled and in-app, so no issue is left over from the missing address.
  assert.deepEqual(labDoorFromEnv({ ONTRAK_LAB_IN_APP: "yes" }), { kind: "in-app", href: "/lab" });
});

test("lab: enabled with no address and no in-app lab is still an issue, never a dead link", () => {
  const door = labDoorFromEnv({ ONTRAK_LAB_ENABLED: "1" });
  assert.equal(door.kind, "misconfigured");
  assert.ok(door.kind === "misconfigured" && door.issues.length > 0, "the operator is told why");
});

test("lab: an address that was refused keeps its reason, even with an in-app lab", () => {
  // The stale variable is the point: silently serving the in-app lab would leave an
  // operator believing their deployment points at `ftp://lab.test`.
  const door = labDoorFromEnv({
    ONTRAK_LAB_ENABLED: "1",
    ONTRAK_LAB_URL: "ftp://lab.test",
    ONTRAK_LAB_IN_APP: "1",
  });
  assert.equal(door.kind, "misconfigured");
  assert.ok(door.kind === "misconfigured" && door.issues.some((issue) => /not an http\(s\) URL/.test(issue)));
  // A peer that is named *and* in-app is the peer: a stated address is a decision.
  assert.equal(
    labDoorFromEnv({ ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: "https://lab.test", ONTRAK_LAB_IN_APP: "1" }).kind,
    "external",
  );
});

test("lab: the door is read from one place, so no page half-reads the three facts", () => {
  // `labDoor` and `labDoorFromEnv` are the same rule; asserting it means a caller that
  // reads the variables itself is a caller the guard below can also see.
  const env = { ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: "https://lab.test" };
  assert.deepEqual(labDoor(labConfigFromEnv(env), env), labDoorFromEnv(env));
});

test("lab: a simulated scenario is untouched, and a lab one has exactly one door", () => {
  const config = labConfigFromEnv({ ONTRAK_LAB_ENABLED: "true", ONTRAK_LAB_URL: "https://lab.test" });
  assert.equal(isLabScenario(["linux", "basics"]), false, "no lab affordance for a simulated scenario");
  assert.equal(simulatedStartRefusal(["linux", "basics"]), null, "and its simulated start is unchanged");
  assert.equal(isLabScenario(["lab"]), true);
  assert.ok(simulatedStartRefusal(["lab"]), "a lab scenario has no simulated start to offer");
  // The substring rule still holds where it matters most: a scenario that merely says
  // "lab" in another word is not promoted onto a hypervisor, and is not refused here.
  assert.equal(simulatedStartRefusal(["cyber-lab", "laboratory"]), null);
  // And the lab URL exists only when the deployment turned it on.
  assert.equal(labSessionUrl(config), "https://lab.test/dashboard");
});
