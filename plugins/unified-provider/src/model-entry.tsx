import { useEffect, useRef, useState } from "react";
import { Button, EffortSlider, Input, Select } from "@ccgui/plugin-ui";
import type { ExecutionChoice, ExecutionSelectionInput, ModelEntryProps } from "@ccgui/plugin-sdk";
import { selectionIdentity, validateSelectionDraft } from "./selection";

/** 拉条没有“未选择”档位，所以换模型时必须落到一个真实档位：优先沿用上一个
 *  仍受支持的档位，否则取 medium，再否则取最弱档。宿主新会话默认也是 medium。 */
function defaultEffort(levels: readonly string[], previous: string | null): string | null {
  if (!levels.length) return null;
  if (previous && levels.includes(previous)) return previous;
  return levels.includes("medium") ? "medium" : levels[0];
}

export function ModelEntry({ context, choices, engines, loading, onApply, onSelectEngine, onRefresh }: ModelEntryProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ExecutionSelectionInput | null>(context.selection);
  const [version, setVersion] = useState<number | null>(context.selection?.version ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const targetKey = JSON.stringify(context.target);
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const currentChoice = context.selection && choices.find((c) => selectionIdentity(c.modelSelection) === selectionIdentity(context.selection!.modelSelection));
  const draftChoice = draft && choices.find((c) => selectionIdentity(c.modelSelection) === selectionIdentity(draft.modelSelection));
  const draftEffort = draftChoice ? defaultEffort(draftChoice.capabilities.effortLevels, draft?.effort ?? null) : null;
  useEffect(() => {
    setDraft(context.selection); setVersion(context.selection?.version ?? null); setOpen(false); setSearch(""); setError(""); setBusy(false);
  }, [targetKey, context.selection?.version]);
  const selection = context.selection?.modelSelection;
  const engineLabel = engines.find((item) => item.engineId === context.target.engineId)?.label ?? context.target.engineId;
  const keyLabel = selection?.source === "contribution" ? selection.credential?.remark || selection.credential?.name || "未选 Key" : "CLI 自带登录";
  const sourceLabel = selection?.source === "native" ? selection.channelId ? "旧版渠道" : "CLI 原生" : currentChoice?.group ?? "供应商不可用";
  const modelLabel = currentChoice?.label ?? (selection?.source === "native" ? selection.modelId ?? "原生默认" : "待选择模型");
  const summary = `${engineLabel} · ${sourceLabel} · ${modelLabel} · ${keyLabel} · ${context.selection?.effort ?? "无档位"}`;

  function choose(choice: ExecutionChoice) {
    let modelSelection = structuredClone(choice.modelSelection);
    if (modelSelection.source === "contribution" && draft?.modelSelection.source === "contribution" && modelSelection.sourceId === draft.modelSelection.sourceId && modelSelection.profileKey === draft.modelSelection.profileKey) {
      const previous = draft.modelSelection.credential;
      if (previous && choice.credentials.some((c) => c.credentialId === previous.credentialId && c.credentialRevision === previous.credentialRevision)) modelSelection = { ...modelSelection, credential: previous };
    }
    setDraft({ modelSelection, effort: defaultEffort(choice.capabilities.effortLevels, draft?.effort ?? null) }); setError("");
  }

  async function apply() {
    if (!draft) return;
    const input = { modelSelection: draft.modelSelection, effort: draftEffort };
    try { validateSelectionDraft(draftChoice ?? undefined, input); } catch (e) { setError(e instanceof Error ? e.message : "选择无效"); return; }
    const target = targetKey; setBusy(true); setError("");
    try { await onApply(input, version); if (targetRef.current === target) setOpen(false); }
    catch { if (targetRef.current === target) setError("选择未生效。会话或 Key 可能已变化，请刷新后重新确认完整选择。"); }
    finally { if (targetRef.current === target) setBusy(false); }
  }

  /** 切 CLI 不是筛选：宿主换掉整个执行目标，本组件随后带着新目标自己的选择重挂。 */
  async function switchEngine(engineId: string) {
    if (engineId === context.target.engineId) return;
    setBusy(true); setError("");
    try { await onSelectEngine(engineId); }
    catch { setError("无法切换到该 CLI。已开始的会话会保留原有 CLI，请新建会话后再选。"); }
    finally { if (targetRef.current === targetKey) setBusy(false); }
  }

  const filtered = choices.filter((c) => `${c.label} ${c.group} ${c.modelSelection.source === "native" ? "原生 native" : "供应商 provider"} ${c.credentials.map((k) => `${k.name} ${k.remark ?? ""}`).join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  return <div className="up up-picker">
    <Button className="up-picker-trigger" aria-expanded={open} aria-label={summary} onClick={() => { if (!open) { setDraft(context.selection); setVersion(context.selection?.version ?? null); setError(""); } setOpen(!open); }}>{summary}</Button>
    {open && <section className="up-picker-panel" aria-label="会话完整模型选择" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setDraft(context.selection); } }}>
      <div className="up-toolbar"><strong>会话模型选择</strong><Button size="sm" disabled={loading || busy} onClick={() => { setError(""); void onRefresh().catch(() => setError("刷新失败，现有选择未改变。")); }}>刷新</Button></div>
      <p className="up-muted">筛选不会改动会话。点“应用完整选择”才会一次性提交模型、供应商、Key 与推理强度。</p>
      {context.unavailableReason && <p role="alert" className="up-error">{context.unavailableReason}</p>}

      <div role="group" aria-label="已安装的 CLI">
        <h4>CLI</h4>
        <div className="up-engine-list">{engines.map((engine) => {
          const active = engine.engineId === context.target.engineId;
          return <button type="button" key={engine.engineId} className="up-engine-row" aria-pressed={active}
            disabled={busy || (!active && engine.disabled)} title={!active && engine.disabled ? engine.disabledReason : undefined}
            onClick={() => void switchEngine(engine.engineId)}>
            <strong>{engine.label}</strong>
            <span>{active ? "当前会话" : engine.disabled ? engine.disabledReason ?? "不可选" : engine.available ? "可切换" : "本机未安装"}</span>
          </button>;
        })}</div>
        {!engines.some((engine) => !engine.disabled || engine.engineId === context.target.engineId) && <p className="up-muted">本工作区没有其它可切换的 CLI。</p>}
      </div>

      <label>搜索模型、供应商或 Key 备注<Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="up-choice-list" role="group" aria-label={`${engineLabel} 的模型`}>
        {loading && <p role="status">正在载入模型…</p>}
        {!loading && !filtered.length && <p>没有匹配的模型。清空搜索即可看到该 CLI 的原生模型。</p>}
        {filtered.map((choice) => <button type="button" key={choice.choiceId} className="up-choice" aria-pressed={!!draft && selectionIdentity(draft.modelSelection) === selectionIdentity(choice.modelSelection)} disabled={!!choice.unavailableReason || busy} onClick={() => choose(choice)}>
          <strong>{choice.label}</strong><span>{choice.modelSelection.source === "native" ? choice.modelSelection.channelId ? `旧版渠道 · ${choice.group}` : `原生配置 · ${choice.group}` : choice.group}</span>{choice.unavailableReason && <span>{choice.unavailableReason}</span>}
        </button>)}
      </div>

      {draft && draftChoice && <div className="up-stack">
        {draft.modelSelection.source === "contribution" && <label>本会话 Key · 名称 / 备注<Select value={draft.modelSelection.credential ? `${draft.modelSelection.credential.credentialId}:${draft.modelSelection.credential.credentialRevision}` : ""} disabled={busy || !draftChoice.credentials.length} onChange={(event) => {
          const credential = draftChoice.credentials.find((c) => `${c.credentialId}:${c.credentialRevision}` === event.target.value) ?? null;
          if (draft.modelSelection.source === "contribution") setDraft({ ...draft, modelSelection: { ...draft.modelSelection, credential } });
        }}><option value="">{draftChoice.credentials.length ? "请明确选择一个 Key" : "该配置不使用 Key"}</option>{draftChoice.credentials.map((c) => <option key={`${c.credentialId}:${c.credentialRevision}`} value={`${c.credentialId}:${c.credentialRevision}`}>{c.name}{c.remark ? ` · ${c.remark}` : ""} · 第 {c.credentialRevision} 代</option>)}</Select></label>}
        {draftChoice.capabilities.effortLevels.length
          ? <EffortSlider label="推理强度 " minLabel="更快" maxLabel="更深入" levels={draftChoice.capabilities.effortLevels} value={draftEffort} disabled={busy} onValueChange={(effort) => setDraft({ ...draft, effort })} />
          : <p className="up-muted">该模型不支持推理强度。</p>}
        <p className="up-muted">上下文：{draftChoice.tokenPolicy.contextWindowTokens?.toLocaleString() ?? "未知"} · 输出上限：{draftChoice.tokenPolicy.maxOutputTokens?.toLocaleString() ?? "未知"}</p>
      </div>}

      {error && <p role="alert" className="up-error">{error}</p>}
      <div className="up-actions"><Button onClick={() => { setOpen(false); setDraft(context.selection); }}>取消</Button><Button variant="primary" disabled={!draft || busy || loading} onClick={() => void apply()}>{busy ? "正在应用…" : "应用完整选择"}</Button></div>
    </section>}
  </div>;
}
