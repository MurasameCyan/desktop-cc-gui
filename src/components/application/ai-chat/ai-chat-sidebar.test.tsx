import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionMenuRegistry } from "@ccgui/plugin-sdk";
import { AiChatSidebar } from "./ai-chat-sidebar";
import type { AiChatRepo } from "./ai-chat-sidebar";
import type * as ReactI18next from "react-i18next";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const KEY = "ccgui-next.sidebarExpandedWorkspaces:v1";

function repo(id: string, defaultOpen = false): AiChatRepo {
  return { id, label: id, defaultOpen, threads: [] };
}

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

/** The row body is the toggle button carrying aria-expanded + the label. */
function rowFor(label: string): HTMLElement {
  const rows = [...node.querySelectorAll<HTMLElement>("button[aria-expanded]")];
  const match = rows.find((el) => el.textContent?.includes(label));
  if (!match) throw new Error(`no header row for ${label}`);
  return match;
}

async function render(repos: AiChatRepo[]) {
  await act(async () => {
    root.render(<AiChatSidebar repos={repos} />);
  });
}

it("remembers which workspaces the user expanded", async () => {
  // The bug: expansion lived in component state, so every restart reopened
  // only the first workspace and the user's tree shape was lost.
  await render([repo("a"), repo("b"), repo("c")]);
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("false");

  await act(async () => rowFor("b").click());

  expect(rowFor("b").getAttribute("aria-expanded")).toBe("true");
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toContain("b");

  // Remount: the freshly mounted sidebar must restore the same shape.
  await act(async () => root.unmount());
  root = createRoot(node);
  await render([repo("a"), repo("b"), repo("c")]);
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("true");
  // Untouched rows keep the built-in default (only the first opens).
  expect(rowFor("c").getAttribute("aria-expanded")).toBe("false");
});

it("active draft 新对话会展开其所在的折叠工作区", async () => {
  localStorage.setItem(KEY, JSON.stringify([]));
  await act(async () => {
    root.render(
      <AiChatSidebar
        activeThreadId="new:codex:/ws/b"
        repos={[
          repo("a", true),
          {
            id: "b",
            label: "b",
            threads: [
              {
                id: "new:codex:/ws/b",
                label: "新对话",
                time: "",
                isDraft: true,
              },
            ],
          },
        ]}
      />,
    );
  });
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("true");
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toContain("b");

  await act(async () => rowFor("b").click());
  expect(rowFor("b").getAttribute("aria-expanded")).toBe("false");
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).not.toContain("b");
});

it("remembers collapses too, and the default never overrides a stored set", async () => {
  await render([repo("a", true), repo("b")]);
  expect(rowFor("a").getAttribute("aria-expanded")).toBe("true");

  await act(async () => rowFor("a").click());
  expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).not.toContain("a");

  await act(async () => root.unmount());
  root = createRoot(node);
  // defaultOpen would open "a" again, but the user's choice wins.
  await render([repo("a", true), repo("b")]);
  expect(rowFor("a").getAttribute("aria-expanded")).toBe("false");
});

function namedThreadCount(): number {
  return [...node.querySelectorAll("button")].filter((el) =>
    /^对话\d+$/.test((el.textContent ?? "").replace(/\s+/g, "")),
  ).length;
}

it("展开只显示 threadLimit 条,收起再展开不会保留加载更多", async () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `codex/s-${index}`,
    label: `对话${index}`,
    time: "1m",
  }));
  await act(async () => {
    root.render(
      <AiChatSidebar
        activeThreadId="codex/s-10"
        repos={[{ id: "a", label: "a", defaultOpen: true, threadLimit: 5, threads }]}
      />,
    );
  });
  expect(namedThreadCount()).toBe(5);

  const more = [...node.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("chat.showMoreSessions"),
  );
  if (!more) throw new Error("no load-more row");
  await act(async () => more.click());
  expect(namedThreadCount()).toBe(12);

  await act(async () => rowFor("a").click());
  await act(async () => rowFor("a").click());
  expect(namedThreadCount()).toBe(5);
});

it("收起会话列表时裁切高度而不做透明度淡出", async () => {
  const threads = Array.from({ length: 3 }, (_, index) => ({
    id: `codex/s-${index}`,
    label: `对话${index}`,
    time: "1m",
  }));
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[{ id: "a", label: "a", defaultOpen: true, threads }]}
      />,
    );
  });
  expect(namedThreadCount()).toBe(3);

  await act(async () => rowFor("a").click());

  const panel = [...node.querySelectorAll<HTMLElement>("[aria-hidden]")].find((el) =>
    (el.getAttribute("class") ?? "").includes("grid-rows-"),
  );
  if (!panel) throw new Error("no collapse panel");
  expect(panel.className).toContain("grid-rows-[0fr]");
  expect(panel.className).not.toMatch(/opacity-0/);
  expect(panel.querySelector(".min-h-0.overflow-hidden")).toBeTruthy();
  // Still in the DOM so the height can clip shut; the next workspace must
  // not see a faded copy of these rows.
  expect(namedThreadCount()).toBe(3);
});
/** The session row whose label is inside it (the hover-action div wrapping
 *  the row button). */
