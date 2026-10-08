/**
 * The portal's decisions, asserted.
 *
 * These are the tests worth having, because none of them need a provider, a
 * network or a browser — and the failures they cover are all logic bugs that a
 * mocked network would happily let through:
 *
 *   * a technician who is quietly shown the sysadmin's product;
 *   * a group list in an unexpected order producing a different role;
 *   * an assertion that is valid but was issued to another application;
 *   * a callback that will redirect to somebody else's site.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  addressFor, asRole, canOpen, emptyStateFor, isRole, landingFor, parseRoleMappings, product,
  productsFor, roleChanged, roleForGroups, roleFromGroups, runsHere, tilesFor, urlFor,
  PRODUCTS, ROLES, type Role,
} from "../src/lib/portal-rules";
import {
  checkClaims, safeReturnTo, type IdTokenClaims,
} from "../src/lib/oidc-rules";

const NOW = 1_800_000_000;

function claims(over: Partial<IdTokenClaims> = {}): IdTokenClaims {
  return {
    iss: "https://auth.cerulean.innotel.us/application/o/ontrak",
    aud: "ontrak",
    sub: "abc-123",
    email: "a.person@innotel.us",
    email_verified: true,
    nonce: "the-nonce",
    iat: NOW - 5,
    exp: NOW + 300,
    ...over,
  };
}

const CHECK = {
  issuer: "https://auth.cerulean.innotel.us/application/o/ontrak",
  clientId: "ontrak",
  nonce: "the-nonce",
  now: NOW,
};

describe("roles", () => {
  it("recognises only the family's vocabulary", () => {
    for (const role of ROLES) assert.equal(isRole(role), true);
    assert.equal(isRole("SUPERUSER"), false);
    assert.equal(isRole(""), false);
    assert.equal(isRole(undefined), false);
  });

  it("fails towards the least privileged role", () => {
    assert.equal(asRole("sysadmin"), "SYSADMIN");
    assert.equal(asRole("  analyst "), "ANALYST");
    assert.equal(asRole("wizard"), "STUDENT");
    assert.equal(asRole(null), "STUDENT");
    assert.equal(asRole("wizard", "ADMIN"), "ADMIN");
  });
});

describe("the catalogue", () => {
  it("gives every product at least one role and a distinct host", () => {
    for (const entry of PRODUCTS) {
      assert.ok(entry.roles.length > 0, `${entry.key} has no audience`);
      assert.ok(entry.name.length > 0);
    }
    const hosts = new Set(PRODUCTS.map((entry) => entry.host));
    assert.equal(hosts.size, PRODUCTS.length);
  });

  it("sends each role to the product it belongs in", () => {
    // The lab is the training range's real-VM sibling, so it follows the same
    // audience as the range rather than the operations roles.
    assert.deepEqual(productsFor("STUDENT").map((p) => p.key), ["its", "lab"]);
    assert.deepEqual(productsFor("INSTRUCTOR").map((p) => p.key), ["its", "lab"]);
    assert.deepEqual(productsFor("TECHNICIAN").map((p) => p.key), ["tix"]);
    assert.deepEqual(productsFor("ANALYST").map((p) => p.key), ["sentinel"]);
    assert.deepEqual(productsFor("SYSADMIN").map((p) => p.key), ["tix", "sentinel", "sync", "genie"]);
    assert.deepEqual(productsFor("ADMIN").map((p) => p.key), ["its", "tix", "sentinel", "sync", "genie", "lab"]);
  });

  it("does not show a student the sysadmin's product", () => {
    assert.equal(canOpen("STUDENT", "sync"), false);
    assert.equal(canOpen("STUDENT", "sentinel"), false);
    // Genie reads, writes and runs code, so the narrow audience is the point.
    assert.equal(canOpen("STUDENT", "genie"), false);
    assert.equal(canOpen("TECHNICIAN", "genie"), false);
    assert.equal(canOpen("ANALYST", "genie"), false);
    assert.equal(canOpen("SYSADMIN", "genie"), true);
    assert.equal(canOpen("SYSADMIN", "sync"), true);
    assert.equal(canOpen("ANALYST", "tix"), false);
    // The lab is for the training audience: a student belongs in it, the desk does not.
    assert.equal(canOpen("STUDENT", "lab"), true);
    assert.equal(canOpen("TECHNICIAN", "lab"), false);
    assert.equal(canOpen("ANALYST", "lab"), false);
  });

  it("prefers the product a person came for over the catalogue order", () => {
    // An admin belongs everywhere; landing them in the training range when they
    // came to patch the Network is landing them in the wrong application.
    assert.equal(landingFor("ADMIN")?.key, "its");
    assert.equal(landingFor("ADMIN", ["sync"])?.key, "sync");
    assert.equal(landingFor("SYSADMIN", ["sync"])?.key, "sync");
    assert.equal(landingFor("SYSADMIN")?.key, "sync");
    assert.equal(landingFor("TECHNICIAN")?.key, "tix");
  });

  it("builds addresses from the configured base domain", () => {
    const sync = product("sync");
    assert.ok(sync);
    assert.equal(urlFor(sync, "ontrak.innotel.us"), "https://sync.ontrak.innotel.us");
    assert.equal(urlFor(sync, "lab.test", false), "http://sync.lab.test");
  });

  it("marks exactly one primary tile, and only for a role that has products", () => {
    const tiles = tilesFor("SYSADMIN");
    assert.equal(tiles.filter((tile) => tile.primary).length, 1);
    assert.equal(tiles.find((tile) => tile.primary)?.key, "sync");
    // Two tiles share the training tone, but only one is the landing product: the
    // range stays where a student arrives, and the lab is the second tile beside it.
    assert.equal(landingFor("STUDENT")?.key, "its");
  });

  it("takes a product out of a deployment without taking it out of the catalogue", () => {
    // The catalogue is the whole family, and the lab stays in it: what it is for, who
    // belongs in it and the path it answers do not change with a deployment. Only the
    // *dashboard* narrows — see `runsHere` and `tilesFor`.
    assert.deepEqual(productsFor("STUDENT").map((entry) => entry.key), ["its", "lab"]);
    assert.equal(canOpen("STUDENT", "lab"), true);
    assert.equal(product("lab")?.health, "/healthz");
  });

  it("draws an optional product only once the deployment says where it is", () => {
    // The lab is a peer deployment, not a service the family stack runs, so a portal that
    // has not been told where it is draws no tile for it at all — no link, and no status
    // light that could only read "not answering" for a product nobody is running.
    assert.deepEqual(tilesFor("STUDENT").map((tile) => tile.key), ["its"]);
    assert.deepEqual(
      tilesFor("STUDENT", { addresses: { lab: "https://lab.example.test" } }).map((tile) => tile.key),
      ["its", "lab"],
    );
  });

  it("links a configured optional product at the address it was given", () => {
    const lab = tilesFor("STUDENT", { addresses: { lab: "https://lab.example.test" } })
      .find((tile) => tile.key === "lab");
    assert.ok(lab);
    // The address an operator gave, not the name the family's convention would derive:
    // the link has to be where they said the lab is.
    assert.equal(lab.url, "https://lab.example.test");
    assert.equal(lab.health, "/healthz");
    // It shares the training tone but is not the landing product.
    assert.equal(lab.primary, false);
  });

  it("does not land somebody on a product this deployment does not run", () => {
    // Somebody who came for the lab, in a deployment with no lab, still lands on the
    // range: a landing product that is not there is a tile nobody is sent to.
    const tiles = tilesFor("STUDENT", { preferred: ["lab"] });
    assert.deepEqual(tiles.map((tile) => tile.key), ["its"]);
    assert.equal(tiles.find((tile) => tile.primary)?.key, "its");

    // …and where the lab is running, the same preference is honoured.
    const withLab = tilesFor("STUDENT", {
      preferred: ["lab"],
      addresses: { lab: "https://lab.example.test" },
    });
    assert.equal(withLab.find((tile) => tile.primary)?.key, "lab");
  });

  it("keeps every product that is not optional in the fleet, whatever the addresses say", () => {
    // A deployment that configures nothing still draws the five products it always runs,
    // at the derived names — the optional rule narrows nothing else.
    assert.deepEqual(
      tilesFor("ADMIN").map((tile) => tile.key),
      ["its", "tix", "sentinel", "sync", "genie"],
    );
    assert.equal(runsHere(product("its")!), true);
    assert.equal(runsHere(product("lab")!), false);
    assert.equal(addressFor(product("lab")!, { baseDomain: "ontrak.innotel.us" }),
      "https://lab.ontrak.innotel.us");
    assert.equal(
      addressFor(product("lab")!, { addresses: { lab: "https://lab.example.test" } }),
      "https://lab.example.test",
    );
  });

  it("says something a person can act on when a role has no product", () => {
    // No catalogue role is empty today, so this asserts the contract rather than
    // the current table: an empty grid must never be the answer.
    assert.match(emptyStateFor("STUDENT"), /cohort|class|instructor/i);
    assert.match(emptyStateFor("ANALYST"), /administrator|group/i);
  });
});

describe("group mapping", () => {
  const mappings = parseRoleMappings(
    "ontrak-students=STUDENT, range-instructors=INSTRUCTOR, it-ops=SYSADMIN",
  );

  it("parses the same syntax as the other OnTrak products", () => {
    assert.deepEqual(parseRoleMappings("instructors=INSTRUCTOR\nit-ops=ADMIN"),
      { instructors: "INSTRUCTOR", "it-ops": "ADMIN" });
    assert.deepEqual(parseRoleMappings('"quoted=STUDENT"'), { quoted: "STUDENT" });
    assert.deepEqual(parseRoleMappings(""), {});
    assert.deepEqual(parseRoleMappings("# a comment"), {});
  });

  it("drops a rule whose role is not one we know", () => {
    // A typo that silently granted ADMIN would be worse than one that grants nothing.
    assert.deepEqual(parseRoleMappings("ops=SUPERUSER"), {});
    assert.deepEqual(parseRoleMappings("ops="), {});
  });

  it("takes the highest-ranked match, not the first one listed", () => {
    const first = roleFromGroups(["range-instructors", "it-ops"], mappings);
    const reversed = roleFromGroups(["it-ops", "range-instructors"], mappings);
    assert.equal(first.role, "SYSADMIN");
    assert.equal(reversed.role, "SYSADMIN");
    assert.equal(reversed.matched, "it-ops");
  });

  it("says when nothing matched rather than silently assuming a role", () => {
    const result = roleFromGroups(["nobody"], mappings, "STUDENT");
    assert.equal(result.role, "STUDENT");
    assert.equal(result.matched, null);
  });

  it("is case-insensitive on both sides", () => {
    assert.equal(roleFromGroups(["IT-OPS"], mappings).role, "SYSADMIN");
  });
});

describe("redirect targets", () => {
  it("only ever returns a path inside the portal", () => {
    assert.equal(safeReturnTo("/findings"), "/findings");
    assert.equal(safeReturnTo("/a/b?c=1"), "/a/b?c=1");
    for (const hostile of [
      "https://evil.test", "//evil.test/x", "javascript:alert(1)", "evil.test",
      "", null, undefined, "http://ontrak.innotel.us/",
    ]) {
      assert.equal(safeReturnTo(hostile), "/", `accepted ${String(hostile)}`);
    }
  });
});

describe("claim checks", () => {
  it("accepts an assertion for this portal", () => {
    const checked = checkClaims(claims(), CHECK);
    assert.ok(checked.ok);
    if (checked.ok) {
      assert.equal(checked.subject, "abc-123");
      assert.equal(checked.email, "a.person@innotel.us");
    }
  });

  it("refuses an assertion issued by somebody else", () => {
    const checked = checkClaims(claims({ iss: "https://attacker.test" }), CHECK);
    assert.equal(checked.ok, false);
  });

  it("refuses an assertion issued to another application", () => {
    // Without this, a token minted for the training range would sign somebody in here.
    const checked = checkClaims(claims({ aud: "ontrak-training" }), CHECK);
    assert.equal(checked.ok, false);
  });

  it("refuses a multi-audience assertion with no matching azp", () => {
    assert.equal(checkClaims(claims({ aud: ["ontrak", "ontrak-tix"] }), CHECK).ok, false);
    assert.equal(
      checkClaims(claims({ aud: ["ontrak", "ontrak-tix"], azp: "ontrak" }), CHECK).ok, true);
  });

  it("refuses a replayed nonce", () => {
    assert.equal(checkClaims(claims({ nonce: "another" }), CHECK).ok, false);
    assert.equal(checkClaims(claims({ nonce: undefined }), CHECK).ok, false);
  });

  it("refuses an expired or not-yet-valid assertion, but tolerates a small skew", () => {
    assert.equal(checkClaims(claims({ exp: NOW - 3600 }), CHECK).ok, false);
    assert.equal(checkClaims(claims({ iat: NOW + 3600 }), CHECK).ok, false);
    assert.equal(checkClaims(claims({ nbf: NOW + 3600 }), CHECK).ok, false);
    assert.equal(checkClaims(claims({ exp: NOW - 10 }), CHECK).ok, true);
  });

  it("refuses an unverified email, and a missing subject", () => {
    assert.equal(checkClaims(claims({ email_verified: false }), CHECK).ok, false);
    assert.equal(checkClaims(claims({ email: "" }), CHECK).ok, false);
    assert.equal(checkClaims(claims({ sub: "" }), CHECK).ok, false);
  });

  it("applies the domain rule when one is configured", () => {
    assert.equal(
      checkClaims(claims({ email: "x@elsewhere.test" }), { ...CHECK, allowedDomains: ["innotel.us"] }).ok,
      false);
    assert.equal(
      checkClaims(claims(), { ...CHECK, allowedDomains: ["innotel.us"] }).ok,
      true);
  });

  it("reads groups from either shape the provider sends", () => {
    const list = checkClaims(claims({ groups: ["a", "b"] }), CHECK);
    assert.ok(list.ok);
    if (list.ok) assert.deepEqual(list.groups, ["a", "b"]);
    const single = checkClaims(claims({ groups: "solo" }), CHECK);
    assert.ok(single.ok);
    if (single.ok) assert.deepEqual(single.groups, ["solo"]);
    const none = checkClaims(claims({}), CHECK);
    assert.ok(none.ok);
    if (none.ok) assert.deepEqual(none.groups, []);
  });

  it("writes refusals for the person who has to fix the configuration", () => {
    // Past the skew allowance, so this is a real expiry rather than clock drift.
    const checked = checkClaims(claims({ exp: NOW - 10 }), { ...CHECK, now: NOW + 200 });
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.reason, /expired/);
  });
});

/**
 * The role is derived, not stored — the bug that kept an administrator a student.
 *
 * The regression these cover is worth naming: the role used to be decided once and
 * written into a twelve-hour cookie, so somebody added to `ontrak-admins` after they
 * signed in stayed a STUDENT until the cookie expired, and no page said why. The
 * re-derivation is what makes a mapping change take effect on the next page load.
 */
