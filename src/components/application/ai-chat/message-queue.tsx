import { useTranslation } from "react-i18next";
import ImageIcon from "lucide-react/dist/esm/icons/image";
import ListOrdered from "lucide-react/dist/esm/icons/list-ordered";
import SendHorizontal from "lucide-react/dist/esm/icons/send-horizontal";
import X from "lucide-react/dist/esm/icons/x";
import type { QueuedMessage } from "@/features/chat/store";
import { cx } from "@/utils/cx";

/**
 * Card above the composer listing messages queued while a turn streams.
 * Numbering follows the send order: #1 sits closest to the input and drains
 * first. Rows render newest-first so the next message to send is at the
 * bottom, matching the reference desktop-cc-gui queue card. Layout classes
 * (width, alignment) come from the caller via `className`.
 */

const PREVIEW_LIMIT = 120;

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= PREVIEW_LIMIT
    ? normalized
    : `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`;
}

export interface MessageQueueProps {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  /** Send one row now instead of waiting the turn out; a running turn is
   *  stopped first, since an engine takes one prompt at a time. Row button
   *  only renders when provided. */
  onSendNow?: (id: string) => void;
  /** Clear every queued message; header button only renders when provided. */
  onClear?: () => void;
  className?: string;
}

export function MessageQueue({ queue, onRemove, onSendNow, onClear, className }: MessageQueueProps) {
  const { t } = useTranslation();
  if (queue.length === 0) return null;

  return (
    <div
      className={cx(
        "flex flex-col rounded-2xl border border-separator-border bg-background-secondary-default shadow-dropdown",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
        <span className="flex min-w-0 items-center gap-1.5 text-caption-1-medium text-text-secondary">
          <ListOrdered className="size-3.5 shrink-0 text-foreground-icon-tertiary" aria-hidden />
          <span className="truncate">{t("chat.queueTitle")}</span>
          <span className="shrink-0 rounded-full bg-background-tertiary-default px-1.5 py-px text-caption-2-medium text-text-tertiary">
            {queue.length}
          </span>
        </span>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-caption-1-medium text-text-tertiary transition-colors hover:bg-background-tertiary-hover hover:text-text-error-primary"
          >
            {t("chat.queueClear")}
          </button>
        )}
      </div>
      <div className="flex max-h-28 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5">
        {[...queue].reverse().map((item, reversedIndex) => {
          const position = queue.length - reversedIndex;
          return (
            <div
              key={item.id}
              className="group grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-background-tertiary-hover"
            >
              <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-button-primary text-caption-2-medium text-text-white">
                {position}
              </span>
              <span
                className="min-w-0 truncate text-body-regular text-text-primary"
                title={item.text}
                aria-label={item.text}
              >
                {item.images.length > 0 && (
                  <span
                    className="mr-1.5 inline-flex items-center gap-0.5 rounded-md bg-background-tertiary-default px-1 py-px align-middle text-caption-1-medium text-text-secondary"
                    title={t("chat.queueImages", { count: item.images.length })}
                  >
                    <ImageIcon className="size-3" aria-hidden />
                    {item.images.length}
                  </span>
                )}
                {preview(item.text)}
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                {onSendNow && (
                  <button
                    type="button"
                    aria-label={t("chat.queueSendNow")}
                    onClick={() => onSendNow(item.id)}
                    className="flex size-5 cursor-pointer items-center justify-center rounded-full text-foreground-icon-tertiary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
                  >
                    <SendHorizontal className="size-3.5" aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t("chat.queueRemove")}
                  title={t("chat.queueRemove")}
                  onClick={() => onRemove(item.id)}
                  className="flex size-5 cursor-pointer items-center justify-center rounded-full text-foreground-icon-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-error-primary"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
