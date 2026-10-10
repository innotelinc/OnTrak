/**
 * The workload catalog: every operating system and application the lab can stand up.
 *
 * The TypeScript half of OnTrak-dev's `ontrak/catalog.py`. A catalog entry is a
 * *manifest*, never a binary: for freely redistributable media the manifest names a URL
 * `media.ts` can fetch, and for everything else — retail Windows, Office, anything
 * end-of-life — it declares `source: operator`, so the operator supplies it from their
 * own licensed store. That split is what keeps the repository publishable while still
 * describing the whole "Windows 95 to present" range.
 *
 * **The data is JSON here, and the loader does no I/O.** The lab read `catalog/*.yaml`;
 * this repository has no YAML parser and the port's decision (plan §3/C6) is that lab
 * data is JSON, so `src/lib/lab/data/catalog.json` holds the same four manifests keyed
 * by file name and this module takes them **already parsed**. `new Catalog({ "linux.yaml":
 * … })` — a caller that has the text parses it, and the port refuses a manifest that is
 * not a mapping rather than half-reading it.
 *
 * Two rules are the reason this module is not just a data file, and both are refusals:
 *
 * 1. **Validation catches a manifest that would fail later, in front of a student.**
 *    A container that names a WinRM automation level, a DOS-era device profile on a
 *    container, an operator-supplied entry with no filename for the media store to look
 *    up: each is a manifest error that would otherwise surface as a broken session.
 *    `validate()` returns **every** problem rather than throwing on the first, because
 *    the person reading it is fixing a file.
 *
 * 2. **The planner is pure.** `plan(entry, facts)` turns an entry plus what the host
 *    currently has into the fastest path that can actually be served, and it takes those
 *    facts as arguments: the CLI can print a plan with no Incus involved (the lab's own
 *    `--dry-run` habit) and the session manager can call it with live facts.
 *
 * One thing carried over from the Python *unchanged and worth naming*: `plan()` accepts
 * `poolReady` and `templateReady` and never reads them. The `warm-pool` and
 * `clone-template` strategies exist in the cost/label/rank tables and in `mergeOrder`,
 * but nothing in the Python's `plan()` ever returns them — the planner only picks
 * between `container-image`, `image-launch`, `build-image` and `unsupported`. The
 * signature is kept so callers pass what they already pass, and this note is here
 * because a reader who sees four facts accepted and two used will otherwise assume a
 * bug rather than a faithful port.
 *
 * Pure: no filesystem, no clock, no Incus.
 */

/* -------------------------------------------------------------------------- */
/*  Device profiles                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A named hardware profile.
 *
 * Guests from the DOS-based era cannot use VirtIO devices and need BIOS boot with IDE
 * disks and emulated NICs, so the profile is part of the entry rather than a global
 * setting — which is also why `validate()` refuses a DOS-era profile on a container.
 */
/**
 * A type alias rather than an interface, deliberately: `selection.ts` types a workload's
 * `profile` as `Record<string, unknown>`, and only an object *type alias* is assignable
 * to an index-signature type — an interface is not (it is open to declaration merging,
 * so TypeScript will not promise it has only the keys it declares). Keeping this an
 * alias is what lets a `CatalogEntry` be handed to `selection.choose()` with no cast.
 */
export type DeviceProfile = {
  label: string;
  description: string;
  devices: Record<string, Record<string, unknown>>;
  config: Record<string, string>;
  notes: string[];
};

