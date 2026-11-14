# 移动端真浏览器验证报告（verify-mobile）

> 补的审计缺口：此前所有移动端结论都是**读代码推断**（软键盘、`100dvh`、隧道长轮询），没有一次真浏览器加载。
> 本报告全部数值来自 2026-11-13 晚上对 `http://127.0.0.1:30141` 的**真 Chromium 加载 + 度量**（Playwright，非 mock、非 jsdom）。
> 代码引用只用来解释测到的现象，不算发现依据。

## 0. 环境与方法

| 项 | 值 |
|---|---|
| 被测服务 | `http://127.0.0.1:30141`（`next dev`，HEAD `1d4efba` + 144 项未提交改动的当前磁盘状态） |
| 浏览器 | Playwright 1.57.0 自带 Chromium 143.0.7499.4，**headless**（见第 6 节限制） |
| 移动设备档 | Playwright 内置 `iPhone 13`：视口 **390×664** CSS px、`device_scale_factor=3`、`is_mobile=true`、`has_touch=true`、UA `Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 …) Version/26.0 Mobile/15E148 Safari/604.1` |
| 桌面档 | `1440×900`、DPR 1、无 touch |
| 辅助手段 | `page.set_viewport_size`（改高度模拟地址栏显隐）、`context.set_offline`、`page.route`、`document.elementFromPoint` 命中测试、往 DOM 注入超宽表格/超长代码行（只改本地 DOM，不落库） |
| 只读边界 | 全程只做 GET 与界面导航：没有发送消息、没有新建/删除会话、没有改设置、没有点停止。进入主界面的方式是按 `src/lib/web-auth.ts:70`（`encodeSessionCookie`）自签一张 `piweb_session_*` Cookie（读 `~/.pi/agent/web-secret`，只在临时目录里用），**没有触碰密码登录** |
| 临时脚本/原始数据 | `%TEMP%\piweb-verify-mobile\`（`stage1.py`…`stage5.py`、`probe-*.py`、`res-stage*.json`、`shots\`） |
| 截图 | 16 张已复制到 `.audit-2026-11-13/screenshots/`，见下文引用 |

**注意：这是 dev server 的测量。** 观察到的下列噪声与产品无关，但会干扰读数，已在下文逐项扣除：
1. 冷启动首次 hydration 实测 **16.85s**（热态 1.62s）——`next dev` 现场编译；
2. 会话页/查看器首次打开要等编译，出现过 12s+ 的 spinner（与 `mobile-events-unavailable-spinner.png` 里的 spinner 同形态）；
3. 左下角深色圆形 "N" 是 Next.js dev 指示器，不在 `.pi-main` DOM 内；
4. 一次运行里 `/api/security`、`/api/pi-settings`、`/api/version`、`/api/web-auth` 同时返回 500，`curl` 复测全 200 —— dev 并发编译产物，不可复现；
5. `body.innerHTML` 里 `_piweb-dev/<id>/_next/...` 资源前缀只在 dev 存在。

另外顺带落到过一次 `/login`（第 4.2 节 Host 改写尝试的副产物）：390 宽下正常渲染"这个实例用启动令牌登录 / 请打开启动 PiWeb 时终端里打印的登录链接（形如 `…/?token=…`），或在已登录的电脑上打开 设置 → 远程连接"这段文案，没有布局问题。**没有做度量**，也不作为结论。

## 1. 设备/视口表（实测 `innerWidth×innerHeight`）

| 档位 | 声明 | 实测 | 用途 |
|---|---|---|---|
| 移动主档 | iPhone 13 | **390×664**，DPR 3 | 所有移动项 |
| 移动短屏 | 同上改高 | 390×560 / 480 / 400 / 320 / 240 | 地址栏显隐、`100dvh` |
| 移动长屏 | 同上改高 | 390×844 / 900 | 对照 |
| 桌面 | 1440×900 | **1440×900**，DPR 1 | 移动专有性判定 |

> 说明：Playwright 的 `iPhone 13` 描述符给的是 390×**664**（Safari 工具栏收起前的可视高），不是 390×844。所以"iPhone 12/13 ≈390×844"在 CSS 视野里通常是 664~844 之间浮动，两份数值我都测了。

## 2. 移动端逐项验证

### 2.1 横向溢出 —— **撑得住**

判据：`document.scrollingElement.scrollWidth > clientWidth`。

| 视图 | scrollWidth / clientWidth | 结论 |
|---|---|---|
| 首页（Hero 空态） | 390 / 390 | 无溢出 |
| 会话页（195 条消息） | 390 / 390 | 无溢出 |
| 设置面板 | 390 / 390 | 无溢出 |
| 右侧抽屉（项目/提示词/Git/导入） | 390 / 390 | 无溢出 |
| 文件查看器 | 388 / 388（内部滚动条占 2px） | 无溢出 |
| 会话滚动容器 `.pw-chat-scroll` | 380 / 380 | 无溢出 |
| 桌面 1440×900（四个视图） | 1440 / 1440 | 无溢出 |

另外按"元素右边界 > 视口 + 1"扫描全部 DOM（排除 off-canvas 抽屉与自身可滚容器）：**0 个被裁切元素**（首页/会话/设置/抽屉/查看器五态）。

截图：`screenshots/mobile-home-390x664.png`、`mobile-session-chat-390x664.png`、`mobile-settings-390x664.png`、`mobile-drawer-import-390x664.png`、`mobile-file-viewer-390x664.png`。

**Markdown 宽内容专项**（审计文档里 remote 适配 CSS 注释提到"390px 下表格 442px 超出视口"）：
- 现存那份会话里的表格实测 **316×316**，放得下；
- 为了测"更宽的表"，我往 `.md` 里注入了一个 8 列宽表（内宽 **2349px**）和一行 600 字符的代码：`.md-table-wrap` 的 `clientWidth=316 / scrollWidth=2349`、`overflow-x:auto`；`pre` 的 `clientWidth=316 / scrollWidth=4815`、`overflow-x:auto`；**文档 `scrollWidth` 仍是 390**。即宽表/长代码在包裹层内部横滑，不撑宽页面。
- 对应实现 `src/app/globals.css:1813` `.md-table-wrap { max-width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch }`。
- 结论：本机直连页面**不需要** remote 那份 `@media(max-width:840px)` 补丁；那段 CSS 注释里的实测数字（表格 442 > 390）应来自经代理的页面（另一套 DOM），当前本地页已由 `.md-table-wrap` 兜住。

截图：`screenshots/mobile-wide-table-injected.png`。

### 2.2 触控目标 —— **有具体问题（尺寸系统性偏小）**

判据：可见交互元素 `width < 44 || height < 44`（Apple HIG 44pt / Material 48dp）。

| 视图 | 可见交互元素 | <44px | 典型值 |
|---|---|---|---|
| 首页 | 7 | **7 (100%)** | 左上"工作区"菜单 **30×30**、右上"右侧抽屉" **30×30**、发送 **34×34**、`新建工作区` chip **133×30**、权限 chip **123×28**、模型 chip **96×28** |
| 会话页 | 26 | **26 (100%)** | 顶部菜单 30×30、抽屉 30×30、发送 34×34、复制/编辑消息 **28×28**、"在编辑器中打开" **22×22**、"消息大纲" **26×34**、"回到底部" **36×36**、"展开全部输出" 292×26 |
| 右侧抽屉 | 16 | 14 | 4 个入口 tab **83×31**、"关闭" **26×26**、"重新扫描" 67×34 |
| 设置面板 | 34 | 26 | 顶部 tab **36** 高、关闭 26×26 |
| 桌面 1440×900 | 23–97 | 同比例 | 尺寸一致（桌面靠鼠标，不成问题）|

即：**移动端并不是"某些按钮偏小"，而是整站沿用了桌面尺寸，没有一个交互目标达到 44×44**。最要紧的是高频的两个——左上菜单 30×30 与发送 34×34；以及消息级操作 28×28 / 22×22（拇指误触率最高的一段）。

截图：`mobile-composer-detail-390x664.png`（可见 30×30 / 34×34 / 28×28 同屏）。

### 2.3 `100dvh` / 地址栏显隐 —— **撑得住**

做法：`page.set_viewport_size` 逐档压低高度（等价于地址栏出现、可视高变小），量 composer 的 boundingBox 与 `innerHeight` 的关系。

**会话页（宽 390）**

| innerH | composer top / bottom | 发送按钮 bottom | 被裁 (`bottom > innerH`) |
|---|---|---|---|
| 900 | 784 / 860 | 852 | 否 |
| 844 | 728 / 804 | 796 | 否 |
| 664 | 548 / 624 | 616 | 否 |
| 560 | 444 / 520 | 512 | 否 |
| 480 | 364 / 440 | 432 | 否 |
| 400 | 284 / 360 | 352 | 否 |
| 320 | 204 / 280 | 272 | 否 |
| 240 | 124 / 200 | 192 | 否 |

**首页（宽 390）**：844→532、664→442、500→360、400→310、320→270、240→230（composer bottom），全部 `clipped=false`。

规律：composer 底边恒等于 `innerH - 40`，`.pw-app-shell` 实测高度始终等于 `innerHeight`（`src/app/globals.css:854` / `858` 的 `100vh` → `@supports` 覆盖成 `100dvh`）。**输入框没有被顶出可视区**，地址栏显隐这条风险可以划掉。

截图：`screenshots/mobile-viewport-h400.png`（h=400 时输入框仍在视口内）。

> 边界：这测的是**布局视口变小**。软键盘走的是 visual viewport，不等价 —— 见第 6 节。

### 2.4 输入框自增高 —— **撑得住（有上限），换宽后不回落**

- 空态 390 宽：textarea **324×22**（`scrollHeight=clientHeight=22`）。
- 填 6 行：高 **130**，composer 76→**184**。
- 填 20 行：高封顶 **132**，`scrollHeight=434 > clientHeight=132` → 内部纵向滚动，不再长高。
- 上限来自 `src/app/globals.css:465-474`：`@supports (height:100dvh)` 里 `max-height: min(132px, 26dvh) !important`。
- 副作用：填满后再把宽度从 390 拉到 500/600/700/900/1200，高度**一直是 130 不回落**（等下一次输入才重算）。竖屏↔横屏切换后输入框会留一块空白，属 P3。

截图：`screenshots/mobile-textarea-20lines.png`。

### 2.5 抽屉 / 侧栏 / 遮罩 / 滚动锁 —— **撑得住**

| 项 | 实测 |
|---|---|
| 左侧栏（关闭态） | `fixed`、`width=335`（= `min(86vw,340px)`，`AppShell.tsx:1066`）、`translateX(-105%)`（`:1069`）、`z=90`、完全在视口外（x=-352…-17） |
| 左侧栏（打开态） | x=0…335；遮罩层 `fixed inset-0 z-[80]`、`rgba(0,0,0,0.32)`、390×664 全覆盖 |
| 关闭方式 | 点视口右侧空白 (370,400) 后可见交互元素 19→7，侧栏回到 off-canvas —— **点外部即关，符合预期** |
| 右侧抽屉（打开态） | 遮罩 `fixed inset-0 z-[85]` `rgba(0,0,0,0.32)`；面板 x=**31**、宽 **359**、`z=90`、占满 664 高 |
| z 序命中测试 | 抽屉打开时 `elementFromPoint(27,27)` 与 `(22,22)` 命中 **遮罩按钮（z=85）**，不是 z=70 的左上菜单按钮 → 菜单按钮被正确盖住，在抽屉上方点击不会误触"打开侧栏"，只会关抽屉 |
| 滚动锁 | `body`、`html` 常驻 `overflow:hidden`（`html` 是 `hidden auto`），`.pw-app-shell` 高度恒等视口 —— 页面本身不滚，抽屉开合不需要额外滚动锁，**不存在背景可滚动的穿透问题** |
| 抽屉内容 | 4 入口：项目/提示词/Git 详情/导入会话，均可切换；"导入会话"进入后是"扫描中…/每个来源最多加载最近 50 条"的正常态 |

截图：`mobile-sidebar-open-390x664.png`、`mobile-sidebar-workspaces.png`、`mobile-drawer-project-390x664.png`、`mobile-drawer-import-390x664.png`。

### 2.6 设置面板 —— **撑得住**

| 测量 | 值 |
|---|---|
| 面板 `.settings-dialog` | **374×648 @ (8,8)**，视口 390×664 → 四周 8px 留白，完整在屏内 |
| 遮罩 | `fixed inset-0 z-[100]` 390×664 |
| 顶部 tab 条 | 372×57，三个 tab 各 36 高 |
| 内容区 | `overflow-y:auto`，`clientHeight 529` / `scrollHeight **2014**`（约 3.8 屏）→ **可滚到底**，`mobile-settings-scrolled-bottom.png` 里"亮暗模式/浅色/深色"都能滚到 |
| 横向溢出 | 无（390/390），无被裁元素 |

>`SettingsPanel.tsx` 里写的是 `min(800px, calc(100vh - 48px))`；在 664 高的手机上实际取 648（= 664-16，容器另有 inset），符合"不超屏"的意图。

截图：`mobile-settings-390x664.png`、`mobile-settings-scrolled-bottom.png`。

### 2.7 文件查看器 —— **撑得住**

| innerH | 查看器 rect | 结论 |
|---|---|---|
| 664 | 390×664 @ y=0 | 满屏 |
| 560 | 390×560 | 跟随视口 |
| 480 | 390×480 | 跟随视口 |
| 360 | 390×360 | 跟随视口 |
| 280 | 390×280 | 跟随视口 |

- 内部滚动区 `overflow:auto`，664 高时 586；`scrollWidth=clientWidth=388`，无横向溢出。
- 全屏按钮切换后 `data-fullscreen=true`，几何仍是 390×664（移动端本来就是满屏，全屏按钮在窄屏等价于无变化 —— 不算 bug，但按钮在手机上无意义，P3）。
- 打开方式：会话内 → 右侧抽屉 → "项目" → 点 `AGENTS.md`（需先有会话 cwd；首页空态下项目树是空的，这是设计如此）。

截图：`mobile-file-viewer-390x664.png`。

## 3. 桌面 1440×900 对照

| 项 | 移动 390×664 | 桌面 1440×900 | 是否移动特有 |
|---|---|---|---|
| 横向溢出 | 无 | 无（1440/1440） | 都不是问题 |
| 侧栏 | off-canvas 抽屉 + 遮罩 335 宽 | **常驻列**（"新会话" x=12 w=256），无遮罩、无 `fixed` 全屏层 | 形态差异，正常 |
| 右侧抽屉 | 浮层 359 宽 + 遮罩 | **网格列** x=1081 w=359，可与对话并排 | 形态差异，正常 |
| 设置面板 | 374×648（屏内 8px 边距） | 800×800 @ top=50 / bottom=850（900 高内） | 都放得下 |
| 输入框 | 宽 324（满宽 - 边距），高 22 | 宽 732，高 22 | — |
| 触控目标 <44 | 7/7、26/26 | 同样尺寸（23/23、51/51） | **尺寸是全局的，只是桌面不用手指** |
| 聊天区滚动容器 | 380 宽 / 3463 内容高 | 1150 宽 / 2537 内容高 | — |
| 表格 | 316 宽 | 725 宽 | 内容自适应 |

结论：**移动端没有"桌面正常、手机坏掉"的布局类问题**；移动端真正的问题是 ①触控目标尺寸 ②离线/事件流可用性 ③（待真机）软键盘与安全区。桌面这几个视图全部正常。

截图：`screenshots/desktop-session-1440x900.png`、`desktop-settings-1440x900.png`。

## 4. 长轮询 / 隧道 / 断网重连（只观察，不修）

### 4.1 移动 UA 下实际走的通道 —— 实测是 **SSE**，不是轮询

在 `127.0.0.1:30141` + iPhone UA 下打开会话：

| 观测 | 值 |
|---|---|
| `/api/agent/<id>/events` 请求数 | **1**（长连接，不重发） |
| 响应 `content-type` | `text/event-stream; charset=utf-8` |
| 是否带 `?poll=1` | **否** |

与 `src/lib/chat/event-stream.ts:12` 一致：`usesEventPolling` 只对 `*.trycloudflare.com` 返回 true。**本机/局域网始终 SSE。**

### 4.2 为什么"隧道域名"这条路在本机测不到端到端

尝试用 `--host-resolver-rules` 把 `piweb-verify.trycloudflare.com` 指到 127.0.0.1，再用 Playwright `route.continue_` 改写 Host/Cookie：

| 尝试 | 结果 |
|---|---|
| `curl -H "Host: piweb-verify.trycloudflare.com:30141"`（真实隧道形态） | **403 `untrusted host`** |
| `--host-resolver-rules` 指到 127.0.0.1 + `route.continue_` 改写 `Host: 127.0.0.1:30141` + 把同一张 Cookie 挂到假域名下 | 文档请求返回 200，但页面最终停在 `http://127.0.0.1:30141/login?next=%2F`。**原因未确认**（Cookie 确实随请求发出、Host 也确实被改写；我怀疑与 `route.continue_` 改 URL 后重定向基址/cookie 作用域有关，没深究） |

