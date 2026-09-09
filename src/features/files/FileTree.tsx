import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { measureElement as defaultMeasureElement, useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import { cx } from "@/utils/cx";
import { ipc, type DirEntry, type FileTreeColor, type RepositorySummary } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { ConfirmDialog, PromptDialog } from "@/components/dialogs";
import { fileName, joinPath, parentPath, useFilesStore } from "./store";
import { getFileTreeIconSvg } from "./fileIcons";
import { FileTreeContextMenu, type FileTreeMenuState } from "./FileTreeContextMenu";
import { useChatStore } from "@/features/chat/store";

export interface VisibleNode extends DirEntry {
  path: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
  repository?: RepositorySummary;
  color?: FileTreeColor;
}

interface TreeRowProps {
  node: VisibleNode;
  selected: boolean;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelectDir: (path: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, node: VisibleNode) => void;
  /** Hover "+": stage an @path mention in the active chat's composer. */
  onMention: (path: string) => void;
  mentionLabel: string;
}

const TreeRow = memo(function TreeRow({
  node,
  selected,
  onToggleDir,
  onOpenFile,
  onSelectDir,
  onContextMenu,
  onMention,
  mentionLabel,
}: TreeRowProps) {
  const handleClick = useCallback(() => {
    if (node.isDir) {
      onSelectDir(node.path);
      onToggleDir(node.path);
    } else {
      onOpenFile(node.path);
    }
  }, [node.isDir, node.path, onToggleDir, onOpenFile, onSelectDir]);

  // Icon SVGs are static string constants; selection is a map/set lookup.
  const iconSvg = useMemo(
    () => getFileTreeIconSvg(node.name, node.isDir, node.expanded),
    [node.name, node.isDir, node.expanded],
  );

  // Same inline form as the changes panel: `branch ✓` when clean, else
  // `branch M<n> ?<n>` (tracked changes first, then untracked).
  const repositoryLabel = node.repository
    ? node.repository.changed + node.repository.untracked === 0
      ? `${node.repository.branch} ✓`
      : `${node.repository.branch}${node.repository.changed > 0 ? ` M${node.repository.changed}` : ""}${node.repository.untracked > 0 ? ` ?${node.repository.untracked}` : ""}`
    : null;

  return (
    <div
      onContextMenu={(e) => onContextMenu(e, node)}
      className={cx(
        "group flex h-7 w-full items-center rounded-md pr-1 text-body-medium",
        "hover:bg-background-primary-hover",
        selected
          ? "bg-background-primary-active text-text-primary"
          : "text-text-primary",
      )}
      style={{ paddingLeft: 14 + node.depth * 14 }}
    >
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        title={node.path}
      >
        {node.loading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-foreground-icon-tertiary" aria-hidden />
        ) : (
          <span
            className={cx(
              "size-4 shrink-0 [&>svg]:size-4",
              node.isDir
                ? "text-foreground-icon-secondary"
                : "text-foreground-icon-tertiary",
            )}
            aria-hidden
            dangerouslySetInnerHTML={{ __html: iconSvg }}
          />
        )}
        <span
          className={cx(
            // The folder/file name has display priority: it keeps its
            // natural width (truncating only when it alone overflows the
            // row), so the badge below yields space instead.
            "min-w-0 max-w-full shrink-0 truncate",
            // Spec: untracked → green, modified → orange, dirty repo root →
            // blue (folder containing both kinds takes modified's orange).
            node.color === "untracked" && "text-status-green-text",
            node.color === "modified" && "text-text-warning-primary",
            node.color === "dirtyRepository" && "text-status-blue-text",
          )}
        >
          {node.name}
        </span>
        {node.repository ? (
          <span
            className={cx(
              // The branch badge takes what's left and scrolls horizontally
              // (scrollbar hidden) instead of truncating the branch name.
              "ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-caption-1-medium",
              "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              node.repository.changed + node.repository.untracked === 0
                ? "text-state-success-text"
                : "text-status-yellow-text",
            )}
            title={repositoryLabel ?? undefined}
            aria-label={repositoryLabel ?? undefined}
          >
            <span className="whitespace-nowrap">{node.repository.branch}</span>
            {node.repository.changed + node.repository.untracked === 0 ? (
              <span className="shrink-0" aria-hidden>✓</span>
            ) : (
              <>
                {node.repository.changed > 0 && (
                  <span className="shrink-0 text-text-tertiary" aria-hidden>M{node.repository.changed}</span>
                )}
                {node.repository.untracked > 0 && (
                  <span className="shrink-0 text-text-tertiary" aria-hidden>?{node.repository.untracked}</span>
                )}
              </>
            )}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={mentionLabel}
        title={mentionLabel}
        onClick={(e) => {
          e.stopPropagation();
          onMention(node.path);
        }}
        className="ml-auto hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-primary-active hover:text-text-primary group-hover:flex focus-visible:flex"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
});

export function FileTree() {
  const { t } = useTranslation();
  const root = useFilesStore((s) => s.root);
  const children = useFilesStore((s) => s.children);
  const expanded = useFilesStore((s) => s.expanded);
  const loadingDirs = useFilesStore((s) => s.loadingDirs);
  const dirErrors = useFilesStore((s) => s.dirErrors);
  const selectedPath = useFilesStore((s) => s.selectedPath);
  const ensureDir = useFilesStore((s) => s.ensureDir);
  const toggleDir = useFilesStore((s) => s.toggleDir);
  const invalidateDir = useFilesStore((s) => s.invalidateDir);
  const selectPath = useFilesStore((s) => s.selectPath);
  const openFile = useFilesStore((s) => s.openFile);
  const repositories = useFilesStore((s) => s.repositories);
  const fileColors = useFilesStore((s) => s.fileColors);

  // Load the root level and keep the synthetic root row expanded: the tree
  // roots at the workspace, so its children are always the first content.
  useEffect(() => {
    if (root) {
      void ensureDir(root);
      if (!useFilesStore.getState().expanded[root]) void toggleDir(root);
    }
  }, [root, ensureDir, toggleDir]);

  const visible = useMemo<VisibleNode[]>(() => {
    const out: VisibleNode[] = [];
    // Synthetic root row: the 截图 design shows the workspace root itself as
    // the first tree row with its repository badge (`open-reverselab main
    // M1 ?12`), clicking it expands the tree below it.
    if (root) {
      out.push({
        name: fileName(root),
        isDir: true,
        size: 0,
        mtimeMs: 0,
        path: root,
        depth: 0,
        expanded: !!expanded[root],
        loading: !!loadingDirs[root],
        repository: repositories[root],
        // The 0.9.x tree tinted a dirty workspace-repo folder name; mirror
        // that with blue whenever the root repository has uncommitted work.
        color:
          repositories[root] &&
          repositories[root].changed + repositories[root].untracked > 0
            ? "dirtyRepository"
            : undefined,
      });
    }
    const walk = (dirPath: string, depth: number) => {
      const entries = children[dirPath];
      if (!entries) return;
      for (const e of entries) {
        const path = joinPath(dirPath, e.name);
        out.push({
          ...e,
          path,
          depth,
          expanded: e.isDir && !!expanded[path],
          loading: e.isDir && !!loadingDirs[path],
          repository: e.isDir ? repositories[path] : undefined,
          // A nested repository with uncommitted work tints its own folder
          // blue (same rule as the root row), overriding the level's
          // aggregated color — its dirt is its own, not the parent's.
          color:
            e.isDir &&
            repositories[path] &&
            repositories[path].changed + repositories[path].untracked > 0
              ? "dirtyRepository"
              : fileColors[dirPath]?.[e.name],
        });
        // Only already-expanded levels are walked — the tree never loads
        // recursively; each expansion triggers exactly one listDir call.
        if (e.isDir && expanded[path]) walk(path, depth + 1);
      }
    };
    if (root && expanded[root]) walk(root, 1);
    return out;
  }, [children, expanded, loadingDirs, repositories, fileColors, root]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
    // Rows are recreated on every store update; key measurements by path so
    // expand/collapse/refresh never reassigns a cached size to the wrong row.
    getItemKey: (index) => visible[index]?.path ?? index,
    // ChatPage keeps this panel mounted under `display: none` while the
    // changes tab is active, and ResizeObserver then reports every rendered
    // row as 0px tall. virtual-core has no zero-size guard: accepting those
    // entries poisons itemSizeCache and fires phantom scroll adjustments
    // (writes dropped on the box-less scroller while scrollOffset eagerly
    // drifts), which can leave the virtualizer scrolled past real rows — a
    // blank band at the top of the tree. Keep the last known height instead.
    measureElement: (el, entry, instance) => {
      const size = defaultMeasureElement(el, entry, instance);
      if (size > 0) return size;
      const index = instance.indexFromElement(el);
      return (
        instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? 28
      );
    },
  });

  // Safety net for the same hidden→shown transition: if the DOM scroll
  // position and the virtualizer's offset still diverge (WKWebView restores
  // scrollTop without a scroll event), re-sync through the virtualizer's own
  // scroll pipeline. The synthetic event is a no-op when already in sync
  // (virtual-core's spurious-event guard).
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let lastHeight = el.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const height = el.getBoundingClientRect().height;
      if (lastHeight === 0 && height > 0) el.dispatchEvent(new Event("scroll"));
      lastHeight = height;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rootError = root ? dirErrors[root] : undefined;
  const rootLoading = root ? !!loadingDirs[root] : false;
  // ---- context menu + file operations -------------------------------------
  const clipboard = useFilesStore((s) => s.clipboard);
  const [menu, setMenu] = useState<FileTreeMenuState | null>(null);
  const [prompt, setPrompt] = useState<{
    kind: "newFile" | "newFolder" | "rename";
    /** Parent dir for newFile/newFolder; the item itself for rename. */
    path: string;
    isDir: boolean;
  } | null>(null);
  const [trashTarget, setTrashTarget] = useState<{ path: string; isDir: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const opFailed = useCallback(
    (e: unknown) => setNotice(t("files.opFailed", { message: errorText(e) })),
    [t],
  );

  const openContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>, node: VisibleNode) => {
      event.preventDefault();
      selectPath(node.path, node.isDir);
      setMenu({ x: event.clientX, y: event.clientY, path: node.path, isDir: node.isDir });
    },
    [selectPath],
  );

  /** Refresh the (loaded) parent listing, expand it when collapsed, and
   *  select the operation result so the user sees what changed. */
  const revealInTree = useCallback(
    async (dir: string, target: string | null, isDir: boolean) => {
      if (dir && dir !== root && !useFilesStore.getState().expanded[dir]) {
        await toggleDir(dir);
      }
      await invalidateDir(dir);
      if (target) selectPath(target, isDir);
    },
    [root, toggleDir, invalidateDir, selectPath],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const submitPrompt = useCallback(
    async (name: string) => {
      const p = prompt;
      setPrompt(null);
      if (!p) return;
      if (name.includes("/") || name.includes("\\")) {
        setNotice(t("files.opFailed", { message: name }));
        return;
      }
      try {
        if (p.kind === "rename") {
          const parent = parentPath(p.path);
          const to = joinPath(parent, name);
          if (to !== p.path) {
            await ipc.renameItem(p.path, to);
            useFilesStore.getState().remapTreePath(p.path, to);
            await invalidateDir(parent);
            selectPath(to, p.isDir);
          }
          return;
        }
        const target = joinPath(p.path, name);
        if (p.kind === "newFile") {
          await ipc.createFile(target);
          await revealInTree(p.path, target, false);
        } else {
          await ipc.createDir(target);
          await revealInTree(p.path, target, true);
        }
      } catch (e) {
        opFailed(e);
      }
    },
    [prompt, t, invalidateDir, selectPath, revealInTree, opFailed],
  );

  const confirmTrash = useCallback(async () => {
    const target = trashTarget;
    setTrashTarget(null);
    if (!target) return;
    try {
      await ipc.trashItem(target.path);
      useFilesStore.getState().removeTreePath(target.path);
      await invalidateDir(parentPath(target.path));
    } catch (e) {
      opFailed(e);
    }
  }, [trashTarget, invalidateDir, opFailed]);

  const handlePaste = useCallback(
    async (targetDir: string) => {
      const item = useFilesStore.getState().clipboard;
      if (!item) {
        setNotice(t("files.pasteUnavailable"));
        return;
      }
      try {
        const result = await ipc.pasteItem(item.path, targetDir);
        await revealInTree(targetDir, result.path, result.isDir);
      } catch (e) {
        opFailed(e);
      }
    },
    [t, revealInTree, opFailed],
  );

  const handleDuplicate = useCallback(async () => {
    if (!menu) return;
    try {
      const result = await ipc.duplicateItem(menu.path);
      await revealInTree(parentPath(menu.path), result.path, result.isDir);
    } catch (e) {
      opFailed(e);
    }
  }, [menu, revealInTree, opFailed]);

  // Hover "+" on a row: insert an @path mention into the active chat's
  // composer (renders there as an inline chip). Files and folders alike.
  const handleMention = useCallback(
    (path: string) => useChatStore.getState().requestMention(path),
    [],
  );

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1">
      {rootError ? (
        <div className="flex flex-col items-start gap-2 px-3 py-2">
          <p className="text-caption-1-regular text-text-error-primary break-all">{rootError}</p>
          <button
            type="button"
            onClick={() => void ensureDir(root)}
            className="text-caption-1-medium text-text-secondary underline underline-offset-2 hover:text-text-primary"
          >
            {t("common.refresh")}
          </button>
        </div>
      ) : rootLoading && visible.length === 0 ? (
        <p className="px-3 py-2 text-caption-1-regular text-text-tertiary">{t("common.loading")}</p>
      ) : visible.length === 0 ? (
        <p className="px-3 py-2 text-caption-1-regular text-text-tertiary">{t("files.emptyTree")}</p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const node = visible[vi.index];
            return (
              <div
                key={node.path}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
                className="px-1"
              >
                <TreeRow
                  node={node}
                  selected={selectedPath === node.path}
                  onToggleDir={toggleDir}
                  onOpenFile={openFile}
                  onSelectDir={selectPath}
                  onContextMenu={openContextMenu}
                  onMention={handleMention}
                  mentionLabel={t("files.addToChat")}
                />
              </div>
            );
          })}
        </div>
      )}
      {notice ? (
        <div
          role="alert"
          className="sticky bottom-1 z-10 mx-2 mt-auto flex items-center gap-2 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 py-1.5 text-caption-1-regular text-text-error-primary shadow-dropdown"
        >
          <span className="min-w-0 flex-1 break-all">{notice}</span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setNotice(null)}
            className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-background-tertiary-hover"
          >
            ×
          </button>
        </div>
      ) : null}
      {menu ? (
        <FileTreeContextMenu
          menu={menu}
          pasteDisabled={!clipboard}
          onClose={closeMenu}
          onNewFile={(dir) => setPrompt({ kind: "newFile", path: dir, isDir: true })}
          onNewFolder={(dir) => setPrompt({ kind: "newFolder", path: dir, isDir: true })}
          onCopy={() =>
            useFilesStore.getState().setClipboard({ path: menu.path, isDir: menu.isDir })
          }
          onPaste={(dir) => void handlePaste(dir)}
          onDuplicate={() => void handleDuplicate()}
          onRename={() => setPrompt({ kind: "rename", path: menu.path, isDir: menu.isDir })}
          onCopyPath={() => {
            void navigator.clipboard.writeText(menu.path).catch(opFailed);
          }}
          onSendPath={() => useChatStore.getState().requestMention(menu.path)}
          onReveal={() => {
            void ipc.revealInFileManager(menu.path).catch(opFailed);
          }}
          onTrash={() => setTrashTarget({ path: menu.path, isDir: menu.isDir })}
        />
      ) : null}
      {prompt ? (
        <PromptDialog
          title={t(
            prompt.kind === "newFile"
              ? "files.newFile"
              : prompt.kind === "newFolder"
                ? "files.newFolder"
                : "files.renameItem",
          )}
          initial={prompt.kind === "rename" ? fileName(prompt.path) : ""}
          onSubmit={(name) => void submitPrompt(name)}
          onCancel={() => setPrompt(null)}
        />
      ) : null}
      {trashTarget ? (
        <ConfirmDialog
          danger
          message={t(
            trashTarget.isDir ? "files.deleteFolderConfirm" : "files.deleteFileConfirm",
            { name: fileName(trashTarget.path) },
          )}
          onConfirm={() => void confirmTrash()}
          onCancel={() => setTrashTarget(null)}
        />
      ) : null}
    </div>
  );
}
