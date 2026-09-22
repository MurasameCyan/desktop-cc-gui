import { useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@ccgui/plugin-ui";
import type { ExecutionChoice, ExecutionSelectionInput, ModelEntryProps } from "@ccgui/plugin-sdk";
import { selectionIdentity, validateSelectionDraft } from "./selection";

export function ModelEntry({ context, choices, loading, onApply, onRefresh }: ModelEntryProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [engine, setEngine] = useState(context.target.engineId);
  const [draft, setDraft] = useState<ExecutionSelectionInput | null>(context.selection);
  const [version, setVersion] = useState<number | null>(context.selection?.version ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const targetKey = JSON.stringify(context.target);
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const currentChoice = context.selection && choices.find((c) => selectionIdentity(c.modelSelection) === selectionIdentity(context.selection!.modelSelection));
  const draftChoice = draft && choices.find((c) => selectionIdentity(c.modelSelection) === selectionIdentity(draft.modelSelection));
  useEffect(() => {
    setDraft(context.selection); setVersion(context.selection?.version ?? null); setEngine(context.target.engineId); setOpen(false); setSearch(""); setError(""); setBusy(false);
  }, [targetKey, context.selection?.version]);
  const selection = context.selection?.modelSelection;
  const keyLabel = selection?.source === "contribution" ? selection.credential?.remark || selection.credential?.name || "No Key" : "Native authentication";
  const sourceLabel = selection?.source === "native" ? selection.channelId ? "Legacy host channel" : "CLI native" : currentChoice?.group ?? "Provider unavailable";
  const summary = `${context.target.engineId} · ${sourceLabel} · ${currentChoice?.label ?? (selection?.source === "native" ? selection.modelId ?? "Native default" : "Select model")} · ${keyLabel} · ${context.selection?.effort ?? "No effort"}`;
  function choose(choice: ExecutionChoice) {
    let modelSelection = structuredClone(choice.modelSelection);
    if (modelSelection.source === "contribution" && draft?.modelSelection.source === "contribution" && modelSelection.sourceId === draft.modelSelection.sourceId && modelSelection.profileKey === draft.modelSelection.profileKey) {
      const previous = draft.modelSelection.credential;
      if (previous && choice.credentials.some((c) => c.credentialId === previous.credentialId && c.credentialRevision === previous.credentialRevision)) modelSelection = { ...modelSelection, credential: previous };
    }
    const levels = choice.capabilities.effortLevels;
    setDraft({ modelSelection, effort: !levels.length ? null : draft?.effort && levels.includes(draft.effort) ? draft.effort : null }); setError("");
  }
  async function apply() {
    if (!draft) return;
    try { validateSelectionDraft(draftChoice ?? undefined, draft); } catch (e) { setError(e instanceof Error ? e.message : "Invalid selection"); return; }
    const target = targetKey; setBusy(true); setError("");
    try { await onApply(draft, version); if (targetRef.current === target) setOpen(false); }
    catch { if (targetRef.current === target) setError("Selection was not applied. The session or Key may have changed; refresh and explicitly review the complete selection."); }
    finally { if (targetRef.current === target) setBusy(false); }
  }
  const filtered = choices.filter((c) => (!engine || c.modelSelection.engineId === engine) && `${c.label} ${c.group} ${c.modelSelection.engineId} ${c.modelSelection.source === "native" ? "native 原生" : "provider"} ${c.credentials.map((k) => `${k.name} ${k.remark ?? ""}`).join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="up up-picker">
    <Button className="up-picker-trigger" aria-expanded={open} aria-label={summary} onClick={() => { if (!open) { setDraft(context.selection); setVersion(context.selection?.version ?? null); setError(""); } setOpen(!open); }}>{summary}</Button>
    {open && <section className="up-picker-panel" aria-label="Complete session model selection" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setDraft(context.selection); } }}>
      <div className="up-toolbar"><strong>Session model selection</strong><Button size="sm" disabled={loading || busy} onClick={() => { setError(""); void onRefresh().catch(() => setError("Refresh failed. Existing selection has not changed.")); }}>Refresh</Button></div>
      <p className="up-muted">Filtering never changes the session. Apply commits model, Provider, Key and effort together.</p>
      {context.unavailableReason && <p role="alert" className="up-error">{context.unavailableReason}</p>}
      <label>Search models, Providers or Key notes<Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>CLI filter<Select value={engine} onChange={(event) => setEngine(event.target.value)}><option value="">All supplied CLIs</option>{[...new Set(choices.map((c) => c.modelSelection.engineId))].map((engineId) => <option key={engineId}>{engineId}</option>)}</Select></label>
      <div className="up-choice-list" role="group" aria-label="Models">
        {loading && <p role="status">Loading models…</p>}
        {!loading && !filtered.length && <p>No matching models. Native models remain available by clearing the filters.</p>}
        {filtered.map((choice) => <button type="button" key={choice.choiceId} className="up-choice" aria-pressed={!!draft && selectionIdentity(draft.modelSelection) === selectionIdentity(choice.modelSelection)} disabled={!!choice.unavailableReason || busy} onClick={() => choose(choice)}>
          <strong>{choice.label}</strong><span>{choice.modelSelection.engineId} · {choice.modelSelection.source === "native" ? choice.modelSelection.channelId ? `Legacy host channel · ${choice.group}` : `Native · ${choice.group}` : choice.group}</span>{choice.unavailableReason && <span>{choice.unavailableReason}</span>}
        </button>)}
      </div>
      {draft && draftChoice && <div className="up-grid">
        {draft.modelSelection.source === "contribution" && <label>Session Key · name / note<Select value={draft.modelSelection.credential ? `${draft.modelSelection.credential.credentialId}:${draft.modelSelection.credential.credentialRevision}` : ""} disabled={busy || !draftChoice.credentials.length} onChange={(event) => {
          const credential = draftChoice.credentials.find((c) => `${c.credentialId}:${c.credentialRevision}` === event.target.value) ?? null;
          if (draft.modelSelection.source === "contribution") setDraft({ ...draft, modelSelection: { ...draft.modelSelection, credential } });
        }}><option value="">{draftChoice.credentials.length ? "Choose an explicit Key" : "No authentication Key"}</option>{draftChoice.credentials.map((c) => <option key={`${c.credentialId}:${c.credentialRevision}`} value={`${c.credentialId}:${c.credentialRevision}`}>{c.name}{c.remark ? ` · ${c.remark}` : ""} · revision {c.credentialRevision}</option>)}</Select></label>}
        <label>Effort<Select value={draft.effort ?? ""} disabled={busy || !draftChoice.capabilities.effortLevels.length} onChange={(event) => setDraft({ ...draft, effort: event.target.value || null })}><option value="">{draftChoice.capabilities.effortLevels.length ? "Choose a supported effort" : "Not applicable"}</option>{draftChoice.capabilities.effortLevels.map((effort) => <option key={effort}>{effort}</option>)}</Select></label>
        <p className="up-muted">Context: {draftChoice.tokenPolicy.contextWindowTokens?.toLocaleString() ?? "unknown"} · Output: {draftChoice.tokenPolicy.maxOutputTokens?.toLocaleString() ?? "unknown"}</p>
      </div>}
      {error && <p role="alert" className="up-error">{error}</p>}
      <div className="up-actions"><Button onClick={() => { setOpen(false); setDraft(context.selection); }}>Cancel</Button><Button variant="primary" disabled={!draft || busy || loading} onClick={() => void apply()}>{busy ? "Applying…" : "Apply complete selection"}</Button></div>
    </section>}
  </div>;
}
