import { describe, expect, it } from "vitest";
import { mergeUsage, parseUsage } from "./usage";

describe("parseUsage", () => {
  it("reads a codex rollout usage record, cache keys included", () => {
    // The session-log tail emits token_usage_record payloads: a flat usage
    // with codex's own cache field names and the stamped context window.
    const parsed = parseUsage({
      input_tokens: 5000,
      cached_input_tokens: 1000,
      cache_write_input_tokens: 2000,
      output_tokens: 300,
      total_tokens: 8300,
      model_context_window: 258_400,
    });
    expect(parsed).toMatchObject({
      input: 5000,
      output: 300,
      cacheRead: 1000,
      cacheWrite: 2000,
      total: 8300,
      contextWindow: 258_400,
    });
  });

  it("reads a flattened last-turn snapshot with the window copied on", () => {
    const parsed = parseUsage({
      input_tokens: 34_660,
      output_tokens: 85,
      total_tokens: 34_745,
      model_context_window: 475_000,
    });
    expect(parsed?.contextWindow).toBe(475_000);
    expect(parsed?.total).toBe(34_745);
  });
});

describe("mergeUsage", () => {
  it("keeps a previously reported context window", () => {
    const merged = mergeUsage(
      { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      { input_tokens: 8, output_tokens: 1, total_tokens: 9, model_context_window: 475_000 },
    );
    expect(merged).toMatchObject({
      input_tokens: 10,
      total_tokens: 12,
      model_context_window: 475_000,
    });
  });
});
