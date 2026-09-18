"use client";

import type { Ref } from "react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ARCHIVED_SECTION_ID,
  useCollapsedGroups,
  useExpandedWorkspaces,
  useFilteredWorkspaces,
  useSidebarSearch,
  useWorkspaceMenu,
  useThreadMenu,
} from "@/components/application/ai-chat/use-sidebar-state";
import { ArchivedSection, WorkspaceSection } from "@/components/application/ai-chat/workspace-sections";
import {
  SidebarBrandRow,
  SidebarContextMenus,
  SidebarDragStrip,
  SidebarFooter,
  SidebarPrimaryNav,
} from "@/components/application/ai-chat/sidebar-chrome";
import type { AiChatRepo, AiChatRepoSection, ThreadAction } from "@/components/application/ai-chat/sidebar-types";
import { cx } from "@/utils/cx";

export type { AiChatRepo, AiChatRepoSection, AiChatThread, ThreadAction } from "@/components/application/ai-chat/sidebar-types";

/**
 * Board UI → "ai_chat" → Sidebar (node 4030:5910, 260×876), adapted to live
 * data: the repositories tree is fed workspaces → sessions, quick actions
 * drive the chat store, and the footer navigates to the app routes. Visual
 * recipe is unchanged from the template. Chrome (drag strip, nav rows,
 * footer, context menus) lives in sidebar-chrome.tsx.
 */

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
  onCopyThreadId,
  onAddWorkspace,
  onRemoveWorkspace,
  onWorkspaceAlias,
  onSetWorkspaceArchived,
  onDropWorkspaceToSection,
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
  /** Thread context-menu action: copy the session id to the clipboard. */
  onCopyThreadId?: (id: string) => void;
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
  /** Workspace row dropped onto a section container: group id, the archived
   *  sentinel (drop on 已归档), or null (ungrouped). */
  onDropWorkspaceToSection?: (workspaceId: string, targetSectionId: string | null) => void;
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
  const { isRepoExpanded, toggleRepoExpanded } = useExpandedWorkspaces(allRepos, activeThreadId);
  const { workspaceMenu, closeWorkspaceMenu, openWorkspaceMenu, openArchivedMenu } =
    useWorkspaceMenu(onWorkspaceAlias, onSetWorkspaceArchived);
  const { threadMenu, openThreadMenu, closeThreadMenu } = useThreadMenu(
    onThreadAction,
    onCopyThreadId,
  );
  const { filteredRepos, filteredSections, filteredArchivedRepos } = useFilteredWorkspaces(
    repos,
    sections,
    archivedRepos,
    normalizedQuery,
  );
  // Mid-drag the sidebar reveals every drop target: empty group headers and
  // the 已归档 section mount even when they have no rows.
  const [workspaceDragging, setWorkspaceDragging] = useState(false);
  const handleDropWorkspaceToSection = useCallback(
    (workspaceId: string, target: string | null) => {
      // Landing in a collapsed group expands it so the moved row is visible.
      if (target && target !== ARCHIVED_SECTION_ID && collapsedGroups.has(target)) {
        toggleGroup(target);
      }
      onDropWorkspaceToSection?.(workspaceId, target);
    },
    [collapsedGroups, toggleGroup, onDropWorkspaceToSection],
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
      {!flat && <SidebarDragStrip onClose={onClose} />}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3 p-3">
        {flat && <SidebarBrandRow />}

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto scrollbar-none">
          <SidebarPrimaryNav
            searchActive={searchActive}
            query={query}
            onQueryChange={setQuery}
            onDeactivateSearch={deactivateSearch}
            onActivateSearch={activateSearch}
            searchInputRef={searchInputRef}
            onNewSession={onNewSession}
          />

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
            onThreadContextMenu={openThreadMenu}
            onAddWorkspace={onAddWorkspace}
            onRemoveWorkspace={onRemoveWorkspace}
            onNewSessionInWorkspace={onNewSessionInWorkspace}
            onReorderWorkspaces={onReorderWorkspaces}
            onToggleGroup={toggleGroup}
            onRepoContextMenu={openWorkspaceMenu}
            workspaceDragging={workspaceDragging}
            onWorkspaceDragActiveChange={setWorkspaceDragging}
            onDropWorkspaceToSection={handleDropWorkspaceToSection}
          />
          {(filteredArchivedRepos.length > 0 || workspaceDragging) && (
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

      <SidebarFooter onOpenSettings={onOpenSettings} />

      <SidebarContextMenus
        workspaceMenu={workspaceMenu}
        threadMenu={threadMenu}
        onCloseWorkspaceMenu={closeWorkspaceMenu}
        onCloseThreadMenu={closeThreadMenu}
        onWorkspaceAlias={onWorkspaceAlias}
        onSetWorkspaceArchived={onSetWorkspaceArchived}
        onThreadAction={onThreadAction}
        onCopyThreadId={onCopyThreadId}
      />
    </aside>
  );
}
