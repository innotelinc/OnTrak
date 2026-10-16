/**
 * Unit tests for the CLI's pure parts: argument parsing, the command table,
 * skills, the turn reducer, the follow-up suggester, SSE frame parsing and the
 * renderer's text handling.
 *
 * The pieces are tested here rather than through a terminal because they are
 * where the decisions live — what a `/` line means, what a skill composes to,
 * what a turn is allowed to suggest — and a terminal adds no information to
 * any of them. The wire behaviour is covered by `cli-handoff.test.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { dataOf, parseEvent } from "../cli/client.js";
import {
  COMMANDS,
  findCommand,
  helpLines,
  matchCommands,
  parseCommand,
  tokenize,
} from "../cli/commands.js";
import { configPath, defaultSkillsDir, normalizeUrl, resolveTarget, skillDirs, writeConfig } from "../cli/config.js";
import {
  emptyTurnSummary,
  reduceTurn,
  suggestFollowups,
  summarizeEvents,
} from "../cli/followups.js";
import {
  findProject,
  formatProjectRow,
  parseProjectsCommand,
  parseProjectsLine,
  ProjectUsageError,
} from "../cli/projects.js";
import {
  parseRemoteCommand,
  parseRemoteLine,
  parseRemoteTarget,
  RemoteUsageError,
  runRemote,
} from "../cli/remote.js";
import {
  SkillUsageError,
  parseSkillsCommand,
  parseSkillsLine,
  runSkills,
} from "../cli/skills.js";
import type { GenieClient, RemoteList } from "../cli/client.js";
import { MarkdownStream, Theme, clip, renderDiff, summarizeArgs, wrap } from "../cli/render.js";
import { composeSkillMessage, describeSkills, loadSkills, parseSkill, slug } from "../cli/skills.js";
import { indexSessions } from "../cli/main.js";
import { parseArgs } from "../cli/main.js";
import type { AgentEvent } from "../agent.js";
import type { FileDiff } from "../diff.js";
import type { ProjectView } from "../projects.js";

const plain = new Theme(false);

/* ------------------------------------------------------------- parseArgs */

test("parseArgs reads a subcommand, its arguments and the flags around it", () => {
  const args = parseArgs(["ask", "run", "the", "tests", "--model=x", "--no-color"]);
  assert.equal(args.command, "ask");
  assert.deepEqual(args.rest, ["run", "the", "tests"]);
  assert.equal(args.model, "x");
  assert.equal(args.color, false);
});

test("parseArgs accepts a flag value as the next word", () => {
  const args = parseArgs(["--url", "https://genie.example", "sessions"]);
  assert.equal(args.url, "https://genie.example");
  assert.equal(args.command, "sessions");
});

test("parseArgs treats an unknown flag as a typo, not a task", () => {
  // A silent ignore would send `--mdoel gpt` to the agent as a task.
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
});

test("parseArgs keeps a bare dash as a positional", () => {
  const args = parseArgs(["ask", "-"]);
  assert.equal(args.command, "ask");
  assert.deepEqual(args.rest, ["-"]);
});

/* ---------------------------------------------------------- command table */

test("every command is reachable by name and by alias", () => {
  for (const command of COMMANDS) {
    assert.equal(findCommand(command.name)?.name, command.name);
    for (const alias of command.aliases ?? []) {
      assert.equal(findCommand(alias)?.name, command.name, `alias ${alias} must resolve`);
    }
  }
});

