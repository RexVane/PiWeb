# 验证报告：插件安装端到端（A）与技能删除越界 P1-10（B）

审计者：verify-plugin-install（子任务）　日期：2026-11-13　基线：HEAD `1d4efba` + 与 `.audit-2026-11-13/baseline-git-status.txt` 完全一致的 145 项未提交改动
环境：Windows 10/11，Node v24.12.0，npm 11.6.2，SDK `@earendil-works/pi-coding-agent@1.5.2`
仓库：`D:\AIApp\PiWeb`（**未改任何源码/测试/配置**；`git status --porcelain` 与基线逐行相同）

> 本报告回答两个待定项：
> **A**：`installAndPersist` 真实跑起来是什么样 —— 装到哪、settings 写什么、**没有 `--ignore-scripts` 时第三方 `postinstall` 到底会不会执行**、失败留什么孤儿、两路并发会不会撞。
> **B**：P1-10 的触发条件是否如审计所写 —— **junction 指向的外部目录会不会被整目录删掉**、`others` 到底在什么条件下才拦得住。

---

## 0. 结论速览

| # | 问题 | 实测结论 | 证据 |
|---|---|---|---|
| A-1 | 装到哪个目录 | user 作用域：`<PI_CODING_AGENT_DIR>\npm\node_modules\<包名>`（npm 前缀 = `<agentDir>\npm`）；project/local：`<cwd>\.pi\npm\node_modules\<包名>` | A1/A6 |
| A-2 | 临时 `settings.json` 里写什么 | 只多一条 `packages`：`{"packages":["npm:acme-pi-plugin"]}`；project 作用域写 `<cwd>\.pi\settings.json` | A1/A6 |
| A-3 | **缺 `--ignore-scripts` 是否真执行第三方 postinstall** | **会**。marker 文件出现，内容含 `cwd=...\npm\node_modules\acme-pi-plugin`、`npm_lifecycle_event=postinstall` | A1/A7 |
| A-4 | 本地路径安装是否也跑 npm | **不跑**。`installAndPersist("C:\...\fixtures\acme-pi-plugin")` 27–47 ms 返回（三次运行），只登记 settings（相对 agentDir 的路径），不复制文件、不执行 postinstall、不创建 `agent/npm` | A2 |
| A-5 | 装不上的包失败后有没有回滚 | **npm 自己回滚了 `node_modules`**：前缀里只剩 `package.json`(48B) 和 `.gitignore`，目标包目录/`.package-lock.json` 都被清掉；PiWeb **没有**回滚动作；`settings.json` 根本没被创建（无 `packages` 记录）；**但失败前的 postinstall 已经执行过**（marker 存在） | A3 |
| A-6 | 两路并发安装会不会撞 | **同一进程内不会**：无论同 cwd 还是不同 cwd，user 作用域都被 `withSettingsWriteLock`（按 `<agentDir>\settings.json` 同一 key）串行化；两包装完、settings 两条都在 | A4/A5 |
| A-7 | 只读 GET 会不会触发安装（P2-75） | **会，已实测**。`listSkills(cwd)`（`GET /api/skills` 的入口）在包已配置但目录缺失时真的跑了 `npm install` + postinstall（2.58 s），之后技能以 `origin=package` 出现 | A7 |
| B-1 | junction 技能目录删除时外部目录会不会被整目录删 | **会**。`removed` = 外部仓库真实路径，删除后外部目录（含 `.git`、`scripts`、`README.md`、`data.txt`）全部消失；`fs.rm(force:true)` 不进回收站 | B1 |
| B-2 | 链接本身会被清理吗 | **不会**。外部目录被删后，`<agentDir>\skills\pack` 的 junction 仍在（`lstat.isSymbolicLink()=true`，`existsSync=false`，`dir /AL` 仍列出 `<JUNCTION>`）→ 留下一个坏链接，UI 里也看不到、删不掉 | B1/B2 |
| B-3 | 审计说"目标里有嵌套技能时 `others` 会拦住" | **不成立**。SDK 的发现规则是"目录里有 `SKILL.md` 就不再下钻"，所以 `inner/SKILL.md` **根本不会被发现**，`others` 不含它 → **整目录（含嵌套技能）照样被删** | B2 |
| B-4 | `others` 什么时候才真的拦得住 | 只有当"同一目录里的第二个技能被**单独发现**"时（例：`settings.skills` 里显式声明了 `.../inner`）。此时只删外部 `SKILL.md`，`.git`/`notes.txt`/`inner/SKILL.md` 保留 | B3 |
| B-5 | 机制是不是"`fs.rm` 跟随链接" | **不是**。对照组：`fs.rm(junction,{recursive:true,force:true})` 只删链接、目标文件仍在；真正跟随链接的是 `resolveDiscoveredPath` 里的 `fs.realpath`（审计的"准确描述"第 2 点正确） | B0 |
| B-6 | 文件符号链接对照 | **本机无法构造**（非管理员、未开开发者模式，`mklink` 报 "You do not have sufficient privilege"）；但其分支与 B1 在 `realpath` 之后完全同构，见 §3.4 | 权限探针 |

