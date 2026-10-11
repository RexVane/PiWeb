# PiWeb 启动与本地配置读取：技术方案

> 调研与实测数据见本文 §1、§2；方案见 §3。所有数字来自本机（Windows / NTFS / Defender 开启，
> 36 个会话 / 17.5MB JSONL、1 个已认证 provider）生产构建实测，脚本见 §5。

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
本次改后的 A/B 脚本是一次性的（`%TEMP%\piweb-verify.mjs`、`%TEMP%\piweb-index-ab.mjs`），
未进仓库；要长期回归的话，把 §4.2 的三段逻辑并进 `scripts/` 更合适。
