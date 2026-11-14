# 自动化任务 审计报告

## 0. 覆盖范围

**读了（全部读完）**：

| 文件 | 行数 |
|---|---|
| `src/lib/automations/store.ts` | 480 |
| `src/lib/automations/runner.ts` | 490 |
| `src/lib/automations/schedule.ts` | 273 |
| `src/lib/automations/agent-tool.ts` | 189 |
| `src/lib/automations/types.ts` | 70 |
| `src/app/api/automations/route.ts` | 111 |
| `src/app/api/automations/preview/route.ts` | 24 |
| `src/components/workspace/AutomationsWorkspaceView.tsx` | 770 |
| `src/components/workspace/AutomationModal.tsx` | 557 |
| `tests/automations-store.test.ts` / `-runner` / `-concurrency` / `-schedule` / `-input` / `-preview` | 190 / 288 / 102 / 75 / 42 / 21 |
| `tests/automation-agent-tool.test.ts` | 81 |
| `tests/components/automation-model-scope.test.tsx` / `automation-preview` / `workspace-nav-automations` | 40 / 22 / 228 |

**为跟到最后一层而读的支撑文件**：`src/lib/tool-preset.ts`(39)、`src/lib/pi.ts`(480–518，TOOL_PRESETS)、`src/lib/permission-gate.ts`(215)、`src/lib/path-security.ts`(93)、`src/lib/settings-write-lock.ts`(45)、`src/lib/atomic-file.ts`(17)、`src/lib/tool-preferences.ts`(109)、`src/lib/extension-ui.ts`(216–412)、`src/lib/ask-user.ts`(grep ASK_USER_TIMEOUT_MS)、`src/lib/agent-manager.ts`(505–560 / 950–1020 / 1104–1118 / 1230–1300 / 1410–1470 / 1650–1810 / 1855–1865 / 2120–2210 / 2770–2960 / 3037–3100)、`src/instrumentation.ts`(18)、`src/instrumentation-node.ts`(46)、`src/proxy.ts`(87)、`scripts/launcher.mjs`(spawn)、`scripts/dev.mjs`、`bin/piweb.js`、`next.config.ts`、`node_modules/next/dist/docs/.../instrumentation.md`、仓库根 `PiWeb_Permissions_Review_2026-11-13.md`。

**跳过了**：`src/lib/pi.ts` 的模型/资源加载主体（bridge 区域）、`sandbox/*` 与 `permission-*.ts` 的实现细节（sandbox 区域，只核对了与本区域相关的入口）、公共组件 `SelectOption`/`ConfirmDialog`/`useDialog`（crosscut 区域，只按调用点核对 props）。未运行任何会改状态的命令；未运行测试（本区域测试已在 lead 的 204 文件全绿基线内，且本报告结论不依赖"跑一下才知道"的行为）。

**结论一览（按子功能）**

| 功能 | 结论 | 依据文件 |
|---|---|---|
| cron/interval/daily/weekly 解析与归一 | **OK** | `schedule.ts:38-180`；`tests/automations-schedule.test.ts` 全绿且断言具体取值 |
| 时区 / DST | **OK-但脆弱**：时间按**服务端本地时区**解释，DST 回拨重复时刻按时间戳排序、spring-forward 不存在的时刻跳过；但任务没有自己的时区字段，跨时区设备只看到"服务端执行时区"提示 | `schedule.ts:197-249`；`preview/route.ts:17`；`tests/automations-preview.test.ts:8-16` |
| 漏跑 / 丢失的运行 | **有问题** P2-4、P2-7：超过 2 分钟宽限即静默跳过，不落记录；claim 已推进 `nextRunAt` 后启动失败只 `console.error` | `runner.ts:20,412-420`；`store.ts:353-359` |
| 重叠运行互斥（同一任务） | **OK**：内存 `activeTaskIds` + 存储层 `ownerPid` 双重互斥，跨进程也成立 | `runner.ts:291-296`；`store.ts:350,386`；`tests/automations-concurrency.test.ts:88-101` |
| 运行：并发上限 / 超时 / 取消 | **有问题** P2-2（无全局上限）、P1-1（无人值守提问挂 30 分钟）、P2-5（无停止入口） | `runner.ts:309-313,408-421`；`extension-ui.ts:231,378-392`；`ask-user.ts:10` |
| 进程重启后恢复 | **OK-但脆弱** P2-1：启动时把无主 `running` 记录改判 error（实现正确），但"有主"判据只有 `process.kill(pid,0)`，pid 复用会让记录永久卡在 running | `runner.ts:441-449`；`store.ts:45-53,452-479` |
| 持久化位置 / 原子写 / 多进程写 | **OK**：`<agentDir>/web-automations.json`，tmp+rename 原子替换（Windows 共享冲突重试），进程内串行 + `proper-lockfile` 跨进程锁 | `store.ts:66-68,181-203`；`atomic-file.ts`；`settings-write-lock.ts`；`tests/automations-concurrency.test.ts:75-86` |
| 崩溃 / 半写 / 坏记录恢复 | **OK-但脆弱** P2-3：半写由 rename 保证不会出现；但**任何一条记录不可解析即整体拒绝加载**，无备份、无修复入口 | `store.ts:160-179,105-137`；`tests/automations-store.test.ts:183-189` |
| 输出日志 / 失败重试 | **OK-但脆弱**：只落运行会话 JSONL + 400 字摘要，`error` 不截断；运行本身有意不重试，完成写盘有重试（`pendingFinishes`） | `runner.ts:98-119,356-368`；`store.ts:421-425,440-441` |
| 权限档位（是否 readonly） | **OK，外部反馈不成立**：默认 `workspace` 而非 readonly；运行前 `setToolPreset` 显式下发且失败即中止 | `tool-preset.ts:29`；`store.ts:114,230`；`runner.ts:329-332`；`agent-manager.ts:2929-2955` |
| `manage_automation` 作用域 / 误删 | **有问题** P2-6：readonly/workspace 双闸门都拦得住（模型不能提权），但 full 档（含 full 档自动化自己）可无限自建 full 档任务、可无确认删除；UI 删除有确认但物理移除、无回收站 | `permission-gate.ts:191-198`；`pi.ts:495-501`；`agent-tool.ts:49-53,120-184`；`store.ts:324-335` |
| 预览接口 / UI 表单校验 / 模型作用域 | **OK-但脆弱** P3-3：预览用服务端时钟与时区且丢弃过期响应，模型按任务工作区拉取并校验；但模型目录请求失败时已选具体模型的任务无法保存 | `preview/route.ts:9-23`；`AutomationModal.tsx:114-200,217-218,548`；`tests/components/automation-model-scope.test.tsx` |

