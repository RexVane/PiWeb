# PiWeb 全栈审计最终报告（2026-11-15 · 当前工作区快照）

> 审计对象：`D:\AIApp\PiWeb`（`@rexvane/piweb` 0.3.30，Next.js 16.4.5 / React 19.3.0 / TypeScript 7.0.2 / vitest 5.0.5 / jsdom 30.0.1）
> 代码快照：git HEAD `4a6a59e2941eac2047f94a9eea8d5caac0226f9b` + 工作区 125 项未提交改动（2026-11-15 18:41 基线 `audit_tmp/run-20261115-full/baseline-20261115T1845.txt`）
> 执行时间：2026-11-15 18:12–20:00（Asia/Shanghai）；上半场 Codex（A/C/D/F/G/H/K/L/M/N/O/P 12 节）18:12–18:31 因用量上限中断，下半场 DSH 续审（B/E/I/J 4 节）18:43–19:51
> 交付物：本报告 + 16 份分节报告 `audit_tmp/report_A…P.md`（合计约 354KB）+ 证据目录 `audit_tmp/run-20261115-full/` + 附录（命令/文件/清单/状态检查）

---

## 0. 结论摘要

- **覆盖**：用户清单要求 A1–P5 共 **87** 个编号，全部给出判定，无跳号、无合并作答。
- **判定分布**：通过 **38** · 有问题 **42** · 无法验证 **6** · 不适用 **1**。
- **严重程度（按用户给定标准统一复核）**：高 **0** · 中 **24** · 低 **18**。未发现满足“认证/授权绕过、未经确认执行命令、密钥/凭证泄露、核心功能完全不可用或升级导致用户数据丢失”的高危缺陷；最接近高危的 F1（Host 伪造绕过认证）已由 B4 生产网络实测**证伪**（见 §4 F1、§8）。
- **最重要的 8 个结论**：
  1. 认证与启动矩阵整体成立：未认证访问受保护接口 401/307，唯一“完全免认证”的组合是**仅回环 + 显式 `PI_WEB_AUTH=0`**；`0.0.0.0` 暴露与“关认证”组合会被启动器拒绝（B3/B4）。
  2. 当前工作区**全量测试基线是红的**：288 文件/2347 用例中 22 文件 50 用例失败；其中 28 条由未提交改动引入（`DEFAULT_PEBREL_THEME` 与测试 mock 不一致，确定性），17 条与本机受限会话/并发相关，3 条为 HEAD 既有失败（B1/E1）。
  3. 认证后的文件边界是“本机操作者级”：`path-security` 不要求已注册工作区，任意现存目录可作为 cwd 读取（G1，中）；配合默认 LAN 入口，认证后的远程设备拥有本机文件读取能力（I4）。
  4. 证书/口令类数据会在配置导出与会话导出中原样输出：`/api/config` 原样下载 `settings.json`（含 proxy 凭据）、`/api/pi-settings` 回显带凭据的代理 URL、会话 JSONL 导出原样带出密钥（I1，中；模型列表已脱敏）。
  5. 手机排版代理对 HTML 响应整段缓冲且无上限、同步解压无输出上限，可致内存耗尽（I4/I-09，中）。
  6. 并发写 `PUT /api/pi-settings` 在 Windows 下大量 500 EACCES（10 并发时 8–9 次失败），文件未损坏（J6，中）；属可复现的用户可见故障。
  7. 构建/打包链路可用：`npm ci`→`tsc`→`next build --webpack`（370s）→`verify:package`（192s）全部 exit 0；但发布包把含构建机绝对路径的 `.next/trace`（1.36MB）打进 tarball（P4，低）。
  8. 仓库无 Lint 配置，临时 eslint 扫描发现 2 个 `no-unsafe-finally` 错误；CI 未配 Lint/依赖漏洞/macOS 门禁，且 Linux 的 skip-guard 会因 2 条未白名单 `it.runIf` 必红（K1/P1/E2）。
- **快照漂移（必须知道）**：审计期间工作区被**外部并行开发活动**继续修改（125→133 项：`runtime-proxy` 相关 5 个新文件、`pi-settings`/`tsconfig` 修改等，mtime 18:54–19:09，见 §8 与 `final/external-parallel-activity.md`）。本报告结论对应各节证据所示快照；这些**外部新增/修改文件本身未纳入本轮审查**（I 节报告已声明其中 `pi-settings` GET 分支未变）。

---

## 1. 审计对象、范围、方法与执行方式

### 1.1 项目画像（证据：`report_A.md` A1、`run/logs/inventory.log`）

- Git：HEAD `4a6a59e2`（`main` 分支），`git ls-files` 1630 个文件；工作区审计开始时 125 项未提交改动（已提交历史共 708 个 commit）。
- 代码规模（物理行，排除依赖/构建/图标 JSON）：`src` 249 文件 63,126 行；`scripts` 31 文件 2,896 行；`bin` 2 文件 82 行；`tests` 291 文件 37,059 行。
- 运行时：本地 Node v24.12.0，`jsdom@30.0.1` engines 要求 `^22.22.2 || ^24.15.0 || >=26`；审计统一改用缓存中的兼容 Node **v24.15.0** 执行构建与测试（属环境版本漂移，非项目缺陷）。
- 定位：单操作者、多浏览器设备、同权限的本地 AI 编程代理 Web 界面（Next.js App Router + SQLite/JSON 持久化 + SSE 事件流 + 远程隧道）。

### 1.2 范围与编号

用户指定清单 A/B/C/D/E/F/G/H/I/J/K/L/M/N/O/P 共 16 节、87 个编号，每条结论必须附真实证据（R1）、能跑必须跑（R2）、零污染（R3）、数据隔离（R4）、脱敏（R5）、完备不跳号（R6）、分阶段落盘（R7）、临时资源清理（R8）。本报告 §4 逐条落地，详细证据在对应分节报告。

### 1.3 执行方式

- **多 agent 分工**：上半场主 agent + 3 个子 agent（security/architecture/build_tests）跑 A/C/D/F/G/H/K/L/M/N/O/P；下半场 DSH 子 agent `b-build`/`e-tests`/`i-supply`/`j-chaos` 并行补齐 B/E/I/J，Lead 汇总。
- **隔离**：启动服务/构建/测试均把 `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR/PI_CODING_AGENT_DIR/npm_config_cache` 重定向到 `audit_tmp/run-…/` 下，并设 `PI_OFFLINE=1`、`NEXT_TELEMETRY_DISABLED=1`、`PI_WEB_UPDATE_CHECK=0`；服务全部随机端口 + `127.0.0.1`（除 B4 明示的监听矩阵）启动。
- **零污染**：审计期间未修改任何被跟踪的源码/配置/lockfile/测试/git 历史；唯一一次误生成物是仓库根 `Microsoft/`（PowerShell ModuleAnalysisCache），已移入回收站，见 §7。
- **工具链限制（如实记录）**：DSH 受限会话下 `fs.symlinkSync` 稳定 `EPERM`、`CreateAppContainerProfile` 失败（0x80070005），导致 33 条 Windows 沙箱用例被跳过、17 条链接族用例失败；`D:\tmp` 等**工作区外目录不能被本会话子进程创建目录**，B1 因此把干净克隆搬入 `audit_tmp/…/b-run/clone-b` 构建（均已在分节报告注明为环境限制）。

