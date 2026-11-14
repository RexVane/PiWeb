# 性能测量副本与静态资源基线

日期：2026-11-14。本记录只覆盖独立生产构建、输入一致性与静态文件大小，不能代替服务启动、内存、浏览器加载或交互测量。此阶段没有启动服务、安装依赖、调用模型或使用个人凭据。

## 测量副本

- 本次测量路径：`D:\AIApp\.piweb-performance-20261114-XavtFX`。全部测量完成后已回收，复测需按冻结输入重新创建独立副本；见 [清理记录](cleanup-stage.json)。
- 输入：`src`、`scripts`、`bin`、`public`、`assets` 及 package/lock/Next/TypeScript/PostCSS 配置，共 730 文件；未复制 `.env` 或个人 agent 数据。`next-env.d.ts` 由本次构建生成。
- 输入 SHA-256：`0a8188e986da0c45600a2153ae2d4d5da4b185e18f7f23b60feb75eb83337961`。计算为按相对路径排序的 `{file,size,sha256}` 数组 JSON 的 SHA-256。
- BUILD_ID：`qs_AuODvEiFduBinEf95d`；333 个封存运行文件，已重新验证完整清单。构建后原始输入和副本逐文件检查均一致。
- 依赖：使用原工作区 `node_modules` 的 junction；没有执行 npm install/ci。这是共享既有依赖的性能副本，不是新的干净安装验收。
- 构建使用独立 HOME、USERPROFILE、TEMP 和 agent 目录，过滤模型凭据及 Node 预加载环境。未触及原目录 `.next` 或构建选择清单。

## 构建时间

运行原始 `node scripts/build.mjs`，单次完整编译及哈希清单封存 **123.03 秒**，退出码 0。开始 `2026-11-14T08:04:24.022Z`，结束 `2026-11-14T08:06:27.638Z`。使用新的 `.next`；依赖目录和操作系统文件缓存已经存在。本项没有多次采样，不报告 p50/p95，也不把它当作服务启动时间。

环境与完整输入见 [source-snapshot.json](source-snapshot.json)；执行记录见 [build-result.json](build-result.json)、[build.log](build.log)；封存与复制验证见 [stage-validation.json](stage-validation.json)。

## 浏览器资源大小

| 范围 | 文件数 | 原始字节 | gzip 字节 |
| --- | ---: | ---: | ---: |
| 所有客户端 JS | 75 | 2,240,949 | 688,530 |
| 所有客户端 CSS | 6 | 168,467 | 34,163 |
| 全部 JS + CSS | 81 | 2,409,416 | 722,693 |
| 首页 JS | 7 | 923,365 | 278,493 |
| 首页 CSS | 2 | 124,407 | 24,383 |
| 首页 JS + CSS | 9 | 1,047,772 | 302,876 |

gzip 按每个文件独立使用 level 6 计算后求和，表示理论压缩体积，未测 HTTP 传输。全部文件来自 `.next/static`，包含条件 polyfill、旧页面框架和空 API 路由占位文件，不包含服务端代码、source map、图片或 HTML/RSC/API 数据。全部资源不等于首页下载量。

首页集合从 `build-manifest.json` 的 rootMainFiles、`/page` 中直接使用的 AppShell/I18n 客户端边界和 entryCSSFiles 推导。现代浏览器不执行的 nomodule polyfill 另为 112,594 原始字节 / 39,627 gzip 字节，未计入现代浏览器首页集合。此集合仍应由真实认证页面 HTML 和浏览器请求核对；页面空闲预取 ChatWindow 等会增加后续流量。

首页最大的应用分块为 `app/page-dd8af9a9858aaf29.js`：381,288 原始字节 / 110,291 gzip 字节。i18n 分块为 90,756 / 34,526 字节。完整初始文件、全部资源、最大文件与每个按需面板的额外文件见 [bundle-stats.json](bundle-stats.json)。按需面板共享部分分块，不能把各面板行直接相加。

## 本次测量使用的启动与认证方式

测量时由主 Agent 统一安排测试端口和时窗，不使用 30141，也不同时启动多个重负载测量。cwd 是上述独立 stage。使用 `node bin/piweb.js -p <测试端口> -H 127.0.0.1 --no-open`，设置：

- `PI_WEB_ROOT=<stage>`，`PI_CODING_AGENT_DIR=<本次独立夹具目录>`。
- `PI_WEB_AUTH=1`，`PIWEB_REMOTE_LAN=0`，`PI_WEB_UPDATE_CHECK=0`，`PI_WEB_ARCHIVE_RETENTION=0`。
- `PI_OFFLINE=1`，`NEXT_TELEMETRY_DISABLED=1`；清除个人模型密钥及宿主 `NODE_OPTIONS` / `NODE_PATH`，使用独立 HOME/TEMP。

导入 stage 的 `scripts/launcher.mjs`，调用 `await readCurrentLaunchToken(port, env)`。该调用经本机私密 IPC 校验并续发可用启动凭据。只在内存中将凭据发送到 `GET /?token=…`（手动处理重定向），提取响应 Cookie 用于后续请求/浏览器。令牌和 Cookie 不写日志或测量报告，不通过关闭认证绕过流程。

正常 launcher 会预热首屏；测量时分别标记进程启动、健康接口就绪、首屏可用及浏览器导航时间。若另测裸 Next 进程，必须注明与用户正常启动流程不同。全部测量结束、测试服务退出后，本次副本已送入回收站；共享依赖未被遍历删除。清理前后原 `.next` 的 462 项元数据和顶层文件 SHA、原依赖 `next/package.json` SHA 均一致，证据目录保留，见 [cleanup-stage.json](cleanup-stage.json)。
