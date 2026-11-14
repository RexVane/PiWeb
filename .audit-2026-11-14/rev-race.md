# 并发正确性审查（相对 HEAD `1d4efba`，仅静态）

范围：未提交工作区里点名的锁、会话、调度、吊销路径。不跑测试，不改其它文件。无第二进程/SDK 源码处的推断标 QUESTION。行号对应当前工作区。

## 发现

### [CRITICAL] src/lib/web-secret.ts:203 与 src/proxy.ts:45-46
**问题**：`revokeAllSessions` 把 `notBefore` 采样在落盘之前；等待原子替换的间隙里签发的 Cookie，`issuedAt >= notBefore`，全局登出盖不住。
**触发条件**：
1. 请求 A 进入 `updateSessionRevocations`，已持有 `web-revocations.json` 的 proper-lockfile，同步算出 `cutoff = Date.now() + 1`（`web-secret.ts:203`）。
2. A 在 `writeSessionRevocations` 里 `await replaceFileAtomically`（`web-secret.ts:172`，`atomic-file.ts:10`）。`fs.promises.rename` 让出事件循环；若 Windows 返回 `EPERM/EBUSY/EACCES`，`atomic-file.ts:13-14` 还会最多再等约 1 秒，旧文件一直可见。
3. 请求 B 整段同步跑完 `proxy`：`loadSessionRevocations()` 读到旧的 `notBefore`，`consumeLaunchToken` 仍接受当前启动令牌（内存里的 cutoff 还没抬高），`createSessionCookie(..., Date.now())` 写下 `issuedAt`。
4. A 的 rename 随后提交。校验是 `issuedAt < revocations.notBefore`（`web-auth.ts:123`）。B 的 `issuedAt` 晚于第 1 步的 `cutoff`，Cookie 继续有效。`invalidateLaunchTokens` 要等 `revokeAllSessions()` resolve 之后才跑（`src/app/api/web-auth/route.ts:74`），管不到这张已经发出的 Cookie。
**期望行为**：提交「让所有设备重新登录」时，提交完成前已签发的 Cookie 全部失效。
**实际行为**：旧吊销文件仍可见的那段时间里换到的 Cookie 比写进文件的 `notBefore` 更新，之后每条请求都放行。
**证据**：cutoff 在回调开头就固定；写盘是其后的第一个 `await`。`proxy` 在 `consumeLaunchToken` 与 `createSessionCookie` 之间没有 `await`，但整个 `proxy()` 可以插在别人的 `await` 里。成功路径一次 rename 的回调就足够跨过 1ms，不必依赖 EPERM。
**修复建议**：进入吊销回调、任何 `await` 之前，先在进程内记下 `revokedThrough = Date.now()`（或 `Infinity` 直到发布完成），`validSessionCookie` / `consumeLaunchToken` 同时看这个值；文件里的 `notBefore` 用发布完成后的时间再写一次。签发与抬升必须用同一把同步判断，不能只靠「写之前的 now+1」。
**最小失败测试**：挂起 `fs.promises.rename` 一次；挂起期间用仍有效的启动令牌 `GET /?token=`；放行 rename；断言该 Cookie 被 `validSessionCookie(..., loadSessionRevocations())` 拒绝。