### 1.4 快照与外部并行改动（汇总）

审计开始基线 125 项；收尾 133 项，其中 8 项为**外部并行开发活动**（非审计写入，mtime 18:54–19:09）：`M src/app/api/pi-settings/route.ts`、`M tests/api/pi-settings-refresh.test.ts`、`M tsconfig.json`、`?? scripts/proxy-env.d.mts`、`?? scripts/proxy-env.mjs`、`?? src/lib/runtime-proxy.ts`、`?? tests/cold-session-thinking.test.ts`、`?? tests/runtime-proxy.test.ts`。HEAD 未变，净污染 0（`final/state-check.md`）。此外审计期间仓库根还有外部进程在跑 `npm run build:release`、`npm run check`、`tsc`（非本审计启动）。

---

## 2. 最终输出①：实际执行过的全部命令清单

用户要求“按执行顺序的全部命令”。本审计分两段记录，完整清单以下两个附录为准：

- **Codex 上半场**：`final/appendix-commands.md` —— 从 root/security/architecture/build 四份 `commands.jsonl` 合并 **73 条**（含退出码/日志路径）。
- **DSH 下半场**：`final/appendix-commands-dsh.md` —— 从 `report_B/E/I/J.md` 的“本节实际执行命令清单”表抽取 **113 条**（B 31 / E 24 / I 25 / J 33），完整命令与输出见各分节报告正文。
- **合计 186 条**。另有各分节报告内的临时脚本（`audit_tmp/run-…/{security,architecture,build,b-run,e-run,i-run,j-run}` 下 `.mjs/.ps1/.py`），均在 §7 清单中。

---

## 3. 最终输出②：实际阅读过的文件与核心目录未阅读文件

完整清单：`final/appendix-files.md`（由 `security/read-files.txt`、`architecture/read-files.txt` 等阅读记录 + 命令日志中的文件路径抽取，并与仓库核心目录逐一比对生成）。

- 已阅读路径去重 **122** 个，其中落在核心目录（`src/scripts/bin/.github`）**79** 个（合计 290 个可枚举核心文件的 27%）。
- 核心目录未在阅读清单出现 **211** 个文件（清单见附录，主要是未改动的组件、测试辅助与配置文件）。
- 说明：该清单按“路径是否出现在阅读记录/命令日志”机械比对，命令内只读片段也算“读过”；第三方依赖（`node_modules`）不在统计范围。

---

## 4. 最终输出③：A1–P5 逐条结论与真实证据（87 条，按编号顺序）

> 证据列只给“分节报告 + 关键命令/文件:行号/日志”入口；每条完整命令输出与源码原文见对应分节报告。判定用词：通过 / 有问题 / 不适用（原因）/ 无法验证（原因和还需要什么）。

