# 测试套件 审计报告

> 审计对象：**测试本身**（`tests/`、`vitest.config.ts`、`tests/setup-dom.ts`、`.github/workflows/check.yml`），不是被测功能。
> 基线（lead 实跑，2026-11-13 18:49–18:55）：`npx tsc --noEmit` exit 0；`npx vitest run` **204 文件通过 / 3 跳过（共 207）、1648 通过 / 19 跳过 / 0 失败**，312.51s（`.audit-2026-11-13/vitest.log`）。

## 0. 覆盖范围

### 0.1 读了什么

配置与门禁（全文）：`vitest.config.ts`（23 行）、`tests/setup-dom.ts`（29 行）、`.github/workflows/check.yml`（35 行）、`package.json` 的 `scripts`。

测试文件：**逐个读/精读 24 个**（见 0.5 抽样表），另有约 20 个只读头部 + `it()` 标题清单（`agent-prompt-acceptance`、`agent-hero-commands`、`settings-model-roundtrip`、`session-import-service`、`session-import-writer`、`api/session-import-scan`、`web-auth`、`message-cancellation` 等，均标注为"只读了标题与 setup 段"）。

源码侧只为对账而读：`src/lib/agent-manager.ts`（只读导出表与关键行）、`src/lib/remote/supervisor.ts`（导出表 + 进程/定时器行）、`src/lib/remote/tunnel-health.ts`（全文 59 行）、`src/lib/sandbox/windows-acl.ts`（null 返回条件）、`src/lib/session-import/*.ts`（`catch` 位置）、`src/app/api/sessions/[id]/route.ts`、`src/app/api/sandbox/route.ts`、`src/lib/model-files.ts`、`src/lib/pi.ts`（模块级副作用）、`src/lib/growth-service.ts`（`isAvailable`/git 身份）。**不审 pi 内核**。

**做了但没做到、要明说的**：仓库没有 coverage provider（`vitest.config.ts` 无 `coverage` 段，`devDependencies` 里没有 `@vitest/coverage-*`，而本次**禁止装依赖**），所以**拿不到行/分支覆盖率百分比**。替代办法：脚本解析 `tests/` 与 `src/` 的 import 图，并**把被 `vi.mock` 的模块从该测试文件的执行图里剪掉**（`vi.mock` 提升到文件级，被 mock 的模块在该文件里确实不执行），得到"源码模块是否被任何测试**真实执行**"。这套对账可复现，但只到**模块级**，粗于行覆盖——这是本报告最大的方法学缺口。

统计口径：`src/` 210 个非 `.d.ts` 模块 / 46,534 行；`tests/` 207 个 `.test.ts(x)` / 24,838 行（`tests/setup-dom.ts` 另 29 行）。`it/test` 块 1,535 个（含 `it.each` 展开后 vitest 报 1,667 条）；`expect()` 5,332 次 → **平均 3.4 断言/测试**；`toBeTruthy()` 311 次、`not.toThrow` 5 次、`toBeDefined()` 7 次、快照 0 次；`vi.mock`/`vi.spyOn` 189 次；`useFakeTimers` 17 处；`waitFor` **242 次，其中 0 次显式给 timeout**；裸 `setTimeout` 29 处。

### 0.2 覆盖对照表（`src/` 按目录 → 对应测试文件）

`被测试执行`= 该目录下被**至少一个**测试文件真实执行的模块数（去 mock 后）。

| 源目录 | 源文件 | 源行数 | 被测试执行 | 未执行 | 对应测试（目录/代表文件） |
|---|---|---|---|---|---|
| `src/lib`（根） | 71 | 14,593 | 70 | 1 | `tests/*.test.ts` 107 个（`agent-*`、`growth-*`、`models-service-*`、`web-*`、`session-*`、`files-service*`…） |
| `src/lib/sandbox` | 4 | 649 | 4 | 0 | `tests/lib/sandbox/*`（6 文件 / 387 行，3 个 `skipIf(!win32)`） |
| `src/lib/remote` | 4 | 838 | 4 | 0 | `tests/remote-*.test.ts`（5 文件）+ `tests/integration/remote/tunnel-status.test.ts`（`skipIf(win32)`） |
| `src/lib/session-import` | 15 | 1,891 | 14 | 1 | `tests/session-import-sources/service/writer.test.ts` + `tests/api/session-import-scan.test.ts` |
| `src/lib/automations` | 5 | 1,392 | 5 | 0 | `tests/automations-*.test.ts`（6 文件） |
| `src/lib/chat` | 6 | 240 | 6 | 0 | `tests/event-stream`、`compose-prompt`、`lib/file-path`、`lib/skill-expansion`、`mention-parity` |
| `src/lib/update` | 1 | 95 | 1 | 0 | `tests/update-startup-check.test.ts`（该模块在 `update-service-route`/`remote-startup` 里被 mock） |
| `src/components`（含子目录） | 54 | 20,691 | 54 | 0 | `tests/components/*` 74 文件 / 8,278 行（ChatWindow 13、ChatInput 6、settings 7、AppShell 8…） |
| `src/hooks` | 6 | 2,098 | 6 | 0 | `tests/use-piweb-events`、`use-growth`、`use-workspace-files`、`components/dialog-stack`、`file-viewer-dir`、`select-keyboard` |
| `src/app/api/*` | 34 | 1,614 | **20** | **14** | 21 个路由被测试 import（`fs-route`、`proxy-auth`、`remote-*`、`models-*`、`plugins-*`、`update-*`、`session-import-scan`、`workspace-picker`…） |
| `src/app/login` / `src/app/pair` | 2 | 82 | 2 | 0 | `components/login-page.test.tsx`、`remote-pair.test.ts` |
| `src/app`（layout/page/instrumentation） | 3 | 43 | 0 | 3 | 无 |
| `src/proxy.ts`（根） | 1 | 71 | 1 | 0 | `proxy-auth`（9 处）、`remote-pair`、`upload-proxy`、`proxy-route` 等 |
| **合计** | **210** | **46,534** | **191（91.0%）** | **19（1.0% 行）** | 207 个测试文件 |

### 0.3 零测试 / 零执行源文件（脚本对账，非印象）

**A. 没有任何测试真实执行（19 个 / 467 行 / 1.0%）**

