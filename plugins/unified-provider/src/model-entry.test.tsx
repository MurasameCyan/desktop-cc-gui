import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExecutionChoice, ModelEntryProps, SessionExecutionContext } from "@ccgui/plugin-sdk";
import { ModelEntry } from "./model-entry";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const choice: ExecutionChoice = {
  choiceId: "native-model", label: "Native model", group: "Native",
  modelSelection: { source: "native", engineId: "codex", modelId: "model" },
  credentials: [], tokenPolicy: {},
  capabilities: { images: "unknown", tools: "unknown", effortLevels: ["low", "medium", "high"] },
};
const initial: SessionExecutionContext = {
  target: { engineId: "codex", workspacePath: "/preview", sessionId: "session", executionTarget: { kind: "local" } },
  selection: { modelSelection: choice.modelSelection, effort: null, version: 1 },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("applies the displayed effort when an existing selection has no effort", async () => {
  function Session() {
    const [context, setContext] = useState(initial);
    const onApply: ModelEntryProps["onApply"] = async (input, expectedVersion) => {
      if (expectedVersion !== context.selection?.version) throw new Error("stale selection");
      const next = { ...context, selection: { ...input, version: expectedVersion + 1 } };
      setContext(next);
      return next;
    };
    return <ModelEntry context={context} choices={[choice]} engines={[{ engineId: "codex", label: "Codex", available: true, disabled: true }]} loading={false} onApply={onApply} onSelectEngine={async () => {}} onRefresh={async () => {}} />;
  }
  act(() => root.render(<Session />));
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  act(() => trigger.click());
  const shownEffort = container.querySelector('input[type="range"]')!.getAttribute("aria-valuetext")!;
  const apply = [...container.querySelectorAll("button")].find((button) => button.textContent === "应用完整选择")!;
  await act(async () => apply.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toContain(shownEffort);
});