| 编号 | 判定 | 结论摘要 | 关键证据 |
|---|---|---|---|
| A1 | 通过 | git 盘点与 inventory.mjs 实跑；1630 个跟踪文件，src 249/63126 行、scripts 31/2896、bin 2/82、tests 291/37059 | `report_A.md` A1；`run/logs/inventory.log` |
| A2 | 通过 | 源码给出 launcher→instrumentation→Next 启动链与生命周期，逐步文件:行号 | `report_A.md` A2；`scripts/launcher.mjs:231-297` |
| A3 | 通过 | 38 个 route 文件、59 个显式 HTTP 方法逐行核对；无源码层 WebSocket 服务（Agent 用 SSE） | `report_A.md` A3；`run/routes-source.txt` |
| A4 | 有问题 | 37 个环境变量未在用户指南说明（共享签名密钥、编辑器、私网模型发现等） | `report_A.md` A4；`run/envs.json` |
| A5 | 有问题 | 只设 `PI_CODING_AGENT_DIR` 不足以隔离全部用户文件；导入来源与全局技能仍用 `os.homedir()` | `report_A.md` A5；`src/lib/session-import/paths.ts:10-37` |
| A6 | 有问题 | 子进程继承全部 `process.env`（只读 git/编辑器/growth），启动令牌可进入子进程环境 | `report_A.md` A6；`src/lib/git-service.ts:67-69` |
| A7 | 通过 | 服务端出网清单与前端 86 处同源 fetch 已核对，未发现不可信输入控制目标 Host | `report_A.md` A7；`run/network.json` |
| B1 | 有问题 | `npm ci`→typecheck→生产构建（370.4s）→`verify:package`（191.7s）全部 exit 0；全量单测两次均 50 failed（28 条 theme mock 与未提交导出不一致） | `report_B.md` §2；`b-run/logs/{02-typecheck-clone,05-build-clone-b.result,09-verify-package.result,07b-unit-tests.out}.log` |
| B2 | 通过 | postinstall 语义实测：普通安装触发、源码检出 no-op；`--ignore-scripts` 后依赖完整、构建与启动均正常；附文档缺口 B-05 | `report_B.md` §3；`b-run/logs/06b-igs-npm-ci-ignore-scripts-retry.log` |
| B3 | 通过 | 隔离生产启动：health 200 不泄漏版本/路径；未认证 401/403；令牌兑换 303 且 `Referrer-Policy: no-referrer`/`Cache-Control: no-store`；Cookie `HttpOnly; SameSite=lax; Path=/`；合法凭证 200；令牌一次性（重放 307） | `report_B.md` §4；`b-run/http/`、`b-run/logs/11-probe-auth.out.log` |
| B4 | 通过 | 启动矩阵：dev/生产/127.0.0.1/0.0.0.0/`PI_WEB_AUTH=0` 逐一实测；唯一完全免认证=**仅回环+显式关认证**；0.0.0.0 下未认证 API 401、页面 307；**伪造 Host=localhost/127.0.0.1 不能换到会话**；`0.0.0.0+auth=0`、`dev+0.0.0.0` 被启动器拒绝 | `report_B.md` §5；`b-run/logs/13-lan-probe.out.log` |
| C1 | 有问题 | README 承诺侧栏技能/提示词/市场，真实入口仅 chat/plugins/automations，市场 route 已删除 | `report_C.md` C1；`src/components/SessionSidebar.tsx:64` |
| C2 | 无法验证 | 生产 HTTP 3–5 条 CRUD + 重启持久化未端到端实测（需隔离生产服务与 CLI 依赖）；已测 14 文件 129 项存储/界面用例通过 | `report_C.md` C2；`architecture/11_target_tests_retry.log` |
| C3 | 通过 | 自动化 JSON 契约前后端一致、loadSeq 防过期、SSE 断线可重建快照 | `report_C.md` C3 |
| C4 | 通过 | 零数据/加载/错误态与降级路径已实测 | `report_C.md` C4 |
| C5 | 有问题 | `SkillsWorkspaceView`/`PromptsWorkspaceView` 无入口可达，市场 i18n/组件残留 | `report_C.md` C5；`src/components/workspace/SkillsPluginsViews.tsx:39` |
| D1 | 有问题 | 检出 `pi.ts→jsonc-settings-storage→path-security→pi` 循环依赖（当前可加载，耦合风险） | `report_D.md`；`architecture/metrics.mjs` |
| D2 | 通过 | JSON Schema 校验、损坏恢复副本、原子替换测试通过 | `report_D.md` D2 |
| D3 | 有问题 | 临时文件+rename 有锁但未 `fsync`，断电后持久性未保证（未做断电注入） | `report_D.md` D3；`src/lib/workspace-store.ts:182` |
| D4 | 有问题 | 会话扫描先收集全部 jsonl 再分批处理，`listSessions` 总返回全量排序，无分页/上限 | `report_D.md` D4；`src/lib/session-reader.ts:275,293-320` |
| D5 | 通过 | 启动地址/端口/公开 URL/agent 目录/共享密钥/编辑器均可外部配置 | `report_D.md` D5 |
| E1 | 有问题 | 全量 288 文件/2347 用例：22 文件 50 失败；28 条为未提交改动 theme mock 缺 `DEFAULT_PEBREL_THEME`（确定性），17 条受限会话/并发伪影（控制重跑 122/122 通过），3 条 HEAD 既有，1 条便携 Node 无 npm | `report_E.md` E1；`e-run/e1-full-tests-coverage.log`、`e-run/e1-failure-classification.json` |
| E2 | 有问题 | Linux CI skip-guard 必红：`powershell-encoding` 与 `agent-resource-isolation` 的 `it.runIf` 跳过未进白名单（真实 guard 函数复现） | `report_E.md` E2；`e-run/e2-guard-probe.log` |
| E3 | 通过 | 覆盖率 Lines 85.27% / Branches 72.17%，门槛通过；16 文件 <50%（其中 3 个接口 0%） | `report_E.md` E3；`e-run/coverage/coverage-summary.json` |
| E4 | 有问题 | `/api/config` 无任何测试；`/api/github`、`/api/version` 仅被 UI mock/代理路径引用，无 handler 级测试 | `report_E.md` E4；`e-run/route-coverage-audit.json` |
| E5 | 通过 | 6 类安全场景（Host/CSRF/无凭证/令牌位置/一次性/撤销）既有测试均覆盖；本节补 18 条边界断言全通过 | `report_E.md` E5；`e-run/security-gap.test.ts` |
| E6 | 通过 | 无字面量恒真/空断言假通过；1 处未 `await` 的 rejects 断言属低风险 | `report_E.md` E6；`e-run/e6-weak-assertion-audit.json` |
| F1 | 有问题（低） | 回环自动签发 Cookie 分支只依赖可伪造 Host + 代理头缺失（函数级可复现 `cookieMinted:true`）；但 **B4 生产网络实测伪造 Host 无法换会话**（Next 恒注入 `x-forwarded-*`，该分支实为死代码），远程绕过不成立 | `report_F.md` F1；`security/probes.test.ts`；`report_B.md` §4.3/5.2 |
| F2 | 有问题 | 写请求 Origin/Sec-Fetch-Site 校验通过；但 GET 并非全无副作用：`/api/git` GET 起 Git 子进程、认证 GET 写设备记录；有 Origin 时不比较 scheme | `report_F.md` F2；`src/app/api/git/route.ts:27`、`src/proxy.ts:60` |
| F3 | 不适用 | 单操作者/多设备/同权限模型，无多用户、角色与资源所有者字段，IDOR 模型不成立 | `report_F.md` F3 |
| F4 | 无法验证 | 跨 OS 权限边界（Windows 0600≠POSIX、双账户 ACL、Linux/macOS 文件权限、生产反代拓扑）未实测 | `report_F.md` F4 |
| F5 | 通过 | 登录/配对限流真实接入主流程：401 后立即重试 429、指数回退/60s 上限/空闲窗口三例通过 | `report_F.md` F5 |
| G1 | 有问题 | `path-security` 只校验字符串/realpath/isDirectory，不要求已注册工作区；probe 在未注册目录创建 marker 并读取成功（认证后任意现存目录可作 cwd） | `report_G.md` G1；`src/lib/path-security.ts:63-72`；`security/probes.test.ts` |
| G2 | 通过 | 上传边界：100MiB 上限、文件名净化截断、固定 `web-uploads` + `wx`；17/17 用例 + 自建畸形文件名 probe 通过 | `report_G.md` G2 |
| G3 | 有问题 | 恶意 Git 配置（fsmonitor 等）防护 10/10 通过；但 git/编辑器/growth 子进程未净化 `process.env`，启动令牌可能进入子进程 | `report_G.md` G3；`src/lib/git-service.ts:67-69` |
| G4 | 通过 | 模型发现：私网/环回/保留地址拦截、先 DNS 后校验、3xx 不跟随；16/16 用例通过 | `report_G.md` G4 |
| G5 | 通过 | 指定 XSS 样本（img onerror、javascript: 链接）与渲染路径实测无执行 | `report_G.md` G5 |
| G6 | 通过 | 导入只读（PRAGMA query_only）、行数/大小上限、畸形样本 38/38 通过 | `report_G.md` G6 |
| H1 | 无法验证 | 无真实模型凭据，未做“恶意仓库内容诱导模型外传”的对抗闭环；不把提示文本当安全边界 | `report_H.md` H1 |
| H2 | 通过 | 工具审批在服务端强制、嵌套工具不能绕过（nested-permission 4/4） | `report_H.md` H2 |
| H3 | 有问题 | 普通回合无 MaxSteps/总时长/token/cost 硬上限（SDK agent-loop 为 `while(true)`），仅靠用户 abort/压缩 | `report_H.md` H3；`src/lib/agent-manager.ts:2958-2967` |
| H4 | 通过 | 模型输出 Schema 校验与异常捕获实测：畸形 number/缺字段/null 不执行工具、不崩溃 | `report_H.md` H4 |
| I1 | 有问题 | `/api/config` 原样导出 settings.json（假 proxy 凭据+trackingId 实测命中）；`/api/pi-settings` 回显含凭据 httpProxy；会话 JSONL 导出原样带密钥；模型列表已脱敏 | `report_I.md` I1；`i-run/i1-results.json` |
| I2 | 有问题（低） | 708 提交/103 万行历史无生产密钥；唯一命中测试夹具自签名私钥；`.gitignore` 缺 `id_rsa/*.pem/*.key` 规则 | `report_I.md` I2；`i-run/i2-scan-history.json` |
| I3 | 有问题 | 无第三方埋点；SDK 安装遥测默认开且无 UI/文档关闭入口；删除会话不清附件、附件“清理”仍留恢复副本；“归档会话自动清理”模块在工作区被删除 | `report_I.md` I3；`i-run/i3-results.json` |
| I4 | 有问题 | LAN 入口默认 `0.0.0.0:30142` 自动监听；Host/Origin 未被洗白、准入有效、隧道子进程环境已清洗；但 HTML 注入代理整段缓冲无上限、同步解压无上限（内存 DoS）、编码兜底损坏页面 | `report_I.md` I4；`i-run/i4-results.json` |
| I5 | 通过 | `npm audit` 0 漏洞（508 依赖）；lock integrity 全覆盖；38 直接依赖中 20 精确锁定；dependabot 每周 | `report_I.md` I5；`i-run/i5-npm-audit.json` |
| I6 | 通过 | 无 GPL/AGPL；LGPL/MPL 来自 sharp/lightningcss 等构建期依赖；无未知协议、无 git/file 依赖；registry 混合但 integrity 全覆盖；缺第三方许可证 NOTICE | `report_I.md` I6；`i-run/i6-licenses.json` |
| J1 | 通过 | 5 个核心接口畸形负载（非 JSON/数组/null/缺字段/未知 action）均 4xx，无 500/崩溃 | `report_J.md` J1；`j-run/results/results.jsonl` |
| J2 | 通过 | 类型/长度越界收敛 4xx；别名 10 万字符被接受并持久化（J-ISSUE-03，低） | `report_J.md` J2 |
| J3 | 通过 | 12MB 全局 body 上限 + 流式字节计数生效，50MB 请求被拒且服务无崩溃、内存平稳 | `report_J.md` J3 |
| J4 | 通过 | 空格/中文/Emoji/引号/`$(id)` 正常；NUL 路径 `/api/fs` 返回 500（J-ISSUE-02，低） | `report_J.md` J4 |
| J5 | 通过 | 无凭证/篡改签名/过期/注销全部会话后旧凭证均被拒 | `report_J.md` J5 |
| J6 | 有问题 | 10 并发 `PUT /api/pi-settings`：主阶段 9/10、补充阶段 8/10 返回 500 EACCES（单请求 0.97–7.9s）；settings.json 未损坏；工作区并发写与 runNow 互斥正常 | `report_J.md` J6；`j-run/results/results.jsonl` |
| J7 | 通过 | PATH 去 git/离线时接口返回可读错误、不挂起不崩溃（`/api/update check` 语义问题 J-ISSUE-05，低） | `report_J.md` J7 |
| J8 | 通过 | SSE 建立后立即断开 50 次：计时器/活动句柄/内存回落无泄漏；信号监听器警告 J-ISSUE-04（低，未定位） | `report_J.md` J8 |
| K1 | 有问题（低） | `tsc --noEmit` exit 0；仓库无 Lint 配置，临时 eslint 扫描发现 2 个 `no-unsafe-finally` 错误 | `report_B.md` §2.3；`build/logs/21-eslint.log` |
| K2 | 有问题 | 最大源码文件 `agent-manager.ts` 3496 行、`ChatWindow.tsx` 2645 行；AST 识别 8 个 >150 行函数 | `report_K.md`；`architecture/07_metrics_retry.log` |
| K3 | 有问题 | AST 扫出 121 个空 catch；会话扫描把 readdir 所有异常吞成空列表（无法区分无会话与 EACCES） | `report_K.md`；`architecture/empty-catches.json` |
| K4 | 通过 | 路由错误经 apiError/publicDiagnostic 过滤路径与堆栈，40 项错误用例通过 | `report_K.md` K4 |
| K5 | 有问题 | `dependencies` 含 `@types/*`、typescript 与构建工具；技能/提示词孤岛视图（C5） | `report_K.md` K5；`package.json:79-89` |
| K6 | 通过 | console.log/debugger/TODO/FIXME/HACK 扫描无调试残留泄露；调试开关仅 SQLite 诊断 | `report_K.md` K6 |
| L1 | 无法验证 | 10 万文件生产 HTTP 压测未执行（J 节同项标不适用/未覆盖，需专用压测环境） | `report_L.md` L1；`report_J.md` §4 |
| L2 | 有问题 | `configuredCredentialFor` 的 `rt.checkAuth(providerId)` 未传 signal，应用层无法保证该分支超时；无统一重试策略 | `report_L.md` L2；`src/lib/models-service.ts:611-617` |
| L3 | 通过 | 会话销毁清理订阅者/磁盘缓冲/沙箱；6 项 events 与 7 项 polling 测试通过 | `report_L.md` L3 |
| L4 | 有问题 | `agent-config.cache` 读缺失文件也 set 且无容量/TTL；`pi` 各缓存按工作区长期保留；summaryCache 随会话增长 | `report_L.md` L4；`src/lib/agent-config.ts:51-58` |
| L5 | 有问题 | 服务进程未注册远程 `stopAll`/自动化停机回调；Unix 无进程组时只杀直系 child，后代回收不保证 | `report_L.md` L5；`scripts/process-runner.mjs:6-22` |
| L6 | 有问题 | SIGINT/SIGTERM 共用 interrupt 直接 terminateProcessTree（Unix SIGKILL、Windows taskkill /T /F），非优雅停机 | `report_L.md` L6；`scripts/launcher.mjs:622-634` |
| L7 | 有问题 | SSE `enqueue` 不检查 `desiredSize`，无慢客户端字节上限与每会话订阅者上限 | `report_L.md` L7；`src/app/api/agent/[id]/events/route.ts:55-64` |
| M1 | 通过 | 启动器日志不含凭据 URL；B3 实测令牌兑换 303 携带 `Referrer-Policy: no-referrer`、`Cache-Control: no-store` | `report_M.md` M1；`report_B.md` §4.2 |
| M2 | 有问题 | 日志仅纯文本前缀、无结构化字段/请求 ID；会话读取失败吞成空、更新检查空 catch | `report_M.md` M2；`src/instrumentation-node.ts:20-21` |
| M3 | 无法验证 | 未发现直接打印 Authorization/Cookie 的调用；但 SDK/扩展 Error 整体进日志，需恶意异常注入确认不含凭据 | `report_M.md` M3 |
| M4 | 有问题 | `/api/health` 只返回静态 ok/service，无依赖/数据目录可写性/调度器就绪状态，存活与就绪未分离 | `report_M.md` M4；`src/app/api/health/route.ts:1-7` |
| N1 | 通过 | 监听器/定时器/ResizeObserver/EventSource 卸载成对清理，断流用例通过 | `report_N.md` N1 |
| N2 | 通过（复核） | 原缺构建数据：B 节实测生产 `.next` 运行产物约 14.6MB（static 2.3MB、最大 JS 322.3KB 未压缩、CSS 0.17MB），未发现大库误入首屏的异常；首屏归属未细分 | `report_B.md` 附录 A2；`b-run/logs/05-build-clone-b.result.txt` |
| N3 | 通过 | 模态/下拉/Esc/焦点陷阱与焦点归还均有代码与实测 | `report_N.md` N3 |
| N4 | 有问题 | 后端错误文案为中文、前端直接显示，英文界面出现中文错误；日期 `toLocaleString` 未指定界面语言 | `report_N.md` N4；`src/lib/api-error.ts:19-24` |
| O1 | 有问题 | 中英 README 的 Node≥22.19 与 `package.json:96` engines 一致（Lead 复核，原报告空证据块不影响该分句）；但 CI 最小 22.22.2、代理功能另要求 24/22.21+，且 README 残留已不存在的侧栏功能 | `report_O.md` O1；`package.json:96`、`README.md:93`、`.github/workflows/check.yml:13-16` |
| O2 | 通过 | 已移除密码认证有明确拒绝与迁移提示（`PI_WEB_PASSWORD` 拒绝启动、410 响应） | `report_O.md` O2 |
| O3 | 有问题 | 55 个直接读取的环境变量中 37 个未出现在当前用户指南 | `report_O.md` O3；`architecture/env-docs.mjs` |
| O4 | 有问题（复核） | B 节按 README 实测：typecheck/build/verify 通过，但 test 步骤 50 failed（同 E1/B-06）；全局安装/更新/卸载与公网反代示例未验证 | `report_B.md` 附录 A3；`report_E.md` E1 |
| O5 | 有问题 | 设计文档开头“当前维护代码”导航仍写技能/提示词/市场，与当前 Sidebar 三视图脱节 | `report_O.md` O5；`docs/planning/technical-design.md:5-17` |
| P1 | 有问题 | CI 覆盖 Ubuntu/Windows×Node 22.22.2/24，但未配 Lint、依赖漏洞门禁、macOS，且未覆盖 README 声明支持的 22.19 下限 | `report_P.md` P1；`.github/workflows/check.yml:13-16,37-50` |
| P2 | 无法验证 | 已读最近 10 次运行/5 次失败日志；registry 两次连接失败，无法证明失败 SHA 从未无 tag 发布 | `report_P.md` P2；`architecture/01_inventory.log` |
| P3 | 有问题 | Actions 用可移动 v4 tag 而非 commit SHA；publish 步骤未设 `PI_OFFLINE`，预构建与 verify 未统一隔离 HOME；publish job 权限已最小化 | `report_P.md` P3；`.github/workflows/publish.yml:27-44,82` |
| P4 | 有问题（复核） | B1 `npm pack --dry-run` 实测 1066 文件/4.09MB，`node_modules` 未打包、`.next/cache` 正确排除；但 `.next/trace`（1.36MB，含构建机绝对路径）被打进包内 | `report_B.md` 附录 A1；`b-run/logs/08-npm-pack-dry-run.log` |
| P5 | 有问题 | Git 自更新先 pull 再 install，共享 node_modules 不随旧构建回退；npm 更新不保证原子切换；缺紧急回滚/降级手册 | `report_P.md` P5；`src/lib/update-service.ts:244-258` |

