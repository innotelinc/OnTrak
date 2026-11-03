import type { GiteaRepository, GiteaStats, GiteaUser, GiteaVersion } from '~/types/Gitea';

/** The estate's instance. A connector that starts on nothing starts wrong. */
export const DEFAULT_GITEA_BASE_URL = 'https://gitlab.innotel.us';

/**
 * The browser never calls Gitea directly.
 *
 * GitLab serves `Access-Control-Allow-Origin` on its API and the GitLab connector
 * relies on it. Gitea does not: a cross-origin `fetch` from this console is answered
 * by the browser, not by the server, and the only thing the page can observe is a
 * CORS failure that says nothing about the token. So the request goes to this app's
 * own origin and `app/routes/api.gitea.ts` makes the hop server-side, exactly as the
 * GitHub connector already does.
 */
export const GITEA_PROXY_ENDPOINT = '/api/gitea';

export type GiteaAction = 'user' | 'repositories' | 'version';

/**
 * A base URL as Gitea wants to be addressed: a scheme, a host, an optional path
 * prefix for an instance served under one, and no trailing slash — the API paths are
 * joined with `/api/v1/…`, and `//api/v1` is a different path.
 *
 * A bare host is accepted and assumed HTTPS, because typing `gitlab.innotel.us` is
 * what a person does and the failure for guessing wrong would be a silent downgrade
 * or a confusing network error.
 */
export function normalizeGiteaBaseUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();

  if (!trimmed) {
    throw new Error('Enter the address of your Gitea instance, for example https://gitlab.innotel.us');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;

  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${trimmed}" is not a URL. Enter an address like https://gitlab.innotel.us`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The Gitea address must be http or https.');
  }

  /*
   * Credentials in the URL would be sent by the proxy in the clear to a third party
   * and stored in `localStorage` beside the token; the token field is the one place a
   * credential belongs.
   */
  if (url.username || url.password) {
    throw new Error('Put the token in the token field, not in the address.');
  }

  url.search = '';
  url.hash = '';

  const path = url.pathname.replace(/\/+$/, '');

  return `${url.origin}${path === '/' ? '' : path}`;
}

/*
 * Link-local addresses are where cloud metadata services live, and a connector whose
 * base URL is typed into a browser is a server-side fetch to whatever that browser
 * asks for. This is the one class of target that is never a Gitea instance, so it is
 * refused by name rather than left to a password that happens to be wrong.
 *
 * Private LAN ranges are deliberately *not* blocked: the whole point of a
 * self-hosted connector is `192.168.1.21`. A deployment that wants a shorter leash
 * sets `GITEA_ALLOWED_HOSTS` and only those hosts are reachable.
 */
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data']);
const BLOCKED_ADDRESSES = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2::254']);

export function assertGiteaBaseUrlAllowed(baseUrl: string, allowedHosts: string[] = []): void {
  const url = new URL(baseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_ADDRESSES.has(host) ||
    host.startsWith('169.254.') ||
    host.startsWith('fe80:')
  ) {
    throw new Error('That address is a link-local metadata endpoint, not a Gitea instance.');
  }

  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    throw new Error(`This deployment only allows Gitea on: ${allowedHosts.join(', ')}`);
  }
}

/** The numbers the connector page shows, from the repositories it already has. */
export function summarizeGiteaRepositories(repositories: GiteaRepository[]): GiteaStats {
  return {
    repositories,
    totalRepositories: repositories.length,
    publicRepositories: repositories.filter((repository) => !repository.private).length,
    privateRepositories: repositories.filter((repository) => repository.private).length,
    totalStars: repositories.reduce((total, repository) => total + repository.stars_count, 0),
    totalForks: repositories.reduce((total, repository) => total + repository.forks_count, 0),
    openIssues: repositories.reduce((total, repository) => total + repository.open_issues_count, 0),
    lastUpdated: new Date().toISOString(),
  };
}

export interface GiteaConnectionResult {
  success: boolean;
  error?: string;
}

export class GiteaApiService {
  private readonly _baseUrl: string;

  constructor(
    private readonly _token: string,
    baseUrl: string = DEFAULT_GITEA_BASE_URL,
  ) {
    if (!_token.trim()) {
      throw new Error('Enter a Gitea access token to connect.');
    }

    this._baseUrl = normalizeGiteaBaseUrl(baseUrl);
  }

  private async _request<T>(action: GiteaAction): Promise<T> {
    let response: Response;

    try {
      response = await fetch(GITEA_PROXY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, baseUrl: this._baseUrl, token: this._token }),
      });
    } catch {
      throw new Error('Could not reach this console’s Gitea proxy. Is the app still running?');
    }

    const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

    if (!response.ok) {
      throw new Error(payload?.error || `Gitea request failed (${response.status})`);
    }

    if (!payload) {
      throw new Error('Gitea returned a response this console could not read.');
    }

    return payload;
  }

  async getUser(): Promise<GiteaUser> {
    const { user } = await this._request<{ user: GiteaUser }>('user');

    return user;
  }

  async getRepositories(): Promise<GiteaRepository[]> {
    const { repositories } = await this._request<{ repositories: GiteaRepository[] }>('repositories');

    return repositories;
  }

  async getVersion(): Promise<GiteaVersion> {
    return this._request<GiteaVersion>('version');
  }

  /** One call that says whether the address and the token agree. */
  async testConnection(): Promise<boolean> {
    try {
      await this.getUser();

      return true;
    } catch {
      return false;
    }
  }
}
