import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_UI_TOKEN_CONTRACT } from "@ccgui/plugin-ui/tokens";

/**
 * 宿主 → @ccgui/plugin-ui 的 token 兼容承诺（packages/plugin-ui/src/tokens.ts
 * 头部注释）：清单内的 CSS 自定义属性不得在 theme.css 中重命名或删除——
 * 每个用了 plugin-ui 的插件样式都 var() 引用它们，改名会静默破坏所有
 * 插件 UI。此测试逐条断言定义仍在；扩约走 tokens.ts 加条目。
 */
const themeCss = readFileSync(
  path.resolve(__dirname, "../../styles/theme.css"),
  "utf8",
);

describe("plugin-ui token contract", () => {
  it("theme.css defines every contracted token", () => {
    const missing = PLUGIN_UI_TOKEN_CONTRACT.filter(
      (token) => !new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(themeCss),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the .dark override block (components carry no dark branches)", () => {
    expect(themeCss).toMatch(/\.dark\s*\{/);
  });

  it("contract has no duplicate entries", () => {
    expect(new Set(PLUGIN_UI_TOKEN_CONTRACT).size).toBe(PLUGIN_UI_TOKEN_CONTRACT.length);
  });
});
