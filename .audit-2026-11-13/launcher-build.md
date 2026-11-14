# 启动器 / 构建 / 发布 / 打包 / CI 审计报告

审计人：audit-launcher（task-16）　日期：2026-11-13　基线：`npx tsc --noEmit` 干净、`vitest` 204 文件 1648 测试全绿（312s）
工作区有 145 项未提交改动，本报告按**当前磁盘状态**审计。本区域相关的未提交改动只有 3 个文件：`README.md`、`package.json`（新增 `optionalDependencies.koffi`、`ignore`、`qrcode`、`yaml`）、`scripts/launcher.mjs`（认证默认值从"仅暴露时开"改成"始终开"，删掉了 `isOffFlag`）。

## 0. 覆盖范围

### 读了什么

| 文件 | 行数 | 备注 |
|---|---|---|
| `bin/piweb.js` | 12 | 入口，只做 `runLauncher()` + 错误打印 |
| `bin/pi.js` | 50 | `pi web` 转发 + `pi` 原样转发 |
| `scripts/launcher.mjs` | 545 | 核心：参数、端口、计划、代理、预热、子进程 |
| `scripts/build-output.mjs` | 150 | 构建产物选择/校验、路径逃逸防护 |
| `scripts/install-build.mjs` | 224 | 一次性安装构建（staging） |
| `scripts/release.mjs` | 192 | `build:release` 事务、锁、清单状态机 |
| `scripts/process-runner.mjs` | 60 | 子命令执行、超时、树杀 |
| `scripts/verify-package.mjs` | 102 | 发布闸门（真 tarball + 干净全局安装） |
| `scripts/dev.mjs` / `entrypoint.mjs` / `postinstall.mjs` | 16 / 8 / 11 | 强制 `--dev --no-open` / `isMainModule` / postinstall |
| `scripts/apply-global.mjs` | 87 | 本机专用：把 src 同步进全局安装并重建 |
| `scripts/system-proxy.mjs` | 48 | 读注册表代理 |
| `scripts/sync-file-icons.mjs` / `sync-provider-icons.mjs` | 118 / 41 | 图标生成（写 `public/`、`src/lib/file-icons.json`） |
| `scripts/pick-folder.ps1` | 110 | 纯 ASCII + UTF-8 输出契约 |
| `scripts/runtime/pi-packages.mjs` / `check-installed.mjs` | 52 / 71 | pi 版本钉死 / 装完自检 |
| `scripts/testing/prepare-sdk-tools.mjs` | 19 | CI 预取 fd/rg |
| `next.config.ts` / `tsconfig.json` / `package.json` | 55 / 50 / 103 | distDir 策略 / include / files·scripts·engines |
| `.github/workflows/check.yml` / `publish.yml` / `dependabot.yml` / `RELEASING.md` | 35 / 106 / 16 / 33 | CI 与发布手册 |
| `README.md`（60–149 行 + 全库 grep） | 189 | 安装/更新/运行/代理说明 |
| `.gitignore` | — | `.next*`、`.next-releases/` 全部忽略 |
| `tests/launcher.test.ts` | 535 | 36 个 `it` |
| `tests/install-build.test.ts` | 57 | 只测 staging 目录布局 |
| `tests/packaging.test.ts` | 195 | 打包契约 + 真 tarball |
| `tests/source-encoding.test.ts` / `powershell-encoding.test.ts` | 33 / 21 | UTF-8 边界 |
| `tests/integration/pi-runtime.test.ts` | 74 | pi 版本一致性 |
| `tests/update-service.test.ts`（60–209）/ `update-service-process.test.ts` | 392 / 126 | `prepareRelease` 全链路（mock `run`）、`runCommand`/`openBrowser` |
| 交叉参考：`src/instrumentation-node.ts`(46)、`src/lib/web-launch-token.ts`(54)、`src/lib/update-service.ts`(150–242)、`src/lib/sandbox/manager.ts`(25–64)、`src/lib/remote/supervisor.ts`(grep) | — | 只读，用于确认启动时副作用与端口占用 |

现场只读核对（未改任何东西）：`Get-CimInstance Win32_Process`（PID 链）、`Get-NetTCPConnection`、`GET /api/health`、`.next-releases` 目录树与 `required-server-files.json`、`.pi/agent/web-launch/*.token`、`git status/diff`。

**跳过的**：`node_modules/@earendil-works/*`（BRIEF 规定）、`src/app/api/**` 与 `src/lib/remote/*` 实现细节（归 API/remote 区域）、`docs/` 全文（只 grep 了安装/发布相关词）、`examples/`（不属本区域）。

### 现场事实核对（与任务书给的两条基线对照）

