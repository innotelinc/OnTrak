/**
 * The signed compliance packet in the other two shapes an auditor asks for (2.2).
 *
 * The JSON packet is the record. These are *renderings* of it — the same rows, the same
 * hashes and the same signature, laid out for a spreadsheet and for a printed page —
 * never a second document with its own numbers. That distinction is the whole point of
 * the file: a CSV that recomputed the posture could disagree with the JSON it arrived
 * beside, and two signed-looking documents that disagree are worse than one.
 *
 * Both functions are pure and deterministic, for the same reason the packet is: an
 * export that changes between two runs on the same data is an export nobody can
 * compare.
 *
 * The PDF is written by hand rather than through a renderer because the product has no
 * PDF dependency and this needs none: one page of Helvetica text, one content stream, a
 * correct cross-reference table. It is a text rendering of the record, not a design;
 * the JSON is still the artefact to archive.
 */

import {
  packetVerificationReport,
  type CompliancePacket,
} from "./assurance-packet";

/* -------------------------------------------------------------------------- */
/*  CSV                                                                        */
/* -------------------------------------------------------------------------- */

/** One CSV cell: quoted only when it has to be, with quotes doubled inside. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The packet as CSV.
 *
 * A fixed section order and a fixed column set, so two exports can be diffed: the
 * packet's own facts first (including every hash and the signature), then the
 * controls, the policy scopes, the retention window, the control history and the audit
 * anchor. The signature is in the file so a recipient can check the CSV's claims
 * against the JSON without opening the JSON — the two carry the same values, and a
 * mismatch is visible in a line-by-line comparison.
 */
export function packetCsv(packet: CompliancePacket): string {
  const rows: string[][] = [["section", "key", "value", "detail"]];
  const row = (section: string, key: string, value: unknown, detail: unknown = "") => {
    rows.push([section, key, String(value ?? ""), String(detail ?? "")]);
  };

  row("packet", "format", packet?.packet);
  row("packet", "version", packet?.version);
  row("packet", "organization", packet?.organization);
  row("packet", "generatedAt", packet?.generatedAt);
  row("packet", "generatedBy", packet?.generatedBy);
  row("packet", "algorithm", packet?.algorithm);
  row("packet", "recordHash", packet?.recordHash);
  row("packet", "contentHash", packet?.contentHash);
  row("packet", "signature", packet?.signature);

  for (const control of packet?.controls ?? []) {
    row("control", control.control, control.state, control.detail);
  }
  for (const role of packet?.roles ?? []) {
    row(
      "role",
      role.title,
      role.requireMfa ? "second factor required" : "not required",
      `${role.identities} identit(ies), ${role.active} active, ${role.mfaEnrolled} with a factor; ` +
        `session ${role.maxSessionSeconds}s / idle ${role.idleTimeoutSeconds}s; ` +
        `${role.stored ? "stored" : "inherited"}`,
    );
  }
  for (const policy of packet?.policyVersions ?? []) {
    row("policy", policy.key, policy.version, `effective ${policy.effectiveAt}`);
  }

  const retention = packet?.retention;
  if (retention) {
    row("retention", "window", `${retention.months} month(s) from ${retention.windowStart}`, retention.detail);
    row("retention", "chain", `${retention.chainLength} event(s)`, `${retention.beforeWindow} before the window; oldest ${retention.oldestAt ?? "(none)"}`);
    row("retention", "source", retention.source);
  }

  // An empty history and an unreadable one are different facts, and the CSV says which.
  const history = packet?.controlHistory;
  if (history === null || history === undefined) {
    row("history", "total", "not asserted", "This exporter may not read the evidence trail.");
  } else {
    row("history", "total", history.total === null ? "not readable" : history.total, history.detail);
    for (const change of history.changes ?? []) {
      row(
        "history",
        change.controlId,
        change.at,
        `${change.from ?? "(first on record)"} -> ${change.to} by ${change.actor} (${change.ref})`,
      );
    }
  }

  row("audit", "verifiedAtExport", packet?.audit?.verified === true);
  row("audit", "length", packet?.audit?.length ?? 0, packet?.audit?.detail);

  return rows.map((cells) => cells.map(csvCell).join(",")).join("\n") + "\n";
}

/* -------------------------------------------------------------------------- */
/*  PDF                                                                        */
/* -------------------------------------------------------------------------- */

/** How wide one printed line is, in characters, at 9pt Helvetica on A4. */
const LINE_WIDTH = 104;

/** The most lines one page holds between the top and bottom margins. */
const MAX_LINES = 62;

/**
 * The printable reduction of a packet.
 *
 * Built from the same `packetVerificationReport` lines the console shows a verifier, so
 * the printed page and the JSON cannot describe the record differently; the retention
 * window and control history are appended because they are the two things 2.2 added to
 * the signed record.
 */
function packetLines(packet: CompliancePacket): string[] {
  const report = packetVerificationReport(packet, {
    ok: true,
    contentHash: String(packet?.contentHash ?? ""),
  });
  const lines: string[] = [
    "OnTrak Sentinel - compliance posture packet",
    "",
    ...report.lines,
    "",
    "Retention",
    `  ${packet?.retention?.detail ?? "(not stated)"}`,
    "",
    "Control history",
  ];

  const history = packet?.controlHistory;
  if (history === null || history === undefined) {
    lines.push("  (not asserted)");
  } else {
    lines.push(`  ${history.detail}`);
    for (const change of history.changes ?? []) {
      lines.push(
        `  ${change.controlId} at ${change.at}: ${change.from ?? "(first)"} -> ${change.to} ` +
          `[${change.actor} ${change.ref}]`,
      );
    }
  }

  lines.push("", "Controls");
  for (const control of packet?.controls ?? []) {
    lines.push(`  [${control.state}] ${control.control} - ${control.detail}`);
  }
  return lines;
}

/** A string as PDF's literal-string syntax allows it: ASCII, with `\ ( )` escaped. */
function pdfText(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Hard-wrap one logical line, preferring a space, never splitting the escape pairs. */
function wrap(line: string, width = LINE_WIDTH): string[] {
  const clean = line.replace(/\s+$/, "");
  if (clean.length <= width) return [clean];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(" ", width);
    const at = cut > width / 2 ? cut : width;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The packet as a one-page PDF.
 *
 * Deliberately minimal and hand-written: object 1 the catalog, 2 the page tree, 3 the
 * page, 4 the content stream, 5 the font. The cross-reference table carries the real
 * byte offset of every object, which is the part a PDF reader will refuse to open the
 * file without — so the test that matters here is that each offset points at its object.
 *
 * If the record runs past one page, the page says how many lines were not printed and
 * points at the JSON and CSV. Silently dropping rows from a compliance document would
 * be the same sin as silently dropping chain entries.
 */
export function packetPdf(packet: CompliancePacket): Uint8Array {
  let lines = packetLines(packet).flatMap((line) => wrap(line));
  if (lines.length > MAX_LINES) {
    const omitted = lines.length - (MAX_LINES - 1);
    lines = [
      ...lines.slice(0, MAX_LINES - 1),
      `... ${omitted} more line(s) not printed; the JSON and CSV carry every row.`,
    ];
  }

  const streamBody = [
    "BT",
    "/F1 9 Tf",
    "12 TL",
    "40 800 Td",
    ...lines.map((line) => `(${pdfText(line)}) Tj T*`),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let position = chunks[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(object);
    position += object.length;
  });

  const xrefOffset = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(xref);

  // ASCII throughout (`pdfText` guarantees it), so one byte per character and the
  // offsets above are the offsets in the file.
  const text = chunks.join("");
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}
