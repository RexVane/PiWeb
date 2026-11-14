# 覆盖率实测（lead，2026-11-13 19:44–19:53）

补的是审计报告附录 C 第 1 条「没有覆盖率数据」。做法：`npm i --no-save @vitest/coverage-v8@5.0.5`（**未改** `package.json`/`package-lock.json`），全量跑：

```
npx vitest run --coverage --coverage.provider=v8 \
  --coverage.reporter=json-summary --coverage.reporter=text-summary \
  --coverage.reportsDirectory=.audit-2026-11-13/coverage --coverage.include=src/**
```

结果：**204 文件通过 / 3 跳过，1648 测试通过 / 19 跳过，0 失败，518.67s**（带插桩比不带慢 206s）。原始数据：`.audit-2026-11-13/coverage/coverage-summary.json`、日志 `coverage-run.log`。

## 1. 全局

| 指标 | 覆盖 | 命中/总 |
|---|---|---|
| Statements | **79.28%** | 17,844 / 22,506 |
| Branches | **70.45%** | 14,021 / 19,902 |
| Functions | **77.82%** | 3,464 / 4,451 |
| Lines | **83.56%** | 15,377 / 18,401 |

对照组：`tests-coverage` 区域报告用"import 图 + 剪 vi.mock"算出的**模块级**执行率是 191/210 = 91%。两者不矛盾——模块被执行 ≠ 里面每个分支都跑到。

## 2. 关键模块（行 / 分支）

| 文件 | 行 | 分支 | 语句数 |
|---|---|---|---|
| `src/lib/agent-manager.ts` | 86.39% | **71.25%** | 1441 |
| `src/lib/models-service.ts` | 81.61% | 69.80% | 718 |
| `src/lib/sandbox/windows-acl.ts` | 86.63% | **61.16%** | 202 |
| `src/lib/remote/supervisor.ts` | 94.22% | 80.00% | 277 |
| `src/lib/growth-service.ts` | 88.17% | 76.17% | 423 |
| `src/lib/session-reader.ts` | 94.00% | 82.30% | 150 |
| `src/lib/plugins-service.ts` | 91.26% | 71.11% | 206 |
| `src/lib/files-service.ts` | 87.82% | 68.81% | 312 |
| `src/components/ChatWindow.tsx` | 83.76% | 71.14% | 850 |
| `src/components/ChatInput.tsx` | 85.32% | 78.93% | 443 |
| `src/hooks/usePiWeb.ts` | **69.48%** | **53.11%** | 675 |
| `src/components/AppShell.tsx` | **70.32%** | **56.87%** | 593 |
| `src/components/SessionSidebar.tsx` | **70.00%** | **58.25%** | 310 |
| `src/components/settings/ModelsSection.tsx` | **68.83%** | **57.16%** | 430 |
| `src/lib/workspace-store.ts` | 77.94% | 60.00% | 263 |

## 3. 两个结论（对审计报告要改的地方）

1. **"三个巨型模块覆盖未知"这个担忧可以撤掉一半**：`agent-manager` 86%、`ChatWindow` 84%、`models-service` 82% 的行覆盖是健康的。**真正的洞在分支覆盖**：`agent-manager` 71%、`ChatWindow` 71%、`usePiWeb` 53%、`AppShell` 57%、`SessionSidebar` 58%、`ModelsSection` 57%。
2. **我们检出的 P1 家族正好长在低分支区**：P1-1（abort 无兜底/复位帧顺序）、P1-2（`isStreaming` 单源、轮询无 try/catch）、P1-3（扩展命令占住 `promptSubmitting`）、P1-17/P1-18（模型目录静默残缺）全部落在 `usePiWeb.ts` / `AppShell.tsx` / `agent-manager.ts` 的**错误分支与超时分支**里——这些分支恰好一行没测。所以"测试全绿"和"停止按钮会挂死"可以同时成立，机理清楚。

## 4. 最差分支覆盖（≥100 分支的文件）

| 文件 | 分支覆盖 | 行覆盖 |
|---|---|---|
| `src/lib/git-service.ts` | **42.85%** | 76.51% |
| `src/app/api/models/route.ts` | 49.12% | 48.71% |
| `src/hooks/usePiWeb.ts` | 53.11% | 69.48% |
| `src/components/settings/GeneralSection.tsx` | 54.28% | 48.88% |
| `src/lib/automations/runner.ts` | 56.02% | 88.83% |
| `src/components/AppShell.tsx` | 56.87% | 70.32% |
| `src/components/TrajectoryView.tsx` | 56.96% | 78.88% |
| `src/components/settings/ModelsSection.tsx` | 57.16% | 68.83% |
| `src/components/SessionSidebar.tsx` | 58.25% | 70.00% |
| `src/lib/workspace-store.ts` | 60.00% | 77.94% |
| `src/lib/sandbox/windows-acl.ts` | 61.16% | 86.63% |
| `src/lib/session-import/oc-family.ts` | 62.42% | 93.75% |
| `src/components/FileViewer.tsx` | 63.76% | 67.42% |

## 5. 零覆盖文件：19 个（与静态对账 19/19 吻合）

14 个 API 路由：`growth`、`skills`、`prompts`、`plugins/marketplace`、`sessions/[id]`、`git`、`agent/[id]`、`sandbox`、`pi-settings`、`github`、`agent/new`、`config`、`models/defaults`、`version`；外加 `src/lib/session-import/paths.ts`、`src/instrumentation.ts`、`src/app/layout.tsx`、`src/app/page.tsx`、`src/components/PiMark.tsx`（按 v8 统计口径）。

**两种方法（静态 import 图 / v8 行命中）独立得出同一个 19**，这是本次审计里对"覆盖缺口清单"最硬的一次交叉验证。

## 6. 覆盖率最低的几个动作（建议补测顺序）

1. `FullDiff.tsx` **5.4% 行覆盖 / 0% 分支**（111 行，几乎整文件没跑）——它是"全文 diff"视图，出错用户只会看到空白。
2. `GeneralSection.tsx` 48.88% 行 / 54.28% 分支——**P1-21（登出吞 500）就在这个文件里**，正好没测到失败分支。
3. `git-service.ts` 分支 42.85%——P1-13（merge/冲突 diff 恒空）、P2-1（`-uall` 缺失）、P2-2（仓库探测折叠错误）全在没覆盖的分支上。
4. `sessions/[id]/route.ts` 零覆盖——这是**用户最高频的删除会话**入口（`DELETE`），且有 `dispose→delete→forget` 顺序问题。

## 7. 复现方式

```powershell
npm i --no-save @vitest/coverage-v8@5.0.5
npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text --coverage.include=src/**
```
（`--no-save` 保证不改 `package.json`/`package-lock.json`；不装就能跑，只是没有覆盖率。）
