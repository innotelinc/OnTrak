/* Coding agent web client — talks to the local server, which talks to OmniRoute. */

import { highlightCode, languageOf } from "./highlight.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  sessionId: null,
  model: "",
  streaming: false,
  controller: null,
  filePath: ".",
  toolCards: new Map(), // tool_call id -> card handles
  approvals: new Map(), // approval id -> card handle
  limits: { minSteps: 1, maxSteps: 200, defaultSteps: 30 },
  /** Fallback chain the server would use for a new chat; null until health answers. */
  fallbackDefault: null,
  /**
   * Whether this account chooses a model ("manual") or is served one ("auto").
   * Set from `/api/health`; auto hides the picker and the chain box, because a
   * control whose setting the server ignores is worse than no control at all.
   */
  modelSelection: "manual",
  /** The chain an automatic turn would use, strongest available first. */
  autoModels: [],
  /** The chain in play for this chat, so the sweep report can mark it. */
  chainModels: [],
  /**
   * The share this console is reading, when the transcript on screen is
   * somebody else's (v0.4). Non-null means read-only: there is no session of
   * your own behind it to continue, and the composer says so.
   */
  shareOf: null,
  lastFocus: null,
  viewer: { path: null, mode: "file", diff: null },
  /**
   * The file the agent is writing, as it is being written. `content` is what has
   * arrived so far and `diff` is filled in when the write lands and reports what
   * it changed.
   */
  preview: {
    name: null,
    path: null,
    content: "",
    diff: null,
    mode: "code",
    /** The tool call the pane is following, so another tool's result is ignored. */
    toolId: null,
    toolName: null,
    generating: false,
    /**
     * Whether the gateway streamed the call, so the pane could show the file
     * being written. `false` means it arrived complete in one frame; `undefined`
     * means no draft ever arrived (streaming is off), which is not the same
     * claim and must not be labelled as one.
     */
    streamed: undefined,
    /** Set when the user closes the pane, so a later draft does not reopen it. */
    dismissed: false,
    /** Whether the pane follows the end of the file as it grows. */
    follow: true,
  },
  /** Ids the last sweep proved can call a tool; null until it has answered. */
  sweepUsable: null,
};

/** Maximum diff rows to build in the DOM; the server already caps what it sends. */
const MAX_DIFF_ROWS = 1500;

/* --------------------------------------------------------------- auth token */

/*
 * The server can require a bearer token (WEB_TOKEN). Open the UI once as
 *   http://<host>:3400/?token=<token>
 * and the token is kept in sessionStorage for the tab, then removed from the
 * address bar so it does not linger in history or get shared by copy-paste.
 */
// Named for what it is — the browser-storage slot the token is kept in — not for
// what it holds. `secret-scan` blocks any identifier carrying a value under a
// `token`-shaped name, and that rule is right to be blunt: a name is all the
// scanner can see. The value is unchanged, so a token stored by an earlier build
// is still found. Do not rename this back into the guard.
const AUTH_KEY = "coding-agent-token";
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  try {
    sessionStorage.setItem(AUTH_KEY, urlToken);
  } catch {
    /* private mode: fall back to in-memory only */
  }
  history.replaceState(null, "", location.pathname);
}

let authToken = urlToken ?? "";
if (authToken === "") {
  try {
    authToken = sessionStorage.getItem(AUTH_KEY) ?? "";
  } catch {
    authToken = "";
  }
}

function withAuth(headers = {}) {
  return authToken === "" ? headers : { ...headers, Authorization: `Bearer ${authToken}` };
}

