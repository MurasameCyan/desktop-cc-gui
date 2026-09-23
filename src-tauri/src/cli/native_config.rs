//! Confirmed, typed native configuration operations. Secret-bearing snapshots
//! remain host-side; previews expose only recognized metadata.

use super::types::*;
use crate::plugins::storage::{private_directory, private_write, reject_linked_path};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const MAX_NATIVE_BYTES: u64 = 64 * 1024 * 1024;
const PREVIEW_TTL: Duration = Duration::from_secs(600);
static PREVIEWS: LazyLock<Mutex<HashMap<String, Pending>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NATIVE_WRITE: Mutex<()> = Mutex::new(());

#[derive(Clone)]
struct FileSnapshot { path: PathBuf, bytes: Option<Vec<u8>> }

struct ImportedCandidate { metadata: NativeConfigCandidate, value: Option<String> }
struct Pending {
    plugin_id: String,
    created: Instant,
    target: NativeConfigTarget,
    before: Vec<FileSnapshot>,
    kind: PendingKind,
}
enum PendingKind {
    Import(Vec<ImportedCandidate>),
    Patch { selection: ExecutionSelectionInput, source_revision: String, after: Vec<Option<Vec<u8>>>, runtime_fingerprint: String },
}

fn snapshot(path: &Path) -> Result<FileSnapshot, String> {
    // Reject symlinks/reparse points rather than following an unexpected target.
    reject_linked_path(path)?;
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_NATIVE_BYTES {
                return Err("CLI_NATIVE_UNSAFE_FILE: target must be a bounded regular file".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("CLI_NATIVE_UNSAFE_FILE: reparse points are not supported".into());
                }
            }
            use std::io::Read;
            let file = std::fs::File::open(path).map_err(|_| "CLI_NATIVE_READ_FAILED")?;
            let mut bytes = Vec::new();
            file.take(MAX_NATIVE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "CLI_NATIVE_READ_FAILED")?;
            if bytes.len() as u64 > MAX_NATIVE_BYTES { return Err("CLI_NATIVE_FILE_TOO_LARGE".into()); }
            Ok(FileSnapshot { path: path.to_path_buf(), bytes: Some(bytes) })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileSnapshot { path: path.to_path_buf(), bytes: None }),
        Err(_) => Err("CLI_NATIVE_READ_FAILED".into()),
    }
}

fn fingerprint(files: &[FileSnapshot]) -> String {
    let mut hash = Sha256::new();
    for file in files {
        let path = file.path.to_string_lossy();
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
        hash.update([u8::from(file.bytes.is_some())]);
        if let Some(bytes) = &file.bytes { hash.update((bytes.len() as u64).to_le_bytes()); hash.update(bytes); }
    }
    format!("{:x}", hash.finalize())
}

fn unchanged(files: &[FileSnapshot]) -> Result<(), String> {
    for file in files {
        if snapshot(&file.path)?.bytes != file.bytes { return Err("CLI_NATIVE_DRIFT: generate a new preview".into()); }
    }
    Ok(())
}

fn text(file: &FileSnapshot) -> Result<&str, String> {
    std::str::from_utf8(file.bytes.as_deref().unwrap_or_default()).map_err(|_| "CLI_NATIVE_INVALID_UTF8".into())
}

fn native_paths(engine: &str) -> Result<Vec<PathBuf>, String> {
    match engine {
        "claude" | "codex" | "kimi" | "grok" => crate::provider_files::native_file_paths(engine),
        "pi" | "omp" => {
            let home = crate::engine::pi_family_auth::agent_dir(engine)?;
            Ok(if engine == "pi" { vec![home.join("models.json"), home.join("auth.json")] }
            else { vec![home.join("models.yml"), home.join("agent.db"), home.join("agent.db-wal")] })
        }
        "opencode" => {
            let home = dirs::home_dir().ok_or("CLI_NATIVE_HOME_UNAVAILABLE")?;
            let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("opencode");
            let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("opencode");
            Ok(vec![config.join("opencode.json"), config.join("opencode.jsonc"), data.join("auth.json")])
        }
        _ => Err("CLI_NATIVE_UNSUPPORTED_ENGINE".into()),
    }
}

fn legacy_id(engine: &str, id: &str) -> String { format!("legacy:{engine}:{:x}", Sha256::digest(id.as_bytes())) }

fn config_targets() -> Result<Vec<NativeConfigTarget>, String> {
    let mut result = Vec::new();
    for engine in ["claude", "codex", "kimi", "grok", "pi", "omp", "opencode"] {
        let paths = native_paths(engine);
        let import_supported = paths.is_ok();
        let apply_supported = import_supported && matches!(engine, "claude" | "codex" | "kimi" | "grok");
        let unsupported_reason = match &paths {
            Err(reason) => Some(reason.clone()),
            Ok(_) if !apply_supported => Some("该引擎使用分层配置或认证存储，暂不支持原生导出；仍可导入配置并按会话使用".into()),
            _ => None,
        };
        result.push(NativeConfigTarget { target_id: format!("native:{engine}"), engine_id: engine.into(), label: format!("{engine} 原生配置"),
            paths: paths.unwrap_or_default().iter().map(|p| p.to_string_lossy().into_owned()).collect(), import_supported, apply_supported, unsupported_reason });
    }
    let config = crate::config::read_config()?;
    for engine in crate::config::ENGINES {
        if !matches!(engine, "claude" | "codex" | "kimi" | "grok") { continue; }
        for (id, provider) in &config.section(engine).ok_or("CLI_NATIVE_UNKNOWN_ENGINE")?.providers {
            if crate::config::is_managed_provider(provider) { continue; }
            result.push(NativeConfigTarget { target_id: legacy_id(engine, id), engine_id: engine.into(),
                label: format!("{engine} 已有渠道：{}", provider.get("name").and_then(Value::as_str).unwrap_or(id)),
                paths: vec![crate::paths::config_path().to_string_lossy().into_owned()], import_supported: true, apply_supported: true, unsupported_reason: None });
        }
    }
    Ok(result)
}

fn target_by_id(id: &str) -> Result<NativeConfigTarget, String> {
    config_targets()?.into_iter().find(|target| target.target_id == id).ok_or_else(|| "CLI_NATIVE_TARGET_UNAVAILABLE".into())
}

fn take_snapshots(target: &NativeConfigTarget) -> Result<Vec<FileSnapshot>, String> {
    target.paths.iter().map(|path| snapshot(Path::new(path))).collect()
}

fn static_key(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|key| !key.is_empty() && !key.starts_with('!') && !key.contains('$')
        && !key.contains("{env:") && !key.contains("{file:") && !key.contains("\n") && !key.contains("\r")
        && !key.starts_with("env:") && !key.starts_with("file:") && !key.starts_with("command:"))
}

fn safe_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https") && url.host_str().is_some() && url.username().is_empty()
        && url.password().is_none() && url.query().is_none() && url.fragment().is_none()).then(|| value.to_owned())
}

fn protocol(value: &str) -> Option<CliProtocol> {
    match value {
        "anthropic" | "anthropic-messages" | "messages" => Some(CliProtocol::AnthropicMessages),
        "responses" | "openai-responses" | "openai-codex-responses" => Some(CliProtocol::OpenaiResponses),
        "openai" | "chat" | "chat_completions" | "openai-chat" | "openai-completions" => Some(CliProtocol::OpenaiChat),
        "gemini" | "google-generative-ai" => Some(CliProtocol::Gemini),
        _ => None,
    }
}

fn candidate(id: &str, url: &str, protocol: CliProtocol, auth: ProfileAuth, models: Vec<String>, key: Option<&str>, mut skipped: Vec<String>) -> NativeConfigCandidate {
    if static_key(key).is_none() { skipped.push("未复制到可用的静态 Key；请明确确认认证方式，并在需要时于发布前填写 Key".into()); }
    NativeConfigCandidate { candidate_id: id.into(), label: id.into(), base_url: url.into(), protocol, auth, models,
        credential_name: static_key(key).map(|_| format!("{id} 导入的 Key")), has_static_key: static_key(key).is_some(), skipped_fields: skipped }
}