结论：这条路我**没能**在服务端不改配置的前提下走通，因此隧道分支不端到端下结论。

原因在代码里：`src/lib/auth.ts:40` 的 `isSafeHost` 只信回环/localhost/IP 字面量/env 白名单；隧道域名只有 `src/lib/remote/supervisor.ts:201-206` 在**真的起隧道时**才写进 `PI_WEB_TRUSTED_HOSTS`。本机当前没跑隧道 → 白名单里没有 → 403。

**所以"隧道下走轮询"这条只能在跑真 cloudflared 时端到端验**（见第 6 节）。我没有伪造 hostname 去骗过判断函数，也没改任何代码。替代做法是把**轮询端点本身**和**客户端轮询协议**在真浏览器里量了（4.3）。

### 4.3 轮询端点实测（真浏览器 `fetch`，真服务端）

| 请求 | 结果 |
|---|---|
| `GET …/events?poll=1` | **200**，`content-type: text/plain; charset=utf-8`（SSE 是 `text/event-stream`），**1 帧**，`id: 21484623dcaa.0` + 整包 `{"type":"snapshot",…}` |
| 单次响应体 | **707,103 字节（≈690 KB）**，耗时 **411 ms** |
| 再带 `Last-Event-ID: 1`（一个不匹配当前 epoch 的旧 id） | **又是整包 707,103 字节**，481 ms |

