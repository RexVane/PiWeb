# 数据目录、隐私与留存

维护日期：2026-11-20。本文说明 PiWeb 实际读写哪些位置、如何做部署隔离、会联网做什么、删除与恢复的真实行为。历史审查记录属于工程档案，只保留在本机。

## 数据根不止 agent 目录

`PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）是 Pi/PiWeb 共享的**主数据根**，但**不是全部数据根**。只重定向它，以下位置仍然指向运行用户的家目录：

| 位置 | 内容 | 代码位置 |
| --- | --- | --- |
| `<agent 目录>`（`PI_CODING_AGENT_DIR`） | `settings.json`、`models.json`、`auth.json`、`sessions/`、`skills/`、`web-skills/`、`web-uploads/`、`web-growth/`（普通目录的生长树快照）、`web-workspaces.json`、`web-devices.json`、`web-revocations.json`、`web-secret`、`trust.json`、`web-bin/`、`web-launch/`、`npm/` | `src/lib/pi.ts`、`web-secret.ts`、`files-service.ts` 等 |
| `$HOME` / `%USERPROFILE%` 下的导入来源 | 会话导入只读取、不修改：`~/.claude/projects`、`~/.codex/sessions`、`~/.grok/sessions`、`~/.dsh/sessions`、`~/.zcode/cli/db/db.sqlite`、`~/.local/share/opencode/opencode.db`、`~/.kimi`、`~/.workbuddy` / `~/.workbuddy-ai`（支持 `WORKBUDDY_CONFIG_DIR`）、`~/.gemini/antigravity`、`~/.gemini/antigravity-cli`、`~/.qwen`（支持 `QWEN_HOME`）、`~/.cursor/chats` | `src/lib/session-import/paths.ts` |
| `~/.agents/skills` | 全局技能目录（个人技能来源之一） | `src/lib/skills-service.ts` |
| `~/.agents/backups` + `INDEX.md` | 后台过期附件清理、损坏配置修复及旧版本删除留下的恢复副本与索引；手动确认的文件删除不再另存副本 | `src/lib/recoverable-remove.ts` |
| 运行 PiWeb 的用户的系统回收站 | 手动确认删除的会话、独占附件、技能、提示词模板和受管包安装文件 | `src/lib/recycle-bin.ts` |
| 安装目录 | `.next`、`.next-releases/`、依赖与锁文件 | `scripts/build-output.mjs` |
| 工作区（用户项目目录） | 项目文件，已有 Git 仓库的生长树记录可存放在 `refs/piweb/rounds/…` | `src/lib/growth-service.ts` |
| 临时目录 | 构建 staging、npm 缓存、SDK 工具下载等 | `scripts/install-build.mjs` 等 |

因此：

- **看住 agent 目录不等于看住全部数据**：`~/.agents/skills`、导入来源和 `~/.agents/backups` 仍在 `HOME`/`USERPROFILE` 下。
- 会话导入只读取来源数据，不写入、不迁移；卸载 PiWeb 不会删除这些来源。
- 普通目录首次记录时，在 `<agent 目录>/web-growth/` 建立快照库，项目里不会生成 `.git`。同一目录之后即使自行初始化 Git，也会继续使用原有的快照库。
- 后端文件接口在默认配置下不要求 cwd 是已注册工作区（认证后本机操作者级权限）。需要更严格的边界时使用[严格工作区模式](environment.md#可选限制开关本修复轮新增默认不改变原有行为)。

## 导入会话的续聊兼容

- 所有来源共用的导入写入器都会为助手消息写入完整的 `usage`（包括 `totalTokens` 和 `cost`），源工具未报告的字段补 0。这里的 0 表示**未知**，不是测得的真实用量；SDK 会对没有有效用量的历史按消息内容估算上下文，导入不会伪造计费。
- 旧导入会话若缺少这些字段，PiWeb 在打开时对内存中的消息做兼容处理，续聊和分支入口共用这一处理。正常消息已记录的完整用量与费用保持原样；原始 JSONL 不会被自动批量重写，正文、ID 和分支关系不变。
- 不需要删除或重新导入旧会话。源工具额度耗尽时，可以选择 PiWeb 中另一个已配置、可用的模型继续任务；后续请求消耗的是所选模型的额度。

## 自动思考档位与手动配置

- 优先级为：用户/扩展显式配置的 `thinkingLevelMap` → Pi SDK 官方对应模型配置 → 未识别兼容模型的后台探测缓存 → SDK 默认档位。匹配模型 ID、版本和已知网关后缀，不跨代借用其他型号的配置；不会修改模型的 API 地址、协议、价格或上下文上限。
- 模型卡片中可编辑“档位 → API 参数值”。添加时从 `low → low` 开始，再选择未使用的 `medium`、`high`、`xhigh`、`max` 等标准档位；`off` 默认映射为 `none`。手动表单未列出的档位以 `null` 禁用，保存到与终端 Pi 共享的 `models.json`；选择“使用自动档位”会移除该手动映射。
- 官方能匹配时不发额外请求。未知 `openai-completions` / `openai-responses` 模型才会进入后台队列：单次最多 9 个简短测试请求，请求输出上限设为 64 tokens，串行执行、请求间隔 3.5 秒；可能消耗所选提供方的额度。仅使用合成测试消息，不发送已有会话。OAuth 和凭证/请求头命令不在后台探测，遇到限速、认证失败或不确定结果保留默认配置。
- 缓存保存在 `<agent 目录>/web-thinking-cache.json`，最多 256 条记录，以 SDK 版本、模型/端点、兼容参数和配置文件指纹区分。有效结果缓存 7 天，失败或不确定结果退避 1 小时；不含密钥、请求头原文、对话或完整响应，不自动写回 `models.json`。后台结果仅代表端点接受的参数值，不能证明实际思考量或网关上游身份。
- `PIWEB_AUTO_THINKING_PROBE=0` 可关闭额外探测；`PI_OFFLINE=1`、构建和测试环境也不自动发起探测。界面无需逐个点击“探测”，手动配置始终优先。

## 部署隔离

容器、CI、多实例或多用户部署要同时隔离**家目录与 agent 目录**：

```bash
# Linux/macOS；路径按部署调整
export HOME=/srv/piweb/home
export PI_CODING_AGENT_DIR=/srv/piweb/agent
export TEMP=/srv/piweb/tmp TMP=/srv/piweb/tmp
# 可选：开发工具/缓存目录
export APPDATA=/srv/piweb/appdata LOCALAPPDATA=/srv/piweb/localappdata
```

```powershell
# Windows（pwsh）
$env:HOME = 'D:\srv\piweb\home'
$env:USERPROFILE = 'D:\srv\piweb\home'
$env:PI_CODING_AGENT_DIR = 'D:\srv\piweb\agent'
$env:TEMP = 'D:\srv\piweb\tmp'; $env:TMP = $env:TEMP
$env:APPDATA = 'D:\srv\piweb\appdata'; $env:LOCALAPPDATA = 'D:\srv\piweb\localappdata'
```

这样做的效果：

- 会话导入来源在隔离的 home 下通常为空，不会读到宿主机用户的历史会话；
- 全局技能从隔离 home 的 `~/.agents/skills` 读取；
- 恢复副本写到隔离 home 的 `~/.agents/backups`，索引同目录；
- 构建 staging、临时文件落在隔离的临时目录。

注意：

- Windows 上 Node 的 `os.homedir()` 取 `USERPROFILE`（无则回退 `HOMEDRIVE`+`HOMEPATH`），所以 Windows 要设 `USERPROFILE`；POSIX 取 `HOME`。
- 隔离后仍挂载进来的路径（例如用 `-H` 或工作区注册把宿主目录暴露给文件工具）按用户的显式配置对待，不属于隔离承诺。
- 同一 `agent 目录` 只应给一个运行中的 PiWeb 实例使用；不要在多实例间共享并同时写。

## 遥测与联网

**PiWeb 自身没有第三方埋点**：源码与依赖里没有 Sentry / PostHog / Segment / Umami / GA / Mixpanel / Datadog 之类 SDK；`scripts/install-build.mjs` 与 CI 会设置 `NEXT_TELEMETRY_DISABLED=1`，启动器给第三方 installer 的子进程环境也固定带 `NEXT_TELEMETRY_DISABLED=1`。该结论来自 2026-11-15 审计（原始证据目录与审计报告已移出仓库，可由 git 历史恢复）。

联网行为分为五类：

1. **Pi SDK 安装遥测（默认开启）**：pi 设置 `enableInstallTelemetry` 默认为 `true`。开启时，发给 OpenRouter、NVIDIA NIM、OpenCode 的模型请求会带 `pi` 归属元数据（如 `HTTP-Referer`、`X-OpenRouter-Title`、`X-BILLING-INVOKE-ORIGIN`，不含用户文件与路径）；SDK 的安装上报实现位于 pi CLI 交互模式（`https://pi.dev/api/report-install?version=…`），PiWeb 经 SDK 使用，审计未发现 PiWeb 源码触发上报。设置 `PI_OFFLINE` 会跳过上报；要**完全关闭**遥测与归属头：

   ```bash
   PI_TELEMETRY=0 piweb   # 0/false/no 强制关闭；1/true/yes 强制开启
   ```

   `PI_TELEMETRY` 未设置时由 pi 设置里的 `enableInstallTelemetry` 决定（PiWeb 界面未暴露该设置的开关，只能改 pi 的 `settings.json` 或用环境变量）。

