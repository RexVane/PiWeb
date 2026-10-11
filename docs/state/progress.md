# 进度

## 2026-10-11 00:23 +08:00 | grok-4.7 | 在 7d6d8f3 上接入每轮 commit 与对话栏改动
- 改了什么：
  - 底版保持 `7d6d8f3`。把 `7e7a501` 的生长树接到这一版：每轮结束往工作区自己的 git 提交一个 commit，挂在 `refs/piweb/rounds/<key>`，不动 HEAD 和用户暂存区。发 prompt 前先把用户自己的修改记成「你的修改」。项目栏按轮显示，对话里提问下方可以打开这一轮。
  - 这一版原来的编辑重发还在。影子仓库、`ledger.jsonl` 和 `growth-rounds.ts` 不再使用，旧文件放在 `backups/`。
  - 接上 PR #18 在这一版对得上的功能：对话栏可拖宽并记在浏览器本地；Markdown 代码块可复制；普通模型列表按 pi 的 `enabledModels` 过滤，设置页（`custom=1` / `full=1`）仍是完整目录。
- 影响文件：`src/lib/growth-service.ts`、`src/lib/growth-tracker.ts`、`src/hooks/useGrowth.ts`、`src/components/ProjectPanel.tsx`、`src/components/ChatWindow.tsx`、`src/lib/models/model-scope.ts`、`src/app/api/models/route.ts`、`src/app/api/growth/route.ts`
- 下一步：在已登录的页面上拖一次对话栏、点一次代码块复制，并看一轮生长记录是否出现

- 2026-10-11 01:47 | #001 | 构建 | 构建修复固化进 next.config.ts，堵住发布包泄漏 | deepseek-flash
- 2026-10-11 02:07 | #002 | 对话 | 对话栏拖宽手柄改成常显中间短抓手（不透明度 0.3，悬停变亮） | deepseek-v4.1-flash
- 2026-10-11 12:52 | #003 | 远程 | 去掉 web 端导入会话功能，加 tailnet 白名单免密访问 | deepseek-flash
- 2026-10-11 13:11 | #004 | 对话 | 改动卡片折叠时只留标题行 | deepseek-flash
- 2026-10-11 13:12 | #005 | 远程 | 手机的添加工作区改用应用内目录浏览器 | deepseek-flash
