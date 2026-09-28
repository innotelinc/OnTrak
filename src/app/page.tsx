import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge, ButtonLink, Card } from "@/components/ui";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "OnTrak IT Support Training";

const FEATURES = [
  {
    tone: "brand",
    title: "Real terminals, no installs",
    body: "Students get an Ubuntu-style bash prompt and a Windows PowerShell host in the browser. Nothing to download, nothing to patch, nothing to break.",
    icon: "M4 6h16v12H4zM8 10l2 2-2 2M13 14h3",
  },
  {
    tone: "pink",
    title: "Graded automatically",
    body: "Every scenario declares what success looks like: a service enabled, a key in the registry, a formula in the right cell. Scores land the moment the student submits.",
    icon: "M5 13l4 4L19 7",
  },
  {
    tone: "amber",
    title: "Timed like a real shift",
    body: "Countdowns per scenario, auto-submit on expiry, and a time-served figure for every attempt so instructors see who froze and who flew.",
    icon: "M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  },
  {
    tone: "teal",
    title: "Works on a phone",
    body: "Installable as a PWA with touch-friendly terminal keys. Students can work a ticket on the bus — graders do not care what screen they used.",
    icon: "M7 4h10v16H7zM11 18h2",
  },
  {
    tone: "sky",
    title: "Software you control",
    body: "Administrators enable or disable each operating system and application, upload a package or point at a vendor URL, and store activation keys when a license needs one.",
    icon: "M12 3l8 4v6c0 4-3.4 7-8 8-4.6-1-8-4-8-8V7z",
  },
  {
    tone: "lime",
    title: "Only what you provision",
    body: "Scenarios unlock solely from the software you have actually made available. If a required package is missing, disabled or unlicensed, the scenario stays hidden with a clear reason.",
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

const ROLES = [
  {
    tone: "teal",
    role: "Student",
    points: ["Browse scenarios you are cleared to run", "Work the ticket in a live console", "Spend hints when stuck, see your score instantly"],
  },
  {
    tone: "brand",
    role: "Instructor",
    points: ["Author and publish scenarios", "Hand them to a class or one student", "Review every attempt, check by check"],
  },
  {
    tone: "pink",
    role: "Administrator",
    points: ["Switch whole operating systems on or off", "Upload software or pull it from a URL", "Store license keys, manage staff accounts"],
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
          <a href="#how" className="transition hover:text-brand">How it works</a>
          <a href="#roles" className="transition hover:text-brand">Roles</a>
          <a href="#opensource" className="transition hover:text-brand">Open source</a>
        </nav>
        <div className="flex items-center gap-2.5">
          <ThemeToggle />
          <ButtonLink href="/login" variant="secondary" size="sm" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink href={selfRegistration ? "/register" : "/login"} size="sm">
            {selfRegistration ? "Start free" : "Sign in"}
          </ButtonLink>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      <section className="relative z-10 mx-auto max-w-7xl px-5 pt-10 pb-20">
        <div className="grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
          <div className="animate-rise">
            <Badge tone="brand" className="mb-5">
              <span className="inline-flex size-1.5 animate-pulse rounded-full bg-brand" />
              Open source · self-hosted · MIT licensed
            </Badge>

            <h1 className="font-display text-4xl leading-[1.05] font-semibold text-balance text-ink sm:text-5xl lg:text-6xl">
              Train real IT support skills in the{" "}
              <span className="text-gradient">browser</span>.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-soft sm:text-lg">
              {appName} drops students into a working Linux server, a Windows workstation or an
              Office suite. They work the ticket, the clock ticks, and the platform grades every
              step — on a laptop or on a phone.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href={selfRegistration ? "/register" : "/login"} size="lg">
                {selfRegistration ? "Create a student account" : "Sign in to train"}
                <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </ButtonLink>
              <ButtonLink href="/login" variant="secondary" size="lg">
                Instructor &amp; admin sign in
              </ButtonLink>
            </div>

            <dl className="mt-10 grid max-w-lg grid-cols-3 gap-4">
              {[
                { k: "3", v: "simulation surfaces" },
                { k: "0", v: "installs for students" },
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
      <section id="how" className="relative z-10 mx-auto max-w-7xl px-5 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-display text-xs font-semibold tracking-[0.2em] text-brand uppercase">Built for the classroom</p>
          <h2 className="mt-2 font-display text-3xl font-semibold text-balance text-ink sm:text-4xl">
            Everything a technician needs to practice, nothing they can break
          </h2>
          <p className="mt-3 text-ink-soft">
            Scenarios are little machines. They boot in milliseconds, they grade themselves, and a
            student can retry a hundred times without an instructor lifting a finger.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, index) => (
            <Card
              key={feature.title}
              className="animate-rise transition-transform duration-300 hover:-translate-y-1"
              style={{ animationDelay: `${index * 55}ms` }}
            >
              <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <svg viewBox="0 0 24 24" className="size-5.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d={feature.icon} />
                </svg>
              </span>
              <h3 className="mt-4 font-display text-lg font-semibold text-ink">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{feature.body}</p>
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
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {PLATFORMS.map((platform) => (
            <Card key={platform.name} className="flex flex-col overflow-hidden p-0">
              <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-5">
                <div>
                  <h3 className="font-display text-xl font-semibold text-ink">{platform.name}</h3>
                  <p className="mt-0.5 font-mono text-[11px] tracking-wide text-ink-faint uppercase">{platform.stack}</p>
                </div>
                <Badge tone={platform.tone as "amber" | "sky" | "pink"}>Simulated</Badge>
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

      {/* ------------------------------------------------------------------ */}
      <section id="opensource" className="relative z-10 mx-auto max-w-7xl px-5 py-16">
        <Card className="relative overflow-hidden border-transparent p-0">
          <div className="grid-lines absolute inset-0 opacity-40" aria-hidden />
          <div className="relative grid gap-10 p-8 sm:p-12 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <Badge tone="brand">MIT licensed</Badge>
              <h2 className="mt-4 font-display text-3xl font-semibold text-balance text-ink sm:text-4xl">
                Run it on your own hardware, on your own terms
              </h2>
              <p className="mt-3 max-w-xl text-ink-soft">
                Clone the repository, point it at a PostgreSQL database and you are teaching.
                Software packages and license keys never leave your network, and the whole
                simulation engine runs without virtual machines.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <ButtonLink href="/register" size="lg">Get started</ButtonLink>
                <ButtonLink href="/login" variant="secondary" size="lg">I already have an account</ButtonLink>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl2 border border-line bg-[#141029]">
              <div className="border-b border-white/8 px-4 py-2.5 font-mono text-[11px] text-white/50">terminal</div>
              <pre tabIndex={0} className="overflow-x-auto px-5 py-4 font-mono text-[12px] leading-relaxed text-[#cfc8ff]">
{`git clone <your-fork> ontrak-it-support-training
cd ontrak-it-support-training
cp .env.example .env
npm install
npm run docker:db    # PostgreSQL 16
npm run setup        # schema + demo data
npm run dev`}
              </pre>
            </div>
          </div>
        </Card>
      </section>

      <footer className="relative z-10 mx-auto max-w-7xl px-5 py-12">
        <div className="flex flex-col items-center justify-between gap-5 border-t border-line pt-8 sm:flex-row">
          <Logo subtitle="IT support training" />
          <p className="text-center text-xs text-ink-faint sm:text-right">
            {appName} — open source IT support training.
            <br />
            Built with Next.js, Prisma and a simulation engine that runs anywhere.
          </p>
        </div>
      </footer>
    </div>
  );
}
