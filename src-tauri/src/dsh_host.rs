//! DeepSeek Harness (DSH) local-host maintenance: probe/adopt/spawn/stop the
//! `dsh web` server. CLI version/update lives in [`crate::cli_lifecycle`].
//!
//! Wire protocol (verified against the reference desktop-cc-gui):
//! `POST {origin}/api/host.describe` with
//! `{type:"client-request",rpcId,method:"host.describe",payload:{}}` →
//! `{type:"server-response",rpcId,result:{ok:true,value}|{ok:false,error}}`.
//!
//! Ownership rule: only hosts we spawned are tracked in [`DshHostState`] and
//! killed (app exit / dsh_host_stop). A pre-existing host answering describe
//! is adopted and never killed — except via dsh_host_stop's local-listener
//! termination, which only ever targets loopback addresses.

use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Child;
use tokio::time::{sleep, Instant};

use crate::engine::{command_for_binary, resolve};
use crate::settings::AppSettings;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3080;
const DESCRIBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(800);
const DESCRIBE_TOTAL_TIMEOUT: Duration = Duration::from_secs(3);
const SPAWN_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Windows npm shims chain through cmd → node and cold-start noticeably
/// slower; give the spawn readiness poll extra headroom there.
#[cfg(windows)]
const SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(not(windows))]
const SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// Bytes of spawned-host stdout+stderr kept for error reporting.
const RING_CAP: usize = 8192;
// ==================== State ====================

/// Managed inside AppState; holds the spawned host child, if any.
#[derive(Default)]
pub struct DshHostState {
    spawned: Mutex<Option<Spawned>>,
    /// Serializes ensure (adopt-or-spawn) so autostart and a manual start
    /// never race each other into two spawns of the same port.
    ensure: tokio::sync::Mutex<()>,
}

struct Spawned {
    child: Child,
    origin: String,
}

impl Drop for Spawned {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            crate::engine::kill_process_group(pid);
        }
        let _ = self.child.start_kill();
    }
}

impl DshHostState {
    /// Kill only the host child we spawned (window Destroyed). Adopted hosts
    /// are never tracked, so they survive us by construction.
    pub fn kill_spawned(&self) {
        let mut guard = lock(&self.spawned);
        // Drop of Spawned kills the process group.
        guard.take();
    }

    fn spawned_origin(&self) -> Option<String> {
        lock(&self.spawned)
            .as_ref()
            .map(|spawned| spawned.origin.clone())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ==================== Config / status ====================

struct HostConfig {
    host: String,
    port: u16,
    origin: String,
    auto_start: bool,
}

impl HostConfig {
    fn from(settings: &AppSettings) -> Self {
        let host = settings
            .dsh_host
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or(DEFAULT_HOST)
            .to_string();
        let port = settings.dsh_port.filter(|p| *p > 0).unwrap_or(DEFAULT_PORT);
        let origin = format!("http://{host}:{port}");
        let auto_start = settings.dsh_auto_start != Some(false);
        Self {
            host,
            port,
            origin,
            auto_start,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DshHostStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub host: String,
    pub port: u16,
    pub origin: String,
    pub auto_start: bool,
    pub running: bool,
    /// "spawned" when the answering host is our child, "adopted" when it
    /// predates us; null when nothing is running.
    pub ownership: Option<&'static str>,
    /// Raw host.describe value (provider/model/attachedSessions/version/cwd).
    pub describe: Option<Value>,
    /// Set only when the host is not running and the probe produced an error.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
}
// ==================== Probes ====================

fn http_client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .connect_timeout(DESCRIBE_CONNECT_TIMEOUT)
            .timeout(DESCRIBE_TOTAL_TIMEOUT)
            .build()
            .expect("reqwest client")
    });
    &CLIENT
}

/// Configured `http://host:port` origin for the DSH host.
pub(crate) fn configured_origin(settings: &AppSettings) -> String {
    HostConfig::from(settings).origin
}

/// One `host.describe` round-trip against `origin`.
pub(crate) async fn probe_describe(origin: &str) -> Result<Value, String> {
    host_call(origin, "host.describe", json!({})).await
}

/// One unary RPC round-trip: `POST {origin}/api/{method}` with the
/// client-request envelope, returning the server-response `result.value`.
pub(crate) async fn host_call(origin: &str, method: &str, payload: Value) -> Result<Value, String> {
    let body = json!({
        "type": "client-request",
        "rpcId": uuid::Uuid::new_v4().to_string(),
        "method": method,
        "payload": payload,
    });
    let response = http_client()
        .post(format!("{origin}/api/{method}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("无法连接 {origin}（{e}）"))?;
    let envelope: Value = {
        let text = response
            .text()
            .await
            .map_err(|e| format!("{method} 响应读取失败（{e}）"))?;
        serde_json::from_str(&text).map_err(|e| format!("{method} 响应解析失败（{e}）"))?
    };
    if envelope.get("type").and_then(Value::as_str) != Some("server-response") {
        return Err(format!("{method} 响应格式不正确（非 server-response）"));
    }
    let result = envelope.get("result").cloned().unwrap_or(Value::Null);
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(result.get("value").cloned().unwrap_or(Value::Null));
    }
    let message = result
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("未知错误");
    Err(format!("{method} 被拒绝：{message}"))
}

/// `dsh` binary: settings `dshBin` override (validated) else PATH resolution.
fn dsh_bin(settings: &AppSettings) -> String {
    if let Some(custom) = settings.bin_override("dsh") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            match crate::settings::validate_bin_override(trimmed) {
                Ok(path) => {
                    return resolve::resolve_launchable_cli_binary(&path.to_string_lossy())
                }
                Err(reason) => {
                    eprintln!("[dsh] ignoring invalid dsh bin override: {reason}");
                }
            }
        }
    }
    resolve::resolve_launchable_cli_binary("dsh")
}

