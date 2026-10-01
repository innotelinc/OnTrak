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
import { POLICY_SCOPES, type PolicyScope } from "./identity-rules";
// The queue's shape, read from the rules module rather than restated here: what the page
// offers to narrow by has to be what the filter actually understands.
import {
  ALERT_SEVERITIES,
  ASSIGNEE_ANY,
  ASSIGNEE_MINE,
  ASSIGNEE_NONE,
  filterQuery,
  type AlertTimelineEntry,
  type RelatedAlert,
  type TriageFilter,
  type TriageSummary,
} from "./alert-triage-rules";
// Who may be handed an alert, read from the module both this page and the service share, so
// the picker cannot offer a name the service would refuse.
import type { AssignableIdentity } from "./alert-assignment-rules";
import type { AlertState } from "./detection-service";
import type { Severity } from "./detection-rules";
// Read for the feed page's help text: the kinds it will classify, and the confidence below
// which a match annotates rather than escalates. Both are named here rather than retyped, so
// the page cannot promise something the matcher does not do.
import { CONFIDENCE_FLOOR, INDICATOR_KINDS } from "./threat-intel-rules";
// The coverage map's shape, read from the module that derives it: the page renders what the
// rulebook says, never a list kept beside it, so it cannot claim detection nothing performs.
import type { CoverageReport } from "./detection-coverage-rules";
// The enforcement page (S4): the shapes a proposal and a policy are, read from the module
// the service decides with, so the form cannot ask for a field the decision never reads.
// `ENFORCEMENT_TARGET_KINDS` and `ENFORCEMENT_ACTION_KINDS` are the vocabulary the form's
// pickers offer, named rather than retyped — a target kind the decision would refuse must
// not be a value the page can submit.
import {
  ENFORCEMENT_ACTION_KINDS,
  ENFORCEMENT_TARGET_KINDS,
  type EnforcementActionKind,
  type EnforcementPolicy,
  type EnforcementTarget,
} from "./enforcement-rules";
import type { EnforcementState } from "./enforcement-service";
import { UPSTREAM_PATHS } from "./upstream-rules";

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
  /**
   * The console's *other* sign-in: the provider.
   *
   * Sentinel owns a password for its own console, but a deployment with a provider does
   * not want a second one. These two paths are the authorization-code legs — the first
   * hands the browser to the provider, the second receives the reply — and they live under
   * the same `/console` prefix as everything else, so a deployment can put one prefix behind
   * a VPN without catching the OIDC endpoints the family depends on.
   */
  upstreamStart: UPSTREAM_PATHS.start,
  upstreamCallback: UPSTREAM_PATHS.callback,
  policies: "/console/policies",
  directory: "/console/directory",
  directoryConnect: "/console/directory/connection",
  directoryRemove: "/console/directory/connection/remove",
  directorySync: "/console/directory/sync",
  /**
   * Access reviews (S2): the register of attestations, and the acts on one.
   *
   * One page with three verbs' worth of surface, like the Guard queue: the register and one
   * review's list (`?review=<id>`), and the changes as their own POST paths below. Naming
   * them separately is what keeps a review's decisions off a path a link or a crawler can
   * reach — attesting to somebody's access is a POST or it did not happen.
   */
  reviews: "/console/reviews",
  reviewOpen: "/console/reviews/open",
  reviewAttest: "/console/reviews/attest",
  reviewClose: "/console/reviews/close",
  reviewCancel: "/console/reviews/cancel",
  reviewSchedule: "/console/reviews/schedule",
  reviewScheduleToggle: "/console/reviews/schedule/toggle",
  reviewScheduleRemove: "/console/reviews/schedule/remove",
  /**
   * Threat intelligence (S3): the indicators this organization matches against.
   *
   * Under `/console` with everything else, for the same reason the console's sign-in is:
   * one prefix an operator can put behind a VPN without also catching the OIDC endpoints.
   */
  intel: "/console/intel",
  intelIngest: "/console/intel/feed",
  intelWithdraw: "/console/intel/indicator/withdraw",
  /**
   * The detection-coverage map (S3): what the rulebook reads, and what it does not.
   *
   * Read-only, and its subject is the *gaps*: the sources and kinds this build declares
   * but no rule looks at. It derives every figure from the rules the pipeline runs, so the
   * page cannot promise coverage the deployment does not have — which is the failure a
   * coverage map exists to prevent, not to commit.
   */
  coverage: "/console/coverage",
  /**
   * The Guard queue (S4): what detection raised, narrowed to what is still open.
   *
   * One path, three verbs' worth of surface: the queue itself, one alert's investigation
   * (`?alert=<id>`), and the two state changes as their own POST paths below — because a
   * state change has to be a POST and a GET that reads a queue must not be able to close
   * anything if a crawler follows it.
   */
  alerts: "/console/alerts",
  alertAcknowledge: "/console/alerts/acknowledge",
  alertClose: "/console/alerts/close",
  /**
   * Handing an alert to somebody, and giving it back to the queue (S3).
   *
   * Two paths rather than one with an empty target, because the two acts read differently on
   * the evidence chain (`guard.alert.assigned` / `guard.alert.unassigned`) and a form whose
   * meaning depends on which control was left blank is a form that will be submitted wrong.
   */
  alertAssign: "/console/alerts/assign",
  alertUnassign: "/console/alerts/unassign",
  /**
   * The compliance posture summary (S4).
   *
   * A read-only page on purpose. It reports what the deployment *is* — the controls in
   * force, who they cover, what is waiting in the queue, and whether the evidence chain
   * still verifies — so that the number a reviewer is handed is derived from the same
   * rows the product enforces, rather than typed into a report.
   */
  compliance: "/console/compliance",
  /**
   * The same posture, as a signed file (S4).
   *
   * A separate path from the page because it answers with a document rather than a
   * screen: the point of it is to leave this system and be verifiable by somebody who
   * has no account here — which is what the family's shared packet format is for.
   */
  compliancePacket: "/console/compliance/packet",
  /**
   * Guard's prevention surface (S4): what is in force, what is waiting, and the forms that
   * propose, approve and lift an action.
   *
   * The last page in the product to arrive and the one the milestone was waiting on,
   * because until an operator could reach enforcement from a browser, prevention was a
   * service somebody had to drive by hand. One page and four POST paths, the same shape the
   * Guard queue takes: the register is a `GET`, and every act on it — proposing, approving,
   * lifting, and writing the policy the rails are judged against — is its own POST, so a link
   * or a crawler cannot block a network. Administration only, both to read and to act: a
   * safe-list is not a page for everybody, and the nav hides it for anyone else.
   */
  enforcement: "/console/enforcement",
  enforcementPropose: "/console/enforcement/propose",
  enforcementApprove: "/console/enforcement/approve",
  enforcementLift: "/console/enforcement/lift",
  enforcementPolicy: "/console/enforcement/policy",
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
 * them from `ontrak-sentinel/` on disk at startup — `src/theme/unity-theme.css` and
 * `public/unity-theme.js`, both byte-identical to the canonical copies in
 * `theme/` — which is what keeps one palette rather than a sixth hand-written one.
 */
export const CONSOLE_ASSET_PATHS = {
  themeCss: "/unity-theme.css",
  themeJs: "/unity-theme.js",
} as const;

/**
 * The console's scheme: the security-operations palette.
 *
 * Sentinel is the SOC, so it wears the navy-and-cyan family. Named here rather
 * than written into the markup twice, because the theme script and the `<html>`
 * attribute have to agree or the first paint is the wrong palette.
 */
export const CONSOLE_SCHEME = "soc";

/**
 * The Sentinel mark: a shield with a heartbeat across it.
 *
 * Sentinel's console is the one page in the Network a person reaches without a
 * product tile to click, so it has to say *whose* page it is before it asks for a
 * password. The shield is the security-operations reading of the family's mark —
 * the same idea as the IT Support Training icon — and the trace inside it is what
 * the product does: watch the wire and raise what it finds. It is inline rather
 * than a file because the console ships no static assets of its own and because
 * the colours are theme tokens, so it repaints with the palette.
 */
const SENTINEL_MARK =
  `<svg class="brand-mark" viewBox="0 0 48 48" role="img" aria-label="OnTrak Sentinel">` +
  `<defs><linearGradient id="sentinel-mark" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0%" stop-color="var(--brand)"/>` +
  `<stop offset="100%" stop-color="var(--tone-sentinel)"/>` +
  `</linearGradient></defs>` +
  `<path d="M24 3.5 42.5 11v13.2C42.5 35 35.3 43.3 24 45.5 12.7 43.3 5.5 35 5.5 24.2V11Z" fill="url(#sentinel-mark)"/>` +
  `<path d="M12.5 25.5h6.2l2.9-7.4 4.4 14.8 3-8.2h6.5" fill="none" stroke="var(--brand-ink)" ` +
  `stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>`;

/**
 * The product lockup: the mark, the name, and one line saying what this is.
 *
 * Rendered instead of the page's `<h1>` on the sign-in page and nowhere else. Every
 * other page is reached by somebody already inside, who knows where they are and
 * wants the page's own title; the sign-in page is the one place a person arrives
 * cold, so there the product signs its name.
 */
function brandHead(sub: string): string {
  return (
    `<div class="brand-head">${SENTINEL_MARK}` +
    `<div class="brand-text"><span class="brand-name">OnTrak Sentinel</span>` +
    `<span class="brand-sub">${escapeHtml(sub)}</span></div></div>`
  );
}

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

/**
 * The policies page (S1).
 *
 * S0 had one policy per organization and no screen for it, which meant the number a
 * sign-in was actually judged by existed only in the database. This is the view that
 * shows it — per scope, with the identity count it governs — because "who does this
 * apply to?" is the question an administrator has before they change it.
 */
export interface ConsolePolicyView {
  scope: PolicyScope;
  /** What the scope is called to a person: “Baseline” or the role name. */
  title: string;
  /** The stored row, or `null` when this scope has never been written. */
  stored: {
    requireMfa: boolean;
    maxSessionSeconds: number;
    idleTimeoutSeconds: number;
    updatedAt: string;
  } | null;
  /** What an identity here is *actually* judged by: the role row, else the baseline. */
  effective: { requireMfa: boolean; maxSessionSeconds: number; idleTimeoutSeconds: number };
  /** How many identities this scope governs today. */
  identities: number;
}

/**
 * The directory page (S2): the sources Sentinel reads, and what the last runs did.
 *
 * Separate from the provisioning page on purpose. Provisioning is a *credential* the
 * customer's connector uses to push at us; this is a connection *we* hold to pull from
 * them. They are different trust directions, and the page that says "who may write to
 * us" should not be the page that holds a client secret.
 */
export interface ConsoleConnectionView {
  id: string;
  name: string;
  source: string;
  url: string;
  conflictPolicy: string;
  defaultRole: string;
  hasSecret: boolean;
  lastSyncedAt: string | null;
}

export interface ConsoleDirectoryRunView {
  connectionId: string;
  startedAt: string;
  status: string;
  detail: string | null;
}

export interface ConsoleDirectoryView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  connections: ConsoleConnectionView[];
  /** The sources this deployment can actually read, so the form offers only those. */
  sources: string[];
  runs: ConsoleDirectoryRunView[];
}

