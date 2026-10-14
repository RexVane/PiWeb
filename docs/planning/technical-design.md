# PiWeb 启动与本地配置读取：技术方案

> 调研与实测数据见本文 §1、§2;方案见 §3。所有数字来自本机(Windows / NTFS / Defender 开启,
> 36 个会话 / 17.5MB JSONL、1 个已认证 provider)生产构建实测,脚本见 §5。
>
> §6 是**后续待做**的性能项(大会话快照体积),§7 是 2026-10-12 功能与显示走查的发现。
> 两节都只记录结论与数据,尚未实现。

## 1. 结论（一句话）

启动慢不是 Next 启动慢，而是**第一个动态 API 请求要一次性付出 2.4~3.3 秒的模块加载成本**，
浏览器首屏正好撞在它上面；侧栏每 3 秒轮询还在做多余的写锁与读盘。两处都在本文档的改动里解决。

## 2. 实测链路与瓶颈

### 2.1 启动时间线（`piweb --no-open`，空载）

| 环节 | 实测 | 结论 |
|---|---|---|
| 安装校验 + 生产构建选择（`selectProductionBuild`） | 65ms | 正常 |
| Next 启动 → 端口可连 | 634~757ms | 正常 |
| 首次 `/api/health` 200 | +700ms | 正常 |
| `GET /` HTML（25.4KB） | 18~33ms | 正常 |
| **首屏三件套（sessions + workspaces + models 并行）** | **2760~3326ms** | 瓶颈 |
| 用户看到内容 | ~4.6~5.0s | |

### 2.2 首个动态 API 请求的一次性成本（关键发现）

| 测试 | 结果 |
|---|---|
| `/api/version` 首次 / 第二次（只 import 一个常量） | **2559~3566ms / 4~10ms** |
| `/api/git` 首次、`/api/security` 首次 | 4956ms、4185ms |
| 页面路由 `GET /` 首次 | 23~73ms（不受影响） |
| `/api/health` 首次（且连续两次也无效） | 598~886ms |
| 三个冷路由并行 | 各自 2.6~2.8s（共用同一次成本） |
| 冷进程 `import @earendil-works/pi-coding-agent`（dist 17.5MB / 1064 文件） | 3132ms |
| 3 次全新进程重复同一测试（排除磁盘/杀软冷读） | 2559 → 2679ms，不衰减 ⇒ **每进程 CPU 工作** |

结论：成本与具体路由无关、与 SDK 是否被 import 也无关（`/api/version` 不 import SDK 一样中招），
是 Next 生产服务器把 app-route 动态路由管线留给首个请求现加载；`/api/health` 走的是轻量路径，
所以启动器的探活并不能替用户吃掉这笔成本。

### 2.3 预热验证（端口打开即后台预热门面路由）

| 场景 | 首屏三件套 | 用户看到内容 |
|---|---|---|
| 不预热（今天） | 3326ms | ~5000ms |
| 只预热 `/api/version` | 644ms | ~4236ms |
| 预热 `/api/version` + 三件套 | **110ms** | ~3900ms |
| 用 `/api/health` 预热两次（对照） | 3074ms | 无效 |

### 2.4 轮询与配置读盘

| 项目 | 实测 |
|---|---|
| 冷扫描全量解析 17.5MB JSONL | 136ms |
| 热扫描（readdir×33 + stat×36） | 10ms |
| `/api/sessions` 每 3 秒轮询 | 6~20ms（列表 TTL 1.2s < 轮询 3s ⇒ 每次都真扫） |
| `proper-lockfile` 加解锁（每次 `registerCwds`） | 1.1ms + 建删 `.lock` 目录 |
| 读+解析 `web-workspaces.json`（每轮询 2 次） | 0.35ms/次 |
| 读+解析 `settings.json`（6 处调用点，含**同步**读） | 0.33ms/次 |
| `resourceFingerprint` 同步 statSync 遍历 | 2.4ms/次（每次快照、每次打开会话） |

隐患：只读路径依赖「能在 `~/.pi/agent` 建目录」——受限环境下稳定 500：

```
{"success":false,"error":"EPERM: operation not permitted, mkdir 'C:\\Users\\guica\\.pi\\agent\\web-workspaces.json.lock'"}
```

每个请求重试 20 次 ≈ 2 秒，侧栏永久报错。

### 2.5 会话打开（SSE 首快照）

| 场景 | 首快照 |
|---|---|
| 冷开（SDK 已热、loader 未发现） | 91~141ms |
| 同进程重开 | 15~28ms |
| 3MB 会话 vs 13KB 会话冷开 | 157ms vs 258ms（都由资源发现主导，不是 JSONL 大小） |

### 2.6 首屏前端资源

- 8 个 chunk / **1272KB**（未压缩），其中 **472KB** = highlight.js + react-markdown + remark-gfm + rehype-highlight
- CSS 370KB：两个 155KB 的字体 CSS，各 239 条 `@font-face`（共 478 个 woff2 / 18.3MB 字体池，按需分片）
- 首屏请求里 `/api/workspaces` 与 `/api/sessions` 返回的 `workspaceRegistry` 完全重复

### 2.7 dev 模式对照

```
port open 4.5s → /api/health 首次 4.9s → GET / 首次 18.9s → /api/sessions 首次 9.5s
GET /api/sessions 200 in 9.5s (next.js: 2.4s, application-code: 7.2s)
```

约 45s 才能用；第二次请求起 15~40ms。这是 webpack dev 现场编译的固有成本。
**给用户用生产模式**（`piweb` / `npm start`，发布前 `npm run build:release`）；dev 只适合改代码调试。

## 3. 改动（选型与实现）

### 3.1 启动预热（P0）——`scripts/launcher.mjs`

- 新增 `warmFirstPaint(base, options)`：等端口起来 → **不带凭据**确认是 PiWeb（沿用 `isPiWebRunning`
  的既有约定，绝不把密码发给占端口的陌生进程）→ 先打最便宜的 `/api/version` 吃掉一次性成本 →
  再后台并行预热 `FIRST_PAINT_ROUTES = /api/sessions、/api/workspaces、/api/models、/api/pi-settings`。
- `runLauncher` 在 spawn 之后立即调用（不阻塞），`ready()` 在打印「就绪」前 await 它，
  这样浏览器打开时服务端已经是热的。轮询间隔 500ms → 250ms。
- 开发模式不预热（每次请求都要现场编译，预热只会白占 CPU）；`PIWEB_SKIP_WARMUP=1` 可关闭。
- 失败一律静默：预热是优化，不是启动的前置条件。
- 未采用 `src/instrumentation.ts`：启动器已覆盖 `piweb` / `npm start` / `npm run dev` 三条入口，
  服务端再预热一次会和启动器重复（两处都发请求），收益为零、复杂度更高。

### 3.2 会话摘要索引落盘（P1）——`src/lib/session-reader.ts`

- `summaryCache` 落盘到 `~/.pi/agent/piweb-session-index.json`（带 `version`，条目为
  `path → [mtimeMs, size, summary]`），debounce 1.5 秒原子写回，最多 5000 条。
