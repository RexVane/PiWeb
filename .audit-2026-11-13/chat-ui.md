# 聊天界面与事件流（ChatWindow / ChatInput / usePiWeb）审计报告

## 0. 覆盖范围

**逐行读完**（行数以磁盘当前状态为准）：

| 文件 | 行数 |
|---|---|
| `src/components/ChatWindow.tsx` | 2347（任务书写 2277，实际 2347） |
| `src/components/ChatInput.tsx` | 1143（任务书写 1114，实际 1143） |
| `src/hooks/usePiWeb.ts` | 1331（任务书写 1284，实际 1331） |
| `src/lib/chat/event-stream.ts` / `cancellation.ts` / `file-path.ts` / `skill-expansion.ts` / `task-notification.ts` / `compose-prompt.ts` | 113 / 15 / 85 / 51 / 13 / 7 |
| `src/lib/event-batcher.ts` / `slash-command-token.ts` | 62 / 14 |
| `src/lib/trajectory.ts` | 508 |
| `src/components/MarkdownBlock.tsx` | 550 |
| `src/components/chat/{markdown-actions.tsx,chat-scroll.ts,reading-anchor.ts}` | 25 / 18 / 81 |
| `src/components/{OutlineRail.tsx,AskUserCard.tsx}` | 216 / 216 |
| `src/components/composer/{ComposerImages.tsx,ComposerFiles.tsx}` | 258 / 224 |
| `src/lib/workspace-index.ts` / `src/hooks/useWorkspaceFiles.ts`（mention 解析，任务书里写作 `mention*`） | 268 / 93 |

**部分读**：`ContextMeter.tsx` 1–200/317、`TrajectoryView.tsx` 1–120/305（其余是纯展示/样式，按调用点抽查）。

**为走通取消链路跨区只读**（不评论其内部实现，只在第 3 节提请对应区域裁定）：`src/app/api/agent/[id]/route.ts`(24)、`.../events/route.ts`(115)、`src/lib/agent-manager.ts`（215–284、400–440、525–554、835–1035、2570–2720、2780–2900、3099–3120 段）、`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` 与 `agent-session.js` 的 `abort()`（仅用于核对调用语义）。

**没读/跳过**：`composer/PermissionSelector.tsx` 及全部 `.module.css`（权限语义归 sandbox/权限区域，视觉归 crosscut）；`ImageSelector/PreviewImage` 内部（crosscut）。

**结论一览**

