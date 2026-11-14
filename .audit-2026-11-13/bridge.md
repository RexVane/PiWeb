# 桥层（agent-manager / 会话运行时）审计报告

## 0. 覆盖范围

- 逐行读完：`src/lib/agent-manager.ts`（3136 行）、`src/lib/session-model-runtime.ts`（70）、`src/lib/agent-config.ts`（129）、`src/lib/session-change-events.ts`（6）、`src/lib/event-batcher.ts`（62）。
- 测试读了：`tests/agent-prompt-acceptance.test.ts`（316，全）、`tests/agent-events-route.test.ts`（139，全）、`tests/message-cancellation.test.ts`（34，全）、`tests/session-model-runtime.test.ts`（172，全）、`tests/agent-hero-commands.test.ts`（160，全）、`tests/agent-resource-isolation.test.ts`（923，读了 1-73 / 200-319 / 580-709 / 790-923，约 55%——跳过 320-579、710-789 的沙箱与权限端到端用例，归 sandbox/权限区域）。
- 为跟调用链额外读（不归我裁）：`src/app/api/agent/[id]/route.ts`（24）、`src/app/api/agent/[id]/events/route.ts`（115）、`src/hooks/usePiWeb.ts:1040-1110`、`src/components/ChatInput.tsx:480-520`、`src/lib/chat/cancellation.ts`、`src/lib/extension-ui.ts:215-410`、`src/lib/growth-tracker.ts`（233）、`src/lib/sandbox/bash-operations.ts:1-140`、`src/lib/automations/runner.ts:100-310`、`tests/extension-surface.test.ts:200-330`。
- 只读核对 pi 公开契约（不改不评）：`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.{d.ts,js}` 的 `abort()` / `waitForIdle()` / `dispose()` / `_emit()`。
- 没跑测试（父 agent 在跑全量）；本报告结论均来自读码，凡需运行确认的都标了「疑似」。

**结论一览**

| 功能 | 结论 | 依据 |
|---|---|---|
| AgentManager 单例与多会话池 | OK-但脆弱（无硬上限，卡死会话永不出池） | `agent-manager.ts:176-179`、`2184-2197` |
| `ensureSession` 获取资源（sandbox 探测/工具偏好/资源发现/独立 model runtime/UI 桥/扩展绑定） | OK（失败回滚完整，有集成测试） | `1623-1730` |
| `disposeSession` 释放资源（ui/growth/session/订阅/model runtime/sandbox） | OK-但脆弱（`releaseSandbox` 不 await，见 P2-5） | `2142-2168` |
| `sessionCustomTools` 组装顺序与同名覆盖 | OK（bash 覆盖内置，有端到端测试） | `1348-1382`、`1395-1440` |
| 工具档位 / 逐项白名单（`tool_call` 闸门 + execute 包装） | OK（`agent-resource-isolation` 端到端覆盖） | `1636-1652`、`1736-1861` |
| 一次性升权（escalation）消费路径 | OK-但脆弱（bash 在 exec 内消费、write 用 callId 白名单；`!` 命令共用同一份授权） | `1318-1346`、`1644-1651`、`1773-1789` |
| pi 事件 → SSE 转换 | OK-但脆弱（P1-2 队头卡死、P2-3 无异常边界） | `505-574`、`839-1046` |
| abort / cancel 语义 | **有问题（P1-1）** | `2861-2871`、`2175-2181`、`1702` |
| 消息队列与 steering | OK（有测试） | `2811-2860`、`2654-2674` |
| 模型切换与 session 恢复 | OK-但脆弱（冷会话会冷启动 agent；reopen 只搬部分会话级状态） | `2904-2928`、`1181-1209` |
| 错误吞噬 | 有问题（P2-1、P2-3） | `1967-1976`、`533-556` |
| Map / 缓存增长 | OK-但脆弱（P3-1、P3-3） | `179`、`442-465`、`697-791` |

## 1. 发现（按严重度降序）

### P1-1 点停止后没有兜底：`await session.abort()` 无超时，挂住就让会话永久停在 streaming，且没有任何逃生门

- **位置**：`src/lib/agent-manager.ts:2861-2871`（abort 命令）、`src/lib/agent-manager.ts:2175-2181`（归档/删除路径）、`src/lib/agent-manager.ts:1702`（扩展 `ctx.abort()`）、`src/lib/agent-manager.ts:2677-2684`（唯一带超时的 `abortRunAndWaitIdle`）
- **证据**：

```ts
// agent-manager.ts:2861-2871
			case "abort": {
				if (!m.session) return { ok: true, data: { steering: [], followUp: [] } };
				// 先清队列再中止（pi 终端 Esc 同款）：Agent.abort() 不清队列……
				const cleared = m.session.clearQueue();
				// 用户的 `!` 命令不属于 agent 回合，abort() 管不到它，单独停
				m.session.abortBash();
				await m.session.abort();
				publish(m, { type: "status", isStreaming: false, state: "aborted", ts: Date.now() });
				return { ok: true, data: cleared };
			}
```

