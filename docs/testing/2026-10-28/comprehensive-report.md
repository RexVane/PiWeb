# PiWeb 全面测试报告

> 后续状态：用户要求“全部修复”后，下文已确认的问题均已修复。最终完整测试为 **1192 通过、0 失败、3 跳过**，类型检查、生产构建与全新安装通过；真实 Pi 和浏览器已复测。详见 [修复与复测报告](fixes/report.md)。下文保留修复前的原始发现和失败结果。

日期：2026-10-28，Asia/Shanghai。被测版本：PiWeb `0.3.28`，Pi SDK `1.4.0`，提交 `26a4d9f`，分支 `main`。

**本次测试发现实际交互缺陷，整体结果包含失败。** 标准自动化、生产构建和独立安装验证通过；补齐真实 fd 后有一项回归测试稳定失败。真实 Pi 完成了代码生成、工具执行、问答、停止后续跑和插话测试，浏览器覆盖设置、文件查看、Git、导入、输入及响应式显示。Mermaid 改动与回归在第 8 节单列；最终按用户要求精简为仅显示图。

## 1. 测试范围与证据口径

本次按“先同步最新代码，再检查现有项目”执行。同步后的 HEAD 为 `26a4d9f`，以下基线测试均针对该版本；原有 `D CLAUDE.md` 状态保留。测试过程中随后按要求添加 Mermaid 支持，变更内容与回归结果在第 8 节单列，修改前后的结果分别记录。其余发现的问题尚未统一修复。

| 证据类别 | 实际含义 | 不能据此推出的结论 |
| --- | --- | --- |
| 真实浏览器操作 | 本次在实际页面执行点击、键盘或尺寸切换，并观察结果 | 单张截图不能证明整个交互流程通过；一个浏览器不能代表所有浏览器 |
| 真实 Pi / 实际模型服务 | 本次操作真正的 Pi 运行时和实际 DeepSeek 模型服务，九轮记录见第 7 节 | 本机模拟 provider、预制历史会话不能代替该类别 |
| 真实 Pi SDK + 本机确定性 provider | 官方 SDK 真实加载、认证并向本机测试 provider 请求，返回预设流式文本或工具调用 | 不验证商业模型的推理质量、实际供应商认证、计费、限额或公网稳定性 |
| 正式自动化测试 | 仓库现有 Vitest 用例或构建/打包 gate，有日志及 JSON 结果 | jsdom 的事件断言不能证明真实像素布局、触摸、焦点和平台输入法体验 |
| 内存组件探针 | 使用当前组件源码、React/Testing Library/jsdom，桩掉无关依赖，观察真实事件与状态逻辑 | 不是仓库正式新增测试，不计入 Vitest 用例数量；不等于浏览器实测 |
| 只读源码审计 | 检查事件绑定、路径处理和调用链 | 未执行的推测不计为已复现缺陷或已通过 |

详细方法见 [automated-findings.md](automated-findings.md)、[interaction-findings.md](interaction-findings.md) 和 [fixture-notes.md](fixture-notes.md)。

## 2. 运行环境与隔离

- macOS；Node `24.15.0`，npm `12.0.2`，Next.js `16.4.2`，Vitest `5.0.5`。
- 自动化和本机 fixture 使用本次独立 agent、home 和 workspace。home 隔离通过 Node preload 替换 `node:os.homedir()`，未修改 `HOME`。fixture 内有测试 models/settings/auth、技能、prompt、预制 Pi 会话和两条 Claude 来源对话。
- 文件样本包含 README、TypeScript、中文 Markdown、长文本、SVG；Git 样本包含基线、暂存修改、未暂存修改和未跟踪文件。
- 本机确定性 provider 仅监听 `127.0.0.1:34128`，使用测试凭据；fixture UI 监听 `127.0.0.1:34129`。真实 Pi 测试 UI 监听 `127.0.0.1:34127`。真实模型测试使用独立 agent 目录和现有认证进行请求；报告不包含认证值、配置内容或请求头。
- 独立安装验证使用新的临时 global prefix，仅监听 `127.0.0.1` 随机端口，关闭远程入口。
- 自动化验证的临时 agent/staging、浏览器 fixture、独立真实 agent 与本次下载样本均已通过 Finder 移入废纸篓；证据副本保留在报告目录。34127、34128、34129 三个本次服务均已停止，核对无监听；浏览器临时 viewport 已恢复。

## 3. 自动化、构建与安装结果

