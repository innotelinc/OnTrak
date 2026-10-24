# REA capture hotfix (rea-agents 6.7.0 on musl)

This image installs `rea-agents` from npm, and its `@lydell/node-pty` prebuild is
linked against glibc. This image's node is musl, so a gcompat shim lets the addon
load and then `forkpty` **segfaults the calling process**. That process is
`rea --mcp` itself: one `capture_process_scenario` call took the MCP server down,
and every tool after it failed.

`install.mjs` backports [morluto/rea#7046](https://github.com/morluto/rea/pull/7046)
into the installed package:

- `ProcessTerminalBackend.js` is the upstream module, transpiled: it reads
  `process.report`'s `glibcVersionRuntime` and picks pipes where the runtime has
  no glibc, importing the native module only on the path that can use it.
- The packaged MCP server runs a rolldown bundle (`dist/mcp/main-*.js`), so the
  patch rewrites the bundle, not only `dist/process/capture/`:
  - the capability probe (`probeProcessCaptureCapability`, which spawns a throwaway
    PTY) now loads the pipe spawner instead of the native module;
  - the capture runtime's spawn call goes through `spawnProcessTerminal()`.
- `dist/process/capture/ProcessHarness.js` gets the same rewrite, for callers that
  load the per-file dist rather than the bundle.
- The run manifest and its output schema hard-code the native backend
  (`pty_backend: "node-pty"`). Both are widened to the two backends the capture
  can actually use, so pipe-captured evidence reports `pipe` instead of claiming
  a terminal it never had — and passes its own validation.

Every replacement is counted. If a future `REA_AGENTS_VERSION` changes the shape
of that code, the build fails instead of shipping a patch that no longer applies.
The script is idempotent, so running it twice is a no-op.

What this does **not** do: a pipe-backed capture cannot observe a TTY, so a
command that calls `isatty()` or draws by terminal size behaves differently, and
6.7.0 has no field to report that limitation. The proper fix is a release that
contains #7046; this hotfix exists so the tool stops crashing the server before
then.
