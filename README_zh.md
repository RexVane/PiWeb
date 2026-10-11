# PiWeb

<p align="center">
  <strong>为 Pi 编程智能体打造的现代 Web 界面。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="assets/main.jpg" alt="PiWeb 界面展示" width="840" />
</p>

---

**PiWeb** 是为 [pi 编程智能体](https://github.com/earendil-works/pi) 打造的现代 Web 界面，**pi 引擎零改动**。一条命令安装，pi 已有的配置、会话、模型、技能和插件开箱即用。

## 与 pi 的关系

PiWeb 和 pi 是两个独立的程序，PiWeb 也不是 pi 的另一个版本：它是网页壳，通过官方 SDK 驱动你本机装好的 pi，不改动 pi 本体。两者**共用同一套配置**——同一个 agent 目录（`~/.pi/agent`）里放着设置、模型与凭据、会话、技能和包，所以在 pi CLI 里开的对话，网页里立刻能看到，反过来也一样。更新是**分开的**两件事：pi 内核和 PiWeb 各有版本、各有更新入口（设置里两个「检查更新」各管一个），升级哪个都不影响另一个。底层跑的就是原生 pi，插件在网页端的兼容（尤其是交互类插件）还没做完，目前以安装、卸载、启停为准。

## 特色功能

### 实时流式对话

边流边渲染 Markdown——标题、列表、代码块在回答还没写完时就已成形，不是整段结束才排版；代码块可以复制。对话栏可以拖宽，宽度记在这台浏览器里。思考过程与工具调用以卡片内联实时展示。版面克制：会话在左、大纲在右，两侧都可收起，屏幕留给对话本身。模型选择器遵循 pi 设置里的 `enabledModels`，设置页仍显示完整目录。

<p align="center"><img src="assets/main.jpg" alt="主页面：流式对话与工具卡片" width="840" /></p>

### 对话导航

对话区右侧的大纲：**加粗的是你发过的消息**，其余是助手回答里的各级标题。收起时是一列长短不一的横线（标题层级越深越短），悬停展开成列表；滚动时自动高亮当前所在的位置，点一下平滑跳过去。

<p align="center"><img src="assets/outline.jpg" alt="对话导航：加粗的是你发过的消息" width="840" /></p>

### 对话里的轨迹与文件

工具卡片上就有两个入口：**在轨迹中查看**把这一步放进轨迹面板——输入 / 模型 / 工具三条车道的时间轴，支持等距 / 时间 / 间隔三种排布与搜索，每行给出 token 与用时，详情分摘要、预览、原始、来源四档；**在编辑器中打开**直接打开这次操作碰的那个本地文件。改文件的卡片本身也内联整段 diff（新增绿、删除红，附 +N −M 行数），长改动折叠成预览，展开看全。

<p align="center"><img src="assets/trace-1.jpg" alt="工具卡片上的两个入口与内联 diff" width="840" /></p>
<p align="center"><img src="assets/trace-2.png" alt="轨迹入口按钮" /> <img src="assets/trace-3.png" alt="入口按钮细节" /> <img src="assets/trace-4.png" alt="入口按钮细节" /></p>

### 工作区与会话

会话按项目文件夹分组，原生文件夹选择器（Windows / macOS / Linux），支持重命名与归档；归档的会话收在侧栏「已归档」里，随时查看或取消归档，**归档后 30 天没有活动就自动删除**，不用手动清理。另有会话树分支跳转、草稿恢复、JSONL / HTML 导出。

<p align="center"><img src="assets/archive.jpg" alt="已归档：归档的会话收在一处" width="400" /></p>

### 项目生长树

pi 的每次文件操作都拍一张快照，按「你发一条消息 = 一轮」分组：每轮列出**相对上一轮**的新增 / 修改 / 删除，任意文件点开就是行级 diff，可以逐轮 review，也能在轮内按「步」细分到单次操作。没有文件改动的轮会注明，不会悄悄跳过。每轮存成工作区 git 仓库里的一个提交，挂在专用引用 `refs/piweb/rounds/…` 上，不动分支和暂存区；目录还不是 git 仓库（或只是别的仓库的子目录）时，第一次记录前会弹窗问你要不要在这里建仓库，选择按工作区记住，不同意就不记录。

<p align="center"><img src="assets/growth-1.jpg" alt="项目生长树（一）" width="840" /></p>
<p align="center"><img src="assets/growth-2.jpg" alt="项目生长树（二）" width="840" /></p>

### 文件查看器

项目文件在页面里直接打开，不必切编辑器：居中窗口、多标签页，`+` 模糊搜索找文件。同一个文件三种看法——**变更**（整文件 diff，新增绿、删除红，一键跳上一处 / 下一处改动）、**内容**（行号 + 语法高亮，被删文件显示删除前）、**渲染**（Markdown 直接成文）。看中的片段可引用进输入框，或用本地编辑器打开。

<p align="center"><img src="assets/viewer-1.jpg" alt="文件查看器（一）" width="840" /></p>
<p align="center"><img src="assets/viewer-2.jpg" alt="文件查看器（二）" width="840" /></p>

### 上下文计量

点击输入框旁的圆环，上下文窗口拆成 13 段展示——System Prompt、System/Custom Tools、Memory（AGENTS.md）、Skills、各类消息、Compacted Data、Auto-Compact Buffer 与 Free Space。

### 提示词来源

顶栏按钮打开右侧面板，把进入模型上下文的提示词全部列出来：系统提示词与追加段、项目记忆 `AGENTS.md`、各技能的 `SKILL.md`、提示模板、工具定义，以及组装后实际发给模型的那一份与压缩摘要；每行标注来源（项目 / 个人 / 包 / 扩展）。点一行就在中间查看器里读原文。列表按当前工作区实时枚举，之后装的插件或包里带提示词，刷新即出现。

<p align="center"><img src="assets/prompts-1.jpg" alt="提示词来源（一）" width="840" /></p>
<p align="center"><img src="assets/prompts-2.jpg" alt="提示词来源（二）" width="840" /></p>

### 模型与供应商管理

内置 40 家供应商，API Key 或 OAuth 授权登录都行——Anthropic、GitHub Copilot、OpenAI Codex、xAI、OpenRouter、Kimi、Radius 支持 OAuth 一键登录。名单之外的照样能用：自定义提供商填地址、协议与模型名即可，落进 `models.json`；本地网关（Ollama 等）自动补占位 Key。模型目录一键拉取，额度与余额（Claude / Codex / xAI / DeepSeek 等 11 家）直接显示在卡片里。

<p align="center"><img src="assets/providers-1.jpg" alt="提供商配置（一）" width="840" /></p>
<p align="center"><img src="assets/providers-2.jpg" alt="提供商配置（二）" width="840" /></p>
<p align="center"><img src="assets/providers-3.jpg" alt="提供商配置（三）" width="840" /></p>

### 插件与技能

在界面里直接安装、更新、卸载 pi 包；技能可启用/禁用/删除，改动即时作用于运行中的会话。

### 安全防护

对外监听走启动令牌登录、写接口同源校验、严格路径边界检查、工具权限预设（只读 / 工作区写入 / 完全访问）。

## 使用

### 安装

```bash
npm install -g @rexvane/piweb
piweb
```

包只注册 `piweb` 一个命令，与官方 `pi` CLI 互不冲突。需要 Node.js ≥ 22.19.0（推荐 24）；生长树功能需要安装 Git。

### 更新

```bash
npm install -g @rexvane/piweb@latest
```

npm 会原地替换已安装的版本，不用先卸载。界面里的「检查更新」按钮执行的就是这条命令；
`latest` 是 npm 的默认标签，所以直接写 `npm install -g @rexvane/piweb` 效果完全一样。
如果你用的镜像是国内源、同步有延迟，可以加 `--registry=https://registry.npmjs.org`
当天就拿到新版本。装完重启 `piweb` 即可用上新版本。

也可以装指定版本：`npm install -g @rexvane/piweb@0.3.4`。

### 删除

```bash
npm uninstall -g @rexvane/piweb
```

只删除 PiWeb 本身——pi 的数据在 `~/.pi/agent/`，不会被动到。

### 启动

```bash
piweb                    # http://127.0.0.1:30141（端口占用自动 +1）
piweb -p 30143 --no-open # 自定义端口，不自动打开浏览器
piweb -H 0.0.0.0         # 局域网访问（会自动打开启动令牌登录）
```

| 参数 | 说明 |
| --- | --- |
| `-p, --port <port>` | 监听端口（默认 30141，env `PORT`） |
| `-H, --hostname <host>` | 绑定地址（默认 127.0.0.1，env `PI_WEB_HOSTNAME`） |
| `--dev` | 开发模式 |
| `--no-open` | 不自动打开浏览器 |
| `--public-url <url>` | 对外地址，用来拼登录链接并自动加进 Host 白名单（env `PI_WEB_PUBLIC_URL`） |

认证由 `PI_WEB_AUTH=1` 打开（只要这台机器可能被本机以外访问，启动器默认就会开）。登录只剩**启动令牌**一条路：
打开启动时打印的 `…/?token=…` 链接，令牌换一张签名 Cookie，之后浏览器不再需要令牌。
`PI_WEB_PASSWORD` 已被移除 —— 设了它启动器会直接拒绝启动。远程访问不要用裸 HTTP。

脚本认证走同样两步：先用 `GET /?token=…` 换到会话 Cookie，之后每条 API 请求都带上这张 Cookie；
没有 Basic 兜底。

### 手机上用：内置的「远程连接」插件

PiWeb 自带一个内置插件负责这件事，在**设置 → 远程连接**里开关，客户端不用装任何东西。

它有两层入口：

**局域网入口（默认开启）** —— 一个只做手机适配的反向代理，绑 `0.0.0.0:30142`。
同一个 WiFi 下的设备直接打开面板里列出的地址即可，拿到的是适配过手机的页面；
本机直连 `127.0.0.1:30141` 仍是原样的桌面页面（回环 Host 不注入）。

**公网入口（默认关闭）** —— 打开后 PiWeb 会拉起一条 Cloudflare 快速隧道（`cloudflared`），
Cloudflare 分配一个 `https://<随机名>.trycloudflare.com` 地址，任何浏览器直接打开即可，
**不需要在每台设备上装客户端**。代价两条：

- 地址每次启动都会变，而且拿到之后还要十几秒才在全球 DNS 生效（面板会显示「生效中」）；
- TLS 在 Cloudflare 终结，那一跳能看到明文。要端到端加密就用可信 VPN。

`cloudflared` 的查找顺序：`PIWEB_CLOUDFLARED` 指定的路径 →
`<agent 目录>/web-bin/cloudflared{,.exe}`（PiWeb 自管的位置）→ `PATH`。找不到时面板直接提示。

> 公网入口一开，认证就是强制的。隧道域名由插件在启动成功时加进 Host 白名单，隧道一停立刻摘掉；
> 起始令牌不接受出现在 API 路径上，也不接受走 `Authorization` 头。

### 自己接反代或隧道

不想用内置插件，也可以自己准备入口（Caddy、nginx、Cloudflare 命名隧道、VPN 都行）。此时注意：

- 反代要转给 **`127.0.0.1:30142`**（局域网入口）才能拿到手机适配；只想要桌面版就转 `127.0.0.1:30141`。
- 必须设 `PI_WEB_AUTH=1`。绑回环时 PiWeb 判断不出「是否暴露」，需要你显式打开认证。
- 反代会把外部主机名原样转给后端，要加进白名单，否则被挡成 403 `untrusted host`：

  ```bash
  PI_WEB_TRUSTED_HOSTS=<你的域名> piweb
  ```

- 用 `--public-url https://你的地址/` 告诉 PiWeb 对外地址：它的主机名会自动进白名单，
  启动日志里打印的登录链接也会用这个地址而不是回环地址。

> 关掉局域网入口用 `PIWEB_REMOTE_LAN=0`；整个认证关掉用 `PI_WEB_AUTH=0`（后者只在纯本机使用时才安全）。

## 开源协议

[MIT](LICENSE)