**定级建议**：P1-10 **保持 P1**（"用户自建链接"这一前置条件仍在，频次未变），但审计的降级理由 ②"没有嵌套技能（否则 `others` 拦掉）"是**错的**，必须删掉；若产品将来在文档/功能里推荐"把技能仓库链接进技能根"（多工具共享 `~/.agents/skills` 正是这种用法），按审计自己的口径应**升回 P0**。P2-75 的置信度从"未实测"升级为**已实测确认**；P2-76 需要按实测收窄（进程内已串行）。

---

## 1. 方法与隔离

### 1.1 临时根与隔离（不碰真实 `~/.pi`）

所有实验在 `%TEMP%\piweb-verify-plugin\` 下进行，每次运行都显式指定：

```powershell
$root = Join-Path $env:TEMP 'piweb-verify-plugin'
$env:PI_CODING_AGENT_DIR = Join-Path $root 'agent-shell'   # SDK 的 agent 目录
$env:HOME = Join-Path $root 'home'                          # 技能/信任的 home 口径
$env:USERPROFILE = Join-Path $root 'home'
$env:npm_config_cache = Join-Path $root 'npm-cache'         # 不污染真实 npm 缓存
$env:PATH = (Join-Path $root 'shim') + ';' + $env:PATH      # npm argv 记录垫片
```

真实 agent 目录 `C:\Users\guica\.pi\agent` 前后快照对比：

```
settingsHashBefore=8EEBC00D3FBB022E03572C1892BBB968B19AA706DC647EEF3ECBA819509F510D
settingsHashAfter =8EEBC00D3FBB022E03572C1892BBB968B19AA706DC647EEF3ECBA819509F510D
settingsHashEqual=True
npmEntriesBefore=node_modules,.gitignore,package-lock.json,package.json
npmEntriesAfter =node_modules,.gitignore,package-lock.json,package.json
skillsEntriesBefore= ; after=
递归搜索 acme-pi-plugin/broken-pi-plugin/beta-pi-plugin → 0 命中
```

唯一差异：真实 agent 里 `web-sandbox/` 目录 mtime 有 0.3 s 漂移（同秒内，目录内容/条目未变）——那是**在跑的 PiWeb 服务自己的沙箱目录**，与本轮进程无关（本轮所有进程的 `PI_CODING_AGENT_DIR` 都指向 `%TEMP%`）。未启动/未触碰 30141 服务。

### 1.2 跑 TS 的方式（临时 vitest 配置，跑完已删）

按约定在 `.audit-2026-11-13/scratch-plugin/` 放了临时配置与 harness，`root` 指向仓库（保证 `node_modules`/`src` 解析与真实测试一致），只把 `include` 收窄到该目录：

```powershell
D:\AIApp\PiWeb\node_modules\.bin\vitest.cmd run `
  --config .audit-2026-11-13\scratch-plugin\vitest.verify.config.ts `
  .audit-2026-11-13/scratch-plugin/plugin-install.e2e.test.ts    # → 7 passed

D:\AIApp\PiWeb\node_modules\.bin\vitest.cmd run `
  --config .audit-2026-11-13\scratch-plugin\vitest.verify.config.ts `
  .audit-2026-11-13/scratch-plugin/skill-delete.e2e.test.ts      # → 4 passed
