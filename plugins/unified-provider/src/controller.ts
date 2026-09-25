import type { ConfigPatchPreview, DiscoveredModel, ExecutionSelectionInput, ExecutionTarget, ModelDiscoveryResult, NativeConfigPreview, NativeConfigTarget, PluginContext, PublishedSource, RuntimeMaterialRequest } from "@ccgui/plugin-sdk";
import { emptyRegistry, endpointCredentials, parseRegistry, probeEngine, probeProfileKey, registryView, validateRegistry, type Binding, type Registry, type RegistryView } from "./registry";
import { credentialForEndpoint, credentialIdentity, projectRegistry, type RegistryProjection } from "./projection";
import { mergeImportedCandidates, type ImportDecision } from "./imports";

export interface ControllerSnapshot {
  registry: RegistryView | null;
  documentVersion: string | null;
  phase: "loading" | "ready" | "saving" | "published" | "saved-unpublished" | "conflict" | "error";
  message: string;
  publication: PublishedSource | null;
}
/** 官方模板只取决于「CLI + 执行环境」，与端点地址无关。 */
function templateKey(engineId: string, target: ExecutionTarget): string { return JSON.stringify([engineId, target]); }
export class ProviderController {
  readonly sourceId: string;
  private registry = emptyRegistry();
  private version: string | null = null;
  private publication: PublishedSource | null = null;
  private state: ControllerSnapshot = { registry: null, documentVersion: null, phase: "loading", message: "正在加载供应商配置…", publication: null };
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
      this.cleanups.push(this.ctx.cli.onMaterialRequested((request) => { void this.supplyMaterial(request).catch(() => { this.emit(this.state.phase, "已绑定的 Key 不可用。发送前请重新确认它的身份、代次和目标。"); }); }));
      this.cleanups.push(this.ctx.sessions.onSelectionChanged(() => { void this.restoreBoundMaterial().catch(() => { this.emit(this.state.phase, "无法恢复所选 Key，未注册任何替代 Key。"); }); }));
      this.cleanups.push(this.ctx.cli.onChanged((event) => { if (event.sourceId === this.sourceId && event.publicationRevision !== this.publication?.publicationRevision) void this.refreshPublication(); }));
      await this.reload();
    } catch { this.emit("error", "插件初始化失败。请检查 SDK 兼容性与已授予的权限，然后重新加载插件。"); }
  }
  dispose(): void { this.active = false; for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); this.listeners.clear(); this.discoveries.clear(); this.templates.clear(); this.registry = emptyRegistry(); }
  private async refreshPublication(): Promise<void> {
    try { this.publication = await this.ctx.cli.getSource(this.sourceId); if (!this.active) return; this.emit(this.publication?.available && this.publication.documentVersion === this.version ? "published" : "saved-unpublished", "发布内容已变化。在其他窗口编辑前，请先重新加载。"); }
    catch { this.emit(this.state.phase, "无法读取当前发布内容，请检查插件权限后重试。"); }
  }
  async reload(): Promise<void> {
    if (this.busy) throw new Error("请等待当前保存操作结束");
    this.emit("loading", "正在加载供应商配置…");
    try {
      const [document, publication] = await Promise.all([this.ctx.documentStorage.readText("registry.json"), this.ctx.cli.getSource(this.sourceId)]);
      if (!this.active) return;
      const registry = document ? parseRegistry(document.content) : emptyRegistry();
      this.registry = registry; this.version = document?.version ?? null; this.publication = publication;
      this.emit(publication?.available && publication.documentVersion === this.version ? "published" : document ? "saved-unpublished" : "ready", publication && publication.documentVersion !== this.version ? "已保存的修改尚未发布，仍在使用此前的发布版本。" : "配置已加载。Key 仅保存在插件私有的 registry.json 中。");
      if (document && publication && !publication.available && publication.documentVersion === document.version) await this.retryPublish();
      else try { await this.restoreBoundMaterial(); } catch { this.emit(this.state.phase, "配置已加载，但已有会话的 Key 不可用。请明确重新选择，未注册任何替代 Key。"); }
    } catch { this.emit("error", "无法加载配置或恢复已绑定的运行材料。请检查文档权限与格式后重新加载，没有覆盖任何文件。"); }
  }
  async save(view: RegistryView, expectedVersion: string | null, keyEdits: Readonly<Record<string, string>> = {}): Promise<void> {
    if (this.busy) throw new Error("另一个保存操作正在进行");
    if (this.state.phase === "error" || this.state.phase === "loading") throw new Error("保存前请重新加载有效配置");
    if (expectedVersion !== this.version) { this.emit("conflict", "草稿已过期，请重新加载并核对修改后再保存。"); throw new Error("配置版本冲突"); }
    const next = validateRegistry({ ...structuredClone(view), credentials: this.mergeKeyValues(view, keyEdits), revision: this.registry.revision + 1 });
    await this.persistAndPublish(next, expectedVersion);
  }
  /** 明文只在这里从编辑框回到 registry：其余流程一律只看身份与代次。 */
  private mergeKeyValues(view: RegistryView, keyEdits: Readonly<Record<string, string>>): Registry["credentials"] {
    return view.credentials.map((credential) => {
      const existing = this.registry.credentials.find((c) => c.id === credential.id);
      const value = keyEdits[credential.id] ?? existing?.value;
      if (!value) throw new Error("新增 Key 必须明确填写值");
      if (existing && existing.endpointId !== credential.endpointId) throw new Error("Key 不能在不同端点之间移动");
      return { ...credential, value, credentialRevision: existing ? existing.credentialRevision + (keyEdits[credential.id] !== undefined ? 1 : 0) : 1 };
    });
  }
  private async persistAndPublish(next: Registry, expectedVersion: string | null): Promise<void> {
    if (this.busy) throw new Error("另一个保存操作正在进行");
    if (!this.active) throw new Error("插件未启用");
    this.busy = true; this.emit("saving", "正在校验版本并保存配置…");
    try {
      let result;
      try { result = await this.ctx.documentStorage.writeTextAtomic("registry.json", JSON.stringify(next, null, 2), expectedVersion); }
      catch { this.emit("conflict", "配置未保存，可能是版本已变化或存储不可用。请重新加载并核对，不要直接覆盖。"); throw new Error("配置保存被拒绝，请重新加载后再试"); }
      if (!this.active) return;
      this.registry = next; this.version = result.version;
      await this.publishSaved();
    } finally { this.busy = false; }
  }
  async retryPublish(): Promise<void> {
    if (this.busy) throw new Error("另一个保存操作正在进行");
    this.busy = true;
    try { await this.publishSaved(); } finally { this.busy = false; }
  }
  private async publishSaved(): Promise<void> {
    if (!this.version) { this.emit("ready", "发布前请先保存配置"); return; }
    let projection: RegistryProjection;
    try {
      await Promise.all(this.registry.bindings.filter((b) => b.enabled && this.registry.providers.some((p) => p.id === b.providerId && p.enabled)).map((b) => this.loadTemplates(b)));
      projection = projectRegistry(this.registry, (binding) => this.templatesFor(binding));
    } catch (error) {
      this.emit("saved-unpublished", `配置已保存，仍在使用此前的发布版本。${error instanceof Error ? error.message : "请核对官方模板与映射策略。"} 修正草稿后请重试发布，不要重复导入。`);
      return;
    }
    if (!this.active) return;
    try {
      const publication = await this.ctx.cli.publishSource({ sourceId: this.sourceId, documentPath: "registry.json", documentVersion: this.version, expectedPublicationRevision: this.publication?.publicationRevision ?? null, ...projection });
      this.publication = publication;
      this.emit("published", "配置已保存并发布，原生 CLI 文件未改动。");
      try { await this.restoreBoundMaterial(); } catch { this.emit("published", "已发布，但有一个已绑定的 Key 无法恢复。请重新确认受影响的会话，没有使用替代 Key。"); }
    } catch { this.emit("saved-unpublished", "配置已保存，但发布失败，仍在使用此前的发布版本。请检查目标授权、官方模板与映射后重试发布，不要重复导入。"); }
  }
  private async supplyMaterial(request: RuntimeMaterialRequest): Promise<void> {
    if (!this.active || request.use.sourceId !== this.sourceId) return;
    const source = this.publication;
    if (!source || request.use.registryRevision !== source.documentVersion) throw new Error("运行材料属于另一个发布版本");
    const profile = source.profiles.find((p) => p.profileKey === request.profileKey);
    if (!profile?.credentials.some((c) => c.credentialId === request.use.credentialId && c.credentialRevision === request.use.credentialRevision)) throw new Error("Key 不在已发布的执行配置中");
    const credential = this.registry.credentials.find((c) => c.id === request.use.credentialId && c.credentialRevision === request.use.credentialRevision && c.enabled);
    if (!credential) throw new Error("已绑定的 Key 缺失、已禁用或代次已变化");
    await this.ctx.cli.registerRuntimeMaterial({ ...request, value: credential.value });
  }
  private async restoreBoundMaterial(): Promise<void> {
    if (!this.active || !this.publication) return;
    const uses = await this.ctx.cli.getCredentialUses(this.sourceId);
    await Promise.all(uses.map((use) => this.supplyMaterial(use)));
  }
  templatesFor(binding: Pick<Binding, "engineId" | "executionTarget">): DiscoveredModel[] { return this.templates.get(templateKey(binding.engineId, binding.executionTarget)) ?? []; }
  async loadTemplates(binding: Pick<Binding, "engineId" | "executionTarget">, refresh = false): Promise<DiscoveredModel[]> {
    const cacheKey = templateKey(binding.engineId, binding.executionTarget);
    if (!refresh && this.templates.has(cacheKey)) return this.templates.get(cacheKey)!;
    let result: ModelDiscoveryResult;
    try { result = await this.ctx.cli.listModels({ source: "official", engineId: binding.engineId, executionTarget: binding.executionTarget }); }
    catch { throw new Error("无法读取该 CLI 与执行目标的官方模板"); }
    if (result.status === "failed" || result.status === "unsupported") throw new Error("该 CLI 与执行目标的官方模板不可用");
    const previous = this.templates.get(cacheKey) ?? [];
    const models = result.models.filter((model) => model.templateRef?.engineId === binding.engineId && model.evidence === "official");
    const merged = result.status === "partial" ? [...previous.filter((p) => !models.some((m) => m.templateRef?.modelId === p.templateRef?.modelId && m.templateRef?.revision === p.templateRef?.revision)), ...models] : models;
    this.templates.set(cacheKey, merged); return merged;
  }
  /** 一个 CLI 线路的授权：端点地址 + 这条线路的执行环境 + 该端点全部启用的 Key。 */
  async authorizeBindingDraft(view: RegistryView, bindingId: string): Promise<RegistryView> {
    const binding = view.bindings.find((b) => b.id === bindingId);
    const endpoint = view.endpoints.find((e) => e.id === binding?.endpointId);
    if (!binding || !endpoint) throw new Error("请先为该 CLI 线路选择端点");
    const grant = await this.ctx.cli.requestTargetGrant({
      sourceId: this.sourceId, baseUrl: endpoint.baseUrl, executionTarget: binding.executionTarget,
      credentials: this.grantCredentials(view, endpoint.id, endpoint.auth),
      purpose: `使用端点“${endpoint.name}”的地址与它自己的 Key 运行 ${binding.engineId}`,
    });
    const next = structuredClone(view); next.bindings.find((b) => b.id === bindingId)!.targetGrantId = grant.grantId; return next;
  }
  /** 拉取模型的授权：只覆盖端点自己的地址与 Key，不涉及任何 CLI 进程。 */
  async authorizeEndpointDraft(view: RegistryView, endpointId: string): Promise<RegistryView> {
    const endpoint = view.endpoints.find((e) => e.id === endpointId);
    if (!endpoint) throw new Error("端点不存在，请重新加载草稿");
    const grant = await this.ctx.cli.requestTargetGrant({
      sourceId: this.sourceId, baseUrl: endpoint.baseUrl, executionTarget: { kind: "local" },
      credentials: this.grantCredentials(view, endpoint.id, endpoint.auth),
      purpose: `从端点“${endpoint.name}”读取它提供的模型列表`,
    });
    const next = structuredClone(view); next.endpoints.find((e) => e.id === endpointId)!.probeGrantId = grant.grantId; return next;
  }
  /** 授权必须覆盖将要发布的全部 Key 身份，否则宿主会在发请求前拒绝。 */
  private grantCredentials(view: RegistryView, endpointId: string, auth: string) {
    if (auth === "none") return [];
    const credentials = endpointCredentials(view.credentials, endpointId).filter((c) => c.enabled);
    if (!credentials.length) throw new Error("请先为该端点添加至少一个启用的 Key");
    return credentials.map(credentialIdentity);
  }
  /** 「拉取模型」是一次完整动作：先把这个端点上缺的授权全部补齐（读取授权，以及它
   *  每条启用 CLI 线路的目标授权——少一个，发布就会整份失败），保存并发布，再列模型。
   *  宿主只接受已发布且已授权的目标，所以顺序不能省。 */
  async pullEndpointModels(view: RegistryView, expectedVersion: string | null, keyEdits: Readonly<Record<string, string>>, endpointId: string, explicitCredentialId?: string): Promise<{ result: ModelDiscoveryResult; draft: RegistryView }> {
    let authorized = view;
    if (!authorized.endpoints.find((e) => e.id === endpointId)?.probeGrantId) authorized = await this.authorizeEndpointDraft(authorized, endpointId);
    for (const binding of authorized.bindings.filter((b) => b.endpointId === endpointId && b.enabled && !b.targetGrantId)) {
      authorized = await this.authorizeBindingDraft(authorized, binding.id);
    }
    await this.save(authorized, expectedVersion, keyEdits);
    return { result: await this.discoverEndpoint(endpointId, explicitCredentialId), draft: registryView(this.registry) };
  }
  async discoverEndpoint(endpointId: string, explicitCredentialId?: string): Promise<ModelDiscoveryResult> {
    const endpoint = this.registry.endpoints.find((e) => e.id === endpointId);
    if (!endpoint || !this.publication || this.publication.documentVersion !== this.version) throw new Error("拉取模型前请先保存并发布该端点");
    const profileKey = probeProfileKey(endpoint.id);
    const profile = this.publication.profiles.find((p) => p.profileKey === profileKey);
    if (!profile) throw new Error("该端点还没有可用于拉取模型的已发布目标。请确认端点已启用、已授权，并且认证端点至少有一个启用的 Key。");
    const credential = profile.auth === "none" ? undefined : credentialForEndpoint(this.registry, endpoint, undefined, explicitCredentialId);
    const cacheKey = JSON.stringify([endpointId, profile.protocol, profile.baseUrl, credential?.id, credential?.credentialRevision]);
    const result = await this.ctx.cli.listModels({
      source: "authorized-endpoint", engineId: probeEngine(endpoint.protocol), executionTarget: { kind: "local" },
      sourceId: this.sourceId, profileKey, targetGrantId: profile.targetGrantId, protocol: profile.protocol,
      ...(credential ? { credentialUse: { sourceId: this.sourceId, credentialId: credential.id, credentialRevision: credential.credentialRevision, registryRevision: this.publication.documentVersion } } : {}),
    });
    const previous = this.discoveries.get(cacheKey);
    if (result.status === "failed" || result.status === "unsupported") return { ...result, models: previous?.models ?? result.models };
    const models = result.status === "partial" && previous ? [...previous.models.filter((p) => !result.models.some((m) => m.modelId === p.modelId)), ...result.models] : result.models;
    const merged = { ...result, models }; this.discoveries.set(cacheKey, merged); return merged;
  }
  /** 拉取回来的候选模型要落到每条 CLI 线路上，所以按线路取各自的官方模板。 */
  async templatesForBindings(bindings: readonly Pick<Binding, "engineId" | "executionTarget">[], refresh = false): Promise<Record<string, DiscoveredModel[]>> {
    const entries = await Promise.all(bindings.map(async (binding) => {
      try { return [binding.engineId, await this.loadTemplates(binding, refresh)] as const; }
      catch { return [binding.engineId, []] as const; }
    }));
    return Object.fromEntries(entries);
  }
  async listConfigTargets(): Promise<NativeConfigTarget[]> { return this.ctx.cli.listConfigTargets(); }
  async previewImport(targetId: string): Promise<NativeConfigPreview> { return this.ctx.cli.previewConfigImport(targetId); }
  async confirmImport(preview: NativeConfigPreview, decisions: ImportDecision[], expectedVersion: string | null): Promise<void> {
    if (expectedVersion !== this.version || this.busy) throw new Error("核对导入内容期间配置已变化，请重新加载并预览");
    const ids = decisions.filter((d) => d.action !== "skip").map((d) => d.candidateId);
    if (!ids.length) throw new Error("请至少选择一个导入候选项");
    const imported = await this.ctx.cli.confirmConfigImport(preview.previewId, ids);
    let next: Registry;
    try { next = mergeImportedCandidates(this.registry, imported.candidates, decisions); }
    finally { for (const candidate of imported.candidates) delete candidate.value; }
    for (const binding of next.bindings.filter((b) => !b.targetGrantId && b.enabled)) {
      const endpoint = next.endpoints.find((e) => e.id === binding.endpointId)!;
      const grant = await this.ctx.cli.requestTargetGrant({
        sourceId: this.sourceId, baseUrl: endpoint.baseUrl, executionTarget: binding.executionTarget,
        credentials: endpoint.auth === "none" ? [] : endpointCredentials(next.credentials, endpoint.id).filter((c) => c.enabled).map(credentialIdentity),
        purpose: "授权导入的 CLI 线路目标；原生文件不会改动",
      });
      binding.targetGrantId = grant.grantId;
    }
    if (expectedVersion !== this.version || this.busy) throw new Error("确认导入期间配置已变化，请重新预览");
    next.revision = this.registry.revision + 1; await this.persistAndPublish(next, expectedVersion);
  }
  async previewPatch(targetId: string): Promise<ConfigPatchPreview> {
    const context = await this.ctx.sessions.getContext();
    if (!context?.selection) throw new Error("请先在聊天中完整选择模型与推理强度");
    const selection: ExecutionSelectionInput = { modelSelection: context.selection.modelSelection, effort: context.selection.effort };
    return this.ctx.cli.previewConfigPatch(targetId, selection);
  }
  async applyPatch(previewId: string): Promise<void> {
    if (this.busy) throw new Error("请等待配置保存完成");
    this.busy = true;
    const previousPhase = this.state.phase;
    this.emit("saving", "正在写入已明确确认的原生补丁…");
    let receipt;
    try { receipt = await this.ctx.cli.applyConfigPatch(previewId); }
    catch { this.emit(previousPhase, "原生补丁被拒绝，请刷新预览后再试。"); throw new Error("原生补丁被拒绝"); }
    finally { this.busy = false; }
    const next = structuredClone(this.registry); next.patchReceipts.push(receipt); next.revision++;
    try { await this.persistAndPublish(next, this.version); }
    catch { this.registry.patchReceipts.push(receipt); this.emit("conflict", `原生补丁已写入，但回执未能保存。请保持本页打开；可通过回执 ${receipt.receiptId} 恢复。恢复补丁或记录回执后再重新加载。`); throw new Error("原生补丁已写入但回执保存失败，请在离开前恢复补丁"); }
  }
  async restorePatch(receiptId: string): Promise<void> {
    if (this.busy) throw new Error("请等待配置保存完成");
    this.busy = true;
    const previousPhase = this.state.phase;
    this.emit("saving", "正在恢复明确选中的原生补丁…");
    try { await this.ctx.cli.restoreConfigPatch(receiptId); }
    catch { this.emit(previousPhase, "原生恢复被拒绝，可能是文件已被外部修改。不要覆盖已变化的文件。"); throw new Error("原生恢复被拒绝"); }
    finally { this.busy = false; }
    const next = structuredClone(this.registry); next.patchReceipts = next.patchReceipts.filter((r) => r.receiptId !== receiptId); next.revision++;
    await this.persistAndPublish(next, this.version);
  }
}
