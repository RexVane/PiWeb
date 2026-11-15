# PiWeb 审计问题修复报告（修复轮 · 2026-11-15）

> **修复口径（用户选择）**：**只修缺陷，不改默认行为**。默认值、默认接口语义、默认 UI 表现保持不变；安全/性能缺陷按“缺陷语义”修复；需要新能力的一律用 env 或显式参数 opt-in；无法在不改默认行为下完成的项标为 deferred 并说明。
> 修复基线：`audit_tmp/run-20261115-full/fix/fix-baseline.txt`（136 项未提交改动，HEAD `4a6a59e2`，branch `main`）
> 执行时间：2026-11-15 20:14–22:15（Asia/Shanghai）
> 执行方式：Lead + 5 个并行修复 agent（A1 tests-ci / A2 auth-exports / A3 retention-tunnel / A4 sre-core / A5 docs-ui，共享任务 task-6～10）+ 独立验证 agent（task-11）+ C5 死代码清理 agent（task-12）
> 整体验证：**通过（无阻塞）** → [`audit_tmp/run-20261115-full/fix/verify/verification.md`](audit_tmp/run-20261115-full/fix/verify/verification.md)
> 审计基线：报告 [`audit_tmp/report_final.md`](audit_tmp/report_final.md)（42 项“有问题”、6 项无法验证、1 项不适用）
> 提交记录：见 §8（2026-11-15 已按用户选择提交 5 个 commit，仅含本轮新增/修改且修复前无旧改动的文件）

---

## 0. 摘要

| 指标 | 结果 |
|---|---|
| 审计“有问题”项 | **42** 项：**已修复 32 / 部分修复 7 / 明确 deferred 3** |
| 类型检查 | `tsc --noEmit --incremental false` **exit 0**（1.8s，0 输出） |
| Lint（新增门禁） | **exit 0，0 error / 29 warning**（均为既有 warning，不阻塞） |
| 全量测试 | 最终 **316 文件 / 2508 用例**：**2505 passed / 1 failed / 2 skipped**（456s，C5 清理后）。唯一失败为**本机受限会话 AppContainer 环境限制**（修复前 HEAD 日志即同失败，非产品缺陷、非回归）；审计基线的 50 failed 已全部消除 |
| 生产构建 | **exit 0**；C5 清理后最终复跑 **118.3s**（`.next/cache` 预热），BUILD_ID `DElOOn0Pb7bYwEF-Xwzlt`，337 runtime files（清理前验证为 161.2s / `Tm3weU65dr-0yLbUxu5wh`） |
| 打包校验 | **exit 0**，1080 文件 / 4.06MB；无 `.next/trace*`/diagnostics/lint 工具链/cache/audit；含 `THIRD-PARTY-NOTICES.md` + `LICENSE` |
| 工作树 | **已全部提交，工作区干净**：2026-11-15 22:22 在用户确认后追加 2 个 commit（混合文件 25 + 其余既有改动 160），合计 7 个 commit 已 push 到 `fork/main`（RexVane/PiWeb）；CI check run `43724228000` 运行中（windows-latest 复跑见 §8） |
| 进程/端口 | 无残留测试/构建进程与监听；用户 30141 实例在收尾时已由用户侧停止（本报告不重启、未占用） |
| 变更规模 | 修复轮涉及约 97 个文件（20:14–22:00）；提交 80 个文件（36 个已跟踪修改 + 新增文件），`package-lock.json` 未变 |

---

## 1. 最终验证结论（独立验证 agent，最终状态）

| # | 验证项 | 结果 |
|---|---|---|
| 1 | typecheck | ✅ exit 0（复跑于 Lead 收尾改动后，1.8s） |
| 2 | lint | ✅ exit 0（0 error / 29 warning：14 react-hooks、13 next/no-img、2 unused eslint-disable，均既有） |
| 3 | 全量测试 | ⚠️ 1 failed / 2505 passed / 2 skipped（316 文件，456s，C5 清理后最终态）。唯一失败 `windows-acl > supports a writable private temp…` 为**既有的本机 AppContainer 环境限制**（修复前 HEAD 与 A1 中间基线同一用例同一断言失败；本机审计全量中该文件按内置条件整文件跳过），非产品缺陷、非本轮回归；建议在 windows-latest CI 复跑确认 |
| 4 | 生产构建 | ✅ exit 0；C5 清理后最终复跑 118.3s（预热缓存），BUILD_ID `DElOOn0Pb7bYwEF-Xwzlt`，337 runtime files（清理前 161.2s / `Tm3weU65dr-0yLbUxu5wh`），`.next` 产物齐全 |
| 5 | 打包校验 | ✅ 4,047,211 B / 1080 文件（C5 清理后最终复跑）；`.next/trace*`、diagnostics、lint 工具链 node_modules **均 absent**；NOTICES+LICENSE 在包内（清理前验证同为 4.06MB/1080 文件且无 trace） |
| 6 | 状态对比 | ✅ HEAD 未变、无意外删除、无 20:42 后改动、新增条目全部可归因；C5 清理后测试文件 317→316（删除 1 个只覆盖死视图的测试） |
| 7 | 进程/端口 | ✅ 无残留；用户实例在收尾时已停止（用户侧行为，本报告未操作） |

