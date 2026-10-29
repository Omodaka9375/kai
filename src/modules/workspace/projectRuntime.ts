import { createNative, type NativeClient } from "@/modules/ai/lib/native";
import { normalizeWorkspacePath } from "@/modules/ai/lib/workspacePath";
import { LOCAL_WORKSPACE, workspaceScopeKey, type WorkspaceEnv } from "./env";

/** Stable identity for one local/WSL project workspace. Root alone is not
 * enough: the same-looking path can belong to different WSL distros. */
export function projectIdFor(root: string, env: WorkspaceEnv): string {
  return `${workspaceScopeKey(env)}:${normalizeWorkspacePath(root)}`;
}

export type ProjectRuntime = {
  id: string;
  root: string;
  env: WorkspaceEnv;
  native: NativeClient;
};

export function createProjectRuntime(root: string, env: WorkspaceEnv = LOCAL_WORKSPACE): ProjectRuntime {
  // Preserve the REAL path for execution (Linux/WSL are case-sensitive).
  // Case-folded normalization is used only by projectIdFor for identity.
  const canonicalRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    id: projectIdFor(canonicalRoot, env),
    root: canonicalRoot,
    env,
    native: createNative(() => env),
  };
}

// React context lives in runtimeContext.ts so native/tool modules never pull
// React or the workspace barrel into their dependency graph.
