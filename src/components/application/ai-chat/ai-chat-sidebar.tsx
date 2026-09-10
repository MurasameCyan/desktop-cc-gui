"use client";

import type { ComponentType, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, Ref, RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Menu from "lucide-react/dist/esm/icons/menu";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Pin from "lucide-react/dist/esm/icons/pin";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import Plus from "lucide-react/dist/esm/icons/plus";
import ScanSearch from "lucide-react/dist/esm/icons/scan-search";
import Settings from "lucide-react/dist/esm/icons/settings";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CloseButton } from "@/components/base/buttons/close-button";
import { WorkspaceSortableList } from "@/components/application/ai-chat/workspace-sortable-list";
import {
  WorkspaceContextMenu,
} from "@/components/application/ai-chat/workspace-context-menu";
import {
  ARCHIVED_SECTION_ID,
  useCollapsedGroups,
  useExpandedWorkspaces,
  useFilteredWorkspaces,
  useSidebarSearch,
  useWorkspaceMenu,
} from "@/components/application/ai-chat/use-sidebar-state";
import { cx } from "@/utils/cx";

/**
 * Board UI → "ai_chat" → Sidebar (node 4030:5910, 260×876), adapted to live
 * data: the repositories tree is fed workspaces → sessions, quick actions
 * drive the chat store, and the footer navigates to the app routes. Visual
 * recipe is unchanged from the template.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** Shared look for the icon buttons in the window drag strip. */
const headerButtonClasses = cx(
  "flex size-7 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150",
  "text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
);

export type ThreadAction = "pin" | "rename" | "delete";

export interface AiChatThread {
  id?: string;
  label: string;
  /** CLI engine id — brand mark rendered left of the label. */
  engine?: string;
  /** Relative-time chip (e.g. "34m"). */
  time: string;
  isSelected?: boolean;
  pinned?: boolean;
  /** A turn is streaming in this session — breathing blue dot. */
  streaming?: boolean;
  /** Finished activity the user has not opened yet — solid green dot. */
  unseen?: boolean;
}

export interface AiChatRepo {
  id?: string;
  label: string;
  /** Original workspace folder name when `label` is a user-set alias
   *  (surfaced as the row tooltip). */
  originalLabel?: string;
  /** Recent chats listed when the repo is expanded. */
  threads: AiChatThread[];
  /** Max threads listed before collapsing behind a "show more" row. */
  threadLimit?: number;
  /** Expanded on first render (folder-open icon + visible threads). */
  defaultOpen?: boolean;
}
/** A workspace group section (工作区二级分类): named groups render with a
 *  collapsible header; the single `id: null` section is ungrouped repos
 *  rendered flat, exactly as before groups existed. */
export interface AiChatRepoSection {
  id: string | null;
  name: string;
  repos: AiChatRepo[];
}

/** Top-level nav row — icon + label, p 8, radius/2lg. */
function NavItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease",
        "hover:bg-background-secondary-hover",
      )}
    >
      <Icon className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="text-body-2-medium whitespace-nowrap text-text-secondary">{label}</span>
    </button>
  );
}

/** Chat row under an open repo — indented 36px, relative-time chip on the
 *  right, hover action icons (pin / rename / delete). */
