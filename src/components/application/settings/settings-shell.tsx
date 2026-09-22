"use client";

import {
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
import { readStoredJson, writeStored } from "@/lib/storage";

/** localStorage key for the user's rail collapse choices (group id →
 *  expanded). Only groups with a stable `id` persist; others are
 *  session-local. */
const RAIL_EXPANDED_KEY = "ccgui-next.settingsRailExpanded:v1";

const readRailExpanded = (): Record<string, boolean> =>
  readStoredJson(RAIL_EXPANDED_KEY, (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, boolean>)
      : null,
  ) ?? {};

/**
 * The app-wide fullscreen settings page, opened on the /settings route from
 * the sidebar's "Settings" item. The shell is content-agnostic: nav groups,
 * page titles, and page bodies come in as props so feature code owns the
 * actual settings.
 *
 * Shell layout:
 *   root      fixed inset-0, z-100 (dialogs from inside settings portal at
 *             z-110 and still outrank it), fades in on mount.
 *   rail      254px, bg background/secondary, 1px right border, p 10 —
 *             back-to-app row + search box fixed on top (md+ vertical rail
 *             only; mobile closes via the content header's X), then the
 *             group list as the rail's only scroll region — rows never
 *             slide under the overlay traffic lights — in the same
 *             group/item recipe as the board-team dropdown menus (label
 *             pl-8, items p-8 radius/2lg icon-20 + body-medium), selected
 *             row bg background/secondary/hover.
 *   content   px 32, title row fixed, the page itself scrolls when taller
 *             than the shell.
 *
 * Search filters rail items by label (case-insensitive substring); while a
 * query is active every group force-expands and drag-sort is suspended — a
 * filtered list has no stable reorder axis. Escape closes the page (the
 * search box consumes it first to clear the query).
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface SettingsNavItem {
  key: string;
  label: string;
  icon: IconComponent;
  /** Disabled entry (a CLI the user turned off): grayed icon and label. */
  disabled?: boolean;
}

