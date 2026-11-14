# 成长树 / 成长追踪（growth） 审计报告

## 0. 覆盖范围

读了（行号以实际文件为准，`read` 计数）：

- `src/lib/growth-service.ts`（911 行，逐段读：基础工具 / 解析器 / 快照 / 提交 / 读取 全部读完）
- `src/lib/growth-tracker.ts`（233）、`src/lib/growth-tree.ts`（245）、`src/lib/growth-turns.ts`（55）
- `src/lib/session/metrics.ts`（31）
- `src/hooks/useGrowth.ts`（606）、`src/components/GrowthTree.tsx`（347）、`src/components/ProjectPanel.tsx`（543，只读 growth 相关段：consent 弹窗 / 轮次标题 / 空态 / 错误条 / 树 / 时间轴）
- `src/app/api/growth/route.ts`（55）
- 跨文件核对：`src/lib/agent-manager.ts:950–1046`（事件分发）、`1048–1082`（growthOf/growthRecord/growthConsent）、`2632–2641`（prepareGrowthBriefly）、`2795–2860`（prompt 路径）；`src/components/AppShell.tsx:900–962`（useGrowth 挂载 + 对话内轮次 badge）；`src/components/FileViewer.tsx:232–297`（快照内容/历史回退）；`src/lib/trajectory.ts:411–470`、`src/lib/chat/cancellation.ts`（口径对照）
- 测试全读：`tests/growth-service.test.ts`(423)、`growth-tracker.test.ts`(108)、`growth-tracker-failures.test.ts`(170)、`growth-turns.test.ts`(43)、`components/growth-tree.test.tsx`(57)；`use-growth.test.ts`(247)、`growth-tree.test.ts`、`components/growth-project-panel.test.tsx` 按用例读
- 实机只读取证（未写任何东西）：`git for-each-ref/rev-list --count/count-objects -v` on `D:\AIApp\PiWeb`，`.git` 目录列表

跳过：`src/lib/path-security.ts`（归 API/鉴权区域，我只依赖它把 `cwd` 收敿到工作区）；`usePiWeb.ts` 只读了 growth 事件分支；未跑 `npx vitest run`（BRIEF 基线已全绿，且本区域测试是真实 git 集成测试，多跑一遍不产生新信息）。

| 子功能 | 结论 | 依据文件 |
|---|---|---|
| 快照与提交（独立 index、`commit-tree`、专用 ref） | OK-但脆弱（不碰用户分支/index，但默认开启、无开关） | `growth-service.ts:236–260,609–673,715–780`；`tests/growth-service.test.ts:297–343` |
| 时间轴读取与缓存（head 增量 + 全量重读兜底） | OK | `growth-service.ts:794–858` |
| 会话解析 / 轮次归组（agent_start→settled） | OK-但脆弱 | `growth-tracker.ts:164–190`、`growth-turns.ts:46–54` |
| 同意（consent）流程 | OK（仅对非 git / 嵌套目录生效） | `growth-tracker.ts:121–145,213–228`、`growth-service.ts:305–323` |
| 时间轴 UI / 选中语义 / 竞态取消 | OK（竞态测试很扎实） | `useGrowth.ts`、`tests/use-growth.test.ts` |
| 项目树渲染（窗口化 / 键盘 / 懒加载） | OK-但脆弱 | `GrowthTree.tsx`、`growth-tree.ts` |
| API 路由 `GET/POST /api/growth` | OK | `app/api/growth/route.ts` |
| 上下文用量投影 `projectedContextUsage` | OK（percent 未 clamp，`>100%` 可能） | `session/metrics.ts:22–30` |

---

## 1. 发现（按严重度降序，同级按影响降序）

### P1-1 只要工作区本身是 git 仓库根目录，就在**不询问、不可关闭**的情况下往用户仓库里写 218 个提交级别的东西

- **位置**：`src/lib/growth-service.ts:305–323`（`ensureGitDir`：仓库根直接复用，不问）；`src/lib/growth-service.ts:332–356`（`createWorkspace` 建 `.git/piweb/`）；`src/lib/agent-manager.ts:2636–2641` + `2802`（每次提问前无条件调用）；`src/lib/growth-tracker.ts:154–163`
- **证据**：

