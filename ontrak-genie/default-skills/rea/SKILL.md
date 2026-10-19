---
name: rea
description: |
  Reverse engineer a shipped artifact — a native binary, a JavaScript/Electron app, a
  .NET assembly, an APK, firmware, a website or a saved capture — with REA's MCP tools.
  Use when a question is about what a *finished* build does and the source is not the
  thing being asked about: "how does this feature work", "what does this binary call",
  "what changed between these two versions", "rebuild this behaviour in our project".
  Do not use it for ordinary architecture work in a source repository you already have.
metadata:
  version: "1"
  source: rea-agents
---

# REA in Genie

REA is installed in this deployment and registered as an MCP server. Its tools arrive
in the tool list with the prefix `mcp__rea__`, e.g.:

- `mcp__rea__analyze` — an overview of an app or binary
- `mcp__rea__analyze_javascript_application` — static reconstruction of a local
  JavaScript/Electron application
- `mcp__rea__decompile`, `mcp__rea__function` — code from a native artifact
- `mcp__rea__compare_application_versions` — two versions, side by side
- `mcp__rea__capabilities`, `mcp__rea__doctor` — what this installation can do

The full list is whatever the connected server advertises — read it rather than
assuming, because the tool set depends on which analysis engines are installed. The
workflows, evidence rules and recovery steps are the vendored skill
`reverse-engineer-anything` (also installed here); read it before a first
investigation and follow it rather than improvising a method.

## How it behaves here

- **Read-only REA tools run without an approval prompt.** A tool the server marks
  read-only does nothing, and the console takes that declaration at its word. Any
  other tool asks first, showing the arguments it is about to send.
- **Ghidra is installed** at `GHIDRA_INSTALL_DIR` (`/opt/ghidra`), so native binary
  analysis works out of the box. The other providers are opt-in: IDA, JADX, Kuna and
  JEB need their own installations and are configured with the `REA_*` variables the
  skill documents.
- **`rea` is on the PATH.** The same capability is available from the terminal
  (`rea analyze …`, `rea --help`) when a workflow is easier as a command than as a
  tool call — for example a loop over many files. Both routes produce the same
  evidence; prefer the tool call, so the transcript shows what was asked.
- **Analysis is local.** Artifacts are read where they are; nothing is uploaded.

## What to report

Facts with their evidence: which artifact and version was inspected, which provider
produced a result, and what the result does *not* establish. REA is explicit about
its own limits — pass those on instead of smoothing them over, and never state a
finding the evidence does not carry.
