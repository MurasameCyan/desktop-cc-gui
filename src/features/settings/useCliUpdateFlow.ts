import { useCallback, useEffect, useRef, useState } from "react";
import { listenCliUpdateProgress } from "@/lib/events";
import { ipc, type CliUpdatePlan } from "@/lib/ipc";
import type { EngineId } from "./providers";
import { useCliVersionStatus } from "./useCliVersionStatus";

/**
 * One-click CLI install/update flow behind the confirm dialog:
 * idle → planning → ready → running → done | error. `begin` asks the
 * backend for the exact execution plan (command preview + manual
 * fallback); `confirm` stamps a runId, subscribes to the streamed
 * `cli://update-progress` events for that run, and drives the shared
 * version store's update (which keeps the header pill on 更新中… and
 * re-probes the version afterwards).
 *
 * The listener only exists while a run is active — idle settings pages
 * pay nothing.
 */

export type CliUpdateFlowStatus = "idle" | "planning" | "ready" | "running" | "done" | "error";

export interface CliUpdateLogLine {
  stream: "stdout" | "stderr";
  text: string;
}

/** Older lines are dropped so a chatty installer can't grow memory. */
const MAX_LOG_LINES = 200;

export interface CliUpdateFlowState {
  status: CliUpdateFlowStatus;
  plan: CliUpdatePlan | null;
  error: string | null;
  runId: string | null;
  logs: CliUpdateLogLine[];
}

const IDLE: CliUpdateFlowState = { status: "idle", plan: null, error: null, runId: null, logs: [] };

export interface CliUpdateFlow {
  state: CliUpdateFlowState;
  /** Open the dialog and fetch the execution plan. */
  begin: () => Promise<void>;
  /** Run the planned command, streaming output into the dialog. */
  confirm: () => Promise<void>;
  /** Close the dialog (a no-op while a run is active). */
  close: () => void;
}

export function useCliUpdateFlow(
  engine: EngineId,
  callbacks?: { onSuccess?: () => void; onError?: (message: string) => void },
): CliUpdateFlow {
  const { update } = useCliVersionStatus(engine);
  const [state, setState] = useState<CliUpdateFlowState>(IDLE);
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  // Subscribe only for the duration of a run; events carry the runId, so a
  // stale/other-engine run can never leak lines into this dialog.
  const running = state.status === "running";
  useEffect(() => {
    if (!running) return;
    let unlisten: (() => void) | null = null;
    void listenCliUpdateProgress((events) => {
      setState((cur) => {
        if (cur.runId === null) return cur;
        let logs = cur.logs;
        for (const event of events) {
          if (event.runId !== cur.runId) continue;
          if (event.phase === "stdout" || event.phase === "stderr") {
            logs = [...logs, { stream: event.phase, text: event.line ?? "" }];
          }
        }
        if (logs === cur.logs) return cur;
        if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
        return { ...cur, logs };
      });
    }).then((f) => {
      unlisten = f;
    });
    return () => unlisten?.();
  }, [running]);

  const begin = useCallback(async () => {
    setState({ ...IDLE, status: "planning" });
    try {
      const plan = await ipc.cliUpdatePlan(engine);
      setState({ ...IDLE, status: "ready", plan });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ ...IDLE, status: "error", error: message });
      callbacksRef.current?.onError?.(message);
    }
  }, [engine]);

  const confirm = useCallback(async () => {
    const runId = `${engine}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setState((cur) => ({ ...cur, status: "running", runId, logs: [], error: null }));
    try {
      await update(runId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState((cur) => (cur.runId === runId ? { ...cur, status: "error", error: message } : cur));
      callbacksRef.current?.onError?.(message);
      return;
    }
    setState((cur) => (cur.runId === runId ? { ...cur, status: "done" } : cur));
    callbacksRef.current?.onSuccess?.();
  }, [engine, update]);

  const close = useCallback(() => {
    setState((cur) => (cur.status === "running" ? cur : IDLE));
  }, []);

  return { state, begin, confirm, close };
}
