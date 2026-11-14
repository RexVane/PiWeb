# 第二波结论 对抗式复核报告

复核人：verify-wave2（task-20）　日期：2026-11-13 19:1x–20:xx　仓库：`D:\AIApp\PiWeb`（HEAD `1d4efba` + 未提交改动）

## 0. 方法与一个必须写在最前面的前提

- **行号会漂，而且漂得很厉害**：审计期间另一个会话在持续改这个仓库。我实测到 `src/lib/agent-manager.ts` 在两次命令之间从 **3136 行缩到 2964 行又涨回去**，`growth-service.ts` 865→911，`.next-releases` 从 13 个目录涨到 63 个条目。所以本报告**全部按代码内容核对**，`path:line` 是我核实时读到的行号，可能在几分钟后失效；每条都贴了可 grep 的原文，请以原文为准。
- 只读：`read/grep/glob`、只读 pwsh、`node -e`、只读 git 查询。**没有**跑测试、没有改任何源码/测试/配置、没有碰 30141/30142、没有碰 `~/.pi`。我唯一写下的文件是本文件。
- 结论数字（详见 §1/§2 的表）：**核对 54 条 → 成立 51 / 夸大 2 / 不成立 0 / 无法静态确认 1**；另有 6 条"成立但危害需运行验证"的子注（在表里标 `→运行`）。**先说结论：第二波两份横切报告（`tests-coverage`、`crosscut`）没有滥发**，`tests-coverage` 是这批里最经得起核的一份（19 条清单我独立重算 19/19 全中，18 处静默早退精确可数）。

---

## 1. 核对表 A：全部 P0 与 P1（16 条）

