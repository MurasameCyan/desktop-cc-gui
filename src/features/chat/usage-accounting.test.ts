import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { parseUsage } from "./usage";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("codex", "s-1", "/tmp/ws");
let runCounter = 0;
let runId: string;

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function event(kind: ChatEngineEvent["kind"], seq: number, data: unknown, engine = "codex"): ChatEngineEvent {
  return { runId, sessionId: "s-1", engine, seq, kind, data };
}

function report(inputTokens: number, outputTokens: number) {
  return { last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

function session() {
  return useChatStore.getState().bySession[KEY]!;
}

describe("usage accounting", () => {
  beforeEach(() => {
    runId = `usage-run-${++runCounter}`;
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    runRouting.set(runId, KEY);
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [{ seq: 2, role: "assistant", text: "…", live: true, ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("sums the reply's reports for the strip and keeps occupancy separate", () => {
    handleEngineEvents([event("usage", 2, report(1000, 40))], deps());
    handleEngineEvents([event("usage", 3, report(500, 10))], deps());
    // The strip counts what this reply spent...
    expect(parseUsage(session().turnUsage)).toMatchObject({ input: 1500, output: 50 });
    // ...while the context meter still reads the newest single report.
    expect(parseUsage(session().usage)).toMatchObject({ input: 500, output: 10 });

    handleEngineEvents([event("done", 9, { usage: report(1500, 50) })], deps());
    // The aggregate in done must not replace the newest context occupancy.
    // The settled row carries the reply's total, and the running counter is
    // gone so the next reply starts from zero.
    const settled = session();
    expect(parseUsage(settled.turnUsage)).toBeNull();
    const assistant = settled.messages.filter((m) => m.role === "assistant").at(-1);
    expect(parseUsage(assistant?.usage)).toMatchObject({ input: 1500, output: 50 });
    expect(parseUsage(settled.usage)).toMatchObject({ input: 500, output: 10 });
  });

  it("settles a reply that reports only at the end exactly once", () => {
    const turnSettled = vi.fn();
    const eventDeps = { ...deps(), turnSettled };
    handleEngineEvents([event("done", 9, { usage: { input_tokens: 7, output_tokens: 3 } })], eventDeps);
    const messages = session().messages;
    expect(parseUsage(messages.at(-1)?.usage)).toMatchObject({ input: 7, output: 3 });
    expect(session().streaming).toBe(false);

    handleEngineEvents([event("done", 10, { usage: { input_tokens: 70, output_tokens: 30 } })], eventDeps);
    expect(session().messages).toBe(messages);
    expect(parseUsage(session().usage)).toMatchObject({ input: 7, output: 3 });
    expect(turnSettled).toHaveBeenCalledTimes(1);
  });

  it("keeps OMP context snapshots out of the reply totals", () => {
    handleEngineEvents([event("usage", 1, { input_tokens: 1000, output_tokens: 40 }, "omp")], deps());
    handleEngineEvents([event("usage", 2, { input_tokens: 5000, output_tokens: 0, model_context_window: 100_000, contextOnly: true }, "omp")], deps());
    expect(parseUsage(session().usage)).toMatchObject({ input: 5000, contextWindow: 100_000 });
    expect(parseUsage(session().turnUsage)).toMatchObject({ input: 1000, output: 40 });
    handleEngineEvents([event("done", 3, { usage: null }, "omp")], deps());
    expect(parseUsage(session().messages.at(-1)?.usage)).toMatchObject({ input: 1000, output: 40, contextWindow: 100_000 });
    expect(parseUsage(session().usage)?.input).toBe(5000);
  });

  it("does not invent billing when the only report is a context snapshot", () => {
    handleEngineEvents([event("usage", 1, { input_tokens: 5000, output_tokens: 0, model_context_window: 100_000, contextOnly: true }, "omp")], deps());
    handleEngineEvents([event("done", 2, { usage: null }, "omp")], deps());
    expect(parseUsage(session().usage)?.input).toBe(5000);
    expect(session().messages.at(-1)?.usage).toBeUndefined();
  });

  it("stamps Claude's resolved custom model instead of the selected family alias", () => {
    const tab = { engine: "claude", sessionId: "s-1", workspacePath: "/tmp/ws", model: "haiku" };
    const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
    const model = "gpt-6-astra-cc-format[1m]";
    runRouting.set(runId, key);
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      models: { claude: "sonnet" },
      bySession: { [key]: { ...EMPTY_SESSION, streaming: true, activeModel: tab.model } },
    });

    handleEngineEvents([
      event("model", 1, model, "claude"),
      event("delta", 2, "Custom model reply", "claude"),
      event("done", 3, { usage: { input_tokens: 7, output_tokens: 3 } }, "claude"),
    ], deps());

    expect(useChatStore.getState().bySession[key]!.messages.at(-1)).toMatchObject({
      role: "assistant", text: "Custom model reply", model, live: false,
    });
    expect(parseUsage(useChatStore.getState().bySession[key]!.messages.at(-1)?.usage)).toMatchObject({ input: 7, output: 3 });
    // Keep the selector for the next send: aliases must still follow channel remaps.
    expect(useChatStore.getState().openTabs[0].model).toBe("haiku");
  });

  it("attributes a reply's tokens to an observed run without an open tab", () => {
    useChatStore.setState({ models: { codex: "different-default-model" } });
    handleEngineEvents([
      event("model", 1, "gpt-5.4"),
      event("usage", 2, report(1000, 40)),
      event("done", 3, { usage: null }),
    ], deps());

    const assistant = session().messages.at(-1);
    expect(assistant).toMatchObject({ role: "assistant", model: "gpt-5.4", live: false });
    expect(parseUsage(assistant?.usage)).toMatchObject({ input: 1000, output: 40 });
  });

});
