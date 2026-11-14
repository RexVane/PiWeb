# 权限、文件、Git、工作区与设置区域最终编号核对

更新：2026-11-14。原报告 v2 编号保持不变；以下区域专项不替代总审查的整合检查。源码已可冻结，未提交、未重启服务。

| 编号 | 核对结果 | 修复与验证 | 限制或交叉归属 |
|---|---|---|---|
| P0-2 | 当前沙箱触发机制闭合 | Windows LPAC AppContainer 每实例独立 SID；readonly 不获 Modify，原完整性标签不改；真实 formerly-Low 根、跨会话 SID、双实例释放、目录读写隔离测试。 | 历史版本留下的用户 Low 标签未擅自重置；旧标签对其他 Low 进程的影响不属于本次可安全自动恢复的状态。 |
| P1-6 | 新增全局 Low 授权机制闭合 | 只增撤自身 SID，保留原标签和其他 SID；实际隔离/原标签保存测试。 | 用户原有 Low 标签保持不变，不能把未知原始 ACL 一律改回 Medium。 |
| P1-7 | 闭合 | readonly 无可写私有 temp；workspace 仅显式物理根和自身 temp 可写。LPAC 不承接 ALL_APPLICATION_PACKAGES 的宽泛权限。实际外部用户文件/目录/DACL 改写拒绝测试。 | 模型读取依现有读取能力；网络启用是产品现有能力。 |
| P1-11 | 后端闭合，UI 与父共同 | 坏 JSON/无效已知字段读时保留原件并返回明确错误/最后有效记录；首次修改 verified copy + INDEX，再恢复 last-good 或明确重建。持久 recovery/数量/备份文件名及 warning，POST 立即回报；I/O 错误不重建。workspace-store 17 项与路由矩阵回归。 | 重建没有伪称恢复别名/归档/置顶；warning 展示由父 hook/sidebar 接线。 |
| P1-12 | 闭合 | 磁盘与 Git 快照共用有界严格解码器：UTF-8 BOM、UTF-16LE/BE BOM 正确识别，UTF-16 NUL 不再误判二进制；截断的多字节字符/代理对保留到完整字符；非法 UTF-8、GBK 与 UTF-32 明确 unsupported，不再静默 U+FFFD 乱码。查看器显示编码提示并允许下载原文件。真实磁盘编码5项、快照编码新增2项及既有读diff1项通过。 | 无 BOM 的未知编码不猜测、不自动转码；提供原文件下载和转换 UTF-8 的明确提示。 |
| P1-13 | 闭合 | merge 用 first-parent 产生普通 unified patch，冲突页用普通分支 patch，不再把 combined diff 判成无差异；真实冲突/合并 Git 仓库回归。 | — |
| P2-1 | 闭合 | Job Object 管整个进程树，timeout/abort/dispose/shell 退出清理子孙；匿名 stdout/stderr 管道及 allowlist。真实后代四种终止路径与输出上限测试。 | — |
| P2-3 | 交叉闭合 | 物理根/junction/既有硬链接校验，实际写桥由 LPAC 执行，外部目标无本 SID 权限；真实 junction/硬链接/外部对象测试。 | 父负责 confined-file-operations 与 permission-gate 同步/原子接线。 |
| P2-4 | 闭合 | key 含 session/cwd/mode/extraRoots/shell；独立 scratch、generation；正在释放的实例从池移出后仍有 releases promise，重复 release/reset 等到真实 cleanup。Windows manager 6 项含新 release-join 回归。 | 父同步修 disposeSessionPath 的缺失实例等待与 SDK fixture afterAll 等待。 |
| P2-5 | 闭合 | 流式匿名管道，读出即计总字节，8 MiB 总输出上限，不再读落盘日志；实际 noisy command/大输出测试。 | — |
| P2-6 | 闭合 | x64 平台检查与 actual startup probe，错误原因可见，能力不可用 fail-closed。真实支持探测及非物理/缺失根回归。 | 原生 MSYS/Git Bash 不满足 LPAC 兼容，受限档回落 cmd，full 档保留原 shell。 |
| P2-7 | 闭合 | spawner/prepare 失败和已取消 signal 都清理自身脚本；Job/handle/backend 关闭；scratch 对 Windows 短暂 EPERM 有有限 retry。真实 spawner failure 与 scratch 释放测试。 | 自身运行时临时文件清理不删除用户文件。 |
| P2-9 | 交叉闭合 | 既有硬链接拒绝建 writable sandbox，不给外部硬链接目标追加权限；内核拒绝通过只读对象建可写硬链接。真实文件内容和 ACL 不变测试。 | 父负责应用闸门层。 |
| P2-10 | 文档限制已补，实机攻击链未验收 | docs/workspace-isolation.md 明确受限实现、兼容性与未保证的 UAC 行为。 | 未实际弹 UAC/点击“是”或测试安全桌面攻击链；不能标成已实机证实 UAC 无法突破。 |
| P2-34 | 闭合 | sessions GET 不再注册 cwd 写盘，响应内合成 CLI 工作区；只读无锁无重写测试。 | — |
| P2-35 | 闭合 | 会话清理 recoverableRemove + INDEX，retention=0 关闭、dry-run 保留；前跳/倒退墙钟异常跨多个 interval 持续暂停。retention 12 项。 | 未擅自清理用户 backups；早期测试有少量恢复副本留在用户 backups，已告知父。 |
| P2-36 | 后端/sidebar 闭合，hook 与父共同 | 服务端 q/归档 scope/offset/limit/nextOffset；sidebar load-more、服务端结果不再本地二次过滤、本地搜索含归档/完整 cwd。API/sidebar 回归。 | 父负责搜索请求竞态、URL 和多标签流程。 |
| P2-41 | 闭合 | canonical realpath 5 秒 TTL/1000 条有界缓存，写路径 fresh；CLI symlink cwd 与 real root 身份统一。workspace-store/session 真实链接回归。 | — |
| P2-42 | 闭合 | 纯 rename/空文件/元数据变化显示明确说明，避免声称无变化而混出正文。查看器回归。 | — |
| P2-43 | 闭合 | 文件/目录刷新、关闭重开重读、cwd key 防串内容；项目树刷新连接 growth.refresh。查看器刷新/请求竞态回归。 | 父负责共享 hook 流程；不把未改变的 snapshot 保留当作磁盘当前状态。 |
| P2-44 | 闭合 | snapshot cache 8 MiB/32 条/60 秒 TTL/LRU，按字节淘汰，刷新绕过。实际大 snapshot 淘汰回归。 | — |
| P2-45 | 闭合原放大器 | check-ignore 仅当前 raw sorted 2000 条页，offset 不再因忽略项跳掉文件；真实 large directory/all-ignored pages 回归。 | readdir 与排序仍需整目录；未宣称分页把全部服务端成本变成只读当前页。 |
| P2-47 | 交叉闭合 | 保持父 resourceLoaderIsStale 的 2 秒指纹 TTL，本区域修 JSONC settings 额外源发现；真实 resource/settings 指纹回归。 | 不把每个受保护图片重新全量指纹扫描作为必经流程。 |
| P2-48 | 闭合 | untracked 用完整文件展开，不再将未跟踪目录当文件点开。真实 Git 回归。 | — |
| P2-49 | 闭合 | 非仓库与 Git 拒绝/损坏错误区分，unknown/error 而非“不是仓库/干净”。实际坏 index 回归。 | — |
| P2-50 | 闭合 | diff stdout 流式保留 400 KiB 预览，完整 numstat 单独读取；真实 >8 MiB 文本 diff 不再 500。 | 大 diff 仍有明确预览截断。 |
| P2-51 | 闭合 | 清除 inherited GIT_*，ceiling 限制根，嵌套普通目录不串父仓库；真实 parent-repository 回归。 | — |
| P2-52 | 闭合 | 显式禁 fsmonitor/untracked cache/hooks/pager 配置执行，清除 inherited GIT_*；真实仓库 fsmonitor 脚本未执行。 | 正常 Git 仓库读取仍依赖系统 Git。 |
| P2-86 | 交叉闭合 | global/project 编辑值与 trusted effective 分离；httpProxy/cacheWarming 全局独有，项目 PUT 拒绝。SDK public fromStorage 使用 JSONC adapter，BOM/comments surgical preservation。reload drainErrors/extensions errors，已保存但刷新失败 applied + warning。scope/真实 SDK/热刷新/插件格式回归。 | 父 GeneralSection 请求竞态、trust/warming 禁用、活动会话 AggregateError/warning 展示共同完成。 |
| P2-115 | 部分优化，首次无索引仍有成本 | session index v5 首尾 prefix/inode 检查、重启落盘索引复用、append 尾扫和 incomplete delimiter 重试；64 KiB 流读，消息摘要 300 字。非 Git 文件索引 2 秒/16 条有界缓存。 | 首次无有效 index 为精确计数仍完整扫描 JSONL；未重跑原机 65 个会话/92.4 MiB 冷启动规模基准，不宣称彻底消除首次全量成本。 |
| P3-1 | 闭合 | 不再用 markMedium 覆盖工作区原有完整性标签；LPAC 只增撤自身 SID，真实 formerly-Low 根及原 ACL/标签保存回归通过。 | 历史用户 Low 标签保留；不能臆测原值并统一恢复 Medium。 |
| P3-2 | 凭据继承闭合 | readonly/workspace Native env 过滤 API_KEY/ACCESS_KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL 字段、PiWeb 认证与构建锁，大小写与显式覆盖同处理。真实 Node 进程无法读取 ANTHROPIC/OPENAI/AWS/AZURE/GITHUB 等测试凭据；PATH/proxy/普通配置/空值保留。 | full 原本走宿主 local 后端，不经受限 env 过滤，保留该档位授权的本地 CLI 兼容；readonly temp 不可写是当前零写承诺，文档明确。无用户要求保留受限档模型密钥；先前保留选择已纠正。 |
| P3-3 | 闭合 | resetSandboxStateForTests 先 await dispose/release promise，再重置状态；重复释放等待真实 cleanup。sandbox manager fixture 使用独立临时 agentDir，收尾回收，未向真实 ~/.pi/agent/web-sandbox 写入。实际 manager6项含 release-join 回归通过。 | 自身临时 fixture 不备份、不记录用户 INDEX，使用回收站清理。 |
| P3-4 | 闭合 | sandbox/config 输入与目录边界用 BoundaryError，realpath 非 ENOENT/ENOTDIR 的实际 I/O 错误保留；PUT validation/JSON 400，I/O 500，不再 400:400。新错误 API 矩阵及配置 6 项通过。 | — |
| P3-18 | 后端闭合，前端归档确认由数据区域接线 | sweep 每项 try/catch，failures 含阶段/错误码/是否已移除；失败不提前列入 deleted/missing，其他项继续。globalThis 唯一 scheduler、running promise 禁止重叠，原时钟异常持续暂停保留。真实拒绝一个文件仍清另一个；模块重新载入与长 pending sweep 的单一调度器回归通过。 | getArchivedEntries 整个注册表不可读时仍明确整轮失败；不能在无有效归档列表时猜测删除。 |
| P3-20 | 源码闭合 | Git 显式 i18n.logOutputEncoding=UTF-8，与解码口径一致；Unicode 提交信息回归。 | 依 Git 可识别的 commit encoding；未新增无 encoding 声明的原始 GBK commit fixture。 |
| P3-21 | 闭合 | GitPanel 实际使用的 DiffView 超400行窗口化，仅高亮可见行及 overscan；18px固定行高、400px视口，white-space:pre 与 overflow:auto，保留多文件/分段头。真实组件2002行diff仅渲染少于80行，滚动换窗口及尾部clamp回归通过。FullDiff 既有窗口化保留。 | DOM回归验证滚动窗口和样式契约；实际浏览器水平滚动几何由总验收检查。 |
| P3-22 | 闭合 | 查看器复制全文/截断预览/原始patch按钮与准确标签；GitPanel复制原始patch保留文件/hunk头和 +/-。两种diff的ASCII符号可选，行号不可选。新增下载GET/HEAD按固定经校验handle流式返回完整原文件，每次最多64KiB，Cookie/Host/Origin/吊销认证、Range、穿越/junction与cancel/abort/响应前异常关闭通过6项回归；查看器导出6项（含同snapshot差异→内容复制切换）通过。 | 下载明确标“下载当前文件”，不把当前磁盘内容称为历史快照；不支持编码仍可下载原始字节。 |
| P3-26 | 自有路由闭合，总矩阵由父确认 | api-error 隐藏服务端路径、保留明确 validation/OS code。files/git/workspaces/pi-settings/sandbox/security/fs/cold session/DELETE no-store；sessions 列表 private,no-cache + ETag。原路由矩阵 20 项、新安全/权限/目录矩阵 8 项、保存/刷新失败 applied 回归。 | 其他 500 路由由父/其他区域核对，不单凭本区域声称全站 15 处闭合。 |
| P3-31 | 闭合 | Git ls-files改spawn流式NUL分隔收集：20k条目/4MiB/15秒上限，stderr与单条路径有界；到条目/字节上限保留Git来源并标truncated；超时/失败走有界opendir磁盘扫描，明确warning说明候选不完整及.gitignore语义不保证，输入与快速打开保留warning。真实Git上限/超时3项、坏index回归、warning缓存1项通过。 | 非仓库正常disk退路不伪称Git失败；失败disk可能含.gitignore忽略项，界面明确说明。 |

