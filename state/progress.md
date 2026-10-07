# 进度

> 更早的条目：[state/archive/2026-10.md](archive/2026-10.md)、[state/archive/2026-09.md](archive/2026-09.md)

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

## 2026-10-07 14:10 +08:00 | Claude Code（云端） | B3 完成：截图上点选元素 → 元素芯片（`ba13e01`）；CI 锁文件修复（`627df1e`）
- 改了什么：
  - **CI 修复**（`627df1e`，已推送）：新 main 的 `npm ci` 报 EUSAGE——lock 里缺 `@tailwindcss/oxide-wasm32-wasi` 内置的 `@emnapi/core` / `@emnapi/runtime` 两条 inBundle 条目，只补这两条，其余 lock 不动
  - **取元素**（`src/lib/browser/inspect.ts`）：页面内 `elementFromPoint`（穿透 open shadow root），取标签、id、可见文本、DOM 路径、构建期源码属性（上溯 6 层），以及框架开发期线索——React ≤18 `fiber._debugSource`（带组件名）、Vue 3 `__vueParentComponent.type.__file` / Vue 2 `$options.__file`（只到文件）、Svelte `__svelte_meta.loc`（Svelte 4 行号从 0 起且带 `char` 时 +1，Svelte 5 不变）；返回值在服务端逐字段限长清洗
  - **定位内核**（`dev-inspect-service.ts`）：多认 `react-source` / `svelte-source`（文件:行:列）与 `vue-file`（只到组件文件）三个键；Vue 时组件内的文本命中排最前，文本太短或搜不到退回组件文件第 1 行；线索指向工作区外忽略。键名放在无依赖的 `source-hint-keys.ts`，浏览器内核不因此引入 pi SDK
  - **截图**（`manager.ts`）：`elementAt(x, y)`；`screenshot({region})` 按元素包围盒裁剪（留 6px 边、裁到视口内、长边超过 640 缩小）
  - **接口** `POST /api/browser`：`capture`（给该会话标签页重截一张）/ `pick`（取点 + 定位源码 + 裁剪图）；只操作 pi 已打开的页面，不导航、不新开标签页；请求体 4KB 上限；无页面 409、点空 404、找不到浏览器 503
  - **前端**：浏览器工具截图旁「选元素」，放大层上可连续点选，点中后描边显示元素位置；结果进当前会话输入卡的元素芯片（`ChatDraft.elements`，缩略图 + 标签 + 第一处源码位置，可删）；发送时在附件行之后拼成「标题行 + Markdown 列表」（页面、DOM、源码、组件），当前模型能看图时附上裁剪图（`ModelChoice.vision`，来自模型 `input` 是否含 image），编号接在用户自己的图片之后，总数不超过 20
  - README 中英文补一句用法
- 验证：`tsc --noEmit` 通过；全量 vitest **63 文件 430 通过 + 1 跳过**（含新增真实无头浏览器集成测试 9 项：React/Vue/Svelte4/Svelte5/data-source/shadow DOM/超大元素/滚动后裁剪像素校验）；`npm run build` 通过；**真实实例冒烟**（生产构建 + 本地假 OpenAI 兼容模型服务，不花 token）：新会话 → 模型调 `browser_open` 打开测试页 → 截图旁「选元素」→ 点按钮 → 芯片显示 `src/App.tsx:3` → 发送后模型收到元素描述与 1 张裁剪图；用户气泡里元素描述显示为列表（最初按缩进行拼接时被 Markdown 合成一段，已改）
- 冒烟中发现、留给下一项修：新会话页（Hero）默认模型取「第一个有凭据的模型」并显式 `setModel`，不看 pi 的 `defaultProvider/defaultModel`；思考强度也不读 pi 的默认值
- 未验证：Windows + Edge 上的点选（集成测试在 Linux Chromium 上跑）；真实 React/Vue/Svelte 开发服务器（用模拟页面覆盖了各框架的元数据形态）
- 影响文件：新增 `src/lib/browser/{inspect,pick}.ts`、`src/lib/element-draft.ts`、`src/lib/source-hint-keys.ts`、`src/app/api/browser/route.ts`、`src/components/ElementPicker.tsx`；修改 `src/lib/browser/manager.ts`、`src/lib/dev-inspect-service.ts`、`src/components/{AppShell,ChatInput,ChatWindow,ModelSelector}.tsx`、`src/app/api/models/route.ts`、`src/app/globals.css`、`src/i18n.tsx`、README；新增 5 个测试文件
- 下一步：模型配置对齐 pi 的思考强度（自定义模型的推理 / 档位 / 图片输入，默认思考强度与按模型默认，Hero 跟随 pi 默认模型）；已发消息的撤回与编辑重发；审查遗留问题

