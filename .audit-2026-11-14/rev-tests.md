# 测试质量审查（rev-tests）— 2026-11-14

审查对象：相对 HEAD `1d4efba9054909cd9c8b2788028ce704c99b03ea` 的未提交工作区。
范围：`tests/` 全部改动与新文件、`scripts/testing/check-skips.mjs`（新）、`vitest.config.ts`。
方法：纯静态分析（read/grep/glob + 只读 git diff）。未运行 npm/vitest/构建。

---

## 发现清单

### [HIGH] scripts/testing/check-skips.mjs:6-29
**问题**：check-skips 的 windowsOnly 允许清单与实际测试标题脱节：windows-acl.test.ts 有 6 个真实标题不在清单内，且清单里有 1 条已失效的旧标题；manager.test.ts 有 1 个真实标题不在清单内。
**触发条件**：check.yml 在 ubuntu-latest 上运行（矩阵含 ubuntu-latest，`node scripts/testing/check-skips.mjs` 在 `if: always()` 下执行）。`tests/lib/sandbox/windows-acl.test.ts:12` 与 `manager.test.ts:8` 整个 `describe.skipIf(!win32 …)` 在 Linux 上全量跳过，JSON 报告中这些用例以 skipped 出现，全部不在允许清单内 → `unexpectedSkips` 抛错。
**期望行为**：Linux CI 上被平台跳过的每一条都应在 windowsOnly 清单里（或清单与标题自动对账）。
**实际行为**：ubuntu 两个 node 版本的 check job 必红（合计 7 条 unexpected skip）。
**证据**：
- 清单内失效条目：`"bounds total pipe output and kills a noisy command"`（check-skips.mjs:18）——实际标题是 `tests/lib/sandbox/windows-acl.test.ts:149` 的 `"stops forwarding output past the limit but lets the command finish"`。
- 实际存在但清单缺失：`windows-acl.test.ts:65` `"does not expose API keys, credentials, PiWeb auth or internal locks through inherited or overridden environments"`、`windows-acl.test.ts:132` `it.each(["timeout","abort","dispose","shell-exit"])("terminates detached descendants on %s")`（4 条）、`windows-acl.test.ts:149`；`manager.test.ts:77` `"awaits an already-started release after its holder has left the pool"`。
**修复建议**：把上述 6 条真实标题补进 windowsOnly 映射（it.each 展开为 4 条），删除失效的 "bounds total pipe output…" 条目；建议加一条单测用 vitest 的实际 JSON 报告做对账，防止再次漂移。
**最小失败测试**：在 Linux 上跑 check.yml 的 "Reject unexpected skipped tests" 步骤（或对样例 JSON 报告喂入 windows-acl/manager 的 skipped 标题调用 `unexpectedSkips`，断言 `unexpected` 非空——与 CI 现状一致即证明）。

### [HIGH] tests/lib/sandbox/shell-selection.test.ts:13-14（配合 scripts/testing/check-skips.mjs:50）
**问题**：唯一验证「原生 bash → script 传输通道」的测试把解释器路径硬编码为作者机器上的 `D:\git\Git\bin\bash.exe`；除这台机器外（包括 windows-latest CI）永远 `it.skipIf` 跳过。check-skips.mjs:50 只允许在 win32 上跳过该条 → 在 ubuntu 上这条跳过是 unexpected（与发现 1 叠加使 ubuntu 必红），在 Windows CI 上被白名单放行，等于「永远绿灯但从未执行」。
**触发条件**：任何不带 `D:\git\Git\bin\bash.exe` 的机器（全部 GitHub 托管 runner、绝大多数开发机）。
**期望行为**：用 PATH 探测（`where bash` / `resolveSandboxShell` 自己的查找函数）动态取一个真实存在的原生 bash，或注入假路径验证 `resolveSandboxShell` 的分支逻辑；CI 上要么真实运行要么显式报缺。
**实际行为**：`hasGitBash = process.platform === "win32" && fs.existsSync("D:\\git\\Git\\bin\\bash.exe")`，Windows 生产路径（Git Bash 是 Windows 上最常见 bash）的 shell 选择逻辑在 CI 里零执行。
**证据**：
```ts
const gitBash = "D:\\git\\Git\\bin\\bash.exe";
const hasGitBash = process.platform === "win32" && fs.existsSync(gitBash);
...
it.skipIf(!hasGitBash)("uses a native bash through a script file", () => {
```
**修复建议**：改为运行时探测 PATH 中的 bash.exe（排除 WSL 启动器），找不到时才跳过；同时把 windowsOnly 清单与 CI runner 的实际能力对齐（见发现 1）。
**最小失败测试**：把硬编码路径改成 `C:\definitely\not\here\bash.exe` 之外的任意探测函数后，在标准 windows-latest 上该测试必须真的执行（断言其 status 不是 skipped）。

