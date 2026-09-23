# @ccgui/plugin-sdk changelog

## 0.3.14 — 2026-09-23
- **模型入口 CLI 切换**：`ModelEntryProps` 新增 `engines: EngineChoice[]` 与
  `onSelectEngine(engineId)`。列表与宿主原入口同源；回调真正更换未开始会话的
  执行目标，不是筛选模型。首轮请求准备中、运行中、已有会话以及过期上下文均拒绝切换。
- 新版统一供应商插件声明 SDK `0.3.14`，旧宿主会在加载前被版本握手拦截，
  不会因缺少上述参数而在渲染时崩溃。
- `@ccgui/plugin-ui` 新增 `EffortSlider`：受控档位拉条，原生键盘/拖拽操作，
  使用宿主主题 token；统一供应商入口显示的草稿档位与实际提交值保持一致。

## 0.3.13 — 2026-09-21
- **新增能力 `agent`**：`ctx.agent.start/interrupt` 让插件经宿主引擎管线
  运行 agent 轮次——与聊天发送共用 spawn/reader/registry（渠道注入、进程
  注册、中断），事件走独立的 `plugin-agent://event` 流，前端按 run id
  属主前缀路由到 `agent://<pluginId>` 总线话题。插件 run 不会进 chat
  store，也不被 chat 的 Stop 误杀。桌面专属。
- 权限单一事实源新增 `agent`；通用 bridge 白名单同步放开
  `plugin_agent_start` / `plugin_agent_interrupt`。
- **新增能力 `cli`**（桌面专属；权限分级 `cli.read` / `cli.contributions.write` /
  `cli.runtime.sensitive` / `network.targets.request` / `cli.config.read` /
  `cli.config.apply`）：通用「执行贡献」门面，供插件把自管的 Provider/Endpoint/
  Model/Binding 投影成宿主可消费的**不可变、无密钥**执行契约。
  - 发布目录：`publishSource` / `getSource` / `unpublishSource` / `listSources` /
    `onChanged`——首发/更新走文档版本 CAS，profiles/choices 与只读索引同事务，
    失败保持上一次发布。
  - 目标授权：`requestTargetGrant` / `listTargetGrants` / `revokeTargetGrant`——
    动态目标（base URL/origin/执行环境/Key 身份+代次）经桌面宿主 dialog 确认、
    可撤回；static grant 或 UI 布尔不能冒充确认。
  - 运行材料：`registerRuntimeMaterial` / `onMaterialRequested` /
    `getCredentialUses`——明文 Key 只为已绑定/正在选择的凭据登记，仅存内存并注入
    目标子进程；`setSelection` 缺材料时发 `cli://material-requested` 等待补登，
    不在每次 send 回调 JS。
  - 发现与原生配置：`listModels`（官方目录 / 授权端点发现，限大小/超时/重定向）、
    `listConfigTargets` / `previewConfigImport` / `confirmConfigImport`（原生配置
    导入，预览仅 metadata，确认后才交付勾选 Key）、`previewConfigPatch` /
    `applyConfigPatch` / `restoreConfigPatch`（从已发布 selection 生成受控 patch，
    保留未知字段/注释，原子写 + CAS 防覆盖外部改动）。
- **新增扩展点 `ui:model-entry`**：`ctx.ui.registerModelEntry({ key?, engineIds,
  component, order? })` 按 engine **替换**内建模型入口（不是并排新增槽位）；组件
  只消费无密钥的 `ModelEntryProps`（`context` / `choices` /
  `onApply(selection, expectedVersion)` / `onRefresh`）。注销/崩溃/禁用/卸载
  回退内建入口。
- **新增能力 `documentStorage`**（权限 `plugin.storage`）：CAS 保护的私有插件文档
  存储——`getLocation` / `selectLocation` / `readText` /
  `writeTextAtomic(path, content, expectedVersion)` / `remove` / `list`；自定义
  位置经宿主选择器，禁越权路径，跨进程锁 + junction/reparse 防护。
- **会话权威选择**（权限 `host:session`）：`ctx.sessions.getContext()` /
  `setSelection(target, selection, expectedVersion)` / `onSelectionChanged(cb)`——
  完整执行选择（native 渠道或插件贡献 + Key 身份 + effort）按执行目标 + workspace
  + 会话身份单条版本 CAS；既有 `setEffort` 沿用签名，只改同一记录。

## 0.3.12 — 2026-09-21
- **新增扩展点 `ui:sidebar-entry`**：`ctx.ui.registerSidebarNav` 在首页侧栏
  内建「自动化」入口之下注册导航项（label/icon/order/onOpen），经宿主
  `sidebarNavRegistry` 渲染，与内建导航同一 chrome。
- **新增扩展点 `ui:center-tab`**：`ctx.ui.registerCenterTab` 注册中心页签
  定义（title/icon/component），`ctx.ui.openCenterTab(key?)` 打开或聚焦——
  页签与会话/文件/浏览器共享中部页签条，组件渲染在 PluginBoundary 内。
  打开未注册的页签会抛错（失败必须可见）。
- 权限单一事实源 `spec/permissions.json` 新增上述两项；TS/Rust/模板校验
  全部自动派生。

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

- **spec 单一事实源**：`KNOWN_PERMISSIONS` 改为从包内 `spec/permissions.json` 生成；
  授权形状/放行测试向量由 TS、Rust（include_str!）、模板校验脚本三方共享，漂移在 CI 暴露。
- **模块拆分**：`src/index.ts` 拆为 manifest / permissions / version / registry / context
  五个关注点模块，index.ts 变为纯 re-export barrel（导出集合不变）；manifest/permissions/version
  零运行时依赖，Node 校验脚本可直接 import。
- **新增导出**：`scopedPluginId` / `pluginIdFromRegistryKey` / `compareByOrder`
  （注册表条目 id 构造/逆运算与 order 排序比较器）。
- **修复**：`satisfiesSdkRange("^0.0", "0.0.0")` 此前误判 false——`^0.0` 省略 patch
  现在正确地匹配任意 0.0.x（与文档化的 `^0.2` 省略语义一致）。
- **修复**：`compareVersions` 遇到非数字段（"0.a.1"/"latest"）现在抛出明确的 Error，
  不再静默返回 NaN 使比较失真。
- **修复**：`parseNetworkGrant` 拒绝把 `none` 当作授权 host——`network:none` 是基座权限
  （声明无网络），永远不是授权；此前 `network:none` 会被解析成放行主机 "none" 的 grant
  （与 Rust 侧行为对齐，spec networkAllow 向量覆盖）。
- `plugin_exec_spawn` 桥命令成功时 resolve 为 void（Rust 返回 ()），文档同步更正。
- 新增 `src/contract-check.ts`：类型层面把守 plugin.d.ts 与 src/* 的双向漂移
  （纯数据类型双向可赋值；PluginContext 各能力组 key 完全对齐）。

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
