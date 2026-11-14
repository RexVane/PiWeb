# 更新 / 发布 / 安装 补审计（下载完整性 + 事务之外 + 替换语义）

日期：2026-11-13 19:45–20:30　HEAD：`1d4efba`（工作区 145 项未提交，按当前磁盘状态审）
性质：**纯静态审查**。没有改任何代码，没有跑 release / install-build / postinstall，没有装依赖，没有重启服务，没有 git 写。
唯一执行的命令都是只读的：`git log/status`、`npm pack --dry-run --json`、`Get-Content`/`Select-String`/`Get-ChildItem`。

> 编号约定：master 报告（`PiWeb_Audit_2026-11-13.md`）的全局号**不动**。本文件用 `U-*`（update-service）/`R-*`（release.mjs）/`I-*`（install-build.mjs）/`K-*`（打包）作**本地号**，每条附「建议定级」，由 lead 决定是否并入全局表。凡与已有条目同源的，我只写"引用 P2-xx"不另起号。

---

## 0. 覆盖范围

### 读了什么

| 文件 | 行数 | 读法 |
|---|---|---|
| `src/lib/update-service.ts` | 242（简报写 229，工作区已变） | 逐行 |
| `scripts/release.mjs` | 192 | 逐行 |
| `scripts/install-build.mjs` | 224 | 逐行 |
| `scripts/build-output.mjs` | 150 | 逐行 |
| `scripts/process-runner.mjs` | 60 | 逐行 |
| `scripts/runtime/pi-packages.mjs` | 52 | 逐行 |
| `scripts/runtime/check-installed.mjs` | 71 | 逐行 |
| `scripts/postinstall.mjs` / `scripts/verify-package.mjs` / `scripts/apply-global.mjs` / `scripts/sync-provider-icons.mjs` | 12 / 102 / 87 / 41 | 逐行 |
| `scripts/launcher.mjs` | 545（重点 :100-260、:390-545） | 逐行（跳 :260-390 的 warmFirstPaint 内部） |
| `src/app/api/update/route.ts`、`src/lib/update/startup-check.ts`、`src/components/update/update-store.ts`、`src/lib/version.ts`、`src/lib/semver.ts` | 49 / 117 / 155 / 6 / 39 | 逐行 |
| `src/lib/sandbox/manager.ts`、`sandbox/windows-acl.ts:98-170`、`agent-manager.ts:1792-1802` | — | 只读 koffi 降级链 |
| `package.json`、`tsconfig.json`、`.gitignore`、`tests/{update-service,update-service-process,install-build,packaging}.test.ts` | — | 逐行 |

**未做（按边界）**：没有真 `npm publish`（只 `--dry-run`）；没有真跑 `npm install -g`（所以"npm 是否先删旧包目录"标为**疑似**并给了验证方法）；没有跑 `next build`/`npm run check`（耗时用 lead 的 `vitest.log`）；`update-service-route.test.ts`（84 行）只扫了结构没逐条核断言。

### 结论一览

| 子功能 | 结论 | 依据 |
|---|---|---|
| 更新包的**来源**（版本信息从哪来） | OK-但脆弱：git 路径读到 `origin/main:package.json` 才用于展示；npm 路径只信 `npm view`；两者都跟随用户 registry | `update-service.ts:120-144` |
| **下载/解压完整性** | **有问题（U-2）**：PiWeb 自己不解压，全部委托 npm；代码层**没有任何哈希/签名校验**，也没有 registry 白名单；成功判据 = 子进程 exit 0 + 21 个清单文件存在 | `update-service.ts:151-175`、`process-runner.mjs:52-58`、`build-output.mjs:89-108` |
| **成功判定**（半包会不会被当好包） | **有问题**：npm 路径只 `readProductionBuild(…, ".next")`，即 P1-23 那 21 条；半包"可能"过闸 | 同上 + P1-23 |
| 失败是否清理 | 部分：release 事务会写 `failed` 并放弃新目录（旧目录保留）；但 lock/`.tmp`/staging 目录崩溃后不清理（R-1、R-4、I-2） | `release.mjs:56-67,157-163` |
| 执行阶段 argv / cwd | OK：全部固定 argv，`cwd` = 安装目录（不是用户目录），无 `shell: true`（npm 只在 Windows 经 `cmd.exe /d /c`） | `update-service.ts:124,158,161,208-229`、`process-runner.mjs:29-33` |
| 失败回滚 | **有问题（引用 P2-96，建议升 P1）**：源码/依赖已被改，构建失败后无法回到上一个 ready；恢复指令在成品包上必然失败（R-3） | 见 §3 |
| 并发（两个更新同时跑） | **有问题（U-3）**：进程内一个布尔 + 只有 git 路径有文件锁；npm 路径零互斥 | `update-service.ts:113,151-175,193` |
| 安装替换语义 | **有问题（引用 P1-24）**：`rmSync(.next)` → `cpSync`，且 `ensureInstallBuild` 可抛异常破坏返回值契约（I-1） | `install-build.mjs:184-192,212-216` |
| 发布事务本身 | OK-但脆弱：新目录 + 原子清单 + 文件锁 + 失败不发布，测试真的断言了 | `release.mjs:119-164`、`update-service.test.ts:94-131` |
| npm 包自洽性 | OK（附条件）：`files` 以 `.next` 整目录为单位，`.next/cache` 实测被排除，关键清单/provider-icons 都在；缺 `next-env.d.ts`/`vitest`/`tests` 使"包内自检"不可用（K-3/R-3） | `npm pack --dry-run --json` 实测 987 文件 |
| `optionalDependencies: koffi` 缺失时的启动降级 | **OK（运行时真的不炸）**：动态 import + try/catch → 探测 false → bash 被剔出并给可操作文案 | `windows-acl.ts:106-124`、`manager.ts:38-59`、`agent-manager.ts:1792-1802` |

---

## 1. 发现（按严重度降序）

### U-1（建议 P1；现为 master P2-89，建议**上调**）非 Windows 一键更新在服务运行中删掉自己的安装目录——UI 报"成功"时运行实例已经在坏

- **位置**：`src/lib/update-service.ts:89-100`、`:149`、`:151-175`；`scripts/launcher.mjs:251`
- **证据**：
  ```ts
  // update-service.ts:89-100
  export function canSelfUpdateNpmInstall(platform: NodeJS.Platform = process.platform, installation?: string): boolean {
  	if (platform !== "win32") return true;
  ```
  ```ts
  // update-service.ts:146-150
  	 * The published package ships a ready build, so there is nothing to compile; the
  	 * running process keeps its old code until the user restarts.
  ```
  ```ts
  // update-service.ts:161（无 stop、无 503、无临时目录）
  		await command(["install", "-g", `${PIWEB_PACKAGE}@latest`, "--no-audit", "--no-fund"], 600_000);
  ```
  ```js
  // launcher.mjs:251 —— 运行实例的构建目录就在包目录里面
  if (command === "start") childEnv.PIWEB_BUILD_DIR = build.buildDir;
  ```
