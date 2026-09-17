/**
 * @ccgui/plugin-sdk — 插件侧公共契约声明（VS Code 的 vscode.d.ts 同款模式：
 * 本文件是插件作者面对的公共 API 定义，与 src/ 同包维护、同版本发布；
 * 双向漂移由 src/contract-check.ts 在类型层面把守）。
 *
 * 插件仓用法（包未发布 npm 前的过渡方案）：复制本文件为插件仓的
 * `src/ccgui-plugin.d.ts`，首行版本戳必须与所用宿主 SDK 一致。
 *
 * @ccgui/plugin-sdk v0.4.1
 */

/** 宿主实现的 SDK 契约版本。 */
export declare const SDK_VERSION: string;

/** 每次注册的撤销句柄；卸载时逆序执行。 */
export type Disposer = () => void;

/** 信任层级（ADR-1）：declarative = 零 JS 声明式。 */
export type PluginTier = "declarative" | "js";

/** 插件入口唯一约定：main.js 默认导出本函数。 */
export type PluginActivate = (ctx: PluginContext) => void | (() => void);
/** Validates safe lowercase point-separated plugin ids: 2..=64 bytes total,
 *  each segment `[a-z0-9][a-z0-9-]*`. Byte-for-byte identical to the Rust
 *  install-time check. */
export declare function isValidPluginId(id: string): boolean;


/** 外部会话源行(ctx.sessions.registerSource,0.3.4 起):插件上报的
 *  远端/容器内会话摘要。workspacePath 必须是已登记工作区的 path,否则
 *  宿主合并时丢弃(侧栏按 workspacePath 分组)。 */
export interface ExternalSessionRow {
  engine: string;
  sessionId: string;
  workspacePath: string;
  title?: string;
  updatedAt?: number | null;
  /** 远端 jsonl 绝对路径(可选;宿主历史回放经远程通道拉取)。 */
  remotePath?: string;
}

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** ccgui.plugin.json（plan §5.1）。 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  /** SDK 兼容区间："^0.4" / "~0.4.0" / ">=0.4.0" / 精确 / "*"（缺省不校验）。 */
  sdkVersion?: string;
  author?: string;
  description?: string;
  tier: PluginTier;
  /** 基座权限与 `network:<host>[…]` / `exec:<bin>` 授权；全集、形状与放行
   *  规则以包内 spec/permissions.json 为单一事实源（TS/Rust/模板校验脚本
   *  三方消费同一文件）。`network:none` 是基座权限（声明无网络），永远
   *  不是授权——它不会放行任何主机。 */
  permissions: string[];
  contributes?: {
    themes?: { name?: string; tokens: { light?: Record<string, string>; dark?: Record<string, string> } }[];
    i18n?: { lang: string; ns?: string; resources: Record<string, unknown> }[];
    statusBarItems?: { key?: string; text: string }[];
    commands?: { key: string; title: string; emits?: string }[];
  };
  configSchema?: JsonSchemaObject;
}

export type ComposerSlotId = "addMenu" | "cliMenu" | "permissionMenu";

/** 侧栏会话右键菜单被打开时所在的会话行。 */
export interface SessionMenuTarget {
  engine: string;
  sessionId: string;
}

export type ComponentLike<P = Record<string, never>> = (props: P) => unknown;
export interface WorkspaceMetadata {
  id: string;
  path: string;
  gitBranch?: string;
  gitHead?: string;
  dirty?: boolean;
}

export interface PromptContribution {
  id: string;
  content: string;
  placement: "system-tail" | "request-tail";
  visibility: "internal";
  persistence: "turn" | "session";
  /** Called synchronously by the host exactly once after the engine accepts a
   * launch carrying this contribution. It is not called when launch fails or
   * when the byte budget rejects the contribution. Callback failures are
   * isolated and do not fail the accepted launch. */
  onAccepted?: () => void;
}

export interface InternalMessageCapture {
  channel: string;
  nonce?: string;
  maxBytes: number;
  /** Synchronous predicate the host calls on each candidate frame's parsed
   *  payload, inline while parsing. Return true to let the host hide the frame
   *  from the transcript and deliver it to the plugin; returning false (or
   *  throwing) keeps the frame visible. NOT authoritative — the payload is
   *  still untrusted, so the plugin must validate again in
   *  `onInternalMessage`. Must be synchronous: it gates visibility before the
   *  async delivery can run. */
  validate?: (payload: unknown) => boolean;
}

export interface BeforeTurnResult {
  promptContributions?: PromptContribution[];
  internalMessageCapture?: InternalMessageCapture;
  /** Pure synchronous lifetime guard, checked during collection, replay and
   * launch acceptance. False or throwing retires this result's prompts and
   * capture; a retired lifetime must never become current again. */
  isCurrent?: () => boolean;
}

