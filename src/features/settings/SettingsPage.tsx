import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import Puzzle from "lucide-react/dist/esm/icons/puzzle";
import {
  SettingsModal,
  type SettingsNavGroup,
} from "@/components/application/settings/settings-modal";
import {
  pluginIdFromRegistryKey,
  settingsRegistry,
  useRegistry,
} from "@ccgui/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import { useChatStore } from "@/features/chat/store";
import { ENGINE_IDS, type EngineId } from "./providers";
import { CliHeaderActions } from "./CliHeaderActions";
import { readStoredJson, writeStored } from "@/lib/storage";
// Side-effect import: registers all builtin sections into settingsRegistry.
import "./sections";

/** Rail meta for known nav groups (label + rail order). A group the SDK adds
 *  later isn't listed here — it falls back to label = group id, appended
 *  after the known rails, so new groups render instead of silently
 *  vanishing (empty groups are filtered out as before). */
/** A nav group plus its rail order, sorted before handing to the modal. */
type RailGroup = SettingsNavGroup & { order: number };
const GROUP_META: Record<string, { labelKey: string; order: number }> = {
  settings: { labelKey: "settings.title", order: 0 },
  cli: { labelKey: "settings.cliManage", order: 1 },
};
const KNOWN_GROUP_COUNT = Object.keys(GROUP_META).length;
/** localStorage key for the user's CLI 管理 rail order (section keys). */
const CLI_NAV_ORDER_KEY = "ccgui-next.settingsCliNavOrder:v1";

const readCliNavOrder = (): string[] =>
  readStoredJson(CLI_NAV_ORDER_KEY, (value) =>
    Array.isArray(value) && value.every((k) => typeof k === "string")
      ? (value as string[])
      : null,
  ) ?? [];

/** Items in the user's stored order; keys absent from the stored list (new
 *  engines) keep their registry order at the end — Array.sort is stable. */
const orderByStoredKeys = <T extends { key: string }>(
  items: T[],
  keys: string[],
): T[] => {
  const rank = new Map(keys.map((key, index) => [key, index]));
  return [...items].sort(
    (a, b) =>
      (rank.get(a.key) ?? keys.length) - (rank.get(b.key) ?? keys.length),
  );
};

/** Unknown page params fall back to General. */
const renderPage = (key: string) => {
  const def = settingsRegistry.get(key);
  if (!def) {
    const fallback = settingsRegistry.get("general");
    return fallback ? <fallback.component /> : null;
  }
  const Component = def.component;
  // Plugin-rendered pages are wrapped so a render crash unmounts only the
  // plugin subtree (plan acceptance 1b); host pages stay unwrapped.
  if (key.startsWith("plugin:")) {
    return (
      <PluginBoundary pluginId={pluginIdFromRegistryKey(key)}>
        <Component />
      </PluginBoundary>
    );
  }
  return <Component />;
};
/** CLI 管理 pages get the docs/version/update cluster next to the title. */
const renderHeaderActions = (key: string) => {
  if (!key.startsWith("cli:")) return null;
  const engine = key.slice("cli:".length);
  if (!(ENGINE_IDS as readonly string[]).includes(engine)) return null;
  return <CliHeaderActions engine={engine as EngineId} />;
};

/**
 * Settings route: overlay for the BoardUI settings modal. ChatPage itself is mounted once
 * by App on every route, so opening and closing settings never rebuilds
 * the chat tree.
 *
 * Nav groups and pages come from settingsRegistry: builtin sections register
 * in ./sections, plugin sections arrive via ctx.ui.registerSettingsSection
 * (plan §4.2 #1).
 */
