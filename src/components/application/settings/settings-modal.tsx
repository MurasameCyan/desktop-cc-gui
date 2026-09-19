"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import X from "lucide-react/dist/esm/icons/x";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { DisplayName } from "@/components/base/display-name";
import {
  WorkspaceSortableList,
  type RepoDragChrome,
} from "@/components/application/ai-chat/workspace-sortable-list";
import { cx } from "@/utils/cx";
import { useBrowserOcclusion } from "@/features/browser/occlusion";

/**
 * Figma sources: Board UI → "Settings/Profile" (node 4081:13943) and
 * "Settings/General" (node 4079:13037).
 *
 * The app-wide settings modal, opened from the sidebar's "Settings" item.
 * The shell is content-agnostic: nav groups, page titles, and page bodies
 * come in as props so feature code owns the actual settings.
 *
 * Shell (1:1 with Figma except the panel size — user asked for a larger modal):
 *   backdrop  overlay-backdrop scrim token.
 *   panel     1120×720 (capped at viewport − 64px), radius/3xl (24px), shadow/xs.
 *   rail      254px, bg background/secondary, 1px right border, p 10 —
 *             same group/item recipe as the board-team dropdown menus
 *             (label pl-8, items p-8 radius/2lg icon-20 + body-medium),
 *             selected row bg background/secondary/hover.
 *   content   px 32 (274 + 32 = Figma's 306 title inset), title row fixed,
 *             the page itself scrolls when taller than the shell.
 *
 * Built on react-aria's Modal/ModalOverlay/Dialog — the same stack as
 * components/dialogs.tsx — which owns role/aria-modal, the focus trap,
 * Escape and backdrop dismissal, and portalling. Open/close animation: the
 * panel fades + blurs in from scale 0.85 (300ms), the backdrop cross-fades;
 * the same transition plays in reverse on close via data-entering/exiting,
 * and react-aria keeps the modal mounted until the exit transition finishes.
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
  /** Muted group heading; omit for an unlabeled group. */
  label?: string;
  /** Collapsible rail section (the 未启用 CLI bucket): the heading becomes a
   *  chevron toggle, items stay hidden until expanded, and a selected page
   *  inside force-expands the group. Starts collapsed. */
  collapsible?: boolean;
  /** When set, the group's items render as a drag-sortable list (the item
   *  icon becomes the grip, md+ vertical rail only) and a drop reports the
   *  new key order. */
  onReorderItems?: (orderedKeys: string[]) => void;
  /** aria-label/title for the drag grip; required with onReorderItems. */
  dragHandleLabel?: string;
  items: SettingsNavItem[];
}

export interface SettingsModalProps {
  /** Controlled open state, owned by the host page, sidebar, or menu. */
  isOpen: boolean;
  /** Called by the backdrop, close button, and Escape key. */
  onClose: () => void;
  /** Page selected each time the modal opens. */
  defaultPage?: string;
  /** Dialog label (visible title row uses the page title). */
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
        <DisplayName name={item.label} />
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
                <DisplayName name={item.label} />
              </span>
            </button>
          </div>
        );
      }}
    />
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  defaultPage,
  ariaLabel,
  groups,
  titles,
  renderPage,
  renderHeaderActions,
}: SettingsModalProps) {
  const firstKey = groups[0]?.items[0]?.key ?? "general";
  // The modal renders above any surface, including the native browser
  // webview — which must hide for HTML to paint over it.
  useBrowserOcclusion(isOpen);
  /** Page the modal resets to on open. */
  const openPage = defaultPage ?? firstKey;
  const [page, setPage] = useState<string>(openPage);

  // Top fade over the scrolling page so rows dissolve under the title row
  // instead of cutting sharply (same recipe as the medical alerts feed).
  const [contentScrolled, setContentScrolled] = useState(false);
  /** Collapsed state per collapsible group (keyed by its rail key); absent =
   *  collapsed, which is the default for those groups. */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );

  // Reset to the default page each time the modal opens. defaultPage/firstKey
  // only matter at the open transition, so the effect stays keyed on isOpen
  // and reads the latest target through a ref — listing them as deps would
  // reset the page mid-session if the host recomputed groups/defaultPage.
  const openPageRef = useRef(openPage);
  useEffect(() => {
    openPageRef.current = openPage;
  }, [openPage]);
  useEffect(() => {
    if (isOpen) setPage(openPageRef.current);
  }, [isOpen]);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={cx(
        "fixed inset-0 z-100 flex items-center justify-center p-4 bg-overlay-backdrop",
        "transition-opacity duration-300 ease-out",
        "data-[entering]:opacity-0 data-[exiting]:opacity-0",
      )}
    >
      <Modal
        isDismissable
        className={cx(
          "relative",
          // Kept light on purpose: an 8px blur over the full 871×614 panel
          // forces a huge re-filter every frame of the scale-down, which is
          // what made the close stutter. 4px + GPU promotion stays smooth.
          "transform-gpu transition-[opacity,transform,filter] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-[opacity,transform,filter]",
          "data-[entering]:scale-[0.85] data-[entering]:opacity-0 data-[entering]:blur-[4px]",
          "data-[exiting]:scale-[0.85] data-[exiting]:opacity-0 data-[exiting]:blur-[4px]",
        )}
      >
        <Dialog
          aria-label={ariaLabel}
          className={cx(
            "relative flex h-[720px] max-h-[calc(100dvh-64px)] w-[1120px] max-w-[calc(100vw-64px)] flex-col md:flex-row",
            // overflow-CLIP, not hidden: hidden boxes are still programmatically
            // scrollable, so focusing a switch's hidden input in a row clipped
            // by the inner scroller made the browser scroll-reveal it through
            // the panel too — shifting the whole modal content up with no way
            // back. clip forbids scrolling outright.
            "overflow-clip rounded-3xl bg-background-full shadow-xs outline-none",
          )}
        >
          {/* Nav rail — the board-team dropdown group/item recipe */}
          <nav
            aria-label={ariaLabel}
            className="flex w-full shrink-0 flex-row gap-5 overflow-x-auto border-b border-separator-border bg-background-secondary-default p-2.5 md:w-[254px] md:flex-col md:gap-5 md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0"
          >
            {groups.map((group, groupIndex) => (
              <div
                key={group.label ?? groupIndex}
                className="flex w-auto shrink-0 flex-row gap-1.5 pt-1 md:w-full md:flex-col"
              >
                {(() => {
                  const groupKey = group.label ?? String(groupIndex);
                  // A selected page inside a collapsed group force-expands it
                  // so the current row never hides under the chevron.
                  const expanded =
                    !group.collapsible ||
                    (expandedGroups[groupKey] ?? false) ||
                    group.items.some((item) => item.key === page);
                  return (
                    <>
                      {group.label &&
                        (group.collapsible ? (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() =>
                              setExpandedGroups((prev) => ({
                                ...prev,
                                [groupKey]: !(
                                  expandedGroups[groupKey] ?? false
                                ),
                              }))
                            }
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
                          </button>
                        ) : (
                          <span className="hidden pl-2 text-body-medium text-text-secondary md:block">
                            {group.label}
                          </span>
                        ))}
                      {expanded &&
                        (group.onReorderItems ? (
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
            ))}
          </nav>

          {/* Content pane — fixed title row, scrollable page below */}
          <div className="flex min-w-0 min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between px-4 pt-4 pb-3 md:px-8 md:pt-8">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="shrink-0 text-title-3-medium text-text-primary">
                  <DisplayName name={titles[page] ?? page} />
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
                onScroll={(e) =>
                  setContentScrolled(e.currentTarget.scrollTop > 0)
                }
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
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