interface SessionEventBase {
  engine: string;
  sessionId: string | null;
  workspace: WorkspaceMetadata;
  occurredAt: string;
}

export interface SessionCreatedEvent extends SessionEventBase {}
export interface SessionRestoredEvent extends SessionEventBase { sessionId: string }
export interface SessionClosedEvent extends SessionEventBase {}

interface TurnEventBase {
  runId: string;
  turnId: string;
  engine: string;
  sessionId: string | null;
  workspace: WorkspaceMetadata;
  occurredAt: string;
}

export interface BeforeTurnEvent extends TurnEventBase {}
export interface AfterTurnEvent extends TurnEventBase {
  status: "completed" | "cancelled" | "failed";
  error?: string;
}
export interface InternalMessageEvent extends TurnEventBase {
  channel: string;
  nonce?: string;
  payload: unknown;
}

export interface RuntimeSwitchEvent {
  sourceEngine: string;
  targetEngine: string;
  sourceSessionId: string | null;
  targetSessionId: string | null;
  workspace: WorkspaceMetadata;
  occurredAt: string;
}

interface NormalizedRuntimeEventBase {
  eventId: string;
  runId: string;
  turnId: string;
  engine: string;
  sessionId: string | null;
  workspaceId: string;
  workspacePath: string;
  occurredAt: string;
}

export interface FileChangedEvent extends NormalizedRuntimeEventBase {
  kind: "file-changed";
  path: string;
  /** `touched`（适配器可确定的最弱事实）：引擎报告了针对该路径的修改类
   *  工具调用；不断言是创建、修改还是删除。 */
  change: "created" | "modified" | "deleted" | "touched";
}
/** 引擎已发起该命令：本事件不含结果，退出码未知；结果由同一工具行的
 *  command-finished 声明。 */
export interface CommandStartedEvent extends NormalizedRuntimeEventBase {
  kind: "command-started";
  command: string;
  cwd: string;
  startedAt: string;
}
export interface CommandFinishedEvent extends NormalizedRuntimeEventBase {
  kind: "command-finished";
  command: string;
  cwd: string;
  /** 仅引擎在同一工具消息里给出结构化数字退出码时才有值；null 表示结果
   *  里没有退出码，status 随之是 unknown。 */
  exitCode: number | null;
  startedAt?: string;
  finishedAt: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
}
export interface ToolFinishedEvent extends NormalizedRuntimeEventBase {
  kind: "tool-finished";
  toolName: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
}
export interface AssistantCompletedEvent extends NormalizedRuntimeEventBase {
  kind: "assistant-completed";
}
export interface TurnCancelledEvent extends NormalizedRuntimeEventBase {
  kind: "turn-cancelled";
}
export interface TurnFailedEvent extends NormalizedRuntimeEventBase {
  kind: "turn-failed";
  error?: string;
}
export interface RuntimeExitedEvent extends NormalizedRuntimeEventBase {
  kind: "runtime-exited";
  exitCode: number | null;
}

export type NormalizedRuntimeEvent =
  | FileChangedEvent
  | CommandStartedEvent
  | CommandFinishedEvent
  | ToolFinishedEvent
  | AssistantCompletedEvent
  | TurnCancelledEvent
  | TurnFailedEvent
  | RuntimeExitedEvent;

export interface SessionHooks {
  onCreated?(event: SessionCreatedEvent): void | Promise<void>;
  onRestored?(event: SessionRestoredEvent): void | Promise<void>;
  onClosed?(event: SessionClosedEvent): void | Promise<void>;
}
export interface TurnHooks {
  beforeTurn?(event: BeforeTurnEvent): BeforeTurnResult | void | Promise<BeforeTurnResult | void>;
  onRuntimeEvent?(event: NormalizedRuntimeEvent): void;
  afterTurn?(event: AfterTurnEvent): void | Promise<void>;
  onInternalMessage?(event: InternalMessageEvent): void | Promise<void>;
}
export interface RuntimeSwitchHooks {
  beforeSwitch?(event: RuntimeSwitchEvent): void | Promise<void>;
  afterSwitch?(event: RuntimeSwitchEvent): void | Promise<void>;
}

export type DocumentStorageLocationKind = "data" | "program" | "custom";
export interface ResolvedDocumentStorageLocation {
  kind: DocumentStorageLocationKind;
  path: string;
}
export interface DocumentReadResult { content: string; version: string }
export interface DocumentWriteResult { version: string }
export interface DocumentStorage {
  getLocation(): Promise<ResolvedDocumentStorageLocation>;
  selectLocation(kind: DocumentStorageLocationKind): Promise<ResolvedDocumentStorageLocation>;
  readText(relativePath: string): Promise<DocumentReadResult | null>;
  /** expectedVersion=null requires the document not to exist. */
  writeTextAtomic(
    relativePath: string,
    content: string,
    expectedVersion: string | null,
  ): Promise<DocumentWriteResult>;
  /** Delete a document. Pass the opaque version from the last read for a
   *  conditional (CAS) delete; omit/null deletes unconditionally. A stale
   *  version rejects with a conflict. */
  remove(relativePath: string, expectedVersion?: string | null): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}


