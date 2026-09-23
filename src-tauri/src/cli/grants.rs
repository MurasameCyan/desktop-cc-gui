//! Desktop-confirmed, revocable destinations. No static network permission can
//! substitute for a grant binding the complete URL, target and key generation.
use super::*;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(super) struct OwnedGrant { pub plugin_id: String, pub grant: TargetGrant }

pub(super) fn load_grants(conn: &Connection) -> Result<HashMap<String, OwnedGrant>, String> {
    let mut query = conn.prepare("SELECT grant_id,plugin_id,payload FROM cli_target_grants").map_err(|_| "read target grants")?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?))).map_err(|_| "read target grants")?;
    rows.map(|row| {
        let (id, plugin_id, payload) = row.map_err(|_| "read target grants")?;
        let grant = serde_json::from_str(&payload).map_err(|_| "invalid target grant")?;
        Ok((id, OwnedGrant { plugin_id, grant }))
    }).collect()
}

pub(crate) fn grant_matches_profile(grant: &TargetGrant, source_id: &str, profile: &ExecutionProfile) -> bool {
    grant.source_id == source_id && grant.base_url == profile.base_url && grant.execution_target == profile.execution_target
        && profile.credentials.iter().all(|credential| grant.credentials.iter().any(|allowed|
            allowed.credential_id == credential.credential_id && allowed.credential_revision == credential.credential_revision))
}

pub(super) fn require_profile_grant(inner: &CliInner, plugin_id: &str, source_id: &str, profile: &ExecutionProfile) -> Result<(), String> {
    require_permission(plugin_id, "network.targets.request")?;
    if profile.auth != ProfileAuth::None { require_permission(plugin_id, "cli.runtime.sensitive")?; }
    check_profile_grant(inner, plugin_id, source_id, profile)
}

pub(super) fn check_profile_grant(inner: &CliInner, plugin_id: &str, source_id: &str, profile: &ExecutionProfile) -> Result<(), String> {
    let grant = inner.grants.get(&profile.target_grant_id).ok_or("target authorization is missing or revoked")?;
    if grant.plugin_id != plugin_id || !grant_matches_profile(&grant.grant, source_id, profile) {
        return Err("target authorization does not match this profile or credential generation".into());
    }
    Ok(())
}

/// The callback is owned by the native dialog, never a plugin-supplied boolean.
pub async fn confirm_desktop(app: &tauri::AppHandle, title: &str, message: &str) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().message(message).title(title).kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel).show(move |accepted| { let _ = sender.send(accepted); });
    match receiver.await {
        Ok(true) => Ok(()),
        _ => Err("desktop confirmation was cancelled".into()),
    }
}

