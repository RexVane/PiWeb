# 自动化静态审查（相对 HEAD `1d4efba`）

范围全部为未跟踪新文件。只读静态分析，外加一次 `TZ=America/New_York` 的 `Date` 构造探针（见 DST 条目）。未跑 npm / vitest / build，未改 git 状态。

## 发现

### [HIGH] src/lib/automations/runner.ts:246
**问题**：以 `/` 开头且能匹配扩展命令的任务提示会被当成已成功结束；调度器停止监视后清空 headless，停止请求不再传到该命令，无人值守提问改为干等浏览器。
**触发条件**：任务 `prompt` 去掉空白后以 `/` 开头，且当前会话 `extensionRunner.getCommand(name)` 为真（API、`manage_automation`、创建弹窗都不拒绝这种文本）。扩展命令在 `agent_start` 之前耗时超过约 30ms，或根本不会把 `m.runActive` 置真（纯 shell / 扩展命令）。
**期望行为**：调度器应一直守到命令结束；headless 保持为真，提问立即按「无人值守、不批准」结束；停止应中止该命令及其子进程，并记下 error 而不是 success。
**实际行为**：`submitPrompt` 发现扩展命令后立刻 `resolve({ ok: true })`，不等 `session.prompt` 结束，只把 `commandRunning` 置真。runner 随后 `agent.waitForIdle()`：没有 `activeRun` 时该 Promise 立即完成，再等 30ms；只有此时 `m.runActive` 仍为真才继续等 `settledPromise`。否则直接落到 `status: "success", summary: "(Completed)"`。`finally` 清掉 30 分钟超时和 5 秒心跳，并把 `managed.headless` 设回 false，然后 `recordRunFinished` 释放 `activeTaskIds`。此后 `requestAutomationStop` 写上的 `cancelRequestedAt` 不再被读取，`disposeSession` 也不会被调用。`askQuestions` 在 headless 已清且 `waitForViewer: true` 时会等到 `ASK_USER_TIMEOUT_MS`（30 分钟）或真有人打开该会话。
**证据**：`runner.ts` 246–252、286–288、324–336、377–380、393–394；`agent-manager.ts` 2857–2880（扩展命令提前 resolve，`commandRunning` 仅在 `run.finally` 清掉）；`agent.js` `waitForIdle` 在没有 `activeRun` 时返回已完成的 Promise；`extension-ui.ts` 233、381–390（headless 才立即返回 unavailable；否则 `waitForViewer` 挂到超时）；`ask-user.ts` 10（30 分钟）。对照：headless 仍为真时，`interaction_unavailable` 会让 runner 198–201、256–258 立刻失败并 `disposeSession`，这条路径本身不挂死。
**修复建议**：`prompt` 若是扩展命令，runner 必须等 `commandRunning === false` 且 session idle，期间保持 headless，并把 abort 接到 `stopManagedRun`（含 `abortBash`）。或者拒绝以 `/` 开头的自动化提示，只允许普通用户消息。
**最小失败测试**：注册一个 200ms 后才返回、期间调用 `ui.confirm` 的扩展命令。创建 prompt 为 `/that-command` 的任务并 `launchAutomationTask`。30–50ms 内 run 应变为 success 且 `headless === false`；命令仍在跑；`requestAutomationStop` 后进程仍在，confirm 在没有 viewer 时不会立即返回。