| 子功能 | 结论 | 依据文件 |
|---|---|---|
| SSE 建连/断线续传/退避 | OK（服务端 `seq>lastEventId` 排他续放 + 断档回退整快照，客户端不重复不丢） | `event-stream.ts:61-113`、`usePiWeb.ts:1014-1052`、`agent-manager.ts:2588-2605` |
| SSE 轮询通道健壮性 | **有问题** P1-3（`onMessage` 无 try/catch，一次异常永久断流） | `event-stream.ts:99-103` |
| 快速切换会话串流 | OK（每个 `currentId` 一个 effect；cleanup 取消批处理 + 关连接） | `usePiWeb.ts:919-1052` |
| 事件顺序/去重/批量折叠 | OK，有真断言测试（含乱序、重复 end、相邻 delta 合并） | `use-piweb-events.test.ts:59-100`、`event-batcher.ts:47-54` |
| 背压/内存 | **有问题** P2-4（messages/tools/trajectory 全量驻留，且每次快照重传） | `usePiWeb.ts:979-1006`、`trajectory.ts:43-47` |
| 流式 Markdown 切块/抖动 | OK-但脆弱（切分器有针对性单测；同一消息出现第二块时会从流式版切回整段版重挂，P3 级闪动） | `MarkdownBlock.tsx:385-548`、`streaming-markdown.test.tsx` |
| 思考块折叠 | OK | `ChatWindow.tsx:804-829`、`chatwindow-cancellation-timing.test.tsx:20-41` |
| 长会话 lazy turns | OK | `ChatWindow.tsx:2017-2136`、`chatwindow-lazy-turns.test.tsx` |
| 滚动锚定/贴底 | OK-但脆弱（靠 `overflow-anchor` 能力检测分流，Safari 走手算；有测试） | `ChatWindow.tsx:2084-2136`、`reading-anchor.ts` |
| **停止/取消语义** | **有问题** P1-1 + P1-2（见下） | `ChatInput.tsx:506`、`AppShell.tsx:744`、`agent-manager.ts:2861-2871` |
| 消息队列 / steering / 取回 | OK（`queue_update` 是权威事件，abort 前先 clearQueue 且 SDK 会发 `queue_update`，不会出现"取回后队列条还在"） | `ChatInput.tsx:492-525,814-871`、`agent-manager.ts:2823-2871` |
| 编辑重发 / 分支 | OK-但脆弱（编辑重发同样要等服务端 abort，落入 P1-1 的同一个坑；失败有提示） | `AppShell.tsx:576-588`、`ChatWindow.tsx:1372-1379` |
| 草稿恢复 / 会话隔离 | OK-但脆弱（草稿存在 AppShell 的 ref Map 里，靠 `void draftVersion` 触发重渲染） | `AppShell.tsx:167-201,1279-1280` |
| `@` 提及解析 | OK（与 pi-tui 逐例对照 + 随机用例；端到端用真 fd 比候选顺序） | `workspace-index.ts`、`mention-parity.test.ts` |
| `@` 提及的实际语义 | OK-但需确认（references 只拼成 `@路径` 文本随 prompt 发出，SDK 不展开成文件内容；pi 的 `@file` 展开只发生在 CLI 参数上，见第 3 节） | `ChatInput.tsx:440-459`、`compose-prompt.ts`、`pi-dist/cli/file-processor.d.ts` |
| `/` 命令解析 | OK-但脆弱（内建命令与同名 pi 模板冲突时键入路径永远走内建，P3） | `slash-command-token.ts`、`ChatInput.tsx:242-245,374-412,442-452` |
| 附件：图片/文件/拖拽 | **有问题** P2-1、P2-2（无尺寸上限；第 21 张图静默丢弃；上传件删除只在本地生效） | `ChatInput.tsx:527-592` |
| 粘贴大文本 | **有问题** P2-1（无任何上限/折叠，与 pi 终端的 paste marker 能力不对等） | `ChatInput.tsx:924-930` |
| 渲染 XSS 面 | OK（无 `rehype-raw`；`defaultUrlTransform` 滤掉 `javascript:`；外链 `rel="noopener noreferrer"`；外图不自动加载） | `MarkdownBlock.tsx:273-315,179-197`、`react-markdown@10 lib/index.js:421-443` |
| mermaid | 不存在（全仓 `src/` 无 mermaid 依赖与用法，审计项不适用） | `package.json` |
| 轨迹 / 大纲 | OK（轨迹有 233 行测试；大纲靠 DOM 采集 + MutationObserver，`revision` 只做去抖） | `trajectory.ts`、`OutlineRail.tsx`、`trajectory.test.ts` |
| 移动端键盘/安全区 | **说不清** P2-5（无 `interactiveWidget`，面板用 `visualViewport` 对齐而聊天列用 `100dvh`；缺真机） | `layout.tsx:9-16`、`globals.css:465,857`、`ModelSelector.tsx:98` |
| Esc 行为 | **有问题** P3-3（运行中 Esc 不是停止键，与服务端注释里的"pi 终端 Esc 同款"不一致） | `ChatInput.tsx:931-1010`、`agent-manager.ts:2863` |

## 1. 发现（按严重度降序，同级按影响降序）

### P1-1 点"停止"后可能永久停在 streaming：`await session.abort()` 无上限，而唯一的复位事件排在它后面

- **位置**：`src/lib/agent-manager.ts:2861-2871`（断点）；前端入口 `src/components/AppShell.tsx:744` → `src/hooks/usePiWeb.ts:1054-1081` → `src/components/ChatInput.tsx:506,1061-1091`
- **证据**（链路各环原文）：

服务端唯一复位点排在**一个没有超时的 await 之后**：
```ts
// src/lib/agent-manager.ts:2861
case "abort": {
    if (!m.session) return { ok: true, data: { steering: [], followUp: [] } };
    const cleared = m.session.clearQueue();
    m.session.abortBash();
    await m.session.abort();                       // ← 无 catch、无超时
    publish(m, { type: "status", isStreaming: false, state: "aborted", ts: Date.now() });
    return { ok: true, data: cleared };
}
```
被等的这个方法自己就是"等到空闲才返回"（并非"发出中止就返回"）：
```ts
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2073
async abort() {
    ...
    this.agent.abort();
    await this.waitForIdle();      // ← 没有超时
}
```
同一个文件里另一处调用**是**加了上限的，说明这个坑团队已知：
```ts
// src/lib/agent-manager.ts:2676
/** 中止正在跑的回合并等待 SDK 回到空闲（最多等 5 秒）… */
async function abortRunAndWaitIdle(...) {
    await session.abort().catch(() => undefined);
    for (let i = 0; i < 50 && !m.disposed && (session.isStreaming || m.runActive); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
```
前端这条链上没有任何超时/兜底，也没有乐观复位：
```ts
// src/components/AppShell.tsx:744
const abortPrompt = useCallback(() => sendCommand({ cmd: "abort" }), [sendCommand]);
// src/hooks/usePiWeb.ts:1066
const r = await fetch(`/api/agent/${target}`, { method: "POST", ... });   // 无 signal / 无 timeout
// src/components/ChatInput.tsx:506
const stopAndRestore = async () => restoreQueued(await onAbort());
```
停止按钮在等待期间既不禁用、也没有"停止中"态（`ChatInput.tsx:1061-1091`，只有 `isStreaming` 一个条件）。

