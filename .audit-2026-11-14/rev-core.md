# rev-core 审查报告（2026-11-14）

审查对象：D:\AIApp\PiWeb 相对 HEAD 1d4efba 的未提交工作区（静态分析，只读 + 本报告文件）。
范围声明：范围中提到的 `src/lib/session-retention-scheduler.ts` 在仓库中不存在；保留期调度器实际位于已跟踪并修改的 `src/lib/session-retention.ts`（`startArchivedSessionRetention`），按该文件审查。

计数：CRITICAL 0 · HIGH 0 · MEDIUM 4 · QUESTION 2 · 未追踪 12

---

## 发现

### [MEDIUM] src/lib/session-reader.ts:384
**问题**：`readSession` 从「临时打开 SessionManager」改为 `getManaged()`，把每次冷读/翻页的会话永久注册进全局会话池；冷条目无上限、且每次 `getManaged` 都 `touch` 续命。
**触发条件**：用户在侧栏/历史里连续浏览 N 个不同会话（`GET /api/sessions/[id]`、`/api/sessions/[id]/history`、`/api/sessions/[id]/images` 三条路由都走 `getManaged`），10 分钟内浏览的每个会话都在池中持有完整解析条目（SessionManager 全量 entries）+ TrajLedger + DiskTracker；翻页请求还会不断重置 `lastActive`，把回收时间一直往后推。MAX_HOT_SESSIONS=24 只在 `ensureSession` 里约束热会话，`reap()` 对冷条目（session=null）只按 10 分钟空闲回收，无数量上限。
**期望行为**：冷读（历史查看）与热会话池解耦：读完即弃，或冷条目有独立的数量上限/LRU。
**实际行为**：浏览过的每个会话都在 `sessions` Map 里驻留 ≥10 分钟（IDLE_MS），内存随浏览量线性增长且不设上限。
**证据**：
```
src/lib/session-reader.ts
384: 	const managed = getManaged(sessionPath);
```
diff 佐证（同一函数）：
```
-	const sm = SessionManager.open(sessionPath);
+	const managed = getManaged(sessionPath);
```
`src/lib/agent-manager.ts:1177-1187`（getManaged 未命中即 registerManaged 并 touch）、`:2307-2320`（reap 仅按 `now - m.lastActive <= IDLE_MS`（10 分钟）回收，`MAX_ACTIVE` 统计只数 `m.session` 非空的条目）、`:1698-1706`（MAX_HOT_SESSIONS 仅在 ensureSession 时生效）。
**修复建议**：`readSession`/history/images 这类只读投影改回临时 `SessionManager.open`（或在 getManaged 增加 `cold: true` 标记并让 reap 对冷条目用更短的 TTL 与数量上限）；至少给冷条目加独立的 LRU 上限。
**最小失败测试**：对 `/api/sessions/[id]`（或直接调 readSession）连续请求 100 个不同会话文件，断言 `sessions`（__piWebSessions）size 不随请求次数增长（或 ≤ 一个小上限）；当前实现下 size 会涨到 ≥100。

