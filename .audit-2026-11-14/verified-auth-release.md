# 认证、启动与发布复核

日期：2026-11-14。依据 SUMMARY.md、rev-remote.md、rev-scripts.md、rev-race.md 及当前源码核实后修复。未修改原审查报告；未停止、重启或覆盖正在服务的 30141/.next。以下专项数量有重叠，不能相加为全仓测试数。

## 裁定与修改

| 条目 | 裁定、修改与证据 |
| --- | --- |
| Cookie 30 天/7 天分裂 | 成立。浏览器安全常量统一到 `scripts/web-auth-constants.mjs`，签发器、代理和早期 HTTP 守卫共享。回归直接用真实 `createSessionCookie` 签发的 30 天 Cookie 完成 POST，另测跨 authority 拒绝。 |
| 全设备登出后旧二维码仍能兑换/展示 | 成立。配对条目绑定 revocationEpoch；all 登出清空本进程 pending，兑换、发码与旧码复用同时检查持久化代次，覆盖其他进程尚有旧 pending 和吊销提交期间发行的码。保留有效码优先验证及发码/匿名错误限流，不把限流一起重置。真实另一进程提交 all 后，本地 pending 立即换新。 |
| all 登出的签发竞态 | 成立但原 CRITICAL 夸大。新 Cookie/配对码绑定签发所见 revocationEpoch；即使签发时间晚于截止值，旧代次仍拒绝。每次 all 在锁内严格增加代次，连续同毫秒或时钟回拨也不复用。新版 Cookie 只用代次吊销判断，旧版无该字段才用时间戳，避免未来截止值拒绝重新登录。 |
| Windows 可预测命名管道偷取启动令牌 | 成立。改为随机 nonce 与 HMAC 双向挑战；旧令牌、新令牌都不经过管道。通过认证的完成证明后，启动器重新读取私有本地文件。伪装端点只能收到随机 nonce，伪造的 token 回复不能授权。真实本机 IPC 已测试；不是宣称做过跨用户 DACL 验收。 |
| 令牌文件截断读/启动日志暴露 | 原截断写及完整 stdout 链接成立。令牌文件改为完整临时文件 fsync 后原子替换；启动日志只提示再次运行启动器，浏览器仍自动登录。API 的过期密码登录提示随之改正。文件仍需保存可供同用户启动器读取的凭据；未擅自修改用户目录原有 Windows ACL。 |
| 退出时 read→unlink 删除后写进程令牌 | 成立（rev-race:103）。完整移除退出删令牌文件的钩子，保留私有文件由后续启动原子替换；服务器退出后私有 IPC 不存在，启动器不会把旧文件直接当成已验证登录凭据。没有用额外 inode/内容检查冒充原子 CAS。回归确认发布者退出钩子不再能删除替代文件。 |
| 超额 chunked body 被当成完整前缀执行 | 成立。超额/超时后暂停、标记 aborted、通知错误并阻止后续 data/end；先发送小的拒绝响应再关闭连接。真实 HTTP 回归发送完整 `{}` 前缀后追加超限块，断言下游没有 end/提交。 |
| 认证守卫同步读盘、公共请求挤占私人配额 | 成立。没有 Cookie 先拒绝；伪签名在读取吊销表前拒绝；文件以 inode/mtime/ctime/size 缓存且有文件大小/缓存条目上限，吊销表解析结果一起缓存；公共慢请求独立 8 个名额。覆盖缓存失效、8 个慢公开请求下合法 POST 仍成功。 |
| Content-Length 小报能使同一个请求读到 101 MiB | 按当前 Node HTTP 数据面不成立：Node 解析器按声明分帧，后续字节不会继续成为该 IncomingMessage 的 body；CL+TE 冲突在应用准入之前就被 Node 400 拒绝，已用真实 TCP 回归确认。保留对 chunked 流的计数与上限。 |
| PI_WEB_AUTH=0 仍可直接非回环绑定 | 成立。非回环或设置公开 URL 时显式关闭认证会拒绝启动并提示修正；纯本机显式关闭仍兼容。默认认证与自动远程不变。 |
| Windows cmd start 的 URL 元字符 | 本机 CLI 输入面，原 HIGH 已过高，但代码问题成立。Windows 浏览器通过固定 PowerShell 命令读取环境中的 URL 数据，不再把 URL 放入 cmd 命令文本；测试含 & 和引号的 URL 不进入命令脚本。 |
| Linux 跳过名单漂移/本机固定 bash 路径 | 成立。同步当前 Windows 专项的精确标题，包括原报告漏掉的四个参数化子进程终止标题；删除 bash 选路用例豁免。bash 临时文件夹具由 sandbox Agent 完成，全部平台实际执行。新增源码标题和名单对照回归，新用例不会被整文件豁免。 |
| fd 端到端覆盖总被跳过 | workflow 已准备 SDK 工具，但测试仍只查 PATH，问题仍成立。改为 SDK 公开 getAgentDir 的 bin 路径，然后 fd/fdfind；CI 不再允许该端到端用例跳过。本机此次真实 fd 对照执行通过。 |
| file-lock 半截元数据、残留 recovery、PID 复用与抢子进程记录 | 成立。所有获取、回收、更新、子进程登记、释放共用 OS 短事务锁：Windows 独占 CreateFile 句柄、POSIX flock。持久 mutex 文件不删除，内核在崩溃后释放锁；元数据 fsync+rename。PID 配操作系统创建身份，旧心跳不能用于抢活进程。父释放后仍保留活子进程；旧 release 不能删除新 owner。Windows 真进程测试覆盖并发六个登记者、进程崩溃、PID 身份不符和旧 recovery。 |
| spawn 成功到父记 child 之间被杀 | 成立。新增 lock-child 预加载，子入口在执行前自行登记；若旧 owner 已被替代则入口失败，测试确认不会写标记。Next 打包不能使用构建机 import.meta.url，预加载路径采用运行时 PI_WEB_ROOT/cwd；原生依赖统一通过 runtime-require 从权威安装根解析，不从另一份 checkout 兜底。打包和外来模块 URL 回归通过。 |
| install-build 清单未 fsync/损坏 active 无恢复 | 成立。安装提升持久化完整临时清单并保存独立 last-ready；已有 prior 也先保存。active 损坏仅恢复已保存并重新通过完整性验证的 ready 构建，不扫描/启用任意未提升 BUILD_ID。覆盖故障注入、fsync-before-rename 和损坏恢复。 |
| apply-global 构建失败已覆盖源码 | 成立。先从指定 sourceRoot 在独立 staging 构建，通过后才同步目标 src；构建失败保持全部旧源码。新增失败和 dry/version 回归。没有对真实全局安装执行同步。 |
| bin/pi.js spawn error 一定挂住 | 该静态结论未证实：exitCode 本身可在无引用句柄时退出，不应直接加无条件 process.exit。补了 error 时撤销信号监听；Unix 子进程改独立进程组，退出信号终止所属树。 |
| taskkill 非零被当成功 | 成立。失败或超时尝试结束直接子进程，同时明确拒绝并报告无法确认后代已全部退出；启动器、runner、watchdog 消费错误，不制造未处理 rejection。回归注入 taskkill exit 1。 |
| npm 经 cmd/shell 重解释参数 | 原报告指出当前调用无可达外部注入，属潜在退路。统一定位 npm-cli.js 后用 Node argv 调用，找不到则明确报错；verify-package 同样移除 shell:true 退路。支持官方 Node 布局与 PATH 中 Unix npm 的真实符号链接。 |
| cloudflared 移除 data 监听后管道无人读取挂死 | 不成立，未改 supervisor 的这段逻辑。真实本地子进程在首块后移除 data listener，再写 8 MiB，结果 readableFlowing=true、exitCode=0。Node 已进入 flowing 状态后会继续排空。 |
| 默认自动 LAN/公网、LAN HTTP | 用户已明确要求统一自动远程及局域网可用，保留该产品行为。公网 TLS 与 LAN HTTP 的传输差异仍然存在；不能把 HTTP 称为已加密，也不能把恢复开关当修复。 |

