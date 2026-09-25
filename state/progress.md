# 进度

## 2026-09-25 09:40 +08:00 | claude-opus-5-5 | 远端锁定与现状快照（只读审查）
- 远端：只有 `origin=https://github.com/RexVane/PiWeb.git`（自己的仓库，可推），没有 `upstream`，无需设置 no_push。
- 现状：
  - `main` 与 `origin/main` 同步在 `2de2a87 chore(release): v0.3.15`；`.next-releases/active.json` 指向 v0.3.15 的已完成构建。
  - 工作区有未提交改动：38 个文件 +2329/−1174，外加 11 个新文件（`src/lib/workflow.ts`、`src/lib/delegation.ts`、`scripts/verify-release-config.mjs` 与一批组件测试）。内容：Agent/Plan/Goal 工作模式、`piweb_delegate` 只读子代理委派、编辑重发改为原位重生成、新默认主题 `piweb`、pi SDK 0.85.1→0.87.1、release 配置校验拆成独立脚本。
  - `tsc --noEmit` 通过；`vitest run` 79 个文件，570 个通过，1 个跳过。
- 审查发现（均未修改，留给正在做这批改动的会话）：
  - Goal 模式编辑重发第一条消息时目标不会更新：`agent-manager.ts` 的 prompt 分支在 `session.prompt` 之前写 goal 记录，所以该记录是用户消息的祖先；`navigateTree(用户消息)` 把叶节点设到父节点，旧 goal 仍然生效；`editAndResend` 又只在 goal 为空时才写入 → 系统提示仍是旧目标。
  - Plan 执行失败（API 报错/中止）后 `agent_settled` 直接回到 idle，已批准的方案丢失，只能重新出方案。
  - `setWorkflowMode` 在模式没变时也会追加一条自定义记录，会话文件里有噪声。
  - 子代理的 token 用量与工具步骤不进轨迹和上下文计量；每个子任务硬超时 2 分钟。
- 影响文件：只新建本文件，没动代码。
- 下一步：这批未提交改动的负责会话修复 goal 编辑问题并提交。

## 2026-09-25 10:33 +08:00 | claude-opus-5-5 | 接手工作模式改动，修 Goal 编辑、Plan 执行失败、重选模式三处问题
- 背景：上一个会话停在未提交的 Agent/Plan/Goal + 委派改动上；接手前确认它最后改的 `SessionSidebar.tsx` 样式改版是完整的（有测试覆盖，tsc/测试全过），没有半截代码。
- 改了什么：
  - Goal 模式编辑重发「定下目标的那条消息」时，目标跟着换成新文本。新增 `awaitingGoalMessage`：当前分支上最近一条工作流记录之后还没有用户消息，就说明被编辑的正是定目标的那条。编辑后面的消息不影响目标。
  ```ts
  // src/lib/workflow.ts:33
  export function awaitingGoalMessage(sm: SessionManager): boolean {
  	for (const entry of sm.getBranch().slice().reverse()) {
  		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return true;
  		if (entry.type === "message" && entry.message.role === "user") return false;
  	}
  	return true;
  }
  // src/lib/agent-manager.ts:1578（editAndResend）
  else if (m.workflow.mode === "goal" && awaitingGoalMessage(m.sm) && m.workflow.goal !== text.slice(0, 8_000)) {
  	setWorkflow(m, { ...m.workflow, goal: text.slice(0, 8_000) });
  }
  ```
  - Plan 执行回合报错或被中止时，不再丢掉方案：状态回到 `ready`，把当前叶节点当作新的批准锚点（`planId`），「执行方案」可以直接再点。正常完成仍回到 `idle`。
  ```ts
  // src/lib/agent-manager.ts:540（agent_settled）
  const failed = answer?.role === "assistant" && (answer.stopReason === "error" || answer.stopReason === "aborted");
  const anchor = failed ? m.sm.getLeafId() : null;
  setWorkflow(m, anchor ? { ...m.workflow, planStatus: "ready", planId: anchor } : { ...m.workflow, planStatus: "idle", planId: undefined });
  ```
  - `setWorkflowMode` 选的就是当前模式时直接返回成功（`agent-manager.ts:1360`）。之前在菜单里重点当前模式会清空 Goal 目标、丢掉待执行的方案，还会往会话里多写一条记录。
  - `tests/agent-resource-isolation.test.ts` 在真实 SDK 回归里加了 2 个用例：执行报错后再次批准并跑完；Goal 编辑首条消息换目标、编辑后续消息保留目标、重选 Goal 保留目标。临时关掉修复时这 2 个用例都会失败（idle≠ready、Old≠New objective），恢复后通过。
