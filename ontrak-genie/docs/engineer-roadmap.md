# OnTrak Engineer — roadmap

> **Re-baselined at 2.0 (2026-10-24).** The shipped add-on is **2.0.0**; the next
> minor milestones are 2.1, 2.2, 2.3, and the next majors are 3.0 and 4.0. The
> portfolio view is [../../docs/portfolio-roadmap-v2.md](../../docs/portfolio-roadmap-v2.md).
>
> Status legend: `[x]` shipped · `[~]` in progress · `[ ]` planned.

## 1. Vision

Point an agent at a shipped application and get back how it works — with evidence
a person can check, not a paragraph they have to trust.

Engineer is an add-on to [OnTrak Genie](roadmap.md), reached at
`re.genie.innotel.us`: the same console, the same jail and gate, with the reverse
engineering tool set (REA over MCP, Ghidra in the image) and a meter in front of
it.

## 2. 2.0.0 — shipped baseline `[x]`

- `[x]` **The analysis itself.** REA's tools arrive over MCP
  (`src/mcp-tools.ts`) and Ghidra does the native work in the Genie image; the
  agent reads the build, runs the tools and reports what it found.
- `[x]` **Metered per project, not per minute.** One credit per project at $5,
  priced by Magnate, spent against the balance the Distro control plane holds
  (`src/engineer.ts`).
- `[x]` **The charge is idempotent** — the project id is the idempotency key, so
  a retry, a reload or a second tab charges once.
- `[x]` **A refusal is an answer, not an error** — a 402 the page acts on ("buy
  some"), a 503 it can retry, and a deployment with no control plane keeps
  working unmetered (`gated: false`).
- `[x]` **Reached under Genie's name** at `re.genie.innotel.us`, behind the same
  Cerulean sign-in and the same role gate as the console.

**2.0 exit:** a person points Engineer at a build and gets an analysis back, with
exactly one credit spent and the ledger row naming the project.

## 3. Next

### 2.1 — Evidence export `[ ]`

**Goal:** the analysis leaves the building.

- `[ ]` Export a signed assurance packet: report, tool transcript, artefact hashes
  and the model/agent identity, in the family's shared packet format.
- `[ ]` Exit: a packet verifies without the console, by the same verifier Tix and
  Sentinel packets use.

### 2.2 — Build diff `[ ]`

- `[ ]` Compare two builds of the same application and report what changed
  (symbols, sections, imports, strings).
- `[ ]` Exit: an injected change between two builds is named by symbol and by
  offset, and a no-op rebuild reports no change.

### 2.3 — Analysis depth `[ ]`

- `[ ]` A recorded static-analysis chain — disassembly, strings, imports, call
  graph — attached to the report as evidence rather than described in prose.
- `[ ]` Exit: every claim in the report cites the tool output that supports it.

### 3.0 — Multi-binary project workspace `[ ]`

- `[ ]` One project spanning an application and its libraries, installers and
  services, with cross-binary references resolved.

### 4.0 — Continuous release analysis `[ ]`

- `[ ]` Watch upstream builds and deliver a diff report per release, metered under
  the same project rule.

## 4. Boundaries

- Engineer does not become a disassembler UI: Ghidra already has one, and the
  product is the agent's evidence-backed answer.
- It does not hold a second ledger; credits are the control plane's.
- It does not run unsandboxed; every tool call meets Genie's jail and gate.
