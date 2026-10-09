/**
 * The console payload's wire format.
 *
 * Guacamole does not parse a link and re-sign it: it decrypts bytes, checks the HMAC
 * that is inside the ciphertext, and opens the connection. So the format is a
 * contract with a program we do not control, and every test here is about a way it
 * could be got wrong without anything on our side noticing — a raw UTF-8 `é` where
 * Python wrote `\u00e9`, spacing where Python wrote none, a key of the wrong length, a
 * value that decrypts to noise.
 *
 * The strongest of them does not use the module's own decoder at all: it decrypts with
 * `node:crypto` primitives directly and asserts the plaintext is exactly
 * `HMAC || json` with the JSON named by a literal. `test_guac.py` did the equivalent
 * with the `openssl` CLI, and that cross-check is ported too (it skips where openssl
 * is not installed), so the format is pinned against an implementation other than
 * itself rather than against its own inverse.
 *
 *   npx tsx --tsconfig tests/tsconfig.json --test tests/lab-guac.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHmac } from "node:crypto";
import { test } from "node:test";

import { newLabSession } from "../src/lib/lab/models";
import {
  AES_BLOCK,
  GuacError,
  PROBE_TIMEOUT_SECONDS,
  SIGNATURE_LEN,
  buildLink,
  buildPayload,
  checkToken,
  compactJson,
  decodePayload,
  encodePayload,
  payloadExpiry,
  payloadIsExpired,
  protocolFor,
  rdpParameters,
  secretBytes,
  sshParameters,
  type ConsoleScenario,
  type ConsoleSession,
  type ConsoleSettings,
  type FormPoster,
  type GuestSettings,
  type GuacSettings,
} from "../src/lib/lab/guac";

// A fixed, arbitrary 16-byte key. The Python suite reads one out of conftest; the
// value does not matter, only that every case uses the same one, because the point of
// most of these tests is that a *different* key cannot read what this one wrote.
const SECRET_HEX = "00112233445566778899aabbccddeeff";
const KEY = Buffer.from(SECRET_HEX, "hex");
const OTHER_KEY = Buffer.from("ff".repeat(AES_BLOCK), "hex");

function makeSettings(
  overrides: { guac?: Partial<GuacSettings>; guest?: Partial<GuestSettings> } = {},
): ConsoleSettings {
  return {
    guac: {
      baseUrl: "http://guac.test/guacamole/",
      secretKey: SECRET_HEX,
      linkTtlMinutes: 120,
      recording: false,
      recordingPath: "/var/lib/guacamole/recordings",
      serverLayout: "en-us-qwerty",
      keyboardLayout: "en-us-qwerty",
      linuxSsh: false,
      ...overrides.guac,
    },
    guest: {
      rdpPort: 3389,
      sshPort: 22,
      user: "student",
      password: "TrainMe!12345",
      linuxUser: "root",
      ...overrides.guest,
    },
  };
}

/**
 * A session, built from the ported session model rather than a literal.
 *
 * That is deliberate: it is the compile-time proof that `LabSession` — what the
 * session manager will hold — satisfies the console's `ConsoleSession`, so no adapter
 * is needed between them.
 */
function makeSession(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  const base = newLabSession({ student: "alice", scenarioId: "net-dns-failure", id: 42 });
  return {
    id: base.id,
    student: base.student,
    scenarioId: base.scenarioId,
    hostIp: "10.20.0.150",
    rdpUser: "student",
    rdpPassword: "TrainMe!12345",
    ...overrides,
  };
}

function consoleScenario(isLinux: boolean, id = "s"): ConsoleScenario {
  return { id, title: isLinux ? "linux scenario" : "windows scenario", isLinux };
}