### [MEDIUM] src/lib/growth-service.ts:440
**问题**：`assertHistoryCapacity` 用 `rev-list --objects` 全量对象清单（maxBuffer 8MiB）+ `cat-file --batch-check` 核对 2000 轮 / 1GB 上限，但对象 ID 清单本身会在到达设计上限之前先撞上 8MiB 输出缓冲；此后每一轮 commit 都在同一处失败，项目生长记录对该工作区永久不可用，且报错是通用信息而非预期的「历史超限，请导出后管理历史」引导。
**触发条件**：长期使用的工作区累计历史对象数 ≳ 8MiB/41B ≈ 20 万（2000 轮上限 × 每轮约百级 blob/tree 即可达）。`assertHistoryCapacity` 在每次 commitRound 被调用两次（:820、:842），一旦 `rev-list --objects` 输出超 8MiB，runGit 杀子进程并 `fail(new GrowthError("git output exceeded the buffer limit", "too-large"))`，commitRound 抛错，本轮与之后所有轮都无法记录；1GB 大小判定（`total > MAX_GROWTH_HISTORY_BYTES`）永远走不到。
**期望行为**：容量守卫在对象清单超过缓冲预算时降级（按 `rev-list --count` 估算或分批流式统计），或至少把缓冲超限映射为与 1GB/2000 轮一致的「历史已达上限」用户引导。
**实际行为**：每次提交都报 `git output exceeded the buffer limit`，生长记录停摆，且无自助恢复路径（记录做不进去，也没提示如何清理）。
**证据**：
```
440: 	const objects = (await shadow(ws, ["rev-list", "--objects", "--no-object-names", ...(head ? [head.commit] : []), tree], { maxBuffer: 8 * 1024 * 1024 })).stdout;
441: 	const sizes = (await shadow(ws, ["cat-file", "--batch-check=%(objectsize)"], { input: objects, maxBuffer: 8 * 1024 * 1024 })).stdout.toString("utf8");
204: 					if (size > maxBuffer) {
206: 						fail(new GrowthError("git output exceeded the buffer limit", "too-large"));
```
**修复建议**：对 `rev-list --objects` 改流式管道（spawn stdout 直灌 cat-file stdin，不落缓冲），或缓冲超限时回退到「仅按轮数上限 + 最近 N 轮对象估算」；把 buffer-exceeded 映射为明确的 too-large 用户提示。
**最小失败测试**：构造 gitDir 里 >20 万对象（循环 commit 小文件）后调用 `commitRound`，断言返回的错误是「增长历史已达到…上限」类文案且 `code === "too-large"` 的语义路径，而不是 `git output exceeded the buffer limit`。

### [MEDIUM] src/lib/session-retention.ts:56-93
**问题**：保留期删除的每一项判定基于「清扫开始时取回的归档列表快照」，删除前不复核登记表；且 `isActive` 只覆盖本进程。用户恰好在清扫期间取消归档（forgetSession）的会话，仍会被这份快照删掉；第二个 PiWeb 进程（如 dev + 生产并存）里打开着的会话也不在 `isActive` 覆盖内。
**触发条件**：清扫逐项处理时（每项要做 stat、可能的 recoverableRemove 全量指纹+复制，单个会话可达数秒，总量大时整轮可达分钟级），用户对列表中靠后的一项执行「取消归档」（workspace-store.ts:391-410 `forgetSession` 把它移出 archivedSessions）；清扫轮到该项时 `isActive`/stat 已过、直接 `deleteSession`。多实例场景同理：进程 A 中会话在 `sessions` 池里正被查看，进程 B 的清扫看不到。
**期望行为**：删除前对每项重新确认「仍在归档列表里」（复读登记表或复用 `withSettingsWriteLock` 原子比对）；删除动作与归档状态变更互斥。
**实际行为**：按快照删除；刚被恢复的会话文件被移除（有 recoverableRemove 副本，可救回，但用户视角是「刚取消归档的会话被删了」）。
**证据**：
```
54: 	const entries = await getArchivedEntries({ now, persist: !dryRun });
62: 			if (isActive(target)) {
84: 			const { deleteSession } = await import("./session-reader");
87: 			await deleteSession(target);
```
`agent-manager.ts:2331-2337`：`isSessionInUse` 只遍历本进程 `sessions` Map。多实例场景在 `session-retention.ts` 头注释「正在被本进程管理的会话…一律跳过」中已自认边界。
**修复建议**：循环体内（`deleteSession` 之前）重读一次登记表确认 `pathKey(target)` 仍在 archivedSessions（一次小 JSON 读，成本可忽略）；长期看把归档删除与登记表变更放进同一把 `withSettingsWriteLock`。
**最小失败测试**：`sweepArchivedSessions({ now: 0, retentionDays: 30 })` 中在自定义 `deleteSession` 导入点（mock `./session-reader`）触发前调用 `forgetSession(target)`，断言文件未被删除；当前实现会照删。