| 未执行模块 | 行数 | 判断 |
|---|---|---|
| `src/app/api/growth/route.ts` | 48 | 路由包装，零执行 |
| `src/app/api/plugins/marketplace/route.ts` | 48 | 路由包装，零执行 |
| `src/app/api/prompts/route.ts` | 43 | 路由包装，零执行（前端 `prompt-panel` 用 fetch mock 测，服务端这侧没测） |
| `src/app/api/skills/route.ts` | 42 | 路由包装，零执行 |
| `src/app/api/sessions/[id]/route.ts` | 34 | **含分支逻辑**：`BoundaryError→400`、DELETE 三步顺序（见 P2-6） |
| `src/lib/session-import/paths.ts` | **29** | **真实逻辑被整体 mock 掉**（`session-import-service.test.ts:14`、`session-import-sources.test.ts:22` 都 `vi.mock` 它）→ 各来源真实根目录（`~/.claude/projects`、`~/.codex/sessions`…）从未被验证 |
| `src/app/api/git/route.ts` | 28 | 路由包装，零执行（`git-service` 本体有测） |
| `src/app/api/sandbox/route.ts` | 24 | 路由包装，零执行（`sandbox/config`、`sandbox/manager` 有测） |
| `src/app/layout.ts` | 23 | 壳，无断言价值 |
| `src/app/api/agent/[id]/route.ts` | 22 | 路由包装，零执行（只在 `lib/file-path.test.ts:17` 里作为**字符串**出现，不是 import） |
| `src/app/api/pi-settings/route.ts` | 21 | 路由包装，零执行（`pi-settings` 服务的锁有测） |
| `src/app/api/config/route.ts` | 20 | 路由包装，零执行 |
| `src/app/api/github/route.ts` | 20 | 路由包装，零执行（`github-identity` 有测） |
| `src/app/api/agent/new/route.ts` | 18 | 路由包装，零执行 |
| `src/app/api/models/defaults/route.ts` | 16 | 路由包装，零执行 |
| `src/instrumentation.ts` | 11 | 启动钩子，零执行 |
| `src/app/page.ts` | 9 | 壳 |
| `src/app/api/version/route.ts` | 6 | 路由包装，零执行 |
| `src/lib/version.ts` | 5 | **真实实现在 `update-service.test.ts:6` 被 mock 掉**，`getRuntimeVersions` 从未真跑 |

**B. 只在别处被 mock、或只在特定 lane 才真跑的模块**（35 个模块出现在 `vi.mock` 目标里，绝大多数在别的文件里有真实覆盖，只有 3 个例外）：

- `src/lib/session-import/paths.ts` — 两个测试文件都整体 mock，**从无真实执行**。
- `src/lib/version.ts` — 被 mock，**从无真实执行**。
- `src/lib/remote/tunnel-health.ts`（59 行）— `remote-auto-connect.test.ts:12` 把它 mock 成一个 `probe` spy；真实实现只在 `tests/integration/remote/tunnel-status.test.ts` 里跑，而那个文件 `describe.skipIf(process.platform === "win32")`（`:20`）→ **主目标平台 Windows 上零执行**。

**C. 核心面里没测到的行为**（按 lead 点名的五项）

| 核心面 | 有测的部分 | 没测的行为（有准确出处） |
|---|---|---|
| `agent-manager` abort/队列/dispose | 队列与 abort **相当扎实**：`tests/agent-resource-isolation.test.ts:209-236`（abort 后 followUp 仍在队列 + `buildSnapshot().queue` + `clearQueue`）、`:286-358`（并发工具调用被降档拒绝）、`tests/agent-prompt-acceptance.test.ts:265-303`（`sendQueueNow`）、`disposeSession` 在 `:43,97,262` | **`reap()` 空闲回收零测试**（`src/lib/agent-manager.ts:2184`，`IDLE_MS=10min` 在 `:82`，`hasViewers` 判定在 `:2187`）；**`BUFFER_CAP=400` 环形缓冲零测试**（`:84`、裁剪在 `:538`）；**`holdViewer` 真实实现零测试**（`:2615`，只在被 mock 的 `agent-events-route.test.ts:105` 里当 spy 断言过）；`syncSessionsFromDisk()`（`:1216`）、`peekSessionModelRuntime()`（`:1121`）在整个测试目录里 **0 次引用** |
| `remote/supervisor` 进程生命周期 | 状态机逻辑测得好：`tests/remote-auto-connect.test.ts:89-157`（退出后重连/停机后停重试/不可达替换/短暂中断保留地址）、`remote-supervisor.test.ts:116-123`（并发 startLan 共享一个监听）、`:126-175`（allowlist/URL 捕获） | **真实子进程永不参与**：`remote-auto-connect.test.ts:11` 把 `node:child_process` 整个替换成 `fakeChild()`；`startPublic` 的 spawn/ENOENT/kill 后 3s 收尾（`src/lib/remote/supervisor.ts:505,552,600-602`）只有 fake 版；真实 cloudflared 只有 `remote-tunnel.integration.test.ts`，其 `RUN = process.env.PIWEB_TEST_TUNNEL === "1"`（`:24`）→ **CI 里永远 skip** |
| `sandbox` ACL 失败路径 | 内核拒绝写测到了（`windows-acl.test.ts:55-66`，含 `node` 而非只 `cmd`、读仍放行 `:68-72`）、只读档（`readonly-mode.test.ts:43-58`）、fail-closed（`windows-acl.test.ts:118-122`） | **"建不出沙箱"只测了 1 条路径**（目录不存在 → null）；`createAclSandbox` 里 `catch { return null }`（`src/lib/sandbox/windows-acl.ts:242-244`）覆盖 `CreateRestrictedToken`/`SetTokenInformation` 失败的分支**无测试**；`markMedium` 失败（`:135` 是 `catch(() => undefined)` 静默吞）无测试；**koffi 缺失时本文件不是 skip 而是崩**（见 P1-2） |
| `session-import` 各来源坏数据 | 各来源的**正常**解析很扎实（`session-import-sources.test.ts` 498 行：Claude 思考/工具/用量、Codex 加密推理跳过、Grok summary、dsh 多帧 zstd、ZCode/opencode 只读 SQLite 且"一字节没变" `:441`、子代理会话排除） | **五个适配器的坏数据容错分支 0 命中**：`claude.ts:147,172`、`codex.ts:123,150`、`grok.ts:21,44,76,107`、`dsh.ts:54-55,146,189` 的 `catch` 全部没有测试（`session-import-sources.test.ts` 里 "坏/损坏/truncat/malformed/invalid" 关键词 **0 命中**）；截断 zstd 帧、损坏 SQLite 均未测 |
| `models` 写盘失败 | 测得好：`models-service-config.test.ts:160-173`（EACCES 不覆盖原文件、不当成"缺失"）、`:211`（`rename` EACCES）、`:152-158`（旧文件 schema 非法时不覆盖）、`:180-185`（10 组非法字段） | 未测：盘满（ENOSPC）、跨卷 rename、写入中途崩溃后残留 `.tmp` 的清理、`models.json` 被外部进程同时改写（无锁竞态） |
| `auth` 撤销竞态 | **跨进程真锁测得好**：`web-revocations-concurrency.test.ts:72-96`（两个真实子进程 + `proper-lockfile` 外部持锁，断言"拿到锁之前不许写"）；`web-auth.test.ts` 22 个用例覆盖签名/过期/篡改/绑定 | 未测：**撤销发生在"cookie 校验通过"与"后续请求"之间的窗口**（proxy 层没有"刚被撤销就立刻失效"的用例）；`REVOCATIONS_FILENAME` 被删/损坏时的 fail-open/fail-closed 行为 |

### 0.4 结论一览（按测试子功能）

