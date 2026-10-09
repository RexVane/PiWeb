# 进度

> 更早的条目：[docs/state/archive/2026-10.md](archive/2026-10.md)、[docs/state/archive/2026-09.md](archive/2026-09.md)

## 2026-10-09 10:05 +08:00 | claude-haiku-5-5 | 清理未使用的代码、导出、文案、路由与配置
- 起因：用户要求去掉项目里没用的东西。knip 与 `tsc --noUnusedLocals` 报出：未用导出 45 个、未用 import / 变量 8 处、未用文案键 35 个；另有无调用方的接口、旧 bin 入口和过期配置。删除的文件一律移进 `backups/`，没有真删
- 改了什么：
  - `d5710f5`：删掉未用的 import / 变量（`AppShell`、`SettingsPanel`、`usePiWeb`、`ChatWindow`、`agent-manager` 与 `pi.ts` 的 `loadProjectContextFiles`，以及 ACP 测试里上次漏掉的 `parseProbeArgs`）。`models-service` 的 `envKeyOf` 是空实现，删掉。`extension-ui` 的 `UiMethod` 只为导出而存在，删掉
  - 同一提交：45 个未用导出里，43 个去掉 `export`（只在本文件内用，不改逻辑），`ProviderSetupModal` 删掉再导出的 `serializeModelDraft`，`UiMethod` 整段删掉
  - `8327902`：`src/i18n.tsx` 删掉 35 个没有引用的文案键，中英文各一行，共 70 行。已确认没有动态拼接的 key
  - `e22a7ff`：`GET /api/agent/[id]/tree` 前端与测试都不调用，是早期设计遗留，移到 `backups/src/app/api/agent/[id]/tree/`。`bin/pi.js` 与 `package.json` 的 `web` 脚本移到 `backups/bin/pi.js`（`npm start` 等价，且 `bin/` 只放 `package.json` 登记的入口）。`.gitignore`、`tsconfig.json` 删掉 `.next-dev/`、`.next-dev-clean/`（开发产物目录现在是 `.next-dev-webpack`）
  - 工作区：空的 `state/` 移到 `backups/state/`；`.next/types` 与 `.next-dev-webpack/dev/types` 里引用已删路由的生成文件（`tree` 目录、两份 `validator.ts`）移到 `backups/`，下次 `build` / `dev` 会重新生成
  - 更正上一条：`tests/` 根部是 57 个文件，不是 60 个
- 保留（有意不动）：`.commandcode/`（AI 工具私有目录）；`docs/planning/plan-2026-10-07-growth-browser.md`（已实现的设计记录）；`.next-dev-webpack/`（用户之前选择保留）；knip 报的 `material-icon-theme`、`@lobehub/icons-static-svg`（被 `scripts/sync-*.mjs` 用路径字符串引用，误报）；两处图标别名（在用）
- 影响文件：`src/components/*`、`src/hooks/*`、`src/lib/*`（含 `browser/`）、`src/i18n.tsx`、`scripts/install-build.mjs`、`tests/scripts/acp-probe.test.ts`、`package.json`、`.gitignore`、`tsconfig.json`；移出：`src/app/api/agent/[id]/tree/route.ts`、`bin/pi.js`
- 验证：`npm run typecheck` 通过；`tsc --noUnusedLocals` 零报错；全量 vitest 80 文件 503 通过 + 1 跳过（与清理前一致）；`npm run build` 通过（重建了 `.next`）；knip 只剩上面的误报
- 下一步：推送 `origin/main`。`tests/` 根部 57 个平铺文件、`src/lib/` 根部 44 个文件，按域拆子目录需要你点头

