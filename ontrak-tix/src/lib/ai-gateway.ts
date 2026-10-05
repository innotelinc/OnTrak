/**
 * The gateway: the one place anything in the product talks to a model.
 *
 * One interface, any model, and a guaranteed answer — the same contract the
 * outcome author made for itself, lifted out so a second caller does not have to
 * re-implement it (and, more importantly, so a second caller cannot accidentally
 * re-implement it *differently*). The call is the generic OpenAI
 * *chat-completions* shape, so nothing here is vendor-specific: OpenAI, Azure
 * OpenAI, a vLLM box, Ollama, LiteLLM, or the organization's own gateway all
 * answer it. No vendor SDK is imported.
 *
 * It resolves; it never throws. A caller is always doing something a person is
 * waiting for — writing a draft, suggesting a queue — and a gateway that can fail
 * a person's request is a gateway that will. On any failure it answers with a
 * reason, so the caller can fall back to its deterministic path and carry the
 * reason to the desk rather than swallowing it.
 */

export interface GatewayConfig {
  /** `<base>/chat/completions` is called; the trailing slash is not needed. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** How long to wait before the caller falls back to its own template. */
  timeoutMs: number;
  /** Set to `0` to force the deterministic path even when a key is present. */
  enabled: boolean;
  /**
   * Whether the deployment *asked* for a model and was refused.
   *
   * The distinction that decides whether a fallback is worth mentioning: a desk that
   * configured a gateway and silently got the template needs to hear about it, while
   * one that never configured anything is working exactly as intended.
   */
  switchedOff: boolean;
}

/** The answer: the model's content, or why there is none. */
export type ChatCall = { ok: true; content: string } | { ok: false; reason: string };

export interface ChatRequest {
  config: GatewayConfig;
  system: string;
  user: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /**
   * Low but not zero by default: a caller that never varies produces the same flat
   * sentence for every ticket in the queue.
   */
  temperature?: number;
}

/**
 * Ask the gateway one question and read the answer's text.
 *
 * The `Authorization` header is omitted rather than sent empty: a keyless local
 * gateway rejects `Authorization: Bearer ` on some builds, and an empty credential
 * is not a credential worth sending. The reason strings are deliberately shaped like
 * the notes the desk reads ("the model answered 500"), because they travel straight
 * into a draft's `note`.
 */
export async function callChat(request: ChatRequest): Promise<ChatCall> {
  const { config } = request;
  const call = request.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await call(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: request.temperature ?? 0.2,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return { ok: false, reason: `the model answered ${response.status}` };

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ok: false, reason: "the model's answer had no content" };

    return { ok: true, content };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `the model did not answer within ${config.timeoutMs}ms`
        : `the model could not be reached (${error instanceof Error ? error.message : String(error)})`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
