# 修复轮整体验证报告（task-11 / fix-verify）

- 时间：2026-11-15 20:39–20:55（修复轮最终验证）
- 仓库：`D:\AIApp\PiWeb`，HEAD `4a6a59e2941eac2047f94a9eea8d5caac0226f9b`，branch `main`（验证前后均未变）
- 角色：只验证、不修改源码；未做任何 git 写操作；未 kill/restart/占用用户 30141 实例
- 证据目录：`audit_tmp/run-20261115-full/fix/verify/`（本文件 + `logs/` 原始日志 + `env/` 隔离环境）
- 修复前基线参照：审计全量 `e-run/e1-full-tests-coverage.log`（288 文件 / 2347 用例 / 50 failed，694.91s，exit 1）与 A1 修复轮基线 `tests-ci/baseline-full.log`（290 文件 / 2359 用例 / 11 failed，649.22s）。用户口径 2347/50 与审计日志一致。

## 0. 最终状态判定（Lead 20:39–20:42 收尾改动）

| 文件 | mtime | 说明 |
|---|---|---|
| `bin/pi.js` | 20:38:54 | supervise 改用 `terminateProcessTreeGracefully` |
| `tests/pi-supervise.test.ts` | 20:38:57 | 同步 mock/断言 |
| `scripts/process-runner.mjs` | 20:40:21 | 失败时挂 `error.output`（≤256KB） |
| `tsconfig.json` | 20:40:21 | exclude 增加 `scripts/testing/lint` |
| `scripts/build.mjs` | 20:40:26 | verbose 失败也打印 `error.output` |
| `.github/RELEASING.md` | 20:40:26 | 文档 |

- 全量测试启动于 20:40:25.575：**晚于**前 4 项，仅早 0.5s 于 `build.mjs`/`RELEASING.md`；而这两个文件不被任何测试 import（`build.mjs` 只被 `scripts/*` 自己引用，测试只 import `process-runner.mjs`）→ **全量测试结果视为含 Lead 最终改动**。
- typecheck/lint 首轮（20:39–20:40:20）早于 20:40:21 的 process-runner/tsconfig 改动，已于 **20:48 在最终状态复跑**，以复跑结果为准（见 §1/§2）。
- 全仓 mtime 扫描：`src|scripts|bin|tests|docs|.github` 下 **20:42:00 之后无任何源码/测试/文档改动** → 后续构建/打包/状态对比均为最终状态。

## 隔离环境（所有命令统一）

```
HOME, USERPROFILE            → audit_tmp/run-20261115-full/fix/verify/env/home
APPDATA                      → .../verify/env/appdata
LOCALAPPDATA                 → .../verify/env/localappdata
PI_CODING_AGENT_DIR          → .../verify/env/pi-coding-agent
TEMP, TMP, TMPDIR            → C:\Users\guica\AppData\Local\Temp\piweb-fix-verify   （仓库外！）
PI_OFFLINE=1, NEXT_TELEMETRY_DISABLED=1, PI_WEB_UPDATE_CHECK=0, PIWEB_LINT_SKIP_INSTALL=1
```

- TEMP 外置是 A4 定位的关键：TEMP 落在 git 检出内时 `file-lock`/`growth-service`/`session-model-runtime` 三条会假失败；外置后三条全绿（见 §3）。
- 运行时：node v24.12.0（`B:\Node.js\node.exe`）、npm 11.6.2。
- 本会话 shell 为 Windows PowerShell 5.1（执行策略 AllSigned/RemoteSigned），无法直接跑 `.ps1`；验证全部用内联命令完成，未改系统配置。

## 1. typecheck —— 通过

| 项 | 值 |
|---|---|
| 命令 | `node node_modules/typescript/bin/tsc --noEmit --incremental false` |
| exit | **0** |
| 耗时 | 1.8s（复跑 20:48:25，最终状态） |
| 输出 | 0 行（无错误） |
| 日志 | `logs/typecheck-final.log`（首轮 20:39 同样 exit 0） |

## 2. lint —— 通过

