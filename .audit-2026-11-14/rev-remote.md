# 远程访问 / 认证静态审查

对象：工作区相对 `1d4efba9054909cd9c8b2788028ce704c99b03ea` 的未提交改动。只读源码，未跑测试、未改其他文件。

## 发现

### [HIGH] src/instrumentation-node.ts:40
**问题**：生产进程启动后默认对局域网和公网同时打开入口，无需再点一次连接。
**触发条件**：`NODE_ENV!==development`、`PI_WEB_AUTH` 不是 `0`、`PIWEB_REMOTE_LAN` 不是 `0/false/off/no`（三者都是默认）。`registerNode` 调用 `ensureRemoteAccess()`。
**期望行为**：公网隧道和 `0.0.0.0` 监听应是显式开启；默认只监听回环。
**实际行为**：`startLan` 默认 `host = "0.0.0.0"`（端口默认 30142）。局域网起来后立刻 `startPublic()`，`cloudflared tunnel --url http://127.0.0.1:<lanPort>`。设置页还会再 POST `{action:"connect"}`，但开机路径不依赖它。`remoteBlocked()` 只在没认证或开发模式时拦住这条路径，挡不住「认证开着的生产默认值」。
**证据**：`src/instrumentation-node.ts:26-40`；`src/lib/remote/supervisor.ts:187-190`、`256-261`、`390`、`402-418`、`531-547`。隧道主机名随后被写进 `PI_WEB_TRUSTED_HOSTS`（`supervisor.ts:201-213`）。`/api/health`、`/login`、`/pair`、`/api/web-auth` 在 `src/proxy.ts:10,32` 对未持会话的客户端开放，因此随机的 `*.trycloudflare.com` 一旦泄露就是互联网上的认证面。配对 URL 把一次性码放在该主机的 query 里（`src/app/api/remote/pair/route.ts:49`）。
**修复建议**：默认不要 `startPublic`，也不要绑 `0.0.0.0`；两者都改成显式开关。隧道未就绪时不要把配对码嵌进任何外部 URL。
**最小失败测试**：生产环境不设 `PIWEB_REMOTE_LAN`，启动后断言没有 `0.0.0.0:30142` 监听、也没有 cloudflared 子进程；只有显式开启后才出现。

### [HIGH] src/lib/web-auth.ts:145
**问题**：局域网入口是明文 HTTP，配对码和会话 Cookie 都可被同网观察者拿走。
**触发条件**：公网隧道尚未 `ready`（启动后 DNS 等待、cloudflared 缺失或探测失败）时，设置页用 `base:"lan"` 发码；或用户打开界面上复制出来的 `http://<lan-ip>:30142`。同二层网络可看流量（开放 Wi-Fi，或能做 ARP 欺骗的同一局域网）。
**期望行为**：能换到主人会话的凭据只走 TLS；Cookie 在非 HTTPS 上不发，或根本不提供明文源站。
**实际行为**：配对 URL 形如 `http://<ip>:30142/pair?code=<43 字符 base64url>`。`GET /pair` 不需要既有会话，验码成功就 `createSessionCookie`。`sessionCookieOptions` 里 `secure` 仅当请求 URL 已是 https，或 `X-Forwarded-Proto` 的第一段精确等于 `https`。直连局域网两者都不成立，Cookie 为 `httpOnly` + `SameSite=Strict` 但不是 `Secure`。之后该源站上的每个请求都带这张 Cookie。码在兑换前可重放；`verifyPairCode` 只在成功时删除。
**证据**：`src/components/RemoteSection.tsx:87-91,212`；`src/app/api/remote/pair/route.ts:39-49`；`src/app/pair/route.ts:21-42`；`src/lib/web-auth.ts:136-148`；`src/lib/remote/pairing.ts:97-105`。代理原样转发 `Host`（`src/lib/remote/mobile-proxy.ts:91`），所以 Cookie 绑的是局域网 `host:port`。未发现 `Access-Control-Allow-Origin`。`SameSite=Strict` 挡的是跨站浏览器请求，挡不住被动嗅探。
**修复建议**：没有 TLS 就不要发配对码，也不要在该源站种会话 Cookie。局域网只做跳转到已认证的 https 源站，或使用只在 TLS 上兑换的一次性码，并把码绑定到目标 authority。
**最小失败测试**：隧道未 ready 时 `POST /api/remote/pair` 得到的 `url` 不得以 `http://` 开头；对 `http://192.0.2.10:30142/pair?code=…` 的响应不得带非 Secure 的 `piweb_session_`。