- **触发路径**：运行中点停止 → `ChatInput.stopAndRestore()` → `POST /api/agent/{id} {cmd:"abort"}` → `execute()` → `case "abort"` → `clearQueue()`/`abortBash()` 生效 → `await m.session.abort()`。若此刻有工具（沙箱 bash、扩展 `ctx.executeTool`、扩展 hook）不响应取消信号，`waitForIdle()` 永不 resolve → 这个 POST 永不返回 → `publish(status isStreaming:false)` 永不执行 → 客户端 `snapshot.isStreaming` 永远为 true。
- **后果**：界面上的停止钮一直亮着、`WorkingStep` 一直 `Working for 12m`、输入框 Enter 永远走 steer/followUp 分支；`ChatInput` 的 `stopAndRestore` 永远 pending（按钮连点会再发 N 个 abort POST）；只有等浏览器把这条连接掐断或用户刷新/换会话才恢复。这正是"点停止后仍 streaming、会话卡死"的形状。且**该会话在服务端也真的一直 busy**（`isManagedBusy` 含 `!session.isIdle`，`agent-manager.ts:1733`），侧栏状态点同样一直转。
- **置信度**：链路已确认（逐环读了原文）；"哪种工具会让 `waitForIdle()` 卡住"未复现，需按下面方法验：①在沙箱里跑一个忽略 SIGTERM 的长命令（如 `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)"`）再点停止，看 `POST /api/agent/{id}` 是否 60s 不返回；②或在扩展里挂一个 `await new Promise(()=>{})` 的 hook。
- **建议修法**（最小）：
  1. 服务端把复位从 await 后面拿出来并加界：
     ```ts
     const cleared = m.session.clearQueue();
     m.session.abortBash();
     const done = await Promise.race([
       m.session.abort().then(() => true, () => true),
       new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
     ]);
     publish(m, { type: "status", isStreaming: false, state: done ? "aborted" : "abort-timeout", ts: Date.now() });
     ```
     若担心"复位太早、run 其实还在跑"，改成推一个前端认识的 `state:"stopping"`（`WebEvent.status` 已有 `state` 字段，`ChatWindow` 只需把 `workingMessage` 换成"停止中…"），run 真正结束时 `agent_settled` 会再推一次权威值。
  2. 前端 `sendCommand` 对 `cmd === "abort"` 传 `signal: AbortSignal.timeout(15_000)`；`stopAndRestore` 增加 `stopping` 本地态：按钮禁用 + 文案"停止中…"，4s 未收到 `status:false` 就提示"停止请求未响应"并给一个 `resync()` 按钮。

### P1-2 `isStreaming` 只由一条 `status` 事件决定，客户端不与每 3 秒的会话轮询对账，丢一条事件即永久流式

- **位置**：`src/hooks/usePiWeb.ts:343-349`（唯一写入口）、`src/components/AppShell.tsx:534`（唯一读取口）；对账用的数据其实已经每 3 秒到浏览器：`src/hooks/usePiWeb.ts:859-870`
- **证据**：
```ts
// src/hooks/usePiWeb.ts:343
case "status":
    if (s.snapshot) s.snapshot = { ...s.snapshot, isStreaming: evt.isStreaming };
```
```ts
// src/components/AppShell.tsx:534
const isStreaming = snapshot?.isStreaming ?? false;
```
```ts
// src/hooks/usePiWeb.ts:859  —— 每 3 秒的 /api/sessions 已经带回权威 running 状态
const running: Record<string, { streaming: boolean; lastStep?: string }> = j.data.running ?? {};
...
(j.data.sessions as SessionSummary[]).map((s) => ({ ...s, streaming: running[s.path]?.streaming === true, ... }))
```
这份 `running` 只喂给侧栏，**没有回灌当前会话**（`AppShell.tsx` 全文只有 `snapshot?.isStreaming` 一处取值）。
- **触发路径**：任何一次 `status{isStreaming:false}` 没到浏览器——SSE 被中间代理掐断但 EventSource 仍认为 open、轮询循环死掉（P1-3）、`batcher.cancel()` 恰好丢掉缓冲里的这条、或服务端压根没发（P1-1）。之后除了重连拿快照（`resync`/`external_reload`/换会话/刷新）没有任何路径把它掰回来。
- **后果**：①永远显示 streaming（P1-1 的放大版）；②更硬的后果：流式态下 `doSend` 走 steer/followUp（`ChatInput.tsx:461-465`），而服务端此刻其实空闲 → 服务端直接拒绝：`{ ok:false, error:"session is busy; choose steer or followUp" }`（`agent-manager.ts:2801`）——用户看到一条英文报错、消息发不出去，但输入框仍显示"运行中"。**反向**（客户端认为空闲/服务端在跑）同样会撞这条 2801。
- **置信度**：已确认（读了完整链路；缺的是复现具体丢帧条件）。
- **建议修法**：在 `usePiWeb` 的会话列表轮询里加一次对账——当 `currentPath` 命中且连续两轮 `running[path].streaming === false` 而 `liveStateRef.current.snapshot?.isStreaming === true`（或事件静默 > 10s）时，`setResyncNonce(n => n+1)` 重连取快照（最多每 30s 一次）。同一处也顺便修 `error` 文案：把 2801 的英文错误映射成本地化提示。

