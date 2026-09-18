import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { SessionTabItem } from "./SessionTab";

/** Pointer-driven tab drag-reorder: dragged key lives in a ref, the
 * insertion point in state so the indicator bar follows the pointer.
 * Pointer events, not HTML5 DnD: WKWebView never delivers dragover/drop, so
 * native DnD only reordered in Chromium. A 5px threshold keeps plain clicks
 * intact. */
export function useTabDragReorder(
  onReorder?: (draggedKey: string, targetKey: string, before: boolean) => void,
) {
  const dragStateRef = useRef<{ key: string; startX: number; dragging: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    draggedKey: string;
    key: string;
    before: boolean;
  } | null>(null);
  // pointerup fires before click; swallow the click that ends a drag.
  const suppressClickRef = useRef(false);

  function handleTabPointerDown(tab: SessionTabItem) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!onReorder || e.button !== 0) return;
      // Dragging from the close button feels broken; keep it click-only.
      if ((e.target as HTMLElement).closest("button")) return;
      dragStateRef.current = { key: tab.key, startX: e.clientX, dragging: false };
    };
  }

  useEffect(() => {
    if (!onReorder) return;
    const DRAG_THRESHOLD = 5;
    const targetAt = (x: number, y: number, excludeKey: string) => {
      const el = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-tab-key]");
      const key = el?.dataset.tabKey;
      if (!el || !key || key === excludeKey) return null;
      const rect = el.getBoundingClientRect();
      return { key, before: x < rect.left + rect.width / 2 };
    };
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.dragging) {
        if (Math.abs(e.clientX - st.startX) < DRAG_THRESHOLD) return;
        st.dragging = true;
      }
      const target = targetAt(e.clientX, e.clientY, st.key);
      setDropTarget((prev) => {
        const next = target ? { draggedKey: st.key, ...target } : null;
        return prev?.key === next?.key &&
          prev?.before === next?.before &&
          prev?.draggedKey === next?.draggedKey
          ? prev
          : next;
      });
    };
    const onUp = (e: PointerEvent) => {
      const st = dragStateRef.current;
      dragStateRef.current = null;
      setDropTarget(null);
      if (!st?.dragging) return;
      suppressClickRef.current = true;
      // The click ending the drag fires right after pointerup — but when
      // the press lands on one tab and releases on another, it targets
      // their container instead, never reaching a tab's onClick. Clear the
      // flag on the next task so it can't swallow a later genuine click.
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      const target = targetAt(e.clientX, e.clientY, st.key);
      if (target) onReorder(st.key, target.key, target.before);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onReorder]);

  return { dropTarget, suppressClickRef, handleTabPointerDown };
}
