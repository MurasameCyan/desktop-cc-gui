//! Per-turn execution-profile adapters. Runtime credentials never become public DTOs.

use super::{BuiltCommand, SendRequest};
use crate::cli::{ResolvedContribution, types::{CapabilitySupport, CliProtocol, ExecutionTarget, ProfileAuth, SessionExecutionTarget}};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(super) const KEY_ENV: &str = "CCGUI_PROVIDER_KEY";
const AUTH_KEYS: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT_ID",
    "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME", "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_MAX_CONTEXT_SIZE", "KIMI_MODEL_CAPABILITIES", "KIMI_MODEL_THINKING_EFFORT",
    "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_API_KEY", "GROK_MODEL", "GROK_MODELS_BASE_URL",
    "GROK_CONFIG", "GROK_CONFIG_PATH", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME",
    "CCGUI_PROVIDER_KEY", "CCGUI_PROVIDER_PROFILE", "CCGUI_CODEX_API_KEY",
];

/// Explicit removals also cross WSL. On Windows env names are case-insensitive;
/// remove spellings inherited from either the launcher or the native adapter.
pub(super) fn clear_auth(command: &mut tokio::process::Command) {
    let aliases: Vec<_> = std::env::vars_os().map(|(k, _)| k)
        .chain(command.as_std().get_envs().map(|(k, _)| k.to_os_string()))
        .filter(|key| AUTH_KEYS.iter().any(|known| key.to_string_lossy().eq_ignore_ascii_case(known)))
        .collect();
    for key in aliases { command.env_remove(key); }
    for key in AUTH_KEYS { command.env_remove(key); }
}

pub(super) fn validate_target(state: &crate::AppState, target: &SessionExecutionTarget) -> Result<(), String> {
    let raw = super::wsl_transport::workspace_meta_json(&state.db, &target.workspace_path);
    let meta: Option<Value> = raw.as_deref().map(serde_json::from_str).transpose().map_err(|_| "Invalid workspace metadata")?;
    let wsl = meta.as_ref().and_then(|meta| meta.get("wsl"));
    match (&target.execution_target, wsl) {
        (ExecutionTarget::Local, None) => Ok(()),
        (ExecutionTarget::Wsl { host_id, distro }, Some(wsl))
            if wsl.get("hostId").and_then(Value::as_str) == Some(host_id.as_str())
                && wsl.get("distro").and_then(Value::as_str) == Some(distro.as_str())
                && meta.as_ref().and_then(super::wsl_transport::from_workspace_meta).is_some() => Ok(()),
        _ => Err("Execution target no longer matches this workspace; select the target again".into()),
    }
}

pub(super) fn provider_name(resolved: &ResolvedContribution) -> String {
    format!("ccgui-{}", resolved.fingerprint)
}

pub(super) fn validate_request(engine: &str, req: &SendRequest) -> Result<(), String> {
    let Some(resolved) = &req.execution else { return Ok(()); };
    if resolved.profile.engine_id != engine { return Err("Execution profile engine mismatch".into()); }
    validate_profile_choice(&resolved.profile, &resolved.choice)?;
    if !req.images.is_empty() && resolved.choice.capabilities.images != CapabilitySupport::Supported { return Err("The selected model has no confirmed image capability".into()); }
    if req.effort.as_ref().is_some_and(|effort| !resolved.choice.capabilities.effort_levels.contains(effort)) { return Err("The selected model does not support the requested effort".into()); }
    if resolved.profile.auth != ProfileAuth::None && resolved.material.is_none() { return Err("Credential material is unavailable".into()); }
    if req.prompt.trim() == "/compact" && !matches!(engine, "claude" | "opencode" | "pi" | "omp") { return Err(format!("{engine} does not expose native compaction through this transport")); }
    if matches!(resolved.profile.execution_target, ExecutionTarget::Wsl { .. }) {
        if engine == "grok" || engine == "opencode" { return Err(format!("{engine} managed profiles currently require local execution")); }
        if engine == "kimi" && req.effort.as_deref().is_some_and(|effort| !matches!(effort, "on" | "off")) { return Err("Kimi remote transport only exposes on/off thinking".into()); }
    }
    Ok(())
}

