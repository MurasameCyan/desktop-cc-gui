//! Generic, source-scoped execution contributions. The database is a generated
//! read-only projection; plugin documents remain the only editable source.
pub mod types;
pub mod grants;
pub mod discovery;
pub mod runtime;
pub mod native_config;
pub use types::*;
pub use runtime::{ensure_selection_material, resolve_contribution, ResolvedContribution, RuntimeMaterial};

use crate::event_sink::Emit;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Weak};

pub struct CliState {
    db: Arc<crate::db::Db>,
    emitter: Arc<dyn Emit>,
    inner: Arc<Mutex<CliInner>>,
}
#[derive(Default)]
struct CliInner {
    sources: BTreeMap<String, Arc<PublishedSource>>,
    grants: HashMap<String, grants::OwnedGrant>,
    materials: HashMap<RuntimeMaterialRequest, Arc<RuntimeMaterial>>,
    // No plaintext retention: generation digests and weak references enforce
    // immutable identity across profile/document handles for this host lifetime.
    material_identities: HashMap<(String, String, u64), runtime::MaterialIdentity>,
    pending: HashMap<RuntimeMaterialRequest, runtime::PendingMaterial>,
    generations: HashMap<String, u64>,
    data_version: i64,
}

// Weak registrations let existing plugin lifecycle commands invalidate every
// live app state without retaining test states or introducing global secrets.
struct LiveCli {
    db: Weak<crate::db::Db>,
    emitter: Weak<dyn Emit>,
    inner: Weak<Mutex<CliInner>>,
}
static LIVE_CLI: LazyLock<Mutex<Vec<LiveCli>>> = LazyLock::new(|| Mutex::new(Vec::new()));

pub fn invalidate_plugin(plugin_id: &str) {
    let states: Vec<_> = {
        let mut registry = LIVE_CLI.lock();
        registry.retain(|entry| entry.inner.strong_count() != 0);
        registry.iter().filter_map(|entry| Some(CliState {
            db:entry.db.upgrade()?, emitter:entry.emitter.upgrade()?, inner:entry.inner.upgrade()?,
        })).collect()
    };
    for state in states { state.invalidate_plugin(plugin_id); }
}

impl CliState {
    pub fn new(db: Arc<crate::db::Db>, emitter: Arc<dyn Emit>) -> Result<Self, String> {
        let (sources, grants, data_version) = {
            let conn = db.0.lock();
            initialize_database(&conn)?;
            (load_sources(&conn)?, grants::load_grants(&conn)?, database_version(&conn)?)
        };
        let inner = Arc::new(Mutex::new(CliInner {
            sources: sources.into_iter().map(|source| (source.source_id.clone(), Arc::new(source))).collect(),
            grants, data_version, ..CliInner::default()
        }));
        LIVE_CLI.lock().push(LiveCli {
            db:Arc::downgrade(&db), emitter:Arc::downgrade(&emitter), inner:Arc::downgrade(&inner),
        });
        Ok(Self { db, emitter, inner })
    }

    pub fn list_sources(&self) -> Result<Vec<PublishedSource>, String> {
        let mut inner = self.inner.lock();
        refresh_projection(&self.db, &mut inner)?;
        Ok(inner.sources.values().map(|source| source_with_availability(source, &inner)).collect())
    }

    pub fn get_source(&self, source_id: &str) -> Result<Option<PublishedSource>, String> {
        let mut inner = self.inner.lock();
        refresh_projection(&self.db, &mut inner)?;
        Ok(inner.sources.get(source_id).map(|source| source_with_availability(source, &inner)))
    }

    /// Called after disable/quarantine/uninstall. Running snapshots keep their
    /// Arc; only future resolutions lose authority and runtime material.
    pub fn invalidate_plugin(&self, plugin_id: &str) {
        let changes = {
            let mut inner = self.inner.lock();
            let generation = inner.generations.entry(plugin_id.to_string()).or_default();
            *generation = generation.saturating_add(1);
            inner.grants.retain(|_, grant| grant.plugin_id != plugin_id);
            let prefix = format!("plugin:{plugin_id}:");
            inner.materials.retain(|request, _| !request.r#use.source_id.starts_with(&prefix));
            inner.pending.retain(|request, pending| {
                if request.r#use.source_id.starts_with(&prefix) {
                    pending.notify.notify_waiters();
                    false
                } else { true }
            });
            let revoked = self.db.0.lock().execute("DELETE FROM cli_target_grants WHERE plugin_id=?1", [plugin_id]);
            // Fail closed in memory if persistence fails. Record invalidation so
            // a later read cannot restore these grants from the index.
            if revoked.is_err() {
                inner.generations.insert(plugin_id.to_string(), u64::MAX);
            }
            inner.sources.values().filter(|s| s.plugin_id == plugin_id)
                .map(|s| CliChange { source_id:s.source_id.clone(), publication_revision:Some(s.publication_revision.clone()) }).collect::<Vec<_>>()
        };
        native_config::invalidate_plugin(plugin_id);
        for change in changes { self.emit_change(&change); }
    }

