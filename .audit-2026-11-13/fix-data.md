# 数据、技能、插件、自动化修复进度

更新：2026-11-13。原始审查报告为 v2；下面区分已修、尚需产品决策、原报告表述修正。未清理真实 refs/piweb，不触碰运行中 PiWeb 或用户技能/插件配置。

## 已落实

- P1-10：技能删除按管理根和发现时的原始路径决定范围。技能根以下 junction/symlink 只移除链接；非管理根外部技能拒绝删除真实文件。包源保护保留。新增 previewDelete/expectedPath，并提供备份路径。
- 恢复删除：普通数据先复制，逐文件 SHA-256 核验，追加 backups/INDEX.md，再回收。Windows 使用隐藏 PowerShell SendToRecycleBin。链接直接移动到恢复目录；含嵌套链接目录同时保留复制备份和完整原件，避免递归回收触及链接目标。备份/核验/索引失败原件保留。
- P1-14：commitRound 的 allowRecording 必须显式 true，已有 Git 仓库亦需要同意。父 Agent 在 tracker/UI 接工作区同意入口。
- P2-53：已记录文件超出 1MiB 时停止本次快照并明确报 too-large，保留上一快照，不再伪报删除。新增 200MiB 总快照预算。
- P2-54：同工作区重叠会话通过进程内记录和磁盘 lease 标记共享改动，历史携带 attribution/concurrentSessions；不再把共享快照假称某个会话独有修改。
- P2-55：历史达到 2000 轮或 1GiB 可达对象后停止新增、提示容量限制，保留全部既有历史；此次未截断任何真实 ref。
- P2-56：git ls-files 的 NUL 记录在输出流中计数，达到上限立即中止；输出、stderr、候选去重后的数量分别有界。工作区锁具有跨进程互斥。
- Growth 缓存：至多 64 工作区，按最近使用淘汰，保护活跃锁和运行。活跃记录按 heartbeat/lease 判断，并在结束路径幂等完成。
- P1-15：自动化 Managed 在启动前标 headless。收到 interaction_unavailable 专用事件立即停止并记录缺人工输入；结束后清除标记，后续真人继续聊天可正常询问。
- P2-59：新运行具有随机实例标识与 5 分钟心跳 lease，PID 复用不再永久保持 running。旧格式 running 的兼容有效期有上限。
- P2-60：每存储实例同时最多 4 个自动化；达到上限的日程不提前消耗 nextRunAt。
- P2-63：POST /api/automations action=stop, id=taskId。共享存储落停止请求，运行 owner 最多 5 秒内收到并停止；父 Agent 接前端按钮。
- P2-65：调度代次取消或启动失败时，释放尚未执行的 claim；并验证任务修改时间和已有运行，避免覆盖另一实例推进。
- P2-61：自动化存储限 16MiB，损坏时保留原件并返回恢复预览；repairStore 支持救有效记录、恢复 last-good 或重建。确认前后按 expectedHash 核对，先备份、记 INDEX 再修复。last-good 刷新失败不会误报主存储落盘失败。
- P2-62：超过 2 分钟宽限的任务写 skipped 运行历史和错过原因，不再无声消失，也未擅自补跑。
- P2-64：任务最多 100 条；full 档任务管理仍按用户授权能力提供。
- P2-74：市场 source 固定为 npm:name@version，与展示/兼容检查的版本相同。
- P2-76：安装/卸载/更新共享作用域的包目录具有进程内及跨进程互斥；不持有 SDK settings 外部锁调用 SDK，避免死锁。
- P2-77：插件更改已保存但刷新失败返回 success + warning/applied，避免用户误重试安装。技能变更同样区分落盘与刷新失败。
- P2-78：技能开关为有锁、临时文件、原子替换，保留 BOM/YAML 原样；修改中源文件变化时拒绝覆盖。
- P2-79：包切换/卸载核对请求作用域的实际配置，不在错误作用域凭空添加源。
- P2-88（技能部分）：技能预览和开关读取限 1MiB，并限制实际读取字节，文件增长不能绕过。
- P1-19（Codex）：文件头被大指令占满时仍列出完整文件中的会话；只有完整读完的短文件才判“没有消息”。
- P1-19（SQLite）：未安装来源缺文件仍可空列表；已有文件无法打开、查询/结构错误明确抛错，由 scanAllSources 隔离来源并展示原因。
- P2-80：文件来源读取前及读取中 200MiB 闸门；zstd 单帧及累计解压输出 200MiB 闸门。扫描只读 4MiB 压缩前缀，解压量受限，不能将截断当完整空会话。
- P2-81：导入按 agentDir 串行互斥，接 Request.signal；来源反查扫描限 30 秒并通知扫描循环取消。SQLite 结果以 iterate 收集，限制行数与字节。文件源扫描按循环检查取消。
- P2-83：OC/ZCode 动态检测 time_deleted/time_archived，过滤非零/非空值；兼容缺列与 0 值。
- P2-84：DSH 缺 cwd 不再从有歧义目录编码猜工作区，保留未知，导入明确说明缺项目目录。
- P2-85：一次导入只建一次已导入索引与归档集合，并在每个成功写入/恢复后更新。
- 导入写入：随机唯一临时文件，原子 create-if-absent，禁止覆盖既有会话；失败清理仅本次临时文件。
- Grok：缺失/损坏 summary.json 时仍保留可读 chat_history；可靠 URL 编码 cwd 可作为兜底。所有文件来源报告坏 JSON 行和解码替换字符。
- 导入面板：取消/卸载时中止 scan/import；未知 cwd 不可勾选；Windows extended/UNC 路径编码归一化。
- 导入 zstd：新增坏数据回归实际暴露 Node 容许截断尾帧并只处理首帧的问题。现在先验证标准 frame/header/block/checksum 长度，再逐帧解码并核对消耗字节；完整读取拒绝损坏尾部，扫描保留前段并标 complete=false。
- 认证：默认启用，只有 PI_WEB_AUTH=0 明确关闭。启动链接 5 分钟有效、兑换后立即更换；全设备退出使未消费链接失效。启动器使用带私密文件凭据的本机 IPC 获取即时 token，不借匿名 HTTP 刷新；POSIX 仅回收同 uid、两次 inode 核验且证明无活监听的遗留 socket。
- 认证：撤销记录读损坏时 fail-closed，写入拒绝覆盖原件；全设备 cutoff 在跨进程锁内计算。cookie 改 7 天并有随机设备会话 id；设备列表可单独撤销其他设备。公开错误不泄露配置路径。
- P1-22：growth 和 Windows 特有路径用例的早退改显式 skip；沙箱能力检测由权限区域修复。CI 保存 JSON 测试报告，并按具体文件/测试名/OS/Node 版本校验允许跳过列表。缺 Git、Windows 缺安全运行时、新增未批准 skip 均导致 CI 失败。
- P2-102：事件路由测试使用真实 subscribe/epoch cursor/holdViewer；仅替换 agent 创建和快照，新增旧实例和缓冲缺口回退测试。
- P2-104：DOM waitFor 和 vi.waitFor 默认 5 秒，保留调用者显式超时。
- P2-105：补文件坏行、源被移动/移除、Grok 缺摘要、损坏 SQLite、压缩截断/总输出上限，以及真实来源路径测试。
- P2-106：新增 sessions/[id] GET/DELETE 业务回归，验证 dispose 真正完成后才删除、删除成功后才忘记元数据，失败及路径边界不继续修改。
- P2-107：remote 测试所有真实监听限定 loopback，并验证本机端口确实可连；不在用户局域网开测试入口。

