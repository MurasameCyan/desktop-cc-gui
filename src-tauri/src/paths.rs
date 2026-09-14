use std::path::PathBuf;

/// Home dir without panicking: a headless/odd environment falls back to the
/// current directory so startup degrades instead of crashing.
fn home_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Application home directory: ~/.ccgui-next/
pub fn app_home() -> PathBuf {
    home_dir().join(".ccgui-next")
}

pub fn legacy_home() -> PathBuf {
    home_dir().join(".ccgui")
}

/// Legacy desktop-cc-gui's workspace list: its Tauri app-data dir (bundle id
/// `com.zhukunpenglinyutong.ccgui`) holds workspaces.json — the sidebar the
/// upgrade imports on first launch so old users keep their workspaces.
pub fn legacy_workspaces_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(home_dir);
    base.join("com.zhukunpenglinyutong.ccgui")
        .join("workspaces.json")
}

/// Legacy app's settings next to its workspace list: holds `workspaceGroups`
/// (sidebar 分组定义), imported on upgrade so groups survive the switch.
pub fn legacy_settings_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(home_dir);
    base.join("com.zhukunpenglinyutong.ccgui")
        .join("settings.json")
}

pub fn config_path() -> PathBuf {
    app_home().join("config.json")
}

pub fn settings_path() -> PathBuf {
    app_home().join("settings.json")
}

pub fn db_path() -> PathBuf {
    app_home().join("app.db")
}

/// Directory containing the running executable (portable/program storage base).
pub fn program_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("resolve current executable: {error}"))?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "current executable has no parent directory".to_string())
}

pub fn ensure_dirs() -> std::io::Result<()> {
    std::fs::create_dir_all(app_home())?;
    Ok(())
}