### P1-3 轮询通道里 `onMessage` 没有 try/catch：一次异常永久断流，而 `connected` 仍是 true

- **位置**：`src/lib/chat/event-stream.ts:99-103`
- **证据**：
```ts
for (const frame of frames) {
    if (closed) return;
    handlers.onMessage(frame.data);      // ← 抛异常就冲出 while 循环
    if (frame.id !== undefined) lastEventId = frame.id;
}
```
外层是 `void (async () => { while (!closed) { ... } })()`（第 74 行），没有 `.catch`。`onMessage`（`usePiWeb.ts:952-1011`）虽然把 `JSON.parse` 包了 try/catch，但后面还有一段会抛的代码：`refreshModels()`、`extensionDialogsFromSnapshot(snap, ...)`（遍历 `snapshot.extensionUiRequests`，非数组即 TypeError）、`setState(...)` 里的 `toolsFromMessages(snap.messages, ...)`（`snap.messages` 异常时同）。
- **触发路径**：只在 `usesEventPolling(hostname)` 为真时走这条通道，即 `*.trycloudflare.com`（`event-stream.ts:12-14`，即"远程连接"公网入口）。一次格式漂移/服务端字段缺失 → 循环 Promise reject（无人处理）→ 之后再也不会发出任何轮询请求，`onError`/`onOpen` 都不再触发。
- **后果**：远程（手机/公网）用户界面停在某一帧：看起来"已连接"、`connected` 徽标不出现、消息不再增长、停止按钮永远亮着——和 P1-1 的用户体验完全一致，但根因在客户端。刷新页面能恢复（`EventSource` 路径不受影响，因为浏览器自己兜住了回调异常）。
- **置信度**：已确认代码缺陷；具体触发样例未构造（要复现可 stub `fetch` 返回一帧 `{"type":"snapshot","snapshot":{}}`，观察后续请求数归零）。
- **建议修法**：`try { handlers.onMessage(frame.data); } catch { handlers.onError(); closed = true-ish break }`——即"一帧坏掉就当成一次失败"，让退避重试接管；同时把 `onMessage` 里的 `extensionDialogsFromSnapshot`/`toolsFromMessages` 入参做 `Array.isArray` 防御。

### P2-1 用户输入与快照都没有尺寸上限：大粘贴 / 大图原样进会话，并且每次快照全量回传