/// Drain a long-lived child's stream into the last-RING_CAP-bytes ring.
fn spawn_ring_drain<R: AsyncRead + Unpin + Send + 'static>(pipe: R, buf: Arc<Mutex<String>>) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(pipe);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let mut guard = lock(&buf);
                    guard.push_str(&line);
                    if guard.len() > RING_CAP {
                        let mut start = guard.len() - RING_CAP;
                        while !guard.is_char_boundary(start) {
                            start += 1;
                        }
                        guard.drain(..start);
                    }
                }
            }
        }
    });
}

fn ring_snapshot(buf: &Mutex<String>) -> String {
    lock(buf).trim().to_string()
}

// ==================== ensure (adopt-or-spawn) ====================

/// Adopt the host if it already answers, otherwise spawn `dsh web` and wait
/// for readiness. Used by dsh_host_start and the setup autostart task.
pub(crate) async fn ensure_host(
    host_state: &DshHostState,
    settings: &AppSettings,
) -> Result<(), String> {
    let _serialize = host_state.ensure.lock().await;
    let cfg = HostConfig::from(settings);

    // Fast path: anything already answering at the origin is adopted as-is
    // (including our own still-live spawned child from an earlier start).
    if probe_describe(&cfg.origin).await.is_ok() {
        return Ok(());
    }

    let bin = dsh_bin(settings);
    let mut command = command_for_binary(&bin);
    command
        .arg("web")
        .arg("--host")
        .arg(&cfg.host)
        .arg("--port")
        .arg(cfg.port.to_string())
        // The GUI talks to the host over HTTP itself; opening a browser tab
        // on every app launch is pure noise.
        .arg("--no-open");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    crate::engine::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| {
        format!("无法启动 dsh web（{bin}）：{e}。请确认已安装 @deepseek-ai/dsh，或检查自定义路径。")
    })?;
    let output = Arc::new(Mutex::new(String::new()));
    if let Some(stdout) = child.stdout.take() {
        spawn_ring_drain(stdout, Arc::clone(&output));
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_ring_drain(stderr, Arc::clone(&output));
    }

    let deadline = Instant::now() + SPAWN_READY_TIMEOUT;
    loop {
        if probe_describe(&cfg.origin).await.is_ok() {
            *lock(&host_state.spawned) = Some(Spawned {
                child,
                origin: cfg.origin.clone(),
            });
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // Spawn race: our child died but another host now answers —
                // adopt it instead of erroring.
                if probe_describe(&cfg.origin).await.is_ok() {
                    return Ok(());
                }
                let tail = ring_snapshot(&output);
                return Err(format!(
                    "dsh web 启动后立即退出（{status}）。{}",
                    if tail.is_empty() {
                        "无输出。".to_string()
                    } else {
                        format!("输出：{tail}")
                    }
                ));
            }
            Ok(None) => {}
            Err(e) => {
                let _ = child.start_kill();
                return Err(format!("dsh web 状态检查失败：{e}"));
            }
        }
        if Instant::now() >= deadline {
            // Spawn race on timeout: another host won the port meanwhile.
            if probe_describe(&cfg.origin).await.is_ok() {
                let _ = child.start_kill();
                return Ok(());
            }
            let tail = ring_snapshot(&output);
            let _ = child.start_kill();
            return Err(format!(
                "等待 dsh host 就绪超时（{} 秒，{}）。{}",
                SPAWN_READY_TIMEOUT.as_secs(),
                cfg.origin,
                if tail.is_empty() {
                    String::new()
                } else {
                    format!("输出：{tail}")
                }
            ));
        }
        sleep(SPAWN_POLL_INTERVAL).await;
    }
}