- 命中规则不变：`mtimeMs` 与 `size` 都一致才复用；文件删了照旧由 `seen` 清理。
- 索引只是加速：读不到、版本不符、写不进去都退化成全量扫描。会话库换目录（`PI_CODING_AGENT_DIR`）
  时缓存与索引路径一起换，且**写回索引时不再重新解析路径**（否则会把 A 目录的摘要写进 B）。

### 3.3 轮询零 I/O（P2）——`src/lib/workspace-store.ts`、`src/app/api/sessions/route.ts`

- 读路径不再取锁：`read()` 改成按 `(mtime, ctime, size, ino)` 校验的进程内快照；
  写路径仍是「进程内串行 + proper-lockfile + 原子替换」，写完让快照失效。
- `registerCwds` 先比快照：没有新 cwd 就直接返回（0 锁、0 读盘、0 写盘），有新增才走原来的加锁写入。
- 顺带消除 §2.4 的 500 隐患：只读请求不再要求「能在配置目录里建锁目录」。

### 3.4 配置读盘统一缓存（P3）——新增 `src/lib/agent-config.ts`

- `readJsonObject` / `readJsonObjectSafe` / `readJsonObjectSync`：按 `(mtime, ctime, size, ino)` 校验，
  返回**副本**（调用方可放心修改）；`invalidateJsonFile` / `invalidateJsonFilesNamed` 供写路径作废。
- 接入点：`pi-settings`（settings.json）、`security-service`（defaultProjectTrust）、
  `pi.readDefaultProjectTrust`（同步路径，每次会话创建/资源指纹都会跑）、
  `models-service.readStoredAuthTypes`（auth.json）、`plugins-service`（全局与项目 settings.json）。
- `models-service`：provider 认证探测结果单独缓存 60 秒（目录 TTL 仍是 5 秒）；
  `/api/models` 的 gzip 结果按目录版本戳复用，不再每次用主线程重新压 271KB/482KB。
- 未采纳：给 `resourceFingerprint` 加 1 秒短缓存。实测 2.4ms，但会让「刚新增 prompt/技能文件 →
  自动重载」在窗口内失效（`tests/agent-resource-isolation.test.ts` 直接抓到），不值得。

### 3.5 打开会话预热（P4）——`src/lib/agent-manager.ts`、`src/app/api/sessions/route.ts`

- `warmSessionResources(cwds)`：侧栏一拿到会话列表，就把最近那个工作区的资源发现（扩展/技能/
  AGENTS.md/prompt 模板）先跑掉——首快照的 ~140ms 主要是它。每个 cwd 只做一次、最多两个、失败静默。

### 3.6 首屏瘦身（P5）——`src/components/MarkdownBlock.tsx`（新）、`ChatWindow`、`AppShell`、`usePiWeb`

- Markdown 渲染（react-markdown + remark-gfm + rehype-highlight，实测 472KB）拆成独立模块，
  `ChatWindow` 用 `next/dynamic` 懒加载 → 挪出首屏；`AppShell` 在空闲 1.2 秒后预取，
  正常打开会话时已经就绪。流式节流渲染行为不变。
- 挂载时不再单独请求 `/api/workspaces`（首个 `/api/sessions` 响应里带着同一份 registry）；
  只有会话列表拉取失败时才回退单拉一次。

## 4. 验收

### 4.1 测试与构建

- `npm run typecheck` 通过；`npm test` 66 个文件 / 490 个用例全绿（1 skipped）；
  `npm run build` 与 `npm run build:release`（内含 `npm run check`）均通过。
- 新增覆盖：预热顺序与凭据不外泄（只把 Basic 发给已验证身份的服务）、预热失败不影响就绪、
  dev 与 `PIWEB_SKIP_WARMUP=1` 不预热、摘要索引落盘与失效（改文件必重解析）、
  轮询不再写盘/不加锁、外部改写注册表立刻可见、流式 Markdown 仍按 Markdown 渲染。

### 4.2 端到端实测（同一台机器、同一份数据、同一个 release）

A = 改前（`PIWEB_SKIP_WARMUP=1` + 摘要索引移开），B = 改后（默认）：

| 指标 | A 改前 | B 改后 |
|---|---|---|
| 端口可连 | 764ms | 145ms（注：B 是第二次加载同一 release，文件已在系统缓存里） |
| `/api/health` 200 | 1405ms | 1480ms |
| **首屏三件套（sessions+workspaces+models）** | **3230ms** | **20ms**（sessions 10 / workspaces 9 / models 19） |
| 侧栏轮询 4 次 | 30, 12, 11, 11ms | 10, 10, 11, 11ms |
| 打开会话首个快照 | 31ms | 29ms |
| `models?custom=1` / `pi-settings` | 16ms / 5ms | 13ms / 3ms |
| 用户看到「页面 + 数据」 | ~5.0s，且先空转 3.2s | ~4.1s，页面出现即有数据 |

说明：B 里 `GET /` 在预热进行中测量是 2324ms——那 2.5s 的一次性模块加载仍然存在，只是被挪到
「就绪」之前（浏览器打开前）付掉了；`ready()` await 的是最贵的那一次 `/api/version`，
四个首屏路由的预热不阻塞就绪，与浏览器加载 HTML/JS 并行。

会话摘要索引单独对比（先吃掉管线成本，再量首次 `/api/sessions`）：

| 场景 | 首次 `/api/sessions` |
|---|---|
| 没有索引（全量解析 17.5MB JSONL） | **195ms** |
| 命中索引（只 stat + 校验） | **83ms** |

其中「扫描 + 摘要」这段本身从 136ms 降到 ~10ms（剩余部分是首次 import pi SDK，约 60~70ms，
一次性的）。会话越大越多，节省越线性放大。

## 5. 复现脚本

调研用的探针（冷/热首屏、轮询、会话打开、SDK 加载、dev 对照、微基准）已归档到
`backups/files/*-20261011-131921.mjs`；其中 `probe-v8`（预热效果）、`probe-v11-minwarm`（最小预热集）、
`micro-bench`（读盘微基准）、`sdk-load-bench`（SDK 加载）是主要证据来源。
本次改后的 A/B 脚本是一次性的(`%TEMP%\piweb-verify.mjs`、`%TEMP%\piweb-index-ab.mjs`),
未进仓库;要长期回归的话,把 §4.2 的三段逻辑并进 `scripts/` 更合适。

---

## 6. 待做:大会话快照体积(`trajectory.detail` 占 92%)

> 状态:**只调研、未实现**。触发条件:「打开大会话变慢」或「远程 / 隧道下开会话等待明显」。
> 当前使用体感正常,按用户决定先记录、后做。

### 6.1 问题

打开 1587 条消息的会话(`--D--AIApp-PiWeb--/2026-10-11T12-18-59-789Z_import-claude-*.jsonl`),
SSE 首个快照帧 **6,376,665 字节(6.38 MB)**,gzip 后 1.82 MB(29.2%)。