## 2026-10-07 12:40 +08:00 | claude-opus-5-5 | B1+B2 完成：pi 的眼睛（无头浏览器工具）（`ea4d0f3`）；误改本地依赖的事故记录
- 改了什么：
  - **spike 结论**：`--remote-debugging-pipe`（CDP 走浏览器第 3/4 号管道，不开调试端口）在 Windows + Edge 154 / Chrome 154 实测可用（查版本、开标签、导航、截图、执行脚本全通，启动约 1.2s），不需要端口模式兜底。前几次 EPIPE 是 spike 脚本里 heredoc 把路径反斜杠吞了、浏览器根本没启动，不是管道问题
  - **内核** `src/lib/browser/`：`locate.ts`（PI_WEB_BROWSER → Chrome → Edge → Chromium，按平台找）、`url-policy.ts`（只开 http(s)，默认只放行本机 / 私网，主机名会解析并要求全部解析结果都非公网；`PI_WEB_BROWSER_ALLOW_PUBLIC=1` 放开）、`cdp.ts`（NUL 分帧、id 关联、事件分发、超时、断管时挂起请求全部失败）、`manager.ts`（进程共用一个浏览器、每会话一个标签页、临时 profile、空闲 10 分钟回收；关闭时等进程退出并删 profile；记录控制台 error/warning、页面异常、请求失败、≥400 响应）
  - 公网判断从 `models-service.ts` 抽到 `src/lib/net-address.ts` 两边共用（`isPublicModelDiscoveryAddress` 导出名不变），避免浏览器模块 → models-service → agent-manager 的循环依赖
  - **工具** `tools.ts`：`browser_open / browser_screenshot / browser_console / browser_click / browser_type`；截图 JPEG 作为 `ImageContent` 直接交给模型，模型 `input` 不含 image 时改为文本大纲；只有 browser_open 带一条 promptGuidelines（改完 UI 先看效果、查控制台再说完成）；参数 schema 用 `@earendil-works/pi-ai` 导出的 `Type`（与 SDK 同一个 typebox 实例，不新增依赖）
  - **注册**：`ensureSession` 在本机找得到浏览器时传 `customTools: createBrowserTools(m.sessionPath)`；`disposeSession` 关对应标签页；`TOOL_PRESETS.standard` 加 5 个浏览器工具（readonly 不加：只读不该有网络能力；full 本就不限）
  - **展示**：工具结果图片经 `toWebMessage` / `tool_execution_end`（新增 `imagesOf`，最多 4 张）→ `ToolCardState.images` → `ToolStep` 缩略图（点开 portal 放大，Esc 关）；浏览器工具有自己的中英文动词
  - 测试：`tests/browser-kernel.test.ts`（定位 / 地址策略 / CDP，含从多字节字符中间切开的分帧）、`tests/browser-manager.integration.test.ts`（真实无头浏览器：截图 JPEG、console.error 与 404 记录、点击、输入回车提交、整页与元素截图、手机视口、拒绝连接时提示；找不到浏览器时整组跳过）、`tests/browser-tools.test.ts`、`tests/components/tool-screenshots.test.tsx`
