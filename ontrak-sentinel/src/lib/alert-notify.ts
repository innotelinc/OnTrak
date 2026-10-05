import type { AlertRecord } from "./detection-service.js";

/**
 * Alert delivery (S4): the seam that turns a raised alert into something a person is
 * told about, rather than a row somebody has to remember to look at.
 *
 * Detection raises a row and stops there (`detection-service.ts`), which is the right
 * half of the job and the wrong half of the *product*: a queue nobody is watching is a
 * detector that is formally working and practically not. This module is the other half,
 * and it is an **interface plus two implementations** for the same reason the
 * enforcement plane is — Sentinel does not own anybody's pager, chat or mail server, and
 * a deployment that has one already has a way to talk to it.
 *
 * Three properties are the interface's, not an implementation's:
 *
 *   * **One alert, one notification.** The detector is told about the moments an alert
 *     is *raised*, not about every sighting that refreshes it, so a burst is one message
 *     rather than a hundred — delivery is the cure for a noisy queue, and re-sending on
 *     every repeat would be the disease.
 *   * **A transport never throws.** `notify` answers with an outcome, because a webhook
 *     being down is not a reason for a detection to fail. The service records the
 *     refusal on the chain and leaves the alert exactly where it is — the alert is what
 *     was detected, and a transport that could not be reached is a fact about the
 *     transport.
 *   * **There is no transport by default.** A deployment with none behaves exactly as it
 *     did before this module existed, and must not be told its alerts are being
 *     delivered anywhere.
 *
 * What a transport is *given* is the alert's own projection — what it is about, how bad
 * it is, and the deduplication key it is stored under — so the message can be joined
 * back to the row in the queue rather than being a notification nobody can find again.
 */

/** What a transport answered. A refusal is data, not an exception. */
export type NotifyOutcome = { ok: true; detail: string } | { ok: false; error: string };

/**
 * A raised alert, as the thing somebody is told about.
 *
 * Deliberately the alert's *summary* rather than its evidence: a transport is somebody
 * else's system, and the observations that made the alert fire stay in the queue it
 * belongs to. What travels is what a person needs to decide whether to look — what
 * fired, how bad it is, what it is about, and the key to find it by.
 */
export interface AlertNotification {
  alertId: string;
  organizationId: string;
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  severity: string;
  sourceAddress: string | null;
  identityId: string | null;
  identityLabel: string | null;
  device: string | null;
  asset: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  dedupeKey: string;
  /** How many indicators the evidence matched, so a consumer can see why it is loud. */
  threatIntel: number;
}

/** The projection one alert becomes. Kept here so every transport is handed the same shape. */
export function alertNotification(alert: AlertRecord): AlertNotification {
  return {
    alertId: alert.id,
    organizationId: alert.organizationId,
    ruleId: alert.ruleId,
    ruleName: alert.ruleName,
    ruleVersion: alert.ruleVersion,
    severity: alert.severity,
    sourceAddress: alert.sourceAddress,
    identityId: alert.identityId,
    identityLabel: alert.identityLabel,
    device: alert.device,
    asset: alert.asset,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrences: alert.occurrences,
    dedupeKey: alert.dedupeKey,
    threatIntel: alert.threatIntel.length,
  };
}

export interface AlertNotifier {
  /** Named in the evidence chain, so a reader can tell which transport was told. */
  readonly name: string;
  notify(event: AlertNotification): Promise<NotifyOutcome>;
}

/**
 * A transport that keeps what it was told, and does nothing with it.
 *
 * Two real uses, and neither is a placeholder: it is the transport a deployment runs to
 * exercise delivery with no pager wired, and it is the one a test drives — so "an alert
 * is delivered once, when it is raised" is asserted rather than described.
 */
export class RecordingAlertNotifier implements AlertNotifier {
  readonly name: string;
  readonly delivered: AlertNotification[] = [];

  constructor(name = "recording") {
    this.name = name;
  }

  async notify(event: AlertNotification): Promise<NotifyOutcome> {
    this.delivered.push(event);
    return { ok: true, detail: `recorded ${event.severity} from ${event.ruleId}` };
  }
}

export interface HttpAlertNotifierOptions {
  /** The transport's one endpoint. Every notification is a `POST` to it. */
  url: string;
  /** A bearer token, when the transport wants one. Sent only when set. */
  token?: string;
  /** How long to wait before treating the transport as unreachable. */
  timeoutMs?: number;
  /** Injected only by a test. */
  fetchImpl?: typeof fetch;
}

/**
 * A transport that speaks HTTP: one `POST` of `AlertNotification` as JSON.
 *
 * One endpoint rather than a vocabulary of its own, because this is the *deployment's*
 * adapter — a Slack hook, a ticketing intake, a mail relay's HTTP door — and each of
 * those already has a shape. The answer is believed only when it is a 2xx, and anything
 * else, including a timeout, a DNS failure and a connection refused, is an outcome the
 * chain records rather than an exception that would take the detection down with it.
 */
export class HttpAlertNotifier implements AlertNotifier {
  readonly name: string;
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpAlertNotifierOptions) {
    this.url = options.url;
    this.token = options.token ?? "";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // The host identifies the transport in an audit row without putting a path (which may
    // name a channel or a tenant) into every entry.
    try {
      this.name = `http:${new URL(this.url).host}`;
    } catch {
      this.name = "http";
    }
  }

  async notify(event: AlertNotification): Promise<NotifyOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token === "" ? {} : { authorization: `Bearer ${this.token}` }),
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!response.ok) {
        // The transport's own words when it sent any: a 4xx body is usually the only thing
        // that says *why* the notification was rejected, and replacing it with "HTTP 400"
        // would throw away the answer.
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          error: `transport answered ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
        };
      }
      return { ok: true, detail: `transport answered ${response.status}` };
    } catch (error) {
      // Abort, DNS, TLS, connection refused: one outcome, because they are one fact to the
      // operator — the transport did not answer.
      const detail = error instanceof Error ? error.message : "unknown error";
      return { ok: false, error: `transport unreachable: ${detail}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The transport a deployment's environment describes, or `null` for none.
 *
 * Read here rather than in the service so the seam stays testable without an environment.
 * An unset URL is **no transport** rather than a default that pretends — a deployment that
 * has not configured one must not be told its alerts are being delivered somewhere.
 */
export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): AlertNotifier | null {
  const url = String(env.SENTINEL_ALERT_WEBHOOK_URL ?? "").trim();
  if (url === "") return null;
  const token = String(env.SENTINEL_ALERT_WEBHOOK_TOKEN ?? "").trim();
  const timeout = Number(env.SENTINEL_ALERT_WEBHOOK_TIMEOUT_MS ?? "");
  return new HttpAlertNotifier({
    url,
    ...(token === "" ? {} : { token }),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  });
}
