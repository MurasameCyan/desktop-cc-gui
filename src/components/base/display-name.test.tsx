import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DisplayName, splitTrailingAcronym } from "./display-name";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render(name: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<DisplayName name={name} />);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("DisplayName", () => {
  it("renders the trailing acronym smaller while keeping the full text", async () => {
    const { container, cleanup } = await render("Client Context Bridge (CCB)");
    expect(container.textContent).toBe("Client Context Bridge (CCB)");
    const small = container.querySelector("span");
    expect(small?.textContent).toBe("(CCB)");
    expect(small?.className).toContain("text-[0.82em]");
    await cleanup();
  });

  it("leaves ordinary parenthesized labels alone", async () => {
    const { container, cleanup } = await render("~/.codex (default)");
    expect(container.textContent).toBe("~/.codex (default)");
    expect(container.querySelector("span")).toBeNull();
    await cleanup();
  });

  it("splits only a trailing all-caps acronym", () => {
    expect(splitTrailingAcronym("Client Context Bridge (CCB)")).toEqual({
      base: "Client Context Bridge",
      acronym: "CCB",
    });
    expect(splitTrailingAcronym("Qoder CLI CN")).toEqual({
      base: "Qoder CLI CN",
      acronym: null,
    });
    expect(splitTrailingAcronym("~/.codex (default)")).toEqual({
      base: "~/.codex (default)",
      acronym: null,
    });
    expect(splitTrailingAcronym("Foo (BAR) baz")).toEqual({
      base: "Foo (BAR) baz",
      acronym: null,
    });
  });
});
