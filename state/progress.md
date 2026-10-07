# 进度

> 更早的条目：[state/archive/2026-10.md](archive/2026-10.md)、[state/archive/2026-09.md](archive/2026-09.md)

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

## 2026-10-07 17:02 +08:00 | claude-opus-5-5 | 设置 → 模型：提供方行布局修复（`9ed1519`）+ 去掉「默认模型与思考强度」面板（`918624c`）
- 起因：用户截图反馈 xAI 那一行按钮被挤成竖排、名称消失；又问「为什么多了这个面板」「那么复杂」「思考强度找 pi 内置的不就行了」，选择「整块去掉」
- 改了什么：
  - **提供方行**（`SettingsPanel.tsx`）：原单行 flex 里按钮可压缩，中文逐字折行成竖排、名称区 `min-w-0` 被压到 0。xAI 同时有 OAuth 凭据、可 OAuth 登录、且 `~/.pi/agent/models.json` 有用户今天 12:03 加的 `xai`（grok-4.7）覆盖 → 多出「删除」时触发。改为整行 `flex-wrap`：名称保留 8rem，状态点 / 凭据标签 / 按钮合成 `flex-none whitespace-nowrap` 一组，放不下整组换到第二行靠右
  - **去掉面板**：删 `ModelDefaultsBlock`（约 210 行，云端 `772d8e7` 加的：默认模型、默认强度、按模型强度、思考预算）及专用的 `catalog` 状态与导入，删 17 个专用文案键（中英各 17）；README 中英文「模型」一条同步
  - **保留**（`772d8e7` 里的真修复）：新会话跟随 pi 的 `defaultProvider/defaultModel/defaultThinkingLevel`（不再误选第一个有凭据的模型）；自定义模型按内置 ID 预填能力；模型菜单「设为默认」；`/api/pi-settings` 读写不动
- 验证：`tsc --noEmit` 通过；全量 vitest **76 文件 488 通过 + 1 跳过**（删掉 1 个专测面板的用例）；在用户运行中的服务（30141，dev 热加载）上用无头 Chrome 核对 1280 / 1000 两种宽度：面板文字已不存在，xAI 行四个按钮高 24–28px（单行），名称区宽 464px，按钮组换到第二行，截图目视确认
- 影响文件：`src/components/SettingsPanel.tsx`、`src/i18n.tsx`、`README.md`、`README_zh.md`、`tests/components/model-defaults.test.tsx`
- 下一步：等用户继续试用反馈

## 2026-10-07 15:58 +08:00 | claude-opus-5-5 | 云端分支快进合入 main 并推送；本机补验 Windows + Edge
- 改了什么：
  - 用户选择「直接快进 main 并推送」：`main` 从 `9ee0a84` 快进到云端分支 `claude/funny-lamport-q9lcem` 的 `04be3f5`（14 个提交：B3 点选元素、思考强度对齐 pi、消息编辑重发 / 撤回、技能删除、npm 安装首次构建与检查更新、密码防爆破、CI actions v5、lock 补回 `@emnapi`），无冲突；远端分支保留未删
  - 本地那段 README 状态段改动与云端 `77e33cd` 重复，存进 `git stash`（`local README status edit (superseded by cloud 77e33cd)`），未提交
  - progress 超 150 行，按日期把 11:21、11:54 两条搬进 `state/archive/2026-10.md`（`6cb3d31`）
- 验证（合并前，在用户这台 Windows 机器上）：
  - GitHub CI：云端分支最新提交 Linux / Windows × Node 22.19 / 24 全部通过；中途 15:05 那次是 Windows 上技能删除测试失败（个人技能被误判为包管理技能），已由 `9e6d339` 真正修复
  - `tsc --noEmit` 通过；全量 vitest **76 文件 489 通过 + 1 跳过**（Windows + Chrome，与云端报告一致）
  - 补上云端标注的「未验证：Windows + Edge」：`PI_WEB_BROWSER` 指向 Edge 重跑 `browser-manager.integration` / `browser-pick.integration` / `dev-inspect-service` 三个文件 **23 项全部通过**（无跳过）；测试后无 `piweb-browser-*` 临时目录残留
