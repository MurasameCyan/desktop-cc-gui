import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { EngineIcon, type EngineIconId } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { ModelBadge } from "@/components/foundations/icons/model-badge";
import { modelDisplayName } from "./usage-model";
import { tokensOf } from "./usage-totals";
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
/** Model shades inside a CLI row: distinguishable, but clearly a family. */
const MODEL_SHADES = ["#34d399", "#fbbf24", "#38bdf8", "#a78bfa", "#fb7185", "#facc15"];

export interface UsageChartProps {
  rows: UsageRow[];
  /** Every local day in the selected range, oldest first. */
  days: string[];
  /** Scale cap in tokens; bars share it so days stay comparable. */
  formatTokens: (n: number) => string;
}

interface Series {
  /** CLI display name (series key). */
  model: string;
  /** Engine id behind the CLI, for its brand mark. */
  engine: string;
  color: string;
  byDay: number[];
  total: number;
  /** Models inside this CLI, largest first — the tooltip's second level. */
  models: { name: string; color: string; byDay: number[]; total: number }[];
}

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

/** Tooltip breakdown for one hovered day: one pass over the series (and one
 *  over each CLI's models), keeping non-zero entries in series order. */
function buildTooltipRows(
  series: Series[],
  dayIndex: number,
  formatTokens: (n: number) => string,
): ReactNode[] {
  const rows: ReactNode[] = [];
  for (const cli of series) {
    const tokens = cli.byDay[dayIndex] ?? 0;
    if (tokens <= 0) continue;
    const modelRows: ReactNode[] = [];
    for (const model of cli.models) {
      const modelTokens = model.byDay[dayIndex] ?? 0;
      if (modelTokens <= 0) continue;
      modelRows.push(
        <span
          key={model.name}
          className="flex items-center justify-between gap-3 pl-5 text-caption-1-regular"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <ModelBadge name={model.name} size={11} className="shrink-0" />
            <span className="truncate text-text-tertiary">{model.name}</span>
          </span>
          <span className="shrink-0 tabular-nums text-text-tertiary">
            {formatTokens(modelTokens)}
          </span>
        </span>,
      );
    }
    rows.push(
      <span key={cli.engine} className="flex flex-col gap-0.5">
        <span className="flex items-center justify-between gap-3 text-body-2-regular">
          <span className="flex min-w-0 items-center gap-1.5">
            <EngineIcon
              engine={cli.engine as EngineIconId}
              size={12}
              className="shrink-0 text-foreground-icon-primary"
            />
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: cli.color }}
            />
            <span className="truncate text-text-secondary">{cli.model}</span>
          </span>
          <span className="shrink-0 tabular-nums text-text-primary">
            {formatTokens(tokens)}
          </span>
        </span>
        {modelRows}
      </span>,
    );
  }
  return rows;
}

