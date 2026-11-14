# 最终成品验收

2026-11-14。本文件仅陈述最终独立构建、打包、安装、运行时及浏览器验收；整仓测试/覆盖率由主审查台账独立报告，不与本页专项次数相加。

## 成品身份

| 项目 | 记录 |
| --- | --- |
| 源文件 | 748 个，独立复制；未复制 live `.next` |
| 源码 SHA256 | `5e8e1948ff57ea6eec8573f4a9542d497b1f1bded06e325fb2dbdc18989c7592` |
| Build ID | `vHQvRhdHkn-_2oDSQbm-A` |
| 密封运行文件 | 333 个 |
| npm pack | 1,084 文件，4,904,827 字节 |
| tarball SHA256 | `7b907f344940d59a295898fe1d47b52cbaad798cfebc1234ea917c068686fa95` |
| 干净安装 | 全新 prefix，空 user/global npmrc，官方 registry，忽略 lifecycle，实际安装 306 个包 |

构建后重新计算原工作区全部 748 文件的 hash，与构建快照完全一致，见 `artifact-source-consistency-final-v2.json`。所有最终 JSON 记录均标 `final:true`；早期 reqryB 中间构建记录仍保留 `final:false`，未覆盖。

## 实际运行结果

- `artifact-installed-standard-final-v2.log`：已安装版本真实启动；主页及 health/version/models/sessions/workspaces/pi-settings 六 API；私有 IPC 一次令牌交换、设备 Cookie 元数据；匿名 unfinished/chunked/Expect 在 body 之前拒绝；12 MiB JSON、101 MiB upload wire、100 MiB file 限额；认证后实际 32 KiB 上传落盘。
- `artifact-installed-extra-final-v2.log`：搬迁安装后的 `koffi` 和 `@emnapi/runtime` 均解析到干净 prefix，未借用 checkout 依赖；原生进程身份和文件锁实际可用；真实认证工作区注册、项目 `.pi/settings.json` 修改及原子替换保留注释和无关字段；原生隔离能力探测通过；30 天 Cookie；全设备登出后旧 Cookie 写入 401，再经私有 IPC 登录可重新写入。
- `artifact-installed-plugins-final-v2.log`：仅回环本地 registry，真实 npm pack 自建无依赖技能包 v1/v2；通过生产认证 `POST /api/plugins` 安装 v1、更新到 v2、移除。下载期间检查私有 stage 已存在且 live 树/设置仍为原版本；安装与更新使用不同 stage；每次完成后的 package 版本与 settings 一致；v1/v2 旧树保留且 `backups/INDEX.md` 有记录；测试包安装脚本若运行即失败，三操作均成功，确认实际忽略 lifecycle。共 6 次 registry GET，未取陌生 npm 包。
- `browser-final.json`：同 Build ID/sourceHash，Chromium 37/37；真实桌面及移动布局、44px 命中、侧栏、语言/主题首屏、设置输入回滚、模型/技能/扩展/提示词/自动化页面；无外部请求、无业务写入、无页面运行错误。
- `tunnel-final.json`：独立真实公网测试 1/1，32.14 秒、0 skip；局域网代理到真实 cloudflared、公网页面、移动 CSS、扫码兑换及 Secure/HttpOnly 登录、旧码不可复用。只转发隔离测试页面，未转发 live 30141。

总成品证据：`artifact-source-snapshot-final-v2.json`、`artifact-build-final-v2.json`、`artifact-pack-install-final-v2.json`，对应日志独立保存。

## 范围与清理

未停止、重启或覆盖 live 30141/.next，未使用真实模型或用户密钥。测试 API 仅修改本次创建的隔离数据。浏览器端口 2516 和安装验收服务均已自行退出；所有自建 stage、安装 prefix、探针脚本在检查进程退出后送回收站，证据 JSON/log/md 保留。

本次 Windows 原生与 Chromium 实测不代表 Linux/macOS CI、其他 Windows 用户 DACL、真实断电或 iOS/WebKit 已验收。局域网 HTTP 与公网 TLS 的差别仍按用户选择保留。
