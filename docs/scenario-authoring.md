# Authoring scenarios

A **scenario** is a JSON document (`ScenarioDefinition`) that describes a starting
machine, the work a student should do, and the checks that award points. The
simulator boots the definition in the browser, the student works the ticket, and
the grader scores the resulting machine state.

You can author scenarios in the instructor UI (`/instructor/scenarios/new`), or
write them directly and load them through `prisma/seed.ts`. The instructor editor
ships a **validator** — use it. It catches almost every mistake described below
before a student ever sees the scenario.

---

## Skeleton

```jsonc
{
  "version": 1,
  "platform": "LINUX",            // LINUX | WINDOWS | OFFICE
  "engine": "bash",               // must match the platform (see below)
  "objective": "One-line goal shown in the console header.",
  "brief": "# Ticket 4471 — the wiki is down\n\nMarkdown briefing.",
  "tasks": ["Start nginx", "Allow HTTP", "Record a note"],
  "machine": { "hostname": "wiki01", "user": "student", "os": "Ubuntu 24.04.2 LTS", "version": "24.04" },
  "files":   [ /* files that exist before the student touches anything */ ],
  "state":   { /* non-filesystem starting conditions */ },
  "docs":    [ /* Office documents (OFFICE platform only) */ ],
  "checks":  [ /* what earns points */ ],
  "hints":   [ /* optional, each with a points penalty */ ],
  "allowHints": true,
  "authorNotes": "Instructor-facing only. Never sent to the student."
}
```

### Platform ↔ engine

| `platform` | `engine`     | Console | Desktop |
| ---------- | ------------ | ------- | ------- |
| `LINUX`    | `bash`       | Linux shell | — |
| `WINDOWS`  | `powershell` | PowerShell | Windows 11 desktop |
| `OFFICE`   | `office`     | Spreadsheet / document / mail panels | — |

The validator rejects a mismatched pair.

### The Windows desktop surface

Add `"surface": "desktop"` to a Windows scenario and the student opens on a
clickable Windows 11 desktop — Start menu, taskbar, File Explorer, Services,
Windows Update, Windows Security, Event Viewer, Task Manager, User Accounts and
Case Notes — with the PowerShell console on the next tab.

The desktop is only a view. Every button sends the same cmdlet a technician
would have typed (`Start-Service`, `Set-ItemProperty`, `New-NetFirewallRule`,
`New-Item`, `Rename-Item`, `Move-Item`, `note`), so checks, hints and grading do
not change, and a student can mix clicking and typing freely. App windows drag
by their title bar and resize from the corner on a screen wide enough for a
mouse. File Explorer can create folders and files, rename items, and move a
file between folders with Cut then Paste, and opening a file goes to the same
editor the console uses — so file work grades with `file_exists`, `file_absent`,
`dir_exists` and `file_contains` exactly as on the console.

On a wide screen the checklist and hints sit in a column beside the desktop, so
the student can read the tasks while clicking through the apps.
`"surface": "console"` is the default, and the validator rejects `surface` on
any platform that has no desktop.

### `machine`

`hostname`, `user`, `os`, `version` are required; `kernel`, `build`, `arch` and
`domain` are optional and only surface in `uname` / `systeminfo` style output.

On Windows, `user` is the account the session runs as, and it decides whether
the driver allows machine-wide changes: the PowerShell driver refuses
`Start-Service`, `Set-Service`, `Set-ItemProperty`, `New-NetFirewallRule` and
friends to a standard account, so a ticket that depends on them has to sign in
as `Administrator` — otherwise it can never be finished. The signed-in account
also gets its own profile (`C:\Users\<user>`), which is where the session and the
desktop's file explorer start.

---

## Seeding the starting state

### `files`

An array of nodes. A node with `content` is a file; add `children` for a
directory.

```jsonc
"files": [
  { "path": "/home/student/README.txt", "content": "Ticket 4471\n" },
  { "path": "/var/log/nginx/error.log", "content": "...", "mode": "0644", "owner": "root", "group": "adm" }
]
```

### `state`

Everything else the machine starts with:

