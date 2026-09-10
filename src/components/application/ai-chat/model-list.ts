import type { ModelOption } from "./cli-menu";

/** Model rows bucketed by provider, first-appearance order. */
export interface ModelGroup {
  /** Provider id, "" for rows with no provider. */
  key: string;
  rows: ModelOption[];
}

/**
 * Bucket rows by provider. Returns a single keyless group when fewer than two
 * providers are present — layering only earns its headers when it actually
 * separates sources, and a keyless group is what tells the list to name each
 * row's provider instead.
 */
export function groupModelsByProvider(models: ModelOption[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const byKey = new Map<string, ModelGroup>();
  for (const model of models) {
    const key = model.provider ?? "";
    let group = byKey.get(key);
    if (!group) {
      group = { key, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(model);
  }
  const labeled = groups.filter((g) => g.key !== "");
  return labeled.length > 1 ? groups : [{ key: "", rows: models }];
}

/**
 * Case-insensitive label/id/description/provider match; an empty query passes
 * the catalog through untouched (identity, so memoized groups stay stable).
 * Provider is part of the match because several relays serve the same model
 * id — typing the channel is how you narrow to one of them.
 */
export function filterModels(
  models: ModelOption[],
  normalizedQuery: string,
): ModelOption[] {
  if (!normalizedQuery) return models;
  return models.filter(
    (m) =>
      m.label.toLowerCase().includes(normalizedQuery) ||
      m.id.toLowerCase().includes(normalizedQuery) ||
      (m.description ?? "").toLowerCase().includes(normalizedQuery) ||
      (m.provider ?? "").toLowerCase().includes(normalizedQuery),
  );
}
