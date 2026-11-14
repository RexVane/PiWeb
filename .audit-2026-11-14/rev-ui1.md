# rev-ui1 — 前端静态审查（相对 HEAD 1d4efba 的未提交工作区）

审查日期：2026-11-14。只做静态分析，未运行 npm/vitest/build。范围：AppShell.tsx、ChatWindow.tsx、ChatInput.tsx、SessionSidebar.tsx、SessionHistory.tsx（新）、SessionHistory.module.css（新）、FileViewer.tsx、GitPanel.tsx、ConfirmDialog.tsx（新）、ErrorToast.tsx（新）、FloatingToast.tsx（新）、page.tsx、layout.tsx、i18n.tsx。

---

## 发现

### [MEDIUM] src/components/ChatInput.tsx:195-207（配合 AppShell.tsx:1374）
**问题**：Composer 的发送/停止/上传/错误状态是组件本地 state，而会话切换时 `MemoChatInput` 不重挂载（ChatWindow 有 `key={currentId}`，ChatInput 没有），这些状态跨会话泄漏。
**触发条件**：会话 A 中有发送/停止/上传在途时切换到会话 B：`sending`/`stopping`/`queueSending`/`uploadCount` 未清零 → `sendBusy`/`uploadBusy` 为真，B 的输入框 Enter 静默无效（doSend 第 433 行早退）；B 的停止按钮显示转圈。另外切换后 A 的迟回异步回调（abort/上传/发送失败路径 `setAttachmentError`，ChatInput.tsx:542/547/566/626）会把 A 的错误文案写在 B 的输入卡上（`uploadFailure` 同步效应只在 prop 变化时跑一次，救不回切换后新设的本地错误）。
**期望行为**：在途状态按会话隔离（如同文件里 `pendingSend` 走 `pendingSends[draftKey]` 的键控做法），或切换会话时重置。
**实际行为**：整个 composer 实例共享一份在途/错误状态，跨会话相互阻塞、错误文案串场。
**证据**：ChatInput.tsx:195-207 `const sendingRef…const [sending, setSending] = useState(false); …const [uploadCount, setUploadCount] = useState(0); const uploadBusy = uploadCount > 0 || pendingUploadCount > 0; const sendBusy = sending || pendingSend || stopping;`（其中仅 `pendingSend`/`pendingUploadCount` 是键控 prop）；AppShell.tsx:1347 `<ChatWindow key={currentId ?? "none"} …>` 同层 `:1374 <MemoChatInput`（无 key）；ChatInput.tsx:457-494 各失败路径 `setAttachmentError(result.error)`。
**修复建议**：把 `sending/stopping/queueSending/uploadCount` 上提为按 `draftKey` 键控（与 `pendingSends` 同构），或给 MemoChatInput 加 `key={draftKey}` 使其随会话重挂载（注意保留草稿在父层，不影响草稿持久化）。
**最小失败测试**：渲染两个会话，A 中 mock `onSend` 为挂起 Promise，按发送后切到 B，断言 B 的 textarea Enter 能触发 `onSend`（当前实现下不触发）。

### [MEDIUM] src/components/SessionSidebar.tsx:178（配合 src/hooks/usePiWeb.ts:551、898-961）
**问题**：侧栏搜索框每敲一个字符就触发一次服务端全量会话搜索请求，无防抖；且每次请求都整页重拉（If-None-Match 因 effect 闭包重建而失效），并把已加载的分页上限重置回 200。
**触发条件**：会话数量大（≥ 数百）时在侧栏搜索框连续输入。
**期望行为**：输入防抖（300ms 级）或请求内去抖；保留 304/分页状态。
**实际行为**：SessionSidebar.tsx:178 `useEffect(() => { onSearchQuery?.(searchOpen ? q.trim() : ""); }, [onSearchQuery, searchOpen, q])` 每击键回调；usePiWeb.ts:551 `setSessionSearch(query); setSessionPageLimit(200)` → :961 依赖含 `sessionSearch` 的会话列表 effect 重跑 → :898 无条件 `fetch("/api/sessions?limit=…&q=…")`（lastEtag 为 effect 闭包内变量，重跑即丢，304 分支失效），仅靠 AbortController 保证同时只有一个在途。
**证据**：见上，均为原文。
**修复建议**：在 SessionSidebar 的 effect 内对 `q` 做 300ms 防抖后再调 `onSearchQuery`；或 usePiWeb 的 load 复用跨次 lastEtag。
**最小失败测试**：mock fetch，输入 "abc"（3 次 onChange），断言 `/api/sessions?q=` 请求次数 ≤ 1-2（当前实现为 3）。

