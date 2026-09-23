import { useState } from "react";
import { Button, Input, Select, Textarea } from "@ccgui/plugin-ui";
import { id, protocols, type Provider, type RegistryView } from "./registry";
import { PolicyEditor, type UpdateDraft } from "./fields";

export function ProviderDetails({ provider, draft, update, keyEdits, editKey }: { provider: Provider; draft: RegistryView; update: UpdateDraft; keyEdits: Record<string, string>; editKey: (credentialId: string, value: string) => void }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const credentials = draft.credentials.filter((c) => c.providerId === provider.id);
  return <div className="up-stack">
    <div className="up-grid"><label>供应商名称<Input value={provider.name} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.name = event.target.value; })} /></label>
    <label>供应商备注<Textarea value={provider.remark ?? ""} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.remark = event.target.value; })} /></label>
    <label className="up-check"><input type="checkbox" checked={provider.enabled} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.enabled = event.target.checked; })} />启用</label>
    <label>默认 Key · 仅在明确绑定时使用<Select value={provider.defaultCredentialId ?? ""} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.defaultCredentialId = event.target.value || undefined; })}><option value="">不设默认</option>{credentials.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.remark ?? "无备注"}</option>)}</Select></label></div>
    <section className="up-card"><div className="up-toolbar"><h3>Key</h3><Button size="sm" onClick={() => { const credentialId = id(); update((r) => { r.credentials.push({ id: credentialId, providerId: provider.id, name: "新 Key", enabled: true, credentialRevision: 1 }); for (const b of r.bindings.filter((b) => b.providerId === provider.id)) delete b.targetGrantId; }); setEditingKey(credentialId); }}>新增 Key</Button></div>
      <p className="up-muted">Key 仅以明文保存在本插件私有的 registry.json 里，请自行保护它的文件权限与备份。普通界面、发布内容和事件里只出现名称与备注。修改 Key 值会产生新代次，已绑定的会话必须重新明确选择。</p>
      {!credentials.length && <p>还没有 Key。新增一个，或使用无需认证的端点。</p>}
      {credentials.map((c) => <fieldset key={c.id} className="up-card"><legend>{c.name} · •••••••• · 第 {c.credentialRevision} 代</legend>
        <div className="up-grid"><label>Key 名称<Input value={c.name} onChange={(event) => update((r) => { r.credentials.find((k) => k.id === c.id)!.name = event.target.value; })} /></label>
        <label>Key 备注<Input value={c.remark ?? ""} onChange={(event) => update((r) => { r.credentials.find((k) => k.id === c.id)!.remark = event.target.value; })} /></label>
        <label className="up-check"><input type="checkbox" checked={c.enabled} onChange={(event) => update((r) => { r.credentials.find((k) => k.id === c.id)!.enabled = event.target.checked; for (const b of r.bindings.filter((b) => b.providerId === provider.id)) delete b.targetGrantId; })} />启用</label></div>
        {editingKey === c.id ? <label>新的 Key 值 · 已保存的值永不回显<Input type="password" autoComplete="new-password" spellCheck={false} value={keyEdits[c.id] ?? ""} onChange={(event) => editKey(c.id, event.target.value)} /></label> : <Button size="sm" onClick={() => setEditingKey(c.id)}>明确修改 Key 值</Button>}
        <Button size="sm" variant="ghost" onClick={() => update((r) => { r.credentials = r.credentials.filter((k) => k.id !== c.id); const p = r.providers.find((p) => p.id === provider.id)!; if (p.defaultCredentialId === c.id) delete p.defaultCredentialId; for (const b of r.bindings.filter((b) => b.providerId === provider.id)) { delete b.targetGrantId; if (b.credential.kind === "explicit" && b.credential.credentialId === c.id) { b.credential = { kind: "inherit" }; b.enabled = false; } } })}>从草稿中删除该 Key</Button>
      </fieldset>)}
    </section>
    <section className="up-card"><div className="up-toolbar"><h3>端点</h3><Button size="sm" onClick={() => update((r) => { r.endpoints.push({ id: id(), providerId: provider.id, name: "新端点", baseUrl: "", protocol: "openai-responses", auth: "bearer", enabled: true }); })}>新增端点</Button></div>
      {draft.endpoints.filter((e) => e.providerId === provider.id).map((endpoint) => <fieldset className="up-card" key={endpoint.id}><legend>{endpoint.name}</legend><div className="up-grid">
        <label>名称<Input value={endpoint.name} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.name = event.target.value; })} /></label>
        <label>完整 Base URL<Input type="url" placeholder="https://api.example.com/v1" value={endpoint.baseUrl} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.baseUrl = event.target.value; for (const b of r.bindings.filter((b) => b.endpointId === endpoint.id)) delete b.targetGrantId; })} /></label>
        <label>协议<Select value={endpoint.protocol} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.protocol = event.target.value as typeof endpoint.protocol; for (const b of r.bindings.filter((b) => b.endpointId === endpoint.id)) delete b.targetGrantId; })}>{protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}</Select></label>
        <label>认证方式<Select value={endpoint.auth} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.auth = event.target.value as typeof endpoint.auth; for (const b of r.bindings.filter((b) => b.endpointId === endpoint.id)) delete b.targetGrantId; })}><option value="bearer">Bearer Key</option><option value="api-key">API Key</option><option value="none">无</option></Select></label>
        <label className="up-check"><input type="checkbox" checked={endpoint.enabled} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.enabled = event.target.checked; })} />启用</label>
      </div><Button size="sm" variant="ghost" onClick={() => update((r) => { const bindings = r.bindings.filter((b) => b.endpointId === endpoint.id).map((b) => b.id); r.endpoints = r.endpoints.filter((e) => e.id !== endpoint.id); r.bindings = r.bindings.filter((b) => b.endpointId !== endpoint.id); r.mappings = r.mappings.filter((m) => !bindings.includes(m.bindingId)); for (const m of r.models) delete m.wireIds[endpoint.id]; })}>从草稿中删除该端点及其 CLI 映射</Button></fieldset>)}
    </section>
  </div>;
}