| 测试面 | 结论 | 依据 |
|---|---|---|
| 配置/门禁（`vitest.config`、CI） | **OK-但脆弱** | `vitest.config.ts`：`maxWorkers:4`、`testTimeout:30s`、`hookTimeout:60s`、无 coverage；`check.yml:14-16` 双 OS × 双 Node，`timeout-minutes: 25` 要装下 typecheck+测试+build |
| 真实 SDK 会话/权限/沙箱闸门 | **OK**（本套件最强的一块） | `agent-resource-isolation.test.ts` 923 行 29 例，真 SDK、真临时工作区、`fetch` 被 stub 成 throw，覆盖 abort/降档/重试/越界写/JSONL 审计 |
| OS ACL 沙箱执行 | **OK-但脆弱** | 见 P1-1、P1-2 |
| 路径安全/会话边界 | **OK** | `lib/permission-gate.test.ts:78-88`（realpath 链接逃逸）、`integration/session-boundaries.test.ts:9-34`（junction 别名） |
| remote 隧道状态机 | **OK-但脆弱** | `remote-auto-connect`（fake 子进程）、`tunnel-status`（真探针但 `skipIf(win32)`）、`tunnel-health`（Windows 零执行） |
| session-import | **OK-但脆弱** | 见 0.3C |
| models 配置写盘 | **OK** | `models-service-config.test.ts:160-185` |
| auth / 撤销 | **OK** | `web-revocations-concurrency`、`web-auth`、`proxy-auth`（284 行） |
| UI 组件（74 文件） | **OK-但脆弱** | 覆盖广但依赖手写 fetch fixture 与 mock hook；有实现细节断言（P3-1/P3-2） |
| API 路由层 | **有问题** | 34 个路由中 14 个零执行（0.3A），含带分支的 `sessions/[id]` |
| growth / git | **OK-但脆弱** | 真 git + 真提交（`GIT_AUTHOR_*` 已内置，`growth-service.ts:729-730`），但 14 个用例在无 git 时静默通过（P1-3） |
| 稳定性 / 环境依赖 | **有问题** | 242 个 `waitFor` 全用 1s 默认超时；真端口/真进程/真 `npm pack`；双 lane 覆盖互补而非重叠（P2-4/P2-7） |

### 0.5 断言质量抽查（24 个代表，按"最强 → 最弱"）

| # | 测试 | 判定 |
|---|---|---|
| 1 | `tests/agent-resource-isolation.test.ts:209`（abort 后队列不丢） | **强**：真 SDK、断言 `hasQueuedMessages()`+快照队列+`clearQueue` 返回值三处一致 |
| 2 | `tests/agent-resource-isolation.test.ts:286`（并行调用被即时降档） | **强**：造 race（extension `tool_call` 里 await gate），断言被拒的两个 toolResult、`fs.access` ENOENT、另一会话不受影响、升档后工具恢复 |
| 3 | `tests/web-revocations-concurrency.test.ts:72` | **强**：真子进程 + 真文件锁，断言"持锁期间文件一字节没变" |
| 4 | `tests/models-service-config.test.ts:160` | **强**：mock 掉 `fs.readFile` 的 EACCES，断言读/写都抛、原文件未被覆盖 |
| 5 | `tests/security-service.test.ts:101`（SDK 吞掉的写错误要浮出） | **强**：用真实 `SettingsManager.fromStorage`，把错误形态（throw / 静默丢弃 / reload 报错）三种都造出来 |
| 6 | `tests/lib/sandbox/windows-acl.test.ts:61` | **强**：断言 `EPERM/EACCES` 文本，证明是内核拒而不是路径检查拒 |
| 7 | `tests/growth-service.test.ts:48`（带 tab 的 numstat） | **强**：真实边缘数据，断言条目数不塌缩 |
| 8 | `tests/lib/permission-gate.test.ts:78` | **强**：目录链接逃逸，断言 `resolved` 落在链接目标上 |
| 9 | `tests/integration/remote/tunnel-status.test.ts:90-98` | **强**：只把 `https.request` 传输替换成本地 edge，**真实 `probeTunnel` + 真实子进程 fixture**；但 `skipIf(win32)` |
| 10 | `tests/remote-auto-connect.test.ts:89-157` | **中**：状态机分支覆盖好，但子进程是 fake、健康探针是 mock → "ready" 全由 mock 决定 |
| 11 | `tests/agent-resource-isolation.test.ts:588`（message_end 钩子） | **中**：断言 `streamId` 稳定 + JSONL entry id 一致，很细；但依赖 `session.agent.streamFunction` 这种 SDK 内部字段赋值（SDK 升级即碎） |
| 12 | `tests/agent-resource-isolation.test.ts:702`（越界写被闸门挡） | **中**：断言拒绝理由可读 + 同回合内合法写仍落盘；闸门的上层策略只在 workspace 档验证 |
| 13 | `tests/components/chatwindow-stick-bottom.test.tsx:39` | **中**：用假 scroller 造 `scrollTop`，断言贴底/松手行为正确；只在 jsdom 成立 |
| 14 | `tests/lib/sandbox/escalation.test.ts:77-96`（档位决策） | **中**：只断言"选了哪个 mode"，`exec` 的真实失败被 `:73` 的 `.catch(() => undefined)` 吞掉 |
| 15 | `tests/agent-events-route.test.ts:9-36,105`（SSE/长轮询） | **弱**：把 `agent-manager` 整段**重实现**成假对象（buffer/subscribe/sseEventId 都是手写），路由契约对齐的是这份假契约 |
| 16 | `tests/remote-pair.test.ts:13-21` | **弱**：`remote/supervisor` + `web-secret` 都 mock，"地址就绪才发码"由假状态驱动 |
| 17 | `tests/components/context-meter/session.test.tsx:28-32,46-52` | **弱**：快照 fixture 手写，服务端 `WebSnapshot` 形状变了这里不会红 |
| 18 | `tests/components/settings-usage-card.test.tsx:14,50` | **弱**：断言绑定内联样式串 `0.5px solid var(--dsw-border-l2)` —— 改样式即碎（或改为 class 后断言假通过） |
| 19 | `tests/components/chatwindow-cancellation-timing.test.tsx:26-35` | **弱**：同时钉 `data-collapsed`/`aria-hidden`/`inert` 三个实现属性，行为对但耦合高 |
| 20 | `tests/components/prompt-panel.test.tsx:52` | **弱**：`getAllByText("项目").length > 0` 只证明"有东西渲染"，任何徽标都满足 |
| 21 | `tests/pi-settings.test.ts:150-151` | **弱**：`setTimeout(100)` 后断言"文件还没变" —— 负向断言，写盘进程还没轮到就会绿 |
| 22 | `tests/growth-tracker.test.ts:9-15` | **弱**：自写 `waitFor` 轮询 8s + 真 `setTimeout` + `throw new Error("timeout")`，负载高时 flake |
| 23 | `tests/components/settings-confirm-dialog.test.tsx:19` | **可维护性差**：一个 `it` 跨 :19–:112（94 行），其中绝大部分是内联 fetch fixture，真正断言只有 7 条、`fireEvent` 5 次；"Escape 只关最上层""背景不滚""确认后回调一次"混在一条用例里 |
| 24 | `tests/agent-resource-isolation.test.ts:747-750` | **假绿**：非 win32 / 无 koffi 时 `return` 而不是 skip（见 P1-1） |

