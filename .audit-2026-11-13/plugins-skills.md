# 插件/技能/市场 审计报告

审计者：audit-plugins（task-13）　日期：2026-11-13　基线：HEAD `1d4efba` + 144 项未提交改动（按当前磁盘）

## 0. 覆盖范围

**读了（PiWeb 自身代码）**：`src/lib/plugins-service.ts`（443，简报写 432，因未提交改动）、`plugins-marketplace.ts`（597）、`skills-service.ts`（237）、`skill-frontmatter.ts`（35）、`resource-fingerprint.ts`（188）、`src/app/api/plugins/route.ts`（81）、`src/app/api/plugins/marketplace/route.ts`（53）、`src/app/api/skills/route.ts`（45）、`src/components/settings/PluginsSection.tsx`（1042）、`PluginMarketplace.tsx`（739）、`SkillsSection.tsx`（408）、`src/components/workspace/SkillsPluginsViews.tsx`（671）、`examples/piweb-extensions/{README.md,todo-panel.ts,review-gate.ts,status-board.ts,lib/piweb-ui.ts}`。
**为判断"防护是否真生效"顺读的依赖（不属于我裁剪范围，只用于判读）**：`src/lib/path-security.ts`（93）、`settings-write-lock.ts`（45）、`pi.ts`（300–479）、`tool-preset.ts`（39）、`permission-gate.ts`（215）、`agent-manager.ts` 片段（1430–1460、1736–1861、2930–2975）、`workspace-index.ts`（268）、`hooks/useWorkspaceFiles.ts`（93）、`src/proxy.ts`（87）、`auth.ts`（59）、`web-auth.ts` 片段（30–99）、`src/app/api/files/route.ts`（77）。
**测试**：`tests/plugins-service.test.ts`（228）、`plugins-marketplace.test.ts`（157）、`plugins-source-regression.test.ts`（153）、`skills-service-safety.test.ts`（175）、`skills-delete.test.ts`（215）、`skill-frontmatter.test.ts`（41）、`tests/lib/skill-expansion.test.ts`（60）、`tests/components/{plugins-section-state.test.tsx(265), skills-section.test.tsx(138), plugin-marketplace-lifecycle.test.tsx(30), workspace-resource-lifecycle.test.tsx(220), workspace-views-prompts-market.test.tsx(252)}`、`resource-refresh.test.ts`（154）、`tests/examples/piweb-extensions.test.ts`（54）。
**只读 SDK 用来核对调用语义**（不评论其内部实现）：`node_modules/@earendil-works/pi-coding-agent/dist/core/{skills.js,resource-loader.js,package-manager.js}` 的相关片段。
**实跑**：`npx vitest run tests/skills-delete.test.ts tests/skills-service-safety.test.ts tests/skill-frontmatter.test.ts` → **3 文件 33 测试全过**（用来确认下面 P0-1 依赖的行为是"当前实现如此"，不是偶发）。
**跳过**：`src/components/*` 公共组件（归 crosscut）；`src/lib/sandbox/*`、`permission-*.ts` 只读到能回答"插件工具是否受档位约束"为止（归 sandbox 区域裁定）；`/login`、`/api/files` 全量（归 API/鉴权与 files 区域）。

| 子功能 | 结论 | 依据 |
|---|---|---|
| 插件包安装（npm / git / local 路径） | **有问题** P1-1、P2-3、P2-4 | `api/plugins/route.ts:59-63` → `plugins-service.ts:395-405` → pi `installNpm` |
| 插件包卸载 | `OK-但脆弱`（local 包只删配置不删盘，方向安全；P3-1 语义、P2-5 无回滚） | `plugins-service.ts:407-430`、pi `remove()` |
| 整包启用/停用（`packages` ↔ `disabledPackages`） | `OK-但脆弱` P2-7（scope 由客户端给） | `plugins-service.ts:301-333`、`route.ts:48-58` |
| 单个扩展开关（`+/-/!` 与 `-builtin:`） | **OK**（写后回读校验，测试真断言） | `plugins-service.ts:339-393`、`plugins-source-regression.test.ts:114-152` |
| 市场搜索 + 兼容性判定 | **有问题** P2-1、P2-2 | `plugins-marketplace.ts:431-536`、`PluginMarketplace.tsx:114-203` |
| 技能发现 / 作用域判定 / frontmatter 开关 | `OK-但脆弱`（开关的 YAML 外科改写有 6 条真断言测试；发现缺元数据时按路径猜，P3-2、P2-6） | `skills-service.ts:86-180`、`skill-frontmatter.ts`、`skill-frontmatter.test.ts` |
| **技能删除** | **有问题 P0-1** | `skills-service.ts:210-237`、`path-security.ts:79-93` |
| 技能正文进入提示词的边界 | `OK`（PiWeb 不拼提示词，只解析展示） | `lib/chat/skill-expansion.ts`、`lib/chat/skill-expansion.test.ts` |
| `@` 提及 | `OK`（只出候选、限工作区；展开由 pi 做） | `workspace-index.ts:11-16,116-133`、`useWorkspaceFiles.ts` |
| 插件提供的工具/命令与权限档 | **有问题 P1-2** | `pi.ts:495-518`、`agent-manager.ts:1804,2957-2965`、`permission-gate.ts:32-38` |
| `examples/` 示例扩展 | `OK`（不被任何代码自动加载；P3-3 文档覆盖风险） | 全仓 grep 只命中测试与 README |
| 状态刷新一致性 | `OK-但脆弱` P2-6、P3-4 | `pi.ts:339-361,430-451`、`resource-fingerprint.ts` |

