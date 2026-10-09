import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { attemptScopeFor } from "@/lib/attempt-scope";
import { holdsSkill, skillKey, skillsMatrixFrom, type SkillRow } from "@/lib/skills-rules";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Card, EmptyState, Stat } from "@/components/ui";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Skills matrix" };

/**
 * Who is competent in what, from the certificates this deployment has issued.
 *
 * The rule is pure and tested (`skills-rules.ts`); this page is the reader. Two
 * deliberate choices live here rather than in the rule:
 *
 *  - the scope is the same `attemptScopeFor` the attempts list and the analytics
 *    dashboard use, so an instructor sees their own students and an administrator
 *    sees everyone — a matrix is a report about people, and a second visibility
 *    rule would be a second place to get it wrong.
 *  - rows are read oldest-issued first, so the name shown is the account's current
 *    one and a competency's column is labelled with the earliest spelling of it.
 */
export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const user = await requireSession();
  if (user.role === "STUDENT") {
    redirect("/student?error=" + encodeURIComponent("Instructor access is required for that."));
  }
  const t = await getTranslator();
  const scope = await attemptScopeFor(user);

  // Only attempts that actually carry a stored record: `certificateIssuedAt` is
  // written when one is issued and never cleared, so this reads every certificate
  // that was ever issued — live or revoked — and nothing else.
  const attempts = await prisma.attempt.findMany({
    where: { ...scope, certificateIssuedAt: { not: null } },
    select: {
      userId: true,
      certificate: true,
      certificateIssuedAt: true,
      certificateRevokedAt: true,
      user: { select: { name: true } },
    },
    orderBy: { certificateIssuedAt: "asc" },
    take: 5000,
  });

  const rows: SkillRow[] = attempts.map((attempt) => ({
    userId: attempt.userId,
    learnerName: attempt.user.name,
    certificate: attempt.certificate,
    certificateIssuedAt: attempt.certificateIssuedAt,
    certificateRevokedAt: attempt.certificateRevokedAt,
  }));

  const matrix = skillsMatrixFrom(rows);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={t("skills.eyebrow")}
        title={t("skills.title")}
        description={t("skills.description")}
      />
      <Flash flash={flash} error={error} />

      {matrix.learners.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={t("skills.empty.title")} description={t("skills.empty.description")} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={t("skills.stat.skills")}
              value={matrix.skills.length}
              hint={t("skills.hint.skills")}
              tone="brand"
            />
            <Stat
              label={t("skills.stat.learners")}
              value={matrix.learners.length}
              hint={t("skills.hint.learners")}
              tone="sky"
            />
            <Stat
              label={t("skills.stat.certificates")}
              value={matrix.counted}
              hint={t("skills.hint.certificates")}
              tone="teal"
            />
            <Stat
              label={t("skills.stat.revoked")}
              value={matrix.revoked}
              hint={t("skills.hint.revoked")}
              tone={matrix.revoked > 0 ? "amber" : "teal"}
            />
          </div>

          {/* The revocation rule is the whole reason a skill can disappear from
              this page, so it is stated where the claim is made rather than left
              for a reader to infer from an absence. */}
          <p className="mt-3 text-xs text-ink-faint">{t("skills.revocationNote")}</p>

          {matrix.skills.length === 0 ? (
            <div className="mt-6">
              <Card className="p-5">
                <p className="text-sm text-ink-soft">{t("skills.noSkills")}</p>
              </Card>
            </div>
          ) : (
            <Card className="mt-6 overflow-x-auto p-0">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">{t("skills.caption")}</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="px-5 py-3.5 text-left font-semibold text-ink">
                      {t("skills.learner")}
                    </th>
                    {matrix.skills.map((skill) => (
                      <th
                        key={skillKey(skill)}
                        scope="col"
                        className="px-3 py-3.5 text-center font-semibold text-ink"
                      >
                        {skill}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {matrix.learners.map((learner) => (
                    <tr key={learner.userId}>
                      <th scope="row" className="px-5 py-3.5 text-left font-medium text-ink">
                        <span className="block">{learner.name}</span>
                        {learner.revoked > 0 && (
                          <span className="mt-1 block">
                            <Badge tone="amber">
                              {t("skills.revokedBadge", { count: learner.revoked })}
                            </Badge>
                          </span>
                        )}
                      </th>
                      {matrix.skills.map((skill) => {
                        const key = skillKey(skill);
                        const held = holdsSkill(learner, key);
                        const earned = learner.skills.find((entry) => skillKey(entry.skill) === key);
                        return (
                          <td key={key} className="px-3 py-3.5 text-center">
                            <span className="sr-only">
                              {held
                                ? t("skills.heldAria", { name: learner.name, skill })
                                : t("skills.notHeldAria", { name: learner.name, skill })}
                            </span>
                            {held ? (
                              <span aria-hidden="true" className="font-semibold text-teal">
                                ✓
                              </span>
                            ) : (
                              <span aria-hidden="true" className="text-ink-faint">
                                ·
                              </span>
                            )}
                            {earned && (
                              <span className="mt-0.5 block text-[0.65rem] text-ink-faint">
                                {earned.firstEarnedAt.slice(0, 10)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line">
                    <th scope="row" className="px-5 py-3.5 text-left font-medium text-ink-faint">
                      {t("skills.holders")}
                    </th>
                    {matrix.skills.map((skill) => (
                      <td key={skillKey(skill)} className="px-3 py-3.5 text-center text-ink-soft">
                        {matrix.holders[skillKey(skill)] ?? 0}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </Card>
          )}

          {matrix.unreadable > 0 && (
            <p className="mt-3 text-xs text-ink-faint">
              {t("skills.unreadable", { count: matrix.unreadable })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
