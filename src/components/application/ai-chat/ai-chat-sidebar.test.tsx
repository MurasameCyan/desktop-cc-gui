import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiChatSidebar } from "./ai-chat-sidebar";
import type { AiChatRepo } from "./ai-chat-sidebar";

vi.mock("react-i18next", () => ({
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

it("keeps right-click inert when no thread handler is wired", async () => {
  await render([
    { id: "a", label: "a", defaultOpen: true, threads: [{ id: "t1", label: "孤独会话", time: "1分钟" }] },
  ]);
  await rightClick(threadRow("孤独会话"));
  expect(document.body.querySelector("[role='menu']")).toBeNull();
});