describe("a role re-derived from the groups already on the session", () => {
  const mappings = parseRoleMappings(
    "ontrak-admins=ADMIN,ontrak-sysadmins=SYSADMIN,ontrak-desk=TECHNICIAN,ontrak-students=STUDENT",
  );

  it("promotes a session that now matches a higher-mapped group", () => {
    const before = { role: "STUDENT" as const, matched_group: "ontrak-students" };
    const next = roleForGroups(["ontrak-students", "ontrak-admins"], mappings, "STUDENT");
    assert.deepEqual(next, { role: "ADMIN", matched: "ontrak-admins" });
    assert.equal(roleChanged(before, next!), true);
  });

  it("follows a mapping change with the same groups — no new sign-in needed", () => {
    // The person's groups did not move; the *mapping* did. This is the case a stored
    // role could never get right.
    const before = { role: "STUDENT" as const, matched_group: null };
    const nowMapped = parseRoleMappings("ontrak-admins=ADMIN,range-instructors=INSTRUCTOR");
    const next = roleForGroups(["range-instructors"], nowMapped, "STUDENT");
    assert.deepEqual(next, { role: "INSTRUCTOR", matched: "range-instructors" });
    assert.equal(roleChanged(before, next!), true);
  });

  it("is a no-op when nothing moved, so no request sees a spurious change", () => {
    const before = { role: "ADMIN" as const, matched_group: "ontrak-admins" };
    const next = roleForGroups(["ontrak-admins"], mappings, "STUDENT");
    assert.deepEqual(next, { role: "ADMIN", matched: "ontrak-admins" });
    assert.equal(roleChanged(before, next!), false);
  });

  it("leaves a session with no groups alone, rather than demoting it to the default", () => {
    // A Sync or break-glass session carries no groups. Re-deriving those to the
    // default role would take an ADMIN's own portal away from them.
    assert.equal(roleForGroups([], mappings, "STUDENT"), null);
  });

  it("still falls back to the default when no group maps, and says so", () => {
    const before = { role: "STUDENT" as const, matched_group: null };
    const next = roleForGroups(["some-other-group"], mappings, "STUDENT");
    assert.deepEqual(next, { role: "STUDENT", matched: null });
    assert.equal(roleChanged(before, next!), false);
  });

  it("matches group names case-insensitively, the way the provider's claim varies", () => {
    const next = roleForGroups(["OnTrak-Admins"], mappings, "STUDENT");
    assert.equal(next?.role, "ADMIN");
  });
});