### [HIGH] scripts/file-lock.mjs:4-27
**问题**：Windows 上 `wx` 只在创建瞬间排他，句柄立刻关掉。崩溃后的残留要么永远收不回，要么 PID 复用后被当成活主。`.recovery` 目录能挡住两个回收者，崩溃留在磁盘上就会把回收本身卡死。
**触发条件**：
- 不完整文件：`create()`（12-15 行）在 `openSync(wx)` 成功后、`writeFileSync`/`fsync` 完成前进程被杀死。下次竞争者 `EEXIST`，`mkdir .recovery` 成功，`JSON.parse` 失败，23 行抛 `lock is incomplete` 且不 `unlink`。`finally` 只删 `.recovery`。之后每次都走同一条，锁文件还在。
- 回收目录残留：19 行 `mkdirSync(recovery)` 成功后、27 行 `rmdirSync` 前被杀死。下次任何人 `mkdir` 失败（20 行 `catch` 不区分 `EEXIST`），直接报 already running。此时即便锁文件里的 pid 已死，也进不了 21-26 行的回收。
- PID 复用：正常崩溃留下完整 JSON。`startedAt` 写了但 24 行不用。`processAlive`（4-6 行）只 `process.kill(pid, 0)`。Windows 把该 pid 分给无关进程后返回成功，`!== false`，锁一直被当成活的。`EPERM` 同样当成活（6 行）。
**期望行为**：持有者已死、且没有活着的 child pid 时，下一次 `acquireFileLock` 能收回锁；回收互斥自身崩溃不能永久占锁。
**实际行为**：上述三种残留都会让后续启动/构建一直失败，直到人工删文件。两个同时走 `EEXIST` 分支的回收者：`mkdir` 是原子的，第二个进不了临界区，这一点成立。
**证据**：锁的实现没有 `LockFileEx`，也没有把 `startedAt` 和进程创建时间比较。20 行把 `.recovery` 的任何 `mkdir` 失败都当成「有实例在跑」。
**修复建议**：用未关闭的独占句柄或 Windows 命名互斥量表示持有；回收目录也要有过期/所有者，不能只靠目录在不在。不完整 JSON 在确认没有活句柄后应可回收。比对 pid 时同时比对进程启动时间。
**最小失败测试**：`wx` 创建后写入前杀掉进程，断言下次 acquire 要么收回要么在有限次后不再抛 incomplete。另：持有 `.recovery` 时杀掉，断言死掉的锁主不会让 acquire 永远 already running。

### [HIGH] scripts/file-lock.mjs:21-26 与 33-51；scripts/launcher.mjs:532-535
**问题**：回收者按一次读到的 pid/children 决定 `unlink`，期间子进程用 `writeFileSync`（默认 `'w'`，不持有 `wx` 句柄）写回的 child pid 会被一起删掉。父进程在 `childStarted` 写盘之前死亡时，文件里根本没有那个活着的子进程。
**触发条件**：
1. 启动器已 `spawn` 出服务进程（`launcher.mjs:532`），尚未执行 `childStarted`（535 行）；或者构建子进程已 `readFileSync` 到 `children: []`（`trackLockChild` 48-51 行 / `childStarted` 33-37 行），父 pid 已经死。
2. 回收者 B：`mkdir .recovery` 成功，读到父 pid 已死且 `children` 为空，通过 24 行，停在 `unlinkSync` 之前。
3. 子进程 `writeFileSync` 把自身 pid 写进锁文件（默认截断写，不是 `wx`，写完即关句柄）。
4. B `unlinkSync` 删掉的是已经含有活 child 的文件，然后 `create()` 得到自己的 token。B 与那个子进程同时认为自己可以运行。
快路径补充（不构成两个成功返回）：B 在 `unlink` 之后、自己的 `create()` 之前，C 的第一次 `openSync(wx)` 可以成功。B 的第二次 `create()` 抛裸 `EEXIST`（17 行只接住第一次）。C 是唯一拿到 `release` 的人。`.recovery` 盖不住这段，因为快路径不进回收目录。`launcher.mjs:596` 只在 `error.owner` 存在时去附着已有实例，裸 `EEXIST` 会直接失败，但不会两个都跑起来。
`release()`（29-31 行）也是「读到 token 相符再 `unlink`」，中间不复核 inode。持有者仍存活且 `processAlive` 正确时，另一进程进不了 24 行，不能在这两次 syscall 之间换上一份新锁；能证明的偷锁是上面第 2–4 步，不是活主自己的 `release()`。
**期望行为**：锁文件里出现过的、仍存活的 child pid，回收者不能拿走锁；`spawn` 成功到 pid 落盘之间崩溃，也不能开出第二个实例。
**实际行为**：回收者 unlink 的是路径而不是当时读到的那一版内容。活着的服务/构建子进程之外可以再 acquire 成功。
**证据**：24 行只看当时解析出的数组；37/42/51 行 `writeFileSync` 没有 `'wx'`，也没有保持 `create()` 里那个句柄。启动器把 `childStarted` 放在 `spawn` 返回之后。
**修复建议**：pid 用单独的 append-only 记录，或在持有独占句柄时更新；`unlink` 前按 inode/`token` 再读一次，对不上就放弃。`spawn` 与写 child pid 之间用 Job Object / 父死子亡，避免靠事后补写。
**最小失败测试**：父进程写完锁并 spawn 子进程后、`childStarted` 前冻结父进程并杀掉；子进程保持存活；第二个 `acquireFileLock` 必须失败。变体：子进程卡在 `trackLockChild` 的 read 与 write 之间，回收者已读到空 `children`，断言 write 之后回收者不会 unlink 成功。