- 本机(127.0.0.1)首字节 125ms,靠 localhost 带宽兜住了;
- 走 Cloudflare 隧道 / 远程时,这 6.38 MB 是明着的等待开销;
- `#062` 只给 `?poll=1`(隧道长轮询)开了压缩,本机与局域网的 SSE 仍带 `no-transform` 不压缩
  (`src/app/api/agent/[id]/events/route.ts` 注释:压缩会把 SSE 流攒住,破坏逐字效果)。

对照:706 条消息的会话快照 1.74 MB;同进程重开该会话仍是全量快照。

### 6.2 构成(实测,同一份快照)

| 字段 | 大小 | 占比 |
|---|---|---|
| `messages`(1587 条) | 2.872 MB | 50.6% |
| `trajectory`(1589 条) | 2.793 MB | 49.2% |
| 其余 28 个字段 | 0.007 MB | 0.2% |

`messages` 按 role:`toolResult` 941 条 **2.186 MB**、`assistant` 634 条 0.604 MB、`user` 12 条 0.081 MB。

`trajectory` 按字段(关键):

| 字段 | 大小 | 占 trajectory |
|---|---|---|
| **`detail`** | **2.578 MB** | **92.3%** |
| `tokens` | 0.037 MB | 1.3% |
| 其余 7 个字段(`seq`/`kind`/`ts`/`title`/`toolName`/`toolCallId`/`isError`) | 0.178 MB | 6.4% |

**两个视图是同一份数据**:抽查 `toolu_01FPmhmNd6EpvoGyC2uPxJmG` ——
`trajectory[].detail` 11,020 字节,`messages[toolResult]` 11,532 字节,同为该工具输出全文;
941 个 `toolCallId` 在两边各存一份。

### 6.3 方案(按收益排序)

**方案 1(推荐,低风险):`trajectory` 只推摘要,`detail` 按需拉**

- 服务端 `buildSnapshot`(`src/lib/agent-manager.ts:1411`)序列化 trajectory 时去掉 `detail`/`preview`/`thinking`;
- 新增 `GET /api/agent/[id]/trajectory/[seq]` 取单条全文;
- `openToolTrajectory`(`src/components/AppShell.tsx:341`)改成点开时按 `seq` 拉全文再 `setSelected`。
- 实测收益:`trajectory` 2.793 → **0.200 MB(−92.8%)**,整条快照 5.672 → **3.079 MB(−45.7%)**。
- 聊天视图**不受影响**:`ChatWindow` 只用 `timing`/`tokens`/`title`/`isError`,不读 `detail`
  (`ChatWindow.tsx:929` 传 `trajectory`,`onInspectTool` 走 `openToolTrajectory`)。

**方案 2(收益最大,风险中高):在方案 1 之上,`messages` 的 `toolResult` 也改截断预览**

- 快照里 `toolResult` 只发前 ~2KB 预览,全文按需拉。
- 预估 5.672 MB → **约 1 MB(−82%)**。但聊天视图要改成懒加载全文,
  `messages` 不再是权威内容,要动 SSE 协议语义。
- 是「工具卡默认折叠、点开才要全文」这个既有交互的延伸,但涉及面大。

**方案 3(独立小改):本机 / 局域网 SSE 也开压缩**

- 一条配置改动:6.38 → 1.82 MB(传输 −71%),零协议改动。
- 但压缩只能对**快照帧**做,不能对整个 SSE 流做(会把流攒住,破坏逐字效果),
  要按帧判断,略绕。与方案 1/2 不冲突,可叠加。

### 6.4 未决

- 方案 1 的 API 形状:`/api/agent/[id]/trajectory/[seq]` 还是复用 `?detail=1` 查询参数;
- `env-lazy` 的 trajectory 条目(`environmentTrajectory`)没有 `detail`,要确认摘要字段完整;
- 增量 `traj` 事件(`src/lib/types.ts:116`)也带完整 `entry`,流式期间每个 dirty entry 重发全文 ——
  方案 1 若只改快照,增量路径仍会推 `detail`。**要做就得两条路径一起改**,否则没省到。

---

## 7. 待做:数字显示精度与格式统一

> 状态:**只调研、未实现**。诉求(2026-10-12 用户提出):「缓存、tokens 数、输出速度、上下文计算
> 这些显示的数字,想精确到小数点后两位」。调研结论:**统一到「两位」不是对每个指标都对**,
> 下面按指标给出建议精度。

### 7.1 现状(实测,同一个 13 轮会话)

底部统计条当前实际渲染:

```
13 轮 · 493 步 | LLM 19m30s · 工具调用 3m57s | 首 token 平均 5.3s · 107 tok/s | 缓存命中 98% | 输入 42.7M tok · 输出 273K tok
```

| 指标 | 当前格式 | 当前精度 | 数据来源 |
|---|---|---|---|
| 轮次 / 步数 | `13 轮 · 493 步` | 整数 | `stats.userMessages` / `assistantMessages` |
| LLM 耗时 | `19m30s` | 秒(无小数) | `fmtDuration`(ChatWindow:1251) |
| 工具调用耗时 | `3m57s` | 秒(无小数) | 同上 |
| 首 token 平均 | `5.3s` | 0.1s | `fmtDuration` |
| **输出速度** | `107 tok/s` | **整数**(≥10 时 `Math.round`) | `fmtThroughput`(ChatWindow:1258) |
| **缓存命中** | `98%` | **整数**(`Math.round`) | ChatWindow:1284 |
| 输入 tokens | `42.7M tok` | ≥100 时取整;否则 0.1 | `fmtTok`(ChatWindow:1246) |
| 输出 tokens | `273K tok` | ≥100 时取整 | 同上 |
| 上下文占用(按钮) | `9% 上下文已用` | **整数** | ContextMeter:87 `Math.round(p)` |
| 上下文明细(弹窗) | `~86.6K / 1000.0K` | 0.1K | ContextMeter:20 `toFixed(1)` |
| 上下文分段逐项 | `~40.8K` 等 12 项 | 0.1K | 同上 |
| 单条耗时(弹层) | `19 分 30 秒` | 秒 | `formatRunDuration`(ChatWindow:58) |
| 花费 | `$0.0000` | 4 位小数 | ChatWindow:148 `toFixed(4)` |
| 轨迹条目 tokens | `1.2M` / `262.4K` | 0.1 | `fmtTok`(TrajectoryView:28) |
| 轨迹条目耗时 | `1.5m` / `3.2s` / `450ms` | 0.1 / ms | `fmtDur`(TrajectoryView:46) |
| 资源大小 | `5.4 KB` | 0.1 | `formatBytes`(PromptPanel:47) |
| 附件大小 | `1.2MB` / `512KB` | 0.1 / 整数 | ChatInput:776 |
| 配额 tokens | `53M` | 0.1 | `fmtQuotaTokens`(SettingsPanel:1726) |
| 会话时间(侧栏) | `3月` / `2mo` | 整数 | SessionSidebar:46 |

