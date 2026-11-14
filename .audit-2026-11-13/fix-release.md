# Build / update / launcher / HTTP-boundary 修复记录

2026-11-13，针对审计报告 v2；不重启或停止既有 PiWeb，不变更实际 ACL，不删除既有 release/cache。

| 条目 | 处理 |
| --- | --- |
| P0-3 | 新增 Node HTTP preload，在 Next clone body 前验证 Host / Origin / Cookie / 吊销状态；未登录的 Content-Length 和 unfinished chunked 请求立即 401，不等正文。Expect:100-continue 也先验证。JSON 单请求12MiB、并发JSON额度48MiB，所有正文总额度128MiB、最多32个请求、独立上传最多1个。普通正文15秒期限，multipart 120秒。原始 Next启动在默认认证开启而缺少preload时拒绝，build/typegen与显式auth=0不受影响。 |
| P1-23 | 构建完成后生成全量runtime文件 SHA256 / size inventory；启动与解包验收检查每个文件，必需清单内标记inventory契约，inventory被移除也拒绝。旧构建额外检查app route及static chunk引用。 |
| P1-24 | install-build复制到新不可变release，完整验证后原子提升active；失败返回failed，不移动/删除/覆盖原.next。apply-global复用force构建，移除旧.next让位逻辑。新增磁盘复制失败回归。 |
| P1-25 / P2-101 | building/failed保留previous complete ready；旧.next完整时可继续启动。hasProductionBuild实际验证选定产物，active文件存在不代表可用；缺目录/必需文件给出可操作重建提示。 |
| P1-26 | 所有平台都检查实际cwd与APP_ROOT；在运行安装内时不允许npm就地替换，只给手动停止后的安装命令。 |
| P2-97 | agentDir实例锁覆盖慢启动窗口，已有实例未ready时等待，不递增端口启动共享数据的另一实例。 |
| P2-98 | 只计新inventory-owned inactive完整release，默认上限10；新输出旁路owner marker记录building/ready/failed，失败/中断输出独立上限3。历史无marker目录完全保留且不计。超过上限只拒绝新构建，提示将指定目录及owner文件移到带日期的backups/files并追加INDEX，不自动删除。 |
| P2-99 / P2-100 | prepublishOnly增加构建及真实tarball安装验证；Linux/Windows CI都跑verify:package。build wrapper统一生成inventory，publish workflow调用同一构建。 |
| P2-108 | npm/git使用系统必要环境白名单，去除launch token、secret、NODE_OPTIONS、TLS注入和npm环境配置；npm install忽略第三方lifecycle scripts，并显式固定npmjs及两官方scope registry。版本结果要求完整合法semver。 |
| P2-109 | 更新/安装构建共享owner锁；读取PID并安全恢复已死owner，仍活跃owner/被跟踪构建子PID不回收，恢复竞争另行串行保护。 |
| P2-114 (launcher部分) | launcher信号终止自己启动的整个命令树，Windows使用taskkill /T /F，POSIX使用独立进程组；pi.js转发平台适当信号并处理启动错误。remote supervisor部分另行处理。 |
| P3-27 | registry结果不再截取第一行放过尾部垃圾；semver完全锚定，拒绝空段/数字前导零/超大core数，超大prerelease数字用BigInt比较。 |

上传边界与root协调：`/api/files/upload` 从proxy matcher精确排除，避免Next clone大multipart；该路径仍先在preload鉴权及流式上限101MiB（100MiB内容+multipart开销），并由新route再次鉴权和校验100MiB内容。旧JSON/API通道保持12MiB。

已验证：真实socket unfinished-body/Expect测试；signed-cookie互操作；chunked及aggregate额度；missing hidden chunk、same-size内容变更、inventory移除；旧ready回退；dead owner / live child锁恢复；安装copy失败不影响旧目录；坏active自愈；默认认证原始Next入口拒绝；真实npm配置确认两个scope的CLI registry覆盖配置。最终本区域回归：11份128项全部通过（22:18:38开始，30.33秒）。

未在本子任务运行真实当前目录production build或npm安装，不触碰live产物；完整构建和实际artifact验收由root统一在隔离目录执行。跨平台CI代码已补，本机未代替Linux跑CI。

末次补验（23:41）：HTTP/HTTPS 真 TLS 的 unfinished body / Expect 401、LAN/public入口本身的同款guard、preload与独立proxy Expect handler互操作；内容101MiB wire / 100MiB route、JSON 12MiB、JSON并发48MiB、全局128MiB、独立上传并发1、上传120秒。当前新上传route用原始二进制流，前文multipart指历史通道，实际route不会进入Next proxy body clone。

更新动作会重读当前httpProxy设置，清除旧settings来源的启动代理并恢复原继承代理；轻量读取放update-environment，避免将launcher的import.meta.url烘焙进服务bundle。npm pack/验包安装也使用白名单env和官方registry。安装最终owner metadata在active提升前完成，metadata写盘失败不会切换active。自救命令修为实际scope `npm rebuild -g @rexvane/piweb`。

