import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSearchPalette } from "./session-search-palette";
import type { AiChatRepo } from "./sidebar-types";
import { ipc, type MessageSearchHit, type MessageSearchPage } from "@/lib/ipc";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: { searchMessages: vi.fn() },
}));
// time.ts (relativeTime for content-hit rows) pulls in the real i18n
// instance, which cannot initialize under jsdom.
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));

function contentHit(overrides: Partial<MessageSearchHit>): MessageSearchHit {
  return {
    engine: "claude",
    sessionId: "s-1",
    workspacePath: "/ws",
    workspaceName: "desktop-cc-gui",
    title: "内容命中",
    customTitle: null,
    updatedAt: null,
    role: "assistant",
    snippet: [
      { text: "…前缀 ", marked: false },
      { text: "命中词", marked: true },
      { text: " 后缀…", marked: false },
    ],
    ...overrides,
  };
}
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
  vi.mocked(ipc.searchMessages).mockReset();
  vi.mocked(ipc.searchMessages).mockResolvedValue({ hits: [], hasMore: false, pending: 0 });
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

/** The 标题 / 内容 lane-filter chip (addressed by its i18n key). */
function chip(key: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (b) => b.textContent === key,
  );
  if (!el) throw new Error(`no chip ${key}`);
  return el;
}

async function render(open: boolean, onThreadSelect = vi.fn(), repoList = repos) {
  const props = { open, repos: repoList, onClose: vi.fn(), onThreadSelect };
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
it("shows debounced message-content hits with highlighted snippets", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(ipc.searchMessages).mockResolvedValue({
      hits: [contentHit({ sessionId: "s-9", title: "版本记录" })],
      hasMore: false,
      pending: 0,
    });
    const { onThreadSelect } = await render(true);
    await type("已生成");
    // Debounce: nothing fires before the 300ms pause.
    expect(ipc.searchMessages).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(ipc.searchMessages).toHaveBeenCalledWith("已生成", 20, 0);

    const rows = options();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("版本记录");
    expect(rows[0].querySelector("mark")?.textContent).toBe("命中词");

    await act(async () => rows[0].click());
    expect(onThreadSelect).toHaveBeenCalledWith("claude/s-9");
  } finally {
    vi.useRealTimers();
  }
});
it("shows the remaining-index count while the indexer has pending sessions", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(ipc.searchMessages).mockResolvedValue({
      hits: [],
      hasMore: false,
      pending: 3,
    });
    await render(true);
    await type("关键词检索");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    const status = document.querySelector("dialog [aria-live='polite']");
    expect(status?.textContent).toBe('chat.searchIndexing:{"count":3}');
  } finally {
    vi.useRealTimers();
  }
});

it("filter chips narrow the title and content lanes inclusively", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(ipc.searchMessages).mockResolvedValue({
      hits: [contentHit({ sessionId: "s-9", title: "版本记录" })],
      hasMore: false,
      pending: 0,
    });
    await render(true);
    // Both chips pressed by default: title row first, then the content hit.
    await type("流水线");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    const both = options().map((el) => el.textContent);
    expect(both[0]).toBe("发布流水线3hvscode-cc-gui");
    expect(both[1]).toContain("版本记录");
    expect(both).toHaveLength(2);

    // Content off: title rows only, and the FTS query is never fired.
    await act(async () => chip("chat.searchScopeContent").click());
    expect(options().map((el) => el.textContent)).toEqual(["发布流水线3hvscode-cc-gui"]);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(ipc.searchMessages).toHaveBeenCalledTimes(1);

    // Un-pressing the last pressed chip flips both back on (and refetches).
    await act(async () => chip("chat.searchScopeTitle").click());
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(options()).toHaveLength(2);
    expect(ipc.searchMessages).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("content-only reveals a hit for a session whose title row is hidden", async () => {
  vi.useFakeTimers();
  try {
    const titled = [
      {
        id: "ws-a",
        label: "desktop-cc-gui",
        threads: [{ id: "claude/s-1", label: "版本记录会话", time: "1h" }],
      },
    ];
    vi.mocked(ipc.searchMessages).mockResolvedValue({
      hits: [contentHit({ sessionId: "s-1", title: "版本记录会话" })],
      hasMore: false,
      pending: 0,
    });
    await render(true, vi.fn(), titled);
    await type("版本记录");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    // Both lanes on: the session shows once, as its title row.
    expect(options().map((el) => el.textContent)).toEqual(["版本记录会话1hdesktop-cc-gui"]);

    // With the title lane hidden there is no row to de-duplicate against, so
    // the same session's body hit is listed.
    await act(async () => chip("chat.searchScopeTitle").click());
    const rows = options();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("版本记录会话");
    expect(rows[0].querySelector("mark")?.textContent).toBe("命中词");
  } finally {
    vi.useRealTimers();
  }
});

it("suspends the stored lane filter while the chips are hidden", async () => {
  await render(true);
  await type("闪退");
  await act(async () => chip("chat.searchScopeTitle").click());
  expect(chip("chat.searchScopeTitle").getAttribute("aria-pressed")).toBe("false");
  expect(options()).toEqual([]);

  // One char: the chips disappear, so the filter must not blank the list.
  await type("闪");
  expect(document.querySelector("dialog [aria-pressed]")).toBeNull();
  expect(options().map((el) => el.textContent)).toEqual(["修复登录闪退1hdesktop-cc-gui"]);
});

it("resets the lane filters on the next open", async () => {
  await render(true);
  await type("闪退");
  await act(async () => chip("chat.searchScopeTitle").click());
  expect(chip("chat.searchScopeTitle").getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    root.render(<SessionSearchPalette open={false} repos={repos} onClose={vi.fn()} />);
  });
  await act(async () => {
    root.render(<SessionSearchPalette open repos={repos} onClose={vi.fn()} />);
  });
  await type("闪退");
  expect(chip("chat.searchScopeTitle").getAttribute("aria-pressed")).toBe("true");
  expect(chip("chat.searchScopeContent").getAttribute("aria-pressed")).toBe("true");
});

it("drops a stale content response that lands after a newer one", async () => {
  vi.useFakeTimers();
  try {
    let resolveFirst!: (page: MessageSearchPage) => void;
    const first = new Promise<MessageSearchPage>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(ipc.searchMessages)
      .mockImplementationOnce(() => first)
      .mockResolvedValue({
        hits: [contentHit({ sessionId: "s-new", title: "新查询结果" })],
        hasMore: false,
        pending: 0,
      });
    await render(true);
    await type("查询一");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await type("查询二二");
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(options()[0]?.textContent).toContain("新查询结果");

    // The first request resolves late; its hits must not overwrite.
    await act(async () => {
      resolveFirst({
        hits: [contentHit({ sessionId: "s-old", title: "旧查询结果" })],
        hasMore: false,
        pending: 0,
      });
    });
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("新查询结果");
    expect(options()[0].textContent).not.toContain("旧查询结果");
  } finally {
    vi.useRealTimers();
  }
});
