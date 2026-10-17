/**
 * The FAST AI seed: CommCorp's Focused AI Skills Training program, as a tenancy of its own.
 *
 * Called from `prisma/seed.ts` (and so by `npm run db:seed` and `npm run setup`) so a fresh
 * demo database already contains the thing the platform was extended for: the Massachusetts
 * Workforce Development tenancy running an applied-AI program for a pre-registered
 * Massachusetts employer, with courses that fit the funder's price ceilings and classes
 * inside its window.
 *
 * Everything upserts on a stable key — a slug, a join code, an email — so re-running the
 * seed converges on the same tenancy rather than stacking a second copy of it. The one
 * deliberate exception is a course's modules, which are keyed on their position within the
 * course: that is what makes editing this file the way to change authored content, with
 * re-seeding as the way to apply it.
 */

import type { PrismaClient } from "@prisma/client";

import { FAST_AI_CONTRACT_END, FAST_AI_PROGRAM, type FastAiTopicArea } from "../src/lib/program-rules";

/** The provider tenancy the whole FAST AI program hangs off. */
export const FAST_AI_TENANT_SLUG = "mass-workforce-development";

/** The employer whose people are trained and who pays for the seats. */
export const FAST_AI_SPONSOR_SLUG = "charles-river-home-care";

/**
 * The demo employer's FEIN, nine digits as a FEIN is.
 *
 * Invented, and inert: nothing in this app checks a FEIN against the IRS, and a Massachusetts
 * employer's real one is not something a demo database should be carrying. What it is *for* is
 * the shape the funder's report needs — every reported slot traced to an employer by FEIN — so
 * the field has something of the right kind in it rather than a placeholder that would fail the
 * check a real one has to pass.
 */
export const FAST_AI_SPONSOR_FEIN = "04-3681297";

/**
 * Join codes for the seeded classes, so re-seeding repairs rather than duplicates them.
 *
 * They follow the same rule the generator does — no I, O, 0 or 1 — because a code is read
 * aloud to a room of learners, and those four are the characters that come back wrong.
 */
export const FAST_AI_CLASS_CODES = ["FASTAP", "FASTCS", "FASTAD"] as const;

export interface SeedModule {
  title: string;
  hours: number;
  /** One objective per line — the shape the admin page reads back as a list. */
  objectives: string[];
  activity: string;
  outcome: string;
}

export interface SeedCourse {
  title: string;
  summary: string;
  /**
   * The in-scope topic areas the course claims, from the RFQ's §3.2 list.
   *
   * A fact rather than a formality: §3.3 requires every submitted course to name the topic
   * area(s) it covers, the directory is browsed by them, and a course that claims none cannot
   * be placed. They are the RFQ's own words so the seeded catalogue reads the way the funder's
   * does — which is also what lets `unrecognisedTopics` report nothing about it.
   */
  topicAreas: FastAiTopicArea[];
  /** The number this course is submitted under, 1 to 20 (§3.3). */
  courseNumber: number;
  /** §3.3's remaining course details, one entry per line as the form writes them. */
  aiTools: string[];
  targetOccupations: string[];
  targetIndustries: string[];
  workplaceTasks: string[];
  /** Empty when the course earns none — the RFQ says "if any". */
  credentials: string;
  /** Empty when it is taught in English only. */
  languages: string;
  /** The most training slots one offering of it may take; its classes may not seat more. */
  maxSlotsPerOffering: number;
  instructionalHours: number;
  pricePerSlotCents: number;
  audience: string;
  prerequisites: string;
  modules: SeedModule[];
}

/**
 * The applied-AI catalogue.
 *
 * The RFQ is explicit that it will not fund general AI literacy, so every module here ends
 * in something the learner does with the tools they already have in their own role: writing
 * a prompt for a task from their workload, checking an answer before it goes out, masking
 * what must not leave the building. The prices are set against the funder's two ceilings —
 * and two of the four exist to exercise the *per-person* ceiling, which is the binding one
 * on a long course and the easy one to get wrong.
 */