### 7.2 发现的两个真问题

**问题 1:`fmtTok` 有三份互不一致的实现,同一数字显示不同**

| n | ChatWindow | ContextMeter | TrajectoryView |
|---|---|---|---|
| 262400 | `262K` | `262.4K` | `262.4K` |
| 1234567 | `1.2M` | `1234.6K` ← 不换单位 | `1.2M` |
| 53000000 | `53M` | `53000.0K` ← 不换单位 | `53.0M` |
| 42000 | `42K` | `42.0K` | `42.0K` |

`ChatWindow.fmtTok` 是唯一「≥100 就不显示小数」的,`ContextMeter` 是唯一「M 单位不切换」的。
同一个 token 数在统计条、上下文弹窗、轨迹面板里出现三种写法。

**问题 2:统计条溢出被省略号切掉(实测)**

```
容器 544px / 内容 959px → 被切掉 415px,textOverflow: ellipsis
```

即「输入 42.7M tok · 输出 273K tok」之后的内容用户看不到(悬停浮层里才有完整行)。
**任何提高精度的改动都会让切得更早**,所以精度问题必须和布局问题一起解。

### 7.3 建议精度(按指标给,不是一律两位)

「两位小数」对**比率和速率**合理,对**大数 tokens 和秒级耗时**没意义(273.45K tok 的末两位
是估算噪声,上下文分项本来就是「字符数 ÷ 4」的启发式)。建议:

| 指标 | 建议 | 理由 |
|---|---|---|
| 缓存命中 | `98.42%`(两位) | 比率,两位有意义;现在 `Math.round` 丢掉了 0.5% 的差 |
| 输出速度 | `107.34 tok/s`(两位) | 速率,两位有意义 |
| 上下文占用 | `9.42%`(两位) | 比率;现在整数看不出 8.6% 和 9.4% 的差 |
| 首 token 平均 | `5.32s`(两位) | 时长,两位有意义 |
| 上下文分项 | `~86.61K`(两位) | 与占用百分比口径一致 |
| 输入 / 输出 tokens | `42.73M` / `273.15K`(两位) | 可选;末两位是估算噪声,但用户要求一致就照做 |
| LLM / 工具耗时 | 保持 `19m30s` | 分钟级 + 两位小数的秒 = `19m30.42s`,读起来更差 |
| 花费 | 保持 4 位 | 金额,4 位是惯例 |
| 轮次 / 步数 / 文件数 | 保持整数 | 计数,不存在小数 |

### 7.4 方案

**方案 1(推荐):抽 `src/lib/format.ts`,统一所有数字格式**

- 新增共享模块,导出 `fmtTok` / `fmtPercent` / `fmtThroughput` / `fmtDuration` / `fmtBytes`,
  每个带明确的小数位参数;
- 删掉三份重复的 `fmtTok`(ChatWindow / ContextMeter / TrajectoryView)、两份 `fmtDuration`
  (ChatWindow / TrajectoryView)、两份字节格式(PromptPanel / ChatInput);
- 精度按 §7.3 表设定,集中在一处,以后要调只改一行;
- 加单测锁住每个格式(现在**零**格式相关测试)。

**方案 2:只改精度,不抽公共模块**

- 就地改 12 处 `toFixed`/`Math.round`;
- 改动面小,但三份 `fmtTok` 仍然不一致,下次还会漂移。

**方案 3(与布局一起解,推荐并入方案 1)**

统计条现在 959px 装进 544px。提高精度后会到约 1061px(两位)/ 1108px。
可选做法:
- 窄屏时分两行(现在单行 `whitespace: nowrap`);
- 或按优先级截断:始终保留「缓存命中 / tok/s / 上下文」这几个用户最关心的,把「输入 / 输出 tokens」移到悬停浮层;
- 或降低该项字号。

### 7.5 未决

- 「两位小数」是否包括**大数 tokens**(42.73M)与**估算类**上下文分项 —— 用户原话是「所有都是这样」,
  但估算值给两位小数会有「精确的假象」。建议除 tokens 外都两位,待确认。
- 统计条布局:分两行 vs 优先级截断,需要视觉确认。
- `i18n` 里 `statsCounts` 等模板带 `{turns}` 占位符,精度改动不涉及文案;但若统计条改分段,
  建议把整行拆成多个 `<span>` 以便单独省略。
---

## 8. 功能与显示走查发现(2026-10-12)

> 状态:**只记录、未修**。用无头 Chromium 走查了 13 个区域(设置 6 个分区、模型/工具/插件/技能/远程、
> 对话视图、工具卡、上下文计量、提示词、Git、项目 + 成长树、文件查看器、轨迹详情、导入会话)。
> **全程 0 条 console 错误、0 条 JS 错误。**

### 8.1 正常项

| 区域 | 实测 |
|---|---|
| 通用设置 | 语言 / 6 套主题 / 亮暗 / 界面字体 + 对话字体 / 流式样式 4 种 + 速度 5 档 / 光标 / Enter 行为 / 自动压缩 / 自动重试 / 双版本更新 / 退出登录 |
| 模型 · 工具 · 插件 · 技能 | 全渲染 |
| 远程连接 | 局域网 4 个网卡地址 + 公网开关 + 已登录设备 |
| 对话视图 | 3 回合 → 1226 DOM 节点;思考折叠、工具卡、失败卡、代码块 |
| 工具卡展开 | 1226 → 1412 节点,diff 内容正确 |
| 上下文计量 | 12 个分项全部算出(System 786 / Tools 2.1K / Memory 931 / Skills 382 / Thinking 40.8K / Tool Output 29.9K / Compacted 4.8K / Free 904.5K) |
| 提示词面板 | 项目记忆 / 9 个技能 / 10 个内置工具 / 系统提示词 / 压缩摘要 |
| Git 详情 | 分支 main · 领先 1 · 干净 · 10 条提交 |
| 项目 + 成长树 | 轮次切换、14 文件 +421 −63、目录树、M/A 状态、行数 |
| 文件查看器 | 面包屑 + 变更/内容/渲染 tab + 折叠未改动 + 行号 diff |
| 轨迹详情 | 摘要/预览/原始/来源 4 tab + Call ID + 完整 patch |
| 导入会话 | 6 个来源 × 15 条 + 兜底工作区 + 已导入标记 |

### 8.2 Bug A:侧栏会话预览显示 `bash · bash`(工具名重复)

`src/lib/agent-manager.ts:1763`(`activeStatus()`):

```ts
lastStep = [e.toolName, (e.preview ?? e.title ?? "").split("\n")[0].slice(0, 80)]
  .filter(Boolean).join(" · ");
```

工具刚 `tool_execution_start`、还没收到 `tool_execution_update` 时 `preview` 为空,回落到 `title`
——而 tool 条目的 `title` 就是 `evt.toolName`(`src/lib/trajectory.ts:163`),
于是拼出 `bash · bash`。**修法**:回落到 `detail`(args JSON)里取 `command` 等摘要,
或该情况下不拼第二段。

