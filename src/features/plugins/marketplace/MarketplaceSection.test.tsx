import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketPlugin } from "@/lib/ipc";

const pluginFetchIndex = vi.fn(async (_force?: boolean): Promise<MarketPlugin[]> => []);
const pluginCheckUpdates = vi.fn(async () => []);
const pluginInstallFromMarketplace = vi.fn(async (_id: string) => {
  throw new Error("not used in these tests");
});
const pluginList = vi.fn(async () => []);
vi.mock("@/lib/ipc", () => ({
  ipc: {
    pluginFetchIndex: (force?: boolean) => pluginFetchIndex(force),
    pluginCheckUpdates: () => pluginCheckUpdates(),
    pluginInstallFromMarketplace: (id: string) => pluginInstallFromMarketplace(id),
    pluginList: () => pluginList(),
  },
}));
vi.mock("@/lib/events", () => ({
  listenPluginInstallProgress: vi.fn(async () => () => {}),
}));
const openExternal = vi.fn((_url: string) => {});
vi.mock("@/lib/platform", () => ({
  isWeb: false,
  openExternal: (url: string) => openExternal(url),
  pickDirectory: vi.fn(async () => null),
}));
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
import MarketplaceSection from "./MarketplaceSection";
import { usePluginsStore } from "../manager/usePlugins";
import { useMarketplaceStore } from "./store";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DOWNLOADS = 47;

const ENTRY: MarketPlugin = {
  id: "react-doctor",
  repo: "zhukunpenglinyutong/ccgui-plugin-react-doctor",
  name: "React Doctor",
  description: "",
  author: "zhukunpenglinyutong",
  tier: "js",
  version: "0.2.0",
  minAppVersion: "1.0.0",
  sdkVersion: "^0.3",
  permissions: [],
  downloads: DOWNLOADS,
};

function downloadsBadge(): HTMLElement | null {
  return document.body.querySelector(
    `span[title="${i18n.t("plugins.market.downloads", { count: DOWNLOADS })}"]`,
  );
}

function repoButton(): HTMLButtonElement {
  const button = document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="${i18n.t("plugins.market.viewRepo")}"]`,
  );
  if (!button) throw new Error("repo button not found");
  return button;
}

describe("MarketplaceSection repo link and download stats", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginFetchIndex.mockImplementation(async () => [ENTRY]);
    usePluginsStore.setState({ installed: [], loaded: false, error: null, installing: null });
    useMarketplaceStore.setState({
      entries: [],
      loaded: false,
      error: null,
      updates: [],
      installing: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    root = null;
  });

  async function render() {
    await act(async () => {
      root!.render(<MarketplaceSection />);
    });
  }

  it("shows the download badge when the index provides a count", async () => {
    await render();
    const badge = downloadsBadge();
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain(DOWNLOADS.toLocaleString());
  });

  it("hides the download badge when stats are unavailable", async () => {
    pluginFetchIndex.mockImplementation(async () => [{ ...ENTRY, downloads: null }]);
    await render();
    expect(downloadsBadge()).toBeNull();
  });

  it("opens the plugin's GitHub repo from the row", async () => {
    await render();
    await act(async () => {
      repoButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openExternal).toHaveBeenCalledWith(`https://github.com/${ENTRY.repo}`);
  });
  it("opens the development guide in a dialog from the compact entry", async () => {
    await render();
    // The long tutorial stays out of the page until the entry is clicked.
    expect(document.body.textContent).not.toContain(i18n.t("plugins.market.localTitle"));
    const entry = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === i18n.t("plugins.market.developGuide"),
    );
    expect(entry).toBeDefined();
    await act(async () => {
      entry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // ModalShell portals to document.body.
    expect(document.body.textContent).toContain(i18n.t("plugins.market.developTitle"));
    expect(document.body.textContent).toContain(i18n.t("plugins.market.localTitle"));
    expect(document.body.textContent).toContain(i18n.t("plugins.market.submitTitle"));
  });
});
