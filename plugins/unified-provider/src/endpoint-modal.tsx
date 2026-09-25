import { useState } from "react";
import { Badge, Button, Input, Select } from "@ccgui/plugin-ui";
import type { DiscoveredModel, ModelDiscoveryResult } from "@ccgui/plugin-sdk";
import { compatible, endpointCredentials, engines, id, protocolLabels, protocolMarks, protocols, wslUnsupported, type Endpoint, type PolicyOverrides, type RegistryView } from "./registry";
import type { ProviderController } from "./controller";
import { PolicyEditor, type UpdateDraft } from "./fields";
import { Bindings } from "./bindings";

const AUTH_LABELS: Record<Endpoint["auth"], string> = { bearer: "Bearer Key", "api-key": "API Key 头", none: "无需认证" };
const blockedInWsl = (engineId: string): boolean => (wslUnsupported as readonly string[]).includes(engineId);
/** 把 token 数压成角标里的 “272K” 形式；没有明确值就不显示，绝不编造。 */
function short(tokens: number | undefined): string | null {
  if (tokens === undefined) return null;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}
function overrideValue(policy: PolicyOverrides, key: "contextWindowTokens" | "maxOutputTokens"): number | undefined {
  const override = policy[key];
  return override?.kind === "value" ? override.value : undefined;
}

export interface EndpointModalProps {
  endpoint: Endpoint;
  draft: RegistryView;
  documentVersion: string | null;
  keyEdits: Readonly<Record<string, string>>;
  update: UpdateDraft;
  editKey: (credentialId: string, value: string) => void;
  controller: ProviderController;
  replaceDraft: (next: RegistryView, expected: RegistryView) => void;
  onPersisted: () => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}

/** 一个端点 = 一张编辑卡：地址、Key、请求格式在上，模型清单在左，所选模型的参数在右。
 *  CLI 线路、官方模板映射与目标授权收进“高级设置”，默认路径不再需要翻分页。 */