- 验证：`tsc --noEmit` 通过；`vitest run` 79 个文件，576 个通过，1 个跳过；`npm run build` 通过；`next start -p 30146` 冒烟测试：health 200、首页 200、会话列表 200、跨源 POST 403，测完已关掉。
- 影响文件：`src/lib/workflow.ts`, `src/lib/agent-manager.ts`, `tests/agent-resource-isolation.test.ts`
- 没做：子代理用量不进轨迹/上下文计量、2 分钟硬超时，属于设计取舍，没动。整批改动仍未提交。
- 下一步：用户确认后提交整批工作模式/委派/界面改动。

## 2026-09-25 11:35 +08:00 | claude-opus-5-5 | 未提交改动拆成三个提交
- 改了什么：
  - 在新分支 `feat/workflow-modes` 上按用户要求拆成三个提交，顺序是依赖顺序：`8d72a04` pi SDK 升级与发布脚本 → `58bae2f` 界面主题/侧栏 → 工作模式/委派（本条随它提交）。
  - 有 8 个文件两组改动混在同一段代码里（AppShell/ChatInput/ChatWindow/usePiWeb/i18n/globals.css/agent-manager/types），按代码块暂存拆不开：用脚本生成「只含界面改动」的中间版本写进暂存区，工作区没动；最后一个提交就是拆分前的完整工作区。
  - 归属取舍：编辑重发的改版归入工作模式提交（README 同一节）；模型/技能加载状态、上下文计量口径、归档失败不跳走、`/api/config` 缺文件返回 `{}` 这些零散修复归入界面提交；CSS 里工作模式与编辑器的样式块随工作模式提交，主题皮肤里几行覆盖它们的样式留在界面提交（之前是用不到的样式，无害）。
- 验证：两个中间提交各自检出到临时 worktree 跑过：`8d72a04` tsc 通过、70 个文件 531 个用例通过；`58bae2f` tsc 通过、78 个文件 550 个用例通过。最终状态即上一条记录验证过的工作区（tsc、576 个用例、build、冒烟测试）。
- 影响文件：只动 git 历史与本文件。
- 下一步：用户确认后把 `feat/workflow-modes` 合回 main / 推送；没有推送。

## 2026-09-25 13:14 +08:00 | claude-opus-5-5 | 合回 main 并推送，修复 CI 的 lock 文件问题
- 改了什么：
  - 用户确认后把 `feat/workflow-modes` 快进合并到 `main`，推送到 origin（`2de2a87..d424d56`）。发布流程是手动触发（`workflow_dispatch`），推 main 不会发 npm。
  - 推送后 CI 的 check 全部挂在 `npm ci`：`Missing: @emnapi/runtime@1.11.3 / @emnapi/core@1.11.3 from lock file`。原因是 SDK 升级时本机 npm 11.6 重写 lock，丢了 wasm32 可选子树（和 5918f23 修过的是同一个问题）。本机 npm 复现不出来，用 CI 同版本 `npx npm@11.19.0 ci --dry-run` 才复现。
  - 按 5918f23 的写法补回两个条目（lock 只多 21 行），提交 `1a3a481` 并推送。
- 验证：npm 11.19.0（Windows、`--os=linux`）和 npm 10.9.9（`--os=linux`）的 `npm ci --dry-run` 均通过；CI run 36096771136 全部任务成功（Ubuntu/Windows 的 check、x64/arm64 的 niubash 冒烟测试）。
- 影响文件：`package-lock.json`
- 下一步：要发版时手动触发 publish（Actions → publish → Run workflow）。本条记录还没提交，随下次提交带上。本地 `feat/workflow-modes` 分支已完全合并，可以删掉。