## 1. 发现（按严重度降序）

### P0-1
无。**没有发现**会写坏用户真实数据、或让 `~/.pi` 被污染的测试。逐个核对过的关键点：
- `resource-refresh.test.ts:31-33` 把 `PI_CODING_AGENT_DIR` **和 `HOME`** 都 `vi.stubEnv` 到临时目录，`:81,138` 里出现的 `process.env.HOME` 是桩值，**不是**真实家目录（这条我特意查了，不是污染）。
- `agent-resource-isolation.test.ts:34`、`session-reader`/`workspace-store`/`pi-settings`/`plugins-service`/`files-service-upload`/`web-secret`/`path-security` 等凡是要落盘的，全部显式指到 `os.tmpdir()` 子目录。
- 唯一"贴着真实用户目录"的是 `tests/lib/tool-preset.test.ts:11` 真实 import `@/lib/pi` 且不隔离 agent 目录，但它只调纯函数（`presetAllowsTool`），`src/lib/pi.ts` 模块级没有读盘副作用（`:35-39` 只有变量声明；`modelFilesFingerprint` 首次调用在函数体内，且只 `statSync` 不读内容，`src/lib/model-files.ts:12`）。
- 未测到的真实风险：`src/lib/session-import/paths.ts` 用 `os.homedir()` 拼各来源根目录（`paths.ts:9-11`），但被 mock 掉了，所以连"误读真实 `~/.claude`"这类问题也不会暴露（见 P2-5）。

### P1-1 沙箱端到端测试在非 Windows 或没有 koffi 的机器上"静默变绿"

- **位置**：`tests/agent-resource-isolation.test.ts:747-750`
- **证据**：
  ```ts
  it("runs workspace-tier bash through the OS sandbox: inside writes land, outside writes are refused", async () => {
      if (process.platform !== "win32") return;
      const { probeSandboxSupport } = await import("../src/lib/sandbox/manager");
      if (!(await probeSandboxSupport())) return; // 没有 koffi 的机器上跳过
  ```
- **触发路径**：`npx vitest run tests/agent-resource-isolation.test.ts`（Linux/macOS，或 Windows 上 koffi 没装成）→ 该用例走两个 `return`，vitest 记为 **passed**。
- **后果**：它守的是"workspace 档的 bash 必须真的进 OS 沙箱、越界写必须失败"这条安全边界。在 Linux/macOS lane（CI 有一半是 ubuntu）和"optionalDependency 装失败"的 Windows 上，这条边界**零验证却显示绿色**。
  本机基线**确实真跑了**（我单独跑了这一条：`npx vitest run tests/agent-resource-isolation.test.ts -t "runs workspace-tier bash through the OS sandbox"` → `✓ ... 1250ms`，koffi 3.3.8 已装），所以问题不是"基线说谎"，而是**同一个 commit 在 ubuntu lane 上这条会静默通过**，报告里看不出差别。同文件其余 `if (...)` 早退共 3 处，`:600` 的是合法的事件过滤，`:748/:750` 这两处才是假绿。
- **置信度**：已确认（读了代码；本机单条实跑 1250ms 证明确实执行；vitest 语义是函数返回即通过）。
- **建议修法**：改成 `it.skipIf(process.platform !== "win32")` 与 `ctx.skip()`（第二个判断放测试体第一行），让报告里出现 skip 计数，别混进 passed。

### P1-2 `windows-acl` / `readonly-mode` 两个沙箱测试在 koffi 缺失时不是跳过而是崩（注释与实现相反）

- **位置**：`tests/lib/sandbox/windows-acl.test.ts:8-9,19,27`；`tests/lib/sandbox/readonly-mode.test.ts:15,29,39`
- **证据**：
  ```ts
  // windows-acl.test.ts:8-9（注释）
   * 非 Windows、或本机没有 koffi（optionalDependency 没装上）时整体跳过——
   * `createAclSandbox` 返回 null 就是「这台机器上没有 shell」，调用方照 fail closed 处理。
  // :19
  describe.skipIf(!win32)("windows acl sandbox", () => { ...
  // :27
  const result = await sandbox!.exec(command, { cwd: workspace, onData: (chunk) => chunks.push(chunk) });
  ```
  ```ts
  // readonly-mode.test.ts:29
  sandbox = await createAclSandbox({ writableDirs: [], tempDir: null });
  // :39
  const result = await sandbox!.exec("type nul", { cwd: workspace, onData: ... });
  ```
  而 `src/lib/sandbox/windows-acl.ts:122-124` 明确：`if (process.platform !== "win32") return null;` / `const koffi = ...` / `if (!options.spawnRestricted && !koffi) return null;`
- **触发路径**：Windows 上 `npm ci` 没装成 `koffi`（`package.json` 里是 `optionalDependencies`，装失败 npm 只警告、CI 照跑）→ `beforeAll` 把 `sandbox` 设成 `null` → 第一个 `it` 里 `sandbox!.exec` 抛 `TypeError: Cannot read properties of null`。
- **后果**：把"本机没有沙箱后端"这种情况从 **skip** 变成 **fail**，而且失败信息是 `TypeError`，看起来像测试/产品代码坏了，实际只是 optional 依赖没装。CI 矩阵里 Windows lane 会整条红；本地新克隆也红。注释承诺的行为和代码不一致，维护者会被误导。
- **置信度**：已确认（三个文件的 null 语义都读过了）。
- **建议修法**：`beforeAll` 里 `if (!sandbox) ctx.skip()`（vitest 支持 `beforeAll` 接收 ctx）或在每个 `it` 开头 `if (!sandbox) return ctx.skip()`；同时把 `manager.test.ts:43` 的静默 `return` 一并改成 `ctx.skip()`，三处口径统一。

### P1-3 14 个 growth 用例在"没有 git"的机器上静默通过

- **位置**：`tests/growth-service.test.ts:110,169,205,223,234,249,271,298,346,369,394,411`（12 处）+ `tests/growth-tracker.test.ts:29,90`（2 处），另有 `tests/lib/permission-gate.test.ts:91`（1 处，win32 大小写）
- **证据**：
  ```ts
  // growth-service.test.ts:110 附近，12 个 it 都是这个开头
  if (!available) return;
  // growth-tracker.test.ts:29
  if (!(await isAvailable())) return;
  ```
  `isAvailable()` 在 `src/lib/growth-service.ts:789`，内部依赖真实 `git` 可执行文件。
- **触发路径**：任何没有 `git` 的环境（精简容器、某些 CI 镜像、Windows 上 PATH 里没有 Git）跑 `npm test` → 这 14 个用例记 passed。
- **后果**：生长跟踪（growth）是这个项目里**用真实 git 提交**记录每轮改动的功能，风险面在"提交时序、基线、失败降级"。它最核心的 14 条断言在缺 git 时会集体消失，而报告只显示 "1648 passed" 且总时长变短——没有任何信号说明"这批根本没跑"。全仓统计：**18 处这种静默早退**（growth-service 12、growth-tracker 2、agent-resource-isolation 2、sandbox/manager 1、permission-gate 1），其余 6 处是真的控制流分支。
- **置信度**：已确认。
- **建议修法**：统一改 `ctx.skip()`（或 `it.skipIf(!gitAvailable)`），并在 `vitest.config.ts` 之外加一条 CI 断言：`skipped` 数不得高于某个基线（例如 `--reporter=json` 后校验 skipped 列表 ∈ 白名单）。