/**
 * The access-review page (S2): the register of attestations, one review's list, and the
 * schedules that open the next ones.
 *
 * Everything the page needs to show a review is projected here rather than read off the
 * service's own records, for the reason every other page does it: a change to a stored
 * record should not be able to change what an operator sees without this file agreeing.
 * In particular `state` is the *derived* one — `OVERDUE` is computed from the clock by the
 * rules, never stored — so the page can never show a stale flag as a fact.
 */
export interface ConsoleReviewItemView {
  identityId: string;
  /** The person: a display name, else their identifier, else the id itself. */
  name: string;
  identifier: string;
  role: string;
  active: boolean;
  decision: string;
  decidedAt: string | null;
  note: string | null;
}

export interface ConsoleReviewView {
  id: string;
  name: string;
  scopeKind: string;
  /** The group's name when the scope is a group, else "". */
  scopeValue: string;
  reviewerId: string;
  /** The reviewer's display name, as shown; falls back to the id when they are gone. */
  reviewerName: string;
  dueAt: string;
  status: string;
  /** `OPEN`, `OVERDUE`, `COMPLETED` or `CANCELLED`, derived with the clock. */
  state: string;
  progress: { total: number; kept: number; revoked: number; pending: number };
  createdAt: string;
}

export interface ConsoleReviewScheduleView {
  id: string;
  name: string;
  scopeKind: string;
  scopeValue: string;
  reviewerId: string;
  reviewerName: string;
  intervalDays: number;
  nextRunAt: string;
  lastRunAt: string | null;
  enabled: boolean;
}

export interface ConsoleReviewsView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  reviews: ConsoleReviewView[];
  schedules: ConsoleReviewScheduleView[];
  /** The review named by `?review=`, or `null` on a plain read. */
  open: {
    review: ConsoleReviewView;
    items: ConsoleReviewItemView[];
    /** Whether this actor is the reviewer (or an administrator), so the forms can appear. */
    canAttest: boolean;
    /** Whether this actor administers reviews, so close/cancel and the schedules appear. */
    canManage: boolean;
  } | null;
  /** People a review or schedule can be assigned to: the active roster. */
  reviewers: { id: string; name: string }[];
  /** Groups a `GROUP` scope may name. Empty when this deployment has no groups. */
  groups: { id: string; name: string }[];
}

/** What a preview or a completed sync is shown as. */
export interface ConsoleSyncReportView {
  connectionName: string;
  dryRun: boolean;
  detail: string;
  changes: { action: string; detail: string }[];
  skipped: string[];
}

/**
 * The threat-intelligence page (S3): the indicators this organization matches against, and
 * what the last push into the list did.
 *
 * One page rather than two, deliberately. "What does the feed know?" and "what did the feed
 * just change?" are the same question asked a second later, and a deployment that has to
 * navigate to see whether its last paste was accepted is a deployment whose paste is
 * unverified. The report travels on the view for that reason — it is the *answer* to the
 * response, not a separate screen.
 */
export interface ConsoleIndicatorView {
  id: string;
  kind: string;
  /** Canonical, so two feeds naming one address are one row here too. */
  value: string;
  source: string;
  confidence: number;
  severity: string | null;
  labels: string[];
  firstSeenAt: string;
  /** ISO, or `null` for "does not expire" — which the page says in words. */
  expiresAt: string | null;
  /** Whether the matcher would use it right now. Expiry applied where it can be seen. */
  active: boolean;
}

/** What one push into the list did, refusals included. */
export interface ConsoleFeedReportView {
  accepted: number;
  updated: number;
  rejected: { value: string; reason: string }[];
}

export interface ConsoleIntelView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  stats: {
    total: number;
    active: number;
    expired: number;
    /** How many rows carry an expiry at all. Zero is worth saying out loud. */
    withExpiry: number;
    byFeed: Record<string, number>;
    byKind: Record<string, number>;
  };
  indicators: ConsoleIndicatorView[];
  /** Present only on the response to a push, `null` on a plain read. */
  report: ConsoleFeedReportView | null;
}

/**
 * The detection-coverage map (S3): which declared kinds and sources the rulebook reads, and
 * which it does not.
 *
 * Read-only, and derived from the rules the deployment runs rather than from a list kept
 * beside them, so the page cannot claim detection the pipeline does not perform. `gaps` is
 * the reason it exists: a coverage map that only listed what is covered would answer the
 * opposite of the question somebody brought to it.
 */
export interface ConsoleCoverageView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  /** The map, built from the rulebook this build ships. */
  report: CoverageReport;
  generatedAt: string;
}

