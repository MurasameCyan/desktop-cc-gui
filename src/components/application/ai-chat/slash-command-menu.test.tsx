import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandMenu, type SlashCommandMenuHandle } from "./slash-command-menu";
import { useSlashCommandStore } from "./slash-commands";
import { type SlashCommandEntry } from "@/lib/ipc";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
      .filter((text) => text === "chat.slashGroupCommands" || text === "chat.slashGroupSkills");
    expect(headers).toEqual(["chat.slashGroupCommands", "chat.slashGroupSkills"]);
    // Commands first (backend catalog order), skills after; each row ends
    // with its kind badge.
    const rows = optionTexts(node);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("/commit");
    expect(rows[0]).toContain("chat.slashKindCommand");
    expect(rows[2]).toContain("/code-review");
    expect(rows[2]).toContain("chat.slashKindSkill");
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
    // keypress (a cached handle closes over a stale `active`).
    act(() => {
      expect(menuRef.current!.handleKey("ArrowDown")).toBe(true);
    });
    act(() => {
      expect(menuRef.current!.handleKey("ArrowDown")).toBe(true);
    });
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
