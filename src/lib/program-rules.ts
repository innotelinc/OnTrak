/**
 * The arithmetic a funded training program is governed by, kept pure.
 *
 * These are the numbers from the FAST AI request for qualifications, and they are the
 * reason a class is not just a cohort with a date on it. A provider is paid per training
 * slot, and the funder caps that price two ways at once:
 *
 *   - no more than $300 per instructional hour per slot, and
 *   - no more than $3,000 per person per course,
 *
 * **whichever is less**. Both are checked, because they are not the same ceiling: a
 * three-hour course is bounded by the hourly one ($900), a forty-hour course by the per
 * person one ($3,000, where the hourly ceiling alone would allow $12,000).
 *
 * Everything here is pure and takes plain values, so the rules can be tested without a
 * database and reused by the form that warns before saving and by the action that refuses
 * after — one implementation, so the warning and the refusal cannot disagree.
 */

/** $300 per instructional hour per training slot. */
export const FAST_AI_COST_PER_HOUR_CENTS = 30_000;

/** $3,000 per person per course. */
export const FAST_AI_COST_PER_PERSON_CENTS = 300_000;

/** A provider's award ceiling across all approved courses: $400,000. */
export const FAST_AI_AWARD_CENTS = 40_000_000;

/** Training starts on or after this date and is complete no later than the end date. */
export const FAST_AI_WINDOW_START = "2027-02-01";
export const FAST_AI_WINDOW_END = "2028-06-30";

/**
 * The whole program's FY27 allocation — $1,615,000 (RFQ §1.5).
 *
 * Not a provider's money and not a rule this app enforces: it is the pool CommCorp is
 * buying out of, and it is here so a page can state the program's size without someone
 * restating it from the RFQ and getting the figure old. A provider's own ceiling is
 * `FAST_AI_AWARD_CENTS`.
 */
export const FAST_AI_FY27_ALLOCATION_CENTS = 161_500_000;

/**
 * No employer may take more than this many slots per approved provider, over the contract
 * term (RFQ §1.5, §3.2, §4.1, §4.2).
 *
 * The cap is the funder's instrument for spreading the money across a broad base of
 * Massachusetts employers, and the RFQ is explicit that it is the **provider's** to track:
 * *"The Applicant will be responsible for tracking these caps"*, and *"Slots delivered to
 * ineligible employers, or in excess of the cap, are not reimbursable, and the selected
 * Applicant carries that risk."* So a slot beyond it is not late paperwork — it is unpaid
 * training the provider has already delivered, which is why this app refuses the enrolment
 * rather than warning after the fact.
 */
export const FAST_AI_EMPLOYER_SLOT_CAP = 100;

/**
 * The cap runs over the **contract term**, which is longer than the training window: the
 * contract signed on 2027-02-01 runs to 2029-01-31 (RFQ §5), while training CommCorp
 * prioritises ends 2028-06-30. Tracking usage against the window would under-count it.
 */
export const FAST_AI_CONTRACT_START = "2027-02-01";
export const FAST_AI_CONTRACT_END = "2029-01-31";

/** The most courses one provider may be accepted for in this round: 20 (RFQ §3.3). */
export const FAST_AI_MAX_COURSES = 20;

/** A course description may run to 250 words and no further (RFQ §3.3). */
export const FAST_AI_DESCRIPTION_WORDS = 250;

/**
 * The in-scope training topics (RFQ §3.2), in the RFQ's own words.
 *
 * "Other AI-related topics will be considered as needed", so an unlisted topic is a fact a
 * person should see rather than a refusal this app invents on CommCorp's behalf: the
 * directory check names an unrecognised topic and lets the provider decide.
 */
export const FAST_AI_TOPIC_AREAS = [
  "AI literacy and awareness",
  "Generative AI",
  "Prompt engineering",
  "AI productivity applications",
  "Data science and machine learning",
  "Occupation-specific AI applications",
  "Industry-specific AI applications",
  "Workflow improvement and business process applications",
  "AI for managers and leaders",
  "AI governance, risk, ethics, and responsible use",
  "AI-assisted analytics and business intelligence",
  "Industry-recognized credentials",
] as const;

export type FastAiTopicArea = (typeof FAST_AI_TOPIC_AREAS)[number];

/**
 * The delivery formats the directory asks a course to state (RFQ §3.3: "in-person, virtual, or
 * hybrid"). A different fact from the funded delivery *mode* — every FAST AI course is
 * instructor-led, and each is also one of these three.
 */