| # | 来源 | 主张（缩写） | 判定 | 依据（路径:行 + 原文/实测） |
|---|---|---|---|---|
| 1 | plugins-skills **P0-1** | 技能删除的递归范围是黑名单，junction/链接时删掉技能根外的整个目录 | **夸大（定级）**；机制与触发**成立** | 见 §3.1 专项。`skills-service.ts:228-233` `const ownsDir = path.basename(authorized)==="SKILL.md" && path.dirname(skillDir)!==skillDir && !protectedRoots.has(comparableDir) && !others.some(...)` / `await fs.rm(removed,{recursive:ownsDir,force:true})`；`:189-201` 黑名单只有 7+5 个**精确路径**；`path-security.ts:83-89` 返回 `fs.realpath`。**建议 P1**。 |
| 2 | plugins-skills **P1-1** | 安装插件包 = 一键执行第三方代码，无白名单/无二次确认 | **夸大（定级 + 一处前提过时）** | 事实成立：`api/plugins/route.ts:41-43,59-63`（只校验长度≤4096，`source` 原样给 SDK）；`plugins-service.ts:395-405`；SDK `package-manager.js:1653` `["install",...specs,"--prefix",installRoot,"--legacy-peer-deps","--no-audit","--no-fund"]` **确无 `--ignore-scripts`**；`PluginMarketplace.tsx:536-549` 兼容项单击即装。但报告说"认证需显式 `PI_WEB_AUTH`（`web-auth.ts:44-47`）"——现状 `scripts/launcher.mjs:248` 已 `if (!String(childEnv.PI_WEB_AUTH ?? "").trim()) childEnv.PI_WEB_AUTH = "1"`，**启动器默认开认证**；"未认证即可 RCE"只剩"绕过启动器直接 `next start`"这一条窄路径。→ 建议 **P2 + 越权面交 api-auth**。 |
| 3 | plugins-skills **P1-2** | 插件工具在 customActiveTools 下绕过档位，执行期闸门只认硬编码工具名 | **成立** | `agent-manager.ts:1804` `const allowed = m.customActiveTools ? m.customActiveTools.includes(name) : presetAllowsTool(effectivePreset, name);`（`:2957-2974` `setActiveTools` 只与"已知工具全集"求交，不比档位）；`permission-gate.ts:160-176` readonly 分支对不在 `MUTATING_TOOL_NAMES`（`:32`）的名字 `return undefined`（放行），`:205-206` workspace 分支 `const field = WRITE_PATH_FIELDS.get(toolName); if (!field) return undefined;`。`pi.ts:498` readonly 白名单不含任何扩展工具 → 只有手勾路径能开，一旦开了执行期无人管。 |
| 4 | growth **P1-1** | 工作区本身是 git 仓库根时，不问、不可关地往用户 `.git` 写 218 个提交 | **成立** | `growth-service.ts:316` `if ("gitDir" in existing) return existing.gitDir;`（只有非仓库根才 `:317` 抛 needs-consent）；`agent-manager.ts:2636-2641` `prepareGrowthBriefly` 每次 prompt 前调用（`:2802` `if (!session.isStreaming) await prepareGrowthBriefly(m);`）。**实测（只读）**：`git for-each-ref refs/piweb` → `refs/piweb/rounds/d-aiapp-piweb-5511943b`；`git rev-list --count <该 ref>` = **218**；`git rev-list --all --count` = **680**、`--not <ref>` = **462**；`.git/piweb/{exclude,index}` 在；作者 `PiWeb|piweb: workspace changes`。`grep growthEnabled\|PIWEB_GROWTH` 在 `src/` 零命中、`workspace-store.ts` 的 `growthInit` 只存"是否同意 init" → **无开关**成立。 |
| 5 | automations **P1-1** | 无人值守运行里模型一问问题，整轮空转到 30 分钟超时 | **成立** | `extension-ui.ts:231` `if (disposed \|\| (!dialogOpts?.waitForViewer && !opts.hasViewers()) \|\| dialogOpts?.signal?.aborted) return ...`；`:378-382` `askQuestions: { signal, timeout: ASK_USER_TIMEOUT_MS, waitForViewer: true }`；`ask-user.ts:10` `ASK_USER_TIMEOUT_MS = 30*60*1000`；`runner.ts:21` `DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000`、`:312` abort 文案。两个 30 分钟窗口重合，`waitForViewer: true` 正好废掉"没 viewer 就返回默认值"这条短路。 |
| 6 | remote **P1-1** | 局域网入口起不来时静默失败，界面永远"启动中…" | **成立** | `supervisor.ts:405-410` `await startLan(); if (generation!==current.generation){...} if (!current.lan) return remoteStatus();`（早退不留 `publicError`）；`:439` 错误只进 `lanError`；把 `lan.error` 抬成 `publicError` 的代码在 `:490-495` 的 `spawnTunnel` 里，而它只在 `ensureRemoteAccess` 的 `if (!current.lan) return` **之后**才会被调 → 自动路径走不到。`RemoteSection.tsx` 全文 `grep` 只有 `status.public.*`（`:83-85,131,170-174`），`status.lan` **零引用** → 面板停在 `t.remoteWorking` + 二维码占位。 |
| 7 | remote **P1-2** | 无 cloudflared 时手机完全连不上：局域网在跑但界面无地址、不要局域网码 | **成立** | `RemoteSection.tsx:83-85` `const publicReady=...; if (!publicReady) { setPair(null); return; }`、`:86` 只请求 `POST /api/remote/pair`（无 `base:"lan"`）；`api/remote/pair/route.ts` 的 `base=lan` 分支已实现（服务端被 `tests/remote-pair.test.ts` 覆盖）。全 `src/` 内 `lan.urls` 只被 `instrumentation-node.ts` 与 pair 路由用到，**UI 从不渲染**。 |
| 8 | crosscut **P1-1** | 登出把服务端失败吞掉，用户以为已登出、Cookie 仍在、被登录页弹回首页 | **成立** | `GeneralSection.tsx:343-346` `await fetch("/api/web-auth",{method:"DELETE"}).catch(()=>{}); window.location.href="/login";`；`api/web-auth/route.ts:64-70` catch 里 `return ... status:500`（早退，**早于** `:72-75` 的 `clearSessionCookie`+`response.cookies.set`）；`login/page.tsx:38` `if (!result.data.enabled \|\| result.data.authenticated) router.replace(next);`。HTTP 500 是 resolve 不是 reject，`.catch()` 完全兜不住 → 弹回 `/`。同仓正确写法：`RemoteSection.tsx:121-123`（读了 `response.ok` 与 `result.success`）。 |
| 9 | import-export **P1-1** | codex 用"文件头 64KB 里有没有 response_item"判断可导入性，实测 5/22 主会话被隐藏 | **成立（我独立复现，数字与文件名完全一致）** | `files.ts:5` `readHead(file, bytes = 64*1024)`；`codex.ts:122-130` `head = await readHead(file) … const hasMessage = records.some(r => r.type === "response_item"); if (!hasMessage) continue;`。**只读实测**（`~/.codex/sessions` 全量 rollout，自己写的解析）：主线程 22 / 子代理 32，其中 **head 64KB 内无 response_item 的主线程 = 5**，且 5 个文件名与报告列出的 UUID 完全相同（`...01a1b987…`/`...01a1bdbe…`/`...01a1cebc…`/`...01a1d095…`/`..._01a1b98d…`）。 |
| 10 | import-export **P1-2** | ZCode/opencode/dsh 在原生依赖或源库不可用时静默返回 0 条，与注释承诺相反 | **成立** | `sqlite.ts:16-24` `openReadOnly` 三种失败全 `return null`（注释 `:3-5` 却写"这两个来源报错"）；`oc-family.ts:152-153` `if (!db) return [];`；`index.ts` 只把**抛异常**的来源放进 `errors`。dsh 同构：`dsh-zstd.ts:36-38` 失败返回空文本 → `dsh.ts` `continue`。 |
| 11 | launcher-build **P1-1** | 生产构建完整性自检只校验 21/305 个文件，残缺构建判"可用" | **成立** | `build-output.mjs:99-106` 只把 5 个 mandatory 加进 `required-server-files.json.files`，再逐个 `statSync().isFile()`；**实测** `.next/required-server-files.json` 的 `files` 长度 = **21**。路由 chunk（`server/app/**/route.js`）不在清单里 → 删掉 chunk 仍通过。 |
| 12 | launcher-build **P1-2** | 一次性安装构建"先删后拷"替换正在服务的 `.next`，失败无回滚 | **成立** | `install-build.mjs:185-187` `fs.rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:100}); fs.cpSync(path.join(staging,".next"), target,{recursive:true});` —— 无 temp+rename、无旧产物兜底（对照 `apply-global.mjs` 是 rename 三段式）。 |
| 13 | settings-i18n **P1-1** | 网络代理保存后对模型请求不生效、无"重启生效"提示，而"测试连接"当场通过 | **成立** | `GeneralSection.tsx:322` `<Row title={t.httpProxy}>`（同级其它 Row 都带 `desc`，下一行 `:326` 就有）；`agent-manager.ts:2343` `applySettingsToSessions(patch:{steeringMode?...;followUpMode?...;cacheWarming?...})` —— 热应用白名单里没有 httpProxy；`grep applyHttpProxySettings\|configureHttpDispatcher src/` = 0（SDK 侧 `dist/core/http-dispatcher.js:38,68` 只被 CLI 入口 `cli-runtime.js`/`rpc-entry.js`/`setup.js` 调）；真正生效点是 `scripts/launcher.mjs` 起子进程时的 env。 |
| 14 | tests-coverage **P1-1** | 沙箱 e2e 在非 Windows / 无 koffi 时 `return` 而不是 skip → 静默变绿 | **成立** | `tests/agent-resource-isolation.test.ts:748` `if (process.platform !== "win32") return;`、`:750` `if (!(await probeSandboxSupport())) return; // 没有 koffi 的机器上跳过`。vitest 里 `it` 回调正常返回即记为 passed，确实不进 skipped 计数。 |
| 15 | tests-coverage **P1-2** | `windows-acl` / `readonly-mode` 在 koffi 缺失时不是跳过而是崩 | **成立** | `windows-acl.test.ts:14` `describe.skipIf(!win32)`、`:18` `let sandbox: AclSandbox \| null = null`、`:36` `sandbox = await createAclSandbox({...})`（**不判 null**）、`:22` `sandbox!.exec(...)`；`readonly-mode.test.ts:26,36` 同构。而 `windows-acl.ts:122` `if (process.platform !== "win32") return null;`、`:124` `if (!options.spawnRestricted && !koffi) return null;` → `sandbox!.exec` 抛 `TypeError`。文件头注释 `windows-acl.test.ts:5` 写的正是"没有 koffi 时整体跳过"，与实现相反。 |
| 16 | tests-coverage **P1-3** | 14 个 growth 用例在无 git 环境静默通过；全仓这类静默早退 18 处 | **成立（数字精确）** | 我用 `^\s*if \(.*\) return;\s*$` 全仓扫描：`growth-service.test.ts` **12** 处（110,169,205,223,234,249,271,298,346,369,394,411）、`growth-tracker.test.ts` **2** 处（29,90）、`agent-resource-isolation.test.ts:748` **1** + `:750`（带行尾注释，正则漏计）**1**、`lib/sandbox/manager.test.ts:39` **1**、`lib/permission-gate.test.ts:91` **1** = **18**；另 3 处（`agent-resource-isolation.test.ts:600`、`packaging.test.ts:35,37`）确为控制流分支。**逐项对上报告**。 |