### [HIGH] src/lib/agent-manager.ts:1241-1242 与 1750-1778、2268、2284、1177-1183
**问题**：`disposeSession` / `reopenManaged` 把会话从 Map 里删掉并异步 `shutdownSession`，不等旧 `AgentSession` 结束就允许同一 JSONL 再 `open` 一次。
**触发条件**：
- 重开：`reopenManaged` 同步调用 `disposeSession`（1241，内部 2268 行 `void shutdownSession`，2284 行 `sessions.delete`），紧接着 1242 行 `registerManaged` → `openSessionManager` 同一路径。旧会话的 shutdown 还排在微任务里。
- 热启动中途释放：A 已执行到 `m.session = session`（1750）并停在 `await session.bindExtensions`（1762）。B 调用 `disposeSession`：`disposed = true`，`sessions.delete`。C 的 `getManaged` 看到 Map 未命中（1178-1183），新建第二份 `SessionManager` 并可以再 `ensureSession`。A 的 `bindExtensions` 返回后才在 1778 行发现 `disposed` 并 shutdown。重叠窗口是整段 `bindExtensions` 加上未 await 的 shutdown。
**期望行为**：同一会话文件在旧运行时 shutdown/dispose 完成前，不能再挂上一份会写 JSONL 的管理对象。`disposeSession` 自己的注释写了要避免「同一 JSONL 双活跃会话」。
**实际行为**：Map 的空缺和异步 shutdown 重叠，两份 `SessionManager`/`AgentSession` 会同时碰同一个文件。
**证据**：2268 行故意不 await；1242 与 1177-1183 在 delete 之后立即注册。1778 的检查只能停掉 A，撤不回已经注册的 C。
**修复建议**：按路径保留「正在关闭」的 promise，`getManaged`/`registerManaged` 必须先等到它完成；`reopenManaged` 改为 await `disposeSessionPath` 里那条会等待 shutdown 的路径，不要调用不等待的 `disposeSession`。
**最小失败测试**：在 `bindExtensions` 里挂起；另一调用 `disposeSession` 后立刻 `getManaged` 同一路径并 `ensureSession`；断言挂起结束前第二个 `createAgentSession` 没有开始。

### [HIGH] src/lib/jsonc-settings-storage.ts:63-67 与 src/lib/pi-settings.ts:205-231
**问题**：两个会话同时写同一份 `settings.json` 时，异步持锁方和 SDK 的 `lockSync` 会把其中一次更新丢掉。跨进程时 proper-lockfile 在判定过期后直接 `rmdir`，不复核 mtime，两个进程会一起写。
**触发条件**：
- 同进程丢更新：会话 A 走 `patchPiSettings` → `withExternalSettingsLock`（`settings-write-lock.ts:25-32`）已经 `mkdir` 了 `settings.json.lock`，并停在 `await replaceFileAtomically`（`pi-settings.ts:231`）。会话 B 的 `SettingsManager` 走 `JsoncSettingsStorage.withLock` → `lockSync`（`jsonc-settings-storage.ts:65`）。B 遇到 `ELOCKED` 后 `Atomics.wait` 20ms，最多 10 次（66 行 `attempt >= 9`）然后抛错。等待期间事件循环被堵住，A 的 `await` 无法恢复，也没法解锁。B 放弃后 SDK 把错误收进 `drainErrors`（`settings-write-lock.ts:36-44` 的注释），A 再把自己的内容 rename 上去。B 改的字段不在文件里。
- 跨进程偷锁：A 的事件循环超过 stale（proper-lockfile 默认 10s，且 `update` 定时器跑不到）后，B `stat` 认为锁目录过期（`node_modules/proper-lockfile/lib/lockfile.js:56-79`）。A 若刚好 `utimes` 续期，B 仍调用 `removeLock` → `rmdir`（88-96 行），没有第二次核对 mtime。B 重新 `mkdir` 成功。A、B 同时写 `settings.json` 或 `models.json`（`models-service.ts:1601` 与 `1648` 用的是同一把 `.lock`）。
**期望行为**：两路写同一设置文件串行，且两次修改都落在最终文件里；过期回收不得删掉刚刚续期的锁。
**实际行为**：B 的同步锁约 180ms 后失败并可能被 SDK 吞掉；跨进程则两份写都以为自己持锁。
**证据**：`withLock` 只重试 `ELOCKED`，等待用 `Atomics.wait` 阻塞唯一的线程。`patchPiSettings` 的临界区含 `await`。proper-lockfile 的 `removeLock` 只 `rmdir`。`models.json` 的同进程路径有 `withSettingsWriteLock` 队列，不会走这个 `lockSync`；跨进程偷锁对它同样成立。
**修复建议**：SDK 存储与 `patchPiSettings` 共用 `withSettingsWriteLock` 的进程内队列，并且不要在持有异步锁时用会阻塞事件循环的 `lockSync`。过期删除前用「mtime + 随机内容」再核对一次，对不上就不要 `rmdir`。
**最小失败测试**：A 持锁并让 rename 挂起超过 300ms；B 在同一进程调用 `JsoncSettingsStorage.withLock` 改另一个字段；断言 B 的字段在 A 提交后仍在文件中，且 B 不抛错。