fn imported(id: &str, url: &str, protocol: CliProtocol, auth: ProfileAuth, models: Vec<String>, key: Option<&str>, skipped: &[&str]) -> Option<ImportedCandidate> {
    let url = safe_url(url)?;
    let key = static_key(key);
    Some(ImportedCandidate { metadata: candidate(id, &url, protocol, auth, models, key, skipped.iter().map(|s| (*s).into()).collect()), value: key.map(str::to_owned) })
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> { value.pointer(pointer).and_then(Value::as_str) }
fn object_entries(value: Option<&Value>) -> impl Iterator<Item = (&String, &Value)> { value.and_then(Value::as_object).into_iter().flatten() }

fn parse_pi(models: &Value, auth: &Value) -> Vec<ImportedCandidate> {
    object_entries(models.get("providers")).filter_map(|(id, provider)| {
        let protocol = protocol(provider.get("api").and_then(Value::as_str)?)?;
        let auth = auth.get(id);
        let key = provider.get("apiKey").and_then(Value::as_str).or_else(|| auth.filter(|a| a.get("type").and_then(Value::as_str) == Some("api_key")).and_then(|a| a.get("key")).and_then(Value::as_str));
        let model_ids = provider.get("models").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
        let auth_mode = if provider.get("authHeader").and_then(Value::as_bool) == Some(true) { ProfileAuth::Bearer }
            else { match provider.get("api").and_then(Value::as_str)? { "anthropic-messages" | "google-generative-ai" => ProfileAuth::ApiKey, _ => ProfileAuth::Bearer } };
        imported(id, provider.get("baseUrl").and_then(Value::as_str)?, protocol, auth_mode, model_ids, key, &["OAuth credentials, environment references, commands, headers and hooks are not imported"])
    }).collect()
}

fn parse_classic(engine: &str, config: &str, auth: &str) -> Result<Vec<ImportedCandidate>, String> {
    let root = if engine == "claude" { parse_jsonc(if config.trim().is_empty() { "{}" } else { config })? }
        else { serde_json::to_value(config.parse::<toml::Value>().map_err(|_| "CLI_NATIVE_INVALID_TOML")?).map_err(|_| "CLI_NATIVE_INVALID_TOML")? };
    let mut result = Vec::new();
    let mut push = |candidate: Option<ImportedCandidate>| { if let Some(candidate) = candidate { result.push(candidate); } };
    let skipped = &["Unrecognized fields, OAuth, environment references and executable hooks remain in the source"];
    match engine {
        "claude" => {
            let models = root.get("env").and_then(Value::as_object).into_iter().flatten()
                .filter(|(key, _)| matches!(key.as_str(), "ANTHROPIC_MODEL" | "ANTHROPIC_DEFAULT_OPUS_MODEL" | "ANTHROPIC_DEFAULT_SONNET_MODEL" | "ANTHROPIC_DEFAULT_HAIKU_MODEL"))
                .filter_map(|(_, value)| value.as_str().map(str::to_owned)).collect();
            let auth_mode = if str_at(&root, "/env/ANTHROPIC_AUTH_TOKEN").is_some() { ProfileAuth::Bearer }
                else if str_at(&root, "/env/ANTHROPIC_API_KEY").is_some() { ProfileAuth::ApiKey } else { ProfileAuth::None };
            push(imported("claude", str_at(&root, "/env/ANTHROPIC_BASE_URL").unwrap_or("https://api.anthropic.com"), CliProtocol::AnthropicMessages, auth_mode, models,
                str_at(&root, "/env/ANTHROPIC_AUTH_TOKEN").or_else(|| str_at(&root, "/env/ANTHROPIC_API_KEY")), skipped));
        }
        "codex" => {
            let auth = parse_jsonc(if auth.trim().is_empty() { "{}" } else { auth })?;
            let selected = root.get("model_provider").and_then(Value::as_str).unwrap_or("openai");
            for (id, provider) in object_entries(root.get("model_providers")) {
                let key = provider.get("experimental_bearer_token").and_then(Value::as_str).or_else(|| {
                    (id == selected && provider.get("env_key").and_then(Value::as_str).is_none_or(|key| key == "OPENAI_API_KEY"))
                        .then(|| auth.get("OPENAI_API_KEY").and_then(Value::as_str)).flatten()
                });
                let models = if id == selected { root.get("model").and_then(Value::as_str).map(str::to_owned).into_iter().collect() } else { vec![] };
                if let Some(protocol) = protocol(provider.get("wire_api").and_then(Value::as_str).unwrap_or("responses")) {
                    push(imported(id, provider.get("base_url").and_then(Value::as_str).unwrap_or("https://api.openai.com/v1"), protocol, ProfileAuth::Bearer, models, key, skipped));
                }
            }
            if root.get("model_providers").and_then(|providers| providers.get("openai")).is_none() && selected == "openai" {
                push(imported("openai", "https://api.openai.com/v1", CliProtocol::OpenaiResponses, ProfileAuth::Bearer,
                    root.get("model").and_then(Value::as_str).map(str::to_owned).into_iter().collect(), auth.get("OPENAI_API_KEY").and_then(Value::as_str), skipped));
            }
        }
        "kimi" => {
            for (id, provider) in object_entries(root.get("providers")) {
                let Some(protocol) = protocol(provider.get("type").and_then(Value::as_str).unwrap_or("openai")) else { continue; };
                let models = object_entries(root.get("models")).filter(|(_, model)| model.get("provider").and_then(Value::as_str) == Some(id.as_str()))
                    .filter_map(|(_, model)| model.get("model").and_then(Value::as_str).map(str::to_owned)).collect();
                let auth_mode = if provider.get("type").and_then(Value::as_str) == Some("anthropic") { ProfileAuth::ApiKey } else { ProfileAuth::Bearer };
                push(imported(id, provider.get("base_url").and_then(Value::as_str).unwrap_or("https://api.moonshot.ai/v1"), protocol, auth_mode, models, provider.get("api_key").and_then(Value::as_str), skipped));
            }
        }
        "grok" => {
            for (id, model) in object_entries(root.get("model")) {
                let Some(protocol) = protocol(model.get("api_backend").and_then(Value::as_str).unwrap_or("responses")) else { continue; };
                let url = model.get("base_url").and_then(Value::as_str).or_else(|| str_at(&root, "/endpoints/xai_api_base_url")).unwrap_or("https://api.x.ai/v1");
                let header_key = str_at(model, "/extra_headers/x-api-key");
                let auth_mode = if header_key.is_some() { ProfileAuth::ApiKey } else { ProfileAuth::Bearer };
                push(imported(id, url, protocol, auth_mode, vec![model.get("model").and_then(Value::as_str).unwrap_or(id).into()],
                    header_key.or_else(|| model.get("api_key").and_then(Value::as_str)), skipped));
            }
        }
        _ => return Err("CLI_NATIVE_UNSUPPORTED_ENGINE".into()),
    }
    Ok(result)
}

fn legacy_provider<'a>(target: &NativeConfigTarget, root: &'a Value) -> Result<(&'a str, &'a Value), String> {
    object_entries(root.get(&target.engine_id).and_then(|section| section.get("providers")))
        .find(|(id, _)| legacy_id(&target.engine_id, id) == target.target_id).map(|(id, value)| (id.as_str(), value))
        .ok_or_else(|| "CLI_NATIVE_TARGET_UNAVAILABLE".into())
}

fn parse_import(target: &NativeConfigTarget, files: &[FileSnapshot]) -> Result<Vec<ImportedCandidate>, String> {
    let first = files.first().ok_or("CLI_NATIVE_TARGET_UNAVAILABLE")?;
    if target.target_id.starts_with("legacy:") {
        let root = parse_jsonc(text(first)?)?;
        let (id, provider) = legacy_provider(target, &root)?;
        if target.engine_id == "codex" {
            if let Some(config) = str_at(provider, "/settingsConfig/config") {
                let auth = provider.pointer("/settingsConfig/auth").cloned().unwrap_or_else(|| json!({}));
                return parse_classic("codex", config, &auth.to_string());
            }
        }
        let env = crate::provider_files::channel_env(&target.engine_id, provider)?;
        let (url_key, key_key, model_key, protocol, default_url) = match target.engine_id.as_str() {
            "claude" => ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", CliProtocol::AnthropicMessages, "https://api.anthropic.com"),
            "codex" => ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL", CliProtocol::OpenaiResponses, "https://api.openai.com/v1"),
            "kimi" => ("KIMI_BASE_URL", "KIMI_API_KEY", "KIMI_MODEL_NAME", CliProtocol::OpenaiChat, "https://api.moonshot.ai/v1"),
            _ => ("GROK_XAI_API_BASE_URL", "XAI_API_KEY", "GROK_MODEL", CliProtocol::OpenaiResponses, "https://api.x.ai/v1"),
        };
        let field = |key: &str, env_key: &str| env.get(env_key).map(String::as_str).or_else(|| provider.get(key).and_then(Value::as_str));
        let models = field("model", model_key).map(str::to_owned).into_iter().collect();
        let alternate_key = (target.engine_id == "claude").then(|| env.get("ANTHROPIC_API_KEY").map(String::as_str)).flatten();
        let selected_key = field("apiKey", key_key).or(alternate_key);
        let auth_mode = if field("apiKey", key_key).is_none() && alternate_key.is_some() { ProfileAuth::ApiKey }
            else if selected_key.is_some() { ProfileAuth::Bearer } else { ProfileAuth::None };
        return Ok(imported(id, field("baseUrl", url_key).unwrap_or(default_url), protocol, auth_mode, models, selected_key,
            &["Only recognized static connection fields are imported; channel remains writable until separately confirmed takeover after publication"]).into_iter().collect());
    }
    match target.engine_id.as_str() {
        "claude" | "codex" | "kimi" | "grok" => parse_classic(&target.engine_id, text(first)?, files.get(1).map(text).transpose()?.unwrap_or("")),
        "pi" | "omp" => {
            let models = if text(first)?.trim().is_empty() { json!({}) } else {
                crate::engine::pi_family_auth::validate_models_config_text(&target.engine_id, text(first)?).map_err(|_| "CLI_NATIVE_INVALID_MODELS_CONFIG")?
            };
            let auth = if target.engine_id == "pi" { let value = text(&files[1])?; parse_jsonc(if value.trim().is_empty() { "{}" } else { value })? }
                else { read_omp_static_auth(files)? };
            Ok(parse_pi(&models, &auth))
        }
        "opencode" => {
            let auth_text = text(&files[2])?;
            let auth = parse_jsonc(if auth_text.trim().is_empty() { "{}" } else { auth_text })?;
            let mut candidates = Vec::new();
            for file in &files[..2] {
                if file.bytes.is_none() { continue; }
                let root = parse_jsonc(text(file)?)?;
                for (id, provider) in object_entries(root.get("provider")) {
                    let npm = provider.get("npm").and_then(Value::as_str).unwrap_or("");
                    let protocol = match npm { "@ai-sdk/anthropic" => CliProtocol::AnthropicMessages, "@ai-sdk/openai" => CliProtocol::OpenaiResponses,
                        "@ai-sdk/openai-compatible" => CliProtocol::OpenaiChat, "@ai-sdk/google" => CliProtocol::Gemini, _ => continue };
                    let key = str_at(provider, "/options/apiKey").or_else(|| auth.get(id).filter(|a| a.get("type").and_then(Value::as_str) == Some("api")).and_then(|a| a.get("key")).and_then(Value::as_str));
                    let models = object_entries(provider.get("models")).map(|(id, _)| id.clone()).collect();
                    if let Some(candidate) = imported(&format!("{}:{id}", file.path.file_name().unwrap_or_default().to_string_lossy()),
                        str_at(provider, "/options/baseURL").unwrap_or(""), protocol,
                        if matches!(npm, "@ai-sdk/anthropic" | "@ai-sdk/google") { ProfileAuth::ApiKey } else { ProfileAuth::Bearer }, models, key,
                        &["OAuth, environment/file references, plugins, hooks, dynamic providers and unknown npm adapters remain in the source"]) { candidates.push(candidate); }
                }
            }
            Ok(candidates)
        }
        _ => Err("CLI_NATIVE_UNSUPPORTED_ENGINE".into()),
    }
}

