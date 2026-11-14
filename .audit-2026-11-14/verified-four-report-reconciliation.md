# 四份报告逐项对账

2026-11-14，仅复核 rev-race、rev-scripts、rev-tests、rev-remote 原有 39 个条目。行号指原报告的条目标题，不是变更后源码行号。没有将 QUESTION、用户明确选择或未经执行的跨平台路径写成已消除风险。

## rev-race（10 条）

| 原条目 | 当前处置与证据 |
| --- | --- |
| 7：全登出签发窗口 | 已用 Cookie revocationEpoch 绑定签发所见代次；应用和早期 HTTP 校验一致。最后对账又发现同毫秒重复 all 代次不增加，已补严格单调代次，新凭据用代次、旧凭据用时间截止。见 pair-generation-final-v2 及认证台账。 |
| 20：残留锁/PID 复用 | OS 短事务锁、完整临时元数据原子提交、进程创建身份，旧 recovery 不再参与。历史损坏 owner 无法证明死亡时保留并报错；没有声称自动恢复所有未知遗留文件。 |
| 32：子进程登记丢失 | 记录更新与回收串行；子入口 lock-child 预加载先自行登记，失去旧 owner 时不执行入口。真实子进程回归在 file-lock.test.ts。 |
| 47：旧会话关闭与重开 | agent-manager 的 pathDisposals 按会话文件等待旧 shutdown，重复 dispose 加入同一任务；agent-managed-lifecycle 真 SDK 钩子挂起后重开验证旧尾记录仍在。 |
| 58：SDK 同步设置与异步锁 | SDK adapter、PiWeb 设置和插件设置使用共享同步 JSONC 提交；HTTP ELOCKED 在释放原生句柄/锁后让出并重试。未把其他非 SDK JSON 文件的异步锁误称为必须移除。见 jsonc-settings-storage、pi-settings、project-settings 测试。 |
| 69：rename 重试/跨进程 CAS | models 与 workspace 接共享有限重试；模型每次尝试前重读 revision，测试保留期间外部编辑。非合作外部写者在最后检查至原子替换的极窄窗口仍无通用文件系统条件替换 CAS，未声称绝对消除。 |
| 80：bashActive 未挡提交 | claimSubmission 包含 bashActive；agent-managed-lifecycle 回归断言不创建新热会话。 |
| 92：5 分钟租约重复运行 | hasLiveRunOwner/liveClaim 使用 PID 与创建身份；旧心跳不证明活进程死亡。OWNER_INSTANCE 防本进程旧实例复用；跨进程创建身份处理系统 PID 复用。见 automations 的实际并发和身份测试。 |
| 103：退出令牌 read/unlink | 已完全移除退出 unlink；文件由后续发布原子替换，读取仍需私有 IPC 活体证明。token-exit-final 23/23。 |
| 116：guardedTools 共享对象 QUESTION | 当前 SDK 的 wrapRegisteredTools 对每项调用 wrapToolDefinition，后者返回新 AgentTool 对象；AgentSession 构建自己的工具注册表。内建 write/edit/bash 定义也逐会话创建后包装。当前 SDK 未出现题设的跨会话 state.tools 引用共享，保留 WeakSet；没有把共享工厂定义直接修改成捕获会话权限的对象。 |

## rev-scripts（9 条）

| 原条目 | 当前处置与证据 |
| --- | --- |
| 7：命名管道窃取令牌 | 双向 nonce/HMAC，令牌不经管道，完成证明后重读私有文件；真实本机 IPC、假服务端和轮换回归。跨用户 DACL 非本次已测。 |
| 37：Windows start URL | 固定 PowerShell 脚本从环境接收 URL，不拼 cmd 命令文本；含元字符测试。 |
| 60：file-lock 完整性/回收 | 同上 OS 短事务锁及身份方案；历史未知损坏文件保留是明确边界。 |
| 87：Content-Length 小报 | 在 Node 原生请求分帧下不成立；其后字节不是同一 IncomingMessage body。真实 CL+TE 冲突 400、chunked 限额和未触发下游 end 回归均执行。 |
| 111：manifest fsync/active 损坏 | 清单 fsync 后替换，独立 last-ready 且恢复前验证成品完整性。不声称做过真实断电。 |
| 132：bin spawn/进程树 | spawn error 清监听，Unix 子树独立进程组，taskkill 失败明确拒绝。仅设置 exitCode 必然挂死未经证实，未加入不必要强制 exit。 |
| 157：apply-global | 构建候选通过才复制 installed src，构建失败不改旧源码。构建成功后的 src 同步仍逐文件，非断电原子整树提升。 |
| 178：process-runner npm QUESTION | 统一定位 npm-cli.js，以 Node argv 执行，移除 cmd 重解释退路；当前无已证实外部注入。 |
| 192：verify-package shell QUESTION | 同上移除 shell:true 回退。真实中间 pack/干净安装/搬迁原生与 API 验收通过，但 evidence 均 final:false，最终包等待源码冻结。 |

## rev-tests（11 条）