| Key | Shape | Used for |
| --- | ----- | -------- |
| `users` | `{ name, fullName?, home?, shell?, uid?, groups?[] }[]` | Local accounts (`useradd`, `New-LocalUser`). |
| `services` | `{ name, displayName, description, active, enabled, startupType }[]` | `systemctl`, `Get-Service`. |
| `processes` | `{ pid, name, user, cpu, mem }[]` | `ps`, `Get-Process`. |
| `packages` | `{ name, version, installed }[]` | `apt`, `dpkg`. |
| `cron` | `{ schedule, user, command }[]` | `crontab -l`. |
| `firewall` | `{ name, action, port, proto }[]` | `ufw`, `New-NetFirewallRule`. |
| `registry` | `{ path, name, type, value }[]` | `Get-ItemProperty`, `Set-ItemProperty`. |
| `shares` | `{ name, path, description }[]` | `New-SmbShare`, `net share`. |
| `events` | `{ id, source, level, message, time }[]` | `Get-WinEvent`. |

> **Important:** declaring `services` **replaces** the platform defaults rather
> than merging with them. This is how you make a ticket real work — for example,
> if the built-in Windows defaults already have the Spooler running, a
> "restore the spooler" scenario would be trivially satisfied. Declare the
> services explicitly in the broken state you want.
>
> The same applies in reverse: if you declare only *some* services, the rest of
> the defaults disappear. Declare the full set you expect the student to see.

### `docs` (OFFICE only)

Office documents (workbooks, documents, mailboxes) that ship with the scenario,
with their sheets, cells, styles, paragraphs and messages.

---

## Checks

Every check is `{ id, label, kind, points?, competency?, halfOf?, ...kindSpecific }`.
`id` must be unique, `label` is shown in the report, and `points` defaults to `1`.
`competency` and `halfOf` are the rubric fields described under *Rubric bands* below.

| Kind | Required fields | Notes |
| ---- | --------------- | ----- |
| `file_exists` | `path` | |
| `file_absent` | `path` | |
| `file_contains` | `path`, `pattern` | `pattern` is a regex that must appear. |
| `file_not_contains` | `path`, `pattern` | `pattern` must **not** appear — use it for "the stale entry is gone". |
| `file_mode` | `path`, `mode` | e.g. `"0644"`. |
| `file_owner` | `path` | optional `owner`, `group`. |
| `dir_exists` | `path` | |
| `command_matched` | `pattern` | Regex against the student's command history. |
| `command_sequence` | `patterns[]` | All must match, in this relative order. |
| `service_state` | `name` | optional `active`, `enabled`. |
| `package_state` | `name` | optional `installed`. |
| `user_exists` | `name` | optional `exists`. |
| `user_in_group` | `name`, `group` | |
| `user_detail` | `name`, `field`, `equals` | `field` ∈ `home` \| `shell` \| `fullName` \| `description`. |
| `cron_matches` | `pattern` | optional `flags`. |
| `firewall_rule` | `name` | optional `exists`, `action`, `port`. |
| `registry_value` | `path`, `name`, `equals` | |
| `share_exists` | `name` | optional `exists`. |
| `hostname_equals` | `value` | |
| `note_matches` | `pattern` | Matches the root-cause note the student records with `note <text>`. |
| `cell_equals` | `doc`, `cell`, `equals` | optional `sheet`, `tolerance`. |
| `cell_formula_contains` | `doc`, `cell`, `pattern` | optional `sheet`, `flags`. |
| `cell_style` | `doc`, `cell` | optional `bold`, `italic`, `format`, `sheet`. |
| `doc_contains` | `doc`, `pattern` | optional `flags`. |
| `doc_heading` | `doc`, `pattern` | optional `level`, `flags`. |
| `sheet_exists` | `doc`, `sheet` | |
| `mail_sent` | `to` | optional `subjectPattern`, `bodyPattern`, `flags`. |
| `mail_flagged` | `subjectPattern` | requires `flagged: true`\|`false`. |

### Regex flags — a real trap

JavaScript regular expressions do **not** support inline flags. Writing
`"(?i)nginx"` throws at runtime.

```jsonc
// ❌ breaks in JavaScript
{ "kind": "file_contains", "path": "/etc/hosts", "pattern": "(?i)wiki" }

// ✅ pass the flag separately
{ "kind": "file_contains", "path": "/etc/hosts", "pattern": "wiki", "flags": "i" }
```

**If a check is trivially satisfied, students get free points.** A scenario whose
check reads "php is installed" when the base image already ships php is a bug,
not a scenario. The validator's dry run is there to catch exactly this, and
instructors should treat its warnings as errors.

### Case notes

`note_matches` grades the root-cause note a student writes with the `note`
command, and `notes` lists what they have recorded so far. **Every console
supports both** — Linux (`note Root cause: nginx was down`), Windows
(`note Root cause: spooler start type was Manual`) and Office — so a
`note_matches` check works in a scenario on any platform.

