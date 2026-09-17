import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileLinkContextMenu } from "./FileLinkContextMenu";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let clipboard = "";

beforeEach(() => {
  clipboard = "";
  vi.stubGlobal("navigator", {
    platform: "Win32",
    clipboard: { writeText: async (text: string) => { clipboard = text; } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("copies the original link when its path cannot be resolved", async () => {
  await act(async () => {
    root.render(<FileLinkContextMenu menu={{ x: 20, y: 20, path: "~/notes.txt", resolvedPath: null, workspacePath: "S:/work" }} onClose={() => {}} />);
  });
  const copy = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")]
    .find((element) => element.textContent?.includes("files.copyLink"));
  expect(copy).toBeDefined();
  await act(async () => copy!.click());
  expect(clipboard).toBe("~/notes.txt");
});