| 项 | 值 |
|---|---|
| 命令 | `npm run lint`（= `node scripts/testing/lint/run.mjs`，`PIWEB_LINT_SKIP_INSTALL=1`） |
| exit | **0**（复跑 20:48:30，最终状态） |
| 耗时 | 8.3s（工具链已安装，**未联网、未 npm ci**；stamp 命中） |
| 结果 | `✖ 29 problems (0 errors, 29 warnings)` |
| warning 构成 | 14 × `react-hooks/exhaustive-deps`、13 × `@next/next/no-img-element`、2 × `Unused eslint-disable`（`src/components/ChatInput.tsx:540,690`）——全部为既有代码 warning，不阻塞 |
| 日志 | `logs/lint-final.log`（首轮 `logs/lint.log`：同样 exit 0 / 29 warnings） |

## 3. 全量测试 —— 唯一失败为环境限制（非产品缺陷、非回归）

| 项 | 值 |
|---|---|
| 命令 | `node node_modules/vitest/vitest.mjs run --maxWorkers=4`（后台作业，隔离 env，TEMP 仓库外） |
| exit | **1**（仅有下述 1 条环境失败） |
| 启动/耗时 | 20:40:25 启动，**470.11s**（`VITEST_EXIT=1 ELAPSED_SEC=470.8`） |
| **Test Files** | **1 failed \| 315 passed \| 1 skipped (317)** |
| **Tests** | **1 failed \| 2506 passed \| 2 skipped (2509)** |
| 跳过 | `tests/remote-tunnel.integration.test.ts`（1，集成用例按既有配置 skip） |
| 日志 | `logs/vitest-full.log` |

### 3.1 与修复前基线对比

| 阶段 | 文件 | 用例 | failed | 耗时 |
|---|---|---|---|---|
| 修复前审计全量（`e-run/e1-full-tests-coverage.log`） | 288 | 2347 | **50（22 文件）** | 694.91s |
| A1 修复轮中间基线 20:29（`tests-ci/baseline-full.log`，移动工作树） | 290 | 2359 | 11（6 文件） | 649.22s |
| **本轮最终（本验证）** | **317** | **2509** | **1（1 文件）** | **470.11s** |

- 文件 +27：正是本轮新增的 27 个测试文件（`tests/**` 新增，见 §6）。
- 用例 +150（相对 A1 基线 2359→2509）：新增测试文件共 147 例（按日志逐文件统计），其余 +3 为既有测试文件扩展（如 `tests/check-skips.test.ts` 等）。
- **审计基线 50 条失败已全部消除**：其中 theme-mock 28 条（本轮 0 处复现）、A4 三条（`file-lock`/`growth-service`/`session-model-runtime`）现均 `✓` 通过，A2 的 `auth`/`pi-settings-refresh` 全绿，A1 新增测试与 Lead 的 `pi-supervise`/`launcher-graceful-stop` 通过。
- 注意：当前剩余的那 1 条 AppContainer 失败**不在审计 e1 的 50 条内**——该次全量中 `windows-acl.test.ts` 为 `23 tests | 23 skipped`（整文件按既有 skip 条件跳过）；但它在修复前的 HEAD 测试日志（`build/logs/05-head-tests.log`、`10-current-tests-coverage.log`）中就是 `23 tests | 1 failed`，见 §3.2 证据。

### 3.2 剩余失败逐条分类（1 条）

