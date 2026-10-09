# 生长树改为「每轮一个 git commit」+ 开发者模式改为「pi 的眼睛」

## Context
**用户已拍板的决定：**
1. **生长树全面改用 git**：每轮结束 commit 一次；面板上每一轮的改动 = `git diff 上一轮 这一轮`；元信息写进 commit。去掉现在的逐工具快照、旁路账本 `ledger.jsonl` 和外部修改监听。
2. **按轮显示**：用户已确认下面的样子——头部显示这一轮的提问、文件数和行数；文件列表只列本轮改动，点开看 diff；时间轴每轮一根柱，高度 = 改动行数；对话流里每条提问下加「本轮改了 N 个文件」。
   ```
   第 7 轮 · 把保存按钮改成红色
   14:32 · 4 个文件 +12 −3      [在对话里看]
   ( 本轮 | 本会话累计 )         [只看改动]
     M src/components/Settings.tsx  +8 −2   ← 点开 = 这一轮的 git diff
   ▂▅▁▇▃░▆  ◀ 第 7/9 轮 ▶  [跟随最新]       ← 灰色细柱 = 你在两轮之间自己的修改
   ```
3. **开发者模式改走「pi 的眼睛」**：系统 Edge/Chrome 无头启动 + CDP，交给 pi 一组浏览器工具。**截图只给 pi 看**（验证自己改的界面，发现问题接着改），对话流里展示 pi 看到的截图；**不做每轮截图存档**。
4. iframe 版本只保留定位内核（`dev-inspect-service`）。

**我选的默认做法（批准即视为同意）：**
- commit 记在专用引用 `refs/piweb/rounds/<key>`，用独立暂存区，不动 HEAD、分支和用户暂存区；
- 今天旧版留下的 `refs/piweb/growth/*` 和 `.git/piweb/ledger.jsonl` 不迁移、不删除（只在今天未发布的版本里存在过），README 写清理命令；
- 没有改动的轮也提交一个空 commit，保证轮号和对话一一对应；
- 「在截图上点选元素」放到最后一批（B3）。

## M0：收尾 iframe 方案
- 提交定位内核：`src/lib/dev-inspect-service.ts`、`tests/dev-inspect-service.test.ts`。
- 移入 `backups/2026-10-07-iframe-dev-preview/`：`src/components/DevPreviewPanel.tsx`、`tests/components/dev-preview-panel.test.tsx`。
- 还原未提交的改动：`src/components/AppShell.tsx`、`src/i18n.tsx`、`src/proxy.ts`、`tests/proxy-auth.test.ts`。proxy 放行在新方案里用不上。
- progress 记一条「方向变更」并提交。

## A：生长树改为每轮一个 git commit

### A1 写入（`src/lib/growth-service.ts`）
- **保留**：`ensureGitDir`（非 git 目录自动 init、子目录嵌套 init、拒绝裸仓库）；独立暂存区 `GIT_INDEX_FILE=<gitdir>/piweb/index`；`exclude` 文件；`refreshIndex`；`write-tree`；`BASE_CONFIG`（关闭 LFS 等）；`runGit`；`withLock`；`workspaceKey`。
- **`snapshot()` 改为 `commitRound(cwd, meta)`**：
  - `meta = {kind: "round" | "user" | "baseline", session, title, promptIds?, status?: "done" | "aborted" | "error"}`；
  - `commit-tree -p 上一个commit`。`round` 类型即使 tree 没变也提交（空 commit），`user` 类型只在有改动时提交；
  - `update-ref <ref> new old` 带旧值校验，防止多个进程并发写；
  - commit message 如下：
  ```
  第 7 轮：把保存按钮改成红色            ← title 取提问首行（截 72 字）

  Piweb-Kind: round
  Piweb-Session: <会话 JSONL 文件名>
  Piweb-Prompts: <用户消息 entryId,…>
  Piweb-Status: done
  ```
- **删除账本**：上一个 commit 直接用 `rev-parse --verify -q <ref>` 取得。
- **只读路径不创建仓库**：先用 `resolveGitDirFast` 判断，没有 `.git` 或没有这个 ref 就返回空。

### A2 触发（`src/lib/growth-tracker.ts`，从 328 行大幅精简）
- **删除**：逐工具快照调度（`tool_execution_end`）、`fs.watch` 监听、`growth_pending` 事件和防抖。
- **`prepare()`**（`agent-manager.ts:1246` 发 prompt 之前已经在调用）：
  - 工作区和上一个 commit 不同 → 先提交一个 `user` commit（显示为「你的修改」）；
  - 工作区从来没提交过 → 提交 `baseline`，作为起点，不算一轮。