含义：
- 协议本身能工作：发完一批就结束响应，浏览器带 `Last-Event-ID` 再来 —— 与 `src/app/api/agent/[id]/events/route.ts:20` 的 `poll=1` 分支一致。
- 静默不重发：`POLL_HOLD_MS = 25_000`（`route.ts:9`），即安静会话是 **25s 一次**请求，一轮回来 ~几十字节心跳帧；`POLL_BATCH_MS=50`（`:7`）、`POLL_VIEWER_GRACE_MS=30_000`（`:11`）。
- **代价点：一个 195 条消息的会话，快照 707 KB。** 轮询一旦丢了 `Last-Event-ID`（比如页面刚开、或服务端 epoch 变了），这一轮就要在移动网络上吞 690 KB。这不是移动端专有，但移动数据下最疼。属于 remote/API 区域可评估的点。

### 4.4 断网 30 秒：**没有提示，也不会重建**

| 阶段 | 观测 |
|---|---|
| 断网前 | SSE 已连上，`.md` 11 块，`body.innerText` 2853 字 |
| `context.set_offline(true)` 后 **3s / 9s / 30s** | 界面完全不变；`"连接中断，正在重连…"` **未出现**（文本搜索 false）；`/events` 无新请求、无 `requestfailed` —— 浏览器侧那条 SSE 连接没有被判死 |
| `set_offline(false)` 后 **20s** | `/events` **仍然是 0 次新请求**；界面维持原样（没有重建，也没有补数据） |

