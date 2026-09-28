import type { Metadata } from "next";
import { requireSession } from "@/lib/auth";
import { recentAudit } from "@/lib/audit";
import { PageHeader } from "@/components/PageHeader";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Audit log" };

const TONE: Record<string, "teal" | "pink" | "amber" | "brand" | "neutral"> = {
  "auth.sign_in": "brand",
  "auth.register": "brand",
  "platform.enable": "teal",
  "platform.disable": "pink",
  "software.create": "teal",
  "software.update": "brand",
  "software.delete": "pink",
  "software.enable": "teal",
  "software.disable": "amber",
  "software.set_key": "amber",
  "user.create": "teal",
  "user.update": "brand",
  "user.delete": "pink",
  "scenario.create": "teal",
  "scenario.update": "brand",
  "scenario.publish": "teal",
  "scenario.unpublish": "amber",
  "scenario.delete": "pink",
  "attempt.start": "neutral",
  "attempt.submit": "brand",
  "attempt.regrade": "amber",
};

export default async function AuditPage() {
  await requireSession();
  const t = await getTranslator();
  const entries = await recentAudit(200);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        eyebrow={t("audit.eyebrow")}
        title={t("audit.title")}
        description={t("audit.description")}
      />

      {entries.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={t("audit.empty.title")} description={t("audit.empty.description")} />
        </div>
      ) : (
        <Card className="mt-6 overflow-hidden p-0">
          <ul className="divide-y divide-line">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
                <Badge tone={TONE[entry.action] ?? "neutral"}>{entry.action}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    <span className="font-semibold">{entry.actor?.name ?? "system"}</span>
                    {entry.actor?.email ? <span className="text-ink-faint"> ({entry.actor.email})</span> : null}{" "}
                    <span className="text-ink-soft">
                      {entry.action.split(".")[1]?.replace(/_/g, " ") ?? entry.action} on {entry.targetType}
                    </span>
                    {entry.targetId ? <span className="font-mono text-xs text-ink-faint"> {entry.targetId}</span> : null}
                  </p>
                  {entry.detail && Object.keys(entry.detail as object).length > 0 ? (
                    <p className="mt-1 font-mono text-[11px] break-all text-ink-faint">
                      {JSON.stringify(entry.detail)}
                    </p>
                  ) : null}
                </div>
                <span className="text-xs whitespace-nowrap text-ink-faint">{formatDateTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
