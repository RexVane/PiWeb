# 环境变量参考

维护日期：2026-11-18。变量值来自启动 PiWeb 的**进程环境**（Windows 用户/系统环境变量、shell、systemd/容器等）。本文区分三类：

- **部署/运维变量**：面向部署者，语义与默认值相对稳定；
- **可选限制开关**：本修复轮新增的加固/上限开关，默认关闭或宽松，不改变原有行为；
- **内部/调试变量**：由启动器、测试或构建流程注入，可能随版本变化，**不要**写进部署配置。

> 历史上 2026-11-15 审计统计到 55 个直接读取的环境变量名、其中 37 个未在用户指南出现；原始审计证据目录与审计报告已在收尾清理中移出仓库（可由 git 历史恢复）。本文件按“能否作为部署参数”分诊补齐；未列出的变量属于内部实现细节或操作系统约定。

## 服务与网络

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `30141` | 主监听端口。`piweb -p` 优先于本变量；被占用时启动器自动 +1 重试。 |
| `PI_WEB_HOSTNAME` | `127.0.0.1` | 主服务绑定地址（等同 `-H/--hostname`）。非回环绑定会同时启用启动令牌认证。 |
| `PI_WEB_PUBLIC_URL` | 未设置 | 对外访问地址（等同 `--public-url`）。其主机名自动加入 Host 白名单，也用于打开登录页。 |
| `PI_WEB_TRUSTED_HOSTS` | 空 | 逗号分隔的 Host 白名单。自建反代/命名隧道必须加，否则返回 403 `untrusted host`。 |
| `PI_WEB_ALLOWED_HOSTS` | 空 | 上游 `agegr/pi-web` 的旧变量名，与 `PI_WEB_TRUSTED_HOSTS` 合并生效（兼容保留）。 |
| `PI_WEB_AUTH` | `1` | 认证开关。设为 `0` 只在“仅回环绑定且未配置公开地址”时被接受；关闭后远程入口（LAN 代理/隧道）不会准备。 |
| `PI_WEB_UPDATE_CHECK` | `1` | `0` 关闭启动时的一次性更新检查（不联网）；设置里的“检查更新”不受影响。 |
| `PI_WEB_NO_OPEN` | 未设置 | `1` 启动后不自动打开浏览器（等同 `--no-open`）。 |
| `PI_WEB_DEV` | 未设置 | `1` 以开发模式启动（等同 `--dev`）；开发模式只允许回环绑定。 |
| `PI_WEB_ROOT` | 安装根/`cwd` | 应用根目录覆盖。启动器、发布与验证脚本使用；普通部署不要改。 |
| `PIWEB_REMOTE_LAN` | 启用 | `0`/`false`/`off`/`no` 关闭内置 LAN 代理与 Cloudflare 快速隧道的自动准备（自管入口的部署使用）。 |
| `PIWEB_REMOTE_LAN_PORT` | `30142` | 内置 LAN/手机代理监听端口（需要时改，例如端口冲突）。 |
| `PIWEB_REMOTE_LAN_BIND` | `0.0.0.0` | 内置 LAN/手机代理监听地址（现有默认行为）。需要只绑某块网卡时可覆盖，例如 `PIWEB_REMOTE_LAN_BIND=192.168.1.10`。 |
| `PIWEB_CLOUDFLARED` | 未设置 | 指定 `cloudflared` 可执行文件路径。查找顺序：本变量 → `<agent 目录>/web-bin/cloudflared{,.exe}` → `PATH`。 |
| `PIWEB_SKIP_WARMUP` | 未设置 | `1` 跳过生产首屏预热。仅排障用，会让首次打开变慢。 |

