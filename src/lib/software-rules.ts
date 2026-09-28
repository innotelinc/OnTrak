/**
 * The software-inventory form, as pure functions.
 *
 * Administrators stock the lab by hand, so the form has several independent
 * choices that must agree with each other:
 *
 *   - the **source** decides what payload is required (UPLOAD needs a file, URL
 *     needs a link, INTERNAL needs nothing);
 *   - the **license type** decides whether a key is needed at all;
 *   - the **expiry** is an optional date.
 *
 * Keeping the parsing here — rather than inline in `createSoftware` /
 * `updateSoftware` — lets those rules be pinned by a unit test.
 */

import type { LicenseType, Platform, SoftwareSource } from "@prisma/client";
import { parseDateInput } from "./form-rules";

export const PLATFORM_VALUES: readonly Platform[] = ["LINUX", "WINDOWS", "OFFICE"];
export const SOURCE_VALUES: readonly SoftwareSource[] = ["UPLOAD", "URL", "INTERNAL"];
export const LICENSE_VALUES: readonly LicenseType[] = ["OPEN", "EVALUATION", "LICENSED"];

/** The bullet used when a stored key is rendered back into the form. */
export const MASK_CHARACTER = "•";

/**
 * Was this key value produced by `maskKey`? A masked value means "the admin
 * left the field as-is", so the stored key must be preserved rather than
 * overwritten with bullets.
 */
export function isMaskedKey(value: string | null | undefined): boolean {
  return Boolean(value && value.includes(MASK_CHARACTER));
}

/**
 * Does the chosen source have the payload it needs?
 *
 * The two software actions (create and update) stock the same inventory from
 * the same form, so "URL needs a link, UPLOAD needs a file" lives here rather
 * than being spelled out twice — the update action used to skip the check
 * entirely, which could leave a package that can never be handed out.
 *
 * `hasFile` is true when a file was supplied *or* one is already stored.
 * Returns a message to flash back, or `null` when the package is ready.
 */
export function softwareSourceProblem(
  source: SoftwareSource,
  sourceUrl: string | null,
  hasFile: boolean,
): string | null {
  if (source === "URL") {
    return sourceUrl ? null : "A download URL is required when the source is URL.";
  }
  if (source === "UPLOAD") {
    return hasFile ? null : "Choose a file to upload, or switch the source to Internal.";
  }
  return null;
}

/**
 * Which licence key an edit should actually store.
 *
 * The edit form renders the stored key as bullets, so a submitted value that
 * still contains the mask means "leave it alone". Writing that value through
 * would replace a real key with bullets and break every scenario that depends
 * on the package, so a masked field always keeps what is already stored.
 */
export function resolveStoredKey(
  fieldValue: string | null | undefined,
  storedKey: string | null | undefined,
): string | null {
  if (isMaskedKey(fieldValue)) return storedKey ?? null;
  return fieldValue ?? null;
}

export interface SoftwareFields {
  name: string;
  vendor: string | null;
  version: string | null;
  flavour: string | null;
  description: string | null;
  platform: Platform;
  source: SoftwareSource;
  sourceUrl: string | null;
  licenseType: LicenseType;
  licenseKey: string | null;
  licenseSeats: number | null;
  licenseExpiresAt: Date | null;
  enabled: boolean;
  /** True only for LICENSED packages; kept denormalised on the row. */
  requiresKey: boolean;
}

export type SoftwareFieldsResult =
  | { ok: true; fields: SoftwareFields }
  | { ok: false; reason: string };

function trimmed(formData: FormData, key: string): string | null {
  return String(formData.get(key) ?? "").trim() || null;
}

/**
 * Read the inventory form. Unknown enum values fall back to the safe defaults
 * (Linux / Internal / Open) rather than reaching the database, a non-positive
 * seat count is dropped, and a malformed expiry is an error the caller flashes.
 */
export function parseSoftwareForm(formData: FormData): SoftwareFieldsResult {
  const expiry = parseDateInput(formData.get("licenseExpiresAt"));
  if (!expiry.ok) return { ok: false, reason: expiry.reason };

  const rawPlatform = String(formData.get("platform") ?? "");
  const rawSource = String(formData.get("source") ?? "");
  const rawLicense = String(formData.get("licenseType") ?? "");

  const platform = (PLATFORM_VALUES as readonly string[]).includes(rawPlatform)
    ? (rawPlatform as Platform)
    : ("LINUX" as Platform);
  const source = (SOURCE_VALUES as readonly string[]).includes(rawSource)
    ? (rawSource as SoftwareSource)
    : ("INTERNAL" as SoftwareSource);
  const licenseType = (LICENSE_VALUES as readonly string[]).includes(rawLicense)
    ? (rawLicense as LicenseType)
    : ("OPEN" as LicenseType);

  const seats = Number(formData.get("licenseSeats") ?? 0);

  return {
    ok: true,
    fields: {
      name: String(formData.get("name") ?? "").trim(),
      vendor: trimmed(formData, "vendor"),
      version: trimmed(formData, "version"),
      flavour: trimmed(formData, "flavour"),
      description: trimmed(formData, "description"),
      platform,
      source,
      sourceUrl: trimmed(formData, "sourceUrl"),
      licenseType,
      licenseKey: trimmed(formData, "licenseKey"),
      licenseSeats: Number.isFinite(seats) && seats > 0 ? Math.trunc(seats) : null,
      licenseExpiresAt: expiry.date,
      enabled: formData.get("enabled") === "on" || formData.get("enabled") === "true",
      requiresKey: licenseType === "LICENSED",
    },
  };
}
