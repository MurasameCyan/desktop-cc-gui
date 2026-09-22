# @ccgui/plugin-sdk changelog

## 0.4.3 — 2026-09-18

- 新增 `ctx.ui.registerOverlay` / `ui:overlay`：跨路由非模态视口挂载，空白区域点击穿透，单插件渲染边界与卸载清理。
- 新增 `ctx.assets`：包内、文档根、显式授权目录及受 `network:` 授权的远程二进制资源 URL；桌面与 Web 共用授权、路径和响应策略，相对资源请求保留授权前缀。
- 新增 `assets:bundle`、`assets:directory` 及每插件目录授权管理；卸载清除目录能力，不改变 CCB 的文档保留策略。新增 `ctx.shell.revealPath`，仅可定位本插件已授权范围。
- 新增 `TurnHooks.onTurnStarted`，只需 `runtime.events.read`，不授予提示写入能力；开始、失败、取消、提前终态共享稳定 `turnId`，旧回合迟到清理不会中断替代回合。
- 新增 `permission-requested` 运行时事实：只投影引擎结构化工具名和路径，不携带 message，不保证 CLI 正在等待。
- 延续 0.4.2 的全部 CCB 契约；资源单文件上限 8 MiB，远程单次请求限时 30 秒，禁止通过远程/目录资源执行脚本。
- 合并上游 0.3.12/0.3.13：新增 `ctx.agent.start/interrupt`（权限 `agent`，插件经宿主引擎管线运行 agent 轮次）、`ctx.ui.registerSidebarNav`（权限 `ui:sidebar-entry`，首页侧栏「自动化」之下导航项）、`ctx.ui.registerCenterTab` + `ctx.ui.openCenterTab`（权限 `ui:center-tab`，中心页签）。
## 0.3.11 — 2026-09-18
- **修复权限漂移**：`registerComposerSlot` 运行时一直校验 `ui:composer`，
  但该字符串在 0.3.9 改名为 `ui:composer-status` 时未同步更新
  （`spec/permissions.json` 的 `knownPermissions` 早已只保留
  `ui:composer-status`），导致 `registerComposerSlot` 自 0.3.9 起对任何
  manifest 声明都必然拒绝——没有任何权限字符串能通过校验。改为校验
  `ui:composer-status`，与 `registerComposerStatusItem` 共享同一权限，
  两个注册点现在都能正常声明使用。

## 0.3.9 — 2026-09-16
- **新增能力**：`ctx.ui.registerComposerStatusItem({ key?, component, order? })`
  （新权限 `ui:composer-status`）——在 composer 状态行（分支/上下文用量那行）
  左组、分支切换器之后渲染 chip。首个消费者：token-meter 指标插件从底部状态栏
  迁至会话工具行。

## 0.3.8 — 2026-09-16
- **新增能力**：`registerStatusBarItem` 的 `zone?: "start" | "end"`——`"start"`
  把 chip 渲染到状态栏左对齐区（内建控件簇左侧），缺省/`"end"` 保持既有槽位
  （同步状态之后、版本号之前）不变。首个消费者：token-meter 指标插件。
- **新增宿主话题**（权限 `events`）：`usage://done`——引擎 done 事件透传
  （payload 同 EngineEventPayload，`data.usage` 携带该轮最终用量；claude/grok
  等只经 Done 上报用量的引擎由此对插件可见）；`session://activated`——活动会话
  切换，payload `{ engine, sessionId }`，pending 标签 sessionId 为 null，无活动
  标签时两者皆 null。
- **payload 增强**：引擎事件 wire payload 新增 `ts`（宿主发射时刻，Unix 毫秒），
  前端 `EngineEventPayload` 同步为 `ts?: number`；插件可用它算吞吐而不受 IPC
  批量/到达抖动影响，旧宿主上缺省回退到达时间。

## 0.3.7 — 2026-09-16
- **新增能力**：`ctx.sessions.refresh()`（复用权限 `host:session`）——请求宿主立即
  刷新会话目录（侧栏/标签页）。插件绕过宿主直写会话数据（sqlite custom_title、
  转录 title 行）后调用，变更即刻可见，不再依赖手动同步或重启。首个消费者：
  auto-title 命名/自愈补写后即时刷新侧栏。

## 0.3.6 — 2026-09-16
- **新增能力**：`ctx.ui.openSettings(key?)`（复用权限 `ui:settings-section`）——跳转到
  本插件的设置页（hash 路由 `#/settings?page=plugin:<id>[:<key>]`），供状态栏 chip、
  面板按钮等做深链入口。首个消费者：auto-title 状态栏 chip 点击改跳设置页。

## 0.3.5 — 2026-09-16
- **新增能力**：`ctx.ui.registerSessionMenuItem({ key?, label, icon?, danger?, run })`（权限
  `ui:session-menu`）——在侧栏会话右键菜单追加一行，`run` 收到打开菜单的会话
  `{ engine, sessionId }`；label 为 thunk，语言切换即时重命名。首个消费者：auto-title
  插件的「重新命名（自动命名）」菜单项。

## 0.3.4 — 2026-09-14
- **新增能力**:`ctx.sessions.registerSource({ id, list })`(权限 `host:session`)——登记
  外部会话源(远程机/容器内 CLI 的会话摘要),宿主在会话目录刷新时调用 `list()` 并把行合并进
  侧栏列表;本机扫描结果优先,行 `workspacePath` 须为已登记工作区 path。配套类型
  `ExternalSessionRow`;返回 Disposer,卸载自动注销。