```ts
// agent-manager.ts:2175-2181  归档 / DELETE /api/sessions/[id] 也走这里，同样无超时
export async function disposeSessionPath(sessionPath: string): Promise<void> {
	const m = sessions.get(sessionPath);
	if (!m) return;
	const session = m.session ?? (m.creating ? await m.creating.catch(() => null) : null);
	if (session?.isStreaming) await session.abort().catch(() => undefined);
	disposeSession(m);
}
```

SDK 公开契约（只读核对，不评内核）：`abort()` 的语义是「中止并**等到 idle**」，`waitForIdle()` 只有在 agent 真正 settle 时才 resolve，**没有任何超时**：

```js
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2073
    async abort() {
        if (this._isAgentRunActive) this._agentRunAbortRequested = true;
        this.abortRetry(); this.abortCompaction(); this.abortBranchSummary();
        if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
        this.agent.abort();
        await this.waitForIdle();          // ← 无超时
    }
```

全文件只有 `abortRunAndWaitIdle`（`2677-2684`，`editAndResend` / `sendQueueNow` 用）带 5 秒上限，且上限到了之后不做任何强制收工，只「不再等」。

- **触发路径**：`ChatInput.stopAndRestore`（`src/components/ChatInput.tsx:506`，`restoreQueued(await onAbort())`）→ `AppShell.abortPrompt`（`AppShell.tsx:744`）→ `usePiWeb.sendCommand`（`usePiWeb.ts:1066-1070`，**fetch 无 AbortSignal 无超时**）→ `POST /api/agent/[id]`（`src/app/api/agent/[id]/route.ts:14`，`await execute(...)` 无超时）→ `execute` 的 `case "abort"`。只要这一轮 agent 因为任何原因 settle 不了（provider 流不响应取消、某个工具的 `execute` 不理会 signal、扩展的 `message_end` / `before_settle` 处理器一直 await），`session.abort()` 就永不 resolve。
- **后果**（可复现描述）：
  1. abort 的 HTTP 请求永不返回 → 停止按钮的 `await` 永不结束，`restoreQueued` 不执行；而 `clearQueue()` 已经在服务端把排队消息删了、`cleared` 又送不回去 → **用户排队的 steering/followUp 文本丢失**（刷新页面也回不来，因为队列里已经没了）。
  2. `status: aborted` 帧在 `await` **之后**才发（`2869`），所以浏览器一帧都收不到状态变化 → 界面继续 streaming。
  3. `m.runActive` 只在 `agent_settled` 清（`967-968`），`isManagedBusy` 还含 `!m.session.isIdle`（`1733`）→ 会话**永久判忙**：`prompt` 被拒（`2801` "session is busy; choose steer or followUp"）、`reap` 永远跳过（`2188`）、`shutdownFromExtensionCommand` 放弃（`2133`）、`buildSnapshot().isStreaming` 仍为 true（`2449`，刷新/重连的页面照样显示在跑）、`activeStatus()` 侧栏一直转圈（`3114`）。
  4. **归档也解不开**：`disposeSessionPath` 同样 `await session.abort()`（`2179`）→ `DELETE /api/sessions/[id]`（`src/app/api/sessions/[id]/route.ts:27`）与「移出工作区」一起挂住。
  5. 唯一出路是重启服务。
- **置信度**：「无兜底」已确认（读完整链路 + SDK 契约）；「这一轮为什么 settle 不了」需运行验证。卡住时抓一次诊断即可定性：`m.runActive`、`session.isStreaming`、`session.isIdle` 三者若分别是 `true/true/false`，就是本问题。另有一条**替代机制**同样能产生「停止后又在 streaming」的现象：SDK 在收尾阶段把提问塞进 `deferredSettledActions` 并在稍后用同一份 options 重发（`submitPrompt` 的注释 `2708-2710` 就是在讲这条），如果排队续跑在 abort 之后被触发，会再发一次 `agent_start`（`959-961`）把状态刷回 running —— 这条也需要运行确认。
- **建议修法**（最小改动，按优先级）：
  1. `case "abort"` 写成 `await Promise.race([session.abort().catch(() => undefined), timeout(ABORT_GRACE_MS)])`，**不管有没有等到都先 publish 状态帧、先返回 `cleared`**（先保住队列文本与 UI 反馈）；
  2. 超时未 settle 时打一条 warn 并记在 `m` 上（如 `m.abortTimedOutAt`），让 `isManagedBusy` 或 `reap` 能据此在 N 分钟后强制 `shutdownSession(session)`（`shutdownSession` 已有 5 秒上限 + `session.dispose()`，是现成的强制收工路径），把会话从「永久卡死」降级为「本轮作废、会话可重开」；
  3. `disposeSessionPath` 改成 `await Promise.race([abort, timeout])` 后再 `disposeSession`（归档必须永远能成功）；
  4. 顺手把顺序改为先 `abort()` 再 `abortBash()`，并用 `m.session.abortBash?.()`（`abortRunAndWaitIdle` 里就是这么写的，两处不一致）。
  5. 同样的 race 逻辑 `automations/runner.ts:121-133` 已有现成实现（`runStep(signal, operation)`），可直接复用写法。

