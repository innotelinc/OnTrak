/**
 * Connector marketplace rules (M6): a catalog a third-party integration is
 * installed from.
 *
 * M6 shipped four ways for the outside world to talk to the desk — signed
 * webhooks, Slack/Teams, the RMM monitoring connector and the versioned REST API.
 * Each was built where it was needed, which is right for the connectors we ship and
 * wrong for the one after them: a new connector meant new plumbing in a new place,
 * and no single answer to "what can talk to this desk?".
 *
 * This module is the pattern that ends that. **A connector is a manifest**, and
 * installing one is *data* rather than code. Six decisions carry it:
 *
 *  1. **The manifest is the whole contract.** Id, vendor, category, the
 *     capabilities it offers, and the fields it needs — everything the console
 *     renders and the service installs is declared once, so the two cannot disagree
 *     about what a connector is.
 *  2. **A first-party connector is catalogued, not installed here.** We already
 *     ship Slack, webhooks, RMM and the rest, each with its own console. Listing
 *     them here gives one answer to "what can talk to this desk?", and
 *     `managePath` says where to configure it — but they are deliberately *not*
 *     installable from this catalog, because a second place to set the same thing
 *     is two sources of truth. Only third-party connectors are installed.
 *  3. **A third-party connector is registered, not patched in.** `ConnectorRegistry`
 *     is the seam: a vendor (or a test) calls `register(manifest, handler)` and the
 *     connector is in the catalog. Registration is validated by the same rules the
 *     built-ins pass, so a malformed manifest is refused at the door rather than
 *     breaking a console later.
 *  4. **Config is validated against the manifest — including what is *not* there.**
 *     A required field that is blank is refused, and an unknown key is refused
 *     rather than silently dropped, because a form that quietly discards a setting
 *     somebody typed is a form that lies about what the connector will do.
 *  5. **A secret is a secret everywhere.** A field declared `secret` is masked in
 *     the console, and the service never writes config into the audit trail — the
 *     trail records *which* fields were set, never their values. An API key is a
 *     credential, and the chain is a document that leaves the building.
 *  6. **Capabilities are a closed set, and dispatch routes by capability.** "Tell
 *     the desk when a ticket is created" is `ticket.notify`; which connectors hear
 *     it is a query over enabled installations, not a list somebody maintains.
 *
 * Pure: no clock, no network, no Prisma. The registry holds handlers but never
 * calls one; dispatch lives in the service, so the routing can be tested with a fake.
 */

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

export const CONNECTOR_CATEGORIES = ["TELEMETRY", "NOTIFY", "MONITORING", "IDENTITY", "INTAKE", "EXPORT"] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export function connectorCategoryLabel(category: ConnectorCategory): string {
  switch (category) {
    case "TELEMETRY":
      return "Security telemetry";
    case "NOTIFY":
      return "Notifications";
    case "MONITORING":
      return "Monitoring";
    case "IDENTITY":
      return "Identity";
    case "INTAKE":
      return "Intake";
    case "EXPORT":
      return "Export";
  }
}

/**
 * What a connector can be asked to do.
 *
 * Closed, and deliberately small. A capability is the routing key: an event is
 * handed to the enabled connectors that declared it, so adding a string here and
 * nowhere else is what makes "who hears about a created ticket?" a query rather
 * than a code path.
 */
