/**
 * The catalog is a manifest library, so the tests are mostly about honesty: does
 * validation catch a bad manifest, and does the planner pick the fastest path the host
 * can actually deliver?
 *
 * Ported from OnTrak-dev's `tests/test_catalog.py`, and — like that suite — it runs
 * against the **shipped data**, not against a fixture that could drift from it. The
 * manifests live in `src/lib/lab/data/catalog.json`, converted from the lab's own
 * `catalog/*.yaml` field for field, so `validate()` returning clean here is a statement
 * about the real catalogue: Windows 95 through 2025, Office layered on Windows bases,
 * and Linux as both containers and VMs.
 *
 * Two further tests exist only in this port, because they check contracts that live in
 * *this* tree rather than in the lab:
 *
 * - a `Catalog` satisfies `media.ts`'s `MediaCatalog`, and a `CatalogEntry` satisfies
 *   `selection.ts`'s `WorkloadFacts`, **with no cast** — which is what lets the media
 *   store and the assignment engine be wired to the catalogue without an adapter. If
 *   someone renames `imageAlias`, that test fails here rather than at a call site three
 *   modules away;
 * - a manifest's `sha256` is stored lower-case, which `media.ts` records as load-bearing
 *   (an upper-case checksum compares unequal to the digest and a good download is
 *   deleted).
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-catalog.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { Catalog, CatalogError, DEVICE_PROFILES, Media } from "../src/lib/lab/catalog";
import type { MediaCatalog } from "../src/lib/lab/media";
import type { WorkloadFacts } from "../src/lib/lab/selection";

const DATA = path.join(process.cwd(), "src", "lib", "lab", "data", "catalog.json");

/** The shipped manifests, as the deployment would hand them over. */
function shippedManifests(): Record<string, unknown> {
  return JSON.parse(readFileSync(DATA, "utf8")) as Record<string, unknown>;
}

function shipped(): Catalog {
  return new Catalog(shippedManifests());
}

/* -------------------------------------------------------------------------- */
/*  Fixtures for the hand-written cases                                       */
/* -------------------------------------------------------------------------- */

/** The minimal valid manifest every broken case starts from and breaks one field of. */
function baseManifest(): Record<string, unknown> {
  return {
    group: "test",
    label: "Test",
    entries: [
      {
        id: "ok-entry",
        name: "Fine",
        media: { source: "free", kind: "image", filename: "images:ubuntu/24.04" },
        install: { recipe: "container-image", alias: "images:ubuntu/24.04" },
        kind: "container",
        family: "linux",
        device_profile: "linux-container",
        automation: "ssh",
        notes: "fine",
      },
    ],
  };
}

function catalogOf(manifest: Record<string, unknown>, name = "test.yaml"): Catalog {
  return new Catalog({ [name]: manifest });
}

/** The one entry of a fixture manifest, as the mutable record the cases edit. */
function firstEntry(manifest: Record<string, unknown>): Record<string, unknown> {
  const entries = manifest.entries;
  const entry = Array.isArray(entries) ? entries[0] : undefined;
  if (typeof entry !== "object" || entry === null) {
    throw new Error("the fixture manifest must declare one entry");
  }
  return entry as Record<string, unknown>;
}

/** A deep copy, so a case never edits the shared fixture. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function problemsOf(catalog: Catalog): string {
  return catalog.validate().join(" ");
}

/* -------------------------------------------------------------------------- */
/*  The shipped catalog                                                       */
/* -------------------------------------------------------------------------- */

test("catalog: the shipped manifests validate clean, every one of them", () => {
  // Every rule in `validate()` is applied to the real data here. A failure is a bug in
  // the port or in the data, never in a fixture nobody ships.
  assert.deepEqual(shipped().validate(), []);
});

test("catalog: it covers Windows 95 through present, desktop and server", () => {
  const ids = new Set(shipped().list().map((entry) => entry.id));

  for (const expected of [
    "win95-osr2",
    "win98se",
    "win-me",
    "win-xp-sp3",
    "win7-sp1",
    "win11-24h2",
    "win2003-r2",
    "win2008-r2",
    "win2019",
    "win2025",
  ]) {
    assert.ok(ids.has(expected), `${expected} must be in the catalog`);
  }

  // Each Office suite is layered onto a Windows base, so it is its own entry.
  for (const expected of [
    "office97-on-win95",
    "office2003-on-xp",
    "office2016-on-win10",
    "m365-apps-on-win11",
  ]) {
    assert.ok(ids.has(expected), `${expected} must be in the catalog`);
  }

  // Linux arrives both ways: a container to launch and a VM image to clone.
  for (const expected of ["ubuntu-24.04", "debian-12", "alpine-3.21", "ubuntu-desktop-24.04"]) {
    assert.ok(ids.has(expected), `${expected} must be in the catalog`);
  }
});