/* ---------------------------------------------------------------- markdown */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Small, dependency-free markdown subset: fences, inline code, bold, headings, bullets. */
function renderMarkdown(text) {
  const fences = [];
  let out = escapeHtml(text);

  out = out.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_match, code) => {
    fences.push(`<pre class="code"><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  out = out.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  out = out.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  out = out.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  out = out.replace(/^\s*[-*] (.+)$/gm, '<div class="li">• $1</div>');
  out = out.replace(/\n{2,}/g, "</p><p>");
  out = out.replace(/\n/g, "<br>");

  out = `<p>${out}</p>`;
  return out.replace(/\u0000FENCE(\d+)\u0000/g, (_match, index) => fences[Number(index)] ?? "");
}

/* ------------------------------------------------------------------ helpers */

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: withAuth(options.headers ?? {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(authHint(response, payload));
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** Turn a bare 401 into something the user can act on. */
function authHint(response, payload) {
  const detail = payload && typeof payload.error === "string" ? payload.error : "";
  // A bare 401 is the shared token's failure and has one specific fix; anything
  // more specific than that — a turn refused because the account is out of
  // quota, or because there is no account to spend on — is the server's to say,
  // and guessing at it here would send somebody to the wrong setting.
  if (response.status === 401 && (detail === "" || detail === "unauthorized")) {
    return authToken === ""
      ? "This UI needs an access token. Reopen it as http://<host>:3400/?token=<your WEB_TOKEN>."
      : "That access token was rejected. Check WEB_TOKEN in .env and reopen ?token=<token>.";
  }
  return detail || `${response.status} ${response.statusText}`;
}

/**
 * Send the browser to the sign-in gate when the server says it uses one.
 *
 * A 401 looks the same whether a deployment wants a shared token or a sign-in,
 * so the console cannot tell them apart from the failure. `/api/auth/status` is
 * the one route that answers without a session, and asking it once at startup is
 * what keeps a signed-out visitor from being shown a console that cannot load.
 *
 * The target is `/login` and not the provider directly: the gate names the
 * product and handles the case where no provider is configured, which a bare
 * redirect into `/api/auth/login` cannot.
 */
async function signInIfRequired() {
  try {
    // The token goes with the question. A deployment can require a shared bearer
    // *and* sign-in, and asking without it would report a token holder as signed
    // out — which is a redirect into a gate holding the credential they already
    // have.
    const response = await fetch("/api/auth/status", { headers: withAuth() });
    if (!response.ok) return;
    const status = await response.json();
    if (status.oidc && !status.authenticated) {
      // The gate takes `next`, so a link into a page inside the console comes
      // back to it rather than always to the root. Today the console has one
      // page; the parameter is what makes the second one not a regression.
      const here = location.pathname + location.search;
      location.replace(here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
    }
  } catch {
    // Unreachable is not this function's problem — the loads below report that
    // the way they always have.
  }
}

function scrollToBottom(force = false) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

function hideEmptyState() {
  const empty = $("#empty");
  if (empty) empty.remove();
}

/** Push a short line to the screen-reader live region. */
function announce(text) {
  const live = $("#live");
  if (live) live.textContent = text;
}

/* -------------------------------------------------------------------- diffs */

function diffLineNode(line) {
  const row = document.createElement("div");
  row.className = `diff-line ${line.type}`;

  const oldNo = document.createElement("span");
  oldNo.className = "diff-num";
  oldNo.textContent = line.oldLine === null || line.oldLine === undefined ? "" : String(line.oldLine);

  const newNo = document.createElement("span");
  newNo.className = "diff-num";
  newNo.textContent = line.newLine === null || line.newLine === undefined ? "" : String(line.newLine);

  const sign = document.createElement("span");
  sign.className = "diff-sign";
  sign.textContent = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";

  const text = document.createElement("span");
  text.className = "diff-text";
  text.textContent = line.text === "" ? " " : line.text;

  row.append(oldNo, newNo, sign, text);
  return row;
}

/** Render the before/after hunks the server attached to a file-changing tool. */
function renderDiff(diff) {
  const box = document.createElement("div");
  box.className = "diff";

  const head = document.createElement("div");
  head.className = "diff-head";
  const verb = diff.created ? "new file" : "modified";
  head.textContent = `${diff.path} — ${verb}, +${diff.added} −${diff.removed}`;
  box.append(head);

  let rows = 0;
  let clipped = false;

  for (const hunk of diff.hunks) {
    if (rows >= MAX_DIFF_ROWS) {
      clipped = true;
      break;
    }
    const hunkHead = document.createElement("div");
    hunkHead.className = "diff-hunk-head";
    hunkHead.textContent = `@@ -${hunk.oldStart} +${hunk.newStart} @@`;
    box.append(hunkHead);

    for (const line of hunk.lines) {
      if (rows >= MAX_DIFF_ROWS) {
        clipped = true;
        break;
      }
      box.append(diffLineNode(line));
      rows += 1;
    }
  }

  if (diff.truncated || clipped) {
    const note = document.createElement("div");
    note.className = "diff-hunk-head";
    note.textContent = "change is too large to show in full — open the file in the workspace panel to see it";
    box.append(note);
  }

  if (diff.hunks.length === 0 && !diff.truncated) {
    const note = document.createElement("div");
    note.className = "diff-hunk-head";
    note.textContent = "no textual change";
    box.append(note);
  }

  return box;
}

/* ------------------------------------------------------------ preview pane */

/*
 * The file being written, while it is being written.
 *
 * A write reaches the agent as one finished tool call, so the code is already
 * complete by the time anything could show it. The server forwards the call's
 * arguments as they arrive (`draft` events) and this renders them, which is the
 * point of the pane: watching a file appear instead of being told afterwards.
 * It stays on screen once the turn ends, because the code the agent just wrote is
 * usually what you want to look at next.
 */

const WRITER_TOOLS = new Set(["write_file", "edit_file"]);

function previewIsOpen() {
  return $("#preview").classList.contains("open");
}

/** The pane's open state, remembered for the tab so a reload keeps the layout. */
const PREVIEW_OPEN_KEY = "coding-agent-preview-open";

function rememberPreviewOpen(open) {
  try {
    sessionStorage.setItem(PREVIEW_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* private mode: the choice just does not outlive the page */
  }
}

function storedPreviewOpen() {
  try {
    return sessionStorage.getItem(PREVIEW_OPEN_KEY);
  } catch {
    return null;
  }
}

function togglePreview(force) {
  const open = force === undefined ? !previewIsOpen() : force;
  $("#preview").classList.toggle("open", open);
  $("#toggle-preview").setAttribute("aria-expanded", open ? "true" : "false");
  // Closing it is a preference: a draft later in the turn must not reopen it.
  if (!open) {
    state.preview.dismissed = true;
    cancelLiveDiff();
  }
  rememberPreviewOpen(open);
  // Whether the code and the change share the pane depends on it being open, so
  // the layout has to be re-applied here rather than only when content arrives.
  applyPreviewLayout();
}

/** The chip in the pane's header. `level` is "ok", "bad" or nothing. */
function setPreviewStatus(text, level) {
  const chip = $("#preview-status");
  chip.textContent = text;
  chip.className = text === "" ? "badge hidden" : `badge ${level ?? ""}`.trimEnd();
  if (text !== "") chip.title = text;
}

/**
 * Fill the change half of the pane.
 *
 * Called whenever the pane's diff changes - a live draft, the write landing, a
 * file restored from the transcript - so the box and the button that shows it
 * can never disagree about whether there is a change to show.
 */
function renderPreviewDiff() {
  const box = $("#preview-diff");
  box.replaceChildren();
  const diff = state.preview.diff;
  if (diff === null || diff === undefined) return;
  const rendered = renderDiff(diff);
  rendered.classList.add("diff-inline");
  box.append(rendered);
}

/**
 * Which view of the pane is on screen.
 *
 * Three, and they are three rather than two because they answer different
 * questions. **App** is the built thing running, which is what "preview" means to
 * anybody who is not the person writing the code. **Code** is the file the agent
 * is writing. **Change** is what that file did to the one it replaced. The app is
 * the default the toolbar button opens, and it is the one view that survives the
 * agent working: the other two are about a write that has already finished by the
 * time you read them.
 */
function applyPreviewLayout() {
  const pane = state.preview;
  const hasDiff = pane.diff !== null && pane.diff !== undefined;
  const app = pane.mode === "app";
  // A write that is still arriving shows the change beside the code: watching the
  // file take shape is the point, and the diff is the other half of that. Once
  // the call lands the pane goes back to one view and the toggle comes back.
  const live =
    !app && pane.generating === true && pane.name === "write_file" && hasDiff && previewIsOpen();
  const showDiff = pane.mode === "change" && hasDiff;

  $("#preview").classList.toggle("live", live);
  $("#preview-app").classList.toggle("hidden", !app);

  const run = $("#preview-run");
  run.textContent = app ? "show code" : "show app";
  run.setAttribute("aria-pressed", app ? "true" : "false");
  run.title = app ? "Show the code the agent is writing" : "Show the app, running";

  const toggle = $("#preview-toggle");
  // With both halves on screen at once there is nothing to switch between, and
  // the app view is a third thing neither half is about.
  toggle.classList.toggle("hidden", !hasDiff || live || app);
  toggle.textContent = showDiff ? "show code" : "show change";
  toggle.setAttribute("aria-pressed", showDiff ? "true" : "false");

  $("#preview-diff").classList.toggle("hidden", app || !(live || showDiff));
  $("#preview-body").classList.toggle("hidden", app || (!live && showDiff));
}

/** Show the app, the code, or - when there is a diff - let the button pick. */
function setPreviewMode(mode) {
  state.preview.mode = mode;
  applyPreviewLayout();
}

function previewBody(content, generating) {
  const body = $("#preview-body");
  const language = languageOf(state.preview.path);
  // The highlighter emits the same characters, only wrapped in spans, so
  // `textContent` still equals the source: it doubles as the "has anything
  // changed?" test and keeps the DOM writes down.
  if (body.textContent !== content || body.dataset.language !== language) {
    const html = highlightCode(content, language);
    body.dataset.language = language;
    if (html === null) body.textContent = content;
    else body.innerHTML = html;
  }
  body.classList.toggle("generating", generating === true);
  // Follow the end of a growing file, unless the reader scrolled away.
  if (state.preview.follow) body.scrollTop = body.scrollHeight;
}

let previewFrame = null;
let previewPending = null;

/**
 * Render a draft at most once per frame.
 *
 * A file arrives as many small events, each carrying the whole body so far, and
 * re-highlighting and re-rendering a large one for every one of them is what would
 * make the pane stutter instead of stream.
 */
function schedulePreviewBody(content, generating) {
  previewPending = { content, generating };
  if (previewFrame !== null) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = null;
    const pending = previewPending;
    previewPending = null;
    if (pending !== null) previewBody(pending.content, pending.generating);
  });
}

/*
 * The diff while the file is still being written.
 *
 * The pane can show the file landing, but not what it is doing to the file it is
 * replacing. That baseline is the file as it stands on disk, so this asks the
 * server to diff it against what has arrived - the same engine the viewer uses,
 * which keeps the two from ever disagreeing about what changed. Requests are
 * spaced out and never overlap: a long file arrives as many small drafts, and one
 * request per draft would spend the whole write diffing bodies that are about to
 * be replaced.
 */
const LIVE_DIFF_INTERVAL_MS = 400;
let liveDiffTimer = null;
let liveDiffInFlight = false;
let liveDiffAgain = false;

function cancelLiveDiff() {
  if (liveDiffTimer !== null) clearTimeout(liveDiffTimer);
  liveDiffTimer = null;
  liveDiffAgain = false;
}

function scheduleLiveDiff() {
  const pane = state.preview;
  // Only a whole-file write has a meaningful diff: an edit's "content" is the
  // replacement snippet, not the file that snippet goes into.
  if (pane.name !== "write_file" || pane.path === null || !previewIsOpen()) return;
  // A request is already queued, and it will read the body as it is when it runs.
  if (liveDiffTimer !== null) return;
  liveDiffTimer = setTimeout(() => {
    liveDiffTimer = null;
    void runLiveDiff();
  }, LIVE_DIFF_INTERVAL_MS);
}

async function runLiveDiff() {
  const pane = state.preview;
  if (pane.name !== "write_file" || pane.path === null) return;
  if (liveDiffInFlight) {
    liveDiffAgain = true;
    return;
  }

  const path = pane.path;
  const content = pane.content;
  liveDiffInFlight = true;
  try {
    const payload = await api("/api/file/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    // The turn may have moved on to another file while this was in flight.
    if (state.preview.path === path) {
      state.preview.diff = payload.diff ?? null;
      renderPreviewDiff();
      applyPreviewLayout();
    }
  } catch {
    // A diff that cannot be computed is not worth interrupting a write over.
  } finally {
    liveDiffInFlight = false;
    if (liveDiffAgain) {
      liveDiffAgain = false;
      scheduleLiveDiff();
    }
  }
}

function resetPreview() {
  cancelLiveDiff();
  // A running app outlives the chat it was started from, so the pane stays on it
  // rather than throwing the user back to an empty code view they did not ask for.
  const mode = state.preview.mode === "app" ? "app" : "code";
  state.preview = {
    ...state.preview,
    name: null,
    path: null,
    content: "",
    diff: null,
    mode,
    toolId: null,
    toolName: null,
    generating: false,
    streamed: undefined,
  };
  $("#preview-title").textContent = "nothing generated yet";
  setPreviewStatus("");
  previewBody("", false);
  renderPreviewDiff();
  setPreviewMode(mode);
  $("#preview-open").classList.add("hidden");
}

/** A tool call still arriving: show the file so far. */
function previewDraft(event) {
  const pane = state.preview;
  // A new file starts a new sequence. That covers a retry on another model too,
  // which must not leave the failed attempt's half-written body on screen.
  const fresh = pane.generating !== true || event.reset === true;
  if (fresh) {
    cancelLiveDiff();
    pane.diff = null;
    pane.toolId = null;
    pane.mode = "code";
    renderPreviewDiff();
  }

  if (!previewIsOpen() && pane.dismissed !== true) togglePreview(true);

  pane.name = event.name;
  if (event.path !== null && event.path !== undefined) pane.path = event.path;
  pane.content = event.content;
  pane.generating = true;
  pane.streamed = event.streamed === true;

  $("#preview-title").textContent = pane.path ?? `${event.name} — path not named yet`;
  schedulePreviewBody(event.content, true);
  // The app view is not switched away from: a file being written is not a reason
  // to take the running app off the screen, and the code is one click away. The
  // pane only follows the write when the code is what it is already showing.
  if (pane.mode !== "app") setPreviewMode("code");
  // The change, as far as it has been written, beside the file itself.
  scheduleLiveDiff();
  /*
   * A file that was never shown growing is not a stream, and the chip should not
   * pretend otherwise: this gateway hands the whole call over in one frame, so
   * the first thing the pane hears of it is the finished body.
   */
  if (event.complete === true && event.streamed === false) {
    setPreviewStatus("arrived complete", "ok");
    $("#preview-status").title =
      "The gateway sent this call in one frame, so the file could not be shown while it was written.";
  } else {
    setPreviewStatus(event.complete === true ? "writing complete" : "generating");
  }
  $("#preview-open").classList.toggle("hidden", pane.path === null);

  // Announced once per file, not once per token: the live region is for state
  // changes, and every delta arriving is not one.
  if (fresh) {
    const label = event.complete === true && event.streamed === false ? "Received" : "Generating";
    announce(`${label} ${event.name}${pane.path === null ? "" : `: ${pane.path}`}`);
  }
}

/** The call has landed: the body is final, so the caret comes off. */
function previewToolCall(event) {
  if (!WRITER_TOOLS.has(event.name)) return;
  const args = event.args !== null && typeof event.args === "object" ? event.args : {};
  const content =
    typeof args.content === "string"
      ? args.content
      : typeof args.new_string === "string"
        ? args.new_string
        : state.preview.content;

  const pane = state.preview;
  // Streaming is over, so no more live diffs: what is on screen is the file.
  cancelLiveDiff();
  if (pane.generating !== true) {
    pane.diff = null;
    pane.mode = "code";
    renderPreviewDiff();
  }

  pane.name = event.name;
  if (typeof args.path === "string" && args.path !== "") pane.path = args.path;
  pane.content = content;
  pane.generating = false;
  pane.toolId = event.id;
  pane.toolName = event.name;

  $("#preview-title").textContent = pane.path ?? event.name;
  previewBody(content, false);
  if (pane.mode !== "app") setPreviewMode("code");
  if (pane.streamed === false) {
    // Same distinction as above, now that the call has landed: say it arrived in
    // one piece rather than let the pane imply it was watched being written.
    setPreviewStatus("written in one frame", "ok");
    $("#preview-status").title =
      "The gateway sent this call in one frame, so the file could not be shown while it was written.";
  } else {
    setPreviewStatus(event.name === "edit_file" ? "edit ready" : "written");
  }
  $("#preview-open").classList.toggle("hidden", pane.path === null);
}

/** The write finished: report what changed, and offer the diff. */
function previewToolResult(event) {
  const pane = state.preview;
  // The name as well as the id: a text-mode call and the next one it triggers can
  // share an id in an older transcript, and the run's output is not the file's.
  if (pane.toolId === null || pane.toolId !== event.id || pane.toolName !== event.name) return;

  if (event.ok !== true) {
    const first = String(event.content ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
    setPreviewStatus("failed", "bad");
    $("#preview-status").title = first;
    return;
  }

  pane.diff = event.diff ?? null;
  renderPreviewDiff();
  setPreviewStatus(pane.diff ? `+${pane.diff.added} −${pane.diff.removed}` : "written", "ok");
  // Re-apply, so the change/code button appears now that there is a diff.
  setPreviewMode(pane.mode);
  announce(`${pane.path ?? "the file"} written`);
}

/**
 * Show a file taken from the transcript rather than from a live turn.
 *
 * A reload leaves the pane empty while the conversation beside it still shows the
 * write, because the drafts that filled it are never stored - only the finished
 * tool call is. So reopening a chat puts the newest file-writing call back in the
 * pane, marked as coming from the chat, with nothing streaming into it.
 */
function showRestoredFile(entry) {
  const pane = state.preview;
  const args = entry.args !== null && typeof entry.args === "object" ? entry.args : {};
  const content =
    typeof args.content === "string"
      ? args.content
      : typeof args.new_string === "string"
        ? args.new_string
        : "";

  pane.name = entry.name;
  pane.path = typeof args.path === "string" && args.path !== "" ? args.path : null;
  pane.content = content;
  pane.generating = false;
  // No tool id: nothing is in flight, so a later result must not settle this.
  pane.toolId = null;
  pane.toolName = null;
  pane.diff = entry.diff ?? null;

  $("#preview-title").textContent = pane.path ?? entry.name;
  previewBody(content, false);
  renderPreviewDiff();
  setPreviewMode("code");
  setPreviewStatus(pane.diff ? `+${pane.diff.added} −${pane.diff.removed}` : "written", "ok");
  $("#preview-status").title = "From this chat's transcript; nothing is being written right now.";
  $("#preview-open").classList.toggle("hidden", pane.path === null);
}

/* --------------------------------------------------------------- the running app */

/*
 * The app, running, in the pane.
 *
 * Everything else in this pane is about the *source*: the file being written, the
 * change it made. This is the other end of the same request — the thing the source
 * is for — and it is what "preview" means to somebody who did not write the code.
 *
 * Three mechanics worth stating.
 *
 * **It starts itself.** Clicking "run" on a project nobody has configured should
 * not answer with a variable name. The server works out what this project is
 * (its own dev script, manage.py, a directory with an index.html); the pane sends
 * that and shows what came back. `AGENT_PREVIEW_COMMAND` still overrides it.
 *
 * **The frame is same-origin, through the server.** Not a second host or port:
 * the app's own fetch, cookies and relative URLs then behave in the pane the way
 * they will in production, and the pane needs no certificate of its own.
 *
 * **It reloads on its own.** A dev server with hot reloading already does this;
 * `python3 -m http.server` does not, and neither does anything whose watcher
 * misses a file. The change stream covers both, and costs nothing when the app's
 * own reload got there first.
 */

const previewApp = {
  /** The last status the server reported, or null before the first answer. */
  status: null,
  /** The change stream, open while the app view is on screen. */
  stream: null,
  /** Debounce for reloads, so a write storm is one reload and not twenty. */
  reloadTimer: null,
};

/** The pane's "nothing is running" hint, kept so "starting" can borrow and restore it. */
const PREVIEW_EMPTY_HTML = $("#preview-app-empty").innerHTML;

/*
 * A dev server that is still building is asked about again rather than written off.
 *
 * The server answers `pending` when the process is up but has not bound its port
 * yet — a debug reloader starting, a bundler's first pass. The frame cannot load
 * an app that is not listening, so the pane polls the status on a short backoff
 * and loads the frame the moment `pending` clears. Bounded, because a project that
 * never binds is a fact the user has to see, not a spinner.
 */
const PREVIEW_PENDING_DELAYS = [400, 800, 1400, 2200, 3200, 4600, 6500];
const PREVIEW_RELOAD_DELAY_MS = 400;
let previewPendingTimer = null;
let previewPendingTries = 0;

function cancelPreviewPending() {
  if (previewPendingTimer !== null) clearTimeout(previewPendingTimer);
  previewPendingTimer = null;
  previewPendingTries = 0;
}

function schedulePreviewPending() {
  if (previewPendingTimer !== null || previewPendingTries >= PREVIEW_PENDING_DELAYS.length) return;
  const delay = PREVIEW_PENDING_DELAYS[previewPendingTries++];
  previewPendingTimer = setTimeout(() => {
    previewPendingTimer = null;
    if (previewAppRunning()) void refreshPreviewApp();
  }, delay);
}

function previewAppRunning() {
  return previewApp.status !== null && previewApp.status.running === true;
}

/** Where the pane points its frame: the proxied app, with this tab's token. */
function previewFrameUrl() {
  const params = new URLSearchParams();
  // A deployment with a shared token authorizes an iframe the same way it
  // authorizes a fetch; without this the frame is a 401 the user cannot see.
  if (authToken !== "") params.set("token", authToken);
  params.set("_", String(Date.now()));
  return `/preview/?${params.toString()}`;
}

/** Load the app into the frame. The cache-buster is what makes this a reload. */
function loadPreviewFrame() {
  const frame = $("#preview-frame");
  frame.dataset.loaded = "1";
  frame.src = previewFrameUrl();
}

function unloadPreviewFrame() {
  const frame = $("#preview-frame");
  delete frame.dataset.loaded;
  frame.src = "about:blank";
}

/** Paint the pane from a server status. Pure: no requests, no side effects. */
function applyPreviewApp(status) {
  previewApp.status = status;
  const running = status.running === true;
  // Up but not answering yet. Not "down": the app is on its way, and showing it
  // as stopped is what made a first click look like a preview that does not work.
  const pending = running && status.pending === true;

  $("#preview-app-dot").className = `preview-dot ${running ? "up" : "down"}`;
  /*
   * The published address when the deployment has one, and the pane's own path
   * otherwise. They are different facts: `/preview/` is where *this browser*
   * reaches the app, and `http://<lan>:<port>/` — when it exists — is where
   * anything else on the network does. Only the second one can be handed to a
   * webhook or opened on a phone.
   */
  const appUrl = $("#preview-app-url");
  appUrl.textContent = !running
    ? "no app running"
    : pending
      ? "starting…"
      : (status.address ?? `/preview/ · port ${status.port}`);
  appUrl.title = !running
    ? ""
    : status.address
      ? "Reachable on the network at this address"
      : "Reachable in this console only; set AGENT_LAN_IP and AGENT_PREVIEW_PUBLISH to publish it";
  // Borrow the hint for "starting", and put it back once it means what it says.
  const empty = $("#preview-app-empty");
  if (pending) empty.textContent = `Starting ${status.command ?? "the project"}… this can take a moment.`;
  else if (empty.innerHTML !== PREVIEW_EMPTY_HTML) empty.innerHTML = PREVIEW_EMPTY_HTML;
  empty.classList.toggle("hidden", running && !pending);

  $("#preview-frame").classList.toggle("hidden", !running || pending);
  $("#preview-app-start").classList.toggle("hidden", running);
  $("#preview-app-stop").classList.toggle("hidden", !running);
  $("#preview-app-reload").classList.toggle("hidden", !running);

  const log = status.log ?? "";
  $("#preview-app-log-toggle").classList.toggle("hidden", log === "");
  $("#preview-app-log").textContent = log;
  if (log === "") {
    const toggle = $("#preview-app-log-toggle");
    toggle.setAttribute("aria-expanded", "false");
    $("#preview-app-log").classList.add("hidden");
  }

  /*
   * One line that says what is true: why it is not up, or what was run. A
   * detected command is named as detected, because a guess the user did not make
   * is a guess they should be able to correct.
   */
  const note = $("#preview-app-note");
  let note_ = "";
  if (status.error) note_ = status.error;
  else if (pending) note_ = `starting: ${status.command ?? "the project"} — it may still be building`;
  else if (running && status.command) {
    note_ = `${status.detected ? "detected" : "running"}: ${status.command}`;
    if (status.address) note_ += ` · served on the network at ${status.address}`;
  } else if (!running && status.command) {
    // Before the click, not after: "will run: npm run dev" is what makes the
    // guess a thing the user can see and correct rather than a surprise.
    note_ = `will run: ${status.command}`;
  }
  note.textContent = note_;
  note.classList.toggle("hidden", note_ === "");

  // The frame waits for an app that is actually listening; the retry loop below
  // is what loads it once this stops saying `pending`.
  if (running && !pending && $("#preview-frame").dataset.loaded !== "1") loadPreviewFrame();
  if (!running) unloadPreviewFrame();
}

/** Ask the server what is running; wrong answers leave the last one on screen. */
async function refreshPreviewApp() {
  try {
    applyPreviewApp(await api("/api/preview"));
    if (previewApp.status !== null && previewApp.status.pending === true) schedulePreviewPending();
    else cancelPreviewPending();
  } catch {
    /* the pane keeps whatever it last knew rather than blanking on a hiccup */
  }
}

async function startPreviewApp() {
  const button = $("#preview-app-start");
  button.disabled = true;
  button.textContent = "starting";
  try {
    // No command: the server picks this project's own, which is the whole point
    // of the button. Anything it could not work out is in `error`, on screen.
    const status = await api("/api/preview/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    applyPreviewApp(status);
    if (status.pending === true) schedulePreviewPending();
    else cancelPreviewPending();
  } catch (error) {
    $("#preview-app-note").textContent = error.message;
    $("#preview-app-note").classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "run";
  }
}

async function stopPreviewApp() {
  cancelPreviewPending();
  try {
    applyPreviewApp(await api("/api/preview/stop", { method: "POST" }));
  } catch {
    /* stopping is idempotent; a refusal is worth a refresh, not a dialog */
  }
  unloadPreviewFrame();
  await refreshPreviewApp();
}

/** Reload the app, coalescing the burst a single save produces. */
function schedulePreviewReload() {
  if (!previewAppRunning()) return;
  if (previewApp.reloadTimer !== null) clearTimeout(previewApp.reloadTimer);
  previewApp.reloadTimer = setTimeout(() => {
    previewApp.reloadTimer = null;
    if (previewAppRunning()) loadPreviewFrame();
  }, PREVIEW_RELOAD_DELAY_MS);
}

/**
 * Open the change stream while the app view is on screen.
 *
 * Opened on the first look and closed when the pane is dismissed: a stream left
 * open is a request that never ends, and one opened for a pane nobody is looking
 * at is a reload nobody asked for.
 */
function watchPreviewChanges() {
  if (previewApp.stream !== null) return;
  const params = new URLSearchParams();
  if (authToken !== "") params.set("token", authToken);
  const stream = new EventSource(`/api/preview/events?${params.toString()}`);
  stream.addEventListener("message", schedulePreviewReload);
  // EventSource reconnects by itself; a failed one is a lost convenience, and
  // the run/reload buttons still work.
  previewApp.stream = stream;
}

function unwatchPreviewChanges() {
  cancelPreviewPending();
  if (previewApp.reloadTimer !== null) clearTimeout(previewApp.reloadTimer);
  previewApp.reloadTimer = null;
  if (previewApp.stream !== null) previewApp.stream.close();
  previewApp.stream = null;
}

/**
 * Show the app view, starting the project if it is not up.
 *
 * `autoStart` is false for the restore-on-load path: reopening the console should
 * not run anything by itself, but *clicking* preview should produce a picture of
 * the app rather than instructions for getting one.
 */
async function showPreviewApp(autoStart = true) {
  setPreviewMode("app");
  watchPreviewChanges();
  await refreshPreviewApp();
  if (previewAppRunning()) return;
  if (!autoStart) return;
  if (previewApp.status !== null && previewApp.status.command) await startPreviewApp();
}

/* ---------------------------------------------------------------- approvals */

function decisionText(decision) {
  if (decision === "approve") return "Approved";
  if (decision === "deny") return "Denied — nothing was run";
  if (decision === "timeout") return "Timed out — nothing was run";
  return "Cancelled";
}

async function respondToApproval(id, decision) {
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
  } catch (error) {
    // A 404 just means the turn already moved on; anything else is worth showing.
    if (error.status !== 404) addErrorMessage(error.message);
  }
}

/** A run_command or a large overwrite is waiting on a click. */
function addApprovalCard(event) {
  hideEmptyState();
  const card = document.createElement("div");
  card.className = "msg approval";

  const head = document.createElement("div");
  head.className = "approval-head";
  const title = document.createElement("span");
  title.className = "approval-title";
  title.textContent = `Approve ${event.name}?`;
  const summary = document.createElement("span");
  summary.className = "approval-summary mono";
  summary.textContent = event.summary;
  head.append(title, summary);

  const body = document.createElement("div");
  body.className = "approval-body";
  if (event.diff) body.append(renderDiff(event.diff));

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.className = "btn-primary";
  approve.textContent = "Approve";
  const deny = document.createElement("button");
  deny.className = "btn-danger";
  deny.textContent = "Deny";
  actions.append(approve, deny);

  card.append(head, body, actions);
  $("#messages").append(card);
  scrollToBottom(true);
  announce(`Approval needed for ${event.name}: ${event.summary}`);
  approve.focus();

  const settle = (decision) => {
    if (card.dataset.settled === "1") return;
    card.dataset.settled = "1";
    card.classList.add(decision === "approve" ? "approved" : "denied");
    actions.replaceChildren();
    const note = document.createElement("span");
    note.className = "approval-note";
    note.textContent = decisionText(decision);
    actions.append(note);
  };

  approve.addEventListener("click", () => {
    settle("approve");
    void respondToApproval(event.id, "approve");
  });
  deny.addEventListener("click", () => {
    settle("deny");
    void respondToApproval(event.id, "deny");
  });

  state.approvals.set(event.id, { settle });
}

function finishApprovalCard(id, decision) {
  state.approvals.get(id)?.settle(decision);
  announce(decisionText(decision));
}

/* ----------------------------------------------------------------- messages */

function addUserMessage(text) {
  hideEmptyState();
  const node = document.createElement("div");
  node.className = "msg msg-user";
  node.textContent = text;
  $("#messages").append(node);
  scrollToBottom(true);
}

function addAssistantMessage() {
  hideEmptyState();
  const node = document.createElement("div");
  node.className = "msg msg-assistant cursor";
  $("#messages").append(node);
  return node;
}

function addErrorMessage(text) {
  hideEmptyState();
  const node = document.createElement("div");
  node.className = "msg msg-error";
  node.textContent = text;
  $("#messages").append(node);
  scrollToBottom(true);
  announce(`Error: ${text}`);
}

function addNotice(text) {
  hideEmptyState();
  const node = document.createElement("div");
  node.className = "msg notice";
  node.textContent = text;
  $("#messages").append(node);
  scrollToBottom();
  announce(text);
}

function toolArgSummary(args) {
  if (args === null || typeof args !== "object") return typeof args === "string" ? args : "";
  for (const key of ["path", "command", "pattern", "cwd"]) {
    if (typeof args[key] === "string") return args[key];
  }
  return "";
}

function attachDiff(card, diff) {
  const rendered = renderDiff(diff);
  card.stat.textContent = `+${diff.added} −${diff.removed}`;

  if (card.diffBox) {
    card.diffBox.replaceWith(rendered);
  } else {
    // Show the diff first and tuck the raw tool output behind a disclosure, so
    // the interesting part is visible without hiding what the tool reported.
    card.content.prepend(rendered);
    const raw = document.createElement("details");
    raw.className = "tool-raw";
    const rawHead = document.createElement("summary");
    rawHead.textContent = "raw output";
    card.body.replaceWith(raw);
    raw.append(rawHead, card.body);
  }

  card.diffBox = rendered;
  card.diff = diff;
}

function addToolCard(id, name, args, diff) {
  hideEmptyState();
  const details = document.createElement("details");
  details.className = "tool";
  details.open = true;

  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "status-dot";
  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = name;
  const argEl = document.createElement("span");
  argEl.className = "tool-arg";
  argEl.textContent = toolArgSummary(args);
  const stat = document.createElement("span");
  stat.className = "tool-stat";
  summary.append(dot, nameEl, argEl, stat);

  const content = document.createElement("div");
  content.className = "tool-content";

  const body = document.createElement("pre");
  body.className = "tool-body";
  body.textContent = "running...";
  content.append(body);

  details.append(summary, content);
  $("#messages").append(details);

  const card = { details, dot, stat, body, content, diffBox: null, diff: null };
  state.toolCards.set(id, card);
  if (diff) attachDiff(card, diff);
  scrollToBottom(true);
}

function finishToolCard(id, name, ok, content, diff) {
  let card = state.toolCards.get(id);
  if (!card) {
    // A result can arrive with no matching call: a denied approval never emits
    // one. Render it as a card of its own rather than dropping the outcome.
    addToolCard(id, name, {}, diff);
    card = state.toolCards.get(id);
  }
  if (!card) return;
  card.dot.classList.add(ok ? "ok" : "bad");
  card.body.textContent = content;
  if (diff && !card.diff) attachDiff(card, diff);
  announce(`${name} ${ok ? "finished" : "failed"}`);
  scrollToBottom();
}

function setStreaming(streaming) {
  state.streaming = streaming;
  $("#send").classList.toggle("hidden", streaming);
  $("#stop").classList.toggle("hidden", !streaming);
  $("#messages").setAttribute("aria-busy", streaming ? "true" : "false");
  $("#input").disabled = false;
}

/* -------------------------------------------------------------------- chat */

function currentModel() {
  return $("#model").value || state.model;
}

function currentSteps() {
  const parsed = Number.parseInt($("#steps").value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(state.limits.maxSteps, Math.max(state.limits.minSteps, parsed));
}

/**
 * The chain as typed, or undefined when we should leave the decision alone.
 *
 * An empty box means "this model and nothing else" only once it has actually
 * been seeded or edited. Before that, sending it would silently turn the
 * fallback chain off just because health had not answered yet.
 */
function currentFallbacks() {
  const input = $("#fallbacks");
  if (input.dataset.known !== "true") return undefined;
  return input.value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function setFallbacks(models) {
  const input = $("#fallbacks");
  input.value = Array.isArray(models) ? models.join(",") : "";
  input.dataset.known = "true";
}

/** Fill the box from the server default, but only once health has told us it. */
function seedFallbacks() {
  if (state.fallbackDefault === null) return;
  setFallbacks(state.fallbackDefault);
}

/** May this chat fall back to the local model? */
function currentUseOffline() {
  return $("#use-offline").checked;
}

function setUseOffline(value) {
  $("#use-offline").checked = value;
}

/* ------------------------------------------------------------------- sweep */

/*
 * The sweep asks the gateway, model by model, whether it can make a tool call,
 * and renders the answer. The catalog cannot be trusted from the inside - a model
 * picker shows 500 ids and hides the fact that most of them answer with an error -
 * so the point of this panel is to make the provider list legible.
 */

let sweepTimer = null;

function sweepSection(title, lines, note) {
  const section = document.createElement("div");
  section.className = "sweep-section";

  const heading = document.createElement("div");
  heading.className = "sweep-heading";
  heading.textContent = note === undefined ? title : `${title} — ${note}`;

  const body = document.createElement("pre");
  body.className = "sweep-body";
  body.textContent = lines.join("\n");

  section.append(heading, body);
  return section;
}

/** Mark the rows that are already the chain in play, so the report is actionable. */
function chainMarker(model) {
  return (state.chainModels ?? []).includes(model) ? "   <- in your chain" : "";
}

/** "just now" / "12 min ago" / "3 h ago" / "2 d ago". */
function relativeAge(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** ", swept 3 h ago" - empty when the report is undated or the date is unusable. */
function sweptWhen(finishedAt) {
  const finished = typeof finishedAt === "string" ? Date.parse(finishedAt) : Number.NaN;
  if (!Number.isFinite(finished)) return "";
  return `, swept ${relativeAge(Date.now() - finished)}`;
}

/**
 * Point this chat at a model the sweep just proved works, from the report itself.
 * Reading the answer and then hunting for the id in a 578-entry picker is the
 * part of a sweep that was still manual.
 */
function sweepUseButton(model) {
  // An automatic account cannot pin a model to the chat, so the sweep's "use"
  // affordance is replaced by the reason rather than offered and then ignored.
  if (state.modelSelection === "auto") {
    const note = document.createElement("span");
    note.className = "muted sweep-use-note";
    note.textContent = "auto";
    note.title =
      "This account is served the model automatically, so a sweep cannot pin one to the chat. The result is still a useful check of the gateway.";
    return note;
  }
  const button = document.createElement("button");
  button.className = "btn-ghost sweep-use";
  button.textContent = "use";
  button.title = `Make ${model} the model for this chat`;
  button.addEventListener("click", () => {
    const select = $("#model");
    if (![...select.options].some((option) => option.value === model)) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      select.append(option);
    }
    select.value = model;
    state.model = model;
    void persistSettings();
    closeSweep();
    addNotice(`Model for this chat set to ${model}.`);
  });
  return button;
}

/**
 * Mark the picker's entries that the last sweep got a tool call out of. A
 * catalog of 578 ids is not a menu; this is the only part of it that has been
 * asked to do the one thing the agent needs.
 */
function annotateModels() {
  const usable = state.sweepUsable;
  if (usable === null) return;

  for (const option of $("#model").options) {
    if (option.dataset.marked === "true") continue;
    option.dataset.marked = "true";
    if (!usable.has(option.value)) continue;
    option.textContent = `${option.value} ✓`;
    option.title = "Made a tool call in the last catalog sweep";
  }
}

function updateSweepUsable(results) {
  state.sweepUsable = new Set(results.filter((result) => result.ok).map((result) => result.model));
  annotateModels();
}

function renderSweep(sweep) {
  const status = $("#sweep-status");
  const report = $("#sweep-report");
  const results = Array.isArray(sweep?.results) ? sweep.results : [];

  if (sweep?.running === true) {
    status.textContent = `probing ${sweep.done} of ${sweep.total}...`;
    status.classList.remove("stale");
  } else if (results.length === 0) {
    status.textContent =
      "Not run yet. A sweep costs one small request per model, so it only runs when you ask.";
    status.classList.remove("stale");
  } else {
    const working = results.filter((result) => result.ok).length;
    // A persisted report can be days old while looking current, so it carries the
    // time it was taken - and says so when that is long enough to have gone off.
    status.textContent =
      `${working} of ${results.length} can drive the agent (${sweep.scope} sweep${sweptWhen(sweep.finishedAt)}).` +
      (sweep.stale === true ? " Old enough that the gateway may have moved on - re-run it." : "");
    status.classList.toggle("stale", sweep.stale === true);
  }

  updateSweepUsable(results);
  report.replaceChildren();

  const working = results
    .filter((result) => result.ok)
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0));
  if (working.length > 0) {
    const section = document.createElement("div");
    section.className = "sweep-section";

    const heading = document.createElement("div");
    heading.className = "sweep-heading";
    heading.textContent = `Usable (${working.length}), fastest first — use one without hunting for it in the picker`;
    section.append(heading);

    for (const result of working) {
      const row = document.createElement("div");
      row.className = "sweep-row";
      row.append(sweepUseButton(result.model));

      const text = document.createElement("span");
      text.className = "sweep-model";
      const rerouted =
        result.servedAs && result.servedAs !== result.model ? `  -> ${result.servedAs}` : "";
      text.textContent = `${String(result.ms ?? "?").padStart(6)} ms  ${result.model}${rerouted}${chainMarker(result.model)}`;
      row.append(text);
      section.append(row);
    }
    report.append(section);
  }

  // Grouped by what can be done about it: one is the provider to fix, one is worth
  // retrying later, one is probably just this sweep's own load.
  const groups = [
    ["broken", "Broken", "fix these in the gateway's provider settings"],
    ["throttled", "Throttled", "credentials cooling down - often caused by the sweep itself"],
    ["slow", "No answer in time", "may be the queue under load rather than the model"],
  ];

  for (const [verdict, title, note] of groups) {
    const subset = results.filter((result) => !result.ok && result.verdict === verdict);
    if (subset.length === 0) continue;

    const byReason = new Map();
    for (const result of subset) {
      const reason = result.error ?? "unknown";
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(result.model);
    }

    const lines = [];
    for (const [reason, models] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`${models.length} x ${reason}`);
      for (const model of models.slice(0, 6)) lines.push(`      ${model}${chainMarker(model)}`);
      if (models.length > 6) lines.push(`      ...and ${models.length - 6} more`);
    }
    report.append(sweepSection(`${title} (${subset.length})`, lines, note));
  }
}

