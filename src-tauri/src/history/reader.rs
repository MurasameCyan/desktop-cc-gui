use super::{parse_session_file, Message, ParsedSession, SessionMeta};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub messages: Vec<Message>,
    pub next_before: Option<i64>,
}

/// Lock the db, run a parameterless query, and collect rows through `map_row`.
fn query_rows<T>(
    state: &crate::AppState,
    sql: &str,
    map_row: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let conn = state.db.0.lock();
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_row).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(value) => out.push(value),
            Err(e) => eprintln!("[history] skipping undecodable row: {e}"),
        }
    }
    Ok(out)
}

/// Run a sessions-table mutation, then notify listeners.
fn mutate_sessions(
    state: &crate::AppState,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<(), String> {
    let conn = state.db.0.lock();
    conn.execute(sql, params).map_err(|e| e.to_string())?;
    drop(conn);
    state.sink.emit_sessions_changed();
    Ok(())
}

#[tauri::command]
pub fn list_sessions(state: tauri::State<'_, crate::AppState>) -> Result<Vec<SessionMeta>, String> {
    query_rows(
        &state,
        "SELECT engine, session_id, workspace_path, file_path, file_size, file_mtime_ms,
                title, preview, created_at, updated_at, message_count, pinned, custom_title
         FROM sessions ORDER BY COALESCE(updated_at, 0) DESC",
        |r| {
            Ok(SessionMeta {
                engine: r.get(0)?,
                session_id: r.get(1)?,
                workspace_path: r.get(2)?,
                file_path: r.get(3)?,
                file_size: r.get(4)?,
                file_mtime_ms: r.get(5)?,
                title: r.get(6)?,
                preview: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                message_count: r.get(10)?,
                pinned: r.get::<_, i64>(11)? != 0,
                custom_title: r.get(12)?,
            })
        },
    )
}

fn session_file_path(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    let conn = db.0.lock();
    conn.query_row(
        "SELECT file_path FROM sessions WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id],
        |r| r.get::<_, String>(0),
    )
    .map(PathBuf::from)
    .map_err(|_| format!("session not found: {engine}/{session_id}"))
}

/// Parsed sessions keyed by (path, size, mtime_ms, accepted-frame signature):
/// paging re-slices a cached parse instead of re-reading the file. The
/// signature belongs in the key because recording a newly accepted frame
/// changes what the parse must hide while the file's stat key is unchanged.
/// Bounded two ways: 32 entries and a ~128MB byte budget (image data URLs
/// make entries heavy).
static PARSED_CACHE: LazyLock<Mutex<HashMap<(PathBuf, i64, i64, String), Arc<ParsedSession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PARSED_CACHE_BYTES: LazyLock<Mutex<usize>> = LazyLock::new(|| Mutex::new(0));

const PARSED_CACHE_CAPACITY: usize = 32;
const PARSED_CACHE_BUDGET_BYTES: usize = 128 * 1024 * 1024;

/// Rough in-memory footprint of one parsed session (text + image payloads).
fn parsed_footprint(parsed: &ParsedSession) -> usize {
    parsed
        .messages
        .iter()
        .map(|m| {
            m.text.len()
                + m.images.iter().map(|i| i.len()).sum::<usize>()
                + m.ts.as_deref().map(str::len).unwrap_or(0)
                + 128
        })
        .sum()
}

fn cached_parse_session(
    engine: &str,
    path: &Path,
    accepted_frames: &HashSet<String>,
    accepted_signature: &str,
) -> Result<Arc<ParsedSession>, String> {
    let Some((size, mtime_ms)) = super::stat_signature(path) else {
        // Unstattable file: let the parse produce the real error.
        return parse_session_file(engine, path, accepted_frames).map(Arc::new);
    };
    let key = (
        path.to_path_buf(),
        size,
        mtime_ms,
        accepted_signature.to_string(),
    );
    if let Some(hit) = PARSED_CACHE.lock().map_err(|e| e.to_string())?.get(&key) {
        return Ok(Arc::clone(hit));
    }
    let parsed = Arc::new(parse_session_file(engine, path, accepted_frames)?);
    let footprint = parsed_footprint(&parsed);
    let mut cache = PARSED_CACHE.lock().map_err(|e| e.to_string())?;
    let mut bytes = PARSED_CACHE_BYTES.lock().map_err(|e| e.to_string())?;
    // Over budget or capacity: drop everything rather than evicting entries
    // one by one (pages are re-parseable, and scans are cheap by stat key).
    if cache.len() >= PARSED_CACHE_CAPACITY || *bytes + footprint > PARSED_CACHE_BUDGET_BYTES {
        cache.clear();
        *bytes = 0;
    }
    *bytes += footprint;
    cache.insert(key, Arc::clone(&parsed));
    Ok(parsed)
}

/// Sync body of `load_session_page` (parsing multi-MB session files must not
/// run on the IPC main thread).
fn load_session_page_blocking(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
    limit: Option<usize>,
    before_seq: Option<i64>,
) -> Result<SessionPage, String> {
    let path = session_file_path(db, engine, session_id)?;
    let (accepted_frames, accepted_signature) = db.accepted_internal_frames(engine, session_id)?;
    let parsed = cached_parse_session(engine, &path, &accepted_frames, &accepted_signature)?;
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let messages = &parsed.messages;
    let (page, next_before) = match before_seq {
        Some(before) => {
            let end = messages
                .iter()
                .position(|m| m.seq >= before)
                .unwrap_or(messages.len());
            let start = end.saturating_sub(limit);
            let next = if start > 0 {
                messages.get(start).map(|m| m.seq)
            } else {
                None
            };
            (messages[start..end].to_vec(), next)
        }
        None => {
            let start = messages.len().saturating_sub(limit);
            let next = if start > 0 {
                messages.get(start).map(|m| m.seq)
            } else {
                None
            };
            (messages[start..].to_vec(), next)
        }
    };
    Ok(SessionPage {
        messages: page,
        next_before,
    })
}

#[tauri::command]
pub async fn load_session_page(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
) -> Result<SessionPage, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        load_session_page_blocking(&db, &engine, &session_id, limit, before_seq)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove the session's on-disk file/dir. kimi/grok wire files live under a
/// per-session dir — validated against the engine home before removal so a
/// corrupt/stale db row can never point remove_dir_all at an arbitrary tree.
/// Returns Ok when the disk state is gone (or wisely skipped), Err when the
/// removal failed — callers keep the db row on Err so a session cannot
/// "delete then resurrect" on the next scan.
fn delete_session_disk(engine: &str, path: &Path) -> Result<(), String> {
    match engine {
        "claude" | "codex" | "pi" | "omp" => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {}: {e}", path.display())),
        },
        _ => {
            // kimi: .../<sessionDir>/agents/main/wire.jsonl -> <sessionDir>
            // grok: .../<sessionDir>/chat_history.jsonl -> <sessionDir>
            let Some(session_dir) = (if engine == "kimi" {
                path.parent()
                    .and_then(|p| p.parent())
                    .and_then(|a| a.parent())
            } else {
                path.parent()
            }) else {
                return Err(format!("no session dir for {}", path.display()));
            };
            let home = crate::engine::engine_home(
                None,
                if engine == "kimi" {
                    ".kimi-code"
                } else {
                    ".grok"
                },
            );
            let anchored = crate::files::canonicalize_lenient(session_dir)
                .map(|resolved| {
                    crate::files::canonicalize_lenient(&home)
                        .map(|root| resolved.starts_with(root))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            // Kimi dirs must show the expected agents/main/wire.jsonl shape.
            let structure_ok = if engine == "kimi" {
                session_dir
                    .join("agents")
                    .join("main")
                    .join("wire.jsonl")
                    .is_file()
            } else {
                session_dir.join("chat_history.jsonl").is_file()
            };
            if !anchored || !structure_ok {
                eprintln!(
                    "[history] refusing disk delete outside {} home or unexpected layout: {}",
                    engine,
                    session_dir.display()
                );
                return Ok(());
            }
            match std::fs::remove_dir_all(session_dir) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("remove {}: {e}", session_dir.display())),
            }
        }
    }
}