**A 段小计：成立 14 / 夸大 2 / 不成立 0 / 无法静态确认 0。**

---

## 2. 核对表 B：涉及"数据丢失 / 越权 / 崩溃"的 P2（32 条）

`→运行` = 机制已确认、危害需要跑起来才知道（已进 §5 清单）。

| # | 来源 | 主张（缩写） | 判定 | 依据 |
|---|---|---|---|---|
| 1 | plugins P2-1 | 市场不校验结果真是 pi 包；搜索词原样拼进 npm 查询 DSL | 成立（机制）`→运行` | `plugins-marketplace.ts:484-488` `["keywords:pi-package", catTerm, cleanedQuery].filter(Boolean).join(" ")`；`:448-453` 只把 `pi-package` 从 keywords 展示里删掉、从不校验；`:524-526` 结果不二次校验。"非 pi 包真会混进结果"取决于 npm 语义，未实证（不允许发外网）。 |
| 2 | plugins P2-2 | 兼容判定版本 ≠ 实际安装版本 | 成立 | `plugins-marketplace.ts:440/471` 卡片带 `version`、`source: \`npm:${name}\`` 不带版本；`PluginMarketplace.tsx:130-134` 用带版本的列表探测兼容性、`:549` 安装用不带版本的 source。 |
| 3 | plugins P2-3 | 只读 GET 可能悄悄 `npm install` | 成立（机制）`→运行` | `pi.ts:339-346` `queueLoaderReload → entry.loader.reload()`（SDK `resolve()` 无 onMissing → `installMissing`）；对照 `plugins-service.ts:66-70` 自己那条特意传了 `async () => "skip"`。实际触发需缓存缺失，未实测。 |
| 4 | plugins P2-4 | 并发安装无服务端互斥 | 成立 | `settings-write-lock.ts:9-20` 是**进程内** `Map` 串行；`:23-34` `withExternalSettingsLock` 才是 proper-lockfile，install 路径没用它。 |
| 5 | plugins P2-5 | 安装失败无回滚；"装上了但刷新失败"报 500 | 成立 | `plugins-service.ts:398-404` `installAndPersist → flushSettingsOrThrow → verifySettingsField`，任一抛错已下载内容留在盘上。 |
| 6 | plugins P2-6 | `SKILL.md` 非原子写 + `reloadAllLoaders` 吞错 → "假成功" | 成立 | `skills-service.ts:172` `await fs.writeFile(authorized, next, "utf8");`（裸覆盖，无 tmp+rename、无备份）；`pi.ts:444` `catch { /* 单个失败不影响其他 */ }`。 |
| 7 | plugins P2-7 | 包作用域/local 由客户端给，服务端不核对真实位置 | 成立 | `api/plugins/route.ts:50` `body.scope === "project" ? "project" : "user"`、`:66` `body.local === true`；`plugins-service.ts:307/409` 直接拼 settings 路径。 |
| 8 | growth P2-1 | >1 MB 的文件被记成"删除"，树与统计和磁盘不符 | 成立 | `growth-service.ts:653-661` `include: Boolean(stat?.isFile() && stat.size <= MAX_FILE_BYTES)` → 超限进 `removals`；`:664-666` `update-index --force-remove`；之后 `diffTreesRaw(parent, tree)` 得 `D`。 |
| 9 | growth P2-2 | 同工作区两个会话并发，改动记到错误的一轮 | 成立 | `growth-service.ts:87-97` registry/ref 只按 cwd 派生；`RoundMeta.session` 只用于提交信息与过滤，不影响 tree 内容。 |
| 10 | growth P2-3 | 快照无**字节**上限、`refs/piweb` 对象永不回收、在用户仓库里 `gc --auto` | 成立 | `:27-35` 三个上限全是"个数"（`MAX_FILE_BYTES` / `MAX_CANDIDATES` / `MAX_CHANGES_PER_ROUND`），无总字节预算；`gcInBackground` `:698-708` `spawn(git, ["--git-dir",ws.gitDir,"gc","--auto","--quiet"])`。 |
| 11 | growth P2-5 | 取消被标成"本轮出错"（与轨迹视图口径相反） | 成立（口径差异）`→运行` | `growth-tracker.ts` 的 `roundStatus` 只看 `stopReason==="error" → "error"`，没有 `trajectory.ts` 里的 `isAbortMessage` 消歧；"provider 取消走 stopReason=error"这一触发条件需真机。 |
| 12 | growth P2-6 | 一轮 commit 失败 → 该轮从时间轴消失 → 轮号与对话错位 | 成立 | `growth-tracker.ts` `enqueue` 用 `chain.then(fn, fn).catch(reportError)`；`useGrowth.ts` 的 `numberRounds` 按数组下标重编号。 |
| 13 | automations P2-1 | `running` 记录被 pid 复用永久锁死（不能跑、不能删） | 成立（代码）`→运行` | `store.ts:45-53` 只有 `process.kill(pid,0)` + `EPERM` 判活；`:326` 删除前 `hasLiveRunOwner` → 409；`:353` claim 跳过。pid 复用概率未实测。 |
| 14 | automations P2-2 | 无全局并发上限，N 个到期就拉 N 个会话 | 成立 | `runner.ts:412-419` `for (const task of due) { … await launchAutomationTask(task,"schedule",…) }`，`launchAutomationTask` 只等 `recordRunStarted` 落盘；互斥只按 taskId。 |
| 15 | automations P2-3 | 一条记录不可解析 → 整个自动化功能不可用、无修复入口 | 成立 | `store.ts:167-170` `if (tasks.some(t=>t===null) \|\| runs.some(r=>r===null)) throw new Error("Invalid automation record; existing data was not modified")`。 |
| 16 | automations P2-4 | 漏跑一律静默跳过（2 分钟宽限） | 成立 | `store.ts` 内 `claimDueTasks`：`const missed = maxLatenessMs!==undefined && now-task.nextRunAt>maxLatenessMs; … if (!missed) claimed.push(updated)`（推进 `nextRunAt` 但**不落任何记录**）。 |
| 17 | automations P2-5 | 没有一等公民"停止运行" | 成立 | `api/automations/route.ts` 的 action 只有 `create/update/toggle/delete/runNow`（`:59,71,85,92,98`）。 |
| 18 | automations P2-6 | full 档会话可无上限自建 full 档任务、无确认删除 | 成立（限 full 档） | `agent-tool.ts:49-52` `Type.Literal("full")`；`:135` `createAutomationTask({... toolPreset: params.toolPreset})` **无档位钳制**；UI 有 `confirm()`、工具无。readonly/workspace 两道闸门确实拦得住（`permission-gate.ts:191-198`）。 |
| 19 | automations P2-7 | claim 已推进 `nextRunAt` 后启动失败 → 静默吞掉一次运行 | 成立 | `claimDueTasks` 在返回前写 `nextRunAt`；`runner.ts:415-419` 失败只 `console.error("[automations] Failed to start task …")`。 |
| 20 | remote P2-1 | 进程退出不清理 cloudflared（Windows 不级联杀子进程） | 成立 | `supervisor.ts:505` spawn 未 detached、无退出钩子；`grep process.on(` 在 `src/` = **0**，只有 `web-launch-token.ts:47` 一处 `process.once("exit")`（清 token）；唯一 kill 在 `:598-603` 的 `stopPublic`。 |
| 21 | remote P2-2 | `/pair` 失败限流是进程级全局计数，30 次/分锁死合法扫码 | 成立 | `pairing.ts` `failedAt` 模块级数组、不按 IP/码/原因分桶；`proxy.ts:9` `PUBLIC_PATHS` 含 `/pair`。 |
| 22 | remote P2-3 | 默认就公网暴露 + 配对=30 天主人权限 + 无单设备撤销 | 成立 | `supervisor.ts:396-420` 生产+认证即自动开局域网并自动 `startPublic`；`web-auth-shared.ts:11` `SESSION_MAX_AGE_SECONDS = 30*24*60*60`；`RemoteSection.tsx:121` 只有 `?scope=all`。`remoteLanEnabled` = `!isOff(PIWEB_REMOTE_LAN)` 且 `startPublic` 在 `if (!current.lan) return` 之后 → **`PIWEB_REMOTE_LAN=0` 确实把两个入口一起关**（"没有只局域网选项"成立）。 |
| 23 | remote P2-4 | 局域网入口明文 HTTP，Cookie 在 LAN 权威下不带 `Secure`、30 天 | 成立 | `supervisor.ts:383` `startLan(port=…, host="0.0.0.0", …)`；`web-auth.ts:153-166` `secure: isSecureRequest(request)`（只认 `https:` 或 `x-forwarded-proto`）。 |
| 24 | remote P2-6 | `stopLan()` 不等 `lanStarting` → "关闭"返回成功后端口又被绑上 | 成立 | `supervisor.ts:447-454` 只看 `current.lan`；`startLan` `:383-392` 期间只挂 `current.lanStarting`。 |
| 25 | import P2-1 | 大文件防护在"读完/解完之后"才生效；200MB 闸门对 zstd 只约束压缩后体积 | 成立 | `index.ts:39,156` `MAX_SOURCE_BYTES=200MB` 且 `fs.stat(location).size`；`:220` `session.entries.length > MAX_ENTRIES` 在 `read()` 之后；`dsh-zstd.ts:36-38` `decodeZstdFrames(await fs.readFile(file))` 整份解压。 |
| 26 | import P2-2 | 导入一次就全量重扫且无超时/进度/取消 | 成立 | `index.ts:169-181` `module.scan({limit: 0})`（`withTimeout` 只包扫描接口）；`api/sessions/import/route.ts:78` 调 `importSessions` 未传 `onProgress`。 |
| 27 | import P2-3 | HTML 导出把临时文件写在服务进程 CWD，同名并发互踩 | 成立 | `agent-manager.ts:3131-3134` `const outPath = await session.exportToHtml(); … rm(outPath,{force:true}).catch(()=>undefined)`（未传 `outputPath`）；SDK `export-html/index.js:193-198` `if (!outputPath) outputPath = \`${APP_NAME}-session-${basename}.html\`` → `writeFileSync` 相对 CWD。 |
| 28 | import P2-4 | ZCode/opencode 不过滤软删除/归档 | 成立（触发需源端删除） | `oc-family.ts:157-165` 的 SQL 只有 `parent_id IS NULL` + 消息数 >0，无 `time_deleted/time_archived` 条件。 |
| 29 | settings P2-3 | 提示词来源正文无 1 MB 上限（只有"链接资源"有） | 成立 | `prompt-sources.ts:253` `if (sourcePath !== undefined && stat.size > 1024*1024) throw …` —— 面板点文件类来源走的就是 `sourcePath === undefined`。 |
| 30 | settings P2-4 | 非 Windows 一键更新会替换正在服务中的安装目录 | 成立（代码）`→运行` | `update-service.ts:89-96` `if (platform !== "win32") return true;`；`assertIdle` 只看有没有流式会话。真实损失需 Linux 实机。 |
| 31 | tests-coverage P2-6 | 14 个 API 路由零执行，含带分支的 `sessions/[id]` DELETE | 成立 | 我独立重算的零执行清单里正好 **14 个 `src/app/api/*/route.ts`**；`api/sessions/[id]/route.ts:23-36` `disposeSessionPath → deleteSession → forgetSession`，`BoundaryError→400`。 |
| 32 | crosscut P2-1/2/3（三条一起） | ① 两个 `aria-modal` 未接 useDialog 且被抢焦点 ② 浅色下 warn 2.15:1 / success 2.28:1 ③ 客户端 fetch 零超时 | **全部成立（②③ 我实算/实例）** | 见 §3.2。 |

