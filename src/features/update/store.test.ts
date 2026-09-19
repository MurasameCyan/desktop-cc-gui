import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => checkMock(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@/lib/transport", () => ({ isWeb: false }));
vi.mock("@/lib/platform", () => ({ getAppVersion: async () => "1.0.5" }));

// vi.mock calls above are hoisted, so this static import sees the mocks.
import { useUpdateStore } from "./store";

function reset() {
  useUpdateStore.setState({
    stage: "idle",
    version: undefined,
    latestVersion: undefined,
    latestPubDate: undefined,
    error: undefined,
    downloadedBytes: 0,
    totalBytes: undefined,
  });
  invokeMock.mockReset();
  checkMock.mockReset();
}

describe("checkForUpdates no-update feedback", () => {
  beforeEach(reset);

  it("interactive check with no update reports the latest release version and date", async () => {
    checkMock.mockResolvedValue(null);
    invokeMock.mockResolvedValue({ version: "1.0.5", pubDate: "2026-09-18T04:13:02Z" });

    await useUpdateStore.getState().checkForUpdates({ interactive: true });

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("latest");
    expect(state.latestVersion).toBe("1.0.5");
    expect(state.latestPubDate).toBe("2026-09-18T04:13:02Z");
    expect(invokeMock).toHaveBeenCalledWith("fetch_latest_release_info", undefined);
  });

  it("keeps the latest result visible instead of auto-resetting to idle", async () => {
    vi.useFakeTimers();
    try {
      checkMock.mockResolvedValue(null);
      invokeMock.mockResolvedValue({ version: "1.0.5", pubDate: null });

      await useUpdateStore.getState().checkForUpdates({ interactive: true });
      // The old 2s auto-reset made the feedback vanish; any scheduled reset
      // timer would fire here.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(useUpdateStore.getState().stage).toBe("latest");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the bare message when the manifest probe fails", async () => {
    checkMock.mockResolvedValue(null);
    invokeMock.mockRejectedValue(new Error("offline"));

    await useUpdateStore.getState().checkForUpdates({ interactive: true });

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("latest");
    expect(state.latestVersion).toBeUndefined();
  });

  it("silent background checks stay silent and skip the manifest probe", async () => {
    checkMock.mockResolvedValue(null);

    await useUpdateStore.getState().checkForUpdates();

    expect(useUpdateStore.getState().stage).toBe("idle");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reuses the update handle's version/date when the endpoint points at the running release", async () => {
    checkMock.mockResolvedValue({
      version: "v1.0.5",
      date: "2026-09-17T00:00:00Z",
      close: vi.fn(),
    });

    await useUpdateStore.getState().checkForUpdates({ interactive: true });

    const state = useUpdateStore.getState();
    expect(state.stage).toBe("latest");
    expect(state.latestVersion).toBe("1.0.5");
    expect(state.latestPubDate).toBe("2026-09-17T00:00:00Z");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
