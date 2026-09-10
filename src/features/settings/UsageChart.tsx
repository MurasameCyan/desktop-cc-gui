import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { inferModelEngine } from "@/components/foundations/icons/engine-brands";
import type { UsageRow } from "@/lib/ipc";

/**
 * Stacked token chart: one bar per local day, one segment per model, with a
 * hover breakdown. Hand-rolled SVG on purpose — the page ships no chart
 * dependency, and the shape needed here (stacked bars + tooltip + legend) is
 * smaller than the smallest library that could draw it.
 */

/** Series colors, assigned by descending total. Categorical palette that
 *  stays legible on the dark canvas and in light mode. */
const PALETTE = [
  "#34d399", // emerald
  "#fbbf24", // amber
  "#38bdf8", // sky
  "#a78bfa", // violet
  "#fb7185", // rose
  "#facc15", // yellow
  "#2dd4bf", // teal
  "#f97316", // orange
  "#94a3b8", // slate
];

const OTHER_COLOR = "#64748b";
const MAX_SERIES = PALETTE.length;

export interface UsageChartProps {
  rows: UsageRow[];
  /** Every local day in the selected range, oldest first. */
  days: string[];
  /** Scale cap in tokens; bars share it so days stay comparable. */
  formatTokens: (n: number) => string;
}

interface Series {
  model: string;
  color: string;
  byDay: number[];
  total: number;
}

const tokensOf = (row: UsageRow) => row.input + row.output + row.cacheRead + row.cacheWrite;

/** Readable axis step: 1/2/5 × 10^n covering `max` in ~4 ticks. */
function axisMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const candidate = magnitude * factor;
    if (candidate >= max) return candidate;
  }
  return magnitude * 10;
}

