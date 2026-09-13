import { useTranslation } from "react-i18next";
import { cx } from "@/utils/cx";

/** Keep full upstream errors scrollable without displacing the conversation. */
export function ErrorBanner({
  message,
  onDismiss,
  className,
}: {
  message: string | null;
  onDismiss: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cx(
        "flex min-w-0 shrink-0 items-start gap-2 rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary",
        className,
      )}
    >
      <span
        tabIndex={0}
        className="max-h-[min(8rem,12dvh)] min-w-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap break-all [@media(max-height:500px)]:max-h-6"
      >
        {message}
      </span>
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