- **触发路径**：非 Windows（macOS/Linux）npm 安装 → 设置页"更新" → `runUpdate("piweb")` → `isNpmInstall` 为真 → `installFromRegistry` → `npm install -g @rexvane/piweb@latest`（`cwd` = 安装目录）→ 服务从不停止。
- **后果**：master P2-89 写的是"替换自己的安装目录（无 503 保护）"。补充更硬的后果链：
  1. 运行实例的 `cwd` 与 `PIWEB_BUILD_DIR` 都指向包内（`launcher.mjs:502-504` 的 `cwd: plan.root` + `:251`）。npm 装新版本时先移除旧包目录再放入新目录，**这两个路径在替换瞬间被删除**；Next 生产服务器按需从磁盘加载路由 chunk（`check-installed.mjs:29,37-48` 就是逐个请求验证这一点），所以下一次懒加载/`public` 静态资源读取会 `ENOENT`。
  2. 与此同时 `installFromRegistry` 的成功校验看的是**新目录**（`:163-174`），必然通过 → API 返回 `{success:true, needsRestart:true}` → 前端 `update-store.ts:129` 显示"已更新" → 用户看到的是"更新成功"，实际页面开始 404/500，直到重启。
  3. 若该安装之前跑过 `build:release`，`.next-releases/active.json` 也随包目录一起消失，运行实例的旧 release 目录同样被删。
- **置信度**：机制已确认（代码路径 + 目录归属）；"懒加载 chunk 立刻 ENOENT"**疑似**，因为跨平台与 Next 版本有关。验证方法（不改代码）：临时 prefix 里 `npm i -g` 旧版 → `piweb -p 30199 --no-open` → 记 `PIWEB_BUILD_DIR` → 在另一个 shell `npm i -g @rexvane/piweb@latest`（同 prefix）→ 请求一个没访问过的路由（如 `/api/github`）看是否 `Cannot find module`。
- **建议修法（最小改动）**：把 `canSelfUpdateNpmInstall` 的判据从"是否 win32"改成"**运行实例的 `PIWEB_BUILD_DIR`/cwd 是否在安装目录内**"——即所有平台都返回 false，UI 退回复制命令（这条路径的代码、测试、文案全都现成，见 `update-service.test.ts:262-279`）。若要保留一键更新，则必须在 `npm install` 前主动让服务进入维护态（停止接受新请求 + 等当前请求结束），而不是把"请重启"当唯一手段。

---

### U-2（建议 P2）"下载完整性"实际是零：无 registry 锁定、无哈希/签名、无 `--ignore-scripts`，且把启动令牌传给 npm 生命周期脚本

- **位置**：`src/lib/update-service.ts:112-114`、`:124`、`:158`、`:161`、`:208`、`:221`；对照 `scripts/verify-package.mjs:47`；`src/lib/web-launch-token.ts:17-22`、`src/proxy.ts:43`、`scripts/launcher.mjs:245`
- **证据**：
  ```ts
  // update-service.ts:112-114
  export function createUpdateService({ root = APP_ROOT, run = runCommand, versions = getRuntimeVersions, env = process.env, platform = process.platform }: UpdateServiceOptions = {}) {
  	let updateRunning = false;
  	const commandEnv = { ...env };
  ```
  ```ts
  // update-service.ts:158-161（cwd=安装目录 → 项目级 .npmrc 生效；无 --registry、无 --ignore-scripts）
  		const command = (args: string[], timeoutMs: number) => run("npm", args, { cwd: installation, env: commandEnv, timeoutMs });
  		const manifestPath = path.join(installation, "package.json");
  		const before = await readPackageVersion(manifestPath);
  		await command(["install", "-g", `${PIWEB_PACKAGE}@latest`, "--no-audit", "--no-fund"], 600_000);
  ```
  ```js
  // verify-package.mjs:47 —— 同一个仓库里，验证用的安装反而加了 --ignore-scripts
  runNpm(["install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
  ```
  ```ts
  // proxy.ts:43 —— 这个 token 就是可用凭据
  if (authority && tokens.length === 1 && validLaunchToken(tokens[0], process.env.PI_WEB_LAUNCH_TOKEN)) {
  ```
- **事实（逐条回答任务里的三个问题）**：
  1. **有没有哈希/签名**：**没有**。我在 `scripts/**/*.mjs` 与 `src/**/*.{ts,tsx}` 里 grep `integrity|signature|sha256|sha512|checksum|provenance`，**0 命中**（唯一命中是 `windows-acl.ts` 的 Windows 完整性级别 `SE_GROUP_INTEGRITY`，无关）。完整性与签名完全依赖 npm 自身：npm 会校验 packument 的 `dist.integrity`，但不校验 npm provenance/签名（默认不验），也不拒绝被改过的 packument。
  2. **HTTP 200 是否算成功**：代码里**没有 HTTP 客户端**，成功判据是**子进程 exit code === 0**（`process-runner.mjs:52-58`）——对 npm 来说这是正确判据；但"好包"的第二个判据只有 `readProductionBuild(…, ".next")`（即 P1-23 的 21 个文件）。
  3. **半包会不会被当好包**：`installFromRegistry` 在 `npm install` 之后先读 `package.json` 版本（`:164`），再 `readProductionBuild`（`:174`）。**若 npm 崩溃在"新 package.json 已就位、`.next` 只落了一半"之间（拷贝序里 21 个清单靠前），会被判成功**——这与 P1-23 是同一个闸门，不是新缺陷，但说明"更新成功"这个结论的强度只等于 21 个文件存在。
- **信任边界（本节真正的发现）**：
  - 无 registry 白名单：`commandEnv` 原样继承 `process.env`（`NPM_CONFIG_REGISTRY`/`npm_config_registry` 直接生效），且 `cwd` = 安装目录 → **项目级 `.npmrc` 也生效**。而 git 更新的"有本地改动"闸门用的是 `--untracked-files=no`（`update-service.ts:213`），**未跟踪的 `.npmrc` 不会被拦**：一个通过解压包/别的工具落进来的 `.npmrc` 可以同时改掉"检查更新"的结论与"安装"的来源，全程无提示。
  - `npm install -g` **不带 `--ignore-scripts`** → 会执行本包 `postinstall`（`package.json:42` → `postinstall.mjs:11-12`）**以及所有依赖/被换掉的包的生命周期脚本**。同一类问题在插件安装已有 P2-72；这里更敏感，因为 `commandEnv` 里带着 `PI_WEB_LAUNCH_TOKEN`（`launcher.mjs:245` 生成 → `:502-504` 进服务进程 env → `update-service.ts:114` 复制进 `commandEnv` → 传给 npm）。该 token 能直接换会话 Cookie（`proxy.ts:43`，且 P2-91 说它进程内长期有效）。**任何一次更新里任意依赖的 install 脚本都能读到它并外带。**
  - 代理/网络：`update-service` **完全不读** `httpProxy` 设置（`pi-settings.ts:156-167` 有该字段，`launcher.mjs:108-116` 只在**启动时**读一次并生成 `HTTP_PROXY`/`HTTPS_PROXY` 给子进程）。所以更新命令能不能走代理，取决于服务启动那一刻的 env——这就是 P1-17"保存代理不生效"的延伸：**更新路径也踩同一个坑，且没有任何提示**（`npm`/`git` 的原始 stderr 直接进 toast，最长 1000 字符，`process-runner.mjs:54`）。TLS 失败 = npm/git 非 0 退出 = 一句英文 stderr，无重试、无降级、无法区分"网络/TLS/凭据/404"。