### P1-2 `deferPublish` 的微任务一旦抛异常，这个会话的 SSE 事件流会永久被一个 `null` 队头堵死

- **位置**：`src/lib/agent-manager.ts:524-531`（`flushPublishes`）、`558-563`（`publish`）、`565-574`（`deferPublish`）、调用点 `879-911`（`message_end`）
- **证据**：

```ts
// agent-manager.ts:524-531
function flushPublishes(m: Managed): void {
	const queue = publishQueues.get(m);
	if (!queue) return;
	while (queue.length > 0 && queue[0].events !== null) {   // ← 队头是 null 就永久卡住
		for (const evt of queue.shift()!.events!) publishImmediate(m, evt);
	}
	if (queue.length === 0) publishQueues.delete(m);
}

// agent-manager.ts:565-574
function deferPublish(m: Managed, events: () => WebEvent[]): void {
	const queue = publishQueues.get(m) ?? [];
	const entry: QueuedPublish = { events: null };
	queue.push(entry);
	publishQueues.set(m, queue);
	queueMicrotask(() => {
		entry.events = events();      // ← 这里抛异常，entry.events 永远是 null
		flushPublishes(m);            // ← 也不会执行
	});
}
```

```ts
// agent-manager.ts:890-910  这个闭包里有多处未加保护的调用
			deferPublish(m, () => {
				const msg = projectMessage(m, raw);          // entryIdForMessage → sm.getEntryCount()/getEntries() 未 try
				...
				const usage = usageEvent(m);
				if (msg.role === "assistant" && m.session) {
					const routed = routedModelEvent(m, m.session);   // → session.getAvailableThinkingLevels() 未 try
```

- **触发路径**：任一条助手消息结束 → `message_end` → `deferPublish` 的微任务 → 闭包里任一处抛异常（最可疑的是 `routedModelEvent` 里的 `session.getAvailableThinkingLevels()`，同一份调用在 `buildSnapshot:2444-2448` 是被 try 包住的，而这里和 `publishModelState:585` 都没包；虚拟模型路由失败 / SDK 形状变化都会命中）。
- **后果**：`entry.events` 停在 `null`，`flushPublishes` 此后每次都从队头看到 `null` 直接 return。于是：**该会话之后所有 `publish` 都进队列再也不落地** —— 不再有 delta/status/tool/usage 帧，`m.seq` 不再增长，`m.buffer` 不再追加。用户看到的是「对话卡住、什么都不动、停止按钮也无反馈」（连 `aborted` 状态帧也发不出去）。`publishQueues` 是 WeakMap，条目要到会话被 dispose 才随 GC 消失，也就是说这份会话在进程存活期间等于死了。另外 `queueMicrotask` 里抛出的异常是**未捕获异常**，Node 会走 `uncaughtException`（Next dev 下通常只记日志，但生产 Node 默认会退出进程）。
- **置信度**：机制已确认（读了 `flushPublishes` / `publish` / `deferPublish` 三处完整语义）；触发源「闭包里抛异常」是**疑似**，需运行验证：在 `deferPublish` 里加 `try { entry.events = events() } catch (e) { entry.events = []; console.error(e) }`，或临时用一条会抛的 `getAvailableThinkingLevels`（虚拟模型 + 坏 route）复现。复现判定很简单：`m.seq` 停止增长但 `publish` 仍被调用。
- **建议修法**：
  1. 微任务体加 `try/catch/finally`：`try { entry.events = events(); } catch (e) { publish 一条 error 事件; entry.events = []; } flushPublishes(m);` —— 保证队头永远会被弹出；
  2. `flushPublishes` 的循环条件改成「只要队头不是 null 就弹」，其余情况直接跳过并清空（更好：队头为 null 时不要无限等待，记录一条 `console.warn`）；
  3. 顺手给 `routedModelEvent` / `publishModelState` 的 `getAvailableThinkingLevels()` 加 try（照 `buildSnapshot:2444-2448` 的写法）。

### P2-1 `performReload` 的 `finally` 里未保护 `applyToolPolicy`，一旦抛异常 `resourceReloading` 永久为真 → 会话永久判忙

- **位置**：`src/lib/agent-manager.ts:1967-1976`
- **证据**：

```ts
		} finally {
			applyToolPolicy(m, session);      // ← 会抛（同文件另两处都包了 try/catch）
			m.resourceReloading = false;      // ← 抛了就跳不到这里
			if (reloadTasks.get(m) === task) reloadTasks.delete(m);
			if (!m.disposed) { publishTools(m, session); ... }
		}
```

同一个 `applyToolPolicy` 在另外两处是被刻意包住的：`2296-2300`（`reloadManagedResources`，「策略本身出错不能把重载判成失败」）和 `3061-3065`（`/reload`，「同上：策略失败不影响 /reload 本身」）。唯独这个 `finally` 没包，而它正是 `m.resourceReloading = false` 的前置语句。

