import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KEY_SEP } from "@/lib/platform";
import type { EditorPaneHandle } from "@/modules/editor";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence, motion } from "motion/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

const TERM_DECORATIONS = {
  matchBackground: "#515c6a",
  activeMatchBackground: "#d18616",
  matchOverviewRuler: "#d18616",
  activeMatchColorOverviewRuler: "#d18616",
};

export type SearchTarget =
  | { kind: "terminal"; addon: SearchAddon; focus: () => void }
  | { kind: "editor"; handle: EditorPaneHandle; focus: () => void }
  | null;

export type SearchInlineHandle = {
  focus: () => void;
  /** Open with replace row visible (Ctrl+H). */
  focusReplace: () => void;
};

type Props = {
  target: SearchTarget;
  /** When true, collapse to an icon-only button until the user opens it. */
  compact?: boolean;
};

export const SearchInline = forwardRef<SearchInlineHandle, Props>(
  function SearchInline({ target, compact }, ref) {
    const [q, setQ] = useState("");
    const [replaceText, setReplaceText] = useState("");
    const [showReplace, setShowReplace] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [useRegexp, setUseRegexp] = useState(false);
    // In compact mode the field is hidden behind an icon until activated.
    // In normal mode the field is always present.
    const [openInCompact, setOpenInCompact] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const replaceInputRef = useRef<HTMLInputElement>(null);
    const pendingFocusRef = useRef(false);
    const pendingReplaceFocusRef = useRef(false);
    const setInputRef = useCallback((el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (!el || !pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      el.focus();
    }, []);

    const isEditor = target?.kind === "editor";

    const userShortcuts = usePreferencesStore((s) => s.shortcuts);

    const shortcutText = useMemo(() => {
      const s = SHORTCUTS.find((s) => s.id === "search.focus");
      if (!s) return "";
      const bindings = userShortcuts["search.focus"] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      const tokens = getBindingTokens(bindings[0]);
      return tokens.join(KEY_SEP);
    }, [userShortcuts]);

    const placeholder = useMemo(() => {
      return shortcutText ? `Search (${shortcutText})` : "Search";
    }, [shortcutText]);

    const tooltipTitle = useMemo(() => {
      return shortcutText ? `Search (${shortcutText})` : "Search";
    }, [shortcutText]);

    const expanded = !compact || openInCompact;

    const focus = useCallback(() => {
      pendingFocusRef.current = true;
      if (compact) setOpenInCompact(true);
      else inputRef.current?.focus();
      if (inputRef.current) pendingFocusRef.current = false;
    }, [compact]);

    const focusReplace = useCallback(() => {
      if (!isEditor) { focus(); return; }
      setShowReplace(true);
      if (compact) setOpenInCompact(true);
      pendingReplaceFocusRef.current = true;
      requestAnimationFrame(() => {
        if (replaceInputRef.current) {
          replaceInputRef.current.focus();
          pendingReplaceFocusRef.current = false;
        }
      });
    }, [compact, focus, isEditor]);

    useImperativeHandle(ref, () => ({ focus, focusReplace }), [focus, focusReplace]);

    const clearTarget = useCallback(() => {
      if (!target) return;
      if (target.kind === "terminal") target.addon.clearDecorations();
      else target.handle.clearQuery();
    }, [target]);

    const restoreTargetFocus = useCallback(() => {
      if (!target) return;
      target.focus();
    }, [target]);

    // Target switched (terminal ↔ editor) or removed → drop highlights.
    useEffect(() => clearTarget, [clearTarget]);

    const syncSearch = useCallback((search: string, replace?: string) => {
      if (!target) return;
      if (target.kind === "terminal") {
        if (search) {
          target.addon.findNext(search, {
            incremental: true,
            decorations: TERM_DECORATIONS,
          });
        } else {
          target.addon.clearDecorations();
        }
      } else {
        target.handle.setSearchReplace(
          search,
          replace ?? replaceText,
          caseSensitive,
          useRegexp,
        );
      }
    }, [target, replaceText, caseSensitive, useRegexp]);

    const findDirection = (forward: boolean) => {
      if (!target || !q) return;
      if (target.kind === "terminal") {
        const opts = { decorations: TERM_DECORATIONS };
        if (forward) target.addon.findNext(q, opts);
        else target.addon.findPrevious(q, opts);
      } else {
        if (forward) target.handle.findNext();
        else target.handle.findPrevious();
      }
    };

    const handleReplaceNext = useCallback(() => {
      if (target?.kind === "editor") target.handle.replaceNext();
    }, [target]);

    const handleReplaceAll = useCallback(() => {
      if (target?.kind === "editor") target.handle.replaceAll();
    }, [target]);

    // Re-sync search config when toggles change.
    useEffect(() => {
      if (q && target?.kind === "editor") syncSearch(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [caseSensitive, useRegexp]);

    // Hide replace row when switching away from editor.
    useEffect(() => {
      if (!isEditor) setShowReplace(false);
    }, [isEditor]);

    return (
      <motion.div
        layout
        initial={false}
        animate={{ width: expanded ? (showReplace ? 280 : 192) : 28 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        className="relative shrink-0 h-7"
      >
        <AnimatePresence initial={false} mode="wait">
          {expanded ? (
            <motion.div
              key="input"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="absolute top-0 right-0 left-0 z-10 flex flex-col gap-0.5"
            >
              {/* ── Find row ── */}
              <div className="relative h-7">
                <HugeiconsIcon
                  icon={Search01Icon}
                  size={13}
                  strokeWidth={1.75}
                  className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={setInputRef}
                  value={q}
                  placeholder={placeholder}
                  className="h-7 w-full bg-muted/80 pr-16 pl-7 text-[13px]! placeholder:text-muted-foreground/70 focus-visible:ring-0"
                  onChange={(e) => {
                    const next = e.target.value;
                    setQ(next);
                    syncSearch(next);
                  }}
                  onBlur={() => {
                    if (compact && !q && !showReplace) setOpenInCompact(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      findDirection(!e.shiftKey);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      clearTarget();
                      setQ("");
                      setReplaceText("");
                      setShowReplace(false);
                      if (compact) setOpenInCompact(false);
                      restoreTargetFocus();
                    }
                  }}
                />
                {/* Toggle buttons */}
                <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
                  {isEditor && (
                    <>
                      <button
                        type="button"
                        onClick={() => setCaseSensitive((v) => !v)}
                        className={`rounded p-0.5 text-[10px] font-bold transition-colors ${caseSensitive ? "bg-foreground/10 text-foreground" : "text-muted-foreground/60 hover:text-muted-foreground"}`}
                        title="Case sensitive"
                      >
                        Aa
                      </button>
                      <button
                        type="button"
                        onClick={() => setUseRegexp((v) => !v)}
                        className={`rounded p-0.5 text-[10px] font-bold transition-colors ${useRegexp ? "bg-foreground/10 text-foreground" : "text-muted-foreground/60 hover:text-muted-foreground"}`}
                        title="Regex"
                      >
                        .*
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowReplace((v) => !v)}
                        className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                        title="Toggle replace"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} className="rotate-45" />
                      </button>
                    </>
                  )}
                  {q && (
                    <button
                      type="button"
                      onClick={() => {
                        setQ("");
                        clearTarget();
                        inputRef.current?.focus();
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>

              {/* ── Replace row (editor only) ── */}
              {showReplace && isEditor && (
                <div className="relative h-7">
                  <Input
                    ref={replaceInputRef}
                    value={replaceText}
                    placeholder="Replace"
                    className="h-7 w-full bg-muted/80 pr-20 pl-2 text-[13px]! placeholder:text-muted-foreground/70 focus-visible:ring-0"
                    onChange={(e) => {
                      setReplaceText(e.target.value);
                      if (q) syncSearch(q, e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleReplaceNext();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setShowReplace(false);
                        inputRef.current?.focus();
                      }
                    }}
                  />
                  <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
                    <button
                      type="button"
                      onClick={handleReplaceNext}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title="Replace next"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={handleReplaceAll}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title="Replace all"
                    >
                      All
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="icon"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="absolute inset-0 flex items-center justify-end"
            >
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={focus}
                title={tooltipTitle}
              >
                <HugeiconsIcon
                  icon={Search01Icon}
                  size={15}
                  strokeWidth={1.75}
                />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  },
);
