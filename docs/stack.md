# OnTrak in the Innotel Platform Stack

**Role: TrainingOps** — OnTrak provides disposable, deliberately broken practice machines
and the grading that goes with them. It is the environment where support skills are
rehearsed and assessed; it is not where anything runs in production.

Canonical definition of the ecosystem:
[Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).

## Boundaries

### Owns

- The **workload catalog**: manifests for every supported guest platform (Windows 95 →
  present, Windows Server NT 4.0 → 2025, Office 97 → 2024/Microsoft 365 Apps, every Linux
  distribution the image server publishes), including device profiles for platforms that
  predate VirtIO and Secure Boot.
- **Training media management**: which media is freely redistributable (fetched) and which
  is operator-supplied under their own licence (never downloaded).
- The **scenario format and its grading contract**: `scenario.yaml` objectives,
  `setup.ps1` fault injection, `check.ps1` live-state grading, progressive hints, the
  score/pass-mark model, and the validation that keeps a scenario from silently scoring zero.
- **Fault primitives and scenario generation** from reviewed, reversible faults.
- The **session lifecycle**: template build → clean snapshot → warm pool → clone → hand over
  → grade → submit → destroy, plus per-session time limits and reset policy.
- The **student portal** and the **operator CLI/instructor view** for the range itself.

### Consumes

- **Cerulean — identity**: the portal is a student/instructor login surface and is expected
  to sit behind Authentik SSO in a deployment. Local accounts exist so a range can run
  air-gapped for a class day.
- **Cerulean — trust (DNS + TLS)**: the portal host and the browser-console host, including
  the wildcard certificate. Public hostnames are provisioned through Cerulean, never by
  hand, and no stack script calls the NPM API directly.
- **Cerulean Vault — secrets**: guest password and portal/Guacamole keys in production.
  `.env` is local-only and gitignored.
- **ONYX — storage**: where built guest images, template snapshots and backups life. The
  lab host's own Incus storage pool is the working tier; ONYX is the durable tier.
- **Magnate — billing (optional)**: if a range is ever sold as a paid course, entitlements
  come from Magnate. Nothing in OnTrak bills today.
- **NPM Edge — edge**: the portal and console are served through the edge, consuming the
  DNS records and certificates issued by Cerulean.

### Does not own

- Identity, secrets, DNS, TLS, storage replication, billing, telephony or edge routing.
  OnTrak calls the platform services for these or runs air-gapped without them.
- The hypervisor. Incus is consumed as infrastructure (`infra/bootstrap-host.sh` prepares
  the host); OnTrak does not wrap it, and the training machines are not containers — the
  container stack carries the control plane only.
- The browser-console gateway's upstream software: Guacamole and guacd are deployed from
  their own images (`deploy/guacamole/`), not forked or vendored.
- Course content, assessment policy or student records of record. OnTrak stores results for
  the range; the institution's grading system is the system of record.

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| Control plane | Python 3.11+ (`ontrak/`) | Catalog, scenarios, sessions, scoring, CLI, portal. Runs on the host (`make serve`) or as the `portal` container (`make up`) |
| Container stack | Docker Compose (`docker-compose.yml`) | The control plane and the console gateway as services; host Incus reached over its socket when present (docs/docker.md) |
| Hypervisor | Incus on Ubuntu + KVM | Guest VMs (Windows, Linux desktop) and system containers (Linux server). **Host infrastructure, never containerised** — a guest that must boot a real kernel and hold a driver fault is a VM |
| Storage | ZFS or btrfs pool | Copy-on-write clones make reset and handout cheap |
| Warm pool | `ontrak pool` / `ontrak schedule` | Pre-booted, unclaimed clones per scenario |
| Console gateway | Apache Guacamole + guacd | HTML5 RDP into student machines with signed, encrypted single-session links |
| Guest automation | WinRM (`winrm-ps51`), Incus agent, or SSH | Drives scenario setup/check scripts and credential rotation |
| Catalog | YAML manifests in `catalog/` | Describes platforms, media, device profiles and provisioning plans |
| Portal | FastAPI + Jinja templates | Student login, tickets, console, time limits, Complete & End, results |
| Datastore | SQLite (WAL) | Users, sessions, submitted results, events |

## In the ecosystem

- **Identity** — Authentik (inside Cerulean) fronts the portal; OnTrak keeps a local
  fallback so a class can run without a network dependency.
- **Secrets** — Cerulean Vault (KV v2) is the production posture; references take the
  `vault://<mount>/<path>#<key>` form. `.env` carries resolved values only for local use.
- **Trust** — the range's three names are issued through Cerulean (DNS, the
  `*.ontrak.innotel.us` wildcard plus the apex certificate, and the edge hosts), by
  `scripts/cerulean-provision.py` over Cerulean's **service bridge** — the only unattended
  door, since the local admin password is break-glass and a session exists only for a
  browser OIDC flow. It needs a `ceru_` service key scoped `domains, dns, certs, npm`
  (Platform → *Service API keys*), is idempotent, plans before it writes, and refuses to
  repoint an edge host that is already serving a name. The Guacamole JSON-auth key is a
  repository-independent secret that must match across `ONTRAK_GUAC__SECRET_KEY` and the
  gateway's `JSON_SECRET_KEY`.
- **Trust — the names** — `ontrak.innotel.us` is the range, `student.ontrak.innotel.us`
  what a student is given, `admin.ontrak.innotel.us` what an instructor is given; all
  three answer on the same portal, which is role-gated at sign-in. Every origin needs its
  own OIDC callback registered (`AUTHENTIK_*_REDIRECT_URI` takes the list).
- **Storage** — built images and snapshots live on the lab host's Incus pool for speed;
  the durable copy and backups belong to ONYX.
- **Revenue** — no billing integration today. If ranges are sold per seat, entitlements come
  from Magnate.
- **Edge** — the portal and console are published through NPM Edge using Cerulean-issued
  certificates.

## Related platform boundaries

- **ONYX (StorageOps)** — the tier that holds golden images and snapshot backups long-term;
  OnTrak consumes it and never re-implements replication or backup policy.
- **Cerulean (TrustOps / IdentityOps)** — OnTrak does not run its own CA, DNS server or IdP.
- **Distro / Atlas (CodeOps / GitOps)** — unrelated: nothing from this repository is deployed
  by them, and no artifact here is a runtime service for another platform.