- **建议修法**：
  1. `commandEnv` 改成白名单构造，**剔除** `PI_WEB_LAUNCH_TOKEN`、`PI_WEB_AUTH`，以及 `NODE_OPTIONS`/`NODE_TLS_REJECT_UNAUTHORIZED`（后两个是能关掉 TLS 校验的开关）；
  2. `npm install` 加 `--ignore-scripts`，需要 postinstall 就显式跑 `node scripts/postinstall.mjs`；
  3. `npm view`/`npm install` 显式传 `--registry`（默认 `https://registry.npmjs.org/`），或先 `npm config get registry` 与白名单比对，不一致就在 UI 里明说"这个 registry 不是官方源"；
  4. 更新成功后跑一次现成的端到端校验 `scripts/runtime/check-installed.mjs`（见 §0 末行与 K-3），而不是只看 21 个文件。

---

### R-1（建议 P2）`update.lock` 无存活检测：一次断电/强杀就让"更新"和"构建"永久不可用，恢复要手删隐藏文件

- **位置**：`scripts/release.mjs:39`、`:56-67`、`:124`、`:163`、`:166-191`
- **证据**：
  ```js
  // release.mjs:56-67 —— 写了 pid/startedAt，但全仓没有任何地方读它
  async function acquireLock(root) {
  	const lockPath = assertLocalPath(root, LOCK_PATH);
  	let lock;
  	try { lock = await fs.open(lockPath, "wx", 0o600); }
  	catch (error) {
  		if (error.code === "EEXIST") throw new Error(`an update/build is already running (${lockPath}); after an interrupted build, confirm its process tree has stopped before removing this lock and retrying npm run build:release`);
  		throw error;
  	}
  	try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  ```
  ```js
  // release.mjs:166-171 —— 只挂一次 SIGINT；第二次 Ctrl+C 走默认终止，finally 不会跑
  if (isMainModule(import.meta.url)) {
  	const controller = new AbortController();
  	const cancel = () => controller.abort();
  	process.once("SIGINT", cancel);
  	process.once("SIGTERM", cancel);
  ```
- **触发路径**：`npm run build:release`（或 UI 的 git 更新）→ 构建中断电 / 任务管理器结束进程 / `taskkill /F` / 连按两次 Ctrl+C → `finally { await releaseLock(); }`（`:163`）不执行 → `.next-releases/update.lock` 留在盘上。
- **后果**：此后**所有** `prepareRelease`（UI 的 piweb 更新、pi 更新、`npm run build:release`）都在第一句就抛错。文案让用户"确认进程树已停后删掉这个 lock 再重试"——路径是 `.next-releases/update.lock`，而 `.next-releases/` 被 `.gitignore:5` 完全忽略、本机已堆 13 个目录 + 50 个文件（见 P2-98 / 附录 A），普通用户不会去那里找。恢复 = 手删隐藏目录里的隐藏文件。
- **置信度**：已确认（代码路径完整；PID 写入后无人读取是静态事实）。
- **最小修法**：`EEXIST` 分支里读 `{pid, startedAt}`，`process.kill(pid, 0)` 探测存活（`ESRCH` → 视为陈旧锁并覆盖），再加 `startedAt` 超过 `2h` 兜底；或直接用仓库已有的 `proper-lockfile`（`package.json:74`，`settings-write-lock.ts` 已在用）。

---

### R-2（建议 P2）发布闸门的 600s 超时与它要跑的东西同量级：`npm run check` 实测单跑 vitest 就 312.5s，超时会被整树 kill 并留下 `failed`

- **位置**：`scripts/release.mjs:147-150`；`scripts/process-runner.mjs:45-48`；`package.json:49`
- **证据**：
  ```js
  // release.mjs:146-150
  		await writeReleaseTypeConfig(installation, buildDir);
  		await run(process.execPath, [path.join(installation, "scripts", "release.mjs"), "--verify-config"], {
  			cwd: installation, env: childEnv, timeoutMs: 60_000, signal,
  		});
  		await run("npm", ["run", "check"], { cwd: installation, env: childEnv, timeoutMs: 600_000, signal });
  ```
  ```json
  "check": "npm run typecheck && npm run test && npm run build",
  ```
  `.audit-2026-11-13/vitest.log` 尾行：`Duration  312.51s (environment 40%, import 32%, tests 27%, transform 1%)`。

  本机**最近一次真实成功发布**的耗时（`.next-releases/active.json` 里 `release.mjs` 自己写的时间戳，只读读取）：
  ```
  "startedAt": "2026-11-13T09:46:55.110Z",
  "finishedAt": "2026-11-13T09:52:42.522Z",     → 347.4s
  ```
- **后果**：那 347.4s 是**整个事务**（`beforePrepare` → `prepare` → `--verify-config` → `npm run check`，而 `startedAt` 写于 `release.mjs:134`、`finishedAt` 写于 `:155`）的耗时；600s 预算只剩 **42% 余量**；且这台机器上 vitest 单跑就占 312.5s（≈ 预算的 52%），即那次发布里 test 之外的全部步骤（git 检查 + pull/install + verify-config + typecheck + build）只花了约 35s。任何一次环境变慢（实时杀毒、CI 共享 runner、冷 webpack 缓存、磁盘忙）都会顶到 600s → `runCommand` 用 `taskkill /T /F`（`process-runner.mjs:11`）杀掉整棵 `npm→node→next` 树 → `prepareRelease` catch 写 `state:"failed"` → **下一次重启就命中 P2-96，旧 ready 明明在盘上却起不来**。也就是说：一次"只是有点慢"的构建，会把一个可用安装变成不可启动状态。
- **置信度**：已确认（600s 常量、312.51s 实测、347.4s 真实发布记录都是实据）。
- **最小修法**：`prepareRelease` 拆成三条带各自超时的命令（typecheck 180s / test 900s / build 900s），或把 `test` 从发布闸门移出（CI 的 `check.yml` 已经在跑全量测试，发布期再跑一遍价值低、风险高）；同时把超时错误文案写清"构建被超时终止，旧构建仍在 `<dir>`，重跑一次即可"。

---

### R-3（建议 P2；与 master P2-96、P2-101 同源，含新证据）失败后的"官方自救路径"在成品包上必然失败，且 `npm rebuild` 被短路——安装进入不可恢复状态

- **位置**：`scripts/build-output.mjs:128-130`；`scripts/release.mjs:150`；`package.json:49,86-93`；`scripts/install-build.mjs:24-32`；`tsconfig.json:31-41`
- **证据**：
  ```js
  // build-output.mjs:125-130 —— 所有安装形态共用这一句"自救指令"
  if (raw !== undefined) {
  	let manifest;
  	try { manifest = JSON.parse(raw); } catch { throw new Error("invalid release manifest; run npm run build:release"); }
  	if (manifest?.schema !== 1 || manifest.state !== "ready") {
  		throw new Error("release is incomplete or failed; finish npm run build:release before restarting (no stale-build fallback)");
  ```
  ```js
  // install-build.mjs:24-26 —— active.json 存在（任何状态）就短路，npm rebuild 永远不重建
  export function hasProductionBuild(root) {
  	if (fs.existsSync(path.join(root, ".next-releases", "active.json"))) return true;
  ```
