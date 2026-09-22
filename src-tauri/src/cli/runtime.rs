//! Per-identity ephemeral credential material. It is never a serialization
//! target, and runtime sends only read already-established selection snapshots.
use super::*;
use std::time::Duration;
use tokio::sync::Notify;

pub struct RuntimeMaterial { value: String }
impl RuntimeMaterial {
    pub fn value(&self) -> &str { &self.value }
}
impl Drop for RuntimeMaterial {
    fn drop(&mut self) {
        // Volatile writes prevent dead-store elimination of secret clearing.
        // No reader can exist once the last Arc is dropped.
        unsafe { for byte in self.value.as_bytes_mut() { std::ptr::write_volatile(byte, 0); } }
    }
}

pub(super) struct MaterialIdentity {
    digest: [u8; 32],
    material: Weak<RuntimeMaterial>,
}

fn bind_material(inner: &mut CliInner, request: &RuntimeMaterialRequest, value: String) -> Result<(), String> {
    let incoming = RuntimeMaterial { value };
    let digest: [u8; 32] = Sha256::digest(incoming.value().as_bytes()).into();
    let identity = (request.r#use.source_id.clone(),request.r#use.credential_id.clone(),request.r#use.credential_revision);
    let existing = inner.material_identities.get(&identity);
    if existing.is_some_and(|entry| entry.digest != digest) {
        return Err("credential value changed without a new generation".into());
    }
    let material = existing.and_then(|entry| entry.material.upgrade()).unwrap_or_else(|| Arc::new(incoming));
    inner.material_identities.insert(identity,MaterialIdentity {digest,material:Arc::downgrade(&material)});
    inner.materials.insert(request.clone(),material);
    Ok(())
}

pub struct ResolvedContribution {
    pub source: Arc<PublishedSource>,
    pub profile: ExecutionProfile,
    pub choice: ModelChoiceContribution,
    pub material: Option<Arc<RuntimeMaterial>>,
    pub fingerprint: String,
}

pub(super) struct PendingMaterial { pub notify: Arc<Notify>, waiters: usize }
struct PendingLease<'a> { cli: &'a CliState, request: RuntimeMaterialRequest, notify: Arc<Notify> }
impl PendingLease<'_> {
    fn is_current(&self, inner: &CliInner) -> bool {
        inner.pending.get(&self.request).is_some_and(|pending| Arc::ptr_eq(&pending.notify,&self.notify))
    }
}
impl Drop for PendingLease<'_> {
    fn drop(&mut self) {
        let mut inner = self.cli.inner.lock();
        if !self.is_current(&inner) { return; }
        if let Some(pending) = inner.pending.get_mut(&self.request) {
            pending.waiters = pending.waiters.saturating_sub(1);
            if pending.waiters == 0 { inner.pending.remove(&self.request); }
        }
    }
}

fn resolve_metadata(state: &crate::AppState, target: &SessionExecutionTarget, selection: &ExecutionSelectionInput) -> Result<ResolvedContribution, String> {
    let ModelSelection::Contribution { engine_id, source_id, profile_key, model_key, credential } = &selection.model_selection else { return Err("selection is not a contribution".into()); };
    if engine_id != &target.engine_id { return Err("selection engine does not match session target".into()); }
    validate_target(&target.execution_target)?;
    let mut inner = state.cli.inner.lock();
    refresh_projection(&state.db, &mut inner)?;
    let source = inner.sources.get(source_id).cloned().ok_or("selected contribution source no longer exists")?;
    require_permission(&source.plugin_id, "cli.contributions.write")?;
    let profile = source.profiles.iter().find(|profile| &profile.profile_key == profile_key).ok_or("selected profile no longer exists")?.clone();
    if &profile.engine_id != engine_id || profile.execution_target != target.execution_target { return Err("selected profile does not match engine or execution environment".into()); }
    grants::require_profile_grant(&inner, &source.plugin_id, source_id, &profile)?;
    let choice = source.choices.iter().find(|choice| &choice.profile_key == profile_key && &choice.model_key == model_key).ok_or("selected model choice no longer exists")?.clone();
    match (&profile.auth, credential) {
        (ProfileAuth::None, None) => {},
        (ProfileAuth::None, Some(_)) => return Err("unauthenticated profile cannot select a credential".into()),
        (_, None) => return Err("explicit credential selection is required; defaults are never used for an existing selection".into()),
        (_, Some(credential)) => {
            if !profile.credentials.iter().any(|candidate| candidate.credential_id == credential.credential_id && candidate.credential_revision == credential.credential_revision) {
                return Err("selected credential was removed or its generation changed; select it again explicitly".into());
            }
        },
    }
    match selection.effort.as_deref() {
        Some(effort) if choice.capabilities.effort_levels.iter().any(|supported| supported == effort) => {},
        None if choice.capabilities.effort_levels.is_empty() => {},
        _ => return Err("selected effort is not supported by this model; select an explicit supported effort".into()),
    }
    let request = credential.as_ref().map(|credential| RuntimeMaterialRequest { profile_key:profile_key.clone(), r#use:CredentialUseRef {
        source_id:source_id.clone(), credential_id:credential.credential_id.clone(), credential_revision:credential.credential_revision, registry_revision:source.document_version.clone(),
    } });
    let material = request.as_ref().and_then(|request| inner.materials.get(request).cloned());
    let fingerprint = routing_fingerprint(source_id, &profile, &choice, credential.as_ref(), selection.effort.as_deref())?;
    Ok(ResolvedContribution { source, profile, choice, material, fingerprint })
}