    fn emit_change(&self, change: &CliChange) {
        if let Ok(json) = serde_json::to_string(change) { self.emitter.emit_json("cli://changed", &json); }
    }
}

pub fn require_permission(plugin_id: &str, permission: &str) -> Result<(), String> {
    let (enabled, permissions) = crate::plugins::plugin_enabled_permissions(plugin_id)?;
    if !enabled { return Err("plugin is disabled or quarantined".into()); }
    if !permissions.iter().any(|p| p == permission) { return Err(format!("plugin requires {permission}")); }
    Ok(())
}

pub fn namespace_source_id(plugin_id: &str, source_id: &str) -> Result<String, String> {
    validate_identifier(plugin_id)?;
    let prefix = format!("plugin:{plugin_id}:");
    let local_id = if source_id.starts_with("plugin:") {
        source_id.strip_prefix(&prefix).ok_or("source belongs to another plugin")?
    } else { source_id };
    validate_identifier(local_id)?;
    Ok(format!("{prefix}{local_id}"))
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b)) {
        return Err("invalid stable identifier".into());
    }
    Ok(())
}
fn validate_text(value: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err("invalid text field".into());
    }
    Ok(())
}
pub(crate) fn validate_target(target: &ExecutionTarget) -> Result<(), String> {
    if let ExecutionTarget::Wsl { host_id, distro } = target {
        validate_identifier(host_id)?;
        validate_text(distro, 256)?;
        if distro.starts_with('-') || distro.contains(['/', '\\']) { return Err("invalid WSL distribution".into()); }
    }
    Ok(())
}
pub(crate) fn validate_base_url(base_url: &str) -> Result<reqwest::Url, String> {
    if base_url.len() > 4096 || base_url.trim() != base_url || base_url.chars().any(char::is_control) {
        return Err("invalid endpoint URL".into());
    }
    let parsed = reqwest::Url::parse(base_url).map_err(|_| "invalid endpoint URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("endpoint must be an HTTP(S) URL without credentials, query or fragment".into());
    }
    Ok(parsed)
}
pub(crate) fn validate_credentials(credentials: &[CredentialIdentity]) -> Result<(), String> {
    if credentials.len() > 256 { return Err("too many credential identities".into()); }
    let mut ids = HashSet::new();
    for credential in credentials {
        validate_identifier(&credential.credential_id)?;
        validate_text(&credential.name, 256)?;
        if let Some(remark) = &credential.remark { if remark.len() > 1024 || remark.chars().any(char::is_control) { return Err("invalid credential remark".into()); } }
        if credential.credential_revision == 0 || credential.credential_revision > 9_007_199_254_740_991 || !ids.insert(&credential.credential_id) {
            return Err("invalid or duplicate credential identity".into());
        }
    }
    Ok(())
}

