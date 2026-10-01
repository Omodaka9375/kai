import {
  findNext,
  findPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { keymap, EditorView } from "@codemirror/view";
import { usePreferencesStore } from "@/modules/settings/preferences";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EDITOR_THEME_EXT } from "./lib/themes";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Prec } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import {
  buildSharedExtensions,
  languageCompartment,
  vimCompartment,
  wrapCompartment,
} from "./lib/extensions";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();
import { resolveLanguage } from "./lib/languageResolver";
import { useDocument } from "./lib/useDocument";
import type { SaveOutcome } from "./lib/useDocument";
import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  formatDocument,
  formatSelection,
} from "./lib/formatter";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "avi"]);
const PDF_EXT = "pdf";

const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

function fileExt(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** Read binary file via Rust and return a blob URL. */
function useBlobUrl(path: string, mime: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let revoke: string | null = null;
    invoke<number[]>("fs_read_file_bytes", { path, workspace: currentWorkspaceEnv() })
      .then((bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [path, mime, enabled]);
  return url;
}

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  setSearchReplace: (search: string, replace: string, caseSensitive: boolean, regexp: boolean) => void;
  findNext: () => void;
  findPrevious: () => void;
  replaceNext: () => void;
  replaceAll: () => void;
  clearQuery: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  scrollToLine: (lineNum: number) => void;
  /** Save the buffer to disk. No-op if not dirty. */
  save: () => Promise<void>;
  /** Format the document (or just the selection). Rejects on formatter
   *  failure — the caller (App context menu) surfaces the error. */
  format: (selectionOnly: boolean) => Promise<void>;
};

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Replace the whole document. Only dispatches when the text actually
 *  changed (prettier can return an identical string) so we don't mark the
 *  buffer dirty (and add an undo step) for a no-op format. */
function applyFormattedDoc(view: EditorView, formatted: string) {
  const current = view.state.doc.toString();
  if (formatted === current) return;
  view.dispatch({
    changes: { from: 0, to: current.length, insert: formatted },
  });
}

export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane({ path, onDirtyChange, onSaved, onClose }, ref) {
    const { doc, dirty, conflict, onChange, save, overwriteDisk, reload, takeDiskVersion } =
      useDocument({ path, onDirtyChange });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const takeDiskRef = useRef(takeDiskVersion);
    takeDiskRef.current = takeDiskVersion;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const editorThemeId = usePreferencesStore((s) => s.editorTheme);
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const wordWrap = usePreferencesStore((s) => s.editorWordWrap);
    const themeExt = EDITOR_THEME_EXT[editorThemeId] ?? EDITOR_THEME_EXT.atomone;

    // ── Formatting (invoked from the App-level context menu) ────────────
    const formatBusyRef = useRef(false);
    const doFormat = useCallback(async (selectionOnly: boolean): Promise<void> => {
      const view = cmRef.current?.view;
      if (!view || formatBusyRef.current) return;
      formatBusyRef.current = true;
      try {
        const source = view.state.doc.toString();
        const range = view.state.selection.main;
        const hasSelection = !range.empty;

        if (selectionOnly && hasSelection) {
          const fragment = view.state.sliceDoc(range.from, range.to);
          const formatted = await formatSelection(path, fragment);
          if (formatted === null) {
            // Fragment can't be wrapped (e.g. json) — format the whole doc.
            const whole = await formatDocument(path, source);
            applyFormattedDoc(view, whole);
          } else if (formatted !== fragment) {
            view.dispatch({
              changes: { from: range.from, to: range.to, insert: formatted },
              // Keep the formatted text selected so the user sees what changed.
              selection: { anchor: range.from, head: range.from + formatted.length },
            });
          }
        } else {
          const whole = await formatDocument(path, source);
          applyFormattedDoc(view, whole);
        }
        view.focus();
      } finally {
        formatBusyRef.current = false;
      }
    }, [path]);

    const doFormatRef = useRef(doFormat);
    doFormatRef.current = doFormat;

    // Stabilize save + onSaved via refs
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const overwriteRef = useRef(overwriteDisk);
    overwriteRef.current = overwriteDisk;
    const conflictRef = useRef(conflict);
    conflictRef.current = conflict;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    /** Shared save path: refuses to clobber on conflict, reports outcome.
     *  `onSaved` fires only on a successful write. */
    const saveAndReport = useCallback(async (): Promise<SaveOutcome> => {
      const outcome = conflictRef.current
        ? { ok: false as const, conflict: true as const }
        : await saveRef.current();
      if (outcome.ok) onSavedRef.current?.();
      return outcome;
    }, []);
    const saveAndReportRef = useRef(saveAndReport);
    saveAndReportRef.current = saveAndReport;

    const [overwriteBusy, setOverwriteBusy] = useState(false);
    const [overwriteError, setOverwriteError] = useState<string | null>(null);
    const doOverwrite = useCallback(async () => {
      if (overwriteBusy) return;
      setOverwriteBusy(true);
      setOverwriteError(null);
      try {
        const outcome = await overwriteRef.current();
        if (!outcome.ok) {
          if (outcome.conflict) {
            setOverwriteError("conflict");
          } else {
            setOverwriteError(outcome.error);
          }
        }
      } catch (e) {
        setOverwriteError(String(e));
      } finally {
        setOverwriteBusy(false);
      }
    }, [overwriteBusy]);
    const doOverwriteRef = useRef(doOverwrite);
    doOverwriteRef.current = doOverwrite;
    const [takeDiskBusy, setTakeDiskBusy] = useState(false);
    const doTakeDisk = useCallback(async () => {
      if (takeDiskBusy) return;
      setTakeDiskBusy(true);
      try {
        await takeDiskRef.current();
      } catch {
        // ignore
      } finally {
        setTakeDiskBusy(false);
      }
    }, [takeDiskBusy]);

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void (async () => {
              await saveAndReportRef.current();
            })();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        languageCompartment.of([]),
        wrapCompartment.of(
          usePreferencesStore.getState().editorWordWrap
            ? EditorView.lineWrapping
            : [],
        ),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void (async () => {
                await saveAndReportRef.current();
              })();
              return true;
            },
          },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(
          vimMode ? Prec.highest(vim()) : [],
        ),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          wordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [wordWrap]);

    useEffect(() => {
      let cancelled = false;
      resolveLanguage(path).then((ext) => {
        if (cancelled) return;
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(ext ?? []),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        setSearchReplace: (search: string, replace: string, caseSensitive: boolean, regexp: boolean) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search, replace, caseSensitive, regexp }),
            ),
          });
          if (search) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        replaceNext: () => {
          const view = cmRef.current?.view;
          if (view) cmReplaceNext(view);
        },
        replaceAll: () => {
          const view = cmRef.current?.view;
          if (view) cmReplaceAll(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        focus: () => {
          cmRef.current?.view?.focus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        save: async () => {
          await saveAndReportRef.current();
        },
        format: async (selectionOnly: boolean) => {
          await doFormatRef.current(selectionOnly);
        },
        scrollToLine: (lineNum: number) => {
          const view = cmRef.current?.view;
          if (!view) return;
          try {
            const line = view.state.doc.line(Math.max(1, Math.min(lineNum, view.state.doc.lines)));
            view.dispatch({
              effects: EditorView.scrollIntoView(line.from, { y: "center" }),
              selection: { anchor: line.from },
            });
            view.focus();
          } catch (e) {
            console.error("scrollToLine failed:", e);
          }
        },
      }),
      [path],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary") {
      const ext = fileExt(path);
      if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || ext === PDF_EXT) {
        return <BinaryPreview path={path} ext={ext} />;
      }
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">Binary file</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} · preview not supported
          </div>
        </div>
      );
    }
    if (doc.status === "toolarge") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">File too large</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} exceeds the {formatBytes(doc.limit)} limit.
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        {conflict && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400"
            role="alert"
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium">File changed on disk.</span>{" "}
              {dirty
                ? "Your unsaved edits conflict with the external change (e.g. the AI agent). Reload to take the new version — your edits are discarded — or overwrite to keep your buffer."
                : "The file changed outside the editor while you had it open. Your buffer is now out of date."}
            </span>
            <button
              type="button"
              disabled={takeDiskBusy}
              onClick={() => void doTakeDisk()}
              className="rounded border border-amber-600/50 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
            >
              {takeDiskBusy ? "Reloading…" : dirty ? "Reload (discard my edits)" : "Reload"}
            </button>
            {dirty && (
              <button
                type="button"
                disabled={overwriteBusy}
                onClick={() => void doOverwrite()}
                className="rounded border border-amber-600/50 bg-amber-500/15 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
              >
                {overwriteBusy ? "Writing…" : "Overwrite with my edits"}
              </button>
            )}
            {overwriteError && (
              <span className="w-full text-destructive">{overwriteError}</span>
            )}
          </div>
        )}
        <CodeMirror
          ref={cmRef}
          value={doc.content}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            searchKeymap: true,
          }}
        />
      </div>
    );
  },
);

function BinaryPreview({ path, ext }: { path: string; ext: string }) {
  const mime = MIME_MAP[ext] ?? "application/octet-stream";
  const url = useBlobUrl(path, mime, true);

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading preview…
      </div>
    );
  }

  if (IMAGE_EXTS.has(ext)) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-background p-4">
        <img
          src={url}
          alt={path.split(/[\\/]/).pop() ?? ""}
          className="max-h-full max-w-full object-contain rounded"
          draggable={false}
        />
      </div>
    );
  }

  if (VIDEO_EXTS.has(ext)) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-background p-4">
        <video src={url} controls className="max-h-full max-w-full rounded" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <iframe
        src={url}
        title={path.split(/[\\/]/).pop() ?? "PDF"}
        className="h-full w-full border-0"
      />
    </div>
  );
}
