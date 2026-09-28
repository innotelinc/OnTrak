/**
 * Seed the database with a runnable demo lab.
 *
 * Everything is idempotent: re-running upserts rather than duplicating, so it is
 * safe to call on a database you have already been clicking around in.
 *
 * It also plants one *finished, passing* attempt for the demo student, so the
 * certificate card, the code on the results index and `/verify` all have
 * something to show in a fresh lab. That row is synthetic — it is scored from the
 * scenario's own checks rather than from a solved machine state — so treat it as
 * demo furniture, not as evidence that anyone did the work.
 *
 *   npm run db:seed
 */

import { PrismaClient } from "@prisma/client";
import { hashPassword, pickAccent } from "../src/lib/auth-hash";
import { demoPassword } from "../src/lib/seed-rules";
import {
  LINUX_ACCOUNTS_TEMPLATE,
  LINUX_NETWORK_TEMPLATE,
  OFFICE_TRIAGE_TEMPLATE,
  TEMPLATES,
  WINDOWS_ACCOUNTS_TEMPLATE,
  WINDOWS_DESKTOP_FILES_TEMPLATE,
  WINDOWS_DESKTOP_TEMPLATE,
} from "../src/lib/templates";
import { validateDefinition } from "../src/lib/validate";
import { certificateForAttempt } from "../src/lib/certificates";
import type { Platform, Prisma, Role } from "@prisma/client";
import type { ScenarioDefinition } from "../src/lib/sim/types";

const prisma = new PrismaClient();

// Must satisfy the sign-in schema's `MIN_PASSWORD_LENGTH`, or the seeded
// accounts cannot actually be used to log in (`src/lib/seed-rules.ts`).
const DEMO_PASSWORD = demoPassword();

const PEOPLE: { name: string; email: string; role: Role; accent: string }[] = [
  { name: "Ada Lovelace", email: "admin@ontrak.local", role: "ADMIN", accent: "pink" },
  { name: "Grace Hopper", email: "instructor@ontrak.local", role: "INSTRUCTOR", accent: "violet" },
  { name: "Alan Turing", email: "student@ontrak.local", role: "STUDENT", accent: "teal" },
  { name: "Katherine Johnson", email: "katherine@ontrak.local", role: "STUDENT", accent: "sky" },
  { name: "Linus Torvalds", email: "linus@ontrak.local", role: "STUDENT", accent: "amber" },
];

const SOFTWARE: {
  name: string;
  vendor: string;
  version: string;
  platform: Platform;
  flavour: string;
  source: "INTERNAL" | "UPLOAD" | "URL";
  sourceUrl?: string;
  licenseType: "OPEN" | "EVALUATION" | "LICENSED";
  licenseKey?: string;
  licenseSeats?: number;
  enabled: boolean;
  description: string;
}[] = [
  {
    name: "Ubuntu Server",
    vendor: "Canonical",
    version: "24.04 LTS",
    platform: "LINUX",
    flavour: "ubuntu-24.04",
    source: "INTERNAL",
    licenseType: "OPEN",
    enabled: true,
    description: "The simulated Ubuntu image used by every Linux scenario. Runs in the browser — nothing to download.",
  },
  {
    name: "Rocky Linux",
    vendor: "Rocky Enterprise Software Foundation",
    version: "9.4",
    platform: "LINUX",
    flavour: "rocky-9",
    source: "INTERNAL",
    licenseType: "OPEN",
    enabled: true,
    description: "Second Linux distribution, for scenarios that need a Red Hat-flavoured box.",
  },
  {
    name: "postfix",
    vendor: "Wietse Venema",
    version: "3.8.6",
    platform: "LINUX",
    flavour: "apt:postfix",
    source: "INTERNAL",
    licenseType: "EVALUATION",
    enabled: false,
    description:
      "Mail transfer agent used by the relay-hardening scenario. Evaluation build — no key required, but an administrator must enable it here first. This is the demo of the availability rule.",
  },
  {
    name: "Windows 11 Workstation",
    vendor: "Microsoft",
    version: "23H2",
    platform: "WINDOWS",
    flavour: "win11-23h2",
    source: "INTERNAL",
    licenseType: "OPEN",
    enabled: true,
    description: "Simulated Windows 11 desktop image with PowerShell. No ISO is needed for the browser host.",
  },
  {
    name: "Windows Server 2022 (evaluation)",
    vendor: "Microsoft",
    version: "2022",
    platform: "WINDOWS",
    flavour: "winsrv-2022",
    source: "URL",
    sourceUrl: "https://example.invalid/downloads/windows-server-2022-eval.iso",
    licenseType: "EVALUATION",
    enabled: true,
    description:
      "Vendor evaluation image pulled from a URL on demand. Evaluation licenses deliberately need no key — the trial simply expires.",
  },
  {
    name: "Contoso Asset Suite",
    vendor: "Contoso",
    version: "5.2",
    platform: "WINDOWS",
    flavour: "contoso-asset",
    source: "URL",
    sourceUrl: "https://example.invalid/downloads/contoso-asset-suite.msi",
    licenseType: "LICENSED",
    licenseSeats: 45,
    enabled: true,
    description:
      "Help-desk tooling that requires a site license. Until an administrator stores the activation key, the scenario that needs it stays hidden.",
  },
  {
    name: "Office Productivity Suite",
    vendor: "OnTrak",
    version: "2024",
    platform: "OFFICE",
    flavour: "browser-office",
    source: "INTERNAL",
    licenseType: "OPEN",
    enabled: true,
    description: "The built-in spreadsheet, document and mail simulator used by Office scenarios.",
  },
];