### [MEDIUM] tests/mention-parity.test.ts:103-104,131 + scripts/testing/check-skips.mjs:51
**问题**：唯一一条「网页 @ 候选 与 pi 终端（真 fd）端到端逐条相等」的对照测试，因 `fd` 不在 GitHub runner 的 PATH 上（`spawnSync("fd", ["--version"])` 探测失败）在 CI 上恒为 skip；check-skips.mjs:51 的允许项无任何平台/环境条件，两个 OS、两种 node 版本都放行 → 该最强对照用例在任何 CI 环境都从不执行，却始终绿灯。
**触发条件**：每次 CI 运行（ubuntu-latest 与 windows-latest 均未预装 fd）。
**期望行为**：远程/依赖缺失的跳过应像 remote-tunnel 一样有专门启用通道（例如 CI 装 fd 或提供 `PIWEB_TEST_FD=1` 专用 job 并强制执行），而不是无条件允许。
**实际行为**：`const withFd = piAutocomplete && piUtils && FD ? it : it.skip;` + 清单 `|| (file === "tests/mention-parity.test.ts" && title === "各类查询逐条相等：…")`（无条件）。文件头自述「跳过 ≠ 通过，会打警告」，但 CI guard 只是打印，从不拦截。
**证据**：check-skips.mjs:51 原文；tests/mention-parity.test.ts:103 `const FD = spawnSync("fd", ["--version"], { encoding: "utf8" }).status === 0 ? "fd" : null;`
**修复建议**：在（至少）一个 CI job 里安装 fd 并用 guard 强制该用例执行（同 remote-e2e.yml 的模式）；或把跳过条件改为可注入并在 CI 报告中对该条目单独要求「必须有 enabling job」。
**最小失败测试**：CI 环境无 fd 时，要求 mention-parity 的 e2e 条目 status 必须为 passed 的 guard 检查应当失败（当前 guard 反而放行）。

### [MEDIUM] scripts/file-lock.mjs:17-27,29-43,48-52（覆盖缺口）
**问题**：新模块 file-lock 的关键分支大面积零测试。现有测试只有 tests/release-boundary.test.ts:38-46（死锁回收、活 owner 拒绝、活子进程拒绝）。
**触发条件**：以下任一分支在生产被改坏时，套件不会失败：
1. `:20` 恢复目录 `fs.mkdirSync(recovery)` 竞争失败 →「an update/build or instance is already running」（注释自称这是"Serialize reclamation"的核心，但没有任何双竞争者测试）；
2. `:23` 锁文件内容不可解析 →「lock is incomplete」；
3. `:24` children 全部已死时的回收（测试只有活子进程）；
4. `:30-31` release() 的 token 不匹配时静默不删（新 owner 已接管）；
5. `:33-43` `childStarted` / `updateMetadata`、`:48-52` `trackLockChild` —— 零调用零测试；
6. `:5` `processAlive(pid<=0)` 返回 undefined 按"活着"处理 —— 未测。
**期望行为**：至少覆盖 1、2、4 与 trackLockChild。
**实际行为**：见上。
**证据**：`grep acquireFileLock tests/` 仅 `tests/release-boundary.test.ts:6`；`grep trackLockChild tests/` 无结果。
**修复建议**：补一个双进程/双句柄竞争回收测试 + 坏 JSON 用例 + release 后他人接管再 release 的用例。
**最小失败测试**：让两个 acquireFileLock 同时竞争同一把死锁，断言只有一个成功（当前实现靠 recovery mkdir 串行化，无测试钉住）。

