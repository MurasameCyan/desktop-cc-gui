// Transport picks Tauri IPC natively and the web-access WS bridge in browsers.
import { invoke } from "./transport";
import { withGrantRetry } from "./grant";

// ==================== Shared types (mirror Rust serde camelCase) ====================

export interface SessionMeta {
  engine: string;
  sessionId: string;
  workspacePath: string;
  filePath: string;
  fileSize: number;
  fileMtimeMs: number;
  title: string;
  preview: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  pinned: boolean;
  customTitle: string | null;
}

export type TodoStatus = "pending" | "active" | "complete" | "blocked" | "dropped";

export interface TodoItem {
  id?: string | null;
  content: string;
  status: TodoStatus;
}

/** Todo-list payload on todo-class tool rows: replace = full snapshot,
 * otherwise a patch matched by content (status "dropped" removes). */
export interface TodosPayload {
  items: TodoItem[];
  replace: boolean;
}

export interface Message {
  seq: number;
  role: string; // "user" | "assistant" | "tool" | "thinking"
  text: string;
  /** Target file of a tool call (read/edit/write/...); renders as a file chip. */
  path?: string | null;
  /** Full tool-call arguments; shown in the expandable tool-call panel. */
  args?: unknown;
  /** Tool execution result/output; shown in the tool panel. */
  result?: unknown;
  todos?: TodosPayload;
  ts: string | null;
  usage?: unknown;
  model?: string | null;
  /** Reasoning effort level ("low" | "medium" | "high" | "xhigh" | "max" | "ultra") */
  effort?: string | null;
  /** Turn duration in milliseconds (measured from prompt send to turn completion) */
  durationMs?: number | null;
  /** True while the row belongs to the in-flight stream and may still grow. */
  live?: boolean;
  /** Permission-denial card state (role "grant"): the CLI denied a tool call
   * targeting `path`; pending until the user answers the card. `dir` is the
   * directory a grant would cover (grant_scope preview). Grant rows are
   * ephemeral UI — they are not part of the CLI's session history. */
  grant?: {
    status: "pending" | "granted" | "declined";
    dir?: string | null;
  };
  /** Image attachments: data URLs render directly, absolute paths load via readFile. */
  images?: string[];
}

export interface SessionPage {
  messages: Message[];
  nextBefore: number | null;
}

export interface Workspace {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number | null;
  sortOrder: number | null;
  /** Sidebar group id (工作区分组); null = ungrouped. */
  groupId: string | null;
}

export interface EngineInfo {
  id: string;
  available: boolean;
  /** False when the user disabled this CLI in settings — hidden from the
   * picker and history lists; running sessions are unaffected. */
  enabled: boolean;
  supportsImages: boolean;
  /** Permission modes the engine honors at spawn ("auto" | "manual" |
   * "plan" | "bypass"); the composer picker greys out the rest. */
  permissions: string[];
}
/** One entry of an engine's model catalog (`--list-models` probe). */
export interface EngineModel {
  /** Selector passed to `--model` ("provider/model"). */
  id: string;
  /** Display name when the catalog carries one. */
  name?: string | null;
  /** Secondary line under the name (e.g. "Custom Opus model"). */
  description?: string | null;
  provider: string;
  /** Context window tokens when the catalog reports one. */
  contextWindow?: number | null;
}

/** An engine's model catalog plus how much trust the list deserves. */
export interface EngineCatalog {
  models: EngineModel[];
  /**
   * True when `models` is exactly what the CLI's model flag resolves
   * (config/registry/binary-derived): a stored pick outside it cannot
   * run and should reset to the leading entry. False for relay-probed
   * lists (claude), which may be partial.
   */
  authoritative: boolean;
}

export interface SendResult {
  runId: string;
  sessionId: string | null;
}

export interface ProviderSection {
  providers: Record<string, unknown>;
  current: string | null;
  /** Provider parked when the engine was disabled via the enable switch. */
  disabledFrom?: string | null;
}
export interface CcSwitchStatus {
  installed: boolean;
  changed: boolean;
  providers: number;
  hash: string;
  modifiedMs: number;
}

