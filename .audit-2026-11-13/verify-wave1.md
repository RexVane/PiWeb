# 第一波审计结论 对抗式复核报告（verify-wave1）

复核人：verify-wave1　时间：2026-11-13 19:10–19:40　对象：`.audit-2026-11-13/{bridge,bridge-tools,sandbox,api-auth,chat-ui,models,sessions-workspaces,files-viewer,git-project}.md`
基线：HEAD `1d4efba` + 未提交改动，**按当前磁盘状态**核对。只读：未改任何源码/测试/配置，未装依赖，未重启或杀服务；只做了 `read`/`grep`/只读 `pwsh`（`icacls`、进程表）、`node -e` 纯计算复刻、以及本机只读 `GET`。

## 0. 复核范围与方法

- **行号漂移**：一律按代码内容定位，报告里的行号只作线索。复核中确认两个文件又变长了（`agent-manager.ts` 3136 行、`sandbox/manager.ts` 127 行），报告引用的行号与当前磁盘**基本一致**（差 ≤2 行），没有出现"引用的代码已经不存在"的情况。
- **判定口径**：
  - `成立`＝机制与影响都如报告所述（触发条件可能仍依赖运行）；
  - `夸大`＝机制在，但影响/严重度被放大，应降级；
  - `不成立`＝代码不是那样，给出反证；
  - `部分成立`＝主干成立、局部事实或归因有错（会在备注里写清哪一段错）。
- **复核了 31 条**：P0 2 条（全部，其中 2 条 lead 已独立确认）、**P1 16 条（九份报告里的 P1 全部，逐条核）**、"会丢数据/越权"的 P2 12 条（api-auth 的 P2-1/P2-2/P2-4/P2-5、bridge 的 P2-1/P2-2/P2-4/P2-5、bridge-tools 的 P2-3、sandbox 的 P2-1/P2-2/P2-4），外加顺带核到 1 条 P3 事实错误（`GetLastError` 时序）。
- **额外做了两件报告没做的事**：(1) 复刻本机**磁盘现状**（`icacls` 四个注册工作区 + `web-sandbox` 私有目录 + 进程表），发现沙箱 Low 标签已经跨进程残留（见 V1-漏-1）；(2) 主动构造了 `file:` 之外的三种同级绕过写法（`/c/…`、`/mnt/c/…`、`/cygdrive/c/…`）去攻 P0-1，结果**攻不破**（闸门与 pi 都判区外），反过来加固了 P0-1 的可信度。

**结论计数（31 条）**：成立 **27**、夸大 **2**、不成立 **1**、部分不成立（归因错）**1**。另附 5 条漏报、9 条必须运行验证项。

## 1. 核对表

