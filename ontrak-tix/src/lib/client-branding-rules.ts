/**
 * Client branding rules (M4): the name, colour and voice one client is shown in.
 *
 * A desk that serves many clients is seen by each of them as *their* supplier,
 * and the fastest way to lose that is to send a client their own incident notice
 * in somebody else's colours. So the branding is per client, and three things
 * about it are decided here rather than left to a form:
 *
 *  - **A colour is a design constraint, not free text.** A client's accent has to
 *    be a six-digit hex colour and has to stay readable on the portal's dark
 *    background. Letting a client pick `#0b0d10` would produce a page where the
 *    brand vanishes — a bug reported as "your site is broken", not as a colour
 *    choice — so contrast is checked at the moment it is set.
 *  - **A logo URL is not a place to put a URL.** The portal renders whatever is
 *    stored, so only `https:` and inline `data:image/*` are accepted: an `http:`
 *    logo is content a third party can rewrite in flight, a `javascript:` or
 *    `data:text/html` "image" is an injection into somebody else's client page,
 *    and an unbounded data URI is a way to fill the database from a form.
 *  - **A client with no branding is not an error.** It falls back to the desk's
 *    own identity, in one function, so no caller has to remember to check.
 */

export const BRAND_NAME_MAX = 120;
export const BRAND_SIGNATURE_MAX = 2000;
export const BRAND_EMAIL_MAX = 200;
/** A data-URI logo is stored in a column; this is the ceiling on one. */
export const BRAND_LOGO_MAX = 100_000;
/** The portal's own background. A client's colour is read *against* this. */
export const PORTAL_BACKGROUND = "#0b0d10";
/**
 * The floor for a client's accent colour. 3:1 is the WCAG AA ratio for large
 * text and UI components — a brand colour is both — so anything below it is a
 * colour that cannot be used for anything the brand is used for.
 */
export const MIN_ACCENT_CONTRAST = 3;

export interface BrandingIssue {
  field: string;
  message: string;
}

export interface ClientBrandingRecord {
  id: string;
  tenantId: string;
  clientId: string;
  displayName: string;
  /** `#rrggbb`, lower-cased on the way in. */
  accentColor: string;
  logoUrl: string | null;
  supportEmail: string | null;
  signature: string | null;
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/*  Colour                                                                    */
/* -------------------------------------------------------------------------- */

/** `#rrggbb` or `#rgb`, normalised to `#rrggbb`. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return null;
}

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const first = normalizeHexColor(a);
  const second = normalizeHexColor(b);
  if (!first || !second) return 0;
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether a logo reference may be rendered on a client's page.
 *
 * `https:` only for a remote image — not `http:`, which a network can rewrite —
 * and inline images only for real image types, decoded as base64. An SVG is
 * allowed because every other logo a client has is an SVG; it is rendered by the
 * portal as an image, which does not execute script inside it.
 */
export function logoUrlIssue(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (raw.length > BRAND_LOGO_MAX) {
    return `A logo may be at most ${Math.round(BRAND_LOGO_MAX / 1000)} KB of inline data, or an https URL.`;
  }
  if (/^https:\/\/\S+$/i.test(raw)) return null;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(raw)) return null;
  if (/^data:/i.test(raw)) {
    return "An inline logo must be a base64 image (png, jpeg, gif, webp or svg+xml).";
  }
  return "A logo must be an https:// URL or an inline base64 image — an image the page renders, never anything else.";
}

export function validateClientBranding(input: {
  displayName?: string;
  accentColor?: string;
  logoUrl?: string | null;
  supportEmail?: string | null;
  signature?: string | null;
}): BrandingIssue[] {
  const issues: BrandingIssue[] = [];

  const name = (input.displayName ?? "").trim();
  if (!name) issues.push({ field: "displayName", message: "A brand needs a name to show the client." });
  else if (name.length > BRAND_NAME_MAX) {
    issues.push({ field: "displayName", message: `The display name may be at most ${BRAND_NAME_MAX} characters.` });
  }

  const color = normalizeHexColor(input.accentColor);
  if (!color) {
    issues.push({ field: "accentColor", message: "Give the accent colour as a hex value, e.g. #3aa0ff." });
  } else {
    const ratio = contrastRatio(color, PORTAL_BACKGROUND);
    if (ratio < MIN_ACCENT_CONTRAST) {
      issues.push({
        field: "accentColor",
        message: `That colour is too close to the portal background to be read (${ratio}:1, needs ${MIN_ACCENT_CONTRAST}:1). Pick a lighter one.`,
      });
    }
  }

  const logo = logoUrlIssue(input.logoUrl);
  if (logo) issues.push({ field: "logoUrl", message: logo });

  const email = (input.supportEmail ?? "").trim();
  if (email) {
    if (email.length > BRAND_EMAIL_MAX) {
      issues.push({ field: "supportEmail", message: `The address may be at most ${BRAND_EMAIL_MAX} characters.` });
    } else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
      issues.push({ field: "supportEmail", message: `“${email}” is not an address a client could reply to.` });
    }
  }

  const signature = (input.signature ?? "").trim();
  if (signature.length > BRAND_SIGNATURE_MAX) {
    issues.push({ field: "signature", message: `The signature may be at most ${BRAND_SIGNATURE_MAX} characters.` });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  The brand in force                                                        */
/* -------------------------------------------------------------------------- */

export interface Brand {
  /** What the client is called where the client will read it. */
  name: string;
  accentColor: string;
  logoUrl: string | null;
  supportEmail: string | null;
  signature: string | null;
  source: "client" | "desk";
}

/** The identity a client with no branding of their own is shown in. */
export const DESK_BRAND: Brand = {
  name: "the desk",
  accentColor: "#fb923c",
  logoUrl: null,
  supportEmail: null,
  signature: null,
  source: "desk",
};

/**
 * The branding in force for a client. One function, so a page never has to ask
 * "is there a branding row?" — a client without one is shown in the desk's own
 * colours and named by the name the desk filed them under.
 */
export function brandFor(client: { name: string }, branding: ClientBrandingRecord | null): Brand {
  if (!branding) return { ...DESK_BRAND, name: client.name };
  return {
    name: branding.displayName,
    accentColor: branding.accentColor,
    logoUrl: branding.logoUrl,
    supportEmail: branding.supportEmail,
    signature: branding.signature,
    source: "client",
  };
}

/**
 * The brand as CSS custom properties, so a page sets it once and inherits it.
 * A plain object of string keys, which is what a React `style` attribute wants at
 * runtime — the rules module stays free of any framework import.
 */
export function brandingStyle(brand: Brand): Record<string, string> {
  return {
    "--brand-accent": brand.accentColor,
    "--brand-tint": `${brand.accentColor}22`,
    "--brand-border": `${brand.accentColor}55`,
  };
}

/** One line for the console, saying whose colours a client is actually shown in. */
export function brandingSummary(brand: Brand): string {
  if (brand.source === "desk") {
    return `${brand.name} has no branding of its own, so their pages use the desk's.`;
  }
  const logos = brand.logoUrl ? " with a logo" : "";
  const mail = brand.supportEmail ? `, replying to ${brand.supportEmail}` : "";
  return `${brand.name} is shown in ${brand.accentColor}${logos}${mail}.`;
}
