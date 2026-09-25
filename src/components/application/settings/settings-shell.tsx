"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import X from "lucide-react/dist/esm/icons/x";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import Search from "lucide-react/dist/esm/icons/search";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import {
  WorkspaceSortableList,
  type RepoDragChrome,
} from "@/components/application/ai-chat/workspace-sortable-list";
import { Input } from "@/components/base/input/input";
import { WindowControls } from "@/components/application/window-controls";
import { needsWindowControls, useTitlebarStyle } from "@/features/settings/titlebar";
import { IS_MAC } from "@/lib/platform";
import { cx } from "@/utils/cx";
import { useBrowserOcclusion } from "@/features/browser/occlusion";

/**
 * The app-wide fullscreen settings page, opened on the /settings route from
 * the sidebar's "Settings" item. The shell is content-agnostic: nav groups,
 * page titles, and page bodies come in as props so feature code owns the
 * actual settings.
 *
 * Shell layout:
 *   root      fixed inset-0, z-100 (dialogs from inside settings portal at
 *             z-110 and still outrank it), fades in on mount. Rendered as a
 *             non-modal <dialog open> so the element carries native dialog
 *             semantics without entering the top layer (a top-layer shell
 *             would cover the z-110 portals).
 *   rail      300px, bg background/secondary, 1px right border, p 10 —
 *             back-to-app row + search box fixed on top (md+ vertical rail
 *             only; mobile closes via the content header's X), then the
 *             group list as the rail's only scroll region — rows never
 *             slide under the overlay traffic lights. Rows follow the Codex
 *             hierarchy: 14px regular-weight labels in text/primary over
 *             near-black icons (foreground/icon-primary), a muted tertiary
 *             section heading and a muted back row — selection is carried by
 *             the row fill alone (background/secondary/hover). The reference
 *             rail renders every row at font-normal (its nav button is passed
 *             `font-normal`); Body/Medium made our labels read visibly
 *             heavier and darker than Codex at the same size. Item rows stack
 *             without a gap: p-1.5 + the 20px line box = the 32px row,
 *             matching the reference rail's pitch.
 *   content   px 32, title row fixed, 720px reading column centered in the
 *             pane — the title row and the page body share it (the close
 *             button stays on the pane's right edge), so wide windows keep
 *             every row's label→control distance short instead of
 *             stretching it edge to edge. The page itself scrolls when
 *             taller than the shell.
 *
 * Rail groups are Codex-style sections: a muted heading over an item list,
 * spaced 24px apart on the md+ rail (list gap 20px + the group's 4px top
 * padding). A group opts into folding with `collapsible` (the CLI 管理 rail
 * and its two buckets) — its heading becomes a toggle whose chevron trails
 * the label, so heading text keeps the rail's left inset (the same column as
 * a static heading) instead of sitting in the item-icon column. The buckets
 * also set `nested`: their gap to the group above drops to 12px so they read
 * as part of CLI 管理 instead of as a new section. Every other group stays
 * static, matching the reference rail. The fold is session-local (no
 * localStorage) and only applies to the md+ vertical rail, which owns the
 * headings; the mobile rail keeps every item. Search filters rail items by
 * label (case-insensitive substring), opens any group holding a match, and
 * suspends drag-sort — a filtered list has no stable reorder axis. Escape
 * closes the page (the search box consumes it first to clear the query).
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** One rail row recipe: back row, nav item and sortable row render from it,
 *  so icon and label columns stay aligned (the collapsible heading copies the
 *  same metrics). */
const RAIL_ROW = "flex items-center gap-1.5 rounded-lg p-1.5 text-left";

/** Reading column shared by the content title row and every page body:
 *  centered in the pane so wide windows keep rows compact (label left,
 *  control right) instead of stretching them edge to edge. */
const CONTENT_COLUMN = "mx-auto w-full max-w-[720px]";

export interface SettingsNavItem {
  key: string;
  label: string;
  icon: IconComponent;
  /** Disabled entry (a CLI the user turned off): grayed icon and label. */
  disabled?: boolean;
}