| 项目 | 结果 | 原始证据 |
| --- | --- | --- |
| SDK 搜索工具准备 | fd、rg 探针通过 | [vitest-sdk-prepare.log](vitest-sdk-prepare.log) |
| 基线标准 `npm test` | 137 文件：135 通过、2 跳过；1135 用例：1131 通过、4 跳过、0 失败；26.75 秒 | [vitest-results.json](vitest-results.json)、[vitest.log](vitest.log) |
| 补齐 PATH 中真实 fd 后运行 @ 候选端到端测试 | **1 失败、4 通过**，独立复跑再次失败 | [vitest-mention-parity-results.json](vitest-mention-parity-results.json)、[复跑日志](vitest-mention-parity-confirm.log) |
| 33 个 @ 查询逐个完整对照 | 32 一致，`[slug]` 不一致 | [mention-parity-all-queries.json](mention-parity-all-queries.json) |
| 基线 `npm run build` | 生产 webpack 构建成功，构建内 TypeScript 检查完成；存在动态依赖警告 | [build.log](build.log) |
| 独立 `npm run typecheck` | 基线和修改后均通过；修改后独立命令退出码 0 | [typecheck-mermaid.log](typecheck-mermaid.log) |
| 工作区直接 `npm run verify:package` | 因现有 `.next/cache/.previewinfo` 进入 tarball，被发布检查拒绝 | [verify-package.log](verify-package.log) |
| 基线排除 cache 的隔离 staging + 真实空目录安装 | **通过**：Pi 1.4.0 SDK、生产启动、首页、首屏 API | [verify-package-isolated.log](verify-package-isolated.log)、[结果 JSON](verify-package-isolated-results.json) |
| 基线源码/包内敏感内容启发式检查 | 637 文件中常见私钥/token 格式 0 命中；包内未发现 `.env`、auth/settings/models 配置、会话 JSONL、私钥文件 | [package-source-safety.json](package-source-safety.json) |
| Mermaid 初版全量 `npm test`，PATH 包含真实 fd | **140 文件：137 通过、1 失败、2 跳过；1147 用例：1143 通过、1 失败、3 跳过；26.91 秒。** 唯一失败为既有 A-01 | [vitest-mermaid-results.json](vitest-mermaid-results.json)、[vitest-mermaid.log](vitest-mermaid.log) |
| Mermaid 初版 `npm run build` | 生产构建通过 | [build-mermaid.log](build-mermaid.log) |
| Mermaid 初版独立 staging + 真实空目录安装 | **通过**：Pi 1.4.0 SDK、生产启动、首页、6 个 API；全新安装内实际导入 Mermaid 12.2.0，`initialize` / `render` 导出存在 | [verify-package-mermaid-isolated.log](verify-package-mermaid-isolated.log)、[结果 JSON](verify-package-mermaid-isolated-results.json) |
| 最终纯图版聚焦回归与独立 typecheck | 5 文件 17/17 通过，含最终 Mermaid 3 文件的 10 个用例；typecheck、diff check 退出码 0 | [mermaid-final-focused.log](mermaid-final-focused.log) |
| 最终纯图版全量 `npm test`，PATH 包含真实 fd | **140 文件：136 通过、2 失败、2 跳过；1145 用例：1140 通过、2 失败、3 跳过；36.89 秒。** A-01 与一个隧道测试失败，详见下文 | [vitest-mermaid-final-results.json](vitest-mermaid-final-results.json)、[vitest-mermaid-final.log](vitest-mermaid-final.log) |
| 最终版隧道失败文件独立复跑 | 11/11 通过，约 6 秒；保留全量中的原始失败，不改写为通过 | [复跑 JSON](vitest-mermaid-final-tunnel-recheck-results.json)、[复跑日志](vitest-mermaid-final-tunnel-recheck.log) |
| 最终纯图版 `npm run build` | 生产构建通过；构建 ID `QgR735Kzoi8Z0uXm_X2J2`，随后实际启动并完成浏览器验收 | [build-mermaid-final.log](build-mermaid-final.log)、[启动日志](real-ui-mermaid-final-server.log) |

标准测试的“0 失败”只描述首次执行。当时真实 fd 对照因 PATH 不含 agent `bin/fd` 而跳过；补齐条件后已确认失败，因此整体结论包含失败。重复执行的 4 个通过用例不叠加到 1131 中充当新的覆盖数量。