**关于"Next 多 bundle 各起一份 `started` 标记"的核实（lead 点名）**：本区域**不会**因此重复执行任务，理由三条：
1. 启动器只起一个 Next 进程：`scripts/launcher.mjs:480-502` 用 `spawn(process.execPath, [next, command, ...])` 起唯一子进程；`next` 文档写明 `register()` 每个 server 实例只调用一次（`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18`）。
2. 运行期状态挂在 `globalThis[Symbol.for("piweb.automations.runtime")]` 且按 store 路径分键（`runner.ts:67-96`），同一进程内即使出现第二份模块实例也复用同一份 runtime；`ensureAutomationSchedulerStarted` 见到 `started && timer` 就不再起（`runner.ts:473-479`）。
3. 即使真的起了两份（或两个 PiWeb 进程），也不会跑两遍：`claimDueTasks` 在**一次** `mutateStore` 里"判定到期 + 推进 `nextRunAt`"（`store.ts:351-360`），另一个 ticker 再进来时 `nextRunAt > now`；且 `recordRunStarted` 用 `ownerPid` 拦第二份（`store.ts:386`），有专门的多进程用例（`tests/automations-concurrency.test.ts:75-86`）。
   **但**它带出一个真实的脆弱点，见 P2-1（pid 复用会让"有主"判断失效）；另外真出现两份 ticker 时，两份会各自跑一遍启动 `reconcileInterruptedRuns` 与各自的 `pendingFinishes` 重试（不致命，只是重复扫描 store）。

**关于"自动化会话默认落在 readonly 档"的核实（lead 点名）**：**不成立**，默认是 `workspace`。
- `DEFAULT_TOOL_PRESET` 是 `workspace`（`tool-preset.ts:29`），创建/读盘兜底都用它（`store.ts:230,114`）；`manage_automation` 的 schema 与描述也写"default 'workspace'"（`agent-tool.ts:53`）。
- `registerManaged` 里新建 `Managed` 的 `toolPreset` 确实是 `"readonly"`（`agent-manager.ts:1256`），但这是"还没下发档位"的初值；运行器在提交 prompt **之前**显式下发任务档位并检查结果：
  ```ts
  const presetRes = await runStep(controller.signal, () => deps.execute(target, { cmd: "setToolPreset", preset: task.toolPreset }));
  if (!presetRes.ok) throw new Error(presetRes.error || `Failed to apply permission preset "${task.toolPreset}"`);
  ```
  （`runner.ts:329-332`）冷会话分支只记下档位、到 `ensureSession`/`applyToolPolicy` 再生效（`agent-manager.ts:2935-2955`），而 `prompt` 才第一次 `ensureSession`（`agent-manager.ts:2798`）；`rename` 不建会话（`agent-manager.ts:3037-3043`），所以首个回合就是以任务档位创建的。用例也断言了 `["rename","setToolPreset","setModel","prompt"]` 的顺序，以及任务档位被原样透传（那个用例里任务显式设成 `readonly` 以验证透传，不是默认值；`tests/automations-runner.test.ts:170-172`）。
- 唯一能观察到"像 readonly"的场景是 P1-1：unattended 会话没有 viewer，`request_permission` 升权永远拿不到答复，模型会自述"我没有权限"。

## 1. 发现（按严重度降序，同级按影响降序）

