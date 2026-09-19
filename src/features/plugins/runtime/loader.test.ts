import { describe, expect, it, vi } from "vitest";
import {
  getPluginState,
  getPluginStatesSnapshot,
  loadPlugin,
  reportPluginCrash,
  unloadPlugin,
  type LoaderBackend,
} from "./loader";
import { setCompatSdkEnabled } from "./sdk-compat";
import { commandRegistry, settingsRegistry } from "@ccgui/plugin-sdk";
import type { PluginInfo } from "@/lib/ipc";

function fakeBackend(files: Record<string, string> = {}) {
  const quarantined: string[] = [];
  const backend: LoaderBackend & { quarantined: string[] } = {
    quarantined,
    list: async () => [],
    readFile: async (id, name) => {
      const content = files[`${id}/${name}`];
      if (content === undefined) throw new Error(`no such file ${id}/${name}`);
      return content;
    },
    quarantine: async (id) => void quarantined.push(id),
    setEnabled: async () => {},
    appVersion: async () => "1.0.0",
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    bridgeInvoke: async () => null,
    workspaceMetadata: async () => ({ id: "workspace-id", path: "C:/work" }),
    workspaceList: async () => [],
    pickDirectory: async () => null,
    documentStorageGetLocation: async () => ({
      kind: "data",
      displayPath: "C:/data/plugin",
      writable: true,
    }),
    documentStorageSelectLocation: async (_id, kind, customPath) => ({
      kind,
      displayPath: customPath ?? "C:/data/plugin",
      writable: true,
    }),
    documentStorageReadText: async () => null,
    documentStorageWriteTextAtomic: async () => ({ status: "written", version: "v1" }),
    documentStorageRemove: async () => ({ status: "removed" }),
    documentStorageList: async () => [],
  };
  return backend;
}