### [MEDIUM] src/lib/agent-manager.ts:1947-1953
**问题**：一次性 bash 升权的审计命令串在两处用不同时点的 `getShellCommandPrefix()` 拼接，可能不相等，导致已批准的升权被「烧掉」但命令没有按批准范围执行。
**触发条件**：会话已创建后用户修改 `settings.shellCommandPrefix`（guard 在执行时读 `getSettingsManager(m.cwd).getShellCommandPrefix()`，agent-manager.ts:1950），而 SDK bash 工具定义创建时固化了旧前缀（sessionCustomTools :1438 → SDK `dist/core/tools/bash.js:184,197` `commandPrefix ? \`${commandPrefix}\n${command}\` : command`）。此时发生一次批准的越权 bash：guard 用新前缀拼 `approval.command`，bash-operations 的 `consumeGrant`（bash-operations.ts:113 → agent-manager.ts:1389-1395 `approval.command !== command` → return null）匹配失败 → 返回 null → 命令按普通档位（workspace/readonly 沙箱）执行，`m.escalation` 已在 guard 里 `clearEscalation` 消耗完毕。用户批准的越权没有生效且不可再用。
**期望行为**：guard 与 SDK 工具用同一份前缀（与工具定义创建时一致），或 `consumeEscalation` 匹配失败时不要先消耗授权（把 `clearEscalation` 挪到 consumeGrant 成功之后 / 由 consumeGrant 的结果决定是否清）。
**实际行为**：授权先被清空，命令降级执行或失败，审计记录（非 bash 才记）与实际执行范围不一致。
**证据**：
```
1947: 			if (grant && grant.expiresAt >= Date.now() && grant.remaining > 0 && grant.actionKey === permissionActionKey(action) && m.toolPreset !== "full") {
1948: 				clearEscalation(m);
1950: 				const prefix = getSettingsManager(m.cwd).getShellCommandPrefix();
1951: 				const command = tool.name === "bash" && typeof rawCommand === "string" ? (prefix ? `${prefix}\n${rawCommand}` : rawCommand) : undefined;
1438: 			commandPrefix: settings.getShellCommandPrefix(),
1389: function consumeEscalation(m: Managed, command: string): EscalationScope | null {
1391: 	if (!approval || approval.managed !== m || approval.used || approval.preset !== m.toolPreset || approval.command !== command) return null;
```
SDK 佐证：`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:184,197`（前缀在定义创建时固定）。
**修复建议**：guard 侧复用 `sessionCustomTools` 同源的 commandPrefix（闭包捕获创建时的值），或改为 `sessionCustomTools` 把「compose 命令」的逻辑下放给 bash-operations（consumeGrant 收原始命令、内部用同一前缀拼审计串）；并调整消耗顺序（先 consume 成功再 clearEscalation）。
**最小失败测试**：创建会话后改 settings 的 shellCommandPrefix，走 request_permission 批准一次 bash 升权，断言 `consumeGrant` 返回非 null 且命令按批准 scope 执行；当前实现返回 null。

### [QUESTION] src/lib/agent-manager.ts:1837、1876（配合 1940-1945）
**问题**：`evaluateToolCallGate` 在「await 期间 preset/逐项选择变了」时无限递归重评；`guardToolExecution` 的 do-while 也在同样条件下重试。两者都没有重试上限。
**触发条件**：需要在一个工具门禁的异步窗口（realpath 等）内持续并发翻转 `toolPreset`/`customActiveTools`（setToolPreset 是允许运行中调用的）。单次并发翻转会被循环吸收；要构成活锁需要一个持续翻转的调用方（如自动化脚本循环调 API），我无法构造一个仅由正常用户操作触发的确定性活锁。
**期望行为**：重评/递归带上限（如 3 次），超限按当前策略给出确定性裁决。
**实际行为**：理论上无上限重评；正常负载下每次都收敛。
**证据**：
```
1837: 	if (m.toolPreset !== presetAtStart || m.customActiveTools !== customAtStart) return evaluateToolCallGate(m, event);
1876: 	if (m.toolPreset !== presetAtStart || m.customActiveTools !== customAtStart) return evaluateToolCallGate(m, event);
1945: 			} while (currentPreset !== m.toolPreset || currentCustom !== m.customActiveTools);
```
**修复建议**：给 evaluateToolCallGate 增加深度参数并在超限后按最新状态裁决返回。
**最小失败测试**：并发循环 setToolPreset 与一次 bash 工具调用（mock permissionDenial 带 await），断言 execute 在有限时间内返回；如无法构造翻转源，则维持 QUESTION。

