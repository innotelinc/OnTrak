/**
 * OnTrak Tix M6 tests: the desk's own fields, and the form each queue shows.
 *
 * The feature is two halves of one question — *what does this desk want to know*, and
 * *which queue asks it* — so the tests follow both, and the ways they go wrong:
 *
 *  - **A field that exists and is on no form.** Defining one is not showing one, and the
 *    field list has to say which is which or a desk edits a field forever and never sees it.
 *  - **A key that changes.** Answers are stored under the key, so a rename that changed it
 *    would orphan every value already recorded; the service refuses and says why.
 *  - **A required field that is required everywhere or nowhere.** "Required" is a property of
 *    the *form*, which is what makes a per-queue layout worth having; the same field is
 *    optional on one queue and required on another, and the ticket path asks the same
 *    question wherever the ticket came from.
 *  - **Values that do not survive the round trip.** A number stored as `"007"`, a value
 *    under a key that no longer exists, a JSON column edited by hand — all of them have to
 *    read back as something the console can print.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/tix-m6-forms.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuditLog, type HashFn } from "../src/lib/audit-chain";
import {
  coerceValue,
  resolveLayout,
  validateField,
  validateLayout,
  validateStoredValues,
  validateValues,
  type CustomFieldRecord,
  type QueueFormRecord,
} from "../src/lib/form-rules";
import { FormService, MemoryFormStore } from "../src/lib/form-service";
import { customFieldKey, customFieldName, readCustomValues } from "../src/lib/form-payload";
import { toFieldRecord, toLayoutRecord, type CustomFieldRow, type QueueFormRow } from "../src/lib/form-store-prisma";
import { MemoryTicketStore, TicketService, type TicketFormGate } from "../src/lib/ticket-service";
import { toTicketCreate, toTicketRecord, type TicketRow } from "../src/lib/ticket-store-prisma";

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex");

/** The chain's records, which is where every "who changed what" answer comes from. */
const trail = (audit: AuditLog) => audit.snapshot().events;
const TENANT = "tenant-a";
const ADMIN = { id: "admin-1", tenantId: TENANT, role: "ADMIN" as const };
const AGENT = { id: "agent-1", tenantId: TENANT, role: "AGENT" as const };
const REQUESTER = { id: "user-1", tenantId: TENANT, role: "REQUESTER" as const };
const NOW = "2026-10-27T12:00:00.000Z";

