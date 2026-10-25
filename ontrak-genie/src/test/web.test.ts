import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Web research (2.1): the address policy, the reader, the search payload, and the
 * gate.
 *
 * These are the parts where a mistake is a security bug rather than a bad answer:
 * an address check that lets one range through, or a tool that does not ask before
 * it dials. No case here reaches the network — the request itself is exercised by
 * the deployment, and the shape it parses is pinned here.
 */

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genie-web-"));
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_WORKSPACE = path.join(dataDir, "workspace");
// A provider, so the tool is offered and the gate can be asked about it.
process.env.EXA_API_KEY = "test-key";
process.env.EXA_API_URL = "https://api.example.test/search";

const { decodeEntities, htmlTitle, htmlToText, isPublicAddress, parseSearchPayload } = await import("../web.js");
const { needsApproval } = await import("../approval.js");
const { allTools } = await import("../tools.js");

test("web: public addresses are allowed and everything internal is not", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, `${address} is public`);
  }
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    assert.equal(isPublicAddress(address), false, `${address} must be refused`);
  }
  // Not an address at all: refused rather than assumed public.
  assert.equal(isPublicAddress("example.com"), false);
});

test("web: a page is read as text, without scripts, styles or markup", () => {
  const html = `<!doctype html><html><head><title>Node &amp; Fetch</title>
    <style>body { color: red }</style><script>alert("not this")</script></head>
    <body><!-- a comment --><h1>Fetch API</h1><p>Use&nbsp;<code>fetch()</code> &mdash; now stable.</p>
    <ul><li>one</li><li>two</li></ul></body></html>`;
  const title = htmlTitle(html);
  assert.equal(title, "Node & Fetch");
  const text = htmlToText(html, title);
  assert.match(text, /Node & Fetch/);
  assert.match(text, /Fetch API/);
  assert.match(text, /Use fetch\(\) — now stable\./);
  assert.match(text, /one\n two|one\ntwo/);
  assert.doesNotMatch(text, /alert|color: red|a comment/);
});

test("web: entities decode, including numeric ones and a lone ampersand", () => {
  assert.equal(decodeEntities("&lt;a&gt; &amp; &#39;b&#39; &#x2014; &nbsp;x"), "<a> & 'b' —  x");
  assert.equal(decodeEntities("&unknown; &"), "&unknown; &");
});

test("web: the search payload is reduced to title, url and snippet", () => {
  const payload = {
    results: [
      { title: "Node.js docs", url: "https://nodejs.org/", text: "  The   official docs. " },
      { title: "GitHub", url: "https://github.com/x", highlights: ["a snippet", "another"] },
      { title: "no url" },
    ],
  };
  const results = parseSearchPayload(payload, 10);
  assert.deepEqual(results, [
    { title: "Node.js docs", url: "https://nodejs.org/", snippet: "The official docs." },
    { title: "GitHub", url: "https://github.com/x", snippet: "a snippet another" },
  ]);
  assert.equal(parseSearchPayload(payload, 1).length, 1);
  assert.deepEqual(parseSearchPayload({ error: "nope" }, 5), []);
});

test("web: the tools are offered, and the gate asks before either dials", () => {
  const names = allTools().map((tool) => tool.name);
  assert.ok(names.includes("web_fetch"), "web_fetch needs no provider");
  assert.ok(names.includes("web_search"), "a configured provider offers search");

  const fetchPreview = { summary: "Fetch https://example.com" };
  assert.equal(needsApproval("risky", "web_fetch", fetchPreview, 400), true);
  assert.equal(needsApproval("risky", "web_search", { summary: "Search the web" }, 400), true);
  assert.equal(needsApproval("all", "web_fetch", fetchPreview, 400), true);
  assert.equal(needsApproval("off", "web_fetch", fetchPreview, 400), false);
  // The gate is still about actions: an ordinary read does not start asking.
  assert.equal(needsApproval("risky", "read_file", null, 400), false);
});
