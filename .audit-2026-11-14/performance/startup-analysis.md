# 启动耗时只读分析与分段补测计划

日期：2026-11-14。状态：源码复核与父启动最小分段测量完成，见 [startup-parent-breakdown.md](startup-parent-breakdown.md)。未改产品源码、未实施优化；子进程模块加载等其余候选尚未做分段计时。本轮补测没有启动服务。

绑定成品：`D:\AIApp\.piweb-performance-20261114-XavtFX`，BUILD_ID `qs_AuODvEiFduBinEf95d`，source SHA256 `0a8188e986da0c45600a2153ae2d4d5da4b185e18f7f23b60feb75eb83337961`。完整来源见 [source-snapshot.json](source-snapshot.json) 与 [stage-validation.json](stage-validation.json)。

## 先修正测量口径

1. [startup.json](startup.json) 的 `listenerMs` 是进程启动后，首次 `/api/health` 返回 200/401 的时刻，**不是 TCP 监听事件**。已回收临时探针 `server-perf-probe.mjs` 的 `runProduction` 约 253–260 行采用此口径；保留的方法与结果见 [后端测量记录](server-results.md)。三轮为 10.319–10.684 秒；认证后的健康响应为 10.414–10.766 秒。
2. Next 本地实现 `node_modules/next/dist/server/lib/start-server.js` 约 295–302 行在 `listening` 回调内、加载配置和请求处理器之前打印 `Ready in ...`；它的时间起点由 Next CLI 设置，不包含 PiWeb 父启动器与此前 Node preload。因此日志约 500 毫秒不能作为 PiWeb 可用时间。安装版 `instrumentation.md` 也明确：注册钩子完成后才能处理请求。
3. 前三轮不是空白数据：探针为每轮新建目录后复制同一份 fixture，包含 300 会话、合计 25,267,221 字节的会话文件，其中一个有 10,000 条消息；还含 100 项技能、10,000 个工作区文件。首次 sessions 请求验证 `total === 300`。第四轮和当前 `serveBrowser` 也复制 fixture；“fresh/new agent directory”只表示新目录，不能解释为空会话。见 [server-run.json](server-run.json) 的 `fixtureSizes`。
4. 首次 sessions 请求 2.147–2.247 秒包含首次索引、模块初始化，以及默认预热可能造成的竞争；此证据不能单独归因于 SDK 导入。它返回时距 spawn 12.661–12.946 秒。随后的首页响应 58–77 毫秒已被前述请求暖机，不是独立冷首屏。
5. 第四轮 [browser-startup.json](browser-startup.json) 禁用了现有 `PIWEB_SKIP_WARMUP`，首次 HTTP 健康响应仍需 9.732 秒；说明预热不是全部延迟的来源，但该轮仍有正常启动器 readiness 请求。
6. [server-resources.jsonl](server-resources.jsonl) 的 2 秒采样显示 startup-1 在 08:17:46 已同时存在父、子进程，父 CPU 累计约 5.172 秒后基本稳定，子进程继续增长。不能把前 8–9 秒全部计入父启动器，更不能把累计 CPU 直接视为精确墙钟分段。

## 已确认的执行路径

### 父启动器：重复完整构建验证

正常已有成品的启动路径是：

```text
runLauncher
  acquireFileLock
  runLauncherInner
    ensureInstallBuild
      hasProductionBuild
        selectProductionBuild -> readProductionBuild
    createLaunchPlan
      selectProductionBuild -> readProductionBuild
    probePort -> lock metadata update -> proxy selection -> spawn Next
```

对应 [launcher.mjs](../../scripts/launcher.mjs) 约 458、471 行，以及 [install-build.mjs](../../scripts/install-build.mjs) 的 `hasProductionBuild` / `ensureInstallBuild`。

两次 `readProductionBuild` 都验证完整清单。当前成品清单 333 文件，每轮均检查路径、文件大小并读取全部文件计算 SHA256。`assertLocalPath` 对每条路径重新 realpath 根目录、逐组件 lstat + realpath；公共目录祖先被反复检查。见 [build-output.mjs](../../scripts/build-output.mjs) 的 `assertLocalPath`、`verifyInventory`、`readProductionBuild`。

三轮最小父启动实测确认：两次校验分别为 2.026–2.206 秒、2.396–2.547 秒，合计占所选父启动阶段的 97.36%–97.64%。归因轮共记录 5,275 次 realpath 与 4,455 次 lstat，两类方法占校验时间约 90.77%。候选改进是同次启动复用已验证的选择结果、减少重复共同祖先检查，前提是保留路径边界、完整性检查和发布切换语义。不能用关闭哈希或信任未验证 manifest 来获取更低数字。

### 父/子交接：原生锁、进程身份和代理