export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  modern: {
    label: "Modern (UEFI, VirtIO, Secure Boot + TPM)",
    description: "Windows 11/Server 2016+, or any Linux VM image.",
    devices: {
      root: { type: "disk", options: { bus: "virtio-scsi", size: "48GiB" } },
      eth0: { type: "nic", options: { nictype: "virtio" } },
    },
    config: { "security.secureboot": "true" },
    notes: [],
  },
  "vista-era": {
    label: "Vista/7 era (BIOS, VirtIO, no Secure Boot)",
    description: "Windows Vista through 8.1: VirtIO drivers exist, Secure Boot does not.",
    devices: {
      root: { type: "disk", options: { bus: "virtio-scsi", size: "40GiB" } },
      eth0: { type: "nic", options: { nictype: "virtio" } },
    },
    config: { "security.secureboot": "false" },
    notes: ["Install VirtIO drivers from the virtio-win ISO during setup."],
  },
  "legacy-xp": {
    label: "XP/2003 era (BIOS, IDE disk, emulated NIC)",
    description: "Windows 2000/XP/2003: no native VirtIO; IDE + e1000 keep setup simple.",
    devices: {
      root: { type: "disk", options: { bus: "ide", size: "24GiB" } },
      eth0: { type: "nic", options: { nictype: "e1000" } },
    },
    config: {
      "security.secureboot": "false",
      "limits.memory": "2GiB",
    },
    notes: [
      "Raw QEMU arguments may be needed for some installers (see raw.qemu below).",
      "Enable Remote Desktop and Remote Assistance manually — WinRM exists from XP SP2 but " +
        "on-demand WS-Management setup is unreliable at this era.",
    ],
  },
  "legacy-9x": {
    label: "DOS-based era (95/98/ME: IDE, rtl8139, cirrus VGA)",
    description: "Windows 95/98/ME: no ACPI assumptions, no VirtIO, small RAM ceiling.",
    devices: {
      root: { type: "disk", options: { bus: "ide", size: "8GiB" } },
      eth0: { type: "nic", options: { nictype: "rtl8139" } },
    },
    config: {
      "security.secureboot": "false",
      "limits.memory": "512MiB",
      "limits.cpu": "1",
      // These guests predate ACPI; give them a chipset they understand.
      "raw.qemu": "-M pc -cpu pentium2 -vga cirrus -device AC97",
    },
    notes: [
      "No guest automation is possible: there is no WMI, PowerShell or agent. Grading is " +
        "instructor-observed or media-inspection, so mark such scenarios manual.",
      "Some installers need a floppy/CD-ROM switch during setup.",
    ],
  },
  "linux-vm": {
    label: "Linux VM",
    description: "Distro VM images (server or desktop).",
    devices: {
      root: { type: "disk", options: { bus: "virtio-scsi", size: "32GiB" } },
      eth0: { type: "nic", options: { nictype: "virtio" } },
    },
    config: {},
    notes: [],
  },
  "linux-container": {
    label: "Linux container",
    description: "System container: shares the host kernel, so it starts in about a second.",
    devices: {},
    config: {},
    notes: [
      "Kernel-level exercises (boot loaders, drivers, kernel modules) are out of scope " +
        "inside a container — pick a VM image for those.",
    ],
  },
};

/** The profile an entry gets when it does not name one, or names an unknown one. */
export const DEFAULT_DEVICE_PROFILE = "modern";

/** One profile by name, falling back to `modern` the way the Python's `.profile` did. */
export function deviceProfile(name: string): DeviceProfile {
  const found = DEVICE_PROFILES[name];
  const fallback = DEVICE_PROFILES[DEFAULT_DEVICE_PROFILE];
  if (found) return found;
  if (!fallback) throw new Error("the built-in device profiles are missing 'modern'");
  return fallback;
}

export const AUTOMATION_LEVELS: Record<string, string> = {
  none: "No guest automation: no PowerShell, no agent (DOS-based Windows).",
  "winrm-ps2": "Windows PowerShell 2.0 era: WinRM possible but enable it per image.",
  "winrm-ps51": "Windows PowerShell 5.1: full automation, what scenarios are written against.",
  agent: "Incus agent over virtio-vsock (no network dependency).",
  ssh: "SSH: Linux guests, automate with shell scenarios.",
};

export const VALID_KINDS = new Set(["vm", "container"]);
export const VALID_RECIPES = new Set(["iso-unattended", "image-alias", "container-image", "manual"]);

/** Raised when a manifest is missing, malformed or inconsistent. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers the messages need                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Python's `!r` for a string, which is what these messages were written with.
 *
 * Worth reproducing rather than approximating: an operator greps the lab's own
 * documentation for an error message, and `'win95'` and `"win95"` are different strings.
 */
function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Python's `sorted(set)` rendered as a list, for the same reason as `pyRepr`. */
function pyList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

function sortedNames(values: Iterable<string>): string[] {
  return [...values].sort(compareText);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function text(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/** One manifest, deep-merged over another — `defaults:` then the entry. */
function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key];
    out[key] = isRecord(value) && isRecord(current) ? deepMerge(current, value) : value;
  }
  return out;
}

/**
 * A size like `4GiB` as mebibytes, or `0` when it cannot be read.
 *
 * `MB` counts as 1 (not 1000) exactly as the Python does: this decides whether a memory
 * figure is *implausibly small*, and a manifest that says `512MB` means 512 MiB of guest
 * RAM in every operator's head.
 */