/// Sync body of `delete_session` (disk + db work off the main thread).
fn delete_session_blocking(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    let path = session_file_path(db, engine, session_id)?;
    delete_session_disk(engine, &path)?;
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // The recorded frame identities are scoped to this session and become
    // unreachable with it. Every scan reads and hashes the whole table, so
    // leaving them behind would tax every later scan for the life of the
    // install.
    tx.execute(
        "DELETE FROM accepted_internal_frames WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM sessions WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    let sink = Arc::clone(&state.sink);
    tauri::async_runtime::spawn_blocking(move || {
        delete_session_blocking(&db, &engine, &session_id)
    })
    .await
    .map_err(|e| e.to_string())??;
    sink.emit_sessions_changed();
    Ok(())
}

#[tauri::command]
pub fn pin_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    mutate_sessions(
        &state,
        "UPDATE sessions SET pinned=?3 WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id, pinned as i64],
    )
}

#[tauri::command]
pub fn rename_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let value = if title.trim().is_empty() {
        None
    } else {
        Some(title.trim().to_string())
    };
    mutate_sessions(
        &state,
        "UPDATE sessions SET custom_title=?3 WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id, value],
    )
}

#[tauri::command]
pub fn rescan_sessions(state: tauri::State<'_, crate::AppState>) {
    super::scanner::spawn_scan(Arc::clone(&state.db), Arc::clone(&state.sink));
}

