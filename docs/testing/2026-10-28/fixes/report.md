# PiWeb 修复与复测报告

日期：2026-10-28，Asia/Shanghai。基于 `main` / `26a4d9f`，PiWeb `0.3.28`、Pi SDK `1.4.0`。本次修改仍在本地，未提交、推送或发布。

**前次报告中已确认的问题均已修复。最终完整测试为 1192 通过、0 失败、3 跳过；独立类型检查、生产构建和全新安装验证通过。** 真实 Pi 完成停止、继续执行与选择题复测，实际浏览器完成文件链接、图片、弹窗、下选键盘、工作区和纯图显示复测。未执行的环境与流程列在第 6 节，不将自动化事件测试冒充系统输入法实测。

前次失败与原始复现保留在 [全面测试报告](../comprehensive-report.md)。本报告描述修复后的状态。

## 1. 修复内容

| 原记录 | 修改后的行为 | 验证与证据 |
| --- | --- | --- |
| A-01：`@[slug]` 候选与 Pi 不一致 | 查询中的正则字符按字面量处理，和 Pi SDK 的 fd 搜索保持一致 | 真实 fd 的 33 个查询全部一致；`workspace-index`、`mention-parity` 纳入最终完整测试 |
| I-01：普通相对 Markdown 链接跳到 404 | 相对文件链接在工作区文件查看器中打开；正确处理中文、空格、编码、查询与片段 | 浏览器依次点击聊天中的 README 和文档内部链接，地址保持首页，文件在查看器中打开；[最终文件页面](file-image-final.png) |
| I-02：旧目录请求覆盖新目录 | 仅接受当前请求的结果；关闭后不再更新目录状态 | 新增乱序返回、关闭期间返回的正式组件回归 |
| I-03：快速打开误用输入法确认 Enter | 组合输入期间的 Enter、原生 `isComposing` 和兼容键码 229 不触发打开 | 正式组件回归通过；系统中文输入法未实测 |
| I-04：下选方向键反复开关 | 方向键移动候选，Enter 确认，Home/End 定位，跳过禁用项；长列表自动滚动到焦点项 | 实际供应商协议菜单连续方向键、End、Home 和 Enter 均通过；[菜单测量](provider-long-menu.json)、[截图](provider-keyboard-final.png) |
| I-05：文档内相对图片错位 | 图片相对当前文档目录解析，通过工作区文件 API 读取；文件预览复用聊天 Markdown 渲染 | 浏览器实际加载 `docs/assets/picture.png`，自然尺寸 400×180；[DOM 记录](file-image-final-dom.json) |
| I-06：目录选择器无法 Escape | 顶层目录弹窗支持 Escape，关闭后恢复焦点 | 正式组件回归与统一弹窗栈回归通过 |
| I-08：菜单 Escape 关闭整个设置 | Escape 逐层关闭，菜单优先；设置保持打开并恢复触发按钮焦点 | 最终构建浏览器复测通过；[设置记录](settings-final-escape.json) |
| R-01：主动停止显示模型错误 | SDK 的标准取消投影为“已中止”，工具取消也不再显示失败；真正的模型错误继续保留 | 实际模型长命令被停止，进程终止；同一会话继续成功，重启后历史状态仍正确；[真实 Pi 记录](real-pi-evidence.json)、[停止截图](real-pi-stopped.png) |

另对前次条件性风险进行了核验和修复：

