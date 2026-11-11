import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  extensionOf,
  formatDocument,
  formatSelection,
  formatterLabelFor,
  isFormattable,
} from "./formatter";

/**
 * Regression net for the prettier/standalone plugin graph.
 *
 * `prettier/standalone` resolves a parser ONLY from the plugins explicitly
 * handed to `format()`. A missing plugin is either a hard "Couldn't resolve
 * parser" throw or — worse — a silent no-op for embedded code, so these tests
 * assert the OUTPUT changed, not merely that the call resolved.
 */

describe("formatter detection", () => {
  it("maps extensions to languages", () => {
    expect(detectLanguage("a.ts")).toBe("typescript");
    expect(detectLanguage("a.tsx")).toBe("typescript");
    expect(detectLanguage("a.js")).toBe("javascript");
    expect(detectLanguage("a.jsx")).toBe("javascript");
    expect(detectLanguage("a.json")).toBe("json");
    expect(detectLanguage("a.vue")).toBe("vue");
    expect(detectLanguage("a.py")).toBe("python");
    expect(detectLanguage("a.unknown")).toBeNull();
  });

  it("handles both path separators and dotfiles", () => {
    expect(extensionOf("C:\\\\repo\\\\src\\\\a.TS")).toBe("ts");
    expect(extensionOf("src/a.ts")).toBe("ts");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });

  it("reports formattability and the formatter label", () => {
    expect(isFormattable("a.json")).toBe(true);
    expect(isFormattable("a.py")).toBe(true);
    expect(isFormattable("a.bat")).toBe(false);
    expect(formatterLabelFor("a.json")).toBe("prettier");
    expect(formatterLabelFor("a.py")).toBe("black");
    expect(formatterLabelFor("a.bat")).toBeNull();
  });
});

describe("formatDocument plugin resolution", () => {
  it("formats JSON (parser lives in the babel plugin)", async () => {
    expect(await formatDocument("a.json", '{"a":1,"b":[1,2,]}')).toBe(
      '{ "a": 1, "b": [1, 2] }\n',
    );
  });

  it("formats JSONC without dropping comments", async () => {
    const out = await formatDocument("a.jsonc", '{"a":1,//c\n"b":2}');
    expect(out).toContain("//c");
    expect(out).toContain('"b": 2');
  });

  it("formats JSON5", async () => {
    expect(await formatDocument("a.json5", "{a:1,b:[1,2,],}")).toBe(
      "{ a: 1, b: [1, 2] }\n",
    );
  });

  it("formats TypeScript (separate typescript plugin)", async () => {
    expect(await formatDocument("a.ts", "const a:number=1")).toBe(
      "const a: number = 1;\n",
    );
  });

  it("formats TSX", async () => {
    expect(await formatDocument("a.tsx", "const a=<div/>;")).toBe(
      "const a = <div />;\n",
    );
  });

  it("formats Vue with its own parser, including the script block", async () => {
    const out = await formatDocument(
      "a.vue",
      '<template><div   >x</div></template>\n<script setup lang="ts">const a:number=1</script>',
    );
    // The <script> body must be formatted: parsed as plain HTML it is left
    // byte-identical, which is the silent-no-op this guards against.
    expect(out).toContain("const a: number = 1;");
  });

  it("formats JS and CSS embedded in HTML", async () => {
    const out = await formatDocument(
      "a.html",
      "<style>.a{color:red}</style>\n<script>const a=1;function f(){return 2}</script>",
    );
    expect(out).toContain("color: red;");
    expect(out).toContain("function f() {");
  });

  it("formats fenced code inside Markdown", async () => {
    const out = await formatDocument(
      "a.md",
      "```ts\nconst a:number=1\n```",
    );
    expect(out).toContain("const a: number = 1;");
  });

  it("formats Vue <style> blocks", async () => {
    const out = await formatDocument(
      "a.vue",
      "<template><div/></template>\n<style>.a{color:red}</style>",
    );
    expect(out).toContain("color: red;");
  });

  it("formats CSS, SCSS and YAML", async () => {
    expect(await formatDocument("a.css", ".a{color:red}")).toBe(
      ".a {\n  color: red;\n}\n",
    );
    expect(await formatDocument("a.scss", ".a{&:hover{color:red}}")).toContain(
      "&:hover {",
    );
    expect(await formatDocument("a.yaml", "a:   1")).toBe("a: 1\n");
  });

  it("throws a readable message for unsupported files", async () => {
    await expect(formatDocument("a.bat", "echo hi")).rejects.toThrow(
      /No formatter/i,
    );
  });

  it("reports a syntax error instead of leaking a prettier stack", async () => {
    await expect(formatDocument("a.json", '{"a": }')).rejects.toThrow(
      /syntax error/i,
    );
  });
});

describe("formatSelection", () => {
  it("formats a fragment and strips prettier's trailing newline", async () => {
    const out = await formatSelection("a.ts", "const a:number=1");
    expect(out).toBe("const a: number = 1;");
  });

  it("returns null when the fragment cannot stand alone", async () => {
    // A JSON slice is not a value, so it cannot be parsed in isolation ->
    // the caller falls back to formatting the whole document.
    expect(await formatSelection("a.json", '"a": 1,')).toBeNull();
  });

  it("returns null for unformattable extensions", async () => {
    expect(await formatSelection("a.bat", "echo hi")).toBeNull();
  });
});