- **触发路径**：`/reload`、`扩展命令 ctx.reload()`、`POST /api/security` / 插件安装 / 技能新建 → `reloadSessionsForCwd` → `reloadManagedResources` → `session.reload()` → `performReload`。若 `rawReload` 失败（扩展语法错、MCP 起不来）或中途 `disposeSession` 让 session 进入半死状态，`applyToolPolicy` 里的 `session.setActiveToolsByName` / `guardToolExecution`（`1838` 直接读 `session.agent.state.tools`）就可能抛。
- **后果**：`m.resourceReloading` 永远 true → `isManagedBusy` 恒真 → `prompt` 在 `2791` 的第二个条件上被永久拒绝（`resourceReloading && !reloadTasks.has(m)`：`reloadTasks` 的删除也被跳过了，所以 `reloadTasks.has(m)` 为真 → 走到 `waitWhileReloading` → 等已 settle 的 task → 返回 "session is busy accepting another command"）、`reap` 跳过、`reloadManagedResources` 早退（`2290`）。与 P1-1 同一类锁死，但触发点是本地异常而不是 provider。
- **置信度**：机制已确认（读码 + 同文件另两处的对照）；具体哪个异常会命中是疑似（需在 `performReload` 的 finally 里加日志）。
- **建议修法**：把 `m.resourceReloading = false` 提到最前面，`applyToolPolicy` 单独 `try/catch`（跟 `2296-2300` 一致）：
  `} finally { m.resourceReloading = false; if (reloadTasks.get(m) === task) reloadTasks.delete(m); try { applyToolPolicy(m, session); } catch {} ... }`

### P2-2 `readonly` 档下用户的 `!` 命令完全不进沙箱，而且会偷走模型的一次性升权

- **位置**：`src/lib/agent-manager.ts:1643-1651`
- **证据**：

```ts
				// 用户的 `!` 命令走同一条受限执行；只在 workspace 档接管，其余档位保持 pi 的默认行为
				const userBashOperations = createSandboxBashOperations({
					sessionPath: m.sessionPath,
					cwd: m.cwd,
					preset: () => m.toolPreset,
					shellPath: settingsManager.getShellPath(),
					consumeGrant: (command: string) => consumeEscalation(m, command),   // ← 与模型共用同一份授权
				});
				api.on("user_bash", () => (m.toolPreset === "workspace" ? { operations: userBashOperations } : undefined));
```

对照 `src/lib/tool-preset.ts:5` 的档位定义：「readonly 仅可查看 —— 只能读和搜索；**有 OS 沙箱时允许只读 bash**」，以及 `toolPolicyDenial:1798` 对模型 bash 的 readonly 处理（要求显式升权）。而这里 `readonly` 直接返回 `undefined` → 走 pi 默认的本地 bash → **完全不受沙箱约束**（可写盘、可联外网）。
- **触发路径**：用户把会话切到「仅可查看」，然后在输入框敲 `!git reset --hard` / `!rm -rf build` → `case "bash"`（`2872`）→ `runUserBash` → `session.extensionRunner.emitUserBash(...)` 拿到 `undefined` → `session.executeBash` 用 pi 默认本地执行。
- **后果**：① 档位语义被绕过（用户自己的操作，所以不是越权，但产品承诺的「仅可查看」在这一条路径上不成立）；② `consumeGrant` 与模型共用 `m.escalation`：用户在模型刚申请到一次性授权后敲一条 `!` 命令，会把那次授权消耗掉并写进审计（`consumeEscalation` 里 `appendPermissionAudit`），模型随后那条被批准的越权操作会突然被拒。
- **置信度**：已确认（读码 + 档位文档对照）。语义上「用户手敲的命令本来就该跑」是合理的，所以这可能是**有意的取舍**，但与 `tool-preset.ts` 的注释、以及 `toolPolicyDenial` 对 readonly bash 的严格口径矛盾，至少需要明确一下。
- **建议修法**：`user_bash` 钩子按 `m.toolPreset === "workspace" || m.toolPreset === "readonly"` 都装沙箱 ops（`createSandboxBashOperations` 内部已经按 preset 选 `readonly` 模式并且「建不起来就报错拒绝」，是安全默认）；若确定 readonly 下 `!` 就该不受限，则把 `tool-preset.ts:5` 的注释改成与实现一致，并让 `!` 用独立的 grant（`consumeGrant` 传 `undefined`），不要把模型的授权烧掉。

### P2-3 `translate` / `publishImmediate` 没有异常边界，一处 `JSON.stringify` 或 SDK 调用抛错会顺着 pi 的同步 `_emit` 循环抛回 agent 回合

- **位置**：`src/lib/agent-manager.ts:533-556`（`publishImmediate`）、`1685`（`session.subscribe((evt) => { if (!m.disposed) translate(m, evt); })`）、`577-589`（`publishModelState`）
- **证据**：

```ts
// agent-manager.ts:533-545
function publishImmediate(m: Managed, evt: WebEvent): void {
	if (m.disposed) return;
	m.seq += 1;
	const json = JSON.stringify(evt);      // ← 未 try：args 里出现循环/BigInt 就抛
	m.buffer.push({ seq: m.seq, json });
	...
	for (const send of m.subscribers) { try { send(m.seq, json); } catch { m.subscribers.delete(send); } }
```

