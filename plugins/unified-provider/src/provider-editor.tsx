import { useState } from "react";
import { Button, Input, Select, Textarea } from "@ccgui/plugin-ui";
import { id, protocols, type Provider, type RegistryView } from "./registry";
import { PolicyEditor, type UpdateDraft } from "./fields";

export function ProviderDetails({ provider, draft, update, keyEdits, editKey }: { provider: Provider; draft: RegistryView; update: UpdateDraft; keyEdits: Record<string, string>; editKey: (credentialId: string, value: string) => void }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const credentials = draft.credentials.filter((c) => c.providerId === provider.id);
  return <div className="up-stack">
    <div className="up-grid"><label>Provider name<Input value={provider.name} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.name = event.target.value; })} /></label>
    <label>Provider note<Textarea value={provider.remark ?? ""} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.remark = event.target.value; })} /></label>
    <label className="up-check"><input type="checkbox" checked={provider.enabled} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.enabled = event.target.checked; })} />Enabled</label>
    <label>Default Key · only when explicitly binding<Select value={provider.defaultCredentialId ?? ""} onChange={(event) => update((r) => { r.providers.find((p) => p.id === provider.id)!.defaultCredentialId = event.target.value || undefined; })}><option value="">No default</option>{credentials.filter((c) => c.enabled).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.remark ?? "No note"}</option>)}</Select></label></div>
    <section className="up-card"><div className="up-toolbar"><h3>Keys</h3><Button size="sm" onClick={() => { const credentialId = id(); update((r) => { r.credentials.push({ id: credentialId, providerId: provider.id, name: "New Key", enabled: true, credentialRevision: 1 }); for (const b of r.bindings.filter((b) => b.providerId === provider.id)) delete b.targetGrantId; }); setEditingKey(credentialId); }}>Add Key</Button></div>
      <p className="up-muted">Keys are stored in plaintext only in this plugin’s private registry.json. Protect its permissions and backups. Ordinary UI, publications and events contain only names and notes. Editing a value creates a new revision; bound sessions must explicitly reselect it.</p>
      {!credentials.length && <p>No Keys. Add one, or use an endpoint without authentication.</p>}
      {credentials.map((c) => <fieldset key={c.id} className="up-card"><legend>{c.name} · •••••••• · revision {c.credentialRevision}</legend>
        <div className="up-grid"><label>Key name<Input value={c.name} onChange={(event) => update((r) => { r.credentials.find((k) => k.id === c.id)!.name = event.target.value; })} /></label>
        <label>Key note<Input value={c.remark ?? ""} onChange={(event) => update((r) => { r.credentials.find((k) => k.id === c.id)!.remark = event.target.value; })} /></label>
        <label className="up-check"><input type="checkbox" checked={c.enabled} onChange={(event) => update((r) => { r.credentials.find((k) => k.id === c.id)!.enabled = event.target.checked; for (const b of r.bindings.filter((b) => b.providerId === provider.id)) delete b.targetGrantId; })} />Enabled</label></div>
        {editingKey === c.id ? <label>New Key value · never displays the saved value<Input type="password" autoComplete="new-password" spellCheck={false} value={keyEdits[c.id] ?? ""} onChange={(event) => editKey(c.id, event.target.value)} /></label> : <Button size="sm" onClick={() => setEditingKey(c.id)}>Edit Key value explicitly</Button>}
        <Button size="sm" variant="ghost" onClick={() => update((r) => { r.credentials = r.credentials.filter((k) => k.id !== c.id); const p = r.providers.find((p) => p.id === provider.id)!; if (p.defaultCredentialId === c.id) delete p.defaultCredentialId; for (const b of r.bindings.filter((b) => b.providerId === provider.id)) { delete b.targetGrantId; if (b.credential.kind === "explicit" && b.credential.credentialId === c.id) { b.credential = { kind: "inherit" }; b.enabled = false; } } })}>Remove Key from draft</Button>
      </fieldset>)}
    </section>
    <section className="up-card"><div className="up-toolbar"><h3>Endpoints</h3><Button size="sm" onClick={() => update((r) => { r.endpoints.push({ id: id(), providerId: provider.id, name: "New endpoint", baseUrl: "", protocol: "openai-responses", auth: "bearer", enabled: true }); })}>Add endpoint</Button></div>
      {draft.endpoints.filter((e) => e.providerId === provider.id).map((endpoint) => <fieldset className="up-card" key={endpoint.id}><legend>{endpoint.name}</legend><div className="up-grid">
        <label>Name<Input value={endpoint.name} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.name = event.target.value; })} /></label>
        <label>Full Base URL<Input type="url" placeholder="https://api.example.com/v1" value={endpoint.baseUrl} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.baseUrl = event.target.value; for (const b of r.bindings.filter((b) => b.endpointId === endpoint.id)) delete b.targetGrantId; })} /></label>
        <label>Protocol<Select value={endpoint.protocol} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.protocol = event.target.value as typeof endpoint.protocol; for (const b of r.bindings.filter((b) => b.endpointId === endpoint.id)) delete b.targetGrantId; })}>{protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}</Select></label>
        <label>Authentication<Select value={endpoint.auth} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.auth = event.target.value as typeof endpoint.auth; for (const b of r.bindings.filter((b) => b.endpointId === endpoint.id)) delete b.targetGrantId; })}><option value="bearer">Bearer Key</option><option value="api-key">API Key</option><option value="none">None</option></Select></label>
        <label className="up-check"><input type="checkbox" checked={endpoint.enabled} onChange={(event) => update((r) => { r.endpoints.find((e) => e.id === endpoint.id)!.enabled = event.target.checked; })} />Enabled</label>
      </div><Button size="sm" variant="ghost" onClick={() => update((r) => { const bindings = r.bindings.filter((b) => b.endpointId === endpoint.id).map((b) => b.id); r.endpoints = r.endpoints.filter((e) => e.id !== endpoint.id); r.bindings = r.bindings.filter((b) => b.endpointId !== endpoint.id); r.mappings = r.mappings.filter((m) => !bindings.includes(m.bindingId)); for (const m of r.models) delete m.wireIds[endpoint.id]; })}>Remove endpoint and its CLI mappings from draft</Button></fieldset>)}
    </section>
  </div>;
}