### 1.1 `sandbox.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 1 | P0-1 `file://` 绕过写入闸门 | P0 | **成立（lead 已确认）** | `src/lib/permission-gate.ts:53` `return path.resolve(cwd, expanded);`（整段 `:43-54` 不认 URL scheme）vs `pi …/dist/utils/paths.js:119-120` `if (/^file:\/\//.test(normalized)) { return fileURLToPath(normalized); }`；`pi …/dist/core/tools/write.js:31` `const absolutePath = resolveToCwd(path, ctx?.cwd \|\| cwd);` | 我用 node 复刻：`file:///C:/Users/guica/.ssh/authorized_keys` → 闸门目标 `D:\AIApp\PiWeb\file:\C:\Users\…`、`inside=true`；pi 侧 `C:\Users\guica\.ssh\authorized_keys`。**另外我试了 `/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 三种同级写法：闸门都判区外（两者一致拒绝），所以这条只有 `file:` 一个口子**，报告建议的修法（别名对齐 + 拒绝 `file:`/`\\.\`/`\\?\`/`\\`）方向正确、够用 |
| 2 | P0-2 readonly 档不是零写入（Low 标签属磁盘） | P0 | **成立（lead 已确认）；触发条件已逐条核对** | 缓存 key 含 mode `src/lib/sandbox/manager.ts:67-68` `return \`${sessionPath}\u0000${mode}\`;`；切档不释放 `src/lib/agent-manager.ts:2948-2951` `m.toolPreset = preset; m.customActiveTools = undefined; clearEscalation(m); applyToolPolicy(m, session);`；释放唯一入口 `src/lib/agent-manager.ts:2167` `void releaseSandbox(m.sessionPath);`（`grep releaseSandbox` 全仓只有 `:59` 导入与 `:2167` 调用） | **适用范围（精确版）**：需要 `(a)` 同一 `sessionPath` 的 workspace 沙箱仍活在本进程 `holders` 里（未 `disposeSession`）**或** `(b)` 磁盘上仍留着上一轮没被 `markMedium` 的 Low 标签。`(b)` 在本机已经成立——见 V1-漏-1。不成立的场景只有一个：**全新进程 + 该目录从未跑过 workspace 档 bash** |
| 3 | P1-1 readonly 里 `!` 命令无沙箱 | P1 | **成立** | `src/lib/agent-manager.ts:1651` `api.on("user_bash", () => (m.toolPreset === "workspace" ? { operations: userBashOperations } : undefined));`；回落 `pi …/dist/core/agent-session.js:3268` `options?.operations ?? createLocalBashOperations({ shellPath })` | 是否升级成 P0 取决于 `POST /api/agent/[id] {cmd:"bash"}` 的鉴权——api-auth 区结论是"没有未鉴权路由"，所以维持 P1 |
| 4 | P1-2 工作区整棵标 Low（工作区=主目录时 `~/.ssh` 对 Low 世界开放） | P1 | **成立** | `src/lib/sandbox/windows-acl.ts:98` `await run("icacls", [dir, "/setintegritylevel", "(OI)(CI)Low"], …);`；工作区来源无黑名单 `src/lib/path-security.ts:63-73`（只 `realpath` + `isDirectory`） | 本机注册表（`~/.pi/agent/web-workspaces.json`）现存 `C:\Users\guica\Desktop`、`D:\AIApp`、`D:\AIApp\harness`、`D:\AIApp\PiWeb`，`removedWorkspaces` 里确实有 `C:\Users\guica`——报告的举例是真的。**而且这四个目录此刻都还挂着 Low 标签**（V1-漏-1） |
| 5 | P1-3 `%LOCALAPPDATA%Low` 永远可写 | P1 | **成立（ACL 已实测）** | `src/lib/sandbox/bash-operations.ts:112` `const extraRoots = mode === "workspace" ? (await readSandboxConfig()).additionalWritableRoots : [];`（readonly 不给任何可写目录）；本机 `icacls "%USERPROFILE%\AppData\LocalLow"` → `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` | `(NW)` 只挡"往上写"，Low→Low 允许。**未做落盘验证**（清单 #3）。影响面有限（默认 Low 目录就那么几个），措辞上"零写入承诺不成立"是对的，但别当成通用逃逸 |
| 6 | P1-4 一次性升权不绑定具体动作 | P1 | **成立** | `src/lib/permission-request-tool.ts:69` `{ label: APPROVE, description: "只对下一次越界操作（一条命令或一次写入）生效，执行完自动回到原档位。" }` vs `src/lib/agent-manager.ts:1356` `m.escalation = { scope, remaining: 1 };`；消费时只记不外校 `:1787` `consumeEscalation(m, describeEscalatedToolCall(event.toolName, event.input));` | 批准卡文案与实现不一致，报告引文准确。补充：`ESCALATABLE_TOOLS` 只含 bash/write/edit（`:1318`），所以"批准 full 后还能用 powershell 工具"不成立，但"批准 full 后 bash 里跑任意命令"成立 |
| 7 | P2-2 `realpathLoose` fail-open，且"`file:` 逃逸靠这一支" | P2 | **部分不成立（归因错）** | `src/lib/permission-gate.ts:69` `if (code !== "ENOENT" && code !== "ENOTDIR") return path.resolve(target);` | fail-open 这行代码**存在**，但 `file:` 输入**不走它**：实测 `fs.realpath` 一路 ENOENT 到 `D:\AIApp\PiWeb`（存在）后回填尾部，走的是 `:65-66` 的**祖先回填分支**，`:69` 一次都没命中。P0-1 与 P2-2 无因果关系，P2-2 应单独定级（仍值得修） |
| 8 | （正文「Win32/koffi 核对」末尾）`GetLastError` 可能被 `CloseHandle` 覆盖 | P3 | **不成立** | `src/lib/sandbox/windows-acl.ts:367-372` `const ok = CreateProcessAsUserW(…); const error = GetLastError(); CloseHandle(outHandle); …` | 取错误码在三个 `CloseHandle` **之前**，报告担心的时序不存在。这只是 P3 里一句顺带的猜测，不影响任何结论，但别写进汇总 |
| 9 | P2-1 `kill()` 只杀直接子进程（无 Job Object） | P2 | **成立** | `src/lib/sandbox/windows-acl.ts:393-398` `killed = true; TerminateProcess(processHandle, 1); WaitForSingleObject(processHandle, 5000); CloseHandle(processHandle);`；全文无 `CreateJobObject` | 连带一个新点：`dispose()` 也不杀在跑的子进程（V1-漏-2） |
| 10 | P2-4 缓存 key 不含 cwd/extraRoots；release 是 fire-and-forget | P2 | **成立** | `src/lib/sandbox/manager.ts:67-69`（key 只有 `sessionPath\0mode`）、`:119` `await fs.rm(tempDirFor(sessionPath), …)`；`src/lib/agent-manager.ts:2167` `void releaseSandbox(m.sessionPath);` | (a) 半段（同一会话换 cwd）报告自己标了"没找到改写点"，我 grep 也未找到改 `m.cwd` 的路径 → 只保留 (b)(c) 两条 |