/**
 * The README's role table, held to the catalogue it documents.
 *
 * That table is what a person reads to decide which group to put somebody in, and the
 * catalogue is what the portal actually draws from, so the two disagreeing is a person
 * given a role that cannot reach what the page promised, or denied one that could.
 * They had: `SYSADMIN` reaches Genie (`PRODUCTS`), and the row said "the desk, Sentinel,
 * Sync" — one product short, in the table that answers "how is this role usually
 * granted". The table documents the catalogue itself, so unlike the operations guide it
 * includes the optional lab: it is the portal's answer for a role, not one deployment's.
 */
describe("the README's role table", () => {
  /** How the README writes each product's name, by catalogue key. */
  const CELL_NAME: Record<string, string> = {
    its: "training",
    tix: "the desk",
    sentinel: "Sentinel",
    sync: "Sync",
    genie: "Genie",
    lab: "the lab",
  };

  /** The table's rows as `{ role, products }`, read from the README under `## Roles`. */
  function rows(): { role: string; products: string }[] {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const [, afterHeading = ""] = readme.split(/^## Roles\s*$/m);
    const [section = ""] = afterHeading.split(/^## /m);
    return section
      .split("\n")
      .filter((line) => line.trimStart().startsWith("| `"))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return { role: (cells[1] ?? "").replace(/`/g, ""), products: cells[2] ?? "" };
      });
  }

  it("names exactly the products the catalogue shows each role", () => {
    const table = rows();
    assert.ok(table.length >= ROLES.length, `the README's role table yielded ${table.length} rows`);

    const unnamed = PRODUCTS.map((entry) => entry.key).filter((key) => !(key in CELL_NAME));
    assert.deepEqual(unnamed, [], `the README's role table has no name for: ${unnamed.join(", ")}`);

    const problems: string[] = [];
    for (const row of table) {
      const wanted = productsFor(row.role as Role).map((entry) => entry.key);
      const cell = row.products.toLowerCase();
      const said = PRODUCTS.filter(
        (entry) => cell.includes("everything") || cell.includes(CELL_NAME[entry.key].toLowerCase()),
      ).map((entry) => entry.key);

      const missing = wanted.filter((key) => !said.includes(key));
      const extra = said.filter((key) => !wanted.includes(key));
      if (missing.length > 0) problems.push(`${row.role} does not name ${missing.join(", ")}`);
      if (extra.length > 0) problems.push(`${row.role} names ${extra.join(", ")}, which is not shown that role`);
    }

    const absent = ROLES.filter((role) => !table.some((row) => row.role === role));
    if (absent.length > 0) problems.push(`no row for ${absent.join(", ")}`);

    assert.deepEqual(problems, [], problems.join("\n"));
  });
});