| 原条目 | 当前处置与证据 |
| --- | --- |
| 11：Windows skip 清单漂移 | 精确标题同步、参数化展开，新增源标题对账测试；非 Windows 才允许这些平台跳过，Windows 不因原生失败获豁免。 |
| 22：固定作者机 bash 路径 | 已改独立临时 bash.exe 选路夹具，各平台执行；删除该 skip 例外。 |
| 37：真 fd 恒跳过 | workflow 本已下载 SDK 工具，测试改查公开 getAgentDir/bin 后查 PATH；CI 明确不许跳过。scripts-third 本机真 fd 用例执行。 |
| 46：file-lock 缺回归 | 增加真实竞争登记、崩溃 OS 锁恢复、PID 身份、旧 release、新 owner、坏元数据、失去 owner 的子入口；实现变更后不再测试已移除的 mkdir recovery 协议。 |
| 61：atomic-file 缺回归 | 6 项直接验证三类共享错误重试、10 次有限失败、无关错误不重试、每次重试前复核并保留外部编辑。 |
| 70：web-devices 缺回归 | 已覆盖损坏 JSON、1 MiB、60 秒合并/失败重试、200 条保留、吊销/排序；插件 Agent 补非数组与 seen 1000 硬上限直测、回拨时新代次设备可见，web-devices-extra-v2-tests 2 文件 10/10。 |
| 84：recoverable-remove 缺回归 | 插件 Agent 已增真实 Windows 引号路径回收及锁内身份变化拒绝，recoverable-remove-v3-tests 8/8。 |
| 95：schedule 缺回归 | OR 已有两例分别仅日期/仅星期匹配，月名已测；root 新增单值步进跨小时与不可能日期的有限返回，11 项通过。纯字符串 en weekly/cron 文案是低风险覆盖建议，未发现业务错误；保留原标签测试，没有新增逐字镜像实现的断言，也不声称这两个纯文案分支已专测。 |
| 104：coverage 排除 scripts/局部门槛 | 核心 7 个生产 mjs 已纳入 include；53/42 原 src 门槛未降低，root 补明仅可提高。真实子进程执行不自然计入 V8 当前进程覆盖率，整仓最终采集尚待完成。 |
| 113：全局 waitFor 5 秒 | 公共测试配置是正常统一约束，不是已证实业务/测试 bug；原报告也说明移除后多数仍可过。保留全局兜底，确有重型条件的用例已有局部 15 秒等限制；不为 283 处机械重复相同配置。 |
| 122：文件 symlink 能力 QUESTION | Windows 无创建文件符号链接权限时显式能力 skip，Linux 实跑该语义；已有 junction 用例不声称与文件 symlink 等价。保留精确、Windows 限定例外，不扩大到整文件。 |

## rev-remote（9 条）

| 原条目 | 当前处置与证据 |
| --- | --- |
| 7：自动公开入口 | 用户明确要求自动准备统一远程，保留。不是漏改的开关。 |
| 16：LAN HTTP | 真实传输差异，用户要求局域网可用；未冒称加密或恢复 LAN-only 产品开关。 |
| 25：all 后旧配对码 | 兑换、发码、previousCode 复用和无 previous 的 pending 复用共用代次；真实另一进程 all 保留本进程 pending 回归已补。限流历史不清零。 |
| 34：Cookie 7/30 天 | 共享常量统一 30 天；真实已安装 API 写入通过，中间成品证据明确 final:false。 |
| 43：同步磁盘/公开配额 | 无 Cookie/伪签名先拒绝、有界文件身份/解析缓存、公开独立配额。 |
| 52：超限仍触发 end | 超额暂停并中止，阻断 data/end，真实 HTTP 完整 JSON 前缀加超额尾验证无提交。 |
| 61：日志/URL/私有文件令牌 | 移除 stdout 完整令牌 URL，私有文件原子写。启动器自动打开浏览器的一次性 URL 交换仍是授权产品流程，随后干净相对跳转；未宣称抹除所有浏览器历史。 |
| 70：auth0 对外绑定 | 非回环/公开 URL 下显式关闭认证拒绝启动，纯本机选择保留。 |
| 79：Windows mode0600 DACL QUESTION | Unix mode 不能证明 Windows 跨用户隔离。当前没有跨用户读到凭据的实证，也未修改既有用户 ACL；明确未做异用户 DACL 攻击验收。 |

## 验收状态

最后认证代次修改与 npm 事务稳定后已重新生成独立快照和成品：sourceHash `5e8e1948ff57ea6eec8573f4a9542d497b1f1bded06e325fb2dbdc18989c7592`，Build ID `vHQvRhdHkn-_2oDSQbm-A`；最终 build/pack/干净安装/原生调用/真实 API/npm 插件事务全流程及 Chromium 37/37 均通过，详见 `verified-artifact-final.md`，未沿用中间构建。本轮公网专项另实测 tunnel-final.json 1/1、32.14 秒、0 skip；只用临时页面和隔离认证数据，未转发 live 30141。
