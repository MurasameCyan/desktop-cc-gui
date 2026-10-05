import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_STORAGE_KEY,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  getAutoCompactSettings,
  migrateAutoCompactSettings,
  normalizeAutoCompactThreshold,
  setAutoCompactEnabled,
  setAutoCompactThreshold,
  shouldAutoCompact,
} from "./auto-compact-context";

const SESSION_A = "omp/session-a/workspace-a";
const SESSION_B = "claude/session-b/workspace-b";

describe("auto compact context settings", () => {
  beforeEach(() => {
    localStorage.clear();
    setAutoCompactEnabled(SESSION_A, false);
    setAutoCompactThreshold(SESSION_A, DEFAULT_AUTO_COMPACT_THRESHOLD);
  });

  it.each([
    [0, 1],
    [101, 100],
    ["42", 42],
    ["", DEFAULT_AUTO_COMPACT_THRESHOLD],
    ["not-a-number", DEFAULT_AUTO_COMPACT_THRESHOLD],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeAutoCompactThreshold(value)).toBe(expected);
  });

  it("persists settings per session without leaking between sessions", () => {
    setAutoCompactEnabled(SESSION_A, true);
    setAutoCompactThreshold(SESSION_A, 72);

    expect(getAutoCompactSettings(SESSION_A)).toEqual({ enabled: true, threshold: 72 });
    expect(getAutoCompactSettings(SESSION_B)).toEqual({
      enabled: false,
      threshold: DEFAULT_AUTO_COMPACT_THRESHOLD,
    });
    expect(JSON.parse(localStorage.getItem(AUTO_COMPACT_STORAGE_KEY) ?? "{}")[SESSION_A]).toEqual({
      enabled: true,
      threshold: 72,
    });
  });
  it("does not persist an empty session key", () => {
    localStorage.clear();
    setAutoCompactEnabled("", true);
    setAutoCompactThreshold("", 55);
    expect(localStorage.getItem(AUTO_COMPACT_STORAGE_KEY)).toBeNull();
  });

  it("carries a pending tab's settings onto the native session it adopts", () => {
    localStorage.clear();
    const pending = "new:omp:S:/ws";
    const native = "omp/sess-1";
    setAutoCompactThreshold(pending, 5);
    setAutoCompactEnabled(pending, true);

    migrateAutoCompactSettings(pending, native);

    expect(getAutoCompactSettings(native)).toEqual({ enabled: true, threshold: 5 });
    const stored = JSON.parse(localStorage.getItem(AUTO_COMPACT_STORAGE_KEY) ?? "{}");
    expect(stored[pending]).toBeUndefined();
  });

  it("keeps settings the native session already has", () => {
    localStorage.clear();
    const pending = "new:omp:S:/ws";
    const native = "omp/sess-2";
    setAutoCompactThreshold(pending, 5);
    setAutoCompactEnabled(native, true);
    setAutoCompactThreshold(native, 60);

    migrateAutoCompactSettings(pending, native);

    expect(getAutoCompactSettings(native)).toEqual({ enabled: true, threshold: 60 });
    expect(
      JSON.parse(localStorage.getItem(AUTO_COMPACT_STORAGE_KEY) ?? "{}")[pending],
    ).toBeUndefined();
  });

  it("is a no-op without pending settings or with equal keys", () => {
    localStorage.clear();
    migrateAutoCompactSettings("new:omp:S:/ws", "omp/sess-3");
    expect(localStorage.getItem(AUTO_COMPACT_STORAGE_KEY)).toBeNull();
    setAutoCompactEnabled("omp/sess-3", true);
    migrateAutoCompactSettings("omp/sess-3", "omp/sess-3");
    expect(getAutoCompactSettings("omp/sess-3")).toEqual({ enabled: true, threshold: 80 });
  });
});

describe("shouldAutoCompact", () => {
  const base = {
    enabled: true,
    threshold: 80,
    usagePct: 80,
    streaming: false,
    compacting: false,
    latched: false,
  };

  it("triggers at the threshold", () => {
    expect(shouldAutoCompact(base)).toBe(true);
  });

  it("does not trigger below the threshold, while streaming, while compacting, or after latching", () => {
    expect(shouldAutoCompact({ ...base, usagePct: 79 })).toBe(false);
    expect(shouldAutoCompact({ ...base, streaming: true })).toBe(false);
    expect(shouldAutoCompact({ ...base, compacting: true })).toBe(false);
    expect(shouldAutoCompact({ ...base, latched: true })).toBe(false);
    expect(shouldAutoCompact({ ...base, enabled: false })).toBe(false);
  });
});
