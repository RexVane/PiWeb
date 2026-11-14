# 远程访问 / 隧道 / 配对 / 代理 审计报告

审计对象：`D:\AIApp\PiWeb`，按当前磁盘状态（HEAD `1d4efba` + 144 项未提交改动）。
本报告只读产出；未修改任何源码、未启停隧道、未改系统代理。

## 0. 覆盖范围

**在范围内的源码（全部读完）**

- `src/lib/remote/supervisor.ts` 623
- `src/lib/remote/mobile-proxy.ts` 155
- `src/lib/remote/pairing.ts` 127
- `src/lib/remote/tunnel-health.ts` 63
- `src/app/api/remote/route.ts` 87
- `src/app/api/remote/pair/route.ts` 55
- `src/app/pair/route.ts` 40
- `src/components/RemoteSection.tsx` 186
- `src/components/ProxySettings.tsx` 64
- `src/lib/proxy-status.ts` 90
- `src/app/api/proxy/route.ts` 22
- `scripts/system-proxy.mjs` 48

**为判断"公网暴露时鉴权是否真的生效"而顺链路读的依赖（只读，结论归各自区域，交叉点见 §3）**

`src/proxy.ts` 87、`src/lib/auth.ts` 59、`src/lib/web-auth.ts` 170、`src/lib/web-auth-shared.ts` 39、
`src/lib/web-secret.ts`（会话吊销部分 100–197）、`src/instrumentation-node.ts` 46、`src/app/api/health/route.ts` 7、
`src/app/api/web-auth/route.ts` 76、`src/app/api/files/route.ts`（上传分支 38–49）、`next.config.ts` 55、
`scripts/launcher.mjs`（`createLaunchPlan`/`applyProxyEnv`/启动与信号处理段）、`README.md` 远程段、`README_zh.md` 128–181、
`docs/planning/technical-design.md` §20。

**测试（全部读完）**：`tests/remote-auto-connect.test.ts` 181、`remote-pair.test.ts` 106、`remote-proxy.test.ts` 203、
`remote-startup.test.ts` 61、`remote-supervisor.test.ts` 257、`remote-tunnel.integration.test.ts` 159、
`tests/integration/remote/tunnel-status.test.ts` 186、`tests/lib/pairing.test.ts` 72、
`tests/components/remote-section.test.tsx` 163、`tests/components/proxy-settings.test.tsx` 90、
`tests/proxy-status.test.ts` 70、`tests/proxy-route.test.ts` 29、`tests/system-proxy.test.ts` 66、`tests/upload-proxy.test.ts` 62。
（`tests/proxy-auth.test.ts` 284 属 API/鉴权 区域，只 grep 引用，未计入结论。）

**跳过**：`src/lib/remote/assets.json`（内联的手机排版 CSS/JS 资源，只确认 `mobile-proxy.ts` 如何取用）；
`node_modules/@earendil-works/*`（pi 内核，按 BRIEF 不审）；Next 内部 body 克隆实现（只按 `next.config.ts:53` 的配置值引用，见 §3）。

**本机现场（只读查询，未动服务）**：30141 由 `node ...next/dist/server/lib/start-server.js` 占用；
30142 无监听、无 `cloudflared` 进程 —— 与"开发模式下 `remoteBlocked()==="dev"`，两个入口都不开"一致（未确认该实例的 `NODE_ENV`，故只作观察）。

### 结论一览

| 子功能 | 结论 | 依据文件 |
|---|---|---|
| 局域网入口（绑 0.0.0.0:30142、注入模式/纯转发切换、关闭后释放端口） | OK-但脆弱（P2-6 竞态；P2-4 明文） | `supervisor.ts`、`mobile-proxy.ts` |
| 手机排版注入代理（HTML 注入、SSE 流式、上传流式、上游断开级联） | OK（P3-5 头部细节） | `mobile-proxy.ts`、`tests/remote-proxy.test.ts` |
| cloudflared quick tunnel 启动（参数、抓地址、45s 超时、失败提示） | OK-但脆弱（P3-2 引擎判定） | `supervisor.ts`、`tests/remote-auto-connect.test.ts` |
| 隧道健康探测（`/api/health` 内容校验、1033、验证页、16KiB 上限、停止时取消） | OK | `tunnel-health.ts`、`tests/integration/remote/tunnel-status.test.ts` |
| 隧道进程生命周期（开关不叠加、退出码上报、崩溃后重建） | 有问题（P2-1：**进程退出**无清理；其余路径处理得比较细） | `supervisor.ts`、`scripts/launcher.mjs` |
| 公网暴露时的鉴权（启动令牌、HMAC 会话 Cookie、Host/Origin、隧道域名白名单） | OK（未找到绕过；但默认就暴露，见 P2-3/P2-4） | `proxy.ts`、`auth.ts`、`web-auth.ts`、`supervisor.ts` |
| 配对码（256bit、120s、一次性、发放/兑换双限流、复用） | OK-但脆弱（P2-2 限流维度是进程级全局） | `pairing.ts`、`tests/lib/pairing.test.ts` |
| 设备撤销 / 远程与本地权限差异 | 有问题（P2-3：无单设备撤销，配对=30 天主人权限） | `RemoteSection.tsx`、`web-secret.ts`、`web-auth-shared.ts` |
| 远程控制 API（GET/POST/DELETE 的闸门重复校验） | OK（`set-plugin` 曾绕过认证的问题已修，有回归测试） | `api/remote/route.ts`、`tests/remote-supervisor.test.ts` |
| 错误状态呈现（1033 / 引擎缺失 / 局域网失败） | 有问题（P1-1：局域网侧的错误与地址完全没呈现） | `RemoteSection.tsx` |
| 系统代理探测与设置（是否改用户全局代理） | OK（只 `reg query` 读，不写）+ P3-3 阻塞式探测 | `scripts/system-proxy.mjs`、`proxy-status.ts` |
| 代理连通性测试 API | OK（不发挑战、只测固定 URL、解析出错误码） | `api/proxy/route.ts`、`tests/proxy-status.test.ts` |