- **位置**：`src/components/ChatInput.tsx:924-930`（粘贴）、`:527-553`（图片只按 20MB 拦，不做缩放）、`src/lib/agent-manager.ts:230`（图片以 base64 进快照）、`src/lib/trajectory.ts:43-47`（轨迹每条的截断上限）
- **证据**：
```ts
// ChatInput.tsx:924  —— 只拦"文件"，纯文本粘贴走浏览器默认行为，无任何长度判断
onPaste={(e) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); pickFiles(e.clipboardData.files); }
}}
```
```ts
// ChatInput.tsx:531 —— 图片只按源文件大小拦，不缩放（对比 pi CLI 侧的 autoResizeImages）
if (f.size > 20 * 1024 * 1024) { setAttachmentError(t.imageTooLarge); continue; }
... const image: ImageAttachment = { type:"image", data: dataUrl.slice(dataUrl.indexOf(",")+1), mimeType: f.type };
```
```ts
// agent-manager.ts:230 —— 会话里的图片在每次快照里整份回传
else if (c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
    items.push({ type: "image", data: c.data, mimeType: c.mimeType });
```
```ts
// usePiWeb.ts:988 —— 快照整体替换 messages
messages: snap.messages,
```
- **触发路径**：粘贴一段几 MB 的日志 / 拖入 5 张 4K 截图 → 进 draft（`text` 字符串 / base64 数组）→ 发送时 `JSON.stringify` 进 `POST /api/agent/{id}`（该路由 `await req.json()`，无体积限制）→ 落进会话 JSONL → 之后每一次建连/重连/`resync`/收压缩卡的快照都把整份 base64 再发一遍；`foldPiWebEvent` 每次 delta 还会 `[...m.content]` 浅拷贝。
- **后果**：手机经隧道打开这种会话：首屏几十 MB、快照 41KB→数 MB（服务端注释里的 41KB 是正常会话）、内存里 `messages` 常驻全量图片；粘贴超大文本还会让 `UserMessage` 的 Markdown 全量解析（`ChatWindow.tsx:1386`）卡住数百毫秒到数秒。
- **置信度**：已确认（尺寸链路上没有任何上限；未实测大图具体耗时）。
- **建议修法**：①客户端在 `pickFiles` 里对图片做一次 canvas 缩放（长边 ≤ 1568px、JPEG/webp 质量 0.85），并在 `uploadFile` 前对文本 paste 做"超过 20 万字符就折叠成附件/提示"，对齐 pi 终端的 paste marker；②服务端 `POST /api/agent` 增加 body 上限（如 8MB）与明确错误；③快照里的旧图片改为 URL 懒加载（`/api/files?image=1` 已有受保护通道），只对最后 N 条消息带内联 base64。

### P2-2 第 21 张图片被静默丢弃；发送/上传忙时拖放被静默忽略

- **位置**：`src/components/ChatInput.tsx:540`、`:528`、`:626`（全窗口 drop）
- **证据**：
```ts
// ChatInput.tsx:540 —— 超上限直接返回旧 state，没有 toast/日志
changeDraft((previous) => previous.images.length >= 20 ? previous : { ...previous, images: [...previous.images, image] });
```
```ts
// ChatInput.tsx:527
const pickFiles = (files: FileList | File[] | null) => {
    if (!files || disabled || isBlocked || sendingRef.current || pendingSend) return;   // 静默
```
- **触发路径**：一次拖入 30 张图（资源管理器多选）→ 前 20 张进入附件轨，其余 10 张无声消失；在"正在发送/权限切换中"时把文件拖到窗口上，遮罩都不出现、文件也不进。
- **后果**：用户以为附图都加上了，实际模型只收到 20 张；反过来在发送瞬间拖入的文件被静默吞掉，事后无从发现（无 toast、无日志）。
- **置信度**：已确认。
- **建议修法**：超限时 `setAttachmentError(t.uploadCountLimit.replace("{n}", ...))` 之类明确提示；`pickFiles` 的三个早退分支各给一句话提示（busy 时尤其要说"等发送完成再加"）。

### P2-3 `relativeMarkdownPath()` 允许 `..` 段，前端把它直接交给 openFile，与"只认工作区内相对路径"的注释不符

- **位置**：`src/lib/chat/file-path.ts:57-67`；调用点 `src/components/MarkdownBlock.tsx:142-177`
- **证据**：
```ts
// file-path.ts:57
export function relativeMarkdownPath(href: string): string | null {
    if (!href || /^[#?/~\\]/.test(href) || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
    const rawPath = href.split(/[?#]/, 1)[0];
    try {
        const decoded = decodeURIComponent(rawPath);
        if (!decoded || /[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
        return decoded;              // ← "../../../secrets/.env" 原样返回
```
同文件顶部注释第 10 行写的是"排除以 / 或 ~ 开头的绝对路径与家目录路径：它们不属于当前工作区"，但 `..` 逃逸没有被挡；`MarkdownBlock` 拿到它就 `event.preventDefault(); actions.openFile!(filePath)`。
- **触发路径**：模型输出 `[看这里](../../../.ssh/id_rsa)`（或被提示词注入的网页让它这么写）→ 用户在正文里点这个链接 → 前端请求文件查看器/本机编辑器打开该路径。
- **后果**：实际能不能读到工作区外的文件完全取决于 `/api/files` 的 `path-security`（**属于 API/鉴权区域，请其裁定**，见第 3 节）。前端这一层的"只认工作区相对路径"防线是空的：它既不规范化也不查前缀。至少是"注释与实现不一致 + 依赖下游兜底"。
- **置信度**：前端行为已确认；危害等级待 API 区域确认（若 `readWorkspaceFile` 已 clamp 到 cwd，则降为 P3）。
- **建议修法**：`relativeMarkdownPath` 里对解析后的路径做一次段折叠，出现"折叠后仍以 `..` 开头"就返回 null（和 `workspace-index.ts:125-129` 的 `..` 处理保持一致）；`MarkdownBlock` 侧再加一道"不含 `..` 段"的判断。

