import type { ActionFunctionArgs } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { action } from './api.gitea';

/**
 * The proxy is the only place a Gitea token crosses from the browser to a server, so
 * what it refuses matters as much as what it returns: a missing token, an action it
 * does not implement, and a metadata address all have to be refused *before* a
 * `fetch` is attempted, and an upstream refusal has to arrive with a reason a person
 * can act on rather than as a bare status.
 */

const call = (body: unknown) =>
  action({
    request: new Request('https://bolt.test/api/gitea', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context: { clientAddress: '127.0.0.1' },
    params: {},
  } as unknown as ActionFunctionArgs);

const base = { action: 'user', baseUrl: 'https://gitlab.innotel.us', token: 'tok' };

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/gitea', () => {
  it('refuses a request with no token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await call({ ...base, token: '' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/token is required/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an action it does not implement, naming the ones it does', async () => {
    const response = await call({ ...base, action: 'delete-repository' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/user, repositories, version/) });
  });

  it('refuses a link-local metadata address before it fetches it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await call({ ...base, baseUrl: 'http://169.254.169.254' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/metadata/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the token to Gitea and returns only the fields the connector draws', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 1,
        login: 'dhunter',
        full_name: 'D Hunter',
        email: 'dhunter@innotel.us',
        avatar_url: 'https://gitlab.innotel.us/avatars/x',
        html_url: 'https://gitlab.innotel.us/dhunter',
        created: '2026-01-01T00:00:00Z',
        is_admin: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await call(base);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        id: 1,
        login: 'dhunter',
        full_name: 'D Hunter',
        email: 'dhunter@innotel.us',
        avatar_url: 'https://gitlab.innotel.us/avatars/x',
        html_url: 'https://gitlab.innotel.us/dhunter',
        created: '2026-01-01T00:00:00Z',
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://gitlab.innotel.us/api/v1/user');
    expect((init.headers as Record<string, string>).Authorization).toBe('token tok');
  });

  it('maps the repositories Gitea returns, and tolerates a missing array', async () => {
    // `/repos/search` wraps its answer in `{ data }`; that envelope is the real one.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        Response.json({
          ok: true,
          data: [
            {
              id: 7,
              name: 'connector-check',
              full_name: 'ontrak-test/connector-check',
              description: null,
              html_url: 'https://gitlab.innotel.us/ontrak-test/connector-check',
              clone_url: 'https://gitlab.innotel.us/ontrak-test/connector-check.git',
              default_branch: 'main',
              private: true,
              fork: false,
              stars_count: 0,
              forks_count: 0,
              open_issues_count: 0,
              updated_at: '2026-11-01T00:00:00Z',
              language: null,
            },
          ],
        }),
      ),
    );

    const response = await call({ ...base, action: 'repositories' });
    const payload = (await response.json()) as { repositories: Array<Record<string, unknown>> };

    expect(payload.repositories).toHaveLength(1);
    expect(payload.repositories[0]).toMatchObject({
      full_name: 'ontrak-test/connector-check',
      description: '',
      language: '',
      private: true,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ message: 'no' })));

    const empty = await call({ ...base, action: 'repositories' });

    expect(await empty.json()).toEqual({ repositories: [] });
  });

  it('turns an upstream 401 into a message about the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'unauthorized' }, { status: 401 })));

    const response = await call(base);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/rejected this token/) });
  });

  it('answers 502 with the address when the instance cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const response = await call(base);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/Could not reach https:\/\/gitlab\.innotel\.us/),
    });
  });
});