### 1.2 `bridge.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 11 | P1-1 `abort` 无超时，复位帧排在 await 之后 | P1 | **成立（机制）；「生产已复现」无证据** | `src/lib/agent-manager.ts:2868` `await m.session.abort();` 之后 `:2869` 才 `publish(… state: "aborted" …)`；SDK `pi …/dist/core/agent-session.js:2073-2084` `async abort() { … this.agent.abort(); await this.waitForIdle(); }`；对照 `agent-manager.ts:2677-2684` 有 5 秒上限 | 正文写"需运行验证"、§4 却写"**且生产已复现**"——内部矛盾。要么补日志/复现步骤，要么撤回这句（我倾向撤回，否则会误导优先级） |
| 12 | P1-2 `deferPublish` 微任务抛异常 → 队头永久 `null` | P1 | **成立（机制）；触发源仍待验证** | `:527` `while (queue.length > 0 && queue[0].events !== null) {`；`:570-573` `queueMicrotask(() => { entry.events = events(); flushPublishes(m); });`（无 try/catch） | 机制无可争辩。触发源（`getAvailableThinkingLevels` 抛错）报告自己标"疑似"，同意；但这属于"一次异常永久黑洞"，修法 3 行，值 |
| 13 | P2-1 `performReload` 的 `finally` 未保护 `applyToolPolicy` | P2 | **成立** | `src/lib/agent-manager.ts:1967-1970` `} finally { applyToolPolicy(m, session); m.resourceReloading = false; if (reloadTasks.get(m) === task) reloadTasks.delete(m);` | 对照 `:2296-2300`、`:3061-3065` 两处都包了 try，「同文件两处对、这一处漏」的论据成立 |
| 14 | P2-4 会话锁是布尔位，`prompt` 占位在 await 之后 | P2 | **成立** | `:2790` 注释"在第一个 await 前占位" vs `:2793` `const busy = await waitWhileReloading(m);` `:2796` `m.promptSubmitting = true;` | 同一模式在 `steer/followUp`（`:2813-2819`）更弱：**完全没有占位**，并发两条 steer 都能进 |
| 15 | P2-5 `void releaseSandbox()` 可能拆掉新会话的沙箱 holder | P2 | **夸大** | `src/lib/sandbox/manager.ts:110-114` `for (const [key, holder] of [...holders.entries()]) { … holders.delete(key); … }` **在第一个 await 之前同步执行**；`:2167` 之后 `agent-manager.ts:1199-1200` `disposeSession(m); const fresh = registerManaged(…)` | 删除 holder 必然早于 `registerManaged`，**新 holder 不可能被删**。真实残留窗口是另外两处：`(1)` 旧 `releaseSandbox` 尾部的 `await fs.rm(tempDirFor(sessionPath))` 与新会话同名 temp 目录竞争；`(2)` 旧 `cleanup()` 的 `markMedium` 把新沙箱刚打的 Low 还原（与 sandbox P2-4(c) 同源）。降为 P3，修法照旧（代际号）但风险描述要改 |
| 16 | P2-2 readonly 下 `!` 偷走模型的一次性升权 | P2 | **成立** | `src/lib/agent-manager.ts:1649` `consumeGrant: (command: string) => consumeEscalation(m, command),` 与 bash 工具 `:1376` 共用 `m.escalation`；`consumeEscalation` 里 `:1344` 直接写审计 | 与 sandbox P1-1 同源，两份报告各自发现同一处，合并成一条修 |

### 1.3 `bridge-tools.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 17 | P1-1 扩展 slash 命令阻塞整次提交，POST 不返回 | P1 | **成立** | SDK `pi …/dist/core/agent-session.js:1705-1709` `const handled = await this._tryExecuteExtensionCommand(text); if (handled) { preflightResult?.("handled"); return; }`（preflight 在 handler **之后**）；`src/lib/agent-manager.ts:2796` `m.promptSubmitting = true;` `:2804` `return await submitPrompt(…)`；`submitPrompt` 只在 `preflightResult` 里 resolve（`:2698-2702`） | 服务端链路静态确凿。用户可见症状（无停止按钮、`sending` 卡死）依赖 UI，属 chat-ui 的 P1-1 同一条 |
| 18 | P2-3 旧 `customActiveTools` 压过档位 → readonly 下扩展写工具真能执行（越权） | P2 | **成立（越权面）** | `src/lib/agent-manager.ts:1804` `const allowed = m.customActiveTools ? m.customActiveTools.includes(name) : presetAllowsTool(effectivePreset, name);`；readonly 闸门只挡内置名 `src/lib/permission-gate.ts:163` `if (MUTATING_TOOL_NAMES.has(toolName))`（不含扩展工具名）；现状被测试钉死 `tests/agent-resource-isolation.test.ts:250-252` `setActiveTools({names:["read","probe_tool"]}) → getActiveToolNames() === ["read","probe_tool"]` | 触发需"已鉴权客户端调 setActiveTools"或"旧偏好文件残留"，模型自身无此工具 → 维持 P2。但这是**唯一一条能绕过 readonly 写盘的模型可见路径**（除 P0-1/P0-2 外），值得与 sandbox 区合并处置 |