### P2-4 长会话的客户端状态无界增长（messages / tools / trajectory 全量驻留，且每次快照重建）

- **位置**：`src/hooks/usePiWeb.ts:979-1006`（快照整体替换）、`:441-469`（`toolsFromMessages` 每次快照全量重建）、`src/lib/trajectory.ts:43-47`（轨迹单条上限 8k/100k 字符）
- **证据**：
```ts
// usePiWeb.ts:986
setState((prev) => ({
    snapshot: snap,
    messages: snap.messages,
    tools: toolsFromMessages(snap.messages, snap.isStreaming),
```
轨迹是快照的一部分（`snapshot.trajectory`），单条 detail 上限 `TOOL_RESULT_MAX_CHARS = 8_000`、`MESSAGE_TEXT_MAX_CHARS = 100_000`，一个几百轮、几十次大输出的会话可达数 MB，且每次重连都整份重传；客户端 `tools` 只增不减（`foldPiWebEvent` 的 `"tool"` 分支从不删除条目）。
- **触发路径**：长时间使用同一个会话（PiWeb 的常态：一个工作区一个长会话），中途刷新/断线重连若干次。
- **后果**：快照帧越来越大（服务端注释里"41KB"是短会话），每次重连的解析 + `toolsFromMessages` 全量遍历 + 首屏 `buildTurns` 都在主线程上；低端手机上表现为"打开会话卡两三秒"。
- **置信度**：已确认数量级上的无界性，未做规模实测（可用现有 154 回合的性能注释口径，造 1000 条含大输出的会话量一下快照体积）。
- **建议修法**：①快照分页（首屏只给最近 N 条 + `before` 游标），`ChatWindow` 已经有 lazy turns，前端可顺着做"往上翻加载"；②轨迹只随 `/api/agent/{id}/tree` 类接口按需拉，不进每次快照。

### P2-5 移动端软键盘：面板都用 `visualViewport` 对齐，唯独聊天列高度用 `100dvh` 且没有 `interactiveWidget`

- **位置**：`src/app/layout.tsx:9-16`（无 `interactiveWidget`）、`src/app/globals.css:465,857`（`100dvh`）、对比 `src/components/ModelSelector.tsx:98-114`、`src/components/composer/PermissionSelector.tsx:65-92`（都监听 `visualViewport`）
- **证据**：
```ts
// layout.tsx:9
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [...] };
```
（`Viewport` 支持 `interactiveWidget: "resizes-content"`，这里没设，Android Chrome 默认 `resizes-visual`：键盘弹出时布局视口不变，`100dvh` 也不变。）
- **触发路径**：手机（尤其直连局域网，不经"远程连接"代理）点输入框 → 软键盘弹出 → 输入卡位于文档流底部、按 `100dvh` 布局 → 键盘盖住输入卡与发送/停止钮。
- **后果**：看不见自己在打什么、按不到停止。注意仓库里有一份手机适配 CSS 只对代理页注入（`src/lib/remote/assets.json` 的 "css" 段），所以"直连局域网"这条路径没有任何键盘补偿。
- **置信度**：**未确认**——这是从代码推断，缺真机验证。验法：Android Chrome 直连 `http://<lan-ip>:30141`，点输入框看输入卡是否被键盘盖住；iOS 上 `dvh` 同样不随键盘变化。
- **建议修法**：`layout.tsx` 的 viewport 加 `interactiveWidget: "resizes-content"`（Chrome/Android 生效）；或在 `AppShell` 底部容器用 `visualViewport.height`（已有监听范式可复制）设一个 CSS 变量给输入卡定位。

### P3-1 `turnBlockPropsEqual` 每帧对每个已挂载回合重建 toolIds 并做 O(n) 比较

- **位置**：`src/components/ChatWindow.tsx:1835-1878`
- **证据**：
```ts
const toolIds: string[] = [];
for (const index of indexes) { for (const part of prev.messages[index]?.content ?? []) { ... } }
for (let i = 0; i < toolIds.length; i += 1) { for (const child of next.tools[toolIds[i]]?.children ?? []) ... }
return toolIds.every((id) => prev.tools[id] === next.tools[id]);
```
- **触发路径**：流式期间每 16ms（`event-batcher` 一帧）父子都会重渲染，React 对每个 `memo` 子组件调用一次比较器。
- **后果**：长会话（几百回合、上千次工具调用）每帧都要把所有已挂载回合的工具 id 重新收集一遍；这是"长会话越用越卡"的一个常数项。
- **置信度**：已确认代码；未实测占比。
- **建议修法**：把每个回合用到的 toolIds 缓存进回合对象（`buildTurns` 时算一次），比较器只做引用比较。

