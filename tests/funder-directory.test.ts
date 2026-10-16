/**
 * The funder's course directory, and the feedback it collects (§4.3, §4.4, §4.5).
 *
 * Both are administrative requirements rather than training requirements, and both are things a
 * provider is *asked for* rather than things the funder refuses for: a course is drafted,
 * published, or taken down again; a class carries two survey addresses once it has been given
 * them. What the rules do own is the shape of the export an employer or CommCorp reads and the
 * validation of every address either surface publishes — a survey link is handed to learners.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/funder-directory.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIRECTORY_HEADERS,
  directoryCsv,
  directoryEntries,
  directoryProblems,
  directoryState,
  listingProblems,
  providerContactProblems,
  type DirectoryEntry,
  type ProviderContact,
} from "../src/lib/directory-rules";
import { feedbackGaps, feedbackLinks, feedbackSummary } from "../src/lib/feedback-rules";
import { httpLink, httpLinkRefusal } from "../src/lib/link-rules";

/* -------------------------------------------------------------------------- */
/*  Where a listing stands                                                     */
/* -------------------------------------------------------------------------- */

const DRAFT = { title: "Applied AI for the Frontline Role", directoryApprovedAt: null, listingSuspendedAt: null, topicAreas: "Generative AI" };

test("directory: a course is drafted, published, or taken down again", () => {
  assert.equal(directoryState(DRAFT), "draft", "not published on the basis of the RFQ response alone");
  assert.equal(directoryState({ ...DRAFT, directoryApprovedAt: new Date("2027-01-05") }), "published");
  // A suspension is the newer act, so it outranks the approval that is still on the row.
  assert.equal(
    directoryState({
      directoryApprovedAt: new Date("2027-01-05"),
      listingSuspendedAt: new Date("2027-06-01"),
    }),
    "suspended",
  );
});

test("directory: a draft says so, and a suspension says why", () => {
  const draft = listingProblems(DRAFT);
  assert.equal(draft.length, 1);
  assert.match(draft[0].message, /not in the directory yet/);
  assert.match(draft[0].message, /§4\.3/);

  const suspended = listingProblems({
    ...DRAFT,
    directoryApprovedAt: new Date("2027-01-05"),
    listingSuspendedAt: new Date("2027-06-01"),
    listingNote: "employer demand fell away",
  });
  assert.equal(suspended.length, 1);
  assert.match(suspended[0].message, /taken down — employer demand fell away/);
  assert.match(suspended[0].message, /at will/);

  assert.deepEqual(
    listingProblems({ ...DRAFT, directoryApprovedAt: new Date("2027-01-05") }),
    [],
    "a published course with a topic area has nothing standing against it",
  );

  // Both problems are reported: the draft is the reason it is not listed, the empty topic area is
  // the reason it could not be browsed to if it were.
  const noTopics = listingProblems({ ...DRAFT, topicAreas: "" });
  assert.equal(noTopics.length, 2);
  assert.match(noTopics[1].message, /claims no in-scope topic area/);
});

/* -------------------------------------------------------------------------- */
/*  The contact block                                                          */
/* -------------------------------------------------------------------------- */

const CONTACT: ProviderContact = {
  providerName: "Massachusetts Workforce Development",
  contactName: "Program Director",
  contactEmail: "fastai@massworkforce.example",
  contactPhone: "617-555-0142",
};

test("directory: an entry carries a name and a way of reaching the provider", () => {
  assert.deepEqual(providerContactProblems(CONTACT), []);

  assert.match(
    providerContactProblems({ ...CONTACT, contactName: "  " })[0].message,
    /no contact name on file/,
  );

  const unreachable = providerContactProblems({ ...CONTACT, contactEmail: null, contactPhone: null });
  assert.equal(unreachable.length, 1);
  assert.match(unreachable[0].message, /no contact email or phone number/);
  assert.match(unreachable[0].message, /§4\.4/);

  // A phone on its own is a way of reaching them: an employer can act on that entry.
  assert.deepEqual(providerContactProblems({ ...CONTACT, contactEmail: null }), []);

  assert.match(
    providerContactProblems({ ...CONTACT, contactEmail: "not-an-address" })[0].message,
    /does not look like an email address/,
  );
});