/// Frames recorded for one session. A long-lived session can accept a snapshot
/// every turn; this bounds what one session contributes to the table. The
/// earliest identities are the ones kept — evicting one would unhide a frame
/// the user has already stopped seeing.
const MAX_RECORDED_FRAMES_PER_SESSION: i64 = 5_000;

/// Ceiling across every session. The per-session cap alone bounds nothing
/// globally, because the scope is chosen by the caller; every scan reads and
/// hashes this whole table, so unbounded growth is a permanent tax.
const MAX_RECORDED_FRAMES_TOTAL: i64 = 100_000;

/// Longest native session id an identity is scoped to. Native ids are short
/// (uuid-like), so this only rejects abuse.
const MAX_RECORDED_SESSION_ID_LEN: usize = 128;

/// Normalize and bound the scope one recorded identity is stored under: the
/// engine must be one this app runs, and the session id must be short enough
/// to be a native id. Without both, a caller could turn the table into
/// arbitrary unbounded storage that slows every later scan.
fn recordable_frame_scope(engine: &str, session_id: &str) -> Result<(String, String), String> {
    let engine = engine.trim();
    let session_id = session_id.trim();
    if !crate::config::ENGINES.contains(&engine) {
        return Err(format!("unknown engine: {engine}"));
    }
    if session_id.is_empty() || session_id.len() > MAX_RECORDED_SESSION_ID_LEN {
        return Err("session id is empty or longer than a native id".to_string());
    }
    Ok((engine.to_string(), session_id.to_string()))
}

/// Record the identity of one internal frame a live capture validator accepted.
/// The frame itself stays in the native transcript; only its hash is stored, so
/// the history parser can hide exactly the frames the user was never meant to
/// see while unrecorded look-alikes, malformed frames, and model prose stay
/// visible.
///
/// The host re-derives the identity from the frame bytes rather than trusting
/// the caller, and bounds the scope it will store. It cannot verify *which*
/// capture accepted the frame — validators run in the renderer — so this is a
/// trusted-caller command: the plugin bridge's allowlist covers only its
/// http/exec commands and rejects this one.
#[tauri::command]
pub async fn record_accepted_internal_frame(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    frame: String,
) -> Result<(), String> {
    let (engine, session_id) = recordable_frame_scope(&engine, &session_id)?;
    let Some(frame_hash) = super::recordable_internal_frame_hash(&frame) else {
        return Err("frame is not one complete internal frame with a JSON payload".to_string());
    };
    let db = Arc::clone(&state.db);
    let sink = Arc::clone(&state.sink);
    let stale_summary = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let conn = db.0.lock();
        let (for_session, total): (i64, i64) = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM accepted_internal_frames
                      WHERE engine=?1 AND session_id=?2),
                    (SELECT COUNT(*) FROM accepted_internal_frames)",
                rusqlite::params![engine, session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        // At capacity the identity cannot be stored, so the frame will be
        // visible again on reload: report it instead of answering success,
        // which would look identical to a stored identity.
        if for_session >= MAX_RECORDED_FRAMES_PER_SESSION || total >= MAX_RECORDED_FRAMES_TOTAL {
            return Err(format!(
                "accepted-frame table is at capacity for {engine}/{session_id}"
            ));
        }
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO accepted_internal_frames(engine, session_id, frame_hash) VALUES(?1, ?2, ?3)",
                rusqlite::params![engine, session_id, frame_hash],
            )
            .map_err(|error| error.to_string())?
            != 0;
        if !inserted {
            return Ok(false);
        }
        // Only an indexed session has a stored summary that now hides fewer
        // frames than it should. One the scanner has never reached derives its
        // summary from the identity set current at that time, so rescanning for
        // it here would be pure amplification.
        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE engine=?1 AND session_id=?2",
                rusqlite::params![engine, session_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(indexed > 0)
    })
    .await
    .map_err(|error| error.to_string())??;
    if stale_summary {
        // This session's stored summary still hides only the previously
        // recorded frames; rebuild it from the enlarged identity set.
        super::scanner::spawn_scan(Arc::clone(&state.db), Arc::clone(&sink));
    }
    Ok(())
}