- 验证：`tsc --noEmit` 通过；全量 vitest **59 文件 406 通过 + 1 跳过**；集成测试后临时目录无 `piweb-browser-*` 残留（补了 `--disable-breakpad/--disable-crash-reporter` 并让关闭流程等 profile 删除完成，此前 Crashpad 晚退出会留下目录）
- **事故（我造成的）**：为加 typebox 直接依赖跑了 `npm install typebox@1.3.27`，npm 顺带把本地 `node_modules` 按 lock 同步——用户本地原装的 pi SDK（迹象显示是 1.0.x，带 `pi-telemetry`，但从未写进 package.json / lock）被降回 lock 锁定的 0.85.1。随后改用 pi-ai 的 `Type`、还原清单、再同步一次，最终：清单与 HEAD 完全一致、`node_modules` 与 lock 一致（pi 0.85.1），类型检查与全量测试在 0.85.1 上通过。副作用：用户运行中的 dev 服务（30141）webpack 缓存了第一次安装时的嵌套路径 `pi-ai/node_modules/typebox`，第二次同步后该路径消失 → 报 `ENOENT ... pi-ai/node_modules/typebox/build/compile/index.mjs`。修复：停服务 → 删 `.next-dev-webpack/dev/cache`（或整个 `.next-dev-webpack`）→ 重启。若用户本来要用 pi 1.0.x，应走 `npm run update:pi` 正式升级（会更新清单并跑检查），之后需要在 1.0.x 上重新验证本次改动
- 未验证：真实模型调用浏览器工具的端到端（会花用户 token，未发 prompt）
- 影响文件：新增 `src/lib/browser/{locate,url-policy,cdp,manager,tools}.ts`、`src/lib/net-address.ts`；修改 `src/lib/agent-manager.ts`、`src/lib/pi.ts`、`src/lib/models-service.ts`、`src/lib/types.ts`、`src/hooks/usePiWeb.ts`、`src/components/ChatWindow.tsx`、`src/app/globals.css`、`src/i18n.tsx`；新增 4 个测试文件
- 下一步：用户确认 pi SDK 版本取向；B3（截图上点选元素 → 元素芯片）；M5（清理 iframe 遗留 + README）

## 2026-10-07 12:17 +08:00 | claude-opus-5-5 | A 完成：生长树改为每轮一个 git commit，按轮显示改动（`7e7a501`）
- 改了什么：
  - **存储**（`growth-service.ts`）：`snapshot()` 改为 `commitRound()`（:671），每轮 commit 到 `refs/piweb/rounds/<key>`，仍用独立暂存区 `GIT_INDEX_FILE`，不动 HEAD/分支/用户暂存区；元信息写进 commit：
  ```
  把保存按钮改成红色            ← 提问首行（按码点截 72 字，控制字符清掉）

  Piweb-Kind: round           ← round / user（你的修改）/ baseline（工作区第一个 commit）
  Piweb-Session: <会话 JSONL 文件名>
  Piweb-Prompts: <用户消息 entryId,…>
  Piweb-Status: done           ← done / aborted / error
  ```
  - 删掉 `ledger.jsonl` 与逐工具快照；链头直接 `for-each-ref` 读；`update-ref <ref> new old` 带旧值校验，别的进程抢先提交时按新链头重挂（最多 3 次）
  - **读取**：`readRounds()`（:794）一次 `git log -z --raw --numstat -M` 读回整条链，`parseRoundLog()`（:482）同时解析状态字母、行数、重命名、二进制和 trailers；按 commit 缓存，链头变了只增量读；只读路径用 fs 判断引用是否存在（含 commondir / packed-refs），不建仓库；`log.showRoot/showSignature/diff.relative` 用 `-c` 关掉，防用户配置污染输出
  - **触发**（`growth-tracker.ts` 328→~130 行）：`prepare()`（发 prompt 前）调 `recordWorkspaceChanges()` 把两轮之间用户自己的修改记成「你的修改」（工作区还没提交过时记基线）；`agent_start`→`agent_settled` 为一轮（重试的第二次 agent_start 不重开），结束时从会话条目取本轮提问（`growth-turns.ts` 的 `promptsFromEntries`），没改动也提交空 commit，轮号与对话一一对应；删掉 `fs.watch`、外部修改去抖、`growth_pending` 事件
  - **接口**：`GET /api/growth` 返回 `{available, rounds}`；`POST {action:"record"}` 取代 `snapshot`；tree 相关四个接口不变
  - **前端**：`useGrowth` 改为按轮（「本轮」用 commit 自带清单、「本会话累计」= 会话起点→所选轮；基线不显示，「你的修改」不占轮号）；加 `watchRounds`：有会话就拉时间轴（对话标签要用），磁盘目录仍只在面板打开时拉；`ProjectPanel` 头部显示提问/时间/文件数/±行数/在对话里看，范围「本轮 | 本会话累计」，「只看改动」默认开；时间轴柱高 = 改动行数（对数缩放）
  - **对话**：每条提问下加「本轮改了 N 个文件 +a −d」（`ChatWindow` 的 `RoundBadge`），点击打开项目栏并选中这一轮；提问气泡带 `data-message-id`，项目栏「在对话里看」滚过去并描边闪一下
  - **顺手修的老问题**：`.pw-tl-rail` / `.pw-tl-bar` 从来没有样式定义（git 历史里也没有），旧时间轴的柱子宽度为 0、实际看不见，这次补上
  - 注册表全局键改为 `__piWebGrowthRounds`：dev 热更新后不复用旧结构（快照 + 账本）的工作区状态；`GROWTH_TRACKER_VERSION` 3→4 让旧 tracker 自动换新
  - 删除 `growth-rounds.ts`（按时间对齐轮次）与快照里的 `userTurns`；i18n 删 14 个旧键、加 13 个新键，「快照」统一改称「记录」
