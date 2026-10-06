import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { zh } from "@/i18n/zh";
import { COMPACT_COMMAND_TEXT, isInternalUserRow } from "./internal-rows";

describe("isInternalUserRow", () => {
  it("hides the host's compaction command", () => {
    expect(isInternalUserRow({ role: "user", text: COMPACT_COMMAND_TEXT })).toBe(true);
    expect(isInternalUserRow({ role: "user", text: " /compact " })).toBe(true);
  });

  it("hides the resume nudge in every shipped locale", () => {
    expect(isInternalUserRow({ role: "user", text: zh.chat.autoCompactResume })).toBe(true);
    expect(isInternalUserRow({ role: "user", text: en.chat.autoCompactResume })).toBe(true);
  });

  // The nudge goes through the ordinary send path, which appends extra text
  // (a frozen agent block) when one is selected — the row text carries it too.
  it("still hides a nudge that carries appended text", () => {
    expect(
      isInternalUserRow({
        role: "user",
        text: `${zh.chat.autoCompactResume}\n\n你是评审工程师。`,
      }),
    ).toBe(true);
  });

  it("keeps ordinary user text and non-user rows", () => {
    expect(isInternalUserRow({ role: "user", text: "/compact 之后再继续" })).toBe(false);
    expect(isInternalUserRow({ role: "user", text: "帮我压一下上下文" })).toBe(false);
    expect(isInternalUserRow({ role: "assistant", text: zh.chat.autoCompactResume })).toBe(false);
    expect(isInternalUserRow({ role: "tool", text: COMPACT_COMMAND_TEXT })).toBe(false);
  });
});