Mermaid 初版回归在新的独立 agent 目录、`PI_OFFLINE=1` 下运行，将真实 fd 加入 PATH，因此 A-01 直接计入完整 suite 的失败。初版新增的 `mermaid.test.ts`、`markdown-mermaid.test.tsx`、`mermaid-diagram.test.tsx` 共 12 个用例全部通过，没有新增 Mermaid 测试失败。随后按用户要求移除工具栏与导出逻辑，最终版本另行回归；不把初版结果当作最终版结果。

最终纯图版删除了不再需要的导出/操作逻辑及对应测试，Mermaid 3 个文件的 10 个用例全部通过。最终全量原始结果为 **2 失败**：除稳定的 A-01 外，`integration/remote/tunnel-status` 的 `can stop while waiting for an address and start a fresh tunnel` 在等待测试 PID 文件时出现 `ENOENT`。该文件随即独立复跑 11/11 通过；观察接近约 1 秒轮询边界，但根因尚未确认，不将其直接归为 Mermaid 缺陷或宣称已经修复，也不将复跑覆盖原失败。

基线独立安装包为 `rexvane-piweb-0.3.28.tgz`：1404 文件、23,360,657 字节（约 22.3 MiB），构建 ID `NqepHhkS-RiO3ALEfYPC5`。Mermaid 初版另行构建并重新打包验证，同名包为 **1540 文件、26,355,788 字节（约 25.1 MiB）**，构建 ID `Egxe8_GiZqCvoKewdM2Mo`，不是已发布的新版本。这是工具栏移除前的独立安装记录。

两个包均在全新临时 global prefix 中安装并实际请求通过 `/`、`/api/health`、`/api/version`、`/api/models`、`/api/sessions`、`/api/workspaces`、`/api/pi-settings`。修改后的安装目录还实际导入 Mermaid，核对到版本 12.2.0 及 `initialize` / `render` 导出，因此新依赖没有借用仓库 `node_modules`。该包的敏感数据文件名检查为 0 命中。此项验证模块安装与生产启动，实际图形显示/导出结果另见第 8 节。

直接打包失败属于发布前置状态，不应写成“已发布包无法运行”。现有 `.github/workflows/publish.yml:56-62` 会在构建后清缓存再打包；本次保留工作区现有缓存，在隔离副本中完成验证。构建的 `scripts/release.mjs` 动态依赖警告也没有阻止构建或独立生产启动，暂记为非阻断观察。

## 4. 已确认缺陷与复现

严重度采用：P2 为会影响特定正常操作的功能问题；P3 为较轻的交互一致性问题。本次下列记录中尚无证据确认 P0/P1 问题，这不等于已经排除所有高严重度风险。

### A-01 / P2：`@[slug]` 多返回了 Pi 终端没有的文件候选

- **证据：正式自动化补测 + 真实 fd；两次稳定复现。**
- 前置：Pi SDK 1.4.0，PATH 可执行真实 fd；目录中有 `src/app/[slug]/page.tsx`。
- 操作：输入 `@[slug]`，对照网页候选和 Pi 终端补全；或运行 `tests/mention-parity.test.ts`。
- 实际：Pi 仅返回 `[slug]/` 目录，网页额外返回 `page.tsx`。
- 原因：`src/lib/workspace-index.ts:75` 不转义无 `/` 查询，`[slug]` 被解释成正则字符集；新版 Pi 同分支已使用 `escapeRegex`。
- 证据文件：[33 个查询对照](mention-parity-all-queries.json)、[失败日志](vitest-mention-parity.log)。

### I-01 / P2：聊天中的普通相对 Markdown 文件链接跳转到 404

- **证据：本次真实浏览器操作 + 源码审计。**
- 前置：聊天回复显示 `[README](README.md)`，文件实际在工作区内。
- 操作：点击该普通 Markdown 链接。
- 实际：浏览器导航到站点 `/README.md`，实际显示 404；没有走页内工作区文件查看器。
- 原因：`src/components/MarkdownBlock.tsx:109` 的普通链接仍是 `a`；行内代码路径才调用文件动作 context。
- 证据：[relative-readme-404.jpg](relative-readme-404.jpg)、[交互报告](interaction-findings.md)。同次测试中，点击反引号行内路径可正常打开文件查看器，见第 6 节。

### I-02 / P2：目录浏览旧请求覆盖新请求，可能确认错误目录

