//! Read-only catalog discovery. Network destinations come from a published,
//! authorized profile; callers cannot smuggle a URL or secret into a request.
use super::*;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_DISCOVERY_BYTES: usize = 1024 * 1024;
const MAX_DISCOVERED_MODELS: usize = 2048;

fn unknown_capabilities() -> ModelCapabilities {
    ModelCapabilities { images:CapabilitySupport::Unknown, tools:CapabilitySupport::Unknown, effort_levels:Vec::new() }
}
fn result(request: &ModelDiscoveryRequest, status: DiscoveryStatus, models: Vec<DiscoveredModel>, error: Option<&str>) -> ModelDiscoveryResult {
    ModelDiscoveryResult { source:request.source,execution_target:request.execution_target.clone(),observed_at:SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,models,status,error:error.map(str::to_string) }
}

fn model_list_url(profile: &ExecutionProfile) -> Result<reqwest::Url, String> {
    let mut url = validate_base_url(&profile.base_url)?;
    // Never search parent paths/origins: the grant covers this exact base URL.
    let base = url.path().trim_end_matches('/');
    let path = if profile.protocol == CliProtocol::Gemini {
        if base.ends_with("/v1beta") || base.ends_with("/v1") { format!("{base}/models") } else { format!("{base}/v1beta/models") }
    } else if base.ends_with("/v1") || base.ends_with("/v1beta") { format!("{base}/models") } else { format!("{base}/v1/models") };
    url.set_path(&path);
    Ok(url)
}

async fn discover_local(profile: &ExecutionProfile, material: Option<&RuntimeMaterial>) -> Result<Vec<u8>, &'static str> {
    let url = model_list_url(profile).map_err(|_| "invalid authorized endpoint")?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(15))
        .build().map_err(|_| "could not initialize model discovery")?;
    let mut request = client.get(url);
    if let Some(headers) = profile.options.as_ref().and_then(|options| options.headers.as_ref()) {
        for (name, value) in headers { request = request.header(name, value); }
    }
    match profile.auth {
        ProfileAuth::None => {},
        ProfileAuth::Bearer => { request = request.bearer_auth(material.ok_or("credential material is unavailable")?.value()); },
        ProfileAuth::ApiKey => {
            let name = if profile.protocol == CliProtocol::Gemini { "x-goog-api-key" } else { "x-api-key" };
            request = request.header(name, material.ok_or("credential material is unavailable")?.value());
        },
    }
    if profile.protocol == CliProtocol::AnthropicMessages { request = request.header("anthropic-version", "2023-06-01"); }
    let mut response = request.send().await.map_err(|_| "authorized model discovery request failed")?;
    if response.status().is_redirection() { return Err("model discovery redirects are not authorized"); }
    if !response.status().is_success() { return Err("model discovery endpoint returned an unsuccessful HTTP status"); }
    if response.content_length().is_some_and(|size| size > MAX_DISCOVERY_BYTES as u64) { return Err("model discovery response is too large"); }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "failed to read model discovery response")? {
        if chunk.len() > MAX_DISCOVERY_BYTES - body.len() { return Err("model discovery response is too large"); }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn discover_wsl(state: &crate::AppState, profile: &ExecutionProfile, material: Option<&RuntimeMaterial>) -> Result<Vec<u8>, &'static str> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use std::process::Stdio;
    // Static code goes in argv; all destination and credential bytes travel
    // only over stdin, never a command argument or a remote staging file.
    const PROBE: &str = r#"import json,sys,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
try:
 payload=json.load(sys.stdin)
 req=urllib.request.Request(payload['url'],headers=payload['headers'],method='GET')
 with urllib.request.build_opener(NoRedirect()).open(req,timeout=15) as response:
  if response.status != 200: sys.exit(2)
  data=response.read(1048577)
  if len(data)>1048576: sys.exit(3)
  sys.stdout.buffer.write(data)
except Exception:
 sys.exit(1)
"#;
    let transport = crate::engine::wsl_transport::transport_for_execution_target(&state.db, &profile.execution_target).map_err(|_| "authorized WSL transport is unavailable")?;
    let mut headers = profile.options.as_ref().and_then(|options| options.headers.clone()).unwrap_or_default();
    match profile.auth {
        ProfileAuth::None => {},
        ProfileAuth::Bearer => { headers.insert("Authorization".into(), format!("Bearer {}",material.ok_or("credential material is unavailable")?.value())); },
        ProfileAuth::ApiKey => { headers.insert(if profile.protocol == CliProtocol::Gemini { "x-goog-api-key" } else { "x-api-key" }.into(),material.ok_or("credential material is unavailable")?.value().to_string()); },
    }
    if profile.protocol == CliProtocol::AnthropicMessages { headers.insert("anthropic-version".into(),"2023-06-01".into()); }
    let payload = serde_json::to_vec(&serde_json::json!({"url":model_list_url(profile).map_err(|_| "invalid authorized endpoint")?.as_str(),"headers":headers})).map_err(|_| "encode discovery request")?;
    let mut command = crate::engine::wsl_transport::python_command(&transport, PROBE).map_err(|_| "authorized WSL transport is unavailable")?;
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| "could not start authorized WSL discovery")?;
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut stdin = child.stdin.take().ok_or("WSL discovery input is unavailable")?;
        stdin.write_all(&payload).await.map_err(|_| "WSL discovery transport failed")?;
        stdin.shutdown().await.map_err(|_| "WSL discovery transport failed")?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or("WSL discovery output is unavailable")?;
        let mut body = Vec::new();
        stdout.take(MAX_DISCOVERY_BYTES as u64 + 1).read_to_end(&mut body).await.map_err(|_| "WSL discovery transport failed")?;
        if body.len() > MAX_DISCOVERY_BYTES { return Err("model discovery response is too large"); }
        if !child.wait().await.map_err(|_| "WSL discovery transport failed")?.success() { return Err("authorized WSL model discovery failed"); }
        Ok(body)
    }).await.map_err(|_| "authorized WSL model discovery timed out")?
}