pub fn resolve_contribution(state: &crate::AppState, target: &SessionExecutionTarget, selection: &ExecutionSelectionInput) -> Result<ResolvedContribution, String> {
    let resolved = resolve_metadata(state, target, selection)?;
    if resolved.profile.auth != ProfileAuth::None && resolved.material.is_none() {
        return Err("selected credential material is unavailable; restore it from the desktop plugin or select again".into());
    }
    Ok(resolved)
}

pub fn validate_contribution_metadata(state: &crate::AppState, target: &SessionExecutionTarget, selection: &ExecutionSelectionInput) -> Result<(), String> {
    resolve_metadata(state, target, selection).map(|_| ())
}

pub async fn ensure_selection_material(state: &crate::AppState, target: &SessionExecutionTarget, selection: &ExecutionSelectionInput) -> Result<(), String> {
    let ModelSelection::Contribution { credential, .. } = &selection.model_selection else { return Ok(()); };
    let resolved = resolve_metadata(state, target, selection)?;
    if let Some(credential) = credential {
        let request = RuntimeMaterialRequest { profile_key:resolved.profile.profile_key.clone(), r#use:CredentialUseRef {
            source_id:resolved.source.source_id.clone(), credential_id:credential.credential_id.clone(), credential_revision:credential.credential_revision, registry_revision:resolved.source.document_version.clone(),
        } };
        ensure_material_request(state, &resolved.source.plugin_id, &request).await?;
    }
    // Publication, plugin state and target authorization may change while JS
    // reads its registry. Never accept the old resolution merely because a key arrived.
    resolve_contribution(state, target, selection).map(|_| ())
}

