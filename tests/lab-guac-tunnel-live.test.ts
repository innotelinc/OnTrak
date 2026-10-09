/**
 * Live test: the console websocket tunnel, verified end to end with no browser.
 *
 *   ONTRAK_GUAC_LIVE=1 \
 *   ONTRAK_GUAC__BASE_URL="http://host:8080/guacamole/" \
 *   ONTRAK_GUAC__SECRET_KEY="<32 hex chars>" \
 *     npx tsx --tsconfig tests/tsconfig.json --test tests/lab-guac-tunnel-live.test.ts
 *
 * `tests/lab-guac.test.ts` proves the *format* of a console link — that the bytes
 * `buildPayload`/`encodePayload` produce are the ones Guacamole's JSON auth extension
 * documents, checked against fixed vectors and an `openssl` cross-check. What it cannot
 * prove is that a real gateway *accepts* those bytes and opens a tunnel to `guacd`,
 * because that needs both running. This file closes that gap: it mints a link with the
 * app's own code and drives the two steps a browser would —
 *
 *   1. `POST /guacamole/api/tokens` with the signed `data`, and
 *   2. a websocket upgrade to `/guacamole/websocket-tunnel` carrying the token, then
 *      reading the Guacamole protocol frames `guacd` sends back.
 *
 * It is opt-in twice over, like the other live tests: `ONTRAK_GUAC_LIVE=1` says "there
 * is a gateway to talk to", and the base URL and key must be set — a checkout with
 * neither skips rather than fails. It asserts a *positive and a negative* control: a
 * link signed with the configured key must be accepted and reach `guacd`, and a
 * tampered one must be refused. Without the refusal check a gateway that answers every
 * token the same way would pass.
 *
 * The flag is deliberately not named `ONTRAK_LAB*_LIVE`: the lab boundary pair
 * (`tests/lab-live.test.ts`, `tests/lab-client-live.test.ts`) runs on a hosted runner
 * with no VM, while this one needs a Guacamole deployment, which a hosted runner does
 * not have (`tests/ci-coverage.test.ts` requires a job for every `ONTRAK_LAB*_LIVE`).
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { randomBytes } from "node:crypto";

import {
  buildPayload,
  encodePayload,
  secretBytes,
  type ConsoleSettings,
} from "../src/lib/lab/guac";

const ENABLED = Boolean(process.env.ONTRAK_GUAC_LIVE);
const BASE = (process.env.ONTRAK_GUAC__BASE_URL ?? "").trim();
const SECRET_HEX = (process.env.ONTRAK_GUAC__SECRET_KEY ?? "").trim();

const SETTINGS: ConsoleSettings = {
  guac: {
    baseUrl: BASE,
    secretKey: SECRET_HEX,
    linkTtlMinutes: 5,
    recording: false,
    recordingPath: "/tmp/guac-recordings",
    serverLayout: "en-us-qwerty",
    keyboardLayout: "en-us-qwerty",
    linuxSsh: false,
  },
  guest: { rdpPort: 3389, sshPort: 22, user: "ontrak", password: "ontrak-verify", linuxUser: "root" },
};

/** The payload the console route actually mints, and the connection name it names. */
function mint(): { data: string; connection: string } {
  const payload = buildPayload(
    SETTINGS,
    { id: 1, student: "verify-ontrak", scenarioId: "console-tunnel-check", hostIp: "127.0.0.1", rdpUser: "", rdpPassword: "" },
    { id: "console-tunnel-check", title: "Console tunnel check" },
  );
  const connection = Object.keys(payload.connections as Record<string, unknown>)[0] ?? "";
  return { data: encodePayload(payload, secretBytes(SETTINGS.guac)), connection };
}

/** POST an urlencoded form and return `[status, body]`. */
function post(url: string, fields: Record<string, string>): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(fields).toString();
    const target = new URL(url);
    const request = http.request(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        path: target.pathname + target.search,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve([response.statusCode ?? 0, text]));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

/** Read one WebSocket frame's text, or a `[close <code>]` marker. */
function frameText(frame: Buffer): string {
  const opcode = frame[0]! & 0x0f;
  if (opcode === 0x8) return `[close ${frame.readUInt16BE(2)}]`;
  const length = frame[1]! & 0x7f;
  return frame.subarray(2 + (length === 126 ? 2 : 0), 2 + length).toString("utf8");
}

/** Upgrade to the tunnel and collect what `guacd` sends back for a few seconds. */
function openTunnel(url: string, query: string): Promise<{ upgraded: boolean; frames: string[]; detail: string }> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const frames: string[] = [];
    let settled = false;
    const finish = (result: { upgraded: boolean; frames: string[]; detail: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.request({
      host: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}websocket-tunnel?${query}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.on("data", (frame: Buffer) => frames.push(frameText(frame)));
      setTimeout(
        () => finish({ upgraded: true, frames, detail: `upgraded ${response.statusCode ?? 101}` }),
        6000,
      );
    });
    request.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => finish({ upgraded: false, frames, detail: `HTTP ${response.statusCode ?? 0}: ${text.slice(0, 200)}` }));
    });
    request.on("error", (error: Error) => finish({ upgraded: false, frames, detail: error.message }));
    request.end();
  });
}

test("a console link the app mints is accepted by the gateway, which opens a guacd tunnel", async (t) => {
  if (!ENABLED) {
    t.skip("set ONTRAK_GUAC_LIVE=1 to run the console-tunnel test (it needs a Guacamole gateway and guacd)");
    return;
  }
  if (!BASE || !SECRET_HEX) {
    t.skip("set ONTRAK_GUAC__BASE_URL and ONTRAK_GUAC__SECRET_KEY to the gateway's own values");
    return;
  }

  const { data, connection } = mint();
  assert.ok(connection, "the minted payload names a connection");
  const base = BASE.endsWith("/") ? BASE : `${BASE}/`;

  // 1. The gateway must accept the signature the app produced.
  const [status, body] = await post(`${base}api/tokens`, { data });
  assert.equal(status, 200, `the gateway refused a link signed with the configured key: ${body.slice(0, 200)}`);
  const authToken = (JSON.parse(body) as { authToken?: string }).authToken;
  assert.ok(authToken, "the gateway answered with an auth token");

  // 2. A tampered link must not be accepted — otherwise step 1 proves nothing.
  const tampered = data.slice(0, -2) + (data.slice(-2) === "AA" ? "BB" : "AA");
  const [badStatus, badBody] = await post(`${base}api/tokens`, { data: tampered });
  assert.ok(
    badStatus !== 200 || !badBody.includes("authToken"),
    `a tampered link was accepted (HTTP ${badStatus}) — the gateway is not checking the signature`,
  );

  // 3. The tunnel: the parameters a Guacamole client passes, then guacd's own frames.
  const query =
    `GUAC_ID=${encodeURIComponent(connection)}&GUAC_TYPE=c&GUAC_DATA_SOURCE=json` +
    `&token=${encodeURIComponent(authToken)}`;
  const tunnel = await openTunnel(base, query);
  assert.ok(tunnel.upgraded, `the websocket tunnel did not upgrade: ${tunnel.detail}`);
  const relayed = tunnel.frames.filter((frame) => !frame.startsWith("[close"));
  assert.ok(
    relayed.length > 0,
    `the tunnel upgraded but guacd sent no protocol frame (frames: ${JSON.stringify(tunnel.frames)})`,
  );
});
