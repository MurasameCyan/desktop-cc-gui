use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// Folded into the scanner's stat signature so a schema/derivation change
/// still invalidates cached parse results.
pub const CACHE_VERSION: &str = "2";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
}

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open() -> rusqlite::Result<Self> {
        Self::open_at(&crate::paths::db_path())
    }
    pub fn open_at(path: &std::path::Path) -> rusqlite::Result<Self> {
        // The db sits next to config.json (provider API keys): owner-only.
        // Touch the file first so the permission lands before sqlite's own
        // lazy creation can pick a looser umask default.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(path);
            if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
                eprintln!("[db] chmod 0600 {}: {e}", path.display());
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// All registered workspace roots (session attribution + path confinement).
    pub fn workspace_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare("SELECT path FROM workspaces")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(path) => out.push(path),
                Err(e) => eprintln!("[db] skipping undecodable workspace row: {e}"),
            }
        }
        Ok(out)
    }

    /// Return the persistent registration identity for an exact workspace path.
    pub fn workspace_metadata(&self, path: &str) -> Result<Option<WorkspaceMetadata>, String> {
        let conn = self.0.lock();
        let mut metadata = conn
            .query_row(
                "SELECT id, path, name FROM workspaces WHERE path=?1",
                [path],
                |row| {
                    Ok(WorkspaceMetadata {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        name: row.get(2)?,
                        git_branch: None,
                        git_head: None,
                        dirty: None,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        drop(conn);

        if let Some(metadata) = metadata.as_mut() {
            if let Some(vcs) = crate::git::workspace_vcs_metadata(&metadata.path) {
                metadata.git_branch = vcs.git_branch;
                metadata.git_head = vcs.git_head;
                metadata.dirty = Some(vcs.dirty);
            }
        }
        Ok(metadata)
    }


    /// Directories the user explicitly granted file access to on top of the
    /// registered workspaces (the on-demand grant flow, files::grant_root).
    pub fn granted_roots(&self) -> Result<Vec<String>, String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare("SELECT path FROM granted_roots ORDER BY granted_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(path) => out.push(path),
                Err(e) => eprintln!("[db] skipping undecodable granted_roots row: {e}"),
            }
        }
        Ok(out)
    }

    pub fn add_granted_root(&self, path: &str) -> Result<(), String> {
        let conn = self.0.lock();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT OR IGNORE INTO granted_roots(path, granted_at) VALUES(?1, ?2)",
            rusqlite::params![path, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_granted_root(&self, path: &str) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute("DELETE FROM granted_roots WHERE path=?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Per-plugin KV value (plugins::plugin_storage_get). Stored as JSON text;
    /// a corrupt row surfaces as an error instead of a silent `None` so the
    /// plugin host notices instead of losing state quietly.
    pub fn plugin_kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let conn = self.0.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                rusqlite::params![plugin_id, key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            None => Ok(None),
            Some(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| format!("decode plugin_kv[{plugin_id}/{key}]: {e}")),
        }
    }

    pub fn plugin_kv_set(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), String> {
        let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO plugin_kv(plugin_id, key, value) VALUES(?1, ?2, ?3)
             ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value",
            rusqlite::params![plugin_id, key, text],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn plugin_kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            rusqlite::params![plugin_id, key],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Whole-plugin wipe: uninstall with delete_data, and the tombstone purge
    /// after the 30-day retention window (plugins::KV_TOMBSTONE_TTL_SECS).
    pub fn plugin_kv_delete_all(&self, plugin_id: &str) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id=?1",
            rusqlite::params![plugin_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_accepted_internal_frame_hash(
        &self,
        engine: &str,
        session_id: &str,
        frame_hash: &str,
    ) -> Result<bool, String> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT OR IGNORE INTO accepted_internal_frames(engine, session_id, frame_hash) VALUES(?1, ?2, ?3)",
            rusqlite::params![engine, session_id, frame_hash],
        )
        .map(|changed| changed != 0)
        .map_err(|error| error.to_string())
    }

    pub fn accepted_internal_frames(
        &self,
        engine: &str,
        session_id: &str,
    ) -> Result<(HashSet<String>, String), String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare(
                "SELECT frame_hash FROM accepted_internal_frames WHERE engine=?1 AND session_id=?2 ORDER BY frame_hash",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![engine, session_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut hashes = HashSet::new();
        for row in rows {
            hashes.insert(row.map_err(|error| error.to_string())?);
        }
        let signature = accepted_frame_set_signature(&hashes);
        Ok((hashes, signature))
    }

    /// Every recorded identity, grouped `engine -> session -> set`, plus a
    /// signature over the whole table. The scanner folds the table signature
    /// into its global stat signature so newly recorded identities re-open a
    /// scan that no file change would otherwise justify, and compares each
    /// row's stored per-session signature to decide which files to re-derive.
    pub fn accepted_internal_frame_index(&self) -> Result<(AcceptedFrameIndex, String), String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare(
                "SELECT engine, session_id, frame_hash FROM accepted_internal_frames
                 ORDER BY engine, session_id, frame_hash",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut index: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();
        let mut hasher = Sha256::new();
        let mut any = false;
        for row in rows {
            let (engine, session_id, frame_hash) = row.map_err(|error| error.to_string())?;
            hasher.update(engine.as_bytes());
            hasher.update(b"/");
            hasher.update(session_id.as_bytes());
            hasher.update(b"/");
            hasher.update(frame_hash.as_bytes());
            any = true;
            index
                .entry(engine)
                .or_default()
                .entry(session_id)
                .or_default()
                .insert(frame_hash);
        }
        // Per-session signatures are derived once here: the scanner asks for
        // them per candidate file, and re-hashing a set per candidate would
        // make a cold scan quadratic in recorded frames.
        let index = index
            .into_iter()
            .map(|(engine, sessions)| {
                let sessions = sessions
                    .into_iter()
                    .map(|(session_id, hashes)| {
                        let signature = accepted_frame_set_signature(&hashes);
                        (session_id, AcceptedFrameSet { hashes, signature })
                    })
                    .collect();
                (engine, sessions)
            })
            .collect();
        let signature = if any {
            format!("{:x}", hasher.finalize())
        } else {
            String::new()
        };
        Ok((index, signature))
    }
}

/// One session's recorded frame identities plus the signature that identifies
/// the set. An empty set signs as `""`, matching the stored column default so
/// sessions that never carried an internal frame are never re-derived.
#[derive(Debug, Default)]
pub struct AcceptedFrameSet {
    pub hashes: HashSet<String>,
    pub signature: String,
}

/// Recorded frame identities grouped by engine, then native session id.
pub type AcceptedFrameIndex = HashMap<String, HashMap<String, AcceptedFrameSet>>;

/// Identity of one session's accepted-frame set: two sets with the same
/// members produce the same signature regardless of insertion order.
pub fn accepted_frame_set_signature(hashes: &HashSet<String>) -> String {
    if hashes.is_empty() {
        return String::new();
    }
    let mut ordered: Vec<&str> = hashes.iter().map(String::as_str).collect();
    ordered.sort_unstable();
    let mut hasher = Sha256::new();
    for hash in ordered {
        hasher.update(hash.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}
#[tauri::command]
pub fn workspace_metadata(
    db: tauri::State<'_, std::sync::Arc<Db>>,
    plugin_id: String,
    workspace_path: String,
) -> Result<WorkspaceMetadata, String> {
    let (enabled, quarantined, permissions) = crate::plugins::plugin_access(&plugin_id)?;
    if !enabled {
        return Err(format!("{plugin_id}: plugin is disabled"));
    }
    if quarantined {
        return Err(format!("{plugin_id}: plugin is quarantined"));
    }
    if !permissions.iter().any(|permission| permission == "workspace.metadata.read") {
        return Err(format!("{plugin_id}: missing workspace.metadata.read permission"));
    }
    db.workspace_metadata(workspace_path.trim())?
        .ok_or_else(|| format!("workspace is not registered: {}", workspace_path.trim()))
}

/// One-time import of the legacy desktop-cc-gui workspace list
/// (`paths::legacy_workspaces_path`): old users open the upgrade and find
/// their sidebar intact. Rows already registered (same path) only adopt the
/// legacy order; new paths are inserted with their legacy id/name. Guarded
/// by a meta flag so a workspace removed in the new app is never
/// resurrected on the next launch.
pub fn import_legacy_workspaces_once(db: &Db) -> Result<(), String> {
    import_legacy_workspaces_from(db, &crate::paths::legacy_workspaces_path())
}

fn import_legacy_workspaces_from(db: &Db, path: &std::path::Path) -> Result<(), String> {
    let conn = db.0.lock();
    let done = conn
        .query_row(
            "SELECT value FROM meta WHERE key='legacy_workspaces_import_v1'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok();
    if done.is_some() {
        return Ok(());
    }

    if path.is_file() {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let legacy: Vec<serde_json::Value> =
            serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))?;
        // Sidebar order: ungrouped workspaces first (file order), then each
        // group with its internal sortOrder. Worktree children (parentId)
        // have no new-app equivalent and are skipped.
        let mut entries: Vec<(usize, &serde_json::Value)> = legacy
            .iter()
            .enumerate()
            .filter(|(_, w)| {
                w.get("parentId").and_then(|v| v.as_str()).is_none()
                    && w.get("path")
                        .and_then(|v| v.as_str())
                        .is_some_and(|p| !p.trim().is_empty())
            })
            .collect();
        entries.sort_by_key(|(i, w)| {
            let group = w
                .pointer("/settings/groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let sort = w
                .pointer("/settings/sortOrder")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            (u8::from(!group.is_empty()), group.to_string(), sort, *i)
        });

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut index = 0i64;
        let mut imported_paths = std::collections::HashSet::new();
        for (_, w) in &entries {
            let path = w.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
            let name = w
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path));
            let id = w
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            // Group assignment rides along with the row (legacy
            // `settings.groupId`); a conflict keeps any assignment the user
            // already made in the new app.
            let group_id = w
                .pointer("/settings/groupId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty());
            tx.execute(
                "INSERT INTO workspaces(id, path, name, sort_order, group_id) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(path) DO UPDATE SET sort_order=excluded.sort_order,
                    group_id=COALESCE(workspaces.group_id, excluded.group_id)",
                rusqlite::params![id, path, name, index, group_id],
            )
            .map_err(|e| e.to_string())?;
            imported_paths.insert(path.to_string());
            index += 1;
        }
        // Rows the legacy list doesn't know (added in the new app before the
        // upgrade) keep their relative order, appended after the import.
        let mut stmt = tx
            .prepare(
                "SELECT id, path FROM workspaces
                 ORDER BY sort_order IS NULL, sort_order, COALESCE(last_opened_at, 0) DESC",
            )
            .map_err(|e| e.to_string())?;
        let remaining: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        drop(stmt);
        for (id, row_path) in remaining {
            if imported_paths.contains(&row_path) {
                continue;
            }
            tx.execute(
                "UPDATE workspaces SET sort_order=?2 WHERE id=?1",
                rusqlite::params![id, index],
            )
            .map_err(|e| e.to_string())?;
            index += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // Flag set even without a legacy file (fresh machine): never re-probe.
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('legacy_workspaces_import_v1', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspaces(
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            last_opened_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime_ms INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',
            created_at INTEGER,
            updated_at INTEGER,
            message_count INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            custom_title TEXT,
            PRIMARY KEY(engine, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
        CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS granted_roots(
            path TEXT PRIMARY KEY,
            granted_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_ledger(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            engine TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            session_id TEXT,
            workspace_path TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_write INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER,
            reports INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts ON usage_ledger(ts);
        CREATE TABLE IF NOT EXISTS plugin_kv(
            plugin_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(plugin_id, key)
        );
        CREATE TABLE IF NOT EXISTS accepted_internal_frames(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            frame_hash TEXT NOT NULL,
            PRIMARY KEY(engine, session_id, frame_hash)
        );
        ",
    )?;
    // NB: no `cache_version` meta row — it was written but never read; cache
    // freshness is carried by the scanner's stat signature (see CACHE_VERSION).
    // Additive migration: usage rows gained a per-turn request count.
    let has_reports = conn
        .prepare("PRAGMA table_info(usage_ledger)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == "reports");
    if !has_reports {
        conn.execute(
            "ALTER TABLE usage_ledger ADD COLUMN reports INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    // Additive migration: user-defined workspace order (drag reorder).
    let has_sort_order = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "sort_order");
    if !has_sort_order {
        conn.execute("ALTER TABLE workspaces ADD COLUMN sort_order INTEGER", [])?;
    }

    // Additive migration: sidebar group assignment (工作区分组), matching the
    // legacy app's per-workspace `settings.groupId` in workspaces.json.
    let has_group_id = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "group_id");
    if !has_group_id {
        conn.execute("ALTER TABLE workspaces ADD COLUMN group_id TEXT", [])?;
    }
    // Additive migration: history hides only internal frames accepted by a
    // live validator. The signature participates in scanner reuse decisions.
    let has_accepted_frames_signature = conn
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "accepted_frames_signature");
    if !has_accepted_frames_signature {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN accepted_frames_signature TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("ccgui-next-db-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn list(db: &Db) -> Vec<(String, String, Option<i64>)> {
        let conn = db.0.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, path, sort_order FROM workspaces
                 ORDER BY sort_order IS NULL, sort_order",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    #[test]
    fn legacy_import_merges_order_and_runs_once() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        // Pre-existing registrations: one path shared with the legacy list
        // (keeps its new-app id), one the legacy list doesn't know.
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id, path, name, last_opened_at, sort_order)
                 VALUES('new-id-shared', '/ws/shared', 'shared-new-name', 100, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO workspaces(id, path, name, last_opened_at, sort_order)
                 VALUES('new-id-extra', '/ws/extra', 'extra', 200, 1)",
                [],
            )
            .unwrap();
        }
        let legacy = r#"[
            {"id":"legacy-grouped","name":"grouped-ws","path":"/ws/shared","kind":"main",
             "parentId":null,"settings":{"sortOrder":2,"groupId":"g1"}},
            {"id":"legacy-ungrouped","name":"ungrouped-ws","path":"/ws/ungrouped","kind":"main",
             "parentId":null,"settings":{"sortOrder":null,"groupId":null}},
            {"id":"legacy-child","name":"worktree-child","path":"/ws/child","kind":"worktree",
             "parentId":"legacy-grouped","settings":{"sortOrder":null,"groupId":null}}
        ]"#;
        let legacy_path = scratch.path("workspaces.json");
        std::fs::write(&legacy_path, legacy).unwrap();

        import_legacy_workspaces_from(&db, &legacy_path).unwrap();
        let rows = list(&db);
        // Ungrouped first, then grouped, then new-app-only rows; the
        // worktree child is skipped.
        assert_eq!(
            rows,
            vec![
                (
                    "legacy-ungrouped".to_string(),
                    "/ws/ungrouped".to_string(),
                    Some(0)
                ),
                (
                    "new-id-shared".to_string(),
                    "/ws/shared".to_string(),
                    Some(1)
                ),
                ("new-id-extra".to_string(), "/ws/extra".to_string(), Some(2)),
            ]
        );

        // Second run is a no-op: a removal in the new app is not resurrected.
        {
            let conn = db.0.lock();
            conn.execute("DELETE FROM workspaces WHERE id='legacy-ungrouped'", [])
                .unwrap();
        }
        import_legacy_workspaces_from(&db, &legacy_path).unwrap();
        assert_eq!(list(&db).len(), 2);
    }

    #[test]
    fn legacy_import_without_legacy_file_only_sets_flag() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        import_legacy_workspaces_from(&db, &scratch.path("missing.json")).unwrap();
        assert!(list(&db).is_empty());
        let conn = db.0.lock();
        let flag: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key='legacy_workspaces_import_v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, "1");
    }
    #[test]
    fn plugin_kv_roundtrip_and_wipe() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        assert_eq!(db.plugin_kv_get("p1", "k").unwrap(), None);

        db.plugin_kv_set("p1", "k", &serde_json::json!({"n": 1})).unwrap();
        db.plugin_kv_set("p1", "other", &serde_json::json!("s")).unwrap();
        db.plugin_kv_set("p2", "k", &serde_json::json!(true)).unwrap();
        // Same key under another plugin is an independent row; overwrite wins.
        db.plugin_kv_set("p1", "k", &serde_json::json!({"n": 2})).unwrap();
        assert_eq!(
            db.plugin_kv_get("p1", "k").unwrap(),
            Some(serde_json::json!({"n": 2}))
        );
        assert_eq!(
            db.plugin_kv_get("p2", "k").unwrap(),
            Some(serde_json::json!(true))
        );

        db.plugin_kv_delete("p1", "other").unwrap();
        assert_eq!(db.plugin_kv_get("p1", "other").unwrap(), None);

        db.plugin_kv_delete_all("p1").unwrap();
        assert_eq!(db.plugin_kv_get("p1", "k").unwrap(), None);
        assert_eq!(
            db.plugin_kv_get("p2", "k").unwrap(),
            Some(serde_json::json!(true))
        );
    }

    #[test]
    fn accepted_internal_frames_are_deduplicated_and_signed_per_session() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        let first = "a".repeat(64);
        let second = "b".repeat(64);

        assert!(db
            .record_accepted_internal_frame_hash("claude", "s1", &first)
            .unwrap());
        assert!(!db
            .record_accepted_internal_frame_hash("claude", "s1", &first)
            .unwrap());
        assert!(db
            .record_accepted_internal_frame_hash("claude", "s1", &second)
            .unwrap());

        let (hashes, signature) = db.accepted_internal_frames("claude", "s1").unwrap();
        assert_eq!(hashes, HashSet::from([first, second]));
        assert_eq!(signature, accepted_frame_set_signature(&hashes));

        // The scanner-facing index carries the same members and the same
        // per-session signature, so a reuse decision and a parse agree.
        let (index, table_signature) = db.accepted_internal_frame_index().unwrap();
        let indexed = index
            .get("claude")
            .and_then(|sessions| sessions.get("s1"))
            .expect("indexed session");
        assert_eq!(indexed.hashes, hashes);
        assert_eq!(indexed.signature, signature);
        assert!(!table_signature.is_empty());
        assert!(index.get("codex").is_none());
    }

    #[test]
    fn workspace_metadata_reuses_registered_uuid() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES('persistent-id', '/ws/project', 'project')",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            db.workspace_metadata("/ws/project").unwrap(),
            Some(WorkspaceMetadata {
                id: "persistent-id".into(),
                path: "/ws/project".into(),
                name: Some("project".into()),
                git_branch: None,
                git_head: None,
                dirty: None,
            })
        );
        assert_eq!(db.workspace_metadata("/ws/missing").unwrap(), None);
    }

    #[test]
    fn workspace_metadata_includes_repository_facts_only_for_repositories() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        let repo_path = scratch.path("repo");
        let repo = git2::Repository::init(&repo_path).unwrap();
        std::fs::write(repo_path.join("tracked.txt"), "clean\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("test", "test@example.com").unwrap();
        let head = repo
            .commit(Some("HEAD"), &signature, &signature, "init", &tree, &[])
            .unwrap();
        let plain_path = scratch.path("plain");
        std::fs::create_dir(&plain_path).unwrap();
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES(?1, ?2, ?3)",
                rusqlite::params!["repo-id", repo_path.to_string_lossy(), "repo"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES(?1, ?2, ?3)",
                rusqlite::params!["plain-id", plain_path.to_string_lossy(), "plain"],
            )
            .unwrap();
        }

        let repository = serde_json::to_value(
            db.workspace_metadata(&repo_path.to_string_lossy())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(repository["gitBranch"], repo.head().unwrap().shorthand().unwrap());
        assert_eq!(repository["gitHead"], head.to_string());
        assert_eq!(repository["dirty"], false);

        let plain = serde_json::to_value(
            db.workspace_metadata(&plain_path.to_string_lossy())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(plain.get("gitBranch").is_none());
        assert!(plain.get("gitHead").is_none());
        assert!(plain.get("dirty").is_none());
    }
}
