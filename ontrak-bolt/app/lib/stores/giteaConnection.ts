import { atom, computed } from 'nanostores';
import {
  DEFAULT_GITEA_BASE_URL,
  GiteaApiService,
  normalizeGiteaBaseUrl,
  summarizeGiteaRepositories,
} from '~/lib/services/giteaApiService';
import { logStore } from '~/lib/stores/logs';
import type { GiteaConnection, GiteaStats } from '~/types/Gitea';

/**
 * The Gitea connection, kept where the other connectors keep theirs.
 *
 * Two differences from the GitLab store beside it, both deliberate:
 *
 *   * the instance URL is part of the connection rather than a constant — Gitea is
 *     self-hosted, and "which Gitea" is a property of the deployment, not of the
 *     product;
 *   * nothing goes into a cookie. GitLab's store writes `git:gitlab.com` for the
 *     clone widget; a Gitea clone needs the instance's own host, and writing a
 *     generic git credential for a host typed into a settings page would hand it to
 *     whatever that host turns out to be.
 *
 * The token lives in `localStorage` alongside the connection, as GitLab's does, and
 * is sent per request to this app's own proxy (`/api/gitea`) rather than to Gitea
 * from the browser — Gitea sends no CORS headers on its API.
 */

const STORAGE_KEY = 'gitea_connection';
const isBrowser = typeof window !== 'undefined';

const envBaseUrl = import.meta.env?.VITE_GITEA_URL;
const envToken = import.meta.env?.VITE_GITEA_ACCESS_TOKEN;

function safeBaseUrl(value: string | undefined): string {
  try {
    return normalizeGiteaBaseUrl(value || DEFAULT_GITEA_BASE_URL);
  } catch {
    return DEFAULT_GITEA_BASE_URL;
  }
}

const initialConnection: GiteaConnection = {
  user: null,
  token: envToken || '',
  tokenType: 'access-token',
  baseUrl: safeBaseUrl(envBaseUrl),
};

const connectionAtom = atom<GiteaConnection>(initialConnection);

function persist(connection: GiteaConnection) {
  if (isBrowser) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  }
}

function readSavedConnection(): GiteaConnection | null {
  if (!isBrowser) {
    return null;
  }

  const saved = localStorage.getItem(STORAGE_KEY);

  if (!saved) {
    return null;
  }

  try {
    const parsed = JSON.parse(saved) as GiteaConnection;

    if (!parsed?.user) {
      return null;
    }

    return {
      ...parsed,
      tokenType: 'access-token',
      baseUrl: safeBaseUrl(parsed.baseUrl),
    };
  } catch (error) {
    console.error('Error reading the saved Gitea connection:', error);
    localStorage.removeItem(STORAGE_KEY);

    return null;
  }
}

export const giteaConnection = computed(connectionAtom, (connection) => connection);
export const isGiteaConnected = computed(connectionAtom, (connection) => Boolean(connection.user));
export const giteaUser = computed(connectionAtom, (connection) => connection.user);
export const giteaStats = computed(connectionAtom, (connection) => connection.stats);
export const giteaBaseUrl = computed(connectionAtom, (connection) => connection.baseUrl);

class GiteaConnectionStore {
  get() {
    return connectionAtom.get();
  }

  /** Validate the address and the token together, and only then keep either. */
  async connect(token: string, baseUrl: string = DEFAULT_GITEA_BASE_URL) {
    try {
      const normalizedBaseUrl = normalizeGiteaBaseUrl(baseUrl);
      const api = new GiteaApiService(token, normalizedBaseUrl);
      const user = await api.getUser();

      const connection: GiteaConnection = {
        user,
        token,
        tokenType: 'access-token',
        baseUrl: normalizedBaseUrl,
      };

      connectionAtom.set(connection);
      persist(connection);

      logStore.logInfo('Connected to Gitea', {
        type: 'system',
        message: `Connected to Gitea at ${normalizedBaseUrl} as ${user.login}`,
      });

      return { success: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      logStore.logError(`Gitea authentication failed: ${message}`, {
        type: 'system',
        message: 'Gitea authentication failed',
      });

      return { success: false as const, error: message };
    }
  }

  /** Repositories and the counters drawn from them. A failure leaves the last stats. */
  async fetchStats(): Promise<{ success: boolean; stats?: GiteaStats; error?: string }> {
    const connection = connectionAtom.get();

    if (!connection.user || !connection.token) {
      return { success: false, error: 'Not connected to Gitea' };
    }

    try {
      const api = new GiteaApiService(connection.token, connection.baseUrl);
      const repositories = await api.getRepositories();
      const stats = summarizeGiteaRepositories(repositories);

      const updated: GiteaConnection = { ...connection, stats };

      connectionAtom.set(updated);
      persist(updated);

      return { success: true, stats };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  disconnect() {
    if (isBrowser) {
      localStorage.removeItem(STORAGE_KEY);
    }

    connectionAtom.set({
      user: null,
      token: '',
      tokenType: 'access-token',
      baseUrl: connectionAtom.get().baseUrl,
    });

    logStore.logInfo('Disconnected from Gitea', {
      type: 'system',
      message: 'Disconnected from Gitea',
    });
  }

  loadSavedConnection() {
    const saved = readSavedConnection();

    if (saved) {
      connectionAtom.set(saved);
    }

    return saved;
  }

  setBaseUrl(baseUrl: string) {
    connectionAtom.set({ ...connectionAtom.get(), baseUrl });
  }

  setToken(token: string) {
    connectionAtom.set({ ...connectionAtom.get(), token });
  }
}

export const giteaConnectionStore = new GiteaConnectionStore();