### 1.4 `models.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 19 | P1-1 目录刷新失败被吞、无任何提示 | P1 | **成立（吞错链确凿）；"模型静默消失"待运行** | `src/lib/pi.ts:75-77` `} catch { if (modelRuntimePromise === pending) modelRuntimePromise = null; }`（全仓 `getError()` 只有 `src/lib/models-service.ts:1491` 一处消费） | 吞错无日志=事实。症状严重度取决于 SDK 对坏 `models.json` 的降级方式 → 清单 #6 |
| 20 | P1-2 认证探测失败当"未认证"并缓存 60 秒 → 整家 provider 模型消失 | P1 | **成立** | `src/lib/models-service.ts:343-346` `catch (error) { authError = … }` + `:346` `authCheckCache.set(pid, { at: Date.now(), ready: authReady, … })`（`authReady` 仍为 `false`）；`:159` `const AUTH_CHECK_TTL_MS = 60_000;`；`src/components/ModelSelector.tsx:123` `if (authByProvider[entry.provider] === false) continue;` | 隐藏（`continue`）而不是置灰，报告描述准确；触发需 `checkAuth` 真抛错（OAuth 刷新/网络抖动） |

### 1.5 `api-auth.md`（无 P0/P1；复核其中会丢数据/越权的 P2）

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 21 | P2-1 `/api/skills` 递归删除边界是黑名单 | P2 | **成立** | `src/lib/skills-service.ts:228-233` `const ownsDir = path.basename(authorized) === "SKILL.md" && path.dirname(skillDir) !== skillDir && !protectedRoots.has(comparableDir) && …` → `await fs.rm(removed, { recursive: ownsDir, force: true });`；`src/lib/path-security.ts:89` `if (realCandidate && samePath(realRequested, realCandidate)) return realRequested;`（返回 realpath） | 前置条件"loader 会通过链接发现技能"已被 SDK 源码证实：`pi …/dist/core/skills.js:173-180` `if (entry.isSymbolicLink()) { const stats = statSync(fullPath); isDirectory = stats.isDirectory(); …`。**同一缺陷在 `plugins-skills.md` 被定为 P0**，两份报告严重度分歧（见 §4 拍板 #1） |
| 22 | P2-2 `PI_WEB_AUTH` 未设置即 fail-open | P2 | **成立** | `src/proxy.ts:28` `if (!authEnabled()) return NextResponse.next();`；`src/lib/web-auth.ts:44-47` 只认 `1/true/on/yes` | 现实触发取决于启动路径（`scripts/launcher.mjs` 会设），但"当前唯一防线是启动器的副作用、没有失败关闭"这点成立 |
| 23 | P2-4 `revokeAllSessions` 的 `notBefore` 在锁外取值 | P2 | **成立** | `src/lib/web-secret.ts:192` `export async function revokeAllSessions(now = Date.now()): Promise<void> {` + `:176` 才 `withSettingsWriteLock(…)` | 默认参数在调用时绑定；窗口窄（无争用时 <1ms），报告已如实说明 |
| 24 | P2-5 启动令牌进程内永久可重放 | P2 | **成立** | `src/proxy.ts:43` `if (authority && tokens.length === 1 && validLaunchToken(tokens[0], process.env.PI_WEB_LAUNCH_TOKEN)) {`（无"消费"标记）；吊销只作用于 Cookie | `scope=all` 撤不掉令牌，报告与 `tests/proxy-auth.test.ts` 的口径一致 |

### 1.6 `chat-ui.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 25 | P1-1 点"停止"可能永久 streaming（与 bridge P1-1 同一断点） | P1 | **成立（机制）；"生产已复现"同样无证据** | `src/components/ChatInput.tsx:506` `const stopAndRestore = async () => restoreQueued(await onAbort());`；`src/components/AppShell.tsx:744` `const abortPrompt = useCallback(() => sendCommand({ cmd: "abort" }), [sendCommand]);`；服务端同 #11 | 前端链路（无乐观复位、无超时）确凿；`usePiWeb.ts` 里的 fetch 也无 signal。两份报告同时写"生产已复现"，但都没给日志/截图 → 建议 lead 让发现者补一条证据或降级措辞 |
| 26 | P1-2 `isStreaming` 只由一条 `status` 事件决定，不与 3 秒轮询对账 | P1 | **成立** | `src/hooks/usePiWeb.ts:344` `if (s.snapshot) s.snapshot = { ...s.snapshot, isStreaming: evt.isStreaming };`（唯一写入口）；`src/components/AppShell.tsx:534` `const isStreaming = snapshot?.isStreaming ?? false;`（唯一读）；`:859-870` 轮询拿到 `running` 但只喂 `setSessions` | `grep isStreaming` 在 usePiWeb 只有 5 处、AppShell 9 处，无第二条对账路径 → 结论稳 |
| 27 | P1-3 轮询通道 `onMessage` 无 try/catch，一次异常永久断流 | P1 | **成立（范围限公网隧道）** | `src/lib/chat/event-stream.ts:99-103` `for (const frame of frames) { … handlers.onMessage(frame.data); … }` 位于 `:74` `void (async () => { while (!closed) { … } })();`（无 .catch）；`:12-14` `usesEventPolling` 只对 `*.trycloudflare.com` 返回 true | 局域网/直连走 SSE 不受影响；影响面是"远程连接"用户，报告已写明 |

