import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUsePermissionStatus } from "@/lib/ipc";

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(async () => {}),
  startAppDrag: vi.fn(async () => {}),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { computerUseOpenPermissionSettings: mocks.openSettings },
}));
// The drag plugin talks to the native layer; the card only needs the call
// to fire, not a real OS drag.
vi.mock("./start-app-drag", () => ({ startAppDrag: mocks.startAppDrag }));
const { openSettings, startAppDrag } = mocks;

import { ComputerUsePermissionCard } from "./ComputerUsePermissionCard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const status = (over: Partial<ComputerUsePermissionStatus>): ComputerUsePermissionStatus => ({
  accessibility: false,
  screenRecording: false,
  osPermissionsRequired: true,
  ...over,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  openSettings.mockClear();
  startAppDrag.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const text = () => host.textContent ?? "";

describe("ComputerUsePermissionCard", () => {
  it("shows granted badges for both grants and no authorize buttons", async () => {
    await act(async () => {
      root.render(
        <ComputerUsePermissionCard status={status({ accessibility: true, screenRecording: true })} />,
      );
    });
    expect(text()).toContain("computerUse.granted");
    expect(text()).not.toContain("computerUse.authorize");
    // 拖拽授权卡片始终可用（已授权用户也可能需要重新授权）。
    expect(text()).toContain("computerUse.dragCard");
  });

  it("routes each authorize button to its System Settings pane", async () => {
    await act(async () => {
      root.render(<ComputerUsePermissionCard status={status({})} />);
    });
    const buttons = Array.from(host.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("computerUse.authorize"),
    );
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0].click();
    });
    expect(openSettings).toHaveBeenCalledWith("accessibility");
    await act(async () => {
      buttons[1].click();
    });
    expect(openSettings).toHaveBeenCalledWith("screenRecording");
  });

  it("starts the app drag from the accessory card", async () => {
    await act(async () => {
      root.render(<ComputerUsePermissionCard status={status({})} />);
    });
    const dragCard = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("computerUse.dragCard"),
    );
    expect(dragCard).toBeTruthy();
    await act(async () => {
      dragCard!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(startAppDrag).toHaveBeenCalled();
  });

  it("collapses to a no-grant note on platforms without TCC", async () => {
    await act(async () => {
      root.render(
        <ComputerUsePermissionCard status={status({ osPermissionsRequired: false })} />,
      );
    });
    expect(text()).toContain("computerUse.noPermissionNeeded");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
});
