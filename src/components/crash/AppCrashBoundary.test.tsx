import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import i18n from "@/lib/i18n";
import { AppCrashBoundary } from "./AppCrashBoundary";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Boom(): never {
  throw new Error("render exploded");
}

describe("AppCrashBoundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // React logs caught render errors; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.appMounted;
  });

  it("renders the crash reason instead of a blank screen", () => {
    act(() => {
      root.render(
        <AppCrashBoundary>
          <Boom />
        </AppCrashBoundary>,
      );
    });

    expect(host.textContent).toContain(i18n.t("crash.title"));
    expect(host.textContent).toContain("render exploded");
    // Copy/reload affordances are present.
    expect(host.textContent).toContain(i18n.t("crash.reload"));
    // A successful boundary mount flips the boot watchdog marker.
    expect(document.documentElement.dataset.appMounted).toBe("1");
  });

  it("renders children while healthy", () => {
    act(() => {
      root.render(
        <AppCrashBoundary>
          <span>healthy</span>
        </AppCrashBoundary>,
      );
    });
    expect(host.textContent).toContain("healthy");
  });
});