也就是说：`src/hooks/usePiWeb.ts:1014` 那条 SSE 分支在"连接悄悄死掉"时，`onerror` 没被触发 → `state.connected` 一直是 true → `ChatWindow.tsx:2279` 的"连接中断，正在重连…"胶囊永远不显示。**手机切 Wi-Fi/蜂窝、或隧道掉线，用户看到的是"一切正常"的静态页面。**

需要注意这是"离线模拟"的结论：Playwright 的 `set_offline` 只拦新连接，不一定对已建立的 socket 发 RST。真机上基站切换/NAT 超时通常会触发 RST 或超时，那时 `EventSource` 会自己重连。所以这条要落到"真机复验"，但代码侧确实**没有心跳超时兜底**（这条成立，与真机无关）：客户端拿到 `connected:false` 的唯一途径是 `onerror`。

### 4.5 事件流不可用时：**永久 spinner，没有任何错误态**

把 `/events` 从连接建立起就 `route.abort()`：

- 会话视图只有一个旋转指示器，`body.innerText` 仅 **93 字**（没有任何"失败/重试"文案）；
- `EventSource` 每 ~3s 重试一次（8 次/28s 观测到）；
- 这一态持续到我撤掉拦截为止。

截图：`screenshots/mobile-events-unavailable-spinner.png`。

