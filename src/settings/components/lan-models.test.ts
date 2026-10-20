import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * LAN local-AI contract tests — the OpenAI-compatible provider must be a
 * first-class way to run LOCAL/LAN models (Ollama, vLLM, llama.cpp, LM Studio
 * on another box), not just hosted endpoints. The transport capability
 * (private-network fetch + http URLs + optional key) already existed; these
 * pins guard the wiring that makes it usable and discoverable:
 *
 *   1. agent.ts routes openai-compatible/lmstudio through localProxyFetch
 *      (allowPrivateNetwork: true) — NEVER through cloudFetch or the bare
 *      gated proxyFetch. If this regresses, LAN endpoints 403 instantly.
 *   2. No https-only validation on the user-supplied base URL anywhere in
 *      the model-call path — http://192.168.x.x must survive to reqwest.
 *   3. Settings presents the LAN story: compat block is labeled Local/LAN,
 *      ships quick-fill presets, and the placeholder shows a LAN URL shape.
 *   4. The registry description mentions local/LAN so the model picker
 *      surface doesn't read hosted-only.
 */

const agentSrc = readFileSync(new URL("../../modules/ai/lib/agent.ts", import.meta.url), "utf8");
const modelsSection = readFileSync(
  new URL("../sections/ModelsSection.tsx", import.meta.url),
  "utf8",
);
const modelsRegistry = readFileSync(
  new URL("../../modules/ai/config/models.ts", import.meta.url),
  "utf8",
);
const providersSrc = readFileSync(
  new URL("../../modules/ai/config/providers.ts", import.meta.url),
  "utf8",
);

describe("compat provider transport stays LAN-capable", () => {
  it("openai-compatible and lmstudio build with localProxyFetch", () => {
    // Extract the two provider cases and assert each uses localProxyFetch.
    const compatCase = agentSrc.split('case "openai-compatible":')[1]?.split("case")[0] ?? "";
    expect(compatCase).toContain("localProxyFetch");
    const lmCase = agentSrc.split('case "lmstudio":')[1]?.split("default:")[0] ?? "";
    expect(lmCase).toContain("localProxyFetch");
  });

  it("localProxyFetch allows private networks", () => {
    expect(agentSrc).toContain(
      'createProxyFetch({ allowPrivateNetwork: true })',
    );
  });

  it("no https-only gate on the compat base URL", () => {
    const buildPath = agentSrc.split("buildLanguageModel")[1] ?? "";
    expect(buildPath).not.toMatch(/startsWith\(\s*"https/);
  });

  it("compat provider is keyless-capable (LAN servers often have no key)", () => {
    expect(providersSrc).toContain('keyOptional: true');
    expect(providersSrc).toMatch(/KEYLESS_PROVIDERS[\s\S]*"openai-compatible"/);
  });
});

describe("Settings surfaces the LAN story", () => {
  it("compat block is labeled Local/LAN with LAN-shaped placeholders", () => {
    expect(modelsSection).toContain("Local / LAN — OpenAI-compatible endpoint");
    expect(modelsSection).toContain("http://192.168.1.50:11434/v1");
    // http:// must be explicitly called out as fine — the old copy said
    // "HTTPS endpoint", which read as a requirement.
    expect(modelsSection).toMatch(/[Pp]lain http:\/\/ is fine on the LAN/);
  });

  it("ships one-click presets for the common local servers", () => {
    expect(modelsSection).toContain("LOCAL_SERVER_PRESETS");
    for (const name of ["Ollama", "llama.cpp", "vLLM", "LM Studio"]) {
      expect(modelsSection).toContain(`label: "${name}"`);
    }
  });

  it("registry description names local/LAN usage", () => {
    expect(modelsRegistry).toMatch(/local\/LAN \(Ollama, vLLM, llama\.cpp, LM Studio\)/);
  });
});
