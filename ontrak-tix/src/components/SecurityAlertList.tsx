/**
 * Security-alert triage list (M2): the alert stream, as a pure renderer.
 *
 * Split out of the page so the markup — the severity/source chips, the
 * enrichment, the promotion outcome and the triage actions — can be rendered and
 * asserted in tests without a session or a database.
 *
 * The status is always visible and always a sentence, never a bare absence: an
 * alert nobody worked should say *why*, because "it was suppressed" and "nobody
 * looked" are very different answers to the same question.
 */

import type { PromotionRecord } from "../lib/alert-promotion-service";
import type { SecurityAlertRecord } from "../lib/security-alert-service";

export interface SecurityAlertActions {
  promote: (formData: FormData) => Promise<void>;
  verdict: (formData: FormData) => Promise<void>;
  /**
   * Ask OnTrak Sentinel to contain what this alert names (M2/S5).
   *
   * Optional because a desk that has named no Sentinel has nowhere to ask — and a button whose
   * request could only fail is worse than no button, so the page simply does not pass one.
   */
  contain?: (formData: FormData) => Promise<void>;
}

export interface SecurityAlertListProps {
  alerts: SecurityAlertRecord[];
  /** The decision recorded for an alert, if any, so a suppressed alert says why. */
  promotionsFor?: (alertId: string) => PromotionRecord | undefined;
  actions?: SecurityAlertActions;
  /** What is shown beside the containment control: who the request will name as its requester. */
  requestedByLabel?: string;
  emptyMessage?: string;
}

function chip(text: string, tone: "muted" | "brand" | "amber" = "muted") {
  const tones = {
    muted: "bg-surface-muted text-ink-soft",
    brand: "bg-brand/10 text-brand",
    amber: "bg-attention/10 text-attention",
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{text}</span>
  );
}

function severityTone(severity: string): "muted" | "amber" {
  return severity === "CRITICAL" || severity === "HIGH" ? "amber" : "muted";
}

/**
 * Where an alert stands with Sentinel's prevention, always as a sentence.
 *
 * "Nothing was asked" is said rather than left blank, for the same reason the promotion status
 * is: an operator scanning the queue has to be able to tell "nobody asked for a block" from
 * "a block was asked for and is waiting on somebody in the other product".
 */
function Containment({ alert }: { alert: SecurityAlertRecord }) {
  if (alert.containmentState === "NONE") return null;

  const tone =
    alert.containmentState === "APPLIED"
      ? "text-ok"
      : alert.containmentState === "REFUSED" || alert.containmentState === "FAILED"
        ? "text-bad"
        : "text-attention";

  const sentence: Record<string, string> = {
    REQUESTED: "Containment requested — waiting for Sentinel to answer.",
    PENDING: "Containment proposed in Sentinel; a Sentinel administrator has to approve it. Nothing is blocked yet.",
    APPLIED: "Sentinel applied the containment action.",
    REFUSED: "Sentinel refused the containment action.",
    FAILED: "Sentinel could not be reached; nothing was blocked.",
  };

  return (
    <p className={`mt-1 text-xs ${tone}`}>
      {sentence[alert.containmentState]}
      {alert.containmentActionId ? ` Action ${alert.containmentActionId}.` : ""}
    </p>
  );
}

/** One alert's promotion status, as text plus a link when it became a ticket. */
function Status({ alert, promotion }: { alert: SecurityAlertRecord; promotion: PromotionRecord | undefined }) {
  if (alert.ticketId) {
    return (
      <p className="mt-1 text-xs text-ink-soft">
        Promoted to{" "}
        <a href={`/inbox/${alert.ticketId}`} className="font-semibold text-brand hover:underline">
          {promotion?.ticketRef ?? "ticket"}
        </a>
      </p>
    );
  }
  if (promotion?.decision === "SUPPRESS") {
    return <p className="mt-1 text-xs text-ink-soft">Suppressed — {promotion.reason}</p>;
  }
  return null;
}