pub(super) fn validate_material_request(inner: &CliInner, plugin_id: &str, request: &RuntimeMaterialRequest) -> Result<(), String> {
    require_permission(plugin_id, "cli.runtime.sensitive")?;
    require_permission(plugin_id, "cli.contributions.write")?;
    let source = inner.sources.get(&request.r#use.source_id).ok_or("unknown credential source")?;
    if source.plugin_id != plugin_id || source.document_version != request.r#use.registry_revision { return Err("credential source or document revision mismatch".into()); }
    let profile = source.profiles.iter().find(|profile| profile.profile_key == request.profile_key).ok_or("unknown credential profile")?;
    grants::require_profile_grant(inner, plugin_id, &source.source_id, profile)?;
    if profile.auth == ProfileAuth::None || !profile.credentials.iter().any(|credential| credential.credential_id == request.r#use.credential_id && credential.credential_revision == request.r#use.credential_revision) {
        return Err("credential identity or generation is not published for this profile".into());
    }
    Ok(())
}

pub(super) async fn ensure_material_request(state: &crate::AppState, plugin_id: &str, request: &RuntimeMaterialRequest) -> Result<Arc<RuntimeMaterial>, String> {
    let (notify, emit) = {
        let mut inner = state.cli.inner.lock();
        refresh_projection(&state.db, &mut inner)?;
        validate_material_request(&inner, plugin_id, request)?;
        if let Some(material) = inner.materials.get(request) { return Ok(Arc::clone(material)); }
        let emit = !inner.pending.contains_key(request);
        let pending = inner.pending.entry(request.clone()).or_insert_with(|| PendingMaterial {notify:Arc::new(Notify::new()),waiters:0});
        pending.waiters += 1;
        (Arc::clone(&pending.notify), emit)
    };
    let lease = PendingLease { cli:&state.cli, request:request.clone(), notify:Arc::clone(&notify) };
    if emit {
        let payload = serde_json::to_string(request).map_err(|_| "encode credential material request")?;
        state.cli.emitter.emit_json("cli://material-requested", &payload);
    }
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut inner = state.cli.inner.lock();
                refresh_projection(&state.db, &mut inner)?;
                validate_material_request(&inner, plugin_id, request)?;
                if !lease.is_current(&inner) { return Err("credential material request was invalidated".into()); }
                if let Some(material) = inner.materials.get(request) { return Ok(Arc::clone(material)); }
            }
            notified.await;
        }
    }).await.map_err(|_| "selected credential material was not supplied by the plugin".to_string())?
}

