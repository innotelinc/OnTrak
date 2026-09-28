/**
 * OnTrak IT Support Training — simulation type definitions
 * -------------------------------------------
 * Everything under `src/lib/sim` is deliberately dependency-free, pure
 * TypeScript so the exact same engine runs in three places:
 *
 *   1. in the student's browser (the live, interactive console),
 *   2. on the server (deterministic grading of a submitted attempt),
 *   3. inside tests and the scenario validator.
 *
 * That property is what lets a heavy container-backed driver be swapped in
 * later behind the same `ShellDriver` interface without touching the UI or the
 * grader.
 */

export type Platform = "LINUX" | "WINDOWS" | "OFFICE";
export type EngineId = "bash" | "powershell" | "office";

/**
 * How the machine is presented to the student.
 *
 * `console` is the text shell every platform understands. `desktop` adds a
 * clickable Windows 11 desktop (Start menu, windows, taskbar) that drives the
 * very same machine state, with the console available on the next tab.
 */
export type ScenarioSurface = "console" | "desktop";

/* -------------------------------------------------------------------------- */
/*  Virtual filesystem                                                        */
/* -------------------------------------------------------------------------- */

export type NodeType = "dir" | "file" | "link";

export interface VfsEntry {
  /** Canonical path, e.g. `/home/student/notes.txt` or `/c:/users/student`. */
  path: string;
  type: NodeType;
  /** File contents. Only meaningful when `type === "file"`. */
  content?: string;
  /** Link target. Only meaningful when `type === "link"`. */
  target?: string;
  /** POSIX-style permission bits, e.g. 0o644 === 420. */
  mode: number;
  owner: string;
  group: string;
  mtime: number;
  size: number;
}

/** Flat, serializable map of canonical path key -> entry. */
export type Vfs = Record<string, VfsEntry>;

/* -------------------------------------------------------------------------- */
/*  Machine state                                                             */
/* -------------------------------------------------------------------------- */

export interface LocalUser {
  name: string;
  uid: number;
  gid: number;
  groups: string[];
  shell: string;
  home: string;
  fullName?: string;
  description?: string;
  /** `null` when a password has been set (we never store plaintext). */
  passwordHash: string | null;
  locked: boolean;
  enabled?: boolean;
}

export interface ServiceState {
  name: string;
  displayName?: string;
  description?: string;
  active: boolean;
  enabled: boolean;
  /** Windows-flavoured wording: Automatic | Manual | Disabled. */
  startupType?: "Automatic" | "Manual" | "Disabled";
  unitFile?: string;
}

export interface ProcessState {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

export interface PackageState {
  name: string;
  version: string;
  installed: boolean;
  description?: string;
  repo?: string;
}

export interface CronEntry {
  user: string;
  schedule: string;
  command: string;
}

export interface FirewallRule {
  name: string;
  direction: "in" | "out";
  action: "allow" | "deny";
  protocol: "tcp" | "udp" | "icmp" | "any";
  port?: string;
  remote?: string;
  enabled: boolean;
}

export interface RegistryValue {
  /** Full hive path, e.g. `HKLM\\SOFTWARE\\Policies\\Contoso`. */
  path: string;
  name: string;
  type: "String" | "DWord" | "QWord" | "ExpandString" | "MultiString";
  value: string | number | string[];
}

export interface ShareState {
  name: string;
  path: string;
  description?: string;
  access?: string;
}

export interface EventLogEntry {
  at: number;
  source: string;
  level: "info" | "warning" | "error";
  id: number;
  message: string;
}

export interface HistoryEntry {
  index: number;
  input: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  at: number;
}

export interface MachineState {
  cwd: string;
  env: Record<string, string>;
  users: LocalUser[];
  services: ServiceState[];
  processes: ProcessState[];
  packages: PackageState[];
  cron: CronEntry[];
  firewall: FirewallRule[];
  registry: RegistryValue[];
  shares: ShareState[];
  events: EventLogEntry[];
  history: HistoryEntry[];
  exitCode: number;
  hostname: string;
  os: {
    name: string;
    version: string;
    kernel?: string;
    build?: string;
    arch: string;
  };
  notes: string[];
  /** Transient notices the UI surfaces as toasts (cleared after each render). */
  notices: string[];
}

/* -------------------------------------------------------------------------- */
/*  Office documents                                                          */
/* -------------------------------------------------------------------------- */

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  format?: "text" | "number" | "currency" | "percent" | "date";
}

export interface Cell {
  /** Raw literal value, always stored as a string. */
  v?: string;
  /** Formula without the leading `=`, e.g. `SUM(B2:B10)`. */
  f?: string;
  style?: CellStyle;
}