```ts
// growth-service.ts:315-317  —— 只有「不是仓库根」才去要同意
const existing = await probe();
if ("gitDir" in existing) return existing.gitDir;
if (!allowInit) throw new GrowthError("growth tracking needs consent to create a git repository here", "needs-consent", existing);
```
```ts
// agent-manager.ts:2802 —— 每次提交对话前都拍快照，没有任何开关
if (!session.isStreaming) await prepareGrowthBriefly(m);
```
```ts
// growth-tracker.ts:121-127 —— needsInit 只在抛过 needs-consent 之后才为 true
const decision = needsInit ? await consent() : null;
if (decision === false) { declined(); return undefined; }
if (needsInit && decision === null) return undefined;
```

- **实测（本仓库自身，只读命令）**：`D:\AIApp\PiWeb\.git\piweb\{index(108 KB),exclude(547 B)}` 存在（今天 18:07 / 18:09），
  `refs/piweb/rounds/d-aiapp-piweb-5511943b` 上有 **218 个 commit**；`git rev-list --all --count` = **680**，`--not <piweb ref>` = **462** ——
  即任何 `git log --all` / `gitk --all` / VS Code Git Graph / `gitg` 的"全部分支"视图会多出 218 条
  `piweb: round` / `piweb: workspace changes`（作者 `PiWeb <piweb@localhost>`）；`count-objects -v`：loose 589 / 3187 KiB、3 个 pack。
  `refs/piweb` **不会**出现在 `git branch -a` 里（已确认 0 条）。
- **触发路径**：用户在任意"已是 git 仓库根"的目录里开会话 → 发第一条 prompt → `prepareGrowthBriefly` → `recordWorkspaceChanges` → `getWorkspace(allowInit=false)` → `ensureGitDir` 的 `probe()` 命中 `gitDir` → 直接写 `.git/piweb/exclude`、`update-index`、`write-tree`、`commit-tree`、`update-ref`。全程不出现在任何 UI 确认里。
- **后果**：
  1. 用户对自己仓库里正在被写东西**毫不知情**，也没有任何 UI 能关掉它（我 grep 了整个 `src/`：没有 growth 开关；`workspace-store.ts:219–227` 的 `growthInit` 只有"同意/拒绝建仓库"两种取值，仓库根永远不会被问，因此也永远不会被记成 `false`）。
  2. 每轮把改动文件的完整 blob 写进用户 `.git/objects`（见 P2-3），且这些对象挂在 `refs/piweb/*` 上**永久可达**，`git gc` 不会回收 —— 用户清理不掉，除非知道要 `git update-ref -d refs/piweb/...`。
  3. commit trailer 里带会话 jsonl 文件名 + 提问首行（`roundMessage`/`sessionName`，`growth-service.ts:570–583`），等于把用户提问内容复制进他的仓库对象库（不会被 push，`git clone` 也不带走 `refs/piweb`，但仓库目录被整包备份/`push --mirror` 时会带出去）。
  4. `gcInBackground`（`:698–708`）在**用户仓库**里每 50 次提交跑一次 `git gc --auto`：会 repack 用户自己的对象、改写 `packed-refs`（本仓库 `packed-refs` 里已经有一条 piweb 引用）。语义上和用户自己跑 `git gc` 相同，但不是用户要求的。
- **澄清（避免误判为 P0）**：**不碰用户 HEAD / 分支 / 暂存区 / `info/exclude`**——`GIT_INDEX_FILE` 指向 `.git/piweb/index`（`:252–260`），用户 index/HEAD/config 一个字节不改、`refs/heads` 为空，这两点有真实 git 测试断言：`tests/growth-service.test.ts:335–342`（外加"新增条目只能是 objects/refs/piweb/piweb 三类"）。所以这不是"污染提交历史/丢数据"，而是**静默增重 + 全分支视图污染 + 无法关闭**。
- **置信度**：已确认（读了完整链路 + 本机仓库实况）。
- **建议修法**：把 consent 的触发条件从"不是仓库根"改成"工作区第一次被记录"——即 `growthInit` 为 `null` 时（无论是否 git 仓库）都先抛 `needs-consent` 并弹窗；弹窗里明确"会产生 refs/piweb/* 提交与对象，可在设置里关闭/删除"。另外在项目面板里给一个"关闭生长记录 + 删除 refs/piweb/* 并 gc"的入口（`workspace-store.ts` 已有 `growthInit` 落盘机制可直接复用为 `false`）。