export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sections = useRegistry(settingsRegistry);
  const [cliNavOrder, setCliNavOrder] = useState<string[]>(readCliNavOrder);
  /** Engine enable states; the chat store refreshes them on every CLI config
   *  change, so toggling a CLI's enable switch moves its rail row live. An
   *  empty list (probe still running or failed) means "don't split" — never
   *  collapse the whole rail away. */
  const engines = useChatStore((s) => s.engines);
  /** CLI 管理 rail keys in display order (user order wins over registry order). */
  const orderedCliKeys = useMemo(() => {
    const keys = sections
      .filter((def) => def.group === "cli")
      .sort((a, b) => a.order - b.order)
      .map((def) => def.key);
    return orderByStoredKeys(
      keys.map((key) => ({ key })),
      cliNavOrder,
    ).map((entry) => entry.key);
  }, [sections, cliNavOrder]);
  // Legacy links land on a CLI 管理 page: ?page=cliConfig → first CLI,
  // ?page=dsh → the DSH engine page (its host section merged there).
  const rawPage = searchParams.get("page") ?? "general";
  const pageParam =
    rawPage === "cliConfig"
      ? (orderedCliKeys[0] ?? "general")
      : rawPage === "dsh"
        ? "cli:dsh"
        : rawPage;

  const groups = useMemo<RailGroup[]>(() => {
    const sorted = [...sections].sort((a, b) => a.order - b.order);
    // Bucket by group in first-seen order; unknown groups (new SDK group
    // values) keep their own rail instead of joining nothing.
    const byGroup = new Map<string, SettingsNavGroup["items"]>();
    for (const def of sorted) {
      const item = {
        key: def.key,
        label: def.label(),
        icon: def.icon ?? Puzzle,
      };
      const bucket = byGroup.get(def.group);
      if (bucket) bucket.push(item);
      else byGroup.set(def.group, [item]);
    }
    /** Enabled engine ids; empty when the engine probe hasn't landed, in
     *  which case every CLI stays in the main rail. */
    const enabledEngines = new Set(
      engines.flatMap((engine) => (engine.enabled ? [engine.id] : [])),
    );
    // Re-render the rail on language flips: labels are functions of i18n.
    return [...byGroup.entries()]
      .flatMap(([group, items], index) => {
        const meta = GROUP_META[group];
        const order = meta?.order ?? KNOWN_GROUP_COUNT + index;
        if (group !== "cli") {
          return [{ label: meta ? t(meta.labelKey) : group, order, items }];
        }
        const ordered = orderByStoredKeys(items, orderedCliKeys);
        // CLIs the user turned off leave the main rail for a collapsed
        // 未启用 bucket with grayed icons; the bucket only exists when the
        // engine states are known and at least one CLI is disabled.
        const disabledItems =
          engines.length > 0
            ? ordered.flatMap((item) =>
                // Plugin sections in this rail have no engine state and
                // always stay in the main group.
                item.key.startsWith("cli:") &&
                !enabledEngines.has(item.key.slice("cli:".length))
                  ? [{ ...item, disabled: true }]
                  : [],
              )
            : [];
        const enabledItems =
          disabledItems.length > 0
            ? ordered.filter(
                (item) => !disabledItems.some((d) => d.key === item.key),
              )
            : ordered;
        const rail: RailGroup[] = [
          {
            label: meta ? t(meta.labelKey) : group,
            order,
            items: enabledItems,
            // The CLI 管理 rail is drag-sortable; the order persists across
            // sessions (localStorage) and new engines append at the end. A
            // reorder only covers the enabled rows — the stored list keeps
            // the disabled keys trailing in their current relative order.
            onReorderItems: (orderedKeys: string[]) => {
              const next = [
                ...orderedKeys,
                ...disabledItems.map((item) => item.key),
              ];
              setCliNavOrder(next);
              writeStored(CLI_NAV_ORDER_KEY, JSON.stringify(next));
            },
            dragHandleLabel: t("settings.cliDrag"),
          },
        ];
        if (disabledItems.length > 0) {
          rail.push({
            label: t("settings.cliDisabledGroup"),
            order: order + 0.5,
            collapsible: true,
            items: disabledItems,
          });
        }
        return rail;
      })
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, t, i18n.language, cliNavOrder, orderedCliKeys, engines]);

  const titles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const def of sections) map[def.key] = def.label();
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, i18n.language]);

  return (
    <SettingsModal
      isOpen
      onClose={() => navigate("/")}
      defaultPage={pageParam}
      ariaLabel={t("settings.title")}
      groups={groups}
      titles={titles}
      renderPage={renderPage}
      renderHeaderActions={renderHeaderActions}
    />
  );
}