### 代理

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HTTP_PROXY` / `HTTPS_PROXY`（及小写形式） | 未设置 | 模型请求代理。未设置时会读取当前用户启用的 Windows 系统代理。 |
| `NO_PROXY` / `no_proxy` | 本机地址直连 | 代理绕过列表。Windows 的精确主机/域名后缀例外也会继承；PAC/WPAD 与 `<local>`、`192.168.*` 等 Windows 专用规则不执行。 |
| `NODE_USE_ENV_PROXY` | 启动器按 Node 版本自动设 `1` | 让 Node 的 `fetch/http` 认代理环境变量。Node 24+ 或 22.21+ 支持；更旧版本上即使配了代理，模型请求仍直连（启动器打印明确提示）。用户显式设置的值会被保留。 |
| `PI_CODING_AGENT_DIR/settings.json` 的 `httpProxy` | 空 | 设置 → 通用 → 网络代理，优先级高于环境变量与系统代理；留空恢复自动检测。 |

## 认证与密钥

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PI_WEB_SECRET_FILE` | `<agent 目录>/web-secret` | Cookie/配对码 HMAC 签名密钥文件路径。 |
| `PI_WEB_SECRET` | 未设置（读密钥文件） | 直接提供签名密钥：**32 字节的 base64url 编码**。适合容器/密钥注入；设置后不再读文件。非法值会报错而不是静默换新密钥。 |
| `PI_WEB_PASSWORD` | 已废弃 | 已移除密码登录。设置后启动器**拒绝启动**并提示删除该变量。 |

