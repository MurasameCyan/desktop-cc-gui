import { OmpSpeedSection } from "./omp-speed-section";
import { filterModels, groupModelsByProvider, type ModelGroup } from "./model-list";
import { supportsOmpFastMode, type OmpServiceTier } from "@/lib/omp-service-tier";
"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Ref, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import X from "lucide-react/dist/esm/icons/x";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
  Slider as AriaSlider,
  SliderThumb as AriaSliderThumb,
  SliderTrack as AriaSliderTrack,
} from "react-aria-components";
import { AnimatePresence, m } from "motion/react";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { ModalShell } from "@/components/dialogs";
import { CLI_DISPLAY_NAMES, inferModelEngine } from "@/components/foundations/icons/engine-brands";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { MOBILE_MEDIA, useMediaQuery } from "@/hooks/use-media-query";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";
import { FlameOverlay } from "./effort-flame";
import { EFFORT_LEVELS } from "./effort-levels";

/**
 * Board UI → "ai_chat" dropdowns (nodes 4035:6313 / 4035:6925), adapted to
 * live data. Same react-aria non-modal popover recipe as the template;
 * contents are props-driven:
 * - CliMenu — CLI + model switcher opened from the composer's engine
 *   button: each engine row flies out a model + effort panel to the right
 *   (search field over a "Models" radio group over the effort slider,
 *   Board UI node 4035:6925). */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** CLI picker panel: shadcn-style menu (reference: desktop-cc-gui's
 *  ModelSelect) — 8px radius, 4px padding, hairline separators between rows,
 *  no header label. Distinct from the other ai_chat popovers above. */
const CLI_POPOVER_CLASSES = menuPopoverSurface({
  width: "w-64",
  origin: "origin-bottom-left",
  radius: "rounded-lg",
  padding: "p-1",
});

/* ------------------------------------------------------------- engine picker */

