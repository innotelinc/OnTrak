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
  /**
   * The console's own sign-in.
   *
   * Sentinel is an identity provider, so this page is the one place in the Network
   * that checks a password itself — everywhere else hands the person to a provider.
   * It sits under `/console` rather than at `/sign-in` so the console's whole surface
   * is one path prefix an operator can reason about (and one prefix a deployment can
   * put behind a VPN without catching the OIDC endpoints too).
   */
  signIn: "/console/sign-in",
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

/**
 * The shared theme, as the console's `node:http` adapter serves it.
 *
 * Two files, mounted at the site root rather than under `/console`, so that every
 * page in the product can use them and not just the console's. The adapter reads
 * them from `ontrak-sentinel/` on disk at startup — `src/theme/ontrak-theme.css` and
 * `public/ontrak-theme.js`, both byte-identical to the canonical copies in
 * `theme/` — which is what keeps one palette rather than a sixth hand-written one.
 */
export const CONSOLE_ASSET_PATHS = {
  themeCss: "/ontrak-theme.css",
  themeJs: "/ontrak-theme.js",
} as const;

/**
 * The console's scheme: the security-operations palette.
 *
 * Sentinel is the SOC, so it wears the navy-and-cyan family. Named here rather
 * than written into the markup twice, because the theme script and the `<html>`
 * attribute have to agree or the first paint is the wrong palette.
 */
export const CONSOLE_SCHEME = "soc";

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

/**
 * The console's own layout, on the shared theme's tokens.
 *
 * No raw colour appears in this block, and that is the point: the palette lives in
 * `ontrak-theme.css` (one canonical copy, served at `/ontrak-theme.css`), and this
 * file only says how the console arranges things. A console that hard-coded its
 * colours would be the sixth opinion about the Network's look, which is exactly what
 * the theme exists to stop.
 *
 * The console picks the `operations` scheme — the graphite-and-blue family the
 * operations consoles use — because that is what Sentinel is.
 */
