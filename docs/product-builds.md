# Product builds: the Microsoft installs, and how to prove one

`product-on-base` is the recipe that turns a base Windows image into a product image.
`ontrak image build sql-server-2022` launches `win2022`, attaches the licensed media
as a CD-ROM, runs `infra/windows/products/sql-server.ps1` inside the guest over the
Incus agent, restarts and re-runs it every time the script says the product needs a
reboot, and publishes `ontrak-sql-server-2022` when the script prints `ONTRAK-PRODUCT-OK`.
The driver is `infra/windows/apply-product-install.py`; the scripts are
`infra/windows/products/*.ps1`; the entries are `catalog/server-products.yaml` plus
`m365-apps-on-win11` in `catalog/office.yaml`.

What is proven without a lab host is the shape — the catalog validates the recipe and
the script it names, the CLI dispatches it, and the reboot-and-resume loop is tested to
the Incus boundary. What is not proven is the install itself: no product media has met a
real guest, so the unattended steps are read against Microsoft's documentation and not
against a setup log ([roadmap.md](roadmap.md), "Built, but not proven on real hardware").
This document is the plan for closing that gap.

## The lab run: one product, end to end

Prove **SQL Server 2022** first, and read its setup logs before calling it done.

Why that one: it needs no Active Directory forest, so there is no promotion and no
identity flip to survive a reboot; it is one or two passes — setup, and at most the
restart its exit code 3010 asks for; its verification is a real TCP connection rather
than a service list; and it is the base `sharepoint-server-se` is layered onto, so a
proven `sql-server-2022` is not throwaway work when the farm comes up. It is also the
cheapest place to learn the shape of a failure, which the more expensive builds will
thank you for.

What the run needs:

- a lab host with Incus and the golden image (`make golden`), and the stack up
  (`make up`) so `ontrak` has its settings and media store;
- the media in the store: `sql-server-2022.iso`, from the operator's licensed download
  — Microsoft's server products are never redistributable, and OnTrak never fetches
  them. `ontrak media status sql-server-2022` says whether it is there;
- about an hour and 100 GiB of disk on the host.

Then:

```bash
ontrak image plan sql-server-2022      # what the build will do, before it does it
ontrak image build win2022             # the base — itself unproven until this runs
ontrak image build sql-server-2022     # launch, attach the media, install, publish
```

The `win2022` line is not a formality: Windows **Server** has never been built from
its answer file on real hardware either (the lab range has so far proved the Windows 11
half), so this run crosses that label off on the way.

Watch for two things in the transcript. One is the reboot pass: the script prints the
reboot marker, the driver restarts the guest and runs the script again on the address
it comes back with — for SQL Server that pass happens only if setup's exit code 3010
asked for one, and the script's own steps say which of 3010's two documented meanings
it read. The other is `ONTRAK-PRODUCT-OK`, which is printed only after verification:
the service running, the instance registered in the registry, and `the instance answered
a real TCP connection on 1433`. A published image is the first half of the proof; the
product's own logs are the second.

## Reading the logs

- The build transcript is the terminal `ontrak image build` ran in: every step the
  script printed, and the exit code and duration of every installer.
- The guest keeps its own copy under `C:\ProgramData\OnTrak\logs` — and that is where
  the SharePoint setup trace and the Deployment Tool's logging are both pointed, so
  the folder grows into the place to look first.
- SQL Server's record of itself is
  `C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\Summary.txt`
  (`150` for SQL Server 2019) with a `Detail` folder beside it. "Setup succeeded" in
  that summary — with the feature list it installed and whether it wants a restart —
  is the line that retires the roadmap label. The build's exit code is not: this
  repository's opinion of the install and SQL Server's own are two different things,
  and only one of them is evidence.
- Exchange, when its turn comes: `C:\ExchangeSetupLogs\ExchangeSetup.log` — the scripts
  already point at it when a step fails, and it records the schema, directory and role
  steps as one story.
- SharePoint: `PrerequisiteInstaller.<date>.log` in `%TEMP%` (including which
  prerequisite asked for which restart), and the ULS logs under
  `...\Web Server Extensions\16\LOGS` for the farm-creation commands.
- A **failed** build leaves `C:\ProgramData\OnTrak\product.json` in the guest on
  purpose — the descriptor carries the lab passwords the product's accounts were
  created with, and the guest is the crime scene. Read it, then delete it; nothing
  published may carry it (the successful path cleans up on its own).