### P2-1 `agent-events-route` 测试把 `agent-manager` 的契约整段重写，路由只对齐了这份假契约

- **位置**：`tests/agent-events-route.test.ts:9-36`（mock 定义）、`:105`（唯一一处"宽限"断言）
- **证据**：
  ```ts
  const manager = vi.hoisted(() => {
      const state = { seq: 0, buffer: [] as {...}[], subscribers: new Set<Send>() };
      return { state, publish(json) {...}, getManaged: () => state,
          parseLastEventId: (_m, raw) => {...}, sseEventId: (_m, seq) => `ep.${seq}`,
          buildSnapshot: async () => ({ seq: state.seq, messages: [] }),
          subscribe: (_m, send, last) => {...}, ...
          holdViewer: vi.fn() };
  });
  vi.mock("../src/lib/agent-manager", () => manager);
  ```
- **触发路径**：任何对 SSE 帧格式/续传语义的改动都会在那份假对象里先满足，测试看不见真实实现。
- **后果**：`src/lib/agent-manager.ts` 里真实的 `subscribe/unsubscribe/sseEventId/parseLastEventId/holdViewer`（`:2588-2625`）语义与假实现是**两份独立实现**；真实实现若把 `subscribe` 的返回值语义（`:2588` 附近）改掉、或 `holdViewer` 的宽限时长改成别的常量，这条测试仍绿。这是本仓最典型的"mock 到永远绿"，且它恰好守着"重连必须不丢事件"这条用户可见行为。
- **置信度**：已确认（假对象逐行读过；真实现只读了导出签名与行号）。
- **建议修法**：把 `subscribe/parseLastEventId/sseEventId` 的真实行为挪进 `agent-resource-isolation`（那里有真 `Managed`）：发布 N 条、`subscribe(m, send, k)` 断言只补发 `seq > k` 的帧、`parseLastEventId` 对 `ep.999`/`ep.abc`/`null` 的返回。

### P2-2 公网隧道（public tunnel）的真实链路在 CI 里永不执行

- **位置**：`tests/remote-auto-connect.test.ts:10-12`（两个 mock）、`tests/remote-tunnel.integration.test.ts:24,66`
- **证据**：
  ```ts
  // remote-auto-connect.test.ts:11-12
  vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), spawn: mocks.spawn }));
  vi.mock("@/lib/remote/tunnel-health", () => ({ probeTunnel: mocks.probe }));
  // remote-tunnel.integration.test.ts:24
  const RUN = process.env.PIWEB_TEST_TUNNEL === "1";
  // :66
  it.runIf(RUN)("serves the LAN entry through a public https URL with the mobile CSS injected", ...)
  ```
- **触发路径**：`npm test`（CI 从不设 `PIWEB_TEST_TUNNEL`）。
- **后果**：`startPublic` 的真实行为——`spawn` 失败（ENOENT/权限）、cloudflared 真实 stdout 格式、真实 `kill()` 与 `exit` 顺序、`stopPublic` 的 3 秒收尾（`src/lib/remote/supervisor.ts:600-602`）——**全部只有 fake 覆盖**。fake child 是 `EventEmitter` + 手动 `emit("exit")`，与 Windows 上 `child.kill()` 后再等 exit 的真实时序不同（正是这类平台差异导致过的 bug）。手机扫码入口是产品主路径，而它唯一的真实端到端测试被环境变量锁住、文档里也没说怎么跑。
- **置信度**：已确认。
- **建议修法**：至少补一条"真子进程但假 cloudflared"的测试：用一个 `#!/usr/bin/env node`（Windows 下用 `node script.js` + `PIWEB_CLOUDFLARED` 指向 .cmd 包装）的 fixture 脚本，走真实 `spawn`/`kill`/exit 路径（`tunnel-status.test.ts` 已经这么干了，但它 `skipIf(win32)`——把它的 fixture 思路搬到 Windows 可跑的用例里）。

### P2-3 `tunnel-health.ts` 的真实实现（59 行）在 Windows lane 从不执行

- **位置**：`tests/integration/remote/tunnel-status.test.ts:20`（`describe.skipIf(process.platform === "win32")`）、`:90-91`（只替换 https 传输）
- **证据**：
  ```ts
  describe.skipIf(process.platform === "win32")("tunnel status through API, process and HTTP", () => {
  ...
  vi.spyOn(https, "request").mockImplementation(((options, callback) =>
      http.request({ ...options, host: "127.0.0.1", port, agent: false }, callback)) as typeof https.request);
  ```
- **触发路径**：Windows 上跑全量 → 这个文件整文件 skip；`remote-auto-connect.test.ts` 又把 `tunnel-health` 整个 mock 掉。
- **后果**：`probeTunnel` 里有相当多的平台无关分支——Cloudflare challenge 头、`1033` 文本识别、16KB 响应上限、`success/data.ok/service==="piweb"` 校验、8s 超时（`src/lib/remote/tunnel-health.ts:24-58`）——在**主目标平台 Windows** 上零覆盖。而这些错误的展示文案正是用户看到的"连不上"提示。
- **置信度**：已确认。
- **建议修法**：把 `probeTunnel` 的纯逻辑部分（响应头/大小/JSON 判定）抽成可注入 `request` 的函数，或在 Windows 上用一个 `https` 本地 server + `NODE_EXTRA_CA_CERTS`（或直接对 `http` 走私）跑；最低成本是补 5 条 `it`：challenge / 1033 / >16KB / 非 piweb JSON / 超时。

### P2-4 242 处 `waitFor` 全部用默认 1s 超时，其中不少在等真实 SDK 流、真实子进程

- **位置**：全仓统计（`waitFor` 242 次，`timeout` 参数 0 次）；典型：`tests/agent-resource-isolation.test.ts:323,326,334,618,663,682,685-689`、`tests/components/*`（`jsdom` 下 100+ 处）
- **证据**：
  ```ts
  // agent-resource-isolation.test.ts:323
  await vi.waitFor(() => expect(calls).toBe(1));
  // :685-689（三连等真实 SDK 收尾）
  await vi.waitFor(() => expect(m.runActive).toBe(false));
  await vi.waitFor(() => expect(session.resourceLoader.getExtensions().runtime).not.toBe(runtime));
  await vi.waitFor(() => expect(m.resourceReloading).toBe(false));
  ```
