//! In-app browser tabs. Each browser tab is a native child webview of the
//! main window, positioned over a React placeholder rect. The frontend owns
//! tab state (order, active tab, persistence); these commands own the native
//! webview lifecycle only, so a closed React tab can never leak a webview
//! (browser_close is called on tab close) and an inactive one never paints
//! over other surfaces (browser_set_visible on tab switch).

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

/// Webview label prefix; the frontend id is appended verbatim. Keeping one
/// namespace lets us tell our children apart from the main webview.
const LABEL_PREFIX: &str = "browser-";

/// Navigation inside a browser webview: emitted with the new URL so the
/// address bar and tab label can follow real navigations.
pub const NAV_EVENT: &str = "browser-tab-nav";
/// Document title changes (fires on load and on SPA title updates).
pub const TITLE_EVENT: &str = "browser-tab-title";

fn label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

/// Webview labels are global per app; keep ids to a safe alphabet so a
/// malformed id can never collide with another webview's label.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid browser tab id: {id:?}"));
    }
    Ok(())
}

fn get_webview(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&label(id))
        .ok_or_else(|| format!("browser webview {id} not found"))
}

fn parse_url(raw: &str) -> Result<Url, String> {
    Url::parse(raw).map_err(|e| format!("invalid url {raw:?}: {e}"))
}

/// Create the child webview for a browser tab. Idempotent: re-creating an
/// existing id is a no-op so the React effect can retry after a failed
/// bounds sync without tearing the page down.
#[tauri::command]
pub fn browser_create(
    window: tauri::Window,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_id(&id)?;
    let label = label(&id);
    if window.get_webview(&label).is_some() {
        return Ok(());
    }
    let parsed = parse_url(&url)?;
    let app = window.app_handle().clone();
    let nav_id = id.clone();
    let title_id = id.clone();
    let builder = tauri::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .focused(true)
        .zoom_hotkeys_enabled(true)
        .on_navigation(move |url| {
            let _ = app.emit(
                NAV_EVENT,
                serde_json::json!({ "id": nav_id, "url": url.to_string() }),
            );
            // Never veto: the frontend address bar is display-only.
            true
        })
        .on_document_title_changed(move |webview, title| {
            let _ = webview.app_handle().emit(
                TITLE_EVENT,
                serde_json::json!({ "id": title_id, "title": title }),
            );
        })
        // target=_blank / window.open: keep the in-app page intact and hand
        // the link to the system browser instead of letting it hijack the
        // tab (or silently dying).
        .on_new_window(|url, _features| {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            tauri::webview::NewWindowResponse::Deny
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| format!("failed to create browser webview: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    // Closing an already-closed tab is fine (React unmount races a tab
    // close from another entry point).
    if let Some(webview) = app.get_webview(&label(&id)) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    validate_id(&id)?;
    let parsed = parse_url(&url)?;
    get_webview(&app, &id)?
        .navigate(parsed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    validate_id(&id)?;
    get_webview(&app, &id)?
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    validate_id(&id)?;
    let webview = get_webview(&app, &id)?;
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn browser_go_back(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    get_webview(&app, &id)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_go_forward(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    get_webview(&app, &id)?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    get_webview(&app, &id)?.reload().map_err(|e| e.to_string())
}

/// Current URL read straight from the native webview, so SPA pushState
/// navigations (which never fire on_navigation) still reach the address
/// bar. The frontend polls this only while the tab is active.
#[tauri::command]
pub fn browser_current_url(app: AppHandle, id: String) -> Result<Option<String>, String> {
    validate_id(&id)?;
    match app.get_webview(&label(&id)) {
        Some(webview) => webview
            .url()
            .map(|u| Some(u.to_string()))
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_id;

    #[test]
    fn id_validation_accepts_safe_alphabet() {
        assert!(validate_id("b1a2c3").is_ok());
        assert!(validate_id("tab-1_x").is_ok());
    }

    #[test]
    fn id_validation_rejects_label_escape() {
        assert!(validate_id("").is_err());
        assert!(validate_id("../main").is_err());
        assert!(validate_id("a b").is_err());
        assert!(validate_id(&"x".repeat(65)).is_err());
    }
}
