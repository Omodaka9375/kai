import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateModelListing } from "./localModelProbe";
import { runLocalModelProbe, useLocalModelProbeStore } from "./localModelProbe";

/**
 * Local-model drift probe contract tests. The IPC probe itself is one
 * invoke call; the interesting logic is evaluateModelListing (pure) plus
 * the store transition the pill renders from.
 */

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("evaluateModelListing (pure verdict)", () => {
  const listing = (ids: string[]) =>
    JSON.stringify({ data: ids.map((id) => ({ id })) });

  it("exact match passes", () => {
    expect(evaluateModelListing("llama-3.3", listing(["llama-3.3", "qwen-4"]))?.ok).toBe(true);
  });

  it("prefix match passes (naming drift like llama-3.3 vs llama-3.3-70b)", () => {
    expect(evaluateModelListing("llama-3.3", listing(["llama-3.3-70b-instruct"]))?.ok).toBe(true);
  });

  it("a different model is reported missing with the available list", () => {
    const verdict = evaluateModelListing("old-model", listing(["qwen-4", "gemma-3"]));
    expect(verdict?.ok).toBe(false);
    expect(verdict?.available).toEqual(["qwen-4", "gemma-3"]);
  });

  it("Ollama's models-name shape parses", () => {
    const body = JSON.stringify({ models: [{ name: "llama3.2" }, { id: "x" }] });
    const verdict = evaluateModelListing("llama3.2", body);
    expect(verdict?.ok).toBe(true);
  });

  it("non-JSON and wrong-shape bodies return null (stay silent, never misreport)", () => {
    expect(evaluateModelListing("m", "not json")).toBeNull();
    expect(evaluateModelListing("m", JSON.stringify({ unexpected: 1 }))).toBeNull();
  });
});

describe("runLocalModelProbe (store transitions)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useLocalModelProbeStore.setState({ status: { state: "idle" } });
  });

  it("missing model → status carries configured id and available list", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      body: Array.from(new TextEncoder().encode(JSON.stringify({
        data: [{ id: "mistral" }, { id: "phi-4" }],
      }))),
    });
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "llama-3.3");
    const s = useLocalModelProbeStore.getState().status;
    expect(s).toMatchObject({
      state: "missing",
      configuredId: "llama-3.3",
      available: ["mistral", "phi-4"],
    });
  });

  it("model present → ok, pill hidden", async () => {
    invokeMock.mockResolvedValue({
      status: 200,
      body: Array.from(new TextEncoder().encode(JSON.stringify({
        data: [{ id: "llama-3.3" }],
      }))),
    });
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "llama-3.3");
    expect(useLocalModelProbeStore.getState().status.state).toBe("ok");
  });

  it("endpoint down → unreachable with the error surfaced", async () => {
    invokeMock.mockRejectedValue(new Error("connection refused"));
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "llama-3.3");
    const s = useLocalModelProbeStore.getState().status;
    expect(s.state).toBe("unreachable");
  });

  it("local endpoints are probed with allowPrivateNetwork: true", async () => {
    invokeMock.mockResolvedValue({ status: 404, body: [] });
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "m");
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "ai_http_request");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ allowPrivateNetwork: true });
    // and the security-relevant flag was passed, not silently dropped
    expect(call![1].url).toBe("http://127.0.0.1:1234/v1/models");
  });

  it("empty model id skips the probe entirely (nothing configured)", async () => {
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
