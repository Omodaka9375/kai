import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Persona scratch workspace - policy contract.
 *
 * The user-specified policy:
 *   - reads (read_file / list_directory): ANYWHERE on the machine, through
 *     the production security deny-lists (.env, .ssh, credentials...)
 *   - writes (write_file): ONLY inside the persona's scratch dir
 *
 * The write confinement rides the production readOnly sandbox override,
 * so these tests pin the WIRING (override shape + call order) and the pure
 * path math; the full deny-list matrix is already covered by security's
 * own tests and not duplicated here.
 */

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "C:/Users/test",
}));

const readFileMock = vi.fn(async (_p: string): Promise<import("./native").ReadResult> => ({
  kind: "text",
  content: "file content",
  size: 12,
}));
const writeFileMock = vi.fn(async (_p: string, _c: string): Promise<void> => undefined);
const readDirMock = vi.fn(async (_p: string): Promise<import("./native").DirEntry[]> => [
  { name: "notes.md", kind: "file", size: 10, mtime: 0 },
  { name: "drafts", kind: "dir", size: 0, mtime: 0 },
]);
const deleteFileMock = vi.fn(async (_p: string): Promise<void> => undefined);
const canonicalizeMock = vi.fn(async (p: string): Promise<string> => p);

vi.mock("./native", () => ({
  native: {
    readFile: (...a: unknown[]) => readFileMock(...(a as [string])),
    writeFile: (...a: unknown[]) => writeFileMock(...(a as [string, string])),
    readDir: (...a: unknown[]) => readDirMock(...(a as [string])),
    deleteFile: (...a: unknown[]) => deleteFileMock(...(a as [string])),
    canonicalize: (...a: unknown[]) => canonicalizeMock(...(a as [string])),
  },
}));

import {
  buildPersonaTools,
  personaPathWithin,
  personaWorkspaceRoot,
  resolvePersonaPathForTest,
  sweepPersonaWorkspace,
} from "./personaWorkspace";

const ROOT = "C:/Users/test/.kai/personas/deadbeef";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("scratch dir resolution", () => {
  it("roots under ~/.kai/personas/<hash> and caches", async () => {
    const a = await personaWorkspaceRoot("builtin:reviewer");
    const b = await personaWorkspaceRoot("builtin:reviewer");
    expect(a).toMatch(/\/\.kai\/personas\/[0-9a-f]+$/);
    expect(a).toBe(b);
  });
});

describe("write policy - confined to scratch", () => {
  it("allows a write inside the scratch dir (absolute)", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.write_file!.execute({
      path: `${ROOT}/draft.md`,
      content: "hi",
    } as never)) as { path?: string; error?: string };
    expect(out.error).toBeUndefined();
    expect(writeFileMock).toHaveBeenCalledWith(`${ROOT}/draft.md`, "hi");
  });

  it("allows a relative write resolved against the scratch root", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    await tools.write_file!.execute({
      path: "notes/todo.md",
      content: "hi",
    } as never);
    expect(writeFileMock).toHaveBeenCalledWith(`${ROOT}/notes/todo.md`, "hi");
  });

  it("REFUSES a write outside the scratch dir (absolute elsewhere)", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.write_file!.execute({
      path: "C:/Code/victim-app/src/main.rs",
      content: "rm everything",
    } as never)) as { error?: string };
    expect(out.error).toBeDefined();
    expect(out.error).toMatch(/[Ss]andbox|not allowed/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("REFUSES a traversal escape from inside the scratch dir", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.write_file!.execute({
      path: "../../../Code/victim-app/evil.txt",
      content: "x",
    } as never)) as { error?: string };
    expect(out.error).toBeDefined();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("sensitive basenames are refused even inside the scratch dir", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.write_file!.execute({
      path: "notes/.env",
      content: "KEY=1",
    } as never)) as { error?: string };
    expect(out.error).toBeDefined();
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe("read policy - anywhere, through security", () => {
  it("reads an absolute path OUTSIDE the scratch dir (the point of the feature)", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.read_file!.execute({
      path: "C:/Code/victim-app/README.md",
    } as never)) as { content?: string; error?: string };
    expect(out.error).toBeUndefined();
    expect(out.content).toBe("file content");
    expect(readFileMock).toHaveBeenCalled();
  });

  it("refuses reads of credential paths (.ssh)", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.read_file!.execute({
      path: "C:/Users/test/.ssh/id_rsa",
    } as never)) as { error?: string };
    expect(out.error).toBeDefined();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("refuses .env reads anywhere", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const out = (await tools.read_file!.execute({
      path: "C:/Code/victim-app/.env",
    } as never)) as { error?: string };
    expect(out.error).toBeDefined();
  });

  it("list_directory defaults to the scratch root and accepts absolutes", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    const rel = (await tools.list_directory!.execute({} as never)) as {
      entries?: Array<{ name: string }>;
    };
    expect(rel.entries!.map((e) => e.name)).toContain("notes.md");
    const abs = (await tools.list_directory!.execute({
      path: "C:/Code/victim-app",
    } as never)) as { entries?: Array<{ name: string }> };
    expect(abs.entries).toBeDefined();
  });

  it("binary and oversized reads return structured errors, not throws", async () => {
    const tools = buildPersonaTools("builtin:reviewer", ROOT);
    readFileMock.mockResolvedValueOnce({ kind: "binary", size: 4096 });
    const bin = (await tools.read_file!.execute({
      path: `${ROOT}/blob.bin`,
    } as never)) as { error?: string };
    expect(bin.error).toMatch(/binary/);
    readFileMock.mockResolvedValueOnce({ kind: "toolarge", size: 99, limit: 1 });
    const big = (await tools.read_file!.execute({
      path: `${ROOT}/huge.txt`,
    } as never)) as { error?: string };
    expect(big.error).toMatch(/too large/);
  });
});

describe("sweep", () => {
  it("deletes the scratch dir best-effort", async () => {
    await sweepPersonaWorkspace("builtin:reviewer");
    expect(deleteFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/\.kai\/personas\/[0-9a-f]+$/),
    );
  });
});

describe("source pins - wiring", () => {
  it("the store wires persona tools into the run with fencing + redaction + step cap", () => {
    const store = readFileSync(new URL("../store/groupChatStore.ts", import.meta.url), "utf8");
    expect(store).toContain("buildPersonaTools(agentId, scratchRoot)");
    expect(store).toContain("withToolGuard(");
    expect(store).toContain("withToolRedaction(");
    expect(store).toContain("PERSONA_MAX_STEPS");
    expect(store).toContain("sweepPersonaWorkspace");
  });

  it("the workspace policy is reads-anywhere / writes-scratch-only", () => {
    const ws = readFileSync(new URL("./personaWorkspace.ts", import.meta.url), "utf8");
    // The readOnly override IS the write policy.
    expect(ws).toContain('mode: "readOnly"');
    // Reads pass through the production canonical security check.
    expect(ws).toContain("checkReadableCanonical");
    expect(ws).toContain("checkWritableCanonical");
  });

  it("pure containment math: absolute outside, traversal blocked", () => {
    expect(personaPathWithin("C:/Code/app", ROOT)).toBe(false);
    expect(personaPathWithin(`${ROOT}/sub/file`, ROOT)).toBe(true);
    if (resolvePersonaPathForTest) {
      const esc = resolvePersonaPathForTest(ROOT, "../../escape");
      expect(personaPathWithin(esc, ROOT)).toBe(false);
    }
  });
});
