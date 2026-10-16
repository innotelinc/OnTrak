import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { OrganizationKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { canCreateTenants } from "@/lib/tenancy";
import { createOrganization } from "@/app/actions/tenants";
import { Flash, PageHeader } from "@/components/PageHeader";
import { Badge, Button, Card, Field, Input, Select, Stat, Textarea, Toggle } from "@/components/ui";
import { formatRelative } from "@/lib/cn";
import { getTranslator } from "@/lib/i18n-server";

export const metadata: Metadata = { title: "Tenancies" };

const KIND_LABEL: Record<OrganizationKind, string> = {
  PLATFORM: "Platform",
  PROVIDER: "Training provider",
  EMPLOYER: "Employer",
};

const KIND_TONE: Record<OrganizationKind, "brand" | "teal" | "sky"> = {
  PLATFORM: "brand",
  PROVIDER: "teal",
  EMPLOYER: "sky",
};

/**
 * The tenancies: one per organisation whose training this deployment carries.
 *
 * This page belongs to the platform operator alone. A tenancy is the thing that decides
 * who can see what, so the ability to make one is the ability to see everything — it is
 * not a page an administrator of one tenancy gets to look at.
 *
 * The card for each tenancy is written in the terms its own program uses (what it trains
 * for, who funds it, how many classes it runs) rather than in row counts, because the
 * person reading this is deciding whether the Massachusetts Workforce Development tenancy
 * is set up the way CommCorp described it.
 */
export default async function TenantsPage({
  searchParams,
}: {
  searchParams: Promise<{ flash?: string; error?: string }>;
}) {
  const { flash, error } = await searchParams;
  const operator = await requireSession();
  const t = await getTranslator();

  if (!canCreateTenants(operator)) {
    redirect(`/?error=${encodeURIComponent("Tenancies belong to the platform operator.")}`);
  }

  const organizations = await prisma.organization.findMany({
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    include: {
      programs: { select: { id: true, name: true, funder: true, awardCents: true } },
      _count: { select: { courses: true, classes: true, users: true, enrollments: true } },
    },
  });

  const shared = await prisma.scenario.count({ where: { organizationId: null } });
  const classes = organizations.reduce((sum, org) => sum + org._count.classes, 0);
  const learners = organizations.reduce((sum, org) => sum + org._count.enrollments, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Platform"
        title="Tenancies"
        description="One tenancy per organisation: its own programs, course catalogue, classes, people and reports — all in one deployment."
        actions={<Link href="/admin" className="text-xs font-semibold text-brand">{t("nav.controlRoom")}</Link>}
      />
      <Flash flash={flash} error={error} />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Tenancies" value={organizations.length} hint="including the operator's own" tone="brand" />
        <Stat label="Classes" value={classes} hint="scheduled across every tenancy" tone="teal" />
        <Stat label="Enrolments" value={learners} hint="learners placed in classes" tone="sky" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          {organizations.length === 0 ? (
            <Card>
              <h2 className="font-display text-base font-semibold text-ink">No tenancies yet</h2>
              <p className="mt-1 text-sm text-ink-soft">
                A specialised training program gets a tenancy of its own. Create the Massachusetts Workforce
                Development one, and its FAST AI classes stop being mixed in with everyone else&apos;s.
              </p>
            </Card>
          ) : null}

          {organizations.map((org) => (
            <Card key={org.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/tenants/${org.id}`}
                      className="font-display text-lg font-semibold text-ink hover:text-brand"
                    >
                      {org.name}
                    </Link>
                    <Badge tone={KIND_TONE[org.kind]}>{KIND_LABEL[org.kind]}</Badge>
                    {org.isPreRegistered ? <Badge tone="lime">Pre-registered</Badge> : null}
                    {!org.active ? <Badge tone="danger">Inactive</Badge> : null}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-ink-faint">{org.slug}</p>
                  {org.programType ? (
                    <p className="mt-2 text-sm text-ink-soft">{org.programType}</p>
                  ) : null}
                  {org.description ? (
                    <p className="mt-1 text-sm text-ink-soft">{org.description}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-ink-faint">
                    {[
                      `${org._count.users} people`,
                      `${org._count.courses} courses`,
                      `${org._count.classes} classes`,
                      `${org._count.enrollments} enrolments`,
                      org.city && org.state ? `${org.city}, ${org.state}` : null,
                      `created ${formatRelative(org.createdAt)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Link
                  href={`/admin/tenants/${org.id}`}
                  className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-soft transition hover:text-ink"
                >
                  Open
                </Link>
              </div>

              {org.programs.length > 0 ? (
                <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
                  {org.programs.map((program) => (
                    <li key={program.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span className="font-semibold text-ink">{program.name}</span>
                      <span className="text-ink-faint">
                        {[program.funder, program.awardCents !== null ? `${(program.awardCents / 100).toLocaleString("en-US")} award` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ))}

          <p className="text-xs text-ink-faint">
            {shared} built-in scenarios are shared with every tenancy and owned by none of them; each tenancy&apos;s
            own scenarios, classes and reports stay inside it.
          </p>
        </div>

        {/* --------------------------------------------------------- new tenancy */}
        <Card className="h-fit">
          <h2 className="font-display text-lg font-semibold text-ink">New tenancy</h2>
          <p className="mt-1 text-sm text-ink-soft">
            For a specialised training program — a funder, a provider, or a single employer whose people are trained
            here.
          </p>

          <form action={createOrganization} className="mt-4 space-y-4">
            <Field label="Name" htmlFor="name">
              <Input id="name" name="name" placeholder="Massachusetts Workforce Development" required />
            </Field>

            <Field label="Key" htmlFor="slug" hint="optional">
              <Input id="slug" name="slug" placeholder="mass-workforce-development" />
            </Field>

            <Field label="Kind" htmlFor="kind">
              <Select id="kind" name="kind" defaultValue="PROVIDER">
                <option value="PROVIDER">Training provider</option>
                <option value="EMPLOYER">Employer</option>
                <option value="PLATFORM">Platform</option>
              </Select>
            </Field>

            <Field label="Trains for" htmlFor="programType" hint="in the program's own words">
              <Input id="programType" name="programType" placeholder="Focused AI Skills Training (FAST AI)" />
            </Field>

            <Field label="Description" htmlFor="description" hint="optional">
              <Textarea id="description" name="description" className="min-h-20" rows={3} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="City" htmlFor="city">
                <Input id="city" name="city" placeholder="Boston" />
              </Field>
              <Field label="State" htmlFor="state">
                <Input id="state" name="state" placeholder="MA" maxLength={2} />
              </Field>
            </div>

            <Toggle
              name="isPreRegistered"
              label="Pre-registered with the funder"
              description="FAST AI only pays for an employer that CommCorp has pre-registered first."
            />

            <Field
              label="Administrator email"
              htmlFor="adminEmail"
              hint="optional"
            >
              <Input id="adminEmail" name="adminEmail" type="email" placeholder="programs@example.org" />
            </Field>
            <p className="-mt-2 text-xs text-ink-faint">
              That address becomes the tenancy&apos;s administrator. An existing account is moved in rather than
              duplicated, so nobody loses their history.
            </p>

            <Button type="submit" className="w-full">
              Create tenancy
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
