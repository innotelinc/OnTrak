/**
 * Browser console access through Apache Guacamole.
 *
 * This is the TypeScript half of OnTrak-dev's `ontrak/guac.py`. Students never
 * receive an RDP password: the portal hands them a Guacamole URL whose `data`
 * parameter is a signed + encrypted JSON payload (the `guacamole-auth-json`
 * extension), scoped to exactly one connection with a short expiry. Guacamole
 * verifies the signature, decrypts, and opens the session.
 *
 * Wire format, exactly as the Guacamole manual specifies:
 *
 *   1. `signature = HMAC-SHA256(secret, json)` — 32 raw bytes.
 *   2. Prepend it to the JSON: `signature || json`.
 *   3. AES-128-CBC encrypt with an all-zero IV (PKCS#7 padding).
 *   4. Base64 the ciphertext; pass as `data`.
 *
 * `decodePayload` implements the inverse so the format is testable without a
 * Guacamole instance, and `checkToken` asks a live gateway whether it will accept
 * what this key signs.
 *
 * Three decisions worth stating, because each is a place a port goes quietly wrong.
 *
 * **The JSON is serialised by hand, not by `JSON.stringify`.** Guacamole does not
 * re-serialise the payload — it decrypts bytes and parses them — so in principle any
 * JSON would do. But the signature covers *those bytes*, the format is pinned by a
 * test against `openssl`, and the Python control plane (and any tooling an operator
 * wrote against it) produces Python's `json.dumps(payload, separators=(",",":"))`.
 * JavaScript's `JSON.stringify` differs from that in one way that matters: non-ASCII
 * characters are emitted raw instead of as `\uXXXX`. `compactJson` reproduces the
 * Python output, so a payload signed here is byte-identical to one signed there. The
 * single difference it cannot undo is JavaScript's own ordering of integer-like keys,
 * which happens when the object is built and before any serialiser sees it — no
 * payload in this module has one, and a test pins the limitation rather than leaving
 * it to be discovered from a signature mismatch.
 *
 * **The IV is a block of zeroes, and that is the format, not an oversight.** The
 * extension's manual says so; the confidentiality comes from the AES key, and the
 * integrity from the HMAC inside the ciphertext. Node's `createCipheriv` applies
 * PKCS#7 by default, which is also what Python's `cryptography` padder does — both
 * are left at their defaults rather than configured, so neither can drift.
 *
 * **A wrong key is reported, never guessed around.** Decryption failing on padding
 * and the signature failing to verify are different facts about a link (a truncated
 * value vs. the wrong key), and `checkToken` exists because the failure an operator
 * actually hits — the portal signing with one key while the gateway verifies with
 * another — is invisible from the portal side: it hands over a correctly-signed link,
 * the iframe is blank, and neither log says why.
 *
 * Pure except for `checkToken`, which makes one HTTP request and takes its transport
 * as an argument so the interpretation can be tested without a gateway.
 */

import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

export const AES_BLOCK = 16;
export const SIGNATURE_LEN = 32;

/** How long the gateway probe waits. Generous enough for a TLS handshake on a busy
 * host, short enough that `ontrak doctor` does not hang on a name that never answers. */
export const PROBE_TIMEOUT_SECONDS = 8;

/**
 * The IV the extension specifies: sixteen zero bytes.
 *
 * Allocated once and never mutated — `createCipheriv`/`createDecipheriv` do not write
 * to it, and building a fresh block per call would only invite a caller to think it is
 * a parameter.
 */
const ZERO_IV = Buffer.alloc(AES_BLOCK, 0);

/** The name appended to a recording, expanded by Guacamole when the session records. */
const RECORDING_SUFFIX = "-${GUAC_DATE}-${GUAC_TIME}";

/** Raised when a payload cannot be built or read. */
export class GuacError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuacError";
  }
}

// ── settings ─────────────────────────────────────────────────────────────────
// Narrow structural views of the lab's configuration. The full settings object a
// later stage loads satisfies these; taking only the fields this module reads keeps
// the console path testable with an object literal and stops it reaching for a
// setting it has no business knowing about.

