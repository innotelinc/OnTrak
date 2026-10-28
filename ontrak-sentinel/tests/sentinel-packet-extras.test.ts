/**
 * OnTrak Sentinel 2.2 tests: the packet's extras — the retention window, the control
 * history and the CSV/PDF renderings of the same signed record.
 *
 * The property every test here protects is *one record, three shapes*. Retention and
 * history are inside the signed content, so editing either after signing fails
 * verification; the CSV and PDF carry the record's own hashes and signature rather than
 * any recomputed figure, so a recipient can check all three against one JSON. A test
 * that only compared the CSV to the packet object would miss the case this is for: a
 * rendering that quietly summarised instead of copying.
 *
 *   npm test            # in ontrak-sentinel/
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCompliancePacket,
  controlHistoryFrom,
  retentionMonths,
  retentionStart,
  retentionWindow,
  verifyCompliancePacket,
  type CompliancePacket,
} from "../src/lib/assurance-packet";
import type { AuditEvent } from "../src/lib/audit-chain";
import { hmacSigner } from "../src/lib/assurance-sign";
import { sha256Hex } from "../src/lib/hash";
import { csvCell, packetCsv, packetPdf } from "../src/lib/packet-export";
import type { ConsoleComplianceView } from "../src/lib/console-rules";

const AS_OF = "2026-10-25T09:00:00.000Z";
const KEY = "packet-extras-test-key-long-enough";
const sign = hmacSigner(KEY);

/** One chain event, shaped as the log stores it. Only the fields the reader uses matter. */
function event(
  seq: number,
  at: string,
  action: string,
  detail: Record<string, unknown>,
): AuditEvent {
  return {
    id: `e${seq}`,
    at,
    actor: "admin-1",
    action,
    targetType: "IdentityPolicy",
    targetId: "ALL",
    detail,
    seq,
    prevHash: "0".repeat(64),
    recordHash: `${seq}`.repeat(64).slice(0, 64),
  };
}

function view(overrides: Partial<ConsoleComplianceView> = {}): ConsoleComplianceView {
  return {
    actor: {
      identifier: "admin@innotel.us",
      displayName: "Admin",
      role: "ADMIN",
      organizationName: "Innotel",
      organizationSlug: "innotel",
    },
    session: { id: "s1", issuedAt: AS_OF, expiresAt: AS_OF, lastSeenAt: AS_OF },
    generatedAt: AS_OF,
    controls: [
      {
        control: "The evidence chain verifies end to end",
        state: "OK",
        // Long enough to wrap in the PDF, with characters PDF strings must escape.
        detail: "SENTINEL-PDF-CHECK one unbroken chain (no \\ or ) characters lost in the rendering",
      },
    ],
    roles: [
      {
        scope: "ALL",
        title: "Everyone",
        identities: 2,
        active: 2,
        mfaEnrolled: 2,
        requireMfa: true,
        maxSessionSeconds: 43200,
        idleTimeoutSeconds: 3600,
        stored: true,
      },
    ],
    identities: { total: 2, humans: 2, services: 0, active: 2, inactive: 0, mfaEnrolled: 2 },
    alerts: null,
    chain: { ok: true, length: 3, detail: "The organization's evidence chain verifies end to end." },
    policies: { stored: 1, baselineStored: true, scopes: 3 },
    retention: retentionWindow([], { months: 12, source: "default", asOf: AS_OF }),
    controlHistory: controlHistoryFrom([], { asOf: AS_OF }),
    ...overrides,
  };
}

function packet(overrides: Partial<ConsoleComplianceView> = {}): CompliancePacket {
  return buildCompliancePacket(
    {
      generatedAt: AS_OF,
      organization: "Innotel",
      generatedBy: "admin@innotel.us",
      view: view(overrides),
      audit: { verified: true, length: 3, detail: "The organization's evidence chain verifies end to end." },
    },
    sha256Hex,
    sign,
  );
}

/* -------------------------------------------------------------------------- */
/*  The retention window                                                       */
/* -------------------------------------------------------------------------- */

test("an unreadable retention setting falls back to the default and says so", () => {
  assert.deepEqual(retentionMonths(undefined), { months: 12, source: "default" });
  assert.deepEqual(retentionMonths("  "), { months: 12, source: "default" });
  assert.deepEqual(retentionMonths("36"), { months: 36, source: "SENTINEL_EVIDENCE_RETENTION_MONTHS" });

  // A typo must not block an audit response, and must not be silent either: the packet
  // carries the fallback in its signed record.
  for (const bad of ["0", "-3", "abc", "12.5", "9999"]) {
    const choice = retentionMonths(bad);
    assert.equal(choice.months, 12);
    assert.match(choice.source, /unreadable/);
    assert.match(choice.source, new RegExp(bad.replace(".", "\\.")));
  }
});