function threadRow(label: string): HTMLElement {
  const body = [...node.querySelectorAll<HTMLElement>("button")].find((el) =>
    el.textContent?.includes(label),
  );
  const row = body?.closest("div");
  if (!row) throw new Error(`no thread row for ${label}`);
  return row;
}

/** The portaled context menu lives on document.body, outside the render node. */
function openMenu(): HTMLElement {
  const menu = document.body.querySelector<HTMLElement>("[role='menu']");
  if (!menu) throw new Error("no context menu open");
  return menu;
}

function menuItem(menu: HTMLElement, label: string): HTMLElement {
  const item = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) =>
    el.textContent?.includes(label),
  );
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

async function rightClick(row: HTMLElement) {
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

it("opens the thread context menu on right-click and dispatches its entries", async () => {
  const onThreadAction = vi.fn();
  const onCopyThreadId = vi.fn();
  const thread = { id: "claude/abc-123", label: "整理发布脚本", time: "1分钟" };
  await act(async () => {
    root.render(
      <AiChatSidebar
        repos={[{ id: "a", label: "a", defaultOpen: true, threads: [thread] }]}
        onThreadAction={onThreadAction}
        onCopyThreadId={onCopyThreadId}
      />,
    );
  });

  await rightClick(threadRow("整理发布脚本"));
  let menu = openMenu();
  await act(async () => menuItem(menu, "chat.renameSession").click());
  expect(onThreadAction).toHaveBeenCalledWith("claude/abc-123", "rename");
  expect(document.body.querySelector("[role='menu']")).toBeNull();

  await rightClick(threadRow("整理发布脚本"));
  menu = openMenu();
  await act(async () => menuItem(menu, "chat.copySessionId").click());
  expect(onCopyThreadId).toHaveBeenCalledWith("claude/abc-123");

  await rightClick(threadRow("整理发布脚本"));
  menu = openMenu();
  await act(async () => menuItem(menu, "chat.deleteSession").click());
  expect(onThreadAction).toHaveBeenCalledWith("claude/abc-123", "delete");
});

it("renders plugin session-menu items and dispatches the parsed target", async () => {
  const run = vi.fn();
  const dispose = sessionMenuRegistry.register({
    id: "plugin:auto-title:rename",
    label: () => "AI Rename",
    run,
  });
  try {
    const thread = { id: "omp/sid-42", label: "拖入分组", time: "1分钟" };
    await act(async () => {
      root.render(
        <AiChatSidebar
          repos={[{ id: "a", label: "a", defaultOpen: true, threads: [thread] }]}
          onThreadAction={vi.fn()}
        />,
      );
    });

    await rightClick(threadRow("拖入分组"));
    const menu = openMenu();
    await act(async () => menuItem(menu, "AI Rename").click());
    expect(run).toHaveBeenCalledWith({ engine: "omp", sessionId: "sid-42" });
    expect(document.body.querySelector("[role='menu']")).toBeNull();
  } finally {
    dispose();
  }
});

it("draft 新对话右键只提供删除,不暴露重命名/复制 ID/插件项", async () => {
  const onThreadAction = vi.fn();
  const onCopyThreadId = vi.fn();
  const dispose = sessionMenuRegistry.register({
    id: "plugin:auto-title:rename",
    label: () => "AI Rename",
    run: vi.fn(),
  });
  try {
    await act(async () => {
      root.render(
        <AiChatSidebar
          repos={[
            {
              id: "a",
              label: "a",
              defaultOpen: true,
              threads: [
                {
                  id: "new:codex:/ws/a",
                  label: "新对话",
                  time: "",
                  isDraft: true,
                },
              ],
            },
          ]}
          onThreadAction={onThreadAction}
          onCopyThreadId={onCopyThreadId}
        />,
      );
    });

    await rightClick(threadRow("新对话"));
    const menu = openMenu();
    expect([...menu.querySelectorAll("[role='menuitem']")].map((el) => el.textContent)).toEqual([
      "chat.deleteSession",
    ]);
    await act(async () => menuItem(menu, "chat.deleteSession").click());
    expect(onThreadAction).toHaveBeenCalledWith("new:codex:/ws/a", "delete");
    expect(onCopyThreadId).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it("keeps right-click inert when no thread handler is wired", async () => {
  await render([
    { id: "a", label: "a", defaultOpen: true, threads: [{ id: "t1", label: "孤独会话", time: "1分钟" }] },
  ]);
  await rightClick(threadRow("孤独会话"));
  expect(document.body.querySelector("[role='menu']")).toBeNull();
});