---

## 1. 发现（按严重度降序，同级按影响降序）

### P0-1 技能删除的"递归范围"是黑名单而非"在技能根内"——技能目录是 junction/符号链接时，删掉的是链接指向的工作区外真实目录

> 这是对"另一位 agent 报告的那条"的独立核实结论：**方向正确，但机制描述需要修正**（见下方"准确描述"）。
> 严重度说明：按 BRIEF 的字面定义（数据丢失 = P0）定为 P0。若团队认为"用户自己建了链接 = 授权删目标"这一前提成立，可降为 P1；但代码与 UI 都没有把这个后果告诉用户（见 `SkillsSection.tsx:101`）。

- **位置**：`src/lib/skills-service.ts:212`（鉴权）、`:224-233`（决策 + 删除）；`src/lib/path-security.ts:83-89`（realpath）；受保护目录表 `src/lib/skills-service.ts:189-201`

- **证据**：

  `src/lib/path-security.ts:83-89`——授权检查返回的是 **realpath 之后**的路径：
  ```ts
  const realRequested = await fs.realpath(requested).catch(() => {
  	throw new BoundaryError("resource not found");
  });
  for (const candidate of allowed) {
  	if (!candidate) continue;
  	const realCandidate = await fs.realpath(candidate).catch(() => null);
  	if (realCandidate && samePath(realRequested, realCandidate)) return realRequested;
  ```

  `src/lib/skills-service.ts:224-233`——递归删除的四个条件里没有任何"必须在技能根内"：
  ```ts
  const skillDir = path.dirname(authorized);            // authorized 已经是 realpath
  const comparableDir = await toComparablePath(skillDir);
  const protectedRoots = await protectedDirs(context);
  const others = discovered.map(({ canonical }) => canonical);
  const ownsDir = path.basename(authorized) === "SKILL.md"
  	&& path.dirname(skillDir) !== skillDir
  	&& !protectedRoots.has(comparableDir)                 // ← 只有黑名单
  	&& !others.some((other) => other !== comparableFile && within(other, comparableDir));
  const removed = ownsDir ? skillDir : authorized;
  await fs.rm(removed, { recursive: ownsDir, force: true });
  ```

  `src/lib/skills-service.ts:189-201`——黑名单本身是"若干具体路径"，不含任何子目录：
  ```ts
  const dirs = [
  	context.agentDir,
  	`${context.agentDir}/skills`,
  	`${context.agentDir}/web-skills`,
  	context.home,
  	`${context.home}/.pi`,
  	`${context.home}/.agents`,
  	`${context.home}/.agents/skills`,
  ];
  ```

  SDK 侧确实会跟随目录链接（`node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:173-193`：`if (entry.isSymbolicLink()) { const stats = statSync(fullPath); isDirectory = stats.isDirectory(); ... if (isDirectory) loadSkillsFromDirInternal(fullPath, ...)`）。

  现有测试把"先 canonicalize 再删"当成**期望行为**并锁死了：`tests/skills-delete.test.ts:193-214`（junction 回归用例断言 `{ removed: <realpath 目标> }`）。也就是说这条代码路径是当前实现有意为之，缺的是"目标是否还在技能根内"这一条约束与对应的测试。

- **准确描述（修正另一位 agent 的说法）**：
  1. ✅ "边界是黑名单而不是『在技能根内』"——**成立**。`ownsDir` 只排除 agentDir / skills / home / ~/.pi / ~/.agents 这几个**精确路径**，从没检查 `skillDir` 是否位于某个技能根之下。
  2. ⚠️ "junction 时可能删到工作区外"——**结论成立，机制不是"fs.rm 跟随链接"**。真正跟随链接的是 `resolveDiscoveredPath` 的 `fs.realpath`：删除目标在进入 `fs.rm` 之前**就已经是链接指向的真实目录**，所以 `fs.rm(..., {recursive:true})` 删的是链接目标的真实内容，跟 rm 是否跟随链接无关。
  3. ➕ 触发条件比"目录是 junction"更具体，需要同时满足：`basename(realpath) === "SKILL.md"`（目标根目录直接放着 SKILL.md）、realpath 后不在上面那张黑名单里、realpath 后该目录里**没有其它已发现技能**。满足时整个目标目录（含 `.git`、脚本、与技能无关的文件）被递归删除，且 `force: true` + `fs.rm` **不进回收站**。
  4. ➕ 不需要 junction 也能中：当 `SKILL.md` 本身是指向别处的**文件符号链接**时，`basename` 仍是 `SKILL.md`，`skillDir` 变成目标文件所在目录 → 同样是"删整个外部目录"。

- **触发路径**（真实且常见的用户习惯：把技能仓库链接进技能根）：
  1. `mklink /J %USERPROFILE%\.pi\agent\skills\pack D:\repos\skill-pack`（junction 不需要管理员权限；POSIX 上是 `ln -s`）。`D:\repos\skill-pack\SKILL.md` 存在，且里面有 `.git/`、`scripts/`、`README.md`。
  2. pi 的技能加载器跟随该链接发现 `<agentDir>/skills/pack/SKILL.md`；`listSkills` 里它 `scope=user, origin=top-level`（不是 package，所以不受"包技能不许删"保护）。
  3. 用户在 PiWeb 技能页点「删除」，确认框只显示技能名（`SkillsSection.tsx:101`：`t.confirmDeleteSkill.replace("{name}", s.name)`，没有路径），点确认 → `POST /api/skills {action:"delete", filePath:<agentDir>/skills/pack/SKILL.md, cwd}`。
  4. `resolveDiscoveredPath` → `D:\repos\skill-pack\SKILL.md`；`skillDir = D:\repos\skill-pack`；黑名单不含它；无兄弟技能 → `ownsDir = true`。
  5. `fs.rm("D:\\repos\\skill-pack", { recursive: true, force: true })` —— **整个仓库连同 `.git` 历史一起消失**，不进回收站，没有任何撤销入口。