**B 段小计：成立 31 / 无法静态确认 1（launcher P2-2 的"双实例写坏会话文件"——机制成立，数据面归 bridge）。**

---

## 3. 三处专项复核（lead 点名）

### 3.1 `plugins-skills` P0-1：机制成立，**触发条件也能达到**，但定级应降为 P1

你独立确认的两点（`ownsDir` 是黑名单、`fs.rm(recursive)`）我逐字复核无误。你点名要核的两件事：

**(a) `resolveDiscoveredPath` 会不会 realpath 到技能根外？——会，而且这正是唯一的"逃出"动作。**
`path-security.ts:79-93`：请求路径先 `fs.realpath(requested)`（`:83`），再对 `allowed` 里每个候选 `fs.realpath` 后 `samePath` 比对，**返回 `realRequested`**。`allowed` 来自 `listSkills(cwd).map(s => s.filePath)`，而 SDK 记录的 `filePath` 是拼出来的**链接拼写**（`skills.js:169-190` 递归时用 `join(dir, entry.name)`，`:236-261` 直接把它当 `filePath`/`baseDir`）。所以：

- 授权比对比的是 realpath（能识破 junction）✅
- 但授权通过之后交给 `deleteSkill` 的也是 realpath → `skillDir = path.dirname(authorized)` **已经站在技能根外**。

