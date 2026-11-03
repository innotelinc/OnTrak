import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGiteaBaseUrlAllowed,
  DEFAULT_GITEA_BASE_URL,
  GiteaApiService,
  normalizeGiteaBaseUrl,
  summarizeGiteaRepositories,
} from './giteaApiService';
import type { GiteaRepository } from '~/types/Gitea';

const repository = (overrides: Partial<GiteaRepository> = {}): GiteaRepository => ({
  id: 1,
  name: 'ontrak-bolt',
  full_name: 'innotelinc/ontrak-bolt',
  description: '',
  html_url: 'https://gitlab.innotel.us/innotelinc/ontrak-bolt',
  clone_url: 'https://gitlab.innotel.us/innotelinc/ontrak-bolt.git',
  default_branch: 'main',
  private: false,
  fork: false,
  stars_count: 0,
  forks_count: 0,
  open_issues_count: 0,
  updated_at: '2026-10-30T00:00:00Z',
  language: 'TypeScript',
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('normalizeGiteaBaseUrl', () => {
  it('accepts the estate default unchanged', () => {
    expect(normalizeGiteaBaseUrl(DEFAULT_GITEA_BASE_URL)).toBe(DEFAULT_GITEA_BASE_URL);
  });

  it('assumes https for a bare host and drops a trailing slash', () => {
    expect(normalizeGiteaBaseUrl('gitlab.innotel.us/')).toBe('https://gitlab.innotel.us');
  });

  it('keeps a path prefix, because an instance can be served under one', () => {
    expect(normalizeGiteaBaseUrl('https://host.example/gitea/')).toBe('https://host.example/gitea');
  });

  it('drops a query and a fragment rather than forwarding them', () => {
    expect(normalizeGiteaBaseUrl('https://host.example/?a=1#frag')).toBe('https://host.example');
  });

  it('rejects a non-http scheme', () => {
    expect(() => normalizeGiteaBaseUrl('ftp://host.example')).toThrow(/http or https/);
  });

  it('rejects credentials in the address', () => {
    expect(() => normalizeGiteaBaseUrl('https://user:pass@host.example')).toThrow(/token field/);
  });

  it('rejects an empty address with something a person can act on', () => {
    expect(() => normalizeGiteaBaseUrl('  ')).toThrow(/address of your Gitea instance/);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => normalizeGiteaBaseUrl('not a url')).toThrow(/not a URL/);
  });
});

describe('assertGiteaBaseUrlAllowed', () => {
  it('allows the private LAN address a self-hosted instance lives at', () => {
    expect(() => assertGiteaBaseUrlAllowed('https://192.168.1.21')).not.toThrow();
  });

  it('refuses a link-local metadata address by name', () => {
    expect(() => assertGiteaBaseUrlAllowed('http://169.254.169.254')).toThrow(/metadata/);
    expect(() => assertGiteaBaseUrlAllowed('http://[fe80::1]')).toThrow(/metadata/);
    expect(() => assertGiteaBaseUrlAllowed('http://metadata.google.internal')).toThrow(/metadata/);
  });

  it('honours GITEA_ALLOWED_HOSTS when a deployment sets it', () => {
    expect(() => assertGiteaBaseUrlAllowed('https://github.com', ['gitlab.innotel.us'])).toThrow(
      /only allows Gitea on: gitlab.innotel.us/,
    );
    expect(() => assertGiteaBaseUrlAllowed('https://gitlab.innotel.us', ['gitlab.innotel.us'])).not.toThrow();
  });
});

describe('summarizeGiteaRepositories', () => {
  it('counts what the page draws', () => {
    const stats = summarizeGiteaRepositories([
      repository({ stars_count: 3, forks_count: 1, open_issues_count: 2 }),
      repository({ id: 2, private: true, stars_count: 4 }),
    ]);

    expect(stats.totalRepositories).toBe(2);
    expect(stats.publicRepositories).toBe(1);
    expect(stats.privateRepositories).toBe(1);
    expect(stats.totalStars).toBe(7);
    expect(stats.totalForks).toBe(1);
    expect(stats.openIssues).toBe(2);
  });
});

describe('GiteaApiService', () => {
  it('requires a token before it will construct', () => {
    expect(() => new GiteaApiService('   ')).toThrow(/access token/);
  });

  it('asks this app to make the hop, and unwraps the user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        user: {
          id: 1,
          login: 'ontrak',
          full_name: 'OnTrak',
          email: '',
          avatar_url: '',
          html_url: 'https://gitlab.innotel.us/ontrak',
          created: '',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = await new GiteaApiService('token', 'https://gitlab.innotel.us').getUser();

    expect(user.login).toBe('ontrak');

    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(endpoint).toBe('/api/gitea');
    expect(JSON.parse(String(init.body))).toEqual({
      action: 'user',
      baseUrl: 'https://gitlab.innotel.us',
      token: 'token',
    });
  });

  it('surfaces the proxy’s reason rather than a bare status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Gitea rejected this token.' }, { status: 401 })),
    );

    await expect(new GiteaApiService('bad').getRepositories()).rejects.toThrow('Gitea rejected this token.');
  });

  it('reports a proxy that cannot be reached as such', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(new GiteaApiService('token').getVersion()).rejects.toThrow(/Gitea proxy/);
  });

  it('answers testConnection with a boolean instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(new GiteaApiService('token').testConnection()).resolves.toBe(false);
  });
});
