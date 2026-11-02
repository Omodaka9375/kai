import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  computePhotoDims,
  latestPhotoSourcePath,
  PHOTO_CONTEXT_WINDOW,
  rehydratePhotoPayloads,
  stripPhotoPayloads,
} from "./photos";

/**
 * The photo-reference contract (photos.ts): the prefs-store history carries
 * file parts WITHOUT inline bytes (`data:""` + `sourcePath`), and model
 * context is rebuilt by rehydrating the most recent window from disk. These
 * two functions are the persistence boundary — a regression in either
 * silently loses vision across turns or bloats the store back to megabytes.
 */

function userMsg(
  id: string,
  parts: Array<Record<string, unknown>>,
): UIMessage {
  return { id, role: "user", parts } as unknown as UIMessage;
}

describe("computePhotoDims", () => {
  it("leaves images within the long-edge limit untouched", () => {
    // long edge 1500 ≤ 1568 → no scale.
    expect(computePhotoDims(1500, 1200)).toEqual({ scale: 1, tw: 1500, th: 1200 });
    expect(computePhotoDims(1568, 900).scale).toBe(1); // exactly at the cap
  });
  it("scales the long edge to the limit, preserving aspect", () => {
    const d = computePhotoDims(3024, 4032); // typical phone photo
    expect(d.tw).toBe(1176);
    expect(d.th).toBe(1568);
    expect(Math.abs(d.tw / d.th - 3024 / 4032)).toBeLessThan(0.01);
  });
  it("never returns a zero dimension", () => {
    expect(computePhotoDims(0, 0)).toEqual({ scale: 1, tw: 0, th: 0 });
    const d = computePhotoDims(1, 99999);
    expect(d.tw).toBeGreaterThanOrEqual(1);
  });
});

describe("stripPhotoPayloads", () => {
  it("empties file data, keeps mediaType + sourcePath", () => {
    const out = stripPhotoPayloads([
      userMsg("m1", [
        { type: "text", text: "look" },
        { type: "file", mediaType: "image/jpeg", data: "QUJD", sourcePath: "/x/photo-1.jpg" },
      ]),
    ]);
    expect(out[0].parts).toMatchObject([
      { type: "text", text: "look" },
      { type: "file", mediaType: "image/jpeg", data: "", sourcePath: "/x/photo-1.jpg" },
    ]);
  });
  it("returns untouched messages by identity (no needless re-renders)", () => {
    const plain = userMsg("m1", [{ type: "text", text: "hi" }]);
    const assistant = { id: "m2", role: "assistant", parts: [{ type: "text", text: "yo" }] } as unknown as UIMessage;
    const out = stripPhotoPayloads([plain, assistant]);
    expect(out[0]).toBe(plain);
    expect(out[1]).toBe(assistant);
  });
  it("strips EVERY photo in a multi-photo message", () => {
    const out = stripPhotoPayloads([
      userMsg("m1", [
        { type: "file", data: "AAA", sourcePath: "/p/1.jpg" },
        { type: "file", data: "BBB", sourcePath: "/p/2.jpg" },
      ]),
    ]);
    const parts = out[0].parts as Array<Record<string, unknown>>;
    expect(parts.every((p) => p.data === "")).toBe(true);
    expect(parts.every((p) => p.sourcePath)).toBe(true);
  });
});