- [file-lock.mjs](../../scripts/file-lock.mjs) 首次加载 koffi，并写入带 fsync 的短事务元数据；父进程登记子 PID，子 [lock-child.mjs](../../scripts/lock-child.mjs) 在入口前再次确认登记。5 秒是冲突上限，不代表每次必等 5 秒。
- [process-identity.mjs](../../scripts/process-identity.mjs) 在 Windows 优先走原生 `OpenProcess/GetProcessTimes`；只有获取失败才启动 PowerShell，后者有 5 秒上限。本轮冷锁与身份初始化合计只需 19.885–27.506 ms，不是秒级启动瓶颈；单独身份诊断处于暖状态，为 0.048–0.151 ms。
- 未设置手动/环境代理时，[system-proxy.mjs](../../scripts/system-proxy.mjs) 同步读取系统注册表，最长 1.5 秒。本轮实测为 61.096–81.080 ms，不能用超时上限代表实际成本。报告只保留是否命中与耗时，不写代理地址或凭据。

### 子进程：请求就绪前导入较大依赖图

[instrumentation-node.ts](../../src/instrumentation-node.ts) 顺序等待以下模块导入：认证与私密 IPC 发布、`update/startup-check`、`automations/runner`、`remote/supervisor`。

- `startup-check` 静态导入 `update-service`；即使关闭联网更新检查，该模块图仍先导入。
- `automations/runner` 静态导入 `agent-manager`，后者与 `pi.ts` 均静态导入 SDK 公开入口及相关服务。这使没有到期任务的启动也先付出模块加载成本。
- `startAutomationScheduler` 调用本身创建定时器并异步开始恢复记录；并未同步等待一次真实模型执行。
- 关闭 fixture 的远程开关，只在 `remote/supervisor` 导入之后返回。
- `http-request-guard.mjs` 顶层没有 SDK 导入，安装过程主要是 HTTP API 挂钩；不能未经计时把它列为大头。

这些是可确认的加载顺序，**尚未得到各模块耗时或确定需要调整的依赖边界**。

### 首次会话列表和预热

[session-reader.ts](../../src/lib/session-reader.ts) 在没有有效索引时以 16 个文件为一批读取会话、生成摘要；本 fixture 首轮需要处理 300 个文件，包括长会话。分页限制返回条数，并不免除建立全部摘要的工作。

`warmFirstPaint` 先确认服务身份和认证，再等待 `/api/version`，最后并发发出 sessions/workspaces/models/pi-settings。后四项没有被全部 await；启动器打印就绪并不表示四个请求均已完成。首个实际请求可能与它们争用同一进程资源。

## 原始分段设想（本轮仅实施父启动与校验计数）

| 补测 | 保持的条件 | 记录与判定目标 |
| --- | --- | --- |
| 父启动分段 | 同一封存 stage；独立临时数据目录；无服务监听 | 新 Node 中分别计时 launcher import、原生锁/身份、ensureInstallBuild、createLaunchPlan、代理读取；每段 wall time 与 CPU；不输出任何凭据 |
| 校验成本计数 | 完整 SHA 和边界检查保持启用 | 仅在临时探针进程包装 fs 的同步只读 API，统计调用次数与耗时、读取字节；先做无包装基线，再做归因计数，避免把 hook 开销混为产品耗时 |
| 子启动边界 | 正常认证、原生锁、IPC；仍用新数据目录 | 外部一次性 preload 标记入口，记录父 spawn、真正 TCP listen、Next Ready 日志、首个 HTTP health、首次私密 IPC成功；不修改封存业务文件、不记录令牌 |
| 首接口对照 | 现有 `PIWEB_SKIP_WARMUP=1`；各用全新进程 | 空白数据与固定 300 会话数据分别测 health→sessions、health→version→sessions，区分一次性请求管线与首次扫描；保持模型调用为零 |
| 模块加载归因 | 无真实模型/联网更新/公网隧道；在隔离数据里 | 从同一生产产物定位 instrumentation 与 SDK 加载成本；必要时用一次诊断 profile，与无 profile基线分列；不将直接源码TS导入时间替代真实成品启动时间 |

本轮获准后串行完成前三轮父启动基线与一轮校验计数，未与浏览器计时重叠。新增结果写入独立 JSON，原始启动证据未覆盖。表中子启动、首接口对照与模块 profile 未实施，也未实施任何产品优化。

## 本轮准备范围已缩小

按协调要求，本轮只实施父启动流程分段测量，方法与结果见 [父启动分段实测](startup-parent-breakdown.md)：三个全新 Node 进程不包装文件读取方法，随后一个全新进程统计同步只读方法调用。顺序保留冷原生锁/身份、两次成品检查、配置与系统代理读取；独立身份采样是暖状态，另列。总和明确排除端口探测、子服务启动、HTTP 就绪与清理，不冒充端到端启动。临时探针 `.startup-parent-probe.mjs` 已按本轮临时文件规则回收。

脚本绑定当前 sourceHash 与 BUILD_ID，拒绝修复或重新构建成品，仅写本次独立临时数据。通过语法检查后，经协调在 17:02:45–17:03:04（UTC+8）执行四轮，原始结果为 [startup-parent-breakdown.json](startup-parent-breakdown.json)，不会覆盖已有证据。四个测量进程均已退出。其余新服务、模块 profile、空白数据对照不纳入本轮。17:05 已回收探针与临时 fixture，见 [探针清理记录](startup-parent-cleanup.json)；后续前端测量及测试服务全部退出后，stage 已回收，见 [stage 清理记录](cleanup-stage.json)。证据完整保留。