```ts
// agent-manager.ts:1685
			session.subscribe((evt) => { if (!m.disposed) translate(m, evt); });
```

pi 的派发是同步、无 try 的：`_emit(event) { for (const l of this._eventListeners) l(event); }`（`agent-session.js:703-707`）。
- **触发路径**：任意扩展工具 / codemode 嵌套调用的 `args` 带不可序列化或循环引用 → `tool_execution_start`（`913-925` 直接把 `evt.args` 放进事件）→ `JSON.stringify` 抛 → 异常从 `translate` 冒到 `_emit` 的调用者；`thinking_level_changed`（`1012-1015`）里 `publishModelState` 的 `getAvailableThinkingLevels()` 也是同理。
- **后果**：异常来源是「模型/扩展给的参数」，落到 pi 的回合循环里，最轻是这一轮以奇怪的错误结束（用户看到莫名报错），最重是 `queue_update` / `message_end` 这类内部派发点被打断，出现状态不一致（例如队列条不更新、assistant 消息没进 UI 但仍落盘）。与 P1-2 是同一类问题的两条不同出口。
- **置信度**：机制已确认（`_emit` 无 try，`JSON.stringify` 无 try）；触发概率疑似（需要扩展给出不可序列化 args）。
- **建议修法**：`publishImmediate` 里 `try { json = JSON.stringify(evt) } catch { json = JSON.stringify({ type: "error", message: "event not serializable", ts: Date.now() }) }`；`translate` 的调用点包一层 `try/catch`（catch 里 `console.error` + 一条 error 事件），绝不让桥层异常进 pi 的派发循环。

### P2-4 会话锁是分散的布尔位而不是互斥：`resourceReloading` 窗口里两个 prompt 可以同时被受理

- **位置**：`src/lib/agent-manager.ts:2790-2804`
- **证据**：

```ts
			case "prompt": {
				const text = (cmd.text ?? "").trim();
				if (!text && !cmd.images?.length) return { ok: false, error: "empty prompt" };
				// 在第一个 await 前占位，两个并发请求不能都看见 idle 后启动/误排队。
				if (m.promptSubmitting || (m.resourceReloading && !reloadTasks.has(m))) return { ok: false, error: "session is busy accepting another command" };
				if (m.resourceReloading) {
					const busy = await waitWhileReloading(m);      // ← 这里 await 了
					if (busy) return { ok: false, error: busy };
				}
				m.promptSubmitting = true;                          // ← 占位其实在 await 之后
```

注释说「在第一个 await 前占位」，但占位语句在 `waitWhileReloading` 之后。同理 `2813`（steer/followUp）、`2831`（sendQueueNow）、`3011`（editAndResend）都是先检查后 await 再占位。

- **触发路径**：同一 session 两个 POST（两个浏览器 / 手机+桌面）几乎同时发 prompt，且此刻 `m.resourceReloading === true`（正在跑 `performReload`，`reloadTasks.has(m)` 为真 → 第一道检查放行）→ 两个请求都进 `waitWhileReloading` → 重载结束后都置 `promptSubmitting = true` → 都过 `!session.isStreaming`（`2801`）→ 都调 `submitPrompt`。
- **后果**：SDK 层的表现取决于时序（一个可能被拒、可能进队列、也可能真跑两轮）。最坏情况是首轮 `agent_start` 之前两个 prompt 都进了 `deferredSettledActions`，产生「同一会话两轮串起来跑」。窗口窄（只在 reload 期间），但 `/app/api/agent/[id]/route.ts` 完全没有 per-session 串行，所以这个窗口是可达的。
- **置信度**：代码路径已确认；具体后果需运行验证（打两条并发 prompt + 同时触发 reload）。
- **建议修法**：把 `m.promptSubmitting = true` 提到第一道检查之后、任何 `await` 之前（用一个 `try/finally` 包住整段），并且在 `waitWhileReloading` 之后再复查一次 `m.promptSubmitting`/`m.runActive`；更彻底的做法是给 `execute` 加一个每 `Managed` 的 promise 链（串行化写类命令），读类命令（`clearQueue` / `setLabel`）不进链。

### P2-5 `disposeSession` 里 `void releaseSandbox()` 不 await：同路径立刻重开会话时，旧会话的释放可能拆掉新会话的沙箱 holder

- **位置**：`src/lib/agent-manager.ts:2166-2167` vs `1200`（`reopenManaged` 里 dispose 后**同步**注册新 Managed）
- **证据**：

```ts
	// 沙箱是会话级资源（工作区 Low 标签 + 私有 temp）：会话被回收就一起释放
	void releaseSandbox(m.sessionPath);      // 不 await
```

```ts
	disposeSession(m);
	const fresh = registerManaged(m.sessionPath, sm.getCwd() || m.cwd, sm);   // 同一个 sessionPath 立刻回到池里
```