export interface MenuOption {
  id: string;
  label: string;
  /** Engine is installed and spawnable — drives the status dot. */
  available?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

const EFFORT_LABEL_KEYS: Record<EffortLevel, string> = {
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
  ultra: "chat.effortUltra",
};

/** Fresh random impulse per tick each time the engine ignites: blown left by
 *  the exhaust with random lift, tumble and stagger, like debris. */
function useBlastImpulses(isMax: boolean) {
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
function EffortTicks({
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
function EffortSlider({
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

export interface ModelOption {
  /** "" selects the CLI/provider default model. */
  id: string;
  label: string;
  /** Secondary line under the label (e.g. "Custom Opus model"). */
  description?: string;
  /** Catalog provider ("kimi-code"); derived from the "provider/model" id
   *  when the catalog entry is missing. Two or more distinct providers turn
   *  the flyout list into labeled sections. */
  provider?: string;
}

/** Per-engine model flyout: pops to the right of the CLI popover, bottom-
 *  aligned with the engine list so the taller panel never clips below the
 *  composer-anchored popover. */
const FLYOUT_CLASSES = cx(
  "absolute left-full bottom-0 z-10 ml-2 w-80 max-w-[calc(100vw-32px)]",
  "rounded-lg border border-border-button-default bg-background-primary-default p-1 shadow-dropdown",
);

/* -------------------------------------------------------------- engine row */

/** One engine row in the CLI list: brand mark, name, selection dot (active
 *  engine only) and the chevron that hints at the flyout. */
function EngineRow({
  option,
  selected,
  flyoutOpen,
  onSelect,
}: {
  option: MenuOption;
  selected: boolean;
  /** This engine's flyout is currently open. */
  flyoutOpen: boolean;
  /** Row click: show this engine's model list (the engine itself switches
   *  when a model is picked there). */
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-disabled={option.disabled || undefined}
      title={option.disabled ? option.disabledReason : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors",
        selected || flyoutOpen
          ? "bg-background-primary-hover"
          : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
        option.disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <EngineIcon
        engine={option.id}
        size={18}
        className="shrink-0 text-foreground-icon-primary"
      />
      <span className="text-body-medium text-text-primary">
        {CLI_DISPLAY_NAMES[option.id] ?? option.label}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {selected && (
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-notification-success-foreground"
          />
        )}
        <ChevronRight
          className="size-4 text-foreground-icon-secondary"
          aria-hidden
        />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ flyout */

/** One checkmark model row inside the flyout's radio group. */
function ModelRow({
  option,
  selected,
  engineId,
  onPick,
}: {
  option: ModelOption;
  selected: boolean;
  engineId: string;
  onPick: (engine: string, id: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onPick(engineId, option.id)}
      className={cx(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
        selected
          ? "bg-background-primary-hover"
          : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
      )}
    >
      <EngineIcon
        engine={inferModelEngine(option.label) ?? inferModelEngine(option.id) ?? engineId}
        size={18}
        className="shrink-0 text-foreground-icon-primary"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
          {option.label}
        </span>
        {/* CLI /model-menu style subtitle ("Custom Opus model"); absent
            for plain catalog rows. */}
        {option.description && (
          <span className="truncate text-body-2-regular whitespace-nowrap text-text-secondary">
            {option.description}
          </span>
        )}
      </span>
      {selected && (
        <Check
          className="ml-auto size-4 shrink-0 text-foreground-icon-primary"
          aria-hidden
        />
      )}
    </button>
  );
}

/** The flyout's effort section: label with a keyed blur-in value, the
 *  faster/smarter captions, and the five-stop slider. */
function FlyoutEffortSection({
  effort,
  onChange,
  header,
}: {
  effort: EffortLevel;
  onChange: (level: EffortLevel) => void;
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col">
      {header ?? <span className="pl-2 text-body-medium text-text-secondary">
        {t("chat.effort")}{" "}
        {/* Keyed on the value so each change remounts and blurs in. */}
        <m.span
          key={effort}
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="inline-block text-text-primary"
        >
          {t(EFFORT_LABEL_KEYS[effort])}
        </m.span>
      </span>}
      <div className={cx("flex w-full items-center justify-between px-2 pb-[3px]", header ? "pt-0" : "pt-2")}>
        <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
          {t("chat.effortFaster")}
        </span>
        <span className="text-body-2-medium whitespace-nowrap text-text-secondary">
          {t("chat.effortSmarter")}
        </span>
      </div>
      <div className="w-full px-2 pb-2">
        <EffortSlider value={effort} onChange={onChange} />
      </div>
    </div>
  );
}

/** Header refresh button: re-probes provider configs and model catalogs,
 * spinning until the probe settles. */
function RefreshButton({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <button
      type="button"
      aria-label={t("common.refresh")}
      title={t("common.refresh")}
      disabled={refreshing}
      onClick={() => {
        if (refreshing) return;
        setRefreshing(true);
        Promise.resolve(onRefresh()).finally(() => setRefreshing(false));
      }}
      className="flex size-7 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:cursor-default"
    >
      <RefreshCw
        className={cx("size-3.5", refreshing && "animate-spin")}
        aria-hidden
      />
    </button>
  );
}

/** Optional header actions: catalog refresh (flyout + dialog) and/or the
 * dialog's dismiss button. Renders nothing when neither applies. */
function PanelActions({
  onRefresh,
  onClose,
}: {
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  if (!onRefresh && !onClose) return null;
  return (
    <span className="mr-1 flex shrink-0 items-center">
      {onRefresh && <RefreshButton onRefresh={onRefresh} />}
      {onClose && (
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** The scrollable radio-group model list: provider-sectioned (search
 * included) when the catalog mixes sources, flat otherwise; an exhausted
 * search shows the no-match hint. */
function ModelGroupList({
  groups,
  empty,
  selectedModelId,
  engineId,
  onPickModel,
}: {
  groups: ModelGroup[];
  empty: boolean;
  selectedModelId: string;
  engineId: string;
  onPickModel: (engine: string, id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex max-h-[240px] w-full flex-col overflow-y-auto"
      role="radiogroup"
      aria-label={t("chat.modelPicker")}
    >
      {groups.map((group) => (
        <div key={group.key || "__flat__"} className="flex w-full flex-col">
          {group.key && (
            <span className="sticky top-0 z-10 bg-background-primary-default px-2 pt-1.5 pb-0.5 text-body-2-medium text-text-tertiary">
              {group.key}
            </span>
          )}
          {group.rows.map((model) => (
            <ModelRow
              key={model.id || "__default__"}
              option={model}
              selected={model.id === selectedModelId}
              engineId={engineId}
              onPick={onPickModel}
            />
          ))}
        </div>
      ))}
      {empty && (
        <span className="p-2 text-body-medium text-text-tertiary">
          {t("chat.noMatchingModels")}
        </span>
      )}
    </div>
  );
}

/**
 * Engine model panel content: "{name} 引擎" header over a search field over
 * checkmark model rows over the effort slider. Shared by the desktop flyout
 * (EngineFlyout) and the mobile second-level dialog; `onClose` adds a
 * dismiss button to the header, which only the dialog passes. Model picks
 * stay in-panel so Fast / effort can follow without reopening.
 */
function EngineModelPanel({
  option,
  models,
  selectedModelId,
  query,
  onQueryChange,
  effort,
  onPickModel,
  onEffortChange,
  ompServiceTier,
  onOmpServiceTierChange,
  codexServiceTier,
  onCodexServiceTierChange,
  onRefresh,
  onClose,
}: {
  option: MenuOption;
  models: ModelOption[];
  selectedModelId: string;
  query: string;
  onQueryChange: (value: string) => void;
  effort: EffortLevel;
  onPickModel: (engine: string, id: string) => void;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  ompServiceTier: OmpServiceTier;
  onOmpServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  codexServiceTier: OmpServiceTier;
  onCodexServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  /** Re-probe provider configs and model catalogs without an app restart. */
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = filterModels(models, normalizedQuery);
  // Provider sections layer the list whenever the engine's catalog mixes
  // sources (OMP serving several relays) — including while filtering, so the
  // results keep naming their origin instead of collapsing into identical
  // rows. Pinning the active row to the top would tear it out of its section,
  // so a grouped list keeps the catalog order and marks the pick in place;
  // only a flat single-source list reorders to surface the pick.
  const groups = useMemo(() => groupModelsByProvider(filteredModels), [filteredModels]);
  // Sectioned whenever the grouping carried keys — a single provider still
  // gets its header (the group is keyless only when no provider is known).
  const layered = groups.length > 0 && groups[0].key !== "";
  const orderedModels = layered
    ? filteredModels
    : [...filteredModels].sort(
        (a, b) =>
          Number(b.id === selectedModelId) - Number(a.id === selectedModelId),
      );
  // The section holding the current pick leads so the selection is never
  // scrolled out of view; within sections the catalog order stands.
  const visibleGroups = layered
    ? [...groups].sort(
        (a, b) =>
          Number(b.rows.some((m) => m.id === selectedModelId)) -
          Number(a.rows.some((m) => m.id === selectedModelId)),
      )
    : null;
  const ompFast = option.id === "omp" && supportsOmpFastMode(selectedModelId);
  const codexFast = option.id === "codex";
  const showFast = ompFast || codexFast;
  const fastTier = codexFast ? codexServiceTier : ompServiceTier;
  const onFastChange = codexFast ? onCodexServiceTierChange : onOmpServiceTierChange;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate px-2 py-1.5 text-body-medium text-text-secondary">
          {t("chat.engineHeader", {
            name: CLI_DISPLAY_NAMES[option.id] ?? option.label,
          })}
        </span>
        <PanelActions onRefresh={onRefresh} onClose={onClose} />
      </div>
      <div className="relative mx-1 -mt-1.5 pb-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-[calc(50%+2px)] text-foreground-icon-secondary"
          aria-hidden
        />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("chat.modelSearchPlaceholder")}
          aria-label={t("chat.modelSearchPlaceholder")}
          className="h-8 w-full rounded-md border border-separator-border bg-background-secondary-default pr-2 pl-7 text-body-regular text-text-primary outline-none placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        />
      </div>
      <ModelGroupList
        groups={visibleGroups ?? [{ key: "", rows: orderedModels }]}
        empty={orderedModels.length === 0}
        selectedModelId={selectedModelId}
        engineId={option.id}
        onPickModel={onPickModel}
      />

      {/* Full-bleed divider, like the reference submenu. */}
      <div aria-hidden className={cx("-mx-1 mt-[7px] h-px bg-border-button-default", showFast ? "mb-1" : "mb-3")} />
      <FlyoutEffortSection
        header={showFast ? (
          <OmpSpeedSection
            model={selectedModelId}
            supported={codexFast || undefined}
            value={fastTier}
            onChange={onFastChange}
          >
            <span className="text-body-medium text-text-primary">{t(EFFORT_LABEL_KEYS[effort])}</span>
          </OmpSpeedSection>
        ) : undefined}
        effort={effort}
        onChange={(level) => onEffortChange(option.id, level)}
      />
    </div>
  );
}

/** Desktop-only wrapper: the model panel as a flyout popping to the right of
 *  the CLI popover. On mobile CliMenu renders the same panel in a modal
 *  dialog instead (hover flyouts don't work on touch). */
function EngineFlyout(props: Parameters<typeof EngineModelPanel>[0]) {
  return (
    <div className={FLYOUT_CLASSES}>
      <EngineModelPanel {...props} />
    </div>
  );
}

/** Trigger min-width lock while the popover is open: snapshot on open, clear
 *  on close, so shorter model labels can't shrink the trigger mid-session
 *  and slide the top-end popover. Adjusted during render (prev-prop pattern)
 *  so every open/close path — trigger press, outside press, Esc — flips it,
 *  not just onOpenChange. */
function useLockedMinWidth(isOpen: boolean, triggerRef: Ref<HTMLButtonElement>) {
  const [lockedMinWidth, setLockedMinWidth] = useState<number | undefined>();
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) {
      setLockedMinWidth(undefined);
    } else {
      const node =
        triggerRef && typeof triggerRef !== "function" ? triggerRef.current : null;
      if (node) setLockedMinWidth(node.offsetWidth);
    }
  }
  return lockedMinWidth;
}

/** Borderless trigger carrying the whole selection at a glance:
 *  "{CLI} / {model} · {effort}" (CLI name / model / effort). The model
 *  part only drops out when the engine has no model list at all.
 *  min-w-0 lets the trigger shrink instead of pushing the send button out
 *  of the composer on narrow widths; below md it collapses to icon +
 *  truncated model (aria-label carries the full selection). */
function CliMenuTrigger({
  triggerRef,
  engine,
  engineName,
  model,
  effort,
  ompServiceTier,
  codexServiceTier,
  modelId,
  isOpen,
}: {
  triggerRef: Ref<HTMLButtonElement>;
  engine: string;
  /** Display name of the active engine. */
  engineName: string;
  /** Selected model of the active engine, when it has a model list. */
  model: ModelOption | undefined;
  effort: EffortLevel;
  ompServiceTier: OmpServiceTier;
  codexServiceTier: OmpServiceTier;
  modelId: string;
  /** While open, lock the trigger's min-width so model picks don't shrink it
   *  and nudge the top-end popover. */
  isOpen: boolean;
}) {
  const { t } = useTranslation();
  const showFast =
    (engine === "omp" && supportsOmpFastMode(modelId) && ompServiceTier === "priority") ||
    (engine === "codex" && codexServiceTier === "priority");
  // Snapshot width on open; clear on close. Shorter model labels then can't
  // shrink the trigger mid-session and slide the popover.
  const lockedMinWidth = useLockedMinWidth(isOpen, triggerRef);
  return (
    <AriaButton
      ref={triggerRef}
      aria-label={`${engineName}${model ? ` / ${model.label}` : ""} · ${t(EFFORT_LABEL_KEYS[effort])}`}
      style={lockedMinWidth ? { minWidth: lockedMinWidth } : undefined}
      className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <EngineIcon engine={engine} size={16} className="shrink-0 text-foreground-icon-secondary" />
      <span className="flex min-w-0 items-center gap-1 text-body-2-medium whitespace-nowrap text-text-secondary transition-colors duration-150 ease group-hover:text-text-primary">
        <span className="shrink-0 max-md:hidden">{engineName}</span>
        {model && (
          <>
            <span aria-hidden className="shrink-0 text-text-tertiary max-md:hidden">
              /
            </span>
            <span className="max-w-44 truncate max-md:max-w-28">{model.label}</span>
          </>
        )}
        <span aria-hidden className="shrink-0 text-text-tertiary max-md:hidden">
          ·
        </span>
        {/* Reserve the widest localized level so the right-aligned popover stays put. */}
        <span className="inline-grid shrink-0 max-md:hidden">
          {EFFORT_LEVELS.map(level => (
            <span key={level} aria-hidden={level !== effort} className={cx("col-start-1 row-start-1", level !== effort && "invisible")}>
              {t(EFFORT_LABEL_KEYS[level])}
            </span>
          ))}
        </span>
        {(engine === "omp" && supportsOmpFastMode(modelId)) || engine === "codex" ? (
          <span aria-hidden={!showFast} className={cx("w-7 shrink-0 text-center text-text-primary", !showFast && "invisible")}>Fast</span>
        ) : null}
      </span>
    </AriaButton>
  );
}

/** Popover body: the hairline-separated engine rows and, on desktop, the
 *  hovered engine's model flyout floating to the right. Pointer entering
 *  or leaving the rows+flyout cluster cancels/schedules the flyout's close
 *  grace period (owned by the parent). */
function EngineMenuBody({
  options,
  value,
  openEngine,
  modelsByEngine,
  models,
  efforts,
  query,
  onQueryChange,
  isMobile,
  onSelectEngine,
  onPickModel,
  onEffortChange,
  ompServiceTier,
  onOmpServiceTierChange,
  codexServiceTier,
  onCodexServiceTierChange,
  onRefreshModels,
}: {
  options: MenuOption[];
  value: string;
  /** Engine whose model flyout is open, null when closed. */
  openEngine: string | null;
  modelsByEngine: Record<string, ModelOption[]>;
  models: Record<string, string>;
  efforts: Record<string, EffortLevel>;
  query: string;
  onQueryChange: (value: string) => void;
  isMobile: boolean;
  onSelectEngine: (option: MenuOption) => void;
  onPickModel: (engine: string, id: string) => void;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  ompServiceTier: OmpServiceTier;
  onOmpServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  codexServiceTier: OmpServiceTier;
  onCodexServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  onRefreshModels?: () => void | Promise<void>;
}) {
  const flyoutOption = options.find((o) => o.id === openEngine);
  return (
    <div className="flex w-full flex-col">
      <div className="relative">
        <div className="flex w-full flex-col">
          {options.map((option, index) => (
            <Fragment key={option.id}>
              {index > 0 && (
                <div
                  aria-hidden
                  className="-mx-1 my-1 border-t border-separator-border"
                />
              )}
              {/* Not `disabled`: that attribute would swallow the click
                  that switches the panel. */}
              <EngineRow
                option={option}
                selected={option.id === value}
                flyoutOpen={option.id === openEngine}
                onSelect={() => onSelectEngine(option)}
              />
            </Fragment>
          ))}
        </div>

        {!isMobile && flyoutOption && (
          <EngineFlyout
              option={flyoutOption}
              models={modelsByEngine[flyoutOption.id] ?? []}
              selectedModelId={models[flyoutOption.id] ?? ""}
              query={query}
              onQueryChange={onQueryChange}
              effort={efforts[flyoutOption.id] ?? "medium"}
              onPickModel={onPickModel}
              onEffortChange={onEffortChange}
              ompServiceTier={ompServiceTier}
              onOmpServiceTierChange={onOmpServiceTierChange}
              codexServiceTier={codexServiceTier}
              onCodexServiceTierChange={onCodexServiceTierChange}
            onRefresh={onRefreshModels}
          />
        )}
      </div>
    </div>
  );
}

/** Mobile second-level model dialog: touch has no hover flyout, so tapping
 *  an engine row opens the same EngineModelPanel in a modal instead. */
function EngineModelDialog({
  option,
  modelsByEngine,
  models,
  efforts,
  query,
  onQueryChange,
  onPickModel,
  onEffortChange,
  ompServiceTier,
  onOmpServiceTierChange,
  codexServiceTier,
  onCodexServiceTierChange,
  onRefreshModels,
  onClose,
}: {
  /** Engine being configured; undefined when the dialog is closed. */
  option: MenuOption | undefined;
  modelsByEngine: Record<string, ModelOption[]>;
  models: Record<string, string>;
  efforts: Record<string, EffortLevel>;
  query: string;
  onQueryChange: (value: string) => void;
  onPickModel: (engine: string, id: string) => void;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  ompServiceTier: OmpServiceTier;
  onOmpServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  codexServiceTier: OmpServiceTier;
  onCodexServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  onRefreshModels?: () => void | Promise<void>;
  onClose: () => void;
}) {
  if (!option) return null;
  return (
    <ModalShell
      onClose={onClose}
      className="max-w-[calc(100vw-32px)]"
    >
      <EngineModelPanel
        option={option}
        models={modelsByEngine[option.id] ?? []}
        selectedModelId={models[option.id] ?? ""}
        query={query}
        onQueryChange={onQueryChange}
        effort={efforts[option.id] ?? "medium"}
        onPickModel={onPickModel}
        onEffortChange={onEffortChange}
        ompServiceTier={ompServiceTier}
        onOmpServiceTierChange={onOmpServiceTierChange}
        codexServiceTier={codexServiceTier}
        onCodexServiceTierChange={onCodexServiceTierChange}
        onRefresh={onRefreshModels}
        onClose={onClose}
      />
    </ModalShell>
  );
}

/**
 * CLI + model switcher, visually mirroring the reference ModelSelect
 * (desktop-cc-gui): a borderless trigger showing the full selection —
 * "{CLI} / {model} · {effort}" — hairline-separated engine rows where
 * only the active engine carries a status dot, and a per-engine flyout.
 * Picking a model in another engine's flyout switches to that engine (when
 * installed) and keeps the panel open for Fast / effort.
 */
export function CliMenu({
  options,
  value,
  onChange,
  modelsByEngine,
  models,
  onModelChange,
  efforts,
  onEffortChange,
  ompServiceTier,
  onOmpServiceTierChange,
  codexServiceTier,
  onCodexServiceTierChange,
  onRefreshModels,
}: {
  options: MenuOption[];
  value: string;
  onChange: (id: string) => void;
  /** Per-engine model lists; concrete ids only, CLI default first. */
  modelsByEngine: Record<string, ModelOption[]>;
  /** Selected model id per engine. */
  models: Record<string, string>;
  onModelChange: (engine: string, id: string) => void;
  /** Per-engine reasoning effort, rendered under each flyout's model list. */
  efforts: Record<string, EffortLevel>;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  ompServiceTier: OmpServiceTier;
  onOmpServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  codexServiceTier: OmpServiceTier;
  onCodexServiceTierChange: (tier: OmpServiceTier) => Promise<void>;
  /** Re-probe provider configs and model catalogs (flyout refresh button). */
  onRefreshModels?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { isOpen, triggerRef, popoverRef, close, setOpen } = usePopoverState();
  const current = options.find((o) => o.id === value);

  // Trigger carries the whole selection at a glance:
  // "Claude Code / 默认 · 高" (CLI name / model / effort). The model part
  // only drops out when the engine has no model list at all.
  const selectedModelId = models[value] ?? "";
  const selectedModel = (modelsByEngine[value] ?? []).find((m) => m.id === selectedModelId);
  const engineName = CLI_DISPLAY_NAMES[value] ?? current?.label ?? value;
  const triggerEffort: EffortLevel = efforts[value] ?? "medium";

  // Which engine's model flyout is open. Pre-opens on the active engine so
  // the current selection is visible the moment the menu opens.
  const [openEngine, setOpenEngine] = useState<string | null>(null);
  // Mobile has no hover, so the flyout never renders there; tapping an
  // engine row opens the same panel as a second-level modal instead.
  const isMobile = useMediaQuery(MOBILE_MEDIA);
  const [dialogEngine, setDialogEngine] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // The filter belongs to the search, not to one engine: switching the flyout
  // must not wipe what the user typed.
  useEffect(() => {
    setQuery("");
  }, [dialogEngine]);

  const handleOpenChange = (o: boolean) => {
    if (!setOpen(o)) return;
    setOpenEngine(o ? value : null);
    if (!o) setQuery("");
  };

  const dialogOption = options.find((o) => o.id === dialogEngine);

  // Keep the menu open after a model pick so Fast / effort can be adjusted in
  // the same panel (Codex desktop behavior). A model on another installed
  // engine still switches the active CLI; the flyout stays on that engine.
  const pickModel = (engine: string, id: string) => {
    onModelChange(engine, id);
    const target = options.find((o) => o.id === engine);
    if (engine !== value && target && !target.disabled) onChange(engine);
    if (!isMobile) setOpenEngine(engine);
  };

  const selectEngine = (option: MenuOption) => {
    // Mobile: the row tap drills into the second-level model dialog instead
    // of switching engines outright — the engine switches when a model is
    // picked there.
    if (isMobile) {
      setDialogEngine(option.id);
      close();
      return;
    }
    if (option.disabled) return;
    // Desktop: the row switches WHICH model list is shown, nothing more. The
    // engine itself changes when a model is picked from that list (see
    // pickModel), so browsing another CLI can never yank the panel away
    // mid-search — a pointer crossing the column does nothing at all.
    // An engine with no catalog has nothing to browse: keep the old
    // behaviour of switching outright.
    if ((modelsByEngine[option.id] ?? []).length === 0) {
      onChange(option.id);
      close();
      return;
    }
    setOpenEngine(option.id);
  };



  return (
    <>
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={handleOpenChange}>
      <CliMenuTrigger
        triggerRef={triggerRef}
        engine={value}
        engineName={engineName}
        model={selectedModel}
        effort={triggerEffort}
        ompServiceTier={ompServiceTier}
        codexServiceTier={codexServiceTier}
        modelId={selectedModelId}
        isOpen={isOpen}
      />

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top end"
        offset={8}
        className={CLI_POPOVER_CLASSES}
      >
        <AriaDialog aria-label={t("chat.cliPicker")} className="outline-none">
          <EngineMenuBody
            options={options}
            value={value}
            openEngine={openEngine}
            modelsByEngine={modelsByEngine}
            models={models}
            efforts={efforts}
            query={query}
            onQueryChange={setQuery}
            isMobile={isMobile}
            onSelectEngine={selectEngine}
            onPickModel={pickModel}
            onEffortChange={onEffortChange}
            ompServiceTier={ompServiceTier}
            onOmpServiceTierChange={onOmpServiceTierChange}
            codexServiceTier={codexServiceTier}
            onCodexServiceTierChange={onCodexServiceTierChange}
            onRefreshModels={onRefreshModels}
          />
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>

    <EngineModelDialog
      option={dialogOption}
      modelsByEngine={modelsByEngine}
      models={models}
      efforts={efforts}
      query={query}
      onQueryChange={setQuery}
      onPickModel={pickModel}
      onEffortChange={onEffortChange}
      ompServiceTier={ompServiceTier}
      onOmpServiceTierChange={onOmpServiceTierChange}
      codexServiceTier={codexServiceTier}
      onCodexServiceTierChange={onCodexServiceTierChange}
      onRefreshModels={onRefreshModels}
      onClose={() => setDialogEngine(null)}
    />
    </>
  );
}