fn read_omp_static_auth(files: &[FileSnapshot]) -> Result<Value, String> {
    // Immutable read avoids SQLite creating SHM/journal files during preview.
    // WAL databases cannot be safely read this way: only inline models.yml keys are offered.
    if files[1].bytes.is_none() || files[2].bytes.as_ref().is_some_and(|bytes| !bytes.is_empty()) { return Ok(json!({})); }
    let mut uri = reqwest::Url::from_file_path(&files[1].path).map_err(|_| "CLI_NATIVE_INVALID_DB_PATH")?;
    uri.set_query(Some("mode=ro&immutable=1"));
    let connection = rusqlite::Connection::open_with_flags(uri.as_str(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI)
        .map_err(|_| "CLI_NATIVE_AUTH_DB_UNREADABLE")?;
    let mut statement = connection.prepare("SELECT provider, data FROM auth_credentials WHERE credential_type = 'api_key' AND disabled_cause IS NULL ORDER BY provider, id")
        .map_err(|_| "CLI_NATIVE_AUTH_DB_UNSUPPORTED_SCHEMA")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|_| "CLI_NATIVE_AUTH_DB_UNREADABLE")?;
    let mut auth = serde_json::Map::new();
    for row in rows {
        let (provider, data) = row.map_err(|_| "CLI_NATIVE_AUTH_DB_UNREADABLE")?;
        let value: Value = serde_json::from_str(&data).map_err(|_| "CLI_NATIVE_AUTH_DB_INVALID_CREDENTIAL")?;
        if let Some(key) = static_key(value.get("key").and_then(Value::as_str)) {
            // Multiple active keys must not be collapsed into an arbitrary winner.
            if auth.contains_key(&provider) { return Err("CLI_NATIVE_MULTIPLE_ACTIVE_KEYS: import this provider explicitly from models.yml".into()); }
            auth.insert(provider, json!({"type":"api_key","key":key}));
        }
    }
    Ok(Value::Object(auth))
}

// Mask comments without changing byte offsets. Patches replace only selected
// value spans; unrelated whitespace, comments and field ordering survive.
fn masked_jsonc(input: &str) -> Result<Vec<u8>, String> {
    let mut bytes = input.as_bytes().to_vec();
    let mut index = 0;
    let mut quoted = false;
    while index < bytes.len() {
        if quoted {
            if bytes[index] == b'\\' { index += 2; continue; }
            if bytes[index] == b'"' { quoted = false; }
        } else if bytes[index] == b'"' { quoted = true; }
        else if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && bytes[index] != b'\n' { bytes[index] = b' '; index += 1; }
            continue;
        } else if bytes[index..].starts_with(b"/*") {
            bytes[index] = b' '; bytes[index + 1] = b' '; index += 2;
            while index + 1 < bytes.len() && !bytes[index..].starts_with(b"*/") {
                if !matches!(bytes[index], b'\n' | b'\r') { bytes[index] = b' '; }
                index += 1;
            }
            if index + 1 >= bytes.len() { return Err("CLI_NATIVE_INVALID_JSONC".into()); }
            bytes[index] = b' '; bytes[index + 1] = b' '; index += 2;
            continue;
        }
        index += 1;
    }
    if quoted { return Err("CLI_NATIVE_INVALID_JSONC".into()); }
    Ok(bytes)
}

fn parse_jsonc(input: &str) -> Result<Value, String> {
    let mut bytes = masked_jsonc(input)?;
    let mut quoted = false;
    let mut index = 0;
    while index < bytes.len() {
        if quoted && bytes[index] == b'\\' { index += 2; continue; }
        if bytes[index] == b'"' { quoted = !quoted; }
        if !quoted && bytes[index] == b',' {
            let mut next = index + 1;
            while next < bytes.len() && bytes[next].is_ascii_whitespace() { next += 1; }
            if next < bytes.len() && matches!(bytes[next], b'}' | b']') { bytes[index] = b' '; }
        }
        index += 1;
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "CLI_NATIVE_INVALID_JSONC")?;
    if !value.is_object() { return Err("CLI_NATIVE_JSON_OBJECT_REQUIRED".into()); }
    Ok(value)
}

fn skip_ws(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() { index += 1; }
    index
}

fn value_end(bytes: &[u8], start: usize) -> Result<usize, String> {
    let mut index = start;
    let mut depth = 0usize;
    let mut quoted = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if quoted {
            if byte == b'\\' { index += 2; continue; }
            if byte == b'"' { quoted = false; if depth == 0 { return Ok(index + 1); } }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => { if depth == 0 { return Ok(index); } depth -= 1; if depth == 0 { return Ok(index + 1); } },
                b',' if depth == 0 => return Ok(index),
                byte if byte.is_ascii_whitespace() && depth == 0 => return Ok(index),
                _ => {},
            }
        }
        index += 1;
    }
    Err("CLI_NATIVE_INVALID_JSONC".into())
}

struct JsonMember { name: String, key_start: usize, start: usize, end: usize, comma: Option<usize> }
fn members(bytes: &[u8], start: usize) -> Result<(Vec<JsonMember>, usize), String> {
    let mut index = skip_ws(bytes, start);
    if bytes.get(index) != Some(&b'{') { return Err("CLI_NATIVE_JSON_OBJECT_REQUIRED".into()); }
    index += 1;
    let mut members = Vec::new();
    let mut names = HashSet::new();
    loop {
        index = skip_ws(bytes, index);
        if bytes.get(index) == Some(&b'}') { return Ok((members, index)); }
        let key_start = index;
        let key_end = value_end(bytes, index)?;
        let name: String = serde_json::from_slice(&bytes[index..key_end]).map_err(|_| "CLI_NATIVE_INVALID_JSONC")?;
        if !names.insert(name.clone()) { return Err("CLI_NATIVE_DUPLICATE_JSON_KEY".into()); }
        index = skip_ws(bytes, key_end);
        if bytes.get(index) != Some(&b':') { return Err("CLI_NATIVE_INVALID_JSONC".into()); }
        let value_start = skip_ws(bytes, index + 1);
        let end = value_end(bytes, value_start)?;
        index = skip_ws(bytes, end);
        let comma = (bytes.get(index) == Some(&b',')).then_some(index);
        members.push(JsonMember { name, key_start, start: value_start, end, comma });
        if comma.is_some() { index += 1; }
        else if bytes.get(index) != Some(&b'}') { return Err("CLI_NATIVE_INVALID_JSONC".into()); }
    }
}

fn json_set(input: &str, path: &[&str], value: &Value) -> Result<String, String> {
    let input = if input.trim().is_empty() { "{}" } else { input };
    parse_jsonc(input)?;
    let bytes = masked_jsonc(input)?;
    let mut start = 0;
    for (depth, name) in path.iter().enumerate() {
        let (fields, close) = members(&bytes, start)?;
        if let Some(field) = fields.iter().find(|field| field.name == *name) {
            if depth + 1 == path.len() {
                let mut output = input.to_owned();
                output.replace_range(field.start..field.end, &value.to_string());
                parse_jsonc(&output)?;
                return Ok(output);
            }
            start = field.start;
        } else {
            let mut value = value.clone();
            for child in path[depth + 1..].iter().rev() { let mut object = serde_json::Map::new(); object.insert((*child).into(), value); value = Value::Object(object); }
            let prefix = if fields.last().is_some_and(|field| field.comma.is_none()) { "," } else { "" };
            let addition = format!("{prefix}\n{}: {}\n", serde_json::to_string(name).map_err(|_| "CLI_NATIVE_SERIALIZE_FAILED")?, value);
            let mut output = input.to_owned();
            output.insert_str(close, &addition);
            parse_jsonc(&output)?;
            return Ok(output);
        }
    }
    Err("CLI_NATIVE_EMPTY_PATCH_PATH".into())
}

