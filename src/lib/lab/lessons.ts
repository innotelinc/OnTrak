/**
 * Lessons: the command walkthroughs a scenario can point a student at.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/lessons.py`. A lesson is a *teaching*
 * artefact, deliberately separate from a scenario, and keeping them apart is what
 * lets one lesson be referenced by several scenarios (permissions are needed by the
 * chmod fault, the ownership fault and the sudo fault) without the teaching text
 * being copied or drifting:
 *
 *     a scenario   a broken machine and a grade — the student is expected to work
 *                  out what to do, or already knows
 *     a lesson     the same subject taught: the commands, what each does, a worked
 *                  example, and exercises with the answer hidden behind a click
 *
 * That separation is why a lesson carries `prerequisites` (teach this before that)
 * and `exercises` with a `verify` snippet the student runs *in the lab machine*: the
 * lesson teaches self-verification rather than "ask the instructor".
 *
 * Four decisions the port makes, each stated because a reader will meet them:
 *
 * **The data is JSON, and this module reads no files.** The lab authored lessons as
 * YAML under `lessons/`; this repository has no YAML parser (plan §3/C6), so the
 * lab's `lessons/*.yaml` were converted field for field with PyYAML into
 * `src/lib/lab/data/lessons.json` and the module takes the records a caller has
 * already parsed. `parseLessonRecord` turns one file's *text* into a record, so a
 * malformed file still fails naming the file rather than the caller.
 *
 * **`fileName` replaces the Python's `Path`.** A lesson's id has to agree with the
 * name it is filed under, or `ontrak lesson show <id>` cannot find it — and the port
 * keeps that rule, and its wording, to stay consistent with `scenarios.ts`, which
 * holds the same rule for a scenario's file.
 *
 * **A duplicate lesson id is refused, and two files are named.** Python's dict
 * assignment kept whichever file was read last, which in a flat layout whose ids live
 * inside the files is silent data loss. `scenarios.ts` refuses the same thing the same
 * way; the two ports agree on purpose.
 *
 * **A bad number fails at load rather than becoming a default.** Python called
 * `int(...)` and let a `ValueError` escape; a `difficulty: "three"` that quietly
 * became `1` would then pass the very range check meant to catch it, so the port
 * refuses it by field name instead.
 *
 * Pure: no database, no filesystem, no I/O.
 */

import { LINUX, PLATFORMS } from "./scenarios";

/** The suffixes a lesson file may carry. */
export const LESSON_SUFFIXES = [".yaml", ".yml"] as const;

/**
 * A command id and an exercise id both become anchors in the page and keys in URLs,
 * so they are slugs rather than free text. Same pattern `scenarios.ts` uses for a
 * lesson reference.
 */
const LESSON_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Raised when a lesson is missing or malformed. */
export class LessonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonError";
  }
}

/** One lesson's fields, as they arrive from the parsed JSON bundle. */
export type LessonSource = Record<string, unknown>;

/**
 * Every lesson, keyed by the file it was authored in.
 *
 * The key is the file name (`linux-permissions.yaml`), not the id: the two are
 * required to agree, and keeping the file name is what makes it possible to say so
 * when they do not.
 */
export type LessonManifests = Readonly<Record<string, LessonSource>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Python's `str(data.get(key) or "").strip()`.
 *
 * A falsy value is the empty string — `0`, `false` and `None` all render as nothing
 * on the Python side, and a field that arrived as `0` should not become `"0"` here.
 */
function text(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return "";
  }
  return String(value).trim();
}

/**
 * A list of strings, read leniently.
 *
 * Python's `[str(x) for x in (data.get(key) or [])]` would iterate a bare string
 * character by character, turning `tags: linux` into `["l","i","n","u","x"]`. That is
 * a Python accident rather than a feature, so a value that is not a list is treated as
 * absent — the narrowing the scoring port documents for the same class of case.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}

/** Only the entries that are records: Python's `if isinstance(entry, dict)`. */
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

/**
 * A whole number from a field, or a refusal naming the field.
 *
 * `where` is the file name, so an operator reading the error knows which lesson to
 * open. A value that is absent takes the Python default; one that is present and
 * unreadable is refused rather than defaulted (see the module header).
 */
function integerField(data: LessonSource, key: string, fallback: number, where: string): number {
  const value = data[key];
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw new LessonError(`${where}: ${key} must be a whole number`);
  return Math.trunc(parsed);
}

