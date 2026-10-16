import { toCsv } from "./csv-rules";

/**
 * The figures a funded program owes its funder, as one row per learner per class.
 *
 * The FAST AI RFQ asks a provider to report enrolment, attendance and completion, and to
 * report them against the class they happened in. That is exactly one row per enrolment:
 * flattening any further (a row per class, or a row per sitting) would lose the thing the
 * funder is checking — that a named person attended named sessions of a named class and
 * finished it.
 *
 * Money is written in dollars with two decimals rather than the cents this app stores,
 * because the file's destination is a spreadsheet somebody sums. Dates are `YYYY-MM-DD`
 * and deliberately not localised: an export that changes format with the server's locale
 * is an export two offices cannot compare.
 *
 * Nothing here touches the database, so the columns and the arithmetic can be tested
 * without one — and so the same builder answers for an operator's whole platform and a
 * single tenancy's single program.
 */

export interface ReportRow {
  tenant: string;
  tenantSlug: string;
  program: string | null;
  funder: string | null;
  course: string | null;
  klass: string;
  joinCode: string;
  sponsor: string | null;
  deliveryMode: string;
  startsOn: string | null;
  endsOn: string | null;
  seats: number | null;
  pricePerSlotCents: number | null;
  slotValueCents: number | null;
  learnerName: string;
  learnerEmail: string;
  status: string;
  enrolledOn: string;
  completedOn: string | null;
  hoursAttended: number;
  sittings: number;
  present: number;
}

/**
 * One tenancy, as both the export route and the page load it.
 *
 * Structural on purpose: the two loaders select different amounts of the same rows (the page
 * also needs a course's modules for the classroom spec), and what makes the page's figures and
 * the file's figures agree is that they are built from one row list, not that they were loaded
 * with one query.
 */
export interface ReportSource {
  organization: { name: string; slug: string };
  classes: readonly {
    name: string;
    joinCode: string;
    deliveryMode: string;
    startsOn: Date | null;
    endsOn: Date | null;
    seats: number | null;
    pricePerSlotCents: number | null;
    course: { title: string } | null;
    program: { name: string; funder: string | null } | null;
    sponsor: { name: string } | null;
    enrollments: readonly {
      status: string;
      enrolledAt: Date;
      completedAt: Date | null;
      hoursAttended: number;
      user: { name: string; email: string };
      attendances: readonly { status: string }[];
    }[];
  }[];
}

/** The funder's rows for one tenancy: one per learner per class, in class then learner order. */
export function reportRows(source: ReportSource): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const klass of source.classes) {
    for (const enrollment of klass.enrollments) {
      rows.push({
        tenant: source.organization.name,
        tenantSlug: source.organization.slug,
        program: klass.program?.name ?? null,
        funder: klass.program?.funder ?? null,
        course: klass.course?.title ?? null,
        klass: klass.name,
        joinCode: klass.joinCode,
        sponsor: klass.sponsor?.name ?? null,
        deliveryMode: klass.deliveryMode,
        startsOn: reportDay(klass.startsOn),
        endsOn: reportDay(klass.endsOn),
        seats: klass.seats,
        pricePerSlotCents: klass.pricePerSlotCents,
        slotValueCents:
          klass.pricePerSlotCents === null ? null : (klass.seats ?? 0) * klass.pricePerSlotCents,
        learnerName: enrollment.user.name,
        learnerEmail: enrollment.user.email,
        status: enrollment.status,
        enrolledOn: enrollment.enrolledAt.toISOString().slice(0, 10),
        completedOn: reportDay(enrollment.completedAt),
        hoursAttended: enrollment.hoursAttended,
        sittings: enrollment.attendances.length,
        present: enrollment.attendances.filter((sitting) => sitting.status === "PRESENT").length,
      });
    }
  }
  return rows;
}

export const REPORT_HEADERS = [
  "tenant",
  "tenant_key",
  "program",
  "funder",
  "course",
  "class",
  "join_code",
  "sponsor",
  "delivery",
  "starts_on",
  "ends_on",
  "seats",
  "price_per_slot_usd",
  "slot_value_usd",
  "learner_name",
  "learner_email",
  "enrolment_status",
  "enrolled_on",
  "completed_on",
  "hours_attended",
  "sittings",
  "sessions_present",
] as const;

const dollars = (cents: number | null): string => (cents === null ? "" : (cents / 100).toFixed(2));

export function reportCsv(rows: readonly ReportRow[]): string {
  return toCsv([
    [...REPORT_HEADERS],
    ...rows.map((row) => [
      row.tenant,
      row.tenantSlug,
      row.program,
      row.funder,
      row.course,
      row.klass,
      row.joinCode,
      row.sponsor,
      row.deliveryMode,
      row.startsOn,
      row.endsOn,
      row.seats,
      dollars(row.pricePerSlotCents),
      dollars(row.slotValueCents),
      row.learnerName,
      row.learnerEmail,
      row.status,
      row.enrolledOn,
      row.completedOn,
      row.hoursAttended,
      row.sittings,
      row.present,
    ]),
  ]);
}

export interface ReportSummary {
  /** Rows, which is one learner in one class — the funder's unit of enrolment. */
  enrolments: number;
  learners: number;
  classes: number;
  completed: number;
  withdrawn: number;
  hoursAttended: number;
  /** Seats offered × price per slot across the classes in the report. */
  committedCents: number;
  /**
   * What the funder will actually pay: completed slots at their own class's per-slot price.
   *
   * §4.1 is explicit that this is the only thing that is paid for — "CommCorp will only pay for
   * course completions and will not reimburse for partial completion" — so it is a separate
   * figure from `committedCents`, which is the ceiling a class's seats add up to. A provider
   * reading one number as the other would forecast money it has not earned.
   */
  reimbursableCents: number;
  /** Completion as a share of everyone who did not withdraw, or null with nobody to divide by. */
  completionRate: number | null;
}

/**
 * Totals for the same rows, computed once so the CSV and the page cannot disagree.
 *
 * Completion is a share of the *retained* learners (everyone who has not withdrawn), not
 * of everyone enrolled: a provider whose funder-eligible learners all finish should read
 * 100%, and counting a withdrawal against them would make that unreachable.
 */
export function reportSummary(rows: readonly ReportRow[]): ReportSummary {
  const learners = new Set(rows.map((row) => row.learnerEmail));
  const classes = new Set(rows.map((row) => `${row.tenantSlug}:${row.klass}`));
  const completed = rows.filter((row) => row.status === "COMPLETED").length;
  const withdrawn = rows.filter((row) => row.status === "WITHDRAWN").length;
  const retained = rows.length - withdrawn;

  // Seats and slot value repeat on every row of a class, so they are taken once per class
  // rather than summed per learner — summing them would multiply the award by the roster.
  const committed = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.tenantSlug}:${row.klass}`;
    if (committed.has(key)) continue;
    committed.set(key, (row.seats ?? 0) * (row.pricePerSlotCents ?? 0));
  }

  return {
    enrolments: rows.length,
    learners: learners.size,
    classes: classes.size,
    completed,
    withdrawn,
    hoursAttended: Math.round(rows.reduce((sum, row) => sum + row.hoursAttended, 0) * 10) / 10,
    committedCents: [...committed.values()].reduce((sum, value) => sum + value, 0),
    reimbursableCents: rows
      .filter((row) => row.status === "COMPLETED")
      .reduce((sum, row) => sum + (row.pricePerSlotCents ?? 0), 0),
    completionRate: retained === 0 ? null : completed / retained,
  };
}

/** `YYYY-MM-DD`, or null. UTC, so a report does not shift its dates by time zone. */
export function reportDay(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
