import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSearchPalette } from "./session-search-palette";
import type { AiChatRepo } from "./sidebar-types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// jsdom implements <dialog> but not its modal methods; the palette drives
// showModal()/close() to keep the element in sync with React state.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

const repos: AiChatRepo[] = [
  {
    id: "ws-a",
    label: "desktop-cc-gui",
    threads: [
      { id: "t-1", label: "修复登录闪退", time: "1h" },
      { id: "t-2", label: "侧边栏搜索弹窗", time: "2h" },
    ],
  },
  {
    id: "ws-b",
    label: "vscode-cc-gui",
    threads: [{ id: "t-3", label: "发布流水线", time: "3h" }],
  },
];

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

function options(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("dialog [role='option']")];
}

async function render(open: boolean, onThreadSelect = vi.fn()) {
  const props = { open, repos, onClose: vi.fn(), onThreadSelect };
  await act(async () => {
    root.render(<SessionSearchPalette {...props} />);
  });
  return props;
}

async function type(value: string) {
  const input = document.querySelector<HTMLInputElement>("dialog input");
  if (!input) throw new Error("no palette input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("lists sessions newest-first on open and jumps on click", async () => {
  const { onThreadSelect, onClose } = await render(true);
  expect(options().map((el) => el.textContent)).toEqual([
    "修复登录闪退1hdesktop-cc-gui",
    "侧边栏搜索弹窗2hdesktop-cc-gui",
    "发布流水线3hvscode-cc-gui",
  ]);

  await act(async () => options()[1].click());
  expect(onThreadSelect).toHaveBeenCalledWith("t-2");
  expect(onClose).toHaveBeenCalled();
});

it("filters by session title, not by unrelated content", async () => {
  await render(true);
  await type("流水线");
  expect(options().map((el) => el.textContent)).toEqual(["发布流水线3hvscode-cc-gui"]);

  await type("不存在的会话");
  expect(options()).toEqual([]);
});

it("matches a workspace name by surfacing its sessions", async () => {
  await render(true);
  await type("vscode");
  expect(options().map((el) => el.textContent)).toEqual(["发布流水线3hvscode-cc-gui"]);
});

it("Enter selects the active row and Escape closes", async () => {
  const { onThreadSelect, onClose } = await render(true);
  await type("闪退");
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  });
  expect(onThreadSelect).toHaveBeenCalledWith("t-1");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  });
  expect(onClose).toHaveBeenCalled();
});