/** 插件唯一能力门面（plan §5.2）。每个 register* 需要对应权限声明，
 *  返回 Disposer；未显式回收也由宿主 disposer 栈兜底。 */
export interface PluginContext {
  pluginId: string;
  version: string;
  /** 宿主共享 React：宿主树容器组件经它创建（createElement/useRef/...）；
   *  插件自有子树用自己的 createRoot 挂进容器（双段挂载模式）。 */
  react: typeof import("react");
  hooks: {
    registerSessionHooks(hooks: SessionHooks): Disposer;
    registerTurnHooks(hooks: TurnHooks): Disposer;
    registerRuntimeSwitchHooks(hooks: RuntimeSwitchHooks): Disposer;
  };
  workspace: {
    /** 稳定的宿主登记工作区身份（权限 workspace.metadata.read）。 */
    getMetadata(): Promise<WorkspaceMetadata>;
  };
  /** 插件隔离的 CAS 文本文档存储（权限 plugin.storage）。 */
  documentStorage: DocumentStorage;
  ui: {
    /** 设置页 section（权限 ui:settings-section）。 */
    registerSettingsSection(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      component: ComponentLike;
    }): Disposer;
    /** Composer「Add」菜单行（权限 ui:add-menu）。 */
    registerAddMenuRow(def: {
      key?: string;
      label: () => string;
      description?: () => string;
      icon?: ComponentLike<{ className?: string }>;
      onSelect: () => void;
    }): Disposer;
    /** Composer 工具栏插槽额外控件（权限 ui:composer）。 */
    registerComposerSlot(def: {
      slot: ComposerSlotId;
      key?: string;
      component: ComponentLike;
      order?: number;
    }): Disposer;
    /** 聊天右侧面板 tab（权限 ui:panel-tab）。 */
    registerPanelTab(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      component: ComponentLike<{ workspacePath: string }>;
      order?: number;
    }): Disposer;
    /** 应用底部状态栏条目（权限 ui:status-bar）。 */
    registerStatusBarItem(def: {
      key?: string;
      component: ComponentLike;
      order?: number;
    }): Disposer;
    /** ⌘K 命令面板命令（权限 ui:command）。 */
    registerCommand(def: {
      key: string;
      title: () => string;
      keywords?: () => string[];
      run: () => void;
    }): Disposer;
    /** 侧栏会话右键菜单追加行（权限 ui:session-menu，0.3.5 起）；
     *  run 收到打开菜单的会话。 */
    registerSessionMenuItem(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      danger?: boolean;
      run: (target: SessionMenuTarget) => void;
    }): Disposer;
    /** 跳转到本插件的设置页（权限 `ui:settings-section`，0.3.6 起）。
     *  `key` 对应 registerSettingsSection 的子 key，省略时打开主 section；
     *  供状态栏 chip、面板按钮等做深链入口。 */
    openSettings(key?: string): void;
    /** Markdown 渲染管线追加（权限 ui:markdown）。 */
    registerMarkdownRenderer(def: {
      key?: string;
      remarkPlugins?: unknown[];
      rehypePlugins?: unknown[];
      components?: Record<string, unknown>;
    }): Disposer;
    /** 覆盖层页面，路由 `#/p/<id>`（权限 ui:page）。 */
    registerPage(def: {
      key?: string;
      title: () => string;
      component: ComponentLike;
    }): Disposer;
    /** 自定义 timeline 行 kind 渲染器（权限 ui:timeline-row）。 */
    registerTimelineRowRenderer(def: {
      kind: string;
      key?: string;
      component: ComponentLike<{ row: { kind: string } }>;
    }): Disposer;
    /** 侧边栏工作区行右键菜单条目（权限 ui:workspace-menu）。 */
    registerWorkspaceMenuItem(def: {
      key?: string;
      label: (ctx: { workspaceId: string; archived: boolean }) => string;
      icon?: ComponentLike<{ className?: string }>;
      visible?: (ctx: { workspaceId: string; archived: boolean }) => boolean;
      onSelect: (ctx: { workspaceId: string; archived: boolean }) => void;
      order?: number;
    }): Disposer;
  };
  theme: {
    /** 注入样式表（权限 theme）；拒绝 @import/远程 url。 */
    injectCss(css: string): Disposer;
    /** BoardUI token 覆盖快捷方式；key 必须是 --* 自定义属性。 */
    setTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): Disposer;
  };
  i18n: {
    /** 注册语言包（权限 i18n）。 */
    addBundle(lang: string, ns: string, resources: Record<string, unknown>): Disposer;
  };
  storage: {
    /** 每插件 KV（权限 storage）。 */
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  events: {
    /** 事件总线（权限 events）。宿主话题示例：`usage://updated`、
     *  `composer://draft`（payload { text }，草稿变化/清空/会话切换均发射）。 */
    on(topic: string, cb: (data: unknown) => void): Disposer;
    emit(topic: string, data: unknown): void;
  };
  /** 聊天输入框(composer)草稿写入(权限 composer:draft,0.3.2 起)。
   *  写入即替换当前活动会话的草稿;不触发发送——发送永远是用户动作。 */
  composer: {
    setDraft(text: string): void;
  };
  /** 工作区登记(权限 host:workspace,0.3.3 起)。把任意路径登记为侧栏
   *  工作区——不要求本机存在该目录(如经 ssh 管理的远程机/WSL 发行版内
   *  路径)。meta 透传存储在宿主工作区行上(如 { wsl: { hostId, distro } }),
   *  会话/文件等宿主能力按需消费;形状由写入方与消费方约定。
   *
   *  meta 携带 `wsl` 键(远程工作区,宿主引擎经 ssh 把会话流量导到
   *  meta.wsl 指定的主机与发行版)需要额外权限 `host:workspace:remote`
   *  (0.3.4 起)——这等效于出网 + 远程执行导向,远超登记一行侧栏数据。
   *  信任权衡:远程通道首连采用 StrictHostKeyChecking=accept-new
   *  (首连自动记录 host key,之后变更才拒绝),插件作者应知晓这是
   *  TOFU 而非严格 pinning。 */
  workspaces: {
    add(path: string, meta?: Record<string, unknown>): Promise<void>;
  };
  /** 会话打开 + 外部会话源(权限 host:session;selectSession 0.3.3 起,
   *  registerSource 0.3.4 起)。registerSource:登记异步会话源,宿主在会话
   *  目录刷新时调用 list() 并把行合并进侧栏列表——本机扫描结果优先,同
   *  engine/sessionId/workspacePath 的外部行被丢弃。返回 Disposer,插件
   *  卸载时自动注销。 */
  sessions: {
    selectSession(engine: string, sessionId: string, workspacePath: string): Promise<void>;
    /** 请求宿主立即刷新会话目录（侧栏/标签页），0.3.7 起。
     *  插件绕过宿主直写会话数据（如 sqlite custom_title、转录 title 行）后
     *  调用——否则变更要等用户手动同步或下次常规刷新才可见。 */
    refresh(): Promise<void>;
    registerSource(def: {
      /** 源 id,插件内唯一;同 id 重复登记覆盖(热重载语义)。 */
      id: string;
      list: () => Promise<ExternalSessionRow[]>;
    }): Disposer;
  };
  bridge: {
    /** 通用能力出口（0.3.0 起；旧的 `cmd:<command>` 逐命令授权机制已删除）。
     *  仅四条命令，`pluginId` 由宿主自动注入（插件无需也不能传）：
     *
     *  - `plugin_http_request` `{ method, url, headers?, body? }` →
     *    `{ status, body }`：url 限 http/https，host(+端口) 须命中 manifest 的
     *    `network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>` 授权
     *    （形状与放行规则以 spec/permissions.json 为准）。
     *  - `plugin_exec_run` `{ bin, args, env?, timeoutMs? }` →
     *    `{ code, stdout, stderr }`：bin 须命中 `exec:<bin>` 授权（裸名，无路径）。
     *  - `plugin_exec_spawn` `{ bin, args, env?, lifecycle? }` → void：
     *    同授权；成功时 resolve 为 void（Rust 返回 ()），失败 reject。
     *    lifecycle 缺省 "detached"（用户级服务，活过插件）；"plugin" =
     *    附属进程，宿主跟踪，插件禁用/卸载时自动 kill。
     *  - `plugin_exec_kill` `{}` → `{ killed: number }`：kill 本插件全部
     *    lifecycle="plugin" 子进程（配置变更改名重启用；需任意 exec: 授权）。
     *
     *  授权未命中的调用在 JS 侧即 reject（不打 IPC）；Rust 侧对授权与插件
     *  启用态另有强制（纵深防御）。 */
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  host: {
    appVersion: string;
    /** 宿主实现的 SDK 版本（= @ccgui/plugin-sdk version）。 */
    sdkVersion: string;
    locale: string;
    /** Web 客户端为 true；上述桌面独占桥命令在那里不可用。 */
    isWeb: boolean;
  };
}
