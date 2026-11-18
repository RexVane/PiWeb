# 数据目录、隐私与留存

维护日期：2026-11-15。本文说明 PiWeb 实际读写哪些位置、如何做部署隔离、会联网做什么、删除与恢复的真实行为。历史审查记录属于工程档案，只保留在本机。

## 数据根不止 agent 目录

`PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）是 Pi/PiWeb 共享的**主数据根**，但**不是全部数据根**。只重定向它，以下位置仍然指向运行用户的家目录：

| 位置 | 内容 | 代码位置 |
| --- | --- | --- |
| `<agent 目录>`（`PI_CODING_AGENT_DIR`） | `settings.json`、`models.json`、`auth.json`、`sessions/`、`skills/`、`web-skills/`、`web-uploads/`、`web-automations.json`、`web-workspaces.json`、`web-devices.json`、`web-revocations.json`、`web-secret`、`trust.json`、`web-bin/`、`web-launch/`、`npm/` | `src/lib/pi.ts`、`web-secret.ts`、`files-service.ts` 等 |
| `$HOME` / `%USERPROFILE%` 下的导入来源 | 会话导入只读取、不修改：`~/.claude/projects`、`~/.codex/sessions`、`~/.grok/sessions`、`~/.dsh/sessions`、`~/.zcode/cli/db/db.sqlite`、`~/.local/share/opencode/opencode.db` | `src/lib/session-import/paths.ts` |
| `~/.agents/skills` | 全局技能目录（个人技能来源之一） | `src/lib/skills-service.ts` |
| `~/.agents/backups` + `INDEX.md` | 可恢复移除（技能、附件、上传清理）保留的恢复副本与索引 | `src/lib/recoverable-remove.ts` |
| 安装目录 | `.next`、`.next-releases/`、依赖与锁文件 | `scripts/build-output.mjs` |
| 工作区（用户项目目录） | 项目文件；生长树记录写在该工作区 Git 仓库的 `refs/piweb/rounds/…` | `src/lib/growth-service.ts` |
| 临时目录 | 构建 staging、npm 缓存、SDK 工具下载等 | `scripts/install-build.mjs` 等 |

因此：

- **看住 agent 目录不等于看住全部数据**：`~/.agents/skills`、导入来源和 `~/.agents/backups` 仍在 `HOME`/`USERPROFILE` 下。
- 会话导入只读取来源数据，不写入、不迁移；卸载 PiWeb 不会删除这些来源。
- 后端文件接口在默认配置下不要求 cwd 是已注册工作区（认证后本机操作者级权限）。需要更严格的边界时使用[严格工作区模式](environment.md#可选限制开关本修复轮新增默认不改变原有行为)。

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

联网行为分为四类：

1. **Pi SDK 安装遥测（默认开启）**：pi 设置 `enableInstallTelemetry` 默认为 `true`。开启时，发给 OpenRouter、NVIDIA NIM、OpenCode 的模型请求会带 `pi` 归属元数据（如 `HTTP-Referer`、`X-OpenRouter-Title`、`X-BILLING-INVOKE-ORIGIN`，不含用户文件与路径）；SDK 的安装上报实现位于 pi CLI 交互模式（`https://pi.dev/api/report-install?version=…`），PiWeb 经 SDK 使用，审计未发现 PiWeb 源码触发上报。设置 `PI_OFFLINE` 会跳过上报；要**完全关闭**遥测与归属头：

   ```bash
   PI_TELEMETRY=0 piweb   # 0/false/no 强制关闭；1/true/yes 强制开启
   ```

   `PI_TELEMETRY` 未设置时由 pi 设置里的 `enableInstallTelemetry` 决定（PiWeb 界面未暴露该设置的开关，只能改 pi 的 `settings.json` 或用环境变量）。

2. **PiWeb 更新检查（默认开启）**：启动时在后台查询新版本。npm 安装用 `npm view` 查 registry 版本；源码/Git 安装用 `git fetch` 对比 `origin/main`。只取版本信息，不上传用户数据。关闭：`PI_WEB_UPDATE_CHECK=0`（设置里的“检查更新”仍可手动用）。

3. **你配置的模型与工具**：对话内容、工具调用结果会发送给你配置的模型提供方；加载的扩展是宿主进程内受信任代码，可自行联网。PiWeb 不代做脱敏。

