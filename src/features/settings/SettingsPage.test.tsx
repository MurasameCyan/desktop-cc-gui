import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineInfo } from "@/lib/ipc";

// The settings page never probes IPC for the rail itself (engine states come
// from the chat store); a rejecting-any-method proxy keeps section module
// imports and the stub page inert.
vi.mock("@/lib/ipc", () => ({
  ipc: new Proxy({}, { get: () => async () => null }),
}));

import { settingsRegistry } from "@ccgui/plugin-sdk";
import i18n from "@/lib/i18n";
import { useChatStore } from "@/features/chat/store";
import SettingsPage from "./SettingsPage";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Landing page for every render: a registered stub keeps real section bodies
// (General/Usage/…) unmounted while the rail lists every registered section.
settingsRegistry.register({
  id: "stub",
  key: "stub",
  label: () => "Stub",
  group: "settings",
  order: 99,
  component: () => <div>stub page</div>,
});

const engine = (id: string, available: boolean, enabled: boolean): EngineInfo => ({
  id,
  available,
  enabled,
  supportsImages: false,
  permissions: [],
});

/** Row labels currently rendered in the nav rail (exact text, no substring
 *  collisions like "Qoder CLI" vs "Qoder CLI CN"). */
function navLabels(): string[] {
  const nav = document.querySelector("nav");
  if (!nav) throw new Error("nav rail not rendered");
  return [...nav.querySelectorAll("button, span")]
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatStore.setState({ engines: [] });
});

async function render(engines: EngineInfo[]) {
  useChatStore.setState({ engines });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/settings?page=stub"]}>
        <SettingsPage />
      </MemoryRouter>,
    );
  });
}

/** Click one collapsed bucket's toggle by its label. */
async function expandBucket(labelKey: string) {
  const toggle = [
    ...document.querySelectorAll<HTMLButtonElement>("nav button"),
  ].find((b) => b.textContent?.trim() === i18n.t(labelKey));
  if (!toggle) throw new Error(`bucket toggle not rendered: ${labelKey}`);
  await act(async () => {
    toggle.click();
  });
}

describe("SettingsPage CLI rail", () => {
  it("buckets uninstalled CLIs under 未安装, disabled ones under 未启用", async () => {
    await render([
      engine("claude", true, true),
      engine("codex", true, false),
      engine("qoder", false, true),
      engine("agy", false, false),
    ]);

    // Main rail: only the installed+enabled CLI; both buckets start collapsed.
    let labels = navLabels();
    expect(labels).toContain("Claude Code");
    expect(labels).not.toContain("Codex CLI");
    expect(labels).not.toContain("Qoder CLI");
    expect(labels).not.toContain("Antigravity CLI");

    // 未启用 holds the installed disabled CLI — and nothing uninstalled.
    await expandBucket("settings.cliDisabledGroup");
    labels = navLabels();
    expect(labels).toContain("Codex CLI");
    expect(labels).not.toContain("Qoder CLI");
    expect(labels).not.toContain("Antigravity CLI");

    // 未安装 holds the uninstalled CLIs regardless of their enable flag.
    await expandBucket("settings.cliNotInstalledGroup");
    labels = navLabels();
    expect(labels).toContain("Qoder CLI");
    expect(labels).toContain("Antigravity CLI");
  });

  it("keeps every CLI while the engine probe is out (empty list = unknown)", async () => {
    await render([]);

    const labels = navLabels();
    expect(labels).toContain("Claude Code");
    expect(labels).toContain("Qoder CLI");
    expect(labels).toContain("Antigravity CLI");
  });
});