- 未验证：真实 React / Vue / Svelte 开发服务器上的点选（集成测试用模拟页面覆盖了各框架元数据形态）
- 影响文件：仅 `state/progress.md`、`state/archive/2026-10.md`（代码随快进合入，无本地改动）
- 下一步：等用户在 dev 服务上试用 B3 与新功能的反馈

## 2026-10-07 15:50 +08:00 | Claude Code（云端） | 审查遗留问题修复：技能删除（`9e6d339`）、npm 安装首次构建（`6a6e57b`）与检查更新（`04e600c`）、密码防爆破（`10e8d57`）、CI actions v5（`9f9f64e`）
- 起因：用户授权「全方面你觉得哪些可以改进的都可以提交出来」。逐条核对此前审查列出的问题在新 main 上是否仍成立，成立且值得的各自单独提交
- 改了什么：
  - **技能删除**（`9e6d339`）：旧逻辑总是删 `dirname(技能文件)`——单文件技能 `~/.pi/agent/skills/foo.md` 会删掉全部全局技能，`.agents/skills/group/a.md` 连带删掉 `b.md`，settings 另配的工作区路径（如 `notes/guide.md`）删掉整个 `notes`。来源按路径前缀猜：Windows 短名（`C:\Users\RUNNER~1`）下全局技能被判成包技能，Windows CI 的 skills-delete 因此一直红（run 130–133）；pi 从 git 装的包技能反被判成全局。现在来源用 pi 给的 `sourceInfo`（origin / scope）；目录技能删目录、单文件技能只删文件、符号链接只删链接；只删 pi 默认技能目录里面的条目，集合根上的 SKILL.md 与 settings 另配的路径拒绝并提示手动处理；列表带 `deletable`，设置页只对可删的技能显示删除
  - **npm 安装首次构建**（`6a6e57b`）：发布包不带 `.next`，全局安装靠首次构建。暂存目录取 `dirname(dirname(root))`，scoped 包（`…/lib/node_modules/@rexvane/piweb`）取到的仍在 `node_modules` 里，被 Next 排除，构建报 `Can't resolve '@/i18n'`——`npm i -g @rexvane/piweb` 在各平台都起不来；退回系统临时目录的分支还用了未导入的 `os`。改为沿路径上溯到不含 `node_modules` 段，建不了再退回系统临时目录；失败提示改成正确包名，并说明再次运行 piweb 即重试
  - **npm 安装检查更新**（`04e600c`）：npm 安装没有 Git 仓库也没有开发依赖，原「检查更新」跑 `git fetch` 必报错，pi 引擎更新要跑 `npm run check` 必失败。改为 `npm view @rexvane/piweb version` 对照 registry，返回命令 `npm install -g @rexvane/piweb@latest`；pi 引擎标为随 PiWeb 发布版本更新；`runUpdate` 对 npm 安装直接拒绝，不执行任何命令；设置页显示可复制的命令，提示先停止 piweb 再运行、然后重新启动（npm 替换整个安装目录，Windows 还会锁住已加载的原生模块）；`npm link` 的开发安装按真实路径落在 Git 仓库里，仍走 git 更新
  - **密码防爆破**（`10e8d57`）：`PI_WEB_PASSWORD` 是对外访问的唯一门槛，背后是能执行命令的智能体，原登录接口和 Basic 都不限次数。新的错误密码先给 10 次，之后每 30 秒恢复一次；额度用完时不校验任何密码（猜中的也回 429 + Retry-After）；整个进程一份额度（Next 拿不到可信的客户端地址，按可伪造的请求头分桶等于没限）；只有没见过的错误密码扣额度（加盐摘要记最近 256 个），浏览器反复带旧密码不会把人锁在外面；会话 Cookie 先于 Basic 判定，已登录的浏览器不受影响；Basic 在 proxy 里限速，额度用完时公开路径也回 429（`GET /api/web-auth` 绕不过去），登录表单在路由里另有一份额度；登录页显示「请 N 秒后再试」；额度耗尽时服务端日志提示一次
  - **CI**（`9f9f64e`）：每个任务都报 Node.js 20 弃用（checkout@v4 / setup-node@v4 被强制跑在 Node 24），check 与 publish 两个工作流升到 v5
  - README 中英文：npm 安装的更新方式；密码限速说明；状态段日期改为 2026-10-07、补此后的变化与测试数；已知限制补三条（编辑 / 撤回不还原文件、限速是全服一份额度、`web-uploads` 不自动清理）
