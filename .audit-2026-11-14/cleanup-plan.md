# 2026-11-14 文档与死代码清理：已回收清单

状态：用户已批准全部回收，13 个目标均已移入 Windows 回收站。机器清单见 [cleanup-plan.json](cleanup-plan.json)，执行结果见 [cleanup-recycled.json](cleanup-recycled.json)。发布指针与进程、文件数量和字节数在执行前重新核对，`backups/INDEX.md` 已逐目标追加记录。

以下 13 个目标均为可重新生成的旧构建或缓存，共 3,238,462,795 字节（约 3.02 GiB）。本次仅移入 Windows 回收站，不清空回收站；因此不会立即释放相同数量的磁盘空间。执行时会再次核对发布指针、进程和路径，追加 `backups/INDEX.md`；可再生产物按用户规则不另备份。

| 目录或文件（相对项目根目录） | 原因 |
| --- | --- |
| `.next-releases/menu-drawer-20261112-235700/` | 旧菜单预览构建 |
| `.next-releases/mvbx09xv-8a50bcae-3208-4069-9763-80681dc673f3/` | 旧版本构建 |
| `.next-releases/mwc51mx1-a059cc29-ee12-4320-9bc3-bb465878b2ab/` | 旧版本构建 |
| `.next-releases/mwdtqifv-a1a78057-23c2-4123-9fb5-e93a3132aed3/` | 已被后续发布替代的构建 |
| `.next-releases/mwerj2pm-1f2e3b01-38ab-46f9-853b-2b3a691d2d09/` | 空构建目录 |
| `.next-releases/preview-20261112-234300/` | 旧预览构建 |
| `.next-releases/proxy-compact-20261113-010500/` | 旧代理面板预览构建 |
| `.next-releases/proxy-diagnostics-20261113-004800/` | 旧代理诊断预览构建 |
| `.next-releases/proxy-settings-20261113-002700/` | 旧代理设置预览构建 |
| `.next-releases/ui-cleanup-20261112-213600/` | 旧界面预览构建 |
| `.next-releases/ui-compaction-20261112-204500/` | 旧界面预览构建 |
| `.next-dev-webpack/` | 已停止使用的开发构建缓存；以后启动开发服务会重建 |
| `node_modules/.cache/tsconfig.tsbuildinfo` | 旧 TypeScript 增量编译缓存 |

盘点时未发现 PiWeb 服务或构建进程。`active.json` 指向 `.next-releases/mweslqtb-0ad8d701-78c0-483d-a970-3bcbdb792000/`，该构建及 `.next/` 保留；`last-ready.json` 当时不存在，若执行前出现则也保护其引用。保留所有发布 JSON/日志、审查报告及证据、用户工具配置、依赖、图片和 `backups/`。`node_modules/.cache/piweb-metrics` 混有审查数据，不能当普通编译缓存整目录移除。

整个源码文件目前没有确认可以删除的候选；只编辑已证实无用的局部代码，不因缺少静态 import 删除 Next 约定入口、动态加载模块、扩展入口、图标或翻译。