## 2026-10-09 09:16 +08:00 | claude-opus-5-5 | 整理目录与工作区：state / assets / 计划迁入 docs/，提交 ACP 探针，清本地残留
- 起因：用户「整理一下呗」「保持 github 和本地项目的干净」。开工时工作区有 22:41 那条记着未提交的 ACP 探测、`process-runner.mjs`、`tsconfig.json`，`.commandcode/` 没被忽略；根部还有规则不允许的 `state/`、`assets/`。GitHub 上只剩 `main` 一个分支，本身已干净
- 改了什么：
  - `63a1b32`：`.gitignore` 加 `.commandcode/`、`.claude/`、`.codex/`，与 `.zcode/` 归成「AI tool private dirs」一组
  - `93b3e0e`：`git mv` 把 `state/` → `docs/state/`、`assets/` → `docs/assets/`、`docs/plan-*.md` → `docs/planning/`。README 中英文配图路径、`package.json` 的 `files`（改为 `docs/assets/*.png`，`npm pack --dry-run` 核对 14 张图都在包里）、计划文档里的 progress 路径同步改；`install-build.mjs` 暂存构建不再复制已不存在的 `assets/`（构建不引用这些图）
  - `161ef75`：提交 command-code 10-07 20:02 做的 M0b ACP 探针。测试按「平铺目录超 15 个不再加」放进 `tests/scripts/acp-probe.test.ts`。提交前查出两处问题并修掉：`resolveLaunch` 的参数类型从默认值推出（Next 扩展过的 `ProcessEnv` 要求 `NODE_ENV`，`existsSync` 参数是 `PathLike`），`npm run typecheck` 实际报 5 个错；查 PATH 用的是宿主的 `path.delimiter` / `path.join`，测试在 Linux CI 上模拟 win32 会按 `:` 拆 PATH 而失败。补 JSDoc 参数类型，固定用 `path.win32`（真 Windows 上行为不变）
  ```js
  // scripts/acp-probe.mjs:122
  const directories = String(env.PATH ?? env.Path ?? "").split(path.win32.delimiter).filter(Boolean);
  ```
  - `e15a218`：`tsconfig.json` 提交 Next 自动补的 `.next-dev-webpack/dev/dev/types/**/*.ts`（`next/dist/lib/typescript/type-paths.js:36`：NODE_ENV 不是 development 时跑 dev 会拼出 `dev/dev`，改回去还会再冒出来）；加 `tsBuildInfoFile: node_modules/.cache/tsconfig.tsbuildinfo`，`tsc --noEmit` 不再往根部写 tsbuildinfo（next build 自己传缓存路径，不受影响），根部旧文件移进 `backups/`
  - 本地：stash「local README status edit (superseded by cloud 77e33cd)」导出为 `backups/stash-readme-status-edit-20261009-0916.patch` 后 drop；`git fetch --prune` 清掉 22 个 GitHub 上早已删除的远端跟踪引用（`origin/pr/*`、`origin/dependabot/*`、`origin/claude/funny-lamport-q9lcem`）
- 验证：`npm run typecheck` 通过；全量 vitest **80 文件 503 通过 + 1 跳过**；`git status` 干净
- 影响文件：`.gitignore`、`tsconfig.json`、`package.json`、`README.md`、`README_zh.md`、`scripts/install-build.mjs`、`scripts/acp-probe.mjs`、`scripts/process-runner.mjs`、`tests/scripts/acp-probe.test.ts`、`tests/fixtures/fake-acp-agent.mjs`、`docs/`（迁移）
- 下一步：推送 `origin/main`。`tests/` 根部平铺 60 个文件，按域拆子目录要单独做，等用户点头

## 2026-10-08 22:41 +08:00 | grok-4.7 | 提交带配图的中英文 README 并推送（`d35b6ba`）
- 起因：GitHub 介绍页仍是旧 README。配图和正文只在本地工作区，没有提交
- 改了什么：
  - 提交 `d35b6ba`：`README.md` 与 `README_zh.md` 换上同一套界面图（主界面、大纲、轨迹、归档、项目栏、文件查看器、提供方），删掉 `assets/showcase.png`，`package.json` 的 `files` 改为 `assets/*.png`
  - 未纳入这次提交：ACP 探测（`scripts/acp-probe.mjs`、夹具与测试）、`scripts/process-runner.mjs`、`tsconfig.json`、`.commandcode/`
- 影响文件：`README.md`、`README_zh.md`、`package.json`、`assets/*.png`
- 下一步：推送到 `origin/main`。生长图上仍是「本步」，提供方图的设置侧栏仍有「导入会话」