| # | 用例 | 分类 | 判定依据 |
|---|---|---|---|
| 1 | `tests/lib/sandbox/windows-acl.test.ts > Windows AppContainer isolation > supports a writable private temp without letting readonly use it` | **环境限制（本机 DSH 受限会话 AppContainer 半可用），非产品缺陷、非本轮回归** | ① 修复前 HEAD 测试日志即存在同一失败：`build/logs/05-head-tests.log`、`10-current-tests-coverage.log` 中该文件为 `23 tests \| 1 failed`；② A1 20:29 修复轮基线同一用例同一断言失败（`tests-ci/baseline-full.log:1411-1421`：`windows-acl.test.ts:200:90`，`expected 1 to be +0`）；③ 本验证 20:49 用 `-t` 单用例隔离复跑仍失败（`logs/windows-acl-isolated.log`：`Tests 1 failed \| 22 skipped (23)`，文件 23 例中仅此 1 例）；④ 同文件其余 22 用例在本次全量中通过（`❯ tests/lib/sandbox/windows-acl.test.ts (23 tests \| 1 failed) 24275ms`）；⑤ A1 已归因本机受限会话 `CreateAppContainerProfile` 半可用/能力不完整，CI windows-latest 完整令牌可运行；⑥ 本会话 netstat 无法枚举 LISTENING 套接字（改用 `Get-NetTCPConnection` 才能看到用户监听端口），与该受限 AppContainer 环境一致；⑦ `src/lib/sandbox/windows-acl.ts` 不在本轮任一修复 agent 改动范围（沿用修复前基线状态）。另：审计 e1 全量中该文件因既有 skip 条件为 `23 skipped`，故未计入审计 50 failed 列表，但失败在本机是既有的。 |

**结论：全量测试无真实产品缺陷失败、无修复引入回归；仅 1 条既有的本机环境限制失败，CI/正常令牌环境应可通过（本机受限会话无法验证，见 §8 待办）。**

## 4. 生产构建 —— 通过

| 项 | 值 |
|---|---|
| 命令 | `npm run build`（= `node scripts/build.mjs`，隔离 env，后台作业） |
| exit | **0** |
| 耗时 | **161.2s**（`.next/cache` 为早前构建预热；A1 早前冷缓存实测 370s，均为正常范围） |
| BUILD_ID | **`Tm3weU65dr-0yLbUxu5wh`**（`.next/BUILD_ID` 一致） |
| 产物 | `[piweb] Build sealed: 337 runtime files (Tm3weU65dr-0yLbUxu5wh).` |
| 产物存在 | `.next/BUILD_ID`(21B)、`required-server-files.json`(7883B)、`routes-manifest.json`(8331B)、`server/`、`static/`、`piweb-build-inventory.json`(47554B，buildId/files 一致) 均存在 |
| 构建输出 | 成功路径默认输出不变（仅 npm 脚本 2 行 + 1 行 sealed，共 5 行），未见 warning/error |
| 日志 | `logs/build-final.log` |

注：Next 构建自身仍在 `.next/` 生成 `trace`(332438B)/`trace-build`(1194B)/`diagnostics/`，属既有行为，已由打包规则排除（§5）。构建只写 `.next`（`git check-ignore` 确认 `.gitignore:4:.next/`），未改变任何被跟踪文件。

## 5. 打包校验 —— 通过

| 项 | 值 |
|---|---|
| 命令 | `npm pack --dry-run --json --ignore-scripts` |
| exit | **0**，3s |
| 包 | `@rexvane/piweb@0.3.30` → `rexvane-piweb-0.3.30.tgz` |
| 文件数 | **1080** |
| 包大小 | **4,059,218 B（4.06 MB）**；unpacked 18,453,773 B（18.45 MB） |
| 日志 | `logs/npm-pack-dry-run-final.json` |

排除/包含校验（对 JSON 文件清单逐条匹配）：

| 检查 | 结果 |
|---|---|
| `.next/trace*`（含 `trace`/`trace-build`） | **0 命中** ✅（本机 `.next/trace` 332KB 确实存在，证明排除生效） |
| `.next/diagnostics` | **0 命中** ✅ |
| `scripts/testing/lint`（含 `node_modules`） | **0 命中** ✅ |
| `.next/cache` | **0 命中** ✅ |
| `audit_tmp/**` | **0 命中** ✅ |
| `THIRD-PARTY-NOTICES.md` | **包含** ✅ |
| `LICENSE` / `README.md` / `package.json` | **包含** ✅ |
| 顶层分布 | public 424、`.next` 338、src 258、scripts 39、assets 12、bin 2、其余配置/文档 7（均为运行所需，未含 lint 工具链/审计目录） |

## 6. 状态对比 —— HEAD 未变、无意外删除、无 20:42 后改动