### P1-1 无人值守运行里模型一问问题，整轮空转到 30 分钟超时
- **位置**：`src/lib/automations/runner.ts:21`、`:309-313`；`src/lib/extension-ui.ts:231`、`:378-392`；`src/lib/ask-user.ts:10`
- **证据**：
  ```ts
  // runner.ts:21
  const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
  // ask-user.ts:10
  export const ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;
  // extension-ui.ts:378-383
  askQuestions: async (questions, signal) => {
      if (disposed) return { status: "unavailable" };
      const outcome = await ask<AskOutcome>(
          { method: "questions", title: "", questions },
          { signal, timeout: ASK_USER_TIMEOUT_MS, waitForViewer: true },
  // extension-ui.ts:230-231 —— 注意条件：只有 waitForViewer 为假时才看 hasViewers
  // 没有浏览器在看：不能永远挂着扩展，按 pi 的 noOp 语义立即返回默认值（选择窗口例外，见 askQuestions）
  if (disposed || (!dialogOpts?.waitForViewer && !opts.hasViewers()) || dialogOpts?.signal?.aborted) return Promise.resolve(fallback);
  ```
  而桥层对"后台自动化"的意图写得很明确：
  ```ts
  // agent-manager.ts:508-511
  /**
   * Subscribe to translated WebEvents without counting as a UI viewer (`hasViewers`).
   * Used by background automation runs so headless extension UI prompts keep using defaults.
   */
  ```
- **触发路径**：任务 prompt 让模型先看情况再决定（"如果发现异常，问我怎么处理"）→ 运行器 `deps.execute(target, {cmd:"prompt"})` 之后等 settlement → 模型调用 `ask_user_question`（`readonly`/`workspace` 档都在白名单里，`pi.ts:498-499`）→ `sessionCustomTools` 把 `ask` 指到 `m.ui.askQuestions`（`agent-manager.ts:1351`）→ `waitForViewer: true` 使"没有 viewer 立刻返回默认值"这条短路失效 → 挂起；`request_permission` 走同一个 `ask`（`agent-manager.ts:1352-1360`），同理。
- **后果**：该次运行在剩余时间里什么都不做，直到 `runner.ts:311-313` 的 30 分钟总超时 abort → `disposeSession` → 运行记录 `status:"error", error:"Automation run timed out after 30m"`。用户看到"跑了 30 分钟然后超时"，真正原因（模型在等人回答）在记录里完全没有体现；期间该任务的后续调度全部被互斥挡住（`store.ts:386`）。如果 prompt 写得不自包含，这是**常规路径**，不是极端边界。
- **置信度**：已确认（读了 `ask` 的完整实现与 `askQuestions` 的选项；未实跑真模型确认它会提问）。
- **建议修法**：给后台运行一个显式的 headless 标记（例如 `launchAutomationTask` 里 `deps.execute(target, {cmd:"setHeadless"})`，或给 `observeManagedEvents` 一套专用 opts），让 `askQuestions` 在 headless 下走 `waitForViewer: false`（没有 viewer 立即返回 `unavailable`/`skipped`）；退一步也可以把 `ask_user_question`、`request_permission` 从自动化会话的活动工具里去掉，并在运行记录里写一句"headless：问题被自动跳过"。

### P2-1 运行记录会被"pid 复用"永久锁死，任务从此不能跑也不能删
- **位置**：`src/lib/automations/store.ts:45-53`（判活）、`:350`、`:386`（互斥）、`:326`（禁止删除）；`src/lib/automations/runner.ts:443-449`（启动 reconcile）
- **证据**：
  ```ts
  export function hasLiveRunOwner(run: AutomationRun): boolean {
      if (!Number.isSafeInteger(run.ownerPid) || !run.ownerPid || run.ownerPid < 1) return false;
      try {
          process.kill(run.ownerPid, 0);
          return true;
      } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
      }
  }
  ```
  ```ts
  // store.ts:326（删除）
  if (data.runs.some((run) => run.taskId === id && run.status === "running" && hasLiveRunOwner(run))) {
      throw new AutomationConflictError("Task is running; wait for completion before deleting it");
  }
  ```
- **触发路径**：运行中把 PiWeb 进程杀掉（任务管理器 / `kill -9` / 断电重启，记录留在 `running` + `ownerPid`）→ 新进程拿到**同一个 pid**（Windows 的 pid 复用很快；重启后 pid 空间从头分配，撞上一个正在运行的进程并不罕见）→ 启动 reconcile 时 `hasLiveRunOwner` 返回 true（`runner.ts:444` → `store.ts:462`）→ 记录保持 `running`。
- **后果**：该任务此后（a）`claimDueTasks` 因 `running.has(task.id)` 永不认领（`store.ts:353`）；（b）手动 `runNow` 报 409 "Task is already running"（`store.ts:386`）；（c）删除报 409（`store.ts:326`）；（d）UI 上 `isRunning` 为真，删除按钮被禁用（`AutomationsWorkspaceView.tsx:551,685`），并因为 `activeTaskIds` 非空而每 2.5 秒轮询一次（`:171`）。只能手改 `web-automations.json` 才能恢复。同一机制下 `EPERM` 分支在 Windows 上还会把"另一个用户/受保护进程"当成活主，放大误判。
- **置信度**：已确认（代码路径与 UI 后果）；触发概率取决于 pid 复用，未实机复现。
- **建议修法**：`ownerPid` 之外再记一个进程内随机 `ownerToken` + `startedAt`，判活时要求 `startedAt > 进程启动时间`（`process.uptime()` 换算）或干脆加"超过 `2 × 运行超时`（60 分钟）的 running 记录视为无主"的 TTL；`reconcileInterruptedRuns` 用同一判据。