### [MEDIUM] src/i18n.tsx:2209-2216（配合 src/app/layout.tsx:19-22）
**问题**：语言偏好的 SSR 对齐依赖 cookie；cookie 缺失而 localStorage 有偏好时，首帧按 zh 渲染、水合后 effect 再切到 en，整树文案闪变（首帧闪烁），且首帧与最终语言不一致。
**触发条件**：`piweb.lang` cookie 不存在（被清理/浏览器拦截 cookie）但 localStorage `piweb.lang === "en"`；每次整页刷新都复现。
**期望行为**：首帧即 en（cookie 写入失败时有别的 SSR 通道），或接受闪变但明确记录该退化路径。
**实际行为**：layout.tsx:20 `preferences.get("piweb.lang")?.value` 为空 → `initialLang` undefined → 服务端按 zh 渲染 `<html lang="zh-CN">` 与全部文案；i18n.tsx:2211-2214 水合后 `setLangState("en")` 并补写 cookie——仅首次补写，cookie 一直被拦的环境下每次刷新都闪。
**证据**：i18n.tsx:2209-2216 原文（`if (!ownsContext || initialLang !== undefined) return; const saved = safeLocalStorage.getItem("piweb.lang"); if (saved === "en" || saved === "zh") { setLangState(saved); document.cookie = … }`）。
**修复建议**：保持现状可接受但建议在 `setLang` 之外也把 cookie 写入挪到 `applyPebrelTheme` 同级的初始化里同步补；或首帧用 `<html data-lang-anim>` 抑制可见闪变。至少：该退化路径加注释/埋点。
**最小失败测试**：jsdom 清空 cookie、设 localStorage `piweb.lang=en`，水合后断言 `document.documentElement.lang === "en"`（通过），并断言首帧渲染（useEffect 前）文本为中文——证明闪变存在。

### [MEDIUM] src/components/AppShell.tsx:241、623、626、629
**问题**：新增的用户可见错误文案硬编码中文，绕过 i18n（应用已有 zh/en 双语字典与运行时切换）。
**触发条件**：界面语言切到 English 后：① sessionStorage 写入失败（草稿超 10MB/禁用）② 模型目录刷新失败 ③ 流式中应用模型配置 ④ 应用期间切换了会话。
**期望行为**：经 `t.*` 字典输出。
**实际行为**：直接输出中文：
- :241 `setError("草稿暂时无法保存到此浏览器，刷新前请先发送或复制内容。")`
- :623 `throw new Error(result.error || "模型目录刷新失败，请重试。")`
- :626 `return { success: false, error: "请等待当前会话结束后再应用。" }`
- :629 `return { success: false, error: "会话已切换，请在当前会话重新应用。" }`

（同类还有 src/lib/client-fetch.ts:10 的超时文案「请求超时…」，该文件不在本范围内，仅提示。）
**证据**：原文如上。
**修复建议**：四处改为 `t.draftPersistFailed` 等字典键，i18n.tsx 两个字典补键。
**最小失败测试**：语言设 en，mock sessionStorage.setItem 抛错，断言错误横幅不含 CJK 字符。