// ==================== Workspaces ====================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub last_opened_at: Option<i64>,
    pub sort_order: Option<i64>,
    /// Sidebar group (工作区分组) this workspace belongs to; None = ungrouped.
    pub group_id: Option<String>,
}

#[tauri::command]
pub fn list_workspaces(state: tauri::State<'_, crate::AppState>) -> Result<Vec<Workspace>, String> {
    query_rows(
        &state,
        "SELECT id, path, name, last_opened_at, sort_order, group_id FROM workspaces
         ORDER BY sort_order IS NULL, sort_order, COALESCE(last_opened_at, 0) DESC",
        |r| {
            Ok(Workspace {
                id: r.get(0)?,
                path: r.get(1)?,
                name: r.get(2)?,
                last_opened_at: r.get(3)?,
                sort_order: r.get(4)?,
                group_id: r.get(5)?,
            })
        },
    )
}

#[tauri::command]
pub fn add_workspace(
    state: tauri::State<'_, crate::AppState>,
    path: String,
) -> Result<Workspace, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    let dir = std::path::PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Err(format!("not a directory: {trimmed}"));
    }
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(trimmed)
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    {
        let conn = state.db.0.lock();
        conn.execute(
            "INSERT INTO workspaces(id, path, name, last_opened_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(path) DO UPDATE SET last_opened_at=excluded.last_opened_at",
            rusqlite::params![id, trimmed, name, now],
        )
        .map_err(|e| e.to_string())?;
    }
    super::scanner::spawn_scan(Arc::clone(&state.db), Arc::clone(&state.sink));
    Ok(Workspace {
        id,
        path: trimmed.to_string(),
        name,
        last_opened_at: Some(now),
        sort_order: None,
        group_id: None,
    })
}