- **后果**：删一个技能 = 删掉技能根之外的一整个目录；对"多工具共享技能仓库"（`~/.agents/skills`、`~/.claude/skills`、`~/.pi/agent/skills` 互相链接）这种做法，等于跨工具、跨仓库的不可逆数据丢失。UI 侧也无法提前预警（确认框不含路径）。

- **置信度**：**已确认**（完整链路读通：route → service → path-security → fs.rm；SDK 跟随链接已读源码；33 条相关测试实跑全绿，证明当前行为就是这样）。真实世界触发频率：未确认（需要确实存在这种链接；我不允许在仓库里造 junction 做实测）。

- **建议修法**（最小改动，保留现有"同目录别名仍可删"的回归语义）：
  1. 增加一条**包含**判定代替/补充黑名单：递归删之前要求 `comparableDir` 位于某个**技能根**之内（根可以从本 cwd 的 `listSkills(cwd)` 结果的 `sourceInfo.baseDir` / `baseDir` 收集，或直接用 `<agentDir>/skills`、`<agentDir>/web-skills`、`<cwd>/.pi/skills`、`~/.agents/skills` 等 realpath 集合），否则退化成"只删 `authorized` 这一个文件"。
  2. 更直接的兜底：对**发现时拼写**的 `path.dirname(filePath)`（未 realpath 的那一份）做 `fs.lstat`，若是 `isSymbolicLink()`，只 `fs.rm(link, {recursive:false})`（删链接本身），永不递归进目标。
  3. 确认框里带上将被删除的**真实路径**（`removed`），并对"将删除目录"的用例加 `danger` 样式。
  4. 补测试：`tests/skills-delete.test.ts` 加一条"技能目录 junction 指向技能根外 → 只删链接/拒绝递归"，与本文件 P0-1 对应。

---

### P1-1 安装插件包 = 一键执行任意第三方代码：无来源白名单、无二次确认，失败的副作用不回滚

- **位置**：`src/app/api/plugins/route.ts:41-43,59-63`；`src/lib/plugins-service.ts:395-405`；前端 `src/components/settings/PluginMarketplace.tsx:536-550,627-643`、`PluginsSection.tsx:1020-1037`

- **证据**：

  服务端只校验"长度 ≤ 4096"，source 内容原样进 SDK：
  ```ts
  // src/app/api/plugins/route.ts:41-43
  if (body.source && body.source.length > 4096) {
  	return NextResponse.json({ success: false, error: "package source is too long" }, { status: 400 });
  }
  ...
  if (body.action === "install") {
  	if (!body.source) return NextResponse.json({ success: false, error: "missing source" }, { status: 400 });
  	await installPackage(body.source, body.local === true, cwd);   // 直接给 SDK
  ```
  ```ts
  // src/lib/plugins-service.ts:398-403
  await withSettingsWriteLock(settingsPath, async () => {
  	const sm = await prepareSettingsWrite(cwd, settingsPath);
  	await pm.installAndPersist(source, { local });                  // npm install / git clone
  ```
  SDK 执行的是**带生命周期脚本**的 npm 安装（`package-manager.js:1630-1654` 的 `getNpmInstallArgs` 只有 `--legacy-peer-deps --no-audit --no-fund`，没有 `--ignore-scripts`；git 源在克隆后还会 `npm install`，`package-manager.js:1696-1703`）。扩展 JS 随后被加载进 pi 进程（同进程、同用户权限）。

  市场卡片"兼容"时**单击即装**，没有任何确认：
  ```tsx
  // PluginMarketplace.tsx:536-550
  const handleInstallClick = async () => {
  	if (compat?.status === "incompatible" && compat.blockers.length > 0) { ... confirm({danger:true}) ... }
  	onInstall(item.source, marketKey);     // 兼容/未知 一律直接装
  ```

  对比：卸载（`PluginsSection.tsx:913-925`）与技能删除都有确认框，唯独"执行代码"的安装没有。

- **触发路径**：市场页点「安装」（或插件页手填 `npm:任意包` / `git:任意仓` / 任意本地路径）→ POST `/api/plugins` → `installAndPersist` → `npm install`（含 postinstall）→ 加载器 reload 把扩展 import 进进程。

- **后果**：装什么就跑什么，跑的是当前用户权限。结合 `src/proxy.ts:28`（`if (!authEnabled()) return NextResponse.next()`；`web-auth.ts:44-47` 认证需显式 `PI_WEB_AUTH`）——**没开认证时，任何能访问该端口的东西（本机任意进程、同网段设备）都能直接 POST 触发这条链**，无需浏览器、无需 Origin（`auth.ts:7-11` 对无 Origin 请求放行）。这条端点的"鉴权"完全依赖部署时是否设 `PI_WEB_AUTH`，那属于 API/鉴权区域，我在这里只标注"install 通道 = RCE 通道"这一事实。

