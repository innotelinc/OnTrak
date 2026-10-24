import { approveInGenie } from "./genie-client.js";
import { describeArgs, oneLine } from "./text.js";

/** One SSE frame's payload, `"done"` for the terminator, or null for noise. */
export function eventOf(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== "")
    .join("\n");
  if (data === "") return null;
  if (data === "[DONE]") return "done";
  try {
    const parsed = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Turn one Genie event into prose on the run.
 *
 * The studio renders markdown, so tool activity arrives as blockquote lines:
 * what ran, whether it worked. The output itself stays in the agent's
 * transcript; the answer is the model's summary of it, as in the console.
 */
export function applyEvent(run, event) {
  switch (event.type) {
    case "session":
      if (typeof event.id === "string" && event.id !== "") run.sessionId = event.id;
      break;
    case "text":
      if (typeof event.text === "string") run.append(event.text);
      break;
    case "tool_call":
      run.append(`\n\n> ⚙ **${oneLine(event.name, 80)}**${describeArgs(event.args)}\n`);
      break;
    case "tool_result": {
      const failed = event.ok === false;
      const detail =
        typeof event.content === "string" && event.content !== ""
          ? `: ${oneLine(event.content, 160)}`
          : "";
      run.append(`> ${failed ? `✗ failed${detail}` : "✓ done"}\n`);
      break;
    }
    case "approval_request":
      run.append(`\n\n> ⏵ **${oneLine(event.name, 80)}** — auto-approved\n`);
      void approveInGenie(run.config, event.id);
      break;
    case "notice": {
      if (typeof event.text !== "string" || event.text === "") break;
      // A retry notice carries the gateway's whole JSON error; the reason is the
      // part before it, and the rest is the console's to show, not a chat answer.
      const brace = event.text.indexOf("{");
      const reason = brace > 0 ? `${event.text.slice(0, brace)}…` : event.text;
      run.append(`\n\n> ℹ ${oneLine(reason, 240)}\n`);
      break;
    }
    case "error":
      run.append(`\n\n**Error:** ${oneLine(event.message, 400)}\n`);
      break;
    default:
      // `step`, `draft`, `gateway`, `approval_result` and `done` carry no prose.
      break;
  }
}
