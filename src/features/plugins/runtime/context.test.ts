import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createPluginContext,
  DocumentStorageConflictError,
  injectBundleCss,
  type PluginContextBackend,
} from "./context";
import type { PluginContext } from "@ccgui/plugin-sdk";
import {
  addMenuRegistry,
  commandRegistry,
  composerSlotRegistry,
  markdownRegistry,
  pageRegistry,
  panelTabRegistry,
  settingsRegistry,
  statusBarRegistry,
  timelineRowRegistry,
} from "@ccgui/plugin-sdk";
import { pluginBus } from "./events";
import type { PluginManifest } from "@ccgui/plugin-sdk";
import { dispatchSessionCreated, dispatchRuntimeEvent } from "./hooks";

function fakeStorage(): PluginContextBackend & {
  data: Map<string, unknown>;
  bridgeInvoke: Mock;
  workspaceMetadata: Mock;
  pickDirectory: Mock;
  documentStorageGetLocation: Mock;
  documentStorageSelectLocation: Mock;
  documentStorageReadText: Mock;
  documentStorageWriteTextAtomic: Mock;
  documentStorageRemove: Mock;
  documentStorageList: Mock;
} {
  const data = new Map<string, unknown>();
  return {
    data,
    bridgeInvoke: vi.fn(async () => null),
    get: async (id, key) => data.get(`${id}:${key}`) ?? null,
    set: async (id, key, value) => void data.set(`${id}:${key}`, value),
    delete: async (id, key) => void data.delete(`${id}:${key}`),
    workspaceMetadata: vi.fn(async () => ({ id: "workspace-id", path: "C:/work" })),
    pickDirectory: vi.fn(async () => "C:/chosen"),
    documentStorageGetLocation: vi.fn(async () => ({
      kind: "data" as const,
      displayPath: "C:/data/plugin-data/test-plugin",
      writable: true,
    })),
    documentStorageSelectLocation: vi.fn(async (_id, kind, customPath) => ({
      kind,
      displayPath: `${customPath ?? "C:/data"}/plugin-data/test-plugin`,
      writable: true,
    })),
    documentStorageReadText: vi.fn(async () => ({ content: "saved", version: "v1" })),
    documentStorageWriteTextAtomic: vi.fn(async () => ({
      status: "written" as const,
      version: "v2",
    })),
    documentStorageRemove: vi.fn(async () => ({ status: "removed" as const })),
    documentStorageList: vi.fn(async () => ["one.txt"]),
  };
}

function manifest(permissions: string[]): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    tier: "js",
    permissions,
  };
}

