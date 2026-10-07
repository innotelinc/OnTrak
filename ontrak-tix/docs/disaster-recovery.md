# Disaster recovery & backup runbook

> M7's backup/DR deliverable. It is written to be *followed*, not admired: every
> step is a command that exists in this repository, and every number is one an
> operator can put in a return-to-service note.
>
> The desk's data is the record of who asked for what, what was promised, and what
> was done about it. It is also the evidence an insurer or an auditor may ask for
> years later. That is why the recovery target below is written in hours and not
> in "as soon as possible".

## 1. What has to survive

| Asset | Where it lives | Lost if | RPO | RTO |
| --- | --- | --- | --- | --- |
| Tickets, messages, SLAs, clients, audit chain | PostgreSQL (`DATABASE_URL`) | the database is lost | **≤ 1 h** | **≤ 4 h** |
| Incident evidence artifacts (WORM) | object-locked storage (`ONTRAK_TIX_EVIDENCE_DIR` or the S3 bucket) | the store is lost | **0** (append-only) | **≤ 8 h** |
| Exported assurance packets | wherever the operator filed them | the file is lost | n/a — regenerable from the record | **≤ 1 h** |
| Configuration | `.env` / Cerulean Vault | the file is lost | n/a — re-derivable from Vault | **≤ 2 h** |
| Uploaded attachments | the blob store | the store is lost | **≤ 1 h** | **≤ 8 h** |

The **audit chain is not backed up separately** — it is part of the database dump,
and restoring the dump restores it. The chain is only as trustworthy as the
`tenant, seq` it verified against, so a restore is followed by a verification
step (§4) rather than assumed good.

## 2. Taking a backup

```bash
DATABASE_URL=postgresql://… scripts/backup.sh [output-dir]
```

- Writes `ontrak-tix-<UTC-stamp>.dump` (PostgreSQL custom format) plus a matching
  `.sha256`.
- Retention: `ONTRAK_TIX_BACKUP_RETENTION_DAYS` (default **14**). Only files this
  script wrote are pruned; a hand-kept archive elsewhere is never touched.
- Exit codes: `0` verified · `1` could not take the backup · `2` written but did
  not verify. **`2` is a page, not a warning** — it means the dump on disk is not
  the backup it claims to be.

**Schedule:** hourly. A cron entry is enough and is deliberately what this repo
does *not* own — the scheduler belongs to the deployment (the same rule OnTrak
Tix already applies to its SLA and retention sweeps, which are HTTP entry points
and `npm run` scripts rather than an in-process cron).

```cron
17 * * * *  cd /srv/ontrak-tix && DATABASE_URL="$(cat /run/ontrak/db-url)" scripts/backup.sh /var/backups/ontrak-tix >>/var/log/ontrak-tix-backup.log 2>&1
```

Copy the output directory off the database host. **A backup that lives only on the
machine it backs up is not a backup**; it is a copy that shares a failure domain.

## 3. Restoring

```bash
DATABASE_URL=postgresql://… scripts/restore.sh /var/backups/ontrak-tix/ontrak-tix-<stamp>.dump --yes
```

- The dump is verified against its `.sha256` **before** anything is dropped. A
  missing checksum is warned about, never passed over silently.
- `--yes` (or `ONTRAK_TIX_RESTORE_CONFIRM=1`) is required: a restore drops and
  rebuilds the objects it finds, so it is a decision somebody made.
- `--clean --if-exists --single-transaction`: re-runnable, and a failure leaves the
  database as it was rather than half-restored.

After a restore, run migrations in case the dump predates one:

```bash
npm run db:deploy   # prisma migrate deploy
```

## 4. Verify the restore (do not skip)

1. **The chain verifies.** Open `/admin` and read the audit-chain result, or call
   the verification the admin surface uses. A restored chain that does not verify
   means the dump is older or newer than the schema it was restored into — stop and
   re-restore from the right point.
2. **The counts reconcile.** Open `/reports` and compare open/closed counts and the
   SLA attainment snapshot against the last scheduled SLA snapshot in the audit log
   (`report.sla.snapshot`). A restore that is missing a day shows up here first.
3. **Evidence artifacts resolve.** For one recent incident, open its packet
   (`GET /api/incidents/<id>/packet`) and confirm the evidence manifest's digests
   match the bytes in the object store. The manifest is content-addressed, so a
   mismatch is unambiguous.
4. **Sign in.** Confirm Cerulean SSO completes and a technician can see their
   queues — the cheapest end-to-end proof that sessions, roles and the database
   agree.

## 5. RPO/RTO in practice

- **RPO ≤ 1 h** holds while the hourly backup runs and its output is copied off the
  host. If backups have been failing (`exit 2`), the true RPO is "since the last
  verified dump" — which is why the verification result is what the runbook trusts,
  not the file's presence.
- **RTO ≤ 4 h** is: provision PostgreSQL (10 min) → restore (§3, 10–40 min
  depending on size) → migrations (2 min) → verify (§4, 20 min) → re-point the app
  and Cerulean (10 min) → sign-off. The number is dominated by waiting on the
  restore, so a rehearsal on a recent dump is what keeps it honest.

## 6. Rehearse

A runbook that has never been run is a hypothesis. Once a quarter:

1. Restore the latest dump into a **scratch** database.
2. Run §4 against it.
3. Record the elapsed time and the verification result in the operations log.

If a rehearsal fails, the fix is to the runbook or the backup, in that order of
suspicion.
