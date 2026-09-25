# 前端接线契约（2026-09-25）

所有接口沿用 `{ success, data?, error? }` 响应包装。写请求受现有同源校验和可选的 `PI_WEB_PASSWORD` 认证保护。`cwd` 是当前已选工作区的绝对路径；不要把组件里的演示路径或固定字符串传给接口。

## 智能体群

启动：`POST /api/swarm`

```json
{
  "cwd": "D:\\project",
  "tasks": [
    { "title": "拆分状态机", "instruction": "只修改状态机模块，保持现有接口。" },
    { "title": "补边界用例", "instruction": "只修改相关测试文件。" }
  ]
}
```

返回 `202`，`data` 为 `SwarmJob`：

```ts
type SwarmJob = {
  id: string;
  cwd: string;
  root: string;
  base: string; // 启动时的 Git HEAD
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: number;
  finishedAt?: number;
  tasks: Array<{
    title: string;
    instruction: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    report?: string;
    patch?: string; // 空字符串表示没有文件改动
    error?: string;
    accepted?: boolean;
  }>;
};
```

- `GET /api/swarm?cwd=<encoded path>`：最近 20 个任务组，按创建时间倒序。
- `GET /api/security?cwd=<encoded path>`：读取当前工作区的项目资源信任状态；`PUT /api/security` + `{ "projectTrust": { "cwd": "...", "decision": true } }` 可由用户主动信任。
- `GET /api/swarm/<id>`：轮询单个任务组。运行时建议约每 2 秒轮询，结束后停止。
- `POST /api/swarm/<id>` + `{ "cwd": "...", "action": "cancel" }`：取消尚在运行的任务组。
- `POST /api/swarm/<id>` + `{ "cwd": "...", "action": "accept", "index": 0 }`：整组任务结束、人工审查后采纳第 0 个已完成子任务的补丁。即使同组其他子任务失败，已完成的补丁仍可审查采纳。仅应用工作区文件，不暂存或创建 Git 提交。失败返回 `400/500` 和 `error`，必须展示错误，不能标记为已采纳。

启动前提：工作区是**干净的 Git 仓库**、Git 根目录的项目资源已信任、Pi 已配置可用模型。从子目录打开时也检查并可设置信任到 Git 根目录。后端最多接收 3 个任务，每个子任务在独立 Git 工作树执行，最长 10 分钟。子智能体只能通过限定在工作树内的文件读写工具工作，不能运行 shell、扩展或自动测试。任务结束后保存报告与补丁；任一子任务失败则整组状态为 `failed`，但保留已完成子任务的补丁；进程重启期间未完成的任务显示为 `interrupted`。采纳前校验 HEAD 和补丁冲突；若主工作区后来发生冲突，需人工处理，不自动合并。

## 测试检查器

- `GET /api/tests?cwd=<encoded path>`：返回 `{ files: string[], runner: "vitest" }`。
- `GET /api/tests?cwd=<encoded path>&file=<encoded relative path>`：返回 `{ file, content }`。
- `POST /api/tests` + `{ "cwd": "...", "file": "tests/semver.test.ts" }`：等待所选文件运行完毕，返回 `TestRunResult`。

```ts
type TestRunResult = {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  success: boolean;
  tests: Array<{ name: string; status: string; durationMs: number }>;
  output: string;
};
```

只发现工作区 `tests/` 里的 `*.test.*` / `*.spec.*` 文件；运行要求项目资源已信任并且工作区本地安装了 Vitest。后端固定运行 `vitest run <file>`，180 秒超时，同一工作区同时只能跑一个测试文件。没有返回内存用量或覆盖率时，界面不要显示固定值。现有 `/api/git?cwd=<encoded path>` 已提供真实分支、工作区改动与差异；`/api/sessions` 已提供真实归档列表。

## 页面接线现状与限制

- “差异对比”复用 `GitPanel` 的真实变更文件列表、暂存/工作区 diff 和提交历史；测试检查器有独立入口，显示工作区测试文件、源码与实际 Vitest 单文件结果。没有覆盖率和内存数据时不显示这些指标。后端不会直接提交 Git。
- 智能体群页支持 1~3 个用户明确填写的子任务、状态轮询、报告/补丁审查、取消与人工采纳。任务不会自动运行测试；采纳只修改主工作区，不暂存或提交。
- 顶栏与侧栏 Git 状态从 `/api/git` 读取。`mutatingDone` 仍只用于触发刷新，不再作为改动数量。设置页不再声称自动 failover 或固定缓存率。
- 当前实现没有 AST 专用隔离修改、自动契约测试或模型故障转移。需要这些能力时应另行设计接口和验收，不应将示例提示词当成已实现功能。
