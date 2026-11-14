# 数据区域最终编号核对

更新：2026-11-14。原报告 v2 的编号保留；“闭合”表示该触发机制已收口，区域测试不能替代父 Agent 的全量验证。

| 编号 | 核对结果 | 具体边界 |
|---|---|---|
| P1-10 | 闭合 | 包源与管理根保护，链接移除不触及目标，previewDelete/expectedPath，核验恢复副本及 INDEX。 |
| P1-14 | 闭合 | 首次任何记录均需工作区显式同意；可关闭，容量有界。保留真实既有 refs，不擅自删除用户历史。 |
| P1-15 | 闭合 | 自动化 headless 询问立即报 interaction_unavailable 并停止，不等 30 分钟。 |
| P1-19 | 闭合 | Codex 大指令头之后的会话可发现，截断扫描不假判完整空会话。 |
| P1-20 | 闭合 | 已有 SQLite 源打不开/结构或查询坏掉明确报错，来源隔离，缺失来源仍可空列表。 |
| P1-22 | 本区域闭合，交叉待父确认 | Growth/本区域 Windows 特有早退已显式 skip，真实 CI JSON 守卫通过；agent-resource-isolation 749/751 两处早退交由父 Agent。 |
| P2-13 | 闭合 | 当前偏好非法明确报错及 readonly 降级；不静默擦除其他坏行；显式权限候选先保存后应用（父接线）。 |
| P2-32 | 闭合（上层父接线） | ModelsSection保存及认证成功onChanged立即刷新上层目录；SettingsPanel持久提示跨分区/关闭重开保留。提供实际应用当前会话回调，busy禁用、失败保留并可重试；应用完成后的目录失败单独提示，切会话清除旧applied状态。API恒true已由会话区域改false，按现有自动刷新/忙时延后机制描述“自动尝试应用”，不伪称无条件成功。 |
| P2-53 | 闭合 | 已记录大文件停止本轮并保留上一树，不伪报删除；实际读取及总快照 200MiB 有界。 |
| P2-54 | 闭合 | 跨进程 lease 标注共享改动，UI 标明参与会话；不声称能识别每字节作者。心跳和过期清理共锁。 |
| P2-55 | 闭合 | 2000 条/1GiB 历史容量；gc 频率改用持久链长，重启不归零；CAS 重挂重新校验容量。既有历史不截断。 |
| P2-56 | 闭合 | 候选流中计数，达到上限立即中止，候选/去重/输出/错误输出有界；跨进程快照锁。 |
| P2-57 | 闭合 | aborted 和 provider 的取消错误都按 isAbortMessage 归为 aborted，和轨迹同口径。 |
| P2-58 | 闭合 | Piweb-Round 持久真实对话轮号；失败缺号明确展示，后续轮号不挪位。 |
| P2-59 | 闭合 | 随机 owner 标识、心跳与 lease，PID 复用不永久保持 running。 |
| P2-60 | 闭合 | 每存储实例全局最多 4 任务；到上限不先推进日程。 |
| P2-61 | 闭合 | 损坏存储保留原件，预览/expectedHash 确认后恢复；先备份核验记 INDEX，再改。 |
| P2-62 | 闭合 | 宽限外写 skipped 历史和原因；2 分钟宽限为明确规则，未擅自补跑。 |
| P2-63 | 闭合 | stop API、共享停止请求及 owner 最多 5 秒轮询，UI停止入口由前端接线。 |
| P2-64 | 闭合 | 任务上限 100；full 档授权能力按现有用户授权执行，不额外削弱它。 |
| P2-65 | 闭合 | 取消调度代次和启动失败释放尚未执行的 claim，并校验新修改/运行。 |
| P2-72 | 闭合授权入口 | npm/Git/本地源统一安装信任确认，确认期间工作区变更取消。获准插件仍运行其代码；不把确认称为第三方供应链审计。 |
| P2-73 → P3-30 | 降级表述有效，剩余项已闭合 | 查询去 DSL 操作字符/前导排除，本地要求 pi-package 关键词；删除未用 total。原“现网非 pi 结果污染”没有复现。 |
| P2-74 | 闭合 | source 固定展示及检查的 npm:name@version；未声称独立于 npm 的完整性审计。 |
| P2-75 | 闭合（父接线） | 只读发现 onMissing=skip，不为 GET 安装缺失包；诊断可见。 |
| P2-76 | PiWeb 并发闭合 | 同作用域包目录进程内及跨进程互斥；其他不遵守同一锁协议的旧 CLI 不在 PiWeb 可保证范围内。 |
| P2-77 | 闭合 | 已保存但刷新失败 applied/success + warning，避免用户重试重复安装；技能同样区分。 |
| P2-78 | 闭合 | 有锁原子技能开关，保留嵌套 YAML/BOM；修改期间源变化拒绝覆盖。 |
| P2-79 | 闭合 | 包操作核对请求作用域中的实际 source，不在错误作用域添加。 |
| P2-80 | 闭合 | 文件读取中/解压累计 200MiB，zstd 逐帧完整性与累计限制，截断扫描保留 incomplete 警示。 |
| P2-81 | 闭合 | 来源反查每来源缓存一次，扫描 30 秒、GET/POST取消、实例锁；NDJSON实时 progress/result、读流取消传后端、失败尾部完整汇总，默认 JSON 兼容。 |
| P2-82 | 交叉由父确认 | HTML 临时目录/唯一名称/清理与导出接线由父会话区域负责。 |
| P2-83 | 闭合 | time_deleted/time_archived 按存在列过滤，兼容缺列/0。 |
| P2-84 | 闭合 | dsh 缺 cwd 保留未知，不猜有歧义编码；面板不可勾选未知工作区。 |
| P2-85 | 闭合 | 每批只读一次导入索引/归档集合，成功后增量更新，writer create-if-absent 防覆盖。 |
| P2-86 | 交叉源码闭合 | 项目编辑值与 trusted effective 值分离，全局独有网络字段不写项目；父负责运行时刷新失败提示。 |
| P2-87 | 本区域闭合 | cookie 同步 SSR 初始语言，旧 localStorage 在 hydrate 后迁移；主题 head 脚本先于绘制。 |
| P2-88 | 闭合 | 直接提示词/引用文档/技能正文统一实际 1MiB 有界读取。 |
| P2-91 | 闭合 | 启动 token 5 分钟、一次性兑换更换、all 登出撤回；带私密凭据 IPC 即时取新值。 |
| P2-92 | 闭合 | 全设备 cutoff 在跨进程锁内计算，坏撤销存储 fail-closed、不覆盖原件。 |
| P2-93 | 闭合 | 认证默认开，仅 PI_WEB_AUTH=0 关闭；launcher 和服务约定一致。 |
| P2-102 | 闭合 | SSE路由保留真实 subscribe/epoch/holdViewer 契约。 |
| P2-103 | 交叉由远程区域确认 | Windows fixtures及真实隧道 CI门禁由远程区域承担，不借本区域测试宣称完成。 |
| P2-104 | 闭合 | DOM/vi.waitFor 未显式指定时默认 5 秒，保留调用者参数。原“所有242处均1秒”表述已修正。 |
| P2-105 | 闭合 | 坏行、编码替换、源移动、缺摘要、SQLite坏数据、zstd截断和累计上限真实回归。 |
| P2-106 | 有效业务缺口闭合 | sessions/[id] 真正 await dispose→delete→forget，成功/失败/边界6项。19零覆盖文件不等于19业务缺陷。 |
| P2-107 | 闭合 | 实际 remote 测试监听限定 loopback。 |
| P2-113 | 闭合（最终浏览器36/36绿） | 窄屏/粗指针按钮、页签与输入控件保留真实44px布局命中；最终build V8EkQiPStS7Rma76LwdHE / Chromium390×664通过实际可见中心命中、侧栏inert及无横溢。header预留safe-area+68px；首字Range中心命中标题，x68不被x12宽44菜单覆盖，截图已目视确认。真机和匹配WebKit未测。 |
| P3-10/11/12/13 | 交叉源码闭合 | web/select waitForViewer；custom await异步工厂；空status删键；switchSession resolveSessionPath。 |
| P3-15 | 报告机制闭合 | 显式 template/extension namespace 解决 Web builtin 同名；模板与扩展彼此同名仍受 SDK extension 优先级限制。 |
| P3-18 | 本区域前半闭合，清理后半交叉 | Sidebar归档改ConfirmDialog确认，说明停止任务/保留内容/30天后恢复副本清理；取消不调用归档，pending防重复，拒绝保留框内错误可重试。父修AppShell拒绝传播和等待期间切会话的旧完成防护；单条清理失败继续、全局单sweeper由权限区域收口。 |
| P3-23 | 闭合 | 工作区缓存 LRU；中文/英文可行动主提示，原始详情折叠；冷用量 percent 0–100。 |
| P3-26 | 本区域闭合，其他路由父确认 | 技能/插件/市场/growth/import/automations catch统一apiError；公开来源诊断、流progress/result、自动化run/store和扩展错误也脱敏。保留合理400/409、OS分类、Growth类别与插件applied warning，20条资源路由错误矩阵及stream5通过。auth已隐藏路径；其他父owned路由由父最终核对。 |
| P3-28 | 闭合（跨区域接线） | ChatInput 模型不支持图片时发送前提示；>2MiB GIF明确拒绝保留动画语义。 |
| P3-30 | 闭合 | 见 P2-73 行，补纯文本过滤、本地标识校验、死字段移除，5项市场专项通过。 |