## 交叉区域和实际限制

- P2-82/P3 HTML 导出属其他区域；最终状态以父 Agent 总清单为准。P2-58 真实轮号和 growth 共享归因展示已在本区域补齐，见后续记录。
- P2-75 的只读发现 onMissing=skip 已由父 Agent pi.ts 接线。技能实际删除路径确认、插件安装信任确认、自动化修复/停止入口、设备列表均由前端区域接线。
- P2-54 标记工作区共享改动可避免错误归因；它不声称能识别每个字节的实际作者。
- P2-72 安装插件运行其生命周期代码属于获准功能，具体安装确认已接；不能把提示确认当成第三方包供应链审计。
- LAN+公网统一入口为用户明确偏好，未加 LAN-only 开关。有效随机配对码不受匿名猜测失败计数锁死，现实现已满足。
- 14 个原来零执行路由不是 14 个已确认业务缺陷；此次补有顺序/失败分支的 session route，其他路由由相应区域覆盖和鉴权矩阵验证。

## 审查表述修正

- 原报告的 onProgress “未使用”不成立：index.ts 原来已经逐条调用；缺的是页面实时进度传送。
- 市场非 pi 包混入没有复现，v2 已降 P3，不能按 P2 缺陷宣称修复。
- growth 没碰用户 HEAD/分支/暂存区；“不可逆”不准确。专用 ref 可移除，但此次不删除真实历史。
- “所有 242 处 waitFor 都用默认 1 秒”过于绝对，现有部分调用已经指定超时；本次统一的是未显式指定的等待。

