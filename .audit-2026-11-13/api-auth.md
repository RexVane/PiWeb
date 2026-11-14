# HTTP API 路由与鉴权面 审计报告

审计人：audit-api-auth　时间：2026-11-13　HEAD：`1d4efba`（按当前磁盘状态）　只读审计

## 0. 覆盖范围

### 读了哪些文件

**审计清单内全部读完**（行数为实际读取）：

| 文件 | 行 |
|---|---|
| `src/proxy.ts` | 87（Next 16 的 middleware，即认证网关） |
| `src/instrumentation.ts` | 18 |
| `src/instrumentation-node.ts` | 46 |
| `src/lib/web-auth.ts` | 170 |
| `src/lib/web-auth-shared.ts` | 39 |
| `src/lib/web-secret.ts` | 197 |
| `src/lib/web-launch-token.ts` | 54 |
| `src/lib/auth.ts` | 59 |
| `src/lib/auth-throttle.ts` | 102 |
| `src/lib/path-security.ts` | 93 |
| `src/lib/command-validation.ts` | 136 |
| `src/lib/security-service.ts` | 48 |
| `src/lib/github-identity.ts` | 232 |
| `src/app/login/page.tsx` | 59 |
| `src/app/pair/route.ts` | 40（不在 `api/` 下但承担登录，纳入） |

34 个 `src/app/api/**/route.ts` **逐个读完**：health 7、version 8、config 22、web-auth 76、fs 119、files 77、prompts 52、skills 45、workspaces 128、sessions 28、sessions/[id] 37、sessions/[id]/export 37、sessions/import 84、agent/new 20、agent/resources 18、agent/[id] 24、agent/[id]/events 115、agent/[id]/tree 29、models 167、models/defaults 18、pi-settings 25、security 41、sandbox 27、git 32、github 26、growth 55、automations 111、automations/preview 24、plugins 81、plugins/marketplace 53、update 49、remote 87、remote/pair 55、models 167。

**顺调用链补读的被调库**（只为判断「防护是否真的生效」，未审其内部业务逻辑）：`src/lib/files-service.ts:193-535,538-581`（581 行全貌经 grep 覆盖）、`src/lib/skills-service.ts:20-237`、`src/lib/prompt-sources.ts`（grep 关键函数）、`src/lib/models-service.ts:460-659`（SSRF 段）、`src/lib/proxy-status.ts:40-90`、`src/lib/remote/pairing.ts:1-127`、`src/lib/pi.ts:466-486`（session id 编解码）。

**配置与约定核对**：`next.config.ts`（第 53 行 `proxyClientMaxBodySize`）、`package.json`（next 16.4.5）、`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`（确认 `src/proxy.ts` + named export `proxy` 是 Next 16 的正式约定，非自造）、`.../proxyClientMaxBodySize.md`、`scripts/launcher.mjs:180-260,440-500`、`bin/piweb.js`。

**跑过的探测**（只读 GET，127.0.0.1:30141，未改任何状态）：`/api/health` 200、`/api/web-auth` 200 `{"enabled":true,"authenticated":false}`、`/api/version` 401、`/api/config` 401、`/api/fs` 401、`/api/files?read=1` 401、`/api/security` 401、`/pair` 303→`/login?pair=unknown`。

**跳过**：`src/lib/agent-manager.ts`、`src/lib/pi.ts` 业务实现、`src/lib/sandbox/*`、`permission-*.ts`——按 BRIEF 边界归 bridge / sandbox 区域；pi SDK 内部实现（`node_modules/@earendil-works/*`）按 BRIEF 不审。

测试文件：全读了 `tests/proxy-auth.test.ts`（329）、`tests/auth.test.ts`（54）、`tests/web-secret.test.ts`（142）、`tests/web-revocations-concurrency.test.ts`（97）；其余指定测试（`web-auth`/`path-security`/`command-validation`/`fs-route`/`security-service`/`api/*`）逐条读了用例清单，未逐行读断言细节。`.audit-2026-11-13/vitest.log`：**204 文件 / 1648 用例全过**。

### 结论一览

| 子功能 | 结论 | 依据文件 |
|---|---|---|
| 认证网关挂载与全局覆盖 | **OK**（实测 8 个路由，仅 health/web-auth 放行） | `src/proxy.ts:20-72,86`；探测结果 |
| Host 校验 / DNS rebinding | **OK** | `src/lib/auth.ts:40-59`；`tests/auth.test.ts:33-53` |
| 同源校验与 CSRF | **OK-但脆弱**（无 Origin 头即放行，靠 SameSite=Strict 兜底；无 CORS 头） | `src/lib/auth.ts:7-18` |
| Cookie HMAC / 时序比较 / 过期 / 权威绑定 | **OK** | `src/lib/web-auth.ts:70-145` |
| 登录凭据（启动令牌 / 配对码） | **OK-但脆弱**（令牌进程内终身有效、不一次性） | `src/lib/web-launch-token.ts:17-22`；`src/proxy.ts:39-51` |
| 会话撤销（单张 / 全设备） | **OK-但脆弱**（全设备撤销有等锁竞态；对启动令牌无效） | `src/lib/web-secret.ts:183-197` |
| 登录限流 / 爆破面 | **OK**（已无密码登录；`auth-throttle.ts` 是死代码） | `src/lib/auth-throttle.ts:1-12`；grep 无生产调用点 |
| 路径穿越（files/prompts/skills/sessions/growth） | **OK**（lexical + realpath 双重校验，逐个看过） | `src/lib/path-security.ts:17-93`；`files-service.ts:198-210,267-277` |
| `/api/fs` 任意目录枚举 | **OK-但脆弱**（设计如此，全盘可枚举；Windows 无超时） | `src/app/api/fs/route.ts:33-51,61-96` |
| 上传落盘 | **OK-但脆弱**（无内容/扩展名校验，但落在独立目录） | `files-service.ts:387-408,499-531` |
| SSRF `/api/models` discover | **OK**（字面量 + DNS lookup 双重私网拦截、禁重定向、4 MiB、15s） | `models-service.ts:483-560,585-640` |
| SSRF `/api/proxy` | **OK-但脆弱**（可做受限端口探测，需鉴权） | `proxy-status.ts:63-90` |
| SSRF `/api/github`、`/api/update`、marketplace | **OK**（域名固定/枚举固定） | `github-identity.ts:163-179`；`update/route.ts:26-27` |
| 请求体大小 / 超时 | **有问题**（P2-3、P2-6） | `next.config.ts:53`；34 个 route 逐个看 |
| 错误响应泄漏 | **有问题**（P3-1：500 回显 `err.message` 含绝对路径） | 见 P3-1 |