/** Run something that must raise `GuacError`, and hand back the error to inspect. */
function guacErrorFrom(run: () => unknown): GuacError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof GuacError, `expected a GuacError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the call to raise a GuacError, but it returned normally");
}

/** Decrypt with the cipher directly, not through the module — the independent check. */
function decryptIndependently(data: string, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(AES_BLOCK, 0));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
}

/** The payload's single connection. Guacamole payloads are one connection wide here. */
function onlyConnection(payload: Record<string, unknown>): Record<string, unknown> {
  const connections = payload.connections as Record<string, Record<string, unknown>>;
  const entries = Object.values(connections);
  assert.equal(entries.length, 1, "the payload carries exactly one connection");
  const connection = entries[0];
  assert.ok(connection, "the payload carries a connection");
  return connection;
}

function parametersOf(payload: Record<string, unknown>): Record<string, string> {
  return onlyConnection(payload).parameters as Record<string, string>;
}

// ── the format ───────────────────────────────────────────────────────────────

test("guac: the payload round-trips through its own format", () => {
  const payload = {
    username: "alice",
    expires: 1234567890123,
    connections: { c: { protocol: "rdp" } },
  };
  assert.deepEqual(decodePayload(encodePayload(payload, KEY), KEY), payload);
});

test("guac: a wrong key fails the signature", () => {
  const data = encodePayload({ username: "alice" }, KEY);
  // A wrong key almost always fails the padding check first and the signature check
  // otherwise; both are GuacError, and which one fires is not a promise worth making.
  const error = guacErrorFrom(() => decodePayload(data, OTHER_KEY));
  assert.match(error.message, /padding is invalid|signature does not verify/);
});

test("guac: tampering with the ciphertext is detected", () => {
  const data = encodePayload({ username: "alice" }, KEY);
  const raw = Buffer.from(data, "base64");
  raw[40] = (raw[40] ?? 0) ^ 0x01; // flip one bit, deep in the payload
  const error = guacErrorFrom(() => decodePayload(raw.toString("base64"), KEY));
  assert.match(error.message, /padding is invalid|signature does not verify/);
});

test("guac: the key length is validated before a cipher is chosen", () => {
  const error = guacErrorFrom(() => encodePayload({ username: "alice" }, Buffer.from("tooshort")));
  assert.match(error.message, /16 bytes/);
  assert.match(guacErrorFrom(() => decodePayload("AAAA", KEY.subarray(0, 8))).message, /16 bytes/);
});

test("guac: the plaintext is signature || json, read back without this module's decoder", () => {
  const payload = { username: "test" };
  const raw = Buffer.from(compactJson(payload), "utf8");

  // Independent of encodePayload/decodePayload: decrypt with the cipher primitive and
  // assert the layout the Guacamole manual specifies.
  const encoded = encodePayload(payload, KEY);
  // Whole-block alignment is a property of the CIPHERTEXT (PKCS#7 pads it up to a
  // block boundary). The plaintext is not block-aligned by construction: it is the
  // 32-byte signature followed by the raw JSON.
  assert.equal(Buffer.from(encoded, "base64").length % AES_BLOCK, 0, "the ciphertext is whole AES blocks");
  const blob = decryptIndependently(encoded, KEY);
  assert.equal(
    blob.subarray(0, SIGNATURE_LEN).equals(createHmac("sha256", KEY).update(raw).digest()),
    true,
    "the first 32 bytes are exactly HMAC-SHA256 of the JSON",
  );
  assert.equal(blob.subarray(SIGNATURE_LEN).toString("utf8"), compactJson(payload));
  assert.equal(SIGNATURE_LEN, 32);
});

test("guac: the JSON signed is Python's, not JSON.stringify's", () => {
  // Pinned with a literal, so this half of the contract is checked against a written
  // string rather than against the serializer it is testing.
  const reference = {
    username: "test",
    expires: 1446323765000,
    connections: {
      "My Connection": { protocol: "rdp", parameters: { hostname: "10.10.209.63" } },
    },
  };
  const expected =
    '{"username":"test","expires":1446323765000,"connections":{"My Connection":' +
    '{"protocol":"rdp","parameters":{"hostname":"10.10.209.63"}}}}';
  assert.equal(compactJson(reference), expected);

  const blob = decryptIndependently(encodePayload(reference, KEY), KEY);
  assert.equal(blob.subarray(SIGNATURE_LEN).toString("utf8"), expected);
});

test("guac: compactJson separates without spaces and escapes as ensure_ascii does", () => {
  assert.equal(compactJson({ username: "test" }), '{"username":"test"}');
  assert.equal(compactJson({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(compactJson([1, 2]), "[1,2]");
  assert.equal(compactJson({ nested: { deep: [true, false, null] } }), '{"nested":{"deep":[true,false,null]}}');
  // Python writes é as an escape, not as a raw byte. A raw one would change the signed
  // bytes for any student or scenario whose name is not ASCII.
  assert.equal(compactJson({ name: "ada é" }), '{"name":"ada \\u00e9"}');
  assert.equal(compactJson({ name: "\u{1F600}" }), '{"name":"\\ud83d\\ude00"}');
  assert.equal(compactJson({ note: "a\nb\tc" }), '{"note":"a\\nb\\tc"}');
  assert.equal(compactJson({ quote: 'say "hi"' }), '{"quote":"say \\"hi\\""}');
  assert.equal(compactJson({ control: "\u0001" }), '{"control":"\\u0001"}');
  // No `undefined` in Python, so these follow JSON.stringify's own reading of it.
  assert.equal(compactJson({ skipped: undefined, kept: 1 }), '{"kept":1}');
  assert.equal(compactJson([undefined]), "[null]");
  // Python would emit the bare token `NaN`, which is not JSON.
  assert.ok(guacErrorFrom(() => compactJson({ score: Number.NaN })) instanceof GuacError);
});

test("guac: integer-like keys keep JavaScript's order, which is why no payload uses one", () => {
  // JavaScript orders integer-like keys while the object is built — before any
  // serializer sees it — so this is a difference no port can undo. Nothing in this
  // module builds a payload with such a key (connection names carry a space and a
  // `#`, parameters are hyphenated words), and the behaviour is stated here so the
  // limitation is known rather than discovered from a signature that will not verify.
  const reordered: Record<string, string> = { "10": "ten", "2": "two" };
  assert.deepEqual(Object.keys(reordered), ["2", "10"]);
  assert.equal(compactJson(reordered), '{"2":"two","10":"ten"}');
});

