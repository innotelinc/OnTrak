# Sentinel host agent

A small, single-binary sensor and responder for one host. It reads the host's own state, judges
it against Sentinel's host signatures **on the endpoint**, acts on what the deployment's posture
says to act on without asking, and ships every observation to Guard — so a detection the agent
handled locally and an alert the pipeline raised are the same incident on the same evidence chain.

```
   host state ──▶ local signatures ──▶ action (kill / block / quarantine)
        └──────────── telemetry ─────▶ POST /guard/v1/events ──▶ normalize ──▶ rules ──▶ alerts
```

It is the piece the roadmap named as a non-goal ("we ingest host telemetry from agents we
integrate with"). This is the agent that changes that: the same wire shape, the same rule ids,
and the server still correlates, dedupes and records — the agent just refuses to wait for a round
trip before it defends the machine it is on.

## Build and run

```bash
cd ontrak-sentinel/agent
go build ./cmd/sentinel-agent            # or: go build -o sentinel-agent ./cmd/sentinel-agent

SENTINEL_BASE_URL=https://sentinel.ontrak.innotel.us \
SENTINEL_GUARD_TOKEN=… \
SENTINEL_GUARD_ORGANIZATION=demo \
SENTINEL_AGENT_ENFORCE=1 \
  ./sentinel-agent
```

Cross-compiled binaries are single static files, no runtime to install:

```bash
GOOS=windows GOARCH=amd64 go build -o sentinel-agent.exe ./cmd/sentinel-agent
GOOS=darwin  GOARCH=arm64 go build -o sentinel-agent-mac ./cmd/sentinel-agent
GOOS=linux   GOARCH=arm64 go build -o sentinel-agent-arm ./cmd/sentinel-agent
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SENTINEL_BASE_URL` (or `SENTINEL_ISSUER`) | — | The deployment root. Required. |
| `SENTINEL_GUARD_TOKEN` | — | The Guard ingest token. Required; without it the surface is off server-side too. |
| `SENTINEL_GUARD_ORGANIZATION` | empty | The tenant slug. Empty for a deployment pinned to one organization. |
| `SENTINEL_AGENT_SENSOR` | hostname | This host's name, as telemetry reports it. |
| `SENTINEL_AGENT_SOURCE` | `EDR` | The telemetry source (`EDR`, `EBPF`, …). |
| `SENTINEL_AGENT_INTERVAL_SECONDS` | `30` | Snapshot cadence. |
| `SENTINEL_AGENT_ENFORCE` | `0` | `1` to actually kill processes and edit the host firewall. |
| `SENTINEL_AGENT_ONCE` | `0` | `1` to run one cycle and exit (a deploy smoke test). |

## Response posture — enforcement is opt-in, and that is deliberate

The agent **detects, logs and ships by default, and changes nothing on the host**. Setting
`SENTINEL_AGENT_ENFORCE=1` turns on autonomous action for **medium severity and above**, which is
the posture the deployment asked for. What each signature does:

| Rule | Severity | Action |
| --- | --- | --- |
| `SG-HOST-001` credential-dumping tool | CRITICAL | Kill the process |
| `SG-HOST-002` web server spawned a shell | HIGH | Kill the process |
| `SG-HOST-003` persistence installed | MEDIUM | Recorded and raised; the mechanism is **not** edited automatically |

Killing a process is real; a wrong automated edit to a scheduled task or an `authorized_keys`
file is an outage, so persistence is raised with its evidence and left for a person. Network
blocks (`BLOCK`) exist in the responder — `iptables` on Linux, `pfctl` on macOS, `netsh` on
Windows — and are driven by the server's enforcement register, not invented locally.

## Platform reach

| Platform | Telemetry | Response | Status |
| --- | --- | --- | --- |
| **Linux** | `/proc/net/tcp` connections + `/proc/*` processes | kill, firewall | **Built and tested** (the reference collector). |
| **Windows** | — | kill, firewall | Builds and runs; the collector (ETW / WMI / `GetTcpTable2`) is the next increment. |
| **macOS** | — | kill, firewall | Builds and runs; the collector (`sysctl` / `libproc`) is the next increment. |
| **Android** | — | — | Feasible via a Device-Owner / Work-Profile MDM plus a `VpnService` network filter. Not built. |
| **iOS / iPadOS** | — | — | **Not possible as a background agent.** See below. |

An unsupported platform returns a *named error*, never an empty snapshot: an agent that reports
"nothing happened" when it simply cannot see is worse than one that is not installed.

### iPhone / iPad — the honest answer

A Windows/Linux-style host agent **cannot exist on non-jailbroken iOS**. Apple's sandbox forbids
an app from enumerating other processes, reading their memory, or editing the firewall; there is
no persistent daemon, and background execution is heavily time-boxed. Nothing sentinel-agent does
on a PC is available there.

What *is* possible, in rough order of value:

1. **An MDM / device-management feed** (the family already manages devices). Posture, installed
   profiles, jailbreak status, OS version and app inventory arrive as telemetry; Sentinel
   correlates and alerts on them. This needs no on-device agent — it is an integration, which is
   exactly the shape the roadmap already prefers.
2. **A Network Extension app** — `NEFilterDataProvider` (content filter) or a `Packet Tunnel`
   (VPN) — can inspect and filter *network flows* on the device, delivered as an app extension
   with a user-approved profile or MDM install. This is the closest thing to an IPS on iOS, and
   it is a separate, App-Store-signed product, not a build target of this binary.
3. **Nothing on-device** — ingest from an existing mobile EDR/MDM vendor over the same
   `POST /guard/v1/events` surface. Zero new code on the phone.

The recommendation is (1) or (3): the iPhone becomes a *source* in Guard, not a host running
this agent. (2) is a real option if flow-level filtering on the device is required, but it is a
different product with its own signing and review cycle.

## Layout

```
agent/
  cmd/sentinel-agent/     the entrypoint and the loop wiring
  internal/model/         the one event record, in Guard's wire shape
  internal/collect/       host → observations (Linux /proc reference; other OSes stubbed)
  internal/detect/        local host signatures + the autonomy policy
  internal/respond/       kill / block / quarantine, dry-run by default
  internal/guard/         the one network call: POST /guard/v1/events
  internal/agent/         snapshot → detect → act → ship, as one testable cycle
```

## Test

```bash
cd ontrak-sentinel/agent
go test ./...
go vet ./...
```