/** The name a lesson is filed under, without its suffix. */
function fileStem(fileName: string): string {
  return fileName.replace(/\.(yaml|yml)$/i, "");
}

/** One command worth knowing, with what it does and a worked example. */
export interface LessonCommand {
  command: string;
  what: string;
  example: string;
  /**
   * Filled in for the commands that can destroy a machine. Shown next to the command
   * in the CLI and the portal rather than buried in prose.
   */
  danger: string;
}

/** A narrative step: read this, then try that. */
export interface LessonStep {
  title: string;
  body: string;
  command: string;
}

/** A practice task with an answer and a way to check it. */
export interface LessonExercise {
  id: string;
  prompt: string;
  solution: string;
  /**
   * A snippet the student runs *in the lab machine* to see whether they got it right,
   * so the lesson teaches self-verification.
   */
  verify: string;
}

export interface Lesson {
  id: string;
  title: string;
  /** The lab's own spelling, lowercased. `PLATFORMS` is the vocabulary. */
  platform: string;
  summary: string;
  category: string;
  difficulty: number;
  minutes: number;
  prerequisites: string[];
  objectives: string[];
  commands: LessonCommand[];
  steps: LessonStep[];
  exercises: LessonExercise[];
  tags: string[];
  docs: string[];
  /**
   * The file it was authored in. The Python carried a `Path` and used it for exactly
   * one rule — that the id and the file name agree — and that rule survives here.
   */
  fileName: string;
}

export function lessonCommandFromDict(data: Record<string, unknown>): LessonCommand {
  return {
    command: text(data.command),
    what: text(data.what),
    example: text(data.example),
    danger: text(data.danger),
  };
}

export function lessonCommandToDict(command: LessonCommand): Record<string, unknown> {
  return {
    command: command.command,
    what: command.what,
    example: command.example,
    danger: command.danger,
  };
}

export function lessonStepFromDict(data: Record<string, unknown>): LessonStep {
  return {
    title: text(data.title),
    body: text(data.body),
    command: text(data.command),
  };
}

export function lessonStepToDict(step: LessonStep): Record<string, unknown> {
  return { title: step.title, body: step.body, command: step.command };
}

export function lessonExerciseFromDict(data: Record<string, unknown>): LessonExercise {
  return {
    id: text(data.id),
    prompt: text(data.prompt),
    solution: text(data.solution),
    verify: text(data.verify),
  };
}

export function lessonExerciseToDict(exercise: LessonExercise): Record<string, unknown> {
  return {
    id: exercise.id,
    prompt: exercise.prompt,
    solution: exercise.solution,
    verify: exercise.verify,
  };
}

/** Whether this lesson is taught on Linux rather than Windows. */
export function lessonIsLinux(lesson: Lesson): boolean {
  return lesson.platform === LINUX;
}

/**
 * Every command in the lesson, in order, as a paste-able block.
 *
 * The commands section first, then the commands that appear inside the narrative steps
 * — which is the order a student meets them, and the order the Python produced.
 */
export function lessonAllShell(lesson: Lesson): string {
  const lines: string[] = [];
  for (const command of lesson.commands) if (command.command) lines.push(command.command);
  for (const step of lesson.steps) if (step.command) lines.push(step.command);
  return lines.join("\n");
}

/**
 * The lesson as the portal and the CLI show it.
 *
 * Named `publicView` rather than Python's `public()` because `public` is a TypeScript
 * modifier and cannot be a method name; `scenarios.ts` uses the same name for the same
 * job. The keys stay snake_case-free — they are the Python's own field names, which is
 * what a caller reading a lesson's JSON already expects.
 */
export function lessonPublicView(lesson: Lesson): Record<string, unknown> {
  return {
    id: lesson.id,
    title: lesson.title,
    platform: lesson.platform,
    summary: lesson.summary,
    category: lesson.category,
    difficulty: lesson.difficulty,
    minutes: lesson.minutes,
    prerequisites: [...lesson.prerequisites],
    objectives: [...lesson.objectives],
    commands: lesson.commands.map(lessonCommandToDict),
    steps: lesson.steps.map(lessonStepToDict),
    exercises: lesson.exercises.map(lessonExerciseToDict),
    tags: [...lesson.tags],
    docs: [...lesson.docs],
  };
}

