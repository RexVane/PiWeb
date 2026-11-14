# 2026-11-14 主任务核验与修复记录

此文件核对当前工作区，保留原 SUMMARY.md。专项数量有重叠，不作为整仓测试总数。最终整仓回归、构建及安装验收另见 verified-summary.md。

## Claude 留下的五项

1. **缺少 @emnapi/runtime：确认并最小修复。** 修前 Windows clean `npm ci` 本身成功，但从 sharp-wasm32 的消费位置实际解析 runtime 得到 MODULE_NOT_FOUND；不能用安装退出码证明依赖完整。仅新增顶层 runtime 1.11.3 的 11 行元数据（官方 registry/integrity），没有把本轮改动扩大为 800 行重生成。修后另一全新目录实际 npm ci 成功，消费者可以解析 runtime。证据：lock-ci-before.log、lock-ci-clean.log、lock-ci-final.log；原工作区 node_modules 未重装。
2. **硬链接与整树扫描：确认。** 文件编辑改为针对目标的原生目录保护，不再创建命令隔离实例/扫描全树；pnpm 式硬链接依赖不影响源文件编辑。命令执行仍拒绝有共享硬链接的可写根，未移除这项安全边界。真实 Windows 证据见 verified-sandbox.md。
3. **读取模型目录执行认证命令：确认。** 目录、刷新、会话创建不执行认证命令；实际认证入口保留命令认证功能，自动配额查询跳过命令凭证。未改掉失败测试掩盖问题，见 verified-plugins-models.md。
4. **Windows 启动环境影响 Node：确认环境隔离缺口并修复。** 受限子进程清理宿主预加载/认证环境；文件编辑独立于命令进程可用性。真实 Node 与文件边界验证见 verified-sandbox.md。未宣称所有 Windows 环境和架构均已实测。
5. **嵌套调用不消耗一次授权：确认并修复。** 消费收口到自定义工具定义执行处，真实 codemode、ctx.executeTool 测试第二次调用被拒绝；shell 前缀采用定义时同一值，见 verified-sandbox.md。

cloudflared 的“管道无人读取会挂死”没有确认，未按此说法改代码。

## 自动化

| 原报告条目 | 核验和处理 |
|---|---|
| rev-auto runner:246 扩展命令提前成功 | 等待模型、扩展命令、shell、提交、资源刷新和停止状态全部结束；无人值守状态保持到真正清理完成。 |
| runner:372 超时/停止孤儿 | 使用统一 abort 路径，等待 dispose；停止失败保留占位/心跳并重试，已 disposed 则加入已有清理任务。 |
| store:421 满额度后误记离线 | 记录持续观察到的排队状态；排队不会被误算成离线；保留四个运行/启动名额限制。 |
| store:495 claim 释放失败 | 持久化独立 claim ID，启动核对并消费；回滚仅影响同一 claim，不以任意手动运行时间或 updatedAt 阻止释放；失败释放保留进程内重试队列。 |
| store:58/63 心跳超时与 PID 复用 | 记录 OS 进程启动身份；活进程不会因心跳过期被另一实例重跑，已知 PID 复用可回收，无法证明退出则保守持有。 |
| schedule:201 interval 漂移 | 下一次按原计划相位推进到未来，跳过已过周期而不累计每轮 tick 延迟。 |
| schedule:204 春季不存在时间 | daily/weekly 与 cron 一样跳过不存在的墙钟时刻。 |
| schedule:246 不可能日期 | 创建/更改计划时拒绝没有未来执行时间的日期组合。 |
| store:187 单条损坏停止调度 | 不认定应自动跳过：已有检查、预览、备份、手动恢复入口；损坏权限/运行记录时自动继续可能破坏互斥。保留显式恢复流程。 |
| schedule:76 `*/n` 日/星期语义 | 报告建议不采纳。Cronie 源码在字段首字符为 `*` 时设置 DOM_STAR/DOW_STAR，与当前实现相同。 |
| schedule:231 回拨日 cron 两次匹配 | 不是必然重复调度 bug。Cronie crontab(5) 明确重复墙钟会匹配两次；保留已有按真实时间排序的回归。daily/weekly 每天一次语义未改。 |

