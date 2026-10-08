/**
 * The family's liveness question is one question, asked the same way by both askers.
 *
 * The dashboard and `npm run health:check` have to agree about the same deployment: an
 * operator reading "DOWN" while the page draws a green light trusts neither, and the
 * reverse is worse — a check that passes while a product is gone is a check nobody
 * runs twice. They used to answer with two copies of the rule: the page went through
 * `probeProduct` and honoured `ONTRAK_<KEY>_INTERNAL_URL`, and the script had its own
 * `fetch`, its own status list and its own idea of which address to ask.
 *
 * These drive the shared answer against a real server rather than a mocked `fetch`,
 * because the rule is about what a product *does*: the override is a base the
 * product's declared path is appended to (never a whole URL), the statuses that count
 * as an answer are the dashboard's (2xx, 3xx, 401, 403), and a product with nothing to
 * ask is never reported as up.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

import { PRODUCTS, urlFor } from "../src/lib/portal-rules";
import { probeFleet } from "../src/lib/sync-client";

/**
 * The widest fleet either caller could hand over: the whole catalogue, at public addresses.
 *
 * Both callers narrow this first — to the tiles a person can see, or to the products this
 * deployment runs — and the narrowing is the catalogue's own rule (`runsHere`), asserted in
 * `portal-rules.test.ts`. What is asserted *here* is what happens to an entry once it is
 * handed over, so these tests hand over every product rather than a deployment's subset.
 *
 * The public address is what the override replaces, so these tests hand over the real
 * one and then assert that the override — and only the override — is what was asked.
 */
function catalogue() {
  return PRODUCTS.map((product) => ({
    key: product.key,
    url: urlFor(product),
    health: product.health ?? null,
  }));
}

/** What the stub product answers, by request path. Anything unlisted answers 200. */
const answers = new Map<string, number>();

/** Every path the stub product was asked for. */
const asked: string[] = [];

let stub: Server | null = null;
let stubBase = "";

/** One stub product on an ephemeral port, shared by these tests. */
async function productBase(): Promise<string> {
  if (stub) return stubBase;
  stub = createServer((request, response) => {
    const path = request.url ?? "/";
    asked.push(path);
    request.resume();
    response.writeHead(answers.get(path) ?? 200, { "content-type": "text/plain" });
    response.end("stub");
  });
  await new Promise<void>((resolve) => stub?.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  stubBase = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
  return stubBase;
}

/** An address nothing is listening on, to tell "refused" from "answered". */
async function deadBase(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

after(() => {
  stub?.close();
});

test("fleet-probe: each product is asked its own declared path, at the override when one is set", async () => {
  const base = await productBase();
  answers.clear();
  asked.length = 0;

  // The override is a *base*, as the deployment sets it (`http://sync-web:8421`), not a
  // finished URL — a value that replaced the path too would ask every product at `/`.
  const results = await probeFleet(catalogue(), (key) => `${base}/${key}`);

  assert.equal(results.length, PRODUCTS.length, "every product in the catalogue has to be asked");
  for (const product of PRODUCTS) {
    assert.ok(product.health, `${product.key} has no health path to ask for`);
    const url = `${base}/${product.key}${product.health}`;
    assert.equal(
      results.find((result) => result.key === product.key)?.url,
      url,
      `${product.key} must be asked at its own declared path, on the override address`,
    );
    assert.ok(
      asked.includes(`/${product.key}${product.health}`),
      `the stub was never asked ${product.key}${product.health}; it saw ${asked.join(", ")}`,
    );
  }
});

test("fleet-probe: an answer is the dashboard's list of statuses, not a list of its own", async () => {
  const base = await productBase();
  const cases: [number, "up" | "down"][] = [
    [200, "up"],
    [204, "up"],
    [302, "up"],
    [401, "up"],
    [403, "up"],
    [404, "down"],
    [429, "down"],
    [500, "down"],
    [503, "down"],
  ];

  for (const [status, expected] of cases) {
    answers.clear();
    answers.set("/health", status);
    const [result] = await probeFleet(
      [{ key: "its", url: `${base}/not-the-probe`, health: "/health" }],
      () => base,
    );
    assert.equal(result.reachability, expected, `a ${status} has to read as ${expected}`);
  }
});

test("fleet-probe: a product that is not listening is down, not unknown", async () => {
  const dead = await deadBase();
  const [result] = await probeFleet([{ key: "its", url: dead, health: "/health" }], () => dead);
  assert.equal(result.reachability, "down", "nothing answered, so this is a fact, not an absence");
});

test("fleet-probe: a product with nothing to ask is never a pass", async () => {
  const base = await productBase();
  const [result] = await probeFleet([{ key: "lab", url: base, health: null }], () => base);
  assert.equal(result.reachability, "unknown", "`not checked` is not `up`");
  assert.equal(result.url, base, "with no path to ask, the address reported stays the product's own");
});

test("fleet-probe: a family that answers 404 everywhere reads down, nowhere up", async () => {
  const base = await productBase();
  answers.clear();
  for (const product of PRODUCTS) {
    if (product.health) answers.set(product.health, 404);
  }

  const results = await probeFleet(catalogue(), () => base);
  assert.deepEqual(
    results.filter((result) => result.reachability !== "down").map((result) => result.key),
    [],
    "a 404 is not an answer, and nothing here may read as up",
  );
});