### [MEDIUM] src/lib/models-service.ts:1574-1576 与 src/lib/workspace-store.ts:177
**问题**：Windows 上对仍被打开的目标 `rename` 会 `EPERM`。这两处不重试；models 的修订号检查和 `rename` 之间还有一段 `await`，非协作写者会把更新塞进来再被覆盖。
**触发条件**：
- `EPERM`：会话 A `readFile` 仍握着 `models.json` 或工作区注册表（或杀软不带 `FILE_SHARE_DELETE` 打开）。会话 B 已通过修订号检查（models 1575）或已写好临时文件（workspace 176），`rename` 失败。B 抛错，`finally` 删掉临时文件，旧文件还在，这次保存丢失。`atomic-file.ts` 的重试没有用在这两处。
- 覆盖非协作写者：B 在 1575 行读到修订号仍等于进入临界区时的值，`await` 让出后，不拿 `models.json.lock` 的写者（手改或 SDK 直接写）换了内容；B 的 `rename` 把那份内容盖掉。锁只挡同样走 `withExternalSettingsLock` 的人。
**期望行为**：共享冲突时重试且不丢旧文件；修订号不符则放弃替换。非协作写入不能在检查通过后、替换前被无声覆盖。
**实际行为**：`EPERM` 使这次保存失败（旧字节还在，不是半截文件）。检查与替换不是一个原子操作，后到的非协作内容会被 B 覆盖。
**证据**：1576、177 行是裸 `fs.rename`。1575 与 1576 之间没有再次开独占句柄。对照 `jsonc-settings-storage.ts:90-92` 与 `atomic-file.ts:8-14` 才有有限次 `EPERM` 重试。
**修复建议**：两处都走 `replaceFileAtomically`。替换时用「期望的 inode/修订号」做失败即停的交换，而不是先读再 `await` 再 `rename`。
**最小失败测试**：用一个不共享删除的句柄打开 `models.json`；并发 `writeCustomProviders`；断言函数失败且原文件字节不变。再：检查通过后、rename 前改文件；断言抛 `CustomProvidersConflictError` 且新字节仍在。