### P2-2 没有任何全局并发上限：N 个任务同时到期就同时拉起 N 个 agent 会话
- **位置**：`src/lib/automations/runner.ts:408-421`
- **证据**：
  ```ts
  const due = await claimDueTasks(now, runtime.activeTaskIds, storePath, {
      maxLatenessMs: opts?.maxLatenessMs ?? SCHEDULE_MISSED_GRACE_MS,
  });
  const startedRuns: AutomationRun[] = [];
  for (const task of due) {
      if (opts?.isCurrent && !opts.isCurrent()) break;
      try {
          const { run } = await launchAutomationTask(task, "schedule", { storePath, deps: opts?.deps });
          startedRuns.push(run);
      } catch (err) {
          console.error(`[automations] Failed to start task "${task.name}":`, err);
      }
  }
  ```
  `launchAutomationTask` 只等 `recordRunStarted` 落盘就返回（`runner.ts:302-307`），真正的执行在后台 `executeInBackground()`（`runner.ts:371`），所以循环里没有"等前一个跑完"的语义；也没有任何信号量/队列。互斥只按 taskId（`runner.ts:291`），跨任务不限。
- **触发路径**：用户建 6 个 09:00 的任务（或 `every 1 hours` 的多个任务撞在同一分钟到期）→ 一次 tick 里 6 个 `createNewSession` + 6 个 agent 冷启动。
- **后果**：每个会话都要加载扩展/MCP/模型目录（`ensureSession` 里的完整初始化，`agent-manager.ts:1665-1710`），并发冷启动会同时打满 CPU 与内存，并同时向模型供应商发请求（容易触 429/余额告警）。`agent-manager` 的 `MAX_ACTIVE = 6` 只回收**空闲**会话（`reap()` 明确跳过 busy 的，`agent-manager.ts:2184-2197`），管不住正在跑的。
- **置信度**：已确认（读了整条链；未实跑压测）。
- **建议修法**：在 `runDueAutomations` 的循环前加一个 `MAX_CONCURRENT_RUNS`（例如 2–3）令牌桶，取不到令牌的任务保持 `nextRunAt` 不变（或标记 `pending`），下个 tick 再试；同时提供一个设置项。

### P2-3 一条记录读不出来，整个自动化功能整体不可用，且没有修复入口
- **位置**：`src/lib/automations/store.ts:160-179`（`readStore`）、`:105-137`（`sanitizeTaskRecord`）、`:181-194`（`writeStore`）
- **证据**：
  ```ts
  const tasks = parsed.tasks.map(sanitizeTaskRecord);
  const runs = parsed.runs.map(sanitizeRunRecord);
  if (tasks.some((task) => task === null) || runs.some((run) => run === null)) {
      throw new Error("Invalid automation record; existing data was not modified");
  }
  ```
  `sanitizeTaskRecord` 对任何 `validateSchedule` 失败都返回 `null`（`:111-136`），而 `validateSchedule` 会拒绝未知 `kind`、超出范围的 interval、坏的 cron 等。
- **触发路径**：升级/降级版本后任务表里出现旧 schema（例如旧版本的 `kind`、旧字段拼写、手改过的 cron）；或文件被外部工具/编辑器写坏（原子写只防"半写"，不防"内容错"）。
- **后果**：`GET /api/automations` 500（`route.ts:30-38`），`AutomationsWorkspaceView` 只显示一句原始英文错误 + 空列表（`:141-157`）；所有写操作同样失败；调度器每 15 秒 `console.error("[automations] Scheduler tick failed")` 刷日志（`runner.ts:453-458`）并且永远 reconcile 不完（`reconcileInterruptedRuns` 也走 `mutateStore`）。用户界面上**没有任何"导出/重置/丢弃坏记录"的出口**，只能手改 `~/.pi/agent/web-automations.json`。用例把这个行为固化成了预期（`tests/automations-store.test.ts:183-189`），所以它不是 bug 而是设计取舍——但取舍的代价没有兜底。
- **置信度**：已确认（代码 + 用例）。
- **建议修法**：保留"不覆盖原文件"的前提，但把不可解析的记录改成"跳过并计数"，同时(a)把原文件复制成 `web-automations.json.corrupt-<ts>`，(b)在 GET 里返回 `warnings` 让 UI 展示可读提示，(c)提供 `?repair=1` 的显式清理入口（只删坏记录，先备份）。