### [QUESTION] src/app/layout.tsx:21
**问题**：App Router 根布局里手写 `<head>` 元素塞内联主题脚本（`dangerouslySetInnerHTML`，常量字符串，非注入风险）。
**触发条件**：无明确触发——静态分析无法证明当前 Next 16.4.5 会渲染/保留手写 `<head>`；node_modules/next/dist/docs 仅 index.md，无相关约定说明。若被剥离，仅退化为首帧主题闪烁（AppShell:426-440 的挂载后 syncPebrelTheme 会兜底），不致错渲染。
**期望行为**：主题脚本在首帧 HTML 解析期执行。
**实际行为**：未知（静态分析无证据）；脚本本身为常量、先于水合执行时与 `suppressHydrationWarning` 配合无水合冲突。
**证据**：`<head><script dangerouslySetInnerHTML={{ __html: `(function(){try{var r=document.documentElement;…` }} /></head>`。
**修复建议**：若实测被剥离，改用 Next 官方的 `<Script strategy="beforeInteractive">` 或把脚本挂到 `<html>` 内首个 `<body>` 前。
**最小失败测试**：SSR 输出快照断言 `<script>` 位于 `<body>` 之前。

### [QUESTION] src/components/ChatInput.tsx:518-524
**问题**：`restoreQueued` 把服务端返回的 `data.images` 直接并入草稿，未走 20 张上限与 `MAX_IMAGES_BASE64` 预算校验（pickFiles/恢复草稿两条路径都有校验，唯独这条没有）。
**触发条件**：队列中积压了带图消息后 stopAndRestore / clearQueue 取回。正常服务端数据不会超限，故仅是防御缺口，无明确用户可见故障。
**期望行为**：与 pickFiles 相同的封顶行为（超限丢弃并提示）。
**实际行为**：`images: [...restoredImages, ...previous.images]` 无条件合并。
**证据**：ChatInput.tsx:522 原文。
**修复建议**：合并前按 `MAX_IMAGES_BASE64`/20 张截断。
**最小失败测试**：mock `onAbort` 返回 25 张图，断言草稿图片数 ≤ 20。

### [QUESTION] src/components/AppShell.tsx:714-728（未改动代码，相邻性提示）
**问题**：`doDeleteSession` 没有 `doArchiveSession` 本次新增的 `archiveActivePathRef` 会话切换守卫：闭包里的 `currentPath` 在 await 期间可能过期。
**触发条件**：删除当前会话，请求在途时切到会话 B；删除完成后果断把用户从 B 拉走（openSession(next)/closeSession）。属于本次为归档路径修掉的同一类「旧请求晚回覆盖新会话」，删除路径未同步修复。该函数本 diff 未改动，故仅记 QUESTION。
**期望行为**：与 :692 相同的 `samePath(path, archiveActivePathRef.current)` 守卫。
**实际行为**：`if (!currentPath || !samePath(path, currentPath)) return;` 只看回调创建时的闭包值。
**证据**：AppShell.tsx:719 原文 vs :692 新增守卫。
**修复建议**：复制 `archiveActivePathRef` 模式（或统一抽一个 `activePathRef`）。
**最小失败测试**：删除 A 在途时切到 B，断言最终停留在 B。

---

## 覆盖清单

- AppShell.tsx：diff 全量读（草稿持久化/恢复、快照会话门控、模型配置应用、归档/删除切换、commandResources、mobile inert、快捷键、state.error 自动清除、SessionHistory 入口、workspace 视图分支、Hero/菜单事件清理）；相关上下文行（390-455、620-745、1150-1530）精读。
- ChatWindow.tsx：diff 全量读（TurnMetaPill portal 化/滚动翻转/自动关闭、sumTurnUsage、FinalAnswer/turnProvider/turnModel、permissionPreview、图片 url 透传、ErrorToast 替换、宽度拖拽 localStorage→safeLocalStorage）；懒渲染/memo 比较器（1831-1882、1960-2145）精读。
- ChatInput.tsx：diff 全量读 + changeDraft/draftRef 机制、doSend 全路径、pickFiles 串行解码、uploadFile finally、拖放监听、键盘分支顺序（1000-1056）精读。
- SessionSidebar.tsx：diff 全量读（搜索接服务端、归档确认流、删除对话框 focus trap 补齐、load-more、workspace 导航）。
- SessionHistory.tsx / .module.css：新文件全文精读（游标分页、中断/竞态、useDialog、导出链接）。
- FileViewer.tsx：diff 全量读（fetchCache TTL/字节/条目上限与 LRU、refreshCachedFile、AbortController、currentLoaded 键控防过期、encodingUnsupported、下载/复制按钮）；缓存 URL 形态核对（cwd+path 均可被 refresh 命中）。
- GitPanel.tsx：diff 全量读（复制补丁、copiedDiff 指示）。
- ConfirmDialog.tsx / ErrorToast.tsx / FloatingToast.tsx：新文件全文精读（useDialog 接入、promise 式 confirm 的 resolve/卸载清理）。
- page.tsx / layout.tsx / i18n.tsx：diff 全量读 + provider 段精读（2204-2231）；新增 t.* 键双语齐备性脚本核对（57 键 ×2，仅 archiveSession 因 unarchiveSession 子串计 4）。
- 周边证据：useDialog.ts、client-fetch.ts、browser-storage（存在性）、image-attachment.ts、slash-command-token.ts、theme.ts（applyLightDark 属性互斥）、usePiWeb.ts（会话列表 fetch/分页/reconcile/watchdog、archiveSession 抛错路径）、package.json（react 19.3 → `inert` 布尔 prop 合法）、node_modules/next/dist/docs（无 <head> 约定文档）。
- XSS 面：src/components 内全部 `dangerouslySetInnerHTML` 定位（DiffView/FullDiff/CodeBlock 均为 hljs 转义输出，未改动；MarkdownBlock 无 rehype-raw/sanitize 配置，react-markdown 默认转义原文 HTML；PreviewImage 仅 `<img src>`）。

## 未追踪清单（超出本次可核对范围）

1. usePiWeb.ts 内部（SSE 批处理器、事件路由、快照/消息原子性、对账 watchdog 的正确性）——仅审查了会话列表 fetch、archiveSession、searchSessions 调用面。
2. AppShell 新引入的 workspace 视图组件本体：SkillsPluginsViews、AutomationsWorkspaceView、settings/、workspace/ 目录（不在范围清单）。
3. MarkdownBlock / DiffView / FullDiff / PreviewImage / AskUserCard / ExtensionUI / useWorkspaceFiles / useGrowth 的内部改动（已改动但不在范围清单；仅从调用面核对了 XSS sink 与 range/changes 身份稳定性）。
4. client-fetch.ts 与 EventSource 长连接的交互（SSE 走 EventSource，不经过该封装；未逐行追踪 usePiWeb 事件流）。
5. 测试文件（新增/修改的 tests/**）与脚本层（scripts/、bin/pi.js、next.config.ts、globals.css）。
6. 服务端路由实现（/api/sessions/[id]/history、/api/files/download、/api/files/upload 等）与 `snapshot.history.omitted` 的生成端。

## 各维度结论

- 会话切换竞态与过期状态覆盖：**1 MEDIUM**（composer 在途状态跨会话泄漏）+ **1 QUESTION**（doDeleteSession 缺守卫，未改动代码）。快照会话门控（AppShell:570）与草稿「captured 回调定位到所属会话」的机制本身设计正确，旧快照/旧消息覆盖新会话的窗口已在 AppShell 层关闭。
- useEffect 清理泄漏：**未发现问题**。新增/改动的全部 effect（定时器、document 监听、ResizeObserver、visualViewport、AbortController、drift listener、pagehide）均有成对清理；FileViewer 目录/内容请求补上了 abort。
- dangerouslySetInnerHTML / XSS：**未发现问题**。layout.tsx 内联脚本为常量字符串；会话内容走 react-markdown（无 rehype-raw）+ `<pre>` 文本节点；hljs 输出经转义；无把消息数据塞进 HTML 的路径。
- i18n 水合不一致：**2 MEDIUM**（cookie 缺失时首帧 zh→水合后 en 的整树闪变；4 处硬编码中文错误文案）。正常 cookie 路径 SSR/CSR 首帧一致，无 mismatch 导致整页重载的证据。
- 键盘/焦点回归：**未发现问题**。Escape 分支有先后序（菜单关闭优先于中止流式， composing/IME 有守卫）；useDialog 栈式焦点陷阱与 Escape 归属正确；Ctrl+Shift+E 与新弹层无键位冲突；`inert` 仅窄屏收起态施加（react 19 布尔 prop 合法）。侧栏删除会话对话框本次补上了 useDialog ref（顺带修复）。
- 长会话性能：**1 MEDIUM**（侧栏搜索每击键全量服务端请求）。对话主链路有回合懒渲染 + 逐回合 memo 比较器 + 16ms 事件批处理，本次改动未引入每击键全量重渲染；草稿持久化为 300ms 尾沿防抖 + 10MB 上限。
- FileViewer 大文件：**未发现问题**。截断/二进制/编码不支持均有显式 UI；模块缓存新增 60s TTL、8MB/32 条上限、LRU 淘汰与失败剔除；刷新按钮按 cwd+path 精准清缓存并重取（核对过全部缓存 URL 形态）；竞态由 contentKey + alive + AbortController 三重防过期。
- SessionHistory 虚拟化/分页与内存：**未发现问题**。固定 100 条/页、内存中仅持一页、响应长度 >100 直接判错、游标分页（before/after/latest 三态互斥）、失败可重试、滚回顶部；100 条 markdown 同屏渲染属有界成本。
- 状态与后端不同步（streaming 卡死、轮询对账缺失）：**范围内未发现问题**。isStreaming/queue/skills/stats 全部经会话门控的快照派生；断连时快照区显示「连接丢失 + 重试」；对账 watchdog 位于 usePiWeb（未追踪项 1）。