export const FAST_AI_DELIVERY_FORMATS = ["in-person", "virtual", "hybrid"] as const;

export interface ProgramCaps {
  /** Cents per instructional hour per slot, or null when the program sets no such cap. */
  costPerHourCents: number | null;
  /** Cents per person per course, or null when the program sets no such cap. */
  costPerPersonCents: number | null;
  /** The window training must run inside, inclusive. Null means unbounded. */
  startsOn: Date | string | null;
  endsOn: Date | string | null;
}

/** A plain date at UTC midnight, so comparisons do not drift with the server's clock. */
function day(value: Date | string): Date {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `$1,234.56` — money in cents, rendered the way a funder's paperwork writes it. */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * The most a slot may cost for a course of this length, or null when the program caps
 * nothing. The binding constraint is returned, not both, because a form has to show one
 * number: the one the funder would apply.
 */
export function slotCeilingCents(
  caps: Pick<ProgramCaps, "costPerHourCents" | "costPerPersonCents">,
  instructionalHours: number,
): number | null {
  const hourly =
    caps.costPerHourCents === null ? null : Math.round(caps.costPerHourCents * instructionalHours);
  const perPerson = caps.costPerPersonCents;
  if (hourly === null) return perPerson;
  if (perPerson === null) return hourly;
  return Math.min(hourly, perPerson);
}

/** Which ceiling is the binding one, for saying *why* a price was refused. */
export function bindingCeiling(
  caps: Pick<ProgramCaps, "costPerHourCents" | "costPerPersonCents">,
  instructionalHours: number,
): "hourly" | "per-person" | "none" {
  const hourly =
    caps.costPerHourCents === null ? null : Math.round(caps.costPerHourCents * instructionalHours);
  const perPerson = caps.costPerPersonCents;
  if (hourly === null && perPerson === null) return "none";
  if (hourly === null) return "per-person";
  if (perPerson === null) return "hourly";
  return perPerson <= hourly ? "per-person" : "hourly";
}

export interface RuleProblem {
  field: string;
  message: string;
}

/**
 * Everything wrong with a course price against a program's caps. Empty means it may be
 * published: this is the list a person reads, so each message names the number that
 * decided it rather than restating the rule.
 */
export function priceProblems(
  caps: Pick<ProgramCaps, "costPerHourCents" | "costPerPersonCents">,
  course: { title: string; instructionalHours: number; pricePerSlotCents: number },
): RuleProblem[] {
  const problems: RuleProblem[] = [];
  if (!Number.isFinite(course.instructionalHours) || course.instructionalHours <= 0) {
    problems.push({
      field: "instructionalHours",
      message: `“${course.title}” must state its instructional hours; the hourly ceiling is a share of them.`,
    });
    return problems;
  }
  if (!Number.isInteger(course.pricePerSlotCents) || course.pricePerSlotCents <= 0) {
    problems.push({
      field: "pricePerSlotCents",
      message: `“${course.title}” must state a price per training slot.`,
    });
    return problems;
  }
  const ceiling = slotCeilingCents(caps, course.instructionalHours);
  if (ceiling !== null && course.pricePerSlotCents > ceiling) {
    const binding = bindingCeiling(caps, course.instructionalHours);
    const shape =
      binding === "hourly"
        ? `${money(caps.costPerHourCents)} per instructional hour`
        : `${money(caps.costPerPersonCents)} per person per course`;
    problems.push({
      field: "pricePerSlotCents",
      message: `A slot for “${course.title}” may not exceed ${money(ceiling)}: ${course.instructionalHours} instructional hours against ${shape}.`,
    });
  }
  return problems;
}

/**
 * Everything wrong with a class's schedule. The window is the funder's, not the
 * provider's: FAST AI pays for training that starts on or after 2027-02-01 and is
 * complete by 2028-06-30, so a class outside it is unschedulable however good it is.
 */
export function scheduleProblems(
  caps: Pick<ProgramCaps, "startsOn" | "endsOn">,
  scheduled: {
    name: string;
    startsOn: Date | string | null;
    endsOn: Date | string | null;
    seats: number | null;
    deliveryMode: string;
  },
): RuleProblem[] {
  const problems: RuleProblem[] = [];
  if (scheduled.seats !== null && (!Number.isInteger(scheduled.seats) || scheduled.seats <= 0)) {
    problems.push({ field: "seats", message: `“${scheduled.name}” must offer at least one seat.` });
  }
  if (scheduled.deliveryMode !== "instructor-led") {
    problems.push({
      field: "deliveryMode",
      message: `The program funds applied, instructor-led training; “${scheduled.name}” is ${scheduled.deliveryMode}.`,
    });
  }
  if (!scheduled.startsOn || !scheduled.endsOn) {
    problems.push({
      field: "startsOn",
      message: `“${scheduled.name}” needs both a start and an end date — the funder's window is reported against them.`,
    });
    return problems;
  }
  const start = day(scheduled.startsOn);
  const end = day(scheduled.endsOn);
  if (end < start) {
    problems.push({ field: "endsOn", message: `“${scheduled.name}” ends before it starts.` });
  }
  if (caps.startsOn) {
    const windowStart = day(caps.startsOn);
    if (start < windowStart) {
      problems.push({
        field: "startsOn",
        message: `Training may not start before ${windowStart.toISOString().slice(0, 10)}; “${scheduled.name}” starts ${start.toISOString().slice(0, 10)}.`,
      });
    }
  }
  if (caps.endsOn) {
    const windowEnd = day(caps.endsOn);
    if (end > windowEnd) {
      problems.push({
        field: "endsOn",
        message: `Training must be complete by ${windowEnd.toISOString().slice(0, 10)}; “${scheduled.name}” runs to ${end.toISOString().slice(0, 10)}.`,
      });
    }
  }
  return problems;
}

/** Slots a program can afford at a price: seats × price, against the award ceiling. */
export function awardProblems(
  awardCents: number | null,
  priced: { name: string; seats: number | null; pricePerSlotCents: number | null },
): RuleProblem[] {
  if (awardCents === null) return [];
  if (priced.seats === null || priced.pricePerSlotCents === null) return [];
  const total = priced.seats * priced.pricePerSlotCents;
  if (total > awardCents) {
    return [
      {
        field: "pricePerSlotCents",
        message: `${priced.seats} seats at ${money(priced.pricePerSlotCents)} is ${money(total)}, over the ${money(awardCents)} award.`,
      },
    ];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/*  The employer side of the money                                             */
/* -------------------------------------------------------------------------- */

/**
 * One enrolment, reduced to the facts the per-employer cap turns on.
 *
 * A slot is *delivered* when the learner has sat at least one session, which is why the row
 * carries `present` and not only a status: enrolment on its own is a plan, and a withdrawal
 * with no attendance never occupied a seat. A withdrawal *after* attendance did — the
 * training was delivered and the funder pays nothing for it ("CommCorp will only pay for
 * course completions", §4.1) — so it counts against the cap even though it earns nothing.
 * Counting it is the safe direction: the provider's risk is delivering a slot past the cap
 * it will not be paid for, not leaving one of its own employer's seats unused.
 */
export interface EmployerSlotRow {
  /** The employer the seat was for. Null for a class no employer sponsored. */
  employerId: string | null;
  employerName?: string | null;
  /** When the learner enrolled. The cap is consumed in the order slots were delivered. */
  enrolledOn: Date | string;
  /** `EnrollmentStatus`: ENROLLED, ATTENDED, COMPLETED or WITHDRAWN. */
  status: string;
  /** Sessions attended (the report's `sessions_present`). */
  present: number;
  pricePerSlotCents: number | null;
}

/** One employer's position against the cap, as the provider has to be able to state it. */
export interface EmployerSlotUsage {
  employerId: string;
  employerName: string | null;
  /** The program's cap per employer, or null when it sets none. */
  cap: number | null;
  /** Seats delivered to this employer, in delivery order. */
  slotsUsed: number;
  /** Deliveries inside the cap. Past it, nothing is reimbursable (§4.2). */
  slotsWithinCap: number;
  /** Learners who finished: the only thing the funder pays for (§4.1). */
  completions: number;
  /** Completions inside the cap — the reimbursable ones. */
  reimbursableCompletions: number;
  /** What those come to at the per-slot prices actually charged. */
  reimbursableCents: number;
  /** Completions past the cap: delivered, completed, and unpaid (§1.5, §4.2). */
  unreimbursedCompletions: number;
  /** Slots left under the cap, or null when the program caps nothing. */
  remaining: number | null;
}

/**
 * Every employer's slot position for one provider, worst-off first.
 *
 * The cap is per employer *per approved Applicant* over the contract term (§1.5), so it is
 * computed per employer across every class the provider has run: an employer is not at 90 of
 * its 100 slots because one class is small, it is at 90 because ninety of its people have
 * been trained. Rows with no employer are left out — a class nobody sponsored has no cap to
 * breach, and folding it into an employer's count would invent one.
 *
 * Unordered input is sorted by delivery, because *which* deliveries are past the cap is not
 * academic: a provider that has delivered 96 slots and then completes four more has four
 * unreimbursable completions, and one that completed those four first does not. Ties break
 * on employer key so two runs over the same rows give the same answer.
 */
export function employerSlotUsage(
  rows: readonly EmployerSlotRow[],
  cap: number | null,
): EmployerSlotUsage[] {
  const byEmployer = new Map<string, EmployerSlotRow[]>();
  for (const row of rows) {
    if (!row.employerId) continue;
    const bucket = byEmployer.get(row.employerId);
    if (bucket) bucket.push(row);
    else byEmployer.set(row.employerId, [row]);
  }

  const usage = [...byEmployer.entries()].map(([employerId, bucket]) => {
    const delivered = bucket
      .filter((row) => row.present > 0 || row.status === "COMPLETED")
      .sort((a, b) => day(a.enrolledOn).getTime() - day(b.enrolledOn).getTime());

    const withinCap = delivered.slice(0, cap ?? delivered.length);
    const completions = delivered.filter((row) => row.status === "COMPLETED");
    const reimbursable = withinCap.filter((row) => row.status === "COMPLETED");

    return {
      employerId,
      employerName: bucket.find((row) => row.employerName)?.employerName ?? null,
      cap,
      slotsUsed: delivered.length,
      slotsWithinCap: withinCap.length,
      completions: completions.length,
      reimbursableCompletions: reimbursable.length,
      reimbursableCents: reimbursable.reduce((sum, row) => sum + (row.pricePerSlotCents ?? 0), 0),
      unreimbursedCompletions: completions.length - reimbursable.length,
      remaining: cap === null ? null : Math.max(0, cap - delivered.length),
    };
  });

  // An employer already past the cap is the one a provider has to look at, so it sorts first.
  return usage.sort(
    (a, b) => b.unreimbursedCompletions - a.unreimbursedCompletions || a.slotsUsed - b.slotsUsed,
  );
}

/**
 * Whether the next seat for this employer is inside the cap.
 *
 * Asked *before* the enrolment is written, because §4.2 is blunt about who carries it: "Slots
 * delivered to ineligible employers, or in excess of the cap, are not reimbursable, and the
 * selected Applicant carries that risk." A refusal in words is a seat the provider does not
 * deliver for free.
 */
export function slotRequestProblems(
  employer: { employerName: string; slotsUsed: number; cap: number | null },
  requestedSeats: number,
): RuleProblem[] {
  if (employer.cap === null) return [];
  const wouldBe = employer.slotsUsed + Math.max(1, requestedSeats);
  if (wouldBe <= employer.cap) return [];
  const remaining = Math.max(0, employer.cap - employer.slotsUsed);
  return [
    {
      field: "seats",
      message:
        remaining === 0
          ? `“${employer.employerName}” has taken all ${employer.cap} of its slots with this provider; a seat past the cap is not reimbursable.`
          : `“${employer.employerName}” has ${remaining} of its ${employer.cap} slots left with this provider; another seat would take it past the cap, where nothing is reimbursable.`,
    },
  ];
}

/**
 * An employer, reduced to the two things §4.2 asks the provider to confirm before enrolling
 * anybody: a current Eligibility Confirmation Memo issued by CommCorp, carrying the
 * employer's FEIN and an expiration date.
 */
export interface EmployerEligibility {
  name: string;
  /** CommCorp pre-registers an employer before its workers may be enrolled (§2.2). */
  preRegistered: boolean;
  /** Nine digits, written however the provider keeps it. */
  fein: string | null;
  /** The memo's expiration date. Null means no memo on file. */
  memoExpiresOn: Date | string | null;
}

/** Whether this employer may be enrolled from `asOf` onwards. Empty means yes. */
export function eligibilityProblems(
  employer: EmployerEligibility,
  asOf: Date | string,
): RuleProblem[] {
  const problems: RuleProblem[] = [];
  if (!employer.preRegistered) {
    problems.push({
      field: "isPreRegistered",
      message: `“${employer.name}” is not recorded as pre-registered with the funder, and a slot delivered to an employer CommCorp has not confirmed is not reimbursable.`,
    });
  }

  const digits = (employer.fein ?? "").replace(/\D/g, "");
  if (digits === "") {
    problems.push({
      field: "fein",
      message: `“${employer.name}” has no FEIN on file; every reported slot has to trace to an employer by FEIN.`,
    });
  } else if (digits.length !== 9) {
    problems.push({
      field: "fein",
      message: `“${employer.name}”'s FEIN “${employer.fein}” is ${digits.length} digits; a FEIN is nine.`,
    });
  }

  if (!employer.memoExpiresOn) {
    problems.push({
      field: "eligibilityMemoExpiresOn",
      message: `“${employer.name}” has no eligibility confirmation memo on file, and §4.2 requires one before any of its workers are enrolled.`,
    });
    return problems;
  }

  const expiry = day(employer.memoExpiresOn);
  const from = day(asOf);
  if (expiry < from) {
    problems.push({
      field: "eligibilityMemoExpiresOn",
      message: `“${employer.name}”'s eligibility memo expired ${expiry.toISOString().slice(0, 10)}; a slot delivered on or after ${from.toISOString().slice(0, 10)} is not reimbursable.`,
    });
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/*  What a course has to say to be submitted                                   */
/* -------------------------------------------------------------------------- */

/** Words, counted the way a word limit is counted: runs of non-space characters. */
export function wordCount(text: string | null | undefined): number {
  const trimmed = (text ?? "").trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Whether a course may be added to the catalogue the funder will read (§3.3).
 *
 * Only the three requirements with a number or a list behind them are refused. The rest of
 * the submission — objectives, activities, tools, occupations, prerequisites, how outcomes
 * are measured — belongs to the provider's own narrative, and a refusal invented here would
 * be this app writing the RFQ rather than following it.
 */
export function courseSubmissionProblems(submission: {
  title: string;
  /** The catalogue description, as written. */
  description: string | null;
  /** The in-scope topic areas the course claims (§3.2). */
  topicAreas: readonly string[];
  /** How many courses the catalogue would hold, this one included. */
  courses: number;
  /** The program's own limit, or null. FAST AI's is 20 (§3.3). */
  maxCourses: number | null;
  /** The number this course is submitted under, 1 to 20 (§3.3). */
  courseNumber: number | null;
  /** The AI tools the course covers, one per line as the form writes them. */
  aiTools: readonly string[];
  /** Who the training is for, and which industries and tasks it serves. */
  targetOccupations: string | null;
  targetIndustries: string | null;
  workplaceTasks: string | null;
  /** The most training slots one offering of the course may take (§3.3). */
  maxSlotsPerOffering: number | null;
  /** The numbers the provider's other courses already answer to. */
  takenNumbers?: readonly number[];
}): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const words = wordCount(submission.description);

  if (words === 0) {
    problems.push({
      field: "summary",
      message: `“${submission.title}” has no description; §3.3 asks for one of no more than ${FAST_AI_DESCRIPTION_WORDS} words.`,
    });
  } else if (words > FAST_AI_DESCRIPTION_WORDS) {
    problems.push({
      field: "summary",
      message: `“${submission.title}”'s description runs to ${words} words; the RFQ's limit is ${FAST_AI_DESCRIPTION_WORDS}.`,
    });
  }

  if (submission.topicAreas.length === 0) {
    problems.push({
      field: "topicAreas",
      message: `“${submission.title}” claims no in-scope topic area, and §3.2 lists the ones the program funds.`,
    });
  }

  // The number is how the funder's own paperwork refers to a course, so it is asked for and
  // asked to be unique: two courses answering to "3" is a budget form nobody can read.
  if (submission.courseNumber === null) {
    problems.push({
      field: "courseNumber",
      message: `“${submission.title}” has no course number; §3.3 numbers each submitted course 1 to ${FAST_AI_MAX_COURSES}.`,
    });
  } else if (
    !Number.isInteger(submission.courseNumber) ||
    submission.courseNumber < 1 ||
    submission.courseNumber > FAST_AI_MAX_COURSES
  ) {
    problems.push({
      field: "courseNumber",
      message: `“${submission.title}” is submitted as course ${submission.courseNumber}; the RFQ numbers courses 1 to ${FAST_AI_MAX_COURSES}.`,
    });
  } else if ((submission.takenNumbers ?? []).includes(submission.courseNumber)) {
    problems.push({
      field: "courseNumber",
      message: `Another course in this catalogue is already number ${submission.courseNumber}; each submitted course gets its own number.`,
    });
  }

  if (submission.aiTools.length === 0) {
    problems.push({
      field: "aiTools",
      message: `“${submission.title}” names no AI tools; §3.3 asks every course for the tools it covers.`,
    });
  }

  const named: Array<[keyof typeof submission, string, string]> = [
    ["targetOccupations", "target occupations", "who the training is for"],
    ["targetIndustries", "target industries", "which sectors of scale it serves"],
    ["workplaceTasks", "workplace tasks", "what it changes about the job"],
  ];
  for (const [field, label, why] of named) {
    if (!String(submission[field] ?? "").trim()) {
      problems.push({
        field,
        message: `“${submission.title}” states no ${label}; §3.3 asks each course to say ${why}.`,
      });
    }
  }

  if (submission.maxSlotsPerOffering === null || submission.maxSlotsPerOffering <= 0) {
    problems.push({
      field: "maxSlotsPerOffering",
      message: `“${submission.title}” does not say how many training slots one offering may take; §3.3 asks for that number.`,
    });
  }

  if (submission.maxCourses !== null && submission.courses > submission.maxCourses) {
    problems.push({
      field: "courses",
      message: `This catalogue would hold ${submission.courses} courses; the funder accepts ${submission.maxCourses} in this round and will not consider the rest.`,
    });
  }

  return problems;
}

/**
 * Whether one class fits inside the course's own ceiling on an offering.
 *
 * §3.3 asks each course to state the maximum number of training slots one offering of it may
 * take, which is a fact about the course that only becomes checkable when a class is scheduled:
 * a class offering more seats than the course was submitted for is a class the funder was never
 * asked to fund.
 */
export function offeringSeatProblems(
  course: { title: string; maxSlotsPerOffering: number | null },
  klass: { name: string; seats: number | null },
): RuleProblem[] {
  const cap = course.maxSlotsPerOffering;
  if (cap === null || klass.seats === null) return [];
  if (!Number.isInteger(klass.seats) || klass.seats <= 0) return [];
  if (klass.seats <= cap) return [];
  return [
    {
      field: "seats",
      message: `“${course.title}” is offered in at most ${cap} training slots; “${klass.name}” offers ${klass.seats} seats.`,
    },
  ];
}

/**
 * Topic areas the RFQ does not list, returned rather than refused.
 *
 * §3.2 says "Other AI-related topics will be considered as needed", so an unlisted topic is a
 * fact for the provider to confirm with CommCorp, not a rule this app can enforce on its
 * behalf. Naming it is the whole point: a course whose only topic is something the directory
 * has never seen should say so before it is submitted, not after.
 */
export function unrecognisedTopics(topicAreas: readonly string[]): string[] {
  const known = new Set<string>(FAST_AI_TOPIC_AREAS.map((area) => area.toLowerCase()));
  return topicAreas.filter((area) => area.trim() !== "" && !known.has(area.trim().toLowerCase()));
}

/**
 * The FAST AI program as CommCorp publishes it, ready to be the default when someone
 * creates a program of this kind. Kept beside the rules so the seeded program and the
 * numbers that govern it cannot drift apart.
 */
export const FAST_AI_PROGRAM = {
  name: "Focused AI Skills Training (FAST AI)",
  funder: "Commonwealth Corporation",
  fundName: "Workforce Investment Trust Fund",
  startsOn: FAST_AI_WINDOW_START,
  endsOn: FAST_AI_WINDOW_END,
  /// The contract the caps run over, which is longer than the training window.
  contractStartsOn: FAST_AI_CONTRACT_START,
  contractEndsOn: FAST_AI_CONTRACT_END,
  awardCents: FAST_AI_AWARD_CENTS,
  /// The FY27 pool the award comes out of, not the provider's own money.
  allocationCents: FAST_AI_FY27_ALLOCATION_CENTS,
  costPerHourCents: FAST_AI_COST_PER_HOUR_CENTS,
  costPerPersonCents: FAST_AI_COST_PER_PERSON_CENTS,
  employerSlotCap: FAST_AI_EMPLOYER_SLOT_CAP,
  maxCourses: FAST_AI_MAX_COURSES,
  reportingCadence: "monthly",
} as const;