---

## 5. 最终输出④：问题汇总表

> 严重程度按用户给定标准统一复核（原分节报告自评可能不同，已在摘要注明）。本表按清单编号各一行；“无法验证/不适用”编号不进入本表（见 §6）。

| 编号 | 严重程度 | 分类 | 文件:行号 | 问题描述 | 复现方式 | 是否已复现 | 修复建议 |
|---|---|---|---|---|---|---|---|
| A4 | 低 | 文档与发布 | `src/lib/web-secret.ts:40`、`src/lib/files-service.ts:675` 等 | 37 个直接读取的环境变量未在用户指南说明（共享密钥/编辑器/私网发现等） | `architecture/env-docs.mjs`（55 env，37 undocumented） | 是 | 补部署/运维文档，区分内部调试变量 |
| A5 | 中 | 架构与数据 | `src/lib/session-import/paths.ts:10-37`、`src/lib/skills-service.ts:260-261` | 仅重定向 `PI_CODING_AGENT_DIR` 不能隔离全部用户文件（仍用 `os.homedir()` 定位导入来源/全局技能） | 源码 + `run/home.json` | 是 | 文档明确 agentDir 不是全部数据根；统一以可配置根替代 homedir |
| A6 | 中 | 安全 | `src/lib/git-service.ts:67-69`、`src/lib/files-service.ts:686`、`src/lib/growth-service.ts:177` | 子进程继承全部 `process.env`，启动器设置的启动令牌可进入 git/编辑器/growth 子进程 | 源码（B3/G3 旁证） | 是（代码级） | 统一 allowlist 过滤 `PI_WEB_*` 秘密，按需显式注入 |
| B1 | 中 | 工程质量 | `tests/components/*.test.tsx` 与 `src/lib/theme.ts` 未提交改动 | 构建/类型/打包校验全绿，但全量单测两次均 50 failed（28 条 theme mock 缺导出确定性失败） | `b-run/logs/07b-unit-tests.out.log`、`e-run/e1-full-tests-coverage.log` | 是（2/2 次） | 修 mock 与未提交改动；提交前跑全量（同 E-1/B-06） |
| C1 | 低 | 文档与发布 | `src/components/SessionSidebar.tsx:64`、`src/components/AppShell.tsx:23-27` | README 宣传侧栏技能/提示词/市场，实际入口仅 chat/plugins/automations | 源码 + `report_C.md` C1 | 是 | 对齐 README 与实际入口 |
| C5 | 低 | 工程质量 | `src/components/workspace/SkillsPluginsViews.tsx:39`、`SessionSidebar.tsx:493` | 技能/提示词工作区视图已实现但无入口可达；市场组件/route 已删而 i18n 键残留 | 全库引用搜索 | 是 | 补入口或清理孤岛代码 |
| D1 | 低 | 架构与数据 | `src/lib/pi.ts:8`、`src/lib/jsonc-settings-storage.ts:6` | ES import 循环 `pi.ts→jsonc-settings-storage→path-security→pi` | `architecture/metrics.mjs` | 是（静态） | 抽取共享类型/工具打断循环 |
| D3 | 中 | 架构与数据 | `src/lib/workspace-store.ts:182`、`src/lib/automations/store.ts:219` | 写文件用临时文件+rename 和锁，但未 `fsync` 文件/目录，断电后持久性无保证 | 源码；未做断电注入 | 是（代码级） | 关键配置增加 fsync 与提交中断恢复测试 |
| D4 | 中 | 性能与SRE | `src/lib/session-reader.ts:275,293-320,342-353` | 会话扫描全量收集、`listSessions` 全量排序并随会话增长，无分页/上限 | 源码；1.2s TTL 只减重复 | 是（代码级） | 增加分页/游标与数量上限 |
| E1 | 中 | 工程质量 | `src/components/settings/GeneralSection.tsx:14,28` + 6 个测试文件 | 当前工作区全量测试基线红：50 failed（28 条 mock 缺 `DEFAULT_PEBREL_THEME` 确定性、17 条环境伪影、3 条 HEAD 既有、1 条便携 Node 无 npm、1 条并发 flake） | `e-run/run-e1.ps1`、`e-run/vitest-report.json` | 是 | 补 mock 导出；环境类在 CI/普通会话复跑（同 B-06） |
| E2 | 中 | 文档与发布 | `scripts/testing/check-skips.mjs` 白名单、`tests/powershell-encoding.test.ts:4`、`tests/agent-resource-isolation.test.ts:516` | ubuntu check job 的 skip-guard 会因 2 条平台跳过未白名单抛错 → CI 必红 | `e-run/e2-guard-probe.mjs`（platform=linux） | 是（函数级） | 补白名单或改用可识别写法；`check-skips.test.ts` 补断言 |
| E4 | 低 | 工程质量 | `src/app/api/config/route.ts:9`、`api/github/route.ts:14`、`api/version/route.ts:6` | 3 个路由无 handler 级测试（覆盖率 0%） | `e-run/analyze-routes.mjs` | 是 | 各补最小 route 测试（成功/鉴权/错误） |
| F1 | 低 | 安全 | `src/lib/auth.ts:79-89`、`src/proxy.ts:68-76` | “本机直连自动签发 Cookie”依赖可伪造 Host/代理头缺失（函数级可伪造），但 Next 恒注入 `x-forwarded-*` 使其不可达（死代码）；远程绕过经 B4 证伪 | `security/probes.test.ts`；`report_B.md` §4.3/5.2 | 是（两面均实测） | 改用 socket 对端地址判断或删除该分支及 launcher 兜底 |
| F2 | 中 | 安全 | `src/app/api/git/route.ts:27`、`src/proxy.ts:60`、`src/lib/auth.ts:43-48` | GET 并非全无副作用（git GET 起子进程、认证 GET 写设备记录）；有 Origin 时不比较 scheme | `report_F.md` F2 + 已有 38+17 用例 | 是 | GET 副作用改 POST；Origin 比较加入 scheme |
| G1 | 中 | 安全 | `src/lib/path-security.ts:63-72`、`src/lib/files-service.ts:325-332` | 文件读写不要求已注册工作区，认证后任意现存目录可作 cwd 读取（本机操作者级权限） | `security/probes.test.ts`（`allowed:true`） | 是 | 增加工作区授权白名单；文档说明权限边界 |
| G3 | 中 | 安全 | `src/lib/git-service.ts:67-69`、`src/lib/files-service.ts:686-687`、`src/lib/growth-service.ts:179` | 子进程环境未统一净化，`PI_WEB_*` 秘密/启动令牌可被继承（同 A6） | 源码 + 恶意 `.git/config` 10/10 防护实测 | 是（代码级） | 统一 allowlist（`scripts/update-environment.mjs:23-25` 可复用） |
| H3 | 中 | 性能与SRE | `src/lib/agent-manager.ts:2958-2967`、`:1711-1718` | 普通回合无 MaxSteps/总时长/token/cost 硬上限，异常循环会持续消耗额度 | 源码 + SDK `agent-loop.js:92-95` | 是（代码级） | 服务端加入步数/时长/预算熔断 |
| I1 | 中 | 安全 | `src/app/api/config/route.ts:11-13`、`src/lib/pi-settings.ts:119`、`src/lib/agent-manager.ts:3480-3482` | 配置导出原样带 proxy 凭据/trackingId；设置接口回显带凭据代理 URL；会话 JSONL 导出原样带密钥 | `i-run/i1-privacy.test.ts` → `i1-results.json` | 是 | 导出/回显前对凭据打码；导出功能明示敏感内容 |
| I2 | 低 | 安全 | `tests/fixtures/localhost-tls.ts:1-3`、`.gitignore:31,39-43` | 仓库跟踪测试专用私钥（非生产）；`.gitignore` 缺 `id_rsa/*.pem/*.key` 规则 | `i-run/i2-*` | 是 | 测试运行时动态生成密钥；补忽略规则或扫描 allowlist |
| I3 | 中 | 安全 | `src/lib/files-service.ts:498,502-616`、`src/lib/session-reader.ts:356-374`、`src/lib/session-retention.ts`（已删） | 删会话不清附件（≥30 天且回收仍留副本）；归档会话自动清理模块被移除；SDK 安装遥测默认开且无关闭入口/文档 | `i-run/i3-retention.test.ts` → `i3-results.json` | 是 | 删除时同步清扫附件；恢复/确认归档保留策略；暴露遥测开关 |
| I4 | 中 | 安全 | `src/lib/remote/supervisor.ts:390,453,260-262`、`src/lib/remote/mobile-proxy.ts:41-48,107-137` | LAN 入口默认 `0.0.0.0:30142` 自动监听；HTML 注入代理全量缓冲无上限、同步解压无上限（内存 DoS）；编码兜底损坏页面 | `i-run/i4-remote.test.ts` → `i4-results.json`（含 8.4MB 缓冲、65KB→64MiB 解压实测） | 是 | 默认仅回环+显式开启；代理加 16MiB 上限/流式透传/响应超时 |
| J6 | 中 | 功能缺陷 | `src/lib/settings-write-lock.ts:23-33`、`src/app/api/pi-settings/route.ts:19-28` | 10 并发 `PUT /api/pi-settings` 时 8–9 次 500 EACCES（单请求最长 7.9s），文件未损坏 | `j-run/scripts/run-main.mjs` phaseJ6；两次运行均复现 | 是（2/2） | Windows 锁 EACCES 可重试/退避；冲突返回 409/503+Retry-After |
| K1 | 低 | 工程质量 | `src/lib/jsonc-settings-storage.ts:159`、`src/lib/npm-install-transaction.ts:127` | 仓库无 Lint 配置；临时 eslint 扫描 2 个 `no-unsafe-finally` 错误（另有 4 条为临时配置缺插件导致） | `build/logs/21-eslint.log` | 是 | 引入正式 lint 配置并修复 finally 中 throw/return |
| K2 | 低 | 工程质量 | `src/lib/agent-manager.ts:3049`（3496 行）、`src/components/ChatWindow.tsx`（2645 行） | 超大源码文件与 8 个 >150 行函数（AST 识别） | `architecture/07_metrics_retry.log` | 是 | 按生命周期/协议拆分 |
| K3 | 低 | 工程质量 | `src/lib/session-reader.ts:275-283`；`architecture/empty-catches.json` | 121 个空 catch 中，会话扫描吞掉所有 readdir 异常返回空列表，无法区分无会话与 EACCES/磁盘错误 | AST 扫描 + 人工复核 | 是（静态） | 只吞 ENOENT，其余上报 |
| K5 | 低 | 工程质量 | `package.json:79-89` | 生产安装会承受 `@types/*`、typescript 与构建工具体积 | `package.json` + `report_K.md` K5 | 是 | 拆分预构建运行包与构建依赖 |
| L2 | 中 | 性能与SRE | `src/lib/models-service.ts:611-617` | `rt.checkAuth(providerId)` 未传 signal，应用层无法保证该分支超时；无统一重试策略 | 源码 | 是（代码级） | 传入 AbortSignal 并统一超时/重试 |
| L4 | 中 | 性能与SRE | `src/lib/agent-config.ts:51-58`、`src/lib/pi.ts:113-115` | 多个模块级 Map 缓存无容量/TTL（agent-config 读缺失文件也 set；pi 缓存按工作区长期保留） | 源码 + 12 项既有缓存测试 | 是（代码级） | 加 LRU/TTL 与工作区删除失效 |
| L5 | 中 | 性能与SRE | `scripts/process-runner.mjs:6-22`、`src/lib/remote/supervisor.ts:652-658` | 服务进程未注册远程 stopAll/自动化停机回调；Unix 无进程组时只杀直系 child | 源码 | 是（代码级） | 注册统一停机回调；跨平台进程树回收 |
| L6 | 中 | 性能与SRE | `scripts/launcher.mjs:622-634` | 收到 SIGINT/SIGTERM 直接强杀进程树，不先停接新连接/等待落盘（非优雅停机） | 源码 | 是（代码级） | 先发可处理停止信号、等待在途请求/落盘后超时强杀 |
| L7 | 中 | 性能与SRE | `src/app/api/agent/[id]/events/route.ts:55-64`、`src/lib/agent-manager.ts:2806-2814` | SSE 写入不检查 `desiredSize`，无慢客户端字节上限/每会话订阅者上限 | 源码 | 是（代码级） | 增加背压检测、队列上限与订阅者配额 |
| M2 | 低 | 工程质量 | `src/instrumentation-node.ts:20-21`、`src/lib/automations/runner.ts:512-517` | 日志仅有纯文本前缀，无结构化字段/请求 ID；多处空 catch 吞错（同 K3） | 源码 | 是 | 统一结构化日志与错误分级 |
| M4 | 中 | 性能与SRE | `src/app/api/health/route.ts:1-7` | `/api/health` 只返回静态 ok/service，无 readiness/依赖检查 | 源码（B3 实测返回体） | 是 | 增加受保护的 readiness 诊断，liveness 保持不泄密 |
| N4 | 低 | 工程质量 | `src/lib/api-error.ts:19-24`、`src/components/settings/ModelsSection.tsx:1170-1174` | 后端错误固定中文、前端直接显示，英文界面出现中文错误；日期格式化跟随 OS 语言 | 源码 + i18n 测试 | 是 | errorCode→本地化映射；显式传 UI 语言 |
| O1 | 低 | 文档与发布 | `README.md:93`、`README_zh.md:93`、`.github/workflows/check.yml:13-16` | README Node 版本下限与 engines 一致，但 CI/代理功能要求更高版本；README 残留已不存在的侧栏功能 | 阅读 + Lead 复核 `package.json:96` | 是 | 统一版本声明，清理过时功能说明 |
| O3 | 低 | 文档与发布 | `src/lib/web-secret.ts:38-42`、`src/lib/files-service.ts:675` | 37/55 环境变量未文档化（同 A4） | `architecture/env-docs.mjs` | 是 | 补文档并分诊内部/运维变量 |
| O4 | 低 | 文档与发布 | `README.md:198-209`、`README_zh.md:187-196` | README 开发验证序列可执行，但 test 步骤在当前工作区失败（同 E1/B-06）；全局安装/更新/卸载与反代示例未验证 | `report_B.md` 附录 A3 | 是（部分） | README 补环境前提；修测试基线 |
| O5 | 低 | 文档与发布 | `docs/planning/technical-design.md:5-17` | 设计文档导航描述与当前 Sidebar 三视图实现脱节 | 阅读 + 源码对照 | 是 | 同步“当前实现”章节并保留历史标记 |
| P1 | 中 | 文档与发布 | `.github/workflows/check.yml:13-16,37-50` | CI 未配 Lint、依赖漏洞门禁、macOS；未覆盖 README 声明支持的 Node 22.19 下限 | 阅读 workflow | 是 | 补门禁与版本矩阵 |
| P3 | 中 | 文档与发布 | `.github/workflows/publish.yml:27-44,82` | Actions 用可移动 v4 tag 而非 commit SHA；publish 未设 `PI_OFFLINE`、预构建/verify 未统一隔离 HOME | 阅读 workflow | 是 | SHA 锁定 Action；统一隔离/离线发布阶段 |
| P4 | 低 | 文档与发布 | `package.json:34-42`、`scripts/build-output.mjs:109` | 发布包含 `.next/trace`（1.36MB，含构建机绝对路径）；两处排除规则不一致 | `npm pack --dry-run --json`（b-run/logs/08） | 是 | `files` 增加 `"!.next/trace*"` 或打包前清理诊断文件 |
| P5 | 中 | 架构与数据 | `scripts/build-output.mjs:234-250`、`src/lib/update-service.ts:244-258` | Git 自更新 pull 后 install，共享 node_modules 不随旧构建回退；npm 更新非原子；缺紧急回滚/降级手册 | 源码 + `report_P.md` P5 | 是（代码级） | 版本化依赖与构建一同切换；补回滚手册 |

