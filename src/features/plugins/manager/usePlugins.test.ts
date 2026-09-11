import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/ipc";
import type { PluginInstallProgress } from "@/lib/events";

const pluginList = vi.fn(async (): Promise<PluginInfo[]> => []);
const pluginInstallFromPath = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    pluginList: () => pluginList(),
    pluginInstallFromPath: (path: string) => pluginInstallFromPath(path),
  },
}));

const pickDirectory = vi.fn(async (_title: string): Promise<string | null> => "/tmp/plugin");
vi.mock("@/lib/platform", () => ({
  pickDirectory: (title: string) => pickDirectory(title),
}));

let progressCb: ((p: PluginInstallProgress) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@/lib/events", () => ({
  listenPluginInstallProgress: vi.fn(async (cb: (p: PluginInstallProgress) => void) => {
    progressCb = cb;
    return unlisten;
  }),
}));

const loadPlugin = vi.fn(async (_args: unknown) => {});
vi.mock("../runtime/loader", () => ({
  bootstrapPlugins: vi.fn(async () => []),
  getPluginStatesSnapshot: () => [],
  ipcBackend: {},
  loadPlugin: (args: unknown) => loadPlugin(args),
  // Already bootstrapped: refresh() under test never re-kicks bootstrap.
  pluginsBootstrapped: () => true,
  prunePluginRuntimeState: vi.fn(),
  subscribePluginStates: () => () => {},
  unloadPlugin: vi.fn(),
}));

vi.mock("../builtin", () => ({ BUILTIN_PLUGINS: [] }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));

// vi.mock calls above are hoisted, so this static import sees the mocks.
import { usePluginsStore } from "./usePlugins";

function info(over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "",
    author: "",
    tier: "js",
    source: "local",
    enabled: true,
    quarantined: false,
    lastError: null,
    permissions: [],
    installedAt: 0,
    minAppVersion: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  progressCb = null;
  usePluginsStore.setState({ installed: [], loaded: false, error: null, installing: null });
});

describe("installFromDirectory", () => {
  it("tracks copy progress and clears it when the install resolves", async () => {
    const gate = Promise.withResolvers<PluginInfo>();
    pluginInstallFromPath.mockReturnValue(gate.promise);

    const pending = usePluginsStore.getState().installFromDirectory();
    await vi.waitFor(() => expect(progressCb).not.toBeNull());
    expect(usePluginsStore.getState().installing).toEqual({ done: 0, total: 0 });

    progressCb!({ done: 5, total: 10, finished: false });
    expect(usePluginsStore.getState().installing).toEqual({ done: 5, total: 10 });

    gate.resolve(info());
    await pending;
    expect(usePluginsStore.getState().installing).toBeNull();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(loadPlugin).toHaveBeenCalledOnce();
    expect(pluginList).toHaveBeenCalled();
  });

  it("clears the installing state and surfaces the error when install fails", async () => {
    pluginInstallFromPath.mockRejectedValue(new Error("bad manifest"));

    await usePluginsStore.getState().installFromDirectory();

    expect(usePluginsStore.getState().installing).toBeNull();
    expect(usePluginsStore.getState().error).toContain("bad manifest");
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("does nothing when the picker is cancelled", async () => {
    pickDirectory.mockResolvedValueOnce(null);

    await usePluginsStore.getState().installFromDirectory();

    expect(usePluginsStore.getState().installing).toBeNull();
    expect(pluginInstallFromPath).not.toHaveBeenCalled();
  });
});