### 1.7 `sessions-workspaces.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 28 | P1-1 归档保留期用 `unlink` 永久删除，无回收站无开关 | P1 | **夸大（建议降 P2）** | 机制确凿：`src/lib/session-retention.ts:81` `await deleteSession(target);` → `src/lib/session-reader.ts:293` `await fs.unlink(target);`；但**UI 明确告知过**：`src/i18n.tsx:256` `archiveRetentionHint: "归档满 30 天自动删除"`，`src/components/SessionSidebar.tsx:565` 把它挂在归档按钮 `title` 上、`:1056` 在已归档区再显示一次 | "30 天后删"是**已声明的产品行为**，不是静默数据丢失；真正缺陷只剩两条：`(a)` 时钟前跳会一次性批量删（边界条件）、`(b)` 无回收站/无开关。按 BRIEF 应落 P2。报告没提 UI 已有提示，属于把"产品决策"写成了"缺陷" |
| 29 | P1-2 `web-workspaces.json` 损坏 → 侧栏整表不可用且无修复入口 | P1 | **成立** | `src/lib/workspace-store.ts:64-66` `} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }`（`JSON.parse` 的 SyntaxError 没有 `.code` → 直接抛）；`src/app/api/sessions/route.ts:17-18` `await registerCwds(…); const workspaceRegistry = await getWorkspaceRegistry();` 同一 `try`；写路径 `mutate` 也经 `readFile` | "读坏文件→连写操作都 500"确凿，是完整的功能死锁。报告建议（坏文件改名留证 + fail-open 返回空表）合理 |

### 1.8 `files-viewer.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 30 | P1-1 非 UTF-8 文本：UTF-16 判成二进制、GBK 静默乱码 | P1 | **成立** | `src/lib/files-service.ts:293` `if (preview.includes(0)) { return { … binary: true, content: "" }; }`；`:301` `content: preview.toString("utf8"),`；`src/lib/text-sanitize.ts:5-11` `utf8Prefix` 只处理截断边界、不剥 BOM | UTF-16（每字节一 0x00）必落二进制分支；GBK 无 NUL → 原样 `toString("utf8")` 出 U+FFFD，无任何提示。报告对"仓库内没有 UTF-16 文件所以测试碰不到"的核对也与我一致 |

### 1.9 `git-project.md`

| # | 报告项 | 原判定 | 复核判定 | 依据（path:line + 原文） | 备注 |
|---|---|---|---|---|---|
| 31 | P1-1 merge/冲突提交的 diff 恒显示"没有差异" | P1 | **成立（我实测复现了它的数据）** | `src/lib/git-service.ts:288` `runGit(root, ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", "--patch", hash], 8 * 1024 * 1024)` | 我跑的同一条命令：`66ba291`（2 父）`--patch` 输出 **0 字符**、`--numstat` **113 行**；`ab9a571` 0 / 223；`a8e924d` 0 / 2；`git rev-list --merges --count HEAD` = **27**。与报告给的数字**逐个吻合**。conflict 分支（`@@@`）未实测 → 清单 #7 |

## 2. 漏报补充

### V1-漏-1（sandbox/权限 / bridge 生命周期，**P1**；这是本轮复核最重要的新发现）沙箱 Low 标签跨进程残留，本机此刻正处于"readonly 能写工作区"的状态

- **位置**：`src/lib/sandbox/windows-acl.ts:132-137`（`cleanup()` 是唯一 `markMedium` 的地方）、`src/lib/sandbox/manager.ts:107-120`（只在 `releaseSandbox` 里被调）、`src/lib/agent-manager.ts:2167`（只在 `disposeSession` 里被调）
- **证据（本机磁盘现状，只读探测，19:20 采样）**：

