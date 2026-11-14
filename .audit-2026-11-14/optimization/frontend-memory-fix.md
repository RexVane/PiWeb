# 前端内存保留修复

状态：源码、定向测试、最终成品原生 Chromium 100 次切换及 90 秒静置复测均完成。本轮有实际堆曲线和修复前后强引用路径证据。

## 已定位的强引用链

使用上一轮脱敏 `performance/frontend-desktop-memory-minimal.heapsnapshot`，构建一份紧凑 typed-array 反向强引用索引；排除 weak edges 及 DevTools console/InjectedScript 锚点，再寻找三个历史正文样本到 GC root 的路径。结果见 `heap-root-paths.json` 与 `heap-root-paths.log`，没有输出正文或凭据。

三条路径分别长 410、464、248 条边，包含 43、49、25 个旧 AbortController，均从实际页面 Window/Document 经按钮的 React props 到达。核心重复链为：

```text
Window → Document → 实际侧栏按钮 React props
  → AppShell/useGrowth 的 recordNow 闭包
  → lazyState.scope → requestScope.refresh
  → AbortController → AbortSignal.reason
  → DOMException → ErrorStackData → 上一代 effect cleanup 闭包
  → 上一代 lazyState.scope → 上一代 refresh controller → …
  → 旧 AppShell state.snapshot.trajectory → detail 正文
```

堆位置还映射到测量成品 `page-dd8af9a9858aaf29.js` 第 4 行第 109858 列：`useEffect(...,()=>u.refresh?.abort())`，对应 `useGrowth` 的刷新 effect 清理；第 107586 列对应 scope 清理中遍历 controller 并 abort。`recordNow` 的位置为同文件第 114425 列。不是仅根据闭包形状猜测：源码、编译代码位置、错误堆栈和重复 controller 链相互对应。

请求成功或失败结束时，旧实现只从 `controllers` 删除，却仍通过 `refresh` 保存 controller；后续切换的 effect cleanup 对已结束请求调用无 reason 的 `abort()`，Chromium 的默认 AbortError 保存创建时的调用栈。目录 UI 状态又直接保存整个 requestScope，使取消错误能够将多代渲染和旧正文连续串起来。前轮原生 CDP 已证明增长不依赖 Playwright/Network 域，最终修复仍需新成品因果对照。

## 修改

- `src/hooks/useGrowth.ts`：成功/失败结束以及空 cwd 分支均释放 `refresh`，仅在它仍属于该请求时清空；被取代请求先移除旧引用再取消。scope 结束时先清空 controller/refresh/目录请求容器，再取消仍进行中的请求。
- 目录 UI 状态仅保存 scope 的独立 Symbol 身份，不再保存含网络 controller 的 scope 对象；保留 A→B→A 的代次隔离。没有限制、删减会话正文和草稿。
- 保留默认 AbortError 合同；没有用字符串 reason 改变既有错误类型。关键在于停止保存已完成 controller、切断 UI 状态到旧 transport 的引用。
- `src/hooks/usePiWeb.ts`：初选与同作用域 SSE snapshot 合并尚未完成的模型目录请求；换会话/cwd 时取消旧请求。用户显式刷新、保存后的刷新以及 resources/model 事件会取代旧请求，防止把修改前的结果复用为保存后的目录。request 代次、当前会话检查与 finally 身份检查保留，取消不向新会话报错；完成后清空 pending 引用。
- `event-stream.ts` 与事件批量器无需改动，本次定位未把它们认定为持续保留根。

## 定向验证

`growth-focused-v2.log`：3 文件、33/33 通过。新增覆盖完成成功/失败请求后不再调用 abort；旧请求晚结束不能释放新的请求；时间轴先完成、目录仍进行时依然能够取消；A→B→A 后旧目录结果不能落地。原有工作区/会话切换、分页取消、旧结果不污染缓存和用户选中旧轮次保持等回归继续通过。

`model-stream-focused.log`：5 文件、47/47 通过。新增覆盖初选与快照共享在途请求、资源变更替换、显式刷新不共享旧请求、不同会话/cwd 与卸载取消、迟到成功/失败不覆盖当前目录。事件折叠、批量顺序、长轮询及会话工具偏好回归通过。

`frontend-typecheck.log`：`npm run typecheck` 通过。上述专项与后续整仓回归可能重叠，不相加为整仓测试总数。

## 最终成品验收

成品：`D:\AIApp\.piweb-optimization-20261114-F3JhDO`，BUILD_ID `T9X3r3wKuuYbNUYmPTqye`，sourceHash `41a70da175d1e7c92ff478fb834b001af204c79a7d713fe53572521285a81046`。记录见 `frontend-memory-optimized-100.json` / `.log`，执行时间为 2026-11-14 19:47:58–19:50:03（UTC+8），exit 0。

使用同一 Chromium 156.0.8078.4、同规模 300 条会话与 10,000 消息长会话（长会话文件 21,599,196 字节）。原生 CDP 不加载 Playwright，不开启 Network，不安装页面探针；长→短预热后，每 10 次交替切换回到同一短会话并双 GC，100 次后再空闲 90 秒双 GC。点击真实侧栏 DOM 按钮并核对会话 URL 和唯一末条正文，模拟点击只用于内存验证，不作为交互延迟样本。此时服务器已完成首个业务导航，sample 0 不是冷启动计时。

| 测量点 | 修复前原生对照（50 次） | 修复后原生复测（100 次） |
| --- | ---: | ---: |
| 预热后起点 | 11.338 MiB | 11.836 MiB |
| 50 次切换后 | 79.632 MiB | 14.461 MiB |
| 100 次切换后 | 未测 | 14.595 MiB |
| 最后再静置 90 秒 | 79.644 MiB（50 次后） | 14.606 MiB（100 次后） |

修复前 50 次后仍增加约 68.305 MiB；修复后 100 次并静置仅增加 2.770 MiB，30–100 次维持约 14.3–14.9 MiB，没有复现原有线性增长。附着元素 4,061、节点 4,531、文档 1 在所有新样本保持一致。这里测量的是页面 JS heap，不等于整个浏览器进程内存；修复前后各一次原生运行，不能据此声称任意规模、任意浏览器都不会增长。

## 修复后的引用路径

末次快照 `frontend-memory-optimized-100.heapsnapshot` 为 34,426,396 字节，临时测试 cookie 扫描替换命中 0 次。用同一有界反向强引用算法分析，结果见 `heap-after-100.json` / `.log`：355,915 nodes、1,740,513 edges，合成历史正文字符串 1,600 个 / 2,514,712 字节。

从这些正文中抽取首/中/末三个大字符串，至 GC root 的最短强引用路径分别仅 16/15/16 条边，三条路径均无 AbortController；剩余路径通过真实按钮 React props 到当前持有的消息/快照状态，不再出现前轮 43/49/25 个 controller 与 AbortError 堆栈串起多代 scope 的链。样本路径与稳定的 100 次堆曲线共同支持已切断本次定位的保留原因；没有靠删正文、清草稿或缩小显示窗口降低占用，也不声称堆中应当完全没有先前消息对象。

浏览器 PID 35448 已正常退出，自建 profile 已回收，2074 测试服务留给后续独占 UI 验收，live 30141 未动。模型刷新专项和事件测试保留了迟到响应、切换中的请求取消与状态隔离边界；后台生成不中断及真实流式输入/滚动由同成品的单独流式验收记录，不能将本次静态会话切换测试替代该项。
