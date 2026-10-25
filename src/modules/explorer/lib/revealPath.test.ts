import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  canonPath,
  isDrivePath,
  pathWithinRoot,
  relativeSegments,
} from "./revealPath";

describe("canonPath", () => {
  it("normalizes backslashes and strips the trailing slash", () => {
    expect(canonPath("C:\\Users\\foo\\")).toBe("C:/Users/foo");
    expect(canonPath("/a/b//")).toBe("/a/b");
    expect(canonPath("/")).toBe("");
  });
});

describe("isDrivePath", () => {
  it("recognizes Windows drive roots from the path shape", () => {
    expect(isDrivePath("C:/x")).toBe(true);
    expect(isDrivePath("d:\\code")).toBe(true);
    expect(isDrivePath("/home/user")).toBe(false);
    expect(isDrivePath("./rel")).toBe(false);
  });
});

describe("pathWithinRoot", () => {
  it("accepts the root itself and nested paths", () => {
    expect(pathWithinRoot("/a/b", "/a")).toBe(true);
    expect(pathWithinRoot("/a", "/a")).toBe(true);
  });
  it("rejects outside and prefix-lookalike paths", () => {
    expect(pathWithinRoot("/other", "/a")).toBe(false);
    // /ab is NOT under /a — the boundary slash check matters.
    expect(pathWithinRoot("/ab/c", "/a")).toBe(false);
  });
  it("is case-insensitive for drive roots, sensitive otherwise", () => {
    expect(pathWithinRoot("c:\\Users\\Foo", "C:/users")).toBe(true);
    expect(pathWithinRoot("/Home/User", "/home")).toBe(false);
  });
});

describe("relativeSegments", () => {
  it("splits the path under the root into segments", () => {
    expect(relativeSegments("/a/b/c.ts", "/a")).toEqual(["b", "c.ts"]);
  });
  it("returns [] for the root itself and for outside paths", () => {
    expect(relativeSegments("/a", "/a")).toEqual([]);
    expect(relativeSegments("/z", "/a")).toEqual([]);
  });
  it("handles backslash tab paths against a slash root", () => {
    expect(relativeSegments("D:\\Code\\src\\x.ts", "D:/Code")).toEqual([
      "src",
      "x.ts",
    ]);
  });
  it("preserves ORIGINAL casing in the segments (matching is the caller's job)", () => {
    // Root "C:/foo" — the path's "Foo" segment IS the root (drifted case), so
    // only "Bar.ts" is relative to it, and it keeps the tab path's own casing.
    // The reveal effect matches segments against disk names case-insensitively
    // on drive roots, so casing here never has to be normalized.
    expect(relativeSegments("C:/foo/sub/Bar.ts", "C:/Foo")).toEqual([
      "sub",
      "Bar.ts",
    ]);
  });
});

describe("ancestorDirs", () => {
  it("lists dirs to expand, excluding the root and the file itself", () => {
    expect(ancestorDirs("/a/b/c/d.ts", "/a")).toEqual(["/a/b", "/a/b/c"]);
  });
  it("returns [] for a direct child of the root", () => {
    expect(ancestorDirs("/a/d.ts", "/a")).toEqual([]);
  });
});