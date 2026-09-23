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
