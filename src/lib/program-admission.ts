import "server-only";

import { prisma } from "./db";
import {
  eligibilityProblems,
  employerSlotUsage,
  slotRequestProblems,
  type EmployerSlotRow,
  type RuleProblem,
} from "./program-rules";

/**
 * Whether a class may take one more learner, under the funder's rules.
 *
 * The RFQ puts both questions on the provider and both *before* the slot is delivered: a funded
 * class needs a sponsoring employer holding a current eligibility confirmation memo (§4.2), and
 * no employer may take more of the program's slots from that provider than §1.5 allows — "slots
 * delivered to ineligible employers, or in excess of the cap, are not reimbursable, and the
 * selected Applicant carries that risk".
 *
 * What the cap counts is the funder's own answer, not this app's reading: "The 100-slot cap
 * applies to slots reimbursed by CommCorp. Slots for trainees who withdraw, do not attend, or do
 * not complete a course are not reimbursed and do not count toward the cap." (RFQ answers,
 * 2026-10-13, §4.) So an employer is refused a seat when its *completions* have spent the
 * allowance, and never refused one merely because more people enrolled than will finish.
 *
 * Answered here rather than inside each action because a class has two doors: an administrator
 * enrolling somebody from the tenancy's page, and a learner joining with the class code from the
 * sign-up form. The second is the easy one to forget, and it is the one nobody has to be given
 * access to walk through.
 *
 * A class that belongs to no funded program is admitted without question: the rules are a
 * funder's, and a class nobody is funding is not the funder's business.
 */
export async function classAdmission(cohort: {
  name: string;
  organizationId: string | null;
  programId: string | null;
  sponsorOrganizationId: string | null;
  startsOn: Date | null;
}): Promise<RuleProblem[]> {
  if (!cohort.organizationId || !cohort.programId) return [];

  const program = await prisma.program.findUnique({
    where: { id: cohort.programId },
    select: { name: true, employerSlotCap: true },
  });
  if (!program) return [];

  const sponsor = cohort.sponsorOrganizationId
    ? await prisma.organization.findUnique({ where: { id: cohort.sponsorOrganizationId } })
    : null;
  if (!sponsor) {
    return [
      {
        field: "sponsorOrganizationId",
        message: `“${cohort.name}” is a class of ${program.name} with no sponsoring employer, and a funded slot belongs to one — every reported slot has to trace to an employer by FEIN.`,
      },
    ];
  }

  // The memo has to be current when the slot is delivered, so a class that starts after it
  // expires is judged on the later of today and the class's own start date. Checking only today
  // would enrol a learner now into training the funder will not pay for in March.
  const now = new Date();
  const asOf = cohort.startsOn && cohort.startsOn > now ? cohort.startsOn : now;
  const problems = eligibilityProblems(
    {
      name: sponsor.name,
      preRegistered: sponsor.isPreRegistered,
      fein: sponsor.fein,
      memoExpiresOn: sponsor.eligibilityMemoExpiresOn,
    },
    asOf,
  );
  if (problems.length > 0) return problems;

  if (program.employerSlotCap === null) return [];

  const history = await prisma.enrollment.findMany({
    where: { organizationId: cohort.organizationId, sponsorOrganizationId: sponsor.id },
    select: {
      status: true,
      enrolledAt: true,
      funded: true,
      cohort: { select: { pricePerSlotCents: true } },
      attendances: { where: { status: "PRESENT" }, select: { id: true } },
    },
  });
  const rows: EmployerSlotRow[] = history.map((entry) => ({
    employerId: sponsor.id,
    employerName: sponsor.name,
    enrolledOn: entry.enrolledAt,
    status: entry.status,
    present: entry.attendances.length,
    pricePerSlotCents: entry.cohort.pricePerSlotCents,
    funded: entry.funded,
  }));
  const used = employerSlotUsage(rows, program.employerSlotCap)[0]?.slotsUsed ?? 0;

  return slotRequestProblems({ employerName: sponsor.name, slotsUsed: used, cap: program.employerSlotCap }, 1);
}