export interface CcSwitchImportResult {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
}
/** Result of `fetch_provider_models`: model ids plus the candidate URL that
 *  answered (a derivation of the channel's base URL). */
export interface ProviderModelList {
  models: string[];
  endpoint: string;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  sortOrder?: number | null;
  /** Legacy "clone copies" folder, preserved on import round-trips. */
  copiesFolder?: string | null;
}

export interface CliConfig {
  claude: ProviderSection;
  kimi: ProviderSection;
  grok: ProviderSection;
  codex: ProviderSection;
  pi: ProviderSection;
  omp: ProviderSection;
  dsh: ProviderSection;
}

export interface AppSettings {
  theme: string;
  /** Sidebar workspace groups (工作区二级分类), ordered by sortOrder then name.
   *  The assignment lives on each workspace (`Workspace.groupId`). */
  workspaceGroups: WorkspaceGroup[];
  /** Workspace id -> sidebar display alias; absent = show the folder name. */
  workspaceAliases: Record<string, string>;
  /** Ids of workspaces hidden into the sidebar's collapsible 已归档 section. */
  archivedWorkspaces: string[];
  language: string;
  claudeBin: string | null;
  kimiBin: string | null;
  grokBin: string | null;
  codexBin: string | null;
  piBin: string | null;
  ompBin: string | null;
  dshBin: string | null;
  defaultModels: Record<string, string>;
  defaultEfforts: Record<string, string>;
  ompOpenaiServiceTier?: "default" | "priority" | null;
  /** Codex Fast override; null preserves ~/.codex/config.toml. */
  codexServiceTier?: "default" | "priority" | null;
  /** Max sessions listed per workspace in the sidebar (default 5). */
  sidebarThreadLimit: number;
  /** Composer send gesture: "enter" (Enter sends) or "cmdEnter" (⌘/Ctrl+Enter sends). */
  composerSendShortcut: string;
  /** Terminal shell override; null/empty = auto-detect. */
  terminalShellPath: string | null;
  /** DSH host address (default "127.0.0.1"). */
  dshHost?: string | null;
  /** DSH host port (default 3080). */
  dshPort?: number | null;