## 本区域新增实质回归与修复

- cold readSession 现在复用分页历史，不启动 agent，含被压缩的真实记录和经认证 images URL；原 JSONL 不改。新 API 本身由会话区域负责。
- 同 ID/同尺寸元数据重写旧 Managed 不刷新：新增 SessionDiskTracker，stat/identity/4 KiB checkpoint samples；普通 append 64 KiB chunk、每次 8 MiB 工作上限、最多 1 MiB 行缓冲，大行保留 8 KiB 头与持久 ID 判断；未完成 UTF-8 行/预算跨次续读。busy 只提示一次、空闲才 reopen，保留现有运行数据。
- 实际导入 Claude→Codex 来源改写回归修前失败，修后 session-import-service 19 项全部通过。cold history 2 项、external-session-write 原 7 项 + 新 active rewrite 项通过；SessionDiskTracker 5 项资源/重写/巨行/半行测试通过。
- 孤儿原附件清理走 verified recoverable copy/INDEX；上传 inventory 1 万/200 candidates，会话 inventory 1 万/深 32、总 256 MiB/5 秒限制。不可读、超预算、链接、并发改写都保留，删前核对 inode/mtime/size；retention=0。upload 12 项真实内容/扫描边界回归通过。
- Windows 受限子进程 environment 清除模型 API keys、其他凭据及 PiWeb auth/password/secret/build-lock credentials，显式 overrides 也过滤；PATH、代理、普通配置与空值保持，full 本地执行兼容保持。真实环境输出回归。

