# 插件、技能、模型与凭证：核验和修复记录

日期：2026-11-14。依据当前源码、已安装 pi SDK 1.5.2、`rev-plugins.md`、`rev-secrets.md`、`rev-ui2.md` 及 Claude 遗留第 3 项。没有修改 SDK/node_modules，没有调用真实模型，没有使用用户密钥联网，没有操作 live 30141。

## 已修复并验证

| 条目 | 核验与处置 | 主要证据 |
|---|---|---|
| auth.json 的 `!command` 在打开模型目录时执行 | 成立。SDK 默认 CredentialStore.read 在初始化、refresh 和 checkAuth 时解析命令。新增 `createPiWebModelRuntime`：状态读取保留命令原文、只解析环境模板；真正 `getAuth` 才进入请求认证上下文。公共运行时和会话运行时均使用同一入口。保留 SDK 的凭证写锁、OAuth 更新和显式命令认证功能。 | `tests/models-sdk-catalog-commands.test.ts` 用真实 SDK 与本机命令验证 models.json key/header、auth.json key 三类：目录创建、刷新、可用性检查、会话运行时创建均不落标记；getAuth 后才落标记；模板/转义与 SDK 实际请求解析一致。 |
| 打开设置页自动查询额度间接执行认证命令 | `ProviderView.authCommand` 标明命令凭证；ModelsSection 自动用量查询跳过此类提供方，保留用户主动查询入口。 | `tests/components/models-auth-boundary.test.tsx` |
| npm 源的参数注入、URL/路径误解析、安装路径穿越 | 成立。`npm:` 只接受注册表包名及可选版本、范围或 tag；拒绝选项、路径、URL、控制符和畸形 scope。服务入口和 SDK package-manager 的 parseSource 均校验，覆盖安装、更新及已有配置路径查找；API 返回 400。 | `tests/package-manager-safe.test.ts` 的非法源、合法范围/tag/local/git、真实 SDK install/getInstalledPath 回归。 |
| 插件安装/更新/卸载的生命周期脚本 | 成立。对 PiWeb 的各个 SDK manager 实例追加 `--ignore-scripts`，不修改全局环境。包括资源加载器内部 manager；缺失包的自动安装仍禁止。 | 真实离线 npm fixture：安全适配不运行 preinstall/install/postinstall/prepare；原 SDK 对照确认四个脚本本来会运行。另测 install/uninstall/update 参数。 |
| 插件手写 settings.json 与 SDK 同步锁冲突 | 与 root 配合：togglePackage 和移除停用记录改用 `mutateJsoncSettingsFileSync`，仍保留外层进程内排队、预先 flush/reload 和 JSON 缓存失效。 | 插件 persistence、source/scope 回归通过。 |
| 技能删除时祖先被替换为 junction | 成立。删除阶段 Windows 使用目录句柄限制祖先重命名/reparse 替换；Linux 使用 O_NOFOLLOW 目录描述符并从 `/proc/self/fd` 执行。计划还传递预期 canonical/type，防止原定普通目录变链接或原定链接变普通目录。目录移除使用备份后原件 rename，不再调用会递归遍历的新目录回收操作。 | `tests/removal-boundary.test.ts` 实测 Windows 重命名竞争被阻止、预先替换祖先/末级 junction 被拒绝、外部 canary 保留；现有 recoverable-remove 回归通过。 |
| 技能根自身是链接、链接被多个技能共用及 Windows 大小写 | 成立。检查包括根本身；共用链接按 Windows 不区分大小写比较，拒绝移除仍被其他技能引用的链接；可独占的链接仅移动链接，保留真实目标。 | `tests/skills-link-removal.test.ts` 的根链接、混合大小写共享链接和普通 junction 回归。 |
| Linux bind mount 递归进入外部挂载内容 | 静态机制成立；仅看 st_dev 不能辨认同设备 bind mount。新增 `/proc/self/mountinfo` 检查受管根到目标以及目标内的挂载点，拒绝移除前/回收前发现的挂载。 | mountinfo 同设备和转义路径解析回归；本机 Windows 未执行真实 Linux mount --bind，见边界。 |
| X-Credential / X-Password / X-Auth 请求头回显 | 成立。扩大认证头识别，同一个判断同时用于输出脱敏和保存回填；同步覆盖 provider、models[]、modelOverrides 的请求头。按模型 ID/同名出现次序保留已有隐藏头，正常重排不会错配。 | `tests/models-service-config.test.ts`：敏感头不可见、保存不丢、模型重排后仍回填同一模型。 |
| 新增自定义请求头输入明文 | 增强项，已将请求头 value 输入默认设为 password。 | ProviderSetupModal 现有回归通过。 |
| 409 后编辑/删除永久重复旧 revision | 成立。保存遇 409 / CONFIG_CHANGED 后刷新配置与 revision，保留未保存输入。旧编辑草稿仍要求取消后重新打开，避免拿旧草稿覆盖另一处新配置；重新编辑即可使用新 revision。 | `tests/components/models-auth-boundary.test.tsx` 验证失败草稿保留、刷新发生、新编辑使用新 revision；原有冲突/审计参数测试通过。 |
| setKey fire-and-forget 与 loginState 竞态 | 成立。setKey API 返回已登记任务的 202 accepted 状态；UI 收到确认后才开始轮询。后台错误由状态返回，缺失任务也不再被视为成功。OAuth 卡片入口使用相同的确认顺序。 | UI 延迟 setKey 确认时不轮询、确认后展示终态错误；API 验证 background 参数与 202；真实 SDK 凭证队列仍保留取消能力。 |
| 多步认证超过 clientFetch 30 秒 | 成立。HTTP 请求只等任务登记，不等待后续用户交互；交互通过既有轮询/应答继续。不扩大所有模型请求的超时。 | `tests/models-service-auth.test.ts` 验证后台 key 登录已返回而第二步 Account 提示仍待用户，回答后才写凭证。 |
| 删除 provider 先清凭证，配置保存失败后留下破损状态 | 成立。先确认 revisioned 配置写入，再清凭证；409 时不调用 removeKey。若配置已删除而清凭证失败，重新读状态并明确显示两步结果和重试入口。 | UI 测试覆盖 409 不清 key、第二步失败不吞错；中英提示已补。 |
| 后台认证错误绕过原同步 API 脱敏 | 在改成后台任务时同时防止此回归：公开 loginStart/setKey/loginState 错误均经 API 错误边界，不返回内部路径/命令/secret 原文。 | `model-login-final-tests.json` 的 API 后台错误脱敏回归。 |
| 仓库内运行时凭证误提交 | 防御性增强：`.gitignore` 增加 auth.json、models.json、web-secret、web-launch/、web-devices.json、web-revocations.json。 | `git check-ignore --no-index` 对虚拟嵌套路径逐一命中，无实际凭证文件写入。 |

