/**
 * The certificate sheet, as a PDF, with no dependencies.
 *
 * The chain in `certificate-chain.ts` signs a *document*, and the document is this: the
 * one-page sheet a learner can print, and the thing a signature is worth something on.
 * Signara signs PDFs, so the certificate has to become one, and the repository has no PDF
 * writer — adding one would be a dependency in a deploy path for a single page, which is
 * the same trade the lab importer refused when it declined to add a YAML reader. A
 * single-page PDF is a small, fully specified file: a catalogue, a page, one content
 * stream and two base-14 fonts. That is what this writes.
 *
 * Two things are deliberate.
 *
 * **Helvetica, unembedded.** The base-14 fonts are the one set every reader has, which is
 * what makes a 2 KB file render identically in a browser, an email attachment and a
 * thirty-year-old printer. Embedding a webfont would multiply the size and the surface
 * for no legibility gained.
 *
 * **The issuer is printed.** `AthenIQ` — not this product — because the credential is the
 * learning platform's, and a certificate that leaks out of this deployment should still
 * say whose it is. The code and the verification address go on the sheet for the same
 * reason: a certificate nobody can check is a picture.
 */

import { sheetPercent, type CertificateSheet } from "./certificate-chain-rules";

/** Letter, landscape. Origin bottom-left, as PDF wants it. */
const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;

interface Line {
  text: string;
  /** Baselines are given from the *top* here, because that is how a page is designed. */
  yFromTop: number;
  size: number;
  bold?: boolean;
}

/**
 * A string as a PDF literal, in WinAnsi bytes.
 *
 * The three characters that would end the literal early are escaped, and anything above
 * Latin-1 is dropped rather than mojibake'd: this file is assembled as bytes, so a
 * `name` with an em dash in it must not be able to break the dictionary it lands in.
 * Accented letters survive — they are single bytes in WinAnsi, which is why the encoding
 * is set on both fonts.
 */
export function pdfLiteral(text: string): string {
  let out = "";
  for (const character of text.normalize("NFC")) {
    const code = character.codePointAt(0) ?? 32;
    if (character === "(" || character === ")" || character === "\\") out += `\\${character}`;
    else if (code < 32) out += " ";
    else if (code <= 126) out += character;
    else if (code <= 255) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return out;
}

/**
 * Roughly where a centered line starts.
 *
 * Helvetica's glyphs are proportional, so this is an approximation — but the sheet is
 * centered for a human, and being a few points off on a name is invisible. Exact metrics
 * would mean carrying the AFM tables for two fonts to place six lines.
 */
function centeredX(text: string, size: number, bold: boolean): number {
  const perCharacter = size * (bold ? 0.56 : 0.5);
  return Math.max(24, (PAGE_WIDTH - text.length * perCharacter) / 2);
}

function formatDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Every line the sheet draws, in drawing order. Separate from the assembly so it can be read. */
export function certificateSheetLines(sheet: CertificateSheet): Line[] {
  const lines: Line[] = [
    { text: sheet.issuer.toUpperCase(), yFromTop: 74, size: 11, bold: true },
    { text: "CERTIFICATE OF COMPLETION", yFromTop: 116, size: 26, bold: true },
    { text: "This certifies that", yFromTop: 176, size: 12 },
    { text: sheet.learnerName, yFromTop: 236, size: 30, bold: true },
    { text: "completed", yFromTop: 292, size: 12 },
    { text: sheet.scenarioTitle, yFromTop: 336, size: 20, bold: true },
    {
      text: `${sheet.platform} · ${sheet.score} of ${sheet.maxScore} points · ${sheetPercent(sheet)}%`,
      yFromTop: 376,
      size: 13,
    },
  ];

  if (sheet.skills.length > 0) {
    lines.push({ text: `Competencies demonstrated: ${sheet.skills.join(", ")}`, yFromTop: 408, size: 11 });
  }

  lines.push(
    { text: `Issued ${formatDate(sheet.completedAt)}`, yFromTop: 448, size: 12 },
    {
      text: `Issued by ${sheet.issuer} · signed through Signara · stored on ONYX`,
      yFromTop: 496,
      size: 11,
    },
    { text: `Certificate ${sheet.code}`, yFromTop: 536, size: 12, bold: true },
    { text: `Verify at ${sheet.verifyUrl}`, yFromTop: 556, size: 10 },
  );

  return lines;
}

/** The content stream: one text object per line, which is all a sheet needs. */
export function certificateSheetContent(sheet: CertificateSheet): string {
  const parts = ["0.10 0.09 0.16 rg"];
  for (const line of certificateSheetLines(sheet)) {
    const font = line.bold ? "/F2" : "/F1";
    const x = centeredX(line.text, line.size, line.bold === true);
    const y = PAGE_HEIGHT - line.yFromTop;
    parts.push(`BT ${font} ${line.size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfLiteral(line.text)}) Tj ET`);
  }
  return parts.join("\n");
}

/**
 * The whole file.
 *
 * Assembled as bytes with the cross-reference table's byte offsets computed as it goes:
 * a reader that cannot find an object silently shows a blank page, so the offsets are the
 * one part of this format that cannot be approximated.
 */
export function renderCertificateSheet(sheet: CertificateSheet): Uint8Array {
  const content = certificateSheetContent(sheet);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [];
  let size = chunks[0].length;

  objects.forEach((body, index) => {
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(size);
    chunks.push(object);
    size += object.length;
  });

  const xrefAt = size;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefAt),
    "%%EOF",
    "",
  ].join("\n");
  chunks.push(xref);

  // Latin-1 rather than UTF-8: the literals were written as WinAnsi bytes, and a
  // UTF-8 encoder would turn every accented letter into two bytes the font cannot map.
  const file = chunks.join("");
  const bytes = new Uint8Array(file.length);
  for (let index = 0; index < file.length; index += 1) bytes[index] = file.charCodeAt(index) & 0xff;
  return bytes;
}
