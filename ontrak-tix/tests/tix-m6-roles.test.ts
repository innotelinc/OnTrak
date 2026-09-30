/**
 * Granular roles (M6).
 *
 * The suite is built around the one property the whole feature rests on: **a tenant role can
 * only ever take something away.** So every "the desk may now do X" case is paired with the case
 * that must not be possible — a permission the built-in role does not hold, a role authored on a
 * different base role than its holder's, an unknown permission waiting in a row for a later
 * release to start honouring, and the change that would leave the desk with nobody who may
 * administer it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { actorHasPermission, hasPermission, permissionsFor, type Actor, type Role } from "../src/lib/access-rules";
import { AuditLog } from "../src/lib/audit-chain";
import {
  administrationHeld,
  effectivePermissionSet,
  effectivePermissions,
  MAX_TENANT_ROLES,
  normalizeRoleKey,
  permissionLabel,
  roleAudit,
  roleSummary,
  validateTenantRole,
  withAssignment,
  withRole,
  type RoleMember,
  type TenantRole,
} from "../src/lib/role-rules";
import {
  MemoryRoleStore,
  RoleService,
  systemRoleIds,
  withEffectivePermissions,
  type RoleStore,
} from "../src/lib/role-service";
import { toTenantRole, toRoleMember, type TenantRoleRow } from "../src/lib/role-store-prisma";
import { sha256Hex } from "../src/lib/ticket-store-prisma";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const TENANT = "tenant-1";

function member(overrides: Partial<RoleMember> = {}): RoleMember {
  return {
    id: "user-1",
    tenantId: TENANT,
    email: "agent@desk.test",
    displayName: "Ada Agent",
    role: "AGENT",
    active: true,
    tenantRoleId: null,
    ...overrides,
  };
}

function role(overrides: Partial<TenantRole> = {}): TenantRole {
  return {
    id: "role-1",
    tenantId: TENANT,
    key: "senior-agent",
    name: "Senior agent",
    description: null,
    baseRole: "AGENT",
    permissions: ["ticket:create", "ticket:read", "ticket:read:any", "ticket:reply", "ticket:update"],
    archivedAt: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return { id: "user-1", tenantId: TENANT, role: "ADMIN", ...overrides };
}

function service(store: RoleStore, audit = new AuditLog(sha256Hex)): RoleService {
  return new RoleService(store, systemRoleIds(), audit);
}

/* -------------------------------------------------------------------------- */
/*  Narrowing, and only narrowing                                             */
/* -------------------------------------------------------------------------- */

test("roles: a role holds the intersection of what it asks for and what its base role has", () => {
  // `ticket:delete` is an ADMIN power, so an AGENT-based role asking for it does not get it.
  const held = effectivePermissions("AGENT", ["ticket:update", "ticket:delete", "not-a-permission"]);
  assert.deepEqual(held, ["ticket:update"]);
  assert.ok(!held.includes("ticket:delete" as never));
});

test("roles: the intersection is returned in catalogue order, so two equal roles compare equal", () => {
  const a = effectivePermissions("DISPATCHER", ["ticket:reply", "ticket:create"]);
  const b = effectivePermissions("DISPATCHER", ["ticket:create", "ticket:reply"]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["ticket:create", "ticket:reply"]);
});

test("roles: a role based on ADMIN keeps every administration power it was given", () => {
  const held = effectivePermissions("ADMIN", ["tenant:manage", "user:manage", "audit:read"]);
  assert.deepEqual(held, ["user:manage", "tenant:manage", "audit:read"]);
});

test("roles: a person with no tenant role keeps exactly their built-in role", () => {
  const base = effectivePermissionSet("AGENT", null);
  assert.deepEqual(base, permissionsFor("AGENT"));
  assert.ok(base.includes("ticket:close"));
  assert.ok(!base.includes("ticket:delete"));
  // An empty role is a real narrowing, not a missing one: nothing is kept.
  assert.deepEqual(effectivePermissionSet("AGENT", role({ permissions: [] })), []);
});

test("roles: an archived role stops narrowing, and its holder falls back to the built-in role", () => {
  const archived = role({ archivedAt: "2026-09-30T00:00:00.000Z", permissions: ["ticket:read"] });
  assert.deepEqual(effectivePermissionSet("AGENT", archived), effectivePermissionSet("AGENT", null));
});

test("roles: a role authored on somebody else's base role does not narrow them", () => {
  // The row says DISPATCHER; the holder is an AGENT. The holder's own role wins, because
  // `baseRole` must not be a second way to spell somebody's job.
  const dispatcherRole = role({ baseRole: "DISPATCHER", permissions: ["ticket:read"] });
  assert.deepEqual(effectivePermissionSet("AGENT", dispatcherRole), effectivePermissionSet("AGENT", null));
});

