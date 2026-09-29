/**
 * OnTrak Tix M2 tests: pushing the desk's people to the identity provider.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m2-scim-push.test.ts
 *
 * Four layers, because they fail differently: the pure plan, the wire shapes, the
 * HTTP client against a real SCIM server on a loopback port, and the service that
 * decides whose people and what gets recorded.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import type { AuditEventInput, AuditSink } from "../src/lib/audit-chain";
// Both are imported here for the ordering they create, which is the ordering a
// `tsx` script sees: `db.ts` pulls the adapter in while `db.ts` is still
// initialising. Building the people source at module scope threw `Cannot access
// 'prisma' before initialization` in exactly that order — invisible to the endpoint,
// which a bundler wires differently, and to the fakes below, which never touch
// `db.ts`. The import *is* the assertion.
import { prisma } from "../src/lib/db";
import { prismaScimPeople } from "../src/lib/scim-sync-store-prisma";
import type { IdentityUser } from "../src/lib/identity-service";
import { HttpScimClient, MemoryScimClient, ScimRequestError, type ScimClient } from "../src/lib/scim-client";
import {
  SCIM_TARGET_ENV,
  deactivatePatch,
  deskPerson,
  parseUserList,
  parseUserResource,
  personBody,
  planScimPush,
  scimErrorDetail,
  scimTargetFromEnv,
  userUrl,
  usersUrl,
  userNameFilter,
} from "../src/lib/scim-rules";
import { ScimSyncService, scimPushAudit, type ScimPeopleSource } from "../src/lib/scim-sync-service";
import { ScimPushCard } from "../src/components/ScimPushCard";

/* -------------------------------------------------------------------------- */
/*  The wiring a script needs                                                 */
/* -------------------------------------------------------------------------- */