## 2026-09-25 18:39 +08:00 | gpt-6-sol | 配置警告处理与前端查看前的现状快照
- 改了什么：
  - 删除用户级 `C:\Users\guica\.codex\config.toml` 中当前 `codex-cli 0.156.1` 不识别的 `windows_wsl_setup_acknowledged = true`；随后运行 Codex 命令，未再出现该警告。项目配置和代码未改。
  - 核对远端：只有 `origin=https://github.com/RexVane/PiWeb.git`（拉取和推送），没有 `upstream`；执行推送锁定命令得到 `No such remote 'upstream'`，因此未创建未知地址的远端，也未推送。
  - 核对现状：`main` 与 `origin/main` 同步于 `1a3a481`；工作区原有 `state/progress.md` 未提交改动和未跟踪的 `images/`，均保留不覆盖。
- 影响文件：`state/progress.md`；用户级 Codex 配置文件（仓库外）。
- 下一步：只读梳理前端入口、组件、样式与验证命令，等待具体前端修改目标。

## 2026-09-25 18:44 +08:00 | gpt-6-sol | 前端结构与基线验证
- 改了什么：
  - 只读梳理前端：`src/app/page.tsx` 挂载 `AppShell` 与国际化；`AppShell` 组织侧栏、Hero、聊天、项目/轨迹/文件面板；`usePiWeb` 处理会话轮询、SSE 与命令；`globals.css` 提供设计令牌、`piweb` 主题及 840px 窄屏规则。
  - 确认本地 Next 16.3.4 文档中的 Client Component 和 CSS 约定；前端代码未修改。
  - 基线验证：`npm run typecheck` 通过；`npm test` 为 79 个文件通过、576 个用例通过、1 个跳过。
- 影响文件：`state/progress.md`。
- 下一步：等待具体前端页面、视觉参考或交互需求，再做定向修改与回归测试。

## 2026-09-25 19:35 +08:00 | gpt-6-sol | 前端交接的远端锁定与现状快照
- 改了什么：
  - 核对远端：仅 `origin=https://github.com/RexVane/PiWeb.git` 可拉取和推送；`upstream` 不存在，锁定推送命令返回 `No such remote 'upstream'`，未添加未知远端，也未推送。
  - 核对基线：`main` 与 `origin/main` 同步在 `1a3a481`；工作区有用户未提交的 `globals.css`、`AppShell.tsx`、`ChatWindow.tsx`、`SessionImportSection.tsx`、`SessionSidebar.tsx`、`SettingsPanel.tsx`、`theme.ts` 和本进度文件，以及新增 `TestInspectorPod.tsx`。这些前端文件保留原样，待核对接线范围。
  - 初查发现新增测试检查器/智能体群视图包含静态模拟数据与动作，而 Git 状态及会话归档已有后端接口；当前 `npm run typecheck` 通过。
- 影响文件：`state/progress.md`。
- 下一步：确认哪些新视图要接成真实功能，梳理接口边界并补齐定向验证。

## 2026-09-25 19:45 +08:00 | gpt-6-sol | 新增隔离智能体群与测试运行后端接口
- 改了什么：
  - 新增 `POST /api/swarm`（1-3 个明确任务）、`GET /api/swarm?cwd=`、`GET /api/swarm/:id`、`POST /api/swarm/:id`（`cancel` / `accept`）。任务在独立 Git 工作树并行执行；子智能体仅有受路径约束的读、列举、字面搜索、精确编辑和写文件工具，没有 shell 或扩展工具。工作树结束后保留报告与补丁，不自动改主工作区；采纳前检查 HEAD 基线并执行 `git apply --check`。任务状态保存到 Pi agent 目录，进程重启后未完成任务标记为中断。
  - 新增 `GET /api/tests?cwd=` 发现 `tests/` 下的本地测试文件、`GET /api/tests?cwd=&file=` 读取文件、`POST /api/tests` 运行指定文件。只允许受信任工作区内、已安装本地 Vitest 的 `*.test/spec.*` 文件；固定执行参数、180 秒超时、单工作区互斥。Vitest 5 的 JSON reporter 实际写文件，因此服务显式使用临时报告文件并清理。
  - 新增后端边界测试，覆盖测试文件发现/路径越界和智能体群任务输入校验。前端视觉文件均未修改；新页面的静态模拟数据仍待前端接线。
  ```ts
  // src/lib/swarm-service.ts:268
  export async function startSwarm(cwdValue: unknown, taskValue: unknown): Promise<SwarmJob> {
    const tasks = checkedInput(taskValue);
    const { cwd, root, base } = await workspace(cwdValue);
    // 每个任务在独立工作树执行，结果仅保存补丁供人工采纳。
  }
  // src/lib/test-run-service.ts:61
  export async function runTestFile(cwdValue: unknown, fileValue: unknown): Promise<TestRunResult> {
    const { cwd, relative } = await testFile(cwdValue, fileValue);
    if (!resolveProjectTrust(cwd).trusted) throw new BoundaryError("trust this project before running tests");
  }
  ```