#[tauri::command]
pub async fn plugin_cli_request_target_grant(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, plugin_id: String, mut request: TargetGrantRequest) -> Result<TargetGrant, String> {
    require_permission(&plugin_id, "network.targets.request")?;
    request.source_id = namespace_source_id(&plugin_id, &request.source_id)?;
    let url = validate_base_url(&request.base_url)?;
    validate_target(&request.execution_target)?;
    validate_credentials(&request.credentials)?;
    validate_text(&request.purpose, 1024)?;
    if !request.credentials.is_empty() { require_permission(&plugin_id, "cli.runtime.sensitive")?; }
    let generation = *state.cli.inner.lock().generations.get(&plugin_id).unwrap_or(&0);
    let target = match &request.execution_target {
        ExecutionTarget::Local => "本机".to_string(),
        ExecutionTarget::Wsl { host_id, distro } => format!("WSL 主机 {host_id}，发行版 {distro}"),
    };
    let identities = if request.credentials.is_empty() { "无（不使用认证）".into() } else {
        request.credentials.iter().map(|key| format!("{} [{}]，第 {} 代", key.name, key.credential_id, key.credential_revision)).collect::<Vec<_>>().join("\n")
    };
    let message = format!("插件：{plugin_id}\n来源：{}\n完整目标地址：{}\n源站：{}\n执行环境：{target}\n凭据身份：\n{identities}\n\n插件声明的用途：{}\n\n是否允许此插件仅在该执行环境中，将这些凭据发送到此目标？此授权可以撤销。", request.source_id, request.base_url, url.origin().ascii_serialization(), request.purpose);
    confirm_desktop(&app, "授权执行目标", &message).await?;
    require_permission(&plugin_id, "network.targets.request")?;
    if !request.credentials.is_empty() { require_permission(&plugin_id, "cli.runtime.sensitive")?; }
    let grant = TargetGrant { grant_id:uuid::Uuid::new_v4().to_string(),source_id:request.source_id,base_url:request.base_url,execution_target:request.execution_target,credentials:request.credentials };
    {
        let mut inner = state.cli.inner.lock();
        if generation != *inner.generations.get(&plugin_id).unwrap_or(&0) { return Err("plugin authority changed while confirmation was open".into()); }
        let payload = serde_json::to_string(&grant).map_err(|_| "encode target grant")?;
        state.db.0.lock().execute("INSERT INTO cli_target_grants (grant_id,plugin_id,payload) VALUES (?1,?2,?3)", params![grant.grant_id,plugin_id,payload]).map_err(|_| "save target grant")?;
        inner.grants.insert(grant.grant_id.clone(), OwnedGrant { plugin_id, grant:grant.clone() });
    }
    state.cli.emit_change(&CliChange { source_id:grant.source_id.clone(),publication_revision:state.cli.get_source(&grant.source_id)?.map(|source| source.publication_revision) });
    Ok(grant)
}

#[tauri::command]
pub fn plugin_cli_list_target_grants(state: tauri::State<'_, crate::AppState>, plugin_id: String) -> Result<Vec<TargetGrant>, String> {
    require_permission(&plugin_id, "network.targets.request")?;
    let mut inner = state.cli.inner.lock();
    refresh_projection(&state.db, &mut inner)?;
    let mut grants: Vec<_> = inner.grants.values().filter(|grant| grant.plugin_id == plugin_id).map(|grant| grant.grant.clone()).collect();
    grants.sort_by(|left, right| left.grant_id.cmp(&right.grant_id));
    Ok(grants)
}

pub(super) fn revoke_grant(conn: &Connection, inner: &mut CliInner, plugin_id: &str, grant_id: &str) -> Result<CliChange, String> {
    let grant = inner.grants.get(grant_id).ok_or("unknown target authorization")?;
    if grant.plugin_id != plugin_id { return Err("target authorization belongs to another plugin".into()); }
    let source_id = grant.grant.source_id.clone();
    let affected: HashSet<String> = inner.sources.get(&source_id).into_iter()
        .flat_map(|source| source.profiles.iter()).filter(|profile| profile.target_grant_id == grant_id)
        .map(|profile| profile.profile_key.clone()).collect();
    conn.execute("DELETE FROM cli_target_grants WHERE grant_id=?1 AND plugin_id=?2", params![grant_id,plugin_id]).map_err(|_| "revoke target authorization")?;
    inner.grants.remove(grant_id);
    inner.materials.retain(|request, _| request.r#use.source_id != source_id || !affected.contains(&request.profile_key));
    inner.pending.retain(|request, pending| {
        if request.r#use.source_id == source_id && affected.contains(&request.profile_key) {
            pending.notify.notify_waiters();
            false
        } else { true }
    });
    Ok(CliChange { publication_revision:inner.sources.get(&source_id).map(|source| source.publication_revision.clone()),source_id })
}

#[tauri::command]
pub fn plugin_cli_revoke_target_grant(state: tauri::State<'_, crate::AppState>, plugin_id: String, grant_id: String) -> Result<(), String> {
    require_permission(&plugin_id, "network.targets.request")?;
    let change = {
        let mut inner = state.cli.inner.lock();
        refresh_projection(&state.db, &mut inner)?;
        revoke_grant(&state.db.0.lock(), &mut inner, &plugin_id, &grant_id)?
    };
    state.cli.emit_change(&change);
    Ok(())
}