1. **30141 上跑的确实是开发模式**，但父进程不是 `node scripts/dev.mjs`：实际 PID 链是 `powershell.exe(37776) → node bin/piweb.js --dev(6032) → node .../next dev --webpack -p 30141 -H 127.0.0.1(30272) → next/dist/server/lib/start-server.js(21992)`。也就是说它是被 IDE/终端直接以 `bin/piweb.js --dev` 起来的，`scripts/dev.mjs` 没参与（`dev.mjs:7-9` 的 `runDev` 只是把 `--dev --no-open` 塞给 `runLauncher`）。`GET /api/health` 返回 `{"success":true,"data":{"ok":true,"service":"piweb"}}`，与 `isPiWebRunning` 的判据一致（`launcher.mjs:301`）。
2. **生产构建本来是好的**：`.next-releases/active.json` 状态 `ready`，指向 `.next-releases/mweslqtb-…`（buildId `V16ZP5Q6rLBrwsSLUXQL0`，version 0.3.30，17:52 构建完成），该目录 305 个文件齐全；仓库根的 `.next`（buildId `Nx1uSvhykceHgB8Og8_Lc`）21 个必需清单也齐全。所以"release 目录被清掉"不是当前磁盘状态，而是历史上的操作事故。
3. **`piweb-runtime-*.mjs` 这个文件名无法复核**：全仓（含被 gitignore 的目录）只有 `.next-releases/piweb-runtime-20261113-1717.json/.log` 两个**探针产物**（内容是 `{pid,mode:"production",port:30141,buildDir,buildId,serverPid,exitCode:4294967295,stoppedAt}`，其中 token 已被 `[REDACTED]`），没有任何 `.mjs`；本机 release 产物里 `.mjs` 数量为 **0**（Webpack 构建只产出 `.js`）。所以报告里凡是涉及 MODULE_NOT_FOUND 的结论，我都只声明**机制**（见 P1-1），不声明具体文件名。

### 结论一览

| 子功能 | 结论 | 依据 |
|---|---|---|
| `piweb` 参数解析与校验 | OK | `scripts/launcher.mjs:191-213`（未知参数直接抛、hostname/public-url 白名单校验），`tests/launcher.test.ts:154-168` |
| 端口选择 / 占用 / 已有实例复用 | OK-但脆弱（P2-2） | `launcher.mjs:427-445` |
| 生产 vs 开发模式判定 | OK（设计内，见 P3-4 的次序瑕疵） | `launcher.mjs:221-257`、`scripts/dev.mjs`、`next.config.ts:34-47`、现场 PID 链 |
| 生产构建选择与完整性校验 | **有问题（P1-1、P2-6）** | `scripts/build-output.mjs:79-108` |
| `.next` 缺失/损坏时的行为 | OK-但脆弱（P2-6、P2-7） | `build-output.mjs:141-149`、`install-build.mjs:24-32` |
| 生产/开发模式切换与回退 | OK（本机回环允许回退 dev，对外监听拒绝回退） | `launcher.mjs:227-237` + `tests/launcher.test.ts:102-113` |
| 一次性安装构建（staging 构建） | **有问题（P1-2、P2-7）** | `scripts/install-build.mjs:163-224` |
| 发布流程（`build:release` 事务） | OK-但脆弱（P2-1、P2-3） | `scripts/release.mjs:119-164`、`tests/update-service.test.ts:73-144` |
| npm 包自洽性（files/bin/engines/koffi/postinstall） | OK（附条件：见 P2-4） | `package.json:23-102`、`scripts/verify-package.mjs` |
| CI（Windows 覆盖 / 矩阵 / 缓存 / `npm ci`） | OK-但脆弱（P2-4、P2-5） | `.github/workflows/check.yml`、`publish.yml` |
| 脚本里的危险操作（递归删 / 强杀 / 路径拼接） | 一处有问题（P1-2），其余 OK | `install-build.mjs:184-187`、`process-runner.mjs:4-17`、`apply-global.mjs:72-86` |
| 编码（GBK 控制台 / 中文路径 / 空格路径） | OK | `scripts/pick-folder.ps1:5-15`、`launcher.mjs:502-504`、`tests/source-encoding.test.ts`、`tests/powershell-encoding.test.ts` |
| 测试覆盖（指定 6 个文件） | OK-但脆弱（缺 P1-1 类断言，见第 2 节） | 见上表 |

## 1. 发现（按严重度降序，同级按影响降序）

本区域无 P0。

### P1-1 生产构建完整性自检只校验 21/305 个文件，残缺构建会被判"可用"并报"就绪"

- **位置**：`scripts/build-output.mjs:88-108`（必查清单在 99-106）
- **证据**：

