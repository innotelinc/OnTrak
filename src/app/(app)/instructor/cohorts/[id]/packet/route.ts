/**
 * A class's proof-of-training packet, as a download.
 *
 * This is the training-side counterpart to OnTrak Tix's incident assurance
 * packet: every live completion record the class's members hold, bundled and
 * signed as one document (`ontrak.assurance.packet/v1`) that an auditor or
 * insurer can check without an account, without this database, and without
 * trusting either. Verification is the same `/verify` page a learner uses.
 *
 * Scoping follows the rest of the staff surface: an instructor exports only the
 * classes they run, an administrator any of them. Revoked records are left out —
 * a certificate whose pass no longer stands has no business in an evidence pack —
 * and the audit log records that the export happened and how much it carried.
 */

import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { buildAssurancePacket } from "@/lib/credentials";
import { issuerName, readStoredCertificate, sha256Hex } from "@/lib/certificates";
import { slugify } from "@/lib/scenario-rules";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  if (user.role === "STUDENT") notFound();

  const cohort = await prisma.cohort.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      instructorId: true,
      members: { select: { userId: true } },
    },
  });

  if (!cohort) notFound();
  if (user.role !== "ADMIN" && cohort.instructorId !== user.id) notFound();

  const attempts = await prisma.attempt.findMany({
    where: {
      userId: { in: cohort.members.map((member) => member.userId) },
      // Both columns, because a record without an issue date is not one this
      // deployment ever issued: `readStoredCertificate` would reject it anyway.
      certificateIssuedAt: { not: null },
      certificateRevokedAt: null,
    },
    select: { id: true, certificate: true, certificateIssuedAt: true, certificateRevokedAt: true },
    orderBy: { certificateIssuedAt: "asc" },
  });

  const records = attempts
    .map((attempt) => readStoredCertificate(attempt))
    .filter((stored) => stored !== null)
    .map((stored) => stored.record);

  const packet = buildAssurancePacket(records, issuerName(), new Date().toISOString(), sha256Hex);

  await recordAudit({
    actorId: user.id,
    action: "cohort.packet",
    targetType: "cohort",
    targetId: cohort.id,
    detail: { records: records.length },
  });

  const filename = `${slugify(cohort.name) || "cohort"}-assurance-packet.json`;

  return new Response(JSON.stringify(packet, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
