"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Slider as AriaSlider,
  SliderThumb as AriaSliderThumb,
  SliderTrack as AriaSliderTrack,
} from "react-aria-components";
import { AnimatePresence, m } from "motion/react";
import { FlameOverlay } from "./effort-flame";
import { EFFORT_LEVELS, type EffortLevel } from "./effort-levels";

/** Fresh random impulse per tick each time the engine ignites: blown left by
 *  the exhaust with random lift, tumble and stagger, like debris. */
export function useBlastImpulses(isMax: boolean) {
  return useMemo(
    () =>
      EFFORT_LEVELS.map(() => ({
        x: -(70 + Math.random() * 130),
        y: (Math.random() - 0.5) * 70,
        rotate: (Math.random() - 0.5) * 720,
        delay: Math.random() * 0.3,
      })),
    [isMax],
  );
}

/** The tick row on the effort track: one tick per stop, fading past the
 *  current value; at max they blast off like exhaust debris. */
export function EffortTicks({
  index,
  isMax,
  blast,
}: {
  index: number;
  isMax: boolean;
  blast: { x: number; y: number; rotate: number; delay: number }[];
}) {
  return (
    <div className="absolute inset-x-[9px] top-[7px] flex h-[13px] items-center justify-between">
      {EFFORT_LEVELS.map((level, i) => (
        <m.span
          key={level}
          aria-hidden
          animate={
            isMax
              ? {
                  x: blast[i].x,
                  y: blast[i].y,
                  rotate: blast[i].rotate,
                  opacity: 0,
                }
              : { x: 0, y: 0, rotate: 0, opacity: i > index ? 0.3 : 1 }
          }
          transition={
            isMax
              ? { duration: 1.6, ease: [0.22, 0.5, 0.5, 1], delay: blast[i].delay }
              : { duration: 0.3, ease: "easeOut" }
          }
          className="h-full w-[3px] rounded-[2px] bg-foreground-icon-tertiary"
        />
      ))}
    </div>
  );
}

/**
 * Effort slider (Board UI Figma node 4037:4885, six stops here): 27px
 * neutral track with a tick per stop, a light fill up to the 21×27 bordered
 * thumb. Built on react-aria's Slider for drag + keyboard support.
 *
 * The thumb travels edge to edge: its center moves from 10.5px to
 * (width − 10.5)px, and the tick row is inset to match, so ticks sit on the
 * stops at any rendered width. At max the ticks blast off like exhaust
 * debris and the flame shader washes over the track.
 */
export function EffortSlider({
  value,
  onChange,
}: {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const index = Math.max(0, EFFORT_LEVELS.indexOf(value));
  const isMax = index === EFFORT_LEVELS.length - 1;
  const blast = useBlastImpulses(isMax);
  // Thumb center sits at `fraction` of the 21px-inset rail, so its right
  // edge is at fraction × (track − 21px) + 21px — in calc() so the fill
  // lands flush against the thumb at any rendered width.
  const fraction = index / (EFFORT_LEVELS.length - 1);

  return (
    <AriaSlider
      aria-label={t("chat.effort")}
      minValue={0}
      maxValue={EFFORT_LEVELS.length - 1}
      step={1}
      value={index}
      onChange={(v) => onChange(EFFORT_LEVELS[v as number] ?? "medium")}
      className="w-full"
    >
      <div className="relative h-[27px] w-full overflow-hidden rounded-lg bg-background-secondary-default">
        {/* Fill up to the thumb's right edge. */}
        <div
          className="absolute inset-y-0 left-0 rounded-lg bg-background-tertiary-hover transition-[width] duration-150 ease-out"
          style={{ width: `calc(${fraction} * (100% - 21px) + 21px)` }}
        />
        <EffortTicks index={index} isMax={isMax} blast={blast} />
        {/* Above the ticks so the flame washes over the step dividers. */}
        <AnimatePresence>{isMax && <FlameOverlay />}</AnimatePresence>
        {/* Rail inset by half the thumb width so the 21px thumb lands flush
            on both track edges. The wrapper does the absolute positioning
            because SliderTrack forces `position: relative` inline. */}
        <div className="absolute inset-x-[10.5px] inset-y-0">
          <AriaSliderTrack className="h-full w-full">
            <AriaSliderThumb className="top-1/2 h-[27px] w-[21px] cursor-grab rounded-[7px] border border-border-checkbox-default bg-background-primary-default shadow-xs outline-none transition-shadow data-[dragging]:cursor-grabbing data-[focus-visible]:ring-2 data-[focus-visible]:ring-border-focus-ring" />
          </AriaSliderTrack>
        </div>
      </div>
    </AriaSlider>
  );
}
