"use client";

import type { ComponentType, RefObject } from "react";
import { useTranslation } from "react-i18next";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import ScanSearch from "lucide-react/dist/esm/icons/scan-search";
import Settings from "lucide-react/dist/esm/icons/settings";
import { CloseButton } from "@/components/base/buttons/close-button";
import {
  WorkspaceContextMenu,
  type WorkspaceMenuState,
} from "@/components/application/ai-chat/workspace-context-menu";
import {
  ThreadContextMenu,
  type ThreadMenuState,
} from "@/components/application/ai-chat/thread-context-menu";
import type { ThreadAction } from "@/components/application/ai-chat/sidebar-types";
import { cx } from "@/utils/cx";
import { needsWindowControls, useTitlebarStyle } from "@/features/settings/titlebar";
import { WindowControls } from "@/components/application/window-controls";
import { useRemoteControl } from "@/hooks/use-remote-control";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** Shared look for the icon buttons in the window drag strip. */
const headerButtonClasses = cx(
  "flex size-7 cursor-pointer items-center justify-center rounded-lg transition-colors duration-150",
  "text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary",
);

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

/** Window drag strip reaching the overlay titlebar: macOS traffic lights
 *  float over its left edge, action icons pin right. Windows 仿 mac 模式在
 *  这里放自绘三色按钮。 */
export function SidebarDragStrip({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const titlebarStyle = useTitlebarStyle();
  return (
    <div
      data-tauri-drag-region
      className="flex h-10 w-full shrink-0 items-center justify-between gap-1 border-b border-separator-border px-3"
    >
      <div className="flex min-w-0 items-center">
        {needsWindowControls(titlebarStyle) && <WindowControls />}
      </div>
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
  );
}

/** App identity row (flat/embedded variant only). */
export function SidebarBrandRow() {
  return (
    <div className="flex w-full flex-row items-center justify-between">
      <span className="flex items-center gap-2 px-1">
        <img src="/app-icon.png" alt="CC GUI" className="size-7 rounded-lg" />
        <span className="text-headline-medium text-text-primary">CC GUI</span>
      </span>
    </div>
  );
}

/** Primary actions: quick-search (field swap when active) + 新建会话. */
export function SidebarPrimaryNav({
  searchActive,
  query,
  onQueryChange,
  onDeactivateSearch,
  onActivateSearch,
  searchInputRef,
  onNewSession,
}: {
  searchActive: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onDeactivateSearch: () => void;
  onActivateSearch: () => void;
  searchInputRef: RefObject<HTMLInputElement>;
  onNewSession?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <nav className="flex w-full shrink-0 flex-col gap-1">
      {searchActive ? (
        <SearchField
          query={query}
          onQueryChange={onQueryChange}
          onDeactivate={onDeactivateSearch}
          inputRef={searchInputRef}
        />
      ) : (
        <NavItem icon={ScanSearch} label={t("common.search")} onClick={onActivateSearch} />
      )}
      <NavItem icon={MessageSquarePlus} label={t("chat.newSession")} onClick={onNewSession} />
    </nav>
  );
}

/** Secondary nav (设置) with the floating web-remote badge. The badge is
 *  floating, not laid out: it covers the empty half of the row (设置 keeps
 *  its full width and hover) and lets clicks through. */
export function SidebarFooter({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { t } = useTranslation();
  const remoteActive = useRemoteControl();
  return (
    <div className="flex w-full shrink-0 flex-col gap-3 px-3 pb-3">
      <div className="relative flex w-full items-center">
        <nav className="flex w-full flex-col gap-1">
          <NavItem icon={Settings} label={t("settings.title")} onClick={onOpenSettings} />
        </nav>
        {remoteActive && (
          <div
            title={t("settings.webRemoteActive")}
            className="pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-full bg-button-primary px-2.5 py-1 shadow-xs"
          >
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-text-white" />
            <span className="text-body-2-medium whitespace-nowrap text-text-white">
              {t("settings.webRemoteActive")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Workspace + thread right-click menus; each mounts only while its state
 *  is open and at least one entry has a handler. */
export function SidebarContextMenus({
  workspaceMenu,
  threadMenu,
  onCloseWorkspaceMenu,
  onCloseThreadMenu,
  onWorkspaceAlias,
  onSetWorkspaceArchived,
  onThreadAction,
  onCopyThreadId,
}: {
  workspaceMenu: WorkspaceMenuState | null;
  threadMenu: ThreadMenuState | null;
  onCloseWorkspaceMenu: () => void;
  onCloseThreadMenu: () => void;
  onWorkspaceAlias?: (id: string) => void;
  onSetWorkspaceArchived?: (id: string, archived: boolean) => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onCopyThreadId?: (id: string) => void;
}) {
  return (
    <>
      {workspaceMenu && (onWorkspaceAlias || onSetWorkspaceArchived) && (
        <WorkspaceContextMenu
          menu={workspaceMenu}
          onClose={onCloseWorkspaceMenu}
          onSetAlias={onWorkspaceAlias}
          onSetArchived={onSetWorkspaceArchived}
        />
      )}
      {threadMenu && (onThreadAction || onCopyThreadId) && (
        <ThreadContextMenu
          menu={threadMenu}
          onClose={onCloseThreadMenu}
          onThreadAction={onThreadAction}
          onCopyId={onCopyThreadId}
        />
      )}
    </>
  );
}
