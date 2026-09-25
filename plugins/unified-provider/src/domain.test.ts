import { describe, expect, it } from "vitest";
import { emptyRegistry, parseRegistry, probeProfileKey, validateRegistry, type Registry } from "./registry";
import { credentialForEndpoint, projectRegistry, resolvePolicy } from "./projection";
import { mergeImportedCandidates } from "./imports";
import { selectionIdentity, validateSelectionDraft } from "./selection";

export function fixture(): Registry {
  return {
    ...emptyRegistry(),
    providers: [{ id: "p", name: "Provider", enabled: true, revision: 1 }],
    endpoints: [{ id: "e", providerId: "p", name: "Endpoint", protocol: "openai-responses", baseUrl: "https://example.com/v1", auth: "bearer", enabled: true, defaultCredentialId: "k1", probeGrantId: "pg" }],
    credentials: ["k1", "k2"].map((id) => ({ id, endpointId: "e", name: id, value: `secret-${id}`, enabled: true, credentialRevision: 1 })),
    models: [{ id: "m", providerId: "p", name: "Same", wireIds: { e: "wire" }, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } }],
    bindings: [{ id: "b", providerId: "p", engineId: "codex", endpointId: "e", enabled: true, credential: { kind: "explicit", credentialId: "k2" }, executionTarget: { kind: "local" }, targetGrantId: "g", options: {} }],
    mappings: [{ id: "map", bindingId: "b", providerModelId: "m", enabled: true, templateRef: { engineId: "codex", modelId: "official", revision: "r1" }, selector: { kind: "wire" }, policy: {} }],
  };
}

const templates = [{ modelId: "official", templateRef: { engineId: "codex", modelId: "official", revision: "r1" }, capabilities: { images: "supported" as const, tools: "supported" as const, effortLevels: ["low", "high"] }, tokenPolicy: { contextWindowTokens: 200000 }, evidence: "official" as const }];

