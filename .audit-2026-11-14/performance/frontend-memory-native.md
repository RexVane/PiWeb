# 原生 Chromium 内存对照

有效结果为 `frontend-memory-native-v2.json`。同一短会话与长会话反复切换，50 次后、90 秒静置并再次 GC，JS heap 仍比基线多 **68.31 MiB**。可确认增长并非仅由 Playwright 或页面性能探针导致；尚未用 retaining path 确认具体产品/框架保留对象，也不能由这一次短程实验断言永久、无限泄漏。

| 已切换次数 | 额外静置 | 双 GC 后 JS heap MiB |
| --- | ---: | ---: |
| 0 | — | 11.338 |
| 10 | — | 25.650 |
| 20 | — | 38.859 |
| 30 | — | 52.072 |
| 40 | — | 66.136 |
| 50 | — | 79.632 |
| 50 | 90 秒 | 79.644 |

平均净增长约 1.366 MiB/次切换。各次均回到相同短会话，按 URL session ID 与最后消息专属标记确认正文就绪后采样。attached 元素 4058、DOM TreeWalker 节点 4528 恒定；这是文档内节点计数，不等同于前一份 Playwright 报告的 `Memory.getDOMCounters`（可包含其它节点）。每次检查 `window.__piPerf` 都不存在。

测量在 2026-11-14 16:55–16:56（Asia/Shanghai）完成，使用独立 Chrome 156.0.8078.4 进程及新 profile。Node 24 原生 WebSocket 直接连接 CDP，完全未 import/连接 Playwright；仅启用 Runtime、HeapProfiler，未启用 Network、Performance、Inspector。另用 Browser/Target 控制独立页面、Storage 在内存注入测试 cookie；未输出 cookie，未修改模型请求或拦截业务接口。

`Runtime.evaluate` 查找并点击真实侧栏按钮，属于不受信任的 DOM click；本轮只用于内存对照，不是交互延迟基准。浏览器参数为 `--window-size=1280,800`，没有通过 Emulation 固定内容视口，因此不要求增长幅度与 Playwright 的精确 1280×800 内容视口完全一致。JS heap 使用 `Runtime.getHeapUsage`，不代表完整浏览器或服务端进程内存。

第一次 `frontend-memory-native.json` 无有效内存样本：脚本在异步会话列表尚未到达时只尝试展开一次工作区，之后等待会话按钮超时。这是探针选择器时序问题。v2 等待已认证主界面的 textarea，并在工作区分组出现后确认折叠状态再展开，最终完整跑完 50 次与 90 秒等待；v1 失败原始 JSON/日志保留，不计入产品结果。

v2 的 Chromium PID 49008 已正常退出，自己的临时 profile 已送回收站；测试 PiWeb 服务保持供前端后续检查。原生脚本为本轮临时探针，结果确认后回收；JSON 与日志保留。后续应结合 `frontend-desktop-memory-minimal.heapsnapshot` 查强引用路径，不再用“是 Playwright 缓存”作为未经验证的解释。
