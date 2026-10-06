export type RemoteWebHost = "github" | "gitlab" | "bitbucket";

export type RemoteWebInfo = {
  host: RemoteWebHost;
  hostname: string;
  owner: string;
  repo: string;
  baseUrl: string;
};

const SUPPORTED_HOSTS: Record<string, RemoteWebHost> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "www.bitbucket.org": "bitbucket",
};

export function parseRemoteWebUrl(raw: string | null | undefined): RemoteWebInfo | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let hostname: string;
  let pathname: string;

  const scpMatch = trimmed.match(/^([^@]+@)?([^:]+):(.+)$/);
  if (scpMatch && !/^https?:\/\//i.test(trimmed) && !trimmed.startsWith("/")) {
    hostname = scpMatch[2];
    pathname = scpMatch[3];
  } else {
    try {
      const url = new URL(trimmed);
      hostname = url.hostname;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  const host = SUPPORTED_HOSTS[hostname.toLowerCase()];
  if (!host) return null;

  const parts = pathname
    .replace(/^\//, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  return {
    host,
    hostname: hostname.toLowerCase(),
    owner,
    repo,
    baseUrl: `https://${hostname.toLowerCase()}/${owner}/${repo}`,
  };
}

export function commitWebUrl(info: RemoteWebInfo, sha: string): string {
  switch (info.host) {
    case "github":
      return `${info.baseUrl}/commit/${sha}`;
    case "gitlab":
      return `${info.baseUrl}/-/commit/${sha}`;
    case "bitbucket":
      return `${info.baseUrl}/commits/${sha}`;
  }
}

/** New-PR / merge-request URL for a pushed branch. Pre-fills title + body
 *  via query params where the host supports it (GitHub, GitLab; Bitbucket
 *  has no title/body pre-fill). */
export function createPullRequestUrl(
  info: RemoteWebInfo,
  branch: string,
  base?: string | null,
  title?: string,
  body?: string,
): string {
  const enc = encodeURIComponent;
  switch (info.host) {
    case "github": {
      const params = new URLSearchParams({ expand: "1" });
      if (title) params.set("title", title);
      if (body) params.set("body", body);
      return `${info.baseUrl}/compare/${enc(base ?? "main")}...${enc(branch)}?${params.toString()}`;
    }
    case "gitlab": {
      const params = new URLSearchParams();
      params.set("merge_request[source_branch]", branch);
      if (base) params.set("merge_request[target_branch]", base);
      if (title) params.set("merge_request[title]", title);
      return `${info.baseUrl}/-/merge_requests/new?${params.toString()}`;
    }
    case "bitbucket": {
      const params = new URLSearchParams();
      params.set("source", branch);
      if (base) params.set("dest", base);
      return `${info.baseUrl}/branch/pull-request/new?${params.toString()}`;
    }
  }
}

export function hostLabel(info: RemoteWebInfo): string {
  switch (info.host) {
    case "github":
      return "View on GitHub";
    case "gitlab":
      return "View on GitLab";
    case "bitbucket":
      return "View on Bitbucket";
  }
}
