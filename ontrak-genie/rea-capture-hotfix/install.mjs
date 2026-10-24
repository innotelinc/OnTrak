// Backport of morluto/rea#7046 into the packaged rea-agents 6.7.0 tree.
//
// 6.7.0 always spawns captured commands through @lydell/node-pty. That prebuild
// is linked against glibc; on Alpine a gcompat shim lets it load, and then
// `forkpty` faults the process that called it — `rea --mcp` itself, so one
// capture_process_scenario took the server down.
//
// This installs ProcessTerminalBackend.js (the upstream module, transpiled) and
// rewires both spawn sites: the capability probe and the capture runtime. The
// packaged MCP server runs a rolldown bundle, so the bundle is patched, not only
// the per-file dist. Every replacement is counted: if the surrounding code is
// not the shape this was written against, the script fails instead of guessing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = process.argv[2] ?? "/usr/local/lib/node_modules/rea-agents";
const backendSource = fs.readFileSync(path.join(here, "ProcessTerminalBackend.js"), "utf8");

// A synchronous pipe spawner, for the caller that wants a terminal now rather
// than a promise (the capability probe). Appended once, so re-running is safe.
const backendModule = backendSource.includes("spawnPipeTerminal")
  ? backendSource
  : `${backendSource}
export const spawnPipeTerminal = (executable, args, options) =>
  new PipeTerminal(executable, args, options);
`;

const replaceOnce = (file, text, from, to, label) => {
  const occurrences = text.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${label}: expected one occurrence of ${JSON.stringify(from.slice(0, 70))} in ${file}, found ${occurrences}`,
    );
  }
  return text.replace(from, to);
};

const captureCall = /terminal = spawn\(scenario\.executable, \[\.\.\.scenario\.arguments\], \{([\s\S]*?)\n(\s*)\}\);/;

const patchHarness = (file) => {
  let text = fs.readFileSync(file, "utf8");
  if (text.includes('import("./ProcessTerminalBackend.js")')) return false;
  text = replaceOnce(
    file,
    text,
    'const { spawn } = await import("@lydell/node-pty");',
    'const { spawnProcessTerminal } = await import("./ProcessTerminalBackend.js");',
    "capture import",
  );
  const match = text.match(captureCall);
  if (match === null) throw new Error(`capture spawn call not found in ${file}`);
  text = text.replace(
    captureCall,
    "({ terminal } = await spawnProcessTerminal(scenario.executable, [...scenario.arguments], {$1\n$2}));",
  );
  fs.writeFileSync(file, text);
  return true;
};

const patchBundle = (file) => {
  let text = fs.readFileSync(file, "utf8");
  if (text.includes('import("./ProcessTerminalBackend.js")')) return false;
  // The capability probe: keep its `loadPty` seam, but the default load is the
  // pipe spawner instead of the native module that faults here.
  text = replaceOnce(
    file,
    text,
    'const { spawn } = await (options.loadPty ?? (() => import("@lydell/node-pty")))();',
    'const { spawn } = await (options.loadPty ?? (() => import("./ProcessTerminalBackend.js").then((module) => ({ spawn: module.spawnPipeTerminal }))))();',
    "capability probe",
  );
  text = replaceOnce(
    file,
    text,
    'const { spawn } = await import("@lydell/node-pty");',
    'const { spawnProcessTerminal } = await import("./ProcessTerminalBackend.js");',
    "bundle capture import",
  );
  const match = text.match(captureCall);
  if (match === null) throw new Error(`capture spawn call not found in ${file}`);
  text = text.replace(
    captureCall,
    "({ terminal } = await spawnProcessTerminal(scenario.executable, [...scenario.arguments], {$1\n$2}));",
  );
  fs.writeFileSync(file, text);
  return true;
};

// The run manifest names the backend it used. 6.7.0 hard-codes the native one,
// which would make pipe-captured evidence claim a terminal it never had.
const patchManifestBackend = (file) => {
  let text = fs.readFileSync(file, "utf8");
  if (text.includes("pty_backend: processTerminalBackend()")) return false;
  text = replaceOnce(
    file,
    text,
    'pty_backend: "node-pty",',
    "pty_backend: processTerminalBackend(),",
    "manifest backend",
  );
  if (!text.includes('processTerminalBackend } from "./ProcessTerminalBackend.js"')) {
    text = `import { processTerminalBackend } from "./ProcessTerminalBackend.js";\n${text}`;
  }
  fs.writeFileSync(file, text);
  return true;
};

// The output schema pins the backend name to the native one too, so a pipe
// capture would fail its own validation. Widen the literal to the two backends
// the capture can actually use.
const patchSchema = (file) => {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes('pty_backend: z.literal("node-pty")')) return false;
  fs.writeFileSync(
    file,
    replaceOnce(
      file,
      text,
      'pty_backend: z.literal("node-pty")',
      'pty_backend: z.enum(["node-pty", "pipe"])',
      "backend schema",
    ),
  );
  return true;
};

const copyBackend = (directory) => {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "ProcessTerminalBackend.js");
  fs.writeFileSync(target, backendModule);
  return target;
};

const changed = [];
const mcpDir = path.join(packageRoot, "dist", "mcp");
const captureDir = path.join(packageRoot, "dist", "process", "capture");

copyBackend(mcpDir);
if (fs.existsSync(captureDir)) copyBackend(captureDir);

if (fs.existsSync(captureDir)) {
  const harness = path.join(captureDir, "ProcessHarness.js");
  if (fs.existsSync(harness) && patchHarness(harness)) changed.push(harness);
  const lifecycle = path.join(captureDir, "ProcessCaptureLifecycle.js");
  if (fs.existsSync(lifecycle) && patchManifestBackend(lifecycle)) changed.push(lifecycle);
}

const schemaCandidates = [
  path.join(packageRoot, "dist", "domain", "process", "processCapture.js"),
  ...fs
    .readdirSync(path.join(packageRoot, "dist", "mcp"))
    .filter((name) => /^toolOutputSchemaGroups-.*\.js$/u.test(name))
    .map((name) => path.join(packageRoot, "dist", "mcp", name)),
  ...fs
    .readdirSync(path.join(packageRoot, "dist", "cli-runtime"))
    .filter((name) => /^reconstructionObligationLedgerSchemas-.*\.js$/u.test(name))
    .map((name) => path.join(packageRoot, "dist", "cli-runtime", name)),
];
for (const schema of schemaCandidates) if (patchSchema(schema)) changed.push(schema);

const bundles = fs
  .readdirSync(mcpDir)
  .filter((name) => /^main-.*\.js$/u.test(name))
  .map((name) => path.join(mcpDir, name));
if (bundles.length === 0) throw new Error(`no MCP bundle found in ${mcpDir}`);
for (const bundle of bundles) {
  let patched = patchBundle(bundle);
  patched = patchManifestBackend(bundle) || patched;
  if (patched) changed.push(bundle);
}

console.log(changed.length === 0 ? "capture hotfix already installed" : `patched ${changed.join(", ")}`);
