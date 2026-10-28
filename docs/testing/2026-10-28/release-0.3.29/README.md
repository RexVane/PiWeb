# PiWeb 0.3.29 整合与发布验收

2026-10-28。本次包含此前全面检查的修复、无标题／无工具栏／无外框的 Mermaid 纯图，以及 PR #48 的冷会话工具目录和逐会话工具偏好持久化。原 PR 提交 `b7e1a6a` 已于 `2026-10-28T14:44:35Z` 合入主干，合并提交 `475c0ea`；评审补漏与本次修复一并进入后续发布 PR，保留原作者提交。

本目录记录发布前实际验证。正式发布由发布 PR 的跨平台检查通过并合入主干后，手动触发 `publish` workflow 完成；npm 与 GitHub 的发布状态以该次 Actions、版本注册记录为准，不把本地构建视为已经发布。

| 验证 | 结果与证据 |
| --- | --- |
| 完整类型检查、测试、生产构建 | `npm run check` 与补上真实 fd PATH 后的最终全量测试成功；150 个测试文件中 148 通过、2 跳过，1217 项测试中 **1214 通过、0 失败、3 条件跳过**；[check 日志](check-ci-final.log)、[最终完整测试](test-ci-final-with-fd.log) |
| 生产安装 | 实际 tarball 安装到全新全局前缀，导入真实 Pi 1.4.0 SDK，启动生产服务，首页及首屏 6 个 API 均通过；[最后构建的安装日志](verify-package-ci-final.log) |
| PR #48 评审补漏 | 修复冷态遗漏 `ask_user_question`、忽略 SDK 显式默认工具，以及旧浏览器偏好迁移的边界；[问题、红绿测试和修改](pr48-review.md) |
| 真实浏览器、真实 SDK 冷会话 | 页面打开工具设置，默认 5/11 启用；实际点击关闭 `grep` 后为 4/11；停止并重启生产服务、重新加载页面，仍为 4/11，`ask_user_question` 保持启用 |
| 冷态与持久化核对 | 保存前后及重启后的真实 SSE 快照均为 `contextBreakdown.cold: true`，工具白名单与保存文件一致；[保存前](browser-cold-before.json)、[保存后](browser-cold-saved.json)、[重启后](browser-cold-restored.json) |
| 页面证据 | [重启并重新加载后的截图](browser-tools-reloaded.png)、[同页 DOM](browser-tools-reloaded-dom.txt)；浏览器验收未向模型发送请求，真实模型停止／继续／提问证据见[之前的修复报告](../fixes/report.md) |
| 本地构建与安装包 | 版本 `0.3.29`、Pi `1.4.0`、BUILD_ID `QWrqaNf6LRYQEB-SEJVy4`；`dist/rexvane-piweb-0.3.29.tgz`；[打包清单](pack.json)、[大小和 SHA-256](verification.json)；不包含 `.next/cache` 或用户认证／环境配置 |

最终本地打包清单为 1537 文件、26,276,685 字节，安装复核同为 1537 文件和同一 BUILD_ID。正式发布包由 Actions 重新构建并验证。

第一轮发布 PR 的一项 Ubuntu / Node 24 检查发现图片接口偶发 500；补充了 Git 提前关闭 stdin 的确定性红绿回归，并保留安全边界，详见 [CI 图片接口复核](ci-image-review.md)。浏览器工具偏好证据来自服务端 Git 子进程补漏前的构建 `V-x9GfKEae1o5yse2_RyS`；最后变更只涉及 Git 错误优先级，最终构建重新通过全部测试和真实安装启动验证。

较早的 `check.log` 记录整合 PR #48 后的 1209 通过；`verify-package.log` 和 `verify-package-final.log` 分别记录 1537／1545 文件的前一构建，均保留为历史记录。最终结果采用上述 `*-ci-final` 日志和最新打包清单。

3 条件跳过分别为两条 Windows 专属用例，以及需要显式开启的真实 cloudflared 公网隧道用例。发布 PR 继续执行 Ubuntu / Windows × Node 22.19.0 / 24 四组检查；本地 macOS 结果不代替它们。

本次隔离测试服务端口 `34130` 已关闭。测试文件使用隔离 agent/home，不改写用户会话。`browser-tools-restored.*` 记录服务重启后、页面重新加载前的状态，最终验收使用 `browser-tools-reloaded.*`。

首轮尚未整合 PR #48 的构建记录保留在 [before-pr48](before-pr48/README.md)，其产物与 1192 通过的结果均已被本次整合构建取代。