test("scim push: the Prisma people source is built on demand, not at import", () => {
  // `npm run sweep:scim` reaches the sweep through this pair. A module-scope
  // `createPrismaScimPeople(prisma)` read the client before `db.ts` had declared it,
  // which broke the operator script while the endpoint kept working.
  assert.ok(prisma, "the shared client is initialised");
  assert.equal(typeof prismaScimPeople().listUsers, "function");
  assert.equal(prismaScimPeople(), prismaScimPeople(), "one source for the process");
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function person(overrides: Partial<IdentityUser> = {}): IdentityUser {
  return {
    id: "user-1",
    tenantId: "tenant-1",
    email: "sam.agent@acme.test",
    displayName: "Sam Agent",
    role: "AGENT",
    active: true,
    externalId: null,
    ...overrides,
  };
}

function people(users: IdentityUser[]): ScimPeopleSource {
  return { async listUsers() { return users; } };
}

function collect(): { sink: AuditSink; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { events, sink: { append: (event) => { events.push(event); return event; } } };
}

const MANAGER = { id: "admin-1", tenantId: "tenant-1", role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: "tenant-1", role: "AGENT" as const };

/* -------------------------------------------------------------------------- */
/*  The target, from the environment                                           */
/* -------------------------------------------------------------------------- */

test("scim push: no configured target means off, not a half-working button", () => {
  const off = scimTargetFromEnv({});
  assert.equal(off.enabled, false);
  assert.equal(off.target, null);
  assert.deepEqual(off.issues, []);
});

test("scim push: a half-configured target is an error rather than a fallback", () => {
  const noToken = scimTargetFromEnv({ [SCIM_TARGET_ENV.baseUrl]: "http://sentinel:8787" });
  assert.equal(noToken.target, null);
  assert.match(noToken.issues[0], /ONTRAK_TIX_SCIM_TOKEN/);

  const noUrl = scimTargetFromEnv({ [SCIM_TARGET_ENV.token]: "sc1_abcdef" });
  assert.equal(noUrl.target, null);
  assert.match(noUrl.issues[0], /ONTRAK_TIX_SCIM_BASE_URL/);

  const notAUrl = scimTargetFromEnv({ [SCIM_TARGET_ENV.baseUrl]: "sentinel:8787", [SCIM_TARGET_ENV.token]: "t" });
  assert.equal(notAUrl.target, null);
  assert.match(notAUrl.issues[0], /absolute http\(s\) URL/);
});

test("scim push: a configured target keeps its path and loses its trailing slash", () => {
  const configured = scimTargetFromEnv({
    [SCIM_TARGET_ENV.baseUrl]: "https://sentinel.test/scim-root/",
    [SCIM_TARGET_ENV.token]: "sc1_token",
  });
  assert.ok(configured.target);
  assert.equal(configured.target.baseUrl, "https://sentinel.test/scim-root");
  assert.equal(configured.target.token, "sc1_token");
  assert.equal(usersUrl(configured.target), "https://sentinel.test/scim-root/scim/v2/Users");
  assert.equal(
    usersUrl(configured.target, { filter: userNameFilter("a@b.test"), count: 2 }),
    "https://sentinel.test/scim-root/scim/v2/Users?filter=userName+eq+%22a%40b.test%22&count=2",
  );
});

test("scim push: a filter escapes what a user name may contain", () => {
  // A quote or a backslash in a directory value must not break out of the filter.
  assert.equal(userNameFilter('we"ird\\name'), 'userName eq "we\\"ird\\\\name"');
});

test("scim push: a user's URL cannot be turned into a path traversal", () => {
  const target = { baseUrl: "https://sentinel.test", token: "t" };
  assert.equal(userUrl(target, "../../admin"), "https://sentinel.test/scim/v2/Users/..%2F..%2Fadmin");
});

/* -------------------------------------------------------------------------- */
/*  What goes on the wire                                                      */
/* -------------------------------------------------------------------------- */

test("scim push: a person is named field by field, and carries no role", () => {
  const body = personBody(deskPerson(person()));
  assert.deepEqual(body, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    externalId: "user-1",
    userName: "sam.agent@acme.test",
    name: { formatted: "Sam Agent" },
    displayName: "Sam Agent",
    active: true,
  });
  // Roles are a deliberate omission: privilege at the provider is not a side
  // effect of a desk edit. If this ever changes, it should be a decision, not a
  // spread that quietly started sending them.
  assert.equal("roles" in body, false);
});

test("scim push: switching somebody off is the PATCH every directory sends", () => {
  assert.deepEqual(deactivatePatch(), {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
});

test("scim push: resources and errors are read the way the standard writes them", () => {
  assert.deepEqual(
    parseUserResource({ id: "p1", userName: "a@b.test", active: false, externalId: "user-1" }),
    { id: "p1", userName: "a@b.test", active: false, externalId: "user-1" },
  );
  assert.equal(parseUserResource({ id: "p1" }), null);
  assert.equal(parseUserResource(null), null);

  assert.deepEqual(
    parseUserList({ Resources: [{ id: "p1", userName: "a@b.test" }] }),
    [{ id: "p1", userName: "a@b.test", active: true, externalId: null }],
  );
  assert.equal(parseUserList({}), null);

  assert.equal(
    scimErrorDetail({ detail: "userName already exists", scimType: "uniqueness" }, 409),
    "userName already exists (uniqueness)",
  );
  assert.match(scimErrorDetail(null, 502), /502/);
});

/* -------------------------------------------------------------------------- */
/*  The plan                                                                  */
/* -------------------------------------------------------------------------- */

test("scim push: the plan is create, replace, deactivate or nothing at all", () => {
  const sam = deskPerson(person());

  assert.equal(planScimPush(sam, null).action, "CREATE");

  assert.equal(
    planScimPush(sam, { id: "p1", userName: sam.email, active: true, externalId: sam.id }).action,
    "NOOP",
  );

  // A renamed person: same provider id, new address.
  assert.equal(
    planScimPush(sam, { id: "p1", userName: "old@acme.test", active: true, externalId: sam.id }).action,
    "REPLACE",
  );

  // Somebody switched off at the desk, who the provider still has on.
  const gone = deskPerson(person({ active: false }));
  assert.equal(planScimPush(gone, { id: "p1", userName: sam.email, active: true, externalId: sam.id }).action, "DEACTIVATE");
  assert.equal(planScimPush(gone, { id: "p1", userName: sam.email, active: false, externalId: sam.id }).action, "NOOP");

  // Never provisioned and no longer at the desk: there is nothing to switch off,
  // and asking the provider to is how a sync gets a 404 on every quiet run.
  assert.equal(planScimPush(gone, null).action, "NOOP");

  // Switched off at the provider, but working here: the desk is the system of
  // record for its own people, so this is drift to close, not a decision to honour.
  assert.equal(
    planScimPush(sam, { id: "p1", userName: sam.email, active: false, externalId: sam.id }).action,
    "REPLACE",
  );
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

test("scim push: only a tenant manager may provision", async () => {
  const { sink } = collect();
  const service = new ScimSyncService(people([person()]), new MemoryScimClient(), sink);
  const refused = await service.push(AGENT);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /cannot provision/);
});

test("scim push: a deployment with nowhere to push says so", async () => {
  const service = new ScimSyncService(people([person()]), null);
  assert.equal(service.configured(), false);
  const refused = await service.push(MANAGER);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /no outbound identity provider/);
});

test("scim push: the scheduler pushes one tenant without a session of its own", async () => {
  const { sink, events } = collect();
  const provider = new MemoryScimClient();
  const asked: string[] = [];
  const source: ScimPeopleSource = {
    async listUsers(tenantId) {
      asked.push(tenantId);
      return [person({ tenantId })];
    },
  };
  const service = new ScimSyncService(source, provider, sink);

  // No actor: a cron has no session to authorize, so the deployment's own
  // configuration is what decides whether it may run at all.
  const result = await service.pushTenant("tenant-7");
  assert.ok(result.ok);
  assert.equal(result.value.created, 1);
  assert.deepEqual(asked, ["tenant-7"], "only the tenant it was asked about");
  // The write is still attributable, which is the point of auditing a system run.
  assert.equal(events[0].tenantId, "tenant-7");
  assert.equal(events[0].actor, "system:scim-sync");
});

test("scim push: a sweep with nowhere to push refuses rather than reporting success", async () => {
  const service = new ScimSyncService(people([person()]), null);
  const refused = await service.pushTenant("tenant-1");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /no outbound identity provider/);
});

test("scim push: the first run creates people, the second changes nothing", async () => {
  const { sink, events } = collect();
  const provider = new MemoryScimClient();
  const service = new ScimSyncService(
    people([person(), person({ id: "user-2", email: "dee@acme.test", displayName: "Dee Dispatcher", role: "DISPATCHER" })]),
    provider,
    sink,
  );

  const first = await service.push(MANAGER);
  assert.ok(first.ok);
  assert.equal(first.value.created, 2);
  assert.equal(first.value.unchanged, 0);
  assert.equal(first.value.failures.length, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].action, "identity.scim.push");
  assert.equal(events[0].targetId, "user-1");
  assert.equal(events[0].tenantId, "tenant-1");

  const second = await service.push(MANAGER);
  assert.ok(second.ok);
  assert.equal(second.value.created, 0);
  assert.equal(second.value.updated, 0);
  assert.equal(second.value.unchanged, 2);
  // A quiet run writes nothing, so the trail stays a record of changes.
  assert.equal(events.length, 2);
});

test("scim push: a person who left is switched off, and one who moved is updated", async () => {
  const { sink } = collect();
  const provider = new MemoryScimClient();
  provider.seed({ id: "p1", userName: "sam.agent@acme.test", active: true, externalId: "user-1" });
  provider.seed({ id: "p2", userName: "old.address@acme.test", active: true, externalId: "user-2" });

  const service = new ScimSyncService(
    people([
      person({ active: false }),
      person({ id: "user-2", email: "dee.moved@acme.test", displayName: "Dee Dispatcher" }),
    ]),
    provider,
    sink,
  );

  const result = await service.push(MANAGER);
  assert.ok(result.ok);
  assert.equal(result.value.deactivated, 1);
  assert.equal(result.value.updated, 1);

  const after = provider.all();
  assert.equal(after.find((entry) => entry.id === "p1")?.active, false);
  assert.equal(after.find((entry) => entry.id === "p2")?.userName, "dee.moved@acme.test");
});

test("scim push: one refusal is reported and does not abandon the rest", async () => {
  const { sink, events } = collect();
  const provider = new MemoryScimClient();
  // A provider that refuses one particular person, and answers normally for the rest.
  const failing: ScimClient = {
    findByUserName: (userName) => provider.findByUserName(userName),
    findByExternalId: (externalId) => provider.findByExternalId(externalId),
    create: async (entry) => {
      if (entry.email === "dee@acme.test") throw new ScimRequestError("userName already exists (uniqueness)", 409);
      return provider.create(entry);
    },
    replace: (id, entry) => provider.replace(id, entry),
    deactivate: (id) => provider.deactivate(id),
  };

  const service = new ScimSyncService(
    people([
      person({ id: "user-2", email: "dee@acme.test", displayName: "Dee Dispatcher" }),
      person({ id: "user-1", email: "sam.agent@acme.test", displayName: "Sam Agent" }),
    ]),
    failing,
    sink,
  );

  const result = await service.push(MANAGER);
  assert.ok(result.ok);
  assert.equal(result.value.failures.length, 1);
  assert.equal(result.value.failures[0].email, "dee@acme.test");
  assert.match(result.value.failures[0].reason, /uniqueness/);
  // Sam was after Dee in the list and was still provisioned.
  assert.equal(result.value.created, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].targetId, "user-1");
});

