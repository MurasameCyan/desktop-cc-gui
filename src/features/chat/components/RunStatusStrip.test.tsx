import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { useChatStore } from "../store";
import { useGitStore } from "@/features/git/store";
import { RunStatusStrip } from "./RunStatusStrip";
import { deriveTodoList } from "./agent-task-steps";
import type { Message, TodosPayload } from "@/lib/ipc";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "test-session";
const WS = "/ws";

function msg(seq: number, role: string, text: string, path?: string): Message {
  return { seq, role, text, path: path ?? null, ts: null };
}
function todoMsg(seq: number, todos: TodosPayload): Message {
  return { seq, role: "tool", text: "todo", ts: null, todos };
}

/** Turn with one active subagent spawn and one edit to /ws/src/a.ts. */
const TURN: Message[] = [
  msg(1, "user", "fix the tests"),
  msg(2, "tool", "task · Dispatching 10 parallel fix agents"),
  msg(3, "tool", "edit_file", "/ws/src/a.ts"),
];

function seed(messages: Message[], streaming: boolean) {
  useChatStore.setState({
    bySession: { [KEY]: { messages, streaming } as never },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh");
  useChatStore.setState({ bySession: {} });
  useGitStore.setState({
    statusByWorkspace: {
      [WS]: {
        branch: "main",
        staged: [],
        unstaged: [{ path: "src/a.ts", status: "M", additions: 10, deletions: 2 }],
        untracked: [],
      },
    },
    // Strip must not hit IPC in tests.
    refresh: async () => {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderStrip() {
  await act(async () => {
    root.render(<RunStatusStrip sessionKey={KEY} engine="pi" workspacePath={WS} />);
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function pill(label: string): Element {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (el) => el.textContent?.includes(label),
  );
  expect(found, `pill ${label}`).toBeTruthy();
  return found!;
}

describe("RunStatusStrip", () => {
  it("renders subagent count and edited git stats as pills", async () => {
    seed(TURN, true);
    await renderStrip();
    expect(pill("子代理").textContent).toContain("0/1");
    const edited = pill("已编辑");
    expect(edited.textContent).toContain("+10");
    expect(edited.textContent).toContain("−2");
  });

  it("opens panels single-open above the strip and closes on Esc", async () => {
    seed(TURN, true);
    await renderStrip();

    await click(pill("子代理"));
    expect(container.querySelector("[data-testid='run-status-subagents']")?.textContent).toContain(
      "运行中",
    );

    // Single-open: switching pills swaps the panel.
    await click(pill("已编辑"));
    expect(container.querySelector("[data-testid='run-status-subagents']")).toBeNull();
    expect(container.querySelector("[data-testid='run-status-files']")?.textContent).toContain(
      "a.ts",
    );

    // Same pill toggles closed…
    await click(pill("已编辑"));
    expect(container.querySelector("[data-testid='run-status-files']")).toBeNull();

    // …and Esc collapses an open panel.
    await click(pill("子代理"));
    expect(container.querySelector("[data-testid='run-status-subagents']")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector("[data-testid='run-status-subagents']")).toBeNull();
  });

  it("chrome toggle hides the pill row and persists across remounts", async () => {
    seed(TURN, true);
    await renderStrip();
    await click(container.querySelector("[aria-label='收起运行状态']")!);
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(localStorage.getItem("ccgui.chat.runStatusChromeOpen")).toBe("0");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderStrip();
    expect(container.querySelector('[role="tab"]')).toBeNull();
    expect(container.querySelector("[aria-label='展开运行状态']")).not.toBeNull();
  });

  it("freezes counts and shows 已完成 once the turn settles", async () => {
    seed(TURN, true);
    await renderStrip();
    await act(async () => {
      seed(TURN, false);
    });
    expect(pill("子代理").textContent).toContain("1/1");
    await click(pill("子代理"));
    expect(container.querySelector("[data-testid='run-status-subagents']")?.textContent).toContain(
      "已完成",
    );
    expect(container.querySelector("[data-testid='run-status-subagents']")?.textContent).not.toContain(
      "运行中",
    );
  });

  it("renders nothing when the turn has no subagents or edits", async () => {
    seed([msg(1, "user", "hi"), msg(2, "assistant", "hello")], false);
    await renderStrip();
    expect(container.querySelector("[data-testid='run-status-strip']")).toBeNull();
  });
  it("ignores write-tool rows targeting device endpoints, not files", async () => {
    seed(
      [msg(1, "user", "hi"), msg(2, "tool", "write", "xd://browser"), msg(3, "tool", "edit_file", "/ws/src/a.ts")],
      false,
    );
    await renderStrip();
    await click(pill("已编辑"));
    const files = container.querySelector("[data-testid='run-status-files']");
    expect(files?.textContent).toContain("a.ts");
    expect(files?.textContent).not.toContain("browser");
  });
  it("keeps files edited in earlier turns (session-scoped, no expiry)", async () => {
    seed(
      [
        msg(1, "user", "first turn"),
        msg(2, "tool", "edit_file", "/ws/src/old.ts"),
        msg(3, "assistant", "done"),
        msg(4, "user", "second turn"),
        msg(5, "assistant", "no edits this turn"),
      ],
      false,
    );
    await renderStrip();
    await click(pill("已编辑"));
    expect(container.querySelector("[data-testid='run-status-files']")?.textContent).toContain(
      "old.ts",
    );
  });
  it("folds todo snapshots and patches into the 任务 pill", async () => {
    seed(
      [
        msg(1, "user", "do work"),
        todoMsg(2, {
          replace: true,
          items: [
            { content: "定位根因", status: "pending" },
            { content: "修复", status: "pending" },
            { content: "回归验证", status: "pending" },
          ],
        }),
        todoMsg(3, { replace: false, items: [{ content: "定位根因", status: "complete" }] }),
        todoMsg(4, { replace: false, items: [{ content: "修复", status: "active" }] }),
      ],
      true,
    );
    await renderStrip();
    expect(pill("任务").textContent).toContain("1/3");
    await click(pill("任务"));
    const panel = container.querySelector("[data-testid='run-status-todos']")?.textContent;
    expect(panel).toContain("定位根因");
    expect(panel).toContain("已完成");
    expect(panel).toContain("运行中");
    expect(panel).toContain("待处理");
  });

  it("a later replace snapshot resets the list; dropped patches remove items", async () => {
    const folded = deriveTodoList([
      todoMsg(1, {
        replace: true,
        items: [
          { content: "a", status: "pending" },
          { content: "b", status: "pending" },
        ],
      }),
      todoMsg(2, { replace: false, items: [{ content: "a", status: "dropped" }] }),
      todoMsg(3, { replace: true, items: [{ content: "c", status: "complete" }] }),
    ]);
    expect(folded).toEqual([{ content: "c", status: "complete" }]);
  });

  it("extracts subagent type and description with breathing light indicator", async () => {
    const subagentTurn: Message[] = [
      msg(1, "user", "run architecture analysis"),
      {
        seq: 2,
        role: "tool",
        text: "Agent",
        ts: null,
        args: {
          subagent_type: "architect",
          description: "分析系统设计与模块划分",
        },
      },
    ];

    seed(subagentTurn, true);
    await renderStrip();

    expect(pill("子代理").textContent).toContain("0/1");
    // In running state, breathing light animation is rendered
    expect(container.querySelector(".animate-ping")).not.toBeNull();

    await click(pill("子代理"));
    const panel = container.querySelector("[data-testid='run-status-subagents']")?.textContent;
    expect(panel).toContain("architect");
    expect(panel).toContain("分析系统设计与模块划分");
    expect(panel).toContain("运行中");
  });

  it("opens a subagent's full assignment inside the existing panel", async () => {
    const assignment = "# Target\nOwn relay.rs only.\n# Acceptance\nOutages recover without toggling.";
    seed([
      msg(1, "user", "delegate"),
      {
        seq: 2,
        role: "tool",
        text: "task · Dispatching relay worker",
        ts: null,
        args: { tasks: [{ agent: "task", name: "RelayRecovery", task: assignment }] },
      },
    ], true);
    await renderStrip();
    await click(pill("子代理"));
    await click(container.querySelector("[data-agent-step-key]")!);

    const panel = container.querySelector("[data-testid='run-status-subagents']");
    expect(panel?.textContent).toContain("RelayRecovery");
    expect(panel?.textContent).toContain("Own relay.rs only.");
    expect(panel?.textContent).toContain("Outages recover without toggling.");
    expect(panel?.querySelector("[data-testid='subagent-detail-overlay']")).not.toBeNull();
  });

  it("keeps subagents from earlier turns visible in completed state", async () => {
    const multiTurn: Message[] = [
      msg(1, "user", "turn 1: run subagent"),
      {
        seq: 2,
        role: "tool",
        text: "Agent",
        ts: null,
        args: {
          subagent_type: "code-reviewer",
          description: "检查代码安全漏洞",
        },
      },
      msg(3, "assistant", "turn 1 finished"),
      msg(4, "user", "turn 2: ordinary message"),
      msg(5, "assistant", "no subagents here"),
    ];

    seed(multiTurn, false);
    await renderStrip();

    // The subagent pill survives cross-turn in completed state
    expect(pill("子代理").textContent).toContain("1/1");
    expect(container.querySelector(".animate-ping")).toBeNull();

    await click(pill("子代理"));
    const panel = container.querySelector("[data-testid='run-status-subagents']")?.textContent;
    expect(panel).toContain("code-reviewer");
    expect(panel).toContain("检查代码安全漏洞");
    expect(panel).toContain("已完成");
  });

  it("correctly maps TaskCreate and subsequent TaskUpdate by taskId to complete status", async () => {
    const taskTurn: Message[] = [
      msg(1, "user", "create and complete task"),
      {
        seq: 2,
        role: "tool",
        text: "TaskCreate",
        ts: null,
        args: {
          subject: "在输入框上方模块增加子代理任务信息与呼吸灯",
        },
        result: "Task #13 created successfully",
        todos: {
          replace: false,
          items: [
            {
              id: "13",
              content: "在输入框上方模块增加子代理任务信息与呼吸灯",
              status: "pending",
            },
          ],
        },
      },
      {
        seq: 3,
        role: "tool",
        text: "TaskUpdate",
        ts: null,
        args: {
          taskId: "13",
          status: "completed",
        },
        todos: {
          replace: false,
          items: [
            {
              id: "13",
              content: "",
              status: "complete",
            },
          ],
        },
      },
    ];

    seed(taskTurn, false);
    await renderStrip();

    expect(pill("任务").textContent).toContain("1/1");
    await click(pill("任务"));
    const panel = container.querySelector("[data-testid='run-status-todos']")?.textContent;
    expect(panel).toContain("在输入框上方模块增加子代理任务信息与呼吸灯");
    expect(panel).toContain("已完成");
    expect(panel).not.toContain("待处理");
  });
});