- **新的硬证据**：成品包里 `npm run check` **跑不起来**。我用 `npm pack --dry-run --json` 实测当前 `files` 只有 987 个文件，其中**没有** `tests/`、没有 `vitest.config.ts`、没有 `next-env.d.ts`；而 `package.json:49` 的 `check` 第一段是 `typecheck`，`tsconfig.json:31-41` 的 `include` **在第 32 行明确列出了 `next-env.d.ts`**（缺失 → tsc 直接报找不到文件）；第二段 `test` 依赖 `devDependencies.vitest`（`package.json:92`），成品包 `--omit=dev` 安装后不存在。
- **触发路径（成品包）**：用户按错误文案执行 `npm run build:release` → `prepareRelease` 先写 `state:"building"`（`release.mjs:134`）→ `npm run check` 在 typecheck 就失败（或用户中途 Ctrl+C）→ `active.json` 停在 `failed`/`building` → 之后 `piweb` 每次启动都在 `createLaunchPlan`（`launcher.mjs:233`）抛 "release is incomplete or failed"（`bin/piweb.js:8-11` 打印后 exit 1）。用户再按另一条文案 `npm rebuild -g piweb`（`install-build.mjs:219`）→ postinstall → `ensureInstallBuild` → `hasProductionBuild` 因 `active.json` 存在返回 true → **skipped**，什么都不修。
- **后果**：**唯一**恢复手段是手动删掉 `.next-releases/active.json`（或整个 `.next-releases`），这件事没有写在任何文案里。而且触发门槛极低：**在成品包上敲一次官方建议的命令然后按两次 Ctrl+C，就足以把一个能跑的安装变成起不来的安装。**
- **建议修法**：① `selectProductionBuild` 在 `state !== "ready"` 时，若 manifest 里记录了上一个 ready（或 `.next-releases/*/BUILD_ID` 中有最新的完整构建）则回退并警告，而不是硬失败（这是 P2-96 的修法，我这里补充了"为什么它比看起来更严重"）；② `hasProductionBuild` 不要只看"文件存在"，要看 manifest 的 `state`（这是 P2-101 的修法）；③ 错误文案按安装形态分流：成品包 → `npm install -g @rexvane/piweb@latest`，源码检出 → `npm run build:release`。

---

### U-3（建议 P2）npm 安装形态的更新没有任何跨进程互斥；进程内的 `updateRunning` 还只在一个 bundle 里有效

- **位置**：`src/lib/update-service.ts:113`、`:193`、`:151-175`；对照 `scripts/release.mjs:56-67`、`src/lib/update/startup-check.ts:5,44`、`scripts/launcher.mjs:427-445`
- **证据**：
  ```ts
  // update-service.ts:113,191-194
  	let updateRunning = false;
  ...
  	async function runUpdate(target: UpdateTarget, ...): Promise<UpdateResult> {
  		if (updateRunning) throw new UpdateBusyError("an update is already running");
  ```
  ```ts
  // startup-check.ts:5 —— 项目自己写着：instrumentation 和路由是不同的 bundle，模块级变量不共享
   * 状态挂 globalThis：instrumentation 和路由是不同的 bundle，模块级变量不共享（同 remote/supervisor）。
  ```
- **事实**：
  1. git 路径有文件锁（`release.mjs:124`），**npm 路径一行锁都没有**：`installFromRegistry`（`:151-175`）与 `installPiIntoPackage`（`:183-189`）只做 `assertIdle()`（"没有正在流式输出的会话"），然后直接 `npm install`。
  2. 而 P2-97 已确认本仓允许"慢启动窗口内起第二个实例"。两个实例 → 两个进程各有一份 `updateRunning=false` → 两次 `npm install -g @rexvane/piweb@latest` 同时对着**同一个全局 prefix** 跑；`installPiIntoPackage` 更糟：两条 `npm install --save-exact …` 同时改**同一个 `node_modules`**。
  3. 即使单实例，`checkForUpdate` 与 `runUpdate` 也可能落在不同 bundle（instrumentation 的启动检查 vs `/api/update` 路由），`updateRunning` 互相看不见——`startup-check.ts:35-47` 用 `globalThis + Symbol.for` 正是为了绕开这一点，`update-service.ts` 没照做。
- **后果**：并发 reify 的经典结果——`EBUSY`/`ENOTEMPTY`/半装（node_modules 里一半旧一半新）、`package-lock` 争用；失败后 npm 路径没有任何清理或回滚，用户看到一条 npm stderr，安装目录处于未知状态。
- **最小修法**：把互斥做成锁文件（一个 `update.lock`，git/npm 两条路径共用），并把 `updateRunning` 挂 `globalThis`（与 `startup-check.ts:35-47` 同构）。

---

### I-1（建议 P2）`ensureInstallBuild` 声称只返回 `skipped|built|failed`，但替换 `.next` 的异常会直接抛出：postinstall 以未捕获异常失败，启动器的 `failed` 分支永远看不到它

- **位置**：`scripts/install-build.mjs:184-192`、`:199-224`；`scripts/postinstall.mjs:11-12`；`scripts/launcher.mjs:407-419`
- **证据**：
  ```js
  // install-build.mjs:184-187（rmSync 可抛 EBUSY/EPERM；cpSync 可抛 ENOSPC/EACCES）
  		const target = path.join(root, ".next");
  		fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  		fs.cpSync(path.join(staging, ".next"), target, { recursive: true });
  ```
  ```js
  // install-build.mjs:212-221 —— 调用点没有 try/catch，返回类型注释却写死三个字符串
  const built = buildInStaging(root, nextBin, {...}, log, warn);
  if (!built) {
  	warn("[piweb] Production build failed. Retry with: npm rebuild -g piweb");
  	return "failed";
  }
  ```
  ```js
  // postinstall.mjs:11-12 —— 顶层无 catch，异常 → 非 0 退出 → npm install -g 失败
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  ensureInstallBuild(root);
  ```
- **后果**：Windows 上 `rmSync(.next)` 撞到运行中实例占用（EBUSY）时，`ensureInstallBuild` 不是返回 `"failed"` 而是抛错：① 从 postinstall 抛 → `npm install -g` 整体失败，用户看到 npm 的 "postinstall failed" 加一句 EBUSY 路径；② 从 `launcher.mjs:408` 抛 → 绕过 `:409-419` 那段"属主不是当前用户"的可操作诊断（那段只在返回值 `=== "failed"` 时跑），实际用户只看到 `bin/piweb.js:9` 的一行 message。
- **修法**：`ensureInstallBuild` 用 try/catch 包住 `buildInStaging`，异常转成 `"failed"` 并把 message 打进 warn；或显式让契约包含 `throw`（改注释 + 两个调用点各加 catch）。

---

### I-2（建议 P2）`.piweb-build-*` staging 目录会永久泄漏（含整份 node_modules 的拷贝场景），位置还落在 npm 全局 prefix 里