### [HIGH] src/lib/automations/store.ts:421
**问题**：并发已满或同一任务仍在跑时，超过 2 分钟还没排上的到期执行会被记成「离线/休眠错过」并直接跳过，而不是推迟到有空位再跑。
**触发条件**：已有 4 个 live run（`MAX_CONCURRENT_AUTOMATIONS`），或本任务自己的 run 尚未结束；另一个任务的 `nextRunAt` 已到，且在空出槽位之前又过了 `SCHEDULE_MISSED_GRACE_MS`（2 分钟）。单次运行上限是 30 分钟，所以这是常态而不是宕机。
**期望行为**：槽位满或本任务仍在执行时保持原来的 `nextRunAt`，等可以跑时再执行这一档；只有进程真的离线或休眠超过宽限才记 skipped。
**实际行为**：`busyTaskIds` / `running` 在计算 `missed` 之前就 `continue`，不改 `nextRunAt`。一旦 `now - nextRunAt > 2min`，`missed` 为真，额度检查被跳过（`if (!missed && claimed.length + running.size >= MAX)`），该档被写成 `status: "skipped"`，摘要固定为「服务离线或休眠期间错过执行时间」，`nextRunAt` 被推到 `computeNextRunAt(schedule, now)`。这一档不会再跑。
**证据**：`store.ts` 21、418–431；`runner.ts` 23–24、434–436。
**修复建议**：因额度或本任务仍在跑而推迟时，不要把宽限计成 missed。宽限只用于「进程当时没有在 tick」。推迟的任务应保留原 `nextRunAt`，空位出现后立即补跑或显式记一条「并发已满」而不是离线。
**最小失败测试**：4 个运行中的 run 占满额度，第 5 个任务 `nextRunAt = now - 121_000`。一次 `claimDueTasks` 后第 5 个应为 skipped，且没有任何一次 `launch`。把 `now - nextRunAt` 改成 60 秒再调一次，应仍保持 due、不被改写。

### [HIGH] src/lib/automations/schedule.ts:231
**问题**：cron 落在 DST 回拨的重复小时里时，同一次墙钟会排到第二次，任务在同一天执行两遍。
**触发条件**：服务器本地时区有秋冬回拨（探针用 `America/New_York`，2026-11-01 01:30 出现两次：`2026-11-01T05:30:00.000Z` 与 `+60min` 后的 `06:30:00.000Z`，`getHours()` 都是 1）。cron 的时分落在该重复小时，且 claim 时的 `now` 已经过了第一次、还没到第二次。
**期望行为**：与 daily/weekly 一样，一个墙钟时刻在回拨日只触发一次；下一次应是下一个不同的民时时刻。
**实际行为**：回拨日 `nextDay.getTimezoneOffset() - dayStart.getTimezoneOffset()` 为正（探针为 60），`repeatedMs` 把构造出的时刻再加一小时。两个瞬间都能通过 `getHours()===hour && getMinutes()===minute && getDate()`。`claimDueTasks` 用 `computeNextRunAt(schedule, now)`，`now` 约等于第一次触发时刻，于是下一次被定成同一天的第二次。daily/weekly 没有这段双瞬间逻辑，同一小时只跑一次。
**证据**：`schedule.ts` 231–240；`store.ts` 424；Node 探针：`new Date(2026,10,1,1,30)` 为 EDT 01:30，`+60min` 仍是 01:30（EST）。春季顺拨日该差分为负，`Math.max(0, …)` 得 0，cron 不会因此双发。
**修复建议**：回拨小时只保留严格大于 `fromMs` 的最早一次，并把「下一次」算到下一个不同的民日时刻；不要在 claim 的 `now` 仍落在同一重复小时时返回第二段。
**最小失败测试**：`TZ=America/New_York`，cron `30 1 * * *`，`fromMs` 取 2026-11-01 第一次 01:30 之后 1 秒。`computeNextRunAt` 不应返回第二次 01:30（`…T06:30:00.000Z`），而应是 11-02 的 01:30。

