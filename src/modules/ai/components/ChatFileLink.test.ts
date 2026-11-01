import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatFileLink,
  isFileLinkHref,
  registerChatFileOpen,
  resolveChatFilePath,
  splitPathLine,
} from "./ChatFileLink";
import { getActiveProjectRuntime } from "../store/chatStore";

/**
 * Chat file links (2026-11-02 ask: "when agent writes local or external
 * relative links make it clickable, e.g. docs/report.md").
 *
 * Streamdown renders `[label](docs/report.md)` as an <a href>; relative
 * hrefs cannot navigate in the Tauri webview. ChatFileLink classifies the
 * href, resolves repo-relative paths against the ACTIVE project root, and
 * routes clicks through the registered open-file handler (the app shell's
 * handleOpenFile). Web links fall through unchanged.
 */

vi.mock("../store/chatStore", () => ({
  getActiveProjectRuntime: vi.fn(() => ({
    id: "p1",
    root: "D:/Code/2026/KAI",
  })),
}));

describe("isFileLinkHref", () => {
  it("matches repo-relative doc paths with extensions", () => {
    expect(isFileLinkHref("docs/report.md")).toBe(true);
    expect(isFileLinkHref("./src/app.tsx")).toBe(true);
    expect(isFileLinkHref("README.md")).toBe(true);
    expect(isFileLinkHref("src/modules/ai/lib/fence.ts")).toBe(true);
  });

  it("matches absolute paths and :line forms", () => {
    expect(isFileLinkHref("/home/user/project/main.rs")).toBe(true);
    expect(isFileLinkHref("D:/Code/2026/KAI/package.json")).toBe(true);
    expect(isFileLinkHref("src/app.tsx:42")).toBe(true);
    expect(isFileLinkHref("src/app.tsx:42:7")).toBe(true);
  });

  it("rejects web links and non-paths", () => {
    expect(isFileLinkHref("https://example.com/docs")).toBe(false);
    expect(isFileLinkHref("http://localhost:5173")).toBe(false);
    expect(isFileLinkHref("mailto:a@b.co")).toBe(false);
    expect(isFileLinkHref("")).toBe(false);
    expect(isFileLinkHref("#anchor")).toBe(false);
  });
});

describe("splitPathLine", () => {
  it("splits path:line and path:line:col", () => {
    expect(splitPathLine("src/app.tsx:42")).toEqual({
      path: "src/app.tsx",
      line: 42,
    });
    expect(splitPathLine("src/app.tsx:42:7").line).toBe(42);
    expect(splitPathLine("docs/report.md")).toEqual({
      path: "docs/report.md",
      line: undefined,
    });
  });

  it("strips GitHub-style query/anchor suffixes", () => {
    expect(splitPathLine("src/app.tsx?plain=1").path).toBe("src/app.tsx");
    expect(splitPathLine("docs/report.md#section").path).toBe("docs/report.md");
  });
});

describe("resolveChatFilePath", () => {
  it("resolves a relative path against the active project root", () => {
    expect(resolveChatFilePath("docs/report.md")).toBe(
      "D:/Code/2026/KAI/docs/report.md",
    );
  });

  it("leaves absolute paths alone", () => {
    expect(resolveChatFilePath("/srv/data/log.txt")).toBe("/srv/data/log.txt");
    expect(resolveChatFilePath("D:/other/proj/x.ts")).toBe("D:/other/proj/x.ts");
  });

  it("falls back to the bare path when no project is open", () => {
    vi.mocked(getActiveProjectRuntime).mockReturnValueOnce(undefined);
    expect(resolveChatFilePath("docs/report.md")).toBe("docs/report.md");
  });
});

describe("ChatFileLink click routing", () => {
  const openSpy = vi.fn();
  beforeEach(() => {
    openSpy.mockClear();
    registerChatFileOpen((path, line) => openSpy(path, line));
    return () => registerChatFileOpen(null);
  });

  /** Extract the onClick handler from the element ChatFileLink returns. */
  const clickHandler = (href: string): (e: unknown) => void => {
    const el = ChatFileLink({ href }) as unknown as {
      props: { onClick: (e: unknown) => void };
    };
    expect(typeof el.props.onClick).toBe("function");
    return el.props.onClick;
  };

  it("a file-link click routes the resolved path + line to the handler", () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    clickHandler("src/app.tsx:42")(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith("D:/Code/2026/KAI/src/app.tsx", 42);
  });

  it("web links render as plain anchors (App's interceptor owns them)", () => {
    const el = ChatFileLink({
      href: "https://example.com",
      children: "site",
    }) as unknown as { props: { href: string } };
    expect(el.props.href).toBe("https://example.com");
  });

  it("without a registered handler the click is a no-op (links go inert)", () => {
    registerChatFileOpen(null);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    expect(() => clickHandler("docs/report.md")(event)).not.toThrow();
  });
});
