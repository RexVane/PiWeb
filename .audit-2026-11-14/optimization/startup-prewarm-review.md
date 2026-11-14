# 启动预热争用：只读核查

2026-11-14。本文件只记录源码和既有采样证据，未启动额外服务、未执行诊断负载、未修改业务源码。最终成品 BUILD_ID `T9X3r3wKuuYbNUYmPTqye`，sourceHash `41a70da175d1e7c92ff478fb834b001af204c79a7d713fe53572521285a81046`。是否存在相对旧版的回归，等待同环境旧新交错 A/B；不能用不同环境的旧样本直接归因。

## 已有证据与限制

- `startup-five-v2.json` 第 1 轮：健康响应 15.308 秒，认证健康 15.495 秒，被测列表首字节 6.029 秒、完整响应体 6.029 秒，总计启动后 21.524 秒。等待主要发生在响应首字节之前，约 71 KB 的响应传输不是这次额外数秒的主要部分。
- 同轮启动器 ready 日志在 17.073 秒出现，但这**仅证明预热尝试已经结束**。`runLauncherInner` 将 `warmFirstPaint` 的 true/false 都映射为已完成，且换 Cookie 失败时仍可能发出匿名预热请求；当前日志没有预热路由状态。因此不能仅凭 ready 声称首个 `/sessions` 成功，或断定索引已经在 17 秒完成。
- 该轮既有进程采样中，Next 子进程 PID 46508 在 `11:20:35.934Z` 到 `11:20:39.968Z` 的 CPU 从 14765.625 ms 增至 18718.750 ms：约 4.03 秒墙钟内使用 3.95 秒 CPU，接近单核持续占用。它支持检查同步计算/同步 I/O/GC，不能单凭此定位到某个函数；这不是整机 CPU 98%。

## 实际调用关系

1. `scripts/launcher.mjs` 的 `warmFirstPaint` 先身份检查、令牌交换，再等 `/api/sessions` 完整响应体，随后并发 version/workspaces/models/pi-settings。默认 `/api/models` **不带 cwd**，走全局模型目录；本次新增的工作区目录缓存不会免除这次首次全局运行时初始化。
2. `src/app/api/sessions/route.ts` 调用 `listSessions`，再等待 cwd 规范化、工作区注册表读取，最后用 `after(() => warmSessionResources(recentCwds))` 注册任务。并发 `listSessions` 共用 `scanning`，已有列表缓存为 1.2 秒；未见为两份并发列表重复解析全部 JSONL 的必然路径。
3. 安装版 Next 的 `server/after/after-context.js` 在所属请求结束后开始 callback queue。它不创建工作线程，也不保证为其他待完成请求保留 CPU；因此第一份响应结束后，其资源发现仍可能阻塞另一份正在等待 cwd/注册表 I/O 的列表。
4. 资源初始化经 `getResourceLoader` / `queueLoaderReload`。`resourceFingerprint` 包含同步 stat/read/readdir/realpath；SDK `DefaultResourceLoader.reload` 的技能、提示词、上下文读取也有同步段。全局 `withResourceLock` 只保证加载顺序，不能把这些同步工作移出 Node 事件循环。必须测分段才能区分资源扫描、SDK 解析、全局模型创建、GC 等具体来源。

## 最小可证伪诊断

`PIWEB_SKIP_WARMUP=1` 只关闭启动器主动预热，**不会关闭 `/sessions` 自身的 after 任务**。单独对比开关只能说明“主动预热及其触发时序”是否影响被测请求，不能单独区分 after 与后续模型热身。

如果 A/B 确认需继续定位，可复用冻结成品、相同 fresh fixture，记录不含凭据的请求开始/响应状态/首字节/结束时刻：

- 禁用启动器预热，认证后发一次列表并立即发第二次列表；不请求模型或资源面板。如果第二次仍被显著阻塞，after/首次列表后续工作可独立造成影响。
- 在另一全新实例重复同序列，但第二次列表同时增加一个 `/api/models` 请求。它与前项之差用于检验全局模型热身的增量影响；不要同时加入 workspaces/pi-settings，避免无法归因。
- 默认预热的诊断需额外记录根路径令牌交换、预热 sessions 及四个后续路由的 HTTP 状态和完成时间。禁止记录 URL 查询令牌、Cookie 或响应正文。结合事件循环延迟或一次 CPU profile，才可将等待归到具体同步函数。

这些是隔离诊断，不是正式性能回归样本；先取得统一准入，不能与其他计时重叠。

## 是否能取消列表触发的资源预热

可以取消该可选 head start 而保留正确性。`warmSessionResources` 仅做每工作区一次、最多两个目录的 `resourceLoaderReady`；没有承担文件变更检测或会话建立的唯一职责：

- `/api/agent/resources` 的 `loadWorkspaceResources` 自身等待 `refreshResourceLoaderIfStale`。
- 工作区模型目录自身等待 `resourceLoaderReady` 和 `refreshResourceLoaderIfStale`。
- 首次冷会话 `buildSnapshot` 自身等待资源发现、检查更新；真正创建会话也等待发现并创建独立会话 loader。

取消会让首次真正需要资源的请求承担原本提前完成的成本，可能增加首次快照/面板等待；不能在未测量前承诺它一定改善完整首屏。全局、不带 cwd 的 `/api/models` 本身不负责目标工作区资源发现。当前未删除该预热逻辑。