## 数据、工具与留存

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi/PiWeb 共用的 agent 目录：设置、模型与凭据、会话、上传附件、自动化任务等。**它不是全部数据根**（会话导入来源与全局技能仍按 `HOME`/`USERPROFILE` 定位），部署隔离方式见[数据目录、隐私与留存](data-and-privacy.md)。 |
| `PI_WEB_EDITOR` | `code` | “在编辑器中打开”使用的本机编辑器命令。仅对本机操作者有意义。 |
| `PI_WEB_UPLOAD_RETENTION` | `30`（天） | `web-uploads` 中过期附件的后台清扫阈值。`0` 关闭该清扫。清扫走“先备份再移除”，恢复副本在 `~/.agents/backups/` 且记入 `INDEX.md`。 |
| `PI_WEB_DELETE_ATTACHMENT_CLEANUP` | 启用 | 删除会话时定向清理该会话独占引用的上传附件（同样先备份再移除）；`0` 关闭这项清理，附件保留。 |
| `PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY` | 关闭 | `1` 允许模型发现探测私网地址（本地推理服务常用）。默认禁止，避免 SSRF 面扩大。 |
| `PIWEB_AUTO_THINKING_PROBE` | 启用 | `0`/`false`/`off`/`no` 关闭额外的后台思考档位请求。手动配置与 Pi 官方目录匹配仍然生效；未知兼容模型才会探测，每次使用简短测试消息，不包含真实会话。缓存与手动配置说明见[自动思考档位](data-and-privacy.md#自动思考档位与手动配置)。 |
| `PI_OFFLINE` | 未启用 | `1`/`true`/`yes` 关闭 SDK/身份相关的联网动作（gh 身份查询、更新检查、安装遥测上报）。只管理 PiWeb/Pi 自己的网络动作，**不是**操作系统级断网。 |
| `PI_TELEMETRY` | 未设置 | Pi SDK 的安装遥测开关：`1`/`true`/`yes` 强制开，`0`/`false`/`no` 强制关；未设置时由 pi 设置里的 `enableInstallTelemetry`（默认开启）决定。详见[隐私与留存](data-and-privacy.md#遥测与联网)。 |

## 构建与发布

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PIWEB_BUILD_DIR` | 由 `.next-releases/active.json` 决定 | 只接受 `.next` 或 `.next-releases/<安全 id>`。与当前活动发布冲突时拒绝启动。 |
| `PIWEB_MAX_RETAINED_RELEASES` | `10`（2–100） | 保留的成功发布构建目录上限。达到上限时拒绝新构建，不自动删除旧构建。 |
| `PIWEB_MAX_FAILED_RELEASES` | `3`（1–100） | 保留的未完成/失败构建目录上限，超出同样拒绝新构建并提示人工归档。 |
| `PIWEB_SKIP_INSTALL_BUILD` | 未设置 | `1` 跳过生产安装的首次自愈构建。只给“自行提供已封存构建”的部署使用，普通安装不要设。 |
| `PIWEB_BUILD_VERBOSE` | 未设置 | `1`/`true`/`yes` 打印完整构建输出。默认只收集 Next 输出，失败时回显末尾，成功时保持安静；CI 排障时开启。 |

安装/构建机制与耗时基线见[安装与构建机制](install-and-build.md)。

## 可选限制开关（本修复轮新增，默认不改变原有行为）

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PIWEB_FS_STRICT_WORKSPACES` | 关闭 | `1`/`true`/`yes` 开启严格工作区模式：认证后的文件接口不再接受任意现存目录当 cwd，必须是已注册工作区或 `PIWEB_FS_ALLOWED_ROOTS` 之内。默认关闭时行为逐字不变。 |
| `PIWEB_FS_ALLOWED_ROOTS` | 空 | 严格模式额外允许的根目录，按平台路径分隔符（Windows `;`、POSIX `:`）分隔。 |
| `PIWEB_MAX_SESSION_SUBSCRIBERS` | 不限制 | 正整数 = 每个会话的 SSE 订阅者上限；达到上限时新订阅退回快照模式。未设置/非法 = 不限制。 |
| `PIWEB_SSE_MAX_BUFFERED_BYTES` | `4MiB` | 单条 SSE 连接排队未读字节上限；慢客户端积压超过该值即断开（浏览器自动重连并走快照）。 |
| `PIWEB_SHUTDOWN_TIMEOUT_MS` | `8000` | 收到 SIGINT/SIGTERM/SIGHUP 后等待停机钩子（停隧道/调度器、等在途落盘）的总预算；超时只告警并继续退出。第二次信号立即退出，退出码保持 Node 原生约定。 |
| `PIWEB_GRACEFUL_STOP_TIMEOUT_MS` | `10000` | 启动器停止自己拉起的子进程（服务/构建子进程）时，先请求优雅退出并等待的预算，超时才强杀进程树。 |
| `PIWEB_AGENT_MAX_STEPS` | 不限制 | 单回合最多模型步数。超限中止本回合并推送明确的错误事件。 |
| `PIWEB_AGENT_MAX_DURATION_MS` | 不限制 | 单回合最长运行时间（毫秒）。 |
| `PIWEB_AGENT_TOKEN_BUDGET` | 不限制 | 单回合累计 token 上限（input+output+cache）。 |
| `PIWEB_MOBILE_PROXY_MAX_HTML_BYTES` | `16MiB` | 手机排版代理的 HTML 注入缓冲上限。超过则放弃注入、改为流式透传（页面仍可用，只是不注入手机样式）。 |
| `PIWEB_MOBILE_PROXY_MAX_DECODED_BYTES` | `64MiB` | 手机代理同步解压输出上限，超过返回 502（防压缩炸弹）。 |
| `PIWEB_MOBILE_PROXY_TIMEOUT_MS` | `30000` | 上游 HTML 响应等待上限，超时放弃注入改流式透传。 |
| `PIWEB_AGENT_CONFIG_CACHE_MAX` | `512` | agent 配置缓存条目上限（防按工作区无限增长）。 |
| `PIWEB_AGENT_CONFIG_CACHE_TTL_MS` | `1800000`（30 分钟） | 上述缓存的读失败/缺失条目 TTL。 |
| `PIWEB_PI_CACHE_MAX` | `512` | `SettingsManager`/资源加载器/包管理器缓存条目上限；运行中的会话持有自己的引用，不受淘汰影响。 |

## 测试与 CI 变量（不要用于部署）

`CI`、`PIWEB_COVERAGE`、`PIWEB_COVERAGE_REPORT_DIR`、`PIWEB_TEST_REPORT`、`PIWEB_TEST_TUNNEL`、`PIWEB_LINT_SKIP_INSTALL` 只服务测试与 CI 门禁；`PI_OFFLINE` 同时是发布/验证流程的离线开关。它们的行为见 [.github/RELEASING.md](../../.github/RELEASING.md) 与 [docs/README.md](../README.md)。`PIWEB_LINT_SKIP_INSTALL=1` 时 lint 步骤禁止自行安装工具链，缺依赖会直接失败而不是联网。

## 内部/调试变量（由启动器、锁或测试注入，不要手工设置）

| 变量 | 说明 |
| --- | --- |
| `PI_WEB_LAUNCH_TOKEN` | 一次性本机登录令牌；每次启动重新生成，只通过本机浏览器打开登录页。 |
| `PIWEB_PORT` | 启动器写入子进程的实际端口（`PORT` 的镜像，供内置代理回连）。 |
| `PIWEB_HTTP_GUARD` | `1` 时在 Node 预加载阶段安装请求体/认证闸门。 |
| `PIWEB_BUILD_LOCK_FILE` / `PIWEB_BUILD_LOCK_TOKEN`、`PIWEB_PROCESS_LOCK_FILE` / `PIWEB_PROCESS_LOCK_TOKEN` | 构建/子进程互斥锁的所有权证明，防止并发构建或死锁清理。 |
| `PIWEB_PROXY_SOURCE`、`PIWEB_INHERITED_HTTP_PROXY` / `PIWEB_INHERITED_HTTPS_PROXY` | 启动器记录的代理来源与原值，用于运行中切换代理与状态显示。 |
| `PIWEB_MANAGED_NODE_USE_ENV_PROXY`、`PIWEB_MANAGED_NO_PROXY`、`PIWEB_MANAGED_*` | 运行中切换代理时，标记“哪些值由 PiWeb 写入”，避免误删用户设置。 |
| `PIWEB_DEV_ASSET_ID` | 开发模式的静态资源版本前缀，避免缓存串版本。 |
| `PIWEB_DISABLE_GRACEFUL_SHUTDOWN` | `1` 时禁用进程级优雅停机信号处理器（只给测试/特殊编排用）。 |
| `PIWEB_DEBUG_PROMPT` | 打印 node:sqlite 加载失败等诊断信息（会话导入用）。 |
| `PYTHONUTF8` / `PYTHONIOENCODING` | 启动器为 Python 子进程设置的 UTF-8 约定。 |
| `NODE_OPTIONS` | Node 预加载与内存上限；启动器/构建脚本会追加自己的参数。 |
| `NEXT_PHASE`、`NEXT_RUNTIME`、`NEXT_TELEMETRY_DISABLED` | Next.js 构建/运行期标记与 Next 遥测关闭标记（构建脚本固定设为禁用）。 |
| `npm_config_global`、`npm_execpath`、`ComSpec`、`SystemRoot`、`ProgramFiles`、`LOCALAPPDATA`、`PATH`/`Path` | npm/命令发现与 Windows 工具路径发现，属于运行环境约定。 |

子进程环境会先清洗再传给外部程序：启动器给第三方安装器/工具的环境走白名单（`scripts/update-environment.mjs` 的 `isolatedCommandEnv`，只保留 PATH/HOME/代理等，不含 PiWeb 令牌）；PiWeb 自身启动的 git、编辑器、隧道等子进程走 `src/lib/child-process-env.ts` 的清洗——默认移除名字含 `TOKEN`/`SECRET`/`PASSWORD`/`API_KEY`/`CREDENTIAL`/`PRIVATE` 的变量以及 `NODE_OPTIONS`/`NODE_PATH`，保留代理变量与 `SSH_AUTH_SOCK`；git 子进程还会移除继承的 `GIT_*` 会话变量，避免被指到别的仓库/索引。因此不要在部署脚本里依赖“子进程能看到某个 `*_TOKEN` 变量”，需要时通过 PiWeb 的设置或显式 extra 参数传入。

## 操作系统路径约定

PiWeb 还读取 `HOME`、`USERPROFILE`、`TEMP`/`TMP`、`APPDATA`、`LOCALAPPDATA`（以及 WorkBuddy / Qwen 可选的 `WORKBUDDY_CONFIG_DIR`、`QWEN_HOME`）等系统变量来定位用户目录与临时目录；其中 `HOME`/`USERPROFILE` 决定全部 12 项会话导入来源（`~/.claude`、`~/.codex`、`~/.grok`、`~/.dsh`、`~/.zcode`、`~/.local/share/opencode`、`~/.kimi`、`~/.workbuddy*`、`~/.gemini/antigravity*`、`~/.qwen`、`~/.cursor`）与全局技能目录 `~/.agents/skills`。做部署隔离时必须一并重定向，见[数据目录、隐私与留存](data-and-privacy.md)。

## 核对方式

- 源码扫描：`rg -n "process\.env" src scripts bin`（Windows 可用 `Select-String`）；本文件的分类与默认值以当前代码为准。
- 审计证据：原始扫描结果与审计报告已随 2026-11-15 收尾清理移出仓库（可由 git 历史恢复）；变量清单与结论以本文为准。
- 修复轮验证证据：随同批审计归档一并移出仓库（可由 git 历史恢复）。