## 验证末状态

- 最新 tsc --noEmit：exit 0。
- 最近真实追加验证：cold/import/external/tracker 4 文件 32 项通过；active rewrite/large own row 2 项通过；最后 tracker5 + cold2 + actual Windows sandbox manager6 = 13 项通过，无 sandbox disposal stderr。
- workspace/自有路由矩阵 36 项通过，随后 known field corruption 新项通过（workspace-store 当前17项）。
- 最后新增安全路由 8 项 + 真实 LPAC 凭据环境 1 项通过；配置 6 项通过。retention 原12项及新增失败隔离均已验证，单调度器/模块重载 1 项通过；时钟回归因加入不重叠 guard 而补“等首轮完成”屏障后通过。最新专项8个API+3个retention目标共11项通过，tsc exit0。
- 最后文件补修：download6 + encoding5 + bounded-index3 = 14项通过；files-service13、viewer-refresh8/dir17、GitPanel-races6/areas6、diff-parser5、workspace-files3、GitPanel窗口1、viewer-export6 = 65个互异专项全部通过。新增export编码提示断言曾使用不存在的文案，改为实际文案后export6绿；最近完整tsc exit0。files-service原有fixture硬删除已改回收站清理。
- 此前对应专项已绿：Windows ACL 20 项；其他 sandbox config/escalation/shell17项；设置基础14、effective scope6、refresh3；viewer 原/新共25；sidebar 原15及搜索分页专项；retention12；upload12；Git/files及session reader/API真实写入专项。父将运行整合全量，不重复全量。
- 未修改真实用户目录 Low 标签/ACL，未清理用户 backups；没有提交或重启服务。自身测试临时目录使用 recycleFixture 回收。
