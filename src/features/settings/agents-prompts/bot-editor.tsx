import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import Eye from "lucide-react/dist/esm/icons/eye";
import Bot from "lucide-react/dist/esm/icons/bot";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/input/textarea";
import { cx } from "@/utils/cx";
import { BotAvatarView } from "@/features/bots/bot-avatar";
import { refreshBotBlocks } from "@/features/bots/selected-bot";
import { useBotStore } from "@/features/bots/bot-store";
import type { BotConfig } from "@/lib/ipc";
import { BotAvatarStudio } from "./bot-avatar-studio";
import { BotPromptPreview } from "./bot-prompt-preview";
import {
  CapabilitiesSection,
  PlannedSection,
  ProseSection,
} from "./bot-editor-sections";

/** Debounce before an edit is written to disk (typing feels instant, the
 *  file is not rewritten per keystroke). */
const AUTOSAVE_MS = 600;

type TabId =
  | "soul"
  | "rules"
  | "capabilities"
  | "runtime"
  | "memory"
  | "routines"
  | "collab";

/** Sections that ship later: the tab is visible, the content says so. */
const PLANNED: Record<
  "runtime" | "memory" | "routines" | "collab",
  { phase: number; items: string[] }
> = {
  runtime: {
    phase: 3,
    items: [
      "直连模型 / Claude Code / Codex 三种运行后端，带安装与登录检测",
      "CLI 模式的工作目录、权限模式和额外参数",
      "切换后端后同一个 Bot 仍用同一份人格与工作规则",
    ],
  },
  memory: {
    phase: 2,
    items: [
      "Bot 自己的笔记（MEMORY，上限 2,200 字）与全局用户画像（USER）",
      "写入需要审批、安全扫描、容量超限时先合并再写入",
      "会话结束后的后台复盘，把偏好与踩坑经验自动记下来",
    ],
  },
  routines: {
    phase: 3,
    items: [
      "按 cron 定时执行任务，结果回到这个 Bot 的聊天里",
      "客户端没运行时不会执行，启动后最多补跑一次",
    ],
  },
  collab: {
    phase: 4,
    items: [
      "把子任务委派给其他 Bot，深度最多 2 层、同时最多 3 个",
      "群聊：2–6 个 Bot 加上你，按顺序轮转、可用 @ 点名",
    ],
  },
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

/** Section heading keys of the planned tabs (the tab label is the title). */
const PLANNED_COPY: Record<
  "runtime" | "memory" | "routines" | "collab",
  { titleKey: string; descKey: string }
> = {
  runtime: { titleKey: "settings.botTabRuntime", descKey: "settings.botRuntimeDesc" },
  memory: { titleKey: "settings.botTabMemory", descKey: "settings.botMemoryDesc" },
  routines: { titleKey: "settings.botTabRoutines", descKey: "settings.botRoutinesDesc" },
  collab: { titleKey: "settings.botTabCollab", descKey: "settings.botCollabDesc" },
};

/**
 * Full-bleed bot editor, opened from the list. It covers the settings content
 * pane (the settings rail stays visible on md+) and keeps the list behind it —
 * the identity column answers "who is this" at every moment, the tabs answer
 * "what does it do".
 *
 * Saves are automatic: edits land in `draft`, and a debounced write patches
 * the store. The draft, not the store, is what the fields render — otherwise a
 * store refresh would fight the caret.
 */
export function BotEditor({
  bot,
  onBack,
}: {
  bot: BotConfig;
  /** Back to the list. `saved` tells the list whether to re-read. */
  onBack: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<BotConfig>(bot);
  const [tab, setTab] = useState<TabId>("soul");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const applyLocal = (patch: Partial<BotConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
    pendingRef.current = true;
  };

  // Debounced autosave. The patch carries every editable field: the backend
  // validates the whole shape anyway, and a partial patch would need a
  // per-field dirty map that adds nothing here.
  useEffect(() => {
    if (!pendingRef.current) return;
    setSave({ kind: "saving" });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      pendingRef.current = false;
      void useBotStore
        .getState()
        .update(draft.id, {
          name: draft.name,
          slug: draft.slug,
          title: draft.title ?? "",
          description: draft.description ?? "",
          avatar: draft.avatar,
          soul: draft.soul,
          instructions: draft.instructions,
          capabilities: draft.capabilities,
          runtime: draft.runtime,
          memory: draft.memory,
          pinned: draft.pinned,
          hidden: draft.hidden,
        })
        .then((updated) => {
          if (!updated) {
            setSave({ kind: "error", message: t("settings.botSaveMissing") });
            return;
          }
          // The backend may normalize what we sent (slug uniqueness, an
          // emoji avatar with no glyph): adopt its answer for those fields
          // without touching what the user is typing.
          setDraft((current) => ({
            ...current,
            slug: updated.slug,
            avatar: updated.avatar,
            updatedAt: updated.updatedAt,
          }));
          setSave({ kind: "saved", at: Date.now() });
        })
        .catch((error: unknown) => {
          setSave({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, AUTOSAVE_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [draft, t]);

  // Leaving the editor with unsaved keystrokes would drop them: flush now.
  useEffect(
    () => () => {
      if (!pendingRef.current) return;
      const current = draftRef.current;
      void useBotStore
        .getState()
        .update(current.id, {
          name: current.name,
          slug: current.slug,
          title: current.title ?? "",
          description: current.description ?? "",
          avatar: current.avatar,
          soul: current.soul,
          instructions: current.instructions,
          capabilities: current.capabilities,
          runtime: current.runtime,
          memory: current.memory,
          pinned: current.pinned,
          hidden: current.hidden,
        })
        .catch(() => {});
    },
    [],
  );

  const tabs: Array<{ id: TabId; label: string; phase?: number }> = useMemo(
    () => [
      { id: "soul", label: t("settings.botTabSoul") },
      { id: "rules", label: t("settings.botTabRules") },
      { id: "capabilities", label: t("settings.botTabCapabilities") },
      { id: "runtime", label: t("settings.botTabRuntime"), phase: PLANNED.runtime.phase },
      { id: "memory", label: t("settings.botTabMemory"), phase: PLANNED.memory.phase },
      { id: "routines", label: t("settings.botTabRoutines"), phase: PLANNED.routines.phase },
      { id: "collab", label: t("settings.botTabCollab"), phase: PLANNED.collab.phase },
    ],
    [t],
  );

  const saveLabel =
    save.kind === "saving"
      ? t("settings.botSaving")
      : save.kind === "error"
        ? t("settings.botSaveFailed", { message: save.message })
        : save.kind === "saved"
          ? t("settings.botSaved", {
              time: new Date(save.at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })
          : t("settings.botSavedIdle");

  return (
    <div className="fixed inset-0 z-105 flex flex-col bg-background-primary-default md:left-[300px]">
      <div
        data-tauri-drag-region="deep"
        className="flex shrink-0 items-center gap-3 border-b border-separator-border px-4 py-2.5"
      >
        <Button
          size="small"
          variant="ghost"
          leadingIcon={ArrowLeft}
          onClick={() => {
            const wasPending = pendingRef.current;
            pendingRef.current = false;
            onBack(wasPending);
          }}
        >
          {t("settings.botBackToList")}
        </Button>
        <span className="flex min-w-0 items-center gap-2">
          <BotAvatarView avatar={draft.avatar} seed={draft.id} size={22} />
          <span className="truncate text-body-medium text-text-primary">{draft.name}</span>
          <span className="shrink-0 rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-caption-1-regular text-text-tertiary">
            {draft.source === "builtin"
              ? t("settings.botSourceBuiltIn")
              : t("settings.botSourceCustom")}
          </span>
        </span>
        <span
          role="status"
          className={cx(
            "ml-auto shrink-0 text-caption-1-regular",
            save.kind === "error" ? "text-text-error-primary" : "text-text-tertiary",
          )}
        >
          {saveLabel}
        </span>
        <Button
          size="small"
          variant="secondary"
          leadingIcon={Eye}
          onClick={() => setPreviewOpen((open) => !open)}
        >
          {t("settings.botPreviewToggle")}
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* 身份：常驻左栏，切到任何分区都不会丢 */}
        <div className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-separator-border bg-background-secondary-default p-4">
          <BotAvatarStudio
            avatar={draft.avatar}
            seed={draft.id}
            onChange={(avatar) => applyLocal({ avatar })}
          />
          <div className="flex flex-col gap-3">
            <Input
              size="small"
              label={t("settings.agentName")}
              value={draft.name}
              onChange={(name) => applyLocal({ name })}
              maxLength={64}
            />
            <Input
              size="small"
              label={t("settings.botTitleLabel")}
              hint={t("settings.botTitleHint")}
              value={draft.title ?? ""}
              onChange={(title) => applyLocal({ title })}
              maxLength={48}
            />
            <TextArea
              label={t("settings.botDescriptionLabel")}
              hint={t("settings.botDescriptionHint")}
              value={draft.description ?? ""}
              onChange={(description) => applyLocal({ description })}
              rows={3}
              maxLength={200}
            />
            <Input
              size="small"
              label={t("settings.botSlugLabel")}
              hint={t("settings.botSlugHint")}
              value={draft.slug}
              onChange={(slug) => applyLocal({ slug })}
              maxLength={48}
            />
          </div>
          <p className="mt-auto text-caption-1-regular text-text-quaternary">
            {t("settings.botMetaLine", {
              date: new Date(draft.createdAt).toLocaleDateString(),
            })}
            <br />
            {t("settings.botSchemaLine", { version: draft.schemaVersion })}
          </p>
        </div>

        {/* 分区内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-separator-border px-4 py-2">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={cx(
                  "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-body-2-regular",
                  "outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  tab === entry.id
                    ? "bg-background-tertiary-default text-text-primary"
                    : "text-text-tertiary hover:text-text-primary",
                )}
              >
                {entry.label}
                {entry.phase !== undefined && (
                  <span className="rounded bg-background-secondary-default px-1 text-caption-1-regular text-text-quaternary">
                    P{entry.phase}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4">
              {(tab === "soul" || tab === "rules") && (
                <ProseSection
                  kind={tab === "soul" ? "soul" : "instructions"}
                  bot={draft}
                  onChange={(patch) => applyLocal(patch)}
                />
              )}
              {tab === "capabilities" && (
                <CapabilitiesSection
                  bot={draft}
                  onChange={(patch) => applyLocal(patch)}
                />
              )}
              {tab !== "soul" && tab !== "rules" && tab !== "capabilities" && (
                <PlannedSection
                  phase={PLANNED[tab].phase}
                  titleKey={PLANNED_COPY[tab].titleKey}
                  descKey={PLANNED_COPY[tab].descKey}
                  items={PLANNED[tab].items}
                />
              )}
              <div className="flex items-start gap-2 rounded-2lg border border-separator-border bg-background-secondary-default px-3 py-2.5 text-caption-1-regular text-text-tertiary">
                <Bot className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <p>{t("settings.botEditorFooter")}</p>
              </div>
            </div>
          </div>
        </div>

        {previewOpen && (
          <BotPromptPreview
            bot={draft}
            onClose={() => setPreviewOpen(false)}
            onRefreshContext={() => refreshBotBlocks(draft.id)}
          />
        )}
      </div>
    </div>
  );
}
