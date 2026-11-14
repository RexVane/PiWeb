# 旧截图回收清单

状态：用户已批准，17 张旧截图全部移入 Windows 回收站，逐项恢复记录已追加 `backups/INDEX.md`；[执行结果](cleanup-assets-recycled.json) 记录文件、Git 对象与时间。合计 1,523,159 字节（约 1.45 MiB），这些历史功能图片已被 `readme-*` 截图替代。当前代码和 Markdown 文档没有有效引用；历史 README（`7d6d8f3`）能确认原用途，旧打包 JSON 清单继续保留历史记录。

回收前逐文件核对以下内容与 HEAD `1d4efba9054909cd9c8b2788028ce704c99b03ea` 中的 Git 对象完全一致、无暂存或工作区修改；未提交其他工作区内容。它们不属于现行界面运行资源；当前 12 张 README 图片、全部文件/提供方图标及 LICENSE 保留。未知外部网站的旧图片直链不在本仓库核对范围内。

| 文件（相对项目根目录） | 原用途 |
| --- | --- |
| `assets/archive.jpg` | 旧归档截图 |
| `assets/growth-1.jpg` | 旧生长树截图 |
| `assets/growth-2.jpg` | 旧生长树截图 |
| `assets/import.jpg` | 旧导入截图 |
| `assets/main.jpg` | 旧主界面截图 |
| `assets/outline.jpg` | 旧对话大纲截图 |
| `assets/prompts-1.jpg` | 旧提示词截图 |
| `assets/prompts-2.jpg` | 旧提示词截图 |
| `assets/providers-1.jpg` | 旧提供方截图 |
| `assets/providers-2.jpg` | 旧提供方截图 |
| `assets/providers-3.jpg` | 旧提供方截图 |
| `assets/trace-1.jpg` | 旧工具轨迹与 diff 截图 |
| `assets/trace-2.png` | 旧轨迹入口截图 |
| `assets/trace-3.png` | 旧轨迹入口细节 |
| `assets/trace-4.png` | 旧轨迹入口细节 |
| `assets/viewer-1.jpg` | 旧文件查看器截图 |
| `assets/viewer-2.jpg` | 旧文件查看器截图 |

恢复时仅在原文件不存在时，使用上述 HEAD 从 Git 恢复指定文件，或从 Windows 回收站恢复。不要用批量 `restore .` 覆盖当前未提交改动。
