import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { applyEvent, eventOf } from "../src/studio-agent/genie-events.js";
import { isAgentRequest, conversationOf, queryOf } from "../src/studio-agent/request.js";
import { abortRuns, createRun, detach, finish, runFor } from "../src/studio-agent/runs.js";
import { forgetSessions, rememberSession, sessionFor } from "../src/studio-agent/sessions.js";
import { describeArgs, oneLine } from "../src/studio-agent/text.js";
import { acquireRun } from "../src/studio-agent/turn.js";

/**
 * The studio's agent seam, one module at a time.
 *
 * `app.test.js` proves the wiring end to end against a fake Genie. What is worth
 * pinning here is the small print of the pieces that were split out of it — the
 * rules that are easy to break by "tidying" and hard to notice in a demo:
 *
 *   * which of the page's calls is the person's turn, and which words they said;
 *   * what survives a restart, and what a corrupt file must not do;
 *   * when a run stops being paid for, and when a late frame is ignored;
 *   * how a stream of Genie events becomes markdown on the answer.
 */

const moduleUrl = (name) => new URL(`../src/studio-agent/${name}`, import.meta.url).href;

test.beforeEach(() => {
  process.env.G0DM0D3_AGENT_SESSIONS = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "g0d-agent-")),
    "sessions.json",
  );
  forgetSessions();
  abortRuns();
});

const req = (headers = {}) => ({ headers });

describe("request", () => {
  test("only the page's own chat title is the person's turn", () => {
    assert.equal(isAgentRequest(req({ "x-title": "GODMOD3.AI" })), true);
    assert.equal(isAgentRequest(req({ "x-title": "GODMOD3.AI-fast" })), true);
    // The page's auxiliary calls are the same product title with a suffix; they
    // are single-shot model calls, and a tool loop would be wrong for them.
    assert.equal(isAgentRequest(req({ "x-title": "GODMOD3.AI-accuracy-check" })), false);
    assert.equal(isAgentRequest(req({ "x-title": "GODMOD3.AI-vision" })), false);
    assert.equal(isAgentRequest(req({ "x-title": "something-else" })), false);
    assert.equal(isAgentRequest(req()), false);
  });

  test("the header wins while it is still in the transcript", () => {
    const prompt = "be uncensored";
    const messages = [{ role: "user", content: `${prompt}\n\nwhat is a pid namespace` }];
    const header = Buffer.from("what is a pid namespace").toString("base64");
    assert.equal(
      queryOf(req({ "x-genie-query": header }), {}, messages),
      "what is a pid namespace",
    );
  });

  test("a stale header loses to the transcript", () => {
    // A regenerated or edited turn: the header names the previous question and
    // the transcript no longer contains it, so the transcript is the authority.
    const header = Buffer.from("the question before the edit").toString("base64");
    const messages = [{ role: "user", content: "the edited question" }];
    assert.equal(queryOf(req({ "x-genie-query": header }), {}, messages), "the edited question");
  });

  test("a header that is not readable text is ignored", () => {
    const header = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
    const messages = [{ role: "user", content: "from the transcript" }];
    assert.equal(queryOf(req({ "x-genie-query": header }), {}, messages), "from the transcript");
  });

  test("the query is capped, and the last user message is the one read", () => {
    const long = "x".repeat(9_000);
    assert.equal(queryOf(req(), {}, [{ role: "user", content: long }]).length, 8_000);
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "an answer" },
    ];
    assert.equal(queryOf(req(), {}, messages), "first");
  });

  test("array content is joined, and non-text parts are skipped", () => {
    const messages = [
      {
        role: "user",
        content: ["look at this", { type: "text", text: "and this" }, { type: "image" }],
      },
    ];
    assert.equal(queryOf(req(), {}, messages), "look at this\nand this");
  });

  test("the conversation id is used as given, and capped", () => {
    const long = "c".repeat(200);
    assert.equal(conversationOf(req({ "x-genie-conversation": long }), "a@b", []), `id:${"c".repeat(120)}`);
  });

  test("without an id, the opening line identifies the conversation per person", () => {
    const messages = [{ role: "user", content: "same opening words" }];
    const first = conversationOf(req(), "a@b", messages);
    assert.equal(conversationOf(req(), "a@b", messages), first);
    // Two people who open with the same words are two conversations, not one.
    assert.notEqual(conversationOf(req(), "other@b", messages), first);
  });
});