export const FAST_AI_COURSES: SeedCourse[] = [
  {
    title: "Applied AI for the Frontline Role",
    topicAreas: ["Generative AI", "AI productivity applications"],
    courseNumber: 1,
    aiTools: ["Microsoft 365 Copilot", "The organisation's approved AI assistant"],
    targetOccupations: ["Home health aide", "Direct support professional", "Front desk coordinator", "Team lead"],
    targetIndustries: ["Home and community care", "Human services", "Behavioural health"],
    workplaceTasks: [
      "Summarising a client's history before a visit",
      "Drafting a reply to a family member's question",
      "Reading a policy and restating it for the team",
    ],
    credentials: "",
    languages: "",
    maxSlotsPerOffering: 16,
    summary:
      "Six hours of hands-on practice with generative AI on tasks a frontline worker already does: reading a policy, drafting a reply, summarising a customer's history.",
    instructionalHours: 6,
    pricePerSlotCents: 180_000, // $1,800 — exactly $300 × 6 hours
    audience: "Frontline staff and team leads in service delivery roles",
    prerequisites: "None. No technical background assumed.",
    modules: [
      {
        title: "Where AI already sits in your work",
        hours: 1.5,
        objectives: [
          "Name three tasks in your own week that are text-in, text-out",
          "Distinguish what a generative model does from what it knows",
          "Identify the tasks on your desk that AI must never be given",
        ],
        activity:
          "Learners map their own week onto a two-column sheet — \"AI can draft this\" and \"this stays with me\" — using the week they have actually had, not a case study.",
        outcome: "A one-page task map, reviewed by the facilitator against the two-column rubric.",
      },
      {
        title: "Prompting for a real task, not a demo",
        hours: 2,
        objectives: [
          "Write a prompt that states the audience, the format and the constraint",
          "Give the model the facts it needs instead of hoping it knows them",
          "Rewrite a bad prompt into a usable one",
        ],
        activity:
          "Each learner brings one email or report they have to write anyway, writes the prompt, runs it, and revises twice. Pairs review each other's prompts before the run.",
        outcome: "A before/after prompt pair with the output each produced, marked on role, format and constraint.",
      },
      {
        title: "Checking the answer before it leaves your desk",
        hours: 1.5,
        objectives: [
          "Verify a claim the model made rather than trusting its confidence",
          "Recognise a fabricated citation, policy number or name",
          "Apply your organisation's rule on personal and client information",
        ],
        activity:
          "Learners are given three model outputs — one correct, one confidently wrong, one leaking a plausible-looking client detail — and have to classify and fix each.",
        outcome: "A short written account of how each output was checked and what changed.",
      },
      {
        title: "Taking it back to the team",
        hours: 1,
        objectives: [
          "Describe the two guardrails you will keep using",
          "Show a colleague the one task this helps with most",
        ],
        activity:
          "Each learner drafts the ten-minute walkthrough they will give their team on Monday, and delivers it to one other learner.",
        outcome: "The walkthrough outline, plus a written note of what the listener still found unclear.",
      },
    ],
  },
  {
    title: "AI-Assisted Customer Support",
    topicAreas: ["Generative AI", "Occupation-specific AI applications"],
    courseNumber: 2,
    aiTools: ["Microsoft 365 Copilot", "The organisation's ticketing system"],
    targetOccupations: ["Customer support representative", "Intake coordinator", "Receptionist"],
    targetIndustries: ["Home and community care", "Retail", "Financial services"],
    workplaceTasks: [
      "Triaging an inbox",
      "Drafting a reply in the organisation's own voice",
      "Summarising a long thread for a colleague",
    ],
    credentials: "",
    // Delivered in English and Spanish, because the employers this serves take calls in both.
    languages: "Spanish",
    maxSlotsPerOffering: 14,
    summary:
      "Eight hours on AI where it touches the customer: triage, drafting, summarising a long thread, and keeping the tone the organisation stands behind.",
    instructionalHours: 8,
    pricePerSlotCents: 240_000, // $2,400 — exactly $300 × 8 hours
    audience: "Support, intake and reception staff",
    prerequisites: "None.",
    modules: [
      {
        title: "Triaging an inbox with a model that has the facts",
        hours: 2,
        objectives: [
          "Summarise a twenty-message thread without losing the commitments made",
          "Route a request to the right queue using your own categories",
        ],
        activity: "Learners summarise three anonymised threads from their own queue and compare the routing they would each choose.",
        outcome: "Three summaries, each checked against the original thread for a missed commitment.",
      },
      {
        title: "Drafting a reply in the organisation's voice",
        hours: 2,
        objectives: [
          "Write a reply the service standard would accept unedited",
          "Adjust tone for a distressed customer without inventing promises",
        ],
        activity: "Draft-and-revise on three real scenarios, with the service standard sheet beside the keyboard.",
        outcome: "One reply per scenario, passed against the tone and commitments checklist.",
      },
      {
        title: "What must not go into a prompt",
        hours: 2,
        objectives: [
          "Apply the organisation's rules on client identifiers and case notes",
          "Replace identifying detail with what the model actually needs",
        ],
        activity:
          "Learners redact three of their own drafts under the rule, then compare redactions in pairs and settle the disagreements against the policy.",
        outcome: "A redaction exercise marked correct only if nothing identifying survives.",
      },
      {
        title: "Measuring whether it helped",
        hours: 2,
        objectives: [
          "Pick two numbers that move if this works",
          "Keep a one-week log that does not become a second job",
        ],
        activity: "Learners design the log they will keep for the following week and run a first day of it.",
        outcome: "A one-page measurement plan with the log's fields and where it is kept.",
      },
    ],
  },
  {
    title: "Automating the Paperwork: AI for Administrative Roles",
    topicAreas: [
      "Workflow improvement and business process applications",
      "AI productivity applications",
    ],
    courseNumber: 3,
    aiTools: ["Microsoft 365 Copilot", "Power Automate", "Acrobat AI Assistant"],
    targetOccupations: ["Administrative assistant", "Billing and claims specialist", "Operations coordinator"],
    targetIndustries: ["Home and community care", "Non-profit administration", "Professional services"],
    workplaceTasks: [
      "Extracting fields from a referral packet",
      "Drafting the routine correspondence",
      "Keeping a prompt library the office can reuse",
    ],
    credentials: "Microsoft Office Specialist (optional, at the employer's request)",
    languages: "",
    maxSlotsPerOffering: 12,
    summary:
      "Twelve hours for the people who move the paper: extracting from documents, drafting the routine correspondence, and building a reusable prompt library for the office.",
    instructionalHours: 12,
    pricePerSlotCents: 270_000, // $2,700 — $225/hour, under the $3,000 per-person ceiling
    audience: "Administrative, finance and operations staff",
    prerequisites: "Comfort with spreadsheets and email.",
    modules: [
      {
        title: "Documents in, structured data out",
        hours: 3,
        objectives: [
          "Extract fields from an invoice or intake form with a prompt that states the schema",
          "Spot where an extracted field has been invented",
        ],
        activity: "Learners extract the same six fields from five real document shapes and reconcile against the originals.",
        outcome: "An extraction sheet with every discrepancy from the source document flagged.",
      },
      {
        title: "The office prompt library",
        hours: 3,
        objectives: [
          "Turn a task you repeat weekly into a prompt somebody else can run",
          "Name the prompt so a colleague finds it without asking",
        ],
        activity: "Each learner converts two recurring tasks into library entries and hands them to a colleague to run cold.",
        outcome: "Two library entries another learner completed without help.",
      },
      {
        title: "Routine correspondence at volume",
        hours: 3,
        objectives: [
          "Draft the standard letters with the right merge fields",
          "Keep a single version of a template rather than five near-copies",
        ],
        activity: "Build one letter template end-to-end, merge it against a small roster, and review three outputs.",
        outcome: "One template plus its merged output, checked for the fields that must never be blank.",
      },
      {
        title: "Recording the process so it survives you",
        hours: 3,
        objectives: [
          "Write down the steps so a successor can run them",
          "State the limits of what the automation may decide",
        ],
        activity: "Learners write the runbook for the process they automated and have a peer follow it verbatim.",
        outcome: "A runbook a peer completed without asking a question, with its decision limits stated.",
      },
    ],
  },
  {
    title: "Data-Ready: Preparing Your Team's Information for AI",
    topicAreas: ["Data science and machine learning", "AI-assisted analytics and business intelligence"],
    courseNumber: 4,
    aiTools: ["Microsoft 365 Copilot", "Excel with Copilot", "Power BI"],
    targetOccupations: ["Program manager", "Records and compliance coordinator", "Data steward"],
    targetIndustries: ["Home and community care", "Human services", "Public sector programmes"],
    workplaceTasks: [
      "Auditing a shared drive for what a model may see",
      "Deciding what must never leave the building",
      "Preparing a case file so an AI tool can be pointed at it",
    ],
    credentials: "",
    languages: "",
    // The smallest offering of the four: this is the course that needs a room and a case file,
    // and the ceiling is the number the funder was asked to fund.
    maxSlotsPerOffering: 10,
    summary:
      "Twenty hours on the groundwork: what your team's documents, spreadsheets and case files have to look like before an AI tool can be pointed at them usefully and safely.",
    instructionalHours: 20,
    pricePerSlotCents: 300_000, // $3,000 — the per-person ceiling, where the hourly one would allow $6,000
    audience: "Program managers and staff who own a team's records",
    prerequisites: "Some responsibility for a shared drive, database or case file.",
    modules: [
      {
        title: "Inventorying what you actually hold",
        hours: 5,
        objectives: [
          "List the systems and folders your team depends on",
          "Say which of them hold personal or protected information",
        ],
        activity: "Build the inventory for your own team in the room, from memory first and then against the shared drive.",
        outcome: "A completed inventory with the protected systems marked.",
      },
      {
        title: "One document, many versions",
        hours: 5,
        objectives: [
          "Find the authoritative copy of a document your team argues about",
          "Propose a naming and retention rule the team will follow",
        ],
        activity: "Audit one contested document set and present both the duplicates found and the rule proposed.",
        outcome: "A duplicate audit with a written retention and naming rule.",
      },
      {
        title: "Structuring for retrieval",
        hours: 5,
        objectives: [
          "Turn an unstructured file into records with the fields you ask questions of",
          "Explain why the same content retrieved well answers better questions",
        ],
        activity: "Convert twenty real documents into structured records and query them with a model, comparing answers against the raw files.",
        outcome: "Twenty structured records and a written comparison of the two answer sets.",
      },
      {
        title: "Staying inside the rules you are already under",
        hours: 5,
        objectives: [
          "State the obligations that apply to your data, in your own words",
          "Write the safeguards that follow from them",
        ],
        activity: "Map the obligations to the inventory from module one and draft the safeguards the team will operate.",
        outcome: "An obligations-and-safeguards table signed off by the learner's manager.",
      },
    ],
  },
];