- **轮结束**：`agent_settled` 时，如果这一段里出现过 `agent_start`，就由 agent-manager 从 `m.sm.getEntries()` 取出本次运行新增的用户消息（得到 entryId 和首行），调用 `commitRound({kind: "round", …})`。用户中止时 `status` 记为 `aborted`。
- **「立即快照」按钮** 改为「立即记录」，提交一个 `user` commit。

### A3 读取与 API
- **`readRounds(cwd, session?)`**：
  - 用一次 `git log --raw --numstat -M -z --format=<分隔符包裹的 %H %T %P %ct %B> <ref>`，同时拿到每轮的 A/M/D/R 状态字母、每个文件的 +/− 行数（含重命名和二进制）和 trailers；
  - 解析复用、改造现有的 `parseNameStatus` / `parseNumstat`；
  - 结果按 commit 哈希缓存（commit 不可变），新增一轮只需解析一个 commit；
  - 按 `Piweb-Session` 过滤会话。
- **每轮的数据结构**：`{commit, parent, tree, parentTree, ts, kind, title, session, promptIds, status, changes[{status, path, from?, add, del, binary}], stats}`。
- **`src/lib/types.ts`**：用 `GrowthRound` 取代 `GrowthStep`；`growth` 事件改为携带新的一轮；删除 `growth_pending`。
- **`src/app/api/growth/route.ts`**：
  - `GET ?cwd&session` 返回 `{available, rounds}`；
  - `list` / `changes` / `path` / `content` 四个接口照旧接受 tree 哈希，内部仍然是 `ls-tree` / `diff-tree` / `diff` / `cat-file`，前端看 diff 的逻辑不用改；
  - `POST snapshot` 改为 `POST record`；
  - 写路由前先读 `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`。

### A4 前端按轮显示
- **`src/hooks/useGrowth.ts`**（649 行）：数据改成 rounds（接口加实时 `growth` 事件）。
  - 「本轮」= `parentTree → tree`；
  - 「本会话累计」= 会话第一轮的 `parentTree → 所选轮的 tree`；
  - 跟随最新、上一轮 / 下一轮；
  - 建树复用 `src/lib/growth-tree.ts` 的 `buildTree`。
- **`src/components/ProjectPanel.tsx`**：
  - 头部：提问首行、时间、文件数、+a −d，以及「在对话里看」；
  - 范围切换「本轮 | 本会话累计」，「只看改动」默认打开；
  - 时间轴柱高 = 改动行数（对数缩放），颜色按主要改动类型；「你的修改」显示为灰色细柱；运行中末尾显示「本轮进行中」占位。
- **`src/components/GrowthTree.tsx`**：文件行显示 +a −d。
- **`src/components/ChatWindow.tsx`**：用户消息下方加标签「本轮改了 N 个文件 +a −d」，按 `promptIds` 关联；点击时打开项目栏并选中这一轮（经 AppShell 回调）。
- **删除**：`src/lib/growth-rounds.ts` 按时间对齐轮次的逻辑（轮次现在直接来自 commit）。`growth-turns.ts` / `userTurns` 如果没有别的用处也一并移除，先 grep 确认。

### A 的已知限制
- 同一工作区两个会话同时运行时，改动可能互相串到对方的轮里（现有方案也有这个问题）。
- 一轮之内的细分只在对话流里有：edit/write 自带逐次 diff，bash 的改动只能看到本轮汇总。

## B：pi 的眼睛（截图只给 pi 看）

### B1 浏览器内核（`src/lib/browser/`，不新增 npm 依赖）
- **`locate.ts`**：按顺序找浏览器——`PI_WEB_BROWSER` → Windows 的 Edge/Chrome → macOS 的 `/Applications/*.app` → Linux 在 PATH 里找。文件系统操作可注入，便于测试。
- **`cdp.ts`**：极简 CDP 客户端（id 关联、事件分发、扁平 session、超时）。
  - 传输优先用 `--remote-debugging-pipe`（第 3/4 号管道，不开端口）；
  - 第一步先做 spike，验证它在 Windows + Edge/Chrome 下可用；不行就退回 `--remote-debugging-port=0` + `DevToolsActivePort` + Node 内置 WebSocket。
- **`manager.ts`**：浏览器进程单例挂在 globalThis 上（沿用 `agent-manager.ts:86` 的写法）。
  - 启动参数：`--headless=new`，profile 放在临时目录 `os.tmpdir()/piweb-browser-<pid>`；
  - 每个会话一个标签页，默认视口 1280×800；
  - 控制台环形缓冲：console 的 error/warning、页面异常、网络失败、状态码 ≥400 的响应；
  - 空闲 10 分钟回收；进程退出时清理；在 `disposeSession`（:848）里关闭对应标签页。