/** A scenario that depends on software the admin has deliberately disabled. */
const MAIL_RELAY_SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "LINUX",
  engine: "bash",
  objective: "Close an open mail relay before the security review.",
  brief: `# Ticket 5612 — the relay is wide open

The security team found that this host will relay mail for anybody. postfix is
installed, but the last maintenance window left it stopped and disabled.

- Configure postfix so that it only relays for the local network (10.10.10.0/24).
- Add the relay restriction file the rest of the fleet uses.
- Start postfix again and make sure it comes back after a reboot.
- Record what you changed.`,
  tasks: [
    "Restrict mynetworks",
    "Create /etc/postfix/relay_restrictions",
    "Start postfix and enable it at boot",
    "Record a note",
  ],
  machine: {
    hostname: "relay01",
    user: "student",
    os: "Ubuntu 24.04.2 LTS",
    version: "24.04",
    kernel: "6.8.0-45-generic",
    arch: "x86_64",
  },
  files: [
    {
      path: "/home/student/README.txt",
      content: "Ticket 5612\nThe audit says this box is an open relay.\npostfix is already installed and running.\n",
    },
  ],
  state: {
    // The relay is installed but down, so getting it serving again is real work.
    services: [
      {
        name: "postfix",
        displayName: "Postfix Mail Transport Agent",
        description: "Postfix Mail Transport Agent",
        active: false,
        enabled: false,
      },
      { name: "ssh", displayName: "OpenBSD Secure Shell server", description: "OpenBSD Secure Shell server", active: true, enabled: true },
      { name: "ufw", displayName: "Uncomplicated firewall", description: "Uncomplicated firewall", active: true, enabled: true },
    ],
    packages: [
      { name: "postfix", version: "3.8.6-1build1", installed: true, description: "High-performance mail transport agent" },
      { name: "openssh-server", version: "1:9.6p1-3ubuntu13", installed: true, description: "secure shell (SSH) server" },
    ],
  },
  checks: [
    {
      id: "mynetworks",
      label: "Only the local network may relay",
      kind: "file_contains",
      path: "/etc/postfix/main.cf",
      pattern: "^mynetworks\\s*=\\s*127\\.0\\.0\\.0/8,\\s*10\\.10\\.10\\.0/24",
      flags: "m",
      points: 3,
    },
    {
      id: "restrictions-file",
      label: "Relay restriction file exists",
      kind: "file_exists",
      path: "/etc/postfix/relay_restrictions",
      points: 2,
    },
    {
      id: "restart",
      label: "postfix was brought back up after the change",
      kind: "command_matched",
      pattern: "systemctl\\s+(restart|reload|start)\\s+postfix",
      points: 2,
    },
    {
      id: "running",
      label: "postfix is running and enabled at boot",
      kind: "service_state",
      name: "postfix",
      active: true,
      enabled: true,
      points: 2,
    },
    {
      id: "note",
      label: "Recorded the change",
      kind: "note_matches",
      pattern: "relay|mynetworks|postfix",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-mynetworks", text: "Edit /etc/postfix/main.cf and set `mynetworks = 127.0.0.0/8, 10.10.10.0/24`.", penalty: 2 },
    { id: "hint-file", text: "The restrictions file is plain text: `echo ... > /etc/postfix/relay_restrictions`.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes: "Demonstrates a scenario gated behind disabled software: enable the postfix package to publish it.",
};

/** A scenario that needs software with no activation key stored yet. */
const ASSET_AUDIT_SCENARIO: ScenarioDefinition = {
  version: 1,
  platform: "WINDOWS",
  engine: "powershell",
  objective: "Reconcile this workstation against the asset inventory.",
  brief: `# Ticket 5390 — asset reconciliation

The quarterly audit needs this machine checked against the inventory.

- Windows Time has been stopped since the outage. Bring it back and make sure it
  starts on its own.
- Create a local account called \`audit\` for the visiting auditor.
- Close inbound RDP for the duration of the visit.
- Record what you changed.`,
  tasks: ["Start Windows Time", "Create the audit account", "Block inbound RDP", "Record a note"],
  machine: {
    hostname: "FIN-07",
    // Administrative work, so the session is the local Administrator — see the
    // note on `WINDOWS_TEMPLATE`.
    user: "Administrator",
    os: "Microsoft Windows 11 Pro",
    version: "10.0.22631",
    build: "22631.3155",
    arch: "64-bit",
  },
  state: {
    services: [
      {
        name: "W32Time",
        displayName: "Windows Time",
        description: "Maintains date and time synchronization",
        active: false,
        enabled: false,
        startupType: "Disabled",
      },
      {
        name: "Spooler",
        displayName: "Print Spooler",
        description: "Loads files to memory for later printing",
        active: true,
        enabled: true,
        startupType: "Automatic",
      },
      {
        name: "LanmanServer",
        displayName: "Server",
        description: "Supports file, print and named-pipe sharing",
        active: true,
        enabled: true,
        startupType: "Automatic",
      },
    ],
  },
  checks: [
    { id: "w32time", label: "Windows Time runs and starts automatically", kind: "service_state", name: "W32Time", active: true, enabled: true, points: 2 },
    { id: "audit-account", label: "The auditor account exists", kind: "user_exists", name: "audit", points: 3 },
    { id: "audit-group", label: "The auditor is a local user only", kind: "user_in_group", name: "audit", group: "Users", points: 1 },
    { id: "rdp", label: "Inbound RDP is blocked", kind: "firewall_rule", name: "Allow-RDP-TCP-In", action: "deny", points: 2 },
    {
      id: "note",
      label: "Recorded what changed",
      kind: "note_matches",
      pattern: "audit|rdp|w32time",
      flags: "i",
      points: 1,
    },
  ],
  hints: [
    { id: "hint-account", text: "`New-LocalUser -Name audit -Password \"...\"` then check it with `Get-LocalUser`.", penalty: 1 },
    { id: "hint-w32", text: "`Set-Service -Name W32Time -StartupType Automatic` and `Start-Service W32Time`.", penalty: 1 },
  ],
  allowHints: true,
  authorNotes: "Gated behind the Contoso Asset Suite license: store a key to make it visible.",
};

async function main() {
  console.log("Seeding OnTrak IT Support Training…");

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  /* ------------------------------------------------------------ platforms */
  for (const platform of ["LINUX", "WINDOWS", "OFFICE"] as Platform[]) {
    await prisma.platformToggle.upsert({
      where: { platform },
      create: { platform, enabled: true, note: null },
      update: {},
    });
  }

  /* --------------------------------------------------------------- people */
  const users: Record<string, { id: string }> = {};
  for (const person of PEOPLE) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      create: {
        name: person.name,
        email: person.email,
        passwordHash,
        role: person.role,
        accent: pickAccent(person.email),
      },
      // Rotate the password too, so changing `SEED_PASSWORD` and re-seeding
      // actually takes effect. These are demo accounts; that is the intent.
      update: { name: person.name, role: person.role, passwordHash },
    });
    users[person.email] = user;
  }

  const admin = users["admin@ontrak.local"];
  const instructor = users["instructor@ontrak.local"];
  const student = users["student@ontrak.local"];

  /* ---------------------------------------------------------- software */
  const software: Record<string, { id: string }> = {};
  for (const item of SOFTWARE) {
    const record = await prisma.softwarePackage.upsert({
      where: { name_version_platform: { name: item.name, version: item.version, platform: item.platform } },
      create: {
        name: item.name,
        vendor: item.vendor,
        version: item.version,
        platform: item.platform,
        flavour: item.flavour,
        description: item.description,
        source: item.source,
        sourceUrl: item.sourceUrl ?? null,
        licenseType: item.licenseType,
        requiresKey: item.licenseType === "LICENSED",
        licenseKey: item.licenseKey ?? null,
        licenseSeats: item.licenseSeats ?? null,
        enabled: item.enabled,
        createdById: admin.id,
      },
      update: { description: item.description, enabled: item.enabled, sourceUrl: item.sourceUrl ?? null },
    });
    software[item.name] = record;
  }

  /* ------------------------------------------------------------ scenarios */
  const scenarios: {
    definition: ScenarioDefinition;
    title: string;
    slug: string;
    difficulty: "FOUNDATION" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";
    tags: string[];
    published: boolean;
    requiredSoftware: string[];
  }[] = [
    {
      definition: TEMPLATES.LINUX,
      title: "Restore the internal wiki",
      slug: "restore-internal-wiki",
      difficulty: "FOUNDATION",
      tags: ["systemd", "nginx", "ufw", "tier1"],
      published: true,
      requiredSoftware: ["Ubuntu Server"],
    },
    {
      definition: TEMPLATES.WINDOWS,
      title: "Spooler recovery and RDP hardening",
      slug: "spooler-recovery-rdp-hardening",
      difficulty: "INTERMEDIATE",
      tags: ["powershell", "services", "firewall", "security"],
      published: true,
      requiredSoftware: ["Windows 11 Workstation"],
    },
    {
      definition: WINDOWS_DESKTOP_TEMPLATE,
      title: "Reception PC handover",
      slug: "reception-pc-handover",
      difficulty: "INTERMEDIATE",
      tags: ["desktop", "services", "windows-update", "firewall"],
      published: true,
      requiredSoftware: ["Windows 11 Workstation"],
    },
    {
      definition: WINDOWS_DESKTOP_FILES_TEMPLATE,
      title: "Stage the kiosk deployment files",
      slug: "stage-kiosk-deploy-files",
      difficulty: "FOUNDATION",
      tags: ["desktop", "file-explorer", "file-management"],
      published: true,
      requiredSoftware: ["Windows 11 Workstation"],
    },
    {
      definition: TEMPLATES.OFFICE,
      title: "Q3 budget and the finance director",
      slug: "q3-budget-finance-director",
      difficulty: "FOUNDATION",
      tags: ["spreadsheets", "email", "office"],
      published: true,
      requiredSoftware: ["Office Productivity Suite"],
    },
    {
      definition: LINUX_NETWORK_TEMPLATE,
      title: "Restore name resolution",
      slug: "restore-name-resolution",
      difficulty: "INTERMEDIATE",
      tags: ["networking", "dns", "tier1"],
      published: true,
      requiredSoftware: ["Ubuntu Server"],
    },
    {
      definition: LINUX_ACCOUNTS_TEMPLATE,
      title: "Onboard and offboard accounts",
      slug: "onboard-offboard-accounts",
      difficulty: "INTERMEDIATE",
      tags: ["accounts", "onboarding", "offboarding", "tier1"],
      published: true,
      requiredSoftware: ["Ubuntu Server"],
    },
    {
      definition: WINDOWS_ACCOUNTS_TEMPLATE,
      title: "Provision the kiosk account and share",
      slug: "provision-kiosk-account-share",
      difficulty: "INTERMEDIATE",
      tags: ["accounts", "endpoint", "smb", "powershell"],
      published: true,
      requiredSoftware: ["Windows 11 Workstation"],
    },
    {
      definition: OFFICE_TRIAGE_TEMPLATE,
      title: "First-line mailbox triage",
      slug: "first-line-mailbox-triage",
      difficulty: "FOUNDATION",
      tags: ["service-desk", "email", "triage", "tier1"],
      published: true,
      requiredSoftware: ["Office Productivity Suite"],
    },
    {
      definition: MAIL_RELAY_SCENARIO,
      title: "Close an open mail relay",
      slug: "close-open-mail-relay",
      difficulty: "ADVANCED",
      tags: ["postfix", "security", "mail", "tier2"],
      published: true,
      requiredSoftware: ["Ubuntu Server", "postfix"],
    },
    {
      definition: ASSET_AUDIT_SCENARIO,
      title: "Asset reconciliation visit",
      slug: "asset-reconciliation-visit",
      difficulty: "INTERMEDIATE",
      tags: ["accounts", "audit", "powershell"],
      published: true,
      requiredSoftware: ["Windows 11 Workstation", "Contoso Asset Suite"],
    },
  ];

  const savedScenarios: Record<string, { id: string }> = {};

  for (const entry of scenarios) {
    const validation = validateDefinition(entry.definition);
    if (!validation.ok) {
      const problems = validation.issues.filter((issue) => issue.level === "error").map((issue) => issue.message);
      throw new Error(`Seed scenario "${entry.title}" is invalid: ${problems.join("; ")}`);
    }
    for (const warning of validation.issues.filter((issue) => issue.level === "warning")) {
      console.warn(`  · warning in "${entry.title}": ${warning.message}`);
    }

    const record = await prisma.scenario.upsert({
      where: { slug: entry.slug },
      create: {
        slug: entry.slug,
        title: entry.title,
        summary: entry.definition.objective,
        description: entry.definition.brief,
        platform: entry.definition.platform,
        engine: entry.definition.engine,
        difficulty: entry.difficulty,
        timeLimitSec: entry.slug.includes("relay") ? 2400 : 1800,
        passScore: 70,
        published: entry.published,
        tags: entry.tags,
        definition: entry.definition as unknown as object,
        authorId: instructor.id,
      },
      update: {
        title: entry.title,
        summary: entry.definition.objective,
        description: entry.definition.brief,
        platform: entry.definition.platform,
        engine: entry.definition.engine,
        difficulty: entry.difficulty,
        tags: entry.tags,
        definition: entry.definition as unknown as object,
        published: entry.published,
      },
    });
    savedScenarios[entry.slug] = record;

    await prisma.scenarioSoftware.deleteMany({ where: { scenarioId: record.id } });
    for (const name of entry.requiredSoftware) {
      const pkg = software[name];
      if (!pkg) continue;
      await prisma.scenarioSoftware.create({
        data: { scenarioId: record.id, softwarePackageId: pkg.id, required: true },
      });
    }
  }

  /* --------------------------------------------------------------- classes */
  // The class is repaired, not just renamed: a demo database outlives a change
  // of demo accounts, and a class left owned by an account nobody signs in as is
  // a class its instructor cannot see. Re-seeding puts it back under the
  // instructor it belongs to.
  const cohort = await prisma.cohort.upsert({
    where: { joinCode: "NET101" },
    create: {
      name: "Networking 101 — Autumn",
      description: "Tuesday afternoons, lab 3. First-line support fundamentals.",
      joinCode: "NET101",
      instructorId: instructor.id,
    },
    update: { name: "Networking 101 — Autumn", instructorId: instructor.id },
  });

  for (const email of ["student@ontrak.local", "katherine@ontrak.local", "linus@ontrak.local"]) {
    const member = users[email];
    if (!member) continue;
    await prisma.cohortMember
      .upsert({
        where: { cohortId_userId: { cohortId: cohort.id, userId: member.id } },
        create: { cohortId: cohort.id, userId: member.id },
        update: {},
      })
      .catch(() => undefined);
  }

  /* ----------------------------------------------------------- assignments */
  const wiki = savedScenarios["restore-internal-wiki"];
  const spooler = savedScenarios["spooler-recovery-rdp-hardening"];

  // Keyed on what an assignment *is* — this scenario, for this class or this
  // student — rather than on who happened to create it. "Any assignment by this
  // instructor" reads as "none" after a change of demo accounts, and re-seeding
  // then stacks duplicates instead of converging.
  async function assignOnce(where: { scenarioId: string; cohortId?: string; studentId?: string }) {
    const existing = await prisma.assignment.findFirst({ where });
    if (existing) {
      await prisma.assignment.update({ where: { id: existing.id }, data: { createdById: instructor.id } });
      return;
    }
    await prisma.assignment.create({
      data: {
        ...where,
        maxAttempts: where.studentId ? 0 : 3,
        dueAt: where.cohortId ? new Date(Date.now() + 7 * 24 * 3600 * 1000) : null,
        instructions: where.cohortId
          ? "Work through it once with hints off, then again if you need to. Bring questions on Tuesday."
          : null,
        createdById: instructor.id,
      },
    });
  }

  if (wiki) await assignOnce({ scenarioId: wiki.id, cohortId: cohort.id });
  if (spooler && student) await assignOnce({ scenarioId: spooler.id, studentId: student.id });

  /* ------------------------------------------------ one finished pass, demoed */
  // A certificate is only worth auditing on a real page, and a fresh lab has no
  // finished attempt at all — so the demo student gets one here. The attempt
  // earns every check but the last, which is what a realistic submission looks
  // like: a solid pass, with something still missed on the report.
  const triage = savedScenarios["first-line-mailbox-triage"];
  const demoAttemptId = "seed-attempt-office-triage";
  if (triage && student) {
    const scenario = await prisma.scenario.findUniqueOrThrow({ where: { id: triage.id } });
    const definition = scenario.definition as unknown as ScenarioDefinition;
    const checks = definition.checks ?? [];
    const maxScore = checks.reduce((total, check) => total + (check.points ?? 1), 0);
    const passMarkPoints = Math.ceil((maxScore * scenario.passScore) / 100);
    const lastPoints = checks.length > 0 ? (checks[checks.length - 1].points ?? 1) : 0;
    // Unless that last check is worth so much that missing it would fail the
    // scenario — in which case earn it, because the point here is a pass.
    const missLast = checks.length > 1 && maxScore - lastPoints >= passMarkPoints;

    const results = checks.map((check, index) => {
      const points = check.points ?? 1;
      const passed = !missLast || index < checks.length - 1;
      return {
        checkId: check.id,
        label: check.label,
        passed,
        points: passed ? points : 0,
        maxPoints: points,
        detail: passed
          ? (check.successDetail ?? "Confirmed in the submitted state.")
          : (check.failureDetail ?? "Not found in the submitted state."),
      };
    });
    const score = results.reduce((total, result) => total + result.points, 0);

    const gradedAt = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const startedAt = new Date(gradedAt.getTime() - 19 * 60 * 1000);
    const learnerName = PEOPLE.find((person) => person.email === "student@ontrak.local")?.name ?? "Demo student";
    const certificate = certificateForAttempt({
      learnerId: student.id,
      learnerName,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      platform: scenario.platform,
      score,
      maxScore,
      passScore: scenario.passScore,
      completedAt: gradedAt,
      skills: scenario.tags,
    });
    const record = certificate as unknown as Prisma.InputJsonValue;

    // Idempotent by id: the check results are replaced rather than appended, so
    // re-seeding repairs the row instead of stacking duplicates.
    await prisma.checkResult.deleteMany({ where: { attemptId: demoAttemptId } });
    await prisma.attempt.upsert({
      where: { id: demoAttemptId },
      create: {
        id: demoAttemptId,
        userId: student.id,
        scenarioId: scenario.id,
        status: "GRADED",
        startedAt,
        expiresAt: new Date(startedAt.getTime() + scenario.timeLimitSec * 1000),
        submittedAt: gradedAt,
        gradedAt,
        timeSpentSec: 1_140,
        score,
        maxScore,
        seed: "seed-office-triage",
        certificate: record,
        certificateIssuedAt: gradedAt,
        certificateRevokedAt: null,
        checkResults: { create: results },
      },
      update: {
        status: "GRADED",
        submittedAt: gradedAt,
        gradedAt,
        score,
        maxScore,
        certificate: record,
        certificateIssuedAt: gradedAt,
        certificateRevokedAt: null,
        checkResults: { create: results },
      },
    });
    console.log(`  Demo certificate: ${scenario.title} — ${score}/${maxScore} for ${learnerName}.`);
  }

  /* ------------------------------------------------------------- settings */
  await prisma.setting.upsert({
    where: { key: "seed.version" },
    create: { key: "seed.version", value: { version: 1, seededAt: new Date().toISOString() } },
    update: { value: { version: 1, seededAt: new Date().toISOString() } },
  });

  console.log("\nSeed complete.\n");
  console.log("  Sign in with:");
  console.log(`    administrator  admin@ontrak.local       / ${DEMO_PASSWORD}`);
  console.log(`    instructor     instructor@ontrak.local  / ${DEMO_PASSWORD}`);
  console.log(`    student        student@ontrak.local     / ${DEMO_PASSWORD}`);
  console.log("\n  Student join code for the demo class: NET101");
  console.log("  Note: \"Close an open mail relay\" is deliberately blocked until the");
  console.log("        postfix package is enabled, and \"Asset reconciliation visit\"");
  console.log("        until the Contoso Asset Suite key is stored.");
  console.log("  Try: \"Reception PC handover\" opens on the clickable Windows desktop.\n");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
