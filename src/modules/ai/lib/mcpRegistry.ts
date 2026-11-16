const BASE_URL = "https://registry.modelcontextprotocol.io/v0.1";
const PAGE_SIZE = 30;

export type McpRegistryPackage = {
  registryType: string;
  identifier: string;
  version: string;
  runtimeHint?: string;
  runtimeArguments?: { value: string; type: string }[];
  environmentVariables?: {
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
  }[];
  transport: { type: string };
};

export type McpRegistryRemote = {
  type: string;
  url: string;
};

export type McpRegistryServer = {
  name: string;
  title?: string;
  description?: string;
  version: string;
  repository?: { url: string; source?: string };
  websiteUrl?: string;
  packages?: McpRegistryPackage[];
  remotes?: McpRegistryRemote[];
};

export type McpRegistryEntry = {
  server: McpRegistryServer;
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status: string;
      publishedAt: string;
      updatedAt: string;
      isLatest: boolean;
    };
  };
};

export type McpRegistryResponse = {
  servers: McpRegistryEntry[];
  metadata: {
    nextCursor: string | null;
    count: number;
  };
};

/**
 * The runtime command that executes a registry package's identifier.
 *
 * The registry's own `runtimeHint` wins when present. When it's absent
 * (common — the live Browserr entry has none), derive from `registryType`:
 * npm → npx, pypi → uvx (uv's package runner). NO blind "npx" default —
 * Browserr is a pypi package and the old fallback displayed "npx
 * browserr-mcp" in the detail popover AND used it as the actual install
 * command, which would fail (2026-11-16 report). Unknown registry types
 * return null: the caller shows the registry type instead of inventing a
 * command, and stdio install refuses rather than spawning a wrong runtime.
 */
export function runtimeCommandFor(pkg: McpRegistryPackage): string | null {
  if (pkg.runtimeHint) return pkg.runtimeHint;
  switch (pkg.registryType) {
    case "npm":
      return "npx";
    case "pypi":
      return "uvx";
    default:
      return null;
  }
}

/** Fetch a page of MCP servers from the official registry. */
export async function fetchRegistryServers(opts?: {
  search?: string;
  cursor?: string;
  limit?: number;
}): Promise<McpRegistryResponse> {
  const params = new URLSearchParams();
  params.set("version", "latest");
  params.set("limit", String(opts?.limit ?? PAGE_SIZE));
  params.set("_t", String(Date.now()));
  if (opts?.search) params.set("search", opts.search);
  if (opts?.cursor) params.set("cursor", opts.cursor);

  const resp = await fetch(`${BASE_URL}/servers?${params}`, {
    cache: "no-store",
  });
  if (!resp.ok) throw new Error(`Registry API error: ${resp.status}`);
  return resp.json();
}
