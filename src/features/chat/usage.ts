export interface ParsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Engine-reported window (Codex `model_context_window`). */
  contextWindow?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(u: Record<string, unknown>, k: string): number {
  return typeof u[k] === "number" ? (u[k] as number) : 0;
}

function reportedWindow(...sources: Array<Record<string, unknown> | null>): number | undefined {
  for (const source of sources) {
    const n = source ? num(source, "model_context_window") : 0;
    if (n > 0) return n;
  }
  return undefined;
}

/** Normalize the per-engine usage shapes (snake_case for claude/codex, bare
 * keys for pi/omp) into one token breakdown. Returns null when no tokens
 * were reported at all. */
export function parseUsage(usage: unknown): ParsedUsage | null {
  const raw = asRecord(usage);
  if (!raw) return null;
  // Codex token_count info: occupancy is last_token_usage; the sibling
  // total_token_usage is session-billed cumulative and must not fill the bar.
  const nested = asRecord(raw.last_token_usage);
  const u = nested ?? raw;
  const input = num(u, "input_tokens") || num(u, "input");
  const output = num(u, "output_tokens") || num(u, "output");
  // Codex names its cache fields differently (cached_input_tokens /
  // cache_write_input_tokens): without them a codex report's cache hits land
  // in the ledger as zero.
  const cacheRead =
    num(u, "cache_read_input_tokens") || num(u, "cacheRead") || num(u, "cached_input_tokens");
  const cacheWrite =
    num(u, "cache_creation_input_tokens") ||
    num(u, "cacheWrite") ||
    num(u, "cache_write_input_tokens");
  const total =
    num(u, "total_tokens") || num(u, "totalTokens") || input + output + cacheRead + cacheWrite;
  if (!total) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    contextWindow: reportedWindow(raw, u),
  };
}

/** Keep a previously reported context window when a later snapshot omits it. */
export function mergeUsage(next: unknown, prev: unknown): unknown {
  if (!next) return prev ?? null;
  const nextObj = asRecord(next);
  const prevObj = asRecord(prev);
  if (!nextObj || !prevObj) return next;
  if (num(nextObj, "model_context_window") > 0) return next;
  const window = reportedWindow(prevObj, asRecord(prevObj.last_token_usage));
  if (!window) return next;
  return { ...nextObj, model_context_window: window };
}