### 路由表（34 个 `/api` route 文件，52 个方法处理器；另加非 api 的 `/pair`）

鉴权列「会话」= 未带有效会话 Cookie 时被 `src/proxy.ts` 拦成 401，**已实测抽样验证**。

| 方法 | 路径 | 鉴权 | 参数校验 | 危险操作 |
|---|---|---|---|---|
| GET | `/api/health` | **公开** | 无 | 无（只回 `{ok,service}`） |
| GET | `/api/version` | 会话 | 无 | 无 |
| GET | `/api/config` | 会话 | 无 | 读 `~/.pi/agent/settings.json` 原样下发 |
| GET/POST/DELETE | `/api/web-auth` | **公开**（自带 host+origin 校验；`?scope=all` 另需有效会话） | GET 无；POST 恒 410 | 写 `web-revocations.json`、清 Cookie |
| POST | `/api/fs` | 会话 | action 枚举 + 绝对路径 ≤4096 + realpath + 必须目录 | **枚举任意绝对目录（全盘）** |
| GET | `/api/files` | 会话 | `cwd` 工作区 realpath；`path` 相对路径边界校验 | 读工作区文本/图片、列目录 |
| POST | `/api/files` | 会话 | upload：`name` 净化 + `x-upload-size` ≤100 MB 流式校验；open：body ≤64 KB | **写文件**到 `<agentDir>/web-uploads/`；**起进程** `cmd /c <editor> <path>` |
| GET/POST | `/api/prompts` | 会话 | `cwd` 工作区；`filePath` 必须是已发现来源或工作区内 | 读文件 |
| GET/POST | `/api/skills` | 会话 | `cwd` 工作区；`filePath` 必须是已发现技能文件 | **改/递归删**技能文件与目录（见 P2-1） |
| GET/POST | `/api/workspaces` | 会话 | action 枚举；`path` 必须存在且是目录；session 走 `resolveSessionPath` | 写 `web-workspaces.json`；归档/遗忘会话；`pick` **起原生对话框进程**（仅回环） |
| GET | `/api/sessions` | 会话 | `q` | 写工作区注册表（`registerCwds`）、预热资源 |
| GET/DELETE | `/api/sessions/[id]` | 会话 | id→base64url→绝对路径+`.jsonl`+sessions 根内 realpath | **删会话文件** |
| GET | `/api/sessions/[id]/export` | 会话 | 同上 + `format` 枚举 | 读会话全文 |
| GET/POST | `/api/sessions/import` | 会话 | `limit` 1..MAX；selection 只收 `{source,externalId}` 并服务端重扫 | 写会话 JSONL、注册工作区 |
| POST | `/api/agent/new` | 会话 | `cwd` 工作区 | 建会话（起 agent 运行时） |
| GET | `/api/agent/resources` | 会话 | `cwd` 工作区 | 读资源清单（不启 MCP） |
| POST | `/api/agent/[id]` | 会话 | `parseAgentCommand` 白名单命令+长度+图片类型/总量 | **执行 agent 命令，含 `bash`** |
| GET | `/api/agent/[id]/events` | 会话 | session id；`poll` 标志 | SSE/长轮询、会话保活钩子 |
| GET | `/api/agent/[id]/tree` | 会话 | session id | 读会话树 |
| GET/POST | `/api/models` | 会话 | 各 action 字段；自定义 header 名/值白名单（`/^[A-Za-z0-9!#$%&'*+.^_\`|~-]{1,64}$/`） | **写 `auth.json`/`models.json`（API key）**；**外连 `baseUrl`（带 SSRF 防护）**；OAuth 登录流 |
| GET | `/api/models/defaults` | 会话 | `cwd` 工作区 | 读设置 |
| GET/PUT | `/api/pi-settings` | 会话 | `patchPiSettings` 校验 | 写 `settings.json` |
| GET/PUT | `/api/security` | 会话 | `decision` ∈ true/false/null 或三档枚举；`cwd` 工作区 | 写 `trust.json`/`settings.json` + 重载 loader 与会话 |
| GET/PUT | `/api/sandbox` | 会话 | `writeSandboxConfig` 校验 | 写沙箱配置 |
| GET | `/api/git` | 会话 | `cwd` 工作区；`diff`/`show` | 只读 git（spawn `git`） |
| GET | `/api/github` | 会话 | `cwd` 工作区 | **外连** `github.com`（域名固定）+ 起 `gh` 进程 |
| GET/POST | `/api/growth` | 会话 | `cwd` 工作区；`session` id；`tree/from/to` | 读 git 对象；POST 可能建 git 仓库并提交 |
| GET/POST | `/api/automations` | 会话 | action + 字段校验（store 侧 `AutomationValidationError`） | **写任务存储**、启调度器、`runNow` **起独立会话执行** |
| POST | `/api/automations/preview` | 会话 | `validateSchedule` | 无 |
| GET/POST | `/api/plugins` | 会话 | action 枚举；`source` ≤4096 | **安装/卸载 npm 包（等于任意代码执行）**、重载扩展 |
| GET/POST | `/api/plugins/marketplace` | 会话 | `q`/`category` 白名单/`size`；`packages` 数组 | **外连 npm registry** |
| GET/POST | `/api/update` | 会话 | `target` ∈ {piweb,pi}、`action` ∈ {check,update} 固定枚举 | **下载并安装更新、起进程**；busy 时 409 |
| GET/POST/DELETE | `/api/remote` | 会话 + `remoteBlocked()` 二次校验 | action 枚举 | **开/关局域网监听与公网隧道** |
| POST | `/api/remote/pair` | 会话 | `base` ∈ {lan,public} | 发一次性配对码（纯内存，120s） |
| GET | `/pair`（非 api） | **公开** | `code` 格式 `/^[A-Za-z0-9_-]{43}$/` + 一次性 + 120s + 失败限流 | 签发会话 Cookie |

