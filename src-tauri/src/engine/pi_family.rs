use super::{
    command_for_binary, images, push_session_id, BuiltCommand, Engine, EngineEvent, SendRequest,
};
use serde_json::Value;

/// pi and omp are the same CLI protocol (omp is a fork of pi): identical
/// spawn args and NDJSON event stream, different binary + home dir.
pub struct PiFamilyEngine {
    pub id: &'static str,
    pub home_dir_name: &'static str, // ".pi" | ".omp"
}

pub fn pi() -> PiFamilyEngine {
    PiFamilyEngine {
        id: "pi",
        home_dir_name: ".pi",
    }
}

pub fn omp() -> PiFamilyEngine {
    PiFamilyEngine {
        id: "omp",
        home_dir_name: ".omp",
    }
}

impl Engine for PiFamilyEngine {
    fn id(&self) -> &'static str {
        self.id
    }

    fn supports_images(&self) -> bool {
        // Images go out as `@<path>` argv entries (the pi/omp print-mode file
        // reference contract); whether the configured provider admits image
        // content is provider-dependent, but the transport is supported.
        true
    }
    /// omp exposes real approval switches (`--approval-mode`,
    /// `--auto-approve`) plus a headless plan flow (`--plan-yolo`); pi 0.85
    /// has none of them, so it keeps the trait default.
    ///
    /// `always-ask`/`write` are deliberately absent: they leave write/exec
    /// tools on a `prompt` policy, and print mode has no UI to answer with —
    /// the CLI aborts the turn with "requires approval but no interactive UI
    /// available" the moment a gated tool runs. Only the non-prompting modes
    /// can be honored headlessly.
    fn supported_permissions(&self) -> &'static [&'static str] {
        if self.id == "omp" {
            &["auto", "plan", "bypass"]
        } else {
            &["auto"]
        }
    }

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, String> {
        let mut cmd = command_for_binary(bin);
        cmd.arg("--print");
        cmd.arg("--mode");
        cmd.arg("json");
        if let Some(model) = req.model.as_deref() {
            cmd.arg("--model");
            cmd.arg(model);
        }
        // Only explicit OpenAI-Codex selectors opt into this per-app preference.
        // Never leak it to pi, another provider or an unknown CLI default.
        if self.id == "omp"
            && req.model.as_deref().is_some_and(|m| {
                m.strip_prefix("openai-codex/")
                    .is_some_and(|id| !id.is_empty())
            })
        {
            if let Some(tier) = req.service_tier.as_deref() {
                if !matches!(tier, "default" | "priority") {
                    return Err("Invalid OMP OpenAI service tier".to_string());
                }
                cmd.args(["--service-tier", tier]);
            }
        }
        // Both accept the full level vocabulary: low…max.
        if let Some(effort) = req.effort.as_deref() {
            cmd.arg("--thinking");
            cmd.arg(effort);
        }
        match self.resolve_permission(req.permission.as_deref()) {
            // Skips every approval tier for this run, and also sets the
            // session's explicit auto-approve flag (not just the setting), so
            // the ACP permission gate stands down too.
            "bypass" => {
                cmd.arg("--auto-approve");
            }
            // omp's own documented headless plan flow: start read-only,
            // auto-approve the plan on the model's first resolve call, then
            // implement. `--plan-yolo-into` otherwise drops to the cheap
            // "smol" role — pin it to the picked model so the implementation
            // phase runs on the CLI the user actually selected.
            "plan" => {
                cmd.arg("--plan-yolo");
                if let Some(model) = req.model.as_deref() {
                    cmd.arg("--plan-yolo-into");
                    cmd.arg(model);
                }
            }
            // "auto": leave the CLI's own tools.approvalMode alone.
            _ => {}
        }
        if let Some(session_id) = req.session_id.as_deref() {
            if !session_id.starts_with('-') {
                // pi supports `--session-id <id>`; omp dropped it, resume goes
                // through `-r/--resume` (accepts an ID prefix).
                if self.id == "omp" {
                    cmd.arg("--resume");
                } else {
                    cmd.arg("--session-id");
                }
                cmd.arg(session_id);
            }
        }
        // Image attachments as `@<abs path>` file references ahead of the
        // prompt. data: URLs can't be file-referenced; the frontend's paste
        // flow already materializes blobs to files, so anything left is
        // skipped here rather than breaking argv.
        for raw in &req.images {
            if let Some(absolute) = images::absolutize_image_path(raw, &req.workspace) {
                cmd.arg(format!("@{}", absolute.display()));
            }
        }
        // Prompt travels through stdin, never argv: on Windows the pi shim is a
        // `.cmd` batch file spawned via `cmd /c`, and cmd.exe cuts a multiline
        // argument at the first newline - every line after the first was
        // dropped. pi joins piped stdin into the initial message
        // (`readPipedStdin` -> `buildInitialMessage`), so the prompt rides
        // stdin verbatim, matching codex; `@<abs path>` image refs stay in argv.
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: Some(req.prompt.clone()),
            cleanup_files: Vec::new(),
            preassigned_session_id: None,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        parse_pi_family_line(line, out);
    }
}

