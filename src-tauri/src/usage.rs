//! Token-usage ledger for the settings usage page.
//!
//! Turns are recorded as they finish (the same `done` payload that stamps the
//! settled row), so the page counts what actually ran after the ledger was
//! switched on — no history is reconstructed, nothing leaves the machine, and
//! the numbers are the engines' own reports rather than estimates.

use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    /// Epoch ms when the turn settled.
    pub ts: i64,
    pub engine: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// Local day ("YYYY-MM-DD"); computed with the caller's UTC offset.
    pub day: String,
    pub engine: String,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    /// How many turns folded into this bucket.
    pub turns: i64,
}

/// Append one finished turn. A turn with no tokens (interrupted before the
/// engine reported) is not a ledger row — it would only add noise.
#[tauri::command]
pub fn usage_record(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    entry: UsageEntry,
) -> Result<(), String> {
    if entry.input + entry.output + entry.cache_read + entry.cache_write == 0 {
        return Ok(());
    }
    {
        let conn = state.db.0.lock();
        conn.execute(
            "INSERT INTO usage_ledger
               (ts, engine, model, session_id, workspace_path,
                input_tokens, output_tokens, cache_read, cache_write, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                entry.ts,
                entry.engine,
                entry.model.unwrap_or_default(),
                entry.session_id,
                entry.workspace_path,
                entry.input,
                entry.output,
                entry.cache_read,
                entry.cache_write,
                entry.duration_ms,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    // The page re-reads on this; the ledger is the only writer.
    let _ = app.emit("usage://changed", ());
    Ok(())
}

/// Per-(day, engine, model) totals over the last `days` local days.
/// `tz_offset_minutes` is the caller's UTC offset so buckets match the
/// calendar the user is looking at.
#[tauri::command]
pub fn usage_summary(
    state: tauri::State<'_, crate::AppState>,
    days: u32,
    tz_offset_minutes: i32,
) -> Result<Vec<UsageRow>, String> {
    let days = days.clamp(1, 365) as i64;
    let shift_ms = i64::from(tz_offset_minutes) * 60_000;
    let conn = state.db.0.lock();
    // Bucketing happens in SQL so the whole ledger never crosses into Rust
    // for a daily view. The offset must be bound as a NUMBER: `date(x, …)`
    // yields NULL when x arrives as text.
    let mut stmt = conn
        .prepare(
            "SELECT date((ts + ?1) / 1000, 'unixepoch') AS day,
                    engine,
                    model,
                    SUM(input_tokens),
                    SUM(output_tokens),
                    SUM(cache_read),
                    SUM(cache_write),
                    COUNT(*)
             FROM usage_ledger
             WHERE day >= date('now', ?2)
             GROUP BY day, engine, model
             ORDER BY day, engine, model",
        )
        .map_err(|e| e.to_string())?;
    let range_param = format!("-{} days", days - 1);
    let rows = stmt
        .query_map(rusqlite::params![shift_ms, range_param], |r| {
            Ok(UsageRow {
                day: r.get(0)?,
                engine: r.get(1)?,
                model: r.get::<_, String>(2).unwrap_or_default(),
                input: r.get(3)?,
                output: r.get(4)?,
                cache_read: r.get(5)?,
                cache_write: r.get(6)?,
                turns: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Drop the whole ledger. The page offers this as an explicit reset; nothing
/// else reads the table.
#[tauri::command]
pub fn usage_clear(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let conn = state.db.0.lock();
    conn.execute("DELETE FROM usage_ledger", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