### [MEDIUM] src/lib/atomic-file.ts:8-16（覆盖缺口）
**问题**：`replaceFileAtomically` 的重试分支（EPERM/EACCES/EBUSY ×9 次退避）零直接测试；`grep replaceFileAtomically tests/` 仅 `tests/skills-service-safety.test.ts:46` 的整模块 mock。Windows 杀软/读句柄占用导致替换失败的真实场景（注释写明的动机）从未被验证。
**触发条件**：退避参数或错误码集合被改坏（例如漏掉 EBUSY）时无测试失败。
**期望行为**：注入失败前 2 次 rename 抛 EPERM、第 3 次成功的单测，并断言最终成功与重试次数。
**实际行为**：仅 happy path 经 `tests/atomic-confined-file-operations.test.ts`（且该用例 skipIf 非 win32）间接覆盖。
**证据**：atomic-file.ts 全文 17 行，无对应测试文件。
**修复建议**：补 `tests/atomic-file.test.ts`：mock fs.rename 两次 EPERM 一次成功；另断言非共享错误码立即抛出、不重试。
**最小失败测试**：`vi.spyOn(fs, "rename").mockRejectedValueOnce({code:"EBUSY"})` 后调用 replaceFileAtomically，断言成功且 rename 被调 2 次。

### [MEDIUM] src/lib/web-devices.ts:13-33,42-46（覆盖缺口）
**问题**：web-devices 只有 tests/web-devices.test.ts 两个路由级用例（同毫秒双设备、无会话 401）。以下分支零测试：
1. `:15` 注册表 >1MB 抛错；`:16-17` 坏 JSON / 非数组抛错（read() 把非 ENOENT 错误向上抛，`rememberWebDevice` 时写入被拒的行为未钉）；
2. `:24` 60 秒去重窗口（同一设备 60s 内不重写）——去重 bug（如 key 拼错导致永不写盘）无测试可抓；
3. `:26` seen map >1000 清理；
4. `:32` `records.slice(-200)` 设备上限；
5. `:45` listWebDevices 的 `revocations.notBefore` / `revoked` 过滤与 lastSeenAt 排序。
**触发条件**：全量登出（notBefore 前移）后设备列表仍显示旧设备等回归不可测。
**期望行为**：补上述分支的直接单测（read/过滤/去重均可通过注入文件与两次调用验证）。
**实际行为**：见上。
**证据**：tests/web-devices.test.ts 全文 31 行，无上述任何断言。
**修复建议**：新增对 read() 损坏文件、60s 去重、notBefore 过滤的用例。
**最小失败测试**：两次 `rememberWebDevice(同 id)`（mock Date.now 相差 <60s）后断言 `web-devices.json` 的 lastSeenAt 未更新。

### [MEDIUM] src/lib/recoverable-remove.ts:109,134-139（覆盖缺口）
**问题**：两条关键分支零测试：
1. `:134-139` win32 无链接目标的 SendToRecycleBin 分支（真实生产删除主路径，`powershell.exe -EncodedCommand … FileSystem]::DeleteFile/DeleteDirectory`）——recoverable-remove.test.ts 的 6 个用例分别走链接 rename、cp 失败、嵌套链接 `.original`、三个拒绝路径，从不进入该分支（recycle-temporary.test.ts 测的是另一个模块的同款实现）；
2. `:109` 锁内复核 `dev/ino/isSymbolicLink` 变化 →「Item changed during removal」竞态保护零测试。
**触发条件**：PowerShell 脚本引号转义、`-EncodedCommand` 编码或 inode 复核被改坏时，套件不会失败。
**期望行为**：至少一个 plain file 的 win32 用例（真跑或 mock execFile 断言脚本内容含 `''` 转义与 `SendToRecycleBin`），一个 mock lstat 变 inode 的竞态用例。
**实际行为**：见上。
**证据**：tests/recoverable-remove.test.ts 无任何 `execFile` mock 或 plain-dir 成功删除用例。
**修复建议**：补「无链接目录删除 → 断言 execFile 调用参数」与「锁内 inode 变化 → 拒绝」两条用例。
**最小失败测试**：`vi.spyOn(child_process, "execFile").mockImplementation(...)` 后 `recoverableRemove(plainFile)`，断言 EncodedCommand 解码后包含 `'` 转义与 SendToRecycleBin。

