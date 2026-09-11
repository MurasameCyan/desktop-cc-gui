use super::{
    command_for_binary, images, push_session_id, BuiltCommand, Engine,
    EngineEvent, SendRequest,
};
use serde_json::Value;

/// Codex one-shot: `codex exec --json` (verified against codex CLI live).
/// The legacy app used the persistent app-server JSON-RPC; exec mode gives
/// the same session files and item.completed messages without a daemon.
pub struct CodexEngine;

impl Engine for CodexEngine {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn supports_images(&self) -> bool {
        true // -i/--image FILE
    }
    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "manual", "bypass"]
    }

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, String> {
        let mut cmd = command_for_binary(bin);
        cmd.arg("exec");
        let mut preassigned = None;
        if let Some(session_id) = req.session_id.as_deref() {
            // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`
            cmd.arg("resume");
            cmd.arg("--json");
            cmd.arg(session_id);
            preassigned = Some(session_id.to_string());
        } else {
            cmd.arg("--json");
        }
        cmd.arg("--skip-git-repo-check");
        // exec auto-declines approval prompts, so "manual" is enforced by the
        // sandbox instead: read-only means nothing can change without the
        // user re-sending in a writable mode. codex exec has no plan mode.
        // Sandbox goes through -c sandbox_mode (not --sandbox): `exec resume`
        // dropped the --sandbox flag, while -c works on both subcommands.
        match self.resolve_permission(req.permission.as_deref()) {
            "bypass" => {
                cmd.arg("--dangerously-bypass-approvals-and-sandbox");
            }
            "manual" => {
                cmd.arg("-c");
                cmd.arg("sandbox_mode=\"read-only\"");
            }
            _ => {
                cmd.arg("-c");
                cmd.arg("sandbox_mode=\"workspace-write\"");
            }
        }
        if let Some(model) = req.model.as_deref() {
            cmd.arg("-m");
            cmd.arg(model);
        }
        // Reasoning effort maps onto codex's config key (TOML value, so the
        // string needs quotes). Pass the level through as-is: current models
        // accept low…ultra (catalog-ordered), including max.
        if let Some(effort) = req.effort.as_deref() {
            cmd.arg("-c");
            cmd.arg(format!("model_reasoning_effort=\"{effort}\""));
        }
        // Fast mode is Codex's service_tier=priority (same id the desktop app
        // uses). Explicit default opts out; None leaves the CLI's config alone.
        if let Some(tier) = req.service_tier.as_deref() {
            if !matches!(tier, "default" | "priority") {
                return Err("Invalid Codex service tier".to_string());
            }
            cmd.arg("-c");
            cmd.arg(format!("service_tier=\"{tier}\""));
        }
        for raw in &req.images {
            if let Some(path) = images::absolutize_image_path(raw, &req.workspace) {
                cmd.arg("-i");
                cmd.arg(path);
            }
        }
        // Prompt travels through stdin (`-`), never argv: on Windows the codex
        // shim is a `.cmd` batch file and cmd.exe cuts a multiline argument at
        // the first newline — every line after the first was dropped (or worse,
        // executed as a command). stdin also dodges cmd's `%VAR%` expansion of
        // quoted args. `codex exec [resume] -` reads the prompt from stdin.
        cmd.arg("-");
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: Some(req.prompt.clone()),
            cleanup_files: Vec::new(),
            preassigned_session_id: preassigned,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "thread.started" => {
                push_session_id(&value, "thread_id", out);
            }
            "item.completed" => {
                let Some(item) = value.get("item") else {
                    return;
                };
                match item.get("type").and_then(Value::as_str) {
                    Some("agent_message") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                out.push(super::assistant_message(text.to_string()));
                            }
                        }
                    }
                    Some("reasoning") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                out.push(EngineEvent::Thinking(text.to_string()));
                            }
                        }
                    }
                    // codex exec has no delta events; tool calls surface as
                    // command_execution items.
                    Some("command_execution") => {
                        let name = item
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        // The command string itself is the payload; wrap it so
                        // the timeline can expand a dedicated args panel.
                        let command = name.to_string();
                        out.push(super::tool_call_message(
                            name.chars().take(120).collect::<String>(),
                            Some(&Value::String(command)),
                        ));
                    }
                    _ => {}
                }
            }
            "turn.completed" => {
                let usage = value
                    .get("usage")
                    .cloned()
                    .map(|usage| attach_context_window(usage, &value));
                out.push(EngineEvent::Done {
                    session_id: None,
                    usage,
                });
            }
            "turn.failed" => {
                out.push(EngineEvent::Error(error_message(&value)));
            }
            // Non-terminal: codex emits `error` for every retry it is about
            // to make ("Reconnecting... 1/5 (...)") and once more with the
            // final message just before `turn.failed`. Verified against a
            // live run: both a retryable stream drop and a terminal 401
            // produce retries, one bare error line, then turn.failed. Only
            // turn.failed ends the turn — treating `error` as terminal
            // settled the UI and killed the CLI on the first reconnect, so
            // the turn died at 1/5 instead of continuing.
            "error" => {
                out.push(EngineEvent::Warn(error_message(&value)));
            }
            _ => {}
        }
    }
}