- **证据：内存组件探针 + 源码审计；未计作真实浏览器复现。**
- 操作：在目录选择器快速依次点击 A、B，令 B 请求先返回、A 旧请求后返回，再点确认。
- 实际：先显示 B，随后被 A 覆盖；确认回调最终收到 A。
- 原因：`src/components/DirectoryPicker.tsx:53` 没有取消旧请求或序号校验，加载时目录入口仍可点击。
- 复现方法和限制：[interaction-findings.md](interaction-findings.md)。

### I-03 / P2：文件快速打开框把中文输入法确认 Enter 当作打开操作

- **证据：内存组件事件探针 + 源码审计；真实平台输入法行为待补。**
- 操作：在文件快速打开输入框派发 `key: Enter, isComposing: true`。
- 实际：仍调用 `onOpen("file.txt")` 并关闭搜索。
- 原因：`src/components/FileViewer.tsx:643` 未检查输入法组合状态。聊天输入框已有相应保护。

### I-04 / P2：供应商自定义下选的方向键反复开关菜单

- **证据：本次真实浏览器操作 + 内存组件探针 + 源码审计。**
- 操作：在自定义供应商设置中聚焦 protocol 下选，连续按两次 ArrowDown。
- 实际：第一次打开，第二次关闭；没有移动候选或完成选择。
- 原因：`src/components/CustomSelect.tsx:75` 将上下方向键实现成反转 `open`，未维护候选索引或焦点。
- 截图：[provider-keyboard.jpg](provider-keyboard.jpg)。

### I-05 / P2：Markdown 文件内相对图片没有解析到文档目录

- **证据：内存组件 DOM/URL 探针 + 源码审计；没有实际发出该图片 HTTP 请求。**
- 前置：打开工作区 `docs/readme.md`，其中有 `![local picture](assets/picture.png)`。
- 实际：生成的 `img src` 仍为 `assets/picture.png`，浏览器会相对站点页面解析；没有读取应有的工作区 `docs/assets/picture.png`。
- 原因：`src/components/FileViewer.tsx:579` 只定制链接，图片走默认 Markdown 输出。
- 限制：站点是否恰有同名静态资源会影响最终 HTTP 结果，不能把探针结果写成已观察到图片 404。

### I-06 / P3：应用内目录选择器无法用 Escape 取消

- **证据：内存组件事件探针 + 源码审计。**
- 操作：打开网页内目录选择弹窗，派发 Escape。
- 实际：取消回调 0 次，弹窗仍存在。
- 原因：`src/components/DirectoryPicker.tsx` 没有 Escape 处理。

### I-08 / P2：下选菜单的 Escape 关闭了整个设置窗口

- **证据：本次真实 Edge 操作 + 源码审计。**
- 操作：打开设置中的语言下选菜单，按 Escape。
- 实际：整个设置窗口关闭，没有只关闭当前菜单层。
- 原因：`src/components/SettingsPanel.tsx:568` 的下选层只处理点击外部；`:97` 的 document Escape 监听直接执行设置 `onClose`。
- 对应源码核验见 [interaction-findings.md](interaction-findings.md)，同次设置测试见第 6 节。

### R-01 / P2：用户主动停止成功，却显示为模型返回错误/失败

- **证据：本次真实 Pi + 实际模型 + 浏览器操作。**
- 操作：让 Pi 通过真实 bash 执行 Python 休眠 30 秒，在约 19 秒时点击停止。
- 实际：进程已被终止，停止动作生效；界面却显示模型返回错误 `This operation was aborted` / 失败。
- 后续验证：在同一会话继续要求运行测试，4 个用例仍全部通过，约 3 秒完成；没有观察到会话因此无法继续。
- 影响：状态文案将正常的用户取消呈现为失败。此处只确认实测症状，未将原因未经核验归到具体源码分支；精简会话记录见 [real-pi-evidence.json](real-pi-evidence.json)。

## 5. 条件性风险与未定观察

以下不并入“正式测试失败”或无条件的已确认产品缺陷数量。

