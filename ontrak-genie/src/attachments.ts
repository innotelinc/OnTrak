import path from "node:path";

/**
 * Images a person attaches to a turn.
 *
 * A screenshot is how somebody says "this is what it looks like when it breaks",
 * and asking them to describe it in words is asking them to leave out the thing
 * they came to show. So a turn may carry images, and they travel to the model as
 * OpenAI-compatible content parts — the wire shape every provider on the gateway
 * understands — beside the text.
 *
 * What arrives is a browser's `File`, so it is treated as hostile input rather
 * than as a picture: the mime type is checked against an allowlist, the bytes are
 * checked against the file's own signature (a file called `.png` that is not a PNG
 * is refused, not forwarded), the decoded size and the per-turn count are bounded
 * *before* anything is decoded or stored, and the name is reduced to a basename so
 * a crafted one cannot be read as a path by anything downstream.
 *
 * The images ride on the user message (`ChatMessage.images`) rather than being
 * folded into `content`. A transcript is JSON that gets written on every step and
 * re-read when a chat is reopened, and a message whose content is an array of
 * content parts is a shape the console, the CLI and every renderer of a transcript
 * would each have to learn. A field beside the text is one field for the model
 * layer to translate (`modelMessages`) and one for a renderer to show — and the
 * text of a turn stays the string it has always been.
 */

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** The image types the gateway's providers accept inline. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof IMAGE_TYPES)[number];

/** Most images one turn may carry. */
export const MAX_IMAGES = 4;
/**
 * Largest decoded image, in bytes.
 *
 * Deliberately below the 5 MB inline limit every one of these providers applies,
 * because the *encoded* form is what travels: base64 inflates by a third, and a
 * request that one provider accepts and another 413s is a turn that works until
 * the fallback model is reached. A screenshot is well under this; a photograph
 * that is not is asking the user to crop it.
 */
export const MAX_IMAGE_BYTES = 1_500_000;
/** Ceiling on the whole turn, so four images cannot add up to a rejected request. */
export const MAX_TOTAL_BYTES = 3_000_000;
/** Longest name kept; the rest is display-only. */
const MAX_NAME = 80;

export interface ImageAttachment {
  /** Basename only, for display. */
  name: string;
  mimeType: ImageMime;
  /** Base64, without the data-URL prefix. */
  data: string;
  /** Decoded size in bytes. */
  bytes: number;
}

/** OpenAI-compatible content parts, as the gateway expects them. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A data URL, which is how an inline image is addressed on the wire. */
export function dataUrl(image: Pick<ImageAttachment, "mimeType" | "data">): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * Does the file start with this type's own signature?
 *
 * The mime type is a claim made by the browser about a file it never inspected.
 * Checking the first bytes is the difference between "we accept PNG" and "we
 * accept anything that says it is a PNG", and it costs one comparison per type.
 */
export function sniffImageType(bytes: Buffer): ImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** `photo.png` from anything a caller calls a name, or "" when there is nothing to show. */
function safeName(raw: unknown, index: number): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const base = path.basename(text.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "");
  if (base === "" || base === "." || base === "..") return `image-${index + 1}`;
  return base.length > MAX_NAME ? base.slice(0, MAX_NAME) : base;
}

function mimeOf(entry: Record<string, unknown>): string {
  const raw = typeof entry.mimeType === "string" ? entry.mimeType : typeof entry.type === "string" ? entry.type : "";
  // `image/jpg` is what some browsers still report for a JPEG; treat it as JPEG
  // rather than refusing a file the browser itself just handed us.
  const lowered = raw.trim().toLowerCase();
  return lowered === "image/jpg" ? "image/jpeg" : lowered;
}

/**
 * Validate and decode the images a turn carried.
 *
 * Throws `AttachmentError` with a sentence a person can act on — the caller turns
 * it into a 400 rather than starting a turn that cannot work. `undefined` and an
 * empty array are both "no images", which is the ordinary turn.
 */
export function parseImages(raw: unknown): ImageAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError("attachments must be an array of images");
  if (raw.length > MAX_IMAGES) {
    throw new AttachmentError(`at most ${MAX_IMAGES} images may be attached to one message`);
  }

  const images: ImageAttachment[] = [];
  let total = 0;

  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new AttachmentError(`image ${index + 1} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const claimed = mimeOf(record);
    if (!(IMAGE_TYPES as readonly string[]).includes(claimed)) {
      throw new AttachmentError(
        `image ${index + 1} is ${claimed === "" ? "of an unknown type" : claimed}; supported types are ${IMAGE_TYPES.join(", ")}`,
      );
    }

    const rawData = typeof record.data === "string" ? record.data : "";
    if (rawData === "") throw new AttachmentError(`image ${index + 1} carried no data`);
    // A data URL is accepted as it is written, so a caller pasting one from the
    // console does not have to split it first.
    const comma = rawData.startsWith("data:") ? rawData.indexOf(",") : -1;
    const base64 = (comma === -1 ? rawData : rawData.slice(comma + 1)).replace(/\s+/g, "");
    if (base64 === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new AttachmentError(`image ${index + 1} is not valid base64`);
    }
    // Bounded before decoding: 4/3 of the ceiling is the most the encoded form can
    // be, so an oversized payload costs a comparison rather than a decode.
    if (base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) {
      throw new AttachmentError(
        `image ${index + 1} is larger than ${Math.round(MAX_IMAGE_BYTES / 1000)} KB; resize it and attach it again`,
      );
    }

    const bytes = Buffer.from(base64, "base64");
    if (bytes.length === 0) throw new AttachmentError(`image ${index + 1} decoded to nothing`);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new AttachmentError(
        `image ${index + 1} is larger than ${Math.round(MAX_IMAGE_BYTES / 1000)} KB; resize it and attach it again`,
      );
    }
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new AttachmentError(`the attached images add up to more than ${Math.round(MAX_TOTAL_BYTES / 1000)} KB`);
    }

    const actual = sniffImageType(bytes);
    if (actual === null) {
      throw new AttachmentError(`image ${index + 1} is not a PNG, JPEG, WebP or GIF`);
    }
    if (actual !== claimed) {
      throw new AttachmentError(`image ${index + 1} says it is ${claimed} but its contents are ${actual}`);
    }

    images.push({
      name: safeName(record.name, index),
      mimeType: actual,
      data: bytes.toString("base64"),
      bytes: bytes.length,
    });
  });

  return images;
}

/**
 * The user turn as the model sees it.
 *
 * Text first, then the images: the sentence frames what is being looked at, and a
 * vision model reads the parts in order. A turn with no text still gets an empty
 * text part, because some providers reject a message made only of images.
 */
export function contentParts(text: string, images: readonly ImageAttachment[]): ContentPart[] {
  return [
    { type: "text", text },
    ...images.map((image): ContentPart => ({ type: "image_url", image_url: { url: dataUrl(image) } })),
  ];
}

/** A one-line description of what was attached, for the transcript and the CLI. */
export function describeImages(images: readonly ImageAttachment[]): string {
  if (images.length === 0) return "";
  const names = images.map((image) => `${image.name} (${Math.max(1, Math.round(image.bytes / 1024))} KB)`);
  return names.length === 1 ? `attached ${names[0]}` : `attached ${names.length} images: ${names.join(", ")}`;
}