- **置信度**：已确认（安装链读到底；`--ignore-scripts` 的缺失读的是 SDK 源码；认证默认值读的是 `web-auth.ts`）。"任意人可达"取决于部署与绑定，未确认。

- **建议修法**：① 安装前弹一次说明性确认（"安装将下载并执行该包的安装脚本与扩展代码，等同以你的身份运行第三方程序"），与卸载确认对称；② 服务端对该端点加来源校验（`npm:` / `git:` / 已存在的本地目录白名单），并把 `local` 与项目信任、`PI_WEB_AUTH` 状态关联（未开认证时拒绝对 user 作用域安装）；③ 安装日志里记录 source 与 npm `--ignore-scripts` 的取舍（若产品接受运行脚本，就把它写进确认文案）。

---

### P1-2 插件注册的工具在「自定义工具集」下绕过权限档白名单，执行期闸门只认硬编码工具名 → 插件工具可在"仅可查看"档写盘/起进程

- **位置**：`src/lib/agent-manager.ts:1804`（白名单被 customActiveTools 整体替换）、`src/lib/agent-manager.ts:2957-2965`（`setActiveTools` 接受任意已知工具名）、`src/lib/permission-gate.ts:29-38,160-176`（执行期只按硬编码名字判定）

- **证据**：
  ```ts
  // agent-manager.ts:1804  —— customActiveTools 一旦存在，档位白名单完全不参与判断
  const allowed = m.customActiveTools ? m.customActiveTools.includes(name) : presetAllowsTool(effectivePreset, name);
  ```
  ```ts
  // agent-manager.ts:2960-2965  —— 只与"已知工具全集"求交集，不与档位求交集
  const all = session ? listAllToolNames(session) : toolCatalog(m).map((tool) => tool.name);
  const next = [...new Set(wanted)].filter((name) => all.includes(name));
  if (next.length === 0) return { ok: false, error: "cannot disable all tools" };
  m.customActiveTools = next;
  ```
  ```ts
  // permission-gate.ts:31-38  —— 第二道锁认的是固定名字
  const MUTATING_TOOL_NAMES = new Set([...SHELL_TOOL_NAMES, "write", "edit", "codemode", "manage_automation"]);
  export const WRITE_PATH_FIELDS = new Map([["write", "path"], ["edit", "path"]]);
  ```
  ```ts
  // permission-gate.ts:160-176  —— readonly 分支：不在上面两张表里的工具直接放行
  if (preset === "readonly") {
  	if (toolName === "bash" && shellAvailable) return undefined;
  	if (MUTATING_TOOL_NAMES.has(toolName)) { return { block: true, ... }; }
  	if (isMcp && readOnlyHint !== true) { return { block: true, ... }; }
  	return undefined;
  }
  ```
  模块头注释自己也把这个边界写明了（`permission-gate.ts:6-8,19-20`）："扩展后来注册的工具、MCP 工具……都会经过 SDK 的 tool_call，但白名单只按名字判断"、"扩展与 pi 同进程、同 OS 权限"。

- **触发路径**：会话档位 = `readonly`（或 `workspace`）→ 用户在工具面板勾选某个**包/本地扩展注册的工具**（如 `my_ext_apply_patch`、`acme_db_write`）→ 前端发 `setActiveTools` → `customActiveTools` 落地 → 此后 `toolPolicyDenial` 只看这份清单放行；该工具执行时，`permissionDenial` 不认识这个名字 → readonly 档 `return undefined`（放行），workspace 档 `WRITE_PATH_FIELDS.get(name)` 为 `undefined` → `return undefined`（放行）。该工具内部写盘/`child_process` 不受任何路径闸门约束。

- **后果**：用户以为"仅可查看"档能挡住所有改盘动作，但只要装过插件并在工具面板勾了它，档位对这类工具**完全失效**。这是"档位是安全边界"这一产品承诺上的缺口；插件是用户主动安装的，但"用户勾了工具"和"用户授权它在只读档下任意写盘"不是一回事。

- **置信度**：已确认（代码链路完整）。触发需要用户手动勾选该工具（扩展自己只能 `requestedTools`，仍要过 `allowed`，不能单方面绕过）——这一点已读 `policyToolNames`（`agent-manager.ts:1824-1829`）确认。

- **建议修法**：`setActiveTools` 落地时与档位求交集（`next.filter((name) => presetAllowsTool(preset, name) || isMcpToolName(name))`，扩展工具在 readonly/workspace 下仍不放行，除非走 `request_permission` 升权）；或给扩展工具引入"声明式能力"（`mutating: true` → 归入 `MUTATING_TOOL_NAMES` 同等待遇）。**跨桥接/沙箱区域，请 sandbox 区域裁定最终语义。**

---

### P2-1 市场不校验结果确实是 pi 包，且搜索词是客户端可控的整串文本直接拼进 npm 搜索 DSL

- **位置**：`src/lib/plugins-marketplace.ts:431-488,512-526`