**(b) `others` 判重会不会误拦？——会拦掉一部分，但拦不住报告描述的那个最典型形态。**
`others` = 所有已发现技能的 realpath 集合；`ownsDir` 要求 `!others.some(o => o !== comparableFile && within(o, comparableDir))`。SDK 的 `loadSkillsFromDirInternal` 会**递归进子目录**（`skills.js:189-193`），所以：
- 若链接目标是"一个仓库里放多个技能"（`skill-pack/a/SKILL.md`、`skill-pack/b/SKILL.md`）→ `others` 里会有 `skill-pack/a/SKILL.md`，`within(它, skill-pack)` 为真 → `ownsDir=false` → 只删 `SKILL.md` 一个文件，**安全**。
- 若链接目标是"一个仓库就是一个技能"（根上 `SKILL.md` + `scripts/`、`.git/`、`README`，无嵌套技能）→ `others` 不拦 → `ownsDir=true` → **整个仓库连同 `.git` 被递归删掉，`force:true` 不进回收站**。这就是报告写的形态，成立。

另外两点报告说得对、值得保留：`protectedRoots`（`:189-201`）里没有任何"技能根的子目录"之外的包含判定，所以 `<agentDir>/skills/pack` 天然不在黑名单；`sourceInfo` 判定走的是 `resolve(filePath)` **非 realpath**（SDK `resource-loader.js:770-792`），所以 junction 出来的技能被判 `scope=user, origin=top-level` → 通过 `:220-222` 的 package 守卫。

**定级：我判 P1，不是 P0。** 理由（三条都要同时成立才触发）：
1. 需要用户**自己在技能根里建 junction/符号链接**——PiWeb 和 pi 都不创建这种结构，默认安装状态下不存在；
2. 链接目标必须**根上直接放 SKILL.md**、且**没有嵌套技能**（否则 `others` 拦）；
3. 删除是用户主动点的（有确认框，只是不显示路径）。

按 BRIEF 字面"数据丢失=P0"，如果团队认定"链接=授权删目标"，则 P1 更合适；**如果产品打算在文档里推荐"把技能仓库链接进技能根"（多工具共享 `~/.agents/skills` 正是这种用法），就必须升回 P0 并先修**。修法优先级不受定级影响：加一条"`comparableDir` 必须在某个技能根之内"的**包含**判定，或对未 realpath 的 `dirname(filePath)` 做 `lstat().isSymbolicLink()` 时只删链接（报告的两条建议都对）。

### 3.2 `crosscut` 的重 5 条：全部经得起核（其中 2 条我实算）

| 断言 | 我的实证 | 判定 |
|---|---|---|
| 登出静默失败（P1-1） | 见 §1 #8，三段链路全对上；同仓 `RemoteSection.tsx:121-123` 是正确写法 | **成立** |
| 两个 `aria-modal` 未接 `useDialog`（P2-1） | `grep 'useDialog('` = **13** 个调用点（ConfirmDialog、DirectoryPicker、FileViewer×2、ImageViewer、ProviderSetupModal×2、SessionSidebar×3、SettingsPanel、PluginsSection、AutomationModal）——**与报告逐个一致**；`grep aria-modal` = 15 处，其中 `ExtensionUI.tsx:286`、`ProjectPanel.tsx:39` 确实不在那 13 个里。`useDialog.ts:16-22` 的 `scopes()`=`[root, …[data-dialog-owner] 且 owner 相符]`、`:41-46` `onFocus` 对"不在 scopes 内的焦点"直接 `focusInside(top)` → 焦点会被拽回下层弹层，**键盘用户确实操作不了那个权限框** | **成立** |
| 对比度 2.15:1 / 2.28:1（P2-2） | 我按 WCAG 公式算：`rgb(245,158,11)` / `#ffffff` = **2.148**；`rgb(34,197,94)` / `#ffffff` = **2.279**；报告给的 `#548c9e`(pebrel 深色块) = **3.735**。变量链 `--dsw-warn: var(--dsw-amber-500)`（`globals.css:56`）、`--dsw-success: var(--dsw-green-500)`（`:57`）、`--dsw-bg-base: #ffffff`（`:39`）；`.pw-warn-text{…color:var(--dsw-warn)}`、渲染点 `ChatWindow.tsx:863` | **成立**（报告说 `--dsw-success` 作文字色"另有 10 处"，实测 `grep dsw-success` 在 components 里 17 行用作前景/文字色，是**少报**不是多报） |
| 50 处 `fetch` 零超时（P2-3） | `src/components/**` 里 `fetch(` = **51**、`AbortSignal.timeout` = **0**、`signal:` = 11（与报告 50/11/0 一致，多出的 1 处是审计期间新增）；`src/hooks/**` 另有 19 处 `fetch(` 也全是 0 超时 | **成立** |
| ConfirmDialog 遮罩误关（P3-1） | `ConfirmDialog.tsx:54-59` 遮罩 `onClick={() => { if (!busy) onCancel(); }}`、`:67` 内层 `onClick={(e)=>e.stopPropagation()}`；同仓正确写法 `FileViewer.tsx:400`、`ModelsSection.tsx:1024` 都是 `onMouseDown + e.target===e.currentTarget` | **成立**（拖选文字在遮罩上松手 → click 落在 mousedown/mouseup 的最近公共祖先=遮罩） |