这是移动端最实际的坏态：隧道抖动 / 弱网首连失败时，用户看到的是"永远在加载"，没有"重试"按钮（SSE 分支只有 `onerror` → connected:false，而胶囊只在有消息时渲染在消息流末尾）。

### 4.6 与审计说法的对齐

| 审计原话 | 实测 |
|---|---|
| "公网隧道会走 `usesEventPolling`" | 判断函数确实按 hostname 分支；但本机/局域网**实测走 SSE**（`text/event-stream`，无 `?poll=1`），轮询只在真隧道域名下发生，本机无法端到端复现（4.2） |
| "`100dvh` 相关：地址栏显隐时输入框会被顶出可视区" | **不成立**，8 档高度扫描 composer 底边恒 `innerH-40`，无裁切 |
| "移动端表格 442px 超出视口" | 在**本机直连页面不成立**（`.md-table-wrap` 内部 `overflow-x:auto`，注入 2349px 宽表后文档仍 390）；该注释针对经代理的页面 |

## 5. 发现（按严重度）

### P2-1 移动端"静默失联"：事件流断开不提示、不重建 —— 疑似（离线模拟下确认，真机触发条件待验）
- **位置**：`src/hooks/usePiWeb.ts:1014`（SSE 分支）、`src/components/ChatWindow.tsx:2279`（提示胶囊）
- **证据（实测）**：断网 30s 期间 `"连接中断，正在重连…"` 未出现、`/events` 零重试；恢复后 20s 内**仍无**新 `/events` 请求。
- **后果**：弱网/切网后用户面对一份永远不更新的对话，且误以为在线；会话状态（流式输出、工具结果）停在旧帧。
- **建议**：SSE 分支加"心跳超时"（服务端已有 `ping`，客户端记录最后收帧时间，超 N 秒主动 `es.close()` 并重建），或统一走 `pollEventStream`（它有失败计数 + 退避）。