test("scim push: the audit entry keeps the two directions apart", () => {
  const plan = planScimPush(deskPerson(person()), null);
  const event = scimPushAudit("tenant-1", deskPerson(person()), plan, 1, "2026-10-22T00:00:00.000Z");
  assert.equal(event.action, "identity.scim.push");
  assert.equal(event.actor, "system:scim-sync");
  assert.equal(event.detail?.action, "CREATE");
});

/* -------------------------------------------------------------------------- */
/*  The HTTP client, against a real SCIM server                               */
/* -------------------------------------------------------------------------- */

interface FakeServer {
  url: string;
  requests: { method: string; url: string; authorization: string; body: unknown }[];
  close(): Promise<void>;
}

/** A SCIM server that answers the subset the sync uses, and refuses like one. */
async function startFakeScim(): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  let nextId = 1;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({
        method: request.method ?? "",
        url: `${url.pathname}${url.search}`,
        authorization: String(request.headers.authorization ?? ""),
        body: raw ? JSON.parse(raw) : null,
      });

      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/scim+json" });
        response.end(JSON.stringify(body));
      };

      if (request.headers.authorization !== "Bearer sc1_test") {
        return send(401, { detail: "A connector token is required.", status: "401" });
      }

      const collection = url.pathname.endsWith("/Users");
      if (collection && request.method === "GET") {
        const filter = url.searchParams.get("filter") ?? "";
        // The server is the authority; the client only gets to ask.
        const matches = filter.includes("duplicate@acme.test")
          ? [{ id: "p9", userName: "duplicate@acme.test", active: true, externalId: "user-9" }]
          : [];
        return send(200, { schemas: [], totalResults: matches.length, startIndex: 1, itemsPerPage: matches.length, Resources: matches });
      }
      if (collection && request.method === "POST") {
        if (JSON.stringify(requests[requests.length - 1].body).includes("duplicate@acme.test")) {
          return send(409, { detail: "userName already exists", scimType: "uniqueness", status: "409" });
        }
        return send(201, { ...(requests[requests.length - 1].body as object), id: `p${nextId++}` });
      }
      if (!collection && request.method === "PUT") {
        return send(200, { ...(requests[requests.length - 1].body as object), id: url.pathname.split("/").pop() });
      }
      if (!collection && request.method === "PATCH") {
        return send(200, { id: url.pathname.split("/").pop(), userName: "sam.agent@acme.test", active: false });
      }
      return send(404, { detail: "No such SCIM endpoint.", status: "404" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("scim push: the client speaks RFC 7644, token and all", async () => {
  const server = await startFakeScim();
  try {
    const client = new HttpScimClient({ baseUrl: server.url, token: "sc1_test" });
    const sam = deskPerson(person());

    assert.equal(await client.findByUserName(sam.email), null);

    const created = await client.create(sam);
    assert.equal(created.id, "p1");
    assert.equal(server.requests[1].method, "POST");
    assert.equal(server.requests[1].authorization, "Bearer sc1_test");
    assert.deepEqual((server.requests[1].body as { schemas: string[] }).schemas, [
      "urn:ietf:params:scim:schemas:core:2.0:User",
    ]);

    const replaced = await client.replace("p1", sam);
    assert.equal(replaced.id, "p1");
    assert.equal(server.requests[2].method, "PUT");
    assert.equal(server.requests[2].url, "/scim/v2/Users/p1");

    const off = await client.deactivate("p1");
    assert.equal(off.active, false);

    // A filter is sent as a query parameter, not interpolated into the path.
    assert.match(server.requests[0].url, /^\/scim\/v2\/Users\?filter=userName\+eq\+%22/);
  } finally {
    await server.close();
  }
});

test("scim push: a refusal carries the provider's own sentence and status", async () => {
  const server = await startFakeScim();
  try {
    const client = new HttpScimClient({ baseUrl: server.url, token: "sc1_test" });
    await assert.rejects(
      () => client.create(deskPerson(person({ email: "duplicate@acme.test" }))),
      (error: unknown) => {
        assert.ok(error instanceof ScimRequestError);
        assert.equal(error.status, 409);
        assert.match(error.message, /already exists \(uniqueness\)/);
        return true;
      },
    );

    const wrongToken = new HttpScimClient({ baseUrl: server.url, token: "nope" });
    await assert.rejects(() => wrongToken.findByUserName("a@b.test"), /A connector token is required/);
  } finally {
    await server.close();
  }
});

test("scim push: the sync drives the client end to end over HTTP", async () => {
  const server = await startFakeScim();
  try {
    const { sink } = collect();
    const service = new ScimSyncService(
      people([person()]),
      new HttpScimClient({ baseUrl: server.url, token: "sc1_test" }),
      sink,
    );
    const result = await service.push(MANAGER);
    assert.ok(result.ok);
    assert.equal(result.value.created, 1);
    assert.equal(result.value.failures.length, 0);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------------------- */
/*  The console card                                                          */
/* -------------------------------------------------------------------------- */

test("scim push: the card explains what to set, and offers nothing it cannot do", () => {
  const unconfigured = renderToStaticMarkup(
    createElement(ScimPushCard, {
      configured: false,
      issues: [],
      baseUrl: null,
      envVars: SCIM_TARGET_ENV,
      action: async () => {},
    }),
  );
  assert.match(unconfigured, /Not configured on this deployment/);
  assert.match(unconfigured, /ONTRAK_TIX_SCIM_BASE_URL/);
  assert.equal(unconfigured.includes("Push accounts to the provider"), false);

  const configured = renderToStaticMarkup(
    createElement(ScimPushCard, {
      configured: true,
      issues: [],
      baseUrl: "http://sentinel:8787",
      envVars: SCIM_TARGET_ENV,
      action: async () => {},
    }),
  );
  assert.match(configured, /Push accounts to the provider/);
  assert.match(configured, /http:\/\/sentinel:8787/);

  const broken = renderToStaticMarkup(
    createElement(ScimPushCard, {
      configured: false,
      issues: ["ONTRAK_TIX_SCIM_TOKEN is not set."],
      baseUrl: null,
      envVars: SCIM_TARGET_ENV,
      action: async () => {},
    }),
  );
  assert.match(broken, /ONTRAK_TIX_SCIM_TOKEN is not set\./);
});
