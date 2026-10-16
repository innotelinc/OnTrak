import { toCsv } from "./csv-rules";
import type { RuleProblem } from "./program-rules";

/**
 * The funder's course directory, from this side of it.
 *
 * FAST AI is a directory program: the funder buys training slots and *publishes* the courses it
 * will buy them from, so that eligible Massachusetts employers can find them and enrol their
 * workers directly (§1.1, §2.2). Three of the RFQ's administrative requirements are about that
 * listing rather than about the training:
 *
 *   - **It is not automatic.** "Awarded courses are not published to the directory on the basis
 *     of the RFQ response alone" (§4.3): the provider submits course details, CommCorp reviews
 *     them, and may decline to publish. So a course has three states, not two — drafted by the
 *     provider, published by the funder, or taken down again.
 *   - **It carries the provider's contact details.** "Directory entries are expected to include
 *     course details and training provider contact information" (§4.4) — an entry an employer
 *     cannot act on is a listing nobody can buy from.
 *   - **It can be removed at will.** "CommCorp reserves the right to remove or suspend a course
 *     listing at will" (§4.4), and the provider has to keep its own record of a course and its
 *     contact information *current*, including "changes to price, hours, format, or
 *     availability".
 *
 * Pure, so the states and the export can be asserted without a database; the page and the CSV
 * route are the two readers, and they read the same functions.
 */

/** Where a course stands with the directory. Suspension outranks publication, because it is the newer act. */
export type DirectoryState = "draft" | "published" | "suspended";

export function directoryState(course: {
  directoryApprovedAt: Date | null;
  listingSuspendedAt: Date | null;
}): DirectoryState {
  if (course.listingSuspendedAt) return "suspended";
  return course.directoryApprovedAt ? "published" : "draft";
}

/** A provider's contact details, as a directory entry carries them. */
export interface ProviderContact {
  providerName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

/**
 * Whether an employer reading the directory could act on this entry.
 *
 * A name to ask for and one way of reaching them; that is the bar, because a directory entry
 * whose contact block is empty is a course nobody can enrol in. The email is checked for shape
 * only — this app cannot verify an address, and pretending to would refuse a working one.
 */
export function providerContactProblems(provider: ProviderContact): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const name = provider.providerName;
  const contact = (provider.contactName ?? "").trim();
  const email = (provider.contactEmail ?? "").trim();
  const phone = (provider.contactPhone ?? "").trim();

  if (contact === "") {
    problems.push({
      field: "contactName",
      message: `“${name}” has no contact name on file, and a directory entry has to say who an employer should ask for.`,
    });
  }
  if (email === "" && phone === "") {
    problems.push({
      field: "contactEmail",
      message: `“${name}” has no contact email or phone number, and §4.4 expects the directory's entries to carry the provider's contact information.`,
    });
  } else if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push({
      field: "contactEmail",
      message: `“${name}”'s contact email “${email}” does not look like an email address.`,
    });
  }
  return problems;
}

/**
 * Everything standing between a course and a listing an employer can use.
 *
 * A draft is not an error — it is the state every course starts in, and §4.3 gives the funder a
 * review before publication. It is reported anyway, because a provider reading its catalogue
 * needs to know which courses are actually in the directory and which are waiting.
 */
export function listingProblems(course: {
  title: string;
  directoryApprovedAt: Date | null;
  listingSuspendedAt: Date | null;
  listingNote?: string | null;
  topicAreas?: string | null;
}): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const state = directoryState(course);

  if (state === "draft") {
    problems.push({
      field: "directoryApprovedAt",
      message: `“${course.title}” is not in the directory yet: awarded courses are published only after CommCorp reviews the submitted details (§4.3).`,
    });
  }
  if (state === "suspended") {
    problems.push({
      field: "listingSuspendedAt",
      message: `“${course.title}”'s listing is taken down${
        course.listingNote ? ` — ${course.listingNote}` : ""
      } (CommCorp may remove or suspend a listing at will, §4.4).`,
    });
  }
  if ((course.topicAreas ?? "").trim() === "") {
    problems.push({
      field: "topicAreas",
      message: `“${course.title}” claims no in-scope topic area, and the directory is browsed by them.`,
    });
  }
  return problems;
}

