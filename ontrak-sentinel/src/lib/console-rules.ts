/**
 * Console rules (S0/S1): the pages, as strings.
 *
 * Sentinel spent S0 and most of S1 as a set of endpoints — discovery, authorize,
 * token, SAML metadata — which is exactly what an *integrator* needs and exactly
 * nothing a person can use. The second factor made that concrete: the product could
 * enforce MFA and had no way for anybody to enroll one, so `mfaEnrolled` could only
 * be set by an administrator acting on somebody else, or by a script. This module is
 * the console's shell: a handful of server-rendered pages with no framework and no
 * client state beyond the session cookie.
 *
 * Three choices worth stating out loud:
 *
 *  - **Server-rendered HTML, as a pure function.** The same trick the HTTP routers
 *    use: the page is a string built from data, so what it says is tested without a
 *    browser and there is no second copy of a rule in a template.
 *  - **Every interpolation is escaped, and there is one function that does it.**
 *    An identity's display name, a factor's label and a refusal's message all reach
 *    these pages, and all three can contain `<`. A console is the one place in an
 *    IdP where somebody else's text is rendered, so `escapeHtml` is applied by the
 *    builders rather than remembered by each page.
 *  - **The one script is the WebAuthn ceremony, and it is inline.** Creating a
 *    credential is not expressible as a form post — the browser has to call
 *    `navigator.credentials.create` — so this is the only JavaScript in the
 *    product, it runs on one page, and it does nothing but hand the browser's
 *    answer back. Everything it can reach is a handler this module names.
 */

import { mfaKindLabel, type MfaFactorSummary } from "./mfa-rules";

/* -------------------------------------------------------------------------- */
/*  Paths                                                                     */
/* -------------------------------------------------------------------------- */

/** Where the console lives. Named here so the router and the pages agree. */
export const CONSOLE_PATHS = {
  home: "/console",
  provisioning: "/console/provisioning",
  mintToken: "/console/provisioning/token",
  revokeToken: "/console/provisioning/token/revoke",
  mfa: "/console/mfa",
  totpBegin: "/console/mfa/totp",
  totpConfirm: "/console/mfa/totp/confirm",
  removeAll: "/console/mfa/remove",
  webauthnBegin: "/console/mfa/webauthn",
  webauthnFinish: "/console/mfa/webauthn/finish",
  webauthnRemove: "/console/mfa/webauthn/remove",
  logout: "/console/session/logout",
} as const;

export const CONSOLE_SESSION_COOKIE = "sentinel_session";

/* -------------------------------------------------------------------------- */
/*  Escaping                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Escape text for HTML.
 *
 * Both quote characters are escaped as well as the angle brackets, because this
 * value can land in an attribute — a factor's label becomes an input's `value`, and
 * a lone `"` there is an attribute injection rather than a rendering curiosity.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* -------------------------------------------------------------------------- */
/*  The view                                                                  */
/* -------------------------------------------------------------------------- */

export interface ConsoleActor {
  identifier: string;
  displayName: string;
  role: string;
  organizationName: string;
  organizationSlug: string;
}

export interface ConsoleSessionView {
  id: string;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface ConsoleFactorView extends MfaFactorSummary {
  /** A security key's credential id, so the page can remove exactly one. */
  credentialId: string | null;
}

export interface ConsoleMfaView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  enrolled: boolean;
  factors: ConsoleFactorView[];
  /** Present once, right after `beginEnrollment`: the secret and its `otpauth://` URI. */
  pending: { secret: string; uri: string } | null;
  /**
   * An enrollment is waiting for its first code.
   *
   * Tracked separately from `pending`, which only exists in the response that showed
   * the secret: a person who navigated away still has an enrollment to finish, and the
   * page has to offer the form even though it can no longer show what to type into it.
   */
  awaitingCode: boolean;
  /** The viewer's own identity id, needed for the WebAuthn user handle display. */
  identityId: string;
}

/**
 * The provisioning page (S2).
 *
 * A connector's token is minted here rather than through the SCIM API, on purpose:
 * the act of delegation is a person's, done while looking at a session, and a
 * machine-facing API that could mint its own credentials would have no ceiling. The
 * page also lists what a sync has brought in — groups and their membership — because
 * "did the directory push what I think it pushed?" is the question an administrator
 * actually has.
 */
export interface ConsoleProvisioningView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  tokens: ConsoleTokenView[];
  groups: ConsoleGroupView[];
  /** Where a connector points, so the page can show it rather than describe it. */
  scimBase: string;
}

