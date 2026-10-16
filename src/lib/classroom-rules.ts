/**
 * The AI classroom a class is taught with — read from the environment, generated from the
 * course, and never guessed at.
 *
 * A funded class is what OnTrak is the system of record for: who is enrolled, who attended,
 * what was assessed, and what the provider may charge. It is not where a learner *practises*
 * AI. That is a classroom: a generated, multi-agent lesson with slides, quizzes, interactive
 * simulations and AI teachers and classmates who speak and draw — and in this estate it is
 * served by **AthenIQ**, the family's learning platform, which runs **OpenMAIC**
 * (github.com/THU-MAIC/OpenMAIC, MIT) as its classroom layer behind
 * `classroom.<base domain>`, authenticates its visitors through the same Authentik tenant
 * (the `atheniq-classroom` client) and routes every model call through the platform's single
 * OmniRoute gateway. OnTrak does not stand up a second classroom host; it hands a class to
 * AthenIQ's.
 *
 * Four decisions are worth stating out loud, because each is a bug this module exists to
 * prevent.
 *
 * **The host is off unless an operator says otherwise.** `ONTRAK_CLASSROOM_ENABLED` is the
 * switch and `ONTRAK_CLASSROOM_URL` is the address, and both are required: a deployment that
 * has set neither behaves exactly as it did before this file existed and offers no door. A
 * stated address that was *refused* keeps its reason rather than quietly becoming a
 * family-style link that resolves to nothing — the same rule the lab's door makes.
 *
 * **The link carries no identity.** AthenIQ signs its own visitors in (Authentik OIDC, or
 * OpenMAIC's `ACCESS_CODE` on a shared deployment), so the deep link only puts a person in
 * front of it. A query parameter carrying an address or a subject would be a second, weaker
 * identity path.
 *
 * **A stored address is validated before it is ever rendered.** Everything else on a class
 * page is authored inside this app; a classroom address is copied out of another product and
 * pasted into a form, and a `javascript:` URL in an `href` is script execution with the
 * reader's own privileges. Only absolute http(s) addresses with no embedded credentials
 * survive `classroomLink`, and the refusal is a sentence an operator can act on.
 *
 * **The specification is generated here, not written by hand.** AthenIQ's generative
 * classrooms are *specified* rather than committed as content: `courses/<slug>/openmaic/
 * classrooms.json` in that repository — `version`, `provider`, `gateway`, `source_course`,
 * `defaults`, and one entry per chapter with a `prompt`, `objectives` and `activities` —
 * which OpenMAIC turns into the live lesson and `scripts/check-classrooms.py` lints. OnTrak
 * already holds the facts that document is made of: the course, its audience, its hours, and
 * every module's objectives, activity and assessment, plus the tenancy and the employer
 * paying for the seats. So `classroomSpec` emits the same shape from those facts and the
 * tenant page offers it as a file, which is the whole integration for a provider whose only
 * task is "build the classroom for this funded class".
 *
 *   Two fields of that document OnTrak deliberately does **not** write: `chapter` and
 *   `linked_units`. They point at Open edX `url_name`s inside an OLX package, and a course
 *   authored here is not one yet — AthenIQ's own linter requires them, alongside a
 *   `source_course` that resolves to a package in its tree. Inventing either would produce a
 *   document that passes a reader's eye and fails `make check-classrooms`, so the generated
 *   spec covers what this app knows and AthenIQ adds the OLX pointers when the course is
 *   imported there. `docs/ai-classrooms.md` says so in the same words.
 *
 * Pure — no fetch, no database, no clock — so every state is cheap to assert and the pages
 * are only presentation. `tests/classroom.test.ts` covers the readings, the storage rules and
 * the generated document.
 */

import { httpLink, httpLinkRefusal } from "./link-rules";
import type { RuleProblem } from "./program-rules";

/* -------------------------------------------------------------------------- */
/*  The host                                                                   */
/* -------------------------------------------------------------------------- */

