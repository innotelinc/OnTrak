# Upstream findings — Olympus

Three things found while making Genie's factory handoff real end to end: Genie
exported a spec, Olympus manufactured an application from it, and the application
was then packaged and run through Olympus's own `package-project.py` → `app-runtime.py`
path. Everything below was reproduced on a scratch checkout, and the parts that are
a diff apply to it cleanly.

Nothing here is a request to change what the factory *builds*. Each item is a place
where a person following the documented workflow hits a wall that does not explain
itself, and the fix is small enough to send.

## What is in this directory

| File | What it is |
| --- | --- |
| `patches/olympus-container-build.patch` | A diff against three files: the `Makefile` target that leaves the manufactured app inside a container, a compose override for nested user namespaces, and a runbook for the rest of the gates. Applies to a clean checkout with `git apply`. |
| this file | The write-up, including the one change that is deliberately **not** a diff (it would carry a deployment address), and two findings that are diagnosis rather than patch. |

Apply it:

```bash
git apply --check docs/patches/olympus-container-build.patch   # then:
git apply         docs/patches/olympus-container-build.patch
```

## 1. A checkout cannot run its own workflow (`.archon/config.yaml`)

**Says:** *"Invalid assistants config in '/app/.archon/config.yaml':
'assistants.codex.apiBaseUrl': unknown provider setting"* — before the first node.

**Is:** the committed config writes `apiBaseUrl` and `defaultModel` for both
assistants. The engine's codex run-config schema takes `model`,
`modelReasoningEffort`, `webSearchMode`, `additionalDirectories` and
`codexBinaryPath` — nothing else — and refuses an unknown key outright. Removing
`apiBaseUrl` and renaming `defaultModel` → `model` lets the source capture and the
DAG start, and costs the gateway nothing, because `build-app.py` writes the run's own
`CODEX_HOME` config from `OMNIROUTE_BASE_URL`/`OMNIROUTE_API_KEY`: the assistant
never needed an address in this file to reach anything.

**Why it is written out here instead of as a diff:** the key's *value* is a
deployment address, so a faithful diff would contain one, and this repository may
not carry real addresses — that is the same rule the change itself is about. The
edit, on a checkout:

```bash
# apiBaseUrl goes entirely; defaultModel becomes model. Under `assistants:`, both
# `codex:` and `claude:` need it.
python3 - <<'PY'
import pathlib, re
p = pathlib.Path(".archon/config.yaml")
text = p.read_text(encoding="utf-8")
text = re.sub(r"^[ \t]*apiBaseUrl:.*\n", "", text, flags=re.M)
text = re.sub(r"^([ \t]*)defaultModel:", r"\1model:", text, flags=re.M)
p.write_text(text, encoding="utf-8")
PY
```

## 2. A manufactured app does not reach the tooling that packages it

**Says:** the workflow reports `[record] ... {"files": 8, "bytes": 10143}`, and the
next command answers *"no build at builds/<slug> — package it first"*.

**Is:** `builds/` is a named volume (`olympus-builds:/app/builds`) and every
consumer of it — `app-package`, `site-package`, `app-up`, `apps-list` — resolves
`./builds/<slug>` in the checkout. Measured: the app existed only inside the
container, and the two filesystems looked like two different builds of one spec.

**Fix (in the patch):** `make docker-app` copies the tree out of the volume when the
run succeeds. `mkdir -p builds` first, because on a fresh clone there is no
`builds/` here at all and the container's copy is made by the entrypoint. The
alternative — bind-mounting `./builds:/app/builds` — was not taken on purpose: the
volume is what keeps the build's root-owned writes and its `node_modules` out of the
operator's checkout, and the copy-back keeps that while still putting the artifact
where packaging reads it.

## 3. A plan can name a `run.start` its own runtime image cannot execute

**Says:** nothing, at first. The image builds, the container starts, and six
health-check attempts later the log has one line: `sh: python3: not found`.

**Is:** the plan was `runtime.language: node` with `install: npm install`, so
`package-project.py` built `node:24-alpine` — an image where `python3` is installed
in the **build** stage (for native modules) and the published stage is a fresh base
plus `COPY --from=build`, deliberately, so the toolchain never reaches a running
container. The project's own `npm start` shells out to `python3`. Nothing in the
packaging path reads the project — the packager says so in its own header, and that
is a defensible boundary — and nothing runs the start command until a person asks
for the app, so no automated step saw it.

**The demonstrated resolution, and it is not the language field alone.** The
artifact is static files, and the planner's own instructions (in both
`scripts/project_plan.py` and `web/studio/lib/plan.ts`) already describe that shape:
`static`, no toolchain, no process, `install` and `build` empty. Corrected that way,
the same artifact packaged and ran — nginx serving it, healthcheck passing, loopback
only, listed by `make apps-list`. Merely relabelling is not enough and the packager
is right to refuse it:

    PACKAGE_PROJECT_FAILED: the plan says the language is 'static' but also asks to
    install or build.

**Two things worth adding, in order of how much they would have helped:**

1. **Run the thing you just built, before calling it packaged.**
   `package-project.py` knows the port and the healthcheck from the plan, and
   `app-runtime.py` already has the polling loop. Starting the image once, waiting
   for its own health check, and failing the *package* with the container's log
   turns six silent restarts at run time into one refusal at build time, with the
   interpreter's name in it. That is the only check that catches this class of
   fault — the fault is inside the project's own start script, so no static check of
   the plan can see it without reading the project.
2. **Prefer `static` when a plan has nothing to install and nothing to build.**
   That is a rule about the plan, not about the project, and it is checkable where
   the plan is parsed — so the contradiction shows up at confirmation, next to the
   person who can fix it, rather than at the health check.

## Two cautions, no patch

- **`REPLACE=1` deletes the previous build before the run can fail.** A plan turn
  the gateway refuses costs the last artifact, and leaves an empty `builds/<slug>`
  that still looks like a build to anything that only checks for the directory.
  Measured, at cost. Deferring the delete until the first file is written, or
  moving the old tree aside until `[record]`, would make a failed rebuild free.
- **A built image cannot stand in for the build directory.** The packager's
  generated `.dockerignore` excludes `plan.json` and `project.manifest.json`, so
  recovering an app from its own image gets its files and not its plan — and the
  plan is what `app-runtime.py` reads to decide how to run it. Plainly correct for
  what the image is for; worth knowing before treating an image as a backup.

## What was verified, and what is still gated

Verified on a scratch checkout: the five container gates with their literal
messages and fixes; a spec exported from Genie manufacturing to `[record]` with 8
files; packaging and running that artifact through `package-project.py` and
`app-runtime.py` (healthy, serving, `apps-list`); its own `node --test` at 5/5 from
the checkout; the `static`-with-install refusal; and the patch applying cleanly.

Not verified: a full `make docker-app` run *after* the copy-back fix. The gateway's
configured chain was out of budget and the model that had carried the previous build
was on a 400-second credential cooldown, so the run failed at `[plan]` — which is
itself the third caution above, observed. The copy-back line was verified against the
container's volume directly, and the patch's `git apply --check -R` proves it applies.