function info(id: string, over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id,
    name: id,
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

function builtinManifest(id: string, permissions: string[] = []) {
  return { id, name: id, version: "1.0.0", tier: "js" as const, permissions };
}

describe("loader", () => {
  it("marks a plugin incompatible when its sdkVersion range excludes the host SDK", async () => {
    const backend = fakeBackend();
    let ran = false;
    await loadPlugin(
      {
        info: info("lp-sdk", { source: "builtin" }),
        manifest: { ...builtinManifest("lp-sdk"), sdkVersion: "^0.1" },
        builtinActivate: () => {
          ran = true;
        },
      },
      backend,
    );
    expect(ran).toBe(false);
    expect(getPluginState("lp-sdk")).toBe("incompatible");

    // Absent sdkVersion = "*" — legacy plugins keep loading.
    await loadPlugin(
      {
        info: info("lp-legacy", { source: "builtin" }),
        manifest: builtinManifest("lp-legacy"),
        builtinActivate: () => {
          ran = true;
        },
      },
      backend,
    );
    expect(ran).toBe(true);
    expect(getPluginState("lp-legacy")).toBe("active");
    unloadPlugin("lp-legacy");
  });

  it("loads a legacy ^0.x plugin in 兼容模式 when the opt-in is on", async () => {
    const backend = fakeBackend();
    let ran = false;
    const load = (id: string, sdkVersion = "^0.1") =>
      loadPlugin(
        {
          info: info(id, { source: "builtin" }),
          manifest: { ...builtinManifest(id), sdkVersion },
          builtinActivate: () => {
            ran = true;
          },
        },
        backend,
      );
    const compatMark = (id: string) =>
      getPluginStatesSnapshot().find((entry) => entry.id === id)?.compat;

    // Default: strict semver — the range predates the host's minor, so no.
    await load("lp-compat");
    expect(getPluginState("lp-compat")).toBe("incompatible");
    expect(compatMark("lp-compat")).toBeUndefined();

    setCompatSdkEnabled(true);
    await load("lp-compat");
    expect(ran).toBe(true);
    expect(getPluginState("lp-compat")).toBe("active");
    expect(compatMark("lp-compat")).toBe("^0.1");
    unloadPlugin("lp-compat");
    // The mark describes a load, not an installation.
    expect(compatMark("lp-compat")).toBeUndefined();

    // 兼容模式 never widens a range that asks for a newer line.
    await load("lp-future", "^1.0");
    expect(getPluginState("lp-future")).toBe("incompatible");
    setCompatSdkEnabled(false);
  });

  it("activates a builtin plugin through the context pipeline and unloads cleanly", async () => {
    const backend = fakeBackend();
    let cleaned = false;
    await loadPlugin(
      {
        info: info("lp-builtin", { source: "builtin", permissions: ["ui:settings-section"] }),
        manifest: builtinManifest("lp-builtin", ["ui:settings-section"]),
        builtinActivate: (ctx) => {
          ctx.ui.registerSettingsSection({ label: () => "L", component: () => null });
          return () => {
            cleaned = true;
          };
        },
      },
      backend,
    );
    expect(getPluginState("lp-builtin")).toBe("active");
    expect(settingsRegistry.get("plugin:lp-builtin")).toBeDefined();

    unloadPlugin("lp-builtin");
    expect(cleaned).toBe(true);
    expect(settingsRegistry.get("plugin:lp-builtin")).toBeUndefined();
    expect(getPluginState("lp-builtin")).toBe("installed");
  });

  it("unwinds partial registrations when activate throws after registering", async () => {
    // Regression: a plugin that registered capabilities and THEN threw used
    // to leave its disposers unrun — registry entries (and CSS/listeners)
    // leaked while the plugin showed quarantined.
    const backend = fakeBackend();
    await loadPlugin(
      {
        info: info("lp-leak"),
        manifest: builtinManifest("lp-leak", ["ui:command"]),
        builtinActivate: (ctx) => {
          ctx.ui.registerCommand({ key: "leaked", title: () => "Leaked", run: () => {} });
          throw new Error("boom after register");
        },
      },
      backend,
    );
    expect(getPluginState("lp-leak")).toBe("quarantined");
    expect(commandRegistry.get("plugin:lp-leak:leaked")).toBeUndefined();
  });

  it("quarantines a plugin whose activate throws; next load is skipped", async () => {
    const backend = fakeBackend();
    await loadPlugin(
      {
        info: info("lp-thrower"),
        manifest: builtinManifest("lp-thrower"),
        builtinActivate: () => {
          throw new Error("boom");
        },
      },
      backend,
    );
    expect(getPluginState("lp-thrower")).toBe("quarantined");
    expect(backend.quarantined).toEqual(["lp-thrower"]);

    // A quarantined record is never activated again until re-enabled.
    let ran = false;
    await loadPlugin(
      {
        info: info("lp-thrower", { quarantined: true, lastError: "boom" }),
        manifest: builtinManifest("lp-thrower"),
        builtinActivate: () => {
          ran = true;
        },
      },
      backend,
    );
    expect(ran).toBe(false);
    expect(getPluginState("lp-thrower")).toBe("quarantined");
  });

  it("refuses plugins whose minAppVersion exceeds the host version", async () => {
    const backend = fakeBackend();
    let ran = false;
    await loadPlugin(
      {
        info: info("lp-future", { minAppVersion: "9.9.9" }),
        manifest: builtinManifest("lp-future"),
        builtinActivate: () => {
          ran = true;
        },
      },
      backend,
    );
    expect(ran).toBe(false);
    expect(getPluginState("lp-future")).toBe("incompatible");
  });

  it("loads a declarative plugin from directory files and unloads its CSS", async () => {
    const backend = fakeBackend({
      "lp-css/manifest.json": JSON.stringify({
        id: "lp-css",
        name: "CSS",
        version: "1.0.0",
        tier: "declarative",
        // styles.css is the install-reviewed bundle artifact, injected via
        // injectBundleCss — no theme permission needed.
        permissions: [],
      }),
      "lp-css/styles.css": ".composer-x { border-radius: 12px; }",
    });
    await loadPlugin({ info: info("lp-css", { tier: "declarative" }) }, backend);
    expect(getPluginState("lp-css")).toBe("active");
    expect(
      document.head.querySelector('style[data-plugin="lp-css"]')?.textContent,
    ).toContain("border-radius: 12px");

    unloadPlugin("lp-css");
    expect(document.head.querySelector('style[data-plugin="lp-css"]')).toBeNull();
  });

  it("rejects an invalid manifest and quarantines the plugin", async () => {
    const backend = fakeBackend({
      "lp-bad/manifest.json": JSON.stringify({
        id: "BAD ID",
        name: "x",
        version: "1.0.0",
        tier: "declarative",
        permissions: [],
      }),
    });
    await loadPlugin({ info: info("lp-bad", { tier: "declarative" }) }, backend);
    expect(getPluginState("lp-bad")).toBe("quarantined");
    expect(backend.quarantined).toEqual(["lp-bad"]);
  });

  it("accepts a safe dotted plugin id", async () => {
    const id = "ccgui.client-context-bridge";
    const backend = fakeBackend({
      [`${id}/manifest.json`]: JSON.stringify({
        id,
        name: "Client Context Bridge",
        version: "1.0.0",
        tier: "declarative",
        permissions: [],
      }),
    });

    await loadPlugin({ info: info(id, { tier: "declarative" }) }, backend);
    expect(getPluginState(id)).toBe("active");
    expect(backend.quarantined).toEqual([]);
    unloadPlugin(id);
  });

  it("activates a builtin whose backend record has empty manifest fields (quarantine-upsert regression)", async () => {
    // Rust upserts a state record for builtin ids on quarantine/enable; that
    // record's PluginInfo has version "" / tier "". The loader must trust the
    // builtin's own manifest, not the record.
    const backend = fakeBackend();
    let ran = false;
    await loadPlugin(
      {
        info: info("lp-record", {
          source: "builtin",
          version: "",
          tier: "" as PluginInfo["tier"],
        }),
        manifest: builtinManifest("lp-record"),
        builtinActivate: () => {
          ran = true;
        },
      },
      backend,
    );
    expect(ran).toBe(true);
    expect(getPluginState("lp-record")).toBe("active");
  });

  it("quarantines after the render-crash threshold and unloads the plugin", async () => {
    const backend = fakeBackend();
    await loadPlugin(
      {
        info: info("lp-crasher"),
        manifest: builtinManifest("lp-crasher"),
        builtinActivate: () => {},
      },
      backend,
    );
    expect(getPluginState("lp-crasher")).toBe("active");
    reportPluginCrash("lp-crasher", new Error("1"), backend);
    reportPluginCrash("lp-crasher", new Error("2"), backend);
    expect(getPluginState("lp-crasher")).toBe("active");
    reportPluginCrash("lp-crasher", new Error("3"), backend);
    expect(getPluginState("lp-crasher")).toBe("quarantined");
    expect(backend.quarantined).toEqual(["lp-crasher"]);
  });
});

// Bootstrap flags are module-global; each test gets a fresh loader instance.
async function freshLoader() {
  vi.resetModules();
  return import("./loader");
}

function builtin(id: string, activate?: () => void) {
  return {
    info: info(id, { source: "builtin" as const }),
    manifest: builtinManifest(id),
    builtinActivate: activate ?? (() => {}),
  };
}

describe("bootstrapPlugins", () => {
  it("rejects on backend list failure, still loads builtins, and retries cleanly", async () => {
    const loader = await freshLoader();
    const backend = fakeBackend();
    let listCalls = 0;
    backend.list = async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error("backend not ready");
      return [];
    };

    await expect(loader.bootstrapPlugins(backend, [builtin("bp-a")])).rejects.toThrow(
      "backend not ready",
    );
    // A failed list is transient: builtins still loaded, bootstrap stays
    // re-callable instead of latching "done" with nothing activated.
    expect(loader.getPluginState("bp-a")).toBe("active");
    expect(loader.pluginsBootstrapped()).toBe(false);

    await loader.bootstrapPlugins(backend, [builtin("bp-a")]);
    expect(listCalls).toBe(2);
    expect(loader.pluginsBootstrapped()).toBe(true);
    expect(loader.getPluginState("bp-a")).toBe("active");
  });

  it("keeps loading the remaining plugins when one load rejects", async () => {
    const loader = await freshLoader();
    const backend = fakeBackend();
    // loadPlugin probes the app version before its own error handling; a
    // rejecting probe must not strand the rest of the bootstrap loop.
    let versionCalls = 0;
    backend.appVersion = async () => {
      versionCalls += 1;
      if (versionCalls === 1) throw new Error("version probe failed");
      return "1.0.0";
    };

    await loader.bootstrapPlugins(backend, [builtin("bp-first"), builtin("bp-second")]);
    expect(loader.getPluginState("bp-first")).toBeUndefined();
    expect(loader.getPluginState("bp-second")).toBe("active");
    expect(loader.pluginsBootstrapped()).toBe(true);
  });

  it("shares one in-flight pass between concurrent callers", async () => {
    const loader = await freshLoader();
    const backend = fakeBackend();
    let listCalls = 0;
    const { promise: listResult, resolve: resolveList } =
      Promise.withResolvers<PluginInfo[]>();
    backend.list = async () => {
      listCalls += 1;
      return listResult;
    };

    // Both callers enter before the list resolves: they must share one pass.
    const first = loader.bootstrapPlugins(backend, [builtin("bp-c")]);
    const second = loader.bootstrapPlugins(backend, [builtin("bp-c")]);
    resolveList([]);
    const [a, b] = await Promise.all([first, second]);
    expect(listCalls).toBe(1);
    expect(a).toBe(b);
    expect(loader.getPluginState("bp-c")).toBe("active");
  });
});
