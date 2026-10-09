# 六个订阅合规接入 + 每次做完自动总结 + 开发者模式验收（参考 t3code）

> 状态：**只是计划，尚未实施**。每个里程碑单独可交付，等用户点头再动手。

## 给实施者（接手的模型先读这一节）
- **一次只做一个里程碑**，按文末「推荐顺序」；做完跑「验证」里的检查、记 `docs/state/progress.md`、提交，再等用户确认下一个。
- **M0 的结论决定 M2 / M3 / M7 的分支**（Cursor 走 ACP 还是 SDK、OpenCode 走 ACP 还是 SDK、Claude 走哪种登录）：没有用户在本机跑过 `scripts/acp-probe.mjs` 的结果，不要开始 M3。
- 写 Next.js 代码前按 `AGENTS.md` 读 `node_modules/next/dist/docs/` 里对应的指南（本仓库是 Next 16，与训练数据不同）。
- 用户的机器是 **Windows**（PowerShell 窗口里跑 `piweb`）；云端 / Linux 没有任何订阅，真订阅只能由用户本机验证。
- t3code 只当参考资料读，不复制其代码进来（许可证与身份标识都不同），也不运行它。
- 「默认做法」与「合规原则」已经由用户批准；与之冲突的改动先问用户。
- 文中的文件名、行号、函数名都已在 2026-10-07 的 main（`71aaa3b`）上核对过；动手前以当时的代码为准。

