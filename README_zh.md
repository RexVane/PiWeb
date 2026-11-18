# PiWeb — Pi Coding Agent 网页界面与 AI 编程助手

<p align="center">
  <strong>可自行部署的 AI 编程智能体 Web 界面，支持桌面与手机浏览器。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong> | <a href="README_zh-Hant.md">繁體中文</a> | <a href="README_ja.md">日本語</a> | <a href="README_ru.md">Русский</a>
</p>

**PiWeb** 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的开源、自托管网页界面。把 Pi 运行在自己的电脑或服务器上，就能在桌面和手机浏览器中查看工具调用、审阅代码改动，并接着之前的会话继续工作。

PiWeb 基于官方 Pi SDK，沿用已有的 pi 设置、模型、技能、扩展和 MCP（Model Context Protocol）配置。可以导入 Claude Code、Codex、OpenCode 等工具的本机会话，也可以用内置的自动化功能定时执行任务。

[快速开始](#快速开始) · [特色功能](#特色功能) · [界面一览](#界面一览) · [安装与部署](#使用) · [文档导航](docs/README.md)

<p align="center">
  <img src="assets/readme-chat.jpg" alt="PiWeb：可自托管的 Pi Coding Agent 网页界面，展示项目工作区、AI 对话和工具调用" width="840" />
</p>

## 快速开始

需要 **Node.js ≥ 22.19.0**，推荐 Node 24。安装并启动：

```bash
npm install -g @rexvane/piweb
piweb
```

PiWeb 默认打开带认证的 `http://127.0.0.1:30141` 浏览器页面（端口占用时自动递增）。在设置中配置模型提供方，或复用已有的 pi 配置。使用手机端 Web 界面时，在 **设置 → 远程访问** 中扫描连接二维码。

环境要求和部署行为详见[安装说明](#安装)、[连接其他设备](#连接其他设备)及[数据与隐私说明](docs/operations/data-and-privacy.md)。

## 特色功能

- **对话与上下文** · 流式显示 Markdown、思考过程和工具调用。通过对话大纲跳转，运行时可补充指示或排队发送消息，也能在上下文圆环中查看 token 用量和组成。
- **工作区与会话** · 按项目文件夹组织对话，支持重命名、分支、归档、恢复草稿，以及导出为 JSONL 或 HTML。
- **会话导入** · 搜索并导入 Claude Code、Codex、OpenCode、Grok、ZCode、dsh、Kimi Code、WorkBuddy、Antigravity、Antigravity CLI、Qwen Code 和 Cursor 的本机历史。支持跨来源选择和恢复已归档的导入会话。原始文件会保留在原处。
- **文件与改动** · 在项目生长树中按轮查看改动，回看 `SKILL.md` 读取步骤和 codemode 内的嵌套调用。文件查看器支持源码、Markdown 预览、统一或并排 Diff，以及在对话中引用选中的行。
- **模型、技能与扩展** · 在设置中配置模型提供方，使用 pi 配置里的 MCP 工具和资源。在侧栏启停技能、打开 `SKILL.md`，并管理个人或项目范围内的扩展与 pi 包。
- **提示词来源** · 在右侧提示词面板查看项目指令、技能、模板和工具定义。由 PiWeb 注入的提示词和工具会标明来源。
- **自动化任务** · 按间隔、每天、每周或 cron 定时执行提示词。可以指定工作区和模型，也能打开每次运行的会话。PiWeb 需要保持运行才能按时执行。
- **手机访问与语言** · 在「设置 → 远程访问」扫码连接手机。界面支持英语、简体中文、繁体中文、日语和俄语。

## 与 pi 的关系

PiWeb 是内置官方 pi SDK 的网页壳，不改动单独安装的 pi CLI。两者**共用同一个 agent 目录**（默认 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 指定），其中保存设置、模型与凭据、会话、技能和包。内置 pi 内核随 PiWeb 发版升级。启动时只自动检查 PiWeb 更新；设置里保留 pi 版本和手动更新入口。

agent 目录是主要数据存储，但**不是唯一数据根**：会话导入会读取家目录下其他工具的会话历史，全局技能可能位于 `~/.agents/skills`。完整数据清单与部署隔离方式见[数据目录、隐私与留存](docs/operations/data-and-privacy.md)。

扩展的对话框、通知、状态文本、文字显示区和注入消息会显示在网页上；扩展命令也能新建、分叉和切换会话。扩展可通过 [JSON UI 桥](docs/extension-web-ui.md) 提供可交互网页面板。兼容的终端组件会退化为只读文本；终端键盘交互及自定义页眉、页脚、编辑器不会被复现。

## 界面一览

以下截图使用英文界面和示例数据。

### 桌面端

<table>
  <tr>
    <td width="50%"><img src="assets/readme-chat.jpg" alt="桌面端对话" /><br /><strong>对话工作区</strong><br />在项目会话旁查看思考过程和工具调用。</td>
    <td width="50%"><img src="assets/readme-desktop-project.jpg" alt="桌面端项目文件" /><br /><strong>项目文件</strong><br />在侧栏浏览项目树并打开文件。</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-files.jpg" alt="桌面端并排 Diff" /><br /><strong>并排 Diff</strong><br />在文件查看器中对照修改前后的代码。</td>
    <td width="50%"><img src="assets/readme-desktop-import.jpg" alt="桌面端会话导入" /><br /><strong>会话导入</strong><br />跨工具搜索并选择本机会话。</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-models.jpg" alt="桌面端模型提供方选择" /><br /><strong>模型提供方</strong><br />查找并配置模型提供方。</td>
    <td width="50%"><img src="assets/readme-desktop-context.jpg" alt="桌面端上下文用量明细" /><br /><strong>上下文用量</strong><br />查看 token 用量及其组成。</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-skills.jpg" alt="桌面端技能工作区" /><br /><strong>技能</strong><br />筛选技能并打开对应的 SKILL.md。</td>
    <td width="50%"><img src="assets/readme-desktop-automations.jpg" alt="桌面端自动化编辑器" /><br /><strong>自动化任务</strong><br />为定时任务选择执行时间、工作区和模型。</td>
  </tr>
</table>

### 手机端

<table>
  <tr>
    <td width="33%"><img src="assets/readme-mobile.jpg" alt="手机端对话" /><br /><strong>随时继续对话</strong><br />在手机上接着之前的会话工作。</td>
    <td width="33%"><img src="assets/readme-mobile-workspaces.jpg" alt="手机端工作区侧栏" /><br /><strong>工作区</strong><br />切换项目和会话。</td>
    <td width="33%"><img src="assets/readme-mobile-import.jpg" alt="手机端会话导入" /><br /><strong>会话导入</strong><br />选择要导入的历史会话。</td>
  </tr>
  <tr>
    <td width="33%"><img src="assets/readme-mobile-files.jpg" alt="手机端文件查看器" /><br /><strong>文件查看器</strong><br />打开并阅读项目代码。</td>
    <td width="33%"><img src="assets/readme-mobile-models.jpg" alt="手机端模型提供方选择" /><br /><strong>模型提供方</strong><br />查找并配置模型提供方。</td>
    <td width="33%"><img src="assets/readme-mobile-context.jpg" alt="手机端上下文用量明细" /><br /><strong>上下文用量</strong><br />查看已用和可用的上下文空间。</td>
  </tr>
</table>

## 归档与数据

归档会话一直保留，可从侧栏查看、恢复或手动删除。点击归档直接生效，不再二次确认；手动删除仍需确认，并且会**永久删除会话文件、不保留恢复副本**。会话不会自动删除。删除会话时会顺带清理仅被它引用的上传附件：先保留恢复副本到 `~/.agents/backups` 并在 `backups/INDEX.md` 记录，再移除（`PI_WEB_DELETE_ATTACHMENT_CLEANUP=0` 可关闭这项清理）。没有会话引用的附件会在之后有新的上传触发清扫时、超过 30 天后清理。需要保留的数据请自行备份；全部数据位置见[数据目录、隐私与留存](docs/operations/data-and-privacy.md)。

项目生长树默认记录，无需确认弹窗。每轮文件变更存为工作区 Git 仓库中 `refs/piweb/rounds/…` 下的提交，不改变分支和暂存区；需要时自动初始化本地仓库。累计历史条数和容量不设上限，可以在项目面板随时关闭或重新开启记录，之前手动关闭的工作区继续保持关闭。关闭记录保留已有历史；单文件、单次快照及预览的大小保护仍然生效。

## 扩展与自动化任务

侧栏工作区与设置分开。技能工作区按所选工作区展示个人、全局与项目作用域的技能，支持启停、在文件查看器中打开 `SKILL.md` 以及可恢复移除非包技能。扩展工作区按所选工作区管理 npm 包，分别标注个人/项目作用域与本地/包来源。个人资源通常在 `<agent 目录>/skills` 和 `<agent 目录>/extensions`；受信任项目可提供 `.pi/skills`、`.pi/extensions`、`.agents/skills` 及显式配置的资源路径。当前工作区与会话组装的提示词来源可在右侧抽屉的提示词面板中查看（资源市场页面已移除）。

npm 包的安装、更新和卸载先在独立目录准备，再切换正式安装与设置。准备失败保留原安装，提交中断会在加载资源前恢复；旧安装代及恢复索引会保留。npm 生命周期脚本不执行，但加载后的扩展本身仍是运行在宿主进程中的受信任代码。

自动化任务和运行记录保存在 `<agent 目录>/web-automations.json`。计划使用编辑器显示的服务端时区，最多同时运行四项任务；每次使用独立会话。停机期间超过宽限期的计划记为跳过，不会在启动后集中补跑。

## 使用

### 安装

```bash
npm install -g @rexvane/piweb
piweb
```

包只注册 `piweb` 一个命令，与官方 `pi` CLI 互不冲突。需要 Node.js **≥ 22.19.0**（`engines` 下限）；CI 覆盖 22.19.0、22.22.2 与 24，推荐 Node 24。自动代理需要 Node 24 或 22.21 以上（更旧版本只能让外部工具继承代理变量，模型请求仍直连，见[代理](#代理)）。生长树功能需要安装 Git。

发布包自带已封存的生产构建，正常全局安装不需要本机编译。`postinstall` 只对**生产专用安装**准备构建：源码检出里是 no-op；如果安装时跳过生命周期脚本，第一次启动 `piweb` 会在独立暂存目录构建一次后再服务（一次性操作，当前机器大约 6–15 分钟）。构建/修复细节和超时见[安装与构建机制](docs/operations/install-and-build.md)。

### 更新

```bash
npm install -g @rexvane/piweb@latest
```

npm 会原地替换已安装的版本，不用先卸载。`latest` 是 npm 的默认标签，所以直接写
`npm install -g @rexvane/piweb` 效果完全一样。如果你用的镜像是国内源、同步有延迟，可以加
`--registry=https://registry.npmjs.org` 当天就拿到新版本。装完重启 `piweb` 即可用上新版本。

安装指定版本时，将 `latest` 换成对应版本号。如果某个版本有问题，[发布、降级与回滚](docs/operations/release-and-rollback.md)给出精确降级、处理 `latest` 标签以及恢复数据的步骤。

**在界面里更新**：每次启动 PiWeb 都会在后台检查 PiWeb 有没有新版本，有的话终端打印一行
`[更新] 有新版本：…`，页面右下角弹出提示条（同一次启动只提醒一次）。点提示条或 设置 → 通用 里的「更新」
就地安装，不用跳仓库；装好后按提示重启 `piweb` 生效，进程不会自己重启。

- PiWeb 发行版携带经过验证的 pi 内核。pi 不再自动弹出更新提示，设置里仍可手动检查。
- Windows 上运行中的 npm 安装不能替换自己（文件被占用），PiWeb 那一项会给出命令和复制按钮：先停掉 `piweb`，再在终端运行上面的命令。
- 不想联网检查：启动前设 `PI_WEB_UPDATE_CHECK=0`，仍可在设置里手动点「检查更新」。

### 删除

```bash
npm uninstall -g @rexvane/piweb
```

只删除 PiWeb 本身——pi 的数据在 agent 目录（默认 `~/.pi/agent/`，或 `PI_CODING_AGENT_DIR` 指定的目录），不会被动到。PiWeb 从家目录导入的其他工具会话历史也不会被修改，见[数据目录、隐私与留存](docs/operations/data-and-privacy.md)。

### 启动

```bash
piweb                    # http://127.0.0.1:30141（端口占用自动 +1）
piweb -p 30143 --no-open # 自定义端口，不自动打开浏览器
piweb -H 0.0.0.0         # 主服务也绑定局域网地址（仍保持认证）
```

| 参数 | 说明 |
| --- | --- |
| `-p, --port <port>` | 监听端口（默认 30141，env `PORT`） |
| `-H, --hostname <host>` | 绑定地址（默认 127.0.0.1，env `PI_WEB_HOSTNAME`） |
| `--dev` | 开发模式 |
| `--no-open` | 不自动打开浏览器 |
| `--public-url <url>` | 对外地址，用来拼登录链接并自动加进 Host 白名单（env `PI_WEB_PUBLIC_URL`） |

所有启动方式都默认启用认证（`PI_WEB_AUTH=1`）。在运行 PiWeb 的电脑上，启动器会带私有登录凭据打开浏览器，
终端不打印凭据。再次运行 `piweb` 可重新打开已有实例并登录；其他设备扫描自动更新的连接二维码。
两种方式都会将凭据换成有效期 30 天的签名 HttpOnly Cookie。「退出所有设备」会使已有 Cookie 和配对码失效。
`PI_WEB_PASSWORD` 已被移除，设了它启动器会拒绝启动。

已获授权启动凭据的脚本先通过 `GET /?token=…` 换取会话 Cookie，之后每条 API 请求携带该 Cookie。
API URL 和 `Authorization` 头不接受启动令牌，也没有 Basic 兜底。

### 代理

PiWeb 自动使用 `HTTP_PROXY` / `HTTPS_PROXY`；没有这些环境变量时，会读取当前用户启用的 Windows HTTP(S) 系统代理。设置 → 通用 → 网络代理（或 `<agent 目录>/settings.json`）中的 `httpProxy` 可覆盖这两种来源，留空则恢复自动检测；没有代理时直接连接。本机地址默认直连（`NO_PROXY` 可覆盖），Windows 的精确主机名和域名后缀例外也会继承。PAC/WPAD 脚本及 `<local>`、`192.168.*` 等 Windows 专用规则不会执行，使用代理 URL 或 `NO_PROXY` 配置这类情况。改动后重启 `piweb` 生效。需要 Node.js 24，或 22.21 以上：更旧的版本不认识这个开关，启动时会明确提示代理未生效（`bash` 工具里的 curl / git 仍能用这些变量）。

### 连接其他设备

打开**设置 → 远程连接**，扫描唯一的连接二维码。同一 WiFi 和外网都使用这个码，无需手动开启连接或选择网络，其他设备也不用安装额外软件。二维码和可复制链接使用同一份 256 位随机凭据，有效期 120 秒，只能使用一次；过期或使用后面板自动更新，重新打开面板会复用仍有效的码。

生产启动时会自动准备本地代理（`0.0.0.0:30142`）和 Cloudflare 快速隧道（`cloudflared`）。二维码使用隧道的 HTTPS 地址，确认地址可达后才显示，不会静默切换成局域网专用地址。短暂中断保持原地址，持续不可达时自动重建隧道；开发模式保持本地运行。

本地代理负责手机适配，运行 PiWeb 的电脑直接访问 `127.0.0.1:30141` 仍是桌面页面。隧道有两点限制：

- 重启或重建隧道后地址可能变化，DNS 和可达性检查完成后二维码才会就绪；
- 二维码地址使用 HTTPS，TLS 在 Cloudflare 终结。直接使用局域网 HTTP 仍不加密；在同一 WiFi 扫这个码也需要公网隧道可达。

内置局域网代理默认监听 `0.0.0.0:30142`。部署覆盖项：`PIWEB_REMOTE_LAN=0` 关闭自动准备局域网代理与隧道，`PIWEB_REMOTE_LAN_PORT` 改代理端口，`PIWEB_REMOTE_LAN_BIND` 改监听地址（例如只绑一块网卡），`-H 0.0.0.0` 让主服务也监听局域网。HTML 注入有上限：超过 `PIWEB_MOBILE_PROXY_MAX_HTML_BYTES`（默认 16MiB）或 `PIWEB_MOBILE_PROXY_TIMEOUT_MS`（默认 30 秒）就放弃注入、改为流式透传；解压后超过 `PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES`（默认 64MiB）直接拒绝。完整清单见[环境变量参考](docs/operations/environment.md)。

`cloudflared` 的查找顺序：`PIWEB_CLOUDFLARED` 指定的路径 →
`<agent 目录>/web-bin/cloudflared{,.exe}`（PiWeb 自管的位置）→ `PATH`。找不到时面板直接提示。

> 远程连接需要认证，认证默认启用。隧道域名在启动成功时加进 Host 白名单，隧道一停立刻摘掉；
> 起始令牌不接受出现在 API 路径上，也不接受走 `Authorization` 头。

### 自己接反代或隧道

也可以自己准备反代或隧道入口（Caddy、nginx、Cloudflare 命名隧道、VPN 都行）。此时注意：

- 反代要转给 **`127.0.0.1:30142`**（局域网入口）才能拿到手机适配；只想要桌面版就转 `127.0.0.1:30141`。
- 保持默认启用的认证。`PI_WEB_AUTH=0` 会关闭自动远程连接，且只允许回环绑定、不配置公开地址。
- 反代会把外部主机名原样转给后端，要加进白名单，否则被挡成 403 `untrusted host`：

  ```bash
  PI_WEB_TRUSTED_HOSTS=<你的域名> piweb
  ```

- 用 `--public-url https://你的地址/` 告诉 PiWeb 对外地址：它的主机名会自动进白名单，
  启动器打开登录页时使用这个地址，日志不打印登录凭据。

> 自行管理网络入口的部署可设 `PIWEB_REMOTE_LAN=0`，关闭内置局域网代理和快速隧道的自动准备。这是部署配置，不是连接面板里的网络切换开关。

## 开发与验证

在独立检出或暂存目录验证：`npm run build` 会写入 `.next`，不要对正在服务的实例目录执行。先用 `npm ci` 安装开发依赖，再运行：

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run verify:package
```

`verify:package` 打包生产构建，安装到空目录，再用临时数据启动安装后的副本。CI 还会运行锁定的 lint 工具链、在 Linux/Node 24 上执行高危依赖审计、准备 SDK 搜索工具、检查异常跳过，并通过 `PIWEB_COVERAGE=1` 开启覆盖率；真实公网隧道使用单独的显式测试开关。生产构建在审计机器上实测约 6–7 分钟（`next build --webpack` 并发负载下 370 秒），本地/CI 构建超时建议 ≥ 15 分钟、完整 `check` 任务建议 30–45 分钟。源码测试、安装包和浏览器检查由 `npm run check` 分别报告。更多文档见[文档导航](docs/README.md)；安装/构建细节与超时基线见[安装与构建机制](docs/operations/install-and-build.md)。

## 运维与部署

- [安装与构建机制](docs/operations/install-and-build.md)：安装形态、`postinstall`、首次启动自愈构建、构建时长与超时。
- [环境变量参考](docs/operations/environment.md)：部署变量、2026-11-15 加固轮新增的可选限制开关、内部进程变量。
- [数据目录、隐私与留存](docs/operations/data-and-privacy.md)：全部数据根、部署隔离、遥测开关、删除与恢复副本行为。
- [发布、降级与回滚](docs/operations/release-and-rollback.md)：精确版本降级、应用内更新失败处理、`.next-releases` 回退、数据兼容。

## 致谢

天青、粉霞配色感谢 [@webkubor](https://github.com/webkubor)。

## 开源协议

[MIT](LICENSE)