/** The switch. Unset or false means no classroom is offered. */
export const CLASSROOM_ENABLED_ENV = "ONTRAK_CLASSROOM_ENABLED";
/**
 * The classroom host's base address, e.g. `https://classroom.ontrak.innotel.us` — AthenIQ's
 * OpenMAIC surface, which that repository calls `CLASSROOM_HOST`.
 */
export const CLASSROOM_URL_ENV = "ONTRAK_CLASSROOM_URL";
/**
 * Where a person lands on the classroom host: OpenMAIC's own home, which is where a
 * classroom is generated from a topic or an uploaded document.
 */
export const CLASSROOM_HOME_PATH = "/home";

export interface ClassroomConfig {
  /** Whether a classroom affordance may be drawn at all. */
  enabled: boolean;
  /** The classroom host's origin, or `null` when it is off or misconfigured. */
  url: string | null;
  /** Why a configured value was refused, or why an enabled classroom has nowhere to go. */
  issues: string[];
}

/**
 * One variable, unquoted.
 *
 * `.env` has three readers that disagree about quotes — compose unquotes, `docker run
 * --env-file` does not, and a shell that sources the file does — so a value is stripped once
 * here, the same convention the rest of the app uses.
 */
function read(env: Record<string, string | undefined>, name: string): string {
  const raw = (env[name] ?? "").trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).trim();
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).trim();
  return raw;
}

/** The truthy spellings the family's other switches accept. */
const TRUTHY = ["1", "true", "yes", "on"];

