"use client";

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import Menu from "lucide-react/dist/esm/icons/menu";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Pin from "lucide-react/dist/esm/icons/pin";
import Plus from "lucide-react/dist/esm/icons/plus";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { paginateThreads } from "@/components/application/ai-chat/repo-pagination";
import type { AiChatRepo, AiChatThread, ThreadAction } from "@/components/application/ai-chat/sidebar-types";
import { cx } from "@/utils/cx";

/** Chat row under an open repo — indented 36px, relative-time chip on the
 *  right, hover action icons (pin / rename / delete; archive lives in the
 *  right-click menu only). */
function ThreadItem({
  id,
  label,
  engine,
  time,
  pinned = false,
  isSelected = false,
  streaming = false,
  unseen = false,
  isDraft = false,
  tabIndex,
  onSelect,
  onAction,
  onContextMenu,
}: AiChatThread & {
  tabIndex?: number;
  onSelect?: (id: string) => void;
  onAction?: (id: string, action: ThreadAction) => void;
  /** Right-click anywhere on the row: opens the thread context menu. */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      onContextMenu={
        id && onContextMenu ? (event) => onContextMenu(event, id) : undefined
      }
      className={cx(
        "group flex w-full cursor-pointer items-center gap-2.5 rounded-2lg py-[5px] pr-2 pl-9 transition-colors duration-150 ease",
        isSelected ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
      )}
    >
      {/* The row body is the button; hover actions sit beside it so no
          control nests inside another. */}
      <button
        type="button"
        tabIndex={tabIndex}
        aria-current={isSelected ? "page" : undefined}
        onClick={() => id && onSelect?.(id)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
      >
        {engine && (
          <EngineIcon
            engine={engine}
            size={12}
            className="size-3 shrink-0 text-foreground-icon-secondary"
          />
        )}
        {streaming ? (
          <span
            className="sidebar-thread-status sidebar-thread-status-processing"
            role="status"
            aria-label={t("chat.sessionRunning")}
            title={t("chat.sessionRunning")}
          />
        ) : unseen ? (
          <span
            className="sidebar-thread-status sidebar-thread-status-unseen"
            aria-label={t("chat.sessionUnseen")}
            title={t("chat.sessionUnseen")}
          />
        ) : null}
        {/* Native title tooltip: hover a moment to read the full title when
            the row truncates it (same pattern as the repo row below). */}
        <span
          className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary"
          title={label}
        >
          {pinned && (
            <Pin
              fill="currentColor"
              className="mr-1 inline size-3 text-foreground-icon-secondary"
              aria-hidden
            />
          )}
          {label}
        </span>
      </button>
      {id && onAction && (
        <span className="hidden shrink-0 items-center gap-1.5 group-hover:inline-flex">
          {!isDraft && (
            <button
              type="button"
              aria-label={pinned ? t("chat.unpin") : t("chat.pin")}
              onClick={(event) => {
                event.stopPropagation();
                onAction(id, "pin");
              }}
              className="text-foreground-icon-secondary hover:text-foreground-icon-primary"
            >
              <Pin className="size-3.5" aria-hidden />
            </button>
          )}
          {!isDraft && (
            <button
              type="button"
              aria-label={t("chat.renameSession")}
              onClick={(event) => {
                event.stopPropagation();
                onAction(id, "rename");
              }}
              className="text-foreground-icon-secondary hover:text-foreground-icon-primary"
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            aria-label={t("chat.deleteSession")}
            onClick={(event) => {
              event.stopPropagation();
              onAction(id, "delete");
            }}
            className="text-foreground-icon-secondary hover:text-foreground-icon-primary"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </span>
      )}
      {time ? (
        <span className="inline-flex shrink-0 items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-caption-2-medium whitespace-nowrap text-text-secondary group-hover:hidden">
          {time}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Curved tree connector (Figma "Vector 132"): a vertical guide dropping from
 * the repo's folder icon with a rounded elbow into each thread row.
 */
function TreeConnector({ count }: { count: number }) {
  // Rows are 28px tall (py-[5px] + 18px line-height) with a 2px gap,
  // and the container's pt-0.5 pushes the first row down 2px.
  const rowPitch = 30; // 28px row + 2px gap
  const firstCenter = 16; // 2px container padding + half of the 28px row
  const height = firstCenter + rowPitch * (count - 1) + 1;
  return (
    <svg
      aria-hidden
      width="12"
      height={height}
      viewBox={`0 0 12 ${height}`}
      fill="none"
      className="pointer-events-none absolute top-0 left-[16.5px] text-foreground-icon-quaternary"
    >
      {Array.from({ length: count }, (_, i) => {
        const y = firstCenter + rowPitch * i;
        return (
          <path
            key={y}
            d={`M0.5 0 V${y - 5} Q0.5 ${y} 5.5 ${y} H11.5`}
            stroke="currentColor"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}

/** Immediate drag entry attached to a repo row's grip handle. */
interface DragHandleProps {
  onPointerDown: (event: ReactPointerEvent) => void;
}


/** The repo row itself: merged folder/reorder-grip button, label, hover
 *  actions (new session / remove) and the thread count chip. Right-click
 *  bubbles to the workspace context menu via `onContextMenu`. */
function RepoHeaderRow({
  repo,
  expanded,
  isDragging,
  dragHandleProps,
  hasHoverActions,
  dragDownPos,
  onToggleOpen,
  onNewSession,
  onRemove,
  onContextMenu,
}: {
  repo: AiChatRepo;
  expanded: boolean;
  isDragging: boolean;
  dragHandleProps: DragHandleProps | null;
  hasHoverActions: boolean;
  /** Pointer-down position on the merged folder/grip button: a press that
   *  travels past the threshold is a reorder drag, so its trailing click must
   *  not toggle the row. */
  dragDownPos: { current: { x: number; y: number } | null };
  onToggleOpen: () => void;
  onNewSession?: (id: string) => void;
  onRemove?: (id: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const Icon = expanded ? FolderOpen : FolderSymlink;
  const collapseLabel = expanded ? t("chat.collapseWorkspace") : t("chat.expandWorkspace");
  return (
    <div
      onContextMenu={onContextMenu}
      className="group flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
    >
      <button
        type="button"
        aria-label={collapseLabel}
        title={dragHandleProps ? t("chat.dragToReorder") : collapseLabel}
        onPointerDown={(event) => {
          if (!dragHandleProps) return;
          event.stopPropagation();
          dragDownPos.current = { x: event.clientX, y: event.clientY };
          dragHandleProps.onPointerDown(event);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (dragDownPos.current) {
            const dx = Math.abs(event.clientX - dragDownPos.current.x);
            const dy = Math.abs(event.clientY - dragDownPos.current.y);
            dragDownPos.current = null;
            if (dx + dy > 4) return;
          }
          onToggleOpen();
        }}
        className={cx(
          "relative -m-0.5 size-6 shrink-0 cursor-pointer rounded-md transition-colors duration-150 hover:bg-background-tertiary-hover/55",
          dragHandleProps && "group-hover:cursor-grab",
          isDragging && "cursor-grabbing",
        )}
      >
        {/* One slot, two affordances: folder by default; on row hover it
            fades out and the reorder grip fades in (when reorder is
            enabled). Plain click toggles collapse; press-and-move drags. */}
        <span
          className={cx(
            "absolute inset-0 flex items-center justify-center transition-opacity duration-150",
            dragHandleProps && "group-hover:opacity-0",
          )}
          aria-hidden
        >
          <Icon className="size-4 text-foreground-icon-secondary" />
        </span>
        {dragHandleProps && (
          <span
            className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            aria-hidden
          >
            <Menu className="size-4 text-foreground-icon-secondary group-hover:text-foreground-icon-primary" />
          </span>
        )}
      </button>
      {/* Row body toggles as its own button, keeping the folder/drag handle
          and hover actions as sibling controls instead of nested ones. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center text-left"
      >
        <span
          title={repo.originalLabel}
          className="truncate text-body-2-medium whitespace-nowrap text-text-secondary"
        >
          {repo.label}
        </span>
        {repo.labelSuffix && (
          <span className="ws-label-badge ml-1.5 shrink-0">
            {repo.labelSuffix}
          </span>
        )}
      </button>
      {hasHoverActions && (
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 group-hover:inline-flex">
          {repo.id && onNewSession && (
            <button
              type="button"
              aria-label={t("chat.newSession")}
              title={t("chat.newSession")}
              onClick={(event) => {
                event.stopPropagation();
                onNewSession(repo.id!);
              }}
              className="cursor-pointer text-foreground-icon-secondary hover:text-foreground-icon-primary"
            >
              <Plus className="size-4" aria-hidden />
            </button>
          )}
          {repo.id && onRemove && (
            <button
              type="button"
              aria-label={t("chat.removeWorkspace")}
              title={t("chat.removeWorkspace")}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(repo.id!);
              }}
              className="cursor-pointer text-foreground-icon-secondary hover:text-foreground-icon-primary"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </span>
      )}
      <span
        className={cx(
          "text-caption-2-medium text-text-tertiary",
          hasHoverActions ? "group-hover:hidden" : "ml-auto",
        )}
      >
        {repo.threads.length}
      </span>
    </div>
  );
}

/** Keep the list mounted through the close animation, then drop it so the
 *  next expand remounts at page 0. Instant unmount + opacity fade left a
 *  compositor ghost over the workspace rows below. */
const THREAD_LIST_COLLAPSE_MS = 300;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The collapsible thread area under a repo row: the wrapper owns the
 *  grid-rows collapse animation. Content stays mounted while the height
 *  clips shut (no opacity fade — fading the last paint leaves a ghost). */
function RepoThreadList({
  expanded,
  threads,
  threadLimit,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
}: {
  expanded: boolean;
  threads: AiChatThread[];
  threadLimit?: number;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
}) {
  const [mounted, setMounted] = useState(expanded);
  useLayoutEffect(() => {
    if (expanded) {
      setMounted(true);
      return;
    }
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => setMounted(false), THREAD_LIST_COLLAPSE_MS);
    return () => window.clearTimeout(timeout);
  }, [expanded]);

  return (
    <div
      aria-hidden={!expanded}
      {...(!expanded ? { inert: "" } : {})}
      className={cx(
        "grid transition-[grid-template-rows] duration-300 ease-in-out motion-reduce:transition-none",
        expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {mounted ? (
          <PagedThreadList
            expanded={expanded}
            threads={threads}
            threadLimit={threadLimit}
            activeThreadId={activeThreadId}
            onThreadSelect={onThreadSelect}
            onThreadAction={onThreadAction}
            onThreadContextMenu={onThreadContextMenu}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Paged thread rows with the tree connector and the show-more/fewer
 *  pagination buttons. Stays mounted through the close animation; page
 *  resets on collapse so a remount or a quick re-expand both start at 0. */
function PagedThreadList({
  expanded,
  threads,
  threadLimit,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
}: {
  expanded: boolean;
  threads: AiChatThread[];
  threadLimit?: number;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
}) {
  const { t } = useTranslation();
  // Pagination: 0 = 初始 limit 条, 1 = +50 条, 2 = 全部。
  const [page, setPage] = useState(0);
  // Reset immediately on collapse so a quick re-expand (before unmount)
  // still restarts as a short recent list.
  useEffect(() => {
    if (!expanded) setPage(0);
  }, [expanded]);
  const { visibleThreads, hiddenCount } = paginateThreads(threads, threadLimit, page);
  const pageButtonClasses =
    "flex w-full cursor-pointer items-center rounded-2lg py-[5px] pr-2 pl-4 text-caption-1-medium text-text-tertiary transition-colors duration-150 ease hover:bg-background-secondary-hover hover:text-text-secondary";
  return (
    <div className="relative flex w-full flex-col gap-0.5 pt-0.5">
      <TreeConnector count={visibleThreads.length} />
      {visibleThreads.map((thread) => (
        <ThreadItem
          key={thread.id ?? thread.label}
          {...thread}
          isSelected={thread.id ? thread.id === activeThreadId : thread.isSelected}
          onSelect={onThreadSelect}
          onAction={onThreadAction}
          onContextMenu={onThreadContextMenu}
        />
      ))}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setPage((value) => value + 1)}
          className={pageButtonClasses}
        >
          <span className="truncate">{t("chat.showMoreSessions")}</span>
        </button>
      ) : null}
      {page > 0 ? (
        <button
          type="button"
          onClick={() => setPage(0)}
          className={pageButtonClasses}
        >
          {t("chat.showFewerSessions")}
        </button>
      ) : null}
    </div>
  );
}

/** Expandable repo folder: clicking the row (or the folder icon) toggles the
 *  thread list; row hover reveals per-row actions — new session, drag
 *  handle (press to reorder, no long-press), remove. */
export function RepoItem({
  repo,
  open,
  onToggleOpen,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onThreadContextMenu,
  onRemove,
  onNewSession,
  onContextMenu,
  isDragging = false,
  dragHandleProps = null,
}: {
  repo: AiChatRepo;
  /** Expanded state, owned by the sidebar so it can persist across restarts. */
  open: boolean;
  onToggleOpen?: () => void;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  /** Right-click on a thread row: opens the thread context menu. */
  onThreadContextMenu?: (event: ReactMouseEvent<HTMLElement>, id: string) => void;
  onRemove?: (id: string) => void;
  /** Per-row + button: start a new chat in this workspace. */
  onNewSession?: (id: string) => void;
  /** Right-click on the repo header row: opens the workspace menu. */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Drag-handle reorder in progress for this row. */
  isDragging?: boolean;
  /** Immediate drag entry attached to the row's grip handle. */
  dragHandleProps?: DragHandleProps | null;
}) {
  const dragDownPos = useRef<{ x: number; y: number } | null>(null);
  const expanded = open;
  const toggleOpen = useCallback(() => onToggleOpen?.(), [onToggleOpen]);
  const hasHoverActions = Boolean(
    (repo.id && onNewSession) || dragHandleProps || (repo.id && onRemove),
  );


  return (
    <div className="flex w-full flex-col">
      <RepoHeaderRow
        repo={repo}
        expanded={expanded}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
        hasHoverActions={hasHoverActions}
        dragDownPos={dragDownPos}
        onToggleOpen={toggleOpen}
        onNewSession={onNewSession}
        onRemove={onRemove}
        onContextMenu={onContextMenu}
      />
      <RepoThreadList
        expanded={expanded}
        threads={repo.threads}
        threadLimit={repo.threadLimit}
        activeThreadId={activeThreadId}
        onThreadSelect={onThreadSelect}
        onThreadAction={onThreadAction}
        onThreadContextMenu={onThreadContextMenu}
      />
    </div>
  );
}