export interface SeedLearner {
  name: string;
  email: string;
  accent: string;
}

/**
 * The classes, as seeded. Exported so a test can hold them against the funder's window and
 * ceilings without a database: the arithmetic that decides whether a class is fundable is
 * the same arithmetic whichever tenancy schedules it.
 */
export interface SeedClass {
  code: string;
  name: string;
  courseTitle: string;
  startsOn: string;
  endsOn: string;
  seats: number;
  pricePerSlotCents: number;
  instructionalHours: number;
  location: string;
  enroll: string[];
  /**
   * The funder's feedback instruments for this sitting (§4.5). Optional, because the RFQ sets
   * them at contracting: the demo records the trainee one on the first class so the surface is
   * visible, and leaves the employer one unset so the "still owed" line is visible beside it.
   */
  traineeSurveyUrl?: string;
  employerSurveyUrl?: string;
}

/** The seeded classes. */
export const FAST_AI_CLASS_PLAN: SeedClass[] = [
  {
    code: FAST_AI_CLASS_CODES[0],
    name: "FAST AI — Applied AI for the Frontline Role (Spring 2027)",
    courseTitle: "Applied AI for the Frontline Role",
    startsOn: "2027-03-02",
    endsOn: "2027-03-16",
    seats: 16,
    pricePerSlotCents: 180_000,
    instructionalHours: 6,
    location: "Charles River Home Care, Watertown MA",
    enroll: ["maria@ontrak.local", "devon@ontrak.local", "yusuf@ontrak.local"],
    traineeSurveyUrl: "https://survey.massworkforce.example/fast-ai/trainee",
  },
  {
    code: FAST_AI_CLASS_CODES[1],
    name: "FAST AI — AI-Assisted Customer Support (Spring 2027)",
    courseTitle: "AI-Assisted Customer Support",
    startsOn: "2027-04-06",
    endsOn: "2027-04-27",
    seats: 14,
    pricePerSlotCents: 240_000,
    instructionalHours: 8,
    location: "Remote, instructor-led",
    enroll: ["priya@ontrak.local", "devon@ontrak.local"],
  },
  {
    code: FAST_AI_CLASS_CODES[2],
    name: "FAST AI — Automating the Paperwork (Summer 2027)",
    courseTitle: "Automating the Paperwork: AI for Administrative Roles",
    startsOn: "2027-07-13",
    endsOn: "2027-08-10",
    seats: 12,
    pricePerSlotCents: 270_000,
    instructionalHours: 12,
    location: "Roxbury, MA",
    enroll: ["yusuf@ontrak.local", "priya@ontrak.local"],
  },
];

