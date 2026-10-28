# 2026-10-28 交互审计补充

基线：`main` / `26a4d9f` / PiWeb `0.3.28`。本报告记录只读源码审计和内存中的组件探针；浏览器实测记录由主测试报告汇总。未改动业务源码，也未在本子任务启动服务。

## 已确认的交互问题

| 编号 | 严重度 | 触发与实际结果 | 源码根因与定位 |
| --- | --- | --- | --- |
| I-01 | P2 | 会话回复中的 `[README](README.md)` 点击后跳到站点 `/README.md`，主浏览器测试观察到 404。 | `MarkdownBlock.tsx:109–127` 的 `MarkdownLink` 对非外链直接返回普通 `a`，未调用 `MarkdownActionsContext`。只有 `:145–155` 的行内代码渲染调用 `actions.openFile`。`ChatWindow.tsx:1577、1791` 已正确提供该 context，但普通 Markdown 链接不使用它。 |
| I-02 | P2 | 目录选择器快速点击 A、再点击 B；B 请求先返回显示 B，旧 A 请求后返回又覆盖为 A；点确认最终得到 A。 | `DirectoryPicker.tsx:53–63` 没有请求取消或序号校验，`:108、146` 的目录入口在 `busy` 时仍可点击。内存组件探针已复现。 |
| I-03 | P2 | 文件快速打开框用中文输入法按 Enter 上屏时，立即打开候选并关闭搜索。 | `FileViewer.tsx:643–656` 未检查 `nativeEvent.isComposing`。内存探针发送 `{ key: "Enter", isComposing: true }`，仍收到 `onOpen("file.txt")`。`ChatInput.tsx:848、920` 对输入法已有正确保护。 |
| I-04 | P2 | 供应商设置里的自定义下选框连续按两次 ↓：第一次打开，第二次关闭，没有移动或选择候选。 | `CustomSelect.tsx:75–80` 将上下方向键统一实现成 `setOpen(prev => !prev)`，未维护候选索引或移动焦点。实际使用位置为 `ProviderSetupModal.tsx:261、315、648、666`。 |
| I-05 | P2 | 查看 `docs/readme.md`，其中 `![local picture](assets/picture.png)` 生成网页根下的 `/assets/picture.png`，无法按该文档的目录读取工作区图片。 | `FileViewer.tsx:579–590` 只定制 `a`，图片直接走 react-markdown 默认 `img`。内存探针得到原始 `src=assets/picture.png`、解析地址 `http://localhost:30142/assets/picture.png`，而所需文件为工作区 `docs/assets/picture.png`。HTTP 是否返回 404 仍取决于站点是否恰有同名静态资源；本探针没有发图片网络请求。 |
| I-06 | P3 | 应用内目录选择弹窗按 Escape 没有效果。 | `DirectoryPicker.tsx` 没有 Escape 处理。内存组件探针确认取消回调次数为 0，弹窗仍存在。 |
| I-08 | P2 | 设置中打开 `SelectOption` 下选后按 Escape，整个设置弹窗关闭。 | 主测试已在真实 Edge 确认。`SettingsPanel.tsx:568–578` 只安装点击外部监听，没有下选的键盘处理；`:97` 的 document Escape 监听调用设置 `onClose`，没有先消费弹出的下选层。 |

### I-01 为什么现有测试没有发现

- `tests/components/markdown-file-path.test.tsx:25–40` 只覆盖反引号包住的行内路径与代码块。
- `tests/components/chatwindow-markdown-paths.test.tsx:25–31、52–76` 和 `tests/components/app-shell-markdown-paths.test.tsx:23–30` 的回答 fixture 也是反引号行内路径，查询目标为 `button.md-file-path`。
- 这些测试证明行内代码接到页内文件查看器，但没有覆盖 `[标签](README.md)` 的普通链接，因此不会发现页面导航。
- 返回后的会话恢复不能仅归因于上述链接问题：`usePiWeb.ts:904–913` 会持久化已选路径，`:928–945` 刷新恢复却用严格字符串匹配 `s.path === saved`。链接导航会卸载当前 AppShell，是否恢复还取决于列表返回的路径是否与保存值一致，尤其需要检查 `/tmp` 与 `/private/tmp` 的差异。

## 路径规范化不一致

### I-07：同一工作区的符号链接路径可能显示成两个工作区

已确认根因：

1. `path-security.ts:63–72` 的 `resolveWorkspacePath` 使用 `fs.realpath`，正常 UI 添加工作区／创建会话会得到规范路径。
2. `workspace-store.ts:67–69` 的比较键只用 `path.resolve`，`addWorkspace:254` 与 `registerCwds:282、296` 也只做词法解析，无法识别符号链接别名。
3. `session-reader.ts:100` 原样读取 JSONL 头中的 `cwd`。`api/sessions/route.ts:15` 又把这些 cwd 注册为工作区。
4. `SessionSidebar.tsx:54–59、247–290` 仅规范分隔符／尾斜杠后按字符串分组；别名也跟原始字符串 key 绑定。

主机只读检查确认 `fs.realpath("/tmp") === "/private/tmp"`，但 `path.resolve` 得到的两个 key 不同。

