import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, Input } from "@ccgui/plugin-ui";
import type { ControllerSnapshot, ProviderController } from "./controller";
import { compatible, id, type RegistryView } from "./registry";
import { ProviderDetails, ProviderModels } from "./provider-editor";
import { Bindings } from "./bindings";
import { ImportWizard, NativeOperations } from "./native";
import type { UpdateDraft } from "./fields";

const PHASE_LABELS: Record<ControllerSnapshot["phase"], string> = {
  loading: "正在加载",
  ready: "就绪",
  saving: "正在保存",
  published: "已发布",
  "saved-unpublished": "已保存 · 未发布",
  conflict: "版本冲突",
  error: "加载失败",
};

export function Settings({ controller }: { controller: ProviderController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [draft, setDraft] = useState<RegistryView | null>(null);
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState("details");
  const [importing, setImporting] = useState(false);
  const [keyEdits, setKeyEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [discardConfirmed, setDiscardConfirmed] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!snapshot.registry || snapshot.phase === "loading") return;
    if (snapshot.documentVersion !== draftVersion || draft === null) {
      setDraft(structuredClone(snapshot.registry)); setDraftVersion(snapshot.documentVersion); setDirty(false); setKeyEdits({}); setDiscardConfirmed(false);
    }
  }, [snapshot.documentVersion, snapshot.registry, snapshot.phase]);
  const update: UpdateDraft = (change) => {
    if (!draftRef.current) return;
    try { const next = structuredClone(draftRef.current); change(next); draftRef.current = next; setDraft(next); setDirty(true); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "草稿修改被拒绝"); }
  };
  const replaceDraft = (next: RegistryView, expected: RegistryView) => {
    if (draftRef.current !== expected) { setError("目标授权期间草稿已变化，请核对最新草稿后重新授权。"); return; }
    draftRef.current = next; setDraft(next); setDirty(true);
  };
  const provider = draft?.providers.find((p) => p.id === providerId);
  const unavailable = busy || snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "error";
  async function save() {
    if (!draft) return;
    setBusy(true); setError("");
    try { await controller.save(draft, draftVersion, keyEdits); setKeyEdits({}); setDirty(false); }
    catch (e) { setError(e instanceof Error ? e.message : "保存被拒绝，请重新加载后再试"); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError("");
    try { await controller.reload(); const current = controller.snapshot(); if (current.phase !== "error") { setDraft(current.registry ? structuredClone(current.registry) : null); setDraftVersion(current.documentVersion); setKeyEdits({}); setDirty(false); setDiscardConfirmed(false); } }
    finally { setBusy(false); }
  }
  return <main className="up up-settings">
    <header className="up-header"><div><h1>统一供应商</h1><p className="up-muted">统一私有配置 · 每个会话独立选择供应商、模型、Key 与推理强度</p></div><div className="up-toolbar"><Button disabled={unavailable || dirty} onClick={() => setImporting(true)}>导入原生 CLI 配置</Button><Button disabled={unavailable || importing} onClick={() => { const providerId = id(); update((r) => { r.providers.push({ id: providerId, name: "新供应商", enabled: true, revision: 1 }); }); setProviderId(providerId); setTab("details"); }}>新增供应商</Button></div></header>
    <div className={`up-status ${snapshot.phase === "saved-unpublished" || snapshot.phase === "conflict" || snapshot.phase === "error" ? "up-status-warning" : ""}`} role="status"><Badge tone={snapshot.phase === "published" ? "success" : snapshot.phase === "conflict" || snapshot.phase === "error" ? "error" : "neutral"}>{dirty ? "草稿未保存" : PHASE_LABELS[snapshot.phase]}</Badge><span>{snapshot.message}</span>{snapshot.phase === "saved-unpublished" && <Button size="sm" disabled={dirty || unavailable} onClick={() => { void controller.retryPublish().catch(() => setError("无法开始重试发布，请等待当前操作结束后再试。")); }}>重试发布 · 不重复创建条目</Button>}</div>
    {dirty && <p className="up-muted">导入前请先保存或放弃当前草稿。已有会话仍绑定原来的 Key，保存默认值不会自动替换它们的选择。</p>}
    {error && <p role="alert" className="up-error">{error}</p>}
    {snapshot.phase === "loading" && <p className="up-card" role="status">正在加载私有配置与发布回执…</p>}
    {draft && importing ? <ImportWizard controller={controller} registry={draft} version={draftVersion} onClose={() => setImporting(false)} /> : draft && <div className="up-layout">
      <aside className="up-sidebar" aria-label="供应商列表"><label>筛选供应商<Input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        {!draft.providers.length && <p>还没有供应商。可以导入已识别的原生配置，也可以手动创建。</p>}
        <div className="up-provider-list">{draft.providers.filter((p) => `${p.name} ${p.remark ?? ""}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((p) => {
          const bindings = draft.bindings.filter((b) => b.providerId === p.id && b.enabled);
          const invalid = bindings.filter((b) => { const e = draft.endpoints.find((e) => e.id === b.endpointId); return !e || !compatible(b.engineId, e.protocol); }).length;
          return <button type="button" key={p.id} className="up-provider-row" aria-pressed={providerId === p.id} onClick={() => setProviderId(p.id)}><strong>{p.name}</strong><span>{p.enabled ? "已启用" : "已禁用"} · {bindings.length} 个 CLI 绑定 · {draft.credentials.filter((c) => c.providerId === p.id).length} 个 Key</span>{invalid > 0 && <span>{invalid} 个绑定不兼容</span>}{p.remark && <span>{p.remark}</span>}</button>;
        })}</div><Button variant="ghost" onClick={() => { setTab("native"); }}>原生配置操作</Button>
      </aside>
      <section className="up-detail" aria-label={provider?.name ?? "供应商详情"}>
        <div className="up-toolbar"><h2>{tab === "native" ? "原生配置" : provider?.name ?? "请选择供应商"}</h2>{provider && tab !== "native" && <Button variant="ghost" size="sm" disabled={unavailable} onClick={() => { update((r) => { const bindingIds = r.bindings.filter((b) => b.providerId === provider.id).map((b) => b.id); r.providers = r.providers.filter((p) => p.id !== provider.id); r.endpoints = r.endpoints.filter((e) => e.providerId !== provider.id); r.credentials = r.credentials.filter((c) => c.providerId !== provider.id); r.models = r.models.filter((m) => m.providerId !== provider.id); r.bindings = r.bindings.filter((b) => b.providerId !== provider.id); r.mappings = r.mappings.filter((m) => !bindingIds.includes(m.bindingId)); }); setProviderId(""); }}>从草稿中删除该供应商</Button>}</div>
        <div className="up-tabs" role="group" aria-label="供应商设置分组">{[["details", "详情与 Key"], ["models", "模型与共享策略"], ["bindings", "CLI 映射"], ["native", "原生配置操作"]].map(([key, label]) => <Button key={key} aria-pressed={tab === key} onClick={() => setTab(key)} disabled={key !== "native" && !provider}>{label}</Button>)}</div>
        <fieldset className="up-editor-boundary" disabled={unavailable}>
          {tab === "native" ? <>{dirty && <p>写入原生配置前，请先保存或放弃当前草稿。</p>}<fieldset className="up-editor-boundary" disabled={dirty}><NativeOperations controller={controller} registry={snapshot.registry ?? draft} /></fieldset></> : provider ? <>
            {tab === "details" && <ProviderDetails key={provider.id} provider={provider} draft={draft} update={update} keyEdits={keyEdits} editKey={(credentialId, value) => { setKeyEdits((current) => ({ ...current, [credentialId]: value })); update((r) => { const credential = r.credentials.find((c) => c.id === credentialId)!; const saved = snapshot.registry?.credentials.find((c) => c.id === credentialId); credential.credentialRevision = saved ? saved.credentialRevision + 1 : 1; for (const binding of r.bindings.filter((b) => b.providerId === credential.providerId)) delete binding.targetGrantId; }); }} />}
            {tab === "models" && <ProviderModels providerId={provider.id} draft={draft} update={update} />}
            {tab === "bindings" && <Bindings key={provider.id} providerId={provider.id} draft={draft} update={update} controller={controller} replaceDraft={replaceDraft} />}
          </> : <p>请在左侧选择供应商，或导入、新建一个供应商。聊天模型菜单中仍可使用原生模型。</p>}
        </fieldset>
      </section>
    </div>}
    {!importing && <footer className="up-savebar"><div><p>{dirty ? "草稿修改尚未影响任何会话。" : "只有显式预览并确认的原生操作才会修改原生文件。"}</p>{dirty && <label className="up-check"><input type="checkbox" checked={discardConfirmed} onChange={(event) => setDiscardConfirmed(event.target.checked)} />重新加载时放弃未保存的草稿</label>}</div><div className="up-actions"><Button disabled={busy || snapshot.phase === "saving" || dirty && !discardConfirmed} onClick={() => void reload()}>重新加载配置</Button><Button variant="primary" disabled={unavailable || !draft || !dirty && snapshot.documentVersion !== null} onClick={() => void save()}>{busy ? "正在保存…" : "保存并发布"}</Button></div></footer>}
  </main>;
}
