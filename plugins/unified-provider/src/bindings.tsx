import { useState } from "react";
import { Button, Input, Select, Textarea } from "@ccgui/plugin-ui";
import type { DiscoveredModel } from "@ccgui/plugin-sdk";
import { compatible, endpointCredentials, id, type Binding, type RegistryView } from "./registry";
import { PolicyEditor, type UpdateDraft } from "./fields";
import type { ProviderController } from "./controller";
import { enginePolicies } from "./projection";

/** 这一页只管「模型怎么映射到官方模板」和 CLI 自己的选项。地址、Key、执行环境
 *  和拉取模型都在端点卡片里完成，不在这里重复一遍。 */
export function BindingEditor({ binding, draft, update, controller }: { binding: Binding; draft: RegistryView; update: UpdateDraft; controller: ProviderController }) {
  const [templates, setTemplates] = useState<DiscoveredModel[]>(controller.templatesFor(binding));
  const [templateIndex, setTemplateIndex] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = draft.endpoints.find((e) => e.id === binding.endpointId);
  const template = templates[Number(templateIndex)];
  const models = draft.models.filter((m) => m.providerId === binding.providerId);
  const mappings = draft.mappings.filter((m) => m.bindingId === binding.id);
  const credentials = endpoint ? endpointCredentials(draft.credentials, endpoint.id) : [];
  return <fieldset className="up-card" disabled={busy}><legend>{binding.engineId} · {endpoint?.name ?? "端点已删除"}{binding.enabled ? "" : " · 已停用"}</legend>
    <p className="up-muted">线路目标：{endpoint?.baseUrl || "未填地址"} · {endpoint?.protocol ?? "未知协议"} · {binding.executionTarget.kind === "wsl" ? `WSL ${binding.executionTarget.distro || "未填发行版"}` : "本机"}。要改地址、Key、执行环境或重新授权，请回到“端点与 Key”。</p>
    {endpoint && !compatible(binding.engineId, endpoint.protocol) && <p role="alert" className="up-error">该 CLI 不支持 {endpoint.protocol}。请在端点卡片里改协议或取消勾选该 CLI；本插件不提供协议代理。</p>}
    <div className="up-grid">
      <label className="up-check"><input type="checkbox" checked={binding.enabled} onChange={(event) => update((r) => { r.bindings.find((b) => b.id === binding.id)!.enabled = event.target.checked; })} />启用这条线路</label>
      {endpoint?.auth !== "none" && <label>这条线路使用的 Key<Select value={binding.credential.kind === "explicit" ? binding.credential.credentialId : ""} onChange={(event) => update((r) => { r.bindings.find((b) => b.id === binding.id)!.credential = event.target.value ? { kind: "explicit", credentialId: event.target.value } : { kind: "inherit" }; })}><option value="">跟随端点的默认 Key</option>{credentials.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.remark ?? "无备注"}</option>)}</Select></label>}
      <label>推荐模型 · 明确选择该供应商时优先显示<Select value={binding.defaultModelId ?? ""} onChange={(event) => update((r) => { r.bindings.find((b) => b.id === binding.id)!.defaultModelId = event.target.value || undefined; })}><option value="">不设推荐</option>{models.filter((m) => mappings.some((mapping) => mapping.providerModelId === m.id && mapping.enabled)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>
    </div>
    {enginePolicies[binding.engineId] && <p className="up-muted">CLI token 策略：需显式清空不支持的字段（{enginePolicies[binding.engineId].unsupported.join("、") || "无"}）；必须明确填写的字段（{enginePolicies[binding.engineId].required.join("、") || "无"}）。不会自动编造未知值。</p>}
    <details><summary>CLI 选项 · 仅限显式、非敏感配置</summary><div className="up-grid">
      <label>服务等级<Select value={binding.options.serviceTier ?? ""} onChange={(event) => update((r) => { const options = r.bindings.find((b) => b.id === binding.id)!.options; if (event.target.value) options.serviceTier = event.target.value as "default" | "priority"; else delete options.serviceTier; })}><option value="">不注入</option><option value="default">默认</option><option value="priority">优先</option></Select></label>
      <label>始终启用思考<Select value={binding.options.alwaysThinkingEnabled === undefined ? "" : String(binding.options.alwaysThinkingEnabled)} onChange={(event) => update((r) => { const options = r.bindings.find((b) => b.id === binding.id)!.options; if (event.target.value) options.alwaysThinkingEnabled = event.target.value === "true"; else delete options.alwaysThinkingEnabled; })}><option value="">不注入</option><option value="true">启用</option><option value="false">禁用</option></Select></label>
      <label>非敏感请求头 · 每行格式为“名称: 值”<Textarea value={Object.entries(binding.options.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n")} onChange={(event) => update((r) => { const headers: Record<string, string> = {}; for (const line of event.target.value.split("\n").filter(Boolean)) { const colon = line.indexOf(":"); headers[colon < 0 ? line : line.slice(0, colon).trim()] = colon < 0 ? "" : line.slice(colon + 1).trim(); } r.bindings.find((b) => b.id === binding.id)!.options.headers = headers; })} /></label></div></details>
    <h4>官方模板模型映射</h4><p className="up-muted">拉取模型时已按同名官方模板自动映射。这里用于补映射、换模板或改 token 策略；更换模板必须明确操作，模板默认值不会复制进 registry.json。</p>
    <Button size="sm" disabled={busy} onClick={() => { setBusy(true); setError(""); void controller.loadTemplates(binding, true).then((items) => { setTemplates(items); setTemplateIndex(""); }).catch(() => setError("无法加载该 CLI 与执行环境的官方模板，已有映射已保留。")).finally(() => setBusy(false)); }}>刷新官方模板</Button>
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
    {error && <p role="alert" className="up-error">{error}</p>}
  </fieldset>;
}

export function Bindings({ providerId, draft, update, controller }: { providerId: string; draft: RegistryView; update: UpdateDraft; controller: ProviderController }) {
  const bindings = draft.bindings.filter((b) => b.providerId === providerId);
  return <div className="up-stack"><h3>CLI 映射</h3>
    <p className="up-muted">线路在“端点与 Key”里勾选 CLI 时建立。DSH、Agy、Qoder 与 Qoder CN 保留原生能力；不受支持的协议组合无法发布。</p>
    {!bindings.length && <p>这个供应商还没有 CLI 线路。请在“端点与 Key”里为某个端点勾选要用的 CLI。</p>}
    {bindings.map((binding) => <BindingEditor key={binding.id} binding={binding} draft={draft} update={update} controller={controller} />)}
  </div>;
}
