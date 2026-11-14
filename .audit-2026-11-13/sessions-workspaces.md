# 工作区 / 会话 / 导航外壳 审计报告

## 0. 覆盖范围

**读了**（行数为当前磁盘实际行数；BRIEF 里记的 AppShell 1609 / SessionSidebar 1332 / workspace-store 518 与磁盘不符，实际 1683 / 1349 / 541，本报告按当前磁盘审计）：

- `src/components/AppShell.tsx` 1683 行（全读）
- `src/components/SessionSidebar.tsx` 1349 行（全读）
- `src/components/SettingsPanel.tsx` 109 行（全读）
- `src/hooks/useDialog.ts` 118 行（全读）
- `src/lib/workspace-store.ts` 541 行（全读）
- `src/lib/session-reader.ts` 320 行（全读）
- `src/lib/session-tree.ts` 149 行（全读）
- `src/lib/session-retention.ts` 115 行（全读）
- `src/lib/workspace-index.ts` 268 行（全读）— **注意：这个文件不是"工作区索引"，而是 `@` 引用补全的纯匹配逻辑**，与工作区注册表无关；任务描述里的归类是错的。
- `src/app/api/workspaces/route.ts` 128、`src/app/api/sessions/route.ts` 28、`src/app/api/sessions/[id]/route.ts` 37、`src/app/api/sessions/[id]/export/route.ts` 37（全读）。`[id]/route.ts` 不是空壳：GET 冷读、DELETE 物理删除。
- `src/app/page.tsx` 10、`src/app/layout.tsx` 26（全读，导航相关只有 metadata/viewport）
- 跨文件跟链路：`src/hooks/usePiWeb.ts` 1331 行（读了 380–1331；1–380 是事件折叠/纯函数，未读）、`src/lib/settings-write-lock.ts` 45（全读）、`src/lib/path-security.ts` 1–93（全读）、`src/lib/pi.ts:455-484`、`src/lib/session-change-events.ts` 6、`src/lib/types.ts:520-527`、`src/lib/agent-manager.ts:2180-2229`、`src/i18n.tsx` 相关 14 条文案、`src/app/globals.css:470-509`、`src/proxy.ts` 关键行（只确认识别口径，鉴权归 API 区域）
- 测试：`tests/workspace-store.test.ts` 305（全读）、`tests/session-retention.test.ts` 145（全读）、`tests/api/session-workspaces.test.ts` 57（全读）、`tests/components/sidebar-menus.test.tsx` 285（全读）、`tests/components/sidebar-current.test.tsx` 53、`tests/components/app-shell-sidebar-actions.test.tsx` 102、`tests/components/app-shell-drawer-shortcut.test.tsx` 105（全读）；`tests/session-reader.test.ts` / `session-tree.test.ts` / `workspace-index.test.ts` / 其余 app-shell-* 读了全部用例名与断言风格（未逐行读完）。

**跳过的**：`DirectoryPicker`、`DrawerPanel`、`CustomSelect`、`icons.tsx`（BRIEF 划给 crosscut）；`agent-manager` 其余部分（bridge）；`proxy.ts`/`web-auth` 鉴权判定（API/鉴权）。没有跑测试（BRIEF 说 lead 已在跑全量）。

**结论一览**（功能 | 结论 | 依据）

| 功能 | 结论 | 依据 |
|---|---|---|
| 工作区增 / 改 / 删（含同名冲突） | OK — 新增走 `resolveWorkspacePath`（存在性 + 必须是目录 + realpath + ≤4096）；改名走 alias 键归一 + 冲突提示；删除**只动注册表加墓碑，磁盘与会话文件都不碰**，弹窗文案与实际一致 | `path-security.ts:63`、`workspace-store.ts:200,412-429`、`SessionSidebar.tsx:186-191`、`i18n.tsx:242` |
| 目录选择（原生框 / 应用内浏览器） | OK-但脆弱 — 原生框靠 Host 头认"本机"，可伪造 | `workspaces/route.ts:28-32`、P3-7 |
| 默认 / 最近工作区 | 有问题 —"最近"语义不存在，回落 `knownCwds[0]`（最早添加的那个） | P3-3 |
| 会话列表加载 / 分页 / 搜索 | OK-但脆弱 — 全量扫描 + mtime/size 摘要缓存 + ETag（加载没问题）；**没有分页**、无虚拟化；搜索是纯客户端，搜不到已归档，服务端 `?q=` 无调用方 | `sessions/route.ts:18-24`、`SessionSidebar.tsx:934-954,1024`、P2-2 |
| 会话改名 / 归档 / 删除 / 导出 / 草稿 | OK-但脆弱 — 改名有 IME 保护、删除有二次确认；**归档一键无确认**且始动 30 天不可逆删除；导出用 `window.open` 无失败反馈；**草稿完全不持久化** | `sidebar-menus.test.tsx`、`SessionSidebar.tsx:562-575`、P3-1、P2-6 |
| 会话↔工作区绑定（切工作区是否漏会话） | OK — 按 `cwd` 归一后分组，切工作区不会把旧会话带过去；不在注册表里的进"未分组"而不是消失 | `SessionSidebar.tsx:311-369` |
| URL 状态与刷新恢复 | 有问题 — 完全没有 URL 参与（不可深链、前进后退无效），恢复用 `===` 比路径 | P2-4 |
| store 写盘原子性与并发 | OK — temp(`wx`)+rename，进程内队列 + `proper-lockfile` 跨进程锁；并发/原子替换失败/跨进程都有单测 | `workspace-store.ts:118-127`、`settings-write-lock.ts`、`workspace-store.test.ts:42-59,220-274` |
| 损坏恢复 | 有问题 — fail-closed：一个坏 JSON 让侧栏整表 500 且所有写操作也 500，无修复入口 | P1-2 |
| 多标签页 / localStorage↔磁盘一致性 | 有问题 —`piweb.currentSession` 被后写的标签页覆盖；localStorage 全裸调用 | P2-3、P2-7 |
| 归档保留策略（会不会误删） | 有问题 — **不会误删未归档会话（有边界校验 + 单测）**，但归档会话到期是 `unlink` 永久删除、无回收站/无开关 | P1-1 |
| 侧栏 / 抽屉 / 移动端 / 键盘 / 快捷键 | OK-但脆弱 — 关闭的移动端侧栏仍可 Tab 聚焦；拖拽手柄/`«»` 无键盘与 aria；行菜单无 Escape；`Ctrl+Shift+E` 无 repeat/模态抑制 | P2-5、P3-5、P3-6 |
| 首屏与轮询 IO | OK-但脆弱 — **不是串行 IO**；但每次 3 秒轮询做 O(会话数)+2×O(工作区数) 次无缓存 `realpath` | P2-8 |