## 2026-10-08 22:17 +08:00 | grok-4.7 | README 换上 0.3.16 的界面配图
- 起因：当前 `main` 的 README 只有一张 `assets/showcase.png`。带多张界面图的是另一条历史，提交 `7d90207`（npm 上的 0.3.16）。用户要的是那套图，正文按现在这个代码改
- 改了什么：
  - 从 `7d90207` 取出仍对得上当前界面的图：主界面、大纲、轨迹与 diff、归档、项目栏、文件查看器、提供方设置，放进 `assets/`，中英文 README 按节配上
  - 正文改成现在的行为：生长记录是每轮一个 git commit（`refs/piweb/rounds/<key>`），不是旧版「每次文件操作拍一张、独立于 git」；补上边生成边排版、编辑重发、pi 的眼睛。不再把已经不在这棵树上的功能写成现有能力：导入会话、提示词来源面板、智能体群、测试检查器、Agent / Plan / Goal、托管 niubash、归档 30 天自动删除
  - `package.json` 的 `files` 从单个 `assets/showcase.png` 改为 `assets/*.png`，发布包里的 README 才能引用这些图
  - 换下来的 `showcase.png`，以及这版用不上的 `import.png`、`prompts-1.png`、`prompts-2.png`，移进 `backups/`（该目录被 git 忽略）
- 影响文件：`README.md`、`README_zh.md`、`package.json`、`assets/*.png`；`assets/showcase.png` 移出仓库
- 下一步：这些 README 改动还没提交。生长图和提供方图是 0.3.16 当时的界面，图上仍写着「本步」和「导入会话」，和现在的「本轮」、设置里没有导入项不一致

## 2026-10-07 20:02 +08:00 | command-code | M0b：ACP 探路脚本 + 假 ACP Agent 夹具（计划第一步）
- 起因：按 `docs/plan-2026-10-07-multi-agent.md` 的 M0 从 M0b 开始——M3 各家走 ACP 还是官方 SDK 由本机探测结果决定
- 做了什么：
  - 新增 `scripts/acp-probe.mjs`：把用户给的命令当 ACP Agent 启动，只发 initialize，打印协议代数（请求 vs 返回）、agentInfo、authMethods、能力（loadSession / 图片 / 音频 / 嵌入上下文 / mcpCapabilities / 未识别能力键）与原始 JSON；`--try-session` 才建会话（带一个 stdio MCP 回声服务器验证 mcpServers）；另有 `--protocol`、`--env KEY=VALUE`、`--cwd`、`--timeout`、`--json`；Windows 上 `.cmd` / `.bat` 经 cmd.exe 启动，其余直接 spawn；退出用 `terminateProcessTree` 杀进程树
  - 新增 `tests/fixtures/fake-acp-agent.mjs`（M0c 的种子：initialize + session/new + MCP 客户端）与 `tests/acp-probe.test.ts`（7 条用例：3 条端到端 + 4 条 Windows 命令解析）
  - `scripts/process-runner.mjs` 的 `terminateProcessTree` 改为导出（探针复用，行为不变）
- 本机实探结果（M0b 真实数据）：
  - `grok agent stdio`：v1，Grok 1.0.46；authMethods `cached_token` / `grok.com`；loadSession 支持；`sessionCapabilities: list/resume/close`；MCP http + sse 都支持；图片输入不支持、embeddedContext 支持；模型 grok-4.6 / grok-4.5（500k 上下文、思考强度 xhigh~low）
  - `opencode acp`：v1，OpenCode 1.18.35，authMethods `opencode-login`，loadSession 支持、图片支持、embeddedContext 支持（Kimi / DeepSeek 走这条）
  - `dsh --profile acp`：v1，`deepseek-harness-acp` 0.0.1，无 authMethods、未报 loadSession；启动慢（>25 秒，需 `--timeout 60`）
  - 未探：claude / codex 要经 npx 适配器（需下载）；Antigravity 本机未安装
- 验证：`npm run typecheck` 通过；全量 `npx vitest run` 503 通过 + 1 跳过（80 文件，此前 496 + 1）；`npm run build` 通过（`.next/BUILD_ID` 19:56 写入）。注意：本机 shell 若带 `NODE_ENV=production`，vitest 会加载生产版 React 导致 25 个 UI/hook 文件误报（`React.act is not a function`），清掉即恢复
- 影响文件：`scripts/acp-probe.mjs`、`tests/fixtures/fake-acp-agent.mjs`、`tests/acp-probe.test.ts`、`scripts/process-runner.mjs`
- 下一步：claude / codex 的 npx 适配器探测（需下载；用户已要求暂缓）、Antigravity 装好后填 `agy_acp_server.exe` 路径；已有三家结果可直接定 M3 的接入顺序