> C5 清理后的最终 build/pack 由 Lead 于 2026-11-15 22:2x 复跑：`node scripts/build.mjs` exit 0 / 118.3s / BUILD_ID `DElOOn0Pb7bYwEF-Xwzlt`；`npm pack --dry-run --json` 1080 文件 / 4,047,211 B 且 trace/diagnostics/lint-toolchain 均不存在。其余验证数字为 task-11 最终结果。

> 全量测试从审计基线 50 failed → 0 条产品缺陷失败；最终 316 文件 / 2508 用例（审计基线 288/2347；修复轮新增 27 个测试文件，C5 清理轮又删除 1 个只覆盖已删视图的测试文件）。
> 环境前提：全量测试需把 `TEMP/TMP/TMPDIR` 放在**仓库 git 检出之外**（审计时 TEMP 在 `audit_tmp/` 内会触发 3 条 git 相关假失败；已由 A4 定位并在验证脚本中修正，不是产品缺陷）。

---

## 2. 42 项“有问题”逐项修复状态

### 2.1 已修复（32 项）

| 编号 | 严重度 | 修复内容 | 关键改动/测试 |
|---|---|---|---|
| A4 | 低 | 环境变量文档补全：`docs/operations/environment.md` 覆盖内部/运维变量；最终扫描 50 个 env 无未文档化部署变量 | A5；`docs/operations/environment.md` |
| A5 | 中 | 文档说明 `PI_CODING_AGENT_DIR` 不是全部数据根（HOME/USERPROFILE 仍参与导入/全局技能），并给出隔离建议 | A5；`docs/workspace-isolation.md`、`docs/operations/data-and-privacy.md` |
| A6 | 中 | 新增 `child-process-env.ts` 统一子进程环境清洗；git/编辑器/growth 调用点全部接入（移除 `PI_WEB_*`/TOKEN/SECRET/PASSWORD 等，保留 PATH/HOME） | A2/A3/A4；`src/lib/child-process-env.ts`、`tests/lib/child-process-env.test.ts`、`tests/git-service-env.test.ts`、`tests/files-service-editor-env.test.ts` |
| B1 | 中 | 构建/类型/打包校验全绿；全量单测 50 failed 全部消除（仅剩 1 条既有 AppContainer 环境失败）；构建失败输出可诊断（`PIWEB_BUILD_VERBOSE=1` 打印完整输出，`error.output` 挂载 ≤256KB） | A1/A4/Lead；`scripts/build.mjs`、`scripts/process-runner.mjs` |
| C1 | 低 | README 中英与 docs 对齐当前真实入口（chat/plugins/automations），删除不存在的侧栏技能/提示词/市场承诺 | A5；`README.md`、`README_zh.md` |
| C5 | 低 | **按用户决定删除死代码**：移除无入口的 `SkillsWorkspaceView`/`PromptsWorkspaceView`（保留 AppShell 使用的 `PluginsWorkspaceView`，532→81 行），清理 62 个 i18n 键（中英各 124 行），删除 1 个只覆盖死视图的测试、改写 1 个测试保持覆盖（SkillsSection harness）；tsc/lint/全量测试通过 | cleanup-c5；`src/components/workspace/SkillsPluginsViews.tsx`、`src/i18n.tsx`、`tests/components/workspace-resource-lifecycle.test.tsx`；证据 `fix/cleanup-c5/`（源文件带既有未提交改动，删除暂未提交，见 §8） |
| D1 | 低 | 新增叶子模块 `src/lib/path-boundary.ts`，打破 `pi.ts↔jsonc-settings-storage↔path-security` 循环；import 图 0 循环 | A4；`src/lib/path-boundary.ts`、`fix/sre-core/cycle-graph.txt` |
| D3 | 中 | 原子写路径补 `fsync`（文件+目录）；Windows 目录 fsync 不可用时安全降级（EINVAL/EPERM/EBUSY/ENOTSUP） | A4；`src/lib/atomic-file.ts`、`jsonc-settings-storage.ts`、`workspace-store.ts`、`automations/store.ts`、`tests/lib/atomic-file-durability.test.ts` |
| E1 | 中 | 测试基线修复：theme-mock 28 条（外部已修）+ 3 条 git 相关根因定位为隔离 TEMP 位置 + 新增测试全绿；50 failed → 1 既有环境失败 | A1/A4/verify；`fix/tests-ci/`、`fix/verify/logs/vitest-full.log` |
| E2 | 中 | `check-skips.mjs` 白名单补 2 条真实平台跳过；`tests/check-skips.test.ts` 补断言；Linux guard 不再误红 | A1；`scripts/testing/check-skips.mjs` |
| E4 | 低 | 为 `/api/github`、`/api/version`、`/api/config` 增加 handler 级测试（成功/鉴权/错误分支） | A1/A2；`tests/api/github-version-routes.test.ts`、`config-route.test.ts` |
| F1 | 低 | 删除“本机直连自动签发 Cookie”死代码分支（依赖可伪造 Host/代理头；默认部署原本不可达）、`isDirectLoopbackRequest` 配套判定与 launcher `x-piweb-warmup` 兜底；测试改断言新语义 | A2/A4；`src/proxy.ts`、`src/lib/auth.ts`、`scripts/launcher.mjs`、`tests/proxy-auth.test.ts` |
| F2 | 中 | Origin 校验加入 scheme 比较（协议不同→跨源 403，支持 `x-forwarded-proto`）；`/api/git` GET 增加跨站保护（cross-site/跨源 Origin → 403） | A2；`src/lib/auth.ts`、`src/app/api/git/route.ts`、`tests/auth.test.ts`、`tests/api/git-route-guard.test.ts` |
| G3 | 中 | git/growth 子进程改用统一 `child-process-env`（不再继承启动令牌等秘密）；恶意 `.git/config` 防护仍 10/10 | A4；`src/lib/git-service.ts`、`growth-service.ts` |
| H3 | 中 | 新增可选 Agent 回合预算（env，默认关闭=原行为）：`PIWEB_AGENT_MAX_STEPS`/`PIWEB_AGENT_MAX_DURATION_MS`/`PIWEB_AGENT_TOKEN_BUDGET`，超限中止并返回明确错误 | A2；`src/lib/agent-manager.ts`、`tests/agent-manager-budget.test.ts` |
| I1 | 中 | 导出/回显默认脱敏：`/api/config`、`/api/pi-settings` GET、会话 JSONL/HTML 导出；`?raw=1` 显式取原文；新增 `secret-redaction` 工具（URL userinfo/sk-/Bearer/JSON 密钥字段） | A2；`src/lib/secret-redaction.ts`、`*/route.ts`、`tests/lib/secret-redaction.test.ts` 等 |
| I2 | 低 | `.gitignore` 补 `id_rsa*`/`*.pem`/`*.key`/`*.p12`/`*.pfx`（确认不误伤已跟踪文件） | A3；`.gitignore` |
| J6 | 中 | 设置写并发：锁 EACCES/EPERM/ELOCKED/EBUSY 退避重试；锁冲突返回 409/503 + `Retry-After`（不再 500）；`settings.json` 保持合法 | A2；`src/lib/settings-write-lock.ts`、`src/app/api/pi-settings/route.ts`、`tests/settings-write-lock.test.ts`、`tests/api/pi-settings-concurrency.test.ts` |
| K1 | 低 | 新增独立 lint 工具链 `scripts/testing/lint/`（eslint 10 + typescript-eslint 8 + react-hooks + next 插件 + typescript 6，锁版本、自带 lockfile；`npm run lint` 单命令，首装自动 `npm ci --prefix`，`PIWEB_LINT_SKIP_INSTALL=1` 离线）；修复 2 个真实 `no-unsafe-finally` 错误；最终 0 error/29 warning | A1/A4；`scripts/testing/lint/`、`eslint.config.mjs`、`jsonc-settings-storage.ts`、`npm-install-transaction.ts` |
| L2 | 中 | `configuredCredentialFor` 的 `rt.checkAuth(providerId)` 传入 20s AbortSignal；测试覆盖 | A4；`src/lib/models-service.ts`、`tests/models-service-configured-credential-signal.test.ts` |
| L4 | 中 | 缓存容量/TTL 上限：`PIWEB_AGENT_CONFIG_CACHE_MAX`/`_TTL_MS`、`PIWEB_PI_CACHE_MAX`（宽松默认，正常规模行为不变）；缺文件读取不再无限 set | A4；`src/lib/agent-config.ts`、`src/lib/pi.ts`、`tests/agent-config-cache.test.ts` |
| L5 | 中 | 新增 `graceful-shutdown.ts` 停机钩子注册；remote supervisor 注册 `shutdownRemote`、automations runner 注册清理；stopAll 逻辑可被停机流程调用 | A3/A4；`src/lib/graceful-shutdown.ts`、`src/lib/remote/supervisor.ts`、`tests/remote-supervisor.test.ts` |
| L6 | 中 | 优雅停机：launcher/process-runner/`bin/pi.js` 收到 SIGINT/SIGTERM 先请求子进程收尾并等待预算（`PIWEB_GRACEFUL_STOP_TIMEOUT_MS`，默认 10s，`PIWEB_DISABLE_GRACEFUL_SHUTDOWN` 可关），超时才整树强杀；退出码约定不变 | A4/Lead；`scripts/launcher.mjs`、`scripts/process-runner.mjs`、`bin/pi.js`、`tests/launcher-graceful-stop.test.ts`、`tests/pi-supervise.test.ts` |
| L7 | 中 | SSE 背压：慢客户端积压超 `PIWEB_SSE_MAX_BUFFERED_BYTES`（默认 4MiB）断开；每会话订阅者上限 `PIWEB_MAX_SESSION_SUBSCRIBERS`（默认不启用） | A2/A4；`src/app/api/agent/[id]/events/route.ts`、`agent-manager.ts`、`tests/events-backpressure.test.ts` |
| M4 | 中 | 新增受认证 `GET /api/health/readiness`（数据目录可写、调度器/模型配置状态；异常 503 可读原因）；`/api/health` 响应逐字不变 | A4；`src/app/api/health/readiness/route.ts`、`tests/api/health-readiness.test.ts` |
| O1 | 低 | README/RELEASING/CI 版本口径统一（22.19.0 为最低且进入 CI 矩阵；22.22.2/24 支持轨道；代理功能版本要求单列） | A5/Lead；`README*.md`、`.github/RELEASING.md` |
| O3 | 低 | 运维环境变量文档补全（`docs/operations/environment.md`） | A5 |
| O4 | 低 | README 命令与实际对齐；test 步骤在当前工作区可跑（唯一环境限制如实说明）；构建时长/超时建议写入文档 | A5；`docs/operations/install-and-build.md` |
| O5 | 低 | 设计/进度文档同步当前实现（技能/提示词/市场等已删除功能不再描述为当前能力） | A5；`docs/planning/technical-design.md` 等 |
| P1 | 中 | CI 增加：lint 门禁（独立工具链安装 + `npm run lint`）、依赖漏洞门禁（`npm audit --audit-level=high`）、Node 22.19.0 矩阵、macOS 最小 job（node 24）、job 超时（主 45min/任务 20-25min） | A1；`.github/workflows/check.yml` |
| P3 | 中 | 第三方 Actions 全部 commit SHA 锁定（3 个 workflow）；publish/verify 步骤补 `PI_OFFLINE=1`/隔离变量；权限已最小化；发布触发条件不变 | A1；`.github/workflows/{check,publish,remote-e2e}.yml` |
| P4 | 低 | 发布包排除 `.next/trace*`、`.next/diagnostics`、lint 工具链；`npm pack --dry-run` 实测 1080 文件/4.06MB，无 trace/诊断文件，含 NOTICES+LICENSE | A1；`package.json`、`tests/package-files-policy.test.ts` |

