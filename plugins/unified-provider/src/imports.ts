import type { NativeImportResult, OfficialTemplateRef } from "@ccgui/plugin-sdk";
import { compatible, id, validateRegistry, type Registry } from "./registry";

export interface ImportDecision {
  candidateId: string; action: "new" | "merge" | "skip"; providerId?: string;
  engineId: string; templateRef?: OfficialTemplateRef;
  /** 是否把原生文件里的静态 Key 复制到这条新端点上。 */
  importKey: boolean;
  /** 该供应商已有同一个 CLI 的线路时，必须确认再并存一条。 */
  conflictConfirmed?: boolean;
}
/** 每个候选项都导入成一条**新端点**：地址、认证方式和它自己的 Key 一起进来。
 *  已有端点永不被替换或改写——那会连带毁掉它上面的 Key 与授权。
 *  标签、URL 和 Key 文本都不是身份，不据此自动合并。 */
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
    if (provider && next.bindings.some((b) => b.providerId === provider!.id && b.engineId === decision.engineId) && !decision.conflictConfirmed) throw new Error("该供应商已有这个 CLI 的线路，请确认是否再并存一条");
    if (!provider) { provider = { id: id(), name: candidate.label, enabled: true, revision: 1 }; next.providers.push(provider); }
    const endpointId = id();
    let credentialId: string | undefined;
    if (decision.importKey) {
      if (!candidate.hasStaticKey) throw new Error("该候选项没有可复制的静态 Key，请改为稍后手动填写");
      if (!candidate.value) throw new Error("宿主未提供静态 Key，请重新预览或手动填写");
      credentialId = id();
      next.credentials.push({ id: credentialId, endpointId, name: candidate.credentialName ?? `${candidate.label} 导入的 Key`, remark: "从 CLI 原生配置复制", value: candidate.value, enabled: true, credentialRevision: 1 });
    }
    // 认证端点缺 Key 时线路先停用：不阻塞整次发布，也不假装它能直接跑。
    const usable = candidate.auth === "none" || credentialId !== undefined;
    next.endpoints.push({ id: endpointId, providerId: provider.id, name: `${candidate.label} · ${decision.engineId}`, protocol: candidate.protocol, baseUrl: candidate.baseUrl, auth: candidate.auth, enabled: true, ...(credentialId ? { defaultCredentialId: credentialId } : {}) });
    const bindingId = id();
    next.bindings.push({ id: bindingId, providerId: provider.id, engineId: decision.engineId, endpointId, credential: { kind: "inherit" }, executionTarget: { kind: "local" }, options: {}, enabled: usable });
    for (const wireId of [...new Set(candidate.models)]) {
      const modelId = id();
      next.models.push({ id: modelId, providerId: provider.id, name: wireId, wireIds: { [endpointId]: wireId }, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } });
      next.mappings.push({ id: id(), bindingId, providerModelId: modelId, templateRef: decision.templateRef, selector: { kind: "wire" }, policy: {}, enabled: true });
    }
  }
  return validateRegistry(next);
}