- 验证：`tsc --noEmit` 通过；全量 vitest **55 文件 386 通过 + 1 跳过**；真实实例（30141）冒烟：临时目录新建会话 → 立即记录得到基线 → 无改动返回 null → 改文件得到「你的修改」（变更正确）→ 接口读回 `baseline,user` → `git log` 能看到标题与 trailers、HEAD 未诞生、无账本；未在会话库留下文件
- 未验证：真的跑一轮模型后的 round commit（需要花用户的 token，没发 prompt；已由真实 git 的 tracker 单测覆盖）
- 旧数据：今天旧版留下的 `refs/piweb/growth/*` 与 `.git/piweb/ledger.jsonl` 不迁移、不删除；清理命令在 M5 写进 README
- 影响文件：`src/lib/growth-service.ts`、`src/lib/growth-tracker.ts`、`src/lib/growth-turns.ts`、`src/lib/types.ts`、`src/lib/agent-manager.ts`、`src/app/api/growth/route.ts`、`src/hooks/useGrowth.ts`、`src/hooks/usePiWeb.ts`、`src/components/ProjectPanel.tsx`、`src/components/ChatWindow.tsx`、`src/components/FileViewer.tsx`、`src/components/AppShell.tsx`、`src/app/globals.css`、`src/i18n.tsx`，及对应测试（删 `growth-rounds` 两个文件，新增 `tests/components/chat-round-badge.test.tsx`）
- 下一步：B1 浏览器内核（先做 pipe 传输在 Windows + Edge/Chrome 上的 spike）

## 2026-10-07 13:25 +08:00 | muse-spark-1.3-contributor-free | M5 收尾提交并推送 GitHub，云端可接手
- 改了什么：
  - 把本地未提交的 M5 收尾一次性提交（`dc96ef8`）：删 `public/piweb-inspect.js` 与 `src/app/api/dev-inspect/route.ts`（iframe 预览残留，按计划移入 `backups/` 后从 git 移除，`backups/` 本就进 `.gitignore` 只留本地）；删 `src/i18n.tsx` 里 22 个 `devPreview*`/`devInspectKind*` 文案键；`README.md`/`README_zh.md` 同步生长树（每轮一个 git commit，`refs/piweb/rounds/<key>`）与 pi 的眼睛（5 个 browser 工具、`PI_WEB_BROWSER`、私网放行）说明
  - 计划文件入仓：`C:\Users\guica\.claude\plans\bubbly-meandering-dream.md` 原样复制为 `docs/plan-2026-10-07-growth-browser.md`（用户选了 docs 位置，老项目不建 `planning/`），云端可直接读 A（生长树）/B（pi 的眼睛）/M5/验证清单
  - 推送前验证：`npm run typecheck` 通过；全量 `npx vitest run` **59 文件 406 通过 + 1 跳过**（跳过的是 Windows 符号链接权限用例）
- 影响文件：`README.md`、`README_zh.md`、`src/i18n.tsx`、删除 `public/piweb-inspect.js`、`src/app/api/dev-inspect/route.ts`，新增 `docs/plan-2026-10-07-growth-browser.md`
- 下一步：云端接手 B3（截图上点选元素 → 元素芯片）与后续迭代；本地 `backups/2026-10-07-iframe-dev-preview/` 仅本地保留不推送