export function classroomConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClassroomConfig {
  if (!TRUTHY.includes(read(env, CLASSROOM_ENABLED_ENV).toLowerCase())) {
    return { enabled: false, url: null, issues: [] };
  }

  const raw = read(env, CLASSROOM_URL_ENV);
  if (!raw) {
    return {
      enabled: true,
      url: null,
      issues: [`${CLASSROOM_URL_ENV} is not set, so there is no classroom host to open.`],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { enabled: true, url: null, issues: [`${raw} is not an absolute URL.`] };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { enabled: true, url: null, issues: [`${raw} is not an http(s) URL.`] };
  }

  // The origin rather than the raw value: a base URL carrying a path or a trailing slash
  // would otherwise double a segment when the host's own path is appended.
  return { enabled: true, url: parsed.origin, issues: [] };
}

/**
 * Which door a class is offered, and what is behind it.
 *
 * `misconfigured` is the state worth having: an operator who set a switch and an address that
 * was then refused has something to fix, and is told so instead of being drawn a dead link.
 * It is the same distinction the lab's door and the control room's integration cards make,
 * because it is the same kind of mistake.
 */
export type ClassroomDoor =
  | { kind: "off" }
  | { kind: "external"; url: string }
  | { kind: "misconfigured"; issues: string[] };

/**
 * The door, from the two facts.
 *
 * A refusal is reported ahead of everything else: an address that was *stated and refused* is
 * a stale variable, and a deployment that silently ignored it would leave an operator
 * believing their classroom is where they typed it.
 */
export function classroomDoor(
  config: ClassroomConfig,
  env: Record<string, string | undefined> = process.env,
): ClassroomDoor {
  const stated = read(env, CLASSROOM_URL_ENV) !== "";
  const refused = config.enabled && config.url === null && stated;

  if (refused) return { kind: "misconfigured", issues: config.issues };
  if (config.url) return { kind: "external", url: `${config.url}${CLASSROOM_HOME_PATH}` };
  if (config.enabled) return { kind: "misconfigured", issues: config.issues };
  return { kind: "off" };
}

/** The door, read straight from the environment. One call, so no caller can half-read it. */
export function classroomDoorFromEnv(
  env: Record<string, string | undefined> = process.env,
): ClassroomDoor {
  return classroomDoor(classroomConfigFromEnv(env), env);
}

/**
 * Where a provider goes to build a classroom, or `null` when this deployment has none.
 *
 * The home rather than a generation URL, because generation is OpenMAIC's own flow — a topic
 * or an uploaded document, its own model settings, its own progress — and a GET this app
 * invented would either 404 or start something the host never agreed to. The provider
 * arrives, submits the generated spec, and copies the resulting classroom's address back into
 * the course or the class.
 */
export function classroomHomeUrl(config: ClassroomConfig): string | null {
  return config.enabled && config.url ? `${config.url}${CLASSROOM_HOME_PATH}` : null;
}

/* -------------------------------------------------------------------------- */
/*  A stored address                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A classroom address that is safe to render, or `null` when it is not one.
 *
 * Four refusals, each for its own reason:
 *
 *   - **Not a URL at all** (a bare host, a path, whitespace): there is nothing to link to.
 *   - **Not http(s)** (`javascript:`, `data:`, `ftp:`): `javascript:` in an `href` runs script
 *     as the person who clicked, and a `data:` URL can render a look-alike page that belongs
 *     to nobody. Both are refusals rather than warnings.
 *   - **Credentials in the URL** (`https://user:pass@host/…`): a secret in a field every class
 *     member reads, that the roster export prints and the audit log keeps, is not a secret.
 *   - **Anything else** the URL parser rejects.
 *
 * The parsed `href` is returned, so what is stored and what is linked are the same string.
 *
 * The rule itself lives in `link-rules.ts`, because the funder's survey addresses (§4.5) have
 * the same four ways of being wrong and one implementation of a security check is the right
 * number of them; this is the classroom's name for it.
 */
export function classroomLink(raw: string | null | undefined): string | null {
  return httpLink(raw);
}

/** Why `classroomLink` refused a value, in words that name what to change. */
export function classroomLinkRefusal(raw: string | null | undefined): string {
  return httpLinkRefusal(raw, "classroom");
}

/** Where a classroom came from, once the course's and the class's own are both considered. */
export interface EffectiveClassroom {
  /** The address to draw a door for, or `null` when there is none. */
  url: string | null;
  /** Which row supplied it: the class's own override, or the course's. */
  source: "class" | "course" | null;
  /** Sentences explaining a stored value that was refused. Empty when both were usable. */
  refused: string[];
}

/**
 * The classroom a class is actually offered: its own if it has one, otherwise its course's.
 *
 * The fallback is deliberate, and it is the opposite of the "stated and refused is not
 * silently replaced" rule above, because the two rows are not the same kind of fact. An
 * environment variable is the *only* place a deployment says where its classroom host is, so
 * replacing a refused one would hide a deployment error. A class's override is one row among
 * many, and its course's classroom is a perfectly good answer — so a mistyped override is
 * reported *and* the class keeps working.
 */
export function effectiveClassroom(
  course: { classroomUrl?: string | null },
  cohort?: { classroomUrl?: string | null } | null,
): EffectiveClassroom {
  const refused: string[] = [];

  const classUrl = classroomLink(cohort?.classroomUrl);
  if (cohort?.classroomUrl && classUrl === null) {
    refused.push(
      `The class's classroom address was refused: ${classroomLinkRefusal(cohort.classroomUrl)}`,
    );
  }
  if (classUrl) return { url: classUrl, source: "class", refused };

  const courseUrl = classroomLink(course.classroomUrl);
  if (course.classroomUrl && courseUrl === null) {
    refused.push(
      `The course's classroom address was refused: ${classroomLinkRefusal(course.classroomUrl)}`,
    );
  }
  return { url: courseUrl, source: courseUrl ? "course" : null, refused };
}

/** A course and a class, as much of each as the classroom rules need. */
export interface ClassroomSubject {
  course: { title: string; classroomUrl?: string | null; moduleCount: number };
  cohort?: { name: string; classroomUrl?: string | null } | null;
}

/**
 * Everything standing between a class and its AI classroom. Empty means it has one.
 *
 * This is the list a page prints beside the door, so each message names the thing to go and
 * change: the deployment's two variables, the course's authored modules, or the empty field.
 * Nothing here is a permission — who may attach a classroom is `lib/tenancy.ts`'s answer, and
 * the action asks that separately.
 */
export function classroomProblems(
  subject: ClassroomSubject,
  config: ClassroomConfig,
): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const name = subject.cohort?.name ?? subject.course.title;

  if (!config.enabled) {
    problems.push({
      field: "classroom",
      message:
        `This deployment has no AI classroom host. Set ${CLASSROOM_ENABLED_ENV} and ` +
        `${CLASSROOM_URL_ENV} to point at AthenIQ's classroom host (see docs/ai-classrooms.md).`,
    });
  }

  if (subject.course.moduleCount === 0) {
    problems.push({
      field: "modules",
      message: `“${subject.course.title}” has no modules yet, and a classroom is generated from them — author the course first.`,
    });
  }

  const effective = effectiveClassroom(subject.course, subject.cohort);
  for (const refusal of effective.refused) problems.push({ field: "classroomUrl", message: refusal });

  if (effective.url === null) {
    problems.push({
      field: "classroomUrl",
      message: config.enabled
        ? `“${name}” has no AI classroom attached yet. Build one from the generated spec, then paste its address here.`
        : `“${name}” has no AI classroom attached, and there is nowhere to host one.`,
    });
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/*  The specification                                                          */
/* -------------------------------------------------------------------------- */

/** The spec document's version — AthenIQ's own field, and its linter requires one. */
export const CLASSROOM_SPEC_VERSION = 1;
/** Who generates the classroom. Matches AthenIQ's `provider` field. */
export const CLASSROOM_SPEC_PROVIDER = "openmaic";
/**
 * The model exit every classroom request is routed through: the platform's single OmniRoute
 * gateway. Emitted because AthenIQ's linter warns when a spec declares anything else, and
 * because a provider handing this document over should not have to be told.
 */
export const CLASSROOM_SPEC_GATEWAY = "OmniRoute";

/**
 * The activity kinds the estate's specs use — AthenIQ's `KNOWN_ACTIVITY_TYPES`, mirrored.
 * Only three are generated (below); the rest are here so a reader can see that the three are
 * a choice rather than the whole vocabulary, and so a test can pin the list.
 */
export const CLASSROOM_ACTIVITY_TYPES = [
  "slides",
  "roleplay",
  "quiz",
  "simulation",
  "lab",
  "video",
  "reading",
  "poll",
  "discussion",
  "exercise",
] as const;

/**
 * The three a module becomes, and why exactly these.
 *
 * OnTrak's course model has three facts about a module, and each maps to one scene:
 *
 *   - the module itself is taught — `slides`;
 *   - the module's `activity` is what the learner does with the tools they already have, and
 *     an interactive scene is what that has to be — `simulation`;
 *   - the module's `outcome` is how it is assessed, which is the check at the end — `quiz`.
 *
 * Nothing is invented for a module that authored less: a module with no activity gets slides
 * and nothing else, and the gap is visible in the spec rather than papered over with a
 * plausible-looking scene nobody wrote.
 */
export const GENERATED_ACTIVITY_TYPES = ["slides", "simulation", "quiz"] as const;

export interface ClassroomSpecEntry {
  /** A lowercase slug, unique in the document — the shape AthenIQ's linter requires. */
  id: string;
  title: string;
  prompt: string;
  objectives: string[];
  activities: Array<{ type: string; title: string }>;
}

/** The generated classroom specification, field for field as AthenIQ's documents carry it. */
export interface ClassroomSpec {
  version: number;
  provider: string;
  gateway: string;
  /** `course-v1:<org>+<course>+<run>` — the key AthenIQ would import the course under. */
  source_course: string;
  locale: string;
  defaults: {
    teacher_persona: string;
    classmates: string[];
    interaction: string;
    assessment: string;
  };
  classrooms: ClassroomSpecEntry[];
}

/** Lowercase, hyphen-separated, no runs or edges — the slug rule the spec's ids obey. */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The course code half of a key: an explicit one if the provider gave it, otherwise the
 * initials of the title's significant words.
 *
 * Initials rather than the whole slug because this is the identifier a person reads on a
 * certificate and types into a gradebook — `AAFR` is a code, `applied-ai-for-the-frontline-
 * role` is a sentence. A provider who already has a code sets it; this is only what a course
 * that has never been imported anywhere gets.
 */
export function courseCodeFor(title: string, explicit?: string | null): string {
  const given = (explicit ?? "").trim();
  if (given !== "") return given.replace(/[^A-Za-z0-9_-]+/g, "");
  const stop = new Set(["a", "an", "and", "for", "of", "the", "to", "in", "on", "at", "with"]);
  const initials = title
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "" && !stop.has(word.toLowerCase()))
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return initials.slice(0, 6) || "COURSE";
}

/** `2027_T1` — the run half, from the date the training starts. */
export function courseRun(startsOn: Date | string): string {
  const date = typeof startsOn === "string" ? new Date(`${startsOn.slice(0, 10)}T00:00:00.000Z`) : startsOn;
  if (Number.isNaN(date.getTime())) return "unscheduled";
  return `${date.getUTCFullYear()}_T${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

/**
 * The course key the classroom is generated for.
 *
 * `course-v1:<org>+<course>+<run>`, with the org read from the tenancy's own slug so the two
 * cannot disagree about who runs the course, and the run from the date the class starts — a
 * second sitting is a second run, which is what makes the two classrooms distinguishable
 * after both exist.
 */
export function courseKeyFor(input: {
  organizationSlug: string;
  courseTitle: string;
  startsOn: Date | string;
  courseCode?: string | null;
}): string {
  const words = slug(input.organizationSlug).split("-").filter((word) => word !== "");
  const org = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("") || "Provider";
  return `course-v1:${org}+${courseCodeFor(input.courseTitle, input.courseCode)}+${courseRun(input.startsOn)}`;
}

/** One objective per line, as a list — the same reading the tenant page does. */
function objectiveLines(objectives: string): string[] {
  return objectives
    .split("\n")
    .map((line) => line.trim().replace(/^[-•*]\s*/, "").trim())
    .filter((line) => line !== "");
}

export interface ClassroomSpecInput {
  /** The tenancy's slug; its words become the key's org. */
  organizationSlug: string;
  /** The tenancy's display name, for the default teacher's persona. */
  providerName?: string | null;
  /** The employer whose people are in the class, when the seats are sponsored. */
  sponsorName?: string | null;
  /** The provider's own course code, when it has one. */
  courseCode?: string | null;
  /** The date the training starts; the key's run comes from it. */
  startsOn: Date | string;
  locale?: string;
  course: {
    title: string;
    summary?: string | null;
    audience?: string | null;
    prerequisites?: string | null;
    instructionalHours?: number | null;
    deliveryMode?: string | null;
  };
  modules: Array<{
    position: number;
    title: string;
    hours?: number | null;
    /** One objective per line. */
    objectives: string;
    activity?: string | null;
    outcome?: string | null;
  }>;
}

/** Who the classroom is for, in words a teacher persona can use. */
function audienceOf(input: ClassroomSpecInput): string {
  return input.course.audience?.trim() || "working adults in this funded training program";
}

/** The prompt for one module: what to teach, what they do, and how it is checked. */
function modulePrompt(
  module: ClassroomSpecInput["modules"][number],
  courseTitle: string,
  audience: string,
): string {
  const parts: string[] = [
    `Run a classroom module titled “${module.title}” from the course “${courseTitle}” for ${audience}.`,
  ];
  const objectives = objectiveLines(module.objectives);
  if (objectives.length > 0) {
    parts.push(`By the end the learners should be able to: ${objectives.join("; ")}.`);
  }
  if (module.activity) {
    parts.push(
      `They do this themselves, with the tools they already use at work: ${module.activity}.`,
    );
  }
  if (module.outcome) parts.push(`Check it the way the course assesses it: ${module.outcome}.`);
  parts.push(
    "Keep every example on the learner's own tasks rather than toy ones, and say plainly what must never be pasted into a public model.",
  );
  return parts.join(" ");
}

/** The activities a module becomes — see `GENERATED_ACTIVITY_TYPES` for why these three. */
function moduleActivities(module: ClassroomSpecInput["modules"][number]) {
  const activities: Array<{ type: string; title: string }> = [
    { type: "slides", title: module.title },
  ];
  if (module.activity) activities.push({ type: "simulation", title: module.activity });
  if (module.outcome) activities.push({ type: "quiz", title: module.outcome });
  return activities;
}

/**
 * The classroom specification, from the course the tenancy already authored.
 *
 * AthenIQ's generative classrooms are specified rather than committed, and its
 * `openmaic/README.md` is explicit about what happens next: *"For each entry in
 * classrooms.json, submit prompt, objectives, and the defaults agent roles to OpenMAIC as the
 * lesson brief."* This produces that document, so the two facts a provider would otherwise
 * transcribe by hand — the objectives and the assessment — come from the course that the
 * funder's report is written from, and cannot drift from it.
 */
export function classroomSpec(input: ClassroomSpecInput): ClassroomSpec {
  const audience = audienceOf(input);
  const provider = input.providerName?.trim();
  const sponsor = input.sponsorName?.trim();
  const courseSlug = slug(input.course.title) || "course";

  const classmates = [
    "A learner in their first week who has never used an AI assistant for work.",
    "An experienced colleague who is sceptical and asks whether the output can be trusted.",
  ];
  if (sponsor) {
    classmates.push(`A supervisor at ${sponsor}, who has to sign off on what leaves the team.`);
  }

  return {
    version: CLASSROOM_SPEC_VERSION,
    provider: CLASSROOM_SPEC_PROVIDER,
    gateway: CLASSROOM_SPEC_GATEWAY,
    source_course: courseKeyFor({
      organizationSlug: input.organizationSlug,
      courseTitle: input.course.title,
      startsOn: input.startsOn,
      courseCode: input.courseCode,
    }),
    locale: input.locale ?? "en",
    defaults: {
      teacher_persona:
        `An instructor${provider ? ` at ${provider}` : ""} who teaches applied AI to ` +
        `${audience} in plain language, always shows the reasoning behind a step, and never ` +
        "gestures at what the model is doing without demonstrating it.",
      classmates,
      interaction:
        "Socratic: the teacher asks before telling, and the classmates voice the misconceptions a real learner would have.",
      assessment:
        "Each classroom ends with one check per objective, aligned to the module's own assessment.",
    },
    classrooms: input.modules.map((module) => ({
      id: `${courseSlug}-mod${String(module.position).padStart(2, "0")}-${slug(module.title) || "module"}`,
      title: module.title,
      prompt: modulePrompt(module, input.course.title, audience),
      objectives: objectiveLines(module.objectives),
      activities: moduleActivities(module),
    })),
  };
}

/** The spec as the file a provider hands to AthenIQ or to the classroom host. */
export function classroomSpecJson(input: ClassroomSpecInput): string {
  return `${JSON.stringify(classroomSpec(input), null, 2)}\n`;
}

/** `applied-ai-for-the-frontline-role-classrooms.json`. */
export function classroomSpecFilename(courseTitle: string): string {
  return `${slug(courseTitle) || "course"}-classrooms.json`;
}