export const CONNECTOR_CAPABILITIES = [
  "alert.ingest",
  "ticket.notify",
  "monitoring.check",
  "identity.sync",
  "email.intake",
  "ticket.export",
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export function isConnectorCapability(value: string): value is ConnectorCapability {
  return (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);
}

export function connectorCapabilityLabel(capability: ConnectorCapability): string {
  switch (capability) {
    case "alert.ingest":
      return "Receive security alerts";
    case "ticket.notify":
      return "Hear about ticket events";
    case "monitoring.check":
      return "Report monitoring checks";
    case "identity.sync":
      return "Sync people with a directory";
    case "email.intake":
      return "Create tickets from email";
    case "ticket.export":
      return "Export desk records";
  }
}

/* -------------------------------------------------------------------------- */
/*  The manifest                                                              */
/* -------------------------------------------------------------------------- */

/** One setting a connector declares. `secret` decides masking and audit treatment. */
export interface ConnectorConfigField {
  key: string;
  label: string;
  required: boolean;
  /** A credential: masked on screen, and never written to the audit trail. */
  secret: boolean;
  hint?: string;
}

/** Everything the catalog, the console and the install path need to agree on. */
export interface ConnectorManifest {
  /** Stable machine key. Fixed once written — an installation names it forever. */
  id: string;
  name: string;
  vendor: string;
  category: ConnectorCategory;
  /** One sentence, printed on the catalog card. */
  summary: string;
  capabilities: readonly ConnectorCapability[];
  configFields: readonly ConnectorConfigField[];
  /** A path into `docs/`, for the connector's own page. */
  docsPath: string;
  /** False for a connector a deployment may install; true for the ones we ship. */
  builtin: boolean;
  /** Where a first-party connector is configured, or null when it is deployment config. */
  managePath: string | null;
}

const ID_MAX = 64;

function field(key: string, label: string, options: { required?: boolean; secret?: boolean; hint?: string } = {}): ConnectorConfigField {
  return { key, label, required: options.required ?? false, secret: options.secret ?? false, ...(options.hint ? { hint: options.hint } : {}) };
}

/**
 * The connectors this release ships, listed so the catalog answers the whole
 * question.
 *
 * They are not installable from here: each is configured on its own console
 * (`managePath`), and duplicating that into an installation row would be a second
 * source of truth for the same endpoint. The catalog's job for them is
 * discoverability — a reader sees *everything* that can talk to the desk, whether
 * it was configured here or not.
 */
export const BUILTIN_CONNECTORS: readonly ConnectorManifest[] = [
  {
    id: "signed-webhooks",
    name: "Signed webhooks",
    vendor: "Innotel",
    category: "NOTIFY",
    summary: "Signed JSON to an endpoint you register, with a delivery log and retries.",
    capabilities: ["ticket.notify"],
    configFields: [],
    docsPath: "docs/api.md",
    builtin: true,
    managePath: "/admin/integrations",
  },
  {
    id: "slack",
    name: "Slack",
    vendor: "Salesforce",
    category: "NOTIFY",
    summary: "Post ticket events to a Slack channel, escaped so a subject stays data.",
    capabilities: ["ticket.notify"],
    configFields: [],
    docsPath: "docs/api.md",
    builtin: true,
    managePath: "/admin/integrations",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    vendor: "Microsoft",
    category: "NOTIFY",
    summary: "Post ticket events to a Teams channel through its incoming webhook.",
    capabilities: ["ticket.notify"],
    configFields: [],
    docsPath: "docs/api.md",
    builtin: true,
    managePath: "/admin/integrations",
  },
  {
    id: "rmm-monitoring",
    name: "RMM / monitoring",
    vendor: "Innotel",
    category: "MONITORING",
    summary: "A failing check opens a ticket; its recovery walks the ticket closed.",
    capabilities: ["monitoring.check"],
    configFields: [],
    docsPath: "docs/api.md",
    builtin: true,
    managePath: "/admin/integrations",
  },
  {
    id: "security-telemetry",
    name: "Security telemetry",
    vendor: "Innotel",
    category: "TELEMETRY",
    summary: "Normalized IDS/IPS, SIEM and EDR alerts, deduped and promotable to tickets.",
    capabilities: ["alert.ingest"],
    configFields: [],
    docsPath: "docs/security-telemetry.md",
    builtin: true,
    managePath: "/security",
  },
  {
    id: "directory-scim",
    name: "Directory (SCIM)",
    vendor: "Innotel",
    category: "IDENTITY",
    summary: "Push desk people to the tenant's provider, and deprovision the leavers.",
    capabilities: ["identity.sync"],
    configFields: [],
    docsPath: "docs/identity.md",
    builtin: true,
    managePath: "/admin/identity",
  },
  {
    id: "email-intake",
    name: "Email intake",
    vendor: "Innotel",
    category: "INTAKE",
    summary: "Turn a message at the support address into a threaded ticket.",
    capabilities: ["email.intake"],
    configFields: [],
    docsPath: "docs/email-intake.md",
    builtin: true,
    managePath: null,
  },
  {
    id: "audit-export",
    name: "Audit evidence export",
    vendor: "Innotel",
    category: "EXPORT",
    summary: "A signed, tenant-wide export of the whole evidence trail.",
    capabilities: ["ticket.export"],
    configFields: [],
    docsPath: "docs/api.md",
    builtin: true,
    managePath: "/api/audit/packet",
  },
];

/* -------------------------------------------------------------------------- */
/*  Registration validation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a manifest cannot be registered, in a sentence each.
 *
 * Run on every manifest, built-in or third-party, because "the built-ins are fine"
 * is an assumption that is wrong the first time somebody edits one. An empty answer
 * means it is usable.
 */
export function manifestProblems(manifest: ConnectorManifest): string[] {
  const problems: string[] = [];

  const id = manifest.id.trim();
  if (!id) problems.push("A connector needs an id.");
  else if (id.length > ID_MAX) problems.push(`The id may be at most ${ID_MAX} characters.`);
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    problems.push(`The id “${manifest.id}” must be lowercase letters, digits and hyphens, and start with a letter or digit.`);
  }

  if (!manifest.name.trim()) problems.push("A connector needs a name.");
  if (!manifest.vendor.trim()) problems.push("A connector needs a vendor, so a reader knows who wrote it.");
  if (!manifest.summary.trim()) problems.push("A connector needs a one-line summary.");

  if (!(CONNECTOR_CATEGORIES as readonly string[]).includes(manifest.category)) {
    problems.push(`“${manifest.category}” is not a connector category.`);
  }

  if (manifest.capabilities.length === 0) {
    problems.push("A connector has to do something: at least one capability is required.");
  }
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    problems.push("The same capability is listed twice.");
  }
  for (const capability of manifest.capabilities) {
    if (!isConnectorCapability(capability)) {
      problems.push(`“${capability}” is not a capability the desk routes.`);
    }
  }

  const keys = new Set<string>();
  for (const configField of manifest.configFields) {
    const key = configField.key.trim();
    if (!key) problems.push("A config field needs a key.");
    else if (keys.has(key)) problems.push(`The config key “${key}” is declared twice.`);
    else keys.add(key);
    if (!configField.label.trim()) problems.push(`The config field “${configField.key}” needs a label.`);
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/*  Install validation                                                        */
/* -------------------------------------------------------------------------- */

export interface ConnectorIssue {
  field: string;
  message: string;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Whether this config would install the connector, and what is wrong if not.
 *
 * Two directions, both deliberate:
 *
 *  - **A required field that is blank is refused**, because a connector missing its
 *    endpoint is one that will fail silently at the first event, which is the
 *    failure this catalog exists to prevent.
 *  - **A key the manifest does not declare is refused, not dropped.** A form that
 *    accepts a setting and then discards it is worse than one that rejects it: the
 *    person believes the connector is configured, and it is not.
 */
export function validateInstallation(
  manifest: ConnectorManifest,
  config: Record<string, unknown>,
): ConnectorIssue[] {
  const issues: ConnectorIssue[] = [];
  const declared = new Set(manifest.configFields.map((field) => field.key));

  for (const key of Object.keys(config)) {
    if (!declared.has(key)) {
      issues.push({ field: key, message: `“${key}” is not a setting the ${manifest.name} connector has.` });
    }
  }

  for (const configField of manifest.configFields) {
    if (configField.required && asText(config[configField.key]) === "") {
      issues.push({ field: configField.key, message: `${configField.label} is required.` });
    }
  }

  return issues;
}

/** The placeholder shown where a secret was — never the secret itself. */
export const MASKED_VALUE = "••••••••";

/**
 * The config as it may be shown on a screen: secrets replaced with a placeholder,
 * blank values and undeclared keys omitted.
 *
 * A declared-but-blank field is left out rather than rendered as an empty box,
 * because an empty box reads as "set to nothing" when the truth is "not set".
 */
export function maskConfig(
  manifest: ConnectorManifest,
  config: Record<string, unknown>,
): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const configField of manifest.configFields) {
    const value = asText(config[configField.key]);
    if (value === "") continue;
    shown[configField.key] = configField.secret ? MASKED_VALUE : value;
  }
  return shown;
}

