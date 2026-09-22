import type { ComponentType } from "react";
import type * as React from "react";
import type { Disposer } from "./manifest";
import type { ComposerSlotId, SessionMenuTarget } from "./registry";
import type { CliCapabilities, ExecutionSelectionInput, ModelEntryProps, SessionExecutionContext, SessionExecutionTarget } from "./cli";
import type { DocumentStorage } from "./document-storage";

/**
 * PluginContext（plan §5.2）：插件唯一能力门面。宿主 runtime/context.ts
 * 实现本接口；插件侧的类型镜像见包根 plugin.d.ts（双向漂移由
 * contract-check.ts 在类型层面把守）。
 */

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

export interface PluginContext {
  pluginId: string;
  version: string;
  /** Shared host React instance: external bundles can't resolve bare
   *  imports, so they build host-tree components with
   *  `ctx.react.createElement`; 插件自己的子树用自带 React createRoot 挂进
   *  ctx.react 容器（双段挂载模式，import-map 共享是 P0-3 后续）。 */
  react: typeof React;
  ui: {
    registerSettingsSection(def: {
      /** Optional sub-key; the settings page key becomes
       *  `plugin:<id>` or `plugin:<id>:<key>`. */
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      component: ComponentType;
    }): Disposer;
    registerAddMenuRow(def: {
      key?: string;
      label: () => string;
      description?: () => string;
      icon?: ComponentType<{ className?: string }>;
      onSelect: () => void;
    }): Disposer;
    /** Extra control rendered beside a composer slot's builtin control
     *  (plan §4.2 #2). Permission `ui:composer-status` (shared with
     *  registerComposerStatusItem — both gate on the same composer-area
     *  grant; there is no separate `ui:composer` permission). */
    registerComposerSlot(def: {
      slot: ComposerSlotId;
      key?: string;
      component: ComponentType;
      order?: number;
    }): Disposer;
    /** Replace the builtin model entry for these engines. Permission
     * ui:model-entry; unregister/crash restores the builtin entry. */
    registerModelEntry(def: {
      key?: string;
      engineIds: string[];
      component: ComponentType<ModelEntryProps>;
      order?: number;
    }): Disposer;
    /** Chat right-panel tab; renders with the active workspace path
     *  (plan §4.2 #4). */
    registerPanelTab(def: {
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      component: ComponentType<{ workspacePath: string }>;
      order?: number;
    }): Disposer;
    /** App status-bar chip (plan §4.2 #8). */
    registerStatusBarItem(def: {
      key?: string;
      component: ComponentType;
      order?: number;
      /** Placement zone (0.3.8): "start" = left-aligned zone; omitted/"end"
       *  = legacy slot after sync status, before version. */
      zone?: "start" | "end";
    }): Disposer;
    /** Composer status-row chip (permission `ui:composer-status`, 0.3.9):
     *  renders in the composer's status row (branch/context meter row),
     *  left group after the branch switcher. */
    registerComposerStatusItem(def: {
      key?: string;
      component: ComponentType;
      order?: number;
    }): Disposer;
    /** Command palette entry (plan §4.2 #9). */
    registerCommand(def: {
      key: string;
      title: () => string;
      keywords?: () => string[];
      run: () => void;
    }): Disposer;
    /** Sidebar session right-click menu row (permission `ui:session-menu`,
     *  0.3.5 起)。`run` 收到打开菜单的会话 `{ engine, sessionId }`。 */
    registerSessionMenuItem(def: {
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      danger?: boolean;
      run: (target: SessionMenuTarget) => void;
    }): Disposer;
    /** 跳转到本插件的设置页（权限 `ui:settings-section`，0.3.6 起）。
     *  `key` 对应 registerSettingsSection 的子 key，省略时打开主 section；
     *  供状态栏 chip、面板按钮等做深链入口。 */
    openSettings(key?: string): void;
    /** Markdown pipeline additions, merged over host defaults (plan §4.2 #5). */
    registerMarkdownRenderer(def: {
      key?: string;
      remarkPlugins?: unknown[];
      rehypePlugins?: unknown[];
      components?: Record<string, unknown>;
    }): Disposer;
    /** Overlay page at `#/p/<id>` (plan §4.2 #10). */
    registerPage(def: {
      key?: string;
      title: () => string;
      component: ComponentType;
    }): Disposer;
        /** Renderer for a plugin-defined chat timeline row kind (plan §4.2 #5).
     * The row payload is plugin-defined and typed loosely — blob bundles
     * can't share the host's TimelineRow type identity. */
    registerTimelineRowRenderer(def: {
      kind: string;
      key?: string;
      component: ComponentType<{ row: { kind: string } }>;
    }): Disposer;
    /** Home sidebar nav entry under the builtin 自动化 row (permission
     *  `ui:sidebar-entry`, 0.3.12). `onOpen` usually opens the plugin's
     *  center tab via openCenterTab. */
    registerSidebarNav(def: {
      key?: string;
      label: () => string;
      icon?: ComponentType<{ className?: string }>;
      order?: number;
      onOpen: () => void;
    }): Disposer;
    /** Center-area tab definition (permission `ui:center-tab`, 0.3.12):
     *  renders in the center tab strip like session/file/browser tabs.
     *  Opening goes through openCenterTab; multiple keys = multiple tabs. */
    registerCenterTab(def: {
      key?: string;
      title: () => string;
      icon?: ComponentType<{ className?: string }>;
      component: ComponentType;
      order?: number;
    }): Disposer;
    /** Open (or focus) one of this plugin's registered center tabs
     *  (permission `ui:center-tab`, 0.3.12). Throws when the tab was never
     *  registered — open failures must be visible, not silent. */
    openCenterTab(key?: string): void;
  };
  theme: {
    /** Inject a stylesheet scoped to this plugin; removed on unload.
     *  Rejects remote references (`@import`, `url(http…)`): plugins must be
     *  self-contained (plan §8 gate rules). */
    injectCss(css: string): Disposer;
    /** Shorthand for BoardUI token overrides: keys must be `--*` custom
     *  properties; emits `:root {…}` and `.dark {…}` blocks. */
    setTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): Disposer;
  };
  i18n: {
    addBundle(lang: string, ns: string, resources: Record<string, unknown>): Disposer;
  };
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Private plugin documents, CAS-protected; permission plugin.storage. */
  documentStorage: DocumentStorage;
  /** Typed execution contributions, grants and native configuration operations. */
  cli: CliCapabilities;
  events: {
    on(topic: string, cb: (data: unknown) => void): Disposer;
    emit(topic: string, data: unknown): void;
  };
  /** 聊天输入框（composer）草稿写入（权限 `composer:draft`，0.3.2 起）。
   *  写入即替换当前活动会话的草稿；不触发发送——发送永远是用户动作。 */
  composer: {
    setDraft(text: string): void;
  };
  /** 工作区登记（权限 `host:workspace`，0.3.3 起）。把任意路径登记为侧栏
   *  工作区——不要求本机存在该目录（如经 ssh 管理的远程机/WSL 发行版内
   *  路径）。`meta` 透传存储在宿主工作区行上，形状由写入方与消费方约定。
   *
   *  `meta` 携带 `wsl` 键（远程工作区，宿主引擎经 ssh 把会话流量导到
   *  meta.wsl 指定的主机与发行版）需要额外权限 `host:workspace:remote`
   *  （0.3.4 起）——这等效于出网 + 远程执行导向，远超登记一行侧栏数据。
   *  信任权衡：远程通道首连采用 StrictHostKeyChecking=accept-new
   *  （首连自动记录 host key，之后变更才拒绝），插件作者应知晓这是
   *  TOFU 而非严格 pinning。 */
  workspaces: {
    add(path: string, meta?: Record<string, unknown>): Promise<void>;
  };
  /** 会话打开 + 外部会话源(权限 `host:session`;selectSession 0.3.3 起,
   *  registerSource 0.3.4 起)。registerSource:登记异步会话源,宿主在会话
   *  目录刷新(init/refreshSessions/rescan)时调用 `list()` 并把行合并进
   *  侧栏列表——本机扫描结果优先,同 engine/sessionId/workspacePath 的外部
   *  行被丢弃。返回 Disposer,插件卸载时自动注销。 */
  sessions: {
    selectSession(engine: string, sessionId: string, workspacePath: string): Promise<void>;
    /** Complete active target/selection; null when no composer target exists. */
    getContext(): Promise<SessionExecutionContext | null>;
    /** Atomically change this target only. Stale expectedVersion rejects. */
    setSelection(target: SessionExecutionTarget, selection: ExecutionSelectionInput, expectedVersion: number | null): Promise<SessionExecutionContext>;
    onSelectionChanged(callback: (context: SessionExecutionContext) => void): Disposer;
    /** 请求宿主立即刷新会话目录（侧栏/标签页），0.3.7 起。
     *  插件绕过宿主直写会话数据（如 sqlite custom_title、转录 title 行）后
     *  调用——否则变更要等用户手动同步或下次常规刷新才可见。 */
    refresh(): Promise<void>;
    /** 修改已有会话的 effort 档位，0.3.10 起。直写宿主会话状态并持久化
     *  （等价于用户在会话内切换档位，refreshSessions 不会回滚）。未知会话
     *  或空 effort 以 rejection 失败——不会创建幽灵会话条目。 */
    setEffort(engine: string, sessionId: string, workspacePath: string, effort: string): Promise<void>;
    registerSource(def: {
      /** 源 id,插件内唯一;同 id 重复登记覆盖(热重载语义)。 */
      id: string;
      list: () => Promise<ExternalSessionRow[]>;
    }): Disposer;
  };
  /** Agent 轮次（权限 `agent`，0.3.13 起）：经宿主引擎管线拉起 agent
   *  进程——渠道注入、进程注册与聊天发送同构。事件走独立的
   *  `agent://<pluginId>` 总线话题（ctx.events.on 订阅；payload 为引擎
   *  事件信封 { runId, sessionId, engine, seq, kind, data, ts }，kind ∈
   *  delta | tool | usage | done | error …）。桌面专属（isWeb 下不可用的
   *  插件要自呈现）。 */
  agent: {
    /** 启动一个 agent 轮次；返回的 runId 用于事件过滤与 interrupt。 */
    start(def: {
      engine: string;
      prompt: string;
      /** agent 进程的工作目录（绝对路径）。 */
      workspacePath: string;
      model?: string;
      /** 缺省 = 引擎当前渠道（与聊天发送同一解析）。 */
      providerId?: string;
      /** 引擎相关的会话续接 id（如 pi 的 --session-id）：同一 id 续上轮。 */
      sessionId?: string;
    }): Promise<{ runId: string; sessionId: string | null }>;
    /** 中断本插件启动的 run（run id 属主前缀由宿主强制）。 */
    interrupt(runId: string): Promise<void>;
  };
  /** 通用能力出口（0.3.0 起；旧的 `cmd:<command>` 逐命令授权机制已删除）。
   *  仅四条命令，`pluginId` 由宿主自动注入（插件无需也不能传）：
   *
   *  - `plugin_http_request` `{ method, url, headers?, body? }` →
   *    `{ status, body }`：url 限 http/https，host(+端口) 须命中 manifest 的
   *    `network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>` 授权
   *    （形状与放行规则见 spec/permissions.json）。
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
  bridge: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  host: {
    appVersion: string;
    /** 宿主实现的 SDK 契约版本（= 本包 version），供插件运行时自检。 */
    sdkVersion: string;
    locale: string;
    /** True in the web-access browser client; the desktop-only bridge
     *  commands above are absent there. */
    isWeb: boolean;
  };
}