export function toMib(value: string): number {
  const upper = String(value).trim().toUpperCase();
  for (const [suffix, factor] of [
    ["GIB", 1024],
    ["MIB", 1],
    ["GB", 1000],
    ["MB", 1],
  ] as const) {
    if (upper.endsWith(suffix)) {
      const amount = Number.parseFloat(upper.slice(0, -suffix.length));
      return Number.isFinite(amount) ? Math.trunc(amount * factor) : 0;
    }
  }
  const amount = Number.parseInt(upper, 10);
  return Number.isFinite(amount) ? amount : 0;
}

/* -------------------------------------------------------------------------- */
/*  Model                                                                     */
/* -------------------------------------------------------------------------- */

/** Where an entry's installation media comes from. */
export class Media {
  source: string;
  kind: string;
  filename: string;
  url: string;
  sha256: string;
  notes: string;

  constructor(init: Partial<Omit<Media, "isFree" | "isImage">> = {}) {
    this.source = init.source ?? "operator";
    this.kind = init.kind ?? "iso";
    this.filename = init.filename ?? "";
    this.url = init.url ?? "";
    this.sha256 = init.sha256 ?? "";
    this.notes = init.notes ?? "";
  }

  get isFree(): boolean {
    return this.source === "free";
  }

  /** An Incus image alias rather than a file to fetch. */
  get isImage(): boolean {
    return this.kind === "image";
  }

  /**
   * Read one manifest's `media:` block.
   *
   * `sha256` is **lower-cased**, and that is load-bearing: the media store compares the
   * checksum byte for byte, so a manifest written in upper case would false-mismatch and
   * a good download would be deleted. The lab's own importer did this here, which is
   * where the port keeps it.
   */
  static fromDict(data: unknown): Media {
    const record = isRecord(data) ? data : {};
    return new Media({
      source: text(record.source, "operator"),
      kind: text(record.kind, "iso"),
      filename: text(record.filename),
      url: text(record.url),
      sha256: text(record.sha256).toLowerCase(),
      notes: text(record.notes),
    });
  }

  toDict(): Record<string, unknown> {
    return {
      source: this.source,
      kind: this.kind,
      filename: this.filename,
      url: this.url,
      sha256: this.sha256,
      notes: this.notes,
    };
  }
}

/** CPU, memory and disk an entry asks for. */
export class Resources {
  cpu: number;
  memory: string;
  disk: string;

  constructor(init: Partial<Resources> = {}) {
    this.cpu = init.cpu ?? 2;
    this.memory = init.memory ?? "4GiB";
    this.disk = init.disk ?? "48GiB";
  }

  static fromDict(data: unknown): Resources {
    const record = isRecord(data) ? data : {};
    const cpu = Number(record.cpu ?? 2);
    return new Resources({
      cpu: Number.isFinite(cpu) ? cpu : 2,
      memory: text(record.memory, "4GiB"),
      disk: text(record.disk, "48GiB"),
    });
  }

  get memoryMib(): number {
    return toMib(this.memory);
  }
}

/**
 * One catalog entry.
 *
 * A class rather than a bare object because the Python's properties (`label`,
 * `image_alias`, `recipe`, `profile`, `automated`) are read by the portal, the media
 * store and the planner, and because `selection.ts`'s `WorkloadFacts` is satisfied by
 * this shape as it stands — no adapter sits between the catalog and the thing that
 * assigns scenarios.
 */