What "proven" means, concretely: the build published; the transcript shows every
documented restart as a pass of its own (setup's 3010 for SQL Server, the post-setup
restart for Exchange, the prerequisite installer's `/continue` for SharePoint); the
product's own setup log says its own words for success; and a session on the
*published* image — freshly booted, media detached — still verifies. Then the label
moves in [roadmap.md](roadmap.md). Not before.

## The order after that

1. `m365-apps-on-win11` — the other product that needs no forest, and the one with
   archive media: it proves the push-and-unpack path and the Office Deployment Tool
   configuration (which deliberately names a `SourcePath` only when the payload is
   really there).
2. `exchange-server-2019` or `exchange-server-se` — the forest promotion, the schema
   preparation, and the identity flip across the reboots. Budget an hour, and watch
   that the pass after each restart resumes instead of re-preparing anything.
3. `sharepoint-server-se` — layered onto the `sql-server-2022` this plan proved first,
   and the longest pass list of the four: prerequisite restarts with `/continue`, the
   post-setup restart, then the farm.

Each of them retires its own sentence in the roadmap when its own setup log has been
read. The scripts were written against the documentation; the point of the lab run is
to find out where the documentation and the media disagree.

## Exchange and SharePoint: what each pass should show

SQL Server's run is one or two passes and its own log is one file. The two domain
products are *sequences* of passes, and each restart hands the next pass a machine
that has changed underneath it — Exchange's promotion turns a workgroup guest into
the domain's own controller between the first pass and the second. What each pass
owes the transcript:

### `exchange-server-2019` / `exchange-server-se` — budget an hour

| Pass | What runs | What the transcript must show |
| --- | --- | --- |
| 1 | the Administrator password set from the descriptor, then the forest promotion | the reboot marker — promotion completes across a restart |
| 2 | `/PrepareSchema`, then `/PrepareAD`, then `/mode:Install /role:Mailbox /InstallWindowsComponents` | `this guest is already in the <domain> domain` on arrival (the identity flip survived the reboot), each step's exit 0 |
| last | the post-setup restart Microsoft asks for, then the verification | services running, the installed tree, `ONTRAK-PRODUCT-OK` |

- The one line to watch: a resumed pass must print `done:` for the steps already
  finished and skip them. A `/PrepareSchema` printed twice is a schema extended
  twice.
- On failure, `C:\ExchangeSetupLogs\ExchangeSetup.log` is the record (the failure
  message names it), and `C:\ProgramData\OnTrak\product-state.txt` says which steps
  had completed when it stopped.

### `sharepoint-server-se` — budget an hour and a half, the longest pass list of the four

| Pass | What runs | What the transcript must show |
| --- | --- | --- |
| 1 | the farm account's SQL login on the local instance (from the `sql-server-2022` base this is layered onto), then `PrerequisiteInstaller.exe /unattended` | exit 0 — or a restart request (3010/1001), which means "restart and re-run with `/continue`", not "done" |
| 2..n | `PrerequisiteInstaller.exe /continue /unattended` | `prerequisites-restarted` in the state file, `/continue` on the command line, until the tool exits 0 |
| next | `setup.exe /config ... /IAcceptTheLicenseTerms`, then the restart Microsoft asks for | `binaries-installed`, then the reboot marker |
| farm | `psconfig` in the configuration wizard's own order: configdb → Update-SPFlightsConfigFile → helpcollections → secureresources → services → installfeatures → adminvs → applicationcontent | one exit 0 per command, in that order, as the domain Administrator |
| verify | the timer service and Central Administration answering on its port | `ONTRAK-PRODUCT-OK` |

- The state file is the spine: one line per completed step, and a resumed pass runs
  only what is missing.
- If a prerequisite asks for a restart and nothing resumes with `/continue`, look
  at the startup task: the script deletes the installer's own re-run-at-logon task
  (Microsoft's documented workaround), because nobody logs on to a guest the agent
  drives — and in the published image that task would fire at a student's first logon.
- Where to read: `%TEMP%\PrerequisiteInstaller.<date>.log` for the prerequisites and
  which one asked for the restart; `C:\ProgramData\OnTrak\logs` for the setup trace
  and the psconfig output.

Pass budget, worst case: promotion (1) + two prerequisite restarts + the post-setup
restart + the final verification pass — six of the driver's eight passes are spoken
for, and `--attempts` raises the fence if a media set needs more.
