import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge, ButtonLink, Card } from "@/components/ui";

/**
 * The range's front page.
 *
 * WHAT THIS PAGE IS FOR. A product page has one job: say what the product is, who it is
 * for, and how somebody gets in. Everything else — the licence, the repository, the
 * install steps — belongs in the repository, where the person who needs it is already
 * looking. This page used to carry all of that anyway: a "MIT licensed" badge, a
 * `git clone` card, a footer about Next.js. It sold the software instead of the
 * training, and it told a college the opposite of what it needed to hear — that this is
 * a hobby somebody runs at home, when what it actually is is a product of the OnTrak
 * Network with an identity provider, a real-machine lab beside it and certificates that
 * come out signed.
 *
 * AND HOW SOMEBODY GETS IN. OnTrak ITS is an entitlement of AthenIQ: the learning
 * platform is where a learner enrolls, and enrollment is what grants the range. It is also
 * included with an OnTrak Network subscription, and it can be reached on its own through
 * a one-time purchase or a time-boxed pass, or by an instructor's invitation. Those are
 * the two entry points — AthenIQ or OnTrak — and this page states both rather than
 * pretending the only door is a self-service sign-up.
 */

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "OnTrak IT Support Training";

const CAPABILITIES = [
  {
    tone: "brand",
    title: "Real terminals, no installs",
    body: "A student gets an Ubuntu-style bash prompt, a Windows PowerShell host and an Office desk in the browser. Nothing to download, nothing to patch, nothing on the network to ruin.",
    icon: "M4 6h16v12H4zM8 10l2 2-2 2M13 14h3",
  },
  {
    tone: "sky",
    title: "Real machines when it has to be real",
    body: "OnTrak Lab runs the same scenario on a living virtual machine — a guest that boots, serves and breaks for real — and the lab grades it. Simulation for practice, machines for proof.",
    icon: "M5 5h14v9H5zM9 18h6M12 14v4",
  },
  {
    tone: "pink",
    title: "Graded automatically",
    body: "Every scenario declares what success looks like: a service enabled, a key in the registry, a formula in the right cell. Scores land the moment the student submits, and a re-grade never rewrites the evidence.",
    icon: "M5 13l4 4L19 7",
  },
  {
    tone: "amber",
    title: "Timed like a real shift",
    body: "Countdowns per scenario, auto-submit on expiry, and a time-served figure for every attempt — so an instructor sees who froze and who flew.",
    icon: "M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  },
  {
    tone: "teal",
    title: "Certificates the platform stands behind",
    body: "Clearing the pass mark earns a completion record with a code anybody can verify. Certificates are issued through AthenIQ, signed through Signara and stored on Onyx — so the evidence outlives the attempt that produced it.",
    icon: "M12 3l8 4v6c0 4-3.4 7-8 8-4.6-1-8-4-8-8V7z",
  },
  {
    tone: "lime",
    title: "Only what you provision",
    body: "Scenarios unlock solely from the software an administrator has actually made available. If a required package is missing, disabled or unlicensed, the scenario stays hidden with a clear reason.",
    icon: "M4 7h16M4 12h10M4 17h7",
  },
];

const PLATFORMS = [
  {
    tone: "amber",
    name: "Linux",
    stack: "bash · systemd · apt · ufw",
    blurb: "Files and permissions, user administration, service recovery, logs, package management and firewall work.",
    sample: [
      "student@server01:~$ sudo systemctl enable --now nginx",
      "student@server01:~$ sudo ufw allow 443/tcp",
      "student@server01:~$ curl -I http://localhost",
    ],
  },
  {
    tone: "sky",
    name: "Windows",
    stack: "PowerShell · services · registry",
    blurb: "Service triage, local accounts and groups, registry policies, firewall rules, SMB shares and event log forensics.",
    sample: [
      "PS C:\\Users\\student> Get-Service Spooler",
      "PS C:\\Users\\student> Set-Service -Name Spooler -StartupType Automatic",
      "PS C:\\Users\\student> New-NetFirewallRule -DisplayName \"Allow HTTPS\" -LocalPort 443",
    ],
  },
  {
    tone: "pink",
    name: "Office",
    stack: "spreadsheets · documents · mail",
    blurb: "The paperwork half of the job: fix a broken budget formula, correct a policy document, triage and route a mailbox.",
    sample: [
      "Q3 Budget.xlsx> formula C4 =SUM(C2:C3)",
      "Q3 Budget.xlsx> format C2:C4 currency",
      "Inbox> mail flag M1002",
    ],
  },
];

/**
 * The two entry points, and the two smaller doors beside them.
 *
 * The first two are the entitlement itself — AthenIQ enrollment, or the OnTrak Network
 * subscription that already includes every product a role belongs in. The third is the
 * one somebody arrives through on their own: a pass, a single purchase, or an
 * instructor's invitation. They are stated together because a page that names only one
 * of them makes a prospect ask whether they are allowed to be here.
 */
const ACCESS = [
  {
    tone: "brand",
    title: "Enrolled at AthenIQ",
    body: "Enroll on a course at AthenIQ and this range comes with it. AthenIQ issues the certificate at the end, which is why enrollment is the door that matters.",
    href: "https://atheniq.innotel.us",
    link: "Go to AthenIQ",
  },
  {
    tone: "sky",
    title: "An OnTrak Network subscription",
    body: "The same subscription that includes the desk, the operations view, the coding console and the lab. One Cerulean sign-in, and every product your role belongs in.",
    href: "#",
    link: null,
  },
  {
    tone: "amber",
    title: "A pass, a purchase or an invitation",
    body: "Buy a single seat or a time-boxed pass, or accept an invitation from an instructor. Same range, same attempts, same certificate.",
    href: "#",
    link: null,
  },
];

const ROLES = [
  {
    tone: "teal",
    role: "Student",
    points: [
      "Browse the scenarios you are cleared to run",
      "Work the ticket in a simulated console or a real machine",
      "Spend hints when stuck, see your score instantly",
    ],
  },
  {
    tone: "brand",
    role: "Instructor",
    points: [
      "Author and publish scenarios from a starter template",
      "Hand them to a class or to one student, with deadlines",
      "Review every attempt, check by check, and re-grade after a fix",
    ],
  },
  {
    tone: "pink",
    role: "Administrator",
    points: [
      "Switch whole operating systems and surfaces on or off",
      "Upload software or pull it from a vendor URL",
      "Store license keys, manage accounts, read the audit log",
    ],
  },
];

export default function LandingPage() {
  const selfRegistration = (process.env.NEXT_PUBLIC_ALLOW_SELF_REGISTRATION ?? "true") !== "false";

  return (
    <div className="relative min-h-dvh overflow-x-hidden">
      <div className="mesh-bg pointer-events-none absolute inset-x-0 top-0 h-[720px] opacity-80" aria-hidden />

      <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between px-5 py-5">
        <Logo subtitle="IT support training" />
        <nav className="hidden items-center gap-7 text-sm font-medium text-ink-soft md:flex">
          <a href="#platforms" className="transition hover:text-brand">Platforms</a>
          <a href="#capabilities" className="transition hover:text-brand">Capabilities</a>
          <a href="#access" className="transition hover:text-brand">Access</a>
          <a href="#roles" className="transition hover:text-brand">Roles</a>
        </nav>
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <ButtonLink href="/login" variant="secondary" size="sm" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink href={selfRegistration ? "/register" : "/login"} size="sm">
            {selfRegistration ? "Enroll" : "Sign in"}
          </ButtonLink>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      <section className="relative z-10 mx-auto max-w-7xl px-5 pt-10 pb-20">
        <div className="grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
          <div className="animate-rise">
            <Badge tone="brand" className="mb-5">
              <span className="inline-flex size-1.5 animate-pulse rounded-full bg-brand" />
              An entitlement of AthenIQ · part of the OnTrak Network
            </Badge>

            <h1 className="font-display text-4xl leading-[1.05] font-semibold text-balance text-ink sm:text-5xl lg:text-6xl">
              Train the support desk on machines that{" "}
              <span className="text-gradient">break safely</span>.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-soft sm:text-lg">
              {appName} drops a student into a working Linux server, a Windows workstation or an
              Office desk — and, through OnTrak Lab, onto a real virtual machine. They work the
              ticket, the clock runs, and every step is graded. No installs, no lab full of
              hardware, no way to break anything that matters.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href={selfRegistration ? "/register" : "/login"} size="lg">
                {selfRegistration ? "Enroll" : "Sign in to train"}
                <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </ButtonLink>
              <ButtonLink href="/login" variant="secondary" size="lg">
                Instructor &amp; admin sign in
              </ButtonLink>
            </div>

            <p className="mt-4 max-w-xl text-sm text-ink-faint">
              Enrollment is through AthenIQ, which is also where a course completion becomes a
              signed certificate. On an OnTrak Network subscription your existing Cerulean account
              already opens this range — see{" "}
              <a href="#access" className="font-medium text-brand hover:underline">how access works</a>.
            </p>

            <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4">
              {[
                { k: "3", v: "simulated surfaces" },
                { k: "1", v: "real-machine lab" },
                { k: "∞", v: "attempts to practice" },
              ].map((item) => (
                <div key={item.v}>
                  <dt className="font-display text-3xl font-semibold text-brand">{item.k}</dt>
                  <dd className="text-xs font-medium tracking-wide text-ink-faint uppercase">{item.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Mock console */}
          <div className="animate-rise [animation-delay:120ms]">
            <div className="relative">
              <div className="absolute -inset-4 -z-10 rounded-[2rem] gradient-brand opacity-20 blur-2xl" aria-hidden />
              <div className="overflow-hidden rounded-xl3 border border-line bg-[#141029] shadow-lift">
                <div className="flex items-center gap-2 border-b border-white/8 bg-white/4 px-4 py-3">
                  <span className="size-3 rounded-full bg-[#ff5f57]" />
                  <span className="size-3 rounded-full bg-[#febc2e]" />
                  <span className="size-3 rounded-full bg-[#28c840]" />
                  <span className="ml-3 font-mono text-xs text-white/60">student@server01 — ticket #4471</span>
                  <span className="ml-auto rounded-full bg-white/10 px-2.5 py-1 font-mono text-[11px] text-white/80">18:42</span>
                </div>
                <pre tabIndex={0} className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-relaxed text-[#d6d0ff]">
{`student@server01:~$ systemctl status nginx
● nginx.service - A high performance web server
     Active: inactive (dead)

student@server01:~$ sudo systemctl enable --now nginx
Created symlink /etc/systemd/system/multi-user.target
  .wants/nginx.service → /lib/systemd/system/nginx.service

student@server01:~$ curl -I http://localhost
HTTP/1.1 200 OK
Server: nginx/1.24.0           `}
                  <span className="animate-pulse text-[#9b83ff]">▌</span>
                </pre>
                <div className="flex flex-wrap items-center gap-2 border-t border-white/8 bg-white/4 px-4 py-3 text-[11px]">
                  <span className="rounded-full bg-[#10b4a4]/25 px-2.5 py-1 font-semibold text-[#5fe3d3]">✓ nginx enabled</span>
                  <span className="rounded-full bg-[#10b4a4]/25 px-2.5 py-1 font-semibold text-[#5fe3d3]">✓ serves on port 80</span>
                  <span className="rounded-full bg-white/10 px-2.5 py-1 font-semibold text-white/70">○ firewall rule pending</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="capabilities" className="relative z-10 mx-auto max-w-7xl px-5 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-display text-xs font-semibold tracking-[0.2em] text-brand uppercase">Built for the classroom</p>
          <h2 className="mt-2 font-display text-3xl font-semibold text-balance text-ink sm:text-4xl">
            Everything a technician needs to practice, nothing they can break
          </h2>
          <p className="mt-3 text-ink-soft">
            Scenarios are little machines. They boot in milliseconds, they grade themselves, and a
            student can retry a hundred times without an instructor lifting a finger — with a real
            virtual machine available the moment a task has to be real.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((capability, index) => (
            <Card
              key={capability.title}
              className="animate-rise transition-transform duration-300 hover:-translate-y-1"
              style={{ animationDelay: `${index * 55}ms` }}
            >
              <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d={capability.icon} />
                </svg>
              </span>
              <h3 className="mt-4 font-display text-lg font-semibold text-ink">{capability.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{capability.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="platforms" className="relative z-10 mx-auto max-w-7xl px-5 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-display text-xs font-semibold tracking-[0.2em] text-pink uppercase">Three surfaces</p>
          <h2 className="mt-2 font-display text-3xl font-semibold text-balance text-ink sm:text-4xl">
            Linux, Windows and Office — graded the same way
          </h2>
          <p className="mt-3 text-ink-soft">
            Any of them can also be run on a real machine in OnTrak Lab, where the guest is a guest
            and the lab grades what the student actually did to it.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {PLATFORMS.map((platform) => (
            <Card key={platform.name} className="flex flex-col overflow-hidden p-0">
              <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-5">
                <div>
                  <h3 className="font-display text-xl font-semibold text-ink">{platform.name}</h3>
                  <p className="mt-0.5 font-mono text-[11px] tracking-wide text-ink-faint uppercase">{platform.stack}</p>
                </div>
                <Badge tone={platform.tone as "amber" | "sky" | "pink"}>Simulated or real</Badge>
              </div>
              <p className="px-6 py-5 text-sm leading-relaxed text-ink-soft">{platform.blurb}</p>
              <pre tabIndex={0} className="mt-auto overflow-x-auto border-t border-line bg-[#141029] px-6 py-4 font-mono text-[11.5px] leading-relaxed text-[#cfc8ff]">
                {platform.sample.join("\n")}
              </pre>
            </Card>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="access" className="relative z-10 mx-auto max-w-7xl px-5 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-display text-xs font-semibold tracking-[0.2em] text-teal uppercase">Access</p>
          <h2 className="mt-2 font-display text-3xl font-semibold text-balance text-ink sm:text-4xl">
            Two ways in, and neither of them is a purchase order
          </h2>
          <p className="mt-3 text-ink-soft">
            {appName} is owned by OnTrak and entitled through AthenIQ — the learning platform whose
            courses it serves. That is the arrangement to understand before choosing a door:
            enrollment is what grants the range, and the certificate at the end is issued there.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {ACCESS.map((entry) => (
            <Card key={entry.title} className="relative flex flex-col overflow-hidden">
              <span className="absolute -top-10 -right-10 size-32 rounded-full gradient-brand opacity-10" aria-hidden />
              <Badge tone={entry.tone as "brand" | "sky" | "amber"}>{entry.title}</Badge>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-ink-soft">{entry.body}</p>
              {entry.link ? (
                <a href={entry.href} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline">
                  {entry.link}
                  <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </a>
              ) : (
                <span className="mt-5 text-sm font-medium text-ink-faint">
                  Ask your OnTrak contact, or sign in with your Cerulean account.
                </span>
              )}
            </Card>
          ))}
        </div>

        <Card className="relative mt-6 overflow-hidden border-transparent p-0">
          <div className="grid-lines absolute inset-0 rounded-xl3 opacity-40" aria-hidden />
          <div className="relative flex flex-col items-start gap-6 p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div className="max-w-2xl">
              <h3 className="font-display text-2xl font-semibold text-balance text-ink">
                Enroll once, and every surface the course needs is already provisioned
              </h3>
              <p className="mt-2 text-sm text-ink-soft">
                A student signs in with their Cerulean account, lands in their queue, and starts the
                ticket their instructor set. Instructors and administrators sign in the same way —
                the range decides what a role may do from the identity, never from a second
                password.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-3">
              {/* One CTA, not two: when self-registration is switched off for a
                  deployment this button says "Sign in" as well, and two identical
                  buttons side by side is how a page looks broken. */}
              <ButtonLink href={selfRegistration ? "/register" : "/login"} size="lg">
                {selfRegistration ? "Enroll" : "Sign in"}
              </ButtonLink>
              <ButtonLink href="#platforms" variant="secondary" size="lg">
                See what they run
              </ButtonLink>
            </div>
          </div>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section id="roles" className="relative z-10 mx-auto max-w-7xl px-5 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-display text-xs font-semibold tracking-[0.2em] text-teal uppercase">One platform, three hats</p>
          <h2 className="mt-2 font-display text-3xl font-semibold text-balance text-ink sm:text-4xl">
            Students practice, instructors assign, admins provision
          </h2>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {ROLES.map((role) => (
            <Card key={role.role} className="relative overflow-hidden">
              <span className="absolute -top-10 -right-10 size-32 rounded-full gradient-brand opacity-10" aria-hidden />
              <Badge tone={role.tone as "teal" | "brand" | "pink"}>{role.role}</Badge>
              <ul className="mt-5 space-y-3">
                {role.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm text-ink-soft">
                    <svg viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-brand" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                    {point}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      <footer className="relative z-10 mx-auto max-w-7xl px-5 py-12">
        <div className="flex flex-col items-center justify-between gap-5 border-t border-line pt-8 sm:flex-row">
          <Logo subtitle="IT support training" />
          <p className="text-center text-xs text-ink-faint sm:text-right">
            {appName} — a product of the OnTrak Network, operated by Innotel.
            <br />
            Enrollment, completion records and certificates are issued through AthenIQ.
          </p>
        </div>
      </footer>
    </div>
  );
}