### P2-4 漏跑一律静默跳过：没有补跑、没有记录、没有提醒
- **位置**：`src/lib/automations/runner.ts:20`；`src/lib/automations/store.ts:353-359`
- **证据**：
  ```ts
  const missed = maxLatenessMs !== undefined && now - task.nextRunAt > maxLatenessMs;
  const nextRunAt = computeNextRunAt(task.schedule, now);
  const updated = { ...task, nextRunAt };
  data.tasks[i] = updated;
  if (!missed) claimed.push(updated);
  ```
  `maxLatenessMs` 默认 `SCHEDULE_MISSED_GRACE_MS = 2 * 60_000`（`runner.ts:20`）。
- **触发路径**：笔记本合盖/关机跨过 09:00；或 dev server 停着；客户端在睡眠恢复后第一次 tick 已过去几小时。到期时间与 now 相差 > 2 分钟 → 直接推进到下一次，不产生任何 `AutomationRun`。
- **后果**：用户看到的运行记录里"今天根本没跑过"，`lastRunAt` 停在昨天，没有任何"跳过了一次"的痕迹；对"每天 09:00 发日报"这类任务而言等于静默失效，且**宽限期短到几乎不可依赖**（tick 间隔 15s + 机器从睡眠唤醒的抖动就可能吃掉 2 分钟）。另外 2 分钟这个值是写死的常量，设置页里没有对应开关。
- **置信度**：已确认（代码）；"该不该补跑"是产品取舍，但"静默"不是。
- **建议修法**：跳过的任务也写一条 `trigger:"schedule", status:"skipped"`（新增状态）或至少给任务打 `lastSkippedAt/lastSkipReason`，让"执行记录"里能看见；同时把宽限期做成设置项，并允许"启动后补跑一次"的开关。

### P2-5 没有一等公民的"停止运行"：只能靠用户自己找到那个会话去按停止
- **位置**：`src/app/api/automations/route.ts:58-106`（action 只有 `create/update/toggle/delete/runNow`）；`src/components/workspace/AutomationsWorkspaceView.tsx:648-690`（运行中只把按钮禁用，没有停止）
- **证据**：
  ```tsx
  // AutomationsWorkspaceView.tsx:649-657
  <button
      type="button"
      className="btn-outline"
      style={{ height: 28, fontSize: 12, padding: "0 10px" }}
      disabled={busy || isRunning}
      onClick={() => void performTaskAction(task, "runNow")}
  >
      {isRunning ? t.autoStatusRunning : t.autoRunNow}
  </button>
  ```
  ```tsx
  // AutomationsWorkspaceView.tsx:681-689（删除同理）
  <button
      type="button"
      className="rounded-lg transition-colors hover:opacity-80"
      style={{ fontSize: 12, padding: "4px 10px", color: "var(--dsw-danger)" }}
      disabled={busy || isRunning}
      onClick={() => void performTaskAction(task, "delete")}
  >
      {t.delete}
  </button>
  ```
  运行中的任务只有"查看会话"可点（`:658-667`，`task.lastSessionPath` 在 `attachRunSession` 时已写入，`store.ts:412-415`）。
- **触发路径**：用户发现某个自动化在跑一个不想要的动作（例如 full 档任务在改文件），想立刻停。
- **后果**：界面没有任何停止入口；必须点"查看会话"进入那个会话再按停止（也就是"取消"存在，但完全靠用户猜到；且 `runPromptAndAwaitSettlement` 会把用户 abort 记成 `status:"error"`，文案是 `"Run aborted"`，与失败混在一起，`runner.ts:257-263`）。如果用户不这么做，该任务最长占用 30 分钟，期间不能再跑（互斥）。
- **置信度**：已确认（读了路由 switch 与按钮 props）。
- **建议修法**：加 `action:"cancel"` + store/runner 侧按 taskId 找到 `activeRunIds` 对应会话 `disposeSession`，运行记录加一个 `status:"cancelled"`（或在 error 上加 `cancelled:true`），UI 在运行中把"立即运行"换成"停止"。

### P2-6 `manage_automation` 的滥用面：full 档可无上限自建 full 档任务、可无确认删除
- **位置**：`src/lib/automations/agent-tool.ts:49-53`（参数允许 `full`）、`:120-147`（create）、`:173-185`（delete）；`src/lib/automations/store.ts:105-137`（无数量上限）
- **证据**：
  ```ts
  toolPreset: Type.Optional(Type.Union([
      Type.Literal("readonly"),
      Type.Literal("workspace"),
      Type.Literal("full"),
  ], { description: "Permission preset when the task runs automatically (default 'workspace'): readonly has no file or command tools, workspace edits only inside the task workspace, full is unrestricted." })),
  ```
  ```ts
  const task = await createAutomationTask({ name, prompt, cwd, schedule, enabled: params.enabled, toolPreset: params.toolPreset }, storePath);
  ```
  创建路径不做"档位不得高于当前会话"的钳制，`data.tasks.unshift(task)` 也没有数量上限（`store.ts:249`）；`delete` 同样没有二次确认（与 UI 的 `confirm()` 不同，`AutomationsWorkspaceView.tsx:291-294`）。