| 观察 | 当前证据与边界 | 仍需核验 |
| --- | --- | --- |
| I-07：同一工作区以符号链接两种拼写出现两组 | `realpath` 与 `path.resolve` 的规范策略确实不同；fixture 曾混用 `/tmp/...` 和 `/private/tmp/...`。正常 UI 添加工作区先做 realpath，历史/CLI 会话可能保留别名 | 用实际历史/CLI 会话复现两种 cwd 注册，确认正常用户路径和影响 |
| 改变窗口尺寸后设置消失 | 本次观察到 320/768px 有设置节点，1440px 后节点消失；源码没有证明是响应式 remount | 排除 Escape、外部点击、页面重载或其他关闭事件，稳定复现并定位 |
| 设置焦点和键盘导航 | 源码缺少部分 dialog/焦点约束；SelectOption、Drawer tab 未见完整方向键处理 | 实际 Tab/Shift+Tab 是否进入后台，以及能否纯键盘完成选择 |
| 多层文件查看器与设置的 Escape | 两者均安装 document Escape 监听 | 实际是否同一按键同时关闭两层 |
| 会话重命名输入法 Enter | 源码未见与聊天输入框同等的组合输入保护 | 单独组件探针及真实中文输入法复现 |
| 无工作区时首屏输入禁用、旧默认模型回退 | 当前逻辑和回退顺序已解释；旧默认 ID 缺失不足以证明回退错误 | 需当时 defaults 响应和工作区 localStorage 才能解释精确选中哪个模型；不得用现在 fixture defaults 替代此前真实响应 |
| 选择题等待被计入“思考了”时长 | 真实选择题约等待用户 55 秒，UI 显示“思考了 59 秒” | 该指标是否意图表示整轮经过时间需确认；不能把 59 秒全部解释成模型计算延迟 |

## 6. 浏览器与视觉测试记录

本节记录实际页面上的点击、按键、DOM 状态和显示结果。真实 Pi 聊天操作见第 7 节；导入、设置持久化等可能改写数据的操作使用隔离测试目录。Microsoft Edge 用于明确尺寸的响应式检查；应用内浏览器的截图仅记录画面，不作为精确 390px 断点的证据。

| 模块 | 本次实际操作与观察 | 结果与边界 |
| --- | --- | --- |
| 文件查看器 | 点击聊天行内代码 `src/sum.ts`，成功打开页内查看器；切换内容/变更，进入全屏并用 Escape 退出 | 这些打开、切换和全屏操作通过；[real-file-fullscreen.jpg](real-file-fullscreen.jpg)。普通 Markdown 相对链接仍有 I-01 |
| Git 抽屉 | 正确显示 staged/unstaged/untracked 分类；打开 README 暂存 diff，显示新增 2 行；执行刷新、返回并查看历史列表 | 分类、diff、导航和历史显示通过；未实际执行 commit、push 或发布 |
| 设置导航 | 逐一载入通用、模型、工具、插件、技能、远程 6 个设置区 | 6 区均载入；这不代表每个区的所有联网/写入功能均已执行 |
| 主题与显示模式 | 逐个切换 6 个主题并检查 `aria-pressed`；将模式切到深色，再切回系统 | 选择状态与切换通过 |
| 字体 | 点击字体字号增加，随后点击重置 | 增加与重置操作通过 |
| 自动压缩 | 切换 compaction 开关，并读取隔离配置核对往返结果 | UI 与配置一致；未改写用户真实配置 |
| 自定义供应商弹窗 | 空表单的保存按钮禁用；protocol 下选连续两次 ArrowDown 导致先打开后关闭；随后取消 | 空值约束和取消通过；方向键行为确认 I-04。未添加真实密钥 |
| 语言下选 | 打开语言菜单后按 Escape | 整个设置窗口关闭，确认 I-08，未计作通过 |
| 插件与技能 | 展开默认 builtin 插件；空安装输入时按钮禁用；载入技能列表 | 展开、空值约束和列表载入通过；未安装/卸载实际插件 |
| 会话导入 | 扫描两条预制 Claude 来源会话，全选并导入，显示成功 2 条；搜索无结果时显示 0；重复导入入口禁用 | 测试数据的扫描、选择、导入、空结果和重复限制通过；不代表所有来源格式已实测 |
| 导入恢复 | 将已导入的 1 条测试会话归档，再扫描，出现 restore 选择框；选择后恢复成功 1 条 | 归档后的识别和恢复操作通过 |
| 侧栏会话搜索 | 输入不存在的内容，结果为 0；输入“中文”，结果为 3 个匹配 | 空结果与中文检索通过 |
| slash 命令 | 输入 `/model` 并按 Enter | 模型菜单打开，输入框清空；该命令流程通过 |
| @ 文件引用 | 输入 `@src/`，按 ArrowDown、Enter | 挂入 `src/demo.ts` 引用 chip，随后能移除；常规候选/键盘接纳/移除通过。特殊查询仍有 A-01 |
| 换行键 | 在输入框输入“第一行”后按 Shift+Enter | 实际 textarea 值为 `第一行\n`，没有发送消息 |
| 会话分支 | 对预制会话点击“在新对话中分支” | 侧栏出现两个同标题会话，分支内容保留，操作通过 |
| 会话导出 | 对预制边界会话执行 `/export`，输入框清空；新窗口触发实际下载，随后定位确切文件并与源 JSONL 逐字节及 SHA-256 核对 | **实际导出下载通过**，1598 字节完全一致；[export-download-check.json](export-download-check.json)。源标签的 download 事件因新窗口下载而等待超时，已用磁盘文件一致性补验，不作为缺陷 |