/** The console gateway's own configuration (`guac.*`). */
export interface GuacSettings {
  /** Where the gateway is, e.g. `http://console.example.test/guacamole/`. Empty means no console. */
  baseUrl: string;
  /**
   * The shared key, as configured: **hex**, 32 characters for the 16 bytes AES-128
   * needs. Guacamole's own `JSON_SECRET_KEY` is the same key spelled the same way.
   */
  secretKey: string;
  /** How long a minted console link stays valid. */
  linkTtlMinutes: number;
  /** Whether sessions are recorded for instructor review. Off by default. */
  recording: boolean;
  recordingPath: string;
  serverLayout: string;
  keyboardLayout: string;
  /**
   * Whether a Linux guest's image actually runs an `sshd`. Off by default: the
   * container transport works through the Incus agent and needs no daemon, so there
   * is no console to offer.
   */
  linuxSsh: boolean;
}

/** The guest's connection facts (`guest.*`). */
export interface GuestSettings {
  rdpPort: number;
  sshPort: number;
  /** The Windows training account. */
  user: string;
  password: string;
  /** The Linux account the template's console transport provisioned; `root` by default. */
  linuxUser: string;
}

/** The slice of the lab's settings this module reads. */
export interface ConsoleSettings {
  guac: GuacSettings;
  guest: GuestSettings;
}

/**
 * The session fields a console link is built from.
 *
 * `LabSession` (`./models`) satisfies this structurally, so the session manager passes
 * its own rows straight in. Declaring the subset is what lets a test build one from an
 * object literal — and it is the same four fields Python's `Session` happened to carry
 * into `guac.py`.
 */
export interface ConsoleSession {
  id: number | null;
  student: string;
  scenarioId: string;
  hostIp: string;
  rdpUser: string;
  rdpPassword: string;
}

/**
 * The scenario facts the protocol decision reads.
 *
 * `isLinux` is optional on purpose. In Python this read
 * `getattr(scenario, "is_linux", False)`, because the call happens while a student's
 * page is being built and a scenario-like object without the property must not turn
 * the page into a 500. A missing field therefore means "not known to be Linux", which
 * is the pre-existing behaviour: a Windows VM is what the pool holds.
 */
export interface ConsoleScenario {
  id: string;
  title: string;
  isLinux?: boolean;
}

/** Which transport a guest can answer. `""` means there is no browser console. */
export type ConsoleProtocol = "rdp" | "ssh" | "";

/**
 * The fifteen bytes of AES key behind the configured value.
 *
 * The value is hex, so a misconfigured key is a real possibility — a truncated paste,
 * a base64 string pasted into a hex field — and it has to be an error rather than the
 * first sixteen bytes of whatever was there. Throws `GuacError`; `checkToken` reports
 * it as the `skipped` state rather than failing a doctor run.
 */