async function refreshSweep() {
  let payload;
  try {
    payload = await api("/api/models/sweep");
  } catch (error) {
    addErrorMessage(error.message);
    return null;
  }

  renderSweep(payload.sweep);

  // Poll only while it is running and on screen, so the panel is never a source
  // of requests on its own.
  if (payload.sweep?.running === true && !$("#sweep").classList.contains("hidden")) {
    if (sweepTimer === null) sweepTimer = setInterval(() => void refreshSweep(), 1000);
  } else if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    void loadHealth();
  }
  return payload.sweep;
}

async function runSweep(all) {
  const buttons = [$("#sweep-run"), $("#sweep-run-all")];
  for (const button of buttons) button.disabled = true;
  try {
    const payload = await api("/api/models/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all }),
    });
    renderSweep(payload.sweep);
    if (sweepTimer === null) sweepTimer = setInterval(() => void refreshSweep(), 1000);
  } catch (error) {
    addErrorMessage(error.message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function openSweep() {
  state.lastFocus = document.activeElement;
  $("#sweep").classList.remove("hidden");
  $("#sweep-close").focus();
  void refreshSweep();
}

function closeSweep() {
  $("#sweep").classList.add("hidden");
  // The poll exists to watch a running sweep; the panel is gone, so stop it.
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  state.lastFocus?.focus?.();
}

/**
 * Report whether the chain's models can still make a tool call, and when that was
 * last checked. The detail lives in the tooltip so the row stays one line.
 */
function renderModelHealth(info) {
  const dot = $("#models-dot");
  const label = $("#models-label");
  const total = info?.total ?? 0;

  if (total === 0) {
    dot.className = "status-dot";
    label.textContent = info?.intervalMs === 0 ? "chain check off" : "chain not checked yet";
    label.title =
      info?.intervalMs === 0
        ? "Set AGENT_HEALTH_INTERVAL_MS above 0 to check the chain on a timer."
        : "The first check runs a few seconds after the server starts.";
    return;
  }

  dot.className = `status-dot ${info.working === total ? "ok" : info.working > 0 ? "warn" : "bad"}`;
  label.textContent = `models ${info.working}/${total} ready`;
  const when = info.checkedAt === null ? "never" : new Date(info.checkedAt).toLocaleTimeString();
  label.title = `Tool-call check, last run ${when}:\n${info.entries
    .map(
      (entry) =>
        `${entry.ok ? "ok  " : "FAIL"} ${entry.model}${entry.offline ? " (offline)" : ""}` +
        (entry.ok ? ` - ${entry.ms} ms` : ` - ${entry.error}`),
    )
    .join("\n")}`;
}

/**
 * Show the account its own spend and the ceiling it is measured against.
 *
 * The plane records every turn's cost, so this is the half a person can act on —
 * how much of today's allowance is gone. The verdict and the caps come from the
 * same decision the turn gate reads, so the number here and the refusal on the
 * next turn cannot disagree. On a deployment with no control plane there is no
 * account to bill, and the row says that rather than showing a fake zero.
 */
function renderAccountUsage(usage) {
  const dot = $("#usage-dot");
  const label = $("#usage-label");
  if (dot === null || label === null) return;

  if (usage?.tenancy !== true || !usage.usageToday) {
    dot.className = "status-dot";
    label.textContent = "no account usage";
    label.title =
      usage?.error ??
      "This deployment runs as a single operator, so there is no account to read usage for.";
    return;
  }

  const today = usage.usageToday;
  const tokens = (today.tokensIn ?? 0) + (today.tokensOut ?? 0);
  const cap = usage.quota?.requestsPerDay ?? null;
  // The ceiling Genie enforces itself (v1.0). It is shown beside the plan rather
  // than merged into it, because the two are not the same kind of number: the
  // plan is what the account may spend, and this is the bound that stops a loop.
  const ceiling = usage.ceiling?.limit > 0 ? usage.ceiling : null;
  dot.className = `status-dot ${usage.allowed && (ceiling === null || ceiling.allowed) ? "ok" : "warn"}`;
  label.textContent =
    `today ${today.requests ?? 0} req / ${tokens} tok` +
    (cap === null ? " · uncapped" : ` / ${cap} req`) +
    (ceiling === null ? "" : ` · stop at ${ceiling.limit}`);
  label.title =
    `Signed in as ${usage.email}.\n` +
    `Today: ${today.requests ?? 0} requests, ${tokens} tokens, $${Number(today.costUsd ?? 0).toFixed(4)}.\n` +
    (cap === null
      ? "No daily request ceiling on this plan."
      : `${usage.allowed ? "Within" : "Over"} the ${cap} request/day ceiling.`) +
    (ceiling === null
      ? "\nThis deployment's own turn ceiling is off."
      : `\nGenie's own ceiling: ${ceiling.used} of ${ceiling.limit} turns started today ` +
        `(${ceiling.remaining} left). It resets at midnight UTC.`) +
    (usage.reasons?.length ? `\n${usage.reasons.join(", ")}` : "");
}

/**
 * Show, persistently, which gateway is answering. A notice scrolls away; a model
 * quietly falling back to a 7B local one is something the user should not have
 * to infer from the transcript.
 */
function setGatewayBadge(mode, model, url) {
  const badge = $("#gateway-badge");
  if (mode !== "offline") {
    badge.classList.add("hidden");
    badge.textContent = "";
    badge.removeAttribute("title");
    return;
  }
  badge.classList.remove("hidden");
  badge.textContent = `offline: ${model}`;
  badge.title = `${model} via ${url ?? "the offline gateway"} — everything on the main gateway failed, so the local model took over.`;
}

/**
 * Say which model an automatic turn is on, and why it is not a choice.
 *
 * The badge exists so the model is still *visible* when it is not selectable: a
 * person debugging a bad answer needs to know what answered, and "auto" on its
 * own would make a deployment with a stale health check look like a black box.
 * The chain is in the tooltip, because a fallback that happens mid-turn is worth
 * being able to predict.
 */
function setAutoBadge(models) {
  const badge = $("#model-auto");
  if (state.modelSelection !== "auto") {
    badge.classList.add("hidden");
    return;
  }
  const chain = (Array.isArray(models) ? models : state.autoModels).filter(
    (entry) => typeof entry === "string" && entry !== "",
  );
  badge.classList.remove("hidden");
  badge.textContent = chain.length === 0 ? "auto" : `auto / ${chain[0]}`;
  badge.title =
    chain.length > 1
      ? `Chosen automatically from the free pool, least-throttled first:\n${chain.join("\n")}`
      : chain.length === 1
        ? `${chain[0]} - chosen automatically from the free pool.`
        : "Chosen automatically from the free pool.";
}

async function sendMessage(text) {
  // A shared chat is a read. Refusing here is a courtesy rather than the control
  // — the server resolves sessions against your own store, so a turn against
  // somebody else's id is refused there too.
  if (state.streaming || state.shareOf !== null || text.trim() === "") return;

  // In automatic mode the server picks the chain, so nothing about a model is
  // sent: sending the hidden picker's value would be asking the server to hold an
  // opinion it has already said it decides itself.
  const auto = state.modelSelection === "auto";
  const model = auto ? undefined : currentModel();
  const maxSteps = currentSteps();
  const fallbacks = auto ? undefined : currentFallbacks();
  const useOffline = currentUseOffline();
  addUserMessage(text);
  $("#input").value = "";
  autoGrow();
  setStreaming(true);

  const assistant = addAssistantMessage();
  let buffer = "";
  state.controller = new AbortController();
  // Clear last turn's state; the server re-announces this turn's gateway.
  setGatewayBadge("primary");

  const onEvent = (event) => {
    switch (event.type) {
      case "session": {
        state.sessionId = event.id;
        $("#chat-title").textContent = event.title;
        showModelChain(event.models);
        // The server names the chain it actually chose, which in auto mode is
        // this turn's answer rather than a stored preference.
        setAutoBadge(event.models);
        void loadSessions();
        break;
      }
      case "approval_request":
        addApprovalCard(event);
        break;
      case "approval_result":
        finishApprovalCard(event.id, event.decision);
        break;
      case "gateway":
        setGatewayBadge(event.mode, event.model, event.url);
        break;
      case "text": {
        buffer += event.text;
        assistant.innerHTML = renderMarkdown(buffer);
        scrollToBottom();
        break;
      }
      case "draft":
        previewDraft(event);
        break;
      case "tool_call":
        addToolCard(event.id, event.name, event.args, event.diff);
        previewToolCall(event);
        break;
      case "tool_result":
        finishToolCard(event.id, event.name, event.ok, event.content, event.diff);
        previewToolResult(event);
        break;
      case "notice":
        addNotice(event.text);
        break;
      case "error":
        addErrorMessage(event.message);
        break;
      default:
        break;
    }
  };

  try {
    await streamChat(
      {
        sessionId: state.sessionId,
        message: text,
        model,
        ...(fallbacks === undefined ? {} : { fallbackModels: fallbacks }),
        useOffline,
        maxSteps,
      },
      onEvent,
      state.controller.signal,
    );
  } catch (error) {
    if (error.name !== "AbortError") addErrorMessage(error.message);
  } finally {
    assistant.classList.remove("cursor");
    if (buffer.trim() === "" && assistant.childElementCount === 0) assistant.remove();
    state.controller = null;
    setStreaming(false);
    void loadSessions();
    $("#input").focus();
  }
}

async function streamChat(payload, onEvent, signal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: withAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(authHint(response, detail));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    let split = pending.indexOf("\n\n");
    while (split !== -1) {
      const frame = pending.slice(0, split);
      pending = pending.slice(split + 2);
      split = pending.indexOf("\n\n");

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
}

/* ------------------------------------------------------------ session list */

/**
 * The chat list, and what may be done to a chat from it.
 *
 * Listing was the whole of this while a deployment was one operator with one
 * pile of chats; what it was missing is the ordinary housekeeping — a name that
 * is yours, putting a finished chat away, and deleting one. All three are on the
 * row itself rather than behind an admin screen, because the person who owns the
 * chat is the person who knows which of them it needs.
 *
 * Archiving folds rather than hides: the count stays visible and the folder
 * opens in place, so a chat that was put away is never something you have to
 * remember the existence of. The server keeps the transcript either way; this
 * only decides what the list draws.
 */
let showArchived = false;

async function loadSessions() {
  let sessions = [];
  try {
    ({ sessions } = await api("/api/sessions"));
  } catch {
    return;
  }

  const nav = $("#sessions");
  nav.replaceChildren();

  const archived = sessions.filter((session) => session.archived === true);
  for (const session of sessions) {
    if (session.archived !== true) nav.append(sessionRow(session));
  }

  if (archived.length > 0) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "session-archived-toggle";
    toggle.setAttribute("aria-expanded", showArchived ? "true" : "false");
    toggle.textContent = showArchived
      ? `hide archived (${archived.length})`
      : `archived (${archived.length})`;
    toggle.addEventListener("click", () => {
      showArchived = !showArchived;
      void loadSessions();
    });
    nav.append(toggle);
    if (showArchived) {
      for (const session of archived) nav.append(sessionRow(session, true));
    }
  }

  // Chats a colleague handed to you (v0.4). Listed apart from your own, because
  // they are not yours: you can read one and put it away, and nothing here
  // renames, archives or deletes somebody else's chat.
  let sharedWithMe = [];
  try {
    ({ sharedWithMe } = await api("/api/shares"));
  } catch {
    sharedWithMe = [];
  }
  if (sharedWithMe.length > 0) {
    const heading = document.createElement("div");
    heading.className = "session-group";
    heading.textContent = `shared with you (${sharedWithMe.length})`;
    nav.append(heading);
    for (const share of sharedWithMe) nav.append(sharedRow(share));
  }
}

/** One chat somebody shared with you: open it read-only, or put it away. */
function sharedRow(share) {
  const active = state.shareOf !== null && state.shareOf.id === share.id;
  const row = document.createElement("div");
  row.className = `session-row shared${active ? " active" : ""}`;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "session";
  button.setAttribute("aria-current", active ? "true" : "false");

  const title = document.createElement("span");
  title.className = "session-title";
  title.textContent = share.title;

  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = share.missing
    ? "removed by its owner"
    : `from ${share.ownerEmail} · ${share.messageCount} messages`;

  button.append(title, meta);
  if (!share.missing) button.addEventListener("click", () => void openShared(share.id));

  const actions = document.createElement("span");
  actions.className = "session-actions";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "session-action";
  remove.textContent = "remove";
  remove.title = `remove the shared chat “${share.title}” from your list`;
  remove.setAttribute("aria-label", `Remove the shared chat “${share.title}”`);
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await api(`/api/shares/${encodeURIComponent(share.id)}`, { method: "DELETE" });
    } catch (error) {
      addErrorMessage(error.message);
    }
    await loadSessions();
  });
  actions.append(remove);

  row.append(button, actions);
  return row;
}

