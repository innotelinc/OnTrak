/**
 * The AI assist (M7): the model-aware half of the suggestions.
 *
 * TWO LAYERS, AND NEITHER IS REQUIRED
 * -----------------------------------
 * Whether a desk has an assistant at all is a *tenant's* own opt-in
 * (`assist-settings-service.ts`), and it is off until somebody asks for it. Given a
 * desk that did opt in, this file decides the other question: if the deployment has a
 * model configured, the prose is the model's; if it has not, the deterministic
 * assistant answers and nobody is any worse off, because every suggestion here has a
 * rules answer that stands on its own.
 *
 * It never throws and it never silences a failure. A configured gateway that is down
 * still leaves a usable suggestion in front of the agent — the draft, the classification
 * and the hit list are all the deterministic ones — and the reason travels on `note` so
 * an operator can see that the model, not the desk, is the thing that is off.
 */

import { authorConfig, type AuthorConfig } from "./ai-author";
import { callChat } from "./ai-gateway";
import {
  buildAssistPrompt,
  deterministicAssist,
  mergeAssist,
  parseAssistResponse,
  type AssistRequest,
  type AssistResult,
} from "./assist-rules";

export interface AssistDeps {
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** The gateway settings. Defaults to the shared AI configuration. */
  gateway?: AuthorConfig;
}


/**
 * Propose the classification, the summary, the draft reply and the similar tickets.
 *
 * The rules answer is computed first and returned whenever it is the better one — no
 * gateway, a failed gateway, or an answer that cannot be read — so a caller always gets
 * a complete `AssistResult`. Similar tickets are never the model's: they are the local
 * computation, always.
 */
export async function assistTicket(request: AssistRequest, deps: AssistDeps = {}): Promise<AssistResult> {
  const base = deterministicAssist(request);
  const gateway = deps.gateway ?? authorConfig();
  // No model configured is not a failure: the deterministic assistant is the answer, and
  // there is no note, because a deployment that never had a gateway is not a broken one.
  if (!gateway.enabled) return base;

  const { system, user } = buildAssistPrompt(request);
  const answer = await callChat({ config: gateway, system, user, fetchImpl: deps.fetchImpl });
  if (!answer.ok) return { ...base, note: answer.reason };

  const parsed = parseAssistResponse(answer.content, request);
  if (!parsed.ok) return { ...base, note: `the model's answer was unusable: ${parsed.reason}` };

  return mergeAssist(base, parsed.value);
}