### [HIGH] src/app/api/web-auth/route.ts:74
**问题**：`DELETE /api/web-auth?scope=all` 不使已发出的配对码失效。登出全部设备之后，码仍可换一张新会话。
**触发条件**：已登录客户端取到配对码（或屏幕上的二维码还在），随后调用全设备登出；在码的 120 秒 TTL 内，另一客户端 `GET /pair?code=…`。调用方不需要被登出的那张 Cookie。
**期望行为**：全设备登出应作废启动令牌和一切尚未兑换的配对码；之后只能用新的启动令牌进入。
**实际行为**：该分支只 `revokeAllSessions()` 和 `invalidateLaunchTokens()`。`notBefore` 只比较 Cookie 的 `issuedAt`。`/pair` 兑换时 `createSessionCookie(..., Date.now())`，新 Cookie 的签发时间晚于 cutoff，proxy 会接受。`pairing.ts` 没有吊销查询，也没有任何生产路径调用 `resetPairingState()`。码不绑定 authority，可在局域网源站或隧道源站兑换。
**证据**：`src/app/api/web-auth/route.ts:60-74`；`src/lib/remote/pairing.ts:16,84-105`；`src/app/pair/route.ts:24-42`；`src/proxy.ts:9-10,63`。进程内 `verifyPairCode` 在删除条目前没有 `await`，同一次成功不能兑换两次；这不覆盖「登出后第一次兑换」。
**修复建议**：`scope=all` 时清空 pending 配对码。兑换时拒绝 `issuedAt`（发码时间）早于 `notBefore` 的码，并把码绑到签发时的 authority。
**最小失败测试**：签发码 → `DELETE /api/web-auth?scope=all`（有效会话）→ 同一码 `GET /pair` 必须失败且不得 `Set-Cookie`。

### [HIGH] scripts/web-auth-protocol.mjs:50
**问题**：会话签发窗口是 30 天，HTTP 守卫只接受跨度 ≤ 7 天的 Cookie。当前签发的每一张合法会话都会在带 body 的请求上被守卫拒绝。
**触发条件**：认证开启，客户端持有 `createSessionCookie` 刚签发的 Cookie，对非公开路径发 POST/PUT/PATCH/DELETE，或带 `Content-Length`/`Transfer-Encoding` 的任何方法。局域网代理和主服务都会跑这道守卫。
**期望行为**：守卫与 `validSessionCookie` 使用同一最大寿命；合法会话可以通过守卫，过长寿命被拒绝。
**实际行为**：`src/lib/web-auth-shared.ts:16` 的 `SESSION_MAX_AGE_SECONDS` 是 `30 * 24 * 60 * 60`。`createSessionCookie` 用它计算 `expiresAt`（`src/lib/web-auth.ts:15,78-79`）。守卫调用的 `validCookieValue` 用的是协议模块里另一个常量 `7 * 24 * 60 * 60`（`scripts/web-auth-protocol.mjs:16,46-50`）。`2592000000 <= 604800000` 为假，函数返回 false，守卫回 401，且不把请求交给 Next（`scripts/http-request-guard.mjs:84-90,132-134`）。proxy 的 `validSessionCookie` 仍按 30 天放行，所以 GET（含文件下载）可以，写请求不行。这是失败关闭，不是提权。
**证据**：上述三个常量定义和两处校验。协议模块没有从 `web-auth-shared` 导入该常量。
**修复建议**：只保留一个最大寿命常量，守卫和签发都用它。补一条「刚签发的 Cookie 必须通过 `createRequestGuard`」的回归。
**最小失败测试**：用 `createSessionCookie` 的输出作为 Cookie，POST 一个 1 字节 body 到受保护路径，现状返回 401；把协议常量改成与 shared 相同后应进入处理函数。