**`crosscut` 有没有滥发？没有。** 13 条里我核的 5 条全中；只有计数漂移（fetch 50→51、success 文字色 10→17）。

### 3.3 `tests-coverage` 的"19 个零执行模块"：**清单 19/19 全部可复现**

我写了一个只读对账脚本（`node`，读 `tests/**` 的 import 图 + 逐测试文件剪掉 `vi.mock` 目标，`src/` 侧 210 个非 `.d.ts` 模块），结果 **19 个模块、与报告清单逐条相同**（顺序按路径）：

`api/agent/[id]`、`api/agent/new`、`api/config`、`api/git`、`api/github`、`api/growth`、`api/models/defaults`、`api/pi-settings`、`api/plugins/marketplace`、`api/prompts`、`api/sandbox`、`api/sessions/[id]`、`api/skills`、`api/version`（**14 个路由**）、`src/app/layout.tsx`、`src/app/page.tsx`、`src/instrumentation.ts`、`src/lib/session-import/paths.ts`、`src/lib/version.ts`。

两处**表述瑕疵**（不影响结论）：
1. 文件名写成了 `src/app/layout.ts` / `src/app/page.ts`，实际是 **`.tsx`**；
2. 行数合计写 467，我重算 541——因为审计期间这些文件都变大了（如 `api/growth/route.ts` 48→55、`api/prompts/route.ts` 43→52），不是统计口径问题。
3. `paths.ts` 与 `version.ts` 判"零真实执行"是对的：它们分别被 `session-import-service.test.ts:12-19`、`session-import-sources.test.ts:22` 和 `update-service.test.ts` **整段 `vi.mock`**，我在剪掉 mock 之后这两个模块在所有测试图里都消失。

**弱断言抽查（4 个，全部成立）**：
- `if (...) return;` **18 处**：见 §1 #16，数目与分布完全对上（我扫出 21 处同名模式，其中 3 处是合法控制流，正好如报告所述）。
- `agent-events-route.test.ts:9-36` 自造假实现：`vi.hoisted(() => { const state={seq,buffer,subscribers}; return { state, publish, getManaged, parseLastEventId, sseEventId, buildSnapshot, subscribe, unsubscribe, holdViewer } })` + `vi.mock("../src/lib/agent-manager", () => manager)` —— **`subscribe/parseLastEventId/sseEventId/holdViewer` 全部是手写第二实现**，路由契约对齐的是这份假契约。报告 P2-1 成立。
- `settings-usage-card.test.tsx:12` `const CARD_BORDER='0.5px solid var(--dsw-border-l2)'`、`:48` `name.closest(\`div[style*="${CARD_BORDER}"]\`)` —— 拿内联样式串当选择器，成立（行号比报告漂了 2 行）。
- `pi-settings.test.ts:149-151` `const update = patchPiSettings({...}); await new Promise(r=>setTimeout(r,100)); expect(await fs.readFile(file,"utf8")).toBe("{}")` —— 负向断言 + 固定 100ms 窗口，成立。
- 附带：`prompt-panel.test.tsx:50` `expect(screen.getAllByText("项目").length).toBeGreaterThan(0)` 成立（行号漂到 50）；`growth-tracker.test.ts:9-15` 自写 `waitFor`（8s 轮询 + 真 setTimeout + `throw new Error("timeout")`）成立。

---

## 4. 漏报补充（我实读代码后认为第二波漏掉的）

### V2-漏-1 growth：`gc` 的触发计数是**进程内内存**，重启即归零 → "每 50 次提交 gc 一次"基本不生效（P2）

- **位置**：`src/lib/growth-service.ts:694-695`（`GC_EVERY_COMMITS`/`const commitsSinceGc = new Map<string, number>()`）、`:774-776`
- **证据**：```ts
  const count = (commitsSinceGc.get(ws.key) ?? 0) + 1;
  commitsSinceGc.set(ws.key, count % GC_EVERY_COMMITS);
  if (count >= GC_EVERY_COMMITS) void gcInBackground(ws);
  ```
  计数只在 `Map` 里，进程退出即丢。每个 prompt 通常只产生 1–2 个 commit（user + round），所以**同一个进程要连做 25–50 轮**才会触发一次 `gc --auto`；每天重启一次、每天聊十几轮的常规用法下，这个"缓解措施"永远不会执行。
- **后果**：与报告 P2-3（无字节预算）叠加 → 用户 `.git/objects` 里的松散对象只增不减。本机现场就是证据：**589 loose / 3187 KiB**，而且 `git count-objects` 显示的对象全部挂在 `refs/piweb/*` 上永久可达。
- **建议**：把计数落盘（`.git/piweb/state.json`）或改成"按 `refs/piweb` 已有 commit 数取模"。

### V2-漏-2 growth：`MAX_CANDIDATES` 检查在 `git ls-files` **全量输出之后**，防护先撞上 64MB 缓冲 / 30s 超时（P2）