---

## 1. 发现（按严重度降序）

### P1-1 归档保留期用 `unlink` 永久删除会话文件：无回收站、无备份、无开关，时钟前跳一次就批量删

- **位置**：`src/lib/session-retention.ts:76-83`，落地点 `src/lib/session-reader.ts:292-297`，接线 `src/lib/agent-manager.ts:2216`
- **证据**：
```ts
// session-retention.ts:71-83
		const since = Math.max(archivedAt, mtimeMs);
		if (since > cutoff) {
			report.kept += 1;
			continue;
		}
		const idleDays = Math.floor((now - since) / (24 * 60 * 60 * 1000));
		report.deleted.push({ path: target, idleDays });
		if (dryRun) continue;
		const { deleteSession } = await import("./session-reader");
		await deleteSession(target);
		await forgetSession(target);
```
```ts
// session-reader.ts:292-297
	try {
		await fs.unlink(target);
	} catch (error) {
		// 未落盘的惰性会话（还没发过消息）本来就没有文件，删除视为成功
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
```
```ts
// agent-manager.ts:2216 —— 启动即生效，没有任何开关
startArchivedSessionRetention({ isActive: isSessionInUse, log: (message) => console.log(message) });
```
- **触发路径**：用户在侧栏点了「归档」（`SessionSidebar.tsx:567-572`，**无二次确认**）→ `POST /api/workspaces {action:"archiveSession"}` → `archiveSession()` 写入 `archivedSessions` + `archivedAt=Date.now()`（`workspace-store.ts:277-295`）→ 服务端启动 5 秒后（`delayMs = 5_000`，`session-retention.ts:93`）与之后每 6 小时（`SWEEP_INTERVAL_MS`）扫一遍归档列表 → `now - max(archivedAt, mtime) >= 30 天` 就 `fs.unlink` + 从注册表抹掉。
- **后果**：
  1. **明确回答任务里那条关键问题：清理逻辑不会误删"未归档"会话**——`getArchivedEntries()` 只返回 `archivedSessions` 里的路径，`deleteSession` 还有 `isPathInside` + `.jsonl` + realpath 三重边界校验（`session-reader.ts:280-291`），`tests/session-retention.test.ts:101` 也有专门用例。这一条是安全的。
  2. **但"已归档"会话的删除完全不可逆**：不是移到回收站、不是先打包，是直接 `unlink`。整个会话 JSONL（历史对话原文）一次性消失，`forgetSession` 还把归档记录一并抹掉，事后连"曾经有个会话"都看不出来。唯一痕迹是一行 `console.log`（`session-retention.ts:83`），而 `npx piweb` 场景下 stdout 未必被保存。
  3. **时钟前跳 = 一次性批量删**：`cutoff = now - 30d`，`now` 取系统时间。Windows 换主板电池 / 双系统 / 虚拟机挂起恢复导致系统时间前跳 30 天以上时，所有"已归档且在归档簿里"的会话在同一轮里全部过期，服务器启动 5 秒后**没有任何确认**就删完。往回改时间也救不回来。
  4. 没有单轮删除上限，也没有"连续 N 轮都过期才删"这类缓冲。
- **置信度**：已确认（读了完整链路 + 单测 + i18n 文案）。时钟场景是推理，验证方式：把测试机时钟 +40 天重启 PiWeb，看 `.pi/agent/sessions` 下归档会话是否被删；或直接 `sweepArchivedSessions({dryRun:true})` 打印 `deleted`。
- **建议修法**（最小改动）：`sweepArchivedSessions` 里把 `deleteSession(target)` 换成"移动到 `sessions/.trash/<原相对路径>`"（同盘 rename，不受时钟影响也不会丢），保留期改成真删除再加 90 天；同时给 `startArchivedSessionRetention` 加一个 env（如 `PIWEB_ARCHIVE_RETENTION_DAYS=off`）并在设置页暴露。写入 `~/.pi/agent` 之外的回收目录要单独讨论（pi 会扫 `sessions/*/*.jsonl`，所以 `.trash` 必须是隐藏子目录且不带 `.jsonl` 后缀，否则会被 `scanSessions` 扫回来）。

### P1-2 `web-workspaces.json` 一旦损坏，侧栏会话列表整表不可用，且没有任何修复入口

- **位置**：`src/lib/workspace-store.ts:39-68`（抛错）、`src/app/api/sessions/route.ts:18-19`（先写后读都在同一 try 里）、`src/hooks/usePiWeb.ts:872-877`
- **证据**：
```ts
// workspace-store.ts:64-67
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { workspaces: [], aliases: {}, archivedSessions: [], pinnedSessions: [], removedWorkspaces: [] };
```
```ts
// sessions/route.ts:18-23（GET /api/sessions 的必经路径）
	await registerCwds(sessions.map((session) => session.cwd));
	const workspaceRegistry = await getWorkspaceRegistry();
	const body = JSON.stringify({ success: true, data: { sessions, running: activeStatus(), workspaceRegistry } });
```
```ts
// tests/workspace-store.test.ts:276-283 —— 这是被单测固定下来的"设计"
	it("does not overwrite a malformed workspace registry", async () => {
		await fs.writeFile(registryPath, "{malformed", "utf8");
		await expect(listAdded()).rejects.toThrow();
		await expect(addWorkspace(path.join(tempDir, "new-workspace"))).rejects.toThrow();
		expect(await fs.readFile(registryPath, "utf8")).toBe("{malformed");
```
- **触发路径**：`~/.pi/agent/web-workspaces.json` 被写坏（手工编辑、别的工具截断、同步盘半覆盖、磁盘错误）→ 任意 tab 每 3 秒的 `GET /api/sessions` → `registerCwds` → `readFile` → `JSON.parse` 抛 SyntaxError（`error.code === undefined`）→ 不进 ENOENT 分支 → 直接抛 → 整个 GET 进 catch 返回 500。
- **后果**：`usePiWeb` 里 `setSessions` 不再被调用，`sessionListError` 常亮"会话列表加载失败"；冷启动时 `addedWorkspaces` 也为空 → 侧栏**完全空白**（工作区、会话、归档区全没有）。更糟的是修不动：**所有写路径也走同一个 `readFile`**（`mutate` → `readFile`），所以"删掉工作区 / 取消归档 / 归档"全部 500；`refreshWorkspacesFallback` 也 500。用户在 UI 里没有任何自愈入口，只能自己找到并手改/删这个文件。
- **置信度**：已确认（`mutate` 与 `read` 都经 `readFile`；空表降级只在 ENOENT 分支生效）。验证：把该文件写成 `{` 后刷新页面。
- **建议修法**：`readFile` 的 catch 里把"解析失败"与"ENOENT"分开处理——解析失败时把原文件 `rename` 成 `web-workspaces.json.corrupt-<ts>`（留证据）并返回空表（fail-open，只是丢了工作区别名/归档标记，不影响会话）；同时 `/api/sessions` 把 `registerCwds`/`getWorkspaceRegistry` 包进各自的 try，注册表出问题不该连累会话列表本身。

