import type { CredentialIdentity, DiscoveredModel, ExecutionProfile, ModelChoiceContribution, TokenPolicy } from "@ccgui/plugin-sdk";
import { compatible, endpointCredentials, policyKeys, probeEngine, probeProfileKey, validateRegistry, validateTokenPolicy, wslUnsupported, type Binding, type CredentialRef, type Endpoint, type PolicyOverrides, type Registry } from "./registry";

export type TemplateLookup = (binding: Binding) => readonly DiscoveredModel[];
export interface RegistryProjection { profiles: ExecutionProfile[]; choices: ModelChoiceContribution[] }
export const enginePolicies: Record<string, { unsupported: (keyof TokenPolicy)[]; required: (keyof TokenPolicy)[] }> = {
  claude: { unsupported: ["contextWindowTokens", "autoCompactionThresholdTokens"], required: [] },
  codex: { unsupported: ["maxOutputTokens"], required: [] },
  grok: { unsupported: ["autoCompactionThresholdTokens"], required: [] },
  kimi: { unsupported: ["maxOutputTokens"], required: ["contextWindowTokens"] },
  pi: { unsupported: ["autoCompactionThresholdTokens"], required: ["contextWindowTokens", "maxOutputTokens"] },
  omp: { unsupported: [], required: ["contextWindowTokens", "maxOutputTokens"] },
  opencode: { unsupported: [], required: ["contextWindowTokens", "maxOutputTokens"] },
};
/** Key 属于端点这条线路：解析顺序是显式选择 > 绑定显式 Key > 端点默认 Key。
 *  都没有时，只在这条线路**恰好只有一个**启用 Key 的情况下用它——唯一候选不是
 *  猜测。有两个以上时必须明确选择：绝不替换，也不在失败后换一个 Key 重试。 */
export function credentialForEndpoint(r: Registry, endpoint: Endpoint, binding?: Binding, explicitId?: string): CredentialRef {
  const enabled = endpointCredentials(r.credentials, endpoint.id).filter((c) => c.enabled);
  const credentialId = explicitId
    ?? (binding?.credential.kind === "explicit" ? binding.credential.credentialId : undefined)
    ?? endpoint.defaultCredentialId
    ?? (enabled.length === 1 ? enabled[0].id : undefined);
  const credential = enabled.find((c) => c.id === credentialId);
  if (!credential) throw new Error(enabled.length > 1 ? "该端点有多个启用的 Key，请明确选择一个；不会替你挑选。" : "所选 Key 缺失或已禁用。请在该端点里添加或启用一个 Key，不会尝试替换。");
  return credential;
}
export function credentialIdentity(c: Pick<CredentialRef, "id" | "credentialRevision" | "name" | "remark">): CredentialIdentity {
  return { credentialId: c.id, credentialRevision: c.credentialRevision, name: c.name, ...(c.remark ? { remark: c.remark } : {}) };
}
export function resolvePolicy(official: TokenPolicy, shared: PolicyOverrides, perCli: PolicyOverrides): Pick<ModelChoiceContribution, "tokenPolicy" | "policySources"> {
  const tokenPolicy: TokenPolicy = {};
  const policySources: NonNullable<ModelChoiceContribution["policySources"]> = {};
  for (const key of policyKeys) {
    let value = official[key];
    let source: "official" | "user" = "official";
    for (const layer of [shared, perCli]) {
      const override = layer[key];
      if (!override || override.kind === "inherit") continue;
      value = override.kind === "clear" ? undefined : override.value;
      source = "user";
    }
    if (value !== undefined) { tokenPolicy[key] = value; policySources[key] = source; }
  }
  validateTokenPolicy(tokenPolicy);
  return { tokenPolicy, policySources };
}
/** 拉取模型用的「只发现」执行配置：零个模型选项，所以不会出现在模型菜单里，
 *  但给了宿主一个已授权的目标，让端点在配好任何 CLI 之前就能列模型。 */
