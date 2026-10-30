import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  collectEditorSearchMatches,
  createEditorSearchQuery,
  createHiddenEditorSearchPanel,
  editorSearchKeyBindings,
  editorSearchMatchInfo,
  editorSearchReplaceKey,
  type EditorSearchKeymapActions,
} from "./editor-search";

function stateOf(doc: string, selection?: { anchor: number; head?: number }) {
  return EditorState.create({ doc, selection });
}

function queryOf(
  search: string,
  overrides: Partial<{
    caseSensitive: boolean;
    regexp: boolean;
    wholeWord: boolean;
  }> = {},
) {
  return createEditorSearchQuery({
    search,
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
    ...overrides,
  });
}

describe("createEditorSearchQuery", () => {
  it("matches case-insensitively by default and strictly when requested", () => {
    const state = stateOf("Foo foo FOOD");
    expect(editorSearchMatchInfo(state, queryOf("foo")).total).toBe(3);
    expect(editorSearchMatchInfo(state, queryOf("foo", { caseSensitive: true })).total).toBe(1);
  });

  it("honours whole-word matching", () => {
    const state = stateOf("cat concatenate cat");
    expect(editorSearchMatchInfo(state, queryOf("cat")).total).toBe(3);
    expect(editorSearchMatchInfo(state, queryOf("cat", { wholeWord: true })).total).toBe(2);
  });

  it("treats non-regexp queries as literal text", () => {
    const state = stateOf("a\\nb");
    expect(editorSearchMatchInfo(state, queryOf("\\n")).total).toBe(1);
    expect(editorSearchMatchInfo(state, queryOf("\\n", { regexp: true })).total).toBe(0);
  });

  it("reports invalid regular expressions instead of throwing", () => {
    const query = queryOf("(", { regexp: true });
    expect(query.valid).toBe(false);
    const info = editorSearchMatchInfo(stateOf("anything"), query);
    expect(info).toMatchObject({ total: 0, index: 0, valid: false });
  });
});

describe("editorSearchMatchInfo", () => {
  it("locates the match under the main selection", () => {
    const state = stateOf("one two one", { anchor: 8, head: 11 });
    expect(editorSearchMatchInfo(state, queryOf("one"))).toMatchObject({
      total: 2,
      index: 2,
      truncated: false,
      valid: true,
    });
  });

  it("falls back to the first match when the cursor is not on one", () => {
    const state = stateOf("one two one", { anchor: 4 });
    expect(editorSearchMatchInfo(state, queryOf("one")).index).toBe(1);
  });

  it("caps the scan and reports truncation", () => {
    const state = stateOf("a a a a a");
    expect(editorSearchMatchInfo(state, queryOf("a"), 3)).toMatchObject({
      total: 3,
      truncated: true,
    });
    expect(editorSearchMatchInfo(state, queryOf("a"), 5)).toMatchObject({
      total: 5,
      truncated: false,
    });
  });

  it("is empty for an empty query", () => {
    expect(editorSearchMatchInfo(stateOf("abc"), queryOf(""))).toMatchObject({
      total: 0,
      index: 0,
      valid: false,
    });
  });
});

describe("collectEditorSearchMatches", () => {
  it("returns matches up to the requested limit", () => {
    const state = stateOf("one two one three one");
    const matches = collectEditorSearchMatches(state, queryOf("one"), 2);
    expect(matches).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 },
    ]);
  });
});

describe("hidden search panel", () => {
  it("stays in the top panel group so it contributes no scroll margin", () => {
    // A hidden *bottom* panel makes CodeMirror treat the scroller height as a
    // bottom scroll margin, which scrolls matches above the viewport.
    const panel = createHiddenEditorSearchPanel();
    expect(panel.top).toBe(true);
  });

  it("removes its panel group from layout when mounted", () => {
    const group = document.createElement("div");
    const panel = createHiddenEditorSearchPanel();
    group.appendChild(panel.dom);
    panel.mount?.();
    expect(group.style.display).toBe("none");
    expect(panel.dom.hidden).toBe(true);
  });
});

describe("editor search shortcuts", () => {
  it("uses Ctrl+H on Windows/Linux and Alt+Cmd+F on macOS", () => {
    expect(editorSearchReplaceKey(false)).toBe("Mod-h");
    expect(editorSearchReplaceKey(true)).toBe("Alt-Mod-f");
  });

  it("routes Mod-F and the platform replace key to the panel actions", () => {
    const actions: EditorSearchKeymapActions = {
      openFind: vi.fn(() => true),
      openReplace: vi.fn(() => true),
      close: vi.fn(() => false),
    };
    const bindings = editorSearchKeyBindings(actions, false);
    expect(bindings.map((binding) => binding.key)).toEqual(["Mod-f", "Mod-h", "Escape"]);
    expect(bindings[0].run?.({} as EditorView)).toBe(true);
    expect(bindings[1].run?.({} as EditorView)).toBe(true);
    expect(actions.openFind).toHaveBeenCalledTimes(1);
    expect(actions.openReplace).toHaveBeenCalledTimes(1);
    expect(bindings[2].run?.({} as EditorView)).toBe(false);
    expect(actions.close).toHaveBeenCalledTimes(1);
  });

  it("binds Alt+Cmd+F as the replace fallback on macOS", () => {
    const actions: EditorSearchKeymapActions = {
      openFind: vi.fn(() => true),
      openReplace: vi.fn(() => true),
      close: vi.fn(() => false),
    };
    const bindings = editorSearchKeyBindings(actions, true);
    expect(bindings.map((binding) => binding.key)).toEqual(["Mod-f", "Alt-Mod-f", "Escape"]);
  });
});