```js
// build-output.mjs:70-77 自检的目的就写在注释里
/**
 * A truncated .next (package built without the runtime manifests, or an interrupted
 * build) leaves BUILD_ID behind, so the raw ENOENT names a file the user cannot act on.
 */
...
// build-output.mjs:99-106
for (const mandatory of ["BUILD_ID", "routes-manifest.json", "build-manifest.json", "prerender-manifest.json", "server/app-paths-manifest.json"]) {
    files.add(`${buildDir}/${mandatory}`);
}
for (const file of files) {
    if (!file.startsWith(`${buildDir}/`)) throw new Error(`invalid required build file: ${file}`);
    const target = assertLocalPath(root, file);
    if (!fs.statSync(target).isFile()) throw new Error(`missing required build file: ${file}`);
}
```

  本机实测数据（只读）：当前 ready release `.next-releases/mweslqtb-…` 去掉 `cache/`、`diagnostics/`、`types/` 后仍有 **305 个文件**（`server/` 下 117 个 `.js`，含全部路由 chunk），而它自己的 `required-server-files.json.files` 只有 **21 条**：20 个清单 + `server/instrumentation.js`，**不含任何路由 chunk**；仓库根 `.next` 同样只有 21 条（该目录有 158 个 js/mjs）。按文件数算，校验覆盖率约 **7%**。
- **触发路径**：用户为了腾磁盘删掉 release 目录里的部分内容（或构建机磁盘满导致拷贝截断、或误删 `server/**` 某个子目录）→ 运行 `piweb` → `selectProductionBuild`（`build-output.mjs:117-140`）→ `readProductionBuild` 全部通过 → `launcher.mjs:502` 起 `next start` → Next 启动只读清单，正常 → 启动器打印 `[piweb] 就绪：…`（`launcher.mjs:522`）→ 用户点开某个页面/接口时，该路由 chunk 被动态加载 → `Cannot find module '<abs>/.next-releases/<id>/server/...'`。
- **后果**：启动阶段"看起来成功"，故障延迟到用户操作时才出现，且报错指向构建产物内部路径；用户拿不到"构建被删了，请重跑 `npm run build:release`"这类可操作信息。本机历史上确实出现过"release 目录被清掉 + `MODULE_NOT_FOUND`"这一类事故，而这条校验正是本该拦住它的那道闸门——它拦不住 chunk 级残缺。
- **置信度**：已确认（读了完整链路 + 用本机真实 `required-server-files.json` 与其目录文件数对账）；唯一无法复核的是原始报错里那个 `.mjs` 文件名（本机产物 0 个 `.mjs`，全库也没有 `piweb-runtime-*.mjs`），见第 0 节第 3 条。
- **建议修法**：最小改动是在 `readProductionBuild` 内对 `${buildDir}/server/**/*.js`（或构建期写一份 `build-files.json`：相对路径 + 字节数，随产物进 `files` 白名单）做一次存在性 + 大小检查。本地 305 个 `stat` 的成本可以忽略；若担心慢，可只查 `server/app/**/route.js`、`server/chunks/*.js` 与 `server/webpack-runtime.js`。

### P1-2 一次性安装构建用"先删后拷"替换正在服务的 `.next`，且失败无回滚

- **位置**：`scripts/install-build.mjs:184-187`
- **证据**：

```js
const target = path.join(root, ".next");
fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
fs.cpSync(path.join(staging, ".next"), target, { recursive: true });
return fs.existsSync(path.join(target, "BUILD_ID"));
```

  对照：`release.mjs` 全程用"新目录 + 原子写清单"（`release.mjs:43-54, 130-156`）；`apply-global.mjs:72-86` 至少是"rename 旧 → 建新 → 失败 rename 回来"。只有这里是**直接删掉服务的输出目录再拷**，`cpSync` 没有 temp+rename，也没有旧产物兜底。
- **触发路径**：production-only 安装（`isProductionOnlyInstall` 为真）且 `hasProductionBuild` 为假时，`ensureInstallBuild` 会跑完整构建（`launcher.mjs:407-420`）。(a) 服务正在跑，用户执行 `npm rebuild -g piweb`；(b) 服务正在跑，用户再起一个 `piweb -p 30150`，而 `.next` 因为上次拷贝中断被判"不完整"；(c) postinstall 在包目录里跑（`scripts/postinstall.mjs:11`）。三种都会在构建完成后进入这行 `rmSync`。
- **后果**：Windows 上若能删就整目录消失；`cpSync` 中途失败（磁盘满、被杀、权限）→ `.next` 半残。因为 21 个清单在拷贝序里通常较早落地，下一次启动会命中 P1-1，把半残产物当"可用"直接服务；若 `rmSync` 自己因 EBUSY 抛错，异常一路冒到 `bin/piweb.js:8-11`（只打 `message`）或 postinstall 顶层（未捕获 → `npm i -g` 直接失败）。同时，正在运行的实例会在下一次懒加载 chunk 时崩——这就是"删掉运行目录"这条风险的实现处。
- **置信度**：已确认（读了 `buildInStaging`/`ensureInstallBuild`/`runLauncher` 完整调用链）。运行验证需要破坏性操作，未做。
- **建议修法**：改成 `staging/.next` → `<root>/.next.new-<ts>` → `rename(.next → .next.old-<ts>)` → `rename(.next.new → .next)`；任一步失败就把 `.next.old` rename 回来。`rename` 是原子目录切换，旧产物保留到下一次成功启动再删。

