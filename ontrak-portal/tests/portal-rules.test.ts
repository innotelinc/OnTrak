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
import { describe, it } from "node:test";

import {
  asRole, canOpen, emptyStateFor, isRole, landingFor, parseRoleMappings, product,
  productsFor, roleChanged, roleForGroups, roleFromGroups, tilesFor, urlFor, PRODUCTS, ROLES,
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
    assert.deepEqual(productsFor("STUDENT").map((p) => p.key), ["its"]);
    assert.deepEqual(productsFor("INSTRUCTOR").map((p) => p.key), ["its"]);
    assert.deepEqual(productsFor("TECHNICIAN").map((p) => p.key), ["tix"]);
    assert.deepEqual(productsFor("ANALYST").map((p) => p.key), ["sentinel"]);
    assert.deepEqual(productsFor("SYSADMIN").map((p) => p.key), ["tix", "sentinel", "sync", "genie"]);
    assert.deepEqual(productsFor("ADMIN").map((p) => p.key), ["its", "tix", "sentinel", "sync", "genie"]);
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
    assert.deepEqual(tilesFor("STUDENT").map((tile) => tile.url),
      ["https://its.ontrak.innotel.us"]);
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