export interface ConsoleTokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ConsoleGroupView {
  id: string;
  displayName: string;
  memberCount: number;
}

export interface ConsoleOverviewView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  enrolled: boolean;
  factorCount: number;
  /** The organization's most recent evidence, newest first. */
  events: { seq: number; at: string; actor: string; action: string; targetType: string | null; targetId: string | null }[];
  chainOk: boolean;
  chainLength: number;
  chainDetail: string;
}

/* -------------------------------------------------------------------------- */
/*  The shell                                                                 */
/* -------------------------------------------------------------------------- */

const STYLES = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b1020; color: #e8ecf6; }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; letter-spacing: .02em; text-transform: uppercase; color: #9fb0d0; }
  p { margin: .35rem 0; }
  a { color: #8fc9ff; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  pre { background: #141a2e; border: 1px solid #223055; border-radius: .5rem; padding: .75rem; overflow-x: auto; }
  form { margin: .5rem 0; }
  input { font: inherit; padding: .4rem .55rem; border-radius: .4rem; border: 1px solid #2c3a60; background: #141a2e; color: inherit; }
  button { font: inherit; font-weight: 600; padding: .45rem .8rem; border-radius: .4rem; border: 1px solid #2c3a60; background: #1b2440; color: inherit; cursor: pointer; }
  button:hover { background: #223055; }
  .muted { color: #9fb0d0; }
  .flash, .error { border-radius: .5rem; padding: .6rem .75rem; margin: 1rem 0; }
  .flash { background: #10331f; border: 1px solid #1f7a44; }
  .error { background: #33131c; border: 1px solid #8c2b45; }
  .card { border: 1px solid #223055; border-radius: .6rem; padding: .9rem 1rem; margin: .6rem 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #223055; vertical-align: top; }
  nav a { margin-right: 1rem; }
  ul { padding-left: 1.1rem; }
`;

export interface ConsolePageInput {
  title: string;
  /** Signed-out pages have no actor; the nav is then just a way back in. */
  actor: { identifier: string; displayName: string; organizationName: string } | null;
  body: string;
  flash?: string | null;
  error?: string | null;
}

/**
 * One page, wrapped.
 *
 * The nav is built here rather than by each page so a new console screen cannot
 * forget it, and so the set of screens is one list somebody can read.
 */
export function consolePage(input: ConsolePageInput): string {
  const nav = input.actor
    ? `<nav class="muted"><a href="${CONSOLE_PATHS.home}">Overview</a>` +
      `<a href="${CONSOLE_PATHS.mfa}">Second factor</a>` +
      `<a href="${CONSOLE_PATHS.provisioning}">Provisioning</a>` +
      `<form method="post" action="${CONSOLE_PATHS.logout}" style="display:inline"><button type="submit">Sign out</button></form></nav>`
    : `<nav class="muted"><a href="${CONSOLE_PATHS.home}">Console</a></nav>`;

  // The display name is somebody else's text and is rendered here on purpose: a page
  // that only ever shows an identifier makes a display name nothing more than
  // decoration. It is escaped like everything else.
  const who = input.actor
    ? `<p class="muted">${
        input.actor.displayName && input.actor.displayName !== input.actor.identifier
          ? `${escapeHtml(input.actor.displayName)} · `
          : ""
      }${escapeHtml(input.actor.identifier)} · ${escapeHtml(input.actor.organizationName)}</p>`
    : "";

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(input.title)} · OnTrak Sentinel</title><style>${STYLES}</style></head>` +
    `<body><main>${nav}<h1>${escapeHtml(input.title)}</h1>${who}` +
    (input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : "") +
    (input.flash ? `<p class="flash">${escapeHtml(input.flash)}</p>` : "") +
    input.body +
    `</main></body></html>`
  );
}

/** A refusal, as a page rather than a stack trace. */
export function consoleErrorPage(message: string, status: number): { status: number; html: string } {
  return {
    status,
    html: consolePage({
      title: status === 403 ? "Not allowed" : "Console could not continue",
      actor: null,
      body:
        `<p class="error" role="alert">${escapeHtml(message)}</p>` +
        `<p class="muted">The console is reached with a browser session (the <code>${CONSOLE_SESSION_COOKIE}</code> cookie). ` +
        `Sign in again from whichever client started the session, then come back.</p>` +
        `<p><a href="${CONSOLE_PATHS.home}">Back to the console</a></p>`,
      error: null,
    }),
  };
}

/** A signed-out landing page, because a sign-out that 404s reads as a failure. */
export function consoleSignedOutPage(): string {
  return consolePage({
    title: "Signed out",
    actor: null,
    body:
      `<p>Your session has ended, and every access token it minted has been revoked.</p>` +
      `<p class="muted">This is the same end-session path the OIDC logout endpoint uses, so a client that ` +
      `kept one of those tokens keeps nothing.</p>`,
  });
}

/* -------------------------------------------------------------------------- */
/*  Overview                                                                  */
/* -------------------------------------------------------------------------- */

const CHAIN_OK = "The organization's evidence chain verifies end to end.";

export function renderOverview(view: ConsoleOverviewView): string {
  const rows = view.events
    .slice(0, 25)
    .map(
      (event) =>
        `<tr><td class="muted">${escapeHtml(event.seq)}</td><td class="muted">${escapeHtml(event.at)}</td>` +
        `<td>${escapeHtml(event.action)}</td><td class="muted">${escapeHtml(event.actor)}</td>` +
        `<td class="muted">${escapeHtml(event.targetType ?? "")} ${escapeHtml(event.targetId ?? "")}</td></tr>`,
    )
    .join("");

  const body =
    `<h2>Second factor</h2>` +
    `<div class="card">` +
    (view.enrolled
      ? `<p><strong>Enrolled.</strong> ${escapeHtml(view.factorCount)} factor${view.factorCount === 1 ? "" : "s"} on record. ` +
        `<a href="${CONSOLE_PATHS.mfa}">Manage them</a>.</p>`
      : `<p><strong>Not enrolled.</strong> The default policy refuses a session to an identity without a second factor, ` +
        `so <a href="${CONSOLE_PATHS.mfa}">enroll one now</a> — no administrator is needed.</p>`) +
    `</div>` +
    `<h2>Session</h2>` +
    `<div class="card"><p class="muted">Issued ${escapeHtml(view.session.issuedAt)} · last seen ${escapeHtml(view.session.lastSeenAt)} · ` +
    `expires ${escapeHtml(view.session.expiresAt)}</p>` +
    `<p class="muted"><code>${escapeHtml(view.session.id)}</code></p></div>` +
    `<h2>Evidence</h2>` +
    `<p class="${view.chainOk ? "flash" : "error"}">${
      view.chainOk ? escapeHtml(CHAIN_OK) : escapeHtml(view.chainDetail)
    } <span class="muted">(${escapeHtml(view.chainLength)} events)</span></p>` +
    (rows
      ? `<table><thead><tr><th>#</th><th>When</th><th>Action</th><th>Actor</th><th>Target</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">Nothing has been recorded yet.</p>`);

  return consolePage({ title: "Console", actor: view.actor, body });
}

/* -------------------------------------------------------------------------- */
/*  Provisioning                                                              */
/* -------------------------------------------------------------------------- */

export function renderProvisioning(
  view: ConsoleProvisioningView,
  minted: { plaintext: string; label: string } | null,
  flash?: string | null,
  error?: string | null,
): string {
  const tokenRows = view.tokens.length
    ? `<table><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${view.tokens
        .map((token) => {
          const state = token.revokedAt
            ? `<span class="muted">revoked ${escapeHtml(token.revokedAt)}</span>`
            : token.lastUsedAt
              ? escapeHtml(token.lastUsedAt)
              : `<span class="muted">never</span>`;
          const action = token.revokedAt
            ? ""
            : `<form method="post" action="${CONSOLE_PATHS.revokeToken}" style="display:inline">` +
              `<input type="hidden" name="tokenId" value="${escapeHtml(token.id)}">` +
              `<button type="submit">Revoke</button></form>`;
          return (
            `<tr><td>${escapeHtml(token.label)}</td><td class="muted">${escapeHtml(token.createdAt)}</td>` +
            `<td class="muted">${state}</td><td>${action}</td></tr>`
          );
        })
        .join("")}</tbody></table>`
    : `<p class="muted">No token yet: nothing can provision for this organization.</p>`;

  const tokenState = view.tokens.some((token) => !token.revokedAt)
    ? `<p class="flash">At least one token is live, so this organization can be provisioned into.</p>`
    : `<p class="error" role="alert">Every token is revoked. A connector holding one is refused; mint a new one to resume.</p>`;

  const groupRows = view.groups.length
    ? `<table><thead><tr><th>Group</th><th>Members</th></tr></thead><tbody>${view.groups
        .map(
          (group) =>
            `<tr><td>${escapeHtml(group.displayName)}</td><td class="muted">${escapeHtml(group.memberCount)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No group has been synced yet.</p>`;

  const mintedCard = minted
    ? `<div class="card">` +
      `<h2>Copy this token now</h2>` +
      `<p>Give it to the directory connector as the bearer token. It is stored as a hash, so this is the only time it can be shown.</p>` +
      `<pre>${escapeHtml(minted.plaintext)}</pre>` +
      `<p class="muted">For ${escapeHtml(minted.label)}. Endpoints: <code>${escapeHtml(view.scimBase)}/Users</code> and ` +
      `<code>${escapeHtml(view.scimBase)}/Groups</code>.</p>` +
      `<p class="error">If it is lost, revoke it and mint another — nothing can read this one back.</p>` +
      `</div>`
    : "";

  const body =
    `<h2>Directory connector</h2>` +
    `<p class="muted">Point a SCIM 2.0 client at <code>${escapeHtml(view.scimBase)}</code>. Discovery is public; ` +
    `everything else needs a token below.</p>` +
    tokenState +
    mintedCard +
    `<div class="card"><form method="post" action="${CONSOLE_PATHS.mintToken}">` +
    `<label class="muted" for="label">Name it after the directory</label> ` +
    `<input id="label" name="label" placeholder="Entra ID — production"> ` +
    `<button type="submit">Mint a token</button></form>` +
    `<p class="muted">The connector acts as you while it holds this token, inside this organization only — ` +
    `every write it makes is recorded against the token, not against you.</p></div>` +
    `<h2>Tokens</h2>` +
    `<div class="card">${tokenRows}</div>` +
    `<h2>Synced groups</h2>` +
    `<div class="card">${groupRows}` +
    `<p class="muted">Groups are recorded, not enforced: roles, groups and attribute-based policy are the rest of S1. ` +
    `What a sync gives you today is the fact of who is in what, on the evidence chain.</p></div>`;

  return consolePage({ title: "Provisioning", actor: view.actor, body, flash, error });
}

/* -------------------------------------------------------------------------- */
/*  Second factor                                                             */
/* -------------------------------------------------------------------------- */

export function renderMfa(view: ConsoleMfaView, flash?: string | null, error?: string | null): string {
  const factorRows = view.factors.length
    ? `<ul>${view.factors
        .map((factor) => {
          const state = factor.confirmed ? "enrolled" : "waiting for its first code";
          const remove = factor.credentialId
            ? `<form method="post" action="${CONSOLE_PATHS.webauthnRemove}" style="display:inline">` +
              `<input type="hidden" name="credentialId" value="${escapeHtml(factor.credentialId)}">` +
              `<button type="submit">Remove</button></form>`
            : "";
          return (
            `<li><strong>${escapeHtml(mfaKindLabel(factor.kind))}</strong>` +
            (factor.label ? ` — ${escapeHtml(factor.label)}` : "") +
            ` <span class="muted">(${escapeHtml(state)}${factor.lastUsedAt ? `, last used ${escapeHtml(factor.lastUsedAt)}` : ""})</span> ${remove}</li>`
          );
        })
        .join("")}</ul>`
    : `<p class="muted">No second factor yet.</p>`;

  const beginForm =
    `<form method="post" action="${CONSOLE_PATHS.totpBegin}">` +
    `<label class="muted" for="label">Name it after the device, if you like</label> ` +
    `<input id="label" name="label" placeholder="Phone"> ` +
    `<button type="submit">Set up an authenticator app</button></form>`;

  const confirmForm =
    `<form method="post" action="${CONSOLE_PATHS.totpConfirm}">` +
    `<label class="muted" for="code">Code</label> ` +
    `<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required> ` +
    `<button type="submit">Confirm</button></form>`;

  const pending = view.awaitingCode
    ? `<div class="card"><h2>Finish enrolling the app</h2>` +
      (view.pending
        ? `<p>Add this secret to an authenticator app — scan the URI as a QR code, or type the secret — then enter the six digits it shows.</p>` +
          `<pre>${escapeHtml(view.pending.secret)}</pre>` +
          `<p class="muted">Or, as a URI:</p><pre>${escapeHtml(view.pending.uri)}</pre>` +
          `<p class="error">This secret is shown once. Nothing can read it back out of the database.</p>`
        : `<p class="muted">An enrollment is waiting for its first code. If the secret is gone, set it up again below — a new secret replaces the pending one.</p>`) +
      confirmForm +
      `</div>` +
      beginForm
    : `<div class="card">${beginForm}</div>`;

  const body =
    `<h2>Enrolled factors</h2>` +
    (view.enrolled
      ? `<p class="flash">The session policy is satisfied.</p>`
      : `<p class="error" role="alert">No confirmed factor: the policy refuses every session for this identity until one is enrolled.</p>`) +
    `<div class="card">${factorRows}</div>` +
    `<h2>Authenticator app</h2>` +
    pending +
    `<h2>Security key</h2>` +
    `<div class="card">` +
    `<p>Register a passkey or a hardware key. The browser asks the device; nothing leaves it but a public key.</p>` +
    `<p><button type="button" id="webauthn-button">Register a security key</button> <span class="muted" id="webauthn-status"></span></p>` +
    `</div>` +
    `<h2>Remove everything</h2>` +
    `<div class="card"><p>Removing every factor clears the enrolled flag, and the default policy then refuses ` +
    `<em>every</em> session this identity holds — including the one you are reading this on. Getting back in ` +
    `needs a factor enrolled from somewhere else: an administrator, or a login path that prompts for one. ` +
    `Removing one factor while another stays confirmed does not do this.</p>` +
    `<form method="post" action="${CONSOLE_PATHS.removeAll}"><button type="submit">Remove all factors</button></form></div>` +
    `<script>${WEBAUTHN_SCRIPT}</script>`;

  return consolePage({ title: "Second factor", actor: view.actor, body, flash, error });
}

/**
 * The WebAuthn ceremony, as the browser has to run it.
 *
 * It posts an options object, hands the browser's answer back verbatim, and
 * reloads. The base64url conversions are the whole of the interesting code: the
 * API speaks `ArrayBuffer` and JSON speaks base64url, and this is where the two
 * meet. `attestation: "none"` is passed through rather than overridden, because the
 * server decides what it will accept.
 *
 * A deployment serving this behind a strict CSP should add a nonce to the `<script>`
 * tag; it is inline because a ceremony cannot be a form post.
 */
export const WEBAUTHN_SCRIPT = `
(function () {
  function fromBase64Url(value) {
    var padded = value.replace(/-/g, "+").replace(/_/g, "/");
    var binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function toBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  var button = document.getElementById("webauthn-button");
  var status = document.getElementById("webauthn-status");
  if (!button) return;
  if (!window.PublicKeyCredential) {
    button.disabled = true;
    if (status) status.textContent = "This browser does not support security keys.";
    return;
  }
  button.addEventListener("click", function () {
    // Disabled for the length of one ceremony, and re-enabled whatever happened:
    // a refusal the user cannot retry is a console they have to reload.
    button.disabled = true;
    run()
      .catch(function (error) {
        if (status) status.textContent = error && error.message ? error.message : "The ceremony failed.";
      })
      .finally(function () {
        button.disabled = false;
      });
  });
  async function run() {
    try {
      var optionsResponse = await fetch("${CONSOLE_PATHS.webauthnBegin}", { method: "POST" });
      var options = await optionsResponse.json();
      if (!optionsResponse.ok) {
        if (status) status.textContent = options.error || "The registration could not be started.";
        return;
      }
      if (status) status.textContent = "Waiting for the device…";
      var credential = await navigator.credentials.create({
        publicKey: {
          challenge: fromBase64Url(options.challenge),
          rp: options.rp,
          user: {
            id: fromBase64Url(options.user.id),
            name: options.user.name,
            displayName: options.user.displayName,
          },
          pubKeyCredParams: options.pubKeyCredParams,
          timeout: options.timeout,
          attestation: options.attestation,
          authenticatorSelection: options.authenticatorSelection,
          excludeCredentials: (options.excludeCredentials || []).map(function (entry) {
            return { type: entry.type, id: fromBase64Url(entry.id) };
          }),
        },
      });
      if (!credential) {
        if (status) status.textContent = "The device returned nothing.";
        return;
      }
      var finish = await fetch("${CONSOLE_PATHS.webauthnFinish}", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: options.challengeId,
          label: (document.getElementById("label") || {}).value || null,
          response: {
            type: credential.type,
            id: credential.id,
            clientDataJSON: toBase64Url(credential.response.clientDataJSON),
            attestationObject: toBase64Url(credential.response.attestationObject),
            transports: credential.response.getTransports ? credential.response.getTransports() : [],
          },
        }),
      });
      var result = await finish.json();
      if (!finish.ok) {
        if (status) status.textContent = result.error || "The key was refused.";
        return;
      }
      if (status) status.textContent = "Registered.";
      window.location.reload();
    } catch (error) {
      if (status) status.textContent = error && error.message ? error.message : "The ceremony failed.";
    }
  }
})();
`;