### [MEDIUM] src/lib/agent-manager.ts:2044-2046 与 3042-3050
**问题**：`claimSubmission` 不把 `bashActive` 算忙，普通 prompt 可以在 `!` 命令仍在跑时进入 `session.prompt`。
**触发条件**：
1. 请求 A 走 `bash`：3047 行同步设 `m.bashActive = true`，停在 `await ensureSession`（3050）。
2. 请求 B 走 `prompt`：`claimSubmission` 只看 `promptSubmitting/commandRunning/stopping/stopFailed/resourceReloading`（2045），看不到 `bashActive`，于是把 `promptSubmitting` 设为 true 并继续 `submitPrompt`。
3. `isManagedBusy`（1807 行）把 `bashActive` 当忙，但这条不在领取入口上。B 的稍后检查只拒绝 `isStreaming || runActive`（prompt 分支），不拒绝 bash。
**期望行为**：与 `isManagedBusy` 一致，shell 未结束时不再受理会启动模型回合的 prompt。
**实际行为**：同一 `Managed` 上 bash 与 prompt 并行。
**证据**：2045 与 1807 的条件集合不一致；3046 行的注释只保证两个 bash 互斥。
**修复建议**：`claimSubmission` 在置位前拒绝 `bashActive`（以及仍需要挡住的 `runActive`，如果产品语义是「忙则拒绝」）。
**最小失败测试**：`bash` 停在 `ensureSession`；并发 `prompt`；断言 prompt 返回 busy，且 `session.prompt` 未被调用。

### [MEDIUM] src/lib/automations/store.ts:56-67 与 src/lib/automations/runner.ts:303-315、428-446
**问题**：同进程里调度器与手动触发不会叠跑。另一进程在心跳租约（5 分钟）过期后仍会再开一轮，而前一轮的 30 分钟超时还没到。
**触发条件**：
- 同进程不双跑（对照，不构成缺陷）：`launchAutomationTask` 在 `await retryPendingFinishes` 之后同步检查并 `activeTaskIds.add`（runner.ts:303-309），然后才 `await recordRunStarted`。第二个调用看到 Set。`recordRunStarted`（store.ts:461-462）在文件锁里拒绝已有活运行。`claimDueTasks` 把 `nextRunAt` 推后的同时，手动运行若已写入 `startedAt >= 旧的 nextRunAt`，`releaseAutomationClaim`（store.ts:499）不会把到点时间拨回去。
- 跨进程双跑：进程 A 已 `recordRunStarted`，回合仍在 `runPromptAndAwaitSettlement`（超时 30 分钟，runner.ts:24、371）。心跳写盘连续失败超过 `OWNER_LEASE_MS`（5 分钟，store.ts:22、60）。进程 B 的 `activeTaskIds` 没有这个 id。B 的 `hasLiveRunOwner` 因心跳过期返回 false（60 行在 `process.kill` 之前）。B 的手动 `runAutomationNow` 或下一次 `claimDueTasks`+`launchAutomationTask` 再写入一条 `running` 并再开会话。A 仍在执行。
**期望行为**：同一任务在前一轮真正结束或进程消失之前不能第二轮。
**实际行为**：同进程被 Set + 文件锁挡住。心跳停更 5 分钟后，另一个进程会把仍在跑的任务再启动一次。
**证据**：60 行把「没有新鲜 heartbeat」定义成不活；runner 的超时是 30 分钟，心跳间隔 5 秒（runner.ts:329-336），写失败只打日志（334 行），不延长租约，也不挡 `activeTaskIds` 以外的进程。
**修复建议**：租约至少盖住运行超时；心跳失败时保留「本进程 activeTaskIds + 上次成功心跳」并拒绝第二轮，而不是把对方标成死的。实例锁若没挡住第二个进程，这条就会发生（见上面的 file-lock）。
**最小失败测试**：两个 store 路径相同的运行时；A 的 run 为 running 且 `heartbeatAt` 老于 5 分钟、pid 仍存在；B 调用 `runAutomationNow`；断言抛冲突。现在会成功再开一轮。

