import { describe, expect, it } from "vitest";
import { injectPrompt } from "./comfyui";

describe("injectPrompt", () => {
  it("injects into CLIPTextEncode node", () => {
    const workflow = {
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: "original prompt", clip: ["4", 0] },
      },
      "4": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "model.safetensors" },
      },
    };
    const result = injectPrompt(workflow, "a cat on the moon");
    const node = (result as Record<string, { inputs: { text: string } }>)["3"];
    expect(node.inputs.text).toBe("a cat on the moon");
  });

  it("injects into first text node only", () => {
    const workflow = {
      "1": {
        class_type: "CLIPTextEncode",
        inputs: { text: "positive prompt" },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: { text: "negative prompt" },
      },
    };
    const result = injectPrompt(workflow, "new prompt");
    const nodes = result as Record<string, { inputs: { text: string } }>;
    expect(nodes["1"].inputs.text).toBe("new prompt");
    expect(nodes["2"].inputs.text).toBe("negative prompt");
  });

  it("falls back to node with 'prompt' input key", () => {
    const workflow = {
      "1": {
        class_type: "CustomNode",
        inputs: { prompt: "old text", seed: 42 },
      },
    };
    const result = injectPrompt(workflow, "hello world");
    const node = (result as Record<string, { inputs: { prompt: string } }>)[
      "1"
    ];
    expect(node.inputs.prompt).toBe("hello world");
  });

  it("falls back to node with 'text' input key", () => {
    const workflow = {
      "1": {
        class_type: "UnknownNode",
        inputs: { text: "placeholder", other: 123 },
      },
    };
    const result = injectPrompt(workflow, "injected");
    const node = (result as Record<string, { inputs: { text: string } }>)["1"];
    expect(node.inputs.text).toBe("injected");
  });

  it("returns workflow unchanged if no text node found", () => {
    const workflow = {
      "1": {
        class_type: "KSampler",
        inputs: { seed: 42, steps: 20 },
      },
    };
    const result = injectPrompt(workflow, "test");
    expect(result).toEqual(workflow);
  });

  it("does not mutate the original workflow object", () => {
    const workflow = {
      "1": {
        class_type: "CLIPTextEncode",
        inputs: { text: "original" },
      },
    };
    const copy = JSON.parse(JSON.stringify(workflow));
    injectPrompt(structuredClone(workflow), "new");
    expect(workflow).toEqual(copy);
  });
});