- **证据**：`normalizeNpmSearchItem` 只做字段类型收窄，把 `pi-package` 关键词**从展示里删掉**，却从不校验它存在：
  ```ts
  // plugins-marketplace.ts:448-453
  const keywords = Array.isArray(pkg.keywords)
  	? pkg.keywords.filter((k): k is string => typeof k === "string").map((k) => k.trim())
  		.filter((k) => k.length > 0 && k.toLowerCase() !== "pi-package")
  	: [];
  ```
  ```ts
  // plugins-marketplace.ts:484-488（测试 plugins-marketplace.test.ts:19 也锁了这个拼接）
  export function buildMarketplaceSearchText(query: string, category: MarketplaceCategory): string {
  	const cleanedQuery = query.trim().slice(0, 120);
  	const catTerm = CATEGORY_TERMS[category] ?? "";
  	return ["keywords:pi-package", catTerm, cleanedQuery].filter(Boolean).join(" ");
  }
  ```
  结果是 `keywords:pi-package <用户原样输入>`，用户输入里的 `scope:`/`not:`/`is:` 之类限定符会被 npm 的查询解析器当成语法；返回结果也不做二次校验（`items = rawObjects.map(normalizeNpmSearchItem)`，`plugins-marketplace.ts:524-526`）。

- **触发路径**：市场搜索框输入（不限于"名字"，可以是任意 npm 搜索语法）→ GET `/api/plugins/marketplace?q=…` → 原样拼进 registry 查询 → 卡片直接渲染 → 安装按钮直接给 `npm:<name>`。

- **后果**：「市场里都是适配 pi 的包」这个不变量**不由代码保证**；一般 npm 包（`compat.status = "unknown"`、只有 `no_pi_manifest` 提示）不触发任何确认框就能一键安装（见 P1-1），其 postinstall 会在安装时执行。属于供应链投毒的可利用面。

- **置信度**：已确认（代码不校验）；"非 pi 包能否真的混进结果"取决于 npm 查询解析语义，**未实证**（不允许发外网请求）。

- **建议修法**：对每条结果做硬校验（返回的 `keywords` 含 `pi-package`，且 `name` 符合 npm 命名规则）→ 不合规的整条丢弃并计数；搜索词只允许 `[\w.\-@/\s]` 之类的白名单字符，或把 npm 限定符语法字符（`:`）过滤掉。

---

### P2-2 市场展示/兼容性判定用的版本与实际安装的版本不是同一个（无版本锁定、无完整性校验）

- **位置**：`src/lib/plugins-marketplace.ts:440,471`；`src/components/settings/PluginMarketplace.tsx:127-134,549`

- **证据**：卡片上显示的 `version` 和送去做兼容性判定的版本来自搜索结果，但安装用的 source **去掉了版本**：
  ```ts
  // plugins-marketplace.ts:440,471
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  ...
  source: `npm:${name}`,
  ```
  ```tsx
  // PluginMarketplace.tsx:130-134 —— 用搜索到的版本探测兼容性
  body: JSON.stringify({ packages: list.map((item) => ({ name: item.name, version: item.version })) }),
  // PluginMarketplace.tsx:549 —— 安装却用不带版本号的 source
  onInstall(item.source, marketKey);
  ```
- **触发路径**：搜索结果（可能有缓存/延迟）→ 用户看到 "v1.2.0 · 兼容" → 点安装 → `npm install <name>`（无版本）→ 实际装上当时的 `latest`（可能是 1.3.0、可能已换维护者/新增 postinstall）。
- **后果**：用户看到的兼容性结论与真正执行的代码可能不是同一版本；也没有 dist-tag/integrity（`npm install` 会用 registry 的 integrity，但**不是** UI 展示的那份元数据的 integrity）。这是典型的"审的是 A、装的是 B"。
- **置信度**：已确认（代码即可证明）。
- **建议修法**：`source` 带上被审的精确版本（`npm:${name}@${version}`），或安装前用 `npm view <name>@latest version` 复核并在版本变化时提示"该包已更新到 x.y.z，重新检查兼容性"。

---

### P2-3 只读 GET 会触发网络安装：打开"插件/技能"页可能悄悄 `npm install` 缺失的包（含生命周期脚本）

- **位置**：`src/lib/plugins-service.ts:136-145,225-234`（`countResources` / `listLoadedExtensions`）→ `src/lib/pi.ts:339-361,368-371`（`queueLoaderReload` → `entry.loader.reload()`）→ SDK `resource-loader.js:383` `await this.packageManager.resolve()` → SDK `package-manager.js:1098-1155`（`installMissing` → `installParsedSource`）

- **证据**：
  ```ts
  // plugins-service.ts:66-70 —— 这一处很谨慎地传了 "skip"
  async function resolveExtensions(cwd: string): Promise<ResolvedResource[]> {
  	return (await getPackageManager(cwd).resolve(async () => "skip")).extensions;
  ```
  但目录接口和技能接口走的是加载器重载，加载器内部 `resolve()` **没有** onMissing 回调，缺包时直接安装：
  ```js
  // dist/core/package-manager.js:1098-1126
  async resolvePackageSources(sources, accumulator, onMissing) { ...
      const installMissing = async () => {
          if (isOfflineModeEnabled()) return false;
          if (onMissing) { const action = await onMissing(resolvedSource); if (action === "skip") return false; ... }
          ...
          await this.installParsedSource(parsed, resolvedScope);
  ```
  `GET /api/plugins`（`route.ts:20-22`）和 `GET /api/skills`（`skills-service.ts:141`）都 `await resourceLoaderReady(cwd)`。
