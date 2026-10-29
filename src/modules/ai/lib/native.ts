import { Channel, invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace/env";

export type ReadResult =
  | { kind: "text"; content: string; size: number; format?: string }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

export type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  /** Remote's default branch (e.g. "main"); null when no remote HEAD. */
  defaultBranch: string | null;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

/** What a pull actually did — so the UI can report counts. */
export type GitPullResult = {
  pulledCommits: number;
  upToDate: boolean;
  mergeCommit: string | null;
};

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string | null;
};

export type GitConflictRegion = {
  line: number;
};

export type GitConflictFile = {
  path: string;
  regions: GitConflictRegion[];
};

export type GpgKey = {
  fingerprint: string;
  keyId: string;
  name: string;
  emails: string[];
};

export type GpgStatus = {
  available: boolean;
  program: string | null;
  version: string | null;
  error: string | null;
};

export type SandboxMode = "off" | "readOnly" | "workspaceOnly";

export type SandboxConfig = {
  mode: SandboxMode;
};

export type SandboxStatus = {
  landlock: boolean;
  bwrap: boolean;
  sandboxExec: boolean;
  wsl: boolean;
  wslDistro: boolean;
  kaiSandboxDistro: boolean;
  kernel: string | null;
};

export type SandboxSetupEvent = {
  phase: "download" | "import" | "done";
  downloaded: number;
  total: number;
  message: string | null;
};

export type VoiceStatus = {
  sttInstalled: boolean;
  ttsInstalled: boolean;
  sttModel: string | null;
  /** First installed TTS voice (legacy single-field view). */
  ttsVoice: string | null;
  /** Every voice currently on disk — the selected voice must be in here. */
  ttsVoices: string[];
};

export type VoiceSetupEvent = {
  phase: string;
  downloaded: number;
  total: number;
  message: string | null;
};

export type ShadowInfo = {
  projectRoot: string;
  shadowRoot: string;
  createdAtMs: number;
  sharedDirs: string[];
};

export type ShadowMergeReport = {
  copied: string[];
  deletedInShadow: string[];
  conflicts: string[];
};

