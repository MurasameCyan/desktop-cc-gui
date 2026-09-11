import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Markdown from "./Markdown";
import { markdownRegistry } from "@ccgui/plugin-sdk";
import type { Disposer } from "@ccgui/plugin-sdk";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

/** Two-line fence so the host `pre` override renders the full CodeBlock card
 *  (single-line fences take the compact path). */
const FENCE = "```ts\nconst a = 1;\nconst b = 2;\n```";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderMarkdown(text: string) {
  await act(async () => {
    root.render(<Markdown text={text} workspacePath="/ws" />);
  });
}

describe("Markdown markdownRegistry merge (plan §4.2 #5)", () => {
  it("renders host defaults with no registrations (gfm + CodeBlock card)", async () => {
    await renderMarkdown(`~~gone~~\n\n${FENCE}`);
    // remark-gfm still active: strikethrough is a <del>.
    expect(container.querySelector("del")?.textContent).toBe("gone");
    // Host `pre` override still renders the code-block card.
    expect(container.querySelector(".md-codeblock")).not.toBeNull();
  });

  it("applies a registered plugin's component override", async () => {
    const dispose = markdownRegistry.register({
      id: "plugin:test:md",
      components: {
        code: ({ children }) => <code data-testid="plugin-code">{children}</code>,
      },
    });
    try {
      await renderMarkdown(FENCE);
      expect(container.querySelector("[data-testid='plugin-code']")).not.toBeNull();
    } finally {
      await act(async () => dispose());
    }
  });

  it("registry changes apply live to a mounted render and dispose reverts them", async () => {
    await renderMarkdown(FENCE);
    expect(container.querySelector("[data-testid='plugin-code']")).toBeNull();
    expect(container.querySelector(".md-codeblock")).not.toBeNull();

    let dispose: Disposer = () => {};
    await act(async () => {
      dispose = markdownRegistry.register({
        id: "plugin:test:md",
        components: {
          code: ({ children }) => <code data-testid="plugin-code">{children}</code>,
        },
      });
    });
    expect(container.querySelector("[data-testid='plugin-code']")).not.toBeNull();

    await act(async () => {
      dispose();
    });
    expect(container.querySelector("[data-testid='plugin-code']")).toBeNull();
    expect(container.querySelector(".md-codeblock")).not.toBeNull();
  });
});

describe("math rendering", () => {
  it("typesets inline math instead of leaving the source literal", async () => {
    await renderMarkdown("能量守恒 $E = mc^2$ 收尾");
    expect(container.querySelector(".katex")).not.toBeNull();
    // The raw TeX must not survive as visible text next to the typeset math.
    expect(container.textContent).not.toContain("$E = mc^2$");
  });

  it("typesets display math as a centered block", async () => {
    await renderMarkdown("推导：\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n结束");
    expect(container.querySelector(".katex-display")).not.toBeNull();
    // The raw markup is gone: what remains is typeset, not source. (KaTeX
    // keeps the TeX inside its MathML annotation for assistive tech, which
    // is why the check looks for the delimiters and not for "\frac".)
    expect(container.textContent).not.toContain("$$");
  });

  it("promotes a formula that owns its line to a display block", async () => {
    // Models write this single-line form constantly; the parser alone would
    // render it inline and wedge the formula into the paragraph flow.
    await renderMarkdown("推导：\n\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$\n\n结束");
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("keeps math inline when it sits inside a sentence", async () => {
    await renderMarkdown("由 $a^2 + b^2 = c^2$ 可得结论");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-display")).toBeNull();
  });

  it("renders a box command with nested math-mode dollars as one formula", async () => {
    await renderMarkdown(
      "颜色测试：$\\nabla_\\theta \\mathcal{L} 与 \\colorbox{yellow}{$\\displaystyle \\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$}$",
    );
    // One formula — the inner `$...$` must not split it into an error span
    // plus a raw-TeX text leak.
    expect(container.querySelectorAll(".katex").length).toBe(1);
    expect(container.querySelector(".katex-error")).toBeNull();
    const outside = [...container.querySelectorAll("*")]
      .filter((el) => !el.closest(".katex") && el.children.length === 0)
      .map((el) => el.textContent ?? "")
      .join("");
    expect(outside).not.toContain("\\int");
    expect(outside).not.toContain("\\colorbox");
  });

  it("renders nested box math in a display formula", async () => {
    await renderMarkdown(
      "$$\n\\hat{p} = \\mathrm{softmax}(Wh + b) \\quad \\colorbox{yellow}{$x^2$}\n$$",
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("leaves dollar signs inside code blocks alone", async () => {
    await renderMarkdown("```sh\necho $HOME\n```");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$HOME");
  });

  it("preserves KaTeX's inline positioning styles through the span override", async () => {
    // KaTeX lifts superscripts and stacks fractions with inline styles
    // (`style="top:-3.06em"`, strut heights). The host span override once
    // dropped every prop except className, collapsing the whole formula
    // onto the baseline with overlapping glyphs.
    await renderMarkdown("平方 $a^2 + \\frac{1}{\\ln x}$ 完");
    const styled = container.querySelectorAll<HTMLElement>(".katex span[style]");
    expect(styled.length).toBeGreaterThan(0);
    const tops = [...styled].map((el) => el.style.top).filter(Boolean);
    expect(tops.length).toBeGreaterThan(0);
  });

  it("keeps the formula whole while the row is streaming", async () => {
    // Reveal spans render text as a moving prefix; a formula must never be
    // truncated by that (the reveal-plan unit test guards the mechanism).
    await act(async () => {
      root.render(<Markdown text={"$a+b$ 以及 $c$"} workspacePath="/ws" streaming />);
    });
    const katex = container.querySelector(".katex");
    expect(katex).not.toBeNull();
    expect(katex?.textContent ?? "").toContain("a");
    expect(katex?.textContent ?? "").toContain("+");
  });
});