## 2026-10-07 19:12 +08:00 | Claude Code（云端） | 计划：六个订阅合规接入 + 每次做完自动总结 + 开发者模式验收（只写计划，未实施）
- 起因：用户要参考 pingdotgg/t3code 重新定义 Agent，三个目标——六个订阅（Claude、Gemini 经 Antigravity、Grok、Cursor、Kimi / DeepSeek 经 OpenCode）合规接入、每次做完就总结项目、验收已做的开发者模式；用户要求「先做计划」「在 GitHub 做完计划即可」「先别执行，拉到本地后叫别的模型来做」
- 做了什么：只读调研 t3code（适配器 + 能力标记、通用 ACP 适配器、每会话 stdio MCP 小桥、检测不建会话）与 PiWeb 的接入点，经一轮设计复核后写成 `docs/plan-2026-10-07-multi-agent.md`。要点：
  - 保留 Next.js 与 pi 路径；新增外部 Agent 层（`src/lib/providers/`、`external-agent-manager.ts`、`session-router.ts`），一个通用 ACP 适配器先覆盖 Claude（claude-agent-acp）、Grok、Antigravity、OpenCode；Cursor 视 M0 结果走 ACP 或 `@cursor/sdk`
  - 外部会话记录用 pi 自己的 JSONL（`SessionManager.create` 写到 `~/.pi/agent/web-sessions/`），快照 / 树 / 导出 / 生长历史几乎不用改；每会话一个进程；审批用新的 `PermissionBridge`（`ExtensionUiBridge.ask` 无人看时立即返回默认值）
  - 总结分两层：确定性本轮卡片（不调模型）→ AI 总结 + 滚动项目总览；都挂在 growth-tracker 新增的 `onRunEnd` 钩子上
  - 开发者模式先出验收包；已知差距：React 19 / Next 16 项目选元素只能靠文字搜索定位源码（`inspect.ts:87`）
  - 合规：只驱动用户自己安装登录的官方 Agent，不碰凭据、检测无副作用；**Claude 是最不确定的一家**（PiWeb 在 npm 上算第三方产品），实施前需用户看 Anthropic 当前条款
- 未做：任何代码改动；真订阅相关的事实（`opencode acp`、Cursor ACP、claude-agent-acp 登录行为、Antigravity Windows 安装）都留到 M0 由用户本机确认
- 影响文件：`docs/plan-2026-10-07-multi-agent.md`（新增）、`state/progress.md`
- 下一步：用户拉取后交给别的模型按计划从 M0 开始；M0b 探测脚本需要用户在 Windows 上跑

## 2026-10-07 18:52 +08:00 | muse-spark-1.3-contributor-free | 提交 README 状态段并清理 backups 旧备份
- 改了什么：
  - 提交 `README.md` / `README_zh.md` 状态段更新（此前工作区未提交的改动）：同步近三次更新——设置保存模型配置后已打开会话即时生效、回答边生成边渲染 Markdown、内置提供方覆盖删空时整块移除；测试数更新为 **79 文件 496 通过 + 1 跳过**；已知限制补生长记录与浏览器工具条目。`git diff --check` 通过，纯文档改动
  - 清理磁盘：删除 `backups/2026-10-07-iframe-dev-preview/`（35KB，已被还原的 iframe 实验残留；`backups/` 本就进 `.gitignore`，不进提交）
  - 未动：`.next-dev-webpack/`（约 258MB 构建缓存，用户选择保留，dev 重建会耗时）、`docs/plan-2026-10-07-growth-browser.md`（历史计划文档，保留）
- 影响文件：`README.md`、`README_zh.md`（提交）；`backups/`（磁盘删除，未跟踪）
- 下一步：无待办，等用户反馈

