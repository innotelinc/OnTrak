import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "./omniroute.js";
// The signed-in account's own directory: a chat list is one person's, and
// another account signing in to the same deployment must not read it.
import { sessionsDir } from "./scope.js";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Model the user last picked for this chat, if any. */
  model?: string;
  /**
   * Fallback chain the user last picked for this chat. Absent means "use the
   * server default"; an empty array is a deliberate "nothing else, thanks".
   */
  fallbackModels?: string[];
  /**
   * Whether this chat may fall back to the offline gateway. Absent means "yes",
   * so only a deliberate opt-out is stored.
   */
  useOffline?: boolean;
  /** Step budget the user last picked for this chat, if any. */
  maxSteps?: number;
}

export interface Session extends SessionSummary {
  messages: ChatMessage[];
}

/** Hard bounds for a per-session step budget, so the UI cannot set something silly. */
export const MIN_STEPS = 1;
export const MAX_STEPS = 200;

/** A chain longer than this is not a fallback plan, it is a retry storm. */
export const MAX_FALLBACKS = 12;
const MAX_MODEL_ID = 120;

/**
 * Coerce a caller-supplied flag, or return undefined when they said nothing.
 *
 * Strings are accepted because the API is also driven by curl, where `false`
 * arrives as text and would otherwise be truthy.
 */
export function normalizeFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * Coerce a caller-supplied fallback chain into a clean list.
 *
 * Returns `undefined` when the caller did not ask for one at all, which is not
 * the same as an empty list: the former falls back to the server default, the
 * latter means "try this model and nothing else". Accepts an array or a
 * comma-separated string, because the API takes JSON and the UI sends the
 * literal text the user typed.
 */
export function normalizeModelList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry : ""))
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (parts === null) return undefined;

  const seen = new Set<string>();
  const models: string[] = [];
  for (const part of parts) {
    const id = part.trim().slice(0, MAX_MODEL_ID);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= MAX_FALLBACKS) break;
  }
  return models;
}

/** Clamp a caller-supplied step budget into range, or return undefined. */
export function normalizeMaxSteps(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.trunc(parsed)));
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionPath(id: string): string {
  // Guard the id before it touches the filesystem.
  if (!ID_PATTERN.test(id)) throw new Error("invalid session id");
  return path.join(sessionsDir(), `${id}.json`);
}

function summarize(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.fallbackModels !== undefined ? { fallbackModels: session.fallbackModels } : {}),
    ...(session.useOffline !== undefined ? { useOffline: session.useOffline } : {}),
    ...(session.maxSteps !== undefined ? { maxSteps: session.maxSteps } : {}),
  };
}

export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "New chat";
  return flat.length > 64 ? `${flat.slice(0, 61)}...` : flat;
}

export function createSession(): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
  };
}

export async function saveSession(session: Session): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  session.updatedAt = new Date().toISOString();
  session.messageCount = session.messages.length;
  await fs.writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export async function getSession(id: string): Promise<Session | null> {
  try {
    const raw = await fs.readFile(sessionPath(id), "utf8");
    const parsed = JSON.parse(raw) as Session;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir());
  } catch {
    return [];
  }

  const sessions: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    // Malformed or hand-edited files are skipped rather than breaking the list.
    const session = await getSession(id);
    if (session) sessions.push(summarize(session));
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}