- **位置**：`src/lib/growth-service.ts:613-624`（`ls-files -z --others --modified --deleted` 之后才判 5 万）、`:163`（`maxBuffer = 64MB`）、`:177`（`setTimeout(…, 30_000)` → `git timed out`）
- **证据**：`const listed = await shadow(ws, ["ls-files","-z","--others",…]); const candidates = Array.from(new Set(listed.stdout.toString("utf8").split("\0")…)); if (candidates.length > MAX_CANDIDATES) throw new GrowthError("snapshot has N candidate files…","too-large")`
- **后果**：仓库里 `node_modules` 之类没被 ignore 时，用户看到的是 `git output exceeded the buffer limit` 或 `git timed out`（英文原文经 `ProjectPanel` 直出），而**不是**那句本来很可用的"最多目录：node_modules: 48211，请用 .gitignore 排除"。另外 `getWorkspace` 在抛错后会把 registry 项删掉（`:349` `pending.catch(() => registry.workspaces.delete(key))`），于是**每次 prompt 都重跑一遍**这次失败的扫描（5s 放行后仍在后台跑，见报告 P2-4）。
- **建议**：`ls-files` 走流式并在第 50001 条时 kill；或先用 `git status --porcelain -uno` 之类廉价命令探规模。

### V2-漏-3 remote：`listenLan` 的 `error` 监听在 listen 成功后**变成死监听**，之后的监听级错误被静默吞掉（P3）

- **位置**：`src/lib/remote/supervisor.ts:433-445`
- **证据**：```ts
  try {
      await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, host, resolve);
      });
  } catch (error) { current.lanError = …; server.close(); return remoteStatus().lan; }
  ```
  `once("error", reject)` 在 listen 成功时**不会被移除**。此后 server 再 emit `error`（accept 期间 `EMFILE`/`ECONNABORTED`，或 `closeAllConnections` 与 `listen` 竞态），只会调用一个已 settle 的 Promise 的 `reject` —— 既不写 `lanError`、不重建监听、也没有日志。而 `mobile-proxy.ts` 只给了 `up`/`upstream` 加 error 处理（`:106,:139`），server 本身没有。
- **后果**：`remoteStatus().lan.running` 仍为 `true`、UI 显示"已连接"，实际新连接已经进不来；手机侧表现为"一直转圈"且主机侧无任何线索。
- **建议**：listen 成功后 `server.off("error", reject)` 并挂一个持久的 `server.on("error", e => { current.lanError = …; })`。

### V2-漏-4 remote：只有 `ensureRemoteAccess` 那条路有自动重连；`POST {action:"start"}` 起的隧道退出后无人重建（P2）

- **位置**：`src/lib/remote/supervisor.ts:89`（重建逻辑的守卫）、`src/app/api/remote/route.ts:50-53`
- **证据**：`if (current.automaticRetry && tunnel.checkedAt - tunnel.unhealthySince >= TUNNEL_STALLED_TIMEOUT_MS) { current.publicRetryAt = …; dropTunnel(tunnel.child); }` —— **`automaticRetry` 这个 interval 只有 `ensureRemoteAccess` 创建**。而 `case "start": await startLan(); await startPublic();` 直接起隧道，不起 interval。
- **后果**：这条路起的隧道一旦 `exit`（`spawnTunnel` 的 exit 分支只写 `current.publicError = "公网连接中断（code N），正在等待自动重连"`）或健康检查判定持续不可达，**没有任何人重连**，但界面文案承诺"正在等待自动重连"。用户只能自己再点一次。
- **建议**：把"重建"从 `automaticRetry` 解耦（用 `publicRetryAt` + 一个统一的 ticker），或在 `start` action 里也走 `ensureRemoteAccess`。

### V2-漏-5 automations：`isCurrent()` 翻假时 `break` 丢弃**已 claim** 的到期任务，且不落记录（P2）

- **位置**：`src/lib/automations/runner.ts:408-419`
- **证据**：```ts
  const due = await claimDueTasks(now, runtime.activeTaskIds, storePath, { maxLatenessMs: … });   // 已推进 nextRunAt
  for (const task of due) {
      if (opts?.isCurrent && !opts.isCurrent()) break;      // ← 这里直接丢
      try { const { run } = await launchAutomationTask(task, "schedule", …); … }
  ```
- **后果**：与报告 P2-7 同族但**是另一条代码路径**（P2-7 讲的是 launch 抛错，这里讲的是 `break`）。触发场景很常见：dev 热重载、`stopAutomationScheduler()`（例如关掉自动化页面/重新初始化 runtime）恰好落在 tick 中间 → 这一批已 claim 的任务 `nextRunAt` 已被推到下一次，**一次运行静默消失**，运行记录里没有、`lastRunAt` 不更新。任务越多、越集中在整点，丢的概率越大。
- **建议**：`break` 前把剩余 `due` 的 `nextRunAt` 回滚，或改成"只 claim 一个、跑一个"。

### V2-漏-6 skills：`POST /api/skills {action:"read"}` 读正文**没有任何大小上限**（P3）

- **位置**：`src/lib/skills-service.ts:182-186`
- **证据**：```ts
  export async function readSkillFile(filePath: string, cwd?: string): Promise<string> {
      const skills = await listSkills(cwd);
      const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
      return fs.readFile(authorized, "utf8");     // 无 stat、无上限
  }
  ```
  与 settings-i18n P2-3（`/api/prompts` 的 `readPromptSource` 只给"链接资源"加了 1 MB）是同一个漏洞家族，两份报告都只写了 prompts 那一侧。`api/skills/route.ts:29-32` 把它整份塞进 `NextResponse.json`。
- **后果**：一个几十 MB 的 `SKILL.md`（或链接到的大文件）会让服务端整份读入 + 再序列化一份；手机端直接崩页。
- **建议**：与 prompts 一起统一加 1 MB 上限（同一处抽函数）。

---

## 5. 必须运行验证清单（静态到此为止的部分）

按"能证实/能否定第 3、4 节结论"排序。**都属于我在只读约束下不能做的破坏性/联网操作**，建议由有写权限的人在一次性的临时 agentDir / 临时工作区里做。