- 验证：
  - `tsc --noEmit` 通过；全量 vitest **76 文件 489 通过 + 1 跳过**（跳过的是仅 Windows 运行的 PowerShell 编码测试）；`npm run build` 通过（只有既有的 release.mjs Critical dependency 警告）；`git diff --check` 通过
  - 技能删除：旧代码实测删 `solo.md` 删掉整个 `agent/skills`、删 `first.md` 连带删掉 `second.md`；新代码接真实加载器实测 solo / 符号链接（只删链接，源目录完好）/ first（second 保留）/ 项目技能 / 目录技能均正确，settings 另配的技能被拒绝
  - 首次构建：模拟 scoped 全局安装，旧逻辑在 `lib/node_modules/.piweb-build-*` 构建失败，新逻辑在 `lib/.piweb-build-*` 26 秒构建成功并拷回 `.next`
  - 密码限速：生产服务器 + 密码实测——10 个新的错误 Basic 之后，正确密码回 429（`/api/version` 与 `/api/web-auth` 都是），已见过的错误密码仍回 401，带 Cookie 的请求 200；登录表单同样；约 30 秒后正确密码恢复 200；日志两份额度各提示一次。另做 5 个变异（去掉去重 / 先判对错再限速 / proxy 不限速 / 路由不限速 / 公开路径放行），测试都能抓到
  - CI：run 134–136 四个任务全绿，Windows 上的 skills-delete 从红转绿；run 137（HEAD `9f9f64e`，含限速与 v5 actions）四个任务全绿，Node.js 20 弃用警告不再出现
- 未验证：npm 安装的「检查更新」只有单元测试和组件测试，没对真实 registry 跑过；publish.yml 的 v5 要到下次发布才会运行；Windows 上 npm 覆盖运行中安装时锁文件是推断（所以提示先停止 piweb）
- 建议（未做）：`~/.pi/agent/web-uploads/` 不自动清理——会话按绝对路径引用这些文件，自动删除会让旧会话里的引用失效，已写进 README 已知限制；以后可考虑按会话引用计数清理，或在设置页给手动清理入口
- 影响文件：修改 `src/lib/{path-security,skills-service,update-service}.ts`、`src/proxy.ts`、`src/app/api/web-auth/route.ts`、`src/app/login/page.tsx`、`src/components/SettingsPanel.tsx`、`src/i18n.tsx`、`scripts/{install-build,launcher}.mjs`、`.github/workflows/{check,publish}.yml`、README、`tests/{skills-delete,update-service}.test.ts`、`tests/components/login-page.test.tsx`；新增 `src/lib/password-throttle.ts`、`tests/{install-build,password-throttle}.test.ts`、`tests/components/{skills-section,update-control}.test.tsx`
- 下一步：审查清单已处理完；等用户反馈