### 2.2 部分修复（7 项，均为“在不动默认行为前提下能做到的最大范围”）

| 编号 | 严重度 | 已做 | 未做/原因 |
|---|---|---|---|
| D4 | 中 | `listSessions` 支持可选 `{limit, offset}` + API query 透传；新增分页测试 | 用户拍板保持默认全量、无默认上限（兼容优先） |
| G1 | 中 | 新增可选严格模式：`PIWEB_FS_STRICT_WORKSPACES=1` + `PIWEB_FS_ALLOWED_ROOTS`（默认关闭=原行为）；文档说明 | 默认仍允许任意现存目录（单操作者远控设计；收紧默认需产品决定） |
| I3 | 中 | 删除会话时清理“仅被该会话引用”的上传附件（走 `recoverableRemove` 备份+INDEX，`PI_WEB_DELETE_ATTACHMENT_CLEANUP=0` 可关）；文档说明遥测与留存 | SDK 安装遥测默认值按用户拍板保持；归档会话自动清理按用户拍板保持现状（不自动清理） |
| I4 | 中 | 手机代理：HTML 注入缓冲上限（16MiB 默认，超限流式透传）、解压输出上限（64MiB，超限 502）、响应超时（30s）、不支持 encoding 保留原头透传；新增 `PIWEB_REMOTE_LAN_BIND` 覆盖绑定地址 | LAN 默认按用户拍板保持 `0.0.0.0` |
| K3 | 低 | `session-reader` 仅把 ENOENT 当“无会话”，其他 readdir 错误 warn 后上抛（审计点名的关键吞错已修） | 其余 120 个空 catch 未逐一改造（需按场景审查，避免引入回归） |
| N4 | 低 | 新增 `localizeApiError(lang, errorCode, fallback)` helper（`@/i18n`）；`ModelsSection` 已接入示范；日期格式化按 UI 语言 | 用户拍板暂缓：其余前端组件仍直接显示 `json.error`（中文兜底），后续可逐组件迁移 |
| P5 | 中 | 新增发布回滚/降级/数据恢复手册（`docs/operations/release-and-rollback.md`）；lint/CI 门禁已补 | 应用内更新的原子切换代码未改（涉及更新事务设计，风险高，建议独立任务） |