`reopenManaged` 与 `syncSessionsFromDisk`（侧栏每 3 秒一次）都会走到这条「dispose 同一路径 → 立即 register」的路。
- **后果**：`releaseSandbox` 是异步的（`sandbox/manager.ts:107`），它可能在新会话已经 `sandboxFor(sessionPath, ...)` 之后才执行完，把新会话刚打好的沙箱 holder 释放掉（或删掉私有 temp 目录），下一条 bash 就会「沙箱不可用 → 拒绝执行」或写进已被删除的 TMP。
- **置信度**：疑似。`releaseSandbox` 的实现我没逐行读（归 sandbox 区域），但它按 `sessionPath` 键、与 `sandboxFor` 同键，所以这个交错是结构性的。**请在 sandbox 区域确认 `releaseSandbox` 与 `sandboxFor` 的并发语义**（见第 3 节）。
- **建议修法**：`releaseSandbox` 的 promise 挂到 Managed 上（`m.releasing`），`registerManaged` 复用时先 `await m.releasing`；或给 sandbox holder 加代际号（generation），释放时只释放自己那一代。

### P3-1 `MAX_ACTIVE` 并没有限制「同时活着的 agent 数」：有看客或忙的会话一律不淘汰

- **位置**：`src/lib/agent-manager.ts:2184-2197`
- **证据**：

```ts
	const active = [...sessions.values()].filter((m) => m.session);
	if (active.length > MAX_ACTIVE) {
		const evictable = active.filter((m) => !m.creating && !isManagedBusy(m) && !hasViewers(m)).sort(...);
		for (const m of evictable.slice(0, active.length - MAX_ACTIVE)) disposeSession(m);
```

- **后果**：20 个浏览器标签各开一个会话 = 20 个常驻 agent（每个都可能拉起 MCP 子进程、持有 sandbox）。`MAX_ACTIVE` 只在「有可淘汰的」时生效，一个都不可淘汰就一个都不淘汰。叠加 P1-1（卡死会话 `isManagedBusy` 恒真）+ `reap` 的 `hasViewers` 跳过，`sessions` 与进程句柄可以无界增长。
- **置信度**：已确认（读码）。属设计取舍，但注释写的是「活跃数上限（LRU）」，名不符实。
- **建议修法**：给「不可淘汰」的会话也留一条硬上限（例如超过 `MAX_ACTIVE * 2` 时按 `lastActive` 强行 `shutdownSession` 最旧的、只留 Managed 壳）；至少把注释改成「只淘汰空闲且无人观看的」。

### P3-2 冷会话上切模型 / 切思考档位会冷启动整个 agent（跑扩展 `session_start`、拉起 MCP）

- **位置**：`src/lib/agent-manager.ts:2904-2928`（`setModel` / `setThinkingLevel` 第一句都是 `await ensureSession(m)`）、`2975-2977`（`cycleModel`）
- **对照**：`setToolPreset`（`2935-2944`）和 `setActiveTools`（`2957-2963`）都刻意避免冷启动，注释写得很明确：「不能为了切个档位就冷启动 agent：打开会话时前端会恢复保存的档位，若这里 ensureSession，光是浏览历史会话就会跑一遍扩展的 session_start。」
- **后果**：在历史会话（未热启动）里点一下模型下拉菜单，代价是：加载该工作区全部扩展、发 `session_start`、按扩展配置拉起 MCP stdio 服务器（`1897` 的注释说明这些进程要 `session_shutdown` 才收）；用户只是改个设置。
- **置信度**：已确认（读码）。也可能是有意的：SDK 的 `setModel` 会往会话里写 `model_change` 条目，绕开 agent 就得自己复刻这条写路径。
- **建议修法**：如果只是「给下一轮选模型」，冷会话可以只记在 Managed 上（像 `toolPreset` 那样），等真正 `ensureSession` 时再 `setModel`；记忆里 `m.desiredThinkingLevel` 已经是这个模式，模型只差一个 `m.desiredModel`。

### P3-3 `writeBases` 是全局 256 条的单表，多会话并发写同一批文件时 patch 会被提前淘汰

- **位置**：`src/lib/agent-manager.ts:442`（模块级 Map）、`450-465`（`captureWriteBase`，淘汰策略 `writeBases.delete(writeBases.keys().next().value!)`）、`953`（结束时消费）
- **后果**：`write` 的 diff 是「开始时存旧内容、结束时算 patch」。超过 256 条同时未完成的 write（多会话 + codemode 批量写）时，被淘汰的那条只是丢一个 patch（写本身成功），前端退化成「全绿新增」。注释说明「只淘汰最早的一条」是为了不误伤其它会话，但总量仍会被跨会话的并发挤爆。
- **置信度**：已确认（读码）；触发需要 256 个并发 write，罕见。
- **建议修法**：改成 `Map<sessionPath, Map<toolCallId, ...>>`，按会话限额（每会话 64 条）；或在 `disposeSession` 里清掉该会话的 key（现在会残留到被淘汰）。

### P3-4 三处小的错误吞噬 / 生命周期卫生

