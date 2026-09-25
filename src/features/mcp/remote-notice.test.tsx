import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ipc.ts subscribes to settings://changed at module scope; the stub keeps
// that subscription inert (the real transport needs Tauri internals).
vi.mock("@/lib/transport", () => ({
  isWeb: true,
  listen: async () => () => {},
}));

import "@/lib/i18n";
import { SkillsSection } from "@/features/skills/SkillsSection";
import { McpSection } from "./McpSection";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("remote web access", () => {
  it("shows a local-management notice instead of management UI for Skills and MCP", async () => {
    await act(async () => {
      root.render(
        <div>
          <SkillsSection />
          <McpSection />
        </div>,
      );
    });
    expect(document.body.textContent).toContain("仅桌面端可用");
    // No management affordances leak into a remote browser.
    expect(document.body.textContent).not.toContain("导入本地技能");
    expect(document.body.textContent).not.toContain("配置清单");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });
});