| 项 | 值 |
|---|---|
| `git rev-parse HEAD` | `4a6a59e2941eac2047f94a9eea8d5caac0226f9b`（与基线一致 ✅） |
| branch | `main` |
| `git status --short` | **208 条**（基线 136 条；新增 72 = 36 个 `M` + 36 个 `??`；删除 0） |
| `D ` 条目 | 基线 7 条 → 现在 7 条且**同一集合**（`AGENTS.md`、`api/plugins/marketplace`、`settings/PluginMarketplace.tsx`、`lib/plugins-marketplace.ts`、`lib/session-retention.ts`、`plugin-marketplace-lifecycle.test.tsx`、`plugins-marketplace.test.ts`）→ **无新增删除** ✅ |
| 构建后再对比 | 与测试运行中快照**完全一致**（208 条，NO CHANGE）→ 构建/测试未污染工作树 ✅ |
| `package-lock.json` | **无变更**（未新增依赖；lint 工具链自带 lockfile 且已安装，`PIWEB_LINT_SKIP_INSTALL=1` 未联网） |
| `.next` | 已被 `.gitignore:4` 忽略；`scripts/testing/lint/node_modules` 被 `.gitignore:1:node_modules/` 忽略 |

### 6.1 本轮新增文件（相对 fix-baseline.txt；完整清单见 `logs/status-added.txt`）

- 新增测试 **27** 个文件（共 147 用例）：`tests/agent-config-cache`、`tests/agent-manager-budget`、`tests/events-backpressure`、`tests/files-service-editor-env`、`tests/git-service-env`、`tests/i18n`、`tests/launcher-graceful-stop`、`tests/models-service-configured-credential-signal`、`tests/package-files-policy`、`tests/remote-mobile-proxy-limits`、`tests/session-reader-pagination`、`tests/settings-write-lock`、`tests/lib/{api-error,atomic-file-durability,child-process-env,path-security-boundary,secret-redaction}`、`tests/api/{config-route,fs-validation,git-route-guard,github-version-routes,health-readiness,pi-settings-concurrency,session-delete-attachments,session-export-redaction,sessions-pagination,workspaces-validation}`
- 新源码/工具/文档：`src/lib/child-process-env.ts`、`src/lib/graceful-shutdown.ts`、`src/lib/path-boundary.ts`、`src/lib/secret-redaction.ts`、`src/app/api/health/readiness/`、`eslint.config.mjs`、`scripts/testing/lint/`、`docs/operations/`（6 文件）、`THIRD-PARTY-NOTICES.md`
- 修改（36 个新增 M，未含基线已有 M）：Lead 的 `bin/pi.js`、`scripts/process-runner.mjs`、`scripts/build.mjs`、`tsconfig.json`、`.github/RELEASING.md` 与 A1–A5 的源码/测试/CI 修复文件（`git status` 与各 agent 报告一致，未发现越界文件）

> 说明：基线 136 条中包含前几轮审计修复遗留的 113 个 M/D 与 23 个 `??`；本轮新增的 72 条全部可对应到 A1–A5 修复报告和 Lead 的 5 处收尾改动，无来源不明的改动、无来源不明的删除。

## 7. 进程 / 端口 —— 无残留，用户实例未受影响

- **无本验证残留进程**：vitest/build 后台作业均已退出；无 `vitest`/`scripts/build.mjs`/`process-runner` 相关 node 进程（唯一字符串命中是本验证自身 shell 命令行）。
- **无测试监听端口**：3000–3100 段无监听；构建/测试子进程未遗留监听。
- **用户 30141 实例正常，未重启、未被占用**：
  - PID 29712 `bin/piweb.js --no-open`（start 20:13:19，早于本验证会话）→ PID 10256 `next start -p 30141 -H 127.0.0.1`（20:13:21）：监听 `127.0.0.1:30141` 与 `0.0.0.0:30142`（`Get-NetTCPConnection -OwningProcess 10256`）→ PID 31404 `scripts/remote-engine.mjs ... cloudflared tunnel --url http://127.0.0.1:30142`，cloudflared PID 36968（20:13:26）。
  - `GET http://127.0.0.1:30141/api/health` → **HTTP 200** `{"success":true,"data":{"ok":true,"service":"piweb"}}`。
  - 全程未对该 PID 树执行 kill/restart，未监听 30141/30142、未向其发送写操作。