export class CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly family: string;
  readonly kind: string;
  readonly released: string;
  /** `supported` | `extended` | `eol`, or empty when the manifest does not say. */
  readonly support: string;
  readonly edition: string;
  readonly media: Media;
  readonly install: Record<string, unknown>;
  readonly deviceProfile: string;
  readonly resources: Resources;
  readonly automation: string;
  readonly scenarioFamilies: string[];
  readonly requires: string[];
  readonly tags: string[];
  readonly notes: string;

  constructor(init: {
    id: string;
    name: string;
    group: string;
    family?: string;
    kind?: string;
    released?: string;
    support?: string;
    edition?: string;
    media?: Media;
    install?: Record<string, unknown>;
    deviceProfile?: string;
    resources?: Resources;
    automation?: string;
    scenarioFamilies?: readonly string[];
    requires?: readonly string[];
    tags?: readonly string[];
    notes?: string;
  }) {
    this.id = init.id;
    this.name = init.name;
    this.group = init.group;
    this.family = init.family ?? "windows";
    this.kind = init.kind ?? "vm";
    this.released = init.released ?? "";
    this.support = init.support ?? "";
    this.edition = init.edition ?? "";
    this.media = init.media ?? new Media();
    this.install = init.install ?? {};
    this.deviceProfile = init.deviceProfile ?? DEFAULT_DEVICE_PROFILE;
    this.resources = init.resources ?? new Resources();
    this.automation = init.automation ?? "winrm-ps51";
    this.scenarioFamilies = [...(init.scenarioFamilies ?? [])];
    this.requires = [...(init.requires ?? [])];
    this.tags = [...(init.tags ?? [])];
    this.notes = init.notes ?? "";
  }

  /** The hardware profile this entry uses, with its devices and config. */
  get profile(): DeviceProfile {
    return deviceProfile(this.deviceProfile);
  }

  get recipe(): string {
    return text(this.install.recipe, "manual");
  }

  /**
   * The Incus image alias for image-based entries.
   *
   * `install.alias` wins, and the media filename is the fallback — which is why an
   * image entry's `media.filename` is the alias rather than a file name.
   */
  get imageAlias(): string {
    const alias = this.install.alias;
    return alias ? String(alias) : this.media.filename;
  }

  get label(): string {
    return this.edition ? `${this.name} (${this.edition})` : this.name;
  }

  get automated(): boolean {
    return ["winrm-ps51", "winrm-ps2", "agent", "ssh"].includes(this.automation);
  }

  resolvedDevices(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, spec] of Object.entries(this.profile.devices ?? {})) out[name] = { ...spec };
    return out;
  }

  resolvedConfig(): Record<string, string> {
    return {
      ...(this.profile.config ?? {}),
      "limits.cpu": String(this.resources.cpu),
      "limits.memory": this.resources.memory,
    };
  }

  /**
   * Console/portal-facing view, in the Python's own keys.
   *
   * No media URLs: those can be signed, and this is the record the student's page reads.
   */
  toPublic(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      label: this.label,
      group: this.group,
      family: this.family,
      kind: this.kind,
      released: this.released,
      support: this.support,
      automation: this.automation,
      automated: this.automated,
      resources: { cpu: this.resources.cpu, memory: this.resources.memory, disk: this.resources.disk },
      device_profile: this.deviceProfile,
      scenario_families: [...this.scenarioFamilies],
      tags: [...this.tags],
      media: { source: this.media.source, kind: this.media.kind },
      notes: this.notes,
    };
  }
}

/** A catalog file's group: the heading its entries are listed under. */
export class CatalogGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly era: string;
  readonly entries: CatalogEntry[];

  constructor(init: {
    id: string;
    label: string;
    description?: string;
    era?: string;
    entries?: readonly CatalogEntry[];
  }) {
    this.id = init.id;
    this.label = init.label;
    this.description = init.description ?? "";
    this.era = init.era ?? "";
    this.entries = [...(init.entries ?? [])];
  }
}

/* -------------------------------------------------------------------------- */
/*  Provisioning plans                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Rough wall-clock costs, used to pick the fastest available path and to tell an
 * operator what they are waiting for. The order of preference is what matters: a warm
 * VM is instant, a container launch is near-instant, cloning a snapshot is tens of
 * seconds, and building an image is an operator task rather than a request path.
 */
export const STRATEGY_COST_SECONDS: Record<string, number> = {
  "warm-pool": 5,
  "container-image": 8,
  "clone-template": 45,
  "image-launch": 90,
  "build-image": 3600,
  unsupported: 0,
};

export const STRATEGY_LABELS: Record<string, string> = {
  "warm-pool": "Hand out an already-booted VM from the warm pool",
  "container-image": "Launch a system container from the image server",
  "clone-template": "Clone the scenario template's clean snapshot",
  "image-launch": "Create the guest from a published image, then inject the scenario",
  "build-image": "Build the guest image from media first (operator task)",
  unsupported: "Cannot be provisioned automatically",
};

export const STRATEGY_ORDER = [
  "warm-pool",
  "container-image",
  "clone-template",
  "image-launch",
  "build-image",
] as const;

