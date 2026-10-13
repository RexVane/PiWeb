# 测试排错与功能改进调研

2026-10-13，本轮重点检查用户从 npm 安装后的启动故障，并运行现有自动化测试及生产包验证。验证环境为 Windows、Node.js 24.12.0、npm 11.6.2。

## 已确认的启动故障

实际从 npm 官方仓库安装 @rexvane/piweb@0.3.22，成功复现：

- pi-coding-agent 和 pi-ai 为 1.1.0。
- pi-codemode、pi-agent-core、pi-mcp 被解析到 1.2.0。
- SDK 1.1.0 的 dist/extensions/codemode/tool.js 从 pi-codemode/declarations 导入 MCP_TYPESCRIPT_PREAMBLE；codemode 1.2.0 已移除此导出，SDK 加载失败，连带导致 Next.js instrumentation 启动失败。
- SDK 的间接依赖声明使用 ^1.1.0，允许安装 1.2.0。本仓库旧 package-lock.json 保存了 1.1.0，因此开发机测试能够通过；用户安装发布包时没有使用这份仓库锁文件。

修复关联既有记录 #037（升级 SDK）和 #057（单独更新 pi）。没有修改官方 SDK 源码。

## 本轮改动

- package.json 将配套 Pi 包作为精确版本的直接依赖；保持已验证的 1.1.0 配套版本，也固定 SDK 1.1.0 使用的 chord。package-lock.json 只同步根依赖声明，保留已有平台与可选依赖条目。
- scripts/runtime/pi-packages.mjs 统一版本约束与安装命令。“更新 pi”先查一次 SDK 发布版本，再将七个 Pi 运行时包安装为这个精确版本；注册表查询后再次检查会话是否空闲。
- scripts/verify-package.mjs 的命令行发布检查增加空全局前缀安装；scripts/runtime/check-installed.mjs 检查实际解析版本、真实 SDK 导入、生产启动、首页和六个首屏接口。安装及配置都使用临时目录，监听仅绑定 127.0.0.1，远程入口和更新检查关闭。
- next.config.ts 明确 outputFileTracingRoot 为当前安装目录。
- 补充 .gitignore 的 .next*/ 和 dist/ 排除规则。
- 新增运行时版本与更新回归测试，并增加发布包缺失版本约束的回归测试。

## 验证结果

- 类型检查通过；git diff --check 通过。
- 全量 Vitest：114 个文件通过、1 个文件跳过；954 个用例通过、2 个用例跳过。
- 更新、发布相关的五个测试文件共 72 个用例通过。发布检查最后改动后的两个相关文件共 26 个用例再次通过。
- Windows 与 Linux x64 的干净 npm ci --dry-run 均通过。Linux 为安装预检，本轮没有在 Linux 上运行服务。
- 独立副本的 Next.js 16.4.0 生产构建通过。
- 修复版真实 tarball：1372 个文件、21.2 MB，空全局前缀安装后，实际 Pi 版本统一为 1.1.0；生产启动、首页及 /api/health、/api/version、/api/models、/api/sessions、/api/workspaces、/api/pi-settings 全部通过。
- 原 npm 0.3.22 成品包应用下方临时恢复方案后，同样通过生产启动、首页和六个接口检查。

验证没有执行真实供应商的付费模型请求和 OAuth 登录。

## 对现有 0.3.22 安装的临时恢复

先停止正在运行的 PiWeb，再在 PowerShell 中执行：

~~~powershell
$piwebRoot = Join-Path (npm root -g) '@rexvane\piweb'
$names = 'pi-coding-agent', 'pi-ai', 'pi-agent-core', 'pi-codemode', 'pi-mcp', 'pi-telemetry', 'pi-tui'
$packages = $names | ForEach-Object { '@earendil-works/{0}@1.1.0' -f $_ }
npm install --prefix $piwebRoot --save-exact --omit=dev --ignore-scripts --no-audit --no-fund $packages
piweb
~~~

这条命令针对全局安装。复现与恢复均使用官方 0.3.22 预构建文件；测试工具只额外加入临时检查脚本。修复尚在本地，重新安装目前的同一个 0.3.22 发布版本仍可能安装到不兼容的间接依赖。

## 后续功能改进建议