export function ProviderModels({ providerId, draft, update }: { providerId: string; draft: RegistryView; update: UpdateDraft }) {
  return <section className="up-stack"><div className="up-toolbar"><h3>供应商模型</h3><Button onClick={() => update((r) => { r.models.push({ id: id(), providerId, name: "新模型", wireIds: {}, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } }); })}>新增模型</Button></div><p className="up-muted">显示名不是身份。不同逻辑模型可以共用同一个 wire ID，从而得到彼此独立的 CLI 别名。共享策略只影响仍然继承它的映射。</p>
    {draft.models.filter((m) => m.providerId === providerId).map((model) => <fieldset className="up-card" key={model.id}><legend>{model.name}</legend>
      <label>显示名<Input value={model.name} onChange={(event) => update((r) => { r.models.find((m) => m.id === model.id)!.name = event.target.value; })} /></label>
      <div className="up-grid">{draft.endpoints.filter((e) => e.providerId === providerId).map((endpoint) => <label key={endpoint.id}>{endpoint.name} · wire 模型 ID<Input value={model.wireIds[endpoint.id] ?? ""} onChange={(event) => update((r) => { const m = r.models.find((m) => m.id === model.id)!; if (event.target.value) m.wireIds[endpoint.id] = event.target.value; else delete m.wireIds[endpoint.id]; })} /></label>)}
      {([["images", "图片"], ["tools", "工具"]] as const).map(([capability, label]) => <label key={capability}>{label} · 由你声明<Select value={model.capabilities[capability]} onChange={(event) => update((r) => { r.models.find((m) => m.id === model.id)!.capabilities[capability] = event.target.value as typeof model.capabilities.images; })}><option value="unknown">未知 · 继承官方模板</option><option value="supported">支持</option><option value="unsupported">不支持</option></Select></label>)}
      <label>可用推理强度 · 逗号分隔，留空则继承官方模板<Input value={model.capabilities.effortLevels.join(",")} onChange={(event) => update((r) => { r.models.find((m) => m.id === model.id)!.capabilities.effortLevels = event.target.value.split(",").map((v) => v.trim()).filter(Boolean); })} /></label></div>
      <PolicyEditor scope="模型共享策略" value={model.sharedPolicy} onChange={(value) => update((r) => { r.models.find((m) => m.id === model.id)!.sharedPolicy = value; })} />
      <Button size="sm" variant="ghost" onClick={() => update((r) => { r.models = r.models.filter((m) => m.id !== model.id); r.mappings = r.mappings.filter((m) => m.providerModelId !== model.id); })}>从草稿中删除该模型及其映射</Button>
    </fieldset>)}
  </section>;
}