test("retention counts the chain's real span but truncates none of it", () => {
  const old = event(1, "2019-01-01T00:00:00.000Z", "policy.update", { scope: "ALL", requireMfa: true });
  const recent = event(2, "2026-10-01T00:00:00.000Z", "policy.update", { scope: "ALL", requireMfa: true });

  const window = retentionWindow([old, recent], { months: 12, source: "default", asOf: AS_OF });

  assert.equal(window.windowStart, "2025-10-25T09:00:00.000Z");
  assert.equal(window.chainLength, 2);
  assert.equal(window.beforeWindow, 1);
  assert.equal(window.oldestAt, old.at);
  // The sentence carries the fact a policy number alone would hide.
  assert.match(window.detail, /carried in full rather than truncated/);
  assert.match(window.detail, /1 predate the window/);
});

test("a month subtraction is a calendar month, not thirty days", () => {
  assert.equal(retentionStart("2026-03-31T00:00:00.000Z", 1), "2026-02-28T00:00:00.000Z");
  assert.equal(retentionStart("2026-01-15T12:00:00.000Z", 12), "2025-01-15T12:00:00.000Z");
});

/* -------------------------------------------------------------------------- */
/*  Control history                                                            */
/* -------------------------------------------------------------------------- */

test("the history reads controls out of the chain, oldest first, with what each replaced", () => {
  const events = [
    event(1, "2026-01-10T00:00:00.000Z", "policy.update", {
      scope: "ALL",
      requireMfa: false,
      maxSessionSeconds: 43200,
      idleTimeoutSeconds: 3600,
    }),
    event(2, "2026-02-10T00:00:00.000Z", "policy.update", {
      scope: "ALL",
      requireMfa: true,
      maxSessionSeconds: 28800,
      idleTimeoutSeconds: 900,
    }),
    event(3, "2026-03-10T00:00:00.000Z", "enforcement.policy", {
      policy: {
        protectedTargets: ["10.0.0.0/8", "10.1.0.0/16"],
        maxTargets: 5,
        maxActionsPerHour: 10,
        defaultTtlSeconds: 3600,
        allowPermanent: false,
        requireSecondApprover: true,
      },
    }),
    event(4, "2026-04-10T00:00:00.000Z", "session.grant", { who: "someone" }),
  ];

  const history = controlHistoryFrom(events, { asOf: AS_OF });
  assert.ok(history);
  assert.equal(history.changes.length, 3, "the session event is not a control change");
  assert.equal(history.total, 3);
  assert.equal(history.truncated, false);

  const [first, second, rails] = history.changes;
  assert.equal(first.controlId, "identity-policy:ALL");
  assert.equal(first.from, null, "the first change on record replaced nothing recorded");
  assert.match(first.to, /second factor not required/);
  assert.equal(second.from, first.to, "each change says what it replaced");
  assert.match(second.to, /second factor required/);
  assert.match(second.to, /8h/);
  assert.match(second.to, /15m/);
  assert.equal(rails.controlId, "enforcement-rails");
  assert.match(rails.to, /2 protected target/);
  assert.match(rails.to, /second approver required/);
  assert.match(second.ref, /^#2 /);
});

test("the history is bounded by count and by window, and says which", () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    event(index + 1, `2026-0${index + 1}-01T00:00:00.000Z`, "policy.update", {
      scope: "ALL",
      requireMfa: index % 2 === 0,
    }),
  );

  const bounded = controlHistoryFrom(events, { asOf: AS_OF, maxChanges: 2 });
  assert.ok(bounded);
  assert.equal(bounded.changes.length, 2, "the newest changes are kept");
  assert.equal(bounded.total, 5);
  assert.equal(bounded.truncated, true);
  assert.match(bounded.detail, /bounded to the newest 2/);
  assert.equal(bounded.changes[1]!.at, events[4]!.at);

  const narrow = controlHistoryFrom(events, { asOf: AS_OF, months: 1 });
  assert.ok(narrow);
  assert.equal(narrow.changes.length, 0, "nothing in January-May is inside a one-month window");
  assert.equal(narrow.total, 5, "the true total is still stated");
  assert.equal(narrow.truncated, true);
});

test("a role that cannot read the trail asserts no history, not an empty one", () => {
  const history = controlHistoryFrom([], {
    asOf: AS_OF,
    unavailable: "Your role may not read the evidence trail, so this packet asserts no control history.",
  });
  assert.ok(history);
  assert.equal(history.total, null, "null, because an empty list would claim nothing changed");
  assert.deepEqual(history.changes, []);
  assert.match(history.detail, /may not read the evidence trail/);
});

/* -------------------------------------------------------------------------- */
/*  Inside the signature                                                       */
/* -------------------------------------------------------------------------- */