### P2-1 只读轮询 `GET /api/sessions` 里做写盘，锁/权限问题会让侧栏 500

- **位置**：`src/app/api/sessions/route.ts:18`，写路径 `src/lib/workspace-store.ts:364-409` + `176-186`
- **证据**：
```ts
// sessions/route.ts:18
	await registerCwds(sessions.map((session) => session.cwd));
```
```ts
// workspace-store.ts:385-386（快路径没命中就进 mutate：排他锁 + 原子写）
	return mutate(async (data, writeTarget) => {
```
```ts
// workspace-store.ts:146-153 —— 注释说明这坑以前踩过，但只修了"没有新 cwd"的那一半
 * 读不需要排他锁——这里以前走 withSettingsWriteLock + withExternalSettingsLock，
 * 于是侧栏每 3 秒的一次轮询都要在 ~/.pi/agent 里建出再删掉一个 `.lock` 目录；
 * ... 整个会话列表会直接 500 并每次重试 2 秒。
```
- **触发路径**：出现任何一个新 cwd（新开一个会话、从终端 pi 进来一个历史会话）→ 快路径 `missing=true` → `mutate` → `withSettingsWriteLock` + `withExternalSettingsLock` → `proper-lockfile.lock(file)` 重试 20×~100ms（`settings-write-lock.ts:27`）。家目录只读、`.lock` 残留目录被别的东西占着、杀软锁文件时，`lock()` 抛错 → `registerCwds` 抛 → 整个 GET 500。
- **后果**：一次新 cwd 就能把"列表加载"变成失败态，而且客户端会 `setSessionListError` + 每 3 秒重试同一个失败（`usePiWeb.ts:835-897`，`schedule()` 在 finally 里继续）。恢复只能靠用户手动清锁文件。另外：一个只读的 GET 会改磁盘，也让 ETag/缓存语义变得不可预期（body 里 `workspaceRegistry` 的写入是这次请求副作用产生的）。
- **置信度**：已确认（链路完整）；锁失败的具体概率取决于环境，标"脆弱"。
- **建议修法**：`registerCwds` 在 GET 里 fire-and-forget 并吞掉错误（`void registerCwds(...).catch(()=>{})`），或者干脆把自动登记从 GET 挪到 `POST /api/agent/new` 与 CLI 会话导入路径；至少让注册表写失败不回抛到会话列表。

### P2-2 会话列表无分页无虚拟化、搜索纯客户端（搜不到已归档，服务端 `?q=` 是死代码）

- **位置**：`src/components/SessionSidebar.tsx:934-954`、`977-1026`；服务端 `src/lib/session-reader.ts:254-278` + `src/app/api/sessions/route.ts:11`
- **证据**：
```tsx
// SessionSidebar.tsx:934-940 —— 搜索只在已经拿到的 sessions 里 filter
				{searchOpen && q.trim() ? (
					flatSessions.filter(
						(s) =>
							s.name?.toLowerCase().includes(q.trim().toLowerCase()) ||
							s.firstMessage.toLowerCase().includes(q.trim().toLowerCase()) ||
							basename(s.cwd).toLowerCase().includes(q.trim().toLowerCase()),
					).length === 0 ? (
```
```tsx
// SessionSidebar.tsx:1024 —— 全部行直接 map，没有 slice/窗口化
						: flatSessions.map((s) => sessionRow(s, false)))}
```
- **触发路径**：`sessions` 来自 `visibleSessions`（`usePiWeb.ts:1275-1278`，已剔除归档）。用户在搜索框里找上周刚归档掉的会话 → 永远搜不到（归档区只能靠肉眼翻）。会话数上千时首页渲染上千行 DOM，且流式期间 `activeStatus()` 让 ETag 每 3 秒变化 → `setSessions` 新数组 → `SessionSidebar` 的 memo 失效、整套分组 memo 重算、全部行重渲染（`SessionSidebar.tsx:1304-1308` 的注释里假设了"侧栏 props 在此期间不变"，流式时这个前提每 3 秒被打破一次）。
- **后果**：归档会话不可检索（用户唯一能找回来的入口是手动展开归档区）；几百个会话以上侧栏滚动和每 3 秒一次的列表更新开始掉帧；`/api/sessions?q=` 及其 `listSessions(query)` 过滤逻辑（`session-reader.ts:266-274`）在生产代码里没有任何调用方，与前端 `basename(s.cwd)` 的口径也不一致（服务端比整条 `cwd`）。
- **置信度**：已确认（grep 全仓 `/api/sessions` 只有 `usePiWeb.ts:849` 一个调用点，且不带 query）。
- **建议修法**：搜索改成"本地 filter 现行结果 + 命中不足时带 `q` 打一次服务端（含归档）"；列表行数超过 ~200 时按工作区分页或做窗口化。最小改动：搜索时把 `archivedSessions` 也纳入 filter，并加一行"含已归档"开关。

### P2-3 多标签页共用 `piweb.currentSession`：后写的覆盖前写的，刷新就串到别人的会话