## 最终实质复审发现

- 父新增 web-history 预览每个 args 8KiB 未扣总预算，100 part×100 nestedCalls可形成约80MiB单消息，首条绕5MiB页预算；已交父共享预算/总call限额修复。
- 父新增 readSession 复用 Managed 后不刷新同ID外部改写，Claude→Codex导入来源变更仍套旧隐藏规则；真实 service回归已失败并通知，父正在修 syncWithDisk，同尺寸回归由权限区域补充。
- clientFetch 使用 body reader 后未清超时/调用者监听已交父修流消费完成路径。
- 父 GeneralSection旧scope rejected响应及活动会话刷新错误反馈已由父确认修复。
- AppShell新增卸载前正文/引用即时持久化真实回归已通过。Windows等价路径草稿恢复缺陷已由父统一Windows/UNC key并迁移旧key，POSIX保留大小写。`slice(-30)`静默淘汰已改为持久化全部非空草稿，保留原存储并在10M字符或浏览器quota超限时明示。31份恢复与发送清空后的保留回归通过。Hero换工作区保持同一草稿；普通文件保存在共享上传目录并用绝对路径引用，没有旧cwd绑定错归属实证。

验证末状态：市场5项、流路由4项、导入面板23项、ProjectPanel14项、AppShell草稿14项通过；导入服务冷缓存复跑由权限区域承担，不重复跑或借旧结果宣称全绿。Growth持久链长GC改动真实Git专项20项通过/1项明确Windows链接权限skip（共21项，63.85秒）。最新完整tsc全绿；父全量最终结果待定。