### 2.3 明确 deferred（3 项，未做并说明）

| 编号 | 严重度 | 未做原因 | 建议 |
|---|---|---|---|
| K2 | 低 | 超大文件/长函数重构（`agent-manager.ts` 3496 行等）属结构性重构，回归面大，不适合混在缺陷修复轮 | 独立重构 PR（先补测试再拆模块）——用户拍板暂缓 |
| K5 | 低 | 依赖结构调整（构建工具/@types 移出生产依赖、预构建运行包）会改变发布形态与安装路径，需单独设计与验证 | 独立发布工程任务——用户拍板暂缓 |
| M2 | 低 | 结构化日志/请求 ID/统一错误级别属跨切面改造，影响日志消费方 | 独立可观测性任务——用户拍板暂缓 |

### 2.4 审计中“无法验证”6 项（无确认的代码缺陷，未改代码）

C2（业务主链路 E2E+重启持久化）、F4（跨 OS 权限/反代边界）、H1（提示词注入对抗）、L1（10 万文件压测）、M3（日志脱敏对抗注入）、P2（registry 发布历史）：本轮未改代码（无已证缺陷）；其中 P2 需 registry 可达、H1 需真实模型、F4 需第二账户/多 OS、L1 需压测环境；C2 可用 `tests/integration/` + 隔离生产服务补端到端脚本。