Notes are an assessment artefact, not part of the machine: they are not files,
and the reboot, package or firewall checks ignore them. An empty `note` is
refused rather than recorded, so a stray keystroke cannot collect the point.

### Simulation shell vs. points

Prefer **derived-state** checks (`file_exists`, `service_state`, `registry_value`,
`firewall_rule`, …) for correctness — they describe the outcome. Use
`command_matched` / `command_sequence` sparingly, to reward good investigative
*process* (reading the log before changing anything), not as the pass/fail gate.

### Rubric bands — 0, half or full

A check can award partial credit without a second authoring language: write the
weaker condition as an ordinary check and point it at its parent with `halfOf`.

```jsonc
"checks": [
  {
    "id": "ssh-hardened",
    "label": "SSH accepts configured sign-in only",
    "kind": "file_contains",
    "path": "/etc/ssh/sshd_config",
    "pattern": "^PermitRootLogin\\s+no",
    "points": 4,
    "competency": "Linux hardening"
  },
  {
    // Worth half the parent when the parent misses: password auth is off, but
    // root sign-in is still open. It is never a line of its own in the report.
    "id": "ssh-password-off",
    "label": "Password sign-in disabled",
    "kind": "file_contains",
    "path": "/etc/ssh/sshd_config",
    "pattern": "^PasswordAuthentication\\s+no",
    "halfOf": "ssh-hardened"
  }
]
```

The parent then earns **0**, **half** or **full**. Half is
`Math.floor(points / 2)`, which is why the validator requires a parent worth an
even number of at least 2; `points` on the band itself is ignored. A band is not
a pass — the report says "half credit" and the check still counts as missed. A
band on a band, two bands for one parent and a band naming a check that does not
exist are all errors; a band that already passes on a fresh machine is a warning,
because that is free points on every submission.

### Competencies

`competency` names the one skill a check demonstrates. A certificate's skills are
the competencies its **full-credit** checks earned; a half band is work in
progress, not a competence. A scenario where no check is tagged keeps using the
scenario's own `tags`, so a catalog written before this existed issues the same
records it always did.

---

## Hints

```jsonc
"hints": [
  { "id": "hint-svc", "text": "`systemctl status nginx` shows whether the unit is active.", "penalty": 1 }
],
"allowHints": true
```

Opening a hint deducts its `penalty` from the final score and is recorded on the
attempt. Set `allowHints: false` for assessments where help is not permitted.

---

## The validator

`validateDefinition()` (`src/lib/validate.ts`) is the single source of truth for
authoring rules. It is pure and runs in the browser, on the server and in tests.

1. **Structural** — the envelope must parse; `engine` must match `platform`.
2. **Per check** — unique `id`, non-empty `label`, a known `kind`, and every
   required field present.
3. **Regex compilation** — every `pattern` is compiled, so an invalid expression
   (or a stray inline `(?i)`) is reported as an error, not a runtime crash.
4. **Dry run** — the definition is booted once into `createInitialState` and every
   check is evaluated against the **untouched** starting state. Anything that
   already passes is reported as a warning: *"this check passes before the student
   does anything."*

`ValidationResult` returns `{ ok, issues, totalPoints }`, where each issue has a
`level` of `"error"` or `"warning"`, an optional `field`, and a `message`.

---

## Worked example

The built-in Linux template (`LINUX_TEMPLATE` in `src/lib/templates.ts`) is a
complete, valid scenario — a good pattern to copy:

```jsonc
{
  "version": 1,
  "platform": "LINUX",
  "engine": "bash",
  "objective": "Raise the internal wiki back to a healthy state.",
  "brief": "# Ticket 4471 — internal wiki is down\n\n…",
  "tasks": ["Start nginx", "Enable nginx at boot", "Allow HTTP through the firewall", "Record a root-cause note"],
  "machine": { "hostname": "wiki01", "user": "student", "os": "Ubuntu 24.04.2 LTS", "version": "24.04", "kernel": "6.8.0-45-generic", "arch": "x86_64" },
  "files": [
    { "path": "/home/student/README.txt", "content": "Ticket 4471\nnginx is installed. Check the service state first.\n" },
    { "path": "/var/log/nginx/error.log", "content": "2026/03/11 09:14:02 [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)\n" }
  ],
  "checks": [
    { "id": "svc-running", "label": "nginx is running", "kind": "service_state", "name": "nginx", "active": true, "points": 2 },
    { "id": "svc-enabled", "label": "nginx survives a reboot", "kind": "service_state", "name": "nginx", "enabled": true, "points": 2 },
    { "id": "fw-open", "label": "HTTP is allowed through the firewall", "kind": "firewall_rule", "name": "allow-80", "action": "allow", "points": 2 },
    { "id": "checked-logs", "label": "Checked the service state first", "kind": "command_sequence", "patterns": ["systemctl (status|is-active)", "(journalctl|tail .*error\\.log)"], "points": 1 },
    { "id": "note", "label": "Recorded a root-cause note", "kind": "note_matches", "pattern": "nginx", "points": 1 }
  ],
  "hints": [
    { "id": "hint-svc", "text": "`systemctl status nginx` shows whether the unit is active.", "penalty": 1 }
  ],
  "allowHints": true
}
```

