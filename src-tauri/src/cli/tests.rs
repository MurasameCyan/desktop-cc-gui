use super::*;
use serde_json::json;

pub(super) fn profile() -> ExecutionProfile {
    serde_json::from_value(json!({
        "profileKey":"p", "engineId":"codex", "label":"Profile", "group":"Group",
        "protocol":"openai-responses", "baseUrl":"https://example.test/v1", "auth":"bearer",
        "executionTarget":{"kind":"local"}, "targetGrantId":"grant", "credentialScope":"account",
        "credentials":[{"credentialId":"key", "credentialRevision":1,"name":"Primary"}]
    })).unwrap()
}

pub(super) fn publication() -> SourcePublication {
    SourcePublication {
        source_id: "plugin:sample:source".into(), document_path: "registry.json".into(),
        document_version: "document-1".into(), expected_publication_revision: None,
        profiles: vec![profile()], choices: vec![serde_json::from_value(json!({
            "profileKey":"p", "modelKey":"m", "label":"Model", "selector":{"kind":"wire","modelId":"same-model"},
            "templateRef":{"engineId":"codex","modelId":"template","revision":"catalog-1"},
            "tokenPolicy":{"contextWindowTokens":200000},
            "capabilities":{"images":"unknown","tools":"supported","effortLevels":["low","high"]}
        })).unwrap()]
    }
}

pub(super) fn granted_database() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    initialize_database(&conn).unwrap();
    let profile = profile();
    let grant = TargetGrant { grant_id:"grant".into(),source_id:"plugin:sample:source".into(),base_url:profile.base_url,execution_target:profile.execution_target,credentials:profile.credentials };
    conn.execute("INSERT INTO cli_target_grants(grant_id,plugin_id,payload) VALUES (?1,?2,?3)", params![grant.grant_id,"sample",serde_json::to_string(&grant).unwrap()]).unwrap();
    conn
}

#[test]
fn identical_wire_and_local_ids_in_another_source_are_not_overwritten() {
    let mut conn = granted_database();
    let mut first = publication();
    let accepted = persist_publication(&mut conn,"sample",&first).unwrap();
    let mut other = publication();
    other.source_id = "plugin:sample:other".into();
    other.profiles[0].target_grant_id = "other-grant".into();
    let p = &other.profiles[0];
    let grant = TargetGrant {grant_id:p.target_grant_id.clone(),source_id:other.source_id.clone(),base_url:p.base_url.clone(),execution_target:p.execution_target.clone(),credentials:p.credentials.clone()};
    conn.execute("INSERT INTO cli_target_grants(grant_id,plugin_id,payload) VALUES (?1,?2,?3)",params![grant.grant_id,"sample",serde_json::to_string(&grant).unwrap()]).unwrap();
    let other_receipt = persist_publication(&mut conn,"sample",&other).unwrap();
    first.expected_publication_revision = Some(accepted.publication_revision);
    first.choices.clear();
    persist_publication(&mut conn,"sample",&first).unwrap();
    let sources = load_sources(&conn).unwrap();
    let untouched = sources.iter().find(|source| source.source_id == other.source_id).unwrap();
    assert_eq!(untouched, &other_receipt);
    assert!(sources.iter().find(|source|source.source_id == first.source_id).unwrap().choices.is_empty());
}

#[test]
fn revoked_grant_prevents_republication_without_destroying_receipt() {
    let mut conn = granted_database();
    let mut request = publication();
    let accepted = persist_publication(&mut conn,"sample",&request).unwrap();
    request.expected_publication_revision = Some(accepted.publication_revision.clone());
    conn.execute("DELETE FROM cli_target_grants",[]).unwrap();
    assert!(persist_publication(&mut conn,"sample",&request).is_err());
    assert_eq!(load_sources(&conn).unwrap()[0].publication_revision,accepted.publication_revision);
}

#[test]
fn invalid_source_does_not_partially_replace_previous_publication() {
    let mut conn = granted_database();
    let mut first = publication();
    let accepted = persist_publication(&mut conn, "sample", &first).unwrap();
    first.expected_publication_revision = Some(accepted.publication_revision.clone());
    first.profiles.push(profile());
    assert!(persist_publication(&mut conn, "sample", &first).is_err());
    let stored = load_sources(&conn).unwrap();
    assert_eq!(stored[0].publication_revision, accepted.publication_revision);
    assert_eq!(stored[0].profiles.len(), 1);
}

#[test]
fn publication_compare_and_swap_rejects_delayed_writer() {
    let mut conn = granted_database();
    let initial = publication();
    let accepted = persist_publication(&mut conn, "sample", &initial).unwrap();
    let mut newer = initial.clone();
    newer.expected_publication_revision = Some(accepted.publication_revision);
    newer.document_version = "document-2".into();
    let current = persist_publication(&mut conn, "sample", &newer).unwrap();
    assert!(persist_publication(&mut conn, "sample", &newer).is_err());
    assert_eq!(load_sources(&conn).unwrap()[0].publication_revision, current.publication_revision);
}