### P3-2 ContextMeter 打开时每帧全量重算字符分类

- **位置**：`src/components/ContextMeter.tsx:70-72`
- **证据**：`const messages = open ? source?.getMessages?.() ?? source?.messages ?? EMPTY_MESSAGES : EMPTY_MESSAGES;` 后接 `useMemo(() => classifyMessageChars(context.messages), [context])`——惰性 getter 每次渲染返回新数组，`useMemo` 等于失效。
- **后果**：流式期间开着上下文弹窗，每 16ms 扫一遍全部消息文本。
- **建议修法**：用 `messages.length + 最后一条 timestamp` 之类的稳定 key 做 memo 依赖，或只在 `open` 打开时算一次 + 用户点击刷新。

### P3-3 运行中 Esc 不是停止键（与服务端注释里对照的 pi 终端语义不一致）

- **位置**：`src/components/ChatInput.tsx:931-1010`（textarea 的 keydown 里所有 Esc 分支都只关菜单 / 摘命令胶囊）；对照 `src/lib/agent-manager.ts:2863` 注释"先清队列再中止（pi 终端 Esc 同款）"
- **证据**：`onKeyDown` 里 Escape 只出现在 mention 菜单（`:936`）、已采纳命令（`:962`）、命令菜单（`:980`）三处；没有任何 `isStreaming` + Esc → `onAbort()` 的分支，页面级也没有全局 Esc 停止（`AppShell.tsx` 仅 `:1547` 用于关工作区菜单）。
- **后果**：从终端过来的用户会按 Esc 期望停下，实际什么都没发生（输入框非空时连菜单都不关）。
- **建议修法**：`if (e.key === "Escape" && isStreaming && !menuOpen && text === "") void stopAndRestore();`（或加确认：连按两次）。

### P3-4 `role="log" aria-live="polite"` 让读屏器在 token 流下持续播报

- **位置**：`src/components/ChatWindow.tsx:2220-2222`
- **后果**：流式每帧都有 DOM 变更，屏幕阅读器队列被塞满，长回答期间基本无法使用。
- **建议修法**：流式期间去掉 `aria-live`（或改成只在回合结束时对最终回答容器播报一次）。

### P3-5 内建命令与同名 pi 模板冲突时，键入路径永远走内建

- **位置**：`src/components/ChatInput.tsx:442-452` 与 `:714-724`（菜单）
- **证据**：`doSend` 里 `const builtin = (commands ?? []).find((c) => c.kind === "builtin" && c.name.toLowerCase() === head.toLowerCase());` 命中即执行并 `return`；而菜单列表是 `[...builtins, ...templates, ...skills].sort(byName)`（`AppShell.tsx:775-788`），同名时两行都显示。
- **后果**：用户装了一个叫 `compact` 的提示模板，键入 `/compact` + Enter 永远触发 PiWeb 的压缩，模板只能从菜单里点。
- **建议修法**：同名冲突时优先用户定义的（template/skill/extension），或把内建加前缀/在菜单里标注优先级。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 点"停止"的整条链 | **生产已复现的 P1-1；UI→hook 这一段没有任何测试**：所有 ChatInput 测试都是 `onAbort={vi.fn()}`（`chat-input-lifecycle/queue/commands/mentions/chips/bash.test.tsx`、`ask-user-card.test.tsx` 全是这样）；服务端只有 `tests/extension-surface.test.ts:263` 一条"停止同时中断 `!` 命令"，没有覆盖"abort 阻塞时状态复位" | ①`onAbort` 返回 `{data:{steering,followUp}}` 时文本回到输入框、`queue` 条消失；②`onAbort` 永不 resolve 时按钮进入"停止中"且 4s 后给出未响应提示（即 P1-1 的修法）；③连点只发一次 |
| `status{isStreaming:false}` 与轮询的会话状态对账 | P1-2：丢一条事件就永久 streaming，没有任何兜底 | 用现有 `settings-tools-session.test.tsx` 的 hook 夹具：打开流式会话 → 不再发 `status` → 让 `/api/sessions` 报 `running:{}` → 断言 N 秒后 `resync()`/`isStreaming` 复位 |
| 轮询通道单帧异常 | P1-3：一次抛异常永久断流且无人知晓 | `event-stream.test.ts` 加一例：`onMessage` 第一次抛错，断言后续仍继续轮询（而不是请求数停在 1） |
| 快速切换会话时的旧流隔离 | 审计重点 1 的"串流"，目前只有"每个 currentId 一个 effect"的隐式保证 | A 会话的 poll 响应在切换后到达（延迟 resolve），断言不会写进 B 的 `messages`/`isStreaming` |
| 附件上限与失败反馈 | P2-2 是纯静默失败 | 一次传入 25 张图 → 断言有可见提示且只保留 20 张；`pendingSend` 时 drop → 断言有提示 |
| 大粘贴 / 大图 | P2-1 的输入面上限不存在 | 粘贴 1MB 文本 → 断言折叠/提示（改完后）；20MB 图片 → 已有 `imageTooLarge`，但缺"缩放后发送"的断言 |
| 压缩卡插入推进列表中间后的 `isStreaming`/回合索引 | 回合序号是 `nearTurns` 的 key，插卡会让序号整体后移 | 已有 `compaction-display`/`chatwindow-compaction`，但缺"压缩发生在流式中、UI 仍不许丢 `WorkingStep`/不许把可见回合降级成 TurnLite" |
| `/` 命令与 `@` 引用混发 | `composePrompt` 的 `base` 在前、引用在后；内建命令带引用时会绕过内建分支 | 断言 `/compact` + 1 个引用 chip 的行为符合预期（现在是"当普通提问发出去"） |