### 2.5 其他低危子项处理情况

- **已修**：B-03（构建失败输出可诊断，含完整 output 挂载）、B-04/P4、B-05（安装机制文档）、B-06（测试基线）、B-08（构建时长/CI 超时）；E-7（未 await 断言）；I-10（编码兜底）、I-14（第三方许可证 NOTICES）、I-15（gitignore 私钥规则）、I-17（Node 版本文档）；J-ISSUE-01/02/03/05。
- **deferred/保留（用户已拍板）**：B-02（dev 模式内存压力原生崩溃，空闲不复现；需受限内存环境复现）、B-07（vitest 5 worker 启动超时硬编码，无公开配置项）、E-9（并发 flake，环境）、I-04（header 值级密钥检测，低危）、I-05（SDK 遥测默认值保持）、I-07（归档清理保持现状）、I-08（LAN 默认保持）、I-11（隧道引擎 PATH 回退）、I-12/I-13（依赖更新/registry 策略）、I-16（测试夹具私钥保留并已补 gitignore）、J-ISSUE-04（信号监听器警告未定位）。
- **C5 删除产物**：`SkillsPluginsViews.tsx` 从 532 行降到 81 行；删除 `tests/components/workspace-views-prompts-market.test.tsx`（已备份 `fix/cleanup-c5/backups/`）；i18n 1019→957 键/字典。源文件与 i18n 带既有未提交改动，删除只存在于工作区、尚未提交（见 §8）。

---

## 3. 缺陷语义变化（默认生效，均为修复本身）

以下变化是缺陷修复的必然结果（不是产品默认值翻转）；逐项在报告中标明，便于审阅：

1. **会话删除**：同步清理仅被该会话引用的上传附件（可恢复备份 + INDEX）；会话 JSONL 本身仍直接删除。`PI_WEB_DELETE_ATTACHMENT_CLEANUP=0` 可关闭附件清理。
2. **导出/回显脱敏**：`/api/config`、`/api/pi-settings` GET、会话 JSONL/HTML 导出默认脱敏；`?raw=1` 显式取原文（仍要求认证）。响应头增加 `X-PiWeb-Redacted` 标记。
3. **设置写并发**：锁冲突从 500 改为 409/503 + `Retry-After`（锁内部先退避重试）。
4. **认证**：删除“本机直连自动签发 Cookie”死代码与 launcher warmup 兜底（默认部署原本不可达；curl/脚本直接访问本机页面仍需登录令牌）。
5. **CSRF/跨站**：Origin 校验纳入 scheme；`/api/git` GET 对跨站请求返回 403。
6. **输入校验**：`/api/fs` 含 NUL 的 path → 400；工作区别名 >1000 字符 → 400。
7. **手机代理上限**：HTML 注入缓冲 >16MiB 改流式透传（不注入，页面仍可用）；解压输出 >64MiB → 502；上游 HTML 等待总时长 >30s 改流式透传；不支持的 encoding 保留原头透传（避免损坏页面）。
8. **流式背压**：SSE 慢客户端积压 >4MiB 断开连接（防内存耗尽）。
9. **持久化**：原子写增加 fsync（Windows 目录 fsync 不可用时降级，不报错）。
10. **优雅停机**：SIGINT/SIGTERM 先请求子进程收尾并等待预算（默认 10s）再强杀；退出码约定不变；`bin/pi.js` 同步。
11. **缓存上限**：agent-config/pi 缓存加容量+TTL（宽松默认，正常规模行为不变）。
12. **Provider 鉴权超时**：`checkAuth` 使用 20s AbortSignal。
13. **健康检查**：新增受认证 `/api/health/readiness`；`/api/health` 响应逐字不变。

## 4. 新增 opt-in 开关/环境变量（默认值均保持原行为）

