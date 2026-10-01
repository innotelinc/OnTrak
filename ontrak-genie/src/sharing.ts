import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { accountScope } from "./scope.js";
import { readSessionIn, type Session } from "./store.js";

/**
 * Shared transcripts (v0.4): hand one chat's *record* to a colleague.
 *
 * v0.4 is "beyond a single operator", and this is the first of its bullets. It is
 * deliberately the smallest version of sharing that is still true to the product:
 * a share is a **read of one transcript**, not a second operator, not a shared
 * workspace, and not a way to run a turn as somebody else. Three properties are
 * the whole design, and each is a refusal as much as a feature:
 *
 *   * **It is one transcript, by name.** A share names a session and a recipient
 *     address; it does not open the owner's workspace, their other chats, their
 *     file history or their key. The recipient sees what the owner chose to show
 *     and nothing beside it.
 *   * **It is still the owner's.** The transcript lives in the owner's slice of
 *     disk and is read from there, so revoking a share — or the owner deleting
 *     the chat — cannot leave a stale copy behind for the recipient to read. The
 *     store keeps a reference, never a duplicate.
 *   * **It is read-only, and the gate is untouched.** A recipient cannot continue
 *     a shared chat: the model route resolves sessions against *their own* store,
 *     so a shared id is simply absent there and the turn is refused by the same
 *     code path that refuses any unknown chat. Since every turn is gated per turn
 *     anyway, a share cannot become a way around an approval either — the
 *     recipient has no tools pointed at the owner's workspace to run.
 *
 * Who a share is for is an **address**, not an account id: the console knows the
 * signed-in person's email and does not ask the control plane to resolve anybody
 * else's. Matching the recipient by address means sharing needs no lookup that
 * could create an account, and it is a comparison the recipient's own sign-in
 * already carries. The honest limit, stated where it can be read: an address that
 * changes stops matching, which is a permission that lapses rather than one that
 * follows the wrong person.
 *
 * The store is one JSON file beside the sessions rather than a database, for the
 * same reason the workspace selection is: a share is a small, replaceable fact,
 * and a file that a backup already covers is one fewer thing to operate.
 */

export interface ShareRecord {
  id: string;
  /** The transcript being shown. */
  sessionId: string;
  /** Who owns it. The share is read from *this* account's slice. */
  ownerId: string;
  /** The owner's address, for the recipient's list. */
  ownerEmail: string;
  /** The recipient's address, lowercased. Matching is by this, not by id. */
  recipientEmail: string;
  /** When the share was made, ISO-8601. */
  createdAt: string;
}

/** A share as the recipient's list renders it: the share, plus the transcript's shape. */
export interface ShareSummary extends ShareRecord {
  title: string;
  updatedAt: string;
  messageCount: number;
  /**
   * Set when the owner has deleted the chat (or the share outlived it).
   *
   * Reported rather than dropped: a list that silently loses an entry somebody
   * was relying on is how a share turns into a mystery, and "the owner removed
   * this" is a fact the recipient can act on.
   */
  missing?: boolean;
}

const SHARE_FILE = (): string => path.join(config.dataDir, "shares.json");

/** Normalise an address for comparison. Empty is not an address. */
function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function readAll(): Promise<ShareRecord[]> {
  try {
    const raw = JSON.parse(await fs.readFile(SHARE_FILE(), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is ShareRecord => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Partial<ShareRecord>;
      return (
        typeof record.id === "string" &&
        typeof record.sessionId === "string" &&
        typeof record.ownerId === "string" &&
        typeof record.recipientEmail === "string"
      );
    });
  } catch {
    // No file yet, or an unreadable one: no shares. A share is a convenience, and
    // refusing to boot the console over one would be a worse failure than the
    // missing entry.
    return [];
  }
}