- **触发路径**：`maxWorkers: 4` + 4 个 worker 里都有真 SDK/真 git/真子进程（`vitest.config.ts:14` 自己写了"heavvy fixtures ... can exceed the 5s default"）→ CI 上更慢的机器、或并发 4 个重测试时，单次 `waitFor` 的 1s 窗口被突破。
- **后果**：`testTimeout: 30_000` 保护的是整个用例，`waitFor` 的 1s 是**另一个**独立的、更紧的窗口。这类失败表现为"偶发红、重跑就绿"，是最难排查的一类 flake。全量 312s 里 `environment 40% + import 32%` 说明环境本身就慢，1s 窗口余量不大。
- **置信度**：疑似（需要多跑几轮复现；建议 `npx vitest run --repeat 3` 观察）。
- **建议修法**：把 `@testing-library` 的 `asyncUtilTimeout` 或 `vi.waitFor` 的默认超时统一调到 3–5s（`vitest.config.ts` 里 `test.waitFor` 没有全局项，就在 `tests/setup-dom.ts` 里 `configure({ asyncUtilTimeout: 4000 })`，`vi.waitFor` 处则逐个补 `{ timeout: 5000 }`）。

### P2-5 session-import 五个来源的坏数据容错分支 0 命中

- **位置**：`src/lib/session-import/claude.ts:147,172`；`codex.ts:123,150`；`grok.ts:21,44,76,107`；`dsh.ts:54-55,146,189`；`oc-family.ts`/`sqlite.ts` 的 SQLite 打开路径。测试侧：`tests/session-import-sources.test.ts`（498 行）里 "坏/损坏/truncat/malformed/invalid" **0 命中**。
- **证据**（以 claude 为例）：
  ```ts
  // claude.ts:147 / :172 —— 行解析失败与文件读取失败都被 catch 掉
  } catch {
  ```
- **触发路径**：用户本机的 `~/.claude/projects/**/*.jsonl` 里有一行写坏（进程被杀、磁盘满），或某个来源的数据库被独占/损坏 → 导入流程。
- **后果**：这些 `catch` 决定"坏一行是跳过还是整条会话失败"、"坏一个文件是跳过还是整个来源报错"。**没有任何测试**固定这个语义，改错方向（例如把"跳过坏行"改成"整条失败"）不会被发现。产品语义上"某来源坏掉不能影响其它来源"在服务层测了（`session-import-service.test.ts:107`），但单条记录级别的容错没测。
- **置信度**：已确认（`catch` 位置来自 grep，测试文件关键词 0 命中）。
- **建议修法**：每个适配器补 1–2 条：① fixture 里塞一行 `"{not json"`，断言仍能导入其余消息且 `skipped` 计数 +1；② 截断的 `.jsonl.zstd`（dsh）断言不抛、返回空或部分会话；③ 损坏的 sqlite 文件断言错误信息可读。

### P2-6 14 个 API 路由零执行，其中 `sessions/[id]` 有分支逻辑

- **位置**：`src/app/api/sessions/[id]/route.ts:16-19,23-36`（`BoundaryError ? 400 : 500`；DELETE 的 `disposeSessionPath → deleteSession → forgetSession` 顺序）；零执行清单见 0.3A
- **证据**：
  ```ts
  // src/app/api/sessions/[id]/route.ts:26-30
  const sessionPath = await resolveSessionPath(id, { allowPending: true });
  await disposeSessionPath(sessionPath);
  await deleteSession(sessionPath);
  await forgetSession(sessionPath);
  ```
- **触发路径**：`DELETE /api/sessions/<id>`（侧栏删除会话）。
- **后果**：① 顺序若被改错（先 delete 后 dispose），正在跑的会话会在删除后继续往已删文件写，而测试不会红；② `BoundaryError` 必须映射 400，若退化成 500，前端会把"越界 id"当成服务器故障重试；③ 中间步骤失败时的部分完成状态没人钉。这三条都是"用户删会话"这个高频动作。
- **置信度**：已确认（读了路由全文，`tests/` 里没有 import 该路由）。
- **建议修法**：在 `tests/api/` 加 `session-delete.test.ts`：mock `disposeSessionPath`/`deleteSession`/`forgetSession` 记录调用序；断言越界 id → 400；断言 dispose 抛错时不调用 delete。

### P2-7 测试进程真的在 `0.0.0.0` 上开监听

- **位置**：`tests/remote-supervisor.test.ts:96-103`（`set-plugin` 打开 LAN 入口的用例）+ `src/lib/remote/supervisor.ts:383`（`startLan(port = remoteLanPort(), host = "0.0.0.0", ...)`）
- **证据**：
  ```ts
  // remote-supervisor.test.ts:96-103
  it("still opens the LAN entry in the chosen mode once remote access is allowed", async () => {
      process.env.PI_WEB_AUTH = "1";
      delete process.env.PIWEB_REMOTE_LAN;
      expect((await setPlugin(false)).status).toBe(200);
      expect(remoteStatus().lan).toMatchObject({ running: true, styled: false });
  ```
- **触发路径**：跑测试的机器（开发机、CI runner）→ `setPlugin` 内部走 `startLan()` 默认参数 → 在 **所有网卡** 上临时开一个代理监听（端口是 `freePort()` 随机）。
- **后果**：该监听要求认证（`PI_WEB_AUTH=1`），但仍会在开发机的局域网/Docker/WSL 网卡上短暂暴露一个 PiWeb 代理入口；在 Windows 上还可能触发防火墙弹窗（无人值守 CI 下若策略严格会阻塞）。同文件 `:116-123` 的并发 `startLan` 用例显式传了 `"127.0.0.1"`，说明作者知道该这么传，只有 `set-plugin` 用例漏了。
- **置信度**：已确认（`startLan` 默认值 + 该用例未改端口断言）。
- **建议修法**：在 `set-plugin` 的 `beforeEach` 里加 `process.env.PIWEB_REMOTE_LAN_HOST = "127.0.0.1"`（若产品不支持该 env，则改为断言 `remoteStatus().lan.urls` 前 mock `startLan`，把"是否开监听"与"开在哪"分开测）。

### P3-1 断言实现细节：`settings-usage-card` 绑定内联样式字符串

- **位置**：`tests/components/settings-usage-card.test.tsx:14,50`
- **证据**：`const CARD_BORDER = '0.5px solid var(--dsw-border-l2)';` / `const card = name.closest(\`div[style*="${CARD_BORDER}"]\`);`
- **后果**：把边框改成 class、或把 `0.5px` 改成 `1px`，"额度在卡片内"这个真需求没变但测试红；反过来，若以后出现另一个带同款内联样式的兄弟节点，测试会**绿得没有意义**。这是全仓唯一一处把视觉样式串当选择器的地方。
- **建议修法**：给卡片加 `data-testid="usage-card"`（或 `data-provider-card`），用 `closest('[data-provider-card]')`。

### P3-2 断言实现细节：`chatwindow-cancellation-timing` 三件套属性

- **位置**：`tests/components/chatwindow-cancellation-timing.test.tsx:26-35`
- **证据**：同时断言 `data-collapsed="true"`、`aria-hidden="true"`、`hasAttribute("inert")`，点开后又逐个断言为 null/false。
- **后果**：`inert`+`aria-hidden` 是行为（可达性）也说得过去，但 `data-collapsed` 是纯实现属性；三者绑定后，任何折叠实现重构（改用 `hidden`/`display:none`/`<details>`）都会红，而"折叠后不可聚焦/不可见"这个真需求只需 1–2 条断言。
- **建议修法**：保留 `aria-hidden` + `inert`（这是"不可交互"的语义），`data-collapsed` 改为断言"内容不可见"（`toBeVisible` 不适用于 jsdom，则用 `closest('[aria-hidden="true"]')`）。