### [QUESTION] src/lib/agent-manager.ts:2249-2255（调用点 1044、1773）
**问题**：`shutdownFromExtensionCommand` 的忙态门漏了 `m.commandRunning`，且两处调用点都是 `void` 无拒绝处理器；`disposeSessionPath` 里 `stopManagedRun` 失败时抛错会成为进程级 unhandled rejection（src 内没有 unhandledRejection 处理器），Node 默认行为是退出进程，殃及所有会话。
**触发条件**：需要「门通过（空闲）→ disposeSessionPath 复查时 commandRunning 已为真 → stopManagedRun 返回 false」三层窄窗口同时成立（commandRunning 与 isIdle 的窗口极小，stop 失败还需 session.abort() 拒绝或 5 秒不收敛）。我无法构造确定性触发序列。
**期望行为**：`void shutdownFromExtensionCommand(...)` 改为带 catch 的兜底（记日志/发布 error 事件）；忙态门补上 `m.commandRunning` 与 `isManagedBusy` 对齐。
**实际行为**：失败路径的拒绝无人接，最坏情况进程退出。
**证据**：
```
2249: 	if (m.creating || m.resourceReloading || m.runActive || m.bashActive || (m.session && !m.session.isIdle)) {
2255: 	await disposeSessionPath(m.sessionPath);
2298: 	if (session && (session.isStreaming || m.runActive || m.commandRunning || m.bashActive)) {
2299: 		if (!(await stopManagedRun(m, session))) throw new Error("停止尚未完成，已保留会话。请等待当前操作结束后再归档。");
1044: 			if (m.shutdownRequested) queueMicrotask(() => void shutdownFromExtensionCommand(m));
1773: 					setImmediate(() => void shutdownFromExtensionCommand(m));
```
**修复建议**：给两处 `void` 调用包上 `.catch()`；`disposeSessionPath` 的失败分支在「回收型」调用方（shutdown 路径）降级为日志而非抛出。
**最小失败测试**：mock `session.abort()` 拒绝，触发 ctx.shutdown() 收尾路径，断言进程不产生 unhandledRejection。

---

## 覆盖清单

- 全文/全 diff 已读：src/lib/agent-manager.ts（3330 行全文 + 794 行 diff）、src/lib/session-disk-sync.ts、src/lib/session-model-runtime.ts、src/lib/session-retention.ts（= 范围所称 session-retention-scheduler）、src/lib/growth-activity.ts、src/lib/jsonc-settings-storage.ts、src/lib/client-fetch.ts、src/lib/resource-fingerprint.ts、src/lib/skill-frontmatter.ts、src/lib/tool-preset.ts、src/lib/chat/web-history.ts、src/lib/chat/compose-prompt.ts、src/lib/chat/image-attachment.ts、src/lib/chat/session-location.ts、src/lib/chat/event-stream.ts（diff）、src/lib/chat/file-path.ts（diff）
- diff 已读并按需回读现文：src/lib/workspace-store.ts、files-service.ts、models-service.ts、growth-service.ts、types.ts、session-reader.ts、session-retention.ts、hooks/usePiWeb.ts、useGrowth.ts、useWorkspaceFiles.ts
- 佐证性抽读（结论引用）：src/lib/permission-gate.ts、confined-file-operations.ts、sandbox/manager.ts、sandbox/config.ts、sandbox/bash-operations.ts、recoverable-remove.ts、pi.ts（loader/锁部分）、growth-tracker.ts（run/consent 部分）、app/api/pi-settings/route.ts、app/api/agent/[id]/events/route.ts（本次仅 1 行 ping 帧变更）、SDK：pi-coding-agent dist/core/tools/bash.js、dist/core/settings-manager.js、dist/core/agent-session.js（prompt 为 async，无同步抛出，排除 commandRunning 卡死路径）

## 未追踪清单（12 项）

