# Scenarios

## Which scenarios matter most for tech-support training

There is no single right answer, but there is a defensible teaching order. Two
properties decide how much a scenario earns its place in a curriculum:

1. **Volume** — how often a first/second-line technician meets it in real work.
2. **Gradability** — whether "fixed" can be verified automatically and
   unambiguously, so the student gets honest feedback without an instructor
   watching.

Scored on both, the order that this catalogue follows is:

| Rank | Family | Why it earns the time |
| --- | --- | --- |
| 1 | **Network / connectivity** (DNS, IP, gateway, wifi) | The highest-volume class of "nothing works" tickets, and the most gradable: a name either resolves or it does not. It also teaches the diagnostic reflex that transfers to everything else — check the layer you can actually see before blaming the application. |
| 2 | **OS boot & performance** | Very common in the field, and the one family where the student must go *looking* for the cause instead of being handed an error message. Startup persistence, runaway processes and disabled services cover most of what makes a workstation "slow" or "broken at boot". |
| 3 | **Software / corrupted settings** | Dominant in any environment with a line-of-business app. Excellent teaching material because the fix is rarely "reinstall": it is reading a log, correcting a configuration, and clearing the state the crash left behind. |
| 4 | **Hardware / drivers** | Lower ticket volume than the first three, but it is where junior technicians lose the most time, because Device Manager problem codes are not self-explanatory. Worth teaching, but you need a scenario that is genuinely device-level (see the note below). |
| 5 | **Security incidents (simulated)** | Lowest routine volume for general support, highest consequence. Treat it as the capstone: it is the only family that also tests *process* — evidence, documentation, and doing the work in an order that does not destroy the evidence. It is the family where a written record is part of the grade. |

Two practical caveats:

* **Teach in ticket language, not fault language.** Every scenario here is framed
  as a user's complaint. That is the transferable skill: translating "my machine
  is dying" into a measurable symptom.
* **Weight the mix to your organisation.** If your learner cohort supports a
  warehouse of thin clients, wireless and roaming profiles deserve more than a
  device-driver exercise. Use the shipped set as a template of *kinds* of exercise
  and replace the specifics with your own estate's stories — you will find the
  fault-injection and grading machinery is the reusable part, not the ticket text.

### A note on hardware scenarios

You cannot make a real driver fail in software. What you *can* do is put a real
device into a problem state — which is what `hw-driver-device` does: the template
gets a second network adapter (`instance_devices` in `scenario.yaml`), and
`setup.ps1` disables it at the device level, which is exactly what Device Manager
shows as a yellow warning triangle. The student fixes it with enable/rescan/
reinstall-driver, and grading accepts any of those because it grades the outcome
(no disabled or unhealthy adapters) rather than the method.

## The lab fact sheet

Scenarios share one fictional estate so that tickets reinforce each other:

