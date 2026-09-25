//! Public SDK DTOs. Secrets have an input-only type and never appear in a receipt.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    Option::<T>::deserialize(deserializer)
}

fn selection_schema<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    match u32::deserialize(deserializer)? {
        1 => Ok(1),
        _ => Err(serde::de::Error::custom("unsupported selection schema; refresh the client")),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ExecutionTarget {
    Local,
    Wsl { host_id: String, distro: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum CliProtocol { AnthropicMessages, OpenaiResponses, OpenaiChat, Gemini }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CapabilitySupport { Supported, Unsupported, Unknown }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialIdentity {
    pub credential_id: String,
    pub credential_revision: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialUseRef {
    pub source_id: String,
    pub credential_id: String,
    pub credential_revision: u64,
    pub registry_revision: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compaction_threshold_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCapabilities {
    pub images: CapabilitySupport,
    pub tools: CapabilitySupport,
    pub effort_levels: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficialTemplateRef { pub engine_id: String, pub model_id: String, pub revision: String }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ModelSelector {
    Wire { model_id: String },
    Alias { alias: String, model_id: String },
}
impl ModelSelector {
    pub fn model_id(&self) -> &str {
        match self { Self::Wire { model_id } | Self::Alias { model_id, .. } => model_id }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileAuth { None, Bearer, ApiKey }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceTier { Default, Priority }

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<ServiceTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_thinking_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionProfile {
    pub profile_key: String,
    pub engine_id: String,
    pub label: String,
    pub group: String,
    pub protocol: CliProtocol,
    pub base_url: String,
    pub auth: ProfileAuth,
    pub execution_target: ExecutionTarget,
    pub target_grant_id: String,
    pub credential_scope: String,
    pub credentials: Vec<CredentialIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<ProfileOptions>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PolicySource { Official, Endpoint, User }

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicySources {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<PolicySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compaction_threshold_tokens: Option<PolicySource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<PolicySource>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelChoiceContribution {
    pub profile_key: String,
    pub model_key: String,
    pub label: String,
    pub selector: ModelSelector,
    pub template_ref: OfficialTemplateRef,
    pub token_policy: TokenPolicy,
    pub capabilities: ModelCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_sources: Option<PolicySources>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub management_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePublication {
    pub source_id: String,
    pub document_path: String,
    pub document_version: String,
    #[serde(deserialize_with = "required_nullable")]
    pub expected_publication_revision: Option<String>,
    pub profiles: Vec<ExecutionProfile>,
    pub choices: Vec<ModelChoiceContribution>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedSource {
    pub source_id: String,
    pub plugin_id: String,
    pub document_path: String,
    pub document_version: String,
    pub publication_revision: String,
    pub profiles: Vec<ExecutionProfile>,
    pub choices: Vec<ModelChoiceContribution>,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unavailable_profiles: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ModelSelection {
    Native {
        engine_id: String,
        #[serde(deserialize_with = "required_nullable")]
        model_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_id: Option<String>,
    },
    Contribution {
        engine_id: String, source_id: String, profile_key: String, model_key: String,
        #[serde(deserialize_with = "required_nullable")]
        credential: Option<CredentialIdentity>,
    },
}
impl ModelSelection {
    pub fn engine_id(&self) -> &str {
        match self { Self::Native { engine_id, .. } | Self::Contribution { engine_id, .. } => engine_id }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionSelectionInput {
    pub model_selection: ModelSelection,
    #[serde(deserialize_with = "required_nullable")]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionExecutionSelection {
    pub model_selection: ModelSelection,
    #[serde(deserialize_with = "required_nullable")]
    pub effort: Option<String>,
    pub version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionExecutionTarget {
    pub engine_id: String,
    pub workspace_path: String,
    #[serde(deserialize_with = "required_nullable")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_id: Option<String>,
    pub execution_target: ExecutionTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionExecutionContext {
    pub target: SessionExecutionTarget,
    #[serde(deserialize_with = "required_nullable")]
    pub selection: Option<SessionExecutionSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionSendRequest {
    #[serde(deserialize_with = "selection_schema")]
    pub schema_version: u32,
    pub target: SessionExecutionTarget,
    pub selection_version: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetGrantRequest {
    pub source_id: String,
    pub base_url: String,
    pub execution_target: ExecutionTarget,
    pub credentials: Vec<CredentialIdentity>,
    pub purpose: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetGrant {
    pub grant_id: String,
    pub source_id: String,
    pub base_url: String,
    pub execution_target: ExecutionTarget,
    pub credentials: Vec<CredentialIdentity>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMaterialRequest { pub profile_key: String, pub r#use: CredentialUseRef }

// Deliberately neither Debug nor Serialize: secret input must not become output.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMaterialInput {
    pub profile_key: String,
    pub r#use: CredentialUseRef,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliChange { pub source_id: String, pub publication_revision: Option<String> }

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiscoverySource { Official, AuthorizedEndpoint }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelDiscoveryRequest {
    pub source: DiscoverySource,
    pub engine_id: String,
    pub execution_target: ExecutionTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_grant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<CliProtocol>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_use: Option<CredentialUseRef>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelEvidence { Official, Endpoint, Unknown }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveredModel {
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<CliProtocol>,
    pub capabilities: ModelCapabilities,
    pub token_policy: TokenPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_ref: Option<OfficialTemplateRef>,
    pub evidence: ModelEvidence,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiscoveryStatus { Complete, Partial, Unsupported, Failed }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelDiscoveryResult {
    pub source: DiscoverySource,
    pub execution_target: ExecutionTarget,
    pub observed_at: u64,
    pub models: Vec<DiscoveredModel>,
    pub status: DiscoveryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConfigTarget {
    pub target_id: String, pub engine_id: String, pub label: String, pub paths: Vec<String>,
    pub import_supported: bool, pub apply_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConfigCandidate {
    pub candidate_id: String, pub label: String, pub base_url: String, pub protocol: CliProtocol,
    pub auth: ProfileAuth,
    pub models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_name: Option<String>,
    pub has_static_key: bool, pub skipped_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConfigPreview {
    pub preview_id: String, pub target: NativeConfigTarget, pub fingerprint: String,
    pub candidates: Vec<NativeConfigCandidate>, pub warnings: Vec<String>,
}

// This desktop-confirmed result is the one exceptional secret output. Never broadcast it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImportCandidate {
    #[serde(flatten)]
    pub candidate: NativeConfigCandidate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeImportResult { pub candidates: Vec<NativeImportCandidate> }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigPatchPreview {
    pub preview_id: String, pub target: NativeConfigTarget, pub fingerprint: String,
    pub changes: Vec<String>, pub contains_plaintext_key: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigPatchReceipt { pub receipt_id: String, pub target_id: String, pub fingerprint: String }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionChoice {
    pub choice_id: String, pub label: String, pub group: String, pub model_selection: ModelSelection,
    pub credentials: Vec<CredentialIdentity>, pub capabilities: ModelCapabilities, pub token_policy: TokenPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}