fn json_remove(input: &str, path: &[&str]) -> Result<String, String> {
    parse_jsonc(input)?;
    let bytes = masked_jsonc(input)?;
    let mut start = 0;
    for (depth, name) in path.iter().enumerate() {
        let (fields, _) = members(&bytes, start)?;
        let Some(position) = fields.iter().position(|field| field.name == *name) else { return Ok(input.into()); };
        let field = &fields[position];
        if depth + 1 == path.len() {
            let mut output = input.to_owned();
            if let Some(comma) = field.comma { output.replace_range(comma..comma + 1, " "); }
            else if position > 0 { if let Some(comma) = fields[position - 1].comma { output.replace_range(comma..comma + 1, " "); } }
            output.replace_range(field.key_start..field.end, "");
            parse_jsonc(&output)?;
            return Ok(output);
        }
        start = field.start;
    }
    Err("CLI_NATIVE_EMPTY_PATCH_PATH".into())
}

fn model_id(selector: &ModelSelector) -> &str {
    match selector { ModelSelector::Wire { model_id } | ModelSelector::Alias { model_id, .. } => model_id }
}

fn toml_set(doc: &mut toml_edit::DocumentMut, path: &[&str], value: toml_edit::Value) -> Result<(), String> {
    let mut current = doc.as_item_mut();
    for key in &path[..path.len() - 1] {
        if current.get(*key).is_none() {
            let mut table = toml_edit::Table::new(); table.set_implicit(true);
            current.as_table_like_mut().ok_or("CLI_NATIVE_TOML_TABLE_REQUIRED")?.insert(*key, toml_edit::Item::Table(table));
        }
        current = current.get_mut(*key).ok_or("CLI_NATIVE_TOML_TABLE_REQUIRED")?;
    }
    let key = path[path.len() - 1];
    let mut value = value;
    if let Some(existing) = current.get(key).and_then(toml_edit::Item::as_value) { *value.decor_mut() = existing.decor().clone(); }
    current.as_table_like_mut().ok_or("CLI_NATIVE_TOML_TABLE_REQUIRED")?.insert(key, toml_edit::Item::Value(value));
    Ok(())
}

