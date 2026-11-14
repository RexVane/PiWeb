# 隧道真链路 + 进程生命周期：实测验证报告

> 审计缺口补测（对应 `PiWeb_Audit_2026-11-13.md` 的 P2-66 / P2-103 / 附录 C #2，以及 `.audit-2026-11-13/remote.md:486` 的未知点）
> 执行时间：2026-11-13 19:45–20:15 (Asia/Shanghai)
> 执行人：verify-tunnel（委派子代理）
> 工作目录：`D:\AIApp\PiWeb`　临时工作区：`%TEMP%\piweb-verify-tunnel\`（已清理）

---

## 0. 结论速览

| 问题 | 结论 | 证据强度 |
|---|---|---|
| 本机有没有 cloudflared | **原本没有**（`where cloudflared` 退出码 1，6 个常见路径全 miss）；已从官方 GitHub release 下载到临时目录，`cloudflared version 2026.11.0` | 实证 |
| 真实 quick tunnel 能不能建 | **能**，`--protocol http2` 下 9 秒完成 connector 注册（`Registered tunnel connection connIndex=0 location=tpe01`） | 实证 |
| 公网地址能不能打到 PiWeb | **能**，隧道转发到 127.0.0.1:30141 后返回的是 **PiWeb 自己的 JSON**（不是 Cloudflare 错误页），说明链路穿透成功 | 实证 |
| 鉴权在隧道下还生效吗 | **生效**。应用自己的隧道：`/` → **307 到 /login**，`/api/*` → **401 `authentication required`** | 实证 |
| `allowTunnelHost()` 动态注入有效吗（remote.md:486 的未知点） | **有效**。同一个 Next 服务进程里，隧道域名被注入后，带该 Host 的请求返回 **401**（不是 403）；未注入的域名返回 **403 `untrusted host`**。→ Next 16.4.5 的 proxy 运行时与路由处理**共享同一个 `process.env` 对象**，不是启动快照 | 实证（决定性） |
| 显式停止隧道会留下 cloudflared 吗 | **不会**。`POST /api/remote {action:"stop"}` 后 cloudflared **123ms** 退出，且域名立刻从白名单摘除（同 Host 再请求变 403） | 实证 |
| Ctrl+C 后 cloudflared 会立即退出吗 | 真实 `CTRL_C_EVENT` 后 **1537ms** 退出，exit code **0**（优雅，非残留） | 实证 |
| Windows 上零覆盖的隧道/沙箱用例 | **16 条**（11 条隧道生命周期 + 5 条 workspace picker），另有 1 条真隧道 E2E 在所有平台都被环境变量锁住 | 实证 |
| 那条被锁的真链路测试在 Windows 上能跑吗 | **能，而且通过**。`PIWEB_TEST_TUNNEL=1` + 真 cloudflared：`1 passed (1)`，31.8s | 实证（本次首次） |
| P2-66 的机制 | **代码层成立**（无任何退出钩子；launcher 只把 SIGINT 转给直接子进程）。但"孤儿"在本机**观测不到**——父进程被强杀后子进程约 2s 内消失，而同一台机器上 PowerShell 派生的子进程能存活 >10s，故判为**本会话环境**（Job Object）行为，不能据此认为真实机器不残留 | 机制成立 / 残留未复现 |
| P2-66 严重度建议 | **维持 P2，但须改写描述**（见 §5）：把"永久残留"降级为"崩溃/强杀路径残留，优雅停止干净"，同时**新增一条 P2**：隧道 kill 语义与更新/构建路径不一致（`child.kill()` vs `taskkill /T /F`） | 见 §5 |

---

## 1. cloudflared 存在性：本机没有，下载成功

### 1.1 查找（19:45–19:46）

```
（Get-Command 之外的直接查：where.exe）
where exit=1
INFO: Could not find files for the given pattern(s).

miss : C:\Program Files\cloudflared\cloudflared.exe
miss : C:\Program Files (x86)\cloudflared\cloudflared.exe
miss : C:\Users\guica\AppData\Local\Microsoft\WinGet\Links\cloudflared.exe
miss : C:\Users\guica\.cloudflared\cloudflared.exe
miss : \bin\cloudflared.exe          ← ChocolateyInstall 为空
miss : C:\cloudflared\cloudflared.exe
```

结论：**本机未安装 cloudflared**。这与审计 P1-16 的前提一致（"它不随 PiWeb 安装，是默认情况"）。

### 1.2 官方 Windows 版下载（19:46:13 → 19:46:44，31 秒）

```
& curl.exe -L --fail --connect-timeout 20 --max-time 240 \
    -o %TEMP%\piweb-verify-tunnel\cloudflared.exe \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
curl exit=0
curl 输出（末行）：100 52.83M 100 52.83M ... 1.73M ... (30s)

size  = 55,397,592  (52.83 MB)
mtime = 2026-11-13T19:46:43.8252080+08:00
SHA256= D5C1D82031DA6253DCDCFF64C944CD0FE063016EDEB2E4FD088075FC9BD52D0A

& cloudflared.exe --version
cloudflared version 2026.11.0 (built 2026-11-12T03:21 UTC)
exit=0
```

> 说明：下载体积（52.8MB）比任务书估的 20–30MB 大，是 2026.11.0 版本本身变大，不是下错东西——`--version` 已确认二进制可执行且自报版本。
> **全程未调用 `npm install`、未改 `package.json`/`package-lock.json`**。

---

## 2. 真实 quick tunnel

### 2.1 独立隧道指向 30141（19:50:35 → 19:51:40）

命令（与 `supervisor.spawnTunnel()` 同参数，仅 `--url` 指向既有服务的端口）：

```
cloudflared.exe tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:30141
```

**建立耗时（stderr 原始时间戳，UTC = 本地 −8h）**：

```
11:50:35Z INF Requesting new quick Tunnel on trycloudflare.com...
11:50:39Z INF |  Your quick Tunnel has been created! Visit it at ...
11:50:39Z INF |  https://knowledge-medieval-english-basics.trycloudflare.com   |
11:50:44Z INF Registered tunnel connection connIndex=0
           connection=b43ddac7-... event=0 ip=198.18.1.35 location=tpe01 protocol=http2
```

- 申请 → 拿到域名：**4 秒**
- 申请 → **connector 注册成功（Registered tunnel connection）**：**9 秒**
- 预检查全部 PASS（DNS / UDP-QUIC / TCP-HTTP2 / Cloudflare API），`suggested_protocol=http2`

**公网只读 GET（无 Cookie、无自定义头）**：

```
curl -sS -D - -w "http=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s \
      tls=%{time_appconnect}s first_byte=%{time_starttransfer}s total=%{time_total}s"
     https://knowledge-medieval-english-basics.trycloudflare.com/

http=403  dns=0.024788s  connect=0.026455s  tls=1.997388s  first_byte=3.971950s  total=3.973898s  size=42

HTTP/1.1 403 Forbidden
CF-Ray: a59d90d58c8ef251-KHH
Server: cloudflare

{"success":false,"error":"untrusted host"}

/api/health  via 公网 → http=403  {"success":false,"error":"untrusted host"}
/api/remote  via 公网 → http=403  {"success":false,"error":"untrusted host"}
```

**判读**：403 的 body 是 **PiWeb 自己的 JSON**（`next/server` 出口），不是 Cloudflare 的 1033/error 页 → 隧道确实把请求送到了 30141 的 PiWeb。403 的原因是 `isSafeHost()` 拒绝：**这个域名是"我的"隧道域名，30141 那个进程的 `PI_WEB_TRUSTED_HOSTS` 里当然没有它**（跨进程改 `process.env` 无效，这正是 `remote-tunnel.integration.test.ts:5-6` 注释里写的事）。

> 这也顺带证伪了一种常见误解："拿任意一个指向 PiWeb 的外部隧道就能打开" —— 打不开，一律 403。

### 2.2 应用自己的隧道 + 当前源码新构建（19:57:28 → 20:03:03）

上一轮用 `.next` 里 02:16 的旧构建试过一次，**结果作废**：`supervisor.ts` 改于 16:32、`instrumentation-node.ts` 改于 15:26，旧构建里根本没有 `Registered tunnel connection` 这段逻辑（grep 命中 0 个文件），表现是 public 从不自动启动。为不碰任何既有构建产物，改用仓库自带的隔离构建开关：

> 补记：30141 实际是 **`next dev`**（`bin/piweb.js --dev` → `next dev --webpack -p 30141 -H 127.0.0.1`，PID 30272，18:48:58 起），
> 它用 `.next-dev-webpack`，既不是 `.next` 也不是 `.next-releases/mweslqtb-…`（后者是打包发布的产物清单）。
> 所以隔离构建在"不碰 `.next`"这一点上是多余的谨慎，但换来的隔离仍然是对的（见 A.1 的披露）。

```
$env:PIWEB_BUILD_DIR = ".next-releases/audit-verify-tunnel"
node --max-old-space-size=8192 node_modules/next/dist/bin/next build --webpack
build exit=0 at 2026-11-13T20:01:18
→ .next-releases/active.json 未被改动（仍指向 mweslqtb-...），30141 不受影响
```

然后以生产模式起在**备用端口 30171**（LAN 30172，避开既有 30142）：

```
$env:PI_WEB_AUTH=1; $env:PI_WEB_TRUSTED_HOSTS=""; $env:PIWEB_REMOTE_LAN=1
$env:PIWEB_REMOTE_LAN_PORT=30172; $env:PIWEB_CLOUDFLARED=<临时目录>\cloudflared.exe（真二进制）
$env:PI_CODING_AGENT_DIR=<temp>\srv2agent; $env:HOME=<temp>\srv2home
node node_modules/next/dist/bin/next start --port 30171
```

**自动建连（当前源码的行为，`instrumentation-node.ts:40` → `ensureRemoteAccess()` → `startPublic()`）**：

```
server ready after 2s                                    (20:02:32)
publicUrl=https://expenses-profiles-gear-xbox.trycloudflare.com
status: public={"running":true,"url":"https://expenses-profiles-gear-xbox.trycloudflare.com",
                "ready":false,"engine":"cloudflared","engineAvailable":true,"error":null}
cloudflared child of server: PID=53244
=== 等 public.ready ===
tunnel reports ready after 18s                            (≈20:03:00)
```

> 对照组（失败的第一次，20:01:48 那轮）：拿到域名后**立刻**打公网，curl 报
> `curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed`（3 次连续失败）；
> 等到 `ready:true`（约 18 秒后）才成功。→ **实测支持 `TUNNEL_DNS_GRACE_MS = 15_000` 这个设计**：
> 域名刚出现时在全球 DNS 还不可用，立刻探测会失败。

**关键探测矩阵（20:03 左右，全部只读 GET）**：

| 探测 | 请求 | 结果 | 含义 |
|---|---|---|---|
| 公网根 | `GET https://expenses-profiles-gear-xbox.trycloudflare.com/`（无 Cookie） | **307**，`location: /login?next=%2F` | 页面请求走登录跳转（设计如此），不是 401 |
| 公网 API | `GET <公网>/api/remote`（无 Cookie） | **401** `{"success":false,"error":"authentication required"}` | **鉴权在隧道下生效**（任务预期项） |
| 本机 · 未登记域名 | `GET :30171/api/remote`，`Host: not-listed.example.com` | **403** `untrusted host` | Host 闸门有效（对照） |
| 本机 · 隧道域名 | `GET :30171/api/remote`，`Host: expenses-profiles-gear-xbox.trycloudflare.com` | **401** `authentication required` | **`allowTunnelHost()` 的运行时注入被 proxy 看见了** |
| 本机 · 回环无 Cookie | `GET 127.0.0.1:30171/api/remote` | **401** | 基线 |
| 本机 · 回环带 Cookie | 同上 + `Cookie: piweb_session_…` | **200**，返回完整 status | 认证链路通 |
| **停止后** · 隧道域名 | `POST {action:"stop"}` 之后，`Host: <隧道域名>` | **403** `untrusted host` | **`disallowTunnelHost()` 真的把域名摘掉了** |

**`POST /api/remote {"action":"stop"}` 的停止时序**：

```
stop response: public={"running":false,"url":null,"ready":false,"engine":null,...}
cloudflared exited 123ms after stop action
```

### 2.3 结论：403 还是 401，意味着什么（回答 `remote.md:486`）

`remote.md:486` 的原话质疑是：

> "请确认 Next 16.4.5 的 `proxy.ts` 运行时与路由处理共享同一 `process.env` 对象（若是独立沙箱且 env 是启动快照，公网入口会整体 403 `untrusted host`）"

**实测裁决：共享。** 证据是 §2.2 表格第 4 行 —— 同一个进程里 `allowTunnelHost()` 写入 `process.env.PI_WEB_TRUSTED_HOSTS` 之后，一个**带该域名的 Host 头**请求拿到 **401**（说明 `isSafeHost()` 通过了），而**未登记域名**拿到 **403**。如果 proxy 用的是启动快照，第 4 行必然也是 403。

这条结论的边界（务必一并记录）：

1. **白名单是"每进程"的**。应用自己的隧道 → 401；任何外部/第三方隧道（不是我进程建的）→ 403。所以"隧道域名白名单"不是全局开关，重启即失效（新进程 env 重新开始）。
2. **摘除是即时的**：stop 后同一个 Host 立刻 403，没有"域名还留在白名单里"的窗口（P2-66 担心的"给没人管的域名留后门"在**优雅停止**路径上不成立）。
3. **`/api/health` 也受 Host 闸门管**（§2.1 里公网打 `/api/health` 得到 403 而不是 200）。这符合 `proxy.ts:21` 里"Host 校验在认证判定之前、且对 health 的豁免在它之后"的顺序。副作用：健康探测方若用非本机 Host 访问会被 403，`tunnel-health.ts` 的探测用的是公网地址所以**依赖白名单已注入**——这点与实现一致（`spawnTunnel` 先 `allowTunnelHost` 再 `probeAllowed=true`）。

### 2.4 Ctrl+C 后进程是否立即退出：**1537ms，exit 0**

方法：新的控制台里起 cloudflared（`Start-Process`，独立 console），14 秒后从辅助进程
`FreeConsole()` → `AttachConsole(<cloudflared pid>)` → `SetConsoleCtrlHandler(NULL, TRUE)`（自己忽略）→
`GenerateConsoleCtrlEvent(CTRL_C_EVENT=0, 0)`。

```
pid=52816 started 2026-11-13T19:57:59.1075643+08:00
still running after 14s: yes
AttachConsole=True
GenerateConsoleCtrlEvent(CTRL_C_EVENT)=True at 2026-11-13T19:58:13.1538858+08:00
cloudflared exited after 1537ms; exit code=0
```

判读：不是"立即"（~1.5s），但**是优雅退出（exit code 0）且没有残留**。所以"用户在终端按 Ctrl+C"
这个最常见路径不会产生孤儿 cloudflared —— **前提是信号真的送到 cloudflared**（见 §3.1：实际代码里送不到，只送到 Next 服务进程）。

---

## 3. 进程树 kill 语义（P2-66 的机制验证）

### 3.1 先读代码：仓库里其实有**两套**互不相同的 kill 实现

| 子系统 | 实现 | 位置 | 语义 |
|---|---|---|---|
| **隧道** | `child.kill()` | `src/lib/remote/supervisor.ts:481`（`dropTunnel`）、`:600`（`stopPublic`） | Windows 上 = `TerminateProcess` **只杀该 PID**，不碰子进程树 |
| **更新/构建命令** | `taskkill /PID <pid> /T /F` | `scripts/process-runner.mjs:11` | 沿父进程链**整棵树**杀 |

补充事实（都影响 P2-66 的定性）：

- `spawnTunnel()` 的 spawn **没有 `detached`**（`supervisor.ts:505-508`）：`stdio:["ignore","pipe","pipe"], windowsHide:true`。
- **`src/lib/process-format.ts` 里没有任何 kill 实现**（`grep taskkill` / `grep kill` 均 0 命中），它是纯格式化模块——任务书里提到它可以忽略。
- **`src/` 全域零退出钩子**：`grep SIGINT|SIGTERM|beforeExit|process.on('exit')` 在 `src/` 只命中 `api/remote/route.ts:85`（HTTP 动作里的 `stopAll()`）和 supervisor 里的定义。**服务进程自己被杀时不会执行 `stopPublic()`**。
- `scripts/launcher.mjs:531-540` 的 Ctrl+C 处理只有一句：`const interrupt = () => { child.kill("SIGINT"); }` —— 只转给**直接子进程**（Next 服务进程）。cloudflared 是**孙进程**，收不到。

→ 代码层已经足以支持 P2-66："PiWeb 进程非正常退出时，没有任何东西去杀 cloudflared"。

### 3.2 实测矩阵（全部保留原始 PID）

实验用**替身**（`fake-cloudflared.mjs`：自己再拉一个 `node -e "setInterval(()=>{},1000)"` 孙进程）
以及**真 cloudflared.exe**。父进程名 `PiWeb`=替身。

| # | 父 → 子 | 停止方式 | 子/孙结局 | 原始证据 |
|---|---|---|---|---|
| S1 | node → node(非detached) | `child.kill()`（**仓库隧道路径**） | 孙进程一并消失 | 见 3.2.1 |
| S2 | node → node(非detached) | `taskkill /PID /T /F`（仓库更新路径） | 树全灭 | 见 3.2.2 |
| S3 | node → node(非detached) | `Stop-Process -Force` 仅父（**"PiWeb 崩了"**） | 孙进程消失（~2s） | 见 3.2.3 |
| Y1 | node → node(**detached**) | 仅杀父 | **孙进程存活** | 见 3.2.4 |
| Y2 | node → node(**detached**) | `taskkill /T /F` | 树全灭（含 detached 子） | 见 3.2.4 |
| P2e | node(explorer 启动) → node | 仅杀父 | 子进程消失 2237ms | 见 3.2.5 |
| **P2r** | node → **真 cloudflared.exe**（sup 同参数） | 仅杀父 | cloudflared 消失 2061ms | 见 3.2.6 |
| C1 | powershell → powershell | 仅杀父 | **子进程存活 >10s** | 见 3.2.7 |

#### 3.2.1 S1 — `child.kill()`（仓库隧道路径）

```
driver(node)=56048  fakeCloudflared=57780  grandchild(keepalive)=45432
BEFORE  Get-Process : 45432 node True / 57780 node True
        Win32_Process: PID=57780 Parent=56048 Name=node.exe
                       PID=45432 Parent=57780 Name=node.exe
child.kill() →
child.exitCode=null child.signalCode=SIGTERM child.killed=true
AFTER   Win32_Process: PID=57780 ABSENT / PID=45432 ABSENT
        parentAlive=false grandchildAlive=false
```

#### 3.2.2 S2 — `taskkill /PID <p> /T /F`

```
fakeCloudflared=40712  grandchild=3708
BEFORE  PID=40712 Parent=56048 / PID=3708 Parent=40712
taskkill exit=0
  成功: 已终止 PID 44300 (属于 PID 3708 子进程) 的进程。
  成功: 已终止 PID 9500  (属于 PID 40712 子进程) 的进程。
  成功: 已终止 PID 3708  (属于 PID 40712 子进程) 的进程。
  成功: 已终止 PID 40712 (属于 PID 56048 子进程) 的进程。
AFTER   PID=40712 ABSENT / PID=3708 ABSENT
```

#### 3.2.3 S3 — 只杀父（"PiWeb 崩了"）→ 替身孙进程

```
fakeCloudflared=51088  grandchild=49752
BEFORE  PID=51088 Parent=56048 / PID=49752 Parent=51088
Stop-Process(parent only) -> stopped
AFTER   PID=51088 ABSENT / PID=49752 ABSENT
按 ParentProcessId=51088 回查: （空）
```

#### 3.2.4 Y1/Y2 — detached 子进程是关键变量

```
Y1: A(parent)=22988 B(grandchild,detached)=41376  BEFORE A=true B=true
    taskkill /PID 22988 /F -> SUCCESS: The process with PID 22988 has been terminated.
    AFTER 3s: A=false B=true          ← 孙进程存活
Y2: A(parent)=45600 B(grandchild,detached)=30388
    taskkill /PID 45600 /T /F -> 终止 62900(child of 45600) / 30388(child of 45600) / 45600
    AFTER 3s: A=false B=false          ← /T 连 detached 子进程也能抓到
Y3: A(parent)=30164 B(grandchild,非detached)=23864
    taskkill /PID 30164 /F -> AFTER 3s: A=false B=false
```

#### 3.2.5 P2e — 从 explorer 启动（逃离工具调用的作业对象）再杀父

```
[11:59:47Z] === launched via explorer.exe (not a child of the DSH tool-call process) ===
[11:59:48Z] driver inJob=inJob=True
[11:59:48Z] piweb=42476 engine=54304
[11:59:51Z] BEFORE piweb=true engine=true
[11:59:53Z] taskkill /PID 42476 /F -> 成功: 已终止 PID 为 42476 的进程
[11:59:54Z] RESULT: engine died 2237ms after PiWeb was killed (no orphan)
```

#### 3.2.6 P2r — **真 cloudflared** 做子进程（最贴近真实场景）

```
[12:00:25Z] === spawn PiWeb(parent) -> real cloudflared(child) ===
[12:00:25Z] piweb=48828 cloudflared=55748
[12:00:31Z] tunnel registered=true url=https://aircraft-cave-anyone-cups.trycloudflare.com
[12:00:32Z] BEFORE: piweb=true cloudflared=true
[12:00:34Z] kill PiWeb only (taskkill /PID 48828 /F, NO /T): SUCCESS: ...
[12:00:35Z] RESULT: real cloudflared died 2061ms after PiWeb died
```

#### 3.2.7 C1 — 同机对照：非 node 的父子对

```
parent(shim powershell)=60904 child=62496 name=powershell.exe
BEFORE: childAlive=True
taskkill /PID 60904 /F → 成功
RESULT: non-node child SURVIVED 10s (normal Windows: orphan, no reaping)
```

### 3.3 怎么读这张表（必须写清楚的方法学限制）

1. **`child.kill()` 在 Windows 上确实只杀一个进程**（这是 libuv/`TerminateProcess` 的语义），所以 S1 之所以"孙进程也死"，**不是** `child.kill()` 的功劳。
2. 本次会话的每个进程都在一个 **Windows Job Object** 里：
   `Add-Type … IsProcessInJob(GetCurrentProcess())` → **`inJob=True`**；连
   `Invoke-CimMethod Win32_Process Create` 起的、和 `explorer.exe` 起的进程也都是 `inJob=True`
   （而用户自己的 `explorer.exe` PID=14880 是 `inJob=False`）。
3. 最有力的对照是 **C1**：同一台机器、同一分钟、同样的 `taskkill /F`，**PowerShell 派生的子进程存活了 >10 秒**。
   也就是说"子进程随父消失"这件事**不是这台机器的 Windows 语义**，而是**本次会话的 node 进程/作业对象环境**造成的（~2 秒的诊断延迟很像是轮询式回收）。
4. 因为 S1/S3/P2e/P2r 都在这个环境里，**"孤儿 cloudflared"在本机无法被观测到**。所以：
   - **不能**用本报告证明"真实机器上 cloudflared 一定残留"；
   - **但也不能**用它证明"不会残留"——C1 说明这是环境特性。
5. 代码层结论不依赖上面任何一条：`src/` 里没有退出钩子、launcher 只信号直接子进程、隧道 kill 不用 `/T`
   → **在没有任何"外部回收器"的普通 Windows 桌面上，PiWeb 崩溃/被强杀后 cloudflared 会存活**（Windows 不做级联终止，这是文档语义，也与 C1 的观测一致）。

### 3.4 对 P2-66 的机制判定

| 断言（P2-66 原文） | 判定 | 依据 |
|---|---|---|
| "进程退出不清理 cloudflared" | **成立** | §3.1：零退出钩子；`stopPublic()` 只在应用主动调用时跑；launcher 的 SIGINT 只到 Next 进程 |
| "Windows 不级联杀子进程" | **成立** | §3.2.4 Y1（detached 存活）、§3.2.7 C1（非 node 子进程存活）、`taskkill /T` 才成树（S2/Y2） |
| "→ 孤儿隧道进程" | **机制成立，本机未复现** | §3.3：本会话 job object 会在 ~2s 内回收；C1 证明这不是机器语义 |
| 隐含"优雅停止也残留" | **不成立** | §2.2：显式 stop 后 **123ms** 退出、域名立刻摘 | 
| 隐含"kill 能收干净树" | **不成立（反向）** | §3.1：隧道路径用单进程 kill，更新路径用 `/T`，两者语义不一致 |

---

## 4. Windows 上到底哪些用例从不执行

### 4.1 `grep` 结果（`tests/` 全域，剔除 `customType:"todo"` 之类误命中）

**A. 因为 `process.platform === "win32"` 被整组跳过（Windows 上零执行）——共 16 条**

| 文件:行 | 用例 | 条数 |
|---|---|---|
| `tests/integration/remote/tunnel-status.test.ts:20` | `describe.skipIf(process.platform === "win32")("tunnel status through API, process and HTTP")` —— 1033 恢复、readiness 超时后继续探测、并发启动合并、5 种"假隧道响应"识别、崩溃后摘地址、停止时丢弃在途探测、等地址期间停止再重建 | **11** |
| `tests/api/workspace-picker.test.ts:9` | `describe.skipIf(process.platform === "win32")("workspace picker API and native process")` | **5** |

实测确认（Windows 上跑这两个文件）：

```
 ↓ tests/integration/remote/tunnel-status.test.ts > ... (11 条逐条列出，全是 ↓)
 ↓ tests/api/workspace-picker.test.ts > ... (5 条)
 Test Files  2 skipped (2)
      Tests  16 skipped (16)
   Duration  8.15s
```

**为什么隧道那 11 条在 Windows 上跑不了（实测原因，不是猜测）**：
该用例的假 cloudflared 是**POSIX shebang 脚本**（`tunnel-status.test.ts:62`
`#!${process.execPath}` + `mode 0o755`）。在 Windows 上它既不能直接执行，也不是可 spawn 的映像：

```
fixture 首行: #!B:\Node.js\node.exe
按 supervisor.spawnTunnel 的方式 spawn(fixture, ["tunnel"]) →
SPAWN ERROR code=ENOENT msg=spawn ...\cloudflared-fixture ENOENT
```

→ 于是整组被 `skipIf(win32)` 掉。**换句话说：隧道进程生命周期（崩溃、重连、超时、停止竞态）在 Windows 上的测试是 0，而这恰恰是最容易出平台差异的部分。**

> 注意方向：`tests/lib/sandbox/{manager,readonly-mode,windows-acl}.test.ts`、`tests/powershell-encoding.test.ts`、
> `tests/agent-resource-isolation.test.ts:513` 用的是 `skipIf(!win32)` / `runIf(win32)`，**这些是只在 Windows 跑**，
> 不属于"Windows 零覆盖"。

**B. 环境变量锁住、任何平台默认都不跑——共 1 条（本次首次在 Windows 上跑通）**

| 文件:行 | 条件 | CI 会不会满足 |
|---|---|---|
| `tests/remote-tunnel.integration.test.ts:24,66` | `const RUN = process.env.PIWEB_TEST_TUNNEL === "1"` → `it.runIf(RUN)` | **永不**。`.github/workflows/check.yml` 只设 `PI_CODING_AGENT_DIR` / `PI_OFFLINE=1` / `NEXT_TELEMETRY_DISABLED`，矩阵是 `[ubuntu-latest, windows-latest] × [22.19.0, 24]`，`grep PIWEB_TEST_TUNNEL .github/` → 0 命中 |

**C. 非平台条件的 `it.skip`（顺带核实，供交叉引用）**

- `tests/lib/sandbox/shell-selection.test.ts:44` `it.skipIf(!hasGitBash)`
- `tests/lib/sandbox/windows-acl.test.ts:90` `it.skipIf(!process.env.PIWEB_TEST_BASH)` ← 需要手工 env
- `tests/proxy-status.test.ts:62`、`tests/system-proxy.test.ts:45` `it.skipIf(!…envProxy…)`
- `tests/mention-parity.test.ts:24,104` 依赖 pi autocomplete / fd 是否可用
- `tests/growth-service.test.ts:381` 运行期 `ctx.skip()`（Windows 符号链接权限）

### 4.2 实测 `PIWEB_TEST_TUNNEL=1 npx vitest run tests/remote-tunnel.integration.test.ts`

**有真 cloudflared（`PIWEB_CLOUDFLARED=<临时目录>\cloudflared.exe`）——通过：**

```
 ✓ tests/remote-tunnel.integration.test.ts (1 test) 31806ms
   ✓ real cloudflared tunnel (1)
     ✓ serves the LAN entry through a public https URL with the mobile CSS injected 31789ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  32.90s
vitest exit=0 at 2026-11-13T19:53:05
=== 测试结束后 cloudflared 进程表 ===
（只剩我自己手工起的那条隧道 PID=56652；测试自己起的已经没了）
```

这条通过的意义：**LAN 注入代理 → 真 cloudflared → 公网回拉 → 移动排版注入 → 配对发码 → 公网兑换 303 → Secure/HttpOnly Cookie → 带 Cookie 得 SIGNED-IN → 老码不可复用**，整条链路在 Windows 上**第一次被真实执行且全部成立**。同时 `afterAll` 里的 `stopAll()` 把 cloudflared 收干净了（**优雅停止不残留**，与 §2.2 一致）。

**它需要真引擎**：用例第 67 行 `const engine = process.env.PIWEB_CLOUDFLARED || managedEnginePath();`。
在没有 cloudflared 的机器上（本机默认情况），`spawn` 会 ENOENT → `markEngineMissing()` → `public.error` 非空 →
用例会一直轮询到 240 秒的最后期限才在 `expect(pub.error).toBeNull()` 上失败（**实测见 §4.3**）。
也就是说这条"锁住的测试"对环境的隐性要求（装 cloudflared + 能连 trycloudflare.com）**没有任何前置断言或提示**。

### 4.3 无引擎时的实测结果

见本文末尾「附录 A.4」——命令与输出原样记录。

---

## 5. 对 P2-66 严重度的修正建议

### 5.1 建议：**维持 P2**，但**必须改写描述**，并把"kill 语义不一致"另立一条

**理由 1（支撑维持，不降级）**：代码缺陷是确凿的、不依赖环境解释的部分——
`src/` 全域无退出钩子；`launcher.mjs:531-540` 只把 SIGINT 转给直接子进程；cloudflared 是孙进程；
`stopPublic()` 只有应用主动调用才跑。因此"PiWeb 崩溃 / 任务管理器强杀 / 终端窗口被关"这三条路径上
**没有任何代码会去停 cloudflared**。这是设计缺口，不会因为某台机器的 job object 恰好回收就消失。

**理由 2（支撑"改写"，不要写成"永久残留"）**：本次三组独立实测都表明**残留能被收掉**——
- 优雅停止：`POST {action:"stop"}` → cloudflared **123ms** 退出（§2.2）
- 整个 E2E 测试跑完：`stopAll()` 后进程表干净（§4.2）
- 真实 Ctrl+C：**1537ms**、exit 0（§2.4）
写成"进程退出不清理 → 孤儿隧道常驻"会**高估**。准确的表述是：
> "非正常退出路径（崩溃/强杀/直接关终端）没有清理动作；正常停止与 Ctrl+C 是干净的。
> 在带进程回收机制的环境里残留会被外部收掉；在普通桌面上会留下孤儿进程，直到下次重启或手工结束。"

**理由 3（支撑"不升级"）**：残留的实际安全影响有限——孤儿 cloudflared 仍指向 `127.0.0.1:30142`，
而新起的 PiWeb 进程的 `PI_WEB_TRUSTED_HOSTS` 里没有旧域名，所以旧公网地址打到新实例是 **403**
（§2.2 已实测：域名一摘立刻 403）。危害是**资源泄漏 + 一个仍可被外部探测到的公网端点（返回 403 JSON）**，
不是鉴权绕过。所以不适合升 P1。

### 5.2 建议新增一条 P2（本次实测发现的不对称）

> **隧道 kill 语义与更新/构建路径不一致**：`supervisor.ts:481,600` 用 `child.kill()`
> （Windows = `TerminateProcess` 单进程），而 `scripts/process-runner.mjs:11` 用
> `taskkill /PID <pid> /T /F` 整树杀。实测：`taskkill /T /F` 连 detached 孙进程都能收（Y2），
> `child.kill()` 在无 job object 的环境里只杀一个 PID（Y1）。
> 后果：现在引擎是 `cloudflared.exe`（无子进程）所以碰不到；一旦改成 `.cmd` 包装器/启动器
> （Windows 上 `spawn` `.cmd` 需要 shell，很容易走到"cmd.exe → cloudflared.exe"两层），
> 单进程 kill 会留下**真正的孤儿引擎**，且 DNS 白名单会先行摘除（"只剩一个没人管的隧道进程"）。
> 修法：隧道路径复用 `terminateProcessTree()`。

### 5.3 顺带修正 P2-103 / 附录 C #2 的两处表述

- P2-103 说"隧道类真实验证几乎为零"——**准确**，本次把 `PIWEB_TEST_TUNNEL=1` 的 E2E 在 Windows 上跑通了，建议把这条从"零验证"改成"已人工验证一次（2026-11-13），仍无 CI 门禁"。
- 附录 C #2 说"隧道进程在 Windows 上的退出/杀进程时序零真实验证"——**本次已补**（§2.4、§3），但**仍然没有 CI 门禁**，也没有自动化回归。建议把 `tunnel-status.test.ts` 的假 cloudflared 从 shebang 脚本改成 `.cmd`+`spawn(shell)` 或直接改成 `.exe` 形态，好让 11 条生命周期用例在 Windows 上真正执行——这是本次发现的**最高性价比修复项**。

---

## 附录 A：原始命令与输出（可复现）

### A.1 环境与边界

- 未修改任何仓库源码/测试/配置；`package.json`、`package-lock.json` 未变；未 `npm install`。
- 未 `git` 写；`git status` 与开工时一致（改动全部是开工前就存在的）。
- 未重启/未杀 30141 服务，仅对它发只读 GET。收尾复验：
  `GET http://127.0.0.1:30141/api/health → 200 {"success":true,...}`、
  `GET /api/remote → 401`（与开工前一致）、`netstat` 显示 30141 仍 LISTENING。
- `~/.pi`、`~/.codex`、`~/.claude` 全程只读：所有实验的 `HOME`/`PI_CODING_AGENT_DIR` 均指向 `%TEMP%\piweb-verify-tunnel\`。
- 唯一新增的仓库内产物：`.next-releases/audit-verify-tunnel/`（隔离构建目录，**未改 `.next-releases/active.json`**，收尾已移入回收站，见下方披露）。

**需要披露的一处副作用（30141）**：

```
20:04:57   30141 的 next dev 子进程换了一个 PID（21992 → 47680），
           父进程 bin/piweb.js --dev (PID 6032) 与 next dev (PID 30272) 仍是 18:48:58 起的原进程
20:05:08   我对 30141/api/health 的 8 秒超时探测失败（服务此刻正在重启子进程）
20:05:29   之后连续 3 次 200：{"success":true,"data":{"ok":true,"service":"piweb"}}
```

我全程只对 30141 发过**只读 GET**，没有重启/停止/杀它，也没有改它的配置。
同一时间窗内另一个审计子代理正在对 30141 做 300MB POST 压测
（`.audit-2026-11-13/verify-body-limit.md` 落盘于 20:03:26，对应审计附录 B #8 那条"内存缓冲压测"），
`next dev` 在该负载下重启 server 子进程是合理归因；我这一侧没有能触发它的操作（隔离构建 20:01:18 就结束了）。
**30141 的服务本身（父进程）从头到尾没被动过，20:05:29 起健康。**

### A.2 关键脚本（都在临时目录，收尾已清理）

| 文件 | 用途 |
|---|---|
| `fake-cloudflared.mjs` | 假引擎：自己再拉一个 node 孙进程，并按 supervisor 期待打印域名 + `Registered tunnel connection` |
| `tree-experiment.mjs` | S1/S2/S3 三场景（含前后 PID 表） |
| `z-parentdeath.mjs` / `x-reaper-probe.mjs` | detached 变量、job object 判定 |
| `wmi-outside-job.mjs` / `p2-orphan.mjs` | 试图逃离 job object 的对照 |
| `p2-real.mjs` | **真 cloudflared** 当子进程的孤儿测试 |
| `ctrl-c-test.ps1` | 真 `CTRL_C_EVENT` 计时 |
| `orchestrate.ps1` / `orchestrate2.ps1` | 真 cloudflared + 真 Next 服务（第二版用隔离构建） |

### A.3 关键文件位置

- 审计原文条目：`PiWeb_Audit_2026-11-13.md` L462（P2-66 所在表）、L612（附录 C #2）
- 区域报告未知点：`.audit-2026-11-13/remote.md:486`
- 代码：`src/lib/remote/supervisor.ts:481,505-508,585-605`、`scripts/process-runner.mjs:11`、`scripts/launcher.mjs:531-540`、`src/proxy.ts:21`、`src/lib/auth.ts:40-53`

### A.4 无引擎时跑被锁测试（原始输出）

```
PIWEB_TEST_TUNNEL=1  PIWEB_CLOUDFLARED unset; cloudflared on PATH:
  INFO: Could not find files for the given pattern(s).        ← 本机默认情况
start 2026-11-13T20:03:26.9751149+08:00

 ❯ tests/remote-tunnel.integration.test.ts (1 test | 1 failed) 241831ms
   ❯ real cloudflared tunnel (1)
     × serves the LAN entry through a public https URL with the mobile CSS injected 241829ms

 FAIL  tests/remote-tunnel.integration.test.ts > real cloudflared tunnel > ...
 AssertionError: 隧道失败：找不到 cloudflared：请先安装它
   （https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/）
   : expected '找不到 cloudflared：请先安装它（https://develop…' to be null
 - Expected: null
 + Received: "找不到 cloudflared：请先安装它（…downloads/）"
  ❯ tests/remote-tunnel.integration.test.ts:127:42
     127|  expect(pub.error, `隧道失败：${pub.error}`).toBeNull();

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Duration  242.65s
exit=1 at 2026-11-13T20:07:33
```

**判读**：没有引擎时，这条测试**不会快速失败**——它先花 **241.8 秒**把 `while (!ready && now < deadline)`
轮询到 240 秒上限，才在 `expect(pub.error).toBeNull()` 上报出"找不到 cloudflared"。
（`spawn` 的 ENOENT 早在第一秒就发生了，`markEngineMissing()` 也已把错误写进 `public.error`，
但用例只在轮询结束后才断言。）改进建议：轮询里一旦 `pub.error` 出现非空就 break，或把
`engineAvailable` 前置断言成"未安装则 skip 并打印原因"，可把 4 分钟的哑等变成 1 行明确提示。

---

## 附录 B：本次没能验证的

1. **孤儿 cloudflared 在普通桌面上的真实存活时长**——本机所有进程都在 Job Object 内（`inJob=True`，
   连 explorer 起的也是），非 detached 子进程会在 ~2s 内被回收；C1（PowerShell 父子对存活 >10s）
   说明这是环境特性而非机器语义。要证实需要一台没有 job object 的机器，或临时给 PiWeb 加 `detached`。
2. **真实"关终端窗口"路径**：本会话没有交互式终端，"用户直接关掉终端"产生的是 `CTRL_CLOSE_EVENT`，
   本次只测了 `CTRL_C_EVENT`。
3. **trycloudflare 被墙/限流时的表现**：本机网络到 Cloudflare 正常（预检查全 PASS、`location=tpe01`），
   未构造失败场景。
4. **移动端真机过隧道**：无真机，只有 curl 级验证。
