/**
 * Directory readers (S2): the vendor-shaped half of the sync.
 *
 * A `DirectoryReader` is a port with one method, and this file is the implementation
 * that covers the two directories almost every customer actually runs — Microsoft Entra
 * ID (Graph) and Google Workspace (the Admin SDK directory API). They share enough that
 * one reader serves both: both answer JSON over HTTPS, both page with a token in the
 * payload, and both spell the same four fields differently, which is what the rules
 * module's alias table is for. LDAP is deliberately *not* here: an LDAP bind is a
 * different protocol with a different dependency, so a deployment that needs it supplies
 * another reader rather than having one faked for it.
 *
 * Four decisions worth stating out loud:
 *
 *  - **The credential is passed in, never read from the connection record.** By the time
 *    this runs, the value exists in exactly one argument of one call.
 *  - **Client-credentials is a real flow, not a bearer token with extra steps.** Graph
 *    and Google both want a token minted from a client id and secret, and a reader that
 *    only understood a static token would work in a test and expire in production. The
 *    token is fetched once per pull and reused for every page.
 *  - **Paging follows the provider's own next-link and stops on a page with none.** A
 *    reader that guessed at `page=2` would silently truncate a tenant at whatever the
 *    provider's default page size is — and a truncated sync is a sync that deactivates
 *    nobody, which looks like success.
 *  - **A page that is not JSON is an error, not an empty roster.** The distinction
 *    matters more than it sounds: an empty roster is a valid answer that means "nobody
 *    is here", and a sync that confused the two would report a clean run.
 */

import { parseDirectoryPage, type DirectoryConnectionRecord, type DirectoryPerson } from "./directory-rules";
import type { DirectoryPull, DirectoryReader } from "./directory-service";

/** Only what we need of `fetch`, so a test can hand in a function. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface HttpDirectoryReaderOptions {
  fetch?: FetchLike;
  /** How many pages to follow before refusing to continue. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 50;

/** A settings value, or a clear refusal naming the setting — never a silent empty string. */
function setting(connection: DirectoryConnectionRecord, key: string): string {
  const value = connection.settings[key];
  if (!value || !value.trim()) throw new Error(`The connection has no “${key}” setting.`);
  return value.trim();
}

function optional(connection: DirectoryConnectionRecord, key: string): string | null {
  const value = connection.settings[key];
  return value && value.trim() ? value.trim() : null;
}

/**
 * The `Authorization` header for a pull.
 *
 * `bearer` uses the stored secret as it stands — the right choice for a short-lived
 * token somebody pastes in, and for a test. `clientCredentials` mints one: a form post to
 * the deployment's token endpoint, which is what both vendors' app registrations expect.
 * Anything else is refused by name rather than defaulting to no header at all, because a
 * request without credentials fails in a way that looks like a permissions problem.
 */
async function authorization(
  connection: DirectoryConnectionRecord,
  secret: string | null,
  fetchImpl: FetchLike,
): Promise<Record<string, string>> {
  const mode = optional(connection, "auth") ?? "bearer";
  if (mode === "none") return {};
  if (!secret) throw new Error(`The connection needs a credential (auth: ${mode}).`);

  if (mode === "bearer") return { authorization: `Bearer ${secret}` };

  if (mode === "clientCredentials") {
    const body = new URLSearchParams({
      client_id: setting(connection, "clientId"),
      client_secret: secret,
      grant_type: "client_credentials",
      scope: setting(connection, "scope"),
    }).toString();

    const response = await fetchImpl(setting(connection, "tokenUrl"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`The directory refused the token request (${response.status}).`);
    let parsed: { access_token?: unknown };
    try {
      parsed = JSON.parse(text) as { access_token?: unknown };
    } catch {
      throw new Error("The token endpoint did not answer with JSON.");
    }
    if (typeof parsed.access_token !== "string" || !parsed.access_token) {
      throw new Error("The token response carried no access_token.");
    }
    return { authorization: `Bearer ${parsed.access_token}` };
  }

  throw new Error(`“${mode}” is not an authentication mode this reader knows.`);
}

/**
 * The next page's URL, if the payload names one.
 *
 * Both vendors put it in the body rather than in a `Link` header, and both spell it
 * differently, so the setting exists for the rest: `nextKey` names the JSON key to read.
 */
function nextPageUrl(body: unknown, nextKey: string, current: string): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  // The literal key first. Graph's is `@odata.nextLink`, which *contains* a dot — a reader
  // that only understood dotted paths would look for `@odata` and find nothing, and a
  // sync that stops at page one looks exactly like a tenant with one page of people.
  let cursor: unknown = record[nextKey];
  if (cursor === undefined) {
    // Then the dotted path, because a vendor that wraps its feed (`data.nextToken`) should
    // not need a second reader for the difference.
    cursor = body;
    for (const part of nextKey.split(".")) {
      if (!cursor || typeof cursor !== "object") return null;
      cursor = (cursor as Record<string, unknown>)[part];
    }
  }

  if (typeof cursor !== "string" || !cursor.trim()) return null;
  if (cursor === current) return null;
  return cursor.trim();
}

/** Turn whatever went wrong into a sentence the console can print. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : "the directory could not be read";
}

/**
 * A reader that lists people over HTTPS and follows the provider's own paging.
 *
 * `settings.url` is where a page starts, `settings.nextKey` is the JSON key carrying the
 * next page (default `@odata.nextLink`, Graph's), and `settings.auth` picks how the
 * credential is used. The field aliases live in the rules module, so a vendor that
 * renames a field is a change there rather than here.
 */
export function createHttpDirectoryReader(options: HttpDirectoryReaderOptions = {}): DirectoryReader {
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  return {
    async pull(connection, secret): Promise<DirectoryPull> {
      try {
        const headers = { accept: "application/json", ...(await authorization(connection, secret, fetchImpl)) };
        const nextKey = optional(connection, "nextKey") ?? "@odata.nextLink";

        let url: string | null = setting(connection, "url");
        const people: DirectoryPerson[] = [];
        const skipped: string[] = [];
        let pages = 0;

        while (url) {
          if (pages >= maxPages) {
            // Refusing to continue is the safe failure: a paging loop that never ends
            // would hold the sync open forever, and one that silently stopped would
            // look like a complete roster.
            return { ok: false, error: `The directory did not stop paging after ${maxPages} pages; refusing to continue.` };
          }
          pages += 1;

          const response = await fetchImpl(url, { headers });
          const text = await response.text();
          if (!response.ok) {
            return { ok: false, error: `The directory answered ${response.status} while listing people.` };
          }

          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return { ok: false, error: "The directory's answer was not JSON." };
          }

          const page = parseDirectoryPage(connection.source, body);
          people.push(...page.people);
          skipped.push(...page.skipped);
          url = nextPageUrl(body, nextKey, url);
        }

        return { ok: true, people, skipped };
      } catch (error) {
        return { ok: false, error: reason(error) };
      }
    },
  };
}

/** A reader that always answers with the same roster — for a deployment's smoke test. */
export function staticDirectoryReader(people: DirectoryPerson[]): DirectoryReader {
  return {
    async pull() {
      return { ok: true, people, skipped: [] };
    },
  };
}