### 8.3 Bug B:轮次条 8 个按钮缺 `aria-label`

成长树底部的轮次圆点(「你的修改」/「第 1 轮」…「第 3 轮」)和「上一轮 / 下一轮」按钮,
可访问名称只挂在 `title` 上,没有 `aria-label`;`title` 不参与可访问名称计算时屏幕阅读器读不到。
**修法**:补 `aria-label`(可复用同一个 `title` 文案)。

## 9. 数据口径修正：上下文、统计条、Git 行数

用户要求这三处使用真实数据。第 7、8 节是此前的历史观测；#069 的分项归一化只能使加总相等，不能产生真实的分类 token，现已取消。

| 显示项 | 权威数据与显示规则 |
| --- | --- |
| 最近请求输入 | 最近有效 assistant 回复的 API usage，input + cacheRead + cacheWrite；保留精确整数作为悬停值 |
| 当前上下文 | SDK 的投影估算（有效 API usage + 后续消息估算）；明确写「上下文估算」。冷会话采用相同口径，压缩后没有新 usage 时为未知 |
| 内容分类 | 当前投影中系统 sections、toolsAdded、摘要与消息正文的实际字符数。图片不计；API 没有分类 token 时不按比例分摊 |
| Free Space | 窗口 − 上下文估算 − 当前工作区/模型的压缩预留。上下文未知时显示「—」 |
| 会话累计 tokens | SDK 全部持久条目的 usage，包含独立 usage、压缩、分支摘要与工具结果调用；冷热口径一致 |
| LLM / 工具累计耗时 | SDK 保存的 message.durationMs，历史重建补读；缺少耗时的历史显示覆盖数量，不从时间戳差造数 |
| 首 token / 生成速度 | 服务端实时测到的回复，显示样本步数。历史未保存这些字段时不补估算 |
| Git 详情增删行数 | 完整 `git diff/show --numstat -z`，独立于 400 KB patch 展示上限；未跟踪文件用 `git diff --no-index` 取完整统计，二进制不计行数 |
| 项目轮次摘要 | 使用完整 round.stats，文件清单截断/加载不影响摘要。会话累计 diff 未读取完成时显示未知 |

另外修正 numstat 解析：路径中含制表符时保留完整路径，避免两个不同文件在 Map 中覆盖而少计行数。

验证覆盖：历史与实时计时一致、压缩与独立 usage 累计、冷会话尾部工具输出/分支切换/上下文编辑、分类字符不被总 token 缩放、未知余量、暂存/工作区/提交/未跟踪大 diff 截断以及轮次摘要加载状态。

## 10. 输入框 `@` 引用文件 / 文件夹（2026-10-12）

### 10.1 与 pi harness 的关系

pi 终端本来就有这个功能：`pi-tui/dist/autocomplete.js` 在词首 `@` 时弹候选；
CLI 的 `@path` 是启动参数（"Include a text file or image in the first prompt"）。
Web 端原来只有「在文件面板点引用」这条鼠标路径，缺的是打字触发。

**#089 起照搬 pi 真正的 `@` 算法**（`CombinedAutocompleteProvider.getFuzzyFileSuggestions`，见 `src/lib/workspace-index.ts`）。
#078 当初移植的是 `pi-tui/dist/fuzzy.js`（fzf 式跳字母匹配），但那只用于斜杠命令和模型 / 思考档位等参数补全，
pi 的文件补全根本不用它——「与 pi 一致」的说法不成立，同一个 `@fz` 网页命中 `fuzzy.ts`、终端没有候选。现在的规则：

1. **限定目录**：`@` 后的文字按最后一个 `/` 拆成目录 + 查询，目录存在才在它下面找（`@src/l`、`@./src/l`、`@src/lib/../c`），
   路径按用户打的前缀显示；目录不存在就不限定。
2. **fd 式过滤**：查询当正则、smart case（有大写才区分大小写）；默认只匹配**文件名**（所以 `@lib` 给出 `lib/` 文件夹，
   不列里面名字不含 lib 的文件）；查询带 `/` 时匹配整条路径，段间允许 `/` 或 `\`。
3. **评分**（`scoreEntry`）：文件名全等 100 / 前缀 80 / 包含 50 / 整条路径包含 30，目录命中再 +10；0 分丢弃；空查询全部 1 分。
4. **排序**：分数 → 层级（浅的在前）→ 路径长度 → `localeCompare`，取前 20。
5. **显示**：名字（目录带 `/`）在前、路径在后，和终端的 label + description 一样。
6. **token 边界**（`extractAtPrefix`）：空白、`"` `'` `=`、中日韩标点算分隔符；开头的 `(` `[` `{` `<` `` ` `` 剥掉
   （token 里有对应右括号就保留，如 `app/[slug]`）；支持 `@"带 空格 的路径`。英文逗号、分号不是分隔符（`a,@b` 不触发），与 pi 相同。

有意的差别：候选来自服务端清单而不是现场跑 fd——pi 每次 fd 只取前 100 条再打分，这里对整份清单打分，
结果是「fd 不截断时 pi 会给的」且稳定；不支持 `~/`、绝对路径和跳出工作区的 `../`；
fd 用 Rust 正则，`c++` 这种 JS 编不过的模式退回字面匹配（`c++` 结果相同，未闭合括号这类 Rust 也编不过的，pi 没候选、这里按字面给）。

`tests/mention-parity.test.ts` 逐例对照 pi-tui：分隔符正则核对 source；`extractAtPrefix` 固定 + 3000 个随机用例；
`scoreEntry` 逐条相等；**端到端**在临时目录建同一批文件，pi 用真 fd 跑 `getSuggestions`，34 个查询的 label + 路径逐条相等
（PATH 上没有 fd 时跳过并警告）。

### 10.2 候选数据来源

`GET /api/files?index=1&cwd=` → `{ files, source, truncated }`：

- `source=git`：`git ls-files -z --cached --others --exclude-standard`（含未被忽略的未跟踪文件，尊重 `.gitignore`）；
- `source=disk`：不是仓库（或机器上没 git）时退回目录遍历，跳过 `node_modules` / `dist` / `.next` 等重目录，深度上限 12 层。
- 只有这两种情况才退回遍历（ENOENT，或 stderr 含 `not a git repository`；调用时设 `LC_ALL=C`，免得中文界面的 git 把这句翻译掉）。
  其它失败（safe.directory 拒绝、索引损坏、超时）照实报错，菜单显示错误——退回遍历会把 `.gitignore` 掉的文件混进候选，
  还会显示「不是 git 仓库」这条错误的解释。

文件夹不单独下发——前端从文件路径推导父目录，省掉一半 payload（`.gitignore` 排除掉的目录自然也进不了候选）。
实测本仓库：**730 个文件 / 23 KB / 73 ms**，加 60 个目录共 790 条候选。上限 20000 条，超出时置 `truncated` 并在菜单里写明。

### 10.3 交互

