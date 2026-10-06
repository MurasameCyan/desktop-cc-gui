import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";
import type { Message } from "@/lib/ipc";

/** The user row the host writes to run its own compaction. */
export const COMPACT_COMMAND_TEXT = "/compact";

/** Nudge the footer sends after a threshold compaction. Identity for the
 *  renderer, so every shipped locale counts; the `Messages` type keeps the
 *  keys honest (a rename breaks the build, not the filter). */
const RESUME_TEXTS: readonly string[] = [
  zh.chat.autoCompactResume,
  en.chat.autoCompactResume,
];

/** User rows the app writes on its own — the "/compact" command and the
 *  post-compaction resume nudge. The store keeps both (compact-turn
 *  detection, resendLastUser read them), but the timeline renders neither:
 *  compaction shows up as a status hint instead. History pages reload from
 *  the engine's transcript, where these rows carry no marker, so the texts
 *  are the identity; a re-sent nudge may carry a frozen bot block, hence the
 *  prefix test. */
export function isInternalUserRow(
  message: Pick<Message, "role" | "text">,
): boolean {
  if (message.role !== "user") return false;
  const text = message.text.trim();
  return (
    text === COMPACT_COMMAND_TEXT ||
    RESUME_TEXTS.some((prefix) => text.startsWith(prefix))
  );
}
