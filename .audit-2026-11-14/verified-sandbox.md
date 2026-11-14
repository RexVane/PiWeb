# 沙箱、授权、生命周期及项目设置复核

日期：2026-11-14。对象为当前共享工作区；未切换或重启 live PiWeb，未修改真实用户工作区的 ACL / Low 标签。全部真实 SDK 回归使用临时 agentDir 和离线工具，不发模型请求。以下专项存在重叠，数量不相加作为整仓总数；最终构建、安装及整仓门禁由主 Agent 汇总。

## Claude 遗留事项

| 原事项 | 裁定与处理 | 证据 |
|---|---|---|
| 2：pnpm 硬链接使整个工作区不可用，建实例扫描整树 | 问题成立，已拆分。Windows write/edit/mkdir 改为只保护实际目标的目录祖先，使用固定目录句柄和原子替换，不再为普通文件工具启动 Node、遍历整树或授予 ACL。无关 node_modules 硬链接不影响源文件编辑，直接写共享硬链接仍拒绝。shell 的可写根需整树授权，继续拒绝共享硬链接；扫描改为流式枚举、32 个有界并行 stat，未跳过授权对象。没有声称任意 pnpm shell 都能安全放行。 | `atomic-confined-file-operations.test.ts`：真实写入、pnpm 式链接共存、外部内容/ACL 不变、无 readdir；`windows-acl.test.ts`：直接硬链接失败关闭。 |
| 4：不同启动环境下隔离 Node 启动不一致，默认档位不能写文件 | 可复现的预加载环境问题已修：受限命令清空继承及显式覆盖的 NODE_OPTIONS/NODE_PATH，过滤内部启动/构建/进程锁变量及凭据。普通文件工具不依赖隔离 Node 是否能启动。缺少 koffi、非 Windows x64、目录占用等情况仍明确失败并给出行动提示，readonly 不因此获得写权限。不能据此断言 Gemini 原机器的所有环境差异都已复现。 | `sandbox-env-final.json` 23/23；`confined-file-operations-fallback.test.ts`、原生文件 5 项。 |
| 5：codemode 嵌套不消耗一次性授权 | 问题成立，已修。包装传给 SDK 的会话 write/edit/bash 定义自身，覆盖内部工具注册表与 codemode 克隆；完整参数匹配后同步消费，仅为当前执行建立授权上下文。再次执行同动作会拒绝，不继承其他嵌套调用的授权。 | `agent-nested-permission.test.ts`：真实 SDK extension executeTool 与 codemode 均验证首次成功、再次失败、used 审计一次。 |

## rev-sandbox / rev-core 逐条