## 不成立或不采纳的推论

- “授权安装插件、加载扩展代码本身就是 CRITICAL”：不作此裁定。PiWeb 的插件功能需要执行用户选定的扩展；非必要安装脚本已禁止，但合法 npm/git/local 源和私有仓库仍保留，没有按报告建议一律封禁。来源/主机白名单和只准精确版本属于额外产品限制，不能等同于已证实边界漏洞。
- “已发现技能的链接读取就是任意外读”：当前权威是 SDK 已发现配置，显式配置的外部技能与链接是已有功能；不能仅因其位于工作区外便判任意文件读取。保留 read/toggle 的已发现校验，删除另有严格边界。
- “Windows junction 不被 isSymbolicLink 识别”：真实 Windows 测试不支持此说法；普通 junction 被识别，已修的是竞态、根链接及共用链接判断。
- “修改 provider ID 导致隐藏密钥丢失”：当前编辑 UI 只有显示名称，没有 ID 输入。另加代码不变量拒绝现有 provider ID 变化；未新增密钥迁移协议。
- “带隐藏密钥的内置 provider 清空覆盖后会因 {} 失败”：当前服务端先回填隐藏凭证再交 SDK 校验。新增真实 SDK 测试确认 `{openai:{}}` 可还原为仅含原 apiKey 的有效条目；无须删除密钥或人为补假字段。
- 安装已持久化、仅资源刷新失败时，保留 `applied + warning`，不改成模糊的安装失败，避免用户重装已成功的包。