**结论：没有找到未鉴权或可绕鉴权的 `/api` 路由**。`PUBLIC_PATHS` 只有 `/login`、`/api/web-auth`、`/pair`，外加 `GET/HEAD /api/health`；其余全覆盖（`src/proxy.ts:9,31,56`）。唯一的「放行面」是静态资源前缀 `/_next/`、`/_piweb-dev/`（`src/proxy.ts:11,32`），它们不映射到任何 PiWeb API。

---

## 1. 发现

> 没有确认的 P0。下面 P2 里 P2-1 的**后果**是 P0 级的（递归删除任意目录），但触发需要前置条件，按 BRIEF 归 P2。

### P2-1 `/api/skills` 的 delete 递归删除边界是「不在受保护名单里」，而不是「在技能根之内」

- **位置**：`src/lib/skills-service.ts:224-233`（路由在 `src/app/api/skills/route.ts:33-37`）
- **证据**：

```ts
	const skillDir = path.dirname(authorized);
	const comparableDir = await toComparablePath(skillDir);
	const protectedRoots = await protectedDirs(context);
	const others = discovered.map(({ canonical }) => canonical);
	const ownsDir = path.basename(authorized) === "SKILL.md"
		&& path.dirname(skillDir) !== skillDir
		&& !protectedRoots.has(comparableDir)
		&& !others.some((other) => other !== comparableFile && within(other, comparableDir));
	const removed = ownsDir ? skillDir : authorized;
	await fs.rm(removed, { recursive: ownsDir, force: true });
```

同时 `resolveDiscoveredPath` 返回的是 **realpath**（`src/lib/path-security.ts:83-92`），所以 `authorized` 已经跟随过链接：

```ts
	const realRequested = await fs.realpath(requested).catch(() => { throw new BoundaryError("resource not found"); });
	for (const candidate of allowed) {
		const realCandidate = await fs.realpath(candidate).catch(() => null);
		if (realCandidate && samePath(realRequested, realCandidate)) return realRequested;
	}
```

- **触发路径**：工作区（或 `~/.pi/agent/skills`）里存在一个**目录链接**（symlink / Windows junction）`evil/` → 外部目录 `D:\somewhere`，且 `D:\somewhere\SKILL.md` 存在（这样 pi 的 loader 会把它发现成一个技能）。用户在工作区技能面板点「删除」→ `POST /api/skills {action:"delete", filePath:"…/evil/SKILL.md"}` → `authorized` = `D:\somewhere\SKILL.md` → `skillDir` = `D:\somewhere` → 不在 `protectedDirs` 列表里（那份名单只有 agentDir/home/.pi/.agents/工作区及其子目录）→ 若该目录内没有别的已发现技能，`ownsDir` 为真 → `fs.rm("D:\\somewhere", {recursive:true})`。
- **后果**：递归删除工作区之外的任意目录。前置条件都成立时是 P0 级数据丢失；`protectedRoots` 只是黑名单，所以「任何没被列进黑名单的路径」都会被当成可以整体删除的技能目录。克隆不可信仓库带 junction 是现实路径（`core.symlinks` 开启时 git 会落链接）。
- **置信度**：疑似（代码路径已读通；未运行验证）。验证方法：临时目录造 `A/skills/evil -> B`、`B/SKILL.md`，让 loader 发现后在测试里调 `deleteSkill("<A>/skills/evil/SKILL.md", A)`，断言 `B` 是否被删。
- **建议修法**：把黑名单改成白名单——要求 `comparableDir` 必须 `within()` 某个技能根（`${agentDir}/skills`、`${home}/.agents/skills`、`${cwd}/.pi/skills`、`${cwd}/.agents/skills`）才允许连目录删，否则退化成只删文件（`authorized`）。改动约 5 行，且天然覆盖 junction 情形。

