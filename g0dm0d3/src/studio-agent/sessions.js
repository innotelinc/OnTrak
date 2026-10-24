import fs from "node:fs";
import path from "node:path";

/**
 * Studio conversation -> Genie session, kept across a restart.
 *
 * Genie keeps the transcript; the studio sends its own history with every
 * request. What makes turn two continue turn one is this map, and it is the only
 * state the container keeps, so it is written beside the volume named in
 * `G0DM0D3_AGENT_SESSIONS`.
 */

const SESSION_LIMIT = 500;

/** studio conversation key -> { sessionId, used } */
const sessions = new Map();
let sessionsLoaded = false;

function sessionsFile() {
  return process.env.G0DM0D3_AGENT_SESSIONS || path.join("/tmp", "g0dm0d3-agent-sessions.json");
}

function loadSessions() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile(), "utf8"));
    for (const [key, value] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof value?.sessionId === "string" && value.sessionId !== "") {
        sessions.set(key, { sessionId: value.sessionId, used: Number(value.used) || 0 });
      }
    }
  } catch {
    // No file yet, or one a previous version wrote badly: a missing mapping only
    // means a new Genie session, never a failed turn.
  }
}

function saveSessions() {
  try {
    const file = sessionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ sessions: Object.fromEntries(sessions) }));
    fs.renameSync(temporary, file);
  } catch {
    // Continuity across a restart is a convenience; it must never break a turn.
  }
}

export function sessionFor(key) {
  loadSessions();
  return sessions.get(key)?.sessionId ?? "";
}

export function rememberSession(key, sessionId) {
  loadSessions();
  sessions.set(key, { sessionId, used: Date.now() });
  if (sessions.size > SESSION_LIMIT) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => a[1].used - b[1].used)
      .slice(0, sessions.size - SESSION_LIMIT);
    for (const [stale] of oldest) sessions.delete(stale);
  }
  saveSessions();
}

/** Test hook: forget every mapping, including the file it came from. */
export function forgetSessions() {
  sessions.clear();
  sessionsLoaded = false;
  try {
    fs.rmSync(sessionsFile(), { force: true });
  } catch {
    // Best effort.
  }
}
