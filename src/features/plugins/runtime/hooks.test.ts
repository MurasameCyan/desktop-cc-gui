import { afterEach, describe, expect, it } from "vitest";
import type { BeforeTurnEvent, PromptContribution, RuntimeSwitchEvent } from "@ccgui/plugin-sdk";
import {
  collectBeforeTurnContributions,
  dispatchAfterSwitch,
  registerRuntimeSwitchHooks,
  registerTurnHooks,
  runBeforeSwitch,
} from "./hooks";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function contribution(id: string): PromptContribution {
  return {
    id,
    content: id,
    placement: "request-tail",
    visibility: "internal",
    persistence: "turn",
  };
}

const turn = (runId: string): BeforeTurnEvent =>
  ({ runId, turnId: `turn-${runId}`, engine: "claude", sessionId: null, workspace: { id: "workspace", path: "/work" }, occurredAt: "2026-09-20T00:00:00.000Z" });

const runtimeSwitch: RuntimeSwitchEvent = {
  switchId: "switch-stable",
  sourceEngine: "claude",
  targetEngine: "codex",
  sourceSessionId: null,
  targetSessionId: null,
  workspace: { id: "workspace", path: "/work" },
  occurredAt: "2026-09-20T00:00:00.000Z",
};

describe("generic plugin hook lifecycle", () => {
  it("invalidates prompt and capture contributions after isCurrent turns false", async () => {
    let current = true;
    disposers.push(
      registerTurnHooks("plugin", {
        beforeTurn: () => ({
          isCurrent: () => current,
          promptContributions: [contribution("stale")],
          internalMessageCapture: { channel: "facts", nonce: "n", maxBytes: 256 },
        }),
      }),
    );

    const collected = await collectBeforeTurnContributions(turn("run-1"));
    current = false;
    expect(collected.promptContributions).toEqual([]);
    expect(collected.internalMessageCaptures).toEqual([]);
  });

  it("keeps switchId stable for the same before/after lifecycle key", async () => {
    const seen: string[] = [];
    disposers.push(registerRuntimeSwitchHooks("plugin", {
      beforeSwitch: (event) => seen.push(`before:${event.switchId}`),
      afterSwitch: (event) => seen.push(`after:${event.switchId}`),
    }));

    await runBeforeSwitch(runtimeSwitch);
    dispatchAfterSwitch(runtimeSwitch);
    await Promise.resolve();
    expect(seen).toEqual(["before:switch-stable", "after:switch-stable"]);
  });
});