export interface SettingsNavGroup {
  /** Stable id used as the rail key; falls back to the label (localized —
   *  unstable across languages). */
  id?: string;
  /** Muted section heading; omit for an unlabeled group. */
  label?: string;
  /** Foldable rail section: the heading becomes a chevron toggle and the
   *  item list folds away on the md+ vertical rail. */
  collapsible?: boolean;
  /** Sub-section of the group above (the CLI 管理 buckets): the md+ rail
   *  tightens the gap above it (12px instead of the 24px section gap) so it
   *  reads as part of that group. A nested group can never be the rail's
   *  first row. */
  nested?: boolean;
  /** Initial state of a collapsible group the user hasn't toggled yet
   *  (default: folded). */
  defaultExpanded?: boolean;
  /** When set, the group's items render as a drag-sortable list (the item
   *  icon becomes the grip, md+ vertical rail only) and a drop reports the
   *  new key order. */
  onReorderItems?: (orderedKeys: string[]) => void;
  /** aria-label/title for the drag grip; required with onReorderItems. */
  dragHandleLabel?: string;
  items: SettingsNavItem[];
}

export interface SettingsShellProps {
  /** Called by the back button, close button, and Escape key. */
  onClose: () => void;
  /** Page selected when the shell mounts (the ?page= deep link). A deep
   *  link that changes while the shell is open remounts it via a key at the
   *  call site, so the shell treats this as mount-time state only. */
  defaultPage?: string;
  /** Rail/dialog label (visible title row uses the page title). */
  ariaLabel: string;
  groups: SettingsNavGroup[];
  titles: Record<string, string>;
  renderPage: (key: string) => ReactNode;
  /** Optional per-page action cluster rendered next to the title (e.g. the
   *  CLI 管理 docs/version/update controls). */
  renderHeaderActions?: (key: string) => ReactNode;
}

/** Plain rail row: icon + label in one select button (unchanged recipe). */
function NavButton({
  item,
  selected,
  onSelect,
}: {
  item: SettingsNavItem;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => onSelect(item.key)}
      className={cx(
        RAIL_ROW,
        "w-auto shrink-0 cursor-pointer md:w-full",
        "outline-none transition-colors duration-150 ease focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        selected
          ? "bg-background-secondary-hover"
          : "hover:bg-background-secondary-hover/60",
      )}
    >
      <span
        className={cx("flex shrink-0", item.disabled && "opacity-50 grayscale")}
      >
        <item.icon
          className="size-4 text-foreground-icon-primary"
          aria-hidden
        />
      </span>
      <span
        className={cx(
          "truncate text-body-regular",
          item.disabled ? "text-text-tertiary" : "text-text-primary",
        )}
      >
        {item.label}
      </span>
    </button>
  );
}

/**
 * Drag-sortable rail group (WorkspaceSortableList, same grip pattern as the
 * CLI channel rows): the item icon is the grip. Two sibling buttons — a
 * nested grip inside the select button would be invalid HTML. The grip only
 * exists on the md+ vertical rail; the horizontal mobile rail keeps a
 * static icon because the reorder axis is vertical.
 */