| 报告位置 | 裁定与处理 |
|---|---|
| rev-sandbox HIGH confined-file-operations:57 / SUMMARY full 绕过 | 报告把 full 的设计语义当成工作区档边界：用户明确批准 full 后允许按宿主用户权限写工作区外，不能仍要求外部目标一律拒绝。保留此语义。真实路径规范化不一致已修：闸门现在与 SDK 一致识别 `/c/`、`/mnt/c/`、`/cygdrive/c/`；workspace 档仍拒绝 junction 越界，新增原生句柄保护实际写入。未声称 full 是 OS 隔离执行。 |
| rev-sandbox HIGH windows-acl:333 / SUMMARY 未删除特权 | 报告核心事实错误：`CreateRestrictedToken` 的 `0x1` 是 `DISABLE_MAX_PRIVILEGE`，`SANDBOX_INERT` 是 `0x2`。原代码已经使用正确标志，本次改为具名常量避免再次误读。保留最小权限和 LPAC；没有添加所谓修复来重复/破坏该设置。官方依据：[Microsoft CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)。普通 token 的跨目录、跨实例和 DACL 负向测试已真实执行；未运行提升 UAC 后的 Backup/Restore 攻击链。 |
| rev-sandbox MEDIUM MCP readOnlyHint | 这是受信任扩展/服务器的声明边界；同进程扩展本就可直接调用宿主能力，不是靠注解实现 OS 隔离。保留已配置 MCP 的只读声明语义，在隔离文档明确限制；没有一刀切禁用用户已经配置的 MCP，也未声称能够约束恶意宿主扩展。 |
| rev-sandbox QUESTION ShellExecute broker | 报告未证明容器外进程出现。保留 LPAC + 禁 breakaway 的 Job Object，真实 detached descendant/timeout/abort/dispose 测试通过。未自动触发 UAC、关联程序或真人桌面链路，故不把该 QUESTION 说成已复现漏洞或已完整实测排除。 |
| rev-sandbox QUESTION 包 Temp 延迟创建 | 既有测试覆盖不同实例临时目录拒绝；本次进一步验证 readonly 自己的系统临时目录在进程恢复后也不可写。最终结果见下方 Windows 专项证据；不推断其他 Windows 版本均已验证。 |
| rev-core MEDIUM 冷 Managed 无数量上限 | 主 Agent 增加独立的 64 条冷池上限与 LRU。本区新增实际 SDK 回归：创建 70 条、最旧但有 viewer 的保留，其余按 LRU 淘汰。 |
| rev-core MEDIUM growth rev-list 8MiB | 由主 Agent 修复并提供其专项证据，本区不重复计为自行完成。 |
| rev-core MEDIUM retention 快照取消归档竞态 | 由主 Agent 在登记表锁内复核后删除。本区只读检查调用链，删除不重新进入同一 workspace 锁，未发现本轮新增再入死锁。 |
| rev-core MEDIUM 升权前缀两处时间点不一致 | 已修：构造工具定义时捕获 shellCommandPrefix，SDK 与授权执行包装共享该值；设置随后变化不改变已存在工具的执行前缀。真实 SDK 回归确认批准仍生效。 |
| rev-core QUESTION 权限持续变化导致无限重评 | 已修：门禁递归和执行前重评均限制 4 次，持续变化则拒绝。新增每轮读取都切换 customActiveTools 的确定性回归，有限时间内拒绝且不写文件。 |
| rev-core QUESTION shutdownFromExtensionCommand | 主 Agent 补忙态检查与 catch，并让 dispose 返回可等待 Promise。本区回归真实延迟 shutdown hook：重复 dispose 返回同一 Promise，同路径 ensure 等旧 hook 完成并读到其追加条目；用户 bashActive 时新 prompt 拒绝。 |
| SUMMARY shell-selection 硬编码 D 盘导致永久 skip | 已修为临时 fake bash.exe 路径注入，测试选择与 script transport，不伪称执行了 Git Bash。新平台标题已同步给 skip 门禁维护者。 |

## 追加 API / 设置边界

| 原事项 | 裁定与处理 | 证据 |
|---|---|---|
| 图片 realpath 检查后，祖先被换为 outside junction | 问题成立，已修。打开前后比较 realpath、dev/ino、打开句柄与当前路径身份；校验后换目录不会把外部 PNG 读出。 | `workspace-image.test.ts` 注入真实 rename + outside junction，外部有效 PNG 含私密标记，响应 400。 |
| /api/files 非对象 JSON body | 原 null 导致 TypeError 500。已统一拒绝 null、数组、字符串、数值、布尔为 400。 | `files-service-upload.test.ts` 5 种 body 回归。 |
| rev-api MEDIUM 项目 .pi/settings.json junction | 问题成立，已修。项目 `.pi` / settings.json 不得为链接，settings.json 不得共享硬链接；有界读取校验打开句柄身份；Windows 写入从盘符根固定全部祖先，锁目录、临时文件、原子替换都在保护期内。读取不存在的项目设置不创建 `.pi`，global agentDir 的明确配置别名仍可用。 | `project-settings-boundary.test.ts` 5 项：UI/SDK 双入口链接拒绝、硬链接拒绝、缺省读取/JSONC/BOM、global alias、真实提交期目录改名被拒。 |
| 同步 SDK settings contract 与 HTTP 等锁 | 同步 helper 不等待异步持锁方；写入回调在同步 cross-process 锁内重读/合并/提交。HTTP 遇 ELOCKED 时在不持文件锁/目录句柄的状态下让出事件循环后有限重试；原同进程释放及独立进程释放回归均通过。同步 native koffi 用通用 runtimeRequire、实际调用时解析运行安装根，最终搬迁安装由主 Agent 验证。 | `pi-settings.test.ts` 原 14 项全部通过；`project-settings-final-v3.json`。 |
| rev-api QUESTION resolveSessionPath allowPending 返回 alias | 未直接采用“存在即返回 realpath”的建议。SDK 新建 Session 和 Managed 按配置的 agentDir 别名路径登记，只改解析返回值会在首次落盘后产生第二个池 key / 重复热 Session。原报告需本地替换会话根祖先的竞态，未证实远程触发。保留现有 alias 语义，并将此边界明确留在台账，不声称已通过改一行完整解决。 |
| 自动公网/LAN 暴露 | 用户已经明确要求默认准备远程、一个动态二维码、局域网和公网统一使用。本区不恢复开关，不把显式产品要求当作待确认缺陷。LAN HTTP 与公网 TLS 的差异仍存在。 |

