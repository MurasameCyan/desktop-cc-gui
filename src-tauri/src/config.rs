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

/// Launch gate: the 停用 pseudo-provider refuses sends. The active channel
/// itself lives in each CLI's native config file — `provider_files::apply`
/// writes it on every switch, so there is nothing to resolve at spawn time.
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

// ==================== Commands ====================

#[tauri::command]
pub fn get_cli_config() -> Result<CliConfig, String> {
    read_config()
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
    mutate(section)?;
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

/// Re-apply the active channel to the CLI's native config after its stored
/// value changed (edit/save on the current channel, delete of the current
/// channel, enable-switch restore).
fn apply_if_current(engine: &str, id: &str) -> Result<(), String> {
    let config = read_config()?;
    let Some(section) = config.section(engine) else {
        return Ok(());
    };
    let current = section.current.as_deref().unwrap_or("");
    if current == id {
        crate::provider_files::apply(engine, id, section.providers.get(id))?;
    }
    Ok(())
}

#[tauri::command]
pub fn upsert_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
    json: Value,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.insert(id.clone(), json);
        Ok(())
    })?;
    apply_if_current(&engine, &id)
}

#[tauri::command]
pub fn delete_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    let mut deleted_current = false;
    mutate_section(&store, &engine, |section| {
        section.providers.remove(&id);
        if section.current.as_deref() == Some(id.as_str()) {
            section.current = None;
            deleted_current = true;
        }
        Ok(())
    })?;
    if deleted_current {
        // Deleting the active channel falls back to 官方配置: restore the
        // CLI's own config file.
        crate::provider_files::apply(&engine, LOCAL_PROVIDER_ID, None)?;
    }
    Ok(())
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
    let mut restored: Option<(String, Option<Value>)> = None;
    mutate_section(&store, &engine, |section| {
        if enabled {
            if section.current.as_deref() == Some(DISABLED_PROVIDER_ID) {
                let restore = section
                    .disabled_from
                    .take()
                    .filter(|id| id != DISABLED_PROVIDER_ID && section.providers.contains_key(id));
                let id = restore.unwrap_or_else(|| LOCAL_PROVIDER_ID.to_string());
                restored = Some((id.clone(), section.providers.get(&id).cloned()));
                section.current = Some(id);
            }
        } else if section.current.as_deref() != Some(DISABLED_PROVIDER_ID) {
            section.disabled_from = section.current.clone();
            section.current = Some(DISABLED_PROVIDER_ID.to_string());
        }
        Ok(())
    })?;
    // Re-enabling onto a real channel re-materializes it into the CLI's
    // config file; disabling touches no files (gate only).
    if let Some((id, provider)) = restored {
        crate::provider_files::apply(&engine, &id, provider.as_ref())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_current_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    let _guard = store.0.lock().map_err(|e| e.to_string())?;
    let provider = {
        let config = read_config()?;
        let section = config
            .section(&engine)
            .ok_or_else(|| format!("unknown engine: {engine}"))?;
        if id != LOCAL_PROVIDER_ID
            && id != DISABLED_PROVIDER_ID
            && id != LEGACY_LOCAL_CONFIG_TOML_ID
            && !section.providers.contains_key(&id)
        {
            return Err(format!("provider {id} not found for {engine}"));
        }
        section.providers.get(&id).cloned()
    };
    // Write the CLI's native config first: a file error leaves our store
    // untouched, so the UI never shows a channel the CLI isn't running on.
    crate::provider_files::apply(&engine, &id, provider.as_ref())?;
    mutate_section_unlocked(&engine, |section| {
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
