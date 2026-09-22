/** Host-owned execution contracts. Provider/Endpoint/Binding business schemas
 * belong to plugins; these are immutable, non-secret execution projections. */
export type ExecutionTarget =
  | { kind: "local" }
  | { kind: "wsl"; hostId: string; distro: string };

export type CliProtocol = "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini";
export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface CredentialIdentity {
  credentialId: string;
  credentialRevision: number;
  name: string;
  remark?: string;
}

/** An ephemeral use handle, never a reference to a host credential vault. */
export interface CredentialUseRef {
  sourceId: string;
  credentialId: string;
  credentialRevision: number;
  registryRevision: string;
}

export interface TokenPolicy {
  contextWindowTokens?: number;
  autoCompactionThresholdTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelCapabilities {
  images: CapabilitySupport;
  tools: CapabilitySupport;
  /** Empty means reasoning effort is not applicable, not unrestricted. */
  effortLevels: string[];
}

export interface OfficialTemplateRef {
  engineId: string;
  modelId: string;
  revision: string;
}

export type ModelSelector =
  | { kind: "wire"; modelId: string }
  | { kind: "alias"; alias: string; modelId: string };

export interface ExecutionProfile {
  profileKey: string;
  engineId: string;
  label: string;
  group: string;
  protocol: CliProtocol;
  baseUrl: string;
  auth: "none" | "bearer" | "api-key";
  executionTarget: ExecutionTarget;
  targetGrantId: string;
  /** Opaque credential grouping owned by the contributing plugin. */
  credentialScope: string;
  credentials: CredentialIdentity[];
  /** A first-binding suggestion; never overrides a saved session credential. */
  defaultCredentialId?: string;
  options?: {
    /** Authentication and executable/loader headers are not accepted. */
    headers?: Record<string, string>;
    serviceTier?: "default" | "priority";
    alwaysThinkingEnabled?: boolean;
  };
}

export interface ModelChoiceContribution {
  profileKey: string;
  modelKey: string;
  label: string;
  selector: ModelSelector;
  templateRef: OfficialTemplateRef;
  tokenPolicy: TokenPolicy;
  capabilities: ModelCapabilities;
  policySources?: Partial<Record<keyof TokenPolicy, "official" | "endpoint" | "user">>;
  /** Settings sub-key belonging to the contributing plugin. */
  managementKey?: string;
}

export interface SourcePublication {
  sourceId: string;
  documentPath: string;
  documentVersion: string;
  expectedPublicationRevision: string | null;
  profiles: ExecutionProfile[];
  choices: ModelChoiceContribution[];
}

export interface PublishedSource {
  sourceId: string;
  pluginId: string;
  documentPath: string;
  documentVersion: string;
  publicationRevision: string;
  profiles: ExecutionProfile[];
  choices: ModelChoiceContribution[];
  available: boolean;
  unavailableReason?: string;
  /** Per-profile failures never disable unrelated Providers in this source. */
  unavailableProfiles?: Record<string, string>;
}

export type ModelSelection =
  | {
      source: "native";
      engineId: string;
      /** null explicitly selects the CLI's own default. */
      modelId: string | null;
      /** Unmanaged legacy host channel; null/absent is native CLI config. */
      channelId?: string | null;
    }
  | {
      source: "contribution";
      engineId: string;
      sourceId: string;
      profileKey: string;
      modelKey: string;
      /** null is valid only for an explicitly unauthenticated endpoint. */
      credential: CredentialIdentity | null;
    };

export interface ExecutionSelectionInput {
  modelSelection: ModelSelection;
  /** null explicitly means not applicable; no global-effort fallback. */
  effort: string | null;
}

export interface SessionExecutionSelection extends ExecutionSelectionInput {
  version: number;
}

export interface SessionExecutionTarget {
  engineId: string;
  workspacePath: string;
  sessionId: string | null;
  pendingId?: string;
  executionTarget: ExecutionTarget;
}

export interface SessionExecutionContext {
  target: SessionExecutionTarget;
  selection: SessionExecutionSelection | null;
  unavailableReason?: string;
}

export interface SelectionSendRequest {
  schemaVersion: 1;
  target: SessionExecutionTarget;
  selectionVersion: number;
}

export interface TargetGrantRequest {
  sourceId: string;
  baseUrl: string;
  executionTarget: ExecutionTarget;
  credentials: CredentialIdentity[];
  purpose: string;
}

export interface TargetGrant {
  grantId: string;
  sourceId: string;
  baseUrl: string;
  executionTarget: ExecutionTarget;
  credentials: CredentialIdentity[];
}

export interface RuntimeMaterialRequest {
  profileKey: string;
  use: CredentialUseRef;
}

/** Desktop-only sensitive input. Never returned in normal reads or events. */
export interface RuntimeMaterialInput extends RuntimeMaterialRequest {
  value: string;
}

export interface CliChange {
  sourceId: string;
  publicationRevision: string | null;
}

export interface ModelDiscoveryRequest {
  source: "official" | "authorized-endpoint";
  engineId: string;
  executionTarget: ExecutionTarget;
  profileKey?: string;
  sourceId?: string;
  targetGrantId?: string;
  protocol?: CliProtocol;
  credentialUse?: CredentialUseRef;
}

export interface DiscoveredModel {
  modelId: string;
  label?: string;
  protocol?: CliProtocol;
  capabilities: ModelCapabilities;
  tokenPolicy: TokenPolicy;
  templateRef?: OfficialTemplateRef;
  evidence: "official" | "endpoint" | "unknown";
}

export interface ModelDiscoveryResult {
  source: "official" | "authorized-endpoint";
  executionTarget: ExecutionTarget;
  observedAt: number;
  models: DiscoveredModel[];
  status: "complete" | "partial" | "unsupported" | "failed";
  error?: string;
}

export interface NativeConfigTarget {
  targetId: string;
  engineId: string;
  label: string;
  paths: string[];
  importSupported: boolean;
  applySupported: boolean;
  unsupportedReason?: string;
}

export interface NativeConfigCandidate {
  candidateId: string;
  label: string;
  baseUrl: string;
  protocol: CliProtocol;
  /** Exact native authentication semantics; never infer this from protocol. */
  auth: ExecutionProfile["auth"];
  models: string[];
  credentialName?: string;
  hasStaticKey: boolean;
  skippedFields: string[];
}

export interface NativeConfigPreview {
  previewId: string;
  target: NativeConfigTarget;
  fingerprint: string;
  candidates: NativeConfigCandidate[];
  warnings: string[];
}

export interface NativeImportResult {
  /** Selected static credentials, delivered once after desktop confirmation.
   * Store only in the plugin document; do not emit or log this object. */
  candidates: Array<NativeConfigCandidate & { value?: string }>;
}

export interface ConfigPatchPreview {
  previewId: string;
  target: NativeConfigTarget;
  fingerprint: string;
  changes: string[];
  containsPlaintextKey: boolean;
}

export interface ConfigPatchReceipt {
  receiptId: string;
  targetId: string;
  fingerprint: string;
}

export interface ExecutionChoice {
  choiceId: string;
  label: string;
  group: string;
  modelSelection: ModelSelection;
  credentials: CredentialIdentity[];
  capabilities: ModelCapabilities;
  tokenPolicy: TokenPolicy;
  unavailableReason?: string;
}

/** The complete, secret-free input to a replacement model picker. */
export interface ModelEntryProps {
  context: SessionExecutionContext;
  choices: ExecutionChoice[];
  loading: boolean;
  onApply(selection: ExecutionSelectionInput, expectedVersion: number | null): Promise<SessionExecutionContext>;
  onRefresh(): Promise<void>;
}

export interface CliCapabilities {
  publishSource(publication: SourcePublication): Promise<PublishedSource>;
  getSource(sourceId: string): Promise<PublishedSource | null>;
  unpublishSource(sourceId: string, expectedPublicationRevision: string): Promise<void>;
  listSources(): Promise<PublishedSource[]>;
  onChanged(callback: (event: CliChange) => void): () => void;
  requestTargetGrant(request: TargetGrantRequest): Promise<TargetGrant>;
  listTargetGrants(): Promise<TargetGrant[]>;
  revokeTargetGrant(grantId: string): Promise<void>;
  registerRuntimeMaterial(input: RuntimeMaterialInput): Promise<void>;
  onMaterialRequested(callback: (request: RuntimeMaterialRequest) => void): () => void;
  getCredentialUses(sourceId: string): Promise<RuntimeMaterialRequest[]>;
  listModels(request: ModelDiscoveryRequest): Promise<ModelDiscoveryResult>;
  listConfigTargets(): Promise<NativeConfigTarget[]>;
  previewConfigImport(targetId: string): Promise<NativeConfigPreview>;
  confirmConfigImport(previewId: string, candidateIds: string[]): Promise<NativeImportResult>;
  previewConfigPatch(targetId: string, selection: ExecutionSelectionInput): Promise<ConfigPatchPreview>;
  applyConfigPatch(previewId: string): Promise<ConfigPatchReceipt>;
  restoreConfigPatch(receiptId: string): Promise<ConfigPatchReceipt>;
}
