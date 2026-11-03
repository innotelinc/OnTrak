/**
 * Gitea's API types, as this app reads them.
 *
 * Gitea is self-hosted by definition, so every connection carries the instance's
 * base URL alongside the token — unlike GitHub's, which is always api.github.com.
 * The fields below are the ones a picker actually draws; Gitea returns more, and
 * the proxy in `app/routes/api.gitea.ts` drops the rest rather than shipping a
 * half-typed copy of the upstream schema through the browser.
 */

export interface GiteaUser {
  id: number;
  login: string;
  full_name: string;
  email: string;
  avatar_url: string;
  html_url: string;
  created: string;
}

export interface GiteaRepository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  fork: boolean;
  stars_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  language: string;
}

export interface GiteaStats {
  repositories: GiteaRepository[];
  totalRepositories: number;
  publicRepositories: number;
  privateRepositories: number;
  totalStars: number;
  totalForks: number;
  openIssues: number;
  lastUpdated: string;
}

export interface GiteaConnection {
  user: GiteaUser | null;
  token: string;
  tokenType: 'access-token';
  baseUrl: string;
  stats?: GiteaStats;
}

export interface GiteaVersion {
  version: string;
}