### P2-1 构建失败不回到上一个 ready 清单，把完全可用的旧版本一起罚死

- **位置**：`scripts/build-output.mjs:125-140`；`scripts/release.mjs:157-163`
- **证据**：

```js
// build-output.mjs:128-130
if (manifest?.schema !== 1 || manifest.state !== "ready") {
    throw new Error("release is incomplete or failed; finish npm run build:release before restarting (no stale-build fallback)");
}
// release.mjs:157-163
} catch (error) {
    if (started) {
        try { await atomicJson(installation, RELEASE_MANIFEST, { ...state, state: "failed", finishedAt: new Date().toISOString() }); }
        catch { /* The previously persisted building state still blocks stale fallback. */ }
    }
    throw error;
} finally { await releaseLock(); }
```

- **触发路径**：UI「更新」（`src/lib/update-service.ts:203` 调 `prepareRelease`）或 `npm run build:release` 在任意阶段失败：`git pull` 冲突、`npm install` 失败、typecheck/test 失败（`release.mjs:150` 跑的是 `npm run check`，含 312s 全量测试 + 构建，失败面很大）、Ctrl+C（`release.mjs:167-170` 主动 abort）。
- **后果**：**旧 release 目录仍然完整存在于磁盘上**（`prepareRelease` 从不删旧目录），却因为 `active.json` 变成 `failed` 而无法启动。用户看到的操作是"我更新失败了 → 服务重启起不来"，唯一出路是再跑一次 6 分钟以上的构建。`state: "building"` 更糟（进程被 SIGKILL/断电时清单停在 building）：启动器会一直拒绝，直到有人手动重跑。
- **置信度**：已确认（代码 + `tests/update-service.test.ts:94-101,123-131` 把"failed 后拒绝启动"作为**预期**钉住了，说明这是有意设计）。这是"避免拿旧代码配新依赖"的保守取舍，但代价是可用性。
- **建议修法**：ready 时同时写 `active.prev.json`（上一次 ready 的 `{buildDir,buildId,version}`）；失败/中断时恢复 `active.prev.json`，仅在**首次**发布（无 prev）时保持 fail-closed。README/错误文案里补一句"上一个可用版本会继续被使用"。

### P2-2 没有单实例保护：慢启动窗口内的第二次启动会在相邻端口静默起第二个实例

- **位置**：`scripts/launcher.mjs:427-445`
- **证据**：

```js
for (let attempts = 0; ; attempts += 1) {
    const state = await checkPort(port, options.hostname);
    if (state === "free") break;
    if (state !== "busy") throw new Error(...);
    const url = localUrl(options.hostname, port);
    if (await checkHealth(url)) { ...return 0; }        // 只探一次，超时 1.5s
    if (attempts >= 50 || port >= 65535) throw new Error(...);
    log(`[piweb] 端口 ${port} 被占用，尝试 ${port + 1}`);
    port += 1;
}
```

  （引文中 `...` 为省略：`throw new Error(...)` 两处的文案、`if (await checkHealth(url))` 块内的日志/开浏览器/`return 0`）

  `isPiWebRunning` 只做**一次** 1.5s 探测（`launcher.mjs:271-305`），失败即当"别人的端口"。
- **触发路径**：(a) 用户连点两次 `piweb`（或两个终端各起一次），第一次还在 `next start` 冷启动/预热窗口（本仓实测首屏预热要等管线，`launcher.mjs:319-341` 的注释记录了 2.4~3.3s 的模块加载成本）→ 第二次探测 health 失败 → 起在 30142；(b) 用户显式 `piweb -p 30150`（README 把这当普通选项，没有"已有实例"提示）。
- **后果**：两个 PiWeb 服务同时存在，共享同一个 `~/.pi/agent`；第二个实例的 `instrumentation-node.ts:21-24` 会再起一套启动检查与**自动化调度器**；生产模式下两者都尝试占用 `DEFAULT_LAN_PORT = 30142`（`src/lib/remote/supervisor.ts:24`），后者报错；同一条会话被两端同时打开时的 JSONL 并发写风险需要 bridge 区域确认（见第 3 节）。唯一被兜住的是"同一任务重复跑"：`automations/store.ts:45-48` 用 `process.kill(pid,0)` 判定 owner 存活。
- **置信度**：已确认（端口/复用逻辑读完整链路）；"会话文件并发写会不会坏"需跨区确认，未验证。
- **建议修法**：在 `createLaunchPlan` 之后、探测之前读一份实例登记（`<agentDir>/web-launch/instances.json` 或复用 `<port>.token` 目录）——存在存活实例就复用/提示，而不是 +1；最低成本改法是**把健康探测改成 3 次 × 500ms 重试**再判定"不是 PiWeb"。