fn render_patch(target: &NativeConfigTarget, files: &[FileSnapshot], resolved: &super::ResolvedContribution, selection: &ExecutionSelectionInput) -> Result<Vec<Option<Vec<u8>>>, String> {
    let profile = &resolved.profile;
    if safe_url(&profile.base_url).is_none() { return Err("CLI_NATIVE_UNSAFE_ENDPOINT: credentials, queries and fragments are not permitted in exported endpoints".into()); }
    if profile.execution_target != ExecutionTarget::Local { return Err("CLI_NATIVE_LOCAL_TARGET_REQUIRED".into()); }
    if target.target_id.starts_with("legacy:") {
        let root = parse_jsonc(text(&files[0])?)?;
        let (id, provider) = legacy_provider(target, &root)?;
        if crate::config::is_managed_provider(provider) { return Err("CLI_CHANNEL_ALREADY_MANAGED".into()); }
        let imported = parse_import(target, files)?;
        if !imported.iter().any(|candidate| candidate.metadata.base_url == profile.base_url && candidate.metadata.protocol == profile.protocol
            && candidate.metadata.auth == profile.auth
            && candidate.value.as_deref() == resolved.material.as_ref().map(|material| material.value())
            && (candidate.metadata.models.is_empty() || candidate.metadata.models.iter().any(|id| id == model_id(&resolved.choice.selector)))) {
            return Err("CLI_NATIVE_TAKEOVER_MISMATCH: publish the imported channel before taking ownership".into());
        }
        // Guarded old exits retain the original internally for recovery, but never expose its fields.
        let marker = json!({"sourceId":resolved.source.source_id,"publicationRevision":resolved.source.publication_revision});
        let result = json_set(text(&files[0])?, &[&target.engine_id, "providers", id, "__ccguiManagedBy"], &marker)?;
        return Ok(vec![Some(result.into_bytes())]);
    }
    let material = resolved.material.as_ref().ok_or("CLI_NATIVE_STATIC_KEY_REQUIRED: native authentication fallback cannot safely represent an unauthenticated contribution")?;
    let key = static_key(Some(material.value())).ok_or("CLI_NATIVE_STATIC_KEY_REQUIRED")?;
    let model = model_id(&resolved.choice.selector);
    let policy = &resolved.choice.token_policy;
    if let Some(options) = &profile.options {
        if options.headers.as_ref().is_some_and(|headers| !headers.is_empty()) && target.engine_id != "grok" { return Err("CLI_NATIVE_HEADERS_UNSUPPORTED".into()); }
        if options.service_tier.is_some() && target.engine_id != "codex" { return Err("CLI_NATIVE_SERVICE_TIER_UNSUPPORTED".into()); }
        if options.always_thinking_enabled.is_some() && target.engine_id != "claude" { return Err("CLI_NATIVE_THINKING_OPTION_UNSUPPORTED".into()); }
    }
    if target.engine_id == "claude" {
        if profile.protocol != CliProtocol::AnthropicMessages { return Err("CLI_NATIVE_PROTOCOL_UNSUPPORTED".into()); }
        if policy.context_window_tokens.is_some() || policy.auto_compaction_threshold_tokens.is_some() { return Err("CLI_NATIVE_EXACT_CONTEXT_POLICY_UNSUPPORTED".into()); }
        let mut config = if text(&files[0])?.trim().is_empty() { "{}".into() } else { text(&files[0])?.to_owned() };
        let original = parse_jsonc(&config)?;
        if original.get("env").and_then(Value::as_object).is_some_and(|env| env.iter().any(|(name, value)|
            ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS"]
                .iter().any(|field| name.eq_ignore_ascii_case(field)) && value.as_str().is_none_or(|value| !value.is_empty() && value != "0"))) {
            return Err("CLI_NATIVE_CONFLICTING_AUTH: existing OAuth, cloud routing or custom headers must be reviewed separately".into());
        }
        for field in ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"] {
            config = json_remove(&config, &["env", field])?;
        }
        let auth_key = if profile.auth == ProfileAuth::ApiKey { "ANTHROPIC_API_KEY" } else { "ANTHROPIC_AUTH_TOKEN" };
        for (name, value) in [("ANTHROPIC_BASE_URL", profile.base_url.as_str()), (auth_key, key), ("ANTHROPIC_MODEL", model)] {
            config = json_set(&config, &["env", name], &json!(value))?;
        }
        if let Some(effort) = &selection.effort { config = json_set(&config, &["effortLevel"], &json!(effort))?; }
        else { config = json_remove(&config, &["effortLevel"])?; }
        if let Some(output) = policy.max_output_tokens { config = json_set(&config, &["env", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"], &json!(output.to_string()))?; }
        if let Some(thinking) = profile.options.as_ref().and_then(|options| options.always_thinking_enabled) { config = json_set(&config, &["alwaysThinkingEnabled"], &json!(thinking))?; }
        return Ok(vec![Some(config.into_bytes())]);
    }
    let mut config = text(&files[0])?.parse::<toml_edit::DocumentMut>().map_err(|_| "CLI_NATIVE_INVALID_TOML")?;
    let owner_id = format!("ccgui_{}", &format!("{:x}", Sha256::digest(format!("{}:{}", resolved.source.source_id, profile.profile_key).as_bytes()))[..16]);
    let mut auth = None;
    match target.engine_id.as_str() {
        "codex" => {
            if !matches!(profile.protocol, CliProtocol::OpenaiResponses | CliProtocol::OpenaiChat) { return Err("CLI_NATIVE_PROTOCOL_UNSUPPORTED".into()); }
            if profile.auth != ProfileAuth::Bearer { return Err("CLI_NATIVE_AUTH_MODE_UNSUPPORTED".into()); }
            if policy.max_output_tokens.is_some() { return Err("CLI_NATIVE_MAX_OUTPUT_UNSUPPORTED".into()); }
            for (name, value) in [("name", profile.label.as_str()), ("base_url", profile.base_url.as_str()), ("experimental_bearer_token", key),
                ("wire_api", if profile.protocol == CliProtocol::OpenaiResponses { "responses" } else { "chat" })] {
                toml_set(&mut config, &["model_providers", &owner_id, name], value.into())?;
            }
            toml_set(&mut config, &["model_providers", &owner_id, "requires_openai_auth"], false.into())?;
            if let Some(table) = config.get_mut("model_providers").and_then(|providers| providers.get_mut(owner_id.as_str())).and_then(toml_edit::Item::as_table_like_mut) {
                table.remove("env_key");
                if table.get("env_http_headers").is_some() { return Err("CLI_NATIVE_DYNAMIC_AUTH_CONFLICT".into()); }
                if table.get("http_headers").and_then(toml_edit::Item::as_table_like).is_some_and(|headers| headers.iter().any(|(name, _)| matches!(name.to_ascii_lowercase().as_str(), "authorization" | "x-api-key" | "api-key"))) {
                    return Err("CLI_NATIVE_CONFLICTING_AUTH_HEADERS".into());
                }
            }
            toml_set(&mut config, &["model_provider"], owner_id.as_str().into())?;
            toml_set(&mut config, &["model"], model.into())?;
            toml_set(&mut config, &["preferred_auth_method"], "apikey".into())?;
            if let Some(effort) = &selection.effort { toml_set(&mut config, &["model_reasoning_effort"], effort.as_str().into())?; }
            else { config.remove("model_reasoning_effort"); }
            for (name, count) in [("model_context_window", policy.context_window_tokens), ("model_auto_compact_token_limit", policy.auto_compaction_threshold_tokens)] {
                if let Some(count) = count { toml_set(&mut config, &[name], i64::try_from(count).map_err(|_| "CLI_NATIVE_TOKEN_POLICY_OUT_OF_RANGE")?.into())?; }
            }
            if let Some(tier) = profile.options.as_ref().and_then(|options| options.service_tier.as_ref()) {
                let tier = serde_json::to_value(tier).map_err(|_| "CLI_NATIVE_INVALID_SERVICE_TIER")?;
                toml_set(&mut config, &["service_tier"], tier.as_str().ok_or("CLI_NATIVE_INVALID_SERVICE_TIER")?.into())?;
            }
            let base = text(&files[1])?;
            auth = Some(json_set(if base.trim().is_empty() { "{}" } else { base }, &["OPENAI_API_KEY"], &json!(key))?);
        }
        "kimi" => {
            if profile.protocol != CliProtocol::OpenaiChat { return Err("CLI_NATIVE_PROTOCOL_UNSUPPORTED".into()); }
            if profile.auth != ProfileAuth::Bearer { return Err("CLI_NATIVE_AUTH_MODE_UNSUPPORTED".into()); }
            if policy.max_output_tokens.is_some() { return Err("CLI_NATIVE_MAX_OUTPUT_UNSUPPORTED".into()); }
            if selection.effort.is_some() { return Err("CLI_NATIVE_EXACT_EFFORT_UNSUPPORTED".into()); }
            for (name, value) in [("type", "openai"), ("base_url", profile.base_url.as_str()), ("api_key", key)] { toml_set(&mut config, &["providers", &owner_id, name], value.into())?; }
            toml_set(&mut config, &["models", &owner_id, "provider"], owner_id.as_str().into())?;
            toml_set(&mut config, &["models", &owner_id, "model"], model.into())?;
            toml_set(&mut config, &["default_model"], owner_id.as_str().into())?;
            if let Some(context) = policy.context_window_tokens { toml_set(&mut config, &["models", &owner_id, "max_context_size"], i64::try_from(context).map_err(|_| "CLI_NATIVE_TOKEN_POLICY_OUT_OF_RANGE")?.into())?; }
            if let Some(threshold) = policy.auto_compaction_threshold_tokens {
                let context = policy.context_window_tokens.ok_or("CLI_NATIVE_COMPACTION_REQUIRES_CONTEXT")?;
                let reserve = context.checked_sub(threshold).ok_or("CLI_NATIVE_INVALID_COMPACTION_POLICY")?;
                let ratio = threshold as f64 / context as f64;
                if !(0.5..=0.99).contains(&ratio) || reserve < 1000 { return Err("CLI_NATIVE_INVALID_COMPACTION_POLICY".into()); }
                toml_set(&mut config, &["loop_control", "compaction_trigger_ratio"], ratio.into())?;
                toml_set(&mut config, &["loop_control", "reserved_context_size"], i64::try_from(reserve).map_err(|_| "CLI_NATIVE_TOKEN_POLICY_OUT_OF_RANGE")?.into())?;
            }
        }
        "grok" => {
            if !matches!(profile.protocol, CliProtocol::OpenaiResponses | CliProtocol::OpenaiChat | CliProtocol::AnthropicMessages) { return Err("CLI_NATIVE_PROTOCOL_UNSUPPORTED".into()); }
            if profile.auth != ProfileAuth::Bearer { return Err("CLI_NATIVE_AUTH_MODE_UNSUPPORTED: API-key export cannot safely suppress Grok native OAuth without modifying its auth store".into()); }
            if policy.auto_compaction_threshold_tokens.is_some() { return Err("CLI_NATIVE_EXACT_COMPACTION_UNSUPPORTED".into()); }
            if selection.effort.is_some() { return Err("CLI_NATIVE_EXACT_EFFORT_UNSUPPORTED".into()); }
            if config.get("model").and_then(|models| models.get(owner_id.as_str())).is_some_and(|model|
                model.get("env_key").is_some() || model.get("env_http_headers").is_some()) {
                return Err("CLI_NATIVE_DYNAMIC_AUTH_CONFLICT: existing environment references are retained; remove them explicitly before applying".into());
            }
            for table in [config.as_item(), config.get("models").unwrap_or(config.as_item()),
                config.get("model").and_then(|models| models.get(owner_id.as_str())).unwrap_or(config.as_item())] {
                if table.get("extra_headers").and_then(toml_edit::Item::as_table_like).is_some_and(|headers| headers.iter().any(|(name, _)|
                    ["authorization", "x-api-key", "api-key"].iter().any(|auth| name.eq_ignore_ascii_case(auth)))) {
                    return Err("CLI_NATIVE_CONFLICTING_AUTH_HEADERS".into());
                }
            }
            for name in ["models_base_url", "xai_api_base_url", "cli_chat_proxy_base_url"] { toml_set(&mut config, &["endpoints", name], profile.base_url.as_str().into())?; }
            toml_set(&mut config, &["endpoints", "models_list_url"], format!("{}/models", profile.base_url.trim_end_matches('/')).into())?;
            toml_set(&mut config, &["models", "default"], owner_id.as_str().into())?;
            let backend = match profile.protocol { CliProtocol::AnthropicMessages => "messages", CliProtocol::OpenaiResponses => "responses", _ => "chat_completions" };
            for (name, value) in [("model", model), ("api_key", key), ("base_url", profile.base_url.as_str()), ("api_backend", backend)] {
                toml_set(&mut config, &["model", &owner_id, name], value.into())?;
            }
            for (name, count) in [("context_window", policy.context_window_tokens), ("max_completion_tokens", policy.max_output_tokens)] {
                if let Some(count) = count { toml_set(&mut config, &["model", &owner_id, name], i64::try_from(count).map_err(|_| "CLI_NATIVE_TOKEN_POLICY_OUT_OF_RANGE")?.into())?; }
            }
            if let Some(headers) = profile.options.as_ref().and_then(|options| options.headers.as_ref()) {
                for (name, value) in headers { toml_set(&mut config, &["model", &owner_id, "extra_headers", name], value.as_str().into())?; }
            }
        }
        _ => return Err("CLI_NATIVE_PATCH_UNSUPPORTED".into()),
    }
    let mut files = vec![Some(config.to_string().into_bytes())];
    if let Some(auth) = auth { files.push(Some(auth.into_bytes())); }
    Ok(files)
}

#[derive(Serialize, Deserialize)]
struct Journal { paths: Vec<PathBuf>, existed: Vec<bool>, before_fingerprint: String, after_fingerprint: String, status: String }
#[derive(Serialize, Deserialize)]
struct ReceiptOwner { plugin_id: String, target_id: String, engine_id: String }

fn receipt_root() -> PathBuf { crate::paths::app_home().join("native-config-receipts") }
fn receipt_dir(id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "CLI_NATIVE_INVALID_RECEIPT")?;
    Ok(receipt_root().join(id))
}

fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "CLI_NATIVE_JOURNAL_SERIALIZE_FAILED")?;
    private_write(path, &bytes)
}

fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = snapshot(path)?.bytes.ok_or("CLI_NATIVE_RECEIPT_MISSING")?;
    serde_json::from_slice(&bytes).map_err(|_| "CLI_NATIVE_JOURNAL_INVALID".into())
}

fn write_state(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    match bytes {
        Some(bytes) => private_write(path, bytes),
        None => match std::fs::remove_file(path) { Ok(()) => Ok(()), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(_) => Err("CLI_NATIVE_REMOVE_FAILED".into()) },
    }
}

