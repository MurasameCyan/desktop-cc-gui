//! The complete selection is the only mutable routing authority for a session.

use crate::cli::types::{
    CredentialUseRef, ExecutionSelectionInput, ExecutionTarget, ModelSelection,
    RuntimeMaterialRequest, SelectionSendRequest, SessionExecutionContext,
    SessionExecutionSelection, SessionExecutionTarget,
};
use crate::db::Db;
use crate::event_sink::Emit;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashSet;

pub const SELECTION_CHANGED_EVENT: &str = "session://selection-changed";
const CONFIRM_LEGACY: &str = "This session has no complete execution identity. Confirm its model, channel and effort before sending; current defaults will not be used.";
// Versions cross the JSON/JavaScript boundary without precision loss.
const MAX_VERSION: u64 = 9_007_199_254_740_991;

fn validate_target(target: &SessionExecutionTarget) -> Result<(), String> {
    if !crate::config::ENGINES.contains(&target.engine_id.as_str()) {
        return Err("unknown session engine".into());
    }
    if target.workspace_path.trim().is_empty() || target.workspace_path.contains('\0') {
        return Err("a nonempty workspacePath is required".into());
    }
    let id = match (&target.session_id, &target.pending_id) {
        (Some(id), None) | (None, Some(id)) => id,
        _ => return Err("provide exactly one sessionId or pendingId".into()),
    };
    if id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err("invalid session identity".into());
    }
    if let ExecutionTarget::Wsl { host_id, distro } = &target.execution_target {
        if host_id.trim().is_empty() || distro.trim().is_empty()
            || host_id.chars().any(char::is_control) || distro.chars().any(char::is_control)
        {
            return Err("WSL target requires hostId and distro".into());
        }
    }
    Ok(())
}

fn validate_input(target: &SessionExecutionTarget, input: &ExecutionSelectionInput) -> Result<(), String> {
    if input.model_selection.engine_id() != target.engine_id {
        return Err("selection engine does not match its session target".into());
    }
    if input.effort.as_ref().is_some_and(|value| value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control)) {
        return Err("effort must be an explicit nonempty level or null".into());
    }
    match &input.model_selection {
        ModelSelection::Native { model_id, channel_id, .. } => {
            for value in [model_id, channel_id].into_iter().flatten() {
                if value.trim().is_empty() || value.chars().any(char::is_control) {
                    return Err("native model/channel must be a nonempty identity or null".into());
                }
            }
            if channel_id.as_deref() == Some(crate::config::DISABLED_PROVIDER_ID) {
                return Err("a disabled channel is not an execution selection".into());
            }
            if input.effort.is_some() && !crate::engine::engine_by_id(&target.engine_id)
                .ok_or("unknown engine")?.supports_effort()
            {
                return Err("this engine has no effort control; explicitly select null".into());
            }
        }
        ModelSelection::Contribution { source_id, profile_key, model_key, credential, .. } => {
            if [source_id, profile_key, model_key].iter().any(|id| id.trim().is_empty()) {
                return Err("contribution source/profile/model identities are required".into());
            }
            if credential.as_ref().is_some_and(|key| key.credential_id.trim().is_empty() || key.credential_revision > MAX_VERSION) {
                return Err("invalid credential identity".into());
            }
        }
    }
    Ok(())
}

fn execution_key(target: &SessionExecutionTarget) -> Result<String, String> {
    serde_json::to_string(&target.execution_target).map_err(|e| e.to_string())
}

fn identity(target: &SessionExecutionTarget) -> (&str, &str) {
    match &target.session_id {
        Some(id) => ("native", id),
        None => ("pending", target.pending_id.as_deref().expect("validated pending identity")),
    }
}