test("roles: an actor carrying a resolved set is judged by it, and one that is not is judged by role", () => {
  const narrowed: Actor = { id: "u", tenantId: TENANT, role: "AGENT", permissions: ["ticket:read"] };
  assert.equal(actorHasPermission(narrowed, "ticket:read"), true);
  assert.equal(actorHasPermission(narrowed, "ticket:close"), false);
  // No `permissions` at all is every actor that existed before tenant roles did.
  assert.equal(actorHasPermission({ id: "u", tenantId: TENANT, role: "AGENT" }, "ticket:close"), true);
  assert.equal(hasPermission("AGENT", "ticket:close"), true);
  // An empty set is a real narrowing, not a missing one — the difference the tuple matters for.
  assert.equal(actorHasPermission({ id: "u", tenantId: TENANT, role: "AGENT", permissions: [] }, "ticket:read"), false);
});

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

test("roles: a key is normalized, and a bad one is refused", () => {
  assert.equal(normalizeRoleKey("Senior Agent"), "senior-agent");
  assert.equal(normalizeRoleKey("  Night-Shift  "), "night-shift");
  assert.deepEqual(validateTenantRole({ key: "Senior Agent", name: "Senior agent", baseRole: "AGENT", permissions: [] }), []);
  assert.match(validateTenantRole({ key: "x", name: "X", baseRole: "AGENT", permissions: [] })[0], /two to forty/);
  assert.match(
    validateTenantRole({ key: "senior-agent", name: "Senior", baseRole: "AGENT", permissions: [] }, ["senior-agent"])[0],
    /already exists/,
  );
});

test("roles: a role needs a name and a base role this release knows", () => {
  assert.match(validateTenantRole({ key: "a-b", name: "", baseRole: "AGENT", permissions: [] })[0], /Give the role a name/);
  const noBase = validateTenantRole({ key: "a-b", name: "Fine", permissions: [] });
  assert.match(noBase[0], /built-in role/);
  const badBase = validateTenantRole({ key: "a-b", name: "Fine", baseRole: "SUPERUSER" as Role, permissions: [] });
  assert.match(badBase[0], /built-in role/);
});

test("roles: an unknown permission is reported, and then dropped rather than honoured", () => {
  const problems = validateTenantRole({
    key: "a-b",
    name: "Fine",
    baseRole: "AGENT",
    permissions: ["ticket:read", "ticket:launch-missiles"],
  });
  assert.match(problems[0], /does not know the permission: ticket:launch-missiles/);
  assert.deepEqual(effectivePermissions("AGENT", ["ticket:read", "ticket:launch-missiles"]), ["ticket:read"]);
});

test("roles: the summary says what a role takes away, in the words the screen uses", () => {
  assert.equal(roleSummary(role({ permissions: ["ticket:create", "ticket:read", "ticket:read:any", "ticket:reply", "ticket:update"] })), "Based on AGENT, without close.");
  assert.equal(roleSummary(role({ permissions: [] })), "Based on AGENT, with every permission withdrawn.");
  assert.match(roleSummary(role({ baseRole: "REQUESTER", permissions: ["ticket:create", "ticket:read", "ticket:reply"] })), /taking nothing away/);
  assert.equal(permissionLabel("ticket:delete"), "Delete");
});

/* -------------------------------------------------------------------------- */
/*  The guard that keeps a desk administered                                  */
/* -------------------------------------------------------------------------- */

test("roles: administration is held only by an active member who actually keeps it", () => {
  const admin = role({ id: "r-admin", baseRole: "ADMIN", permissions: ["tenant:manage"] });
  const administrator = member({ id: "a", role: "ADMIN", tenantRoleId: "r-admin" });
  assert.equal(administrationHeld([administrator], [admin]), true);
  // A narrowing role that dropped the permission is not the way back in.
  const narrowed = role({ id: "r-narrow", baseRole: "ADMIN", permissions: ["ticket:read"] });
  assert.equal(administrationHeld([member({ id: "a", role: "ADMIN", tenantRoleId: "r-narrow" })], [narrowed]), false);
  // And a deactivated administrator is not one either.
  assert.equal(administrationHeld([{ ...administrator, active: false }], [admin]), false);
  // A member whose role has been archived is back on their built-in role, which is an ADMIN's.
  assert.equal(administrationHeld([administrator], [role({ id: "r-admin", archivedAt: "2026-09-30T00:00:00.000Z" })]), true);
});

