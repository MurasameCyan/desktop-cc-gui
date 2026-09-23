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
    if (!candidate) throw new Error("导入候选项已过期，请重新预览来源");
    if (!compatible(decision.engineId, candidate.protocol)) throw new Error("该原生候选项无法映射到对应的 CLI 协议");
    if (!candidate.models.length || !decision.templateRef || decision.templateRef.engineId !== decision.engineId) throw new Error("导入前请选择官方模板，并确保至少有一个已识别的模型");
    let provider = decision.action === "merge" ? next.providers.find((p) => p.id === decision.providerId) : undefined;
    if (decision.action === "merge" && !provider) throw new Error("请选择要合并到的已有供应商");
    if (!provider) { provider = { id: id(), name: candidate.label, enabled: true, revision: 1 }; next.providers.push(provider); }
    const existingBinding = next.bindings.find((b) => b.providerId === provider.id && b.engineId === decision.engineId);
    if (existingBinding && !decision.conflictConfirmed) throw new Error("请确认保留还是替换已有 CLI 映射");
    if (decision.action === "merge" && next.credentials.some((c) => c.providerId === provider.id) && candidate.hasStaticKey && !decision.conflictConfirmed) throw new Error("请确认 Key 冲突的处理方式");
    let credentialId = provider.defaultCredentialId;
    if (decision.credentialDecision === "new" && candidate.hasStaticKey) {
      if (!candidate.value) throw new Error("宿主未提供静态 Key，请重新预览或手动填写");
      credentialId = id();
      next.credentials.push({ id: credentialId, providerId: provider.id, name: candidate.credentialName ?? `${candidate.label} 导入的 Key`, remark: "从 CLI 原生配置复制", value: candidate.value, enabled: true, credentialRevision: 1 });
      if (!provider.defaultCredentialId) provider.defaultCredentialId = credentialId;
    }
    if (!credentialId && candidate.auth !== "none") throw new Error("没有可用的静态 Key。请跳过此候选项，将 OAuth 或环境变量认证保留在原生配置中。");
    if (existingBinding && decision.bindingDecision === "keep") continue;
    const endpoint = { id: id(), providerId: provider.id, name: `${decision.engineId} 导入端点`, protocol: candidate.protocol, baseUrl: candidate.baseUrl, auth: candidate.auth, enabled: true };
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