test("a non-command line is a task, not an error", () => {
  assert.equal(parseCommand("fix the tests"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand("   "), null);
});

test("an unknown slash word is not silently swallowed as a task", () => {
  // Returning null here is what makes `/nonsense` fall through to the agent,
  // which is wrong — the REPL only calls parseCommand after deciding the line is
  // a command, so the contract is that an unknown word resolves to null and the
  // caller reports it. Pin the null so the caller keeps that job.
  assert.equal(parseCommand("/nonsense"), null);
});

test("parseCommand separates the command from its arguments", () => {
  const parsed = parseCommand("/resume 3");
  assert.equal(parsed?.command.name, "resume");
  assert.deepEqual(parsed?.args, ["3"]);
  assert.equal(parsed?.rest, "3");
});

test("parseCommand honours quotes for a title and for a skill task", () => {
  assert.deepEqual(parseCommand('/rename "release prep"')?.args, ["release prep"]);
  const skill = parseCommand("/skill release-check verify the tag");
  assert.equal(skill?.command.name, "skill");
  assert.equal(skill?.rest, "release-check verify the tag");
});

test("tokenize splits on whitespace but keeps quoted runs together", () => {
  assert.deepEqual(tokenize('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(tokenize("   "), []);
});

test("a subcommand's own flags reach it from a shell, not only from the REPL", () => {
  /*
   * `genie remote ssh host:/path --key-file id` and `genie skills add a/b --dir x`
   * read their flags themselves, because the REPL has no argv: there they are just
   * words on the line. This parser once refused every one of them, so the flags
   * the help documented worked only *inside* the REPL — and a shell answered
   * "unknown option --key-file", which is the opposite of what the help said.
   */
  const skills = parseArgs(["skills", "add", "acme/skills", "--dir", "/tmp/x"]);
  assert.equal(skills.command, "skills");
  assert.deepEqual(skills.rest, ["add", "acme/skills", "--dir", "/tmp/x"], "passed through, value and all");

  const remote = parseArgs(["remote", "ssh", "root@host:/srv", "--port", "2222"]);
  assert.equal(remote.command, "remote");
  assert.deepEqual(remote.rest, ["ssh", "root@host:/srv", "--port", "2222"]);

  // A command that owns no such flags still gets the typo reported.
  assert.throws(() => parseArgs(["whoami", "--wat"]), /unknown option --wat/);
  assert.throws(() => parseArgs(["--wat"]), /unknown option --wat/);
});

test("the palette offers prefix matches only, and nothing once a space is typed", () => {
  assert.deepEqual(
    matchCommands("/re").map((command) => command.name),
    ["resume", "rename", "remote"],
  );
  assert.deepEqual(matchCommands("/resume 3"), []);
  // Aliases count: `/ls` is `sessions`.
  assert.deepEqual(
    matchCommands("/ls").map((command) => command.name),
    ["sessions"],
  );
});

test("the help text carries every command", () => {
  const text = helpLines().join("\n");
  for (const command of COMMANDS) {
    assert.ok(text.includes(`/${command.name}`), `${command.name} must appear in help`);
  }
});

/* ----------------------------------------------------------------- skills */

const SKILLS_OPTIONS = { json: false, project: false };

test("the skills subcommands are one table, and a bare `skills` lists", () => {
  assert.deepEqual(parseSkillsCommand([]), { sub: "list", args: [] });
  assert.deepEqual(parseSkillsCommand(["ls"]), { sub: "list", args: [] });
  assert.deepEqual(parseSkillsCommand(["install", "pbakaus/impeccable"]), {
    sub: "add",
    args: ["pbakaus/impeccable"],
  });
  assert.deepEqual(parseSkillsCommand(["uninstall", "audit"]), { sub: "remove", args: ["audit"] });
  assert.throws(() => parseSkillsCommand(["wibble"]), /try list, add or remove/);
  // A subcommand is found as a word, never through the prototype.
  assert.throws(() => parseSkillsCommand(["constructor"]), SkillUsageError);
});

test("the skills flags are read from the line as well as from the shell", () => {
  const parsed = parseSkillsLine(
    ["add", "acme/skills", "--path", "audit", "--name=review", "--ref", "v1", "--project"],
    SKILLS_OPTIONS,
  );
  assert.deepEqual(parsed.invocation, { sub: "add", args: ["acme/skills"] });
  assert.equal(parsed.options.path, "audit");
  assert.equal(parsed.options.name, "review");
  assert.equal(parsed.options.ref, "v1");
  assert.equal(parsed.options.project, true);
  assert.equal(parsed.options.dir, undefined, "a flag nobody gave stays unset");

  assert.throws(() => parseSkillsLine(["list", "--wat"], SKILLS_OPTIONS), /unknown option --wat/);
});

test("`genie skills add` installs from the line, and refuses a non-GitHub name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genie-cli-skills-"));
  const lines: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (url.includes("/git/trees/")) {
      return { ok: true, status: 200, json: async () => ({ tree: [{ path: "skills/audit/SKILL.md", type: "blob" }] }) } as unknown as Response;
    }
    if (url.includes("/repos/")) {
      return { ok: true, status: 200, json: async () => ({ default_branch: "main" }) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from("---\nname: audit\ndescription: Review it\n---\nLook closely.\n"),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const code = await runSkills({
    invocation: { sub: "add", args: ["acme/skills"] },
    skills: [],
    dirs: [dir],
    installDir: dir,
    theme: plain,
    options: { ...SKILLS_OPTIONS, path: "audit" },
    fetchImpl,
    write: (line) => lines.push(line),
  });
  assert.equal(code, 0);
  assert.match(lines[0] ?? "", /^installed audit \(1 files\) into /);
  assert.ok(fs.existsSync(path.join(dir, "audit", "SKILL.md")));

  await assert.rejects(
    () =>
      runSkills({
        invocation: { sub: "add", args: ["gitlab.com/acme/skill"] },
        skills: [],
        dirs: [dir],
        installDir: dir,
        theme: plain,
        options: SKILLS_OPTIONS,
        write: (line) => lines.push(line),
      }),
    /is not a GitHub repository/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- remote */

/* ---------------------------------------------------- where skills live */

test("a deployment's CLI installs where the console looks, and reads it back", () => {
  /*
   * `AGENT_DATA_DIR` means this process is the *deployment's*, not a person's: the
   * console reads `<it>/skills` and not this container's home, so a skill installed
   * into `/root/.config/ontrak-genie/skills` was a command that reported success and
   * changed nothing any chat could see.
   */
  const previous = process.env.AGENT_DATA_DIR;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "genie-cli-data-"));
  try {
    process.env.AGENT_DATA_DIR = data;
    assert.equal(skillDirs("/app").at(-1), path.join(data, "skills"), "the deployment's is read too");
    assert.equal(defaultSkillsDir("/app"), path.join(data, "skills"), "and it is where `add` writes");
  } finally {
    if (previous === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = previous;
  }

  // A laptop: no deployment to answer to, so the person's own directory wins.
  assert.equal(defaultSkillsDir("/app"), path.join(path.dirname(configPath()), "skills"));
  assert.equal(
    skillDirs("/app").at(-1),
    path.join("/app", ".genie", "skills"),
    "and `./.genie/skills` is the last thing read",
  );
});

const REMOTE_OPTIONS = {
  json: false,
  passwordStdin: false,
  tokenStdin: false,
  github: false,
};

/** Collect what a command writes, since the CLI's commands write to stdout. */
function captureStdout(): { text: () => string; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { text: () => chunks.join(""), restore: () => void (process.stdout.write = original) };
}

/** A client where only the calls a case makes exist. */
function stubClient(overrides: Partial<GenieClient>): GenieClient {
  return overrides as unknown as GenieClient;
}

test("a remote target is read the way ssh spells one, and a half one is refused", () => {
  assert.deepEqual(parseRemoteTarget("root@192.168.1.90:/srv/app"), {
    user: "root",
    host: "192.168.1.90",
    path: "/srv/app",
  });
  assert.deepEqual(parseRemoteTarget("deploy@dev.example.com:/srv/my app"), {
    user: "deploy",
    host: "dev.example.com",
    path: "/srv/my app",
  });
  // The path is *not* checked here — the server owns that fence (`remote-rules.ts`)
  // and would refuse a relative one — but a target with no user or no path is not a
  // target at all, and saying so is better than a request that comes back refused.
  for (const bad of ["192.168.1.90:/srv/app", "root@192.168.1.90", "root@:/srv", "@host:/x", ""]) {
    assert.throws(() => parseRemoteTarget(bad), RemoteUsageError, `refused: ${bad}`);
  }
});

test("`genie remote` on its own lists, and the subcommands are one table", () => {
  assert.deepEqual(parseRemoteCommand([]), { sub: "list", args: [] });
  assert.deepEqual(parseRemoteCommand(["ls"]), { sub: "list", args: [] });
  assert.deepEqual(parseRemoteCommand(["mount", "root@h:/p"]), { sub: "ssh", args: ["root@h:/p"] });
  assert.deepEqual(parseRemoteCommand(["create", "app"]), { sub: "new", args: ["app"] });
  assert.deepEqual(parseRemoteCommand(["pull-request", "genie/x"]), { sub: "pr", args: ["genie/x"] });
  assert.deepEqual(parseRemoteCommand(["run"]), { sub: "run", args: [] });
  assert.throws(() => parseRemoteCommand(["wibble"]), /try list, ssh, disconnect, atlas, new, clone, run, push or pr/);
  // A subcommand is found as a word, never through the prototype.
  assert.throws(() => parseRemoteCommand(["constructor"]), RemoteUsageError);
});

test("the remote flags are read from the line as well as from the shell", () => {
  const parsed = parseRemoteLine(
    ["clone", "acme/widgets", "--github", "--dir", "app", "--branch=dev", "--token-stdin"],
    REMOTE_OPTIONS,
  );
  assert.deepEqual(parsed.invocation, { sub: "clone", args: ["acme/widgets"] });
  assert.equal(parsed.options.github, true);
  assert.equal(parsed.options.dir, "app");
  assert.equal(parsed.options.branch, "dev");
  assert.equal(parsed.options.tokenStdin, true);
  assert.equal(parsed.options.passwordStdin, false, "a flag nobody gave stays unset");

  const ssh = parseRemoteLine(["ssh", "root@h:/p", "--key-file", "/tmp/id", "--port", "2222"], REMOTE_OPTIONS);
  assert.equal(ssh.options.keyFile, "/tmp/id");
  assert.equal(ssh.options.port, 2222);

  // `--command` is what says "run this instead of what the project says", and a
  // command with spaces in it survives quoting as one value.
  const run = parseRemoteLine(["run", "--command", "npm run dev -- --host"], REMOTE_OPTIONS);
  assert.deepEqual(run.invocation, { sub: "run", args: [] });
  assert.equal(run.options.command, "npm run dev -- --host");
  assert.equal(parseRemoteLine(["run"], REMOTE_OPTIONS).options.command, undefined);

  assert.throws(() => parseRemoteLine(["list", "--wat"], REMOTE_OPTIONS), /unknown option --wat/);
  assert.throws(() => parseRemoteLine(["ssh", "root@h:/p", "--port", "abc"], REMOTE_OPTIONS), /needs a number/);
});

test("`genie remote run` runs the project here, through the same route the pane uses", async () => {
  const asked: Array<Record<string, unknown>> = [];
  const status = {
    running: true,
    command: "npm run dev",
    cwd: ".",
    port: 5173,
    url: "/preview/",
    address: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    exitCode: null,
    error: null,
    log: "",
    detected: true,
  };
  const client = stubClient({
    runProject: (async (input: Record<string, unknown>) => {
      asked.push(input);
      return status;
    }) as unknown as GenieClient["runProject"],
  });

  const captured = captureStdout();
  try {
    const code = await runRemote(client, plain, { sub: "run", args: [] }, REMOTE_OPTIONS);
    assert.equal(code, 0);
  } finally {
    captured.restore();
  }

  // No command: the server works one out from the project, which is what makes a
  // repository created on a forge runnable without naming anything.
  assert.deepEqual(asked, [{}]);
  assert.match(captured.text(), /running `npm run dev` in \./);
  assert.match(captured.text(), /listening on port 5173/);
});

test("`genie remote run` says what the server could not work out, and exits non-zero", async () => {
  const captured = captureStdout();
  let code = 0;
  try {
    code = await runRemote(
      stubClient({
        runProject: (async () => ({ running: false, command: null, cwd: null, port: null, url: "/preview/", address: null, startedAt: null, exitCode: null, error: "No command to run, and nothing here looks like an app.", log: "" })) as unknown as GenieClient["runProject"],
      }),
      plain,
      { sub: "run", args: [] },
      REMOTE_OPTIONS,
    );
  } finally {
    captured.restore();
  }

  assert.equal(code, 1, "an app that could not be run is a failure, not a success");
  assert.match(captured.text(), /nothing here looks like an app/);
});

test("a credential is never taken from a positional argument", async () => {
  // `genie remote ssh root@host:/path` has nowhere to put a secret but a file or a
  // pipe. A password in the words would land in a shell history and in `ps`.
  await assert.rejects(
    () => runRemote(stubClient({}), plain, { sub: "ssh", args: ["root@h:/p"] }, REMOTE_OPTIONS),
    /a key or a password is required/,
  );
});

test("`genie remote` prints what is connected, and where Atlas is", async () => {
  const list: RemoteList = {
    enabled: true,
    allowedHosts: [],
    ssh: [
      {
        id: "dev.example.com-1",
        label: "deploy@dev.example.com:/srv/app",
        host: "dev.example.com",
        user: "deploy",
        port: 22,
        path: "/srv/app",
        rel: ".remotes/dev.example.com-1",
        mountPoint: "/sandbox/.remotes/dev.example.com-1",
        auth: "key",
        connectedAt: "2026-01-01T00:00:00.000Z",
        live: true,
      },
    ],
    github: [],
    forge: [
      {
        host: "http://atlas.test:3000",
        label: "atlas.test:3000",
        user: "root",
        credential: true,
        system: true,
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    forgeClones: [],
    atlas: {
      url: "http://atlas.test:3000",
      configured: true,
      sshHost: "192.168.1.90",
      systemUser: "root",
      systemCredential: true,
      entitled: null,
      reason: "",
      signupUrl: "",
    },
  };

  const captured = captureStdout();
  try {
    const code = await runRemote(
      stubClient({ remotes: async () => list }),
      plain,
      { sub: "list", args: [] },
      REMOTE_OPTIONS,
    );
    assert.equal(code, 0);
  } finally {
    captured.restore();
  }

  const text = captured.text();
  assert.match(text, /ssh\s+deploy@dev\.example\.com:\/srv\/app/);
  assert.match(text, /forge\s+atlas\.test:3000 as root/);
  assert.match(text, /Atlas: http:\/\/atlas\.test:3000 — this deployment has its own credential/);
});

test("switched off, the CLI says so rather than showing an empty list", async () => {
  const captured = captureStdout();
  try {
    await runRemote(
      stubClient({
        remotes: async () => ({
          enabled: false,
          allowedHosts: [],
          ssh: [],
          github: [],
          forge: [],
          forgeClones: [],
          atlas: {
            url: "",
            configured: false,
            sshHost: "",
            systemUser: "",
            systemCredential: false,
            entitled: null,
            reason: "",
            signupUrl: "",
          },
        }),
      }),
      plain,
      { sub: "list", args: [] },
      REMOTE_OPTIONS,
    );
  } finally {
    captured.restore();
  }
  assert.match(captured.text(), /AGENT_REMOTE_ENABLED=false/);
});

/* --------------------------------------------------------------- projects */

function view(overrides: Partial<ProjectView> & { name: string }): ProjectView {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    dir: "my-app-abc123",
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    path: "/sandbox/my-app-abc123",
    exists: true,
    active: false,
    ...overrides,
  };
}

test("`genie projects` on its own lists, and a subcommand can be spelled plainly", () => {
  assert.deepEqual(parseProjectsCommand([]), { sub: "list", args: [] });
  assert.deepEqual(parseProjectsCommand(["ls"]), { sub: "list", args: [] });
  assert.deepEqual(parseProjectsCommand(["save", "My App"]), { sub: "new", args: ["My App"] });
  assert.deepEqual(parseProjectsCommand(["rm", "2"]), { sub: "remove", args: ["2"] });
  // Case is the user's, not a distinction worth making.
  assert.deepEqual(parseProjectsCommand(["OPEN", "My App"]), { sub: "open", args: ["My App"] });
});

test("an undefined subcommand is reported with what exists, not guessed at", () => {
  assert.throws(() => parseProjectsCommand(["wibble"]), ProjectUsageError);
  assert.throws(() => parseProjectsCommand(["wibble"]), /try list, new, open, rename, remove, export or import/);
});

test("the projects flags are read from the line as well as from the shell", () => {
  const plainOptions = { json: false, deleteFiles: false };

  // `--out` before and after the words, detached and attached: all the same.
  for (const rest of [
    ["export", "--out", "bundle.json"],
    ["export", "--out=bundle.json"],
    ["--out", "bundle.json", "export"],
  ]) {
    const { invocation, options } = parseProjectsLine(rest, plainOptions);
    assert.equal(invocation.sub, "export");
    assert.deepEqual(invocation.args, []);
    assert.equal(options.out, "bundle.json");
  }

  const remove = parseProjectsLine(["remove", "2", "--files"], plainOptions);
  assert.deepEqual(remove.invocation.args, ["2"]);
  assert.equal(remove.options.deleteFiles, true);
  assert.equal(remove.options.out, undefined, "a flag nobody gave stays unset");

  // `-` is a value, not a flag: it is how export means stdout and import stdin.
  const piped = parseProjectsLine(["export", "-o", "-"], plainOptions);
  assert.equal(piped.options.out, "-");
  assert.deepEqual(piped.invocation.args, []);
  assert.deepEqual(parseProjectsLine(["import", "-"], plainOptions).invocation.args, ["-"]);
});

test("a flag with no value is reported where it is read, not as a missing project", () => {
  const options = { json: false, deleteFiles: false };
  assert.throws(() => parseProjectsLine(["export", "--out"], options), /needs a file/);
  assert.throws(() => parseProjectsLine(["wibble", "--wat"], options), /unknown option --wat/);
});

test("a subcommand is found as a word, never through the prototype", () => {
  // `constructor` and `toString` are object keys before they are subcommands.
  assert.throws(() => parseProjectsCommand(["constructor"]), ProjectUsageError);
  assert.throws(() => parseProjectsCommand(["toString"]), ProjectUsageError);
});

test("a project can be named by its row, its name, or its id", () => {
  const first = view({ name: "Alpha", id: "aaaaaaaa-0000-0000-0000-000000000000" });
  const second = view({ name: "Beta", id: "bbbbbbbb-1111-1111-1111-111111111111", dir: "beta-def456" });
  const projects = [first, second];

  assert.equal(findProject("1", projects)?.name, "Alpha");
  assert.equal(findProject("2", projects)?.name, "Beta");
  assert.equal(findProject("beta", projects)?.name, "Beta", "a name is case-insensitive");
  assert.equal(findProject("BETA", projects)?.name, "Beta");
  assert.equal(findProject(second.id, projects)?.name, "Beta");
  assert.equal(findProject("bbbbbbbb", projects)?.name, "Beta", "one unambiguous prefix is enough");

  // A project can be called "2026", and a row cannot: the row wins, and a
  // number that is not a row is still allowed to be the name.
  const numbered = [view({ name: "2026", id: "cccccccc-0000-0000-0000-000000000000" })];
  assert.equal(findProject("2026", numbered)?.name, "2026");
  assert.equal(findProject("1", numbered)?.name, "2026", "row 1 is the row before the name");
});

test("an ambiguous or absent name resolves to nothing rather than a guess", () => {
  const projects = [
    view({ name: "one", id: "aaaa0000-0000-0000-0000-000000000000" }),
    view({ name: "two", id: "aaaa1111-0000-0000-0000-000000000000" }),
  ];
  assert.equal(findProject("aaaa", projects), null, "two matches is not a choice to make for somebody");
  assert.equal(findProject("9", projects), null, "row 9 of a two-row list is not a project");
  assert.equal(findProject("nope", projects), null);
  assert.equal(findProject("", projects), null);
});

test("a row says where the project is, and any reason to look twice", () => {
  const row = formatProjectRow(3, view({ name: "My App", description: "the demo" }));
  assert.match(row, /^ +3\s+My App/);
  assert.match(row, /11111111/);
  assert.match(row, /my-app-abc123/);
  assert.match(row, /\(the demo\)/);

  const open = formatProjectRow(1, view({ name: "Beta", active: true }));
  assert.match(open, /\(open\)/);

  // A registry entry whose directory is gone says so, rather than looking fine.
  const missing = formatProjectRow(2, view({ name: "Gone", exists: false }));
  assert.match(missing, /folder missing/);
});

/* ----------------------------------------------------------------- skills */

test("a skill takes its name and description from front matter when present", () => {
  const skill = parseSkill("x.md", "---\nname: Release Check\ndescription: Verify a tag\n---\nRun the tests.\n");
  assert.equal(skill?.name, "release-check");
  assert.equal(skill?.description, "Verify a tag");
  assert.equal(skill?.body, "Run the tests.");
});

test("a plain markdown file still becomes a skill", () => {
  const skill = parseSkill("db-migrate.md", "\n# Migrations\nThe house rules for a migration.\n");
  assert.equal(skill?.name, "db-migrate");
  assert.equal(skill?.description, "# Migrations");
  assert.equal(skill?.body.startsWith("# Migrations"), true);
});

test("an empty file is not a skill", () => {
  assert.equal(parseSkill("empty.md", "   \n\n"), null);
});

test("slug produces something typeable", () => {
  assert.equal(slug("Release Check!"), "release-check");
  assert.equal(slug("  "), "");
});

test("loadSkills reads a directory, sorts by name, and lets the first directory win", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "genie-skills-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, "b.md"), "---\nname: beta\ndescription: B\n---\nbee\n");
  fs.writeFileSync(path.join(first, "shared.md"), "---\nname: shared\ndescription: from first\n---\nx\n");
  fs.writeFileSync(path.join(second, "shared.md"), "---\nname: shared\ndescription: from second\n---\ny\n");
  fs.writeFileSync(path.join(second, "a.md"), "---\nname: alpha\ndescription: A\n---\nay\n");
  fs.writeFileSync(path.join(second, "notes.txt"), "not markdown by extension but readable\n");

  const skills = loadSkills([first, second, path.join(root, "missing")]);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["alpha", "beta", "notes", "shared"],
  );
  assert.equal(skills.find((skill) => skill.name === "shared")?.description, "from first");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a skill composes into a message with the task last", () => {
  const skill = { name: "review", description: "d", source: "s", body: "Check the diff." };
  const message = composeSkillMessage(skill, "on the last commit");
  assert.match(message, /<skill>\nCheck the diff\.\n<\/skill>/);
  assert.match(message, /Task:\non the last commit$/);
  // No task: the skill still resolves to something runnable rather than an empty send.
  assert.match(composeSkillMessage(skill, "   "), /Do what the skill describes/);
});

test("an empty skill list says how to add one", () => {
  assert.match(describeSkills([])[0] ?? "", /add a markdown file/);
});

/* ---------------------------------------------------------------- followups */

function toolCall(name: string, args: unknown): AgentEvent {
  return { type: "tool_call", id: "c1", name, args };
}

test("the reducer records a changed file from a call and proves it from a diff", () => {
  const summary = reduceTurn(emptyTurnSummary(), toolCall("edit_file", { path: "src/a.ts" }));
  assert.deepEqual(summary.filesChanged, ["src/a.ts"]);

  const diff: FileDiff = { path: "src/b.ts", created: true, added: 1, removed: 0, hunks: [], truncated: false };
  reduceTurn(summary, { type: "tool_result", id: "c1", name: "write_file", ok: true, content: "wrote 1 line", diff });
  assert.deepEqual(summary.filesChanged, ["src/a.ts", "src/b.ts"]);
});

test("a read does not count as a change, and a failure is remembered flat", () => {
  const summary = emptyTurnSummary();
  reduceTurn(summary, toolCall("read_file", { path: "src/a.ts" }));
  assert.deepEqual(summary.filesChanged, []);
  assert.deepEqual(summary.filesRead, ["src/a.ts"]);

  reduceTurn(summary, {
    type: "tool_result",
    id: "c2",
    name: "run_command",
    ok: false,
    content: "exit 1: no such target\nmore detail",
  });
  assert.deepEqual(summary.errors, ["exit 1: no such target"]);
});

test("a failure is suggested before a review, because an unfixed failure outranks one", () => {
  const summary = emptyTurnSummary();
  reduceTurn(summary, toolCall("edit_file", { path: "a.ts" }));
  reduceTurn(summary, { type: "tool_result", id: "c", name: "run_command", ok: false, content: "boom" });

  const suggestions = suggestFollowups(summary);
  assert.match(suggestions[0] ?? "", /^Fix the failure: boom$/);
  assert.ok(suggestions.length <= 3, "never more than three, so the prompt stays small");
});

test("a clean change suggests review, tests and commit", () => {
  const summary = summarizeEvents([
    toolCall("edit_file", { path: "a.ts" }),
    { type: "tool_result", id: "c", name: "edit_file", ok: true, content: "ok" },
    { type: "text", text: "Done." },
  ]);
  const suggestions = suggestFollowups(summary);
  assert.deepEqual(suggestions, [
    "Review the change to a.ts",
    "Run the test suite for this workspace",
    "Commit this change with a descriptive message",
  ]);
});

test("an untouched turn still offers something rather than an empty menu", () => {
  const suggestions = suggestFollowups(summarizeEvents([{ type: "text", text: "Nothing to do." }]));
  assert.ok(suggestions.length >= 1);
  assert.match(suggestions[0] ?? "", /Explain the approach/);
});

test("a denied approval suggests an alternative rather than repeating it", () => {
  const summary = summarizeEvents([
    { type: "approval_result", id: "a", decision: "deny" },
    { type: "text", text: "I did not run it." },
  ]);
  assert.match(suggestFollowups(summary).join("\n"), /alternative that does not need the denied action/);
});

/* ------------------------------------------------------------------- SSE */

test("a data frame is unwrapped, and a heartbeat is ignored", () => {
  assert.equal(dataOf("data: {\"type\":\"text\"}"), '{"type":"text"}');
  assert.equal(dataOf(": ping"), null);
  assert.equal(dataOf(""), null);
  // A multi-line payload joins with a newline, per the SSE spec.
  assert.equal(dataOf("data: one\ndata: two"), "one\ntwo");
});

test("an event parse ignores what is not an event", () => {
  assert.equal(parseEvent("[DONE]"), null);
  assert.equal(parseEvent("not json"), null);
  assert.deepEqual(parseEvent('{"type":"step","index":1,"of":5}'), { type: "step", index: 1, of: 5 });
});

/* ---------------------------------------------------------------- render */

test("wrap breaks on width and keeps blank lines", () => {
  assert.deepEqual(wrap("a b c", 3), ["a b", "c"]);
  assert.deepEqual(wrap("one\n\ntwo", 20), ["one", "", "two"]);
});

test("clip shortens with an ellipsis and leaves short text alone", () => {
  assert.equal(clip("abcdef", 10), "abcdef");
  assert.equal(clip("abcdefghij", 5), "abcd…");
});

test("a tool call's arguments are summarized to the field that matters", () => {
  // The names and argument keys are the ones `tools.ts` defines; getting them
  // wrong renders a card with an empty header, which is silent and useless.
  assert.equal(summarizeArgs("run_command", { command: "npm test" }), "npm test");
  assert.equal(summarizeArgs("edit_file", { path: "src/a.ts", oldString: "a", newString: "b" }), "src/a.ts");
  assert.equal(summarizeArgs("write_file", { path: "src/b.ts", content: "x" }), "src/b.ts");
  assert.equal(summarizeArgs("search_code", { pattern: "TODO", path: "src" }), "TODO  in src");
  assert.equal(summarizeArgs("list_dir", {}), ".");
});

test("a diff renders add and del lines with their markers", () => {
  const diff: FileDiff = {
    path: "src/a.ts",
    created: false,
    added: 1,
    removed: 1,
    truncated: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { type: "ctx", text: "const a = 1;", oldLine: 1, newLine: 1 },
          { type: "del", text: "old", oldLine: 2, newLine: null },
          { type: "add", text: "new", oldLine: null, newLine: 2 },
        ],
      },
    ],
  };
  const text = renderDiff(plain, diff, 80).join("\n");
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /\+1 -1/);
  assert.match(text, /\+\s*new/);
  assert.match(text, /-\s*old/);
});

