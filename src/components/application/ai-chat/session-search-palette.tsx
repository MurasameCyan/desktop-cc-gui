"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Search from "lucide-react/dist/esm/icons/search";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import type { AiChatRepo } from "@/components/application/ai-chat/sidebar-types";
import { cx } from "@/utils/cx";
import { useBrowserOcclusion } from "@/features/browser/occlusion";
import { ipc, type MessageSearchHit } from "@/lib/ipc";
import { relativeTime } from "@/features/chat/time";

/** Hard cap on listed rows: the palette is a jumper, not a browser. */
const MAX_RESULTS = 50;
/** Content hits fetched per query — small on purpose, ranked by bm25. */
const CONTENT_LIMIT = 20;
/** Debounce before a content query fires (agentsview uses the same 300ms). */
const CONTENT_DEBOUNCE_MS = 300;
/** Content search needs at least this many chars; title match runs always. */
const CONTENT_MIN_CHARS = 2;

interface SessionMatch {
  id: string;
  label: string;
  engine?: string;
  /** Relative-time chip (e.g. "34m"), same string the sidebar shows. */
  time: string;
  workspace: string;
}

/**
 * Session quick-search palette (sidebar strip icon / ⌘L). Two lanes: title
 * matches are instant and local; message-content hits come from the
 * backend's FTS5 trigram index (debounced, stale responses dropped by a
 * request counter). Empty query lists the most recent sessions in sidebar
 * order. Enter/click jumps to the session; Esc or a backdrop press closes.
 *
 * Dialog mechanics (native <dialog>, backdrop press-to-close, window-level
 * key navigation) mirror the ⌘K command palette.
 */