pub(crate) fn validate_profile_choice(profile: &crate::cli::types::ExecutionProfile, choice: &crate::cli::types::ModelChoiceContribution) -> Result<(), String> {
    let engine = profile.engine_id.as_str();
    if !matches!(engine, "claude" | "codex" | "kimi" | "grok" | "opencode" | "pi" | "omp") { return Err(format!("{engine} supports native configuration only")); }
    let protocol_ok = match engine {
        "claude" => profile.protocol == CliProtocol::AnthropicMessages,
        "codex" => profile.protocol == CliProtocol::OpenaiResponses,
        "grok" => profile.protocol != CliProtocol::Gemini,
        _ => true,
    };
    if !protocol_ok { return Err(format!("{engine} does not support this profile protocol")); }
    let policy = &choice.token_policy;
    if engine == "codex" && policy.max_output_tokens.is_some() { return Err("Codex does not expose a max output token override".into()); }
    if engine == "claude" && policy.context_window_tokens.is_some() { return Err("Claude cannot override its model context window".into()); }
    if matches!(engine, "claude" | "grok" | "pi") && policy.auto_compaction_threshold_tokens.is_some() { return Err(format!("{engine} cannot set an exact auto-compaction token threshold")); }
    if engine == "kimi" && policy.max_output_tokens.is_some() { return Err("Kimi does not expose this provider's max output token override".into()); }
    if engine == "kimi" && policy.context_window_tokens.is_none() { return Err("Kimi requires an explicit model context window".into()); }
    if matches!(engine, "pi" | "omp" | "opencode") && (policy.context_window_tokens.is_none() || policy.max_output_tokens.is_none()) { return Err(format!("{engine} requires explicit context and output token limits")); }
    if engine == "opencode" {
        let substitution = |value: &str| value.contains("{env:") || value.contains("{file:") || value.contains("${");
        if [profile.base_url.as_str(), choice.selector.model_id(), choice.label.as_str()].iter().any(|value|substitution(value))
            || profile.options.as_ref().and_then(|o|o.headers.as_ref()).is_some_and(|headers|headers.iter().any(|(key,value)|substitution(key)||substitution(value)))
            || choice.capabilities.effort_levels.iter().any(|effort|substitution(effort)) {
            return Err("OpenCode profile values may not contain loader substitutions".into());
        }
    }
    if let Some(options) = &profile.options {
        if options.always_thinking_enabled.is_some() && engine != "claude" { return Err("alwaysThinkingEnabled is only supported by Claude".into()); }
        if options.service_tier.is_some() && engine != "codex" && !(engine == "omp" && matches!(profile.protocol, CliProtocol::OpenaiResponses | CliProtocol::OpenaiChat)) { return Err("This engine/protocol has no profile-scoped service tier override".into()); }
    }
    let auth_ok = match engine {
        "claude" => profile.auth != ProfileAuth::None,
        "grok" => profile.auth != ProfileAuth::None,
        "codex" => profile.auth != ProfileAuth::ApiKey,
        "pi" | "omp" | "kimi" => profile.auth != ProfileAuth::None && (profile.auth == ProfileAuth::Bearer || matches!(profile.protocol, CliProtocol::AnthropicMessages | CliProtocol::Gemini)),
        "opencode" => match profile.protocol {
            CliProtocol::AnthropicMessages | CliProtocol::Gemini => profile.auth == ProfileAuth::ApiKey,
            CliProtocol::OpenaiResponses => profile.auth == ProfileAuth::Bearer,
            CliProtocol::OpenaiChat => profile.auth != ProfileAuth::ApiKey,
        },
        _ => true,
    };
    if !auth_ok { return Err(format!("{engine} cannot honor the requested authentication mode")); }
    Ok(())
}

