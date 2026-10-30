import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { findNext, findPrevious, replaceAll, replaceNext } from "@codemirror/search";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import TextSelect from "lucide-react/dist/esm/icons/text-select";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { Collapsible } from "@/components/application/collapsible/collapsible";
import { cx } from "@/utils/cx";
import {
  EDITOR_SEARCH_MATCH_LIMIT,
  EMPTY_EDITOR_SEARCH_MATCH_INFO,
  collectEditorSearchMatches,
  createEditorSearchQuery,
  dispatchEditorSearchQuery,
  editorSearchMatchInfo,
  type EditorSearchMatchInfo,
  type EditorSearchQueryOptions,
} from "./editor-search";

/** Typing debounce before the query is written to CodeMirror and the first
 *  match is selected. */
const SEARCH_DEBOUNCE_MS = 120;
/** Edits elsewhere in the document only refresh the match counter. */
const DOCUMENT_SEARCH_DEBOUNCE_MS = 400;
/** Ignore very long selections when seeding the find field. */
const SEED_SELECTION_MAX_CHARS = 200;

function requestIdle(callback: () => void): number {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(callback, { timeout: 500 });
  }
  return window.setTimeout(callback, 0);
}

function cancelIdle(handle: number) {
  if (typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle);
  } else {
    window.clearTimeout(handle);
  }
}

export interface EditorSearchFocusRequest {
  target: "find" | "replace";
  /** Bumped on every open request so focusing the already-open panel works. */
  token: number;
}

export interface EditorSearchPanelProps {
  view: EditorView | null;
  open: boolean;
  showReplace: boolean;
  readOnly: boolean;
  focusRequest: EditorSearchFocusRequest;
  /** Current editor text; a change refreshes the match counter while open. */
  documentText: string;
  onShowReplaceChange: (show: boolean) => void;
  onClose: () => void;
}

const ICON_BUTTON_CLASS =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-icon-tertiary outline-none transition-colors duration-150 ease hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground-icon-tertiary motion-reduce:transition-none";

const FIELD_CLASS =
  "flex h-7 min-w-0 flex-1 items-center rounded-md border border-border-button-default bg-background-primary-default focus-within:border-border-focus-ring focus-within:ring-1 focus-within:ring-border-focus-ring";

const INPUT_CLASS =
  "editor-search-input h-full min-w-0 flex-1 bg-transparent px-2 text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary";