追加回归：remote/HTTP/update9份117项通过；IPC/launcher/install4份54项通过；packaging/update/launcher/IPC4份85项通过；pi-runtime+packaging2份27项通过（明确验证registry/ignore-scripts新参数及非法精确版本安装前拒绝）。这些是分批回归，存在重复测试，不相加作为总数。最新全量typecheck已通过。

正式成品验收现在强制隔离agentDir与auth=1：IPC取有效启动token、单次兑换、device cookie metadata、匿名unfinished body/Expect头部401、JSON>12MiB 413、uploadwire>101MiB 413、声明内容>100MiB 400、32KiB带cookie真实二进制上传并核对落盘内容，再测首页/首屏API。脚本已通过语法校验；正式Next生产构建/实际解包运行由root等全量回归绿后触发。最终同盘隔离stage为 `D:/AIApp/.piweb-audit-build-XbNJ73`，在仓库外避免根tsconfig递归扫描，不会写live active或重启live。

第一遍隔离生产构建已通过（328 sealed runtime files），但root随后追加模型UI当前会话key和API500脱敏，该stage不是最终源码，不据此宣称正式验收完成。最终freeze后重拷并重新build，再执行installed/pack。raw socket验收工具增加close失败分支，服务器未返回HTTP就断开时明确失败而不挂住。

后续阶段build `wgrQ4h0tdIM2hIIdYVPDi`（328 sealed files）与真实生产runtime smoke已过：单次IPC登录/metadata、匿名unfinished/Expect预鉴权、JSON12MiB、上传101MiB wire/100MiB内容、32KiB真实上传落盘、首页和6个首屏API；临时server正常结束。证据 `production-smoke-stage1.json`。root随后撤回freeze补P1-12/P3-22/P3-31文件区域；此结果明确为阶段构建，最终仍要等文件源码与浏览器临时server停止后重copy/rebuild/smoke/pack，不混作最终成品。

## 最终成品验收（2026-11-14 01:40）

最终全部区域冻结后，735 份源码/config/资源重新复制到仓库外 stage，逐文件 SHA256 核对；独立生产构建通过，333 个 sealed runtime files，buildId `V8EkQiPStS7Rma76LwdHE`。构建后及全部成品验收后工作区这 735 份源 SHA 均保持一致；stage 仅由 Next 自动重写 `next-env.d.ts`，已在 source snapshot 中单列 generated 记录。证据：`build-snapshot-final.json`、`build-final.log`。

真实 production smoke exit 0：IPC 当前启动凭据一次性兑换、设备 cookie metadata、匿名 unfinished Content-Length/chunked/Expect 立即 401 且不发送 100 Continue、JSON 12MiB 与上传 wire 101MiB/content 100MiB 边界、32KiB 真实带认证二进制上传及落盘核对、首页和 6 个首屏 API；临时进程正常退出。证据：`production-smoke-final.json`/`.log`。

真实 npm pack 与解包 inventory 校验通过，再将该 tarball 安装到全新空 global prefix（官方 registry、omit dev、ignore scripts），真实 Pi 1.5.2 SDK、安装后的正式生产启动及同款认证/上传/首页 API 验收均通过。Tarball `rexvane-piweb-0.3.30.tgz`，1072 文件、4,766,332 bytes，SHA256 `17f14ecb9da9e53718f92f2351d9957452c3e075a0e1d5422f713fb46d99615a`。证据：`pack-install-final.json`/`.log`。临时 pack、安装目录及凭据留在本次 stage 下，收尾按用户规则回收，不触用户既有 release/cache。

data Agent 对同一 build 的真正浏览器验收 36/36 通过，含新增长 Git diff 在桌面/移动端横向滚动、可视窗口/底部可达、44px 触控、首字不被菜单遮挡与原生 SSE 故障恢复/心跳；证据 `browser-final.json`/`.md`。该浏览器临时服务已退出并核验。正式全量测试/覆盖率由 root 唯一执行，本段不替代其结果；Linux/远端 CI 仍不冒充本机已运行。

root 唯一最终全量完成后，已将本次 stage 收尾送回收站：先单独回收 `node_modules` junction，并核验真实工作区依赖目录存在、Next package SHA 未变；再回收无外部链接的 stage，自建目录 3465 个、活跃验证进程 0，原 stage 不再存在。735 份源码 SHA、333 份完整 runtime inventory、tarball SHA 与验收记录均保留在本审计目录；`build-inventory-final.json` 为完整构建清单，`temporary-cleanup-final.json` 记录明确路径/目标保护/回收位置。`pack-install-final.json` 保留原临时路径溯源并标记为已随 stage 回收。未停止或重启 live PiWeb，也未清理用户既有 release/cache。
