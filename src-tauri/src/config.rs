use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub const LOCAL_PROVIDER_ID: &str = "__local_settings_json__";
/// Legacy kimi marker from the imported v1 config: same "use the CLI's own
/// config" semantics, different spelling.
pub(crate) const LEGACY_LOCAL_CONFIG_TOML_ID: &str = "__local_config_toml__";
pub const DISABLED_PROVIDER_ID: &str = "__disabled__";
pub const ENGINES: [&str; 11] = [
    "claude", "kimi", "grok", "codex", "pi", "omp", "dsh", "agy", "opencode", "qoder", "qoder-cn",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderSection {
    #[serde(default)]
    pub providers: serde_json::Map<String, Value>,
    #[serde(default)]
    pub current: Option<String>,
    /// Provider that was current when the engine was disabled via the
    /// enable switch, restored on re-enable. Absent while enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_from: Option<String>,
}

/// Per-engine config sections: the engine id doubles as the serialized key,
/// so the shape stays flat (`{"claude": …, "qoder-cn": …}`) while
/// section()/section_mut() dispatch is generated, not hand-written. The
/// field name is separate from the id because ids may contain '-'.
macro_rules! engine_sections {
    ($(($field:ident, $id:literal)),* $(,)?) => {
        #[derive(Debug, Clone, Serialize, Deserialize, Default)]
        pub struct CliConfig {
            $(#[serde(default, rename = $id)] pub $field: ProviderSection,)*
            /// Preserve unknown top-level fields from legacy config on import.
            #[serde(flatten)]
            pub extra: HashMap<String, Value>,
        }

        impl CliConfig {
            pub fn section(&self, engine: &str) -> Option<&ProviderSection> {
                match engine {
                    $($id => Some(&self.$field),)*
                    _ => None,
                }
            }

            pub fn section_mut(&mut self, engine: &str) -> Option<&mut ProviderSection> {
                match engine {
                    $($id => Some(&mut self.$field),)*
                    _ => None,
                }
            }
        }
    };
}

engine_sections!(
    (claude, "claude"),
    (kimi, "kimi"),
    (grok, "grok"),
    (codex, "codex"),
    (pi, "pi"),
    (omp, "omp"),
    (dsh, "dsh"),
    (agy, "agy"),
    (opencode, "opencode"),
    (qoder, "qoder"),
    (qoder_cn, "qoder-cn"),
);

#[derive(Default)]
pub struct ConfigStore(pub Mutex<()>);

pub fn read_config() -> Result<CliConfig, String> {
    let path = crate::paths::config_path();
    if !path.exists() {
        return Ok(CliConfig::default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(CliConfig::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_config(config: &CliConfig) -> Result<(), String> {
    let path = crate::paths::config_path();
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::settings::atomic_write(&path, &content)
}

/// One-time import of the legacy ~/.ccgui/config.json claude/kimi/grok
/// sections. Runs only when the new config does not exist yet.
pub fn import_legacy_config_once() {
    let new_path = crate::paths::config_path();
    if new_path.exists() {
        return;
    }
    let legacy_path = crate::paths::legacy_home().join("config.json");
    if !legacy_path.exists() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(&legacy_path) else {
        return;
    };
    let Ok(legacy) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let mut config = CliConfig::default();
    for engine in ENGINES {
        // Legacy codex providers carry configToml/authJson materialization
        // state from the pre-channel config model; skipped on import.
        if engine == "codex" {
            continue;
        }
        let Some(section) = legacy.get(engine) else {
            continue;
        };
        let providers = section
            .get("providers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let current = section
            .get("current")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(target) = config.section_mut(engine) {
            target.providers = providers;
            target.current = current;
        }
    }
    let _ = write_config(&config);
}

/// Launch gate: the 停用 pseudo-provider refuses sends. Channel env is
/// resolved at spawn (`resolve_provider_env`) and injected onto the child.
pub fn ensure_engine_enabled(engine: &str) -> Result<(), String> {
    let config = read_config()?;
    let section = config
        .section(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    if section.current.as_deref() == Some(DISABLED_PROVIDER_ID) {
        return Err(format!("engine {engine} is disabled"));
    }
    Ok(())
}

fn is_official_provider(id: &str) -> bool {
    id.is_empty() || id == LOCAL_PROVIDER_ID || id == LEGACY_LOCAL_CONFIG_TOML_ID
}

pub(crate) fn is_managed_provider(provider: &Value) -> bool {
    provider.get("__ccguiManagedBy").is_some()
}

fn public_provider(provider: &Value) -> Value {
    if !is_managed_provider(provider) {
        return provider.clone();
    }
    serde_json::json!({
        "name": provider.get("name").and_then(Value::as_str).unwrap_or("Managed channel"),
        "readOnly": true,
        "__ccguiManagedBy": {
            "sourceId": provider.pointer("/__ccguiManagedBy/sourceId").and_then(Value::as_str),
            "publicationRevision": provider.pointer("/__ccguiManagedBy/publicationRevision").and_then(Value::as_str),
        },
    })
}

fn guard_managed_channels(previous: &ProviderSection, next: &ProviderSection) -> Result<(), String> {
    for (id, provider) in &previous.providers {
        if is_managed_provider(provider) && next.providers.get(id) != Some(provider) {
            return Err("CLI_CHANNEL_MANAGED: edit this channel in its owning plugin".into());
        }
    }
    for (id, provider) in &next.providers {
        if is_managed_provider(provider) && previous.providers.get(id) != Some(provider) {
            return Err("CLI_CHANNEL_MANAGED: takeover requires confirmed published configuration".into());
        }
    }
    Ok(())
}

/// Helper to find a provider in a section by exact id or by plugin prefix/suffix match.
/// For example, "custom_123" matches "plugin_model-switcher_custom_123",
/// and "plugin_model-switcher_custom_123" matches "custom_123".
/// More than one fuzzy candidate is an error: picking by insertion order
/// could silently send the conversation to the wrong endpoint.
pub(crate) fn find_provider<'a>(
    section: &'a ProviderSection,
    id: &str,
) -> Result<Option<(&'a str, &'a Value)>, String> {
    if let Some((k, v)) = section.providers.get_key_value(id) {
        return Ok(Some((k.as_str(), v)));
    }
    // Fuzzy both ways: a key ending with "_<id>" (caller passed the id
    // without its plugin prefix), or the id ending with "_<key>" (caller
    // passed it with an extra prefix).
    let mut matches = section
        .providers
        .iter()
        .filter(|(k, _)| k.ends_with(&format!("_{id}")) || id.ends_with(&format!("_{k}")));
    let first = matches.next();
    if let Some((second, _)) = matches.next() {
        let first_key = first.map(|(k, _)| k.as_str()).unwrap_or("");
        return Err(format!(
            "provider id {id} is ambiguous: matches {first_key} and {second}"
        ));
    }
    Ok(first.map(|(k, v)| (k.as_str(), v)))
}

/// Env a spawn should inject for `provider_id` on `engine`. Official / empty
/// / unknown-but-pseudo ids yield an empty map (the CLI's own files apply).
/// `__disabled__` is a launch error. Claude is injected the same way as the
/// other engines — unlike the old spawn path which skipped it.
pub fn resolve_provider_env(
    engine: &str,
    provider_id: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    resolve_provider(engine, provider_id)?
        .map(|provider| crate::provider_files::channel_env(engine, &provider))
        .unwrap_or_else(|| Ok(HashMap::new()))
}

/// Read one channel snapshot for the whole launch (env and native overrides).
pub(crate) fn resolve_provider(
    engine: &str,
    provider_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let config = read_config()?;
    let section = config
        .section(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    let explicit = provider_id.map(str::trim).filter(|s| !s.is_empty());
    let id = explicit.unwrap_or_else(|| section.current.as_deref().unwrap_or("").trim());
    if id == DISABLED_PROVIDER_ID {
        return Err(format!("engine {engine} is disabled"));
    }
    let selected = if is_official_provider(id) { None } else { find_provider(section, id)? };
    if selected.is_some_and(|(_, provider)| is_managed_provider(provider)) {
        return Err("CLI_CHANNEL_MANAGED: select the owning plugin contribution explicitly".into());
    }
    crate::provider_files::migrate_legacy(engine, section)?;
    if is_official_provider(id) {
        return Ok(None);
    }

    if let Some((_matched_key, provider)) = selected {
        return Ok(Some(provider.clone()));
    }

    if explicit.is_some() {
        // An explicitly chosen channel that no longer resolves must not
        // silently reroute the conversation to whatever channel is current:
        // the user picked an endpoint. Fail the send so they can re-pick.
        return Err(format!("provider {id} not found for engine {engine}"));
    }

    // Only the stored current id may be stale (the channel was deleted out
    // from under the config): fall back to the official config rather than
    // fail every send.
    eprintln!("[config] current provider {id} not found for {engine}, falling back to official config");
    Ok(None)
}

// ==================== Commands ====================

#[tauri::command]
pub fn get_cli_config() -> Result<CliConfig, String> {
    let mut config = read_config()?;
    for engine in ENGINES {
        if let Some(section) = config.section_mut(engine) {
            for provider in section.providers.values_mut() {
                if is_managed_provider(provider) {
                    *provider = public_provider(provider);
                }
            }
        }
    }
    Ok(config)
}

/// Web clients receive a fresh display/model projection, never a redacted copy
/// of the flexible legacy record (which can hide keys in arbitrary fields).
pub fn get_cli_config_for_web() -> Result<CliConfig, String> {
    let config = read_config()?;
    let mut public = CliConfig::default();
    for engine in ENGINES {
        let source = config.section(engine).ok_or("unknown engine")?;
        let target = public.section_mut(engine).ok_or("unknown engine")?;
        target.current = source.current.clone();
        target.disabled_from = source.disabled_from.clone();
        for (id, provider) in &source.providers {
            if is_managed_provider(provider) {
                target.providers.insert(id.clone(), public_provider(provider));
                continue;
            }
            let mut projection = serde_json::Map::new();
            projection.insert("readOnly".into(), Value::Bool(true));
            for field in ["name", "model"] {
                if let Some(value) = provider.get(field).and_then(Value::as_str) {
                    projection.insert(field.into(), Value::String(value.into()));
                }
            }
            if engine == "codex" && !projection.contains_key("model") {
                if let Some(model) = provider.pointer("/settingsConfig/config").and_then(Value::as_str)
                    .and_then(|text| text.parse::<toml::Value>().ok())
                    .and_then(|config| config.get("model").and_then(toml::Value::as_str).map(str::to_owned)) {
                    projection.insert("model".into(), Value::String(model));
                }
            }
            let mut models = serde_json::Map::new();
            // Match providers.ts channelEnv precedence, but allow only model ids.
            for env in [provider.get("env"), provider.pointer("/settingsConfig/env")] {
                for (key, value) in env.and_then(Value::as_object).into_iter().flatten() {
                    let recognized = match engine {
                        "claude" => key == "ANTHROPIC_MODEL" || key.strip_prefix("ANTHROPIC_DEFAULT_")
                            .and_then(|key| key.strip_suffix("_MODEL"))
                            .is_some_and(|family| !family.is_empty() && family.bytes().all(|byte| byte.is_ascii_uppercase())),
                        "kimi" => key == "KIMI_MODEL_NAME",
                        "grok" => key == "GROK_MODEL",
                        _ => false,
                    };
                    if recognized {
                        if let Some(model) = value.as_str() { models.insert(key.clone(), Value::String(model.into())); }
                    }
                }
            }
            if !models.is_empty() { projection.insert("env".into(), Value::Object(models)); }
            target.providers.insert(id.clone(), Value::Object(projection));
        }
    }
    Ok(public)
}

/// Lock-free core of mutate_section: callers that already hold the
/// ConfigStore lock (cc_switch's multi-engine import) use this directly.
pub(crate) fn mutate_section_unlocked(
    engine: &str,
    mutate: impl FnOnce(&mut ProviderSection) -> Result<(), String>,
) -> Result<(), String> {
    let mut config = read_config()?;
    let section = config
        .section_mut(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    let previous = section.clone();
    mutate(section)?;
    guard_managed_channels(&previous, section)?;
    crate::provider_files::migrate_legacy(engine, &previous)?;
    write_config(&config)
}

/// Lock the store, apply `mutate` to one engine's section, persist. A
/// `mutate` error aborts before the write, leaving the config untouched.
fn mutate_section(
    store: &ConfigStore,
    engine: &str,
    mutate: impl FnOnce(&mut ProviderSection) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = store.0.lock().map_err(|e| e.to_string())?;
    mutate_section_unlocked(engine, mutate)
}

#[tauri::command]
pub fn upsert_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
    json: Value,
) -> Result<(), String> {
    upsert_provider_inner(&store, engine, id, json)
}

fn upsert_provider_inner(
    store: &ConfigStore,
    engine: String,
    id: String,
    json: Value,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.insert(id.clone(), json);
        Ok(())
    })
}

#[tauri::command]
pub fn delete_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    delete_provider_inner(&store, engine, id)
}

fn delete_provider_inner(store: &ConfigStore, engine: String, id: String) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.remove(&id);
        if section.current.as_deref() == Some(id.as_str()) {
            // Fall back to 官方配置: spawn injects nothing for official.
            section.current = None;
        }
        Ok(())
    })
}

/// Enable-switch semantics: disabling remembers the current provider in
/// `disabled_from` and parks `current` on `__disabled__`; enabling restores
/// it (falling back to 官方配置 when nothing was remembered or the remembered
/// provider was deleted in between).
#[tauri::command]
pub fn set_engine_enabled(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    enabled: bool,
) -> Result<(), String> {
    set_engine_enabled_inner(&store, engine, enabled)
}

fn set_engine_enabled_inner(
    store: &ConfigStore,
    engine: String,
    enabled: bool,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        if enabled {
            if section.current.as_deref() == Some(DISABLED_PROVIDER_ID) {
                let restore = section
                    .disabled_from
                    .take()
                    .filter(|id| id != DISABLED_PROVIDER_ID && section.providers.contains_key(id));
                let id = restore.unwrap_or_else(|| LOCAL_PROVIDER_ID.to_string());
                section.current = Some(id);
            }
        } else if section.current.as_deref() != Some(DISABLED_PROVIDER_ID) {
            section.disabled_from = section.current.clone();
            section.current = Some(DISABLED_PROVIDER_ID.to_string());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_current_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    set_current_provider_inner(&store, engine, id)
}

fn set_current_provider_inner(
    store: &ConfigStore,
    engine: String,
    id: String,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        if id != LOCAL_PROVIDER_ID
            && id != DISABLED_PROVIDER_ID
            && id != LEGACY_LOCAL_CONFIG_TOML_ID
        {
            if let Some((matched_key, provider)) = find_provider(section, &id)? {
                if is_managed_provider(provider) {
                    return Err("CLI_CHANNEL_MANAGED: select the owning plugin contribution explicitly".into());
                }
                section.current = Some(matched_key.to_string());
                return Ok(());
            }
            return Err(format!("provider {id} not found for {engine}"));
        }
        // Session-scoped: this is the default for new chats. Existing sessions
        // keep the provider they remembered; spawn injects env, never writes
        // the CLI's own config file.
        section.current = Some(id.clone());
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_providers(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    ids: Vec<String>,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        // Rebuild map in requested order; keep unknown ids at the end.
        let mut ordered = serde_json::Map::new();
        let mut remaining: Vec<(String, Value)> =
            std::mem::take(&mut section.providers).into_iter().collect();
        for id in &ids {
            if let Some(pos) = remaining.iter().position(|(k, _)| k == id) {
                let (k, v) = remaining.remove(pos);
                ordered.insert(k, v);
            }
        }
        for (k, v) in remaining {
            ordered.insert(k, v);
        }
        section.providers = ordered;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn web_channel_projection_keeps_models_but_excludes_all_flexible_secret_fields() {
        let _scratch = Scratch::new();
        crate::paths::ensure_dirs().unwrap();
        let mut config = CliConfig::default();
        config.extra.insert("unknownSecret".into(), json!("top-secret"));
        config.claude.providers.insert("channel".into(), json!({"name":"Relay", "apiKey":"key-secret", "unknown":"unknown-secret",
            "env":{"ANTHROPIC_MODEL":"wire-model","MYSTERY":"env-secret"},
            "settingsConfig":{"env":{"ANTHROPIC_AUTH_TOKEN":"auth-secret","ANTHROPIC_DEFAULT_OPUS_MODEL":"opus-wire"},"hooks":"hook-secret"}}));
        config.codex.providers.insert("codex".into(), json!({"settingsConfig":{"config":"model = \"codex-wire\"\nsecret = \"toml-secret\"", "auth":{"tokens":"oauth-secret"}}}));
        write_config(&config).unwrap();
        let public = get_cli_config_for_web().unwrap();
        let encoded = serde_json::to_string(&public).unwrap();
        assert!(!encoded.contains("secret"));
        assert_eq!(public.claude.providers["channel"]["name"], "Relay");
        assert_eq!(public.claude.providers["channel"]["env"]["ANTHROPIC_MODEL"], "wire-model");
        assert_eq!(public.claude.providers["channel"]["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "opus-wire");
        assert_eq!(public.codex.providers["codex"]["model"], "codex-wire");
    }

    #[test]
    fn managed_channels_are_secret_free_and_read_only_at_old_exits() {
        let _scratch = Scratch::new();
        crate::paths::ensure_dirs().unwrap();
        let store = ConfigStore::default();
        let managed = json!({"name":"Imported", "apiKey":"secret", "env":{"KEY":"secret"},
            "__ccguiManagedBy":{"sourceId":"plugin:test:source","publicationRevision":"one"}});
        let mut config = CliConfig::default();
        config.claude.providers.insert("managed".into(), managed.clone());
        config.claude.providers.insert("normal".into(), json!({"apiKey":"normal-secret"}));
        write_config(&config).unwrap();
        assert!(upsert_provider_inner(&store, "claude".into(), "managed".into(), json!({"apiKey":"new-secret"})).is_err());
        assert!(delete_provider_inner(&store, "claude".into(), "managed".into()).is_err());
        assert!(set_current_provider_inner(&store, "claude".into(), "managed".into()).is_err());
        assert!(resolve_provider("claude", Some("managed")).is_err());
        upsert_provider_inner(&store, "claude".into(), "normal".into(), json!({"apiKey":"allowed"})).unwrap();
        let public = get_cli_config().unwrap();
        assert!(!public.claude.providers["managed"].to_string().contains("secret"));
        assert_eq!(public.claude.providers["managed"]["readOnly"], true);
        assert_eq!(public.claude.providers["normal"]["apiKey"], "allowed");
        assert_eq!(read_config().unwrap().claude.providers["managed"], managed);
    }

    use crate::paths::HOME_ENV_LOCK;

    struct Scratch {
        dir: std::path::PathBuf,
        prev_home: Option<std::ffi::OsString>,
        prev_profile: Option<std::ffi::OsString>,
        engine_homes: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _lock: parking_lot::MutexGuard<'static, ()>,
    }
    impl Scratch {
        fn new() -> Self {
            let lock = HOME_ENV_LOCK.lock();
            let dir = std::env::temp_dir()
                .join(format!("ccgui-next-config-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let prev_home = std::env::var_os("HOME");
            let prev_profile = std::env::var_os("USERPROFILE");
            std::env::set_var("HOME", &dir);
            std::env::set_var("USERPROFILE", &dir);
            let engine_homes = [
                "CLAUDE_CONFIG_DIR",
                "CODEX_HOME",
                "KIMI_CODE_HOME",
                "GROK_HOME",
                "GROK_CONFIG_PATH",
                "GROK_AUTH_PATH",
                "ANTIGRAVITY_HOME",
            ]
            .into_iter()
            .map(|key| {
                let previous = std::env::var_os(key);
                let path = match key {
                    "GROK_CONFIG_PATH" => dir.join("grok-override/config.toml"),
                    "GROK_AUTH_PATH" => dir.join("grok-override/auth.json"),
                    _ => dir.join(key),
                };
                std::env::set_var(key, path);
                (key, previous)
            })
            .collect();
            Self {
                dir,
                prev_home,
                prev_profile,
                engine_homes,
                _lock: lock,
            }
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            for (key, previous) in &self.engine_homes {
                match previous {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            match &self.prev_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match &self.prev_profile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn seed_channel(engine: &str, id: &str, current: Option<&str>, provider: Value) {
        crate::paths::ensure_dirs().unwrap();
        let mut config = CliConfig::default();
        let section = config.section_mut(engine).unwrap();
        section.providers.insert(id.to_string(), provider);
        section.current = current.map(str::to_string);
        write_config(&config).unwrap();
    }

    #[test]
    fn resolve_provider_env_official_is_empty_and_claude_injects() {
        let _scratch = Scratch::new();
        seed_channel(
            "claude",
            "chan-a",
            Some("chan-a"),
            json!({
                "baseUrl": "https://a.example",
                "apiKey": "sk-a",
                "model": "m-a",
            }),
        );
        let env = resolve_provider_env("claude", Some("chan-a")).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://a.example")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("sk-a")
        );
        assert_eq!(env.get("ANTHROPIC_MODEL").map(String::as_str), Some("m-a"));

        let official = resolve_provider_env("claude", Some(LOCAL_PROVIDER_ID)).unwrap();
        assert!(official.is_empty());
        let empty = resolve_provider_env("claude", Some("")).unwrap();
        // Empty id falls back to section.current (chan-a).
        assert_eq!(
            empty.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://a.example")
        );
    }

    #[test]
    fn resolve_provider_env_disabled_errors() {
        let _scratch = Scratch::new();
        seed_channel("kimi", "chan-a", Some(DISABLED_PROVIDER_ID), json!({}));
        assert!(resolve_provider_env("kimi", Some(DISABLED_PROVIDER_ID)).is_err());
    }

    #[test]
    fn resolve_provider_env_matches_plugin_prefix_and_falls_back() {
        let _scratch = Scratch::new();
        seed_channel(
            "claude",
            "plugin_model-switcher_custom_1789366959743",
            Some("plugin_model-switcher_custom_1789366959743"),
            json!({
                "baseUrl": "https://tobapi.example.com",
                "apiKey": "sk-test",
            }),
        );
        // Suffix match: caller passes unprefixed id from plugin
        let env = resolve_provider_env("claude", Some("custom_1789366959743")).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://tobapi.example.com")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("sk-test")
        );

        // A stale explicit id must fail, not silently reroute the
        // conversation to whatever channel happens to be current.
        let stale = resolve_provider_env("claude", Some("deleted_channel_123"));
        assert!(stale.is_err(), "stale explicit provider id must error");
        assert!(stale.unwrap_err().contains("deleted_channel_123"));
    }

    #[test]
    fn find_provider_fails_on_ambiguous_suffix_match() {
        let _scratch = Scratch::new();
        let mut section = ProviderSection::default();
        section.providers.insert(
            "plugin_a_custom_1".to_string(),
            json!({"baseUrl": "https://a.example"}),
        );
        section.providers.insert(
            "plugin_b_custom_1".to_string(),
            json!({"baseUrl": "https://b.example"}),
        );
        assert!(find_provider(&section, "custom_1").is_err());
        // Exact id still wins over fuzzy candidates.
        section
            .providers
            .insert("custom_1".to_string(), json!({"baseUrl": "https://exact.example"}));
        let (key, _) = find_provider(&section, "custom_1").unwrap().unwrap();
        assert_eq!(key, "custom_1");
    }

    #[test]
    fn set_current_provider_does_not_write_native_files() {
        let _scratch = Scratch::new();
        let store = ConfigStore::default();
        for engine in ENGINES {
            seed_channel(
                engine,
                "chan-a",
                None,
                json!({"baseUrl":"https://a.example", "apiKey":"sk-a"}),
            );
            let paths = crate::provider_files::provider_file_paths(engine.into());
            for path in &paths {
                std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
                // Intentionally arbitrary bytes: switching must not parse/reformat
                // an existing native file when there is no legacy migration.
                std::fs::write(path, "# user's own config\n中文 🧪\n").unwrap();
            }
            for id in ["chan-a", LOCAL_PROVIDER_ID, "chan-a"] {
                set_current_provider_inner(&store, engine.into(), id.into()).unwrap();
                assert_eq!(
                    read_config()
                        .unwrap()
                        .section(engine)
                        .unwrap()
                        .current
                        .as_deref(),
                    Some(id)
                );
            }
            assert!(set_current_provider_inner(&store, engine.into(), "missing".into()).is_err());
            upsert_provider_inner(
                &store,
                engine.into(),
                "chan-a".into(),
                json!({"apiKey":"updated"}),
            )
            .unwrap();
            set_engine_enabled_inner(&store, engine.into(), false).unwrap();
            set_engine_enabled_inner(&store, engine.into(), true).unwrap();
            delete_provider_inner(&store, engine.into(), "chan-a".into()).unwrap();
            for path in &paths {
                assert_eq!(
                    std::fs::read_to_string(path).unwrap(),
                    "# user's own config\n中文 🧪\n",
                    "{engine}: {path}"
                );
                std::fs::remove_file(path).unwrap();
            }
            upsert_provider_inner(
                &store,
                engine.into(),
                "chan-a".into(),
                json!({"apiKey":"new"}),
            )
            .unwrap();
            set_current_provider_inner(&store, engine.into(), "chan-a".into()).unwrap();
            for path in paths {
                assert!(!std::path::Path::new(&path).exists());
            }
        }
    }
}
