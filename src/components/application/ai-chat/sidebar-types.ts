export type ThreadAction = "pin" | "rename" | "archive" | "delete";

export interface AiChatThread {
  id?: string;
  label: string;
  /** CLI engine id — brand mark rendered left of the label. */
  engine?: string;
  /** Relative-time chip (e.g. "34m"). */
  time: string;
  isSelected?: boolean;
  pinned?: boolean;
  /** A turn is streaming in this session — breathing blue dot. */
  streaming?: boolean;
  /** Finished activity the user has not opened yet — solid green dot. */
  unseen?: boolean;
  /** Pending tab: first message not sent, so pin/rename/copy-id do not apply. */
  isDraft?: boolean;
}

export interface AiChatRepo {
  id?: string;
  label: string;
  /** Original workspace folder name when `label` is a user-set alias
   *  (surfaced as the row tooltip). */
  originalLabel?: string;
  /** Recent chats listed when the repo is expanded. */
  threads: AiChatThread[];
  /** Max threads listed before collapsing behind a "show more" row. */
  threadLimit?: number;
  /** Plugin-provided badge text (e.g. "WSL") rendered as a chip after the
   *  label; styling comes from the plugin's injected CSS. */
  labelSuffix?: string;
  /** Expanded on first render (folder-open icon + visible threads). */
  defaultOpen?: boolean;
}
/** A workspace group section (工作区二级分类): named groups render with a
 *  collapsible header; the single `id: null` section is ungrouped repos
 *  rendered flat, exactly as before groups existed. */
export interface AiChatRepoSection {
  id: string | null;
  name: string;
  repos: AiChatRepo[];
}