## 2026-10-07 15:05 +08:00 | Claude Code（云端） | 已发消息可编辑重发与撤回（`3b03fa9`）
- 起因：用户问「发出去的消息如何修改撤回」。此前只能在会话树里跳节点，没有针对某条用户消息的编辑 / 撤回入口，运行中也撤不回
- 语义：与 pi 终端 `/tree` 选中用户消息相同——`navigateTree(用户消息 entryId)` 把叶子移到它的父节点并交回原文；**不破坏历史**，原分支留在会话 JSONL 里，终端 pi 的 `/tree` 仍能找回
- 改了什么：
  - **服务端** `rewind` 命令（`agent-manager.ts`）：校验是当前对话里的用户消息 → 清队列（清出的文本交回前端）→ 运行中先中止（同 Esc）→ `navigateTree` → 广播 `history` → 带 `text/images` 时接着作为新消息发出。全程占住 `promptSubmitting` 提交位，中间插不进别的提问；扩展可经 `session_before_tree` 取消；重发失败时返回 `rewound`，前端把改过的内容放回输入框。prompt 的提交与释放抽成 `submitPrompt` / `releasePromptSlot`，两条命令共用
  - **接口**：命令失败时也带回 `data`（已清出的排队文本、已回退标记）
  - **前端**：用户消息操作栏加「编辑」「撤回」（只对已落盘、有 entryId 的消息）。编辑在气泡原位展开：可删原图，Enter 发送 / Shift+Enter 换行 / 输入法组字中不触发 / Esc 取消；提示「之后的 N 轮对话会从当前对话移除（会话文件里仍保留）」，这一轮起改过文件时追加「已改动的文件不会还原」。撤回在没有损失时直接执行，否则先确认；撤回后原文（服务端 `editorText`）、图片与被清出的排队消息放回输入框，排在已有草稿前面
  - **同步**：新事件 `history`，所有打开该会话的页面收到后安静重连取新快照（不闪「重连中」），旧连接上迟到的帧丢弃
  - README 中英文补一句
- 验证：`tsc --noEmit` 通过；全量 vitest **71 文件 471 通过 + 1 跳过**（新增 4 个测试文件：服务端 rewind 6 项——运行中撤回先清队列再中止、空闲时不中止且同一命令内重发、非用户消息 / 不在当前分支拒绝、提交位被占与空内容拒绝、扩展取消时交回队列、重发失败标 rewound；气泡编辑 / 撤回 5 项；撤回内容回输入框 4 项；history 重连 1 项，含去掉旧连接保护时会失败的断言）；`npm run build` 通过；**真实实例冒烟 9 项全过**（生产构建 + 假模型）：编辑第一句时提示后面 1 轮会移出 → Enter 重发后对话只剩改过的那句，模型请求里也只有它 → 慢速流式中途撤回：内容回到输入框、未完成的回复消失、之后不再调模型 → 继续对话时模型上下文跳过撤回的那条 → 刷新后历史就是新分支 → 会话文件里旧分支（第二句、慢一点）仍在
- 已知限制：不还原文件（pi `/tree` 同样不还原；每轮的生长 commit 可对照恢复）；服务端还没加载的冷会话撤回时会先冷启动 agent；回退到压缩点之前的消息会恢复未压缩的上下文（与 pi `/tree` 一致）
- 未验证：带图片的编辑重发只在单元测试覆盖，端到端没带图；多个标签页同时编辑同一会话（服务端提交位保证串行，界面上后到的一方会收到忙碌错误）
- 影响文件：修改 `src/lib/{agent-manager,command-validation,types}.ts`、`src/app/api/agent/[id]/route.ts`、`src/hooks/usePiWeb.ts`、`src/components/{AppShell,ChatWindow,icons}.tsx`、`src/app/globals.css`、`src/i18n.tsx`、README、`tests/command-validation.test.ts`；新增 `tests/agent-rewind.test.ts`、`tests/use-piweb-history.test.tsx`、`tests/components/{message-rewind,app-shell-rewind}.test.tsx`
- 下一步：审查遗留问题（技能删除可删到集合根、作用域判断缺 realpath、install-build 暂存目录等），各自单独提交