/// Assign a workspace to a sidebar group (None = ungrouped). The group must
/// exist in app settings so a deleted group never lingers on a row.
#[tauri::command]
pub fn set_workspace_group(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    if let Some(gid) = group_id.as_deref() {
        let exists = crate::settings::read_settings()?
            .workspace_groups
            .iter()
            .any(|g| g.id == gid);
        if !exists {
            return Err(format!("unknown group: {gid}"));
        }
    }
    let conn = state.db.0.lock();
    conn.execute(
        "UPDATE workspaces SET group_id=?2 WHERE id=?1",
        rusqlite::params![id, group_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reorder_workspaces(
    state: tauri::State<'_, crate::AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let conn = state.db.0.lock();
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE workspaces SET sort_order=?2 WHERE id=?1",
            rusqlite::params![id, index as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_workspace(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let conn = state.db.0.lock();
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM workspaces WHERE id=?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .ok();
    conn.execute("DELETE FROM workspaces WHERE id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    if let Some(path) = path {
        // Same cleanup as delete_session: these identities are scoped to
        // sessions that no longer exist.
        conn.execute(
            "DELETE FROM accepted_internal_frames WHERE (engine, session_id) IN
             (SELECT engine, session_id FROM sessions WHERE workspace_path=?1)",
            rusqlite::params![path],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM sessions WHERE workspace_path=?1",
            rusqlite::params![path],
        )
        .map_err(|e| e.to_string())?;
    }
    drop(conn);
    state.sink.emit_sessions_changed();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ccgui-reader-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// One omp rollout whose assistant turn carries two look-alike frames.
    fn write_session(path: &Path, workspace: &Path, text: &str) {
        let lines = [
            serde_json::json!({"type": "title", "v": 1, "title": "t"}),
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "sid-1",
                "timestamp": "2026-09-05T07:13:57.946Z",
                "cwd": workspace.to_string_lossy(),
            }),
            serde_json::json!({
                "type": "message",
                "timestamp": "2026-09-05T07:14:06.682Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
            }),
            serde_json::json!({
                "type": "message",
                "timestamp": "2026-09-05T07:14:07.682Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
            }),
        ];
        let body = lines
            .iter()
            .map(|line| serde_json::to_string(line).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path, format!("{body}\n")).unwrap();
    }

    /// The page a restored conversation renders hides exactly the frames a live
    /// capture validator accepted, and recording a new identity re-derives the
    /// page instead of serving the parse cached under the older identity set.
    #[test]
    fn session_page_hides_only_recorded_internal_frames() {
        let home = scratch_dir("page-frames");
        let workspace = home.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let file = home.join("s.jsonl");
        let recorded = "<CCGUI_INTERNAL_abcdefgh>{\"pluginId\":\"bridge\"}</CCGUI_INTERNAL_abcdefgh>";
        let unrecorded = "<CCGUI_INTERNAL_zzzzzzzz>{\"pluginId\":\"other\"}</CCGUI_INTERNAL_zzzzzzzz>";
        write_session(&file, &workspace, &format!("answer {recorded} tail {unrecorded}"));

        let db = crate::db::Db::open_at(&home.join("app.db")).unwrap();
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms)
                 VALUES('omp', 'sid-1', ?1, ?2, 1, 1)",
                rusqlite::params![
                    workspace.to_string_lossy(),
                    file.to_string_lossy(),
                ],
            )
            .unwrap();
        }

        // Nothing recorded yet: both frames are ordinary model output.
        let page = load_session_page_blocking(&db, "omp", "sid-1", None, None).unwrap();
        let assistant = |page: &SessionPage| {
            page.messages
                .iter()
                .find(|m| m.role == "assistant")
                .expect("assistant row")
                .text
                .clone()
        };
        assert_eq!(
            assistant(&page),
            format!("answer {recorded} tail {unrecorded}")
        );

        // Recording one identity hides that frame only. The first page was
        // cached under the empty identity set, so a cache keyed on file stat
        // alone would still serve the stale text here.
        db.record_accepted_internal_frame_hash(
            "omp",
            "sid-1",
            &super::super::internal_frame_hash(recorded),
        )
        .unwrap();
        let page = load_session_page_blocking(&db, "omp", "sid-1", None, None).unwrap();
        assert_eq!(assistant(&page), format!("answer  tail {unrecorded}"));

        drop(db);
        std::fs::remove_dir_all(&home).ok();
    }

    /// The scope one identity is stored under is bounded: only engines this app
    /// runs, and only ids short enough to be native session ids. Without both,
    /// the table becomes arbitrary storage that taxes every later scan.
    #[test]
    fn recorded_frame_scope_rejects_unknown_engines_and_oversized_ids() {
        assert_eq!(
            recordable_frame_scope(" omp ", " sid-1 ").unwrap(),
            ("omp".to_string(), "sid-1".to_string())
        );
        assert!(recordable_frame_scope("not-an-engine", "sid-1").is_err());
        assert!(recordable_frame_scope("omp", "").is_err());
        assert!(
            recordable_frame_scope("omp", &"x".repeat(MAX_RECORDED_SESSION_ID_LEN + 1)).is_err()
        );
    }

    /// Deleting a conversation drops the identities scoped to it. They can never
    /// match another session's frames again, and every scan re-reads and hashes
    /// the whole table, so orphans are a permanent tax.
    #[test]
    fn deleting_a_session_drops_its_recorded_frame_identities() {
        let home = scratch_dir("delete-frames");
        let workspace = home.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let file = home.join("s.jsonl");
        write_session(&file, &workspace, "answer");
        let db = crate::db::Db::open_at(&home.join("app.db")).unwrap();
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms)
                 VALUES('omp', 'sid-1', ?1, ?2, 1, 1)",
                rusqlite::params![workspace.to_string_lossy(), file.to_string_lossy()],
            )
            .unwrap();
        }
        db.record_accepted_internal_frame_hash("omp", "sid-1", &"a".repeat(64))
            .unwrap();
        db.record_accepted_internal_frame_hash("omp", "kept", &"b".repeat(64))
            .unwrap();

        delete_session_blocking(&db, "omp", "sid-1").unwrap();

        assert!(db.accepted_internal_frames("omp", "sid-1").unwrap().0.is_empty());
        assert_eq!(db.accepted_internal_frames("omp", "kept").unwrap().0.len(), 1);

        drop(db);
        std::fs::remove_dir_all(&home).ok();
    }
}
