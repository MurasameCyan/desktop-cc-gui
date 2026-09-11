export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** The six effort stops, in slider order (Codex Astra catalog order). */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/** i18n label key per effort stop. */
export const EFFORT_LABEL_KEYS: Record<EffortLevel, string> = {
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
  ultra: "chat.effortUltra",
};
