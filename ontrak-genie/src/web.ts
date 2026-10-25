/**
 * Web research (2.1): search and fetch, with the network treated as untrusted.
 *
 * A coding agent that can read the web can also be talked into reading *this*
 * host. The URL it is given comes from a model that has just read a page somebody
 * else wrote, so the fetch is the one place in the tool set where a mistake is a
 * request from inside the deployment. Everything here exists to keep that from
 * happening:
 *
 *  - only `http` and `https`, no credentials in the URL;
 *  - the host is resolved and **every** address it answers with is checked, so a
 *    name that resolves to a loopback or RFC 1918 address is refused rather than
 *    dialled;
 *  - a redirect is not followed by the HTTP client — each hop is validated the
 *    same way — and the response is read with a byte cap, so a page cannot fill
 *    the process;
 *  - only textual content is read; a binary is reported, not decoded.
 *
 * It cannot defeat DNS rebinding on its own (Node's fetch resolves the name
 * again), which is why the tool is approval-gated by default and why the docs say
 * so plainly rather than implying the check is total.
 *
 * Search needs a provider. Exa is the one this build speaks: a JSON endpoint, a
 * free tier, and result text that is already extracted for a model. Without
 * `EXA_API_KEY` the tool is not offered at all rather than offered and always
 * failing.
 */

import dns from "node:dns/promises";
import net from "node:net";

import { config } from "./config.js";

export const WEB_TIMEOUT_MS = 15_000;
export const WEB_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Address policy                                                            */
/* -------------------------------------------------------------------------- */

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number(part));
  return numbers.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? numbers : null;
}

/** Is this IPv4 address something a request from this host must not reach? */
function isPublicIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && parts[2] === 0) return false;
  if (a === 192 && b === 0 && parts[2] === 2) return false; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return false; // TEST-NET-3
  if (a === 224 || a >= 240) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 address to its eight 16-bit groups, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.trim().toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (text === "" || text.includes(":::")) return null;

  // A trailing dotted quad (::ffff:127.0.0.1) is two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.slice(lastColon + 1).includes(".")) {
    const quad = ipv4Parts(text.slice(lastColon + 1));
    if (!quad) return null;
    tail = [(quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!];
    text = text.slice(0, lastColon + 1);
    if (text.endsWith("::")) text = text.slice(0, -1);
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const numbers: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      numbers.push(Number.parseInt(group, 16));
    }
    return numbers;
  };

  const left = parse(halves[0] ?? "");
  const right = parse(halves[1] ?? "");
  if (!left || !right) return null;

  const known = left.length + right.length + tail.length;
  if (halves.length === 1) {
    const groups = [...left, ...tail];
    return groups.length === 8 ? groups : null;
  }
  if (known > 7) return null;
  return [...left, ...new Array(8 - known).fill(0), ...right, ...tail];
}

