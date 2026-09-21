import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { AiChatRepo } from "@/components/application/ai-chat/ai-chat-sidebar";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import { useChatStore } from "./store";
import { useChatSidebar } from "./use-chat-sidebar";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/platform", () => ({
  pickDirectory: vi.fn(async () => null),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const WS: Workspace = {
  id: "w1",
  path: "/ws/a",
  name: "a",
  sortOrder: 0,
  groupId: null,
} as Workspace;

const SESSION: SessionMeta = {
  engine: "codex",
  sessionId: "s-1",
  workspacePath: "/ws/a",
  filePath: "/local/s-1.jsonl",
  fileSize: 1,
  fileMtimeMs: 1,
  title: "local",
  preview: "",
  createdAt: null,
  updatedAt: 1,
  messageCount: 1,
  pinned: false,
  customTitle: null,
};

let container: HTMLDivElement;
let root: Root;
let captured: AiChatRepo[];

function Harness() {
  const streaming = useChatStore((s) => s.streamingByKey["codex/s-1"] === true);
  const retrying = useChatStore((s) => s.retryingByKey["codex/s-1"] === true);
  const { repos } = useChatSidebar({
    sessionById: new Map(),
    threadStreaming: [streaming],
    threadRetrying: [retrying],
    collapseSidebarOnMobile: () => {},
    composerInputRef: { current: null },
    setDialog: () => {},
  });
  captured = repos;
  return null;
}

describe("useChatSidebar repo mapping", () => {
  beforeEach(async () => {
    useChatStore.setState({
      workspaces: [WS],
      sessions: [SESSION],
      openTabs: [],
      threadLimit: 7,
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      retryingByKey: {},
      streamingByKey: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      window.__ccguiWorkspaceUI?.registerHooks(null);
      root.unmount();
    });
    container.remove();
  });

  it("threadLimit 透传到 repo(分页折叠依赖它,删了设置就失效)", () => {
    expect(captured).toHaveLength(1);
    expect(captured[0]?.threadLimit).toBe(7);
    expect(captured[0]?.threads.map((t) => t.id)).toEqual(["codex/s-1"]);
  });

  it("pending 新对话出现在对应工作区线程列表顶部", async () => {
    await act(async () => {
      useChatStore.setState({
        openTabs: [{ engine: "codex", sessionId: null, workspacePath: "/ws/a" }],
        active: { engine: "codex", sessionId: null, workspacePath: "/ws/a" },
      });
    });
    expect(captured[0]?.threads.map((thread) => thread.id)).toEqual([
      "new:codex:/ws/a",
      "codex/s-1",
    ]);
    expect(captured[0]?.threads[0]).toMatchObject({
      label: "新对话",
      isDraft: true,
      engine: "codex",
    });
  });

  it("插件桥 hooks 注册后徽标响应式出现(activate/热重载不等无关重渲染)", async () => {
    expect(captured[0]?.labelSuffix).toBeUndefined();
    await act(async () => {
      window.__ccguiWorkspaceUI?.registerHooks({
        allowedEngines: () => null,
        labelSuffix: (p) => (p === "/ws/a" ? "WSL" : null),
      });
    });
    expect(captured[0]?.labelSuffix).toBe("WSL");
  });

  it("maps retrying state to the matching sidebar thread", async () => {
    await act(async () => {
      useChatStore.setState({
        streamingByKey: { "codex/s-1": true },
        retryingByKey: { "codex/s-1": true },
      });
    });

    expect(captured[0]?.threads[0]).toMatchObject({
      streaming: true,
      retrying: true,
    });
  });
});
