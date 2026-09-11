import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "@/lib/ipc";

const pluginList = vi.fn(async (): Promise<PluginInfo[]> => []);
const pluginUninstall = vi.fn(async (_id: string, _deleteData: boolean) => {});
vi.mock("@/lib/ipc", () => ({
  ipc: {
    pluginList: () => pluginList(),
    pluginUninstall: (id: string, deleteData: boolean) => pluginUninstall(id, deleteData),
  },
}));
vi.mock("@/lib/events", () => ({
  listenPluginInstallProgress: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/platform", () => ({ pickDirectory: vi.fn(async () => null) }));
// Stable empty snapshot: useSyncExternalStore loops forever on a fresh [].
const STATES_SNAPSHOT: never[] = [];
vi.mock("../runtime/loader", () => ({
  bootstrapPlugins: vi.fn(async () => []),
  getPluginStatesSnapshot: () => STATES_SNAPSHOT,
  ipcBackend: {},
  loadPlugin: vi.fn(async () => {}),
  pluginsBootstrapped: () => true,
  prunePluginRuntimeState: vi.fn(),
  subscribePluginStates: () => () => {},
  unloadPlugin: vi.fn(),
}));
vi.mock("../builtin", () => ({ BUILTIN_PLUGINS: [] }));

import i18n from "@/lib/i18n";
import PluginsSection from "./PluginsSection";
import { usePluginsStore } from "./usePlugins";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN: PluginInfo = {
  id: "hello-plugin",
  name: "Hello Plugin",
  version: "0.1.0",
  description: "",
  author: "",
  tier: "js",
  source: "local",
  enabled: false,
  quarantined: false,
  lastError: null,
  permissions: [],
  installedAt: 0,
  minAppVersion: null,
};

function bodyButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("PluginsSection uninstall flow", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(async () => {
    pluginList.mockReset();
    pluginUninstall.mockReset();
    pluginList.mockImplementation(async () => [PLUGIN]);
    usePluginsStore.setState({ installed: [], loaded: false, error: null, installing: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PluginsSection />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = null;
  });

  function trashButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${i18n.t("plugins.uninstall")}"]`,
    );
    if (!button) throw new Error("trash button not found");
    return button;
  }

  it("keeps the row untouched when the confirm is cancelled", async () => {
    await click(trashButton());
    expect(document.body.textContent).toContain(
      i18n.t("plugins.uninstallConfirm", { name: PLUGIN.name }),
    );
    await click(bodyButton(i18n.t("common.cancel")));
    expect(pluginUninstall).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      i18n.t("plugins.uninstallConfirm", { name: PLUGIN.name }),
    );
  });

  it("uninstalls on confirm, always keeping saved data", async () => {
    await click(trashButton());
    await click(bodyButton(i18n.t("common.confirm")));
    expect(pluginUninstall).toHaveBeenCalledWith(PLUGIN.id, false);
  });
});