- **位置**：`src/hooks/usePiWeb.ts:1128-1140`（写）、`1156-1171`（读）
- **证据**：
```ts
	const openSession = useCallback(
		(path: string) => {
			setCurrentPath(path);
			setCurrentId(idOf(path));
			// 持久化当前会话：刷新页面时恢复到这里，而不是回到新会话草稿
			try {
				localStorage.setItem("piweb.currentSession", path);
```
```ts
// usePiWeb.ts:1156-1167
	const restoredRef = useRef(false);
	useEffect(() => {
		if (restoredRef.current || !sessions.length) return;
		restoredRef.current = true;
		try {
			const saved = localStorage.getItem("piweb.currentSession");
			if (saved) {
				if (sessions.some((s) => s.path === saved)) {
```
- **触发路径**：标签页 A 开着会话 X；标签页 B 打开会话 Y（写 localStorage）。A 刷新 → 恢复到 Y。反过来同样。`storage` 事件只监听了主题键（`AppShell.tsx:358-361`），`piweb.currentSession` 没有监听，所以两个标签页之间也不会即时同步。
- **后果**：刷新后落到"另一个标签页正在看的会话"，用户会以为自己点错了；两个标签同时阅读时更容易困惑。**不会**串会话内容（SSE 按 `currentId` 各自订阅），只是选中项被抢。
- **置信度**：已确认（读写点都读了；无 storage 同步）。
- **建议修法**：键名加 `sessionStorage` 语义或加 tabId 后缀（`piweb.currentSession.<tabId>`，`sessionStorage` 里存 tabId）；至少对 `piweb.currentSession` 加 `storage` 监听并忽略"本次由我写入"的回声。

### P2-4 完全没有 URL 状态：不可深链、浏览器前进/后退无效、恢复靠字符串全等比较

- **位置**：`src/components/AppShell.tsx:112-1683`（无 `history`/`searchParams` 调用）、`src/hooks/usePiWeb.ts:1162`
- **证据**：全仓 grep `history\.(pushState|replaceState)|beforeunload|useSearchParams|location\.search` 只命中 `src/app/login/page.tsx:9,27`（登录页读 `?next=`），`src/` 里没有任何 `pushState`/`replaceState`/`beforeunload`。会话/工作区/视图（`activeView`、`heroCwd`、`currentPath`）全部只活在 React state + localStorage。恢复判断用的是全等：
```ts
// usePiWeb.ts:1162
				if (sessions.some((s) => s.path === saved)) {
```
- **后果**：① 无法把某个会话发给别人 / 收藏 / 从手机跟到桌面；② 点开一个会话后按浏览器返回，直接退出 PiWeb；③ 恢复用 `===` 比路径，而项目里其它所有比较都走 `normPath`/`pathKey`（`SessionSidebar.tsx:62-68`、`usePiWeb.ts:512-517`），一旦 `PI_CODING_AGENT_DIR` 换了写法或盘符大小写变化（Windows 短路径/junction），恢复静默失效并 `removeItem` 把记录删掉。
- **置信度**：已确认。
- **建议修法**：`openSession/closeSession/selectWorkspaceView` 用 `history.replaceState` 写 `?s=<id>&view=<view>`（id 已是 base64url，可直接进 URL），启动时优先读 URL 再回落 localStorage；恢复判断换成 `pathKey`/`normPath`。

### P2-5 移动端关闭的侧栏仍可 Tab 聚焦、读屏可读（无 `inert` / `aria-hidden`）

- **位置**：`src/components/AppShell.tsx:1061-1073`
- **证据**：
```tsx
			<div
				className="min-h-0 overflow-hidden"
				style={isNarrow ? {
					position: "fixed",
					inset: "0 auto 0 0",
					width: "min(86vw, 340px)",
					zIndex: 90,
					background: "var(--dsw-sidebar-fill)",
					transform: mobileSidebarOpen ? "translateX(0)" : "translateX(-105%)",
					transition: "transform var(--ds-duration-normal) var(--ds-ease-in-out)",
					boxShadow: mobileSidebarOpen ? "var(--dsw-elevation-prominent)" : "none",
				} : { background: "var(--dsw-sidebar-fill)" }}
			>
```
- **触发路径**：窄屏（≤840px）且 `mobileSidebarOpen === false`。侧栏只是被 `translateX(-105%)` 移出视口，仍在 DOM 里、`visibility` 正常、没有 `inert`/`aria-hidden`。
- **后果**：键盘用户 Tab 会依次陷进一个看不见的抽屉（品牌行、「新会话」、5 个导航项、加工作区、搜索、设置、以及所有工作区行/会话行的按钮），焦点指示器完全不可见；读屏会把整个会话树读一遍。手机上配蓝牙键盘或桌面窄窗口时可直接复现。
- **置信度**：已确认。`grep -n 'inert|aria-hidden' src/components/AppShell.tsx` 只有一处命中，是第 1333 行的网格占位 `<div aria-hidden="true" />`，侧栏容器（1061-1073）两者都没有；`grep -n 'visibility\s*:\s*hidden|inert|\[aria-hidden' src/app/globals.css` 无任何命中，所以也没有 CSS 侧兜底。
- **建议修法**：`isNarrow && !mobileSidebarOpen` 时给这个 div 加 `inert`（React 19 支持 `inert` 布尔属性；这个 Next 版本要确认，否则用 `aria-hidden="true"` + `tabIndex={-1}` 包一层），或干脆条件渲染（代价是丢失 transform 动画）。

### P2-6 草稿不落盘（刷新即丢，含图片），同时 `composerDrafts` 永久驻留 base64 图片

- **位置**：`src/components/AppShell.tsx:165-181`；`ChatDraft`/`ImageAttachment` 定义 `src/components/ChatInput.tsx:45-55`、`src/lib/types.ts:523-527`
- **证据**：
```tsx
	// Drafts are parent-owned data, never a replayable last insertion/upload event.
	const composerDrafts = useRef(new Map<string, ChatDraft>());
	const sessionDraftKeys = useRef(new Map<string, string>());
```
```ts
// types.ts:523-527
export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}
```
- **触发路径**：在输入框里写了一段长 prompt / 贴了图 → 刷新、崩溃、手机切后台被系统回收 → 草稿全部消失，而当前会话本身会被恢复到（`piweb.currentSession`）。Map 里的条目只有在"发送成功后按附件逐个剔除"时才变小（`ChatInput.tsx:477-479`），会话切换/删除/归档都不会清理对应 key。
- **后果**：① 未发送内容（可能是几百字 prompt + 20 张 base64 图片）刷新即丢，属于用户输入的数据丢失；② 反过来，一直被挂着没发的草稿（尤其带图的）会长期占内存，`__hero__:N` 键还会随每次"新会话"单调增（`AppShell.tsx:675-679`、`734-735`），同一个页面开一整天可以累积到几十份 base64。
- **置信度**：已确认（无任何 localStorage/IndexedDB 写入；grep `piweb.*` 键里没有草稿）。
- **建议修法**：把 `composerDrafts` 落成 `sessionStorage`（或 IndexedDB，图片大），按 `draftKey` 存纯文本 + 引用，图片单独存 blob；删除会话/归档时清对应 key。同时加 `beforeunload` 提示（可选）。

