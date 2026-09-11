import { describe, expect, it } from "vitest";
import {
  NESTED_DOLLAR,
  protectNestedMathDollars,
  restoreNestedMathDollars,
} from "./math-dollars";

describe("protectNestedMathDollars", () => {
  it("hides boxed math-mode dollars from remark-math and restores them", () => {
    const src =
      "颜色测试：$\\nabla_\\theta \\mathcal{L} 与 \\colorbox{yellow}{$\\displaystyle \\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$}$";
    const out = protectNestedMathDollars(src);
    // Only the outer delimiter pair survives as `$`; the inner pair is hidden.
    expect(out.split("$").length).toBe(3);
    expect(out).toContain(NESTED_DOLLAR);
    expect(restoreNestedMathDollars(out)).toBe(src);
  });

  it("hides nested dollars in display math too", () => {
    const src = "$$\\hat{p} = \\mathrm{softmax}(Wh + b) \\quad \\colorbox{green}{$x^2$}$$";
    const out = protectNestedMathDollars(src);
    expect(out.split("$$").length).toBe(3);
    expect(out).toContain(NESTED_DOLLAR);
    expect(restoreNestedMathDollars(out)).toBe(src);
  });

  it("leaves plain math without nesting untouched", () => {
    const src = "能量守恒 $E = mc^2$ 收尾";
    expect(protectNestedMathDollars(src)).toBe(src);
  });

  it("leaves dollars in fenced code blocks alone", () => {
    const src = "```sh\necho $HOME\n```";
    expect(protectNestedMathDollars(src)).toBe(src);
  });

  it("leaves dollars in inline code spans alone", () => {
    const src = "run `echo $HOME` now";
    expect(protectNestedMathDollars(src)).toBe(src);
  });

  it("keeps an escaped dollar inside math", () => {
    const src = "$\\$5 + x = 6$";
    expect(protectNestedMathDollars(src)).toBe(src);
  });

  it("pairs unboxed dollars simply like remark-math", () => {
    const src = "价格 $5 和 $10 元";
    expect(protectNestedMathDollars(src)).toBe(src);
  });

  it("returns fast for text without dollars", () => {
    expect(protectNestedMathDollars("没有美元符号")).toBe("没有美元符号");
  });
});