2. **PiWeb 更新检查（默认开启）**：启动时在后台查询新版本。npm 安装用 `npm view` 查 registry 版本；源码/Git 安装用 `git fetch` 对比 `origin/main`。只取版本信息，不上传用户数据。关闭：`PI_WEB_UPDATE_CHECK=0`（设置里的“检查更新”仍可手动用）。

3. **你配置的模型与工具**：对话内容、工具调用结果会发送给你配置的模型提供方；加载的扩展是宿主进程内受信任代码，可自行联网。PiWeb 不代做脱敏。

4. **远程连接**：连接二维码/配对码是一次性凭据（120 秒），`cloudflared` 快速隧道会把手机流量经 Cloudflare 转发；直连局域网 HTTP **不加密**。吊销与设备记录的留存见下节。

5. **自动思考档位探测**：无法匹配官方配置的已认证兼容模型，可能发送上节所述的合成测试请求；会消耗提供方额度，但不发送真实对话、不覆盖手动映射。可通过 `PIWEB_AUTO_THINKING_PROBE=0` 或 `PI_OFFLINE=1` 禁用。

## 导出与敏感信息

- **默认脱敏**：设置弹窗顶部的「打开配置文件」（`GET /api/config`）默认对 `settings.json` 里的代理凭据/密钥/trackingId 等打码，响应带 `X-PiWeb-Redacted: 1`；需要原始字节时显式加 `?raw=1`。
- **会话导出默认脱敏**：JSONL/HTML 导出默认脱敏，需要完整原文时显式加 `?raw=1`。
- 凭据本体仍在 agent 目录内明文保存（`auth.json`、`models.json`、`settings.json` 的 `httpProxy`、`web-secret`），请按密钥文件保护：限制目录权限、不要放进备份共享区、不要提交到仓库。
- 会话 JSONL、上传附件、导出文件都包含完整对话与工具输出，可能含路径、密钥片段与业务数据；分享前自行检查。