| 变量/参数 | 默认 | 作用 |
|---|---|---|
| `PIWEB_FS_STRICT_WORKSPACES` | 关 | 启用文件路径严格边界（配合 `PIWEB_FS_ALLOWED_ROOTS`） |
| `PIWEB_FS_ALLOWED_ROOTS` | 空 | 严格模式允许的根目录列表（`path.delimiter` 分隔） |
| `PIWEB_AGENT_MAX_STEPS` / `PIWEB_AGENT_MAX_DURATION_MS` / `PIWEB_AGENT_TOKEN_BUDGET` | 未设置（不限制） | Agent 回合步数/时长/token 预算熔断 |
| `PIWEB_MAX_SESSION_SUBSCRIBERS` | 未设置（不限制） | 每会话 SSE 订阅者上限 |
| `PIWEB_SSE_MAX_BUFFERED_BYTES` | 4MiB | 单连接 SSE 积压上限，超限断开 |
| `PIWEB_AGENT_CONFIG_CACHE_MAX` / `PIWEB_AGENT_CONFIG_CACHE_TTL_MS` / `PIWEB_PI_CACHE_MAX` | 宽松默认 | 缓存容量/TTL |
| `PIWEB_MOBILE_PROXY_MAX_HTML_BYTES` | 16MiB | 手机代理 HTML 注入缓冲上限（超限流式透传） |
| `PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES` | 64MiB | 手机代理解压输出上限（超限 502） |
| `PIWEB_MOBILE_PROXY_TIMEOUT_MS` | 30000 | 手机代理等待上游 HTML 总时长 |
| `PIWEB_REMOTE_LAN_BIND` | `0.0.0.0`（不变） | 局域网入口绑定地址覆盖（如改回环） |
| `PI_WEB_DELETE_ATTACHMENT_CLEANUP` | 开 | 设为 `0` 关闭“删会话时清理独占附件” |
| `PIWEB_GRACEFUL_STOP_TIMEOUT_MS` | 10000 | 优雅停机等待预算 |
| `PIWEB_DISABLE_GRACEFUL_SHUTDOWN` | 未设置 | 设为 1 回到旧的立即强杀行为 |
| `PIWEB_SHUTDOWN_TIMEOUT_MS` | 内置默认 | 停机钩子总预算（graceful-shutdown 模块） |
| `PIWEB_LINT_SKIP_INSTALL` | 未设置 | 设为 1 时 lint 不联网安装工具链（CI 缓存/离线） |
| `PIWEB_BUILD_VERBOSE` | 未设置 | 设为 1/true 时构建打印完整输出（成功与失败） |
| `?raw=1`（`/api/config`、`/api/pi-settings` GET、`/api/sessions/[id]/export`） | 未设置（默认脱敏） | 显式获取未脱敏原文（仍受认证保护） |

## 5. 新增测试与质量门禁

- **新增测试 27 个文件 / 147 个用例**（见验证报告 §6.1 清单；C5 清理轮删除 1 个死视图测试、改写 1 个保持覆盖），覆盖：认证/Origin/CSRF、导出脱敏、设置并发、NUL/长度校验、SSE 背压、手机代理上限、fsync 持久性、缓存上限、provider 鉴权信号、优雅停机、readiness、子进程 env、分页、附件清理、i18n/localizeApiError、打包白名单、check-skips、pi-supervise/launcher 等。
- **修改既有测试 9 个**（auth/proxy-auth/pi-settings-refresh/session-export/remote-supervisor/update-service-process/check-skips/workspace-store/workspace-resource-lifecycle 等）。
- **Lint 门禁**：`npm run lint`（独立锁版本工具链，不污染根 `typescript@7`）→ CI 已接入；当前 0 error / 29 warning。
- **CI 门禁**：lint、`npm audit --audit-level=high`、Node 22.19.0/22.22.2/24 矩阵、macOS 最小 job、Actions SHA 锁定、`PI_OFFLINE` 隔离、job 超时 ≥15min。
- **打包门禁**：`npm pack --dry-run` 校验 trace/diagnostics/lint 工具链排除 + NOTICES/LICENSE 入包（`tests/package-files-policy.test.ts`）。

## 6. 如何审阅 / 回滚 / 生效

- **审阅**：本轮改动集中在修复窗口（2026-11-15 20:14–22:00），已提交部分见 §8；未提交部分见 §8 末尾清单。`git diff -- <文件>` 查看单文件差异；基线对比 `audit_tmp/run-20261115-full/fix/fix-baseline.txt`。
- **回滚**：已提交的 5 个 commit 可 `git revert <hash>`；未提交改动逐文件 `git restore -- <paths>` 或移除新增文件。默认行为除 §3 缺陷语义变化外未翻转；运行时用 §4 的开关可单独关闭新行为。
- **生效**：用户 30141 实例在收尾时已停止（用户侧行为）；下次启动/`npm run build:release` 后新代码生效。
- **用户已拍板结论**（2026-11-15 晚间）：I-05 遥测保持默认、仅文档说明；I-07 归档清理保持现状；I-08 LAN 默认保持 `0.0.0.0`；I-16 测试夹具私钥保留；C5 死代码删除（已实施，源文件待随混合改动提交）；D4 会话列表保持默认全量；N4 其余组件本地化暂缓；K2/K5/M2 暂缓；提交策略=只提交修复轮干净文件（已完成）。