- **触发路径**：settings.json 里配了 `packages: ["npm:x"]` 但缓存目录被清理/迁移（或换了新机器后同步了 settings）→ 用户只是打开「插件」或「技能」页 → 服务端 `npm install`（网络 + postinstall）。失败也被加载器吞成 `installFailures` 列表，UI 只看 `getExtensions()`。
- **后果**：读操作有网络写、有代码执行副作用；离线/内网环境下页面变慢甚至卡住（`NETWORK_TIMEOUT_MS` 级等待），而用户没有任何"正在安装"的提示（只有安装按钮才显示进度）。
- **置信度**：已确认代码路径；"实际是否触发"未实测（不允许改状态）。
- **建议修法**：在这类只读入口显式传 `onMissing = async () => "skip"`（SDK 支持），或至少在服务端设置 `PI_OFFLINE` 语义的开关给"只读浏览"用；UI 上把 `installFailures` 显示出来。

---

### P2-4 并发安装/更新没有服务端互斥，只有"配置文件写锁"

- **位置**：`src/lib/settings-write-lock.ts:9-20`；`src/lib/plugins-service.ts:395-436`；`PluginsSection.tsx:329,438`（前端只有本组件内的 `busyRef` 单飞）

- **证据**：`withSettingsWriteLock` 只是把"同一个 settings 文件"的读改写排队：
  ```ts
  const previous = pending.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  ```
  `installPackage` 在整个 `npm install` 期间持有这个内存锁，但：① 两个不同 cwd 的 user 作用域安装最终操作**同一个** `agentDir/npm` 前缀，仅因为 key 都是全局 settings 才碰巧串行；② `local:true`（项目作用域）时锁的是 `<cwd>/.pi/settings.json`，两个不同 cwd 的项目安装互不排队；③ 与 pi CLI（另一个进程）之间没有任何文件锁参与（`withExternalSettingsLock` 只在 `movePackage`/`removePackage` 的 disabledPackages 段用到）。
- **后果**：两个客户端（桌面 + 手机）同时点安装 / 一个装一个更新 → 同一 npm 前缀上并发 `npm install`，最坏情况 `node_modules` 半成品（npm 没有对 prefix 的互斥锁），或一边的 `verifySettingsField` 读到另一边刚写的中间态而报 "was not persisted"。失败后磁盘上留下装了但没进 settings 的孤儿包（见 P2-5）。
- **置信度**：疑似（需要并发实测才能确认危害程度；互斥缺失本身已确认）。
- **建议修法**：在 `plugins-service` 里加一个进程级的 package-manager 互斥（按安装前缀 key 排队），并让 install/update/remove 都取 `withExternalSettingsLock`（与 pi CLI 对齐）。

---

### P2-5 安装失败没有回滚；"已装上但刷新失败"会以 500 报给用户

- **位置**：`src/lib/plugins-service.ts:395-405,92-95`

- **证据**：`installAndPersist` 成功后紧跟 `flushSettingsOrThrow` + `verifySettingsField`，任一失败直接抛出——但**已下载解包的内容留在磁盘**：
  ```ts
  await pm.installAndPersist(source, { local });
  await flushSettingsOrThrow(sm);
  await verifySettingsField(settingsPath, "packages", (local ? sm.getProjectSettings() : sm.getGlobalSettings()).packages);
  ```
  收尾 `applyResourceChange` 也是抛错源（`reloadAllLoaders` 内部虽吞掉单点失败，但 `reloadSessionsForCwd` 可能抛），此时包其实已经可用，API 返回 500，UI 提示"安装失败"，而下次刷新它又出现在列表里。
- **后果**：用户看到"失败"但实际装上了（信任受损/重复点击）；真正的失败（settings 写不进）留下孤儿缓存且无清理入口。
- **置信度**：已确认（代码即可证明失败顺序）。
- **建议修法**：把 settings 落盘与 reload 隔离开——`installAndPersist` 成功后 settings 失败 → 尝试 `pm.remove(...)` 回滚再抛；`applyResourceChange` 失败只记日志并返回 `{ installed: true, reloaded: false }`，UI 提示"已安装，刷新未生效，点刷新重试"。

---

### P2-6 技能操作的两处"看起来成功其实没生效"：`SKILL.md` 非原子写 + 全量 reload 吞错误

- **位置**：`src/lib/skills-service.ts:169-180,233-236`；`src/lib/pi.ts:430-451`

- **证据**：
  ```ts
  // skills-service.ts:169-174 —— 直接覆盖写，无临时文件/rename，无备份
  const content = await fs.readFile(authorized, "utf8");
  const next = toggleSkillFrontmatterDisabled(content, disabled);
  if (next === content) return { changed: false };
  await fs.writeFile(authorized, next, "utf8");
  await reloadAllLoaders();
  ```
  ```ts
  // pi.ts:441-449 —— 单个 loader 重载失败被静默吞掉
  for (const [key, entry] of loaderCache) {
  	try { await queueLoaderReload(entry.cwd, entry); reloaded.push(key); }
  	catch { /* 单个失败不影响其他 */ }
  }
  ```
- **触发路径**：进程在 `fs.writeFile` 中途被杀/断电 → 用户 `SKILL.md` 变成半截（技能直接损坏，且它通常是用户的唯一副本）；或 `reloadAllLoaders` 里该 cwd 的 loader 重载失败 → API 返回 `{changed:true}`、UI 显示开关已切换，但系统提示里的技能列表没变（下次刷新又弹回去）。
- **后果**：① 前台文件写坏（相对 `writeSettingsFile` 的 tmp+rename 入盘方式，这里是不一致的）；② 状态刷新"假成功"。
- **置信度**：已确认（代码即可证明）；写坏需要崩溃窗口，属低概率。
- **建议修法**：复用 `plugins-service.ts:123-133` 的 tmp + `fs.rename` 写法；`reloadAllLoaders` 把失败列表返回给调用方，API 里至少带上 `reloaded:false` 让 UI 提示。

