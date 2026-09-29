/**
 * 智能体列表与编辑器的回归：行里能认出「是谁 / 干什么」，搜索能命中头衔与
 * @标识，点开编辑器后改名字会落盘（防抖后的 bot_update），拼装预览把空区块
 * 标成「已省略」而不是假装有内容。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "@/lib/ipc";

const bots = vi.hoisted(() => ({
  list: [] as unknown[],
}));

const ipcMock = vi.hoisted(() => ({
  listBots: vi.fn(async (): Promise<unknown[]> => bots.list),
  createBot: vi.fn(),
  updateBot: vi.fn(async () => bots.list[0] ?? null),
  deleteBot: vi.fn(async () => true),
  duplicateBot: vi.fn(),
  listBuiltInAgents: vi.fn(async () => ({
    provider: {
      id: "p",
      displayName: "catalog",
      sourceUrl: "https://example.com",
      sourceRevision: "rev",
      license: "MIT",
    },
    divisions: [],
    agents: [],
  })),
}));

vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, ...ipcMock } };
});

vi.mock("@/features/skills/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/skills/api")>();
  return {
    ...actual,
    cachedInstalledSkills: vi.fn(async () => ({
      targets: [],
      skills: [
        {
          id: "s1",
          key: "pdf-translate",
          name: "pdf-translate",
          description: "翻译 PDF 并保留中英对照",
          directory: "pdf-translate",
          readmeUrl: null,
          repoOwner: null,
          repoName: null,
          repoBranch: null,
          installedAt: null,
          managed: true,
          sourceKind: "managed" as const,
          readonly: false,
          targets: [],
          targetStates: {},
        },
      ],
      generatedAt: Date.now(),
    })),
  };
});

import "@/lib/i18n";
import { useBotStore } from "@/features/bots/bot-store";
import { BotsPane } from "./BotsPane";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "bot-1",
    slug: "tainai",
    name: "太奶",
    title: "耐心的讲解员",
    description: "把复杂的东西讲成家常话",
    avatar: { type: "generated", shape: "flower", color: "#14b8a6", face: "smile" },
    soul: "先给结论。",
    instructions: "",
    capabilities: { skills: ["pdf-translate"], tools: [], mcpServers: [] },
    runtime: {
      kind: "direct",
      model: null,
      cwd: null,
      extraArgs: [],
      permissionMode: "ask",
    },
    memory: {
      enabled: true,
      writeApproval: false,
      memoryCharLimit: 2200,
      reviewEnabled: true,
      reviewEveryNTurns: 5,
    },
    source: "custom",
    builtinId: null,
    pinned: false,
    hidden: false,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ipcMock.listBots.mockClear();
  ipcMock.updateBot.mockClear();
  bots.list = [
    makeBot(),
    makeBot({ id: "bot-2", slug: "reviewer", name: "代码评审员", title: "严格的守门员" }),
  ];
  useBotStore.setState({ bots: [], builtInAgents: [], builtInDivisions: [], loaded: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<BotsPane />);
  });
  await act(async () => {});
}

function text(): string {
  return container.textContent ?? "";
}

function findButton(predicate: (el: HTMLElement) => boolean): HTMLElement | undefined {
  return [...container.querySelectorAll("button")].find((el) =>
    predicate(el as HTMLElement),
  ) as HTMLElement | undefined;
}

/** React tracks the DOM value, so a plain `input.value = x` is swallowed.
 *  Going through the native setter is what makes onChange fire. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function firstRow(): HTMLElement {
  return container.querySelector('[data-testid="bot-row"]') as HTMLElement;
}

async function openEditor() {
  await act(async () => {
    firstRow().click();
  });
  await act(async () => {});
}

describe("BotsPane", () => {
  it("lists each bot with its identity and filters by search", async () => {
    await render();
    expect(text()).toContain("太奶");
    expect(text()).toContain("耐心的讲解员");
    expect(text()).toContain("代码评审员");

    await typeInto(container.querySelector("input") as HTMLInputElement, "评审");
    expect(text()).toContain("代码评审员");
    expect(text()).not.toContain("太奶");
  });

  it("filters by @handle as well as by name", async () => {
    await render();
    await typeInto(container.querySelector("input") as HTMLInputElement, "tainai");
    expect(text()).toContain("太奶");
    expect(text()).not.toContain("代码评审员");
  });

  it("opens the editor on a row and autosaves an edit", async () => {
    await render();
    await openEditor();
    // The editor's identity column and the section tabs are up.
    expect(text()).toContain("人格（SOUL）");
    expect(text()).toContain("工作规则");
    expect(text()).toContain("能力");

    // The identity column starts with the avatar studio (which has a colour
    // input), so pick the field by its current value rather than by order.
    const nameInput = [...container.querySelectorAll("input")].find(
      (input) => input.value === "太奶",
    ) as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    await typeInto(nameInput, "太奶（改）");
    await vi.waitFor(() => {
      expect(ipcMock.updateBot).toHaveBeenCalled();
    });
    const [id, patch] = ipcMock.updateBot.mock.calls[0] as unknown as [
      string,
      { name: string },
    ];
    expect(id).toBe("bot-1");
    expect(patch.name).toBe("太奶（改）");
  });

  it("shows the prompt preview with the empty blocks marked omitted", async () => {
    await render();
    await openEditor();
    const toggle = findButton((el) => el.textContent?.includes("拼装预览"));
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle?.click();
    });
    await act(async () => {});
    expect(text()).toContain("# 你的人格");
    expect(text()).toContain("工作规则");
    // 工作规则 is blank for this bot: it must say so, not fake a block.
    expect(text()).toContain("已省略");
    expect(text()).toContain("# 可用 Skills");
  });
});