test("roles: the guard's picture can be moved forward without mutating it", () => {
  const members = [member({ id: "a", role: "ADMIN" }), member({ id: "b" })];
  const moved = withAssignment(members, "a", "r-narrow");
  assert.equal(members[0].tenantRoleId, null, "the original list is untouched");
  assert.equal(moved[0].tenantRoleId, "r-narrow");
  assert.equal(moved[1].tenantRoleId, null);

  const roles = [role({ id: "r-1", permissions: ["ticket:read"] })];
  assert.deepEqual(withRole(roles, "r-1", null), []);
  assert.deepEqual(withRole(roles, "r-1", { baseRole: "AGENT", permissions: [] })[0].permissions, []);
  assert.deepEqual(roles[0].permissions, ["ticket:read"], "the original role is untouched");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("roles: managing roles is `user:manage`, and the catalogue is not open to an agent", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  const refused = await roles.overview(actor({ role: "AGENT" }));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /cannot manage roles/);
  const allowed = await roles.overview(actor({ role: "DISPATCHER" }));
  assert.equal(allowed.ok, true);
  assert.ok(allowed.ok && allowed.value.catalogue.length > 0);
});

test("roles: a saved role is stored already narrowed, so the row cannot disagree with the rule", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  const saved = await roles.save(actor(), {
    key: "Senior Agent",
    name: "Senior agent",
    baseRole: "AGENT",
    // `ticket:delete` and `tenant:manage` are both beyond an agent.
    permissions: ["ticket:update", "ticket:delete", "tenant:manage"],
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.ok ? saved.value.permissions : null, ["ticket:update"]);
  assert.equal(saved.ok ? saved.value.key : null, "senior-agent");
  assert.deepEqual((await store.list(TENANT))[0].permissions, ["ticket:update"]);
});

test("roles: a key is fixed once written, and the rest of a role is an ordinary edit", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  const created = await roles.save(actor(), { key: "night", name: "Night", baseRole: "AGENT", permissions: ["ticket:read"] });
  assert.ok(created.ok);
  if (!created.ok) return;

  const edited = await roles.save(
    actor(),
    { key: "renamed", name: "Night shift", baseRole: "AGENT", permissions: ["ticket:read", "ticket:reply"] },
    created.value.id,
  );
  assert.ok(edited.ok);
  assert.equal(edited.ok ? edited.value.key : null, "night", "the key names the role in the audit trail");
  assert.equal(edited.ok ? edited.value.name : null, "Night shift");
  assert.deepEqual(edited.ok ? edited.value.permissions : null, ["ticket:read", "ticket:reply"]);
});

test("roles: a duplicate key is refused, and an edit does not collide with itself", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  const first = await roles.save(actor(), { key: "night", name: "Night", baseRole: "AGENT", permissions: [] });
  assert.ok(first.ok);
  const dupe = await roles.save(actor(), { key: "night", name: "Other", baseRole: "AGENT", permissions: [] });
  assert.equal(dupe.ok, false);
  if (!first.ok) return;
  const own = await roles.save(actor(), { key: "night", name: "Night shift", baseRole: "AGENT", permissions: [] }, first.value.id);
  assert.equal(own.ok, true);
});

test("roles: the last administrator cannot be narrowed away, and somebody else fixes that first", async () => {
  const adminRole = role({ id: "r-admin", key: "admin", baseRole: "ADMIN", permissions: ["tenant:manage", "user:manage"] });
  const store = new MemoryRoleStore([member({ id: "admin-1", role: "ADMIN", tenantRoleId: "r-admin" })]);
  const roles = service(store);
  await store.insert(adminRole);

  const refused = await roles.save(
    actor(),
    { key: "admin", name: "Administrator", baseRole: "ADMIN", permissions: ["ticket:read"] },
    "r-admin",
  );
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /nobody able to administer/);
  // Nothing was written.
  assert.equal((await store.find(TENANT, "r-admin"))?.permissions.length, 2);

  // Give the permission to somebody else, and the same edit becomes ordinary.
  const second = member({ id: "admin-2", role: "ADMIN" });
  store.people.push(second);
  const allowed = await roles.save(
    actor(),
    { key: "admin", name: "Administrator", baseRole: "ADMIN", permissions: ["ticket:read"] },
    "r-admin",
  );
  assert.equal(allowed.ok, true);
});

