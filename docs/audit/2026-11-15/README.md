# PiWeb 审计与修复 · 交付索引（2026-11-15）

> 状态：审计完成（16 节 / 87 条）；42 项问题已修复 32、部分修复 7、明确 deferred 3；修复已提交并 push 到 `fork/main`（HEAD `7802ba4`，工作区干净）。
> 剩余：部分产物仅能靠 CI 验证；用户已决定停止继续修 CI，run5 结果未等待。

## 1. 报告

| 文件 | 内容 |
|---|---|
| [`report_final.md`](report_final.md) | 全栈审计总报告：87 条判定、问题汇总表、无法验证项、附录索引 |
| [`report_fix.md`](report_fix.md) | 修复轮报告：42 项逐项状态、行为变化、opt-in 开关、提交记录、CI 跨平台修复过程 |
| `report_A.md` … `report_P.md` | 16 份分节报告（审计证据原文） |

## 2. 提交记录

- `audit_tmp/run-20261115-full/fix/commit-log.md` —— 全部 commit 与文件清单
- 关键 commit：
  - `5e7c254` fix(security) / `3d64847` fix(stability) / `91c6b36` test(ci) / `ceb4de2` docs / `687e44c` test(views)
  - `2ba56ee` fix(audit)（混合文件补充修复）/ `66c7c44` chore（其余既有工作区）
  - `1c17c43` + `513e422` + `fc80b45` + `7802ba4`（CI 跨平台修复）
- 已 push：`fork/main`（RexVane/PiWeb）；工作区 `git status` = 0。

## 3. 证据目录（`run-20261115-full/`）

| 目录 | 内容 |
|---|---|
| `final/` | 命令清单（186 条）、文件阅读清单、audit_tmp 清单、状态检查、外部并行改动记录 |
| `fix/tests-ci/`、`fix/auth-exports/`、`fix/retention-tunnel/`、`fix/sre-core/`、`fix/docs-ui/` | A1–A5 修复证据 |
| `fix/cleanup-c5/` | C5 死代码清理证据（含删除备份） |
| `fix/verify/` | 修复轮整体验证（typecheck/lint/全量测试/构建/打包/状态） |
| `fix/ci-logs*/`、`fix/ci-windows-acl.md`、`fix/ci-windows-acl-status*.log` | GitHub Actions 跨平台问题与修复记录 |
| `security/`、`architecture/`、`build/`、`b-run/`、`e-run/`、`i-run/`、`j-run/` | 审计分节原始证据 |

## 4. 当前 CI 状态（停止时）

- **已确认绿**：macOS、ubuntu-latest × Node 22.19/22.22/24（run `43729179839`）。
- **Windows**：windows-acl 已从“全部 skipped”修为“24 tests / 23 passed / 1 flaky”；剩余为 hosted-runner 测试夹具/沙箱环境相关，修复在 `7802ba4`（run `43729556067`，未等待结果）。
- 记录：`fix/ci-windows-acl.md`。

> 归档说明（2026-11-15 收尾）：原始证据目录 `audit_tmp/run-20261115-full/` 与 `.audit-2026-*` 已按用户要求清理；总报告、修复报告、验证记录、CI 记录与提交记录保留在本目录。原始命令输出未随仓库保留，需要时可按报告中的命令复跑。