| 项目 | 结果 |
| --- | --- |
| I-07：符号链接造成工作区重复或面板路径不一致 | 工作区存储、会话列表和会话快照统一使用真实路径，保留别名、顺序和移除状态；不改写原始 SDK 会话头。真实 SDK 符号链接历史回归先失败、修复后通过；浏览器历史和实际模型会话归入同一工作区，侧栏别名和项目面板一致。[历史回归](workspace-snapshot-final.log)、[浏览器记录](workspace-symlink-dom.txt) |
| 多层弹窗、Tab 焦点 | 文件、图片、快速打开、设置、供应商等共用弹窗栈；仅顶层响应 Escape，Tab/Shift+Tab 约束在当前弹窗，关闭后恢复焦点。实际图片预览 Escape 仅关闭图片层，文件层保留；设置连续 35 次 Tab 均未进入后台。[图片层记录](nested-image-escape.json)、[Tab 记录](settings-tab-focus.json) |
| 会话重命名输入法 | 加入组合输入保护，候选确认和 Escape 不再误提交、误关外层；正式组件回归通过，系统输入法未实测 |
| Drawer 标签键盘 | 加入方向键、Home/End 与标签语义；实际 Home 从 Git 返回项目页且焦点正确，正式回归通过 |
| 选择题等待混入“思考了” | 使用 SDK 模型执行时长汇总，不再用下一条消息的时间差估算；工具与用户等待不计入。无有效历史计时则不猜测。新增长时间问答等待的正式回归；真实停止轮模型 3686ms 显示约 4 秒，工具运行约 31 秒另计 |
| 改变尺寸后设置消失 | 在受控浏览器中依次切换 320、390、768、1440px，设置始终存在，文档未横向溢出。未稳定复现独立的尺寸缺陷，未虚构对应修复。[尺寸记录](settings-resize.json) |
| 无工作区首屏禁用、旧默认模型回退 | 现有逻辑不足以确认缺陷；保留原报告的证据边界，没有凭推测改变产品行为 |

同时修复两个测试/打包问题：

- `package.json` 的发布文件清单明确排除 `.next/cache`。实际缓存仍存在且未被删除；打包中不再包含缓存，其余运行文件完整保留。[策略验证](pack-policy.json)；最终工作区直接打包及全新安装也通过。
- 隧道状态测试改为等待真实子进程发布 PID 文件，替代约 1 秒的默认轮询边界；补充故意延迟 1.2 秒的回归。没有增加失败重试或跳过产品逻辑。

工作区图片 API 同步增加词法路径和 realpath 边界、gitignore / `.git` 限制、文件类型签名与 20MB 上限。SVG 拒绝 DTD/ENTITY，并使用固定 MIME、nosniff、私有不缓存及隔离 CSP；SVG 并非经通用清洗器处理。技能文档图片仍受实际发现的源文档边界约束。

## 2. 最终验证

以下结果均对应本次最终源码；构建 ID 为 **`YuwhSbAS9zo56WEfaAGB8`**。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 完整 Vitest，PATH 包含真实 fd | 148 文件：146 通过、2 跳过；1195 用例：1192 通过、0 失败、3 跳过；31.92 秒 | [日志](vitest-complete.log)、[完整 JSON](vitest-complete-results.json) |
| 独立 `npm run typecheck` | 退出码 0 | [日志](typecheck-final.log) |
| `npm run build` | webpack 生产构建和 TypeScript 检查通过；现有动态依赖警告未阻止构建 | [日志](build-final.log) |
| 工作区直接 `npm run verify:package` | 全新临时 global prefix 安装通过；真实导入 SDK 1.4.0、生产启动、首页和 6 个首屏 API 通过。包为 1536 文件、日志显示 25.1 MB，构建 ID 与上述一致 | [日志](verify-package-final.log) |
| 最终构建实际浏览器 | 相对链接、图片与图形加载；长菜单焦点及滚动；逐层 Escape；符号链接历史、项目面板；实际 Pi 历史冷加载通过 | [文件与图形](file-image-final-dom.json)、[长菜单](provider-long-menu.json)、[历史冷加载](real-pi-cold-dom.txt) |

安装验证实际访问 `/`、`/api/health`、`/api/version`、`/api/models`、`/api/sessions`、`/api/workspaces`、`/api/pi-settings`。这不是发布操作。

