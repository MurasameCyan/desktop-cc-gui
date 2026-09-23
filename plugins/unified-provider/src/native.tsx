import { useEffect, useState } from "react";
import { Button, Select } from "@ccgui/plugin-ui";
import type { ConfigPatchPreview, DiscoveredModel, NativeConfigPreview, NativeConfigTarget } from "@ccgui/plugin-sdk";
import type { ProviderController } from "./controller";
import { compatible, type RegistryView } from "./registry";
import type { ImportDecision } from "./imports";

export function ImportWizard({ controller, registry, version, onClose }: { controller: ProviderController; registry: RegistryView; version: string | null; onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [targets, setTargets] = useState<NativeConfigTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<NativeConfigPreview | null>(null);
  const [templates, setTemplates] = useState<DiscoveredModel[]>([]);
  const [decisions, setDecisions] = useState<ImportDecision[]>([]);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; void controller.listConfigTargets().then((value) => { if (active) setTargets(value); }).catch(() => { if (active) setError("无法列出原生来源。请检查桌面端的配置读取权限。"); }); return () => { active = false; }; }, [controller]);
  async function previewSource() {
    setBusy(true); setError("");
    try {
      const result = await controller.previewImport(targetId);
      const official = await controller.loadTemplates({ id: "import-preview", providerId: "", endpointId: "", engineId: result.target.engineId, enabled: true, credential: { kind: "inherit" }, executionTarget: { kind: "local" }, options: {} }, true);
      setPreview(result); setTemplates(official); setDecisions(result.candidates.map((c) => ({ candidateId: c.candidateId, action: (c.hasStaticKey || c.auth === "none") && c.models.length && compatible(result.target.engineId, c.protocol) ? "new" : "skip", engineId: result.target.engineId, credentialDecision: "new", bindingDecision: "replace" }))); setStep(2);
    } catch { setError("无法读取来源预览或官方模板。registry 与原生文件都没有改动。请换一个受支持的来源再试。"); }
    finally { setBusy(false); }
  }
  function revise(candidateId: string, change: Partial<ImportDecision>) { setDecisions((items) => items.map((d) => d.candidateId === candidateId ? { ...d, ...change } : d)); }
  function review() {
    const chosen = decisions.filter((d) => d.action !== "skip");
    if (!chosen.length || chosen.some((d) => !d.templateRef || d.action === "merge" && (!d.providerId || !d.conflictConfirmed))) { setError("请至少选择一个候选项，为每个候选项选定官方模板，并逐条确认合并决定。"); return; }
    setError(""); setStep(3);
  }
  async function confirm() {
    if (!preview || !riskAccepted) return;
    setBusy(true); setError("");
    try { await controller.confirmImport(preview, decisions, version); onClose(); }
    catch { setError("导入没有完成。来源或 registry 可能已变化，也可能宿主拒绝了确认。请重新预览后再试。若文档已保存，请在向导之外使用“重试发布”，不要重复导入。"); }
    finally { setBusy(false); }
  }
  return <section className="up-card up-wizard" aria-label="导入原生 CLI 配置">
    <div className="up-toolbar"><h2>导入原生 CLI 配置</h2><Button disabled={busy} onClick={onClose}>取消 · 不做任何改动</Button></div>
    <ol className="up-steps" aria-label="导入步骤">{["选择来源", "核对映射", "确认复制"].map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined}>{index + 1}. {label}</li>)}</ol>
    {step === 1 && <><p>只提供能够识别的来源。OAuth、环境变量引用、命令、hooks 以及无法识别的字段都留在原生配置里。</p>
      <label>原生 CLI / 来源<Select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择来源</option>{targets.map((target) => <option key={target.targetId} value={target.targetId} disabled={!target.importSupported}>{target.label}{!target.importSupported ? ` · ${target.unsupportedReason ?? "不支持导入"}` : ""}</option>)}</Select></label>
      {targets.filter((target) => target.targetId === targetId).map((target) => <div key={target.targetId}><h3>{target.label}</h3><ul>{target.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>)}
      {!targets.length && <p>没有可识别的来源。关闭本向导再重新打开即可刷新。</p>}
      <Button variant="primary" disabled={!targetId || busy} onClick={() => void previewSource()}>{busy ? "正在读取脱敏预览…" : "预览来源"}</Button></>}
    {step === 2 && preview && <><p>{preview.target.label} · 识别到 {preview.candidates.length} 个候选项。名称或 URL 相同并不代表是同一个账号。</p>{preview.warnings.map((warning) => <p className="up-muted" key={warning}>{warning}</p>)}
      {preview.candidates.map((candidate) => { const decision = decisions.find((d) => d.candidateId === candidate.candidateId)!; return <fieldset className="up-card" key={candidate.candidateId}><legend>{candidate.label}</legend>
        <p>{candidate.protocol} · {candidate.baseUrl} · 原生认证方式：{candidate.auth}</p><p>模型：{candidate.models.join("、") || "未识别到"}</p><p>Key：{candidate.hasStaticKey ? `${candidate.credentialName ?? "静态 Key"} · ••••••••` : "没有可迁移的静态 Key"}</p>
        {!!candidate.skippedFields.length && <p className="up-muted">保留在原生配置中的字段：{candidate.skippedFields.join("、")}</p>}
        <div className="up-grid"><label>导入方式<Select value={decision.action} onChange={(event) => revise(candidate.candidateId, { action: event.target.value as ImportDecision["action"], conflictConfirmed: false })}><option value="skip">跳过</option><option value="new" disabled={!candidate.hasStaticKey && candidate.auth !== "none" || !candidate.models.length || !compatible(preview.target.engineId, candidate.protocol)}>新建独立供应商</option><option value="merge" disabled={!registry.providers.length || !candidate.models.length || !compatible(preview.target.engineId, candidate.protocol)}>合并进已有供应商</option></Select></label>
        {decision.action !== "skip" && <label>官方模板<Select value={decision.templateRef ? templates.findIndex((t) => t.templateRef?.modelId === decision.templateRef?.modelId && t.templateRef?.revision === decision.templateRef?.revision) : ""} onChange={(event) => revise(candidate.candidateId, { templateRef: event.target.value === "" ? undefined : templates[Number(event.target.value)]?.templateRef })}><option value="">请明确选择模板</option>{templates.map((t, index) => <option key={`${t.modelId}:${t.templateRef?.revision}`} value={index}>{t.label ?? t.modelId} · {t.templateRef?.revision.slice(0, 8)}</option>)}</Select></label>}
        {decision.action === "merge" && <><label>已有供应商<Select value={decision.providerId ?? ""} onChange={(event) => revise(candidate.candidateId, { providerId: event.target.value, conflictConfirmed: false })}><option value="">选择供应商</option>{registry.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.remark ?? "无备注"}</option>)}</Select></label>
          <label>Key 冲突处理<Select value={decision.credentialDecision} onChange={(event) => revise(candidate.candidateId, { credentialDecision: event.target.value as "new" | "keep", conflictConfirmed: false })}><option value="new" disabled={!candidate.hasStaticKey}>新建一个具名 Key · 绝不覆盖原有</option><option value="keep">保留该供应商现有的默认 Key</option></Select></label>
          <label>已有 CLI 绑定冲突处理<Select value={decision.bindingDecision} onChange={(event) => revise(candidate.candidateId, { bindingDecision: event.target.value as "replace" | "keep", conflictConfirmed: false })}><option value="replace">用新的独立模型替换该 CLI 映射</option><option value="keep">保持现有 CLI 映射不变</option></Select></label>
          <label className="up-check"><input type="checkbox" checked={!!decision.conflictConfirmed} onChange={(event) => revise(candidate.candidateId, { conflictConfirmed: event.target.checked })} />我已核对供应商、Key 与映射的冲突</label></>}
        </div></fieldset>; })}
      <div className="up-actions"><Button onClick={() => { setPreview(null); setDecisions([]); setStep(1); }}>返回选择来源</Button><Button variant="primary" onClick={review}>核对最终复制内容</Button></div></>}
    {step === 3 && preview && <><h3>确认一次性复制</h3><ul>{decisions.filter((d) => d.action !== "skip").map((d) => <li key={d.candidateId}>{preview.candidates.find((c) => c.candidateId === d.candidateId)?.label}：{d.action === "new" ? "新建供应商" : `合并进 ${registry.providers.find((p) => p.id === d.providerId)?.name}`} · {d.engineId} · {d.templateRef?.modelId} · Key {d.credentialDecision === "new" ? "新建" : "保留"} · CLI 映射 {d.bindingDecision === "replace" ? "替换" : "保留"}</li>)}</ul>
      <p>宿主确认时会重新校验来源指纹，并对每个新目标单独授权。导入只写 registry.json（带版本校验），随后原子发布。原生文件不会被修改、删除，也不会自动保持同步。</p>
      <label className="up-check"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />我明白被复制的静态 Key 会同时存在于原生文件和插件私有 registry 中，我会自行保护其权限与备份。</label>
      <div className="up-actions"><Button disabled={busy} onClick={() => { setRiskAccepted(false); setStep(2); }}>上一步</Button><Button variant="primary" disabled={!riskAccepted || busy} onClick={() => void confirm()}>{busy ? "正在确认并保存…" : "确认导入并发布"}</Button></div></>}
    {error && <p role="alert" className="up-error">{error}</p>}
  </section>;
}