### [HIGH] src/lib/automations/store.ts:495
**问题**：claim 已经把 `nextRunAt` 推后之后，若 `recordRunStarted` 失败，释放条件会把失败吞掉，这一档既不跑也没有 skipped/error 记录。
**触发条件**：`claimDueTasks` 已提交新的 `nextRunAt` 并返回带原始到期时间的快照；随后 `launchAutomationTask` 抛错（额度冲突、手动 run 已占用、存储暂时失败）。释放时该任务已有任意一条 `startedAt >= 原始 nextRunAt` 的 run（手动 run 在 `retryPendingFinishes` 的 await 窗口里启动即可），或 `updatedAt` 已变，或 `releaseAutomationClaim` 自己抛错。
**期望行为**：这次 claim 没有对应的 running 记录时，应把 `nextRunAt` 设回原到期时间，或写一条 error/skipped。失败必须可见，不能只打 console。
**实际行为**：catch 只 `console.error` 再调用 `releaseAutomationClaim`。释放在 `updatedAt` 不一致，或存在 `taskId` 相同且 `startedAt >= task.nextRunAt` 的历史 run 时直接 `changed: false`。claim 写入的未来 `nextRunAt` 保留。没有本档的 run 记录。`release` 再抛错时，tick 的 catch 同样只打日志。`launch` 在 `recordRunStarted` 之前有 `await retryPendingFinishes`，同进程的 `runAutomationNow` 可以插进这个窗口。
**证据**：`store.ts` 424–427（claimed 快照把 `nextRunAt` 改回旧值，但不改 `updatedAt`）、495–504；`runner.ts` 303、309–319、438–446、484。
**修复建议**：claim 时写入代次或 `claimToken`，释放只比较这个 token，不要用「任意较新的 startedAt」。释放失败或无法恢复时写一条 error run，并保持 due。
**最小失败测试**：任务 due 于 T。claim 后、`recordRunStarted` 前插入一条同任务、`startedAt = T+1`、status 已是 success 的手动 run，再让 `recordRunStarted` 抛 `AutomationConflictError`。断言 `nextRunAt` 仍是 claim 写出的未来时间，runs 里没有这条计划档的 skipped/error。

### [HIGH] src/lib/automations/store.ts:187
**问题**：任意一条损坏的 task 或 run 会让整个存储读取失败，调度器不再 claim，所有任务一起停。
**触发条件**：`web-automations.json` 版本仍是 1，但 `tasks`/`runs` 里有一条 `sanitizeTaskRecord` 或 `sanitizeRunRecord` 返回 null（非法 schedule、缺 id/cwd、status 不是四态之一等）。
**期望行为**：跳过坏记录并继续跑其余任务，或自动走已有的 salvage，而不是让全部定时任务停摆。
**实际行为**：`readStore` 发现任一 null 就抛 `AutomationStoreError`。`mutateStore` / `claimDueTasks` / `listAutomations` 全部失败。tick 在 `initialize` 或 `runDueAutomations` 处失败，只 `console.error`。坏记录不会被自动隔离。`inspectAutomationStore` 能 salvage 出好记录并给出 `storeError`，但那条路径只用于 GET/修复，调度器不走它。修复必须人工调用 `repairStore`。
**证据**：`store.ts` 120–151、154–176、187–191、220–226、241、414；`runner.ts` 471–484。
**修复建议**：调度读取使用与 inspect 相同的「跳过坏记录」策略，并把坏记录留在原文件或 sidecar，不要让一条坏记录拒绝整个 `mutateStore`。
**最小失败测试**：两任务的合法文件，把第二条 task 的 `schedule` 改成 `{}`。`claimDueTasks` 应抛错，第一条即使 `nextRunAt <= now` 也不会被启动。`inspectAutomationStore` 仍能返回第一条。

