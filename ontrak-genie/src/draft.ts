/**
 * Reading a tool call that is still arriving.
 *
 * A model that writes a file does it through a tool call, and the arguments of
 * that call stream in like any other text: `{"path":"notes.md","content":"# Hel`
 * is a real, half-arrived message. The agent loop only sees the finished
 * `tool_call` event, which arrives after the last character - too late to watch
 * anything being written.
 *
 * This module turns those fragments into something renderable, which is what the
 * UI's preview pane shows: the file as it is being generated. The arguments are
 * JSON, and a fragment of JSON does not parse, so the reader here is deliberately
 * partial: it walks the object and reports the string fields it has *so far*,
 * treating a missing closing quote as "still arriving" rather than as an error.
 *
 * Best effort by design. A preview that gives up on the first unusual byte would
 * be worse than no preview, so anything unrecognised is skipped rather than
 * thrown, and a body that never closes simply yields what was read.
 */

export interface DraftPreview {
  /** The tool being called, e.g. `write_file`. */
  name: string;
  /** Where it is being written, when the arguments name a path yet. */
  path: string | null;
  /** The file body (or replacement text) as far as it has arrived. */
  content: string;
  /** False before the body's opening quote: the path is known, the code is not. */
  started: boolean;
  /** True once the body's closing quote has arrived. */
  complete: boolean;
}

/** Tools whose arguments contain a file being written. */
const WRITERS = new Set(["write_file", "edit_file"]);

/** The field holding the new file body, per tool. */
const BODY_FIELDS = ["content", "new_string"] as const;

interface StringField {
  value: string;
  /** False when the fragment ended before the closing quote. */
  closed: boolean;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
  return cursor;
}

/**
 * Read a JSON string starting at its opening quote. Stops at the closing quote,
 * or at the end of the text when it has not arrived yet.
 */
function readString(text: string, start: number): { value: string; end: number; closed: boolean } {
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') return { value, end: index + 1, closed: true };
    if (char !== "\\") {
      value += char;
      continue;
    }

    const next = text[index + 1];
    if (next === undefined) break;
    if (next === "u") {
      // A truncated escape is just the tail of a string still arriving.
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    value += SIMPLE_ESCAPES[next] ?? next;
    index += 1;
  }
  return { value, end: text.length, closed: false };
}

/**
 * Step over one complete value - object, array, number, literal - so the scan can
 * carry on with the key after it. Returns -1 when the value is still arriving.
 */
function skipValue(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      const inner = readString(text, index);
      if (!inner.closed) return -1;
      index = inner.end - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      // At depth 0 this closes the object being scanned, not the value.
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
      continue;
    }
    if (char === "," && depth === 0) return index;
  }
  return -1;
}

/**
 * Every top-level string field of a JSON object that may still be arriving.
 *
 * Keys are matched by walking the object rather than by searching for the field
 * name, so a `content` inside another *value* - a path, an old string - cannot be
 * mistaken for the key being read.
 */
export function scanStringFields(text: string): Map<string, StringField> {
  const fields = new Map<string, StringField>();
  let cursor = text.indexOf("{");
  if (cursor === -1) return fields;
  cursor = skipWhitespace(text, cursor + 1);

  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === "}" || char === ",") {
      cursor = skipWhitespace(text, cursor + 1);
      continue;
    }
    if (char !== '"') {
      // Not a key. Rather than give up, step over whatever it is and keep going.
      cursor += 1;
      continue;
    }

    const key = readString(text, cursor);
    if (!key.closed) return fields;
    cursor = skipWhitespace(text, key.end);
    if (text[cursor] !== ":") return fields;
    cursor = skipWhitespace(text, cursor + 1);

    if (text[cursor] === '"') {
      const value = readString(text, cursor);
      fields.set(key.value, { value: value.value, closed: value.closed });
      if (!value.closed) return fields;
      cursor = value.end;
      continue;
    }

    const end = skipValue(text, cursor);
    if (end === -1) return fields;
    cursor = end;
  }

  return fields;
}

/**
 * The file a tool call is writing, as far as it has arrived.
 *
 * Returns null for anything that is not writing a file - a `read_file` or a
 * `run_command` produces no draft, and the UI leaves the last one on screen.
 */
export function draftPreview(name: string, args: string): DraftPreview | null {
  if (!WRITERS.has(name)) return null;

  const fields = scanStringFields(args);
  const path = fields.get("path")?.value.trim() ?? "";

  let body: StringField | undefined;
  for (const field of BODY_FIELDS) {
    body = fields.get(field);
    if (body !== undefined) break;
  }

  return {
    name,
    path: path === "" ? null : path,
    content: body?.value ?? "",
    started: body !== undefined,
    complete: body?.closed === true,
  };
}

/**
 * The file a *text-mode* tool call is writing, as it arrives.
 *
 * Smaller models - the local 7B this project falls back to, for one - print the
 * call as JSON prose rather than using the structured channel: no `tool_calls`
 * field, just `{"name": "write_file", "arguments": {...}}` in the text, arriving
 * token by token. The agent already recognises and executes those (see
 * `salvageToolCalls`); this recognises one while it is *still* being printed, so
 * the file can be shown as it is written rather than after.
 *
 * The arguments object is taken as everything from the first `{` after the tool's
 * name, which is where a JSON-written call puts them (the object's own opening
 * brace comes before the name).
 */
export function textDraftPreview(text: string, toolNames: Set<string>): DraftPreview | null {
  for (const name of WRITERS) {
    if (!toolNames.has(name)) continue;

    const named = text.indexOf(`"${name}"`);
    if (named === -1) continue;

    const open = text.indexOf("{", named + name.length + 2);
    if (open === -1) continue;
    return draftPreview(name, text.slice(open));
  }
  return null;
}
