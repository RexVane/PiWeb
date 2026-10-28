# 自动化测试与安装包验证

- 日期：2026-10-28，Asia/Shanghai。
- 被测提交：`26a4d9f`；PiWeb `0.3.28`；Pi SDK `1.4.0`。
- 环境：macOS，Node `24.15.0`，npm `12.0.2`，Vitest `5.0.5`。
- 所有运行时检查使用本次独立临时 agent 目录；没有读取或改写用户真实 Pi 配置。未修改业务源码。

## 结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| SDK fd/rg 离线准备 | 通过 | `vitest-sdk-prepare.log` |
| 全量 `npm test` | 135 文件通过、2 文件跳过；1131 用例通过、4 用例跳过、0 失败；26.75 秒 | `vitest.log`、`vitest-results.json` |
| 补充真实 fd 的 @ 引用端到端对照 | **1 失败、4 通过；重复执行稳定复现** | `vitest-mention-parity.log`、`vitest-mention-parity-confirm.log` |
| 独立跑完 33 个 @ 查询对照 | 32 一致，`[slug]` 不一致 | `mention-parity-all-queries.json` |
| 工作区直接 `npm run verify:package` | 被发布检查拒绝：现有 `.next/cache/.previewinfo` 会进入 tarball | `verify-package.log` |
| 排除 cache 的独立 staging 发布包 + 空 global prefix 安装 | **通过**：Pi 1.4.0 依赖、真实生产启动、首页、首屏 6 个 API 全部成功 | `verify-package-isolated.log`、`verify-package-isolated-results.json` |
| 源码与发布包敏感文件检查 | 扫描 637 个源码/脚本/静态文件，常见私钥/token 格式 0 命中；tarball 中未发现 `.env`、auth/settings/models 配置、会话 `.jsonl`、私钥文件 | `package-source-safety.json` |

## 确认的问题：@ 文件查询与新版 Pi 终端不一致

严重度：P2。输入含正则特殊字符的文件/目录引用时，网页会出现终端没有的候选。

复现条件：真实 `fd` 可在 PATH 中执行；Pi SDK 1.4.0；测试夹具含 `src/app/[slug]/page.tsx`。

1. 运行 `tests/mention-parity.test.ts`（将 SDK 下载的 `bin/fd` 所在目录加到本次命令 PATH）。
2. 查询 `@[slug]`。
3. Pi 终端仅返回目录 `[slug]/`；网页额外返回该目录中的 `page.tsx`。
4. 断言失败位置：`tests/mention-parity.test.ts:153`。

原因：`src/lib/workspace-index.ts:75` 在查询不含 `/` 时直接返回原始文本，因此 `[slug]` 被当作正则字符集。当前 Pi 1.4.0 的 `@earendil-works/pi-tui/dist/autocomplete.js` 在同一分支使用 `escapeRegex(normalized)`，按字面过滤。网页过滤 `page.tsx` 时正则字符集能命中 `g`，后续路径评分又在父目录发现字面 `[slug]`，所以错误保留了文件候选。

全量测试中这项最初被跳过，因为准备脚本下载了 agent `bin/fd`，但该目录未在 PATH 中。故标准测试全绿不能覆盖该回归。补测未更改现有测试或源码。

## 打包验证的前置状态

工作区中 `.next/cache` 是现有构建缓存；本次没有删除或移动它。直接打包失败属于本地发布前置状态，**不能据此判定已发布包无法运行**。

`.github/workflows/publish.yml:56-62` 已明确在生产构建后清除 cache/diagnostics/trace，再运行 `verify:package`。本次在独立 staging 副本中排除 cache，保留原工作区后完成真实安装检查。产生的 tarball 为 `rexvane-piweb-0.3.28.tgz`，1404 文件、23,360,657 字节（约 22.3 MiB），构建 ID `NqepHhkS-RiO3ALEfYPC5`。

安装检查在全新临时 global prefix 中执行 `npm install --omit=dev --ignore-scripts`，随后真实载入 SDK，并仅监听 `127.0.0.1` 的随机端口。成功检查 `/`、`/api/health`、`/api/version`、`/api/models`、`/api/sessions`、`/api/workspaces`、`/api/pi-settings`。

## 尚未在本分项执行的用例

全量报告的 4 个跳过中，真实 fd 对照已通过补测实际执行并确认失败；其余 3 个为：

- Windows 项目信任路径大小写恢复测试：当前 macOS 不适用。
- Windows PowerShell UTF-8 输出测试：当前 macOS 不适用。
- 真实 cloudflared 公网隧道：默认关闭，需要明确启用 `PIWEB_TEST_TUNNEL=1`；本分项没有打开公网监听。

本报告只涵盖自动化和安装包分项；真实浏览器的显示、焦点、快捷键、移动端以及实际模型提供商联网行为需结合其他分项结果。源码/token 扫描是启发式检查，不构成完整安全审计。