### [MEDIUM] scripts/http-request-guard.mjs:23
**问题**：每个带 body 的非公开请求都在事件循环上同步读密钥文件和整份吊销表；公开路由虽免认证，但占用全局在途名额。默认公网隧道使两者都可从互联网打到。
**触发条件**：认证不是 `0`。未带有效 Cookie 的客户端对任意非公开路径发 POST（或带 body 的 GET）。或对 `/api/web-auth`、`/login`、`/pair` 并发慢 POST。
**期望行为**：未认证请求在读盘之前就拒绝；吊销表按 mtime 缓存；公开路由的慢请求不能占满全局写配额。
**实际行为**：`secretAndRevocations` 每次 `readFileSync` 密钥（环境变量未设置时）并 `readFileSync` + `JSON.parse` `web-revocations.json`（`22-31` 行），没有 `loadSessionRevocations` 那种 mtime 缓存。这条路径在 401 之前（`84-90` 行）。同一请求先打局域网代理上的 `createRequestGuard`，再打主端口上的 `installRequestGuard`，最多四次同步读。公开路由跳过认证（`81` 行），`Content-Length` 缺省时按 64KiB 预留，`inflightRequests >= 32` 时所有带 body 的请求回 503（`93-98` 行）。
**证据**：`scripts/http-request-guard.mjs:11-12,22-32,81-100`；对比 `src/lib/web-secret.ts:134-163` 的缓存。代理安装点 `src/lib/remote/supervisor.ts:439-441`。主服务安装点见覆盖节。
**修复建议**：守卫使用与应用相同的已缓存快照，未认证且不需要验 Cookie 的请求不要读盘。公开路由使用独立的在途计数。
**最小失败测试**：密钥文件打点计数；无 Cookie 的 POST 在返回 401 时计数不得增加。并行 32 个不结束的 `POST /api/web-auth` 不得让已认证的小 POST 收到 503。

### [MEDIUM] scripts/http-request-guard.mjs:115
**问题**：超限时 `req.emit` 返回 false，并不能停掉解析器，也不取消已经放行的处理函数；`end` 仍会送出。
**触发条件**：请求已通过 `admit`（公开路由，或 `PI_WEB_AUTH=0`，或 Cookie 跨度真的 ≤ 7 天），body 为 chunked 或实际字节超过 `content-length` 预检所用的上限。当前签发的 30 天 Cookie 到不了这里（见上一条 HIGH）。
**期望行为**：超过上限应立刻销毁请求并保证路由看不到 body、也不会把前缀当成完整 body 执行。
**实际行为**：包装器在 `received > limit` 时调用 `reject` 并 `return false`，不调用原始 `emit`，因此已注册的 `data` 监听者看不到超额那一块。它不 `pause`、不在当下 `destroy`。`reject` 只在响应 `finish` 之后 `req.socket.destroy()`（`53-60` 行）。`end` 不是 `data`，会落到 `emit.call`（`117` 行）。Next 的克隆器只监听 `data`/`end`（`node_modules/next/dist/server/body-streams.js:95-114`），超额前的字节加上 `end` 会被当成完整 body。返回值 false 不是 Node 流的背压信号。
**证据**：`scripts/http-request-guard.mjs:53-60,111-118`。`Content-Length` 大于上限时在读 body 之前就 413（`94-97` 行），这条缺口只涉及没有可用长度或长度被压在上限以内、实际块更大的请求。
**修复建议**：超限时 `req.destroy()` / `socket.destroy()`，不要再转发 `end`；处理函数必须在销毁后不可继续 `request.json()`。
**最小失败测试**：认证放行后发送 chunked：先一个完整小 JSON，再补块使总长超过 `maxBodyBytes`。断言路由没有执行该 JSON 的副作用，且连接在超额块处被重置。