---

### P2-7 包的作用域/作用域文件由客户端决定，服务端不核对包实际在哪

- **位置**：`src/app/api/plugins/route.ts:49-51,64-68`；`src/lib/plugins-service.ts:301-315,407-430`

- **证据**：
  ```ts
  // route.ts:49-51 —— scope 来自请求体
  await togglePackage(body.source, body.disabled === true, body.scope === "project" ? "project" : "user", cwd);
  // route.ts:66 —— local 来自请求体
  const removed = await removePackage(body.source, body.local === true, cwd);
  ```
  `togglePackage` 直接用这个 scope 拼 settings 路径（`plugins-service.ts:307`），`removePackage` 也一样（`:409`），都不检查 `pm.listConfiguredPackages()` 里该 source 的真实 scope。
- **触发路径**：两个标签页/两个设备上列表不同步时（A 页把全局包停用、B 页仍按 `scope:user` 发请求但包此时已在 disabledPackages；或项目包在 B 页按 user 发）→ 写到错误的 settings 文件 → 出现重复条目/`packages` 与 `disabledPackages` 同时含同一 source，卸载还会返回 404（`route.ts:67`）而包其实还在。
- **后果**：状态错乱（同一包在两个作用域各有一份），"停用"在另一个作用域不生效；卸载误报 404。
- **置信度**：疑似（需要构造不一致状态；代码确实无核对）。
- **建议修法**：服务端用 `pm.listConfiguredPackages()` + 两份 settings 反查真实 scope/local，找不到目标则 409 "refresh first"，忽略请求体里的 scope。

---

### P3-1 破坏性确认的语义不统一：技能删除 / 卸载按钮没有 `danger`，且不显示将被删除的真实路径

- **位置**：`SkillsSection.tsx:100-103,380-391`、`PluginsSection.tsx:311-315,902-925`（对比 `PluginMarketplace.tsx:539-546` 的 `danger: true`）
- **证据**：`confirm({ title: t.delete, message: t.confirmDeleteSkill.replace("{name}", s.name), confirmLabel: t.delete })` —— 没有 `danger`，也没有 `filePath`。
- **后果**：与 P0-1 叠加时用户完全没有机会看到"要删的是哪个目录"。属 UI 一致性 + 安全提示问题。
- **修法**：统一加 `danger: true`，确认文案里带真实删除目标（`removed` 而不是技能名）。

### P3-2 `setSkillDisabled` 用原样字符串匹配发现结果，`deleteSkill` 用 canonical —— 两处口径不一致

- **位置**：`skills-service.ts:176`（`skills.find(skill => skill.filePath === filePath)`）对比 `:216`（canonical 比较）
- **后果**：客户端传 realpath 形式而发现结果里是链接拼写（或反之）时，`setSkillDisabled` 取不到 `sourceInfo`，回退到按路径猜作用域——只影响"重载哪些会话"（可能多刷或漏刷），不影响写盘正确性。属脆弱耦合。
- **修法**：与 `deleteSkill` 一样按 canonical 匹配。

### P3-3 `examples/` 示例是安全的（不会被自动加载），但 README 的安装命令是"覆盖式复制"

- **位置**：`examples/piweb-extensions/README.md:17-25`
- **证据**：全仓 grep 只有 `tests/examples/piweb-extensions.test.ts` 引用它们；`examples/` 不是任何发现根（`plugins-service.ts:66-70`、`pi.ts:329`、`resource-fingerprint.ts:111-118` 都只扫 agentDir/`.pi`/settings 里的路径）。README 用 `cp ... "$EXT/"`，同名文件会被静默覆盖用户已有扩展。
- **后果**：示例本身没有安全风险（不自动执行）；覆盖风险是文档级的。
- **修法**：README 改成 `cp -n`（不覆盖）或先提示；示例里可加一行注释说明"这些是示例代码，不是官方包"。

### P3-4 市场路由无缓存头、`size>36` 的卡片永远拿不到兼容性判定

- **位置**：`src/app/api/plugins/marketplace/route.ts:24-25`（无 `Cache-Control`）、`plugins-marketplace.ts:549`（`specs.slice(0, 36)`）对比 `PluginMarketplace.tsx:131`（最多 50 条全量送检）
- **后果**：第 37 张之后的卡片永远显示"检查中→无徽章"，用户看不到不兼容提示却仍能一键安装（与 P1-1 叠加）。纯展示缺陷，但会削弱 P1-1 的唯一缓冲。
- **修法**：`size` 上限压到 36 或分批送检；响应加 `Cache-Control: private, max-age=60`。

### P3-5 打开插件/技能页会在请求线程里做全量资源指纹（同步 fs）

