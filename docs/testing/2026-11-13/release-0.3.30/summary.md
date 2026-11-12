# 0.3.30 本地发布与代理验收

- 时间：2026-11-13 01:30–01:45 +08:00
- 环境：Windows，Node 24.12.0，仓库工作树在 `faf1cad`
- 发布命令：`npm run build:release`
  - 构建目录：`.next-releases/mwdtqifv-a1a78057-23c2-4123-9fb5-e93a3132aed3`
  - buildId：`lOHqk7fKtc3YWA-3iM-Dc`
  - `.next-releases/active.json`：`state: ready`，`version: 0.3.30`
  - 构建内检查：`npm run check`（`tsc --noEmit` + 全量 vitest + `next build`）退出码 0
- 启动验收：`node bin/piweb.js -p 3999 --no-open`（start 模式，启动令牌认证开启）
  - 启动日志：`[piweb] 模型请求走代理 http://127.0.0.1:7897（来自系统代理）`
  - `/api/health` 首次探测 1.5s 内返回 `{"ok":true,"service":"piweb"}`

## 代理接口实测

| 请求 | 结果 |
|---|---|
| `GET /api/proxy` | `source: system`，`http`/`https` = `http://127.0.0.1:7897` |
| `POST /api/proxy {"proxy":""}`（跟随自动检测） | `ok: true`，879ms，HTTP 204 |
| `POST /api/proxy {"proxy":"http://127.0.0.1:7897"}`（手动地址） | `ok: true`，748ms，HTTP 204，`source: manual` |
| `POST /api/proxy {"proxy":"http://127.0.0.1:1"}`（死端口） | `ok: false`，`code: unreachable`，103ms |
| `POST /api/proxy {"proxy":"not-a-url"}`（非法地址） | `ok: false`，`code: invalid`，0ms |

外网目标为 gstatic 的 204 探测（`testProxyConnection`），结果码取自实际 HTTP 状态。

## 未覆盖

- 设置面板的浏览器目视验收：启动令牌只打印在启动它的终端里，本次用终端令牌换取会话 Cookie 后走 API 验收；界面点选留给用户在浏览器里做。
- npm 发布与 GitHub Release 未执行（`publish.yml` 由发布流程触发，本次只做本地激活）。

## 复现

```powershell
npm run build:release
node bin/piweb.js -p 3999 --no-open   # 终端会打印带 token 的登录链接
# 用该链接换 Cookie 后：GET /api/proxy；POST /api/proxy {"proxy":""}
```
