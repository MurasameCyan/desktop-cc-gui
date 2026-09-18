import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { QuestionCard } from "./components/QuestionCard";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");
const QUESTION_TEXT = "选哪个方案？";

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function questionEvent(requestId = "req-1") {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 1,
    kind: "question" as const,
    data: {
      requestId,
      toolUseId: "call_1",
      input: {
        questions: [
          {
            question: QUESTION_TEXT,
            header: "方案",
            options: [
              { label: "A", description: "方案 A" },
              { label: "B", description: "方案 B" },
            ],
          },
        ],
      },
    },
  };
}

function settledEvent(requestId = "req-1") {
  return {
    runId: "run-1",
    sessionId: "s-1",
    engine: "claude",
    seq: 2,
    kind: "question_settled" as const,
    data: { requestId },
  };
}

function cardRows() {
  return (useChatStore.getState().bySession[KEY]?.messages ?? []).filter(
    (m) => m.role === "question",
  );
}

describe("ask-user-question flow", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "帮我做", ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a question event appends one pending card", () => {
    handleEngineEvents([questionEvent()], deps());
    const rows = cardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].question?.status).toBe("pending");
    expect(rows[0].question?.requestId).toBe("req-1");
    expect(rows[0].question?.runId).toBe("run-1");
    expect(rows[0].question?.questions[0].options).toHaveLength(2);
  });

  it("replayed frames for the same request id collapse into one card", () => {
    handleEngineEvents([questionEvent(), questionEvent()], deps());
    expect(cardRows()).toHaveLength(1);
  });

  it("answering sends the picked labels and flips the card", async () => {
    handleEngineEvents([questionEvent()], deps());
    const seq = cardRows()[0].seq;
    await useChatStore
      .getState()
      .respondToQuestion(KEY, seq, { [QUESTION_TEXT]: "B" });
    expect(vi.mocked(ipc.answerQuestion)).toHaveBeenCalledWith("run-1", "req-1", {
      [QUESTION_TEXT]: "B",
    });
    expect(cardRows()[0].question?.status).toBe("answered");
    expect(cardRows()[0].question?.answers).toEqual({ [QUESTION_TEXT]: "B" });
  });

  it("skipping sends null and records no answer", async () => {
    handleEngineEvents([questionEvent()], deps());
    const seq = cardRows()[0].seq;
    await useChatStore.getState().respondToQuestion(KEY, seq, null);
    expect(vi.mocked(ipc.answerQuestion)).toHaveBeenCalledWith("run-1", "req-1", null);
    expect(cardRows()[0].question?.status).toBe("dismissed");
    expect(cardRows()[0].question?.answers).toBeUndefined();
  });

  it("a settled event cancels a pending card", () => {
    handleEngineEvents([questionEvent()], deps());
    handleEngineEvents([settledEvent()], deps());
    expect(cardRows()[0].question?.status).toBe("cancelled");
  });
});

describe("QuestionCard free-form Other", () => {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let container: HTMLDivElement;
  let root: Root;

  function cardMessage(multiSelect = false) {
    return {
      seq: 7,
      role: "question",
      text: QUESTION_TEXT,
      ts: null,
      question: {
        requestId: "req-9",
        runId: "run-9",
        toolUseId: null,
        questions: [
          {
            question: QUESTION_TEXT,
            header: "方案",
            multiSelect,
            options: [
              { label: "A", description: "方案 A" },
              { label: "B", description: "方案 B" },
            ],
          },
        ],
        status: "pending" as const,
      },
    };
  }
  const buttonByText = (needle: string) =>
    [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(needle),
    );

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    void i18n.changeLanguage("zh");
    useChatStore.setState({
      openTabs: [],
      active: { engine: "claude", sessionId: "s-1", workspacePath: "/tmp/ws" },
      bySession: {
        [KEY]: { ...EMPTY_SESSION, messages: [cardMessage() as never] },
      },
      streamingByKey: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a single-select question offers the free-form input; a multi-select one does not", () => {
    act(() => root.render(<QuestionCard message={cardMessage() as never} />));
    expect(container.querySelector("input")).toBeTruthy();
    act(() => root.render(<QuestionCard message={cardMessage(true) as never} />));
    expect(container.querySelector("input")).toBeFalsy();
  });

  it("typing a custom answer and confirming sends the free text", async () => {
    act(() => root.render(<QuestionCard message={cardMessage() as never} />));
    const input = container.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, "用 C 方案");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonByText("提交")!.click();
    });
    expect(vi.mocked(ipc.answerQuestion)).toHaveBeenCalledWith("run-9", "req-9", {
      [QUESTION_TEXT]: "用 C 方案",
    });
  });

  it("an option pick replaces the typed answer (single select)", async () => {
    act(() => root.render(<QuestionCard message={cardMessage() as never} />));
    await act(async () => {
      buttonByText("A")!.click();
    });
    await act(async () => {
      buttonByText("提交")!.click();
    });
    expect(vi.mocked(ipc.answerQuestion)).toHaveBeenCalledWith("run-9", "req-9", {
      [QUESTION_TEXT]: "A",
    });
  });
});