test("catalog: an Office entry names the OS it is layered onto, and that OS exists", () => {
  const catalog = shipped();
  const office = catalog.list({ family: "microsoft-office" });
  assert.ok(office.length > 0, "the Office family must not be empty");

  for (const entry of office) {
    assert.ok(entry.requires.length > 0, `${entry.id} must require a Windows base`);
    for (const required of entry.requires) {
      const base = catalog.get(required);
      assert.ok(
        base.family === "windows" || base.family === "linux",
        `${entry.id} requires ${required}, which is ${base.family}`,
      );
    }
  }
});

test("catalog: DOS-era guests get a DOS-era profile, not VirtIO", () => {
  const catalog = shipped();
  assert.equal(catalog.get("win95-osr2").deviceProfile, "legacy-9x");
  assert.equal(catalog.get("win-xp-sp3").deviceProfile, "legacy-xp");
  assert.equal(catalog.get("win11-24h2").deviceProfile, "modern");

  // These guests predate ACPI and VirtIO entirely, so the profile has to say so: the
  // raw QEMU line is what makes the installer boot, and an rtl8139 NIC is the only one
  // the era's drivers know.
  const config = catalog.get("win98se").resolvedConfig();
  assert.ok("raw.qemu" in config, "the DOS-era profile carries raw.qemu");

  const eth0 = catalog.get("win98se").resolvedDevices()["eth0"];
  assert.ok(eth0, "the DOS-era profile declares eth0");
  const options = eth0.options as Record<string, unknown> | undefined;
  assert.equal(options?.nictype, "rtl8139");
});

test("catalog: licensed media is never marked free", () => {
  // The one rule that keeps the repository publishable: OnTrak ships manifests, so an
  // entry whose media is a licensed product must say `operator`.
  for (const entry of shipped().list({ family: "microsoft-office" })) {
    assert.equal(entry.media.source, "operator", `${entry.id} must not be redistributable`);
  }
});

test("catalog: the filters read the fields they name", () => {
  const catalog = shipped();

  const containers = catalog.list({ kind: "container" });
  assert.ok(containers.length > 0);
  assert.ok(containers.every((entry) => entry.kind === "container"));

  const legacyWindows = catalog.list({ group: "windows-desktop", kind: "vm" });
  assert.ok(legacyWindows.some((entry) => entry.media.source === "operator"));

  // `id` is a substring match, so `win10` finds the releases and the newest sorts last.
  assert.equal(catalog.list({ id: "win10" }).pop()?.id, "win10-22h2");
});

/* -------------------------------------------------------------------------- */
/*  Plans                                                                     */
/* -------------------------------------------------------------------------- */

test("catalog: a container workload plans a launch, with no operator work", () => {
  const plan = shipped().plan("ubuntu-24.04");
  assert.equal(plan.strategy, "container-image");
  assert.equal(plan.ready, true);
  assert.equal(plan.needsOperator, false);
  assert.ok(plan.estimateSeconds < 30, "a container launch is near-instant");
});

test("catalog: an ISO workload needs an image built before it is fast", () => {
  const catalog = shipped();

  // Cold: no media, no image. This is an operator task, and the plan says which one.
  const cold = catalog.plan("win11-24h2", { mediaReady: false, imageReady: false });
  assert.equal(cold.strategy, "build-image");
  assert.equal(cold.needsOperator, true);
  assert.ok(cold.blockers.some((blocker) => blocker.includes("media store")));

  // Both halves present: the request path is a launch.
  const warm = catalog.plan("win11-24h2", { mediaReady: true, imageReady: true });
  assert.equal(warm.strategy, "image-launch");
  assert.equal(warm.ready, true);
  assert.equal(warm.needsOperator, false);

  // Media but no image: still an operator task, and the step names the entry.
  const mediaOnly = catalog.plan("win11-24h2", { mediaReady: true, imageReady: false });
  assert.equal(mediaOnly.strategy, "build-image");
  assert.ok(mediaOnly.steps.some((step) => step.includes("ontrak image build win11-24h2")));
});

test("catalog: a manual platform reports itself unplannable rather than guessing", () => {
  const plan = shipped().plan("win95-osr2");
  assert.equal(plan.strategy, "unsupported");
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.length > 0);
  assert.ok(plan.blockers.some((blocker) => blocker.includes("provision it by hand")));
});