## 删除、归档与恢复副本

**手动确认删除实际文件时统一进入系统回收站，不另建恢复副本或 `INDEX.md`，也不降级为永久删除。** 回收站位于运行 PiWeb 的电脑或服务器上，不是访问页面的手机上。移除工作区入口、模型或凭据只修改对应配置条目，不能因此删除整个目录或配置文件。

| 操作 | 实际行为 |
| --- | --- |
| **手动删除会话** | 停止该会话后，将 JSONL 移到系统回收站。仅由该会话引用的上传附件，在确认没有其他会话引用后同样移到回收站；证据不足则保留附件。主文件回收失败会报错并保留记录；主文件已回收但附件清理或列表更新失败时，返回明确的部分完成提示。`PI_WEB_DELETE_ATTACHMENT_CLEANUP=0` 关闭定向附件清理。导入来源的原始会话不受影响。 |
| **技能删除** | 确认实际路径后，将独占技能目录、单个平铺文件或链接移到系统回收站。技能根、共享目录及链接的真实目标保留；包技能只能停用。 |
| **提示词模板删除** | 只回收确认的单个模板文件或链接，不回收其目录；包内模板和外部来源通过停用管理。 |
| **扩展包卸载** | Git 包的受管检出目录直接进入回收站，不调用 SDK 的递归删除。npm 包仍在独立 staging 中用官方包管理器卸载，再提交新安装树；旧安装树整体进入回收站，其他包及共享依赖在新树中保持可用。回收失败时旧安装树及事务记录保留，明确报告卸载已生效但回收待完成，后续读取列表时重试。未落盘的包只移除声明；本地源包不会删除来源文件。 |
| **工作区入口、模型、凭据** | 工作区仅从注册表移除，项目目录及会话保留；模型提供方及凭据仅移除相应配置项，不回收整份 `models.json` 或 `auth.json`，也不额外保存一份密钥。 |
| **归档会话** | 归档只改标记，不删除文件；当前版本不会自动删除归档会话。归档会话一直保留到手动恢复或删除。 |
| **后台过期上传清理** | 保存在 `<agent 目录>/web-uploads/`。之后发生新的上传时才触发，每进程每天最多一次；只处理 30 天前且确认没有会话引用的候选。此操作没有手动删除确认，仍保留恢复副本；`PI_WEB_UPLOAD_RETENTION=0` 关闭该清扫。 |
| **退出所有设备 / 吊销** | 写入吊销代次 `web-revocations.json`，已有 Cookie 与配对码立即失效；这是授权状态变更，不是文件删除。 |
| **已有恢复副本** | 旧副本、后台清理和损坏配置修复的副本仍保留。家目录内通常在 `~/.agents/backups/`，工作区内在 `<工作区>/backups/`，其他位置按原文件旁的 `backups/` 存放。`INDEX.md` 只追加；这些目录不会因为新删除策略自动清理。 |