### [HIGH] src/lib/automations/store.ts:58
**问题**：心跳超过租约后，另一个进程会把仍在执行的 run 判死并再启动同一任务；原进程不会被停掉。
**触发条件**：两个 PiWeb 进程共用 `web-automations.json`（`OWNER_INSTANCE`、`hasLiveRunOwner` 就是为这件事写的）。持有 run 的进程连续超过 `OWNER_LEASE_MS`（5 分钟）没有成功心跳：事件循环被同步工作堵住，或 `heartbeatAutomationRun` 持续抛错（存储锁/磁盘）。原 run 的工具仍在跑。
**期望行为**：租约过期后要么向原 pid 发真正的停止并确认退出，要么在原进程仍活着时不要第二次 `recordRunStarted`。
**实际行为**：心跳过期在 `process.kill(pid, 0)` 之前就返回 false，根本不看进程是否还在。别的进程的 `activeRunIds` 为空，`reconcileInterruptedRuns` 把记录改成 error「Interrupted by server restart」，但不向原进程发 abort。随后 `claimDueTasks` / `recordRunStarted` 看不到 live owner，可以再插入一条 running。原进程的 `activeTaskIds` 仍占着，所以它自己不会再启动；第二个进程会。
**证据**：`store.ts` 22–24、56–67、439–466、560–577；`runner.ts` 329–335（心跳失败只打日志）、471。同进程不会误清：`activeRunIds.has(run.id)` 为真时 reconcile 保留该 run。
**修复建议**：租约过期后先对原 pid 做一次真正的停止（或要求原 `ownerInstance` 的心跳文件独立于大 JSON），确认退出后再改状态。心跳失败不应只打日志直到租约悄悄过期。
**最小失败测试**：进程 A 写下 running（pid=A，heartbeat 为 6 分钟前）且不退出。进程 B `reconcileInterruptedRuns(empty)` 后 `runAutomationNow`。应出现第二条 running，且 A 的会话没有收到 abort。

### [MEDIUM] src/lib/automations/schedule.ts:204
**问题**：daily/weekly 在 DST 春季缺口里会跑到被日期构造器进位后的时刻，而不是跳过不存在的墙钟。
**触发条件**：服务器本地时区存在春季顺拨缺口，计划时刻落在缺口内。探针：`TZ=America/New_York`，`new Date(2026,2,8,2,30)` 得到 03:30 EDT（`getHours()===3`，`2026-03-08T07:30:00.000Z`）。
**期望行为**：与同文件 cron 分支一样，民时不存在则跳过这一天（cron 用 `getHours()===hour && getMinutes()===minute` 把进位后的 03:30 丢掉）。
**实际行为**：daily/weekly 只比较 `getTime() > fromMs`，不核对进位后的时分。02:30 的每日任务在顺拨日 03:30 运行，并与真正的 03:30 任务撞车。回拨日 daily 只保留构造器给出的第一次，不会双发。
**证据**：`schedule.ts` 204–209、211–219；cron 的核对在 240。探针见上。
**修复建议**：daily/weekly 复用 cron 的「构造后再核对 getHours/getMinutes，不匹配则当日作废」逻辑。
**最小失败测试**：`TZ=America/New_York`，daily `02:30`，`fromMs` 为 2026-03-08 00:00 本地。返回值不应是 `2026-03-08T07:30:00.000Z`。

### [MEDIUM] src/lib/automations/schedule.ts:76
**问题**：cron 把 `*/n` 当成通配，日与星期同时受步长约束时用 AND，而不是标准 cron 的 OR。
**触发条件**：日字段或星期字段是 `*/n`、`*` 以外但以 `*` 开头的形式，另一字段是不受限的具体值。例如 `0 0 */2 * 1`（每隔两日，以及每周一）。
**期望行为**：只有字段是 `*`（不受限）才算 wildcard；两个字段都受限时，匹配应为日或星期（crontab 的 OR）。
**实际行为**：`isWildcard = trimmed.startsWith("*")`，`*/2` 与 `*` 同样为真。`cronMatchesDay` 仅在两边都不是 wildcard 时 OR，否则 AND。上例只会在「步长日且为周一」运行，周一的其他日期不跑。纯 `*` 与具体日的组合（`0 0 1 * *`）碰巧仍正确，因为 `*` 的值集合是全日。
**证据**：`schedule.ts` 76、182–190。
**修复建议**：wildcard 仅当字段在去掉空白后就是 `*`。`*/n` 视为受限。
**最小失败测试**：`parseCronExpression("0 0 */2 * 1")` 后，对某个不是步长日的周一，`cronMatchesDay` 应为 true。当前实现为 false。