### [MEDIUM] src/lib/automations/schedule.ts:182-191（覆盖缺口）
**问题**：cron 的 dom/dow 经典 OR 语义分支（`:187-189`，dom 与 dow 均非通配时取「或」）零测试——现有用例只测「星号字段合取」。另未测：month 英文名（jan-dec）、单值带步进（`5/2`，`:103`）、`MAX_LOOKAHEAD_DAYS` 耗尽返回 null（`:246`）、describeSchedule 的 en/weekly 与 cron 文案。
**触发条件**：`0 9 1 * 1`（每月 1 号或周一）这类标准 cron 语义被改坏时无失败。
**期望行为**：补 `computeNextRunAt({kind:"cron", expr:"0 9 1 * 1"}, …)` 同时命中 dom 与 dow 的用例。
**实际行为**：tests/automations-schedule.test.ts:13-19 只测 `*/1 * * 1` 与 `0-7`。
**证据**：cronMatchesDay 的 `domMatch || dowMatch` 分支在测试文本中无对应断言。
**修复建议**：补一条「dom=1、dow=1、2026-06-01 是周一」的用例钉住 OR 语义。
**最小失败测试**：`expect(computeNextRunAt({kind:"cron",expr:"0 9 1 * 1"}, Date.parse("2026-06-01T00:00:00Z"))).toBe(Date.parse("2026-06-01T09:00:00Z"))`。