- 验证：`npm run typecheck` 通过；`npx vitest run tests/backend-bridge.test.ts` 2 个用例通过；手动验证 Vitest JSON reporter 的实际输出位置。尚未验证真实模型任务与页面接线。
- 影响文件：`src/lib/swarm-service.ts`, `src/lib/test-run-service.ts`, `src/app/api/swarm/route.ts`, `src/app/api/swarm/[id]/route.ts`, `src/app/api/tests/route.ts`, `tests/backend-bridge.test.ts`, `state/progress.md`。
- 下一步：验证真实测试执行与任务取消/采纳路径，确认前端由谁补任务输入、状态和补丁审查控件。

## 2026-09-25 20:01 +08:00 | gpt-6-sol | 后端端到端验证与前端接线说明
- 改了什么：
  - 补强隔离任务：非 Git 工作区给出明确边界错误；取消后不再继续初始化子会话；文件编辑/写入工具串行化；采纳状态同步到内存与持久化记录。
  - 新增端到端测试：在临时 Git 仓库里用模拟子会话改独立工作树，验证主工作区在采纳前不变、冲突补丁拒绝、采纳后文件更新及重复采纳拒绝。另验证真实 Vitest JSON 报告解析和文件工具路径边界。
  - 新增 `docs/frontend-backend-bridge.md`，列出智能体群、测试检查器、现有 Git 接口的请求/响应及前端待接线点；用户确认自行补前端，本轮未改其视觉文件。
- 验证：`npm run typecheck` 通过；`npm test` 81 个文件、581 个通过、1 个跳过；`npm run build` 通过，新 API 路由均生成；生产服务 HTTP 冒烟：测试文件列表返回 80 个文件，智能体群列表返回空数组，非法启动返回 400。`git diff --check` 仅报告用户原有 `src/app/globals.css` 末尾空行，本轮未触碰该文件。
- 影响文件：`src/lib/swarm-service.ts`, `src/lib/test-run-service.ts`, `src/app/api/swarm/route.ts`, `src/app/api/swarm/[id]/route.ts`, `src/app/api/tests/route.ts`, `tests/backend-bridge.test.ts`, `tests/swarm-service.test.ts`, `docs/frontend-backend-bridge.md`, `state/progress.md`。
- 下一步：前端按契约接入任务输入、轮询、报告/补丁审查、取消/采纳与真实测试结果；移除未实现的固定 Git 状态、模型 failover、缓存率和演示测试指标。真实模型调用需在已配置 Pi 模型的干净 Git 工作区由用户主动触发，不能用本轮未提交的工作区做无损探针。

## 2026-09-25 20:25 +08:00 | gpt-6-sol | 前端接线前的远端锁定与现状快照
- 改了什么：
  - 核对远端：仅有 `origin=https://github.com/RexVane/PiWeb.git`，不存在 `upstream`；执行上游推送锁定命令得到 `No such remote 'upstream'`，没有新增或推送远端。
  - 核对工作区：用户新增 `SwarmCoordinatorPod.tsx` 及其组件测试，并修改 AppShell 等界面文件；后端 API、契约文档和测试仍未提交。本轮保留这些现有改动，不清理、不重置。
  - 基线检查：`npm run typecheck` 通过，智能体群组件测试 6 项通过；发现差异视图仍渲染静态 `TestInspectorPod`，且没有独立测试入口。用户确认由本轮补齐这两处前端。
- 影响文件：`state/progress.md`。
- 下一步：复用真实 GitPanel 完成差异视图；新增独立测试入口并接入 `/api/tests`，补齐组件验证。

