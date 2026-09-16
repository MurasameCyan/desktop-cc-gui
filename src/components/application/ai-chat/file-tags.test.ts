import { describe, expect, it } from "vitest";
import { FILE_TAG_CLASS, mentionToken, renderFileTags } from "./file-tags";

describe("mentionToken", () => {
  it("normalizes Windows paths to the /-rooted mention form", () => {
    expect(mentionToken("S:\\AIWorker\\desktop-cc-gui/tests")).toBe(
      "@/S:/AIWorker/desktop-cc-gui/tests",
    );
    expect(mentionToken("C:\\Users\\Me\\My Docs\\proj")).toBe(
      '@"/C:/Users/Me/My Docs/proj"',
    );
  });

  it("leaves canonical absolute paths untouched", () => {
    expect(mentionToken("/Users/me/proj")).toBe("@/Users/me/proj");
    expect(mentionToken("//wsl$/Ubuntu/home/u/proj")).toBe("@//wsl$/Ubuntu/home/u/proj");
  });
});

describe("renderFileTags", () => {
  it("renders a Windows-path mention as a chip", () => {
    // Regression: `@S:\…\path` used to skip the mention grammar entirely, so
    // tree-inserted mentions stayed plain text — no chip, no round-trip.
    const el = document.createElement("div");
    el.textContent = `${mentionToken("S:\\AIWorker\\desktop-cc-gui/tests")} `;
    renderFileTags(el);
    const chip = el.querySelector(`.${FILE_TAG_CLASS}`);
    expect(chip).not.toBeNull();
    // The chip carries the canonical mention path (what gets sent), not the
    // native separator spelling.
    expect(chip?.getAttribute("data-file-path")).toBe(
      "/S:/AIWorker/desktop-cc-gui/tests",
    );
  });
});