### 系统回收站适配

- **macOS**：通过 `NSFileManager.trashItemAtURL` 操作确切的文件 URL。不能把待删链接强转为 Finder alias：该转换会跟随链接，可能误回收其目标。
- **Windows**：使用 `IFileOperation` 的显式回收选项。禁用回收站、网络卷或不支持回收的环境会失败，不使用 `Remove-Item` 或永久删除作为兜底。
- **Linux**：使用 Freedesktop 规范的 `$XDG_DATA_HOME/Trash`（默认 `~/.local/share/Trash`），记录 `.trashinfo` 以供恢复，并在同一文件系统中原子移动。回收站必须是当前用户拥有的私有物理目录；跨文件系统或不安全目录会报错并保留源文件。

### 恢复

1. 停掉 `piweb`；
2. 对本版手动删除的会话、技能、模板或附件，在运行 PiWeb 的电脑的系统回收站中恢复到原位置。npm 旧安装树包含整个上一代 prefix，不要直接覆盖当前安装树；通常应重新安装并重新配置该包，需要找回本地改动时从回收站取回对应文件；
3. 对旧副本或后台清理的对象，根据对应 `backups/INDEX.md` 找到副本，确认原位置没有文件后复制回去；
4. 重新启动 `piweb` 或重载资源。清空系统回收站后无法再靠本策略恢复。

**整体数据备份**：停掉 `piweb` 后复制整个 agent 目录和（如存在）`~/.agents/skills`、`~/.agents/backups` 即可；如果用过工作区内的可恢复删除，也备份对应 `<工作区>/backups`。升级/降级都不会自动迁移或删除这些数据，但**降级前必须备份**，旧版本可能不识别新版本写入的字段。

## 核对证据

- 数据路径源码：`src/lib/session-import/paths.ts`、`src/lib/skills-service.ts`、`src/lib/prompt-templates-service.ts`、`src/lib/recycle-bin.ts`、`src/lib/recoverable-remove.ts`、`src/lib/files-service.ts`、`src/lib/session-reader.ts`。
- 审计证据：原始报告目录与审计归档已随 2026-11-15 收尾清理移出仓库（可由 git 历史恢复）。
- 修复轮验证：随同批审计归档移出仓库（可由 git 历史恢复）。