/** One chat: open it, or rename, archive or delete it. */
function sessionRow(session, isArchived = false) {
  const row = document.createElement("div");
  row.className = `session-row${session.id === state.sessionId ? " active" : ""}${
    isArchived ? " archived" : ""
  }`;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "session";
  button.setAttribute("aria-current", session.id === state.sessionId ? "true" : "false");

  const title = document.createElement("span");
  title.className = "session-title";
  title.textContent = session.title;

  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = `${session.messageCount} messages${session.model ? ` · ${session.model}` : ""}`;

  button.append(title, meta);
  button.addEventListener("click", () => void openSession(session.id));

  const actions = document.createElement("span");
  actions.className = "session-actions";
  actions.append(
    sessionAction(isArchived ? "restore" : "archive", session, async () => {
      await patchSession(session.id, { archived: !isArchived });
    }),
    sessionAction("share", session, async () => {
      const email = window.prompt(`Share “${session.title}” read-only with which address?`);
      if (email === null || email.trim() === "") return;
      const { share, existing } = await api(
        `/api/sessions/${encodeURIComponent(session.id)}/share`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        },
      );
      addNotice(
        existing
          ? `Already shared with ${share.recipientEmail}.`
          : `Shared read-only with ${share.recipientEmail}.`,
      );
    }),
    sessionAction("rename", session, async () => {
      const next = window.prompt("Name this chat", session.title);
      if (next === null || next.trim() === "") return;
      await patchSession(session.id, { title: next.trim() });
      if (session.id === state.sessionId) $("#chat-title").textContent = next.trim();
    }),
    sessionAction("delete", session, async () => {
      const gone = await deleteSession(session.id);
      if (!gone) return;
      // Deleting the chat you are looking at has to leave the console somewhere:
      // a fresh chat, not a transcript whose record no longer exists. That path
      // redraws the list itself; the row's own reload covers the other case.
      if (session.id === state.sessionId) startNewChat();
    }),
  );

  row.append(button, actions);
  return row;
}

