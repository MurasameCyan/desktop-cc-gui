import { describe, expect, it, vi } from "vitest";
import { createPluginContext, type PluginContextBackend } from "./context";
import type { PluginManifest } from "@ccgui/plugin-sdk";

const client = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/transport", () => ({
  get isWeb() { return client.web; },
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
}));

function context(permissions: string[], web = false) {
  client.web = web;
  const backend: PluginContextBackend = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    bridgeInvoke: vi.fn(async () => { throw new Error("backend must not be reached"); }),
  };
  const manifest: PluginManifest = {
    id: "execution-boundary", name: "Execution boundary", version: "1.0.0", tier: "js", permissions,
  };
  return { ...createPluginContext(manifest, backend, { appVersion: "1.0.0" }), backend };
}

const publication = {
  sourceId: "models", documentPath: "registry.json", documentVersion: "document-1",
  expectedPublicationRevision: null, profiles: [], choices: [],
};

const material = {
  profileKey: "chat",
  use: { sourceId: "models", credentialId: "key-a", credentialRevision: 1, registryRevision: "document-1" },
  value: "test-secret-that-must-stay-local",
};

describe("execution capability security boundaries", () => {
  it("refuses publication without its own permission before reaching native code", async () => {
    const { ctx, backend } = context(["cli.read"]);
    await expect(Promise.resolve().then(() => ctx.cli.publishSource(publication)))
      .rejects.toThrow(/cli\.contributions\.write/);
    expect(backend.bridgeInvoke).not.toHaveBeenCalled();
  });

  it("does not treat publication permission as permission to deliver a credential", async () => {
    const { ctx, backend } = context(["cli.contributions.write"]);
    await expect(Promise.resolve().then(() => ctx.cli.registerRuntimeMaterial(material)))
      .rejects.toThrow(/cli\.runtime\.sensitive/);
    expect(backend.bridgeInvoke).not.toHaveBeenCalled();
  });

  it("refuses sensitive material on a paired Web client even with a manifest grant", async () => {
    const { ctx, backend } = context(["cli.runtime.sensitive"], true);
    await expect(Promise.resolve().then(() => ctx.cli.registerRuntimeMaterial(material)))
      .rejects.toThrow(/desktop|桌面/i);
    expect(backend.bridgeInvoke).not.toHaveBeenCalled();
  });

  it("does not let the generic bridge bypass typed source publication checks", async () => {
    const { ctx, backend } = context(["cli.contributions.write"]);
    await expect(ctx.bridge.invoke("plugin_cli_publish_source", { request: publication }))
      .rejects.toThrow(/unknown bridge command/);
    expect(backend.bridgeInvoke).not.toHaveBeenCalled();
  });
});
