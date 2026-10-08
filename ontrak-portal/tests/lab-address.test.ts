/**
 * The lab is drawn only when a deployment says both that it wants it and where it is.
 *
 * This is the front door's half of the rule the training app already keeps in
 * `src/lib/lab-rules.ts`, and it is worth a test of its own because of what the *other*
 * answer draws: the dashboard used to give every role in the training audience a lab tile
 * pointing at `lab.<base domain>` and probe it, so a deployment that does not run the lab
 * — which is every deployment today, since the lab is a peer Python host this repository
 * does not serve — opened on a red "not answering" for a product nobody was running. The
 * light that could never turn green is the same class of defect as the Sync light aimed at
 * the wrong half of Sync.
 *
 * So there are three states, and the test is about the middle one arriving as `null`:
 *
 *   * off (the default) — no lab, whatever address is lying around;
 *   * on but nowhere — still no lab, because a link needs somewhere to go;
 *   * on and located — the origin, so the tile links where the operator said.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { labAddress } from "../src/lib/config";

describe("the lab address a deployment states", () => {
  it("is null until the deployment turns the lab on", () => {
    // The address alone is not an invitation: an operator who has set it but not asked
    // for the lab has said where a lab *would* be, not that there is one.
    assert.equal(labAddress({}), null);
    assert.equal(labAddress({ ONTRAK_LAB_URL: "https://lab.example.test" }), null);
    assert.equal(
      labAddress({ ONTRAK_LAB_ENABLED: "false", ONTRAK_LAB_URL: "https://lab.example.test" }),
      null,
    );
  });

  it("is null when the lab is on but nowhere", () => {
    // Enabled and located are two facts, and both are required for a link.
    assert.equal(labAddress({ ONTRAK_LAB_ENABLED: "true" }), null);
    assert.equal(labAddress({ ONTRAK_LAB_ENABLED: "on", ONTRAK_LAB_URL: "   " }), null);
  });

  it("reads the same spellings of on as the training app", () => {
    for (const truthy of ["1", "true", "yes", "on", "ON", " True "]) {
      assert.equal(
        labAddress({ ONTRAK_LAB_ENABLED: truthy, ONTRAK_LAB_URL: "https://lab.example.test" }),
        "https://lab.example.test",
        `${truthy} has to read as on`,
      );
    }
  });

  it("returns the origin, so the link cannot double a segment", () => {
    // A trailing slash and a path are both things a person types into `.env`; neither may
    // reach the tile, where `<url>/dashboard`-shaped suffixes are appended.
    assert.equal(
      labAddress({ ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: '"https://lab.example.test/"' }),
      "https://lab.example.test",
    );
    assert.equal(
      labAddress({ ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: "http://10.0.0.5:8080/dashboard" }),
      "http://10.0.0.5:8080",
    );
  });

  it("refuses what a browser cannot open, rather than drawing a dead link", () => {
    // A misconfiguration is reported by drawing nothing, never by drawing a link that
    // cannot work — the stance the training app's lab reader takes too.
    assert.equal(labAddress({ ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: "lab.example.test" }), null);
    assert.equal(labAddress({ ONTRAK_LAB_ENABLED: "1", ONTRAK_LAB_URL: "ftp://lab.example.test" }), null);
  });
});
