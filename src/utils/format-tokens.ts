/**
 * Compact token counts for a dense row of numbers: 314 → "314",
 * 96_000 → "96k", 482_800 → "482.8k", 1_000_000 → "1M", 1_111_253_443 → "1.1B".
 *
 * Shared by the usage page and the agent-limits card, which used to each carry
 * their own copy — one of them capped at "M", so a ledger past a billion tokens
 * read "1111.3M", a number wearing the wrong unit.
 */

const UNITS = [
  { scale: 1, suffix: "" },
  { scale: 1_000, suffix: "k" },
  { scale: 1_000_000, suffix: "M" },
  { scale: 1_000_000_000, suffix: "B" },
];

/** One decimal rounds 999.95 up to "1000.0", which is the next unit's job. */
const CARRY_AT = 999.95;

export function formatTokens(n: number): string {
  let unit = 0;
  while (unit + 1 < UNITS.length && n >= UNITS[unit + 1].scale) unit++;
  let value = n / UNITS[unit].scale;
  if (value >= CARRY_AT && unit + 1 < UNITS.length) {
    unit++;
    value = n / UNITS[unit].scale;
  }
  const { suffix } = UNITS[unit];
  if (!suffix) return String(n);
  // Round first, then decide: 999_999 carries to 0.999999B-style values that
  // are integral only after rounding, and "1.0M" is not how the other rows read.
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}${suffix}`;
}