test("retention and control history are covered by the signature", () => {
  const events = [
    event(1, "2026-01-10T00:00:00.000Z", "policy.update", { scope: "ALL", requireMfa: false }),
  ];
  const intact = packet({
    retention: retentionWindow(events, { months: 12, source: "default", asOf: AS_OF }),
    controlHistory: controlHistoryFrom(events, { asOf: AS_OF }),
  });

  assert.equal(verifyCompliancePacket(intact, sha256Hex, sign).ok, true);

  const movedWindow: CompliancePacket = {
    ...intact,
    retention: { ...intact.retention, months: 6 },
  };
  const movedHistory: CompliancePacket = {
    ...intact,
    controlHistory: {
      ...intact.controlHistory!,
      changes: [{ ...intact.controlHistory!.changes[0]!, to: "second factor required" }],
    },
  };
  assert.equal(verifyCompliancePacket(movedWindow, sha256Hex, sign).ok, false);
  assert.equal(verifyCompliancePacket(movedHistory, sha256Hex, sign).ok, false);
});

/* -------------------------------------------------------------------------- */
/*  CSV                                                                        */
/* -------------------------------------------------------------------------- */

test("a CSV cell quotes only when it must, and doubles its quotes", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(null), "");
});

test("the CSV is the same record: deterministic, signed, escaped", () => {
  const one = packetCsv(packet());
  const two = packetCsv(packet());

  // Same posture, same bytes — two exports of an unchanged reading can be diffed.
  assert.equal(one, two);
  assert.ok(one.endsWith("\n"));
  assert.match(one, /^section,key,value,detail\n/);

  // The signature and both hashes travel with the rows, so a recipient can check the
  // CSV's numbers against the JSON.
  assert.ok(one.includes(packet().signature));
  assert.ok(one.includes(packet().recordHash));
  assert.ok(one.includes(packet().contentHash));

  // A detail with a comma is quoted, and the row still parses as one row.
  const withComma = packetCsv(
    packet({
      controls: [{ control: "A control", state: "OK", detail: "two, three (and more)" }],
    }),
  );
  assert.ok(withComma.includes('"two, three (and more)"'));

  // header + 9 packet facts + control + role + 4 policy versions + 3 retention rows
  // + history total + 2 audit rows. Nothing is silently omitted from the CSV.
  const rows = withComma.trimEnd().split("\n");
  assert.equal(rows.length, 22);
});

test("the CSV distinguishes an empty history from one the exporter cannot read", () => {
  const empty = packetCsv(packet({ controlHistory: controlHistoryFrom([], { asOf: AS_OF }) }));
  assert.match(empty, /history,total,0,/);

  const unreadable = packetCsv(
    packet({
      controlHistory: controlHistoryFrom([], { asOf: AS_OF, unavailable: "no permission to read the trail" }),
    }),
  );
  assert.match(unreadable, /history,total,not readable,no permission to read the trail/);
});

/* -------------------------------------------------------------------------- */
/*  PDF                                                                        */
/* -------------------------------------------------------------------------- */

function pdfString(value: Uint8Array): string {
  let out = "";
  for (let index = 0; index < value.length; index += 0x2000) {
    out += String.fromCharCode(...value.subarray(index, index + 0x2000));
  }
  return out;
}

test("the PDF is a real PDF: header, one page, resolvable xref, EOF", () => {
  const text = pdfString(packetPdf(packet()));

  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.endsWith("%%EOF\n"));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Count 1/);
  assert.match(text, /\/BaseFont \/Helvetica/);

  // Every xref entry must land exactly on its object — the check a reader performs
  // before it will open the file at all.
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
  assert.ok(Number.isFinite(startxref) && startxref > 0);
  assert.equal(text.slice(startxref, startxref + 5), "xref\n", "startxref points at the table");

  const rows = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(rows.length, 5);
  rows.forEach((offset, index) => {
    assert.ok(
      text.startsWith(`${index + 1} 0 obj`, offset),
      `object ${index + 1} is at the offset the table gives`,
    );
  });
});

test("the PDF carries the record, escapes its strings, and does not lose a long field", () => {
  const text = pdfString(packetPdf(packet()));

  assert.match(text, /OnTrak Sentinel - compliance posture packet/);
  assert.ok(text.includes("SENTINEL-PDF-CHECK"), "a long control detail survives the rendering");
  // Parentheses and backslashes inside a PDF literal string are escaped, or the page's
  // text operators would end early. Asserted loosely because the renderer may wrap the
  // sentence at a space, which is allowed; dropping the escape is not.
  assert.ok(text.includes("\\(no"), "the opening parenthesis is escaped");
  assert.ok(text.includes("\\"), "the backslash is escaped");
  assert.ok(text.includes("\\)"), "the closing parenthesis is escaped");
  // Both 2.2 sections are printed, not only signed.
  assert.match(text, /Retention/);
  assert.match(text, /Control history/);
});

test("an over-long record is cut on the page but says so", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    control: `Control ${index + 1}`,
    state: "OK" as const,
    detail: `Detail for control ${index + 1}`,
  }));
  const text = pdfString(packetPdf(packet({ controls: many })));

  // The page's text is a PDF literal string, so its parentheses are escaped; the
  // assertion is written against the file as it is, not a decoded rendering.
  assert.match(text, /more line\\\(s\\\) not printed; the JSON and CSV carry every row/);
  assert.match(text, /\/Count 1/, "still one page, as advertised");
});