---

## 1. 发现

### P1-1 局域网入口起不来时设置页静默失败：界面永远"启动中…/正在准备二维码…"，错误只进 console.warn

- **位置**：`src/lib/remote/supervisor.ts:404-410`（早退）、`src/lib/remote/supervisor.ts:438-442`（错误只记在 `lanError`）、`src/components/RemoteSection.tsx:169-174`（只渲染 `public.*`）
- **证据**：

```ts
// supervisor.ts:404-410  —— 局域网没起来就直接返回，publicError 根本不会被赋值
	const generation = current.generation;
	await startLan();
	if (generation !== current.generation) {
		await stopLan();
		return remoteStatus();
	}
	if (!current.lan) return remoteStatus();
```

```ts
// supervisor.ts:438-442  —— 唯一记录 lanError 的地方
	} catch (error) {
		current.lanError = error instanceof Error ? error.message : String(error);
		server.close();
		return remoteStatus().lan;
	}
```

```ts
// supervisor.ts:492-496  —— 把 lan.error 抬成 UI 可见的 publicError 的代码只在 startPublic 里
	const lan = remoteStatus().lan;
	if (!lan.running || lan.port === null) {
		current.publicError = lan.error ?? "局域网入口没能启动，公网入口无从转发";
		return remoteStatus().public;
	}
```

`startPublic()` 只在 `ensureRemoteAccess` 的 `if (!current.lan) return` **之后**才会被调用，所以自动路径下这一段永远走不到。

```tsx
// RemoteSection.tsx:169-174  —— 界面只看 public.error；lan.error / lan.urls 全文件未被引用
		{status && !blocked ? <div className="flex items-center gap-2" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }}>
			<Dot ready={publicReady} />{publicReady ? t.remoteConnected : status.public.error ? t.remoteUnavailable : t.remoteWorking}
		</div> : null}
		{status?.public.error && !publicReady && !blocked ? <p role="status" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
			{status.public.engineAvailable ? status.public.error : t.remoteEngineMissing}
		</p> : null}
```

- **触发路径**：生产模式 + `PI_WEB_AUTH=1` 启动 → `instrumentation-node.ts:40` 调 `ensureRemoteAccess()` → 30142 已被占用（同一台机器跑第二个 PiWeb 实例、或别的程序占了 30142）→ `listenLan` EADDRINUSE → `current.lanError = "listen EADDRINUSE: address already in use 0.0.0.0:30142"` → `ensureRemoteAccess` 在第 410 行返回 → 打开 设置→远程连接 → `RemoteSection` 每 3 秒 `GET /api/remote`，`public.error` 恒为 `null`。
- **后果**：界面停在 `remoteWorking`（"启动中…"）+ 二维码占位卡（"正在准备连接二维码…"），永远没有原因、没有"重试"按钮（`RemoteSection.tsx:147` 的重试按钮只在 `error` 状态非空时出现）。数据其实一直在 `GET /api/remote` 的响应体里（`lan.error`），前端就是不显示。后端口令每 30 秒重试一次（`REMOTE_RETRY_MS`），把问题永久藏起来。`instrumentation-node.ts:44` 只是 `console.warn`，用户只会看面板。
- **置信度**：已确认（读了 `listenLan` → `ensureRemoteAccess` → `RemoteSection` 完整链路；本机无法复现端口占用，但代码路径唯一）。验证方法：占住 30142（`node -e "require('net').createServer().listen(30142)"`），生产模式启动 PiWeb，打开远程设置看是否为"启动中…"且无错误文案。
- **建议修法**：最小改动 —— `RemoteSection` 增加对 `status.lan.error` 的渲染（与 `public.error` 同一条 `<p>` 即可），并在 `ensureRemoteAccess` 的早退分支里把 `startLan()` 的返回值写进 `current.publicError`，让旧的呈现路径也能显示。

### P1-2 没有 cloudflared（或隧道长期不可用）时手机完全连不上：局域网入口在跑，但界面上没有地址、也不发局域网码

- **位置**：`src/components/RemoteSection.tsx:83-86`、`src/app/api/remote/pair/route.ts:36-45`、`README_zh.md:144-146`
- **证据**：

```tsx
// RemoteSection.tsx:83-86 —— 只有公网就绪才去要码；否则什么都不做
				const publicReady = next.public.running && next.public.ready && Boolean(next.public.url);
				if (next.blocked) { stopPolling = true; setPair(null); return; }
				if (!publicReady) { setPair(null); return; }
				const data = await request("/api/remote/pair", { previousCode: pairRef.current?.code }) as PairData;
```

```ts
// api/remote/pair/route.ts:36-45
	const status = remoteStatus();
	const publicReady = status.public.running && status.public.ready && Boolean(status.public.url);
	const selected = base;
	const origin = selected === "public" ? (publicReady ? status.public.url : null) : (status.lan.running ? status.lan.urls[0] ?? null : null);
	if (!origin) {
		return NextResponse.json(
			{ success: false, error: selected === "public" ? "public entry is not ready yet" : "lan entry is not running" },
			{ status: 409, headers: NO_STORE },
		);
	}
```

```markdown
<!-- README_zh.md:144-145 —— 文档承诺"面板里列出的地址" -->
**局域网入口（默认开启）** —— 一个只做手机适配的反向代理，绑 `0.0.0.0:30142`。
同一个 WiFi 下的设备直接打开面板里列出的地址即可，拿到的是适配过手机的页面；
```