## 验证记录

- `auth-release-second.json`：8 文件，137/137；真实 HTTP、IPC、全设备登出、二维码、启动计划和 Windows 锁。
- `auth-lock-second.json`：18/18；与上组有重叠。
- `scripts-third.json`：3 文件，21/21，包含真实 fd 对照，0 skip。
- `auth-release-final.json`：20 文件，219/220；唯一失败是旧故障注入仍拦直接 owner 文件 write，而实现已改为临时文件 rename。保留失败记录，未覆盖。
- `auth-release-final-v2.json`：修正故障注入后 4 文件 40/40，含新 fsync/恢复检查及最终 HTTP/令牌文件路径。
- `release-pack-unit.json`：38/39；发现 lock-child-env 的构建机 import.meta.url 路径问题。
- `release-pack-unit-v2.json`：修复后 packaging/file-lock/install-build transaction 24/24；与前述数字有重叠。
- `runtime-path-final.json`：packaging/file-lock 20/20；增加外来模块 URL 和权威安装根不能偷偷借用 checkout 依赖的回归。
- `token-exit-final.json`：web-launch-lifetime/web-secret/launcher-local-token 23/23，覆盖退出不删后写者凭据。
- `pair-generation-final.json`：发码/复用/另一真实进程吊销 3 文件 20/20。
- `pair-generation-final-v2.json`：加入同毫秒/回拨单调代次后，7 文件 74/74，0 skip；应用和早期协议 Cookie 校验、Pair、私有启动凭据与真实 HTTP 均通过。`auth-pair-typecheck-final.log` 通过。
- `tunnel-final.json`：本轮真实公网专项 1/1，单用例 32.14 秒，启用 skip 守卫 0 skip。独立临时 agentDir、随机本地端口和官方固定 SHA256 的 cloudflared 2026.10.0，真实公网拉页面/移动 CSS、发码、兑换 303、Secure/HttpOnly Cookie、登录验证及旧码不可复用全部执行。进程退出后临时 fixture 送回收站；未连接 live 30141。
- `auth-release-typecheck-final.log` 与 `auth-release-typecheck-runtime.log`：通过。父 Agent 执行统一的最终整仓验证。
- 最终真实成品构建/pack/干净安装及搬迁后的原生依赖、认证/API 文件写入、插件 install/update/remove 全流程均通过，浏览器同成品 37/37；详见 `verified-artifact-final.md` 及 `artifact-pack-install-final-v2.json`。未沿用中间成品的通过结果。

## 实际边界

- 新锁不会生成半截共享元数据；历史遗留且无法确定 owner 的损坏文件仍原样保留并提示核实后归档，不自动抢未知活 owner。旧 recovery 目录不再影响新协议，也未删除。
- koffi 是现有可选依赖；安全 OS 锁需要它。未安装时明确提示启用可选依赖重装，不退回有抢锁窗口的实现。
- Windows 锁与进程创建身份已实际执行；POSIX flock/Linux/macOS 路径仅代码和跨平台测试设计核对，尚未在本机运行 Linux/macOS。
- 没有声称完成其他 Windows 用户账号的 DACL 攻击测试、真实断电、真实手机/iOS/WebKit 测试。
- apply-global 在构建成功后的源码同步仍是逐文件复制；复制中断会明确报错，已验证的成品保留。没有宣称整棵安装树拥有跨断电原子替换能力。
- 所有认证修复需运行新服务代码才生效；本轮保持正在运行的旧实例不动。