export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) return isPublicIpv4(address);
  const groups = ipv6Groups(address);
  if (!groups) return false;

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 hat.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isPublicIpv4(v4);
  }
  // IPv4-compatible (deprecated) is still IPv4.
  if (groups.slice(0, 6).every((group) => group === 0)) {
    const v4 = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isPublicIpv4(v4);
  }

  if (groups.every((group) => group === 0)) return false; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false; // ::1
  if ((groups[0]! & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((groups[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((groups[0]! & 0xff00) === 0xff00) return false; // multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  return true;
}

const INTERNAL_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa", ".lan"];

/**
 * Refuse a URL the agent should not be able to dial: a non-HTTP scheme, embedded
 * credentials, an obviously internal name, or a name that resolves to any
 * non-public address.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`“${raw}” is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be fetched, not ${url.protocol.replace(":", "")}.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("A URL with credentials in it will not be fetched.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "" || hostname === "localhost" || hostname.endsWith(".") ) {
    throw new Error("A URL with no host will not be fetched.");
  }
  if (INTERNAL_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
    throw new Error(`“${hostname}” is an internal name, so it will not be fetched.`);
  }

  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error(`“${hostname}” is not a public address, so it will not be fetched.`);
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(`“${hostname}” could not be resolved: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new Error(`“${hostname}” resolved to no address.`);
  for (const entry of addresses) {
    if (!isPublicAddress(entry.address)) {
      throw new Error(`“${hostname}” resolves to ${entry.address}, which is not a public address.`);
    }
  }
  return url;
}

/* -------------------------------------------------------------------------- */
/*  HTML to text                                                              */
/* -------------------------------------------------------------------------- */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name.startsWith("#x") || name.startsWith("#X")
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Read a page as text. Not a renderer: the point is what the page *says*, with
 * scripts, styles and comments gone and block boundaries kept as line breaks, so
 * a model is not handed a wall of markup or a page's JavaScript.
 */
export function htmlToText(html: string, title?: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `${title}\n\n${text}` : text;
}

/** The page's `<title>`, decoded, or an empty string. */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

/* -------------------------------------------------------------------------- */
/*  Fetch                                                                     */
/* -------------------------------------------------------------------------- */

function textual(contentType: string): boolean {
  const type = contentType.toLowerCase().split(";")[0]!.trim();
  return (
    type === "" ||
    type === "text/html" ||
    type === "text/plain" ||
    type === "text/xml" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type === "application/json" ||
    type.startsWith("text/")
  );
}

async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > WEB_MAX_BYTES) {
          const keep = value.byteLength - (bytes - WEB_MAX_BYTES);
          text += decoder.decode(value.subarray(0, Math.max(0, keep)), { stream: true });
          truncated = true;
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  text += decoder.decode();
  return { text, truncated };
}

/**
 * Fetch a public page and return readable text.
 *
 * Redirects are followed by hand so every hop is checked; the response body is
 * capped; a non-textual content type is an error the caller can explain rather
 * than a binary that gets decoded as mojibake.
 */
export async function fetchPage(raw: string): Promise<FetchedPage> {
  let current = await assertPublicHttpUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      headers: {
        "user-agent": "Genie/2.1 (web research; +https://github.com/innotelinc)",
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`The page answered ${response.status} without a location.`);
      current = await assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      throw new Error(`The page answered ${response.status} ${response.statusText}.`);
    }
    if (!textual(contentType)) {
      throw new Error(`The page is ${contentType || "an unknown content type"}, not text, so it was not read.`);
    }

    const { text, truncated } = await readCapped(response);
    const isHtml = /html/i.test(contentType) || /^\s*</.test(text);
    return {
      url: current.toString(),
      status: response.status,
      contentType,
      text: isHtml ? htmlToText(text, htmlTitle(text)) : text.slice(0, WEB_MAX_BYTES),
      truncated,
    };
  }

  throw new Error(`The page redirected more than ${MAX_REDIRECTS} times.`);
}

/* -------------------------------------------------------------------------- */
/*  Search (Exa)                                                              */
/* -------------------------------------------------------------------------- */

/** Is a search provider configured? */
export function searchEnabled(): boolean {
  return config.webSearchKey !== "";
}

/**
 * Reduce an Exa response to the three fields a model needs. Kept separate from
 * the request so the shape is testable without the network.
 */
export function parseSearchPayload(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) => {
      const row = entry as { title?: unknown; url?: unknown; text?: unknown; highlights?: unknown };
      const highlights = Array.isArray(row.highlights) ? row.highlights.filter((item) => typeof item === "string") : [];
      const snippet = typeof row.text === "string" ? row.text : highlights.join(" ");
      return {
        title: typeof row.title === "string" ? row.title : typeof row.url === "string" ? row.url : "(untitled)",
        url: typeof row.url === "string" ? row.url : "",
        snippet: snippet.replace(/\s+/g, " ").trim(),
      };
    })
    .filter((result) => result.url !== "")
    .slice(0, limit);
}

export async function searchWeb(query: string, limit: number): Promise<WebSearchResult[]> {
  if (!searchEnabled()) throw new Error("No search provider is configured (EXA_API_KEY).");
  const response = await fetch(config.webSearchUrl, {
    method: "POST",
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    headers: { "content-type": "application/json", "x-api-key": config.webSearchKey },
    body: JSON.stringify({
      query,
      numResults: Math.max(1, Math.min(25, limit)),
      type: "auto",
      contents: { text: { maxCharacters: 600 } },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`The search provider answered ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return parseSearchPayload(await response.json(), limit);
}