## 验证

- 第一次区域运行：9 文件 94 项通过。
- 扩展运行：11 文件 104 项通过。
- 新增边界回归后：11 文件 116 项通过，包含真实 junction 删除范围、恢复副本核验、无人值守询问停止、压缩累计上限、损坏 SQLite 和生命周期过滤。
- 后补认证/导入等 10 文件 137 项通过；writer/设备/token/proxy/secret/auth/pair/市场 8 文件 84 项通过。
- Growth 同意、超限与真实历史/事件/session route 4 文件 32 项通过、1 项 Windows 文件 symlink 权限不足明确 skipped。
- 最新导入坏数据/真实路径/CI 守卫 3 文件 43 项通过；启动器 IPC/令牌/导入服务 3 文件 26 项通过。
- 最新基础设施 6 文件 62 项全过，JSON 保存于 .audit-2026-11-13/infra-test-report.json，并通过真实 skipped 守卫。
- 2026-11-13 23:59 的完整 `npx tsc --noEmit` 全部通过，前一轮 ProjectPanel 两处类型错误已修。全量测试仍由父 Agent 统筹，不将区域测试替代最终总验证。

## 23:39 后追加修复与验证

- P2-13：工具偏好文件及当前会话的非法 preset、custom 工具列表和 updatedAt 明确抛错；父 manager 已接只读降级与错误通知。保存其他会话保留其原始非法记录，不借一次写入静默擦掉坏数据。schema 严格、兼容旧 v1、支持 BOM、有界读取 16MiB，保存输入同样验证。
- P2-88：提示词直接正文和引用文档统一 1MiB 实际有界读取。新 read-file-bounded helper 打开句柄核对普通文件、初始大小并限制实际读取量，文件在读取期间增长也不能绕过上限；空正文仍合法。
- 恢复副本：复制目录前拒绝备份目录位于源内部，防自递归；副本核验成功后才记录成功位置。复制失败 INDEX 明记“未核验，不可作为恢复副本 / 原件保留”。
- SSR 语言：根 layout 从 cookie 传入同一初始语言给 html 和 I18nProvider；page 不再重复包 provider；hydrate 前不再由 localStorage 改 html。旧仅 localStorage 的偏好在 hydrate 完成后迁移并写 cookie，嵌套 provider 继承已有上下文。会话删除确认改为先保留恢复副本并说明可从备份找回。
- P2-72：AddPluginModal 对 npm、Git、本地路径统一展示插件代码执行和文件读写确认；等待确认期间工作区变化则取消安装，防止批准后写入另一个项目。
- P1-1 前端：停止按钮立即进入 stopping、禁用并显示 spinner；发送与扩展命令发送也核对 stoppingRef，避免停止期间追加请求。
- 大 GIF：超过 2MiB 明确拒绝，保留动画语义，避免无声转为静态 JPEG；提示使用较小 GIF 或先转静态图片。既有不支持图片的模型发送前提示继续保留。
- P2-58：GrowthRound 写入/读出 Piweb-Round trailer，编号来自 userTurnsFromEntries 的实际轮次；失败轮不会令后续轮号前移。ProjectPanel 以最大真实轮号为分母，另计已保存条数；缺号有说明，跳转缺号定位后续最近已保存轮。
- Growth tracker：terminal error、declined 和 dispose 释放 active run 与心跳；再次允许记录使用新 runId。后台 tracker 重新启用不重复拍 baseline。共享轮明确标“工作区共享改动”、参与会话与不能独有归因说明；界面显示 2000 条历史和 1GiB 容量限制，开关 pending 防连点且防旧工作区请求改新状态。
- P3-15：支持明确 `/template:name` 和 `/extension:name`，过滤、键盘选择、模板参数补全和发送均保留来源区分；发送给 SDK 时转为真实 `/name args`，避开 Web 内建同名命令。
- 实际限制：模板与扩展彼此同名时，SDK 本身优先执行 extension；当前来源前缀解决报告中的 Web 内建命令冲突，未声称改变 SDK 交叉同名优先级。该额外限制已通知父 Agent，不擅自改 manager 协议。
- readonly MCP 测试修正：presetAllowsTool 仅提供候选，实际执行层根据 readOnlyHint 约束；补低权限档无 hint 拒绝、有 true hint 允许的断言，旧“readonly 全部 MCP false”期望已改。