describe("rehydratePhotoPayloads", () => {
  const stripped = (id: string, path: string) =>
    userMsg(id, [{ type: "file", mediaType: "image/jpeg", data: "", sourcePath: path }]);

  it("fills the newest windowSize payloads from the reader", async () => {
    const msgs = [stripped("a", "/p/a.jpg"), stripped("b", "/p/b.jpg")];
    const read = vi.fn(async (p: string) => `bytes:${p}`);
    const out = await rehydratePhotoPayloads(msgs, 2, read);
    expect(read).toHaveBeenCalledTimes(2);
    const p0 = (out[0].parts as Record<string, unknown>[])[0];
    expect(p0.data).toBe("bytes:/p/a.jpg");
    expect(p0.sourcePath).toBe("/p/a.jpg"); // path survives alongside bytes
  });
  it("only the NEWEST PHOTO_CONTEXT_WINDOW get payloads — older stay empty", async () => {
    const n = PHOTO_CONTEXT_WINDOW + 3;
    const msgs = Array.from({ length: n }, (_, i) => stripped(`m${i}`, `/p/${i}.jpg`));
    const read = vi.fn(async (p: string) => `b:${p}`);
    const out = await rehydratePhotoPayloads(msgs, PHOTO_CONTEXT_WINDOW, read);
    const data = (i: number) =>
      (out[i].parts as Record<string, unknown>[])[0].data;
    expect(data(0)).toBe(""); // fell out of the window: text-only in context
    expect(data(n - 1)).toBe(`b:/p/${n - 1}.jpg`);
    expect(read).toHaveBeenCalledTimes(PHOTO_CONTEXT_WINDOW);
  });
  it("a failed read degrades to omitted-image, never a throw", async () => {
    const msgs = [stripped("a", "/p/gone.jpg"), stripped("b", "/p/ok.jpg")];
    const read = vi.fn(async (p: string) => {
      if (p.includes("gone")) throw new Error("ENOENT");
      return "ok-bytes";
    });
    const out = await rehydratePhotoPayloads(msgs, 2, read);
    expect((out[0].parts as Record<string, unknown>[])[0].data).toBe("");
    expect((out[1].parts as Record<string, unknown>[])[0].data).toBe("ok-bytes");
  });
  it("messages already carrying data (the live turn) are returned by identity, not re-read", async () => {
    const live = userMsg("now", [
      { type: "file", mediaType: "image/jpeg", data: "LIVE", sourcePath: "/p/now.jpg" },
    ]);
    const read = vi.fn();
    const out = await rehydratePhotoPayloads([live], 4, read);
    expect(out[0]).toBe(live);
    expect(read).not.toHaveBeenCalled();
  });
  it("history with no photo parts is a zero-copy pass-through", async () => {
    const msgs = [userMsg("t", [{ type: "text", text: "hello" }])];
    const out = await rehydratePhotoPayloads(msgs, 4, vi.fn());
    expect(out).toBe(msgs);
  });
});

describe("latestPhotoSourcePath (the edit-follow-up seam)", () => {
  // 2026-11-02 user report: photo sent → edit attempt → "key expired, get a
  // new one" → user adds the key → "try now" — and the model asked for the
  // photo again because the media tools only ever looked at the CURRENT
  // turn's attachment. The bytes are persisted in scratch and the history
  // part carries the path; latestPhotoSourcePath finds the newest one so the
  // "try now" turn can still edit it.
  it("returns the sourcePath of the newest photo part in history", () => {
    const history = [
      userMsg("t1", [
        { type: "text", text: "look at this" },
        { type: "file", mediaType: "image/jpeg", data: "", sourcePath: "/p/photo-1.jpg" },
      ]),
      userMsg("t2", [{ type: "text", text: "now edit it" }]),
    ];
    expect(latestPhotoSourcePath(history)).toBe("/p/photo-1.jpg");
  });

  it("scans NEWEST-FIRST: the last photo in the last message wins", () => {
    const history = [
      userMsg("t1", [
        { type: "file", mediaType: "image/jpeg", data: "", sourcePath: "/p/photo-old.jpg" },
      ]),
      userMsg("t2", [
        { type: "file", mediaType: "image/png", data: "", sourcePath: "/p/photo-new.png" },
      ]),
    ];
    expect(latestPhotoSourcePath(history)).toBe("/p/photo-new.png");
  });

  it("null when history has no photo parts (model asks to attach)", () => {
    expect(latestPhotoSourcePath([userMsg("t", [{ type: "text", text: "hi" }])])).toBeNull();
    expect(latestPhotoSourcePath([])).toBeNull();
  });

  it("ignores file parts without a sourcePath (non-photo documents)", () => {
    const history = [
      userMsg("t1", [
        { type: "file", mediaType: "application/pdf", data: "" },
        { type: "file", mediaType: "image/jpeg", data: "", sourcePath: "/p/only.jpg" },
      ]),
    ];
    expect(latestPhotoSourcePath(history)).toBe("/p/only.jpg");
  });
});