### P2-2 认证网关在 `PI_WEB_AUTH` 未设置时 **fail-open**，「默认开启」完全依赖 instrumentation 的 `process.env` 副作用

- **位置**：`src/proxy.ts:28`；`src/instrumentation-node.ts:12,14-18`
- **证据**：

```ts
	// src/proxy.ts:28
	if (!authEnabled()) return NextResponse.next();
```

```ts
	// src/instrumentation-node.ts:11-18
	// 直接使用 Next 启动时也常设认证；启动器已经提供的凭据保持不变。
	if (!process.env.PI_WEB_AUTH?.trim()) process.env.PI_WEB_AUTH = "1";
	const { authEnabled } = await import("./lib/web-auth");
	if (authEnabled()) {
		process.env.PI_WEB_LAUNCH_TOKEN ||= (await import("node:crypto")).randomBytes(32).toString("base64url");
		(await import("./lib/web-launch-token")).publishLaunchToken();
	}
```

`authEnabled()`（`src/lib/web-auth.ts:44-47`）只认 `1/true/on/yes`，**未设置即为关闭**；网关对「关闭」不做任何日志、直接放行全部请求。

- **触发路径**：任何 `instrumentation.register()` 没有跑到 `registerNode()` 的启动方式（自定义 server、被裁掉的构建、某些平台/包装器不执行 instrumentation、或 `NEXT_PHASE === "phase-production-build"` 分支被误命中），`PI_WEB_AUTH` 就是空 → 整个 `/api/**`、页面、以及 `POST /api/remote` 能开出的局域网/公网入口全部**无鉴权**。而 `POST /api/remote` 自带 `remoteBlocked()==="auth"` 二次闸（`src/app/api/remote/route.ts:41-45`）能兜住远程入口，但兜不住本地 API。
- **后果**：一个环境变量缺失 = 静默变成无鉴权 shell（`/api/agent/[id]` 的 `bash` 命令、`/api/plugins` 装包、`/api/update` 升级都直接可用）。没有失败关闭、没有告警日志，只有 `launcher.mjs:248` 会设这个变量；`bin/piweb.js → launcher` 是主路径（已验证），所以现实风险取决于用户是否绕过启动器。
- **置信度**：已确认逻辑；「现实中会不会发生」未确认（见第 4 节最大未知点）。验证方法：`mv src/instrumentation.ts src/instrumentation.ts.bak` 后 `next dev`，再 `GET /api/fs` —— 若 200 则确认。
- **建议修法**：让 `authEnabled()` 增加「未设置 = 开启」的第三态（显式 `PI_WEB_AUTH=0/off/false` 才关），或在 `proxy` 里 `process.env.PI_WEB_AUTH === undefined` 时返回 503 + 打一条 ERROR 日志。前者 3 行改动，顺带删掉 instrumentation 里那句赋值。

### P2-3 `proxyClientMaxBodySize: "272mb"` 是全局的，绝大多数路由没有任何自己的 body 上限

- **位置**：`next.config.ts:53`
- **证据**：

```ts
		// Image prompts allow 268 MB of base64 plus text and JSON framing.
		experimental: { proxyClientMaxBodySize: "272mb" },
```

Next 官方文档对该选项的说明（`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md:7-10`）：

> When proxy is used, Next.js automatically clones the request body and buffers it in memory to enable multiple reads - both in proxy and the underlying route handler. To prevent excessive memory usage, this configuration option sets a size limit on the buffered body.
> By default, the maximum body size is **10MB**. … 3. The request will continue processing normally, but only the partial body will be available. 4. The request will **not** fail or return an error to the client.

- **触发路径**：这个上限是为 `/api/agent/[id]` 的 268 MB base64 图片（`src/lib/command-validation.ts:34-35`）开的，但它是**进程级**的。实测哪些路由有自带上限：`/api/files` POST 有（upload 100 MB 流式、open 手写 64 KB，`src/app/api/files/route.ts:45-65`）、`/api/files` 的 `parseUploadLength`（`files-service.ts:491-497`）、`/api/sessions/import` 有选择条数上限。**没有上限**的：`/api/models`（`saveCustomProviders` 的 `content` 字符串，`models/route.ts:94-101`；`headers` 只限每值 4096 但值可空）、`/api/pi-settings` PUT、`/api/growth` POST、`/api/update` POST、`/api/automations` POST、`/api/security` PUT、`/api/workspaces` POST、`/api/proxy` POST（只限 `proxy` ≤2048）。
- **后果**：单请求可让进程吃进最多 272 MB 缓冲 + JSON 解析副本；并发几个就能把 3 GB 堆（`scripts/launcher.mjs:255` 的 `--max-old-space-size=3072`）打爆。经过 `no-store` 不设的路由还会把超大内容写盘（`models.json` 写坏后模型运行时读不动）。
- **置信度**：疑似（**未确认缓冲是在 proxy 的鉴权判断之前还是之后发生**，见第 4 节）。若是之前，则未鉴权攻击者用几个 272 MB POST 打 `/api/health`（非 GET → 401，但 body 可能已被缓冲）就能做远程内存耗尽。
- **建议修法**：把 `proxyClientMaxBodySize` 压回 `20mb` 级别，另给唯一的图片通道单独开（`/api/agent/[id]` 改成流式解析或分片上传）；同时给每个 route 的 `req.json()` 加统一包装，超限直接 413 而不是「静默截断成部分 body 再解析失败」。