export function secretBytes(guac: GuacSettings): Buffer {
  const raw = (guac.secretKey ?? "").trim();
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== AES_BLOCK * 2) {
    throw new GuacError(
      `guac.secret_key must be ${AES_BLOCK} bytes of hex (${AES_BLOCK * 2} hex characters), ` +
        `got ${raw.length} character(s)`,
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * `secretBytes` with the failure kept as a value.
 *
 * Used by the one caller whose job is to *report* an unusable key — the gateway probe
 * turns it into the `skipped` state — so the error is a value rather than a throw in
 * the middle of a control flow that has to stay readable.
 */
function readSecretKey(
  guac: GuacSettings,
): { ok: true; key: Buffer } | { ok: false; detail: string } {
  try {
    return { ok: true, key: secretBytes(guac) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// ── serialisation ────────────────────────────────────────────────────────────

/**
 * One string, escaped the way Python's `json.dumps` escapes it with its default
 * `ensure_ascii=True`: quotes and backslashes escaped, the short control escapes used
 * where they exist, anything below 0x20 written as `\u00XX`, and everything outside
 * ASCII written as `\uXXXX` — a surrogate pair for astral characters, each code unit
 * escaped, which is what Python emits for them too.
 */
function escapeJsonString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20 || code > 0x7e) {
      if (code <= 0xffff) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      } else {
        const offset = code - 0x10000;
        const high = 0xd800 + (offset >> 10);
        const low = 0xdc00 + (offset & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      }
    } else out += character;
  }
  return `${out}"`;
}

/**
 * `json.dumps(value, separators=(",", ":"))`, byte for byte.
 *
 * A faithful port rather than a convenience wrapper: what this returns is what gets
 * signed, so the layout is part of the protocol. Object keys keep their order, which
 * for every key this module writes (`username`, `connections`, `OnTrak #42 - …`,
 * `ignore-cert`) is the order the object was built in — JavaScript reorders only
 * integer-like keys, and it does that while the object is being built, so no
 * serializer can preserve it. Passing a payload with such a key would sign a
 * different byte string than Python would; nothing here produces one, and the test
 * suite states the difference instead of implying it does not exist. `undefined` is
 * skipped in an object and written as `null` in an array, matching `JSON.stringify`,
 * because Python has no `undefined` to copy.
 * A non-finite number throws: Python would emit the bare tokens `NaN`/`Infinity`,
 * which is not JSON and which Guacamole would parse as an error — a number that
 * cannot be represented should stop the link, not produce one that cannot open.
 */
export function compactJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GuacError(`cannot serialise ${String(value)} as JSON`);
    return String(value);
  }
  if (typeof value === "string") return escapeJsonString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : compactJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      entries.push(`${escapeJsonString(key)}:${compactJson(item)}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new GuacError(`cannot serialise a ${typeof value} as JSON`);
}

// ── the payload ──────────────────────────────────────────────────────────────

/**
 * Sign, encrypt and base64 the payload the way `guacamole-auth-json` expects.
 *
 * The key-length guard is here rather than left to the cipher: AES-128 with a key of
 * the wrong length throws an OpenSSL error naming a cipher, which is not a sentence
 * an operator can act on.
 */
export function encodePayload(payload: Record<string, unknown>, key: Buffer): string {
  if (key.length !== AES_BLOCK) {
    throw new GuacError(`secret key must be ${AES_BLOCK} bytes, got ${key.length}`);
  }
  const raw = Buffer.from(compactJson(payload), "utf8");
  const signature = createHmac("sha256", key).update(raw).digest();
  const cipher = createCipheriv("aes-128-cbc", key, ZERO_IV);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([signature, raw])), cipher.final()]);
  return ciphertext.toString("base64");
}

/**
 * Inverse of `encodePayload`. Used by tests, by the portal when debugging a link, and
 * by `checkToken` when it asks what it just sent.
 *
 * Base64 is validated the way Python's `base64.b64decode(..., validate=True)` is —
 * the alphabet and the padding, not a lenient reinterpretation — so a URL that lost a
 * character says so instead of decrypting into noise.
 */
export function decodePayload(data: string, key: Buffer): Record<string, unknown> {
  if (key.length !== AES_BLOCK) {
    throw new GuacError(`secret key must be ${AES_BLOCK} bytes, got ${key.length}`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    throw new GuacError(`data is not valid base64: ${JSON.stringify(data.slice(0, 40))}`);
  }

  let blob: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, ZERO_IV);
    blob = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  } catch (error) {
    // A wrong key usually fails the padding check here. Occasionally the padding is
    // valid by luck (one value in 256) and the signature check below catches it —
    // which is why both paths exist and both raise GuacError.
    throw new GuacError(
      `padding is invalid (wrong key?): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (blob.length <= SIGNATURE_LEN) throw new GuacError("payload is truncated");
  const signature = blob.subarray(0, SIGNATURE_LEN);
  const raw = blob.subarray(SIGNATURE_LEN);
  const expected = createHmac("sha256", key).update(raw).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new GuacError("signature does not verify (wrong key or tampered payload)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new GuacError(
      `payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GuacError("payload is not valid JSON: the payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

/** When a payload's link stops being valid, or `null` when it carries no expiry. */
export function payloadExpiry(payload: Record<string, unknown>): Date | null {
  const expires = payload.expires;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  return new Date(expires);
}

/**
 * Whether a minted link has passed its expiry.
 *
 * Guacamole is the enforcer — it refuses a stale payload at token time — so this is
 * the same rule expressed once for the callers that need to decide *before* embedding
 * an iframe: a page reopened from history, or a session whose console is reloaded
 * after the link it was given has aged out. It deliberately does not live inside
 * `decodePayload`: that function's job is to invert the format, and a debugging tool
 * that refused to read an old link would be unable to explain why it is old.
 */
export function payloadIsExpired(payload: Record<string, unknown>, now: Date = new Date()): boolean {
  const expiry = payloadExpiry(payload);
  return expiry !== null && now.getTime() > expiry.getTime();
}

// ── connection parameters ────────────────────────────────────────────────────

/** The name a recorded session is filed under, with Guacamole's own date placeholders. */
function recordingName(session: ConsoleSession): string {
  return `ontrak-${session.id}-${session.student}-${session.scenarioId}${RECORDING_SUFFIX}`;
}

/** RDP parameters for one student's VM. */
export function rdpParameters(
  settings: ConsoleSettings,
  session: ConsoleSession,
): Record<string, string> {
  const guac = settings.guac;
  const params: Record<string, string> = {
    hostname: session.hostIp,
    port: String(settings.guest.rdpPort),
    username: session.rdpUser || settings.guest.user,
    password: session.rdpPassword || settings.guest.password,
    // Windows 10/11 negotiate NLA; "any" lets guacd pick what the host offers while
    // still using the credentials above.
    security: "any",
    "ignore-cert": "true",
    "resize-method": "display-update",
    "server-layout": guac.serverLayout,
    "keyboard-layout": guac.keyboardLayout,
    "color-depth": "32",
    "clipboard-encoding": "UTF-8",
    "disable-audio": "true",
    // Training quality-of-life: keep the guest visually plain so screen sharing and
    // screenshots are readable, and keep transfer off by default.
    "enable-wallpaper": "false",
    "enable-theming": "false",
    "enable-font-smoothing": "true",
    "enable-desktop-composition": "false",
    "disable-bitmap-caching": "false",
    "enable-drive": "false",
    "create-drive-path": "true",
    autoretry: "5",
  };
  if (guac.recording) {
    // Session recording for instructor review and incident exercises.
    params["recording-path"] = guac.recordingPath;
    params["recording-name"] = recordingName(session);
    params["create-recording-path"] = "true";
  }
  return params;
}

/**
 * SSH parameters for one student's Linux guest.
 *
 * Only used when the Linux images actually run an `sshd` (`guac.linux_ssh`); the
 * default container driver runs commands through the Incus agent and has no `sshd` at
 * all, which is why this is off by default rather than the natural choice.
 */
export function sshParameters(
  settings: ConsoleSettings,
  session: ConsoleSession,
): Record<string, string> {
  const guac = settings.guac;
  const params: Record<string, string> = {
    hostname: session.hostIp,
    port: String(settings.guest.sshPort),
    // The *Linux* account, not the Windows one. The session row's `rdpUser` is the
    // training account on a Windows guest, while the console transport a Linux
    // template is built with sets the password for `guest.linuxUser` (root by
    // default) and nothing else. Borrowing the RDP user here pointed every Linux
    // console at an account the image does not have, so guacd's login was refused and
    // the student got a console that never opened.
    username: settings.guest.linuxUser || "root",
    // The password the transport baked into the image. Randomising credentials
    // rotates a Windows local account only, so nothing else can move this.
    password: settings.guest.password,
    "color-depth": "32",
    "font-size": "14",
    "clipboard-encoding": "UTF-8",
    "server-layout": guac.serverLayout,
    "read-only": "false",
    autoretry: "5",
  };
  if (guac.recording) {
    params["recording-path"] = guac.recordingPath;
    params["recording-name"] = recordingName(session);
    params["create-recording-path"] = "true";
  }
  return params;
}

/**
 * The console protocol this scenario's guest can actually answer.
 *
 * A Windows VM brokers RDP. A Linux *container* does not: it runs no RDP server, so an
 * RDP console for it is a page that reports the remote desktop server as unreachable,
 * which says nothing about the scenario being broken. It answers SSH instead, but only
 * where the image runs `sshd` — the default container driver works through the Incus
 * agent and needs no daemon, so this answers `""` (no browser console) unless
 * `guac.linux_ssh` says otherwise. An empty answer is the honest one: the portal then
 * explains the situation instead of embedding a console that cannot connect.
 */
export function protocolFor(
  settings: ConsoleSettings,
  scenario: ConsoleScenario | null | undefined,
): ConsoleProtocol {
  if (scenario?.isLinux === true) return settings.guac.linuxSsh ? "ssh" : "";
  return "rdp";
}

/**
 * Full Guacamole auth payload for one session.
 *
 * `nowSeconds` is an argument rather than a call to the clock so a test can assert the
 * expiry it asked for; the portal passes nothing and gets the real time.
 */
export function buildPayload(
  settings: ConsoleSettings,
  session: ConsoleSession,
  scenario?: ConsoleScenario | null,
  nowSeconds?: number,
): Record<string, unknown> {
  if (!session.hostIp) {
    throw new GuacError(`session ${String(session.id)} has no host address yet`);
  }
  const protocol = protocolFor(settings, scenario);
  if (!protocol) {
    throw new GuacError(
      `scenario ${session.scenarioId} runs a Linux guest, which has no remote desktop: ` +
        "set guac.linux_ssh once the image runs sshd (guac.ssh_port), or hand the student " +
        "a shell another way",
    );
  }
  const ttlSeconds = settings.guac.linkTtlMinutes * 60;
  const expiresMs = Math.trunc(((nowSeconds ?? Date.now() / 1000) + ttlSeconds) * 1000);
  const title = scenario ? scenario.title : session.scenarioId;
  return {
    username: session.student,
    expires: expiresMs,
    connections: {
      // Named for the student and the title: Guacamole shows this to them.
      [`OnTrak #${String(session.id)} - ${title}`]: {
        id: `ontrak-session-${String(session.id)}`,
        protocol,
        parameters:
          protocol === "ssh" ? sshParameters(settings, session) : rdpParameters(settings, session),
      },
    },
  };
}

