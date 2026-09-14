import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Search from "lucide-react/dist/esm/icons/search";
import { cx } from "@/utils/cx";
import {
  MENU_ITEM,
  MENU_ITEM_ACTIVE,
  MENU_ITEMS_CONTAINER,
} from "@/components/base/dropdown/menu-styles";
import {
  MENTION_MENU_LIMIT,
  useMentionIndexStore,
  type MentionEntry,
} from "@/components/application/ai-chat/mention-files";
import { getFileTreeIconSvg } from "./fileIcons";
import { joinPath, useFilesStore } from "./store";

const INPUT_ID = "file-search-input";

/**
 * Workspace-relative prefix of `absolute` inside `root`: `""` when `absolute`
 * IS the root, `null` when it is not inside the workspace (nothing to search).
 * Separators are normalized so Windows `\` and POSIX `/` roots compare equal.
 */
export function workspaceRelativePrefix(root: string, absolute: string): string | null {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = absolute.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base) return null;
  if (target === base) return "";
  if (!target.startsWith(base + "/")) return null;
  return target.slice(base.length + 1);
}

/**
 * Index entries that live inside the search root. The prefix test is
 * separator-aware on purpose: a bare `startsWith` would scope `src` to
 * `src-extra/` too.
 */
export function scopeEntries(
  entries: MentionEntry[],
  root: string,
  searchRoot: string,
): MentionEntry[] {
  const prefix = workspaceRelativePrefix(root, searchRoot);
  if (prefix === null) return [];
  if (prefix === "") return entries;
  return entries.filter(
    (entry) => entry.rel === prefix || entry.rel.startsWith(prefix + "/"),
  );
}

/** Match quality of one query against one entry; lower wins. */
const TIER = {
  /** The name IS the query (`readme` → `readme`). */
  NameExact: 0,
  /** The name starts with the query (`readme` → `readme.md`). */
  NamePrefix: 1,
  /** The query sits inside the name (`readme` → `my-readme.md`). */
  NameSubstring: 2,
  /** The query is a subsequence of the name (`rdm` → `readme.md`). */
  NameSubsequence: 3,
  /** Only the folder path matches — a weak result, ranked last. */
  PathSubsequence: 4,
} as const;
type MatchTier = (typeof TIER)[keyof typeof TIER];

interface RankedRow {
  entry: MentionEntry;
  tier: MatchTier;
  /** Where the match starts (in the name, or the path for the last tier). */
  offset: number;
}

/** Leftmost index of `needle` as a subsequence of `haystack`, or null. */
function subsequenceAt(haystack: string, needle: string): number | null {
  let qi = 0;
  let first = -1;
  for (let i = 0; i < haystack.length && qi < needle.length; i++) {
    if (haystack[i] !== needle[qi]) continue;
    if (qi === 0) first = i;
    qi++;
  }
  return qi === needle.length ? first : null;
}

function rankEntry(entry: MentionEntry, q: string): RankedRow | null {
  const name = entry.name.toLowerCase();
  if (name === q) return { entry, tier: TIER.NameExact, offset: 0 };
  if (name.startsWith(q)) return { entry, tier: TIER.NamePrefix, offset: 0 };
  const inName = name.indexOf(q);
  if (inName >= 0) return { entry, tier: TIER.NameSubstring, offset: inName };
  const inNameSub = subsequenceAt(name, q);
  if (inNameSub !== null) {
    return { entry, tier: TIER.NameSubsequence, offset: inNameSub };
  }
  // `entry.key` is the lower-cased relative path (mention-files buildEntries).
  const inPath = subsequenceAt(entry.key, q);
  if (inPath !== null) return { entry, tier: TIER.PathSubsequence, offset: inPath };
  return null;
}

/**
 * Rows the overlay shows for a query, best match first.
 *
 * Ranking is name-first: exact name, name prefix, query inside the name,
 * subsequence of the name, and only then a subsequence of the folder path.
 * Reusing the @-mention picker's scorer here was wrong — it scores the WHOLE
 * relative path, so for `readme` the workspace segment `open-reverselab`
 * matches `re…` and collects its own bonuses, which pushed the actual
 * `README.md` files below `DISCLAIMER.md`.
 *
 * Within a tier: earlier match first, then the shallower path, then
 * alphabetical. An empty query shows nothing rather than the first N scoped
 * entries — an arbitrary slice of a subtree reads as "these are the files";
 * browsing is the tree's job, this surface is search only.
 */
