/**
 * The slash commands, and the palette that suggests them.
 *
 * A line that starts with `/` is a command to the CLI; anything else is a task
 * for the agent. Keeping the two apart is what lets the CLI have controls at
 * all — `/model` must not be a sentence the model is asked to interpret.
 *
 * The definitions are data, so the same list draws `/help`, feeds the
 * autocomplete, and is what a test asserts against. Adding a command is adding
 * one row.
 */

export interface SlashCommand {
  /** The word after the slash. */
  name: string;
  /** Alternate spellings that resolve to the same command. */
  aliases?: string[];
  /** Argument hint shown in `/help`, e.g. `<name> [task]`. */
  args?: string;
  summary: string;
  /** Section in `/help`. */
  group: "session" | "model" | "gate" | "skills" | "account" | "cli";
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", aliases: ["?"], summary: "Show this list of commands.", group: "cli" },
  { name: "new", summary: "Start a new chat (the current one is kept).", group: "session" },
  { name: "sessions", aliases: ["ls"], summary: "List chats, most recently used first.", group: "session" },
  { name: "resume", args: "<id|number>", summary: "Switch to an existing chat and show its transcript.", group: "session" },
  { name: "rename", args: "<title>", summary: "Name the current chat.", group: "session" },
  { name: "archive", summary: "Put the current chat away without deleting it.", group: "session" },
  { name: "unarchive", summary: "Bring the current chat back.", group: "session" },
  { name: "delete", args: "[id|number]", summary: "Delete a chat and its transcript (asks first).", group: "session" },
  { name: "model", args: "[id]", summary: "Show or choose the model for this chat.", group: "model" },
  { name: "models", args: "[filter]", summary: "List the models the gateway advertises.", group: "model" },
  { name: "steps", args: "[n]", summary: "Show or set this chat's step budget.", group: "model" },
  { name: "offline", args: "[on|off]", summary: "Allow or refuse the offline gateway for this chat.", group: "model" },
  { name: "approve", aliases: ["a"], args: "[id]", summary: "Answer a waiting approval with approve.", group: "gate" },
  { name: "deny", aliases: ["d"], args: "[id]", summary: "Answer a waiting approval with deny.", group: "gate" },
  { name: "pending", aliases: ["gate"], summary: "List the approvals waiting right now.", group: "gate" },
  { name: "skills", summary: "List the skills available to this CLI.", group: "skills" },
  { name: "skill", args: "<name> [task]", summary: "Apply a skill to a task.", group: "skills" },
  { name: "usage", summary: "Show this account's usage and ceiling.", group: "account" },
  { name: "whoami", summary: "Show the server, the identity and the plan in force.", group: "account" },
  { name: "last", summary: "Show the message the agent was last asked.", group: "cli" },
  { name: "clear", summary: "Clear the screen.", group: "cli" },
  { name: "login", summary: "Sign in again (browser-assisted).", group: "cli" },
  { name: "logout", summary: "Forget the stored credential.", group: "cli" },
  { name: "quit", aliases: ["exit", "q"], summary: "Leave the CLI.", group: "cli" },
];

const GROUP_ORDER: SlashCommand["group"][] = ["session", "model", "gate", "skills", "account", "cli"];
const GROUP_TITLE: Record<SlashCommand["group"], string> = {
  session: "Chats",
  model: "Model",
  gate: "Approvals",
  skills: "Skills",
  account: "Account",
  cli: "CLI",
};

export function findCommand(name: string): SlashCommand | null {
  const wanted = name.toLowerCase();
  for (const command of COMMANDS) {
    if (command.name === wanted) return command;
    if (command.aliases?.includes(wanted)) return command;
  }
  return null;
}

export interface ParsedCommand {
  command: SlashCommand;
  /** Positional arguments, quotes already stripped. Always defined. */
  args: string[];
  /** The text after the command, verbatim — for `/rename my chat` and `/skill …`. */
  rest: string;
}

/**
 * Split a command line into a name and its arguments.
 *
 * Quoting is honoured for a single argument (`/rename "release prep"`) and for
 * the tail (`/skill review check the diff`), because a title and a task are
 * both things people type spaces in. Returns null when the line is not a
 * command at all, which is how the caller knows to treat it as a task.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const match = /^([A-Za-z?][A-Za-z0-9_-]*)?\s*([\s\S]*)$/.exec(body);
  if (!match) return null;
  const rawName = (match[1] ?? "").toLowerCase();
  const rest = match[2] ?? "";
  const command = rawName === "" ? null : findCommand(rawName);
  if (command === null) return null;
  return { command, args: tokenize(rest), rest: rest.trim() };
}

/** Whitespace splitting that respects double quotes. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * The commands the palette should offer for a partial line.
 *
 * Matches on the name and on an alias, prefix-only, so `/r` offers `resume`
 * and `rename` rather than every command containing an `r`.
 */
export function matchCommands(input: string): SlashCommand[] {
  const body = input.startsWith("/") ? input.slice(1) : input;
  if (body.includes(" ")) return [];
  const wanted = body.toLowerCase();
  return COMMANDS.filter(
    (command) =>
      command.name.startsWith(wanted) || (command.aliases ?? []).some((alias) => alias.startsWith(wanted)),
  );
}

/** `/help` as grouped lines. */
export function helpLines(): string[] {
  const lines: string[] = [];
  for (const group of GROUP_ORDER) {
    const rows = COMMANDS.filter((command) => command.group === group);
    if (rows.length === 0) continue;
    lines.push(`  ${GROUP_TITLE[group]}`);
    for (const command of rows) {
      const usage = `${command.name}${command.args ? ` ${command.args}` : ""}`;
      lines.push(`    /${usage.padEnd(24)} ${command.summary}`);
    }
  }
  return lines;
}
