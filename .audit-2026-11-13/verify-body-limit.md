# `proxyClientMaxBodySize` 的缓冲时机：在鉴权**之前**（verify-body-limit）

> 补审计报告**附录 C 第 4 条**与**附录 B #8**（P2-90 唯一未排除的 P0 可能）。
> 时间：2026-11-13 19:45–20:05。对象：`127.0.0.1:30141`，PID **21992**（`node .../next/dist/server/lib/start-server.js`，18:48:59 启动，`next start` 生产模式）。
> 边界：**未改**源码/配置，**未重启/杀**该进程，未 `git` 写；单次请求 ≤20MB、并发 1；临时探针放 `%TEMP%\piweb-verify-body\`，跑完已删；每批探测后都验 `/api/health` 仍 200。

## 0. 结论

**缓冲发生在 `src/proxy.ts` 的鉴权判断之前，而且 401 要等整个请求体收完才发。**

- Next 在**调用 `proxy()` 之前**就 `cloneBodyStream()`，把请求体逐块 push 进内存（上限 = `proxyClientMaxBodySize` = 272MB）；`proxy()` 读不读 body 都无所谓 —— `src/proxy.ts` 一个 body API 都没调。
- `proxyClientMaxBodySize` **不是拒绝阈值**：超限只截断 + `console.warn`，没有 413；272MB 以内全部留在内存里。
- 实测：20MB 未认证 POST → 上传 123ms、401 在上传结束后 2ms 才到；只发 header 不发 body 时，401 被扣住 **8s 仍 0 字节**（`/api/health`、`/login` 都是），而**不经过 proxy** 的 `/_next/...` 1.8s 就回了 404。
- 20MB body 的 RSS 平台：**+17.1MB / +18.6MB**（两次干净测量），2MB 对照 **+0.0MB**；把 Next 的 `getCloneableBody` 原样搬到独立进程复现：20MB → **+21.2MB 常驻**，4MB → +4.3MB，线性。

**定级：P2-90 升 P0**（新增 **P0-3「未认证请求在鉴权前缓冲 272MB」**）。理由与可直接替换的文本见 §5。

---

## 1. 静态证据（先定位，后实测）

### 1.1 配置：`"272mb"` 在构建期被归一化成 285,212,672 字节

`next.config.ts:53`：

```ts
experimental: { proxyClientMaxBodySize: "272mb" },
```

`node_modules/next/dist/server/config.js:685-701`（`bytes.parse` 归一化，字符串 → 数字）：

```js
// Normalize & validate experimental.proxyClientMaxBodySize
if (typeof result.experimental?.proxyClientMaxBodySize !== 'undefined') {
    const proxyClientMaxBodySize = result.experimental.proxyClientMaxBodySize;
    if (typeof proxyClientMaxBodySize === 'string') {
        normalizedValue = bytes.parse(proxyClientMaxBodySize);
    } else if (typeof proxyClientMaxBodySize === 'number') {
        normalizedValue = proxyClientMaxBodySize;
    }
    ...
    result.experimental.proxyClientMaxBodySize = normalizedValue;
}
```

默认值是 10MB，不是 272MB —— `config-shared.js:289`：

```js
proxyClientMaxBodySize: 10485760,
```

运行产物的 `required-server-files.json` 里已烘死为数字（两个候选产物都一样，见 §1.7）：

```
config.experimental.proxyClientMaxBodySize = 285212672   // 272MB
```

### 1.2 每个请求进来先建一个 `clonableBody`（此时还没判断是否命中 middleware）

`node_modules/next/dist/server/lib/router-utils/resolve-routes.js:124-127`：

```js
if (!isUpgradeReq) {
    const bodySizeLimit = config.experimental.proxyClientMaxBodySize;
    addRequestMeta(req, 'clonableBody', getCloneableBody(req, bodySizeLimit));
}
```

### 1.3 **先 `cloneBodyStream()`，再调 `proxy()`**；proxy 返回后才 `finalize()`

`node_modules/next/dist/server/next-server.js:1215-1235`（Node middleware 分支，本实例走的就是这条，见 §1.6）：

```js
const hasRequestBody = !['HEAD', 'GET'].includes(params.request.method) && Boolean(requestData.body);
try {
    result = await adapterFn({
        handler: middlewareModule.proxy || middlewareModule.middleware || middlewareModule,
        request: {
            ...requestData,
            body: hasRequestBody ? requestData.body.cloneBodyStream() : undefined,   // ← 1227：先 clone
        },
        page: 'middleware'
    });
} finally {
    if (hasRequestBody) {
        await requestData.body.finalize();                                           // ← 1233：proxy 返回后才 finalize
    }
}
```

`node_modules/next/dist/server/web/adapter.js:160-171` 把 p1 塞进 `NextRequest`，`adapter.js:303` 才真正调用 handler：

```js
const request = new NextRequestHint({ ..., init: { body: params.request.body, ... } });  // 160-171
...
return await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, params.handler, request, event));  // 303
```

**顺序是死的**：`cloneBodyStream()` → 构造 Request → `params.handler`（即 `proxy()`）→ `finally finalize()`。也就是说鉴权**必然发生**在 body 缓冲启动之后。

> 更精确的表述（避免过度声称）：`proxy()` 的鉴权**判断**仍然很早执行（`src/proxy.ts` 是同步函数，几毫秒内就构造好 401 Response），但 (a) 它执行时 body 已经在往 `p1`/`p2` 里灌；(b) 这个 401 要等 `finalize()` 的 `await endPromise` 之后才会写到 socket 上。所以"鉴权在前"只在"判断算得快"这一层成立，在"**能否阻止内存被占用 / 客户端能否尽早被拒**"这一层完全不成立。安全上要的是后者。

### 1.4 clone 的实现：无条件 `data` 监听 + 两块流；上限只"截断"不"拒绝"

`node_modules/next/dist/server/body-streams.js:52-118`（节选，行号即文件行号）：

```js
52: function getCloneableBody(readable, sizeLimit) {
53:     let buffered = null;
54:     const endPromise = new Promise((resolve, reject)=>{
55:         readable.on('end', resolve);
56:         readable.on('error', reject);
57:     })...
67:     async finalize () {
68:             if (buffered) {
69:                 const res = await endPromise;          // ← 等整个请求体 'end'
...
80:     cloneBodyStream () {
81:             const input = buffered ?? readable;
82:             const p1 = new PassThrough();
...
89:             const p2 = new Readable({ read () {} });
92:             let bytesRead = 0;
93:             const bodySizeLimit = sizeLimit ?? DEFAULT_BODY_CLONE_SIZE_LIMIT;   // 默认 10MB
94:             let limitExceeded = false;
95:             input.on('data', (chunk)=>{
96:                 if (limitExceeded) return;
97:                 bytesRead += chunk.length;
98:                 if (bytesRead > bodySizeLimit) {
99:                     limitExceeded = true;
100:                     ... console.warn(`Request body exceeded ...`);
103:                     p1.push(null);
104:                     p2.push(null);
105:                     return;                              // ← 超限后只丢弃剩余字节，不销毁连接、不报错
106:                 }
107:                 p1.push(chunk);
108:                 p2.push(chunk);                          // ← 同一 chunk 对象进两条流：一份内存
109:             });
...
116:             buffered = p2;
117:             return p1;
118:         }
```

关键点三条：

1. **`input.on('data')` 一挂上，请求流就进入 flowing 模式**，body 被无条件读出并留在 `p1`/`p2` 里——和 proxy 有没有读 body 无关（`src/proxy.ts` 确实没读，§1.6）。
2. `finalize()` 第一件事是 `await endPromise`，而 `endPromise` 在 `getCloneableBody()` 创建时（§1.2，早于 proxy）就绑了 `'end'` —— **整个 body 收完之前，中间件响应发不出去**。
3. 超限不是 413：`p1.push(null)` 之后剩余字节"读到就丢"，客户端仍会看到正常响应。官方文档明说这一点。

### 1.5 官方文档原文（与代码一致）

`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md:7-9`：

> When proxy is used, Next.js automatically clones the request body and buffers it in memory to enable multiple reads ... this configuration option sets a size limit on the buffered body.

同文件 `:71-76`：

> 1. Next.js will buffer only the first N bytes (up to the limit) ... 3. The request will continue processing normally, but only the partial body will be available 4. The request will **not** fail or return an error to the client

### 1.6 本实例确实走 Node middleware 分支，且 `proxy.ts` 完全不读 body

- `src/proxy.ts` 全文 grep `\.body|\.text\(\)|\.json\(\)|arrayBuffer|formData|Content-Length`：**0 命中**。鉴权只读 `Host`/`Origin`/`Cookie`/URL/`method`。
- matcher（`src/proxy.ts:86`）：`["/((?!_next/|_piweb-dev/|icon\\.svg|favicon\\.ico).*)"]` —— 除这 4 个前缀外**全部**命中，`src/app/api/**` 共 **34** 个 `route.ts` 全在覆盖内。
- 构建产物 `…/server/functions-config-manifest.json` 里 `"/_middleware": { "runtime": "nodejs", "matchers": [...] }`（matcher 与源码一致），而 `…/server/middleware-manifest.json` 是空的 `{"middleware":{},"functions":{},"sortedMiddleware":[]}` → 不存在 edge middleware → `runMiddleware` 走 `next-server.js:1208-1235` 的 **Node 分支**（`loadNodeMiddleware()` 加载 `server/middleware.js`，其中含 `untrusted host` / `authentication required` 字符串，即编译后的 `proxy.ts`）。
- 全链路**没有任何 413 / `content-length` 预检**：在 `next-server.js`、`router-server.js`、`resolve-routes.js`、`body-streams.js` 里 grep `413|content-length|maxBodySize|requestTimeout`，除 `next-server.js:409`（过滤响应头）外没有命中；`proxyClientMaxBodySize` 在**请求路径上**只在两处被读：`resolve-routes.js:125`（建 clone）和 `next-server.js:1312`（attachRequestMeta）。

### 1.7 跑的是哪份产物（不影响结论，但写清楚）

`scripts/build-output.mjs:selectProductionBuild` 优先用 `.next-releases/active.json`；它是 `state:"ready"`、`buildDir:".next-releases/mweslqtb-0ad8d701-78c0-483d-a970-3bcbdb792000"`（17:52 完成），进程 18:48:59 启动 → 用该 release。**两个候选产物的配置一致**：`.next/required-server-files.json` 与 `.next-releases/mweslqtb-…/required-server-files.json` 的 `proxyClientMaxBodySize` 都是 `285212672`，`functions-config-manifest.json` 都含 `/_middleware` runtime=nodejs。

---

## 2. 实测（只读/小规模，并发 1）

### 2.1 方法

| 探针 | 做法 |
|---|---|
| 20MB POST | `HttpWebRequest`，`AllowWriteStreamBuffering=false`，`ContentLength=20MB`，64KB 一块直写 |
| headers-only | 裸 `TcpClient`：只发请求头（`Content-Length: 20971520`），**一个 body 字节都不发**，然后阻塞读最多 8s |
| 慢传 | 裸 `TcpClient`：声明 2MB，先发 1MB，停 2s 读（看会不会先回 401），再发剩余 1MB |
| hold | 裸 `TcpClient`：声明 20MB，先发 19.87MB，**停 3s**（此时 body 未完成、响应未发），期间 10ms 采样 RSS；再发最后 128KB 收响应 |
| RSS | C# `Process.Refresh()` + `WorkingSet64`/`PrivateMemorySize64`，10ms 一次（约 30ms 实际间隔） |

每批之间 `GET /api/health` 确认 200。总流量约 100MB，单次 ≤20MB，未并发。

### 2.2 决定性证据①：body 不发完，401 就不发（8s 仍 0 字节）

| 请求（headers-only，CL=20MB，实际 body=0） | 结果 |
|---|---|
| `POST /api/health` | **8.0s 内 0 字节**，读超时；无任何响应 |
| `POST /login` | **8.0s 内 0 字节**，读超时 |
| `POST /` | 2.5s 内 0 字节（同型） |
| `POST /api/nonexistent-verify` | 2.5s 内 0 字节（同型） |
| **对照：`POST /_next/nonexistent-verify.bin`** | **1.81s 回 `HTTP/1.1 404`，9,689 字节** |

`/_next/` 被 matcher 排除 → 没有 clone → 不需要 body 就能响应；凡是经过 proxy 的路径，**响应被 body 卡住**。这正是 `finalize()` 里 `await endPromise`（§1.4 第 2 点）的行为。

### 2.3 决定性证据②：2MB 的慢传同样被卡

`POST /api/health`，声明 2MB、先发 1MB 后停 2s：

```json
{"firstPartSent":1048576,"earlyResponseBytes":0,"earlyResponseAfterMs":2003,
 "firstLineAfterFullBody":"HTTP/1.1 401 Unautho","fullBodyToResponseMs":17}
```

**2s 内 0 字节**；补上最后 1MB 后 **17ms** 就拿到 401。=> 401 不是"算得慢"，是**在等 body**。

### 2.4 20MB 未认证 POST：上传 123ms，401 在上传结束后 2ms

| 请求 | body | 状态 | 上传耗时 | 响应相对上传结束 | base WS | 峰值 ΔWS |
|---|---|---|---|---|---|---|
| `POST /api/health` | 20MB | **401** | 123ms | **+2ms** | 2262.3MB | +6.9MB |
| `POST /api/definitely-missing-xyz` | 20MB | **401**（不是 404 —— proxy 先拦） | 104ms | +6ms | 2242.7MB | +29.8MB |
| `POST /_next/nonexistent-verify.bin`（对照，不走 proxy） | 20MB | 404 | **24,081ms（回压）** | +11ms | 2247.0MB | +13.2MB |

对照行的 24s 不是"慢"：§2.2 已证 404 根本不需要 body（1.8s 就回），所以这 24s 是服务端**不读 body**、客户端被 socket 回压卡住（0.83MB/s）；而经过 proxy 的路径 123ms 就把 20MB 收完了（≈160MB/s）—— 说明 proxy 路径在**主动把 body 读进内存**。

### 2.5 RSS：20MB body ≈ +17~19MB 平台；2MB ≈ 0

先量噪声（进程本身很忙，这对读数很关键）：

| 空闲窗口 | WS 范围 | Private 范围 |
|---|---|---|
| 6s | 1620.1–1662.5（Δ42.4MB） | 2687.3–2813.5（Δ126.2MB） |
| 12s | 1638.6–1711.6（Δ73.0MB） | 2696.2–2767.7（Δ71.5MB） |
| 8s | 1717.1–1734.9（Δ17.8MB） | 2656.3–2965.9（Δ309.6MB） |

hold 测试（声明 20MB，先发 19.87MB 停 3s，期间采样；`pre` = 上传前中位数，`hold` = 停住那 3s 的中位数）：

| # | body | pre WS | hold WS | **Δ WS** | 峰值 Δ | 响应后 4s Δ | 备注 |
|---|---|---|---|---|---|---|---|
| 1 | 19.87MB | 2044.0 | 1681.3 | −362.7 | +32.0 | −386.9 | 期间进程自己掉了 ~400MB，作废 |
| 2 | 19.87MB | 1731.3 | 1737.5 | +6.2 | +10.6 | +12.8 | 被空闲堆复用掩盖 |
| 3 | 19.87MB | 2233.0 | 2251.7 | **+18.6** | **+24.6** | +19.3 | 干净 |
| 4 | **2.00MB** | 2233.8 | 2233.8 | **0.0** | +2.8 | +5.2 | **同尺寸对照** |
| 5 | 19.87MB | 2224.5 | 2228.0 | +3.5 | +4.8 | −6.7 | 被掩盖 |
| 6 | 19.87MB | 1754.6 | 1771.8 | **+17.1** | +17.3 | **+17.3** | 复现 |

读法：

- **干净时 20MB body → +17.1 / +18.6MB 常驻**（≈ 1:1），2MB 对照 +0.0MB；响应发出 4s 后仍 +17~19MB（还没被 GC 收回）。
- 中途出现的 +3.5 / +6.2MB 不是"没缓冲"：该进程 WS 常驻 1.7–2.2GB，且测试期间刚释放过 ~400MB（表里第 1 行那次 −400MB），20MB 的 64KB chunk 直接复用了已驻留的空闲页，WorkingSet 自然不涨。**读数的方差来自分配器复用，不来自机制**。
- 因此补了一个干净进程的复现（§2.6），它给出无噪声的定量。

### 2.6 把 Next 的 `getCloneableBody` 原样搬到独立进程：20MB → +21.2MB

用 `node_modules/next/dist/server/body-streams.js` 里 `getCloneableBody()` 的**逐行拷贝**（含同样的 272MB limit、同样"proxy 不读 body"），喂 20MB/4MB 请求体，跑在同一 Node（`B:\Node.js\node.exe`）：

| body | limit | RSS Δ | external Δ | `p1.readableLength`（proxy 侧未读的量） |
|---|---|---|---|---|
| 20MB | 272MB | **+21.2MB** | +20.0MB | **20.0MB** |
| 4MB | 272MB | +4.3MB | +4.0MB | 4.0MB |
| 20MB | 10MB（默认值） | +18.7MB | +17.5MB | 10.0MB（+ 超限部分瞬时分配） |

结论：**常驻内存 ≈ body 大小（p1/p2 共享同一 chunk 对象，不是两份）**，线性；limit 只决定"留多少"。

### 2.7 服务健康

探测前后：`GET /api/health` → 200 `{"success":true,...}`；`GET /login` → 200；进程仍在，PID 21992，70 线程，StartTime 18:48:59；结束采样时 WS 2223MB / Private 3696MB / PeakWS 2480MB。**未观察到异常或重启**。

机器现状（定级相关）：物理内存 **15.8GB**，探测期间采样到**可用最低 1.0GB**；服务常驻已 ~1.7–2.2GB WS / 3.4–3.7GB private。

---

## 3. 按代码逻辑推演 272MB（不需要真发 272MB）

1. **单请求常驻上限 = min(body, 272MB) ≈ 272MB**（§1.4 第 3 点 + §2.6 线性）。是**一份**内存（p1、p2 引用同一 chunk），外加每请求少量 chunk 头开销。
2. **没有 413、没有提前断开**：272MB 以内全留在内存；超过 272MB 的部分"读到丢"（仍要收完才会走到 `finalize` 的 `end`），客户端照样拿到 401。所以"发超了会被拒"是错觉。
3. **持有时间由客户端控制**：从第一个字节开始，直到请求流 `end`（`finalize` 前的 `await endPromise`）且对象被 GC。攻击者可以慢慢传，Node 默认 `server.requestTimeout` 300s 内一直持有（Next 只覆盖了 `keepAliveTimeout`，见 `start-server.js:233-235`，没有 `requestTimeout`）。
4. **并发无全局上限**：文档写明"limit applies per-request, not globally across all concurrent requests"。N 条连接 = N × 272MB。
5. **可行性**：20MB 上传在回环 123ms 完成；272MB 在 100Mbps 链路上约 22s。10 条并行连接 ≈ **2.7GB** 常驻，而本机现在可用内存只有 1GB、服务自己已占 ~3.4GB private → **OOM / 长时间换页 / 服务假死**是可复现结果。
6. **与鉴权开关无关**：`proxy.ts` 不读 body，所以 `PI_WEB_AUTH=1/0` 都一样缓冲；差别只是最后回 401 还是继续往下走。也就是说 P2-93 的 fail-open 场景同样吃这一发。
7. **可达性前提**：默认监听 `127.0.0.1`（本实例 netstat 只有回环）；`-H/--hostname` 可开 LAN，remote/隧道功能可暴露到公网。攻击面 = "能连到该端口的任何人/进程"，因此对 LAN/隧道部署是**远程未认证**。

---

## 4. 定级与修法建议

### 4.1 定级：P0（原 P2-90 升格，新增 P0-3）

- 它是**未认证**可达的（鉴权恰恰是被延迟/旁路的那个环节），不依赖任何用户操作、不依赖配置错误（默认 `PI_WEB_AUTH=1` 也成立），只依赖"端口可达"。
- 后果是**整进程不可用**（含正在跑的 agent 会话），且可反复触发；不需要 RCE、不需要读文件。
- 唯一缓冲是 272MB 这个 cap —— 但它只限制"每条连接吃多少"，不限制"吃不吃"，也不拒绝。
- 若某部署严格只监听回环且无隧道，可降为 P1；但审计报告面向的是"默认安装 + 可能开的远程/移动端"，按 P0 记更合适。

### 4.2 修法（按"能不能真正拦住"排序）

1. **把 `proxyClientMaxBodySize` 压回实际需要的量级**（如 `12mb`）——立刻把单请求上限从 272MB 降到 12MB。注意：这是缓解，不是根治（缓冲仍在鉴权前）。
2. **唯一能"在鉴权前就拒"的位置是 Next 之前**：在 `scripts/launcher.mjs` / 移动端代理那一跳做 `Content-Length` 预检（超限直接 413 + 断开）。`src/proxy.ts` 里加检查**没用**——clone 已经发生，且 `finalize` 会等 body 结束，攻击者不配合就一直占着。
3. **大 body 通道移出 matcher**：图片粘贴（268MB base64）是唯一需要大 body 的功能（`next.config.ts:53` 的注释）。把上传端点放到 matcher 排除的前缀下（如 `/upload/…`，或复用 `_piweb-dev/` 之外的专用前缀），在该 route 里自己做会话校验 + 流式处理，这样走不到 clone。代价：该路由必须自己认证。
4. **前端改成压缩/分片**（图片先压到几 MB、或分片上传），配合 (1) 之后就不需要 272MB 了。
5. 顺手补一个**统一 413 包装**（route 侧 `req.json()` 前判 `Content-Length`），至少让"超过自身上限"的路由明确拒绝而不是静默截断 —— 但这条**不解决**鉴权前缓冲。

---

## 5. 可直接替换审计报告的文本

### 5.1 替换「附录 B #8」整行

```md
| 8 | ~~P2-90 的缓冲时机（唯一未排除的 P0 可能）~~ **已实测，见 `.audit-2026-11-13/verify-body-limit.md`** | 已完成：20MB 未认证 POST + headers-only（只发头不发 body）+ 2MB/20MB hold 期间 RSS 采样；未发 300MB，按代码线性推演 | **缓冲在鉴权之前 → 升 P0（新增 P0-3）**。证据：只发 header 不发 body 时 `/api/health`、`/login` 8s 内 0 字节；发完 body 后 2ms 出 401；20MB body 的 WS 平台 +17.1/+18.6MB（2MB 对照 +0.0MB）；`/_next/` 这类不走 proxy 的路径 1.8s 就回 404。本行可删除 |
```

### 5.2 替换「附录 C 第 4 条」

```md
4. **`proxyClientMaxBodySize: 272mb` 的缓冲时机已实测，不再是未知项**：缓冲发生在 `proxy()` **之前**（`next-server.js:1227` 先 `cloneBodyStream()` 再调 handler；`body-streams.js:95-109` 无条件把 body push 进内存），且 401 要等整个 body 收完才发（`body-streams.js:67-76` 的 `await endPromise`）。未认证请求即可让进程为每个请求持有 ≤272MB，无 413、无全局上限。实测与定级见 `.audit-2026-11-13/verify-body-limit.md`，结论并入 **P0-3**（原 P2-90 升格）。
```

### 5.3 新增 P0 条目（放 §2 P0 清单，编号按现有顺延为 P0-3）

```md
### P0-3 未认证请求的 272MB body 在鉴权前被完整缓冲：远程内存耗尽（api-auth / launcher-build）

- **现象**：任何能连到 PiWeb 端口的人，对任意 matcher 覆盖的路径（34 个 `/api/**` 路由 + 全部页面路径）POST 一个大 body，Next 会在调用 `src/proxy.ts` **之前**就 `cloneBodyStream()`，把 body 逐块读进内存（上限 272MB），并且 **401 要等整个 body 收完才发出**。`proxyClientMaxBodySize` 不是拒绝阈值：超限只截断 + `console.warn`，没有 413；272MB 以内全留在内存。
- **证据**：
  - 顺序：`next-server.js:1227`（先 clone）→ `adapter.js:303`（才调 handler）→ `next-server.js:1233`（finally finalize，且 `body-streams.js:69` 先 `await endPromise`）。
  - 实测：20MB 未认证 POST → 上传 123ms、401 在上传结束后 2ms；只发 header 不发 body 时 8s 内 0 字节（`/api/health`、`/login`）；同一时刻 `/_next/` 的 404 只要 1.8s。
  - 内存：20MB hold（停 3s）WS 平台 **+18.6MB / +17.1MB**（两次），2MB 对照 **+0.0MB**；`getCloneableBody` 原样复现 20MB → **+21.2MB** 常驻，线性。
  - 无上限：文档明说 per-request；本实例可用内存仅 1GB 时服务已占 ~3.4GB private。
- **修法**：① `proxyClientMaxBodySize` 压回 `12mb` 量级；② 超限拒绝只能在 Next 之前做（launcher/mobile-proxy 的 `Content-Length` 预检 + 直接断开），`proxy.ts` 里加检查无效；③ 图片/大上传端点移出 matcher，route 内自校验 + 流式处理；④ 前端压缩/分片。
- **定级理由**：未认证可达、默认配置即成立、后果是整进程不可用（连带正在跑的会话）；不是"需要用户配合"的边角。
```

### 5.4 替换 P2-90 那一行（保留历史线索，指向 P0-3）

```md
| ~~P2-90~~ **→ P0-3** | `experimental.proxyClientMaxBodySize: "272mb"` 是全局的，且**缓冲发生在鉴权之前**（已实测）；34 个路由里只有 2 个有自身上限，超限只静默截断 | `next.config.ts:53`、`next-server.js:1227`、`body-streams.js:95-109` | api-auth |
```

### 5.5 「0.4 定级调整与合并」表可加一行

```md
| **升 P0** | api-auth 原 P2-90（272MB body 缓冲时机） | 实测确认缓冲在鉴权之前、401 被 body 阻塞：未认证即可占满内存，见 `verify-body-limit.md` |
```

### 5.6 「本报告的严重度计数」表要把 P0 从 2 改成 3

```md
| **P0** | **3** | 两条「权限档承诺不成立」+ 一条「未认证请求在鉴权前缓冲 272MB」 |
```

---

## 6. 局限与没做的事

1. **没有真发 272MB**（>20MB 属压力型请求，超出本次授权）。单请求上限的结论来自：20MB 实测线性 + `getCloneableBody` 原样复现 + 代码里 `sizeLimit` 直接来自配置。若 lead 要"一次 272MB 拍死"的现场，那是一次受控压测，需要单独批准。
2. **RSS 读数受进程自身活动干扰严重**：同一进程在测试期间自己掉了 ~400MB、Private 在 2.6–3.9GB 之间摆，空闲窗口 WS 波动 18–73MB。§2.5 的 +3.5~+6.2MB 与 +17.1~+18.6MB 都是真的，差异来自空闲堆复用；**结论不依赖单次 RSS**，决定性证据是 §2.2/§2.3 的时序（0 字节 vs 2ms）和 §1 的调用顺序。
3. **没测 edge runtime**：本构建是 Node middleware（`middleware-manifest.json` 为空），edge 路径（`sandbox.js:94` 同样先 clone）未实测，但代码顺序相同。
4. **没测 HTTP/2 / TLS**：走的是明文 HTTP/1.1 回环。
5. **没有把临时探针留档**（按要求删了）；§7 给了最小复现步骤。
6. 行号以 2026-11-13 20:00 的 `node_modules/next@16.4.5` 为准；升级 Next 后 `body-streams.js` 的实现要重看。

---

## 7. 最小复现（PowerShell，10 行级别）

**A. 只发头不发 body → 401 永远不来（8s），对照 `/_next/` 秒回 404**

```powershell
$c = New-Object Net.Sockets.TcpClient('127.0.0.1', 30141); $s = $c.GetStream()
$h = "POST /api/health HTTP/1.1`r`nHost: 127.0.0.1:30141`r`nContent-Type: application/octet-stream`r`nContent-Length: 20971520`r`nConnection: close`r`n`r`n"
$b = [Text.Encoding]::ASCII.GetBytes($h); $s.Write($b,0,$b.Length); $s.Flush()
$s.ReadTimeout = 8000; $buf = New-Object byte[] 4096
try { $n = $s.Read($buf,0,4096); "bytes=$n" } catch { "timeout after 8s, bytes=0" }   # → 0
# 换成 /_next/nonexistent.bin 则立刻读到 404
$c.Close()
```

**B. 20MB POST 与 RSS 采样（并发 1）**

```powershell
$p = Get-Process -Id 21992
$fs = [IO.File]::Create("$env:TEMP\20mb.bin"); $fs.SetLength(20MB); $fs.Close()
$job = Start-Job { $pp = Get-Process -Id 21992; 1..400 | % { $pp.Refresh(); [pscustomobject]@{t=$_;ws=$pp.WorkingSet64}; Start-Sleep -ms 25 } }
curl.exe -s -o NUL -w "%{http_code}`n" -X POST --data-binary "@$env:TEMP\20mb.bin" -H "Content-Type: application/octet-stream" http://127.0.0.1:30141/api/health
$job | Wait-Job | Receive-Job | Measure-Object ws -Minimum -Maximum   # 峰值 − 基线 ≈ body 大小
```

**C. 独立复现 Next 的缓冲**（把 `body-streams.js:52-118` 的 `getCloneableBody` 原样拷出，喂一个 20MB 的 Readable，不读 p1，4s 后看 `process.memoryUsage()` / `p1.readableLength`）→ 实测 `rss +21.2MB`、`p1.readableLength = 20MB`。