test("catalog: an image-based workload launches without any media at all", () => {
  const plan = shipped().plan("ubuntu-desktop-24.04");
  assert.equal(plan.strategy, "image-launch");
  assert.equal(plan.ready, true);
});

test("catalog: plans are ordered fastest first, unsupported last", () => {
  const catalog = shipped();
  const ordered = catalog.mergeOrder([
    catalog.plan("win11-24h2", { mediaReady: false, imageReady: false }),
    catalog.plan("ubuntu-24.04"),
    catalog.plan("win95-osr2"),
  ]);
  assert.equal(ordered[0]?.strategy, "container-image");
  assert.equal(ordered.at(-1)?.strategy, "unsupported");
});

/* -------------------------------------------------------------------------- */
/*  Validation of hand-written manifests                                      */
/* -------------------------------------------------------------------------- */

test("catalog: a minimal valid manifest validates clean", () => {
  assert.deepEqual(catalogOf(baseManifest()).validate(), []);
});

test("catalog: a DOS-era profile is refused on a container", () => {
  const manifest = baseManifest();
  firstEntry(manifest).device_profile = "legacy-9x";
  assert.match(problemsOf(catalogOf(manifest)), /DOS-era profiles are VM-only/);
});

test("catalog: an unknown automation level is refused", () => {
  const manifest = baseManifest();
  firstEntry(manifest).automation = "telepathy";
  const problems = problemsOf(catalogOf(manifest));
  assert.match(problems, /unknown automation level 'telepathy'/);
  assert.match(problems, /ssh/, "the refusal names the levels that exist");
});

test("catalog: free media must say where it comes from", () => {
  const manifest = baseManifest();
  firstEntry(manifest).media = { source: "free", kind: "iso", filename: "x.iso" };
  assert.match(problemsOf(catalogOf(manifest)), /free media must have a url/);
});

test("catalog: an image-alias recipe without an alias is refused", () => {
  const manifest = baseManifest();
  firstEntry(manifest).install = { recipe: "image-alias" };
  assert.match(problemsOf(catalogOf(manifest)), /install\.alias/);
});

test("catalog: operator media must name a filename the media store can find", () => {
  const manifest = baseManifest();
  firstEntry(manifest).media = { source: "operator", kind: "iso" };
  assert.match(problemsOf(catalogOf(manifest)), /operator-supplied media must name a filename/);
});

test("catalog: a Linux container cannot be driven over WinRM", () => {
  const manifest = baseManifest();
  firstEntry(manifest).automation = "winrm-ps51";
  assert.match(problemsOf(catalogOf(manifest)), /cannot be driven by winrm-ps51/);
});

test("catalog: an unknown device profile is refused by name", () => {
  const manifest = baseManifest();
  firstEntry(manifest).device_profile = "vibes";
  const problems = problemsOf(catalogOf(manifest));
  assert.match(problems, /unknown device_profile 'vibes'/);
  assert.match(problems, /modern/, "the refusal names the profiles that exist");
});

test("catalog: a product requiring an OS that is not in the catalog is refused", () => {
  const manifest = baseManifest();
  const entries = manifest.entries as Record<string, unknown>[];
  entries.push({
    id: "office-on-nothing",
    name: "Office without an OS",
    kind: "vm",
    family: "microsoft-office",
    requires: ["does-not-exist"],
    device_profile: "vista-era",
    automation: "none",
    media: { source: "operator", kind: "iso", filename: "office.iso" },
    install: { recipe: "manual", builder: "manual" },
    notes: "layered onto nothing",
  });
  assert.match(problemsOf(catalogOf(manifest)), /requires 'does-not-exist'/);
});

test("catalog: two files claiming one entry id are refused, not silently merged", () => {
  // Python's dict assignment kept whichever file was read last; a duplicate id across
  // groups is a copy-paste error, and half a catalog is worse than a refusal.
  const second = baseManifest();
  second.group = "other";
  assert.throws(
    () => new Catalog({ "a.yaml": baseManifest(), "b.yaml": second }).load(),
    (error: unknown) =>
      error instanceof CatalogError && /duplicate catalog entry id 'ok-entry'/.test(error.message),
  );
});

