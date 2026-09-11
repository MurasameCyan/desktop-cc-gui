import type {
  EngineInfo,
  Message,
  SessionMeta,
  WorkspaceGroup,
} from "@/lib/ipc";
import { EMPTY_SESSION, type SessionState } from "./stream";
import type { ChatStore } from "./types";

/** Sidebar workspace groups (工作区二级分类), ordered by sortOrder then name. */
export function sortedWorkspaceGroups(
  groups: WorkspaceGroup[],
): WorkspaceGroup[] {
  return groups.slice().sort((a, b) => {
    const diff =
      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}

/** History lists hide sessions of CLIs the user disabled in settings. An
 * empty engines list means listEngines failed — keep sessions rather than
 * blanking the sidebar. */
export function visibleSessions(
  sessions: SessionMeta[],
  engines: EngineInfo[],
): SessionMeta[] {
  if (engines.length === 0) return sessions;
  const enabled = new Set<string>();
  for (const e of engines) {
    if (e.enabled) enabled.add(e.id);
  }
  return sessions.filter((s) => enabled.has(s.engine));
}

/** Append committed timeline rows, assigning seq after the session's last
 * row; `patch` carries any extra per-site session changes. */
export function appendCommittedRows(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  rows: Omit<Message, "seq">[],
  patch: Partial<SessionState> = {},
) {
  set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const lastSeq = prev.messages.length
      ? prev.messages[prev.messages.length - 1].seq
      : 0;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...prev,
          ...patch,
          messages: [
            ...prev.messages,
            ...rows.map((row, i) => ({ ...row, seq: lastSeq + 1 + i })),
          ],
        },
      },
    };
  });
}