专项结果：tool-preferences/prompt-sources/有界读取 21 项；recoverable/automation store 15 项；tool-preset 6 项；ChatInput lifecycle 与图片 8 项；tracker release/ordinal/parser/shared UI 5 项，随后完整 tracker-failures 9 项与 ProjectPanel 14 项通过。最终插件安装确认 2 项、命令 19 项、hydration 2 项共 23 项通过。先前插件夹具 Windows 路径转义及菜单 title 位置错误已修并重跑通过，无未处理专项失败；父 Agent 全量最终状态待定。

## 2026-11-14 00:05 后追加复查

- Growth marker 心跳原子替换与过期移除共用进程内/跨进程锁，快速筛选之后在锁内重新核对过期时间，避免旧 stat 删除刚刷新的 peer marker。marker 正文也使用 16KiB 实际有界读取。新增竞争回归确认 refreshed peer 被保留。
- 恢复副本创建前解析已有祖先，备份根 junction 指回源时先拒绝，不再先在源内创建 files 目录。复制目录创建期间为 0700，POSIX 完成后保留原目录权限，避免原先 0700 私密目录的副本变为 0755。
- 图片附件在解码前预留最多 20 项并串行准备 bitmap/FileReader，避免大量粘贴触发全部并行解码后才拒绝。晚完成图片使用父层原草稿的函数更新，切换工作区后不会把新工作区正文复制回旧草稿；新增真实组件交互验证。
- 上传清理当前版本已由权限区域接恢复副本及 INDEX、200 候选/1 万条目、会话流式 64KiB/256MiB/1 万会话/5 秒预算。证据不完整、目录/文件变化、链接和预算超限均保留原上传；先前基于旧版本的 unlink 提醒已撤回。partial upload 独有临时文件清理不涉及既有用户附件。
- client-fetch 当前使用方都以 init 传 method，调用者取消和超时会取消底层 fetch，正文消费完成清除定时器；session-location 的 Unicode URL 深链接、回到首页和非法参数不回退其他会话均通过。pi-settings 有界/JSONC/BOM/锁/全局与项目编辑值和 effective 值接线已核对；活动会话刷新失败及旧作用域 rejected 请求的 UI 更新问题交由父 Agent 收口。
- 认证默认开且仅 PI_WEB_AUTH=0 关闭的旧注释已同步修正，启动器区域已报告对应 57 项通过。

验证：Growth 真实 Git / tracker / activity / recoverable 5 文件 40 项通过，1 项 Windows 文件 symlink 权限不足明确 skipped；ChatInput 命令 19、AppShell 草稿 9、图片 1、会话地址 3 共 32 项通过；ChatInput lifecycle 9 项重跑全过（包含新增串行/预留名额和草稿归属两项）。00:09 完整 `npx tsc --noEmit` 再次全绿；中途 git route 同步中的三处语法错误已由所有者完成，不留该类型失败。

