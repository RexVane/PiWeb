# 浏览器性能与交互验收 — 2026-11-14

状态：最终成品验收完成。手机布局跳动与本轮交互预算通过；弱网冷加载仍约5.5秒，未取得显著提速，不能概括为全部体验达标。

BUILD_ID：`T9X3r3wKuuYbNUYmPTqye`；sourceHash：`41a70da175d1e7c92ff478fb834b001af204c79a7d713fe53572521285a81046`。Chromium 156.0.8078.4，仅使用独立生产副本、合成会话与假凭据。原运行实例与原 .next 没有切换。

## 加载

全新服务实例只经历健康检查、私密登录和30秒空闲后，首次桌面浏览器导航：外壳 209.0 ms，首批业务数据就绪 1348.1 ms，CLS 0。只有一个样本，不能称为分位数。业务就绪要求会话与模型接口的响应体完成，并且会话工作区已显示。

以下每组5次。cold指新的浏览器HTTP缓存，服务器已经预热；warm指同一context中的第二次导航。mobile-slow为390×844、4倍CPU降速、100ms延迟、1.6Mbps下行/750Kbps上行。

| 场景 | 次数 | 业务就绪范围 | p50 / p95 | 最大CLS | 首批JS/CSS实际传输 |
| --- | --- | --- | --- | --- | --- |
| desktop / cold | 5 | 227.2～245.7 ms | 234.2 / 245.7 ms | 0 | 279.0～279.0 KiB |
| desktop / warm | 5 | 111.9～133.5 ms | 118.1 / 133.5 ms | 0 | 0.0～0.0 KiB |
| mobile-slow / cold | 5 | 5440.8～5518.3 ms | 5454.9 / 5518.3 ms | 0 | 441.6～441.6 KiB |
| mobile-slow / warm | 5 | 2157.1～2294.4 ms | 2205.2 / 2294.4 ms | 0 | 0.0～0.0 KiB |

原弱网冷导航为5.44～5.58秒、CLS约0.332；本轮耗时基本持平，但布局偏移消失。静态资源只统计业务就绪时已完成的JS/CSS，不包含HTML、接口或全部后续请求；理论gzip和实际传输量不可混用。未在本轮追加LCP观测，不以业务就绪冒充LCP。

禁用页面JavaScript后，390/840/841/1280四种宽度的首帧CSS布局全部通过；20次常规/限速导航均无横向溢出、无页面运行时或HTTP错误。已人工查看首个桌面与手机冷加载截图。

## 操作

桌面/手机模拟各20次真实键盘输入，p95分别 7.5 / 8.7 ms。两种长会话实际wheel滚动均发生可见位移，帧间隔p95约5.8ms，超过50ms的长帧比例0。跨840px断点时，仍为同一个输入框节点，草稿保留。

本轮帧节奏与早先约16.7ms不同，因此只用这些数据判断当前场景通过响应/长帧预算，不将33ms到个位毫秒的差值全部算作代码收益，也不当作现场INP。

## 真实后端的本地模拟流

有效结果是 [stream-real-pipeline-v4.json](stream-real-pipeline-v4.json)：本地假provider → 真实SDK → agent命令 → 服务端SSE → 浏览器。没有向页面注入假消息，也没有调用真实模型。

- 800个分段完整显示；真实输入p95 10.5ms，实际滚动帧间隔p95 6ms，长帧比例0。
- 浏览器断网1.2秒后建立新的SSE请求，在完成前恢复部分正文，最终完整显示结束标记；provider只发起1次请求。
- 第二轮通过真实侧栏切到短会话再返回，后台仍继续生成，部分正文恢复。停止时provider连接关闭于约11ms，发送停在98段，后续计数保持不变。
- 浏览器零运行时错误；临时models.json原始字节已恢复。

首轮及v2被正常的生长记录选择框挡住；v3完整输出/重连通过，但脚本将重命名参数错写为name，导致返回时找不到预期名称。修正为接口实际的text后v4两项全过。所有失败JSON/log保留，不计作通过样本。更早ui-first-business.log是浏览器启动前的Windows ESM导入路径错误；修正file URL后的首次导航才是有效样本。

## 范围

本轮是Windows/Chromium实验室结果，没有真实手机、iOS/WebKit、真实模型网络或公网隧道延迟；没有长时间运行浸泡。浏览器JS堆与整个浏览器进程占用是不同指标，内存结果另见 [frontend-memory-fix.md](frontend-memory-fix.md)。

原始证据：[ui-first-business.json](ui-first-business.json)、[ui-layout.json](ui-layout.json)、[ui-interaction.json](ui-interaction.json)、[ui-analysis.json](ui-analysis.json)。截图：[桌面](optimized-first-business.png)、[手机](optimized-mobile-slow-cold.png)。
