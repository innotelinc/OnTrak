/**
 * The availability rule, as pure functions.
 *
 * This is the part of `availability.ts` that answers a single question — *is
 * this scenario safe to hand a student right now?* — without touching the
 * database or any framework API. Keeping it dependency-free means the browser,
 * the server actions and `npm test` all evaluate the very same rule, and
 * `availability.ts` is left with just the queries that feed it.
 *
 * A scenario is offered to a student only when **all** of these hold:
 *
 *   1. the platform (Linux / Windows / Office) is switched on globally;
 *   2. the scenario is published;
 *   3. every *required* software dependency exists in the inventory, is
 *      enabled, and has a usable source — an uploaded package for UPLOAD, a
 *      download URL for URL, or nothing at all for INTERNAL simulations;
 *   4. a LICENSED package has an activation key on file and has not expired,
 *      and an EVALUATION package's trial window has not closed. OPEN packages
 *      never need a key and never expire.
 *
 * Licensing follows the vendor model:
 *
 *   | LicenseType | Needs a key? | Time limited? |
 *   | ----------- | ------------ | ------------- |
 *   | OPEN        | no           | no            |
 *   | EVALUATION  | no           | yes           |
 *   | LICENSED    | yes          | yes           |
 */

import type { Platform } from "./sim/types";
import {
  normalizeFidelity,
  satisfiesFidelity,
  type Fidelity,
  type SandboxAvailability,
} from "./sim/fidelity";

export type BlockerKind =
  | "platform"
  | "unpublished"
  | "software-disabled"
  | "software-missing"
  | "software-source"
  | "license-key"
  | "license-expired"
  | "sandbox";

export interface AvailabilityBlocker {
  kind: BlockerKind;
  message: string;
  softwareId?: string;
  softwareName?: string;
}

export interface Availability {
  available: boolean;
  blockers: AvailabilityBlocker[];
}

/** The slice of a `SoftwarePackage` row the rule actually reads. */
export interface PackageForAvailability {
  id: string;
  name: string;
  vendor?: string | null;
  version?: string | null;
  platform: Platform;
  source: "UPLOAD" | "URL" | "INTERNAL";
  sourceUrl?: string | null;
  uploadPath?: string | null;
  licenseType: "OPEN" | "EVALUATION" | "LICENSED";
  licenseKey?: string | null;
  licenseExpiresAt?: Date | null;
  enabled: boolean;
}

/** The slice of a scenario (with its dependency links) the rule reads. */
export interface ScenarioWithSoftware {
  id: string;
  platform: Platform;
  published: boolean;
  software: {
    required: boolean;
    softwarePackage: PackageForAvailability;
  }[];
  /** The fidelity the definition declares (v1.2); absent means simulated. */
  fidelity?: Fidelity;
}

export interface AvailabilityContext {
  /** Platforms switched off by an administrator. */
  disabledPlatforms: Set<Platform>;
  /**
   * The simulator sandbox this deployment has, if any. A scenario authored for a real shell
   * cannot be offered where there is no sandbox to run it in, and saying so is friendlier
   * than handing a student a scenario whose checks can never pass.
   */
  sandbox?: SandboxAvailability;
}

/** An empty context — every platform on — handy for tests and dry runs. */
export const ALL_PLATFORMS_ENABLED: AvailabilityContext = { disabledPlatforms: new Set() };

/** The default when a deployment names no sandbox at all. */
export const NO_SANDBOX: SandboxAvailability = {
  available: false,
  reason:
    "No simulator sandbox is configured on this deployment (set ONTRAK_SANDBOX_BACKEND), so a scenario that needs a real shell cannot be offered.",
};

/** Has this licence's window (if it has one) already closed? */
export function licenceExpired(pkg: Pick<PackageForAvailability, "licenseType" | "licenseExpiresAt">, now = Date.now()): boolean {
  // OPEN software is never time limited; LICENSED and EVALUATION both are.
  if (pkg.licenseType === "OPEN") return false;
  return pkg.licenseExpiresAt != null && pkg.licenseExpiresAt.getTime() < now;
}

