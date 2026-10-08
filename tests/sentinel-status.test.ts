/**
 * The Sentinel tile's facts, as the control room reads them.
 *
 * Sentinel is a product beside this app rather than a library inside it, so the control
 * room cannot report on its internals — it can only report *where its console is*, which
 * is what this module decides. What the tests pin down is therefore the reading, not the
 * markup: the three states, the URL the tile actually opens, and the rule that an
 * `off` deployment is not painted as a broken one.
 *
 * The states are the link's states: `ready` means there is an absolute http(s) URL the
 * tile can open, and `incomplete` is the case the tile exists to make visible — somebody
 * set a value the deployment cannot use, so the link is refused rather than half-drawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SENTINEL_CONSOLE_URL_ENV,
  SENTINEL_CONTROL_CENTER_PATH,
  SENTINEL_ISSUER_ENV,
  sentinelStatus,
} from "../src/lib/sentinel-status";

const CONSOLE = "https://sentinel.example";

test("sentinel: an empty environment is off, and names nothing", () => {
  const status = sentinelStatus({});
  assert.equal(status.state, "off");
  assert.equal(status.controlCenterUrl, null);
  assert.equal(status.issuer, null);
  assert.deepEqual(status.details, []);
  assert.deepEqual(status.issues, []);
});

test("sentinel: the console URL is the control center's base, path and all", () => {
  const status = sentinelStatus({ [SENTINEL_CONSOLE_URL_ENV]: CONSOLE });
  assert.equal(status.state, "ready");
  assert.equal(status.controlCenterUrl, `${CONSOLE}${SENTINEL_CONTROL_CENTER_PATH}`);
  // No issuer was set, so the tile says so rather than inventing one.
  assert.equal(status.issuer, null);
  assert.deepEqual(status.issues, []);
});

test("sentinel: the issuer is the console's origin when no console URL is set", () => {
  const status = sentinelStatus({ [SENTINEL_ISSUER_ENV]: "http://127.0.0.1:8787" });
  assert.equal(status.state, "ready");
  assert.equal(status.controlCenterUrl, `http://127.0.0.1:8787${SENTINEL_CONTROL_CENTER_PATH}`);
  assert.equal(status.issuer, "http://127.0.0.1:8787");
});

test("sentinel: an explicit console URL wins over the issuer", () => {
  const status = sentinelStatus({
    [SENTINEL_CONSOLE_URL_ENV]: CONSOLE,
    [SENTINEL_ISSUER_ENV]: "http://127.0.0.1:8787",
  });
  assert.equal(status.controlCenterUrl, `${CONSOLE}${SENTINEL_CONTROL_CENTER_PATH}`);
  assert.equal(status.issuer, "http://127.0.0.1:8787");
});

test("sentinel: a value that is not an absolute http(s) URL is refused, with the reason", () => {
  for (const bad of ["sentinel.example", "/console", "ftp://sentinel.example"]) {
    const status = sentinelStatus({ [SENTINEL_CONSOLE_URL_ENV]: bad });
    assert.equal(status.state, "incomplete", `${bad} must not be drawn as a link`);
    assert.equal(status.controlCenterUrl, null);
    assert.ok(status.issues.length > 0, "a refusal has to say why");
    assert.deepEqual(status.details, [], "there is no URL to show when it was refused");
  }
});

test("sentinel: a trailing path or slash on the base does not double the segment", () => {
  // The control center has one home, so the tile opens the origin's `/console/control-center`
  // whatever the base was written as — a console URL that carried a path or a slash would
  // otherwise produce `/console/console/control-center`.
  const withSlash = sentinelStatus({ [SENTINEL_CONSOLE_URL_ENV]: `${CONSOLE}/` });
  const withPath = sentinelStatus({ [SENTINEL_CONSOLE_URL_ENV]: `${CONSOLE}/somewhere` });
  assert.equal(withSlash.controlCenterUrl, `${CONSOLE}${SENTINEL_CONTROL_CENTER_PATH}`);
  assert.equal(withPath.controlCenterUrl, `${CONSOLE}${SENTINEL_CONTROL_CENTER_PATH}`);
});
