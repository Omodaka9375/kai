import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateModelListing } from "./localModelProbe";
import {
  clearLocalModelProbe,
  runLocalModelProbe,
  useLocalModelProbeStore,
} from "./localModelProbe";

/**
 * Local-model drift probe contract tests. The IPC probe itself is one
 * invoke call; the interesting logic is evaluateModelListing (pure) plus
 * the store transition the pill renders from.
 */

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// The runner reads the compat provider's stored key; mock the keyring module
// so tests never touch secrets_* and can assert the Bearer header shape.
const getKeyMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock("./keyring", () => ({ getKey: getKeyMock }));

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
    getKeyMock.mockReset();
    getKeyMock.mockImplementation(async () => null);
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

  it("a stored compat key rides the probe as a Bearer header", async () => {
    getKeyMock.mockResolvedValueOnce("sk-local-key");
    invokeMock.mockResolvedValue({ status: 200, body: [] });
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "llama-3.3");
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "ai_http_request");
    expect(call).toBeDefined();
    expect(call![1].headers.Authorization).toBe("Bearer sk-local-key");
  });

  it("401 (auth demanded) maps to silent auth-required, never a false offline", async () => {
    invokeMock.mockResolvedValue({ status: 401, body: [] });
    await runLocalModelProbe("http://127.0.0.1:1234/v1", "llama-3.3");
    expect(useLocalModelProbeStore.getState().status.state).toBe("auth-required");
  });

  it("a superseded probe never lands its stale verdict (generation token)", async () => {
    const enc = (s: string) => Array.from(new TextEncoder().encode(s));
    const gates: Array<(v: { status: number; body: number[] }) => void> = [];
    invokeMock.mockImplementation(
      () => new Promise((res) => gates.push(res as never)),
    );
    const first = runLocalModelProbe("http://127.0.0.1:1234/v1", "old-model");
    const second = runLocalModelProbe("http://127.0.0.1:1234/v1", "new-model");
    // runLocalModelProbe awaits the keyring read BEFORE invoking; flush the
    // microtask chain so both pending invoke calls exist.
    await new Promise((r) => setTimeout(r, 0));
    expect(gates.length).toBe(2);
    // Newer probe resolves FIRST with its model present → ok lands.
    gates[1]!({ status: 200, body: enc(JSON.stringify({ data: [{ id: "new-model" }] })) });
    await second;
    // Older probe resolves LAST; its "missing" verdict must be dropped.
    gates[0]!({ status: 200, body: enc(JSON.stringify({ data: [{ id: "other" }] })) });
    await first;
    expect(useLocalModelProbeStore.getState().status.state).toBe("ok");
  });

  it("clearLocalModelProbe voids in-flight verdicts and resets the store", async () => {
    const enc = (s: string) => Array.from(new TextEncoder().encode(s));
    const gates: Array<(v: { status: number; body: number[] }) => void> = [];
    invokeMock.mockImplementation(
      () => new Promise((res) => gates.push(res as never)),
    );
    const p = runLocalModelProbe("http://127.0.0.1:1234/v1", "m");
    await new Promise((r) => setTimeout(r, 0)); // let the invoke call exist
    clearLocalModelProbe();
    gates[0]!({ status: 200, body: enc(JSON.stringify({ data: [{ id: "m" }] })) });
    await p;
    expect(useLocalModelProbeStore.getState().status.state).toBe("idle");
  });
});
