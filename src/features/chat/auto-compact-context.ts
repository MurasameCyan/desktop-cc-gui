import { useCallback, useSyncExternalStore } from "react";
import { readStoredJson, writeStored } from "@/lib/storage";

export const AUTO_COMPACT_STORAGE_KEY = "ccgui-next.chat.autoCompactBySession";
const AUTO_COMPACT_CHANGED_EVENT = "ccgui-next:auto-compact-changed";
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 80;

export interface AutoCompactSettings {
  enabled: boolean;
  threshold: number;
}

const DEFAULT_SETTINGS: AutoCompactSettings = Object.freeze({
  enabled: false,
  threshold: DEFAULT_AUTO_COMPACT_THRESHOLD,
});

type StoredSettings = Record<string, AutoCompactSettings>;

export function normalizeAutoCompactThreshold(value: unknown, fallback = DEFAULT_AUTO_COMPACT_THRESHOLD): number {
  const parsed =
    typeof value === "string"
      ? value.trim() === ""
        ? Number.NaN
        : Number(value)
      : typeof value === "number"
        ? value
        : Number(value);
  const safeFallback = Math.round(Math.max(1, Math.min(100, fallback)));
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.round(Math.max(1, Math.min(100, parsed)));
}

function readStoredSettings(): StoredSettings {
  const raw = readStoredJson(AUTO_COMPACT_STORAGE_KEY, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result: StoredSettings = {};
    for (const [sessionKey, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      result[sessionKey] = {
        enabled: record.enabled === true,
        threshold: normalizeAutoCompactThreshold(record.threshold),
      };
    }
    return result;
  });
  return raw ?? {};
}

let settingsSnapshot = readStoredSettings();
const listeners = new Set<() => void>();

function refreshSettingsSnapshot(): void {
  settingsSnapshot = readStoredSettings();
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener(AUTO_COMPACT_CHANGED_EVENT, refreshSettingsSnapshot);
  window.addEventListener("storage", refreshSettingsSnapshot);
}

export function subscribeAutoCompactSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAutoCompactSettings(sessionKey: string): AutoCompactSettings {
  if (!sessionKey) return DEFAULT_SETTINGS;
  return settingsSnapshot[sessionKey] ?? DEFAULT_SETTINGS;
}

function updateSettings(sessionKey: string, patch: Partial<AutoCompactSettings>): void {
  if (!sessionKey) return;
  const current = readStoredSettings();
  const previous = current[sessionKey] ?? DEFAULT_SETTINGS;
  const next = {
    ...current,
    [sessionKey]: {
      enabled: patch.enabled ?? previous.enabled,
      threshold: normalizeAutoCompactThreshold(patch.threshold ?? previous.threshold, previous.threshold),
    },
  };
  writeStored(AUTO_COMPACT_STORAGE_KEY, JSON.stringify(next));
  settingsSnapshot = next;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTO_COMPACT_CHANGED_EVENT));
  } else {
    for (const listener of listeners) listener();
  }
}

export function setAutoCompactEnabled(sessionKey: string, enabled: boolean): void {
  updateSettings(sessionKey, { enabled });
}

export function setAutoCompactThreshold(sessionKey: string, threshold: unknown): void {
  updateSettings(sessionKey, { threshold: normalizeAutoCompactThreshold(threshold) });
}

/** Carry a pending tab's settings onto the native session it just adopted.
 *  Without this, a threshold set on a brand-new chat is lost the moment the
 *  first send resolves the session id (the key changes from `new:<engine>:<ws>`
 *  to `<engine>/<id>`). A native key that already has settings wins — the user
 *  configured that session explicitly. */
export function migrateAutoCompactSettings(fromKey: string, toKey: string): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const current = readStoredSettings();
  const pending = current[fromKey];
  if (!pending) return;
  const next = { ...current, [toKey]: current[toKey] ?? pending };
  delete next[fromKey];
  writeStored(AUTO_COMPACT_STORAGE_KEY, JSON.stringify(next));
  settingsSnapshot = next;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTO_COMPACT_CHANGED_EVENT));
  } else {
    for (const listener of listeners) listener();
  }
}

export function useAutoCompactSettings(sessionKey: string): AutoCompactSettings {
  const getSnapshot = useCallback(() => getAutoCompactSettings(sessionKey), [sessionKey]);
  return useSyncExternalStore(subscribeAutoCompactSettings, getSnapshot, () => DEFAULT_SETTINGS);
}

export interface AutoCompactDecisionInput {
  enabled: boolean;
  threshold: number;
  usagePct: number | undefined;
  streaming: boolean;
  compacting: boolean;
  latched: boolean;
}

export function shouldAutoCompact({
  enabled,
  threshold,
  usagePct,
  streaming,
  compacting,
  latched,
}: AutoCompactDecisionInput): boolean {
  return Boolean(
    enabled &&
      !streaming &&
      !compacting &&
      !latched &&
      usagePct !== undefined &&
      usagePct >= threshold,
  );
}
