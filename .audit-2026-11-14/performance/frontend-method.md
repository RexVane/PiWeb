# 前端性能测量方法

状态：已完成真实 Chromium 桌面与普通移动基准、弱环境部分导航、CLS 归因、精确会话就绪补测，以及无页面探针/原生 CDP 内存对照。结果见 `frontend-results.md` 和 `frontend-metrics.json`。弱环境主流程主动中止，保留 5 次冷/2 次热有效导航；3 次合成流式探针均未形成有效负载验收，不报告流式通过。执行窗口由主 Agent 统一安排；从未访问现有 30141 实例。

成品：`D:\AIApp\.piweb-performance-20261114-XavtFX`；BUILD_ID `qs_AuODvEiFduBinEf95d`；sourceHash `0a8188e986da0c45600a2153ae2d4d5da4b185e18f7f23b60feb75eb83337961`。

## 场景与口径

- Chromium 真实浏览器，桌面 1280×800、移动模拟 390×844。移动模拟不等于真手机。
- 每种配置冷缓存导航 5 次、热缓存导航 5 次。桌面第一回单独标注新进程首次业务导航；其余冷缓存指新浏览器 context 的空 HTTP 缓存、服务器已热。操作系统页缓存不重启。身份凭据只在内存，不计入导航耗时。
- 收集导航 TTFB、FCP、LCP、无近期用户输入的 CLS 会话窗口最大值。分别记录 shell/输入框出现的 shellReadyMs、首轮 sessions/models 响应结束且工作区已渲染后的 businessReadyMs；LCP 至少持续观察到 businessReady 后 1.5 秒，并记录采样截止。记录 shell 就绪与采样截止的资源集合，区分首屏资源与空闲预取。SSE 和定时轮询存在，因此不用 networkidle 定义就绪。
- 设置、模型、技能、扩展面板各操作至少 20 次，记录真实鼠标/键盘事件到后续帧，以及目标内容可见的上界。输入使用真实键盘事件；不发送消息。
- 真实短会话、长会话切换，记录点击到目标末尾消息显示的时间；原生 SSE 负责传输。长会话在前端存在 300 条消息上限，报告原文件消息数及实际回合/DOM 数。
- 滚动使用真实 wheel 事件，采样 rAF 间隔与超过 50 ms 的长帧比例、LongTasks。性能采样本身有开销，保留原始序列。
- 单列生成中场景：每 25 ms 投递合成 delta（目标 40 events/s，约 20 秒），期间真实键盘输入与 wheel 滚动。通过原生 EventSource 的消息处理路径投递合成事件；传输/模型生成并非真实 SSE 后端负载。记录实际事件数/运行时长，避免把计时器目标速率当作真实到达速率。
- 独立内存阶段：先预热会话，强制 GC 后取基线，切换 50 次，每 10 次在同一会话状态 GC 后采样 JS heap、DOM、文档与事件监听器。不能以单个堆差值断言泄漏。浏览器 JS heap 与服务端进程 RSS 分开；不把 JS heap 冒充整个浏览器内存。
- 可单列 4× CPU + 100 ms RTT、1.6 Mbps 下行/750 Kbps 上行的模拟条件；其结果不混入本地正常配置。
- 大资源目录若使用网络拦截的合成模型/插件响应，单独标注为前端渲染场景，不能用于推断服务端资源发现性能；导航基准不启用 Playwright 路由，避免其关闭 HTTP 缓存。

## 本轮预算

主 Agent 设定：正常桌面本地 LCP ≤2.5 s、CLS ≤0.1；面板/输入交互 p95 ≤200 ms；滚动 rAF p95 ≤33.3 ms 且超过 50 ms 的长帧占比 ≤5%。前两项参考 Web Vitals 指标定义，其余为本次实验室预算。实验室点击/键盘计时及少量 EventTiming 样本不能等同真实用户 INP。

## 安全与复现

- 执行需显式 `PIWEB_PERF_ALLOW_RUN=1`，并传独立端口、fixture 清单。脚本不启动服务，不接受 30141。
- 仅使用临时 agentDir，模型凭据为空。通过私有 IPC 换取登录 cookie，不写凭据到报告。
- 页面内拒绝所有业务非 GET/HEAD fetch；原生 SSE、静态资源与 HTTP 缓存保留。记录任何被阻止的操作，不存请求正文。
- 只保存非敏感指标、fixture 标签与截图。脚本最终移入回收站，证据保留。
- 逐样本失败会保留错误和进度；不能把未完成场景计入通过率。

## 只读热点候选

以下是需要测量验证的候选，尚不是性能故障结论：

| 位置 | 现有行为 | 测量重点 |
| --- | --- | --- |
| `src/components/ChatWindow.tsx`，`buildTurns`、`nearTurns` | 消息数组变动重建回合；延迟渲染历史回合，已升级的历史不降级 | 长会话首开与滚过全文后的 DOM/heap，区分预期保留与持续增长 |
| `src/components/SessionSidebar.tsx`，`flatSessions` | 排序比较里调用 `pinnedPaths.some()`；可见列表逐项渲染 | 300 会话列表的 DOM、切换与输入干扰 |
| `src/components/settings/{SkillsSection,PluginsSection,ModelsSection}.tsx` | 筛选后对结果直接 map 渲染 | 实际资源数与大合成目录下的面板就绪、输入筛选、DOM |
| `src/components/AppShell.tsx`，草稿持久化 | 输入后 300 ms debounce，对非空草稿 JSON 序列化并写 localStorage；总预算 10M 字符 | 普通输入与大草稿场景分开采样 LongTasks |
| `src/hooks/usePiWeb.ts`，snapshot 处理 | 快照解析与预览/工具对象投影；消息/工具/轨迹有前端上限 | 原生 SSE 到页面显示、切换回收情况 |
| `src/components/AppShell.tsx`，按需加载 | 设置、聊天、文件/轨迹有动态 import；技能/插件视图静态引入 | 实际首屏下载与空闲预取，不能把所有 75 个 JS 文件总量等同首屏 |

