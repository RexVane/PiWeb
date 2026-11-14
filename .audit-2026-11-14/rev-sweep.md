# rev-sweep — 漏网变更文件完整性核查（2026-11-14）

只读静态分析。变更全集 = `git diff --name-only` ∪ `git ls-files --others --exclude-standard`（另用 `git diff HEAD --name-only` 复核，两者一致，无仅暂存改动）。已排除 .audit-2026-11-13/、.audit-2026-11-14/、node_modules、package-lock.json、PiWeb_Permissions_Review_2026-11-13.md，并扣除已认领 pathspec（src/app/api/、src/app/pair/、src/lib/、src/components/、src/hooks/、src/app/page.tsx、src/app/layout.tsx、src/app/globals.css、src/i18n.tsx、scripts/、bin/、.github/、next.config.ts、package.json、vitest.config.ts、tests/、examples/、docs/extension-web-ui.md、docs/workspace-isolation.md、backups/INDEX.md）。

## 漏网文件清单（4 个）

| 路径 | 分类 | 状态 | 风险一句话 |
|---|---|---|---|
| src/proxy.ts | source | 已跟踪改动 | 认证网关多处变更：matcher 新排除 `api/files/upload`、PUBLIC_PATHS 增加 `/pair`、启动令牌改为一次性消费、新增设备记忆与 revocations 不可用即 503 fail-closed；upload 路由已自带等效防护（见 NOTES），整体安全方向为收紧 |
| src/instrumentation-node.ts | source | 已跟踪改动 | 启动钩子：认证改为默认开、自动生成 PI_WEB_LAUNCH_TOKEN、新增自动化调度器启动、`startLan` 升级为 `ensureRemoteAccess`（生产启动自动准备局域网入口+公网隧道），见 QUESTION |
| README.md | docs | 已跟踪改动 | 远程访问章节重写（二维码配对、认证默认开、自动隧道），与本次代码变更一致，纯文档 |
| README_zh.md | docs | 已跟踪改动 | 同上中文版，与英文版语义一致，纯文档 |

### 分类计数

- source：2（src/proxy.ts、src/instrumentation-node.ts）
- test：0
- docs：2（README.md、README_zh.md）
- config：0
- other：0
- **合计：4**

重点候选核查结果：src/proxy.ts ✅存在已审；src/instrumentation-node.ts ✅存在已审；src/middleware* 不存在；src 根其余文件无改动（src/ 下漏网的只有上述 2 个）；public/ 无变更文件；根目录 *.d.mts、tsconfig/eslint 无变更；.github 以外根目录文件改动仅 README.md、README_zh.md（next.config.ts、package.json、vitest.config.ts 已被认领）。

## 已认领但按重点要求复核的内容

- **backups/INDEX.md diff**：仅追加 2 行（2026-11-13 17:16:47 备份 .next-releases/active.json 与 tsconfig.json），格式符合「时间 | 原路径 | 存放位置 | 原因」，只追加未改旧行。未发现问题。

## NOTES（跨边界核实，非发现）

1. **proxy.ts:93 matcher 新排除 `api/files/upload$`**：该路径从此不过网关（无 Host 校验/同源校验/认证）。已核实 `src/app/api/files/upload/route.ts:13,15` 自行实现了 `isSafeHost`+`isSafeOrigin`（403）与 `authEnabled()+validSessionCookie`（401），防护等效。路由文件归 src/app/api/ 分片，此处仅确认网关排除未被遗漏防护。
2. **proxy.ts:10 PUBLIC_PATHS 增加 `/pair`**：配对入口免认证（短码即凭据），与 README「二维码 120 秒一次性 256 位凭据」一致；短码实现与限速归 src/app/pair/ 分片。

## Findings

### [QUESTION] src/instrumentation-node.ts:40
**问题**： 生产启动默认自动拉起公网 Cloudflare 快速隧道，默认网络暴露面从「本机」扩大为「局域网 + 公网」。
**触发条件**： 生产模式启动（非 `phase-production-build`、非 dev），认证已启用（本变更后 `PI_WEB_AUTH` 未设时默认置 "1"，src/instrumentation-node.ts:12），且未设 `PIWEB_REMOTE_LAN=0`（`remoteLanEnabled` 默认 true，src/lib/remote/supervisor.ts:261）→ `ensureRemoteAccess()` 自动启动 `0.0.0.0:30142` 局域网反代并准备公网隧道。
**期望行为**： 若属有意设计（README.md/README_zh.md 本次已同步改写为「生产启动自动准备本地代理与 Cloudflare 快速隧道」「认证默认启用」），仅需 owner 确认该默认值对所有部署场景（含无人值守的服务器部署）可接受。
**实际行为**： 只要用户启用过局域网入口（或从未关闭，即默认），每次生产启动都会自动创建公网可达 URL（TLS 终结在 Cloudflare），并有自动重试重建（supervisor.ts:501）。
**证据**： src/instrumentation-node.ts:26-45；src/lib/remote/supervisor.ts:187-191、260-261、501；README.md diff「Production startup automatically prepares the local proxy (0.0.0.0:30142) and a Cloudflare quick tunnel (cloudflared)」。
**修复建议**： 确认为有意后关闭本条；如需保守默认，可将隧道改为显式开关（如 `PIWEB_REMOTE_PUBLIC=1`），保留 `PIWEB_REMOTE_LAN=0` 作局域网退路。
**最小失败测试**： 无法以只读方式执行；建议形态：设 `PIWEB_REMOTE_LAN` 未设、`NODE_ENV=production` 启动构建产物，断言存在 outbound cloudflared 子进程（若期望默认不开则此测试失败）。

（其余漏网文件未发现需按此格式报告的问题。）

## 结论

- 漏网文件共 **4** 个：source 2、docs 2、test 0、config 0、other 0。
- **无 CRITICAL、无 HIGH**；1 个 QUESTION（见上）。
- 变更全集扣除已认领 pathspec 后无其他遗漏；未跟踪文件中除已排除的审计目录/评审文档外全部落入已认领目录（scripts/、.github/、examples/、docs/、src/app/api/、src/app/pair/、src/components/、src/lib/、tests/）。
