/**
 * The transport half of the webhook: one POST, and never a throw.
 *
 * A grader must not be able to fail because a consumer's endpoint is down. The
 * notifier answers with an outcome instead of raising, so a refused or
 * unreachable delivery leaves the graded attempt exactly where it is and the
 * refusal becomes a row somebody can see and retry — which is the only sane
 * shape for a send whose reader is not in this process.
 *
 * Modelled on `ontrak-sentinel/src/lib/alert-notify.ts`, deliberately: both
 * products tell an outside system something happened, and both must survive it
 * not answering.
 */

import { SIGNATURE_HEADER, signatureHeader, webhookBody, type WebhookEvent } from "./webhook-rules";

export const WEBHOOK_URL_ENV = "ONTRAK_WEBHOOK_URL";
export const WEBHOOK_SECRET_ENV = "ONTRAK_WEBHOOK_SECRET";
export const WEBHOOK_TIMEOUT_ENV = "ONTRAK_WEBHOOK_TIMEOUT_MS";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 30_000;

export interface SendOutcome {
  ok: boolean;
  /** The HTTP status, when there was a response at all. */
  status: number | null;
  /** A short reason, for the delivery row's `error` column. */
  error: string | null;
}

export interface WebhookNotifier {
  /** A name for the log line and the delivery row's `transport`. */
  readonly name: string;
  send(event: WebhookEvent): Promise<SendOutcome>;
}

/**
 * POSTs the canonical body, signed.
 *
 * A non-2xx answer is a refusal rather than an exception: the consumer's own
 * words are the useful part, and they end up in the outcome.
 */
export class HttpWebhookNotifier implements WebhookNotifier {
  readonly name = "http";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    options: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async send(event: WebhookEvent): Promise<SendOutcome> {
    const body = webhookBody(event);
    const timestampSec = Math.floor(this.now() / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "ontrak-training-webhooks/1",
          [SIGNATURE_HEADER]: signatureHeader(this.secret, timestampSec, body),
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return {
          ok: false,
          status: response.status,
          error: `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        };
      }
      return { ok: true, status: response.status, error: null };
    } catch (error) {
      const message = (error as Error)?.name === "AbortError" ? "timed out" : ((error as Error)?.message ?? "failed");
      return { ok: false, status: null, error: message.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keeps what it was asked to send, for tests and for an unconfigured deployment. */
export class RecordingWebhookNotifier implements WebhookNotifier {
  readonly name = "recording";
  readonly sent: WebhookEvent[] = [];
  outcome: SendOutcome = { ok: true, status: 200, error: null };

  async send(event: WebhookEvent): Promise<SendOutcome> {
    this.sent.push(event);
    return this.outcome;
  }
}

export interface WebhookConfig {
  url: string;
  secret: string;
  timeoutMs: number;
}

/**
 * The webhook a deployment has configured, or `null`.
 *
 * An unset URL is a real configuration — most deployments have no consumer — so
 * it is `null` rather than an error, and the caller decides whether that is
 * worth a startup line. A URL with no secret is refused loudly, because an
 * unsigned webhook is a body anybody on the path can rewrite.
 */
export function webhookConfigFromEnv(env: Record<string, string | undefined>): WebhookConfig | null {
  const url = (env[WEBHOOK_URL_ENV] ?? "").trim();
  if (!url) return null;

  const secret = (env[WEBHOOK_SECRET_ENV] ?? "").trim();
  if (!secret) {
    return { url, secret: "", timeoutMs: timeoutFor(env) };
  }
  return { url, secret, timeoutMs: timeoutFor(env) };
}

export function notifierFromConfig(config: WebhookConfig | null): WebhookNotifier | null {
  if (!config || !config.secret) return null;
  return new HttpWebhookNotifier(config.url, config.secret, config.timeoutMs);
}

function timeoutFor(env: Record<string, string | undefined>): number {
  const raw = Number((env[WEBHOOK_TIMEOUT_ENV] ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(raw));
}

/** A one-line description of what a deployment's webhook is doing, for the log. */
export function describeWebhook(config: WebhookConfig | null): string {
  if (!config) return "no webhook consumer is configured";
  if (!config.secret) {
    return `${WEBHOOK_URL_ENV} is set but ${WEBHOOK_SECRET_ENV} is not, so webhook delivery stays off`;
  }
  return `graded attempts are posted to ${config.url}`;
}