### [MEDIUM] vitest.config.ts:27,30-36
**问题**：新增的覆盖率闸门有两处放水：① `include: ["src/**"]` 把本轮新增的生产逻辑全部排除——scripts/file-lock.mjs、scripts/http-request-guard.mjs、scripts/remote-engine.mjs、scripts/update-environment.mjs、scripts/web-auth-protocol.mjs 完全不受分支覆盖约束；② `src/hooks/usePiWeb.ts` 与 `src/lib/git-service.ts` 设了 53/42 的独立低基线，把两个最大模块的分支覆盖不足固化成了通过条件。
**触发条件**：scripts/ 下新模块分支被改坏而测试恰好未覆盖时，coverage 闸门不报警；usePiWeb/git-service 分支覆盖继续下滑到 53/42 以上也绿灯。
**期望行为**：把 scripts/*.mjs 的测试覆盖纳入 include；两个基线文件给出「只许升不许降」的注释化理由或提高基线。
**实际行为**：配置原文如上（`include: ["src/**"]`、两条 per-file thresholds）。
**证据**：vitest.config.ts:27-36。
**修复建议**：`include: ["src/**", "scripts/**/*.mjs"]`；或至少为 scripts/ 里的五个新模块设 per-file 基线。
**最小失败测试**：把某个 scripts/*.mjs 分支的测试删掉后跑 `PIWEB_COVERAGE=1`，闸门应红（当前不会）。

### [MEDIUM] tests/setup-dom.ts:16-18（昨日「242 处 waitFor 默认 1s」线索复核）
**问题**：该线索已不成立但被转换为新的隐式依赖：现在全部测试的 `waitFor`/`vi.waitFor` 默认超时被 setup-dom 全局垫到 5s。当前 `waitFor(` 共 298 处（spread 统计），其中仅 15 处显式 timeout，其余 283 处全部依赖这一个全局垫片；任何人在 node-only 环境绕过 setupFiles 或删除该垫片时，283 处同时回到 1s。
**触发条件**：单个重型夹具（maxWorkers=4 并行）下仍可能 >5s；垫片被移除时 283 处脆弱断言集体回归 1s。
**期望行为**：对真正依赖慢 I/O 的断言（markdown 渲染、SDK 会话）在调用点显式给 timeout，全局垫片只作兜底。
**实际行为**：`configure({ asyncUtilTimeout: 5_000 })` + `vi.waitFor` 重写为默认 `{ timeout: 5_000 }`。
**证据**：tests/setup-dom.ts:16-18；计数 298/15/283（本目录 pwsh 扫描）。
**修复建议**：保留垫片，但把 30s testTimeout 语境下的关键 waitFor（如 agent-resource-isolation 的 15s 显式项）模式推广到 jsdom 重渲染用例；无需全部显式化。
**最小失败测试**：删除 setup-dom 垫片后跑任一组件测试，断言其仍稳定通过（当前预期多数仍过——超时收紧后首次暴露的就是 283 处清单）。

### [QUESTION] tests/growth-service.test.ts:405-421
**问题**：「tracked 路径被文件符号链接替换后 force-remove」用例在 Windows 无符号链接权限（非管理员/未开开发者模式）时 `context.skip`，check-skips 在 win32 放行该跳过。GitHub runner 以管理员运行通常能建 symlink，但本地 Windows 开发者（默认无特权）会让这条最危险的删除路径测试静默缺席。
**触发条件**：Windows 且无 SeCreateSymbolicLinkPrivilege 的本地跑测。
**期望行为**：明确该跳过是「能力缺失」还是应改为 junction 替代夹具（junction 无需特权，且 `:429` 的目录链接用例已经这么做了）。
**实际行为**：文件符号链接失败 → skip，CI Linux 上实跑、Windows 视特权而定。
**证据**：growth-service.test.ts:413-419 `catch (error) { if (process.platform === "win32" && ["EPERM","EACCES"]...) { context.skip(...); return; }`。
**修复建议**：能建 symlink 时保留原用例；不能时改用「文件 → junction」等价夹具（同文件下一用例 `:429` 的做法）而不是跳过。
**最小失败测试**：在无 symlink 特权的 Windows 上强制运行该用例应跳过（现状）；改用 junction 夹具后应可执行。

---

## 覆盖清单（按指定模块）

| 模块 | 现有测试 | 已覆盖关键分支 | 零测试分支 |
|---|---|---|---|
| automations | runner/store/concurrency/schedule/input/preview/agent-tool（7 个新文件） | 依赖注入的 headless 输入、超时、一次写失败重试、store 修复/租约/claim、跨进程真竞争（真子进程） | schedule 的 dom/dow OR、月名、单值步进、lookahead 耗尽；agent-tool 与 input/preview 未深读 |
| sandbox | windows-acl(17)/readonly-mode(5)/manager(6)/shell-selection(6)/escalation/config | AppContainer 真内核边界、只读模式、实例复用、升级决策（mock 注明） | 原生 bash script 通道（作者机路径，见 HIGH-2）；escalation 真进程由 windows-acl 兜底 |
| permission-gate/audit | permission-gate.test(24 用例)/permission-audit.test(3)/escalation | junction 逃逸、盘符大小写、UNC/设备路径、additionalWritableRoots、无后端拒 shell、审计旁路不抛、审计写入真实 JSONL（agent-resource-isolation:770-793） | resolveModelPath 的 `file:` 与 unsupported-scheme 分支、judgeWritePath 顶层 catch |
| pairing | lib/pairing.test(7)/remote-pair.test(5) | 256bit 一次性、TTL、限流/上限、QR 复用、匿名猜测节流、双网络兑换+cookie 绑定+代理拦截 | collision do/while（不可测，豁免） |
| marketplace | plugins-marketplace.test(6)+组件 lifecycle | 搜索词构建、npm 项归一、fetcher 注入缓存/强刷、semver/兼容性/caveat | route 层（src/app/api/plugins/marketplace）无直接路由测试（未深读组件 lifecycle 是否覆盖） |
| session-history | api/session-history.test(6)+components(7) | 分页校验前置、路径泄露防护、MIME/防嗅探/外链拒绝、翻页/竞态/重试 | history 读取器主体在 session-reader-history/web-history-budget（未深读） |
| web-devices | web-devices.test(2) | 双设备 cookie、吊销单设备、401 | 1MB 上限、坏 JSON、60s 去重、200 上限、revocation 过滤/排序 |
| atomic-file | （无专测；confined ops 间接 happy path） | — | 重试/错误码分支全零 |
| file-lock | release-boundary.test(1 条锁用例) | 死锁回收、活 owner、活子进程 | recovery 竞争、坏 JSON、dead-child 回收、release token、childStarted/updateMetadata/trackLockChild |
| http-request-guard | http-request-guard.test(9) | 头部先于 body 的 401/413/503、Expect:100-continue、真子进程预载（http+https）、代理端口独立闸门、multipart 通道、cookie authority | — |
| recoverable-remove | recoverable-remove.test(6)+recycle-temporary.test(2) | 链接整体入回收、嵌套链接保留原件、自递归/自链拒绝、权限保留、引号路径回收（recycle-temporary） | win32 无链接 recycle-bin 分支、锁内 inode 竞态 |

## 未追踪清单（未深读文件）

本轮未深读的未追踪项共 **62** 项（未追踪合计 90 项，深读/核对 28 项）：
api/agent-prompt-error-boundary、api/model-route-errors、api/pi-settings-refresh、api/read-route-errors、api/resource-route-errors、api/security-route-errors、api/session-import-stream、automation-agent-tool.test、automations-input、automations-preview、client-fetch、components/automation-model-scope、components/automation-preview、components/chat-input-queue、components/extension-web-dialog、components/file-viewer-export、components/file-viewer-refresh、components/git-panel-diff-window、components/i18n-hydration、components/markdown-ux、components/plugin-marketplace-lifecycle、components/plugins-install-confirm、components/session-model-catalog、components/settings-confirm-dialog、components/sidebar-search-pagination、components/skills-section、components/workspace-nav-automations、components/workspace-registry-warning、components/workspace-resource-lifecycle、components/workspace-views-prompts-market、compose-prompt、files-download、files-index-bounds、files-service-encoding、fixtures/、growth-activity、image-attachment、install-build-transaction、launcher-local-token、lib/extension-web-ui、lib/permission-request、lib/sandbox/config.test、lib/sandbox/windows-acl/manager/readonly-mode（仅标题核对+片段）、lib/tool-preset、models-catalog-boundary、models-runtime-errors、models-sdk-catalog-commands、next-config-entrypoint、plugins-source-regression、read-file-bounded、remote-lifecycle-boundary、remote-startup、resource-refresh、session-import-paths、session-location、session-model-runtime、session-reader-history、session-retention-scheduler、sessions-id-route、settings-effective-scope、skill-frontmatter、skills-link-removal、skills-service-safety、theme-color-meta、web-history-budget、web-launch-lifetime。
另有已跟踪改动 73 个测试文件中约 28 个仅做 diff 级浏览未逐条深读（如 plugins-section-state、settings-model-roundtrip、session-import-service、git-service、files-service、update-service、trajectory、command-validation、launcher 等）。

## 各维度结论

- **静默跳过机制**：check-skips.mjs 本身设计良好（报告对账、CI 强制、专门 tunnel job 双端执行），但允许清单与实际标题已脱节（HIGH-1）、一条白名单无条件放行恒跳过的 e2e 对照（MEDIUM-3）、一条作者机专属路径测试被永久放行（HIGH-2）。
- **假绿**：未发现断言 mock 替代行为、吞断言的 try/catch、恒真条件断言。抽查的 12 个新测试文件（automations×3、concurrency×2、permission×2、pairing×2、session-history×2、http-request-guard、release-boundary、session-disk-sync、recoverable-remove、examples）触发条件真实、可失败。`.catch(() => undefined)` 仅出现在「错误内容不关键、以文件系统终态断言兜底」的场景（agent-resource-isolation:762、escalation:74），不构成假绿。
- **并发测试**：automations-concurrency、web-revocations-concurrency 是真跨进程（spawn + proper-lockfile），交错真实存在；remote-auto-connect 用 fake timers 驱动真实 supervisor 状态机；未发现「并发外壳、串行执行」的假并发。
- **waitFor**：昨日「242 处默认 1s」已被 setup-dom 全局 5s 垫片消解（现为 298 处/283 隐式/15 显式，见 MEDIUM-8）。
- **真实监听/子进程/网络**：未发现测试监听 0.0.0.0（launcher 测试只断言拒绝 0.0.0.0）；全部监听 127.0.0.1 随机端口。真实子进程（automations/revocations worker、remote-engine watchdog、http-request-guard 夹具、pi-settings、workspace-store）均有 kill/exit 收尾且执行体无害；remote-tunnel e2e 真联网但有专属 workflow + pinned cloudflared hash + guard 强制执行。recycle-temporary 在 Windows 本机会真实写入回收站（设计如此，CI 无副作用问题）。
- **CI 现状判断**：按当前工作区，check.yml 的 ubuntu 两个 job 会因 check-skips 的 8 条 unexpected skip 必红（HIGH-1 7 条 + HIGH-2 1 条）；windows job 能绿的前提是 runner 具备 AppContainer 支持与（若 symlink 特权缺失则 growth-service 跳过已获放行）。