const STYLES = `
  body { margin: 0; font: 15px/1.55 var(--font-sans); background: var(--canvas); color: var(--ink); }
  main { max-width: 46rem; margin: 0 auto; padding: var(--space-6) var(--space-4) 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 var(--space-1); letter-spacing: -.01em; }
  h2 { font-size: .82rem; margin: var(--space-6) 0 var(--space-2); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); }
  p { margin: .35rem 0; }
  a { color: var(--brand); }
  code, pre { font-family: var(--mono); font-size: .85em; }
  pre { background: var(--surface-sunken); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: .75rem; overflow-x: auto; }
  form { margin: .75rem 0; }
  input { font: inherit; width: 100%; box-sizing: border-box; padding: .5rem .6rem; border-radius: var(--radius-sm); border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); }
  input:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: 1px; }
  button { font: inherit; font-weight: 600; padding: .5rem .9rem; border-radius: var(--radius-sm); border: 1px solid transparent; background: var(--brand); color: var(--brand-ink); cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .muted { color: var(--ink-faint); }
  .flash, .error { border-radius: var(--radius-sm); padding: .6rem .75rem; margin: var(--space-4) 0; }
  .flash { background: var(--ok-soft); border: 1px solid var(--ok); color: var(--ok); }
  .error { background: var(--bad-soft); border: 1px solid var(--bad); color: var(--bad); }
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: .9rem 1rem; margin: var(--space-2) 0; box-shadow: var(--shadow-card); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  /* One bar across the top, holding the section links and the two controls. It is
     sticky because the evidence table runs long and the switch should still be to
     hand at the bottom of it. */
  .bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: var(--space-4);
         flex-wrap: wrap; padding: var(--space-3) var(--space-4); background: var(--surface);
         border-bottom: 1px solid var(--line); }
  nav { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; margin-right: auto; }
  nav a { color: var(--ink-soft); text-decoration: none; font-weight: 500; }
  nav a:hover { color: var(--brand); }
  .bar-actions { display: flex; align-items: center; gap: var(--space-3); }
  .bar-actions form { margin: 0; }
  button.quiet { background: transparent; border-color: var(--line-strong); color: var(--ink-soft); font-weight: 500; }
  button.quiet:hover { background: var(--surface-muted); color: var(--ink); filter: none; }
  main { max-width: 52rem; }
  ul { padding-left: 1.1rem; }
  .field { display: block; margin: var(--space-3) 0; }
  .field label { display: block; font-weight: 600; font-size: .88rem; margin-bottom: var(--space-1); }
  .field .hint { font-weight: 400; color: var(--ink-faint); }
  /* The sign-in page is a single narrow column, centred in the viewport rather than
     in the 52rem reading column: a login form adrift in a wide empty page looks
     like a page that failed to load. */
  .signin { max-width: 24rem; margin: 8vh auto 0; }
  .signin h1 { font-size: 1.5rem; }
  .signin .sub { color: var(--ink-faint); margin-bottom: var(--space-5); }
  .signin button[type="submit"] { width: 100%; padding: .6rem; margin-top: var(--space-2); }
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
      `</nav>`
    : `<nav class="muted"><a href="${CONSOLE_PATHS.signIn}">Sign in</a></nav>`;

  // The switch and the sign-out button share the bar's right-hand side, so the two
  // things a person reaches for from any page are in the same place on every page.
  const actions =
    `<div class="bar-actions">${themeSwitch()}` +
    (input.actor
      ? `<form method="post" action="${CONSOLE_PATHS.logout}"><button type="submit" class="quiet">Sign out</button></form>`
      : "") +
    `</div>`;

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
    // `data-scheme` is how the shared theme is told which palette to paint; the mode
    // (light/dark/system) is whichever the person chose, restored by the theme script
    // below before the first paint. Both are on `<html>` rather than a wrapper so the
    // `prefers-color-scheme` rules reach the whole document.
    `<!doctype html><html lang="en" data-scheme="${CONSOLE_SCHEME}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(input.title)} · OnTrak Sentinel</title>` +
    // The stylesheet first, then the switch, then the console's own rules. The switch
    // is a *blocking* script on purpose: it has to run before the first paint so
    // `<html>` already carries the remembered mode. Deferred, it would paint the
    // default palette and then correct itself, which reads as a flicker.
    `<link rel="stylesheet" href="${CONSOLE_ASSET_PATHS.themeCss}">` +
    `<script src="${CONSOLE_ASSET_PATHS.themeJs}"></script>` +
    `<style>${STYLES}</style></head>` +
    `<body><div class="bar">${nav}${actions}</div><main><h1>${escapeHtml(input.title)}</h1>${who}` +
    (input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : "") +
    (input.flash ? `<p class="flash">${escapeHtml(input.flash)}</p>` : "") +
    input.body +
    `</main>${TOGGLE_SCRIPT}</body></html>`
  );
}

/**
 * The colour switch, as the console renders it.
 *
 * The same control the React apps use, in plain markup: the console is server-rendered
 * HTML with no bundler, so it cannot import `ThemeToggle.tsx`. It renders the same
 * classes (`.ot-theme`) that the shared stylesheet styles, so it cannot drift visually
 * either — only the wiring differs, and that is six lines of script at the foot of the
 * page rather than a framework.
 */
function themeSwitch(): string {
  const buttons = (["system", "light", "dark"] as const)
    .map(
      (mode) =>
        `<button type="button" data-theme-mode="${mode}" aria-pressed="false">${mode === "system" ? "System" : mode === "light" ? "Light" : "Dark"}</button>`,
    )
    .join("");
  return `<div class="ot-theme" role="group" aria-label="Colour theme">${buttons}</div>`;
}

/**
 * Wire the switch to `window.OntrakTheme`.
 *
 * A `data-theme-mode` click asks the shared script to change the preference, and the
 * `ontrak:theme` event it fires in response is what repaints the pressed state — so
 * the buttons reflect the document rather than the click that asked for the change.
 * That is what keeps two switches on one page (a product's and this one) agreeing, and
 * it is why `apply()` is never called directly here.
 */