/// Shared NDJSON parser for pi and omp (`--mode json`).
fn parse_pi_family_line(line: &str, out: &mut Vec<EngineEvent>) {
    // Stream updates can include the entire growing message twice (message
    // and assistantMessageEvent.partial). Skip those snapshots without
    // allocating a JSON object tree for every token.
    #[derive(serde::Deserialize)]
    struct Envelope {
        #[serde(rename = "type")]
        kind: String,
        #[serde(rename = "assistantMessageEvent")]
        event: Option<Delta>,
    }
    #[derive(serde::Deserialize)]
    struct Delta {
        #[serde(rename = "type")]
        kind: String,
        delta: Option<String>,
    }
    let Ok(envelope) = serde_json::from_str::<Envelope>(line) else {
        return;
    };
    if envelope.kind == "message_update" {
        if let Some(delta) = envelope.event {
            if let Some(text) = delta.delta.filter(|text| !text.is_empty()) {
                match delta.kind.as_str() {
                    "text_delta" => out.push(EngineEvent::Delta(text)),
                    "thinking_delta" => out.push(EngineEvent::Thinking(text)),
                    _ => {}
                }
            }
        }
        return;
    }
    let event_type = envelope.kind.as_str();
    if !matches!(
        event_type,
        "session" | "tool_execution_start" | "tool_execution_end" | "message_end" | "turn_end" | "agent_end"
    ) {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match event_type {
        "session" => {
            push_session_id(&value, "id", out);
        }
        "tool_execution_start" => {
            let name = value
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let intent = value.get("intent").and_then(Value::as_str);
            out.push(super::tool_call_message(
                tool_label(name, intent),
                value.get("args"),
            ));
        }
        "tool_execution_end" => {
            let name = value
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("");
            let result = value.get("result");
            out.push(super::tool_result_patch(name, result));
        }
        "message_end" => {
            if let Some(model) = value
                .get("message")
                .and_then(|m| m.get("model"))
                .or_else(|| value.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                out.push(EngineEvent::Model(model.to_string()));
            }
            if let Some(usage) = value
                .get("message")
                .and_then(|m| m.get("usage"))
                .filter(|u| !u.is_null())
            {
                out.push(EngineEvent::Usage(usage.clone()));
            }
            // A message-level error is one failed model call (e.g. an
            // upstream 429): the CLI retries and the turn continues, so this
            // is only a notice. turn_end/agent_end errors stay terminal.
            // omp shapes vary by version: `message.errorMessage`, top-level
            // `errorMessage`, and nested `error.message` / `message.error`.
            if let Some(error) = nested_error_text(&value, &["message"]) {
                out.push(EngineEvent::Warn(error));
            }
        }
        "turn_end" | "agent_end" => {
            // omp nests the failure in `message.errorMessage` on every one
            // of these events (e.g. upstream 401 Invalid token): a failed
            // model call ends the turn with stopReason=error, so this is
            // terminal — same treatment as a top-level errorMessage.
            if let Some(error) = nested_error_text(&value, &["message"]) {
                out.push(EngineEvent::Error(error));
            }
            // No terminal result event exists in this protocol; the runner
            // emits Done on clean EOF. agent_end still settles the turn —
            // but never after an Error: the Done event would clear the
            // error banner in the UI and report a failed turn as success.
            if event_type == "agent_end" && !out.iter().any(|e| matches!(e, EngineEvent::Error(_))) {
                out.push(EngineEvent::Done {
                    session_id: None,
                    usage: None,
                });
            }
        }
        _ => {}
    }
}
/// Display label for a tool call: the human-readable intent when the CLI
/// provides one, prefixed with the tool name so the frontend's type
/// classification still sees the raw name token.
pub fn tool_label(name: &str, intent: Option<&str>) -> String {
    match intent {
        Some(intent) if !intent.trim().is_empty() && intent.trim() != name => {
            format!("{} · {}", name, intent.trim())
                .chars()
                .take(120)
                .collect()
        }
        _ => name.to_string(),
    }
}

/// Find the first non-empty error text across the shapes omp emits:
/// `<prefix>.errorMessage`, top-level `errorMessage`, `error.message`, and
/// `<prefix>.error` when it is a plain string. Returns the
/// trimmed text; None when the event carries no error.
fn nested_error_text(value: &Value, prefix: &[&str]) -> Option<String> {
    let mut candidates: Vec<Option<&str>> = Vec::new();
    for pre in prefix {
        candidates.push(
            value
                .get(*pre)
                .and_then(|m| m.get("errorMessage"))
                .and_then(Value::as_str),
        );
    }
    candidates.push(value.get("errorMessage").and_then(Value::as_str));
    candidates.push(value.get("error").and_then(|e| e.get("message")).and_then(Value::as_str));
    for pre in prefix {
        candidates.push(value.get(*pre).and_then(|m| m.get("error")).and_then(Value::as_str));
    }
    candidates
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_updates_skip_snapshots_and_preserve_delta_order() {
        let mut out = Vec::new();
        for (kind, text) in [("thinking_delta", "思考\n"), ("text_delta", "答案\"你好\"")] {
            let snapshot =
                serde_json::json!({"content": [{"type": "text", "text": "长文本".repeat(20000)}]});
            let line = serde_json::json!({
                "type": "message_update", "message": snapshot,
                "assistantMessageEvent": {"type": kind, "delta": text, "partial": snapshot}
            })
            .to_string();
            parse_pi_family_line(&line, &mut out);
        }
        assert_eq!(out.len(), 2);
        assert!(matches!(&out[0], EngineEvent::Thinking(t) if t == "思考\n"));
        assert!(matches!(&out[1], EngineEvent::Delta(t) if t == "答案\"你好\""));
        for line in [
            r#"{"type":"message_update"}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":""}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"ignored"}}"#,
            "{incomplete",
        ] {
            parse_pi_family_line(line, &mut out);
        }
        assert_eq!(out.len(), 2);
    }

    #[test]
    #[ignore = "manual parser throughput benchmark"]
    fn benchmark_snapshot_updates() {
        let snapshot = serde_json::json!({"content": (0..200).map(|_| serde_json::json!({"type":"text", "text":"x".repeat(320)})).collect::<Vec<_>>()});
        let line = serde_json::json!({"type":"message_update", "message":snapshot, "assistantMessageEvent":{"type":"text_delta", "delta":"token", "partial":snapshot}}).to_string();
        let start = std::time::Instant::now();
        for _ in 0..1000 {
            std::hint::black_box(serde_json::from_str::<Value>(&line).unwrap());
        }
        let full = start.elapsed();
        let start = std::time::Instant::now();
        let mut out = Vec::new();
        for _ in 0..1000 {
            out.clear();
            parse_pi_family_line(&line, &mut out);
            std::hint::black_box(&out);
        }
        eprintln!(
            "1000 snapshot updates ({} bytes): full JSON {:?}, delta parser {:?}",
            line.len(),
            full,
            start.elapsed()
        );
    }

    #[test]
    fn tool_execution_start_carries_args_path() {
        let line = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "tool_1",
            "toolName": "edit",
            "args": { "path": "src/app.tsx", "input": {} },
            "intent": "Adding chrome token"
        })
        .to_string();
        let mut out = Vec::new();
        parse_pi_family_line(&line, &mut out);
        match &out[0] {
            EngineEvent::Message {
                role,
                text,
                path,
                args,
                ..
            } => {
                assert_eq!(role, "tool");
                assert_eq!(text, "edit · Adding chrome token");
                assert_eq!(path.as_deref(), Some("src/app.tsx"));
                assert_eq!(
                    args,
                    &Some(serde_json::json!({"path": "src/app.tsx", "input": {}}))
                );
            }
            _ => panic!("expected tool message"),
        }

        // bash-style args carry no path key -> None. No file chip, but the
        // command still lands in `args` for the expandable panel.
        let line = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "tool_2",
            "toolName": "bash",
            "args": { "command": "ls" }
        })
        .to_string();
        let mut out = Vec::new();
        parse_pi_family_line(&line, &mut out);
        match &out[0] {
            EngineEvent::Message { path, args, .. } => {
                assert_eq!(*path, None);
                assert_eq!(args, &Some(serde_json::json!({"command": "ls"})));
            }
            _ => panic!("expected tool message"),
        }
    }

    #[test]
    fn tool_execution_start_carries_todo_payload() {
        let line = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "tool_3",
            "toolName": "todo",
            "args": {
                "op": "init",
                "list": [
                    {"phase": "scaffold", "items": ["scan files", "write code"]}
                ]
            }
        })
        .to_string();
        let mut out = Vec::new();
        parse_pi_family_line(&line, &mut out);
        match &out[0] {
            EngineEvent::Message {
                todos: Some(todos), ..
            } => {
                assert!(todos.replace);
                assert_eq!(todos.items.len(), 2);
                assert_eq!(todos.items[0].content, "scan files");
                assert_eq!(todos.items[0].status, "pending");
                assert_eq!(todos.items[1].content, "write code");
                assert_eq!(todos.items[1].status, "pending");
            }
            _ => panic!("expected tool message with todos"),
        }

        // Non-todo tool args carry no payload.
        let line = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "tool_4",
            "toolName": "bash",
            "args": { "command": "ls" }
        })
        .to_string();
        let mut out = Vec::new();
        parse_pi_family_line(&line, &mut out);
        match &out[0] {
            EngineEvent::Message { todos, .. } => assert!(todos.is_none()),
            _ => panic!("expected tool message"),
        }
    }

    #[test]
    fn message_end_extracts_nested_error_shapes_as_warn() {
        for line in [
            serde_json::json!({"type":"message_end","message":{"errorMessage":"upstream 429"}}),
            serde_json::json!({"type":"message_end","errorMessage":"top-level 429"}),
            serde_json::json!({"type":"message_end","error":{"message":"nested 429"}}),
            serde_json::json!({"type":"message_end","message":{"error":"message.error 429"}}),
        ] {
            let mut out = Vec::new();
            parse_pi_family_line(&line.to_string(), &mut out);
            match out.last() {
                Some(EngineEvent::Warn(text)) => assert!(text.contains("429"), "{line}"),
                other => panic!("expected Warn for {line}, got {other:?}"),
            }
        }
    }

    #[test]
    fn turn_end_extracts_error_from_all_shapes() {
        for line in [
            serde_json::json!({"type":"turn_end","errorMessage":"boom"}),
            serde_json::json!({"type":"turn_end","error":{"message":"nested boom"}}),
            // Real omp 401 shape: the failure nests in `message.errorMessage`
            // with stopReason=error on the enclosing message.
            serde_json::json!({"type":"turn_end","message":{"role":"assistant","stopReason":"error","errorStatus":401,"errorMessage":"401 Invalid token"}}),
        ] {
            let mut out = Vec::new();
            parse_pi_family_line(&line.to_string(), &mut out);
            match out.first() {
                Some(EngineEvent::Error(text)) => assert!(text.contains("boom") || text.contains("401"), "{line}"),
                other => panic!("expected Error for {line}, got {other:?}"),
            }
        }
    }

    #[test]
    fn agent_end_after_error_does_not_emit_done() {
        // A failed turn ends turn_end(error) + agent_end: the Done must be
        // suppressed or the UI clears the error banner and reports success.
        let line = serde_json::json!({
            "type":"agent_end",
            "message":{"stopReason":"error","errorMessage":"401 Invalid token"},
            "isTerminal":true
        })
        .to_string();
        let mut out = Vec::new();
        parse_pi_family_line(&line, &mut out);
        assert!(matches!(out[0], EngineEvent::Error(_)), "got {out:?}");
        assert!(!out.iter().any(|e| matches!(e, EngineEvent::Done { .. })), "Done leaked after Error: {out:?}");

        // Healthy turn: agent_end without an error still settles with Done.
        let ok_line = serde_json::json!({"type":"agent_end","isTerminal":true}).to_string();
        let mut ok_out = Vec::new();
        parse_pi_family_line(&ok_line, &mut ok_out);
        assert!(matches!(ok_out[0], EngineEvent::Done { .. }), "got {ok_out:?}");
    }
}
