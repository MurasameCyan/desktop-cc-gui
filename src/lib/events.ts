import { listen } from "./transport";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface EngineEventPayload {
  runId: string;
  sessionId: string | null;
  engine: string;
  seq: number;
  kind:
    | "delta"
    | "thinking"
    | "message"
    | "session"
    | "usage"
    | "error"
    | "warn"
    | "permission_denied"
    | "done"
    | "model";
  data: unknown;
}

/** Batched engine events arrive as an array under a single event name. */
export function listenEngineEvents(
  cb: (events: EngineEventPayload[]) => void,
): Promise<UnlistenFn> {
  return listen<EngineEventPayload[]>("engine://event", (e) => cb(e.payload));
}

export function listenSessionsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("sessions://changed", () => cb());
}

/** Fired after a turn lands in the usage ledger; the page re-reads on it. */
export function listenUsageChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("usage://changed", () => cb());
}
export interface ScanProgress {
  done: number;
  total: number;
  /** True on the last event of a scan run. */
  finished: boolean;
}

/** App settings were persisted (any page, any surface). */
export function listenSettingsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("settings://changed", () => cb());
}

/** History-scan progress, throttled by the scanner (~50 updates per run). */
export function listenScanProgress(cb: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (e) => cb(e.payload));
}
export interface PluginInstallProgress {
  done: number;
  total: number;
  /** True on the last event of an install run. */
  finished: boolean;
}

/** Plugin-install copy progress, throttled by the backend (~50 updates per run). */
export function listenPluginInstallProgress(
  cb: (p: PluginInstallProgress) => void,
): Promise<UnlistenFn> {
  return listen<PluginInstallProgress>("plugin://install-progress", (e) => cb(e.payload));
}
export interface TerminalOutputPayload {
  id: string;
  data: string;
}

/** Batched PTY output: arrays of chunks flushed at 32ms / 64KB by the sink. */
export function listenTerminalOutput(
  cb: (chunks: TerminalOutputPayload[]) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputPayload[]>("terminal://output", (e) => cb(e.payload));
}
export interface CliUpdateProgress {
  /** Scopes events to one confirmed run; other runs are ignored. */
  runId: string;
  engine: string;
  phase: "started" | "stdout" | "stderr" | "finished";
  /** Output line for stdout/stderr phases (clipped to 1000 chars). */
  line: string | null;
  /** Exit status on the finished phase. */
  exitOk: boolean | null;
}

/** One-click CLI install/update progress: batched arrays, 32ms / 64KB. */
export function listenCliUpdateProgress(
  cb: (events: CliUpdateProgress[]) => void,
): Promise<UnlistenFn> {
  return listen<CliUpdateProgress[]>("cli://update-progress", (e) => cb(e.payload));
}