### P2-4 `revokeAllSessions` 的 `notBefore` 取的是「调用时刻」，等锁期间新签发的 Cookie 逃过「所有设备退出登录」

- **位置**：`src/lib/web-secret.ts:174-197`
- **证据**：

```ts
async function updateSessionRevocations(update: (current: SessionRevocations) => SessionRevocations): Promise<void> {
	const file = revocationsPath();
	await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
		revocationCache = null;
		await writeSessionRevocations(update(loadSessionRevocations()));
	}));
}

/** 让此刻之前签发的 Cookie 失效；… */
export async function revokeAllSessions(now = Date.now()): Promise<void> {
	await updateSessionRevocations((current) => ({
		notBefore: Math.max(now, current.notBefore),
```

`now` 在**进入锁之前**求值（默认参数在调用时绑定），而判定是 `payload.issuedAt < revocations.notBefore`（`src/lib/web-auth.ts:140`）。

- **触发路径**：浏览器 A 点「所有设备退出登录」→ `DELETE /api/web-auth?scope=all` → `revokeAllSessions(T0)` 进入 `withSettingsWriteLock`／`withExternalSettingsLock` 等锁（另一个进程/请求正在写同一个 `web-revocations.json`）。等锁期间浏览器 B 通过启动令牌 `GET /?token=…` 换到一张 `issuedAt = T0+Δ` 的 Cookie。锁到后写入 `notBefore = T0`，B 的 Cookie 因为 `issuedAt > notBefore` 且不在 `revoked` 里 → **继续有效 30 天**。
- **后果**：正是「怀疑泄露所以全设备登出」这个场景下，攻击者只要在窗口内重新登一次就能留下来。窗口通常 <1 ms（无争用），有外部写者时可达数十 ms。
- **置信度**：已确认代码逻辑；竞态窗口未运行复现。验证：在 `tests/web-proxy-auth` 风格下用 `proper-lockfile` 先占住 `web-revocations.json`（`web-revocations-concurrency.test.ts:75` 已有现成写法），调 `revokeAllSessions(T0)`、期间 `createSessionCookie`，释放锁后断言新 Cookie 是否仍 `validSessionCookie()`。
- **建议修法**：在**锁内**重新取时间：把 `now` 从默认参数改成 `undefined`，`updateSessionRevocations` 的回调里用 `Date.now()`；或写入 `notBefore = Date.now()` 后再把本次调用前已存在的 `revoked` 快照中 `issuedAt <= notBefore` 的全部覆盖。前者 3 行改动。

### P2-5 启动令牌在进程生命周期内**永久有效且可重复使用**，`scope=all` 也撤不掉它

- **位置**：`src/lib/web-launch-token.ts:17-22`；`src/proxy.ts:39-51`
- **证据**：

```ts
	if (request.method === "GET" && pathname === "/") {
		const tokens = request.nextUrl.searchParams.getAll(TOKEN_QUERY);
		if (tokens.length > 0) {
			const authority = requestAuthority(request);
			if (authority && tokens.length === 1 && validLaunchToken(tokens[0], process.env.PI_WEB_LAUNCH_TOKEN)) {
				const cookie = createSessionCookie(authority, secret);
```

令牌本身只在 `instrumentation-node.ts:16` 进程启动时生成一次，`validSessionCookie` 的吊销清单（`notBefore` / `revoked`）**只作用于 Cookie**，不作用于令牌；`tests/proxy-auth.test.ts:299-301` 明确断言了这个行为（「启动令牌仍然能换一张新的」）。

- **触发路径**：登录链接是 `http://host:port/?token=…`，`launcher.mjs:473-478` 把它打到终端并注明「它会进浏览器历史」；`web-launch-token.ts:31-46` 还会把它以 0600 落盘到 `<agentDir>/web-launch/<端口>.token`。任何看到过这条链接的人（终端回滚、截图、投屏、浏览器历史同步、`web-launch/*.token` 文件）都可以在服务存活期内**任意次数**换新 Cookie，「让所有设备重新登录」也拦不住——它只能把 Cookie 清掉，令牌一换又是一张新的。
- **后果**：撤销语义不完整。操作者以为「全设备登出」已经止住泄露，实际对方仍持有根凭据，直到重启进程。
- **置信度**：已确认（`tests/proxy-auth.test.ts:287-302` 就是这个行为）。
- **建议修法**：令牌一次性——首次成功兑换后 `process.env.PI_WEB_LAUNCH_TOKEN = ""`（并把 `web-launch/<端口>.token` 删掉），或在 `revokeAllSessions()` 成功后轮换令牌；若需要「再次运行启动器能找回登录链接」，改成启动器重新起服务时再生成。

### P2-6 `/api/fs`（Windows）与 `/api/github` 没有超时，请求可挂住数十秒甚至无限期

- **位置**：`src/app/api/fs/route.ts:33-51`、`src/app/api/github/route.ts:20`、`src/lib/github-identity.ts:118-127,143-149,163-179`
- **证据**：

```ts
	// fs/route.ts:36-39 —— 26 个盘符 Promise.all，每个都无超时
		const drives = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
		const present = await Promise.all(drives.map(isDirectory));
```