## 2026-09-25 20:34 +08:00 | gpt-6-sol | Git 差异页与真实测试检查器接线
- 改了什么：
  - `AppShell` 的“差异对比”改为复用 `GitPanel`，新增独立“测试检查器”入口；顶部 Git 分支和改动数从 `/api/git` 读取，不再使用固定 `main`、`2` 或工具完成次数冒充 Git 状态。页面动作只使用当前明确选中的会话/草稿工作区，不回落到历史工作区。
  - 重写 `TestInspectorPod`：列出当前工作区测试文件、读取所选源码、按文件触发真实 Vitest、显示通过/失败/跳过、逐项结果与输出。移除模拟耗时、内存、覆盖率和固定 PASS；工作区或文件切换时丢弃旧读取响应。
  - `GET /api/security?cwd=` 新增按工作区读取信任状态，智能体群可在无会话草稿工作区正确显示并设置信任。智能体群的 Git/历史/详情响应按工作区防串页，空白任务替代会误触发模型的虚构默认任务，修正采纳条件、取消等待和误导性安全文案。
  - Vitest JSON 解析现在把断言失败信息写入 `output`，测试页可展示失败原因。
  ```ts
  // src/app/api/security/route.ts:10
  export async function GET(req: Request) {
    const params = new URL(req.url).searchParams;
    if (params.has("cwd")) {
      const cwd = await resolveWorkspacePath(params.get("cwd"));
      return NextResponse.json({ success: true, data: resolveProjectTrust(cwd) });
    }
  }
  ```
- 影响文件：`src/components/AppShell.tsx`, `src/components/GitPanel.tsx`, `src/components/TestInspectorPod.tsx`, `src/components/SwarmCoordinatorPod.tsx`, `src/app/api/security/route.ts`, `src/lib/test-run-service.ts`, `state/progress.md`。
- 下一步：更新并扩充组件测试，验证切换工作区、真实运行结果和 Git 差异交互，再跑全量测试与构建。

## 2026-09-25 20:52 +08:00 | gpt-6-sol | 移除剩余演示状态并闭合 Git 提交入口
- 改了什么：
  - 侧栏 Git 卡片接收 AppShell 从 `/api/git` 读取的真实分支与状态；没有改动或状态未知时禁用“让 pi 提交”，有改动时由 AppShell 正常写入受控会话草稿，不再直接改 DOM textarea 值。
  - 设置页删除未实现的 3000ms 自动 failover、固定 72% 缓存率、固定工具总数等演示指标，只显示当前会话可验证的工具数；顶栏删除虚构 engine 版本并以实际连接状态着色。
  - 补充 `docs/frontend-backend-bridge.md` 的项目信任读取接口与已接线页面现状；补充侧栏委托提交回归测试。采纳智能体补丁会触发顶栏 Git 状态刷新，打开差异页或 Git 状态卡片时也重新读取。
  ```tsx
  // src/components/AppShell.tsx:565
  const gitBranchLabel = gitSummary?.isRepo ? (gitSummary.detached ? "HEAD" : gitSummary.branch || "—") : "—";
  const gitStatusLabel = !activeWorkspaceCwd ? "未选择"
    : gitSummaryError || gitSummary?.statusError ? "状态未知"
    : !gitSummary ? "读取中"
    : !gitSummary.available ? "Git 不可用"
    : !gitSummary.isRepo ? "非仓库"
    : gitSummary.files.length ? `${gitSummary.files.length} 改动` : "干净";
  ```
- 影响文件：`src/components/AppShell.tsx`, `src/components/SessionSidebar.tsx`, `src/components/SettingsPanel.tsx`, `src/components/SwarmCoordinatorPod.tsx`, `docs/frontend-backend-bridge.md`, `tests/components/session-sidebar-actions.test.tsx`, `state/progress.md`。
- 下一步：完成最终全量回归、生产构建和接口冒烟；真实模型协同任务仅在用户选择干净 Git 工作区后主动启动。

## 2026-09-25 20:57 +08:00 | gpt-6-sol | 前后端接线最终验证
- 改了什么：
  - 为测试检查器新增真实文件列表、源码读取、单文件运行和工作区切换防旧响应用例；为智能体群补空任务启动约束和跨工作区异步响应回归；为侧栏补真实 Git 状态与提交草稿委托用例。
  - 最终 `npm run typecheck` 通过；`npx vitest run --maxWorkers=4` 83 个文件通过，593 项通过、1 项跳过；`npm run build` 通过，`/api/security`、`/api/swarm`、`/api/tests` 均进入生产路由。
  - 生产服务 HTTP 冒烟：`GET /api/security?cwd=` 返回当前工作区 `trusted=true`，`GET /api/tests?cwd=` 返回 83 个真实测试文件，`GET /api/git?cwd=` 返回 `main` 与 21 项真实改动，`GET /api/swarm?cwd=` 返回空历史。冒烟服务已关闭。
  - 首次默认并发全量测试曾有一个未改动的 launcher 1.5 秒健康探针用例超时；单独重跑 17 项通过，降低并发后的两次全量回归均通过。`git diff --check` 仅提示用户原有 `src/app/globals.css` 末尾空行，未触碰该样式文件。
