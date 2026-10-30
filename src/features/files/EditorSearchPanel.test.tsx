import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
// Side-effect import: initializes the i18next instance useTranslation reads.
import i18n from "@/lib/i18n";
import { EditorSearchPanel } from "./EditorSearchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout engine. CodeMirror measures text ranges when a search
// match is scrolled into view; an empty rect list is enough for these tests.
if (typeof Range.prototype.getClientRects !== "function") {
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    value: () => new DOMRect(0, 0, 0, 0),
  });
}

const viewHost = document.createElement("div");
let view: EditorView;
let container: HTMLDivElement;
let root: Root;

function makeView(doc: string, selection?: { anchor: number; head: number }) {
  document.body.appendChild(viewHost);
  view = new EditorView({
    state: EditorState.create({ doc, selection }),
    parent: viewHost,
  });
  openSearchPanel(view);
}

function renderPanel(options: { showReplace?: boolean; readOnly?: boolean } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <EditorSearchPanel
        view={view}
        open
        showReplace={options.showReplace ?? false}
        readOnly={options.readOnly ?? false}
        focusRequest={{ target: "find", token: 1 }}
        documentText={view.state.doc.toString()}
        onShowReplaceChange={() => {}}
        onClose={() => {}}
      />,
    ),
  );
}

function input(placeholder: string) {
  const field = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!field) throw new Error(`input not found: ${placeholder}`);
  return field;
}

function typeInto(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string) {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`button not found: ${label}`);
  return element;
}

function statusText() {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  view?.destroy();
  viewHost.remove();
  vi.useRealTimers();
});

describe("EditorSearchPanel", () => {
  it("seeds the query from a single-line selection and selects it", () => {
    makeView("one two one", { anchor: 0, head: 3 });
    renderPanel();

    const field = input(i18n.t("files.editorSearch.find"));
    expect(field.value).toBe("one");
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(3);
  });

  it("searches, counts and steps through matches", () => {
    makeView("one two one");
    renderPanel();

    typeInto(input(i18n.t("files.editorSearch.find")), "one");
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // The first match is selected and the counter reflects it.
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      "one",
    );
    expect(statusText()).toBe("1/2");

    act(() => button(i18n.t("files.editorSearch.nextMatch")).click());
    expect(statusText()).toBe("2/2");
  });

  it("replaces every match", () => {
    makeView("one two one");
    renderPanel({ showReplace: true });

    typeInto(input(i18n.t("files.editorSearch.find")), "one");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    typeInto(input(i18n.t("files.editorSearch.replace")), "1");

    act(() => {
      const replaceAll = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.textContent === i18n.t("files.editorSearch.replaceAll"),
      );
      replaceAll?.click();
    });

    expect(view.state.doc.toString()).toBe("1 two 1");
  });

  it("hides replacement controls for read-only files", () => {
    makeView("one two one");
    renderPanel({ showReplace: true, readOnly: true });

    expect(
      container.querySelector(`button[aria-label="${i18n.t("files.editorSearch.expandReplace")}"]`),
    ).toBeNull();
    // The row stays mounted for the collapse animation but is not visible.
    const replaceInput = input(i18n.t("files.editorSearch.replace"));
    expect(replaceInput.closest('[style*="visibility: hidden"]')).not.toBeNull();
    expect(button(i18n.t("files.editorSearch.selectAllMatches"))).not.toBeNull();
  });
});
