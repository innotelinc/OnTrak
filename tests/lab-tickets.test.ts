/**
 * The in-house ticket: the write-up a student hands in with their submission.
 *
 * Ported from `OnTrak-dev/tests/test_tickets.py`. The rubric is deliberately mechanical
 * (length, required terms, a dropdown), so these tests are about whether it *resists* the
 * lazy answer while accepting every reasonable one — and about the two properties that
 * matter beyond individual rules:
 *
 * - every rubric shipped in this repository must be **satisfiable**: a form nobody can
 *   score full marks on is a broken ticket, not a strict one, and the demo proves it in a
 *   second rather than a class discovering it;
 * - a form is **optional**, so a scenario that predates the ticket grades exactly as it did.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-tickets.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadScenarios } from "../src/lib/lab/dataset";
import { publicView } from "../src/lib/lab/scenarios";
import { synthesiseTicket } from "../src/lib/lab/demo";
import { InMemoryLabStore } from "../src/lib/lab/store";
import {
  MAX_TICKET_WEIGHT,
  RESERVED_FIELD_IDS,
  TicketError,
  WRITEUP_ACTION,
  blend,
  feedbackText,
  grade,
  loadForm,
  missingRequired,
  renderFeedback,
  ticketFieldFromDict,
  ticketFormPublic,
  ticketFormToDict,
  ticketGradeFromDict,
  ticketGradeSummaryLine,
  ticketGradeToDict,
  validateForm,
  wordCount,
  type TicketForm,
} from "../src/lib/lab/tickets";
import { newLabSession } from "../src/lib/lab/models";

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function formWith(fields: Record<string, unknown>[], weight = 30): TicketForm {
  const form = loadForm({ form: { weight, fields } });
  if (form === null) throw new Error("the fixture rubric must load");
  return form;
}

function simpleField(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cause",
    label: "Root cause",
    kind: "textarea",
    weight: 100,
    min_words: 3,
    any_of: ["dns", "resolver"],
    ...overrides,
  };
}

/** The lab's own shipped scenarios, which is what the rubric tests run against. */
function shipped(): ReturnType<typeof loadScenarios> {
  return loadScenarios();
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

test("tickets: no form means no ticket", () => {
  assert.equal(loadForm(null), null);
  assert.equal(loadForm({}), null);
  assert.equal(loadForm({ from: "someone", priority: "high" }), null);
});

test("tickets: a bare list of fields is accepted", () => {
  const form = loadForm({ form: [simpleField()] });
  assert.notEqual(form, null);
  assert.equal(form?.fields.length, 1);
});

test("tickets: field kind aliases and defaults", () => {
  assert.equal(ticketFieldFromDict({ id: "a", kind: "multiline" }).kind, "textarea");
  assert.equal(ticketFieldFromDict({ id: "b", kind: "dropdown" }).kind, "select");
  assert.equal(ticketFieldFromDict({ id: "c", type: "text" }).kind, "text");
  // An absent kind is a textarea, and an empty string is absent (Python's `or`).
  assert.equal(ticketFieldFromDict({ id: "d" }).kind, "textarea");
  assert.equal(ticketFieldFromDict({ id: "e", kind: "", type: "select" }).kind, "select");
  // A select with no explicit answer defaults to its first option.
  const field = ticketFieldFromDict({ id: "f", kind: "select", options: ["one", "two"] });
  assert.equal(field.expected, "one");
});

test("tickets: keywords accept a scalar, a list and a comma-separated string", () => {
  assert.deepEqual(ticketFieldFromDict({ id: "a", keywords: "dns" }).allOf, ["dns"]);
  assert.deepEqual(ticketFieldFromDict({ id: "b", keywords: ["dns", "dhcp"] }).allOf, ["dns", "dhcp"]);
  assert.deepEqual(ticketFieldFromDict({ id: "c", keywords: "dns, dhcp" }).allOf, ["dns", "dhcp"]);
});

test("tickets: a malformed form raises a TicketError", () => {
  assert.throws(() => loadForm({ form: "not a mapping or a list" }), TicketError);
});

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

test("tickets: a healthy form validates", () => {
  assert.deepEqual(validateForm(formWith([simpleField()])), []);
});

test("tickets: field weights must total one hundred", () => {
  const form = formWith([simpleField({ weight: 60 }), simpleField({ id: "other", weight: 20 })]);
  assert.ok(validateForm(form).some((problem) => problem.includes("not 100")));
});

test("tickets: the ticket's share is capped so the machine still decides", () => {
  const form = formWith([simpleField()], MAX_TICKET_WEIGHT + 10);
  assert.ok(
    validateForm(form).some((problem) => problem.includes("machine state is always the larger part")),
  );
});

test("tickets: a free-text field needs a rubric", () => {
  const form = formWith([simpleField({ required: false, min_words: 0, any_of: [], all_of: [] })]);
  assert.ok(validateForm(form).some((problem) => problem.includes("no rubric")));
});

test("tickets: duplicate field ids are reported", () => {
  const form = formWith([simpleField(), simpleField()]);
  assert.ok(validateForm(form).some((problem) => problem.includes("duplicate field id")));
});

test("tickets: a field id may not take a portal control name", () => {
  // The write-up's fields and its Save/Preview/Complete buttons are one HTML form, so a
  // field sharing a control name is submitted in the same slot — which is how a field
  // named `action` made *Save draft* submit the session.
  const reserved = validateForm(formWith([simpleField({ id: WRITEUP_ACTION })]));
  assert.ok(reserved.some((problem) => problem.includes("reserved")));
  assert.ok(validateForm(formWith([simpleField({ id: "csrf" })])).some((problem) => problem.includes("reserved")));
  // The name scenarios actually use is fine: only the portal's control is reserved.
  assert.deepEqual(validateForm(formWith([simpleField({ id: "action" })])), []);
  assert.equal(RESERVED_FIELD_IDS.has("action"), false);
});

test("tickets: a select without options is reported", () => {
  const form = formWith([
    { id: "class", label: "Class", kind: "select", weight: 100, expected: "x" },
  ]);
  assert.ok(validateForm(form).some((problem) => problem.includes("needs options")));
});

test("tickets: an empty form is reported", () => {
  const form = loadForm({ form: { fields: [] } });
  assert.ok(validateForm(form).some((problem) => problem.includes("no fields")));
});

/* -------------------------------------------------------------------------- */
/*  Grading                                                                   */
/* -------------------------------------------------------------------------- */

test("tickets: a blank required field fails and an optional blank passes", () => {
  const form = formWith([
    { id: "req", label: "Required", weight: 50, min_words: 2, any_of: ["x"] },
    { id: "opt", label: "Optional", weight: 50, required: false, any_of: ["y"] },
  ]);
  const result = grade(form, { req: "", opt: "" });
  const passed = Object.fromEntries(result.outcomes.map((outcome) => [outcome.fieldId, outcome.passed]));
  assert.deepEqual(passed, { req: false, opt: true });
  assert.equal(result.score, 50);
});

test("tickets: the minimum length is enforced", () => {
  const form = formWith([simpleField({ min_words: 10 })]);
  const short = grade(form, { cause: "dns was broken" });
  assert.equal(short.outcomes[0]?.passed, false);
  assert.ok(short.outcomes[0]?.detail.includes("word"));
  const long = grade(form, {
    cause: "the resolver address was set by hand and did not answer queries at all",
  });
  assert.equal(long.outcomes[0]?.passed, true);
});

test("tickets: any_of accepts a synonym", () => {
  const form = formWith([simpleField({ any_of: ["dns", "name resolution", "resolver"] })]);
  for (const answer of ["the DNS server was wrong", "name resolution failed", "the resolver was misconfigured"]) {
    assert.equal(grade(form, { cause: answer }).outcomes[0]?.passed, true, answer);
  }
});

test("tickets: all_of demands every term", () => {
  const form = formWith([simpleField({ all_of: ["chmod", "permission"], any_of: [] })]);
  assert.equal(grade(form, { cause: "changed the chmod for that file" }).outcomes[0]?.passed, false);
  assert.equal(grade(form, { cause: "chmod fixed the permission on the script" }).outcomes[0]?.passed, true);
});

test("tickets: rejected answers are caught", () => {
  const form = formWith([simpleField({ none_of: ["chmod 777", "reinstall"] })]);
  const result = grade(form, { cause: "dns was odd so I ran chmod 777 on the directory" });
  assert.equal(result.outcomes[0]?.passed, false);
  assert.ok(result.outcomes[0]?.detail.includes("rejected answer"));
});

test("tickets: a select must match the expected option", () => {
  const form = formWith([
    {
      id: "class",
      label: "Classification",
      kind: "select",
      weight: 100,
      options: ["Permissions", "Ownership"],
      expected: "Ownership",
    },
  ]);
  assert.equal(grade(form, { class: "Ownership" }).score, 100);
  const wrong = grade(form, { class: "Permissions" });
  assert.equal(wrong.score, 0);
  assert.ok(wrong.outcomes[0]?.detail.includes("correct classification"));
});

test("tickets: the score is a weighted percentage", () => {
  const form = formWith([
    { id: "a", label: "A", weight: 70, min_words: 1, any_of: ["x"] },
    { id: "b", label: "B", weight: 30, min_words: 1, any_of: ["y"] },
  ]);
  assert.equal(grade(form, { a: "x happened", b: "" }).score, 70);
});

test("tickets: no submission scores zero and says so", () => {
  const form = formWith([simpleField()]);
  const result = grade(form, {});
  assert.equal(result.submitted, false);
  assert.equal(result.score, 0);
  assert.ok(result.notes.some((note) => note.includes("no ticket was submitted")));
});

test("tickets: a scenario with no form grades as an unsubmitted zero, and says why", () => {
  const result = grade(null, { anything: "at all" });
  assert.equal(result.submitted, false);
  assert.equal(result.score, 0);
  assert.ok(result.notes.some((note) => note.includes("no ticket form")));
});

test("tickets: missing required lists labels only", () => {
  const form = formWith([
    { id: "a", label: "Root cause", weight: 50, min_words: 2, any_of: ["x"] },
    { id: "b", label: "Notes", weight: 50, required: false, any_of: ["y"] },
  ]);
  assert.deepEqual(missingRequired(form, { a: "", b: "" }), ["Root cause"]);
  assert.deepEqual(missingRequired(form, { a: "x", b: "" }), []);
});

test("tickets: feedback rows name the failed field, and only a failure carries a hint", () => {
  const form = formWith([simpleField({ hint: "Name the mechanism." })]);
  const rows = renderFeedback(form, grade(form, { cause: "no idea" }));
  assert.equal(rows[0]?.passed, false);
  assert.equal(rows[0]?.weight, 100);
  assert.equal(rows[0]?.hint, "Name the mechanism.");
  const passed = renderFeedback(form, grade(form, { cause: "the dns resolver was wrong" }));
  assert.equal(passed[0]?.hint, "");
  assert.ok(feedbackText(form, grade(form, { cause: "no idea" })).includes("[FAIL] Root cause"));
});

test("tickets: word count ignores punctuation and counts a path once", () => {
  // Punctuation is not a word, and a path is one token — not three words of padding.
  assert.equal(wordCount("the DNS server; /etc/resolv.conf is wrong."), 6);
  assert.equal(wordCount("..."), 0);
});

test("tickets: the summary line is what the audit trail records", () => {
  const form = formWith([simpleField()]);
  const marked = grade(form, { cause: "the dns resolver was wrong" });
  assert.equal(ticketGradeSummaryLine(marked), "100% (1/1 fields)");
  assert.equal(ticketGradeSummaryLine(grade(form, {})), "no ticket submitted");
});

/* -------------------------------------------------------------------------- */
/*  Blending with the machine score                                           */
/* -------------------------------------------------------------------------- */

test("tickets: the blend is the weighted sum", () => {
  const form = formWith([simpleField()], 40);
  const ticket = grade(form, { cause: "the dns server address was wrong" });
  assert.equal(ticket.score, 100);
  assert.equal(blend(50, ticket, 40), 70);
});

test("tickets: no submission contributes nothing", () => {
  assert.equal(blend(100, null, 30), 70);
});

test("tickets: a scenario without a ticket is graded exactly as before", () => {
  assert.equal(blend(80, null, 0), 80);
});

test("tickets: the blend cannot be pushed above the cap", () => {
  const form = formWith([simpleField()], 100);
  const ticket = grade(form, { cause: "the dns resolver was wrong" });
  assert.equal(ticket.score, 100);
  // 100% ticket weight is refused by validation, and blend clamps it anyway.
  assert.equal(blend(0, ticket, 100), 60);
});

/* -------------------------------------------------------------------------- */
/*  The repository's own rubrics                                              */
/* -------------------------------------------------------------------------- */

test("tickets: every shipped rubric is satisfiable", () => {
  // A rubric nobody can score full marks on is a broken ticket, not a strict one. This is
  // also the test the demo's write-up synthesiser is proven against: it answers each field
  // from the rubric alone, so a rubric asking for a term nothing can produce fails here.
  const repository = shipped();
  let withForms = 0;
  for (const scenario of repository.list()) {
    const form = scenario.ticketForm as TicketForm | null;
    if (form === null || form.fields.length === 0) continue;
    withForms += 1;
    const answers = synthesiseTicket(form);
    const result = grade(form, answers, { scenarioId: scenario.id });
    assert.equal(
      result.score,
      100,
      `${scenario.id}: ${result.outcomes.map((outcome) => `${outcome.fieldId}: ${outcome.detail}`).join("; ")}`,
    );
  }
  assert.ok(withForms > 0, "at least some scenarios should ask for a write-up");
});

test("tickets: every shipped rubric validates", () => {
  const problems = shipped().validateRecords();
  assert.deepEqual(
    problems.filter((problem) => problem.includes("ticket")),
    [],
    problems.join("\n"),
  );
});

test("tickets: the public view shows a form, and never the rubric's answers", () => {
  const repository = shipped();
  let withForms = 0;
  for (const scenario of repository.list()) {
    const form = scenario.ticketForm as TicketForm | null;
    const view = publicView(scenario);
    if (form === null || form.fields.length === 0) continue;
    withForms += 1;
    assert.equal(view.has_ticket, true, `${scenario.id} has a form, and says so`);

    // What a student's page may show: the labels, the lengths, the choices. What it may
    // not: an answer. The select's `expected` is the one that would give the game away.
    const shown = ticketFormPublic(form) as { fields: Record<string, unknown>[] };
    assert.equal(shown.fields.length, form.fields.length, scenario.id);
    for (const field of shown.fields) {
      assert.equal("expected" in field, false, `${scenario.id}: the answer is withheld`);
      assert.equal("all_of" in field, false, `${scenario.id}: and so is the rubric's term list`);
      assert.equal("none_of" in field, false, scenario.id);
    }

    // The stored view (`to_dict`) is a wire format: the lab's snake_case keys, and the
    // same withholding.
    const stored = ticketFormToDict(form) as { fields: Record<string, unknown>[] };
    assert.equal("expected" in (stored.fields[0] ?? {}), false, `${scenario.id}: nor in the stored copy`);
    assert.equal("min_words" in (stored.fields[0] ?? {}), true, `${scenario.id}: the stored key is the lab's`);
  }
  assert.ok(withForms > 0, "at least some scenarios should ask for a write-up");
});

/* -------------------------------------------------------------------------- */
/*  Persistence: a draft is not a grade                                       */
/* -------------------------------------------------------------------------- */

test("tickets: drafts are kept out of the marked-ticket table", async () => {
  // A draft is not a grade: the results-only policy applies to the write-up too.
  const store = new InMemoryLabStore();
  const session = await store.createSession(
    newLabSession({ student: "alice", scenarioId: "net-dns-failure" }),
  );
  const sessionId = session.id ?? 0;

  await store.saveTicketDraft(sessionId, { cause: "half a thought" });
  assert.deepEqual(await store.ticketDraft(sessionId), { cause: "half a thought" });
  assert.deepEqual(await store.listTickets(), [], "a draft is not a marked ticket");
  assert.deepEqual(await store.ticketValues(sessionId), {});

  const form = formWith([simpleField()]);
  const result = grade(form, { cause: "the dns resolver was wrong" }, { sessionId });
  await store.saveTicket(result, session.student);
  assert.equal((await store.listTickets()).length, 1);
  const marked = await store.latestTicket(sessionId);
  assert.equal(marked?.score, 100);
  assert.equal((await store.ticketValues(sessionId)).cause?.startsWith("the dns"), true);

  // Handing the write-up in forgets the draft it came from.
  await store.clearTicketDraft(sessionId);
  assert.deepEqual(await store.ticketDraft(sessionId), {});
});

test("tickets: the store counts tickets and their average", async () => {
  const store = new InMemoryLabStore();
  const form = formWith([simpleField()]);
  // One field answered properly and one submission left blank: the average is over both
  // rows (as the SQL's AVG was), and only one of them counts as submitted.
  for (const [index, answer] of ["the dns resolver was wrong", ""].entries()) {
    const session = await store.createSession(
      newLabSession({ student: `student${index + 1}`, scenarioId: "net-dns-failure" }),
    );
    const result = grade(form, { cause: answer }, { sessionId: session.id ?? 0 });
    await store.saveTicket(result, session.student);
  }
  const stats = await store.countTickets();
  assert.equal(stats.count, 2);
  assert.equal(stats.submitted, 1);
  assert.equal(stats.average, 50);
});

test("tickets: a marked grade survives the JSON round trip it is stored through", () => {
  const form = formWith([simpleField()]);
  const marked = grade(form, { cause: "the dns resolver was wrong" }, { sessionId: 7, scenarioId: "net-dns-failure" });
  const restored = ticketGradeFromDict(ticketGradeToDict(marked));
  assert.deepEqual(restored, marked, "the lab's own to_dict/from_dict is lossless for a real grade");
  // ...and a row written by something older degrades a field at a time rather than throwing.
  const sparse = ticketGradeFromDict({ session_id: 3, score: 40 });
  assert.equal(sparse.sessionId, 3);
  assert.equal(sparse.scenarioId, "");
  assert.deepEqual(sparse.outcomes, []);
  assert.equal(sparse.submitted, false);
});
