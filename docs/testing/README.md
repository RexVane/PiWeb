# 测试与审查记录

当前使用方式见 [文档导航](../README.md)，当前进度见 [progress.md](../state/progress.md)。下列报告保留当时的失败、修复和验证边界，不把旧结果改写成新代码的通过证明。

## 2026-11-14 工作区记录

2026-11-14 的原始工作区记录（`.audit-2026-11-14/`）已随 2026-11-15 收尾清理移出工作区；保留的结论见 [2026-11-15 审计归档](../audit/2026-11-15/README.md)。历史报告不随 npm 包发布，也不作为当前代码的通过证明。

## 历史记录

| 日期 | 入口与内容 |
| --- | --- |
| 2026-11-13 | [0.3.30 本地发布与代理验收](2026-11-13/release-0.3.30/summary.md) |
| 2026-11-12 | [交接验证](2026-11-12/handoff/README.md)、[专项验证](2026-11-12/handoff/validation-20261112-142631/summary.md)、[锁文件验证](2026-11-12/handoff/lock-validation/summary.md) |
| 2026-10-28 | [综合报告](2026-10-28/comprehensive-report.md)、[自动化发现](2026-10-28/automated-findings.md)、[交互发现](2026-10-28/interaction-findings.md)、[测试数据说明](2026-10-28/fixture-notes.md)、[当时的架构审查提示词](2026-10-28/architecture-prompt.md)、[修复记录](2026-10-28/fixes/report.md) |
| 2026-10-28，0.3.29 | [发布记录](2026-10-28/release-0.3.29/README.md)、[PR 48 审查](2026-10-28/release-0.3.29/pr48-review.md)、[CI 镜像审查](2026-10-28/release-0.3.29/ci-image-review.md)、[PR 48 前快照](2026-10-28/release-0.3.29/before-pr48/README.md) |

旧构建可以在确认不再被发布指针或进程使用后回收；原始日志、截图和 JSON 证据不是编译缓存。不要整目录删除混合存放这些内容的 `.next-releases/` 或 `.audit-*/`。移除和备份遵循项目使用者的 `AGENTS.md`，`backups/INDEX.md` 只追加。