/** The URL to embed in the portal's console iframe. */
export function buildLink(
  settings: ConsoleSettings,
  session: ConsoleSession,
  scenario?: ConsoleScenario | null,
  nowSeconds?: number,
): string {
  if (!settings.guac.baseUrl) throw new GuacError("guac.base_url is not configured");
  const payload = buildPayload(settings, session, scenario, nowSeconds);
  const data = encodePayload(payload, secretBytes(settings.guac));
  const base = settings.guac.baseUrl.endsWith("/")
    ? settings.guac.baseUrl
    : `${settings.guac.baseUrl}/`;
  // `encodeURIComponent` escapes every character base64 can contain (`+`, `/`, `=`
  // are all escaped; the handful it leaves alone — `!'()*-._~` — cannot appear), so
  // this is Python's `quote(data, safe="")` for this alphabet.
  return `${base}#/?data=${encodeURIComponent(data)}`;
}

// ── the gateway probe ────────────────────────────────────────────────────────

/** The four verdicts the probe can reach. */
export type ConsoleCheckState = "ok" | "refused" | "unreachable" | "skipped";

/** A form POST, as the Guacamole webapp sends one. Injectable so tests need no gateway. */
export type FormPoster = (
  url: string,
  fields: Record<string, string>,
  timeoutSeconds: number,
) => Promise<[number, string]> | [number, string];