- **触发路径 / 边界核实**：`manage_automation` 在 `readonly`/`workspace` 两处都被挡住，**模型不能借它提权**——白名单里没有它（`pi.ts:495-501`），执行期闸门也显式拒绝（`permission-gate.ts:191-198`，注释写明"能建出一个 full 档的任务再从那里跑 shell —— 等于开后门"），且 `toolPolicyDenial` 的 `customActiveTools` 绕过路径仍会过 `permissionDenial`（`agent-manager.ts:1746-1761`）。所以只有 `full` 档会话（用户自己选的完全权限，或一个 full 档自动化会话）能调用它。
- **后果**：在那个前提下，模型可以自我繁殖：一个 full 档自动化单次运行里连建多个 `every 1 minutes` 的 full 档任务，每个任务又建新任务；任务数无上限（顺带每次写入都是全量 JSON 重写，任务表线性增长时写放大是 O(n)），用户只能逐个在 UI 里关掉/删掉，而运行中的任务连删除都会被 409 挡住（P2-1/P2-5 叠加）。
- **置信度**：已确认（读了工具 schema、两条闸门与 store 的写入路径）；"模型真会这么干"未实跑。
- **建议修法**：`createAutomationTask` 接受一个 `maxPreset` 参数，由 `sessionCustomTools` 传当前会话档位，禁止提档；给任务总数设上限（如 200）并在超限时返回结构化错误；`delete` 动作要求调用方显式带 `confirmId`（或只允许把任务改成 paused）。

### P2-7 claim 与 recordRunStarted 之间失败会静默吞掉一次运行
- **位置**：`src/lib/automations/store.ts:351-360`（先推进 `nextRunAt`）；`src/lib/automations/runner.ts:412-420`（失败只 `console.error`）
- **证据**：
  ```ts
  try {
      const { run } = await launchAutomationTask(task, "schedule", { storePath, deps: opts?.deps });
      startedRuns.push(run);
  } catch (err) {
      console.error(`[automations] Failed to start task "${task.name}":`, err);
  }
  ```
  `claimDueTasks` 在返回前已经把 `nextRunAt` 写成"下一次"（`store.ts:355-357`），所以 `launchAutomationTask` 抛错时（`recordRunStarted` 的 `mutateStore` 因锁超时/磁盘写失败而抛、任务在 claim→start 的窗口内被暂停（`store.ts:385` 的 "Task was paused before its scheduled run started"）或删除（`store.ts:384`）、另一实例抢先 `recordRunStarted` 导致 409（`store.ts:386`））就等于"这次到期被吃掉"，而唯一的痕迹是这行 `console.error`。
- **触发路径**：两台 PiWeb 实例共用一个 `web-automations.json` 时争锁（`withExternalSettingsLock` 的 `retries: 20` 用尽后抛错，`settings-write-lock.ts:27`）；或用户恰好在到期那一瞬把任务暂停/删掉。注意工作区目录失效**不属于**这一类——`resolveWorkspacePath` 是在 `recordRunStarted` 之后才跑的（`runner.ts:302` vs `:318`），会正常落一条 `status:"error"` 的记录。
- **后果**：运行记录里没有这一条，`lastRunAt` 不更新，界面上完全看不出"这次到期被跳过了"，只有服务端控制台一行；对"每天一次"的任务等于静默少跑一天。
- **置信度**：已确认（代码路径：claim 先推进、失败后无补偿写）；触发窗口较窄，未实机复现。
- **建议修法**：`claimDueTasks` 只"预占"（写 `claimId/claimAt`）不推进 `nextRunAt`，`recordRunStarted` 成功后在同一/下一次写里推进；或者最小改动：`launchAutomationTask` 抛错时补一条 `status:"error"` 的运行记录（含错误原因），别只打日志。

### P3-1 interval 任务的下一次时间按 `now` 算，每次 tick 的延迟会累积成漂移
- **位置**：`src/lib/automations/store.ts:355`（`computeNextRunAt(task.schedule, now)`）
- **证据**：`computeNextRunAt` 的 interval 分支是 `return fromMs + normalized.every * unitMs;`（`schedule.ts:200-203`），而 `now` 是 tick 时刻（`runner.ts:406`），tick 间隔 15s。
- **后果**：`every 5 minutes` 的任务实际会在 5:07、10:10、15:13… 累积向前漂；一天下来偏几分钟。对齐整点的 interval（`every 1 hours`）会慢慢离开整点。功能不算错，但"每 1 小时"变成"每小时零 X 分"是用户可见的偏差。
- **置信度**：已确认（代码）。
- **建议修法**：interval 用 `computeNextRunAt(schedule, task.nextRunAt)` 并在落后超过一个周期时才回退到 `now`。