### P2-7 localStorage 全裸调用：存储被禁时挂载 effect 抛错，最坏整页白屏

- **位置**：`src/components/AppShell.tsx:91-97`、`231-239`、`298-305`、`485-490`、`211-214`
- **证据**：
```tsx
function persist(key: string, value: number) {
	localStorage.setItem(key, String(value));
}
function restore(key: string, fallback: number): number {
	const v = parseInt(localStorage.getItem(key) ?? "", 10);
	return Number.isNaN(v) ? fallback : v;
}
```
```tsx
	useEffect(() => {
		setSidebarWidth(restore("piweb.sidebarW", SIDEBAR_DEFAULT));
		setRightWidth(restoreRightWidth());
		setSidebarCollapsed(localStorage.getItem("piweb.sidebarCollapsed") === "1");
		setDrawerOpen(localStorage.getItem("piweb.drawerOpen") === "1");
```
- **触发路径**：浏览器禁用站点数据 / 隐私模式配额为 0 / 页面被嵌在禁止存储的 iframe 里 → `localStorage` 的 getter 直接抛 `SecurityError`。
- **后果**：写在 **mount effect** 里，抛出会冒泡到最近的 error boundary；`src/app` 下没有自定义 `error.tsx`，所以最坏是 Next 的默认错误页（整个 AppShell 都不渲染）。即便不白屏，`toggleSidebar`/`chooseDrawerSection`/拖拽松手时的 `setItem` 也会在事件处理器里抛未捕获异常。注：`usePiWeb` 里对 `piweb.currentSession` 的读写在 try/catch 里（`usePiWeb.ts:1113-1117`），说明团队知道这个风险，AppShell 这几处漏了。
- **置信度**：疑似（代码路径确定，实际抛错取决于浏览器/部署形态；手机 Safari 隐私模式 + 隧道域名下值得实测）。
- **建议修法**：把这几个 helper 统一包成 `safeGet/safeSet`（try/catch 返回 fallback），mount effect 里逐项 try。

### P2-8 每次轮询（3 秒）都做 O(会话数) + 2×O(工作区数) 次无缓存 `realpath`，而不是串行 IO

- **位置**：`src/app/api/sessions/route.ts:13-18`、`src/lib/workspace-store.ts:364-369`、`83-89`、`171-174`
- **证据**：
```ts
// sessions/route.ts:18 —— 直接把「每个会话的 cwd」原样传下去（第 13 行才去重，这里没有）
	await registerCwds(sessions.map((session) => session.cwd));
```
```ts
// workspace-store.ts:364-366 —— 每个元素各做一次 realpath，没有去重、没有缓存
export async function registerCwds(cwds: string[], { restoreRemoved = false } = {}): Promise<string[]> {
	const target = file();
	const normalizedCwds = await Promise.all(cwds.filter((cwd) => typeof cwd === "string" && cwd).map(canonicalWorkspacePath));
```
```ts
// workspace-store.ts:171-174 —— read() 每次都重新 realpath 全部工作区（注释自己说明了原因）
async function read(agentDir?: string): Promise<WorkspaceFile> {
	// 每次重新解析符号链接，避免链接改指向后沿用注册表快照中的旧 realpath。
	return normalizeWorkspaces(await readCached(file(agentDir)));
}
```
- **触发路径**：侧栏每 3 秒一次 `GET /api/sessions`（`usePiWeb.ts:841-844`，每个标签页各一条独立轮询）。服务端依次：`listSessions`（有摘要缓存，OK）→ `registerCwds(sessions.map(cwd))`（**每个会话**一次 `fs.realpath`）→ `read()`/`normalizeWorkspaces`（每读到一次就把 workspaces + removedWorkspaces + aliases 键 + growthInit 键全 realpath 一遍，`registerCwds` 里一次、`getWorkspaceRegistry` 再一次）。
- **后果**：直接回答简报里"工作区很多时是不是串行 IO"——**不是串行**（`Promise.all` 并行），但**代价与用户数据线性相关且完全没有缓存**。500 个会话 + 20 个工作区时，单次轮询约 500 + 2×(20+20+别名) ≈ 580 次 `realpath`；3 个标签页就 ≈ 1740 次 / 3 秒。Windows 上 `realpath` 要解析 junction 且会受杀软扫描影响，这是纯浪费的 CPU + IO（且每次轮询都在事件循环里发起几百个并行 fs 请求）。注意 `registerCwds` 的"快路径"（不取锁、不写盘）在这些 realpath **之后**才判断，所以它省掉的是锁，不是 IO。
- **置信度**：已确认（去重点在第 13 行的 `cwds` Map 上，第 18 行没用它）。验证：在 `canonicalWorkspacePath` 里计数，开两个标签页观察每分钟调用次数。
- **建议修法**：路由里传 `[...new Set(sessions.map((s) => s.cwd))]`（一行，立刻把 O(会话数) 降到 O(工作区数)）；`normalizeWorkspaces` 加一个按路径 + mtime 的 realpath 结果缓存（5–30 秒 TTL 足够，因为符号链接改指向极少发生）。



- **位置**：`src/components/SessionSidebar.tsx:562-575`
- **证据**：
```tsx
					<button
						className="icon-btn"
						style={{ width: 22, height: 22 }}
						title={reallyArchived ? t.unarchiveSession : `${t.archiveSession} · ${t.archiveRetentionHint}`}
						aria-label={reallyArchived ? t.unarchiveSession : t.archiveSession}
						onClick={(e) => {
							e.stopPropagation();
							setSessionMenu(null);
							if (reallyArchived) onUnarchive?.(s.path);
							else onArchive?.(s.path);
						}}
					>
```
- **触发路径**：鼠标悬停会话行 → 出现三个 22×22 图标（归档 / 置顶 / `…`），归档紧挨着置顶。误点一下即归档，无确认。
- **后果**：删除会话有二次确认（`sidebar-menus.test.tsx:135` 断言了），但"归档"没有——它启动的是 30 天后不可恢复的自动删除（P1-1）。用户只看到会话"消失了"，多半不会去展开归档区，30 天后就真没了。恢复成本全在用户身上。
- **置信度**：已确认。
- **建议修法**：归档后给一个可点"撤销"的 toast（几秒内可取消），或首次归档弹一次"归档满 30 天会删除，确认？"（可记住不再提示）。

