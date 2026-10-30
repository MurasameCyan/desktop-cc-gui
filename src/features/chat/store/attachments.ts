/**
 * Per-session composer attachments: the images waiting to be sent with the
 * next message of one conversation, plus their chip thumbnails.
 *
 * Keyed by sessionKey beside `drafts` for the same reason drafts are: one
 * ChatConversation instance serves every session the tab strip (and every
 * split pane) shows, so anything the user attached has to belong to the
 * conversation it was attached in — never to the component instance. The
 * hook used to hold this in local useState, which leaked A's chips into B.
 *
 * Leaf module: no store imports, so tabs / messaging / engine-events can
 * migrate and drop this state beside the drafts they already move, without a
 * runtime cycle back into the store.
 */

/** Chip thumbnail plus the metadata shown beside it: a preview data URL, the
 *  display name, and pixel dimensions / byte size recovered from it. */
export interface AttachmentPreview {
  url: string;
  name: string;
  width?: number;
  height?: number;
  size?: number;
}

/** One session's pending attachments. `error` is the paste/import banner,
 *  scoped the same way: a rejection in session A must not paint session B. */
export interface ComposerAttachments {
  images: string[];
  previews: Record<string, AttachmentPreview>;
  error: string | null;
}

/** Path → attachments for every session that has attached (or failed to
 *  attach) something. Sessions absent from the map have no attachments. */
export type ComposerAttachmentsByKey = Record<string, ComposerAttachments>;

/** One session's attested-empty slice: the selector's stable answer for a
 *  session that has never attached anything (a fresh object per read would
 *  re-render every subscriber on every store write). */
export const EMPTY_ATTACHMENTS: ComposerAttachments = {
  images: [],
  previews: {},
  error: null,
};

/** Shared empty record: the store's initial value and the migration helper's
 *  "nothing to do" answer, so subscribers keep their reference. */
export const NO_COMPOSER_ATTACHMENTS: ComposerAttachmentsByKey = {};

/** True when a session slice carries nothing worth remembering: no images, no
 *  thumbnails, no banner. Such a slice is dropped from the map instead of
 *  stored, so the record only holds sessions that actually have attachments. */
export function isEmptyAttachments(value: ComposerAttachments | undefined): boolean {
  return (
    value === undefined ||
    (value.images.length === 0 &&
      Object.keys(value.previews).length === 0 &&
      value.error === null)
  );
}

/**
 * Move one session's attachments to another key, exactly like drafts follow a
 * pending tab to its native id. The destination wins on a preview collision
 * (it is the conversation the user is looking at); images are concatenated
 * without duplicates. A same-key move leaves the record untouched.
 */
export function moveComposerAttachments(
  rec: ComposerAttachmentsByKey | undefined,
  fromKey: string,
  toKey: string,
): ComposerAttachmentsByKey {
  if (fromKey === toKey || !rec) return rec ?? NO_COMPOSER_ATTACHMENTS;
  const from = rec[fromKey];
  if (isEmptyAttachments(from)) return rec;
  const to = rec[toKey];
  const next = { ...rec };
  delete next[fromKey];
  if (!to) {
    next[toKey] = from;
    return next;
  }
  const images = [...to.images];
  const seen = new Set(images);
  for (const path of from.images) {
    if (seen.has(path)) continue;
    seen.add(path);
    images.push(path);
  }
  next[toKey] = {
    images,
    previews: { ...from.previews, ...to.previews },
    error: to.error ?? from.error,
  };
  return next;
}

/** Drop attachments for keys whose sessions are gone (delete / archive /
 *  removed workspace). Keys not present keep their reference. */
export function withoutComposerAttachments(
  rec: ComposerAttachmentsByKey | undefined,
  keys: Iterable<string>,
): ComposerAttachmentsByKey {
  if (!rec) return NO_COMPOSER_ATTACHMENTS;
  let next = rec;
  for (const key of keys) {
    if (!(key in next)) continue;
    if (next === rec) next = { ...rec };
    delete next[key];
  }
  return next;
}
