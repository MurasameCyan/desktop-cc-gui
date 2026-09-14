import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScrollFollow, type ScrollFollow } from "./use-scroll-follow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no PointerEvent constructor; the handlers read type, pointerType
 *  and offsets, so a MouseEvent with those fields filled in is the closest
 *  stand-in. */
function pointerEvent(
  type: string,
  init: { pointerType?: string; offsetX?: number; offsetY?: number },
) {
  const ev = new MouseEvent(type, { bubbles: true });
  Object.assign(ev, init);
  return ev;
}

/** The hook throttles scroll handling through rAF and the stub would recurse
 *  into itself if it ran the callback inline; queue frames and flush them
 *  explicitly instead. */
let pendingFrames: FrameRequestCallback[] = [];

function flushFrames() {
  const queued = pendingFrames;
  pendingFrames = [];
  for (const cb of queued) cb(0);
}

describe("useScrollFollow touch intent", () => {
  let container: HTMLDivElement;
  let root: Root;
  let el: HTMLDivElement;
  let geometry: { scrollHeight: number; clientHeight: number; scrollTop: number };
  let follow: ScrollFollow;

  beforeEach(() => {
    pendingFrames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      pendingFrames.push(cb);
      return pendingFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    geometry = { scrollHeight: 5000, clientHeight: 600, scrollTop: 4400 };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount() {
    function Probe() {
      const scrollRef = { current: el };
      follow = useScrollFollow({ scrollRef });
      return null;
    }
    el = document.createElement("div");
    Object.defineProperties(el, {
      scrollHeight: { get: () => geometry.scrollHeight, configurable: true },
      clientHeight: { get: () => geometry.clientHeight, configurable: true },
      scrollTop: {
        get: () => geometry.scrollTop,
        set: (v: number) => {
          geometry.scrollTop = v;
        },
        configurable: true,
      },
    });
    container.appendChild(el);
    act(() => {
      root.render(createElement(Probe));
    });
  }

  /** One step of a finger drag: the browser emits a scroll event as the content
   *  moves under the finger. */
  function scrollTo(to: number) {
    geometry.scrollTop = to;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      flushFrames();
    });
  }

  /** A finger drag: pointerdown with pointerType touch, the scroll events, then
   *  the lift. */
  function touchDrag(to: number) {
    act(() => {
      el.dispatchEvent(pointerEvent("pointerdown", { pointerType: "touch" }));
    });
    scrollTo(to);
    act(() => {
      el.dispatchEvent(pointerEvent("pointerup", { pointerType: "touch" }));
    });
  }

  it("pauses following when a finger drags up into history", () => {
    mount();
    expect(follow.isFollowing()).toBe(true);

    touchDrag(3000);

    expect(follow.isFollowing()).toBe(false);
  });

  it("resumes following when a finger drags back down to the tail", () => {
    mount();
    touchDrag(3000);
    expect(follow.isFollowing()).toBe(false);

    // Back within the bottom threshold.
    touchDrag(4450);

    expect(follow.isFollowing()).toBe(true);
  });

  it("holds the gesture through momentum after the finger lifts", () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      el.dispatchEvent(pointerEvent("pointerdown", { pointerType: "touch" }));
    });
    scrollTo(3000);
    act(() => {
      el.dispatchEvent(pointerEvent("pointerup", { pointerType: "touch" }));
    });

    // Inertial scrolling is still moving the list, well after the lift.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    scrollTo(2000);

    expect(follow.isFollowing()).toBe(false);

    // Once the list settles, a later virtualizer measurement shift must not
    // read as intent and re-follow the tail.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    scrollTo(2100);

    expect(follow.isFollowing()).toBe(false);
  });
});