/** How an entry would be provisioned, and what an operator has to do first. */
export class ProvisionPlan {
  readonly entryId: string;
  strategy: string;
  estimateSeconds: number;
  steps: string[];
  blockers: string[];
  notes: string[];

  constructor(init: {
    entryId: string;
    strategy?: string;
    estimateSeconds?: number;
    steps?: readonly string[];
    blockers?: readonly string[];
    notes?: readonly string[];
  }) {
    this.entryId = init.entryId;
    this.strategy = init.strategy ?? "unsupported";
    this.estimateSeconds = init.estimateSeconds ?? 0;
    this.steps = [...(init.steps ?? [])];
    this.blockers = [...(init.blockers ?? [])];
    this.notes = [...(init.notes ?? [])];
  }

  get label(): string {
    return STRATEGY_LABELS[this.strategy] ?? this.strategy;
  }

  get ready(): boolean {
    return this.strategy !== "unsupported";
  }

  get needsOperator(): boolean {
    return this.strategy === "build-image";
  }

  toDict(): Record<string, unknown> {
    return {
      entry_id: this.entryId,
      strategy: this.strategy,
      label: this.label,
      estimate_seconds: this.estimateSeconds,
      steps: [...this.steps],
      blockers: [...this.blockers],
      notes: [...this.notes],
      ready: this.ready,
      // Snake_case on the way out, like every other stored/emitted shape in this port.
      needs_operator: this.needsOperator,
    };
  }
}

/** What the host currently has, passed into the planner so it stays pure. */
export interface PlanFacts {
  /**
   * Accepted for the caller's benefit and **not read** — see the module note. Nothing in
   * `plan()` returns `warm-pool` or `clone-template`, so a fact about either changes no
   * answer today; the parameter is kept because every call site already passes it.
   */
  poolReady?: boolean;
  templateReady?: boolean;
  imageReady?: boolean;
  mediaReady?: boolean;
}

/** The filters `list()` understands, spelled as the Python's keyword arguments. */
export interface CatalogFilters {
  group?: string;
  family?: string;
  kind?: string;
  automation?: string;
  support?: string;
  device_profile?: string;
  /** Substring match, case-insensitive. */
  id?: string;
  /** Substring match, case-insensitive. */
  name?: string;
  automated?: boolean;
  tag?: string;
  scenario_family?: string;
  /** Group prefix, so `era: "windows"` catches every Windows group. */
  era?: string;
  max_memory_mib?: number;
  /** Only what can be provisioned with no operator work. */
  available?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Catalog                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The manifests, loaded and queried.
 *
 * Constructed with already-parsed manifests keyed by file name, so the loader has no I/O
 * and every validation rule is a pure function of data a test can write inline.
 */
export class Catalog {
  /** File name -> its manifest, exactly as the caller parsed it. */
  readonly manifests: Record<string, unknown>;
  private groups: Map<string, CatalogGroup> = new Map();
  private entries: Map<string, CatalogEntry> = new Map();
  private loaded = false;

  constructor(manifests: Record<string, unknown> = {}) {
    this.manifests = manifests;
  }

  /** Load the manifests and return every entry by id, reloading when asked. */
  load(force = false): Map<string, CatalogEntry> {
    if (this.loaded && !force) return this.entries;
    const groups = new Map<string, CatalogGroup>();
    const entries = new Map<string, CatalogEntry>();

    for (const name of Object.keys(this.manifests).sort(compareText)) {
      const group = this.loadFile(name, this.manifests[name]);
      if (groups.has(group.id)) {
        throw new CatalogError(`duplicate catalog group ${pyRepr(group.id)} (in ${name})`);
      }
      for (const entry of group.entries) {
        const existing = entries.get(entry.id);
        if (existing) {
          throw new CatalogError(
            `duplicate catalog entry id ${pyRepr(entry.id)} (${existing.group} and ${entry.group})`,
          );
        }
        entries.set(entry.id, entry);
      }
      groups.set(group.id, group);
    }

    this.groups = groups;
    this.entries = entries;
    this.loaded = true;
    return entries;
  }