test("directory: the whole answer for one entry is the course's and the provider's", () => {
  const problems = directoryProblems(DRAFT, { ...CONTACT, contactName: null, contactEmail: null, contactPhone: null });
  assert.equal(problems.length, 3, "a draft, a missing name, and no way of reaching anybody");
  assert.deepEqual(
    directoryProblems({ ...DRAFT, directoryApprovedAt: new Date("2027-01-05") }, CONTACT),
    [],
  );
});

/* -------------------------------------------------------------------------- */
/*  The export                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE = {
  organization: {
    name: "Massachusetts Workforce Development",
    slug: "mass-workforce-development",
    contactName: CONTACT.contactName,
    contactEmail: CONTACT.contactEmail,
    contactPhone: CONTACT.contactPhone,
  },
  courses: [
    {
      title: "Applied AI for the Frontline Role",
      summary: "Six hours of hands-on practice.",
      topicAreas: "Generative AI\nAI productivity applications",
      deliveryMode: "instructor-led",
      instructionalHours: 6,
      pricePerSlotCents: 180_000,
      courseNumber: 1,
      maxSlotsPerOffering: 16,
      languages: null,
      credentials: null,
      audience: "Frontline staff",
      prerequisites: "None",
      directoryApprovedAt: new Date("2027-01-05"),
      listingSuspendedAt: null,
      updatedAt: new Date("2027-01-06T12:00:00.000Z"),
      program: { name: "Focused AI Skills Training (FAST AI)", funder: "Commonwealth Corporation" },
    },
    {
      title: "AI-Assisted Customer Support, part 2",
      summary: "Eight hours.",
      topicAreas: "Generative AI",
      deliveryMode: "instructor-led",
      instructionalHours: 8,
      pricePerSlotCents: 240_000,
      courseNumber: 2,
      maxSlotsPerOffering: 14,
      languages: "Spanish",
      credentials: "Microsoft Office Specialist",
      audience: "Support staff",
      prerequisites: null,
      directoryApprovedAt: new Date("2027-01-05"),
      listingSuspendedAt: new Date("2027-07-01"),
      updatedAt: new Date("2027-07-02T12:00:00.000Z"),
      program: null,
    },
  ],
};

test("directory: the columns are the directory's, in a fixed order", () => {
  assert.deepEqual([...DIRECTORY_HEADERS], [
    "tenant",
    "tenant_key",
    "program",
    "funder",
    "listing_state",
    "course_number",
    "course",
    "description",
    "topic_areas",
    "delivery",
    "instructional_hours",
    "price_per_slot_usd",
    "max_slots_per_offering",
    "languages",
    "credentials",
    "audience",
    "prerequisites",
    "contact_name",
    "contact_email",
    "contact_phone",
    "approved_on",
    "suspended_on",
    "updated_on",
  ]);
});

test("directory: every row carries the provider's contact block", () => {
  // An employer who downloads the directory and finds a course has to be able to act on it, so
  // the contact details repeat on every line rather than living in a header somewhere.
  const entries = directoryEntries(SOURCE);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.providerContactName, "Program Director");
    assert.equal(entry.providerContactEmail, "fastai@massworkforce.example");
    assert.equal(entry.providerContactPhone, "617-555-0142");
  }
  assert.equal(entries[0].state, "published");
  assert.equal(entries[1].state, "suspended");
  assert.equal(entries[1].program, null, "a course outside a program is still listed");
});

test("directory: prices are dollars a spreadsheet can sum", () => {
  const csv = directoryCsv(directoryEntries(SOURCE));
  const [header, first] = csv.split("\r\n");
  const cells = first.split(",");
  const at = (name: string) => header.split(",").indexOf(name);
  assert.equal(cells[at("price_per_slot_usd")], "1800.00");
  assert.equal(cells[at("instructional_hours")], "6");
  assert.equal(cells[at("max_slots_per_offering")], "16");
  assert.equal(cells[at("topic_areas")], "Generative AI; AI productivity applications");
  assert.equal(cells[at("approved_on")], "2027-01-05");
  assert.equal(cells[at("updated_on")], "2027-01-06");
});

test("directory: a course title containing a comma survives the round trip", () => {
  const csv = directoryCsv(directoryEntries(SOURCE));
  assert.match(csv, /"AI-Assisted Customer Support, part 2"/);
  assert.equal(csv.trimEnd().split("\r\n").length, 3, "one header and two courses");
});

/* -------------------------------------------------------------------------- */
/*  Feedback (§4.5)                                                            */
/* -------------------------------------------------------------------------- */