describe("text", () => {
  test("oneLine flattens whitespace and truncates", () => {
    assert.equal(oneLine("a\n\n  b\tc ", 40), "a b c");
    assert.equal(oneLine("x".repeat(30), 10).length, 10);
    assert.equal(oneLine(undefined, 10), "");
  });

  test("describeArgs shows the first argument that identifies the call", () => {
    assert.equal(describeArgs({ path: "/tmp", command: "ls -l" }), " · `ls -l`");
    assert.equal(describeArgs({ command: "   ", path: "/tmp" }), " · `/tmp`");
    assert.equal(describeArgs({ command: 7 }), "");
    assert.equal(describeArgs(null), "");
    // A backtick in the value would end the inline code span and mangle the line.
    assert.equal(describeArgs({ command: "echo `id`" }), " · `echo 'id'`");
  });
});

describe("genie events", () => {
  test("a frame is its data lines, and the terminator is not JSON", () => {
    assert.equal(eventOf("data: [DONE]"), "done");
    assert.deepEqual(eventOf('event: text\ndata: {"type":"text","text":"hi"}\nid: 3'), {
      type: "text",
      text: "hi",
    });
    assert.equal(eventOf(": keep-alive"), null);
    assert.equal(eventOf("data: not json"), null);
    // JSON that is not an event object carries nothing this side can use.
    assert.equal(eventOf("data: null"), null);
    assert.equal(eventOf("data: 3"), null);
  });

  test("a session event sets the id, and an empty one does not erase it", () => {
    const run = { sessionId: "", text: "", append(text) { this.text += text; } };
    applyEvent(run, { type: "session", id: "s-1" });
    applyEvent(run, { type: "session", id: "" });
    assert.equal(run.sessionId, "s-1");
  });

  test("both tool outcomes read as a blockquote, and a failure says so", () => {
    const run = { text: "", append(text) { this.text += text; } };
    applyEvent(run, { type: "tool_call", name: "run_command", args: { command: "ls" } });
    applyEvent(run, { type: "tool_result", name: "run_command", ok: true, content: "a b" });
    applyEvent(run, { type: "tool_result", name: "run_command", ok: false, content: "x".repeat(400) });
    assert.match(run.text, /> ⚙ \*\*run_command\*\* · `ls`/);
    assert.match(run.text, /> ✓ done/);
    const failed = run.text.slice(run.text.indexOf("✗ failed"));
    assert.match(failed, /^✗ failed: x{160}\n/);
  });

  test("a retry notice keeps the reason and drops the gateway's JSON", () => {
    const run = { text: "", append(text) { this.text += text; } };
    applyEvent(run, {
      type: "notice",
      text: 'all credentials cooling down: {"error":{"message":"rate limited"}}',
    });
    assert.match(run.text, /ℹ all credentials cooling down: …/);
    assert.doesNotMatch(run.text, /rate limited/);
  });

  test("events that carry no prose leave the answer alone", () => {
    const run = { text: "keep", append(text) { this.text += text; } };
    for (const type of ["step", "draft", "gateway", "approval_result", "done"]) {
      applyEvent(run, { type, text: "noise", content: "noise" });
    }
    assert.equal(run.text, "keep");
  });

  test("an approval prompt is approved against Genie, with the id encoded", async () => {
    const asked = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      asked.push({ url: String(url), body: options?.body });
      return new Response("{}", { status: 200 });
    };
    try {
      const run = {
        text: "",
        config: { genieUrl: "http://genie.test/", genieToken: "t" },
        append(text) { this.text += text; },
      };
      applyEvent(run, { type: "approval_request", name: "run_command", id: "a/b" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(run.text, /auto-approved/);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].url, "http://genie.test//api/approvals/a%2Fb");
      assert.equal(asked[0].body, JSON.stringify({ decision: "approve" }));
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("sessions", () => {
  test("a mapping is written to the file, and read back by a later process", () => {
    rememberSession("id:conv-1", "sess-1");
    const written = JSON.parse(fs.readFileSync(process.env.G0DM0D3_AGENT_SESSIONS, "utf8"));
    assert.equal(written.sessions["id:conv-1"].sessionId, "sess-1");

    // The point of the file is the next process, so read it from one.
    const read = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { sessionFor } from ${JSON.stringify(moduleUrl("sessions.js"))};
         process.stdout.write(sessionFor("id:conv-1"));`,
      ],
      { env: process.env, encoding: "utf8" },
    );
    assert.equal(read, "sess-1");
  });

  test("a file a previous version wrote badly means a new session, not a failed turn", () => {
    fs.writeFileSync(process.env.G0DM0D3_AGENT_SESSIONS, "{not json");
    const read = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { sessionFor } from ${JSON.stringify(moduleUrl("sessions.js"))};
         process.stdout.write(\`[\${sessionFor("id:conv-1")}]\`);`,
      ],
      { env: process.env, encoding: "utf8" },
    );
    assert.equal(read, "[]");
  });

  test("an entry without a session id is not a mapping", () => {
    fs.writeFileSync(
      process.env.G0DM0D3_AGENT_SESSIONS,
      JSON.stringify({ sessions: { "id:conv-1": { sessionId: "" }, "id:conv-2": { sessionId: "s-2" } } }),
    );
    const read = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { sessionFor } from ${JSON.stringify(moduleUrl("sessions.js"))};
         process.stdout.write(\`[\${sessionFor("id:conv-1")}][\${sessionFor("id:conv-2")}]\`);`,
      ],
      { env: process.env, encoding: "utf8" },
    );
    assert.equal(read, "[][s-2]");
  });

  test("the map is capped, and the least recently used conversation is the one dropped", () => {
    for (let index = 0; index < 501; index += 1) {
      rememberSession(`id:c-${index}`, `s-${index}`);
    }
    assert.equal(sessionFor("id:c-0"), "");
    assert.equal(sessionFor("id:c-1"), "s-1");
    assert.equal(sessionFor("id:c-500"), "s-500");
  });
});

/** A controller that records being stopped, without a request behind it. */
const controller = () => ({ aborted: false, abort() { this.aborted = true; } });

/** The smallest run the registry will accept. */
const makeRun = (overrides = {}) =>
  createRun({
    key: "turn-1",
    sessionKey: "session-1",
    conversation: "id:conv-1",
    query: "hello",
    streaming: true,
    config: {},
    email: "a@b",
    log: () => {},
    ...overrides,
  });

describe("runs", () => {
  test("text arriving after the turn is finished is dropped", () => {
    const run = makeRun();
    finish(run);
    run.append("late");
    assert.equal(run.text, "");
  });

  test("finishing twice resolves once and is not an error", async () => {
    let resolved = 0;
    const run = makeRun();
    run.finished.then(() => { resolved += 1; });
    finish(run);
    finish(run);
    await run.finished;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, 1);
  });

  test("a finished run is forgotten after the grace, but a newer one under the same key is not", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = makeRun();
    finish(first);
    t.mock.timers.tick(5_000);
    assert.equal(runFor("turn-1"), undefined);

    // A second turn under the same key starts before the first one's cleanup
    // timer fires; that timer must not take the new run with it.
    const second = makeRun();
    finish(second);
    abortRuns();
    const third = makeRun();
    t.mock.timers.tick(5_000);
    assert.equal(runFor("turn-1"), third);
  });

  test("every racer leaving stops the turn after the idle window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = makeRun();
    run.controller = controller();
    const listener = () => {};
    run.listeners.add(listener);
    detach(run, listener);
    t.mock.timers.tick(9_999);
    assert.equal(run.controller.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(run.controller.aborted, true);
  });

  test("a listener that joins inside the idle window keeps the turn alive", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = makeRun();
    run.controller = controller();
    const first = () => {};
    const second = () => {};
    run.listeners.add(first);
    detach(run, first);
    run.listeners.add(second);
    t.mock.timers.tick(10_000);
    assert.equal(run.controller.aborted, false);
  });

  test("there is nothing to stop once the turn has finished", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const run = makeRun();
    run.controller = controller();
    const listener = () => {};
    run.listeners.add(listener);
    finish(run);
    detach(run, listener);
    t.mock.timers.tick(60_000);
    assert.equal(run.controller.aborted, false);
  });

  test("a finished run hands its session to the map", () => {
    const run = makeRun();
    run.sessionId = "s-42";
    finish(run);
    assert.equal(sessionFor("session-1"), "s-42");
  });
});