pub(crate) fn validate_source_shape(source: &SourcePublication) -> Result<(), String> {
    validate_text(&source.document_path, 1024)?;
    validate_text(&source.document_version, 256)?;
    if source.profiles.len() > 256 || source.choices.len() > 4096 { return Err("source exceeds contribution limit".into()); }
    let mut profiles = HashMap::new();
    for profile in &source.profiles {
        validate_identifier(&profile.profile_key)?;
        validate_text(&profile.label, 256)?;
        validate_text(&profile.group, 256)?;
        validate_text(&profile.credential_scope, 256)?;
        validate_text(&profile.target_grant_id, 256)?;
        validate_target(&profile.execution_target)?;
        validate_base_url(&profile.base_url)?;
        validate_credentials(&profile.credentials)?;
        if profiles.insert(&profile.profile_key, profile).is_some() { return Err("duplicate profile key".into()); }
        if !matches!(profile.engine_id.as_str(), "claude" | "codex" | "kimi" | "grok" | "opencode" | "pi" | "omp") {
            return Err("engine does not support managed contributions".into());
        }
        if profile.auth == ProfileAuth::None {
            if !profile.credentials.is_empty() || profile.default_credential_id.is_some() { return Err("unauthenticated profile must not carry credentials".into()); }
        } else if profile.credentials.is_empty() { return Err("authenticated profile requires an explicit credential identity".into()); }
        if profile.default_credential_id.as_ref().is_some_and(|id| !profile.credentials.iter().any(|c| &c.credential_id == id)) { return Err("unknown default credential identity".into()); }
        if let Some(options) = &profile.options {
            if let Some(headers) = &options.headers {
                if headers.len() > 32 { return Err("too many transport headers".into()); }
                let mut names = HashSet::new();
                for (name, value) in headers {
                    let lower = name.to_ascii_lowercase();
                    if reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
                        || reqwest::header::HeaderValue::from_str(value).is_err() || value.len() > 4096
                        || !names.insert(lower.clone())
                        || lower.contains("auth") || lower.contains("token") || lower.contains("key")
                        || matches!(lower.as_str(), "cookie" | "set-cookie" | "host" | "proxy-connection" | "connection" | "content-length" | "transfer-encoding" | "upgrade") {
                        return Err("unsafe transport header".into());
                    }
                }
            }
        }
    }
    let mut choices = HashSet::new();
    for choice in &source.choices {
        let profile = profiles.get(&choice.profile_key).ok_or("choice references an unknown profile")?;
        validate_identifier(&choice.model_key)?;
        validate_text(&choice.label, 256)?;
        validate_text(choice.selector.model_id(), 512)?;
        if choice.selector.model_id().starts_with('-') { return Err("invalid model selector".into()); }
        if let ModelSelector::Alias { alias, .. } = &choice.selector { validate_identifier(alias)?; }
        if !choices.insert((&choice.profile_key, &choice.model_key)) { return Err("duplicate model choice key".into()); }
        if choice.template_ref.engine_id != profile.engine_id { return Err("template engine does not match profile".into()); }
        validate_text(&choice.template_ref.model_id, 512)?;
        validate_text(&choice.template_ref.revision, 256)?;
        if let Some(key) = &choice.management_key { validate_identifier(key)?; }
        let policy = &choice.token_policy;
        for count in [policy.context_window_tokens, policy.auto_compaction_threshold_tokens, policy.max_output_tokens].into_iter().flatten() {
            if count == 0 || count > 1_000_000_000 { return Err("token limit must be a positive bounded integer".into()); }
        }
        if let Some(context) = policy.context_window_tokens {
            if policy.auto_compaction_threshold_tokens.is_some_and(|n| n >= context) || policy.max_output_tokens.is_some_and(|n| n > context) { return Err("token policy exceeds context window".into()); }
        }
        let mut efforts = HashSet::new();
        if choice.capabilities.effort_levels.len() > 16 { return Err("too many effort levels".into()); }
        for effort in &choice.capabilities.effort_levels {
            validate_identifier(effort)?;
            if !efforts.insert(effort) { return Err("duplicate effort level".into()); }
        }
        crate::engine::contribution::validate_profile_choice(profile, choice)?;
    }
    Ok(())
}