fn endpoint_models(body: &[u8], profile: &ExecutionProfile, secret: Option<&str>) -> Result<(Vec<DiscoveredModel>, bool), &'static str> {
    let mut value: serde_json::Value = serde_json::from_slice(body).map_err(|_| "model discovery endpoint did not return valid JSON")?;
    let mut partial = value.get("has_more").and_then(serde_json::Value::as_bool) == Some(true)
        || value.get("nextPageToken").and_then(serde_json::Value::as_str).is_some_and(|token| !token.is_empty());
    let entries = if value.get("data").is_some_and(serde_json::Value::is_array) {
        value.get_mut("data").and_then(serde_json::Value::as_array_mut)
    } else if value.is_array() {
        value.as_array_mut()
    } else {
        value.get_mut("models").and_then(serde_json::Value::as_array_mut)
    }.ok_or("model discovery response has no supported model list")?;
    // The shared parser deduplicates linearly. Cap raw entries BEFORE calling
    // it, so a bounded HTTP body cannot still trigger unbounded quadratic work.
    partial |= entries.len() > MAX_DISCOVERED_MODELS;
    entries.truncate(MAX_DISCOVERED_MODELS);
    if profile.protocol == CliProtocol::Gemini {
        for model in entries {
            if let Some(name) = model.get("name").and_then(serde_json::Value::as_str).map(str::to_string) {
                model["id"] = serde_json::Value::String(name.strip_prefix("models/").unwrap_or(&name).to_string());
            }
        }
    }
    let mut ids = crate::provider_models::extract_model_ids(&value);
    // A malicious endpoint can reflect credentials into an apparent model ID.
    // Never return either the actual material or response diagnostics verbatim.
    ids.retain(|id| id.len() <= 512 && !id.chars().any(char::is_control) && !id.starts_with('-') && secret.map_or(true, |key| !id.contains(key)));
    Ok((ids.into_iter().map(|model_id| DiscoveredModel {
        model_id,label:None,protocol:Some(profile.protocol),capabilities:unknown_capabilities(),token_policy:TokenPolicy::default(),template_ref:None,evidence:ModelEvidence::Endpoint,
    }).collect(), partial))
}