| # | 要验的结论 | 怎么验（最小步骤） | 期望 |
|---|---|---|---|
| 1 | **P0-1 技能删除越界** | 临时 `PI_CODING_AGENT_DIR`；`mklink /J <agentDir>\skills\pack D:\tmp\skill-pack`（目标里放 `SKILL.md`+`.git`+`scripts/`，**不放嵌套技能**）；调 `deleteSkill("<agentDir>/skills/pack/SKILL.md")`；检查 `D:\tmp\skill-pack` 是否还在。再补一次"目标是多技能仓库"的对照。 | 现状：目标被整目录删除（证 P0-1 触发条件可达到）；对照：只删 SKILL.md（证 `others` 真会拦） |
| 2 | remote P1-1 静默失败 | `node -e "require('net').createServer().listen(30142)"` 占端口 → 生产模式启动 PiWeb → 打开 设置→远程连接，等 30s 看面板文案；同时 `curl /api/remote` 看 `lan.error` 是否有值 | 面板停在"启动中…/正在准备连接二维码"，`lan.error` 有 EADDRINUSE 但不显示 |
| 3 | remote P1-2 局域网兜底 | 卸载/改名 cloudflared → 生产启动 → 看面板是否出现 `http://192.168.x.x:30142` 与局域网码 | 现状：不出现；`POST /api/remote/pair {base:"lan"}` 手工调用却能拿到码 |
| 4 | crosscut P1-1 登出 | 把 `~/.pi/agent/web-revocations.json` 设为只读（或 mock `revokeSessionCookie` 抛错）→ 点"登出" | 现状：无提示、跳到 `/login` 后被 `router.replace("/")` 弹回；Cookie 仍有效 |
| 5 | plugins P1-2 档位被勾选穿透 | readonly 档 → 工具面板勾一个扩展工具（用 `examples/` 里任一带写盘的工具）→ 让模型调用 | 现状：执行期 `permissionDenial` 放行（写盘成功） |
| 6 | automations P1-1 30 分钟空转 | fake deps 里让模型触发 `ask`；把 `ASK_USER_TIMEOUT_MS` 临时调小（或等 30s 观察无返回） | 现状：不返回 `unavailable/skipped`，直到运行超时 |
| 7 | tests P1-2 koffi 缺失崩 | 临时把 `node_modules/koffi` 改名 → `npx vitest run tests/lib/sandbox/windows-acl.test.ts` | 现状：整文件红 + `TypeError: Cannot read properties of null`（不是 skip） |
| 8 | launcher P1-1 残缺构建被判可用 | 复制 `.next` 到临时目录 → 删掉 `server/app/api/health/route.js`（保留 21 个清单）→ 让 `readProductionBuild` 跑 | 现状：通过；`next start` 起得来，直到有人访问该路由才 `MODULE_NOT_FOUND` |
| 9 | V2-漏-5 已 claim 被丢弃 | 两个到期任务 + `isCurrent` 在第一个 launch 后翻假 | 第二个任务的 `nextRunAt` 已推进、无运行记录 |
| 10 | import P2-1 OOM | 造一个 200MB 的 `.jsonl.zstd`（压缩比 ~20:1）→ `POST /api/sessions/import` | 进程 RSS 冲到 GB 级；`MAX_ENTRIES` 未拦 |
| 11 | remote P2-2 限流维度 | 对 `/pair?code=xxxx` 连发 30 次 → 立刻用**合法**码配对 | 现状：合法码 429 |
| 12 | growth P1-1 的"多会话污染"（报告 P2-2） | 同一 cwd 两个会话交替 settle，比对各自 `changes` | 现状：A 的改动出现在 B 的 tree 里 |
| 13 | 双实例共享 `~/.pi/agent`（launcher P2-2 的数据面，`无法静态确认`） | 慢启动窗口里连点两次 `piweb` → 两个实例同时打开同一条会话并各发一条消息 | 需 bridge 区域裁定 JSONL 并发追加是否安全；我只确认了 `proper-lockfile` 全库只用在 `settings-write-lock.ts` |

**不需要再验的**（已实证，别再排期）：§3.2 的对比度（2.148/2.279 已按 WCAG 公式算死）、§3.3 的 19 条零执行清单、18 处静默早退、`~/.codex` 的 5/22、本仓库 `refs/piweb` 的 218 个 commit。

---

## 6. 复核结论

1. **这批报告质量高于基线预期**：54 条核对里 **51 条成立、0 条不成立**，`tests-coverage` 与 `crosscut` 这两份"容易滥发"的横切报告反而是最经得起核的两份——`tests-coverage` 的 19 条清单、18 处计数、7 个抽查样例我都能独立复现，`crosscut` 的 13 条我核的 5 条全中（含两处我自己算/自己数的硬指标）。
2. **两条要改定级**：`plugins-skills P0-1` → **P1**（触发需要用户自建链接，且 `others` 会拦掉"多技能仓库"这一半场景）；`plugins-skills P1-1` → **P2**（"未认证即 RCE"这一前提在 `launcher.mjs:248` 默认注入 `PI_WEB_AUTH=1` 之后已经不成立，剩下的是"安装无二次确认"这种产品加固问题）。这两条都不该占 P0/P1 的修复预算——把名额让给 growth P1-1、remote P1-1/P1-2、crosscut P1-1。
3. **第二波真正的漏报集中在"缓解措施没生效"这一类**，而不是新的漏洞：V2-漏-1（gc 计数不落盘 → 缓解措施等于没有）、V2-漏-2（`MAX_CANDIDATES` 在崩溃面之后）、V2-漏-4（自动重连只覆盖一条启动路径）、V2-漏-5（`break` 丢弃已 claim 的任务）。四条的共同点都是**代码里写着"已经处理了"，实际路径没走到**——这和 BRIEF 里"检查防护是否真的生效（不是只看名字）"正好对上。
4. **仍无定论的一点**：`launcher-build P2-2`（双实例共享 `~/.pi/agent`）会不会写坏会话 JSONL，需要 bridge 区域给结论；我只确认了"两个实例可以静默同时存在"和"全库只有一处 `proper-lockfile`"。