describe("registry projection boundaries", () => {
  it("resolves a Key within its own endpoint and never substitutes a disabled explicit Key", () => {
    const r = fixture();
    const endpoint = r.endpoints[0];
    expect(credentialForEndpoint(r, endpoint, r.bindings[0]).id).toBe("k2");
    expect(credentialForEndpoint(r, endpoint, r.bindings[0], "k1").id).toBe("k1");
    expect(credentialForEndpoint(r, endpoint).id).toBe("k1");
    r.credentials[1].enabled = false;
    expect(() => credentialForEndpoint(r, endpoint, r.bindings[0])).toThrow();
  });
  it("never reaches a Key that belongs to another endpoint", () => {
    const r = fixture();
    r.endpoints.push({ ...r.endpoints[0], id: "e2", defaultCredentialId: undefined, probeGrantId: undefined });
    expect(() => credentialForEndpoint(r, r.endpoints[1], undefined, "k1")).toThrow();
  });
  it("uses the endpoint's only enabled Key without a default, but demands a choice once there are two", () => {
    const r = fixture();
    const endpoint = r.endpoints[0];
    delete endpoint.defaultCredentialId;
    expect(() => credentialForEndpoint(r, endpoint)).toThrow("多个");
    r.credentials = r.credentials.filter((c) => c.id === "k2");
    expect(credentialForEndpoint(r, endpoint).id).toBe("k2");
    r.credentials[0].enabled = false;
    expect(() => credentialForEndpoint(r, endpoint)).toThrow();
  });
  it("publishes a discovery target for an endpoint that has no CLI line yet", () => {
    const r = fixture();
    r.bindings = [];
    r.mappings = [];
    const result = projectRegistry(r, () => templates);
    expect(result.profiles.map((profile) => profile.profileKey)).toEqual([probeProfileKey("e")]);
    expect(result.profiles[0].credentials.map((c) => c.credentialId)).toEqual(["k1", "k2"]);
    expect(result.choices).toEqual([]);
  });
  it("withholds the discovery target until the endpoint is authorized with a usable Key", () => {
    const r = fixture();
    r.bindings = [];
    r.mappings = [];
    delete r.endpoints[0].probeGrantId;
    expect(projectRegistry(r, () => templates).profiles).toEqual([]);
    r.endpoints[0].probeGrantId = "pg";
    for (const credential of r.credentials) credential.enabled = false;
    delete r.endpoints[0].defaultCredentialId;
    expect(projectRegistry(r, () => templates).profiles).toEqual([]);
  });
  it("keeps clear distinct from inherit and checks the resulting token budget", () => {
    expect(resolvePolicy({ contextWindowTokens: 1000, maxOutputTokens: 500 }, { contextWindowTokens: { kind: "value", value: 2000 } }, { maxOutputTokens: { kind: "clear" } }).tokenPolicy).toEqual({ contextWindowTokens: 2000 });
    expect(() => resolvePolicy({ contextWindowTokens: 1000 }, {}, { maxOutputTokens: { kind: "value", value: 1001 } })).toThrow();
  });
  it("preserves independent aliases and same-name logical identities without publishing secrets", () => {
    const r = fixture();
    r.models.push({ ...r.models[0], id: "m2" });
    r.mappings.push({ ...r.mappings[0], id: "map2", providerModelId: "m2", selector: { kind: "alias", alias: "fast" } });
    const result = projectRegistry(r, () => templates);
    expect(result.choices.map((x) => x.modelKey)).toEqual(["map", "map2"]);
    expect(result.choices[1].selector).toEqual({ kind: "alias", alias: "fast", modelId: "wire" });
    expect(JSON.stringify(result)).not.toContain("secret-");
  });
  it("rejects dangling references and duplicate Provider/CLI bindings before persistence", () => {
    const r = fixture();
    r.bindings.push({ ...r.bindings[0], id: "b2" });
    expect(() => validateRegistry(r)).toThrow();
    r.bindings.pop();
    r.mappings[0].providerModelId = "missing";
    expect(() => validateRegistry(r)).toThrow();
  });
  it("rejects a Key reference that crosses an endpoint boundary", () => {
    const r = fixture();
    r.endpoints.push({ ...r.endpoints[0], id: "e2", defaultCredentialId: undefined, probeGrantId: undefined });
    r.bindings.push({ ...r.bindings[0], id: "b2", engineId: "claude", endpointId: "e2", credential: { kind: "explicit", credentialId: "k1" } });
    expect(() => validateRegistry(r)).toThrow();
  });
  it("names the offending endpoint when one row's Base URL blocks the whole document", () => {
    const r = fixture();
    r.providers.push({ id: "p2", name: "空白行", enabled: true, revision: 1 });
    r.endpoints.push({ id: "e2", providerId: "p2", name: "刚新增的供应商", protocol: "openai-chat", baseUrl: "", auth: "bearer", enabled: true });
    expect(() => validateRegistry(r)).toThrow("“刚新增的供应商”还没有填 Base URL");
    r.endpoints[1].baseUrl = "ftp://example.com";
    expect(() => validateRegistry(r)).toThrow("“刚新增的供应商”的 Base URL 必须是 HTTP(S) 地址");
  });
  it("rejects an explicitly unsupported CLI policy instead of dropping it", () => {
    const r = fixture();
    r.mappings[0].policy.maxOutputTokens = { kind: "value", value: 1000 };
    expect(() => projectRegistry(r, () => templates)).toThrow("maxOutputTokens");
    r.mappings[0].policy.maxOutputTokens = { kind: "clear" };
    expect(projectRegistry(r, () => templates).choices[0].tokenPolicy.maxOutputTokens).toBeUndefined();
  });
  it("does not silently merge imported accounts by URL or display name", () => {
    const r = fixture();
    const result = mergeImportedCandidates(r, [{ candidateId: "c", label: "Provider", baseUrl: "https://example.com/v1", protocol: "openai-responses", auth: "bearer", models: ["wire"], hasStaticKey: true, value: "new-secret", skippedFields: [] }], [{ candidateId: "c", action: "new", engineId: "codex", templateRef: templates[0].templateRef, importKey: true }]);
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toEqual(r.providers[0]);
  });
  it("gives an imported candidate its own endpoint and leaves existing Keys untouched", () => {
    const r = fixture();
    const result = mergeImportedCandidates(r, [{ candidateId: "c", label: "Provider", baseUrl: "https://example.com/v1", protocol: "openai-responses", auth: "bearer", models: ["wire"], hasStaticKey: true, value: "new-secret", skippedFields: [] }], [{ candidateId: "c", action: "merge", providerId: "p", engineId: "omp", templateRef: { engineId: "omp", modelId: "official", revision: "r1" }, importKey: true }]);
    const imported = result.endpoints.find((endpoint) => endpoint.id !== "e")!;
    expect(result.credentials.filter((c) => c.endpointId === "e").map((c) => c.id)).toEqual(["k1", "k2"]);
    expect(result.credentials.filter((c) => c.endpointId === imported.id)).toHaveLength(1);
    expect(imported.defaultCredentialId).toBe(result.credentials.find((c) => c.endpointId === imported.id)!.id);
  });
  it("preserves native authentication rather than deriving it from protocol", () => {
    const result = mergeImportedCandidates(emptyRegistry(), [{ candidateId: "c", label: "Public", baseUrl: "https://example.com/v1", protocol: "openai-responses", auth: "none", models: ["wire"], hasStaticKey: false, skippedFields: [] }], [{ candidateId: "c", action: "new", engineId: "codex", templateRef: templates[0].templateRef, importKey: false }]);
    expect(result.endpoints[0].auth).toBe("none");
    expect(result.credentials).toEqual([]);
  });
});