#[tauri::command]
pub async fn plugin_cli_list_models(state: tauri::State<'_, crate::AppState>, plugin_id: String, mut request: ModelDiscoveryRequest) -> Result<ModelDiscoveryResult, String> {
    require_permission(&plugin_id, "cli.read")?;
    validate_target(&request.execution_target)?;
    if !matches!(request.engine_id.as_str(), "claude"|"codex"|"kimi"|"grok"|"opencode"|"pi"|"omp"|"dsh"|"agy"|"qoder"|"qoder-cn") { return Err("unknown engine".into()); }
    if request.source == DiscoverySource::Official {
        if request.profile_key.is_some() || request.source_id.is_some() || request.target_grant_id.is_some() || request.credential_use.is_some() || request.protocol.is_some() { return Err("official discovery does not accept endpoint or credential fields".into()); }
        let catalog = match tokio::time::timeout(Duration::from_secs(30), crate::engine::models::catalog_for_execution_target(&state, &request.engine_id, &request.execution_target)).await {
            Ok(Ok(catalog)) => catalog,
            _ => return Ok(result(&request, DiscoveryStatus::Failed, Vec::new(), Some("CLI catalog discovery failed"))),
        };
        require_permission(&plugin_id, "cli.read")?;
        let mut models = Vec::new();
        let truncated = catalog.models.len() > MAX_DISCOVERED_MODELS;
        for model in catalog.models.into_iter().take(MAX_DISCOVERED_MODELS) {
            if model.id.len() > 512 || model.id.chars().any(char::is_control) { continue; }
            let token_policy = TokenPolicy {context_window_tokens:model.context_window,..TokenPolicy::default()};
            let revision = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&request.engine_id,&model.id,&token_policy)).map_err(|_| "encode official template")?));
            models.push(DiscoveredModel { template_ref:Some(OfficialTemplateRef { engine_id:request.engine_id.clone(),model_id:model.id.clone(),revision }), model_id:model.id,label:model.name,protocol:None,capabilities:unknown_capabilities(),token_policy,evidence:ModelEvidence::Official });
        }
        let status = if models.is_empty() { DiscoveryStatus::Unsupported } else if truncated { DiscoveryStatus::Partial } else { DiscoveryStatus::Complete };
        return Ok(result(&request,status,models,None));
    }
    require_permission(&plugin_id, "network.targets.request")?;
    let source_id = namespace_source_id(&plugin_id, request.source_id.as_deref().ok_or("endpoint discovery requires a source")?)?;
    request.source_id = Some(source_id.clone());
    let profile_key = request.profile_key.as_deref().ok_or("endpoint discovery requires a profile")?;
    let (source, profile) = {
        let mut inner = state.cli.inner.lock();
        refresh_projection(&state.db, &mut inner)?;
        let source = inner.sources.get(&source_id).cloned().ok_or("unknown discovery source")?;
        if source.plugin_id != plugin_id { return Err("discovery source belongs to another plugin".into()); }
        require_permission(&plugin_id, "cli.contributions.write")?;
        let profile = source.profiles.iter().find(|profile| profile.profile_key == profile_key).ok_or("unknown discovery profile")?.clone();
        grants::require_profile_grant(&inner,&plugin_id,&source_id,&profile)?;
        if profile.engine_id != request.engine_id || profile.execution_target != request.execution_target || request.target_grant_id.as_deref() != Some(profile.target_grant_id.as_str()) || request.protocol != Some(profile.protocol) { return Err("discovery request does not match the authorized profile".into()); }
        (source,profile)
    };
    let material = if profile.auth == ProfileAuth::None {
        if request.credential_use.is_some() { return Err("unauthenticated discovery must not select a credential".into()); }
        None
    } else {
        let mut use_ref = request.credential_use.clone().ok_or("discovery requires an explicit credential identity")?;
        use_ref.source_id = namespace_source_id(&plugin_id,&use_ref.source_id)?;
        if use_ref.source_id != source_id { return Err("discovery credential source mismatch".into()); }
        Some(runtime::ensure_material_request(&state,&plugin_id,&RuntimeMaterialRequest { profile_key:profile.profile_key.clone(),r#use:use_ref }).await?)
    };
    let body = match &request.execution_target {
        ExecutionTarget::Local => discover_local(&profile,material.as_deref()).await,
        ExecutionTarget::Wsl { .. } => discover_wsl(&state,&profile,material.as_deref()).await,
    };
    // Revocation or publication change during a probe invalidates its result.
    {
        let mut inner = state.cli.inner.lock();
        refresh_projection(&state.db,&mut inner)?;
        require_permission(&plugin_id,"cli.read")?;
        grants::require_profile_grant(&inner,&plugin_id,&source_id,&profile)?;
        if inner.sources.get(&source_id).map_or(true, |current| current.publication_revision != source.publication_revision) { return Err("discovery source changed while the request was running".into()); }
    }
    match body.and_then(|body| endpoint_models(&body,&profile,material.as_deref().map(RuntimeMaterial::value))) {
        Ok((models,partial)) => Ok(result(&request,if partial { DiscoveryStatus::Partial } else { DiscoveryStatus::Complete },models,None)),
        Err(error) => Ok(result(&request,DiscoveryStatus::Failed,Vec::new(),Some(error))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorized_url_never_probes_parent_origin() {
        let profile: ExecutionProfile = serde_json::from_value(serde_json::json!({"profileKey":"p","engineId":"codex","label":"p","group":"p","protocol":"openai-responses","baseUrl":"https://example.test/account/v1","auth":"none","executionTarget":{"kind":"local"},"targetGrantId":"g","credentialScope":"s","credentials":[]})).unwrap();
        assert_eq!(model_list_url(&profile).unwrap().as_str(),"https://example.test/account/v1/models");
    }

    #[test]
    fn endpoint_cannot_reflect_credentials_into_discovery_receipts() {
        let profile = crate::cli::tests::profile();
        let body = br#"{"data":[{"id":"credential-secret"},{"id":"prefix-credential-secret"},{"id":"safe-model"}]}"#;
        let (models, _) = endpoint_models(body,&profile,Some("credential-secret")).unwrap();
        assert_eq!(models.iter().map(|model|model.model_id.as_str()).collect::<Vec<_>>(),vec!["safe-model"]);
        assert!(!serde_json::to_string(&models).unwrap().contains("credential-secret"));
        assert_eq!(endpoint_models(br#"{"error":"credential-secret"}"#,&profile,Some("credential-secret")).unwrap_err(),"model discovery response has no supported model list");
    }

    #[test]
    fn paginated_endpoint_results_are_not_reported_as_complete() {
        let mut profile = crate::cli::tests::profile();
        let (models, partial) = endpoint_models(br#"{"data":[{"id":"first-page-model"}],"has_more":true}"#,&profile,None).unwrap();
        assert_eq!(models[0].model_id,"first-page-model");
        assert!(partial);
        profile.protocol = CliProtocol::Gemini;
        let (models, partial) = endpoint_models(br#"{"models":[{"name":"models/gemini-model"}],"nextPageToken":"next-page"}"#,&profile,None).unwrap();
        assert_eq!(models[0].model_id,"gemini-model");
        assert!(partial);
    }
}
