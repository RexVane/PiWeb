# 会话切换堆增长：只读代码复核

状态：代码候选已核实；**尚未拿到增长对象的 retaining path，不能指定泄漏根因，也未修改产品代码。** 本复核没有启动浏览器、服务或计时负载。

前端实测提供的条件：侧栏点击固定 `Performance session 298` 与 `Performance long session`，共 50 次；每 10 次回到同一短会话并 GC，JS heap 约 89.34→105.14→121.22→137.19→152.51→168.09 MiB。attached DOM 4060、CDP nodes 4788、documents 1、listeners 1228 保持一致。这个稳定斜率需要调查；DOM 恒定不能单独排除 JavaScript 对象或网络响应的保留。

## 已确认的清理及有界状态

| 位置 | 源码证据 | 对本次两个固定会话交替的意义 |
| --- | --- | --- |
| `src/hooks/usePiWeb.ts:992–1152` | 切换时替换会话 state；清 watchdog/retry；cancel batcher；close EventSource；移除 online/offline 监听器；清 esRef/batcherRef | 未见每次快照累加到历史数组或 Map 的实现。close 后是否还有浏览器原生根保留，需要快照确认，不能只凭调用 close 宣称无问题 |
| `src/lib/event-batcher.ts` | cancel 会清计时器并把 pending 置为空数组；默认队列上限 400 | 静态上不是无限事件积压容器 |
| `src/components/AppShell.tsx:1348` | `ChatWindow` 使用 `key={currentId}`，切会话卸载重建 | ChatWindow 的 turns/slot Map/nearTurns 是单次挂载所有，不是跨 50 次累加的共享缓存 |
| `src/components/ChatWindow.tsx:1977–1991` 与 `src/components/chat/reading-anchor.ts:65–80` | ResizeObserver disconnect、全局监听 remove；多数 rAF 在 effect cleanup cancel | 没发现每切一次就新增永久窗口监听的直接路径；与实测监听器数恒定一致 |
| `src/components/SessionHistory.tsx:35–55` | 历史页 replace loaded state；每页最多 100 条；切换/卸载 abort | 普通侧栏切换并未打开此组件，不能把历史分页缓存列为本轮根因 |
| `src/components/AppShell.tsx:179–196/356–364` | 草稿按 session key 覆盖；资源按 cwd 覆盖 | 同一工作区、两个会话、没有新增草稿，键数不会随切换次数线性增长 |
| `src/hooks/useWorkspaceFiles.ts:33–61` | 按 cwd 缓存并覆盖，同 cwd in-flight 去重，完成后删除 in-flight | 单工作区无法靠新键解释每次 +1.6 MiB；跨大量工作区的上限是另一个议题，不能混入本轮 |
| `src/hooks/useGrowth.ts:173–194/290–294` | 每 scope 跟踪 AbortController，切换清空并 abort；请求 finally 删除 controller | 静态上没有让全部旧 scope 一直留在共享列表的路径 |
| `src/components/SessionSidebar.tsx:346–405/470–485` | 分组、排序、搜索使用当前 props 的 useMemo 局部 Map/数组 | 未见累计每次会话点击内容的外部 cache |

## 值得在快照里验证的候选

1. **模型目录请求与旧响应/闭包保留。** `usePiWeb.ts:966–988` 在 currentId 改变后请求模型目录；`usePiWeb.ts:1058` 收到 snapshot 又请求一次。每次返回约 329 KB JSON，解析后的数组/对象更大。旧请求仅由 request nonce/activeSessionRef 判作失效，没有 AbortController 取消。它能造成暂时的重复请求和分配，**目前没有证据证明请求完成后的结果被永久保留**。精确验证：无探针复跑后静置至少 35 秒再次 GC；快照查 `Response`、`ReadableStream`、`AbortController`、model/provider 数组，以及 `refreshModels` 的旧闭包 retaining path。若静置后仍同斜率，应排除“只是尚未完成请求”的解释。

2. **EventSource 原生对象与回调闭包。** `usePiWeb.ts:1105–1126` 给每个连接设置 onmessage/onerror/onopen/ping；cleanup 调 close，但没有逐项设 null 或 remove ping。正常 GC 可以回收不可达的闭环，不能把“未设 null”直接当缺陷。精确验证：堆内 closed EventSource 数量是否随 10/20/50 次增长，以及旧回调是否由浏览器根、诊断监听器或其它对象保留；若数量稳定，此候选可排除。禁止为了对齐怀疑先改代码。

3. **Markdown/高亮器反复初始化的分配。** `MarkdownBlock.tsx:272–278` 每个 MarkdownContent 都挂 `rehype-highlight`；安装版 `node_modules/rehype-highlight/lib/index.js:53–69` 每个 processor 创建 lowlight 并注册 common languages。重建 ChatWindow 会重新走该路径，哪怕合成消息没有代码块。没有查到应用层全局保存这些 processor 的集合，故目前是分配热点候选，不能称泄漏。精确验证：快照是否出现持续增长的 grammar/compiled language/processor/transform closure，并沿强引用追到根；只有瞬时对象或 GC 后消失就不成立。

4. **框架 history/路由状态。** 侧栏最终调用 `storeSessionLocation`（`src/lib/chat/session-location.ts:14–24`）的 pushState。安装版 Next 的 `app-router.js:274–312` 会包装 pushState 并 dispatch restore。应用没有把聊天正文放入 history.state，但框架内部可能持有自己的路由节点。精确验证：快照查增长是否由 Next cache/restore/route tree 或浏览器历史关联对象支配；仅有 50 条小 history 记录不足以解释 80 MiB。该候选目前没有已知 retaining path。

`clientFetch.ts` 对 json/text/blob/arrayBuffer/formData 消费的 finally 清除 30 秒计时器，也移除 caller abort listener。响应消费完整时，不能直接把这层包装认定为 30 秒泄漏。若测试只收响应头、不消费正文，则未消费 response 可能一直等计时器结束；需用真实快照区分应用与诊断代码。

## 最小诊断建议（由前端 Agent 执行）

- 新浏览器 context 中只做真实侧栏点击；不装性能观察器、不保存网络 Response/JSHandle/DOM 对象；不启不需要的 CDP Network 域。只保留数值基线。
- 同一短会话、同一菜单关闭状态，比较 0/10/20/50 次 GC 后结果，最后额外静置 35 秒再 GC。
- 保存起止 heap snapshot，以 dominator/retaining path 判定增长对象。优先查上述模型响应、EventSource、Markdown processor，以及框架路由树；不要只按 constructor 数量下结论。
- 如果复跑不增长，先追原探针和 CDP 对象保留；如果继续增长且对象归属明确，再设计只替换一个来源的隔离验证。全部不调用真实模型，不写用户数据。

本报告仅记录静态源码证据与可证伪候选。最终结论必须结合无探针复跑和堆快照，不能用此表代替动态证据。

## 后续对照结果

2026-11-14 16:56，原生 Chromium＋Node WebSocket CDP 的无 Playwright、无 Network 域、无页面探针对照也复现：50 次切换后 11.338→79.632 MiB，额外静置 90 秒双 GC 后 79.644 MiB，attached DOM 恒定。见 `frontend-memory-native.md`。这排除了“仅由原探针/Playwright 造成”和“只等 30 秒请求超时就会释放”的解释；尚不能从数字直接选择上表某个源码候选，仍需要堆快照 retaining path。