/**
 * One row control.
 *
 * Delete is armed in two clicks for the same reason deleting a file is: a
 * one-click destroy sitting beside "rename" is a trap, and a native `confirm()`
 * is neither testable nor usable headlessly.
 */
function sessionAction(name, session, run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `session-action${name === "delete" ? " danger" : ""}`;
  button.textContent = name;
  button.title = `${name} “${session.title}”`;
  button.setAttribute("aria-label", `${name} the chat “${session.title}”`);

  if (name !== "delete") {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await run();
      } catch (error) {
        addErrorMessage(error.message);
      }
      await loadSessions();
    });
    return button;
  }

  let timer = null;
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    button.textContent = "delete";
    button.classList.remove("armed");
  };
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (timer === null) {
      button.textContent = "sure?";
      button.classList.add("armed");
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    try {
      await run();
    } catch (error) {
      addErrorMessage(error.message);
    }
    await loadSessions();
  });
  return button;
}

/** Save one edit to a chat — its name, or whether it is put away. */
async function patchSession(id, body) {
  await api(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteSession(id) {
  const result = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  return result?.removed === true;
}

/** A fresh chat, and the callers that need one (the button, and a delete). */
function startNewChat() {
  if (state.streaming) return;
  state.sessionId = null;
  setSharedView(null);
  state.toolCards.clear();
  state.approvals.clear();
  resetPreview();
  $("#chat-title").textContent = "New chat";
  seedFallbacks();
  setUseOffline(true);
  setGatewayBadge("primary");
  $("#messages").innerHTML =
    '<div class="empty" id="empty"><h2>What are we building?</h2><p class="muted">This agent reads, edits and runs code inside the workspace. Model access is routed through your OmniRoute gateway.</p></div>';
  void loadSessions();
  $("#input").focus();
}

/** Apply a session's saved model and step budget to the toolbar. */
function applySessionSettings(session) {
  if (typeof session.model === "string" && session.model !== "") {
    state.model = session.model;
    $("#model").value = session.model;
    // The model may not be in the picker (e.g. the session predates it).
    if ($("#model").value !== session.model) {
      const option = document.createElement("option");
      option.value = session.model;
      option.textContent = session.model;
      $("#model").append(option);
      $("#model").value = session.model;
    }
  }
  // A chat that never saved a chain inherits whatever the server would use.
  if (session.fallbackModels !== undefined) setFallbacks(session.fallbackModels);
  else seedFallbacks();
  setUseOffline(session.useOffline !== false);
  if (typeof session.maxSteps === "number") $("#steps").value = String(session.maxSteps);
}

async function persistSettings() {
  if (state.sessionId === null) return;
  // Nothing to save: the server ignores a model for an automatic account, so a
  // write here would be a setting that is stored and never read.
  if (state.modelSelection === "auto") return;
  const fallbacks = currentFallbacks();
  try {
    await api(`/api/sessions/${encodeURIComponent(state.sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: currentModel(),
        ...(fallbacks === undefined ? {} : { fallbackModels: fallbacks }),
        useOffline: currentUseOffline(),
        maxSteps: currentSteps(),
      }),
    });
  } catch {
    /* the setting is also sent with the next message, so this is best effort */
  }
}

async function openSession(id) {
  if (state.streaming) return;
  let session;
  try {
    ({ session } = await api(`/api/sessions/${encodeURIComponent(id)}`));
  } catch (error) {
    addErrorMessage(error.message);
    return;
  }

  state.sessionId = session.id;
  setSharedView(null);
  $("#chat-title").textContent = session.title;
  renderTranscript(session);

  applySessionSettings(session);
  scrollToBottom(true);
  await loadSessions();
}

/**
 * Open a chat somebody shared with you, read-only (v0.4).
 *
 * The transcript is drawn exactly as the owner's own console draws it — the
 * record is the same record — and the only difference is stated where it can be
 * seen: the composer is off and the top bar says whose chat this is. There is no
 * "continue as them": the model route resolves sessions against your own store,
 * so the id is not there and a turn against it is refused, which is why turning
 * the composer off is honesty rather than the control.
 */
async function openShared(shareId) {
  if (state.streaming) return;
  let payload;
  try {
    payload = await api(`/api/shares/${encodeURIComponent(shareId)}`);
  } catch (error) {
    addErrorMessage(error.message);
    return;
  }

  // Deliberately not `state.sessionId`: that id belongs to somebody else's
  // store, and every route that reads it would 404. A shared view has no
  // session of your own, which is the whole point.
  state.sessionId = null;
  setSharedView(payload.share);
  $("#chat-title").textContent = `${payload.share.ownerEmail} — shared with you`;
  renderTranscript(payload.session);
  scrollToBottom(true);
  await loadSessions();
}

/**
 * Whether the console is showing somebody else's chat, and the composer's state.
 * `null` is your own chat (or a fresh one), where the composer is live again.
 */
function setSharedView(share) {
  state.shareOf = share;
  const badge = $("#share-badge");
  const readOnly = share !== null;
  badge.classList.toggle("hidden", !readOnly);
  badge.textContent = readOnly ? `read-only — shared by ${share.ownerEmail}` : "";
  $("#input").disabled = readOnly;
  $("#send").disabled = readOnly;
  $("#input").placeholder = readOnly
    ? "This chat was shared with you read-only."
    : "Describe a change, ask a question, or paste an error...";
}

/**
 * Draw a transcript into the message pane.
 *
 * Shared between a chat you can continue and one that was handed to you, because
 * the record is the same record; what differs is only whether the composer is
 * live, which `setSharedView` owns.
 */
function renderTranscript(session) {
  state.toolCards.clear();
  state.approvals.clear();
  resetPreview();
  const box = $("#messages");
  box.replaceChildren();

  // Pair tool calls with their results before rendering.
  const results = new Map();
  /** The newest call that wrote a file, for the preview pane to show. */
  let lastWrite = null;
  for (const message of session.messages) {
    if (message.role === "tool" && message.tool_call_id) results.set(message.tool_call_id, message);
  }

  for (const message of session.messages) {
    if (message.role === "user") {
      addUserMessage(message.content ?? "");
    } else if (message.role === "assistant") {
      if (message.content && message.content.trim() !== "") {
        const node = addAssistantMessage();
        node.innerHTML = renderMarkdown(message.content);
        node.classList.remove("cursor");
      }
      for (const call of message.tool_calls ?? []) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = call.function.arguments;
        }
        const result = results.get(call.id);
        const ok = result ? !/^(Exit code: [1-9]|Refused)/.test(result.content ?? "") : true;
        addToolCard(call.id, call.function.name, args, result?.diff);
        finishToolCard(
          call.id,
          call.function.name,
          ok,
          result ? result.content : "(no result recorded)",
          result?.diff,
        );
        // A write that failed is not what the pane should be holding up.
        if (ok && WRITER_TOOLS.has(call.function.name)) {
          lastWrite = { name: call.function.name, args, diff: result?.diff ?? null };
        }
      }
    }
  }

  if (box.childElementCount === 0) {
    box.innerHTML =
      '<div class="empty" id="empty"><h2>What are we building?</h2><p class="muted">This agent reads, edits and runs code inside the workspace. Model access is routed through your OmniRoute gateway.</p></div>';
  }

  if (lastWrite === null) resetPreview();
  else showRestoredFile(lastWrite);
}

/* ---------------------------------------------------------------- workspace */

async function loadFiles(path = state.filePath) {
  let payload;
  try {
    payload = await api(`/api/files?path=${encodeURIComponent(path)}`);
  } catch (error) {
    $("#files-list").textContent = error.message;
    return;
  }

  state.filePath = payload.path;
  $("#files-path").textContent = payload.path;

  const list = $("#files-list");
  list.replaceChildren();

  if (payload.path !== ".") {
    const up = document.createElement("button");
    up.className = "file-entry";
    const parent = payload.path.split("/").slice(0, -1).join("/") || ".";
    up.innerHTML = '<span class="glyph" aria-hidden="true">↑</span> ..';
    up.setAttribute("aria-label", "Go up one directory");
    up.addEventListener("click", () => void loadFiles(parent));
    list.append(up);
  }

  for (const entry of payload.entries) {
    const button = document.createElement("button");
    button.className = entry.changed ? "file-entry changed" : "file-entry";

    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = entry.type === "dir" ? "▸" : "·";

    const name = document.createElement("span");
    name.textContent = entry.name;
    button.append(glyph, name);

    // A dot marks anything the agent has written, so the tree points at the change.
    if (entry.changed) {
      const mark = document.createElement("span");
      mark.className = "changed-mark";
      mark.setAttribute("aria-hidden", "true");
      button.append(mark);
      button.title = "Changed by the agent";
      button.setAttribute("aria-label", `${entry.name}, changed by the agent`);
    }

    if (entry.type === "file") {
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = formatBytes(entry.size);
      button.append(size);
    }

    button.addEventListener("click", () =>
      entry.type === "dir" ? void loadFiles(entry.path) : void openFile(entry.path),
    );
    list.append(button);
  }

  if (payload.entries.length === 0) {
    list.textContent = "empty directory";
  }
}

/**
 * Which directory the agent works in, and how to change it.
 *
 * `dirs` is every directory inside the sandbox, never the host: picking one moves
 * the agent's working directory without moving the fence around it. Values are
 * sandbox-relative (`.` is the sandbox itself), which is what the picker offers
 * and what `POST /api/workspace` takes back.
 */
async function loadWorkspace() {
  let info;
  try {
    info = await api("/api/workspace");
  } catch {
    return;
  }

  const pick = $("#workspace-pick");
  pick.replaceChildren();
  for (const dir of info.dirs ?? []) {
    const option = document.createElement("option");
    option.value = dir;
    option.textContent = dir === "." ? "(the sandbox root)" : dir;
    pick.append(option);
  }
  pick.value = info.rel === "" ? "." : info.rel;

  const note = $("#workspace-note");
  note.textContent = info.cwd;
  note.title = `The agent reads and writes here. Nothing outside ${info.base} is reachable.`;
}

/** Make a directory the agent's working directory. */
async function chooseWorkspace(path) {
  try {
    const payload = await api("/api/workspace", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    $("#workspace-note").textContent = payload.cwd;
  } catch (error) {
    $("#workspace-note").textContent = error.message;
    return;
  }
  // A different root is a different tree, so start it at the top rather than
  // leaving the list on a path that only existed in the old one.
  await loadFiles(".");
  await loadWorkspace();
  // And a different preview: the running app belongs to a workspace, so the pane
  // must not keep showing the old one's frame under the new one's name.
  unloadPreviewFrame();
  await refreshPreviewApp();
}

/** Create a folder in the working directory, then offer it as the working directory. */
async function newWorkspaceFolder() {
  const name = window.prompt("New folder name", "project");
  if (name === null) return;
  try {
    await api("/api/workspace/mkdir", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
  } catch (error) {
    $("#workspace-note").textContent = error.message;
    return;
  }
  await loadFiles(state.filePath);
  await loadWorkspace();
}

/**
 * This chat's own controls: the fallback chain, the local fallback and the step
 * budget.
 *
 * They live in a dialog rather than the top bar because they are decisions you
 * make once per chat — three more controls beside the model made the bar read as
 * settings rather than as where you are.
 */
function toggleSettings(force) {
  const dialog = $("#settings");
  const open = force === undefined ? dialog.classList.contains("hidden") : force;
  dialog.classList.toggle("hidden", !open);
  $("#chat-settings").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    $("#settings-note").textContent =
      state.sessionId === null ? "Saved on the chat once it starts." : "Saved on this chat.";
  }
}

/* --------------------------------------------------------- deleting a file */

/*
 * Deleting from the viewer, in two clicks.
 *
 * A native confirm() is the obvious way and the wrong one: it blocks the page
 * and nobody can answer it in a headless browser. A one-click delete sitting
 * next to "close" is a trap. So the first click arms the button and a second one
 * within a few seconds removes the file.
 */
let deleteArmed = null;

function disarmDelete() {
  if (deleteArmed === null) return;
  clearTimeout(deleteArmed.timer);
  deleteArmed = null;
  const button = $("#viewer-delete");
  button.textContent = "delete";
  button.classList.remove("armed");
}

function armDelete() {
  const path = state.viewer.path;
  if (path === null) return;

  if (deleteArmed !== null && deleteArmed.path === path) {
    disarmDelete();
    void deleteFile(path);
    return;
  }

  disarmDelete();
  const button = $("#viewer-delete");
  button.textContent = "confirm delete";
  button.classList.add("armed");
  button.setAttribute("aria-label", `Confirm deleting ${path}`);
  deleteArmed = { path, timer: setTimeout(disarmDelete, 6000) };
}

async function deleteFile(path) {
  try {
    await api(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  } catch (error) {
    addErrorMessage(error.message);
    return;
  }

  closeViewer();
  // The pane would otherwise be holding a file that no longer exists.
  if (state.preview.path === path) resetPreview();
  await loadFiles(state.filePath);
  addNotice(`${path} deleted from the workspace`);
}

function closeViewer() {
  const viewer = $("#viewer");
  if (viewer.classList.contains("hidden")) return;
  disarmDelete();
  viewer.classList.add("hidden");
  state.viewer = { path: null, mode: "file", diff: null };
  if (state.lastFocus && typeof state.lastFocus.focus === "function") state.lastFocus.focus();
  state.lastFocus = null;
}

/** Switch the viewer between the agent's change and the file as it stands. */
async function setViewerMode(mode) {
  const diffBox = $("#viewer-diff");
  const body = $("#viewer-body");
  const toggle = $("#viewer-toggle");

  if (mode === "diff") {
    if (state.viewer.diff === null) {
      try {
        const payload = await api(`/api/file/diff?path=${encodeURIComponent(state.viewer.path)}`);
        state.viewer.diff = payload.diff ?? false;
      } catch (error) {
        state.viewer.diff = false;
        addErrorMessage(error.message);
      }

      diffBox.replaceChildren();
      if (state.viewer.diff) {
        const rendered = renderDiff(state.viewer.diff);
        rendered.classList.add("diff-inline");
        diffBox.append(rendered);
      } else {
        const note = document.createElement("p");
        note.className = "muted viewer-note";
        note.textContent = "The agent has not changed this file.";
        diffBox.append(note);
      }
    }
    diffBox.classList.remove("hidden");
    body.classList.add("hidden");
  } else {
    diffBox.classList.add("hidden");
    body.classList.remove("hidden");
  }

  state.viewer.mode = mode;
  toggle.textContent = mode === "diff" ? "show file" : "show diff";
  toggle.setAttribute("aria-pressed", mode === "diff" ? "true" : "false");
}

async function openFile(path) {
  try {
    const payload = await api(`/api/file?path=${encodeURIComponent(path)}`);
    $("#viewer-title").textContent = `${payload.path}${payload.truncated ? " (truncated)" : ""}`;
    // The same colouring as the preview pane: the file you opened to read and the
    // file being written should not look like two different applications.
    const body = $("#viewer-body");
    const html = highlightCode(payload.content, languageOf(payload.path));
    if (html === null) body.textContent = payload.content;
    else body.innerHTML = html;

    state.viewer = { path, mode: "file", diff: null };
    // A file is open, so it can be deleted - but never by the click that opened it.
    disarmDelete();
    $("#viewer-delete").classList.remove("hidden");
    $("#viewer-toggle").classList.toggle("hidden", !payload.hasHistory);
    // For a file the agent has touched, the change is what you came to see.
    await setViewerMode(payload.hasHistory ? "diff" : "file");

    state.lastFocus = document.activeElement;
    $("#viewer").classList.remove("hidden");
    $("#viewer-close").focus();
  } catch (error) {
    addErrorMessage(error.message);
  }
}

/* ------------------------------------------------------------------- status */

async function loadHealth() {
  try {
    const health = await api("/api/health");
    $("#gateway-dot").className = `status-dot ${health.ok ? "ok" : "bad"}`;
    $("#gateway-label").textContent = health.ok
      ? `${health.modelCount} models via gateway`
      : "gateway unreachable";
    $("#workspace-label").textContent = health.workspace;

    if (health.sandbox) {
      // Green only when commands really are isolated in a container.
      const level = health.sandbox.backend === "docker" ? "ok" : "warn";
      $("#sandbox-dot").className = `status-dot ${level}`;
      $("#sandbox-label").textContent =
        health.sandbox.backend === "docker" ? "sandboxed commands" : "commands run on host";
      $("#sandbox-label").title = health.sandbox.detail;
    }

    if (health.approval) {
      const badge = $("#approval-badge");
      const mode = health.approval.mode ?? "off";
      badge.classList.toggle("hidden", mode === "off");
      badge.textContent = `approval: ${mode}`;
      badge.title =
        mode === "all"
          ? "Every file change and command asks for a click first"
          : `Every command, and writes over ${health.approval.maxLines} lines, ask for a click first`;
    }

    if (Array.isArray(health.fallbackModels)) {
      state.fallbackDefault = health.fallbackModels;
      // Only seed a chat that has not already chosen a chain of its own.
      if (state.sessionId === null) setFallbacks(state.fallbackDefault);
    }

    /*
     * Who chooses the model. `auto` is an account without a paid plan (or a
     * deployment with AGENT_FORCE_AUTO_MODEL): the picker and the chain box are
     * hidden rather than disabled, because a greyed-out control still invites the
     * question "how do I unlock this?" and this one cannot be unlocked from here.
     */
    if (health.modelSelection === "auto" || health.modelSelection === "manual") {
      state.modelSelection = health.modelSelection;
    }
    if (Array.isArray(health.autoModels)) state.autoModels = health.autoModels;
    const auto = state.modelSelection === "auto";
    $("#model-field").classList.toggle("hidden", auto);
    $("#chat-settings").classList.toggle("hidden", auto);
    if (auto) toggleSettings(false);
    setAutoBadge(state.autoModels);

    renderModelHealth(health.modelHealth);

    // Its own request: usage is read from the plane, and the status poll should
    // not wait on it or fail with it.
    try {
      renderAccountUsage(await api("/api/account/usage"));
    } catch {
      renderAccountUsage(null);
    }

    if (health.offline) {
      const models = Array.isArray(health.offline.models) ? health.offline.models : [];
      $("#offline-dot").className = "status-dot ok";
      $("#offline-label").textContent = `offline: ${models.join(", ") || health.offline.url}`;
      $("#offline-label").title = `${health.offline.url} — tried only after every main model fails, and needs no network.`;
      $("#use-offline").disabled = false;
      $("#use-offline").title =
        "Let this chat fall back to the local model when every main model fails. Uncheck for work where a small local model's answer would be worse than an error.";
    } else {
      $("#offline-dot").className = "status-dot";
      $("#offline-label").textContent = "no offline fallback";
      $("#offline-label").title =
        "Set AGENT_OFFLINE_URL to a local model server (for example Ollama) so the agent keeps working without a network.";
      $("#use-offline").disabled = true;
      $("#use-offline").title = "No offline gateway is configured, so there is nothing to fall back to.";
    }

    if (health.limits) {
      state.limits = health.limits;
      $("#steps").min = String(health.limits.minSteps);
      $("#steps").max = String(health.limits.maxSteps);
      if ($("#steps").dataset.touched !== "true") {
        $("#steps").value = String(health.limits.defaultSteps);
      }
    }
  } catch (error) {
    $("#gateway-dot").className = "status-dot bad";
    $("#gateway-label").textContent = error.message;
  }
}

/**
 * Ids to offer when the catalog cannot be read at all. Deliberately short and
 * generic: guessing specific model names here would just invent a menu, and
 * "auto/offline" in particular would be confused with the real offline gateway.
 */
function defaults() {
  return ["auto", "auto/coding", "auto/best-coding"];
}

/** Surface the ordered fallback list so it is clear what else will be tried. */
function showModelChain(models) {
  if (!Array.isArray(models) || models.length === 0) return;
  state.chainModels = models;
  const select = $("#model");
  select.title =
    models.length > 1
      ? `Tried in order if one rate-limits:\n${models.join("\n")}`
      : `${models[0]} (no fallbacks configured)`;
}

/**
 * Routes we would rather use, best first. `auto/best-coding` is the gateway's
 * own "best" combo; the rest are progressively more general fallbacks every
 * OmniRoute deployment offers. A route only leads if the catalog actually
 * carries it, so this never puts a model the gateway cannot serve in front.
 */
const PREFERRED_MODELS = ["auto/best-coding", "auto/best", "auto/best-free", "auto"];

/** The best route the catalog offers, else the deployment's own default. */
function pickBestModel(available, serverDefault) {
  for (const id of PREFERRED_MODELS) {
    if (available.includes(id)) return id;
  }
  if (typeof serverDefault === "string" && available.includes(serverDefault)) return serverDefault;
  return available[0] ?? serverDefault;
}

async function loadModels() {
  const select = $("#model");
  let models = defaults();
  let current = "auto/coding";
  try {
    const payload = await api("/api/models");
    const available = Array.isArray(payload.models)
      ? payload.models.filter((id) => typeof id === "string" && id !== "")
      : [];
    if (available.length > 0) {
      // Offer exactly what the gateway serves: a model disabled upstream drops
      // out of the catalog, and the old code re-injected the deployment's
      // default even when the catalog no longer carried it, so a disabled
      // model stayed in the list. Lead with the best available route and keep
      // every other one selectable.
      current = pickBestModel(available, payload.model);
      models = [current, ...available.filter((id) => id !== current)];
    } else if (typeof payload.model === "string" && payload.model !== "") {
      current = payload.model;
    }
  } catch {
    /* keep the defaults */
  }

  state.model = current;
  select.replaceChildren();
  for (const id of models) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    select.append(option);
  }
  select.value = current;
  // The sweep may have answered before the picker was filled.
  annotateModels();
}

/* --------------------------------------------------------------- composer */

function autoGrow() {
  const input = $("#input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function toggleFilesPanel(force) {
  const panel = $("#files-panel");
  const open = force === undefined ? !panel.classList.contains("open") : force;
  panel.classList.toggle("open", open);
  $("#toggle-files").setAttribute("aria-expanded", open ? "true" : "false");
}

function wire() {
  $("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage($("#input").value);
  });

  $("#input").addEventListener("input", autoGrow);
  $("#input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage($("#input").value);
    }
  });

  $("#stop").addEventListener("click", () => state.controller?.abort());

  $("#new-chat").addEventListener("click", () => startNewChat());

  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer-delete").addEventListener("click", () => armDelete());

  $("#sweep-open").addEventListener("click", openSweep);

  $("#sweep-close").addEventListener("click", closeSweep);
  $("#sweep-run").addEventListener("click", () => void runSweep(false));
  $("#sweep-run-all").addEventListener("click", () => void runSweep(true));

  // Clicking the backdrop closes it; clicking inside does not.
  $("#sweep").addEventListener("click", (event) => {
    if (event.target === $("#sweep")) closeSweep();
  });

  $("#viewer-toggle").addEventListener("click", () => {
    void setViewerMode(state.viewer.mode === "diff" ? "file" : "diff");
  });

  // Clicking the backdrop closes the viewer; clicking inside it does not.
  $("#viewer").addEventListener("click", (event) => {
    if (event.target === $("#viewer")) closeViewer();
  });

  /*
   * The toolbar button opens the app, not the code.
   *
   * "Preview" means the built thing to anybody who did not write it, and a pane
   * that answers with the source of a file is answering a different question. The
   * code is one click further in.
   */
  $("#toggle-preview").addEventListener("click", () => {
    const opening = !previewIsOpen();
    togglePreview();
    if (opening) void showPreviewApp();
    else unwatchPreviewChanges();
  });
  $("#preview-close").addEventListener("click", () => {
    togglePreview(false);
    unwatchPreviewChanges();
  });
  $("#preview-run").addEventListener("click", () => {
    if (state.preview.mode === "app") {
      setPreviewMode("code");
      return;
    }
    void showPreviewApp();
  });
  $("#preview-toggle").addEventListener("click", () =>
    setPreviewMode(state.preview.mode === "change" ? "code" : "change"),
  );
  $("#preview-open").addEventListener("click", () => {
    if (state.preview.path !== null) void openFile(state.preview.path);
  });

  $("#preview-app-start").addEventListener("click", () => void startPreviewApp());
  $("#preview-app-stop").addEventListener("click", () => void stopPreviewApp());
  $("#preview-app-reload").addEventListener("click", () => {
    if (previewAppRunning()) loadPreviewFrame();
    else void refreshPreviewApp();
  });
  $("#preview-app-log-toggle").addEventListener("click", () => {
    const log = $("#preview-app-log");
    const open = log.classList.toggle("hidden");
    $("#preview-app-log-toggle").setAttribute("aria-expanded", open ? "false" : "true");
  });

  // Following the end of a growing file is the default; scrolling up stops it, so
  // reading an earlier part of a long file is not yanked away mid-sentence.
  const previewScroll = $("#preview-body");
  previewScroll.addEventListener("scroll", () => {
    state.preview.follow =
      previewScroll.scrollHeight - previewScroll.scrollTop - previewScroll.clientHeight < 40;
  });

  $("#files-root").addEventListener("click", () => void loadFiles("."));

  $("#toggle-files").addEventListener("click", () => toggleFilesPanel());
  $("#files-close").addEventListener("click", () => toggleFilesPanel(false));
  $("#files-new").addEventListener("click", () => void newWorkspaceFolder());
  $("#workspace-pick").addEventListener("change", (event) => void chooseWorkspace(event.target.value));

  $("#chat-settings").addEventListener("click", () => toggleSettings());
  $("#settings-close").addEventListener("click", () => toggleSettings(false));
  $("#settings").addEventListener("click", (event) => {
    if (event.target === $("#settings")) toggleSettings(false);
  });

  $("#model").addEventListener("change", (event) => {
    state.model = event.target.value;
    void persistSettings();
  });

  $("#steps").addEventListener("change", () => {
    $("#steps").dataset.touched = "true";
    void persistSettings();
  });

  // Editing the box is what makes an empty value meaningful, so mark it on input
  // (which fires before blur) and save on change.
  $("#fallbacks").addEventListener("input", () => {
    $("#fallbacks").dataset.known = "true";
  });
  $("#fallbacks").addEventListener("change", () => void persistSettings());

  $("#use-offline").addEventListener("change", () => void persistSettings());

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#sweep").classList.contains("hidden")) closeSweep();
    else if (!$("#settings").classList.contains("hidden")) toggleSettings(false);
    else closeViewer();
  });
}

wire();
autoGrow();
// Restore the pane's own state before any turn can change it: open if it was open,
// and quiet if it was closed on purpose.
if (storedPreviewOpen() === "1") {
  togglePreview(true);
  // Reopened, not started: reloading the console is not a request to run the app.
  void showPreviewApp(false);
} else if (storedPreviewOpen() === "0") state.preview.dismissed = true;
// Before anything is fetched: if this deployment signs people in, go there.
void signInIfRequired();
void loadModels();
// Which models the last sweep found usable, for the picker and the panel.
void refreshSweep();
void loadHealth();
void loadSessions();
void loadWorkspace();
void loadFiles(".");
$("#input").focus();

// The server checks the chain on its own timer, so re-read the status to show it.
// Skipped mid-turn: the row is about the chain, not about the reply in flight.
setInterval(() => {
  if (!state.streaming) void loadHealth();
}, 60_000);
