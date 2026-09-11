import { describe, expect, it } from "vitest";
import { mergeUsage, parseUsage } from "./usage";

describe("parseUsage", () => {
  it("folds a codex record's cache counters out of its input", () => {
    // The session-log tail emits token_usage_record payloads: a flat usage
    // with codex's own cache field names and the stamped context window.
    // Codex bills `input_tokens` as the whole prompt and reports
    // `total_tokens` = input + output, so the cache counters are already
    // inside input and must not be added again.
    const parsed = parseUsage({
      input_tokens: 8000,
      cached_input_tokens: 6000,
      cache_write_input_tokens: 1500,
      output_tokens: 300,
      total_tokens: 8300,
      model_context_window: 258_400,
    });
    expect(parsed).toMatchObject({
      input: 500,
      output: 300,
      cacheRead: 6000,
      cacheWrite: 1500,
      total: 8300,
      contextWindow: 258_400,
    });
    expect(
      parsed!.input + parsed!.output + parsed!.cacheRead + parsed!.cacheWrite,
    ).toBe(parsed!.total);
  });

  it("keeps claude's cache tokens outside its input", () => {
    // Claude reports fresh input separately from the cache it read and wrote,
    // so there the cache volume is missing input rather than a subset of it.
    const parsed = parseUsage({
      input_tokens: 400,
      cache_read_input_tokens: 6000,
      cache_creation_input_tokens: 1500,
      output_tokens: 300,
    });
    expect(parsed).toMatchObject({
      input: 400,
      output: 300,
      cacheRead: 6000,
      cacheWrite: 1500,
      total: 8200,
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