test("guac: base64 that is not base64, and payloads that are too short, are reported", () => {
  assert.match(guacErrorFrom(() => decodePayload("not base64!", KEY)).message, /not valid base64/);
  assert.match(guacErrorFrom(() => decodePayload("AAAAA", KEY)).message, /not valid base64/);
  // Valid base64, but not something this key signed: noise must not be read as a link.
  const noise = Buffer.alloc(AES_BLOCK, 7).toString("base64");
  assert.match(
    guacErrorFrom(() => decodePayload(noise, KEY)).message,
    /padding is invalid|payload is truncated|signature does not verify/,
  );
});

test("guac: secretBytes reads the configured hex and refuses anything else", () => {
  assert.equal(secretBytes(makeSettings().guac).length, AES_BLOCK);
  assert.match(guacErrorFrom(() => secretBytes(makeSettings({ guac: { secretKey: "zz" } }).guac)).message, /hex/);
  assert.match(guacErrorFrom(() => secretBytes(makeSettings({ guac: { secretKey: "abcd" } }).guac)).message, /hex/);
});

test("guac: the expiry travels in the payload, and staleness is readable before an iframe is embedded", () => {
  const atSeconds = 1_700_000_000;
  const payload = buildPayload(makeSettings(), makeSession(), consoleScenario(false), atSeconds);
  const ttlMinutes = makeSettings().guac.linkTtlMinutes;
  assert.equal(payload.expires, (atSeconds + ttlMinutes * 60) * 1000);
  assert.deepEqual(payloadExpiry(payload), new Date((atSeconds + ttlMinutes * 60) * 1000));
  assert.equal(payloadIsExpired(payload, new Date(atSeconds * 1000)), false);
  assert.equal(payloadIsExpired(payload, new Date((atSeconds + ttlMinutes * 60) * 1000)), false);
  assert.equal(payloadIsExpired(payload, new Date((atSeconds + (ttlMinutes + 1) * 60) * 1000)), true);
  // A payload with no expiry is "no deadline recorded", not "expired".
  assert.equal(payloadExpiry({ username: "x" }), null);
  assert.equal(payloadIsExpired({ username: "x" }), false);
});

// ── connection parameters ────────────────────────────────────────────────────

test("guac: RDP parameters carry the session's credentials and the site's ports", () => {
  const params = rdpParameters(makeSettings(), makeSession());
  assert.equal(params.hostname, "10.20.0.150");
  assert.equal(params.username, "student");
  assert.equal(params.password, "TrainMe!12345");
  assert.equal(params["ignore-cert"], "true");
  assert.equal(params.port, "3389");
  assert.equal(params.security, "any");
});

test("guac: a session without credentials falls back to the guest account", () => {
  const params = rdpParameters(makeSettings(), makeSession({ rdpUser: "", rdpPassword: "" }));
  assert.equal(params.username, "student");
  assert.equal(params.password, "TrainMe!12345");
});

test("guac: recording is opt-in, for both protocols", () => {
  const off = makeSettings({ guac: { recording: false } });
  assert.equal("recording-path" in rdpParameters(off, makeSession()), false);
  assert.equal("recording-path" in sshParameters(off, makeSession()), false);

  const on = makeSettings({ guac: { recording: true, recordingPath: "/rec" } });
  const rdp = rdpParameters(on, makeSession());
  assert.equal(rdp["recording-path"], "/rec");
  assert.equal(rdp["create-recording-path"], "true");
  // The name carries the session and Guacamole's own date placeholders, unexpanded.
  assert.match(rdp["recording-name"] ?? "", /^ontrak-42-alice-net-dns-failure-\$\{GUAC_DATE\}-\$\{GUAC_TIME\}$/);

  const ssh = sshParameters(on, makeSession());
  assert.equal(ssh["recording-path"], "/rec");
});

