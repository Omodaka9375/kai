/**
 * Model fit check runner — drives the SELECTED model through KAI's real
 * agent loop (streamText + real tool schemas) against throwaway fixture
 * projects, then grades the RESULTING ENVIRONMENT (not the model's claims).
 *
 * Isolation:
 *   - per-run temp dir under the OS temp root
 *   - workspaceOnly sandbox override pinned to that dir (same mechanism the
 *     Telegram assistant uses) — writes/shell confined to the fixture
 *   - tool subset: fs + edit only; no MCP, web, memory, terminal, secrets
 *   - shell (verification runs) is the harness's own native.runCommand, NOT
 *     a model-callable tool — the model never executes arbitrary commands
 *   - hard time cap per mission + overall
 *
 * Local models: all three missions run SEQUENTIALLY (a local server usually
 * cannot take three parallel streams). Hosted providers run them in
 * parallel — the 60–90s target budget.
 */

import { streamText, stepCountIs, type LanguageModel } from "ai";
import { homeDir } from "@tauri-apps/api/path";
import type { ToolContext } from "../../tools/context";
import { native } from "../native";
import { FileTracker } from "../fileTracker";
import {
  allFixtures,
  fitCheckVerifyCommand,
  makeFitCheckSeed,
  type FitFixture,
} from "./fixtures";
import {
  gradeMission,
  type MissionResult,
  type MissionVerdict,
  type RecordedCall,
} from "./grader";
import { buildFsTools } from "../../tools/fs";
import { buildEditTools } from "../../tools/edit";
import { withToolRedaction } from "../toolFencing";

export type FitCheckMissionReport = {
  fixtureId: FitFixture["id"];
  title: string;
  verdict: MissionVerdict;
  durationMs: number;
  /** Tool calls in order — for the trace view. */
  calls: RecordedCall[];
  /** Final assistant text (trimmed). */
  finalText: string;
};

export type FitCheckReport = {
  modelId: string;
  provider: string;
  thinkingMode: string;
  /** "ready" | "flaky" | "chat-only" | "not-recommended" | "inconclusive" */
  verdict: "ready" | "flaky" | "chat-only" | "not-recommended" | "inconclusive";
  verdictLabel: string;
  missions: FitCheckMissionReport[];
  totalDurationMs: number;
  timeToFirstTokenMs: number | null;
  outputTokensPerSec: number | null;
  totalTokens: number | null;
  /** Short why-line for the verdict banner. */
  summary: string;
};

const FIT_CHECK_MAX_STEPS = 8;
const MISSION_TIMEOUT_MS = 120_000;

export type FitCheckOptions = {
  model: LanguageModel;
  modelId: string;
  provider: string;
  thinkingMode?: string;
  /** True for local endpoints (LM Studio / custom) — sequential missions. */
  local: boolean;
  abortSignal?: AbortSignal;
  onProgress?: (label: string) => void;
};

/** Harness-side run of the fixture's tests. Never model-callable: uses the
 *  ambient native client directly with the fixture root as both cwd and
 *  sandbox root. Explicit test-file paths (not a dir) — `node --test <dir>` was observed to treat the dir itself as a test entry and fail. */
async function runFixtureTests(
  fixture: FitFixture,
  root: string,
): Promise<{ exitCode: number | null; stdout: string } | null> {
  // Relative forward-slash paths: node accepts them on every platform and
  // they need no quoting (fixture paths never contain spaces).
  const testFiles = fixture.files
    .filter((f) => /\.test\.js$/.test(f.path))
    .map((f) => f.path);
  if (testFiles.length === 0) return null;
  const out = await native.runCommand(
    `node --test ${testFiles.join(" ")}`,
    root,
    30,
    root,
  );
  return { exitCode: out.exit_code, stdout: out.stdout };
}

/** The separator a base path implies (tempRoot arrives forward-normalized). */
function sepOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