- **位置**：`scripts/install-build.mjs:163-169`、`:188-192`、`:86-102`、`:135-161`
- **证据**：
  ```js
  // install-build.mjs:163-169
  function buildInStaging(root, nextBin, env, log, warn) {
  	let staging;
  	try {
  		staging = fs.mkdtempSync(path.join(stagingParent(root), ".piweb-build-"));
  	} catch {
  		staging = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-build-"));
  	}
  ```
  ```js
  // install-build.mjs:188-192
  	} finally {
  		fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  	}
  ```
- **事实**：
  - `stagingParent` 的推导（`:86-102`）对 `C:\Users\u\AppData\Roaming\npm\node_modules\@rexvane\piweb` 返回 `C:\Users\u\AppData\Roaming\npm`——即**每个失败的构建都在 npm 全局 prefix 根目录里留下一个 `.piweb-build-XXXXXX`**（那里同时放着 `piweb.cmd` 等 shim）。
  - `finally` 只在进程走到时执行；`next build` 被 Ctrl+C / 断电 / 超时杀 → 目录留下，**没有任何启动期清理逻辑**（全仓无 `piweb-build-` 的清理代码）。
  - 链接不可用时的兜底（`:158-161`）是 `fs.cpSync(target, linkPath, {recursive:true})`——把**整份 node_modules** 复制进 staging。在这个分支上被杀，泄漏的是数百 MB 级。
  - 跨卷回退（`:97`）把 staging 放到 `os.tmpdir()`：Windows 上 D: 装、C: 存 TEMP 很常见，此时 junction 建不出来（`:142`），走整份拷贝，C: 盘瞬时压力可观。
- **修法**：staging 名带 pid（`.piweb-build-<pid>-XXXX`），`ensureInstallBuild` 开头清理 `parent` 下超过 N 小时的同名前缀目录；日志里打印 staging 路径（已有 `:180`）方便人工清扫。

---

### U-4（建议 P3）npm 路径"成功"判定宽松：版本没变、registry 也没有更新时依旧报 `needsRestart: true` 的成功

- **位置**：`src/lib/update-service.ts:164-174`
- **证据**：
  ```ts
  		const version = await readPackageVersion(manifestPath);
  		if (version === before) {
  			// Either already current, or this PiWeb is not the copy the global prefix owns …
  			const latest = (await command(["view", `${PIWEB_PACKAGE}@latest`, "version"], 30_000)).trim().split(/\r?\n/)[0];
  			if (isNewer(latest, before)) {
  				throw new Error(`npm updated a different copy of ${PIWEB_PACKAGE}; …`);
  			}
  		}
  		return { ...readProductionBuild(installation, ".next"), version, needsRestart: true };
  ```
- **后果**：若 `@latest` 的 dist-tag 被回滚到一个不比本地新的版本（或 npm 因权限/prefix 问题什么都没做而本地已是最新），`version === before` 且 `!isNewer` → 落到 `return`，UI 显示"已更新"，实际未变。属误导性成功（不损坏状态）。
- **修法**：`version === before` 时返回"已是最新，无需重启"的显式结果（`needsRestart:false`）。

---

### U-5（建议 P3）更新结果里的 `buildDir` 恒为 `.next`，而运行实例服务的是 `.next-releases/<id>`

- **位置**：`src/lib/update-service.ts:174`、`:188`；`scripts/launcher.mjs:233,251`；`scripts/build-output.mjs:117-140`
- **证据**：`return { ...readProductionBuild(installation, ".next"), version, needsRestart: true };` 与 `childEnv.PIWEB_BUILD_DIR = build.buildDir;`——npm 安装若曾有 release（`active.json=ready`），launcher 优先用 release 目录，而更新汇报/校验的是 `.next`。两者可以不是同一份产物，UI 展示的 buildId 也就可能不是真正生效的那个。
- **修法**：npm 路径改用 `selectProductionBuild(installation)`（返回真正会被启动的构建），并在返回前断言它可用。

---

### U-6（建议 P3）"当前版本"在构建期烘焙：更新后不重启，检查更新永远拿旧版本比

- **位置**：`src/lib/version.ts:1-6`；`src/components/update/update-store.ts:125-135`
- **证据**：
  ```ts
  import { VERSION as PI_ENGINE_VERSION } from "@earendil-works/pi-coding-agent";
  import appManifest from "../../package.json";
  export function getRuntimeVersions(): Promise<{ piWeb: string; piEngine: string }> {
  	return Promise.resolve({ piWeb: appManifest.version, piEngine: PI_ENGINE_VERSION });
  }
  ```
- **后果**：`package.json` 是静态 import → 版本号被 webpack 烘进 server bundle。git 更新后 `package.json` 已经是 2.0.0，但进程还报 1.0.0（`checkForUpdate` 的 `current`）→ 用户再点"检查更新"仍看到"可更新到 v2.0.0"。设置页显示的版本号同理。
- **修法**：`getRuntimeVersions` 读磁盘上的 `package.json`（`APP_ROOT` 已知）而不是 import；pi 引擎版本可从 `node_modules/@earendil-works/pi-coding-agent/package.json` 读。

---

### U-7（建议 P3）`git pull --ff-only origin main` 硬编码分支，会把"其它分支"静默快进到 main

- **位置**：`src/lib/update-service.ts:137-143`、`:226`
- **证据**：`await command("git", ["pull", "--ff-only", "origin", "main"], 120_000);` 与 `behind` 的算法 `git rev-list --count HEAD..origin/main`。
- **后果**：用户在 `feature-x` 分支上（工作区干净）时点更新 → `--ff-only` 允许 → 该分支被快进到 `origin/main`，工作树内容整体换掉，UI 只说"更新成功"。有本地提交时会失败（"Not possible to fast-forward"），这是唯一护栏。
- **修法**：先 `git rev-parse --abbrev-ref HEAD`，非 `main` 时明确拒绝或提示"当前不在 main"。

---

### U-8（建议 P3）`assertIdle` 只判"有会话在流式输出"，且是 TOCTOU：文案自己在求用户"别开新会话"

- **位置**：`src/app/api/update/route.ts:34-41`；`src/lib/update-service.ts:157,162,206,217,225`
- **证据**：
  ```ts
  		const assertIdle = async () => {
  			if (Object.values(activeStatus()).some((session) => session.streaming)) {
  				throw new UpdateBusyError("An agent session is running. Wait for it to finish and update in a maintenance window; do not start new sessions until the release is ready.");
  ```
- **后果**：`npm install`（最长 600s）/`npm run check`（最长 600s）期间，用户可以随时开新会话——新会话会从**正在被 npm 重写的 node_modules** 里加载 pi 模块，或从**正在被 `git pull` 改写的 `src/`** 触发按需编译。错误文案本身暴露了这是约定而非机制。
- **修法**：更新期间在进程内设置"maintenance"标志，让新建会话的 API 返回 503（比"UI 提示"更可靠）。

---

### U-9（建议 P3）`installPiUpdate` 会就地重写 live 的 `public/provider-icons`