```ts
	// github-identity.ts：串行 15s + 8s + 8s，路由整体无超时
	const out = await exec(await resolveGitBin(), args, { cwd, timeout: 15_000, ... });
		const { stdout } = await exec(bin, ["api", "user"], { cwd, timeout: GH_TIMEOUT_MS, ... });   // 8s
		const res = await fetch(`https://github.com/${encodeURIComponent(owner)}.png?...`, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) }); // 8s
```

- **触发路径**：Windows 上存在断开的映射网络盘 / 未插卡的读卡器 → `fs.stat("Z:\\")` 卡在内核层（Node 的 `fs.stat` 没有超时）→ `POST /api/fs {action:"roots"}` 挂住，手机端目录选择器永远转圈（注释 `fs/route.ts:36` 只解决了「叠加」问题，没解决「单个卡死」）。`/api/github` 最坏 15+8+8 = 31 s，Git 面板头部 `await awaitGithubIdentity(root)` 期间一直空白。
- **后果**：目录选择器/Git 面板在特定环境下不可用（静默挂起，没有错误提示）；这些请求还会占着连接。
- **置信度**：已确认代码无超时；实际挂起时长依赖环境（未复现）。
- **建议修法**：`/api/fs` 的 `isDirectory` 包一层 `Promise.race([stat, timeout(1500)])`（超时按「不存在」处理）；`/api/github` 用 `AbortSignal.timeout(5000)` 整体包住 `awaitGithubIdentity`，超时就走 `identity:null` 降级（该路由本来就把失败当装饰）。

### P2-7 有副作用的 GET 依赖 SameSite=Strict 兜底；`isSafeOrigin` 对「没有 Origin 头」直接放行

- **位置**：`src/lib/auth.ts:7-18`；有副作用的 GET 见 `src/app/api/sessions/route.ts:18`（写工作区注册表）、`src/app/api/automations/route.ts:32`（启调度器）、`src/app/api/update/route.ts:13`（触发外网检查）、`src/app/pair/route.ts:20-39`（签发 Cookie）、`src/app/api/remote/route.ts:27`（`refreshPublicStatus`）
- **证据**：

```ts
export function isSafeOrigin(request: Request): boolean {
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const origin = request.headers.get("origin");
	if (!origin) return true;           // ← 非浏览器调用一律放行
```

- **触发路径**：`src/proxy.ts:24` 只对**非只读方法**做同源校验，`GET` 完全跳过；上表那些 GET 会写盘/起后台任务。真正的 CSRF 防线是 Cookie 的 `sameSite: "strict"`（`web-auth.ts:158-165`）+ 全站无任何 `Access-Control-Allow-*` 头（grep 确认 0 处）。因此跨站 GET 带不上 Cookie → 401，攻击不成立；但只要出现一个「无 Origin 但带 Cookie」的客户端（被拷走的 Cookie 灌进脚本、或未来某个 `SameSite=None` 的改动），写操作就没有第二道闸。
- **后果**：现状不可利用，属于纵深防御缺口。同时 `GET /api/sessions` 每 3 秒轮询会走 `registerCwds`（`sessions/route.ts:18`）——读操作里写盘，是脆弱的耦合。
- **置信度**：已确认（代码 + 无 CORS 头）。
- **建议修法**：给有副作用的 GET 换成 POST（或加一行 `if (!isSafeOrigin(request)) return 403` 到这些 handler）；`/api/sessions` 的 `registerCwds` 挪到独立 POST 或改成「只在内容变化时写」。

---

### P3（仅列关键项，按影响降序）

**P3-1 所有 500 把 `err.message` 原样回显，会带出绝对路径；`/api/config` 下发 settings.json 且不带 `no-store`**
- 位置：`src/app/api/config/route.ts:19-21`、`src/app/api/fs/route.ts:113-118`、`src/app/api/workspaces/route.ts:37-39`、`files/route.ts:29-34,71-76` 等 15 处同型。
- 证据：`return NextResponse.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });` —— `ENOENT … open 'C:\Users\<user>\.pi\agent\settings.json'` 会整条进浏览器。`/api/config` 的响应头只有 `Content-Type` + `Content-Disposition`，没有 `Cache-Control: no-store`（对比 `web-auth/route.ts` 每处都写了）。settings.json 里存的是 provider/思考档位/扩展配置，**不含** API key（key 在 `auth.json`，见 `models-service.ts:397-402`），所以泄漏面有限。
- 建议：统一错误出口，500 只回「内部错误」+ 一个可对照服务端日志的 requestId；`/api/config` 补 `Cache-Control: no-store`。

**P3-2 `auth-throttle.ts` 是死代码**
- 位置：`src/lib/auth-throttle.ts:1-12`（文件头自述「目前无调用方」）。
- 全仓 grep：生产代码 0 个调用点，只有 `tests/proxy-auth.test.ts:9,305-329` 在测它。因此「爆破被压到大约每分钟一次」这句注释描述的是**不存在的防护**。
- 判定：当前**不需要**限流——唯一的凭据是 32 字节随机令牌和 43 字符配对码，爆破不可行；`/pair` 有自己的失败计数（`pairing.ts:109-112`）。但这文件留着容易让人误以为有登录限流。
- 建议：删掉，或移到 `docs/` 并在文件头写清「未接线」。

**P3-3 没有任何全局安全响应头**（CSP / X-Frame-Options / HSTS / Referrer-Policy / X-Content-Type-Options）。`next.config.ts` 没有 `headers()`；只有 `/api/files?image=1` 自己设了 nosniff + CSP + `Referrer-Policy`（`files/route.ts:13-20`）。当前点击劫持被 `SameSite=Strict` 挡住（跨站 iframe 带不上 Cookie，只会显示登录页），所以是 P3。
- 建议：加一个全局 `headers()`，至少 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: SAMEORIGIN`。