function SortableNavItems({
  group,
  page,
  collapsed = false,
  onSelect,
}: {
  group: SettingsNavGroup;
  page: string;
  /** Folded on the md+ rail; the mobile rail keeps the list either way. */
  collapsed?: boolean;
  onSelect: (key: string) => void;
}) {
  const sortableItems = useMemo(
    () => group.items.map((item) => ({ id: item.key, item })),
    [group.items],
  );
  return (
    <WorkspaceSortableList
      items={sortableItems}
      onReorder={(orderedKeys) => group.onReorderItems?.(orderedKeys)}
      className={cx(
        "flex w-auto flex-row gap-1 md:w-full md:flex-col md:gap-0",
        collapsed && "md:hidden",
      )}
      renderItem={({ item }, drag: RepoDragChrome | null) => {
        const selected = item.key === page;
        if (!drag?.dragHandleProps) {
          return (
            <NavButton item={item} selected={selected} onSelect={onSelect} />
          );
        }
        return (
          <div
            className={cx(
              RAIL_ROW,
              "w-full transition-colors duration-150 ease",
              selected
                ? "bg-background-secondary-hover"
                : "hover:bg-background-secondary-hover/60",
            )}
          >
            <button
              type="button"
              aria-label={group.dragHandleLabel}
              title={group.dragHandleLabel}
              {...drag.dragHandleProps}
              onClick={(event) => event.stopPropagation()}
              className={cx(
                "hidden shrink-0 cursor-grab touch-none md:flex",
                "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              )}
            >
              <item.icon
                className="size-4 shrink-0 text-foreground-icon-primary"
                aria-hidden
              />
            </button>
            <button
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onSelect(item.key)}
              className={cx(
                "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-2lg text-left md:gap-2",
                "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              )}
            >
              <item.icon
                className="size-4 shrink-0 text-foreground-icon-primary md:hidden"
                aria-hidden
              />
              <span className="truncate text-body-regular text-text-primary">
                {item.label}
              </span>
            </button>
          </div>
        );
      }}
    />
  );
}

/** Expanded state for one rail group: explicit user fold state wins, then
 *  the group default, then "the current page lives here" (so a deep link
 *  never lands in a folded group). An active search expands everything. */
function isRailGroupExpanded(
  group: SettingsNavGroup,
  groupKey: string,
  page: string,
  searching: boolean,
  expandedGroups: Record<string, boolean>,
): boolean {
  if (!group.collapsible || searching) return true;
  const explicit = expandedGroups[groupKey];
  if (explicit !== undefined) return explicit;
  if (group.defaultExpanded) return true;
  return group.items.some((item) => item.key === page);
}

/** One rail section: heading (static or fold toggle) plus item list. */
function RailGroupSection({
  group,
  groupIndex,
  page,
  searching,
  expandedGroups,
  onToggleGroup,
  onSelect,
}: {
  group: SettingsNavGroup;
  groupIndex: number;
  page: string;
  searching: boolean;
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (key: string, nextExpanded: boolean) => void;
  onSelect: (key: string) => void;
}) {
  const groupKey = group.id ?? group.label ?? String(groupIndex);
  // Folded is the default for a collapsible group; an active search opens
  // matches so none stay hidden behind a chevron. A page reached inside a
  // folded group (deep link, probe landing later) unfolds that group —
  // unless the user folded it by hand, which stores an explicit `false`.
  const expanded = isRailGroupExpanded(group, groupKey, page, searching, expandedGroups);
  return (
    <div
      className={cx(
        "flex w-auto shrink-0 flex-row gap-1.5 pt-1 md:w-full md:flex-col md:gap-1",
        // Pull a nested bucket 12px up into the gap above it; index 0 keeps
        // the container's own edge (a search can promote a bucket to the
        // first visible row).
        group.nested && groupIndex > 0 && "md:-mt-3",
      )}
    >
      {/* Section heading (Codex style): muted label on the rail's left
          inset, aligned with a static heading. A collapsible group turns
          the heading row into a toggle whose chevron trails the label; the
          rest stay static. */}
      {group.label &&
        (group.collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => onToggleGroup(groupKey, !expanded)}
            className={cx(
              "hidden w-auto shrink-0 cursor-pointer items-center gap-1.5 rounded-lg p-1.5 text-left md:flex md:w-full",
              "outline-none transition-colors duration-150 ease hover:bg-background-secondary-hover/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-body-regular text-text-tertiary">
              {group.label}
            </span>
            <ChevronRight
              className={cx(
                "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-150 ease",
                expanded && "rotate-90",
              )}
              aria-hidden
            />
          </button>
        ) : (
          <span className="hidden truncate pl-1.5 text-body-regular text-text-tertiary md:block">
            {group.label}
          </span>
        ))}
      {group.onReorderItems && !searching ? (
        <SortableNavItems
          group={group}
          page={page}
          collapsed={!expanded}
          onSelect={onSelect}
        />
      ) : (
        <div
          className={cx(
            "flex w-auto flex-row gap-1 md:w-full md:flex-col md:gap-0",
            !expanded && "md:hidden",
          )}
        >
          {group.items.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              selected={item.key === page}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The rail: drag strip, back/search header, then the scrollable group
 *  list with its progressive top fade. */
function SettingsRail({
  ariaLabel,
  customControls,
  trafficLightInset,
  query,
  onQueryChange,
  onClose,
  searching,
  visibleGroups,
  page,
  expandedGroups,
  onToggleGroup,
  onSelect,
  railScrolled,
  onRailScrolled,
}: {
  ariaLabel: string;
  customControls: boolean;
  trafficLightInset: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  searching: boolean;
  visibleGroups: SettingsNavGroup[];
  page: string;
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (key: string, nextExpanded: boolean) => void;
  onSelect: (key: string) => void;
  railScrolled: boolean;
  onRailScrolled: (scrolled: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={ariaLabel}
      className="flex w-full shrink-0 flex-row gap-5 overflow-x-auto border-b border-separator-border bg-background-secondary-default p-2.5 md:w-[300px] md:flex-col md:gap-5 md:overflow-x-visible md:border-r md:border-b-0"
    >
      {/* Window drag strip reaching the overlay titlebar (same recipe as
          SidebarDragStrip): clears the floating macOS traffic lights so
          back/search don't sit under them, and drags the window from
          blank spots — Tauri toggles maximize on double-click. */}
      <div
        data-tauri-drag-region="deep"
        className={cx(
          "hidden w-full shrink-0 items-center md:flex md:-mb-3",
          trafficLightInset ? "h-6.25" : "h-3",
        )}
      >
        {customControls && <WindowControls className="pl-2" />}
      </div>
      {/* Back + search — vertical rail only; mobile closes via the X. */}
      <div className="hidden md:flex md:w-full md:shrink-0 md:flex-col md:gap-1.5">
        <button
          type="button"
          onClick={onClose}
          className={cx(
            RAIL_ROW,
            "w-full cursor-pointer",
            "outline-none transition-colors duration-150 ease hover:bg-background-secondary-hover/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          )}
        >
          <ArrowLeft
            className="size-4 shrink-0 text-foreground-icon-secondary"
            aria-hidden
          />
          <span className="truncate text-body-regular text-text-secondary">
            {t("settings.backToApp")}
          </span>
        </button>
        <Input
          aria-label={t("common.search")}
          placeholder={t("settings.searchPlaceholder")}
          value={query}
          onChange={onQueryChange}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // The react-aria input stops keydown propagation, so
              // Escape can't fall through to the window close listener —
              // clear a query first, close the page when the box is empty.
              event.stopPropagation();
              if (query) onQueryChange("");
              else onClose();
            }
          }}
          leadingIcon={Search}
          size="small"
          /* Codex-style field: white fill with a 1px hairline (the shell's
             idle ring is transparent; the inset shadow supplies the
             border without fighting hover/focus ring colors). The fill
             needs `!` — the shell's own bg utility is emitted later in
             the stylesheet and would win otherwise. */
          fieldClassName="bg-background-primary-default! shadow-[inset_0_0_0_1px_var(--color-separator-border)]"
        />
      </div>

      {/* Group list — the rail's only scroll region on md+, so rows never
          slide under the floating traffic lights and back/search stay
          fixed. `contents` on mobile keeps the groups as direct flex
          children of the horizontal-scrolling nav (unchanged recipe). */}
      <div className="contents md:relative md:min-h-0 md:flex-1">
        <div
          className="scrollbar-none contents md:flex md:h-full md:w-full md:flex-col md:gap-5 md:overflow-y-auto"
          onScroll={(e) => onRailScrolled(e.currentTarget.scrollTop > 0)}
        >
          {searching && visibleGroups.length === 0 ? (
            <span className="hidden px-1.5 text-body-2-medium text-text-tertiary md:block">
              {t("settings.searchEmpty")}
            </span>
          ) : (
            visibleGroups.map((group, groupIndex) => (
              <RailGroupSection
                key={group.id ?? group.label ?? groupIndex}
                group={group}
                groupIndex={groupIndex}
                page={page}
                searching={searching}
                expandedGroups={expandedGroups}
                onToggleGroup={onToggleGroup}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
        {/* Progressive top fade (same recipe as the content pane): rows
            dissolve under the fixed header instead of hard-cutting. */}
        <div
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-x-0 top-0 hidden h-8 bg-linear-to-b from-background-secondary-default to-transparent md:block",
            "transition-opacity duration-200 ease-out",
            railScrolled ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </nav>
  );
}

/** The content pane: fixed title row (doubling as a window drag region) and
 *  the scrollable page body on the shared reading column. */
function SettingsContent({
  ariaLabel,
  page,
  titles,
  renderHeaderActions,
  renderPage,
  contentScrolled,
  onContentScrolled,
  onClose,
}: {
  ariaLabel: string;
  page: string;
  titles: Record<string, string>;
  renderHeaderActions?: (key: string) => ReactNode;
  renderPage: (key: string) => ReactNode;
  contentScrolled: boolean;
  onContentScrolled: (scrolled: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The title row doubles as a window drag region ("deep": blank spots
          drag, Tauri toggles maximize on double-click, buttons stay
          clickable). Title and page body share CONTENT_COLUMN (same px,
          same padding), so wide windows center both on one axis; the close
          button sits in the title's grid cell (justify-self) and never
          shifts that axis. */}
      <div
        data-tauri-drag-region="deep"
        className="grid shrink-0 items-center px-4 pt-4 pb-3 md:px-8 md:pt-16 select-none"
      >
        <div
          className={cx(
            CONTENT_COLUMN,
            "col-start-1 row-start-1 flex min-w-0 items-center gap-3 pr-8",
          )}
        >
          <h2 className="shrink-0 text-title-2-medium text-text-primary">
            {titles[page] ?? page}
          </h2>
          {renderHeaderActions?.(page)}
        </div>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={onClose}
          className={cx(
            "col-start-1 row-start-1 justify-self-end flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full",
            "bg-background-tertiary-default text-foreground-icon-secondary",
            "transition-colors duration-150 ease hover:bg-background-tertiary-hover",
            "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          )}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          className="h-full overflow-y-auto px-4 pb-4 md:px-8 md:pb-8"
          onScroll={(e) => onContentScrolled(e.currentTarget.scrollTop > 0)}
        >
          <div className={CONTENT_COLUMN}>{renderPage(page)}</div>
        </div>
        {/* Progressive top fade — eases in once the page is scrolled so
            content dissolves under the title row instead of hard-cutting. */}
        <div
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-x-0 top-0 h-10 bg-linear-to-b from-background-primary-default to-transparent",
            "transition-opacity duration-200 ease-out",
            contentScrolled ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </div>
  );
}

export function SettingsShell({
  onClose,
  defaultPage,
  ariaLabel,
  groups,
  titles,
  renderPage,
  renderHeaderActions,
}: SettingsShellProps) {
  // macOS Overlay titlebar: the system traffic lights float over the
  // rail's top-left; Windows 仿 mac mode draws its own controls instead.
  // Both need the rail's first content row pushed below them.
  const titlebarStyle = useTitlebarStyle();
  const customControls = needsWindowControls(titlebarStyle);
  const trafficLightInset = IS_MAC || customControls;
  const firstKey = groups[0]?.items[0]?.key ?? "general";
  // The page renders above any surface, including the native browser
  // webview — which must hide for HTML to paint over it.
  useBrowserOcclusion(true);
  /** Page selected on mount (the ?page= deep link), General otherwise. */
  const openPage = defaultPage ?? firstKey;
  const [page, setPage] = useState<string>(openPage);

  // Escape returns to the app; the search input stops propagation first so
  // a query-cleared Escape never closes the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Fade in on mount; no exit transition (the route unmounts immediately).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Rail search: case-insensitive label substring. Groups keep their
  // headings (context for the match) and drop empty buckets entirely.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  /** Fold state of collapsible groups, keyed by group id; session-local, so
   *  reopening settings starts from each group's default again. */
  const [expandedGroups, setExpandedGroups] = useState<
    Record<string, boolean>
  >({});
  // Top fade over the scrolling page so rows dissolve under the title row
  // instead of cutting sharply (same recipe as the medical alerts feed).
  const [contentScrolled, setContentScrolled] = useState(false);
  /** Rail counterpart of contentScrolled: drives the group list's top fade
   *  now that the list scrolls on its own under the fixed header. */
  const [railScrolled, setRailScrolled] = useState(false);
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.flatMap((group) => {
      const items = group.items.filter((item) =>
        item.label.toLowerCase().includes(needle),
      );
      return items.length > 0 ? [{ ...group, items }] : [];
    });
  }, [groups, query]);

  // A page reached inside a folded group (deep link, page change) unfolds
  // that group so the selected row is never hidden; the fold stays
  // user-owned, so an explicit fold is never re-opened. Computed during
  // render in RailGroupSection instead of mirrored into state by an effect.

  const toggleGroup = useCallback(
    (groupKey: string, nextExpanded: boolean) => {
      setExpandedGroups((prev) => ({ ...prev, [groupKey]: nextExpanded }));
    },
    [],
  );
  const selectPage = useCallback((key: string) => {
    setPage(key);
    setContentScrolled(false);
  }, []);

  return (
    <dialog
      open
      aria-label={ariaLabel}
      className={cx(
        "fixed inset-0 z-100 m-0 flex h-full max-h-none w-full max-w-none flex-col border-0 bg-background-full p-0 md:flex-row",
        "transition-opacity duration-200 ease-out",
        entered ? "opacity-100" : "opacity-0",
      )}
    >
      <SettingsRail
        ariaLabel={ariaLabel}
        customControls={customControls}
        trafficLightInset={trafficLightInset}
        query={query}
        onQueryChange={setQuery}
        onClose={onClose}
        searching={searching}
        visibleGroups={visibleGroups}
        page={page}
        expandedGroups={expandedGroups}
        onToggleGroup={toggleGroup}
        onSelect={selectPage}
        railScrolled={railScrolled}
        onRailScrolled={setRailScrolled}
      />
      <SettingsContent
        ariaLabel={ariaLabel}
        page={page}
        titles={titles}
        renderHeaderActions={renderHeaderActions}
        renderPage={renderPage}
        contentScrolled={contentScrolled}
        onContentScrolled={setContentScrolled}
        onClose={onClose}
      />
    </dialog>
  );
}
