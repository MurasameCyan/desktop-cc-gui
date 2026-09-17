import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Star from "lucide-react/dist/esm/icons/star";
import X from "lucide-react/dist/esm/icons/x";
import { ModalShell } from "@/components/dialogs";
import { openExternal } from "@/lib/platform";
import { cx } from "@/utils/cx";
import type { ChangelogEntry } from "@/version/changelog";

/**
 * Resolve content to display. Shows both EN and ZH when both exist,
 * ordered by the active UI language (zh / zh-TW get Chinese first).
 */
function resolveContent(entry: ChangelogEntry, language?: string): { lang: "zh" | "en"; text: string }[] {
  const parts = [
    { lang: "zh" as const, text: entry.content.zh },
    { lang: "en" as const, text: entry.content.en },
  ].filter((part) => part.text);
  return (language ?? "").toLowerCase().startsWith("zh") ? parts : parts.reverse();
}

interface ChangelogDialogProps {
  entries: ChangelogEntry[];
  /** GitHub repo the Star banner links to. */
  githubUrl: string;
  onClose: () => void;
}

/**
 * Version-history dialog (Settings → About → 版本记录). One page per
 * release, ←/→ or the chevrons to page; Escape/backdrop close come from
 * ModalShell's react-aria modal.
 */
export function ChangelogDialog({ entries, githubUrl, onClose }: ChangelogDialogProps) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPage((p) => Math.max(0, p - 1));
      else if (e.key === "ArrowRight") setPage((p) => Math.min(entries.length - 1, p + 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [entries.length]);

  const entry = entries[page];
  const hasPrev = page > 0;
  const hasNext = page < entries.length - 1;

  const starRepo = useCallback(() => openExternal(githubUrl), [githubUrl]);

  if (!entry) return null;

  return (
    <ModalShell
      onClose={onClose}
      label={t("changelog.title")}
      className="flex max-h-[calc(100dvh-64px)] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl p-0"
      dialogClassName="flex min-h-0 flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-separator-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-title-3-semibold text-text-primary">{t("changelog.title")}</h3>
          <span className="shrink-0 rounded-full bg-background-tertiary-default px-2 py-0.5 text-caption-1-medium text-text-secondary">
            v{entry.version}
          </span>
          <span className="shrink-0 text-caption-1-regular text-text-tertiary">{entry.date}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={starRepo}
            aria-label={t("settings.openSourceBannerStarAria")}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border-button-default bg-background-primary-default px-2 py-1 text-body-2-medium text-text-primary transition-colors hover:bg-background-secondary-hover"
          >
            <Star className="size-3.5 text-foreground-icon-secondary" aria-hidden />
            {t("settings.openSourceBannerStar")}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {resolveContent(entry, i18n.language).map((part, idx) => (
          <div key={part.lang} className={cx(idx > 0 && "border-t border-separator-border pt-3")}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h4 className="pt-1 pb-1 text-body-medium text-text-primary">{children}</h4>
                ),
                p: ({ children }) => (
                  <p className="py-0.5 text-body-regular text-text-primary">{children}</p>
                ),
                ul: ({ children }) => (
                  <ul className="flex list-disc flex-col gap-1 py-1 pl-5 text-body-regular text-text-primary marker:text-text-tertiary">
                    {children}
                  </ul>
                ),
                li: ({ children }) => <li className="pl-0.5">{children}</li>,
                strong: ({ children }) => (
                  <strong className="font-semibold text-text-primary">{children}</strong>
                ),
                code: ({ children }) => (
                  <code className="rounded-sm bg-background-tertiary-default px-1 py-0.5 font-mono text-[0.85em] text-text-primary">
                    {children}
                  </code>
                ),
              }}
            >
              {part.text}
            </ReactMarkdown>
          </div>
        ))}
      </div>

      {/* Footer pagination */}
      <div className="flex items-center justify-between border-t border-separator-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!hasPrev}
          aria-label={t("changelog.prev")}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>

        {entries.length <= 10 ? (
          <div className="flex items-center gap-1.5">
            {entries.map((e, idx) => (
              <button
                key={e.version}
                type="button"
                onClick={() => setPage(idx)}
                aria-label={e.version}
                className={cx(
                  "size-1.5 cursor-pointer rounded-full transition-colors",
                  idx === page
                    ? "bg-foreground-icon-primary"
                    : "bg-background-tertiary-default hover:bg-foreground-icon-secondary",
                )}
              />
            ))}
          </div>
        ) : (
          <span className="text-caption-1-regular text-text-secondary">
            {t("changelog.page", { current: page + 1, total: entries.length })}
          </span>
        )}

        <button
          type="button"
          onClick={() => setPage((p) => Math.min(entries.length - 1, p + 1))}
          disabled={!hasNext}
          aria-label={t("changelog.next")}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </ModalShell>
  );
}
