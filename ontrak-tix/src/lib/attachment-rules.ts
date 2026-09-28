/**
 * Attachment rules (M1): what a requester or agent may attach to a ticket.
 *
 * Uploads are the classic place a support desk is attacked, so the validation
 * is pure, deny-by-default and exhaustively tested. The bytes go to object
 * storage behind a `BlobStore` port; this module only decides *whether* and
 * *what metadata* — it never touches the filesystem.
 */

export const ATTACHMENT_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_DEFAULT_MAX_COUNT = 10;
export const ATTACHMENT_FILENAME_MAX = 180;

/**
 * An allow-list, not a deny-list. Executables, scripts and archives are absent
 * on purpose: a support desk has no reason to accept them, and an allow-list
 * cannot be outflanked by a new extension.
 */
export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export interface AttachmentLimits {
  maxBytes: number;
  maxCount: number;
  allowedTypes: readonly string[];
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxBytes: ATTACHMENT_DEFAULT_MAX_BYTES,
  maxCount: ATTACHMENT_DEFAULT_MAX_COUNT,
  allowedTypes: ALLOWED_ATTACHMENT_TYPES,
};

/** What a client submits for one file, before it is validated. */
export interface AttachmentCandidate {
  filename: string;
  contentType: string;
  byteSize: number;
}

export interface AttachmentIssue {
  field: string;
  message: string;
}

export function isAllowedType(contentType: string, allowed: readonly string[] = ALLOWED_ATTACHMENT_TYPES): boolean {
  const normalized = contentType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return allowed.includes(normalized);
}

/**
 * A filename that cannot escape its directory or break a header: strip any path
 * segments, drop control characters, collapse the result to a safe core and cap
 * its length while preserving the extension.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim();
  const safe = cleaned.replace(/^\.+/, "") || "file";
  if (safe.length <= ATTACHMENT_FILENAME_MAX) return safe;

  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 ? safe.slice(dot) : "";
  const stemLength = Math.max(1, ATTACHMENT_FILENAME_MAX - extension.length);
  return `${safe.slice(0, stemLength)}${extension}`;
}

/** The extension of a sanitized filename, lower-cased, including the dot. */
export function fileExtension(name: string): string {
  const safe = sanitizeFilename(name);
  const dot = safe.lastIndexOf(".");
  return dot > 0 ? safe.slice(dot).toLowerCase() : "";
}

/** Validate one candidate against the limits and the ticket's existing files. */
export function validateAttachment(
  candidate: AttachmentCandidate,
  existingCount = 0,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): AttachmentIssue[] {
  const issues: AttachmentIssue[] = [];

  if (!candidate.filename?.trim()) {
    issues.push({ field: "filename", message: "A file name is required." });
  }

  if (!isAllowedType(candidate.contentType, limits.allowedTypes)) {
    issues.push({ field: "contentType", message: `Files of type ${candidate.contentType || "unknown"} are not allowed.` });
  }

  if (!Number.isFinite(candidate.byteSize) || candidate.byteSize <= 0) {
    issues.push({ field: "byteSize", message: "The file appears to be empty." });
  } else if (candidate.byteSize > limits.maxBytes) {
    issues.push({ field: "byteSize", message: `Files may be at most ${formatBytes(limits.maxBytes)}.` });
  }

  if (existingCount >= limits.maxCount) {
    issues.push({ field: "count", message: `A ticket may have at most ${limits.maxCount} attachments.` });
  }

  return issues;
}

/** Validate a whole upload batch, tracking the running count as it goes. */
export function validateAttachments(
  candidates: readonly AttachmentCandidate[],
  existingCount = 0,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): AttachmentIssue[] {
  const issues: AttachmentIssue[] = [];
  candidates.forEach((candidate, index) => {
    for (const issue of validateAttachment(candidate, existingCount + index, limits)) {
      issues.push({ ...issue, field: `attachments[${index}].${issue.field}` });
    }
  });
  return issues;
}

/** A collision-free object-storage key. The bytes never share a namespace. */
export function storageKeyFor(tenantId: string, ticketId: string, attachmentId: string, filename: string): string {
  return `tix/${tenantId}/${ticketId}/${attachmentId}${fileExtension(filename)}`;
}

/** A compact, human-readable size for the UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * The object-storage port. The app implements it against S3-compatible storage;
 * tests and local development use the in-memory implementation below.
 */
export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** An in-memory `BlobStore`, for tests and single-process local development. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array, _contentType?: string): Promise<void> {
    this.blobs.set(key, data.slice());
  }

  async get(key: string): Promise<Uint8Array | null> {
    const data = this.blobs.get(key);
    return data ? data.slice() : null;
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

/** The metadata the app persists for an accepted upload. */
export interface AttachmentRecord {
  id: string;
  tenantId: string;
  ticketId: string;
  messageId: string | null;
  uploaderId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  storageKey: string;
  createdAt: string;
}