export interface Sheet {
  name: string;
  cells: Record<string, Cell>;
}

export interface SpreadsheetDoc {
  type: "spreadsheet";
  name: string;
  location: string;
  sheets: Sheet[];
  activeSheet: number;
}

export type DocBlock =
  | { kind: "heading"; text: string; level: number; style?: CellStyle }
  | { kind: "paragraph"; text: string; style?: CellStyle }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "table"; rows: string[][]; header?: boolean };

export interface DocumentDoc {
  type: "document";
  name: string;
  location: string;
  blocks: DocBlock[];
  /** Paragraph the cursor currently sits on, for in-place edits. */
  cursor: number;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  at: number;
  read: boolean;
  flagged: boolean;
  folder: "inbox" | "sent" | "drafts" | "archive";
  attachments?: string[];
}

export interface MailDoc {
  type: "mail";
  name: string;
  location: string;
  messages: MailMessage[];
}

export interface SlideDoc {
  type: "slides";
  name: string;
  location: string;
  slides: { title: string; bullets: string[] }[];
}

export type OfficeDoc = SpreadsheetDoc | DocumentDoc | MailDoc | SlideDoc;

export interface OfficeState {
  docs: Record<string, OfficeDoc>;
  activeDoc?: string;
  user: { name: string; email: string };
}

/* -------------------------------------------------------------------------- */
/*  Full engine state                                                         */
/* -------------------------------------------------------------------------- */

export interface EngineState {
  vfs: Vfs;
  machine: MachineState;
  office: OfficeState;
  /** Scenario bookkeeping that survives a save/restore round trip. */
  meta: {
    hintsUsed: string[];
    revision: number;
  };
}

/* -------------------------------------------------------------------------- */
/*  Scenario definitions                                                      */
/* -------------------------------------------------------------------------- */

export interface SeedNode {
  /** Path, written the way the platform presents it (`C:\Users\student\x.txt`). */
  path: string;
  type?: NodeType;
  content?: string;
  target?: string;
  /** Octal string such as "644" or "0755". */
  mode?: string;
  owner?: string;
  group?: string;
}

export interface ScenarioCheckBase {
  id: string;
  label: string;
  /** Points awarded when the check passes. Defaults to 1. */
  points?: number;
  /** Shown in the report when the check fails. */
  successDetail?: string;
  failureDetail?: string;
  /** Optional per-check nudge revealed only after the student spends a hint. */
  hint?: string;
}

export type ScenarioCheck =
  | (ScenarioCheckBase & { kind: "file_exists"; path: string })
  | (ScenarioCheckBase & { kind: "file_absent"; path: string })
  | (ScenarioCheckBase & {
      kind: "file_contains";
      path: string;
      pattern: string;
      flags?: string;
      /** Fail unless the file exists (default true). */
      mustExist?: boolean;
    })
  | (ScenarioCheckBase & {
      kind: "file_not_contains";
      path: string;
      pattern: string;
      flags?: string;
      /** Fail unless the file exists (default true). */
      mustExist?: boolean;
    })
  | (ScenarioCheckBase & { kind: "file_mode"; path: string; mode: string })
  | (ScenarioCheckBase & { kind: "file_owner"; path: string; owner?: string; group?: string })
  | (ScenarioCheckBase & { kind: "dir_exists"; path: string })
  | (ScenarioCheckBase & {
      kind: "command_matched";
      /** Regular expression tested against the student's command history. */
      pattern: string;
      flags?: string;
      /** How many matching invocations are required. Defaults to 1. */
      minMatches?: number;
    })
  | (ScenarioCheckBase & {
      kind: "command_sequence";
      /** Patterns that must all match, in this relative order. */
      patterns: string[];
      flags?: string;
    })
  | (ScenarioCheckBase & {
      kind: "service_state";
      name: string;
      active?: boolean;
      enabled?: boolean;
    })
  | (ScenarioCheckBase & {
      kind: "package_state";
      name: string;
      installed?: boolean;
    })
  | (ScenarioCheckBase & { kind: "user_exists"; name: string; exists?: boolean })
  | (ScenarioCheckBase & { kind: "user_in_group"; name: string; group: string })
  | (ScenarioCheckBase & { kind: "user_detail"; name: string; field: "home" | "shell" | "fullName" | "description"; equals: string })
  | (ScenarioCheckBase & { kind: "cron_matches"; pattern: string; flags?: string })
  | (ScenarioCheckBase & { kind: "firewall_rule"; name: string; exists?: boolean; action?: "allow" | "deny"; port?: string })
  | (ScenarioCheckBase & { kind: "registry_value"; path: string; name: string; equals: string | number })
  | (ScenarioCheckBase & { kind: "share_exists"; name: string; exists?: boolean })
  | (ScenarioCheckBase & { kind: "hostname_equals"; value: string })
  | (ScenarioCheckBase & { kind: "note_matches"; pattern: string; flags?: string })
  // ---- Office -------------------------------------------------------------
  | (ScenarioCheckBase & {
      kind: "cell_equals";
      doc: string;
      sheet?: string;
      cell: string;
      equals: string | number;
      /** Allow +/- this much when comparing numbers. */
      tolerance?: number;
    })
  | (ScenarioCheckBase & {
      kind: "cell_formula_contains";
      doc: string;
      sheet?: string;
      cell: string;
      pattern: string;
      flags?: string;
    })
  | (ScenarioCheckBase & {
      kind: "cell_style";
      doc: string;
      sheet?: string;
      cell: string;
      bold?: boolean;
      italic?: boolean;
      format?: CellStyle["format"];
    })
  | (ScenarioCheckBase & { kind: "doc_contains"; doc: string; pattern: string; flags?: string })
  | (ScenarioCheckBase & { kind: "doc_heading"; doc: string; pattern: string; flags?: string; level?: number })
  | (ScenarioCheckBase & { kind: "sheet_exists"; doc: string; sheet: string })
  | (ScenarioCheckBase & {
      kind: "mail_sent";
      to: string;
      subjectPattern?: string;
      bodyPattern?: string;
      flags?: string;
    })
  | (ScenarioCheckBase & { kind: "mail_flagged"; subjectPattern: string; flagged: boolean; flags?: string });

