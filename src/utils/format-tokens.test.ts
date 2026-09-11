import { describe, expect, it } from "vitest";
import { formatTokens } from "./format-tokens";

describe("formatTokens", () => {
  it("carries into the next unit instead of overflowing the last one", () => {
    // The bug this pins: the usage page capped at "M", so this machine's real
    // ledger (1_111_253_443 tokens) read "1111.3M".
    expect(formatTokens(1_111_253_443)).toBe("1.1B");
    expect(formatTokens(1_000_000_000)).toBe("1B");
    // Rounding must not print a value that belongs to the unit above.
    expect(formatTokens(999_999_999)).toBe("1B");
    expect(formatTokens(999_999)).toBe("1M");
  });

  it("keeps small counts exact and drops trailing zeros", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(314)).toBe("314");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(482_800)).toBe("482.8k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});