/** Every reason a single package cannot be handed out, in report order. */
export function evaluatePackage(pkg: PackageForAvailability, now = Date.now()): AvailabilityBlocker[] {
  const blockers: AvailabilityBlocker[] = [];

  if (!pkg.enabled) {
    blockers.push({
      kind: "software-disabled",
      softwareId: pkg.id,
      softwareName: pkg.name,
      message: `${pkg.name} is disabled in the software inventory.`,
    });
  }

  if (pkg.source === "UPLOAD" && !pkg.uploadPath) {
    blockers.push({
      kind: "software-source",
      softwareId: pkg.id,
      softwareName: pkg.name,
      message: `${pkg.name} is marked as uploaded but no package file is present.`,
    });
  }

  if (pkg.source === "URL" && !pkg.sourceUrl) {
    blockers.push({
      kind: "software-source",
      softwareId: pkg.id,
      softwareName: pkg.name,
      message: `${pkg.name} is sourced from a download URL, but no URL is configured.`,
    });
  }

  // Only a LICENSED package needs a key stored before it can be used.
  if (pkg.licenseType === "LICENSED" && !pkg.licenseKey) {
    blockers.push({
      kind: "license-key",
      softwareId: pkg.id,
      softwareName: pkg.name,
      message: `${pkg.name} requires an activation key, and none has been stored.`,
    });
  }

  if (licenceExpired(pkg, now) && pkg.licenseExpiresAt) {
    const when = pkg.licenseExpiresAt.toISOString().slice(0, 10);
    blockers.push({
      kind: "license-expired",
      softwareId: pkg.id,
      softwareName: pkg.name,
      message:
        pkg.licenseType === "EVALUATION"
          ? `The ${pkg.name} evaluation period ended on ${when}.`
          : `The ${pkg.name} license expired on ${when}.`,
    });
  }

  return blockers;
}

export function evaluateScenario(
  scenario: ScenarioWithSoftware,
  context: AvailabilityContext,
  now = Date.now(),
): Availability {
  const blockers: AvailabilityBlocker[] = [];

  if (context.disabledPlatforms.has(scenario.platform)) {
    blockers.push({
      kind: "platform",
      message: `${platformLabel(scenario.platform)} simulations are currently switched off by the administrator.`,
    });
  }

  if (!scenario.published) {
    blockers.push({ kind: "unpublished", message: "This scenario has not been published yet." });
  }

  // Fidelity (v1.2). A scenario authored for a sandbox is *not* silently downgraded here —
  // the runtime does that, visibly, when an attempt is already open — because offering it
  // would mean a student spending their time on checks the sandbox was there to make
  // possible. An author who wants the scenario offered anywhere declares `simulated`.
  const fidelity = normalizeFidelity(scenario.fidelity);
  if (!satisfiesFidelity(fidelity, context.sandbox ?? NO_SANDBOX)) {
    blockers.push({
      kind: "sandbox",
      message: `This scenario is authored for a real shell in a sandbox. ${(context.sandbox ?? NO_SANDBOX).reason}`,
    });
  }

  for (const link of scenario.software) {
    // Optional dependencies annotate the ticket; only required ones gate it.
    if (!link.required) continue;
    blockers.push(...evaluatePackage(link.softwarePackage, now));
  }

  return { available: blockers.length === 0, blockers };
}

export function platformLabel(platform: Platform): string {
  switch (platform) {
    case "LINUX":
      return "Linux";
    case "WINDOWS":
      return "Windows";
    case "OFFICE":
      return "Office";
    default:
      return platform;
  }
}

/** Full equipment list for a scenario, annotated with per-item readiness. */
export function equipmentList(scenario: ScenarioWithSoftware, now = Date.now()) {
  return scenario.software.map((link) => {
    const blockers = evaluatePackage(link.softwarePackage, now);
    return {
      id: link.softwarePackage.id,
      name: link.softwarePackage.name,
      vendor: link.softwarePackage.vendor,
      version: link.softwarePackage.version,
      platform: link.softwarePackage.platform,
      source: link.softwarePackage.source,
      licenseType: link.softwarePackage.licenseType,
      enabled: link.softwarePackage.enabled,
      required: link.required,
      ready: blockers.length === 0,
      blockers,
    };
  });
}
