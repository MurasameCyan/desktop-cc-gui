import { useTranslation } from "react-i18next";
import Copy from "lucide-react/dist/esm/icons/copy";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { sessionMenuRegistry, useRegistry } from "@ccgui/plugin-sdk";
import { ContextMenu, type ContextMenuEntry } from "@/components/context-menu";
import type { ThreadAction } from "@/components/application/ai-chat/sidebar-types";

export interface ThreadMenuState {
  x: number;
  y: number;
  threadId: string;
}

/**
 * Right-click menu for sidebar session rows. Chrome (portal anchoring,
 * viewport clamping, Escape/outside dismissal) comes from the shared
 * ContextMenu; this component only owns the session action entries.
 * Rename/delete reuse the hover-icon funnel (the page's prompt/confirm
 * dialogs); copy writes the session id to the clipboard.
 */
export function ThreadContextMenu({
  menu,
  onClose,
  onThreadAction,
  onCopyId,
}: {
  menu: ThreadMenuState;
  onClose: () => void;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onCopyId?: (id: string) => void;
}) {
  const { t } = useTranslation();
  // 插件追加行（ctx.ui.registerSessionMenuItem）：label 是 thunk，
  // 语言切换即时重命名；run 收到菜单所在的会话。
  const pluginDefs = useRegistry(sessionMenuRegistry);

  const entries: (ContextMenuEntry | "separator")[] = [];
  if (onThreadAction) {
    entries.push({
      id: "rename",
      label: t("chat.renameSession"),
      icon: <Pencil className="size-4" aria-hidden />,
      onSelect: () => onThreadAction(menu.threadId, "rename"),
    });
  }
  if (onCopyId) {
    entries.push({
      id: "copy-id",
      label: t("chat.copySessionId"),
      icon: <Copy className="size-4" aria-hidden />,
      onSelect: () => onCopyId(menu.threadId),
    });
  }
  if (onThreadAction) {
    if (entries.length > 0) entries.push("separator");
    entries.push({
      id: "delete",
      label: t("chat.deleteSession"),
      icon: <Trash2 className="size-4" aria-hidden />,
      danger: true,
      onSelect: () => onThreadAction(menu.threadId, "delete"),
    });
  }
  if (pluginDefs.length > 0) {
    // threadId 约定为 "<engine>/<sessionId>"（侧栏行 id），引擎段不含 "/"。
    const slash = menu.threadId.indexOf("/");
    const target =
      slash > 0
        ? { engine: menu.threadId.slice(0, slash), sessionId: menu.threadId.slice(slash + 1) }
        : null;
    if (target) {
      if (entries.length > 0) entries.push("separator");
      for (const def of pluginDefs) {
        const Icon = def.icon;
        entries.push({
          id: def.id,
          label: def.label(),
          icon: Icon ? <Icon className="size-4" aria-hidden /> : null,
          danger: def.danger,
          onSelect: () => def.run(target),
        });
      }
    }
  }

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={menu.threadId}
      entries={entries}
      onClose={onClose}
    />
  );
}
