# 测试与审查记录

当前使用方式见 [文档导航](../README.md)，当前进度见 [progress.md](../state/progress.md)。下列报告保留当时的失败、修复和验证边界，不把旧结果改写成新代码的通过证明。

## 2026-11-14 工作区记录

- [审查修复与最终验收](../../.audit-2026-11-14/verified-summary.md)：清理前冻结源码的 2211 项通过、2 项有说明的跳过；实际构建、干净安装、公网与浏览器证据均有各自记录。
- [文档和死代码清理](../../.audit-2026-11-14/cleanup-summary.md)：本次清理范围及清理后验证，独立于上面的修复验收。
- [回收清单](../../.audit-2026-11-14/cleanup-plan.md)：旧构建与缓存的具体目标；实际结果以清理总结为准。

这些 `.audit-*` 链接指向本工作区保留的记录，只有包含该目录的检出副本可以打开；它们不随 npm 包发布。原始报告 [SUMMARY.md](../../.audit-2026-11-14/SUMMARY.md) 保持原文，是否成立和如何处理以修复汇总为准。

## 历史记录

| 日期 | 入口与内容 |
| --- | --- |
| 2026-11-13 | [0.3.30 本地发布与代理验收](2026-11-13/release-0.3.30/summary.md) |
| 2026-11-12 | [交接验证](2026-11-12/handoff/README.md)、[专项验证](2026-11-12/handoff/validation-20261112-142631/summary.md)、[锁文件验证](2026-11-12/handoff/lock-validation/summary.md) |
| 2026-10-28 | [综合报告](2026-10-28/comprehensive-report.md)、[自动化发现](2026-10-28/automated-findings.md)、[交互发现](2026-10-28/interaction-findings.md)、[测试数据说明](2026-10-28/fixture-notes.md)、[当时的架构审查提示词](2026-10-28/architecture-prompt.md)、[修复记录](2026-10-28/fixes/report.md) |
| 2026-10-28，0.3.29 | [发布记录](2026-10-28/release-0.3.29/README.md)、[PR 48 审查](2026-10-28/release-0.3.29/pr48-review.md)、[CI 镜像审查](2026-10-28/release-0.3.29/ci-image-review.md)、[PR 48 前快照](2026-10-28/release-0.3.29/before-pr48/README.md) |

旧构建可以在确认不再被发布指针或进程使用后回收；原始日志、截图和 JSON 证据不是编译缓存。不要整目录删除混合存放这些内容的 `.next-releases/` 或 `.audit-*/`。移除和备份遵循项目使用者的 `AGENTS.md`，`backups/INDEX.md` 只追加。