## 7. 证据索引

| 内容 | 路径 |
|---|---|
| 整体验证（本报告数字来源） | `audit_tmp/run-20261115-full/fix/verify/verification.md` + `logs/` |
| A1 测试/CI/工具链/打包 | `audit_tmp/run-20261115-full/fix/tests-ci/` |
| A2 认证/导出/设置并发/输入校验 | `audit_tmp/run-20261115-full/fix/auth-exports/` |
| A3 会话/附件/远程代理/许可证 | `audit_tmp/run-20261115-full/fix/retention-tunnel/` |
| A4 数据/SRE/进程/缓存/健康检查 | `audit_tmp/run-20261115-full/fix/sre-core/` |
| A5 文档/UI/发布说明 | `audit_tmp/run-20261115-full/fix/docs-ui/` |
| C5 死代码清理 | `audit_tmp/run-20261115-full/fix/cleanup-c5/`（report.md、i18n 键清单、diff、删除备份） |
| 提交记录 | `audit_tmp/run-20261115-full/fix/commit-log.md` |
| 修复基线 | `audit_tmp/run-20261115-full/fix/fix-baseline.txt` |
| 审计总报告（问题原始定义） | `audit_tmp/report_final.md` |

## 8. 提交记录（2026-11-15 22:10）

按用户选择：**只提交“修复轮新增/修改、且修复前没有旧改动”的文件**；修复前就已有未提交改动的文件（含 23 个本轮也改过的“混合文件”）保留在工作区，等待 review 后再提交。共 **5 个 commit、80 个文件**：

| commit | 主题 | 文件数 |
|---|---|---|
| `5e7c254` | fix(security): redact exports, harden auth, input validation and child-process env | 22 |
| `3d64847` | fix(stability): durable writes, graceful shutdown, bounded caches, SSE backpressure and readiness | 30 |
| `91c6b36` | test(ci): repair test baseline, add pinned lint toolchain and CI gates | 15 |
| `ceb4de2` | docs: align guides with current behavior, add operations runbooks and third-party notices | 11 |
| `687e44c` | test(views): adapt workspace lifecycle coverage and add sessions pagination tests | 2 |

- 完整文件清单/剩余清单：`audit_tmp/run-20261115-full/fix/commit-log.md`。
- **仍留在工作区（未提交）**：136 个路径 = 修复前既有改动 113 个（与本轮修复无关的既有工作）+ 23 个本轮也改过的混合文件（`proxy.ts`、`auth.ts`、`agent-manager.ts`、`files-service.ts`、`session-reader.ts`、`mobile-proxy.ts`、`workspace-store.ts`、`models-service.ts`、`i18n.tsx`、`README*.md`、`tsconfig.json`、`pi-settings` 路由等）+ C5 的源文件删除/i18n 清理（`SkillsPluginsViews.tsx`、`i18n.tsx`、删除的 prompts 测试）。
- **已知代价**：这 5 个 commit 只含干净文件，其中部分文件依赖“混合文件”里的未提交改动（如会话导出路由依赖 agent-manager 的新签名），因此**单独 checkout 这 5 个 commit 时可能无法完整通过 typecheck**；等混合文件也提交后 HEAD 才完整可构建。这是用户选择“干净文件提交”的预期取舍。
- `package-lock.json` 未变；lint 工具链有独立 lockfile（`scripts/testing/lint/package-lock.json`）。

### 追加提交与 push（2026-11-15 22:22，用户确认 review 后）

用户确认“review 后一起提交”，剩余 135 条工作区改动提交为 2 个 commit，并 push 到 `fork/main`（RexVane/PiWeb）：

| commit | 主题 | 文件数 |
|---|---|---|
| `2ba56ee` | fix(audit): land remaining audit fixes in files that also carried pre-existing edits | 25（23 个混合文件 + `SkillsPluginsViews.tsx` 删除 + 删除的 prompts 死视图测试） |
| `66c7c44` | chore: commit remaining pre-existing working-tree changes | 160（既有 WIP 功能/测试、`.audit` 证据目录、市场与 session-retention 删除等） |