### P3-3 存在性断言偏弱（`prompt-panel` 等）

- **位置**：`tests/components/prompt-panel.test.tsx:52`（`expect(screen.getAllByText("项目").length).toBeGreaterThan(0)`）；同类弱存在断言集中在 `context-meter.test.tsx`（24 处 `toBeTruthy`）、`session-import-panel.test.tsx`（22 处）。
- **后果**：311 处 `toBeTruthy()` 里，凡是对 `getAllByText(...).length > 0` 的用法，都只证明"页面里有这个字符串"，不证明"这条数据被归到了正确分组/来源"。`prompt-panel` 真正该钉的是"`AGENTS.md` 归到『项目记忆』组、技能归到『技能提示词』组"，现在只断言了分组标题和徽标各自存在。
- **建议修法**：把断言改成"行 → 所属分组"的结构性断言（`within(group).getByText("AGENTS.md")`）。

### P3-4 手写契约 fixture（`context-meter/session`、`remote-pair`）

- **位置**：`tests/components/context-meter/session.test.tsx:28-32`（手写 `snapshot()`）、`tests/remote-pair.test.ts:13-21`（mock supervisor 的 status 形状）
- **后果**：`WebSnapshot` / `RemoteStatus` 这些跨层结构被复制进测试，真结构变了测试不会红（TypeScript 也拦不住，因为 fixture 是 `unknown[]` / 手写对象）。这类 mock 在 `agent-resource-isolation` 里有真快照可对照，建议至少加一条"真 `buildSnapshot` 的字段 ⊇ fixture 字段"的守卫测试。
- **建议修法**：`snapshot()` 的返回类型改成 `satisfies WebSnapshot`（或 `Pick<...>`），让 `tsc --noEmit` 在结构漂移时直接报错——这条对 CI 零成本。

### P3-5 负向时间断言可能假绿

- **位置**：`tests/pi-settings.test.ts:149-151`
- **证据**：`const update = patchPiSettings({...}); await new Promise((r) => setTimeout(r, 100)); expect(await fs.readFile(file, "utf8")).toBe("{}");`
- **后果**：断言的是"100ms 内没写盘"。如果被测方的重试逻辑是 200ms 才开始、或机器慢到 100ms 内还没跑到写盘点，这条断言**永远成立**——它证明不了"锁被尊重"。真正的证据是下一行"释放锁后写入成功"（`:152-156`，这条是好的）。
- **建议修法**：把 100ms 换成"等被测方明确到达等待锁的状态"（例如暴露一个 hook/计数，或用 `vi.waitFor` 等 `patchPiSettings` 内部的锁重试计数 ≥1），再做负向断言。

### P3-6 超大单测：`settings-confirm-dialog`

- **位置**：`tests/components/settings-confirm-dialog.test.tsx:19-112`（一个 `it`，94 行），文件里只有 2 个 `it`
- **证据**：该块内 `expect(` 只有 **7** 次、`fireEvent.` 5 次，其余全是内联 fetch fixture（`:24-` 起的 `/api/models?custom=1` provider 数据等，约 40 行 JSON）。
- **后果**：三种不同行为（Escape 只关最上层 / 背景不滚 / 确认回调）混在一条用例里，且大段 fixture 内联在测试体内，改一处 provider 字段要翻 90 行。对 `settings-*` 这一组（7 个文件里 5 个都这么写）来说，fixture 无法共享，字段漂移时只能一个文件一个文件改。
- **建议修法**：把 provider fixture 提到文件级常量（或 `__fixtures__`），把 94 行的用例拆成 3 个 `it`，`beforeEach` 里共享 `setup()`。

### P3-7 `escalation` 用 `catch(() => undefined)` 吞掉本地执行错误

- **位置**：`tests/lib/sandbox/escalation.test.ts:72-75`
- **证据**：`await operations.exec("echo hi", "C:\\ws", { onData: () => {} }).catch(() => undefined);` 注释也写了"C:\ws 不存在会抛错——这里只关心有没有进沙箱"
- **后果**：可接受（该用例只断言选了哪个 mode），但 `full` 档（不走沙箱、本地直跑）这条**最危险**的路径在测试里从来没成功执行过一次。
- **建议修法**：把 cwd 换成真实临时目录，断言 `full` 档的 `exec` 真的跑出输出。

### P3-8 `packaging` 真跑 `npm pack`

- **位置**：`tests/packaging.test.ts:84,97,102,111,122`（`verifyPackedPackage` 内部打真实 tarball），每条 `:87,103,112,130` 给 60s 超时
- **后果**：测试依赖 PATH 上有 `npm`、能写临时目录、能跑打包；在受限沙箱/无 npm 环境里会 5 条一起红（不是 skip）。它是"发布契约"的唯一守卫，值得留，但应在缺 npm 时 `ctx.skip()` 而不是崩。
- **建议修法**：`beforeAll` 里探测 `npm --version`，不可用时 `ctx.skip()` 并打印原因。

## 2. 缺失的测试

按风险降序（1 最高）。"为什么重要"尽量给到真实故障场景。

