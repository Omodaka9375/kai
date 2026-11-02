import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract pins for the "terminal running" rail dot's SHELL side
 * (2026-11-02 phantom-green-dot fix).
 *
 * User report: opening a terminal tab lit the project folder's green dot
 * even though nothing ran. Root cause: the dot keyed on OSC 133 B, but B is
 * the FinalTerm "prompt line starts here" marker — all four integration
 * scripts embed it in the PROMPT (PS1 / prompt function / fish_prompt), so
 * it fires at every prompt render, including the very first one of a fresh
 * tab. The host now lights the dot on C only (true execution: zsh preexec,
 * bash PS0, fish_preexec, and a PSConsoleHostReadLine wrapper on pwsh —
 * which previously emitted NO C at all).
 *
 * These pins keep every script emitting C at real execution, and keep B
 * where it belongs (prompt-line marker) without which command-text
 * extraction would break. Assertions are deliberately written without
 * multi-backslash runs (bash's \[ \e \\ \] prompt escapes) — matching on
 * stable ASCII heads instead; byte-exact backslash clusters in regex
 * literals do not survive the tool encoding round-trip (nano-banana war
 * story, same class).
 */
const scriptsDir = new URL("../../../../src-tauri/src/modules/pty/scripts/", import.meta.url);

function script(name: string): string {
  return readFileSync(new URL(name, scriptsDir), "utf8");
}

describe("shell integration emits OSC 133 C at real execution (dot lights on C only)", () => {
  it("pwsh: the prompt emits B (prompt-line marker) and a readline wrapper emits C on submit", () => {
    const ps1 = script("profile.ps1");
    // B stays in the prompt string — the command-text extraction marker.
    expect(ps1).toContain('$oscB = "$esc]133;B');
    expect(ps1).toContain("${original}${oscB}");
    // The C wrapper: captures the original PSConsoleHostReadLine, emits C
    // only for non-empty submissions (parity with zsh preexec / bash PS0 —
    // no dot blink on empty Enter).
    expect(ps1).toContain("Copy-Item Function:PSConsoleHostReadLine Function:__KAI_original_Readline");
    expect(ps1).toContain("function global:PSConsoleHostReadLine");
    expect(ps1).toContain("]133;C$esc");
    expect(ps1).toContain("Trim().Length -gt 0");
  });

  it("zsh: preexec emits C; B is only the PS1-injected prompt-line marker", () => {
    const zshrc = script("zshrc.zsh");
    // C fires from the preexec hook (real execution), not the prompt.
    expect(zshrc).toMatch(/_KAI_preexec[\s\S]*133;C/);
    expect(zshrc).toContain("add-zsh-hook preexec _KAI_preexec");
    // B is injected into PS1 only (prompt-line marker).
    expect(zshrc).toMatch(/PS1=\$'[^']*133;B/);
  });

  it("bash: PS0 emits C (bash 4.4+); B is only the PS1-injected prompt-line marker", () => {
    const bashrc = script("bashrc.bash");
    expect(bashrc).toMatch(/PS0='[^']*133;C/);
    expect(bashrc).toMatch(/PS1='[^']*133;B/);
  });

  it("fish: fish_preexec emits C; B is only the fish_prompt trailing marker", () => {
    const fish = script("init.fish");
    expect(fish).toMatch(/--on-event fish_preexec[\s\S]*133;C/);
    expect(fish).toMatch(/function fish_prompt[\s\S]*133;B/);
  });
});

describe("the host consumes C only (never B) for the running dot", () => {
  it("osc-handlers: B sets inCommand but does NOT call onCommandStart", async () => {
    const { readFileSync: read } = await import("node:fs");
    const src = read(new URL("./osc-handlers.ts", import.meta.url), "utf8");
    // B branch: state gate only — no start hook.
    expect(src).toMatch(/data\.startsWith\("B"\)[\s\S]*?state\.inCommand = true;\s*\} else if \(data\.startsWith\("C"\)/);
    // C branch: state gate AND the hook.
    expect(src).toMatch(/data\.startsWith\("C"\)[\s\S]*?state\.inCommand = true;\s*\n\s*onCommandStart\?\.\(\)/);
  });
});
