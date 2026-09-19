import { useEffect, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import Archive from "lucide-react/dist/esm/icons/archive";
import ArchiveRestore from "lucide-react/dist/esm/icons/archive-restore";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Puzzle from "lucide-react/dist/esm/icons/puzzle";
import { compareByOrder, pluginIdFromRegistryKey, useRegistry, workspaceMenuRegistry } from "@ccgui/plugin-sdk";
import { ContextMenu, type ContextMenuEntry } from "@/components/context-menu";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";

export interface WorkspaceMenuState {
  x: number;
  y: number;
  workspaceId: string;
  /** Row lives in the 已归档 section: the archive entry flips to 取消归档. */
  archived: boolean;
}

export interface BlankMenuState {
  x: number;
  y: number;
}

/**
 * Right-click menu for sidebar workspace rows. Chrome (portal anchoring,
 * viewport clamping, Escape/outside dismissal) comes from the shared
 * ContextMenu; this component owns the builtin workspace action entries and
 * appends the registered workspace-menu extension entries after them.
 */
export function WorkspaceContextMenu({
  menu,
  onClose,
  onSetAlias,
  onSetArchived,
}: {
  menu: WorkspaceMenuState;
  onClose: () => void;
  onSetAlias?: (workspaceId: string) => void;
  onSetArchived?: (workspaceId: string, archived: boolean) => void;
}) {
  const { t } = useTranslation();
  // Extension entries: label/visible are resolved during this render, so a
  // language flip or an owner's state change re-labels an open menu. The
  // target is the row the user right-clicked, never the active workspace.
  const extensionDefs = useRegistry(workspaceMenuRegistry);
  const target = { workspaceId: menu.workspaceId, archived: menu.archived };

  const builtins: ContextMenuEntry[] = [];
  if (onSetAlias) {
    builtins.push({
      id: "set-alias",
      label: t("chat.setWorkspaceAlias"),
      icon: <Pencil className="size-4" aria-hidden />,
      onSelect: () => onSetAlias(menu.workspaceId),
    });
  }
  if (onSetArchived) {
    builtins.push({
      id: "toggle-archive",
      label: menu.archived ? t("chat.unarchiveWorkspace") : t("chat.archiveWorkspace"),
      icon: menu.archived ? (
        <ArchiveRestore className="size-4" aria-hidden />
      ) : (
        <Archive className="size-4" aria-hidden />
      ),
      onSelect: () => onSetArchived(menu.workspaceId, !menu.archived),
    });
  }

  // Extension callbacks are foreign code. A throwing label/visible must not
  // take the sidebar down with it, so that entry is dropped; a failing
  // onSelect (sync throw or rejected async) is reported and swallowed.
  const extensionEntries: ContextMenuEntry[] = [];
  // compareByOrder: undefined order sorts last, ties break by id.
  for (const def of [...extensionDefs].sort(compareByOrder)) {
    const Icon: ComponentType<{ className?: string }> = def.icon ?? Puzzle;
    try {
      if (def.visible?.(target) === false) continue;
      extensionEntries.push({
        id: def.id,
        label: def.label(target),
        icon: def.icon ? (
          <PluginBoundary pluginId={pluginIdFromRegistryKey(def.id)} fallback={<Puzzle className="size-4" aria-hidden />}>
            <Icon className="size-4" aria-hidden />
          </PluginBoundary>
        ) : <Icon className="size-4" aria-hidden />,
        onSelect: () => {
          try {
            void Promise.resolve(def.onSelect(target)).catch((error: unknown) =>
              console.error(`[plugins] workspace menu ${def.id} onSelect failed`, error),
            );
          } catch (error) {
            console.error(`[plugins] workspace menu ${def.id} onSelect failed`, error);
          }
        },
      });
    } catch (error) {
      console.error(`[plugins] workspace menu ${def.id} failed to resolve`, error);
    }
  }

  const entries: (ContextMenuEntry | "separator")[] =
    builtins.length > 0 && extensionEntries.length > 0
      ? [...builtins, "separator", ...extensionEntries]
      : [...builtins, ...extensionEntries];
  useEffect(() => {
    if (entries.length === 0) onClose();
  }, [entries.length, onClose]);
  if (entries.length === 0) return null;

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={menu.workspaceId}
      entries={entries}
      onClose={onClose}
    />
  );
}
/**
 * Right-click menu for the workspace section's blank area: create a group
 * without a trip to Settings → 工作区. Selecting the entry opens the
 * sidebar's inline name composer (owned by the sidebar component).
 */
export function WorkspaceBlankContextMenu({
  menu,
  onClose,
  onCreateGroup,
}: {
  menu: BlankMenuState;
  onClose: () => void;
  onCreateGroup?: () => void;
}) {
  const { t } = useTranslation();

  const entries: ContextMenuEntry[] = [];
  if (onCreateGroup) {
    entries.push({
      id: "create-group",
      label: t("chat.newGroup"),
      icon: <FolderPlus className="size-4" aria-hidden />,
      onSelect: onCreateGroup,
    });
  }

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={t("chat.workspaces")}
      entries={entries}
      onClose={onClose}
    />
  );
}