export type CheckKind = ScenarioCheck["kind"];

export interface ScenarioHint {
  id: string;
  text: string;
  /** Points deducted from the final score when the hint is opened. */
  penalty?: number;
}

export interface ScenarioDefinition {
  version: 1;
  platform: Platform;
  engine: EngineId;
  /** Defaults to `console`. Only meaningful on the WINDOWS platform. */
  surface?: ScenarioSurface;
  /** One-line goal shown in the console header. */
  objective: string;
  /** Markdown briefing presented on the "Start attempt" screen. */
  brief: string;
  /** Ordered task list the student ticks off. */
  tasks: string[];
  machine: {
    hostname: string;
    user: string;
    os: string;
    version: string;
    kernel?: string;
    build?: string;
    arch?: string;
    domain?: string;
  };
  /** Files and directories that exist before the student touches anything. */
  files?: SeedNode[];
  /** Non-filesystem starting conditions. */
  state?: {
    users?: (Partial<LocalUser> & { name: string })[];
    services?: ServiceState[];
    processes?: ProcessState[];
    packages?: PackageState[];
    cron?: CronEntry[];
    firewall?: FirewallRule[];
    registry?: RegistryValue[];
    shares?: ShareState[];
    events?: EventLogEntry[];
  };
  /** Office documents that ship with the scenario. */
  docs?: OfficeDoc[];
  checks: ScenarioCheck[];
  hints?: ScenarioHint[];
  /** Allow hint spending at all. */
  allowHints?: boolean;
  /** Instructor-facing authoring notes; never sent to the student. */
  authorNotes?: string;
}

/* -------------------------------------------------------------------------- */
/*  Grading                                                                   */
/* -------------------------------------------------------------------------- */

export interface CheckEvaluation {
  checkId: string;
  label: string;
  kind: CheckKind;
  passed: boolean;
  points: number;
  maxPoints: number;
  detail: string;
}

export interface GradeReport {
  results: CheckEvaluation[];
  score: number;
  maxScore: number;
  percent: number;
  passed: boolean;
  penalty: number;
}

/* -------------------------------------------------------------------------- */
/*  Driver contract — the seam a container backend plugs into later           */
/* -------------------------------------------------------------------------- */

export interface CommandResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Ask the terminal to wipe its buffer (`clear` / `cls`). */
  clear?: boolean;
  /** Ask the UI to re-render the side panel (documents, services, ...). */
  refresh?: boolean;
  /** Present a file in the block editor instead of printing it. */
  openEditor?: string;
}

export interface ShellDriver {
  id: EngineId;
  platform: Platform;
  /** Prompt string echoed before each command. */
  prompt(state: EngineState): string;
  /** Runs a full command line (pipes, redirection, `&&` all handled here). */
  run(input: string, state: EngineState): CommandResult;
  /** Files created when the scenario boots. */
  boot?(state: EngineState): void;
  /** Human readable one-liner describing the environment. */
  banner(state: EngineState): string;
  /** Command names offered by Tab completion in the console. */
  completions?(): string[];
}
