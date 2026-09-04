import { describe, expect, it } from "vitest";
import { injectDuration, injectPrompt } from "./comfyui";

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

describe("injectDuration", () => {
  it("sets frame count from duration and detected fps", () => {
    const workflow = {
      "1": {
        class_type: "KSampler",
        inputs: { frames: 16, fps: 24, steps: 20 },
      },
    };
    const result = injectDuration(workflow, 5) as Record<
      string,
      { inputs: { frames: number; fps: number } }
    >;
    expect(result["1"].inputs.frames).toBe(120); // 5s * 24fps
  });

  it("defaults fps to 24 when no fps node exists", () => {
    const workflow = {
      "1": {
        class_type: "EmptyHunyuanLatentVideo",
        inputs: { length: 25, width: 512, height: 512 },
      },
    };
    const result = injectDuration(workflow, 3) as Record<
      string,
      { inputs: { length: number } }
    >;
    expect(result["1"].inputs.length).toBe(72); // 3s * 24fps
  });

  it("sets a plain duration input directly", () => {
    const workflow = {
      "1": {
        class_type: "Custom",
        inputs: { duration: 10 },
      },
    };
    const result = injectDuration(workflow, 5) as Record<
      string,
      { inputs: { duration: number } }
    >;
    expect(result["1"].inputs.duration).toBe(5);
  });

  it("leaves non-frame inputs untouched", () => {
    const workflow = {
      "1": {
        class_type: "KSampler",
        inputs: { seed: 42, steps: 20 },
      },
    };
    const result = injectDuration(workflow, 5) as Record<
      string,
      { inputs: { seed: number; steps: number } }
    >;
    expect(result["1"].inputs.seed).toBe(42);
    expect(result["1"].inputs.steps).toBe(20);
  });
});