```
icacls D:\                      → (无显式标签)
icacls D:\AIApp                 → Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)   ← 显式
icacls D:\AIApp\PiWeb           → Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
icacls D:\AIApp\harness         → Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
icacls C:\Users\guica\Desktop   → Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)   ← 独立目录树
icacls C:\Users\guica           → (无显式标签)

~/.pi/agent/web-sandbox/ 只有一个子目录：ZGM0OThlYTg4ZDhiLmpzb25s
   （= base64url("dc09ea88d8b.jsonl")）LastWriteTime 18:36:38，**空目录，且自己已经没有 Low 标签（= 已被 markMedium 过）**
当前 dev server：pid 6032 `bin/piweb.js --dev` / pid 21992 `next dev -p 30141`，启动时间 **18:48:58**
GET http://127.0.0.1:30141/api/health → 200（服务在跑）
```

  四条硬事实：
  1. `D:\` 本身没有标签，所以 `D:\AIApp` 的 Low 是**显式**打上去的（某个沙箱把它当 cwd）；`C:\Users\guica\Desktop` 是另一棵独立的树，`C:\Users\guica` 没有标签 → 也是显式。
  2. 活着的沙箱一定有自己的 `tempDirFor(sessionPath)` 目录（`windows-acl.ts:140` 在创建时就 `mkdir`），而磁盘上**只有一个**，且它**自己已经恢复成 Medium、还是空的**（说明它的 `cleanup()`/`dispose()` 跑过，但 `releaseSandbox` 没跑，否则目录会被 `fs.rm` 删掉，见 `manager.ts:119`）。
  3. 因此"`D:\AIApp` 树 + 桌面 树"这两处 Low 里**至少有一处没有任何活着的沙箱与之对应**；而那个空目录的 mtime(18:36) 早于当前 server 启动(18:48)，也说明上一代进程留下过未收尾的沙箱资源。
  4. 更根本的问题：PiWeb 只把"我标过哪些目录"放在内存的 `holders`（`manager.ts:35`）里，**磁盘上没有任何所有权记录**，所以重启后**无从判断该还原谁**，`docs/workspace-isolation.md:146-153` 的兜底只能是让用户手动 `icacls …(OI)(CI)Medium`。（`Get-Acl -Audit` 读 SACL 需要 `SeSecurityPrivilege`，非管理员进程拿不到，所以我无法进一步区分父子目录里哪条是继承 ACE —— 这一点如实标注为未确认。）
- **触发路径**：workspace 档跑过任意 bash（标签落盘）→ 进程被强杀 / 崩溃 / 断电 / `reap` 时 `releaseSandbox` 失败 → 标签留在磁盘上，永久。此后：
  1. `readonly` 档（哪怕是**重启后新建的、从未跑过 workspace 档的会话**）的 bash 子进程照样能写这个工作区 —— P0-2 从"同进程内的时序窗口"变成"**一次异常退出后长期成立**"；
  2. `D:\AIApp` 这种"父目录工作区"被标 Low 后，**它下面所有项目**（含 `harness`、`PiWeb`）对整个 Low 世界可写（浏览器 low-IL 渲染进程、其它工具的 low 沙箱、任何 `CreateRestrictedToken` 出来的低完整性子进程）；
  3. 桌面 `C:\Users\guica\Desktop` 也是 Low → Low 进程可以往桌面投文件（"用户双击"这条经典路径）。
- **后果**：本机现在（19:40）就处在这个状态。它是 P0-2、P1-2 两条结论的**共同放大器**，也是"沙箱生命周期"这一整块唯一没有兜底的地方。
- **置信度**：**已确认（观测到现状 + 代码路径唯一）**。唯一不能从磁盘区分的是"这四个标签里哪些属于当前仍存活的沙箱"——因为所有权只在内存里，这本身就是缺陷的一半。
- **建议修法**：`createAclSandbox` 在标 Low 前把目标路径写进 `<tempDir>/marks.json`（或在 `~/.pi/agent/web-sandbox/marks/<key>.json`），dispose 时删；**进程启动时扫一遍遗留 marks 文件，把里面列的目录 `markMedium` 并清理**（顺带复活 `resetSandboxStateForTests` 的语义）。再加一条：`markMedium` 失败要 `console.warn`，不要 `.catch(() => undefined)`。

### V1-漏-2（sandbox/windows-acl，P3，疑似）`dispose()` 不终止在跑的子进程，且 `exec` 的清理在 disposed 后被跳过

- **位置**：`src/lib/sandbox/windows-acl.ts:227-234`（`finally { … if (!disposed) { await fs.rm(stdoutPath…) … } }`）、`:236-240`（`dispose()` 只 `cleanup()`）
- **证据**：`cleanup()` 只做三件事：`closeSpawner?.()`（关受限令牌句柄）、对 `marked` 逐个 `markMedium`、删 scratch。**没有任何 `handle.kill()`**；而 `RestrictedProcessHandle` 是每个 `exec` 局部的，`dispose` 拿不到。
- **触发路径**：`shutdownSession` 的 5 秒上限到点后 `session.dispose()`（`agent-manager.ts:1890-1897`）→ 沙箱仍在跑的命令没有 listener 去 kill → `releaseSandbox` 把目录还原成 Medium、删掉私有 temp，子进程继续以 Low 令牌跑，但它要写的目录已经变回 Medium（写失败），TMP 也已不存在。
- **后果**：进程/handle 泄漏（`cmd.exe`+node 常驻），表现是"停止后后台还在占 CPU"，与 sandbox P2-1（无 Job Object）同一根因，但触发点是**回收**而不是用户 abort，报告没覆盖。
- **置信度**：疑似（要构造"force dispose 时命令仍在跑"的时序）。
- **建议修法**：把在跑的 handle 收进 sandbox 级 `Set`，`dispose()` 里逐个 `kill()`；`finally` 的清理条件改成"文件存在就删"。

### V1-漏-3（bridge/agent-manager，P3）`write` 的 diff 基线用与 pi 不同的路径解析，`~`/`file:` 形式的覆盖写会退化成"全绿新增"

- **位置**：`src/lib/agent-manager.ts:450-465`（`captureWriteBase`）、`:454` `const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);`
- **证据**：pi 侧写盘用的是 `resolveToCwd` → `normalizePath`（`pi …/dist/core/tools/write.js:31`、`path-utils.js:42-44`、`paths.js:100-123`：展开 `~`、剥 `@`、`file:` → `fileURLToPath`）；而这个 diff 基线只做 `path.resolve`。
- **触发路径**：工作区 = 家目录（本机历史工作区里就有 `C:\Users\guica`）时，模型 `write({path:"~/notes.txt", content})` → pi 覆盖 `C:\Users\guica\notes.txt`，`captureWriteBase` 去 stat `C:\Users\guica\~\notes.txt` → ENOENT → 没有旧内容 → 前端把整篇当新增行（删掉的行永远不标红）。`file://` 同理（与 P0-1 同源）。
- **后果**：只影响 diff 展示（落盘是对的），但"覆盖了却显示全绿"会误导用户以为只是新增。
- **置信度**：已确认（代码）。
- **建议修法**：`captureWriteBase` 复用 `resolveModelPath`（`permission-gate.ts:43`）+ 与 pi 一致的 `file:` 处理，或干脆从 pi 的 `resolveToCwd` 导出一份共用。