## 2026-10-07 18:34 +08:00 | claude-opus-5-5 | 重启服务核对 Grok 4.7 思考；回答改为边生成边渲染 Markdown（`fea3690`）
- 起因：用户「重启看看」（服务此前已停，30141 无监听）；随后问「输出不是实时渲染的吗？」
- 重启：按原方式在可见 PowerShell 窗口跑 `piweb`（全局命令是到本仓库的 junction，无 `.next/BUILD_ID` → dev），PiWeb 0.3.4 / pi 1.0.4。核对：目录 Grok 4.7 思考 low–xhigh；workProject 会话 18:19 切到 xhigh，之后回复带思考。更正此前说法：16:49 那几条也有推理（44/413/271 tokens）——Grok 4.7 总会思考（内置定义 off 为 null），旧定义下只是没发强度。旧会话开局记的 off 恢复时钳到 low（与终端 pi 同规则），新会话默认 max → xhigh
- 实时渲染排查（只读，不花 token）：用 SSE 环形缓冲重放上一轮——392 个 text_delta 在 3.6 秒里陆续推出（每秒约 100 个）；带浏览器 `Accept-Encoding` 直连 SSE 无压缩、心跳 15.06/30.07 秒准时到；前端 reducer 逐个拼接。根因在渲染：`StreamingText` 流式期间按纯文本显示（09-11 `997e0e5` 有意为之，免每个 delta 重解析整段），结束才切 Markdown；那条回复 2529 字含 7 个标题、11 个列表项、5 行表格、代码块、28 处行内代码，生成中全是原始符号
- 改了什么：
  - 新增 `src/lib/markdown-blocks.ts` 的 `splitMarkdownBlocks`：只在代码围栏外的空行处切块，下一块须从第 0 列开始且不是列表项（不拆代码块、列表、缩进续行）；块按 `\n` 拼回即原文
  - `ChatWindow.tsx`：插件配置提成常量；新增不带外层容器的 `MarkdownBody`（memo）；`StreamingText` 改为 `useDeferredValue` + 按块渲染，写完的块记忆化、只重解析尾块；所有块放在同一个 `.md` 里保证间距一致
  - `globals.css`：`.stream-cursor` 改为 `.md-streaming` 下最后一个块末尾的 `::after` 光标（段落 / 标题 / 代码块；列表挂最后一项；引用挂最后一段）
  ```tsx
  // src/components/ChatWindow.tsx:133
  function StreamingText({ text }: { text: string }) {
  	const deferred = useDeferredValue(text);
  	const blocks = useMemo(() => splitMarkdownBlocks(deferred), [deferred]);
  	return (
  		<div className="md md-streaming" data-testid="streaming-markdown">
  			{blocks.map((block, index) => (
  				<MarkdownBody key={index} text={block} />
  			))}
  		</div>
  	);
  }
  ```
- 验证：`tsc --noEmit` 通过；全量 vitest **79 文件 496 通过 + 1 跳过**；新增切块单测与组件测试（围栏未收尾时标题 / 表格 / 行内代码 / 代码块已是元素）；在运行中的页面注入同结构 DOM（真实样式）截图：三种结尾光标位置正确、表格与间距正常
- 未验证：真实流式下的观感（需要真实模型调用，会花用户 token）
- 影响文件：`src/lib/markdown-blocks.ts`、`src/components/ChatWindow.tsx`、`src/app/globals.css`、`tests/markdown-blocks.test.ts`、`tests/components/streaming-markdown.test.tsx`
- 下一步：用户下一次提问时看生成过程是否已按 Markdown 排版；dev 服务热更新，刷新页面即可

## 2026-10-07 18:11 +08:00 | claude-opus-5-5 | 保存模型配置后，已打开的会话立即用上新定义（`a267b3d`）
- 起因：用户 18:01 在设置里对 grok-4.7 点了「用内置能力」并保存（`models.json` 已是完整定义：思考 low–xhigh、看图、500K），回来说「还是不行」
- 原因（在运行中的服务上只读核实）：`/api/models` 目录已是 Grok 4.7 + low/medium/high/xhigh；但活跃会话（workProject，16:49 建）JSONL 里开局记的是 `thinking_level_change: off`。pi 的 `session.reload()` 只重载设置/资源/扩展，不碰模型；PiWeb 保存后只 `resetModelRuntime()` 给新会话换新 runtime，旧会话的 runtime 和 `session.model` 一直停在保存前 → 菜单仍「此模型不支持」。只有在菜单里主动选模型（`setModel` 从新目录取对象）才会换
- 改了什么：
  - `agent-manager.ts` 新增 `refreshSessionModels()`：活跃会话原地 `session.modelRuntime.refresh({ allowNetwork: false })`（多个会话共用的 runtime 只刷一次），当前模型换成新定义（同 pi 私有 `_refreshCurrentModelFromRegistry` 的做法，不记 model_change）；可用档位变了就 `session.setModel(next, { persist: false })` 走 pi 切模型的档位规则（单模型设置 > 全局默认，用户默认 max → Grok 4.7 钳到 xhigh），再 `reapplyDesiredLevel`，最后推 model 事件。页面开着的冷会话按新目录推档位
  - 冷会话模型/档位还原从 `buildSnapshot` 抽成 `coldModelState()`，语义不变
  - `models-service.ts` 的 `writeCustomProviders` 在 `reloadSessionsForCwd()` 之后调用它
  ```ts
  // src/lib/agent-manager.ts:1052
  const levels = session.getAvailableThinkingLevels().join();
  session.agent.state.model = next;
  if (session.getAvailableThinkingLevels().join() !== levels) {
  	await session.setModel(next, { persist: false }).catch(() => session.setThinkingLevel(session.thinkingLevel));
  	reapplyDesiredLevel(m, session);
  }
  publishModelState(m, session);
  ```