export type MonitorInfo = {
  /** "0"-based index in left-to-right order — the tool's stable selector. */
  id: string;
  name: string;
  isPrimary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SpreadsheetSheet = {
  name: string;
  rows: string[][];
  startRow: number;
  startCol: number;
};

export type SpreadsheetData = {
  sheetNames: string[];
  activeSheet: number;
  sheets: SpreadsheetSheet[];
};

export type ScreenCapture = {
  /** Temp JPEG path (forward slashes). Reader must delete it after use. */
  path: string;
  monitor: MonitorInfo;
  width: number;
  height: number;
  sizeBytes: number;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export type GitStashEntry = {
  index: number;
  shortSha: string;
  subject: string;
  refName: string;
};

/** Build a native client whose environment is captured at construction.
 * Background project work must never consult the currently visible project's
 * environment midway through a tool call. `native` below remains the legacy
 * active-window client for global UI surfaces. */
export function createNative(getEnv: () => WorkspaceEnv) {
  const env = getEnv;
  return {
    env: getEnv(),
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: env(),
    }),
  readFile: (path: string, extract?: boolean) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: env(),
      extract: extract ?? false,
    }),
  /** Extract dimensions + OCR text from in-memory image bytes (no temp
   *  file management on the JS side — Rust owns the temp file). */
  extractImageBytes: (bytes: Uint8Array) =>
    invoke<
      | { format: string; meta: [string, string][]; content: string; size: number }
      | null
    >("fs_extract_image_bytes", {
      bytes: bytes as unknown as number[],
    }),
  writeFile: (path: string, content: string) =>
    invoke<void>("fs_write_file", {
      path,
      content,
      workspace: env(),
    }),
  writeFileBytes: (path: string, bytes: number[]) =>
    invoke<void>("fs_write_file_bytes", {
      path,
      bytes,
      workspace: env(),
    }),
    readFileBytes: (path: string) =>
    invoke<number[]>("fs_read_file_bytes", {
      path,
      workspace: env(),
    }),
  parseSpreadsheet: (path: string) =>
    invoke<SpreadsheetData>("fs_parse_spreadsheet", {
      path,
      workspace: env(),
    }), canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace: env(),
    }),
  createFile: (path: string) =>
    invoke<void>("fs_create_file", { path, workspace: env() }),
  createDir: (path: string) =>
    invoke<void>("fs_create_dir", { path, workspace: env() }),
  deleteFile: (path: string) =>
    invoke<void>("fs_delete", { path, workspace: env() }),
  // AI tooling never sees dot-prefixed entries regardless of the user's
  // explorer preference — keeps .git / .env / .ssh out of agent context.
  readDir: (path: string) =>
    invoke<DirEntry[]>("fs_read_dir", {
      path,
      showHidden: false,
      workspace: env(),
    }),
  grep: (params: {
    pattern: string;
    root: string;
    glob?: string[];
    caseInsensitive?: boolean;
    maxResults?: number;
  }) =>
    invoke<GrepResponse>("fs_grep", {
      pattern: params.pattern,
      root: params.root,
      glob: params.glob ?? null,
      caseInsensitive: params.caseInsensitive ?? null,
      maxResults: params.maxResults ?? null,
      workspace: env(),
    }),
  glob: (params: { pattern: string; root: string; maxResults?: number }) =>
    invoke<GlobResponse>("fs_glob", {
      pattern: params.pattern,
      root: params.root,
      maxResults: params.maxResults ?? null,
      workspace: env(),
    }),
  runCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
    sandboxRoot?: string | null,
  ) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: env(),
      sandboxRoot: sandboxRoot ?? null,
    }),
  runElevatedCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<CommandOutput>("shell_run_elevated", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: env(),
    }),

  shellSessionOpen: (cwd?: string | null) =>
    invoke<number>("shell_session_open", {
      cwd: cwd ?? null,
      workspace: env(),
    }),
  shellSessionRun: (
    id: number,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
    sandboxRoot?: string | null,
  ) =>
    invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      cancelled: boolean;
      truncated: boolean;
      cwd_after: string;
    }>("shell_session_run", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: env(),
      sandboxRoot: sandboxRoot ?? null,
    }),
  shellSessionClose: (id: number) =>
    invoke<void>("shell_session_close", { id }),
  shellSessionCancel: (id: number) =>
    invoke<void>("shell_session_cancel", { id }),
  /** Rust-driven 1s tick for the watch scheduler — immune to WebView2's
   *  hidden-page timer throttling. See modules/heartbeat.rs. */
  watchHeartbeat: (onTick: unknown) =>
    invoke<void>("watch_heartbeat", { onTick }),
  // ── Voice (local engines: whisper.cpp STT + Piper TTS) ──
  voiceStatus: () => invoke<VoiceStatus>("voice_status"),
  voiceSetupStt: (model: string, onEvent: unknown) =>
    invoke<void>("voice_setup_stt", { model, onEvent }),
  voiceSetupTts: (voice: string, onEvent: unknown) =>
    invoke<void>("voice_setup_tts", { voice, onEvent }),
  voiceRemoveLocal: () => invoke<void>("voice_remove_local"),
  voiceTranscribe: (audioBase64: string) =>
    invoke<string>("voice_transcribe", { audioBase64 }),
  voiceTts: (text: string, voice?: string) =>
    invoke<string>("voice_tts", { text, voice: voice ?? null }),
  shellBgSpawn: (
    command: string,
    cwd?: string | null,
    owner?: string,
    label?: string,
    sandboxRoot?: string | null,
  ) =>
    invoke<number>("shell_bg_spawn", {
      command,
      cwd: cwd ?? null,
      workspace: env(),
      owner: owner ?? null,
      label: label ?? null,
      sandboxRoot: sandboxRoot ?? null,
    }),
  shellBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
  shellBgReap: (owner: string) => invoke<number>("shell_bg_reap", { owner }),
  shellBgList: () =>
    invoke<
      {
        handle: number;
        command: string;
        cwd: string | null;
        started_at_ms: number;
        exited: boolean;
        exit_code: number | null;
      }[]
    >("shell_bg_list"),
  gitResolveRepo: (cwd: string) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: env(),
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: env(),
    }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: env(),
    }),
  gitDiff: (repoRoot: string, path: string | null, staged: boolean) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      staged,
      workspace: env(),
    }),
  gitDiffContent: (
    repoRoot: string,
    path: string,
    staged: boolean,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      staged,
      originalPath: originalPath ?? null,
      workspace: env(),
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: env(),
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: env(),
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: env(),
    }),
  gitStashList: (repoRoot: string) =>
    invoke<GitStashEntry[]>("git_stash_list", {
      repoRoot,
      workspace: env(),
    }),
  gitStashPush: (repoRoot: string, message?: string | null) =>
    invoke<void>("git_stash_push", {
      repoRoot,
      message: message ?? null,
      workspace: env(),
    }),
  gitStashPop: (repoRoot: string, index: number) =>
    invoke<void>("git_stash_pop", {
      repoRoot,
      index,
      workspace: env(),
    }),
  gitStashApply: (repoRoot: string, index: number) =>
    invoke<void>("git_stash_apply", {
      repoRoot,
      index,
      workspace: env(),
    }),
  gitStashDrop: (repoRoot: string, index: number) =>
    invoke<void>("git_stash_drop", {
      repoRoot,
      index,
      workspace: env(),
    }),
  gitCommit: (
    repoRoot: string,
    message: string,
    opts?: { sign?: boolean; signingKey?: string | null },
  ) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      sign: opts?.sign ?? false,
      signingKey: opts?.signingKey ?? null,
      workspace: env(),
    }),
  gitConfigGet: (key: string) =>
    invoke<string | null>("git_config_get", {
      key,
      workspace: env(),
    }),
  gitConfigSet: (key: string, value: string) =>
    invoke<void>("git_config_set", {
      key,
      value,
      workspace: env(),
    }),
  gitConfigUnset: (key: string) =>
    invoke<void>("git_config_unset", {
      key,
      workspace: env(),
    }),
  gpgStatus: () =>
    invoke<GpgStatus>("gpg_status", { workspace: env() }),
  sandboxStatus: () => invoke<SandboxStatus>("sandbox_status"),
  sandboxLoadConfig: (root: string) =>
    invoke<SandboxConfig>("sandbox_load_config", {
      root,
      workspace: env(),
    }),
  sandboxSaveConfig: (root: string, mode: SandboxMode) =>
    invoke<void>("sandbox_save_config", {
      root,
      mode,
      workspace: env(),
    }),
  sandboxWslSetup: (onEvent: Channel<SandboxSetupEvent>) =>
    invoke<void>("sandbox_wsl_setup", { onEvent }),
  sandboxWslRemove: () => invoke<void>("sandbox_wsl_remove"),
  shadowStatus: (projectRoot: string) =>
    invoke<ShadowInfo | null>("shadow_status", { projectRoot }),
  shadowCreate: (projectRoot: string) =>
    invoke<ShadowInfo>("shadow_create", { projectRoot }),
  shadowMerge: (projectRoot: string, dryRun: boolean) =>
    invoke<ShadowMergeReport>("shadow_merge", { projectRoot, dryRun }),
  shadowDiscard: (projectRoot: string) =>
    invoke<void>("shadow_discard", { projectRoot }),
  gpgListKeys: () =>
    invoke<GpgKey[]>("gpg_list_keys", { workspace: env() }),
  gpgExportPublic: (fingerprint: string) =>
    invoke<string>("gpg_export_public", {
      fingerprint,
      workspace: env(),
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: env(),
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<GitPullResult>("git_pull_ff_only", {
      repoRoot,
      workspace: env(),
    }),
  gitPull: (repoRoot: string) =>
    invoke<GitPullResult>("git_pull", {
      repoRoot,
      workspace: env(),
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: env(),
    }),
  gitLog: (repoRoot: string, options?: { limit?: number; beforeSha?: string }) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace: env(),
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: env(),
    }),
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace: env(),
    }),
  gitCommitMessage: (repoRoot: string, sha: string) =>
    invoke<string>("git_commit_message", {
      repoRoot,
      sha,
      workspace: env(),
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
      workspace: env(),
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace: env(),
    }),
  gitListBranches: (repoRoot: string) =>
    invoke<GitBranch[]>("git_list_branches", {
      repoRoot,
      workspace: env(),
    }),
  gitListConflicts: (repoRoot: string) =>
    invoke<GitConflictFile[]>("git_list_conflicts", {
      repoRoot,
      workspace: env(),
    }),
  screenListMonitors: () => invoke<MonitorInfo[]>("screen_list_monitors"),
  screenCapture: (selector?: string | null) =>
    invoke<ScreenCapture>("screen_capture", { selector: selector ?? null }),
  gitSwitchBranch: (repoRoot: string, name: string) =>
    invoke<void>("git_switch_branch", {
      repoRoot,
      name,
      workspace: env(),
    }),
  gitCreateBranch: (repoRoot: string, name: string) =>
    invoke<void>("git_create_branch", {
      repoRoot,
      name,
      workspace: env(),
    }),
  gitDeleteBranch: (repoRoot: string, name: string) =>
    invoke<void>("git_delete_branch", {
      repoRoot,
      name,
      workspace: env(),
    }),
  };
}

export type NativeClient = ReturnType<typeof createNative>;
export const native = createNative(currentWorkspaceEnv);