### P2-3 `.next-releases` 只增不减：本机已积 13 个目录、2.86 GB

- **位置**：`scripts/release.mjs:130-133`（每次 `prepareRelease` 新建目录）；`scripts/` 全目录 grep 无任何清理逻辑（`rmSync` 只出现在 `install-build.mjs` 的 `.next`/staging、`apply-global.mjs` 的 target、`verify-package.mjs` 的临时目录）。
- **证据**（现场只读统计）：

```
menu-drawer-20261112-235700      276.3 MB
mvbx09xv-…                       253.2 MB
mwc51mx1-…                       275.9 MB
mwdtqifv-…                       217.7 MB
mwerj2pm-…                         0.0 MB   ← 失败的构建，也留下了
mweslqtb-…（active）              263.4 MB
preview-20261112-234300          276.2 MB
proxy-compact-…                  217.7 MB
proxy-diagnostics-…              241.5 MB
proxy-settings-…                 276.3 MB
review-…                           2.5 MB
ui-cleanup-…                     276.3 MB
ui-compaction-…                  346.0 MB
合计 6795 文件 / 2.86 GB
```

- **后果**：磁盘被吃满 → 下一次 `npm run build:release` 在 `next build`/`cpSync` 阶段失败 → 叠加 P2-1 直接导致重启起不来。失败构建的残留目录（`mwerj2pm` 已完成 `mkdir` 但没有产物）也在其中。另外这些目录名有一部分（`menu-drawer-*`、`preview-*`、`ui-*`、`proxy-*`）不符合 `release.mjs` 的命名规则（`<base36 时间>-<uuid>`），说明除 `release.mjs` 外还有外部脚本/人手在往这个目录写，进一步增加了"删错目录"的概率。
- **置信度**：已确认（现场数据）。
- **建议修法**：`prepareRelease` 成功后做保留策略：只留最近 2 个 ready + `active`，`state:"failed"` 的目录在下次成功构建后删除；或提供 `node scripts/release.mjs --prune` 并在 `README`/`RELEASING.md` 写明。

### P2-4 发布闸门可被本地 `npm publish` 绕过（`prepublishOnly` 不构建、不验包）

- **位置**：`package.json:43`
- **证据**：

```json
"prepublishOnly": "npm run typecheck && npm run test",
```

  CI 的顺序是 `prebuild → npm run verify:package → 版本校验 → npm publish`（`publish.yml:58-83`），闸门很强；但 `npm publish` 在**任何**机器上都会触发 `prepublishOnly`，那里既没有 `next build` 也没有 `verify:package`。`files` 白名单里 `.next` 是**整目录**（`package.json:35`），目录不存在时 npm 只是少打包，不会报错。
- **触发路径**：维护者在干净检出（或 `.next` 是旧的/wiped 的）里直接 `npm publish`。
- **后果**：发出"装得上、`piweb` 一跑就死在缺清单"的包——正是 0.3.7 的事故（`tests/packaging.test.ts:1-10` 的注释记录了这次事故）。
- **置信度**：已确认（两个文件的行为都是确定的；未真跑 publish）。
- **建议修法**：`"prepublishOnly": "npm run typecheck && npm run test && node scripts/verify-package.mjs"`，或加一个 2 行的 `prepublish` 前置断言：`.next/BUILD_ID` 与 `.next/required-server-files.json` 必须存在，否则 `exit 1`。

### P2-5 CI 只在 Linux 上验证发布产物，而包是全平台分发

