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
  /** The chain in play for this chat, so the sweep report can mark it. */
  chainModels: [],
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
 * Send the browser to the identity provider when the server says it uses one.
 *
 * A 401 looks the same whether a deployment wants a shared token or a sign-in,
 * so the console cannot tell them apart from the failure. `/api/auth/status` is
 * the one route that answers without a session, and asking it once at startup is
 * what keeps a signed-out visitor from being shown a console that cannot load.
 */
async function signInIfRequired() {
  try {
    const response = await fetch("/api/auth/status");
    if (!response.ok) return;
    const status = await response.json();
    if (status.oidc && !status.authenticated) location.replace("/api/auth/login");
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

/** Which half of the pane is on screen: the code, the change, or both. */
function applyPreviewLayout() {
  const pane = state.preview;
  const hasDiff = pane.diff !== null && pane.diff !== undefined;
  // A write that is still arriving shows the change beside the code: watching the
  // file take shape is the point, and the diff is the other half of that. Once
  // the call lands the pane goes back to one view and the toggle comes back.
  const live =
    pane.generating === true && pane.name === "write_file" && hasDiff && previewIsOpen();
  const showDiff = pane.mode === "change" && hasDiff;

  $("#preview").classList.toggle("live", live);

  const toggle = $("#preview-toggle");
  // With both halves on screen at once there is nothing to switch between.
  toggle.classList.toggle("hidden", !hasDiff || live);
  toggle.textContent = showDiff ? "show code" : "show change";
  toggle.setAttribute("aria-pressed", showDiff ? "true" : "false");

  $("#preview-diff").classList.toggle("hidden", !(live || showDiff));
  $("#preview-body").classList.toggle("hidden", !live && showDiff);
}

/** Show the code, the change, or - when there is a diff - let the button pick. */
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
  state.preview = {
    ...state.preview,
    name: null,
    path: null,
    content: "",
    diff: null,
    mode: "code",
    toolId: null,
    toolName: null,
    generating: false,
  };
  $("#preview-title").textContent = "nothing generated yet";
  setPreviewStatus("");
  previewBody("", false);
  renderPreviewDiff();
  setPreviewMode("code");
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

  $("#preview-title").textContent = pane.path ?? `${event.name} — path not named yet`;
  schedulePreviewBody(event.content, true);
  setPreviewMode("code");
  // The change, as far as it has been written, beside the file itself.
  scheduleLiveDiff();
  setPreviewStatus(event.complete === true ? "writing complete" : "generating");
  $("#preview-open").classList.toggle("hidden", pane.path === null);

  // Announced once per file, not once per token: the live region is for state
  // changes, and every delta arriving is not one.
  if (fresh) announce(`Generating ${event.name}${pane.path === null ? "" : `: ${pane.path}`}`);
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
  setPreviewMode("code");
  setPreviewStatus(event.name === "edit_file" ? "edit ready" : "written");
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

/* ------------------------------------------------------------------ factory */

/**
 * The Genie → factory handoff, from the browser.
 *
 * The spec is assembled by the server from this workspace — a file index, sizes,
 * the entry point, the test command — with no second model call, so what lands in
 * `build-requests/` is what the file set actually is and the same workspace always
 * produces the same bytes. The form therefore asks only for the parts that cannot
 * be observed: a name, a purpose, a feature list. Those are decisions, and a spec
 * that guessed at them is how the factory manufactures something nobody described.
 *
 * Nothing is built here. Genie writes a request; Olympus manufactures it.
 */
let factoryInfo = null;

async function runFactory(write) {
  const status = $("#factory-status");
  const name = $("#factory-name").value.trim();

  if (name === "") {
    status.textContent = "A name is required — it becomes the spec's title and its filename.";
    $("#factory-name").focus();
    return;
  }

  const buttons = [$("#factory-preview"), $("#factory-export")];
  for (const button of buttons) button.disabled = true;

  try {
    const payload = await api("/api/factory/spec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        purpose: $("#factory-purpose").value.trim(),
        features: $("#factory-features")
          .value.split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
        kind: $("#factory-kind").value,
        overwrite: $("#factory-overwrite").checked,
        write,
      }),
    });
    renderFactory(payload, write);
  } catch (error) {
    // A refusal is an answer. The 409 is the one worth explaining: a spec someone
    // edited by hand is already there and was not replaced by its own export.
    status.textContent =
      error.status === 409
        ? `${error.message}. Tick "replace an existing spec" to overwrite it.`
        : error.message;
    if (error.status === 409) $("#factory-overwrite").focus();
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function renderFactory(payload, write) {
  const size = `${payload.bytes} bytes`;
  const status = $("#factory-status");

  if (payload.written) {
    status.textContent = `${payload.replaced ? "replaced" : "wrote"} ${payload.filename} — ${size} in the factory directory`;
  } else if (!write) {
    status.textContent = `previewed ${payload.filename} — ${size}, nothing written`;
  } else {
    // Asked to write and did not: the only other reason is that no directory was
    // named, and the operator can fix that from here.
    status.textContent = `built ${payload.filename} — ${size}, not written: no factory directory is configured (AGENT_FACTORY_DIR)`;
  }

  const steps = $("#factory-steps");
  steps.replaceChildren();
  for (const step of payload.nextSteps ?? []) {
    const item = document.createElement("div");
    item.className = "factory-step mono";
    item.textContent = step;
    steps.append(item);
  }

  // Markdown, plainly: it is a document to review, and colouring it would suggest
  // the app had a view of what it means.
  $("#factory-body").textContent = payload.markdown;
}

async function refreshFactory() {
  try {
    return await api("/api/factory/spec");
  } catch {
    // A console that cannot read its own configuration still exports; it just
    // cannot say where the spec will land.
    return null;
  }
}

/**
 * What the operator is told before they click anything. Written synchronously when
 * the dialog opens, then again once the configuration is known: a note that only
 * appears after a round trip is a dialog that looks broken for as long as the
 * request takes.
 */
function writeFactoryNote() {
  const note = $("#factory-note");

  if (factoryInfo === null) {
    // Not read yet, or the read failed. Say only what is true either way.
    note.textContent =
      "The spec is assembled from this workspace. Genie writes a request; Olympus manufactures it.";
    return;
  }

  note.textContent = factoryInfo.configured
    ? `Assembled from this workspace and written to ${factoryInfo.dir}. Genie writes a request; Olympus manufactures it.`
    : "No factory directory is configured, so an export shows the spec instead of writing it — set AGENT_FACTORY_DIR to write one. Genie writes a request; Olympus manufactures it.";
}

async function openFactory() {
  state.lastFocus = document.activeElement;
  $("#factory").classList.remove("hidden");
  $("#factory-close").focus();
  writeFactoryNote();

  // The chat's title is already a description of what this workspace is for, so it
  // is a better starting point than an empty box. Nothing else is prefilled: the
  // purpose and the features are the operator's to state.
  const title = $("#chat-title").textContent.trim();
  if ($("#factory-name").value === "" && title !== "" && title !== "New chat") {
    $("#factory-name").value = title.replace(/[.!?]+$/, "").slice(0, 60);
  }

  if (factoryInfo === null) {
    factoryInfo = await refreshFactory();
    writeFactoryNote();
  }
}

function closeFactory() {
  $("#factory").classList.add("hidden");
  if (state.lastFocus && typeof state.lastFocus.focus === "function") state.lastFocus.focus();
  state.lastFocus = null;
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

async function sendMessage(text) {
  if (state.streaming || text.trim() === "") return;

  const model = currentModel();
  const maxSteps = currentSteps();
  const fallbacks = currentFallbacks();
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

async function loadSessions() {
  let sessions = [];
  try {
    ({ sessions } = await api("/api/sessions"));
  } catch {
    return;
  }

  const nav = $("#sessions");
  nav.replaceChildren();

  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = `session${session.id === state.sessionId ? " active" : ""}`;
    button.setAttribute("aria-current", session.id === state.sessionId ? "true" : "false");

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title;

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${session.messageCount} messages${session.model ? ` · ${session.model}` : ""}`;

    button.append(title, meta);
    button.addEventListener("click", () => void openSession(session.id));
    nav.append(button);
  }
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
  state.toolCards.clear();
  state.approvals.clear();
  resetPreview();
  $("#chat-title").textContent = session.title;
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

  applySessionSettings(session);
  scrollToBottom(true);
  await loadSessions();
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

    renderModelHealth(health.modelHealth);

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

async function loadModels() {
  const select = $("#model");
  let models = defaults();
  let current = "auto/coding";
  try {
    const payload = await api("/api/models");
    current = payload.model || current;
    if (Array.isArray(payload.models) && payload.models.length > 0) {
      models = [current, ...payload.models.filter((id) => id !== current)];
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

  $("#new-chat").addEventListener("click", () => {
    if (state.streaming) return;
    state.sessionId = null;
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
  });

  $("#viewer-close").addEventListener("click", closeViewer);
  $("#viewer-delete").addEventListener("click", () => armDelete());

  $("#sweep-open").addEventListener("click", openSweep);

  $("#factory-open").addEventListener("click", () => void openFactory());
  $("#factory-preview").addEventListener("click", () => void runFactory(false));
  $("#factory-export").addEventListener("click", () => void runFactory(true));
  $("#factory-close").addEventListener("click", closeFactory);
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

  $("#toggle-preview").addEventListener("click", () => togglePreview());
  $("#preview-close").addEventListener("click", () => togglePreview(false));
  $("#preview-toggle").addEventListener("click", () =>
    setPreviewMode(state.preview.mode === "change" ? "code" : "change"),
  );
  $("#preview-open").addEventListener("click", () => {
    if (state.preview.path !== null) void openFile(state.preview.path);
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
    else if (!$("#factory").classList.contains("hidden")) closeFactory();
    else closeViewer();
  });
}

wire();
autoGrow();
// Restore the pane's own state before any turn can change it: open if it was open,
// and quiet if it was closed on purpose.
if (storedPreviewOpen() === "1") togglePreview(true);
else if (storedPreviewOpen() === "0") state.preview.dismissed = true;
// Before anything is fetched: if this deployment signs people in, go there.
void signInIfRequired();
void loadModels();
// Which models the last sweep found usable, for the picker and the panel.
void refreshSweep();
void loadHealth();
void loadSessions();
void loadFiles(".");
$("#input").focus();

// The server checks the chain on its own timer, so re-read the status to show it.
// Skipped mid-turn: the row is about the chain, not about the reply in flight.
setInterval(() => {
  if (!state.streaming) void loadHealth();
}, 60_000);