**跨节复核修正说明**（与原分节报告判定的差异）：K1 由“无法验证”→“有问题（低）”（B 节 tsc exit 0 + 临时 lint 证据）；N2 由“无法验证”→“通过”（B 节构建产物实测）；O4、P4 由“无法验证”→“有问题（低）”（B 节 README 实测与 pack 清单）；F1 严重程度由“待定/高候选”→“低”（B4 生产网络实测证伪远程利用）。

---

## 6. 最终输出⑤：无法验证的条目、原因与还需要什么

### 6.1 条目级（6 条）

| 编号 | 条目 | 无法验证原因 | 还需要什么 |
|---|---|---|---|
| C2 | 业务主链路 E2E + 重启持久化 | 未在隔离环境跑生产 HTTP 的 3–5 条 CRUD 全链并重启校验 | 隔离生产服务 + 可用的 CLI/模型依赖（或假服务）+ 写入→重启→查询脚本 |
| F4 | 会话/令牌/密码学跨 OS 与反代边界 | Windows 0600≠POSIX、双账户 ACL、Linux/macOS 文件权限、反代拓扑均未实测 | 第二 Windows 账户 ACL 测试 + Linux/macOS 权限实测 + 真实反代配置 |
| H1 | 间接提示词注入隔离 | 无真实付费模型凭据，未做恶意仓库内容诱导外传的对抗闭环 | 隔离假敏感数据 + 已授权测试模型 + 外传接收桩 + 多轮攻击样本 |
| L1 | 10 万文件大目录扫描/索引压测 | 未执行 10 万文件生产 HTTP 压测（J 节同项亦未覆盖） | 隔离压测目录 + 生产构建 + 索引接口耗时/内存采集 |
| M3 | 敏感字段脱敏审计 | 未发现直接打印 Authorization/Cookie，但 SDK/扩展异常整体输出无法静态证明不含凭据 | 带假密钥的恶意 provider/扩展异常注入 + stdout/stderr 捕获 |
| P2 | 近期 CI 运行诊断 | registry 两次连接失败，无法证明失败 SHA 从未被无 tag 发布 | registry 可达后核查所有版本 gitHead/provenance |