- **位置**：`.github/workflows/publish.yml:25`（`runs-on: ubuntu-latest`，`node-version: 24`）；`.github/workflows/check.yml:14-16`（矩阵 `ubuntu-latest, windows-latest` × `22.19.0, 24`）
- **证据**：`check.yml` 的 Windows 覆盖是真的（`npm run check` = typecheck+test+build），但**打包契约**只有 `publish.yml` 里那一次 `npm run verify:package`（`publish.yml:69-70`），它在 Linux 上跑：`npm pack` → 解包 → 临时 prefix 全局安装 → `check-installed.mjs` 真起 Next 生产服务 + 打 6 个路由 + 首页（`scripts/runtime/check-installed.mjs:27-53`）。Windows 用户拿到的 `.next` 是 **Linux 构建机产出的**。本仓已经有同类事故的化石：`tests/packaging.test.ts:133-139` 记录的 0.3.8"CI 的 POSIX 路径进 bundle → Windows 启动 `ERR_INVALID_FILE_URL_PATH`"。
- **后果**：跨平台产物的 Windows 侧首次真实运行发生在用户机器上。目前用两条静态/契约测试兜着（`packaging.test.ts:140-195` 禁 `import.meta.url` 定路径、`pi-runtime.test.ts` 钉版本），风险被压低但没消除（例如 `next.config.ts:23-32` 的 `isolateHomeFromTracing` 在构建期改 `HOME/USERPROFILE` 这种平台相关行为，只在 Linux 上被真实执行过）。
- **置信度**：已确认（工作流文件）；实际是否已在 Windows 上出问题：未验证。
- **建议修法**：`check.yml` 增加一步 `npm run verify:package`（仅 ubuntu-latest × node 24，用 `if:` 限定，跳过 `--runtime` 的全局安装以控时）；或在 publish 之后加一个 `windows-latest` 的"装 tarball + 跑 `check-installed.mjs`"job。

### P2-6 删掉 release 目录后的报错是原始 ENOENT，没有可操作提示

- **位置**：`scripts/build-output.mjs:79-86`（只包住了 `required-server-files.json`）与 `:91`（`BUILD_ID` 直接读）
- **证据**：

```js
// :79-86 只有这一个文件有友好文案
function readRequiredServerFiles(root, buildDir) {
    try { return readLocalFile(root, `${buildDir}/required-server-files.json`); }
    catch (error) {
        if (error.code === "ENOENT") throw new Error(incompleteBuildMessage(buildDir));
        throw error;
    }
}
// :91 BUILD_ID 没有对应处理；readLocalFile 内部的 fs.statSync 直接抛 ENOENT
const buildId = readLocalFile(root, `${buildDir}/BUILD_ID`, 1024).trim();
```

- **触发路径**：清理磁盘时 `rm -rf .next-releases/mwdtqifv-…`（保留 `active.json`），或删 `.next` 但留下 `BUILD_ID` 之外的东西。
- **后果**：终端只有 `[piweb] ENOENT: no such file or directory, stat 'D:\AIApp\PiWeb\.next-releases\…\BUILD_ID'`（`bin/piweb.js:8-11` 只打 `message`，无栈）。注意一个反直觉点：**把整个 `.next-releases` 删掉反而是安全的**（没有 `active.json` → `selectProductionBuild` 回到 `.next`，`build-output.mjs:141-149`），而只删其中某个目录最致命——恰好是"清理磁盘"最自然的做法。
- **置信度**：已确认（代码读出来的行为）。
- **建议修法**：`readProductionBuild` 开头 try/catch ENOENT → 复用 `incompleteBuildMessage` 同款文案并指名 `buildDir`；再补一句"`rm -rf .next-releases` 后运行 `npm run build:release`"。

### P2-7 `hasProductionBuild` 只看 `active.json` 是否存在，会让一次性构建的自愈短路

- **位置**：`scripts/install-build.mjs:24-32`
- **证据**：

```js
export function hasProductionBuild(root) {
    if (fs.existsSync(path.join(root, ".next-releases", "active.json"))) return true;
    try { readProductionBuild(root, ".next"); return true; } catch { return false; }
}
```

- **触发路径**：目录里残留 `active.json`（`state:"building"`/`"failed"`，或指向已被删的 `buildDir`）→ `ensureInstallBuild` 返回 `"skipped"`（`install-build.mjs:201`）→ 紧接着 `createLaunchPlan` → `selectProductionBuild` 抛错 → 启动失败。本该救场的一次性构建被这行短路掉了。
- **后果**：没有开发依赖的安装（`isProductionOnlyInstall` 为真）从此无法自愈，而报错文案建议的 `npm run build:release`（`build-output.mjs:129`）在成品包里跑不动（`release.mjs:150` 要 `npm run check`，需要 vitest/jsdom）。
- **置信度**：已确认（逻辑确定）。触发面窄：发布的 npm 包 `files` 不含 `.next-releases`（`package.json:26-37`），只有用户在包目录里手跑过 `build:release` 或从别的安装拷过来才会出现。
- **建议修法**：`hasProductionBuild` 解析 `active.json`，仅 `state === "ready"` 且 `readProductionBuild` 通过才算 true；否则让它继续走到一次性构建。