## Context
用户要参考 [pingdotgg/t3code](https://github.com/pingdotgg/t3code)（自称 "agent harness control surface"）重新定义 PiWeb 的 Agent。目前就三个目标：
1. **六个订阅合规接入**：Claude、Gemini（经 Google Antigravity）、Grok、Cursor 原生支持；Kimi、DeepSeek 经 OpenCode 接入。（用户补充：Vibe Kanban 对 Gemini 订阅的支持不确定；Claude Code Router 只能接 Kimi 和 DeepSeek。）
2. **每次做完就总结项目**。
3. **开发者模式**：已做（pi 的眼睛：无头浏览器五个工具 + 在截图上选元素 → 源码定位芯片），用户还没验收，不确定是否满足期望。

**参考 t3code 得到的事实**（读其源码与文档核对，2026-10-07 `cd41c4a`；只当资料读，不运行其代码）：
- 服务端拥有各 Agent 进程；Agent 差异全部关在「适配器」后面（`apps/server/src/orchestration-v2/ProviderAdapter.ts`），界面只认归一化事件；能力差异用能力标记表达（能否回退、能否分叉、能否插话、权限执行方式）。
- 各家接法：

  | 订阅 | t3code 的接法 | 登录 |
  |---|---|---|
  | Claude | 官方 `@anthropic-ai/claude-agent-sdk` | 用户自己的 Claude Code 登录（`claude auth login`） |
  | Gemini | Google 官方 Antigravity ACP 代理（ACP Registry 条目 `antigravity-acp`：`agy_acp_server` + 同目录 `localharness_external`） | 代理自带的 Google 登录（个人账号 / Gemini Enterprise / API key / Vertex） |
  | Grok | Grok Build CLI 的 ACP 模式 `grok agent stdio` | `grok login`（远程可 `--device-auth`） |
  | Cursor | 官方 `@cursor/sdk` 本地 Agent（Cursor 另有 ACP 通道，t3code 未用） | 浏览器登录或 `CURSOR_API_KEY` |
  | Kimi / DeepSeek | OpenCode：1.x 用 `@opencode-ai/sdk`，2.x 用 `@opencode/client` | `opencode auth login` |

- **ACP（Agent Client Protocol）** 是通用协议：t3code 的 Grok、Antigravity 只是同一个通用 ACP 适配器的两个「口味」。官方 TS 库 `@agentclientprotocol/sdk`（1.7.0，Apache-2.0，无依赖，稳定版 v1 + `./experimental/v2`）；Claude 有官方 ACP 适配器 `@agentclientprotocol/claude-agent-acp`（0.86.0，内含 Claude Agent SDK 0.3.287）。ACP 没有「插话」，t3code 用「中断后重发」代替。ACP 现在有两代线协议：t3code 发 `protocolVersion: 2`、按回应形状区分；Antigravity 报 2 却回 v1 形状。
- t3code 给每个 Agent 注入自己的 MCP 工具（预览浏览器、子任务），且**每个 ACP 会话都走一个 stdio 小桥**（原话：Agent "routinely fail to wire injected http servers"），令牌只放环境变量、不上命令行（`AcpAdapterV2.ts:690-715`），会话结束即吊销。
- 健康检查**不得建会话、不得触发登录**（`docs/internals/providers.md`：开会话可能启动 MCP、跑 hooks、弹登录浏览器）。
- 每轮检查点用隐藏 git 引用，与 PiWeb 的生长历史（`refs/piweb/rounds/<key>`）同一思路，且与 Agent 无关。

**默认做法：**
- **保留 Next.js 单体，现有 pi 路径不动**。新增「外部 Agent」一层，外部会话产出与 pi 会话相同的 `WebEvent`：SSE、快照、聊天界面、生长历史全部复用。不引入 t3code 的事件溯源 / SQLite（这三个目标用不上）。
- **一个通用 ACP 适配器先覆盖五家**：Claude（claude-agent-acp）、Grok（`grok agent stdio`）、Gemini（Antigravity ACP）、Kimi / DeepSeek（`opencode acp`，M0 确认）。Cursor 先探测 Cursor CLI 的 ACP，不行再单写 `@cursor/sdk` 适配器；OpenCode 若 ACP 不能切模型再换官方 SDK。另留「自定义本地 ACP 命令」（例如 `dsh --profile acp`）。
- **外部会话的记录用 pi 自己的 JSONL 格式**：`SessionManager.create(cwd, webSessionsDir)` 写到单独的 `~/.pi/agent/web-sessions/<编码后的 cwd>/`，用 `custom` 条目（`customType: "piweb.agent"`）记 Agent 信息。这样消息转换、冷快照（`buildContextEntries`）、轨迹、树、改名、导出、`session-reader` 摘要、生长历史都几乎不用改；放在单独目录，`pi --resume` 不会列出它们。
- **会话 id 仍是「路径的 base64url」**：`resolveSessionPath` 多认一个根，新的 `session-router.ts` 按所在根分派；前端 id 逻辑不用改。
- **每个外部会话一个 Agent 进程**（Grok 的权限模式写在命令行上，只能这样；也隔离崩溃、工作目录和环境变量）。
- **总结分两层**：先出确定性的「本轮卡片」（不调模型，没有合规问题），再出 AI 总结 + 滚动项目总览。两层都从 growth-tracker 的「一轮结束」钩子触发，pi 会话和外部会话走同一条路。
- **开发者模式先验收、后改动**；跨 Agent 用 MCP 小桥把浏览器工具给所有 Agent。

## 合规原则（每个 Agent 都适用）
1. 只驱动**用户自己安装并登录**的官方 Agent 程序（或官方 SDK / 官方 ACP 适配器）；登录走各家自己的流程，PiWeb 只显示可复制的登录命令，**从不替用户跑登录**。
2. PiWeb **不读取、不保存、不转发**任何订阅凭据（不碰 `~/.claude`、`~/.grok` 等目录）；**检测不建会话、不触发登录**。
3. 只在本机给本人用；不把订阅额度代理给别的客户端或别人。
4. **Claude 是六家里最不确定的一家**：PiWeb 发布在 npm 上，算第三方产品；Anthropic 的 Agent SDK 条款限制过「在第三方产品里提供 claude.ai 登录 / 订阅额度」。做法：
   - 尽量驱动用户自己安装的 `claude` 程序（M0 确认 claude-agent-acp 能否指向它）；
   - `ANTHROPIC_API_KEY` 作为毫无歧义的替代，设置页并列显示；
   - 实施前请用户看一眼 Anthropic 当前条款，再决定默认走哪条；
   - 不走 pi 自带的 Anthropic OAuth，设置页 pi 的 OAuth 登录处加一句提示。
5. 不冒用别人的身份：例如不照抄 t3code 的 `GROK_OAUTH2_REFERRER=t3code`（那是 t3code 的标识）。
6. 各家条款以官方当前版本为准；README 写清楚以上几点。

## 架构

**`src/lib/providers/`**
- `types.ts`、`registry.ts`：内置描述（claude、grok、antigravity、opencode、cursor）+ `custom:<id>`。
- `spawn.ts`：Windows 感知的命令解析与进程树结束。
- `acp-connection.ts`：`ClientSideConnection` 跑在 `Readable.toWeb(child.stdout)` / `Writable.toWeb(child.stdin)` 上；先用 v1，M0 确认每家都接受。
- `acp-map.ts`：ACP 更新 → 归一化更新的纯函数（以后 `@cursor/sdk` 适配器产出同样的归一化更新）。
- `probe.ts`：安装 / 登录检测。

```ts
interface ProviderDescriptor {
  id: string; label: string; transport: "acp" | "cursor-sdk";
  launch(s: ProviderSettings, mode: PermissionMode, cwd: string): LaunchSpec; // command/args/env；restartOnModeChange
  probe(s: ProviderSettings): Promise<ProbeResult>;   // 绝不 session/new、绝不 authenticate
  permission: { nativeMode?(m: PermissionMode): string | undefined; autoAllowKinds(m: PermissionMode): AcpToolKind[] };
}
interface AgentConnection {               // 一个进程 + 一个原生会话
  caps: { loadSession: boolean; resume: boolean; images: boolean; mcpStdio: boolean };
  nativeSessionId: string; config: AgentConfigOption[];
  prompt(blocks: PromptBlock[]): Promise<StopReason>; cancel(): void;
  setConfig(id: string, value: string): Promise<void>; dispose(): Promise<void>;
}
interface AgentHost { onUpdate(u: NormalizedUpdate): void; requestPermission(r: PermissionReq): Promise<PermissionOutcome>; onExit(i: ExitInfo): void }
```
`NormalizedUpdate` = text、thinking、tool_start、tool_update、plan、commands、config、usage、title。只有 manager 写记录和 `WebEvent`。

**`src/lib/external-agent-manager.ts`**：自己的 `globalThis` 表，每项含 `SessionManager`、连接状态（cold / starting / ready / running / crashed）、事件中枢（环形缓冲 + seq，语义照抄 `agent-manager.ts` 的 `publishImmediate` / `subscribe`，含重放规则）、`GrowthTracker`、权限桥、进行中的助手段落。导出与 `agent-manager.ts` 同名的函数：`getManaged`、`buildSnapshot`、`subscribe`、`unsubscribe`、`execute`、`createNewSession(cwd, provider)`、`disposeSessionPath`、`activeStatus`、`exportSession`、`growthRecord`。`agent-manager.ts` 本身只加一个保护（拒绝 web-sessions 下的路径）和总结钩子。

**`src/lib/session-router.ts`**：按路径所在根选 manager。调 `getManaged` 的路由（`agent/[id]`、`agent/[id]/events`、`agent/[id]/tree`、`browser`、`growth`、`sessions/[id]/export`）和 `sessions/[id]`（`disposeSessionPath`）改为经路由器；`agent/new` 接受 `{cwd, provider?}`。`src/lib/security/path-security.ts` 的 `resolveSessionPath` 改为允许根列表（`sessions`、`web-sessions`）并加 `sessionKind(path)`；`session-reader.ts` 两个根一起扫，`SessionSummary` 加 `provider?`。

**记录条目**
- 用户消息：`appendMessage({role: "user", …})`。
- 助手段落：段落结束时写入（`api: "acp"`、`provider: "acp:<id>"`）；结束原因 end_turn → stop、max_tokens → length、cancelled → aborted、refusal → error。
- 工具结果：`details.patch` 放由 ACP `diff` 内容生成的统一 diff（用 `diff` 包），现有红绿 diff 视图直接可用。
- 另有 `appendModelChange`，以及 `piweb.agent` custom 条目：`{provider, nativeSessionId, agentVersion, permissionMode, configCache}`。

**映射到现有界面**
- `agent_message_chunk` / `agent_thought_chunk` → `delta`，**每约 50 ms 合并一次**（否则 400 条的环形缓冲 `BUFFER_CAP` 会溢出、逼前端整份重同步）。
- `tool_call` → 先以 toolCall 收尾当前助手段落，再发 running 的 `tool`；`tool_call_update` → partial / done（`result`、`patch`、`images`）。
- `plan` → 名为 `plan` 的 `tool`（清单）；`available_commands_update` → `extensionCommands`（现有 `/` 菜单直接可用，命令作为 `/name` 文字发出）；`usage_update` → `usage`；`session_info_update` → `name`。
- `session/load` 期间 Agent 重放的历史要压住：等 load 回应 + 一段静默再放行（同 t3code）。
- 快照加可选 `agent: {provider, label, state, caps, config[], permissionMode}`；pi 专有字段给空。前端看到 `snapshot.agent` 就隐藏 pi 专有控件：思考强度（除非 Agent 有 `thought_level` 选项）、压缩、编辑重发 / 撤回、分叉、树。

**新命令**（`src/lib/agent/command-validation.ts`）：`setAgentConfig {configId, value}`、`restartAgent`。外部会话的 `setToolPreset` 兼作权限模式；`followUp` 是 PiWeb 侧队列，下一轮发出（复用 `queue` 事件）；插话 = 取消后重发（以后做）。

**审批不能用 `ExtensionUiBridge.ask`**：没人在看时它立刻返回默认值（`src/lib/agent/extension-ui.ts:49`），无人值守的 Agent 会被悄悄拒绝一切。新建 `PermissionBridge`：等最多 10 分钟，超时答 `reject_once`。

**进程生命周期**
- 惰性启动：spawn → `initialize` → 只有 Agent 说需要时才 `authenticate` → `session/load`，不行 `session/resume`，再不行 `session/new`；不能恢复时新开原生会话并在前面附上预算内的历史交接。
- 取消：`session/cancel`，挂起的审批答 `cancelled`，等 prompt 回应 10 秒，超时结束进程树。
- 结束进程：Windows `taskkill /PID <pid> /T /F`（同 `scripts/process-runner.mjs:11`）；POSIX 独立进程组，先 SIGTERM 再 SIGKILL。
- 崩溃：段落标 `error`，显示 stderr 最后几行，照常走生长历史的 `agent_settled`；下一条消息自动重启；2 分钟内崩 3 次就停止自动重启，给「重启 Agent」按钮。
- 回收：沿用 `reap()` 规则（空闲 10 分钟），且有挂起审批时不回收；`MAX_ACTIVE_AGENTS = 4`（环境变量可改）；像 `browser/manager.ts` 一样挂 `process.once("exit")`。

**Windows 启动（`spawn.ts`）**：按 PATH + PATHEXT 解析；npm 的 `.cmd` shim 读出 JS 入口，用 `process.execPath <entry>` 直接跑，不经 cmd.exe；未知 `.cmd` / `.bat` 才用 `cmd.exe /d /s /c` + cmd 转义；一律 `windowsHide: true`；运行时绝不用 `npx`（慢、要联网、可能弹提示）；stderr 宽松解码（可能是 GBK），ACP stdout 是 UTF-8 JSON。`next.config.ts` 的 `serverExternalPackages` 加 `@agentclientprotocol/sdk`。

**权限模式**（沿用 只读 / 标准 / 完全 三档，改名；「自动接受修改」以后再加）

| PiWeb 模式 | Claude（ACP 模式） | Grok（命令行） | OpenCode / Antigravity | Cursor SDK |
|---|---|---|---|---|
| 只读 | `plan`；非读取请求一律拒绝 | `--permission-mode default`；拒绝 | plan agent / 拒绝 | 开沙箱 |
| 有人看管 | `default`；弹审批 | `default`；弹审批 | 弹审批 | 开沙箱（SDK 没有交互审批） |
| 完全 | `bypassPermissions` | `agent --always-approve stdio`（需重启进程） | PiWeb 自动允许 | 关沙箱 |

自动批准一律选 `allow_once`，绝不选 `allow_always`（Grok 会在整个项目里记住允许过的命令）；读取和搜索总是允许。PiWeb 的模式只是映射到各家的模式，**不是操作系统沙箱**，README 写清。

## M0：探路与验收（不写产品代码）
- **M0a 开发者模式验收包** `docs/dev-mode-review.md`：生产构建 + 假模型（不花 token）+ 本地示例页，逐项截图配说明，附勾选清单：
  - 浏览器工具只在「标准 / 完全」预设里（`src/lib/pi.ts:365`），且要找到 Edge / Chrome；
  - pi 打开页面、截图显示在对话里；读到控制台报错；点击 / 输入；
  - 在截图上选元素 → DOM 路径、源码位置、裁剪图；点源码位置打开编辑器；
  - **已知差距：React 19 / Next 16 的项目只能靠文字搜索定位源码**（React 19 去掉了 `_debugSource`，`src/lib/browser/inspect.ts:87`）——用户自己的项目多半正是这种；
  - 默认只开本机 / 内网地址（公网需 `PI_WEB_BROWSER_ALLOW_PUBLIC=1`）；临时浏览器配置；用户看不到实时画面。
  - 再列出 t3code 有而 PiWeb 没有的相关能力供勾选：用户和 Agent 共用的实时预览浏览器（可接管 / 交还）、页面标注、桌面窗口截图快捷键、HTML 可视化回复、导入浏览器登录态；以及候选改进：React 19 开发构建 fiber 上的 `_debugStack` + source map 解析出 file:line（待验证）。
  - **用户勾完再定 M6 的范围。**
- **M0b 探测脚本** `scripts/acp-probe.mjs <cmd> [args]`（用户在自己的 Windows 上跑，云端没有订阅）：只做 `initialize`，打印协议代数、`authMethods`、`loadSession` / resume、`mcpCapabilities`、模式 / 配置项、图片输入；加 `--try-session` 时才额外试一次带 stdio MCP 回声服务器的 `session/new`（会建会话，由用户决定跑不跑）。据此定 Cursor 走 ACP 还是 SDK、OpenCode 走 ACP 还是 SDK、Antigravity 的安装方式、claude-agent-acp 能否指向用户自己的 `claude`。
- **M0c 假 ACP Agent** `tests/fixtures/fake-acp-agent.mjs`：用同一个 SDK 的 `AgentSideConnection`，环境变量选场景（文字流、工具 + diff、审批、慢取消、半路崩溃、load 重放、MCP 调用）；用 `process.execPath` 启动，Windows CI 也能跑。后面所有测试和端到端都用它。

## M1：本轮卡片（总结第一层，先给 pi 会话）
- **钩子**：`src/lib/growth/growth-tracker.ts` 加选项 `onRunEnd({prompts, title, status, runEntries, round | null})`；即使生长历史停用（没有 git / 项目过大）也照样跟踪一轮的边界并回调（`round` 为 null）。`agent-manager.ts` 的 `growthOf` 传入；M3 的外部 manager 同样传入。
- **卡片内容**（不调模型）：提问、文件 +/−（来自 `round.changes`）、工具调用次数、最后回复摘录、状态（完成 / 已中止 / 出错）。
- **存储**：每工作区一份 `~/.pi/agent/web-summaries/<workspaceKey(cwd)>/runs.jsonl`，一条一轮（以 commit 为键，没有 commit 时以会话 + 提问 id 为键）。
- **事件与接口**：新增 `WebEvent` `summary {key, status: pending|done|error, card?, ai?}`；快照带本会话各轮卡片；`GET /api/summaries?cwd&session`（写路由前读 `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`）。
- **界面**：对话里每轮最后一条回复下方的卡片（可复制为 Markdown）；`ProjectPanel.tsx` 新增「总结」页：按轮的时间线，点一轮跳到生长历史对应的轮。

## M2：Agent 检测（只读）
- `GET /api/agents`（探测结果缓存 60 秒）、`POST /api/agents {action: "refresh"}`（显式刷新）。
- 探测无副作用：`--version`；然后 `claude auth status`、`grok models`（找 "logged in" / "not authenticated"）、`opencode auth list`（M0 确认）、Antigravity 只 `initialize`、Cursor 待定。
- 设置页新增「Agent」区（`SettingsPanel.tsx` 的 `Section` 加 `"agents"`）：六家的状态（未安装 / 已安装未登录 / 可用 / 出错）、版本、可复制的安装与登录命令、可执行文件路径、额外环境变量、启用开关；存 `~/.pi/agent/web-agents.json`。
- Claude 的「安装」按钮（用户点了才执行）跑 `npm i -g @agentclientprotocol/claude-agent-acp@<固定版本>`。
- 测试：探测输出解析、命令解析（mock fs / env、`.cmd` shim 夹具）。

## M3：外部会话内核（实验开关；先 Claude、Grok、OpenCode → Kimi / DeepSeek）
- 上面「架构」里的适配器、manager、路由器、记录条目、事件映射、权限桥、进程生命周期。
- 新会话页加「用哪个 Agent」；侧栏和会话头显示 Agent 标记（`src/lib/models/provider-display.ts` 及图标）。
- 审批先用现有 `extension_ui` 的 select（允许一次 / 总是允许 / 拒绝），但背后是 `PermissionBridge` 的语义。
- 生长历史与 M1 卡片在这里自动生效（外部 manager 同样建 `GrowthTracker`，`entries()` 取自 `SessionManager`）。
- OpenCode：模型取 OpenCode 报告的 provider/model；若 ACP 不能切模型，换 `@opencode-ai/sdk` 适配器（产出同样的归一化更新）。
- Grok：xAI 扩展里的结构化提问映射到选择框，未知扩展方法回优雅的错误。

## M4：打磨到对齐
- 输入框上方的专门审批卡片：工具标题、类别、涉及路径、diff 预览；新事件 `permission` / `permission_resolved`。
- `setAgentConfig` 的模型 / 模式菜单（按 Agent 报告的选项显示）。
- PiWeb 重启后经 load 恢复、追加消息队列、用量表、侧栏圆点显示「等待审批」（`activeStatus`）。
- 每家一张能力表（会话恢复、图片、模式、模型、回退），驱动界面开关。

## M5：AI 总结 + 滚动项目总览（总结第二层）
- 每工作区串行一条队列（保证总览按顺序合并）。只在「完成」的轮跑；设置项：自动总结 开 / 关（默认开）、只在有文件改动时总结。
- **输入**（预算约 12k 字符）：提问、最后回复、改动文件、前 3 个 patch（`filePatch`）、上一版总览；第一次再加 README 开头。
- **输出**：本轮 AI 总结 `{done[], changedFiles[{path, why}], verified[], notVerified[], next[]}` 并入 `runs.jsonl` 对应条目；滚动项目总览 `overview.md`（项目目的、关键结构、当前状态、最近 10 次变化、未决问题）+ `overview-history/`。
- **引擎**（设置里三选一）：
  - **同一个 Agent**：开一个用完即弃的 ACP 进程，只读模式、不给 MCP、审批一律拒绝、90 秒超时；
  - **pi 模型**：pi-ai 的 `completeSimple`；若该模型用的是订阅 OAuth 登录（`src/lib/models/models-service.ts` 的 `storedAuthType === "oauth"`），默认不拿它写总结、只出卡片，设置里可另指定模型；
  - **关**。
- `POST /api/summaries {action: "regenerate" | "export"}`；可选（每工作区默认关）同步写一份到仓库文件（如 `docs/PROJECT_SUMMARY.md`），并加入生长历史的 exclude，免得下一轮被记成「你的修改」。
- pi 引擎部分不依赖 M3，可以提前做。

## M6：开发者模式给所有 Agent（MCP 小桥，等验收签字后）
- `scripts/mcp-bridge.mjs`（随包发布，`scripts/` 已在 `package.json` 的 `files` 里）：零依赖，把 stdin 上按行的 JSON-RPC 用 POST 转发到 `http://127.0.0.1:$PORT/api/mcp`，带 `Authorization: Bearer $PIWEB_MCP_TOKEN`；stdin 结束即退出。
- `src/app/api/mcp/route.ts`：只实现 `initialize`、`tools/list`、`tools/call`、`ping`；包装 `createBrowserTools(sessionPath)`（`src/lib/browser/tools.ts`），把 TypeBox schema 转成 `inputSchema`、用桩上下文调 `execute`。
- 令牌：每个 Agent 进程一个，32 字节随机，只在内存里，结束即吊销；`src/proxy.ts` 对 `/api/mcp` 放行到路由自己的 Bearer 校验。
- `session/new` 里传 `mcpServers: [{name: "piweb", command: process.execPath, args: [bridgePath], env: [...]}]`（令牌只走环境变量）。
- 工具调用由 PiWeb 服务端自己执行，所以截图可以直接发进会话中枢显示，不依赖 Agent 回显 MCP 图片。
- 按 M0a 的勾选结果做的改进单独列小节再估。

## M7：其余几家
- **Gemini（Antigravity）**：第一版让用户从官方 ACP Registry 安装，在设置里填 `agy_acp_server.exe` 的路径（同目录要有 `localharness_external.exe`）；第二版再考虑受管安装（按 Registry 下载、校验 SHA-256、按版本放 `~/.pi/agent/web-tools/`）。登录走 ACP `authenticate` 的浏览器流程。Antigravity 不能回退对话。
- **Cursor**：Cursor CLI 的 ACP 可用就走 ACP；否则写 `@cursor/sdk` 适配器（本地运行时；SDK 没有交互审批回调）。
- **自定义本地 ACP 命令**。
- 可以和 M4 并行。

**推荐顺序**：M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7；M1、M5 的 pi 部分随时可以提前。每个里程碑同步 README（中英文：接入说明、合规原则、登录命令、能力差异、总结说明）和 `docs/state/progress.md`。

## 验证
- 每个里程碑：`npm run typecheck` + 全量 `npx vitest run` + `npm run build`；CI（Linux + Windows）全绿。
- **单测**：`acp-map`（ACP 更新 → 归一化更新 → 记录条目与 `WebEvent`）；权限表；`spawn.ts` 解析与 shim 解析；`resolveSessionPath` 多根与越界拒绝；`session-reader` 的 provider 字段；MCP JSON-RPC 处理与令牌鉴权（无令牌 / 已吊销 / 别的会话）；总结输入预算、队列顺序、跳过规则（pi-ai 的 faux provider）；`tests/hooks/use-piweb-events.test.ts` 加 reducer 夹具。
- **集成**（用假 Agent）：prompt → 事件顺序；取消；崩溃 / 重启并压住重放；回收；冷快照与热快照一致；临时 git 仓库里的生长 commit（复用 `growth-tracker.test.ts` 的写法）；`mcp-bridge.mjs` 对桩 HTTP 服务器。
- **端到端（云端，不需要订阅）**：生产构建 + 假 ACP Agent 注册成「自定义 ACP 命令」+ 假模型：新建外部会话 → 流式输出 → 审批 → 生长轮 → 本轮卡片 / AI 总结 → 项目总览更新 → 外部 Agent 经 MCP 截图并显示。
- **真订阅（只能在用户本机 Windows）**：每家一张清单——检测显示「可用」、发一条消息、审批、取消、重启 PiWeb 后恢复、用浏览器工具、生成总结。可选 `PI_WEB_ACP_LOG=1` 记录去掉密钥的通信日志，之后可转成重放夹具。

## 风险与待确认（M0 逐项确认）
- **Claude 的合规边界**（见合规原则 4）：claude-agent-acp 能否复用现有 `claude` 登录而 PiWeb 不碰凭据、能否指向用户自己的可执行文件、报告哪些 load / resume 能力与模式；Anthropic 当前条款。
- `opencode acp` 在 Windows 上是否存在、是否支持 `session/load` 与 stdio MCP、能否切模型。
- Cursor 是否有 ACP 模式（命令、参数、Windows 支持）；否则 `@cursor/sdk` 1.0.36 的本地运行时在 Windows 上能否用。
- Grok Build CLI 是否有 Windows 原生版；`--permission-mode` / `--always-approve` 在 ACP 下的实际行为；xAI 扩展方法有哪些。
- Antigravity 在 Windows 的安装位置与体积（可能数 GB）、是否接受 v1 `initialize`、Google 登录怎么弹出（`127.0.0.1` 回调，本机浏览器可直接完成）。
- 各 Agent 会不会把 MCP 图片结果交给模型；不会就退回文字描述。
- 同一工作区同时开多个会话，生长历史的轮次会混进彼此的改动（已知限制）。
- 自动总结会消耗额度：默认开但可关，可设「只在有改动时总结」，OAuth 订阅模型默认不用来写总结。
- 「每次做完就总结项目」若指的是开发流程（每次让 Claude 做完都更新一份项目总结文档），而不是 PiWeb 的功能，那 M5 的「同步写到仓库文件」就是它，可单独先做。
