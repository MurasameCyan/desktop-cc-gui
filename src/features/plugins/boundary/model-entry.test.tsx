import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelEntryRegistry, type Disposer, type ModelEntryProps } from "@ccgui/plugin-sdk";
import { ModelEntry } from "./model-entry";

vi.mock("../runtime/loader", () => ({ notePluginRenderOk: vi.fn(), reportPluginCrash: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const props: ModelEntryProps = { context: { target: { engineId: "claude", workspacePath: "/work", sessionId: "a", executionTarget: { kind: "local" } }, selection: null },
  choices: [], engines: [{ engineId: "claude", label: "Claude Code", available: true, disabled: false }], loading: false,
  onApply: vi.fn(), onSelectEngine: vi.fn(), onRefresh: vi.fn() };
let root: Root;
let container: HTMLDivElement;
let dispose: Disposer | undefined;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => { root.unmount(); dispose?.(); }); container.remove(); dispose = undefined; vi.restoreAllMocks(); });
const render = () => act(() => root.render(<ModelEntry {...props} fallback={<button>Original CLI menu</button>} />));
describe("model entry replacement", () => {
  it("renders one selector and restores the original when the plugin unloads", () => {
    dispose = modelEntryRegistry.register({ id: "plugin:selector:entry", engineIds: ["claude"], component: () => <button>Provider selector</button> });
    render();
    expect(container.textContent).toBe("Provider selector");
    act(() => dispose?.());
    expect(container.textContent).toBe("Original CLI menu");
  });
  it("keeps the original menu for engines outside the registration", () => {
    dispose = modelEntryRegistry.register({ id: "plugin:selector:entry", engineIds: ["codex"], component: () => <button>Provider selector</button> });
    render();
    expect(container.textContent).toBe("Original CLI menu");
  });
  it("falls back to the original menu after a plugin render crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dispose = modelEntryRegistry.register({ id: "plugin:selector:entry", engineIds: ["claude"], component: () => { throw new Error("broken selector"); } });
    render();
    expect(container.textContent).toBe("Original CLI menu");
  });
});