#[tauri::command]
pub fn plugin_cli_register_runtime_material(state: tauri::State<'_, crate::AppState>, plugin_id: String, mut request: RuntimeMaterialInput) -> Result<(), String> {
    require_permission(&plugin_id, "cli.runtime.sensitive")?;
    request.r#use.source_id = namespace_source_id(&plugin_id, &request.r#use.source_id)?;
    // No secret value, including invalid input, is ever interpolated into errors.
    if request.value.is_empty() || request.value.len() > 16 * 1024 || request.value.chars().any(char::is_control) { return Err("invalid credential material".into()); }
    let identity = RuntimeMaterialRequest { profile_key:request.profile_key, r#use:request.r#use };
    // Session DB must be read before taking cli.inner: session persistence may
    // resolve the CLI first, never nest its lock under a callback into sessions.
    let bound = crate::session_selection::credential_uses(&state, &identity.r#use.source_id)?;
    let mut inner = state.cli.inner.lock();
    refresh_projection(&state.db, &mut inner)?;
    validate_material_request(&inner, &plugin_id, &identity)?;
    if !inner.pending.contains_key(&identity) && !bound.contains(&identity) { return Err("credential is neither selected nor currently requested".into()); }
    bind_material(&mut inner,&identity,request.value)?;
    if let Some(pending) = inner.pending.get(&identity) { pending.notify.notify_waiters(); }
    Ok(())
}

#[tauri::command]
pub fn plugin_cli_get_credential_uses(state: tauri::State<'_, crate::AppState>, plugin_id: String, source_id: String) -> Result<Vec<RuntimeMaterialRequest>, String> {
    require_permission(&plugin_id, "cli.runtime.sensitive")?;
    let source_id = namespace_source_id(&plugin_id, &source_id)?;
    let mut uses = crate::session_selection::credential_uses(&state, &source_id)?;
    let mut inner = state.cli.inner.lock();
    refresh_projection(&state.db, &mut inner)?;
    uses.extend(inner.pending.keys().filter(|request| request.r#use.source_id == source_id).cloned());
    uses.retain(|request| validate_material_request(&inner, &plugin_id, request).is_ok());
    let mut unique = HashSet::new();
    uses.retain(|request| unique.insert(request.clone()));
    uses.sort_by(|left, right| (&left.profile_key,&left.r#use.credential_id,left.r#use.credential_revision).cmp(&(&right.profile_key,&right.r#use.credential_id,right.r#use.credential_revision)));
    Ok(uses)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(profile: &str, document: &str) -> RuntimeMaterialRequest {
        RuntimeMaterialRequest {profile_key:profile.into(),r#use:CredentialUseRef {
            source_id:"plugin:sample:source".into(),credential_id:"key".into(),credential_revision:1,registry_revision:document.into(),
        }}
    }

    #[test]
    fn a_key_generation_cannot_change_bytes_across_profiles_or_documents() {
        let mut inner = CliInner::default();
        let first = request("a","document-1");
        bind_material(&mut inner,&first,"original-secret".into()).unwrap();
        let second = request("b","document-1");
        assert!(bind_material(&mut inner,&second,"other-secret".into()).is_err());
        bind_material(&mut inner,&second,"original-secret".into()).unwrap();
        let running_snapshot = inner.materials[&first].clone();
        assert!(Arc::ptr_eq(&running_snapshot,&inner.materials[&second]));
        inner.materials.clear();
        let mut next = request("a","document-2");
        assert!(bind_material(&mut inner,&next,"other-secret".into()).is_err());
        next.r#use.credential_revision = 2;
        bind_material(&mut inner,&next,"other-secret".into()).unwrap();
        assert_eq!(running_snapshot.value(),"original-secret");
        assert_eq!(inner.materials[&next].value(),"other-secret");
    }

    #[test]
    fn revoking_one_profile_preserves_other_profile_authority_and_material() {
        let mut conn = crate::cli::tests::granted_database();
        let mut publication = crate::cli::tests::publication();
        let first_profile = publication.profiles[0].clone();
        let mut second_profile = first_profile.clone();
        second_profile.profile_key = "second".into();
        second_profile.target_grant_id = "second-grant".into();
        let second_grant = TargetGrant {grant_id:second_profile.target_grant_id.clone(),source_id:publication.source_id.clone(),base_url:second_profile.base_url.clone(),execution_target:second_profile.execution_target.clone(),credentials:second_profile.credentials.clone()};
        conn.execute("INSERT INTO cli_target_grants(grant_id,plugin_id,payload) VALUES (?1,?2,?3)",params![second_grant.grant_id,"sample",serde_json::to_string(&second_grant).unwrap()]).unwrap();
        publication.profiles.push(second_profile.clone());
        let mut second_choice = publication.choices[0].clone();
        second_choice.profile_key = second_profile.profile_key.clone();
        publication.choices.push(second_choice);
        let source = persist_publication(&mut conn,"sample",&publication).unwrap();
        let mut inner = CliInner::default();
        inner.grants = grants::load_grants(&conn).unwrap();
        inner.sources.insert(source.source_id.clone(),Arc::new(source));
        let first = request(&first_profile.profile_key,"document-1");
        let second = request(&second_profile.profile_key,"document-1");
        bind_material(&mut inner,&first,"shared-secret".into()).unwrap();
        bind_material(&mut inner,&second,"shared-secret".into()).unwrap();
        let running_first = inner.materials[&first].clone();
        inner.pending.insert(second.clone(),PendingMaterial {notify:Arc::new(Notify::new()),waiters:1});
        grants::revoke_grant(&conn,&mut inner,"sample",&first_profile.target_grant_id).unwrap();
        assert!(grants::check_profile_grant(&inner,"sample",&publication.source_id,&first_profile).is_err());
        grants::check_profile_grant(&inner,"sample",&publication.source_id,&second_profile).unwrap();
        assert!(!inner.materials.contains_key(&first));
        assert_eq!(inner.materials[&second].value(),"shared-secret");
        assert!(inner.pending.contains_key(&second));
        assert_eq!(running_first.value(),"shared-secret");
    }

    struct NoEvents;
    impl Emit for NoEvents { fn emit_json(&self,_:&str,_:&str) {} }

    #[test]
    fn dropping_an_invalidated_waiter_cannot_cancel_its_replacement() {
        let db = Arc::new(crate::db::Db(Mutex::new(Connection::open_in_memory().unwrap())));
        let cli = CliState::new(db,Arc::new(NoEvents)).unwrap();
        let request = request("a","document-1");
        let old = Arc::new(Notify::new());
        let replacement = Arc::new(Notify::new());
        let lease = PendingLease {cli:&cli,request:request.clone(),notify:old};
        cli.inner.lock().pending.insert(request.clone(),PendingMaterial {notify:replacement.clone(),waiters:1});
        assert!(!lease.is_current(&cli.inner.lock()));
        drop(lease);
        let inner = cli.inner.lock();
        assert_eq!(inner.pending[&request].waiters,1);
        assert!(Arc::ptr_eq(&inner.pending[&request].notify,&replacement));
    }
}