/**
 * Parse one lesson file's text.
 *
 * The analogue of the Python's `yaml.safe_load`, with the file read lifted out — and
 * with YAML's two failures translated: `invalid YAML` becomes `invalid JSON`, and a
 * top level that is not a mapping is refused either way. Both name the file, because
 * the person reading the error is looking at a directory of them.
 */
export function parseLessonRecord(source: string, label: string): LessonSource {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LessonError(`${label}: invalid JSON: ${detail}`);
  }
  if (!isRecord(data)) throw new LessonError(`${label}: top level must be a mapping`);
  return data;
}

/**
 * Loads the lesson bundle.
 *
 * The Python walked `lessons/*.yaml` and treated a missing directory as "no lessons,
 * not an error", which matters because a deployment may legitimately ship none. In the
 * port the bundle *is* the directory, so an empty one is the same state and produces
 * the same empty result rather than a throw.
 *
 * `find` makes this repository usable as `scenarios.ts`'s `LessonFacts`, which is what
 * lets a scenario validator check that the lessons it names exist.
 */
export class LessonRepository {
  private cache: Map<string, Lesson> | null = null;

  constructor(private readonly manifests: LessonManifests) {}

  load(force = false): Map<string, Lesson> {
    if (this.cache === null || force) this.cache = this.discover();
    return this.cache;
  }

  /** Re-read the bundle. With in-memory manifests this re-derives from the same input. */
  reload(): Map<string, Lesson> {
    return this.load(true);
  }