## 尚需如实保留的边界

1. 此前“未实现 npm 安装树事务”的记录已撤回：后续复核确认是真实问题，现由阶段安装、保留旧代、配置字段恢复与跨 scope 共同提交记录修复。提交决定前失败保旧，决定后中断则完成整组提交；不能把所有晚期故障称为回旧。真实 npm 晚期 EACCES、进程退出、SDK首次资源加载及安装/更新/卸载回归见 `verified-npm-transaction.md`。恢复材料保留，Linux/macOS分支未在本机实测。
2. 旧文件 `node_modules/.cache/piweb-metrics/audit-agent/models.json` 原存在，仅核验了路径/大小/模式计数（24600 字节，2 个 apiKey 字段、1 个 sk-like 值）。用户随后明确批准移除，root 已于 2026-11-14 12:53:54 将精确单文件移入 Windows 回收站，并追加 `backups/INDEX.md`，核验原路径已不存在。未展示完整密钥、未联网测试有效性。移除副本不会使凭证失效；若仍在使用相应凭证，应轮换。
3. 未做真实 Linux bind mount、macOS、管理员主动重挂载测试。Windows 祖先替换已实测，Linux mountinfo/目录描述符分支需 Linux CI/实机进一步验证；不能把有挂载权限的并发攻击者宣称为已完全隔离。
4. SDK 的 credential-store/package-manager 适配使用经过形状检查的内部成员。已用安装版 SDK 回归，升级 SDK 时若接口变化会拒绝操作，需更新适配后再通过合同测试。
5. `rev-ui2` 的 SessionImport 语言切换、ProxySettings 系统代理显示、GeneralSection 数值失败回滚已另行补验，记录见 `verified-ui.md`，本文件的 210 项不包含后续 UI 批次。

## 验证结果

- `.audit-2026-11-14/plugins-models-tests.json` / `.log`：19 个定向测试文件，210 passed、0 failed、0 skipped，53.83 秒。范围包含插件服务与真实生命周期、技能/恢复删除、模型运行时/认证/配置、设置 UI 与 API。
- 后续仅补后台认证公开错误脱敏：`.audit-2026-11-14/model-login-final-tests.json` / `.log`，2 文件 21 passed、0 failed。两组有重叠，不相加当整仓测试数量。
- 最后 `npx tsc --noEmit --incremental false` 通过。未在本子任务运行整仓 test/build，root 负责整合后的最终验收。
- 后补 `rev-tests` 的可恢复移除覆盖缺口：`recoverable-remove-v3-tests.json` / `.log`，1 文件 8 passed，12.60 秒。新增带单引号文件名与中文内容的真实 Windows PowerShell 回收，验证备份内容及 INDEX；新增实际占用 INDEX 写锁、等待捕获源身份后再注入不同 lstat 身份，验证锁内复核拒绝并保留原件、没有复制或登记错误恢复点。测试目录改用回收站清理。原生目录句柄已使真实文件替换尝试返回 EBUSY，因此第二项明确是文件身份注入测试，不声称成功替换了受保护文件。此前探针日志 `recoverable-remove-final-tests` / `v2-tests` 保留失败过程，不计入最终通过批次。
- 新增探针 fixture 由测试清理到回收站；保留上述测试日志和核验文档。旧凭证缓存已按用户后续批准由 root 单文件回收并登记。没有重置工作区、没有重启在线 PiWeb。
