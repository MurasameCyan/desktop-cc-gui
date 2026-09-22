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
  useEffect(() => { let active = true; void controller.listConfigTargets().then((value) => { if (active) setTargets(value); }).catch(() => { if (active) setError("Cannot list native sources. Check desktop config-read permissions."); }); return () => { active = false; }; }, [controller]);
  async function previewSource() {
    setBusy(true); setError("");
    try {
      const result = await controller.previewImport(targetId);
      const official = await controller.loadTemplates({ id: "import-preview", providerId: "", endpointId: "", engineId: result.target.engineId, enabled: true, credential: { kind: "inherit" }, executionTarget: { kind: "local" }, options: {} }, true);
      setPreview(result); setTemplates(official); setDecisions(result.candidates.map((c) => ({ candidateId: c.candidateId, action: (c.hasStaticKey || c.auth === "none") && c.models.length && compatible(result.target.engineId, c.protocol) ? "new" : "skip", engineId: result.target.engineId, credentialDecision: "new", bindingDecision: "replace" }))); setStep(2);
    } catch { setError("Source preview or official templates are unavailable. No registry or native file was changed. Try another supported source."); }
    finally { setBusy(false); }
  }
  function revise(candidateId: string, change: Partial<ImportDecision>) { setDecisions((items) => items.map((d) => d.candidateId === candidateId ? { ...d, ...change } : d)); }
  function review() {
    const chosen = decisions.filter((d) => d.action !== "skip");
    if (!chosen.length || chosen.some((d) => !d.templateRef || d.action === "merge" && (!d.providerId || !d.conflictConfirmed))) { setError("Choose at least one candidate, an official template for each, and explicitly confirm all merge decisions."); return; }
    setError(""); setStep(3);
  }
  async function confirm() {
    if (!preview || !riskAccepted) return;
    setBusy(true); setError("");
    try { await controller.confirmImport(preview, decisions, version); onClose(); }
    catch { setError("Import did not complete. The source/registry may have changed, or host confirmation was denied. Re-preview before retrying. If the document was already saved, use Retry publication outside this wizard rather than importing again."); }
    finally { setBusy(false); }
  }
  return <section className="up-card up-wizard" aria-label="Import native CLI configuration">
    <div className="up-toolbar"><h2>Import native CLI configuration</h2><Button disabled={busy} onClick={onClose}>Cancel · change nothing</Button></div>
    <ol className="up-steps" aria-label="Import steps">{["Choose source", "Review mappings", "Confirm copy"].map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined}>{index + 1}. {label}</li>)}</ol>
    {step === 1 && <><p>Only recognized sources are offered. OAuth, environment references, commands, hooks and unknown fields stay in native configuration.</p>
      <label>Native CLI / source<Select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">Choose a source</option>{targets.map((target) => <option key={target.targetId} value={target.targetId} disabled={!target.importSupported}>{target.label}{!target.importSupported ? ` · ${target.unsupportedReason ?? "Import unsupported"}` : ""}</option>)}</Select></label>
      {targets.filter((target) => target.targetId === targetId).map((target) => <div key={target.targetId}><h3>{target.label}</h3><ul>{target.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>)}
      {!targets.length && <p>No recognized sources available. Refresh by closing and reopening this wizard.</p>}
      <Button variant="primary" disabled={!targetId || busy} onClick={() => void previewSource()}>{busy ? "Reading redacted preview…" : "Preview source"}</Button></>}
    {step === 2 && preview && <><p>{preview.target.label} · {preview.candidates.length} recognized candidates. Same name or URL never implies the same account.</p>{preview.warnings.map((warning) => <p className="up-muted" key={warning}>{warning}</p>)}
      {preview.candidates.map((candidate) => { const decision = decisions.find((d) => d.candidateId === candidate.candidateId)!; return <fieldset className="up-card" key={candidate.candidateId}><legend>{candidate.label}</legend>
        <p>{candidate.protocol} · {candidate.baseUrl} · native auth: {candidate.auth}</p><p>Models: {candidate.models.join(", ") || "None recognized"}</p><p>Key: {candidate.hasStaticKey ? `${candidate.credentialName ?? "Static Key"} · ••••••••` : "No transferable static Key"}</p>
        {!!candidate.skippedFields.length && <p className="up-muted">Kept in native configuration: {candidate.skippedFields.join(", ")}</p>}
        <div className="up-grid"><label>Import decision<Select value={decision.action} onChange={(event) => revise(candidate.candidateId, { action: event.target.value as ImportDecision["action"], conflictConfirmed: false })}><option value="skip">Skip</option><option value="new" disabled={!candidate.hasStaticKey && candidate.auth !== "none" || !candidate.models.length || !compatible(preview.target.engineId, candidate.protocol)}>Create a separate Provider</option><option value="merge" disabled={!registry.providers.length || !candidate.models.length || !compatible(preview.target.engineId, candidate.protocol)}>Merge into an existing Provider</option></Select></label>
        {decision.action !== "skip" && <label>Official template<Select value={decision.templateRef ? templates.findIndex((t) => t.templateRef?.modelId === decision.templateRef?.modelId && t.templateRef?.revision === decision.templateRef?.revision) : ""} onChange={(event) => revise(candidate.candidateId, { templateRef: event.target.value === "" ? undefined : templates[Number(event.target.value)]?.templateRef })}><option value="">Choose template explicitly</option>{templates.map((t, index) => <option key={`${t.modelId}:${t.templateRef?.revision}`} value={index}>{t.label ?? t.modelId} · {t.templateRef?.revision.slice(0, 8)}</option>)}</Select></label>}
        {decision.action === "merge" && <><label>Existing Provider<Select value={decision.providerId ?? ""} onChange={(event) => revise(candidate.candidateId, { providerId: event.target.value, conflictConfirmed: false })}><option value="">Choose Provider</option>{registry.providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.remark ?? "No note"}</option>)}</Select></label>
          <label>Key conflict<Select value={decision.credentialDecision} onChange={(event) => revise(candidate.candidateId, { credentialDecision: event.target.value as "new" | "keep", conflictConfirmed: false })}><option value="new" disabled={!candidate.hasStaticKey}>Create a separate named Key · never overwrite</option><option value="keep">Keep the existing Provider default Key</option></Select></label>
          <label>Existing CLI binding conflict<Select value={decision.bindingDecision} onChange={(event) => revise(candidate.candidateId, { bindingDecision: event.target.value as "replace" | "keep", conflictConfirmed: false })}><option value="replace">Replace this CLI mapping with new independent models</option><option value="keep">Keep the existing CLI mapping unchanged</option></Select></label>
          <label className="up-check"><input type="checkbox" checked={!!decision.conflictConfirmed} onChange={(event) => revise(candidate.candidateId, { conflictConfirmed: event.target.checked })} />I reviewed the Provider, Key and mapping conflicts</label></>}
        </div></fieldset>; })}
      <div className="up-actions"><Button onClick={() => { setPreview(null); setDecisions([]); setStep(1); }}>Back to source</Button><Button variant="primary" onClick={review}>Review final copy</Button></div></>}
    {step === 3 && preview && <><h3>Confirm one-time copy</h3><ul>{decisions.filter((d) => d.action !== "skip").map((d) => <li key={d.candidateId}>{preview.candidates.find((c) => c.candidateId === d.candidateId)?.label}: {d.action === "new" ? "new Provider" : `merge into ${registry.providers.find((p) => p.id === d.providerId)?.name}`} · {d.engineId} · {d.templateRef?.modelId} · Key {d.credentialDecision} · CLI mapping {d.bindingDecision}</li>)}</ul>
      <p>Host confirmation rechecks the source fingerprint and authorizes every new destination. Import writes only registry.json with a version check, then publishes atomically. Native files are not changed, deleted or automatically kept in sync.</p>
      <label className="up-check"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} />I understand copied static Keys will exist in both native files and the private plugin registry; I will protect permissions and backups.</label>
      <div className="up-actions"><Button disabled={busy} onClick={() => { setRiskAccepted(false); setStep(2); }}>Back</Button><Button variant="primary" disabled={!riskAccepted || busy} onClick={() => void confirm()}>{busy ? "Confirming and saving…" : "Confirm import and publish"}</Button></div></>}
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
  useEffect(() => { let active = true; void controller.listConfigTargets().then((items) => { if (active) setTargets(items); }).catch(() => { if (active) setMessage("Cannot list recognized native config targets."); }); return () => { active = false; }; }, [controller]);
  async function perform(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch { setMessage("Native operation was not completed. Source drift, permissions or unsupported config may require a fresh preview. Review the registry status before leaving this page."); } finally { setBusy(false); } }
  return <section className="up-stack"><h3>Native configuration · explicit operations</h3><p>Saving Providers and choosing session models never writes native files. These separate operations may change CLI-wide defaults and create an additional plaintext Key copy.</p>
    <label>Known native target<Select value={targetId} onChange={(event) => { setTargetId(event.target.value); setPreview(null); setConfirmed(false); }}><option value="">Choose target</option>{targets.map((target) => <option key={target.targetId} value={target.targetId} disabled={!target.applySupported}>{target.label}{!target.applySupported ? ` · ${target.unsupportedReason ?? "Apply unsupported"}` : ""}</option>)}</Select></label>
    {targets.filter((target) => !target.applySupported).map((target) => <p className="up-muted" key={target.targetId}>{target.label}: {target.unsupportedReason ?? "Native apply/restore is not supported"}</p>)}
    <Button disabled={!targetId || busy} onClick={() => void perform(async () => { setPreview(await controller.previewPatch(targetId)); setConfirmed(false); })}>Preview current session selection → native config</Button>
    {preview && <section className="up-card"><h4>{preview.target.label}</h4><ul>{preview.target.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul><ul>{preview.changes.map((change, index) => <li key={index}>{change}</li>)}</ul><p>{preview.containsPlaintextKey ? "This writes a plaintext Key into native config." : "This patch does not write a plaintext Key."}</p>
      <label className="up-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed this exact native-file diff and approve the write</label>
      <Button variant="primary" disabled={!confirmed || busy} onClick={() => void perform(async () => { await controller.applyPatch(preview.previewId); setPreview(null); setConfirmed(false); setMessage("Native patch applied; its restore receipt is recorded in registry.json."); })}>Apply previewed native patch</Button>
    </section>}
    <h4>Recorded native patches</h4>{!registry.patchReceipts.length && <p>No native patches recorded.</p>}
    {registry.patchReceipts.map((receipt) => <div className="up-card" key={receipt.receiptId}><p>{receipt.targetId} · receipt {receipt.receiptId}</p><p className="up-muted">Restore checks the recorded fingerprint and refuses to overwrite subsequent external changes.</p><Button disabled={busy} onClick={() => void perform(async () => { await controller.restorePatch(receipt.receiptId); setMessage("Native patch restored."); })}>Restore this native patch</Button></div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