test("roles: archiving a role cannot strand the desk, because it can only give power back", async () => {
  // The last administrator holds a narrowing ADMIN role. Archiving it returns them to the built-in
  // ADMIN role, which is a superset — so this is allowed, and it is *why* `archive` has no guard.
  const adminRole = role({ id: "r-admin", key: "admin", baseRole: "ADMIN", permissions: ["tenant:manage"] });
  const store = new MemoryRoleStore([member({ id: "admin-1", role: "ADMIN", tenantRoleId: "r-admin" })]);
  await store.insert(adminRole);
  const roles = service(store);

  const archived = await roles.archive(actor(), "r-admin");
  assert.equal(archived.ok, true);
  assert.ok(archived.ok && archived.value.archivedAt);
  // And the holder is back to the full built-in role, which is the widening the guard would have
  // been checking for the absence of.
  assert.equal(
    effectivePermissionSet("ADMIN", await store.assignedRole(TENANT, "admin-1")).includes("tenant:manage"),
    true,
  );

  const unused = role({ id: "r-unused", key: "unused", baseRole: "AGENT", permissions: [] });
  await store.insert(unused);
  const allowed = await roles.archive(actor(), "r-unused");
  assert.equal(allowed.ok, true);
  assert.ok(allowed.ok && allowed.value.archivedAt);
  // Archiving twice is a no-op rather than an error, so a double submit does not look like a bug.
  assert.equal((await roles.archive(actor(), "r-unused")).ok, true);
});

test("roles: assigning a narrow role to the last administrator is the other way to strand the desk", async () => {
  const adminRole = role({ id: "r-admin", key: "admin", baseRole: "ADMIN", permissions: ["tenant:manage"] });
  const narrowRole = role({ id: "r-narrow", key: "narrow", baseRole: "ADMIN", permissions: ["ticket:read"] });
  const store = new MemoryRoleStore([member({ id: "admin-1", role: "ADMIN", tenantRoleId: "r-admin" })]);
  const roles = service(store);
  await store.insert(adminRole);
  await store.insert(narrowRole);

  const refused = await roles.assign(actor(), "admin-1", "r-narrow");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /nobody able to administer/);

  const off = await roles.assign(actor(), "admin-1", null);
  assert.equal(off.ok, true);
});

test("roles: an assignment refuses an unknown person, an unknown role and an archived one", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  await store.insert(role({ id: "r-archived", archivedAt: "2026-09-30T00:00:00.000Z" }));

  const refusedFor = async (userId: string, roleId: string | null) => {
    const result = await roles.assign(actor(), userId, roleId);
    return result.ok ? "" : result.error;
  };
  assert.match(await refusedFor("nobody", null), /not on this desk/);
  assert.match(await refusedFor("user-1", "r-nope"), /does not exist/);
  assert.match(await refusedFor("user-1", "r-archived"), /archived/);
});

test("roles: the overview counts holders and reports who holds what", async () => {
  const store = new MemoryRoleStore([
    member({ id: "user-1", tenantRoleId: "role-1" }),
    member({ id: "user-2", displayName: "Bo", tenantRoleId: null }),
    // Somebody who administers the desk, so the guard's own answer is the honest `true`.
    member({ id: "user-3", displayName: "Cy Admin", role: "ADMIN" }),
  ]);
  await store.insert(role());
  const overview = await service(store).overview(actor());
  assert.ok(overview.ok);
  if (!overview.ok) return;
  assert.equal(overview.value.roles[0].holders, 1);
  assert.equal(overview.value.members.find((entry) => entry.id === "user-1")?.roleName, "Senior agent");
  assert.equal(overview.value.members.find((entry) => entry.id === "user-2")?.roleName, null);
  assert.equal(overview.value.administered, true, "Cy administers the desk and no role narrows them");
  assert.ok(overview.value.catalogue.every((entry) => typeof entry.inBaseRole === "object"));
});

/* -------------------------------------------------------------------------- */
/*  Resolving what somebody may actually do                                   */
/* -------------------------------------------------------------------------- */

test("roles: an actor is resolved from the store, on the way into a request", async () => {
  const store = new MemoryRoleStore([member({ id: "user-1", tenantRoleId: "role-1" })]);
  await store.insert(role({ id: "role-1", permissions: ["ticket:read"] }));

  const resolved = await withEffectivePermissions(store, member({ id: "user-1" }));
  assert.deepEqual(resolved.permissions, ["ticket:read"]);
  assert.equal(actorHasPermission(resolved, "ticket:close"), false);
});

test("roles: an actor with no assignment, and a caller with no store, are both unchanged", async () => {
  const store = new MemoryRoleStore([member()]);
  const base = await withEffectivePermissions(store, { id: "user-1", tenantId: TENANT, role: "AGENT" });
  assert.deepEqual(base.permissions, effectivePermissionSet("AGENT", null));
  const untouched: Actor = { id: "user-1", tenantId: TENANT, role: "AGENT" };
  assert.equal(await withEffectivePermissions(null, untouched), untouched);
});