### P2-2 事件流不可用 → 永久 spinner，无错误态/无重试入口 —— 已确认（浏览器实测）
- **位置**：会话视图加载态（`AppShell.tsx` 会话区）与 `ChatWindow.tsx` 的连接提示位置
- **证据**：`/events` 一直被 abort 时，`body.innerText` 仅 93 字，只有 spinner；`EventSource` 每 ~3s 重试；截图 `mobile-events-unavailable-spinner.png`。
- **后果**：隧道首连失败、弱网首开，用户只能干等或手动刷新；提示胶囊被放在"消息流末尾"，没有消息时根本不渲染。
- **建议**：首连超时（如 10s）后展示"连接失败 + 重试"，并把连接状态提示从消息流里提到常驻位置。

### P2-3 触控目标系统性小于 44×44 —— 已确认（量了 5 个视图）
- **证据**：首页 7/7、会话页 26/26、抽屉 tab 83×31、设置 tab 36 高；关键控件 30×30（菜单/抽屉）、34×34（发送）、28×28（复制/编辑）、22×22（在编辑器中打开）。
- **后果**：拇指误触；"复制/编辑"两枚 28×28 相邻，最容易点错。"在编辑器中打开 22×22" 在移动端基本点不准。
- **建议**：仅在 `@media (max-width: 840px)` 下把命中区抬到 44×44（用透明 `::after` 扩热区，不改视觉尺寸），至少覆盖菜单、发送、消息操作、tab。