回归过程中保留了原始失败，未用后来通过覆盖：后端初始失败见 [backend-before.log](backend-before.log)，取消状态初始失败见 [cancellation-before.log](cancellation-before.log)，长菜单可见性失败见 [select-scroll-before.log](select-scroll-before.log)，SDK 快照路径失败见 [workspace-snapshot-before.log](workspace-snapshot-before.log)。首轮整合的两个字体测试仍用旧 button 语义查询选项，已改为在 listbox 中查询 option，原行为断言保留；[首轮日志](vitest.log)。后续完整通过之后又补入长菜单滚动及 SDK 快照回归，因此最终以 `vitest-complete` 为准，不将不同轮次数量相加。

## 3. 真实 Pi 复测

使用现有实际认证，在独立 agent/home/workspace 中连接 **DeepSeek V4.1 Flash 1017 / ClinePass**；不是预设响应 provider。

| 操作 | 实际结果 |
| --- | --- |
| 执行 Python 休眠 45 秒，在运行中点击停止 | bash 已输出开始标记，运行 31319ms 后被终止，没有完成标记，进程检查确认已退出。SDK 原始 assistant 仍记录 `stopReason: error` / `This operation was aborted`，UI 正确投影为“已中止”，原始记录未篡改。模型执行为 3686ms，UI 显示约 4 秒。[截图](real-pi-stopped.png) |
| 在同一会话继续执行 | bash 实际输出 `PIWEB_RESUME_FIX_OK`，工具 9ms 成功，模型回复“恢复成功”；两段模型执行分别为 1914ms、2157ms。[DOM](real-pi-resumed-dom.txt) |
| 调用选择题并使用数字键选择 | `ask_user_question` 实际等待 53974ms，数字键 1 选“简洁”，提交后模型回复“选择收到：简洁”。模型前后执行分别为 2117ms、1982ms；工具与整轮经过时间可单列显示，不等于模型思考时间。[截图](real-pi-ask-completed.png)、[DOM](real-pi-ask-completed-dom.txt) |
| 最终构建重启并重新打开会话 | 已中止、恢复成功、选择结果仍正确，验证了历史读取路径。[DOM](real-pi-cold-dom.txt) |

[精简 SDK 证据](real-pi-evidence.json) 仅记录角色、模型、时长和必要结果标记，不包含认证内容、请求头或推理正文。

## 4. 纯图显示

保留用户最后指定的样式：成功的 Mermaid 内容仅显示图片，没有 Mermaid 标题、工具栏、查看源码或外边框。文件预览现在也复用这套渲染。

最终构建页面中，两处成功图形的容器都只有一个 `IMG`，操作控件为 0、边框 0px、padding 0px；文档内本地 PNG 与 Mermaid 图片均真实加载成功。[测量](file-image-final-dom.json)、[页面截图](file-image-final.png)。原有完整围栏、流式未闭合内容和错误回退回归继续通过；图形仍根据实际 Mermaid 内容生成。

## 5. 隔离与收尾

测试使用独立临时目录，不修改用户 `HOME`，也不覆盖日常 agent 配置、历史或工作区。真实认证仅在权限受限的独立 agent 中用于实际请求，未写入报告。

收尾状态与已知凭据精确比对记录见 [cleanup.json](cleanup.json)。证据保留在本目录；本次自建临时环境按用户规则通过 Finder 移入废纸篓。仓库 `.next`、`node_modules` 和现有缓存保留。原有 `D CLAUDE.md` 状态保留。

## 6. 验证边界

- 三项跳过分别为 Windows 信任路径大小写、Windows PowerShell UTF-8、需显式开启的真实 cloudflared 公网隧道；当前为 macOS。
- 组合输入通过真实组件事件回归验证，没有执行 macOS 原生中文输入法候选操作。
- 未执行 OAuth 登录、新增真实密钥、真实插件安装/卸载、真实更新、Git 提交/推送或生产发布。
- 实际模型复测仅覆盖上述接入，不代表所有商业供应商、额度、网络故障和浏览器/实体移动设备均已验证。
- 图片边界、取消识别和凭据比对是本次针对性验证，不代表完成了整个项目的安全审计。