const TOGGLE_SCRIPT =
  `<script>(function(){` +
  `var api=window.OntrakTheme;if(!api)return;` +
  `function paint(){var now=api.mode();var all=document.querySelectorAll('[data-theme-mode]');` +
  `for(var i=0;i<all.length;i++){all[i].setAttribute('aria-pressed',String(all[i].getAttribute('data-theme-mode')===now));}}` +
  `var buttons=document.querySelectorAll('[data-theme-mode]');` +
  `for(var i=0;i<buttons.length;i++){buttons[i].addEventListener('click',function(){api.setMode(this.getAttribute('data-theme-mode'));});}` +
  `window.addEventListener('ontrak:theme',paint);paint();` +
  `})();</script>`;

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
        `An expired or revoked session is ordinary — signing in again is the fix.</p>` +
        `<p><a href="${CONSOLE_PATHS.signIn}">Sign in to the console</a> · ` +
        `<a href="${CONSOLE_PATHS.home}">Back to the console</a></p>`,
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
      `kept one of those tokens keeps nothing.</p>` +
      `<p><a href="${CONSOLE_PATHS.signIn}">Sign in again</a></p>`,
  });
}

/* -------------------------------------------------------------------------- */
/*  Sign in                                                                   */
/* -------------------------------------------------------------------------- */

/** What the sign-in form needs to render. */
export interface ConsoleSignInView {
  /** Echoed back so a mistyped address does not have to be retyped. */
  identifier: string | null;
  /** The organization slug, when the deployment is configured with one. */
  organization: string | null;
  error: string | null;
  flash: string | null;
}

/**
 * The console's sign-in page.
 *
 * One form, three fields, and no client script: the code field is always present
 * rather than revealed after the password is accepted, because *revealing* it would
 * announce which accounts have a second factor enrolled — a small thing on its own
 * and a useful one to a person choosing who to attack.
 *
 * The workspace field is shown only when the deployment names a default. A
 * single-tenant console should not ask somebody to type a workspace they were never
 * given; a multi-tenant one has to, because an email address is unique within an
 * organization rather than across them.
 */
export function renderSignIn(view: ConsoleSignInView): string {
  const workspace = view.organization
    ? `<span class="field"><label for="organization">Workspace</label>` +
      `<input id="organization" name="organization" value="${escapeHtml(view.organization)}" autocomplete="organization" readonly>` +
      `<span class="hint muted">This console signs in to <code>${escapeHtml(view.organization)}</code>.</span></span>`
    : `<span class="field"><label for="organization">Workspace <span class="hint">(optional)</span></label>` +
      `<input id="organization" name="organization" autocomplete="organization" placeholder="your-organization"></span>`;

  return consolePage({
    title: "Sign in",
    actor: null,
    body:
      `<div class="signin">` +
      `<p class="muted">OnTrak Sentinel is the identity provider for the Network: this console holds the ` +
      `identities, so this is the one place that checks a password itself.</p>` +
      `<form method="post" action="${CONSOLE_PATHS.signIn}">` +
      `<span class="field"><label for="identifier">Email address</label>` +
      `<input id="identifier" name="identifier" type="text" inputmode="email" autocomplete="username" ` +
      `autocapitalize="none" spellcheck="false" required value="${escapeHtml(view.identifier ?? "")}"></span>` +
      `<span class="field"><label for="password">Password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required></span>` +
      workspace +
      `<span class="field"><label for="code">Authenticator code <span class="hint">(when one is enrolled)</span></label>` +
      `<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" ` +
      `pattern="[0-9]{6,8}" placeholder="123456"></span>` +
      `<button type="submit">Sign in</button>` +
      `</form>` +
      `<p class="muted">Every other product in the Network signs in through Sentinel rather than holding ` +
      `passwords of its own.</p>` +
      `</div>`,
    flash: view.flash,
    error: view.error,
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