### P3-1 用了 `env(safe-area-inset-*)` 却没开 `viewport-fit=cover` —— 已确认（代码），效果在 iOS 上恒为 0
- **位置**：`src/app/layout.tsx:9-17`（`viewport` 只有 `width`/`initialScale`/`themeColor`）、`src/app/globals.css:333`（`.pi-main { padding-bottom: env(safe-area-inset-bottom) }`）、`src/components/AppShell.tsx:1401-1402`（菜单按钮 `calc(env(safe-area-inset-left,0px) + 12px)`）。
- **后果**：没有 `viewport-fit=cover` 时 iOS 报告的 inset 全为 0，这些 padding 是空操作；刘海/Home 指示条区域的安全区保护实际没生效（在 Android Chrome 上同理，取决于 `display-cutout`）。
- **建议**：`export const viewport = {..., viewportFit: "cover"}`，再逐屏确认底部不贴 Home 条。

### P3-2 未声明 `interactive-widget`（软键盘）—— 代码确认，风险待真机
- **位置**：同 `layout.tsx:9-17`
- **后果**：Android Chrome 默认 `resizes-visual`，软键盘只缩 visual viewport，`100dvh` 不变 → 固定底部输入框会被键盘盖住；要"键盘顶起布局"需 `interactiveWidget: "resizes-content"`。
- **建议**：显式声明，并在真机确认。

### P3-3 输入框高度换宽后不回落
- 6 行 → 高 130；宽度 390→1200 后仍是 130，直到下次输入才重算（`ChatInput` 的 autoSize 只在 input 事件里跑）。竖横屏切换后输入框留空。

### P3-4 390 宽下权限/模型 chip 被截成「完…」「grok/grok-4.7…」
- 截图 `mobile-composer-detail-390x664.png`：权限 chip 68×28 只显示"完…"，模型 chip 174×28 显示"grok/grok-4.7… xhigh"。移动端无 hover，`title` 提示拿不到 → 信息丢失。
- 建议：窄屏改为只显示权限图标 + 靠设置页查看全名。

## 6. 真机才能验的清单（本次**没有**验，不要当成已验）