export function searchEntries(
  entries: MentionEntry[],
  root: string,
  searchRoot: string,
  query: string,
): MentionEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: RankedRow[] = [];
  for (const entry of scopeEntries(entries, root, searchRoot)) {
    const row = rankEntry(entry, q);
    if (row) ranked.push(row);
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.offset - b.offset ||
      a.entry.rel.length - b.entry.rel.length ||
      (a.entry.rel < b.entry.rel ? -1 : a.entry.rel > b.entry.rel ? 1 : 0),
  );
  return ranked.slice(0, MENTION_MENU_LIMIT).map((row) => row.entry);
}

/**
 * Workspace file search scoped to one folder, opened from the tree's
 * right-click menu. Shares the @-mention index cache for the active
 * workspace root (no extra walk), and exists only while `searchRoot` is set
 * — see FilesPanel. Escape closes; the input keeps focus, so the pointer and
 * the keyboard both work without a focus dance.
 */
export function FileSearchOverlay({ searchRoot }: { searchRoot: string }) {
  const { t } = useTranslation();
  const root = useFilesStore((s) => s.root);
  const closeSearch = useFilesStore((s) => s.closeSearch);
  const index = useMentionIndexStore((s) => (root ? s.byRoot[root] : undefined));
  useEffect(() => {
    if (root) useMentionIndexStore.getState().ensure(root);
  }, [root]);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The overlay mounts per open, so this focuses the input exactly then.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(
    () => searchEntries(index?.entries ?? [], root, searchRoot, query),
    [index, root, searchRoot, query],
  );

  // The match list can shrink under the cursor; clamp the active row.
  const active = items.length > 0 ? Math.min(activeIndex, items.length - 1) : -1;

  const activate = useCallback(
    (entry: MentionEntry) => {
      // Index rels are workspace-relative with "/" — back to the absolute,
      // platform-separator paths the tree/store use.
      const absolute = joinPath(root, entry.rel);
      if (entry.isDir) useFilesStore.getState().selectPath(absolute, true);
      else void useFilesStore.getState().openFile(absolute);
      closeSearch();
    },
    [root, closeSearch],
  );

  // Keys live on the window (same pattern as the command palette): the input
  // holds focus, but the overlay stays keyboard-driven even if focus leaves.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          closeSearch();
          return;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
          return;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        case "Enter": {
          const entry = active >= 0 ? items[active] : undefined;
          if (!entry) return;
          e.preventDefault();
          activate(entry);
          return;
        }
        default:
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, active, activate, closeSearch]);

  // Keep the keyboard-highlighted row in view while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  return (
    <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background-primary-default">
      <div className="flex items-center gap-2 border-b border-separator-border px-3">
        <Search className="size-4 shrink-0 text-foreground-icon-tertiary" aria-hidden />
        <label
          htmlFor={INPUT_ID}
          className="sr-only"
        >
          {t("files.searchFilesTitle")}
        </label>
        <input
          id={INPUT_ID}
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          placeholder={t("files.searchPlaceholder")}
          className="h-9 w-full bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-placeholder"
        />
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={t("files.searchFilesTitle")}
        className={cx(MENU_ITEMS_CONTAINER, "min-h-0 flex-1 overflow-y-auto p-1.5")}
      >
        {items.length === 0 ? (
          // No query → nothing at all: see searchEntries. A query with no
          // matches gets the empty state.
          query.trim() ? (
            <div className="p-2 text-body-regular text-text-tertiary select-none">
              {t("files.searchNoMatches")}
            </div>
          ) : null
        ) : (
          items.map((entry, i) => {
            // Containing folder ("" for workspace-root entries), same split
            // the @-mention rows use.
            const dir = entry.rel.slice(0, entry.rel.length - entry.name.length);
            return (
              <div
                key={entry.rel}
                role="option"
                aria-selected={i === active}
                data-active={i === active || undefined}
                tabIndex={-1}
                title={entry.rel}
                // Keep focus in the input so typing never stops: the click
                // still activates the row below.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => {
                  if (i !== active) setActiveIndex(i);
                }}
                onClick={() => activate(entry)}
                className={cx(MENU_ITEM, "cursor-pointer", i === active && MENU_ITEM_ACTIVE)}
              >
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center text-foreground-icon-secondary [&>svg]:size-4"
                  dangerouslySetInnerHTML={{
                    __html: getFileTreeIconSvg(entry.name, entry.isDir),
                  }}
                />
                <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
                {dir ? (
                  <span className="truncate text-body-regular text-text-tertiary">{dir}</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
