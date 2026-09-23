import { useState } from "react";
import { Button, Input, Select, Textarea } from "@ccgui/plugin-ui";
import type { DiscoveredModel, ModelDiscoveryResult } from "@ccgui/plugin-sdk";
import { compatible, engines, id, policyKeys, type Binding, type PolicyOverrides, type RegistryView } from "./registry";
import { PolicyEditor, type UpdateDraft } from "./fields";
import type { ProviderController } from "./controller";
import { enginePolicies } from "./projection";

const DISCOVERY_STATUS: Record<ModelDiscoveryResult["status"], string> = { complete: "完整", partial: "部分", unsupported: "不支持", failed: "失败" };
const MODEL_EVIDENCE: Record<DiscoveredModel["evidence"], string> = { official: "官方模板", endpoint: "端点返回", unknown: "来源未知" };

export function BindingEditor({ binding, draft, update, controller, replaceDraft }: { binding: Binding; draft: RegistryView; update: UpdateDraft; controller: ProviderController; replaceDraft: (draft: RegistryView, expected: RegistryView) => void }) {
  const [templates, setTemplates] = useState<DiscoveredModel[]>(controller.templatesFor(binding));
  const [templateIndex, setTemplateIndex] = useState("");
  const [modelId, setModelId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [discovery, setDiscovery] = useState<ModelDiscoveryResult | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = draft.endpoints.find((e) => e.id === binding.endpointId);
  const template = templates[Number(templateIndex)];
  const models = draft.models.filter((m) => m.providerId === binding.providerId);
  const mappings = draft.mappings.filter((m) => m.bindingId === binding.id);
  async function perform(action: () => Promise<void>, message: string) { setBusy(true); setError(""); try { await action(); } catch { setError(message); } finally { setBusy(false); } }
  return <fieldset className="up-card" disabled={busy}><legend>{binding.engineId} · {endpoint?.name ?? "请选择端点"}</legend>
    <div className="up-grid"><label className="up-check"><input type="checkbox" checked={binding.enabled} onChange={(event) => update((r) => { r.bindings.find((b) => b.id === binding.id)!.enabled = event.target.checked; })} />启用</label>
      <label>端点<Select value={binding.endpointId} onChange={(event) => update((r) => { const b = r.bindings.find((b) => b.id === binding.id)!; b.endpointId = event.target.value; delete b.targetGrantId; })}>{draft.endpoints.filter((e) => e.providerId === binding.providerId).map((e) => <option value={e.id} key={e.id}>{e.name} · {e.protocol}</option>)}</Select></label>
      <label>绑定默认 Key<Select value={binding.credential.kind === "explicit" ? binding.credential.credentialId : ""} onChange={(event) => update((r) => { r.bindings.find((b) => b.id === binding.id)!.credential = event.target.value ? { kind: "explicit", credentialId: event.target.value } : { kind: "inherit" }; })}><option value="">明确绑定时继承供应商默认 Key</option>{draft.credentials.filter((c) => c.providerId === binding.providerId && c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.remark ?? "无备注"}</option>)}</Select></label>
      <label>推荐模型 · 明确选择该供应商时优先显示<Select value={binding.defaultModelId ?? ""} onChange={(event) => update((r) => { r.bindings.find((b) => b.id === binding.id)!.defaultModelId = event.target.value || undefined; })}><option value="">不设推荐</option>{models.filter((m) => mappings.some((mapping) => mapping.providerModelId === m.id && mapping.enabled)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>
      <label>执行环境<Select value={binding.executionTarget.kind} onChange={(event) => { setTemplates([]); setTemplateIndex(""); update((r) => { const b = r.bindings.find((b) => b.id === binding.id)!; b.executionTarget = event.target.value === "local" ? { kind: "local" } : { kind: "wsl", hostId: "", distro: "" }; delete b.targetGrantId; }); }}><option value="local">本机</option><option value="wsl">WSL · 需单独授权</option></Select></label>
      {binding.executionTarget.kind === "wsl" && <><label>WSL 主机 ID<Input value={binding.executionTarget.hostId} onChange={(event) => update((r) => { const b = r.bindings.find((b) => b.id === binding.id)!; if (b.executionTarget.kind === "wsl") b.executionTarget.hostId = event.target.value; delete b.targetGrantId; })} /></label><label>WSL 发行版<Input value={binding.executionTarget.distro} onChange={(event) => update((r) => { const b = r.bindings.find((b) => b.id === binding.id)!; if (b.executionTarget.kind === "wsl") b.executionTarget.distro = event.target.value; delete b.targetGrantId; })} /></label></>}
    </div>
    {endpoint && !compatible(binding.engineId, endpoint.protocol) && <p role="alert" className="up-error">该 CLI 不支持 {endpoint.protocol}。请保留原生模型，或选择兼容的端点；本插件不提供协议代理。</p>}
    {enginePolicies[binding.engineId] && <p className="up-muted">CLI token 策略：需显式清空不支持的字段（{enginePolicies[binding.engineId].unsupported.join("、") || "无"}）；必须明确填写的字段（{enginePolicies[binding.engineId].required.join("、") || "无"}）。不会自动编造未知值。</p>}
    <p className="up-muted">目标授权：{binding.targetGrantId ? "已授权记录的 URL、执行环境及 Key 代次" : "发布前需要授权"}。修改 Key 值后需要重新授权。</p>
    <div className="up-toolbar"><Button disabled={busy} onClick={() => void perform(async () => { replaceDraft(await controller.authorizeDraft(draft, binding.id), draft); }, "未获得目标授权，没有向端点发送任何请求。")}>授权此目标</Button><Button disabled={busy} onClick={() => void perform(async () => { setTemplates(await controller.loadTemplates(binding, true)); setTemplateIndex(""); }, "无法加载该 CLI 与执行环境的官方模板，已有映射已保留。")}>刷新官方模板</Button></div>
    <details><summary>CLI 选项 · 仅限显式、非敏感配置</summary><div className="up-grid">
      <label>服务等级<Select value={binding.options.serviceTier ?? ""} onChange={(event) => update((r) => { const options = r.bindings.find((b) => b.id === binding.id)!.options; if (event.target.value) options.serviceTier = event.target.value as "default" | "priority"; else delete options.serviceTier; })}><option value="">不注入</option><option value="default">默认</option><option value="priority">优先</option></Select></label>
      <label>始终启用思考<Select value={binding.options.alwaysThinkingEnabled === undefined ? "" : String(binding.options.alwaysThinkingEnabled)} onChange={(event) => update((r) => { const options = r.bindings.find((b) => b.id === binding.id)!.options; if (event.target.value) options.alwaysThinkingEnabled = event.target.value === "true"; else delete options.alwaysThinkingEnabled; })}><option value="">不注入</option><option value="true">启用</option><option value="false">禁用</option></Select></label>
      <label>非敏感请求头 · 每行格式为“名称: 值”<Textarea value={Object.entries(binding.options.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n")} onChange={(event) => update((r) => { const headers: Record<string, string> = {}; for (const line of event.target.value.split("\n").filter(Boolean)) { const colon = line.indexOf(":"); headers[colon < 0 ? line : line.slice(0, colon).trim()] = colon < 0 ? "" : line.slice(colon + 1).trim(); } r.bindings.find((b) => b.id === binding.id)!.options.headers = headers; })} /></label></div></details>
    <h4>官方模板模型映射</h4><p className="up-muted">先选择官方模板，再映射逻辑模型。更换模板必须明确操作，模板默认值不会复制进 registry.json。</p>
    <div className="up-grid"><label>官方模板<Select value={templateIndex} onChange={(event) => setTemplateIndex(event.target.value)}><option value="">请选择模板</option>{templates.map((t, index) => <option key={`${t.modelId}:${t.templateRef?.revision}`} value={index}>{t.label ?? t.modelId} · {t.templateRef?.revision.slice(0, 8)}</option>)}</Select></label>
    <label>尚未映射的供应商模型<Select value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">请选择模型</option>{models.filter((m) => !mappings.some((mapping) => mapping.providerModelId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></label></div>
    <Button size="sm" disabled={!modelId || templateIndex === "" || !template?.templateRef} onClick={() => { update((r) => { r.mappings.push({ id: id(), bindingId: binding.id, providerModelId: modelId, templateRef: template!.templateRef!, selector: { kind: "wire" }, policy: {}, enabled: true }); }); setModelId(""); }}>向草稿添加映射</Button>
    {mappings.map((mapping) => { const model = models.find((m) => m.id === mapping.providerModelId)!; const activeTemplate = templates.find((t) => t.templateRef?.modelId === mapping.templateRef.modelId && t.templateRef?.revision === mapping.templateRef.revision); return <fieldset className="up-card" key={mapping.id}><legend>{model.name} → {model.wireIds[binding.endpointId] ?? "缺少 wire 模型 ID"}</legend>
      <label className="up-check"><input type="checkbox" checked={mapping.enabled} onChange={(event) => update((r) => { r.mappings.find((m) => m.id === mapping.id)!.enabled = event.target.checked; const b = r.bindings.find((b) => b.id === binding.id)!; if (!event.target.checked && b.defaultModelId === mapping.providerModelId) delete b.defaultModelId; })} />在模型菜单中显示</label>
      <p className="up-muted">模板 {mapping.templateRef.modelId} · 版本 {mapping.templateRef.revision.slice(0, 12)}{!activeTemplate && " · 若已不可用，请刷新并明确选择替代模板"}</p>
      <Button size="sm" disabled={templateIndex === "" || !template?.templateRef} onClick={() => update((r) => { r.mappings.find((m) => m.id === mapping.id)!.templateRef = template!.templateRef!; })}>使用选中的官方模板</Button>
      <div className="up-grid"><label>模型选择方式<Select value={mapping.selector.kind} onChange={(event) => update((r) => { r.mappings.find((m) => m.id === mapping.id)!.selector = event.target.value === "wire" ? { kind: "wire" } : { kind: "alias", alias: "" }; })}><option value="wire">wire 模型 ID</option><option value="alias">独立 CLI 别名</option></Select></label>
      {mapping.selector.kind === "alias" && <label>别名<Input value={mapping.selector.alias} onChange={(event) => update((r) => { r.mappings.find((m) => m.id === mapping.id)!.selector = { kind: "alias", alias: event.target.value }; })} /></label>}</div>
      <PolicyEditor scope="CLI 映射覆盖" value={mapping.policy} shared={model.sharedPolicy} official={activeTemplate?.tokenPolicy} onChange={(value) => update((r) => { r.mappings.find((m) => m.id === mapping.id)!.policy = value; })} />
      <Button variant="ghost" size="sm" onClick={() => update((r) => { r.mappings = r.mappings.filter((m) => m.id !== mapping.id); })}>从草稿中删除该映射</Button>
    </fieldset>; })}
    <details><summary>从已授权端点发现模型</summary><p className="up-muted">使用已保存、已发布的绑定和一个明确选择的 Key。候选项只保留在内存中；发现失败或结果不完整不会删除已维护的模型。</p>
      <label>发现模型所用 Key<Select value={keyId} onChange={(event) => setKeyId(event.target.value)}><option value="">明确使用已保存绑定的默认 Key</option>{draft.credentials.filter((c) => c.providerId === binding.providerId && c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.remark ?? "无备注"}</option>)}</Select></label>
      <Button disabled={busy} onClick={() => void perform(async () => { setDiscovery(await controller.discover(binding.id, keyId || undefined)); setChecked([]); }, "模型发现失败。请检查已保存的发布内容、目标授权和所选 Key；没有尝试替换 Key。")}>发现候选模型</Button>
      {discovery && <><p role="status">发现结果：{DISCOVERY_STATUS[discovery.status]} · {new Date(discovery.observedAt).toLocaleString()}{discovery.status === "failed" && " · 已保留此前的候选项"}</p>{discovery.models.map((candidate) => <label className="up-check" key={candidate.modelId}><input type="checkbox" checked={checked.includes(candidate.modelId)} onChange={(event) => setChecked(event.target.checked ? [...checked, candidate.modelId] : checked.filter((m) => m !== candidate.modelId))} />{candidate.label ?? candidate.modelId} · {MODEL_EVIDENCE[candidate.evidence]} · 上下文 {candidate.tokenPolicy.contextWindowTokens ?? "未知"}</label>)}
        <Button disabled={!checked.length || templateIndex === "" || !template?.templateRef || discovery.status === "unsupported"} onClick={() => {
          update((r) => { for (const candidate of discovery.models.filter((c) => checked.includes(c.modelId))) { if (candidate.protocol && endpoint?.protocol !== candidate.protocol) throw new Error("候选模型的协议与绑定端点不一致"); const modelId = id(); const sharedPolicy: PolicyOverrides = {}; for (const key of policyKeys) if (candidate.tokenPolicy[key] !== undefined) sharedPolicy[key] = { kind: "value", value: candidate.tokenPolicy[key]! }; r.models.push({ id: modelId, providerId: binding.providerId, name: candidate.label ?? candidate.modelId, wireIds: { [binding.endpointId]: candidate.modelId }, sharedPolicy, capabilities: candidate.capabilities }); r.mappings.push({ id: id(), bindingId: binding.id, providerModelId: modelId, templateRef: template!.templateRef!, selector: { kind: "wire" }, policy: {}, enabled: true }); } }); setChecked([]);
        }}>添加选中的候选模型并映射到所选模板</Button></>}
    </details>
    {error && <p role="alert" className="up-error">{error}</p>}
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => update((r) => { r.bindings = r.bindings.filter((b) => b.id !== binding.id); r.mappings = r.mappings.filter((m) => m.bindingId !== binding.id); })}>从草稿中删除该 CLI 绑定</Button>
  </fieldset>;
}

export function Bindings({ providerId, draft, update, controller, replaceDraft }: { providerId: string; draft: RegistryView; update: UpdateDraft; controller: ProviderController; replaceDraft: (draft: RegistryView, expected: RegistryView) => void }) {
  const [engine, setEngine] = useState("");
  const endpoint = draft.endpoints.find((e) => e.providerId === providerId);
  return <div className="up-stack"><h3>CLI 映射</h3><div className="up-toolbar"><label>新增 CLI 绑定<Select value={engine} onChange={(event) => setEngine(event.target.value)}><option value="">请选择 CLI</option>{engines.filter((engineId) => !draft.bindings.some((b) => b.providerId === providerId && b.engineId === engineId)).map((engineId) => <option key={engineId}>{engineId}</option>)}</Select></label><Button disabled={!engine || !endpoint} onClick={() => { update((r) => { r.bindings.push({ id: id(), providerId, engineId: engine, endpointId: endpoint!.id, enabled: true, credential: { kind: "inherit" }, executionTarget: { kind: "local" }, options: {} }); }); setEngine(""); }}>添加绑定</Button></div>
    {!endpoint && <p>请先在“详情与 Key”中添加端点。</p>}
    <p className="up-muted">DSH、Agy、Qoder 与 Qoder CN 保留原生能力；不受支持的供应商与协议绑定无法发布。</p>
    {draft.bindings.filter((b) => b.providerId === providerId).map((binding) => <BindingEditor key={binding.id} binding={binding} draft={draft} update={update} controller={controller} replaceDraft={replaceDraft} />)}
  </div>;
}
