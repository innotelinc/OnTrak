import crypto from "node:crypto";

/** Titles that are the page asking itself something, not the person talking. */
const AUXILIARY = new Set([
  "classifier",
  "prefill",
  "tastemaker",
  "refusal-detector",
  "accuracy-check",
  "vision",
  "pliny-coach",
  "pliny-improve",
  "liquid-refiner",
]);

/** The studio marks its cloud calls with this prefix (see `cloudChatRequest`). */
const TITLE_PREFIX = "GODMOD3.AI";

const MAX_QUERY = 8_000;

/**
 * Is this the person's own chat turn, rather than the page classifying, judging
 * or prefilling one? Only the former goes to the agent; the rest are short,
 * single-shot model calls where a tool loop would be wrong (and expensive).
 */
export function isAgentRequest(req) {
  const title = String(req.headers["x-title"] ?? "").trim();
  if (!title.startsWith(TITLE_PREFIX)) return false;
  const suffix = title.slice(TITLE_PREFIX.length).replace(/^-/, "");
  return !AUXILIARY.has(suffix);
}

function textOf(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter((part) => part !== "")
      .join("\n");
  }
  return "";
}

function decodeHeader(raw) {
  const header = String(raw ?? "").trim();
  if (header === "") return "";
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    // A base64 string that was not utf8 decodes to replacement characters; that
    // is a header we cannot read, not a query.
    return decoded.includes("\uFFFD") ? "" : decoded.trim();
  } catch {
    return "";
  }
}

/**
 * The text the person typed.
 *
 * The page sends its jailbreak template as the last user message and puts the
 * real query in a header (see the injected bridge in `studioDocument`). The
 * transcript is the authority, though: the page embeds the query in the
 * template, so a header that is not in the transcript is stale — a regenerated
 * turn, an edited message — and the transcript wins.
 */
export function queryOf(req, body, messages) {
  const last = [...messages].reverse().find((message) => message && message.role === "user");
  const transcript = textOf(last).trim();
  const header = decodeHeader(req.headers["x-genie-query"]);
  if (header !== "" && (transcript === "" || transcript.includes(header))) return header.slice(0, MAX_QUERY);
  return transcript.slice(0, MAX_QUERY);
}

export function conversationOf(req, actor, messages) {
  const header = String(req.headers["x-genie-conversation"] ?? "").trim();
  if (header !== "") return `id:${header.slice(0, 120)}`;
  const first = messages.find((message) => message && message.role === "user");
  // No conversation id (an older cached page): the opening line is the next best
  // identity. Two chats that open with the same words would share a session; that
  // is a rarer accident than losing the thread on every turn.
  return `open:${digest(actor, textOf(first).slice(0, 2_000))}`;
}

export function digest(...parts) {
  return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}