### 6.2 分节内的子项未验证（详见各分节报告）

- **B 节 U-1～U-8**：dev 模式内存压力崩溃根因（B-02）、生产专用安装首次启动自愈端到端、构建可重复性、第二主机、反代剥离 `x-forwarded-*` 时伪造 Host 是否重新可达、其他 Node 版本等（`report_B.md` §7）。
- **E 节 6 项**：Windows AppContainer/ACL 安全边界（本机会话受限）、Linux CI 实际跳过清单、17 条链接族失败的精确触发条件、覆盖率运行期间外部改动、`mention-parity` 工具链原因、Windows 本机 skip-guard（`report_E.md` §④）。
- **I 节 7 项**：会话 HTML 导出脱敏、attribution 头实际外发、真实 cloudflared 公网隧道、真机配对全流程、LGPL/MPL 分发法律判定、审计期间新快照覆盖、旧证据逐条重放（`report_I.md` §④）。
- **J 节 U-01～U-07**：真实断网、SSE 订阅者计数直读、真实模型 runNow、生产模式（dev 启动）、>50MB 水位、10 万文件（不适用）、配对码路径（`report_J.md` §4）。

---

## 7. 最终输出⑥：audit_tmp 清单、清理与后台进程确认

- **分节报告**：`audit_tmp/report_A.md … report_P.md` 共 16 份、约 354KB（大小/时间见 `final/appendix-audit-tmp.md`）。
- **证据目录**（收尾后）：`audit_tmp/run-20261115-full/` 计 **68.9MB / 3079 文件**，其中 `security/` 54.1MB（含上一轮安全证据与隔离数据）、`e-run/` 9.5MB、`build/` 2.0MB、`architecture/` 0.96MB、`b-run/` 0.5MB、`j-run/` 0.37MB、`i-run/` 0.33MB、`final/` 0.23MB。
- **清理记录**：本轮/上一轮遗留的可再生成大目录已按 R8 清理并记录到 `final/cleanup-generated-artifacts.md`：
  - `build/current`（干净克隆副本+node_modules）1000.2MB/45,482 文件 → 已删除；
  - `build/cache`（npx 兼容 Node 24.15 与包缓存）470.7MB/1,158 文件 → 已删除；
  - `build/lint-tools` 37.3MB、`build/coverage` 14.2MB、`build/tmp` 6MB → 已删除；
  - 仓库外 `D:\tmp\repo-audit-clone-16092`（上一轮 HEAD 干净克隆）679.8MB/40,492 文件 → 已删除。
  - 合计释放约 **2.21GB**；所有日志/脚本/JSON 证据/报告保留。
