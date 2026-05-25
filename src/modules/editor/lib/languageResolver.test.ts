import { describe, expect, it } from "vitest";
import { resolveLanguage, resolveLanguageSync } from "./languageResolver";

describe("resolveLanguage", () => {
  it("resolves JavaScript", async () => {
    const ext = await resolveLanguage("app.js");
    expect(ext).not.toBeNull();
  });

  it("resolves TypeScript", async () => {
    const ext = await resolveLanguage("index.ts");
    expect(ext).not.toBeNull();
  });

  it("resolves TSX", async () => {
    const ext = await resolveLanguage("Component.tsx");
    expect(ext).not.toBeNull();
  });

  it("resolves Python", async () => {
    const ext = await resolveLanguage("main.py");
    expect(ext).not.toBeNull();
  });

  it("resolves Rust", async () => {
    const ext = await resolveLanguage("lib.rs");
    expect(ext).not.toBeNull();
  });

  it("resolves Go", async () => {
    const ext = await resolveLanguage("main.go");
    expect(ext).not.toBeNull();
  });

  it("resolves JSON", async () => {
    const ext = await resolveLanguage("package.json");
    expect(ext).not.toBeNull();
  });

  it("resolves CSS", async () => {
    const ext = await resolveLanguage("styles.css");
    expect(ext).not.toBeNull();
  });

  it("resolves HTML", async () => {
    const ext = await resolveLanguage("index.html");
    expect(ext).not.toBeNull();
  });

  it("resolves Markdown", async () => {
    const ext = await resolveLanguage("README.md");
    expect(ext).not.toBeNull();
  });

  it("resolves YAML", async () => {
    const ext = await resolveLanguage("config.yml");
    expect(ext).not.toBeNull();
  });

  it("resolves TOML", async () => {
    const ext = await resolveLanguage("Cargo.toml");
    expect(ext).not.toBeNull();
  });

  it("resolves Ruby", async () => {
    const ext = await resolveLanguage("app.rb");
    expect(ext).not.toBeNull();
  });

  it("resolves Swift", async () => {
    const ext = await resolveLanguage("main.swift");
    expect(ext).not.toBeNull();
  });

  it("resolves Kotlin", async () => {
    const ext = await resolveLanguage("Main.kt");
    expect(ext).not.toBeNull();
  });

  it("resolves SQL", async () => {
    const ext = await resolveLanguage("query.sql");
    expect(ext).not.toBeNull();
  });

  it("resolves PowerShell", async () => {
    const ext = await resolveLanguage("script.ps1");
    expect(ext).not.toBeNull();
  });

  it("returns null for unknown extensions", async () => {
    const ext = await resolveLanguage("file.xyz123");
    expect(ext).toBeNull();
  });

  it("returns null for extensionless files", async () => {
    const ext = await resolveLanguage("Makefile");
    expect(ext).toBeNull();
  });

  it("resolves Dockerfile by filename override", async () => {
    const ext = await resolveLanguage("Dockerfile");
    expect(ext).not.toBeNull();
  });

  it("resolveLanguageSync returns null before async load", () => {
    // For a never-loaded extension, sync should return null
    const ext = resolveLanguageSync("file.never_loaded_ext_abc");
    expect(ext).toBeNull();
  });
});