### [MEDIUM] scripts/launcher.mjs:508
**问题**：启动令牌以明文出现在终端、浏览器将要打开的 URL，以及磁盘文件里。
**触发条件**：认证开启并启动。父进程 `console.log` 打印完整登录链接；子进程 `publishLaunchToken` 把当前令牌写入 `<agentDir>/web-launch/<port>.token`。浏览器打开 `/?token=`。令牌在被兑换或 5 分钟 TTL 到期前有效。
**期望行为**：令牌不进 stdout、不进浏览器历史；磁盘副本仅所有者可读，且与内存中的当前令牌一致。
**实际行为**：`scripts/launcher.mjs:503-508` 把 `tokenLoginUrl` 打到日志。`557` 行用文件/IPC 里的当前令牌再打开浏览器。`src/lib/web-launch-token.ts:171-174` 以 `writeFileSync(..., { mode: 0o600 })` 写明文，无临时文件替换。注释写明链接会进浏览器历史。兑换成功后 proxy 303 到去掉 query 的 `/` 并设 `referrer-policy: no-referrer`（`src/proxy.ts:81-89`），这不能保证历史里已经记下的 URL 被删除。未在 `localStorage`/`sessionStorage` 发现启动令牌或配对码；`src/lib/browser-storage.ts` 只是存储兜底，`RemoteSection` 把配对 URL 放在组件状态和二维码 data URL 里。
**证据**：上述行。熵是 `randomBytes(32).toString("base64url")`（`scripts/launcher.mjs:271`，`src/instrumentation-node.ts:16`），比较用 `timingSafeEqual`（`src/lib/web-launch-token.ts:65-69`）。用后轮换在 `consumeLaunchToken`（`40-43` 行）。
**修复建议**：不要把完整 URL 打到 stdout；用一次性本地跳转页或 IPC 把令牌交给浏览器，避免地址栏和历史。文件写入走 `wx` + 原子替换，并在 Windows 上设仅当前用户的 DACL。
**最小失败测试**：捕获启动器 stdout，断言不含 `token=`。启动后立刻读 `.token` 文件，在非所有者身份下必须 EACCES（Unix 与 Windows 各一次）。

### [MEDIUM] scripts/launcher.mjs:274
**问题**：帮助文本说非本机监听会强制打开认证；代码只在变量未设置时写上 `1`。显式 `PI_WEB_AUTH=0` 时主服务仍可绑非回环地址，且不装请求守卫。
**触发条件**：`PI_WEB_AUTH=0` 且 `piweb -H 0.0.0.0`（或 `::` / 局域网地址），生产构建。开发模式对非回环会拒绝（`launcher.mjs:254-255`）。
**期望行为**：非回环或存在公网 URL 时拒绝启动，或强制认证并安装守卫。帮助文本与实现一致。
**实际行为**：`createLaunchPlan` 仅当 `PI_WEB_AUTH` trim 后为空才设为 `1`（`274` 行）。`authenticationEnabled` 对 `0` 返回 false（`212-214` 行）。子进程照样 `-H 0.0.0.0`（`532` 行）。`next.config.ts:37-39` 在值为 `0` 时不要求守卫已安装。`remoteBlocked` 会跳过局域网代理和隧道（`supervisor.ts:187-188`），但不影响主监听。结果是整个 Next 应用在所有 IPv4 接口上无认证。帮助文本在 `426` 行。
**证据**：上述行。`src/proxy.ts:29` 在 `authEnabled()` 为 false 时直接 `NextResponse.next()`。`src/lib/web-auth.ts:47-49` 同样只把 `0` 当关闭。
**修复建议**：`!isLoopback(hostname) || publicUrl` 时若认证关闭则抛错，不要只打帮助说明。
**最小失败测试**：`PI_WEB_AUTH=0` 且 `-H 0.0.0.0` 时期望 `createLaunchPlan` 抛错；默认 `-H 127.0.0.1` 仍允许显式关闭。

