# 安装与构建机制

维护日期：2026-11-20。适用于当前源码（`0.3.35`）。发布包内容与版本号以 `package.json` 为准；历史验证记录属于工程档案，只保留在本机。

## 两种安装形态

| 形态 | 判断方式 | 生产构建从哪来 |
| --- | --- | --- |
| **源码检出**（`git clone` + `npm ci`） | 安装了 `vitest`/`jsdom` 等开发依赖，`isProductionOnlyInstall()` 为 false | 包内不保证有 `.next`；`npm run build` / `npm run build:release` 现场构建。没有生产构建时 `piweb` 只在本机回退开发模式（对外监听会直接拒绝启动）。 |
| **生产安装**（`npm install -g @rexvane/piweb`，或 `--omit=dev`） | 全局安装或没有开发依赖 | 正常从 npm 安装时，发布包自带已封存的 `.next`（`package.json` 的 `files` 包含 `.next`），直接复用；只有构建缺失/不完整时才在首次使用时现场构建一次。 |

## `postinstall` 钩子与首次启动自愈

`package.json` 的 `postinstall` 是 `node scripts/postinstall.mjs`，它调用
[`scripts/install-build.mjs`](../../scripts/install-build.mjs) 的 `ensureInstallBuild()`。该函数的实际顺序是：

1. 设置 `PIWEB_SKIP_INSTALL_BUILD=1` → 直接跳过；
2. 已经存在通过启动器校验的生产构建（`.next-releases/active.json` 指向的构建，或可用的 `.next`）→ 跳过；
3. 不是生产专用安装（源码检出有开发依赖）→ **no-op**，不构建；
4. 生产专用安装且没有可用构建 → 在安装目录之外的同盘 staging 目录执行一次生产构建，把产物封存进 `.next-releases/<id>`、写 `active.json`/`last-ready.json` 后切换。

因此：

- **源码检出里 `postinstall` 是 no-op**。用 `--ignore-scripts` 安装不会影响源码检出的构建/启动（构建仍是 `npm run build`，启动仍会按需回退 dev 模式）。
- **生产安装会自愈**：如果安装过程跳过了生命周期脚本（`--ignore-scripts`）或包里的构建不完整，第一次运行 `piweb` 会先完成一次现场构建再启动（`scripts/launcher.mjs` 在探测/复用已有实例之前调用 `ensureInstallBuild`）。这次首次启动会明显变慢（见下节构建时长）。
- 构建失败不会替换正在服务的旧构建：失败标记写进 `.next-releases/<id>.owner.json`，旧构建保留；重试命令：

  ```bash
  npm rebuild -g @rexvane/piweb
  ```

  常见失败原因：安装目录属主不是当前用户（例如曾用 `sudo` 安装，启动器会直接给出提示和修复命令）、磁盘空间不足、Windows 文件被占用。
- 发布构建的保留数量有上限（默认成功构建 10 个、未完成/失败构建 3 个，见[环境变量](environment.md#构建与发布)）。达到上限会拒绝新构建而不是自动删除旧构建，需要人工归档。

## 构建时长与超时基线

2026-11-15 审计在同一台机器上实测：

| 操作 | 命令 | 实测耗时 |
| --- | --- | --- |
| 生产构建 | `npm run build`（`next build --webpack`，脚本内置 `--max-old-space-size=8192`） | **370.4 秒（约 6 分 10 秒）**，并发负载下完成，退出码 0 |
| 打包安装校验 | `npm run verify:package`（打包 → 空 prefix 安装 → 安装后生产启动） | 约 190 秒（含 npm 网络安装，受镜像影响） |
| 全量测试 | `npm run test` | 数分钟到十几分钟，随机器与并行度变化 |

- 上一轮曾把构建超时设为 600 秒，在并发负载下被误判为“卡死”；**本地/CI 的构建超时建议 ≥ 15 分钟**，包含 `typecheck`、全量测试和构建的完整 `check` 任务建议 ≥ 30–45 分钟。当前 CI 的 `check` 作业已设 45 分钟。
- 首次安装自愈构建与上面的生产构建同量级（也在 6–15 分钟区间），部署时不要把首次启动的健康检查超时设得过短。
- 构建进度只打印少量 `[piweb]` 前缀行；Next 的编译输出由脚本收集，失败时回显末尾，成功时保持安静。需要完整输出（CI 排障）时设 `PIWEB_BUILD_VERBOSE=1`。排障时优先看退出码与 `.next-releases` 下的失败标记。

## 部署健康检查

- **liveness**：`GET /api/health` 保持原样，返回静态 `{ ok: true, service: "piweb" }`，不查依赖、不泄露内部状态，用于“进程是否活着/端口是否可连”。匿名可访问。
- **readiness**：`GET /api/health/readiness` 在 liveness 之外检查数据目录可写（真实写探针文件）、`settings.json`/`models.json`/`auth.json` 可解析，并报告自动任务调度器状态。任一核心检查失败返回 **503** 和可读原因（`not ready: …`）；调度器停转只作为 `warnings` 报告，不把实例判为未就绪。该路由受启动令牌/会话 Cookie 保护（`proxy.ts` 只匿名放行精确路径 `/api/health`），监控端需要带认证（本机可再次运行 `piweb` 获取登录凭据，或接入自己的 Cookie）。

容器/反向代理的探针建议：liveness 用 `/api/health`；就绪/滚动更新用带认证的 `/api/health/readiness`，并把首次安装自愈构建的时间窗口算进去（见上节）。

## 开发与验证

在独立检出或暂存目录验证：`npm run build`/`npm run build:release` 会写构建输出，不要对正在服务的安装目录执行。

```bash
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run verify:package
```

源码检出若从 PiWeb 子进程或其他生产环境运行安装命令（继承了 `NODE_ENV=production`），请使用 `npm ci --include=dev`，否则 npm 默认跳过测试工具等开发依赖。

根包锁定 TypeScript 7，`next.config.ts` 显式启用 `experimental.useTypeScriptCli`：Next 构建仍执行完整类型检查，但调用原生编译器 CLI，不依赖 TypeScript 6 的旧 JavaScript 编译器 API。

`npm run lint` 使用 `scripts/testing/lint/` 下独立锁定的 ESLint 工具链（根包的 TypeScript 7 与 typescript-eslint 尚不兼容）：第一次运行会自行安装该工具链，CI 里先执行 `npm ci --prefix scripts/testing/lint` 并设 `PIWEB_LINT_SKIP_INSTALL=1`，让 lint 步骤本身无法联网安装。CI 还会在 ubuntu/Node 24 上跑 `npm audit --audit-level=high`、检查意外跳过、并用 `PIWEB_COVERAGE=1` 开启覆盖率；macOS 只跑平台敏感子集。真实公网隧道使用单独的 `PIWEB_TEST_TUNNEL=1` 显式开关。完整发布流程见 [.github/RELEASING.md](../../.github/RELEASING.md)。

## 全量安装后的目录

- 安装目录：npm 全局前缀下的 `@rexvane/piweb`，其中 `.next` 为当前发布构建；`.next-releases/<id>` 为隔离构建与回退候选。
- 用户数据：默认在 `~/.pi/agent`（可用 `PI_CODING_AGENT_DIR` 指定），但这不是全部数据根，见[数据目录、隐私与留存](data-and-privacy.md)。
