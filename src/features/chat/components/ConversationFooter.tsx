import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Composer,
  StatusBar,
  type ComposerInputHandle,
} from "@/components/application/ai-chat/ai-chat-composer";
import { MessageQueue } from "@/components/application/ai-chat/message-queue";
import type { ContextSegment } from "@/components/application/agent-limits/agent-limits-card";
import type { BranchInfo, Workspace } from "@/lib/ipc";
import type { ActiveSession, QueuedMessage } from "../store";
import { useChatStore } from "../store";
import { ImageLightbox } from "./MessageImages";
import { RunStatusStrip } from "./RunStatusStrip";
import { sessionKey } from "../store";
import { ComposerSlotExtras } from "@/features/plugins/boundary/composer-slot-extras";
import { COMPOSER_DRAFT_TOPIC, pluginBus } from "@/features/plugins/runtime/events";
import { USAGE_PART_LABEL_KEYS, usageBreakdown } from "./usage-breakdown";

/** Path → trailing name (folder or file) for status-bar and chip labels.
 *  Both separators: workspace/attachment paths are native — backslashes on
 *  Windows — matching fileName in features/files/store. */
function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Composer attachment chip lightbox target: preview URL + display name. */
type ZoomImage = { src: string; name: string } | null;

/** Error banner row (image/branch failures); hidden with no message. */
function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary"
    >
      <span className="min-w-0 flex-1 break-all">{message}</span>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-background-tertiary-hover"
      >
        ×
      </button>
    </div>
  );
}

/** One attachment chip: thumbnail + name button zooms the preview, × removes. */
function AttachmentChip({
  path,
  preview,
  onRemove,
  onZoom,
}: {
  path: string;
  preview: { url: string; name: string } | undefined;
  onRemove: (path: string) => void;
  onZoom: (zoom: NonNullable<ZoomImage>) => void;
}) {
  const { t } = useTranslation();
  const name = preview?.name ?? baseName(path);
  return (
    <span
      className="inline-flex items-center rounded-full bg-background-tertiary-default text-caption-1-medium text-text-secondary"
    >
      <button
        type="button"
        onClick={() =>
          preview && onZoom({ src: preview.url, name: preview.name })
        }
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-l-full py-0.5 pl-0.5"
        aria-label={name}
      >
        {preview && (
          <img
            src={preview.url}
            alt=""
            className="size-6 shrink-0 rounded-full object-cover"
          />
        )}
        <span className="max-w-48 truncate">{name}</span>
      </button>
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={() => onRemove(path)}
        className="cursor-pointer rounded-r-full py-0.5 pr-2 pl-1 hover:text-text-primary"
      >
        ×
      </button>
    </span>
  );
}

/** Attachment chip row above the composer; hidden with no attachments. */
function AttachmentChips({
  images,
  previews,
  onRemoveImage,
  onZoomImage,
}: {
  images: string[];
  previews: Record<string, { url: string; name: string }>;
  onRemoveImage: (path: string) => void;
  onZoomImage: (zoom: NonNullable<ZoomImage>) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex flex-wrap gap-1.5">
        {images.map((path) => (
          <AttachmentChip
            key={path}
            path={path}
            preview={previews[path]}
            onRemove={onRemoveImage}
            onZoom={onZoomImage}
          />
        ))}
      </div>
    </div>
  );
}

/** Active session's run status; renders idle placeholders with no session. */
function ActiveRunStatus({ active }: { active: ActiveSession | null }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <RunStatusStrip
        sessionKey={active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : ""}
        engine={active?.engine ?? ""}
        workspacePath={active?.workspacePath ?? ""}
      />
    </div>
  );
}

