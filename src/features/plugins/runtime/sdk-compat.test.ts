import { describe, expect, it } from "vitest";
import { isLegacySdkRange } from "./sdk-compat";

describe("isLegacySdkRange", () => {
  it("treats an older 0.x minor range as loadable for a 0.x host", () => {
    expect(isLegacySdkRange("^0.3", "0.4.3")).toBe(true);
    expect(isLegacySdkRange("^0.3.11", "0.4.3")).toBe(true);
    expect(isLegacySdkRange("~0.2", "0.4.3")).toBe(true);
  });

  it("leaves newer or same-minor declarations to the strict handshake", () => {
    // Same minor is satisfied strictly — the compat path must not be the
    // reason it loads.
    expect(isLegacySdkRange("^0.4", "0.4.3")).toBe(false);
    // A plugin asking for the future stays incompatible.
    expect(isLegacySdkRange("^0.5", "0.4.3")).toBe(false);
  });

  it("never widens non-caret declarations or non-0 majors", () => {
    expect(isLegacySdkRange("0.3.11", "0.4.3")).toBe(false);
    expect(isLegacySdkRange(">=0.3", "0.4.3")).toBe(false);
    expect(isLegacySdkRange("*", "0.4.3")).toBe(false);
    expect(isLegacySdkRange(undefined, "0.4.3")).toBe(false);
    expect(isLegacySdkRange("^0.3", "1.2.0")).toBe(false);
    expect(isLegacySdkRange("^1.0", "2.0.0")).toBe(false);
  });
});