- 影响文件：`tests/components/test-inspector.test.tsx`, `tests/components/swarm-coordinator.test.tsx`, `tests/components/session-sidebar-actions.test.tsx`, `state/progress.md`；其余改动见前两条记录。
- 下一步：用户在干净 Git 工作区配置可用模型后主动运行智能体群，人工核对补丁再采纳；本轮未在带未提交改动的当前仓库启动收费模型任务，也未推送远端。

## 2026-09-26 03:10 +08:00 | gpt-6-sol | 修复智能体群与测试检查器静态审查问题
- 改了什么：
  - 复核远端仍只有 `origin`，不存在 `upstream`；执行上游推送锁定命令得到 `No such remote 'upstream'`，未创建未知远端，也未推送。
  - 智能体群改在 Git 根目录校验项目信任，模型最终响应不是正常停止时将子任务判为失败；只有全部子任务成功才把群组标为完成。初始持久化失败会撤销内存中的运行占位。
  - 整组任务结束前禁止补丁采纳，采纳时使用当前内存中的权威任务对象，避免运行中的子任务继续写旧对象；前端同步禁用采纳按钮并说明等待原因。
  - 测试运行互斥登记移到首个异步等待之前，Vitest 输出加入套件级加载错误；Ocean Ink 补齐亮暗两套配色变量，移除主会话沙盒与不存在目录的误导文案。
  - 补充并发采纳、模型错误、根目录信任、部分失败、测试互斥、套件错误和前端按钮回归；`npm run typecheck` 与受影响的 3 个测试文件、18 项用例通过。未启动应用服务或真实模型。
  ```ts
  // src/lib/swarm-service.ts:213
  if (!answer || answer.role !== "assistant") throw new Error("agent returned no assistant response");
  if (answer.stopReason !== "stop") throw new Error(answer.errorMessage || `agent stopped: ${answer.stopReason}`);
  // src/lib/swarm-service.ts:292
  job.status = controller.signal.aborted ? "cancelled" : job.tasks.every((task) => task.status === "completed") ? "completed" : "failed";
  // src/lib/swarm-service.ts:331
  if (job.status === "running") throw new BoundaryError("wait for all swarm tasks to finish before accepting changes");
  // src/lib/test-run-service.ts:82
  running.add(cwd);
  ```
- 影响文件：`src/lib/swarm-service.ts`, `src/lib/test-run-service.ts`, `src/components/SwarmCoordinatorPod.tsx`, `src/components/AppShell.tsx`, `src/components/SettingsPanel.tsx`, `src/app/globals.css`, `tests/swarm-service.test.ts`, `tests/backend-bridge.test.ts`, `tests/components/swarm-coordinator.test.tsx`, `state/progress.md`。
- 下一步：运行全量离线测试和生产构建；不启动应用服务或收费模型任务。

## 2026-09-26 03:24 +08:00 | gpt-6-sol | 根目录信任联动与最终离线验证
- 改了什么：
  - 智能体群从仓库子目录打开时，前端改为读取 Git 根目录的信任状态；用户点击“信任项目”也对根目录发出决策，不再沿用子目录的父组件状态。补充该情形的组件回归测试。
  - 更新 `docs/frontend-backend-bridge.md`：明确整组任务结束后才能采纳、部分失败仍可审查成功补丁，以及从子目录启动时校验 Git 根目录信任。
  - 全量离线回归通过：83 个测试文件，600 项通过、1 项跳过；最终前端改动后的定向回归 2 个文件、14 项通过。最终 `npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。
  - 未启动 PiWeb 服务、未调用真实模型、未推送远端；因此运行时交互与真实智能体调用仍待用户允许启动后验证。
- 影响文件：`src/components/SwarmCoordinatorPod.tsx`, `tests/components/swarm-coordinator.test.tsx`, `docs/frontend-backend-bridge.md`, `state/progress.md`。
- 下一步：在用户允许启动后，用干净且已信任的 Git 仓库手动验证真实智能体运行、补丁审查与采纳链路。