// ── the link ─────────────────────────────────────────────────────────────────

test("guac: the link is a browser URL whose payload is encrypted", () => {
  const settings = makeSettings();
  const atSeconds = 1_700_000_000;
  const link = buildLink(settings, makeSession(), consoleScenario(false), atSeconds);

  const parsed = new URL(link);
  assert.equal(parsed.protocol, "http:");
  assert.equal(parsed.host, "guac.test");
  assert.equal(parsed.pathname, "/guacamole/");

  const data = new URLSearchParams(parsed.hash.replace(/^#\/\?/, "")).get("data");
  assert.ok(data, "the fragment carries the data parameter");
  const payload = decodePayload(data, KEY);
  assert.equal(payload.username, "alice");
  const expectedExpiry = (atSeconds + settings.guac.linkTtlMinutes * 60) * 1000;
  assert.equal(payload.expires, expectedExpiry);
  const connection = onlyConnection(payload);
  assert.match(String(Object.keys(payload.connections as Record<string, unknown>)[0]), /windows scenario/);
  assert.equal((connection.parameters as Record<string, string>).hostname, "10.20.0.150");
  // The password is inside the ciphertext, so it is not readable in the URL.
  assert.equal(link.includes("TrainMe"), false);
});

test("guac: a link needs an address and a configured gateway", () => {
  assert.match(guacErrorFrom(() => buildLink(makeSettings(), makeSession({ hostIp: "" }))).message, /no host address/);
  assert.match(
    guacErrorFrom(() => buildLink(makeSettings({ guac: { baseUrl: "" } }), makeSession())).message,
    /base_url/,
  );
  // A base URL with no trailing slash still gets its path ended properly.
  assert.match(
    buildLink(makeSettings({ guac: { baseUrl: "https://guac.test/guacamole" } }), makeSession(), consoleScenario(false), 0),
    /^https:\/\/guac\.test\/guacamole\/#\/\?data=/,
  );
});

// ── which protocol a guest can answer ────────────────────────────────────────

test("guac: a Windows guest gets RDP", () => {
  const settings = makeSettings();
  assert.equal(protocolFor(settings, consoleScenario(false)), "rdp");
  const payload = buildPayload(settings, makeSession(), consoleScenario(false));
  assert.equal(onlyConnection(payload).protocol, "rdp");
  assert.equal(parametersOf(payload).port, "3389");
});

test("guac: a Linux container gets no browser console by default", () => {
  // The reported failure: the console iframe was an RDP session pointed at a Linux
  // container, which runs no RDP server, so every container scenario showed "the
  // remote desktop server is currently unreachable". With no sshd in the image either
  // (the default Incus-agent driver), the honest answer is no console at all.
  const settings = makeSettings();
  assert.equal(protocolFor(settings, consoleScenario(true)), "");
  assert.match(guacErrorFrom(() => buildPayload(settings, makeSession(), consoleScenario(true))).message, /no remote desktop/);
});

test("guac: a Linux guest gets SSH when the image runs sshd", () => {
  const settings = makeSettings({ guac: { linuxSsh: true } });
  assert.equal(protocolFor(settings, consoleScenario(true)), "ssh");
  const payload = buildPayload(settings, makeSession({ rdpUser: "", rdpPassword: "" }), consoleScenario(true));
  assert.equal(onlyConnection(payload).protocol, "ssh");
  assert.equal(parametersOf(payload).port, "22");
  assert.equal(parametersOf(payload).username, "root");
  // An SSH console has no desktop to resize; asking for one would be noise.
  assert.equal("resize-method" in parametersOf(payload), false);
});

test("guac: a Linux console logs in as the account the template provisioned", () => {
  // A real Linux session carries the *Windows* training account in `rdpUser`, and the
  // old code preferred it here too — but an SSH console's password is set for
  // `guest.linuxUser` and nothing else, so every Linux console asked guacd to log in
  // as an account the image did not have. The test above passes `rdpUser: ""`, which
  // is why it never caught this.
  const settings = makeSettings({ guac: { linuxSsh: true }, guest: { linuxUser: "root" } });
  const session = makeSession({ rdpUser: "student", rdpPassword: "TrainMe!12345" });
  assert.equal(parametersOf(buildPayload(settings, session, consoleScenario(true))).username, "root");
  assert.equal(parametersOf(buildPayload(settings, session, consoleScenario(true))).password, "TrainMe!12345");
  // ...and the RDP half still gets the training account.
  assert.equal(rdpParameters(settings, session).username, "student");
});

test("guac: a scenario we cannot classify still gets RDP", () => {
  // In Python this was `getattr(scenario, "is_linux", False)`; a scenario-like object
  // that lacks the property must not turn a student's page into a 500, and a Windows
  // VM is what the pool holds — so "not known to be Linux" reads as RDP.
  const settings = makeSettings();
  assert.equal(protocolFor(settings, null), "rdp");
  assert.equal(protocolFor(settings, undefined), "rdp");
  assert.equal(protocolFor(settings, { id: "s", title: "unclassified" }), "rdp");
});

// ── the gateway probe ────────────────────────────────────────────────────────

test("guac: the probe signs with the portal's own key", async () => {
  // It must test the *agreement*, not merely reach the gateway: it sends a payload
  // signed with guac.secret_key, the same thing a student's link carries, so a gateway
  // that accepts it is a gateway that will open the console.
  const settings = makeSettings();
  const sent: { url?: string; fields?: Record<string, string>; timeout?: number } = {};
  const post: FormPoster = (url, fields, timeout): [number, string] => {
    sent.url = url;
    sent.fields = fields;
    sent.timeout = timeout;
    return [200, '{"authToken":"abc","dataSource":"json"}'];
  };

  const result = await checkToken(settings, { post });
  assert.equal(result.state, "ok", result.detail);
  assert.equal(sent.url, "http://guac.test/guacamole/api/tokens");
  assert.equal(sent.timeout, PROBE_TIMEOUT_SECONDS);
  const payload = decodePayload(sent.fields?.data ?? "", secretBytes(settings.guac));
  const doctor = onlyConnection(payload);
  assert.equal(doctor.protocol, "rdp");
  assert.equal((doctor.parameters as Record<string, string>).hostname, "127.0.0.1");
  assert.equal(payload.username, "ontrak-doctor");
});

test("guac: the probe names a key mismatch, which is the console-never-opens state", async () => {
  const result = await checkToken(makeSettings(), {
    post: () => [403, '{"message":"Permission denied."}'],
  });
  assert.equal(result.state, "refused");
  assert.match(result.detail, /JSON_SECRET_KEY/);
  assert.match(result.detail, /console never opens/);
});

test("guac: the probe warns rather than fails when nothing answers", async () => {
  // Split-horizon DNS is normal: the browser's URL need not resolve on the host.
  const result = await checkToken(makeSettings(), {
    post: () => {
      throw new Error("name or service not known");
    },
  });
  assert.equal(result.state, "unreachable");
  assert.match(result.detail, /could not reach/);
});

test("guac: the probe skips when there is no console, and when the key is unusable", async () => {
  const noConsole = await checkToken(makeSettings({ guac: { baseUrl: "" } }), {
    post: () => {
      throw new Error("the probe must not dial when there is no console to check");
    },
  });
  assert.equal(noConsole.state, "skipped");
  assert.match(noConsole.detail, /guac\.base_url/);

  const badKey = await checkToken(makeSettings({ guac: { secretKey: "not-a-key" } }));
  assert.equal(badKey.state, "skipped");
  assert.match(badKey.detail, /unusable/);
});

// ── the independent implementation ───────────────────────────────────────────

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = opensslAvailable();

test(
  "guac: the payload matches the openssl reference implementation",
  { skip: HAS_OPENSSL ? false : "openssl CLI is not available on this host" },
  () => {
    // HMAC-SHA256, prepend, AES-128-CBC with a zero IV, PKCS#7 — computed by an
    // independent implementation rather than by this module, exactly as the Python
    // suite did. This is the check that says a payload signed here is a payload
    // Guacamole's own tooling would produce.
    const payload = {
      username: "test",
      expires: 1446323765000,
      connections: {
        "My Connection": { protocol: "rdp", parameters: { hostname: "10.10.209.63" } },
      },
    };
    const raw = Buffer.from(compactJson(payload), "utf8");

    const signature = execFileSync(
      "openssl",
      ["dgst", "-sha256", "-mac", "HMAC", "-macopt", `hexkey:${KEY.toString("hex")}`, "-binary"],
      { input: raw, maxBuffer: 1 << 20 },
    );
    assert.equal(signature.length, SIGNATURE_LEN);

    const encrypted = execFileSync(
      "openssl",
      ["enc", "-aes-128-cbc", "-K", KEY.toString("hex"), "-iv", "00".repeat(AES_BLOCK), "-nosalt", "-base64"],
      { input: Buffer.concat([signature, raw]), maxBuffer: 1 << 20 },
    )
      .toString("ascii")
      .replace(/\s+/g, "");

    assert.equal(encodePayload(payload, KEY), encrypted);
  },
);