### P3-2 永不可能触发的 cron 被接受，任务静默"永不运行"
- **位置**：`src/lib/automations/schedule.ts:173-176`（只校验语法）、`:227-246`（找不到返回 `null`）
- **证据**：`case "cron": { const parsed = parseCronExpression(String(s.expr ?? "")); return { kind: "cron", expr: parsed.normalized }; }` —— `0 0 30 2 *` 语法合法、语义永不成立；`computeNextRunAt` 走满 `MAX_LOOKAHEAD_DAYS = 1466` 后返回 `null`。
- **后果**：任务 `nextRunAt: null`、`enabled: true`，UI 把它归到"已结束"页签（`AutomationsWorkspaceView.tsx:23-27`）——这也让"已结束"这个页签实际上只由这种非法组合产生。用户看不到任何"这条排期永远不会跑"的警告。
- **置信度**：已确认（代码推导）。
- **建议修法**：`validateSchedule` 里对 cron 试算一次 `computeNextRunAt`，返回 null 时报 `AutomationValidationError("this cron expression never fires")`；modal 里直接禁用保存。

### P3-3 模型目录请求失败时，带"指定模型"的任务连排期都存不下去
- **位置**：`src/components/workspace/AutomationModal.tsx:217-218`、`:548`
- **证据**：
  ```ts
  // AutomationModal.tsx:217
  const modelSelectionBlocked = modelKey !== DEFAULT_MODEL_VALUE && (modelsLoading || workspaceModels?.cwd !== cwd || unavailableModel);
  ```
  ```tsx
  // AutomationModal.tsx:548
  disabled={saving || modelSelectionBlocked || !name.trim() || !prompt.trim() || !cwd.trim() || !validSchedule.ok}
  ```
  `/api/models` 失败时 `workspaceModels` 保持 `null`（`:117-131`），于是 `workspaceModels?.cwd !== cwd` 恒为真、`modelSelectionBlocked` 恒为真。
- **后果**：模型服务临时不可用时，用户想改这个任务的名称/排期/权限也点不动"确认"，只能先把模型切回"默认"（会丢掉模型选择）。`modelsError` 只是一行红字，没提示"可以先切默认再保存"。
- **置信度**：已确认（代码 + 现有用例 `tests/components/automation-model-scope.test.tsx:27-40` 断言了这个 disabled）。
- **建议修法**：只在"提交时的模型字段"上阻止，而不是阻止整个表单；或允许保存并给出警告（服务端本来就有"模型不可用即报错"的兜底，`runner.ts:334-345`）。

### P3-4 运行历史是全局 100 条的环，`error` 不截断而 `summary` 截断
- **位置**：`src/lib/automations/store.ts:13-16`、`:55-58`、`:421-425`、`:440-441`
- **证据**：`const MAX_RUNS = 100;`、`const MAX_SUMMARY_LEN = 400;`；`retainRunHistory` 用"下标 < 100"判定（依赖数组恒为新→旧，靠 `unshift` 维持）；`summary` 过 `truncateSummary`，`error` 原样写入。
- **后果**：任务多时，一个高频任务的记录会把别的任务的历史挤掉（不是按任务分配配额）；模型返回的 `errorMessage` 可能很长，直接把 JSON 里的单条记录撑大。属可维护性问题，不是功能错误。
- **置信度**：已确认（代码）。
- **建议修法**：保留最近 N 条**每任务**记录 + 全局上限；`error` 也过一遍 `truncateSummary`（或单独的 800 字上限）。

### P3-5 状态字段与死代码：`schedulerStarted` 没人用、"已结束"页签近似死路、时间戳没有年份
- **位置**：`src/lib/automations/types.ts:69`（`schedulerStarted`）；`src/lib/automations/runner.ts:488`；`src/components/workspace/AutomationsWorkspaceView.tsx:29-38`（`formatTimestamp` 无年份）、`:23-27`
- **证据**：`schedulerStarted: boolean` 只出现在类型、`getAutomationsSnapshot` 与测试里（`tests/automations-runner.test.ts:99-102`），UI 从不读取；`formatTimestamp` 只格式化 `月-日 时:分`。
- **后果**：调度器没起来（例如 `NEXT_PHASE` 命中，`runner.ts:475`）时 UI 无法提示"自动执行没在跑"，任务卡片照样显示下次运行时间——用户会以为排期有效。跨年查看历史时时间戳有歧义。
- **置信度**：已确认（grep 无其他引用）。
- **建议修法**：`schedulerStarted === false` 时在页面顶部给一条警告条；时间戳在跨年时补年份。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| unattended 会话里 `ask_user_question` / `request_permission` 的返回 | P1-1 的根因，直接决定一次运行会不会空转 30 分钟 | 用 fake deps 的 `observeManagedEvents` 模拟模型发起 `ask`，断言后台会话**立即**返回 `unavailable/skipped` 而不是等满超时；现有 runner 用例完全没覆盖"运行中要交互"的场景 |
| 服务启动后对"pid 复用"的伪造记录的处理 | P2-1 会让任务永久卡死且只能手改文件 | 构造 `runs[0] = {status:"running", ownerPid: process.pid, startedAt: 很久以前}`，断言 `reconcileInterruptedRuns` 或 TTL 逻辑把它改判 error；现有用例（`tests/automations-store.test.ts:149-161`）只测"同进程活着必须保留" |
| 多任务同时到期时的并发上限 | P2-2 是资源耗尽面 | `runDueAutomations` 一次 tick 命中 10 个任务，断言同时启动数不超过配置上限、其余保持 due 等下一 tick |
| 损坏记录的可恢复性 | P2-3 现在等于"整站不可用" | 已有用例只断言"拒绝写入"，缺"坏记录不进内存 / 页面仍可用 / 能导出备份"的行为断言 |
| 漏跑被跳过时的可见记录 | P2-4 | `claimDueTasks` 传一个远滞后的 `now`，断言产生了一条可读的"跳过"痕迹（或 `lastSkippedAt`），而不只是 `nextRunAt` 被推进 |
| 取消运行 | P2-5 | 有 `cancel` action 后：断言运行被 abort、记录状态为 cancelled、`activeTaskIds` 清空、下一次 tick 可再次运行 |
| 调度器真起没起来 | P3-5 | 断言 `ensureAutomationSchedulerStarted()` 在 `NEXT_PHASE=phase-production-build` 下不起 timer、在正常环境下 `schedulerStarted` 反映真实状态（现有用例只测 stop handle 隔离，`tests/automations-runner.test.ts:91-112`） |
| 组件层的表单错误态 | P3-3 | `/api/models` 失败时 `确认` 按钮是否仍可用（现在会被 P3-3 的 gate 挡住，属"测试与实现都不考虑"的地方） |