describe("migration to endpoint-owned Keys", () => {
  const legacy = JSON.stringify({
    schemaVersion: 1, revision: 4,
    providers: [{ id: "p", name: "Provider", enabled: true, revision: 1, defaultCredentialId: "k1" }],
    endpoints: [
      { id: "e1", providerId: "p", name: "Primary", protocol: "openai-responses", baseUrl: "https://one.example.com/v1", auth: "bearer", enabled: true },
      { id: "e2", providerId: "p", name: "Backup", protocol: "openai-responses", baseUrl: "https://two.example.com/v1", auth: "bearer", enabled: true },
    ],
    credentials: [{ id: "k1", providerId: "p", name: "Shared", value: "secret-k1", enabled: true, credentialRevision: 3 }],
    models: [],
    bindings: [{ id: "b", providerId: "p", engineId: "codex", endpointId: "e2", enabled: true, credential: { kind: "explicit", credentialId: "k1" }, executionTarget: { kind: "local" }, targetGrantId: "old-grant", options: {} }],
    mappings: [],
    patchReceipts: [],
  });
  it("keeps every endpoint's reach by copying the provider Key, preserving its generation", () => {
    const r = parseRegistry(legacy);
    expect(r.schemaVersion).toBe(2);
    expect(r.credentials.filter((c) => c.endpointId === "e1").map((c) => c.id)).toEqual(["k1"]);
    expect(r.credentials.filter((c) => c.endpointId === "e2")).toHaveLength(1);
    for (const credential of r.credentials) expect(credential.credentialRevision).toBe(3);
    expect(r.endpoints.map((endpoint) => endpoint.defaultCredentialId)).toEqual(r.endpoints.map((endpoint) => r.credentials.find((c) => c.endpointId === endpoint.id)!.id));
  });
  it("repoints an explicit Key at its own endpoint's copy and drops stale grants", () => {
    const r = parseRegistry(legacy);
    const binding = r.bindings[0];
    expect(binding.targetGrantId).toBeUndefined();
    expect(binding.credential).toEqual({ kind: "explicit", credentialId: r.credentials.find((c) => c.endpointId === "e2")!.id });
    expect(credentialForEndpoint(r, r.endpoints[1], binding).endpointId).toBe("e2");
  });
});

describe("atomic picker draft", () => {
  it("distinguishes native channels and contributions sharing wire IDs", () => {
    expect(selectionIdentity({ source: "native", engineId: "codex", modelId: "wire", channelId: "a" })).not.toBe(selectionIdentity({ source: "native", engineId: "codex", modelId: "wire", channelId: "b" }));
  });
  it("requires an explicit supported effort when changing to an incompatible model", () => {
    const choice = { choiceId: "n", label: "native", group: "native", modelSelection: { source: "native" as const, engineId: "codex", modelId: "wire" }, credentials: [], capabilities: { images: "unknown" as const, tools: "unknown" as const, effortLevels: ["low"] }, tokenPolicy: {} };
    expect(() => validateSelectionDraft(choice, { modelSelection: choice.modelSelection, effort: "high" })).toThrow();
    expect(validateSelectionDraft(choice, { modelSelection: choice.modelSelection, effort: "low" }).effort).toBe("low");
  });
});