```

两个 harness 调的都是**真实业务函数**：`src/lib/plugins-service.ts` 的 `installPackage()` / `listPackages()`、`src/lib/skills-service.ts` 的 `listSkills()` / `deleteSkill()`，没有 mock 掉安装或删除；只有 npm registry 被替换成本机 `127.0.0.1` 的临时 registry（见 §2.2）。

### 1.3 两个方法学坑（会影响结论，必须写明）

1. **本地路径并不走 npm**：审计"缺失的测试"里建议"用一个 `file:` 本地包走真实 `installAndPersist`"。实测这条路**测不到 postinstall**（见 A2），因为 SDK 把非 `npm:`/`git:` 的 source 一律当 `local`，`install()` 只检查路径存在就返回（`package-manager.js:811-833`，local 分支 `:824-830`）。要跑真实 npm 链，source 必须以 `npm:` 开头。
2. **假 registry 的 packument 必须带 `hasInstallScript`**：第一版本地 registry 的 packument 只写了 `dist`，npm 认定"无生命周期脚本"直接跳过 postinstall（lockfile 里没有 `"hasInstallScript": true`）。这不是产品行为，是 fixture 失真；补上后与真实 registry 一致，postinstall 正常执行。任何后续"用本地 registry 测安装"的人都可能踩这个坑。

---

## 2. A. 插件安装端到端

### 2.1 先读安装链（代码定位）

- PiWeb 入口：`src/lib/plugins-service.ts:395-405`
  ```ts
  export async function installPackage(source: string, local: boolean, cwd: string): Promise<void> {
      const pm = getPackageManager(cwd);
      const settingsPath = local ? path.join(cwd, ".pi", "settings.json") : path.join(getAgentDir(), "settings.json");
      await withSettingsWriteLock(settingsPath, async () => {
          const sm = await prepareSettingsWrite(cwd, settingsPath);
          await pm.installAndPersist(source, { local });
          await flushSettingsOrThrow(sm);
          await verifySettingsField(settingsPath, "packages", (local ? sm.getProjectSettings() : sm.getGlobalSettings()).packages);
      });
      await applyResourceChange(cwd, local ? "project" : "user");
  }
  ```
- SDK：`installAndPersist`（`dist/core/package-manager.js:834-837`）→ `install`（`:811-833`）→ npm 源走 `installNpm`（`:1655-1659`）→ `getNpmInstallRoot`（`:1882-1891`：user = `<agentDir>/npm`，project = `<cwd>/.pi/npm`，temporary = 临时目录）+ `ensureNpmProject`（`:1861-1876`：建 `package.json`/`.gitignore`）+ `getNpmInstallArgs`（`:1630-1654`）。
- 实际 npm argv（`:1653`）：`["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps", "--no-audit", "--no-fund"]` —— **没有 `--ignore-scripts`**。
- settings 落盘：`addSourceToSettings`（`:652-682`）只改 SDK 内存里的 `packages` 数组，PiWeb 再 `flush` + 回读校验。

### 2.2 装置

- **fixture 包**（零依赖，`%TEMP%\piweb-verify-plugin\fixtures\acme-pi-plugin\`）：
  - `package.json`：`name=acme-pi-plugin@1.0.0`、`keywords:["pi-package"]`、`pi:{"skills":["skills/demo"]}`、`scripts.postinstall = "node scripts/postinstall.js"`；
  - `skills/demo/SKILL.md`（让清单能数到 1 个技能）；
  - `scripts/postinstall.js`：把 `cwd`、`npm_lifecycle_event`、包名/版本追加到 `$PIWEB_FIXTURE_MARKER`。
  - 另有 `broken-pi-plugin`（postinstall 先写 marker 再 `exit 1`）与 `beta-pi-plugin`（无脚本，用于并发）。
  - 用 `npm pack` 打成 tarball（`npm pack` 日志在 `logs/npm-pack-*.log`）。
- **本机临时 registry**：harness 内起 `http.createServer` 监听 `127.0.0.1:0`，按 npm packument 格式返回 `acme/broken/beta` 三个包（含 `dist.tarball`、`dist.integrity(sha512)`、有脚本的包带 `hasInstallScript:true`），并记录所有请求（`logs/npm-registry-requests.log`，全程只有 `127.0.0.1`，无外网）。
- **npm argv 垫片**：`%TEMP%\...\shim\npm.cmd` 被放在 PATH 最前，记录真实 argv 后 `call` 真正的 `npm.cmd`。捕获到的真实调用（节选）：
  ```
  [npm-shim] argv: "install" "acme-pi-plugin" "--prefix" "C:\...\agent-a1\npm" "--legacy-peer-deps" "--no-audit" "--no-fund"
  [npm-shim] argv: "install" "broken-pi-plugin" "--prefix" "C:\...\agent-a3\npm" "--legacy-peer-deps" "--no-audit" "--no-fund"
  [npm-shim] argv: "install" "beta-pi-plugin" "--prefix" "C:\...\ws-a6\.pi\npm" "--legacy-peer-deps" "--no-audit" "--no-fund"
  [npm-shim] argv: "install" "acme-pi-plugin" "--prefix" "C:\...\agent-a7\npm" "--legacy-peer-deps" "--no-audit" "--no-fund"
  ```
  最后一条是 A7 只读列表触发的安装；`npm root -g` 也出现过一次（SDK 在解析缺失包时会探测全局前缀）。

### 2.3 观测（逐项）

#### A1 `npm:acme-pi-plugin`（真实 `installPackage`，user 作用域）

```
elapsedMs               : 1658
packages                : npm:acme-pi-plugin          # <agentDir>\settings.json 全文
postinstallMarkerExists : True
resources               : {"extensions":0,"skills":1,"prompts":0,"themes":0}
npmTree                 : .gitignore | node_modules/.package-lock.json/ | node_modules/acme-pi-plugin/ | package-lock.json (514B) | package.json (105B)
```

`<agentDir>\settings.json`：
```json
{ "packages": ["npm:acme-pi-plugin"] }
```
`<agentDir>\npm\package.json`（SDK 建的前缀工程）：
```json
{ "name": "pi-extensions", "private": true, "dependencies": { "acme-pi-plugin": "^1.0.0" } }
```
marker 原文：
```
when=2026-11-13T11:56:11.190Z
cwd=C:\Users\guica\AppData\Local\Temp\piweb-verify-plugin\agent-a1\npm\node_modules\acme-pi-plugin
npm_lifecycle_event=postinstall
npm_package_name=acme-pi-plugin
npm_package_version=1.0.0
```
`listPackages(cwd)` 紧接着返回 `installedPath=<agentDir>\npm\node_modules\acme-pi-plugin`、`types:["skills"]` —— 说明装完就能被 PiWeb 的包清单认出来。

> **结论**：缺 `--ignore-scripts` **确实会执行第三方 postinstall**，而且是在用户身份、与 PiWeb 同权限下执行。审计 P2-72 的这一条**成立**，现在有运行时证据（不再只是读 SDK 源码）。

#### A2 本地路径 source（`installAndPersist` 的 local 分支）

```
installSource           : C:\...\fixtures\acme-pi-plugin      # 目录，不是 tarball
elapsedMs               : 27
settings                : {"packages":["..\\fixtures\\acme-pi-plugin"]}
agentDirTree            : settings.json (58 bytes)            # 没有 npm/ 目录
npmRootExists           : false
postinstallMarkerExists : false
agentDirHasCopyOfFixture: false
fixtureStillInPlace     : true
```

> **结论**：PiWeb 里"安装本地路径插件"实际上只是往 settings 里登记一条**相对 agentDir 的路径**（可能是 `..\` 开头的），既 npm install、也不复制、也不跑 postinstall；插件目录仍是用户原来那份。因此：
> - 用本地目录 fixture 验证"postinstall 是否执行"会得到**假阴性**（审计测试建议里的 `file:` 写法需要修正为 `npm:file:...` 或 registry）；
> - 本地路径的"代码执行"发生在**之后的 loader 重载**（扩展被 import），不在 install 调用本身（本次 harness 没创建 loader，因此 A2 的 27 ms 里没有任何代码加载）。

#### A3 装不上的包（postinstall 写 marker 后 `exit 1`）

```
elapsedMs        : 1667
rejected         : true
error            : npm install broken-pi-plugin --prefix C:\...\agent-a3\npm --legacy-peer-deps --no-audit --no-fund failed with code 1
marker           : broken postinstall ran            # 脚本确实执行了，然后才失败
settingsFileExists: false                            # installAndPersist 没走到 addSourceToSettings，settings 没被创建
npmProjectPackageJson: {"name":"pi-extensions","private":true}   # ensureNpmProject 建的骨架还在
npmTree          : .gitignore (14B) | package.json (48B)        # node_modules、package-lock 都不在
```

npm 自己的 reify 在脚本失败后把整棵 `node_modules` 回滚掉了；**PiWeb 侧没有任何回滚代码**（`installPackage` 里 install 抛错就直接向上抛）。所以这一次失败留下的是**空 npm 前缀**（`package.json`/`.gitignore`）+ npm 缓存里的下载内容，没有"解包好的包目录"，也没有 settings 条目。

> **结论**：回答"失败留下什么孤儿"需要分两种失败点（审计 P2-77 的原措辞把两者混在一起了）：
> 1. **npm 级失败**（网络/脚本/解包）：npm 回滚 `node_modules`，残留 ≈ 空前缀骨架 + npm 缓存；settings 无记录（实测 A3）。
> 2. **settings 落盘/校验失败（install 已成功之后）**：包已经在 `node_modules` 里、`settings.packages` 写不进去 → 这才是真正的"装上了但没登记"孤儿（代码路径成立：`installAndPersist` → `flushSettingsOrThrow` / `verifySettingsField` 抛错；本轮没有构造 settings 写失败，未实测）。
> 另外：失败**发生前** postinstall 已经跑过了 —— "安装失败"不代表"没有执行代码"。

#### A4 同 cwd 两路并发（user 作用域）

```
totalElapsedMs : 2902
results        : npm:acme-pi-plugin: 1-1616ms ok=True ; npm:beta-pi-plugin: 10-2902ms ok=True
packages       : npm:acme-pi-plugin,npm:beta-pi-plugin
installedDirs  : .package-lock.json,acme-pi-plugin,beta-pi-plugin
```
第二路 10 ms 就"开始"（进入函数），但真正结束在 2902 ms = 第一路结束（1616）+ 第二路 npm 时长；两段 npm 子进程没有重叠（argv 日志时间戳也是串行）。

#### A5 不同 cwd 两路并发（都是 user 作用域，共享 `<agentDir>\npm`）

```
totalElapsedMs : 2787
results        : npm:acme-pi-plugin@ws-a5: 0-1547ms ok=True ; npm:beta-pi-plugin@ws-a5-b: 5-2787ms ok=True
packages       : npm:acme-pi-plugin,npm:beta-pi-plugin
```

> **结论（A4+A5）**：`withSettingsWriteLock` 的 key 是 **settings 文件路径**；user 作用域无论 cwd 是什么，都落在 `<agentDir>\settings.json` 同一个 key 上，因此**同一 PiWeb 进程内的两路 user 安装是串行的**，两包装完、settings 两条都在，没出现半成品。审计 P2-76 里"两个客户端同时点安装 → 同一前缀并发 npm"在**单进程**前提下不成立（同一服务进程内的两个请求就是这种情况）。

#### A6 project/local 作用域

```
agentSettings   : {"defaultProjectTrust":"always"}      # 见下：project 安装受信任门禁
projectSettings : <cwd>\.pi\settings.json = {"packages":["npm:beta-pi-plugin"]}
projectNpmRoot  : <cwd>\.pi\npm
projectNpmTree  : .gitignore | node_modules/.package-lock.json/ | node_modules/beta-pi-plugin/ | package-lock.json (481B) | package.json (105B)
```
`local:true` 的 npm 前缀是 `<cwd>\.pi\npm`（不是 agent 目录），settings 是项目那份。注意 SDK 的 `assertProjectTrustedForScope`（`package-manager.js:1568-1572`）会拒绝在**未信任项目**里做 project 安装；本实验为了让 cwd（位于 `%TEMP%` 但仍在真实用户目录树内）通过信任门禁，在临时 agent settings 里写了 `defaultProjectTrust:"always"`。这是项目信任的正常行为，不是缺陷，但对"本地插件安装失败"的用户报错有解释价值。

#### A7 只读列表触发安装（P2-75 原"未实测"项）

```
entryPoint : listSkills(cwd) -> resourceLoaderReady(cwd) -> loader.reload() -> packageManager.resolve()
elapsedMs  : 2583
skillsSeenAfterList : [{"name":"acme-demo","origin":"package","sourceLabel":"acme-pi-plugin"}]
installedDirExists  : true
postinstallMarkerExists : true
settingsAfter : {"packages":["npm:acme-pi-plugin"]}     # 安装前就已配置（模拟缓存被清）
```

做法：临时 agent 的 `settings.json` 预先写 `{"packages":["npm:acme-pi-plugin"]}`（**不**安装），然后直接调 `listSkills(cwd)`（与 `GET /api/skills` 同一个 `resourceLoaderReady` 入口）；`GET /api/plugins` 走 `listLoadedExtensions` 也命中同一条 loader 重载。结果：读取动作触发了真实 `npm install`（argv 日志最后一条），postinstall 执行，技能随后以包来源出现。

> **结论**：P2-75 **坐实** —— 只读的页面/接口在"包已配置但目录缺失"时会静默下载第三方包并执行其生命周期脚本，用户没有任何"正在安装"的提示。置信度可从"已确认代码路径、未实测"升级为"本机已实测"。

### 2.4 A 节总结（对应审计两个待定项）

1. **"缺 `--ignore-scripts` 是否真的会执行第三方 postinstall"** → **会**（A1/A7 marker + `npm_lifecycle_event=postinstall` + argv 无 `--ignore-scripts`）。安装期代码执行面 = `npm:` / `git:` 源；本地路径源不跑安装脚本，但随后 loader 会 import 它的扩展代码（同权限）。
2. **"失败留下什么孤儿"** → npm 级失败时 **npm 回滚 `node_modules`**，只剩空 npm 前缀（`package.json` 48B + `.gitignore`）与 npm 缓存，settings 无记录（A3）；真正会留下"已装好但没登记"孤儿的是 **install 成功、settings 落盘/校验失败** 的那条路径（P2-77，代码成立但本轮未构造）。
3. 附带确认：user 安装前缀 `<agentDir>\npm`、project 安装前缀 `<cwd>\.pi\npm`；临时 settings 只多一条 `packages`；同一进程内并发被串行化（A4/A5）。

---

## 3. B. 技能删除越界（P1-10）实测

### 3.1 代码要点

`src/lib/skills-service.ts:210-237`：
```ts
const skills = await listSkills(cwd);                                              // :211
const authorized = await resolveDiscoveredPath(filePath, skills.map((s) => s.filePath)); // :212 —— 返回 realpath
const comparableFile = await toComparablePath(authorized);        // realpath 后的 SKILL.md
const skillDir = path.dirname(authorized);                       // :224 —— 已经是 realpath，外部目录
const ownsDir = path.basename(authorized) === "SKILL.md"
    && path.dirname(skillDir) !== skillDir
    && !protectedRoots.has(comparableDir)                        // :230 —— 只有黑名单
    && !others.some((other) => other !== comparableFile && within(other, comparableDir));