fn attach_context_window(mut usage: Value, source: &Value) -> Value {
    if usage.get("model_context_window").is_none() {
        if let Some(window) = source
            .get("model_context_window")
            .or_else(|| source.get("info").and_then(|i| i.get("model_context_window")))
        {
            if let Some(obj) = usage.as_object_mut() {
                obj.insert("model_context_window".to_string(), window.clone());
            }
        }
    }
    usage
}

/// Message text of a codex error payload: `error.message` when nested,
/// `error` or `message` when flat, with a generic fallback.
fn error_message(value: &Value) -> String {
    value
        .get("error")
        .and_then(|e| e.get("message").or(Some(e)).and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("codex turn failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, EngineEvent};

    fn argv(req: &SendRequest) -> Vec<String> {
        CodexEngine
            .build_command(req, "fake-bin")
            .unwrap()
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    fn base_req() -> SendRequest {
        SendRequest {
            session_id: None,
            workspace: std::path::PathBuf::from("/tmp"),
            prompt: "hi".into(),
            images: Vec::new(),
            model: Some("gpt-6-astra".into()),
            effort: None,
            service_tier: None,
            permission: Some("auto".into()),
            additional_dirs: Vec::new(),
        }
    }

    #[test]
    fn effort_and_fast_tier_pass_through() {
        let mut req = base_req();
        req.effort = Some("ultra".into());
        req.service_tier = Some("priority".into());
        let args = argv(&req);
        assert!(args.iter().any(|a| a == "model_reasoning_effort=\"ultra\""));
        assert!(args.iter().any(|a| a == "service_tier=\"priority\""));
    }

    #[test]
    fn max_effort_is_not_clamped_to_xhigh() {
        let mut req = base_req();
        req.effort = Some("max".into());
        let args = argv(&req);
        assert!(args.iter().any(|a| a == "model_reasoning_effort=\"max\""));
        assert!(!args.iter().any(|a| a.contains("xhigh")));
    }

    fn parse(line: &str) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        CodexEngine.parse_line(line, &mut out);
        out
    }

    /// Captured live from `codex exec --json` against a mock endpoint that
    /// drops the SSE stream: codex announces every retry as an `error` event
    /// and only `turn.failed` ends the turn. Handling these as terminal
    /// settled the UI — and killed the CLI — on the first reconnect, so the
    /// turn died at 1/5 instead of continuing to completion.
    #[test]
    fn reconnect_notice_is_non_terminal() {
        let line = r#"{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)"}"#;
        match &parse(line)[..] {
            [EngineEvent::Warn(text)] => assert!(text.starts_with("Reconnecting... 1/5")),
            other => panic!("expected a non-terminal warn, got {other:?}"),
        }
    }

    /// The bare error line codex emits right before `turn.failed` repeats the
    /// final message; the terminal signal is the `turn.failed` event itself.
    #[test]
    fn turn_failed_is_the_terminal_error() {
        // The retry notice must not settle the turn.
        match &parse(
            r#"{"type":"error","message":"unexpected status 401 Unauthorized: Incorrect API key provided: x."}"#,
        )[..] {
            [EngineEvent::Warn(_)] => {}
            other => panic!("expected warn for the retry notice, got {other:?}"),
        }
        // turn.failed carries the terminal error text to the banner.
        match &parse(
            r#"{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided: x."}}"#,
        )[..] {
            [EngineEvent::Error(message)] => assert!(message.contains("401 Unauthorized")),
            other => panic!("expected terminal error, got {other:?}"),
        }
    }

    /// A successful turn after retries must still complete normally.
    #[test]
    fn turn_completed_after_retries_still_dones() {
        let mut out = Vec::new();
        CodexEngine.parse_line(
            r#"{"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion: x)"}"#,
            &mut out,
        );
        CodexEngine.parse_line(r#"{"type":"turn.completed","usage":null}"#, &mut out);
        assert!(matches!(out[0], EngineEvent::Warn(_)));
        assert!(matches!(out[1], EngineEvent::Done { .. }));
    }
}
