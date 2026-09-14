import type { PromptContribution } from "@ccgui/plugin-sdk";

/** Remembered internal contributions the host promises to keep contributing:
 *  scope -> contribution id -> latest contribution of that id. */
export type SessionContributions = Record<string, Record<string, PromptContribution>>;

/** Capacity bounds: ids kept per scope, scopes kept overall (oldest evicted). */
const PER_SCOPE_LIMIT = 32;
const SCOPE_LIMIT = 64;

/** Scope of remembered session-scoped contributions: the native session when
 * known, otherwise the not-yet-created session of one engine+workspace. */
export function sessionContributionScope(
  engine: string,
  sessionId: string | null,
  workspacePath: string,
): string {
  return sessionId ? `${engine}/${sessionId}` : `pending:${engine}:${workspacePath}`;
}

/** Remembered session contributions first, then this turn's; a fresh
 * contribution with the same id wins. */
export function mergeSessionContributions(
  remembered: Record<string, PromptContribution> | undefined,
  fresh: PromptContribution[],
): PromptContribution[] {
  if (!remembered) return fresh;
  const byId = new Map<string, PromptContribution>();
  for (const contribution of Object.values(remembered)) byId.set(contribution.id, contribution);
  for (const contribution of fresh) byId.set(contribution.id, contribution);
  return [...byId.values()];
}

/** Fold this turn's `persistence:"session"` contributions into their scope,
 * keyed by id (latest wins), evicting the oldest ids and scopes past capacity.
 * Pure: the next map, or null when this turn contributed nothing to remember. */
export function rememberSessionContributions(
  all: SessionContributions,
  scope: string,
  fresh: PromptContribution[],
): SessionContributions | null {
  const sessionScoped = fresh.filter((contribution) => contribution.persistence === "session");
  if (sessionScoped.length === 0) return null;
  const current = { ...(all[scope] ?? {}) };
  for (const contribution of sessionScoped) current[contribution.id] = contribution;
  const ids = Object.keys(current);
  if (ids.length > PER_SCOPE_LIMIT) {
    for (const id of ids.slice(0, ids.length - PER_SCOPE_LIMIT)) delete current[id];
  }
  const next = { ...all, [scope]: current };
  const scopes = Object.keys(next);
  if (scopes.length > SCOPE_LIMIT) {
    for (const old of scopes.slice(0, scopes.length - SCOPE_LIMIT)) delete next[old];
  }
  return next;
}

/** A pending tab just adopted its native id: carry the remembered session
 * contributions from the placeholder scope onto the real one, the real
 * scope's own entries winning. Pure: the next map, or null when nothing was
 * pending under that engine+workspace. */
export function migrateSessionContributions(
  all: SessionContributions,
  engine: string,
  workspacePath: string,
  sessionId: string,
): SessionContributions | null {
  const from = sessionContributionScope(engine, null, workspacePath);
  const pending = all[from];
  if (!pending) return null;
  const to = sessionContributionScope(engine, sessionId, workspacePath);
  const next = { ...all, [to]: { ...(all[to] ?? {}), ...pending } };
  delete next[from];
  return next;
}

/** Drop a scope's remembered contributions (tab closed, session deleted).
 * Pure: the next map, or null when the scope held nothing. */
export function forgetSessionContributions(
  all: SessionContributions,
  engine: string,
  sessionId: string | null,
  workspacePath: string,
): SessionContributions | null {
  const scope = sessionContributionScope(engine, sessionId, workspacePath);
  if (!(scope in all)) return null;
  const next = { ...all };
  delete next[scope];
  return next;
}
