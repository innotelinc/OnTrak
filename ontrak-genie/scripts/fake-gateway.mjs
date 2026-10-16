#!/usr/bin/env node
/**
 * A gateway that answers, for the browser checks where no real one exists.
 *
 *   node scripts/fake-gateway.mjs            # 127.0.0.1:20128
 *   GATEWAY_PORT=21128 node scripts/fake-gateway.mjs
 *
 * `scripts/smoke-run.sh` starts this so `ui:smoke` can run on a machine with no
 * OmniRoute and no model behind it — which is every CI runner. It is deliberately
 * *not* a model: it answers `/v1/models` with two ids and `/v1/chat/completions`
 * with a canned reply, streaming frames in the shape `src/omniroute.ts` parses, so
 * the console's own request framing, SSE handling and tool execution all run for
 * real. What it cannot do is think, so the checks that need a model to write a file
 * report a skip on it rather than passing for the wrong reason.
 *
 *   FAKE_GATEWAY_WRITE_FIRST=notes.md   the first completion asks for this file,
 *                                       through a real `write_file` tool call, and
 *                                       every later one is plain prose. That is what
 *                                       seeds a "file the agent changed" for the
 *                                       checks that read the change list.
 *
 * The gateway name a request asks for is echoed back as `model`, because that is
 * what a provider that re-routes does and what the console displays.
 */

import http from "node:http";

const port = Number(process.env.GATEWAY_PORT ?? 20128);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const writeFirst = process.env.FAKE_GATEWAY_WRITE_FIRST ?? "";

/** The catalog, in the shape the console reads: id plus what it can do. */
const MODELS = [
  {
    id: "fake/model",
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "fake",
    context_length: 32_768,
    max_output_tokens: 4_096,
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: { tool_calling: true, reasoning: false, thinking: false, temperature: true },
  },
  {
    id: "fake/other",
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "fake",
    context_length: 32_768,
    max_output_tokens: 4_096,
    input_modalities: ["text"],
    output_modalities: ["text"],
    capabilities: { tool_calling: true, reasoning: false, thinking: false, temperature: true },
  },
];

let completions = 0;

const PROSE =
  "The stand-in gateway answered. No model was called, so nothing was written or run.";

/** One SSE frame in OpenAI's shape, which is what the console parses. */
function frame(body) {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(res, model, { toolCall }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (toolCall === null) {
    // Split the prose in two so the console's streaming path is exercised rather
    // than a single frame that any code would handle.
    const half = Math.ceil(PROSE.length / 2);
    res.write(frame({ model, choices: [{ delta: { content: PROSE.slice(0, half) }, finish_reason: null }] }));
    res.write(frame({ model, choices: [{ delta: { content: PROSE.slice(half) }, finish_reason: null }] }));
    res.write(
      frame({
        model,
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  } else {
    res.write(
      frame({
        model,
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_fake_1",
                  type: "function",
                  function: { name: "write_file", arguments: toolCall },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    res.write(frame({ model, choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0] ?? "";

  if (url === "/v1/models" || url === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODELS }));
    return;
  }

  if (url !== "/v1/chat/completions" && url !== "/chat/completions") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${url}` } }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* an unparseable body is answered as if it were empty */
    }
    const model = typeof body.model === "string" && body.model !== "" ? body.model : "fake/model";

    completions += 1;
    const seed = writeFirst !== "" && completions === 1
      ? JSON.stringify({ path: writeFirst, content: "Seeded by the stand-in gateway.\n" })
      : null;

    if (body.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model,
          choices: [
            seed === null
              ? { message: { role: "assistant", content: PROSE }, finish_reason: "stop" }
              : {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      { id: "call_fake_1", type: "function", function: { name: "write_file", arguments: seed } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
          ],
        }),
      );
      return;
    }

    stream(res, model, { toolCall: seed });
  });
});

server.listen(port, host, () => {
  console.log(`fake gateway on http://${host}:${port}/v1 — ${MODELS.length} models, ${MODELS[0]?.id}`);
  if (writeFirst !== "") console.log(`the first completion writes ${writeFirst}`);
});

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
