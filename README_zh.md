# PiWeb — Pi Coding Agent 网页界面与 AI 编程助手

<p align="center">
  <a href="https://www.npmjs.com/package/@rexvane/piweb"><img src="https://img.shields.io/npm/v/@rexvane/piweb.svg" alt="npm 版本" /></a>
  <a href="https://github.com/RexVane/PiWeb/actions/workflows/check.yml"><img src="https://github.com/RexVane/PiWeb/actions/workflows/check.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 许可证" /></a>
</p>

<p align="center">
  <strong>可自行部署的 AI 编程智能体 Web 界面，支持桌面与手机浏览器。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong> | <a href="README_zh-Hant.md">繁體中文</a> | <a href="README_ja.md">日本語</a> | <a href="README_ru.md">Русский</a>
</p>

**PiWeb** 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的开源、自托管网页界面。用 npm 安装，在自己的电脑或服务器上运行，就能在桌面或手机浏览器中查看工具调用、审阅代码改动，并接着之前的会话继续工作。

它内置官方 `@earendil-works/pi-*` SDK，沿用已有的 pi 设置、模型、技能、扩展和 MCP（Model Context Protocol）配置。

<p align="center">
  <img src="assets/readme-chat.jpg" alt="PiWeb：可自托管的 Pi Coding Agent 网页界面，展示项目工作区、AI 对话和工具调用" width="840" />
</p>

## 目录