export function SecurityAlertList({
  alerts,
  promotionsFor,
  actions,
  requestedByLabel,
  emptyMessage,
}: SecurityAlertListProps) {
  if (alerts.length === 0) {
    return (
      <p className="rounded-xl2 border border-line bg-surface p-5 text-sm text-ink-soft">
        {emptyMessage ?? "No security alerts have been ingested yet. Connectors feed this stream."}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line bg-surface">
      {alerts.map((alert) => {
        const promotion = promotionsFor?.(alert.id);
        return (
          <li key={alert.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {chip(`${alert.triageSeverity}`, severityTone(alert.triageSeverity))}
              {chip(alert.source, "brand")}
              {alert.triageSeverity !== alert.severity ? chip(`sensor ${alert.severity}`, "muted") : null}
              {alert.occurrences > 1 ? chip(`${alert.occurrences}×`, "muted") : null}
              {alert.assetCriticality === "HIGH" || alert.assetCriticality === "CRITICAL" ? chip("critical asset", "amber") : null}
              {alert.identityPrivileged ? chip("privileged identity", "amber") : null}
              {alert.source === "SENTINEL" && alert.rulebookVersion ? chip(`rulebook ${alert.rulebookVersion}`, "muted") : null}
              {alert.threatIntelCount > 0 ? chip(`${alert.threatIntelCount} indicator${alert.threatIntelCount === 1 ? "" : "s"}`, "amber") : null}
              {alert.techniques.map((technique) => chip(technique, "muted"))}
              <time className="ml-auto text-[11px] text-ink-faint" dateTime={alert.lastSeenAt}>
                {alert.lastSeenAt}
              </time>
            </div>

            <p className="mt-1 font-semibold text-ink">{alert.signature}</p>
            <p className="mt-0.5 text-sm text-ink-soft">{alert.description}</p>

            <p className="mt-1 text-xs text-ink-faint">
              {[
                alert.asset ? `Asset ${alert.asset}${alert.assetCriticality ? ` (${alert.assetCriticality})` : ""}` : null,
                alert.assetOwner ? `owner ${alert.assetOwner}` : null,
                alert.identityName ? `Identity ${alert.identityName}` : alert.identity ? `Identity ${alert.identity}` : null,
                alert.sourceIp ? `From ${alert.sourceIp}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>

            <Status alert={alert} promotion={promotion} />
            <Containment alert={alert} />

            {actions && !alert.ticketId ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <form action={actions.promote}>
                  <input type="hidden" name="alertId" value={alert.id} />
                  <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
                    Open incident
                  </button>
                </form>
                <form action={actions.verdict}>
                  <input type="hidden" name="alertId" value={alert.id} />
                  <input type="hidden" name="verdict" value="FALSE_POSITIVE" />
                  <button type="submit" className="text-xs font-semibold text-ink-faint hover:text-ink">
                    Mark false positive
                  </button>
                </form>
              </div>
            ) : null}

            {/*
              Containment is offered whatever the alert's promotion state: a detection worth
              escalating is exactly the one worth containing, and gating the ask on "not yet a
              ticket" would make the desk choose between documenting the incident and stopping
              it.
            */}
            {actions?.contain && alert.containmentState !== "PENDING" && alert.containmentState !== "APPLIED" ? (
              <form action={actions.contain} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="alertId" value={alert.id} />
                {requestedByLabel ? <input type="hidden" name="requestedByLabel" value={requestedByLabel} /> : null}
                <label className="text-xs font-medium text-ink-soft">
                  Contain in Sentinel
                  <input
                    name="reason"
                    required
                    placeholder="Why this should be contained"
                    className="ml-2 rounded-xl2 border border-line bg-surface px-2 py-1 text-xs text-ink"
                  />
                </label>
                <button type="submit" className="rounded-full bg-attention/15 px-3 py-1.5 text-xs font-semibold text-attention">
                  Ask Sentinel
                </button>
              </form>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
