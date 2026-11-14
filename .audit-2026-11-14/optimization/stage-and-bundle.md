# 优化版本独立成品

日期：2026-11-14。最终生产输入已冻结并构建；本文件中的构建耗时不是启动耗时。原项目 .next、发布指针和用户配置未修改，未安装依赖。

| 项目 | 本轮成品 |
| --- | --- |
| 独立目录 | D:\AIApp\.piweb-optimization-20261114-F3JhDO |
| BUILD_ID | T9X3r3wKuuYbNUYmPTqye |
| 源码 SHA256 | 41a70da175d1e7c92ff478fb834b001af204c79a7d713fe53572521285a81046 |
| 生产输入 | 731 个；源码与复制文件均匹配快照 |
| 封存运行文件 | 335 个；完整验证通过 |
| 构建耗时 | 170.980 秒；同期有整仓回归运行，不作优化前后性能归因 |
| 依赖 | 仅连接当前仓库已有 node_modules，未执行安装 |

证据：[最终源码快照](source-snapshot-verified.json)、[构建结果](build-result-verified.json)、[成品完整性](stage-validation-verified.json)、[构建日志](build-verified.log)。前两次构建分别早于显式保存刷新和三等待者交接的最终补丁，均已回收其自建 .next，保留[第一次中间记录](intermediate-build-recycled.json)和[第二次替换记录](superseded-build-recycled.json)，不参与最终性能结论。最后一次只复制了内容有差异的 src/lib/pi.ts，但对全部生产输入和新生成的运行产物重新校验。

## 客户端体积

与[原基线](../performance/bundle-stats.json)使用相同口径：每个物理文件以 gzip level 6 压缩后求和。首页清单取 rootMainFiles、首页 AppShell / layout I18n 客户端边界与该页面 CSS，包含 layout 入口；已与真实认证 HTML 的 7 个 JS、2 个 CSS 逐一吻合。这里仍是文件理论 gzip 大小，实际浏览器传输另行测量。条件 polyfill 不计入现代浏览器首页。

| gzip 字节 | 基线 | 优化后 | 变化 |
| --- | ---: | ---: | ---: |
| 首页 JS | 278,493 | 257,946 | -20,547（-7.38%） |
| 首页 CSS | 24,383 | 24,743 | +360 |
| 首页合计 | 302,876 | 282,689 | -20,187（-6.665%） |
| 全部物理 JS + CSS | 722,693 | 729,142 | +6,449 |

首页体积减少与视图按需载入一致；全部分块的总体积并未减少。懒加载边界之间有共享块，不能把各行相加。逐文件字节数、压缩数、条件文件与按需边界见 [bundle-stats-verified.json](bundle-stats-verified.json)。此前临时统计漏了 layout 入口的 184 字节 gzip；不完整记录保留为 [bundle-stats-verified-incomplete.json](bundle-stats-verified-incomplete.json)，不使用其中的 6.73% 结论。原基线本来包含此入口，无同类遗漏。五轮与 A/B 的实际 HTML 资源核对见 [bundle-html-verification.json](bundle-html-verification.json)。

## 顺序测量方法

统一使用新生成的虚构数据：300 个会话、299 个短会话各 20 条消息、一个 10,000 条消息的长会话；会话文件总计 25,267,221 字节，与基线一致。工作区还有 10,000 个普通文件、100 个技能及 40 个资源工作区。没有个人模型凭据，没有真实模型调用。

启动使用此目录中的 node bin/piweb.js -p <本轮空闲回环端口> -H 127.0.0.1 --no-open，仅继承白名单环境，agent/home/配置均在本轮夹具中。认证使用私有 IPC 的 readCurrentLaunchToken 并在内存交换 cookie，不把凭据写入证据或对话。各轮 agent 数据在计时前独立复制，保留默认 sessions 优先预热。

正式启动测量与其他测试、浏览器负载串行。记录 HTTP health 首次完整响应、认证 health、完整 sessions、首页 HTML、启动器就绪日志和进程资源；不将 HTTP 可响应混称为 TCP 开始监听，不将 sessions 后的页面请求混称为独立冷首屏。OS 文件缓存不清空。已完成五轮、父阶段受控对照及旧新交错各两轮，完整结果与慢样本见 [startup-comparison.md](startup-comparison.md)。启动测量窗口已交还，服务端与浏览器继续复测。
