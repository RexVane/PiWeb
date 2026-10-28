# PR #48 整合审查

2026-10-28。原 PR：`x2410516039:piweb-x2410516039`，原提交 `b7e1a6a1643d2a3f57d3705117468049a139f030`，基于 `26a4d9f`。原 PR 的 Ubuntu / Windows × Node 22.19.0 / 24 四组 GitHub 检查均通过。本地将其整合到 0.3.29 的既有修复，保留原作者提交；唯一合并冲突为 `agent-manager` 的 import，双方导入均保留。

原 PR 增加无须启动 agent 的冷工具目录，并在独立 `web-tool-preferences.json` 中按会话保存 preset / 逐项工具选择，使用设置写入锁和原子替换，不改写 Pi JSONL。

审查与回归补充了以下修复：

| 问题 | 修改与实际验证 |
| --- | --- |
| 冷目录漏掉 PiWeb 注入的 `ask_user_question`，冷态保存白名单可能意外关闭它 | 冷热路径共用自定义工具定义，按 SDK 的覆盖顺序注册；真实 SDK 三档冷目录都包含该工具，冷态选择后热启动仍保留 |
| 冷目录未遵循 SDK 显式 `defaultTools`，例如 opt-in 的 `codemode` | 冷态读取同一份工作区合并设置中的显式工具，仍受 preset、逐项白名单与 hidden 限制；真实 `.pi/settings.json` 的冷热 active 一致，custom 白名单继续优先 |
| 显式旧 `standard` 与服务端相同就不保存，换浏览器后仍可能被旧档位覆盖 | 新协议 `toolPreferenceSaved: false` 时也完成一次迁移；服务端已保存的 preset 和 custom 白名单优先；真实 hook 回归覆盖跨会话、跨浏览器值变化和运行中延迟迁移 |
| 缺失/无效 localStorage 被当作用户选定的 `standard` 迁移 | 有效旧存储与 UI 默认 fallback 分开；缺失/坏值不会写入服务端，保留旧服务端协议兼容 |
| 无会话时虚假显示正在发现工具，实际没有发现请求 | 恢复中英文“打开会话后查看工具”提示；有冷会话目录时直接显示工具，无须 prepare |

后端真实 SDK 红测为 4 失败、21 通过、1 既有平台跳过；最终聚焦 3 文件、44 通过、1 既有平台跳过。前端真实 hook 红测为 4 失败、6 通过；最终聚焦 3 文件、23 通过，独立 typecheck 通过。

- [后端原始失败](pr48-tools-before.log)、[后端最终通过](pr48-tools-after.log)
- [前端原始失败](pr48-frontend-red.log)、[前端最终通过](pr48-frontend-green.log)、[独立类型检查](pr48-frontend-typecheck.log)

后端中间一次失败另保留在 [pr48-tools-intermediate.log](pr48-tools-intermediate.log)：测试用 `applyOverrides` 写内存设置，SDK loader 的 reload 从磁盘重新加载后覆盖该值。最终测试使用实际隔离工作区的 `.pi/settings.json` 验证，没有为迎合测试改写热会话策略。

完整整合验证和产物记录见 [版本构建记录](README.md)。本地 SDK 测试禁用网络，浏览器工具偏好验收不向模型发送请求；它们不冒充实际模型推理测试。实际模型停止、继续与选择题证据保留在 [前次修复报告](../fixes/report.md)。