### [MEDIUM] src/lib/web-launch-token.ts:174 与 181-184
**问题**：退出钩子先读令牌文件再 `unlink`，中间被另一次 `writeFileSync` 换掉内容后，会删掉新进程刚发布的令牌。轮换定时器与 `consumeLaunchToken` 在同一线程且都同步，没有「定时器已换内存令牌、consume 仍接受旧令牌」的交错。
**触发条件**：
1. 进程 A 的 `exit` 钩子 `readFileSync` 看到文件内容仍是 A 的当前令牌（183 行条件为真），还没 `unlink`。
2. 进程 B `publishLaunchToken` 用默认 `'w'` 把 B 的令牌写入同一路径（174 行，不是 `wx`）。
3. A `unlinkSync` 把 B 的文件删掉。B 内存里仍有令牌，磁盘上没有。再次启动的启动器读不到登录链接。
同进程的 `setInterval`（159-167 行）与 `consumeLaunchToken`（30-43 行）都是同步函数，事件循环不会在它们内部切换；consume 比较的是内存 Map，定时器先 `tokens.set` 再写盘。这条不破「旧令牌只能用一次」。
**期望行为**：退出只删除仍属于自己那一版的文件（比对本进程写完后的代际/inode），不能删掉后写者。
**实际行为**：检查和 `unlink` 之间路径可以被覆盖，unlink 按路径删。
**证据**：183 行是读比较，184 行无条件 `unlinkSync` 该路径。174 行没有排他创建。
**修复建议**：发布时 `wx` 到临时名再替换，并在文件里写 pid+代际；退出时用目录项的 inode/代际再核对一次，不符则不删。
**最小失败测试**：A 在 exit 钩子读完后挂起；B `publishLaunchToken`；A 继续 unlink；断言 B 的令牌文件仍在且内容是 B。

### [QUESTION] src/lib/agent-manager.ts:1926-1957
**问题**：`guardedTools` 这个 WeakSet 若碰到跨会话共享的 tool 对象，第二份会话不会再包一层，执行闭包仍是第一份 `Managed` 的权限与升权。
**触发条件**：需要 `session.agent.state.tools` 里的对象在两个 `AgentSession` 之间是同一个引用。那样会话 B `guardToolExecution` 在 1930 行 `continue`，B 的调用走进 A 的 `m.toolPreset` / `m.escalation`。
**期望行为**：每个会话的执行包装只读自己的 `Managed`。
**实际行为**：未证实。注释（1927-1928）说包装的是 per-session 对象，共享的是工厂定义；本 diff 没有把 `state.tools` 从共享定义复制出来，也没有 SDK 赋值处的证据。
**证据**：1930-1957 行闭包捕获的是调用 `guardToolExecution` 时的那个 `m`，并且用 WeakSet 跳过已包装对象。
**修复建议**：确认 SDK 每会话一份 tool 对象后再保持现状；否则按会话 WeakMap 包装，不要用全局 WeakSet 跳过。
**最小失败测试**：两个会话取到同一个 `tool` 引用时，B 的 readonly 不能执行 A 的 workspace 允许的写。缺 SDK 是否共享该对象的证据，现在不能判失败。

## 覆盖

| 目标 | 结论 |
| --- | --- |
| `scripts/file-lock.mjs` | 见 CRITICAL 之外的两条 HIGH。`mkdir .recovery` 能挡住两个回收者，挡不住 unlink 之后的快路径；快路径不会让两个 acquire 都成功返回。 |
| `src/lib/atomic-file.ts` | 重试 `EPERM` 会保留旧文件，但把吊销提交的事件循环窗口拉长。自身不是第二个所有者。 |
| `src/lib/settings-write-lock.ts`（HEAD 已有，未改） | 进程内队列按路径串行；盖不住 `lockSync`+`Atomics.wait`，也盖不住 proper-lockfile 的过期 `rmdir`。 |
| `src/lib/session-disk-sync.ts` | 全文读过。同一次 `check` 里用开头的 stat 收尾，文件在读的过程中变长会留到下一次；同尺寸替换会被 `rewritten`/`sampleChanged` 标成外部变更。没有证明会永久漏掉一次外部写入。 |
| `src/lib/workspace-store.ts` | 写路径有进程内队列 + 外部锁。`lastGood` 只在本进程、且损坏恢复发生在持锁读失败之后。裸 `rename` 见 MEDIUM。 |
| `src/lib/automations/schedule.ts` | 纯函数，无共享可变状态。 |
| `src/lib/automations/store.ts` + `runner.ts` | 同进程调度器与手动触发见 MEDIUM 的反面结论；跨进程租约见 MEDIUM。 |
| `src/lib/jsonc-settings-storage.ts` | 见 settings HIGH。文件尚不存在时会在加锁后重读并再次调用 `fn`，第二次结果才落盘，不构成双写。 |
| `src/lib/web-devices.ts` | 同一设备的 `seen` 置位在 `await` 之前，进程内不会双写。列表在 `flush` 之后读，替换是 rename。未证明撕裂读。 |
| `src/lib/web-launch-token.ts` 轮换定时器 vs `consume` | 同线程同步，无中途交错。见退出钩子 MEDIUM。IPC（107-112 行）在 `notBefore` 已变时仍把新令牌回给旧令牌持有者；`invalidateLaunchTokens` 紧跟在吊销的 microtask 后面，没证明客户端能在 invalidate 之前用这枚新令牌换到 Cookie，因此不单列。 |
| `src/lib/sandbox/manager.ts` + `bash-operations.ts:124-131` | `releaseSandbox` 先加 generation 再摘 Map。创建中的沙箱对不上 generation 会 `dispose` 并返回 null。`exec` 开头看 `disposed`。没有证明释放之后还能启动一条未受隔离的命令。 |
| `src/lib/agent-manager.ts` 并发 prompt | 两个 `prompt`/`steer`/`sendQueueNow` 由 `claimSubmission` 在第一个 `await` 前占位挡住。没有证明两个 prompt 能同时过领取。bash 与 prompt 见 MEDIUM。一次性升权的 `clearEscalation` 在包装函数的同步段里，两路 `await` 都返回后也不会双花同一次 grant。 |