测试质量的正面记录（不必补）：`use-piweb-events.test.ts` 是真断言（乱序、重复 end、相邻 delta 合并、延迟 end 覆盖快照、嵌套调用），`mention-parity.test.ts` 直接拿 pi-tui 当基准做逐例 + 随机 + 真 fd 端到端，这在本仓里属于最高水准。

## 3. 与其他区域的可能交叉点

1. **bridge（`agent-manager.ts`）**：P1-1 的断点在 `case "abort"`（2861-2871）——`await m.session.abort()` 无 catch 无超时，且 `publish(status false)` 在其后；同文件 `abortRunAndWaitIdle`（2676-2684）已经做了 5s 上限，两处口径不一致。另外 `isManagedBusy` 含 `!session.isIdle`（1733）：只要 SDK 侧 `isIdle` 因残留的 queued continuation 一直为 false，**所有**后续 `status` 都会报 streaming，前端无解——请 bridge 区域确认 `agent_settled` 里的 `clearQueue` 兜底（973）是否覆盖了所有残留路径。
2. **sandbox/权限**：`waitForIdle()` 卡住最可能的现实原因是某个工具不响应取消。请 sandbox 区域确认 `createSandboxBashOperations` 的取消路径（`abortBash` → 子进程 kill）在 Windows 上对 `cmd.exe`/`powershell` 包装层是否真的会终止，以及 `ctx.executeTool` 类的嵌套调用是否可取消。
3. **API/鉴权**：①`POST /api/agent/{id}` 无 body 上限（P2-1）、无请求超时；②`relativeMarkdownPath` 交给 `/api/files` 的 `..` 路径是否被 `path-security` clamp（P2-3，决定它是 P2 还是 P3）；③上传件生命周期：`ChatInput` 删除/清空/发送后**不会**通知服务端删文件（`onRemove`/`onClear` 只改 draft，见 `ChatInput.tsx:754,803`），请确认 `saveUploadStream` 的临时目录有无 TTL 清理，否则用户删掉的附件会永久占盘。
4. **crosscut**：`AppShell.tsx:171-180` 用 `const [draftVersion, setDraftVersion] = useState(0); void draftVersion;` 强制每次按键整树重渲染（含侧栏/面板），属于 AppShell 的取舍，不在我范围，只记录。`PreviewImage`/`DiffView` 的渲染面同样未审。
5. **i18n**：服务端错误直出英文（`"session is busy; choose steer or followUp"`、`"prompt acceptance pending"`），会原样出现在输入卡上的红色 toast 里。

## 4. 建议优先修的 3 件事

1. **P1-1**：`case "abort"` 里把 `publish(status isStreaming:false)` 从事后挪到有界等待之后/并用 `Promise.race` 加 5s 上限；前端 `stopAndRestore` 加 `stopping` 态 + 超时提示 + `sendCommand` 对 abort 传 `AbortSignal.timeout`。这是生产已经踩到的那条，一条改动同时解决"点停止没反应"和"按钮能连点 N 次"。
2. **P1-2**：用已经每 3 秒到手的 `/api/sessions` `running` 给 `snapshot.isStreaming` 做对账（连续两轮不一致就 `resync()`）。它把"任何一次事件丢失"从"永久卡死"降级成"最多 6 秒后自愈"，代价极小且不动服务端。
3. **P1-3**：`event-stream.ts` 的帧循环加 try/catch → 转成一次 `onError` 让退避重试接管。远程/隧道用户的"界面不动了"这一整类问题会少一大半。