async function runOneMission(
  fixture: FitFixture,
  root: string,
  opts: FitCheckOptions,
  injectErr: { tool: string; error: string } | undefined,
): Promise<MissionResult> {
  const calls: RecordedCall[] = [];
  const fileTracker = new FileTracker();
  const before = new Map<string, number>();
  // Pre-hash every fixture file.
  for (const f of fixture.files) {
    const abs = joinPath(root, f.path);
    const bytes = await native.readFileBytes(abs);
    let h = 5381;
    for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) | 0;
    before.set(f.path, h);
  }

  const ctx: ToolContext = {
    getCwd: () => root,
    getWorkspaceRoot: () => root,
    getRealWorkspaceRoot: () => root,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    writeToActiveTerminalDisplay: () => false,
    openPreview: () => false,
    readCache: new Map(),
    getSessionId: () => null,
    fileTracker,
    getSandboxOverride: () => ({ root, mode: "workspaceOnly" }),
  };

  // Minimal tool subset with recording + injected-error wrapping.
  const fsTools = buildFsTools(ctx);
  const editTools = buildEditTools(ctx);
  const raw: Record<string, unknown> = {
    ...fsTools,
    ...editTools,
  };
  let firstEditInjected = false;
  let firstEditInput: string | null = null;
  let recoveredAfterInjectedError: boolean | null = null;
  let repeatedIdenticalCall: boolean | null = null;

  const tools: Record<string, unknown> = {};
  for (const [name, toolObj] of Object.entries(raw)) {
    const anyTool = toolObj as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    tools[name] = {
      ...(toolObj as object),
      execute: async (input: unknown, options?: unknown) => {
        calls.push({ tool: name, executed: true });
        // Injected-error drill: first edit/multi_edit call returns a stale-
        // anchor error; a retry with a DIFFERENT input counts as recovery.
        if (
          injectErr &&
          !firstEditInjected &&
          (name === "edit" || name === "multi_edit")
        ) {
          firstEditInjected = true;
          firstEditInput = JSON.stringify(input);
          calls[calls.length - 1] = { tool: name, executed: false };
          if (calls.length >= 2) {
            recoveredAfterInjectedError = false;
            repeatedIdenticalCall = null;
          }
          return { error: injectErr.error };
        }
        if (
          injectErr &&
          firstEditInjected &&
          (name === "edit" || name === "multi_edit") &&
          recoveredAfterInjectedError === false
        ) {
          const current = JSON.stringify(input);
          repeatedIdenticalCall = current === firstEditInput;
          recoveredAfterInjectedError = !repeatedIdenticalCall;
        }
        return anyTool.execute(input, options);
      },
    };
  }

  const redacted = withToolRedaction(tools);

  let finalText = "";
  let infrastructureError: string | null = null;
  try {
    const result = streamText({
      model: opts.model,
      system:
        "You are a coding agent operating in a small fixture project. Follow the user's instructions exactly. Use the provided tools; do not attempt shell access. Be terse.",
      prompt: fixture.prompt,
      tools: redacted as Parameters<typeof streamText>[0]["tools"],
      stopWhen: stepCountIs(FIT_CHECK_MAX_STEPS),
      abortSignal: opts.abortSignal,
      onFinish: async (event) => {
        finalText = event.text ?? "";
      },
    });
    await result.text;
  } catch (e) {
    infrastructureError = String(e);
  }

  // Post-run file states.
  const files: MissionResult["files"] = [];
  for (const [rel, oldHash] of before) {
    const abs = joinPath(root, rel);
    let changed = true;
    try {
      const bytes = await native.readFileBytes(abs);
      let h = 5381;
      for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) | 0;
      changed = h !== oldHash;
    } catch {
      changed = true;
    }
    files.push({ path: rel, changed });
  }

  // Independent verification — never trust the model.
  let testOutput: MissionResult["testOutput"] = null;
  const verify = fitCheckVerifyCommand(fixture);
  if (verify) {
    try {
      testOutput = await runFixtureTests(fixture, root);
    } catch (e) {
      infrastructureError ??= String(e);
    }
  }

  return {
    fixture,
    testOutput,
    finalText,
    files,
    calls,
    recoveredAfterInjectedError,
    repeatedIdenticalCall,
    infrastructureError,
  };
}

