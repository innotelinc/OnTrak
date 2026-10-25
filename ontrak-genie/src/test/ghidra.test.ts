import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAnalyzeArgs,
  extractIndicators,
  formatSummary,
  ghidraHomeCandidates,
  ghidraScriptDir,
  locateGhidra,
  parseSummary,
  runGhidraAnalysis,
  type GhidraInstall,
} from "../ghidra.js";

/**
 * The tool has two halves that fail differently: finding/parsing Ghidra (pure,
 * tested here in full) and actually driving `analyzeHeadless` (a process). The
 * process half is exercised against a stub launcher so the spawn, the argument
 * order and the artefact reading are all real, and against a real Ghidra when
 * the host has one.
 */

const packageRoot = path.resolve(import.meta.dirname, "..", "..");
const fixture = path.join(packageRoot, "ghidra", "fixtures", "ghidra-probe-x86_64");

test("the test binary is a loadable ELF64 x86-64 executable", async () => {
  const binary = await fs.readFile(fixture);
  assert.equal(binary.subarray(0, 4).toString("latin1"), "\u007fELF");
  assert.equal(binary[4], 2, "ELFCLASS64");
  assert.equal(binary[5], 1, "little endian");
  assert.equal(binary.readUInt16LE(16), 2, "ET_EXEC");
  assert.equal(binary.readUInt16LE(18), 0x3e, "EM_X86_64");

  const entry = Number(binary.readBigUInt64LE(24));
  const phoff = Number(binary.readBigUInt64LE(32));
  const phnum = binary.readUInt16LE(56);
  assert.equal(phnum, 1);
  assert.equal(binary.readUInt32LE(phoff), 1, "PT_LOAD");
  assert.equal(binary.readUInt32LE(phoff + 4), 5, "read + execute");
  assert.equal(Number(binary.readBigUInt64LE(phoff + 16)), 0x400000, "load address");
  assert.ok(entry > 0x400000 && entry < 0x400000 + binary.length, "entry inside the segment");
  assert.ok(binary.includes(Buffer.from("ontrak-genie ghidra probe")), "probe string present");
});

test("a Ghidra install is found through GHIDRA_HOME and common locations", async () => {
  const platform = "linux" as const;
  assert.deepEqual(ghidraHomeCandidates({ GHIDRA_HOME: "/opt/ghidra_11.2" }, platform).slice(0, 1), [
    "/opt/ghidra_11.2",
  ]);

  const seen: string[] = [];
  const found = await locateGhidra({
    scriptDir: path.join(packageRoot, "ghidra"),
    env: { GHIDRA_HOME: "/opt/ghidra_11.2" },
    platform,
    exists: async (candidate) => {
      seen.push(candidate);
      return candidate === "/opt/ghidra_11.2/support/analyzeHeadless";
    },
  });

  assert.equal(found?.home, "/opt/ghidra_11.2");
  assert.equal(found?.launcher, "/opt/ghidra_11.2/support/analyzeHeadless");
  assert.ok(seen.length >= 1);
});

test("nothing is reported when no install exists", async () => {
  const found = await locateGhidra({
    scriptDir: packageRoot,
    env: {},
    platform: "linux",
    exists: async () => false,
  });
  assert.equal(found, null);
});

test("the analysis command carries the binary, the script and a clean project", () => {
  const args = buildAnalyzeArgs({
    projectDir: "/tmp/proj",
    projectName: "genie-test",
    binaryPath: "/tmp/probe",
    scriptDir: "/repo/ghidra",
    summaryPath: "/tmp/home/summary.json",
    timeoutSeconds: 300,
  });

  assert.equal(args[0], "/tmp/proj");
  assert.deepEqual(args.slice(2, 4), ["-import", "/tmp/probe"]);
  assert.deepEqual(args.slice(4, 6), ["-scriptPath", "/repo/ghidra"]);
  assert.equal(args[args.indexOf("-postScript") + 1], "ExportSummary.java");
  assert.equal(args[args.indexOf("-postScript") + 2], "/tmp/home/summary.json");
  assert.equal(args[args.indexOf("-analysisTimeoutPerFile") + 1], "300");
  assert.ok(args.includes("-deleteProject"));
});

test("the summary parser accepts Ghidra output and survives partial junk", () => {
  const summary = parseSummary(
    JSON.stringify({
      program: "probe",
      languageId: "x86:LE:64:default",
      architecture: "x86",
      endian: "little",
      compiler: "gcc",
      entryPoints: ["00400078"],
      functionCount: 3,
      functions: ["entry", "write_wrapper"],
      imports: ["write", "exit"],
      exports: ["entry"],
      strings: ["ontrak-genie ghidra probe: ELF64 x86-64"],
      indicators: ["http://198.51.100.7/c2"],
      analyzedAt: "2026-01-01T00:00:00Z",
      durationMs: 1234,
    })
  );
  assert.equal(summary.languageId, "x86:LE:64:default");
  assert.equal(summary.functionCount, 3);
  assert.deepEqual(summary.entryPoints, ["00400078"]);
  assert.equal(summary.indicators[0], "http://198.51.100.7/c2");

  const sparse = parseSummary(
    JSON.stringify({ program: "x", functionCount: "many", entries: null, functions: [1, 2] })
  );
  assert.equal(sparse.functionCount, 0);
  assert.deepEqual(sparse.functions, []);
  assert.equal(sparse.compiler, null);

  assert.throws(() => parseSummary("not json"));
});