- 词首 `@` 触发（`foo@bar` 这类邮箱不触发，边界规则见 10.1）；光标在 token 中间时整段替换，不留半截。
- 候选一次拉全量、按工作区缓存 30s（in-flight 去重；过期时先用旧清单渲染、再后台刷新），
  之后每个字符都在本地匹配——与 pi 一样是瞬时的，不算上本地匹配 20k 条也只有几毫秒。
- 键盘：↑↓ 选择、Enter / Tab 采纳、Esc 关闭、点击采纳；**没有候选时不拦 Enter**（`@某人` 这种不成候选的文字能直接发出去）。
  输入法组字时的按键全部归输入法；Esc 只关掉当前这个 token（按位置 + 原文记，光标在里面移动不再弹，改字、换成别的 token 或离开后重新弹）；
  选中一段文字时不弹。没有工作区（新会话还没选目录）时不进入 `@` 模式（#090 修：首页输入框原来没传 cwd，菜单空转还拦着方向键）。
- 同一工作区多个输入框同时打开只拉一次清单；共享请求不挂任何一方的中止信号，先关的那个不会让后来的拿到 AbortError。
- 选中后文件夹与文件都落成引用 chip（文件夹 = 引用整个目录；要往下钻就继续打 `@src/lib/`），
  正文里的 `@token` 被清掉，发送时统一拼成 `@路径` 行——复用既有链路，与 pi 的 `@` 语法一致。
- 候选被截断、或走了目录遍历时在菜单里说明来源，不静默少候选。

## 11. 模型能力自动识别与配置体检（2026-10-12）

### 11.1 问题：不填字段就会被 pi 的过时缺省顶掉

models.json 里的模型条目不写 `input` / `contextWindow` / `maxTokens`，pi 就用三个缺省值顶
（`dist/core/provider-composer.js:105-110`：`["text"]` / `128000` / `16384`）。实测后果：

- `lilililwan/DeepSeek-V4.1-Flash` 没写 `input` → 贴的截图被换成
  `[Current model does not support images. The image will be omitted from this request.]`；
  那句提示把「配置里没声明」说成「模型不支持」，把人引向「是不是模型不行」；
- 同一条没写 `contextWindow` 时，会话在 **128,444 tokens** 就被自动压缩（真实窗口 1M，等于在 1/8 处丢历史）；
- 而 `virtual-models.js:78` 的同类缺省是 `["text","image"]` —— 同一个字段，两个相反缺省。

### 11.2 端点其实拿得到这些值

`POST /api/models {action:"discoverModels"}` 之前只留 `id` / `name`，把端点返回的能力字段全丢了。
实测本机 magpie 中转（41 个模型）：

| 字段 | 覆盖率 |
| --- | --- |
| 上下文窗口 | 40/41（98%） |
| 输出上限 | 39/41（95%） |
| 视觉模态 | 28/41（68%） |

而且值与会话里实际生效的一致（`commandcode-plan/deepseek/deepseek-v4.1-flash` 端点给 1,000,000 / 200,000 / 有视觉）。
字段名各家不同，`catalogCapabilities()` 统一读：`context_window` / `context_length` / `max_input_tokens`、
`max_output_tokens` / `max_completion_tokens` / `top_provider.max_completion_tokens`、
`modalities.input` / `architecture.input_modalities` / 顶层 `input_modalities`。读不到就留空，不编数。

### 11.3 改动

1. **发现即预填**：`DiscoveredModel` 带上 contextWindow / maxTokens / vision，采纳候选时一起进草稿。
2. **表单加「视觉」三态**（未声明 / 有视觉 / 纯文本；原来连输入框都没有）；容量占位提示保持 pi 的真实缺省 `128K` / `16K`。
3. **不替用户猜值**：只写端点报的、或用户填的；留空就不写，由 pi 按 `PI_MODEL_FALLBACKS`（128K / 16K / 纯文本）处理。
   曾经保存时盲填 1M / 32K（#078），已撤掉（#086）：pi-ai 每次请求都按 `clampMaxTokensToContext(contextWindow − 估算 − 4096)`
   发 `max_tokens`，**往大里猜会让上游直接拒绝**（窗口只有 128K 的模型被当 1M，`max_tokens` 超限报 400）；
   往小里猜只是提前压缩，可以接受，但也不该悄悄发生，所以交给体检提醒。视觉同理：猜错会把图片发给不收图的上游。
4. **体检 + 当场填写**：设置页列出「有字段没写、会落到 pi 缺省上」的条目（`customModelGaps`，只看 `models[]`，不碰 `modelOverrides`），
   每行空着的格子可以直接填（容量支持 256K / 1M 写法，视觉三态，另有「都有视觉 / 都是纯文本」一键表态）。
   保存走设置页已有的 `saveCustomProviders`（`fillModelFields` 只填空、按 provider + 位置定位并核对 ID；
   revision 乐观锁、apiKey 由 `writeCustomProviders` 从原文件恢复），存完重新载入，体检跟着刷新。
   缺口从已载入的配置算，不再单独开 `modelAudit` / `fixModelDefaults` 接口。
5. **填完 URL 和密钥就自动识别**：自定义 provider 还没有任何模型行、地址（+密钥，本机网关可省）都填了时，
   地址或密钥输入框**失焦**（或换协议）就拉一次模型目录并采纳候选；本机/私网地址自动勾上「允许访问本机/私有网络地址」
   （服务端仍会自己再判一次，见 `src/lib/model-endpoint.ts`）。自动跑失败不弹错，按钮还在，手动点能看到原因。
   #078 最初按「停手 0.8 秒」触发，#088 改成失焦：停手计时会拿半截地址、半截密钥去发请求（密钥片段被发往打了一半的主机），
   而且每停一次就多一个请求、先发的可能后到。现在同一签名（URL + 协议 + 密钥）只跑一次；签名一变，还在路上的那次作废，
   迟到的结果丢掉；采纳后用户清空模型行不会被自动加回来；手动点「获取可用模型」时作废自动那次，以候选对话框为准。

### 11.4 验收（生产构建 + 真实数据）

拿**改配置之前的备份**当 models.json 起服务：体检自己报出 3 条，与手工扫描逐条一致（#078 时的验收）。
#086 起补全改成只写用户填的值：`tests/model-audit.test.ts` 覆盖只填空、已有值与 `modelOverrides` 不动、
位置或 ID 对不上就跳过、补完体检缺口消失；`tests/model-draft.test.ts` 覆盖容量留空就不写、端点值原样带进表单。
组件测试覆盖：自定义 provider 没填容量时保存出的条目只有 `id`；自动识别后候选被采纳且容量与视觉来自端点
（`tests/components/provider-setup-modal.test.tsx`）。

### 11.5 仍未解决（在 pi 侧）

三个缺省值本身、以及那句误导性的提示语，都在 pi 包里；npm 一升级就回去了，
只能在 PiWeb 侧兜住（预填 + 体检），或去上游提。

## 12. 输入卡的 chip 显示（引用 / 图片，2026-10-12）

### 12.1 引用 chip：目录与同名文件分不清

