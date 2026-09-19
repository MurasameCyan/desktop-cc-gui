"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Search from "lucide-react/dist/esm/icons/search";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import type { AiChatRepo } from "@/components/application/ai-chat/sidebar-types";
import { cx } from "@/utils/cx";

/** Hard cap on listed rows: the palette is a jumper, not a browser. */
const MAX_RESULTS = 50;

interface SessionMatch {
  id: string;
  label: string;
  engine?: string;
  workspace: string;
}

/**
 * Session quick-search palette (sidebar strip icon / ⌘L). Title-only:
 * matches session labels (and workspace names, which surface that
 * workspace's sessions) — message-content search is deliberately out of
 * scope. Empty query lists the most recent sessions in sidebar order.
 * Enter/click jumps to the session; Esc or a backdrop press closes.
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
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

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
          workspace: repo.label,
        });
        if (out.length >= MAX_RESULTS) return out;
      }
    }
    return out;
  }, [repos, query]);

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
        setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const match = matches[Math.min(activeIndex, Math.max(0, matches.length - 1))];
        if (match) jump(match);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matches, activeIndex, onClose]);

  // The filtered list can shrink under the cursor; clamp the active row.
  const active = Math.min(activeIndex, Math.max(0, matches.length - 1));

  // Keep the keyboard-highlighted row visible while arrowing through a
  // scrolled list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
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
        </div>
        <div ref={listRef} role="listbox" className="max-h-[320px] overflow-y-auto p-2">
          {matches.length === 0 ? (
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
                <span className="shrink-0 text-caption-1-medium text-text-tertiary">
                  {match.workspace}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
}
