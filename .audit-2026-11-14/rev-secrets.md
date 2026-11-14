# 凭证泄露审查（rev-secrets）

- 仓库：D:\AIApp\PiWeb，基线 HEAD `1d4efba`，对象：未提交工作区（`git diff --name-only HEAD` ∪ `git ls-files --others --exclude-standard`，排除 .audit-2026-11-13、.audit-2026-11-14、node_modules、package-lock.json）。
- 方法：纯静态分析。对 src/ scripts/ tests/ docs/ examples/ .github/ bin/ 及根目录文件做凭证模式全量 grep（`sk-`、`ghp_`、`github_pat_`、`xox`、`AKIA`、`BEGIN … PRIVATE KEY`、URL 内嵌凭证、webhook、`password/token/secret/apiKey`），并深读全部密钥处理路径。
- 硬性约束遵守：仅写入本文件；未运行 npm/vitest/build；仅使用只读 git（diff / ls-files / rev-parse）。

## 计数

| 级别 | 数量 |
| --- | --- |
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| QUESTION | 1 |

---

### [MEDIUM] node_modules\.cache\piweb-metrics\audit-agent\models.json:961（审查范围外路径，主动上报）

**问题**：一份 2026-10-12 生成的 agent 配置快照（审计指标缓存）里残留 `sk-` 开头的 48 字符 API 密钥（`sk-UY7f……yaNdg`，首8末8脱敏），挂在自定义 provider `lilililwan`（baseUrl `https://metapi.lilililwan.xyz/v1`）下。
**触发条件**：任何人/工具复制、归档、上传整个项目目录（node_modules 不走 git，但会跟着目录走）；或密钥仍然有效。
**期望行为**：密钥只存在于 `~/.pi/agent/`（0600），不落进项目目录任何缓存。
**实际行为**：真实配置被整份快照进 node_modules 缓存并驻留一个月。已验证：① 全树（含 -Force 隐藏/忽略目录）扫描该密钥前缀，唯一命中即此文件；② `.gitignore` 的 `node_modules/` 使其不可能被提交；③ 当前 `~/.pi/agent/models.json`（2026-11-14 02:12 修改）已不含该 provider/密钥（可能已轮换或删除）；④ backups/ 与 .audit-*/ 均无该密钥。
**证据**：`node_modules\.cache\piweb-metrics\audit-agent\models.json:961` `"apiKey": "sk-UY7f……yaNdg"`（同文件 :944 另有占位值 `"apiKey": "magpie"`，非密钥）；文件创建/修改时间 2026-10-12 21:22:14。
**修复建议**：删除 `node_modules\.cache\piweb-metrics\` 整个缓存目录（可重新生成）；若 `metapi.lilililwan.xyz` 的这把 key 仍有效则立即轮换；metrics/审计类快照工具今后对 `apiKey`/`headers` 做脱敏再落盘。
**最小失败测试**：快照写入前对内容跑 `redactCustomProviderSecrets`（src\lib\models-service.ts:1443），断言产物不含任何 `sk-` 开头 40+ 字符串。

### [MEDIUM] src\lib\models-service.ts:1452

**问题**：自定义 provider「密钥型请求头」的回显脱敏靠名字启发式 `/authorization|cookie|token|key|secret/i`（值前缀 `!` 也算），名字不带这些词的密钥头（如 `X-Credential`、`X-Password`）会被原样回显到设置页。
**触发条件**：用户把密钥放在名字不匹配启发式的自定义头里 → `GET /api/models?custom=1` 把值带进浏览器，并在 ProviderSetupModal 的头编辑框里明文显示。
**期望行为**：与 `apiKey` 一致：值不回显，只显示「已保存」状态，保存时合并回写（见 :1461-1481 的既有机制）。
**实际行为**：`apiKey` 与 `Authorization/Cookie/…Token/…Key/…Secret` 名头的值被删除（:1448、:1452），其余头的值原样返回（`readCustomProviders` :1509-1516 → `src\app\api\models\route.ts:40,73` → `src\components\ProviderSetupModal.tsx:322-341` 渲染为可编辑输入框）。
**证据**：src\lib\models-service.ts:1443-1458（redact 正则）、:1509-1516；src\components\ProviderSetupModal.tsx:76、:322-341；旁证——项目自己的测试把 `X-Credential` 当作密钥头示例（tests\models-sdk-catalog-commands.test.ts:15），models-service.ts:645 注释也承认「自定义请求头可能带密钥」。
**修复建议**：扩词表（`password|passwd|credential|auth`）或改为「默认回显为空、未填写则保留旧值」的保守策略；至少给 UI 加「此头已保存，留空保持不变」提示。
**最小失败测试**：写入 `{headers:{"X-Credential":"s3cr3t"}}` 的 models.json → `readCustomProviders()` 断言返回内容不含 `s3cr3t` 且 `secretProviderIds` 含该 provider。

### [QUESTION] .gitignore:1-36（防御性缺口，当前不构成泄露）

**问题**：`.gitignore` 没有覆盖 `web-secret`、`web-launch/`、`web-devices.json`、`web-revocations.json`、`models.json`、`auth.json`。
**触发条件**：仅当用户把 `PI_CODING_AGENT_DIR` 指进仓库目录（src\lib\web-secret.ts:32-36 支持）或把仓库克隆进 agent 目录时，这些 0600 状态文件才会出现在 git 视野内并被提交。
**期望行为**：密钥文件即使被重定向进仓库也不会进 git。
**实际行为**：默认路径在 `~/.pi/agent/`（仓库外），当前仓库树内经 glob 核实不存在任何此类文件，因此今天没有泄露；纯属配置重定向时的兜底缺失。
**证据**：.gitignore 全文（36 行，无 web-*/models.json/auth.json 条目）；src\lib\web-secret.ts:31-42、:118、:130-132；src\lib\web-launch-token.ts:79-81；src\lib\web-devices.ts:12。
**修复建议**：.gitignore 追加 `web-secret`、`web-launch/`、`web-devices.json`、`web-revocations.json`、`models.json`、`auth.json`（或 `/web-*`）。
**最小失败测试**：在仓库内创建 `web-secret` 文件，`git check-ignore web-secret` 应返回该路径。

---

## 测试夹具判定（非泄露）

| 位置 | 内容 | 判定依据 |
| --- | --- | --- |
| tests\fixtures\localhost-tls.ts:2 | 2048 位 RSA PEM 私钥 + 证书 | 仅被 tests\http-request-guard.test.ts:11 导入，用于本机回环 TLS 测试；自造夹具密钥、非真实凭据，发布测试证书是通行做法。仅建议：如担心被误当生产密钥，可改为测试启动时现场生成 |
| tests\models-sdk-catalog-commands.test.ts:15 | `apiKey:"literal-secret"`、`X-Credential: !command` | 写进临时目录（:11,16-18），断言 SDK 不执行命令、不落盘（:24-25） |
| tests\models-service-credentials.test.ts:65 | `resolved-key` | 内存桩 credential store |
| tests\models-service-discovery.test.ts:93,107 | `test-key` / `anthropic-key` | 打向本地 mock 服务 |
| tests\models-runtime-errors.test.ts:25 | `!should-never-run` | 断言命令前缀不执行 |
| tests\model-draft.test.ts:37 | `" test-only "` | 纯序列化断言 |
| tests\launcher.test.ts:525,529、tests\proxy-status.test.ts:21,30-31、tests\pi-settings.test.ts:219、tests\proxy-route.test.ts:8 | `alice:s3cret@…` 等代理 URL | 验证「对外展示前剥离凭证」逻辑本身（见下） |

## 各维度结论

**1. 硬编码凭证：未发现问题。** src/scripts/tests/docs/examples/.github/bin/根文件全量模式扫描零命中（唯一 `sk-` 命中即上述范围外缓存）；`.github/workflows/publish.yml:80` 正确使用 `secrets.NPM_TOKEN`，`RELEASING.md:29` 明令禁止入库；`remote-e2e.yml`、`check.yml` 无任何 token/secret 字样；src 无 Basic Auth、无 webhook、`discoverModels` 显式拒绝带用户名/密码的 baseUrl（models-service.ts:628）。

**2. 密钥落盘位置：符合预期。** 全部在 `~/.pi/agent/`（`PI_CODING_AGENT_DIR` 可重定向），仓库树内不存在：
- `web-secret`：32 字节随机，`wx` + mode 0600 创建（web-secret.ts:68-82）；也支持 `PI_WEB_SECRET` 环境变量（:89-95）。
- `web-launch/<port>.token`：0600（web-launch-token.ts:171-177），退出时且内容未被轮换才删除（:181-187），5 分钟 TTL 每 30s 轮换（:17、:159-170）。
- `web-revocations.json` / `web-devices.json`：临时文件 0600 + 原子替换（web-secret.ts:166-177；web-devices.ts:31-33）。
- `models.json`：临时文件 0600 + SDK 校验 + 修订号冲突检测 + rename（models-service.ts:1553-1580）。
- `backups/INDEX.md` 本次 diff 仅新增两条（.next-releases/active.json、release-tsconfig 备份），均非密钥文件，实体内容已抽查干净；backups/ 全目录 glob 无 web-secret/*.token/models.json/auth.json。

**3. 密钥进日志：未发现问题。** src 全部 40 处 console.* 逐一核对，均为错误对象/状态文案，无 token、无 `?token=` URL（proxy.ts:47,60、pair\route.ts:40 只打 error；instrumentation-node.ts:42 打的局域网地址不带令牌）；启动令牌只打印到用户自己终端并明示「令牌即凭据」（launcher.mjs:503-508），不写日志文件；`publicDiagnostic`（public-diagnostic.ts:4-8）先归一 OS 错误码、命令输出类直接吞掉、再截断 2048；`apiError`（api-error.ts:10-24）非校验错误一律返回固定文案，校验错误把本地路径替换为 `[local path]`；沙箱子进程环境剥离全部密钥类变量（windows-acl.ts:17-19、:490-496），第三方安装器环境走白名单（update-environment.mjs:22-26）。

**4. 密钥到浏览器：除 MEDIUM 头回显缺口外未发现问题。**
- apiKey / 密钥型请求头不再回显设置页（models-service.ts:1443-1458 → api/models\route.ts:40,73），`setKey` 不回显（route.ts:112-116），探测报错不含密钥与 URL（models-service.ts:680-720）。
- localStorage/sessionStorage 仅存主题、草稿、档位等 UI 偏好（usePiWeb.ts:607-617、AppShell.tsx:201-238、theme.ts:46-166 等），无任何凭据；HTML 内联脚本只有主题预置（layout.tsx:29）。
- 代理凭证：`publicProxy` 剥离 username/password 后才返回浏览器（proxy-status.ts:35-45；api\proxy\route.ts:8,21；测试覆盖 proxy-status.test.ts:21-31）。
- GitHub：只把 login/name/url/avatar 给前端，token 留在服务端（github-identity.ts:26-31、:138-159）。
- 会话 Cookie：httpOnly + sameSite=strict + https 下 secure，值是 HMAC 签名载荷而非可离线爆破的凭据（web-auth.ts:141-149、web-auth-shared.ts:10-16）。
- 启动令牌换 Cookie：只认根路径 GET、单一 token 参数，成功或失效都 303 到去查询串的根地址（proxy.ts:39-55、:82-90）；扫码配对是内存态一次性 120 秒短码 + 双向限流（pairing.ts:16-27、:69-114），二维码里不含长期令牌。
- 备注（非发现）：`GET /api/config` 按设计整份下载用户自己的 `~/.pi/agent/settings.json`（config\route.ts:9-19），若用户在其中写了带凭证的 httpProxy，会随附件回浏览器——已登录同源场景，属功能本身；`full` 权限档的 agent 命令等同用户信任、可读 env/文件，沙箱档（readonly/workspace）已剥离密钥环境变量。

**5. .gitignore 与备份索引：** `.env*`（放行 .env.example，当前不存在）、`*.log`、`backups/*`（放行 INDEX.md）、`node_modules/` 均已覆盖；仓库树内无 .env、无 .token、无密钥文件；新文件 `PiWeb_Permissions_Review_2026-11-13.md` 不匹配任何 ignore 规则（可提交），已扫描确认无凭证内容；INDEX.md diff 无密钥路径（见维度 2）。缺口仅 QUESTION 一条（防御性条目）。

## 覆盖清单

- 深读（逐行）：web-secret.ts、web-launch-token.ts、web-devices.ts、web-auth.ts、web-auth-shared.ts、web-auth-protocol.mjs(.d.mts)、proxy.ts、pair\route.ts、api\web-auth\route.ts、api\remote\pair\route.ts、remote\pairing.ts、models-service.ts（密钥相关段 :623-725、:737-846、:1443-1658）、api\models\route.ts、api-error.ts、public-diagnostic.ts、proxy-status.ts、api\proxy\route.ts、api\config\route.ts、api\github\route.ts、github-identity.ts、instrumentation-node.ts、update\startup-check.ts、sandbox\windows-acl.ts / bash-operations.ts（环境剥离段）、remote\supervisor.ts / mobile-proxy.ts（grep 定位）、launcher.mjs（:69-160、:354-380、:495-570）、http-request-guard.mjs、check-installed.mjs、remote-engine.mjs、update-environment.mjs、build.mjs、file-lock.mjs、process-runner.mjs、web-secret/web-devices 相关测试、localhost-tls 夹具及全部 apiKey 夹具测试。
- 模式全量扫描（零命中即整文件过一遍模式）：diff+untracked 全部 ~380 个文件按目录分组跑凭证/日志/浏览器存储 grep（src 24+42+40 处命中全部人工核对为误报或良性）。
- 密钥残留专项：以缓存密钥前缀对全树（含 -Force 隐藏与被忽略目录，~4700 文件）扫描，唯一命中见 MEDIUM #1。

## 未追踪清单（未逐行深读、仅模式扫描，共约 345 个）

UI 组件与样式约 150 个（src\components\**、globals.css、i18n.tsx、theme.ts、icons.tsx 等）、session-import 解析器 12 个、其余 lib/hooks/app 路由约 60 个、测试约 120 个。上述均完成凭证模式、console 输出、localStorage/sessionStorage 三类扫描且零命中；其中不排除存在与凭证无关的其它问题（不在本次猎取目标内）。专项说明：session-import/* 处理的是用户导入的历史会话内容，其"密钥"来自会话原文，属数据搬运而非代码泄露，未逐行审。

## 建议动作（按优先级）

1. 删除 `node_modules\.cache\piweb-metrics\`，必要时轮换 `metapi.lilililwan.xyz` 的 key。
2. 扩大自定义请求头脱敏词表或改为默认不回显（MEDIUM #2 的最小测试可加进 tests\models-service-config.test.ts）。
3. .gitignore 追加 web-secret / web-launch/ / web-devices.json / web-revocations.json / models.json / auth.json 兜底。
