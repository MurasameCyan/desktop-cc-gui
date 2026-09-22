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
    version: "1.0.6",
    date: "2026-09-22",
    content: {
      zh: `✨ 新功能
- **会话内容全文搜索**：⌘L 搜索弹窗在标题匹配之外新增消息正文匹配（FTS5 trigram 索引 + 后台增量索引），支持相关性 / 最近排序与索引进度提示，短词回退 LIKE 精确匹配
- **会话内搜索**：⌘F 在当前会话中查找消息并逐条跳转高亮，快捷键可在设置中改绑
- **内置斜杠命令**：/new、/clear、/compact 由前端直接处理，斜杠选择器新增「内置」分组；同名 catalog 命令仍优先，压缩期间状态条显示 Compacting context…
- **提问卡片打通更多引擎**：Codex / Grok 走 CLI 自有传输（app-server / ACP），Kimi 走 ACP elicitation 表单，pi 由内置 ask-bridge 扩展提供 ask_user 工具，omp 切 rpc-ui 模式，DSH 与 OpenCode 分别经 $events/result 与托管 server 应答
- **多选题轮次体验重做**：选项可再次点击取消，单选答完自动跳到下一道未答题，未答完时 Enter 跳题并提示剩余题数；多选在本地收集后一次提交（失败可回退重答）；协议只接受预置选项时不渲染自由输入
- **推理强度全引擎贯通**：所有 CLI 统一注入请求级 effort，并原样下发（xhigh / ultra 不再被改写成 max / high）；新建会话默认 medium，修复切换推理强度实际不生效
- **幕布显示真实模型与档位**：读取 run 实际上报的 model / effort，不再沿用虚假的初始请求参数
- **设置页改为全屏**：覆盖层弹窗换成全屏 SettingsShell，侧栏支持搜索过滤与分组折叠（折叠状态持久化），重新分组为系统 / 插件 / CLI 管理 / 工作区与数据 / 其他，未安装与未启用独立成组
- **变更面板撤销更改**：未暂存与未跟踪文件支持单个撤销与「全部撤销」，均经危险确认；索引内文件等价 git restore --worktree，未跟踪文件等价 git clean，已暂存组不提供撤销
- **变更面板跟随嵌套仓库**：跟随文件树选中进入子仓库时，头部显示仓库名徽标，避免在不知情下对非根仓库 stage / commit
- **终端增强**：输出中的绝对路径可点击在文件管理器中显示；选中文本支持右键复制
- **用量统计新增本年 / 总和**：总和读取全部台账（不再被 365 天窗口截断），图表横轴随之切换——本年按月、总和按 CLI 分柱
- **渠道选择器改进**：供应商改为限定高度下拉框并支持输入筛选，切换渠道立即刷新该渠道映射的模型，无渠道引擎不再显示空筛选框，引擎面板改为点击切换以免误换面板
- **DSH 图片附件**：支持粘贴 / 选择 / 拖入图片；自定义 llm-pi-ai 路由由 ccgui 在发送前自动声明图片输入能力
- **Linux 新增 .rpm 安装包**（zstd 压缩，需 rpm ≥ 4.14），README 增补十引擎功能兼容矩阵
- **插件 SDK 0.3.12 / 0.3.13**：新增侧栏导航项（ui:sidebar-entry）、中心页签（ui:center-tab）与插件 agent 轮次（agent 权限，事件走独立 plugin-agent://event 流，不被聊天 Stop 误杀）；新增 @ccgui/plugin-ui 共享组件库
- 打开 .md 文件默认进入预览模式；CSP 放开 https: 图片，远程图片可直接显示

🐛 修复
- 选中文字后拖动导致页面锁死：显式释放 pointer capture，拖拽结束时清理 window 事件监听器
- 并发槽位泄漏：任务 panic 或被丢弃时经 Drop 兜底清理 run 条目与虚拟运行守卫，不再钉住槽位直到应用退出（too many concurrent runs）
- 插件启动期拿不到当前会话：会话激活事件支持粘性回放，引擎选择器切换待发会话时也会广播
- pi stdin 缺终止换行导致解析失败的警告横幅
- 上游 400 错误横幅显示原始 JSON：改为可读文案
- 变更面板未跟踪文件预览为空；diff 移出 IPC 主线程并加 2 MiB 上限，大文件不再阻塞界面
- git 远程认证失败返回误导性的 libgit2 报错：改为可操作错误，并正确解析 macOS osxkeychain 凭据助手
- 分支下拉菜单在外部 checkout 后点击无效：改用实时分支名判断当前分支
- 拉取 / 推送按钮补齐与刷新一致的成功对号反馈
- 远程 WebUI 窄屏下右侧文件面板被裁掉一半：改为整行宽浮层展开
- 变更面板行布局简化：状态 | 路径 | 自适应 stats，去掉空置尾列
- Windows CI 换行与路径转义相关测试修复；内置智能体提示词固定 LF，发布流程补哈希门禁
- react-doctor 体检问题全量修复（评分 76 → 100）

🧹 内部优化
- 后端：引擎新增 Transport / host_command 抽象与 set_stdin，codex / grok / kimi / opencode 拆出独立会话适配模块；历史新增 FTS5 检索
- 前端：设置壳层重写，时间线搜索抽为 useTimelineSearch，中心页签抽为 center-tabs，render 期 ref 写入全部移入 effect
- 仓库清理：移除入库的 CI 验证产物（约 52 MB）并加入 .gitignore；渠道家族模型映射改按 ANTHROPIC_DEFAULT_*_MODEL 的 key 模式派生
- CI：新增 PR 目标分支守卫（非发布分支禁止直提 main）与 PR 模板，Windows 发布打包前先跑 cargo test --lib
- Computer Use 后端能力落地（OMP 的 MCP 注入、macOS AX 无障碍树交互、虚拟光标覆盖层），前端入口因尚未打磨好暂先下线`,
      en: `✨ Features
- **Full-text search across messages**: the ⌘L palette now matches message bodies on top of titles (FTS5 trigram index with background incremental indexing), with relevance/recency sorting and an indexing-progress hint; short tokens fall back to a LIKE exact match
- **Search within a session**: ⌘F finds messages in the open session and steps through matches with highlighting; the shortcut is remappable in Settings
- **Built-in slash commands**: /new, /clear, and /compact are handled by the front end, with a new "Built-in" group in the slash picker; same-named catalog commands still win, and compaction shows "Compacting context…" in the status bar
- **Question cards reach more engines**: Codex and Grok answer through their own transports (app-server / ACP), Kimi through ACP elicitation forms, pi via the bundled ask-bridge extension exposing an ask_user tool, omp in rpc-ui mode, and DSH / OpenCode through $events/result and managed-server replies
- **Multi-select rounds reworked**: options can be deselected, a single-select answer advances to the next unanswered question, Enter jumps ahead when questions remain (with a remaining-count hint), multi-select answers are collected locally and submitted as one batch with rollback on failure, and cards omit free-text input when the protocol accepts declared options only
- **Reasoning effort across every engine**: request-level effort injection for all CLIs, passed through verbatim (xhigh / ultra are no longer rewritten to max / high); new sessions default to medium, fixing switching that silently did nothing
- **Curtain shows the real model and effort**: it reads the run's reported model/effort instead of the original request parameters
- **Fullscreen Settings**: the overlay modal becomes a fullscreen shell with rail search, collapsible groups whose state persists, and regrouping into System / Plugins / CLI management / Workspace & data / Other, with not-installed and disabled CLIs as their own groups
- **Discard changes**: unstaged and untracked files can be discarded one by one or via a group-level "Discard all", both behind a danger confirmation (tracked files restore the worktree, untracked files are deleted, the staged group offers no discard)
- **Changes panel follows nested repos**: when the panel follows the file tree into a submodule it shows a repository badge, so a stage/commit never silently targets a non-root repo
- **Terminal improvements**: absolute paths in output are clickable and reveal in the file manager; selected text has a right-click copy menu
- **Usage: this year / all time**: the all-time range reads the whole ledger (no longer truncated at 365 days) and the chart re-bases its axis — per month for the year, per CLI for all time
- **Channel picker improvements**: providers move into a height-capped, filterable dropdown, switching a channel refreshes that channel's mapped models immediately, engines without channels no longer render an empty filter box, and the engine panel switches on click instead of hover
- **DSH image attachments**: paste, pick, or drop images; for custom llm-pi-ai routes ccgui declares image input before sending
- **Linux .rpm package** (zstd-compressed, requires rpm ≥ 4.14), plus a ten-engine feature compatibility matrix in the README
- **Plugin SDK 0.3.12 / 0.3.13**: sidebar nav entries (ui:sidebar-entry), center tabs (ui:center-tab), and plugin agent runs (agent permission; events on a separate plugin-agent://event stream that chat's Stop cannot kill); new shared @ccgui/plugin-ui component package
- .md files open in preview mode by default; the CSP allows https: images so remote images render

🐛 Fixes
- Dragging selected text could lock the page: pointer capture is released explicitly and window listeners are cleaned up when a drag ends
- Concurrent-slot leak: panicking or dropped runs now clean up through Drop (plus a virtual-run guard), so a stale slot no longer blocks new sessions with "too many concurrent runs"
- Plugins couldn't read the active session during startup: session activation events now support sticky replay and are broadcast when the engine picker switches a pending session
- pi's stdin lacked its terminating newline, producing parse-failure warning banners
- Upstream 400 errors showed raw JSON in the banner; they now render a readable message
- Untracked files previewed as empty; diff generation moved off the IPC thread and is capped at 2 MiB, so large files no longer block the UI
- git remote authentication failures surfaced a misleading libgit2 error; they now return an actionable message and parse the macOS osxkeychain credential helper
- The branch dropdown no-op'd after an external checkout because it compared a stale branch name
- Pull/push buttons now show the same success check feedback as refresh
- A narrow remote WebUI clipped the right-side file panel; it now expands as a full-width overlay
- The changes panel row layout is simplified to status | path | self-sizing stats, dropping the empty trailing column
- Windows CI line-ending and path-escaping tests fixed; bundled agent prompts are pinned to LF with a hash gate in the release workflow
- react-doctor findings fixed across the board (score 76 → 100)

🧹 Internal
- Backend: engines gain a Transport / host_command abstraction with set_stdin; codex, grok, kimi, and opencode move to dedicated session adapters; history gains FTS5 search
- Frontend: settings shell rewritten, timeline search extracted into useTimelineSearch, center tabs extracted, and all render-phase ref writes moved into effects
- Repo hygiene: removed ~52 MB of committed CI verification artifacts and gitignored them; channel family-model mapping now derives from the ANTHROPIC_DEFAULT_*_MODEL key pattern
- CI: PR target-branch guard (non-release branches cannot open PRs against main) with a PR template; Windows releases now run cargo test --lib before packaging
- Computer Use backend landed (OMP MCP injection, macOS AX-tree interaction, virtual-cursor overlay) while the front-end entry is withdrawn for now pending polish`,
    },
  },
  {
    version: "1.0.5",
    date: "2026-09-19",
    content: {
      zh: `✨ 新功能
- **内置浏览器标签页**：应用内打开网页，原生子 webview 渲染；地址栏与页签标题跟随真实导航，target=_blank 链接改为当前页签内打开，页签关闭即销毁 webview
- **会话归档**：侧栏右键菜单归档会话，设置页新增「归档会话」管理面板，可查看与恢复
- **会话搜索弹窗**：侧栏顶栏搜索框退役，改用搜索图标或 ⌘L 打开会话标题搜索弹窗
- **启动脚本**：按工作区配置启动脚本，可从会话工具区快速运行
- **图片预览增强**：图片灯箱查看器，支持消息与附件图片放大浏览
- **工作区右键新建**：文件树与工作区支持右键新建文件 / 文件夹
- **Markdown GitHub 风格 alert**：支持 > [!NOTE] / [!WARNING] 等提示框，极简左边线样式
- **输入框拖拽文件回归**：图片拖入转为附件，其他文件插入 @引用
- **删除确认气泡**：删除会话等危险操作改为就地气泡确认
- **检查更新反馈**：已是最新时明确展示版本号与发布日期，结果不再 2 秒消失
- 侧栏新增置灰的「自动化」入口，悬停 / 点击提示「即将开放」
- 插件 SDK 0.3.11：修复 registerComposerSlot 权限漂移——自 0.3.9 改名后仍校验旧字符串 ui:composer 导致任何声明都被拒绝，改为校验 ui:composer-status

🐛 修复
- 折叠长消息改为裁剪高度，不再残留淡出残影
- 失败会话的历史索引与删除：失败会话可被正确索引并彻底删除
- 长用户消息气泡不再向左溢出
- 上下文用量表盘分子卡在整轮累加值，恢复实时按 token 更新
- 引擎进程注册表泄漏：中断 / 退出路径正确注销进程句柄
- 移动端网页模式移除「添加工作区」入口
- 「关于」页移除重复的版本记录入口

🧹 内部优化
- 后端模块化拆分：引擎拆出 reader / registry / events，历史发现与扫描分离，Web 后端拆出 dispatch 层
- 聊天 store 拆分为 composer / sessions / tabs / workspaces / messaging 等模块
- 插件市场页面精简`,
      en: `✨ Features
- **Built-in browser tabs**: open web pages inside the app via native child webviews; the address bar and tab title follow real navigations, target=_blank links navigate the current tab, and closing a tab destroys its webview
- **Session archive**: archive sessions from the sidebar context menu, with a new "Archived sessions" pane in Settings to browse and restore them
- **Session search palette**: the sidebar top-bar search field is retired — open session title search via the search icon or ⌘L
- **Launch scripts**: per-workspace startup scripts, runnable from the session toolbar area
- **Image preview upgrade**: lightbox viewer for message and attachment images
- **Workspace right-click create**: create files/folders from the file tree and workspace context menus
- **GitHub-style Markdown alerts**: > [!NOTE] / [!WARNING] and friends, rendered with a minimal left-border style
- **Composer file drag-and-drop returns**: dropped images become attachments, other files insert @ references
- **Delete confirmation popover**: destructive actions like session deletion now confirm in place
- **Update check feedback**: "already up to date" now shows the version and release date and no longer vanishes after 2 seconds
- Sidebar gains a greyed-out "Automation" entry with a "coming soon" hint
- Plugin SDK 0.3.11: fixes registerComposerSlot permission drift — it still validated the old ui:composer string after the 0.3.9 rename, rejecting every manifest; it now checks ui:composer-status

🐛 Fixes
- Collapsed long messages clip their height instead of leaving a fading ghost
- Failed sessions are correctly indexed in history and can be fully deleted
- Long user message bubbles no longer overflow to the left
- Context-usage gauge numerator no longer sticks at the whole-turn cumulative value; it updates per token again
- Engine process registry leak: interrupt/exit paths now deregister process handles
- Mobile web mode no longer shows the "add workspace" entry
- Removed the duplicate version-history entry on the About page

🧹 Internal
- Backend modularization: engine split into reader / registry / events, history discovery separated from scanning, Web backend gains a dispatch layer
- Chat store split into composer / sessions / tabs / workspaces / messaging modules
- Plugin marketplace page simplified`,
    },
  },
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
