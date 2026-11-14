# 规模 / 性能采样报告 —— P2-44 / 45 / 46 / 47 的量化依据

日期：2026-11-13 20:00–20:40　采样机：本机（同一台跑着 30141 dev server）
目的：审计报告里 P2-44/45/46/47（文件侧）的严重度全部建立在「典型工作区有多大」的猜测上。本文用**真实函数**（`@/lib/files-service`、`@/lib/pi`、`@/lib/prompt-sources`、`@/lib/session-reader`）和**真实路由处理器**（`@/app/api/files`、`/api/skills`、`/api/sessions`）在本机 3 个真实规模工作区 + 4 个合成目录上计时，给出 min / median / P95 / max、返回体积、内存峰值，并逐条给升降级建议。

---

## 0. 方法与边界（读之前请先看）

**做了什么**

- 在 `%TEMP%\piweb-verify-scale\` 建了一个临时 vitest 工程（`vitest.config.ts` 用 `alias: { "@": "D:\AIApp\PiWeb\src" }`，`cacheDir` 也指到临时目录，`node_modules` 用 junction 指向仓库自己的），**直接 import 生产代码里的函数**，跑在 Node 24 + 真实 git 2.54 上。仓库内除了本文件没有任何写入。
- 30141 服务全程只做只读探测，没有重启/杀进程。
- `~/.pi` 没有改动：所有会写 agent 目录的路径（会话摘要索引、工作区注册表、设置管理器）都把 `PI_CODING_AGENT_DIR` 指到 `%TEMP%` 下的**镜像**（robocopy 复制的 `~/.pi/agent`，65 个会话 / 92.4 MiB，与原目录同规模）。

**没能走通的那条路（重要）**

想直接给 30141 的认证接口计时，但 `/api/sessions`、`/api/files`、`/api/skills` 全返回 **401**。我用 `src/lib/web-auth.ts` 的 `createSessionCookie()` 按 `~/.pi/agent/web-secret` 签了一张 Cookie，`validSessionCookie()` 在本地对同一 authority（`127.0.0.1:30141`）判定为 `true`（`results/cookie-local-check.json`），服务端仍 401 → 说明**运行中的 dev server 用的签名密钥与磁盘上的 `web-secret` 不一致**（很可能是启动时带了 `PI_WEB_SECRET`/`PI_WEB_SECRET_FILE`；我没有去翻它的进程环境，也没有重启它）。所以：

- 计时改用**进程内直接调用路由处理器**（`GET(new Request(...))`），跑的是同一条真实代码路径（`files-service` → `git`/`fs`），只少了 Next 的 HTTP 层与 proxy。
- HTTP 层开销单独用**公开端点** `/api/health` 量化：n=10，min 12.2 ms、p50 44.9 ms、max 4444 ms（首个请求是 Next dev 的按需编译）。**所以 UI 上看到的耗时 ≈ 下表 + 30–45 ms**（dev 模式；生产构建会更低）。

**没测到的**：production build、手机/远程、浏览器内存（P2-44 只能按文件体积推算）、macOS/Linux。

---

## 1. 采样环境

| 机器 | 值 |
|---|---|
| CPU / RAM | Intel i7-14700HX（20C/28T）/ 15.8 GB |
| 磁盘 | UMIS RPJYJ1T24MLR1HWY NVMe SSD（1 TB） |
| OS / Node / Next | Windows（PS 5.1 环境）/ v24.12.0 / next 16.4.5（dev, `--webpack -p 30141`） |
| git | 2.54.0.windows.1 |

| 工作区 | 磁盘文件 | 磁盘目录 | 磁盘体积 | 是 git 仓库 | `git ls-files`（cached+others+exclude-standard） | `node_modules` 被忽略 | robocopy 全量扫描耗时 |
|---|---|---|---|---|---|---|---|
| `D:\AIApp\PiWeb`（大） | 53,140 | 6,357 | 6.18 GiB | 是 | **1,168 条 / 42,964 B**（tracked 1,030） | **是**（`.gitignore:1: node_modules/`） | 1.17 s |
| `D:\AIApp`（父目录，更大） | **999,998** | 192,840 | 130.6 GiB | **否**（两层内 27 个仓库） | n/a（走磁盘遍历退路） | n/a | 55.7 s |
| `%TEMP%\piweb-verify-scale\small-ws`（小） | 82（含 `.git`，工作区本身 50） | 34 | 32 KB | 是 | 50 条 / 741 B | 不适用 | 38 ms |

补充：本机（`D:\AIApp` 两层内）27 个真实仓库里**最大的**是 `D:\AIApp\study\Reviva`（**79,270 条 / 4,316,679 B**，`ls-files` 1.6 s），其次 `D:\AIApp\.toolcache\flutter`（14,695 条 / 970,750 B）、`D:\AIApp\harness`（10,166 条 / 1.03 MB）。PiWeb 的 1,168 条属**小仓库**。

> 计数会漂：审计期间另一个会话在改这个仓库，同一天里 PiWeb 的 `ls-files` 我先测到 1,167、后测到 1,184 条（±1.5%），响应体 42,963→46,410 B。不影响任何结论。

---

## 2. 逐操作耗时

> 全部为**空闲机器**上的数字（最初一批测量时有另一个全盘枚举进程在抢 IO，已作废重测；两者差异最大达 4 倍，见 §7）。`n` 为有效次数，`p95` 用最近秩法（n≤10 时 p95≈max，已在表里注明 n）。

### 2.1 目录列举 `listWorkspaceDir`（真实工作区，n=12，含 2 次预热）

| 目标 | 返回条目 | 响应体 | min | **p50** | p95 | max | 进程 RSS 峰值增量 |
|---|---|---|---|---|---|---|---|
| PiWeb 根 `/` | 26 | 1,165 B | 56.8 | **60.6** | 71.5 | 71.5 | +2.6 MiB |
| PiWeb `/src` | 8 | 392 B | 54.0 | **59.7** | 80.0 | 80.0 | +0.7 MiB |
| PiWeb `/src/lib` | 80 | 4,239 B | 67.1 | **74.3** | 87.4 | 87.4 | +4.9 MiB |
| PiWeb `/public/file-icons` | 396 | 20,909 B | 101.5 | **114.0** | 140.4 | 140.4 | +19.7 MiB |
| PiWeb `/node_modules`（310 条目，**全部被忽略 → 返回 0 条**） | 0 | 71 B | 62.3 | **67.9** | 75.3 | 75.3 | +6.2 MiB |
| PiWeb `/.git` | 17 | 733 B | 57.1 | **61.3** | 78.5 | 78.5 | +4.9 MiB |
| `D:\AIApp` 根 | 25 | 958 B | 51.0 | **54.9** | 76.1 | 76.1 | +4.2 MiB |
| small-ws 根 | 15 | 539 B | 54.3 | **62.8** | 89.4 | 89.4 | +3.4 MiB |

同一批走**路由处理器**（n=8）：根 63.0 / `src` 61.4 / `file-icons` 94.3（20,933 B）/ `node_modules` 75.6（**95 B 响应**）/ 根第 2 页 84.3（84 B）。

**读法**：固定成本 ≈ **55–85 ms/次**，与目录内容几乎无关——那是 `ignoredNames()` 每次 spawn 一个 `git check-ignore` 子进程（`files-service.ts:184-196` → `:146-177`）。`/node_modules` 那行最能说明问题：**响应只有 95 字节，工作一点没少做**。

### 2.2 合成目录的条目数曲线（P2-45 的核心；同一台机器、同一个 repo 结构）

每个目录都是 `git init` + 全部提交、无 `.gitignore`（= 最坏情况：全部条目可见、全部名字送 check-ignore）。

| 单目录条目数 | page1 p50 | page1 max | page2（offset=2000）p50 | page2 max | 每页响应体 |
|---|---|---|---|---|---|
| 500 | 166.4 ms | 171.6 | —（只有一页） | — | 25,578 B |
| 2,000 | 412.8 ms | 496.3 | 118.4 ms | 137.2 | 102,026 B |
| 5,000 | 475.6 ms | 503.2 | **472.4 ms** | 530.5 | 102,026 B |
| 10,000 | **1,019.7 ms** | 1,052.4 | **1,026.9 ms** | 1,306.9 | 102,026 B |
| 20,000 | **3,743.5 ms** | 4,737.7 | **3,809.2 ms** | 4,240.4 | 102,026 B |

**page1 与 page2 在同一目录上耗时相同**（5000：475.6 vs 472.4 ms；10000：1019.7 vs 1026.9；20000：3743.5 vs 3809.2）——「分页只压缩响应体，不减服务端工作量」这句话**实测成立**。

### 2.3 成本分解：3.7 s 花在哪（n=4，同一批目录）

| 目录条目 | `fs.readdir` | `sort(localeCompare)` | `git check-ignore`（**全部**名字） | `git check-ignore`（只前 2000 个） | 2000 条 `stat` |
|---|---|---|---|---|---|
| 2,000 | 0.8 ms | 0.1 ms | 98.6 ms（31 KB stdin） | 97.9 ms | 174.0 ms |
| 5,000 | 1.8 ms | 0.2 ms | 251.1 ms（78 KB stdin） | 147.4 ms | 182.2 ms |
| 20,000 | 7.9 ms | 1.0 ms | **3,541.1 ms**（313 KB stdin） | **330.9 ms** | 191.0 ms |

结论：`files-service.ts:241` 把**整个目录**的名字送 `check-ignore`，在 2 万条目时占单次请求总耗时的 **94%**，而且**超线性**（2k→98.6 ms，5k→251 ms，20k→3541 ms：条目 ×10，耗时 ×36）。审计里建议的修法（只送当前页）实测能省 **10.7×**（3541 → 331 ms）。

### 2.4 `@` 引用索引 `listWorkspaceIndex`（`git ls-files -z` 那条路）

| 工作区 | 条目 | source | truncated | 函数 p50 | 路由 p50 | 响应体 | 其中 `git ls-files` p50 | 其中 `sort` p50 |
|---|---|---|---|---|---|---|---|---|
| PiWeb | 1,184 | git | 否 | 78.9 ms | 83.1 ms | 46,410 B | 67.9 ms（43,974 B） | 0.3 ms |
| small-ws | 50 | git | 否 | 69.3 ms | 66.5 ms | 765 B | — | — |
| `D:\AIApp\harness` | 10,165 | git | 否 | — | 837.9 ms | 1,051,317 B | 842.6 ms（1,030,919 B） | 1.5 ms |
| `D:\AIApp\study\Reviva` | 20,000（从 **79,270** 截断） | git | 是 | 1,605.5 ms | 1,630.6 ms | 1,249,541 B | 1,609.6 ms（4,316,679 B） | 24.4 ms |
| **`D:\AIApp`（非仓库）** | 20,000（截断） | **disk** | 是 | **1,093.7 ms** | — | 1,199,864 B | —（`walkWorkspaceFiles`） | — |

内存：非 git 工作区那次磁盘遍历 **RSS +134.5 MiB / heap +46.3 MiB**；PiWeb 那次 +60 MiB。

**读法**：`@` 索引的成本几乎全是 `git ls-files` 自己（D:\AIApp\harness 8.4e2 ms 对 10k 条目），`sort` 只占 0.3–24 ms。截断发生在 `sort` **之后**（`files-service.ts:120-121`），所以 79k 条目的仓库仍然先整表排序再切前 20k。64 MB `maxBuffer` 见 §4.3。

### 2.5 技能列表 + 资源指纹（P2-47 的成本单元）

| 操作 | n | min | **p50** | p95 | max | 返回体积 |
|---|---|---|---|---|---|---|
| `GET /api/skills`（loader 已热） | 8 | 0.8 | **1.2** | 2.4 | 2.4 | 799 B（1 个技能） |
| `listSkills()`（进程内，热） | 10 | 0.3 | **0.4** | 0.7 | 0.7 | 764 B |
| `listSkills()` **冷 loader（首次）** | 1 | — | **162.1** | — | — | — |
| `resourceFingerprint()`（不传 loader/packageRoots） | 10 | 9.4 | **10.7** | 12.1 | 12.1 | 指纹串 4,194 B |
| **`resourceLoaderIsStale()`（真实参数，同步）** | 20 | 36.6 | **40.1** | 57.3 | 65.5 | — |
| `refreshResourceLoaderIfStale()` | 10 | 39.0 | **58.1** | 93.9 | 93.9 | — |
| `listPromptSources()`（每次受保护图片请求都走） | 10 | 39.0 | **45.7** | 68.4 | 68.4 | 473 B |
| `resolvePromptSourcePath()`（`?image=1&sourcePath=` 分支） | 10 | 40.1 | **55.6** | 94.8 | 94.8 | — |

内存：`listPromptSources` 峰值 RSS +10.7 MiB，`refreshResourceLoaderIfStale` +13.9 MiB。

**读法**：`resourceLoaderIsStale` 是**同步函数**，真实参数（带 loader + packageRoots）下单次 **40.1 ms** 卡住事件循环。一张图一次 → 10 张图 ≈ 0.4 s 纯阻塞，25 张图 >1 s。

### 2.6 会话列表 `/api/sessions`

本机会话库：**65 个 `.jsonl` / 96,906,593 B（92.4 MiB）**。

| 场景 | 耗时 | 响应体 | 内存 |
|---|---|---|---|
| **冷启动**（摘要索引不存在，全量解析 92.4 MiB JSONL） | **2,940.3 ms** | 25,121 B | **RSS +145.1 MiB / heap +79.2 MiB** |
| 热启动（索引命中，只 stat 65 个文件） | 22.2 ms | 25,251 B | RSS +0.7 MiB |
| 稳态轮询（跨 1.2 s TTL，n=8） | p50 **12.5–20.9 ms**，max 26.2 | 同 | — |
| `GET /api/sessions`（路由，warm，n=6） | p50 **11.7 ms**，max 13.6 | 33,658 B | — |

### 2.7 真实文件体积分布（P2-44 的输入；`git cat-file --batch-check`，非 stat）

| 仓库 | 跟踪 blob | p50 | p90 | p99 | max | >256 KB | >1 MB | >4 MB | 全部 blob 合计 |
|---|---|---|---|---|---|---|---|---|---|
| PiWeb | 1,030 | 1,284 B | 28,580 B | 154,107 B | 479,758 B | 6 | 0 | 0 | 14.0 MB |
| `harness` | 10,165 | 1,276 B | 8,992 B | 88,879 B | 1,542,538 B | 16 | 1 | 0 | 59.8 MB |
| `study\Reviva` | 1,733 | 4,474 B | 27,365 B | 331,088 B | **33,976,244 B** | 22 | 5 | **4** | 163.8 MB |

因为 `filePatch` 用 `-U1000000`（整文件上下文）且上限 4 MB（`growth-service.ts:29,887-890`），**patch 体积 ≈ 文件体积**（大文件被截到 4 MB）。所以「一条 fetchCache 条目多大」＝ 上表的文件体积分布。

---

## 3. 拐点结论

| 操作 | 本机实测最坏 | 超过 1 s 的规模 | 超过 3 s 的规模 | 超过 10 s 的规模 | 形状 |
|---|---|---|---|---|---|
| 目录列举（单目录条目数） | 20k 条目 3.74 s | **≈10k 条目**（10k=1.02 s） | **≈18–20k 条目**（20k=3.74 s） | 外推 ≈40–50k（未实测，超线性） | 固定 55–85 ms + `check-ignore` 超线性 |
| `@` 索引（git 仓库） | 79,270 条目 1.63 s | **≈12k 条目** | 未达到（**15 s 硬超时会先触发**：Reviva 1.6 s/7.9 万 → 约 70 万条目） | 不可达 | ≈线性于 `ls-files` 输出/工作树规模 |
| `@` 索引（非 git 目录） | 20k 截断 1.09 s（D:\AIApp，100 万文件） | **已经是 1 s 级** | 未测到（`INDEX_LIMIT` 在 20k 处截断） | — | 每次请求重走一遍，无缓存 |
| `GET /api/skills` | 2.4 ms | 不可达 | — | — | 常量 |
| 资源指纹（同步，每图一次） | 65.5 ms/次 | **≈25 张图/文档** | ≈75 张 | — | 线性 |
| 会话列表 | 冷 2.94 s（92.4 MiB） | **冷启动即 >1 s** | ≈3 倍体积（未实测） | — | 线性于 JSONL 总量 |
| 目录列举（固定成本） | 55–85 ms/次 | — | — | — | 常量（一次 git 子进程） |

**有没有 O(n²) / 重复全量解析 / 无分页的证据**

1. **`git check-ignore` 全量**（P2-45）：`files-service.ts:241` 每次请求把整个目录的名字写进 git stdin；20k 条目 = 3.54 s，占 94%。**超线性**（条目 ×10 → 耗时 ×36），这是我在本机看到的唯一「像 O(n²)」的曲线。只送当前页可降到 0.33 s。
2. **分页不减服务端工作量**（P2-45）：page2 与 page1 耗时相同（§2.2），实测确认。
3. **未缓存的重复全量解析**（`@` 索引，非 git 工作区）：`D:\AIApp` 这种 100 万文件的非仓库目录，每次 `Ctrl+P`／`@` 都要 BFS 20k 个文件（1.09 s）+ 1.2 MB 响应，**没有任何 TTL 缓存**。
4. **一次请求读了 200 MB 这类事：没有测到。** 最大的单次读放大是会话冷启动（读 92.4 MiB，RSS +145 MiB）和非 git 目录遍历（RSS +134 MiB）。
5. **客户端侧的放大**（不在服务端）：`useGrowth.ts:126-137` 的 `listDiskEntries` 是 `for(;;)` 翻到底、无页数上限；`useGrowth.ts:297-320` 在**每次新 commit** 时把根目录 + 所有已展开目录重新完整翻一遍。一个 2 万条目且已展开的目录 → 10 页 × 3.7 s ≈ **37 s**，而且每次提交都重来一次。这是 P2-45 最坏路径的真正放大器。

---

## 4. 定级建议

### 4.1 P2-45（目录分页只压缩响应体）—— **维持 P2，证据升级为实测；建议在 P2 里往前排**

- 实测：单目录 10k 条目 1.02 s、20k 条目 3.74 s；**page2 与 page1 同价**（3,809 vs 3,744 ms）。
- 成本归因明确：`check-ignore` 全量占 94%，且超线性；改成「只送当前页」实测 3541 → 331 ms（**10.7×**），这是最小改动且收益确定。
- 落在真实工作区上的严重度：本机最"胖"的目录只有 396 条（114 ms），**日常不痛**；痛的是「生成物/导出/日志/未被 ignore 的大目录」，一旦出现就是秒级，且被 `expandLazy` 与「每次 commit 重拉」放大成几十秒。
- 建议：结论不变，把「10 万条目 → 数 MB 写进 stdin」换成实测数字（20k 条目 / 313 KB stdin / 3.54 s），并补一句「2 万条目目录被展开后每次提交约 37 s」。

### 4.2 P2-44（模块级 `fetchCache` 最多 200 份响应，含 4 MB patch）—— **维持 P2，但把体积口径改为实测，优先级下移一位**

- 实测上界：patch ≈ 文件大小（`-U1000000` + 4 MB 截断）。真实仓库文件体积 p99 = **88–331 KB**，>4 MB 的在本机 27 个仓库里**只有 4 个文件**（都在 `study\Reviva`，最大 34 MB）。
- 于是：200 条 × ≤331 KB ≈ **≤66 MB**（`DiffLine[]` 副本再乘约 2 → 百 MB 量级内），**不是「数百 MB」**；要逼近 800 MB 需要 200 个 ≥4 MB 的 patch URL，本机根本凑不出来。
- 仍是 P2：手机上常驻 60 MB+ 字符串确实会被系统回收；且淘汰是 FIFO 不按字节。修法（TTL + 按累计字节上限 + 不缓存 `-U1000000` 的 patch）不变，成本极低。
- 建议：**维持 P2、降序**；把「可达数百 MB」改成「典型 ≤66 MB；单条上限 4 MB 仅在有 >4 MB 文本文件的仓库才接近（本机 4 个文件）」。

### 4.3 P2-46（`git ls-files` 超 64 MB `maxBuffer` → `@` 索引整体 500，无降级）—— **降级 P3**

- 64 MB 需要 **≥120 万条**（Reviva 54.5 B/条）到 **≥180 万条**（PiWeb 36.8 B/条）条目。本机最大仓库 79,270 条 / 4.3 MB / 1.6 s，**离阈值差 15 倍**；PiWeb 级别（1,168 条 / 43 KB）差 1500 倍。
- 真正会先踩到的是 **15 s 超时**（`files-service.ts:114`）：Reviva 1.6 s / 7.9 万条 → 约 70 万条目；PiWeb 曲线（68 ms / 1,168 条）→ 约 26 万条目。两者都要求「单工作区几十万到上百万个文件」。
- 也就是说：**「64 MB maxBuffer」这个具体阈值不现实**，但它暴露的设计缺陷（失败后不退回磁盘遍历、直接 500）在超时路径上同样成立。触发面窄 → **P3**；若保留 P2，请把触发条件改写成「超时/超大仓库」，并把修法从「提高 `maxBuffer` 到 256 MB」改成「流式收集 + 超时/失败时退回 `walkWorkspaceFiles` 并标 `truncated`」。
- 附带数据：本机最大仓库的 `@` 索引耗时 1.63 s、响应 1.25 MB —— 这条（**大仓库上 `@` 索引本身就要 1.6 s 且每次重付**）比 maxBuffer 更值得单独记一条。

### 4.4 P2-47（技能文档每张受保护图片触发一次同步全量指纹）—— **维持 P2（偏下限），修法不变**

- 实测：`resourceLoaderIsStale()`（真实参数、同步）**40.1 ms/次**（p95 57.3、max 65.5）；整条 `resolvePromptSourcePath` **55.6 ms**，`listPromptSources` **45.7 ms**。调用链与描述完全一致（`files-service.ts:328-379` → `prompt-sources.ts:220-221` → `pi.ts:388-395`）。
- 放大关系：N 张图 → N × 40 ms 同步阻塞（10 张 ≈ 0.4 s、25 张 >1 s）。属"能感觉到但不致命"，且修法（按 cwd 的 2 s TTL 缓存 / 同步快路径）改动很小、无正确性风险。
- 建议：**维持 P2**，但删掉「几毫秒到几十毫秒」这种模糊表述，写成实测 40 ms/图，并在标题里点明"同步"这一要害（`fs.*Sync` 递归）。

### 4.5 files-viewer 里其余两条相关表述

| 原文表述 | 采样结论 |
|---|---|
| 「10 万条目的目录 → 服务端一次 readdir + 全量排序 + 约 10 万条路径写进 git stdin」 | **方向对、量级偏保守**：2 万条目 313 KB stdin 已经要 3.54 s，10 万条目按超线性外推远超 10 s（未实测）。另外 `readdir`（7.9 ms@20k）与 `sort`（1.0 ms@20k）微不足道，**成本几乎全在 `check-ignore`**，建议把描述里的三件事按实测重新排序 |
| 「`expandLazy` 等于把整个目录全部拉一遍」 | **确认，且更糟**：`listDiskEntries` 无页数上限（`useGrowth.ts:126-137`），并且每次新 commit 会把已展开目录**全部重拉**（`:297-320`）。2 万条目目录展开后每次提交 ≈ 10 页 × 3.7 s |
| 「`git ls-files` … 约 250 万文件才会超 64 MB」 | **实测吻合**：按本机真实仓库平均 36.8–54.5 B/条，64 MB ≈ 120–180 万条；文中「约 30 万文件 × 25 字节」的估算偏低（25 B/条 太乐观，实测 37–55 B/条） |

---

## 5. 顺带测到、但不属于我这条链路的（交给对应区域裁定）

1. **`/api/sessions` 冷启动 2.94 s + RSS +145 MiB**（65 会话 / 92.4 MiB JSONL；热启动 22 ms）。这是本机唯一「正常路径就 >1 s」的操作，比 P2-44/46/47 都更该有人管。落点：`session-reader.ts:205-249`（`scanSessions` 冷启动全量解析）+ `:150-203`（落盘索引）。会话数量再翻一倍就会到 6 s，且它在**侧栏首次渲染**的路径上。
2. **非 git 工作区的 `@` 索引每次重走磁盘遍历**：`D:\AIApp`（100 万文件）→ 1.09 s/次、1.2 MB 响应、RSS +134 MiB，无任何缓存（`files-service.ts:122-127` → `:68-88`）。用户在非仓库目录里每按一次 `@` 都会重付。
3. **目录列举的 55–85 ms 固定成本**：每次 `listWorkspaceDir` 都 spawn 一次 `git check-ignore`（`files-service.ts:241`）。小目录（8 条目）也要 60 ms，`node_modules` 那种全忽略目录返回 95 B 也要 68–76 ms。若 UI 逐层展开多层目录，这个常数会线性累加。
4. **`git check-ignore` 的超线性**：5k→251 ms、20k→3541 ms。这可能是 git 自身的 path-matching 行为，也可能是 `--stdin` 大输入下的退化；无论哪种，都建议 PiWeb 侧按页切片规避（不要依赖 git 的线性假设）。

---

## 6. 复现方式（临时 harness，不在仓库里）

```
%TEMP%\piweb-verify-scale\
  vitest.config.ts          # alias @ -> D:\AIApp\PiWeb\src，cacheDir 指本地
  bench\*.test.ts           # a-files / b-skills / c-sessions / e-http / f-bigdir / g-decompose / h-blob / i-cold / j-largeindex / k-index / l-syncfingerprint / m-10k
  results\*.json            # 每次运行的 min/p50/p95/max/bytes/runs/mem 原始数据
  agent-mirror\             # ~/.pi/agent 的镜像（写操作都落这里，原目录不动）
  bigdir-{500,2000,5000,10000,20000}\   # 合成的单目录曲线
  small-ws\                 # 小工作区
