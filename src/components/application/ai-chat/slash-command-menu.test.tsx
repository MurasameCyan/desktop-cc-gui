import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandMenu, type SlashCommandMenuHandle } from "./slash-command-menu";
import { useSlashCommandStore } from "./slash-commands";
import { type SlashCommandEntry } from "@/lib/ipc";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // lib/i18n (pulled in via app-commands) initializes i18next with this plugin.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
// jsdom omits scrollIntoView; the menu calls it to keep the active row visible.
Element.prototype.scrollIntoView ??= () => {};

const ENTRIES: SlashCommandEntry[] = [
  { name: "commit", description: "提交变更", source: "workspace", kind: "command" },
  { name: "ccg:review", description: "多模型代码审查", source: "global", kind: "command" },
  { name: "code-review", description: "审查代码", source: "workspace", kind: "skill" },
];

const optionTexts = (node: HTMLElement) =>
  [...node.querySelectorAll('[role="option"]')].map((el) => el.textContent);

describe("SlashCommandMenu", () => {
  let node: HTMLDivElement, root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    useSlashCommandStore.setState({
      byRoot: { "/ws": { entries: ENTRIES, status: "ready", fetchedAt: Date.now() } },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
  });

  it("groups commands and skills under kind headers with per-row badges", async () => {
    await act(async () =>
      root.render(
        <SlashCommandMenu root="/ws" query="" left={0} onSelect={vi.fn()} onClose={vi.fn()} />,
      ),
    );
    const headers = [...node.querySelectorAll('[role="listbox"] > div > div > div:first-child')]
      .map((el) => el.textContent)
      .filter((text) => text?.startsWith("chat.slashGroup"));
    expect(headers).toEqual(["chat.slashGroupApp", "chat.slashGroupCommands", "chat.slashGroupSkills"]);
    // Built-in app rows lead, then commands (backend catalog order), then
    // skills; each row ends with its kind badge.
    const rows = optionTexts(node);
    // 电脑操控（/ccgui-cua）入口暂时隐藏：原先 8 行、/commit 在 rows[5]、
    // skill 在 rows[7]；恢复时把行数与下标改回去并取消下方注释。
    expect(rows).toHaveLength(7);
    expect(rows[0]).toContain("/new");
    expect(rows[0]).toContain("chat.slashKindApp");
    expect(rows[1]).toContain("/clear");
    expect(rows[3]).toContain("/mcp");
    // expect(rows[4]).toContain("/ccgui-cua");
    // expect(rows[4]).toContain("chat.slashKindApp");
    expect(rows[4]).toContain("/commit");
    expect(rows[4]).toContain("chat.slashKindCommand");
    expect(rows[6]).toContain("/code-review");
    expect(rows[6]).toContain("chat.slashKindSkill");
  });

  it("a catalog command named like an app command shadows the app row", async () => {
    useSlashCommandStore.setState({
      byRoot: {
        "/ws": {
          entries: [...ENTRIES, { name: "new", description: "用户自定义", source: "workspace", kind: "command" }],
          status: "ready",
          fetchedAt: Date.now(),
        },
      },
    });
    await act(async () =>
      root.render(
        <SlashCommandMenu root="/ws" query="" left={0} onSelect={vi.fn()} onClose={vi.fn()} />,
      ),
    );
    const rows = optionTexts(node);
    // /clear, /compact, /mcp remain in the app group（/ccgui-cua 入口暂时
    // 隐藏，恢复时改回 4 行）；the user's /new renders as a command row instead.
    expect(rows.filter((text) => text?.includes("chat.slashKindApp"))).toHaveLength(3);
    expect(rows.filter((text) => text?.includes("/new"))).toHaveLength(1);
    expect(rows.find((text) => text?.includes("/new"))).toContain("chat.slashKindCommand");
  });

  it("keyboard navigation crosses the kind boundary and Enter selects", async () => {
    const onSelect = vi.fn();
    const menuRef: { current: SlashCommandMenuHandle | null } = { current: null };
    await act(async () =>
      root.render(
        <SlashCommandMenu
          root="/ws"
          query=""
          left={0}
          onSelect={onSelect}
          onClose={vi.fn()}
          menuRef={menuRef}
        />,
      ),
    );
    // The ref is re-registered as activeIndex changes; read it fresh per
    // keypress (a cached handle closes over a stale `active`). Rows: four
    // app entries, then commands, then the skill — six downs reach it.
    // （/ccgui-cua 入口暂时隐藏，恢复时改回五个 app 行、七次 ArrowDown）
    for (let i = 0; i < 6; i++) {
      act(() => {
        expect(menuRef.current!.handleKey("ArrowDown")).toBe(true);
      });
    }
    expect(node.querySelector('[data-active="true"]')?.textContent).toContain("/code-review");
    act(() => {
      expect(menuRef.current!.handleKey("Enter")).toBe(true);
    });
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[2]);
  });

  it("query filters across both kinds and keeps kind grouping intact", async () => {
    await act(async () =>
      root.render(
        <SlashCommandMenu root="/ws" query="review" left={0} onSelect={vi.fn()} onClose={vi.fn()} />,
      ),
    );
    const rows = optionTexts(node);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("/ccg:review");
    expect(rows[1]).toContain("/code-review");
  });
});
