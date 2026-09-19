import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Copy from "lucide-react/dist/esm/icons/copy";
import Archive from "lucide-react/dist/esm/icons/archive";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  sessionMenuRegistry,
  useRegistry,
  type SessionMenuItemDef,
  type SessionMenuTarget,
} from "@ccgui/plugin-sdk";
import { ContextMenu, type ContextMenuEntry } from "@/components/context-menu";
import type { ThreadAction } from "@/components/application/ai-chat/sidebar-types";

export interface ThreadMenuState {
  x: number;
  y: number;
  threadId: string;
}

type MenuEntry = ContextMenuEntry | "separator";

/** Join non-empty entry groups with a separator between each. */
function joinSections(sections: MenuEntry[][]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (entries.length > 0) entries.push("separator");
    entries.push(...section);
  }
  return entries;
}

// threadId 约定为 "<engine>/<sessionId>"（侧栏行 id），引擎段不含 "/"。
function parseThreadTarget(threadId: string): SessionMenuTarget | null {
  const slash = threadId.indexOf("/");
  return slash > 0
    ? { engine: threadId.slice(0, slash), sessionId: threadId.slice(slash + 1) }
    : null;
}

/** Host entries: rename/copy in one group, delete in its own (separated) group. */
function buildHostSections({
  threadId,
  isDraft,
  t,
  onThreadAction,
  onCopyId,
}: {
  threadId: string;
  isDraft: boolean;
  t: TFunction;
  onThreadAction?: (id: string, action: ThreadAction) => void;
  onCopyId?: (id: string) => void;
}): MenuEntry[][] {
  const actions: MenuEntry[] = [];
  if (onThreadAction && !isDraft) {
    actions.push({
      id: "rename",
      label: t("chat.renameSession"),
      icon: <Pencil className="size-4" aria-hidden />,
      onSelect: () => onThreadAction(threadId, "rename"),
    });
  }
  if (onCopyId && !isDraft) {
    actions.push({
      id: "copy-id",
      label: t("chat.copySessionId"),
      icon: <Copy className="size-4" aria-hidden />,
      onSelect: () => onCopyId(threadId),
    });
  }
  if (onThreadAction && !isDraft) {
    actions.push({
      id: "archive",
      label: t("chat.archiveSession"),
      icon: <Archive className="size-4" aria-hidden />,
      onSelect: () => onThreadAction(threadId, "archive"),
    });
  }
  const danger: MenuEntry[] = onThreadAction
    ? [
        {
          id: "delete",
          label: t("chat.deleteSession"),
          icon: <Trash2 className="size-4" aria-hidden />,
          danger: true,
          onSelect: () => onThreadAction(threadId, "delete"),
        },
      ]
    : [];
  return [actions, danger];
}

/** 插件追加行（ctx.ui.registerSessionMenuItem）：label 是 thunk，
 *  语言切换即时重命名；run 收到菜单所在的会话。 */
function buildPluginEntries(
  defs: readonly SessionMenuItemDef[],
  target: SessionMenuTarget | null,
): MenuEntry[] {
  if (!target) return [];
  return defs.map((def) => {
    const Icon = def.icon;
    return {
      id: def.id,
      label: def.label(),
      icon: Icon ? <Icon className="size-4" aria-hidden /> : null,
      danger: def.danger,
      onSelect: () => def.run(target),
    };
  });
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
  const pluginDefs = useRegistry(sessionMenuRegistry);
  const isDraft = menu.threadId.startsWith("new:");

  const hostSections = buildHostSections({
    threadId: menu.threadId,
    isDraft,
    t,
    onThreadAction,
    onCopyId,
  });
  const pluginSection =
    pluginDefs.length > 0 && !isDraft
      ? buildPluginEntries(pluginDefs, parseThreadTarget(menu.threadId))
      : [];
  const entries = joinSections([...hostSections, pluginSection]);

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