  private discover(): Map<string, Lesson> {
    const found = new Map<string, Lesson>();
    const seen = new Map<string, string>();
    for (const fileName of Object.keys(this.manifests).sort()) {
      const lower = fileName.toLowerCase();
      if (!LESSON_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue;
      const source = this.manifests[fileName];
      if (!isRecord(source)) throw new LessonError(`${fileName}: top level must be a mapping`);
      const lesson = this.build(source, fileName);
      const previous = seen.get(lesson.id);
      if (previous !== undefined) {
        throw new LessonError(`${previous} and ${fileName} both claim the id ${JSON.stringify(lesson.id)}`);
      }
      seen.set(lesson.id, fileName);
      found.set(lesson.id, lesson);
    }
    return found;
  }

  private build(data: LessonSource, fileName: string): Lesson {
    const lessonId = text(data.id) || fileStem(fileName);
    return {
      id: lessonId,
      title: text(data.title) || lessonId,
      // No alias table here, exactly as in the Python: a platform is lowercased and
      // then checked against the vocabulary, so `ubuntu` is refused by name rather
      // than quietly read as Linux.
      platform: (text(data.platform) || LINUX).toLowerCase(),
      summary: text(data.summary),
      category: text(data.category),
      difficulty: integerField(data, "difficulty", 1, fileName),
      minutes: integerField(data, "minutes", 10, fileName),
      prerequisites: stringList(data.prerequisites),
      objectives: stringList(data.objectives),
      commands: records(data.commands).map(lessonCommandFromDict),
      steps: records(data.steps).map(lessonStepFromDict),
      exercises: records(data.exercises).map(lessonExerciseFromDict),
      tags: stringList(data.tags),
      docs: stringList(data.docs),
      fileName,
    };
  }

  /** One lesson, or a refusal naming what does exist. */
  get(lessonId: string): Lesson {
    const lessons = this.load();
    const lesson = lessons.get(lessonId);
    if (lesson === undefined) {
      const available = [...lessons.keys()].sort().join(", ") || "none";
      throw new LessonError(`unknown lesson ${JSON.stringify(lessonId)}; available: ${available}`);
    }
    return lesson;
  }

  /** One lesson or `null`. `scenarios.ts`'s `LessonFacts` seam is this method. */
  find(lessonId: string): Lesson | null {
    return this.load().get(lessonId) ?? null;
  }

  /** Every lesson, ordered by platform then id — the Python's sort, and the page's order. */
  list(): Lesson[] {
    return [...this.load().values()].sort((a, b) => {
      if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
  }

  ids(): string[] {
    return this.list().map((lesson) => lesson.id);
  }

  /**
   * Resolve a scenario's `lessons:` list, skipping ids that are missing.
   *
   * A missing id is reported by the scenario validator at build time; at request time a
   * stale id must not break a student's page, so it is dropped rather than thrown.
   */
  forScenario(lessonIds: readonly string[]): Lesson[] {
    const lessons = this.load();
    const resolved: Lesson[] = [];
    for (const lessonId of lessonIds) {
      const lesson = lessons.get(lessonId);
      if (lesson !== undefined) resolved.push(lesson);
    }
    return resolved;
  }

  byPlatform(): Map<string, Lesson[]> {
    const grouped = new Map<string, Lesson[]>();
    for (const lesson of this.list()) {
      const bucket = grouped.get(lesson.platform);
      if (bucket === undefined) grouped.set(lesson.platform, [lesson]);
      else bucket.push(lesson);
    }
    return grouped;
  }

  /**
   * Human-readable problems; empty means healthy.
   *
   * Mirrors the scenario validator on purpose: both refuse a lesson that teaches
   * nothing, a broken reference, and an id that disagrees with its file. A lesson with
   * no exercises is a read-through, and a scenario that links a lesson which does not
   * exist sends a student to a 404 mid-ticket — which is why the other side of that
   * link (`scenarios.ts`) checks its own half against `find`.
   */
  validate(): string[] {
    let lessons: Map<string, Lesson>;
    try {
      lessons = this.reload();
    } catch (error) {
      if (error instanceof LessonError) return [error.message];
      throw error;
    }

    const problems: string[] = [];
    for (const lesson of lessons.values()) {
      const prefix = `[lesson ${lesson.id}]`;
      if (!LESSON_ID.test(lesson.id)) problems.push(`${prefix} id must be lowercase and dash-separated`);
      if (fileStem(lesson.fileName) !== lesson.id) {
        problems.push(
          `${prefix} file is ${JSON.stringify(lesson.fileName)} but id is ` +
            `${JSON.stringify(lesson.id)}; the two must match so \`ontrak lesson show <id>\` finds it`,
        );
      }
      if (!PLATFORMS.some((platform) => platform === lesson.platform)) {
        problems.push(`${prefix} platform must be one of: ${PLATFORMS.join(", ")}`);
      }
      if (!lesson.summary) {
        problems.push(`${prefix} needs a summary (one sentence, shown in the list)`);
      }
      if (!(lesson.difficulty >= 1 && lesson.difficulty <= 4)) {
        problems.push(`${prefix} difficulty must be 1..4`);
      }
      if (lesson.minutes <= 0) problems.push(`${prefix} minutes must be positive`);
      if (lesson.commands.length === 0 && lesson.steps.length === 0) {
        problems.push(`${prefix} teaches nothing: add commands and/or steps`);
      }
      if (lesson.exercises.length === 0) {
        problems.push(`${prefix} has no exercises; a lesson students cannot practise is a read-through`);
      }

      const seenCommands = new Set<string>();
      for (const command of lesson.commands) {
        if (!command.command) problems.push(`${prefix} a commands entry has no 'command'`);
        if (!command.what) {
          problems.push(`${prefix} command ${JSON.stringify(command.command)} does not say what it does`);
        }
        const key = command.command.trim();
        if (seenCommands.has(key)) problems.push(`${prefix} duplicate command entry ${JSON.stringify(key)}`);
        seenCommands.add(key);
      }

      const seenExercises = new Set<string>();
      for (const exercise of lesson.exercises) {
        if (!LESSON_ID.test(exercise.id)) {
          problems.push(`${prefix} exercise id ${JSON.stringify(exercise.id)} must be lowercase and dash-separated`);
        }
        if (!exercise.prompt) problems.push(`${prefix} exercise ${JSON.stringify(exercise.id)} has no prompt`);
        if (!exercise.solution) {
          problems.push(
            `${prefix} exercise ${JSON.stringify(exercise.id)} has no solution; students check ` +
              "themselves against it",
          );
        }
        if (seenExercises.has(exercise.id)) {
          problems.push(`${prefix} duplicate exercise id ${JSON.stringify(exercise.id)}`);
        }
        seenExercises.add(exercise.id);
      }
    }

    // Prerequisites are checked after every lesson is known, so a forward reference is
    // valid and only a genuinely absent one is reported.
    for (const lesson of lessons.values()) {
      for (const prerequisite of lesson.prerequisites) {
        if (!lessons.has(prerequisite)) {
          problems.push(`[lesson ${lesson.id}] prerequisite ${JSON.stringify(prerequisite)} is not a lesson`);
        } else if (prerequisite === lesson.id) {
          problems.push(`[lesson ${lesson.id}] lists itself as a prerequisite`);
        }
      }
    }
    return problems;
  }
}
