import { redirect } from "next/navigation";

import { requireActor } from "../../../lib/session";
import { hasPermission } from "../../../lib/access-rules";
import { alertPromotionServicesFor, securityAlertServicesFor } from "../../../lib/db";
import { summarizeAlerts } from "../../../lib/security-alert-rules";
import { SUPPRESSION_FIELDS } from "../../../lib/alert-promotion-rules";
import type { PromotionRecord } from "../../../lib/alert-promotion-service";
import { SecurityAlertList } from "../../../components/SecurityAlertList";
import { addSuppressionAction, promoteAlertAction, recordAlertVerdictAction } from "../../actions/security";

export const metadata = { title: "Security" };

/**
 * The security console: the alert stream the desk triages.
 *
 * It shows what has been ingested, how each alert was decided (promoted,
 * suppressed or still just observed), and the suppression rules in force — so a
 * silent detection is a visible choice rather than an unexplained absence. Only
 * staff who may update a ticket can act here.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const actor = await requireActor();
  if (!hasPermission(actor.role, "ticket:read:any")) redirect("/portal");

  const { flash, error } = await searchParams;
  const [alerts, promotions, suppressions] = await Promise.all([
    securityAlertServicesFor().list(actor.tenantId),
    alertPromotionServicesFor().listPromotions(actor.tenantId),
    alertPromotionServicesFor().listSuppressions(actor.tenantId),
  ]);

  const summary = summarizeAlerts(alerts);
  const byAlert = new Map<string, PromotionRecord>(promotions.map((promotion) => [promotion.alertId, promotion]));
  const canTriage = hasPermission(actor.role, "ticket:update");
  const open = alerts.filter((alert) => alert.ticketId === null).length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">Security alerts</h1>
          <p className="text-sm text-ink-soft">
            {summary.total === 0
              ? "Nothing ingested yet."
              : `${summary.total} alert${summary.total === 1 ? "" : "s"} · ${open} not promoted · ${summary.bySeverity.CRITICAL} critical, ${summary.bySeverity.HIGH} high`}
          </p>
        </div>
        <p className="text-xs text-ink-faint">
          {summary.uniqueDetections} detection{summary.uniqueDetections === 1 ? "" : "s"} from {Object.values(summary.bySource).filter((count) => count > 0).length} source
          {Object.values(summary.bySource).filter((count) => count > 0).length === 1 ? "" : "s"}
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl2 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {flash ? <p className="rounded-xl2 border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{flash}</p> : null}

      <SecurityAlertList
        alerts={alerts}
        promotionsFor={(alertId) => byAlert.get(alertId)}
        {...(canTriage ? { actions: { promote: promoteAlertAction, verdict: recordAlertVerdictAction } } : {})}
      />

      <section className="space-y-3 rounded-xl2 border border-line bg-surface p-4">
        <div>
          <h2 className="font-display text-base font-semibold text-ink">Suppression rules</h2>
          <p className="text-sm text-ink-soft">
            An alert matching a rule is never promoted. Suppressions are recorded, not silent — a suppressed alert stays in
            the stream with its reason.
          </p>
        </div>

        {suppressions.length === 0 ? (
          <p className="text-sm text-ink-faint">No suppression rules configured.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl2 border border-line">
            {suppressions.map((rule) => (
              <li key={rule.id} className="px-3 py-2">
                <p className="text-sm text-ink">
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                    {rule.field}
                  </span>{" "}
                  matches “{rule.match}”
                </p>
                <p className="text-xs text-ink-soft">{rule.reason}</p>
                <p className="text-xs text-ink-faint">{rule.until ? `Expires ${rule.until}` : "Permanent"}</p>
              </li>
            ))}
          </ul>
        )}

        {canTriage ? (
          <form action={addSuppressionAction} className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium text-ink">
              Field
              <select name="field" defaultValue="signature" className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink">
                {SUPPRESSION_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-ink">
              Matches
              <input name="match" required className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" />
            </label>
            <label className="text-sm font-medium text-ink">
              Reason
              <input name="reason" className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink" />
            </label>
            <label className="text-sm font-medium text-ink">
              Expires (optional)
              <input
                name="until"
                type="datetime-local"
                className="mt-1 block rounded-xl2 border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
            </label>
            <button type="submit" className="rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-brand-ink">
              Add suppression
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