- 备注：本会话 `netstat` 不输出 LISTENING 行（受限会话的套接字枚举限制），监听事实以 `Get-NetTCPConnection -OwningProcess` 为证；这也是 §3.2 环境失败的同源佐证。

## 8. 整体结论

### 结论：**通过（无阻塞问题）**

| 验证项 | 结果 |
|---|---|
| 1) typecheck | ✅ exit 0（1.8s，0 输出） |
| 2) lint | ✅ exit 0（0 error / 29 warning，均既有） |
| 3) 全量测试 | ✅ 1 failed / 2506 passed / 2 skipped（317 文件）；唯一失败为**既有的本机 AppContainer 环境限制**，非产品缺陷、非回归。修复前审计基线 50 条失败已全部消除；该环境条在审计 e1 全量中为整文件 skip（未计入 50），但在修复前 HEAD 测试日志中已同样失败（见 §3.2） |
| 4) 生产构建 | ✅ exit 0，161.2s，BUILD_ID `Tm3weU65dr-0yLbUxu5wh`，337 runtime files，产物齐全 |
| 5) 打包校验 | ✅ exit 0，1080 文件 / 4.06MB；无 trace/diagnostics/lint 工具链/cache/audit；含 THIRD-PARTY-NOTICES.md + LICENSE |
| 6) 状态对比 | ✅ HEAD 未变、无意外删除、无 20:42 后改动、工作树与各 agent 报告一致 |
| 7) 进程/端口 | ✅ 无残留进程/监听；用户 30141 实例在线（HTTP 200），未受影响 |

### 需要 Lead / 用户处理或拍板的清单

1. **环境失败 1 条（不阻塞交付）**：`tests/lib/sandbox/windows-acl.test.ts > supports a writable private temp ...` 本机受限会话 AppContainer 半可用导致。建议在有完整令牌的 Windows CI（windows-latest）或用户普通终端复跑该文件确认全绿；本机无法验证。
2. **deferred 产品决定（A3 报告，需用户拍板，均未改默认行为）**：① I-07 归档会话自动清理模块未恢复（`src/lib/session-retention.ts` 工作区已删、HEAD 有 30 天保留调度器）；② I-05 SDK 安装遥测默认开启；③ I-08 LAN 默认监听 `0.0.0.0`（仅新增 `PIWEB_REMOTE_LAN_BIND` 覆盖）；④ I-11 隧道引擎 PATH 回退；⑤ I-16 测试夹具私钥保留（`.gitignore` 已补私钥规则）。
3. **UI 文案不一致（A3 发现，归 A5/用户）**：删除会话确认框仍写“直接永久删除，无法恢复”（`src/i18n.tsx:255,1283`），而附件清理已改为可恢复语义（备份 + INDEX）；会话 JSONL 本身仍是直接删除。是否改文案需拍板。
4. **deferred 技术项（A1 结论）**：B-07 vitest worker 启动超时是 vitest 5.0.5 硬编码常量、不可配置（按“不改默认”未动 `vitest.config.ts`）；macOS 全量 build 门禁未加（已加最小 macos job）。
5. **可选清理（不阻塞）**：`src/components/ChatInput.tsx:540,690` 两个 unused eslint-disable 若清零需改 `src/**`（当前仅 warning）。
6. **提交/发布提示**：工作树 208 条变更（36 个新增文件）均为本轮修复产物，建议按 A1–A5 报告逐组 review 后提交；构建为 `.next/cache` 预热（161s），发布前如需冷构建基线，可清 `.next/cache` 重跑一次（A1 冷缓存实测 370s）。

---
原始证据：`logs/typecheck-final.log`、`logs/lint-final.log`、`logs/lint.log`、`logs/vitest-full.log`、`logs/windows-acl-isolated.log`、`logs/build-final.log`、`logs/npm-pack-dry-run-final.json`、`logs/status-added.txt`、`logs/status-removed.txt`（空）、`logs/status-now.txt`、`logs/status-final.txt`。