- **位置**：`scripts/release.mjs:103-109`；`scripts/sync-provider-icons.mjs:39-40`
- **证据**：`await run("npm", ["run", "sync:provider-icons"], { cwd: root, env, timeoutMs: 60_000, signal });` → `await Promise.all(slugs.map((slug) => copyFile(...)))`（非原子写）。
- **后果**：git 路径更新 pi 时，运行中实例正在服务的 `public/` 被逐个别覆盖；并发请求可能读到被截断的 SVG（毫秒级窗口）。另：该脚本**没有清理逻辑**，`public/provider-icons/` 里会保留上一个版本多出来的图标（当前 28 个，与 `slugs` 等长，暂无残留）。
- **修法**：先写临时目录再 `rename` 整个目录，或至少 copy 到 `*.tmp` 再 rename。

---

### R-4（建议 P3）`atomicJson` 崩溃残留 `<uuid>.tmp` 永不清理；`.next-releases/tsconfig.json` 是跨 release 共享的可变文件

- **位置**：`scripts/release.mjs:43-54`、`:69-80`
- **证据**：`const temporary = assertLocalPath(root, `${relative}.${randomUUID()}.tmp`);` + `finally { await fs.rm(temporary, { force: true }); }` —— 进程被强杀时 `finally` 不执行；`.tmp` 名字不匹配 `RELEASE_PATH`（`build-output.mjs:6`）所以不会被误选，但会永远留在目录里（本机已有 13 目录 + 50 文件的先例）。`writeReleaseTypeConfig` 每次 release 覆盖同一个 `tsconfig.json`，它是 `--verify-config` 的输入；一旦构建在写完之后被杀，该文件指向 `<id>` 半成品目录，下一次构建会先重写它，所以不影响正确性，只影响"失败后现场可读性"。
- **修法**：`prepareRelease` 启动时清理 `*.tmp`（同 I-2 的"启动期清扫"）；`.next-releases/tsconfig.json` 改成 `<id>.tsconfig.json`。

### R-5（建议 P3）锁与清单的权限/属主假设

- **位置**：`scripts/release.mjs:46`（`0o600`）、`:132`（`fs.mkdir` 默认 umask）、`:59-63`（只处理 `EEXIST`）
- **事实**：`atomicJson` 以 `0o600` 建临时文件再 rename → `active.json` 是 `0600`（单用户部署没问题）。但若 release 由**另一个用户**（`sudo npm run build:release`）跑，服务进程读 `active.json` 会 `EACCES`，而 `selectProductionBuild` 只把 `ENOENT` 当"没有清单"（`build-output.mjs:120-124`），`EACCES` 会原样冒到启动器；同理锁文件的 `EACCES` 不会被 `EEXIST` 分支翻译成人话。
- **修法**：`acquireLock` 的 catch 里对 `EACCES/EPERM` 给"这个目录属主不是当前用户"的文案；`active.json` 用 `0o644`。

### K-1（建议 P3）包里带了 158 KB 的构建机诊断（`.next/trace`）与 37 个 `.next/types/*.ts`

- **位置**：`package.json:26-37`
- **证据**（`npm pack --dry-run --json` 实测，见附录 A）：`.next/trace` 158,388 B、`.next/trace-build` 1,209 B、`.next/diagnostics/*` 130 B、`.next/types/**` 37 个文件（每个约 9 KB）。`trace` 是 Next 的构建追踪，通常含构建机的绝对路径与模块列表——对用户无功能价值，属构建机信息外泄面（同 P2-100 的"Linux 构建机产物"家族）。
- **修法**：`files` 加 `"!.next/trace"`、`"!.next/trace-build"`、`"!.next/diagnostics"`、`"!.next/types"`（`verify:package` 里 `.next/cache` 的同类断言可照抄一条）。

### K-2（建议 P3）`optionalDependencies.koffi` 是唯一用 caret 的 native 依赖，而降级代码把结构体偏移写死 x64

- **位置**：`package.json:100-102`；`src/lib/sandbox/windows-acl.ts:249-330`（对照 master P2-6）
- **事实**：其余依赖要么精确锁（`next`/`react`/pi 全家），要么是非 native 的 caret。koffi 是 native addon：`^3.3.8` 意味着每次 `npm i` 都可能换小版本，而 `windows-acl.ts` 的 `TOKEN_MANDATORY_LABEL`/`SE_GROUP_INTEGRITY` 结构体布局是手写偏移（`:273-274,320-321`）。缺失/ABI 不匹配时**不会崩**（见 §0 末行），但会静默退化成"workspace/readonly 档没有 bash"。
- **修法**：`"koffi": "3.3.8"` 精确锁（与 pi 家族一致），并在 `probeSandboxSupport` 里比对 `process.arch === "x64"`。

### K-3（建议 P3）包内自检不可用：`files` 不含 `next-env.d.ts` / `vitest.config.ts` / `tests/`

- **位置**：`package.json:26-37,49,86-93`；`tsconfig.json:31-41`
- 与 R-3 同源，作为"打包自洽性"单列：`npm run typecheck`、`npm run test`、`npm run check` 在安装副本上都不可能成功。**但**：运行期真正需要的（`.next` 整目录含 `BUILD_ID`/`required-server-files.json`/`routes-manifest.json`/`server/app/**`、`public/provider-icons` + `public/file-icons`、`assets`、`scripts`、`bin`）我逐项核对**都在包里**（附录 A 列出关键路径的存在性）。
- **修法**：要么把 `next-env.d.ts` 加进 `files`（让 typecheck 至少语法上可跑），要么把"包内不允许跑 check"写进 R-3 的文案分流。

---

## 2. 「更新 / 发布 / 安装」状态机

写者：`R`=`scripts/release.mjs`，`N`=npm 自己，`B`=`scripts/install-build.mjs`，`L`=`scripts/launcher.mjs`，`U`=`update-service.ts`。所有路径相对安装根。