/** Keeps focus in the find field while a toolbar button is pressed. */
function keepInputFocus(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

/**
 * Floating find/replace card for the file code editor, modelled on dbx.
 *
 * CodeMirror owns the search state, match highlighting and navigation
 * commands; this component owns the visible UI. The native CodeMirror panel is
 * suppressed by `createEditorSearchExtensions`, and the host opens/closes the
 * panel state (`openSearchPanel` / `closeSearchPanel`) alongside this flag.
 */
export function EditorSearchPanel({
  view,
  open,
  showReplace,
  readOnly,
  focusRequest,
  documentText,
  onShowReplaceChange,
  onClose,
}: EditorSearchPanelProps) {
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchInfo, setMatchInfo] = useState<EditorSearchMatchInfo>(
    EMPTY_EDITOR_SEARCH_MATCH_INFO,
  );
  const [selectionLimited, setSelectionLimited] = useState(false);
  // Bumped after IME composition so the debounced search runs even when no
  // further input event follows compositionend.
  const [searchNonce, setSearchNonce] = useState(0);

  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const idleRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);
  // Seeding the query from a selection updates `searchText` after the open
  // render; select the value once it is actually in the input.
  const pendingSeedRef = useRef<string | null>(null);
  const focusTargetRef = useRef<"find" | "replace">("find");

  const clearTimers = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (idleRef.current !== null) {
      cancelIdle(idleRef.current);
      idleRef.current = null;
    }
  }, []);

  const queryOptions = useCallback(
    (): EditorSearchQueryOptions => ({
      search: searchText,
      replace: replaceText,
      caseSensitive,
      regexp: useRegex,
      wholeWord,
    }),
    [searchText, replaceText, caseSensitive, useRegex, wholeWord],
  );

  /** Write the query to CodeMirror, then count on an idle tick. */
  const scheduleMatches = useCallback(
    (options: EditorSearchQueryOptions, delay: number, autoSelect: boolean) => {
      if (!view) return;
      clearTimers();
      const query = dispatchEditorSearchQuery(view, options);
      setSelectionLimited(false);
      if (!options.search) {
        setMatchInfo(EMPTY_EDITOR_SEARCH_MATCH_INFO);
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        idleRef.current = requestIdle(() => {
          idleRef.current = null;
          if (autoSelect && query.valid) findNext(view);
          setMatchInfo(editorSearchMatchInfo(view.state, query));
        });
      }, delay);
    },
    [view, clearTimers],
  );

  // Declared before the query effect: when both the document and the query
  // change, the query effect runs last and wins (auto-select + shorter delay).
  useEffect(() => {
    if (!open || !view) return;
    const options = queryOptions();
    if (!options.search) return;
    const query = createEditorSearchQuery(options);
    if (!query.valid) return;
    clearTimers();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      idleRef.current = requestIdle(() => {
        idleRef.current = null;
        setMatchInfo(editorSearchMatchInfo(view.state, query));
      });
    }, DOCUMENT_SEARCH_DEBOUNCE_MS);
    // `queryOptions` is intentionally omitted: it is read from the render in
    // which the document changed, and including it would re-run on typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentText, open, view, clearTimers]);

  useEffect(() => {
    if (!open || !view || composingRef.current) return;
    scheduleMatches(
      {
        search: searchText,
        replace: replaceText,
        caseSensitive,
        regexp: useRegex,
        wholeWord,
      },
      SEARCH_DEBOUNCE_MS,
      true,
    );
    // `replaceText` is intentionally omitted: editing the replacement must
    // not move the selection to the next match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, searchText, caseSensitive, useRegex, wholeWord, searchNonce, scheduleMatches]);

  useEffect(() => {
    if (open === wasOpenRef.current) return;
    wasOpenRef.current = open;
    if (!open) {
      clearTimers();
      setMatchInfo(EMPTY_EDITOR_SEARCH_MATCH_INFO);
      setSelectionLimited(false);
      return;
    }
    setSelectionLimited(false);
    if (!view) return;
    const selection = view.state.selection.main;
    if (selection.empty) return;
    const selected = view.state.sliceDoc(selection.from, selection.to);
    if (
      selected !== searchText &&
      selected &&
      !selected.includes("\n") &&
      selected.length <= SEED_SELECTION_MAX_CHARS
    ) {
      pendingSeedRef.current = selected;
      setSearchText(selected);
    }
    // `searchText` is read only on the open transition; adding it to the deps
    // would re-seed while the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, clearTimers]);

  // Runs after the seeded value is rendered. It deliberately does not depend
  // on `open`: on the open commit the input still holds the old text, so
  // selecting there would leave the stale value highlighted. The effect may
  // also run in the same commit as the seed (mount with `open` already true),
  // so wait until the rendered value actually matches the pending seed.
  useEffect(() => {
    const pending = pendingSeedRef.current;
    if (!open || pending === null || searchText !== pending) return;
    pendingSeedRef.current = null;
    const input =
      focusTargetRef.current === "replace" ? replaceInputRef.current : findInputRef.current;
    input?.focus();
    input?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  useEffect(() => {
    if (!open) return;
    focusTargetRef.current = focusRequest.target;
    const input = focusRequest.target === "replace" ? replaceInputRef.current : findInputRef.current;
    input?.focus();
    input?.select();
  }, [open, focusRequest.token, focusRequest.target]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const goToMatch = (direction: "next" | "prev") => {
    if (!view) return;
    const query = createEditorSearchQuery(queryOptions());
    if (!query.valid) return;
    const moved = direction === "next" ? findNext(view) : findPrevious(view);
    if (moved) setMatchInfo(editorSearchMatchInfo(view.state, query));
  };

  const replaceCurrent = () => {
    if (!view || readOnly) return;
    const query = createEditorSearchQuery(queryOptions());
    if (!query.valid) return;
    replaceNext(view);
    setMatchInfo(editorSearchMatchInfo(view.state, query));
  };

  const replaceEvery = () => {
    if (!view || readOnly) return;
    const query = createEditorSearchQuery(queryOptions());
    if (!query.valid) return;
    replaceAll(view);
    setMatchInfo(editorSearchMatchInfo(view.state, query));
  };

  const selectAllMatches = () => {
    if (!view) return;
    const query = createEditorSearchQuery(queryOptions());
    if (!query.valid) return;
    const matches = collectEditorSearchMatches(
      view.state,
      query,
      EDITOR_SEARCH_MATCH_LIMIT + 1,
    );
    if (matches.length === 0) return;
    const limited = matches.length > EDITOR_SEARCH_MATCH_LIMIT;
    const selected = limited ? matches.slice(0, EDITOR_SEARCH_MATCH_LIMIT) : matches;
    view.dispatch({
      selection: EditorSelection.create(
        selected.map((match) => EditorSelection.range(match.from, match.to)),
      ),
      scrollIntoView: true,
    });
    setSelectionLimited(limited);
    setMatchInfo(editorSearchMatchInfo(view.state, query));
    view.focus();
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      goToMatch(event.shiftKey ? "prev" : "next");
    }
  };

  const handleReplaceKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      replaceCurrent();
    }
  };

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const handleReplaceTextChange = (value: string) => {
    setReplaceText(value);
    if (!view || !open) return;
    dispatchEditorSearchQuery(view, {
      search: searchText,
      replace: value,
      caseSensitive,
      regexp: useRegex,
      wholeWord,
    });
  };

  const hasQuery = searchText.length > 0;
  const noMatches = hasQuery && matchInfo.total === 0;
  const canReplace = !readOnly && hasQuery && matchInfo.total > 0;
  const statusText = selectionLimited
    ? t("files.editorSearch.selectionLimitSummary", { limit: EDITOR_SEARCH_MATCH_LIMIT })
    : hasQuery && matchInfo.total > 0
      ? `${matchInfo.index}/${matchInfo.total}${matchInfo.truncated ? "+" : ""}`
      : t("files.editorSearch.noResults");

  const toggleClass = (active: boolean) =>
    cx(
      "flex h-5 min-w-6 shrink-0 cursor-pointer items-center justify-center rounded px-1 text-caption-1-medium outline-none transition-colors duration-150 ease focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none",
      active
        ? "bg-background-tertiary-default text-text-primary"
        : "text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary",
    );

  return (
    <div
      role="search"
      aria-label={t("files.editorSearch.panelLabel")}
      onKeyDown={handlePanelKeyDown}
      className={cx(
        "absolute top-2 right-3 z-20 flex w-[460px] max-w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-border-button-default bg-background-primary-default p-1.5 text-text-primary shadow-lg",
        open ? "animate-editor-search-in motion-reduce:animate-none" : "hidden",
      )}
    >
      <div className="flex items-center gap-1">
        {!readOnly && (
          <button
            type="button"
            className={ICON_BUTTON_CLASS}
            onClick={() => onShowReplaceChange(!showReplace)}
            onMouseDown={keepInputFocus}
            aria-expanded={showReplace}
            aria-label={t(
              showReplace
                ? "files.editorSearch.collapseReplace"
                : "files.editorSearch.expandReplace",
            )}
            title={t(
              showReplace
                ? "files.editorSearch.collapseReplace"
                : "files.editorSearch.expandReplace",
            )}
          >
            <ChevronRight
              className={cx(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showReplace && "rotate-90",
              )}
              aria-hidden
            />
          </button>
        )}
        <div className={FIELD_CLASS}>
          <input
            ref={findInputRef}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              setSearchNonce((value) => value + 1);
            }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t("files.editorSearch.find")}
            aria-label={t("files.editorSearch.find")}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            className={toggleClass(caseSensitive)}
            onClick={() => setCaseSensitive((value) => !value)}
            onMouseDown={keepInputFocus}
            aria-pressed={caseSensitive}
            aria-label={t("files.editorSearch.caseSensitive")}
            title={t("files.editorSearch.caseSensitive")}
          >
            Aa
          </button>
          <button
            type="button"
            className={toggleClass(wholeWord)}
            onClick={() => setWholeWord((value) => !value)}
            onMouseDown={keepInputFocus}
            aria-pressed={wholeWord}
            aria-label={t("files.editorSearch.wholeWord")}
            title={t("files.editorSearch.wholeWord")}
          >
            W
          </button>
          <button
            type="button"
            className={cx(toggleClass(useRegex), "mr-1 font-mono")}
            onClick={() => setUseRegex((value) => !value)}
            onMouseDown={keepInputFocus}
            aria-pressed={useRegex}
            aria-label={t("files.editorSearch.regex")}
            title={t("files.editorSearch.regex")}
          >
            .*
          </button>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={cx(
            "min-w-[3.4rem] shrink-0 text-center text-caption-1-regular",
            noMatches ? "text-text-error-primary" : "text-text-tertiary",
          )}
        >
          {statusText}
        </span>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={selectAllMatches}
          onMouseDown={keepInputFocus}
          disabled={!hasQuery || matchInfo.total === 0}
          aria-label={t("files.editorSearch.selectAllMatches")}
          title={t("files.editorSearch.selectAllMatches")}
        >
          <TextSelect className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={() => goToMatch("prev")}
          onMouseDown={keepInputFocus}
          disabled={!hasQuery || matchInfo.total === 0}
          aria-label={t("files.editorSearch.previousMatch")}
          title={t("files.editorSearch.previousMatch")}
        >
          <ChevronUp className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={() => goToMatch("next")}
          onMouseDown={keepInputFocus}
          disabled={!hasQuery || matchInfo.total === 0}
          aria-label={t("files.editorSearch.nextMatch")}
          title={t("files.editorSearch.nextMatch")}
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className={ICON_BUTTON_CLASS}
          onClick={onClose}
          onMouseDown={keepInputFocus}
          aria-label={t("files.editorSearch.close")}
          title={t("files.editorSearch.close")}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <Collapsible open={showReplace && !readOnly} seconds={0.15}>
        <div className="flex items-center gap-1 pt-0.5">
          <span className="size-6 shrink-0" aria-hidden />
          <div className={FIELD_CLASS}>
            <input
              ref={replaceInputRef}
              value={replaceText}
              onChange={(event) => handleReplaceTextChange(event.target.value)}
              onKeyDown={handleReplaceKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("files.editorSearch.replace")}
              aria-label={t("files.editorSearch.replace")}
              className={INPUT_CLASS}
            />
          </div>
          <Button
            variant="secondary"
            size="xs"
            onMouseDown={keepInputFocus}
            disabled={!canReplace}
            onClick={replaceCurrent}
          >
            {t("files.editorSearch.replace")}
          </Button>
          <Button
            variant="secondary"
            size="xs"
            onMouseDown={keepInputFocus}
            disabled={!canReplace}
            onClick={replaceEvery}
          >
            {t("files.editorSearch.replaceAll")}
          </Button>
        </div>
      </Collapsible>
    </div>
  );
}
