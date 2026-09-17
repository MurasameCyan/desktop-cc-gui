# CC GUI 插件开发与提交规范

> **版本**：v0.1（规范草案，随插件系统 Phase 1 落地生效）
> **适用对象**：社区插件开发者、AI 生成插件的使用者、市场审核人员
> **关联文档**：[插件化系统总体计划](../.omx/plans/plugin-system-plan.md)

本文档是向 CC GUI 插件市场提交插件的**唯一权威规范**。插件从开发、打包、发版到上架的全部要求都在这里。

---

## 目录

1. [插件是什么](#1-插件是什么)
2. [三层信任模型](#2-三层信任模型)
3. [快速开始](#3-快速开始)
4. [插件仓库结构规范](#4-插件仓库结构规范)
5. [manifest.json 字段规范](#5-manifestjson-字段规范)
6. [插件 SDK API 参考](#6-插件-sdk-api-参考)
7. [权限规范](#7-权限规范)
8. [声明式插件（Tier-0）规范](#8-声明式插件tier-0规范)
9. [构建与发版规范](#9-构建与发版规范)
10. [上架流程（提交到市场）](#10-上架流程提交到市场)
11. [审核标准与禁止事项](#11-审核标准与禁止事项)
12. [版本更新与兼容性策略](#12-版本更新与兼容性策略)
13. [用户数据与安全规范](#13-用户数据与安全规范)
14. [FAQ](#14-faq)

---

## 1. 插件是什么

CC GUI 插件是一个**托管在 GitHub 上的独立仓库**，通过 GitHub Releases 分发，用户可以一键安装、升级、卸载。插件可以：

- 修改界面样式（主题、输入框样式、布局微调）
- 新增设置页、侧边栏面板、状态栏组件、命令面板命令
- 注册 Markdown 渲染组件、Composer 插槽内容
- 读取宿主提供的只读事件（如用量统计 `usage://updated`）
- 在自己的 KV 命名空间里持久化数据

插件**不得**（由安装期评审 + 权限门面共同约束，见 §7）：

- 直接调用 Tauri IPC（`window.__TAURI__` 在插件加载前已被移除——这是收敛面，不是不可绕过的沙箱，见 §7）
- 访问文件系统、终端、其他插件的数据
- 未经 `network` 权限声明就发起网络请求
- 新增 AI 引擎或 Rust 命令（编译期固化，不在插件能力面内）

## 2. 三层信任模型

| 层级 | 形态 | 能力 | 上架要求 |
|---|---|---|---|
| **Tier-0 声明式** | 纯 JSON + CSS，**零 JavaScript** | 主题/样式、菜单行、设置项、状态栏文本 | 审核从简（无代码可审） |
| **Tier-1 JS（市场）** | 单文件 ESM bundle + manifest | 完整 SDK 扩展点 API | PR 人工审核；可选 minisign 签名获「已验证」徽章 |
| **Tier-2 JS（个人/AI 生成）** | 同 Tier-1，未签名 | 同 Tier-1 | **不上架**，仅本地安装，安装时用户须确认代码 diff + 权限清单 |

> 建议：只做样式/主题/菜单的插件**优先做成 Tier-0**——审核最快、用户信任成本最低、AI 也能可靠生成。

## 3. 快速开始

```bash
# 1. 从官方模板创建仓库（GitHub → Use this template）
#    https://github.com/<org>/ccgui-plugin-template

# 2. 克隆并安装
git clone https://github.com/<you>/ccgui-plugin-hello.git
cd ccgui-plugin-hello && pnpm install

# 3. 开发（产物三件套输出到 dist/）
pnpm dev        # 监听构建
pnpm build      # 产出 main.js + manifest.json + styles.css
pnpm validate   # 本地校验 manifest 与产物

# 4. 本地调试：CC GUI → 设置 → 插件 → 从本地目录安装（指向 dist/）

# 5. 发版：打一个与 manifest.json version 一致的 tag
git tag 1.0.0 && git push origin 1.0.0
#    GitHub Action 自动构建并将三件套附加到 Release

# 6. 上架：向索引仓库提 PR（见 §10）
```

## 4. 插件仓库结构规范

### 4.1 必须满足的仓库布局

```
ccgui-plugin-hello/
├── manifest.json          # 【必须】仓库根目录，见 §5
├── src/
│   └── index.ts           # JS 插件入口（Tier-0 可没有 src/）
├── styles.css             # 【可选】样式源文件
├── README.md              # 【必须】市场详情页直接渲染它
├── LICENSE                # 【必须】开源许可证
├── .github/workflows/release.yml   # 模板自带，勿删改核心步骤
└── dist/                  # 构建产物（.gitignore，不入库）
    ├── main.js
    ├── manifest.json
    └── styles.css
```

### 4.2 硬性要求

1. **`manifest.json` 必须在默认分支的根目录**——市场按「默认分支根目录 manifest 的 version」查找同 tag 的 Release（与 Obsidian 相同约定）。
2. **Release 附件文件名固定**：`main.js`、`manifest.json`、`styles.css`（Tier-0 允许只有后两个）。改名 = 无法安装。
3. **Release tag 必须等于 manifest.json 的 `version`**（如 tag `1.2.0` ↔ `"version": "1.2.0"`），不带 `v` 前缀。
4. **单文件 ESM bundle**：所有第三方依赖在构建期打进 `main.js`；运行时**禁止** `import` 任何外部模块（宿主提供的基座除外，构建模板已将 `react`/`react-dom`/`@ccgui/plugin-sdk` 标记为 external）。
5. **体积**：bundle ≤ 512KB（CI 警告阈值），硬上限 2MB（gzip 前）。超出硬上限 CI 直接拒绝。

## 5. manifest.json 字段规范

完整示例：

```jsonc
{
  // ── 必填 ──────────────────────────────
  "id": "usage-stats",              // 全局唯一；小写字母/数字/连字符的点分段，总长 ≤ 64，
                                    // 例如 vendor.usage-stats；禁止空段、路径分隔符、`.`、`..`
  "name": "用量统计",                // 显示名，≤ 30 字符
  "version": "1.2.0",               // semver，必须与 Release tag 一致
  "minAppVersion": "1.1.0",         // 最低宿主版本，低于此版本的 App 不加载本插件
  "author": "zhangsan",             // GitHub 用户名或组织名
  "description": "统计各引擎 token 用量与花费",  // ≤ 120 字符
  "repo": "zhangsan/ccgui-plugin-usage-stats",  // owner/repo 形式
  "tier": "js",                     // "declarative" | "js"
  "license": "MIT",

  // ── 可选 ──────────────────────────────
  "permissions": [                  // 必填；仅声明实际使用的能力，见 §7
    "storage",
    "ui:settings-section",
    "events"
  ],
  "contributes": {                  // 声明式贡献点（Tier-0 全靠它；JS 插件也可静态声明）
    "settingsSections": [{ "key": "usage", "titleKey": "usage.title", "icon": "chart" }],
    "panelTabs":        [{ "id": "usage", "titleKey": "usage.tab", "icon": "chart" }],
    "statusBarItems":   [{ "id": "usage", "alignment": "right" }],
    "commands":         [{ "id": "usage.open", "titleKey": "usage.cmd.open" }],
    "themes":           [{ "id": "midnight", "name": "Midnight", "dark": true, "css": "themes/midnight.css" }],
    "i18n":             [{ "lang": "zh-CN", "ns": "usage", "file": "i18n/zh-CN.json" }]
  },
  "configSchema": {                 // JSON Schema（draft 2020-12），市场自动生成设置表单
    "configVersion": 2,             // 配置结构版本，破坏性变更时 +1，见 §12.3
    "type": "object",
    "properties": {
      "currency":  { "type": "string", "enum": ["CNY", "USD"], "default": "CNY", "title": "货币" },
      "apiToken":  { "type": "string", "title": "API Token", "ccgui:role": "secret" }
      //                                                              ^ secret 字段仅写入不回显
    }
  },
  "screenshots": ["docs/screenshot-1.png"],   // ≤ 5 张，市场详情页展示
  "keywords": ["usage", "token"]               // ≤ 8 个，市场搜索
}
```

**字段校验规则**（索引仓 CI 强制执行）：

| 规则 | 说明 |
|---|---|
| `id` 稳定性 | 一旦上架**永不更改**；更新、卸载、用户数据都按 id 寻址 |
| `version` 单调 | 新版本 semver 必须严格大于索引中已登记版本 |
| `minAppVersion` 真实 | CI 会检查插件用到的 SDK API 在该宿主版本是否已存在 |
| `permissions` 最小化 | CI 对比代码实际行为与声明，多余声明会在 PR 中评论要求删减 |
| `description` 诚实 | 功能描述与实际行为不符 = 拒审 |

## 6. 插件 SDK API 参考

### 6.1 入口约定

`main.js` 的默认导出是唯一入口：

```ts
import type { PluginContext } from '@ccgui/plugin-sdk';

export default function activate(ctx: PluginContext): void | (() => void) {
  // 所有 register* 都返回 Disposer；宿主在卸载时也会逆序兜底回收。
  ctx.ui.registerSettingsSection({ key: 'hello', label: () => 'Hello', component: HelloSection });

  // 也可返回总清理函数，负责停止插件自行创建的定时器等副作用。
  return () => { /* stop timers, cancel subscriptions */ };
}
```

**生命周期纪律**：

- `activate` 必须是同步返回（异步初始化放函数体内 fire-and-forget，或经 `ctx.events` 等待）。
- 所有副作用必须有对应的 disposer——泄漏副作用（卸载后 UI 残留、定时器存活）是拒审理由。
- 插件抛错不会拖垮宿主：每个插件 UI 挂载点有 ErrorBoundary 隔离；崩溃次数达阈值插件被自动隔离（quarantine），用户可在插件页手动恢复。

### 6.2 PluginContext

```ts
interface PluginContext {
  readonly pluginId: string;
  readonly version: string;
  readonly react: typeof import('react');

  hooks: {
    registerSessionHooks(hooks: SessionHooks): Disposer;
    registerTurnHooks(hooks: TurnHooks): Disposer;
    registerRuntimeSwitchHooks(hooks: RuntimeSwitchHooks): Disposer;
  };
  workspace: { getMetadata(): Promise<{ id: string; path: string }> };
  documentStorage: DocumentStorage;

  ui: {
    registerSettingsSection(d: SettingsSectionDef): Disposer;
    registerAddMenuRow(d: AddMenuRowDef): Disposer;
    registerComposerSlot(d: ComposerSlotDef): Disposer;
    registerPanelTab(d: PanelTabDef): Disposer;
    registerStatusBarItem(d: StatusBarItemDef): Disposer;
    registerCommand(d: CommandDef): Disposer;
    registerSessionMenuItem(d: Omit<SessionMenuItemDef, "id"> & { key?: string }): Disposer;
    openSettings(key?: string): void; // 跳转到本插件设置页（0.3.6 起）
    registerMarkdownRenderer(d: MarkdownRendererDef): Disposer;
    registerPage(d: PageDef): Disposer;
    registerTimelineRowRenderer(d: TimelineRowRendererDef): Disposer;
    registerWorkspaceMenuItem(d: Omit<WorkspaceMenuItemDef, "id"> & { key?: string }): Disposer;
  };
  theme: { injectCss(css: string): Disposer; setTokens(tokens: ThemeTokens): Disposer };
  i18n: { addBundle(lang: string, ns: string, resources: object): Disposer };
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  events: { on(topic: string, cb: (data: unknown) => void): Disposer; emit(topic: string, data: unknown): void };
  bridge: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  host: { appVersion: string; sdkVersion: string; locale: string; isWeb: boolean };
}
```

生命周期 hook 按插件注册顺序调用且逐插件隔离错误；`beforeTurn` 与 `beforeSwitch` 最多等待 2 秒，超时或异常均不阻断聊天或客户端切换。`beforeTurn` 可返回 `PromptContribution[]` 及内部消息捕获声明。内部提示不会进入 CCGUI 聊天画布、乐观用户消息或标题；当 CLI 无真正 system channel 时，`system-tail` 会降级为带清晰标记的 request tail，因此仍可能进入 CLI 自身原生历史。

`turnId` 在 `beforeTurn`、运行时事件和 `afterTurn` 之间保持稳定；`runId` 可能从启动前占位 ID 重绑定为引擎运行 ID。引擎启动失败也会派发一次 `afterTurn`，状态为 `failed`，尚无原生会话时 `sessionId` 为 `null`。插件应按 `turnId` 清理临时状态。`PromptContribution.onAccepted` 只在贡献通过预算且启动成功后调用；失败的发送不能据此登记为已消费。

`BeforeTurnResult.isCurrent` 是可选的纯同步生命周期守卫，用于某个工作区关闭功能、但插件仍在其他工作区运行的情形。宿主在收集结果、再次注入及启动接纳时检查；返回 `false` 或抛错会撤销该结果，已失效的生命周期不得再返回 `true`。已返回的结果必须捕获其原始生命周期，不能只读取可能再次开启的全局布尔值。这不是回滚或取消已发出任务的接口：已发出的工作允许自然完成。

宿主不会重新注入已注销注册者的缓存提示。原生 CLI 历史无法抹去，因而停用后的下一次发送会携带一次性旧指令撤销；启动失败则保留重试，接纳后不重复发送。撤销不删除历史任务事实，也不启动插件读写。旧指令撤销是发送给模型的提示，不保证任意模型遵从，不能作为技术安全边界。

`ctx.ui.registerWorkspaceMenuItem`（权限 `ui:workspace-menu`）的 `label`、`visible` 和 `onSelect` 接收右键目标 `{ workspaceId, archived }`，不是当前活动工作区。菜单项应绑定用户看到的动作，避免异步保存完成后把旧的“停用”选择反转成“启用”。返回的 Disposer 及插件卸载均会移除菜单项。

`ctx.ui.registerSessionMenuItem`（权限 `ui:session-menu`，0.3.5 起）向侧栏会话右键菜单追加行；`run` 接收打开菜单的目标会话 `{ engine, sessionId }`，`label` 是随语言切换重新求值的函数。它与工作区菜单是独立的扩展点。`ctx.ui.openSettings(key?)`（复用权限 `ui:settings-section`，0.3.6 起）跳转到本插件设置页；`key` 对应 `registerSettingsSection` 的子 key，省略时打开主 section。SDK 0.4.1 同时保留这两项能力和工作区菜单。

`ctx.documentStorage` 是 `ctx.storage` KV 之外的受控 UTF-8 文档存储：根目录固定隔离在 `<所选位置>/plugin-data/<plugin-id>/`，路径必须相对且不能逃逸；`writeTextAtomic(path, content, expectedVersion)` 使用不透明版本做 CAS，`expectedVersion: null` 表示要求文件尚不存在。`selectLocation('custom')` 由宿主打开目录选择器，插件不能提交任意绝对根路径。

### 6.3 标准化运行时事件（只读）

`TurnHooks.onRuntimeEvent` 接收宿主可确定的 `NormalizedRuntimeEvent`：`file-changed`、`command-started`、`command-finished`、`tool-finished`、`assistant-completed`、`turn-cancelled`、`turn-failed`、`runtime-exited`。公共字段包括 `eventId/runId/turnId/engine/sessionId/workspaceId/workspacePath/occurredAt/kind`；只有 adapter 确定知道的命令、退出码、文件变化和状态才会出现，宿主不会从模型正文推断事实。

> 想消费这里没有的宿主事实？到索引仓开 issue 提议通用事件，不要绕过 SDK 抓 DOM/store。

### 6.4 UI 组件纪律

- 用宿主提供的 React 实例（构建模板已配置 external）；**禁止**自带 React 副本。
- 样式优先用 BoardUI 语义 token（`bg-background-*`、`text-text-*` 等），**禁止**写死 hex 颜色——深色模式靠 token 自动翻转。
- 插件 UI 文本必须走 `ctx.i18n` 注册的资源，至少提供 `en` 与 `zh-CN`。

## 7. 权限规范

| 权限 | 能力 | 审核强度 |
|---|---|---|
| `storage` | 使用 `ctx.storage` KV | 低 |
| `ui:*`（`ui:settings-section`、`ui:add-menu`、`ui:composer`、`ui:panel-tab`、`ui:status-bar`、`ui:page`、`ui:command`、`ui:markdown`、`ui:timeline-row`、`ui:workspace-menu`、`ui:session-menu`） | 对应 UI 扩展点；`openSettings` 复用 `ui:settings-section` | 低 |
| `theme` | 注入 CSS / 覆盖 token | 低（Tier-0 隐含拥有） |
| `i18n` | 注册语言资源 | 低 |
| `events` | 插件事件总线；订阅涉及用户行为数据的宿主事件时须在 description 说明用途 | 按订阅数据评审 |
| `session.lifecycle.read` | 观察 session 新建、恢复、关闭 | 中 |
| `runtime.events.read` | 读取标准化运行时事实 | 中 |
| `runtime.switch.observe` | 观察切换前后生命周期；失败不阻断切换 | 中 |
| `workspace.metadata.read` | 读取稳定 workspace ID 与绝对路径 | 中 |
| `plugin.storage` | 使用受控文档存储和位置选择 | 中 |
| `prompt.contribute.internal` | 向有效 CLI 请求加入用户不可见的内部提示，并接收捕获的内部消息 | 高（安装时必须明确告知） |
| `network:none` / `network:<host>[:port或范围]` | 声明无网络，或授权宿主代理访问精确 host | 高 |
| `exec:<bin>` | 授权宿主执行精确裸命令名 | 高 |

1. 未声明的权限调用会被门面拒绝并记录——这是**评审/DX 门**（拦截误用、给评审提供可审计面），不是技术强制边界；市场版本新增权限必须显著提示用户。
2. 网络和进程能力仅经 `ctx.bridge.invoke` 的宿主代理命令执行；插件没有原始 `fetch`，`network`/`exec` 授权不接受通配符或路径。
3. `prompt.contribute.internal` 的内容对 CCGUI 用户界面不可见，必须按不可信数据处理；nonce 只做 turn 关联，不构成认证。
4. 申请用不到的权限会被 CI 标记，审核员会要求删减。

> **权限模型的性质（务必理解）**：JS 插件与宿主 UI **同源**运行在同一 webview 中。`ctx` 权限门面与 Rust 侧桥命令的安装/启用/授权校验是**评审与开发体验（DX）门**——拦截误用与意外越权，并为市场评审提供可审计面，**不是技术强制沙箱**：同源 JS 仍可通过异步续体、React 事件 handler、同源 iframe 等绕过门面直接触达 IPC，Tauri IPC 也无法在进程内区分宿主 UI 与插件 JS。真正的边界是**安装期评审 + 隔离/隔离区（quarantine）+ 卸载与生命周期追踪**；彻底的进程级隔离属后续架构演进。因此插件作者须以「最小权限、诚实声明」自律，评审员以 manifest 声明与实际行为的一致性为准。

## 8. 声明式插件（Tier-0）规范

Tier-0 插件 = `manifest.json` + CSS/i18n 资源，**不含任何 JS**。宿主解释 `contributes` 执行。

```jsonc
// manifest.json —— 一个主题插件的完整示例
{
  "id": "theme-midnight",
  "name": "Midnight 主题",
  "version": "1.0.0",
  "minAppVersion": "1.1.0",
  "author": "you", "description": "深蓝午夜主题", "repo": "you/ccgui-plugin-midnight",
  "tier": "declarative",
  "license": "MIT",
  "contributes": {
    "themes": [{ "id": "midnight", "name": "Midnight", "dark": true, "css": "styles.css" }]
  }
}
```

```css
/* styles.css —— 只允许覆盖语义 token 与安全属性 */
.dark {
  --background-primary-default: #0d1117;
  --text-primary: #e6edf3;
}
```

**CSS 约束**（CI 静态解析强制）：

- 禁止 `@import`；禁止 `url()` 引用远程资源（`data:` 内联允许，单文件 ≤ 100KB）。
- 禁止 `position: fixed` 全屏遮罩、禁止 `z-index` > 1000、禁止 `!important`（token 覆盖除外）。
- 禁止隐藏/遮挡宿主核心 UI 的选择器（审核员人工判断，如 `display: none` 作用于发送按钮）。

## 9. 构建与发版规范

### 9.1 构建（模板已配置好，无需手改）

- Vite lib mode 输出单文件 ESM；`react`、`react-dom/jsx-runtime`、`@ccgui/plugin-sdk` 标记 external（运行时由宿主基座注入）。
- `pnpm validate` 本地跑与市场 CI 相同的检查：manifest schema、bundle 体积、权限-代码比对、CSS 静态解析、黑名单扫描（`eval` / `new Function` / `__TAURI__` / `localStorage` / 远程 `import(`）。

### 9.2 发版

1. `manifest.json` 的 `version` +1（semver，见 §12）。
2. `git tag <version> && git push origin <version>`（tag = version，无 `v` 前缀）。
3. 模板自带 GitHub Action 构建三件套并附加到该 tag 的 Release。
4. **已进市场的插件**：另需向索引仓提「版本登记 PR」（见 §10.3），否则用户收不到更新。

### 9.3 可选：minisign 签名（「已验证」徽章）

```bash
minisign -Sm dist/main.js -p your-plugin.pub   # main.js.minisig 一并传到 Release
```

将公钥登记在索引仓的 `plugins/<id>.json`。签名非强制，但带徽章的插件在市场上标识为「已验证」，且**权限升级时用户无需重新确认**。

## 10. 上架流程（提交到市场）

市场 = 中央索引仓库 `ccgui-plugins`（纯 GitHub，无自建服务器）。

### 10.1 首次上架

1. Fork 索引仓库。
2. 在 `community-plugins.json` 追加一条（保持按 id 字典序）：

```json
{ "id": "usage-stats", "repo": "zhangsan/ccgui-plugin-usage-stats" }
```

3. 新增 `plugins/usage-stats.json`：

```json
{
  "id": "usage-stats",
  "name": "用量统计",
  "author": "zhangsan",
  "description": "统计各引擎 token 用量与花费",
  "keywords": ["usage", "token"],
  "signingPubkey": null
}
```

4. 提 PR。CI 自动执行：
   - 仓库结构检查（根 manifest、LICENSE、README、release.yml）
   - manifest schema 校验 + `id` 唯一性 + `version` ↔ 最新 Release tag 一致性
   - 下载 Release 产物：SHA256 登记、bundle 体积、黑名单扫描、权限-代码比对
   - 生成**审核报告**评论在 PR 里（权限清单、网络域名、体积、扫描结果）
5. 人工审核（通常 3 个工作日内）：按 §11 标准过一遍，通过后合并即上架。

### 10.2 上架后用户侧流程（你无需关心，供理解）

App 市场页 → Rust 拉索引 → 用户点安装 → 从 Release 下载三件套 → 校验 SHA256 → staging 目录 → 健康检查（冷加载 activate 一次）→ 原子替换生效。任一步失败，已装版本不受影响。

### 10.3 版本更新

1. 按 §9.2 在你的仓库发新 Release。
2. 向索引仓提「版本登记 PR」（只改 `plugins/<id>.json` 无代码变更时，机器人可自动合并）。
3. 权限有新增 → 转人工审核，且老用户升级时会看到权限 diff 确认。
4. App 端每 24h 比对索引版本，向用户提示可更新。

### 10.4 下架

- 作者主动下架：PR 删除索引条目（用户已装副本不受影响）。
- 违规下架：维护者可标记 `plugins/<id>.json` 为 `"delisted": true`，市场隐藏且已装用户收到安全提示。

## 11. 审核标准与禁止事项

### 11.1 一律拒审的行为

| 禁止事项 | 原因 |
|---|---|
| `eval`、`new Function`、远程 `import()`、`<script>` 注入 | 远程代码执行面 |
| 访问 `window.__TAURI__` / `__TAURI_INTERNALS__` / 宿主内部 store | 绕过权限模型 |
| 读写 `localStorage` | 跨插件污染，须用 `ctx.storage` |
| 混淆/压缩到不可读的代码（合理 minify 除外，需附 sourcemap 或源码对应关系） | 可审核性 |
| 收集用户对话内容、API key、文件路径并外发 | 隐私红线，永久拉黑作者 |
| 未声明的 `network` 行为、域名白名单外的请求 | 权限模型 |
| `description` 与实际功能不符、伪装成官方插件 | 信任 |

### 11.2 审核员 checklist（公开版）

1. manifest 与实际行为一致（功能、权限、域名）。
2. 全部副作用有 disposer，卸载后 UI/DOM/事件无残留。
3. UI 用 BoardUI token，深浅色模式均可用；i18n 至少 en + zh-CN。
4. 崩溃不拖垮宿主（ErrorBoundary 内渲染，无全局异常吞噬）。
5. README 说清楚：干什么、要什么权限、数据去哪。
6. 无 §11.1 禁止事项。

### 11.3 质量标准（不强制但影响推荐位）

- bundle 小、激活快（activate < 50ms）、无控制台噪音。
- 提供截图、关键词准确、configSchema 有合理的默认值与 `title`（市场自动生成表单直接可读）。

## 12. 版本更新与兼容性策略

### 12.1 semver 纪律

- **patch**：bug 修复，不变 SDK 用法。
- **minor**：新增能力/权限（权限 diff 会提示用户）。
- **major**：破坏性变更（配置结构、贡献点 id 变更）。

### 12.2 宿主兼容性

- `minAppVersion` 决定哪些 App 版本能装。宿主 SDK 按 semver 演进，废弃 API 至少保留一个大版本并提前在索引仓公告。
- 宿主升级后若插件 `minAppVersion` 不再满足，插件被**自动禁用**并在市场页提示「等待插件更新」——用户数据保留。

### 12.3 配置迁移（`configVersion`）

`configSchema` 破坏性变更时 `configVersion` +1。宿主升级插件后：已知键保留、被删键丢弃、新键补默认值。需要自定义迁移的，在 `activate` 里读旧值自行处理后再写回。

### 12.4 用户数据

- 用户卸载插件时可选择「保留数据」（默认保留 30 天后自动清理）或「立即删除」。插件**不得**在卸载路径上做阻止、隐藏数据等对抗行为。

## 13. 用户数据与安全规范

1. **最小采集**：只拿实现功能必需的数据；session、runtime 和 workspace 数据禁止无授权外发。
2. **secret 字段**（`ccgui:role: "secret"`）仅写入不回显，存于每插件隔离 KV；禁止把 secret 打到日志。
3. **网络请求**：仅限 `network:<host>[:port或范围]` 授权；禁止把用户对话内容、文件路径、API key 作为请求参数外发。
4. **依赖供应链**：构建期依赖锁定（lockfile 入库）；Release 产物必须由模板 Action 从源码构建——**禁止手工上传本地构建的产物**（CI 会比对）。
5. 发现安全漏洞：向索引仓 Security Advisory 私密报告，48h 内响应；确认后下架受影响版本。

## 14. FAQ

**Q：我的插件需要一个 SDK 没有的能力（新事件、新扩展点）？**
A：到索引仓开 issue 描述场景。宿主每版本评估扩展 SDK；SDK 走 semver，废弃 API 提前一个大版本公告。

**Q：插件能用 npm 依赖吗？**
A：能，但全部在构建期打进单文件 bundle（注意 2MB 硬上限）。运行时禁止加载任何外部模块。

**Q：为什么插件不能直接用 `fetch`？**
A：CSP 与信任模型要求网络 IO 走 `ctx.bridge.invoke` 的宿主代理，并用 `network:<host>[:port或范围]` 精确授权。

**Q：AI 生成的插件能上架吗？**
A：可以，与人工插件同标准审核；上架前请在 PR 里注明「含 AI 生成代码」。未上架的 AI 生成插件按 Tier-2 个人插件在本地使用（生成时会向你展示代码 diff 与权限清单，确认后生效）。

**Q：插件之间能互相依赖/通信吗？**
A：没有插件间依赖机制（刻意决策，避免依赖地狱）。事件总线允许 `plugin:<id>:` 前缀的事件，跨插件协作属高级用法，文档不承诺兼容。

**Q：我的插件违规被下架了，申诉渠道？**
A：索引仓开 issue 并 @maintainers，说明整改内容；隐私红线类违规不接受申诉。

---

*本规范随插件系统版本演进，变更历史见索引仓库 `SPEC-CHANGELOG.md`。*