### P3-2 保留期清理：单条出错中断整轮；并且每个 route bundle 各起一个 sweeper

- **位置**：`src/lib/session-retention.ts:51-84`（循环里直接抛）、`88-98`（`started` 是模块级 `let`）、对照 `src/lib/agent-manager.ts:176-179`、`2199-2205`
- **证据**：
```ts
// session-retention.ts:88-98
let started = false;
export function startArchivedSessionRetention({...} = {}): void {
	if (started) return;
	started = true;
```
```ts
// agent-manager.ts:176-179 —— 同一份代码里，跨 bundle 的状态都挂 globalThis
const globalForAgentManager = globalThis as typeof globalThis & {
	__piWebSessions?: Map<string, Managed>;
};
const sessions = globalForAgentManager.__piWebSessions ??= new Map<string, Managed>();
```
- **触发路径**：① 归档列表里有一条越界/被改过的路径（`deleteSession` 抛 `BoundaryError`）或 Windows 上 `unlink` 被占用抛 EPERM → 异常冲出 `for` 循环 → 后面所有过期会话本轮都不处理，且每 6 小时重复卡死在同一处（`startArchivedSessionRetention` 的 catch 只打日志）。② `started` 没挂 globalThis，而 Next 每个 route bundle 各有一份模块实例 → 每个用到 `agent-manager` 的路由都会各自 `setTimeout(5s)` 起一个 sweeper（dev 下 HMR 还会再加）。
- **后果**：① 一条坏记录导致清理永久停摆（过期会话越积越多，磁盘涨）；② 多个 sweeper 并发扫同一份归档簿，重复 `unlink`（ENOENT 被吞，不会丢数据）和多份重复日志——功能上无害，但让"每一次删除都会打印日志"这句承诺变成 N 行重复。
- **置信度**：① 已确认（无 try/catch per-entry）。② 疑似——依据是同一文件里两处显式用 globalThis 规避"每 bundle 一份模块"（`agent-manager.ts:176`、`2199`）的既有做法；验证方式：在 `startArchivedSessionRetention` 里打一行日志，冷启动后数行数。
- **建议修法**：循环体内 try/catch 单条（记 `report.failed` 后继续）；`started` 改挂 `globalThis.__piWebRetention`。

### P3-3 "默认 / 最近工作区"没有实现，"最近"实际是"最早添加"

- **位置**：`src/components/AppShell.tsx:655-662`、`388-395`、`846`
- **证据**：
```tsx
	const startNewSessionInCurrentWorkspace = useCallback(() => {
		// 对齐 dsh startSession：新会话默认落在当前会话的工作区（无则取最近工作区）
		const cur = currentPath ? sessions.find((s) => samePath(s.path, currentPath))?.cwd : undefined;
		setHeroCwd(cur || heroCwd || knownCwds[0] || "");
```
```tsx
	// AppShell.tsx:846
	const panelCwd = snapshot?.cwd || currentSession?.cwd || heroCwd || knownCwds[0] || "";
```
- **后果**：`knownCwds` 是 `[...addedWorkspaces, ...sessions.map(cwd)]` 去重后的顺序（`AppShell.tsx:394`），`addedWorkspaces` 又是注册表的插入顺序，所以 `knownCwds[0]` 永远是**最早添加的那个工作区**，与"最近使用"无关。用户在 B 工作区干了一整天、刷新页面后点"新会话"，草稿会落到 A（如果他没先点开过某个会话，`cur` 也是 undefined）。抽屉/文件查看器的 `panelCwd` 兜底同理。
- **置信度**：已确认（顺序来源明确）。
- **建议修法**：记录 `lastWorkspace`（在 `openSession`/`startNewSessionInWorkspace` 时写 localStorage），兜底改成 `cur || lastWorkspace || knownCwds[0]`。

### P3-4 切换会话时首帧会渲染上一个会话的消息

- **位置**：`src/components/AppShell.tsx:1243-1245`、`src/hooks/usePiWeb.ts:919-931`
- **证据**：
```tsx
								<ChatWindow
									key={currentId ?? "none"}
									messages={state.messages}
```
```ts
	// usePiWeb.ts:919-931 —— 清空 state 发生在 effect 里，晚于触发它的那次渲染
	useEffect(() => {
		esRef.current?.close();
		esRef.current = null;
		if (!currentId) {
			subscribedSessionRef.current = null;
			setState(emptyState(savedToolPreset()));
			return;
		}
		const reconnectingCurrentSession = subscribedSessionRef.current === currentId;
		subscribedSessionRef.current = currentId;
		setState((current) => reconnectingCurrentSession
			? { ...current, connected: false }
			: { ...emptyState(savedToolPreset()), connected: false });
```
- **触发路径**：点侧栏另一个会话 → `openSession` 只 `setCurrentPath/setCurrentId` → 这一次 commit 里 `currentId` 已是新的、`state.messages` 还是上一个会话的 → `ChatWindow` 因为 `key` 变了而重新挂载并用旧消息渲染 → effect 跑完才清空 → 再等新快照。
- **后果**：切会话瞬间有一帧（16ms 级）把上一个会话的消息、工具卡片、`panelCwd`（于是抽屉/文件列表也是旧工作区）摆在标题下面。多数情况看不见，但慢设备/大对话下可见闪烁；那一帧里 `onFork`/`onEditMessage` 拿到的是旧 entryId（点中的概率极低）。
- **置信度**：已确认（渲染顺序由代码决定），实际可见性需肉眼验证。
- **建议修法**：`ChatWindow` 的渲染条件加 `state.snapshot` 校验（`snapshot?.sessionPath` 与 `currentPath` 同路径才渲染消息），或把"清空 state"提前到 `openSession`（同步 `setState(emptyState())` 与 id 一起批处理）。

### P3-5 键盘/读屏细节合集（拖拽手柄、折叠按钮、行菜单）