pub(super) fn apply(engine: &str, built: &mut BuiltCommand, req: &SendRequest) -> Result<(), String> {
    let resolved = req.execution.as_ref().ok_or("Missing execution profile")?;
    // OpenCode owns its actual serve process; never inject into its unused command.
    if engine == "opencode" { return Ok(()); }
    clear_auth(&mut built.command);
    let key = resolved.material.as_ref().map(|material| material.value());
    let mut env = HashMap::new();
    let profile = &resolved.profile;
    let options = profile.options.as_ref();
    match engine {
        "claude" => {
            env.insert("ANTHROPIC_BASE_URL".into(), profile.base_url.clone());
            env.insert(if profile.auth == ProfileAuth::Bearer { "ANTHROPIC_AUTH_TOKEN" } else { "ANTHROPIC_API_KEY" }.into(), key.unwrap_or("").into());
            if let Some(headers) = options.and_then(|o| o.headers.as_ref()) {
                env.insert("ANTHROPIC_CUSTOM_HEADERS".into(), headers.iter().map(|(k,v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n"));
            }
            if let Some(limit) = resolved.choice.token_policy.max_output_tokens { env.insert("CLAUDE_CODE_MAX_OUTPUT_TOKENS".into(), limit.to_string()); }
            let provider = json!({"settingsConfig": {"alwaysThinkingEnabled": options.and_then(|o| o.always_thinking_enabled).unwrap_or(req.effort.is_some())}});
            built.command.envs(&env);
            super::claude_channel::apply(built, &provider, &env, req)
        }
        "codex" => {
            env.insert("OPENAI_BASE_URL".into(), profile.base_url.clone());
            if let Some(key) = key { env.insert("OPENAI_API_KEY".into(), key.into()); }
            let id = provider_name(resolved);
            let mut provider = toml::Table::new();
            provider.insert("name".into(), toml::Value::String(id.clone()));
            provider.insert("base_url".into(), toml::Value::String(profile.base_url.clone()));
            provider.insert("wire_api".into(), toml::Value::String("responses".into()));
            provider.insert("requires_openai_auth".into(), toml::Value::Boolean(false));
            if let Some(headers) = options.and_then(|o| o.headers.as_ref()) {
                provider.insert("http_headers".into(), toml::Value::Table(headers.iter().map(|(k,v)| (k.clone(), toml::Value::String(v.clone()))).collect()));
            }
            let mut config = toml::Table::new();
            config.insert("model_provider".into(), toml::Value::String(id.clone()));
            config.insert("model_providers".into(), toml::Value::Table([(id, toml::Value::Table(provider))].into_iter().collect()));
            for (field, value) in [("model_context_window", resolved.choice.token_policy.context_window_tokens), ("model_auto_compact_token_limit", resolved.choice.token_policy.auto_compaction_threshold_tokens)] {
                if let Some(value) = value { config.insert(field.into(), toml::Value::Integer(value.try_into().map_err(|_| "Token limit is too large")?)); }
            }
            let text = toml::to_string(&config).map_err(|_| "Cannot render Codex profile")?;
            super::codex::apply_channel(&mut built.command, &json!({"settingsConfig":{"config":text}}), &env, req)
        }
        "kimi" => apply_kimi(built, req, resolved),
        "grok" => super::grok::apply_profile(built, req, resolved),
        "pi" | "omp" => apply_bridge(built, req, resolved),
        _ => Err("Native-only engine cannot consume a contribution".into()),
    }
}

fn apply_kimi(built: &mut BuiltCommand, req: &SendRequest, resolved: &ResolvedContribution) -> Result<(), String> {
    // --config-file is consumed by both stream-json and ACP. The env-created
    // ephemeral model used by the legacy adapter cannot carry headers/policy.
    let provider_type = match resolved.profile.protocol {
        CliProtocol::AnthropicMessages => "anthropic", CliProtocol::OpenaiResponses => "openai_responses",
        CliProtocol::OpenaiChat => "openai_legacy", CliProtocol::Gemini => "gemini",
    };
    let context = resolved.choice.token_policy.context_window_tokens.ok_or("Kimi requires an explicit model context window")?;
    let mut provider = json!({"type":provider_type,"base_url":resolved.profile.base_url,"api_key":resolved.material.as_ref().map(|m|m.value()).unwrap_or("")});
    if let Some(headers) = resolved.profile.options.as_ref().and_then(|o|o.headers.as_ref()) { provider["custom_headers"] = json!(headers); }
    let mut capabilities = Vec::new();
    if resolved.choice.capabilities.images == CapabilitySupport::Supported { capabilities.push("image_in"); }
    if !resolved.choice.capabilities.effort_levels.is_empty() { capabilities.push("thinking"); }
    let mut config = json!({"default_model":"ccgui-bound", "providers":{"ccgui-bound":provider}, "models":{"ccgui-bound":{"provider":"ccgui-bound","model":req.model,"max_context_size":context,"capabilities":capabilities}}});
    if let Some(threshold) = resolved.choice.token_policy.auto_compaction_threshold_tokens {
        let ratio = threshold as f64 / context as f64;
        if !(0.5..=0.99).contains(&ratio) || context.saturating_sub(threshold) < 1000 { return Err("Kimi compaction threshold is outside its supported range".into()); }
        config["loop_control"] = json!({"compaction_trigger_ratio":ratio,"reserved_context_size":context-threshold});
    }
    config["default_thinking"] = json!(req.effort.as_deref().is_some_and(|e| e != "off"));
    let dir = private_dir("kimi-staging")?;
    built.cleanup_files.push(dir.clone());
    let file = dir.join("config.json");
    std::fs::write(&file, serde_json::to_vec(&config).map_err(|_| "Cannot render Kimi profile")?).map_err(|_| "Cannot stage Kimi profile")?;
    built.command.args(["--config-file"]).arg(file);
    Ok(())
}

pub(super) struct BridgeSelection { pub provider: String, pub model: String, pub effort: Option<String> }
impl BridgeSelection {
    pub(super) fn for_request(req: &SendRequest) -> Option<Self> {
        let resolved = req.execution.as_ref()?;
        Some(Self { provider: provider_name(resolved), model: resolved.choice.selector.model_id().into(), effort: req.effort.clone() })
    }
    pub(super) fn verify(&self, state: &Value) -> Result<(), String> {
        if state.pointer("/model/provider").and_then(Value::as_str) != Some(self.provider.as_str())
            || state.pointer("/model/id").and_then(Value::as_str) != Some(self.model.as_str())
            || self.effort.as_deref().is_some_and(|effort| state.get("thinkingLevel").and_then(Value::as_str) != Some(effort)) {
            return Err("CLI did not confirm the selected provider, model and effort; prompt was not sent".into());
        }
        Ok(())
    }
}

// Fixed, dependency-free extension: values are data in the child environment,
// never interpolated into source. Pi uses $ENV syntax, OMP uses an env-key name.
const PROVIDER_BRIDGE: &str = r#"export default function (pi) {
  const p = JSON.parse(process.env.CCGUI_PROVIDER_PROFILE);
  pi.on('session_start', (_event, ctx) => {
    const slash=p.template.indexOf('/');
    if (slash<1) throw new Error('Provider bridge requires a provider/model template');
    const template=ctx.modelRegistry.find(p.template.slice(0,slash),p.template.slice(slash+1));
    if (!template || !template.cost) throw new Error('Provider bridge official template is unavailable');
    const model={id:p.model,name:p.label,reasoning:p.efforts.length>0,
      input:p.images?['text','image']:['text'],cost:template.cost,
      contextWindow:p.context,maxTokens:p.output};
    if (p.engine==='pi') model.thinkingLevelMap=Object.fromEntries(['minimal','low','medium','high','xhigh','max'].map(x=>[x,p.efforts.includes(x)?x:null]));
    else if (template.thinking) model.thinking=template.thinking;
    pi.registerProvider(p.provider,{baseUrl:p.baseUrl,api:p.api,
      apiKey:p.engine==='pi'?'$CCGUI_PROVIDER_KEY':'CCGUI_PROVIDER_KEY',
      authHeader:p.auth==='bearer',headers:p.headers,models:[model]});
  });
}
"#;

fn apply_bridge(built: &mut BuiltCommand, req: &SendRequest, resolved: &ResolvedContribution) -> Result<(), String> {
    let api = match resolved.profile.protocol {
        CliProtocol::AnthropicMessages => "anthropic-messages", CliProtocol::OpenaiResponses => "openai-responses",
        CliProtocol::OpenaiChat => "openai-completions", CliProtocol::Gemini => "google-generative-ai",
    };
    let mut headers = std::collections::BTreeMap::new();
    if let Some(source) = resolved.profile.options.as_ref().and_then(|o|o.headers.as_ref()) {
        for (index, (header, value)) in source.iter().enumerate() {
            let key = format!("CCGUI_PROVIDER_HEADER_{index}");
            built.command.env(&key, value);
            headers.insert(header.clone(), if resolved.profile.engine_id == "pi" { format!("${key}") } else { key });
        }
    }
    let profile = json!({"engine":resolved.profile.engine_id,"provider":provider_name(resolved),"model":resolved.choice.selector.model_id(),"label":resolved.choice.label,
        "baseUrl":resolved.profile.base_url,"api":api,"auth":resolved.profile.auth,"headers":headers,"template":resolved.choice.template_ref.model_id,
        "images":resolved.choice.capabilities.images==CapabilitySupport::Supported,"efforts":resolved.choice.capabilities.effort_levels,
        "context":resolved.choice.token_policy.context_window_tokens,"output":resolved.choice.token_policy.max_output_tokens});
    let dir = private_dir("provider-staging")?;
    built.cleanup_files.push(dir.clone());
    if resolved.profile.engine_id == "omp" {
        // OMP's documented --config overlay is process-local and never persisted.
        // Disable model/provider failover, including usage-aware switching and
        // context promotion; transport retries retain this same credential.
        let mut overlay = json!({"retry":{"modelFallback":false,"usageAwareFallback":false,"fallbackChains":{"default":[]}},"contextPromotion":{"enabled":false},"providers":{"anthropic":{"serverSideFallback":false}}});
        if let Some(threshold) = resolved.choice.token_policy.auto_compaction_threshold_tokens {
            let context = resolved.choice.token_policy.context_window_tokens.ok_or("OMP compaction needs context tokens")?;
            overlay["compaction"] = json!({"thresholdTokens":threshold,"thresholdPercent":-1,"reserveTokens":context.checked_sub(threshold).ok_or("Invalid OMP compaction threshold")?});
        }
        if let Some(tier) = &req.service_tier { overlay["tier"] = json!({"openai":tier}); }
        let config = dir.join("run-config.json");
        crate::plugins::storage::private_write(&config,overlay.to_string().as_bytes())?;
        built.command.arg("--config").arg(config);
    }
    let path = dir.join("provider-bridge.mjs");
    std::fs::write(&path, PROVIDER_BRIDGE).map_err(|_| "Cannot stage provider bridge")?;
    built.command.arg("--extension").arg(path);
    built.command.env("CCGUI_PROVIDER_PROFILE", profile.to_string());
    if let Some(material) = &resolved.material { built.command.env(KEY_ENV, material.value()); }
    Ok(())
}

pub(super) fn private_dir(parent: &str) -> Result<PathBuf, String> {
    let root = crate::paths::app_home().join(parent);
    std::fs::create_dir_all(&root).map_err(|_| "Cannot create staging root")?;
    let path = root.join(uuid::Uuid::new_v4().to_string());
    create_private_dir(&path)?;
    Ok(path)
}

pub(super) fn create_private_dir(path: &Path) -> Result<(), String> {
    crate::plugins::storage::private_directory(path)
}

pub(super) fn configure_opencode(command: &mut tokio::process::Command, req: &SendRequest) -> Result<(), String> {
    let resolved = req.execution.as_ref().ok_or("Missing OpenCode profile")?;
    let profile = &resolved.profile;
    clear_auth(command);
    let provider = provider_name(resolved);
    let npm = match profile.protocol {
        CliProtocol::AnthropicMessages => "@ai-sdk/anthropic", CliProtocol::OpenaiResponses => "@ai-sdk/openai",
        CliProtocol::OpenaiChat => "@ai-sdk/openai-compatible", CliProtocol::Gemini => "@ai-sdk/google",
    };
    let mut options = json!({"baseURL":profile.base_url});
    if let Some(material) = &resolved.material {
        command.env(KEY_ENV, material.value());
        // provider.env is resolved as a credential by OpenCode, not spliced into
        // config text. Even quotes/{file:...} in a Key remain inert secret data.
    }
    if let Some(headers) = profile.options.as_ref().and_then(|o|o.headers.as_ref()) {
        options["headers"] = json!(headers);
    }
    let mut model = json!({"id":resolved.choice.selector.model_id(),"name":resolved.choice.label,
        "reasoning":!resolved.choice.capabilities.effort_levels.is_empty(),"tool_call":resolved.choice.capabilities.tools==CapabilitySupport::Supported,
        "attachment":resolved.choice.capabilities.images==CapabilitySupport::Supported,
        "limit":{"context":resolved.choice.token_policy.context_window_tokens,"output":resolved.choice.token_policy.max_output_tokens}});
    let mut variants = serde_json::Map::new();
    for effort in &resolved.choice.capabilities.effort_levels {
        let variant = match profile.protocol {
            CliProtocol::OpenaiResponses | CliProtocol::OpenaiChat => json!({"reasoningEffort":effort}),
            CliProtocol::AnthropicMessages => json!({"thinking":{"type":"adaptive"},"effort":effort}),
            CliProtocol::Gemini => json!({"thinkingConfig":{"includeThoughts":true,"thinkingLevel":effort}}),
        };
        variants.insert(effort.clone(),variant);
    }
    model["variants"] = Value::Object(variants);
    let mut config = json!({"enabled_providers":[provider],"model":format!("{}/{}",provider,resolved.choice.selector.model_id()),
        "provider":{(provider.clone()):{"name":provider,"npm":npm,"env":[KEY_ENV],"options":options,"models":{(resolved.choice.selector.model_id()):model}}}});
    if let Some(threshold) = resolved.choice.token_policy.auto_compaction_threshold_tokens {
        let context = resolved.choice.token_policy.context_window_tokens.ok_or("OpenCode compaction needs a context limit")?;
        config["compaction"] = json!({"auto":true,"reserved":context.checked_sub(threshold).ok_or("Invalid OpenCode compaction threshold")?});
    }
    command.env("OPENCODE_CONFIG_CONTENT",config.to_string());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicting_auth_is_removed_case_insensitively() {
        let mut command = tokio::process::Command::new("unused");
        command.env("anthropic_auth_token", "wrong-key");
        command.env("ANTHROPIC_API_KEY", "also-wrong");
        clear_auth(&mut command);
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        assert!(env.iter().all(|(key, value)| !key.to_string_lossy().eq_ignore_ascii_case("anthropic_auth_token") || value.is_none()));
        assert_eq!(env.get(std::ffi::OsStr::new("ANTHROPIC_API_KEY")), Some(&None));
    }

    #[test]
    fn bridge_handshake_rejects_restored_wrong_provider_or_effort() {
        let expected = BridgeSelection { provider: "ccgui-bound".into(), model: "same-wire-id".into(), effort: Some("high".into()) };
        assert!(expected.verify(&serde_json::json!({"model":{"provider":"native", "id":"same-wire-id"},"thinkingLevel":"high"})).is_err());
        assert!(expected.verify(&serde_json::json!({"model":{"provider":"ccgui-bound", "id":"same-wire-id"},"thinkingLevel":"low"})).is_err());
        assert!(expected.verify(&serde_json::json!({"model":{"provider":"ccgui-bound", "id":"same-wire-id"},"thinkingLevel":"high"})).is_ok());
    }

    /// Concurrent children each see only their own Key, and the parent process
    /// never holds one — the isolation behind "same Provider, different Key" in
    /// parallel sessions. Runs on both platforms: CI is Windows-only, so a
    /// unix-gated version of this test would never execute there.
    #[tokio::test]
    async fn distinct_runtime_keys_remain_child_local() {
        let mut first = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        let mut second = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        for (child, key) in [(&mut first, "first-private"), (&mut second, "second-private")] {
            clear_auth(child);
            child.env(KEY_ENV, key);
            // Both shells expand the name from the child's own environment at
            // run time; the value never appears in argv.
            if cfg!(windows) {
                child.args(["/d", "/c", "echo %CCGUI_PROVIDER_KEY%"]);
            } else {
                child.args(["-c", "printf '%s' \"$CCGUI_PROVIDER_KEY\""]);
            }
        }
        let (a, b) = tokio::join!(first.output(), second.output());
        // cmd's echo appends CRLF; compare the payload, not the line ending.
        let printed = |output: std::process::Output| String::from_utf8(output.stdout).unwrap().trim().to_string();
        assert_eq!(printed(a.unwrap()), "first-private");
        assert_eq!(printed(b.unwrap()), "second-private");
        assert_ne!(std::env::var(KEY_ENV).ok().as_deref(), Some("second-private"));
    }
}