fn commit_files(before: &[FileSnapshot], desired: &[Option<Vec<u8>>], directory: &Path, fail_at: Option<usize>) -> Result<(), String> {
    if before.len() != desired.len() { return Err("CLI_NATIVE_PATCH_FILE_COUNT_MISMATCH".into()); }
    unchanged(before)?;
    private_directory(directory)?;
    let after: Vec<_> = before.iter().zip(desired).map(|(file, bytes)| FileSnapshot { path: file.path.clone(), bytes: bytes.clone() }).collect();
    let mut journal = Journal { paths: before.iter().map(|file| file.path.clone()).collect(), existed: before.iter().map(|file| file.bytes.is_some()).collect(),
        before_fingerprint: fingerprint(before), after_fingerprint: fingerprint(&after), status: "prepared".into() };
    for (index, file) in before.iter().enumerate() {
        if let Some(bytes) = &file.bytes { private_write(&directory.join(format!("{index}.before")), bytes)?; }
    }
    save_json(&directory.join("journal.json"), &journal)?;
    let mut attempted = 0;
    let result: Result<(), String> = (|| {
        unchanged(before)?;
        for (index, (file, desired)) in before.iter().zip(desired).enumerate() {
            attempted = index + 1;
            if snapshot(&file.path)?.bytes != file.bytes { return Err("CLI_NATIVE_DRIFT".into()); }
            if fail_at == Some(index) { return Err("CLI_NATIVE_INJECTED_WRITE_FAILURE".into()); }
            write_state(&file.path, desired.as_deref())?;
            if snapshot(&file.path)?.bytes != *desired { return Err("CLI_NATIVE_WRITE_VERIFICATION_FAILED".into()); }
        }
        unchanged(&after)?;
        journal.status = "applied".into();
        save_json(&directory.join("journal.json"), &journal)
    })();
    if result.is_err() {
        let mut conflict = false;
        for index in (0..attempted).rev() {
            match snapshot(&before[index].path) {
                Ok(current) if current.bytes == before[index].bytes => {},
                Ok(current) if current.bytes == desired[index] => {
                    if write_state(&before[index].path, before[index].bytes.as_deref()).is_err() { conflict = true; }
                }
                _ => conflict = true,
            }
        }
        journal.status = if conflict { "recovery-required" } else { "rolled-back" }.into();
        if save_json(&directory.join("journal.json"), &journal).is_err() || conflict {
            return Err("CLI_NATIVE_RECOVERY_REQUIRED: private backups retained; external edits were not overwritten".into());
        }
    }
    result
}

fn active_owners() -> Result<Vec<ReceiptOwner>, String> {
    let mut owners = Vec::new();
    let entries = match std::fs::read_dir(receipt_root()) { Ok(entries) => entries, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(owners), Err(_) => return Err("CLI_NATIVE_RECEIPTS_UNREADABLE".into()) };
    for entry in entries {
        let entry = entry.map_err(|_| "CLI_NATIVE_RECEIPTS_UNREADABLE")?;
        if !entry.file_type().map_err(|_| "CLI_NATIVE_RECEIPTS_UNREADABLE")?.is_dir() { continue; }
        let owner_path = entry.path().join("owner.json");
        if !owner_path.exists() { continue; }
        let owner: ReceiptOwner = load_json(&owner_path)?;
        let journal_path = entry.path().join("journal.json");
        if !journal_path.exists() { continue; }
        let journal: Journal = load_json(&journal_path)?;
        if !matches!(journal.status.as_str(), "restored" | "rolled-back") {
            owners.push(owner);
        }
    }
    Ok(owners)
}

pub(crate) fn ensure_raw_access(engine: &str) -> Result<(), String> {
    if active_owners()?.iter().any(|owner| owner.engine_id == engine && owner.target_id.starts_with("native:")) {
        return Err("CLI_NATIVE_MANAGED_READ_ONLY: native configuration is owned by a confirmed plugin patch; restore it before using the raw editor".into());
    }
    Ok(())
}

fn require_target_owner(plugin_id: &str, target: &NativeConfigTarget) -> Result<(), String> {
    if active_owners()?.iter().any(|owner| owner.target_id == target.target_id && owner.plugin_id != plugin_id) {
        return Err("CLI_NATIVE_TARGET_OWNED: restore the owning plugin's patch before importing or applying from another plugin".into());
    }
    Ok(())
}

pub(crate) fn raw_access_lock(engine: &str) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    let guard = NATIVE_WRITE.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    ensure_raw_access(engine)?;
    Ok(guard)
}

pub(crate) fn invalidate_plugin(plugin_id: &str) {
    let mut previews = PREVIEWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    previews.retain(|_, preview| preview.plugin_id != plugin_id);
}

fn preview_bytes(pending: &Pending) -> usize {
    let original = pending.before.iter().map(|file| file.bytes.as_ref().map_or(0, Vec::len)).sum::<usize>();
    original + match &pending.kind {
        PendingKind::Import(candidates) => candidates.iter().map(|candidate| candidate.value.as_ref().map_or(0, String::len)).sum::<usize>(),
        PendingKind::Patch { after, .. } => after.iter().map(|bytes| bytes.as_ref().map_or(0, Vec::len)).sum::<usize>(),
    }
}

