import { useStore } from '@nanostores/react';
import { motion } from 'framer-motion';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ConnectorActionPermissions,
  getConnectorPermissionKey,
} from '~/components/@settings/shared/ConnectorActionPermissions';
import { DEFAULT_GITEA_BASE_URL } from '~/lib/services/giteaApiService';
import { giteaConnection, giteaConnectionStore } from '~/lib/stores/giteaConnection';
import { useMCPStore } from '~/lib/stores/mcp';

/**
 * Gitea, as a connector page.
 *
 * The shape is the GitLab page's — address and token, then the account, then what
 * the account can see — because the two products are the same kind of thing: a
 * self-hosted forge whose API answers at `/api/v1`. What differs is the hop: Gitea
 * sends no CORS headers, so every call goes through this app's `/api/gitea` proxy
 * (`app/routes/api.gitea.ts`) rather than from the browser.
 *
 * The address is a field rather than a constant. `https://gitlab.innotel.us` is the
 * estate's instance and therefore the default, but a connector that can only reach
 * one host is not a connector.
 */

const GiteaIcon = () => <div className="i-ph:git-branch w-5 h-5" />;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2">
      <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
      <p className="text-sm font-medium text-bolt-elements-textPrimary">{value}</p>
    </div>
  );
}

export default function GiteaTab() {
  const connection = useStore(giteaConnection);
  const toolEnabled = useMCPStore((state) => state.settings.toolEnabled);
  const permissionsInitialized = useMCPStore((state) => state.isInitialized);
  const initialize = useMCPStore((state) => state.initialize);

  const canReadRepositories =
    permissionsInitialized && toolEnabled[getConnectorPermissionKey('gitea', 'read_repositories')] !== false;

  const [baseUrl, setBaseUrl] = useState(connection.baseUrl || DEFAULT_GITEA_BASE_URL);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    giteaConnectionStore.loadSavedConnection();
  }, []);

  useEffect(() => {
    if (!permissionsInitialized) {
      initialize().catch((cause) => console.error('Could not load connector permissions:', cause));
    }
  }, [initialize, permissionsInitialized]);

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsConnecting(true);

    const result = await giteaConnectionStore.connect(token, baseUrl);

    if (!result.success) {
      setError(result.error ?? 'Gitea rejected this connection.');
      setIsConnecting(false);

      return;
    }

    setToken('');

    if (canReadRepositories) {
      const stats = await giteaConnectionStore.fetchStats();

      if (!stats.success) {
        setError(stats.error ?? 'Connected, but the repositories could not be read.');
      }
    }

    setIsConnecting(false);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);

    const result = await giteaConnectionStore.fetchStats();

    if (!result.success) {
      setError(result.error ?? 'Could not refresh the repositories.');
    }

    setIsRefreshing(false);
  };

  const handleDisconnect = () => {
    giteaConnectionStore.disconnect();
    setError(null);
    setBaseUrl(DEFAULT_GITEA_BASE_URL);
  };

  if (!connection.user) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <GiteaIcon />
          <h2 className="text-lg font-medium text-bolt-elements-textPrimary">Gitea Integration</h2>
        </div>

        <p className="text-sm text-bolt-elements-textSecondary">
          Connect your Gitea instance to list its repositories and account statistics. Works with any Gitea
          installation, including one on your own network.
        </p>

        <form
          onSubmit={(event) => void handleConnect(event)}
          className="space-y-4 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-5"
        >
          <div>
            <label className="mb-2 block text-sm font-medium text-bolt-elements-textPrimary" htmlFor="gitea-base-url">
              Instance address
            </label>
            <input
              id="gitea-base-url"
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_GITEA_BASE_URL}
              className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2 text-sm text-bolt-elements-textPrimary outline-none focus:border-bolt-elements-borderColorActive"
            />
            <p className="mt-1 text-xs text-bolt-elements-textSecondary">
              The root of the instance, not the repository. An instance served under a path prefix (
              <code>https://host/gitea</code>) is fine.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-bolt-elements-textPrimary" htmlFor="gitea-token">
              Access token
            </label>
            <input
              id="gitea-token"
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="A Gitea token with repository read access"
              className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2 text-sm text-bolt-elements-textPrimary outline-none focus:border-bolt-elements-borderColorActive"
            />
            <p className="mt-1 text-xs text-bolt-elements-textSecondary">
              Gitea → Settings → Applications → Generate New Token, with the <code>read:repository</code> scope.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-bolt-elements-icon-error">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isConnecting || !token.trim()}
              className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 px-4 py-2 text-sm font-medium text-bolt-elements-textPrimary transition-colors hover:border-bolt-elements-borderColorActive disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isConnecting ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </form>

        <ConnectorActionPermissions
          connector="gitea"
          actions={[
            {
              id: 'read_repositories',
              name: 'Read repositories and statistics',
              description: 'List your Gitea repositories and count their stars, forks and open issues.',
            },
          ]}
        />
      </div>
    );
  }

  const stats = connection.stats;

  return (
    <div className="space-y-6">
      <motion.div
        className="flex items-center justify-between gap-2"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="flex items-center gap-2">
          <GiteaIcon />
          <h2 className="text-lg font-medium text-bolt-elements-textPrimary">Gitea Integration</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={isRefreshing || !canReadRepositories}
            className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 px-3 py-1.5 text-sm font-medium text-bolt-elements-textSecondary transition-colors hover:border-bolt-elements-borderColorActive hover:text-bolt-elements-textPrimary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={handleDisconnect}
            className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 px-3 py-1.5 text-sm font-medium text-bolt-elements-textSecondary transition-colors hover:border-bolt-elements-borderColorActive hover:text-bolt-elements-textPrimary"
          >
            Disconnect
          </button>
        </div>
      </motion.div>

      <p className="text-sm text-bolt-elements-textSecondary">
        Connected to <span className="text-bolt-elements-textPrimary">{connection.baseUrl}</span>
      </p>

      <ConnectorActionPermissions
        connector="gitea"
        actions={[
          {
            id: 'read_repositories',
            name: 'Read repositories and statistics',
            description: 'List your Gitea repositories and count their stars, forks and open issues.',
          },
        ]}
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex items-center gap-4 rounded-lg bg-bolt-elements-background-depth-1 p-4">
        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border-2 border-bolt-elements-item-contentAccent bg-bolt-elements-background-depth-2">
          {connection.user.avatar_url ? (
            <img
              src={connection.user.avatar_url}
              alt={connection.user.login}
              className="h-full w-full rounded-full object-cover"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <span className="text-sm font-semibold text-white">
              {(connection.user.full_name || connection.user.login).charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div>
          <h4 className="text-sm font-medium text-bolt-elements-textPrimary">
            {connection.user.full_name || connection.user.login}
          </h4>
          <a
            href={connection.user.html_url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
          >
            {connection.user.login}
          </a>
        </div>
      </div>

      {canReadRepositories && stats && (
        <div className="border-t border-bolt-elements-borderColor pt-6">
          <h3 className="mb-3 text-base font-medium text-bolt-elements-textPrimary">Statistics</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Repositories" value={stats.totalRepositories} />
            <Stat label="Private" value={stats.privateRepositories} />
            <Stat label="Public" value={stats.publicRepositories} />
            <Stat label="Stars" value={stats.totalStars} />
            <Stat label="Forks" value={stats.totalForks} />
            <Stat label="Open issues" value={stats.openIssues} />
          </div>
        </div>
      )}

      {canReadRepositories && stats && (
        <div className="border-t border-bolt-elements-borderColor pt-6">
          <h3 className="mb-3 text-base font-medium text-bolt-elements-textPrimary">Repositories</h3>

          {stats.repositories.length === 0 ? (
            <p className="text-sm text-bolt-elements-textSecondary">This account has no repositories yet.</p>
          ) : (
            <ul className="space-y-2">
              {stats.repositories.slice(0, 10).map((repository) => (
                <li
                  key={repository.id}
                  className="flex items-start justify-between gap-4 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <a
                        href={repository.html_url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-sm font-semibold text-bolt-elements-textPrimary hover:underline"
                      >
                        {repository.full_name}
                      </a>
                      {repository.private && (
                        <span className="rounded-full bg-bolt-elements-background-depth-3 px-2 py-0.5 text-[11px] text-bolt-elements-textSecondary">
                          Private
                        </span>
                      )}
                      {repository.language && (
                        <span className="rounded-full bg-bolt-elements-background-depth-3 px-2 py-0.5 text-[11px] text-bolt-elements-textSecondary">
                          {repository.language}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-sm text-bolt-elements-textSecondary">
                      {repository.description || 'No description'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-bolt-elements-textSecondary">
                    <p>
                      ★ {repository.stars_count} · ⑂ {repository.forks_count}
                    </p>
                    <p>{repository.default_branch}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {stats.repositories.length > 10 && (
            <p className="mt-2 text-xs text-bolt-elements-textSecondary">
              Showing the 10 most recently updated of {stats.repositories.length}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