/**
 * The whole answer for one entry: the course's own problems, then the provider's contact details.
 *
 * Kept as two functions because the two are *read* in two different places — the contact block
 * belongs to the provider and is reported once for the whole catalogue, while a draft belongs to
 * one course and is reported on its card.
 */
export function directoryProblems(
  course: Parameters<typeof listingProblems>[0],
  provider: ProviderContact,
): RuleProblem[] {
  return [...listingProblems(course), ...providerContactProblems(provider)];
}

/** One course as the directory lists it. */
export interface DirectoryEntry {
  tenant: string;
  tenantSlug: string;
  program: string | null;
  funder: string | null;
  state: DirectoryState;
  courseNumber: number | null;
  course: string;
  description: string | null;
  topics: string;
  delivery: string;
  instructionalHours: number;
  pricePerSlotUsd: number;
  maxSlotsPerOffering: number | null;
  languages: string | null;
  credentials: string | null;
  audience: string | null;
  prerequisites: string | null;
  providerContactName: string | null;
  providerContactEmail: string | null;
  providerContactPhone: string | null;
  approvedOn: string | null;
  suspendedOn: string | null;
  /** The last time the course itself changed — the provider's own "kept current" fact. */
  updatedOn: string;
}

export const DIRECTORY_HEADERS = [
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
] as const;

const day = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : "");

/** The rows, one per course, in the order a provider's catalogue reads. */
export function directoryEntries(
  source: {
    organization: { name: string; slug: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null };
    courses: readonly {
      title: string;
      summary: string | null;
      topicAreas: string | null;
      deliveryMode: string;
      instructionalHours: number;
      pricePerSlotCents: number;
      courseNumber: number | null;
      maxSlotsPerOffering: number | null;
      languages: string | null;
      credentials: string | null;
      audience: string | null;
      prerequisites: string | null;
      directoryApprovedAt: Date | null;
      listingSuspendedAt: Date | null;
      updatedAt: Date;
      program: { name: string; funder: string | null } | null;
    }[];
  },
): DirectoryEntry[] {
  return source.courses.map((course) => ({
    tenant: source.organization.name,
    tenantSlug: source.organization.slug,
    program: course.program?.name ?? null,
    funder: course.program?.funder ?? null,
    state: directoryState(course),
    courseNumber: course.courseNumber,
    course: course.title,
    description: course.summary,
    topics: (course.topicAreas ?? "").split("\n").filter(Boolean).join("; "),
    delivery: course.deliveryMode,
    instructionalHours: course.instructionalHours,
    // Dollars, as the funder's own directory and paperwork write prices.
    pricePerSlotUsd: course.pricePerSlotCents / 100,
    maxSlotsPerOffering: course.maxSlotsPerOffering,
    languages: course.languages,
    credentials: course.credentials,
    audience: course.audience,
    prerequisites: course.prerequisites,
    providerContactName: source.organization.contactName,
    providerContactEmail: source.organization.contactEmail,
    providerContactPhone: source.organization.contactPhone,
    approvedOn: day(course.directoryApprovedAt),
    suspendedOn: day(course.listingSuspendedAt),
    updatedOn: course.updatedAt.toISOString().slice(0, 10),
  }));
}

export function directoryCsv(entries: readonly DirectoryEntry[]): string {
  return toCsv([
    [...DIRECTORY_HEADERS],
    ...entries.map((entry) => [
      entry.tenant,
      entry.tenantSlug,
      entry.program,
      entry.funder,
      entry.state,
      entry.courseNumber,
      entry.course,
      entry.description,
      entry.topics,
      entry.delivery,
      entry.instructionalHours,
      entry.pricePerSlotUsd.toFixed(2),
      entry.maxSlotsPerOffering,
      entry.languages,
      entry.credentials,
      entry.audience,
      entry.prerequisites,
      entry.providerContactName,
      entry.providerContactEmail,
      entry.providerContactPhone,
      entry.approvedOn,
      entry.suspendedOn,
      entry.updatedOn,
    ]),
  ]);
}