export function EndpointModal({ endpoint, draft, documentVersion, keyEdits, update, editKey, controller, replaceDraft, onPersisted, onCancel, onSave, busy }: EndpointModalProps) {
  const [advanced, setAdvanced] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [discovery, setDiscovery] = useState<ModelDiscoveryResult | null>(null);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState("");

  const credentials = endpointCredentials(draft.credentials, endpoint.id);
  const primaryKey = credentials.find((c) => c.id === endpoint.defaultCredentialId) ?? credentials[0];
  const bindings = draft.bindings.filter((b) => b.endpointId === endpoint.id);
  const activeBindings = bindings.filter((b) => b.enabled);
  const providerModels = draft.models.filter((m) => m.providerId === endpoint.providerId);
  const ownModels = providerModels.filter((m) => m.wireIds[endpoint.id] !== undefined);
  const otherModels = providerModels.filter((m) => m.wireIds[endpoint.id] === undefined);
  const selected = providerModels.find((m) => m.id === selectedModel);

  /** 授权覆盖的是准确目标：地址、协议、认证或 Key 集合一变，全部授权立即作废。 */
  function revoke(next: RegistryView): void {
    delete next.endpoints.find((e) => e.id === endpoint.id)!.probeGrantId;
    for (const binding of next.bindings.filter((b) => b.endpointId === endpoint.id)) delete binding.targetGrantId;
  }
  function edit(change: (endpoint: Endpoint, next: RegistryView) => void): void {
    update((next) => { change(next.endpoints.find((e) => e.id === endpoint.id)!, next); revoke(next); });
  }
  /** 分组名同时是端点名与供应商名：这条流程里两者一一对应，不让用户维护两个名字。 */
  function rename(name: string): void {
    update((next) => {
      next.endpoints.find((e) => e.id === endpoint.id)!.name = name;
      const siblings = next.endpoints.filter((e) => e.providerId === endpoint.providerId);
      if (siblings.length === 1) next.providers.find((p) => p.id === endpoint.providerId)!.name = name;
    });
  }
  function writeKey(value: string): void {
    if (primaryKey) { editKey(primaryKey.id, value); return; }
    const credentialId = id();
    update((next) => {
      next.credentials.push({ id: credentialId, endpointId: endpoint.id, name: "API Key", enabled: true, credentialRevision: 1 });
      next.endpoints.find((e) => e.id === endpoint.id)!.defaultCredentialId = credentialId;
      revoke(next);
    });
    editKey(credentialId, value);
  }
  function mappingsFor(view: RegistryView, modelId: string) {
    const ids = view.bindings.filter((b) => b.endpointId === endpoint.id).map((b) => b.id);
    return view.mappings.filter((m) => ids.includes(m.bindingId) && m.providerModelId === modelId);
  }
  function toggleModel(modelId: string, on: boolean): void {
    update((next) => { for (const mapping of mappingsFor(next, modelId)) mapping.enabled = on; });
  }
  /** 拉取分两步落盘：宿主要求“已发布 + 已授权”才肯发请求，所以先保存发布该端点，
   *  再把返回的候选模型连同同名官方模板一起存进 registry。候选默认不启用。 */
  async function pull(): Promise<void> {
    setPulling(true); setError("");
    try {
      const { result, draft: saved } = await controller.pullEndpointModels(draft, documentVersion, keyEdits, endpoint.id);
      setDiscovery(result);
      onPersisted();
      const templates = await controller.templatesForBindings(saved.bindings.filter((b) => b.endpointId === endpoint.id && b.enabled), true);
      const next = structuredClone(saved);
      for (const candidate of result.models) {
        if (candidate.protocol && candidate.protocol !== endpoint.protocol) continue;
        if (next.models.some((m) => m.providerId === endpoint.providerId && m.wireIds[endpoint.id] === candidate.modelId)) continue;
        const modelId = id();
        next.models.push({
          id: modelId, providerId: endpoint.providerId, name: candidate.label ?? candidate.modelId,
          wireIds: { [endpoint.id]: candidate.modelId }, sharedPolicy: {}, capabilities: candidate.capabilities,
        });
        for (const binding of next.bindings.filter((b) => b.endpointId === endpoint.id && b.enabled)) {
          const templateRef = (templates[binding.engineId] ?? []).find((t) => t.templateRef?.modelId === candidate.modelId)?.templateRef;
          if (!templateRef) continue;
          next.mappings.push({ id: id(), bindingId: binding.id, providerModelId: modelId, templateRef, selector: { kind: "wire" }, policy: {}, enabled: false });
        }
      }
      await controller.save(next, controller.snapshot().documentVersion, {});
      onPersisted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "拉取模型失败。请核对地址、认证方式与 Key；没有尝试替换 Key，已有模型也没有被删除。");
    } finally { setPulling(false); }
  }
  function addManualModel(): void {
    const wireId = search.trim();
    if (!wireId) { setError("请先在搜索框里填入要手动添加的模型 ID。"); return; }
    if (ownModels.some((m) => m.wireIds[endpoint.id] === wireId)) { setError(`${wireId} 已在清单中。`); return; }
    const modelId = id();
    setError("");
    update((next) => {
      next.models.push({ id: modelId, providerId: endpoint.providerId, name: wireId, wireIds: { [endpoint.id]: wireId }, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } });
    });
    setSelectedModel(modelId); setSearch("");
  }

  const visible = ownModels.filter((m) => `${m.name} ${m.wireIds[endpoint.id]}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const enabledCount = ownModels.filter((m) => mappingsFor(draft, m.id).some((mapping) => mapping.enabled)).length;

  return <div className="up-scrim" role="dialog" aria-modal="true" aria-label={`编辑供应商 ${endpoint.name}`}>
    <section className="up-modal up">
      <div className="up-modal-head">
        <div className="up-modal-title"><span className="up-mark" aria-hidden="true">{protocolMarks[endpoint.protocol]}</span><h2>编辑供应商</h2><Badge tone="neutral">{protocolLabels[endpoint.protocol]}</Badge></div>
        <div className="up-actions">
          <Button size="sm" aria-pressed={advanced} onClick={() => setAdvanced(!advanced)}>高级设置</Button>
          <Button size="sm" disabled={busy || pulling} onClick={onCancel}>取消</Button>
          <Button size="sm" variant="primary" disabled={busy || pulling} onClick={onSave}>保存</Button>
        </div>
      </div>

      <fieldset className="up-editor-boundary" disabled={busy || pulling}>
        <div className="up-grid">
          <label>服务类型<Select value={endpoint.protocol} onChange={(event) => edit((target, next) => {
            target.protocol = event.target.value as typeof endpoint.protocol;
            // 协议变了可能让某些 CLI 不再兼容：停用而不是删除，已维护的映射留着等你确认。
            for (const binding of next.bindings.filter((b) => b.endpointId === endpoint.id && !compatible(b.engineId, target.protocol))) binding.enabled = false;
          })}>{protocols.map((protocol) => <option key={protocol} value={protocol}>{protocolLabels[protocol]}</option>)}</Select></label>
          <label>完整 Base URL<Input type="url" placeholder="https://api.example.com/v1" value={endpoint.baseUrl} onChange={(event) => edit((target) => { target.baseUrl = event.target.value; })} /></label>
          <label>分组名称<Input value={endpoint.name} onChange={(event) => rename(event.target.value)} /></label>
          <label>认证方式<Select value={endpoint.auth} onChange={(event) => edit((target, next) => {
            target.auth = event.target.value as typeof endpoint.auth;
            // 无需认证的端点不持有任何 Key 引用：清掉默认与各线路的显式选择，Key 本身保留。
            if (target.auth !== "none") return;
            delete target.defaultCredentialId;
            for (const binding of next.bindings.filter((b) => b.endpointId === endpoint.id)) binding.credential = { kind: "inherit" };
          })}>{(Object.keys(AUTH_LABELS) as Endpoint["auth"][]).map((auth) => <option key={auth} value={auth}>{AUTH_LABELS[auth]}</option>)}</Select></label>
        </div>

        {endpoint.auth === "none" ? <p className="up-muted">该端点声明无需认证，不使用任何 Key。</p> : <div className="up-keyrow">
          <label>API Key<Input type={revealKey ? "text" : "password"} autoComplete="new-password" spellCheck={false}
            placeholder={primaryKey ? "已保存的值不会回显，填入新值即替换" : "填入这个端点自己的 Key"}
            value={primaryKey ? keyEdits[primaryKey.id] ?? "" : ""} onChange={(event) => writeKey(event.target.value)} /></label>
          <Button size="sm" aria-pressed={revealKey} onClick={() => setRevealKey(!revealKey)}>{revealKey ? "隐藏" : "显示"}</Button>
        </div>}
        <p className="up-muted">Key 属于这个端点，和地址填在一起。明文只存在插件私有的 registry.json，请自行保护文件权限与备份；界面、发布内容和事件里只出现名称与备注。改 Key 值会产生新代次，需要重新授权。{credentials.length > 1 && ` 这个端点有 ${credentials.length} 个 Key，多 Key 管理在高级设置里。`}</p>

        <div className="up-models">
          <div>
            <div className="up-model-toolbar">
              <label className="up-model-search">搜索模型<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按名称或模型 ID 过滤，也用作手动添加的 ID" /></label>
              <Button size="sm" disabled={pulling || !endpoint.baseUrl} onClick={() => void pull()}>{pulling ? "正在拉取…" : "刷新模型列表"}</Button>
              <Button size="sm" onClick={addManualModel}>手动添加</Button>
            </div>
            {discovery && <p className="up-muted" role="status">拉取结果：{discovery.status === "complete" ? "完整" : discovery.status === "partial" ? "部分" : discovery.status === "unsupported" ? "不支持" : "失败"} · {new Date(discovery.observedAt).toLocaleString()} · 端点返回 {discovery.models.length} 个模型</p>}
            <div className="up-model-total">
              <input type="checkbox" aria-label="启用或停用全部模型" checked={!!ownModels.length && enabledCount === ownModels.length}
                onChange={(event) => update((next) => { for (const model of ownModels) for (const mapping of mappingsFor(next, model.id)) mapping.enabled = event.target.checked; })} />
              <span>已启用 {enabledCount} / {ownModels.length} 个模型</span>
            </div>
            {!!ownModels.length && !activeBindings.length && <p className="up-error" role="alert">这个端点没有启用任何 CLI 线路，上面启用的模型不会出现在模型菜单里。请在「高级设置」里启用一条。</p>}
            <div className="up-model-list">
              {!ownModels.length && <p className="up-muted">还没有模型。填好地址与 Key 后点“刷新模型列表”，或用搜索框填入 ID 后“手动添加”。</p>}
              {visible.map((model) => {
                const mappings = mappingsFor(draft, model.id);
                const ctx = short(overrideValue(model.sharedPolicy, "contextWindowTokens"));
                const out = short(overrideValue(model.sharedPolicy, "maxOutputTokens"));
                return <div className="up-model-row" key={model.id} aria-selected={selectedModel === model.id}>
                  <input type="checkbox" aria-label={`启用 ${model.name}`} checked={mappings.some((m) => m.enabled)} disabled={!mappings.length}
                    onChange={(event) => toggleModel(model.id, event.target.checked)} />
                  <button type="button" className="up-model-name" onClick={() => setSelectedModel(model.id)}>{model.name}</button>
                  <span className="up-chip">{!mappings.length ? "无官方模板 · 见高级设置" : [ctx && `${ctx} ctx`, out && `${out} out`].filter(Boolean).join(" · ") || "继承官方模板"}</span>
                  <Button size="sm" variant="ghost" onClick={() => update((next) => { next.models = next.models.filter((m) => m.id !== model.id); next.mappings = next.mappings.filter((m) => m.providerModelId !== model.id); for (const binding of next.bindings) if (binding.defaultModelId === model.id) delete binding.defaultModelId; })}>删除</Button>
                </div>;
              })}
              {!!otherModels.length && <><p className="up-muted">该供应商下还有 {otherModels.length} 个模型没有配置这个端点的模型 ID：</p>
                {otherModels.map((model) => <div className="up-model-row" key={model.id} aria-selected={selectedModel === model.id}>
                  <span aria-hidden="true" />
                  <button type="button" className="up-model-name" onClick={() => setSelectedModel(model.id)}>{model.name}</button>
                  <span className="up-chip">未映射到此端点</span>
                  <span aria-hidden="true" />
                </div>)}</>}
            </div>
          </div>

          <aside className="up-param-pane" aria-label="模型参数">
            <h3>模型参数</h3>
            {!selected ? <p className="up-muted">在左侧点一个模型，这里编辑它的模型 ID、能力与 token 策略。</p> : <>
              <p className="up-muted">{selected.wireIds[endpoint.id] ?? "未映射到此端点"}</p>
              <label>显示名<Input value={selected.name} onChange={(event) => update((next) => { next.models.find((m) => m.id === selected.id)!.name = event.target.value; })} /></label>
              <label>该端点的模型 ID<Input value={selected.wireIds[endpoint.id] ?? ""} placeholder="留空表示不在此端点提供该模型" onChange={(event) => update((next) => {
                const model = next.models.find((m) => m.id === selected.id)!;
                if (event.target.value) model.wireIds[endpoint.id] = event.target.value; else delete model.wireIds[endpoint.id];
              })} /></label>
              {([["images", "输入图片能力"], ["tools", "工具调用能力"]] as const).map(([capability, label]) => <label key={capability}>{label}<Select value={selected.capabilities[capability]} onChange={(event) => update((next) => { next.models.find((m) => m.id === selected.id)!.capabilities[capability] = event.target.value as typeof selected.capabilities.images; })}><option value="unknown">自动推断 · 继承官方模板</option><option value="supported">支持</option><option value="unsupported">不支持</option></Select></label>)}
              <label>可用推理强度 · 逗号分隔，留空继承官方模板<Input value={selected.capabilities.effortLevels.join(",")} onChange={(event) => update((next) => { next.models.find((m) => m.id === selected.id)!.capabilities.effortLevels = event.target.value.split(",").map((v) => v.trim()).filter(Boolean); })} /></label>
              <PolicyEditor scope="模型共享策略" value={selected.sharedPolicy} onChange={(value) => update((next) => { next.models.find((m) => m.id === selected.id)!.sharedPolicy = value; })} />
            </>}
          </aside>
        </div>

        {advanced && <section className="up-stack">
          <h3>高级设置</h3>
          <section className="up-card"><h4>使用这条线路的 CLI</h4>
            <p className="up-muted">勾选即在此端点上建立该 CLI 的线路。执行环境属于 CLI 进程，所以逐行设置。{protocolLabels[endpoint.protocol]} 之外的 CLI 请保留原生模型，本插件不做协议代理。</p>
            {engines.filter((engineId) => compatible(engineId, endpoint.protocol)).map((engineId) => {
              const binding = bindings.find((b) => b.engineId === engineId);
              return <div className="up-policy-row" key={engineId}>
                <label className="up-check"><input type="checkbox" checked={!!binding?.enabled} onChange={(event) => update((next) => {
                  const existing = next.bindings.find((b) => b.endpointId === endpoint.id && b.engineId === engineId);
                  if (!event.target.checked) { if (existing) existing.enabled = false; return; }
                  if (existing) { existing.enabled = true; return; }
                  next.bindings.push({ id: id(), providerId: endpoint.providerId, engineId, endpointId: endpoint.id, credential: { kind: "inherit" }, executionTarget: { kind: "local" }, options: {}, enabled: true });
                })} />{engineId}</label>
                {binding?.enabled && <>
                  <label>执行环境<Select value={binding.executionTarget.kind} onChange={(event) => update((next) => { const target = next.bindings.find((b) => b.id === binding.id)!; target.executionTarget = event.target.value === "local" ? { kind: "local" } : { kind: "wsl", hostId: "", distro: "" }; delete target.targetGrantId; })}><option value="local">本机</option><option value="wsl" disabled={blockedInWsl(engineId)}>WSL · 需单独授权</option></Select></label>
                  {binding.executionTarget.kind === "wsl" && <><label>WSL 主机 ID<Input value={binding.executionTarget.hostId} onChange={(event) => update((next) => { const target = next.bindings.find((b) => b.id === binding.id)!; if (target.executionTarget.kind === "wsl") target.executionTarget.hostId = event.target.value; delete target.targetGrantId; })} /></label>
                  <label>WSL 发行版<Input value={binding.executionTarget.distro} onChange={(event) => update((next) => { const target = next.bindings.find((b) => b.id === binding.id)!; if (target.executionTarget.kind === "wsl") target.executionTarget.distro = event.target.value; delete target.targetGrantId; })} /></label></>}
                  <span className="up-muted">{binding.targetGrantId ? "已授权" : "发布前需授权"}</span>
                  {!binding.targetGrantId && <Button size="sm" variant="ghost" onClick={() => { setError(""); void controller.authorizeBindingDraft(draft, binding.id).then((next) => replaceDraft(next, draft)).catch((e) => setError(e instanceof Error ? e.message : "未获得目标授权，没有向端点发送任何请求。")); }}>授权这条线路</Button>}
                </>}
              </div>;
            })}
          </section>

          <section className="up-card"><div className="up-toolbar"><h4>这个端点的 Key</h4><Button size="sm" disabled={endpoint.auth === "none"} onClick={() => { const credentialId = id(); update((next) => { next.credentials.push({ id: credentialId, endpointId: endpoint.id, name: "新 Key", enabled: true, credentialRevision: 1 }); revoke(next); }); }}>新增 Key</Button></div>
            <p className="up-muted">读取授权：{endpoint.probeGrantId ? "已授权当前地址与 Key 代次" : "尚未授权，拉取模型时会请求一次"}。</p>
            {credentials.map((credential) => <fieldset className="up-card" key={credential.id}><legend>{credential.name} · •••••••• · 第 {credential.credentialRevision} 代{endpoint.defaultCredentialId === credential.id ? " · 默认" : ""}</legend>
              <div className="up-grid"><label>名称<Input value={credential.name} onChange={(event) => update((next) => { next.credentials.find((c) => c.id === credential.id)!.name = event.target.value; })} /></label>
              <label>备注<Input value={credential.remark ?? ""} onChange={(event) => update((next) => { next.credentials.find((c) => c.id === credential.id)!.remark = event.target.value; })} /></label>
              <label>Key 值 · 已保存的值永不回显<Input type="password" autoComplete="new-password" spellCheck={false} value={keyEdits[credential.id] ?? ""} onChange={(event) => editKey(credential.id, event.target.value)} /></label>
              <label className="up-check"><input type="checkbox" checked={credential.enabled} onChange={(event) => update((next) => { next.credentials.find((c) => c.id === credential.id)!.enabled = event.target.checked; revoke(next); })} />启用</label></div>
              <Button size="sm" variant="ghost" onClick={() => update((next) => {
                next.credentials = next.credentials.filter((c) => c.id !== credential.id);
                const target = next.endpoints.find((e) => e.id === endpoint.id)!;
                if (target.defaultCredentialId === credential.id) delete target.defaultCredentialId;
                // 删掉被显式选中的 Key 就停用那条线路：绝不静默换一个 Key 继续跑。
                for (const binding of next.bindings.filter((b) => b.endpointId === endpoint.id)) {
                  if (binding.credential.kind === "explicit" && binding.credential.credentialId === credential.id) { binding.credential = { kind: "inherit" }; binding.enabled = false; }
                }
                revoke(next);
              })}>删除该 Key</Button>
            </fieldset>)}
            {endpoint.auth !== "none" && <label>默认 Key · CLI 线路未单独指定时使用<Select value={endpoint.defaultCredentialId ?? ""} onChange={(event) => update((next) => { const target = next.endpoints.find((e) => e.id === endpoint.id)!; if (event.target.value) target.defaultCredentialId = event.target.value; else delete target.defaultCredentialId; })}><option value="">不设默认 · 只有一个启用 Key 时直接用它</option>{credentials.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.remark ?? "无备注"}</option>)}</Select></label>}
          </section>

          <Bindings providerId={endpoint.providerId} draft={draft} update={update} controller={controller} />
        </section>}
      </fieldset>

      {error && <p role="alert" className="up-error">{error}</p>}
      <p className="up-muted">“刷新模型列表”需要宿主先发布并授权这个端点，所以它会立即保存这份草稿；其后的编辑仍可用“取消”丢弃。原生 CLI 文件不会被改动。</p>
    </section>
  </div>;
}