- **`url-policy.ts`**：只允许 http(s)，默认只放行回环地址、`*.localhost` 和私网地址（复用 `models-service.ts:284` 的判断取反）。公网地址需要设置 `PI_WEB_BROWSER_ALLOW_PUBLIC=1`。

### B2 工具与展示
- **`src/lib/browser/tools.ts`**：用 `defineTool` + `typebox` 定义工具（`typebox@1.3.27` 加进直接依赖）：
  - `browser_open {url, device?}`：返回截图、标题、URL、控制台计数；
  - `browser_screenshot {fullPage?, selector?}`；
  - `browser_console {level?}`；
  - `browser_click {selector | x,y}`；
  - `browser_type {selector, text, submit?}`；
  - 截图为 JPEG，最大 1280 宽；
  - 如果 `ctx.model.input` 不包含 `"image"`，改为返回文本：可见文本大纲、可交互元素、控制台摘要；
  - `promptGuidelines` 写一条：改完 UI 后截图验证，并检查控制台。
- **注册**：`ensureSession`（`agent-manager.ts:739`）把 `customTools` 传给 `createAgentSession`。`TOOL_PRESETS`（`pi.ts:363`）只给 `standard` 加这 5 个工具，`readonly` 不加。找不到浏览器时不注册。
- **截图在对话流里显示**：
  - `types.ts:78` 的 toolResult 和 tool 事件加 `images`；
  - `toWebMessage`（`agent-manager.ts:132`）和 `tool_execution_end`（:452）把图片透传出去；
  - `ChatWindow.tsx` 的 `ToolStep`（:433）显示缩略图，点击放大。

### B3（最后一批）在截图上点选元素
- 对话流里的截图上有「选元素」：点开后服务端对当前标签页截一张新图，放进放大层；用户点一下 → 在页面里执行 `elementFromPoint` 加描述函数（移植 `piweb-inspect.js` 的逻辑，加上 Svelte / React≤18 / Vue 的源码线索）→ 交给 `locateSource` 找源码。
- 结果作为元素芯片进入输入卡：`ChatDraft` 加 `elements`，照 `uploads` 芯片的样式（`ChatInput.tsx:494`），由 `compose()`（:244）拼进正文。当前模型支持图片时附上元素裁剪图，为此 `ModelChoice` 加 `vision` 字段。

## M5：清理与文档
- 移入 backups：`public/piweb-inspect.js`、`src/app/api/dev-inspect/route.ts`、不再使用的 `devPreview*` 文案。
- README 中英文：生长树改为每轮 git commit（附查看命令 `git log refs/piweb/rounds/<key>`，以及旧引用的清理命令）；加上 pi 的眼睛（浏览器要求、`PI_WEB_BROWSER`）。
- 每个里程碑结束都记 progress 并提交（按全局规范）。

## 验证
- 每个里程碑：`npm run typecheck` + 全量 `npx vitest run`（M0 后基线约为 380 通过 + 1 跳过，以实测为准）。
- **A 的测试**：改写以下测试文件——`growth-service`、`growth-tracker`、`growth-tracker-failures`、`growth-rounds`、`use-growth`，以及组件测试 `growth-project-panel`、`growth-tree`。覆盖：
  - 每轮 commit 和 trailers；
  - 空轮提交；
  - 「你的修改」只在有改动时提交；
  - 用户的 HEAD、暂存区、分支零改动；
  - 非 git 目录自动 init，子目录嵌套 init；
  - 一次 `git log` 解析出状态、行数、重命名、二进制；
  - 按会话过滤；
  - 只读路径不创建仓库；
  - 中止的轮记为 `aborted`；
  - 对话标签按 `promptIds` 关联。
- **B 的测试**：
  - 单测：浏览器定位、URL 策略、CDP（用假传输）、工具在有视觉和无视觉模型下的返回、ToolStep 显示截图；
  - 集成测试：找不到浏览器就跳过（`it.skipIf`）。真实无头启动浏览器 → 用 `node:http` 起一个本地页面 → 截图得到 JPEG → 读到 `console.error`。
- **手工走查**：
  1. 起一个 Vite 示例项目；
  2. 让 pi 连续改三轮，确认面板出现 3 根柱，每轮文件和 diff 正确；
  3. 两轮之间自己手改一个文件，确认出现灰柱「你的修改」；
  4. 确认对话里的标签能跳到对应的轮；
  5. 在终端执行 `git log refs/piweb/rounds/<key>`，能看到同样的历史；
  6. 让 pi「打开 localhost:5173 看看有没有问题」，确认对话流里出现截图；
  7. 故意写一个运行时错误，确认 pi 能从控制台发现并修复。