`referenceLabelOf` 只取 basename：`src/lib`（目录）显示 `lib`、`src/lib/index.ts` 显示 `index.ts` —— 
目录和文件长得一样（只有 hover 的 title 能区分），`a/index.ts` 与 `b/index.ts` 也完全同形。

改成 `referenceChipOf`：
- 目录存成带尾斜杠的形式（`src/lib/`），chip 显示 `src/lib/` 并换成文件夹图标；
- 其余最多保留**尾部两段**（`src/lib/index.ts` → `…/lib/index.ts`），同名文件立刻区分得开；
- 完整路径仍在 `title` 里。

尾斜杠引入了新的重复风险（面板引用 `src/lib` 与 @ 选择器引用 `src/lib/`），所以两处去重
（`ChatInput.applyMention`、`AppShell.insertIntoComposer`）都改成「去掉尾斜杠再比较」。

### 12.2 图片 chip：被裁成方形、点不开

原来是 `h-14 w-14 object-cover`（56px **裁切**），而对话里已发送的图是 `object-contain` 最大 288px：
贴一张截图在输入框里根本看不出是哪张，也没法核对。

- 缩略图改 `max-h-24 max-w-32 object-contain`（不裁切，按比例放大到 96×128 以内）；
- 点缩略图 → 应用内放大预览（全屏遮罩，点背景、关闭按钮或 Esc 关闭；细节见 12.5）——手机上没法「用本机程序打开」，
  应用内预览是唯一可行的核对方式；
- ✕ 命中区 20 → 22px，并补 `aria-label`（按序号标识，删的是哪张一目了然）。

### 12.3 验收

`tests/components/chat-input-chips.test.tsx`：目录/同名文件/无父目录三类标签、完整路径仍在 title、
缩略图不带 `object-cover`、点开放大显示的是对应那张、Esc 关闭、按序号删除。

### 12.4 折叠：牌堆 + 「展开 N」

引用 chip 和待发送图片超过 4 个时，在手机上折行会把输入框顶掉。折叠方式按用户给的参考图做：

| | 折叠时 | 展开后 |
| --- | --- | --- |
| 引用 chip | 前 4 个 + 「展开 N」（N = 还藏了几个） | 全部 + 「收起」 |
| 待发送图片 | **牌堆**：正面那张可点开预览/删除，后面最多 4 层只露出 4px 右边缘 + 「展开 N」 | 沿弧线扇开（12.5）+ 「收起」 |

阈值是 `COLLAPSE_AT = 4`（`src/components/composer/ComposerImages.tsx` 导出，引用 chip 共用），卡片边长 96。

### 12.5 扇形展开（弧线向上）

用户要求展开时「弧度向上展开，好看一点」。做法不是换一套布局，而是**同一批卡片靠 `transform` 过渡**
（两个状态是同一组 DOM，CSS `transition` 自动演出「从牌堆扇开」的动画）。#085 的第一版有几处硬伤，#091 重做
（图片轨与预览拆到 `src/components/composer/ComposerImages.tsx`）：

| 问题（#085） | 现在（#091） |
| --- | --- |
| 牌堆 `z-index` 用 `-i`，后面几张掉到输入卡背景后面 | 层级始终为正、左压右（`n - i`），牌堆与扇形同一个顺序，展开时不闪着换层 |
| 错位不封顶，16 张时卡片伸出容器 60px | 最多露 4 层边，第 5 张起叠在第 4 层下面、透明 |
| 折叠时每张的 ✕ 都常驻，叠成一串 | 牌堆只有正面那张能点能删，后面几张不进 Tab 顺序 |
| 枢轴半径小、步长固定 14°，5 张时每张只露 25px，几乎看不到图；删除靠悬停，触屏删不了 | 按容器实测宽度排：圆弧半径 520（平缓）、相邻间距 ≤ 76px；左压右，每张露出右侧条带，✕ 就在条带右上角，触屏也点得到；条带窄于 30px 时 ✕ 只在悬停 / 聚焦那张上出现 |
| 长图上下留白透明，透出后面那张 | 卡面有不透明的底；牌堆里后面几张只露空白卡边（看得出是一叠），扇开时图淡入 |
| key 用 base64 前 12 位 + 下标（PNG 前缀都一样），删中间一张时后面的 DOM 被复用成别的图 | 每个图片对象一个稳定 key（WeakMap） |
| 预览挂在输入卡里（祖先 backdrop-filter 会让 fixed 只盖住输入卡）；Esc 冒泡到文件预览等面板一起关；焦点不管 | 预览挂到 body；按键在捕获阶段处理并拦下；打开时焦点进对话框、Tab 只在里面转、关掉还给原来的元素；← → 切换并显示「第几张 / 共几张」，删除后接着看下一张 |

扇开时从左往右依次错开 14ms（收起反过来，总时长封顶 140ms）；`prefers-reduced-motion` 时不做过渡。
几何是纯函数 `deckLayout` / `fanLayout`，单测覆盖对称、中间最高、按宽度不出界；视觉在无头 Chrome 里截图核对过
（平铺 / 7 张牌堆 / 640 宽 5、7 张扇形 / 360 宽 16 张扇形 / 预览）。


## 13. 上下文圆环里改窗口（外部 PR #27 重做，2026-10-13）

外部贡献者 cnluzx 的 PR #27 想在对话框右下角的圆环弹窗里直接调当前模型的上下文窗口。想法有用，但原实现没合，按本地代码重做：

| PR #27 的做法 | 问题 | 重做后 |
| --- | --- | --- |
| 对数滑块 8K–2M、100 档、取整到 1K，停手 350ms 自动保存 | 落不到 128000 / 200000 这类真实值（拖到 200K 附近只有 197K / 208K）；多报一档就是上游 400（见 §11.3 第 3 条） | 精确数字输入（与设置页同一套 `parseCapacity`，支持 200K / 1M），点「保存」才写 |
| 弹窗里没有说明 | 写的是全局 `models.json`（pi 终端共用），入口却在单个会话里 | 输入框下写明「改的是这个模型的全局配置」 |
| — | 没有对照值 | 内置目录有原值就并排给出（`contextWindowInfo` 读 `modelsPath: null` 的原始 SDK 目录），填得比它大时提醒；没有原值时提醒填真实上限 |
| 一律写 `modelOverrides.<id>` | 自定义模型（`models[]`）的值分散到两处，设置页表单显示的还是旧值 | `withContextWindow` 写在 pi 实际取值的那一层：已有覆盖写了窗口就改覆盖（它最后套用）；否则 `models[]` 定义了就改那几条；都没有才写覆盖 |
| 抄一份写盘逻辑 | 少了「校验期间文件被别的程序改过」的检测 | 抽出 `replaceCustomProvidersFile`，与设置页保存共用旧文件校验、SDK 校验、改动检测、原子替换 |
| 新增 `refreshSessionModels()`（保存配置后换绑会话），未 await | 本地已有同样做法的 `swapCurrentModelObject`（#072） | 不重复；写完刷新共享目录，`refreshSessionModels(provider, id)` 只给用这个模型的会话换对象并推一次用量，不重载会话资源 |
| 拿不到新对象时直接改 `model.contextWindow` | 可能改到 pi 内置目录的共享对象 | 不就地改任何模型对象 |
| — | 冷会话（没启动）没有用量推送，窗口要等下一次快照才变 | 保存后先用服务端回的新值重算百分比；窗口值一变（快照 / 用量追上来，或别处改了）或换了模型，就以 props 为准 |