test("indicator strings are promoted out of the noise", () => {
  const indicators = extractIndicators([
    "hello world",
    "http://198.51.100.7/gate.php",
    "C:\\Windows\\System32\\cmd.exe /c whoami",
    "just some text",
    "10.0.0.12",
    "hello world",
  ]);
  assert.deepEqual(indicators, [
    "http://198.51.100.7/gate.php",
    "C:\\Windows\\System32\\cmd.exe /c whoami",
    "10.0.0.12",
  ]);
});

test("the rendered summary names the binary and its indicators", () => {
  const text = formatSummary(
    parseSummary(
      JSON.stringify({
        program: "probe",
        languageId: "x86:LE:64:default",
        architecture: "x86",
        endian: "little",
        functionCount: 2,
        entryPoints: ["00400078"],
        imports: ["write"],
        indicators: ["http://example.test/beacon"],
        strings: ["probe"],
        functions: ["entry"],
        durationMs: 42,
      })
    ),
    "fixtures/ghidra-probe-x86_64"
  );
  assert.match(text, /fixtures\/ghidra-probe-x86_64/);
  assert.match(text, /functions: 2/);
  assert.match(text, /http:\/\/example\.test\/beacon/);
});

test("driving analyzeHeadless produces a parsed summary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghidra-stub-"));
  const launcher = path.join(dir, "analyzeHeadless");
  const shim = path.join(dir, "shim.mjs");
  const workDir = path.join(dir, "work");

  // A stand-in for the real launcher: it reads the arguments exactly as Java
  // would and writes the file the post-script is told to write. Everything
  // after this point in the tool is the production path.
  await fs.writeFile(
    shim,
    [
      "import { writeFileSync, readFileSync } from 'node:fs'",
      "const args = process.argv.slice(2)",
      "const scriptIndex = args.indexOf('-postScript')",
      "if (scriptIndex === -1) process.exit(2)",
      "const out = args[scriptIndex + 2]",
      "const binaryIndex = args.indexOf('-import')",
      "const magic = readFileSync(args[binaryIndex + 1]).subarray(0, 4).toString('latin1')",
      "writeFileSync(out, JSON.stringify({",
      "  program: 'ghidra-probe-x86_64',",
      "  languageId: magic === '\\u007fELF' ? 'x86:LE:64:default' : 'unknown',",
      "  architecture: 'x86', endian: 'little', compiler: 'gcc',",
      "  entryPoints: ['00400078'], functionCount: 9,",
      "  functions: ['entry', '_start'], imports: ['write', 'exit'], exports: ['_start'],",
      "  strings: ['ontrak-genie ghidra probe: ELF64 x86-64', 'http://198.51.100.7/gate.php'],",
      "  analyzedAt: new Date().toISOString(), durationMs: 7",
      "}))",
      "console.log('INFO  REPORT: Analysis succeeded')"
    ].join("\n")
  );
  await fs.writeFile(launcher, "#!/bin/sh\n# stub\n");

  const install: GhidraInstall = { home: dir, launcher, scriptDir: path.join(packageRoot, "ghidra") };
  const stubExec = ((
    _file: string,
    args: readonly string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => execFile(process.execPath, [shim, ...args], options as never, callback as never)) as never;

  const { summary, log } = await runGhidraAnalysis({
    binaryPath: fixture,
    install,
    workDir,
    timeoutSeconds: 30,
    exec: stubExec,
  });

  assert.equal(summary.languageId, "x86:LE:64:default", "the stub saw the ELF magic");
  assert.equal(summary.functionCount, 9);
  assert.deepEqual(summary.imports, ["write", "exit"]);
  assert.equal(summary.indicators[0], "http://198.51.100.7/gate.php");
  assert.match(log, /Analysis succeeded/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a launcher that writes nothing is reported, not silently empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ghidra-fail-"));
  const shim = path.join(dir, "shim.mjs");
  await fs.writeFile(shim, "console.error('ERROR: no program to analyse'); process.exit(3)");

  const install: GhidraInstall = {
    home: dir,
    launcher: path.join(dir, "analyzeHeadless"),
    scriptDir: path.join(packageRoot, "ghidra"),
  };
  const stubExec = ((
    _file: string,
    args: readonly string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => execFile(process.execPath, [shim, ...args], options as never, callback as never)) as never;

  await assert.rejects(
    runGhidraAnalysis({ binaryPath: fixture, install, workDir: path.join(dir, "work"), exec: stubExec }),
    /no summary.*exit 3/
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("the post-script ships with the package", async () => {
  const scriptDir = ghidraScriptDir();
  const source = await fs.readFile(path.join(scriptDir, "ExportSummary.java"), "utf8");
  assert.match(source, /extends GhidraScript/);
  assert.match(source, /@category Innotel/);
});

test("a real Ghidra install analyses the fixture", async (t) => {
  const install = await locateGhidra({ scriptDir: ghidraScriptDir() });
  if (!install) {
    t.skip("no Ghidra install on this host (set GHIDRA_HOME to run this test)");
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ghidra-live-"));
  const { summary } = await runGhidraAnalysis({ binaryPath: fixture, install, workDir, timeoutSeconds: 180 });
  assert.ok(summary.functionCount > 0, "Ghidra found functions");
  assert.match(summary.architecture.toLowerCase(), /x86|amd64/);
  await fs.rm(workDir, { recursive: true, force: true });
});
