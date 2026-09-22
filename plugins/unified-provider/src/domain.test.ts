import { describe, expect, it } from "vitest";
import { emptyRegistry, validateRegistry, type Registry } from "./registry";
import { credentialForBinding, projectRegistry, resolvePolicy } from "./projection";
import { mergeImportedCandidates } from "./imports";
import { selectionIdentity, validateSelectionDraft } from "./selection";

export function fixture(): Registry {
  return {
    ...emptyRegistry(),
    providers: [{ id: "p", name: "Provider", enabled: true, revision: 1, defaultCredentialId: "k1" }],
    endpoints: [{ id: "e", providerId: "p", name: "Endpoint", protocol: "openai-responses", baseUrl: "https://example.com/v1", auth: "bearer", enabled: true }],
    credentials: ["k1", "k2"].map((id) => ({ id, providerId: "p", name: id, value: `secret-${id}`, enabled: true, credentialRevision: 1 })),
    models: [{ id: "m", providerId: "p", name: "Same", wireIds: { e: "wire" }, sharedPolicy: {}, capabilities: { images: "unknown", tools: "unknown", effortLevels: [] } }],
    bindings: [{ id: "b", providerId: "p", engineId: "codex", endpointId: "e", enabled: true, credential: { kind: "explicit", credentialId: "k2" }, executionTarget: { kind: "local" }, targetGrantId: "g", options: {} }],
    mappings: [{ id: "map", bindingId: "b", providerModelId: "m", enabled: true, templateRef: { engineId: "codex", modelId: "official", revision: "r1" }, selector: { kind: "wire" }, policy: {} }],
  };
}

const templates = [{ modelId: "official", templateRef: { engineId: "codex", modelId: "official", revision: "r1" }, capabilities: { images: "supported" as const, tools: "supported" as const, effortLevels: ["low", "high"] }, tokenPolicy: { contextWindowTokens: 200000 }, evidence: "official" as const }];

describe("registry projection boundaries", () => {
  it("resolves a credential only at explicit bind, never substitutes a disabled explicit Key", () => {
    const r = fixture();
    expect(credentialForBinding(r, r.bindings[0]).id).toBe("k2");
    expect(credentialForBinding(r, r.bindings[0], "k1").id).toBe("k1");
    r.credentials[1].enabled = false;
    expect(() => credentialForBinding(r, r.bindings[0])).toThrow();
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
  it("rejects an explicitly unsupported CLI policy instead of dropping it", () => {
    const r = fixture();
    r.mappings[0].policy.maxOutputTokens = { kind: "value", value: 1000 };
    expect(() => projectRegistry(r, () => templates)).toThrow("maxOutputTokens");
    r.mappings[0].policy.maxOutputTokens = { kind: "clear" };
    expect(projectRegistry(r, () => templates).choices[0].tokenPolicy.maxOutputTokens).toBeUndefined();
  });
  it("does not silently merge imported accounts by URL or display name", () => {
    const r = fixture();
    const result = mergeImportedCandidates(r, [{ candidateId: "c", label: "Provider", baseUrl: "https://example.com/v1", protocol: "openai-responses", auth: "bearer", models: ["wire"], hasStaticKey: true, value: "new-secret", skippedFields: [] }], [{ candidateId: "c", action: "new", engineId: "codex", templateRef: templates[0].templateRef, credentialDecision: "new", bindingDecision: "replace" }]);
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toEqual(r.providers[0]);
  });
  it("preserves native authentication rather than deriving it from protocol", () => {
    const result = mergeImportedCandidates(emptyRegistry(), [{ candidateId: "c", label: "Public", baseUrl: "https://example.com/v1", protocol: "openai-responses", auth: "none", models: ["wire"], hasStaticKey: false, skippedFields: [] }], [{ candidateId: "c", action: "new", engineId: "codex", templateRef: templates[0].templateRef, credentialDecision: "keep", bindingDecision: "replace" }]);
    expect(result.endpoints[0].auth).toBe("none");
    expect(result.credentials).toEqual([]);
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
