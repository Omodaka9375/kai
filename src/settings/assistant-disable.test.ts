import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** Disable must stay a lightweight Settings operation. Importing the whole
 *  assistant runtime on this path caused extra startup work and a failure
 *  surface unrelated to the native stop command. */
describe("assistant disable path", () => {
  const source = readFileSync(
    new URL("./sections/ExternalSection.tsx", import.meta.url),
    "utf8",
  );

  it("uses the native stop command without importing the AI runtime", () => {
    const disable = source.slice(
      source.indexOf("} else {\n        // Stopping needs only"),
      source.indexOf("setStatus(\"Stopped.\")"),
    );
    expect(disable).toContain("await telegramNative.stop()");
    expect(disable).toContain('await patch({ enabled: false })');
    expect(disable).not.toContain('import("@/modules/assistant")');
    expect(disable).not.toContain("stopAssistantBridge");
  });
});

/** React #299 means createRoot received a missing/invalid container. The
 *  main bootstrap has an explicit assertion; Settings fails with a useful
 *  diagnostic instead of casting null and throwing a minified React error. */
describe("assistant startup revalidation", () => {
  const source = readFileSync(
    new URL("../modules/assistant/index.ts", import.meta.url),
    "utf8",
  );

  it("does not trust bridgeStarted after a native Settings stop", () => {
    const functionStart = source.indexOf("export async function startAssistantBridge");
    const start = source.slice(
      functionStart,
      source.indexOf("const prefs = await loadAssistantPrefs()", functionStart),
    );
    expect(start).toContain("await telegramNative.status()");
    expect(start).toContain("bridgeStarted = current.running");
  });
});

describe("webview root bootstrap", () => {
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
  const settings = readFileSync(
    new URL("./main.tsx", import.meta.url),
    "utf8",
  );

  it("checks both roots before mounting React", () => {
    expect(main).toContain("if (!(root instanceof HTMLElement))");
    expect(main).toContain("ReactDOM.createRoot(root)");
    expect(settings).toContain("if (root instanceof HTMLElement)");
    expect(settings).toContain("KAI settings root is unavailable");
    expect(settings).not.toContain("as HTMLElement");
  });
});