/**
 * The learners and staff inside the FAST AI tenancy.
 *
 * Real accounts with the demo password, because the point of seeding them is that somebody
 * can sign in as one and see the class from the learner's side — not merely that the report
 * has rows in it. Their emails are listed in `demo-reset-rules.ts` so a demo reset clears
 * their attempts instead of deleting them.
 */
const LEARNERS: SeedLearner[] = [
  { name: "Maria Ferreira", email: "maria@ontrak.local", accent: "teal" },
  { name: "Devon Clarke", email: "devon@ontrak.local", accent: "violet" },
  { name: "Yusuf Rahman", email: "yusuf@ontrak.local", accent: "amber" },
  { name: "Priya Nagarajan", email: "priya@ontrak.local", accent: "sky" },
];

export interface FastAiSeedOptions {
  /** Hashed once by the caller so every seeded account shares the demo password. */
  passwordHash: string;
  /** The tenancy's administrator, who is also the program's first point of contact. */
  administrator: { name: string; email: string };
  /** The instructor the seeded classes belong to. */
  instructor: { name: string; email: string };
}

export interface FastAiSeedResult {
  tenantId: string;
  sponsorId: string;
  programId: string;
  courseCount: number;
  classCount: number;
  enrollmentCount: number;
}

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

export async function seedFastAi(
  prisma: PrismaClient,
  options: FastAiSeedOptions,
): Promise<FastAiSeedResult> {
  /* ------------------------------------------------------------- the tenancy */
  const tenant = await prisma.organization.upsert({
    where: { slug: FAST_AI_TENANT_SLUG },
    create: {
      name: "Massachusetts Workforce Development",
      slug: FAST_AI_TENANT_SLUG,
      kind: "PROVIDER",
      programType: "Focused AI Skills Training (FAST AI)",
      description:
        "Applied AI training for Massachusetts employers, funded through the Workforce Investment Trust Fund. Classes are instructor-led, contextualised to the learner's own role, and priced within CommCorp's ceilings.",
      displayName: "FAST AI",
      accent: "teal",
      city: "Boston",
      state: "MA",
      // The contact block the directory's entries carry (§4.4): who an employer asks for, and how.
      // A "fictional" reserve domain, so the demo cannot accidentally publish somebody's address.
      contactName: "Program Director, Workforce Development",
      contactEmail: "fastai@massworkforce.example",
      contactPhone: "617-555-0142",
    },
    update: {
      name: "Massachusetts Workforce Development",
      kind: "PROVIDER",
      contactName: "Program Director, Workforce Development",
      contactEmail: "fastai@massworkforce.example",
      contactPhone: "617-555-0142",
    },
  });

  const sponsor = await prisma.organization.upsert({
    where: { slug: FAST_AI_SPONSOR_SLUG },
    create: {
      name: "Charles River Home Care",
      slug: FAST_AI_SPONSOR_SLUG,
      kind: "EMPLOYER",
      programType: "Home care and community services",
      description:
        "A Massachusetts employer whose frontline and administrative staff are being trained under FAST AI. Pre-registered with CommCorp, which is what makes its classes fundable.",
      city: "Watertown",
      state: "MA",
      isPreRegistered: true,
      // The two facts §4.2 asks a provider to confirm before enrolling anybody. The FEIN is what
      // every reported slot traces back to, and the memo's expiration is set at the end of the
      // contract term so the demo employer is eligible for every class the seed schedules — a
      // demo whose first enrolment is refused for an expired memo teaches the wrong thing.
      fein: FAST_AI_SPONSOR_FEIN,
      eligibilityMemoExpiresOn: day(FAST_AI_CONTRACT_END),
    },
    update: {
      isPreRegistered: true,
      kind: "EMPLOYER",
      fein: FAST_AI_SPONSOR_FEIN,
      eligibilityMemoExpiresOn: day(FAST_AI_CONTRACT_END),
    },
  });

  /* ------------------------------------------------------------ the program */
  // Keyed on the name inside the tenancy: `Program` deliberately has no unique constraint on
  // it, because a funder may run the same program name twice with different funds.
  const programData = {
    name: FAST_AI_PROGRAM.name,
    funder: FAST_AI_PROGRAM.funder,
    fundName: FAST_AI_PROGRAM.fundName,
    startsOn: day(FAST_AI_PROGRAM.startsOn),
    endsOn: day(FAST_AI_PROGRAM.endsOn),
    awardCents: FAST_AI_PROGRAM.awardCents,
    costPerHourCents: FAST_AI_PROGRAM.costPerHourCents,
    costPerPersonCents: FAST_AI_PROGRAM.costPerPersonCents,
    allocationCents: FAST_AI_PROGRAM.allocationCents,
    contractStartsOn: day(FAST_AI_PROGRAM.contractStartsOn),
    contractEndsOn: day(FAST_AI_PROGRAM.contractEndsOn),
    employerSlotCap: FAST_AI_PROGRAM.employerSlotCap,
    maxCourses: FAST_AI_PROGRAM.maxCourses,
    reportingCadence: FAST_AI_PROGRAM.reportingCadence,
    // The cap is stated the way CommCorp answered it (RFQ answers, 2026-10-13, §4): it counts the
    // slots the funder reimburses, so a withdrawal or a no-show is not one of them.
    notes: `Training starts on or after ${FAST_AI_PROGRAM.startsOn} and is complete by ${FAST_AI_PROGRAM.endsOn}. No more than $300 per instructional hour per slot and $3,000 per person per course, whichever is less. No employer may take more than ${FAST_AI_PROGRAM.employerSlotCap} completed slots over the contract term — the cap counts what CommCorp reimburses, so seats that do not complete do not count against it. Up to ${FAST_AI_PROGRAM.maxCourses} courses are accepted in this round.`,
  };
  const existingProgram = await prisma.program.findFirst({
    where: { organizationId: tenant.id, name: programData.name },
  });
  const program = existingProgram
    ? await prisma.program.update({ where: { id: existingProgram.id }, data: programData })
    : await prisma.program.create({ data: { organizationId: tenant.id, ...programData } });

  /* ------------------------------------------------------------- the people */
  const administrator = await prisma.user.upsert({
    where: { email: options.administrator.email },
    create: {
      name: options.administrator.name,
      email: options.administrator.email,
      passwordHash: options.passwordHash,
      role: "ADMIN",
      accent: "pink",
      organizationId: tenant.id,
    },
    update: { name: options.administrator.name, role: "ADMIN", passwordHash: options.passwordHash, organizationId: tenant.id },
  });

  const instructor = await prisma.user.upsert({
    where: { email: options.instructor.email },
    create: {
      name: options.instructor.name,
      email: options.instructor.email,
      passwordHash: options.passwordHash,
      role: "INSTRUCTOR",
      accent: "violet",
      organizationId: tenant.id,
    },
    update: { name: options.instructor.name, role: "INSTRUCTOR", passwordHash: options.passwordHash, organizationId: tenant.id },
  });

  const learners: { id: string; email: string; name: string }[] = [];
  for (const learner of LEARNERS) {
    const user = await prisma.user.upsert({
      where: { email: learner.email },
      create: {
        name: learner.name,
        email: learner.email,
        passwordHash: options.passwordHash,
        role: "STUDENT",
        accent: learner.accent,
        organizationId: tenant.id,
      },
      update: { name: learner.name, role: "STUDENT", passwordHash: options.passwordHash, organizationId: tenant.id },
    });
    learners.push({ id: user.id, email: user.email, name: user.name });
  }

  /* ----------------------------------------------------------- the catalogue */
  const courses = new Map<string, { id: string; pricePerSlotCents: number; instructionalHours: number }>();
  for (const course of FAST_AI_COURSES) {
    const data = {
      programId: program.id,
      title: course.title,
      summary: course.summary,
      deliveryMode: "instructor-led",
      instructionalHours: course.instructionalHours,
      pricePerSlotCents: course.pricePerSlotCents,
      audience: course.audience,
      prerequisites: course.prerequisites,
      topicAreas: course.topicAreas.join("\n"),
      courseNumber: course.courseNumber,
      aiTools: course.aiTools.join("\n"),
      targetOccupations: course.targetOccupations.join("\n"),
      targetIndustries: course.targetIndustries.join("\n"),
      workplaceTasks: course.workplaceTasks.join("\n"),
      credentials: course.credentials || null,
      languages: course.languages || null,
      maxSlotsPerOffering: course.maxSlotsPerOffering,
      directoryApprovedAt: day(FAST_AI_PROGRAM.startsOn),
    };
    const existing = await prisma.course.findFirst({
      where: { organizationId: tenant.id, title: course.title },
    });
    const record = existing
      ? await prisma.course.update({ where: { id: existing.id }, data })
      : await prisma.course.create({ data: { organizationId: tenant.id, ...data } });

    for (const [index, module] of course.modules.entries()) {
      const moduleData = {
        title: module.title,
        hours: module.hours,
        objectives: module.objectives.join("\n"),
        activity: module.activity,
        outcome: module.outcome,
      };
      await prisma.courseModule.upsert({
        where: { courseId_position: { courseId: record.id, position: index + 1 } },
        create: { courseId: record.id, position: index + 1, ...moduleData },
        update: moduleData,
      });
    }

    courses.set(course.title, {
      id: record.id,
      pricePerSlotCents: course.pricePerSlotCents,
      instructionalHours: course.instructionalHours,
    });
  }

  /* ------------------------------------------------------------- the classes */
  // Three classes across the window, one per course shape: a short frontline course, a
  // support-team course, and the longer administrative one whose price is bound by the
  // per-person ceiling rather than the hourly one.
  const plan = FAST_AI_CLASS_PLAN;
  let classCount = 0;
  let enrollmentCount = 0;

  for (const entry of plan) {
    const course = courses.get(entry.courseTitle);
    if (!course) continue;

    const data = {
      name: entry.name,
      description: `${entry.instructionalHours} instructor-led hours for ${sponsor.name}.`,
      instructorId: instructor.id,
      organizationId: tenant.id,
      programId: program.id,
      courseId: course.id,
      sponsorOrganizationId: sponsor.id,
      startsOn: day(entry.startsOn),
      endsOn: day(entry.endsOn),
      instructionalHours: entry.instructionalHours,
      seats: entry.seats,
      pricePerSlotCents: entry.pricePerSlotCents,
      deliveryMode: "instructor-led",
      location: entry.location,
      traineeSurveyUrl: entry.traineeSurveyUrl ?? null,
      employerSurveyUrl: entry.employerSurveyUrl ?? null,
    };

    const klass = await prisma.cohort.upsert({
      where: { joinCode: entry.code },
      create: { joinCode: entry.code, ...data },
      update: data,
    });
    classCount += 1;

    for (const email of entry.enroll) {
      const learner = learners.find((candidate) => candidate.email === email);
      if (!learner) continue;

      await prisma.cohortMember.upsert({
        where: { cohortId_userId: { cohortId: klass.id, userId: learner.id } },
        create: { cohortId: klass.id, userId: learner.id },
        update: {},
      });

      const enrollment = await prisma.enrollment.upsert({
        where: { cohortId_userId: { cohortId: klass.id, userId: learner.id } },
        create: {
          cohortId: klass.id,
          userId: learner.id,
          organizationId: tenant.id,
          sponsorOrganizationId: sponsor.id,
          funded: true,
        },
        // The status and hours are recomputed below from the sittings, so a re-seed
        // repairs an enrolment somebody edited by hand rather than preserving the edit.
        update: { organizationId: tenant.id, sponsorOrganizationId: sponsor.id, funded: true },
      });
      enrollmentCount += 1;

      /* Attendance: two sittings for the learners in the first class, one for the rest.
         Enough that the report has attendance in it, and that a completion has hours
         behind it rather than being an assertion with nothing under it. */
      const sittings =
        entry.code === FAST_AI_CLASS_CODES[0]
          ? [
              { date: entry.startsOn, status: "PRESENT" as const, hours: 3 },
              { date: entry.endsOn, status: "PRESENT" as const, hours: 3 },
            ]
          : [
              { date: entry.startsOn, status: "PRESENT" as const, hours: entry.instructionalHours / 2 },
              { date: entry.endsOn, status: "EXCUSED" as const, hours: 0 },
            ];

      for (const sitting of sittings) {
        await prisma.attendance.upsert({
          where: { enrollmentId_sessionDate: { enrollmentId: enrollment.id, sessionDate: day(sitting.date) } },
          create: {
            enrollmentId: enrollment.id,
            organizationId: tenant.id,
            sessionDate: day(sitting.date),
            status: sitting.status,
            hours: sitting.hours,
            note: sitting.status === "EXCUSED" ? "Excused — shift cover, made up in class." : null,
          },
          update: { status: sitting.status, hours: sitting.hours },
        });
      }

      const totals = await prisma.attendance.aggregate({
        where: { enrollmentId: enrollment.id, status: "PRESENT" },
        _sum: { hours: true },
      });
      const attended = totals._sum.hours ?? 0;
      // The first learner in the first class finished it, so the report, the completion
      // figure and the "completed" badge all have something real to show.
      const completed =
        entry.code === FAST_AI_CLASS_CODES[0] && email === "maria@ontrak.local";

      await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          hoursAttended: attended,
          status: completed ? "COMPLETED" : attended > 0 ? "ATTENDED" : "ENROLLED",
          completedAt: completed ? day(entry.endsOn) : null,
          // A completion the funder would pay for has the course's assessment behind it, so the
          // seeded one carries the record rather than being an assertion with nothing under it
          // (RFQ answers, 2026-10-13, §4).
          assessmentRecordedAt: completed ? day(entry.endsOn) : null,
        },
      });
    }
  }

  await prisma.auditLog.create({
    data: {
      actorId: administrator.id,
      action: "program.seed",
      targetType: "program",
      targetId: program.id,
      detail: { tenant: tenant.slug, courses: FAST_AI_COURSES.length, classes: classCount },
    },
  });

  return {
    tenantId: tenant.id,
    sponsorId: sponsor.id,
    programId: program.id,
    courseCount: courses.size,
    classCount,
    enrollmentCount,
  };
}
