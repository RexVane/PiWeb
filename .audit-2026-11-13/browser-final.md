# PiWeb 浏览器验收

构建：V8EkQiPStS7Rma76LwdHE；Chromium 156.0.8078.4；桌面1280×800、移动390×664。

- 通过：isolated-auth-enabled
- 通过：staged-source-snapshot-matches-workspace
- 通过：ssr-chinese-language
- 通过：real-browser-native-eventsource
- 通过：desktop-chat-no-horizontal-overflow
- 通过：desktop-chat-visible-center-hit-targets
- 通过：desktop-git-long-line-horizontal-scroll
- 通过：desktop-git-large-diff-window-bounded
- 通过：desktop-git-long-line-page-contained
- 通过：desktop-git-large-diff-bottom-accessible
- 通过：desktop-settings-no-horizontal-overflow
- 通过：desktop-settings-visible-center-hit-targets
- 通过：desktop-settings-open
- 通过：desktop-no-hydration-or-runtime-errors
- 通过：mobile-closed-sidebar-inert
- 通过：mobile-chat-no-horizontal-overflow
- 通过：mobile-chat-44px-visible-hit-targets
- 通过：mobile-current-title-first-character-uncovered
- 通过：mobile-git-long-line-horizontal-scroll
- 通过：mobile-git-large-diff-window-bounded
- 通过：mobile-git-long-line-page-contained
- 通过：mobile-git-large-diff-bottom-accessible
- 通过：mobile-open-sidebar-interactive
- 通过：mobile-sidebar-no-horizontal-overflow
- 通过：mobile-sidebar-44px-visible-hit-targets
- 通过：mobile-settings-no-horizontal-overflow
- 通过：mobile-settings-44px-visible-hit-targets
- 通过：mobile-no-hydration-or-runtime-errors
- 通过：sse-permanent-failure-actionable-error
- 通过：sse-manual-retry-creates-real-request
- 通过：sse-permanent-error-auto-retries
- 通过：sse-failure-no-page-runtime-error
- 通过：sse-silent-connection-rebuilt-by-watchdog
- 通过：sse-heartbeats-keep-recovered-connection-live
- 通过：sse-silence-no-page-runtime-error
- 通过：no-browser-mutations-or-model-call

局限：当前为最终源码快照的production构建；移动为桌面Chromium触屏模拟，未测真机；WebKit缓存2336与所需2370不匹配，未使用。API元数据和SSE异常使用本机确定性夹具，EventSource保持浏览器原生实现；未调用真实模型、未修改用户设置、未触及30141。

详见 browser-final.json；截图见 browser-final-*.png。

清理：独立测试实例已停止并再次核验无进程/监听；本次自建临时探针与隔离运行目录已移入回收站，截图和JSON记录保留。