describe("createPluginContext", () => {
  it("registers a settings section under plugin:<id> and the disposer removes it", () => {
    const { ctx } = createPluginContext(manifest(["ui:settings-section"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    const dispose = ctx.ui.registerSettingsSection({
      label: () => "Test",
      component: () => null,
    });
    expect(settingsRegistry.get("plugin:test-plugin")).toBeDefined();
    dispose();
    expect(settingsRegistry.get("plugin:test-plugin")).toBeUndefined();
  });

  it("rejects capability use that the manifest did not declare", () => {
    const { ctx } = createPluginContext(manifest([]), fakeStorage(), { appVersion: "1.0.0" });
    expect(() =>
      ctx.ui.registerAddMenuRow({ label: () => "x", onSelect: () => {} }),
    ).toThrow(/ui:add-menu/);
    expect(() => ctx.theme.injectCss(".a{}")).toThrow(/theme/);
    return expect(ctx.storage.get("k")).rejects.toThrow(/storage/);
  });

  it("storage round-trips through the backend in the plugin's namespace", async () => {
    const backend = fakeStorage();
    const { ctx } = createPluginContext(manifest(["storage"]), backend, { appVersion: "1.0.0" });
    await ctx.storage.set("k", { n: 1 });
    expect(backend.data.get("test-plugin:k")).toEqual({ n: 1 });
    expect(await ctx.storage.get("k")).toEqual({ n: 1 });
    await ctx.storage.delete("k");
    expect(await ctx.storage.get("k")).toBeNull();
  });

  it("theme.injectCss mounts a tagged <style> and its disposer removes it", () => {
    const { ctx } = createPluginContext(manifest(["theme"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    const dispose = ctx.theme.injectCss(".composer { border-color: red; }");
    const node = document.head.querySelector('style[data-plugin="test-plugin"]');
    expect(node?.textContent).toContain("border-color: red");
    // Theme-API CSS stays unlayered: token overrides must beat the host's
    // unlayered :root/.dark token definitions.
    expect(node?.textContent).not.toContain("@layer");
    dispose();
    expect(document.head.querySelector('style[data-plugin="test-plugin"]')).toBeNull();
  });

  it("theme.setTokens emits :root and .dark blocks and rejects non-token keys", () => {
    const { ctx } = createPluginContext(manifest(["theme"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    const dispose = ctx.theme.setTokens({
      light: { "--color-text-primary": "red" },
      dark: { "--color-text-primary": "blue" },
    });
    const css = document.head.querySelector('style[data-plugin="test-plugin"]')?.textContent ?? "";
    expect(css).toContain(":root { --color-text-primary: red;");
    expect(css).toContain(".dark { --color-text-primary: blue;");
    expect(() => ctx.theme.setTokens({ light: { color: "red" } })).toThrow(/--/);
    dispose();
  });

  it("injectCss rejects remote references (plan §8 gate rule)", () => {
    const { ctx } = createPluginContext(manifest(["theme"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    expect(() => ctx.theme.injectCss('@import url("https://evil.com/x.css");')).toThrow(/remote/);
    expect(() => ctx.theme.injectCss(".a { background: url(https://evil.com/x.png); }")).toThrow(
      /remote/,
    );
  });

  it("events.on delivers bus emissions and the disposer unsubscribes", () => {
    const { ctx } = createPluginContext(manifest(["events"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    const seen: unknown[] = [];
    const dispose = ctx.events.on("t://opic", (d) => seen.push(d));
    pluginBus.emit("t://opic", 1);
    dispose();
    pluginBus.emit("t://opic", 2);
    expect(seen).toEqual([1]);
  });

  it("events.emit is confined to the plugin's own and shared plugin- topics", () => {
    const { ctx } = createPluginContext(manifest(["events"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    // Own namespace and shared plugin-* topics are fine.
    const seen: unknown[] = [];
    const offOwn = pluginBus.on("plugin:test-plugin:ping", (d) => seen.push(d));
    const offShared = pluginBus.on("plugin-config://changed", (d) => seen.push(d));
    ctx.events.emit("plugin:test-plugin:ping", 1);
    ctx.events.emit("plugin-config://changed", { pluginId: "test-plugin", key: "k", value: 2 });
    expect(seen).toEqual([1, { pluginId: "test-plugin", key: "k", value: 2 }]);
    offOwn();
    offShared();

    // Host topics and other plugins' namespaces throw.
    expect(() => ctx.events.emit("usage://updated", {})).toThrow(/may not emit/);
    expect(() => ctx.events.emit("composer://draft", {})).toThrow(/may not emit/);
    expect(() => ctx.events.emit("plugin:other-plugin:ping", 1)).toThrow(/may not emit/);
  });

  it("accumulates every registration on the handle's disposer stack", () => {
    const handle = createPluginContext(
      manifest(["ui:settings-section", "ui:add-menu", "theme"]),
      fakeStorage(),
      { appVersion: "1.0.0" },
    );
    handle.ctx.ui.registerSettingsSection({ label: () => "s", component: () => null });
    handle.ctx.ui.registerAddMenuRow({ label: () => "m", onSelect: () => {} });
    handle.ctx.theme.injectCss(".x{}");
    expect(handle.disposers).toHaveLength(3);
    for (const d of [...handle.disposers].reverse()) d();
    expect(settingsRegistry.get("plugin:test-plugin")).toBeUndefined();
    expect(addMenuRegistry.get("plugin:test-plugin")).toBeUndefined();
    expect(document.head.querySelector('style[data-plugin="test-plugin"]')).toBeNull();
  });

  it("gates hook groups precisely, tracks registrations, and disposal stops delivery", async () => {
    const denied = createPluginContext(manifest([]), fakeStorage(), { appVersion: "1.0.0" });
    expect(() => denied.ctx.hooks.registerSessionHooks({})).toThrow(/session\.lifecycle\.read/);
    expect(() => denied.ctx.hooks.registerTurnHooks({ onRuntimeEvent: () => {} })).toThrow(
      /runtime\.events\.read/,
    );
    expect(() =>
      createPluginContext(manifest(["runtime.events.read"]), fakeStorage(), {
        appVersion: "1.0.0",
      }).ctx.hooks.registerTurnHooks({ beforeTurn: () => undefined }),
    ).toThrow(/prompt\.contribute\.internal/);
    expect(() => denied.ctx.hooks.registerRuntimeSwitchHooks({})).toThrow(
      /runtime\.switch\.observe/,
    );

    const sessionSeen = vi.fn();
    const runtimeSeen = vi.fn();
    const handle = createPluginContext(
      manifest(["session.lifecycle.read", "runtime.events.read"]),
      fakeStorage(),
      { appVersion: "1.0.0" },
    );
    const stopSession = handle.ctx.hooks.registerSessionHooks({ onCreated: sessionSeen });
    const stopTurn = handle.ctx.hooks.registerTurnHooks({ onRuntimeEvent: runtimeSeen });
    expect(handle.disposers).toEqual([stopSession, stopTurn]);

    const base = {
      engine: "claude",
      sessionId: null,
      workspace: { id: "workspace-id", path: "C:/work" },
      occurredAt: "2026-09-13T00:00:00.000Z",
    } as const;
    dispatchSessionCreated(base);
    dispatchRuntimeEvent({
      eventId: "event-1",
      runId: "run-1",
      turnId: "turn-1",
      engine: base.engine,
      sessionId: base.sessionId,
      workspaceId: base.workspace.id,
      workspacePath: base.workspace.path,
      occurredAt: "2026-09-13T00:00:00.000Z",
      kind: "assistant-completed",
    });
    await Promise.resolve();
    expect(sessionSeen).toHaveBeenCalledTimes(1);
    expect(runtimeSeen).toHaveBeenCalledTimes(1);

    stopSession();
    stopTurn();
    dispatchSessionCreated(base);
    dispatchRuntimeEvent({
      eventId: "event-2",
      runId: "run-2",
      turnId: "turn-2",
      engine: base.engine,
      sessionId: base.sessionId,
      workspaceId: base.workspace.id,
      workspacePath: base.workspace.path,
      occurredAt: "2026-09-13T00:00:01.000Z",
      kind: "assistant-completed",
    });
    await Promise.resolve();
    expect(sessionSeen).toHaveBeenCalledTimes(1);
    expect(runtimeSeen).toHaveBeenCalledTimes(1);
  });

  it("routes workspace metadata and document storage through the plugin namespace", async () => {
    const backend = fakeStorage();
    const { ctx } = createPluginContext(
      manifest(["workspace.metadata.read", "plugin.storage"]),
      backend,
      { appVersion: "1.0.0" },
    );

    await expect(ctx.workspace.getMetadata()).resolves.toEqual({
      id: "workspace-id",
      path: "C:/work",
    });
    expect(backend.workspaceMetadata).toHaveBeenCalledWith("test-plugin");

    await expect(ctx.documentStorage.getLocation()).resolves.toEqual({
      kind: "data",
      path: "C:/data/plugin-data/test-plugin",
    });
    await expect(ctx.documentStorage.readText("state.json")).resolves.toEqual({
      content: "saved",
      version: "v1",
    });
    await expect(ctx.documentStorage.writeTextAtomic("state.json", "next", "v1")).resolves.toEqual({
      version: "v2",
    });
    await ctx.documentStorage.remove("state.json");
    await expect(ctx.documentStorage.list("state")).resolves.toEqual(["one.txt"]);

    expect(backend.documentStorageGetLocation).toHaveBeenCalledWith("test-plugin");
    expect(backend.documentStorageReadText).toHaveBeenCalledWith("test-plugin", "state.json");
    expect(backend.documentStorageWriteTextAtomic).toHaveBeenCalledWith(
      "test-plugin",
      "state.json",
      "next",
      "v1",
    );
    expect(backend.documentStorageRemove).toHaveBeenCalledWith("test-plugin", "state.json", null);
    expect(backend.documentStorageList).toHaveBeenCalledWith("test-plugin", "state");
  });

  it("forwards an explicit remove expectedVersion and defaults an omitted one to null", async () => {
    const backend = fakeStorage();
    const { ctx } = createPluginContext(manifest(["plugin.storage"]), backend, {
      appVersion: "1.0.0",
    });

    // A caller holding a read version deletes conditionally (CAS): the opaque
    // token must reach the backend, not be hardcoded to null.
    await ctx.documentStorage.remove("state.json", "v2");
    expect(backend.documentStorageRemove).toHaveBeenLastCalledWith(
      "test-plugin",
      "state.json",
      "v2",
    );

    await ctx.documentStorage.remove("state.json");
    expect(backend.documentStorageRemove).toHaveBeenLastCalledWith(
      "test-plugin",
      "state.json",
      null,
    );

    backend.documentStorageRemove.mockResolvedValueOnce({
      status: "conflict",
      currentVersion: "v3",
    });
    await expect(ctx.documentStorage.remove("state.json", "v2")).rejects.toMatchObject({
      name: "DocumentStorageConflictError",
      code: "DOCUMENT_STORAGE_CONFLICT",
      currentVersion: "v3",
    });
  });

  it("uses the host chooser only for custom document storage and preserves cancellation", async () => {
    const backend = fakeStorage();
    const { ctx } = createPluginContext(manifest(["plugin.storage"]), backend, {
      appVersion: "1.0.0",
    });

    await expect(ctx.documentStorage.selectLocation("program")).resolves.toEqual({
      kind: "program",
      path: "C:/data/plugin-data/test-plugin",
    });
    expect(backend.pickDirectory).not.toHaveBeenCalled();
    expect(backend.documentStorageSelectLocation).toHaveBeenLastCalledWith(
      "test-plugin",
      "program",
      null,
    );

    await expect(ctx.documentStorage.selectLocation("custom")).resolves.toEqual({
      kind: "custom",
      path: "C:/chosen/plugin-data/test-plugin",
    });
    expect(backend.pickDirectory).toHaveBeenCalledTimes(1);
    expect(backend.documentStorageSelectLocation).toHaveBeenLastCalledWith(
      "test-plugin",
      "custom",
      "C:/chosen",
    );

    backend.pickDirectory.mockResolvedValueOnce(null);
    await expect(ctx.documentStorage.selectLocation("custom")).rejects.toThrow(/cancelled/i);
    expect(backend.documentStorageSelectLocation).toHaveBeenCalledTimes(2);
  });

  it("rejects structured document CAS conflicts as a typed error", async () => {
    const backend = fakeStorage();
    backend.documentStorageWriteTextAtomic.mockResolvedValueOnce({
      status: "conflict",
      currentVersion: "v2",
    });
    const { ctx } = createPluginContext(manifest(["plugin.storage"]), backend, {
      appVersion: "1.0.0",
    });

    const write = ctx.documentStorage.writeTextAtomic("state.json", "stale", "v1");
    await expect(write).rejects.toBeInstanceOf(DocumentStorageConflictError);
    await expect(write).rejects.toMatchObject({
      name: "DocumentStorageConflictError",
      code: "DOCUMENT_STORAGE_CONFLICT",
      currentVersion: "v2",
    });
  });

  it("rejects workspace and document access before calling the backend when permissions are absent", async () => {
    const backend = fakeStorage();
    const { ctx } = createPluginContext(manifest([]), backend, { appVersion: "1.0.0" });
    await expect(ctx.workspace.getMetadata()).rejects.toThrow(/workspace\.metadata\.read/);
    await expect(ctx.documentStorage.getLocation()).rejects.toThrow(/plugin\.storage/);
    expect(backend.workspaceMetadata).not.toHaveBeenCalled();
    expect(backend.documentStorageGetLocation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "ui:composer",
      (ctx: PluginContext) =>
        ctx.ui.registerComposerSlot({ slot: "addMenu", component: () => null }),
      composerSlotRegistry,
    ],
    [
      "ui:panel-tab",
      (ctx: PluginContext) =>
        ctx.ui.registerPanelTab({ label: () => "T", component: () => null }),
      panelTabRegistry,
    ],
    [
      "ui:status-bar",
      (ctx: PluginContext) =>
        ctx.ui.registerStatusBarItem({ component: () => null }),
      statusBarRegistry,
    ],
    [
      "ui:markdown",
      (ctx: PluginContext) =>
        ctx.ui.registerMarkdownRenderer({}),
      markdownRegistry,
    ],
    [
      "ui:page",
      (ctx: PluginContext) =>
        ctx.ui.registerPage({ title: () => "P", component: () => null }),
      pageRegistry,
    ],
    [
      "ui:timeline-row",
      (ctx: PluginContext) =>
        ctx.ui.registerTimelineRowRenderer({ kind: "custom", component: () => null }),
      timelineRowRegistry,
    ],
  ])(
    "%s gates and registers under plugin:<id>, disposer removes (phase-2 ui points)",
    (permission, register, registry) => {
      const denied = createPluginContext(manifest([]), fakeStorage(), { appVersion: "1.0.0" });
      expect(() => register(denied.ctx)).toThrow(new RegExp(permission));

      const { ctx } = createPluginContext(manifest([permission]), fakeStorage(), {
        appVersion: "1.0.0",
      });
      const dispose = register(ctx);
      expect(registry.get("plugin:test-plugin")).toBeDefined();
      dispose();
      expect(registry.get("plugin:test-plugin")).toBeUndefined();
    },
  );

  it("registerCommand requires a key, prefixes ids, and wraps run with the plugin guard", () => {
    const denied = createPluginContext(manifest([]), fakeStorage(), { appVersion: "1.0.0" });
    expect(() =>
      denied.ctx.ui.registerCommand({ key: "go", title: () => "Go", run: () => {} }),
    ).toThrow(/ui:command/);

    const { ctx } = createPluginContext(manifest(["ui:command"]), fakeStorage(), {
      appVersion: "1.0.0",
    });
    let ran = 0;
    const dispose = ctx.ui.registerCommand({
      key: "go",
      title: () => "Go",
      run: () => ran++,
    });
    const entry = commandRegistry.get("plugin:test-plugin:go");
    expect(entry?.title()).toBe("Go");
    entry?.run();
    expect(ran).toBe(1);
    dispose();
    expect(commandRegistry.get("plugin:test-plugin:go")).toBeUndefined();
  });

  it("injectBundleCss mounts bundle styles without the theme permission and rejects remote refs", () => {
    const handle = createPluginContext(manifest([]), fakeStorage(), { appVersion: "1.0.0" });
    injectBundleCss(handle, ".bundle { color: red; }");
    const css = document.head.querySelector('style[data-plugin="test-plugin"]')?.textContent ?? "";
    expect(css).toContain("color: red");
    // Bundle CSS is wrapped in the ccgui-plugins layer (declared first in
    // index.css) so it can never outrank host utilities on specificity ties.
    expect(css).toMatch(/^@layer ccgui-plugins \{/);
    expect(handle.disposers).toHaveLength(1);
    handle.disposers[0]();
    expect(document.head.querySelector('style[data-plugin="test-plugin"]')).toBeNull();

    expect(() => injectBundleCss(handle, '@import url("https://evil.com/x.css");')).toThrow(
      /remote/,
    );
  });

  describe("bridge.invoke grant prechecks", () => {
    it("rejects plugin_http_request to a url with no matching network: grant, without IPC", async () => {
      const backend = fakeStorage();
      const { ctx } = createPluginContext(manifest([]), backend, { appVersion: "1.0.0" });
      await expect(
        ctx.bridge.invoke("plugin_http_request", {
          method: "GET",
          url: "http://127.0.0.1:7684/functions/tokentracker-user-status",
        }),
      ).rejects.toThrow(/network:/);
      expect(backend.bridgeInvoke).not.toHaveBeenCalled();
    });

    it("rejects plugin_http_request when the port falls outside the granted range", async () => {
      const backend = fakeStorage();
      const { ctx } = createPluginContext(manifest(["network:127.0.0.1:7680-7690"]), backend, {
        appVersion: "1.0.0",
      });
      await expect(
        ctx.bridge.invoke("plugin_http_request", { method: "GET", url: "http://127.0.0.1:8000/" }),
      ).rejects.toThrow(/network:/);
      expect(backend.bridgeInvoke).not.toHaveBeenCalled();
    });

    it("passes a granted http request through and injects pluginId", async () => {
      const backend = fakeStorage();
      backend.bridgeInvoke.mockResolvedValue({ status: 200, body: "{}" });
      const { ctx } = createPluginContext(manifest(["network:127.0.0.1:7680-7690"]), backend, {
        appVersion: "1.0.0",
      });
      const result = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url: "http://127.0.0.1:7684/functions/tokentracker-user-status",
      });
      expect(result).toEqual({ status: 200, body: "{}" });
      expect(backend.bridgeInvoke).toHaveBeenCalledWith("plugin_http_request", {
        method: "GET",
        url: "http://127.0.0.1:7684/functions/tokentracker-user-status",
        pluginId: "test-plugin",
      });
    });

    it("rejects plugin_exec_run/spawn without a matching exec: grant, without IPC", async () => {
      const backend = fakeStorage();
      const { ctx } = createPluginContext(manifest(["exec:npm"]), backend, {
        appVersion: "1.0.0",
      });
      await expect(
        ctx.bridge.invoke("plugin_exec_run", { bin: "tokentracker", args: ["--version"] }),
      ).rejects.toThrow(/exec:/);
      await expect(
        ctx.bridge.invoke("plugin_exec_spawn", { bin: "tokentracker", args: ["serve"] }),
      ).rejects.toThrow(/exec:/);
      expect(backend.bridgeInvoke).not.toHaveBeenCalled();
    });

    it("passes a granted exec through and injects pluginId", async () => {
      const backend = fakeStorage();
      backend.bridgeInvoke.mockResolvedValue({ code: 0, stdout: "1.0.0", stderr: "" });
      const { ctx } = createPluginContext(manifest(["exec:tokentracker"]), backend, {
        appVersion: "1.0.0",
      });
      const result = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "tokentracker",
        args: ["--version"],
        timeoutMs: 10000,
      });
      expect(result).toEqual({ code: 0, stdout: "1.0.0", stderr: "" });
      expect(backend.bridgeInvoke).toHaveBeenCalledWith("plugin_exec_run", {
        bin: "tokentracker",
        args: ["--version"],
        timeoutMs: 10000,
        pluginId: "test-plugin",
      });
    });

    it("rejects unknown bridge commands (cmd: mechanism is gone)", async () => {
      const backend = fakeStorage();
      const { ctx } = createPluginContext(
        manifest(["network:example.com", "exec:npm"]),
        backend,
        { appVersion: "1.0.0" },
      );
      await expect(ctx.bridge.invoke("tt_proxy", {})).rejects.toThrow(/unknown bridge command/);
      expect(backend.bridgeInvoke).not.toHaveBeenCalled();
    });
  });
});