00:44 P2-32追加：模型面板23项、设置确认2项通过，完整tsc再次全绿。API回归由会话区域执行37项通过；AppShell callbacks/currentSessionKey由父接线，统一构建和全量复跑以父结果为准。本区域source已freeze，不重启真实实例。

01:00最后收口：P3-26公开错误、P3-18归档确认和ProjectPanel warn/success前景修复完成。10文件100项全绿（resource errors20、stream5、scan11、automation preview6/input4、plugins15/source7、Sidebar16、ProjectPanel14、settings confirm2）；完整tsc绿。AppShell父归档回归与清理后半权限回归以各所有者结果为准；本区域source再次freeze，仅更新此台账。

01:20真实浏览器补充：移动44px菜单覆盖标题首字，header左padding已由52px改safe-area+68px；新stage首字符elementFromPoint与截图待验收。Growth历史预览统一共享BOM解码，UTF8/BOM及UTF16LE/BE正常，非法编码明确unsupported，截断不切UTF8/UTF16字符；新真实Git2项先复现再修绿，加既有round读取用例共3绿，完整tsc绿。最终build/browser由父统筹，不把旧stage当最终结果。

最终production浏览器：build V8EkQiPStS7Rma76LwdHE，Chromium156.0.8078.4 / Playwright1.64.0 / 匹配revision1248，36/36项绿，11关键stage源码SHA与当前目录一致。桌面1280×800与移动触屏390×664，SSR zh-CN无hydration/runtime错误，44px/侧栏inert/标题首字无遮挡已实测。原生EventSource永久503出现明确提示及手动/自动新请求，静默51秒触发重建，恢复后80秒心跳保持同一连接。P3-21交叉补真实GitPanel长行横滚：桌面/移动scrollWidth33103/client311，scrollLeft0→1000，2002差异行只渲染63行、底部可达、整页无横溢；截图已目视，权限区域登记。API元数据与异常来自本机fixture，没有调用真实模型；物理手机与匹配WebKit未测。独立测试进程43556/2411已关闭且再次核验PID/监听均不存在；30141及真实用户设置未动。证据为browser-final.json/md与5张截图。

清理已完成：本次自建browser-probe临时根（脚本和隔离agentDir）已用Windows原生回收站接口移入回收站；路径消失已核验，browser-final.json登记temporaryFilesRecycled与独立停进程核验。截图/结果保留在审计目录。