function joinPath(root: string, rel: string): string {
  const sep = sepOf(root);
  const relNorm = sep === "\\" ? rel.replace(/\//g, "\\") : rel;
  return root.endsWith(sep) ? root + relNorm : root + sep + relNorm;
}

/**
 * Parent directories a fixture needs, DEDUPED and in creation order.
 * fs_create_dir refuses existing paths, so sibling files sharing a
 * directory (src/math.js + src/math.test.js) must yield ONE entry —
 * the "already exists" crash from the first shipped version.
 */
export function fixtureParentDirs(
  fixture: Pick<FitFixture, "files">,
  root: string,
): string[] {
  const sep = sepOf(root);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of fixture.files) {
    const abs = joinPath(root, f.path);
    const dir = abs.substring(0, abs.lastIndexOf(sep));
    if (dir && dir !== root && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}
export async function runFitCheck(
  opts: FitCheckOptions,
): Promise<FitCheckReport> {
  const seed = makeFitCheckSeed();
  const fixtures = allFixtures(seed);
  const started = Date.now();

  // One temp dir per fixture (missions never share state).
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const base = await tempRoot();
  const sep = base.includes("/") ? "/" : "\\";
  const tmpBase = `${base}${sep}kai-fit-check-${stamp}`;
  // Sweep leftovers from earlier runs — a failed run used to leak its tree
  // (cleanup only ran on success). This dir is KAI-owned fit-check temp
  // space; nothing else lives here. Best-effort: a locked file just proceeds.
  try {
    await native.deleteFile(base);
  } catch {
    /* absent or locked — fine */
  }
  await native.createDir(tmpBase);

  const runMission = async (fixture: FitFixture) => {
    opts.onProgress?.(fixture.title);
    const root = `${tmpBase}${sep}${fixture.id}`;
    await native.createDir(root);
    // fs_create_dir refuses existing paths and sibling files share
    // directories — create each parent exactly once per mission.
    const parents = fixtureParentDirs(fixture, root);
    for (const dir of parents) await native.createDir(dir);
    for (const f of fixture.files) {
      const abs = joinPath(root, f.path);
      await native.writeFile(abs, f.content);
    }
    const injectErr =
      fixture.id === "fix-and-recover"
        ? fixture.injectErrorOnFirstCall
        : undefined;
    return {
      fixture,
      result: await runOneMission(fixture, root, opts, injectErr),
    };
  };

  const missionTimeout = async (
    fixture: FitFixture,
    p: Promise<{ fixture: FitFixture; result: MissionResult }>,
  ): Promise<{ fixture: FitFixture; result: MissionResult }> =>
    (await Promise.race([
      p,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), MISSION_TIMEOUT_MS),
      ),
    ])) ?? { fixture, result: emptyFailure(fixture, "timeout") };

  let pairs: { fixture: FitFixture; result: MissionResult }[];
  try {
    if (opts.local) {
      pairs = [];
      for (const f of fixtures) {
        pairs.push(await missionTimeout(f, runMission(f)));
      }
    } else {
      pairs = await Promise.all(
        fixtures.map((f) => missionTimeout(f, runMission(f))),
      );
    }
  } finally {
    // Cleanup runs on FAILURE too — a leaked tree survives only until the
    // next run's sweep above.
    try {
      await native.deleteFile(tmpBase);
    } catch {
      /* best-effort */
    }
  }

  const reports: FitCheckMissionReport[] = pairs.map(({ fixture, result }) => {
    const verdict = gradeMission(result);
    return {
      fixtureId: fixture.id,
      title: fixture.title,
      verdict,
      durationMs: 0,
      calls: result.calls,
      finalText: result.finalText.slice(0, 400),
    };
  });

  const totalDurationMs = Date.now() - started;

  return {
    modelId: opts.modelId,
    provider: opts.provider,
    thinkingMode: opts.thinkingMode ?? "off",
    verdict: deriveVerdict(reports),
    verdictLabel: "",
    missions: reports,
    totalDurationMs,
    timeToFirstTokenMs: null,
    outputTokensPerSec: null,
    totalTokens: null,
    summary: deriveSummary(reports),
  };
}

function emptyFailure(fixture: FitFixture, why: string): MissionResult {
  return {
    fixture,
    testOutput: null,
    finalText: "",
    files: fixture.files.map((f) => ({ path: f.path, changed: false })),
    calls: [],
    recoveredAfterInjectedError: null,
    repeatedIdenticalCall: null,
    infrastructureError: why,
  };
}

function deriveVerdict(reports: FitCheckMissionReport[]): FitCheckReport["verdict"] {
  const coding = reports.filter(
    (r) => r.fixtureId !== "read-only-control",
  );
  const control = reports.find((r) => r.fixtureId === "read-only-control");
  const infraFailed = reports.every((r) => !r.verdict.pass);
  if (infraFailed) {
    const allInfra = reports.every(
      (r) => r.verdict.reason?.startsWith("Infrastructure error") === true,
    );
    if (allInfra) return "inconclusive";
  }
  if (coding.length === 2 && coding.every((r) => r.verdict.pass)) {
    return control?.verdict.pass ? "ready" : "ready";
  }
  if (coding.some((r) => r.verdict.pass)) return "flaky";
  // No coding pass. Did it at least answer the control correctly?
  if (control?.verdict.pass) return "chat-only";
  return "not-recommended";
}

function deriveSummary(reports: FitCheckMissionReport[]): string {
  const passed = reports.filter((r) => r.verdict.pass).length;
  return `${passed}/${reports.length} missions passed`;
}

async function tempRoot(): Promise<string> {
  // Tauri homeDir() — canonical, cross-platform. Fixtures live under
  // ~/.kai/fitcheck/ so nothing lands in the user's workspace or git tree.
  const home = await homeDir();
  const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${homeNorm}/.kai/fitcheck`;
}