### V1-漏-4（models/models-service，P3）刷新失败照样 `return true`，调用方以为"目录已是最新"

- **位置**：`src/lib/pi.ts:64-86`
- **证据**：`refreshModelRuntime` 里 `modelFilesSeen = …; modelRuntimeGeneration += 1;` 在 `try` **之前**做，失败只在 `catch` 里把 promise 置 null；`refreshModelRuntimeIfFilesChanged` 的 `await refreshModelRuntime(); return true;` 无条件返回 true。
- **后果**：`refreshModelRuntimeIfFilesChanged()` 的返回值被当成"已按最新文件重建目录"（`models-service.ts:212` 等），失败时上层没有任何信号——这是 P1-1"吞错"的**第二半**（报告只写了 `getError()` 没人读，没写"刷新失败还报成功"）。
- **置信度**：已确认（代码）。
- **建议修法**：`refreshModelRuntime` 返回 `{ ok, error }`，`…IfFilesChanged` 透传；`listModelsUncached` 把 error 放进响应。

### V1-漏-5（models/models-service，P3）用量探测没有响应体上限，与目录探测的 4 MiB 口径不一致

- **位置**：`src/lib/models-service.ts:736-751`（`fetchUsageJson` → `return await response.json();`）vs `:481`/`:537-549`/`:564-576`（目录探测 4 MiB 双保险）
- **后果**：用量端点的响应体完全没有上限（10 秒超时只管时间）；一个异常大的响应就能把整个响应读进内存再 `JSON.parse`。
- **置信度**：已确认（代码）；规模未测。
- **建议修法**：抽一个 `readJsonCapped(response, 1 MiB)` 给两边共用。

## 3. 必须运行验证的清单（按优先级）

> 前 3 条是"结论已经站得住、只差一个落盘证据"，建议由 lead 在**专用临时工作区**里做（会往磁盘写文件、会改 ~/.pi，我不能做）。

