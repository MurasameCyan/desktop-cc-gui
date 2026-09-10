import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { mentionToken } from "@/components/application/ai-chat/file-tags";
import { pickFiles } from "@/lib/platform";
import { useChatStore, type ActiveSession } from "../store";
import { recordPrompt } from "../prompt-history";
import { IMAGE_EXTENSIONS } from "./use-composer-images";

/** Composer submit/draft/attach/stop handlers plus the pending-@mention
 * bridge, so ChatConversation stays a composition layer. */
export function useComposerActions({
  active,
  sessionKey,
  streaming,
  images,
  clearImages,
  importImageFiles,
  supportsImages,
  composerInputRef,
}: {
  active: ActiveSession | null;
  sessionKey: string;
  streaming: boolean;
  images: string[];
  clearImages: () => void;
  importImageFiles: (paths: string[], supported: boolean) => void;
  supportsImages: boolean;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
}) {
  const { t } = useTranslation();
  const pendingMention = useChatStore((s) => s.pendingMention);
  const {
    setDraft,
    clearPendingMention,
    send,
    queueMessage,
    interrupt,
  } = useChatStore(
    useShallow((s) => ({
      setDraft: s.setDraft,
      clearPendingMention: s.clearPendingMention,
      send: s.send,
      queueMessage: s.queueMessage,
      interrupt: s.interrupt,
    })),
  );

  const submit = useCallback(
    (value: string) => {
      if (!active || (!value.trim() && images.length === 0)) return;
      recordPrompt(value);
      setDraft(sessionKey, "");
      clearImages();
      // A turn is in flight: park the message in the session's queue; the
      // store drains it FIFO when the turn ends.
      if (streaming) {
        queueMessage(value, images);
        return;
      }
      void send(value, images);
    },
    [active, images, streaming, sessionKey, setDraft, clearImages, send, queueMessage],
  );

  // File-tree "+" asks the composer to insert an @path mention at the caret.
  useEffect(() => {
    if (!pendingMention) return;
    clearPendingMention();
    const input = composerInputRef.current;
    if (!input) return;
    input.focus();
    input.insertText(`${mentionToken(pendingMention.path)} `);
  }, [pendingMention, clearPendingMention, composerInputRef]);

  const handleDraftChange = useCallback(
    (v: string) => setDraft(sessionKey, v),
    [sessionKey, setDraft],
  );

  // "Add → Files and folders": native multi-picker. Images flow through the
  // sandboxed image pipeline (chips); every other picked file becomes an
  // @mention at the caret — same as the file tree's "+" — so its content
  // stays live instead of a frozen sandbox copy.
  const handleAddAttachments = useCallback(() => {
    void (async () => {
      const picked = await pickFiles(t("chat.addFilesFolders"));
      if (picked.length === 0) return;
      const imagePaths: string[] = [];
      const mentionPaths: string[] = [];
      for (const path of picked) {
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        (IMAGE_EXTENSIONS.includes(ext) ? imagePaths : mentionPaths).push(path);
      }
      if (mentionPaths.length > 0) {
        const input = composerInputRef.current;
        if (input) {
          input.focus();
          input.insertText(`${mentionPaths.map(mentionToken).join(" ")} `);
        }
      }
      if (imagePaths.length > 0) importImageFiles(imagePaths, supportsImages);
    })();
  }, [t, composerInputRef, importImageFiles, supportsImages]);

  const handleStop = useCallback(() => void interrupt(), [interrupt]);
  const handlePickSkills = useCallback(
    () => composerInputRef.current?.openSlashPicker(),
    [composerInputRef],
  );

  return {
    submit,
    handleDraftChange,
    handleAddAttachments,
    handleStop,
    handlePickSkills,
  };
}