---

## Publishing and the availability rule

Publishing a scenario does **not** by itself make it visible to students. A
scenario is offered only when its platform is switched on, it is published, and
**every software package it requires is enabled with a usable source** (an
uploaded package, a download URL, or nothing for `INTERNAL` simulations), and any
`LICENSED` package has a key and has not expired.

Attach the software a scenario needs on the scenario's edit page. If a package is
missing, disabled, or unlicensed, the admin control room reports exactly which
dependency is blocking it — and students simply never see the scenario, rather
than opening it and finding a broken environment.

See the *Availability rule* section of the main [README](../README.md) for the
full matrix.

## Review, history and rollback

A scenario is a graded artifact, so the person who wrote the checks is the worst
placed to notice that a check asks the wrong thing. With
`ONTRAK_SCENARIO_REVIEW_REQUIRED` on, an author **submits** a scenario, somebody
else **approves** it (the author cannot approve their own work), and only then
may it be published. A request-changes decision returns it to draft, and an edit
that changes the grading shape drops an approval too — a review covers the checks
that were read, not whatever they become later. A title or briefing edit does not
cost a revision, because it cannot move a score.

Every grading-shape save writes the shape it replaced to the scenario's history,
and the edit page lists it. **Rollback is a new save carrying the old shape**, not
a deletion of the revisions after it: restoring revision 1 makes that shape live
again, records what it replaced as the newest revision, and leaves the revisions
in between readable. The slug and the software links are left alone — both are
catalog facts rather than scoring ones.

The writes behind all of this live in `src/lib/scenario-workflow.ts`, which takes
the database as a structural seam, so the instructor actions and a script run the
same decisions. `tests/scenario-workflow.test.ts` drives two authors through the
whole thing over an in-memory store, and
`npx tsx --tsconfig tests/tsconfig.json scripts/verify-scenario-review.ts`
(with `DATABASE_URL` set) runs it against a real database and cleans up after
itself.

## Timing integrity (opt-in)

A scenario may ask for a **timing record**: the intervals during which the
learner's page was hidden while the attempt ran. It is off unless the definition
says so, and it is added as one block:

```jsonc
{
  // … the rest of the definition
  "integrity": { "recordFocusLoss": true }
}
```

The block is strict: an unknown or misspelled key is a validator error rather
than a silently ignored one, because a scenario whose author believed the control
was on but which records nothing is worse than either state.

What the record is: the attempt runner reports `visibilitychange` intervals, the
server clamps each to the attempt's own window, merges overlaps, drops claims it
cannot read (a switch under a second, a claim longer than four hours, an interval
that ends before it starts), and caps the total at six hours. The attempt stores
the merged periods and their total; both the learner's report and the
instructor's review page show the same sentence — "43 s away in 2 intervals;
recorded, not scored".

What the record is **not**: a score input, a cheating detector, or proof of
anything about the learner. The grader never reads it, a re-grade does not change
it, and a lost tab cannot fail anybody. It exists so a higher-stakes assessment
can put a fact beside a result that a reviewer can read — and so it must never be
described to a class as proctoring. The intervals are browser-reported; the
record says so in its own words, because software the learner controls is not a
witness.

---

## Checklist before publishing

- [ ] Validator reports **no errors**.
- [ ] Validator's dry run reports **no "already passes" warnings** (or you have
      consciously accepted each one).
- [ ] Every required software package is enabled and provisioned.
- [ ] Stated `tasks` line up with the `checks` — no orphan tasks or orphan points.
- [ ] Time limit and `passScore` suit the class.
- [ ] You have played the scenario end to end yourself.