#[test]
fn routing_identity_is_source_scoped_and_ignores_display_metadata() {
    let first = publication();
    let key = &first.profiles[0].credentials[0];
    let fingerprint = routing_fingerprint(&first.source_id, &first.profiles[0], &first.choices[0], Some(key), Some("low")).unwrap();
    let mut other = first.clone();
    other.source_id = "plugin:sample:other".into();
    assert_ne!(fingerprint, routing_fingerprint(&other.source_id, &other.profiles[0], &other.choices[0], Some(key), Some("low")).unwrap());
    other.source_id = first.source_id;
    other.profiles[0].label = "Renamed".into();
    other.choices[0].label = "Renamed model".into();
    assert_eq!(fingerprint, routing_fingerprint(&other.source_id, &other.profiles[0], &other.choices[0], Some(key), Some("low")).unwrap());
    let mut changed_key = key.clone();
    changed_key.credential_revision += 1;
    assert_ne!(fingerprint, routing_fingerprint(&other.source_id, &other.profiles[0], &other.choices[0], Some(&changed_key), Some("low")).unwrap());
}

#[test]
fn profile_rejects_credentials_in_transport_metadata() {
    let mut source = publication();
    source.profiles[0].base_url = "https://secret@example.test/v1".into();
    assert!(validate_source_shape(&source).is_err());
    source.profiles[0] = profile();
    source.profiles[0].options = Some(serde_json::from_value(json!({"headers":{"AUTHORIZATION":"Bearer secret"}})).unwrap());
    assert!(validate_source_shape(&source).is_err());
    source.profiles[0] = profile();
    source.choices[0].token_policy.auto_compaction_threshold_tokens = Some(200001);
    assert!(validate_source_shape(&source).is_err());
}

#[test]
fn grant_checks_revision_target_and_complete_base_path() {
    let p = profile();
    let grant = TargetGrant { grant_id:"grant".into(),source_id:"plugin:sample:source".into(),base_url:p.base_url.clone(),execution_target:p.execution_target.clone(),credentials:p.credentials.clone() };
    assert!(grants::grant_matches_profile(&grant, "plugin:sample:source", &p));
    let mut changed = p.clone();
    changed.credentials[0].credential_revision += 1;
    assert!(!grants::grant_matches_profile(&grant, "plugin:sample:source", &changed));
    changed = p.clone();
    changed.base_url = "https://example.test/other".into();
    assert!(!grants::grant_matches_profile(&grant, "plugin:sample:source", &changed));
    changed = p;
    changed.execution_target = ExecutionTarget::Wsl { host_id:"host".into(),distro:"Ubuntu".into() };
    assert!(!grants::grant_matches_profile(&grant, "plugin:sample:source", &changed));
}

#[test]
fn credential_dtos_refuse_secret_and_unknown_fields() {
    assert!(serde_json::from_value::<CredentialIdentity>(json!({"credentialId":"key","credentialRevision":1,"name":"Primary","value":"secret"})).is_err());
    assert!(serde_json::from_value::<ExecutionProfile>(json!({"profileKey":"p","env":{"KEY":"secret"}})).is_err());
    let request = RuntimeMaterialRequest { profile_key:"p".into(), r#use:CredentialUseRef {source_id:"plugin:sample:source".into(),credential_id:"key".into(),credential_revision:1,registry_revision:"document-1".into()} };
    let serialized = serde_json::to_string(&request).unwrap();
    assert_eq!(serde_json::from_str::<RuntimeMaterialRequest>(&serialized).unwrap(), request);
}

#[test]
fn incomplete_selection_cannot_be_interpreted_as_native_defaults() {
    let explicit = json!({"modelSelection":{"source":"native","engineId":"codex","modelId":null},"effort":null});
    assert!(serde_json::from_value::<ExecutionSelectionInput>(explicit.clone()).is_ok());
    let mut missing_effort = explicit.clone();
    missing_effort.as_object_mut().unwrap().remove("effort");
    assert!(serde_json::from_value::<ExecutionSelectionInput>(missing_effort).is_err());
    let mut missing_model = explicit;
    missing_model["modelSelection"].as_object_mut().unwrap().remove("modelId");
    assert!(serde_json::from_value::<ExecutionSelectionInput>(missing_model).is_err());
    assert!(serde_json::from_value::<ModelSelection>(json!({"source":"contribution","engineId":"codex","sourceId":"s","profileKey":"p","modelKey":"m"})).is_err());
}
