import { describe, expect, it } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { normalizeEngineEvent, toolNameFromLabel } from "./normalized-runtime-events";

const context = {
  turnId: "run-7",
  workspaceId: "workspace-1",
  workspacePath: "S:/work/project",
  occurredAt: "2026-09-12T08:30:00.000Z",
};

function event(
  kind: EngineEventPayload["kind"],
  data: unknown,
  overrides: Partial<EngineEventPayload> = {},
): EngineEventPayload {
  return {
    runId: "run-7",
    sessionId: "session-3",
    engine: "claude",
    seq: 12,
    kind,
    data,
    ...overrides,
  };
}

describe("toolNameFromLabel", () => {
  it("takes the leading token of an engine display label", () => {
    expect(toolNameFromLabel("write · Creating smoke note")).toBe("write");
    expect(toolNameFromLabel("bash · Listing workspace contents")).toBe("bash");
    expect(toolNameFromLabel("Edit")).toBe("Edit");
    // Only the first separator splits; an intent may contain more.
    expect(toolNameFromLabel("  edit · Replace · in src/app.ts  ")).toBe("edit");
  });
});

describe("normalizeEngineEvent", () => {
  it("reports structured permission requests without exposing the user-facing message", () => {
    const normalized = normalizeEngineEvent(event("permission_denied", {
      tool: "Read",
      path: "C:/outside/model.json",
      message: "private approval instructions",
    }), context);
    expect(normalized).toMatchObject({
      kind: "permission-requested",
      turnId: "run-7",
      tool: "Read",
      path: "C:/outside/model.json",
    });
    expect(normalized).not.toHaveProperty("message");
  });


  it("leaves missing, blank and non-string permission fields unknown rather than parsing prose", () => {
    for (const data of [
      { message: "Read needs approval for C:/secret.txt" },
      { tool: "  ", path: "", message: "Read C:/secret.txt" },
      { tool: 42, path: { path: "C:/secret.txt" } },
    ]) {
      expect(normalizeEngineEvent(event("permission_denied", data), context)).toEqual({
        eventId: "run-7:12",
        runId: "run-7",
        turnId: "run-7",
        engine: "claude",
        sessionId: "session-3",
        workspaceId: "workspace-1",
        workspacePath: "S:/work/project",
        occurredAt: context.occurredAt,
        kind: "permission-requested",
        tool: null,
        path: null,
      });
    }
  });

  it("does not publish a permission fact from malformed payloads", () => {
    for (const data of [null, undefined, "Read C:/secret.txt", 42, true, []]) {
      expect(normalizeEngineEvent(event("permission_denied", data), context)).toBeNull();
    }
  });

  it("does not turn assistant deltas or snapshots into facts", () => {
    expect(
      normalizeEngineEvent(
        event("delta", "I changed src/secret.ts and the command succeeded"),
        context,
      ),
    ).toBeNull();
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "assistant",
          text: "Exit code 0; deleted src/secret.ts",
        }),
        context,
      ),
    ).toBeNull();
  });

  it("normalizes a structured tool result without inferring its outcome", () => {
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "tool",
          text: "Read",
          path: "src/app.ts",
          result: { content: "source" },
          patch: true,
        }),
        context,
      ),
    ).toMatchObject({
      eventId: "run-7:12",
      turnId: "run-7",
      kind: "tool-finished",
      toolName: "Read",
      status: "unknown",
    });
  });

  it("derives a touched file fact from the mutating tool call, before its result arrives", () => {
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "tool",
          text: "write · Creating smoke note",
          args: { path: "src/app.ts" },
        }),
        context,
      ),
    ).toEqual({
      eventId: "run-7:12",
      runId: "run-7",
      turnId: "run-7",
      engine: "claude",
      sessionId: "session-3",
      workspaceId: "workspace-1",
      workspacePath: "S:/work/project",
      occurredAt: "2026-09-12T08:30:00.000Z",
      kind: "file-changed",
      path: "src/app.ts",
      change: "touched",
    });
  });

  it("emits exactly one file fact when a message carries both the path and its result", () => {
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "tool",
          text: "edit · Replacing the import block",
          args: { file_path: "src/app.ts" },
          result: { ok: true },
        }),
        context,
      ),
    ).toEqual({
      eventId: "run-7:12",
      runId: "run-7",
      turnId: "run-7",
      engine: "claude",
      sessionId: "session-3",
      workspaceId: "workspace-1",
      workspacePath: "S:/work/project",
      occurredAt: "2026-09-12T08:30:00.000Z",
      kind: "file-changed",
      path: "src/app.ts",
      change: "touched",
    });
  });

  it("does not repeat the file fact when the tool result lands", () => {
    const started = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "write · Creating smoke note",
        args: { path: "src/app.ts" },
      }),
      context,
    );
    const settled = normalizeEngineEvent(
      event(
        "message",
        { role: "tool", text: "Write", result: { ok: true }, patch: true },
        { seq: 13 },
      ),
      context,
    );
    expect(started).toMatchObject({ kind: "file-changed", path: "src/app.ts" });
    expect(settled).not.toMatchObject({ kind: "file-changed" });
  });

  it("derives a touched file fact from an OMP edit result details path", () => {
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "tool",
          text: "edit",
          result: {
            content: [{ type: "text", text: "[seed.txt#1478]\\n1:seeded-2" }],
            details: {
              op: "update",
              path: "S:\\work\\project\\seed.txt",
            },
          },
          patch: true,
        }),
        context,
      ),
    ).toMatchObject({
      kind: "file-changed",
      path: "seed.txt",
      change: "touched",
    });
  });

  it("relativizes only paths that sit under the workspace root", () => {
    const under = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "Write",
        args: { path: "S:/work/project/src/app.ts" },
        result: {},
      }),
      context,
    );
    expect(under).toMatchObject({ kind: "file-changed", path: "src/app.ts" });

    const outside = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "write",
        args: { filePath: "S:/other/app.ts" },
        result: {},
      }),
      context,
    );
    expect(outside).toMatchObject({ kind: "file-changed", path: "S:/other/app.ts" });
  });

  it("derives a command fact from a settled tool result, never inventing an exit code", () => {
    const completed = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "Bash",
        args: { command: "pnpm test" },
        result: { exit_code: 0 },
      }),
      context,
    );
    expect(completed).toMatchObject({
      eventId: "run-7:12",
      turnId: "run-7",
      kind: "command-finished",
      command: "pnpm test",
      cwd: "S:/work/project",
      exitCode: 0,
      status: "completed",
      finishedAt: "2026-09-12T08:30:00.000Z",
    });

    const failed = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "bash",
        args: { command: "pnpm build" },
        result: { exitCode: 2 },
      }),
      context,
    );
    expect(failed).toMatchObject({ kind: "command-finished", exitCode: 2, status: "failed" });

    const unknown = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "Bash",
        args: { command: "pnpm lint" },
        result: { stdout: "done" },
      }),
      context,
    );
    expect(unknown).toMatchObject({
      kind: "command-finished",
      command: "pnpm lint",
      exitCode: null,
      status: "unknown",
    });
  });

  it("derives a command start from the tool call, leaving the outcome unknown", () => {
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "tool",
          text: "bash · Listing workspace contents",
          args: { command: "ls -la" },
        }),
        context,
      ),
    ).toEqual({
      eventId: "run-7:12",
      runId: "run-7",
      turnId: "run-7",
      engine: "claude",
      sessionId: "session-3",
      workspaceId: "workspace-1",
      workspacePath: "S:/work/project",
      occurredAt: "2026-09-12T08:30:00.000Z",
      kind: "command-started",
      command: "ls -la",
      cwd: "S:/work/project",
      startedAt: "2026-09-12T08:30:00.000Z",
    });
  });

  it("upgrades a command to its finish only when the same message carries an exit code", () => {
    const started = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "bash · Running the focused suite",
        args: { command: "pnpm vitest run" },
      }),
      context,
    );
    const settled = normalizeEngineEvent(
      event(
        "message",
        {
          role: "tool",
          text: "bash",
          args: { command: "pnpm vitest run" },
          result: { exit_code: 0 },
        },
        { seq: 13 },
      ),
      context,
    );
    expect(started).toMatchObject({ kind: "command-started" });
    expect(settled).toMatchObject({
      kind: "command-finished",
      command: "pnpm vitest run",
      exitCode: 0,
      status: "completed",
    });
    expect(settled).not.toMatchObject({ kind: "command-started" });
  });

  it("correlates split command messages by the adapter tool-call identity", () => {
    const started = normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "bash · Running the focused suite",
        args: { command: "pnpm vitest run" },
        toolCallId: "tool_2",
      }),
      context,
    );
    const settled = normalizeEngineEvent(
      event(
        "message",
        {
          role: "tool",
          text: "bash",
          result: { exitCode: 3, stdout: "failed" },
          patch: true,
          toolCallId: "tool_2",
        },
        { seq: 13 },
      ),
      context,
    );

    expect(started).toMatchObject({ kind: "command-started", command: "pnpm vitest run" });
    expect(settled).toMatchObject({
      kind: "command-finished",
      command: "pnpm vitest run",
      cwd: "S:/work/project",
      exitCode: 3,
      status: "failed",
    });
  });

  it("keeps concurrent commands with the same tool label separated by identity", () => {
    for (const [seq, toolCallId, command] of [
      [20, "tool_a", "pnpm test"],
      [21, "tool_b", "pnpm build"],
    ] as const) {
      normalizeEngineEvent(
        event(
          "message",
          { role: "tool", text: "bash", args: { command }, toolCallId },
          { seq },
        ),
        context,
      );
    }

    const second = normalizeEngineEvent(
      event(
        "message",
        {
          role: "tool",
          text: "bash",
          result: { exitCode: 2 },
          patch: true,
          toolCallId: "tool_b",
        },
        { seq: 22 },
      ),
      context,
    );
    const first = normalizeEngineEvent(
      event(
        "message",
        {
          role: "tool",
          text: "bash",
          result: { exitCode: 0 },
          patch: true,
          toolCallId: "tool_a",
        },
        { seq: 23 },
      ),
      context,
    );

    expect(second).toMatchObject({
      kind: "command-finished",
      command: "pnpm build",
      exitCode: 2,
      status: "failed",
    });
    expect(first).toMatchObject({
      kind: "command-finished",
      command: "pnpm test",
      exitCode: 0,
      status: "completed",
    });
  });

  it("leaves unrelated and ambiguous split results as generic tool finishes", () => {
    normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "bash",
        args: { command: "pnpm test" },
        toolCallId: "tool_unrelated",
      }),
      context,
    );
    expect(
      normalizeEngineEvent(
        event(
          "message",
          {
            role: "tool",
            text: "bash",
            result: { exitCode: 0 },
            patch: true,
            toolCallId: "tool_other",
          },
          { seq: 13 },
        ),
        context,
      ),
    ).toMatchObject({ kind: "tool-finished", toolName: "bash" });

    for (const command of ["pnpm build", "pnpm lint"]) {
      normalizeEngineEvent(
        event(
          "message",
          { role: "tool", text: "bash", args: { command }, toolCallId: "tool_duplicate" },
          { seq: command === "pnpm build" ? 14 : 15 },
        ),
        context,
      );
    }
    expect(
      normalizeEngineEvent(
        event(
          "message",
          {
            role: "tool",
            text: "bash",
            result: { exitCode: 0 },
            patch: true,
            toolCallId: "tool_duplicate",
          },
          { seq: 16 },
        ),
        context,
      ),
    ).toMatchObject({ kind: "tool-finished", toolName: "bash" });
  });

  it("clears pending command identity at terminal lifecycle and never crosses runs", () => {
    normalizeEngineEvent(
      event("message", {
        role: "tool",
        text: "bash",
        args: { command: "pnpm test" },
        toolCallId: "shared-tool-id",
      }),
      context,
    );
    normalizeEngineEvent(event("done", {}, { seq: 13 }), {
      ...context,
      terminal: { status: "completed" },
    });

    expect(
      normalizeEngineEvent(
        event(
          "message",
          {
            role: "tool",
            text: "bash",
            result: { exitCode: 0 },
            patch: true,
            toolCallId: "shared-tool-id",
          },
          { runId: "run-8", seq: 1 },
        ),
        context,
      ),
    ).toMatchObject({ kind: "tool-finished", toolName: "bash" });

    expect(
      normalizeEngineEvent(
        event(
          "message",
          {
            role: "tool",
            text: "bash",
            result: { exitCode: 0 },
            patch: true,
            toolCallId: "shared-tool-id",
          },
          { seq: 14 },
        ),
        context,
      ),
    ).toMatchObject({ kind: "tool-finished", toolName: "bash" });
  });

  it("stays silent on a tool call start whose args hold no file or command fact", () => {
    expect(
      normalizeEngineEvent(
        event("message", {
          role: "tool",
          text: "read · Reading src/app.ts",
          args: { file_path: "src/app.ts" },
          patch: true,
        }),
        context,
      ),
    ).toBeNull();
    expect(
      normalizeEngineEvent(
        event("message", { role: "tool", text: "bash", patch: true }),
        context,
      ),
    ).toBeNull();
  });

  it("requires an explicit terminal fact to distinguish completion and cancellation", () => {
    expect(normalizeEngineEvent(event("done", { usage: null }), context)).toBeNull();
    expect(
      normalizeEngineEvent(event("done", { usage: null }), {
        ...context,
        terminal: { status: "cancelled" },
      }),
    ).toMatchObject({ kind: "turn-cancelled" });
    expect(
      normalizeEngineEvent(event("done", { usage: null }), {
        ...context,
        terminal: { status: "completed" },
      }),
    ).toMatchObject({ kind: "assistant-completed" });
  });

  it("normalizes a terminal engine error without parsing its prose", () => {
    expect(
      normalizeEngineEvent(
        event("error", "claude exited with status 17: denied"),
        context,
      ),
    ).toMatchObject({
      kind: "turn-failed",
      error: "claude exited with status 17: denied",
    });
  });

  it("accepts a deterministic runtime exit fact only through terminal input", () => {
    expect(
      normalizeEngineEvent(event("done", { usage: null }), {
        ...context,
        terminal: { status: "exited", exitCode: 17 },
      }),
    ).toMatchObject({ kind: "runtime-exited", exitCode: 17 });
    expect(
      normalizeEngineEvent(event("error", "process exited with status 17"), context),
    ).not.toMatchObject({ kind: "runtime-exited" });
  });

  it("omits events that carry no normalized runtime fact", () => {
    for (const kind of [
      "thinking",
      "session",
      "usage",
      "warn",
      "model",
    ] satisfies EngineEventPayload["kind"][]) {
      expect(normalizeEngineEvent(event(kind, null), context)).toBeNull();
    }
  });

  it("requires finite sequence and valid metadata before publishing", () => {
    expect(
      normalizeEngineEvent(event("done", {}, { seq: Number.NaN }), {
        ...context,
        terminal: { status: "completed" },
      }),
    ).toBeNull();
    expect(
      normalizeEngineEvent(event("done", {}), {
        ...context,
        occurredAt: "not-a-date",
        terminal: { status: "completed" },
      }),
    ).toBeNull();
  });
});