4. **远程连接**：连接二维码/配对码是一次性凭据（120 秒），`cloudflared` 快速隧道会把手机流量经 Cloudflare 转发；直连局域网 HTTP **不加密**。吊销与设备记录的留存见下节。

## 导出与敏感信息

- **默认脱敏**：设置弹窗顶部的「打开配置文件」（`GET /api/config`）默认对 `settings.json` 里的代理凭据/密钥/trackingId 等打码，响应带 `X-PiWeb-Redacted: 1`；需要原始字节时显式加 `?raw=1`。
- **会话导出默认脱敏**：JSONL/HTML 导出默认脱敏，需要完整原文时显式加 `?raw=1`。
- 凭据本体仍在 agent 目录内明文保存（`auth.json`、`models.json`、`settings.json` 的 `httpProxy`、`web-secret`），请按密钥文件保护：限制目录权限、不要放进备份共享区、不要提交到仓库。
- 会话 JSONL、上传附件、导出文件都包含完整对话与工具输出，可能含路径、密钥片段与业务数据；分享前自行检查。

## 删除、归档与恢复副本

| 操作 | 实际行为 |
| --- | --- |
| **手动删除会话** | 直接永久删除该会话 JSONL，**不留恢复副本**（界面确认框明确写“永久删除，无法恢复”）。删除前会先找出该会话独占引用的上传附件，删除后确认没有其他会话仍引用它们时，按“先备份再移除”清理（恢复副本在 `~/.agents/backups`，位置追加到 `INDEX.md`）；证据不足（目录读不全、超预算、读取失败）则保留附件。可用 `PI_WEB_DELETE_ATTACHMENT_CLEANUP=0` 关闭这项定向附件清理。 |
| **归档会话** | 归档只改归档标记，不删除文件；**当前版本不会自动删除归档会话**（2026-11-15 工作区移除了原有的 30 天自动清理模块），归档会话保留到手动恢复或删除。恢复/删除仍需用户在界面操作。 |
| **上传附件** | 保存在 `<agent 目录>/web-uploads/`。后台清扫只在**之后发生新的上传时**触发，且每进程每天最多一次；只处理 30 天前的候选、且确认没有会话 JSONL 再引用才清理。清理同样保留恢复副本。`PI_WEB_UPLOAD_RETENTION=0` 关闭该清扫。删除会话时另有上面的定向清理。 |
| **技能删除** | 通过可恢复移除：先复制并核验恢复副本、追加 `INDEX.md`，再移除原入口；链接只移动本身、不触碰目标。 |
| **退出所有设备 / 吊销** | 写入吊销代次 `web-revocations.json`，已有 Cookie 与配对码立即失效；设备记录 `web-devices.json` 按过期时间清理并截断到 200 条。 |
| **恢复副本的根** | 恢复副本默认放在 `~/.agents/backups/`（家目录内按原路径镜像）；目标位于某个工作区时放在 `<工作区>/backups/`。`INDEX.md` 只追加、记录时间、原路径、存放位置与原因；`backups/` 只由用户手动清理。 |

**恢复步骤**（适用于技能/附件等有恢复副本的对象）：

1. 停掉 `piweb`；
2. 在 `~/.agents/backups/INDEX.md`（或对应 `<工作区>/backups/INDEX.md`）里按原路径找到对应副本；
3. 把副本复制回原路径（会话 JSONL 没有恢复副本，只能从 agent 目录备份恢复）；
4. 重新启动 `piweb`。

**整体数据备份**：停掉 `piweb` 后复制整个 agent 目录和（如存在）`~/.agents/skills`、`~/.agents/backups` 即可；如果用过工作区内的可恢复删除，也备份对应 `<工作区>/backups`。升级/降级都不会自动迁移或删除这些数据，但**降级前必须备份**，旧版本可能不识别新版本写入的字段。

## 核对证据

- 数据路径源码：`src/lib/session-import/paths.ts`、`src/lib/skills-service.ts`、`src/lib/recoverable-remove.ts`、`src/lib/files-service.ts`、`src/lib/session-reader.ts`。
- 审计证据：原始报告目录与审计归档已随 2026-11-15 收尾清理移出仓库（可由 git 历史恢复）。
- 修复轮验证：随同批审计归档移出仓库（可由 git 历史恢复）。