### P3-1 `bin/pi.js` 既没注册成命令、又硬编码 pi 包内部路径

- **位置**：`bin/pi.js:34-49`；`package.json:23-25`
- **证据**：

```js
const piAgentCli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const child = spawn(process.execPath, [piAgentCli, ...rawArgs], { cwd: process.cwd(), stdio: "inherit", env: utf8Env });
child.on("exit", (code) => process.exit(code ?? 0));
```

  `package.json.bin` 只有 `{ "piweb": "bin/piweb.js" }`；`README.md:81` 明确写"只注册 `piweb`"。
- **后果**：`bin/pi.js` 对 npm 用户是死代码（只有本仓 `npm run web` 会用到）。它对 `dist/bundle/cli.js` 这个内部路径硬编码，pi 调整产物结构后转发会以 `MODULE_NOT_FOUND` 静默失败；且没有 `child.on("error")`，`spawn` 本身失败会抛未捕获异常。
- **置信度**：已确认（读代码）；pi 内部路径是否稳定：未核对。
- **建议修法**：要么删掉它并在 `package.json` 去掉 `"web"` 脚本，要么注册 `"pi": "bin/pi.js"` 前先解决命名冲突（README 说不注册就是为了避免和官方 `pi` 冲突），并补 `error` 处理。

### P3-2 `scripts/apply-global.mjs` 硬编码本机路径，且会 rename 正在服务的 `.next`

- **位置**：`scripts/apply-global.mjs:18`、`:72-86`
- **证据**：`const DEFAULT_OUT = "D:\\NodeJs\\node_modules\\@rexvane\\piweb";` / `if (fs.existsSync(target)) fs.renameSync(target, old);`
- **后果**：它不在任何 npm script 里，属于开发期私有工具；但 `--out` 有默认值意味着误跑就会动那台机器的全局安装，且在服务运行时 rename `.next` 会让运行中实例失去产物（同 P1-2 类别）。成功后旧的 `.next-old-<ts>` 也不自动清理，会叠加 P2-3。
- **建议修法**：`--out` 改为必填；或直接把脚本移到 `docs/`（不随包发布）。

### P3-3 启动器的环境变量语义不一致 / 报错文案弱

- **位置**：`scripts/launcher.mjs:195`、`:185-188`、`:211`
- **证据**：`let noOpen = env.PI_WEB_NO_OPEN === "1";`（只认 `"1"`）vs 认证走 `isTruthyFlag`（`"1"/"true"/"on"/"yes"`）；`PORT=abc` 时报 `无效端口：NaN`。
- **后果**：`PI_WEB_NO_OPEN=true` 不生效（用户以为关掉自动开浏览器了，结果还是弹）；端口报错看不出是环境变量还是命令行给的。
- **建议修法**：`noOpen` 也用 `isTruthyFlag`；端口报错带上来源（`PORT=abc` vs `--port abc`）。

### P3-4 `ensureInstallBuild` 排在参数/环境校验之前，可能白构建 1–2 分钟再拒绝启动

- **位置**：`scripts/launcher.mjs:394-421`
- **证据**：`runLauncher` 先 `parseLauncherArgs`（191-213）→ `if (!options.isDev) ensureInstallBuild(...)`（407-420）→ 之后才 `createLaunchPlan`（421），而"`PI_WEB_PASSWORD` 已移除 → 拒绝启动"这条硬拒绝在 `createLaunchPlan:224-226`。
- **后果**：设了 `PI_WEB_PASSWORD` 的部署（本来就是被明确拒绝的配置）在 production-only 安装上会先跑完整构建，然后因为一个环境变量退出。
- **建议修法**：把 `PI_WEB_PASSWORD` 与 loopback/dev 的静态断言提到 `ensureInstallBuild` 之前（抽一个 `assertLaunchEnvironment(options, env)`）。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 构建自检必须拦住"清单齐全但 chunk 缺失"的产物 | P1-1 的保护正是本次事故的机制，但现在 `readProductionBuild` 的用例全是"清单缺一个"（`tests/launcher.test.ts:258-264`、`tests/packaging.test.ts:56-68`），从不构造"清单在、chunk 没了" | 造一个 `required-server-files.json` 完整 + `server/app/xxx/route.js` 被删的目录，断言 `selectProductionBuild` 抛错并给出可操作文案 |
| 一次性构建替换 `.next` 的原子性/失败保留旧产物 | P1-2 是唯一"删除正在服务的输出目录"的地方，`install-build.test.ts` 只测 staging 路径布局（57 行，4 个用例），`buildInStaging` 本体零覆盖 | mock `spawnSync` 返回非 0、或在 `cpSync` 处抛错，断言旧 `.next` 仍在且 `BUILD_ID` 未变 |
| `ensureInstallBuild` 的 `skipped/built/failed` 三条分支 | P2-7 的短路效应要从这里才能看见 | 给 `active.json` 分别写 `ready`/`failed`/`building`，断言 `hasProductionBuild` 与 `ensureInstallBuild` 的返回值 |
| release 目录被删后的错误文案 | P2-6，本机真实发生过 | `packaging.test.ts` 加一例：写 `active.json` 指向不存在目录，断言错误里含 `build:release` 而不是裸 ENOENT |
| 第二个实例不应静默出现 | P2-2，`launcher.test.ts` 里"端口占用"用例都假设占用者"不是 PiWeb"（`:280-292`），没有"占用者是刚启动还没就绪的 PiWeb"这一态 | 注入 `probePort` 两位都 `"busy"`、`isPiWebRunning` 前两次 false 后 true，断言只启动一个子进程 |
| `verify:package` 在非发布日也跑 | P2-5，`files`/`.next` 的完整性只在 publish 那个 job 里被验证 | `check.yml` 增加 ubuntu-only 的 `npm run verify:package` 步骤（用 CI 配置本身作为断言点） |
| release 保留策略 | P2-3，现在完全没有策略可测 | 连续 `prepareRelease` 三次（`tests/update-service.test.ts` 的 mock 已经够用），断言旧 ready 目录被回收、`active` 不受影响 |