const removed = ownsDir ? skillDir : authorized;
await fs.rm(removed, { recursive: ownsDir, force: true });       // :233
```
- `resolveDiscoveredPath`（`src/lib/path-security.ts:79-93`）对请求路径和候选都做 `fs.realpath` 后比较、并**返回 realpath**。所以删除目标在进 `fs.rm` 之前就已经是链接指向的真实目录。
- 黑名单 `protectedDirs`（`skills-service.ts:189-201`）只有 agentDir/`skills`/`web-skills`/home/`~/.pi`/`~/.agents` 等**精确路径**，不含"必须在技能根内"的包含判定（审计这一条正确）。

### 3.2 装置

```powershell
# 外部"技能仓库"（不放进 agent 目录）
%TEMP%\piweb-verify-plugin\external\skill-pack\{SKILL.md, .git\config+objects\dummy, scripts\deploy.js, README.md, data.txt}
%TEMP%\piweb-verify-plugin\external\skill-pack-two\{SKILL.md, inner\SKILL.md, .git\config, notes.txt}
%TEMP%\piweb-verify-plugin\external\skill-pack-three\{SKILL.md, inner\SKILL.md, .git\config, notes.txt}

# agent 目录 + 目录联接（junction，无需管理员）
cmd /c mklink /J <root>\agentB\skills\pack  <root>\external\skill-pack
cmd /c mklink /J <root>\agentB2\skills\pack2 <root>\external\skill-pack-two
cmd /c mklink /J <root>\agentB3\skills\pack3 <root>\external\skill-pack-three
```
- `agentB` / `agentB2` 的 skills 根下**只有**该 junction（不存在其它技能），保证 `others` 为空集。
- `agentB3` 额外有 `settings.json = {"skills":["<external>\skill-pack-three\inner"]}`：让内层技能被**单独发现**，作为"`others` 真的能拦"的正例。
- 所有 skill 文件由 SDK 真实发现（`listSkills`），删除走真实 `deleteSkill`；`PI_CODING_AGENT_DIR` 分别指到 agentB/agentB2/agentB3。

### 3.3 观测

#### B0 机制对照：`fs.rm` 本身不跟随 junction

```
realpathOfJunction : C:\...\probe-rm\target
linkStillExists    : false
targetStillExists  : true
targetTreeAfter    : keep.txt (4 bytes)
```
→ `fs.rm(link,{recursive:true,force:true})` 只删链接本身。**越界不是 rm 跟随链接导致的**，而是 `resolveDiscoveredPath` 的 `realpath` 先把 `authorized` 变成了外部路径（审计"准确描述"第 2 点成立）。

#### B1 junction 技能目录 → 外部仓库（主实验）

`listSkills` 发现结果（删除前）：
```
name=pack  filePath=<agentDir>\skills\pack\SKILL.md  scope=user  origin=top-level
sourceInfo={source:"auto", scope:"user", origin:"top-level", baseDir:"<agentDir>"}
lstatOfSkillFile: isSymbolicLink=false, isFile=true
realpathOfSkillFile: C:\...\external\skill-pack\SKILL.md
```
调用：
```ts
await deleteSkill(path.join(agentDir, "skills", "pack", "SKILL.md"), cwd);
```
结果：
```
removed                : C:\...\external\skill-pack
error                  : null
externalExistsAfter    : false
externalTreeAfter      : []                     # 目录已不存在
junctionPathExistsAfter: false                  # existsSync=false（坏链接）
junctionRealpathAfter  : ENOENT ... \agentB\skills\pack
```
删除前的 `externalTree`（全被删）：`.git/`、`.git/config`、`.git/objects/dummy`、`README.md`、`SKILL.md`、`data.txt`、`scripts/deploy.js`。

事后单独检查链接：
```
lstat=ok isSymbolicLink=true existsSync=false
cmd /c dir /AL <agentDir>\skills
→ <JUNCTION> pack [C:\...\external\skill-pack]
```
→ **外部目录被整目录递归删掉（含 `.git`），链接本身没被清理，留下一个指向已删目标的坏 junction。**

#### B2 目标目录里还有嵌套技能（审计声称"`others` 会拦住"的对照）

删除前的发现结果（真实 SDK）：
```
skillsBefore: [ pack-two ]                      # 只有根技能
nestedSkillDiscovered: false                    # inner/SKILL.md 未被发现
```
结果：
```
removed              : C:\...\external\skill-pack-two
externalExistsAfter  : false
rootSkillFileExistsAfter  : false
nestedSkillFileExistsAfter: false               # 嵌套技能也一起没了
```
原因（SDK `dist/core/skills.js:135-160`）：扫描目录时**先找 `SKILL.md`，找到就 `return`，不再下钻**（"if a directory contains SKILL.md, treat it as a skill root and do not recurse further"）。所以 `inner/SKILL.md` 根本不在 `listSkills` 里，`others` 为空，`ownsDir=true`，整目录删除。

> **结论**：审计 P1-10 的降级理由 ②"目标根上直接放 `SKILL.md` 且**没有嵌套技能**（否则 `others` 拦掉）"**不成立**。嵌套技能不构成任何保护；只要链接目标根上有 `SKILL.md`，整目录就会被删——**触发面比审计写的更大**。

#### B3 正例：同一目录里"被单独发现"的第二个技能才会触发 `others`

`agentB3` 的全局 settings 显式声明了 `external\skill-pack-three\inner`，发现结果：
```
skillsBefore: [inner-declared (origin=top-level, source=local), pack-three (origin=top-level, source=auto)]
nestedSkillDiscovered: true
```
删除根技能后：
```
removed                    : C:\...\external\skill-pack-three\SKILL.md   # 只删这一个文件
externalExistsAfter        : true
externalTreeAfter          : .git/ | .git/config | inner/ | inner/SKILL.md | notes.txt
rootSkillFileExistsAfter   : false
nestedSkillFileExistsAfter : true
```
→ `others.some(within(other, comparableDir))` 命中，`ownsDir=false`，退化成只删 `authorized` 文件；外部仓库的 `.git`/脚本/嵌套技能都保住了。

> **结论**：`others` 这条保护在真实发现规则下**几乎不会自然触发**；只有"技能目录里的第二个技能也被列入发现列表"（如通过 `settings.skills` 显式声明，或该技能同时被别的根/别名单独发现）时才生效。审计建议的"多技能仓库对照 → `others` 会拦"如果按真实 SDK 发现来写，会**失败**（B2 实测）。

#### B4 对照 1：`SKILL.md` 是文件符号链接 —— 本机无法构造

```
cmd /c mklink <link.txt> <target.txt>
→ You do not have sufficient privilege to perform this operation.        (LASTEXIT=1)
New-Item -ItemType SymbolicLink → 此操作需要管理员权限
HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock\AllowDevelopmentWithoutDevLicense 不存在
当前用户管理员：False
```
junction 可以建（不需要管理员），文件符号链接不行。**因此这一对照本轮未实测**。但从代码路径看它与 B1 同构：
- `resolveDiscoveredPath` 对 `SKILL.md` 做 `realpath` → 得到**目标文件**路径；
- `path.basename(authorized)` 仍是 `SKILL.md`；
- `path.dirname(authorized)` = 目标文件所在目录 → `fs.rm(dir,{recursive:true})` 删外部目录。

即审计"准确描述"第 4 点（文件符号链接同样中招）在代码上成立，但需要管理员/开发者模式才能构造，真实用户触发门槛比 junction 更高。

### 3.4 B 节结论与定级建议

- **P1-10 的触发条件（修正版）**：
  1. 用户在技能根里建了一个链接（junction 一条 `mklink /J` 即可，无需管理员；文件符号链接需要管理员/开发者模式）；
  2. 链接目标根上直接有 `SKILL.md`（**嵌套技能不会保护**，B2；`others` 只在第二个技能被单独发现时才拦，B3）；
  3. 用户在 PiWeb 技能页点「删除」并确认（确认框只显示技能名，不显示真实路径）。
- 删除后果：外部目录**整目录递归删除**，包含 `.git`、脚本、与技能无关的文件；`force:true` **不进回收站**；链接本身留下成坏 junction。
- **定级**：**保持 P1**。降级所依赖的"频次"条件没变——仍需用户自己先建链接；PiWeb/pi 不会自动创建这种结构，仓库文档也没有推荐把技能仓库链接进技能根（全仓 Markdown 搜索 `junction|mklink|符号链接` 未发现该用法）。但必须删掉"嵌套技能会拦住"这条错误的降级理由，并在条目里写明"触发面比原描述更大（任何根上有 `SKILL.md` 的外部仓库都中招）"。
- **升 P0 的触发条件**（沿用审计自己的口径）：如果产品决定在文档/UI 里推荐"把技能仓库链接进技能根"（多工具共享 `~/.agents/skills`），或增加"从链接仓库导入技能"的功能，则升级为 P0 并先修。
- **修法与验证建议**（不变，但补一条测试口径）：递归删前要求 `comparableDir` 位于某个**技能根 realpath 集合**之内；对发现时拼写的 `path.dirname(filePath)` 做 `lstat`，是链接时只删链接本身；确认框显示 `removed` 真实路径 + `danger`。测试必须用**真实 SDK 发现**（不要 mock `listSkills` 造嵌套技能），断言"目标目录仍在、内部文件仍在、外部目录按键值不变"，并加一条"嵌套技能不保护"的回归（B2 的形状）。

---

## 4. 对审计报告相关条目的定级与措辞修正建议

### 4.1 P1-10（`PiWeb_Audit_2026-11-13.md:206-219`）

| 位置 | 现在写的 | 建议改成 |
|---|---|---|
| 降级理由 ② | "链接目标必须根上直接放 `SKILL.md` 且**没有嵌套技能**（否则 `others` 拦掉，只删单个文件）" | **删除这条**。实测：SDK 发现到 `SKILL.md` 就停止下钻，嵌套技能不进发现列表，`others` 不会拦；整目录（含嵌套技能）照样被删（B2）。`others` 只在第二个技能被单独发现（如 `settings.skills` 显式声明）时生效（B3） |
| 验证段 | "再补一个'多技能仓库'对照证明 `others` 会拦" | "对照要用**真实发现**：嵌套技能不会拦（B2）；要构造 `others` 生效需把内层技能单独声明为发现源（B3）" |
| 后果段 | "没有嵌套技能…" | 补一句"删除后链接本身残留为坏 junction（`lstat` 仍是符号链接、`existsSync=false`），UI 里无法清理" |
| 定级 | P1（原 P0 降级） | **保持 P1**；若产品文档/功能推荐"链接技能仓库"→ **P0** |

### 4.2 P2-72（安装通道 = 代码执行通道）

- **实测确认**：没有 `--ignore-scripts`，npm 真的执行了第三方 `postinstall`（A1/A7，marker 里有 `npm_lifecycle_event=postinstall` 与包内 cwd）。argv 由 PATH 垫片原样捕获：`install <pkg> --prefix <root> --legacy-peer-deps --no-audit --no-fund`。
- **措辞补充**：代码执行面分两种时序 —— ① `npm:`/`git:` 源在**安装时**执行生命周期脚本；② **本地路径**源安装时不执行脚本（A2 实测），但安装后的 loader 重载会 import 其扩展代码（同权限；这是代码路径，A2 harness 未创建 loader，未实测代码加载）。"一键安装 = 一键执行任意第三方代码"的主结论不变。
- 定级：**P2 保持**（供应链加固项），无需改级。

### 4.3 P2-75（只读 GET 会触发安装）

- **置信度升级**：从"已确认代码路径；实际是否触发未实测"改为"**已本机实测**"（A7：`listSkills` → loader.reload → `npm install` + postinstall，2.58 s，技能随后以 `origin=package` 出现）。
- 建议补一句：这条安装发生在**请求线程**里，用户只看到页面变慢；失败会被加载器吞成 `installFailures`，UI 不显示（与审计原文一致）。
- 定级：**P2 保持**（若产品把"打开技能页即可静默执行第三方代码"视为不可接受，可提 P1，但这属于产品判断）。

### 4.4 P2-76（并发安装/更新没有服务端互斥）

- **实测修正**：单进程内 user 作用域的并发 install 已被 `withSettingsWriteLock` 串行化 —— 同 cwd（A4：1–1616 ms / 10–2902 ms）和不同 cwd（A5：0–1547 / 5–2787 ms）都串行，两包都装成、settings 两条都在。"两个客户端同时点安装"在**同一个 PiWeb 服务进程**里不会撞前缀。
- **仍然成立的风险**：① 两个 PiWeb 进程 / PiWeb + `pi` CLI 同时操作同一 `agentDir/npm`（锁是进程内 `Map`，没有跨进程文件锁；npm 也没有 prefix 互斥）；② `local:true` 走不同 settings 文件（不排队），但前缀也是不同的 `<cwd>/.pi/npm`，**不会共享前缀**，因此"半成品 node_modules"风险不成立。
- 定级建议：**保持 P2 但收窄措辞**（"单进程已串行；风险限于多进程/CLI 并发与跨进程无锁"）；如果产品保证单实例且不鼓励同时用 pi CLI 装包，可降 P3。

### 4.5 P2-77（安装失败无回滚 / 孤儿）

- **措辞修正**：拆成两种失败点（见 §2.3 A3）：
  - npm 级失败：npm 自己回滚 `node_modules`，残留只有空前缀（`package.json`/`.gitignore`）+ npm 缓存；settings 无记录。**没有解包好的包目录孤儿**。
  - install 成功后 settings/校验/reload 失败：包在盘上但没登记，这才是真正的孤儿（代码路径成立，本轮未构造）。
- 定级：**P2 保持**。

### 4.6 测试建议行的修正（`.audit-2026-11-13/plugins-skills.md:398`）

原文建议"用一个 `file:` 本地包走真实 `installAndPersist`：确认…postinstall 是否会跑"。实测：`file:` 只有包在 `npm:` 前缀里才会进 npm；直接给本地路径会走 SDK 的 local 分支，**不跑 npm、不执行脚本**（A2）。建议改为：

> 用 `npm:` 源（本地 registry，或 `npm:file:<tarball>`）安装带 `postinstall` 的 fixture；本地 registry 的 packument 必须带 `hasInstallScript:true`，否则 npm 会跳过脚本（本轮踩过）。同时用 PATH 垫片断言真实 argv 里没有 `--ignore-scripts`。

### 4.7 未触及的条目

P2-73 / P2-74 / P2-78 / P2-79 本轮未做运行时验证（市场搜索、版本锁定、原子写、scope 反查不在本次授权范围），维持审计原文与定级。仅 P2-74 可补一句技术事实：npm 会校验 registry 响应里的 integrity，但 UI 兼容性判定用的版本/元数据与实际安装版本仍可能不是同一份（审计结论不变）。

---

## 5. 清理与可复现

- 仓库内临时文件 `.audit-2026-11-13/scratch-plugin/`（临时 vitest 配置、两个 harness、一个 trust 探针脚本）**已删除**；`git status --porcelain` 与 `.audit-2026-11-13/baseline-git-status.txt` 完全一致。
- 原始证据已归档到 `.audit-2026-11-13/verify-evidence/`（含 `a1…a7`、`b0…b3` 的 JSON、`npm-argv.log`、`npm-registry-requests.log`、两份 vitest 完整输出、真实 agent 前后快照，索引见该目录 `README.md`）。
- 实验目录 `%TEMP%\piweb-verify-plugin\` 已清理：先用 `rmdir` 删掉 3 个 junction（只删链接、不碰目标，删后确认 `external\skill-pack-three\inner\SKILL.md` 仍在），再把根目录送进回收站。
- 复现要点：Node 24 + 仓库自带 npm/vitest；`PI_CODING_AGENT_DIR`、`HOME`、`USERPROFILE`、`npm_config_cache` 四者必须同时指向临时目录；junction 用 `cmd /c mklink /J`（无需管理员）。

---

## 附：本轮实跑汇总

```
A: plugin-install.e2e.test.ts   7 passed (7)   17.27s
   A1 npm registry install / A2 local path / A3 failing postinstall /
   A4 same-cwd concurrency / A5 cross-cwd concurrency / A6 project scope /
   A7 read-only listing triggers install
B: skill-delete.e2e.test.ts     4 passed (4)    9.02s
   B0 fs.rm junction control / B1 junction -> external repo /
   B2 nested skill does NOT protect / B3 others blocks when second skill discovered
真实 agent 目录：settings.json SHA256 前后一致，npm/skills 条目一致，无 fixture 包残留。
```
