import { describe, expect, it } from "vitest";
import {
  redactSourceText,
  redactToolOutput,
  redactSensitive,
} from "./redact";

// ── Value-shaped patterns: stripped in BOTH tiers ──────────────────────────

describe("redactSourceText — value-shaped secrets", () => {
  it("strips OpenAI keys", () => {
    expect(redactSourceText('key = "sk-proj-abcdefghij0123456789XYZ"')).toContain(
      "<REDACTED:openai-key>",
    );
  });

  it("strips Anthropic keys", () => {
    expect(redactSourceText("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toContain(
      "<REDACTED:anthropic-key>",
    );
  });

  it("strips AWS access key ids", () => {
    const out = redactSourceText("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("<REDACTED:aws-access-key>");
  });

  it("strips GitHub tokens, both classic and fine-grained", () => {
    expect(
      redactSourceText("ghp_" + "a".repeat(36)).includes("<REDACTED:github-token>"),
    ).toBe(true);
    expect(
      redactSourceText("github_pat_" + "a".repeat(22) + "_" + "b".repeat(38)).includes(
        "<REDACTED:github-pat>",
      ),
    ).toBe(true);
  });

  it("strips private key blocks whole, including the armored body", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = redactSourceText(pem);
    expect(out).toBe("<REDACTED:private-key-block>");
  });

  it("strips JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ" +
      ".dQw4w9WgXcQabcdefghij1234567890";
    expect(redactSourceText(`token: ${jwt}`)).toContain("<REDACTED:jwt>");
  });

  it("strips Authorization: Bearer values", () => {
    expect(
      redactSourceText("Authorization: Bearer abcdef1234567890ABCDEF._-xyz")
        .includes("<REDACTED:bearer>"),
    ).toBe(true);
  });

  it("leaves ordinary source code untouched", () => {
    const src = `export const API_BASE = "https://api.example.com/v1";\nexport function sum(a: number, b: number) { return a + b; }`;
    expect(redactSourceText(src)).toBe(src);
  });
});

// ── The read→edit round-trip guard ─────────────────────────────────────────

describe("tier separation — why name-based patterns are payload-only", () => {
  const ENV_ASSIGN = "OPENAI_API_KEY=changeme-placeholder-value";
  const CONFIG_SRC = `# .env.example — fill these in\nAPI_KEY=your-key-here\nDB_PASSWORD=postgres`;

  it("source tier PRESERVES placeholder assignments (edit round-trips)", () => {
    // If redaction mangled these, an `old_string` copied from a redacted
    // read_file would never match the real file and every edit would fail.
    expect(redactSourceText(ENV_ASSIGN)).toBe(ENV_ASSIGN);
    expect(redactSourceText(CONFIG_SRC)).toBe(CONFIG_SRC);
  });

  it("payload tier DOES strip them (shell output, web pages)", () => {
    expect(redactSensitive(ENV_ASSIGN)).not.toContain("changeme-placeholder-value");
    expect(redactSensitive("API_KEY=your-key-here")).not.toContain("your-key-here");
    expect(redactSensitive("DB_PASSWORD=postgres")).not.toContain("postgres");
  });

  it("payload tier preserves the variable name so output stays diagnosable", () => {
    expect(redactSensitive(ENV_ASSIGN)).toMatch(/^OPENAI_API_KEY=<REDACTED:bare>$/);
  });

  it("redaction is idempotent (scrollback is redacted twice, by design)", () => {
    const once = redactSensitive("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG");
    expect(once).toBe("AWS_SECRET_ACCESS_KEY=<REDACTED:bare>");
    expect(redactSensitive(once)).toBe(once);
  });

  it("leaves ordinary config alone", () => {
    // The name test must gate this, or payload-tier redaction would shred
    // every `pnpm dev` log the agent reads.
    const env = "PORT=3000\nNODE_ENV=production\nHOST=localhost\nAUTHOR=Jane Doe";
    expect(redactSensitive(env)).toBe(env);
  });

  it("catches credential-named vars without an enumerated allow-list", () => {
    for (const line of [
      "GITHUB_TOKEN=abc123def456",
      "NPM_TOKEN=abcdefgh",
      "DATABASE_PASSWORD=hunter2",
    ]) {
      const name = line.slice(0, line.indexOf("="));
      expect(redactSensitive(line)).toBe(`${name}=<REDACTED:bare>`);
    }
  });

  it("prefers the specific value-shaped label over the generic one", () => {
    // AKIA… is recognized by shape in BOTH tiers, so the source pass gets
    // there first and reports the precise kind rather than `bare`.
    const out = redactSensitive("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(out).toBe("AWS_ACCESS_KEY_ID=<REDACTED:aws-access-key>");
  });
});

// ── Structure walking ──────────────────────────────────────────────────────

describe("redactToolOutput — structure preservation", () => {
  it("redacts string values but leaves path-like keys verbatim", () => {
    const out = redactToolOutput("read_file", {
      path: "/home/me/.aws/credentials",
      content: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      kind: "text",
    }) as { path: string; content: string; kind: string };

    // A redacted `path` would hand the model an unusable address.
    expect(out.path).toBe("/home/me/.aws/credentials");
    expect(out.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.kind).toBe("text");
  });

  it("walks nested arrays and objects", () => {
    const out = redactToolOutput("read_file", {
      hits: [
        { path: "src/a.ts", line: 1, text: "const k = 'sk-proj-abcdefghij0123456789XYZ'" },
        { path: "src/b.ts", line: 2, text: "plain text" },
      ],
      truncated: false,
      files_scanned: 2,
    }) as { hits: { text: string }[]; truncated: boolean; files_scanned: number };

    expect(out.hits[0]!.text).toContain("<REDACTED:openai-key>");
    expect(out.hits[1]!.text).toBe("plain text");
    expect(out.truncated).toBe(false);
    expect(out.files_scanned).toBe(2);
  });

  it("returns the SAME reference when nothing needs redacting", () => {
    const clean = { path: "/a/b.ts", content: "export const x = 1;", lineCount: 1 };
    // Identity matters: the common case must not copy every tool result.
    expect(redactToolOutput("read_file", clean)).toBe(clean);
  });

  it("keeps base64 media payload verbatim", () => {
    const big = { base64_data: "AKIAIOSFODNN7EXAMPLE" + "A".repeat(5000) };
    // Scanning megabytes of image bytes for secrets is pure stall, and random
    // base64 is not a credential.
    expect(redactToolOutput("generate_image", big)).toBe(big);
  });

  it("applies the payload tier for shell/web tools", () => {
    const out = redactToolOutput("bash_run", {
      stdout: "export GITHUB_TOKEN=ghp_reallookingtoken123",
      exit_code: 0,
    }) as { stdout: string; exit_code: number };
    // ghp_ value is too short to match the value-shaped github-token pattern,
    // so only the name-based payload tier catches it — the whole point of
    // giving shell tools the stricter pass.
    expect(out.stdout).not.toContain("ghp_reallookingtoken123");
    expect(out.exit_code).toBe(0);
  });

  it("survives circular structures without hanging", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactToolOutput("read_file", a)).not.toThrow();
  });

  it("passes through non-objects unchanged", () => {
    expect(redactToolOutput("read_file", "plain string")).toBe("plain string");
    expect(redactToolOutput("bash_run", 42)).toBe(42);
    expect(redactToolOutput("bash_run", null)).toBeNull();
  });
});