| # | 状态（磁盘上的事实） | 谁写 | 失败会停在哪 | 用户看到什么 | 怎么自救 |
|---|---|---|---|---|---|
| 1 | `.next` 完整、无 `.next-releases/active.json`（源码检出首启 / tarball 默认） | N（tarball）/B（一次性构建） | `B` 的 `rmSync`+`cpSync` 中途失败 → `.next` 半残（P1-24），21 清单多半已落地 → 下次被判"可用"（P1-23） | 正常启动；或几天后某页面 `Cannot find module .next/server/...` | 删 `.next` 重跑 `npm rebuild -g piweb`（源码检出用 `npm run build:release`） |
| 2 | `active.json = building`（`release.mjs:133-134`，`update.lock` 存在） | R | **停在这里**：`selectProductionBuild` 抛 `release is incomplete or failed`（`build-output.mjs:128-130`） | `piweb` 起不来，一行英文错误；`bin/piweb.js:9` 只打 message | 重跑 `npm run build:release`（需先手删 `update.lock`）；成品包上重跑必失败（R-3）→ 删 `active.json` |
| 3 | `active.json = ready`（`release.mjs:155`） | R | 无失败态；此状态是启动的必要条件 | 重启后 `[piweb] 就绪：…`，服务的是 `.next-releases/<id>` | — |
| 4 | `active.json = failed`（`release.mjs:157-163`） | R | **停在这里**，旧 ready 目录仍在盘上但被忽略（P2-96） | 同 2；`npm rebuild` 也修不了（`hasProductionBuild` 短路，P2-101/R-3） | 手删 `active.json`（未文档化）或成功跑一次 `build:release` |
| 5 | `update.lock` 残留（崩溃/强杀，`release.mjs:56-67`） | R | **停在这里**：所有 `prepareRelease` 第一句就失败 | `an update/build is already running (.next-releases/update.lock)…` | 手删 `update.lock`（文案有说，但要进隐藏目录） |
| 6 | npm 包目录已被替换、进程未重启（POSIX，`update-service.ts:161`） | N | 无回滚点：旧包目录已删 | UI「已更新，重启生效」+ 页面开始 404/500（U-1） | 立刻重启 `piweb` |
| 7 | `node_modules` 已是新 pi、`.next-releases/active.json` 仍是旧的 ready | `installPiRuntime`（`pi-packages.mjs:41-51`） | 若随后构建失败 → 落到状态 4 | 运行实例"旧构建 + 新 pi"混合版本（U-8）；重启后可能起不来 | 重启前先确认状态 3 或 1 |
| 8 | 两个实例同时更新（无锁，U-3） | U×2 | 失败点不确定：`EBUSY`/`ENOTEMPTY`/半装 node_modules | 一条 npm stderr（最长 1000 字符，`process-runner.mjs:54`） | 停掉一个实例后重试；npm 路径没有清场逻辑 |
| 9 | `.piweb-build-*` 残留（I-2） | B | 不影响启动，只吃磁盘 | 无（没有日志） | 手删 `<npm prefix>/.piweb-build-*` |

**三段一致性结论（发布产物 → 安装路径 → 生效时机）**：

- **git 检出**这一路是一致的：产物落 `.next-releases/<new>`、运行实例继续用旧目录、`active.json` 原子切换、重启才生效（`release.mjs:119-164` + `launcher.mjs:233-251`）。
- **npm 成品**这一路不一致（U-1/U-5）：产物就是 `.next`（随包替换）、安装路径 = 服务正在用的目录、生效时机 = 重启，但**替换动作发生在服务运行中**且没有任何隔离；而"成功"的判据看的是替换后的新目录。三段里唯一没有保障的，正是"替换期间服务仍在用旧目录"这条前提。
- **pi 依赖**这一路半一致（U-8）：`node_modules` 立即换、构建不重建、声称"重启即用"，但重启前的那个进程里可能出现新旧混合。

---

## 3. 对已有条目的定级修正建议

| 全局号 | 现级别 | 建议 | 理由（本轮新证据） |
|---|---|---|---|
| **P1-23**（`readProductionBuild` 只校验 21/305） | P1 | **维持 P1** | 本轮定位到它的第二个"客户"：`installFromRegistry` 的**成功判定**就是这个函数（`update-service.ts:174`）。所以"下载完整性"缺口的落点不是"有没有哈希"，而是"更新成功的定义只有 21 个文件存在"。修法建议加一条：更新后用仓库现成的 `scripts/runtime/check-installed.mjs`（真起 Next、真打 6 个路由 + 首页，`verify-package.mjs:44-57` 已在用）做验收，比加 300 次 `stat` 更接近"用户能否用"。 |
| **P1-24**（`install-build.mjs:184-187` 先删后拷） | P1 | **维持 P1（不要降级）** | 触发面比原报告更宽：① `launcher.mjs:407-408` **每次启动**都调 `ensureInstallBuild`，不只是 `npm rebuild`/postinstall；② 异常会击穿 `ensureInstallBuild` 的返回值契约，从 postinstall 顶层抛出使 `npm i -g` 直接失败（I-1）；③ `apply-global.mjs:72-74` 是同类"把正在服务的 `.next` 挪走"的第二处（已由 P3-2 覆盖）。 |
| **P2-96**（失败不回退旧 ready） | P2 | **建议上调 P1** | 不只是"不回退"：进入该状态的**代价极低**（成品包上按官方文案跑一次 `build:release` 然后 Ctrl+C 两次即可，或一次 R-2 超时），而**两条官方自救路径在该形态下都无效**（`npm run check` 缺 vitest/next-env.d.ts；`npm rebuild -g piweb` 被 `hasProductionBuild` 短路）→ 实际是"一次失败就把安装锁死到需要手删隐藏文件"。见 R-3。 |
| **P2-89**（非 Windows 更新替换在服目录） | P2 | **建议上调 P1** | 补强：运行实例的 `cwd` 与 `PIWEB_BUILD_DIR` 都在被替换的目录内（`launcher.mjs:251,502-504`），替换瞬间这两个路径消失；而更新的成功校验看新目录 → **UI 报成功的同时服务已在坏**。且没有 503、没有维护态（U-8），用户的唯一补救是"立刻重启"。见 U-1。 |
| **P3-27**（pi 目标不校验 registry 输出） | P3 | **维持 P3** | 补一句收敛结论：真正的安装路径 `installPiRuntime` 会用 `piRuntimeSpecs` 校验版本形（`pi-packages.mjs:14-20`），异常 registry 输出**不会导致装错版本**，只会在"检查更新"上误报"已是最新"。所以 P3 合适，不需要升级。 |
| **P2-101**（`hasProductionBuild` 只看文件存在） | P2 | **维持 P2** | 与 R-3 合并后证据更足（它就是"`npm rebuild` 修不了 failed"的直接原因）。修法只需一行：读 `active.json` 的 `state`。 |
| **P2-98**（`.next-releases` 只增不减） | P2 | **维持 P2** | 本轮实测：13 个目录 + **50 个文件**、合计 **2,926 MB**；其中只有 `active.json` 与 `tsconfig.json` 是 `release.mjs` 写的，另外 48 个是审计/探针产物（`remote-*.json`、`restart-latest-*.json`、`audit-validation-*.json`…）——印证原报告"有外部写入者"，并说明这个目录事实上被当成临时输出目录用，清理策略必须先约定归属。 |

**新增建议进全局表的 4 条**（按上面顺序）：U-2（更新路径的信任边界/凭据外泄，P2）、R-1（陈旧锁无存活检测，P2）、R-2（600s 超时与实测同量级，P2）、U-3（npm 路径零跨进程互斥，P2）；其余作为 P3 或并入已有条目。

---

