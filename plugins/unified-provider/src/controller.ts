import type { ConfigPatchPreview, DiscoveredModel, ExecutionSelectionInput, ModelDiscoveryResult, NativeConfigPreview, NativeConfigTarget, PluginContext, PublishedSource, RuntimeMaterialRequest } from "@ccgui/plugin-sdk";
import { emptyRegistry, parseRegistry, registryView, validateRegistry, type Binding, type Registry, type RegistryView } from "./registry";
import { credentialForBinding, credentialIdentity, projectRegistry, type RegistryProjection } from "./projection";
import { mergeImportedCandidates, type ImportDecision } from "./imports";

export interface ControllerSnapshot {
  registry: RegistryView | null;
  documentVersion: string | null;
  phase: "loading" | "ready" | "saving" | "published" | "saved-unpublished" | "conflict" | "error";
  message: string;
  publication: PublishedSource | null;
}
export class ProviderController {
  readonly sourceId: string;
  private registry = emptyRegistry();
  private version: string | null = null;
  private publication: PublishedSource | null = null;
  private state: ControllerSnapshot = { registry: null, documentVersion: null, phase: "loading", message: "Loading registry…", publication: null };
  private listeners = new Set<() => void>();
  private cleanups: Array<() => void> = [];
  private active = true;
  private busy = false;
  private templates = new Map<string, DiscoveredModel[]>();
  private discoveries = new Map<string, ModelDiscoveryResult>();
  constructor(private readonly ctx: PluginContext) { this.sourceId = `plugin:${ctx.pluginId}:registry`; }
  snapshot = (): ControllerSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(phase: ControllerSnapshot["phase"], message: string): void {
    if (!this.active) return;
    this.state = { registry: registryView(this.registry), documentVersion: this.version, phase, message, publication: this.publication };
    for (const listener of this.listeners) listener();
  }
  async start(): Promise<void> {
    try {
      this.cleanups.push(this.ctx.cli.onMaterialRequested((request) => { void this.supplyMaterial(request).catch(() => { this.emit(this.state.phase, "A bound Key is unavailable. Reconfirm its identity, revision and destination before sending."); }); }));
      this.cleanups.push(this.ctx.sessions.onSelectionChanged(() => { void this.restoreBoundMaterial().catch(() => { this.emit(this.state.phase, "A selected Key could not be restored; no substitute was registered."); }); }));
      this.cleanups.push(this.ctx.cli.onChanged((event) => { if (event.sourceId === this.sourceId && event.publicationRevision !== this.publication?.publicationRevision) void this.refreshPublication(); }));
      await this.reload();
    } catch { this.emit("error", "Plugin initialization failed. Check SDK compatibility and granted permissions, then reload the plugin."); }
  }
  dispose(): void { this.active = false; for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); this.listeners.clear(); this.discoveries.clear(); this.templates.clear(); this.registry = emptyRegistry(); }
  private async refreshPublication(): Promise<void> {
    try { this.publication = await this.ctx.cli.getSource(this.sourceId); if (!this.active) return; this.emit(this.publication?.available && this.publication.documentVersion === this.version ? "published" : "saved-unpublished", "Publication changed. Reload before editing from another window."); }
    catch { this.emit(this.state.phase, "Cannot read the current publication. Retry after checking plugin permissions."); }
  }
  async reload(): Promise<void> {
    if (this.busy) throw new Error("Wait for the current save to finish");
    this.emit("loading", "Loading registry…");
    try {
      const [document, publication] = await Promise.all([this.ctx.documentStorage.readText("registry.json"), this.ctx.cli.getSource(this.sourceId)]);
      if (!this.active) return;
      const registry = document ? parseRegistry(document.content) : emptyRegistry();
      this.registry = registry; this.version = document?.version ?? null; this.publication = publication;
      this.emit(publication?.available && publication.documentVersion === this.version ? "published" : document ? "saved-unpublished" : "ready", publication && publication.documentVersion !== this.version ? "Saved changes are not published. The previous publication is still in use." : "Registry loaded. Keys are stored only in the private registry document.");
      if (document && publication && !publication.available && publication.documentVersion === document.version) await this.retryPublish();
      else try { await this.restoreBoundMaterial(); } catch { this.emit(this.state.phase, "Registry loaded; an existing session Key is unavailable. Reconfirm it explicitly; no substitute was registered."); }
    } catch { this.emit("error", "Could not load registry or restore bound material. Check document permissions/schema, then reload. No file was overwritten."); }
  }
  async save(view: RegistryView, expectedVersion: string | null, keyEdits: Readonly<Record<string, string>> = {}): Promise<void> {
    if (this.busy) throw new Error("Another save is in progress");
    if (this.state.phase === "error" || this.state.phase === "loading") throw new Error("Reload a valid registry before saving");
    if (expectedVersion !== this.version) { this.emit("conflict", "This draft is stale. Reload and review changes before saving."); throw new Error("Registry version conflict"); }
    const credentials = view.credentials.map((credential) => {
      const existing = this.registry.credentials.find((c) => c.id === credential.id);
      const value = keyEdits[credential.id] ?? existing?.value;
      if (!value) throw new Error("A new Key requires an explicit value");
      if (existing && existing.providerId !== credential.providerId) throw new Error("A Key cannot move between Providers");
      return { ...credential, value, credentialRevision: existing ? existing.credentialRevision + (keyEdits[credential.id] !== undefined ? 1 : 0) : 1 };
    });
    const next = validateRegistry({ ...structuredClone(view), credentials, revision: this.registry.revision + 1 });
    await this.persistAndPublish(next, expectedVersion);
  }
  private async persistAndPublish(next: Registry, expectedVersion: string | null): Promise<void> {
    if (this.busy) throw new Error("Another save is in progress");
    if (!this.active) throw new Error("Plugin is inactive");
    this.busy = true; this.emit("saving", "Saving the registry with a version check…");
    try {
      let result;
      try { result = await this.ctx.documentStorage.writeTextAtomic("registry.json", JSON.stringify(next, null, 2), expectedVersion); }
      catch { this.emit("conflict", "The registry was not saved. Its version may have changed or storage may be unavailable. Reload and review; do not overwrite blindly."); throw new Error("Registry save rejected; reload before retrying"); }
      if (!this.active) return;
      this.registry = next; this.version = result.version;
      await this.publishSaved();
    } finally { this.busy = false; }
  }
  async retryPublish(): Promise<void> {
    if (this.busy) throw new Error("Another save is in progress");
    this.busy = true;
    try { await this.publishSaved(); } finally { this.busy = false; }
  }
  private async publishSaved(): Promise<void> {
    if (!this.version) { this.emit("ready", "Save the registry before publishing"); return; }
    let projection: RegistryProjection;
    try {
      await Promise.all(this.registry.bindings.filter((b) => b.enabled && this.registry.providers.some((p) => p.id === b.providerId && p.enabled)).map((b) => this.loadTemplates(b)));
      projection = projectRegistry(this.registry, (binding) => this.templatesFor(binding));
    } catch (error) {
      this.emit("saved-unpublished", `Document saved; previous publication remains in use. ${error instanceof Error ? error.message : "Review the official templates and mapping policies."} Retry publication after correcting the draft; do not import again.`);
      return;
    }
    if (!this.active) return;
    try {
      const publication = await this.ctx.cli.publishSource({ sourceId: this.sourceId, documentPath: "registry.json", documentVersion: this.version, expectedPublicationRevision: this.publication?.publicationRevision ?? null, ...projection });
      this.publication = publication;
      this.emit("published", "Registry saved and published. Native CLI files were not changed.");
      try { await this.restoreBoundMaterial(); } catch { this.emit("published", "Published; one bound Key could not be restored. Reconfirm the affected session; no fallback was used."); }
    } catch { this.emit("saved-unpublished", "Document saved, publication failed. The previous publication remains in use. Check target grants, official templates and mappings, then retry publication; do not import again."); }
  }
  private async supplyMaterial(request: RuntimeMaterialRequest): Promise<void> {
    if (!this.active || request.use.sourceId !== this.sourceId) return;
    const source = this.publication;
    if (!source || request.use.registryRevision !== source.documentVersion) throw new Error("Material belongs to another publication");
    const profile = source.profiles.find((p) => p.profileKey === request.profileKey);
    if (!profile?.credentials.some((c) => c.credentialId === request.use.credentialId && c.credentialRevision === request.use.credentialRevision)) throw new Error("Key is not in the published profile");
    const credential = this.registry.credentials.find((c) => c.id === request.use.credentialId && c.credentialRevision === request.use.credentialRevision && c.enabled);
    if (!credential) throw new Error("Bound Key is missing, disabled or changed");
    await this.ctx.cli.registerRuntimeMaterial({ ...request, value: credential.value });
  }
  private async restoreBoundMaterial(): Promise<void> {
    if (!this.active || !this.publication) return;
    const uses = await this.ctx.cli.getCredentialUses(this.sourceId);
    await Promise.all(uses.map((use) => this.supplyMaterial(use)));
  }
  templatesFor(binding: Binding): DiscoveredModel[] { return this.templates.get(JSON.stringify([binding.engineId, binding.executionTarget])) ?? []; }
  async loadTemplates(binding: Binding, refresh = false): Promise<DiscoveredModel[]> {
    const cacheKey = JSON.stringify([binding.engineId, binding.executionTarget]);
    if (!refresh && this.templates.has(cacheKey)) return this.templates.get(cacheKey)!;
    let result: ModelDiscoveryResult;
    try { result = await this.ctx.cli.listModels({ source: "official", engineId: binding.engineId, executionTarget: binding.executionTarget }); }
    catch { throw new Error("Official templates could not be read for this CLI and execution target"); }
    if (result.status === "failed" || result.status === "unsupported") throw new Error("Official templates are unavailable for this CLI and execution target");
    const previous = this.templates.get(cacheKey) ?? [];
    const models = result.models.filter((model) => model.templateRef?.engineId === binding.engineId && model.evidence === "official");
    const merged = result.status === "partial" ? [...previous.filter((p) => !models.some((m) => m.templateRef?.modelId === p.templateRef?.modelId && m.templateRef?.revision === p.templateRef?.revision)), ...models] : models;
    this.templates.set(cacheKey, merged); return merged;
  }
  async authorizeDraft(view: RegistryView, bindingId: string): Promise<RegistryView> {
    const binding = view.bindings.find((b) => b.id === bindingId);
    const endpoint = view.endpoints.find((e) => e.id === binding?.endpointId);
    if (!binding || !endpoint) throw new Error("Choose a binding endpoint first");
    const credentials = endpoint.auth === "none" ? [] : view.credentials.filter((c) => c.providerId === binding.providerId && c.enabled).map((c) => ({ credentialId: c.id, credentialRevision: c.credentialRevision, name: c.name, ...(c.remark ? { remark: c.remark } : {}) }));
    const grant = await this.ctx.cli.requestTargetGrant({ sourceId: this.sourceId, baseUrl: endpoint.baseUrl, executionTarget: binding.executionTarget, credentials, purpose: "Use this Provider for the selected CLI and explicitly chosen session Key" });
    const next = structuredClone(view); next.bindings.find((b) => b.id === bindingId)!.targetGrantId = grant.grantId; return next;
  }
  async discover(bindingId: string, explicitCredentialId?: string): Promise<ModelDiscoveryResult> {
    const binding = this.registry.bindings.find((b) => b.id === bindingId);
    const profile = this.publication?.profiles.find((p) => p.profileKey === bindingId);
    if (!binding || !profile || !this.publication || this.publication.documentVersion !== this.version) throw new Error("Save, authorize and publish this binding before endpoint discovery");
    const credential = profile.auth === "none" ? undefined : credentialForBinding(this.registry, binding, explicitCredentialId);
    const cacheKey = JSON.stringify([bindingId, profile.protocol, profile.baseUrl, profile.executionTarget, credential?.id, credential?.credentialRevision]);
    const result = await this.ctx.cli.listModels({ source: "authorized-endpoint", engineId: binding.engineId, executionTarget: binding.executionTarget, sourceId: this.sourceId, profileKey: binding.id, targetGrantId: profile.targetGrantId, protocol: profile.protocol, ...(credential ? { credentialUse: { sourceId: this.sourceId, credentialId: credential.id, credentialRevision: credential.credentialRevision, registryRevision: this.publication.documentVersion } } : {}) });
    const previous = this.discoveries.get(cacheKey);
    if (result.status === "failed" || result.status === "unsupported") return { ...result, models: previous?.models ?? result.models };
    const models = result.status === "partial" && previous ? [...previous.models.filter((p) => !result.models.some((m) => m.modelId === p.modelId)), ...result.models] : result.models;
    const merged = { ...result, models }; this.discoveries.set(cacheKey, merged); return merged;
  }
  async listConfigTargets(): Promise<NativeConfigTarget[]> { return this.ctx.cli.listConfigTargets(); }
  async previewImport(targetId: string): Promise<NativeConfigPreview> { return this.ctx.cli.previewConfigImport(targetId); }
  async confirmImport(preview: NativeConfigPreview, decisions: ImportDecision[], expectedVersion: string | null): Promise<void> {
    if (expectedVersion !== this.version || this.busy) throw new Error("Registry changed while reviewing import; reload and preview again");
    const ids = decisions.filter((d) => d.action !== "skip").map((d) => d.candidateId);
    if (!ids.length) throw new Error("Select at least one import candidate");
    const imported = await this.ctx.cli.confirmConfigImport(preview.previewId, ids);
    let next: Registry;
    try { next = mergeImportedCandidates(this.registry, imported.candidates, decisions); }
    finally { for (const candidate of imported.candidates) delete candidate.value; }
    for (const binding of next.bindings.filter((b) => !b.targetGrantId && b.enabled)) {
      const endpoint = next.endpoints.find((e) => e.id === binding.endpointId)!;
      const grant = await this.ctx.cli.requestTargetGrant({ sourceId: this.sourceId, baseUrl: endpoint.baseUrl, executionTarget: binding.executionTarget, credentials: endpoint.auth === "none" ? [] : next.credentials.filter((c) => c.providerId === binding.providerId && c.enabled).map(credentialIdentity), purpose: "Authorize the imported CLI Provider destination; native files will not change" });
      binding.targetGrantId = grant.grantId;
    }
    if (expectedVersion !== this.version || this.busy) throw new Error("Registry changed during import confirmation; preview again");
    next.revision = this.registry.revision + 1; await this.persistAndPublish(next, expectedVersion);
  }
  async previewPatch(targetId: string): Promise<ConfigPatchPreview> {
    const context = await this.ctx.sessions.getContext();
    if (!context?.selection) throw new Error("Select a complete model and effort in the chat first");
    const selection: ExecutionSelectionInput = { modelSelection: context.selection.modelSelection, effort: context.selection.effort };
    return this.ctx.cli.previewConfigPatch(targetId, selection);
  }
  async applyPatch(previewId: string): Promise<void> {
    if (this.busy) throw new Error("Wait for the registry save");
    this.busy = true;
    const previousPhase = this.state.phase;
    this.emit("saving", "Applying the explicitly confirmed native patch…");
    let receipt;
    try { receipt = await this.ctx.cli.applyConfigPatch(previewId); }
    catch { this.emit(previousPhase, "Native patch was rejected. Refresh its preview before trying again."); throw new Error("Native patch rejected"); }
    finally { this.busy = false; }
    const next = structuredClone(this.registry); next.patchReceipts.push(receipt); next.revision++;
    try { await this.persistAndPublish(next, this.version); }
    catch { this.registry.patchReceipts.push(receipt); this.emit("conflict", `Native patch applied, but its receipt could not be saved. Keep this page open; restore is available for receipt ${receipt.receiptId}. Reload only after restoring or recording the receipt.`); throw new Error("Native patch applied but receipt save failed; restore it before leaving"); }
  }
  async restorePatch(receiptId: string): Promise<void> {
    if (this.busy) throw new Error("Wait for the registry save");
    this.busy = true;
    const previousPhase = this.state.phase;
    this.emit("saving", "Restoring the explicitly selected native patch…");
    try { await this.ctx.cli.restoreConfigPatch(receiptId); }
    catch { this.emit(previousPhase, "Native restore was rejected, possibly due to external file changes. Do not overwrite the changed file."); throw new Error("Native restore rejected"); }
    finally { this.busy = false; }
    const next = structuredClone(this.registry); next.patchReceipts = next.patchReceipts.filter((r) => r.receiptId !== receiptId); next.revision++;
    await this.persistAndPublish(next, this.version);
  }
}