function field(over: Partial<CustomFieldRecord> = {}): CustomFieldRecord {
  return {
    id: "field-1",
    tenantId: TENANT,
    key: "location",
    label: "Location",
    type: "TEXT",
    options: [],
    requiredByDefault: false,
    placeholder: "",
    helpText: "",
    archived: false,
    createdBy: ADMIN.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function layout(over: Partial<QueueFormRecord> = {}): QueueFormRecord {
  return {
    id: "layout-1",
    tenantId: TENANT,
    queueId: "queue-net",
    sections: [{ title: "Details", fieldKeys: ["location"] }],
    updatedBy: ADMIN.id,
    updatedAt: NOW,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/*  The rules                                                                 */
/* -------------------------------------------------------------------------- */

test("fields: a key is a key, and a choice field needs choices", () => {
  assert.equal(validateField({ key: "location", label: "Location", type: "TEXT" }).length, 0);

  // The key ends up in stored JSON, so it has a shape rather than a length.
  assert.equal(validateField({ key: "Change Window", label: "x", type: "TEXT" })[0].field, "key");
  assert.equal(validateField({ key: "1location", label: "x", type: "TEXT" })[0].field, "key");
  assert.equal(validateField({ key: "", label: "x", type: "TEXT" })[0].field, "key");

  const noChoices = validateField({ key: "room", label: "Room", type: "SELECT", options: ["One"] });
  assert.equal(noChoices[0].field, "options");
  assert.match(noChoices[0].message, /at least two/);

  const sameTwice = validateField({ key: "room", label: "Room", type: "SELECT", options: ["One", "one"] });
  assert.match(sameTwice[0].message, /read the same/);

  // Options on a field that has no choices are a mistake, not a harmless extra.
  assert.equal(validateField({ key: "note", label: "Note", type: "TEXT", options: ["a", "b"] })[0].field, "options");

  assert.equal(validateField({ key: "note", label: "Note", type: "NONSENSE" })[0].field, "type");
});

test("fields: a layout cannot name a field that is not there, twice, or require what it omits", () => {
  const fields = [field(), field({ id: "field-2", key: "change_window", label: "Change window" })];

  assert.equal(validateLayout([{ title: "Details", fieldKeys: ["location"] }], fields).length, 0);

  const unknown = validateLayout([{ title: "Details", fieldKeys: ["nope"] }], fields);
  assert.match(unknown[0].message, /not an active custom field/);

  const twice = validateLayout([{ title: "A", fieldKeys: ["location"] }, { title: "B", fieldKeys: ["location"] }], fields);
  assert.match(twice[0].message, /appears twice/);

  // A required key that is not on the form could never be satisfied — every ticket in the
  // queue would be unraisable rather than merely unvalidated.
  const unreachable = validateLayout([{ title: "Details", fieldKeys: ["location"], requiredKeys: ["change_window"] }], fields);
  assert.match(unreachable[0].message, /required but is not on this form/);

  // An archived field is not available to a new form either.
  const archived = validateLayout([{ title: "Details", fieldKeys: ["location"] }], [field({ archived: true })]);
  assert.match(archived[0].message, /not an active custom field/);

  assert.equal(validateLayout([], fields)[0].field, "sections");
});

test("fields: the form a queue shows is its own, the default's, or every field", () => {
  const fields = [
    field(),
    field({ id: "field-2", key: "change_window", label: "Change window" }),
    field({ id: "field-3", key: "retired", label: "Retired", archived: true }),
  ];
  const defaultLayout = layout({ id: "default", queueId: null, sections: [{ title: "General", fieldKeys: ["location"] }] });
  const netLayout = layout({
    sections: [{ title: "Network", fieldKeys: ["location", "change_window"], requiredKeys: ["change_window"] }],
  });

  // A queue with its own form gets exactly it, and its own required set.
  const net = resolveLayout(fields, [defaultLayout, netLayout], "queue-net");
  assert.equal(net.inherited, false);
  assert.deepEqual(net.sections[0].fields.map((entry) => entry.key), ["location", "change_window"]);
  assert.equal(net.fields.find((entry) => entry.key === "change_window")?.required, true);
  assert.equal(net.fields.find((entry) => entry.key === "location")?.required, false);

  // A queue without one shows the default, and says that it inherited.
  const other = resolveLayout(fields, [defaultLayout, netLayout], "queue-other");
  assert.equal(other.inherited, true);
  assert.deepEqual(other.fields.map((entry) => entry.key), ["location"]);

  // A desk that has only ever added fields shows all of them, in the order it made them,
  // and an archived one is not among them.
  const fresh = resolveLayout(fields, [], null);
  assert.deepEqual(fresh.fields.map((entry) => entry.key), ["location", "change_window"]);

  // A field archived after the layout was written is skipped rather than rendered stale.
  const stale = resolveLayout(fields, [layout({ sections: [{ title: "Details", fieldKeys: ["location", "retired"] }] })], "queue-net");
  assert.deepEqual(stale.fields.map((entry) => entry.key), ["location"]);
});

test("values: each type is checked as itself and stored canonically", () => {
  const number = field({ key: "seats", label: "Seats", type: "NUMBER" });
  assert.deepEqual(coerceValue(number, " 42 "), { ok: true, value: "42" });
  assert.deepEqual(coerceValue(number, "007"), { ok: true, value: "7" }, "a number is stored as the number it is");
  assert.equal(coerceValue(number, "0x10").ok, false, "hex is not what a person typed");
  assert.equal(coerceValue(number, "many").ok, false);
  assert.deepEqual(coerceValue(number, ""), { ok: true, value: "" }, "blank is allowed; required is the form's decision");

  const date = field({ key: "window", label: "Window", type: "DATE" });
  assert.deepEqual(coerceValue(date, "2026-11-01"), { ok: true, value: "2026-11-01" });
  assert.equal(coerceValue(date, "01/11/2026").ok, false);
  assert.equal(coerceValue(date, "2026-13-45").ok, false);

  const select = field({ key: "region", label: "Region", type: "SELECT", options: ["EMEA", "Americas"] });
  assert.deepEqual(coerceValue(select, "emea"), { ok: true, value: "EMEA" }, "a choice is matched case-insensitively and stored as spelled");
  assert.equal(coerceValue(select, "Mars").ok, false);

  const checkbox = field({ key: "approved", label: "Approved", type: "CHECKBOX" });
  assert.deepEqual(coerceValue(checkbox, "on"), { ok: true, value: "true" });
  assert.deepEqual(coerceValue(checkbox, undefined), { ok: true, value: "false" });
  assert.equal(coerceValue(checkbox, "maybe").ok, false);

  const text = field({ key: "note", label: "Note", type: "TEXT" });
  assert.equal(coerceValue(text, "x".repeat(2001)).ok, false);
});

test("values: unknown keys and missing required fields are refused by name", () => {
  const fields = [field(), field({ id: "f2", key: "seats", label: "Seats", type: "NUMBER", requiredByDefault: true })];
  const form = resolveLayout(fields, [], null);

  const missing = validateValues(form, { location: "Rack 4" });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.issues[0].field, "seats");
    assert.match(missing.issues[0].message, /required/);
  }

  const unknown = validateValues(form, { location: "Rack 4", seats: "2", gone: "x" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.issues[0].message, /not on this form/);

  const good = validateValues(form, { location: "Rack 4", seats: "2", });
  assert.ok(good.ok, good.ok ? "" : JSON.stringify(good.issues));
  assert.deepEqual(good.value, { location: "Rack 4", seats: "2" });

  // A *required* checkbox means somebody had to tick it.
  const tickbox = resolveLayout([field({ key: "approved", label: "Approved", type: "CHECKBOX", requiredByDefault: true })], [], null);
  assert.equal(validateValues(tickbox, {}).ok, false);
  assert.ok(validateValues(tickbox, { approved: "on" }).ok);

  // Not an object at all is refused rather than coerced into one.
  assert.equal(validateValues(form, ["location"]).ok, false);
  // And an empty form takes an empty object, which is what a desk with no fields posts.
  assert.ok(validateValues(resolveLayout([], [], null), {}).ok);
});

test("values: a stored ticket's values are shape-checked without any definitions", () => {
  assert.deepEqual(validateStoredValues(undefined), []);
  assert.deepEqual(validateStoredValues({ location: "Rack 4" }), []);
  assert.equal(validateStoredValues({ "Not A Key": "x" })[0].field, "Not A Key");
  assert.equal(validateStoredValues({ location: 4 })[0].field, "location");
  assert.equal(validateStoredValues({ location: "x".repeat(2001) })[0].field, "location");
  assert.equal(validateStoredValues("nope")[0].field, "customFields");
});

/* -------------------------------------------------------------------------- */
/*  The service                                                               */
/* -------------------------------------------------------------------------- */

function service() {
  const audit = new AuditLog(sha256);
  const store = new MemoryFormStore();
  return { audit, store, forms: new FormService(store, audit) };
}

test("service: defining a field is an administrator's act, and lands on the chain", async () => {
  const { forms, audit } = service();

  const denied = await forms.createField(AGENT, { key: "location", label: "Location", type: "TEXT" });
  assert.equal(denied.ok, false);

  const created = await forms.createField(ADMIN, { key: "Location", label: "Location", type: "TEXT" });
  assert.ok(created.ok, created.ok ? "" : created.error);
  assert.equal(created.value.key, "location", "the key is normalised, because it is what values are stored under");

  const duplicate = await forms.createField(ADMIN, { key: "location", label: "Where", type: "TEXT" });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /already exists/);

  const events = trail(audit).filter((event) => event.action === "form.field.create");
  assert.equal(events.length, 1);
  assert.equal(events[0].targetId, "location");
});

test("service: a key cannot change, a label can, and archiving is not deleting", async () => {
  const { forms, store, audit } = service();
  const created = await forms.createField(ADMIN, { key: "location", label: "Location", type: "TEXT" });
  assert.ok(created.ok, created.ok ? "" : created.error);

  const renamed = await forms.updateField(ADMIN, created.value.id, { key: "site", label: "Site" });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.match(renamed.error, /key cannot change/);

  const relabelled = await forms.updateField(ADMIN, created.value.id, { label: "Site" });
  assert.ok(relabelled.ok, relabelled.ok ? "" : relabelled.error);
  assert.equal(relabelled.value.label, "Site");
  assert.equal(relabelled.value.key, "location", "the values already recorded stay findable under the same key");

  const archived = await forms.archiveField(ADMIN, created.value.id, true);
  assert.ok(archived.ok, archived.ok ? "" : archived.error);
  assert.equal(archived.value.archived, true);
  assert.ok((await store.listFields(TENANT)).length > 0, "archiving keeps the field; there is no delete");
  assert.ok(trail(audit).some((event) => event.action === "form.field.archive"));
});

test("service: a queue's form is saved whole, and can be given back", async () => {
  const { forms, audit } = service();
  const location = await forms.createField(ADMIN, { key: "location", label: "Location", type: "TEXT" });
  assert.ok(location.ok, location.ok ? "" : location.error);
  const window_ = await forms.createField(ADMIN, { key: "change_window", label: "Change window", type: "DATE" });
  assert.ok(window_.ok, window_.ok ? "" : window_.error);

  const defaultForm = await forms.setLayout(ADMIN, {
    queueId: null,
    sections: [{ title: "Details", fieldKeys: ["location"] }],
  });
  assert.ok(defaultForm.ok, defaultForm.ok ? "" : defaultForm.error);
  assert.equal(defaultForm.value.id, `${TENANT}:default`, "the default form's id is derived, so two racing writes collapse");

  const net = await forms.setLayout(ADMIN, {
    queueId: "queue-net",
    sections: [{ title: "Network", fieldKeys: ["location", "change_window"], requiredKeys: ["change_window"] }],
  });
  assert.ok(net.ok, net.ok ? "" : net.error);

  // A bad layout is refused with the field named, and nothing is written.
  const bad = await forms.setLayout(ADMIN, { queueId: "queue-net", sections: [{ title: "Network", fieldKeys: ["gone"] }] });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /not an active custom field/);

  const netView = await forms.layoutFor(AGENT, "queue-net");
  assert.ok(netView.ok, netView.ok ? "" : netView.error);
  assert.equal(netView.value.fields.find((entry) => entry.key === "change_window")?.required, true);

  // Another queue inherits the default, and the page can say so.
  const other = await forms.layoutFor(AGENT, "queue-other");
  assert.ok(other.ok);
  assert.equal(other.value.inherited, true);
  assert.deepEqual(other.value.fields.map((entry) => entry.key), ["location"]);

  // Giving a queue its form back is a removal, and the default cannot be removed.
  assert.equal((await forms.removeLayout(ADMIN, null)).ok, false);
  assert.ok((await forms.removeLayout(ADMIN, "queue-net")).ok);
  const backToDefault = await forms.layoutFor(AGENT, "queue-net");
  assert.ok(backToDefault.ok);
  assert.equal(backToDefault.value.inherited, true);

  assert.ok(trail(audit).some((event) => event.action === "form.layout.set"));
  assert.ok(trail(audit).some((event) => event.action === "form.layout.remove"));
});

test("service: the field list says which fields are actually on a form", async () => {
  const { forms } = service();
  const location = await forms.createField(ADMIN, { key: "location", label: "Location", type: "TEXT" });
  assert.ok(location.ok);
  await forms.createField(ADMIN, { key: "spare", label: "Spare", type: "TEXT" });
  await forms.setLayout(ADMIN, { queueId: null, sections: [{ title: "Details", fieldKeys: ["location"] }] });

  const listed = await forms.fields(AGENT);
  assert.ok(listed.ok, listed.ok ? "" : listed.error);
  assert.equal(listed.value.find((entry) => entry.field.key === "location")?.usedByLayouts, 1);
  assert.equal(listed.value.find((entry) => entry.field.key === "spare")?.usedByLayouts, 0, "a field nobody shows is visible as such");
});

/* -------------------------------------------------------------------------- */
/*  The ticket path                                                           */
/* -------------------------------------------------------------------------- */

test("tickets: a required field is required wherever the ticket came from", async () => {
  const store = new MemoryTicketStore();
  const audit = new AuditLog(sha256);
  const forms = new FormService(new MemoryFormStore(), audit);
  await forms.createField(ADMIN, { key: "change_window", label: "Change window", type: "DATE", requiredByDefault: true });
  await forms.createField(ADMIN, { key: "location", label: "Location", type: "TEXT" });
  await forms.setLayout(ADMIN, { queueId: "queue-net", sections: [{ title: "Network", fieldKeys: ["change_window"] }] });
  // The desk's default form is what every other queue shows, and it does not ask for the
  // network queue's change window — which is the point of a per-queue layout at all.
  await forms.setLayout(ADMIN, { queueId: null, sections: [{ title: "Details", fieldKeys: ["location"] }] });

  const gate: TicketFormGate = {
    validateTicketValues: (tenantId, queueId, values) => forms.validateTicketValues(tenantId, queueId, values),
  };
  const tickets = new TicketService(store, audit, undefined, null, null, gate);

  // The queue's form requires it, so a ticket without it is refused and nothing is stored.
  const refused = await tickets.createTicket(REQUESTER, {
    subject: "Switch 4 is flapping",
    description: "Port 12 went down twice today.",
    type: "INCIDENT",
    priority: "NORMAL",
    queueId: "queue-net",
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /required/);
  assert.equal((await store.listTickets(TENANT)).length, 0);

  // A bad value is refused with its own sentence.
  const badDate = await tickets.createTicket(REQUESTER, {
    subject: "Switch 4 is flapping",
    description: "Port 12 went down twice today.",
    type: "INCIDENT",
    priority: "NORMAL",
    queueId: "queue-net",
    customFields: { change_window: "tomorrow" },
  });
  assert.equal(badDate.ok, false);
  if (!badDate.ok) assert.match(badDate.error, /YYYY-MM-DD/);

  const raised = await tickets.createTicket(REQUESTER, {
    subject: "Switch 4 is flapping",
    description: "Port 12 went down twice today.",
    type: "INCIDENT",
    priority: "NORMAL",
    queueId: "queue-net",
    customFields: { change_window: "2026-11-02" },
  });
  assert.ok(raised.ok, raised.ok ? "" : raised.error);
  assert.deepEqual(raised.value.customFields, { change_window: "2026-11-02" });

  // The ticket is stored with the values, and the create event names the fields rather
  // than reproducing them: the chain records that a form was answered, not the answers.
  const stored = await store.findTicket(TENANT, raised.value.id);
  assert.deepEqual(stored?.customFields, { change_window: "2026-11-02" });
  const created = trail(audit).find((event) => event.action === "ticket.create");
  assert.deepEqual((created?.detail as { customFields?: string[] }).customFields, ["change_window"]);

  // A queue that inherits the default form does not show the field, so it neither
  // requires it nor accepts it.
  const elsewhere = await tickets.createTicket(REQUESTER, {
    subject: "Laptop will not boot",
    description: "No power light.",
    type: "INCIDENT",
    priority: "NORMAL",
  });
  assert.ok(elsewhere.ok, elsewhere.ok ? "" : elsewhere.error);
  assert.equal(elsewhere.value.customFields, undefined, "no fields answered, and the record is shaped as it always was");

  const smuggle = await tickets.createTicket(REQUESTER, {
    subject: "Laptop will not boot",
    description: "No power light.",
    type: "INCIDENT",
    priority: "NORMAL",
    customFields: { change_window: "2026-11-02" },
  });
  assert.equal(smuggle.ok, false, "a value for a field this queue's form does not show is refused");
});

test("tickets: a desk with no custom fields behaves exactly as it did", async () => {
  const store = new MemoryTicketStore();
  const audit = new AuditLog(sha256);
  const tickets = new TicketService(store, audit);

  const raised = await tickets.createTicket(REQUESTER, {
    subject: "Printer is offline",
    description: "The third-floor printer stopped answering.",
    type: "INCIDENT",
    priority: "NORMAL",
  });
  assert.ok(raised.ok, raised.ok ? "" : raised.error);
  assert.equal(raised.value.customFields, undefined);
  assert.deepEqual(Object.keys(raised.value).includes("customFields"), false, "the key is absent, not an empty object");
});

test("payload: a desk may name a field anything without colliding with the form", () => {
  const data = new FormData();
  data.set("subject", "Switch 4 is flapping");
  data.set(customFieldName("subject"), "the desk's own subject");
  data.set(customFieldName("priority"), "P2");
  data.set(customFieldName("change_window"), "2026-11-02");
  data.set("unrelated", "ignored");

  assert.deepEqual(readCustomValues(data), {
    subject: "the desk's own subject",
    priority: "P2",
    change_window: "2026-11-02",
  });

  // A repeated name is one answer, and the last one is what the person typed.
  const repeated = new FormData();
  repeated.append(customFieldName("location"), "Rack 4");
  repeated.append(customFieldName("location"), "Rack 5");
  assert.deepEqual(readCustomValues(repeated), { location: "Rack 5" });

  assert.equal(customFieldKey("subject"), null);
  assert.equal(customFieldKey(customFieldName("")), null);
  assert.equal(customFieldKey("custom:key"), "key", "a field may even be called “key”");
});

/* -------------------------------------------------------------------------- */
/*  The adapters' mappers                                                     */
/* -------------------------------------------------------------------------- */

test("store: a field row with junk in it reads as something the page can render", () => {
  const row: CustomFieldRow = {
    id: "field-1",
    tenantId: TENANT,
    key: "location",
    label: "Location",
    type: "nonsense",
    options: null,
    requiredByDefault: false,
    placeholder: "",
    helpText: "",
    archived: false,
    createdBy: ADMIN.id,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  const record = toFieldRecord(row);
  assert.equal(record.type, "TEXT", "a type the domain does not know must not make the page throw");
  assert.deepEqual(record.options, []);

  const layoutRow: QueueFormRow = {
    id: "layout-1",
    tenantId: TENANT,
    queueId: "queue-net",
    sections: [{ title: "Details", fieldKeys: ["location", 7], requiredKeys: ["location", false] }, "junk", { fieldKeys: ["x"] }],
    updatedBy: ADMIN.id,
    updatedAt: new Date(NOW),
  };
  const layoutRecord = toLayoutRecord(layoutRow);
  assert.equal(layoutRecord.sections.length, 1, "a section with no title is not a section");
  assert.deepEqual(layoutRecord.sections[0].fieldKeys, ["location"]);
  assert.deepEqual(layoutRecord.sections[0].requiredKeys, ["location"]);
});

test("store: custom values survive the ticket round trip, and junk does not", () => {
  const ticketRow = {
    id: "t1",
    tenantId: TENANT,
    ref: "TIX-000001",
    subject: "Switch 4 is flapping",
    description: "Port 12 went down twice today.",
    type: "INCIDENT",
    status: "NEW",
    priority: "NORMAL",
    requesterId: "user-1",
    assigneeId: null,
    queueId: "queue-net",
    clientId: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    slaPauses: [],
    tags: [],
    customFields: { change_window: "2026-11-02", "Not A Key": "x", count: 3 },
  } as unknown as TicketRow;
  assert.deepEqual(toTicketRecord(ticketRow).customFields, { change_window: "2026-11-02" });

  // A ticket with none has no key at all, which is what a record written before fields
  // existed looks like and what the store must keep looking like.
  const bare = { ...ticketRow, customFields: null } as unknown as TicketRow;
  assert.equal(toTicketRecord(bare).customFields, undefined);

  // And the write side stores exactly what it was given.
  const write = toTicketCreate({ ...toTicketRecord(ticketRow), customFields: { location: "Rack 4" } } as never);
  assert.deepEqual(write.customFields, { location: "Rack 4" });
  assert.deepEqual(toTicketCreate(toTicketRecord(bare) as never).customFields, {});
});