- **新增权限**:`host:workspace:remote`——`ctx.workspaces.add` 的 meta 携带 `wsl` 键
  (远程工作区,宿主引擎经 ssh 把会话流量导到插件指定主机)时必需;仅 `host:workspace`
  的插件不能再设置远程 meta。等效于出网 + 远程执行导向,故独立于工作区登记授权。
- **修复**:`events` 权限条目在权限 spec 中被误删导致存量插件无法加载的问题,已恢复
  (契约本身无变化)。
- **加固**(宿主侧,契约不变):registerSource 入口校验 def 形状;同步抛错的会话源被
  隔离(不再连累其他源与整轮刷新);外部行字段类型校验 + 单源 500 行上限;
  `selectSession` 的错误统一走 Promise rejection。

## 0.3.3 — 2026-09-13
- **新增能力**:`ctx.workspaces.add(path, meta?)`(权限 `host:workspace`)——把任意路径
  登记为侧栏工作区,不要求本机存在该目录(远程机/WSL 发行版内路径);meta 透传存储,
  如 `{ wsl: { hostId, distro } }`(0.3.4 起携带 `wsl` 键需 `host:workspace:remote`)。
- **新增能力**:`ctx.sessions.selectSession(engine, sessionId, workspacePath)`(权限
  `host:session`)——按引擎 + 会话 id 打开/恢复既有会话;未知组合抛错,不静默。
- 注:0.3.3 未单独发布,上述能力随 0.3.4 首次落地;版本戳保留以标注能力引入序。

## 0.3.2 — 2026-09-12
- **新增能力**：`ctx.composer.setDraft(text)`（权限 `composer:draft`）——写入当前活动会话的
  聊天输入框草稿；替换语义，不触发发送。配合既有 `composer://draft` 事件（host→plugin）构成
  草稿的双向通道；react-doctor 的「一键修复」填入修复提示词即首个消费者。

## 0.3.1 — 2026-09-09

- `plugin_exec_spawn` 新增可选 `lifecycle: "detached" | "plugin"`（缺省 detached，行为不变）；
  `"plugin"` 的子进程由宿主跟踪，插件禁用/卸载时自动 kill。
- 新增 `plugin_exec_kill`：kill 本插件全部 lifecycle="plugin" 子进程（改名重启用；需任意 exec: 授权）。
- 动机：prompt-shield 类插件的附属代理进程需要随插件生命周期回收；tokentracker 类用户级服务保持 detached。
- 加载器修复：`styles.css` 现在对 js 插件也自动注入（此前只有 declarative 注入，js 插件的样式文件产而不装——prompt-shield 设置页"样式丢失"即此因）。样式表属三件套产物，不走 `theme` 运行时权限门；远程引用拒止仍生效。

插件系统契约包的独立版本史。宿主运行时随 app 发版，本包版本表达**契约**的演进；
插件经 manifest `sdkVersion` range 声明兼容区间（VS Code `engines.vscode` 同款模式）。

## 0.3.0 — 2026-09-09（breaking：通用能力出口）

- **breaking**：`cmd:<command>` 逐命令授权机制整体删除（`GRANTABLE_COMMANDS` 移除）；
  `tt_proxy` / `tt_detect_cli` / `tt_server_status` / `tt_install_cli` / `tt_ensure_server`
  五条 usage-stats 专属桥命令随宿主侧 tokentracker.rs 一并退役。
- 新增通用能力出口三条：`plugin_http_request`（域名白名单 HTTP 代理，响应文本上限 8MB）、
  `plugin_exec_run`（二进制白名单进程执行，stdout/stderr 各截 64KB，超时上限 300s）、
  `plugin_exec_spawn`（detached 后台进程）；`pluginId` 由宿主自动注入。
- 新增授权语法：`network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>`
  （host 精确匹配，大小写不敏感，无通配/子域）与 `exec:<bin>`（裸名，禁路径分隔符）。
- 新增导出 `isKnownPermission` / `networkGrantAllows` / `execGrantAllows`
  （宿主 permissions.ts、模板 validate-manifest.mjs、Rust plugins.rs 四处锁步）。
- usage-stats 插件自 1.1.0 起适配本版契约（`sdkVersion: "^0.3"`）。

## 0.2.0 — 2026-09-09（Phase 2）

- 扩展点注册化全部落地：新增 `registerComposerSlot`（ui:composer）、`registerPanelTab`（ui:panel-tab）、
  `registerStatusBarItem`（ui:status-bar）、`registerCommand`（ui:command）、`registerMarkdownRenderer`
  （ui:markdown）、`registerPage`（ui:page）、`registerTimelineRowRenderer`（ui:timeline-row）。
- 新增 `manifest.sdkVersion` 版本握手 + `ctx.host.sdkVersion` + `satisfiesSdkRange`。
- manifest `contributes` 补齐 Tier-0 `statusBarItems` / `commands`。
- 权限全集 14 项；`KNOWN_PERMISSIONS`/`GRANTABLE_COMMANDS` 移入本包作为单一事实源。
- 契约包首次独立成包：类型/Registry/注册表单例/版本常量从 `features/plugins/` 收敛至此。

## 0.1.0 — 2026-09-08（Phase 1，追溯记录）

- 初始契约：`PluginContext`（ui.registerSettingsSection/registerAddMenuRow、theme、i18n、storage、
  events、bridge.invoke、host）、`PluginManifest`、`Registry`/`useRegistry`、分层信任 Tier-0/1/2。
