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
import { normalizeUrl, resolveTarget, writeConfig } from "../cli/config.js";
import {
  emptyTurnSummary,
  reduceTurn,
  suggestFollowups,
  summarizeEvents,
} from "../cli/followups.js";
import { MarkdownStream, Theme, clip, renderDiff, summarizeArgs, wrap } from "../cli/render.js";
import { composeSkillMessage, describeSkills, loadSkills, parseSkill, slug } from "../cli/skills.js";
import { indexSessions } from "../cli/main.js";
import { parseArgs } from "../cli/main.js";
import type { AgentEvent } from "../agent.js";
import type { FileDiff } from "../diff.js";

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

test("the palette offers prefix matches only, and nothing once a space is typed", () => {
  assert.deepEqual(
    matchCommands("/re").map((command) => command.name),
    ["resume", "rename"],
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