test("markdown streaming keeps fence state across chunks", () => {
  let out = "";
  const stream = new MarkdownStream(plain, (text) => (out += text));
  stream.push("Here is code:\n```ts\n");
  stream.push("const x = 1;\n```\n**done**\n");
  stream.end();
  assert.match(out, /Here is code:/);
  assert.match(out, /┌ ts/);
  assert.match(out, /│ const x = 1;/);
  assert.match(out, /└/);
  assert.match(out, /done/);
});

test("markdown streaming holds only the partial trailing line", () => {
  let out = "";
  const stream = new MarkdownStream(plain, (text) => (out += text));
  stream.push("complete line\nhalf");
  assert.equal(out, "complete line\n", "the incomplete line must not be printed yet");
  stream.push(" a line\n");
  assert.equal(out, "complete line\nhalf a line\n");
});

/* ------------------------------------------------------------------ config */

test("normalizeUrl requires a scheme and drops a trailing slash", () => {
  assert.equal(normalizeUrl("genie.example.com"), "http://genie.example.com");
  assert.equal(normalizeUrl("https://genie.example.com/"), "https://genie.example.com");
  assert.equal(normalizeUrl("  "), "http://127.0.0.1:3400");
});

test("resolveTarget prefers a flag, then the environment, then the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genie-conf-"));
  const file = path.join(dir, "config.json");
  const saved = { ...process.env };
  try {
    process.env.ONTRAK_GENIE_CONFIG = file;
    writeConfig({ url: "https://from-file.example", cookie: "file-cookie" });

    // The file supplies both when nothing else does.
    delete process.env.ONTRAK_GENIE_URL;
    delete process.env.ONTRAK_GENIE_TOKEN;
    let target = resolveTarget();
    assert.equal(target.base, "https://from-file.example");
    assert.equal(target.cookie, "file-cookie");
    assert.equal(target.hasCredential, true);

    // The environment beats the file.
    process.env.ONTRAK_GENIE_URL = "https://from-env.example";
    target = resolveTarget();
    assert.equal(target.base, "https://from-env.example");

    // A flag beats the environment.
    target = resolveTarget({ url: "https://from-flag.example" });
    assert.equal(target.base, "https://from-flag.example");
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- session index */

test("sessions are numbered one-based so /resume 1 means the first row", () => {
  const sessions = [
    { id: "a", title: "A", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", messageCount: 0 },
    { id: "b", title: "B", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messageCount: 0 },
  ];
  const indexed = indexSessions(sessions);
  assert.equal(indexed.get(1)?.id, "a");
  assert.equal(indexed.get(2)?.id, "b");
  assert.equal(indexed.get(3), undefined);
});