## 2026-10-07 14:45 +08:00 | Claude Code（云端） | 模型配置对齐 pi 的思考强度（`772d8e7`）
- 起因：用户反馈「模型配置里没有思考强度」。查下来四处断开：① 自定义模型表单没有 `reasoning` / `thinkingLevelMap` / `input`，自定义模型的思考菜单永远只有 off；② 内置提供商下写同 ID 的模型条目会**整条替换**内置定义，能力随之丢失；③ 新会话页默认取「第一个有凭据的模型」并显式 `setModel`，不看 pi 的 `defaultProvider/defaultModel`（有 AWS 环境凭证时会选到 Bedrock）；④ PiWeb 不暴露 `defaultThinkingLevel` / `modelThinkingLevels` / `thinkingBudgets`
- 改了什么：
  - **纯函数** `src/lib/thinking.ts`（前后端共用、不依赖 SDK）：档位、`supportedThinkingLevels` / `clampThinkingLevel`（与 pi-ai 逐项对照测试）、新会话默认强度推导（按模型 → 全局默认 → medium，再钳到模型档位）、档位表 ↔ `thinkingLevelMap` 互转、pi-ai 默认思考预算
  - **pi 设置**（`pi-settings.ts`）：读写 pi 自己的键 `defaultProvider/defaultModel`、`defaultThinkingLevel`、`modelThinkingLevels`、`thinkingBudgets`（null 删除、空对象整个删）；严格校验（模型键 `provider/id`、≤200 条、预算正整数 ≤2M）；读回宽松（手改的非法值当未设置）；`/api/models` 随目录附带 `defaults`
  - **自定义模型行**：「容量与能力」里加「支持思考 / 支持图片输入」、可用档位（xhigh / max 需显式打开）、每档发送值（如 OpenAI 兼容接口的 `reasoning_effort`）和思考菜单预览；只在改动时写，关掉即删键回到 pi 默认
  - **内置提供商**：`builtinModels` 接口给出未经 models.json 改动的内置定义；目录里标「已内置」且不默认勾选，填入内置 ID 自动预填能力，旧的替换条目可点「用内置能力」补回
  - **设置 → 模型**：新增「默认模型与思考强度」（默认模型只列认证就绪的提供商，默认不可用时标出；默认强度；按模型强度可增删改；思考预算折叠区，占位显示 pi 内置值）
  - **模型菜单**：默认模型与新会话会用的档位标「默认」，每档附 pi 终端同款说明；底部「设为默认」（同终端 `/model`、`/thinking` 的 Ctrl+S；该模型有单独强度时一起改）
  - **新会话页**：显示 pi 的默认模型与强度；用户没改时什么都不下发、交给 pi 自己应用（项目级设置也随之生效），改过才显式 `setModel` + `setThinkingLevel`
- 验证：`tsc --noEmit` 通过；全量 vitest **67 文件 455 通过 + 1 跳过**（新增 thinking / 能力表单 / 默认值 / 新会话页 4 个测试文件）；`npm run build` 通过；**真实实例冒烟 13 项全过**（生产构建 + 假 OpenAI 兼容模型，**保留 AWS 环境凭证**复现原问题）：新会话页显示 Mock Vision · medium 且请求 `reasoning_effort=medium` → 设置页把默认强度改 high（settings.json 写入 `defaultThinkingLevel`）→ 在 UI 里给自定义 mock-text 开「支持思考」、high 档发 `deep-think`（models.json 写入 `reasoning` + `thinkingLevelMap`，apiKey 保留）→ 新会话显示 high，选 Mock Text 后请求里 `reasoning_effort=deep-think` → 会话中「设为默认」Mock Text · low 写入 pi 的三个键 → 再开新会话直接是 Mock Text · low，pi 自己应用
- 未验证：项目级 `.pi/settings.json` 覆盖全局默认时，新会话页显示的仍是全局默认（发送时 pi 用项目级，结果正确、显示可能不一致）；按 token 预算思考的真实接口（Anthropic / Google / Bedrock）上的预算生效
- 影响文件：新增 `src/lib/thinking.ts`；修改 `src/lib/{pi-settings,models-service,model-draft}.ts`、`src/app/api/models/route.ts`、`src/components/{AppShell,ChatInput,ModelSelector,ProviderSetupModal,SettingsPanel}.tsx`、`ProviderSetupModal.module.css`、`globals.css`、`src/hooks/usePiWeb.ts`、`src/i18n.tsx`、README；新增 4 个测试文件
- 下一步：已发消息的撤回与编辑重发；审查遗留问题（技能删除可删到集合根、作用域判断缺 realpath、install-build 暂存目录等）