- **上一轮遗留进程清理**：审计开始时发现上一轮 Codex 中断遗留的卡死进程（构建 pipeline、仍在跑的 vitest、旧审计服务器等 5 组）占用资源，已清理并记录到 `final/cleanup-stale-processes.txt`；未触碰用户当时运行中的 PiWeb 实例（30141，用户后自行停止）。
- **审计自身进程**：本轮所有服务/压测进程均由各 agent `taskkill /T /F` 收尾；`final/state-check.md` 复核结果：**无审计相关 node 进程、无审计监听端口**。
- **仓库零污染**：`git status` 收尾 133 项 vs 基线 125 项，差异 8 项全部为外部并行改动（见 §8），HEAD 未变；本审计唯一写入的 `Microsoft/` 已移入回收站。**净污染 = 0**。
- 审计期间启动过的服务：B3/B4 生产与 dev 实例、J 节隔离 dev 实例、I 节测试内监听端口等，均已在各分节报告 §清理 中逐一确认关闭。

---

## 8. 其他重要事项

1. **外部并行开发活动**：审计期间（18:50–19:09）工作区被外部改动 8 项（`runtime-proxy` 功能、`pi-settings` PUT 分支、`tsconfig.json` 等），并有外部 `npm run build:release`/`npm run check` 进程；这些**不属于本轮审查范围**，也非审计写入。详细清单与影响见 `final/external-parallel-activity.md`。若需覆盖新代码，应在快照冻结后补审（I 节报告已给出补充路径）。
2. **审计断点与恢复**：上半场 Codex 在 18:31 因用量上限中断（12/16 节完成）；下半场 DSH 在 19:11 因会话重启中断一次，B/E/J 三个子 agent 于 19:36–19:51 恢复并补齐（均已 `complete` 共享任务）。完整任务板记录：task-1～task-5。
3. **环境/工具链归因**（不属于项目缺陷）：本机 Node 24.12 低于 jsdom 要求（用 24.15 兼容版）；DSH 受限会话无法创建符号链接/AppContainer（导致 33 条沙箱用例跳过、17 条链接族用例失败）；`D:\tmp` 等工作区外目录不能被子进程建目录（B1 改在工作区内构建）。这些均在分节报告中与代码缺陷明确区分。
4. **构建/超时基线**：`next build --webpack` 在本机实测 370.4s（并发负载下），上一轮 600s 超时导致误判；建议 CI/本地超时 ≥15 分钟（B-08）。