### [QUESTION] src/lib/web-launch-token.ts:174
**问题**：`mode: 0o600` 在 Windows 上是否让其他本地用户读不到启动令牌、`web-secret` 和吊销表。
**触发条件**：无法从源码单独判定。Node 的 `mode` 在 Windows 上不实现「其他用户不可读」；实际 ACL 来自父目录继承。默认路径是 `%USERPROFILE%\.pi\agent`。本次没有读取该目录的 DACL，也没有创建命名管道去看默认 SDDL。
**期望行为**：仅当前用户（以及 SYSTEM）可读写这些文件；Windows 命名管道 `\\.\pipe\piweb-launch-*` 同样拒绝其他本地用户连接。
**实际行为**：Unix 上传了 `0o600`，并且非 Windows 才 `chmod` 套接字（`web-launch-token.ts:119`）。Windows 管道路径没有安全描述符参数（`scripts/web-auth-protocol.mjs:10-12`，`publishLocalRefreshServer`）。管道协议本身要求出示当前令牌才回令牌（`web-launch-token.ts:102-112`），因此即使管道可连，也不能凭空读出令牌。
**证据**：写入点 `web-secret.ts:73,171`、`web-devices.ts:32`、`web-launch-token.ts:174`。
**修复建议**：Windows 上创建后用显式 DACL 收紧文件和管道；不要依赖 `mode`。
**最小失败测试**：以第二个标准用户打开 `web-secret` 和 `web-launch\<port>.token`，以及连接对应命名管道，期望拒绝。

## 覆盖

- 守卫安装：`scripts/launcher.mjs:477-478` 设 `PIWEB_HTTP_GUARD=1`，并把 `--import` 该模块加进子进程 `NODE_OPTIONS`；子进程在 `532-533` 行以 `plan.env` 启动 Next。模块顶层 `scripts/http-request-guard.mjs:153` 在加载时 `installRequestGuard()`，早于 `http.Server` 接请求。`next.config.ts:37-39` 在开发/生产服务阶段、认证不是 `0`、且 `requestGuardInstalled(PORT ?? PIWEB_PORT)` 为假时直接抛错。局域网代理另外把 `createRequestGuard({ env: process.env })` 作为 `admitRequest`（`supervisor.ts:439-441`），其 `checkContinue` 在 `writeContinue` 之前调用（`mobile-proxy.ts:156-159`）。`installRequestGuard` 只钩 `address().port === PIWEB_PORT` 的服务器（`http-request-guard.mjs:126-134`），所以 30142 不靠预加载钩子，靠代理自己的 `admitRequest`。两条路径在放行后才把 body pipe 到上游。
- 启动令牌：32 字节 `base64url`；根路径单个 `token` 查询参数、仅 GET、用后轮换、TTL 5 分钟、全设备登出时 `invalidateLaunchTokens`。未见写入 `localStorage`。明文文件和 stdout 见 MEDIUM。
- 配对：32 字节、120 秒、成功路径同步删除，进程内不能双花。缺口是登出不清码，以及明文/隧道 URL 携带。`refreshPairCode` 会把现有码交给任一已登录调用方（`pairing.ts:84-94`）；该 POST 在 proxy 匹配器内，不是公开路径。
- 设备表：`web-devices.ts` 在 `withSettingsWriteLock` + `proper-lockfile`（`realpath: false`，文件可不存在）里读改写。表不参与鉴权，只用于列表和按 id 吊销。未见因此丢失吊销记录的路径。`slice(-200)` 会让更老的设备从界面消失，全设备登出仍靠 `notBefore`。
- 隧道路径：公网 → cloudflared → `127.0.0.1:lanPort` → `admitRequest` → 主服务守卫 → proxy。升级（WebSocket）代理没有 `upgrade` 监听，不会旁路转发。`remote-engine.mjs` 用 `isolatedCommandEnv`，不把 `PI_WEB_SECRET` / `PI_WEB_LAUNCH_TOKEN` 传给 cloudflared；会额外传 `PI_CODING_AGENT_DIR`。
- Host：守卫 `authorityFor` 与 `isSafeHost` 都接受 `localhost`、`*.localhost` 和任意 `net.isIP` 字面量，再加上两个环境变量里的精确主机名（`http-request-guard.mjs:41-50`，`src/lib/auth.ts:40-49`）。这挡住「攻击者域名解析到本机后仍带自己的 Host」。未发现用 Host 冒充去偷另一源站 Cookie 的路径：浏览器按 URL 主机存 Cookie，不按攻击者另写的 Host。
- 公开路由豁免：守卫和 proxy 都是精确路径 `/api/web-auth`、`/login`、`/pair`。`new URL(req.url, base).pathname` 会解析 `..` 和反斜杠；`/pair/../api/sessions` 得到 `/api/sessions`，不会被当成公开。绝对 URL 形式若 pathname 仍是公开路径，Next 也落到同一公开处理函数，没有把公开豁免套到私有路由上。公开 body 上限 64KiB。`/api/web-auth` 的 `scope=all` 和 `device` 在处理函数里再要有效会话。上传被排除出 proxy 匹配器（`src/proxy.ts:92-93`），但路由自身调用 `validSessionCookie`（`src/app/api/files/upload/route.ts:13-15`），且 POST 会进守卫。
- `Expect: 100-continue`：主服务的 `checkContinue` 在 `admit` 失败时不调用监听者，因此不 `writeContinue`。代理在 `admitRequest` 失败时 return，同样不发送 100。`checkExpectation` 回 417。静态路径与仓库里的回归意图一致；本次按约束未执行 `tests/http-request-guard.test.ts`。
- `PI_WEB_AUTH=0`：应用、launcher 和守卫都把 trim 后的 `0` 当作关闭。应用还会 `toLowerCase`，对 `"0"` 无差异。关闭后守卫不做 Cookie 校验，proxy 放行，但默认不会起局域网/隧道。非回环主监听见 MEDIUM。
- Cookie：`httpOnly`、`SameSite=Strict`、`path=/`，无 `Domain`，名字绑定 authority。无 CORS 响应头。跨站浏览器 POST 被 `sec-fetch-site` / `Origin` 与 SameSite 挡住（`http-request-guard.mjs:73-77`，`src/lib/auth.ts:7-17`）。同站不同主机（另一 `*.trycloudflare.com`）的 Origin 主机不相等，写请求仍拒绝。
- `Transfer-Encoding` 与 `Content-Length` 同时出现：守卫自己不拒绝，长度预检看 Content-Length。是否在进入守卫前就被解析器丢掉，见未追踪。