function probeProfile(r: Registry, endpoint: Endpoint, label: string): ExecutionProfile | null {
  if (!endpoint.probeGrantId) return null;
  const credentials = endpoint.auth === "none" ? [] : endpointCredentials(r.credentials, endpoint.id).filter((c) => c.enabled).map(credentialIdentity);
  if (endpoint.auth !== "none" && !credentials.length) return null;
  const defaultCredentialId = credentials.some((c) => c.credentialId === endpoint.defaultCredentialId) ? endpoint.defaultCredentialId : undefined;
  return {
    profileKey: probeProfileKey(endpoint.id), engineId: probeEngine(endpoint.protocol), label, group: label,
    protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, auth: endpoint.auth, executionTarget: { kind: "local" },
    targetGrantId: endpoint.probeGrantId, credentialScope: endpoint.id, credentials,
    ...(defaultCredentialId ? { defaultCredentialId } : {}), options: {},
  };
}
export function projectRegistry(r: Registry, lookup: TemplateLookup): RegistryProjection {
  validateRegistry(r);
  const profiles: ExecutionProfile[] = [];
  const choices: ModelChoiceContribution[] = [];
  for (const endpoint of r.endpoints) {
    const provider = r.providers.find((p) => p.id === endpoint.providerId)!;
    if (!endpoint.enabled || !provider.enabled) continue;
    const probe = probeProfile(r, endpoint, provider.name);
    if (probe) profiles.push(probe);
  }
  for (const binding of r.bindings) {
    const provider = r.providers.find((p) => p.id === binding.providerId)!;
    const endpoint = r.endpoints.find((e) => e.id === binding.endpointId)!;
    if (!binding.enabled || !provider.enabled || !endpoint.enabled) continue;
    if (!compatible(binding.engineId, endpoint.protocol)) throw new Error(`${binding.engineId} 不支持 ${endpoint.protocol}，请禁用或修改此绑定`);
    if (binding.executionTarget.kind === "wsl" && wslUnsupported.includes(binding.engineId as typeof wslUnsupported[number])) throw new Error(`${binding.engineId} 不支持受管 WSL 执行`);
    if (!binding.targetGrantId) throw new Error(`发布前请为 ${provider.name} 的 ${binding.engineId} 线路授权它的准确目标`);
    const credentials = endpoint.auth === "none" ? [] : endpointCredentials(r.credentials, endpoint.id).filter((c) => c.enabled).map(credentialIdentity);
    const defaultCredentialId = endpoint.auth === "none" ? undefined : credentialForEndpoint(r, endpoint, binding).id;
    profiles.push({ profileKey: binding.id, engineId: binding.engineId, label: provider.name, group: provider.name, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, auth: endpoint.auth, executionTarget: binding.executionTarget, targetGrantId: binding.targetGrantId, credentialScope: endpoint.id, credentials, ...(defaultCredentialId ? { defaultCredentialId } : {}), options: binding.options });
    const templates = lookup(binding);
    const mappings = r.mappings.filter((m) => m.bindingId === binding.id && m.enabled);
    if (binding.defaultModelId) mappings.sort((a, b) => Number(b.providerModelId === binding.defaultModelId) - Number(a.providerModelId === binding.defaultModelId));
    for (const mapping of mappings) {
      const model = r.models.find((m) => m.id === mapping.providerModelId)!;
      const wireId = model.wireIds[endpoint.id];
      if (!wireId) throw new Error(`${model.name} 未配置 ${endpoint.name} 对应的 wire 模型 ID`);
      const template = templates.find((t) => t.templateRef?.engineId === mapping.templateRef.engineId && t.templateRef.modelId === mapping.templateRef.modelId && t.templateRef.revision === mapping.templateRef.revision);
      if (!template) throw new Error(`${model.name} 的官方模板不可用或已变化，请刷新模板并明确核对映射。`);
      if (template.protocol && !compatible(binding.engineId, template.protocol)) throw new Error("官方模板的协议与该 CLI 不兼容");
      const capabilities = {
        images: model.capabilities.images === "unknown" ? template.capabilities.images : model.capabilities.images,
        tools: model.capabilities.tools === "unknown" ? template.capabilities.tools : model.capabilities.tools,
        effortLevels: model.capabilities.effortLevels.length ? model.capabilities.effortLevels : template.capabilities.effortLevels,
      };
      if (template.capabilities.images === "unsupported" && capabilities.images === "supported") throw new Error("官方模板不支持图片");
      if (template.capabilities.tools === "unsupported" && capabilities.tools === "supported") throw new Error("官方模板不支持工具");
      if (capabilities.effortLevels.some((level) => !template.capabilities.effortLevels.includes(level))) throw new Error("官方 CLI 模板不支持所选推理强度");
      const policy = resolvePolicy(template.tokenPolicy, model.sharedPolicy, mapping.policy);
      const constraints = enginePolicies[binding.engineId];
      for (const key of constraints?.unsupported ?? []) if (policy.tokenPolicy[key] !== undefined) throw new Error(`${binding.engineId} 无法应用 ${key}，请在此 CLI 映射中显式清空该字段`);
      for (const key of constraints?.required ?? []) if (policy.tokenPolicy[key] === undefined) throw new Error(`${binding.engineId} 必须明确配置 ${key}，请填写经核对的共享策略或 CLI 覆盖值`);
      choices.push({ profileKey: binding.id, modelKey: mapping.id, label: model.name, selector: mapping.selector.kind === "alias" ? { kind: "alias", alias: mapping.selector.alias, modelId: wireId } : { kind: "wire", modelId: wireId }, templateRef: mapping.templateRef, ...policy, capabilities, managementKey: "providers" });
    }
  }
  return { profiles, choices };
}