  /** Auto-adopt-or-spawn the DSH host on app start (default true). */
  dshAutoStart?: boolean | null;
  /** Global network proxy switch; spawned children inherit the proxy env. */
  systemProxyEnabled: boolean;
  /** Proxy URL (http/https/socks5); null = unset. */
  systemProxyUrl: string | null;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileContent {
  kind: "text" | "image" | "binary";
  text: string | null;
  dataUrl: string | null;
  truncated: boolean;
}
/** Result of `duplicate_item` / `paste_item`: the created destination. */
export interface FileOpResult {
  path: string;
  isDir: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}
/** One entry of the workspace file index (`list_file_index`). */
export interface FileIndexEntry {
  /** Workspace-relative path, "/" separators. */
  rel: string;
  isDir: boolean;
}

/** A custom slash command from `.claude/commands` (`list_slash_commands`):
 *  workspace commands shadow global ones of the same name. */
export interface SlashCommandEntry {
  /** Slash-less name; directory segments join with `:` ("aimax:plan"). */
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  /** "workspace" (project `.claude/commands`) or "global" (CLI home). */
  source: string;
}

export interface GitFileEntry {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface GitStatus {
  branch: string;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
}

/** Compact status for a directory that is itself a Git worktree root. */
export interface RepositorySummary {
  path: string;
  branch: string;
  changed: number;
  untracked: number;
}

/** Per-entry git state for one loaded tree level. `repository` marks an
 *  exact repo-root directory (blue name); plain folders never carry color. */
export type FileTreeColor = "modified" | "untracked" | "repository";

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
}
export interface AppMetrics {
  /** Resident memory of the app process, bytes. */
  memoryBytes: number;
  /** CPU usage since the previous poll, percent of one core. */
  cpuPercent: number;
}
export interface WebAccessInfo {
  /** Full URL including the auth token — shareable as-is or as a QR code. */
  url: string;
  port: number;
  token: string;
  lanIp: string;
}

/** One finished turn as it enters the usage ledger. */
export interface UsageEntryInput {
  /** Epoch ms when the turn settled. */
  ts: number;
  engine: string;
  model: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  durationMs: number | null;
}

/** Ledger totals for one (local day, engine, model) bucket. */
export interface UsageRow {
  /** Local "YYYY-MM-DD". */
  day: string;
  engine: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
}
// ---- DeepSeek Harness local host ----

/** Snapshot of the DSH local host + CLI probe (`dsh_host_status`,
 *  `dsh_host_start`). Never spawns on its own; `dsh_host_start` does. */
export interface DshHostStatus {
  installed: boolean;
  version: string | null;
  host: string;
  port: number;
  origin: string;
  autoStart: boolean;
  running: boolean;
  /** "spawned" = we launched it (and will kill it); "adopted" = pre-existing
   *  listener we attached to and never kill implicitly. */
  ownership: "spawned" | "adopted" | null;
  /** Raw host.describe value (provider/model/attachedSessions/…). */
  describe: {
    provider?: string | null;
    model?: string | null;
    attachedSessions?: number | null;
    version?: string | null;
  } | null;
  /** Probe error, set only when the host is down. */
  error: string | null;
}

/** Managed-CLI local version + npm registry latest (`cli_version_status`). */
export interface CliVersionStatus {
  engine: string;
  installed: boolean;
  localVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** How install/update acts: "npm" | "native"; null = no action (grok). */
  updateKind: "npm" | "native" | null;
}
/** Confirm-dialog execution plan for a one-click install/update. */
export interface CliUpdatePlan {
  engine: string;
  action: "install" | "update";
  /** "npm" | "native" | "none". */
  kind: string;
  /** Exact argv that will execute. */
  command: string[];
  /** Copy-paste fallback for a manual run. */
  manualCommand: string;
  canRun: boolean;
  blockers: string[];
  platform: string;
}

// ==================== Typed invoke wrappers ====================
// Shared in-flight/cached app-settings promise: startup, the settings page
// and the chat store all read the same settings, so fetch once.
let settingsPromise: Promise<AppSettings> | null = null;
// ---- pi-family (pi/omp) provider auth & custom providers (供应商认证) ----

export type PiFamilyAuthState = "configured" | "none";
export type PiFamilyKeySource = "literal" | "command" | "envRef";

export interface PiFamilyAuthProviderSnapshot {
  id: string;
  envVar: string | null;
  state: PiFamilyAuthState;
  maskedKey?: string;
  keySource?: PiFamilyKeySource;
}

export interface PiFamilyAuthListResult {
  store: { path: string; kind: "authJson" | "sqlite"; exists: boolean };
  providers: PiFamilyAuthProviderSnapshot[];
  /** Provider ids holding an active OAuth credential (raw store ids — pi
   * lands ChatGPT subscription logins under `openai-codex`). */
  oauthProviders: string[];
}

export interface PiFamilyCustomProviderSummary {
  id: string;
  name: string | null;
  baseUrl: string | null;
  api: string | null;
  modelCount: number;
  hasApiKey: boolean;
}

export interface PiFamilyModelsConfigReadResult {
  file: { path: string; format: "json" | "yaml"; exists: boolean };
  text: string | null;
  template: string;
  providers: PiFamilyCustomProviderSummary[];
  parseError: string | null;
}

// ==================== Plugins (Phase 1 runtime, plan §4.3) ====================

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  tier: "declarative" | "js";
  source: "marketplace" | "local" | "ai" | "builtin";
  enabled: boolean;
  quarantined: boolean;
  lastError: string | null;
  permissions: string[];
  installedAt: number;
  minAppVersion: string | null;
}