/* -------------------------------------------------------------------------- */
/*  The row mappers                                                           */
/* -------------------------------------------------------------------------- */

test("roles: a base role the release does not know reads as the least powerful role there is", () => {
  const row: TenantRoleRow = {
    id: "r",
    tenantId: TENANT,
    key: "k",
    name: "K",
    description: null,
    baseRole: "SUPERUSER",
    permissions: ["ticket:read"],
    archivedAt: null,
    createdAt: new Date("2026-09-30T00:00:00Z"),
    updatedAt: new Date("2026-09-30T00:00:00Z"),
  };
  assert.equal(toTenantRole(row).baseRole, "REQUESTER");
  // An unknown permission is dropped rather than carried for a later release to honour.
  assert.deepEqual(toTenantRole({ ...row, permissions: ["ticket:read", "ticket:launch-missiles"] }).permissions, ["ticket:read"]);
  assert.equal(toTenantRole(row).createdAt, "2026-09-30T00:00:00.000Z");
  assert.equal(toTenantRole({ ...row, archivedAt: new Date("2026-09-30T01:00:00Z") }).archivedAt, "2026-09-30T01:00:00.000Z");
});

test("roles: a member row with an unknown role reads as a requester", () => {
  const mapped = toRoleMember({
    id: "u",
    tenantId: TENANT,
    email: "a@desk.test",
    displayName: "A",
    role: "SUPERUSER",
    active: true,
    tenantRoleId: null,
  });
  assert.equal(mapped.role, "REQUESTER");
  assert.equal(mapped.active, true);
});

/* -------------------------------------------------------------------------- */
/*  The audit trail                                                           */
/* -------------------------------------------------------------------------- */

test("roles: writing, archiving and assigning all land on the tenant's chain", async () => {
  const audit = new AuditLog(sha256Hex);
  const store = new MemoryRoleStore([member()]);
  const roles = service(store, audit);

  const created = await roles.save(actor(), { key: "night", name: "Night", baseRole: "AGENT", permissions: ["ticket:read"] });
  assert.ok(created.ok);
  if (!created.ok) return;
  await roles.assign(actor(), "user-1", created.value.id);
  await roles.archive(actor(), created.value.id);

  const events = audit.snapshot().events;
  assert.deepEqual(
    events.map((event) => event.action),
    ["role.create", "role.assign", "role.archive"],
  );
  assert.equal(events[1].targetType, "user");
  assert.equal(events[1].targetId, "agent@desk.test", "the entry names a person, not a row id");
  assert.equal(events[0].targetType, "role");
  assert.equal(events[0].targetId, "night");
  assert.deepEqual(events[0].detail?.permissions, ["ticket:read"]);
  assert.equal(events.every((event) => event.tenantId === TENANT), true);
  assert.deepEqual(audit.verify(), { ok: true, length: 3 });
});

test("roles: the builder names the actor and carries what a role kept", () => {
  const event = roleAudit("role.update", {
    tenantId: TENANT,
    actorId: "admin-1",
    targetId: "night",
    detail: { permissions: ["ticket:read"], previous: ["ticket:read", "ticket:reply"] },
    at: "2026-09-30T00:00:00.000Z",
  });
  assert.equal(event.actor, "admin-1");
  assert.equal(event.action, "role.update");
  assert.equal(event.targetType, "role");
  assert.equal(event.tenantId, TENANT);
  assert.ok(event.id.length > 0, "every entry carries its own id");
});

test("roles: a role written by somebody without the permission is refused before anything is written", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  const refused = await roles.save(actor({ role: "AGENT" }), {
    key: "night",
    name: "Night",
    baseRole: "AGENT",
    permissions: [],
  });
  assert.equal(refused.ok, false);
  assert.deepEqual(await store.list(TENANT), []);
});

/* -------------------------------------------------------------------------- */
/*  The ceiling                                                               */
/* -------------------------------------------------------------------------- */

test("roles: a desk cannot accumulate a dropdown nobody can read", async () => {
  const store = new MemoryRoleStore([member()]);
  const roles = service(store);
  for (let index = 0; index < MAX_TENANT_ROLES; index++) {
    const saved = await roles.save(actor(), {
      key: `role-${index}`,
      name: `Role ${index}`,
      baseRole: "AGENT",
      permissions: [],
    });
    assert.equal(saved.ok, true, `role ${index} should have been written`);
  }
  const refused = await roles.save(actor(), { key: "one-too-many", name: "One too many", baseRole: "AGENT", permissions: [] });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /fifty active roles/);
  assert.equal((await store.list(TENANT)).length, MAX_TENANT_ROLES);
});