export function ProviderModels({ providerId, draft, update }: { providerId: string; draft: RegistryView; update: UpdateDraft }) {
  return <section className="up-stack"><div className="up-toolbar"><h3>Provider models</h3><Button onClick={() => update((r) => { r.models.push({ id: id(), providerId, name: "New model", wireIds: {}, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } }); })}>Add model</Button></div><p className="up-muted">Display names are not identities. Separate logical models can use the same wire ID for independent CLI aliases. Shared policy affects only mappings that still inherit it.</p>
    {draft.models.filter((m) => m.providerId === providerId).map((model) => <fieldset className="up-card" key={model.id}><legend>{model.name}</legend>
      <label>Display name<Input value={model.name} onChange={(event) => update((r) => { r.models.find((m) => m.id === model.id)!.name = event.target.value; })} /></label>
      <div className="up-grid">{draft.endpoints.filter((e) => e.providerId === providerId).map((endpoint) => <label key={endpoint.id}>{endpoint.name} · wire model ID<Input value={model.wireIds[endpoint.id] ?? ""} onChange={(event) => update((r) => { const m = r.models.find((m) => m.id === model.id)!; if (event.target.value) m.wireIds[endpoint.id] = event.target.value; else delete m.wireIds[endpoint.id]; })} /></label>)}
      {(["images", "tools"] as const).map((capability) => <label key={capability}>{capability} · user declaration<Select value={model.capabilities[capability]} onChange={(event) => update((r) => { r.models.find((m) => m.id === model.id)!.capabilities[capability] = event.target.value as typeof model.capabilities.images; })}><option value="unknown">Unknown · inherit template</option><option value="supported">Supported</option><option value="unsupported">Unsupported</option></Select></label>)}
      <label>Allowed efforts · comma-separated, empty inherits template<Input value={model.capabilities.effortLevels.join(",")} onChange={(event) => update((r) => { r.models.find((m) => m.id === model.id)!.capabilities.effortLevels = event.target.value.split(",").map((v) => v.trim()).filter(Boolean); })} /></label></div>
      <PolicyEditor scope="Shared model policy" value={model.sharedPolicy} onChange={(value) => update((r) => { r.models.find((m) => m.id === model.id)!.sharedPolicy = value; })} />
      <Button size="sm" variant="ghost" onClick={() => update((r) => { r.models = r.models.filter((m) => m.id !== model.id); r.mappings = r.mappings.filter((m) => m.providerModelId !== model.id); })}>Remove model and mappings from draft</Button>
    </fieldset>)}
  </section>;
}