- `src/lib/agent-manager.ts:1712-1723`：`ensureSession` 的 catch 里 `if (modelRuntime) await releaseSessionModelRuntime(modelRuntime);` 未 try——它若 reject，**原始错误会被顶掉**（后面的 `m.session = null` 与 `throw error` 都被跳过），用户看到的是凭据落盘错误而不是真正的建会话失败原因。
- `src/lib/agent-manager.ts:2636-2641`：`prepareGrowthBriefly` 的 `setTimeout(resolve, 5000)` 既没 `unref()` 也没 `clearTimeout`，每次 prompt 都让事件循环多挂最多 5 秒（同文件的其它定时器都 `unref?.()` 了）。
- `src/lib/agent-manager.ts:96` + `2619-2622`：`viewerAvailable` 全域没有任何赋值点（`grep` 只命中声明与 `hasViewers` 的读取），是死字段；留着它会让人以为「有人看」可以由外部注入。
- `src/lib/agent-manager.ts:1892-1896`：`session.dispose()` 的 catch 完全静默（`/* ignore */`），dispose 失败会导致句柄泄漏但没有任何日志。

### P3-5 冷快照每次都要重建整份工具目录

- **位置**：`src/lib/agent-manager.ts:1457-1466`（`snapshotTools` → 冷路径 `toolCatalog`）、`1395-1440`（`toolCatalog` 里对 8 个内置定义做 `create(m.cwd)`，并调 `sessionCustomTools(m)` 再构造一遍 bash 定义 + `createSandboxBashOperations`）、`1443-1455`（`coldActiveToolNames` 再读一次 `getSettingsManager`）
- **后果**：每次冷快照（打开会话、resync、缓存断档重连）都构造一遍全部工具定义（含 `createSandboxBashOperations` 与 3 个自定义工具），纯重复工作。`event-batcher` 侧的 400 条上限和 SSE 很稳，这里是服务端 CPU/分配。
- **建议修法**：按 `m` 缓存一份 catalog，用 `resourceLoaderVersion` / `m.toolPreset` 作 key 失效。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| **abort 在真正 streaming 中** | 现有唯一 abort 用例（`tests/extension-surface.test.ts:263-274`）是在**空闲**会话上跑的，`session.abort()` 立刻 resolve，P1-1 完全没被覆盖 | 让假 session 的 `abort()` 永不 resolve（或 30s 后 resolve），断言：① `execute({cmd:"abort"})` 在 ABORT 上限内返回；② 期间/之后一定有 `status{state:"aborted"}` 帧；③ 返回的 `data` 里带着被清掉的队列文本 |
| abort 清队列的文本必须回到客户端 | 现在只在「abort 正常返回」时才回传，P1-1 里永久丢失 | 断言 `clearQueue()` 的返回值出现在 response.data；再补一条「abort 超时」用例断言它仍然出现在 response.data |
| `performReload` 失败/抛异常后的状态复位 | `resourceReloading` 卡真会让会话永久判忙（P2-1），无任何用例 | 让 `session.reload()` reject、让 `applyToolPolicy` 抛（`setActiveToolsByName` 打桩 throw），断言 `m.resourceReloading === false`、后续 prompt 仍可受理 |
| `deferPublish` 微任务抛异常后的队列自愈 | P1-2 是「一次抛错永久黑洞」，没有任何用例 | 打桩让 `getAvailableThinkingLevels` throw，触发 `message_end`，断言之后 `publish` 的新事件仍进 `m.buffer` / 到达订阅者 |
| 真实 `subscribe()`（epoch / replay 断档 / pending UI 检查） | `tests/agent-events-route.test.ts` 把整个 `agent-manager` mock 掉了（`25-33`），真实实现零覆盖 | 直接测 `subscribe`：seq 越界、buffer 断档、`extension_ui` 待答复在 replay 里时必须回 `false`（`2588-2605`） |
| 同一 session 并发命令 | 没有 per-session 互斥（P2-4），route 也不串行 | 并发两个 `prompt`（其中一个在 `resourceReloading` 窗口内），断言最多一次 `session.prompt`（`agent-prompt-acceptance` 的 `104-118` 只测了无 reload 的情形） |
| `disposeSession` 与 `ensureSession` 并发（创建中回收） | `2142-2168` 有一段专门的「创建中回收」逻辑，没有用例；泄漏的是真实句柄（MCP/沙箱/订阅） | 在 `createAgentSession` 的 await 处 dispose，断言最终 `session.dispose()` 被调用、`modelRuntime` 从 `session-model-runtime` 的 `active` 表里移除（`releaseSessionModelRuntime`） |
| `reap()` / `MAX_ACTIVE` 语义 | P3-1：名字叫上限但实际不封顶 | 造 8 个有 subscriber 的会话 + 1 个忙会话，断言 `reap` 的实际行为与文档一致（无论修不修，先有基线） |
| pi 事件目录全覆盖 | `translate`（`839-1046`）对 `entry_appended` 等事件是「默认分支」，未来 SDK 加事件会静默丢 | 一个表驱动测试：把 `AgentSessionEvent` 的每个 `type` 过一遍 `translate`，断言「要么产生帧、要么被显式登记为不需要帧」 |
| `user_bash` 钩子的分档行为 | P2-2：readonly 与 workspace 的沙箱决定没有任何断言 | 断言 readonly 档 `user_bash` 也返回 sandbox operations；断言 `!` 命令不会消耗模型的 `m.escalation` |