## 主 Agent 改动的只读复核

- 指出并由主 Agent 修复：自动化会话已被其他入口 dispose 后，abort 永久失败导致任务一直占运行槽；现先 join dispose 并退出停止循环。
- 指出并由主 Agent 修复：批量 claim 后部分启动及 releaseClaim 均遇暂时存储失败，剩余 claim 永久占槽；现先记录全部 pending releases，单条启动失败继续处理，finally 和后续 tick 重试释放。
- 对本轮 automations/store、retention/workspace-store 新串行路径未发现其他确定的新增挂起或锁再入问题；不是全项目无缺陷保证。

## 专项证据

| 文件 | 结果与用途 |
|---|---|
| `sandbox-verification.json` / `.log` | 14 文件，152 passed / 0 failed / 0 skipped；Windows 实际隔离、原生文件、权限、冷/外部会话等联合专项。 |
| `sandbox-permission-final.json` / `.log` | 后增持续策略变化上限后，嵌套权限 4 + resource isolation 32，共 36 passed。 |
| `sandbox-env-final.json` / `.log` | PROCESS_LOCK / NODE 环境修复后的 Windows 23 passed。 |
| `sandbox-env-final-v2.json` / `.log` | 增加 readonly 自己的进程恢复后系统 Temp 负向断言后，Windows 23 passed / 0 failed / 0 skipped。该机器上未复现 rev-sandbox:500 猜测。 |
| `managed-lifecycle-final.json` / `.log` | 冷池 LRU、延迟 hook 同路径重开、重复 dispose、bashActive，共 3 项通过。 |
| `files-boundary-final.json` / `.log` | 普通文件边界相关 5 文件、41 passed。 |
| `files-body-final.json` / `.log` | 修正 it.each 空数组数据表达后的 5 种 body 通过；其余 12 项被 -t 过滤，不作为跳过门禁证据。 |
| `project-settings-final-v3.json` / `.log` | 项目设置 5 + 原设置 14 + 原生文件 5，3 文件 24 passed / 0 failed / 0 skipped。 |
| `prompt-settings-regression.json` / `.log` | 整仓发现旧 cwd 缓存残留后追加修复：已删除工作区的 SDK 只读加载返回空设置，写入仍拒绝且不重建工作区。提示词 13 + 设置作用域 7 + 项目边界 6，3 文件 26 passed / 0 failed / 0 skipped。 |
| `sandbox-typecheck-final.log` | 最近类型检查 exit 0；最终共享工作区类型门禁由主 Agent 再运行。 |
| `sandbox-typecheck-regression.log` | 上述已删除工作区处理修复后，类型检查 exit 0。 |

中间失败记录（project-settings-final / v2、较早 Windows 并发检查的未处理拒绝）保留用于过程追踪，不算通过证据。最终已修正失败断言或代码后再运行上表对应专项。自建测试目录结束后送回收站；没有删除或重置用户文件。

待主 Agent 统一补充：当前完整工作区的 coverage、typecheck、隔离生产 build、真实 installed smoke、移动安装/pack 验证。Linux CI、提升 UAC 和真实手机不在本机实际验收范围。