## 未追踪

1. `agent-manager.ts` 里与锁、prompt 领取、dispose/reopen、sandbox、冷路径 `setModel` 无关的 diff（快照分页、导出 HTML、工具目录缓存、growth 计时器）。
2. `src/lib/sandbox/windows-acl.ts` 里 spawn、Job Object、ACE 标志位的正确性；只追了 `dispose` 与 `grantRoot` 的互斥量顺序。每个沙箱有自己的 AppContainer SID，释放时 `REVOKE_ACCESS` 按该 SID 删，没有证明会拆掉另一会话的 ACE。
3. `models-service.ts` 在 `writeCustomProviders` / `setModelContextWindow` 之外的目录刷新、OAuth 写回是否绕过 `models.json.lock`。
4. `scripts/launcher.mjs`、`scripts/release.mjs`、`scripts/install-build.mjs` 里除锁的 acquire/release/`childStarted` 调用点以外的流程。`install-build` 的子进程是 `spawnSync`，父进程在子进程退出前不会 `release()`。
5. `session-disk-sync.ts` 在「中间被改、同时追加、且 head/tail 4KiB 样本碰巧不变」时会不会漏报；代码只比较头尾样本，没有现成交错能证明漏报会留下来。
6. `scripts/web-auth-protocol.mjs` 的签名与 `sessionId` 编码；Cookie 竞态只追到签发时刻与 `notBefore` 比较。

## 维度结论

- Windows `wx` 锁：排他只在创建时；句柄马上关闭。崩溃残留（半截 JSON、`.recovery` 目录、pid 复用）会永久占锁。
- `.recovery`：能挡住两个回收者，不能挡住 `unlink` 与下一次 `wx` 之间的快路径。快路径不会产生两个成功的持有者。
- token 检查后 `unlink`：`file-lock` 的 `release()` 在持有者仍被 `processAlive` 视为活着时，偷不走另一份新锁。能偷走活子进程的是「按旧 children 决定后再 unlink」，以及 `childStarted` 之前父进程已死。启动令牌退出钩子是同一形状，并且另一进程可以 `writeFile` 插进来。
- `writeFile` 不持句柄：`childStarted` / `updateMetadata` / `trackLockChild` 用默认 `'w'` 截断锁文件，不继承 `wx` 句柄。
- 原子替换 `EPERM`：重试实现不会把旧文件换成半截；不重试的 models/工作区注册表会丢掉这一次保存。吊销文件的重试会把 CRITICAL 的签发窗口拉长。
- 两个会话写 settings：会丢其中一次，或在锁过期后同时写。同进程写 `models.json` 有队列；跨进程与裸 `rename` 见 HIGH/MEDIUM。
- 撤销 `notBefore` 与正在签发的 Cookie：CRITICAL。采样在 `await` 之前，比较又是严格小于。
- 轮换定时器与 `consume`：同线程无此竞态。
- 调度器与手动触发：同进程不会双跑；心跳租约过期后另一进程会双跑。
- sandbox `release`：generation 会作废正在创建的实例；没证明释放后命令仍能跑。