export function UsageChart({ rows, days, formatTokens }: UsageChartProps) {
  const { t } = useTranslation();
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  const { series, dayTotals, max } = useMemo(() => {
    const totalsByModel = new Map<string, number>();
    const perDay = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const model = row.model || t("usage.unknownModel");
      const tokens = tokensOf(row);
      totalsByModel.set(model, (totalsByModel.get(model) ?? 0) + tokens);
      const bucket = perDay.get(row.day) ?? new Map<string, number>();
      bucket.set(model, (bucket.get(model) ?? 0) + tokens);
      perDay.set(row.day, bucket);
    }
    const ranked = [...totalsByModel.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, MAX_SERIES);
    const rest = ranked.slice(MAX_SERIES);
    const built: Series[] = top.map(([model], index) => ({
      model,
      color: PALETTE[index],
      byDay: days.map((day) => perDay.get(day)?.get(model) ?? 0),
      total: totalsByModel.get(model) ?? 0,
    }));
    if (rest.length > 0) {
      const restNames = new Set(rest.map(([model]) => model));
      built.push({
        model: t("usage.otherModels"),
        color: OTHER_COLOR,
        byDay: days.map((day) => {
          const bucket = perDay.get(day);
          if (!bucket) return 0;
          let sum = 0;
          for (const [model, tokens] of bucket) {
            if (restNames.has(model)) sum += tokens;
          }
          return sum;
        }),
        total: rest.reduce((acc, [, tokens]) => acc + tokens, 0),
      });
    }
    const totals = days.map((_day, index) =>
      built.reduce((acc, s) => acc + (s.byDay[index] ?? 0), 0),
    );
    const peak = Math.max(...totals, 0);
    return { series: built, dayTotals: totals, max: axisMax(peak) };
  }, [rows, days, t]);

  // Fixed viewBox: the panel is a known width, and uniform scaling keeps the
  // label sizes honest instead of stretching text non-uniformly.
  const W = 620;
  const H = 220;
  const padLeft = 52;
  const padRight = 8;
  const padTop = 10;
  const padBottom = 26;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;
  const step = plotW / Math.max(days.length, 1);
  const barW = Math.max(2, Math.min(26, step * 0.62));
  const y = (tokens: number) => padTop + plotH - (tokens / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // Thin the date labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  const hoverIndex = hoverDay ? days.indexOf(hoverDay) : -1;
  const hoverTotal = hoverIndex >= 0 ? dayTotals[hoverIndex] : 0;

  return (
    <div className="relative flex w-full flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t("usage.chartLabel")}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padLeft}
              x2={W - padRight}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-separator-border)"
              strokeDasharray={tick === 0 ? undefined : "3 4"}
            />
            <text
              x={padLeft - 8}
              y={y(tick) + 3.5}
              textAnchor="end"
              className="fill-text-tertiary"
              style={{ fontSize: 10 }}
            >
              {formatTokens(tick)}
            </text>
          </g>
        ))}
        {days.map((day, dayIndex) => {
          const x = padLeft + dayIndex * step + (step - barW) / 2;
          let cursor = 0;
          return (
            <g key={day}>
              {/* Hit area spans the full column so hovering is forgiving. */}
              <rect
                x={padLeft + dayIndex * step}
                y={padTop}
                width={step}
                height={plotH}
                fill={hoverIndex === dayIndex ? "var(--color-background-primary-hover)" : "transparent"}
                onMouseEnter={() => setHoverDay(day)}
                onMouseLeave={() => setHoverDay((current) => (current === day ? null : current))}
              />
              {series.map((s) => {
                const tokens = s.byDay[dayIndex] ?? 0;
                if (tokens <= 0) return null;
                const height = (tokens / max) * plotH;
                const segmentY = padTop + plotH - cursor - height;
                cursor += height;
                return (
                  <rect
                    key={s.model}
                    x={x}
                    y={segmentY}
                    width={barW}
                    height={Math.max(height - 0.6, 0.6)}
                    fill={s.color}
                    pointerEvents="none"
                  />
                );
              })}
              {dayIndex % labelEvery === 0 && (
                <text
                  x={padLeft + dayIndex * step + step / 2}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-text-tertiary"
                  style={{ fontSize: 10 }}
                >
                  {day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hoverIndex >= 0 && (
        <div
          className="pointer-events-none absolute top-1 z-10 flex min-w-[150px] flex-col gap-1 rounded-lg border border-separator-border bg-background-primary-default p-2 shadow-dropdown"
          style={
            {
              // Clamp inside the panel: the tooltip flips side near the edges.
              left: `${Math.min(
                88,
                Math.max(0, ((hoverIndex + 0.5) / Math.max(days.length, 1)) * 100),
              )}%`,
            } as React.CSSProperties
          }
        >
          <span className="text-body-2-regular text-text-tertiary">{hoverDay}</span>
          <span className="flex items-baseline justify-between gap-3 text-body-2-medium text-text-primary">
            <span>{t("usage.tooltipTotal")}</span>
            <span className="tabular-nums">{formatTokens(hoverTotal)}</span>
          </span>
          {series
            .map((s) => ({ model: s.model, color: s.color, tokens: s.byDay[hoverIndex] ?? 0 }))
            .filter((entry) => entry.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens)
            .map((entry) => (
              <span
                key={entry.model}
                className="flex items-center justify-between gap-3 text-body-2-regular"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {inferModelEngine(entry.model) && (
                    <EngineIcon
                      engine={inferModelEngine(entry.model)!}
                      size={12}
                      className="shrink-0 text-foreground-icon-primary"
                    />
                  )}
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="truncate text-text-secondary">{entry.model}</span>
                </span>
                <span className="shrink-0 tabular-nums text-text-primary">
                  {formatTokens(entry.tokens)}
                </span>
              </span>
            ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {series.map((s) => (
          <span key={s.model} className="flex min-w-0 items-center gap-1.5 text-body-2-regular text-text-secondary">
            {/* Brand mark (which family the model belongs to) next to the
                series swatch (which band it owns in the chart). */}
            {inferModelEngine(s.model) && (
              <EngineIcon
                engine={inferModelEngine(s.model)!}
                size={14}
                className="shrink-0 text-foreground-icon-primary"
              />
            )}
            <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="max-w-[150px] truncate">{s.model}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