| 优先级 | 要验的结论 | 怎么验（最小步骤） | 预期结果差异 |
|---|---|---|---|
| **1** | **P0-2 的"现在是否真的能写"** | 当前这台机器上，把 `D:\AIApp\PiWeb\.audit-2026-11-13` 当作工作区开一个 readonly 档会话，`bash` 跑 `echo probe> .audit-2026-11-13\ro-probe.txt` | **文件出现**＝证实（结合 V1-漏-1 的现状，几乎必然成功）。若失败：说明我的"标签已残留"判断错，需要重看 `icacls` |
| **2** | **P0-1 端到端落盘** | 临时目录建 workspace（如 `%TEMP%\piweb-v1-ws`），workspace 档会话里让模型 `write({path:"file:///C:/Users/guica/AppData/Local/Temp/piweb-v1-escape.txt", content:"x"})` | 文件出现在 `%TEMP%` 而不是工作区内＝证实；若被拒，说明 pi 侧 `resolveToCwd` 与我读到的版本不同 |
| **3** | **P1-3 readonly 能写 `LocalLow`** | readonly 档 `bash`：`echo x> "%USERPROFILE%\AppData\LocalLow\piweb-probe.txt"` 然后 `type` 它 | 成功＝证实（CLI 已确认标签是 `Low (OI)(CI)(NW)`，Low 写 Low 允许）；`Access is denied`＝我的 ACL 推断错 |
| **4** | **bridge/chat P1-1 的触发场景（决定它是不是 P0）** | 在 30141 的会话里 `!` 跑 `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`，然后点停止；同时用 `curl -m 60 -X POST http://127.0.0.1:30141/api/agent/<id> -d '{"cmd":"abort"}'`（带 Cookie）观察是否 60s 不返回 | 超时未返回 + UI 仍 streaming＝证实"abort 能永久挂住"；正常返回 200＝P1-1 只剩理论（应降级并撤回"生产已复现"） |
| **5** | **bridge-tools P1-1** | 把 `examples/piweb-extensions/todo-panel.ts` 装进某工作区 `.pi/extensions/`，空闲会话发 `/todo`，观察 `POST /api/agent/[id]` 是否挂到面板被应答 | 挂住 + `promptSubmitting` 期间新 prompt 被拒＝证实；秒回 200＝我的 SDK 顺序判断错（可能性极低，已逐行核过 `agent-session.js:1705-1709`） |
| **6** | **models P1-1 的症状**（会不会"模型静默消失"） | 备份 `~/.pi/agent/models.json` 后写入 `{"providers":{"x":{"baseUrl":1}}}`，`GET /api/models`，看返回的 `providers/models` 与 `runtime.getError()`；完成后还原文件 | 内置模型仍在、自定义 provider 全消失＝证实"静默残缺"；整个 500 并提示 JSONC 无效＝降级为"错误可见"，P1-1 应改写 |
| **7** | **git P1-1 的 conflict 分支** | 临时仓库造冲突（`git init` + 两个分支改同一行 + merge）后跑 `git diff --no-color -- <冲突文件>` | 首行 `diff --cc` + hunk `@@@ -1,2 -1,2 +1,2 @@@` ＝证实 `DiffView.tsx:34` 的正则不匹配；若 git 输出了普通 `diff --git`，则冲突分支不成立（merge 分支已实测成立，不受影响） |
| **8** | **api-auth P2-3（本区域唯一未排除的 P0 可能）** | 向 `POST http://127.0.0.1:30141/api/health` 发 300 MB body（必然 401），同时采样 dev server 进程 RSS | RSS 峰值涨 ≥272 MB＝缓冲发生在鉴权**之前**（远程内存耗用，升级 P0）；RSS 不变＝鉴权先拒绝，维持 P2。**这属于压力型请求，需要你批准，我没做** |
| **9** | **bridge P2-5 的真实残留窗口** | 造一个 `reopenManaged` 立刻 bash 的场景：同一会话文件被外部写入 → `/api/sessions` 轮询触发 reopen → 立刻发一条 `bash ls` | 出现 `sandbox unavailable` 或 TMP 丢失＝证实；正常＝维持"夸大"（holder 一定不会被删，只有 temp/mark 竞争） |

## 附：给 lead 的三条"最站不住"与三条"要拍板"

**最站不住（建议降级或改措辞）**
1. `sessions-workspaces.md` P1-1（归档 unlink 永久删）——UI 明确写了"归档满 30 天自动删除"（`i18n.tsx:256`），这是已声明的产品行为；真缺陷只剩时钟前跳和"无回收站"，应按 P2。
2. `bridge.md` P2-5（`releaseSandbox` 拆掉新 holder）——`holders.delete` 是同步的、必然早于 `registerManaged`，机制描述错；真实窗口是 temp 目录与 `markMedium`。
3. `sandbox.md` P2-2 的归因（"`file:` 靠 fail-open 那一支"）+ P3 里 `GetLastError` 的猜测——两处都与代码不符（前者实测走 ENOENT 祖先回填，后者取码在 `CloseHandle` 之前）。事实错了，结论要重写。
   （另：`bridge.md`/`chat-ui.md` §4 都写"生产已复现 P1-1"，但正文标"需运行验证"，无任何日志证据——要么补证，要么撤回。）

**最需要你拍板**
1. **`/api/skills` 递归删除**：`api-auth.md` 定 P2、`plugins-skills.md` 定 P0，同一缺陷两个级别。分歧点是"用户自己建了 junction = 授权删链接目标"这个前提成不成立；我复核认为机制成立（SDK 确实通过链接发现技能），级别由你定。
2. **P0-2 / V1-漏-1 的修法方向**：是"切档时释放旧沙箱 + 标签引用计数"（改动在 `setToolPreset`/`manager`），还是"启动时扫遗留标记统一复原"（能同时兜住崩溃残留）？我建议**两个都做**，但如果只做一个，选后者（它是当前磁盘上真实存在的状态）。
3. **readonly 里扩展工具能不能执行（bridge-tools P2-3）**：现状被 `tests/agent-resource-isolation.test.ts:250-252` 钉成"预期行为"，但它等于给 readonly 开了一个"非内置写工具"的口子。是明确写进文档（受限档只保证内置工具边界），还是把 `customActiveTools` 与档位求交？这条会决定权限模型的口径。