标准语义核验来源：[Cronie entry.c](https://github.com/cronie-crond/cronie/blob/master/src/entry.c)、[Cronie crontab.5](https://github.com/cronie-crond/cronie/blob/master/man/crontab.5)。

## 会话、设置、文件历史及界面

- 同路径会话重新创建会等待旧 session_shutdown / runtime / 原生资源清理，再重读旧关闭钩子可能追加的 JSONL；重复 dispose 加入同一 Promise。冷会话增加 64 个的 LRU 目标上限，正在查看/运行者保留。新增生命周期真实 SDK 回归由 sandbox 子任务记录。
- bash 执行期间拒绝新的普通 prompt；扩展关闭路径补 commandRunning 忙态检查和拒绝处理器。
- Pi 设置和插件手写 settings.json 改用共享同步 JSONC 事务，避免异步持锁时 SDK lockSync 阻塞本线程；保留 BOM、注释和不相关字段。真实同时保存 SDK/theme 与 web/retry 的回归通过。
- 最后整仓回归实际发现：资源缓存仍持有已删除/移动工作区时，新增项目设置边界检查会令所有提示词刷新失败。现 SDK 只读回调对缺失根读取空设置，写入仍拒绝且不重建根；链接/权限失败继续拒绝。修后 prompt/settings/boundary 26 项通过，详见 sandbox 台账。
- `rev-race:69` 两个裸 rename 已接入有限共享错误重试。模型每次重试前重读 revision，检测等待期间的外部编辑并返回冲突；永久失败保留旧文件并清理临时文件。新增真实文件内容与受控 I/O 故障回归。普通文件系统没有跨平台的条件 rename，不能宣称这使不合作的外部写者与替换完全原子互斥；受支持的 PiWeb 写入仍由共同锁串行。
- 归档清理在每次移除前于注册表写锁内核对归档时间与归档状态，重查活动和文件 mtime；取消归档/重新归档不会被旧快照删除。跨进程仅通过归档注册表变更协调；本进程 isActive 不是其他任意客户端的活动租约，不宣称已覆盖外部程序只读打开。
- Git 历史容量检查改为对象 ID 直接流向 cat-file，累计尺寸，不再把完整对象清单放入 8MiB 缓冲。真实 Git 全套和超过 8MiB 的离线子进程管道、枚举失败、容量拒绝回归通过。
- 输入组件的 key={draftKey} 已由其他修复存在，保留，不重复宣称新修。新增删除会话完成后的当前路径检查、搜索 300ms 防抖、关闭搜索取消请求。
- 恢复队列的图片全部保留；超限时提示并阻止发送，不按报告建议静默截断用户附件。
- 草稿/模型应用提示补双语；启动器登录说明跟随新流程。无 cookie 时迁移 localStorage 语言会在水合后切换，属于已有明确回归的兼容退化，不为消除一次闪变制造水合不一致。
- 导入中的语言切换不再触发清理；代理自动探测地址只作占位提示；重试次数无效/保存失败回到已保存值。界面行为新增验证见 verified-ui.md。
- web-devices 写失败后撤销去重标记，允许立即重试；缓存上限 1000 项、读取上限 1MiB、保留最多 200 条设备记录，并按 Cookie 吊销代次过滤。损坏恢复/去重/超限/代次专项 5 项通过。
- 旧凭证缓存已按用户明确授权将指定 models.json 单文件移入 Windows 回收站，原路径已不存在，backups/INDEX.md 已追加记录；未读取展示完整凭证，未触碰实际使用的模型配置。若其中凭证仍有效，删除副本不能替代轮换。

## 验证说明

- root-round1.log：6 文件 41 通过。
- root-round2.log：中间回归两项新测试夹具失败（错误回调名与原搜索框未处理 Esc），已修；保留失败日志。
- retention-verbose.log：14 项通过，含取消归档竞态。
- root-round3.log：5 文件 39 通过、1 项当前 Windows 无文件符号链接能力跳过；含真实 Git 与流式容量测试。
- root-round4.log：8 文件 65 通过，含同步 SDK/web 保存。
- automations-final.log：自动化最后针对性回归通过，包含已 disposed 停止和存储恢复后的 claim 回收。
- atomic-config-final.json / .log：原子文件重试、模型配置、工作区注册表共 3 文件 65 项通过；原子 helper 包含三类共享错误、永久失败、非共享错误即停和等待期间版本变化。
- 覆盖率范围新增核心生产 mjs：file-lock、HTTP guard、remote-engine、update-environment、web-auth-protocol、web-auth-constants、process-identity；原 src 门槛未降低。子进程原生集成测试与单进程覆盖率分别报告。

最终验证现已完成：冻结源码整仓 2211 passed / 0 failed / 2 approved skips，分支覆盖率 73.03%，类型检查、差异检查、成品构建、干净安装、真实插件 API 与浏览器验收通过。完整结果与实际边界以 verified-summary.md / verification-final.json 为准；上面的定向批次数量不相加。