  /** One manifest. The group id is its `group:` or, as in the Python, its file stem. */
  private loadFile(name: string, raw: unknown): CatalogGroup {
    if (!isRecord(raw)) throw new CatalogError(`${name}: top level must be a mapping`);
    const groupId = text(raw.group) || fileStem(name);
    const defaults = raw.defaults ?? {};
    if (!isRecord(defaults)) throw new CatalogError(`${name}: defaults must be a mapping`);

    const rawEntries = raw.entries ?? [];
    if (!Array.isArray(rawEntries)) throw new CatalogError(`${name}: entries must be a list`);
    const entries: CatalogEntry[] = [];
    for (const entry of rawEntries) {
      if (!isRecord(entry)) throw new CatalogError(`${name}: every entry must be a mapping`);
      entries.push(this.buildEntry(groupId, raw, deepMerge(defaults, entry), name));
    }

    return new CatalogGroup({
      id: groupId,
      label: text(raw.label) || titleCase(groupId.replace(/-/g, " ")),
      description: text(raw.description).trim(),
      era: text(raw.era),
      entries,
    });
  }

  private buildEntry(
    groupId: string,
    groupData: Record<string, unknown>,
    data: Record<string, unknown>,
    name: string,
  ): CatalogEntry {
    if (!text(data.id)) throw new CatalogError(`${name}: an entry is missing 'id'`);

    const install = isRecord(data.install) ? { ...data.install } : {};
    const media = Media.fromDict(data.media);
    // An image entry whose alias is declared under `install:` still needs a filename for
    // the media store to name it by, and the alias is the only sensible one.
    if ("alias" in install && media.kind === "image") {
      media.filename = media.filename || String(install.alias);
    }

    return new CatalogEntry({
      id: text(data.id),
      name: text(data.name) || text(data.id),
      group: groupId,
      family: text(data.family) || text(groupData.family, "windows"),
      kind: text(data.kind, "vm"),
      released: text(data.released),
      support: text(data.support),
      edition: text(data.edition),
      media,
      install,
      deviceProfile: text(data.device_profile, DEFAULT_DEVICE_PROFILE),
      resources: Resources.fromDict(data.resources),
      automation: text(data.automation, "winrm-ps51"),
      scenarioFamilies: stringList(data.scenario_families),
      requires: stringList(data.requires),
      tags: stringList(data.tags),
      notes: text(data.notes).trim(),
    });
  }

  /** One entry by id, or a refusal that says how to list them. */
  get(entryId: string): CatalogEntry {
    this.load();
    const found = this.entries.get(entryId);
    if (!found) {
      throw new CatalogError(
        `unknown catalog entry ${pyRepr(entryId)}; try \`ontrak catalog list\``,
      );
    }
    return found;
  }

  /** Entries in group order, then release, then name — filtered when asked. */
  list(filters: CatalogFilters = {}): CatalogEntry[] {
    this.load();
    const order = new Map<string, number>();
    let index = 0;
    for (const group of this.groups.keys()) order.set(group, index++);

    let rows = [...this.entries.values()];
    for (const [key, value] of Object.entries(filters)) {
      // The Python skipped falsy filters (`None`, `""`, `[]`, `False`), which is what
      // makes `list(automated=False)` mean "no filter" rather than "the manual ones".
      if (value === undefined || value === null || value === "" || value === false) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      rows = rows.filter((row) => matches(row, key, value));
    }
    rows.sort(
      (a, b) =>
        compareNumber(order.get(a.group) ?? 99, order.get(b.group) ?? 99) ||
        compareText(a.released, b.released) ||
        compareText(a.name, b.name),
    );
    return rows;
  }

  groupList(): CatalogGroup[] {
    this.load();
    return [...this.groups.values()];
  }