### P2-1 超过 1 MB 的文件会被记成"删除"，树和统计与磁盘不符（`MAX_FILE_BYTES` 的判定方式有问题）

- **位置**：`src/lib/growth-service.ts:27`（`MAX_FILE_BYTES`）、`:647–661`（分类）、`:662–666`（全体 `--force-remove`）
- **证据**：

```ts
// growth-service.ts:653-660
const stat = await fs.lstat(path.join(ws.cwd, rel)).catch(...);
return { rel, include: Boolean(stat?.isFile() && stat.size <= MAX_FILE_BYTES) };
...
for (const { rel, include } of classified) (include ? adds : removals).push(rel);
```
```ts
// growth-service.ts:664-666 —— 超限的候选被无条件从 PiWeb 索引里移除
for (let i = 0; i < removals.length; i += INDEX_BATCH) {
	await shadow(ws, ["update-index", "--force-remove", "-z", "--stdin"], { input: `${removals.slice(i, i + INDEX_BATCH).join("\0")}\0` });
}
```

- **触发路径**：某文件曾被快照（≤1 MB）→ 用户/pi 把它改到 >1 MB → 下一轮 `commitRound`：它出现在 `ls-files --modified` 里、分类成 `removals`、被 `--force-remove` → 新 tree 里没有它 → `diffTreesRaw(parentTree, tree)` 得出 **status D**。
- **后果**：一个**仍然存在**的文件在项目树里显示成删除线 + 红色 `D`，`stats.deleted` +1（二进制文件 add/del 记 0，文本大文件会把上万行算成"−N 行"，整轮柱状图变红）。`graftLazy` 也修不回来：`growth-tree.ts:236–241` 里"已有的（D 节点）优先，磁盘节点只补空缺"。文件再缩回 1 MB 以下又会变回 `A`，来回跳。Web 项目里 `public/` 下 >1 MB 的图片/视频被替换是最常见的命中场景。
- **置信度**：已确认（代码路径完整，无测试覆盖；未实跑复现）。
- **建议修法**：分类时区分"从未进过索引"和"已在索引里但现在超限"。对后者保留旧 blob、不提交本轮内容（即从 `ls-files --modified` 结果里剔除，而不是 force-remove），或在 diff 里把它显式标成"超限跳过"而不是 `D`。

### P2-2 同一工作区两个会话（或多开 PiWeb / 自动任务）并发时，改动会被记到错误的一轮上

- **位置**：`src/lib/growth-service.ts:87–97`（registry 按 **cwd** 共享状态）、`:344`（ref 按 cwd 派生）、`:715–780`（全量快照 + 单链）；`src/lib/agent-manager.ts:1050–1062`（每个 session 各一个 tracker、共用 `m.cwd`）
- **证据**：

```ts
// growth-service.ts:96-97 —— 一个工作区一条链，与会话数量无关
const registry: Registry = (globalForGrowth.__piWebGrowthRounds ??= { workspaces: new Map() });
...
ref: `${GROWTH_REF_PREFIX}/${key}`,   // :344  key 只由 cwd 决定
```
- **触发路径**：会话 A 运行中（文件已改未提交）→ 会话 B（另一个浏览器标签 / `automations/runner.ts` 起的后台会话）settle → B 的 `commitRound` 对**整个工作区**拍快照 → A 正在改的文件被写进 B 的 tree、记成 B 这一轮的 `A`/`M`。随后 A settle，它的 diff 相对 B 的 commit，A 的"本轮改动"就少了这部分；面板里 A/B 各自的"第 N 轮 · 改了 M 个文件"都错。
- **后果**：跨会话 `refs/piweb` 是单一链，`numberRounds` 只对**当前会话**的 commit 编号（`useGrowth.ts:88–91`），所以两个会话的轮号各自治好了，但**每一轮的改动内容互相污染**。同时 `readRounds(cwd, session)` 用 basename 过滤（`:841–857`），能过滤掉别人的轮次条目，过滤不掉别人塞进 tree 的字节。
- **置信度**：已确认（读代码 + 测试只覆盖单会话），未多会话实跑。
- **建议修法**：最小改动是给 `RoundMeta` 加一个"本轮会话独占工作区"的标记，把 `abortIf` 的判定从"本轮 epoch 变了"扩展到"工作区里还有别的活跃 run"；更彻底的做法是按会话分 ref（`refs/piweb/rounds/<key>/<sessionKey>`），代价是失去"工作区全局时间轴"。