### 响应式显示的实际测量

Edge 分别设置 **390、320、768、1440 CSS 像素**的真实 viewport，在这四个宽度测得 `documentWidth === innerWidth`，没有观察到页面横向溢出。390px 时设置窗口宽 374px，320px 时宽 304px；390px 的导入界面底部按钮可见。

- 尺寸证据：[edge-mobile-settings-390.jpg](edge-mobile-settings-390.jpg)、[edge-mobile-import-390.jpg](edge-mobile-import-390.jpg)，配合上述 viewport/DOM 测量。
- `edge-desktop-models-1440.jpg` 实际没有显示设置窗口，因此不能用作“1440px 模型设置显示正常”的截图证据；1440px 的无横向溢出测量仍独立成立。
- `mobile-settings-390.jpg`、`mobile-settings.jpg`、`mobile-sidebar.jpg`、`mobile-import.jpg` 来自应用内浏览器，其实际 viewport 宽度未可靠确认，不能因文件名就认定为 390px 响应式验证。
- 本次通过调整桌面浏览器 viewport 测试，没有使用实体手机触摸，也没有据此宣称触控、虚拟键盘、设备安全区或所有移动浏览器通过。

窗口尺寸切换后设置消失的观察仍保留在第 5 节，尚未证明原因。真实浏览器中已经执行的上述操作，与组件探针或静态线索分别记录，没有将未执行的按钮或流程计作通过。

## 7. 真实 Pi 与实际模型服务验证

已落盘的 fixture 证据证明：`SessionManager.listAll()` 读到预制会话与 4 条消息；`ModelRuntime.create({allowModelNetwork:false})` 识别并认证测试模型；`streamSimple` 向本机 provider 获取完整 Markdown，以 `stop` 结束。provider 支持预设慢流、`read` 工具、两题选择题和 HTTP 429，用于稳定触发 UI 状态。

与上述 fixture 分开，本次在真实 Pi 中使用实际模型 **DeepSeek V4.1 Flash1017 · ClinePass** 完成以下九轮验证。精简证据保存在 [real-pi-evidence.json](real-pi-evidence.json)，包含 70 个事件，未保存思考内容、源文件正文、系统提示词或凭据。

| 轮次 | 实际操作与结果 | 判定与限制 |
| --- | --- | --- |
| 1 | 实际读取 README 和 `src/demo`，创建 `src/sum.ts` 与含 4 个用例的 node:test 测试；模型通过 bash 执行 `node --test`，4 个全部通过；独立重跑也 4 个通过，git diff 确认原 README/demo 未修改；约 15 秒 | 代码读取/生成、写文件、bash、测试和 diff 核对通过；这 4 个是临时样本测试，不加入仓库 Vitest 数量 |
| 2 | 真实 bash 执行 Python 休眠 30 秒，在约 19 秒点击停止，进程被终止 | 停止生效，但 UI 将主动停止显示为模型错误/失败，见 R-01 |
| 3 | 停止后在同一会话继续运行上述测试，4 个通过，约 3 秒 | 会话可继续使用，恢复流程通过 |
| 4 | 实际调用 `ask_user_question`，提供“简洁/详细”；等待用户约 55 秒，用数字键 1 选择“简洁”并提交，模型遵守选择 | 真实工具问答、数字键选择、提交和后续模型响应通过；“思考了 59 秒”包含用户等待，单列观察 |
| 5、6 | 执行 12 秒休眠期间插话，真实排队并在后续回复中精确返回“插话收到：STEER_TOOL_OK” | 运行中插话/队列及后续消费通过，相关事件见精简证据 |
| 7 | 只读实际 PiWeb 项目，读取 9 个文件，执行若干目录枚举和 grep 搜索，约 44 秒生成 10 节点架构图；find 因缺 fd 失败两次后，模型使用 read/grep 继续完成 | 源码分析任务与工具失败后的替代路径完成。缺 fd 来自本次 `PI_OFFLINE=1` 隔离环境阻止下载，不归为产品缺陷 |
| 8 | 基于已读源码，把第一版收敛为 8 节点系统总览；约 11 秒，未调用工具 | 生成总览、减少连线通过；新生产构建将同一条真实历史消息渲染为图，SVG/PNG 真正下载成功 |
| 9 | 在新生产构建中，用没有指定 Mermaid 的自然语言要求画请求时序图；约 11 秒，未调用工具 | 实际模型返回 Mermaid，完整输出后自动显示；6 个参与者、中文标签与事件返回正常。仅证明这次自然提示可用，不把输出归因于单一提示词改动 |