test("catalog: defaults are inherited, and an entry can override them", () => {
  const catalog = catalogOf({
    group: "test",
    label: "Test",
    defaults: {
      kind: "container",
      family: "linux",
      automation: "ssh",
      device_profile: "linux-container",
      media: { source: "free", kind: "image" },
      install: { recipe: "container-image" },
    },
    entries: [
      {
        id: "inherited",
        name: "Inherits everything",
        install: { alias: "images:debian/12" },
        media: { filename: "images:debian/12" },
      },
      {
        id: "overridden",
        name: "Overrides the profile",
        kind: "vm",
        device_profile: "linux-vm",
        automation: "ssh",
        install: { recipe: "image-alias", alias: "images:debian/12/cloud" },
        media: { kind: "image", filename: "images:debian/12/cloud" },
      },
    ],
  });

  assert.deepEqual(catalog.validate(), []);
  assert.equal(catalog.get("inherited").kind, "container");
  assert.equal(catalog.get("inherited").recipe, "container-image");
  assert.equal(catalog.get("overridden").kind, "vm");
  assert.equal(catalog.get("overridden").deviceProfile, "linux-vm");
});

test("catalog: an unknown entry is refused with a hint that helps", () => {
  assert.throws(
    () => shipped().get("windows-3000"),
    (error: unknown) =>
      error instanceof CatalogError && /ontrak catalog list/.test(error.message),
  );
});

test("catalog: every referenced device profile exists", () => {
  for (const entry of shipped().list()) {
    assert.ok(
      entry.deviceProfile in DEVICE_PROFILES,
      `${entry.id} names device_profile ${entry.deviceProfile}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/*  Contracts the rest of this tree already depends on                        */
/* -------------------------------------------------------------------------- */

test("catalog: a catalog IS a media catalog, and an entry IS a workload — with no cast", () => {
  // `media.ts` asks a catalog for `list()`; `selection.ts` asks an entry for its kind,
  // families, profile and automation. Both are structural, so this assignment is the
  // test: if the shapes drift, this line stops compiling rather than a call site failing
  // three modules away.
  const catalog = shipped();
  const asMediaCatalog: MediaCatalog = catalog;
  const entries = asMediaCatalog.list();
  assert.ok(entries.length > 0, "the media store must see the entries");

  const first = entries[0];
  assert.ok(first, "the media store sees an entry");
  assert.equal(typeof first.label, "string");
  assert.equal(typeof first.imageAlias, "string");
  assert.equal(typeof first.media.sha256, "string");

  const facts: WorkloadFacts = catalog.get("ubuntu-24.04");
  assert.equal(facts.kind, "container");
  assert.ok(Array.isArray(facts.scenarioFamilies));
  assert.equal(typeof facts.automation, "string");
  assert.ok(facts.profile, "the workload facts carry the device profile");
});

test("catalog: a manifest checksum is stored lower-case, or a good download is deleted", () => {
  // `media.ts` compares this string byte for byte against the digest, so an upper-case
  // manifest would mismatch and the store would delete a file it just fetched.
  const manifest = baseManifest();
  firstEntry(manifest).media = {
    source: "free",
    kind: "iso",
    filename: "x.iso",
    url: "https://example.test/x.iso",
    sha256: "ABCDEF0123456789",
  };
  assert.equal(catalogOf(manifest).get("ok-entry").media.sha256, "abcdef0123456789");
  assert.equal(Media.fromDict({ sha256: "DEADBEEF" }).sha256, "deadbeef");
});

test("catalog: a memory figure is read as mebibytes, and an unreadable one is zero", () => {
  // This decides whether a manifest is refused as implausibly small, and `512MB` means
  // 512 MiB of guest RAM to every operator who wrote it.
  const manifest = baseManifest();
  firstEntry(manifest).resources = { cpu: 1, memory: "128MiB", disk: "8GiB" };
  assert.deepEqual(catalogOf(manifest).validate(), []);

  const tiny = baseManifest();
  firstEntry(tiny).resources = { cpu: 1, memory: "64MiB", disk: "8GiB" };
  assert.match(problemsOf(catalogOf(tiny)), /resources\.memory is implausibly small/);

  const nonsense = baseManifest();
  firstEntry(nonsense).resources = { cpu: 1, memory: "lots", disk: "8GiB" };
  assert.match(problemsOf(catalogOf(nonsense)), /resources\.memory is implausibly small/);
});

test("catalog: the loaded view keeps the manifest's edition in its label", () => {
  // `label` is what a student reads on the picker, and two editions of one release must
  // not look like the same entry.
  const manifest = clone(baseManifest());
  firstEntry(manifest).edition = "Professional";
  const entry = catalogOf(manifest).get("ok-entry");
  assert.equal(entry.label, "Fine (Professional)");
  assert.equal(entry.name, "Fine");

  const plain = catalogOf(clone(baseManifest())).get("ok-entry");
  assert.equal(plain.label, "Fine");
});
