# 进度

## 2026-09-28 10:40 +08:00 | k3 (DeepSeek Harness) | 开工登记：远端锁定 + 现状快照
- 远端锁定：
  - `origin = https://github.com/RexVane/PiWeb.git`（本人仓库，可 fetch/push）
  - 无 `upstream`（非 fork 场景），无需 `no_push` 锁定
- 现状快照：
  - HEAD = `4d0f96c chore(release): v0.3.4`，工作区干净
  - 本项目是 pi coding agent 的 Web UI（Next.js 16 + React 19 + Tailwind v4），通过 `@earendil-works/pi-coding-agent` SDK 驱动，零修改引擎
  - 生长树（Growth）现状：每工作区在 `~/.pi/agent/web-growth/<key>/` 建影子裸仓库 + `ledger.jsonl`，快照 = update-index → write-tree → commit-tree 到 `refs/piweb/growth`
- 下一步：生长树去影子仓库改造——快照直接存工作区自身 `.git`（非 git 目录自动 init），提交挂 `refs/piweb/growth/<key>` 专用引用，不碰 HEAD/暂存区/分支；账本挪到 `.git/piweb/ledger.jsonl`；放弃旧影子历史（旧目录保留不删）
- 影响文件：本次仅新增 `state/progress.md`、`.gitignore` 增加 `backups/`

## 方案备忘（本次改造已确认的决策）
- 提交位置：`refs/piweb/growth/<workspaceKey>` 专用引用；独立临时 index（`GIT_INDEX_FILE=<gitdir>/piweb/index`），绝不动用户 index
- 元信息：保留精简 JSONL 索引（`<gitdir>/piweb/ledger.jsonl`），commit message 保持人类可读摘要
- 旧数据：`~/.pi/agent/web-growth/` 放弃迁移，原样保留
- 工作区是某仓库子目录时：在工作区根单独 `git init`（嵌套仓库），保证快照范围恰好等于工作区