### [MEDIUM] src/lib/automations/schedule.ts:201
**问题**：interval 的下一次从「这次 claim 的 now」起算，tick 迟到会永久叠进周期。
**触发条件**：interval 任务在 `nextRunAt` 之后才被 tick 扫到（tick 间隔 15 秒，再叠加 claim 之前的 I/O）。每次 claim 都这样重算。
**期望行为**：下一次 = 原 `nextRunAt + every`，或按固定相位对齐，避免每轮吃进调度延迟。
**实际行为**：`computeNextRunAt` 对 interval 返回 `fromMs + every * unitMs`。`claimDueTasks` 传入的 `fromMs` 是 `now` 不是原来的 `nextRunAt`。每轮最多叠加约一个 tick（未超过 2 分钟宽限时）。超过宽限则整档被 skipped（见额度那条），然后同样从 now 重新起算。
**证据**：`schedule.ts` 201–202；`store.ts` 424；`runner.ts` 22。
**修复建议**：interval 用 `task.nextRunAt + period`，若已落后超过一个周期再对齐到 now，并单独记漂移而不是悄悄加长。
**最小失败测试**：interval 1 分钟，`nextRunAt = T`，`claimDueTasks(T+14_000)`。新的 `nextRunAt` 应为 `T+60_000`，不是 `T+74_000`。

### [MEDIUM] src/lib/automations/runner.ts:372
**问题**：正常运行路径的停止不走 `stopManagedRun` / `abortBash`，也不等待子进程树退出；full 档没有 Job Object。
**触发条件**：非 `/` 扩展命令的运行已进入 `executeInBackground`，用户调用 `requestAutomationStop` 或 30 分钟超时触发 abort，且模型正在跑 bash 工具（full 档走本机 shell，不走 AppContainer）。
**期望行为**：与交互式停止相同：`session.abortBash()` + `session.abort()`，并等到 bash 不再活跃或明确失败；确认进程树退出后才 `recordRunFinished` 并放开该任务。
**实际行为**：心跳最多 5 秒后 `controller.abort`。catch 里只在 `signal.aborted && managed` 时调用 `disposeSession`。`disposeSession` 把 `shutdownSession` 以 void 丢开，其中只 `session.agent.abort()`，不调用 `abortBash`，也不等待。`agent.abort()` 会让仍挂着该 signal 的 bash 工具调用 `killProcessTree`；Windows 实现是 detached `taskkill /F /T`，错误被吞，调用方不等 taskkill。full 档 `createSandboxBashOperations` 直接 `local.exec`，`releaseSandbox` 无 Job 可杀。runner 随即写完 run 并删除 `activeTaskIds`。SDK 注明：shell 已经退出后，Windows 找不到仍持有管道的后台子进程。
**证据**：`runner.ts` 329–336、372–380；`agent-manager.ts` 1973–1982、2258–2268、2815–2824（`stopManagedRun` 才 `abortBash` 并轮询 `bashActive`）；`bash-operations.ts` 107–114；`sandbox/manager.ts` 6、80–88；`pi-coding-agent` `dist/utils/shell.js` 189–203；`dist/core/tools/bash.js` 96–120 与 106–107 的 Windows 注释。
**修复建议**：停止和超时改为 `execute({ cmd: "abort" })` / `stopManagedRun`，等待其返回后再 dispose；full 档也把 bash 放进可终止的 Job。失败时不要释放任务槽。
**最小失败测试**：full 任务跑 `bash` 睡眠 60 秒。`requestAutomationStop` 返回后立刻检查：在 `stopManagedRun` 被调用之前 run 已是 error，且测试桩上的 `abortBash` 调用次数为 0。子进程 pid 在 `recordRunFinished` 返回时仍可能存活（taskkill 未等待）。