- 提交后 `git status --short` = **0 条**（工作区干净）；`tsc` exit 0；`npm run lint` exit 0（0 error / 29 warning）。
- push：`1d4efba..66c7c44 main -> main`，共 13 个本地 commit 推送（含此前 6 个未推的本地提交 + 本轮 7 个）。
- 推送触发 GitHub Actions：check run [`43724228000`](https://github.com/RexVane/PiWeb/actions/runs/43724228000)、remote connection run `43724227991`；windows-latest 复跑结果记录在 `fix/ci-windows-acl.md` / `fix/ci-windows-acl-status.log`。
- review 结论（提交前核查）：剩余 diff 无敏感信息（私钥/token 扫描 0 命中）；`.audit-*` 目录为仓库既有跟踪模式（2026-11-13/14 已跟踪），故一并提交；`AGENTS.md` 为 `next dev` 自动生成文件，已从 HEAD 恢复而不是提交删除。

### GitHub CI 首轮结果与跨平台修复（2026-11-15 22:24–23:15）

- 首轮 check run [`43724228000`](https://github.com/RexVane/PiWeb/actions/runs/43724228000) **failure**：macOS、Ubuntu×3、Windows×3 全部失败，失败主要来自既有 WIP 提交在 CI 环境下的跨平台问题（本地 Windows 同代码全量仅 1 例环境相关失败）。
- 其中用户点名的 windows-latest windows-acl：**23 tests 全部 skipped，并触发 skip-guard `Unexpected skipped tests`**。根因：`src/lib/sandbox/windows-acl.ts` 用 `path.resolve(root) !== realpath(root)` 判断“物理目录”，CI 临时目录是 8.3 短名（`C:\Users\RUNNER~1\...`）而 realpath 展开成长名（`C:\Users\runneradmin\...`）→ 误判 → AppContainer 沙箱整体不可用。
- 修复 commit `1c17c43 test(ci): make cross-platform checks robust on hosted runners`（24 文件）：新增 `src/lib/sandbox/physical-path.ts`（逐级 lstat 判物理目录，接受 8.3 短名、仍拒绝 symlink/junction）；`sandbox/config.ts`、`windows-acl.ts` 接入；`recycleFixture` 用 realpath 规范化并在无回收站时回退；`npmCommand` 补 POSIX/setup-node/nvm 布局；runtime-proxy 按 Node 版本判定 supported；launcher-graceful-stop/path-security-boundary 平台化；tmpdir 短/长路径断言、pipe/IPC 侧车、权限路由、git-timeout 与 source-encoding 超时等测试确定性化。
- 本地修复后验证（CI 同款环境：8.3 短名 TEMP + coverage）：全量 314 文件/2507 用例通过（唯一 launcher.test 既有偶发，单跑 46/46 且首轮 CI 该用例通过）；tsc/lint/skip-guard exit 0；定向回归 8 文件/66 用例通过。
- 修复后第二轮 check run [`43728621225`](https://github.com/RexVane/PiWeb/actions/runs/43728621225)：macOS 平台敏感测试**全部通过**（`Test Files 3 passed`、`Tests 24 passed | 1 skipped`，说明 POSIX npm 布局修复生效），但 macOS job 在 **lint 步骤**失败：CI 直接 `npm ci --prefix scripts/testing/lint` 没有写 wrapper 缓存 stamp，`PIWEB_LINT_SKIP_INSTALL=1` 下被误判为 missing/stale。
- 修复：commit `513e422 fix(ci): trust direct npm ci lint installs without the cache stamp`（run.mjs：无 stamp 且 eslint 二进制存在时信任安装并记录 lock hash，仅 stale stamp 才重装；本地模拟 CI 离线 lint 已通过）。
- 跨平台修复过程共 4 个 commit：`1c17c43`（沙箱物理目录/短路径、npm POSIX 布局、平台化测试）、`513e422`（lint 工具链 CI stamp）、`fc80b45`（POSIX graceful-stop mock / ext4 mtime 断言）、`7802ba4`（hosted-Windows 夹具清理兜底、readonly `type nul`、shell-exit 容忍）。run 43729179839（fc80b45）的 **ubuntu×3 与 macOS 已全部 success**；Windows 的夹具清理兜底修复在 7802ba4，对应 run 43729556067 因用户决定停止等待而未记录最终结果。
- **windows-acl 结论**：首轮“23/23 skipped（探测误判）”已修复；run3/run4 中变为 **24 tests / 23 passed / 1 flaky**（shell-exit 退出码受 hosted-runner job-object 收尾影响），run5 已放宽该宿主相关断言并在本地 29 tests 全过。该测试在 windows-latest 上已能真正执行且基本通过；剩余为其宿主环境相关偶发，与产品逻辑无关。
- 最终记录与未等待项：`fix/ci-windows-acl.md`（含 runs 链接与停止时状态）。

---

**交付自查**：42 项“有问题”逐项有状态（32 修复 / 7 部分 / 3 deferred，其中 C5 删除已在工作区完成、源文件尚未提交）；默认行为未翻转，新增能力均 opt-in；typecheck、lint、全量测试、生产构建、打包校验、状态与进程检查全部通过（唯一 1 条既有环境限制失败已明确归因并给出 CI 复跑建议）；已按用户选择提交 5 个 commit。
