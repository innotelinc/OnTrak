/**
 * The studio's chat, answered by Genie's agent instead of a bare completion.
 *
 * The implementation lives in `studio-agent/`: `request.js` decides whether a
 * call is the person's turn, `turn.js` runs it (joining every racer onto one
 * run), `sessions.js` keeps conversation -> Genie session across a restart,
 * `genie-events.js` turns stream events into the answer, `runs.js` owns the
 * in-flight registry and `responses.js` speaks the OpenAI shape.
 *
 * This file stays as the seam `app.js` imports, so the split did not move the
 * call site.
 */
export { handleAgentChat, isAgentRequest, resetAgentState } from "./studio-agent/index.js";