本次浏览器 fixture 的注册表使用 `/tmp/.../workspace`，后续规范路径为 `/private/tmp/.../workspace`，因此容易触发重复。本次现象受 fixture 写入方式触发；正常 UI add 会先做 realpath。历史／CLI 会话带原始符号链接拼写时也存在同一条件，不能把本次重复无条件推广为所有工作区都会重复。

## 首屏模型禁用与模型回退说明

这部分区分行为解释与缺陷，未直接计为新功能缺陷。

- `AppShell.tsx:179、199–201` 在首屏没有选择工作区时将 `heroModel` 设为 null；`:217–218` 不请求默认模型；`:363–366` 因而无法得到 `heroChoice`。`ChatInput.tsx:182、817` 会禁用输入。首屏禁用不是过期默认模型单独导致的；无工作区时普遍会发生。`AppShell.tsx:327–328` 的“未选择时输入框仍可用”注释与当前实现不一致。
- 选择工作区后才请求 `/api/models/defaults?cwd=...`。`AppShell.tsx:203–215` 优先工作区 localStorage 记住的模型，否则使用服务端建议。
- `model-defaults.ts:67–81` 的顺序为 enabledModels 第一个 → 有认证且存在的默认模型 → 已知 provider 默认表 → 第一个可用模型。找不到旧默认 ID 会正常进入后续回退分支。
- 只读过滤输出核验了用户配置：默认 provider 为 `magpie`，默认 ID 为 `clinepass/cline-pass/deepseek-v4.1-flash`，模型目录含 `clinepass/cline-pass/deepseek-v4.1-flash-1017`，不含旧 ID。未输出任何密钥、认证值或请求头。
- 对“选择工作区后为什么精确选到 Grok”，仅凭上述默认值不足以下结论；还需当时 `/api/models/defaults` 的 `model` 返回或该工作区 localStorage。当前主测试服务已切为隔离 fixture，其 defaults 返回 `ui-fixture/test-model`，不能用现在的响应代替此前真实配置的响应。
- 现有 `tests/model-defaults.test.ts:41–73` 覆盖规则顺序、缺认证回退与第一个可用模型；未覆盖过期模型 ID 的实际配置组合，以及首屏工作区选择与该回退的浏览器接线。

## 仍需浏览器核验的静态线索

- 设置中的 `SelectOption` 也缺少方向键选择处理，需进一步核验键盘是否可以完成候选选择；Escape 的关闭层级问题已在 I-08 确认。
- 设置没有 dialog 语义、自动聚焦或焦点约束，需核验 Tab 是否进入后台聊天输入／发送按钮。
- 从技能设置打开文件查看器后，SettingsPanel 与 FileViewer 都有 document Escape 监听，需核验是否同时关闭两层。
- `SessionSidebar.tsx:926–928` 的重命名输入框同样没有输入法保护；尚未单独做探针。
- Drawer 的 tablist/tab 没有方向键切换实现。

### 响应式切换时设置消失：观察成立，所提 remount 根因尚未成立

主测试观察到 Edge 在 320px、768px 宽度时存在 `.settings-dialog`，切到 1440px 后节点消失。本次只读核验未发现“desktop/mobile 分支切换 remount 含设置状态的组件”这一根因：

- `AppShell.tsx:163` 持有 `settingsOpen`；`:1191–1209` 的 `SettingsPanel` 是始终渲染的根节点子组件，位于桌面／移动条件分支之外，也没有响应宽度变化的 key。
- `AppShell.tsx:288–295` 的 840px 媒体查询只更新 `isNarrow`、关闭移动侧栏，不修改设置状态。全 `src` 唯一的 `setSettingsOpen(false)` 在 `:1194` 的设置 `onClose` 中。
- 桌面 `:1141` 与移动 `:1159–1164` 确实切换 `rightColumn` 所在的分支，但设置不在该分支里。
- `globals.css:299–323` 只改变小屏设置弹窗尺寸、排列与圆角，没有隐藏桌面设置的规则。

因此应保留该浏览器观察，继续排查是否触发设置的关闭事件或页面重载；现有源码证据不足以将问题归因于响应式 remount，也不足以确认未保存表单必然因该机制丢失。

## 内存探针的方法与限制

通过 Node heredoc 读取现有 TSX，由已安装的 `rolldown/experimental.transformSync` 转成可执行模块，再使用已安装 React、Testing Library 和 jsdom 渲染。执行过程中不创建或改写源码、测试脚本、业务配置或工作区文件。

- 图标、i18n、文件图标工具及与目标行为无关的子组件使用最小桩；被审计组件的事件处理和状态更新来自当前源码。
- DirectoryPicker 使用受控 Promise 模拟不同完成顺序的目录请求，直接检查显示路径和确认回调。
- CustomSelect 检查 `aria-expanded`、候选存在性与 `onChange` 回调。
- FileViewer 用静态 Markdown 页签检查 DOM 图片 URL，并在快速打开框派发带 `isComposing` 的 Enter，检查 `onOpen` 和搜索框是否关闭。
- 这些探针不是仓库正式测试，不计入 Vitest 通过／失败数量。它们证明事件与状态行为，不能证明浏览器像素布局、触摸、滚动、实际输入法平台差异或图片 HTTP 状态。视觉与真实浏览器结果应按主测试记录单独确认。