## 4. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 更新成功后**运行实例仍可用** | U-1 是唯一"更新把在服进程搞坏"的路径，现有测试全部停在"API 返回什么" | 不可能单测（要真进程）。至少加一条**契约测试**：断言 `canSelfUpdateNpmInstall` 在"buildDir 位于安装目录内"时对所有平台返回 false（先改实现，再锁住） |
| 陈旧锁的回收 | R-1 一旦发生，用户只能手删文件 | 写一个 `{pid: 999999, startedAt: <很久以前>}` 的 `update.lock` → 断言 `prepareRelease` 不抛 "already running"（改实现后）；再写当前 pid → 断言仍互斥 |
| `npm run check` 超时 | R-2 | `run: vi.fn` 里让 `npm run check` 永不 resolve + `timeoutMs` 调小 → 断言 manifest=failed、lock 被释放 |
| `ensureInstallBuild` 在 `rmSync`/`cpSync` 抛错时的返回 | I-1 的契约 | mock `fs` 让 `cpSync` 抛 `ENOSPC` → 断言返回 `"failed"`（不是 throw），且旧 `.next` 的 `BUILD_ID` 未变（与 P1-24 的验证合并） |
| 两个 `runUpdate` 并发（npm 路径） | U-3 | 同一 `createUpdateService` 实例上并发两次 `runUpdate("piweb")`（npm 安装形态）→ 现在第二次会因 `updateRunning` 抛 `UpdateBusyError`；**但**文件锁缺失这件事无法在单进程单测里体现 → 建议加"npm 路径也要 acquire 锁文件"的断言（读 `.next-releases/update.lock` 存在性） |
| `checkForUpdate("pi")` 的 registry 输出校验 | P3-27 | `npm view` 返回 `""` / `"vNext"` / `"1.2.3.4"` → 断言 `canUpdate` 为 false **且** check 明确提示无法判断，而不是显示"已是最新" |
| `getRuntimeVersions` 读磁盘而非 import | U-6 | 临时改 `package.json` 的 version → 断言 `getRuntimeVersions()` 跟着变（当前会失败，正好锁住修法） |
| 打包白名单的"运行期必需文件" | K-1/K-3 | 在 `packaging.test.ts` 里加一条：解包后断言存在 `.next/server/app/api/update/route.js`、`public/provider-icons/openai.svg`、`scripts/runtime/check-installed.mjs`（我本轮是用 `npm pack --dry-run --json` 人工核对的，应自动化） |

---

## 5. 与其他区域的交叉点（请对应区域裁定，我不越界）

1. **→ settings-i18n（P1-17 延伸）**：`update-service` **不读** `httpProxy`（`pi-settings.ts:156-167` 有这个设置，只有 `launcher.mjs:108-116` 在启动时读一次）。所以"保存代理后不生效"这件事在**更新路径**上更彻底——它连"启动时读一次"都没有，纯粹继承服务进程的 env。若 P1-17 的修法是"改完即时生效"，更新命令需要显式传入代理。
2. **→ api-auth（P2-91）**：`PI_WEB_LAUNCH_TOKEN` 会随 `commandEnv` 流进 `npm`/`git` 子进程（U-2）。如果 P2-91 的修法是给 token 加过期/一次性，也能顺带降低这条的影响，但**根因是 env 透传**，建议两边都修。
3. **→ plugins-skills（P2-72）**：同一条"`npm install` 缺 `--ignore-scripts`"的模式在**插件安装**和**自更新**两处各有一份。如果统一抽一个"受控 npm 调用"工具函数，两条一起消掉。
4. **→ bridge**：`installPiRuntime` 在服务运行中替换 `node_modules/@earendil-works/*`，而 `agent-manager`/`pi.ts` 里对这些包有动态 `import()`（懒加载路径）。"混合版本"到底会不会在单个进程里出现，取决于 SDK 的加载时机——需要 bridge 区域确认 pi SDK 是否有 lazy import 的入口（`tool_search`/`codemode` 相关）。
5. **→ tests-coverage（P1-22）**：koffi 缺失时**运行时**的降级是干净的（§0 末行），问题只在测试里（`TypeError` 而非 skip）。不要把 P1-22(b) 当成运行时缺陷。

---

## 6. 建议优先修的 3 件事

1. **R-3 + P2-96/P2-101：让"构建失败"不再等于"安装永久起不来"**。三行改动收益最大：`selectProductionBuild` 在 `state !== "ready"` 时回退到上一个完整构建（并 warn）；`hasProductionBuild` 也看 `state`；错误文案按安装形态给不同指令。它挡住的是"一次超时/一次 Ctrl+C → 手删隐藏文件"这条现实路径（本机已经有 failed 目录先例）。
2. **U-1 + P2-89：非 Windows 不要一边服务一边替换安装目录**（或至少加维护态/503）。现在 UI 会在服务已经坏掉的情况下告诉用户"更新成功"，这是本轮最伤用户信任的一条。
3. **U-2 + R-1：更新路径的两条硬边界**——`commandEnv` 里剔掉 `PI_WEB_LAUNCH_TOKEN`/`NODE_TLS_REJECT_UNAUTHORIZED` 并加 `--ignore-scripts`（2 行）；`update.lock` 加 pid 存活探测（10 行，或直接用已有的 `proper-lockfile`）。

---

## 附录 A：本轮只读命令与关键输出（可复核）

```
$ npm pack --dry-run --json            # 不 publish、不写 tarball
  filename=rexvane-piweb-0.3.30.tgz size=4751522 unpacked=16443918 files=987
  分组：public 424 | .next 288 | src 221 | assets 29 | scripts 17 | root 6 | bin 2
  .next 子项：server 166 | static 68 | types 37 | diagnostics 2 | trace 1 | trace-build 1 | 其余清单各 1
  .next/cache 命中数：0（`!.next/cache` 生效）
  关键路径存在性：.next/BUILD_ID=True, .next/required-server-files.json=True,
    .next/routes-manifest.json=True, .next/server/app-paths-manifest.json=True,
    .next/server/app/api/health/route.js=True, .next/server/app/api/update/route.js=True,
    public/provider-icons/openai.svg=True, scripts/runtime/check-installed.mjs=True, package.json=True
  缺失（与运行期无关但与"包内自检"相关）：next-env.d.ts、vitest.config.ts、tests/**
    （root 只有 6 项：LICENSE README.md next.config.ts package.json postcss.config.mjs tsconfig.json）

$ Select-String -Path scripts/**, src/** -Pattern 'integrity|signature|sha256|sha512|checksum|provenance'
  0 命中（唯一近似命中是 windows-acl.ts 的 SE_GROUP_INTEGRITY，Windows 完整性级别，无关）

$ Get-ChildItem .next-releases   （只读清点）
  13 个目录 + 50 个文件，合计 2,926.0 MB；active.json = {schema:1, state:"ready",
  buildDir:".next-releases/mweslqtb-…", buildId:"V16ZP5Q6rLBrwsSLUXQL0", version:"0.3.30",
  startedAt:"2026-11-13T09:46:55.110Z", finishedAt:"2026-11-13T09:52:42.522Z"}   ← 347.4s 一次真实成功发布
  其中 48 个文件是 remote-*/restart-*/audit-*/permission-* 探针产物，非 release.mjs 所写

$ Get-Content .audit-2026-11-13/vitest.log -Tail
  Test Files 204 passed | 3 skipped (207) / Tests 1648 passed | 19 skipped (1667)
  Duration 312.51s

$ git log --oneline -3
  1d4efba fix(test): make proxy diagnostics tests independent of the runner node version
$ git status --porcelain | measure  → 145 项（按当前磁盘状态审）
```

**没有执行**（按边界）：`npm publish`、`npm install`、`npm rebuild`、`node scripts/release.mjs`、`node scripts/install-build.mjs`、`npm run check/build/test`、任何 git 写操作、任何服务重启/终止。因此凡是"npm 会先删旧包目录"这类 npm 内部行为，本报告都标了**疑似**并给了验证方法，没有写成已确认事实。
