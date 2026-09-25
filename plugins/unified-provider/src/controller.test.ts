import { describe, expect, it } from "vitest";
import type { PluginContext, PublishedSource, SourcePublication } from "@ccgui/plugin-sdk";
import { ProviderController } from "./controller";
import { emptyRegistry } from "./registry";

function host() {
  let content: string | null = null;
  let version = 0;
  let publication: PublishedSource | null = null;
  let rejectPublication = false;
  const ctx = {
    pluginId: "unified-provider",
    documentStorage: {
      readText: async () => content === null ? null : { content, version: String(version) },
      writeTextAtomic: async (_path: string, next: string, expected: string | null) => {
        if (expected !== (content === null ? null : String(version))) throw new Error("DOCUMENT_VERSION_CONFLICT");
        content = next; return { version: String(++version) };
      },
    },
    cli: {
      getSource: async () => publication,
      getCredentialUses: async () => [],
      onMaterialRequested: () => () => {},
      onChanged: () => () => {},
      publishSource: async (input: SourcePublication) => {
        if (rejectPublication) throw new Error("invalid profile");
        publication = { ...input, pluginId: "unified-provider", publicationRevision: `p${version}`, available: true };
        return publication;
      },
    },
    sessions: { onSelectionChanged: () => () => {} },
  } as unknown as PluginContext;
  return { ctx, drift: () => { version++; }, failPublication: (fail: boolean) => { rejectPublication = fail; }, document: () => content, publication: () => publication };
}

describe("CAS save followed by atomic publication", () => {
  it("rejects a stale editor without overwriting the externally changed document", async () => {
    const h = host(); const c = new ProviderController(h.ctx); await c.start();
    await c.save(c.snapshot().registry!, c.snapshot().documentVersion);
    const before = h.document(); h.drift();
    await expect(c.save(c.snapshot().registry!, c.snapshot().documentVersion)).rejects.toThrow();
    expect(h.document()).toBe(before);
    expect(c.snapshot().phase).toBe("conflict"); c.dispose();
  });
  it("keeps the last publication after a successful save and retries without duplicating entities or writing again", async () => {
    const h = host(); const c = new ProviderController(h.ctx); await c.start();
    await c.save(emptyRegistry(), null);
    const oldPublication = h.publication(); h.failPublication(true);
    const draft = c.snapshot().registry!;
    draft.providers.push({ id: "p", name: "saved", enabled: false, revision: 1 });
    await c.save(draft, c.snapshot().documentVersion);
    expect(c.snapshot().phase).toBe("saved-unpublished");
    expect(h.publication()).toBe(oldPublication);
    const saved = h.document(); h.failPublication(false); await c.retryPublish();
    expect(h.document()).toBe(saved);
    expect(c.snapshot().registry!.providers.map((p) => p.id)).toEqual(["p"]);
    expect(c.snapshot().phase).toBe("published"); c.dispose();
  });
});
