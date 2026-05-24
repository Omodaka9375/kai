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

/** Fetch a page of MCP servers from the official registry. */
export async function fetchRegistryServers(opts?: {
  search?: string;
  cursor?: string;
  limit?: number;
}): Promise<McpRegistryResponse> {
  const params = new URLSearchParams();
  params.set("version", "latest");
  params.set("limit", String(opts?.limit ?? PAGE_SIZE));
  if (opts?.search) params.set("search", opts.search);
  if (opts?.cursor) params.set("cursor", opts.cursor);

  const resp = await fetch(`${BASE_URL}/servers?${params}`);
  if (!resp.ok) throw new Error(`Registry API error: ${resp.status}`);
  return resp.json();
}