- **位置**：`resource-fingerprint.ts:23-44,64-106`（`lstatSync/readdirSync/readFileSync`）被 `pi.ts:344-352` 每次 `queueLoaderReload` 调用 **两遍**
- **后果**：包/技能/prompt 目录很大时，一次页面加载可能让 Node 事件循环卡住若干百毫秒到秒级（所有会话的 SSE 流一起卡）。属性能/健壮性，未实测。
- **修法**：把指纹改成异步 fs，或缓存到一定程度（按目录 mtime 短路）。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 技能目录 junction/符号链接指向技能根外 | P0-1 的核心；现有 `skills-delete.test.ts:193-214` 只锁了"agentDir 别名仍可删"，恰好把危险路径当成期望行为 | 造 `<agentDir>/skills/pack` → junction 到临时目录外；断言**要么拒绝、要么只删链接**，且目标目录内容仍在 |
| 真实安装链路（npm/git） | `plugins-service.test.ts:84` 明确 mock 掉 `installAndPersist`，`plugins-source-regression.test.ts:36` 让 `fetch` 抛错——**安装从未端到端跑过** | 用一个 `file:` 本地包走真实 `installAndPersist`：确认装到哪个目录、settings 是否落地、`postinstall` 是否会跑（用无害脚本断言）、失败时是否回滚 |
| 安装后 reload 失败的用户可见状态 | P2-5 | mock `reloadAllLoaders` 抛错，断言 API 语义（不该报"安装失败"）与 UI 文案 |
| 市场结果的 pi-package 校验 | P2-1 | 注入不含 `pi-package` 关键词的搜索结果，断言被丢弃/被标"未知"且安装前有确认 |
| 搜索词里的 npm 限定符 | P2-1 | `q="scope:foo"` 等，断言拼装/转义策略 |
| 兼容性判定版本 = 安装版本 | P2-2 | 断言 `onInstall` 收到的 source 带版本，或安装前复核 latest |
| 只读 GET 不触发安装 | P2-3 | 配 `packages:["npm:x"]` 且缓存缺失 + `fetch` 断言"不应被调用"，打 `GET /api/plugins` |
| 并发 install/update | P2-4 | 同进程两路并发调用 `installPackage`，断言串行化（或至少 `node_modules` 不半成品） |
| 扩展注册的工具 + 自定义工具集 + 只读档 | P1-2 | 注册一个不在白名单里的工具，`setActiveTools` 打开它，断言 readonly 下执行被拒 |
| `setActiveTools` 与档位求交集 | P1-2 | 直接单测 `toolPolicyDenial` 的 custom 分支 |
| 技能 frontmatter 写盘原子性 | P2-6 | 断言写临时文件 + rename（或用故障注入模拟写一半） |
| 技能删除确认框包含真实路径 | P0-1 的可用性防线 | 断言 dialog 文案含 `filePath`/目标目录 |

## 3. 与其他区域的可能交叉点

1. **API/鉴权（`src/app/api/**`、`web-auth`）**：`/api/plugins` 的 install/remove/toggle 与 `/api/skills` 的 delete 都是"无认证即可直接改盘/执行代码"的端点；认证默认关闭（`web-auth.ts:44-47`），`isSafeOrigin`（`auth.ts:7-11`）对无 `Origin` 的请求放行。**请 API 区域裁定**：这些危险端点是否需要在这种情况下额外拒绝、是否要与"绑定地址"联动。
2. **bridge（`agent-manager.ts`）**：P1-2 的两处落点（`toolPolicyDenial` 的 `customActiveTools` 分支、`setActiveTools` 不做档位交集）都在 bridge 的文件里；我只按"插件工具"这一视角核对，**最终语义请 bridge 区域定**。另外 `reloadSessionsForCwd(undefined)` 表示"全部会话"这一约定，我按测试推断（`plugins-source-regression.test.ts:132`），未读该函数实现。
3. **sandbox/权限（`permission-gate.ts`、`tool-preset.ts`）**：P1-2 的第二道锁是**硬编码工具名表**（`MUTATING_TOOL_NAMES` / `WRITE_PATH_FIELDS`），扩展工具天然不在表内。是否引入"扩展工具声明能力"需要 sandbox 区域决定；这属于"档位能不能当安全边界"的产品级判断。
4. **remote（手机/远程）**：远程访问时若 `PI_WEB_AUTH` 必开（`remote/supervisor.ts:177` 注释提到这点），P1-1 的实际暴露面取决于 remote 区域对认证的强制程度；请交叉确认"开了 remote 但没开 auth"是否可能。
5. **files / crosscut（`@` 提及）**：PiWeb 只提供候选（`/api/files?index=1` 的工作区清单），`@path` 的**内容内联是 pi 做的**，我没在 PiWeb 里找到任何"把文件内容塞进提示词"的代码。若 files 区域改了 index 的边界（例如允许绝对路径/`../`），会直接影响提及的可达范围——`workspace-index.ts:14` 注释声称"不支持 `~/`、绝对路径和跳出工作区的 `../`"，需要 files 区域确认服务端索引是否也只限工作区。
6. **卸载语义**：`pi` 的 `remove()` 对 **local 路径源**是空操作（`package-manager.js:851-853`），PiWeb 卸载 local 包只删 settings 条目、不动用户目录（我认为这个方向是对的）。如果产品将来要"删本地插件目录"，必须另做确认，不能复用现在的卸载按钮。

## 4. 建议优先修的 3 件事

1. **P0-1 技能删除的递归边界**：递归删除前要求目标在技能根内，且发现路径是链接时只删链接本身；确认框显示真实删除路径。改动小、后果最重（不可逆删用户仓库）。
2. **P1-1 安装通道的确认与来源约束**：把"安装 = 下载并执行第三方代码"在 UI 上说清并二次确认（与卸载对称），服务端加 source 形态校验，并把"未开 `PI_WEB_AUTH` 时拒绝对 user 作用域安装"交给 API 区域一起定。
3. **P1-2 插件工具与权限档的关系**：`setActiveTools` 与档位求交集（或给扩展工具加能力声明），让"仅可查看"不会被一个勾选穿透。P2-1/P2-2（市场结果校验、版本锁定）作为紧随其后的供应链加固一起做。