- **位置**：`src/components/AppShell.tsx:1336-1349`（手柄）、`SessionSidebar.tsx:468`、`817-821`（`title="«"`）、`293-309` + `611-670`（行菜单）
- **证据**：
```tsx
			{!isNarrow && !sidebarCollapsed && (
				<div
					className="fixed top-0 h-full w-2 cursor-col-resize"
					style={{ left: sidebarWidth - 4, zIndex: 40 }}
					onPointerDown={onDrag("sidebar")}
				/>
			)}
```
- **后果**：① 宽度调整只有指针事件，键盘完全不可达，也没有 `role="separator"`/`aria-valuenow`；② 折叠按钮只有 `title="«"`/`title="»"`，读屏念出来是符号；③ 会话行菜单/工作区行菜单是纯 div popover：无 `role="menu"`、无方向键、**Escape 关不掉**（只监听 document 的 `mousedown`，`SessionSidebar.tsx:293-309`），键盘用户 Tab 进去后只能一路 Tab 出去；④ 搜索输入框只有 placeholder，无 `aria-label`，也没有快捷键唤起。
- **置信度**：已确认。
- **建议修法**：手柄加 `role="separator"` + 左右键调整（复用 `onDrag` 的 clamp 逻辑）；`«/»` 补 `aria-label={t.collapseSidebar}`；行菜单加 `onKeyDown` 处理 Escape/ArrowUp/ArrowDown。

### P3-6 `Ctrl/⌘+Shift+E` 没有 repeat 与弹窗抑制

- **位置**：`src/components/AppShell.tsx:317-328`
- **证据**：
```tsx
	useEffect(() => {
		const h = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
				e.preventDefault();
				if (drawerOpen && !selected && drawerSection === "project") toggleDrawer(false);
				else openDrawerSection("project");
			}
		};
		document.addEventListener("keydown", h);
```
- **后果**：长按会 `keydown` 连发，抽屉开/关抖动；设置弹窗、重命名弹窗、`AskUserCard`、扩展对话框打开时快捷键仍然生效（这些弹窗自己的 `useDialog` 吞掉了 Escape，但没吞这个组合键），会在模态后面偷偷切换抽屉，关闭弹窗后看到状态被改了。
- **置信度**：已确认。
- **建议修法**：加 `if (e.repeat) return;` 与 `if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;`（或复用 `useDialog` 的栈判断）。

### P3-7 `remove` 动作未做与其它动作一致的路径校验；`pick` 靠 Host 头认"本机"

- **位置**：`src/app/api/workspaces/route.ts:78-82`（remove）、`59-73` + `28-32`（pick）
- **证据**：
```ts
		if (body.action === "remove") {
			if (!body.path) return NextResponse.json({ success: false, error: "missing path" }, { status: 400 });
			const r = await removeWorkspace(body.path);
```
```ts
function isLoopbackRequest(req: Request): boolean {
	const host = req.headers.get("host") ?? new URL(req.url).host;
	const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
	return isLoopbackHostname(hostname);
}
```
- **后果**：① `add`/`pick` 都过 `resolveWorkspacePath`（realpath + 必须是目录 + ≤4096），`remove` 不过——可以往 `removedWorkspaces` 墓碑里塞任意字符串（会把此后再添加的同名路径静默隐藏），也能给不存在的目录留墓碑；影响面小但校验口径不一致。② Host 头可伪造：能直连服务端口的远端只要带 `Host: 127.0.0.1:30141` 就能让**主机上弹出原生文件夹对话框**（`pickFolderNative` 有 `picking` 互斥但只挡并发，挡不住连点）。不会泄露文件内容，但属于远端可控的主机 UI 干扰 + 一次 `addWorkspace` 的机会。
- **置信度**：已确认（代码如此）；实际可利用性取决于部署（有 `proxy.ts` 鉴权时先要过登录）。
- **建议修法**：`remove` 也走 `resolveWorkspacePath`（目录已不存在时用宽松版本：`path.resolve` + 长度校验）；`pick` 的主机判定改用 socket 对端地址（`req.headers.get("x-forwarded-for")` 都不可信，Next 里可用 `(req as any).ip` 或干脆改成一个显式的 `localhostOnly` 一次性令牌）。

### P3-8 注册表返回值与进程内快照共享引用；`removedWorkspaces` 只增不减

- **位置**：`src/lib/workspace-store.ts:109-116`（`normalizeWorkspaces` 只重建部分字段）、`155-169`（快照直接返回）、`412-429`（墓碑只加不减）
- **证据**：
```ts
	return {
		...data,
		workspaces: unique(data.workspaces),
		removedWorkspaces: unique(data.removedWorkspaces ?? []),
		aliases: normalizeKeys(data.aliases ?? {}),
		...(data.growthInit ? { growthInit: normalizeKeys(data.growthInit) } : {}),
	};
```
- **后果**：`archivedSessions`/`pinnedSessions`/`archivedAt` 是**直接透传的引用**，而 `readCached` 把 `snapshot.data` 原样交给 `normalizeWorkspaces`，所以 `getArchivedSessions()`/`getPinnedSessions()`/`getWorkspaceRegistry()` 返回的数组就是进程内缓存里的那一份。当前所有调用方都只读（`mutate` 里走的是 `readFile` 新读的对象），所以现在没坏；但这层别名关系是隐式的，任何人一次 `push` 就会污染缓存并绕过 mtime 校验。另外 `removeWorkspace` 写的墓碑没有过期机制，`registerCwds` 会自动跳过它们（`workspace-store.ts:375-378`），所以每删一个工作区就永久多一条记录。
- **置信度**：已确认（引用共享）；影响是"潜在"。
- **建议修法**：`normalizeWorkspaces` 把 `archivedSessions`/`pinnedSessions`/`archivedAt` 也拷贝一份；`removedWorkspaces` 加一个"墓碑只对最近 N 条/N 天生效"的剪枝。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 归档会话**永久删除**前的保护 | P1-1 是不可逆数据丢失 | `sweepArchivedSessions` 走"移动到 `.trash`"或断言"单轮删除上限 / 时钟前跳不会一次删空"；现在只测了正常过期 |
| 注册表损坏时的**产品级降级** | P1-2：`tests/workspace-store.test.ts:276` 只断言 lib 抛错，等于把"整表 500"固化成了契约 | 断言 `GET /api/sessions` 在注册表损坏时仍返回 200 + `sessions`，且 `usePiWeb` 仍渲染会话列表 |
| 清理循环的**错误隔离** | P3-2：一条坏记录会停掉整轮 | 归档簿里放一条越界路径 + 一条正常过期路径，断言正常的那条仍被处理、`report.failed` 有值 |
| `isSessionInUse` 与真实 managed 会话的**接线** | `session-retention.test.ts:109` 是注入假 `isActive`，`agent-manager.ts:2208` 的真实现从未被测 | 打开一个会话（进入 `sessions` 表）→ `sweep({isActive:isSessionInUse})` → 断言 `skippedActive` 命中 |
| 归档 / 取消归档的**端到端往返** | 前端 hook ↔ `/api/workspaces` ↔ registry 三段各自有测，中间拼起来没有 | `usePiWeb.archiveSession` → 归档区出现 → 主列表消失 → `unarchiveSession` 回来 |
| 服务端搜索 `q` | P2-2：死代码，且与前端口径不一致 | `listSessions("proj")` 命中 cwd/name/firstMessage 的断言，或直接删掉这条 API |
| 多标签页 `piweb.currentSession` 冲突 | P2-3 | 模拟两个 tab 写同一个键，断言恢复策略（或 tabId 隔离） |
| 归档期间另一个标签页仍打开该会话 | 归档"即收工"的承诺（`workspaces/route.ts:91-93`） | `/api/agent/[id]/events` 会不会把 dispose 掉的会话重新拉起 |
| 删除工作区后其会话落到"未分组" | 现在只有 lib 层测"只删注册"，UI 分组没有断言 | 渲染 `SessionSidebar`，断言删除后会话出现在「未分组」且工作区行消失（文案 `i18n:242` 与之对应） |
| localStorage 不可用时的挂载降级 | P2-7（疑似白屏） | stub `localStorage.getItem` 抛错，断言 `<AppShell>` 仍能渲染 |
| 上千会话的渲染上限 | P2-2 性能回归 | 2000 条 `sessions` 渲染耗时/节点数上限（或直接测分页函数） |
| `getArchivedEntries` 的 **key 大小写迁移** | Windows 上老注册表若存了非小写键，`typeof known[pathKey(p)] !== "number"` 会把整表时间重置为 now（会**推迟**删除，属安全方向，但没有测试固定这个行为） | 手写一个 `archivedAt` 键为混合大小写的注册表，断言不删 + 补写为 pathKey |
| 侧栏移动端关闭后的可聚焦性 | P2-5 | `isNarrow && !open` 时断言容器 `inert` / 无可聚焦后代 |