第 7 轮生成的原始 Mermaid 保存为 [pi-generated-architecture.mmd](pi-generated-architecture.mmd)。原界面未将 Mermaid 代码块渲染成图，截图见 [architecture-before.jpg](architecture-before.jpg)，后续处理单列第 8 节。

上述测试只覆盖这一个实际模型接入。没有据此宣称其他商业供应商、OAuth、额度或跨网络条件通过；报告不包含凭据或用户配置内容。

## 8. 静态 Mermaid 架构图与后续改动

基线已确认：实际模型能根据源码生成 Mermaid，但 PiWeb 将 Mermaid 代码块作为普通代码展示，没有渲染成图。原始源码和显示截图分别为 [pi-generated-architecture.mmd](pi-generated-architecture.mmd)、[architecture-before.jpg](architecture-before.jpg)。

本次按截图参考添加静态 Mermaid 图形显示：浅蓝圆角节点、细灰连线、中文标签和存储圆柱。用户查看初版后明确要求只显示图，因此最终移除 Mermaid 标题、复制/保存/尺寸切换按钮、查看源码与外边框，图默认适应聊天宽度。仅在完整 Mermaid 围栏闭合后绘制；失败时保留错误提示和源码，避免内容丢失。库按需加载，普通代码块继续按原方式展示。

改动集中在 `src/components/MarkdownBlock.tsx`、新增 `MermaidDiagram.tsx` 和 `src/lib/mermaid.ts`、相关 CSS/中英文文案及 Mermaid 12.2.0 依赖。`src/lib/execution-guidance.ts` 仅增加条件式绘图指引：需要图时优先 Mermaid，依据实际读过的源码，中文短标签、分层、减少交叉、大图拆分，服从用户另行指定的格式。[architecture-prompt.md](architecture-prompt.md) 提供可复用提示词，普通回答不强制带图。

以下表格保留初版真实浏览器验收，含后来按要求移除的操作，不代表这些操作仍在最终界面中。

| 初版验收项 | 实际结果与证据 |
| --- | --- |
| 真实模型图形展示 | 10 节点首版和 8 节点总览均成功渲染；总览自然尺寸 742×570。[聊天全景](architecture-after.jpg)、[聊天图区域](architecture-chat-preview.png)、[总览源码](pi-generated-architecture-overview.mmd) |
| 保存 SVG / PNG | 真实点击两个保存按钮，各自完成下载；导出 PNG 为 1484×1140，109896 字节。已保留 [SVG](piweb-architecture.svg) 和 [PNG](piweb-architecture.png) |
| 复制与源码 | 实际复制内容与模型 Mermaid 源码一致；源码展开/收起、原始尺寸/适宽往返均通过 |
| 390px 窄屏 | DOM 实测页面和文档宽度均为 390；图区域 348px、适宽图 298px，保存按钮最右边界 343.41px。Enter 可切至原图，区域内部滚动，页面仍为 390px；可切回适宽。缩略图文字较小，细节需要原尺寸或导出。该轮截图提供器只返回 390×200，未将其用作像素布局证据 |
| 真实时序图 | 第 9 轮自然语言请求后自动渲染，原始尺寸 1250×609。[源码](pi-generated-request-sequence.mmd)、[页面截图](architecture-sequence-after.jpg) |
| 预制边界用例 | 单独标注“预制，非模型输出”的会话：有效时序图成功；坏语法显示源码且禁用保存；外部图片语法被拒绝；未闭合围栏保留代码。[DOM 记录](diagram-boundary-dom.txt) |
| 安全与回归 | strict 配置、渲染前资源检查、SVG 静态清理及图片隔离；全量 JSON 中初版新增 Mermaid 12 个用例均通过。全量 1143 通过、1 个已知 A-01 失败、3 跳过；初版独立 typecheck、生产构建、新安装包验证通过，见第 3 节 |