---

## 9. 附录索引（均在 `audit_tmp/run-20261115-full/final/`）

| 附录 | 内容 |
|---|---|
| `appendix-commands.md` | 上半场 73 条命令（退出码/日志路径） |
| `appendix-commands-dsh.md` | 下半场 B/E/I/J 113 条命令 |
| `appendix-files.md` | 已阅读文件清单 + 核心目录未阅读清单（122 读 / 79 核心读 / 211 未读） |
| `appendix-audit-tmp.md` | audit_tmp 产物与体积清单 |
| `state-check.md` | 收尾零污染与进程/端口检查 |
| `cleanup-generated-artifacts.md` | 大目录清理记录（约 2.21GB） |
| `cleanup-stale-processes.txt` | 上一轮遗留进程清理记录 |
| `external-parallel-activity.md` | 审计期间外部并行改动记录 |
| `existing/` | 上半场 12 节结构化提取（items.json / issues.md / verdicts.md / coverage-check.md） |

---

**交付自查**：A1–P5 共 87 条逐条给出判定与证据入口（§4）；问题汇总表 42 行（§5）；无法验证 6 条及所需条件（§6）；命令、文件、audit_tmp 清单与进程清理（§2/§3/§7）；R1–R8 遵循情况已在 §1.3、§7 与各分节报告中说明。