---

## 3. 与其他区域的可能交叉点

- **API / 鉴权区域**：`/api/workspaces`、`/api/sessions` 的路由体内**没有任何鉴权调用**，全靠 `src/proxy.ts` 的 `authEnabled()` + Cookie。请确认：`PI_WEB_AUTH` 未开启（默认本机用法）时，`GET /api/sessions` 会下发**主机上所有会话的绝对路径、cwd、首条消息全文（截断 300 字）**——只要端口可达（局域网/内网穿透）就等同信息泄露。另外 `action:"add"` 可把主机任意目录注册为工作区并被 `/api/fs` 浏览，这是设计边界还是漏了确认，需要 API 区域裁定。
- **bridge（`agent-manager`）区域**：① `archiveSession` 会 `disposeSessionPath`，但 `/api/agent/[id]/events` 会 `getManaged` 重新打开——只要另一个标签页/设备还开着这个会话，"归档即收工"就不成立，请确认 events 路由对已归档路径是否要拒绝；② `exportSessionFile`/`doRename`/`doForkSession` 对冷会话都会经 `/api/agent/[id]` 建 managed 实例，`export/route.ts:21-23` 的注释里已承认"junction/符号链接不同写法会给同一个文件再起一个 agent"，请确认这个重复实例是否有实际危害（句柄/内存/写冲突）；③ `isSessionInUse` 只认本进程 managed 表，`readSession`（冷读，`session-reader.ts:301`）打开的会话不算"在用"——用户正冷读一个满 30 天的归档会话时，清理会把文件从他眼皮底下删掉。
- **crosscut 区域**：`AppShell` 的 `panelCwd` 兜底链（`snapshot?.cwd || currentSession?.cwd || heroCwd || knownCwds[0]`）直接喂给 `DrawerPanel`/`FileViewer`/`useGrowth`/`openInEditor`，会话切换首帧（P3-4）会让它们指向上一个工作区；`DrawerPanel`/`FileViewer` 是否自己做了 cwd 变化时的状态重置，请 crosscut 确认。侧栏的行菜单是手写 popover，不是公共 `CustomSelect`/`DrawerPanel`，所以它的无 Escape/无 role 问题不算 crosscut 的账。
- **sandbox / 权限区域**：工作区列表就是"允许操作的目录集合"的 UI 面。`remove` 不校验路径（P3-7）会不会让某个仍被工具白名单引用的目录以墓碑形式复活/隐藏，需要 sandbox 区域确认墓碑与工具白名单的关系。
- **平台差异**：`workspace-store.ts:123` 的 `fs.rename(temporary, target)` 在 Windows 上覆盖被占用（杀软扫描、另一个进程持有读句柄）时会抛 EPERM/EBUSY，`write()` 会 fail-loud（工作区操作报错，不会静默），但 3 秒轮询里的 `registerCwds` 因此变成间歇性 500（P2-1）。是否有重试需要平台区域给结论。

---

## 4. 建议优先修的 3 件事

1. **P1-1：归档过期删除改成"移动到 `sessions/.trash/`（同盘 rename）"，并给 `startArchivedSessionRetention` 加关闭开关 + 单轮删除上限。** 现状是一行 `unlink` + 30 天计时，误归档或系统时钟前跳就永久丢失整段对话，事后没有任何痕迹可查。这是本区域唯一真正会"删掉用户数据"的地方。
2. **P1-2：注册表损坏改成 fail-open（改名留证 + 空表继续），并让 `registerCwds`/`getWorkspaceRegistry` 的失败不再连累 `GET /api/sessions`。** 一个几十字节的 JSON 现在就等于"侧栏全空 + 所有工作区/归档写操作全 500 + UI 无修复入口"。顺手把 P2-1 一起解决（只读 GET 里的写盘 fire-and-forget）。
3. **P2-3 + P2-4：把"当前会话/视图"编码进 URL（`replaceState`），并让 `piweb.currentSession` 按标签页隔离、恢复比较改用 `pathKey`。** 两件事共用一套状态出口：修完之后深链、前进后退、多标签、刷新恢复全都一次性对齐，也顺带解决恢复时的字符串全等比较。

（另外两条强烈建议排在 4/5 位：P2-2 的搜索覆盖归档 + 列表窗口化；P2-6 的草稿持久化——输入框内容在刷新时丢失，在手机上是常态。）