初版测量与下载详情见 [diagram-browser-checks.json](diagram-browser-checks.json)，对应构建 `Egxe8_GiZqCvoKewdM2Mo`。最终纯图版本的回归另行记录。

最终纯图版本使用构建 `QgR735Kzoi8Z0uXm_X2J2` 重新启动，实际载入同一组真实 Pi 历史消息：三个图均加载完成，每个成功容器仅有一个 `IMG`，文本为空、内部操作控件 0、外边框 0px、padding 0px。8 节点总览自然尺寸为 742×570；[最终聊天截图](architecture-pure-chat.jpg)、[最终图区域](architecture-pure-preview.png) 与 [桌面 DOM 测量](diagram-pure-desktop.json) 可核对。

最终版 Edge 390px 实测：页面与文档宽均为 390px，三个图均适宽至 348px，控件为 0、边框为 0px，没有横向撑宽；详见 [窄屏 DOM 测量](diagram-pure-narrow.json)。预制边界会话重新载入后，有效时序图显示，错误语法和外部图片来源保留错误提示及源码，未闭合围栏继续作为代码，见 [最终边界 DOM](diagram-pure-boundary-dom.txt)。

最终纯图版完成聚焦测试、全量测试、独立 typecheck、生产构建与上述浏览器验收。独立空目录安装记录对应精简前的同一 Mermaid 依赖版本，最终精简后未重复空目录安装；未把初版安装包记录标为最终纯图包。

图示仅解释架构，不作为图中所有功能均已测试通过的证据。

## 9. 覆盖边界与收尾

- 当前平台为 macOS。标准报告中 Windows 项目信任路径大小写和 PowerShell UTF-8 两项未执行；没有据此宣称 Windows/Linux 或所有 Node 版本通过。
- 真实 cloudflared 公网隧道用例默认关闭，本次未启用。局域网代理与隧道状态的既有测试通过，不等于真实公网隧道已验证。
- 未执行 OAuth 登录、新增真实密钥、实际插件安装/卸载、真实更新、Git commit/push 或发布。相应入口载入、空值禁用或自动化测试不能替代这些真实流程。
- 未逐一验证所有商业模型供应商、额度、真实网络故障、浏览器版本和实体移动设备。实际输入法需区分事件探针与系统输入法体验。
- 预制边界会话的 `/export` 实际导出下载已通过，1598 字节与源 JSONL 逐字节及 SHA-256 一致；新窗口下载事件限制已用磁盘文件一致性补验。该文件是预制会话，不是实际模型输出，未据此覆盖所有大型/多模态会话导出边界。
- SDK/npm 下载发生过网络访问；fixture provider 和安装后的 HTTP 入口仅在本机监听。源码敏感格式检查是启发式扫描，不能替代完整安全审计。
- 本次 Mermaid 后续改动及回归另列第 8 节；其他缺陷保留在报告，不视为已修复。现有九轮真实 Pi 精简证据、截图和自动化 JSON 保存在本目录。
- 收尾已核对最终聚焦/全量回归、typecheck、生产构建与真实页面。测试服务已停止，本次临时数据已移入废纸篓，报告证据保留；48 个文本证据文件与测试时复制的真实凭据值精确比对为 0 命中。此项仅检查已知凭据值，不替代完整安全审计。
- Git 保留原有 `D CLAUDE.md`；本次源码、测试和报告改动仍在本地，未提交或推送。其他已报告缺陷未在本次统一修复。

## 10. “全部修复”后的状态

用户随后要求统一修复，前述已确认问题及核验后的工作区路径、弹窗焦点、输入法保护、等待计时等问题现已修复；打包缓存排除和隧道测试等待边界也已处理。最终源码完整回归为 1192 通过、0 失败、3 跳过，构建 `YuwhSbAS9zo56WEfaAGB8` 的类型检查、生产构建和工作区直接打包/全新安装均通过。真实 Pi 停止后正确显示“已中止”，同会话可继续，选择题完成；最终页面保留无标题、无工具栏、无外框的纯图。

具体改动、逐项证据、原始失败与覆盖边界见 [修复与复测报告](fixes/report.md)。本节更新当前状态，不改写上文历史测试结果。