export const ipc = {
  // config
  getCliConfig: () => invoke<CliConfig>("get_cli_config"),
  upsertProvider: (engine: string, id: string, json: unknown) =>
    invoke<void>("upsert_provider", { engine, id, json }),
  deleteProvider: (engine: string, id: string) =>
    invoke<void>("delete_provider", { engine, id }),
  setCurrentProvider: (engine: string, id: string) =>
    invoke<void>("set_current_provider", { engine, id }),
  /** Native config files a channel switch would overwrite (shown in the
   *  switch confirmation); empty for display-only engines. */
  providerFilePaths: (engine: string) =>
    invoke<string[]>("provider_file_paths", { engine }),
  reorderProviders: (engine: string, ids: string[]) =>
    invoke<void>("reorder_providers", { engine, ids }),
  setEngineEnabled: (engine: string, enabled: boolean) =>
    invoke<void>("set_engine_enabled", { engine, enabled }),
  // pi/omp provider auth (auth.json for pi, agent.db auth_credentials for omp)
  piFamilyAuthList: (engine: string) =>
    invoke<PiFamilyAuthListResult>("pi_family_auth_list", { engine }),
  piFamilyAuthSetApiKey: (engine: string, providerId: string, key: string) =>
    invoke<void>("pi_family_auth_set_api_key", { engine, providerId, key }),
  piFamilyAuthDeleteCredential: (engine: string, providerId: string) =>
    invoke<void>("pi_family_auth_delete_credential", { engine, providerId }),
  // pi/omp custom providers (models.json for pi, models.yml for omp)
  piFamilyModelsConfigRead: (engine: string) =>
    invoke<PiFamilyModelsConfigReadResult>("pi_family_models_config_read", { engine }),
  piFamilyModelsConfigWrite: (engine: string, text: string) =>
    invoke<void>("pi_family_models_config_write", { engine, text }),
  // cc-switch interop
  checkCcSwitch: () => invoke<CcSwitchStatus>("check_cc_switch"),
  dismissCcSwitch: (hash: string) => invoke<void>("dismiss_cc_switch", { hash }),
  importCcSwitch: (engine: string) =>
    invoke<CcSwitchImportResult>("import_cc_switch", { engine }),
  importCcSwitchFromPath: (path: string, engine: string) =>
    invoke<CcSwitchImportResult>("import_cc_switch_from_path", { path, engine }),
  /** 拉取模型: probe the channel's /v1/models endpoint for its model list. */
  fetchProviderModels: (baseUrl: string, apiKey: string) =>
    invoke<ProviderModelList>("fetch_provider_models", { baseUrl, apiKey }),
  // settings
  getAppSettings: () =>
    (settingsPromise ??= invoke<AppSettings>("get_app_settings").catch((e) => {
      // Allow retry after a failed fetch instead of caching the rejection.
      settingsPromise = null;
      throw e;
    })),
  updateAppSettings: async (settings: AppSettings) => {
    await invoke<void>("update_app_settings", { settings });
    // Keep the cache in sync with the authoritative value just persisted.
    settingsPromise = Promise.resolve(settings);
  },
  // engine
  sendMessage: (args: {
    engine: string;
    workspacePath: string;
    sessionId: string | null;
    prompt: string;
    imagePaths: string[] | null;
    model: string | null;
    effort: string | null;
    permission: string | null;
  }) => invoke<SendResult>("send_message", args),
  interruptSession: (sessionId: string) =>
    invoke<boolean>("interrupt_session", { sessionId }),
  listEngines: () => invoke<EngineInfo[]>("list_engines"),
  /** Persist a clipboard image to app home; returns its absolute path so it
   * can flow through the same path-based image pipeline as picked files. */
  savePastedImage: (dataBase64: string, extension: string) =>
    invoke<string>("save_pasted_image", { dataBase64, extension }),
  /** Copy explicitly user-picked files into the app sandbox and return the
   * new paths (same order). Picked paths live outside the sandbox, so the
   * engines' path-based image pipeline cannot read them in place. */
  importAttachments: (paths: string[]) => invoke<string[]>("import_attachments", { paths }),
  listEngineModels: (engine: string) =>
    invoke<EngineCatalog>("list_engine_models", { engine }),
  // history
  listSessions: () => invoke<SessionMeta[]>("list_sessions"),
  loadSessionPage: (
    engine: string,
    sessionId: string,
    limit?: number,
    beforeSeq?: number | null,
  ) => invoke<SessionPage>("load_session_page", { engine, sessionId, limit, beforeSeq }),
  deleteSession: (engine: string, sessionId: string) =>
    invoke<void>("delete_session", { engine, sessionId }),
  pinSession: (engine: string, sessionId: string, pinned: boolean) =>
    invoke<void>("pin_session", { engine, sessionId, pinned }),
  renameSession: (engine: string, sessionId: string, title: string) =>
    invoke<void>("rename_session", { engine, sessionId, title }),
  rescanSessions: () => invoke<void>("rescan_sessions"),
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  addWorkspace: (path: string) => invoke<Workspace>("add_workspace", { path }),
  reorderWorkspaces: (ids: string[]) => invoke<void>("reorder_workspaces", { ids }),
  removeWorkspace: (id: string) => invoke<void>("remove_workspace", { id }),
  setWorkspaceGroup: (id: string, groupId: string | null) =>
    invoke<void>("set_workspace_group", { id, groupId }),
  // terminal
  /** Idempotent: re-opening a live session id is a no-op on the backend. */
  terminalOpen: (args: { id: string; cwd: string; cols: number; rows: number }) =>
    invoke<void>("terminal_open", args),
  terminalWrite: (id: string, data: string) =>
    invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  /** No-op when the session is already gone. */
  terminalClose: (id: string) => invoke<void>("terminal_close", { id }),
  // files — every command goes through withGrantRetry so an outside-roots
  // rejection becomes a one-click grant prompt + retry (see lib/grant.ts).
  listDir: (path: string) => withGrantRetry(() => invoke<DirEntry[]>("list_dir", { path })),
  readFile: (path: string) => withGrantRetry(() => invoke<FileContent>("read_file", { path })),
  writeFile: (path: string, content: string) =>
    withGrantRetry(() => invoke<void>("write_file", { path, content })),
  createDir: (path: string) => withGrantRetry(() => invoke<void>("create_dir", { path })),
  /** Fails when the file already exists (unlike write_file, which overwrites). */
  createFile: (path: string) => withGrantRetry(() => invoke<void>("create_file", { path })),
  renameItem: (from: string, to: string) =>
    withGrantRetry(() => invoke<void>("rename_item", { from, to })),
  trashItem: (path: string) => withGrantRetry(() => invoke<void>("trash_item", { path })),
  duplicateItem: (path: string) =>
    withGrantRetry(() => invoke<FileOpResult>("duplicate_item", { path })),
  pasteItem: (source: string, targetDir: string) =>
    withGrantRetry(() => invoke<FileOpResult>("paste_item", { source, targetDir })),
  searchText: (path: string, query: string) =>
    withGrantRetry(() => invoke<SearchHit[]>("search_text", { path, query })),
  /** Whole-tree file index for the composer @-mention picker (relative
   * paths; backend caps at 20k entries). */
  listFileIndex: (path: string) =>
    withGrantRetry(() => invoke<FileIndexEntry[]>("list_file_index", { path })),
  /** Custom slash commands for the composer `/` picker (workspace
   *  `.claude/commands` + the CLI's global commands dir). */
  listSlashCommands: (path: string) =>
    withGrantRetry(() => invoke<SlashCommandEntry[]>("list_slash_commands", { path })),
  // granted directories (desktop-only commands; the settings list hides on web)
  listGrantedRoots: () => invoke<string[]>("list_granted_roots"),
  /** Directory a grant for `path` would cover (path itself when a dir, else
   * its parent) — the grant card shows this before the user approves. */
  grantScope: (path: string) => invoke<string>("grant_scope", { path }),
  /** Persist a user-approved directory grant; subsequent claude launches
   * receive it as --add-dir. */
  grantRoot: (path: string) => invoke<void>("grant_root", { path }),
  revokeGrantedRoot: (path: string) => invoke<void>("revoke_granted_root", { path }),
  // git
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitRepositorySummaries: (paths: string[]) =>
    invoke<RepositorySummary[]>("git_repository_summaries", { paths }),
  gitFileColors: (path: string, files: string[]) =>
    invoke<Record<string, FileTreeColor>>("git_file_colors", { path, files }),
  gitDiff: (path: string, file: string, staged: boolean) =>
    invoke<string>("git_diff", { path, file, staged }),
  gitStage: (path: string, files: string[]) => invoke<void>("git_stage", { path, files }),
  gitUnstage: (path: string, files: string[]) =>
    invoke<void>("git_unstage", { path, files }),
  gitCommit: (path: string, message: string) =>
    invoke<string>("git_commit", { path, message }),
  gitPush: (path: string) => invoke<void>("git_push", { path }),
  gitPull: (path: string) => invoke<void>("git_pull", { path }),
  gitBranches: (path: string) => invoke<BranchInfo[]>("git_branches", { path }),
  gitCheckout: (path: string, branch: string) =>
    invoke<void>("git_checkout", { path, branch }),
  gitCreateBranch: (path: string, name: string) =>
    invoke<void>("git_create_branch", { path, name }),
  // open-app
  openWorkspaceIn: (path: string, options: { appName: string; args?: string[] }) =>
    invoke<void>("open_workspace_in", { path, app: options.appName, args: options.args ?? [] }),
  revealInFileManager: (path: string) =>
    invoke<void>("reveal_in_file_manager", { path }),
  // metrics
  appMetrics: () => invoke<AppMetrics>("app_metrics"),
  // plugins
  pluginList: () => invoke<PluginInfo[]>("plugin_list"),
  pluginInstallFromPath: (path: string) =>
    invoke<PluginInfo>("plugin_install_from_path", { path }),
  pluginUninstall: (id: string, deleteData: boolean) =>
    invoke<void>("plugin_uninstall", { id, deleteData }),
  pluginSetEnabled: (id: string, enabled: boolean) =>
    invoke<PluginInfo>("plugin_set_enabled", { id, enabled }),
  pluginQuarantine: (id: string, error: string) =>
    invoke<PluginInfo>("plugin_quarantine", { id, error }),
  pluginReadFile: (id: string, name: string) =>
    invoke<string>("plugin_read_file", { id, name }),
  pluginStorageGet: (id: string, key: string) =>
    invoke<unknown>("plugin_storage_get", { id, key }),
  pluginStorageSet: (id: string, key: string, value: unknown) =>
    invoke<void>("plugin_storage_set", { id, key, value }),
  pluginStorageDelete: (id: string, key: string) =>
    invoke<void>("plugin_storage_delete", { id, key }),
  // web access (start/stop are desktop-only; the bridge answers status too)
  webAccessStart: () => invoke<WebAccessInfo>("web_access_start"),
  webAccessStop: () => invoke<void>("web_access_stop"),
  webAccessStatus: () => invoke<WebAccessInfo | null>("web_access_status"),
  // usage ledger (settings 用量)
  usageRecord: (entry: UsageEntryInput) => invoke<void>("usage_record", { entry }),
  usageSummary: (days: number, tzOffsetMinutes: number) =>
    invoke<UsageRow[]>("usage_summary", { days, tzOffsetMinutes }),
  usageClear: () => invoke<void>("usage_clear"),
  // DeepSeek Harness local host (dsh web --host H --port P)
  dshHostStatus: () => invoke<DshHostStatus>("dsh_host_status"),
  dshHostStart: () => invoke<DshHostStatus>("dsh_host_start"),
  dshHostStop: () => invoke<{ ok: boolean }>("dsh_host_stop"),
  // managed-CLI lifecycle (CLI 管理 header: version probe + install/update)
  cliVersionStatus: (engine: string) =>
    invoke<CliVersionStatus>("cli_version_status", { engine }),
  cliUpdatePlan: (engine: string) =>
    invoke<CliUpdatePlan>("cli_update_plan", { engine }),
  cliUpdate: (engine: string, runId: string) =>
    invoke<{ ok: boolean; version: string | null }>("cli_update", { engine, runId }),
};