## 2026-11-14 00:20 后收口

- P2-55：Growth GC周期改用持久化ref链长，进程重启不归零；复用容量检查计数，CAS重挂再次检查容量/数量。真实Git专项20通过/1 Windows链接权限明确skip（21项，63.85秒）。
- P3-23：ProjectPanel按失败原因显示中文/英文可行动主提示，原始错误放入折叠详情；ProjectPanel14项通过。
- P3-30：市场查询剔除DSL操作字符和前导排除符，保留Unicode词和包名标点；本地要求pi-package keyword，删除死total字段。市场专项5项通过。
- P2-81：导入GET扫描传取消信号、每来源30秒预算；POST新增NDJSON实时progress/result且兼容旧JSON，读流取消传后端，完成前可见进度。流失败发送error后仍保留已完成结果与完整汇总，面板实时显示数量和失败原因、提供取消。流路由4项与面板23项通过。
- 额外真实回归发现AppShell Windows大小写/分隔符变化导致草稿旧key无法恢复，以及30条slice会静默淘汰未发送正文。已由父修canonical key/旧key迁移（POSIX保持大小写）、保存全部非空草稿、10M字符或quota失败明示且保留旧存储。我补卸载即存、Windows等价路径、POSIX区分、31条恢复、发送清空不挤掉旧稿，整个drafts文件14项通过。
- Hero换工作区是同一草稿切换目标；普通上传位于共享web-uploads并返回绝对路径，未发现旧cwd绑定错归属实证。
- 导入冷缓存外部同ID重写缺陷已交权限区域修SessionDiskTracker与manager接线，对方正在执行真实service/history回归；不将此前18/19结果表述为文件全绿。父新增web-history共享预算与clientFetch读流完成清理亦已交父完成。

各编号最终状态集中于 `fix-data-final-numbered.md`。不重启真实30141、不调用模型、不改真实用户设置、真实218条growth refs保持原样；最终全量验证由父Agent统筹。

## 2026-11-14 00:44 P2-32模型配置接线

- ModelsSection保存provider/模型字段、密钥移除/更新及OAuth成功后通过onChanged立即刷新上层模型目录；自己的配置重载与上层刷新并行，保存成功不因刷新失败转成重复写入。
- SettingsPanel持有持续提示，不随2.4秒toast、切换分区或关闭重开消失；提供实际“应用到当前会话”入口，busy禁用、同步防连点，失败保留且可重试。新正文使用`--dsw-success-text`确保可读对比。
- 实际应用成功但后续目录刷新失败，明确区分“当前会话已应用”和“模型目录刷新失败”；新保存或切换会话使旧回调结果失效，currentSessionKey变化清除上一会话applied/应用错误，不伪称新会话已经更新。
- 会话区域核验saveCustomProviders已自动refresh/reload，busy轮结束后再应用，没有必须重开场景，API恒requiresSessionReopen:true已改false。后端重载失败走error事件，所以提示采用“已保存、自动尝试应用”，而非无条件宣称已应用；父接实际reload回调与currentSessionKey。
- 模型面板23项和设置确认2项通过；00:44完整tsc全绿。顺带settings-tools-session早先3项夹具失败由父修fresh-tab隔离并已报5绿，不留未处理失败。本区域source已freeze，统一构建和全量最终结果由父负责。

## 2026-11-14 01:00最终公开错误与归档收口