async fn status_snapshot(host_state: &DshHostState, settings: &AppSettings) -> DshHostStatus {
    let cfg = HostConfig::from(settings);
    let bin = dsh_bin(settings);
    let (cli, describe) = tokio::join!(crate::cli_lifecycle::probe_local_version(&bin), probe_describe(&cfg.origin));
    let running = describe.is_ok();
    let ownership = if running {
        Some(
            if host_state.spawned_origin().as_deref() == Some(cfg.origin.as_str()) {
                "spawned"
            } else {
                "adopted"
            },
        )
    } else {
        None
    };
    let (describe, error) = match describe {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    DshHostStatus {
        installed: cli.installed,
        version: cli.version,
        host: cfg.host,
        port: cfg.port,
        origin: cfg.origin.clone(),
        auto_start: cfg.auto_start,
        running,
        ownership,
        describe,
        error,
    }
}

// ==================== Commands ====================

#[tauri::command]
pub async fn dsh_host_status(state: tauri::State<'_, crate::AppState>) -> Result<DshHostStatus, String> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    Ok(status_snapshot(&state.dsh_host, &settings).await)
}

#[tauri::command]
pub async fn dsh_host_start(
    state: tauri::State<'_, crate::AppState>,
) -> Result<DshHostStatus, String> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    ensure_host(&state.dsh_host, &settings).await?;
    Ok(status_snapshot(&state.dsh_host, &settings).await)
}

#[tauri::command]
pub async fn dsh_host_stop(state: tauri::State<'_, crate::AppState>) -> Result<OkResult, String> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    let cfg = HostConfig::from(&settings);
    // Kill only our own spawned child first.
    state.dsh_host.kill_spawned();
    if !is_local_host(&cfg.host) {
        return Err("只能停止本机的 DSH host，远程地址不会被关闭。".to_string());
    }
    // Someone else's listener on the port (adopted or foreign): terminate it.
    if probe_describe(&cfg.origin).await.is_ok() {
        terminate_local_listener(cfg.port, &cfg.origin).await?;
    }
    Ok(OkResult { ok: true })
}

// ==================== Stop helpers ====================

fn is_local_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "0.0.0.0" | "[::1]" | "[::]"
    )
}

/// Terminate whatever listens on `port`: SIGTERM, re-probe, SIGKILL if the
/// host still answers.
#[cfg(unix)]
async fn terminate_local_listener(port: u16, origin: &str) -> Result<(), String> {
    let output = std::process::Command::new("lsof")
        .arg("-n")
        .arg("-P")
        .arg("-t")
        .arg(format!("-iTCP:{port}"))
        .arg("-sTCP:LISTEN")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("检查端口 {port} 失败：{e}"))?;
    let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();
    if pids.is_empty() {
        return Ok(());
    }
    for pid in &pids {
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();
    }
    sleep(Duration::from_millis(500)).await;
    if probe_describe(origin).await.is_ok() {
        for pid in &pids {
            let _ = std::process::Command::new("kill")
                .arg("-KILL")
                .arg(pid.to_string())
                .status();
        }
    }
    Ok(())
}

#[cfg(windows)]
async fn terminate_local_listener(port: u16, _origin: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut netstat = std::process::Command::new("netstat");
    netstat
        .args(["-ano", "-p", "tcp"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let output = netstat
        .output()
        .map_err(|e| format!("检查端口 {port} 失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let needle = format!(":{port}");
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if cols[1].ends_with(&needle) {
            if let Ok(pid) = cols[4].parse::<u32>() {
                pids.push(pid);
            }
        }
    }
    for pid in pids {
        let mut taskkill = std::process::Command::new("taskkill");
        taskkill
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = taskkill.status();
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
async fn terminate_local_listener(_port: u16, _origin: &str) -> Result<(), String> {
    Err("当前平台不支持停止本机 DSH host。".to_string())
}