### [MEDIUM] src/lib/automations/schedule.ts:246
**问题**：永远匹配不到的 cron 被存成 `nextRunAt: null`，任务保持 enabled，之后每次 tick 都静默跳过，界面显示为已结束。
**触发条件**：表达式语法合法但在 1466 天内没有民时命中，例如 `0 0 31 2 *`（2 月没有 31 日，月份又被限制为 2 月）。`validateSchedule` 接受日 31 与月 2 的组合。
**期望行为**：保存时拒绝不可能的表达式，或保持 due 并写一条可见错误，而不是看起来像「已结束」。
**实际行为**：`computeNextRunAt` 用尽 `MAX_LOOKAHEAD_DAYS` 后返回 null。创建/更新把 `enabled: true` 与 `nextRunAt: null` 一起写入。`claimDueTasks` 对 `nextRunAt === null` 直接 continue。UI 把 null 显示成 ended。
**证据**：`schedule.ts` 35、128、173–175、227–246；`store.ts` 309、363–367、421；`AutomationsWorkspaceView.tsx` 27。
**修复建议**：`validateSchedule` 对 cron 调用一次 `computeNextRunAt`，null 则拒绝保存。已有任务在算出 null 时写 error，不要只显示 ended。
**最小失败测试**：`validateSchedule({ kind: "cron", expr: "0 0 31 2 *" })` 目前成功；`computeNextRunAt` 为 null。创建后 `claimDueTasks(Date.now()+ 86_400_000)` 返回空数组且不写 run。

### [MEDIUM] src/lib/automations/store.ts:63
**问题**：进程已经死掉后，若 pid 被复用或 `kill(pid, 0)` 得到 EPERM，任务会在心跳租约内被当成仍在运行，无法再启动也不能删除。
**触发条件**：running 记录的 `heartbeatAt` 仍在 5 分钟租约内，原进程已退出；新进程占用了同一 pid 且 `kill(pid, 0)` 成功，或对复用 pid 抛 `EPERM`（代码把 EPERM 当成存活）。本进程复用自己的 pid 且 `ownerInstance` 不同时会返回 false，这条特例盖不住「别的进程复用了 pid」。
**期望行为**：pid 存活性不能单独续租；进程死掉后应马上允许 reconcile，而不是最久锁 5 分钟。
**实际行为**：租约未过期且 `kill` 成功或 EPERM 时 `hasLiveRunOwner` 为 true。claim、删除、停止都把该任务当作活的。没有新心跳（死进程不会写），锁最多持续到租约结束，不是永久死锁。
**证据**：`store.ts` 56–67、391–392、418、461、488。
**修复建议**：EPERM 不要当作存活。pid 检查加上启动令牌（不能只用 pid）：令牌不在了就立即判死。租约只作为辅助。
**最小失败测试**：记录 `ownerPid` 指向一个无关的存活进程，`heartbeatAt = Date.now()`，`ownerInstance` 为别的 uuid。`hasLiveRunOwner` 当前为 true，`deleteAutomationTask` 抛冲突。进程不存在且错误码为 EPERM 时同样为 true。

## 覆盖

已全文读：`src/lib/automations/` 下 `agent-tool.ts`、`runner.ts`、`schedule.ts`、`store.ts`、`types.ts`；`src/app/api/automations/route.ts`、`preview/route.ts`；`src/components/workspace/` 下 `AutomationModal.tsx`、`AutomationsWorkspaceView.tsx`、`SkillsPluginsViews.tsx`、`WorkspaceViewShell.tsx`。

为核对调用后果，另读了这些既有代码（不在 diff 里，只作证据）：`permission-gate.ts` 对 `manage_automation` 的拒绝、`pi.ts` 的 `TOOL_PRESETS`、`path-security.ts` 的 `resolveWorkspacePath`、`atomic-file.ts`、`settings-write-lock.ts`、`tool-preset.ts`、`proxy.ts` 认证网关、`agent-manager.ts` 的会话创建/销毁/停止/`submitPrompt`、`extension-ui.ts` 的 headless 提问、`sandbox/manager.ts` 与 `bash-operations.ts`、`instrumentation-node.ts` 的调度器启动、`public-diagnostic.ts` / `api-error.ts`，以及 pi SDK 的 `agent.abort` / `abortBash` / `killProcessTree`。

