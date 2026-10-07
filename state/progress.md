# 进度

## 2026-09-28 10:55 +08:00 | k3 (DeepSeek Harness) | 生长树去影子仓库：快照直入工作区 .git
- 改了什么：
  - 重写 `growth-service.ts` 存储层：删除 `~/.pi/agent/web-growth/<key>/` 影子裸仓库与 `growthRoot()`/`meta.json`，快照对象直接写入工作区自己的 `.git/objects`
  - 非 git 工作区在首次快照前自动 `git init`；工作区若只是别的仓库的子目录（`rev-parse --show-toplevel` 不等于 cwd），在工作区根嵌套 init，保证快照范围恰好等于工作区；裸仓库拒绝并停用
  - 每步 `commit-tree` 挂到专用引用 `refs/piweb/growth/<workspaceKey>`（带 key 后缀，多 worktree 互不覆盖），不碰 HEAD / 用户 index / 任何分支；不再在用户仓库里跑 `gc`
  - PiWeb 私有文件全部收进 `<gitdir>/piweb/`：独立暂存区 `index`（`GIT_INDEX_FILE` 传入）、排除文件 `exclude`（`--exclude-from` 叠加，不改写用户 `info/exclude`）、账本 `ledger.jsonl`
  - 快照命令新增 LFS 过滤禁用，保证快照存原始字节而非指针文本：
  ```ts
  // src/lib/growth-service.ts:200
  "-c", "filter.lfs.clean=",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.required=false",
  ```
  - 读取侧 `readSteps` 快速路径改为纯 fs 解析 `.git`（目录或 worktree gitfile），无账本直接返回空，不为读取创建仓库
  - 导出签名全部不变，`growth-tracker` / API 路由 / 前端零改动
  - 测试：`growth-service.test.ts` 账本路径断言改指 `.git/piweb/ledger.jsonl`；「用户仓库零改动」用例的 `.git` 目录断言改为只允许新增 `objects/`、`refs/piweb/`、`piweb/`；新增「非 git 工作区自动 init 且 HEAD 保持未诞生」「别的仓库子目录嵌套 init 且父仓库零改动」两个用例
  - 清理 agent-manager / growth-tracker / growth-tree / types / route 里 5 处「影子仓库」过时注释；README 中英双语的环境要求补充新存储说明
- 验证：`tsc --noEmit` 通过；全量 vitest 54 文件 369 通过 + 1 跳过（Windows 符号链接权限用例）
- 影响文件：`src/lib/growth-service.ts`（重写）、`src/lib/growth-tracker.ts`、`src/lib/growth-tree.ts`、`src/lib/agent-manager.ts`、`src/lib/types.ts`、`src/app/api/growth/route.ts`、`tests/growth-service.test.ts`、`tests/growth-tracker.test.ts`、`README.md`、`README_zh.md`
- 旧数据：`~/.pi/agent/web-growth/`（本机 7 个工作区 / 43.6 MB）已是孤儿目录，新版本不读不写；按 backups 原则不代为删除，由用户手动清理
- 下一步：用户手动确认后可删除旧目录；观察真实会话中生长树表现

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