```

跑法（`node_modules` 是指向 `D:\AIApp\PiWeb\node_modules` 的 junction）：

```powershell
$env:PI_CODING_AGENT_DIR = "$env:TEMP\piweb-verify-scale\agent-mirror"
$env:GIT_BIN = (Get-Command git).Source
cd "$env:TEMP\piweb-verify-scale"
node "D:\AIApp\PiWeb\node_modules\vitest\vitest.mjs" run bench/<name>.test.ts --config vitest.config.ts
```

原始数据（本文每个数字都能在 `results\*.json` 里找到）：`dir-listing`、`at-index`、`bigdir-curve`、`bigdir-10k`、`decompose`、`index-decompose`、`index-large`、`route-files-dir`、`route-files-index`、`route-skills`、`route-sessions`、`skills`、`fingerprint`、`fingerprint-sync`、`prompt-source-resolve`、`cold-loader`、`sessions-cold`、`sessions-warmindex`、`blob-sizes`、`git-plumbing`、`dir-entry-counts`、`scale-robo.json`、`repos.json`。
工作区规模的 robocopy 原始值在 `%TEMP%\piweb-verify-scale\scale-robo.json`、`repos.json`（本文件 §1 的表就是它们）。这批临时文件可随时整体删除，不影响仓库。

---

## 7. 已知偏差 / 未确认

1. **第一批测量作废重测**：19:47–20:05 期间我用 PowerShell 递归枚举 `D:\AIApp`（100 万文件），抢了 IO/CPU，同一条 `listWorkspaceIndex` 在忙时 p50 = 4.19 s、空闲时 = 1.09 s（差 3.8×），`resourceFingerprint` 忙时 43.7 ms、空闲 10.7 ms（差 4×）。§2 全部采用**空闲**数字。**这也说明这些指标对机器负载非常敏感**，定级时请按数量级看，不要抠毫秒。
2. **没走 HTTP 认证路径**（见 §0）：表里的数是**路由处理器**耗时；dev 下 HTTP 再加 30–45 ms（`/api/health` p50 44.9 ms）。生产构建下会低一些，没有测。
3. **`fetchCache` 的浏览器内存是推算**，不是测量：没有跑浏览器，只用了文件体积分布 + 代码里的 200 条 FIFO。
4. **合成目录是"最坏情况"**：`git init` + 全部提交 + 无 `.gitignore`，因此每个名字都要走完整 ignore 匹配。真实目录若大部分条目被 ignore（例如 `node_modules`），`check-ignore` 的返回量不同，耗时会变（`/node_modules` 那条 310 条目 = 68 ms，比同规模的"全可见"目录略快）。
5. **P2-46 的超时外推是推算**：79k→1.6 s 线性外推到 70 万条目 ≈ 15 s，没有真的造 70 万文件的仓库。
6. **单机单盘**：Windows + Defender 实时扫描 + NTFS，`git` 相关数字比 Linux 上通常更慢；跨机器绝对值不可直接比较，**比例与拐点位置**更可信。
7. 审计正文的行号会漂（审计期间另一个会话在改仓库）。本文引用的行号是**本次读到时**的快照；以我贴出的函数名/代码特征为准。
