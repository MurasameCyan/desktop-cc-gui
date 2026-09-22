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
function text(value: unknown, name: string): asserts value is string { requireValue(typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), `${name} is required and must not contain control characters`); }
function positive(value: unknown, name: string) { requireValue(Number.isSafeInteger(value) && Number(value) > 0, `${name} must be a positive integer`); }
export function validatePolicy(policy: PolicyOverrides): void {
  requireValue(policy && typeof policy === "object" && !Array.isArray(policy), "Invalid model policy");
  for (const [key, override] of Object.entries(policy)) {
    requireValue(policyKeys.includes(key as typeof policyKeys[number]), "Unknown model policy field");
    requireValue(override && ["inherit", "clear", "value"].includes(override.kind), "Invalid policy override");
    if (override.kind === "value") positive(override.value, key);
  }
}
export function validateTokenPolicy(policy: TokenPolicy): void {
  for (const key of policyKeys) if (policy[key] !== undefined) positive(policy[key], key);
  if (policy.contextWindowTokens !== undefined) {
    requireValue(policy.maxOutputTokens === undefined || policy.maxOutputTokens <= policy.contextWindowTokens, "Maximum output exceeds the context window");
    requireValue(policy.autoCompactionThresholdTokens === undefined || policy.autoCompactionThresholdTokens <= policy.contextWindowTokens, "Compaction threshold exceeds the context window");
  }
}
export function validateRegistry(r: Registry): Registry {
  requireValue(r?.schemaVersion === 1 && Number.isSafeInteger(r.revision) && r.revision >= 0, "Unsupported registry schema or revision");
  for (const items of [r.providers, r.endpoints, r.credentials, r.models, r.bindings, r.mappings]) {
    requireValue(Array.isArray(items), "Invalid registry collection");
    const ids = new Set<string>();
    for (const item of items) { text(item.id, "Identity"); requireValue(!ids.has(item.id), "Duplicate identity"); ids.add(item.id); }
  }
  for (const item of [...r.providers, ...r.endpoints, ...r.credentials, ...r.bindings, ...r.mappings]) requireValue(typeof item.enabled === "boolean", "Enabled flags must be boolean");
  const provider = (providerId: string) => { const found = r.providers.find((p) => p.id === providerId); requireValue(found, "Missing Provider reference"); return found; };
  const credential = (credentialId: string, providerId: string) => requireValue(r.credentials.some((c) => c.id === credentialId && c.providerId === providerId), "Missing or foreign Key reference");
  for (const p of r.providers) { text(p.name, "Provider name"); positive(p.revision, "Provider revision"); if (p.defaultCredentialId) credential(p.defaultCredentialId, p.id); }
  for (const c of r.credentials) { provider(c.providerId); text(c.name, "Key name"); text(c.value, "Key"); positive(c.credentialRevision, "Key revision"); }
  for (const e of r.endpoints) {
    provider(e.providerId); text(e.name, "Endpoint name"); requireValue(protocols.includes(e.protocol), "Unknown protocol"); requireValue(["none", "bearer", "api-key"].includes(e.auth), "Unknown authentication mode");
    let url: URL; try { url = new URL(e.baseUrl); } catch { throw new Error("Invalid endpoint URL"); }
    requireValue(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search, "Endpoint must be an HTTP(S) URL without credentials, query or fragment");
  }
  for (const m of r.models) {
    provider(m.providerId); text(m.name, "Model name"); validatePolicy(m.sharedPolicy);
    requireValue(m.capabilities && ["supported", "unsupported", "unknown"].includes(m.capabilities.images) && ["supported", "unsupported", "unknown"].includes(m.capabilities.tools), "Invalid capabilities");
    requireValue(Array.isArray(m.capabilities.effortLevels) && new Set(m.capabilities.effortLevels).size === m.capabilities.effortLevels.length, "Invalid effort levels");
    for (const effort of m.capabilities.effortLevels) text(effort, "Effort");
    for (const [endpointId, wireId] of Object.entries(m.wireIds)) { requireValue(r.endpoints.some((e) => e.id === endpointId && e.providerId === m.providerId), "Missing or foreign model endpoint"); text(wireId, "Wire model ID"); }
  }
  const pairs = new Set<string>();
  for (const b of r.bindings) {
    provider(b.providerId); requireValue(engines.includes(b.engineId as typeof engines[number]), "Unknown CLI");
    const pair = JSON.stringify([b.providerId, b.engineId]); requireValue(!pairs.has(pair), "Only one binding per Provider and CLI is allowed"); pairs.add(pair);
    requireValue(r.endpoints.some((e) => e.id === b.endpointId && e.providerId === b.providerId), "Missing or foreign binding endpoint");
    if (b.defaultModelId) requireValue(r.models.some((m) => m.id === b.defaultModelId && m.providerId === b.providerId) && r.mappings.some((m) => m.bindingId === b.id && m.providerModelId === b.defaultModelId && m.enabled), "Default model must have a visible mapping in this binding");
    requireValue(b.credential?.kind === "inherit" || b.credential?.kind === "explicit", "Invalid binding Key policy");
    if (b.credential.kind === "explicit") credential(b.credential.credentialId, b.providerId);
    requireValue(b.executionTarget?.kind === "local" || b.executionTarget?.kind === "wsl", "Invalid execution target");
    if (b.executionTarget.kind === "wsl") { text(b.executionTarget.hostId, "WSL host"); text(b.executionTarget.distro, "WSL distribution"); }
    for (const [name, value] of Object.entries(b.options.headers ?? {})) {
      requireValue(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/(auth|cookie|token|secret|api.?key|^host$|^proxy-)/i.test(name), "Sensitive or invalid header name");
      text(value, "Header value");
    }
    requireValue(b.options.serviceTier === undefined || ["default", "priority"].includes(b.options.serviceTier), "Invalid service tier");
    requireValue(b.options.alwaysThinkingEnabled === undefined || typeof b.options.alwaysThinkingEnabled === "boolean", "Invalid thinking option");
  }
  const mappingPairs = new Set<string>();
  for (const m of r.mappings) {
    const b = r.bindings.find((entry) => entry.id === m.bindingId);
    requireValue(b && r.models.some((model) => model.id === m.providerModelId && model.providerId === b.providerId), "Missing or foreign mapping model");
    const pair = JSON.stringify([m.bindingId, m.providerModelId]); requireValue(!mappingPairs.has(pair), "Duplicate model mapping; aliases need independent logical model identities"); mappingPairs.add(pair);
    requireValue(m.templateRef?.engineId === b.engineId, "Official template belongs to another CLI"); text(m.templateRef.modelId, "Official template model"); text(m.templateRef.revision, "Official template revision");
    requireValue(m.selector?.kind === "wire" || m.selector?.kind === "alias", "Invalid selector"); if (m.selector.kind === "alias") text(m.selector.alias, "Alias"); validatePolicy(m.policy);
  }
  requireValue(Array.isArray(r.patchReceipts), "Invalid patch receipts");
  return r;
}
/** Version zero was the pre-release registry without receipts; migration never invents credentials. */
export function parseRegistry(content: string): Registry {
  let parsed: Registry;
  try { parsed = JSON.parse(content); } catch { throw new Error("Registry is not valid JSON; reload or restore the document before editing"); }
  const legacy = parsed as unknown as { schemaVersion: number; patchReceipts?: Registry["patchReceipts"] };
  if (legacy.schemaVersion === 0) parsed = { ...parsed, schemaVersion: 1, patchReceipts: legacy.patchReceipts ?? [] };
  return validateRegistry(parsed);
}
