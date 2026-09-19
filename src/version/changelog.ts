/**
 * Release notes shown in Settings → About → 版本记录 (ChangelogDialog).
 * Newest first; add an entry at release time. Content is bilingual — the
 * dialog shows both when available, ordered by the active UI language.
 */

/** Repo the dialog's Star banner links to; shared with Settings → About. */
export const GITHUB_REPO_URL = "https://github.com/zhukunpenglinyutong/desktop-cc-gui";

export interface ChangelogEntry {
  version: string;
  date: string;
  content: {
    en: string;
    zh: string;
  };
}

export const CHANGELOG_DATA: ChangelogEntry[] = [
  {
    version: "1.0.4",
    date: "2026-09-18",
    content: {
      zh: `✨ 新功能
- **claude 弹窗提问（AskUserQuestion）**：支持控制协议双向应答；未决提问以悬浮层覆盖输入框，支持单选 / 多选、多问题翻页、自由输入作答与「忽略」，答完转为只读历史行
- **内置 Agents 目录**：打包 agency-agents 资源，设置页新增内置 Agents 面板；composer 支持 @ 选择 agent、/ 选择 prompt 的触发菜单
- **状态栏分支跟随嵌套仓库**：文件树选中子仓库内的文件 / 文件夹时，分支胶囊、分支列表与检出跟随该仓库（显示「仓库名·分支」）
- 插件 SDK 0.3.7 / 0.3.9 / 0.3.10：新增 ctx.sessions.refresh（插件直写后即时刷新侧栏）、ctx.ui.registerComposerStatusItem（composer 状态项）、ctx.sessions.setEffort（插件修改会话推理强度）

🐛 修复
- 推理强度切换对已有会话无效：多余调用污染 tab 字段导致回退到引擎默认值
- 新建空会话（「新对话」页签）不在侧栏显示；折叠文件夹后恢复短列表
- 消息文件链接在嵌套工程下解析失败：新增索引回退（含 gitignore 产物）；@ 提及路径统一规范形，Windows 路径可渲染为 chip 并往返
- Windows「在资源管理器中显示」含空格路径静默跳到「文档」：改用 raw_arg 原样传递 /select 参数
- 快速回合先于 send 返回即完成时的路由丢失：桌面与 web IPC 预分配 run ID
- Claude / Kimi 渠道路由与原生别名互相污染：settings 白名单透传、渠道注入字段剥离、保留 CLI provider 配置
- 引擎进程 run_id 原子预留消除中断 TOCTOU 窗口；启动时清扫 claude-staging / grok-staging 残留目录

🧹 内部优化
- 行为保持型重构清零 react-doctor 13 条警告：composer / 侧栏 / 会话页签条等组件拆分与状态模式修正`,
      en: `✨ Features
- **claude AskUserQuestion popups**: control-protocol two-way answering; pending questions overlay the composer with single/multi-select, multi-question paging, free-text answers, and "Ignore"; answered questions become read-only history rows
- **Built-in Agents catalog**: agency-agents bundled as a resource with a new Settings pane; composer trigger menus for @ agent and / prompt selection
- **Status-bar branch follows nested repos**: selecting a file/folder inside a nested git repo switches the branch pill, branch list, and checkout to that repo (shown as "repo·branch")
- Plugin SDK 0.3.7 / 0.3.9 / 0.3.10: new ctx.sessions.refresh (instant sidebar refresh after direct writes), ctx.ui.registerComposerStatusItem (composer status items), ctx.sessions.setEffort (change session reasoning effort)

🐛 Fixes
- Effort switching had no effect on existing sessions: a stray call polluted the tab field and fell back to the engine default
- Empty new chats ("New chat" tabs) didn't appear in the sidebar; collapsing a folder restores the short recent list
- Message file links failed to resolve in nested projects: new index-based fallback (including gitignored build artifacts); @ mention paths normalized so Windows paths render as chips round-trip
- Windows "Show in Explorer" silently jumped to Documents for paths with spaces: pass the /select argument verbatim via raw_arg
- Fast turns completing before send returns lost routing: run IDs are preassigned across desktop and web IPC
- Claude/Kimi channel routing no longer pollutes native aliases: settings passed via allowlist, channel-injected fields stripped, CLI provider configs preserved
- Engine run_id reservation is now atomic, closing the interrupt TOCTOU window; stale claude-staging / grok-staging directories cleaned at startup

🧹 Internal
- Behavior-preserving refactor clearing 13 react-doctor warnings: composer / sidebar / session tab strip component splits and state-pattern fixes`,
    },
  },
  {
    version: "1.0.3",
    date: "2026-09-16",
    content: {
      zh: `✨ 新功能
- Windows 可切换**仿 macOS 自绘标题栏**
- 侧栏工作区行可**拖拽**到分组 / 未分组 / 已归档完成移动
- 插件 SDK 0.3.5 / 0.3.6：新增会话右键菜单扩展点 ui:session-menu；ctx.ui.openSettings 让插件深链自身设置页

🐛 修复
- Windows 对话孙进程（pwsh/conhost）孤儿泄漏：改用 Job Object 内核级清扫，dsh host、登录 shell 探针、插件子进程一并封堵；Unix 侧同步清扫进程组
- 上下文窗口显示：/compact 后分母不再回落 200k；新会话记住引擎上报的窗口；claude 回合结束自动重读真实占用，无需手动「刷新用量」
- claude auto 模式联网被拦截：预批准 WebSearch / WebFetch
- 模型目录探测死循环风暴；DSH 客户端本机 origin 恒直连
- codex 旧 CLI 预检并给出可操作升级提示；stderr 为空时错误横幅兜底
- dsh / 远程会话删除修复：新增 delete_remote_session IPC，dsh 删除不再失败复活`,
      en: `✨ Features
- Windows can switch to a **macOS-style custom title bar**
- Sidebar workspace rows can be **dragged** into groups / ungrouped / archived containers
- Plugin SDK 0.3.5 / 0.3.6: new session context-menu extension point ui:session-menu; ctx.ui.openSettings deep-links a plugin to its own settings page

🐛 Fixes
- Windows grandchild process (pwsh/conhost) orphan leaks: Job Object kernel-level cleanup now covers conversations, the dsh host, login-shell probes, and plugin child processes; Unix sides sweep the process group as well
- Context window display: the denominator no longer falls back to 200k after /compact; new sessions remember the engine-reported window; claude turns auto-reread real usage on completion — no manual "refresh usage" needed
- claude auto mode network access blocked: pre-approves WebSearch / WebFetch
- Model catalog probe infinite loop storm; DSH client always connects directly for local origins
- codex legacy CLI preflight with an actionable upgrade hint; error banner falls back when stderr is empty
- dsh / remote session deletion fixed: new delete_remote_session IPC, dsh deletions no longer resurrect`,
    },
  },
  {
    version: "1.0.2",
    date: "2026-09-15",
    content: {
      zh: `✨ 新功能
- 接入 **OpenCode** 与 **Qoder** 两个一等引擎；Qoder 区分国际版与国内版（qoder-cn 兄弟引擎）
- **WSL 插件**全链接入：会话源 / 文件源 / UI 桥 / 远程历史回放 / 远程模型目录
- **快捷键系统迁移**：可配置键位、设置页录制编辑、快捷键指南
- 会话行**右键菜单**：重命名 / 复制 ID / 删除

🐛 修复
- 新会话不再被刷新冲掉：侧栏即时显示，无需手动同步
- Windows 检测不到新装 / 非 npm 渠道安装的 codex 与 claude
- claude 上下文窗口改读 CLI 上报值
- 放行 asset 协议在 Windows 上的可用 URL 形式，移除 CSP 冗余项
- 移动端设置导航分组溢出重叠
- WSL 接入安全审查修复：meta.wsl 全字段白名单、权限模型收紧、远程调用 30s 全局超时
- 发版增加版本输入校验门禁，修复 latest.json 资产名空格 404`,
      en: `✨ Features
- Two new first-class engines: **OpenCode** and **Qoder**, with Qoder split into Global and CN distributions (qoder-cn sibling engine)
- **WSL plugins** wired end to end: session source, file source, UI bridge, remote history replay, remote model catalog
- **Shortcut system migration**: configurable keybindings, recording editor in Settings, and a shortcut guide
- Session-row **context menu**: rename / copy ID / delete

🐛 Fixes
- New sessions no longer get wiped by refreshes — the sidebar shows them immediately, no manual sync
- Windows now detects freshly installed or non-npm codex and claude builds
- claude context window reads the value reported by the CLI
- Allow the Windows-usable asset-protocol URL forms in CSP and drop a redundant entry
- Mobile settings navigation groups no longer overflow and overlap
- WSL integration security review fixes: full meta.wsl field allowlist, tightened permission model, 30s global timeout for remote calls
- Release pipeline validates version input and fixes the latest.json asset-name space 404`,
    },
  },
  {
    version: "1.0.1",
    date: "2026-09-14",
    content: {
      zh: `✨ 新功能
- 右键文件夹**搜索工作区文件**
- OMP 引擎补 plan / bypass 权限档

🐛 修复
- 「已编辑」行数改从会话编辑调用统计
- 窄窗下侧边栏开关常显、幕布区留白修正、子代理行归并`,
      en: `✨ Features
- **Search workspace files** from a folder's right-click menu
- OMP engine gains plan / bypass permission tiers

🐛 Fixes
- "Edited" line counts now come from the session's edit-call stats
- Narrow windows keep the sidebar toggle visible, fix backdrop gaps, and merge subagent rows`,
    },
  },
  {
    version: "1.0.0",
    date: "2026-09-08",
    content: {
      zh: `✨ 新功能
- 接入 **OMP 引擎**（pi-family 参数化复用 + 全链路接线）
- 新增 **局域网网页访问**：WebSocket 桥接 + 设置页二维码入口，手机浏览器可直接使用
- **Pi 家族引擎认证**：OAuth 订阅授权与 API Key 管理、cc-switch 渠道导入与切换
- **AI 聊天输入区增强**：@ 提及、权限 / effort 档位、分支菜单、提示历史补全
- 消息锚点导航、Provider 配置对话框与引擎 / 历史层增强
- 首页外观设置与交互粒子字标

🐛 修复
- Windows 上派生子进程不再弹出控制台窗口`,
      en: `✨ Features
- Add the **OMP engine** (parameterized reuse of the pi-family pipeline, wired end to end)
- **LAN web access**: WebSocket bridge + QR entry in Settings, so phones on the same network can use CC GUI in a browser
- **Pi-family engine auth**: OAuth subscription sign-in and API Key management, cc-switch channel import and switching
- **Composer upgrades**: @ mentions, permission / effort tiers, branch menu, prompt-history completion
- Message anchor navigation, provider configuration dialog, and engine/history layer improvements
- Home appearance settings with an interactive particle wordmark

🐛 Fixes
- Spawned child processes no longer show console windows on Windows`,
    },
  },
  {
    version: "0.9.4",
    date: "2026-08-30",
    content: {
      zh: `✨ 新功能
- 侧栏工作区子项增加树状连接线，会话重载收敛为强制同步并加重载忙碌态
- 设置新增 **侧栏网络代理抽屉**
- 文件底部状态栏新增 **Git Blame** 切换按钮

🐛 修复
- 修复 pi 多原生 turn 交错下「响应中」卡死、重复叙述与完成音连响
- 修复 Windows 单文件「差异不可用」死路
- 修复新建会话抽屉卡死

⚡ 性能
- live 工具输出增加渲染预算，会话条目缓存驱逐加入近期切换保护`,
      en: `✨ Features
- Sidebar workspace children get tree lines; session reload converges to a forced Session Index sync with a busy state
- New **network proxy drawer** in Settings
- **Git Blame** toggle in the file status bar

🐛 Fixes
- Fix pi sessions stuck in "running" with duplicated narration when native turns interleave
- Fix the Windows single-file "diff unavailable" dead end
- Fix the new-session drawer freeze

⚡ Performance
- Render budget for live tool output; recent-switch protection for session-entry cache eviction`,
    },
  },
  {
    version: "0.9.3",
    date: "2026-08-26",
    content: {
      zh: `🐛 修复
- PI catalog 探测跳过 extension boot 并放宽预算至 15s，根除 auto-only 降级
- Codex usage 事件不再伪造 200K 上下文窗口
- 新增孤儿 turn 零首事件看门狗，防止「响应中」永久卡死
- process_is_alive 增加 Windows 平台分支
- client store 写盘改 raw-string 过桥，遏制 markdown worker 崩溃循环`,
      en: `🐛 Fixes
- PI catalog probing skips extension boot with a 15s budget, eliminating auto-only degradation
- Codex usage events no longer fabricate a 200K context window
- Orphan-turn zero-first-event watchdog prevents sessions stuck in "running" forever
- Windows branch for process_is_alive
- Client store writes cross the bridge as raw strings, stopping markdown-worker crash loops`,
    },
  },
  {
    version: "0.9.2",
    date: "2026-08-22",
    content: {
      zh: `✨ 新功能
- 接入 **Qoder** Global 与 CN 双分发，落地 profile 限定的 Native 会话身份解析
- 会话 catalog 与 provider binding 全面携带分发归属

🐛 修复
- 修复多智能体协作模板选择器卡在加载中
- Shared 链路按 Target 认主并隐藏下崽会话`,
      en: `✨ Features
- **Qoder** Global and CN distributions, with profile-qualified native session identity resolution
- Session catalog and provider binding now carry distribution attribution throughout

🐛 Fixes
- Fix the multi-agent template picker stuck loading
- Shared sessions resolve ownership by target and hide child sessions`,
    },
  },
  {
    version: "0.9.1",
    date: "2026-08-19",
    content: {
      zh: `✨ 新功能
- DSH 接入 composer **Agent Preset** 选择器

🐛 修复
- DSH 按会话隔离 Agent Preset 展示，接通任务条与上下文占用
- 收敛长对话尾部重复的用户气泡
- 隐藏 Shared 协议续跑会话及其侧栏子会话`,
      en: `✨ Features
- DSH gets an **Agent Preset** picker in the composer

🐛 Fixes
- DSH Agent Presets are isolated per session; task bar and context usage are wired up
- Collapse duplicated user bubbles at the tail of long conversations
- Hide Shared-protocol resumed sessions and their sidebar children`,
    },
  },
];
