/** Minimal label row for the GitHub-style blockquote alerts promoted by
 *  remark-github-alerts.ts: colored uppercase text, no icon. Kept separate
 *  from Markdown.tsx so the renderer file stays lean. */
import { useTranslation } from "react-i18next";
import type { AlertType } from "./remark-github-alerts";

const ALERT_LABEL_KEY: Record<AlertType, string> = {
  note: "chat.alertNote",
  tip: "chat.alertTip",
  important: "chat.alertImportant",
  warning: "chat.alertWarning",
  caution: "chat.alertCaution",
};

/** Reads the className the remark plugin stamped onto the blockquote (hast
 *  `properties.className`, or the space-separated React `className` string)
 *  back into the alert type, for the component override in Markdown.tsx. */
export function isAlertClassName(className: unknown): AlertType | null {
  const names = Array.isArray(className)
    ? className.flatMap((item) => String(item).split(/\s+/))
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  for (const name of names) {
    if (!name) continue;
    const match = /^md-alert-(note|tip|important|warning|caution)$/.exec(name);
    if (match) return match[1] as AlertType;
  }
  return null;
}

export function AlertTitle({ type }: { type: AlertType }) {
  const { t } = useTranslation();
  return <div className="md-alert-title">{t(ALERT_LABEL_KEY[type])}</div>;
}