export function UsageChart({ rows, days, formatTokens }: UsageChartProps) {
  const { t } = useTranslation();
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  // The tooltip trails the pointer (clamped to the chart box) instead of
  // being pinned to the hovered column: pinning made it jump to the other
  // side near the edges and widened the settings pane into a scrollbar.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);

  const { series, dayTotals, max } = useMemo(() => {
    // Stack by CLI (the details card's top level), with each CLI's models kept
    // for the tooltip — the chart and 详细数据 then describe the same thing.
    const byCli = new Map<string, Map<string, number[]>>();
    for (const row of rows) {
      // Same fold as 详细数据: the chart and the details card must describe
      // one model per row, whatever slug the session ran.
      const name = modelDisplayName(row.model) || t("usage.unknownModel");
      const models = byCli.get(row.engine) ?? new Map<string, number[]>();
      const perDay = models.get(name) ?? new Array(days.length).fill(0);
      const index = days.indexOf(row.day);
      if (index >= 0) {
        perDay[index] += tokensOf(row);
      }
      models.set(name, perDay);
      byCli.set(row.engine, models);
    }
    const built: Series[] = [...byCli.entries()]
      .map(([engine, models]) => {
        const entries = [...models.entries()].map(([name, byDay]) => ({
          name,
          byDay,
          total: byDay.reduce((acc, n) => acc + n, 0),
          color: OTHER_COLOR,
        }));
        entries.sort((a, b) => b.total - a.total);
        return {
          model: CLI_DISPLAY_NAMES[engine] ?? engine,
          engine,
          color: OTHER_COLOR,
          byDay: days.map((_, index) => entries.reduce((acc, e) => acc + (e.byDay[index] ?? 0), 0)),
          total: entries.reduce((acc, e) => acc + e.total, 0),
          models: entries,
        };
      })
      .sort((a, b) => b.total - a.total);
    built.forEach((entry, index) => {
      entry.color = PALETTE[index % PALETTE.length];
      entry.models.forEach((model, modelIndex) => {
        // Same hue as the CLI, stepped lighter per model so the tooltip reads
        // as a breakdown of the bar rather than a different data set.
        model.color = MODEL_SHADES[modelIndex % MODEL_SHADES.length];
      });
    });
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
  // Bar width follows the range: a month packs slim columns, a single day
  // fills a readable slab instead of leaving one hairline in the plot.
  // The cap keeps ≤7-day views from looking like solid blocks.
  const barW = Math.max(3, Math.min(step * 0.62, 76));
  const y = (tokens: number) => padTop + plotH - (tokens / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // Thin the date labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  const hoverIndex = hoverDay ? days.indexOf(hoverDay) : -1;
  const hoverTotal = hoverIndex >= 0 ? dayTotals[hoverIndex] : 0;
  const tooltipRows = hoverIndex >= 0 ? buildTooltipRows(series, hoverIndex, formatTokens) : [];

  useLayoutEffect(() => {
    const box = boxRef.current;
    const tip = tipRef.current;
    if (!box || !tip || !cursor) {
      setTipPos(null);
      return;
    }
    const bounds = box.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    // Stay inside the settings pane (not just the chart): anything past it
    // widened the pane into a scrollbar. Bounds are the pane's edges mapped
    // into this wrapper's coordinates.
    const pane = box.closest("[role='dialog']")?.getBoundingClientRect() ?? bounds;
    const left = pane.left - bounds.left + 4;
    const right = pane.right - bounds.left - 4;
    const top = pane.top - bounds.top + 4;
    const bottom = pane.bottom - bounds.top - 4;
    // Auto side: prefer the pointer's right, flip to its left when the box
    // would not fit there.
    const flips = right - cursor.x < size.width + 18;
    const desiredLeft = flips ? cursor.x - size.width - 14 : cursor.x + 14;
    setTipPos({
      left: Math.max(left, Math.min(desiredLeft, right - size.width)),
      top: Math.max(top, Math.min(cursor.y + 14, bottom - size.height)),
    });
  }, [cursor, hoverDay]);

  return (
    <div
      ref={boxRef}
      className="relative flex w-full flex-col gap-2"
      onMouseMove={(event) => {
        const box = boxRef.current?.getBoundingClientRect();
        if (!box) return;
        setCursor({ x: event.clientX - box.left, y: event.clientY - box.top });
      }}
      onMouseLeave={() => setCursor(null)}
    >
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
          ref={tipRef}
          className="pointer-events-none absolute z-10 flex min-w-[150px] flex-col gap-1 rounded-lg border border-separator-border bg-background-primary-default p-2 shadow-dropdown"
          style={tipPos ? { left: tipPos.left, top: tipPos.top } : { left: 0, top: 0, visibility: "hidden" }}
        >
          <span className="text-body-2-regular text-text-tertiary">{hoverDay}</span>
          <span className="flex items-baseline justify-between gap-3 text-body-2-medium text-text-primary">
            <span>{t("usage.tooltipTotal")}</span>
            <span className="tabular-nums">{formatTokens(hoverTotal)}</span>
          </span>
          {tooltipRows}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {series.map((s) => (
          <span key={s.engine} className="flex min-w-0 items-center gap-1.5 text-body-2-regular text-text-secondary">
            <EngineIcon
              engine={s.engine as EngineIconId}
              size={14}
              className="shrink-0 text-foreground-icon-primary"
            />
            <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="max-w-[150px] truncate">{s.model}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
