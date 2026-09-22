import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, Input } from "@ccgui/plugin-ui";
import type { ProviderController } from "./controller";
import { compatible, id, type RegistryView } from "./registry";
import { ProviderDetails, ProviderModels } from "./provider-editor";
import { Bindings } from "./bindings";
import { ImportWizard, NativeOperations } from "./native";
import type { UpdateDraft } from "./fields";

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
    catch (e) { setError(e instanceof Error ? e.message : "Draft change was rejected"); }
  };
  const replaceDraft = (next: RegistryView, expected: RegistryView) => {
    if (draftRef.current !== expected) { setError("The draft changed while target authorization was open. Review the latest draft and authorize again."); return; }
    draftRef.current = next; setDraft(next); setDirty(true);
  };
  const provider = draft?.providers.find((p) => p.id === providerId);
  const unavailable = busy || snapshot.phase === "loading" || snapshot.phase === "saving" || snapshot.phase === "error";
  async function save() {
    if (!draft) return;
    setBusy(true); setError("");
    try { await controller.save(draft, draftVersion, keyEdits); setKeyEdits({}); setDirty(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Save was rejected; reload before retrying"); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError("");
    try { await controller.reload(); const current = controller.snapshot(); if (current.phase !== "error") { setDraft(current.registry ? structuredClone(current.registry) : null); setDraftVersion(current.documentVersion); setKeyEdits({}); setDirty(false); setDiscardConfirmed(false); } }
    finally { setBusy(false); }
  }
  return <main className="up up-settings">
    <header className="up-header"><div><h1>Unified Providers</h1><p className="up-muted">One private registry · per-session Provider, model, Key and effort</p></div><div className="up-toolbar"><Button disabled={unavailable || dirty} onClick={() => setImporting(true)}>Import native CLI configuration</Button><Button disabled={unavailable || importing} onClick={() => { const providerId = id(); update((r) => { r.providers.push({ id: providerId, name: "New Provider", enabled: true, revision: 1 }); }); setProviderId(providerId); setTab("details"); }}>New Provider</Button></div></header>
    <div className={`up-status ${snapshot.phase === "saved-unpublished" || snapshot.phase === "conflict" || snapshot.phase === "error" ? "up-status-warning" : ""}`} role="status"><Badge tone={snapshot.phase === "published" ? "success" : snapshot.phase === "conflict" || snapshot.phase === "error" ? "error" : "neutral"}>{dirty ? "Unsaved draft" : snapshot.phase === "saved-unpublished" ? "Saved · not published" : snapshot.phase}</Badge><span>{snapshot.message}</span>{snapshot.phase === "saved-unpublished" && <Button size="sm" disabled={dirty || unavailable} onClick={() => { void controller.retryPublish().catch(() => setError("Publication retry could not start. Wait for the current operation and retry.")); }}>Retry publication · no new entities</Button>}</div>
    {dirty && <p className="up-muted">Save or discard this draft before importing. Existing sessions remain bound to their previous Key identity; saving defaults never silently rebinds them.</p>}
    {error && <p role="alert" className="up-error">{error}</p>}
    {snapshot.phase === "loading" && <p className="up-card" role="status">Loading the private registry and publication receipt…</p>}
    {draft && importing ? <ImportWizard controller={controller} registry={draft} version={draftVersion} onClose={() => setImporting(false)} /> : draft && <div className="up-layout">
      <aside className="up-sidebar" aria-label="Provider list"><label>Filter Providers<Input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        {!draft.providers.length && <p>No Providers yet. Import recognized native configuration or create one.</p>}
        <div className="up-provider-list">{draft.providers.filter((p) => `${p.name} ${p.remark ?? ""}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((p) => {
          const bindings = draft.bindings.filter((b) => b.providerId === p.id && b.enabled);
          const invalid = bindings.filter((b) => { const e = draft.endpoints.find((e) => e.id === b.endpointId); return !e || !compatible(b.engineId, e.protocol); }).length;
          return <button type="button" key={p.id} className="up-provider-row" aria-pressed={providerId === p.id} onClick={() => setProviderId(p.id)}><strong>{p.name}</strong><span>{p.enabled ? "Enabled" : "Disabled"} · {bindings.length} CLI bindings · {draft.credentials.filter((c) => c.providerId === p.id).length} Keys</span>{invalid > 0 && <span>{invalid} incompatible bindings</span>}{p.remark && <span>{p.remark}</span>}</button>;
        })}</div><Button variant="ghost" onClick={() => { setTab("native"); }}>Native operations</Button>
      </aside>
      <section className="up-detail" aria-label={provider?.name ?? "Provider details"}>
        <div className="up-toolbar"><h2>{tab === "native" ? "Native configuration" : provider?.name ?? "Select a Provider"}</h2>{provider && tab !== "native" && <Button variant="ghost" size="sm" disabled={unavailable} onClick={() => { update((r) => { const bindingIds = r.bindings.filter((b) => b.providerId === provider.id).map((b) => b.id); r.providers = r.providers.filter((p) => p.id !== provider.id); r.endpoints = r.endpoints.filter((e) => e.providerId !== provider.id); r.credentials = r.credentials.filter((c) => c.providerId !== provider.id); r.models = r.models.filter((m) => m.providerId !== provider.id); r.bindings = r.bindings.filter((b) => b.providerId !== provider.id); r.mappings = r.mappings.filter((m) => !bindingIds.includes(m.bindingId)); }); setProviderId(""); }}>Remove Provider from draft</Button>}</div>
        <div className="up-tabs" role="group" aria-label="Provider sections">{[["details", "Details & Keys"], ["models", "Models & shared policy"], ["bindings", "CLI mappings"], ["native", "Native operations"]].map(([key, label]) => <Button key={key} aria-pressed={tab === key} onClick={() => setTab(key)} disabled={key !== "native" && !provider}>{label}</Button>)}</div>
        <fieldset className="up-editor-boundary" disabled={unavailable}>
          {tab === "native" ? <>{dirty && <p>Save or discard the current draft before writing native configuration.</p>}<fieldset className="up-editor-boundary" disabled={dirty}><NativeOperations controller={controller} registry={snapshot.registry ?? draft} /></fieldset></> : provider ? <>
            {tab === "details" && <ProviderDetails key={provider.id} provider={provider} draft={draft} update={update} keyEdits={keyEdits} editKey={(credentialId, value) => { setKeyEdits((current) => ({ ...current, [credentialId]: value })); update((r) => { const credential = r.credentials.find((c) => c.id === credentialId)!; const saved = snapshot.registry?.credentials.find((c) => c.id === credentialId); credential.credentialRevision = saved ? saved.credentialRevision + 1 : 1; for (const binding of r.bindings.filter((b) => b.providerId === credential.providerId)) delete binding.targetGrantId; }); }} />}
            {tab === "models" && <ProviderModels providerId={provider.id} draft={draft} update={update} />}
            {tab === "bindings" && <Bindings key={provider.id} providerId={provider.id} draft={draft} update={update} controller={controller} replaceDraft={replaceDraft} />}
          </> : <p>Select a Provider on the left, or import/create one to begin. Native models remain accessible in the chat picker.</p>}
        </fieldset>
      </section>
    </div>}
    {!importing && <footer className="up-savebar"><div><p>{dirty ? "Draft changes have not reached any session." : "Native files change only through an explicit previewed native operation."}</p>{dirty && <label className="up-check"><input type="checkbox" checked={discardConfirmed} onChange={(event) => setDiscardConfirmed(event.target.checked)} />Discard my unsaved draft on reload</label>}</div><div className="up-actions"><Button disabled={busy || snapshot.phase === "saving" || dirty && !discardConfirmed} onClick={() => void reload()}>Reload registry</Button><Button variant="primary" disabled={unavailable || !draft || !dirty && snapshot.documentVersion !== null} onClick={() => void save()}>{busy ? "Saving…" : "Save and publish"}</Button></div></footer>}
  </main>;
}