fn initialize_database(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS cli_sources (source_id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, publication_revision TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cli_target_grants (grant_id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, payload TEXT NOT NULL);").map_err(|_| "initialize CLI contribution index".to_string())
}
fn load_sources(conn: &Connection) -> Result<Vec<PublishedSource>, String> {
    let mut query = conn.prepare("SELECT payload FROM cli_sources ORDER BY source_id").map_err(|_| "read CLI contribution index")?;
    let rows = query.query_map([], |row| row.get::<_, String>(0)).map_err(|_| "read CLI contribution index")?;
    rows.map(|row| serde_json::from_str(&row.map_err(|_| "read CLI contribution index")?).map_err(|_| "invalid CLI contribution index".to_string())).collect()
}
fn database_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA data_version", [], |row| row.get(0)).map_err(|_| "read contribution cache version".into())
}
fn refresh_projection(db: &crate::db::Db, inner: &mut CliInner) -> Result<(), String> {
    let conn = db.0.lock();
    let version = database_version(&conn)?;
    if version == inner.data_version { return Ok(()); }
    let sources = load_sources(&conn)?;
    inner.sources = sources.into_iter().map(|source| (source.source_id.clone(), Arc::new(source))).collect();
    inner.grants = grants::load_grants(&conn)?.into_iter().filter(|(_, grant)| inner.generations.get(&grant.plugin_id) != Some(&u64::MAX)).collect();
    inner.materials.retain(|request, _| inner.sources.get(&request.r#use.source_id).is_some_and(|source| source.document_version == request.r#use.registry_revision));
    inner.data_version = version;
    Ok(())
}
fn persist_publication(conn: &mut Connection, plugin_id: &str, request: &SourcePublication) -> Result<PublishedSource, String> {
    validate_source_shape(request)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "begin source publication")?;
    let previous: Option<(String, String)> = tx.query_row("SELECT plugin_id, publication_revision FROM cli_sources WHERE source_id=?1", [&request.source_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|_| "read source publication")?;
    if previous.as_ref().is_some_and(|(owner, _)| owner != plugin_id) { return Err("source belongs to another plugin".into()); }
    if previous.as_ref().map(|(_, revision)| revision.as_str()) != request.expected_publication_revision.as_deref() { return Err("source publication revision conflict".into()); }
    // Check grants inside the same write transaction: another host process
    // cannot revoke a destination between validation and publication commit.
    for profile in &request.profiles {
        let payload: Option<String> = tx.query_row("SELECT payload FROM cli_target_grants WHERE grant_id=?1 AND plugin_id=?2", params![profile.target_grant_id,plugin_id], |row| row.get(0)).optional().map_err(|_| "read publication target grant")?;
        let grant: TargetGrant = serde_json::from_str(&payload.ok_or("target authorization is missing or revoked")?).map_err(|_| "invalid publication target grant")?;
        if !grants::grant_matches_profile(&grant, &request.source_id, profile) { return Err("target authorization does not match publication".into()); }
    }
    let published = PublishedSource {
        source_id:request.source_id.clone(), plugin_id:plugin_id.into(), document_path:request.document_path.clone(), document_version:request.document_version.clone(),
        publication_revision:uuid::Uuid::new_v4().to_string(), profiles:request.profiles.clone(), choices:request.choices.clone(), available:true, unavailable_reason:None,
        unavailable_profiles:BTreeMap::new(),
    };
    let payload = serde_json::to_string(&published).map_err(|_| "encode source publication")?;
    if payload.len() > 4 * 1024 * 1024 { return Err("source exceeds publication size limit".into()); }
    tx.execute("INSERT INTO cli_sources (source_id,plugin_id,publication_revision,payload) VALUES (?1,?2,?3,?4) ON CONFLICT(source_id) DO UPDATE SET publication_revision=excluded.publication_revision,payload=excluded.payload", params![published.source_id,plugin_id,published.publication_revision,payload]).map_err(|_| "save source publication")?;
    tx.commit().map_err(|_| "commit source publication")?;
    Ok(published)
}
fn source_with_availability(source: &PublishedSource, inner: &CliInner) -> PublishedSource {
    let mut source = source.clone();
    let reason = require_permission(&source.plugin_id, "cli.contributions.write")
        .and_then(|_| require_permission(&source.plugin_id, "network.targets.request")).err();
    source.available = reason.is_none();
    source.unavailable_reason = reason;
    source.unavailable_profiles.clear();
    if source.available {
        for profile in &source.profiles {
            if let Err(reason) = grants::require_profile_grant(inner, &source.plugin_id, &source.source_id, profile) {
                source.unavailable_profiles.insert(profile.profile_key.clone(), reason);
            }
        }
    }
    source
}

pub(crate) fn routing_fingerprint(source_id: &str, profile: &ExecutionProfile, choice: &ModelChoiceContribution, credential: Option<&CredentialIdentity>, effort: Option<&str>) -> Result<String, String> {
    // Struct fields and BTreeMap headers provide a stable order. Labels, receipt
    // revisions and unrelated keys/models are intentionally not routing inputs.
    let data = serde_json::to_vec(&serde_json::json!({
        "sourceId":source_id,"profileKey":profile.profile_key,"modelKey":choice.model_key,
        "engine":profile.engine_id,"protocol":profile.protocol,"baseUrl":profile.base_url,
        "auth":profile.auth,"target":profile.execution_target,"grant":profile.target_grant_id,
        "scope":profile.credential_scope,"options":profile.options,"selector":choice.selector,
        "tokens":choice.token_policy,"capabilities":choice.capabilities,"effort":effort,
        "credential":credential.map(|c| (&c.credential_id,c.credential_revision))
    })).map_err(|_| "encode execution fingerprint")?;
    Ok(format!("{:x}", Sha256::digest(data)))
}

#[tauri::command]
pub fn cli_list_sources(state: tauri::State<'_, crate::AppState>) -> Result<Vec<PublishedSource>, String> { state.cli.list_sources() }
#[tauri::command]
pub fn plugin_cli_list_sources(state: tauri::State<'_, crate::AppState>, plugin_id: String) -> Result<Vec<PublishedSource>, String> {
    require_permission(&plugin_id, "cli.read")?;
    Ok(state.cli.list_sources()?.into_iter().filter(|source| source.plugin_id == plugin_id).collect())
}
#[tauri::command]
pub fn plugin_cli_get_source(state: tauri::State<'_, crate::AppState>, plugin_id: String, source_id: String) -> Result<Option<PublishedSource>, String> {
    require_permission(&plugin_id, "cli.read")?;
    state.cli.get_source(&namespace_source_id(&plugin_id, &source_id)?)
}
#[tauri::command]
pub fn plugin_cli_publish_source(state: tauri::State<'_, crate::AppState>, plugin_id: String, mut request: SourcePublication) -> Result<PublishedSource, String> {
    require_permission(&plugin_id, "cli.contributions.write")?;
    require_permission(&plugin_id, "plugin.storage")?;
    require_permission(&plugin_id, "network.targets.request")?;
    if request.profiles.iter().any(|profile| profile.auth != ProfileAuth::None) { require_permission(&plugin_id, "cli.runtime.sensitive")?; }
    request.source_id = namespace_source_id(&plugin_id, &request.source_id)?;
    validate_source_shape(&request)?;
    let published = crate::plugins::storage::with_document_version(&plugin_id, &request.document_path, &request.document_version, || {
        // Permission reads are lockless atomic-file reads; the storage guard
        // prevents lifecycle writers from changing them until commit.
        require_permission(&plugin_id, "cli.contributions.write")?;
        require_permission(&plugin_id, "network.targets.request")?;
        if request.profiles.iter().any(|profile| profile.auth != ProfileAuth::None) { require_permission(&plugin_id, "cli.runtime.sensitive")?; }
        let mut inner = state.cli.inner.lock();
        refresh_projection(&state.db, &mut inner)?;
        for profile in &request.profiles {
            let grant = inner.grants.get(&profile.target_grant_id).ok_or("target authorization is missing or revoked")?;
            if grant.plugin_id != plugin_id || !grants::grant_matches_profile(&grant.grant, &request.source_id, profile) { return Err("target authorization does not match publication".into()); }
        }
        let published = persist_publication(&mut state.db.0.lock(), &plugin_id, &request)?;
        inner.materials.retain(|use_ref, _| use_ref.r#use.source_id != published.source_id || use_ref.r#use.registry_revision == published.document_version);
        inner.sources.insert(published.source_id.clone(), Arc::new(published.clone()));
        for (request, pending) in &inner.pending {
            if request.r#use.source_id == published.source_id { pending.notify.notify_waiters(); }
        }
        Ok(published)
    })?;
    state.cli.emit_change(&CliChange { source_id:published.source_id.clone(), publication_revision:Some(published.publication_revision.clone()) });
    Ok(published)
}
#[tauri::command]
pub fn plugin_cli_unpublish_source(state: tauri::State<'_, crate::AppState>, plugin_id: String, source_id: String, expected_revision: String) -> Result<(), String> {
    require_permission(&plugin_id, "cli.contributions.write")?;
    let source_id = namespace_source_id(&plugin_id, &source_id)?;
    {
        let mut inner = state.cli.inner.lock();
        let deleted = state.db.0.lock().execute("DELETE FROM cli_sources WHERE source_id=?1 AND plugin_id=?2 AND publication_revision=?3", params![source_id,plugin_id,expected_revision]).map_err(|_| "remove source publication")?;
        if deleted != 1 { return Err("source publication revision conflict".into()); }
        inner.sources.remove(&source_id);
        inner.materials.retain(|request, _| request.r#use.source_id != source_id);
        inner.pending.retain(|request, pending| { if request.r#use.source_id == source_id { pending.notify.notify_waiters(); false } else { true } });
    }
    state.cli.emit_change(&CliChange { source_id, publication_revision:None });
    Ok(())
}

#[cfg(test)]
mod tests;