`grep` 结果：`status.lan.urls` 在 `src/` 内只被 `instrumentation-node.ts:42`（终端日志）和 `api/remote/pair/route.ts:39`（base=lan 分支）使用，**任何 UI 都没渲染过**。

- **触发路径**：没装 cloudflared（最常见的默认情况：它不随 PiWeb 安装）→ `spawn` ENOENT → `markEngineMissing()` + `publicError = "找不到 cloudflared：请先安装它（…）"`；或在中国大陆/trycloudflare 被阻断的网络下长期 1033 → `ready` 永远 false。两种情况下 `publicReady === false`。
- **后果**：面板显示"找不到 cloudflared"（这条提示是对的）和"连接暂不可用，正在重试…"，但**局域网入口其实是好的**（`startLan` 成功了），而用户既看不到 `http://192.168.x.x:30142` 这个地址，也没有局域网配对码可用。手机侧唯一出路是自己在手机上敲地址、再回终端抄启动令牌。`tests/components/remote-section.test.tsx:120-130` 还把"没有公网就不显示二维码"固化成断言，等于把这条降级路径锁死。
- **置信度**：已确认（读了组件、路由、`remoteStatus()` 与测试）。
- **建议修法**：`publicReady === false && status.lan.running` 时渲染 `status.lan.urls` 列表（点击复制），并向 `/api/remote/pair` 传 `base: "lan"` 取局域网码 —— 服务端这条路径已经实现且被 `tests/remote-pair.test.ts:43-45` 覆盖，只需前端接上。

### P2-1 进程退出时不清理 cloudflared：Windows 不级联杀子进程，崩溃/硬杀/服务包装器退出后会留下仍连着 Cloudflare 的隧道进程

- **位置**：`src/lib/remote/supervisor.ts:505-509`（spawn）、`src/lib/remote/supervisor.ts:585-605`（只有显式 `stopPublic()` 才 kill）、`src/` 全域无退出钩子
- **证据**：

```ts
// supervisor.ts:505-509  —— 直接 spawn，未 detached，也没有任何 process 级清理钩子
	const child = spawn(binary, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${lan.port}`], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
```

```ts
// supervisor.ts:598-603  —— 唯一杀进程的地方，只由 stopAll/stopPublic/健康检查停滞触发
	await new Promise<void>((resolve) => {
		tunnel.child.once("exit", () => resolve());
		tunnel.child.kill();
		setTimeout(resolve, 3_000).unref();
	});
