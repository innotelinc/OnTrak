/**
 * The hand-off to OnTrak ITS — the training range.
 *
 * This is the last leg of the loop: a ticket is solved, an article is written, and
 * the same experience becomes something the next person can *practise*. The desk
 * does not own the training range and does not write to its database; it POSTs a
 * draft, and the range decides what to do with it.
 *
 * WHY A DRAFT AND NOT A SCENARIO
 * A training scenario is a graded simulator definition — a platform, an engine, a
 * machine state, checks that score a person. A resolved ticket is evidence that a
 * fix worked, which is a different thing. So what travels is an unpublished draft
 * with the objectives and the steps, and an instructor turns it into a scenario.
 * Autopublishing a machine-authored scenario would put unmarked, unverified work in
 * front of learners and call it a grade.
 *
 * The endpoint is server-to-server, so in a container stack the host is the service
 * name and never `localhost` — from inside the desk, `localhost` is the desk.
 */

import type { ScenarioDraft } from "./outcome-rules";

export const ITS_BASE_URL_ENV = "ONTRAK_ITS_BASE_URL";
export const ITS_TOKEN_ENV = "ONTRAK_ITS_SERVICE_TOKEN";

export interface ItsConfig {
  /** The range's origin, e.g. `http://ontrak-training-app:3000`. */
  baseUrl: string;
  /** A service token minted in the range; sent as a bearer. */
  token: string;
  /** Both a base URL and a token are required; half-set is not "almost working". */
  enabled: boolean;
  timeoutMs: number;
}

export function itsConfig(env: Record<string, string | undefined> = process.env): ItsConfig {
  const baseUrl = (env[ITS_BASE_URL_ENV] ?? "").trim().replace(/\/+$/, "");
  const token = (env[ITS_TOKEN_ENV] ?? "").trim();
  const timeout = Number(env.ONTRAK_ITS_TIMEOUT_MS ?? "");
  return {
    baseUrl,
    token,
    enabled: baseUrl.length > 0 && token.length > 0,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
  };
}

/** The body the range expects. Named here so both sides can read one definition. */
export interface ScenarioHandoff {
  ticketRef: string;
  title: string;
  summary: string;
  description: string;
  engine: ScenarioDraft["engine"];
  difficulty: ScenarioDraft["difficulty"];
  objectives: string[];
  steps: ScenarioDraft["steps"];
  tags: string[];
}

export function scenarioHandoffBody(ticketRef: string, draft: ScenarioDraft): ScenarioHandoff {
  return {
    ticketRef,
    title: draft.title,
    summary: draft.summary,
    description: draft.description,
    engine: draft.engine,
    difficulty: draft.difficulty,
    objectives: [...draft.objectives],
    steps: draft.steps.map((step) => ({ ...step, actions: [...step.actions] })),
    tags: [...draft.tags],
  };
}

export interface HandoffResult {
  ok: boolean;
  /** The range's own id for the draft, when it accepted one. */
  id?: string;
  reason?: string;
}

/**
 * Send one draft to the range. Never throws: a training range that is down must
 * not make a resolution fail, and the sweep reports the refusal instead.
 */
export async function handOffScenario(
  ticketRef: string,
  draft: ScenarioDraft,
  options: { config?: ItsConfig; fetchImpl?: typeof fetch } = {},
): Promise<HandoffResult> {
  const config = options.config ?? itsConfig();
  if (!config.enabled) {
    return { ok: false, reason: "OnTrak ITS is not configured for this desk" };
  }

  const call = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await call(`${config.baseUrl}/api/v1/scenario-drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(scenarioHandoffBody(ticketRef, draft)),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: `OnTrak ITS answered ${response.status}` };
    }
    const payload = (await response.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: payload?.id };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? `OnTrak ITS did not answer within ${config.timeoutMs}ms`
      : `OnTrak ITS could not be reached (${error instanceof Error ? error.message : String(error)})`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