export function NativeOperations({ controller, registry }: { controller: ProviderController; registry: RegistryView }) {
  const [targets, setTargets] = useState<NativeConfigTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<ConfigPatchPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let active = true; void controller.listConfigTargets().then((items) => { if (active) setTargets(items); }).catch(() => { if (active) setMessage("无法列出可识别的原生配置目标。"); }); return () => { active = false; }; }, [controller]);
  async function perform(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch { setMessage("原生操作没有完成。可能是来源已变化、权限不足或该配置不受支持，需要重新预览。离开本页前请先查看 registry 状态。"); } finally { setBusy(false); } }
  return <section className="up-stack"><h3>原生配置 · 需显式操作</h3><p>保存供应商和选择会话模型都不会写原生文件。下面这些独立操作可能改变该 CLI 的全局默认值，并额外产生一份明文 Key 副本。</p>
    <label>已识别的原生目标<Select value={targetId} onChange={(event) => { setTargetId(event.target.value); setPreview(null); setConfirmed(false); }}><option value="">选择目标</option>{targets.map((target) => <option key={target.targetId} value={target.targetId} disabled={!target.applySupported}>{target.label}{!target.applySupported ? ` · ${target.unsupportedReason ?? "不支持写入"}` : ""}</option>)}</Select></label>
    {targets.filter((target) => !target.applySupported).map((target) => <p className="up-muted" key={target.targetId}>{target.label}：{target.unsupportedReason ?? "不支持写入或恢复原生配置"}</p>)}
    <Button disabled={!targetId || busy} onClick={() => void perform(async () => { setPreview(await controller.previewPatch(targetId)); setConfirmed(false); })}>预览：把当前会话选择写入原生配置</Button>
    {preview && <section className="up-card"><h4>{preview.target.label}</h4><ul>{preview.target.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul><ul>{preview.changes.map((change, index) => <li key={index}>{change}</li>)}</ul><p>{preview.containsPlaintextKey ? "本次写入会把明文 Key 写进原生配置。" : "本次写入不包含明文 Key。"}</p>
      <label className="up-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已逐条核对这份原生文件差异，同意写入</label>
      <Button variant="primary" disabled={!confirmed || busy} onClick={() => void perform(async () => { await controller.applyPatch(preview.previewId); setPreview(null); setConfirmed(false); setMessage("原生补丁已写入，其恢复回执已记录在 registry.json 中。"); })}>写入已预览的原生补丁</Button>
    </section>}
    <h4>已记录的原生补丁</h4>{!registry.patchReceipts.length && <p>还没有记录任何原生补丁。</p>}
    {registry.patchReceipts.map((receipt) => <div className="up-card" key={receipt.receiptId}><p>{receipt.targetId} · 回执 {receipt.receiptId}</p><p className="up-muted">恢复时会校验记录的指纹，拒绝覆盖之后发生的外部改动。</p><Button disabled={busy} onClick={() => void perform(async () => { await controller.restorePatch(receipt.receiptId); setMessage("原生补丁已恢复。"); })}>恢复该原生补丁</Button></div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
