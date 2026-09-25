import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatStore, sessionKey } from "../store";
import { EMPTY_SESSION } from "../store/stream";
import { useTabModelDisplay } from "./use-tab-model-display";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const SID = "s-1";
const KEY = sessionKey("omp", SID, WS);
const ENGINE_DEFAULT = { omp: "medium" as const };

/** Reads the picker's inputs straight off the store, the way the composer does. */
function Probe() {
  const active = useChatStore((s) => s.active);
  const activeEngine = useChatStore((s) => s.activeEngine);
  const key = active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : "";
  const { displayEfforts } = useTabModelDisplay({
    active,
    activeEngine,
    sessionKey: key,
    models: {},
    efforts: ENGINE_DEFAULT,
    providers: {},
  });
  return (
    <span data-testid="effort">{displayEfforts[activeEngine] ?? ""}</span>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function shownEffort() {
  return container.querySelector("[data-testid='effort']")?.textContent ?? "";
}

describe("the picker follows the session, not a stale tab field", () => {
  it("shows the session's own level when the tab still carries an older one", async () => {
    const tab = { engine: "omp", sessionId: SID, workspacePath: WS, effort: "max" as const };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [tab],
      active: tab,
      efforts: ENGINE_DEFAULT,
      bySession: { [KEY]: { ...EMPTY_SESSION, activeEffort: "max", executionSelection: { version: 4, modelSelection: { source: "native", engineId: "omp", modelId: "model-a" }, effort: "low" } } },
    });

    await act(async () => root.render(<Probe />));

    // The persisted tab field used to win forever, so a level changed in
    // another window never reached this picker.
    expect(shownEffort()).toBe("low");
  });

  it("honours a pending conversation's backend record", async () => {
    const tab = { engine: "omp", sessionId: null, workspacePath: WS, effort: "high" as const };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [tab],
      active: tab,
      efforts: ENGINE_DEFAULT,
      bySession: { [sessionKey("omp", null, WS)]: { ...EMPTY_SESSION, executionSelection: { version: 1, modelSelection: { source: "native", engineId: "omp", modelId: "model-b" }, effort: "high" } } },
    });

    await act(async () => root.render(<Probe />));

    expect(shownEffort()).toBe("high");
  });

  it("does not pretend an unconfirmed session uses the foreground default", async () => {
    const tab = { engine: "omp", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [tab],
      active: tab,
      efforts: ENGINE_DEFAULT,
      bySession: { [KEY]: { ...EMPTY_SESSION } },
    });

    await act(async () => root.render(<Probe />));

    expect(shownEffort()).toBe("");
  });
});