```

`grep` `process\.on\(.?(SIGINT|SIGTERM|exit|SIGHUP)|beforeExit` 在 `src/` 下**零命中**；`scripts/launcher.mjs:531-540` 只把 SIGINT/SIGTERM 转发给 next-server 那一个子进程（`child.kill("SIGINT")`），不涉及孙进程。

- **触发路径**：`piweb` 正常运行 → cloudflared 已连上 trycloudflare → 任一路径让 next-server 进程消失而没走 `stopAll()`：任务管理器结束 node.exe、进程崩溃（未捕获异常）、将来任何 `process.exit()`/自更新重启路径、Windows 服务包装器停止。控制台 Ctrl+C 恰好能穿透（同一 console 的 CTRL_C_EVENT 会同时打到 cloudflared），但这不是代码保证的，只是平台副作用。
- **后果**：cloudflared 成为孤儿，继续维持那条 quick tunnel；30142 已随父进程释放，于是旧域名对所有拿到过链接的人返回 502/1033，直到有人手动结束进程。下次启动会再 spawn 一个，`Get-Process cloudflared` 会叠加；旧的 trycloudflare 域名再也无人回收（主机名白名单只在进程内存里，进程没了就没了，但 Cloudflare 侧连接仍在）。
- **置信度**：已确认（缺清理钩子是代码事实；Windows 父子进程不级联终止是平台语义）。**现场残留未观测到**（本机当前没有 cloudflared 进程），验证方法：`PIWEB_CLOUDFLARED=<真 cloudflared>` 生产模式启动 → 等 `remoteStatus().public.ready` → 用任务管理器结束 node.exe → `Get-Process cloudflared` 应仍在，`netstat -ano | findstr <其 PID>` 应仍有到 Cloudflare 的连接。
- **建议修法**：`spawnTunnel` 里 spawn 之后注册一次 `process.once("exit", () => { try { child.kill(); } catch {} })`（外加 `SIGINT`/`SIGTERM` 各一次，退出前 `await stopAll()`）；或至少提供 `stopAll` 给启动器的退出路径调用。

### P2-2 `/pair` 是公开路径而失败限流是进程级全局计数：匿名流量刷 30 次/分钟即可锁死合法扫码

- **位置**：`src/lib/remote/pairing.ts:104-113`、`src/proxy.ts:9`（`/pair` 在 `PUBLIC_PATHS`）
- **证据**：

```ts
// pairing.ts:107-113
	if (entry) pending.delete(code);
	purge(now);
	if (failedAt.length >= VERIFY_LIMIT) {
		return { ok: false, reason: "rate-limited", retryAfterSeconds: Math.max(1, Math.ceil((failedAt[0] + VERIFY_WINDOW_MS - now) / 1000)) };
	}
	failedAt.push(now);
	return { ok: false, reason: entry ? "expired" : "unknown" };
```

`VERIFY_LIMIT = 30`、`VERIFY_WINDOW_MS = 60_000`，`failedAt` 是模块级数组，**不按 IP、不按码**分桶，也不区分"猜码"和"过期码"。

- **触发路径**：任何能访问公网地址（或局域网入口）的人对 `/pair?code=xxxx` 连发 30 个 GET。`/pair` 不需要认证（扫码设备必须有这个免认证入口），因此不需要任何凭据。
- **后果**：此后 60 秒内**所有人**的扫码兑换都返回 429（`src/app/pair/route.ts:25-29`），界面显示"配对重试中"。攻击者持续刷就能让"添加新设备"永久失败；合法用户遇到自己的二维码过期点两次，也会自己把通道锁住一分钟。密码学强度本身没问题（256bit、一次性、120s，`tests/lib/pairing.test.ts:65-71` 证明了这一点），坏的是限流维度。
- **置信度**：已确认（代码 + 现有测试就是按全局 30 次写的）。
- **建议修法**：`failedAt` 改成按来源（`x-forwarded-for` 首跳 / 直连 socket 地址）分桶，并给"格式合法但不存在的码"单独一个更严的桶；全局桶只用于兜底（例如 300 次/分钟），不要把全局桶的拒绝返回给合法码。

### P2-3 默认就公网暴露 + 配对一次得到 30 天主人权限 + 没有单设备撤销

- **位置**：`src/lib/remote/supervisor.ts:395-420`（默认自动起隧道）、`src/lib/web-auth-shared.ts:11`（`SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60`）、`src/components/RemoteSection.tsx:117-128`（只有"让所有设备重新登录"）
- **证据**：

```ts
// supervisor.ts:396-415 —— 生产 + 有认证就自动开局域网并自动起公网隧道，没有单独开关
export async function ensureRemoteAccess(): Promise<RemoteStatus> {
	if (remoteBlocked() !== null || !remoteLanEnabled()) return remoteStatus();
```
```ts
// supervisor.ts:410-415（第 398–409 行省略：自动重试 interval 与 generation 检查）
	if (!current.lan) return remoteStatus();
	if (!current.tunnel && !current.publicStarting && Date.now() >= (current.publicRetryAt ?? 0)) {
		current.publicRetryAt = Date.now() + REMOTE_RETRY_MS;
		// 安装好引擎后无需重启 PiWeb；下一次重试重新查找。
		if (!current.enginePath) current.engineChecked = false;
		void startPublic().catch((error) => { current.publicError = String(error?.message ?? error); });
```

```ts
// web-auth-shared.ts:11
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
```

```tsx
// RemoteSection.tsx:121 —— 唯一能"撤设备"的手段是全体失效
			const response = await fetch("/api/web-auth?scope=all", { method: "DELETE" });
```

`grep` `revokeSessionCookie` 只出现在 `src/app/api/web-auth/route.ts:62`（撤当前这台），没有任何"列出/撤销某一台"的能力；`RemoteSection` 也不显示已连接设备数。

- **触发路径**：任何一次正常 `piweb` 启动（启动器默认 `PI_WEB_AUTH=1`）→ 30 秒内公网出现一条 `https://<随机>.trycloudflare.com`；扫一次码 → 新设备拿到一张 30 天有效的 HMAC 会话 Cookie，权限与主机本地浏览器**完全一致**（同一 `createSessionCookie`、同一 `validSessionCookie`，没有任何角色/来源区分，见 `src/proxy.ts:54-55`）。
- **后果**：① 用户没有"只要局域网、不要公网"的选项（`PIWEB_REMOTE_LAN=0` 会把两个入口一起关掉），机器的公网可达性成了一条隐式默认；② 手机丢了/卖掉了，唯一处置是"所有设备重新登录"（连主人自己的桌面浏览器也要重新开令牌链接）；③ 二维码在设置页是**常驻有效**的（面板每 3 秒轮询保持一个有效码），投屏/录屏/旁人拍照后 120 秒内就能永久拿到主人权限，主机侧没有任何"新设备已连接"的确认或通知。
- **置信度**：已确认（都是代码事实与既定设计；风险判断见下）。
- **建议修法**：给公网入口一个独立开关（例如 `PIWEB_REMOTE_PUBLIC=0`，与 LAN 开关解耦）；`web-revocations.json` 已有按 Cookie 指纹吊销的能力（`web-secret.ts:183-189`），补一个"已连接会话"列表 + 单条撤销（把 `sessionCookieId` 与 `issuedAt`/`authority` 暴露给设置页即可）；配对成功时在主机侧记一条可撤销记录。

### P2-4 局域网入口是明文 HTTP，而配对得到的会话 Cookie 在局域网权威下不带 `Secure`、有效期 30 天

- **位置**：`src/lib/remote/supervisor.ts:383`（`0.0.0.0` 明文监听）、`src/lib/web-auth.ts:153-166`（`secure` 由请求协议决定）、`README_zh.md:129`（自己警告"远程访问不要用裸 HTTP"）
- **证据**：

```ts
// supervisor.ts:383
export function startLan(port = remoteLanPort(), host = "0.0.0.0", targetPort = piwebPort()): Promise<LanState> {
```

```ts
// web-auth.ts:153-166
export function isSecureRequest(request: Request): boolean {
	if (new URL(request.url).protocol === "https:") return true;
	return (request.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

export function sessionCookieOptions(request: Request) {
	return {
		httpOnly: true,
		sameSite: "strict" as const,
		secure: isSecureRequest(request),
		path: "/",
		maxAge: SESSION_MAX_AGE_SECONDS,
	};
}
```

- **触发路径**：手机走 `http://192.168.x.x:30142/pair?code=…` 配对（`base=lan` 分支）→ 权威是 `192.168.x.x:30142`、协议 http → Cookie 不带 `Secure`，30 天有效。
- **后果**：同一个 WiFi 下（咖啡馆、共享办公室、宿舍）任何能嗅探/ARP 欺骗的人拿到这张 Cookie 就等于拿到主人权限 30 天，且**不能单设备撤销**（见 P2-3），只能全体失效。文档在"认证"一节明确说远程访问不要裸 HTTP，但内置的局域网入口本身默认就是裸 HTTP——两者自相矛盾。
- **置信度**：已确认（代码）；实际风险取决于所在网络，属"设计未交代"。
- **建议修法**：至少把局域网入口的会话缩短（例如 LAN 权威签发的 Cookie 用 1 天），或在设置页明确标注"局域网入口是明文 HTTP，仅在可信网络使用"；真正的修法是给 30142 加自签 TLS 或只在公网入口签发会话。

### P2-5 `README_zh.md` 与实现相反：写着"公网入口默认关闭 / 在设置里开关"，实际是默认开启且设置页没有任何开关

- **位置**：`README_zh.md:140`、`README_zh.md:148`、`README_zh.md:176`
- **证据**：

```markdown
<!-- README_zh.md:140 -->
PiWeb 自带一个内置插件负责这件事，在**设置 → 远程连接**里开关，客户端不用装任何东西。
<!-- README_zh.md:148 -->
**公网入口（默认关闭）** —— 打开后 PiWeb 会拉起一条 Cloudflare 快速隧道（`cloudflared`），
```

```tsx
// RemoteSection.tsx 全文件没有任何 switch/开关；tests/components/remote-section.test.tsx:55-58 明确断言
		expect(screen.queryByRole("switch")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("button", { name: "开启远程连接" })).toBeNull();
		expect(screen.queryByRole("button", { name: "生成二维码" })).toBeNull();
```

英文 `README.md` 已经改成新行为（"Production startup automatically prepares the local proxy (`0.0.0.0:30142`) and a Cloudflare quick tunnel"），中文版没跟上。

- **触发路径**：中文用户读完文档认为"我没开，所以没暴露"，实际每次启动都会拉起公网隧道（前提是装了 cloudflared、认证开着、非开发模式）。
- **后果**：用户对自身暴露面的判断是错的 —— 这直接放大了 P2-3/P2-4 的风险。`README_zh.md:176` 也只提 `PIWEB_REMOTE_LAN=0` 能关局域网，用户会以为公网另有开关。
- **置信度**：已确认（文档与代码/测试三方对照）。
- **建议修法**：改中文文档为"两个入口都随生产启动自动准备；`PIWEB_REMOTE_LAN=0` 一起关掉"，并在实现里补 P2-3 建议的公网独立开关后写进文档。

### P2-6 `stopLan()` 不等正在进行的 `startLan()`：`stop-lan`/`DELETE` 返回成功后端口仍可能被绑上并继续服务

- **位置**：`src/lib/remote/supervisor.ts:447-454`（`stopLan`）对比 `383-392`（`startLan` 用 `lanStarting` 去重）
- **证据**：

```ts
// supervisor.ts:447-454 —— 只看 current.lan，不看 current.lanStarting
export async function stopLan(): Promise<void> {
	const current = state();
	const lan = current.lan;
	current.lan = null;
	if (!lan) return;
	lan.server.closeAllConnections?.();
	await new Promise<void>((resolve) => lan.server.close(() => resolve()));
}
```

```ts
// supervisor.ts:383-392 —— 启动中只挂 lanStarting，current.lan 仍为 null
export function startLan(port = remoteLanPort(), host = "0.0.0.0", targetPort = piwebPort()): Promise<LanState> {
	const current = state();
	if (current.lan) return Promise.resolve(remoteStatus().lan);
	if (current.lanStarting) return current.lanStarting;
	const starting = listenLan(port, host, targetPort).finally(() => {
		if (current.lanStarting === starting) current.lanStarting = null;
	});
```

- **触发路径**：`POST {action:"start-lan"}`（或 `DELETE`）与另一次启动并发 —— 两次 HTTP 请求、或 `set-plugin`（`api/remote/route.ts:73` 先 `stopLan()` 再 `startLan()`）与另一个 `start-lan` 交叉。`stopLan` 在 `listenLan` 还没 set 好 `current.lan` 时直接返回，随后 `listenLan` 成功，`current.lan = { server, port, styled }` 落地。
- **后果**：`stop-lan`/`DELETE` 返回 `{lan:{running:false}}`，但监听在下一毫秒被建立并持续对外服务（直到下一次 `stop`）。`POST /api/remote` 的 DELETE 语义是"全停"，这时它撒谎了。目前没有 UI 触发点（只有脚本/自建管理面板会调），所以影响面小，但这是"关闭远程后是否真断开"的直接反例。
- **置信度**：已确认（代码）；可用两次并发 `fetch` 复现。
- **建议修法**：`stopLan` 里先 `const starting = current.lanStarting; current.lanStarting = null;` 并 `await starting?.catch(() => {})`，然后照旧关 `current.lan`（`ensureRemoteAccess` 的 `generation` 检查已经是这个思路，只是没覆盖外部直接调 `startLan` 的路径）。

### P3-1 设置页的"打开"链接指向 `/pair?code=…`：点一下就把二维码里的一次性码用掉，还顺手给桌面浏览器种了一张公网权威的会话 Cookie

- **位置**：`src/components/RemoteSection.tsx:165`
- **证据**：

```tsx
				<a href={visiblePair.url} target="_blank" rel="noreferrer" className="hover:underline" style={{ fontSize: 12 }}>{t.pairOpen}</a>
```

- **触发路径**：主人好奇点"打开"→ 新标签打开 `https://<隧道>/pair?code=…` → `src/app/pair/route.ts` 兑换成功、303 到 `/`，码作废。
- **后果**：屏幕上正在展示的那个二维码/复制链接随即失效（下一个 3 秒轮询才换新码），这段时间里手机扫码会看到 `/login?pair=unknown`；同时桌面浏览器多了一张公网隧道权威的会话 Cookie（同一台机器，风险不大，但属于无意义的凭据扩散）。
- **置信度**：已确认（代码 + `verifyPairCode` 的一次性语义）。
- **建议修法**：这个链接应指向 `new URL(visiblePair.url).origin`（只看入口通不通），或者干脆去掉。

### P3-2 "引擎可用"的判定只是"字符串非空"：`engineAvailable` 在首次 spawn 失败前恒为 true，且 PATH 上的 `.cmd` 垫片在 Windows 上会 spawn 失败并显示原始系统错误

- **位置**：`src/lib/remote/supervisor.ts:320-339`、`src/lib/remote/supervisor.ts:300-303`、`src/lib/remote/supervisor.ts:551-561`
- **证据**：

```ts
// supervisor.ts:320-330 —— 找不到就返回裸名，让 spawn 去报错
function resolveTunnelEngine(): string {
	const explicit = process.env.PIWEB_CLOUDFLARED?.trim();
	if (explicit) return explicit;
	const managed = managedEnginePath();
	try {
		if (fs.existsSync(managed)) return managed;
	} catch {
		/* 读不了就当没有 */
	}
	return "cloudflared";
}
```

```ts
// supervisor.ts:302 —— engineChecked 一旦为 true，enginePath 非 null 就叫"可用"
			engineAvailable: current.engineChecked ? current.enginePath !== null : true,
```

```ts
// supervisor.ts:554-559 —— 只有 ENOENT 才翻译成安装提示
			if (error.code === "ENOENT") {
				markEngineMissing();
				current.publicError = "找不到 cloudflared：请先安装它（…）";
			} else {
				current.publicError = error.message;
			}
```

- **触发路径**：`npm i -g cloudflared` 这类安装把 `cloudflared.cmd`/`.ps1` 垫片放进 PATH（Windows 上 Node `spawn` 直接执行 `.cmd` 会失败，`shell: true` 才可执行）；或 `PIWEB_CLOUDFLARED` 指向一个脚本/错误架构的 exe。
- **后果**：`engineAvailable` 先报 true（面板显示"启动失败"+ 原始错误码，而不是"请安装 cloudflared"这个可操作提示）；`tests/remote-supervisor.test.ts:219-222` 的 `expect(tunnelEngine()).toBeTruthy()` 只验证了返回非空字符串，把这层语义固化成了"可用"。
- **置信度**：疑似（Node 在 Windows 上不能直接 spawn `.cmd` 是确定的；具体某台机器的安装方式未验证）。验证方法：在 Windows 上把 PATH 指向一个 `cloudflared.cmd`，看 `public.error` 是否为 `EINVAL/UNKNOWN` 而不是安装提示。
- **建议修法**：`resolveTunnelEngine` 用 `fs.accessSync(p, fs.constants.X_OK)` / 检查扩展名来做一次真正的可用性判断；非 ENOENT 的 spawn 错误也给出"引擎无法执行，请用 PIWEB_CLOUDFLARED 指向 cloudflared.exe"。

### P3-3 `/api/proxy` 在请求路径里同步起 `reg.exe`（最长阻塞事件循环 1.5s），且非 Windows 平台永远识别不到系统代理

- **位置**：`src/lib/proxy-status.ts:25-33`、`src/lib/proxy-status.ts:48-61`、`scripts/system-proxy.mjs:40-48`
- **证据**：

```ts
// proxy-status.ts:25 —— automaticProxy 的默认参数就地跑 readSystemProxy()
export function automaticProxy(env: Record<string, string | undefined> = process.env, system = readSystemProxy()): ProxyChoice {
```

```js
// system-proxy.mjs:40-47 —— execFileSync（同步），timeout 1500ms
export function readSystemProxy({ platform = process.platform, run = execFileSync } = {}) {
	if (platform !== "win32") return null;
```

- **触发路径**：打开 设置→通用（`ProxySettings` 挂载即 `GET /api/proxy`）；每次点"测试连接"再走一次（`POST` 里 `automaticProxy()` 又跑一遍），并额外 spawn 一个 Node 子进程做代理探测（`probeThroughProxy`，最长 10s）。
- **后果**：Windows 上每次调用同步阻塞事件循环（`reg.exe` 起进程 ~20–50ms，最坏 1.5s），期间该进程内所有请求（含 SSE 流、agent 执行）都被挡住；macOS/Linux 下 `readSystemProxy` 恒返回 `null`，面板永远显示"未检测到代理"，用户看不出真实原因（`source: "none"`）。并发点"测试连接"没有服务端并发上限，每次一个 Node 子进程。
- **置信度**：已确认（代码）；阻塞时长随机器。
- **建议修法**：`readSystemProxy` 改成异步/结果带 TTL 缓存（例如 30s），或至少在 `GET /api/proxy` 里缓存；非 Windows 返回"不支持系统代理探测"这个明确状态而不是 `null`。

### P3-4 `stopPublic()` 用 `.unref()` 的 3 秒兜底计时器 `await` 子进程退出：进程杀不掉且事件循环空闲时这个 await 可能永不返回

- **位置**：`src/lib/remote/supervisor.ts:598-603`
- **证据**：见 P2-1 的第二段代码（`setTimeout(resolve, 3_000).unref()`）。
- **触发路径**：cloudflared 不响应 `kill()`（权限/挂起），且此时进程没有其它活动句柄（例如正要关闭）。
- **后果**：`DELETE /api/remote` 的 handler 挂住不返回，客户端 15s 超时（`RemoteSection.tsx:54`）后显示"操作失败"；`stopAll()` 也卡住。日常 Ctrl+C 场景里 Next 的事件循环仍活着，timer 会触发，所以危害有限。
- **置信度**：疑似（未构造出真正的"事件循环全空"场景）。
- **建议修法**：去掉 `.unref()`，或改成 `Promise.race([exitPromise, delay(3000)])` 的普通 timer。

### P3-5 mobile-proxy 的转发细节：逐跳头原样透传、空 body 的 304 也会被注入、HTML 缓冲无上限

- **位置**：`src/lib/remote/mobile-proxy.ts:89`、`src/lib/remote/mobile-proxy.ts:105-136`
- **证据**：

```ts
// mobile-proxy.ts:89 —— 连 connection/transfer-encoding 一起转给上游
		const headers: http.OutgoingHttpHeaders = { ...req.headers };
```

```ts
// mobile-proxy.ts:112-113 与 126-135（中间是注入/降级逻辑，省略）
			up.on("end", () => {
				const raw = Buffer.concat(chunks);
				…
				outHeaders["content-length"] = String(out.byteLength);
				outHeaders["cache-control"] = "no-store";
				res.writeHead(up.statusCode ?? 200, outHeaders);
				res.end(out);
```

- **触发路径**：客户端带 `Connection: keep-alive`/`Transfer-Encoding` 等逐跳头（合规实现应剥掉）；或请求一个 `304`/`204` 但 `content-type: text/html` 的响应；或上游返回一个很大的 HTML。
- **后果**：逐跳头透传在 `keepAlive` agent 下可能让上游提前关连接（目前未见症状）；304 场景会给空 body 写 `content-length: <注入长度>`（`injectAssets("")` 会把样式/脚本整个前置），理论上违反"304 无 body"，浏览器一般忽略但这是畸形响应；HTML 分支没有大小上限，`Buffer.concat` 全量进内存（PiWeb 自己的页面都很小，风险低）。
- **置信度**：304 分支已确认（代码路径），逐跳头为规范性意见。
- **建议修法**：转发前删掉 `connection`/`keep-alive`/`transfer-encoding`/`te`/`upgrade`；注入分支跳过 `statusCode` 为 304/204 或 `method === "HEAD"` 的情况；给 HTML 缓冲加一个上限（例如 8MiB）超限即原样流式返回。

### P3-6 `resetRemoteSupervisor()`（测试用）直接丢弃状态：不关监听、不杀子进程、不摘 Host 白名单

- **位置**：`src/lib/remote/supervisor.ts:616-623`
- **证据**：

```ts
// supervisor.ts:615-623（原文，`/** 仅供测试 *​/` 注释在 615 行）
export function resetRemoteSupervisor(): void {
	const previous = state();
	if (previous.automaticRetry) clearInterval(previous.automaticRetry);
	const store = globalThis as Record<PropertyKey, unknown>;
	store[Symbol.for(STATE_KEY)] = {
		lan: null, tunnel: null, lanError: null, publicError: null, enginePath: null, engineChecked: false,
	} satisfies SupervisorState;
}
```

- **触发路径**：`tests/remote-auto-connect.test.ts:33`、`tests/remote-supervisor.test.ts:21` 等在使用前调用它；部分文件（例如 `tests/remote-auto-connect.test.ts:31-43`）在 `beforeEach` 先 reset、`afterEach` 再 `stopAll`，另一些直接 reset。
- **后果**：如果上一条状态里还有真实监听/子进程，reset 之后再也拿不到句柄——端口和 `cloudflared` 进程泄漏到测试进程生命周期之外，还会残留 `PI_WEB_TRUSTED_HOSTS` 项（`allowTunnelHost` 只写 `process.env`）。目前测试都跑在假子进程/临时端口上，所以没炸；但这让"用例之间互相污染"成为潜在噪声源。
- **置信度**：已确认（代码）；影响仅限测试可靠性。
- **建议修法**：把 reset 改成 `await stopAll()` 的同步版本（或至少在 reset 里 `close()` 监听 + `kill()` 子进程 + `disallowTunnelHost`）。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| Windows 上的隧道进程生命周期 | **`tests/integration/remote/tunnel-status.test.ts:20` 是 `describe.skipIf(process.platform === "win32")`** —— 而本项目的目标平台就是 Windows（基线 `.audit-2026-11-13/vitest.log`：204 通过 / 3 跳过文件，本机 win32 下这个文件必然是跳过的那个）。退出码上报、启动中关闭、崩溃不复活、1033 恢复、`kill` 是否真杀掉进程，这一整套在本机基线上**零覆盖** | 把 fixture 改成跨平台：`tests/integration/remote/tunnel-status.test.ts:62-73` 现在写的是带 shebang 的可执行脚本，Windows 上不能直接执行；改成 `spawn(process.execPath, [fixture.js])`（或 `PIWEB_CLOUDFLARED` 指向一个 `.js` 并用 `node` 包一层）后去掉 `skipIf`；另补一条"`PIWEB_CLOUDFLARED` 指向 `.cmd` 垫片时给出安装提示而不是原始错误" |
| 真实 cloudflared 公网端到端（`PIWEB_TEST_TUNNEL=1`） | Host 透传、注入、`Secure` Cookie、Origin 校验这四件事只有这条用例能证明；`docs/planning/technical-design.md:975` 记录 2026-10-20 手工跑通过，之后基线里一直是跳过状态。`tests/remote-tunnel.integration.test.ts:154` 的 `expect(setCookie).toContain("Secure")` 正是公网路径的关键断言 | 至少进 CI 的"允许联网"一项；或在网络不可用时用本地 HTTPS 前置代理模拟 cloudflared 的 Host/`X-Forwarded-Proto` 行为，保证回归能跑 |
| `stop-lan`/`DELETE` 与启动并发 | P2-6 的"关闭后端口又开了"是"关闭远程是否真断开"的核心 | 并发 `startLan()` + `stopLan()`，断言 `await stopLan()` 之后 `net.connect(port)` 必然 ECONNREFUSED（等 100ms 再连一次） |
| 局域网入口失败时的 UI | P1-1 的静默失败；现在组件测试只覆盖 `public.error` | 给 `status.lan.error = "listen EADDRINUSE …"`，断言页面上出现该原因；给 `lan.urls` 断言地址可见可复制 |
| 隧道不可用时的局域网兜底 | P1-2；现在 `tests/components/remote-section.test.tsx:120-130` 恰好断言了"没有二维码" | 断言 `public.ready=false && lan.running=true` 时仍能给局域网地址/局域网码 |
| `decodeBody()`（gzip/br/deflate/不支持编码） | `mobile-proxy.ts:41-48` 是注入路径上唯一会抛异常的地方，抛了就走"原样返回"；现有注入测试全是未压缩响应，四种分支零覆盖 | 起三个上游分别返回 gzip/br/`zstd`（不支持）编码的 HTML，断言：前两者注入成功、`content-encoding` 被摘、`content-length` 与新 body 一致；不支持时原样返回且头被清理 |
| 会话吊销与公网权威的关系 | `web-revocations.json` 的 `notBefore` 语义是全局的，但 Cookie 是按权威命名的（隧道域名每次变）| 断言"撤销后旧隧道权威的 Cookie 失效"、"换个隧道域名后旧 Cookie 不生效"（可与 auth 区域协作） |

## 3. 与其他区域的可能交叉点

1. **API/鉴权 区域（`src/proxy.ts`、`auth.ts`）**：公网入口能工作，依赖 `supervisor.ts:194-223` 在**运行时**把隧道域名写进 `process.env.PI_WEB_TRUSTED_HOSTS`，而 `configuredTrustedHosts()` 每次请求现读 env。请确认 Next 16.4.5 的 `proxy.ts` 运行时与路由处理共享同一 `process.env` 对象（若是独立沙箱且 env 是启动快照，公网入口会整体 403 `untrusted host`）。现有测试都不覆盖这一点：`tests/remote-pair.test.ts:27` 直接 `vi.stubEnv` 塞白名单，`tests/remote-tunnel.integration.test.ts:130` 只断言 `process.env` 里出现了主机名、随后在同进程里直调 `proxy(incoming)`。这条不确认，"公网可用"的判断就悬着。
2. **API/鉴权 区域**：`/pair` 在 `PUBLIC_PATHS`（`src/proxy.ts:9`）且无 IP 维度限流（我的 P2-2 在 `pairing.ts`，但"公开路径该不该有闸门级限流"是他们的设计）。另外 `src/lib/web-auth.ts:153-166` 的 `secure` 判定直接信任 `x-forwarded-proto`，局域网入口（我的 P2-4）因此拿到非 Secure Cookie。
3. **bridge/chat 区域**：`src/lib/chat/event-stream.ts:13` 的 `usesEventPolling()` 是"Cloudflare 快速隧道不支持 SSE"的绕法。remote 只负责把 trycloudflare 暴露出去；如果他们把这个开关扩到命名隧道/自建反代，行为会变得不可预期。隧道下长轮询的压缩（#062）也归他们。
4. **API 区域（上传）**：`next.config.ts:53` 的 `proxyClientMaxBodySize: "272mb"` + `api/files` 的 `saveUploadStream`。`mobile-proxy` 这一跳是纯流式（`req.pipe`、不缓冲），所以远端上传不会在代理里爆内存；但 Next 侧是否会为 middleware 克隆 body 而把 272MB 落到内存/临时盘，需要在他们的区域确认（`tests/upload-proxy.test.ts` 只测了 11MiB）。
5. **设置区域**：`ProxySettings` 写入的是 pi 的 `httpProxy`（`src/lib/pi-settings.ts:37`）；系统代理只读（`readSystemProxy` 只 `reg query`），改不到用户的全局代理——这点是 OK 的；但 `applyProxyEnv`（`scripts/launcher.mjs:149-177`）会给服务进程注入 `HTTP_PROXY`/`NODE_USE_ENV_PROXY`，与 `mobile-proxy` 自建 agent 绕开代理是同一条故事线（#052），改任一侧都要双方一起看。

## 4. 建议优先修的 3 件事

1. **把局域网入口的状态真正呈现出来（P1-1 + P1-2 一起修）**：`RemoteSection` 渲染 `lan.urls` 与 `lan.error`；公网不可用时给局域网地址/局域网码兜底。服务端（`/api/remote/pair` 的 `base=lan`）已经实现并被测试覆盖，只差前端接上——这是"没装 cloudflared 或 trycloudflare 被墙时手机根本连不上"的唯一低成本解。
2. **给 cloudflared 补进程级清理（P2-1）**：`process.once("exit"|"SIGINT"|"SIGTERM")` 里 `kill()` 子进程（或 `await stopAll()`）。现在完全靠"控制台 Ctrl+C 顺带打到子进程"这种平台副作用，崩溃/硬杀/服务包装器停止都会留下一条仍挂在 Cloudflare 上的隧道进程。
3. **修配对限流维度（P2-2）并给远程设备可撤销性（P2-3）**：`failedAt` 按来源分桶，全局桶只作兜底，避免匿名刷 30 次就锁死合法扫码；同时把 `web-revocations.json` 已有的按 Cookie 指纹吊销能力做成"已连接设备列表 + 单设备撤销"，让"手机丢了"不必等于"所有设备重新登录"。