fn remember(pending: Pending) -> Result<String, String> {
    let mut previews = PREVIEWS.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    previews.retain(|_, preview| preview.created.elapsed() < PREVIEW_TTL);
    if previews.len() >= 128 { return Err("CLI_NATIVE_TOO_MANY_PREVIEWS".into()); }
    if previews.values().map(preview_bytes).sum::<usize>() + preview_bytes(&pending) > 2 * MAX_NATIVE_BYTES as usize {
        return Err("CLI_NATIVE_PREVIEW_MEMORY_LIMIT".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    previews.insert(id.clone(), pending);
    Ok(id)
}

fn take_preview(plugin_id: &str, preview_id: &str) -> Result<Pending, String> {
    let mut previews = PREVIEWS.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    previews.retain(|_, preview| preview.created.elapsed() < PREVIEW_TTL);
    if previews.get(preview_id).is_none_or(|preview| preview.plugin_id != plugin_id) { return Err("CLI_NATIVE_PREVIEW_UNAVAILABLE".into()); }
    previews.remove(preview_id).ok_or_else(|| "CLI_NATIVE_PREVIEW_UNAVAILABLE".into())
}

fn select_candidates(candidates: &[ImportedCandidate], ids: &[String]) -> Result<Vec<NativeImportCandidate>, String> {
    let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if unique.len() != ids.len() { return Err("CLI_NATIVE_DUPLICATE_CANDIDATE".into()); }
    ids.iter().map(|id| {
        let candidate = candidates.iter().find(|candidate| &candidate.metadata.candidate_id == id).ok_or("CLI_NATIVE_UNKNOWN_CANDIDATE")?;
        Ok(NativeImportCandidate { candidate: candidate.metadata.clone(), value: candidate.value.clone() })
    }).collect()
}

fn resolve_patch(state: &crate::AppState, plugin_id: &str, target: &NativeConfigTarget, selection: &ExecutionSelectionInput) -> Result<super::ResolvedContribution, String> {
    let execution_target = SessionExecutionTarget { engine_id: target.engine_id.clone(), workspace_path: String::new(), session_id: None, pending_id: None, execution_target: ExecutionTarget::Local };
    let resolved = super::resolve_contribution(state, &execution_target, selection)?;
    if resolved.source.plugin_id != plugin_id || !resolved.source.available { return Err("CLI_NATIVE_SOURCE_OWNERSHIP_REQUIRED".into()); }
    Ok(resolved)
}

#[tauri::command]
pub fn plugin_cli_list_config_targets(plugin_id: String) -> Result<Vec<NativeConfigTarget>, String> {
    super::require_permission(&plugin_id, "cli.config.read")?;
    let owners = active_owners()?;
    let mut targets = config_targets()?;
    for target in &mut targets {
        if owners.iter().any(|owner| owner.target_id == target.target_id && owner.plugin_id != plugin_id) {
            target.import_supported = false;
            target.apply_supported = false;
            target.unsupported_reason = Some("该目标由其他插件的原生补丁占用，请先恢复该补丁".into());
        }
    }
    Ok(targets)
}

#[tauri::command]
pub fn plugin_cli_preview_config_import(plugin_id: String, target_id: String) -> Result<NativeConfigPreview, String> {
    super::require_permission(&plugin_id, "cli.config.read")?;
    let _guard = NATIVE_WRITE.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    let target = target_by_id(&target_id)?;
    require_target_owner(&plugin_id, &target)?;
    if !target.import_supported { return Err(target.unsupported_reason.unwrap_or_else(|| "CLI_NATIVE_IMPORT_UNSUPPORTED".into())); }
    let before = take_snapshots(&target)?;
    let candidates = parse_import(&target, &before)?;
    unchanged(&before)?;
    let metadata = candidates.iter().map(|candidate| candidate.metadata.clone()).collect();
    let fingerprint = fingerprint(&before);
    let warnings = vec!["只提供已识别的静态字段。未知字段、OAuth、环境变量或文件引用、命令与 hooks 均保留在原处，且不会执行。".into(),
        if target.engine_id == "omp" { "仅当不存在活动 WAL 时，才以不可变只读方式读取 OMP SQLite 认证；否则只提供 models.yml 内直接填写的 Key。".into() }
        else { "经宿主确认后，才将所选静态 Key 复制给目标插件；来源文件不会改动。".into() }];
    let preview_id = remember(Pending { plugin_id, created: Instant::now(), target: target.clone(), before, kind: PendingKind::Import(candidates) })?;
    Ok(NativeConfigPreview { preview_id, target, fingerprint, candidates: metadata, warnings })
}

#[tauri::command]
pub async fn plugin_cli_confirm_config_import(app: tauri::AppHandle, plugin_id: String, preview_id: String, candidate_ids: Vec<String>) -> Result<NativeImportResult, String> {
    super::require_permission(&plugin_id, "cli.config.read")?;
    super::require_permission(&plugin_id, "cli.runtime.sensitive")?;
    let pending = take_preview(&plugin_id, &preview_id)?;
    let PendingKind::Import(candidates) = &pending.kind else { return Err("CLI_NATIVE_WRONG_PREVIEW_KIND".into()); };
    let selected = select_candidates(candidates, &candidate_ids)?;
    if selected.is_empty() { return Ok(NativeImportResult { candidates: vec![] }); }
    unchanged(&pending.before)?;
    let message = format!("来源：{}\n文件：\n{}\n目标插件：{}\n所选候选项：{}\n\n是否仅将这些静态 Key 复制给此插件？插件可能将它们以明文保存在 registry.json 中，产生第二份明文副本。原生文件、OAuth 与动态凭据均不会改动，也不会转移已有渠道的所有权。",
        pending.target.label, pending.target.paths.join("\n"), plugin_id, selected.iter().map(|candidate| candidate.candidate.label.as_str()).collect::<Vec<_>>().join("、"));
    super::grants::confirm_desktop(&app, "导入原生静态凭据", &message).await?;
    super::require_permission(&plugin_id, "cli.config.read")?;
    super::require_permission(&plugin_id, "cli.runtime.sensitive")?;
    let _guard = NATIVE_WRITE.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    let target = target_by_id(&pending.target.target_id)?;
    require_target_owner(&plugin_id, &target)?;
    if target != pending.target { return Err("CLI_NATIVE_TARGET_CHANGED".into()); }
    unchanged(&pending.before)?;
    Ok(NativeImportResult { candidates: selected })
}

#[tauri::command]
pub async fn plugin_cli_preview_config_patch(state: tauri::State<'_, crate::AppState>, plugin_id: String, target_id: String, selection: ExecutionSelectionInput) -> Result<ConfigPatchPreview, String> {
    super::require_permission(&plugin_id, "cli.config.apply")?;
    let ModelSelection::Contribution { source_id, .. } = &selection.model_selection else { return Err("CLI_NATIVE_PUBLISHED_SELECTION_REQUIRED".into()); };
    super::namespace_source_id(&plugin_id, source_id)?;
    let initial_target = target_by_id(&target_id)?;
    require_target_owner(&plugin_id, &initial_target)?;
    if !initial_target.apply_supported { return Err(initial_target.unsupported_reason.unwrap_or_else(|| "CLI_NATIVE_PATCH_UNSUPPORTED".into())); }
    let execution_target = SessionExecutionTarget { engine_id: initial_target.engine_id, workspace_path: String::new(), session_id: None, pending_id: None, execution_target: ExecutionTarget::Local };
    super::ensure_selection_material(&state, &execution_target, &selection).await?;
    super::require_permission(&plugin_id, "cli.config.apply")?;
    let _guard = NATIVE_WRITE.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    let target = target_by_id(&target_id)?;
    require_target_owner(&plugin_id, &target)?;
    if !target.apply_supported { return Err(target.unsupported_reason.unwrap_or_else(|| "CLI_NATIVE_PATCH_UNSUPPORTED".into())); }
    let before = take_snapshots(&target)?;
    let resolved = resolve_patch(&state, &plugin_id, &target, &selection)?;
    let after = render_patch(&target, &before, &resolved, &selection)?;
    unchanged(&before)?;
    let fingerprint = fingerprint(&before);
    let takeover = target.target_id.starts_with("legacy:");
    let mut changes = if takeover { vec![format!("将已有渠道的所有权转移给已发布来源 {}（{}）", resolved.source.source_id, resolved.source.publication_revision),
        "原渠道编辑器与原始元数据将变为只读且不再包含密钥；已有原生渠道选择必须明确重新绑定。私有恢复备份会保留原渠道凭据。".into()] }
        else { vec![format!("将 {} 的原生供应商端点设为 {}", target.engine_id, resolved.profile.base_url), format!("将原生模型设为 {}，推理强度为 {}", model_id(&resolved.choice.selector), selection.effort.as_deref().unwrap_or("不适用")),
            "只写入受控的路由、认证与策略字段；保留无关字段及注释。".into(), "所选 Key 与恢复备份将以明文私有保存，在 registry.json 之外产生另一份副本。".into()] };
    changes.push(format!("完整选择：{}", serde_json::to_string(&selection).map_err(|_| "CLI_NATIVE_SERIALIZE_FAILED")?));
    changes.push(format!("Token 策略：{}", serde_json::to_string(&resolved.choice.token_policy).map_err(|_| "CLI_NATIVE_SERIALIZE_FAILED")?));
    let contains_plaintext_key = resolved.material.is_some();
    let preview_id = remember(Pending { plugin_id, created: Instant::now(), target: target.clone(), before, kind: PendingKind::Patch {
        selection, source_revision: resolved.source.publication_revision.clone(), after, runtime_fingerprint: resolved.fingerprint } })?;
    Ok(ConfigPatchPreview { preview_id, target, fingerprint, changes, contains_plaintext_key })
}

#[tauri::command]
pub async fn plugin_cli_apply_config_patch(app: tauri::AppHandle, state: tauri::State<'_, crate::AppState>, store: tauri::State<'_, crate::config::ConfigStore>, plugin_id: String, preview_id: String) -> Result<ConfigPatchReceipt, String> {
    super::require_permission(&plugin_id, "cli.config.apply")?;
    let pending = take_preview(&plugin_id, &preview_id)?;
    let PendingKind::Patch { selection, source_revision, after, runtime_fingerprint } = &pending.kind else { return Err("CLI_NATIVE_WRONG_PREVIEW_KIND".into()); };
    unchanged(&pending.before)?;
    let resolved = resolve_patch(&state, &plugin_id, &pending.target, selection)?;
    if &resolved.source.publication_revision != source_revision || &resolved.fingerprint != runtime_fingerprint || render_patch(&pending.target, &pending.before, &resolved, selection)? != *after {
        return Err("CLI_NATIVE_PUBLICATION_DRIFT: generate a new preview".into());
    }
    let message = format!("来源插件：{}\n已发布来源：{}\n发布版本：{}\n目标：{}\n文件：\n{}\n端点：{}\n模型：{}\n推理强度：{}\n完整选择：{}\nToken 策略：{}\n选项：{}\n\n{}\n\n仅授权本次预览；外部文件修改或发布内容变化都会取消操作。",
        plugin_id, resolved.source.source_id, source_revision, pending.target.label, pending.target.paths.join("\n"), resolved.profile.base_url, model_id(&resolved.choice.selector), selection.effort.as_deref().unwrap_or("不适用"),
        serde_json::to_string(selection).map_err(|_| "CLI_NATIVE_SERIALIZE_FAILED")?, serde_json::to_string(&resolved.choice.token_policy).map_err(|_| "CLI_NATIVE_SERIALIZE_FAILED")?, serde_json::to_string(&resolved.profile.options).map_err(|_| "CLI_NATIVE_SERIALIZE_FAILED")?,
        if pending.target.target_id.starts_with("legacy:") { "是否将此已有渠道转交给已发布的插件来源？原渠道控件将变为只读，且不再显示凭据。已有原生选择需要明确重新绑定。私有明文恢复备份会保留原宿主配置，包括其中的凭据。" }
        else { "是否将此选择写入原生 CLI 配置？所选 Key 与恢复备份将以明文私有保存，在插件 registry 之外产生另一份副本。这会改变之后独立启动 CLI 时使用的配置。" });
    super::grants::confirm_desktop(&app, "写入原生配置", &message).await?;
    super::require_permission(&plugin_id, "cli.config.apply")?;
    let _native_guard = NATIVE_WRITE.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    let _config_guard = store.0.lock().map_err(|_| "CLI_NATIVE_CONFIG_LOCK_POISONED")?;
    let target = target_by_id(&pending.target.target_id)?;
    require_target_owner(&plugin_id, &target)?;
    if target != pending.target { return Err("CLI_NATIVE_TARGET_CHANGED".into()); }
    let resolved = resolve_patch(&state, &plugin_id, &target, selection)?;
    if &resolved.source.publication_revision != source_revision || &resolved.fingerprint != runtime_fingerprint || render_patch(&target, &pending.before, &resolved, selection)? != *after {
        return Err("CLI_NATIVE_PUBLICATION_DRIFT: generate a new preview".into());
    }
    unchanged(&pending.before)?;
    let receipt_id = uuid::Uuid::new_v4().to_string();
    let directory = receipt_dir(&receipt_id)?;
    private_directory(&directory)?;
    save_json(&directory.join("owner.json"), &ReceiptOwner { plugin_id, target_id: target.target_id.clone(), engine_id: target.engine_id })?;
    commit_files(&pending.before, after, &directory, None)?;
    let applied = pending.before.iter().zip(after).map(|(file, bytes)| FileSnapshot { path: file.path.clone(), bytes: bytes.clone() }).collect::<Vec<_>>();
    Ok(ConfigPatchReceipt { receipt_id, target_id: target.target_id, fingerprint: fingerprint(&applied) })
}

#[tauri::command]
pub async fn plugin_cli_restore_config_patch(app: tauri::AppHandle, store: tauri::State<'_, crate::config::ConfigStore>, plugin_id: String, receipt_id: String) -> Result<ConfigPatchReceipt, String> {
    super::require_permission(&plugin_id, "cli.config.apply")?;
    let directory = receipt_dir(&receipt_id)?;
    let owner: ReceiptOwner = load_json(&directory.join("owner.json"))?;
    if owner.plugin_id != plugin_id { return Err("CLI_NATIVE_RECEIPT_OWNERSHIP_REQUIRED".into()); }
    let message = format!("插件：{}\n目标：{}\n回执：{}\n\n是否恢复此原生配置备份？恢复操作会拒绝覆盖之后发生的外部修改；若恢复失败，备份会继续保留。", plugin_id, owner.target_id, receipt_id);
    super::grants::confirm_desktop(&app, "恢复原生配置", &message).await?;
    super::require_permission(&plugin_id, "cli.config.apply")?;
    let _native_guard = NATIVE_WRITE.lock().map_err(|_| "CLI_NATIVE_LOCK_POISONED")?;
    let _config_guard = store.0.lock().map_err(|_| "CLI_NATIVE_CONFIG_LOCK_POISONED")?;
    let mut journal: Journal = load_json(&directory.join("journal.json"))?;
    if journal.status != "applied" { return Err("CLI_NATIVE_RECEIPT_NOT_APPLIED".into()); }
    let allowed = if owner.target_id.starts_with("legacy:") { vec![crate::paths::config_path()] } else { native_paths(&owner.engine_id)? };
    if allowed != journal.paths || journal.paths.len() != journal.existed.len() { return Err("CLI_NATIVE_RECEIPT_TARGET_CHANGED".into()); }
    let current = journal.paths.iter().map(|path| snapshot(path)).collect::<Result<Vec<_>, _>>()?;
    if fingerprint(&current) != journal.after_fingerprint { return Err("CLI_NATIVE_RESTORE_CONFLICT: native files were changed after application".into()); }
    let original = journal.paths.iter().zip(&journal.existed).enumerate().map(|(index, (path, existed))| {
        let bytes = if *existed { Some(snapshot(&directory.join(format!("{index}.before")))?.bytes.ok_or("CLI_NATIVE_BACKUP_MISSING")?) } else { None };
        Ok(FileSnapshot { path: path.clone(), bytes })
    }).collect::<Result<Vec<_>, String>>()?;
    if fingerprint(&original) != journal.before_fingerprint { return Err("CLI_NATIVE_BACKUP_CORRUPTED".into()); }
    commit_files(&current, &original.iter().map(|file| file.bytes.clone()).collect::<Vec<_>>(), &directory.join(format!("restore-{}", uuid::Uuid::new_v4())), None)?;
    journal.status = "restored".into();
    if save_json(&directory.join("journal.json"), &journal).is_err() {
        commit_files(&original, &current.iter().map(|file| file.bytes.clone()).collect::<Vec<_>>(), &directory.join(format!("restore-compensation-{}", uuid::Uuid::new_v4())), None)?;
        return Err("CLI_NATIVE_RESTORE_JOURNAL_FAILED: restored files were compensated".into());
    }
    Ok(ConfigPatchReceipt { receipt_id, target_id: owner.target_id, fingerprint: fingerprint(&original) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_import_preserves_api_key_versus_bearer_with_the_same_protocol() {
        let api_key = parse_classic("claude", r#"{"env":{"ANTHROPIC_API_KEY":"api-key-secret"}}"#, "").unwrap();
        let bearer = parse_classic("claude", r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"bearer-secret"}}"#, "").unwrap();
        assert_eq!(api_key[0].metadata.protocol, bearer[0].metadata.protocol);
        assert_eq!(api_key[0].metadata.auth, ProfileAuth::ApiKey);
        assert_eq!(bearer[0].metadata.auth, ProfileAuth::Bearer);
        assert_eq!(api_key[0].value.as_deref(), Some("api-key-secret"));
        assert_eq!(bearer[0].value.as_deref(), Some("bearer-secret"));
        assert!(!serde_json::to_string(&api_key[0].metadata).unwrap().contains("api-key-secret"));
        assert!(!serde_json::to_string(&bearer[0].metadata).unwrap().contains("bearer-secret"));
    }

    #[test]
    fn codex_auth_key_is_not_assigned_to_an_unrelated_provider_or_env_reference() {
        let config = "model = \"selected-model\"\nmodel_provider = \"chosen\"\n[model_providers.chosen]\nbase_url = \"https://chosen.example/v1\"\nenv_key = \"CUSTOM_KEY\"\n[model_providers.other]\nbase_url = \"https://other.example/v1\"\n";
        let candidates = parse_classic("codex", config, r#"{"OPENAI_API_KEY":"private-key","tokens":{"access_token":"oauth-key"}}"#).unwrap();
        assert!(candidates.iter().all(|candidate| candidate.value.is_none()));
        assert_eq!(candidates.iter().find(|candidate| candidate.metadata.candidate_id == "chosen").unwrap().metadata.models, vec!["selected-model"]);
        assert!(candidates.iter().find(|candidate| candidate.metadata.candidate_id == "other").unwrap().metadata.models.is_empty());
    }

    #[test]
    fn preview_handle_is_bound_to_its_requesting_plugin() {
        let target = NativeConfigTarget { target_id:"native:claude".into(), engine_id:"claude".into(), label:"Claude".into(), paths:vec![], import_supported:true, apply_supported:true, unsupported_reason:None };
        let id = remember(Pending { plugin_id:"owner".into(), created:Instant::now(), target, before:vec![], kind:PendingKind::Import(vec![]) }).unwrap();
        assert!(take_preview("other", &id).is_err());
        assert!(take_preview("owner", &id).is_ok());
        assert!(take_preview("owner", &id).is_err());
    }

    fn scratch() -> PathBuf {
        let path = std::env::temp_dir().join(format!("ccgui-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::canonicalize(path).unwrap()
    }

    #[test]
    fn preview_does_not_copy_oauth_or_dynamic_keys() {
        let candidates = parse_pi(&json!({"providers": {
            "one": {"baseUrl":"https://example.test", "api":"openai-responses", "models":[{"id":"m"}]},
            "two": {"baseUrl":"https://example.test", "api":"openai-responses", "apiKey":"!secret-command", "models":[]}
        }}), &json!({"one":{"type":"oauth","access":"oauth-secret"}}));
        assert!(candidates.iter().all(|candidate| candidate.value.is_none()));
        let public = serde_json::to_string(&candidates.iter().map(|v| &v.metadata).collect::<Vec<_>>()).unwrap();
        assert!(!public.contains("oauth-secret"));
        assert!(!public.contains("secret-command"));
    }

    #[test]
    fn jsonc_patch_preserves_unrelated_fields_and_comments() {
        let original = "{\n // keep me\n \"env\": {\"OTHER\":\"untouched\", /* keep too */ \"ANTHROPIC_MODEL\":\"old\",},\n \"hooks\": [\"not executed\"],\n}";
        let patched = json_set(original, &["env", "ANTHROPIC_MODEL"], &json!("new")).unwrap();
        assert!(patched.contains("// keep me"));
        assert!(patched.contains("/* keep too */"));
        assert_eq!(parse_jsonc(&patched).unwrap()["env"]["OTHER"], "untouched");
        assert_eq!(parse_jsonc(&patched).unwrap()["env"]["ANTHROPIC_MODEL"], "new");
        assert_eq!(parse_jsonc(&patched).unwrap()["hooks"], json!(["not executed"]));
    }

    #[test]
    fn source_drift_rejects_without_writes() {
        let dir = scratch();
        let file = dir.join("config.json");
        std::fs::write(&file, "old").unwrap();
        let before = vec![snapshot(&file).unwrap()];
        std::fs::write(&file, "external").unwrap();
        assert!(commit_files(&before, &[Some(b"new".to_vec())], &dir.join("receipt"), None).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "external");
        assert!(!dir.join("receipt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn multi_file_failure_compensates_and_restore_refuses_external_edits() {
        let dir = scratch();
        let first = dir.join("config.toml");
        let second = dir.join("auth.json");
        std::fs::write(&first, "original config").unwrap();
        std::fs::write(&second, "original auth").unwrap();
        let before = vec![snapshot(&first).unwrap(), snapshot(&second).unwrap()];
        let desired = vec![Some(b"new config".to_vec()), Some(b"new auth".to_vec())];
        assert!(commit_files(&before, &desired, &dir.join("failed"), Some(1)).is_err());
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "original config");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "original auth");
        commit_files(&before, &desired, &dir.join("ok"), None).unwrap();
        let applied = vec![snapshot(&first).unwrap(), snapshot(&second).unwrap()];
        std::fs::write(&second, "external edit").unwrap();
        assert!(commit_files(&applied, &before.iter().map(|f| f.bytes.clone()).collect::<Vec<_>>(), &dir.join("restore"), None).is_err());
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "new config");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "external edit");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn empty_confirmation_does_not_change_source_or_return_secrets() {
        let candidate = ImportedCandidate { metadata: candidate("one", "https://example.test", CliProtocol::OpenaiResponses, ProfileAuth::Bearer, vec![], Some("secret"), vec![]), value: Some("secret".into()) };
        assert!(select_candidates(&[candidate], &[]).unwrap().is_empty());
    }
}