- 验证：`tsc --noEmit` 通过；全量 vitest **77 文件 493 通过 + 1 跳过**；新增 `tests/agent-model-refresh.test.ts`（真实 SDK、离线、禁网）：退化条目建会话只剩 off → `writeCustomProviders` 删掉条目 → 同一会话 reasoning true、档位等于内置、档位按默认 max 钳制、推了 model 事件；修复前的代码挂在 reasoning 断言上
- 影响文件：`src/lib/agent-manager.ts`、`src/lib/models-service.ts`、`tests/agent-model-refresh.test.ts`
- 下一步：用户当前会话在模型菜单里重选一次 Grok 4.7（或新开会话）即可生效；以后在设置里保存模型配置，已打开的会话会立即更新

## 2026-10-07 17:47 +08:00 | claude-opus-5-5 | grok-4.7「此模型不支持」思考的原因；内置提供方覆盖删空时整块移除（`590d2aa`）
- 起因：用户截图模型菜单里 grok-4.7 显示「思考 · 此模型不支持」，问「为什么模型不支持思考强度？」
- 原因（只读核对，未改用户配置）：用户 12:03 在 `~/.pi/agent/models.json` 加了 `xai: {api: "openai-responses", models: [{id: "grok-4.7"}]}`，当时 pi 0.85.1 内置 xAI 只有 grok-4.3/4.5/4.6（下载 0.85.1 包核对）；12:49 升 pi 1.0.4（`451d519`）后内置了 Grok 4.7（思考 low/medium/high/xhigh、看图、500K）。pi 规则是 `models` 同 ID 条目整条替换内置定义，于是生效定义回落缺省：reasoning false、只收文字、128K/16K，思考菜单只剩 off。用 pi 的 `ModelRuntime` 只读对比两份定义确认
- 改了什么：
  - 删掉这条的路原本走不通：编辑内置提供方、删掉最后一个模型行再保存 → `{api, models: []}`；添加内置提供方只填密钥 → `{}`。两者都被 pi 拒绝（`must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"`），保存失败、密钥也存不上。pi 0.85.1 同规则，是 PiWeb 旧 bug，不是升级带来的
  - `model-draft.ts` 加 `providerOverrideHasContent`（与 pi `applyModelsJson` 同口径）和 `withBuiltinOverride`：块删空就整块移除；有不下发前端的 apiKey 时保留，让服务端补回。`SettingsPanel.tsx` 的 `saveBuiltinEdit` / `saveBuiltinSetup` 改用它
  - 「与内置模型同 ID」提示改为先建议删掉这一行直接用内置的（中英）
  ```ts
  // src/lib/model-draft.ts:141
  export function providerOverrideHasContent(config: Readonly<Record<string, unknown>>): boolean {
  	const overrides = config.modelOverrides;
  	return (Array.isArray(config.models) && config.models.length > 0)
  		|| Boolean(config.baseUrl || config.headers || config.compat || config.apiKey || config.oauth)
  		|| (typeof overrides === "object" && overrides !== null && Object.keys(overrides).length > 0)
  		|| config.authHeader !== undefined;
  }
  ```
- 验证：`tsc --noEmit` 通过；全量 vitest **76 文件 492 通过 + 1 跳过**；新组件测试在旧 `SettingsPanel` 上失败、新代码通过；契约测试对照 pi 真实校验 11 种块形状。`next build` 留给 CI（本机 build 会生成 `.next/BUILD_ID`，`piweb` 会切生产模式）
- 注意：提供方行上的「删除」对内置提供方会连带 `removeKey`，会删掉 xAI 的 OAuth 登录，不是删单个模型的地方
- 影响文件：`src/lib/model-draft.ts`、`src/components/SettingsPanel.tsx`、`src/i18n.tsx`、`tests/model-draft.test.ts`、`tests/models-service-config.test.ts`、`tests/components/settings-model-roundtrip.test.tsx`
- 下一步：用户在 设置 → 模型 → xAI「编辑」→「自定义设置」里删掉 grok-4.7 行并保存（或授权代改），模型菜单应出现 Grok 4.7 与 low/medium/high/xhigh
