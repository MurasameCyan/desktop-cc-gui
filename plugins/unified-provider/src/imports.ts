import type { NativeImportResult, OfficialTemplateRef } from "@ccgui/plugin-sdk";
import { compatible, id, validateRegistry, type Registry } from "./registry";

export interface ImportDecision {
  candidateId: string; action: "new" | "merge" | "skip"; providerId?: string;
  engineId: string; templateRef?: OfficialTemplateRef;
  credentialDecision: "new" | "keep";
  bindingDecision: "replace" | "keep";
  conflictConfirmed?: boolean;
}
/** Each merge is an explicit decision. Labels, URLs and matching Key text are never identities. */
export function mergeImportedCandidates(registry: Registry, candidates: NativeImportResult["candidates"], decisions: ImportDecision[]): Registry {
  const next = structuredClone(registry);
  for (const decision of decisions) {
    if (decision.action === "skip") continue;
    const candidate = candidates.find((c) => c.candidateId === decision.candidateId);
    if (!candidate) throw new Error("Import candidate expired; preview the source again");
    if (!compatible(decision.engineId, candidate.protocol)) throw new Error("This native candidate cannot be mapped to its CLI protocol");
    if (!candidate.models.length || !decision.templateRef || decision.templateRef.engineId !== decision.engineId) throw new Error("Choose an official template and at least one recognized model before importing");
    let provider = decision.action === "merge" ? next.providers.find((p) => p.id === decision.providerId) : undefined;
    if (decision.action === "merge" && !provider) throw new Error("Choose an existing Provider to merge");
    if (!provider) { provider = { id: id(), name: candidate.label, enabled: true, revision: 1 }; next.providers.push(provider); }
    const existingBinding = next.bindings.find((b) => b.providerId === provider.id && b.engineId === decision.engineId);
    if (existingBinding && !decision.conflictConfirmed) throw new Error("Confirm whether to keep or replace the existing CLI mapping");
    if (decision.action === "merge" && next.credentials.some((c) => c.providerId === provider.id) && candidate.hasStaticKey && !decision.conflictConfirmed) throw new Error("Confirm the Key conflict decision");
    let credentialId = provider.defaultCredentialId;
    if (decision.credentialDecision === "new" && candidate.hasStaticKey) {
      if (!candidate.value) throw new Error("Static Key was not delivered by the host; re-preview or enter it manually");
      credentialId = id();
      next.credentials.push({ id: credentialId, providerId: provider.id, name: candidate.credentialName ?? `${candidate.label} imported Key`, remark: "Copied from CLI native configuration", value: candidate.value, enabled: true, credentialRevision: 1 });
      if (!provider.defaultCredentialId) provider.defaultCredentialId = credentialId;
    }
    if (!credentialId && candidate.auth !== "none") throw new Error("No usable static Key. Skip this candidate and retain OAuth/environment authentication in native configuration.");
    if (existingBinding && decision.bindingDecision === "keep") continue;
    const endpoint = { id: id(), providerId: provider.id, name: `${decision.engineId} import`, protocol: candidate.protocol, baseUrl: candidate.baseUrl, auth: candidate.auth, enabled: true };
    next.endpoints.push(endpoint);
    const bindingId = existingBinding?.id ?? id();
    if (existingBinding) { next.bindings = next.bindings.filter((b) => b.id !== bindingId); next.mappings = next.mappings.filter((m) => m.bindingId !== bindingId); }
    next.bindings.push({ id: bindingId, providerId: provider.id, engineId: decision.engineId, endpointId: endpoint.id, credential: credentialId ? { kind: "explicit", credentialId } : { kind: "inherit" }, executionTarget: { kind: "local" }, options: {}, enabled: true });
    for (const wireId of [...new Set(candidate.models)]) {
      const modelId = id();
      next.models.push({ id: modelId, providerId: provider.id, name: wireId, wireIds: { [endpoint.id]: wireId }, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } });
      next.mappings.push({ id: id(), bindingId, providerModelId: modelId, templateRef: decision.templateRef, selector: { kind: "wire" }, policy: {}, enabled: true });
    }
  }
  return validateRegistry(next);
}
