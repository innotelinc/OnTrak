/** One line of a value, for a chat answer that is rendered as markdown. */
export function oneLine(value, limit) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * The argument worth showing beside a tool name.
 *
 * A tool call reads as a blockquote line in the answer; the first recognised
 * argument is enough to tell one `run_command` from another without printing a
 * whole JSON object at the person.
 */
export function describeArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["command", "path", "query", "pattern", "name", "url", "skill", "source"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return ` · \`${oneLine(value, 140).replace(/`/g, "'")}\``;
    }
  }
  return "";
}
