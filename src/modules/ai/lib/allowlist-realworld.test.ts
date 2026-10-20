import { describe, expect, it } from "vitest";
import { isAllowlistable } from "./allowlist";

/** Real-world agent command shapes — the cases the user actually hits. */
describe("isAllowlistable real-world shapes", () => {
  it("pins the everyday agent chains", () => {
    expect(isAllowlistable("cd src-tauri && cargo check")).toBe(true);
    expect(isAllowlistable("cd src && pnpm exec tsc --noEmit")).toBe(true);
    expect(
      isAllowlistable("pnpm exec vitest run src/modules/ai/lib/allowlist.test.ts"),
    ).toBe(true);
    expect(isAllowlistable("cargo test --lib net")).toBe(true);
    expect(isAllowlistable("git log --oneline -5")).toBe(true);
    expect(isAllowlistable("cargo build --release")).toBe(true);
    expect(isAllowlistable("ls src")).toBe(true);
    expect(isAllowlistable("echo hello")).toBe(true);
    expect(isAllowlistable("pnpm --version")).toBe(true);
  });

  it("still rejects the dangerous chains and invisible-effect syntax", () => {
    expect(isAllowlistable("cargo check && rm -rf target")).toBe(false); // rm segment
    expect(isAllowlistable("cd x && cargo check > log.txt")).toBe(false); // redirection
    expect(isAllowlistable("cd x && echo $(pwd) && cargo check")).toBe(false); // substitution
    expect(isAllowlistable("cargo check &")).toBe(false); // backgrounding
    expect(isAllowlistable("npm install left-pad")).toBe(false); // medium-risk segment
    expect(isAllowlistable("cd x && cp a b")).toBe(false); // cp = write-shaped
    expect(isAllowlistable("cd x && cat f | tee g")).toBe(false); // tee = write-shaped
  });
});