export interface ConsolePoliciesView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  policies: ConsolePolicyView[];
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
 * `unity-theme.css` (one canonical copy, served at `/unity-theme.css`), and this
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
  input, textarea { font: inherit; width: 100%; box-sizing: border-box; padding: .5rem .6rem; border-radius: var(--radius-sm); border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); }
  input:focus-visible, textarea:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: 1px; }
  textarea { font-family: var(--mono); font-size: .85em; resize: vertical; }
  button { font: inherit; font-weight: 600; padding: .5rem .9rem; border-radius: var(--radius-sm); border: 1px solid transparent; background: var(--brand); color: var(--brand-ink); cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .muted { color: var(--ink-faint); }
  .flash, .error { border-radius: var(--radius-sm); padding: .6rem .75rem; margin: var(--space-4) 0; }
  .flash { background: var(--ok-soft); border: 1px solid var(--ok); color: var(--ok); }
  .error { background: var(--bad-soft); border: 1px solid var(--bad); color: var(--bad); }
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: .9rem 1rem; margin: var(--space-2) 0; box-shadow: var(--shadow-card); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  select { font: inherit; padding: .35rem .5rem; border-radius: var(--radius-sm); border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); }
  /* Severity and control states. Colour comes from the theme's own tokens and nowhere
     else, so the SOC palette and a light/dark switch both reach these two columns. */
  .sev { font-size: .72rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .sev-critical, .sev-high { color: var(--bad); }
  .sev-medium { color: var(--ink-soft); }
  .sev-low { color: var(--ink-faint); }
  .control-ok { color: var(--ok); font-weight: 600; }
  .control-warn { color: var(--ink-soft); font-weight: 600; }
  .control-fail { color: var(--bad); font-weight: 600; }
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
  /* The product lockup. Sized so the mark reads at a glance without the name
     becoming a headline: on the sign-in page the form is the subject, not the
     branding. */
  .brand-head { display: flex; align-items: center; gap: var(--space-3); margin: 0 0 var(--space-4); }
  .brand-mark { width: 44px; height: 44px; flex: none; }
  .brand-text { display: flex; flex-direction: column; }
  .brand-name { font-size: 1.3rem; font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; }
  .brand-sub { color: var(--ink-faint); font-size: .78rem; text-transform: uppercase; letter-spacing: .09em; }
  .signin { max-width: 24rem; margin: 8vh auto 0; }
  .signin h1 { font-size: 1.5rem; }
  .signin .sub { color: var(--ink-faint); margin-bottom: var(--space-5); }
  .signin button[type="submit"] { width: 100%; padding: .6rem; margin-top: var(--space-2); }
`;

export interface ConsolePageInput {
  title: string;
  /** Signed-out pages have no actor; the nav is then just a way back in. */
  actor: { identifier: string; displayName: string; organizationName: string; role?: string } | null;
  body: string;
  flash?: string | null;
  error?: string | null;
  /**
   * Lead with the product mark and name instead of the page's own `<h1>`.
   *
   * Only the sign-in page sets it: it is the one screen a person reaches without
   * having chosen the product, so the product has to introduce itself there.
   */
  brand?: boolean;
  /** The line under the product name when `brand` is set. */
  brandSub?: string;
}

/**
 * One page, wrapped.
 *
 * The nav is built here rather than by each page so a new console screen cannot
 * forget it, and so the set of screens is one list somebody can read.
 */
export function consolePage(input: ConsolePageInput): string {
  // The queue sits second because it is the one page an operator opens first, and the
  // posture summary sits last because it is the page that summarizes all the others.
  const nav = input.actor
    ? `<nav class="muted"><a href="${CONSOLE_PATHS.home}">Overview</a>` +
      `<a href="${CONSOLE_PATHS.alerts}">Alerts</a>` +
      `<a href="${CONSOLE_PATHS.mfa}">Second factor</a>` +
      `<a href="${CONSOLE_PATHS.policies}">Policies</a>` +
      `<a href="${CONSOLE_PATHS.directory}">Directories</a>` +
      `<a href="${CONSOLE_PATHS.reviews}">Access reviews</a>` +
      `<a href="${CONSOLE_PATHS.intel}">Threat intel</a>` +
      `<a href="${CONSOLE_PATHS.coverage}">Coverage</a>` +
      `<a href="${CONSOLE_PATHS.provisioning}">Provisioning</a>` +
      // Prevention is an administrator's surface, and the nav says so rather than offering
      // a page that would refuse on arrival: a link to a refusal is worse than no link.
      (input.actor.role === "ADMIN"
        ? `<a href="${CONSOLE_PATHS.enforcement}">Enforcement</a>`
        : "") +
      `<a href="${CONSOLE_PATHS.compliance}">Compliance</a>` +
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

  // The sign-in page introduces the product; every other page leads with its own
  // title, because the person is already inside and knows where they are.
  const heading = input.brand
    ? brandHead(input.brandSub ?? "security console")
    : `<h1>${escapeHtml(input.title)}</h1>`;

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
    `<body><div class="bar">${nav}${actions}</div><main>${heading}${who}` +
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

/**
 * A refusal, as a page rather than a stack trace.
 *
 * The paragraph below is the one place the console explains how it is reached, and it
 * exists because of a real confusion: an operator who reached `/console` without a live
 * cookie read "the console is reached with a browser session" as "you came in by the
 * wrong door". It has to say the opposite — that this page is the door, and that the way
 * through it is an email address, a password and an authenticator code.
 */
export function consoleErrorPage(message: string, status: number): { status: number; html: string } {
  /*
   * A session that is gone never reaches this page — it is bounced to the sign-in
   * form, with the cookie expired, so the sentence below cannot claim a credential
   * the browser did not present. What is left is a request that was understood and
   * refused, and the two kinds say different things.
   */
  const because =
    status === 403
      ? `Your session is valid, but this account is not allowed to do that. An administrator can change the ` +
        `role it holds, and nothing about the account or the sign-in has changed.`
      : `Sentinel <em>is</em> the Network's identity provider, so its console is the sign-in screen: the email ` +
        `address, the password and the authenticator code enrolled on the account are the way in.`;

  return {
    status,
    html: consolePage({
      title: status === 403 ? "Not allowed" : "Console could not continue",
      actor: null,
      body:
        `<p class="error" role="alert">${escapeHtml(message)}</p>` +
        `<p class="muted">${because}</p>` +
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
  /**
   * The provider door, when a deployment has one.
   *
   * `null` — not a disabled button — is the honest way to say "this console has no provider
   * configured": a greyed-out control that can never work is a question the page cannot
   * answer. The label is the deployment's, so the page can say *whose* SSO it is.
   */
  upstream: { path: string; label: string } | null;
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
    // The tab still says "Sign in · OnTrak Sentinel"; the page itself leads with the
    // mark and the name, because the product is what a person arriving cold needs to
    // recognise before they type a password.
    brand: true,
    brandSub: "security console",
    actor: null,
    body:
      `<div class="signin">` +
      `<p class="muted">OnTrak Sentinel is the identity provider for the Network: this console holds the ` +
      `identities, so this is the one place that checks a password itself.</p>` +
      (view.upstream
        ? `<p><a class="button" href="${escapeHtml(view.upstream.path)}">Sign in with ${escapeHtml(view.upstream.label)}</a></p>` +
          `<p class="hint muted">or sign in with the password for this console</p>`
        : "") +
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
/*  Policies                                                                  */
/* -------------------------------------------------------------------------- */

/** Seconds as somebody would say them out loud, for the prose beside a form. */
export function humanSeconds(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

export function policyScopeTitle(scope: PolicyScope): string {
  return scope === "ALL" ? "Baseline — everybody" : `${scope.charAt(0)}${scope.slice(1).toLowerCase()}s`;
}

/**
 * One card per scope: what is stored, what it resolves to, and the form that changes
 * it. Rendered rather than redirected-to-edit so the whole set of controls is visible
 * at once — a policy page that hid the others would make it easy to tighten one role
 * while forgetting the baseline underneath it.
 */
export function renderPolicies(view: ConsolePoliciesView, flash?: string | null, error?: string | null): string {
  const cards = view.policies
    .map((policy) => {
      const row = policy.stored;
      const shown = row ?? policy.effective;
      const state = row
        ? `<p class="flash">Stored here.</p>`
        : `<p class="muted">Not set: this scope inherits the baseline (or the built-in default).</p>`;
      const effectiveNote =
        policy.scope !== "ALL" && !row
          ? `<p class="muted">Effective now: ${policy.effective.requireMfa ? "a second factor is required" : "no second factor"}, ` +
            `session ${escapeHtml(humanSeconds(policy.effective.maxSessionSeconds))}, idle ${escapeHtml(humanSeconds(policy.effective.idleTimeoutSeconds))}.</p>`
          : "";

      return (
        `<div class="card">` +
        `<h3>${escapeHtml(policy.title)}</h3>` +
        `<p class="muted">Governs ${escapeHtml(policy.identities)} identit${policy.identities === 1 ? "y" : "ies"} today.</p>` +
        state +
        effectiveNote +
        `<form method="post" action="${CONSOLE_PATHS.policies}">` +
        `<input type="hidden" name="scope" value="${escapeHtml(policy.scope)}">` +
        `<p><label class="muted"><input type="checkbox" name="requireMfa" value="on"${shown.requireMfa ? " checked" : ""}> Require a second factor</label></p>` +
        `<p><label class="muted" for="max-${escapeHtml(policy.scope)}">Session lifetime, seconds</label> ` +
        `<input id="max-${escapeHtml(policy.scope)}" name="maxSessionSeconds" inputmode="numeric" value="${escapeHtml(shown.maxSessionSeconds)}"></p>` +
        `<p><label class="muted" for="idle-${escapeHtml(policy.scope)}">Idle timeout, seconds</label> ` +
        `<input id="idle-${escapeHtml(policy.scope)}" name="idleTimeoutSeconds" inputmode="numeric" value="${escapeHtml(shown.idleTimeoutSeconds)}"></p>` +
        `<button type="submit">Save ${escapeHtml(policy.title)}</button>` +
        (row ? `<p class="muted">Last changed ${escapeHtml(row.updatedAt)}.</p>` : "") +
        `</form></div>`
      );
    })
    .join("");

  const body =
    `<h2>Session policies</h2>` +
    `<p class="muted">A policy decides who may hold a session at all (whether a second factor is required) and how long that ` +
    `session may live. The <strong>baseline</strong> applies to everyone; a role card overrides it for that role only. ` +
    `A policy is asked when a session is granted <em>and</em> every time one is read, so tightening one takes effect on the ` +
    `next check — including on sessions that already exist. To cut somebody off right now, end their sessions as well.</p>` +
    cards +
    `<p class="muted">Every change is recorded on the organization's evidence chain as <code>policy.update</code>.</p>`;

  return consolePage({ title: "Policies", actor: view.actor, body, flash, error });
}

/** The scope list the page iterates, so the order is one thing rather than three. */
export function policyScopes(): readonly PolicyScope[] {
  return POLICY_SCOPES;
}

/* -------------------------------------------------------------------------- */
/*  Directories                                                               */
/* -------------------------------------------------------------------------- */

function optionList(values: readonly string[], selected: string): string {
  return values
    .map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`)
    .join("");
}

/**
 * `optionList` for a select whose values are not the words a person reads.
 *
 * The filter's owner select is the case: `MINE` and `NONE` are the query-string grammar, and
 * a queue that asked an operator to pick "NONE" would be asking them to guess.
 */
function labelledOptionList(options: readonly (readonly [string, string])[], selected: string): string {
  return options
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
}

export function renderDirectory(
  view: ConsoleDirectoryView,
  report: ConsoleSyncReportView | null,
  flash?: string | null,
  error?: string | null,
): string {
  const rows = view.connections.length
    ? `<table><thead><tr><th>Name</th><th>Source</th><th>Conflicts</th><th>Last sync</th><th></th></tr></thead><tbody>${view.connections
        .map(
          (connection) =>
            `<tr><td>${escapeHtml(connection.name)}</td><td class="muted">${escapeHtml(connection.source)}</td>` +
            `<td class="muted">${escapeHtml(connection.conflictPolicy)}</td>` +
            `<td class="muted">${connection.lastSyncedAt ? escapeHtml(connection.lastSyncedAt) : "never"}</td>` +
            `<td>` +
            `<form method="post" action="${CONSOLE_PATHS.directorySync}" style="display:inline">` +
            `<input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}">` +
            `<input type="hidden" name="dryRun" value="1">` +
            `<button type="submit">Preview</button></form> ` +
            `<form method="post" action="${CONSOLE_PATHS.directorySync}" style="display:inline">` +
            `<input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}">` +
            `<button type="submit">Sync now</button></form> ` +
            `<form method="post" action="${CONSOLE_PATHS.directoryRemove}" style="display:inline">` +
            `<input type="hidden" name="connectionId" value="${escapeHtml(connection.id)}">` +
            `<button type="submit">Remove</button></form>` +
            `</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No directory is connected. Sentinel can be pushed to over SCIM, or read one itself below.</p>`;

  const runRows = view.runs.length
    ? `<table><thead><tr><th>When</th><th>Status</th><th>What happened</th></tr></thead><tbody>${view.runs
        .map(
          (run) =>
            `<tr><td class="muted">${escapeHtml(run.startedAt)}</td>` +
            `<td class="${run.status === "COMPLETED" ? "muted" : "error"}">${escapeHtml(run.status)}</td>` +
            `<td class="muted">${escapeHtml(run.detail ?? "")}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">Nothing has been synced yet.</p>`;

  const reportCard = report
    ? `<div class="card"><h3>${report.dryRun ? "Preview — nothing was written" : "Sync finished"}</h3>` +
      `<p>${escapeHtml(report.connectionName)}: ${escapeHtml(report.detail)}</p>` +
      (report.changes.length
        ? `<table><thead><tr><th>Action</th><th>Detail</th></tr></thead><tbody>${report.changes
            .slice(0, 60)
            .map((change) => `<tr><td>${escapeHtml(change.action)}</td><td class="muted">${escapeHtml(change.detail)}</td></tr>`)
            .join("")}</tbody></table>`
        : `<p class="muted">Nothing to do: the directory and this organization already agree.</p>`) +
      (report.skipped.length
        ? `<h3>Skipped</h3><ul>${report.skipped.map((entry) => `<li class="muted">${escapeHtml(entry)}</li>`).join("")}</ul>`
        : "") +
      `</div>`
    : "";

  const form =
    view.sources.length > 0
      ? `<h2>Read a directory</h2>` +
        `<div class="card"><form method="post" action="${CONSOLE_PATHS.directoryConnect}">` +
        `<p><label class="muted" for="name">Name it</label> <input id="name" name="name" placeholder="Entra ID — production" required></p>` +
        `<p><label class="muted" for="source">Kind</label> <select id="source" name="source">${optionList(view.sources, view.sources[0])}</select></p>` +
        `<p><label class="muted" for="url">Users URL</label> <input id="url" name="url" placeholder="https://graph.microsoft.com/v1.0/users" required></p>` +
        `<p><label class="muted" for="nextKey">Next-page key</label> <input id="nextKey" name="nextKey" placeholder="@odata.nextLink"></p>` +
        `<p><label class="muted" for="auth">Credential</label> <select id="auth" name="auth">${optionList(["bearer", "clientCredentials", "none"], "bearer")}</select></p>` +
        `<p><label class="muted" for="clientId">Client id (client-credentials only)</label> <input id="clientId" name="clientId"></p>` +
        `<p><label class="muted" for="tokenUrl">Token URL (client-credentials only)</label> <input id="tokenUrl" name="tokenUrl"></p>` +
        `<p><label class="muted" for="scope">Scope (client-credentials only)</label> <input id="scope" name="scope" placeholder="https://graph.microsoft.com/.default"></p>` +
        `<p><label class="muted" for="secret">Secret</label> <input id="secret" name="secret" type="password" autocomplete="off"></p>` +
        `<p><label class="muted" for="conflictPolicy">When the two disagree</label> <select id="conflictPolicy" name="conflictPolicy">${optionList(["preferDirectory", "preferLocal"], "preferDirectory")}</select></p>` +
        `<p><label class="muted" for="defaultRole">Role for a new person</label> <select id="defaultRole" name="defaultRole">${optionList(["AGENT", "AUDITOR", "ADMIN"], "AGENT")}</select></p>` +
        `<button type="submit">Connect</button>` +
        `<p class="muted">The secret is stored so the reader can call the directory, and it is never shown again. ` +
        `A deployment that cares encrypts that column at rest.</p></form></div>`
      : `<h2>Read a directory</h2><p class="muted">This deployment has no directory reader configured, so there is ` +
        `nothing to connect to. A connector can still push people in over SCIM.</p>`;

  const body =
    form +
    `<h2>Connections</h2><div class="card">${rows}</div>` +
    reportCard +
    `<h2>Recent runs</h2><div class="card">${runRows}</div>` +
    `<p class="muted">A sync only ever switches somebody off when the directory says they are inactive by name; ` +
    `a person who disappears from the answer is left alone, because a partial answer is how a sync offboards a company.</p>`;

  return consolePage({ title: "Directories", actor: view.actor, body, flash, error });
}

/* -------------------------------------------------------------------------- */
/*  Access reviews (S2)                                                       */
/* -------------------------------------------------------------------------- */

/** How a scope reads to a person, in one line. */
function reviewScopeLabel(kind: string, value: string): string {
  if (kind === "GROUP") return value ? `group ${escapeHtml(value)}` : "a group";
  return "everybody";
}

/** A person, as a select option list. The id is the value; the name is what is read. */
function peopleOptions(people: readonly { id: string; name: string }[], selectedId?: string): string {
  return people
    .map((person) => `<option value="${escapeHtml(person.id)}"${person.id === selectedId ? " selected" : ""}>${escapeHtml(person.name)}</option>`)
    .join("");
}

/**
 * The access-review page.
 *
 * The page's job is to make the *distinction* the feature exists for visible: an
 * undecided item reads as undecided, an overdue review reads as overdue, and a closed
 * review keeps its count of what was never looked at. Everything else on it is the two
 * forms that open the next review and the next schedule.
 *
 * A decision that revokes access is offered *beside* one that keeps it rather than behind
 * a menu: “keep” and “revoke” are the two answers an attestation has, and hiding one of
 * them turns a two-second decision into a page nobody finishes. The service still carries
 * out the revocation properly, and refuses the record if it cannot.
 */
export function renderReviews(view: ConsoleReviewsView, flash?: string | null, error?: string | null): string {
  const stateClass = (state: string): string =>
    state === "OVERDUE" ? "sev-high" : state === "OPEN" ? "control-warn" : "muted";

  const reviewRows = view.reviews.length
    ? `<table><thead><tr><th>Review</th><th>Scope</th><th>State</th><th>Progress</th><th>Due</th></tr></thead><tbody>${view.reviews
        .map(
          (review) =>
            `<tr><td><a href="${CONSOLE_PATHS.reviews}?review=${encodeURIComponent(review.id)}">${escapeHtml(review.name)}</a></td>` +
            `<td class="muted">${reviewScopeLabel(review.scopeKind, review.scopeValue)}</td>` +
            `<td class="${stateClass(review.state)}">${escapeHtml(review.state)}</td>` +
            `<td class="muted">${review.progress.total} people: ${review.progress.kept} kept, ${review.progress.revoked} revoked, ` +
            `<strong>${review.progress.pending} undecided</strong></td>` +
            `<td class="muted">${escapeHtml(review.dueAt)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No access review has been opened yet. A directory says who exists; a review is how a named person says the access is still warranted.</p>`;

  const detail = view.open
    ? (() => {
        const { review, items, canAttest, canManage } = view.open;
        const openNow = review.state === "OPEN" || review.state === "OVERDUE";
        const itemRows = items.length
          ? `<table><thead><tr><th>Person</th><th>Access</th><th>Decision</th><th></th></tr></thead><tbody>${items
              .map((item) => {
                const decided =
                  item.decision === "PENDING"
                    ? `<span class="muted">not yet decided</span>`
                    : `<strong>${escapeHtml(item.decision)}</strong>` +
                      (item.decidedAt ? `<span class="muted"> · ${escapeHtml(item.decidedAt)}</span>` : "") +
                      (item.note ? `<br><span class="muted">${escapeHtml(item.note)}</span>` : "");
                const actions =
                  canAttest && openNow
                    ? `<form method="post" action="${CONSOLE_PATHS.reviewAttest}" style="display:inline">` +
                      `<input type="hidden" name="reviewId" value="${escapeHtml(review.id)}">` +
                      `<input type="hidden" name="identityId" value="${escapeHtml(item.identityId)}">` +
                      `<input type="hidden" name="decision" value="KEPT">` +
                      `<button type="submit">Keep</button></form> ` +
                      `<form method="post" action="${CONSOLE_PATHS.reviewAttest}" style="display:inline">` +
                      `<input type="hidden" name="reviewId" value="${escapeHtml(review.id)}">` +
                      `<input type="hidden" name="identityId" value="${escapeHtml(item.identityId)}">` +
                      `<input type="hidden" name="decision" value="REVOKED">` +
                      `<button type="submit" class="quiet">Revoke</button></form>`
                    : "";
                return (
                  `<tr><td>${escapeHtml(item.name)}<br><span class="muted">${escapeHtml(item.identifier)}</span></td>` +
                  `<td class="muted">${escapeHtml(item.role)}${item.active ? "" : " · deactivated"}</td>` +
                  `<td>${decided}</td><td>${actions}</td></tr>`
                );
              })
              .join("")}</tbody></table>`
          : `<p class="muted">This review has no items.</p>`;

        const controls = canManage && openNow
          ? `<form method="post" action="${CONSOLE_PATHS.reviewClose}" style="display:inline">` +
            `<input type="hidden" name="reviewId" value="${escapeHtml(review.id)}">` +
            `<button type="submit">Close review</button></form> ` +
            `<form method="post" action="${CONSOLE_PATHS.reviewCancel}" style="display:inline">` +
            `<input type="hidden" name="reviewId" value="${escapeHtml(review.id)}">` +
            `<button type="submit" class="quiet">Cancel</button></form>`
          : "";

        return (
          `<h2>${escapeHtml(review.name)}</h2><div class="card">` +
          `<p class="muted">${reviewScopeLabel(review.scopeKind, review.scopeValue)} · reviewer ${escapeHtml(review.reviewerName)} · ` +
          `due ${escapeHtml(review.dueAt)} · <span class="${stateClass(review.state)}">${escapeHtml(review.state)}</span></p>` +
          `<p>${review.progress.total} people: <strong>${review.progress.kept}</strong> kept, ` +
          `<strong>${review.progress.revoked}</strong> revoked, <strong>${review.progress.pending}</strong> never decided.</p>` +
          itemRows +
          (controls ? `<p>${controls}</p>` : "") +
          (openNow && !canAttest
            ? `<p class="muted">This review is answered by ${escapeHtml(review.reviewerName)}, or by an administrator.</p>`
            : "") +
          `</div>`
        );
      })()
    : "";

  const scheduleRows = view.schedules.length
    ? `<table><thead><tr><th>Schedule</th><th>Scope</th><th>Every</th><th>Next</th><th>State</th><th></th></tr></thead><tbody>${view.schedules
        .map(
          (schedule) =>
            `<tr><td>${escapeHtml(schedule.name)}<br><span class="muted">reviewer ${escapeHtml(schedule.reviewerName)}</span></td>` +
            `<td class="muted">${reviewScopeLabel(schedule.scopeKind, schedule.scopeValue)}</td>` +
            `<td class="muted">${schedule.intervalDays} day(s)</td>` +
            `<td class="muted">${escapeHtml(schedule.nextRunAt)}</td>` +
            `<td class="${schedule.enabled ? "muted" : "control-warn"}">${schedule.enabled ? "on" : "paused"}</td>` +
            `<td>` +
            `<form method="post" action="${CONSOLE_PATHS.reviewScheduleToggle}" style="display:inline">` +
            `<input type="hidden" name="scheduleId" value="${escapeHtml(schedule.id)}">` +
            `<input type="hidden" name="enabled" value="${schedule.enabled ? "0" : "1"}">` +
            `<button type="submit">${schedule.enabled ? "Pause" : "Resume"}</button></form> ` +
            `<form method="post" action="${CONSOLE_PATHS.reviewScheduleRemove}" style="display:inline">` +
            `<input type="hidden" name="scheduleId" value="${escapeHtml(schedule.id)}">` +
            `<button type="submit" class="quiet">Remove</button></form>` +
            `</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No recurring review. Turning one on means a tick in this deployment opens the next review for you.</p>`;

  // The two forms ask for the same three things, so the fields are built once with a
  // prefix that keeps every `id` unique — duplicated ids would make the second form's
  // labels point at the first form's inputs.
  const scopeFields = (prefix: string): string =>
    `<p><label class="muted" for="${prefix}scopeKind">Scope</label> <select id="${prefix}scopeKind" name="scopeKind">` +
    optionList(["ORGANIZATION", "GROUP"], "ORGANIZATION") +
    `</select></p>` +
    (view.groups.length
      ? `<p><label class="muted" for="${prefix}scopeValue">Group (group scope only)</label> <select id="${prefix}scopeValue" name="scopeValue">` +
        `<option value=""></option>${peopleOptions(view.groups)}</select></p>`
      : `<p class="muted">This deployment has no groups, so a review can only cover everybody.</p>`);

  const openForm = view.reviewers.length
    ? `<h2>Open a review</h2><div class="card"><form method="post" action="${CONSOLE_PATHS.reviewOpen}">` +
      `<p><label class="muted" for="oname">Name it</label> <input id="oname" name="name" placeholder="Quarterly — production access" required></p>` +
      scopeFields("") +
      `<p><label class="muted" for="oreviewer">Reviewer</label> <select id="oreviewer" name="reviewerId">${peopleOptions(view.reviewers)}</select></p>` +
      `<p><label class="muted" for="windowDays">Answer within</label> <input id="windowDays" name="windowDays" type="number" min="1" value="14"> days</p>` +
      `<button type="submit">Open review</button>` +
      `<p class="muted">The list is taken once, now: somebody hired tomorrow is the next review's problem, which is what <em>periodic</em> attestation means.</p>` +
      `</form></div>`
    : `<h2>Open a review</h2><p class="muted">There is nobody in this organization to review, so a review would attest to nothing.</p>`;

  const scheduleForm = view.reviewers.length
    ? `<h2>Schedule a recurring review</h2><div class="card"><form method="post" action="${CONSOLE_PATHS.reviewSchedule}">` +
      `<p><label class="muted" for="sname">Name it</label> <input id="sname" name="name" placeholder="Quarterly — service desk" required></p>` +
      scopeFields("s") +
      `<p><label class="muted" for="sreviewer">Reviewer</label> <select id="sreviewer" name="reviewerId">${peopleOptions(view.reviewers)}</select></p>` +
      `<p><label class="muted" for="intervalDays">Every</label> <input id="intervalDays" name="intervalDays" type="number" min="1" max="366" value="90"> days</p>` +
      `<button type="submit">Schedule</button>` +
      `<p class="muted">A schedule only opens reviews when this deployment's scheduler is running; until then a pause and a note are all it is.</p>` +
      `</form></div>`
    : "";

  const body =
    openForm +
    detail +
    `<h2>The register</h2><div class="card">${reviewRows}</div>` +
    scheduleForm +
    `<h2>Schedules</h2><div class="card">${scheduleRows}</div>`;

  return consolePage({ title: "Access reviews", actor: view.actor, body, flash, error });
}

/* -------------------------------------------------------------------------- */
/*  Threat intelligence                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The feed page.
 *
 * What it deliberately does *not* offer is a delete-everything or a "clear the feed" button.
 * Withdrawing one indicator is a named, audited decision — the row's own button says which
 * one — and a bulk erase is what a panicking operator reaches for at 03:00 and regrets at
 * 09:00. A feed that has turned out to be wrong can at least say which rows it withdrew.
 */
export function renderIntel(view: ConsoleIntelView, flash?: string | null, error?: string | null): string {
  const stats = view.stats;
  const feeds = Object.entries(stats.byFeed).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kinds = Object.entries(stats.byKind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const summary =
    `<div class="card"><p>${stats.total} indicator(s): <strong>${stats.active}</strong> usable now, ${stats.expired} expired. ` +
    (stats.withExpiry === 0
      ? `None carries an expiry date — an address is reassigned and a list nobody pruned reports the innocent for years.</p>`
      : `${stats.withExpiry} carr${stats.withExpiry === 1 ? "ies" : "y"} an expiry date.</p>`) +
    (feeds.length
      ? `<table><thead><tr><th>Feed</th><th>Usable</th></tr></thead><tbody>${feeds
          .map(([feed, count]) => `<tr><td>${escapeHtml(feed)}</td><td class="muted">${count}</td></tr>`)
          .join("")}</tbody></table>`
      : "") +
    (kinds.length
      ? `<p class="muted">${kinds.map(([kind, count]) => `${escapeHtml(kind)}: ${count}`).join(" · ")}</p>`
      : "") +
    `</div>`;

  const reportCard = view.report
    ? `<div class="card"><h3>Feed accepted</h3>` +
      `<p>${view.report.accepted} new indicator(s), ${view.report.updated} refreshed from a feed we already had.</p>` +
      (view.report.rejected.length
        ? `<h3>Refused</h3><ul>${view.report.rejected
            .slice(0, 40)
            .map((row) => `<li class="muted">${escapeHtml(row.value || "(empty)")} — ${escapeHtml(row.reason)}</li>`)
            .join("")}</ul>` +
          `<p class="muted">A row that will never match anything is worse than no row, because it reads as protection, ` +
          `so these were not stored.</p>`
        : `<p class="muted">Nothing was refused.</p>`) +
      `</div>`
    : "";

  const rows = view.indicators.length
    ? `<table><thead><tr><th>Kind</th><th>Value</th><th>Feed</th><th>Confidence</th><th>Severity</th><th>Expires</th><th></th></tr></thead><tbody>${view.indicators
        .map(
          (indicator) =>
            `<tr${indicator.active ? "" : ` class="muted"`}>` +
            `<td class="muted">${escapeHtml(indicator.kind)}</td>` +
            `<td><code>${escapeHtml(indicator.value)}</code></td>` +
            `<td class="muted">${escapeHtml(indicator.source)}</td>` +
            `<td class="muted">${indicator.confidence}</td>` +
            `<td class="muted">${escapeHtml(indicator.severity ?? "—")}</td>` +
            `<td class="muted">${indicator.expiresAt ? escapeHtml(indicator.expiresAt) : "never"}</td>` +
            `<td><form method="post" action="${CONSOLE_PATHS.intelWithdraw}" style="display:inline">` +
            `<input type="hidden" name="indicatorId" value="${escapeHtml(indicator.id)}">` +
            `<button type="submit" class="quiet">Withdraw</button></form></td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No indicator is in the list. A feed that has told us nothing cannot raise anything, ` +
      `which is the correct behaviour and an empty security posture.</p>`;

  const form =
    `<h2>Add indicators</h2><div class="card"><form method="post" action="${CONSOLE_PATHS.intelIngest}">` +
    `<p><label class="muted" for="source">Feed</label> ` +
    `<input id="source" name="source" placeholder="abuse-ch" required></p>` +
    `<p><label class="muted" for="rows">One indicator per line</label>` +
    `<textarea id="rows" name="rows" rows="9" spellcheck="false" placeholder="203.0.113.9&#10;*.bad.example | 80&#10;44d88612fea8a8f36de82e1278abb02f | 90 | CRITICAL&#10;# a comment line is skipped"></textarea></p>` +
    `<button type="submit">Add to the list</button>` +
    `<p class="muted">Fields are <code>value | confidence | severity | expires</code> and everything after the value is optional. ` +
    `Values are classified by shape (${INDICATOR_KINDS.join(", ")}); a <code>*.</code> prefix means the domain and anything ` +
    `under it, and anything else matches one host exactly. A bare date expires at the end of that day. ` +
    `Below confidence ${CONFIDENCE_FLOOR} a match annotates an alert instead of raising its severity.</p></form></div>`;

  const body =
    form +
    `<h2>What is watched</h2>` +
    summary +
    reportCard +
    `<h2>Indicators</h2><div class="card">${rows}</div>` +
    `<p class="muted">A match annotates a detection rather than raising one of its own: "this address is on a list" is ` +
    `not a claim that anything happened. What it does is change how an existing alert is judged, and the alert keeps the ` +
    `indicator, the feed and the confidence it was judged on — so an escalation can be reviewed after the feed is gone.</p>`;

  return consolePage({ title: "Threat intel", actor: view.actor, body, flash, error });
}

/* -------------------------------------------------------------------------- */
/*  Alerts: the Guard queue, and one alert's investigation                    */
/* -------------------------------------------------------------------------- */

/**
 * One alert, as the queue renders it.
 *
 * `severity` and `state` are the record's own values, and `escalated` is carried
 * separately from the severity so the page can say *why* something is CRITICAL without
 * re-deriving it: an alert that a feed raised and one whose rule fires at CRITICAL look the
 * same in a severity column and are not the same thing to review.
 */
export interface ConsoleAlertView {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  state: AlertState;
  sourceAddress: string | null;
  identityId: string | null;
  identityLabel: string | null;
  device: string | null;
  asset: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  note: string | null;
  /** Whoever is working it, or `null` for one nobody has picked up. */
  assigneeId: string | null;
  assigneeLabel: string | null;
  assignedAt: string | null;
  /** How many indicators the alert's evidence matched, escalations and annotations. */
  indicators: number;
  /** Whether a feed raised the severity its rule fired at. */
  escalated: boolean;
  /** Whole minutes since it was last seen, or `null` when it is closed. */
  waitingMinutes: number | null;
}

/**
 * One alert, opened.
 *
 * The three questions an operator asks next, each already answered by
 * `alert-triage-rules.ts`: what else is this (`related`), why is it this loud
 * (`escalation`), and what actually happened (`timeline`). The page's job is to lay them
 * out; none of the judgement lives here.
 */
export interface ConsoleAlertInvestigationView {
  subject: ConsoleAlertView;
  escalation: string | null;
  annotation: string | null;
  related: RelatedAlert[];
  timeline: AlertTimelineEntry[];
  actions: { canAcknowledge: boolean; canClose: boolean; canAssign: boolean };
  /**
   * Who this alert may be handed to.
   *
   * Built from `assignableIdentities`, so the picker offers exactly the people the service
   * will accept: a list assembled for the page would eventually offer a name the service
   * refuses, and the refusal would read as a bug in triage rather than as a rule.
   */
  assignable: AssignableIdentity[];
}

/**
 * The queue page.
 *
 * `alerts` is what the *filter* selected and `summary` describes *everything* the
 * organization has, deliberately: a header that counted only the rows below it would say
 * "3 open" on a deployment with ninety, which is the number an operator would then report
 * upward. One question each — "what is waiting?" and "how bad is it overall?" — so the two
 * numbers are allowed to disagree and the page says which is which.
 */
export interface ConsoleAlertsView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  filter: TriageFilter;
  summary: TriageSummary;
  alerts: ConsoleAlertView[];
  /** The alert `?alert=` named, or `null` on a plain read of the queue. */
  investigation: ConsoleAlertInvestigationView | null;
}

/** A severity, as a badge whose colour comes from the theme rather than from here. */
function severityBadge(severity: Severity): string {
  return `<span class="sev sev-${severity.toLowerCase()}">${escapeHtml(severity)}</span>`;
}

/**
 * The queue and, when one is open, the alert underneath it.
 *
 * The filter form is a `GET`, and that is the one difference from every other form in the
 * console: narrowing a list changes nothing, so it belongs in the address bar where it can
 * be bookmarked, shared and reflected in a browser's back button. Acknowledge and close stay
 * `POST`s, and they are why this page can safely be a `GET` at all.
 *
 * Closing asks for a reason and acknowledging does not, matching the service: one is "I have
 * seen this" and the other is "this is finished", and only the second is a claim somebody
 * will be asked to justify.
 */
export function renderAlerts(view: ConsoleAlertsView, flash?: string | null, error?: string | null): string {
  const filter = view.filter;
  const query = filterQuery(filter);
  const severityOptions = optionList(["ALL", ...ALERT_SEVERITIES], filter.severity);
  const stateOptions = optionList(["OPEN", "ALL", "NEW", "ACKNOWLEDGED", "CLOSED"], filter.state);
  // "Mine" is a value the filter carries rather than one it resolves, so it still reads back
  // as the thing the operator asked for after the page has rendered.
  const assigneeOptions = labelledOptionList(
    [
      [ASSIGNEE_ANY, "anyone"],
      [ASSIGNEE_MINE, "mine"],
      [ASSIGNEE_NONE, "unassigned"],
    ],
    filter.assignee,
  );

  const form =
    `<form method="get" action="${CONSOLE_PATHS.alerts}">` +
    `<p><label class="muted" for="state">Show</label> <select id="state" name="state">${stateOptions}</select> ` +
    // "exactly", because that is what the filter does: a select whose label promised "at
    // least" over an exact match would have an operator believing a CRITICAL was hidden
    // from a HIGH view.
    `<label class="muted" for="severity">severity</label> <select id="severity" name="severity">${severityOptions}</select> ` +
    `<label class="muted" for="assignee">owned by</label> <select id="assignee" name="assignee">${assigneeOptions}</select></p>` +
    `<p><label class="muted" for="search">Search</label> <input id="search" name="search" value="${escapeHtml(filter.search)}" placeholder="rule, address, asset, indicator"> ` +
    `<button type="submit">Apply</button> <a class="muted" href="${CONSOLE_PATHS.alerts}">Clear</a></p>` +
    (filter.identityId
      ? `<p class="muted">Narrowed to one identity: <code>${escapeHtml(filter.identityId)}</code></p>`
      : "") +
    (filter.address
      ? `<p class="muted">Narrowed to one address: <code>${escapeHtml(filter.address)}</code></p>`
      : "") +
    (filter.assignee !== ASSIGNEE_ANY && filter.assignee !== ASSIGNEE_MINE && filter.assignee !== ASSIGNEE_NONE
      ? `<p class="muted">Narrowed to one owner: <code>${escapeHtml(filter.assignee)}</code></p>`
      : "") +
    `</form>`;

  const summary = view.summary;
  const bySeverity = ALERT_SEVERITIES.map(
    (severity) => `${severityBadge(severity)} ${summary.bySeverity[severity]}`,
  ).join(" · ");

  const summaryCard =
    `<div class="card">` +
    `<p><strong>${summary.open}</strong> open of ${summary.total}: ${summary.new} new, ` +
    `${summary.acknowledged} acknowledged, ${summary.closed} closed.</p>` +
    `<p class="muted">${bySeverity}</p>` +
    `<p class="${summary.openHighOrCritical > 0 ? "error" : "flash"}"${summary.openHighOrCritical > 0 ? ` role="alert"` : ""}>` +
    `${summary.openHighOrCritical === 0
      ? "Nothing at HIGH or above is waiting."
      : `${summary.openHighOrCritical} open alert(s) are HIGH or CRITICAL — the number that should be zero at the end of a shift.`}</p>` +
    `<p class="muted">${summary.escalated} were raised by a feed rather than by the rule that fired` +
    (summary.oldestOpenAt ? ` · oldest open last seen ${escapeHtml(summary.oldestOpenAt)}` : "") +
    (summary.lastSeenAt ? ` · newest activity ${escapeHtml(summary.lastSeenAt)}` : "") +
    `</p>` +
    // The "whoever gets there first" problem, as a number. It is a muted line rather than an
    // alert-coloured one because an unowned alert is the normal state of a fresh queue; what
    // is worth seeing is that the number is not going down.
    `<p class="muted">` +
    (summary.unassigned === 0
      ? "Every open alert has an owner."
      : `${summary.assigned} open alert(s) have an owner; ${summary.unassigned} are waiting for one — one alert is worked by one person, and an unowned alert is one nobody is working.`) +
    `</p></div>`;

  const rows = view.alerts.length
    ? `<table><thead><tr><th>Severity</th><th>Rule</th><th>About</th><th>Owner</th><th>Last seen</th><th>Seen</th><th></th></tr></thead><tbody>${view.alerts
        .map((alert) => {
          const about = alert.identityLabel
            ? `${escapeHtml(alert.identityLabel)}${alert.sourceAddress ? ` <span class="muted">from ${escapeHtml(alert.sourceAddress)}</span>` : ""}`
            : alert.sourceAddress
              ? escapeHtml(alert.sourceAddress)
              : `<span class="muted">${alert.asset ? escapeHtml(alert.asset) : "unattributed"}</span>`;
          const waiting = alert.waitingMinutes === null ? "" : ` <span class="muted">(${alert.waitingMinutes}m)</span>`;
          return (
            `<tr>` +
            `<td>${severityBadge(alert.severity)}</td>` +
            `<td><a href="${CONSOLE_PATHS.alerts}?${escapeHtml(query)}&amp;alert=${escapeHtml(alert.id)}">${escapeHtml(alert.ruleName)}</a>` +
            (alert.escalated ? ` <span class="muted">· from a feed</span>` : "") +
            `<br><span class="muted">${escapeHtml(alert.state.toLowerCase())}${alert.note ? ` · ${escapeHtml(alert.note)}` : ""}</span></td>` +
            `<td class="muted">${about}${alert.asset ? `<br>${escapeHtml(alert.asset)}` : ""}</td>` +
            (alert.assigneeLabel
              ? `<td class="muted">${escapeHtml(alert.assigneeLabel)}${alert.assignedAt ? `<br>since ${escapeHtml(alert.assignedAt)}` : ""}</td>`
              : `<td class="muted">unassigned</td>`) +
            `<td class="muted">${escapeHtml(alert.lastSeenAt)}${waiting}</td>` +
            `<td class="muted">${escapeHtml(alert.occurrences)}${alert.indicators ? `<br>${alert.indicators} indicator(s)` : ""}</td>` +
            `<td>` +
            (alert.state === "NEW"
              ? `<form method="post" action="${CONSOLE_PATHS.alertAcknowledge}" style="display:inline">` +
                `<input type="hidden" name="alertId" value="${escapeHtml(alert.id)}">` +
                `<button type="submit" class="quiet">Acknowledge</button></form>`
              : "") +
            `</td></tr>`
          );
        })
        .join("")}</tbody></table>`
    : `<p class="muted">Nothing matches. A queue that is empty of open work is the state this page exists to reach.</p>`;

  const investigation = view.investigation ? renderInvestigation(view.investigation, query) : "";

  const body =
    form +
    `<h2>Where this organization stands</h2>` +
    summaryCard +
    investigation +
    `<h2>Waiting (${view.alerts.length})</h2><div class="card">${rows}</div>` +
    `<p class="muted">An alert is raised by a sensor's telemetry against a rule in the rulebook, and it is ` +
    `correlated to an identity when the address it came from held a session. A repeat refreshes the alert it ` +
    `belongs to rather than raising a second one, so a burst that is still arriving is one row.</p>`;

  return consolePage({ title: "Alerts", actor: view.actor, body, flash, error });
}

/** One alert, opened: what else it is part of, why it is this loud, and what happened. */
function renderInvestigation(view: ConsoleAlertInvestigationView, query: string): string {
  const subject = view.subject;
  const link = (id: string): string =>
    `<a href="${CONSOLE_PATHS.alerts}?${escapeHtml(query)}&amp;alert=${escapeHtml(id)}">open</a>`;

  const related = view.related.length
    ? `<table><thead><tr><th>Why</th><th>Rule</th><th>Severity</th><th>State</th><th>Last seen</th><th></th></tr></thead><tbody>${view.related
        .map(
          (alert) =>
            `<tr><td class="muted">same ${escapeHtml(alert.kind)} <code>${escapeHtml(alert.shared)}</code></td>` +
            `<td>${escapeHtml(alert.ruleName)}${alert.closer ? ` <span class="muted">· at least this loud</span>` : ""}</td>` +
            `<td>${severityBadge(alert.severity)}</td>` +
            `<td class="muted">${escapeHtml(alert.state.toLowerCase())}</td>` +
            `<td class="muted">${escapeHtml(alert.lastSeenAt)}</td>` +
            `<td>${link(alert.id)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="muted">Nothing open shares an identity, address, asset or device with this one. A lone alert is ` +
      `an alert; a cluster is an incident, and this one is not in a cluster.</p></div>`;

  const timeline = view.timeline.length
    ? `<table><thead><tr><th>When</th><th>What</th><th>Detail</th></tr></thead><tbody>${view.timeline
        .map(
          (entry) =>
            `<tr><td class="muted">${escapeHtml(entry.at)}</td><td>${escapeHtml(entry.title)}</td>` +
            `<td class="muted">${escapeHtml(entry.detail)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No evidence was kept on this alert.</p>`;

  const acknowledge = view.actions.canAcknowledge
    ? `<form method="post" action="${CONSOLE_PATHS.alertAcknowledge}">` +
      `<input type="hidden" name="alertId" value="${escapeHtml(subject.id)}">` +
      `<p><label class="muted" for="ack-note">Note <span class="hint">(optional)</span></label> ` +
      `<input id="ack-note" name="note" placeholder="Looking at this now"></p>` +
      `<button type="submit">Acknowledge</button>` +
      `<p class="muted">Acknowledging says somebody has seen it. It does not say it is finished, and it does not ` +
      `stop the alert being refreshed by a repeat.</p></form>`
    : `<p class="muted">Already acknowledged: it stays in the queue until somebody closes it with a reason.</p>`;

  const assignment = view.actions.canAssign
    ? `<form method="post" action="${CONSOLE_PATHS.alertAssign}">` +
      `<input type="hidden" name="alertId" value="${escapeHtml(subject.id)}">` +
      `<p><label class="muted" for="assignee">Give it to</label> ` +
      `<select id="assignee" name="assigneeId">${labelledOptionList(
        [["", subject.assigneeId ? "somebody else" : "choose somebody"], ...view.assignable.map((identity) => [identity.id, identity.label] as const)],
        "",
      )}</select> ` +
      `<button type="submit">Assign</button></p>` +
      `<p class="muted">An alert is worked by one person. The queue can be narrowed to what is yours, and the chain ` +
      `records who handed it to whom — which is the whole difference between one incident with an owner and two ` +
      `people acknowledging the same thing.</p></form>` +
      (subject.assigneeId
        ? `<form method="post" action="${CONSOLE_PATHS.alertUnassign}">` +
          `<input type="hidden" name="alertId" value="${escapeHtml(subject.id)}">` +
          `<button type="submit" class="quiet">Give it back to the queue</button>` +
          `<p class="muted">Unowned is a real state, and it is the one a shift should start from — not a ` +
          `name left on an alert nobody is working.</p></form>`
        : "")
    : `<p class="muted">This alert is closed: it is the record of who worked it, so there is nothing left to hand on.</p>`;

  const close = view.actions.canClose
    ? `<form method="post" action="${CONSOLE_PATHS.alertClose}">` +
      `<input type="hidden" name="alertId" value="${escapeHtml(subject.id)}">` +
      `<p><label class="muted" for="close-note">Why it is finished</label> ` +
      `<input id="close-note" name="note" required placeholder="Blocked at the edge; the host is rebuilt"></p>` +
      `<button type="submit">Close</button>` +
      `<p class="muted">A reason is required because an incident review asks this question, and a blank answer is not one.</p></form>`
    : `<p class="muted">This alert is closed, so there is nothing left to do to it.</p>`;

  return (
    `<h2>Investigating</h2>` +
    `<div class="card">` +
    `<h3>${severityBadge(subject.severity)} ${escapeHtml(subject.ruleName)}</h3>` +
    `<p class="muted">${escapeHtml(subject.ruleId)} · ${escapeHtml(subject.state.toLowerCase())} · ` +
    `${escapeHtml(subject.occurrences)} occurrence(s) · first seen ${escapeHtml(subject.firstSeenAt)} · ` +
    `last seen ${escapeHtml(subject.lastSeenAt)}` +
    (subject.waitingMinutes === null ? "" : ` · waiting ${subject.waitingMinutes}m`) +
    `</p>` +
    `<p class="muted">About ${
      subject.identityLabel
        ? `<strong>${escapeHtml(subject.identityLabel)}</strong>${subject.identityId ? ` <code>${escapeHtml(subject.identityId)}</code>` : ""}`
        : "no correlated identity"
    }${subject.sourceAddress ? ` · from <code>${escapeHtml(subject.sourceAddress)}</code>` : ""}` +
    `${subject.device ? ` · device ${escapeHtml(subject.device)}` : ""}` +
    `${subject.asset ? ` · asset ${escapeHtml(subject.asset)}` : ""}</p>` +
    `<p class="muted">${
      subject.assigneeLabel
        ? `Owner: <strong>${escapeHtml(subject.assigneeLabel)}</strong>${subject.assignedAt ? ` since ${escapeHtml(subject.assignedAt)}` : ""}`
        : "Owner: nobody yet"
    }</p>` +
    (subject.identityId
      ? `<p class="muted"><a href="${CONSOLE_PATHS.alerts}?${escapeHtml(
          filterQuery({ state: "OPEN", severity: "ALL", assignee: ASSIGNEE_ANY, identityId: subject.identityId, address: null, search: "" }),
        )}">Everything open about this identity</a></p>`
      : "") +
    (subject.sourceAddress
      ? `<p class="muted"><a href="${CONSOLE_PATHS.alerts}?${escapeHtml(
          filterQuery({ state: "OPEN", severity: "ALL", assignee: ASSIGNEE_ANY, identityId: null, address: subject.sourceAddress, search: "" }),
        )}">Everything open from this address</a></p>`
      : "") +
    // "Mine" is resolved by the browser's own cookie, not here: this link is the operator
    // asking for their own work, and the filter keeps that word rather than an id.
    `<p class="muted"><a href="${CONSOLE_PATHS.alerts}?${escapeHtml(
      filterQuery({ state: "OPEN", severity: "ALL", assignee: ASSIGNEE_MINE, identityId: null, address: null, search: "" }),
    )}">Everything open that is mine</a> · <a href="${CONSOLE_PATHS.alerts}?${escapeHtml(
      filterQuery({ state: "OPEN", severity: "ALL", assignee: ASSIGNEE_NONE, identityId: null, address: null, search: "" }),
    )}">everything open that nobody has picked up</a></p>` +
    (view.escalation ? `<p class="error" role="alert">Raised above its rule's own severity. ${escapeHtml(view.escalation)}</p>` : "") +
    (view.annotation ? `<p class="muted">${escapeHtml(view.annotation)}</p>` : "") +
    `<h3>What else is this</h3>` +
    related +
    `<h3>What happened</h3>` +
    `<div class="card">${timeline}</div>` +
    `<h3>What to do</h3>` +
    `<div class="card">${acknowledge}${assignment}${close}` +
    `<p class="muted">All three actions are recorded on the organization's evidence chain, against your identity.</p></div>` +
    `</div>`
  );
}

/* -------------------------------------------------------------------------- */
/*  Compliance posture                                                        */
/* -------------------------------------------------------------------------- */

/** How one control reads: satisfied, worth a look, or not in force. */
export type ControlState = "OK" | "WARN" | "FAIL";

export interface ComplianceControlView {
  /** What is being asserted, in the words of whoever has to sign it off. */
  control: string;
  state: ControlState;
  /** The number or the fact behind the state, so it can be checked rather than believed. */
  detail: string;
}

/** One policy scope, with the population it governs. */
export interface ComplianceRoleView {
  scope: string;
  title: string;
  identities: number;
  active: number;
  mfaEnrolled: number;
  requireMfa: boolean;
  maxSessionSeconds: number;
  idleTimeoutSeconds: number;
  /** False when the scope resolves through the baseline rather than a row of its own. */
  stored: boolean;
}

/**
 * The posture summary.
 *
 * Every number here is *read from the control it describes* — the policy table, the
 * directory, the alert queue, the audit chain — rather than computed from a second model of
 * the same thing. That is the point of the page: a reviewer asking "is MFA enforced?" should
 * be answered by the same rows the login path reads, and if the review and the enforcement
 * ever disagree, the page is being generated by the wrong code.
 *
 * The other thing it deliberately does is report an absence as an absence. A deployment with
 * no second factor enrolled anywhere gets a FAIL rather than a green tick with a footnote.
 */
export interface ConsoleComplianceView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  generatedAt: string;
  controls: ComplianceControlView[];
  roles: ComplianceRoleView[];
  identities: {
    total: number;
    humans: number;
    services: number;
    active: number;
    inactive: number;
    /** Identities with a factor on record, which is what a session policy reads. */
    mfaEnrolled: number;
  };
  /** `null` when this deployment runs no detection pipeline. */
  alerts: {
    total: number;
    open: number;
    new: number;
    openHighOrCritical: number;
    escalated: number;
    oldestOpenAt: string | null;
  } | null;
  /** `null` when the actor may not read the trail, rather than a false "verified". */
  chain: { ok: boolean; length: number; detail: string } | null;
  /** The policy table's state, and the number of rows an administrator has written. */
  policies: { stored: number; baselineStored: boolean; scopes: number };
}

/**
 * The posture page.
 *
 * Rendered as a table of assertions rather than a dashboard of charts, because the output
 * is meant to be printed, pasted into a ticket and signed. `generatedAt` is on it for the
 * same reason: a compliance page without a timestamp is a claim about no particular moment.
 */
export function renderCompliance(view: ConsoleComplianceView, flash?: string | null, error?: string | null): string {
  const controls = view.controls
    .map(
      (control) =>
        `<tr><td>${escapeHtml(control.control)}</td>` +
        `<td class="control-${control.state.toLowerCase()}">${escapeHtml(control.state)}</td>` +
        `<td class="muted">${escapeHtml(control.detail)}</td></tr>`,
    )
    .join("");

  const roles = view.roles
    .map(
      (role) =>
        `<tr><td>${escapeHtml(role.title)}${role.stored ? "" : ` <span class="muted">(inherited)</span>`}</td>` +
        `<td class="muted">${escapeHtml(role.identities)}</td>` +
        `<td class="muted">${escapeHtml(role.mfaEnrolled)} of ${escapeHtml(role.active)}</td>` +
        `<td class="muted">${role.requireMfa ? "required" : "not required"}</td>` +
        `<td class="muted">${escapeHtml(humanSeconds(role.maxSessionSeconds))} / idle ${escapeHtml(humanSeconds(role.idleTimeoutSeconds))}</td></tr>`,
    )
    .join("");

  const population =
    `<div class="card"><p>${view.identities.total} identities: ${view.identities.humans} people, ` +
    `${view.identities.services} services. ${view.identities.active} active, ${view.identities.inactive} switched off.</p>` +
    `<p class="muted">${view.identities.mfaEnrolled} have a second factor on record. ` +
    `${view.policies.stored} scope(s) have a stored policy; the baseline ${
      view.policies.baselineStored ? "has one" : "resolves to the built-in default"
    }.</p></div>`;

  const alertSummary = view.alerts
    ? `<div class="card"><p>${view.alerts.open} open of ${view.alerts.total} alert(s): ${view.alerts.new} new, ` +
      `${view.alerts.openHighOrCritical} at HIGH or above, ${view.alerts.escalated} raised by a feed.</p>` +
      `<p class="muted">${view.alerts.oldestOpenAt ? `Oldest open last seen ${escapeHtml(view.alerts.oldestOpenAt)}.` : "No open alert is waiting."}</p></div>`
    : `<p class="muted">This deployment runs no detection pipeline, so there is no alert backlog to report — ` +
      `which is an absence, not a clean queue.</p>`;

  const chain = view.chain
    ? `<p class="${view.chain.ok ? "flash" : "error"}"${view.chain.ok ? "" : ` role="alert"`}>${escapeHtml(view.chain.detail)} ` +
      `<span class="muted">(${escapeHtml(view.chain.length)} events)</span></p>`
    : `<p class="muted">Your role may not read the evidence trail, so this report cannot assert anything about it.</p>`;

  const body =
    `<h2>Controls in force</h2>` +
    `<div class="card"><table><thead><tr><th>Control</th><th></th><th>Evidence</th></tr></thead><tbody>${controls}</tbody></table></div>` +
    `<h2>Who and what is governed</h2>` +
    population +
    `<h2>Policy coverage</h2>` +
    `<div class="card"><table><thead><tr><th>Scope</th><th>Identities</th><th>Second factor</th><th>Required</th><th>Session</th></tr></thead><tbody>${roles}</tbody></table>` +
    `<p class="muted">A scope with no row of its own inherits the baseline, so the number shown is the one a ` +
    `sign-in would actually be judged by. Changing any of it is on <a href="${CONSOLE_PATHS.policies}">Policies</a>.</p></div>` +
    `<h2>Alert backlog</h2>` +
    alertSummary +
    `<h2>Evidence integrity</h2>` +
    chain +
    `<h2>Take it with you</h2>` +
    `<div class="card"><p><a href="${CONSOLE_PATHS.compliancePacket}" download>Download this posture as a signed packet</a></p>` +
    `<p class="muted">The file carries the controls, the coverage and the evidence anchor above, with a ` +
    `fingerprint of the posture and a signature over the whole document. It verifies with the deployment's ` +
    `key and nothing else — no account here, no session, no database — which is what makes it usable as ` +
    `evidence rather than as a screenshot. Its format is the one OnTrak Tix's incident packets use.</p></div>` +
    `<p class="muted">Generated ${escapeHtml(view.generatedAt)}. Every figure above is read from the same rows the ` +
    `product enforces: no control is reported as satisfied because a setting exists somewhere else.</p>`;

  return consolePage({ title: "Compliance", actor: view.actor, body, flash, error });
}

/* -------------------------------------------------------------------------- */
/*  Enforcement                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One enforcement action, as the register shows it.
 *
 * The same record the service stores, flattened for reading: the interesting columns are
 * *who asked*, *what it answers* and *how it ends*, because those are the three questions an
 * incident review asks about a block. `rollbackLabel` is the inverse the decision computed at
 * the moment of the decision, rendered rather than re-derived — so the page can say how an
 * action will be undone instead of implying one exists.
 */
export interface ConsoleEnforcementActionView {
  id: string;
  action: EnforcementActionKind;
  state: EnforcementState;
  targets: EnforcementTarget[];
  alertId: string;
  /** The rule behind the alert this answers, when the queue still knows it. */
  alertRuleName: string | null;
  reason: string;
  requestedByLabel: string;
  requestedByRole: string;
  approvedByLabel: string | null;
  appliedAt: string | null;
  expiresAt: string | null;
  liftedAt: string | null;
  liftedByLabel: string | null;
  liftReason: string | null;
  refusedReason: string | null;
  /** The inverse, as the decision computed it, for the row's “how it ends” column. */
  rollbackLabel: string | null;
  createdAt: string;
}

/**
 * Guard's prevention register (S4).
 *
 * Three lists rather than one, because the three are different questions: **in force** is
 * "what is blocked right now", **waiting** is "what needs a second pair of eyes", and the
 * history is "what was done and how it ended". The policy is on the page too, because the
 * rails a proposal will be judged by are the thing an operator needs before they propose —
 * a safe-list that is only visible after a refusal is one nobody learns from.
 */
export interface ConsoleEnforcementView {
  actor: ConsoleActor;
  session: ConsoleSessionView;
  generatedAt: string;
  policy: EnforcementPolicy;
  /** False until somebody writes one: the built-in default, shown as inherited. */
  policyStored: boolean;
  actions: ConsoleEnforcementActionView[];
  /** The open alerts an action may be proposed against — loudest first. */
  candidates: { id: string; ruleName: string; severity: Severity }[];
  /** The targets the policy refuses to enforce against. */
  protectedTargets: string[];
}

/**
 * The prevention page (S4).
 *
 * Read the order of it: what is **in force** comes first, because in an incident that is the
 * only question, and the propose form comes last, because proposing is the deliberate act and
 * the policy above it is what the proposal will be judged against.
 */
export function renderEnforcement(
  view: ConsoleEnforcementView,
  flash?: string | null,
  error?: string | null,
): string {
  const targetList = (targets: EnforcementTarget[]): string =>
    targets
      .map((target) => `${target.kind} ${target.value}${target.label ? ` (${target.label})` : ""}`)
      .join(", ");

  const source = (action: ConsoleEnforcementActionView): string =>
    `<span class="muted">answers ${escapeHtml(action.alertRuleName ?? action.alertId)}</span>`;

  const inForce = view.actions.filter((action) => action.state === "ACTIVE");
  const pending = view.actions.filter((action) => action.state === "PENDING");
  const history = view.actions.filter((action) => action.state === "LIFTED" || action.state === "REFUSED");

  const inForceRows = inForce.length
    ? inForce
        .map(
          (action) =>
            `<tr><td><strong class="sev">${escapeHtml(action.action)}</strong><br>` +
            `<span class="muted">${escapeHtml(targetList(action.targets))}</span></td>` +
            `<td>${escapeHtml(action.reason)}<br>${source(action)}</td>` +
            `<td>${escapeHtml(action.requestedByLabel)}<br><span class="muted">in force since ${escapeHtml(action.appliedAt ?? action.createdAt)}</span></td>` +
            `<td class="muted">${escapeHtml(action.approvedByLabel ?? action.requestedByLabel)}</td>` +
            `<td class="muted">${action.expiresAt ? `lifts itself ${escapeHtml(action.expiresAt)}` : "until lifted by hand"}</td>` +
            `<td><form method="post" action="${CONSOLE_PATHS.enforcementLift}">` +
            `<input type="hidden" name="actionId" value="${escapeHtml(action.id)}">` +
            `<input name="reason" placeholder="why now?">` +
            `<button type="submit">Lift</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="muted">Nothing is being enforced against right now.</td></tr>`;

  const pendingRows = pending.length
    ? pending
        .map(
          (action) =>
            `<tr><td><strong class="sev">${escapeHtml(action.action)}</strong><br>` +
            `<span class="muted">${escapeHtml(targetList(action.targets))}</span></td>` +
            `<td>${escapeHtml(action.reason)}<br>${source(action)}</td>` +
            `<td>${escapeHtml(action.requestedByLabel)} <span class="muted">(${escapeHtml(action.requestedByRole)})</span></td>` +
            `<td class="muted">waiting for a second administrator since ${escapeHtml(action.createdAt)}</td>` +
            `<td><form method="post" action="${CONSOLE_PATHS.enforcementApprove}">` +
            `<input type="hidden" name="actionId" value="${escapeHtml(action.id)}">` +
            `<button type="submit">Approve</button></form></td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">Nothing is waiting on approval.</td></tr>`;

  const historyRows = history.length
    ? history
        .map((action) => {
          const ending =
            action.state === "LIFTED"
              ? `<span class="muted">lifted ${escapeHtml(action.liftedAt ?? "")} by ${escapeHtml(action.liftedByLabel ?? "—")}` +
                `${action.liftReason ? ` — ${escapeHtml(action.liftReason)}` : ""}</span>`
              : `<span class="muted">refused — ${escapeHtml(action.refusedReason ?? "a rail said no")}</span>`;
          return (
            `<tr><td><strong class="sev">${escapeHtml(action.action)}</strong><br>` +
            `<span class="muted">${escapeHtml(targetList(action.targets))}</span></td>` +
            `<td>${escapeHtml(action.reason)}<br>${source(action)}</td>` +
            `<td>${escapeHtml(action.requestedByLabel)}</td>` +
            `<td>${escapeHtml(action.state)}<br>${ending}</td></tr>`
          );
        })
        .join("")
    : `<tr><td colspan="4" class="muted">No action has ended yet.</td></tr>`;

  const candidateOptions = view.candidates.length
    ? view.candidates
        .map(
          (candidate) =>
            `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.ruleName)} — ${escapeHtml(candidate.severity)}</option>`,
        )
        .join("")
    : `<option value="">No open alert is waiting</option>`;

  const protectedList = view.protectedTargets.length
    ? `<ul>${view.protectedTargets.map((entry) => `<li><code>${escapeHtml(entry)}</code></li>`).join("")}</ul>`
    : `<p class="muted">The safe-list is empty. That is a policy nobody has written yet, not a permission — ` +
      `name the addresses and ids this deployment must never enforce against.</p>`;

  const policyForm =
    `<form method="post" action="${CONSOLE_PATHS.enforcementPolicy}">` +
    `<label>Never enforce against (one CIDR, address or id per line)` +
    `<textarea name="protectedTargets" rows="4">${escapeHtml(view.policy.protectedTargets.join("\n"))}</textarea></label>` +
    `<label>Most targets one action may name<input name="maxTargets" type="number" min="1" value="${escapeHtml(view.policy.maxTargets)}"></label>` +
    `<label>Actions allowed in a rolling hour<input name="maxActionsPerHour" type="number" min="0" value="${escapeHtml(view.policy.maxActionsPerHour)}"></label>` +
    `<label>How long an action stands, in seconds (0 = until lifted by hand)` +
    `<input name="defaultTtlSeconds" type="number" min="0" value="${escapeHtml(view.policy.defaultTtlSeconds)}"></label>` +
    `<label class="check"><input type="checkbox" name="allowPermanent" value="1"${view.policy.allowPermanent ? " checked" : ""}> Allow an action that stands until lifted by hand</label>` +
    `<label class="check"><input type="checkbox" name="requireSecondApprover" value="1"${view.policy.requireSecondApprover ? " checked" : ""}> Require a second administrator to approve</label>` +
    `<button type="submit">Save the policy</button></form>`;

  const proposeForm =
    view.candidates.length === 0
      ? `<p class="muted">There is no open alert to answer, so nothing can be proposed. An enforcement action has to ` +
        `answer a detection — raise one on the <a href="${CONSOLE_PATHS.alerts}">Alerts</a> page first.</p>`
      : `<form method="post" action="${CONSOLE_PATHS.enforcementPropose}">` +
        `<label>Answer this alert<select name="alertId" required>${candidateOptions}</select></label>` +
        `<label>Action<select name="action">${ENFORCEMENT_ACTION_KINDS.map(
          (kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`,
        ).join("")}</select></label>` +
        `<label>Targets (one per line, “KIND value label” — a bare line is an address)` +
        `<textarea name="targets" rows="3" required placeholder="ADDRESS 203.0.113.7 scanner\nIDENTITY 8f3c…"></textarea></label>` +
        `<label>Why (the audit row is what somebody reads later)` +
        `<input name="reason" required maxlength="280" placeholder="e.g. credential stuffing from this address"></label>` +
        `<label class="check"><input type="checkbox" name="permanent" value="1"> Stand until lifted by hand (refused unless the policy allows it)</label>` +
        `<button type="submit">Propose</button></form>`;

  const body =
    `<p class="muted">Prevention is an administrator's action, and this is where it is taken and undone. ` +
    `Every proposal is judged against the policy below — the safe-list first and absolutely — and an ` +
    `action that is in force is a record here, not merely a call that was made.</p>` +
    `<h2>In force</h2>` +
    `<div class="card"><table><thead><tr><th>Action</th><th>Reason</th><th>Requested by</th><th>Approved by</th><th>Ends</th><th></th></tr></thead>` +
    `<tbody>${inForceRows}</tbody></table></div>` +
    `<h2>Waiting on a second administrator</h2>` +
    `<div class="card"><table><thead><tr><th>Action</th><th>Reason</th><th>Requested by</th><th>Since</th><th></th></tr></thead>` +
    `<tbody>${pendingRows}</tbody></table></div>` +
    `<h2>The policy, and what it protects</h2>` +
    `<div class="card"><p class="muted">${
      view.policyStored ? "This organization has written its own policy." : "No policy has been written for this organization, so the cautious built-in default is in force."
    }</p>${protectedList}${policyForm}</div>` +
    `<h2>Propose an action</h2>` +
    `<div class="card">${proposeForm}</div>` +
    `<h2>What has ended</h2>` +
    `<div class="card"><table><thead><tr><th>Action</th><th>Reason</th><th>Requested by</th><th>How it ended</th></tr></thead>` +
    `<tbody>${historyRows}</tbody></table></div>` +
    `<p class="muted">Generated ${escapeHtml(view.generatedAt)}. ${
      inForce.length === 0 && pending.length === 0
        ? "Nothing is in force and nothing is waiting."
        : `${inForce.length} action(s) in force, ${pending.length} waiting.`
    }</p>`;

  return consolePage({ title: "Enforcement", actor: view.actor, body, flash, error });
}

/* -------------------------------------------------------------------------- */
/*  Coverage                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The detection-coverage map (S3).
 *
 * The gaps come first because they are the answer: everything below them exists so a reader
 * can see *why* a name is in the gap list, and so an operator can tell "no rule reads this"
 * from "a rule reads it but is quiet". Nothing here is written by hand — the rulebook is the
 * input — which is what lets the page be trusted as a statement about the running build.
 */
export function renderCoverage(view: ConsoleCoverageView, flash?: string | null, error?: string | null): string {
  const report = view.report;

  const kindRows = report.kinds
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.kind)}</td>` +
        `<td class="${entry.covered ? "control-ok" : "control-fail"}">${entry.covered ? "read" : "nothing reads it"}</td>` +
        `<td class="muted">${entry.rules.length ? entry.rules.map((id) => escapeHtml(id)).join(", ") : "—"}</td></tr>`,
    )
    .join("");

  const sourceRows = report.sources
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.source)}</td><td class="muted">${escapeHtml(entry.kind)}</td>` +
        `<td class="${entry.covered ? "control-ok" : "control-fail"}">${entry.covered ? "read" : "blind"}</td>` +
        `<td class="muted">${entry.rules.length ? entry.rules.map((id) => escapeHtml(id)).join(", ") : "—"}</td></tr>`,
    )
    .join("");

  const ruleRows = report.rules
    .map(
      (rule) =>
        `<tr><td>${escapeHtml(rule.id)} <span class="muted">v${escapeHtml(rule.version)}</span></td>` +
        `<td>${escapeHtml(rule.name)}</td>` +
        `<td class="sev sev-${rule.severity.toLowerCase()}">${escapeHtml(rule.severity)}</td>` +
        `<td class="muted">${escapeHtml(rule.shape)}</td>` +
        `<td class="muted">${(rule.kinds.length ? rule.kinds : ["any kind"]).map((value) => escapeHtml(value)).join(", ")}` +
        `${rule.sources.length ? ` · ${rule.sources.map((value) => escapeHtml(value)).join(", ")}` : ""}</td></tr>`,
    )
    .join("");

  const gaps = report.gaps.length
    ? `<div class="card"><ul>${report.gaps
        .map(
          (gap) =>
            `<li><strong>${escapeHtml(gap.name)}</strong> <span class="muted">(${escapeHtml(gap.what)})</span> — ` +
            `${escapeHtml(gap.detail)}</li>`,
        )
        .join("")}</ul></div>`
    : `<p class="flash">Every declared kind and source is read by at least one rule.</p>`;

  const unreachable = report.unreachable.length
    ? `<h2>Rules that read nothing</h2>` +
      `<div class="card"><p class="muted">A rule that names a kind or source this build does not have would ` +
      `never see an event; it is listed here rather than left to look like coverage.</p><ul>${report.unreachable
        .map((entry) => `<li><strong>${escapeHtml(entry.id)}</strong> — ${escapeHtml(entry.detail)}</li>`)
        .join("")}</ul></div>`
    : "";

  const body =
    `<p class="muted">This is what detection <em>actually reads</em>, derived from the rules this deployment runs ` +
    `rather than from the sources it can accept. A source is “read” when a rule would look at an event from it — not ` +
    `because a collector is posting, and not because the name exists.</p>` +
    `<h2>Blind spots</h2>` +
    gaps +
    `<h2>By kind</h2>` +
    `<div class="card"><table><thead><tr><th>Kind</th><th></th><th>Rules</th></tr></thead><tbody>${kindRows}</tbody></table>` +
    `<p class="muted">The kind is the normalizer's, not the sender's: an event is filed by the kind its payload ` +
    `states, falling back to the kind its source implies. AUTH is never implied — a payload has to claim it.</p></div>` +
    `<h2>By source</h2>` +
    `<div class="card"><table><thead><tr><th>Source</th><th>Kind</th><th></th><th>Rules</th></tr></thead><tbody>${sourceRows}</tbody></table>` +
    `<p class="muted">Every source here is declared vocabulary. The ingest surface accepts a batch a collector posts ` +
    `(<code>POST /guard/v1/events</code>); no source has a streaming listener yet, so “read” is a statement about ` +
    `the rules, not about a feed being live.</p></div>` +
    unreachable +
    `<h2>The rulebook</h2>` +
    `<div class="card"><table><thead><tr><th>Rule</th><th>Name</th><th>Severity</th><th>Shape</th><th>Reads</th></tr></thead><tbody>${ruleRows}</tbody></table></div>` +
    `<p class="muted">Generated ${escapeHtml(view.generatedAt)} from the ${escapeHtml(report.rules.length)} rule(s) ` +
    `in this build. Adding a rule adds it here; nothing on this page is maintained by hand.</p>`;

  return consolePage({ title: "Coverage", actor: view.actor, body, flash, error });
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
