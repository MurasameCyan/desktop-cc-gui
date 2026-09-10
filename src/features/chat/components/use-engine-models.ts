import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelOption } from "@/components/application/ai-chat/cli-menu";
import { ipc, type CliConfig, type EngineCatalog, type EngineInfo } from "@/lib/ipc";
import {
  CLI_CONFIG_CHANGED_EVENT,
  isPseudoProvider,
  providerModel,
  type EngineId,
} from "@/features/settings/providers";

/** Provider configs and per-engine model catalogs feeding the CLI menu's
 * per-engine model flyouts, plus the pin effect that repairs unset or stale
 * stored model picks. */
export function useEngineModels(
  engines: EngineInfo[],
  models: Record<string, string>,
  pinModels: (updates: Record<string, string>) => Promise<void>,
) {
  const [cliConfig, setCliConfig] = useState<CliConfig | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, EngineCatalog>>({});
  // Engine-level custom models (设置 → CLI → 自定义模型): user-added ids
  // merged into the picker next to the CLI's catalog.
  const [customModels, setCustomModels] = useState<Record<string, string[]>>({});
  // Engines whose catalog probe is still in flight: the picker shows whatever
  // it already knows (usually just the configured model) until it lands, so
  // the panel needs to say "still loading" instead of looking truncated.
  const [pending, setPending] = useState<Record<string, true>>({});

  // Provider configs feed the model picker's per-engine model lists.
  useEffect(() => {
    ipc.getCliConfig().then(setCliConfig).catch(() => {});
  }, []);
  // The settings CLI page mutates provider config and custom models outside
  // this tree; refetch so the picker tracks both immediately.
  useEffect(() => {
    const reload = () => {
      ipc.getCliConfig().then(setCliConfig).catch(() => {});
      ipc
        .getAppSettings()
        .then((s) => setCustomModels(s.customModels ?? {}))
        .catch(() => {});
    };
    reload();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, reload);
    return () => window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, reload);
  }, []);
  // Model catalogs for every engine (pi/omp probe their CLI; others return
  // empty and fall back to provider-config models below). The CLI menu's
  // per-engine model flyouts all read from this map.
  useEffect(() => {
    let cancelled = false;
    for (const engine of engines) {
      if (engine.id in catalogs) continue;
      setPending((prev) => (prev[engine.id] ? prev : { ...prev, [engine.id]: true }));
      ipc
        .listEngineModels(engine.id)
        .then((list) => {
          if (!cancelled) setCatalogs((prev) => ({ ...prev, [engine.id]: list }));
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) {
            setPending((prev) => {
              if (!prev[engine.id]) return prev;
              const next = { ...prev };
              delete next[engine.id];
              return next;
            });
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [engines, catalogs]);

  // Per-engine model lists for the CLI menu flyouts: the backend catalog
  // plus, for channel-driven engines, the current provider channel's
  // configured model (both describe the channel the engine would actually
  // launch with), with the current override appended so the selection never
  // vanishes. Claude is exempt: it runs on the CLI's own configuration
  // (~/.claude/settings.json), so app channels contribute nothing.
  const modelsByEngine = useMemo(() => {
    const result: Record<string, ModelOption[]> = {};
    for (const engine of engines) {
      const section = cliConfig?.[engine.id as EngineId];
      const currentId = section?.current ?? "";
      const currentRaw =
        engine.id !== "claude" && currentId && !isPseudoProvider(currentId)
          ? section?.providers?.[currentId]
          : undefined;
      const configured = currentRaw
        ? providerModel(engine.id as EngineId, currentRaw).trim()
        : "";
      const providerModels = configured ? [configured] : [];
      const current = models[engine.id]?.trim();
      const catalog = catalogs[engine.id]?.models ?? [];
      // Channel model leads (it is what the CLI would run unprompted), the
      // backend catalog follows, then engine-level custom models, and the
      // current-override append last so the selection never vanishes.
      const known = [
        ...new Set([
          ...providerModels,
          ...catalog.map((m) => m.id),
          ...(customModels[engine.id] ?? []),
          ...(current ? [current] : []),
        ]),
      ];
      const byId = new Map(catalog.map((m) => [m.id, m]));
      result[engine.id] = known.map((m) => {
        const entry = byId.get(m);
        return {
          id: m,
          label: entry?.name || m,
          description: entry?.description ?? undefined,
          // Channel/override ids keep the "provider/model" shape, so the
          // prefix stands in when the catalog doesn't name the provider.
          provider: entry?.provider ?? (m.includes("/") ? m.slice(0, m.indexOf("/")) : undefined),
        };
      });
    }
    return result;
  }, [engines, cliConfig, catalogs, models, customModels]);
  // Selectable ids WITHOUT the current-override append: what the channel,
  // the backend catalog, and the custom model list can actually serve.
  const knownIdsByEngine = useMemo(() => {
    const result: Record<string, Set<string>> = {};
    for (const engine of engines) {
      const section = cliConfig?.[engine.id as EngineId];
      const currentId = section?.current ?? "";
      const currentRaw =
        engine.id !== "claude" && currentId && !isPseudoProvider(currentId)
          ? section?.providers?.[currentId]
          : undefined;
      const configured = currentRaw
        ? providerModel(engine.id as EngineId, currentRaw).trim()
        : "";
      const ids = new Set((catalogs[engine.id]?.models ?? []).map((m) => m.id));
      if (configured) ids.add(configured);
      // Custom ids stay selectable past the authoritative-catalog reset.
      for (const id of customModels[engine.id] ?? []) ids.add(id);
      result[engine.id] = ids;
    }
    return result;
  }, [engines, cliConfig, catalogs, customModels]);
  // No "default" pseudo entry: an unset selection would hide which model
  // actually runs. Pin it to the first entry — the CLI's effective default.
  // An authoritative catalog also invalidates stale stored picks (leftovers
  // from older, broader catalogs) that the CLI's model flag cannot resolve.
  // All engines' pins are computed first and written in ONE store action:
  // per-engine setModel would mean one settings persist round-trip each.
  useEffect(() => {
    const updates: Record<string, string> = {};
    for (const engine of engines) {
      const first = modelsByEngine[engine.id]?.[0];
      if (!first) continue;
      const stored = models[engine.id]?.trim();
      if (!stored) {
        updates[engine.id] = first.id;
        continue;
      }
      const catalog = catalogs[engine.id];
      if (
        catalog?.authoritative &&
        catalog.models.length > 0 &&
        !knownIdsByEngine[engine.id]?.has(stored)
      ) {
        updates[engine.id] = first.id;
      }
    }
    if (Object.keys(updates).length > 0) void pinModels(updates);
  }, [engines, models, modelsByEngine, catalogs, knownIdsByEngine, pinModels]);

  // Manual refresh from the flyout: re-read provider configs and re-probe
  // every engine's catalog (the mount effect skips engines already probed,
  // so settings edits otherwise only land after an app restart).
  const refresh = useCallback(async () => {
    await ipc.getCliConfig().then(setCliConfig).catch(() => {});
    await Promise.all(
      engines.map(async (engine) => {
        try {
          const list = await ipc.listEngineModels(engine.id);
          setCatalogs((prev) => ({ ...prev, [engine.id]: list }));
        } catch {
          // A failed probe keeps the stale catalog rather than blanking the
          // flyout.
        }
      }),
    );
  }, [engines]);

  return { catalogs, modelsByEngine, refresh, pendingEngines: pending };
}