**P3-4 `web-secret` 的 `mode: 0o600` 在 Windows 上是空操作，测试还显式跳过了这个断言**
- 位置：`src/lib/web-secret.ts:73`、`tests/web-secret.test.ts:44-49`（`if (process.platform !== "win32")`）。
- 后果：密钥文件的保护完全靠 `%USERPROFILE%\.pi\agent` 的继承 ACL（默认只允许本用户 + Administrators + SYSTEM，还算安全）；一旦 `PI_WEB_SECRET_FILE` / `PI_CODING_AGENT_DIR` 指到共享目录，同一台机器上的其他账户就能读到 HMAC 密钥并伪造任意会话 Cookie。项目里已有 `src/lib/sandbox/windows-acl.ts` 的先例，这里没复用。
- 建议：Windows 上写入后用 `icacls`/ACL API 收紧到当前用户；至少在文档里说明「别把 agent 目录放到共享位置」。

**P3-5 同一毫秒签发的两张 Cookie 完全相同 → 一台设备登出会连带撤掉另一台**
- 位置：`web-auth.ts:102-111`（载荷只有 `authority/issuedAt/expiresAt`，无随机 nonce/设备标识）。测试靠 `setTimeout(5)` 规避（`tests/proxy-auth.test.ts:274-277`）。
- 建议：载荷加一个 `randomBytes(8)` 的 `nonce`。

**P3-6 `loadSessionRevocations()` 每个请求一次 `statSync`，缓存键是 `mtimeMs:ctimeMs:size`**
- 位置：`web-secret.ts:133-142`。认证网关每个请求同步 stat 一次（侧栏 3 秒轮询、SSE 重连都算）；`ctimeMs` 变化会让缓存频繁失效。功能正确，纯性能/耦合。
- 建议：改成 `fs.promises.stat` 或短 TTL 的内存缓存。

**P3-7 `/api/proxy` POST 是一个（受限的）端口探测原语**
- 位置：`proxy-status.ts:63-90` + `proxy/route.ts:16-21`。协议限 http/https、禁止 path/query/hash、长度 ≤2048，但 `host:port` 任意 → 服务端会向它发起连接，响应只回 `ok / timeout / unreachable / failed` + 延迟。需鉴权，且本来就是这个功能（测代理连通性），因此只记 P3。
- 建议：默认禁私网目标（复用 `models-service.ts:483-502` 的 `blockedIpv4/blockedIpv6` 与 `lookup` 思路）。

**P3-8 有 `pick` 动作的 `/api/workspaces` 与 `/api/files` 的 `open` 会起本机进程**：前者 `pickFolderNative()`（弹原生对话框），后者 `spawn("cmd.exe", ["/d","/c", editor, …])`。后者的 Windows 注入面已被 `isSafeWindowsEditorArgument`（`files-service.ts:579-581`，禁 `&|^<>()%!"` 与控制字符）挡住，`editor` 又只来自 `PI_WEB_EDITOR` 环境变量，属 OK；仅提醒 `code.cmd` 经 cmd.exe 启动这条路径在路径含 `,`/`;` 时未验证。

**P3-9 `/api/web-auth` 的 GET 未鉴权即可回答 `{enabled, authenticated}`**：向任何未登录访问者暴露「这台机器开了认证」。无害，仅信息面。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| `src/proxy.ts` 的 `config.matcher` 覆盖所有真实路由 | 网关能挡住的**唯一**依据是这个正则；如果它漏了某条路径，该路径就是完全无鉴权的。目前 0 个测试断言 matcher | 收集 `src/app/**/route.ts` + `page.tsx` 的全部路径，逐条断言 `new RegExp(...)`（由 matcher 转成）匹配；再加一条「matcher 不得匹配 `/_next/`」 |
| `PI_WEB_AUTH` 未设置时网关是 fail-open（P2-2） | 「默认开启」靠 instrumentation 副作用，没有任何测试覆盖「instrumentation 没跑」的启动方式 | 断言 `authEnabled({})` 的当前语义，并加一个显式用例记录「未设置 = 全放行」这个危险默认值，避免哪天被无意改成 fail-closed 或反过来 |
| 「全设备登出」与并发签发（P2-4） | 安全语义的竞态，现有 `web-revocations-concurrency.test.ts` 只测了两个写者，没测「等锁期间签发」 | 用现成的 `proper-lockfile` 占锁 → 调 `revokeAllSessions(T0)` → 锁内签发一张新 Cookie → 释放锁 → 断言新 Cookie 是否被拒 |
| 启动令牌一次性 / 被撤销后失效（P2-5） | 现状是**永久可重放**，测试反而把这个行为固化了 | 若要修，加「兑换一次后第二次 401」的用例 |
| Windows 上 `web-secret` / `web-revocations.json` / `web-launch/*.token` 的实际 ACL | 0600 在 Windows 是空操作，测试显式跳过（`web-secret.test.ts:46`） | Windows 专用：`icacls` 输出断言只有当前用户 + SYSTEM/Administrators |
| 每个 route 的请求体上限 | 34 个路由里只有 2 个有自身上限（P2-3） | 表格化：给每个 POST/PUT 发一个超限 body，断言 413/400 而不是「部分 body 解析」或 OOM |
| `/api/skills` delete 的链接逃逸（P2-1） | `fs.rm(recursive)` 是唯一会**删目录**的操作，现有 `skills-delete.test.ts`（200 行）没覆盖链接目录 | 造 symlink/junction 技能目录，断言只删 `SKILL.md` 或拒绝 |
| `/api/fs` 单个盘符 stat 挂住 | Windows 网络盘会让请求无限期挂着 | mock `fs.stat` 永不 resolve，断言 1.5s 内返回 |
| 每个需要鉴权的 route 在无 Cookie 时返回 401 | 目前只有 `/api/version`、`/api/fs`、`/api/files` 被 `proxy-auth.test.ts` 覆盖；其余靠 matcher 推断 | 遍历所有 route 文件导出名，对每个发一次无 Cookie 请求，断言 401（防止未来有人往 `PUBLIC_PATHS` 里加东西） |