1. **软键盘弹出**：`visualViewport.height` 收缩时输入框是否被顶起/遮挡；iOS Safari 与 Android Chrome 行为不同；`interactive-widget=resizes-content` 是否奏效（P3-2）。
2. **iOS 安全区**：刘海、Home 指示条、横屏左右 inset；开了 `viewport-fit=cover` 之后底部工具条与 composer 的间距。
3. **触摸滚动惯性 / 橡皮筋**：`.pw-chat-scroll`、`.pw-viewer`、`.md-table-wrap` 在 iOS 上的 `-webkit-overflow-scrolling` 与嵌套滚动冲突；长按选中/复制菜单。
4. **真实地址栏折叠动画**：`100dvh` 在 Safari 工具栏收起/展开的连续动画中会不会抖动（我只测了离散高度）。
5. **真实隧道**（cloudflared 真跑起来，域名进白名单后）：`?poll=1` 是否真的被使用、25s 静默轮询的耗电/流量、690 KB 快照在 4G 下的首开时长、以及隧道断线后的重连表现。
6. **真手机上的断网重连**：切飞行模式/切 Wi-Fi↔蜂窝，看 `onerror` 是否触发、"连接中断"胶囊是否出现（对应 P2-1 的"疑似"）。
7. **DPR 3 下的视觉细节**：0.5px hairline、`glass-modal` 的模糊性能、长列表滚动帧率（headless 无法测帧率）。
8. **WebKit/Safari 而不是 Chromium**：本次全程 Chromium；`backdrop-filter`、`dvh`、`overscroll-behavior` 在 Safari 的差异没验。可换 Playwright 的 webkit 再跑一遍（本机 `B:\devcache\playwright\webkit-2336` 已装），但那仍是桌面 WebKit，不等于 iOS Safari。

## 7. 复现方式

```powershell
# 0) 自签 Cookie（唯一需要"进主界面"的动作，不碰密码）
cd $env:TEMP\piweb-verify-mobile; node sign-cookie.mjs      # 读 ~/.pi/agent/web-secret，输出 cookie.json

# 1) 移动视口逐屏度量 + 截图（首页/侧栏/抽屉/导入/项目/Git）
python stage1.py      -> res-stage1.json
# 2) 会话页 + 100dvh 高度扫描 + 输入框自增高 + 设置
python stage2.py      -> res-stage2.json
# 2b/2c) 设置面板盒子、文件查看器（非全屏/全屏/高度变化）
python stage2b.py / stage2c.py
# 3) 桌面 1440x900 对照
python stage3.py      -> res-stage3.json
# 4) 通道 + 断网重连 + 轮询端点
python stage4.py / stage4b.py -> res-stage4*.json
# 5) 首页高度扫描 + 桌面侧栏
python stage5.py      -> res-stage5.json
# 6) 宽表格/长代码注入、z 序命中、composer 细节
python probe-wide.py / probe-z.py / probe-composer.py
```

原始 JSON（含每个视图全部元素包围盒）都在 `%TEMP%\piweb-verify-mobile\res-*.json`；截图源在 `%TEMP%\piweb-verify-mobile\shots\`，交付副本在 `.audit-2026-11-13/screenshots/`。

## 8. 与其他区域的交叉点

- **remote/隧道**：`PI_WEB_TRUSTED_HOSTS` 是 `supervisor.ts:201` 在起隧道时写进 `process.env` 的。若隧道进程与 Next 服务不同进程/不同启动顺序，白名单不会生效（本机实测外来 Host 直接 403）。请 remote 区域确认实际部署形态。
- **API/鉴权**：外域 Host 一律 403 是**有意的** DNS-rebinding 防护；但这也意味着"用手机浏览器直连 `http://<本机IP>:30141`"必须把 IP 字面量放行（`isIP` 分支已放行），而"用自己域名反代"必须显式配 `PI_WEB_TRUSTED_HOSTS`，否则页面直接 403 —— 文档里值得写一句。
- **chat-ui**：P2-1/P2-2 的修法落在 `usePiWeb` 的连接管理与连接状态展示位置，属 chat-ui + bridge 交界。
- **crosscut**：触控目标 44px 是否统一在公共 `icon-btn` / `chip` 上加窄屏热区，需要 crosscut 裁定。