| Thing | Value |
| --- | --- |
| Intranet DNS domain | `ontrak.lab` (served by the lab bridge's own DNS) |
| DNS server | the bridge gateway, e.g. `10.20.0.1` (supplied by DHCP) |
| File server | `fileserver.ontrak.lab` — HTTP on 80, `10.20.0.53`, from `infra/lab-services.sh` |
| Staff portal | `portal.ontrak.lab` — HTTP on 8080, `10.20.0.54` |
| Database | `TrainingDB` on the SQL Server workloads (APPDB-01 in tickets) |
| Mail server | `APPMAIL-01` — the Exchange Server workloads, SMTP on 25 |
| Intranet farm | `SPINTRA-01` — the SharePoint Server workloads, Central Admin on `8080` |
| Export host | `export-01` (Ubuntu) — the nightly export to the file server |

The two service names are **explicit DNS records** on the lab bridge
(`incus network get ontrak0 raw.dnsmasq`), not Incus's automatic per-instance
registration: the bridge runs with `dns.mode=none` so that one instance may hold
two NICs on it, which `hw-driver-device` needs. Students still repair the resolver
— the names are answered by the same dnsmasq that DHCP hands out.
| Client subnet / DHCP range | `10.20.0.0/24`, DHCP `10.20.0.100-10.20.0.200` |
| Client gateway | `10.20.0.1` |
| Training account | local `student`, member of `Administrators` |
| Student notes file | `C:\Users\student\Desktop\ontrak-notes.txt` |
| Fault artifacts directory | `C:\ProgramData\OnTrak` (Defender-excluded at image build) |
| Scenario scripts on the guest | `C:\ProgramData\OnTrak\scenarios\<id>\`, shared lib in `..\lib\` |

## Anatomy of a scenario

```
scenarios/<id>/
├── scenario.yaml     ticket, objectives + weights, hints, metadata
├── setup.ps1         injects the fault; must confirm success
├── check.ps1         grades each objective; must emit the JSON payload
└── resources/        optional extra files uploaded alongside setup.ps1
```

### `scenario.yaml`

```yaml
id: net-dns-failure            # must match the directory name
title: "Nothing resolves on the intranet"
category: network              # hardware | software | network | os | security
difficulty: 1                  # 1..4, shown to students
minutes: 20                    # suggested time on ticket
pass_score: 80                 # score needed, on top of all critical objectives
requires_internet: true
tags: [dns, dhcp, resolver]
ticket:                        # rendered as a table on the session page
  from: "Priya Raman (Accounting)"
  system: "WORKSTATION-042"
  priority: "High"
briefing: |                    # the student's ticket, verbatim
  ...
objectives:                    # the grading contract
  - id: restore-resolver
    text: "The adapter resolves through the lab DNS server again"
    weight: 40
    critical: true
    hint: "Compare ipconfig /all with a working machine."
hints:                         # revealed one at a time, most generic first
  - "Start with ipconfig /all"
instance_devices:              # optional: extra hardware, applied at template build
  - name: eth1
    type: nic
    network: ontrak0
instance_config:               # optional: extra incus config keys
  limits.memory: 4GiB
resources: []                  # optional files uploaded with setup.ps1
reset_notes: |                 # shown to students about what reset does
  ...
```

### The script contract

`setup.ps1` injects the fault and **must** finish with `Write-OnTrakSetupOk`
(which prints `ONTRAK-SETUP-OK`). Template build refuses to snapshot a scenario
whose setup did not confirm, so a half-applied fault can never reach a student.
Write your setup to be idempotent: rebuilding a template is a normal operation.

`check.ps1` calls `Add-OnTrakCheck` once per objective and then `Write-OnTrakReport`
exactly once. The payload is JSON between two markers, which makes grading immune
to noise on stdout:

```
###ONTRAK-JSON-BEGIN###
{"checks":[{"objective":"restore-resolver","passed":true,"detail":"dns=10.20.0.1"}]}
###ONTRAK-JSON-END###
```

Both scripts dot-source the shared library:

```powershell
. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"
```

`scenarios/_lib/OnTrak.Common.ps1` provides the reporting contract plus helpers
that encode the lab's hard-won details: `Get-OnTrakPrimaryAdapter` (the adapter
that actually carries traffic), `Test-OnTrakDnsName -DnsOnly` (so a hosts entry
cannot fake a working resolver), `Get-OnTrakPnpDevice` (filters phantom devices
left over from imaging), `Test-OnTrakReportField` (grades written notes),
`Get-OnTrakCpuLoad` (samples instead of a single reading), and so on. Add to it
rather than copying logic between scenarios.

### Grading model

* **Weighted objectives** — score is `100 × passed_weight / total_weight`, so
  partial credit is meaningful and the numbers on the session page add up.
* **Critical objectives** — a gate: resolution requires *all* critical objectives
  passed *and* `pass_score` reached. Use it for the objective the ticket actually
  cares about ("the user can reach the file server again"), not for the whole
  scenario. Validation warns if you mark everything critical, because then partial
  credit stops meaning anything.
* **Unreported objectives count as failures.** A check that crashed must never look
  like a pass. Validation statically enforces that `check.ps1` mentions every
  objective id, and a test in `tests/test_scenarios.py` enforces it for the shipped
  catalogue, so this only bites authors who skip `make validate`.
* **Duplicate reports:** if the same objective is reported twice, the failure wins.
  A flapping probe cannot fake a pass.
* **Observations, not verdicts.** `-Detail` should carry the evidence your check
  saw ("dns servers=10.20.0.99; lookup works=False"). It is what students learn
  from, and what an instructor needs when a score is disputed.

## The shipped scenarios

### 1. `net-dns-failure` — "Nothing resolves on the intranet" (network, 1/4)

* **Broken:** a static, non-existent DNS server (`10.20.0.99`) on the primary
  adapter. Everything else is healthy, so the machine looks connected.
* **Fix:** return the adapter to DHCP-supplied DNS (or point it at the working
  resolver), clear the DNS cache, verify.
* **Graded:** resolver restored (critical) / intranet name resolves (critical) /
  file server reachable on 80.
* **Common wrong answer:** `ipconfig /flushdns` and declaring victory. A cached
  entry is not the fault, and the checks ignore the cache.
* **Gotcha:** the check uses `-DnsOnly`, so a hosts-file entry cannot fake it.

### 2. `net-static-ip-conflict` — "A contractor 'optimised' the network settings" (network, 2/4)

* **Broken:** static address with a gateway (`10.20.0.254`) that does not exist.
  The VM stays reachable *on-link*, which is why remote support still works while
  nothing off-subnet does.
* **Fix:** back to DHCP per the site standard, verify gateway and service.
* **Graded:** DHCP enabled (critical) / gateway answers (critical) / file server
  reachable.
* **Common wrong answer:** fixing the address but not the route, then reporting
  "the address is correct now".

### 3. `sw-app-crash` — "The CRM app crashes on launch" (software, 2/4)

* **Broken:** three independent faults around a simulated app: invalid JSON in
  `config.json` (trailing comma *and* a decommissioned server), a wrong per-user
  override in `HKCU\Software\OnTrak\CrmApp`, and a stale lock file left by the crash.
* **Fix:** read the app's log, repair the config, correct the registry override,
  delete the lock, re-run the self-test.
* **Graded:** config parses and points at the approved backend (critical) /
  override correct / lock cleared / self-test exits 0 with `SELFTEST OK` (critical).
* **Common wrong answer:** deleting the lock file only — the app then fails on
  config. This is deliberate: one fix is not enough, which mirrors real crash
  recovery.

### 4. `os-perf-startup` — "Takes ten minutes to boot and then crawls" (os, 3/4)

* **Broken:** an unwanted "PC Speed Booster" burns a full CPU core. It comes back
  from **two** places: a scheduled task at startup (runs on every boot) and a Run
  key (visible to the student at logon). The Print Spooler is also set to Disabled.
* **Fix:** find the process, remove both persistence mechanisms, delete the payload
  file, restore the spooler service.
* **Graded:** CPU load under threshold and no burner process (critical) / both
  persistence entries gone (critical) / payload file deleted / spooler running
  with a non-disabled startup type.
* **Common wrong answer:** killing the process in Task Manager and removing the
  Run key. The scheduled task relaunches it and the CPU objective fails — a
  designed lesson in persistence.
* **Gotcha:** the CPU objective samples 5 readings a second apart rather than
  trusting one number, and separately checks for the process, because "quiet for a
  second" is not "fixed".

### 5. `hw-driver-device` — "Dock Ethernet shows a warning triangle" (hardware, 3/4)

* **Broken:** the second network adapter's device is disabled (a warning triangle
  in Device Manager). The primary adapter is untouched, so remote support still
  works.
* **Fix:** enable the device (or reinstall/rescan the driver) and confirm the link
  is up. Write up what was found.
* **Graded:** no disabled or unhealthy adapters (critical) / both adapters up /
  notes file with `Evidence:` and `Action:` lines.
* **Common wrong answer:** leaving it disabled and calling it "cleanup". Grading is
  outcome-based on purpose: enable, rescan and driver-reinstall all pass.
* **Requires:** `instance_devices` support (the extra NIC) — the build fails loudly
  with a clear message if the second adapter is missing.

### 6. `sec-malware-persistence` — "EDR alert: unexpected persistence and a new administrator" (security, 4/4)

* **Broken (simulated, benign):** a `svchost32.vbs` payload running from
  `C:\Users\Public\update`, Run key + scheduled task persistence, a rogue local
  administrator `svc_backup`, a hosts entry redirecting `portal.ontrak.lab`, and
  Defender real-time protection turned off.
* **Fix:** work the four alerts, remove persistence and payload, deal with the
  account, clean the hosts file, re-enable protection, and write up the incident.
* **Graded:** persistence gone (critical) / payload deleted and not running /
  rogue admin no longer privileged / hosts file clean / Defender real-time on
  (critical) / notes with `Evidence:` and `Action:`.
* **Why the write-up is graded:** the professional skill in an incident is the
  record. `Test-OnTrakReportField` requires two labelled lines with real content, so
  "rebooted the PC" earns nothing.
* **Gotchas:** the payload is deliberately harmless (no network, no spreading) —
  this is an investigation exercise, not a malware sample. Real-time protection
  may be locked by Windows 11 **tamper protection**; `setup.ps1` records what
  actually happened and grading reports it honestly instead of pretending the
  fault was applied. See the note in `infra/windows/post-install.ps1` for how to
  bake tamper protection off if your cohort needs that objective to bite.

### 7. `sec-phishing-triage` — "Suspicious invoice email" (security, 3/4)

**What the student finds:** a reported phishing email in the user's mailbox, a placeholder
attachment sitting in `Downloads` with a `.doc.exe` name, and a hosts-file entry the user
added themselves to "fix" an unreachable intranet page.

**Objectives:** name the indicators (spoofed sender domain, failed SPF, the attachment);
isolate the attachment; restore the hosts file; write the incident up.

**Why it is here:** it is the only scenario that grades *process*. Nothing has executed,
so there is no malware to remove — the marks are for recognising the indicators, containing
the artifact that could run, undoing the change the user made, and documenting all three.
A student who quarantines but writes nothing gets partial credit, which is the correct
outcome for a triage ticket.

### 8. `sw-db-service-account` — "The application cannot connect to the database" (software, 2/4)

* **Broken:** the SQL Server service logs on as a local account (`svc-sql`) whose password
  identity rotated on Saturday. Windows services hold their *own* copy of the password, so
  the service cannot start at all (System log, error 1069) and every client reports
  "cannot connect to the database" — while the database is never the problem.
* **Fix:** move the service to the estate standard — the virtual account
  `NT SERVICE\MSSQLSERVER`, which has no password to rotate — and start it.
* **Graded:** service running (critical) / a real query answers (critical) / the service
  logs on as the standard virtual account.
* **Common wrong answer:** hunting for a database fault while the service is stopped.
  Fixing `svc-sql`'s password also passes the machine objectives but loses the standard
  one — on purpose, since it would be stranded again by the next rotation.
* **Workloads:** `sql-server-2019`, `sql-server-2022`.

### 9. `net-db-protocols` — "The app server cannot reach the database — but it works on the box" (network, 3/4)

* **Broken:** TCP/IP and Named Pipes are disabled in the instance's network configuration;
  shared memory — SQL Server's always-on local "protocol" — is left alone. Every tool on
  the box works; nothing answers the network.
* **Fix:** re-enable both protocols (SQL Server Configuration Manager) and restart the
  SQL Server service — the protocols load with the service.
* **Graded:** TCP/IP enabled / named pipes enabled / the port answers (critical) / a
  forced-TCP connection runs a query (critical).
* **Common wrong answer:** "it works when I test it" — tested by a local tool riding
  shared memory. The graded connection forces `tcp:` into the data source so the shortcut
  cannot fake a fix.
* **Gotcha:** the registry path is instance-versioned (`MSSQL15` on 2019, `MSSQL16` on
  2022), so the scripts resolve it from `Instance Names\SQL` rather than assuming one.
* **Workloads:** `sql-server-2019`, `sql-server-2022`.

### 10. `net-db-firewall` — "The database stopped answering after the change window" (network, 2/4)

* **Broken:** the change window's "temporary lockdown": the estate's allow rule for the
  database port is disabled and an enabled block rule takes its place on TCP 1433. The
  database is untouched and healthy.
* **Fix:** remove the block rule and leave inbound 1433 allowed by an enabled rule.
* **Graded:** no enabled block rule on 1433 (critical) / an enabled allow rule on 1433 /
  the instance itself still answers — a guard against "fixing" a firewall ticket inside
  SQL Server.
* **Gotcha:** grading reads the *rule list* on purpose. Loopback traffic does not cross
  Windows Firewall rules, so no probe from the machine itself can see the block at all —
  a socket test would pass before the fix and grade the fault as healthy.
* **Workloads:** `sql-server-2019`, `sql-server-2022`.

### 11. `os-db-log-full` — "Saving records fails: the transaction log is full" (os, 3/4)

* **Broken:** `TrainingDB`'s transaction log is capped at 4 MB with autogrowth off, in full
  recovery with no backup job — so it fills with committed transactions it can never
  clear and refuses every write, on a server whose disks are nearly empty.
* **Fix:** get saving again *and* take the lid off: autogrowth (or a bigger cap), plus
  either a log backup or the recovery model the estate uses.
* **Graded:** a write succeeds (critical) / the log can grow again / the log has room
  again. All three legitimate fixes pass, whichever door the student used.
* **Common wrong answer:** "the disk is full". The log is a file with a size cap, and in
  full recovery a checkpoint alone provably clears nothing.
* **Gotcha:** the check runs a `CHECKPOINT` before its probe write — fairness to the
  simple-recovery fix (whose first save would race an auto-checkpoint) and, in full
  recovery, a free demonstration that the log stays full.
* **Workloads:** `sql-server-2019`, `sql-server-2022`.

### 12. `os-db-backup-job` — "Audit wants a point-in-time restore and there is nothing to restore from" (os, 3/4)

* **Broken:** `TrainingDB`'s log-backup job is disabled and SQL Server Agent — the thing
  that runs both backup jobs — is stopped on manual startup. The database is in full
  recovery with a healthy nightly *full* backup and not one log backup in its history,
  so the chain a point-in-time restore needs does not exist.
* **Fix:** close the gap that can still be closed (a log backup now) and put the
  recurring routine back — the job enabled and scheduled, the Agent running and
  automatic. Routing the backups through Task Scheduler instead counts as an
  equivalent fix.
* **Graded:** a log backup exists (critical) / the recurring routine is in place and
  able to run (critical) / full recovery with a full and a log backup — the objective
  that fails the "switch it to simple" shortcut.
* **Common wrong answer:** taking one manual log backup and calling it done. The gap
  opens again at the next transaction.
* **Gotcha:** the backup report is the red herring — it shows the full backup and a
  green tick. The evidence is the backup *history*, filtered to log backups.
* **Workloads:** `sql-server-2019`, `sql-server-2022`.

### 13. `net-mail-queue` — "Mail is just sitting in the Outbox" (network, 3/4)

* **Broken:** the Microsoft Exchange Transport service is stopped and disabled by a
  weekend "hardening" script. Nothing can be submitted (messages sit in the Outbox)
  and nothing can be delivered (external senders are refused).
* **Fix:** the transport service running and set to automatic again.
* **Graded:** the transport service running (critical) / a complete SMTP transaction
  accepted (critical) / the service starts automatically again.
* **Common wrong answer:** trusting the facts the ticket already carries — the server
  pings, *port 25 answers*, the mail database is mounted. A TCP banner is a listener,
  not mail flow: Exchange's frontend keeps answering the port while the transport
  service behind it is dead.
* **Gotcha:** grading walks the SMTP conversation as far as the server taking
  responsibility for a message (banner, EHLO, MAIL FROM, RCPT TO, DATA) —
  `Test-OnTrakSmtpProbe` in the shared lib — because connecting is exactly the test
  the ticket passes before the fix.
* **Workloads:** `exchange-server-2019`, `exchange-server-se`.

### 14. `sw-farm-timer` — "The intranet stopped doing its scheduled work" (software, 2/4)

* **Broken:** the SharePoint timer service (`SPTimerV4`, every scheduled job) and the
  administration service (`SPAdminV4`, provisioning work) are stopped and disabled by
  Friday's "performance tuning" script. The sites keep serving pages the whole time.
* **Fix:** both services running and set to automatic.
* **Graded:** the timer service running (critical) / the administration service
  running / both starting automatically — the half that survives a restart.
* **Common wrong answer:** fixing the web server, because the symptom list is
  "scheduled things stopped" while the site is demonstrably up. The stuck
  site-collection creation is the administration service, not the timer.
* **Gotcha:** the sites never stop — the build-time trap assert is Central
  Administration answering `8080` while both farm services are down.
* **Workloads:** `sharepoint-server-se`.

### 15. `sw-office-wont-open` — "None of the Office apps will open" (software, 2/4)

* **Broken:** the Microsoft Office Click-to-Run Service (`ClickToRunSvc`) — the launcher
  every app in the suite starts through — is stopped and disabled by a weekend
  inventory agent's "optimisation". Every app dies at the splash screen with the same
  generic error.
* **Fix:** the service running and set to automatic again. A repair install also works,
  for 3 GB and an hour of the user's day.
* **Graded:** the launcher service running (critical) / set to automatic / an Office app
  genuinely starts again (critical).
* **Common wrong answer:** the repair install suggested in the ticket thread. The whole
  suite failing identically is the clue: the fault is in what the suite shares, not in
  any one app.
* **Gotcha:** grading launches Word through its *automation object* in a bounded child
  process — "WINWORD.EXE is running" proves nothing, because an error dialog is a
  process too. First-run wizards are suppressed at setup so the probe measures the
  fault rather than a wizard.
* **Workloads:** `m365-apps-on-win11`.

### 16. `linux-log-flood` — "The nightly export fails: no space left on device" (os, 2/4)

* **Broken:** the export service's logging was turned up to debug for a weekend
  debugging session, and its logrotate config was moved aside "so the log is kept" —
  neither put back. The flood filled the `/var/log` filesystem, and the nightly export
  to the file server now fails every night with "No space left on device".
* **Fix:** reclaim the space (truncate or rotate — in place, so the writer survives)
  and bound the log again: rotation back where logrotate reads it, or the debug flood
  off. Both doors pass. The moved-aside config is cleaned up either way — the ticket
  asks what changed, and to undo it.
* **Graded:** the flood log is small again (critical) / the log cannot grow without
  bound (critical) / the weekend's temporary change is cleaned up.
* **Common wrong answer:** "the disk is full, get a bigger one" — and clearing only
  tonight's space without bounding the log, which re-runs this ticket on the next busy
  week.
* **Gotcha:** the moved-aside config is correct and complete — it is a file named for
  what it used to be, sitting in the application's directory where logrotate will
  never read it. Walkthrough: the `linux-log-rotation` lesson.
* **Workloads:** `ubuntu-24.04`, `debian-12`.

## Generating scenarios from fault primitives

Writing each scenario by hand does not scale past a handful, and a course that ends up with
four scenarios teaches four things. OnTrak therefore keeps a library of **fault primitives**
in `ontrak/primitives.py`: each one carries a plausible, reversible fault, the objectives
that describe a fix, and the grading that decides whether the fix worked.

```bash
ontrak generate list                       # the primitives, and curated combinations
ontrak generate one --primitive dns-resolver-trapped --scenario gen-dns
ontrak generate one --primitive dns-resolver-trapped --primitive service-disabled \
    --scenario gen-monday-morning --title "Nothing works since this morning"
ontrak generate matrix --prefix gen        # one scenario per primitive
ontrak scenario validate                   # the same gate hand-written scenarios pass
```

Generation is deliberately **not** free-form. A primitive is a code change and gets reviewed,
because it embeds the judgement about what "fixed" means. What generation automates is the
plumbing: ticket text, weighted objectives, the `setup.ps1` that injects the fault, the
`check.ps1` that grades it, and hints.

Three guarantees hold for anything generated:

1. **It is validated before it exists.** `generate` writes the scenario and immediately runs
   the same `ScenarioRepository.validate` that CI runs. A check script that never reports an
   objective fails generation rather than failing a student.
2. **Objective weights are normalised to 100**, so a composed ticket keeps the same pass
   mark semantics as every other scenario.
3. **It is honest about what it needs.** Combining a primitive that needs internet with a
   workload that cannot verify it is refused by selection, not silently graded as zero.

The generated directory is a normal scenario: hand-edit it afterwards if you want, or
regenerate with `--force`. The manifest records `generated_from:` so provenance survives.

## Authoring a new scenario

```bash
mkdir -p scenarios/my-ticket
$EDITOR scenarios/my-ticket/scenario.yaml    # start from a shipped one
$EDITOR scenarios/my-ticket/setup.ps1        # inject; end with Write-OnTrakSetupOk
$EDITOR scenarios/my-ticket/check.ps1        # Add-OnTrakCheck per objective, then Write-OnTrakReport
make validate                                # schema + objective/check contract
.venv/bin/ontrak template build my-ticket  # boots Windows once, injects, snapshots "clean"
.venv/bin/ontrak session start --student you --scenario my-ticket
.venv/bin/ontrak session console <id>      # open the URL Guacamole gave you
```

Checklist before you let students near it:

1. `make validate` is clean.
2. Build the template, open a console, confirm the fault is *visible* to someone
   with no inside knowledge (can a competent tech find it from the ticket text?).
3. Walk the intended fix; confirm the score reaches 100 and the report text is a
   sensible explanation, not a restatement of the answer.
4. Try the most likely wrong fix; confirm it scores less than the pass mark.
5. Reset, and confirm the fault is back and identical (same adapter, same
   addresses, same file paths).

## Known fragility (things to re-verify on a new image or a new Windows build)

| Area | Risk | What to do |
| --- | --- | --- |
| VBScript payloads | Microsoft is retiring the script host; `wscript.exe` may be absent | both scenarios that need it detect that and fall back to a PowerShell payload; keep that pattern |
| Defender | the lab's benign artifacts can be quarantined | image build adds path exclusions for `C:\ProgramData\OnTrak` and `C:\Users\Public\update`; do not exclude `powershell.exe` (AMSI hole) unless a specific scenario forces it |
| Defender state objective | tamper protection can refuse `Set-MpPreference` | `setup.ps1` records the real outcome and grading reports it; bake tamper protection off if the objective must always be actionable |
| Device scenarios | depend on the VM's device inventory | declare hardware in `instance_devices`; don't rely on what "usually" exists |
| Printer scenarios | printer drivers are not guaranteed on client SKUs | not shipped for that reason; if you add one, create it with `Add-Printer` in `setup.ps1` and verify on your image first |
| Evaluation ISOs | 90/180-day expiry | rebuild before a course, or move to volume licensing |
| Cloned SIDs | images are not sysprep'd, so clones share a machine SID | fine standalone; never assume domain join works in a scenario |
