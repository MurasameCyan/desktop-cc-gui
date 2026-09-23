import type { CliProtocol, ExecutionProfile, ExecutionTarget, ModelCapabilities, OfficialTemplateRef, TokenPolicy } from "@ccgui/plugin-sdk";

export type Override<T> = { kind: "inherit" } | { kind: "clear" } | { kind: "value"; value: T };
export type PolicyOverrides = Partial<{ [K in keyof TokenPolicy]: Override<number> }>;
export interface Provider { id: string; name: string; remark?: string; enabled: boolean; revision: number; defaultCredentialId?: string }
export interface Endpoint { id: string; providerId: string; name: string; protocol: CliProtocol; baseUrl: string; auth: "none" | "bearer" | "api-key"; enabled: boolean }
export interface CredentialRef { id: string; providerId: string; name: string; remark?: string; value: string; enabled: boolean; credentialRevision: number }
export interface ProviderModel { id: string; providerId: string; name: string; wireIds: Record<string, string>; sharedPolicy: PolicyOverrides; capabilities: ModelCapabilities }
export interface Binding {
  id: string; providerId: string; engineId: string; endpointId: string; enabled: boolean;
  credential: { kind: "inherit" } | { kind: "explicit"; credentialId: string };
  executionTarget: ExecutionTarget; targetGrantId?: string; defaultModelId?: string; options: NonNullable<ExecutionProfile["options"]>;
}
export interface ModelMapping {
  id: string; bindingId: string; providerModelId: string; enabled: boolean;
  templateRef: OfficialTemplateRef; selector: { kind: "wire" } | { kind: "alias"; alias: string };
  policy: PolicyOverrides;
}
export interface Registry {
  schemaVersion: 1; revision: number; providers: Provider[]; endpoints: Endpoint[];
  credentials: CredentialRef[]; models: ProviderModel[]; bindings: Binding[]; mappings: ModelMapping[];
  patchReceipts: Array<{ receiptId: string; targetId: string; fingerprint: string }>;
}
export type RegistryView = Omit<Registry, "credentials"> & { credentials: Omit<CredentialRef, "value">[] };
export const engines = ["claude", "codex", "kimi", "grok", "opencode", "pi", "omp", "dsh", "agy", "qoder", "qoder-cn"] as const;
export const protocols: CliProtocol[] = ["anthropic-messages", "openai-responses", "openai-chat", "gemini"];
export const policyKeys = ["contextWindowTokens", "autoCompactionThresholdTokens", "maxOutputTokens"] as const;
export function id(): string { return crypto.randomUUID(); }
export function emptyRegistry(): Registry { return { schemaVersion: 1, revision: 0, providers: [], endpoints: [], credentials: [], models: [], bindings: [], mappings: [], patchReceipts: [] }; }
export function registryView(r: Registry): RegistryView {
  const { credentials, ...metadata } = r;
  return { ...structuredClone(metadata), credentials: credentials.map(({ value: _value, ...credential }) => ({ ...credential })) };
}
export function compatible(engine: string, protocol: CliProtocol): boolean {
  if (engine === "claude") return protocol === "anthropic-messages";
  if (engine === "codex") return protocol === "openai-responses";
  if (engine === "grok") return protocol === "anthropic-messages" || protocol === "openai-responses" || protocol === "openai-chat";
  return ["kimi", "opencode", "pi", "omp"].includes(engine);
}
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function text(value: unknown, name: string): asserts value is string { requireValue(typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), `${name}不能为空，也不能包含控制字符`); }
function positive(value: unknown, name: string) { requireValue(Number.isSafeInteger(value) && Number(value) > 0, `${name}必须是正整数`); }
export function validatePolicy(policy: PolicyOverrides): void {
  requireValue(policy && typeof policy === "object" && !Array.isArray(policy), "模型策略无效");
  for (const [key, override] of Object.entries(policy)) {
    requireValue(policyKeys.includes(key as typeof policyKeys[number]), "未知的模型策略字段");
    requireValue(override && ["inherit", "clear", "value"].includes(override.kind), "策略覆盖方式无效");
    if (override.kind === "value") positive(override.value, key);
  }
}
export function validateTokenPolicy(policy: TokenPolicy): void {
  for (const key of policyKeys) if (policy[key] !== undefined) positive(policy[key], key);
  if (policy.contextWindowTokens !== undefined) {
    requireValue(policy.maxOutputTokens === undefined || policy.maxOutputTokens <= policy.contextWindowTokens, "最大输出超过上下文窗口");
    requireValue(policy.autoCompactionThresholdTokens === undefined || policy.autoCompactionThresholdTokens <= policy.contextWindowTokens, "自动压缩阈值超过上下文窗口");
  }
}
export function validateRegistry(r: Registry): Registry {
  requireValue(r?.schemaVersion === 1 && Number.isSafeInteger(r.revision) && r.revision >= 0, "不支持的配置格式或版本");
  for (const items of [r.providers, r.endpoints, r.credentials, r.models, r.bindings, r.mappings]) {
    requireValue(Array.isArray(items), "配置条目集合无效");
    const ids = new Set<string>();
    for (const item of items) { text(item.id, "条目 ID"); requireValue(!ids.has(item.id), "条目 ID 重复"); ids.add(item.id); }
  }
  for (const item of [...r.providers, ...r.endpoints, ...r.credentials, ...r.bindings, ...r.mappings]) requireValue(typeof item.enabled === "boolean", "启用标记必须是布尔值");
  const provider = (providerId: string) => { const found = r.providers.find((p) => p.id === providerId); requireValue(found, "引用的供应商不存在"); return found; };
  const credential = (credentialId: string, providerId: string) => requireValue(r.credentials.some((c) => c.id === credentialId && c.providerId === providerId), "引用的 Key 不存在或属于其他供应商");
  for (const p of r.providers) { text(p.name, "供应商名称"); positive(p.revision, "供应商版本"); if (p.defaultCredentialId) credential(p.defaultCredentialId, p.id); }
  for (const c of r.credentials) { provider(c.providerId); text(c.name, "Key 名称"); text(c.value, "Key"); positive(c.credentialRevision, "Key 代次"); }
  for (const e of r.endpoints) {
    provider(e.providerId); text(e.name, "端点名称"); requireValue(protocols.includes(e.protocol), "未知协议"); requireValue(["none", "bearer", "api-key"].includes(e.auth), "未知认证方式");
    let url: URL; try { url = new URL(e.baseUrl); } catch { throw new Error("端点 URL 无效"); }
    requireValue(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search, "端点必须是 HTTP(S) URL，且不能包含凭据、查询参数或片段标识");
  }
  for (const m of r.models) {
    provider(m.providerId); text(m.name, "模型名称"); validatePolicy(m.sharedPolicy);
    requireValue(m.capabilities && ["supported", "unsupported", "unknown"].includes(m.capabilities.images) && ["supported", "unsupported", "unknown"].includes(m.capabilities.tools), "模型能力声明无效");
    requireValue(Array.isArray(m.capabilities.effortLevels) && new Set(m.capabilities.effortLevels).size === m.capabilities.effortLevels.length, "推理强度档位无效");
    for (const effort of m.capabilities.effortLevels) text(effort, "推理强度");
    for (const [endpointId, wireId] of Object.entries(m.wireIds)) { requireValue(r.endpoints.some((e) => e.id === endpointId && e.providerId === m.providerId), "模型端点不存在或属于其他供应商"); text(wireId, "wire 模型 ID"); }
  }
  const pairs = new Set<string>();
  for (const b of r.bindings) {
    provider(b.providerId); requireValue(engines.includes(b.engineId as typeof engines[number]), "未知 CLI");
    const pair = JSON.stringify([b.providerId, b.engineId]); requireValue(!pairs.has(pair), "每个供应商与 CLI 之间只允许一个绑定"); pairs.add(pair);
    requireValue(r.endpoints.some((e) => e.id === b.endpointId && e.providerId === b.providerId), "绑定端点不存在或属于其他供应商");
    if (b.defaultModelId) requireValue(r.models.some((m) => m.id === b.defaultModelId && m.providerId === b.providerId) && r.mappings.some((m) => m.bindingId === b.id && m.providerModelId === b.defaultModelId && m.enabled), "默认模型必须在此绑定中具有可见映射");
    requireValue(b.credential?.kind === "inherit" || b.credential?.kind === "explicit", "绑定的 Key 策略无效");
    if (b.credential.kind === "explicit") credential(b.credential.credentialId, b.providerId);
    requireValue(b.executionTarget?.kind === "local" || b.executionTarget?.kind === "wsl", "执行目标无效");
    if (b.executionTarget.kind === "wsl") { text(b.executionTarget.hostId, "WSL 主机"); text(b.executionTarget.distro, "WSL 发行版"); }
    for (const [name, value] of Object.entries(b.options.headers ?? {})) {
      requireValue(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/(auth|cookie|token|secret|api.?key|^host$|^proxy-)/i.test(name), "请求头名称包含敏感字段或格式无效");
      text(value, "请求头值");
    }
    requireValue(b.options.serviceTier === undefined || ["default", "priority"].includes(b.options.serviceTier), "服务等级无效");
    requireValue(b.options.alwaysThinkingEnabled === undefined || typeof b.options.alwaysThinkingEnabled === "boolean", "思考选项无效");
  }
  const mappingPairs = new Set<string>();
  for (const m of r.mappings) {
    const b = r.bindings.find((entry) => entry.id === m.bindingId);
    requireValue(b && r.models.some((model) => model.id === m.providerModelId && model.providerId === b.providerId), "映射模型不存在或属于其他供应商");
    const pair = JSON.stringify([m.bindingId, m.providerModelId]); requireValue(!mappingPairs.has(pair), "模型映射重复；别名需要独立的逻辑模型 ID"); mappingPairs.add(pair);
    requireValue(m.templateRef?.engineId === b.engineId, "官方模板属于另一个 CLI"); text(m.templateRef.modelId, "官方模板模型"); text(m.templateRef.revision, "官方模板版本");
    requireValue(m.selector?.kind === "wire" || m.selector?.kind === "alias", "模型选择方式无效"); if (m.selector.kind === "alias") text(m.selector.alias, "别名"); validatePolicy(m.policy);
  }
  requireValue(Array.isArray(r.patchReceipts), "补丁回执无效");
  return r;
}
/** Version zero was the pre-release registry without receipts; migration never invents credentials. */
export function parseRegistry(content: string): Registry {
  let parsed: Registry;
  try { parsed = JSON.parse(content); } catch { throw new Error("配置不是有效的 JSON，请重新加载或恢复文档后再编辑"); }
  const legacy = parsed as unknown as { schemaVersion: number; patchReceipts?: Registry["patchReceipts"] };
  if (legacy.schemaVersion === 0) parsed = { ...parsed, schemaVersion: 1, patchReceipts: legacy.patchReceipts ?? [] };
  return validateRegistry(parsed);
}