## 3. 与其他区域的可能交叉点

1. **bridge（`src/lib/agent-manager.ts` / `extension-ui.ts`）**：P1-1 的修法落在 `askQuestions` / `hasViewers` 的语义上——后台会话"用默认值"这条注释与 `waitForViewer: true` 的实际行为不一致，需要 bridge 区域确认"headless 标记"应该挂在哪一层（`Managed` 字段？`observeManagedEvents` 的旁路？）。另外 `registerManaged` 的 `toolPreset: "readonly"` 初值是"自动化会话像 readonly"这一误解的来源，建议 bridge 侧在注释或类型上写明"初值，运行器会在首个回合前覆盖"。
2. **sandbox/权限**：`PiWeb_Permissions_Review_2026-11-13.md` 记录的 P1（`file://` 绕过 workspace 写入边界、运行中降档后已准备调用仍可越界）会**放大到无人值守场景**：自动化任务的默认档就是 `workspace`（`tool-preset.ts:29`），模型在无人盯的情况下跑一整轮，出了问题没有人当场发现。请 sandbox 区域在结论里明确"该绕过对自动化运行同样成立"。
3. **API/鉴权**：`/api/automations` 走 `src/proxy.ts` 的认证网关（非公开路径 → 401，非只读方法要求同源，`proxy.ts:24-26,56-66`），所以"创建 full 档任务 = 任意代码执行"这条链在开启认证时不会暴露给未登录方。但 `proxy.ts:28` 的 `if (!authEnabled()) return NextResponse.next()` 是全局旁路，值得 API 区域确认"认证关闭时是否还有别的补偿"（本区域只做引用，不下结论）。
4. **crosscut / tool-preferences**：每跑一次自动化都会新建一个会话并对该会话写一条工具偏好（`setToolPreset` 冷分支 → `persistToolPreference`，`agent-manager.ts:2942`；`saveToolPreference` 无条件新增键，`tool-preferences.ts:96-108`），`web-tool-preferences.json` 只增不减。高频自动化（`every 1 minutes`）一天就能加 1440 条记录。请 crosscut 区域确认该文件是否有清理策略（本区域未发现）。
5. **sessions-workspaces**：自动化每次运行都 `createNewSession` 一条会话，运行结束后**不 dispose**（只有超时才 dispose，`runner.ts:349-351`），靠 `reap()` 的 10 分钟空闲回收兜底（`agent-manager.ts:82,2184-2189`）。如果 sessions 区域正在改 LRU/归档策略，请确认"无 viewer 的后台会话被 60 秒 reaper 回收时不会打断正在等 settlement 的运行"（`isManagedBusy` 对 `agent_settled` 之后、`persistRunFinish` 之前的窗口是否仍为真，需要在 bridge 侧确认）。

## 4. 建议优先修的 3 件事

1. **P1-1**：让无人值守会话的交互请求立即失败（headless 语义），否则"模型问一句 → 白跑 30 分钟"是任何不自包含 prompt 的默认结局；顺手把 `ask_user_question`/`request_permission` 从自动化活动工具里去掉更稳。
2. **P2-1**：给 `running` 记录加 TTL / 进程实例令牌。这是唯一会让用户"必须手改 JSON 才能恢复"的缺陷，且和 lead 关心的"多实例/多 bundle"是同一个判活问题。
3. **P2-2 + P2-5**：并发上限 + 一等公民的取消。这两条一起决定"自动化会不会把机器和额度打爆，以及用户能不能在发现不对时立刻收手"；都只动 `runner.ts` 与一条 API action，改动面小。
