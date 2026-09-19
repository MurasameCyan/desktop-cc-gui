import { useEffect } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWeb, startWindowDrag } from "@/lib/platform";

// Interactive elements keep their click behavior; any other press inside the
// strip (empty padding, container wrappers, panel header blanks) starts a
// window drag. data-tauri-drag-region alone only fires when the press lands
// on the element carrying the attribute, never on its children — so the
// nested containers swallowing most of the titlebar could not drag.
const DRAG_IGNORE_SELECTOR = "button, a, input, textarea, select, [role='tab']";

/** Window drag: presses that miss every interactive element start dragging
 * the window (overlay titlebar). Native listener — the drag region is a
 * window-level gesture, not a control with click/keyboard semantics. */
function useWindowDragRegion(stripRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onMouseDown = (e: globalThis.MouseEvent) => {
      // No native titlebar to drag in web-access mode.
      if (isWeb || e.button !== 0) return;
      if ((e.target as HTMLElement).closest(DRAG_IGNORE_SELECTOR)) return;
      e.preventDefault();
      startWindowDrag();
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [stripRef]);
}

/** Vertical wheel drives the horizontal tab scroll (VSCode behavior).
 * Native non-passive listener: React wheel handlers cannot preventDefault. */
function useHorizontalWheelScroll(scrollRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX === 0 && e.deltaY === 0) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef]);
}

/** Keep the active tab in view as tabs stream in/out of the strip. */
function useActiveTabInView(
  scrollRef: RefObject<HTMLDivElement | null>,
  activeKey: string | null,
  tabCount: number,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeKey) return;
    el.querySelector(`[data-tab-key="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollRef, activeKey, tabCount]);
}

/** Roving-tabindex tab list: Arrow keys move focus between tabs (selection
 * still requires Enter/Space, matching the platform tab convention). */
function handleTabListKeyDown(
  scrollRef: RefObject<HTMLDivElement | null>,
  e: KeyboardEvent<HTMLDivElement>,
) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const el = scrollRef.current;
  if (!el) return;
  const tabEls = Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]'));
  const current = tabEls.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  e.preventDefault();
  const next =
    e.key === "ArrowRight"
      ? (current + 1) % tabEls.length
      : (current - 1 + tabEls.length) % tabEls.length;
  tabEls[next]?.focus();
}

/**
 * Chrome behaviors of the tab strip: window drag region, wheel-to-horizontal
 * scroll, active-tab scroll-into-view, and roving-tabindex arrow keys.
 * Returns the handlers the strip's JSX wires up.
 */
export function useTabStripChrome({
  stripRef,
  scrollRef,
  activeKey,
  tabCount,
  customControls,
}: {
  stripRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  activeKey: string | null;
  tabCount: number;
  /** Custom (non-macOS) titlebar buttons are drawn; the strip is the only
   *  caption surface, so double-click toggles maximize. */
  customControls: boolean;
}) {
  useWindowDragRegion(stripRef);
  useHorizontalWheelScroll(scrollRef);
  useActiveTabInView(scrollRef, activeKey, tabCount);

  // Double-click on empty strip space maximizes/restores: the custom Windows
  // titlebar has no native caption, so this is the only titlebar affordance.
  // macOS keeps its native traffic-light/zoom behaviors — untouched.
  const handleStripDoubleClick = (e: ReactMouseEvent) => {
    if (isWeb || !customControls) return;
    if ((e.target as HTMLElement).closest(DRAG_IGNORE_SELECTOR)) return;
    void getCurrentWindow().toggleMaximize();
  };

  return {
    handleStripDoubleClick,
    handleTabListKeyDown: (e: KeyboardEvent<HTMLDivElement>) =>
      handleTabListKeyDown(scrollRef, e),
  };
}
