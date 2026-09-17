import { describe, expect, it, beforeEach } from "vitest";
import { IS_WINDOWS } from "@/lib/platform";
import {
  __setSandboxModeForTests,
  checkSandbox,
  checkShellSandbox,
  invalidateSandboxCache,
  setSandboxRoot,
  splitShellArgs,
} from "./sandbox";

const ROOT = "/home/user/project";

beforeEach(() => {
  invalidateSandboxCache();
  __setSandboxModeForTests(null, "off");
  setSandboxRoot(null);
});

describe("checkSandbox - fs tool confinement", () => {
  it("no root set = allow everything", async () => {
    setSandboxRoot(null);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
    const r = await checkSandbox("write", "/etc/passwd");
    expect(r.ok).toBe(true);
  });

  it("off mode = allow everything", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "off");
    const r = await checkSandbox("write", "/etc/passwd");
    expect(r.ok).toBe(true);
  });

  it("readOnly: outside write blocked, outside read allowed", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "readOnly");
    expect((await checkSandbox("write", "/etc/passwd")).ok).toBe(false);
    expect((await checkSandbox("read", "/etc/passwd")).ok).toBe(true);
  });

  it("workspaceOnly: outside write AND read blocked, inside allowed", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
    expect((await checkSandbox("write", "/etc/passwd")).ok).toBe(false);
    expect((await checkSandbox("read", "/etc/passwd")).ok).toBe(false);
    expect((await checkSandbox("read", `${ROOT}/src/a.ts`)).ok).toBe(true);
    expect((await checkSandbox("write", `${ROOT}/out.txt`)).ok).toBe(true);
  });

  it("root itself is within", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
    expect((await checkSandbox("read", ROOT)).ok).toBe(true);
  });

  it("prefix is not containment: /home/user/projectX is outside", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
    expect((await checkSandbox("read", `${ROOT}X/file`)).ok).toBe(false);
  });

  it("backslash paths normalized; case rules follow the runtime platform", async () => {
    const winRoot = "C:/Users/me/Project";
    setSandboxRoot("C:\\Users\\me\\Project");
    __setSandboxModeForTests(winRoot, "workspaceOnly");
    // Separator normalization is platform-independent.
    expect((await checkSandbox("read", `${winRoot}/src/a.ts`)).ok).toBe(true);
    expect((await checkSandbox("write", "C:\\Users\\me\\Other\\f.txt")).ok).toBe(false);
    // Case-insensitive compare only on Windows (vitest without the Tauri
    // runtime resolves platform() to "" — same case-sensitive path).
    const mixed = await checkSandbox("read", "c:/users/ME/project/src/a.ts");
    expect(mixed.ok).toBe(IS_WINDOWS);
  });
});

describe("checkShellSandbox - shell command gating", () => {
  it("write-shaped command naming outside path blocked in readOnly", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "readOnly");
    const r = await checkShellSandbox(`cp /etc/hosts ${ROOT}/hosts.copy`);
    expect(r.ok).toBe(false);
  });

  it("read-shaped command naming outside path allowed in readOnly", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "readOnly");
    const r = await checkShellSandbox(`cat /etc/hosts`);
    expect(r.ok).toBe(true);
  });

  it("read-shaped outside path blocked in workspaceOnly", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
    const r = await checkShellSandbox(`cat /etc/hosts`);
    expect(r.ok).toBe(false);
  });

  it("command entirely inside project allowed", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
    expect((await checkShellSandbox(`pnpm test`)).ok).toBe(true);
    expect(
      (await checkShellSandbox(`node ${ROOT}/scripts/build.js --out ${ROOT}/dist`)).ok,
    ).toBe(true);
  });

  it("output redirection outside blocked", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "readOnly");
    const r = await checkShellSandbox(`echo hi > /tmp/x.log`);
    expect(r.ok).toBe(false);
  });

  it("off mode = allow everything", async () => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "off");
    expect((await checkShellSandbox(`rm -rf /etc`)).ok).toBe(true);
  });
});

describe("checkShellSandbox — real-world command regressions (issue: substring tokenizer)", () => {
  // The old tokenizer matched mid-string fragments as path claims and
  // blocked everyday commands in workspaceOnly mode. These are the exact
  // strings that broke.
  beforeEach(() => {
    setSandboxRoot(ROOT);
    __setSandboxModeForTests(ROOT, "workspaceOnly");
  });

  it("relative paths and test globs are not absolute claims", async () => {
    for (const cmd of [
      "pnpm test src/lib/foo.test.ts",
      "cargo build --release",
      "ls src/components",
      "git status",
    ]) {
      expect((await checkShellSandbox(cmd)).ok).toBe(true);
    }
  });

  it("sed expressions, dates, regex args, shebangs in strings are not claims", async () => {
    for (const cmd of [
      "sed 's/foo/bar/' f.txt",
      "date +%Y/%m",
      "grep -E '^/usr' file",
      "echo '#!/usr/bin/env bash' > script.sh",
      "awk '/pattern/{print}' data.txt",
    ]) {
      expect((await checkShellSandbox(cmd)).ok).toBe(true);
    }
  });

  it("URLs are not filesystem claims — even with scheme-like drive letters", async () => {
    for (const cmd of [
      "curl https://github.com/a/b -o out.zip",
      "git clone https://github.com/a/b.git",
      "npm install lodash",
    ]) {
      expect((await checkShellSandbox(cmd)).ok).toBe(true);
    }
  });

  it("real outside claims still block (absolute, home, traversal)", async () => {
    expect((await checkShellSandbox("cat /etc/passwd")).ok).toBe(false);
    expect((await checkShellSandbox("cat ~/.ssh/config")).ok).toBe(false);
    // Traversal escape — relative `..` that leaves the project.
    expect((await checkShellSandbox("cat ../../secrets.txt")).ok).toBe(false);
    // Windows drive letter + real path.
    setSandboxRoot("D:/Code/Proj");
    __setSandboxModeForTests("D:/Code/Proj", "workspaceOnly");
    expect((await checkShellSandbox("cat C:/Windows/win.ini")).ok).toBe(false);
    expect((await checkShellSandbox("cat D:/Code/Proj/src/a.ts")).ok).toBe(true);
  });

  it("quoted paths classify like unquoted ones", async () => {
    expect((await checkShellSandbox('cat "/etc/passwd"')).ok).toBe(false);
    expect((await checkShellSandbox("cat '/etc/passwd'")).ok).toBe(false);
    // Quoted relative path with spaces inside the project — fine.
    expect((await checkShellSandbox('cat "src/my file.ts"')).ok).toBe(true);
  });
});

describe("splitShellArgs", () => {
  it("splits on whitespace and separators, honors quotes", () => {
    expect(splitShellArgs("cp a b.txt c d")).toEqual(["cp", "a", "b.txt", "c", "d"]);
    expect(splitShellArgs('echo "a b" | grep x')).toEqual(["echo", "a b", "grep", "x"]);
    expect(splitShellArgs("cat 'my file.txt'")).toEqual(["cat", "my file.txt"]);
    expect(splitShellArgs("a && b")).toEqual(["a", "b"]);
    expect(splitShellArgs("cmd --flag")).toEqual(["cmd", "--flag"]);
  });
});