test("feedback: a class that has not been given the surveys says which are missing", () => {
  const gaps = feedbackGaps({ traineeSurveyUrl: null, employerSurveyUrl: null });
  assert.equal(gaps.length, 2);
  assert.match(gaps[0], /No trainee survey is recorded/);
  assert.match(gaps[0], /course quality/);
  assert.match(gaps[1], /No employer survey is recorded/);
  assert.match(gaps[1], /training's impact/);

  assert.equal(
    feedbackGaps({ traineeSurveyUrl: "https://survey.example/trainee", employerSurveyUrl: null }).length,
    1,
    "one instrument recorded is one gap",
  );
});

test("feedback: a survey address is validated, because a learner is handed it", () => {
  const links = feedbackLinks({
    traineeSurveyUrl: "https://survey.example/trainee?class=FASTAP",
    employerSurveyUrl: "javascript:alert(1)",
  });
  assert.equal(links.trainee, "https://survey.example/trainee?class=FASTAP");
  assert.equal(links.employer, null, "a javascript: address is not a survey");

  const gaps = feedbackGaps({ traineeSurveyUrl: "javascript:alert(1)", employerSurveyUrl: null });
  assert.match(gaps[0], /trainee survey address was refused/);
  assert.match(gaps[0], /javascript address/);
  // The empty field is silent: nothing stored and nothing usable are the same answer here.
  const empty = { traineeSurveyUrl: "https://survey.example/t", employerSurveyUrl: "https://survey.example/e" };
  assert.deepEqual(feedbackGaps(empty), []);
  assert.match(feedbackSummary(empty), /Both surveys are recorded/);
  assert.match(feedbackSummary({ traineeSurveyUrl: null, employerSurveyUrl: null }), /No trainee survey/);
});

/* -------------------------------------------------------------------------- */
/*  The link rule both surfaces read                                           */
/* -------------------------------------------------------------------------- */

test("links: only absolute http(s) addresses without credentials survive", () => {
  assert.equal(httpLink("https://classroom.example/lesson/1"), "https://classroom.example/lesson/1");
  assert.equal(httpLink("  https://survey.example/t  "), "https://survey.example/t");
  assert.equal(httpLink(""), null);
  assert.equal(httpLink(null), null);
  assert.equal(httpLink("javascript:alert(1)"), null);
  assert.equal(httpLink("data:text/html,<h1>not us</h1>"), null);
  assert.equal(httpLink("ftp://files.example/lesson"), null);
  assert.equal(httpLink("survey.example/t"), null, "a bare host is not a link");
  assert.equal(httpLink("https://user:pass@survey.example/t"), null, "a credential in a shared field is not a secret");
});

test("links: a refusal names the subject, so a person knows which field to fix", () => {
  assert.match(httpLinkRefusal("javascript:alert(1)", "trainee survey"), /a trainee survey must be served over http\(s\)/);
  assert.match(httpLinkRefusal("", "employer survey"), /^A employer survey address cannot be empty/);
  assert.match(httpLinkRefusal("survey.example", "trainee survey"), /absolute http\(s\) address/);
  assert.match(
    httpLinkRefusal("https://a:b@survey.example/t", "employer survey"),
    /carries a username and password/,
  );
});

test("links: the classroom keeps its own words for the same rule", () => {
  // The delegation has to keep classroom-rules' messages, because operators have been reading
  // them: one implementation, two names.
  const entry: DirectoryEntry = directoryEntries(SOURCE)[0];
  assert.equal(entry.course, "Applied AI for the Frontline Role");
  assert.match(httpLinkRefusal("javascript:alert(1)", "classroom"), /a classroom must be served over http\(s\)/);
});