export interface SettingsNavGroup {
  /** Stable id used as the rail key and for persisted collapse state;
   *  falls back to the label (localized — unstable across languages). */
  id?: string;
  /** Muted group heading; omit for an unlabeled group. */
  label?: string;
  /** Collapsible rail section: the heading becomes a chevron toggle and a
   *  selected page inside force-expands the group. */
  collapsible?: boolean;
  /** Initial expanded state for a collapsible group the user has never
   *  toggled (default: collapsed). Once toggled, the user's choice wins and
   *  persists across sessions when the group has an `id`. */
  defaultExpanded?: boolean;
  /** Show an item-count pill next to the heading (the CLI rails). */
  showCount?: boolean;
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
  /** Page selected when the shell mounts (the ?page= deep link). */
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
        "flex w-auto shrink-0 cursor-pointer items-center gap-1.5 rounded-2lg p-1.5 text-left md:w-full md:gap-2 md:p-2",
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
          className="size-4 text-foreground-icon-secondary md:size-5"
          aria-hidden
        />
      </span>
      <span
        className={cx(
          "truncate text-body-medium",
          item.disabled
            ? "text-text-tertiary"
            : selected
              ? "text-text-primary"
              : "text-text-secondary",
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
  onSelect,
}: {
  group: SettingsNavGroup;
  page: string;
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
      className="flex w-auto flex-row gap-1 md:w-full md:flex-col"
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
              "flex w-full items-center gap-1.5 rounded-2lg p-1.5 transition-colors duration-150 ease md:gap-2 md:p-2",
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
                className="size-5 shrink-0 text-foreground-icon-secondary"
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
                className="size-4 shrink-0 text-foreground-icon-secondary md:hidden"
                aria-hidden
              />
              <span
                className={cx(
                  "truncate text-body-medium",
                  selected ? "text-text-primary" : "text-text-secondary",
                )}
              >
                {item.label}
              </span>
            </button>
          </div>
        );
      }}
    />
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
  const { t } = useTranslation();
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
  // A deep link that changes while settings is open switches pages.
  // openPage is a stable string (URL param / "general"), so group memo
  // recomputes don't reset the user's page mid-session.
  useEffect(() => setPage(openPage), [openPage]);

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

  // Top fade over the scrolling page so rows dissolve under the title row
  // instead of cutting sharply (same recipe as the medical alerts feed).
  const [contentScrolled, setContentScrolled] = useState(false);
  /** Rail counterpart of contentScrolled: drives the group list's top fade
   *  now that the list scrolls on its own under the fixed header. */
  const [railScrolled, setRailScrolled] = useState(false);
  /** Expanded state per collapsible group (keyed by group id); seeded from
   *  localStorage so the user's collapse choices survive reopening. */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    readRailExpanded,
  );

  return (
    <div
      role="dialog"
      aria-label={ariaLabel}
      className={cx(
        "fixed inset-0 z-100 flex flex-col bg-background-full md:flex-row",
        "transition-opacity duration-200 ease-out",
        entered ? "opacity-100" : "opacity-0",
      )}
    >
      {/* Nav rail — the board-team dropdown group/item recipe */}
      <nav
        aria-label={ariaLabel}
        className="flex w-full shrink-0 flex-row gap-5 overflow-x-auto border-b border-separator-border bg-background-secondary-default p-2.5 md:w-[254px] md:flex-col md:gap-5 md:overflow-x-visible md:border-r md:border-b-0"
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
              "flex cursor-pointer items-center gap-1.5 rounded-2lg p-1.5 text-left md:gap-2 md:p-2",
              "outline-none transition-colors duration-150 ease hover:bg-background-secondary-hover/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            )}
          >
            <ArrowLeft
              className="size-4 shrink-0 text-foreground-icon-secondary md:size-5"
              aria-hidden
            />
            <span className="truncate text-body-medium text-text-primary">
              {t("settings.backToApp")}
            </span>
          </button>
          <Input
            aria-label={t("common.search")}
            placeholder={t("settings.searchPlaceholder")}
            value={query}
            onChange={setQuery}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // The react-aria input stops keydown propagation, so
                // Escape can't fall through to the window close listener —
                // clear a query first, close the page when the box is empty.
                event.stopPropagation();
                if (query) setQuery("");
                else onClose();
              }
            }}
            leadingIcon={Search}
            size="small"
          />
        </div>

        {/* Group list — the rail's only scroll region on md+, so rows never
            slide under the floating traffic lights and back/search stay
            fixed. `contents` on mobile keeps the groups as direct flex
            children of the horizontal-scrolling nav (unchanged recipe). */}
        <div className="contents md:relative md:min-h-0 md:flex-1">
          <div
            className="scrollbar-none contents md:flex md:h-full md:w-full md:flex-col md:gap-5 md:overflow-y-auto"
            onScroll={(e) => setRailScrolled(e.currentTarget.scrollTop > 0)}
          >
            {searching && visibleGroups.length === 0 ? (
              <span className="hidden px-2 text-body-medium text-text-tertiary md:block">
                {t("settings.searchEmpty")}
              </span>
            ) : (
              visibleGroups.map((group, groupIndex) => (
                <div
                  key={group.id ?? group.label ?? groupIndex}
                  className="flex w-auto shrink-0 flex-row gap-1.5 pt-1 md:w-full md:flex-col"
                >
                  {(() => {
                    const groupKey = group.id ?? group.label ?? String(groupIndex);
                    // A selected page inside a collapsed group force-expands it
                    // so the current row never hides under the chevron; an
                    // active search force-expands everything so matches show.
                    const expanded =
                      searching ||
                      !group.collapsible ||
                      (expandedGroups[groupKey] ?? group.defaultExpanded ?? false) ||
                      group.items.some((item) => item.key === page);
                    const toggleGroup = () =>
                      setExpandedGroups((prev) => {
                        const next = {
                          ...prev,
                          [groupKey]: !(
                            prev[groupKey] ?? group.defaultExpanded ?? false
                          ),
                        };
                        if (group.id)
                          writeStored(RAIL_EXPANDED_KEY, JSON.stringify(next));
                        return next;
                      });
                    return (
                      <>
                        {group.label &&
                          (group.collapsible ? (
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={toggleGroup}
                              className={cx(
                                "flex w-auto shrink-0 cursor-pointer items-center gap-1.5 rounded-2lg p-1.5 text-left md:w-full md:gap-1 md:px-2 md:py-1.5",
                                "outline-none transition-colors duration-150 ease hover:bg-background-secondary-hover/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                              )}
                            >
                              <ChevronRight
                                className={cx(
                                  "size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-150 ease",
                                  expanded && "rotate-90",
                                )}
                                aria-hidden
                              />
                              <span className="truncate text-body-medium text-text-secondary">
                                {group.label}
                              </span>
                              {group.showCount && (
                                <span className="ml-auto hidden rounded-full bg-background-secondary-hover px-1.5 text-[11px] leading-4 text-text-tertiary md:block">
                                  {group.items.length}
                                </span>
                              )}
                            </button>
                          ) : (
                            <span className="hidden pl-2 text-body-medium text-text-secondary md:block">
                              {group.label}
                              {group.showCount && (
                                <span className="ml-1.5 rounded-full bg-background-secondary-hover px-1.5 text-[11px] leading-4 text-text-tertiary">
                                  {group.items.length}
                                </span>
                              )}
                            </span>
                          ))}
                        {expanded &&
                          (group.onReorderItems && !searching ? (
                            <SortableNavItems
                              group={group}
                              page={page}
                              onSelect={(key) => {
                                setPage(key);
                                setContentScrolled(false);
                              }}
                            />
                          ) : (
                            <div className="flex w-auto flex-row gap-1 md:w-full md:flex-col">
                              {group.items.map((item) => (
                                <NavButton
                                  key={item.key}
                                  item={item}
                                  selected={item.key === page}
                                  onSelect={(key) => {
                                    setPage(key);
                                    setContentScrolled(false);
                                  }}
                                />
                              ))}
                            </div>
                          ))}
                      </>
                    );
                  })()}
                </div>
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

      {/* Content pane — fixed title row, scrollable page below; the title
          row doubles as a window drag region ("deep": blank spots drag,
          Tauri toggles maximize on double-click, buttons stay clickable). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          data-tauri-drag-region="deep"
          className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3 md:px-8 md:pt-8 select-none"
        >
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="shrink-0 text-title-3-medium text-text-primary">
              {titles[page] ?? page}
            </h2>
            {renderHeaderActions?.(page)}
          </div>
          <button
            type="button"
            aria-label={ariaLabel}
            onClick={onClose}
            className={cx(
              "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full",
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
            onScroll={(e) => setContentScrolled(e.currentTarget.scrollTop > 0)}
          >
            {renderPage(page)}
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
    </div>
  );
}