- P3-26：技能、插件、市场、growth、导入与自动化路由的内部失败统一apiError，中文可行动fallback保留OS类别，JSON语法错误400、合理输入400/冲突409和Growth类别仍保留。SDK包裹的errno由父api-error恢复分类，旧“API错误正文必须含EACCES”回归改为errorCode与安全中文断言。
- 新public-diagnostic处理扫描来源message、导入progress/result/outcome/skipped、自动化run/store与扩展加载error：移除本机路径和命令输出，保留可辨认的诊断原因；来源工作区/成功会话路径等必要数据字段仍正常传递。插件保存后刷新失败继续success/applied+安全warning。
- P3-18前半：Sidebar一键归档改内部ConfirmDialog，说明停止正在运行任务、内容保留、可取消归档和30天自动清理前恢复副本。取消不调用归档，等待中禁止重复确认，拒绝保持对话框和可重试错误。ConfirmDialog只增optional error用于框内提示。父负责AppShell失败传播及等归档时切会话后旧完成不切走；权限区域负责单条清理失败继续和全局单sweeper。
- P2-24交叉：ProjectPanel所有warn/success正文前景（含tally/helper）改用对应-text变量，保持颜色语义并提高对比。
- 01:00专项10文件100项全绿，完整tsc全绿。早先真实whole-package提示脱敏吞掉后缀的测试失败已修为静态安全可行动提示；原scan测试无signal契约已与真实取消接线对齐，未保留未处理失败。

区域source再次freeze，无待清探针/待跑session；父统一全量、stage与构建。真实30141进程、用户配置和218条既有Growth refs未动。

## 2026-11-14 01:20 真实浏览器发现与历史编码补充

- 第一次隔离production浏览器截图发现：移动44px菜单覆盖会话标题首字。既有移动header的52px左padding仅让出40px菜单空间，已改为safe-area+68px，保留真实44px命中范围；浏览器探针增加首个字符Range中心elementFromPoint校验，最终新stage截图待验证。
- Growth历史fileContent原先把UTF16 BOM文本判为二进制；已统一接file-preview的BOM识别与fatal解码，返回encodingUnsupported供既有FileViewer明确提示。UTF8/BOM、UTF16LE/BE中文emoji均正确，非法UTF8/UTF16/UTF32不制造乱码；截断时保留UTF8和UTF16 surrogate字符边界。Git diff语义保持原有实现。
- 新真实Git2项先复现再修复通过，加已有round全文/patch读用例共3项绿，完整tsc绿。本区域source ready；最终production浏览器、运行与包验收等新stage，不借前一阶段结果称最终完成。独立浏览器实例63108/2514已停止，30141与真实用户数据未动。

## 最终production浏览器结果

- 最终build V8EkQiPStS7Rma76LwdHE，Chromium156.0.8078.4 / Playwright1.64.0 / 匹配Chromium1248，36/36项通过。11个关键stage源码SHA与当前工作目录一致，验证的是最后快照。
- P2-113：移动390×664真实44px按钮中心命中、侧栏inert、无横向溢出全部通过。标题首字Range中心命中自身，首字x68与菜单x12/width44分离；新截图已目视确认。
- P2-87及连接：SSR lang=zh-CN合法，无hydration/runtime错误。浏览器原生EventSource在连续503后显示明确提示及重试按钮，手动/自动重试都产生真实HTTP请求；首连接静默51秒后主动重建，恢复后的心跳经过80秒快进仍保持同一连接。
- P3-21交叉：GitPanel长行差异在桌面/移动均scrollWidth33103/client311，scrollLeft0→1000；2002行diff只渲染63行，滚到末尾added2000可达，整页1280/390无横向溢出。两张Git截图已目视，权限区域更新编号台账。
- 产物browser-final.json/md及desktop、mobile、mobile-settings、desktop-git、mobile-git五张截图保留。本次独立Next PID43556/port2411已finally关闭，另查PID/监听均无记录。真实30141、用户配置、模型和218条既有Growth refs未动。
- 局限明确保留：移动为桌面Chromium触屏模拟；未测物理手机，WebKit缓存2336不匹配所需2370未使用。API元数据和SSE异常来自本机确定性HTTP fixture，并未调用真实模型或验证所有真实业务API。
- 本次自建临时browser-probe脚本和隔离运行目录已整体移入Windows回收站，路径消失已核验；审计截图/JSON/Markdown均保留。依用户规则，自己的临时探针不备份、不写INDEX。无待跑浏览器/待停测试实例。
