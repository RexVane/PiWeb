# 启动父阶段受控对照

日期：2026-11-14。使用同一个最终封存成品，各轮为新 Node 进程。顺序为旧／新、新／旧、旧／新；旧路径执行 ensureInstallBuild 后再 createLaunchPlan，新路径只执行 createLaunchPlan。模块导入单列，不计入表内。没有启动 HTTP 服务、预热、安装或构建。

| 组 | 旧双校验（s） | 新单校验（s） |
| --- | ---: | ---: |
| 1 | 4.795 | 2.382 |
| 2 | 5.198 | 2.398 |
| 3 | 5.054 | 2.411 |

中位数 5.054 → 2.398 秒，减少 2.656 秒（52.55%）。每次仍执行完整成品校验，无长期缓存。此结果只归因父阶段重复调用，不能当作全部启动耗时。OS 文件缓存未清空。

证据：[六次原始测量](startup-parent-controlled.json)、[运行日志](startup-parent-controlled.log)、[完整成品 A/B 与慢样本](startup-comparison.md)。
