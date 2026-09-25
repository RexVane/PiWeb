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
