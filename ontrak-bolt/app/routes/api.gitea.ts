import type { ActionFunctionArgs } from 'react-router';
import { withSecurity } from '~/lib/security';
import { assertGiteaBaseUrlAllowed, normalizeGiteaBaseUrl } from '~/lib/services/giteaApiService';

/**
 * The one server-side hop between the console and a Gitea instance.
 *
 * Gitea does not serve CORS headers on `/api/v1`, so the connector cannot call it
 * from the browser — and even if it could, the token would then be a cross-origin
 * credential in a page. So the page posts `{ action, baseUrl, token }` to its own
 * origin, this route makes the request, and only the fields the connector draws come
 * back. The token is used and dropped; nothing here stores it.
 *
 * Two things this route refuses, both by name rather than by accident:
 *
 *   * a base URL that is not http(s), or that carries credentials in it, and
 *   * a base URL pointing at a link-local metadata address — `assertGiteaBaseUrlAllowed`
 *     explains why that class is blocked and private ranges are not.
 *
 * A deployment can shorten the leash with `GITEA_ALLOWED_HOSTS` (comma-separated):
 * when it is set, only those hosts are reachable through this route.
 */ const API_PATHS = {
  user: '/api/v1/user',

  /*
   * `/repos/search`, not `/user/repos`.
   *
   * Both return the repositories the token can see, but `/user/repos` ignored the
   * `sort` it was given and answered alphabetically, capped at the page size — so on
   * an instance with more than fifty repositories the one a person had just created
   * was simply absent from the list, with nothing on screen saying why. The search
   * endpoint honours `sort=updated&order=desc` and wraps its answer in `{ data }`,
   * which is why the parser below accepts either shape.
   */
  repositories: '/api/v1/repos/search?q=&limit=50&sort=updated&order=desc',
  version: '/api/v1/version',
} as const;

type GiteaProxyAction = keyof typeof API_PATHS;

const isAction = (value: unknown): value is GiteaProxyAction =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(API_PATHS, value);

function allowedHosts(): string[] {
  return String(process.env.GITEA_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host: string) => host.trim().toLowerCase())
    .filter(Boolean);
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function giteaProxyAction({ request }: ActionFunctionArgs) {
  let body: { action?: unknown; baseUrl?: unknown; token?: unknown };

  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body: { action, baseUrl, token }.' }, 400);
  }

  const { action, baseUrl, token } = body ?? {};

  if (typeof token !== 'string' || !token.trim()) {
    return json({ error: 'A Gitea access token is required.' }, 400);
  }

  if (!isAction(action)) {
    return json({ error: `Unknown Gitea action. Expected one of: ${Object.keys(API_PATHS).join(', ')}` }, 400);
  }

  let base: string;

  try {
    base = normalizeGiteaBaseUrl(typeof baseUrl === 'string' ? baseUrl : '');
    assertGiteaBaseUrlAllowed(base, allowedHosts());
  } catch (error) {
    return json({ error: messageOf(error) }, 400);
  }

  let response: Response;

  try {
    response = await fetch(`${base}${API_PATHS[action]}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        'User-Agent': 'ontrak-bolt',
      },

      // A connector page must not hang on an instance that stopped answering.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return json(
      {
        error: `Could not reach ${base}. Check the address, and that this deployment can route to it.${
          base.includes('192.168.') || base.includes('10.')
            ? ' (private addresses need the container to be on that network.)'
            : ''
        }`,
      },
      502,
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return json({ error: 'Gitea rejected this token. It needs at least read access to your repositories.' }, 401);
    }

    if (response.status === 404) {
      return json({ error: `No Gitea API answered at ${base}/api/v1. Is the address the instance root?` }, 404);
    }

    return json({ error: `Gitea answered ${response.status}.` }, 502);
  }

  const data = (await response.json().catch(() => null)) as Record<string, any> | any[] | null;

  if (!data) {
    return json({ error: 'Gitea returned a response that could not be read.' }, 502);
  }

  if (action === 'version') {
    return json({ version: String((data as Record<string, any>).version ?? '') });
  }

  if (action === 'user') {
    const user = data as Record<string, any>;

    return json({
      user: {
        id: Number(user.id ?? 0),
        login: String(user.login ?? ''),
        full_name: String(user.full_name ?? ''),
        email: String(user.email ?? ''),
        avatar_url: String(user.avatar_url ?? ''),
        html_url: String(user.html_url ?? base),
        created: String(user.created ?? ''),
      },
    });
  }

  const repositories = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, any>).data)
      ? (data as Record<string, any>).data
      : [];

  return json({
    repositories: repositories.slice(0, 50).map((repository: Record<string, any>) => ({
      id: Number(repository.id ?? 0),
      name: String(repository.name ?? ''),
      full_name: String(repository.full_name ?? ''),
      description: String(repository.description ?? ''),
      html_url: String(repository.html_url ?? ''),
      clone_url: String(repository.clone_url ?? ''),
      default_branch: String(repository.default_branch ?? ''),
      private: Boolean(repository.private),
      fork: Boolean(repository.fork),
      stars_count: Number(repository.stars_count ?? 0),
      forks_count: Number(repository.forks_count ?? 0),
      open_issues_count: Number(repository.open_issues_count ?? 0),
      updated_at: String(repository.updated_at ?? ''),
      language: String(repository.language ?? ''),
    })),
  });
}

export const action = withSecurity(giteaProxyAction, {
  rateLimit: true,
  allowedMethods: ['POST'],
});