运行中的会话也当场换模型对象：SDK 在扩展注册 provider 时同样会中途替换 `agent.state.model`，已发出的请求不受影响。
接口：`POST /api/models {action:"contextWindowInfo" | "setContextWindow", providerId, modelId, contextWindow?}`，
返回 `{ contextWindow, builtin }`；目录里没有的模型、非正整数都 400。
测试：`tests/models-service-context-window.test.ts` 用真实 `ModelRuntime` 读临时 `models.json`，验证三种写入层级下 pi 取到的值确实变了；
`tests/components/context-meter.test.tsx` 覆盖输入校验、对照提示、Esc 不冒泡、保存失败留在编辑态、保存后重算、快照没追上时保持保存值、别处改了则以 props 为准。

## 14. 右侧旁聊

需求见 `docs/planning/requirements.md`。旁聊在右侧抽屉中常驻，主会话顶栏提供直达入口；沿用现有调宽与手机抽屉布局。面板独立渲染问答、输入框和上下文环；工具执行时显示简短的只读工具状态。

### 14.1 主会话只提供背景

`POST /api/agent/[id]/side-chat` 验证会话路径后，只读取主会话管理器的 `buildSessionContext()` 与当时已生成的正文。这尊重有效分支、上下文编辑及已有压缩摘要，正在流出的文字也可作为背景。不会调用主 AgentSession 的 prompt、abort、compact 或分支方法，不追加 Session 条目，也不推送主会话事件。

通过 Pi SDK 的 `createReadOnlyTools(cwd)` 创建工具，并按现有 `readonly` preset 再过滤，仅开放 `read`、`grep`、`find`、`ls`。工作目录来自当前主会话的 `managed.cwd`；不加载主会话的可写工具、MCP、Codemode 或插件扩展。`pi-agent-core.runAgentLoopContinue()` 驱动独立的内存工具循环，每轮沿用共享 `ModelRuntime.streamSimple()` 的模型、思考档位和 SDK 认证，使用独立的旁聊 affinity ID。主会话系统指令和思考内容不作为旁聊指令转发，文件内容和主会话均作为参考材料。图片背景只保留附件标记，不转发主会话图像数据。

模型默认为「跟随主会话」，也可以在输入框左下角单独选一个（面板里保留跟随主会话选项）；发送时把选择作为 `model` 字段随请求下发，服务端从共享目录取该模型并沿用同一套认证。选择随那份旁聊一起保存，新旁聊继承上一份的选择，只影响之后的问题；选中的模型不在目录里时报「模型不可用」，不静默回退到主会话模型。

背景和旁聊历史按模型窗口保守限制 UTF-8 字节数，计入工具声明，预留输出、协议及工具结果空间。工具结果过长时先移除完整的较旧工具调用与结果，再裁剪当前工具文本并附省略说明；保持工具调用与结果配对。发生截断时向界面返回标记；不为旁聊触发主会话压缩，也不把字节预算显示成 token 统计。一问最多请求模型 32 次，超限给出可重试的错误。界面显示正在使用的只读工具，停止只取消旁聊工具和模型请求。上下文环使用最后一轮模型请求的实际 usage，避免累计多轮输入后误报窗口占用。

### 14.2 持久化与请求生命周期

浏览器按主会话 ID 使用 `piweb.sidechat.v1.*` 保存独立线程、草稿和当前记录。`SideChatStore` 使用自己的订阅，不让旁聊输出触发 AppShell 或主 ChatWindow 的重渲染。关闭面板或切换到其他入口不停止回答；切换主会话时，各自的记录和迟到的回答归各自所有。新旁聊保留旧记录；失败重试复用原问题所在的位置。

服务端只保留临时生成任务。POST 接受请求，GET 以 revision 等待更新并返回有限 JSON 响应，DELETE 停止指定旁聊任务。适用于本机、局域网和会缓冲 SSE 的 Cloudflare 快速隧道。生成中的正文按 offset 增量返回，最终正文修正或旧 cursor 仍可返回完整文本；客户端不重复追加文字。请求 ID 幂等，提前停止会留下短期取消标记，防止迟到的 POST 再发起调用。

持久化按短间隔合并写入，完成、停止、切换记录立即保存，pagehide 补保存。页面刷新后可通过已保存的任务 ID 恢复尚在服务端生成的回答；服务重启或任务已过期时保留已有文字并允许重试。保存失败在面板内提示，不清空内存中的内容。不同浏览器和设备之间不共享旁聊记录。

### 14.3 阅读位置

主会话与旁聊各有滚动容器。打开、关闭或拖动列宽前，记录主会话视口中的文字 Range，布局改变后按其位移修正主会话滚动位置；不支持文字定位的浏览器退回段落锚点。连续拖拽先完成上一帧的校准，过期或宽度未变化的锚点不会在以后拉动主会话。

### 14.4 验证

- TypeScript 检查与独立生产构建通过；本次全量测试 118 个文件通过、1 个文件跳过，973 项通过、2 项跳过。
- `tests/integration/side-chat.test.ts` 使用真实 SessionManager、ModelRuntime 和只读工具，加 SDK 的离线 faux provider：实际读取相对路径文件、列目录、查找与搜索；拒绝 write/edit/bash/powershell/codemode/tool_search/MCP；多轮工具旁聊前后主会话文件逐字节一致，分支与上下文一致，冷会话不启动；停止和循环超限只影响旁聊。`side-chat/tool-context.test.ts` 覆盖完整工具交换裁剪、Unicode 和图像超限。
- 组件验证多轮历史、关闭后完成、跨主会话迟到回答、历史恢复、新旁聊、单独选模型（默认跟随主会话、选后随问题下发、随旁聊保存、可改回跟随）、停止与错误重试、输入法、增量回答修正、存储失败和阅读锚点。
- Next.js 16.4.0 生产构建通过，输出位于独立验证目录，未切换 active release。
- Chrome 在 1600×1000 与 390×844 视口通过实际页面检查：打开、发送、调宽、关闭保持阅读位置；默认跟随主会话、换成旁聊自己的模型后请求带显式模型；旧记录、刷新恢复与手机输入框可见。测试使用固定 API 响应，不调用线上模型或真实用户会话。截图在 `docs/assets/side-chat-desktop.png`、`docs/assets/side-chat-mobile.png`。
- 浏览器脚本：启动本地服务与带 debugging port 的独立 Chrome 后，运行 `node tests/end-to-end/side-chat-browser.mjs http://127.0.0.1:3217 9337 docs/assets`。
