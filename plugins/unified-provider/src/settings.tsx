import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button } from "@ccgui/plugin-ui";
import type { CliProtocol } from "@ccgui/plugin-sdk";
import type { ControllerSnapshot, ProviderController } from "./controller";
import { enabledModelIds, id, probeEngine, protocolLabels, protocolMarks, protocols, type RegistryView } from "./registry";
import { EndpointModal } from "./endpoint-modal";
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

/** 打开弹窗时记下的草稿，用于「取消」原样退回；拉取模型会落盘，届时基线随之前移。 */
interface Baseline { draft: RegistryView; version: string | null; keyEdits: Record<string, string>; dirty: boolean }

export function Settings({ controller }: { controller: ProviderController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [draft, setDraft] = useState<RegistryView | null>(null);
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [protocol, setProtocol] = useState<CliProtocol | null>(null);
  const [editing, setEditing] = useState("");
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [importing, setImporting] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
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
  /** 拉取模型必须先落盘发布，所以弹窗里会保存一次；这里把已保存的内容重新认作基线。 */
  function adoptSaved(): void {
    const current = controller.snapshot();
    if (!current.registry) return;
    const next = structuredClone(current.registry);
    draftRef.current = next;
    setDraft(next); setDraftVersion(current.documentVersion); setKeyEdits({}); setDirty(false);
    setBaseline({ draft: next, version: current.documentVersion, keyEdits: {}, dirty: false });
  }
  const unavailable = busy || snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "error";
  async function save(): Promise<boolean> {
    if (!draft) return false;
    setBusy(true); setError("");
    try { await controller.save(draft, draftVersion, keyEdits); setKeyEdits({}); setDirty(false); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "保存被拒绝，请重新加载后再试"); return false; }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError("");
    try { await controller.reload(); const current = controller.snapshot(); if (current.phase !== "error") { setDraft(current.registry ? structuredClone(current.registry) : null); setDraftVersion(current.documentVersion); setKeyEdits({}); setDirty(false); setDiscardConfirmed(false); } }
    finally { setBusy(false); }
  }

  const counts = Object.fromEntries(protocols.map((p) => [p, draft?.endpoints.filter((e) => e.protocol === p).length ?? 0])) as Record<CliProtocol, number>;
  const active = protocol ?? protocols.find((p) => counts[p] > 0) ?? "openai-chat";
  const rows = draft?.endpoints.filter((e) => e.protocol === active) ?? [];
  const editingEndpoint = draft?.endpoints.find((e) => e.id === editing);

  /** 基线默认取当前草稿；新增与复制要传入**插入之前**的草稿，否则「取消」会把
   *  那条刚建出来、还没填地址的行留在草稿里，挡住其余各行的保存与拉取。 */
  function openEditor(endpointId: string, base: RegistryView | null = draftRef.current): void {
    if (base) setBaseline({ draft: base, version: draftVersion, keyEdits, dirty });
    setEditing(endpointId);
  }
  function closeEditor(restore: boolean): void {
    // 基线过期说明弹窗里已经落盘过，退回旧草稿只会造成版本冲突，所以那时只关闭。
    if (restore && baseline && baseline.version === draftVersion) {
      draftRef.current = baseline.draft; setDraft(baseline.draft); setKeyEdits(baseline.keyEdits); setDirty(baseline.dirty);
    }
    setBaseline(null); setEditing("");
  }
  /** 供应商与端点在这条流程里一一对应：新增一行就是新增一个供应商加它唯一的端点，
   *  再带上这个协议对应的那条 CLI 线路——没有线路，拉回来的模型就没有任何映射，
   *  在清单里一个都启用不了。想换或加别的 CLI 在弹窗的“高级设置”里。 */
  function create(): void {
    const base = draftRef.current;
    const providerId = id();
    const endpointId = id();
    update((r) => {
      r.providers.push({ id: providerId, name: "新供应商", enabled: true, revision: 1 });
      r.endpoints.push({ id: endpointId, providerId, name: "新供应商", protocol: active, baseUrl: "", auth: "bearer", enabled: true });
      r.bindings.push({ id: id(), providerId, engineId: probeEngine(active), endpointId, credential: { kind: "inherit" }, executionTarget: { kind: "local" }, options: {}, enabled: true });
    });
    openEditor(endpointId, base);
  }
  /** 复制结构，不复制 Key：明文不在草稿里，宿主授权也只对准确目标有效。新行的 CLI
   *  线路先停用，等填好它自己的 Key 再启用，避免整次发布因缺 Key 失败。 */
  function duplicate(endpointId: string): void {
    const base = draftRef.current;
    const copyId = id();
    update((r) => {
      const source = r.endpoints.find((e) => e.id === endpointId)!;
      const sourceProvider = r.providers.find((p) => p.id === source.providerId)!;
      const providerId = id();
      r.providers.push({ ...sourceProvider, id: providerId, name: `${sourceProvider.name} 副本`, revision: 1 });
      const { defaultCredentialId: _default, probeGrantId: _probe, ...rest } = source;
      r.endpoints.push({ ...rest, id: copyId, providerId, name: `${source.name} 副本` });
      const copies = new Map<string, string>();
      for (const model of r.models.filter((m) => m.providerId === source.providerId && m.wireIds[endpointId] !== undefined)) {
        const modelId = id();
        copies.set(model.id, modelId);
        r.models.push({ ...structuredClone(model), id: modelId, providerId, wireIds: { [copyId]: model.wireIds[endpointId]! } });
      }
      for (const binding of r.bindings.filter((b) => b.endpointId === endpointId)) {
        const bindingId = id();
        const { targetGrantId: _grant, defaultModelId: _model, ...carried } = binding;
        r.bindings.push({ ...structuredClone(carried), id: bindingId, providerId, endpointId: copyId, credential: { kind: "inherit" }, enabled: false });
        for (const mapping of r.mappings.filter((m) => m.bindingId === binding.id && copies.has(m.providerModelId))) {
          r.mappings.push({ ...structuredClone(mapping), id: id(), bindingId, providerModelId: copies.get(mapping.providerModelId)! });
        }
      }
    });
    openEditor(copyId, base);
  }
  function remove(endpointId: string): void {
    update((r) => {
      const endpoint = r.endpoints.find((e) => e.id === endpointId)!;
      const bindingIds = r.bindings.filter((b) => b.endpointId === endpointId).map((b) => b.id);
      r.endpoints = r.endpoints.filter((e) => e.id !== endpointId);
      r.credentials = r.credentials.filter((c) => c.endpointId !== endpointId);
      r.bindings = r.bindings.filter((b) => b.endpointId !== endpointId);
      r.mappings = r.mappings.filter((m) => !bindingIds.includes(m.bindingId));
      for (const model of r.models) delete model.wireIds[endpointId];
      if (r.endpoints.some((e) => e.providerId === endpoint.providerId)) return;
      // 供应商的最后一个端点被删掉后，它的模型再也无处可用，一起清掉而不是留成孤儿。
      r.providers = r.providers.filter((p) => p.id !== endpoint.providerId);
      r.models = r.models.filter((m) => m.providerId !== endpoint.providerId);
      const remaining = new Set(r.models.map((m) => m.id));
      r.mappings = r.mappings.filter((m) => remaining.has(m.providerModelId));
    });
    if (editing === endpointId) closeEditor(false);
  }
  /** 行序决定模型菜单里的先后，所以换位用按钮而不是拖拽，键盘也能操作。 */
  function move(endpointId: string, delta: number): void {
    update((r) => {
      const positions = r.endpoints.map((e, index) => ({ e, index })).filter((x) => x.e.protocol === active).map((x) => x.index);
      const from = r.endpoints.findIndex((e) => e.id === endpointId);
      const to = positions[positions.indexOf(from) + delta];
      if (to === undefined) return;
      [r.endpoints[from], r.endpoints[to]] = [r.endpoints[to], r.endpoints[from]];
    });
  }

  return <main className="up up-settings">
    <h1 className="up-page-title">供应商配置</h1>
    <div className={`up-status ${snapshot.phase === "saved-unpublished" || snapshot.phase === "conflict" || snapshot.phase === "error" ? "up-status-warning" : ""}`} role="status">
      <Badge tone={snapshot.phase === "published" ? "success" : snapshot.phase === "conflict" || snapshot.phase === "error" ? "error" : "neutral"}>{dirty ? "草稿未保存" : PHASE_LABELS[snapshot.phase]}</Badge>
      <span>{snapshot.message}</span>
      {snapshot.phase === "saved-unpublished" && <Button size="sm" disabled={dirty || unavailable} onClick={() => { void controller.retryPublish().catch(() => setError("无法开始重试发布，请等待当前操作结束后再试。")); }}>重试发布 · 不重复创建条目</Button>}
    </div>
    {error && <p role="alert" className="up-error">{error}</p>}
    {snapshot.phase === "loading" && <p className="up-card" role="status">正在加载私有配置与发布回执…</p>}

    {draft && <>
      <div className="up-listbar">
        <div className="up-proto-tabs" role="group" aria-label="服务类型">
          {protocols.map((item) => <button type="button" key={item} className="up-proto-tab" aria-pressed={active === item} onClick={() => setProtocol(item)}>
            <span className="up-mark" aria-hidden="true">{protocolMarks[item]}</span>{protocolLabels[item]}<span className="up-count">{counts[item]}</span>
          </button>)}
        </div>
        <div className="up-actions">
          <Button variant="primary" disabled={unavailable || importing} onClick={create}>+ 新增</Button>
          <Button disabled={unavailable || dirty} onClick={() => setImporting(true)}>导入</Button>
          <Button aria-pressed={nativeOpen} disabled={unavailable} onClick={() => setNativeOpen(true)}>设置</Button>
        </div>
      </div>

      <div className="up-rows">
        {!rows.length && <p className="up-card">{protocolLabels[active]} 下还没有供应商。点「+ 新增」填入地址与 Key，或用「导入」读取已识别的原生配置。</p>}
        {rows.map((endpoint) => {
          const models = enabledModelIds(draft, endpoint.id).size;
          const lines = draft.bindings.filter((b) => b.endpointId === endpoint.id && b.enabled).length;
          return <div className="up-row" key={endpoint.id}>
            <div className="up-order">
              <Button size="sm" variant="ghost" aria-label={`上移 ${endpoint.name}`} disabled={unavailable} onClick={() => move(endpoint.id, -1)}>↑</Button>
              <Button size="sm" variant="ghost" aria-label={`下移 ${endpoint.name}`} disabled={unavailable} onClick={() => move(endpoint.id, 1)}>↓</Button>
            </div>
            <span className="up-mark" aria-hidden="true">{protocolMarks[endpoint.protocol]}</span>
            <div className="up-row-main">
              <span className="up-row-name">{endpoint.name}{endpoint.enabled ? "" : " · 已禁用"}</span>
              <span className="up-muted">{endpoint.baseUrl || "未填写 Base URL"} · {models} 个激活模型{lines ? "" : " · 未启用任何 CLI"}</span>
            </div>
            <div className="up-row-actions">
              <Button size="sm" variant="ghost" aria-label={`复制 ${endpoint.name}`} disabled={unavailable} onClick={() => duplicate(endpoint.id)}>复制</Button>
              <Button size="sm" variant="ghost" aria-label={`编辑 ${endpoint.name}`} disabled={unavailable} onClick={() => openEditor(endpoint.id)}>编辑</Button>
              <Button size="sm" variant="ghost" aria-label={`删除 ${endpoint.name}`} disabled={unavailable} onClick={() => remove(endpoint.id)}>删除</Button>
            </div>
          </div>;
        })}
      </div>

      <footer className="up-savebar">
        <div>
          <p>{dirty ? "草稿修改尚未影响任何会话。" : "只有显式预览并确认的原生操作才会修改原生文件。"}</p>
          {dirty && <label className="up-check"><input type="checkbox" checked={discardConfirmed} onChange={(event) => setDiscardConfirmed(event.target.checked)} />重新加载时放弃未保存的草稿</label>}
        </div>
        <div className="up-actions">
          <Button disabled={busy || snapshot.phase === "saving" || dirty && !discardConfirmed} onClick={() => void reload()}>重新加载配置</Button>
          <Button variant="primary" disabled={unavailable || !dirty && snapshot.documentVersion !== null} onClick={() => void save()}>{busy ? "正在保存…" : "保存并发布"}</Button>
        </div>
      </footer>
    </>}

    {draft && editingEndpoint && <EndpointModal key={editingEndpoint.id} endpoint={editingEndpoint} draft={draft} documentVersion={draftVersion}
      keyEdits={keyEdits} update={update} controller={controller} replaceDraft={replaceDraft} busy={busy}
      editKey={(credentialId, value) => {
        setKeyEdits((current) => ({ ...current, [credentialId]: value }));
        update((r) => {
          const credential = r.credentials.find((c) => c.id === credentialId)!;
          const saved = snapshot.registry?.credentials.find((c) => c.id === credentialId);
          credential.credentialRevision = saved ? saved.credentialRevision + 1 : 1;
          const endpoint = r.endpoints.find((e) => e.id === credential.endpointId);
          if (endpoint) delete endpoint.probeGrantId;
          for (const binding of r.bindings.filter((b) => b.endpointId === credential.endpointId)) delete binding.targetGrantId;
        });
      }}
      onPersisted={adoptSaved} onCancel={() => closeEditor(true)} onSave={() => { void save().then((ok) => { if (ok) closeEditor(false); }); }} />}

    {draft && importing && <div className="up-scrim" role="dialog" aria-modal="true" aria-label="导入原生 CLI 配置">
      <div className="up-modal up"><ImportWizard controller={controller} registry={draft} version={draftVersion} onClose={() => setImporting(false)} /></div>
    </div>}

    {draft && nativeOpen && <div className="up-scrim" role="dialog" aria-modal="true" aria-label="原生配置操作">
      <section className="up-modal up">
        <div className="up-modal-head"><h2>设置 · 原生配置操作</h2><Button size="sm" onClick={() => setNativeOpen(false)}>关闭</Button></div>
        {dirty && <p role="alert" className="up-error">写入原生配置前，请先保存或放弃当前草稿。</p>}
        <fieldset className="up-editor-boundary" disabled={dirty || unavailable}><NativeOperations controller={controller} registry={snapshot.registry ?? draft} /></fieldset>
      </section>
    </div>}
  </main>;
}