### P2-3 快照存储无字节上限、piweb 对象永不回收，并在用户仓库里代跑 `gc --auto`

- **位置**：`src/lib/growth-service.ts:27–35`（三个上限全是"个数"）、`:693–708`（gc）、`:723–724`（每轮 `write-tree`）
- **证据**：

```ts
export const MAX_FILE_BYTES = 1024 * 1024;      // 单文件上限
const MAX_CANDIDATES = 50_000;                  // 只有"候选文件数"上限
const MAX_CHANGES_PER_ROUND = 2000;             // 只影响返回给前端的列表
```
```ts
// :698-708 —— 在用户的 gitDir 里跑 gc
const child = spawn(gitBin, ["--git-dir", ws.gitDir, "gc", "--auto", "--quiet"], { cwd: ws.cwd, ... stdio: "ignore" });
child.unref();
```
- **后果**：理论上限 = 50 000 × 1 MB = 50 GB 单轮 baseline（第一次拍基线就把工作区全部文件写进用户 `.git`；`MAX_CANDIDATES` 只拦"文件数量"，不拦"总字节"，也没有"当前仓库已用多少"的判断）。之后每轮把改动文件的完整副本再写一遍，且都可达 → `git gc` 只能打包不能回收。本机实测（P1-1 同一仓库）：loose 589 个 / 3187 KiB 只是**今天**的增量，pack 17.6 MB。
- **置信度**：已确认（代码 + 实测量）。
- **建议修法**：加一个总字节预算（例如每轮 `sum(size of added blobs) <= 64 MB`、每工作区快照总量上限），超限时按 P2-1 同样的方式只跳过不记 D；`gcInBackground` 建议改成不在用户仓库里跑（改为提示用户，或至少尊重用户 `gc.auto=0` —— 现在 `-c` 里没传，实际会读用户配置，这点是好的，但默认值会触发）。

### P2-4 每轮提问前做一次全量 worktree 扫描（且显式关掉了 fsmonitor / untracked cache），大仓库固定成本高

- **位置**：`src/lib/growth-service.ts:236–246`（`BASE_CONFIG`）、`:609–673`（`refreshIndex`：`ls-files` + 逐候选 `lstat`）、`src/lib/agent-manager.ts:2636–2641`（5 s 竞速）
- **证据**：

```ts
const BASE_CONFIG = [
	"-c", "core.autocrlf=false", ... "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...
];
```
```ts
// :613  每次都要 git 走一遍索引 + 工作区
const listed = await shadow(ws, ["ls-files", "-z", "--others", "--modified", "--deleted", "--exclude-standard", `--exclude-from=${excludeFrom}`]);
```
```ts
// agent-manager.ts:2637-2640  5 秒后放行提问，但后台那次扫描仍在跑并占着 ws.lock
await Promise.race([growthOf(m).prepare().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
```
- **后果**：10 万文件级的仓库，**每次发消息**都起一个 git 进程做全量 stat 走查 + 最多 5 万次 `fs.lstat`（`BATCH=256` 并发）。超过 5 s 后用户已经能提问，但 `withLock` 让本轮 settle 的 `commitRound` 排在那次扫描后面，于是"轮次落盘"被推迟；关闭 `fsmonitor`/`untrackedCache` 是为了不改用户索引的合理取舍，但代价恒定存在。`README`/注释里说的"项目过大时本会话停用跟踪"只在**候选数** >5 万时生效，大而深的目录树（文件不多但层级深）不受保护。
- **置信度**：已确认（读代码；未在大仓库实测耗时）。
- **建议修法**：`prepare()` 在"距上次快照 < N 秒且没有任何工具写过盘"时直接跳过（PiWeb 已经知道本轮有没有 `write`/`edit`/`bash` 工具调用）；或把 `ls-files` 的 30 s 超时降到 5 s 并区分"慢"与"失败"。

### P2-5 轮次状态口径与轨迹视图不一致：provider 的"取消"会被标成"本轮出错"

- **位置**：`src/lib/growth-tracker.ts:42–51`（`roundStatus`）对照 `src/lib/trajectory.ts:449`（`stopReason === "error" && !isAbortMessage(m.errorMessage)`）
- **证据**：