fn canonical_target(conn: &Connection, target: &SessionExecutionTarget) -> Result<SessionExecutionTarget, String> {
    let mut canonical = target.clone();
    if let Some(pending_id) = &target.pending_id {
        let native_id: Option<String> = conn.query_row(
            "SELECT native_id FROM session_pending_adoptions WHERE execution_target=?1 AND workspace_path=?2 AND engine=?3 AND pending_id=?4",
            params![execution_key(target)?, target.workspace_path, target.engine_id, pending_id], |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(id) = native_id {
            canonical.session_id = Some(id);
            canonical.pending_id = None;
        }
    }
    Ok(canonical)
}

fn read_selection(conn: &Connection, target: &SessionExecutionTarget) -> Result<Option<SessionExecutionSelection>, String> {
    let (kind, id) = identity(target);
    let row: Option<(String, u64)> = conn.query_row(
        "SELECT selection_json,version FROM session_execution_selections WHERE execution_target=?1 AND workspace_path=?2 AND engine=?3 AND identity_kind=?4 AND identity=?5",
        params![execution_key(target)?, target.workspace_path, target.engine_id, kind, id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    row.map(|(json, version)| {
        let input: ExecutionSelectionInput = serde_json::from_str(&json).map_err(|e| format!("invalid stored execution selection: {e}"))?;
        validate_input(target, &input)?;
        if version == 0 || version > MAX_VERSION { return Err("invalid stored selection version".into()); }
        Ok(SessionExecutionSelection { model_selection: input.model_selection, effort: input.effort, version })
    }).transpose()
}

fn insert_selection(conn: &Connection, target: &SessionExecutionTarget, input: &ExecutionSelectionInput, version: u64) -> Result<(), String> {
    let (kind, id) = identity(target);
    conn.execute(
        "INSERT INTO session_execution_selections(execution_target,workspace_path,engine,identity_kind,identity,selection_json,version) VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(execution_target,workspace_path,engine,identity_kind,identity) DO UPDATE SET selection_json=excluded.selection_json,version=excluded.version",
        params![execution_key(target)?, target.workspace_path, target.engine_id, kind, id, serde_json::to_string(input).map_err(|e| e.to_string())?, version],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_or_migrate(conn: &Connection, target: &SessionExecutionTarget) -> Result<Option<SessionExecutionSelection>, String> {
    if let Some(saved) = read_selection(conn, target)? { return Ok(Some(saved)); }
    let Some(session_id) = &target.session_id else { return Ok(None) };
    // The old tables did not carry execution-target scope. Only an indexed,
    // local transcript in this exact workspace is attributable without guessing.
    if target.execution_target != ExecutionTarget::Local { return Ok(None); }
    let legacy: Option<(Option<String>, Option<String>, Option<String>)> = conn.query_row(
        "SELECT m.model,e.effort,p.provider_id FROM sessions s
         LEFT JOIN session_models m ON m.engine=s.engine AND m.session_id=s.session_id
         LEFT JOIN session_efforts e ON e.engine=s.engine AND e.session_id=s.session_id
         LEFT JOIN session_providers p ON p.engine=s.engine AND p.session_id=s.session_id
         WHERE s.engine=?1 AND s.session_id=?2 AND s.workspace_path=?3",
        params![target.engine_id, session_id, target.workspace_path],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(|e| e.to_string())?;
    // Missing channel meant "current", not necessarily native. Missing effort
    // was likewise filled from globals. Neither is historical evidence.
    let Some((Some(model), Some(effort), Some(channel))) = legacy else { return Ok(None) };
    let channel_id = match channel.as_str() {
        crate::config::LOCAL_PROVIDER_ID | crate::config::LEGACY_LOCAL_CONFIG_TOML_ID => None,
        _ => Some(channel),
    };
    let input = ExecutionSelectionInput {
        model_selection: ModelSelection::Native { engine_id: target.engine_id.clone(), model_id: Some(model), channel_id },
        effort: Some(effort),
    };
    if validate_input(target, &input).is_err() { return Ok(None); }
    insert_selection(conn, target, &input, 1)?;
    Ok(Some(SessionExecutionSelection { model_selection: input.model_selection, effort: input.effort, version: 1 }))
}

fn context(target: SessionExecutionTarget, selection: Option<SessionExecutionSelection>) -> SessionExecutionContext {
    let unavailable_reason = (target.session_id.is_some() && selection.is_none()).then(|| CONFIRM_LEGACY.to_owned());
    SessionExecutionContext { target, selection, unavailable_reason }
}

pub(crate) fn get_context_from(db: &Db, target: &SessionExecutionTarget) -> Result<SessionExecutionContext, String> {
    validate_target(target)?;
    let mut conn = db.0.lock();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let canonical = canonical_target(&tx, target)?;
    let selection = load_or_migrate(&tx, &canonical)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(context(canonical, selection))
}

fn check_version(selection: Option<&SessionExecutionSelection>, expected: Option<u64>) -> Result<(), String> {
    if selection.map(|s| s.version) != expected {
        return Err("session selection version conflict; reload this session before applying changes".into());
    }
    Ok(())
}

fn compare_and_set(db: &Db, target: &SessionExecutionTarget, input: ExecutionSelectionInput, expected_version: Option<u64>) -> Result<SessionExecutionContext, String> {
    validate_target(target)?;
    validate_input(target, &input)?;
    let mut conn = db.0.lock();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let canonical = canonical_target(&tx, target)?;
    let current = load_or_migrate(&tx, &canonical)?;
    check_version(current.as_ref(), expected_version)?;
    let version = current.as_ref().map_or(1, |s| s.version + 1);
    if version > MAX_VERSION { return Err("session selection version exhausted".into()); }
    insert_selection(&tx, &canonical, &input, version)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(context(canonical, Some(SessionExecutionSelection { model_selection: input.model_selection, effort: input.effort, version })))
}

fn validate_available(state: &crate::AppState, target: &SessionExecutionTarget, input: &ExecutionSelectionInput) -> Result<(), String> {
    validate_input(target, input)?;
    match &input.model_selection {
        ModelSelection::Contribution { .. } => crate::cli::runtime::validate_contribution_metadata(state, target, input),
        ModelSelection::Native { channel_id: Some(channel_id), .. } => {
            if target.execution_target != ExecutionTarget::Local {
                return Err("legacy host channels cannot be used on a different execution target".into());
            }
            let config = crate::config::read_config()?;
            if !config.section(&target.engine_id).is_some_and(|section| section.providers.contains_key(channel_id)) {
                return Err("the selected legacy channel no longer exists; explicitly select another source".into());
            }
            Ok(())
        }
        ModelSelection::Native { .. } => Ok(()),
    }
}

pub fn get_context(state: &crate::AppState, target: &SessionExecutionTarget) -> Result<SessionExecutionContext, String> {
    let mut result = get_context_from(&state.db, target)?;
    if let Some(saved) = &result.selection {
        let input = ExecutionSelectionInput { model_selection: saved.model_selection.clone(), effort: saved.effort.clone() };
        result.unavailable_reason = validate_available(state, &result.target, &input).err();
    }
    Ok(result)
}

pub fn emit_selection_changed(state: &crate::AppState, context: &SessionExecutionContext) -> Result<(), String> {
    let json = serde_json::to_string(context).map_err(|e| e.to_string())?;
    state.emitters.emit_json(SELECTION_CHANGED_EVENT, &json);
    state.sink.emit_sessions_changed();
    Ok(())
}

pub async fn set_selection(state: &crate::AppState, target: &SessionExecutionTarget, input: ExecutionSelectionInput, expected_version: Option<u64>) -> Result<SessionExecutionContext, String> {
    let current = get_context_from(&state.db, target)?;
    check_version(current.selection.as_ref(), expected_version)?;
    validate_available(state, &current.target, &input)?;
    crate::cli::runtime::ensure_selection_material(state, &current.target, &input).await?;
    // No SQLite/CLI lock is held while awaiting the selected Key. Another
    // client or native-id adoption may have changed this record meanwhile.
    validate_available(state, &current.target, &input)?;
    let result = compare_and_set(&state.db, target, input, expected_version)?;
    emit_selection_changed(state, &result)?;
    Ok(result)
}

fn set_effort_in(db: &Db, target: &SessionExecutionTarget, effort: Option<String>, expected_version: Option<u64>) -> Result<SessionExecutionContext, String> {
    let current = get_context_from(db, target)?;
    check_version(current.selection.as_ref(), expected_version)?;
    let saved = current.selection.ok_or("choose a complete session selection before changing effort")?;
    compare_and_set(db, target, ExecutionSelectionInput { model_selection: saved.model_selection, effort }, expected_version)
}

pub fn set_effort(state: &crate::AppState, target: &SessionExecutionTarget, effort: Option<String>, expected_version: Option<u64>) -> Result<SessionExecutionContext, String> {
    let current = get_context_from(&state.db, target)?;
    check_version(current.selection.as_ref(), expected_version)?;
    let saved = current.selection.as_ref().ok_or("choose a complete session selection before changing effort")?;
    let input = ExecutionSelectionInput { model_selection: saved.model_selection.clone(), effort: effort.clone() };
    validate_available(state, &current.target, &input)?;
    let result = set_effort_in(&state.db, target, effort, expected_version)?;
    emit_selection_changed(state, &result)?;
    Ok(result)
}

pub fn selection_for_send(state: &crate::AppState, request: &SelectionSendRequest) -> Result<SessionExecutionSelection, String> {
    if request.schema_version != 1 { return Err("unsupported selection schema; refresh the client".into()); }
    let current = get_context(state, &request.target)?;
    selection_from_context(request, current)
}

fn selection_from_context(request: &SelectionSendRequest, current: SessionExecutionContext) -> Result<SessionExecutionSelection, String> {
    if current.target != request.target {
        return Err("session identity changed after native adoption; refresh this session before sending".into());
    }
    if let Some(reason) = current.unavailable_reason { return Err(reason); }
    let saved = current.selection.ok_or("choose a complete session selection before sending")?;
    check_version(Some(&saved), Some(request.selection_version))?;
    Ok(saved)
}

/// Move the newest saved selection, never the model/Key frozen in a running
/// turn. The alias also redirects selection writes that were awaiting material.
pub fn adopt_pending(db: &Db, pending_target: &SessionExecutionTarget, native_id: &str) -> Result<SessionExecutionContext, String> {
    validate_target(pending_target)?;
    if pending_target.session_id.is_some() { return Err("adoption requires a pending target".into()); }
    let mut native = pending_target.clone();
    native.session_id = Some(native_id.to_owned());
    native.pending_id = None;
    validate_target(&native)?;
    let mut conn = db.0.lock();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let canonical = canonical_target(&tx, pending_target)?;
    if canonical.session_id.is_some() {
        if canonical != native { return Err("pending session was already adopted by a different native session".into()); }
        let saved = read_selection(&tx, &canonical)?.ok_or("adopted session selection is missing")?;
        return Ok(context(canonical, Some(saved)));
    }
    let saved = read_selection(&tx, pending_target)?.ok_or("pending session selection is missing")?;
    if load_or_migrate(&tx, &native)?.is_some() {
        return Err("native session already has an independent execution selection".into());
    }
    let input = ExecutionSelectionInput { model_selection: saved.model_selection.clone(), effort: saved.effort.clone() };
    insert_selection(&tx, &native, &input, saved.version)?;
    let execution = execution_key(pending_target)?;
    let pending_id = pending_target.pending_id.as_deref().expect("validated pending identity");
    tx.execute(
        "INSERT INTO session_pending_adoptions(execution_target,workspace_path,engine,pending_id,native_id) VALUES(?1,?2,?3,?4,?5)",
        params![execution, pending_target.workspace_path, pending_target.engine_id, pending_id, native_id],
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM session_execution_selections WHERE execution_target=?1 AND workspace_path=?2 AND engine=?3 AND identity_kind='pending' AND identity=?4",
        params![execution, pending_target.workspace_path, pending_target.engine_id, pending_id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(context(native, Some(saved)))
}

/// Actual CLI observations do not mutate requested routing or its CAS version.
pub fn record_observed(db: &Db, target: &SessionExecutionTarget, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
    validate_target(target)?;
    let conn = db.0.lock();
    let canonical = canonical_target(&conn, target)?;
    let session_id = canonical.session_id.as_deref().ok_or("observations require an adopted session")?;
    conn.execute(
        "INSERT INTO session_observations(execution_target,workspace_path,engine,session_id,observed_model,observed_effort) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(execution_target,workspace_path,engine,session_id) DO UPDATE SET observed_model=COALESCE(excluded.observed_model,observed_model),observed_effort=COALESCE(excluded.observed_effort,observed_effort)",
        params![execution_key(&canonical)?, canonical.workspace_path, canonical.engine_id, session_id, model, effort],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn credential_uses(state: &crate::AppState, source_id: &str) -> Result<Vec<RuntimeMaterialRequest>, String> {
    // Release the DB lock before entering CLI state: runtime registration also
    // consults these references and must never invert the two lock orders.
    let bindings: Vec<(ExecutionTarget, ExecutionSelectionInput)> = {
        let conn = state.db.0.lock();
        let mut stmt = conn.prepare("SELECT execution_target,selection_json FROM session_execution_selections").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        let mut bindings = Vec::new();
        for row in rows {
            let (target, json) = row.map_err(|e| e.to_string())?;
            bindings.push((serde_json::from_str(&target).map_err(|e| e.to_string())?, serde_json::from_str(&json).map_err(|e| e.to_string())?));
        }
        bindings
    };
    let Some(source) = state.cli.get_source(source_id)? else { return Ok(Vec::new()) };
    if !source.available { return Ok(Vec::new()); }
    let mut seen = HashSet::new();
    let mut uses = Vec::new();
    for (target, binding) in bindings {
        let ModelSelection::Contribution { source_id: bound_source, engine_id, profile_key, model_key, credential: Some(key) } = binding.model_selection else { continue };
        if bound_source != source_id { continue; }
        if source.unavailable_profiles.contains_key(&profile_key) { continue; }
        let Some(profile) = source.profiles.iter().find(|p| p.profile_key == profile_key && p.engine_id == engine_id && p.execution_target == target) else { continue };
        if !profile.credentials.iter().any(|c| c.credential_id == key.credential_id && c.credential_revision == key.credential_revision)
            || !source.choices.iter().any(|c| c.profile_key == profile_key && c.model_key == model_key)
        { continue; }
        let request = RuntimeMaterialRequest {
            profile_key,
            r#use: CredentialUseRef { source_id: bound_source, credential_id: key.credential_id, credential_revision: key.credential_revision, registry_revision: source.document_version.clone() },
        };
        if seen.insert(request.clone()) { uses.push(request); }
    }
    Ok(uses)
}

#[tauri::command]
pub fn get_session_selection(state: tauri::State<'_, crate::AppState>, target: SessionExecutionTarget) -> Result<SessionExecutionContext, String> {
    get_context(&state, &target)
}

#[tauri::command]
pub async fn set_session_selection(state: tauri::State<'_, crate::AppState>, target: SessionExecutionTarget, selection: ExecutionSelectionInput, expected_version: Option<u64>) -> Result<SessionExecutionContext, String> {
    set_selection(&state, &target, selection, expected_version).await
}

#[tauri::command]
pub fn set_session_effort(state: tauri::State<'_, crate::AppState>, target: SessionExecutionTarget, effort: Option<String>, expected_version: Option<u64>) -> Result<SessionExecutionContext, String> {
    set_effort(&state, &target, effort, expected_version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::types::CredentialIdentity;

    fn db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn target(workspace: &str, id: &str) -> SessionExecutionTarget {
        SessionExecutionTarget {
            engine_id: "omp".into(), workspace_path: workspace.into(),
            session_id: Some(id.into()), pending_id: None,
            execution_target: ExecutionTarget::Local,
        }
    }

    fn input(key: &str, effort: Option<&str>) -> ExecutionSelectionInput {
        ExecutionSelectionInput {
            model_selection: ModelSelection::Contribution {
                engine_id: "omp".into(), source_id: "plugin:test:source".into(),
                profile_key: "profile".into(), model_key: "model".into(),
                credential: Some(CredentialIdentity {
                    credential_id: key.into(), credential_revision: 3,
                    name: key.into(), remark: None,
                }),
            },
            effort: effort.map(str::to_owned),
        }
    }

    #[test]
    fn workspaces_and_execution_targets_do_not_share_keys() {
        let db = db();
        let a = target("/a", "same");
        let b = target("/b", "same");
        let mut remote = a.clone();
        remote.execution_target = ExecutionTarget::Wsl { host_id: "host".into(), distro: "Ubuntu".into() };
        compare_and_set(&db, &a, input("A", Some("high")), None).unwrap();
        compare_and_set(&db, &b, input("B", None), None).unwrap();
        compare_and_set(&db, &remote, input("C", Some("low")), None).unwrap();
        assert_eq!(get_context_from(&db, &a).unwrap().selection.unwrap().model_selection, input("A", None).model_selection);
        assert_eq!(get_context_from(&db, &b).unwrap().selection.unwrap().model_selection, input("B", None).model_selection);
        assert_eq!(get_context_from(&db, &remote).unwrap().selection.unwrap().model_selection, input("C", None).model_selection);
    }

    #[test]
    fn stale_client_cannot_overwrite_another_clients_selection() {
        let db = db();
        let t = target("/a", "session");
        compare_and_set(&db, &t, input("A", Some("high")), None).unwrap();
        compare_and_set(&db, &t, input("B", Some("low")), Some(1)).unwrap();
        assert!(compare_and_set(&db, &t, input("A", None), Some(1)).unwrap_err().contains("conflict"));
        assert!(compare_and_set(&db, &t, input("A", None), None).is_err());
        assert_eq!(get_context_from(&db, &t).unwrap().selection.unwrap().model_selection, input("B", None).model_selection);
    }

    #[test]
    fn effort_edit_preserves_key_and_explicit_null() {
        let db = db();
        let t = target("/a", "session");
        compare_and_set(&db, &t, input("A", Some("high")), None).unwrap();
        let saved = set_effort_in(&db, &t, None, Some(1)).unwrap().selection.unwrap();
        assert_eq!(saved.model_selection, input("A", None).model_selection);
        assert_eq!(saved.effort, None);
        assert_eq!(get_context_from(&db, &t).unwrap().selection.unwrap(), saved);
        assert!(set_effort_in(&db, &t, Some("low".into()), Some(1)).is_err());
    }

    #[test]
    fn stale_pending_send_cannot_create_a_second_native_session() {
        let db = db();
        let mut pending = target("/a", "unused");
        pending.session_id = None;
        pending.pending_id = Some("pending-send".into());
        compare_and_set(&db, &pending, input("A", None), None).unwrap();
        let adopted = adopt_pending(&db, &pending, "native").unwrap();
        let request = SelectionSendRequest { schema_version: 1, target: pending.clone(), selection_version: 1 };
        assert!(selection_from_context(&request, get_context_from(&db, &pending).unwrap()).is_err());
        let current_request = SelectionSendRequest { target: adopted.target.clone(), ..request };
        assert_eq!(selection_from_context(&current_request, adopted.clone()).unwrap(), adopted.selection.unwrap());
    }

    #[test]
    fn adoption_moves_latest_selection_and_late_writes_follow_native_identity() {
        let db = db();
        let mut pending = target("/a", "unused");
        pending.session_id = None;
        pending.pending_id = Some("pending".into());
        compare_and_set(&db, &pending, input("A", Some("high")), None).unwrap();
        // The first run has A frozen; the user already selected B for the next run.
        compare_and_set(&db, &pending, input("B", None), Some(1)).unwrap();
        let adopted = adopt_pending(&db, &pending, "native").unwrap();
        assert_eq!(adopted.target.session_id.as_deref(), Some("native"));
        assert_eq!(adopted.selection.as_ref().unwrap().model_selection, input("B", None).model_selection);
        assert_eq!(adopted.selection.as_ref().unwrap().version, 2);
        assert_eq!(adopt_pending(&db, &pending, "native").unwrap(), adopted);
        assert!(compare_and_set(&db, &pending, input("A", None), Some(1)).is_err());
        let latest = compare_and_set(&db, &pending, input("C", Some("low")), Some(2)).unwrap();
        assert_eq!(latest.target, adopted.target);
        assert_eq!(get_context_from(&db, &target("/a", "native")).unwrap(), latest);
        assert!(adopt_pending(&db, &pending, "another").is_err());
    }

    #[test]
    fn adoption_conflict_does_not_overwrite_either_session() {
        let db = db();
        let native = target("/a", "native");
        let mut pending = native.clone();
        pending.session_id = None;
        pending.pending_id = Some("pending".into());
        compare_and_set(&db, &pending, input("A", None), None).unwrap();
        compare_and_set(&db, &native, input("B", None), None).unwrap();
        assert!(adopt_pending(&db, &pending, "native").is_err());
        assert_eq!(get_context_from(&db, &pending).unwrap().selection.unwrap().model_selection, input("A", None).model_selection);
        assert_eq!(get_context_from(&db, &native).unwrap().selection.unwrap().model_selection, input("B", None).model_selection);
    }

    fn legacy(db: &Db) {
        db.0.lock().execute(
            "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('omp','old','/a','/old.jsonl',0,0)", [],
        ).unwrap();
        db.remember_session_model("omp", "old", "provider/model", 1).unwrap();
        db.remember_session_effort("omp", "old", "high", 1).unwrap();
    }

    #[test]
    fn legacy_unknown_channel_requires_confirmation_not_current_defaults() {
        let db = db();
        legacy(&db);
        let context = get_context_from(&db, &target("/a", "old")).unwrap();
        assert_eq!(context.selection, None);
        assert!(context.unavailable_reason.is_some());
        assert_eq!(get_context_from(&db, &target("/b", "old")).unwrap().selection, None);
    }

    #[test]
    fn confirmed_runtime_observations_do_not_change_next_turn_selection() {
        let db = db();
        let t = target("/a", "session");
        let selected = compare_and_set(&db, &t, input("B", None), None).unwrap();
        record_observed(&db, &t, Some("model-from-earlier-run"), Some("high")).unwrap();
        assert_eq!(get_context_from(&db, &t).unwrap(), selected);
        let actual: (String, String) = db.0.lock().query_row(
            "SELECT observed_model,observed_effort FROM session_observations WHERE workspace_path='/a' AND session_id='session'",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(actual, ("model-from-earlier-run".into(), "high".into()));
    }

    #[test]
    fn pending_defaults_are_created_once_and_never_fill_existing_null_effort() {
        let db = db();
        let mut pending = target("/a", "unused");
        pending.session_id = None;
        pending.pending_id = Some("new".into());
        assert_eq!(get_context_from(&db, &pending).unwrap().selection, None);
        compare_and_set(&db, &pending, input("A", None), None).unwrap();
        assert!(compare_and_set(&db, &pending, input("B", Some("high")), None).is_err());
        assert_eq!(get_context_from(&db, &pending).unwrap().selection.unwrap().effort, None);
    }

    #[test]
    fn legacy_missing_effort_is_not_inferred_from_model_or_channel() {
        let db = db();
        legacy(&db);
        db.remember_session_provider("omp", "old", "channel", 1).unwrap();
        db.0.lock().execute("DELETE FROM session_efforts", []).unwrap();
        let t = target("/a", "old");
        assert_eq!(get_context_from(&db, &t).unwrap().selection, None);
        let explicit = compare_and_set(&db, &t, input("A", None), None).unwrap();
        assert_eq!(get_context_from(&db, &t).unwrap(), explicit);
    }

    #[test]
    fn deterministic_legacy_migration_blocks_competing_old_writers() {
        let db = db();
        legacy(&db);
        db.remember_session_provider("omp", "old", "channel", 1).unwrap();
        let saved = get_context_from(&db, &target("/a", "old")).unwrap().selection.unwrap();
        assert_eq!(saved.model_selection, ModelSelection::Native {
            engine_id: "omp".into(), model_id: Some("provider/model".into()), channel_id: Some("channel".into()),
        });
        assert_eq!(saved.effort.as_deref(), Some("high"));
        assert!(db.remember_session_model("omp", "old", "wrong", 2).is_err());
        assert!(db.remember_session_effort("omp", "old", "low", 2).is_err());
        assert!(db.remember_session_provider("omp", "old", "wrong", 2).is_err());
        assert_eq!(get_context_from(&db, &target("/a", "old")).unwrap().selection, Some(saved));
    }
}