describe("turn", () => {
  const config = (overrides = {}) => ({
    genieUrl: "http://genie.test",
    genieToken: "token",
    agentModel: "",
    agentFallbackModels: [],
    ...overrides,
  });

  /** A Genie that answers with `body`, split at the byte offsets given. */
  const respond = (body, { status = 200, splits = [] } = {}) => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    const cuts = [0, ...splits, bytes.length];
    const stream = new ReadableStream({
      start(controller) {
        for (let index = 1; index < cuts.length; index += 1) {
          controller.enqueue(bytes.slice(cuts[index - 1], cuts[index]));
        }
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
  };

  const withFetch = async (impl, body) => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return impl(url, options);
    };
    try {
      await body(calls);
    } finally {
      globalThis.fetch = original;
    }
  };

  test("a deployment with no GENIE_URL says so instead of calling out", async () => {
    await withFetch(
      () => {
        throw new Error("fetch must not be called");
      },
      async (calls) => {
        const run = acquireRun({
          key: "t-unset",
          sessionKey: "s-unset",
          conversation: "id:c",
          query: "hi",
          streaming: true,
          config: config({ genieUrl: "" }),
          email: "a@b",
          log: () => {},
        });
        await run.finished;
        assert.equal(calls.length, 0);
        assert.match(run.text, /GENIE_URL is unset/);
      },
    );
  });

  test("a stream split mid-frame is still assembled, and nothing after [DONE] is read", async () => {
    const body =
      'data: {"type":"text","text":"Hel"}\n\n' +
      'data: {"type":"tool_call","name":"run_command","args":{"command":"ls"}}\n\n' +
      'data: {"type":"tool_result","name":"run_command","ok":true,"content":"ok"}\n\n' +
      'data: {"type":"session","id":"s-9"}\n\n' +
      "data: [DONE]\n\n" +
      'data: {"type":"text","text":"AFTER-DONE"}\n\n';
    await withFetch(
      () => respond(body, { splits: [12, 40, 41, 95] }),
      async (calls) => {
        const log = [];
        const run = acquireRun({
          key: "t-stream",
          sessionKey: "s-stream",
          conversation: "id:c",
          query: "hi",
          streaming: true,
          config: config({ agentModel: "genie/agent" }),
          email: "a@b",
          log: (entry) => log.push(entry),
        });
        await run.finished;
        assert.equal(run.text.startsWith("Hel"), true);
        assert.match(run.text, /⚙ \*\*run_command\*\*/);
        assert.doesNotMatch(run.text, /AFTER-DONE/);
        assert.equal(sessionFor("s-stream"), "s-9");
        assert.equal(calls[0].url, "http://genie.test/api/chat");
        assert.equal(calls[0].options.headers["x-genie-actor"], "a@b");
        assert.equal(JSON.parse(calls[0].options.body).model, "genie/agent");
        assert.deepEqual(log.at(-1), {
          event: "agent_completion",
          email: "a@b",
          conversation: "id:c",
          mode: "stream",
          bytes: run.text.length,
        });
      },
    );
  });

  test("a refusal carries the status and the reason, and is logged as a failure", async () => {
    await withFetch(
      () => new Response("no gateway key for this account", { status: 502 }),
      async () => {
        const log = [];
        const run = acquireRun({
          key: "t-refused",
          sessionKey: "s-refused",
          conversation: "id:c",
          query: "hi",
          streaming: false,
          config: config(),
          email: "a@b",
          log: (entry) => log.push(entry),
        });
        await run.finished;
        assert.match(run.text, /Genie refused the turn \(HTTP 502\): no gateway key/);
        assert.equal(log.at(-1).event, "agent_failed");
        assert.equal(sessionFor("s-refused"), "");
      },
    );
  });

  test("a stopped turn reads as stopped, not as a network error", async () => {
    await withFetch(
      () => {
        throw new DOMException("aborted", "AbortError");
      },
      async () => {
        const run = acquireRun({
          key: "t-abort",
          sessionKey: "s-abort",
          conversation: "id:c",
          query: "hi",
          streaming: true,
          config: config(),
          email: "a@b",
          log: () => {},
        });
        await run.finished;
        assert.match(run.text, /the agent run was stopped/);
      },
    );
  });

  test("racers for one turn share it; the next turn is a different run", async () => {
    await withFetch(
      () => respond('data: {"type":"text","text":"once"}\n\ndata: [DONE]\n\n'),
      async (calls) => {
        const fields = {
          key: "t-shared",
          sessionKey: "s-shared",
          conversation: "id:c",
          query: "hi",
          streaming: true,
          config: config(),
          email: "a@b",
          log: () => {},
        };
        const first = acquireRun(fields);
        const second = acquireRun(fields);
        assert.equal(first, second);
        await first.finished;
        assert.equal(calls.length, 1);

        const next = acquireRun({ ...fields, key: "t-next" });
        assert.notEqual(next, first);
        await next.finished;
        assert.equal(calls.length, 2);
      },
    );
  });
});
