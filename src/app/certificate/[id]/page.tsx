/**
 * A printable certificate.
 *
 * Deliberately outside the `(app)` route group: no sidebar, no header, no toasts
 * — just the sheet, so printing gives a certificate rather than a screenshot of
 * an application. It renders the **stored** record, not a freshly derived one, so
 * the code on the paper is the code that was issued, even if the attempt has been
 * re-graded since (see `docs/training-evidence.md`).
 *
 * A revoked certificate, or one that was never issued, is a 404 rather than a
 * blank sheet: there is nothing truthful to print.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { certificateCode } from "@/lib/credentials";
import { readStoredCertificate } from "@/lib/certificates";
import { Badge } from "@/components/ui";
import { PrintButton } from "@/components/PrintButton";
import { formatDateTime } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Certificate" };

export default async function CertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const t = await getTranslator();

  const attempt = await prisma.attempt.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      certificate: true,
      certificateIssuedAt: true,
      certificateRevokedAt: true,
    },
  });

  if (!attempt) notFound();
  // Attempt records are private to their owner; staff may look at anyone's, which
  // is the same rule the report page applies.
  if (attempt.userId !== user.id && user.role === "STUDENT") notFound();

  const stored = readStoredCertificate(attempt);
  if (!stored || attempt.certificateRevokedAt) notFound();

  const record = stored.record;
  const skills = record.skills ?? [];
  const code = certificateCode(record);
  const backHref = user.role === "STUDENT" ? `/student/results/${attempt.id}` : `/instructor/attempts/${attempt.id}`;

  return (
    <main className="certificate-sheet min-h-dvh bg-canvas px-6 py-8 print:min-h-0 print:bg-white print:p-0">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={backHref} className="text-sm font-semibold text-brand hover:underline">
          ← {t("certificate.print.back")}
        </Link>
        <PrintButton label={t("certificate.print.action")} />
      </div>

      <article className="mx-auto mt-6 max-w-3xl rounded-xl3 border border-line bg-surface p-8 shadow-card sm:p-12 print:mt-0 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <p className="font-display text-xs font-semibold tracking-[0.18em] text-brand uppercase">{record.issuer}</p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-ink sm:text-4xl">
          {t("certificate.print.title")}
        </h1>

        <p className="mt-8 text-sm text-ink-soft">{t("certificate.print.certifies")}</p>
        <p className="mt-1 font-display text-2xl font-semibold text-ink sm:text-3xl">{record.learnerName}</p>

        <p className="mt-6 text-sm text-ink-soft">{t("certificate.print.completed")}</p>
        <p className="mt-1 font-display text-xl font-semibold text-ink">{record.scenarioTitle}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {t("certificate.print.outcome", {
            percent: record.percent,
            score: record.score,
            max: record.maxScore,
          })}{" "}
          · {formatDateTime(new Date(record.completedAt))} · {record.platform}
        </p>

        {skills.length > 0 ? (
          <div className="mt-8">
            <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{t("certificate.skills")}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {skills.map((skill) => (
                <li key={skill}>
                  <Badge tone="neutral">{skill}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <dl className="mt-10 grid gap-4 border-t border-line pt-6 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{t("certificate.code")}</dt>
            <dd className="mt-1 font-mono text-base font-semibold text-ink">{code}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
              {t("certificate.print.digest")}
            </dt>
            <dd className="mt-1 truncate font-mono text-[11px] text-ink-soft">{record.digest}</dd>
          </div>
        </dl>

        <p className="mt-6 text-xs text-ink-faint">
          {t("certificate.verifyHint")}{" "}
          <span className="font-mono text-ink-soft">/verify</span> · {t("certificate.print.issued", { when: formatDateTime(new Date(stored.issuedAt)) })}
        </p>
      </article>
    </main>
  );
}