1. `src/lib/permission-request-tool.ts`（升权工具全文未读，仅经 agent-manager 调用面核对）
2. `src/lib/permission-audit.ts`
3. `src/lib/sandbox/windows-acl.ts`（沙箱 ACL 实现未审）
4. `src/lib/automations/`（runner/schedule/store/agent-tool 未审）
5. `src/lib/atomic-file.ts`、`src/lib/settings-write-lock.ts`（未读，多处依赖其原子性/互斥语义）
6. `src/lib/api-error.ts`、`file-preview.ts`、`read-file-bounded.ts`、`recycle-temporary.ts`（未读）
7. `src/app/api/sessions/[id]/history/route.ts`、`src/app/api/sessions/[id]/images/route.ts`（新路由，仅确认其调用面）
8. `src/app/api/agent/[id]/events/route.ts` 整体背压（本次变更仅 ping 帧；慢客户端 controller 队列无上限属存量设计，未列入发现）
9. 未变更文件无 diff 可审：`src/lib/chat/cancellation.ts`、`skill-expansion.ts`、`task-notification.ts`、`src/hooks/useFileViewer.ts`、`useDialog.ts`、`useSelectKeyboard.ts`
10. `src/lib/session-retention-scheduler.ts`：文件不存在（实际为 session-retention.ts，已按其审查）
11. 关联模块只按需抽读：`growth-tracker.ts`、`pi-settings.ts`、`trajectory.ts`、`session/metrics.ts`、`text-sanitize.ts`、`prompt-sources.ts`
12. 组件层（src/components/**）与本范围（lib/hooks）交界的行为未审

## 各维度结论

- **agent 进程崩溃/超时/断网时的清理与恢复**：agent 为进程内 SDK（无独立 agent 子进程），stopManagedRun 5s 超时 + stopFailed 保护、shutdownSession 5s 兜底、ensureSession 失败路径释放 modelRuntime/扩展 runtime、dispose 释放沙箱与 writeBases——除 QUESTION#2 的未处理拒绝路径外未发现问题。
- **子进程与监听器泄漏**：runGit 输出/记录上限 + kill、模型目录 HTTP agent `destroy()`、定时器 unref + globalThis 去重、guardToolExecution WeakSet 防重复包装、retention/reaper 单例——未发现问题。
- **事件流背压与客户端断连**：环形缓冲 400 + subscribe 续传校验 + 快照兜底 + epoch 防串台；事件序列化失败有兜底 error 帧；内部观察者异常互不传染——未发现问题（慢客户端流队列无上限为存量，见未追踪#8）。
- **会话文件并发写一致性**：SessionDiskTracker（stamp 五元组 + 首尾采样 + 8MiB 预算 + 半行留待下次 + 重写/截断/同尺寸改写判重开）较旧实现是净改进，tracker 跨 reopen 交接正确；采样对「同尺寸原位改写中段」存在理论盲区（pi 写入均为追加，无法构造现实触发，不列为发现）——未发现问题。
- **会话中途切模型**：冷会话 setModel/setThinkingLevel 直接落 JSONL 且有 TOCTOU 复检；热会话用会话私有 runtime（本次新增），切模型后 usage 缓存失效、档位按新模型钳制——未发现问题。
- **归档保留期删除是否可丢数据**：删除走 recoverableRemove（核验副本 + INDEX），有 PI_WEB_ARCHIVE_RETENTION=0 开关、时钟跳变保护、逐项失败隔离、isActive 覆盖本进程在用会话（含历史浏览注册的）；遗留 MEDIUM#3（快照竞态 + 多实例边界）。
- **设置合并语义**：jsonc-settings-storage `edit()` 按 before/after 逐叶 diff 修改原 JSONC（删键、嵌套递归、BOM 保留），SDK 回调经核实返回全量合并对象（settings-manager.js persistScopedSettings `{...current, [field]: value}`），patch 不会清掉别的字段；models-service preserveJsoncLayout 同口径；skill-frontmatter 只改根级布尔——未发现问题。
- **错误被吞**：序列化/延迟发布/translate 均有兜底事件；工具偏好读失败降级 readonly 并提示；偏好保存失败保留原选择并抛出；applySettingsToSessions 聚合错误由路由转 warning——除 QUESTION#2 外未发现问题。
- **每 3 秒轮询的放大成本**：sessions 路由 ETag + 分页上限、listWorkspaceIndex 2s 戳缓存（并发共 Promise）、SessionDiskTracker 未变更仅 1 次 stat、listSessions 1.2s 合并并发扫描——未发现问题（冷条目驻留的内存放大见 MEDIUM#1）。
