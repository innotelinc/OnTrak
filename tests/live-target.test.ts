/**
 * Tests: the guard that keeps a browser sweep off a real deployment.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/live-target.test.ts
 *
 * The sweeps are opt-in through a base URL, but this repository's own `.env` records the
 * production desk under the same variable — so a shell that sourced it would sweep
 * production and report success. These pin the answer: loopback runs, a deployment's own
 * address does not, and the switch is what changes that.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALLOW_REMOTE, liveRefusal } from "./support/live-target";

const VARIABLE = "ONTRAK_TIX_BASE_URL";
const REMOTE = "https://tix.ontrak.innotel.us";

/** Run `body` with the opt-in switch set to `value`, and leave nothing behind. */
function withOptIn(value: string | undefined, body: () => void): void {
  const previous = process.env[ALLOW_REMOTE];
  if (value === undefined) delete process.env[ALLOW_REMOTE];
  else process.env[ALLOW_REMOTE] = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env[ALLOW_REMOTE];
    else process.env[ALLOW_REMOTE] = previous;
  }
}

test("live target: an unset address is not a refusal — that is the sweep's own skip to explain", () => {
  assert.equal(liveRefusal(VARIABLE, undefined), null);
  assert.equal(liveRefusal(VARIABLE, null), null);
  assert.equal(liveRefusal(VARIABLE, ""), null);
});

test("live target: a deployment on this machine is allowed, with the switch off", () => {
  withOptIn(undefined, () => {
    for (const url of [
      "http://127.0.0.1:3001",
      "http://localhost:3001",
      "https://localhost",
      "http://[::1]:3001",
      "http://tix.localhost:3001",
    ]) {
      assert.equal(liveRefusal(VARIABLE, url), null, `${url} is this machine`);
    }
  });
});

test("live target: a deployment's own address is refused, and the refusal says which", () => {
  withOptIn(undefined, () => {
    const refusal = liveRefusal(VARIABLE, REMOTE);
    assert.ok(refusal, "the desk's public name is refused");
    assert.match(refusal, /tix\.ontrak\.innotel\.us/, "it names the host it refused");
    assert.match(refusal, new RegExp(VARIABLE), "it names the variable to change");
    assert.match(refusal, new RegExp(ALLOW_REMOTE), "and the switch that overrides it");

    // A LAN rehearsal box is not loopback either, so it is refused the same way — and
    // that is the point: only the person running it knows whether it is a rehearsal.
    assert.ok(liveRefusal(VARIABLE, "http://192.168.1.52:3001"), "a LAN address is refused");

    // A host that merely *contains* a loopback name is not loopback.
    assert.ok(liveRefusal(VARIABLE, "https://127.0.0.1.evil.test"), "a look-alike host is refused");
    assert.ok(liveRefusal(VARIABLE, "https://localhost.evil.test"), "and so is this one");
  });
});

test("live target: the switch is what lets a remote address through", () => {
  for (const value of ["1", "true", "YES", "on", " true "]) {
    withOptIn(value, () => {
      assert.equal(liveRefusal(VARIABLE, REMOTE), null, `"${value}" opts in`);
    });
  }
  for (const value of ["", "0", "false", "no", "off", "maybe"]) {
    withOptIn(value, () => {
      assert.ok(liveRefusal(VARIABLE, REMOTE), `"${value}" does not opt in`);
    });
  }
});

test("live target: something that is not a URL is refused rather than trusted", () => {
  withOptIn(undefined, () => {
    const refusal = liveRefusal(VARIABLE, "tix.ontrak.innotel.us");
    assert.ok(refusal, "a value with no scheme cannot be read, so it is refused");
    assert.match(refusal, new RegExp(VARIABLE));
  });
});