/** Composer with its slot menus, disabled state, and image-paste wiring. */
function FooterComposer({
  active,
  draft,
  onDraftChange,
  onSubmit,
  sendShortcut,
  onStop,
  streaming,
  noEnabledEngines,
  images,
  composerInputRef,
  addMenu,
  cliMenu,
  permissionMenu,
  supportsImages,
  onPasteImages,
}: {
  active: ActiveSession | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  sendShortcut: string;
  onStop: () => void;
  streaming: boolean;
  noEnabledEngines: boolean;
  images: string[];
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  addMenu: ReactNode;
  cliMenu: ReactNode;
  permissionMenu: ReactNode;
  supportsImages: boolean;
  onPasteImages: (files: File[]) => void;
}) {
  return (
    <Composer
      className="mx-auto max-w-3xl"
      value={draft}
      onValueChange={onDraftChange}
      onSubmit={onSubmit}
      sendShortcut={sendShortcut === "cmdEnter" ? "cmdEnter" : "enter"}
      onStop={onStop}
      streaming={streaming}
      disabled={!active || noEnabledEngines || (!draft.trim() && images.length === 0)}
      inputRef={composerInputRef}
      addMenu={<>{addMenu}<ComposerSlotExtras slot="addMenu" /></>}
      cliMenu={<>{cliMenu}<ComposerSlotExtras slot="cliMenu" /></>}
      permissionMenu={<>{permissionMenu}<ComposerSlotExtras slot="permissionMenu" /></>}
      onPasteImages={supportsImages ? onPasteImages : undefined}
      workspacePath={active?.workspacePath}
    />
  );
}

/** Branch/folder/usage status bar under the composer. The quick-switch
 * folder chip mirrors the sidebar: archived workspaces stay hidden until
 * unarchived. */