## 未追踪

1. 未在本机 Node 上发送同时带 `Transfer-Encoding` 与 `Content-Length` 的请求。`package.json` 要求 `node >= 22.19.0`；守卫代码本身不处理这种冲突。
2. 未读取 Windows 上 `%USERPROFILE%\.pi\agent` 的实际 DACL，也未探测 `\\.\pipe\piweb-launch-*` 的默认 SDDL。
3. 未逐个审范围外的 GET 路由是否改状态。proxy 对非公开 GET 要求 30 天会话；若存在改状态的 GET，嗅探到的 Cookie 可以调用它，而 7 天守卫管不到 GET。
4. 未取证 trycloudflare 子域熵，以及快速隧道主机名能否从证书透明度或 DNS 枚举。代码只接受 `https://[a-z0-9-]+.trycloudflare.com`。

## 维度结论

- 启动令牌熵足够（256 位），用后轮换，5 分钟 TTL，全设备登出会换新令牌。明文 stdout、浏览器 URL 和磁盘副本是暴露面，不是弱随机。
- 明文落盘：Unix `0600` 有写；Windows `mode` 不可作为访问控制证据（QUESTION）。
- 绑定 `0.0.0.0` 和公网隧道是生产默认值，不是只有用户传入 `-H 0.0.0.0` 才发生。
- 配对：进程内成功路径不能重放；全设备登出后可以第一次兑换。局域网明文可劫持。
- 设备表有锁，不构成鉴权绕过。
- 隧道数据面都经过 `admitRequest` 或主端口守卫；没有第二条无守卫的转发实现。
- 请求守卫：Host 字面量策略能挡住常见 DNS rebinding。`PI_WEB_AUTH=0` 是真豁免，并且会连主服务的非回环绑定一起放开。公开路径是精确匹配，64KiB，不是前缀。`100-continue` 在静态路径上先鉴权再决定是否 100。`emit` 返回 false 不能截断传输。CL/TE 冲突未实测。
- 令牌不进 localStorage。会进启动器 stdout 和浏览器地址。
- 局域网 CSRF：现代浏览器跨站写请求被 Origin/Sec-Fetch-Site 和 `SameSite=Strict` 拒绝；没有反射 CORS。明文嗅探不在 CSRF 模型里。
- Cookie：`httpOnly` + `Strict`；明文源站上不是 `Secure`。
- 公网默认暴露：会。