HEAD 确认为 `1d4efba9054909cd9c8b2788028ce704c99b03ea`。上述路径相对 HEAD 全部是 `??` 未跟踪，没有已跟踪文件的 diff。

## 未追踪

1. SDK `_tryExecuteExtensionCommand` 函数体（只确认 `submitPrompt` 在命令结束前 resolve）。
2. `src/lib/recoverable-remove.ts` 的 `createRecoverableCopy`。
3. `src/lib/session-import/files.ts` 的 `readFileBounded`。
4. `proper-lockfile` 的 stale 默认值（未读依赖源码，因此没有把锁文件报成永久死锁）。
5. `PluginMarketplace`、`PluginsSection`、`SkillsSection` 内部（只读了 `SkillsPluginsViews.tsx` 包装层）。

## 维度结论

- **时区**：计划没有独立时区，全部用服务器本地时区；preview 返回 `Intl` 时区，弹窗用该时区格式化，没有把用户输入反射进 HTML。DST 回拨使 cron 双发（HIGH），春季缺口使 daily/weekly 进位到错误时刻（MEDIUM）。
- **漏跑**：离线超过 2 分钟会记 skipped，这条本身成立。额度满或本任务仍在跑超过 2 分钟也会被记成离线漏跑（HIGH），属于误杀不是漏记。
- **定时器泄漏**：`startAutomationScheduler` 会 `clearInterval` 旧 timer 并 bump `generation`；`unref`；UI 的轮询在 effect cleanup 里清除。未看到 interval 泄漏。
- **同一任务重入**：同进程 `activeTaskIds` 的检查与添加是同步的，但失败分支无条件 `delete`，且 claim 与 `recordRunStarted` 不是同一次写入。存储锁在 live owner 仍有效时拒绝第二条 running。跨进程在心跳租约失效后可以双开（HIGH）。pid 复用则是假活，最多锁 5 分钟（MEDIUM）。
- **停止 / 孤儿进程**：正常路径会 `agent.abort()`，bash 工具因此收到 signal，但不等待、不 `abortBash`、full 无 Job（MEDIUM）。`/` 扩展命令路径心跳被拆掉，停止根本不会发出（HIGH）。成功结束后会话留给 10 分钟 idle reap（`IDLE_MS`），不是进程泄漏。
- **存储原子性**：同进程队列锁 + `proper-lockfile`，写入是 `wx` 临时文件再 `rename`。没有发现半截 JSON 的写入路径。`.last-good` 刷新失败只打日志，主文件已换上。
- **损坏记录**：一条坏记录让 `readStore` 失败，调度全停（HIGH）。salvage 只在 inspect/repair，不会自动进行。
- **claim 与 record 之间**：失败只进 console；释放条件用 `startedAt >= 原 nextRunAt` 时会放弃回滚（HIGH）。
- **全局并发**：有上限 4，`recordRunStarted` 在锁内再查一次。缺口是「满员推迟超过 2 分钟被跳过」，不是没有上限。
- **agent-tool**：`manage_automation` 不在 readonly/workspace 白名单里，执行期闸门也拒绝（能建更高权限任务）。full 会话可以创建任意 prompt、任意已存在目录、以及 `full` 档任务，这是现有设计。工具参数没有 eval；危险点是 prompt 原样进入 `cmd: "prompt"`，`/` 被当成扩展命令（HIGH 那条）。
- **preview 注入**：只返回 `nextRunAt` / 服务器时区 / `computedAt`。弹窗用 React 文本节点显示时区和错误，没有 `dangerouslySetInnerHTML`。未发现注入。
- **输入校验**：名称、prompt 长度、cwd 必须是已存在目录、preset 三档、schedule 语法都有校验。缺口：`/` 命令、不可能的 cron、`*/n` 的日/星期语义。
- **无人值守提问**：监视尚未结束且 `headless === true` 时，提问立即 unavailable，runner 会失败并 dispose，不挂死。监视被过早拆除之后才会干等最多 30 分钟（HIGH 那条）。
