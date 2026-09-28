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

Every check is `{ id, label, kind, points?, ...kindSpecific }`. `id` must be
unique, `label` is shown in the report, and `points` defaults to `1`.

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

---

## Checklist before publishing

- [ ] Validator reports **no errors**.
- [ ] Validator's dry run reports **no "already passes" warnings** (or you have
      consciously accepted each one).
- [ ] Every required software package is enabled and provisioned.
- [ ] Stated `tasks` line up with the `checks` — no orphan tasks or orphan points.
- [ ] Time limit and `passScore` suit the class.
- [ ] You have played the scenario end to end yourself.