1. 启动诊断与脱敏报告：展示 PiWeb、Node、npm、各 Pi 包实际加载版本和 SDK 自检结果；一键复制报告时剔除启动令牌、Cookie、API Key。优先级最高，能缩短远程排错时间。
2. 更新自检与失败回退：保存上一次可用的依赖版本，更新后执行 SDK 和关键接口检查，失败时给出恢复入口；当前更新会修改共享 node_modules，旧构建保留并不能恢复旧依赖。
3. 旁聊采用浏览器本地存储：按用户要求撤回导入、导出功能；历史记录、草稿和模型选择继续通过原有 localStorage 自动保存。撤回前的实现与验证文件已归档到 backups/，记录见 backups/INDEX.md。

另外，CI 的 Node.js 22.19.0 检查项与 jsdom 30.1.2 等开发依赖声明的 ^22.22.2 / ^24.15.0 / >=26 范围不一致。本轮补跑 Node.js 22.19.0 的旁聊组件测试，12 项通过；声明范围仍与项目最低版本不同，正式发布继续由 Windows/Linux × Node 22.19.0/24 的 CI 矩阵检查。

本轮独立构建副本保存在 .next-releases/startup-audit-mv6k37vr/，没有替换当前 .next 或发布清单。

## 发布前全面验收（2026-10-13）

用户要求检查视觉、点击、交互与功能，通过后发布新版本。旁聊仅保存在浏览器中，未加入备份导入/导出。

### 检查结果

- 类型检查通过；最终全量测试 959 项通过、2 项跳过（115 个测试文件通过、1 个跳过）。
- 最终生产构建通过。保留了现有 release.mjs 动态加载导致的 Webpack 提示，SDK 实际导入和运行另以成品包检查验证。
- Chrome 真浏览器：桌面 1440×960 / 1600×1000、手机 390×844、窄屏 320×640；观察截图，检查横向溢出、输入框位置、弹窗与抽屉。
- 实际接口 + Pi SDK + 本地 OpenAI 兼容测试服务：模型发现、添加保存、工作区新建会话、发送中文消息、流式完成、Markdown/代码渲染、旁聊回答、刷新恢复草稿和记录。测试模型不使用用户的付费额度。
- 实际点击：设置的通用/模型/工具/插件/技能/远程入口、浅深色切换、手机模型编辑弹窗、文件树与 Markdown 预览、文件引用、@ 文件提及、文本附件拖拽上传、Git 差异、提示词入口、会话导入入口。
- 旁聊浏览器脚本：多轮提问、默认/专属模型、新旁聊/历史菜单、刷新后恢复、打开/关闭/拖宽的阅读位置、手机输入框均通过；真实 SDK 旁聊请求前后主会话 JSONL 文件逐字节不变。
- 独立认证实例：未登录跳转登录页、API 返回 401；令牌登录后查询串清除、HttpOnly Cookie 生效、接口返回 200；跨站写入返回 403。
- Node 22.19.0 单独验证旁聊组件 12 项通过；工作流 YAML 解析与发布索引脚本试运行通过。

- 最终成品包：1371 个文件、21.2 MB；空目录全局安装、Pi 1.1.0 SDK、首页及 health/version/models/sessions/workspaces/pi-settings 六个接口检查通过。

### 本次修复

1. 修复 #037 / #057：固定 Pi 运行时相容版本，更新 Pi 时一次解析版本并同步安装相关包，加入成品包干净安装和生产启动门禁。
2. 修复 #105：长期旁聊超过 1000 条历史、UTF-8 JSON 超过 2 MiB、单条回答超过 100000 字符时，下一次提问会被服务端拒绝。新增三类先失败再通过的回归测试；仅裁剪发送上下文，完整浏览器记录不动，并保留上下文截断提示。
3. 修复旁聊端到端脚本滞后的原生 select 选择器，适配历史菜单，以及独立旁聊面板刷新后重新打开的交互。
4. 发布流程追加版本提交索引、发布前确认远端 main 未前进、原子推送版本提交和标签，取消失败时重写历史的 rebase 回退。

### 范围与证据

没有实际访问每一家付费模型、执行供应商 OAuth 登录，或新开公网 Cloudflare 隧道；这些外部条件不由本地验收覆盖。远程代理、导入、更新、异常与安全边界由已有自动化用例覆盖。真实浏览器检查未发现前端未捕获异常。

- 桌面截图：../assets/full-audit-desktop.png
- 手机截图：../assets/full-audit-mobile.png
- 所有浏览器配置、测试会话和上传附件使用独立临时目录；工作区原有会话和浏览器数据未清理。