- [特色功能](#特色功能)
- [快速开始](#快速开始)
- [使用与远程访问](#使用与远程访问)
- [配置](#配置)
- [工作原理](#工作原理)
- [文档](#文档)
- [贡献](#贡献)
- [致谢](#致谢)
- [开源协议](#开源协议)

## 特色功能

- **对话与上下文** — 流式显示 Markdown、思考过程和工具调用。通过对话大纲跳转，运行时可补充指示或排队发送消息，也能在上下文用量指示中查看 token 用量。
- **工作区与会话** — 按项目文件夹组织会话。支持重命名、分支、归档、恢复草稿，以及导出为 JSONL 或 HTML。
- **会话导入** — 搜索并导入 Claude Code、Codex、OpenCode、Grok、ZCode、dsh、Kimi Code、WorkBuddy、Antigravity、Antigravity CLI、Qwen Code 和 Cursor 的本机历史。PiWeb 就地读取原始文件。
- **文件与改动** — 在项目生长树中按轮查看改动，包括 `SKILL.md` 读取步骤和 codemode 内的调用。支持源码、Markdown 预览、统一或并排 Diff，以及在对话中引用选中的行。
- **模型、技能与扩展** — 配置模型提供方，使用 Pi 的 MCP 工具并管理 Pi 包。[通过 Pi 安装扩展](docs/resources.md)，使用内置交互界面与 JSON UI。
- **提示词来源** — 查看项目指令、技能、模板和工具定义及其资源来源。
- **手机访问与语言** — 在「设置 → 远程访问」扫码连接。界面支持英语、简体中文、繁体中文、日语和俄语。

<details>
<summary>更多截图（桌面端与手机端）</summary>

以下截图使用旧版英文界面和示例数据。

<table>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-project.jpg" alt="桌面端项目文件" /><br /><strong>项目文件</strong></td>
    <td width="50%"><img src="assets/readme-desktop-files.jpg" alt="桌面端并排 Diff" /><br /><strong>并排 Diff</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-import.jpg" alt="桌面端会话导入" /><br /><strong>会话导入</strong></td>
    <td width="50%"><img src="assets/readme-desktop-models.jpg" alt="桌面端模型提供方选择" /><br /><strong>模型提供方</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-context.jpg" alt="桌面端上下文用量明细" /><br /><strong>上下文用量</strong></td>
    <td width="50%"><img src="assets/readme-desktop-skills.jpg" alt="桌面端技能工作区" /><br /><strong>技能</strong></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="assets/readme-mobile.jpg" width="50%" alt="手机端对话" /><br /><strong>手机端对话</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-mobile-workspaces.jpg" alt="手机端工作区侧栏" /><br /><strong>工作区</strong></td>
    <td width="50%"><img src="assets/readme-mobile-import.jpg" alt="手机端会话导入" /><br /><strong>手机端导入</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-mobile-files.jpg" alt="手机端文件查看器" /><br /><strong>文件查看器</strong></td>
    <td width="50%"><img src="assets/readme-mobile-models.jpg" alt="手机端模型提供方选择" /><br /><strong>模型提供方</strong></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-mobile-context.jpg" alt="手机端上下文用量明细" /><br /><strong>上下文用量</strong></td>
    <td></td>
  </tr>
</table>

</details>

## 快速开始

需要 **Node.js ≥ 22.19.0**（`package.json` 中的 `engines`），推荐 Node 24。项目生长历史功能需要 Git。

```bash
npm install -g @rexvane/piweb
piweb
```

PiWeb 默认打开带认证的 `http://127.0.0.1:30141` 页面（端口占用时自动递增）。在设置中配置模型提供方，或复用已有的 pi 配置。发布包只注册 `piweb` 命令，不会与官方 `pi` CLI 冲突。包内已包含封存的生产构建；如果安装时跳过了生命周期脚本，第一次启动会先构建一次再提供服务。详见[安装与构建](docs/operations/install-and-build.md)。

## 使用与远程访问

```bash
piweb                    # http://127.0.0.1:30141
piweb -p 30143 --no-open # 指定端口，不自动打开浏览器
piweb -H 0.0.0.0         # 同时把主服务绑到局域网（认证仍然开启）
```

| 选项 | 说明 |
| --- | --- |
| `-p, --port <port>` | 监听端口（默认 30141，环境变量 `PORT`） |
| `-H, --hostname <host>` | 绑定地址（默认 127.0.0.1，环境变量 `PI_WEB_HOSTNAME`） |
| `--public-url <url>` | 公开地址，用于登录链接，并自动加入 Host 白名单（环境变量 `PI_WEB_PUBLIC_URL`） |
| `--dev` | 开发模式（仅回环） |
| `--no-open` | 不自动打开浏览器 |
| `-h, --help` | 显示用法 |

在本机上，启动器会用私有登录凭据打开浏览器，并且不会把该凭据打印出来。再次运行 `piweb` 会重新打开已有实例并登录。

更新：`npm install -g @rexvane/piweb@latest`，然后重启 `piweb`。卸载：`npm uninstall -g @rexvane/piweb` —— agent 数据和已导入的工具历史不会被改动。降级见[发布、降级与回滚](docs/operations/release-and-rollback.md)。

连接手机或其他设备时，打开 **设置 → 远程访问**，扫描二维码（或复制链接）。同一张码在同一 Wi-Fi 和局域网外都可以用，客户端无需额外软件。这是一个 256 位一次性凭据，有效期 120 秒。生产启动会准备 `0.0.0.0:30142` 上的手机排版代理，以及 Cloudflare 快速隧道（`cloudflared`）。二维码使用隧道的 HTTPS 地址，只有该地址可达后才会出现。本机的 `127.0.0.1:30141` 提供桌面页面。开发模式保持本机访问。

直连局域网的 HTTP 不加密。二维码地址的 TLS 在 Cloudflare 终止。重启后隧道地址可能变化。

### 安全说明

- 在 `piweb` 启动器接受的所有启动方式中，认证默认开启（`PI_WEB_AUTH=1`）。
- `PI_WEB_AUTH=0` 只允许绑定回环，且不能设置 `--public-url` / `PI_WEB_PUBLIC_URL`。其他组合会被启动器拒绝。关闭认证时，不会准备内置局域网代理和 Cloudflare 隧道。
- 开发模式（`--dev` / `PI_WEB_DEV=1`）只允许回环绑定，因为 Next.js 开发端点不受启动令牌保护。
- 启动令牌通过 `GET /?token=…` 兑换一张经 HMAC 签名的 HttpOnly 会话 Cookie（有效期 30 天；在 HTTPS 下设置 `Secure`）。它不能用在 API 路径或 `Authorization` 头中。没有密码登录；设置 `PI_WEB_PASSWORD` 会使启动器拒绝启动。
- 「让所有设备重新登录」会使现有 Cookie 和配对码失效。
- 自建反向代理或隧道时，将代理指向 `127.0.0.1:30142`（手机排版）或 `127.0.0.1:30141`（桌面），保持认证开启，并把外部主机名加入白名单（`PI_WEB_TRUSTED_HOSTS=<your-domain>` 或 `--public-url`）。否则请求会返回 403 `untrusted host`。`PIWEB_REMOTE_LAN=0` 会关闭内置代理和快速隧道的自动准备。

## 配置

取值来自进程环境。命令行参数会覆盖对应的环境变量。含操作系统路径约定的维护文档见[环境变量参考](docs/operations/environment.md)。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PORT` | `30141` | 主监听端口。`piweb -p` 优先；端口被占用时启动器会按 `+1` 重试。 |
| `PI_WEB_HOSTNAME` | `127.0.0.1` | 主绑定地址（等同 `-H`）。非回环绑定仍会保持认证开启。 |
| `PI_WEB_AUTH` | `1` | 认证开关。`0` 仅在绑定回环且没有公开地址时被接受。 |
| `PI_WEB_PUBLIC_URL` | 未设置 | 公开地址（等同 `--public-url`）。其主机名会加入 Host 白名单。 |
| `PI_WEB_TRUSTED_HOSTS` | 空 | 自建反代或命名隧道的 Host 白名单，逗号分隔。 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi / PiWeb 共用的 agent 目录。它不是唯一数据根，见[数据与隐私](docs/operations/data-and-privacy.md)。 |
| `PIWEB_REMOTE_LAN` | 启用 | `0` / `false` / `off` / `no` 关闭局域网代理和 Cloudflare 快速隧道的自动准备。 |
| `PIWEB_REMOTE_LAN_PORT` | `30142` | 内置局域网 / 手机代理的监听端口。 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 未设置 | 模型请求使用的代理。设置 → 通用 → 网络代理（`httpProxy`）会覆盖它。 |
| `PI_WEB_UPDATE_CHECK` | `1` | 设为 `0` 时跳过启动时的更新检查。设置 → 检查更新仍可用。 |
| `PI_OFFLINE` | 未设置 | `1` / `true` / `yes` 跳过 PiWeb / SDK 的联网动作，例如更新检查。 |

<details>
<summary>全部环境变量</summary>

下表列出了在 `src/`、`scripts/` 和 `bin/` 中找到的全部 PiWeb 专用变量。内部进程变量在部署中不要设置。

#### 服务与网络

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PORT` | `30141` | 主监听端口。`piweb -p` 优先；端口被占用时启动器会按 `+1` 重试。 |
| `PI_WEB_HOSTNAME` | `127.0.0.1` | 主绑定地址（等同 `-H` / `--hostname`）。非回环绑定仍会保持认证开启。 |
| `PI_WEB_PUBLIC_URL` | 未设置 | 公开地址（等同 `--public-url`）。其主机名会加入 Host 白名单，并用于打开登录页。 |
| `PI_WEB_TRUSTED_HOSTS` | 空 | 逗号分隔的 Host 白名单。自建反代或命名隧道必须列入，否则返回 403 `untrusted host`。 |
| `PI_WEB_ALLOWED_HOSTS` | 空 | 上游 `agegr/pi-web` 的旧变量名，与 `PI_WEB_TRUSTED_HOSTS` 合并生效。 |
| `PI_WEB_AUTH` | `1` | 认证开关。`0` 仅在绑定回环且没有公开地址时被接受；关闭认证时不会准备局域网/隧道入口。 |
| `PI_WEB_UPDATE_CHECK` | `1` | 设为 `0` 时跳过启动时的一次性更新检查。**设置 → 检查更新** 仍可用。 |
| `PI_WEB_NO_OPEN` | 未设置 | `1` 表示启动后不自动打开浏览器（等同 `--no-open`）。 |
| `PI_WEB_DEV` | 未设置 | `1` 以开发模式启动（等同 `--dev`）。开发模式只允许回环绑定。 |
| `PI_WEB_ROOT` | 安装根目录 / `cwd` | 应用根目录覆盖，供启动器和发布脚本使用。普通部署不要改。 |
| `PIWEB_REMOTE_LAN` | 启用 | `0` / `false` / `off` / `no` 关闭内置局域网代理和 Cloudflare 快速隧道的自动准备。 |
| `PIWEB_REMOTE_LAN_PORT` | `30142` | 内置局域网 / 手机代理的监听端口。 |
| `PIWEB_REMOTE_LAN_BIND` | `0.0.0.0` | 内置局域网 / 手机代理的绑定地址，例如只绑某块网卡。 |
| `PIWEB_CLOUDFLARED` | 未设置 | `cloudflared` 可执行文件路径。查找顺序：本变量 → `<agent 目录>/web-bin/cloudflared{,.exe}` → `PATH`。 |
| `PIWEB_SKIP_WARMUP` | 未设置 | `1` 跳过生产首屏预热（仅排障用，首次打开会变慢）。 |

#### 代理

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `HTTP_PROXY` / `HTTPS_PROXY`（及小写形式） | 未设置 | 模型请求使用的代理。未设置时，若当前用户启用了 Windows 系统代理则使用它。 |
| `NO_PROXY` / `no_proxy` | 本机地址绕过 | 代理绕过列表。Windows 的精确主机和域名后缀例外会继承；PAC/WPAD 以及 `<local>`、`192.168.*` 等 Windows 专用规则不会被执行。 |
| `NODE_USE_ENV_PROXY` | 在支持时由启动器设为 `1` | 让 Node 的 `fetch` / `http` 认代理环境变量。支持 Node 24+ 或 22.21+；用户显式设置的值会被保留。 |

设置 → 通用 → 网络代理中的值（`settings.json` 的 `httpProxy`）优先于环境变量和系统代理；留空则回到自动检测。修改后请重启 `piweb`。

#### 认证与密钥

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_WEB_SECRET_FILE` | `<agent 目录>/web-secret` | 用于 Cookie 和配对码 HMAC 签名的密钥文件。 |
| `PI_WEB_SECRET` | 未设置（读密钥文件） | 签名密钥，格式为 **32 字节的 base64url 编码**。设置后不再读文件。非法值会报错，而不是静默轮换密钥。 |
| `PI_WEB_PASSWORD` | 已移除 | 密码登录已删除。若设置此变量，启动器会**拒绝启动**。 |

#### 数据、工具与留存

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi / PiWeb 共用的 agent 目录：设置、模型与凭据、会话、上传。它不是唯一数据根，见[数据与隐私](docs/operations/data-and-privacy.md)。 |
| `PI_WEB_EDITOR` | `code` | 「在编辑器中打开」使用的本机编辑器命令，仅对本机操作者有意义。 |
| `PI_WEB_UPLOAD_RETENTION` | `30`（天） | `web-uploads` 中未被引用文件的后台清扫阈值。`0` 关闭该清扫。清扫会先复制到 `~/.agents/backups/`，并记入 `INDEX.md`。 |
| `PI_WEB_DELETE_ATTACHMENT_CLEANUP` | 启用 | 删除会话时，一并清理仅被该会话引用的上传文件（先备份再删除）。`0` 保留这些上传。 |
| `PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY` | 关闭 | `1` 允许模型发现探测私网地址（本地推理常用）。默认关闭，以限制 SSRF。 |
| `PI_OFFLINE` | 未设置 | `1` / `true` / `yes` 跳过 PiWeb / SDK 的联网动作，例如更新检查、gh 身份查询和安装遥测。这不是操作系统级断网。 |
| `PI_TELEMETRY` | 未设置 | Pi SDK 的安装遥测开关（`1` / `true` / `yes` 开启，`0` / `false` / `no` 关闭）。未设置时由 SDK 的 `enableInstallTelemetry`（默认开启）决定。PiWeb 源码本身不读取该变量，由捆绑的 SDK 消费。 |

#### 构建与发布

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PIWEB_BUILD_DIR` | 由 `.next-releases/active.json` 决定 | 只接受 `.next` 或 `.next-releases/<安全 id>`。与当前活动发布冲突时拒绝启动。 |
| `PIWEB_MAX_RETAINED_RELEASES` | `10`（范围 2–100） | 保留的成功发布构建数量上限。达到上限时拒绝新构建，不会自动删除旧构建。 |
| `PIWEB_MAX_FAILED_RELEASES` | `3`（范围 1–100） | 未完成或失败的发布目录上限，同样会拒绝新构建。 |
| `PIWEB_SKIP_INSTALL_BUILD` | 未设置 | `1` 跳过生产安装的首次自愈构建。只给已经自带封存构建的部署使用。 |
| `PIWEB_BUILD_VERBOSE` | 未设置 | `1` / `true` / `yes` 打印完整构建输出。 |

#### 可选限制

这些开关默认关闭或上限较宽松，不设置时不会改变既有行为。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PIWEB_FS_STRICT_WORKSPACES` | 关闭 | `1` / `true` / `yes` 将已认证的文件接口限制在已注册工作区或 `PIWEB_FS_ALLOWED_ROOTS` 之内。 |
| `PIWEB_FS_ALLOWED_ROOTS` | 空 | 严格模式额外允许的根目录，Windows 用 `;` 分隔，POSIX 用 `:`。 |
| `PIWEB_MAX_SESSION_SUBSCRIBERS` | 不限制 | 每个会话的 SSE 订阅者上限（正整数）；超出后新订阅改为快照模式。 |
| `PIWEB_SSE_MAX_BUFFERED_BYTES` | `4MiB` | 单条 SSE 连接的未读缓冲上限；慢客户端会被断开，随后应重连并走快照。 |
| `PIWEB_SHUTDOWN_TIMEOUT_MS` | `8000` | 收到 SIGINT / SIGTERM / SIGHUP 后等待停机钩子的预算。第二次信号会立即退出。 |
| `PIWEB_GRACEFUL_STOP_TIMEOUT_MS` | `10000` | 启动器等待自己拉起的子进程退出的时间，超时后结束进程树。 |
| `PIWEB_AGENT_MAX_STEPS` | 不限制 | 单回合最多模型步数。 |
| `PIWEB_AGENT_MAX_DURATION_MS` | 不限制 | 单回合最长运行时间（毫秒）。 |
| `PIWEB_AGENT_TOKEN_BUDGET` | 不限制 | 单回合累计 token 上限（input + output + cache）。 |
| `PIWEB_MOBILE_PROXY_MAX_HTML_BYTES` | `16MiB` | 手机代理 HTML 注入缓冲上限；超过则改为不注入、直接流式透传。 |
| `PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES` | `64MiB` | 手机代理解压输出上限；更大的响应返回 502。 |
| `PIWEB_MOBILE_PROXY_TIMEOUT_MS` | `30000` | 手机代理等待上游 HTML 响应的时间，超时后改为不注入、直接流式透传。 |
| `PIWEB_AGENT_CONFIG_CACHE_MAX` | `512` | agent 配置缓存条目上限。 |
| `PIWEB_AGENT_CONFIG_CACHE_TTL_MS` | `1800000`（30 分钟） | 上述缓存中失败或缺失条目的 TTL。 |
| `PIWEB_PI_CACHE_MAX` | `512` | SettingsManager / 资源加载器 / 包管理器的缓存条目上限。 |

#### 测试、CI 与内部变量

不要在部署中使用这些变量。`CI`、`PIWEB_COVERAGE`、`PIWEB_COVERAGE_REPORT_DIR`、`PIWEB_TEST_REPORT`、`PIWEB_TEST_TUNNEL` 和 `PIWEB_LINT_SKIP_INSTALL` 仅用于测试和 CI。

启动器、锁和测试还会注入：`PI_WEB_LAUNCH_TOKEN`（一次性本机登录令牌，每次启动重新生成）、`PIWEB_PORT`（写入子进程的实际端口）、`PIWEB_HTTP_GUARD`、`PIWEB_BUILD_LOCK_FILE` / `PIWEB_BUILD_LOCK_TOKEN`、`PIWEB_PROCESS_LOCK_FILE` / `PIWEB_PROCESS_LOCK_TOKEN`、`PIWEB_PROXY_SOURCE`、`PIWEB_INHERITED_HTTP_PROXY` / `PIWEB_INHERITED_HTTPS_PROXY`、`PIWEB_MANAGED_NODE_USE_ENV_PROXY`、`PIWEB_MANAGED_NO_PROXY`、`PIWEB_DEV_ASSET_ID`、`PIWEB_DISABLE_GRACEFUL_SHUTDOWN`、`PIWEB_DEBUG_PROMPT`，以及 `PIWEB_BROWSER_URL`（在 Windows 上打开本机浏览器时的临时地址）。`PYTHONUTF8` / `PYTHONIOENCODING`、`NODE_OPTIONS`、`NEXT_PHASE`、`NEXT_RUNTIME` 和 `NEXT_TELEMETRY_DISABLED` 属于进程或 Next.js 约定（构建脚本会关闭 Next 遥测）。

PiWeb 还会读取 `HOME`、`USERPROFILE`、`TEMP` / `TMP`、`APPDATA`、`LOCALAPPDATA` 等操作系统路径变量，以及可选的 `WORKBUDDY_CONFIG_DIR` 和 `QWEN_HOME`（用于对应的会话导入来源）。

</details>

## 工作原理

PiWeb 是基于 Next.js 16 + React 19 的 TypeScript 应用，封装了官方 `@earendil-works/pi-*` SDK。`piweb` 命令（`bin/piweb.js` → `scripts/launcher.mjs`）会选择空闲端口、生成一次性启动令牌、拉起 Next.js 服务，并打开本机登录地址。服务将令牌兑换为经 HMAC 签名的会话 Cookie；在生产模式且认证开启时，还会准备局域网入口和 Cloudflare 快速隧道。

PiWeb 不会取代单独安装的 `pi` CLI。两者**共用同一个 agent 目录**（默认 `~/.pi/agent`，或由 `PI_CODING_AGENT_DIR` 指定）。该目录是主要存储，但不是唯一数据根——会话导入会读取家目录下其他工具的历史，全局技能可能位于 `~/.agents/skills`。详见[数据、隐私与留存](docs/operations/data-and-privacy.md)。

## 文档

- [安装与构建](docs/operations/install-and-build.md)
- [环境变量参考](docs/operations/environment.md)
- [数据、隐私与留存](docs/operations/data-and-privacy.md)
- [发布、降级与回滚](docs/operations/release-and-rollback.md)
- [自 0.3.35 以来的变化](docs/releases/0.3.36.md)
- [扩展 Web UI](docs/extension-web-ui.md) 与[扩展示例](examples/piweb-extensions/README.md)
- 文档导航：[docs/README.md](docs/README.md)

## 贡献

欢迎在 [github.com/RexVane/PiWeb](https://github.com/RexVane/PiWeb) 提交 issue 和 pull request。开发环境、项目结构、提交前检查和问题反馈方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

天青、粉霞配色感谢 [@webkubor](https://github.com/webkubor)。上游项目与参考来源见 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。依赖许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 开源协议

[MIT](LICENSE)