  /**
   * Every problem the manifests have, as text.
   *
   * A list rather than an exception, and every problem rather than the first: the person
   * reading it is editing a file and wants the whole list in one pass.
   */
  validate(): string[] {
    const problems: string[] = [];
    try {
      this.load(true);
    } catch (error) {
      if (error instanceof CatalogError) return [error.message];
      throw error;
    }

    for (const entry of this.entries.values()) {
      const prefix = `[${entry.id}]`;
      if (!VALID_KINDS.has(entry.kind)) {
        problems.push(`${prefix} kind must be vm or container (got ${pyRepr(entry.kind)})`);
      }
      if (!Object.hasOwn(DEVICE_PROFILES, entry.deviceProfile)) {
        problems.push(
          `${prefix} unknown device_profile ${pyRepr(entry.deviceProfile)}; ` +
            `known: ${sortedNames(Object.keys(DEVICE_PROFILES)).join(", ")}`,
        );
      }
      if (!VALID_RECIPES.has(entry.recipe)) {
        problems.push(
          `${prefix} install.recipe must be one of ${pyList(sortedNames(VALID_RECIPES))} ` +
            `(got ${pyRepr(entry.recipe)})`,
        );
      }
      if (!Object.hasOwn(AUTOMATION_LEVELS, entry.automation)) {
        problems.push(
          `${prefix} unknown automation level ${pyRepr(entry.automation)}; ` +
            `known: ${sortedNames(Object.keys(AUTOMATION_LEVELS)).join(", ")}`,
        );
      }
      if (entry.media.source !== "free" && entry.media.source !== "operator") {
        problems.push(`${prefix} media.source must be free or operator`);
      }
      if (!["iso", "image", "archive"].includes(entry.media.kind)) {
        problems.push(`${prefix} media.kind must be iso, image or archive`);
      }
      if (entry.resources.cpu < 1) problems.push(`${prefix} resources.cpu must be >= 1`);
      if (entry.resources.memoryMib < 128) {
        problems.push(`${prefix} resources.memory is implausibly small`);
      }

      if (entry.media.isFree && entry.media.kind !== "image" && !entry.media.url) {
        problems.push(`${prefix} free media must have a url (or kind: image)`);
      }
      if (entry.media.source === "operator" && !entry.media.filename) {
        problems.push(
          `${prefix} operator-supplied media must name a filename so the media store can look it up`,
        );
      }
      if (entry.recipe === "image-alias" && !entry.install.alias) {
        problems.push(`${prefix} install.recipe image-alias needs install.alias`);
      }
      if (entry.recipe === "container-image" && entry.kind !== "container") {
        problems.push(`${prefix} container-image recipe requires kind: container`);
      }
      if (entry.recipe === "iso-unattended" && !entry.install.builder) {
        problems.push(
          `${prefix} iso-unattended needs install.builder (how the ISO is turned into an image)`,
        );
      }
      if (
        entry.kind === "container" &&
        ["winrm-ps51", "winrm-ps2", "agent"].includes(entry.automation)
      ) {
        problems.push(
          `${prefix} a Linux container cannot be driven by ${entry.automation}; use ssh`,
        );
      }
      if (entry.deviceProfile === "legacy-9x" && entry.kind === "container") {
        problems.push(`${prefix} DOS-era profiles are VM-only`);
      }
      if (!entry.automated && !entry.notes) {
        problems.push(
          `${prefix} has automation ${pyRepr(entry.automation)} and no notes explaining how it is used`,
        );
      }
      for (const required of entry.requires) {
        if (!this.entries.has(required)) {
          problems.push(
            `${prefix} requires ${pyRepr(required)}, which is not in the catalog ` +
              "(a product entry must name the OS it is layered onto)",
          );
        }
      }
      if (
        entry.recipe === "iso-unattended" &&
        entry.install.builder === "incus-windows" &&
        entry.deviceProfile !== "modern"
      ) {
        problems.push(
          `${prefix} uses the incus-windows builder with device profile ` +
            `${pyRepr(entry.deviceProfile)}; that builder targets Secure Boot/TPM guests ` +
            "(use the answer-file builder for older releases)",
        );
      }
    }
    return problems;
  }