/** POST an urlencoded form and return `[status, body]`. */
const defaultPoster: FormPoster = async (
  url,
  fields,
  timeoutSeconds,
): Promise<[number, string]> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(Math.round(timeoutSeconds * 1000)),
  });
  return [response.status, await response.text()];
};

/**
 * Run one probe POST, with the failure kept as a value.
 *
 * A poster may throw synchronously or reject — `fetch` on a name that does not
 * resolve is the first, an aborted timeout is the second — and both mean the same
 * thing to the caller, so both arrive here as `ok: false` rather than as two shapes
 * the caller has to remember to catch.
 */
async function sendProbe(
  sender: FormPoster,
  url: string,
  fields: Record<string, string>,
  timeoutSeconds: number,
): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
  try {
    const [status, body] = await Promise.resolve(sender(url, fields, timeoutSeconds));
    return { ok: true, status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CheckTokenOptions {
  timeoutSeconds?: number;
  post?: FormPoster;
  /** Overridable so a test can pin the doctor payload's expiry. */
  nowSeconds?: number;
}

/**
 * Ask the console gateway whether it accepts a link we signed. `{ state, detail }`.
 *
 * Googleable symptom this exists for: **the console iframe never opens**. The portal
 * signs every link with `guac.secret_key` and Guacamole verifies it with its own
 * `JSON_SECRET_KEY`; when the two disagree — a stack recreated from an older `.env`, or
 * a gateway deployed on its own with a freshly generated key — Guacamole answers *every*
 * student with "Permission denied". The portal cannot see that: it hands over a
 * correctly-signed link, the iframe is blank, and nothing in either log says why.
 *
 * States: `ok` (accepted), `refused` (reached, but rejected our key — a mismatch, or
 * the JSON auth extension is off), `unreachable` (no answer: split-horizon DNS and a
 * stopped gateway are both normal here, so this is a warning), and `skipped` (no console
 * configured at all, or a key that cannot be used).
 */
export async function checkToken(
  settings: ConsoleSettings,
  options: CheckTokenOptions = {},
): Promise<{ state: ConsoleCheckState; detail: string }> {
  const base = (settings.guac.baseUrl || "").trim();
  if (!base) {
    return { state: "skipped", detail: "guac.base_url is not set, so this range has no console to check" };
  }

  const keyRead = readSecretKey(settings.guac);
  if (!keyRead.ok) {
    return {
      state: "skipped",
      detail: `guac.secret_key is unusable, so there is no console link to test: ${keyRead.detail}`,
    };
  }
  const key = keyRead.key;

  // A payload for a machine that does not have to exist: the gateway answers the
  // *signature* question at token time and only dials the VM when the console opens.
  const payload: Record<string, unknown> = {
    username: "ontrak-doctor",
    expires: Math.trunc(((options.nowSeconds ?? Date.now() / 1000) + 60) * 1000),
    connections: {
      "OnTrak doctor": {
        id: "ontrak-doctor",
        protocol: "rdp",
        parameters: { hostname: "127.0.0.1", port: String(settings.guest.rdpPort) },
      },
    },
  };
  const url = `${base.endsWith("/") ? base : `${base}/`}api/tokens`;
  const sender = options.post ?? defaultPoster;

  const sent = await sendProbe(
    sender,
    url,
    { data: encodePayload(payload, key) },
    options.timeoutSeconds ?? PROBE_TIMEOUT_SECONDS,
  );
  if (!sent.ok) {
    return { state: "unreachable", detail: `could not reach the console gateway at ${base}: ${sent.error}` };
  }

  if (sent.status === 200 && sent.body.includes("authToken")) {
    return {
      state: "ok",
      detail: `the console gateway at ${base} accepted a payload signed with guac.secret_key`,
    };
  }
  if (sent.status === 401 || sent.status === 403) {
    return {
      state: "refused",
      detail:
        `the console gateway at ${base} rejected a payload signed with guac.secret_key ` +
        `(HTTP ${sent.status}). Its JSON_SECRET_KEY differs from this key, or its JSON auth ` +
        "extension is not enabled — so every student's console link is refused and the " +
        "console never opens. Make JSON_SECRET_KEY equal ONTRAK_GUAC__SECRET_KEY " +
        "(config: guac.secret_key) and recreate the gateway: " +
        "`docker compose up -d --force-recreate guacamole`",
    };
  }
  return {
    state: "unreachable",
    detail: `the console gateway at ${base} answered HTTP ${sent.status}: ${sent.body.slice(0, 200)}`,
  };
}