---

## 3. 与其他区域的可能交叉点

1. **`src/lib/skills-service.ts` 的递归删除（P2-1）**：这个文件不在任何区域的显式清单里，但 `/api/skills` 是入口、`fs.rm(recursive)` 在本区域的路由表里。请 **sandbox/权限** 或 **bridge** 区域裁定归属；结论与修法见 P2-1，需要有人认领。
2. **`/api/agent/[id]` 的 `bash` 命令**（`src/app/api/agent/[id]/route.ts:12-14` → `execute(getManaged(...), parsed.command)`）：我只验证了参数校验是白名单（`command-validation.ts:66-135`），**命令最终怎么被执行、有没有沙箱/审批**属于沙箱与 bridge 区域。若沙箱区域结论是「`bash` 可以无沙箱执行」，那 P2-2（网关 fail-open）的实际后果要从「本地 API 可读」升级为「未鉴权远程 shell」，请 remote 区域一起看。
3. **`/api/remote` 能开公网隧道**（`src/app/api/remote/route.ts:41-53`）：我确认了它自己会二次检查 `remoteBlocked()`（auth/dev），但「隧道建起来之后边缘侧有没有缓存/日志泄漏 Cookie、`x-forwarded-proto` 可信度」属于 remote 区域。相关：`isSecureRequest()`（`web-auth.ts:153-156`）无条件信任 `x-forwarded-proto` 的第一个值。
4. **`/api/models` 的 SSRF 防护做得好**（`models-service.ts:483-560`，DNS `lookup` 层拦截 + 禁重定向 + 4 MiB + 15 s）：请 **UI/settings** 区域在「自定义 provider 表单」里确认 `allowPrivate` 这个勾选框的默认值必须是**不勾**——它是唯一能关掉 SSRF 防护的开关（`models-service.ts:506`）。
5. **`experimental.proxyClientMaxBodySize: "272mb"`（P2-3）** 与 **UI/crosscut** 区域相关：图片粘贴通道（268 MB base64）是唯一需要这么大 body 的功能，若 UI 侧能改成压缩/分片，这个全局上限就能直接降下来。
6. **`src/lib/update-service.ts`**（`/api/update` 背后）不在我的清单里，但它会下载并安装 npm 包：建议 update 区域确认「下载源是否固定 registry / 是否校验完整性」。

---

## 4. 建议优先修的 3 件事

1. **P2-2 网关 fail-open**：`authEnabled()` 改成「未设置 = 开启，显式 `0/off/false` 才关」，或在 `proxy` 里对未设置直接 503 + ERROR 日志。这是唯一一个「配置疏忽 = 整个鉴权面消失」的点，改动 3 行。
2. **P2-5 + P2-4 撤销语义补全**：启动令牌改成一次性（兑换成功即失效，或 `revokeAllSessions` 时轮换），`revokeAllSessions` 的 `notBefore` 改到锁内取。两处各 3 行，修完「所有设备退出登录」才真的等于「凭据全部失效」。
3. **P2-1 技能递归删除的边界**：`deleteSkill` 把「不在受保护名单里」改成「必须在某个技能根之内」，否则降级成只删 `SKILL.md`。这是本区域唯一可能造成**目录级数据丢失**的路径。

**本区域最大的未知点（按重要性）**：

- **P2-3 的缓冲时机**：`proxyClientMaxBodySize` 的 272 MB 缓冲到底发生在 `proxy()` 的鉴权判断**之前**还是之后？如果在之前，未鉴权攻击者只用一个 272 MB POST 就能占满内存（且 Next 按文档「不报错、只截断」，完全静默）。这是本区域唯一尚未排除的 P0 级可能。验证方式：向 `/api/health`（POST，必然 401）发 300 MB body，同时采样 dev server 进程 RSS；若 RSS 峰值上涨 ≥272 MB 即确认。我**没有执行**这个探测（属于压力型请求，超出只读探测范围），留给 lead 决定。
- 次要：`PI_WEB_AUTH` 未设置时的 fail-open 在真实启动路径里是否会触发（`bin/piweb.js → launcher.mjs:248` 会设，但 `next start` 直启、或某些包装器不跑 instrumentation 时的行为未实测）。
