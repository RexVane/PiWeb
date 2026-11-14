# 前端无用代码清理记录

日期：2026-11-14。范围为 components、hooks、i18n 与相关样式。遵循安装版 Next 16 文档的 page 入口、动态导入和 CSS Modules 规则；没有操作在线实例或 `.next`，没有整文件删除。

## 本轮清理

| 位置 | 清理内容与引用证据 |
|---|---|
| AppShell | 移除未读取的 `workspaceAliases` 解构；hook 内实际状态、工作区改名与查询逻辑保留。 |
| ChatInput、FileViewer、PluginsSection、usePiWeb | 移除对应未使用的图标、SelectOption、TrajEntry 导入；模块本身和有效导出保留。 |
| ChatWindow、ComposerImages | 移除无人引用的 MONO、FAN_RADIUS、FAN_GAP_MAX 常量及对应旧注释；布局计算与实际样式没有更改。 |
| GrowthConsentDialog | 删除未请求、未渲染的额外 useConfirmDialog 实例。ProjectPanel 自身实际使用的确认框实例保留。 |
| ModelsSection | 仅返回当前 provider 加成功符号的私有函数接收一个从未使用的 any 参数；内联同值字符串，保留 OAuth 成功/错误行为。 |
| plugins-section-state 测试 | 移除未用 waitFor 导入和无读取的 resolvePlugins 变量；该用例仍保留永不完成的 Promise 和原 fetch 模拟行为。 |
| ProviderSetupModal.module.css | 旧原生 select 已由 CustomSelect 取代，唯一导入者没有 styles.select 使用；移除其独立规则及两个组合选择器分支。 |
| globals.css | 删除 pw-busy-hint、hairline-r、line-dots、piweb-pulse、stream-cursor 五组没有任何源码/示例/测试调用的旧样式，连同后两组独占的 keyframes。 |
| i18n | 经全项目文本、值传递和动态索引复核，移除 115 个无引用逻辑键的中英 230 条定义。完整清单与原定义行号在 cleanup-i18n-candidates.md；root 已复核批准。没有删除现行远程连接、权限、自动化文案，也保留 resultRead/resultFound 和全部 9 个错误映射键。 |

## 文件与导出盘点

- `frontend-reference-scan.json` 记录 62 个前端 TS/TSX 模块，均存在生产引用；统计包含普通 import、Next 动态 import、测试 mock 和字符串路径，另人工核对入口。8 个 CSS Modules 也均由组件引用。没有提交整文件删除候选。
- `frontend-export-candidates.json` 记录 206 个导出声明及外部引用文件。所有图标均有其他生产文件引用；21 个没有跨文件名称引用的函数/类型仍在本文件使用，例如卡片布局、最大行号、导入响应解析、版本变更显示和会话编码，不属于死代码。
- 没有按字面量缺失误删 Markdown/语法高亮运行时生成的 contains-task-list、task-list-item、hljs-* 等选择器；通用移动控件选择器也保留。没有删除 SDK 接口、测试入口或仍有意义的测试。
- 原工作区已有大量共享修改，本记录仅说明此次局部清理。FileViewer 的 folder-close.svg→folder.svg 修正由 root 完成，本子任务没有覆盖。

## 验证

- `cleanup-frontend-typecheck.log`：`tsc --noEmit --incremental false --noUnusedLocals --noUnusedParameters` 退出 0，日志为空；未在此轮更改 tsconfig 强制检查规则。
- `cleanup-frontend-tests.json` / `.log`：13 文件 **99 passed、0 failed、0 skipped**，33.94 秒。覆盖草稿/输入框渲染隔离、附件卡片、流式 Markdown、项目记录确认、模型/OAuth与提供方设置、插件状态、文件导出、语言水合、远程连接、权限选择、自动化模型作用域。
- 文件目录补验 `cleanup-fileviewer-dir-tests.json` / `.log`：1 文件 **17 passed、0 failed、0 skipped**；不与全仓总数混加。最终全仓验证由 root 统一执行。
- 引用扫描与翻译移除脚本为本轮临时文件，收尾移入回收站；保留 JSON、Markdown 与测试日志证据。