```ts
// growth-tracker.ts:42-51
function roundStatus(entries: readonly SessionEntryLike[]): GrowthRoundStatus {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const message = entries[i].type === "message" ? entries[i].message : undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return "error";
		return "done";
	}
	return "done";
}
```
```ts
// trajectory.ts:449 —— 轨迹视图对同一份 JSONL 做了消歧
title: m.stopReason === "error" && !isAbortMessage(m.errorMessage) ? "error" : "assistant",
```
`StopReason` 的取值域是 `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`
（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:321`），而 `src/lib/chat/cancellation.ts:2–5` 明确存在
"provider 取消串被包成普通 error" 这种情况。

- **触发路径**：用户点停止 / provider 主动 abort → 最后一条 assistant 消息 `stopReason === "error"` 且 `errorMessage` 是 `"This operation was aborted"` 之类 → 轨迹视图显示"中断/非错误"，生长面板把这一轮标成 `error`（`ProjectPanel.tsx:263,327` 显示"本轮出错"），`round.stats`/柱状图也跟着变。
- **后果**：同一件事两个视图结论相反，属于 BRIEF 特别点出的"口径对不上"。另外 `length`（被截断）与 `deferred` 都归成 `done`，也不算错但同样没区分。
- **置信度**：疑似（代码口径差异已确认；"取消走 stopReason=error"这一点需要真机上制造一次 provider abort 才能坐实）。
- **建议修法**：`roundStatus` 复用 `isAbortMessage`：`if (message.stopReason === "error" && !isAbortMessage(message.errorMessage)) return "error";`，其余 error 一律按 `aborted`/`done` 处理。

### P2-6 一轮的 commit 失败时，这一轮会从时间轴上"消失"，导致轮号与对话错位

- **位置**：`src/lib/growth-service.ts:715–780`（失败即无 commit）、`src/lib/growth-tracker.ts:96–99`（`enqueue` 链吞掉异常只报错）、`src/hooks/useGrowth.ts:88–91`（`numberRounds` 按数组顺序重编号）
- **证据**：

```ts
// growth-tracker.ts:96-99
const enqueue = (fn: () => Promise<void>) => {
	chain = chain.then(fn, fn).catch(reportError);
	return chain;
};
```
- **触发路径**：`git timed out`（30 s，`growth-service.ts:177`）/ `git output exceeded the buffer limit` / 磁盘满 / 用户仓库被锁 → 本轮 commit 抛错 → `reportError` 只发一次 `growth_error`（60 s 节流）→ 没有 commit → 面板里 `numberRounds` 把后面的轮次整体前移一位。
- **后果**："第 5 轮"实际是对话里的第 6 轮；`roundBadges` 把改动数挂到了错误的用户消息上（`AppShell.tsx:935–943` 用 `promptIds[0]` 去对消息 id —— 这条是对得上的，但**轮号**对不上）。而"轮号与对话一一对应"是这个功能写在文件头注释里的核心承诺（`growth-tracker.ts:5–7`）。
- **置信度**：已确认（代码路径；失败触发条件未实跑）。
- **建议修法**：终态失败时把这一轮记成"占位"（例如在 `ws.rounds` 里补一条 `status:"error"` 的本地内存项，或前端按 `promptIds` 计轮号而不是按数组下标）。

### P3-1 服务端缓存与内存无淘汰：`registry.workspaces` / `ws.rounds` / `commitsSinceGc` 只增不减

`growth-service.ts:87–97`（`Map` 永不 delete，除 `.git/HEAD` 消失时）、`:79`（每个 workspace 保留全链所有 `changes`，单轮上限 2000 条）。长跑的开发服务器上，每开过一个工作区就永久留一份（含所有轮的 diff 清单）。dev 热更新时靠 `__piWebGrowthRounds` 全局缓存"不复用旧结构"，但也因此更不容易被回收。建议加 LRU（例如保留最近 8 个工作区）。

### P3-2 纯读路径仍会往 `.git` 里写文件

`readRounds` 的快速路径（`:849–852`）确实避免了给非仓库建 `.git`（有测试 `tests/growth-service.test.ts:222–231`），但对**已是仓库**的工作区，`getWorkspace → createWorkspace`（`:337,349`）会 `mkdir .git/piweb` + 覆写 `exclude`。一次"看时间轴"的 GET 请求因此有写副作用（`hash-object` 没带 `-w`，不算写对象）。影响很小，但与"读取一律不建仓库"的注释意图不完全一致。

### P3-3 文件清单请求失败被静默吞掉，树退化成"只显示变更文件"且无提示

```ts
// useGrowth.ts:366-368
.catch(() => { if (isCurrent(controller)) setFiles({ key, tree, files: [] }); });
```
`/api/growth?list=1` 404/500 时用户看到的是"只剩改动文件的树"，没有任何错误提示（范围变更失败是有提示的：`rangeChanges.error`）。

### P3-4 跨天历史看不出日期；面包屑跳转后键盘导航失效

- `ProjectPanel.tsx:99–102` `fmtTime` 只输出 `HH:MM`，一个跑了三天的项目，时间轴/轮次列表里昨天和前天的轮次只差一个时刻，无法区分。
- `GrowthTree.tsx:91–100` `revealPath` 只 `setFocused(...)`，没有 `el.focus()`，所以"面包屑跳转到文件"之后按 ↑↓ 不生效，必须先用鼠标点一下树。

### P3-5 失败提示全是英文原文直出

`growth-service.ts` 抛的 message（`snapshot has 50001 candidate files (limit 50000); largest directories: ...`、`git timed out`、`git is not installed`）经 `ProjectPanel.tsx:370–374` 原样显示给用户，没有走 `i18n`。中文界面里突然冒一段英文技术描述。另外 `too-large` 是终态（`growth-tracker.ts:81–86`），用户只会看到一次错误，之后时间轴静默不再增长，界面上没有"本会话已停用生长记录"的常驻提示（`growth.available` 只在 git 不可用时变 false）。

### P3-6 `.git` 之外的其它小问题（各一句）

- `parseRoundMessage`（`growth-service.ts:547–564`）把提交信息第 1 行当标题，用户提问首行如果恰好写成 `Piweb-Prompts: x` 形态，回读时会在"本轮没有 promptIds"的情况下注入一个假的 id（真 trailer 因为写在其后会覆盖，所以 kind/session/status 不受影响）。后果只是"在对话里看"按钮跳到一个不存在的 id（静默无效）。
- `sessionName`（`:581–583`）+ `sameSessionName`（`:841–843`）用**文件名**而非完整路径做会话键：同工作区内两份同名 jsonl（复制/另存/导入）会把两段历史混成一条时间轴。会话文件名含 uuid，实际很难撞。
- `workspaceKey`（`:107–119`）进 ref 名：项目目录**改名/移动**后历史整体"消失"（旧 ref 与对象仍留在 `.git` 里成为孤儿），用户视角就是"记录没了"。
- `session/metrics.ts:29–30` `percent: tokens / contextWindow * 100` 没有 clamp，估算超窗口时会算出 >100%（`ContextMeter.tsx:91` 的圆环/条自己 `Math.min` 兜住了，但 `usageLabel` 会显示 `137%`）。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| `MAX_FILE_BYTES` 边界 | P2-1：超过 1 MB 的文件被记成 `D`，树/统计与磁盘不符，现在完全没测 | 文件从 900 KB 改成 1.1 MB 后 `commitRound` 的 `changes` 应该是"不变/跳过"而不是 `[{status:"D"}]`；再缩回后不应出现 A |
| `MAX_CANDIDATES`（`too-large`） | 唯一会让整个会话停用跟踪的路径，只有 mock 测试（`growth-tracker-failures.test.ts:22`），真实 git 路径没测 | 在临时目录造 50 001 个候选文件（可用 sparse/硬链接或把上限注入），断言抛 `code:"too-large"`、`error.message` 里带最大目录、且**没有**产生任何 commit |
| `MAX_CHANGES_PER_ROUND` 截断 + `stats` 完整性 | `truncated` 与"列表被截断但统计完整"是 UI 的核心依据（`ProjectPanel` 有测试，服务端没有） | 一轮改 >2000 个文件：`changes.length===2000`、`truncated===true`、`stats.added===2001`（完整数），并且 `changesBetween` 能补全 |
| 同一工作区两个会话并发 | P2-2：归属错乱，现在一个测试都没有 | 两个 tracker 共用同一 cwd，交替 `prepare`/`agent_settled`，断言 A 的 `changes` 不含 B 写的文件（或明确记录该行为为已知限制） |
| provider 取消（`stopReason:"error"` + abort 文案） | P2-5：口径与轨迹视图冲突 | `entries` 里放 `{role:"assistant", stopReason:"error", errorMessage:"This operation was aborted"}`，断言 `status` 与 `buildTrajectoryFromEntries` 的判定一致 |
| commit 失败后的轮号连续性 | P2-6：轮号与对话错位 | 让第 2 轮 commit 抛错，断言第 3 轮在 UI 里仍是"第 3 轮"（或恢复成功后补记） |
| `filePatch`/`fileContent` 的路径穿越 | `assertRelPath` 只有代码没有测试 | `../x`、`/abs`、`C:\x`、`a\..\b`、UNC `\\\\srv\\share` 全部应 404/`not-found`，而不是读到工作区外 |
| 空态组合 | 面板 `emptyText` 有 5 个分支（无 cwd / 无会话 / 加载中 / 不可用 / 无轮次） | 至少锁住"`too-large` 停用后"的显示（当前落到 `growthNoRounds`，用户看不出是"出错停用"还是"真的还没记录"） |

---

## 3. 与其他区域的可能交叉点

1. **API/鉴权区域**：`GET /api/growth` 的 `cwd` 靠 `resolveWorkspacePath` 收敿；`listTree/fileContent/filePatch` 接受客户端给的任意 tree/blob 哈希（只校验 40 位 hex 与路径不含 `..`），意味着**只要在工作区内**，这些接口能读出用户仓库里任意 tree 的历史文件内容（包括用户自己 git 里、快照里没有的文件）。我没发现能逃出工作区的路径，但"读 git 对象内容"这层权限面建议由 API 区域复核：`assertRelPath`（`growth-service.ts:393–400`）没有测试，且 `fileContent` 用 `${tree}:${rel}` 拼对象名。
2. **sandbox/权限区域**：`refreshIndex` 明确不跟随 symlink/junction（`growth-service.ts:646–661`），有 3 个测试守着（`tests/growth-service.test.ts:368–422`）。若 sandbox 区域改动了"工作区外可写路径"的定义，这里的 `regularDirectory` 判据（只认 `lstat().isDirectory() && !isSymbolicLink()`）需要同步。
3. **bridge 区域（`agent-manager.ts`）**：`prepareGrowthBriefly` 的 5 s 竞速写在 agent-manager 里，而 `abortIf`/`epoch` 语义在 growth-tracker 里；两处对"pi 何时算开工"的假设必须一致（`agent_start` 事件）。目前 `runStart` 只在 `agent_start` 置位，若 bridge 区域将来在别处合成/抑制 `agent_start`，轮次会丢（tracker 里 `runStart !== null` 时不重开一轮）。
4. **crosscut/UI 区域**：`ContextMeter` 对 `percent > 100` 的处理（`ContextMeter.tsx:91,93`）；`ProjectPanel` 的 `growth.error` 条直接渲染服务端英文串，是否统一由 i18n 层兜。
5. **FileViewer（文件查看器）区域**：`FileViewer.tsx:238–256` 在快照里 404 时会沿 `growth.rounds` 往回找"最近一次涉及该文件的轮"，依赖 `round.changes` 完整；若 `MAX_CHANGES_PER_ROUND` 截断生效（`truncated`），这段回退会找不到那条记录而直接退化成"读磁盘版本"。这个耦合建议由查看器区域确认是否符合预期。

---

## 4. 建议优先修的 3 件事

1. **P1-1**：把 consent 提前到"第一次要记录"（任何工作区，不只是非 git 目录），并在 UI 给出关闭开关 + 删除 `refs/piweb/*` 的方式。这是唯一"用户不知道、也关不掉"的写盘行为，本机仓库已经积了 218 个 PiWeb 提交、`git log --all` 已被污染。
2. **P2-1**：修 `MAX_FILE_BYTES` 的判定 —— 让"文件变大超过上限"不再表现为 `D`（同时给 P2-3 的字节预算留出同一个钩子）。这是纯展示/统计层面的错，但会让用户以为文件被删了。
3. **P2-2**：解决同工作区多会话（含 automation）的改动归属；哪怕只是"检测到并发就放弃这一轮的 `user` 快照"，也比把 A 的改动记进 B 的轮次强。