## 3. 与其他区域的可能交叉点

1. **双实例 × 会话文件（→ bridge）**：P2-2 的双实例共享 `~/.pi/agent`。两个服务同时打开**同一条会话**时，pi 的 JSONL 追加写是否安全、`agent-manager` 有没有跨进程的会话锁（`proper-lockfile` 目前只用在 `src/lib/settings-write-lock.ts`，grep 全库仅 1 处），需要 bridge 区域裁定。
2. **双实例 × 自动化调度器（→ automations）**：`instrumentation-node.ts:24` 每个进程都 `startAutomationScheduler()`。`automations/store.ts:45-48` 用 `process.kill(pid,0)` 挡住"同一任务重复跑"，但"进程首次启动时对账 missed 计划"（`runner.ts:429`）在两个进程同时启动时会不会各自补偿一次，需要 automations 区域确认。
3. **双实例 × 局域网入口（→ remote）**：`DEFAULT_LAN_PORT = 30142` 是硬编码单例（`src/lib/remote/supervisor.ts:24`），第二个生产实例必然抢端口失败，只打一行 warning（`instrumentation-node.ts:44`）。
4. **koffi 缺失（→ sandbox）**：`koffi` 是 `optionalDependencies`（`package.json:100-102`，且是**未提交改动**），缺失时 `probeSandboxSupport()` 返回 false（`src/lib/sandbox/manager.ts:38-54`）、`sandboxSupported()` 默认 false。打包层面这是合理的（原生模块装不上不该让整个包失败），但"workspace/readonly 档退化成无 OS 沙箱"这件事的可见性（是否只有一行日志、UI 是否提示）归 sandbox 区域。
5. **`installPiIntoPackage` 在服务运行时替换 `node_modules/pi`（→ bridge/update）**：`update-service.ts:183-189` 的注释假设"运行中的服务没加载 pi 的原生模块"，但 pi 是通过动态 `import` 加载扩展的，替换过程中新的动态 import 可能撞到半替换的目录树。这条属 update/bridge 区域，与本区域的启动链路无直接关系，但风险类别相同（"替换正在被引用的目录"）。
6. **发布产物的平台相关行为（→ 全体）**：`next.config.ts:23-32` 会在 `PHASE_PRODUCTION_BUILD` 期改写 `HOME/USERPROFILE`。构建在 Linux CI 上做，运行时在用户机器上，凡是构建期"求值用户环境"的代码都只被 Linux 路径验证过（P2-5）。

## 4. 建议优先修的 3 件事

1. **P1-1（含 P2-6）**：让"生产构建可用"这个判定真的能发现被删/截断的产物，并把 `ENOENT` 变成一句可操作的话。这是本机事故的直接机制，改动集中在 `scripts/build-output.mjs` 一个文件，风险低、收益最高。
2. **P1-2**：把一次性构建里的"删 `.next` + 拷贝"改成 rename 原子切换 + 失败回滚。它不仅是崩溃面，还是唯一一处会删掉**正在被运行中进程使用**的目录的代码。
3. **P2-2 + P2-4**：单实例登记（或至少健康探测重试）能消掉"双击启动得到两个服务"这类静默副作用；`prepublishOnly` 补上 `verify:package` 只需要一行，却能把 0.3.7 那个事故类别彻底关掉。