## 3. 与其他区域的可能交叉点

- **API/鉴权区域**：`POST /api/agent/[id]`（`src/app/api/agent/[id]/route.ts:14`）`await execute(...)` 无超时、无 per-session 串行；`DELETE /api/sessions/[id]` 走 `disposeSessionPath`，同样会 `await session.abort()`。今天只要桥层的 abort 挂住，这两个路由就永久占用一个 request handler——请 API 区域确认是否要在路由层加超时/串行（我倾向在桥层修，路由层只加一个 15s 兜底）。
- **UI 区域**：`ChatInput.stopAndRestore`（`src/components/ChatInput.tsx:506`）= `restoreQueued(await onAbort())`，**停止按钮没有任何乐观反馈**，完全等 HTTP 回应；`AppShell.abortPrompt`（`744`）也不更新本地 streaming 状态。请 UI 区域确认：点停止后是否应该立刻本地置为「停止中/已停止」，而不是等服务端 `status` 帧（这能显著降低 P1-1 的用户感知严重度）。
- **sandbox/权限区域**：①`disposeSession` 的 `void releaseSandbox(sessionPath)`（`2167`）与 `sandboxFor` 同键并发，见 P2-5，请确认释放与获取的交错语义；②`consumeEscalation` 被 `bash-operations.ts:107`（模型 bash）和 `agent-manager.ts:1649`（用户 `!`）共用同一份 `m.escalation`，请确认这是期望语义；③readonly 档 `user_bash` 是否也该装沙箱（P2-2）由你们定。
- **automations 区域**：`runner.ts:193-243` 用 `observeManagedEvents` 等 `status{state:"idle"|"aborted"}` 判定一轮结束。P1-1 一旦发生，`aborted` 帧永远不来，automation 只能靠自己的 `timeoutMs` 收场，而且那个会话不会被回收（`disposeSession` 之后 abort 仍挂）。另外 automation 的 `createNewSession` 不设档位，会话会停在 `registerManaged` 的默认 `readonly`（`1256`）——请确认这是有意的安全默认。
- **models 区域**：`refreshSessionModels`（`2325-2337`）直接改 `session.agent.state.model`，而 `execute({cmd:"setModel"})` 走 `session.setModel` 并 `publishModelState`；两者并发时后者可能被前者覆盖（反之亦然），且 `usageCache.delete` 只在 `2329`/`2913` 两处做。请 models 区域确认是否需要一把按会话的模型切换锁。
- **remote 区域**：`src/lib/remote/supervisor.ts` 没有直接 import `agent-manager`（grep 全仓只有 21 个 import 点，不含 supervisor），走的是 HTTP。那么隧道断开时 abort 请求可能根本没送达，本机会话会继续跑——请确认 remote 侧有没有「连接断开即取消」的兜底。
- **session-reader / 侧栏**：`syncSessionsFromDisk`（`1216-1224`；由侧栏拉会话列表时调，`session-reader.ts:264`，客户端约 3 秒一次）会 `reopenManaged`：dispose 旧 Managed（订阅者收到 `disposed` 状态帧、SSE 关闭）+ 用新 epoch 重开。此时若有 in-flight `execute`，它拿到的是已 `disposed` 的 `m`，会返回 500/ok:false。请 API 区域确认这个「终端 pi 同时在写同一会话」的竞态在 UI 上是否可接受。

## 4. 建议优先修的 3 件事

1. **P1-1：给 abort 加超时兜底与强制收工路径**。`case "abort"` / `disposeSessionPath` / 扩展 `abortHandler` 全部改成 `Promise.race([session.abort(), timeout])`，**无论等到没等到都先发状态帧、先返回清出的队列文本**；超时后落一个标记，让 `reap`/`isManagedBusy` 能在 N 分钟后走现成的 `shutdownSession()`（内部已有 5 秒上限 + `session.dispose()`）把会话强拆。这是唯一一条会让会话「永久不可用、只能重启服务」的路径，且生产已复现。
2. **P1-2：`deferPublish` 的微任务必须 try/catch/finally**，保证 `entry.events` 一定被赋值、`flushPublishes` 一定被调用——一个回调抛异常不该让整份会话的事件流永久静默。顺带给 `publishImmediate` 的 `JSON.stringify` 与 `translate` 的订阅入口加异常边界（P2-3），别让桥层异常穿进 pi 的同步派发循环。
3. **P2-1：`performReload` 的 `finally` 里先复位 `m.resourceReloading`/`reloadTasks`，再 `try { applyToolPolicy }`**——同文件已经有两处这样写了，就差这一处；否则一次本地异常就能复刻 P1-1 的锁死面。