/** The config keys that hold a credential, so the audit trail can name them and no more. */
export function secretKeys(manifest: ConnectorManifest): string[] {
  return manifest.configFields.filter((field) => field.secret).map((field) => field.key);
}

/**
 * A config safe to put on the audit chain: the keys that were set, never a value.
 *
 * `secret` alone is not enough of a rule — a base URL can be sensitive too, and a
 * chain entry is a document that outlives the deployment. So the record is
 * `{ fields: [...], secrets: [...] }`: enough to answer "was it configured?" and
 * nothing that would make the evidence trail a place a credential leaks from.
 */
export function auditConfigSummary(
  manifest: ConnectorManifest,
  config: Record<string, unknown>,
): { fields: string[]; secrets: string[] } {
  const set = manifest.configFields
    .filter((field) => asText(config[field.key]) !== "")
    .map((field) => field.key);
  return { fields: set, secrets: secretKeys(manifest) };
}

/* -------------------------------------------------------------------------- */
/*  An installation                                                           */
/* -------------------------------------------------------------------------- */

export interface ConnectorInstallationRecord {
  id: string;
  tenantId: string;
  connectorId: string;
  /** The values as written; secrets are stored here and masked everywhere else. */
  config: Record<string, string>;
  enabled: boolean;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

/**
 * The connectors an event goes to: the enabled installations whose connector
 * declares the capability.
 *
 * An installation whose connector is not in the catalog is skipped — the catalog is
 * the authority on what a connector can do, and a row pointing at a manifest nobody
 * registered cannot be routed. Disabled installations ask for nothing.
 */
export function installationsForCapability(
  installations: readonly ConnectorInstallationRecord[],
  catalog: (id: string) => ConnectorManifest | null,
  capability: ConnectorCapability,
): ConnectorInstallationRecord[] {
  return installations.filter((installation) => {
    if (!installation.enabled) return false;
    const manifest = catalog(installation.connectorId);
    return manifest !== null && (manifest.capabilities as readonly string[]).includes(capability);
  });
}

/* -------------------------------------------------------------------------- */
/*  The registry — the marketplace seam                                       */
/* -------------------------------------------------------------------------- */

/** What a handler is handed: the event, and whose installation is receiving it. */
export interface ConnectorDispatchContext {
  tenantId: string;
  installation: ConnectorInstallationRecord;
  at: string;
}

/** What a handler reports back. A handler never throws — it returns an outcome. */
export interface ConnectorDispatchOutcome {
  ok: boolean;
  detail?: string;
  error?: string;
}

export type ConnectorHandler = (
  payload: unknown,
  context: ConnectorDispatchContext,
) => Promise<ConnectorDispatchOutcome>;

/**
 * The catalog plus the handlers behind it.
 *
 * Registration is the one write, and it is validated by `manifestProblems` before
 * anything is stored, so a broken manifest is refused at the door. A built-in id
 * cannot be re-registered from outside: the connectors we ship are the product's,
 * and letting a plugin shadow `signed-webhooks` would make the catalog lie about
 * what that id means.
 *
 * The registry holds handlers but never calls one on its own — routing is the
 * service's job, so the *decision* about who hears an event is testable without a
 * handler that does anything.
 */
export class ConnectorRegistry {
  private readonly manifests = new Map<string, ConnectorManifest>();
  private readonly handlers = new Map<string, ConnectorHandler>();

  constructor(manifests: readonly ConnectorManifest[] = BUILTIN_CONNECTORS) {
    for (const manifest of manifests) {
      this.manifests.set(manifest.id, manifest);
    }
  }

  /**
   * Add a third-party connector. Returns the problems (empty on success).
   *
   * Idempotent in the only direction that is safe: registering the same id twice is
   * refused rather than replacing, because a silent replace is how one connector
   * impersonates another.
   */
  register(manifest: ConnectorManifest, handler?: ConnectorHandler): string[] {
    const problems = manifestProblems(manifest);
    if (problems.length > 0) return problems;
    if (this.manifests.has(manifest.id)) return [`“${manifest.id}” is already in the catalog.`];
    this.manifests.set(manifest.id, manifest);
    if (handler) this.handlers.set(manifest.id, handler);
    return [];
  }

  get(id: string): ConnectorManifest | null {
    return this.manifests.get(id) ?? null;
  }

  handler(id: string): ConnectorHandler | null {
    return this.handlers.get(id) ?? null;
  }

  /** The catalog, first-party connectors first, then by name. */
  list(): ConnectorManifest[] {
    return [...this.manifests.values()].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  get size(): number {
    return this.manifests.size;
  }
}
