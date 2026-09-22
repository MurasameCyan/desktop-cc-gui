import type { CredentialIdentity, DiscoveredModel, ExecutionProfile, ModelChoiceContribution, TokenPolicy } from "@ccgui/plugin-sdk";
import { compatible, policyKeys, validateRegistry, validateTokenPolicy, type Binding, type CredentialRef, type PolicyOverrides, type Registry } from "./registry";

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
export function credentialForBinding(r: Registry, binding: Binding, explicitId?: string): CredentialRef {
  const provider = r.providers.find((p) => p.id === binding.providerId);
  const credentialId = explicitId ?? (binding.credential.kind === "explicit" ? binding.credential.credentialId : provider?.defaultCredentialId);
  const credential = r.credentials.find((c) => c.id === credentialId && c.providerId === binding.providerId && c.enabled);
  if (!credential) throw new Error("The selected Key is missing or disabled. Explicitly choose a Key; no fallback is attempted.");
  return credential;
}
export function credentialIdentity(c: CredentialRef): CredentialIdentity {
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
export function projectRegistry(r: Registry, lookup: TemplateLookup): RegistryProjection {
  validateRegistry(r);
  const profiles: ExecutionProfile[] = [];
  const choices: ModelChoiceContribution[] = [];
  for (const binding of r.bindings) {
    const provider = r.providers.find((p) => p.id === binding.providerId)!;
    const endpoint = r.endpoints.find((e) => e.id === binding.endpointId)!;
    if (!binding.enabled || !provider.enabled || !endpoint.enabled) continue;
    if (!compatible(binding.engineId, endpoint.protocol)) throw new Error(`${binding.engineId} cannot consume ${endpoint.protocol}; disable or change this binding`);
    if (binding.executionTarget.kind === "wsl" && ["grok", "opencode"].includes(binding.engineId)) throw new Error(`${binding.engineId} does not support managed WSL execution`);
    if (!binding.targetGrantId) throw new Error(`Authorize the exact target for ${provider.name} / ${binding.engineId} before publishing`);
    const credentials = endpoint.auth === "none" ? [] : r.credentials.filter((c) => c.providerId === provider.id && c.enabled).map(credentialIdentity);
    const defaultCredentialId = endpoint.auth === "none" ? undefined : credentialForBinding(r, binding).id;
    profiles.push({ profileKey: binding.id, engineId: binding.engineId, label: provider.name, group: provider.name, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, auth: endpoint.auth, executionTarget: binding.executionTarget, targetGrantId: binding.targetGrantId, credentialScope: provider.id, credentials, ...(defaultCredentialId ? { defaultCredentialId } : {}), options: binding.options });
    const templates = lookup(binding);
    const mappings = r.mappings.filter((m) => m.bindingId === binding.id && m.enabled);
    if (binding.defaultModelId) mappings.sort((a, b) => Number(b.providerModelId === binding.defaultModelId) - Number(a.providerModelId === binding.defaultModelId));
    for (const mapping of mappings) {
      const model = r.models.find((m) => m.id === mapping.providerModelId)!;
      const wireId = model.wireIds[endpoint.id];
      if (!wireId) throw new Error(`${model.name} has no wire model ID for ${endpoint.name}`);
      const template = templates.find((t) => t.templateRef?.engineId === mapping.templateRef.engineId && t.templateRef.modelId === mapping.templateRef.modelId && t.templateRef.revision === mapping.templateRef.revision);
      if (!template) throw new Error(`Official template for ${model.name} is unavailable or changed. Refresh templates and explicitly review the mapping.`);
      if (template.protocol && !compatible(binding.engineId, template.protocol)) throw new Error("Official template protocol is incompatible with the CLI");
      const capabilities = {
        images: model.capabilities.images === "unknown" ? template.capabilities.images : model.capabilities.images,
        tools: model.capabilities.tools === "unknown" ? template.capabilities.tools : model.capabilities.tools,
        effortLevels: model.capabilities.effortLevels.length ? model.capabilities.effortLevels : template.capabilities.effortLevels,
      };
      if (template.capabilities.images === "unsupported" && capabilities.images === "supported") throw new Error("Official template does not support images");
      if (template.capabilities.tools === "unsupported" && capabilities.tools === "supported") throw new Error("Official template does not support tools");
      if (capabilities.effortLevels.some((level) => !template.capabilities.effortLevels.includes(level))) throw new Error("Model effort is not supported by the official CLI template");
      const policy = resolvePolicy(template.tokenPolicy, model.sharedPolicy, mapping.policy);
      const constraints = enginePolicies[binding.engineId];
      for (const key of constraints?.unsupported ?? []) if (policy.tokenPolicy[key] !== undefined) throw new Error(`${binding.engineId} cannot apply ${key}; explicitly clear it in this CLI mapping`);
      for (const key of constraints?.required ?? []) if (policy.tokenPolicy[key] === undefined) throw new Error(`${binding.engineId} requires a known ${key}; enter a reviewed shared or CLI value`);
      choices.push({ profileKey: binding.id, modelKey: mapping.id, label: model.name, selector: mapping.selector.kind === "alias" ? { kind: "alias", alias: mapping.selector.alias, modelId: wireId } : { kind: "wire", modelId: wireId }, templateRef: mapping.templateRef, ...policy, capabilities, managementKey: "providers" });
    }
  }
  return { profiles, choices };
}