async function writeAll(records: ShareRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(SHARE_FILE()), { recursive: true });
  await fs.writeFile(SHARE_FILE(), `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

export type ShareOutcome =
  | { ok: true; share: ShareRecord; existing: boolean }
  | { ok: false; status: number; message: string };

/**
 * Share one of the caller's transcripts with an address.
 *
 * Idempotent on `(session, recipient)`: asking twice returns the share that
 * already exists rather than a second entry, because two entries would be two
 * things to revoke and one of them would be forgotten.
 */
export async function shareSession(input: {
  sessionId: string;
  ownerId: string;
  ownerEmail: string;
  recipientEmail: string;
  /** Whether the session exists in the owner's own slice. */
  owned: boolean;
}): Promise<ShareOutcome> {
  const recipient = normalizeEmail(input.recipientEmail);
  if (recipient === "") {
    return { ok: false, status: 400, message: "name the address to share with" };
  }
  if (!input.owned) {
    return { ok: false, status: 404, message: "session not found" };
  }
  if (recipient === normalizeEmail(input.ownerEmail)) {
    // Sharing with yourself reads like a typo and would put the chat in both of
    // the caller's own lists, which is a confusing way to say "nothing happened".
    return { ok: false, status: 400, message: "that is your own address" };
  }

  const records = await readAll();
  const existing = records.find(
    (entry) => entry.sessionId === input.sessionId && entry.recipientEmail === recipient,
  );
  if (existing) return { ok: true, share: existing, existing: true };

  const share: ShareRecord = {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    ownerId: input.ownerId,
    ownerEmail: normalizeEmail(input.ownerEmail),
    recipientEmail: recipient,
    createdAt: new Date().toISOString(),
  };
  records.push(share);
  await writeAll(records);
  return { ok: true, share, existing: false };
}

/** Every share addressed to this person, newest first. */
export async function sharesForRecipient(email: string): Promise<ShareRecord[]> {
  const recipient = normalizeEmail(email);
  if (recipient === "") return [];
  const records = await readAll();
  return records
    .filter((entry) => entry.recipientEmail === recipient)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every share this person has made, newest first. */
export async function sharesByOwner(ownerId: string): Promise<ShareRecord[]> {
  const records = await readAll();
  return records
    .filter((entry) => entry.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * One share, when this person is allowed to see it.
 *
 * The check is the whole function: a share is readable by the account that made
 * it and the address it names, and by nobody else — including by an
 * administrator, because there is no administrator of a person's chats.
 */
export async function shareReadableBy(
  shareId: string,
  viewer: { userId: string | null; email: string },
): Promise<ShareRecord | null> {
  const records = await readAll();
  const share = records.find((entry) => entry.id === shareId);
  if (!share) return null;
  const byOwner = viewer.userId !== null && share.ownerId === viewer.userId;
  const byRecipient = normalizeEmail(viewer.email) === share.recipientEmail;
  return byOwner || byRecipient ? share : null;
}

/** Withdraw a share. Either side may: a recipient may put it away, an owner may stop it. */
export async function revokeShare(
  shareId: string,
  viewer: { userId: string | null; email: string },
): Promise<ShareRecord | null> {
  const share = await shareReadableBy(shareId, viewer);
  if (share === null) return null;
  const records = await readAll();
  await writeAll(records.filter((entry) => entry.id !== shareId));
  return share;
}

/**
 * Read the transcript a share points at, from the **owner's** slice.
 *
 * This is the one place sharing touches another account's disk, and it does so by
 * constructing that account's sessions directory from their id through the same
 * `accountScope` the rest of the console uses — so the path rules are not
 * duplicated, and a share can never read outside the owner's own chats.
 */
export async function readShared(share: ShareRecord): Promise<Session | null> {
  return readSessionIn(accountScope(share.ownerId).sessions, share.sessionId);
}

/** The shape a recipient's list renders, with a deleted chat reported rather than dropped. */
export async function summarizeShare(share: ShareRecord): Promise<ShareSummary> {
  const session = await readShared(share);
  if (session === null) {
    return { ...share, title: "Removed by its owner", updatedAt: share.createdAt, messageCount: 0, missing: true };
  }
  return {
    ...share,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}