function FooterStatusBar({
  active,
  streaming,
  workspaces,
  sessionUsage,
  contextMax,
  branch,
  branches,
  onBranchSelect,
  startNewChat,
}: {
  active: ActiveSession | null;
  streaming: boolean;
  workspaces: Workspace[];
  sessionUsage: unknown;
  contextMax: number;
  branch: string | undefined;
  branches: BranchInfo[] | undefined;
  onBranchSelect: (name: string) => void;
  startNewChat: (workspacePath: string) => void;
}) {
  const { t } = useTranslation();
  // Same denominator as the breakdown card (contextMax), so the ring pill
  // and the card never disagree.
  const usage = useMemo(
    () => usageBreakdown(sessionUsage, contextMax),
    [sessionUsage, contextMax],
  );
  const contextSegments: ContextSegment[] | undefined = useMemo(
    () =>
      usage?.parts.map((p) => ({
        label: t(USAGE_PART_LABEL_KEYS[p.kind]),
        tokens: p.tokens,
      })),
    [usage, t],
  );
  const archivedWorkspaces = useChatStore((s) => s.archivedWorkspaces);
  const compactContext = useChatStore((s) => s.compactContext);
  const refreshSessionUsage = useChatStore((s) => s.refreshSessionUsage);
  const [compacting, setCompacting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleCompact = useCallback(async () => {
    if (!active || streaming || compacting) return;
    setCompacting(true);
    try {
      await compactContext();
    } finally {
      setCompacting(false);
    }
  }, [active, streaming, compacting, compactContext]);

  const handleRefresh = useCallback(async () => {
    if (!active || refreshing) return;
    setRefreshing(true);
    try {
      await refreshSessionUsage();
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }, [active, refreshing, refreshSessionUsage]);

  const visibleWorkspaces = useMemo(
    () => {
      const archivedIds = new Set(archivedWorkspaces);
      return workspaces.filter((w) => !archivedIds.has(w.id));
    },
    [workspaces, archivedWorkspaces],
  );
  const statusFolders = useMemo(() => visibleWorkspaces.map((w) => baseName(w.path)), [visibleWorkspaces]);
  const handleFolderSelect = useCallback(
    (name: string) => {
      const target = visibleWorkspaces.find((w) => baseName(w.path) === name);
      if (target) startNewChat(target.path);
    },
    [visibleWorkspaces, startNewChat],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <StatusBar
        branch={branch}
        branches={branches}
        onBranchSelect={onBranchSelect}
        folders={statusFolders}
        selectedFolder={active ? baseName(active.workspacePath) : undefined}
        onFolderSelect={handleFolderSelect}
        usagePct={usage?.pct}
        contextMax={contextMax}
        contextSegments={contextSegments}
        onCompactContext={handleCompact}
        onRefreshUsage={handleRefresh}
        compacting={compacting}
        refreshing={refreshing}
        canCompact={Boolean(active) && !streaming && !compacting}
      />
    </div>
  );
}

/** Attachment preview lightbox; hidden until a chip is clicked. */
function AttachmentLightbox({
  zoom,
  onClose,
}: {
  zoom: ZoomImage;
  onClose: () => void;
}) {
  if (!zoom) return null;
  return <ImageLightbox src={zoom.src} name={zoom.name} onClose={onClose} />;
}

/** Bottom column of the conversation: the message queue, error banners,
 * attachment chips, the composer, and the branch/folder/usage status bar. */
export function ConversationFooter({
  active,
  workspaces,
  queue,
  onRemoveQueued,
  onClearQueued,
  imageError,
  branchError,
  onDismissImageError,
  onDismissBranchError,
  images,
  previews,
  onRemoveImage,
  draft,
  onDraftChange,
  onSubmit,
  sendShortcut,
  onStop,
  streaming,
  noEnabledEngines,
  composerInputRef,
  addMenu,
  cliMenu,
  permissionMenu,
  supportsImages,
  onPasteImages,
  sessionUsage,
  contextMax,
  branch,
  branches,
  onBranchSelect,
  startNewChat,
}: {
  active: ActiveSession | null;
  workspaces: Workspace[];
  queue: QueuedMessage[];
  onRemoveQueued: (id: string) => void;
  onClearQueued?: () => void;
  imageError: string | null;
  branchError: string | null;
  onDismissImageError: () => void;
  onDismissBranchError: () => void;
  images: string[];
  previews: Record<string, { url: string; name: string }>;
  onRemoveImage: (path: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  sendShortcut: string;
  onStop: () => void;
  streaming: boolean;
  noEnabledEngines: boolean;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  addMenu: ReactNode;
  cliMenu: ReactNode;
  permissionMenu: ReactNode;
  supportsImages: boolean;
  onPasteImages: (files: File[]) => void;
  sessionUsage: unknown;
  contextMax: number;
  branch: string | undefined;
  branches: BranchInfo[] | undefined;
  onBranchSelect: (name: string) => void;
  startNewChat: (workspacePath: string) => void;
}) {
  /** Composer attachment chip lightbox: preview URL + display name. */
  const [zoomImage, setZoomImage] = useState<ZoomImage>(null);

  // The draft prop is the store's per-session value, so watching it covers
  // every change source at once: typing, submit-clear, and session switches
  // all re-emit with the latest text (empty string included).
  useEffect(() => {
    pluginBus.emit(COMPOSER_DRAFT_TOPIC, { text: draft });
  }, [draft]);

  return (
    <>
      <div
        className="flex w-full flex-col gap-2.5 bg-background-primary-default px-4 pt-2.5 pb-2"
      >
        <MessageQueue queue={queue} onRemove={onRemoveQueued} onClear={onClearQueued} className="mx-auto w-full max-w-3xl" />
        <ErrorBanner message={imageError} onDismiss={onDismissImageError} />
        <ErrorBanner message={branchError} onDismiss={onDismissBranchError} />
        <AttachmentChips
          images={images}
          previews={previews}
          onRemoveImage={onRemoveImage}
          onZoomImage={setZoomImage}
        />
        <ActiveRunStatus active={active} />
        <FooterComposer
          active={active}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit}
          sendShortcut={sendShortcut}
          onStop={onStop}
          streaming={streaming}
          noEnabledEngines={noEnabledEngines}
          images={images}
          composerInputRef={composerInputRef}
          addMenu={addMenu}
          cliMenu={cliMenu}
          permissionMenu={permissionMenu}
          supportsImages={supportsImages}
          onPasteImages={onPasteImages}
        />
        <FooterStatusBar
          active={active}
          streaming={streaming}
          workspaces={workspaces}
          sessionUsage={sessionUsage}
          contextMax={contextMax}
          branch={branch}
          branches={branches}
          onBranchSelect={onBranchSelect}
          startNewChat={startNewChat}
        />

      </div>
      <AttachmentLightbox zoom={zoomImage} onClose={() => setZoomImage(null)} />
    </>
  );
}
