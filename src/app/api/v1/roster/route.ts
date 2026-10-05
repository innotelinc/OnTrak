/**
 * `GET /api/v1/roster` — who is enrolled, and in what.
 * `POST /api/v1/roster` — the same rows back in, from the class spreadsheet.
 *
 *   GET  /api/v1/roster?cohortId=...&role=STUDENT
 *   POST /api/v1/roster      Content-Type: text/csv   (or {"csv": "..."})
 *   Authorization: Bearer $ONTRAK_API_TOKEN
 *
 * IMPORT IS A DIRECTORY SYNC, NOT A PASSWORD ISSUE. A user created here has no
 * local password, exactly like one provisioned by the identity provider: the
 * roster says who exists and what they teach or learn, and it is the wrong
 * document to carry a credential. A deployment with no provider sets passwords
 * from the admin console afterwards; one with a provider does not need to.
 *
 * A cohort name the import does not recognise is *reported*, not invented. The
 * class may be created later under the instructor who owns it, and a membership
 * pointing at a row nobody owns would be a class with no teacher — so the user
 * is still imported, the membership is skipped, and the name comes back in
 * `unmatchedCohorts` so an administrator can fix it in one round trip.
 *
 * `?dryRun=1` answers with the same report and writes nothing, which is how a
 * five-thousand-row file should be checked the first time. The counts in a dry
 * run are the counts it would have written, so the report means the same thing
 * either way.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { Role } from "@prisma/client";

import { prisma } from "@/lib/db";
import { pickAccent } from "@/lib/auth-hash";
import { recordAudit } from "@/lib/audit";
import { readRosterCsv, type RosterCsvRow } from "@/lib/csv-rules";
import { loadRosterPage, readRosterFilters, toRosterJson } from "../_roster";
import { apiAccess, badBody } from "../_access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const read = readRosterFilters(request.nextUrl.searchParams);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 400 });

  const { rows, localPassword, nextCursor } = await loadRosterPage(read.filters);
  return NextResponse.json({
    users: rows.map((user) => toRosterJson(user, localPassword.has(user.id))),
    nextCursor,
    count: rows.length,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const access = apiAccess(request);
  if (!access.ok) return access.response;

  const text = await readBody(request);
  if (text === null) return badBody();
  if (text.trim().length === 0) {
    return NextResponse.json(
      { error: "The request carried no CSV — send a CSV body, or JSON with a `csv` string." },
      { status: 400 },
    );
  }

  const read = readRosterCsv(text);
  if (!read.ok) return NextResponse.json({ error: read.reason }, { status: 422 });

  const dryRun = ["1", "true", "yes"].includes((request.nextUrl.searchParams.get("dryRun") ?? "").toLowerCase());

  const existing = await prisma.user.findMany({
    where: { email: { in: read.rows.map((row) => row.email) } },
    select: { id: true, email: true, name: true, role: true, active: true },
  });
  const byEmail = new Map(existing.map((user) => [user.email, user]));

  // Cohort names resolve case-insensitively: a spreadsheet's capitalisation is
  // not a claim about which class is meant.
  const wanted = [...new Set(read.rows.flatMap((row) => row.cohorts))];
  const cohorts = wanted.length
    ? await prisma.cohort.findMany({
        where: { name: { in: wanted, mode: "insensitive" } },
        select: { id: true, name: true },
      })
    : [];
  const cohortByName = new Map(cohorts.map((cohort) => [cohort.name.toLowerCase(), cohort]));
  const unmatchedCohorts = wanted.filter((name) => !cohortByName.has(name.toLowerCase()));

  // Which memberships already exist, in one read: deciding "new membership" from
  // a per-row count would be both an N+1 and a race with a second import.
  const knownIds = existing.map((user) => user.id);
  const cohortIds = cohorts.map((cohort) => cohort.id);
  const held = new Set<string>();
  if (knownIds.length && cohortIds.length) {
    const memberships = await prisma.cohortMember.findMany({
      where: { userId: { in: knownIds }, cohortId: { in: cohortIds } },
      select: { userId: true, cohortId: true },
    });
    for (const membership of memberships) held.add(`${membership.userId}:${membership.cohortId}`);
  }

  const planned: { row: RosterCsvRow; userId: string; cohortIds: string[] }[] = [];
  let created = 0;
  let updated = 0;
  for (const row of read.rows) {
    const user = byEmail.get(row.email);
    const ids = row.cohorts
      .map((name) => cohortByName.get(name.toLowerCase())?.id)
      .filter((id): id is string => id !== undefined);
    planned.push({ row, userId: user?.id ?? "", cohortIds: ids });
    if (user) updated += 1;
    else created += 1;
  }
  const newMemberships = planned.reduce(
    (total, entry) => total + entry.cohortIds.filter((id) => !held.has(`${entry.userId}:${id}`)).length,
    0,
  );

  if (!dryRun) {
    for (const entry of planned) {
      const userId = await applyRosterUser(entry.row, byEmail.get(entry.row.email) ?? null);
      const fresh = entry.cohortIds.filter((id) => !held.has(`${userId}:${id}`));
      if (fresh.length > 0) {
        await prisma.cohortMember.createMany({
          data: fresh.map((cohortId) => ({ cohortId, userId })),
          skipDuplicates: true,
        });
        for (const cohortId of fresh) held.add(`${userId}:${cohortId}`);
      }
    }

    await recordAudit({
      action: "roster.import",
      targetType: "user",
      targetId: null,
      detail: {
        rows: read.rows.length,
        created,
        updated,
        memberships: newMemberships,
        refused: read.refused.length,
        unmatchedCohorts,
      },
    });
  }

  return NextResponse.json({
    dryRun,
    rows: read.rows.length,
    created,
    updated,
    memberships: newMemberships,
    refused: read.refused,
    unmatchedCohorts,
  });
}

/** The CSV body, or a JSON envelope around one. `null` means unreadable JSON. */
async function readBody(request: NextRequest): Promise<string | null> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) return request.text();
  try {
    const body: unknown = await request.json();
    const csv = (body as { csv?: unknown } | null)?.csv;
    return typeof csv === "string" ? csv : "";
  } catch {
    return null;
  }
}

/**
 * Create or refresh one roster user.
 *
 * An update touches only what the file can actually be authoritative about —
 * name, role and whether the account is active. A password, an accent or an
 * `externalId` are *not* in a roster import's scope, so a re-import cannot
 * demote a renamed account or clear the link to the provider's subject.
 */
async function applyRosterUser(row: RosterCsvRow, existing: { id: string; name: string; role: Role; active: boolean } | null): Promise<string> {
  if (existing) {
    const unchanged =
      existing.name === row.name && existing.role === row.role && existing.active === row.active;
    if (!unchanged) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { name: row.name, role: row.role as Role, active: row.active },
      });
    }
    return existing.id;
  }
  const user = await prisma.user.create({
    data: {
      email: row.email,
      name: row.name,
      role: row.role as Role,
      active: row.active,
      passwordHash: null,
      accent: pickAccent(row.email),
    },
    select: { id: true },
  });
  return user.id;
}