export function SessionSearchPalette({
  open,
  repos,
  onClose,
  onThreadSelect,
}: {
  open: boolean;
  /** Every workspace (sections already flattened by the caller). */
  repos: AiChatRepo[];
  onClose: () => void;
  onThreadSelect?: (id: string) => void;
}) {
  const { t } = useTranslation();
  useBrowserOcclusion(open);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [sort, setSort] = useState<"relevance" | "recency">("relevance");
  const [contentHits, setContentHits] = useState<MessageSearchHit[]>([]);
  const [contentPending, setContentPending] = useState(0);
  // Invalidate in-flight content responses: Tauri invoke cannot be
  // aborted, so a monotonically increasing request id drops late arrivals
  // (agentsview's requestVersion — the AbortController equivalent here).
  const requestSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trimmedQuery = query.trim();

  const matches = useMemo<SessionMatch[]>(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const out: SessionMatch[] = [];
    for (const repo of repos) {
      const repoHit = normalized
        ? repo.label.toLocaleLowerCase().includes(normalized)
        : false;
      for (const thread of repo.threads) {
        if (!thread.id) continue;
        if (
          normalized &&
          !repoHit &&
          !thread.label.toLocaleLowerCase().includes(normalized)
        ) {
          continue;
        }
        out.push({
          id: thread.id,
          label: thread.label,
          engine: thread.engine,
          time: thread.time,
          workspace: repo.label,
        });
        if (out.length >= MAX_RESULTS) return out;
      }
    }
    return out;
  }, [repos, query]);
  // Content lane: debounced backend FTS. Title matches above are free;
  // this fires at most once per 300ms pause and only for ≥2 chars.
  useEffect(() => {
    if (!open || trimmedQuery.length < CONTENT_MIN_CHARS) {
      setContentHits([]);
      setContentPending(0);
      return;
    }
    const seq = ++requestSeq.current;
    const timer = setTimeout(() => {
      ipc
        .searchMessages(trimmedQuery, sort, CONTENT_LIMIT, 0)
        .then((page) => {
          if (requestSeq.current !== seq) return;
          setContentHits(page.hits);
          setContentPending(page.pending);
        })
        .catch(() => {
          if (requestSeq.current !== seq) return;
          setContentHits([]);
        });
    }, CONTENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, trimmedQuery, sort]);

  // A session matching by title is not repeated as a content hit.
  const content = useMemo(() => {
    if (contentHits.length === 0) return contentHits;
    const titled = new Set(matches.map((m) => m.id));
    return contentHits.filter((h) => !titled.has(`${h.engine}/${h.sessionId}`));
  }, [matches, contentHits]);
  const rowCount = matches.length + content.length;

  // Native <dialog>: keep the modal open state in sync with the prop.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Fresh query + focus every time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  const jump = (match: SessionMatch) => {
    onClose();
    onThreadSelect?.(match.id);
  };
  const jumpContent = (hit: MessageSearchHit) => {
    onClose();
    onThreadSelect?.(`${hit.engine}/${hit.sessionId}`);
  };

  const jumpRow = (index: number) => {
    if (index < matches.length) jump(matches[index]);
    else jumpContent(content[index - matches.length]);
  };

  // Backdrop press-to-close (see CommandPalette for why this is a window
  // listener rather than a dialog click handler).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target === dialogRef.current) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, onClose]);

  // Keyboard navigation on window: Esc/↑/↓/Enter work regardless of which
  // element inside the palette holds focus. IME composition is left alone —
  // Enter that confirms a candidate must not jump.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, rowCount - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (rowCount > 0) jumpRow(Math.min(activeIndex, rowCount - 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matches, content, activeIndex, onClose]);

  // The filtered list can shrink under the cursor; clamp the active row.
  const active = Math.min(activeIndex, Math.max(0, rowCount - 1));

  // Keep the keyboard-highlighted row visible while arrowing through a
  // scrolled list. Section headers sit between option rows, so address by
  // role, not child index.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelectorAll("[role='option']")
      [active]?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={t("chat.searchSessions")}
      className={cx(
        "fixed inset-0 z-110 m-0 h-full max-h-none w-full max-w-none items-start justify-center bg-overlay-backdrop px-4 pt-[15vh]",
        open ? "flex" : "hidden",
      )}
      onCancel={onClose}
    >
      <div className="w-[560px] max-w-full overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <div className="flex items-center gap-2 border-b border-separator-border px-3">
          <Search className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder={t("chat.searchSessions")}
            aria-label={t("chat.searchSessions")}
            className="h-11 w-full bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-placeholder"
          />
          {trimmedQuery.length >= CONTENT_MIN_CHARS && (
            <div className="flex shrink-0 items-center gap-1">
              {(["relevance", "recency"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={sort === mode}
                  onClick={() => {
                    setSort(mode);
                    setActiveIndex(0);
                  }}
                  className={cx(
                    "cursor-pointer rounded-2lg px-2 py-1 text-caption-1-medium outline-none transition-colors",
                    sort === mode
                      ? "bg-background-secondary-default text-text-primary"
                      : "text-text-tertiary hover:bg-dropdown-item-hover-background",
                  )}
                >
                  {mode === "relevance" ? t("chat.sortByRelevance") : t("chat.sortByRecency")}
                </button>
              ))}
            </div>
          )}
        </div>
        <div ref={listRef} role="listbox" className="max-h-[320px] overflow-y-auto p-2">
          {matches.length === 0 && content.length === 0 ? (
            <div className="px-2 py-6 text-center text-body-medium text-text-secondary">
              {t("chat.noSessions")}
            </div>
          ) : (
            matches.map((match, index) => (
              <button
                key={match.id}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => jump(match)}
                className={cx(
                  "flex w-full cursor-pointer items-center gap-2 rounded-2lg px-2 py-1.5 text-left outline-none transition-colors",
                  index === active && "bg-dropdown-item-hover-background",
                )}
              >
                {match.engine && (
                  <EngineIcon
                    engine={match.engine}
                    size={12}
                    className="size-3 shrink-0 text-foreground-icon-secondary"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-body-medium text-text-primary">
                  {match.label}
                </span>
                {match.time && (
                  <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                    {match.time}
                  </span>
                )}
                <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                  {match.workspace}
                </span>
              </button>
            ))
          )}
          {content.length > 0 && (
            <div
              aria-hidden
              className="px-2 pt-2 pb-1 text-caption-1-medium text-text-tertiary"
            >
              {t("chat.searchMessageMatches")}
            </div>
          )}
          {content.map((hit, i) => {
            const index = matches.length + i;
            return (
              <button
                key={`${hit.engine}/${hit.sessionId}`}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => jumpContent(hit)}
                className={cx(
                  "flex w-full cursor-pointer flex-col gap-0.5 rounded-2lg px-2 py-1.5 text-left outline-none transition-colors",
                  index === active && "bg-dropdown-item-hover-background",
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <EngineIcon
                    engine={hit.engine}
                    size={12}
                    className="size-3 shrink-0 text-foreground-icon-secondary"
                  />
                  <span className="min-w-0 flex-1 truncate text-body-medium text-text-primary">
                    {hit.customTitle || hit.title || hit.sessionId.slice(0, 8)}
                  </span>
                  {hit.updatedAt ? (
                    <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                      {relativeTime(hit.updatedAt)}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                    {hit.workspaceName ?? hit.workspacePath}
                  </span>
                </span>
                <span className="w-full truncate pl-5 text-caption-1-medium text-text-secondary">
                  {hit.snippet.map((part, j) =>
                    part.marked ? (
                      <mark
                        key={j}
                        className="rounded-xs bg-background-tertiary-warning px-0.5 text-text-warning-primary"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <span key={j}>{part.text}</span>
                    ),
                  )}
                </span>
              </button>
            );
          })}
          {contentPending > 0 && trimmedQuery.length >= CONTENT_MIN_CHARS && (
            <div aria-live="polite" className="px-2 pt-1 pb-1 text-caption-1-medium text-text-tertiary">
              {t("chat.searchIndexing", { count: contentPending })}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