  /**
   * Pick the fastest viable provisioning path for an entry.
   *
   * Pure: the caller supplies what the host currently has, so the CLI can print a plan
   * without touching Incus and the session manager can call it with live facts.
   */
  plan(entry: CatalogEntry | string, facts: PlanFacts = {}): ProvisionPlan {
    const target = typeof entry === "string" ? this.get(entry) : entry;
    const plan = new ProvisionPlan({ entryId: target.id, strategy: "unsupported" });

    if (target.kind === "container") {
      plan.strategy = "container-image";
      plan.steps = [
        `incus launch ${target.imageAlias} <instance> -p default -p ${target.deviceProfile}`,
        "wait for cloud-init/the init system, then run the scenario setup script over SSH",
      ];
      plan.estimateSeconds = STRATEGY_COST_SECONDS["container-image"] ?? 0;
      if (target.recipe !== "container-image") {
        plan.blockers.push(
          `kind is container but install.recipe is ${pyRepr(target.recipe)}; expected container-image`,
        );
      }
      return plan;
    }

    if (target.media.kind === "image" || target.recipe === "image-alias") {
      plan.strategy = "image-launch";
      if (!facts.imageReady) {
        plan.blockers.push(
          `image alias ${pyRepr(target.imageAlias)} is not published yet; ` +
            "publish it once, or build it from media",
        );
      }
      plan.steps = [
        `incus init ${target.imageAlias} <template> --profile ${target.deviceProfile}`,
        "apply the profile's devices and config (legacy profiles differ: IDE disk, e1000 NIC)",
        "boot, run the scenario setup script, snapshot as clean",
      ];
      plan.estimateSeconds = STRATEGY_COST_SECONDS["image-launch"] ?? 0;
      return plan;
    }

    // An ISO that has to be turned into an image at least once.
    if (target.recipe === "iso-unattended") {
      if (!facts.mediaReady) {
        plan.blockers.push(
          "installation media is not in the media store; " +
            (target.media.isFree
              ? "run `ontrak media fetch` (freely redistributable)"
              : `place ${target.media.filename} in the media store from your licensed source`),
        );
      }
      if (!facts.imageReady) {
        plan.strategy = "build-image";
        plan.steps = [
          `ontrak media fetch ${target.id}   # or operator-supplied ${target.media.filename}`,
          `ontrak image build ${target.id}  # unattended install via ${text(target.install.builder)}`,
          `ontrak template build <scenario> --workload ${target.id}`,
        ];
        plan.estimateSeconds = STRATEGY_COST_SECONDS["build-image"] ?? 0;
        for (const note of target.profile.notes ?? []) plan.notes.push(note);
        return plan;
      }
      plan.strategy = "image-launch";
      plan.estimateSeconds = STRATEGY_COST_SECONDS["image-launch"] ?? 0;
      return plan;
    }

    plan.blockers.push(
      `recipe ${pyRepr(target.recipe)} cannot be automated; provision it by hand and publish the image`,
    );
    plan.notes.push(...(target.profile.notes ?? []));
    return plan;
  }

  /** Sort plans by the order requests would be served in (fastest first). */
  mergeOrder(plans: Iterable<ProvisionPlan>): ProvisionPlan[] {
    const rank = new Map<string, number>();
    STRATEGY_ORDER.forEach((name, index) => rank.set(name, index));
    return [...plans].sort(
      (a, b) =>
        compareNumber(rank.get(a.strategy) ?? 99, rank.get(b.strategy) ?? 99) ||
        compareNumber(a.estimateSeconds, b.estimateSeconds),
    );
  }
}

/**
 * Build a catalog from parsed manifests.
 *
 * The caller owns the reading: a test loads `src/lib/lab/data/catalog.json`, and a later
 * stage loads the same shape from wherever the deployment keeps it. There is deliberately
 * no `importImages` here — the Python's `import_images()` *writes* a YAML catalog file
 * from `incus image list`, and this port has no YAML writer (plan §3/C6). Regenerating
 * that group is a conversion step documented in the plan, not a method on this class.
 */
export function catalogFromManifests(manifests: Record<string, unknown>): Catalog {
  return new Catalog(manifests);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function fileStem(name: string): string {
  const withoutDirectory = name.split("/").pop() ?? name;
  return withoutDirectory.replace(/\.[^.]+$/, "");
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => (word ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function compareNumber(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * One filter, applied.
 *
 * `id` and `name` are substring matches because an operator types `win10` and means the
 * three Windows 10 releases; every other key is an equality test, which is what makes
 * `list(kind: "container")` a fact rather than a guess.
 */
function matches(entry: CatalogEntry, key: string, value: unknown): boolean {
  if (["group", "family", "kind", "automation", "support", "device_profile"].includes(key)) {
    const actual = String((entry as unknown as Record<string, unknown>)[key] ?? "");
    return actual === String(value);
  }
  if (key === "id" || key === "name") {
    const actual = String((entry as unknown as Record<string, unknown>)[key] ?? "");
    return actual.toLowerCase().includes(String(value).toLowerCase());
  }
  if (key === "automated") return entry.automated === Boolean(value);
  if (key === "tag") return entry.tags.includes(String(value));
  if (key === "scenario_family") return entry.scenarioFamilies.includes(String(value));
  if (key === "era") return entry.group.startsWith(String(value));
  if (key === "max_memory_mib") return entry.resources.memoryMib <= Number(value);
  if (key === "available") {
    // What can be provisioned with no operator work: free media, or a container the
    // image server already publishes.
    return entry.media.isFree || entry.recipe === "container-image";
  }
  return true;
}