| # | 行为 | 为什么重要 | 建议测什么（断言） |
|---|---|---|---|
| 1 | **沙箱 e2e 在非 Windows/无 koffi 时显式跳过** | 现在静默绿，安全边界零验证（P1-1/P1-2） | `ctx.skip()` 后断言 skipped 列表包含该用例；CI 断言 skipped 数不超基线 |
| 2 | **`reap()` 空闲会话回收**（`src/lib/agent-manager.ts:2184`，`IDLE_MS` `:82`） | 10 分钟不活跃即释放；错了就内存/句柄泄漏或**误杀正在看的会话** | 有 viewer 时不回收；无 viewer 且超 `IDLE_MS` → 从 map 移除且 `getManaged` 返回新对象；`isStreaming` 时不回收 |
| 3 | **`BUFFER_CAP=400` 环形缓冲**（`:84`、`:538`） | 事件缓冲无上限会吃内存；裁剪错了会让断线重连丢历史 | push 401 帧后 `buffer.length === 400` 且 `buffer[0].seq === 2`；`subscribe(m, send, 1)` 仍能从最旧帧补齐 |
| 4 | **`holdViewer` 真实实现**（`:2615`） | 长轮询两次请求之间靠它保命，回收早了会话被踢 | 宽限期内 `reap()` 不回收；超时后回收；`unsubscribe` 清定时器 |
| 5 | **`sessions/[id]` DELETE 路由**（`src/app/api/sessions/[id]/route.ts:23-36`） | 用户高频操作；顺序错→写入已删文件；错误映射错→前端误判 | `dispose → delete → forget` 调用序；`BoundaryError` → 400；dispose 抛错时不 delete |
| 6 | **session-import 坏数据**（5 个适配器 `catch`） | 用户本机历史里坏一行很常见（P2-5） | 坏行被跳过且 `skipped` +1、其余消息仍导入；截断 zstd 不抛；损坏 sqlite 报可读错误 |
| 7 | **`session-import/paths` 真实路径** | 被 mock，路径写错则"扫不到任何会话"（用户看到空列表） | 各来源 root 与 `os.homedir()` 的拼装；Windows 分隔符；`~` 兜底解析 |
| 8 | **`probeTunnel` 真实分支**（Windows lane） | 用户看到的"连不上"文案全在这里（P2-3） | challenge→特定文案；1033→特定文案；>16KB→拒；非 piweb JSON→拒；8s 超时→拒 |
| 9 | **`startPublic` 真子进程生命周期**（Windows 可跑） | 现在只有 fake child（P2-2） | ENOENT → 安装提示且 `engineAvailable=false`；kill 后 3s 内状态归零；exit 后重连且只发一次新地址 |
| 10 | **撤销会话 cookie 的竞态窗口** | 撤销后旧 cookie 必须立刻失效 | 签发 cookie → 撤销 → 用同一 cookie 请求 API 得 401；撤销写入与读取交错时不出现"撤销丢失" |
| 11 | **`syncSessionsFromDisk()`**（`:1216`） | 外部新增/删除 JSONL 后侧栏要同步 | 新增文件出现后被列出；已管理的会话对象不被替换；删除后从 map 移除 |
| 12 | **`web-secret` 轮换与 revocations 文件损坏** | 轮换后旧 cookie 必须全失效；文件坏了不能 fail-open | 轮换 → 旧 cookie 401；revocations 文件截断/非法 JSON → 保守拒绝（或明确记录 fail-open 决策） |
| 13 | **`createAclSandbox` 的失败分支**（`windows-acl.ts:242-244`） | fail-closed 是安全前提；只有一条"目录不存在"被测 | `CreateRestrictedToken`/`SetTokenInformation` 抛错 → 返回 null 且调用方剔除 bash 工具 |
| 14 | **`models.json` 写盘更多失败态** | 已有 EACCES；盘满/跨卷会留下半写文件 | ENOSPC / EXDEV → 原文件不变、`.tmp` 被清理、错误可读 |
| 15 | **API 鉴权矩阵（34 个路由 × 未认证）** | 14 个路由零执行，逐路由补测不现实 | 未带 cookie/token 请求每个路由 → 401/302；`Host` 不在 allowlist → 拒绝 |
| 16 | **growth 无 git 时显式跳过 + needs-consent 路径** | 14 条断言会静默消失（P1-3）；`allowInit=false` 的"未同意不建仓库"是隐私边界 | `ctx.skip()`；`allowInit=false` 时抛 `needs-consent` 且目录里没有 `.git` |
| 17 | **`disposeSession` 期间正在流式/reload 的会话** | 服务重启/空闲回收会发生，泄漏订阅者或定时器 | dispose 后 `subscribers.size === 0`；不留未清定时器；`disposeSessionPath` 幂等 |
| 18 | **`settings-write-lock` 死锁恢复** | 锁文件残留会让设置页永久卡住 | 持有者崩溃（进程被杀）后新进程能在超时内拿到锁 |
| 19 | **UI 真集成：真 `usePiWeb` + 真快照** | 8 个 `app-shell-*` 测试把 `usePiWeb`/`SessionSidebar`/`ChatWindow` 全 mock 了 | 至少 1 条真 hook + 假 EventSource 的端到端（`context-meter/session.test.tsx` 已是这个模式，值得扩到会话切换/草稿） |
| 20 | **`package.json` 结构守卫（fixture 类型化）** | P3-4 的根因：手写 fixture 不随源码漂移 | `satisfies WebSnapshot` / `satisfies RemoteStatus`，让 `tsc` 兜住 |

## 3. 与其他区域的可能交叉点

1. **sandbox/权限 区域**：`src/app/api/sandbox/route.ts:25` 的三元 `err instanceof SyntaxError ? 400 : 400` 恒等于 400（疑为笔误）。该路由**零测试**（0.3A），所以没人钉住 PUT 的错误码语义。请 sandbox 区域确认这是有意（一律 400）还是漏改。
2. **bridge 区域**：`reap()`/`BUFFER_CAP`/`holdViewer`/`syncSessionsFromDisk` 在 `src/lib/agent-manager.ts` 里是资源生命周期的一部分（`:82,84,538,1216,2184,2615`），**全仓 0 测试引用**。请 bridge 区域确认这几个函数的语义（尤其 `hasViewers` 与 `lastActive` 的更新点），我按"疑似内存/句柄泄漏面"记，但没读完整实现，不敢下结论。
3. **API/鉴权 区域**：`src/proxy.ts` 的鉴权门禁本身有 284 行 `proxy-auth.test.ts` 覆盖，但 **14 个从未被测试 import 的路由**在鉴权矩阵里是空白（0.3A）。如果某个路由在 `proxy.ts` 的 matcher 之外，就是越权风险；请鉴权区域确认 matcher 覆盖是否与 `src/app/api/**` 一一对应。
4. **remote 区域**：`startPublic` 真实子进程与 `tunnel-health` 在 Windows 的零覆盖（P2-2/P2-3）意味着"手机上连不上"这类问题只能靠用户反馈发现。请 remote 区域确认 cloudflared 在 Windows 上的退出/杀进程时序是否与 fake child 一致。
5. **UI 区域**：`settings-*`/`chatwindow-*` 有 7 处断言绑定实现细节（P3-1/P3-2），如果 UI 区域计划重构样式或折叠实现，这批测试会一起红。建议重构前先把这些断言换成 `data-*` 稳定选择器。
6. **session-import 相关**：`paths.ts` 被两个测试文件整体 mock（`session-import-service.test.ts:14`、`session-import-sources.test.ts:22`），真实路径解析从未验证；若 session-import 区域要改来源根目录，测试不会给任何信号。

## 4. 建议优先修的 3 件事

1. **把所有"静默早退"改成显式 skip**（P1-1、P1-2、P1-3）：18 处 `if (...) return;` 改为 `ctx.skip()`，并在 CI 加一条"skipped 清单必须是白名单的子集"的守卫。这一步不增加任何覆盖率，但立刻让总账可读——目前 ubuntu lane 上那条沙箱安全用例、以及缺 git 环境下的 14 条 growth 用例都会混进 passed，`skipped` 数完全反映不出"这批没跑"。
2. **补 agent-manager 的资源生命周期测试 + `sessions/[id]` DELETE 路由**（P2-6、§2 #2/#3/#4/#5）：`reap`/`BUFFER_CAP`/`holdViewer` 全仓 0 引用，而它们是"空闲回收 + 断线续传"的正确性基础；DELETE 路由是用户高频操作且含分支，14 个零执行路由里唯一带逻辑的。
3. **补 session-import 坏数据 + 真实路径**（P2-5、§2 #6/#7）：5 个适配器的 `catch` 分支零命中，而用户本机历史"坏一行"是常态；`paths.ts` 被 mock 意味着"扫不到会话"这类故障永远不会在测试里出现。