function ThreadItem({
  id,
  label,
  engine,
  time,
  pinned = false,
  isSelected = false,
  streaming = false,
  unseen = false,
  tabIndex,
  onSelect,
  onAction,
}: AiChatThread & {
  tabIndex?: number;
  onSelect?: (id: string) => void;
  onAction?: (id: string, action: ThreadAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
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
        <span className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
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
      <span className="inline-flex shrink-0 items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-caption-2-medium whitespace-nowrap text-text-secondary group-hover:hidden">
        {time}
      </span>
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

/** Threads revealed by the first "还有 N 个对话" click. */
const PAGE_SIZE = 50;

/** Immediate drag entry attached to a repo row's grip handle. */
interface DragHandleProps {
  onPointerDown: (event: ReactPointerEvent) => void;
}

/**
 * Thread pagination for one repo: page 0 caps at `threadLimit`, page 1 adds
 * PAGE_SIZE, page 2 shows all — but the selected thread is never hidden.
 */
function paginateThreads(
  threads: AiChatThread[],
  threadLimit: number | undefined,
  page: number,
  activeThreadId?: string,
): { visibleThreads: AiChatThread[]; hiddenCount: number } {
  const limit = threadLimit ?? threads.length;
  const activeIndex = activeThreadId
    ? threads.findIndex((thread) => thread.id === activeThreadId)
    : -1;
  const visibleCount =
    page >= 2 ? threads.length : Math.max(limit + page * PAGE_SIZE, activeIndex + 1);
  const visibleThreads =
    threads.length <= visibleCount ? threads : threads.slice(0, visibleCount);
  return { visibleThreads, hiddenCount: threads.length - visibleThreads.length };
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

/** The collapsible thread area under a repo row: tree connector, paged
 *  thread rows, and the show-more/fewer pagination buttons. */
function RepoThreadList({
  expanded,
  visibleThreads,
  hiddenCount,
  page,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onShowMore,
  onShowFewer,
}: {
  expanded: boolean;
  visibleThreads: AiChatThread[];
  hiddenCount: number;
  page: number;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onShowMore: () => void;
  onShowFewer: () => void;
}) {
  const { t } = useTranslation();
  const pageButtonClasses =
    "flex w-full cursor-pointer items-center rounded-2lg py-[5px] pr-2 pl-4 text-caption-1-medium text-text-tertiary transition-colors duration-150 ease hover:bg-background-secondary-hover hover:text-text-secondary";
  return (
    <div
      aria-hidden={!expanded}
      className={cx(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
        expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="overflow-hidden">
        <div className="relative flex w-full flex-col gap-0.5 pt-0.5">
          <TreeConnector count={visibleThreads.length} />
          {visibleThreads.map((thread) => (
            <ThreadItem
              key={thread.id ?? thread.label}
              {...thread}
              isSelected={thread.id ? thread.id === activeThreadId : thread.isSelected}
              onSelect={onThreadSelect}
              onAction={onThreadAction}
              tabIndex={expanded ? undefined : -1}
            />
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              tabIndex={expanded ? undefined : -1}
              onClick={onShowMore}
              className={pageButtonClasses}
            >
              <span className="truncate">{t("chat.showMoreSessions")}</span>
            </button>
          ) : null}
          {page > 0 ? (
            <button
              type="button"
              tabIndex={expanded ? undefined : -1}
              onClick={onShowFewer}
              className={pageButtonClasses}
            >
              {t("chat.showFewerSessions")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Expandable repo folder: clicking the row (or the folder icon) toggles the
 *  thread list; row hover reveals per-row actions — new session, drag
 *  handle (press to reorder, no long-press), remove. */
function RepoItem({
  repo,
  open,
  onToggleOpen,
  forceOpen = false,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
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
  /** Query-driven filtering pins the thread list open while searching. */
  forceOpen?: boolean;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
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
  // Pagination: 0 = 初始 limit 条, 1 = +50 条, 2 = 全部。
  const [page, setPage] = useState(0);
  const expanded = open || forceOpen;
  const toggleOpen = useCallback(() => onToggleOpen?.(), [onToggleOpen]);
  const hasHoverActions = Boolean(
    (repo.id && onNewSession) || dragHandleProps || (repo.id && onRemove),
  );

  const { visibleThreads, hiddenCount } = paginateThreads(
    repo.threads,
    repo.threadLimit,
    page,
    activeThreadId,
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
        visibleThreads={visibleThreads}
        hiddenCount={hiddenCount}
        page={page}
        activeThreadId={activeThreadId}
        onThreadSelect={onThreadSelect}
        onThreadAction={onThreadAction}
        onShowMore={() => setPage((value) => value + 1)}
        onShowFewer={() => setPage(0)}
      />
    </div>
  );
}

/** The active quick-search row: filter field replacing the "Search" nav
 *  item, ⌘L-focusable, Escape exits. */
function SearchField({
  query,
  onQueryChange,
  onDeactivate,
  inputRef,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onDeactivate: () => void;
  inputRef: RefObject<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full items-center gap-2 rounded-2lg bg-background-tertiary-default p-2 ring-2 ring-inset ring-border-focus-ring">
      <ScanSearch className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        aria-label={t("chat.searchSessions")}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDeactivate();
          }
        }}
        placeholder={t("chat.searchSessions")}
        className="min-w-0 flex-1 bg-transparent text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary"
      />
      <CloseButton
        size="xs"
        aria-label={t("common.close")}
        onClick={onDeactivate}
      />
    </div>
  );
}

/** Workspace group header (› name): click toggles the group's
 *  repo list; collapsed state is owned (and persisted) by the sidebar. */
function GroupHeaderRow({
  name,
  collapsed,
  onToggle,
}: {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-1 rounded-2lg px-1 py-[5px] transition-colors duration-150 ease hover:bg-background-secondary-hover"
    >
      <ChevronRight
        className={cx(
          "size-3.5 shrink-0 text-foreground-icon-secondary transition-transform duration-150",
          !collapsed && "rotate-90",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-left text-caption-1-medium text-text-tertiary">
        {name}
      </span>
    </button>
  );
}

/** A grayed, non-expandable archived workspace row: right-click is the only
 *  interaction (unarchive / set alias via the shared workspace menu). */
function ArchivedRepoRow({
  repo,
  onContextMenu,
}: {
  repo: AiChatRepo;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      onContextMenu={onContextMenu}
      className="flex w-full cursor-default items-center gap-2 rounded-2lg p-2 transition-colors duration-150 ease hover:bg-background-secondary-hover"
    >
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
        <FolderSymlink className="size-4 text-foreground-icon-tertiary" />
      </span>
      <span
        title={repo.originalLabel}
        className="min-w-0 flex-1 truncate text-body-2-medium whitespace-nowrap text-text-tertiary"
      >
        {repo.label}
      </span>
    </div>
  );
}

/** 已归档 section at the bottom of the workspace tree: collapsible like a
 *  group header (same persisted collapse set), rows are plain grayed labels. */
function ArchivedSection({
  repos,
  searching,
  collapsed,
  onToggle,
  onRepoContextMenu,
}: {
  repos: AiChatRepo[];
  searching: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onRepoContextMenu?: (event: ReactMouseEvent<HTMLElement>, workspaceId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col">
      <GroupHeaderRow
        name={t("chat.archivedWorkspaces", { count: repos.length })}
        collapsed={!searching && collapsed}
        onToggle={onToggle}
      />
      {(searching || !collapsed) && (
        <div className="flex w-full flex-col gap-1">
          {repos.map((repo) => (
            <ArchivedRepoRow
              key={repo.id ?? repo.label}
              repo={repo}
              onContextMenu={
                onRepoContextMenu && repo.id
                  ? (event) => onRepoContextMenu(event, repo.id!)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Workspaces section: header with the add button + the sortable repo tree.
 *  With workspace groups configured, repos render under collapsible group
 *  headers (工作区二级分类); otherwise the flat list renders unchanged. */
function WorkspaceSection({
  filteredRepos,
  sections,
  searching,
  collapsedGroups,
  isRepoExpanded,
  onToggleRepo,
  activeThreadId,
  onThreadSelect,
  onThreadAction,
  onAddWorkspace,
  onRemoveWorkspace,
  onNewSessionInWorkspace,
  onReorderWorkspaces,
  onToggleGroup,
  onRepoContextMenu,
}: {
  filteredRepos: AiChatRepo[];
  /** Grouped repo tree; absent/empty = legacy flat list. */
  sections?: AiChatRepoSection[];
  searching: boolean;
  collapsedGroups: Set<string>;
  /** Sidebar-owned so expansion survives restarts. */
  isRepoExpanded: (repo: AiChatRepo) => boolean;
  onToggleRepo: (repo: AiChatRepo) => void;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onAddWorkspace?: () => void;
  onRemoveWorkspace?: (id: string) => void;
  onNewSessionInWorkspace?: (id: string) => void;
  onReorderWorkspaces?: (orderedIds: string[]) => void;
  onToggleGroup?: (groupId: string) => void;
  /** Right-click on a repo header row (workspace context menu). */
  onRepoContextMenu?: (event: ReactMouseEvent<HTMLElement>, workspaceId: string) => void;
}) {
  const { t } = useTranslation();
  const hasGroups = Boolean(sections?.some((section) => section.id !== null));

  const renderRepoList = (repos: AiChatRepo[], sectionId: string | null) =>
    repos.length > 0 && (
      <WorkspaceSortableList
        items={repos}
        disabled={searching}
        onReorder={
          onReorderWorkspaces
            ? (orderedIds) => {
                // Rebuild the global order: other sections keep theirs, the
                // dragged section takes the new one.
                const all = (sections ?? [{ id: null, name: "", repos: filteredRepos }]).flatMap(
                  (section) =>
                    section.id === sectionId
                      ? orderedIds
                      : section.repos.map((repo) => repo.id),
                );
                onReorderWorkspaces(all.filter((id): id is string => Boolean(id)));
              }
            : undefined
        }
        className="flex w-full flex-col gap-1"
        renderItem={(repo, drag) => (
          <RepoItem
            repo={repo}
            open={isRepoExpanded(repo)}
            onToggleOpen={() => onToggleRepo(repo)}
            forceOpen={searching}
            activeThreadId={activeThreadId}
            onThreadSelect={onThreadSelect}
            onThreadAction={onThreadAction}
            onRemove={onRemoveWorkspace}
            onNewSession={onNewSessionInWorkspace}
            onContextMenu={
              onRepoContextMenu && repo.id
                ? (event) => onRepoContextMenu(event, repo.id!)
                : undefined
            }
            isDragging={drag?.isDragging ?? false}
            dragHandleProps={drag?.dragHandleProps ?? null}
          />
        )}
      />
    );

  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="flex w-full items-center justify-between">
        <span className="text-body-2-medium text-text-secondary">
          {t("chat.workspaces")}
        </span>
        <button
          type="button"
          aria-label={t("chat.addWorkspace")}
          title={t("chat.addWorkspace")}
          onClick={onAddWorkspace}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full text-foreground-icon-secondary transition-colors duration-150 hover:bg-background-tertiary-hover/55 hover:text-foreground-icon-primary"
        >
          <FolderPlus className="size-4" aria-hidden />
        </button>
      </div>
      {!hasGroups && renderRepoList(filteredRepos, null)}
      {hasGroups &&
        sections!.map((section) =>
          section.id === null ? (
            <div key="ungrouped" className="flex w-full flex-col">
              {renderRepoList(section.repos, null)}
            </div>
          ) : (
            <div key={section.id} className="flex w-full flex-col">
              <GroupHeaderRow
                name={section.name}
                collapsed={!searching && collapsedGroups.has(section.id)}
                onToggle={() => onToggleGroup?.(section.id!)}
              />
              {(searching || !collapsedGroups.has(section.id)) &&
                renderRepoList(section.repos, section.id)}
            </div>
          ),
        )}
    </div>
  );
}

export function AiChatSidebar({
  repos = [],
  sections,
  archivedRepos = [],
  className,
  width = 260,
  rootRef,
  activeThreadId,
  onThreadSelect,
  onNewSessionInWorkspace,
  onNewSession,
  onReorderWorkspaces,
  onThreadAction,
  onAddWorkspace,
  onRemoveWorkspace,
  onWorkspaceAlias,
  onSetWorkspaceArchived,
  onOpenSettings,
  onClose,
  flat = false,
}: {
  repos?: AiChatRepo[];
  /** Grouped repo tree (工作区二级分类); omitted = flat `repos` list. */
  sections?: AiChatRepoSection[];
  /** Archived workspaces for the bottom 已归档 section (labels only). */
  archivedRepos?: AiChatRepo[];
  className?: string;
  /** Sidebar width in px; the parent owns resizing. */
  width?: number;
  /** Ref to the root <aside> so the parent can mutate width mid-drag. */
  rootRef?: Ref<HTMLElement>;
  activeThreadId?: string;
  onThreadSelect?: (id: string) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onAddWorkspace?: () => void;
  onRemoveWorkspace?: (id: string) => void;
  /** Workspace context-menu action: open the set-alias dialog for the row. */
  onWorkspaceAlias?: (id: string) => void;
  /** Workspace context-menu action: move the row into / out of 已归档. */
  onSetWorkspaceArchived?: (id: string, archived: boolean) => void;
  /** Per-row + button: start a new chat in that workspace. */
  onNewSessionInWorkspace?: (id: string) => void;
  /** Commit of a drag-handle reorder (ordered workspace ids). */
  onReorderWorkspaces?: (orderedIds: string[]) => void;
  /** 新建会话 nav entry: start a new chat in the current workspace. */
  onNewSession?: () => void;
  onOpenSettings?: () => void;
  onClose?: () => void;
  flat?: boolean;
} = {}) {
  const { t } = useTranslation();
  const {
    searchActive,
    query,
    setQuery,
    normalizedQuery,
    searchInputRef,
    activateSearch,
    deactivateSearch,
  } = useSidebarSearch();
  const { collapsedGroups, toggleGroup } = useCollapsedGroups();
  const allRepos = useMemo(
    () => (sections ? sections.flatMap((section) => section.repos) : repos),
    [sections, repos],
  );
  const { isRepoExpanded, toggleRepoExpanded } = useExpandedWorkspaces(allRepos);
  const { workspaceMenu, closeWorkspaceMenu, openWorkspaceMenu, openArchivedMenu } =
    useWorkspaceMenu(onWorkspaceAlias, onSetWorkspaceArchived);
  const { filteredRepos, filteredSections, filteredArchivedRepos } = useFilteredWorkspaces(
    repos,
    sections,
    archivedRepos,
    normalizedQuery,
  );

  return (
    <aside
      ref={rootRef}
      style={{ width }}
      className={cx(
        "flex h-full shrink-0 flex-col overflow-hidden select-none",
        flat
          ? "bg-background-full"
          : "bg-background-secondary-default",
        className,
      )}
    >
      {/* Window drag strip reaching the overlay titlebar: macOS traffic
          lights float over its left edge, action icons pin right. */}
      {!flat && (
        <div
          data-tauri-drag-region
          className="flex h-10 w-full shrink-0 items-center justify-end gap-1 border-b border-separator-border px-3"
        >
          <button
            type="button"
            aria-label={t("chat.collapseSidebar")}
            title={t("chat.collapseSidebar")}
            onClick={onClose}
            className={headerButtonClasses}
          >
            <PanelLeft className="size-4 -scale-x-100" aria-hidden />
          </button>
        </div>
      )}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3 p-3">
        {/* App identity (flat/embedded variant only) */}
        {flat && (
          <div className="flex w-full flex-row items-center justify-between">
            <span className="flex items-center gap-2 px-1">
              <img src="/app-icon.png" alt="CC GUI" className="size-7 rounded-lg" />
              <span className="text-headline-medium text-text-primary">CC GUI</span>
            </span>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto scrollbar-none">
          {/* Primary actions */}
          <nav className="flex w-full shrink-0 flex-col gap-1">
            {searchActive ? (
              <SearchField
                query={query}
                onQueryChange={setQuery}
                onDeactivate={deactivateSearch}
                inputRef={searchInputRef}
              />
            ) : (
              <NavItem icon={ScanSearch} label={t("common.search")} onClick={activateSearch} />
            )}
            <NavItem icon={MessageSquarePlus} label={t("chat.newSession")} onClick={onNewSession} />
          </nav>

          <WorkspaceSection
            filteredRepos={filteredRepos}
            sections={filteredSections}
            searching={Boolean(normalizedQuery)}
            collapsedGroups={collapsedGroups}
            isRepoExpanded={isRepoExpanded}
            onToggleRepo={toggleRepoExpanded}
            activeThreadId={activeThreadId}
            onThreadSelect={onThreadSelect}
            onThreadAction={onThreadAction}
            onAddWorkspace={onAddWorkspace}
            onRemoveWorkspace={onRemoveWorkspace}
            onNewSessionInWorkspace={onNewSessionInWorkspace}
            onReorderWorkspaces={onReorderWorkspaces}
            onToggleGroup={toggleGroup}
            onRepoContextMenu={openWorkspaceMenu}
          />
          {filteredArchivedRepos.length > 0 && (
            <ArchivedSection
              repos={filteredArchivedRepos}
              searching={Boolean(normalizedQuery)}
              collapsed={collapsedGroups.has(ARCHIVED_SECTION_ID)}
              onToggle={() => toggleGroup(ARCHIVED_SECTION_ID)}
              onRepoContextMenu={openArchivedMenu}
            />
          )}
          {filteredRepos.length === 0 && (
            <p className="px-2 text-body-regular text-text-tertiary">{t("chat.noSessions")}</p>
          )}
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col gap-3 px-3 pb-3">
        {/* Secondary nav */}
        <nav className="flex w-full flex-col gap-1">
          <NavItem icon={Settings} label={t("settings.title")} onClick={onOpenSettings} />
        </nav>
      </div>

      {workspaceMenu && (onWorkspaceAlias || onSetWorkspaceArchived) && (
        <WorkspaceContextMenu
          menu={workspaceMenu}
          onClose={closeWorkspaceMenu}
          onSetAlias={onWorkspaceAlias}
          onSetArchived={onSetWorkspaceArchived}
        />
      )}
    </aside>
  );
}
