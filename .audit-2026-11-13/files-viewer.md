# 文件浏览 / 查看器 / 差异 审计报告

## 0. 覆盖范围

**读过的源码（17 个，全部整文件读完，行数按当前磁盘）**

| 文件 | 行数 |
|---|---|
| `src/lib/files-service.ts` | 581（任务书写 558） |
| `src/components/FileViewer.tsx` | 690（任务书写 674） |
| `src/components/FullDiff.tsx` | 220 |
| `src/components/DiffView.tsx` | 139 |
| `src/components/DirectoryPicker.tsx` | 202 |
| `src/components/ImportProjectPicker.tsx` | 157 |
| `src/components/ImageViewer.tsx` | 67 |
| `src/components/PreviewImage.tsx` | 33 |
| `src/hooks/useFileViewer.ts` | 62 |
| `src/hooks/useWorkspaceFiles.ts` | 93 |
| `src/app/api/files/route.ts` | 77 |
| `src/app/api/fs/route.ts` | 119 |
| `src/lib/resource-fingerprint.ts` | 188 |
| `src/lib/chat/file-path.ts` | 85 |
| `src/lib/highlight.ts` | 59 |
| `src/lib/file-icons.ts` | 39 |
| `src/lib/text-sanitize.ts` | 32 |

**为核对调用链额外读的（不算本区域结论，只用来验证边界是否真生效）**：`src/lib/path-security.ts`(93)、`src/proxy.ts`(87)、`src/lib/prompt-sources.ts`(255)、`src/app/api/growth/route.ts`(55)、`src/lib/growth-service.ts` 片段（`filePatch`/`fileContent`/`parseNameStatus`/`parseNumstat`，约 200 行）、`src/hooks/useGrowth.ts` 片段（`listDiskEntries`/`expandLazy`/`diskPulse` 刷新，约 250 行）、`src/lib/workspace-index.ts`(268)、`src/lib/pi.ts` 片段（资源指纹调用，约 40 行）、`src/components/AppShell.tsx` 片段、`src/components/ChatInput.tsx` 片段、`src/lib/types.ts` 片段、`src/app/globals.css` 片段（`.pw-viewer` / `.pw-fdiff-*`）。

**读过的测试（10 个）**：`tests/files-service.test.ts`(177)、`files-service-upload.test.ts`(135)、`tests/api/workspace-image.test.ts`(131)、`tests/api/workspace-picker.test.ts`(76)、`tests/lib/file-path.test.ts`(89)、`tests/components/file-viewer-dir.test.tsx`(323，任务书写 300)、`tests/components/chat-image-preview.test.tsx`(78)、`tests/integration/files/ignore-process.test.ts`(31)、`tests/diff-parser.test.ts`(41)、`tests/use-workspace-files.test.ts`(48)。

**跳过**：`src/lib/growth-tree.ts`、`GrowthTree.tsx`、`GitPanel`（归 crosscut / growth 区域）；`MarkdownBlock.tsx`（归 markdown/crosscut，只在第 3 节提问）；pi 内核 `node_modules/@earendil-works/*`（BRIEF 明确不审），只读了 jsdiff 的 `formatPatch` 输出规则用于核对 diff 解析。依据：`.audit-2026-11-13/vitest.log` 显示全量 204 文件 / 1648 用例通过，本区域相关测试均绿。

**结论一览**

| 子功能 | 结论 | 依据文件 |
|---|---|---|
| 目录列举 + 分页 + 排序 | OK-但脆弱（P2-4） | `files-service.ts:198-258`，`FileViewer.tsx:159-189` |
| .gitignore 过滤 / 隐藏文件 | OK（有真断言测试） | `files-service.ts:136-196`，`tests/files-service.test.ts:40-84` |
| @ 引用全量索引 | OK-但脆弱（P2-5 大仓库失败；P3 分页/口径） | `files-service.ts:108-128`，`useWorkspaceFiles.ts` |
| 文本预览：二进制判定 / 截断 / 编码 | **有问题 P1-1** | `files-service.ts:267-303`，`text-sanitize.ts:5-11` |
| 受保护图片 / SVG / 内容嗅探 | OK（SVG 有 sandbox CSP + 拒绝 DOCTYPE/ENTITY，测试覆盖扎实） | `files-service.ts:305-379`，`api/files/route.ts:11-21`，`tests/api/workspace-image.test.ts` |
| 图片预览入口（UI） | 功能缺口 P3-1（工作区图片点开只说「二进制文件」） | `FileViewer.tsx:573-574`，`i18n.tsx:186` |
| 页签 / 快捷打开 / 目录兜底 | OK（竞态与迟到响应都有测试） | `useFileViewer.ts`，`FileViewer.tsx:159-297`，`tests/components/file-viewer-dir.test.tsx` |
| 整文件 diff（变更页） | **有问题 P2-1（无 hunk 时谎报无事）** | `FileViewer.tsx:269-288`，`growth-service.ts:882-891` |
| unified diff 解析 | OK-但脆弱（P3-4 八进制路径；CRLF/无换行结尾已正确） | `DiffView.tsx:18-77`，`tests/diff-parser.test.ts` |
| FullDiff 虚拟滚动 / 高亮缓存 | OK-但脆弱（P3-3 缓存不含语言） | `FullDiff.tsx:102,152-163` |
| 变更感知（外部改动） | **有问题 P2-2（无刷新入口，关掉再开仍是旧内容）** | `FileViewer.tsx:192-297`，`useGrowth.ts:303-328` |
| 目录选择器 / `/api/fs` | OK-但脆弱（P3-7 无分页、无超时、无根限制） | `api/fs/route.ts`，`DirectoryPicker.tsx` |
| 上传附件（拖拽/流式/清理） | OK（边界、截断、防覆盖都有测试） | `files-service.ts:381-531`，`tests/files-service-upload.test.ts` |
| 资源变更指纹 | OK-但脆弱（P2-6 被图片请求放大成同步全量扫描） | `resource-fingerprint.ts`，`pi.ts:373-395` |

## 1. 发现（按严重度降序，同级按影响降序）

### P1-1 非 UTF-8 文本：UTF-16 直接判成「二进制」，GBK 静默乱码，两者都没有任何提示
- **位置**：`src/lib/files-service.ts:291-302`（判定与解码都在这里）；`src/lib/text-sanitize.ts:5-11`（只处理 UTF-8 截断边界）
- **证据**：
```ts
const preview = utf8Prefix(buffer.subarray(0, bytesRead), MAX_READ_BYTES);
// 只检查预览范围，绝不为识别二进制而加载整个大文件
if (preview.includes(0)) {
    return { path: toRel(root, real), binary: true, truncated: false, content: "" };
}
const truncated = stat.size > MAX_READ_BYTES || bytesRead > MAX_READ_BYTES;
return {
    path: toRel(root, real),
    binary: false,
    truncated,
    content: preview.toString("utf8"),
}
```
- **触发路径**：文件树/快捷打开 → `FileViewer` 取数据 → `GET /api/files?read=1&cwd=&path=` → `readWorkspaceFile`。用户在 Windows 上用记事本「Unicode 编码」保存的 `.txt/.ps1/.ini`，或历史遗留的 GBK 源码（中文项目里常见）都会走到这里。
- **后果**：1）UTF-16LE/BE（含 BOM）文本，每隔一个字节就是 `0x00`，`preview.includes(0)` 命中 → 界面显示 `t.fileBinary`「二进制文件，不提供预览」（`i18n.tsx:186`），用户无法查看，也无法区分「这真的是二进制」还是「编码不认识」；2）GBK/Big5 文本没有 NUL，`toString("utf8")` 把非法序列替换成 U+FFFD，界面把一整篇乱码当正常内容渲染，**没有任何「编码可能不对」的提示**；3）UTF-8 BOM 不会被剥掉，正文首字符是一个零宽 U+FEFF（对比 `resource-fingerprint.ts:38` 是剥 BOM 的，口径不一致）。
- **置信度**：已确认（代码路径可证；无运行时验证，因为需要构造非 UTF-8 文件，本次审计只读）。仓库内 `scripts/ tests/ src/ bin/ docs/ examples/` 扫过一遍，当前没有 UTF-16 BOM 文件，所以现有测试一条都碰不到这个分支。
- **建议修法**：在 `readWorkspaceFile` 里先按 BOM 判编码（`EF BB BF` 剥掉；`FF FE`/`FE FF` 用 `utf16le`/手工交换字节解码），无 BOM 时先严格 `TextDecoder("utf-8",{fatal:true})` 试解，失败再判二进制，并把「编码不受支持」作为 `FilePreview` 的一个字段（例如 `encoding: "utf-8" | "utf-16le" | "unknown"`）交给 UI 显示，别用 `includes(0)` 当唯一判据。

### P2-1 纯重命名 / 空文件 / 只改权限的「变更」页会显示「这一范围内此文件没有变化」+ 整篇正文
- **位置**：`src/components/FileViewer.tsx:281-287`；patch 来源 `src/lib/growth-service.ts:887`
- **证据**：
```ts
const lines = parseUnifiedDiff(data.patch);
if (!lines) {
    await snapshotContent(range.to, "nochange");
    return;
}
done({ diff: lines, truncated: data.truncated, notice: change.status === "D" ? "deleted" : null });
```
```ts
const r = await shadow(ws, ["diff", "-M", "--no-color", "--no-ext-diff", "-U1000000", assertHash(from, "from"), assertHash(to, "to"), "--", ...paths]);
```
- **触发路径**：Agent 用 `git mv`/写出同名不同路径完成一次纯重命名（内容 100% 相同）→ 本轮 commit 的 `changes` 里有一条 `status:"R"`（`growth-service.ts:412-419`）→ 用户点该文件，`mode` 自动选 `diff`（`FileViewer.tsx:145` 因为 `change` 存在）→ `parseUnifiedDiff(patch)`。git 对 100% 相似度的重命名只输出 `diff --git` / `similarity index 100%` / `rename from` / `rename to`，**没有 hunk** → `parseUnifiedDiff` 返回 `null`（`:76` 要求至少一条 add/del/ctx）→ 落进 `snapshotContent(range.to, "nochange")`，notice 显示 `t.viewerNoChanges`「这一范围内此文件没有变化」（`i18n.tsx:995`）。
- **后果**：用户明确知道本轮「重命名了 1 个文件」，点进去却被告知"此文件没有变化"，看到的是整篇正文（无红无绿）。同样的坑还有：新增一个 0 字节文件（`new file mode` 无 hunk）、`chmod +x`（只有 `old mode/new mode`），都报"没有变化"。这是可复现的、语义相反的结论，不是样式问题。
- **置信度**：已确认（读了完整链路 + git 输出规则；未跑 git 验证，但 `parseUnifiedDiff` 对无 hunk 输入返回 null 有测试 `tests/diff-parser.test.ts:36-40`）。
- **建议修法**：`filePatch` 里识别「无 hunk 但存在 `rename from/to` 或 `new file mode`/`old mode`」并在返回值加一个 `notice: "renamed" | "mode" | "empty"`；或前端在 `lines === null` 时先看 `change.status`：`R` 显示「重命名为 …（内容未变）」，`A` + 0 字节显示「新增空文件」。

### P2-2 查看器没有刷新入口，且关闭再打开仍是旧内容——外部改动 / 本轮未提交改动都会被静默当成最新
- **位置**：`src/components/FileViewer.tsx:192-297`（取数据 effect 的依赖与缓存策略）；对照 `src/hooks/useGrowth.ts:303-328`（目录只在有新 commit 时重拉）
- **证据**：
```ts
}, [activeTab, cwd, mode, range, change, growth.rounds, growth.selected, t.viewerLoadFailed]);
```
（`state.open` 不在依赖里；组件在 `!state.open` 时只是 `return null`（`:383`），实例与 `loaded`/`dirPage` 状态都保留。）
```ts
// 磁盘目录只在提交了新的一轮时重拉，不用每次渲染都重拉一遍全部目录
const diskPulse = latest?.commit ?? "";
```
- **触发路径**：用户在查看器里看着 `src/x.ts`（内容模式 = 所选 round 的 tree 内容）→ agent 继续改这个文件（本轮尚未 commit），或用户在本机 VS Code 里改 → 切回 PiWeb：`growth.rounds` 没变、`activeTab` 没变 → 不重取；关掉查看器再打开，`loaded` 还是旧的那份 → 仍然旧内容。全局搜索确认无文件监听：`grep "fs.watch|watchFile|chokidar"` 在 `src/` 下 0 命中。
- **后果**：界面把「上一轮 commit 的内容」当成本文件当前内容展示，且没有任何「可能已过期」的标记；`notice` 只会是 `null`/`disk`/`historical`，没有 stale。用户看代码、复制片段、据此判断「agent 到底改成什么样了」都会被误导。唯一的隐式刷新是「再点一次同一文件」（`open()` 每次都造新 tab 对象 → `activeTab` 身份变化 → 重跑 effect；`read=1` 不缓存所以能拿到新内容）和「切换模式」，但界面上没有任何提示。
- **置信度**：已确认（读了取数据 effect、关闭逻辑、`useGrowth` 刷新条件、并确认全仓无 watcher）。
- **建议修法**：最小改动：工具条加一个刷新按钮（`forceReload` 计数器进 effect 依赖）；把 `state.open` 进依赖（关闭即丢弃 `loaded`，重开必重取）；内容模式在 `growth.fresh`/pending 非空时挂一条「工作区有未提交改动，当前显示第 N 轮快照」的提示条。

### P2-3 模块级 `fetchCache` 长期持有最多 200 份响应，其中包含整文件 patch（单份上限 4 MB），浏览器内存可涨到数百 MB
- **位置**：`src/components/FileViewer.tsx:29-50`（缓存定义与淘汰），调用点 `:235,:249,:274`
- **证据**：
```ts
const fetchCache = new Map<string, Promise<unknown>>();
...
function cachedJson<T>(url: string): Promise<T> {
	let p = fetchCache.get(url) as Promise<T> | undefined;
	if (!p) {
		p = requestJson<T>(url);
		p.catch(() => fetchCache.delete(url));
		fetchCache.set(url, p);
		if (fetchCache.size > 200) fetchCache.delete(fetchCache.keys().next().value as string);
	}
	return p;
}
```
- **触发路径**：`/api/growth?...&path=` 的 patch 响应走 `cachedJson`；`growth-service.ts:29` `MAX_PATCH_BYTES = 4MB`，而 `filePatch` 用 `-U1000000`（整文件上下文），所以一份 patch 就约等于整个文件大小。用户在几个大文件之间来回看「变更」，或打开的页签多，URL 里 `from/to/path` 各不同 → 200 条互不相同的条目常驻。
- **后果**：这是 `Map` 里的 `Promise<unknown>`，解析后的对象（`patch` 字符串）被 promise 引用着，**永不释放**（模块作用域，关闭查看器也不清）。最坏 200 × 4 MB ≈ 800 MB 字符串常驻一个浏览器标签页，手机上会直接被系统杀掉页面。淘汰策略是 FIFO 而非 LRU/按字节，且只按条数不按体积。
- **置信度**：已确认（细节：patch 是 `string`，`parseUnifiedDiff` 又按行切出 `DiffLine[]` 副本，实际占用还要翻倍）。最大未知是真实文件大小分布——见第 4 节。
- **建议修法**：给缓存加 TTL（例如 30 s）+ 按累计字符数上限（例如 8 MB）淘汰，并只缓存 `content=1`（256 KB 档），`-U1000000` 的 patch 不缓存（它本来就是内容寻址、可重取）。

### P2-4 目录分页只压缩了响应体，服务端仍把整个目录读进内存、排序、并把**所有**名字塞给 `git check-ignore`
- **位置**：`src/lib/files-service.ts:212-244`（尤其 `:241`）；相关注释 `:141-145`
- **证据**：
```ts
const raw = await fs.readdir(real, { withFileTypes: true });
...
entries.sort((a, b) => { ... });
const relForIgnore = path.relative(root, real).replace(/\\/g, "/");
const ignored = await ignoredNames(root, relForIgnore, entries.map((entry) => entry.name));
const visible = ignored.size ? entries.filter((entry) => !ignored.has(entry.name)) : entries;
const nextOffset = offset + MAX_ENTRIES < visible.length ? offset + MAX_ENTRIES : null;
const page = visible.slice(offset, offset + MAX_ENTRIES);
```
而 `checkIgnore` 的注释写的是「条目多时命令行会超长，所以走 stdin 不走参数（单页最多 2000 条）」——实际传的是**整个目录**的条目，不是单页。
- **触发路径**：打开一个条目数超过 `MAX_ENTRIES`(2000) 的目录。`node_modules`、`.next` 这类被 ignore 的目录根本进不到列表，但**没有被 ignore 规则覆盖**的大目录会走到这里：已提交的生成物、`public/` 下的素材/图标目录（本仓库 `public/file-icons` 就有 300+ 个 svg）、日志/上传/导出目录、`.git`（本仓库的测试明确要求 `.git` 出现在列举结果里，`tests/files-service.test.ts:63-64`）。另外 `expandLazy` 对任意目录都会 `for(;;)` 翻页直到 `nextOffset === null`（`useGrowth.ts:131-142`），等于把整个目录全部拉一遍。
- **后果**：10 万条目的目录 → 服务端一次 `readdir` + 全量 `localeCompare` 排序 + 约 10 万条路径（数 MB）写入 git 子进程 stdin；每个分页请求都重复一次完整工作（`/api/files` 会被 `listDiskEntries` 逐页调用）。手机远程访问时表现为「点进目录转很久」，并伴随多次 git 进程。
- **置信度**：已确认（代码可证；未做基准测试）。
- **建议修法**：先对 `raw` 做「名字取自排序后数组的页切片」，只把该页的名字送 `check-ignore`（ignore 判定是逐条目独立的，可以按页做）；或至少在名字数 > 5000 时跳过 ignore 过滤并在响应里标出，避免为隐藏少数条目付全量代价。

### P2-5 超大仓库 `git ls-files` 超过 64 MB `maxBuffer` 时整个 @ 引用索引 500，没有兜底
- **位置**：`src/lib/files-service.ts:112-127`
- **证据**：
```ts
const { stdout } = await exec(git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
    ...
});
...
} catch (error) {
    const failure = gitIndexFailure(error);
    if (failure !== "fallback") throw failure;
```
`gitIndexFailure`（`:94-102`）只把 `ENOENT` 和 `not a git repository` 当 fallback；maxBuffer 溢出抛出的错误 `code` 不是 ENOENT、stderr 为空 → 走到 `return new Error(...)` → 路由 500。
- **触发路径**：`monorepo`/`node_modules` 被 -f 加入索引的仓库，路径清单 > 64 MB（约 30 万文件 × 平均 25 字节 → 7.5 MB，需 ~250 万文件；或超长路径），或 15 s 超时（`e.killed` → `git ls-files timed out`）。此时 `Ctrl/⌘+P` 快捷打开与 `@` 候选整体报错。
- **后果**：功能在超大仓库上从「候选被截断（已设计 truncated 提示）」退化成「完全不可用 + 错误横幅」；而且这个错误没有回退到 `walkWorkspaceFiles`（磁盘遍历），用户没有可用替代路径，只有手打路径能打开文件。
- **置信度**：已确认代码路径；阈值是否会被真实仓库触发属疑似（需要 250 万+ 文件或 15 s 以上 git 时间）。
- **建议修法**：给 `git ls-files` 换流式收集（`spawn` 累加 chunk，读满 `INDEX_LIMIT` 后 kill）或把 `maxBuffer` 提到 256 MB 并在溢出时降级为 disk walk + `truncated: true`（配合 UI 已有提示）。

### P2-6 技能文档里每张受保护图片都触发一次**同步全量资源指纹扫描**（阻塞事件循环）
- **位置**：调用链 `src/lib/files-service.ts:338-340` → `src/lib/prompt-sources.ts:227-233`（`listPromptSources`）→ `:185` `refreshResourceLoaderIfStale` → `src/lib/pi.ts:388-395` → `:373-377` → `src/lib/resource-fingerprint.ts:13-188`（全量 `lstatSync`/`statSync` 递归）
- **证据**：
```ts
if (sourcePath) {
    const { resolvePromptSourcePath } = await import("./prompt-sources");
    real = await resolvePromptSourcePath(target, root, sourcePath);
}
```
```ts
export async function resolvePromptSourcePath(filePath: string, cwd: string, sourcePath?: string): Promise<string> {
	const { sources } = await listPromptSources({ cwd });
```
```ts
export async function refreshResourceLoaderIfStale(cwd: string): Promise<boolean> {
	await resourceLoaderReady(cwd);
	...
	if (resourceFingerprint(cwd) === entry.fingerprint) return false;
```
`resourceFingerprint` 内部 `rulesFor`/`entries`/`stamp` 全部是 `fs.*Sync`。
- **触发路径**：技能文档（`staticContent` 页签，带 `sourcePath`）在「渲染」模式里含 N 张本地图片 → 浏览器对 N 个 `<img src="/api/files?image=1&…&sourcePath=…">` 并发发请求 → 每个请求都走一遍 `listPromptSources`（含 `refreshResourceLoaderIfStale` → 一次同步全树指纹）。
- **后果**：`resourceFingerprint` 会扫 `agentDir`、项目 `.pi/`、各 ancestor 的 `.agents/skills`、`HOME/.agents/skills`、`packageRoots`（含 `node_modules` 里的包），以及 `loader` 报上来的所有来源。典型机器上单次是几毫秒到几十毫秒，但它是**同步**的，直接占住 Node 事件循环；N 张图串行放大 N 倍，且与其它请求（SSE 流、agent 执行）抢同一条线程。技能目录落在 `node_modules` 里时更贵。
- **置信度**：已确认调用链；量化影响疑似（取决于机器上的技能/扩展数量，未跑基准）。
- **建议修法**：`readWorkspaceImage` 在 `sourcePath` 分支里给 `listPromptSources` 结果加一个按 cwd 的短 TTL 缓存（例如 2 s，与 `refreshResourceLoaderIfStale` 的节流配合）；或让 `resolvePromptSourcePath` 走一个同步快路径（只 realpath 校验 source 与 skill 根，不重扫全量来源）。

### P3-1 工作区里的图片在文件树里点开只会显示「二进制文件」——受保护 image 端点没有接进查看器
- **位置**：`src/components/FileViewer.tsx:573-574`；能力在 `src/lib/files-service.ts:328-379` + `src/app/api/files/route.ts:11-21`
- **证据**：
```tsx
) : loaded.binary ? (
    <div className="flex min-h-0 flex-1 items-center justify-center" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.fileBinary}</div>
```
全仓 `grep "image=1"` 只有两处消费：`chat/file-path.ts:80-85`（Markdown 图片）和测试。`FileViewer` 没有任何图片分支。
- **触发路径**：项目栏/目录页签里点 `assets/logo.png` → `read=1` → `matchesImageType` 前先 `includes(0)` 判成 binary → 显示「二进制文件，不提供预览」。
- **后果**：后端已经有一整套带边界校验、内容嗅探、20 MB 上限、sandbox CSP 的图片通道，但查看器自己不用；用户在文件树里无法预览工作区图片（只能通过 Markdown 渲染里的 `![]()`）。顺带：`IMAGE_TYPES` 缺 `.tif/.tiff`、`.heic`、`.jfif`，这些"图片"一律「unsupported image type」。
- **置信度**：已确认（读了 FileViewer 全部分支 + grep 全部 `image=1` 消费点）。
- **建议修法**：`Loaded` 增加 `image?: { mimeType }`；`readWorkspaceFile` 命中 `IMAGE_TYPES` 扩展名时返回 `{ image: mime }`，前端 `<img src="/api/files?image=1&…">`；顺手补 3 个扩展名。

### P3-2 代码正文的行号栏比正文多一行（凡是以换行结尾的文件），空文件显示「1」
- **位置**：`src/components/FileViewer.tsx:69-75`
- **证据**：
```tsx
const lines = content.split("\n").length;
const gutterWidth = `${String(lines).length + 1}ch`;
...
<pre aria-hidden className="flex-none select-none ...">{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre>
```
- **触发路径**：打开任意以 `\n` 结尾的文件（绝大多数）。`"a\nb\n".split("\n").length === 3`，但 `<pre>` 里的正文是 2 个可视行（行尾换行不产生额外行盒），行号栏却渲染 "1\n2\n3" 三行。
- **后果**：底部多出一个没有对应内容的行号；空文件（`content === ""`）行号栏显示「1」而正文空白。不影响上方对齐与复制（行号栏是 `select-none` + `aria-hidden`）。
- **置信度**：已确认（HTML `<pre>` 尾随换行不产生额外行盒是浏览器行为；未在浏览器里实测）→ 更准确说是「疑似（需目视一次）」，修法本身无害。
- **建议修法**：`const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;`（正文的分段也要跟着用同一个值，或干脆用 `\n` 计数）。

### P3-3 `FullDiff` 的单行高亮缓存以「行文本」为键，不含语言——切页签后同文本的行沿用上一种语言的着色
- **位置**：`src/components/FullDiff.tsx:102,154-163`；父组件不换实例 `src/components/FileViewer.tsx:575-576`
- **证据**：
```ts
const cache = useRef(new Map<string, string | null>());
...
const html = (text: string): string | null => {
    if (!canHighlight || !text.trim()) return null;
    const k = text;
    const cached = cache.current.get(k);
    if (cached !== undefined) return cached;
    const h = highlightLine(text, language!);
```
- **触发路径**：`ts` 文件的 diff 里有一行 `return 0;`（被缓存成 TypeScript 高亮）→ 切到 `py` 文件的 diff：`lines` 变、`useEffect` 只重置了 `unfolded`，`cache` 不动，`language` 也没进键 → 同一行文本直接复用旧 HTML。
- **后果**：跨语言切换后个别行着色错误（如 Python 的 `return` 用了 TS 的 token 规则）。纯视觉，读代码时可能造成微小误判。
- **置信度**：已确认（React 复用同一位置的组件实例；`FileViewer` 不按 path 加 `key`）。
- **建议修法**：`useEffect(() => cache.current.clear(), [language])`，或键改成 `${language}\u0000${text}`。

### P3-4 `parseUnifiedDiff` 还原不了 git 的八进制转义路径（多文件 diff 的文件头显示乱码）
- **位置**：`src/components/DiffView.tsx:27-31`
- **证据**：
```ts
const headerPath = (row: string) => {
    const value = row.slice(4).split("\t")[0];
    if (!value.startsWith('"')) return value;
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
};
```
- **触发路径**：`core.quotePath` 默认 true，非 ASCII 路径在 patch 头里是 C 风格八进制转义，例如 `"a/\344\270\255.ts"`。`JSON.parse` 不接受 `\3` 这种转义 → 抛错 → 走 `slice(1,-1)`，返回仍带 `\344\270\255` 的字符串。
- **后果**：多文件 patch 的文件名行显示 `a/\344\270\255.ts`，并且 `languageForPath(l.text)` 拿到错误扩展名 → 该文件所有行不按语言高亮。当前**在本区域不可见**（`FileViewer` 的 `FullDiff` 会跳过 `kind:"file"` 行，`FileViewer` 送的是单文件 patch），影响面在 Git 面板的多文件 diff（`grep` 显示 `DiffView` 被 GitPanel/提交内容复用）。所以它在我的区域是"上游正确性"，落地在 crosscut/git 区域。
- **置信度**：已确认（git 的引用规则 + `JSON.parse` 语义）；触发需要非 ASCII 路径的多文件 diff。
- **建议修法**：加一个 C 字符串还原函数：把 `\\([0-7]{3})` 转成字节再 `Buffer.from(bytes).toString("utf8")`，`\"`/`\\`/`\t`/`\n` 单独处理；还原失败再退回 `slice(1,-1)`。

### P3-5 `parseCheckIgnore` 把反斜杠当路径分隔符替换，POSIX 上文件名含 `\` 时 ignore 过滤失效（fail-open）
- **位置**：`src/lib/files-service.ts:136-139`（配合 `:184-195`）
- **证据**：
```ts
export function parseCheckIgnore(raw: string): string[] {
	return raw.split("\u0000").filter(Boolean).map((entry) => entry.split("\\").join("/"));
}
```
- **触发路径**：Linux/macOS 上存在名字含反斜杠的文件（合法字符），且被 ignore 规则命中。git 原样回显 `a\b` → 解析成 `a/b` → 与目录里的名字 `a\b` 不相等 → 该条目不被隐藏。
- **后果**：只是"该隐藏的没隐藏"（fail-open，不藏用户文件），与本文件的"宁可多显示"原则一致，所以不是安全问题；但 `parseCheckIgnore` 也被 `readWorkspaceImage`（`:354`）用来**拒绝**被忽略的图片，那里是 fail-open 反面（本该 400 的变成 200 通过）——同样不构成越权（还是在工作区内）。
- **置信度**：已确认（Windows 上 git 已输出 `/`，所以只在 POSIX 触发）。
- **建议修法**：只在 `process.platform === "win32"` 时把 `\` 换成 `/`，或比较时对两侧做同样的归一化。

### P3-6 `read=1` 与 `image=1` 的可见性口径不一致：文本能读 gitignore 掉的文件，图片直接 400
- **位置**：`src/lib/files-service.ts:267-303`（无 ignore/.git 校验）对比 `:347-359`（有 `.git` + `git check-ignore` 校验）
- **证据**：`readWorkspaceImage` 里
```ts
if (rels.some((rel) => rel.split("/").includes(".git"))) throw new BoundaryError("image is not a visible workspace file");
try {
    const ignored = await checkIgnore(root, await resolveGitBin(), rels);
    if (parseCheckIgnore(ignored).length) throw new BoundaryError("image is ignored by the workspace");
```
`readWorkspaceFile` 里没有任何对应逻辑。
- **触发路径**：文档里引用一张被 `.gitignore` 忽略的图（例如 `docs/screenshots/` 被忽略但 README 引用了它，或 `dist/` 里的图）→ 渲染模式下图片 400，界面是坏图；而同一路径改成文本查看却能看到内容。
- **后果**：1）Markdown 渲染时被忽略目录里的图片一律加载失败（有测试固化这个行为：`tests/api/workspace-image.test.ts:76-82`，说明是**有意**的）；2）口径不一致本身会让人困惑：树里看不到、图片不加载、但"已知路径"的文本能读。第三个后果是安全叙事上的：`read=1` 实际上是「工作区内任意文件可读（含 `.git/config`、`.env`、被忽略的密钥文件）」，而目录树故意隐藏它们。附带一处同类不一致：`.git` 在「文件」树里被 `useGrowth.diskNodes` 的 `HIDDEN_DISK_DIRS` 挡掉（`useGrowth.ts:108-112`），但在查看器的目录页签里**照常列出**（`listWorkspaceDir` 不过滤 `.git`，测试 `files-service.test.ts:63-64` 明确断言它会出现在条目里），点进去就能读 `.git/config`。图片端点专门拒绝 `.git`（":351 注释 image is not a visible workspace file"），文本端点却没有——同一份"`.git` 不可见"的意图只落实了三分之一。（注：这**不构成额外越权**，因为 `read=1` 本来就按任意 `cwd` 可读全盘，见第 3 节第 1 条。）
- **置信度**：已确认（两侧代码与测试对照）。
- **建议修法**：明确取舍并写进注释：要么 `read=1` 也拒绝 `.git`/被忽略文件（一致性 + 密钥不外泄），要么图片也放开同样的可见性；当前这种"一半一半"最容易被当成漏洞报告。

### P3-7 `/api/fs`：无分页（>2000 子目录不可达）、26 个盘符并发探测无超时、且没有工作区根限制
- **位置**：`src/app/api/fs/route.ts:33-51`（盘符探测）、`:93-94`（截断）；`src/components/DirectoryPicker.tsx:168-172`（只显示"已截断"）
- **证据**：
```ts
const drives = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
const present = await Promise.all(drives.map(isDirectory));
return drives.filter((_, i) => present[i]).map((drive) => ({ name: drive, path: drive }));
```
```ts
entries: entries.slice(0, MAX_ENTRIES),
truncated: entries.length > MAX_ENTRIES,
```
- **触发路径**：Windows 上有离线网络盘/未插卡的读卡器映射盘时，`fs.stat` 会等 SMB 超时（十几秒到一分钟），`Promise.all` 要等最慢的那一个，`roots` 请求整体挂住，选择器一直「加载中」；没有 `Promise.race` 超时。目录 > 2000 个子目录时，第 2001 项之后**没有任何办法选到**（无 offset 参数、UI 无翻页）。
- **后果**：1）远程手机打开目录选择器可能白等很久；2）超大目录里靠后的子目录在 UI 上不可达（只能手输路径，而选择器没有手输框）；3）`POST {action:"list"}` 对任意绝对路径都列目录（设计如此：选择器需要浏览全盘），任何持有效会话的客户端都能枚举主机文件系统——这一点属 API/鉴权区域裁定，见第 3 节。
- **置信度**：已确认代码；挂起时长与 2000 项不可达属"代码可证"，未实测。
- **建议修法**：盘符探测包一层 `Promise.race`（每个 800 ms 视为不存在）；`listDirectory` 支持 `offset` 并在 `DirectoryPicker` 加「更多」按钮（`listWorkspaceDir` 已有现成实现可照抄）。

### P3-8 没有「复制全文」「下载」，diff 复制丢 `+`/`-` 标记
- **位置**：`src/components/FileViewer.tsx:509-531`（工具条只有：折叠 / 上一处 / 下一处 / 引用 / 编辑器）；`src/components/DiffView.tsx:132`
- **证据**：
```tsx
<span style={{ color: signColor, userSelect: "none" }}>{num} {sign} </span>
```
- **触发路径**：用户在「变更」页框选一段复制 → 行号和 `+`/`-` 都是 `user-select: none` → 复制出来的文本分不清哪行是新增、哪行是删除；「内容」页想拿走整篇：`read=1` 上限 256 KB（`files-service.ts:32`），超出部分界面上根本没有，且没有下载/复制全部按钮；「在编辑器中打开」是**在服务器本机**弹编辑器（`files-service.ts:538-577`），手机/远程用户点了只会让主机屏幕弹窗，对自己毫无用处。
- **后果**：远程/手机上 > 256 KB 的文件拿不到完整内容（能力上限 + 无出口）；diff 的复制结果语义丢失。这属于"功能缺口"，不是 bug。
- **置信度**：已确认（读了工具条全部分支 + `openInEditor` 的实现语义）。
- **建议修法**：工具条加「复制全文」（`copyText(loaded.content)`，已有 `src/lib/clipboard.ts`）和「下载」（`/api/files?read=1` 加 `&download=1` 走 `Content-Disposition`，或新增流式 range 下载）；diff 复制把 `+`/`-` 做成可选中（或提供"复制为 patch"）。

### P3-9 `sweepUploads` 把「sessions 目录不存在」当成「没有任何会话」，会删掉所有超期附件
- **位置**：`src/lib/files-service.ts:466-489`
- **证据**：
```ts
try {
    sessionFiles = (await fs.readdir(sessionsRoot, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    sessionFiles = [];
}
```
- **触发路径**：`getAgentDir()` 由 `PI_CODING_AGENT_DIR` 决定。若某次运行把 agent 目录指向了一个**新建/空的**目录（dev 与运行态切换、恢复备份、迁移机器），`web-uploads` 与 `sessions` 同根但 `sessions` 可能确实为空/不存在 → 之后任意一次上传触发清理（每天最多一次），超过 30 天且"没有任何 JSONL 提到"的文件会被 `unlink`。
- **后果**：附件是消息里引用的绝对路径，被删后历史会话里的附件链接静默失效（不可恢复，git 也管不到）。当前实现里"读失败就整次放弃"的保护对 ENOENT 不生效。
- **置信度**：疑似（需要 agent 目录被换过、且存在 >30 天的上传；默认路径下 sessions 与 uploads 同根，正常情况不会命中）。
- **建议修法**：`ENOENT` 时也 `return []`（无法证明"没人引用"就不删），或把 `web-uploads` 与 `sessions` 目录存在性一起检查。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| UTF-16LE/BE、UTF-8 BOM、GBK 文本预览 | 目前零覆盖，且是中文环境最常见的"看不到/看到乱码"来源（P1-1） | 三种编码各写一个文件，断言 `binary === false`、`content` 与原文相等（GBK 至少断言返回"编码不受支持"信号而不是静默 U+FFFD） |
| 纯重命名 / 空文件新增 / 仅 mode 变更的 patch | `parseUnifiedDiff` 返回 null 的合法输入，会谎报"没有变化"（P2-1） | 用真 git 仓库造 3 种情况，断言 `filePatch` 返回值带出 rename/mode/empty 语义，UI 不显示"没有变化" |
| 查看器的重取语义 | 关掉再开、外部改动后是否读新内容，全靠隐式行为（P2-2） | jsdom 里：打开→关闭→再打开，断言 `fetch` 被再次调用；外部 `growth.rounds` 不变时断言不会误报"最新" |
| `listWorkspaceDir` 分页与 ignore 同时生效 | 现有分页测试（`files-service.test.ts:15`）目录里没有 .gitignore；ignore 测试（`:40`）目录里没有 >2000 条 | 建 2500 个文件 + 忽略其中 600 个，断言两页拼起来恰好是 1900 个且无重复/遗漏 |
| 符号链接指向工作区外时的目录列举行为 | `listWorkspaceDir` 会把这种链接列成目录（`:226-234`），点进去才 400；只有图片端点测了 junction（`workspace-image.test.ts:57`） | 列举含外部 junction 的目录：断言条目出现（或明确不出现）、点开返回 400 且错误文案可理解 |
| `git ls-files` 超 maxBuffer / 超时 | P2-5 的降级路径完全没有测试 | mock `execFile` 抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，断言走 disk walk 且 `truncated` 为真（或明确 500，但要有测试钉住） |
| `FullDiff` 切换语言后的高亮 | P3-3 | 同一实例先渲染 ts 行再渲染 py 行，断言 `dangerouslySetInnerHTML` 结果按新语言重算 |
| `parseUnifiedDiff` 的八进制路径 / CRLF 内容 / `\ No newline` 组合 | 只有一条 CRLF+引号路径的用例（`diff-parser.test.ts:32`） | 加 `"a/\344\270\255.ts"` 头、文件内容本身含 `\r`、`@@ -1,0 +1,0 @@` 等 |
| `readWorkspaceFile` 的错误映射 | 非 `BoundaryError` 一律 500，且把原始 Node 错误文本（含绝对路径）回给界面（`files-service.ts:276,279` 的 `fs.stat`/`fs.open` 没有 try，`api/files/route.ts:32` 只把 `BoundaryError` 映射成 400） | 无读权限的文件 → 断言 400 与可读文案；`.git/config` 的可见性策略 → 断言与产品决定一致 |

## 3. 与其他区域的可能交叉点

1. **API/鉴权区域**（`src/lib/path-security.ts`、`src/proxy.ts` 归他们）：`/api/files` 与 `/api/fs` 的 `cwd` 参数**只做 `realpath + 必须是目录`**（`path-security.ts:63-73`），不校验它是否在「工作区注册表」里。任何持有效会话的客户端都能 `?read=1&cwd=/home/user&path=.ssh/id_rsa`（256 KB 以内）、能 `/api/fs` 枚举全盘。认证网关我核对过：`proxy.ts` 做 Host/Origin/Cookie 三件事，`/api/files`、`/api/fs` 都不在 `PUBLIC_PATHS`，所以**必须**过认证；但 `authEnabled()` 为假时（我看代码没有强制开启）这些能力对整个网段全开。请 API/鉴权区域裁定：这是不是可接受的"owner 级能力"，还是应该收敛到注册工作区。
2. **sandbox/权限区域**：`readWorkspaceFile` / `readWorkspaceImage` / `openInEditor` 完全不经过 pi 的沙箱读写限制，只做 `isPathInside(realpath)`。两个需要他们确认的点：(a) 工作区内的**硬链接**指向工作区外文件时，realpath 落在工作区内 → 可读（符号链接会被拦住，硬链接不会）；(b) 沙箱若禁止 agent 读工作区外文件，而上传附件固定落在 `~/.pi/agent/web-uploads`（工作区外，`files-service.ts:389`），那消息里的绝对路径引用对受沙箱限制的 `read` 工具是否可用。
3. **bridge 区域**：`@` 引用的拼装。`ChatInput.tsx:456` 是 `refs.map((path) => `@${path}`).join("\n")`，**不带引号**；而 `workspace-index.ts:245-267` 里 pi-tui 的 `extractAtPrefix` 明确支持 `@"带空格 的路径"`。带空格的路径（`docs/my file.md`）会被拼成 `@docs/my file.md`。需要确认 pi 侧对正文里的 `@` 是否做展开/校验（我只读到了自动补全逻辑，没找到展开逻辑），如果只是正文文本则无碍，否则空格会截断引用。
4. **growth 区域**：`filePatch` 用 `-U1000000` 把整文件塞进一份 patch（4 MB 截断），我这边"变更"页的解析成本、以及"无 hunk 时报无事"（P2-1）都源于它；另外纯重命名的语义最好在 `filePatch` 返回结构里表达（`renamed: true`），比前端猜 patch 文本更稳。`readRounds` 只按 commit 产生 `changes`，"本轮未提交改动"在数据层就不可见，这决定了 P2-2 的修法方向。
5. **crosscut 区域**：`GrowthTree` 的 `lazy` / `from` / `revealPath` 语义我只消费未改动；`MarkdownBlock` 负责"渲染"模式的内容净化（我这个区域只确认了图片一律走 `/api/files?image=1`、外部图必须用户点按同意）。
6. **文档/产品决策**：`.gitignore` 掉的文件在文件树里完全不可见（有测试固化），但文本接口可读、图片接口拒绝（P3-6）。这三处口径需要产品拍一次板，否则以后每轮审计都会有人报同一个问题。

## 4. 建议优先修的 3 件事

1. **给文本预览加编码判定**（P1-1）：BOM 剥离 + UTF-16 解码 + 「解码失败」显式提示，别用 `includes(0)` 当唯一判据。这是中文环境下的高频真实故障，改动局限在 `files-service.readWorkspaceFile` 一个函数 + 一个 UI 提示位。
2. **修「变更」页的假阴性**（P2-1）：纯重命名 / 空文件 / 只改权限时不要落到「这一范围内此文件没有变化」。最小改法是在 `filePatch` 返回结构里带出 `renamed`/`mode`/`empty` 标记，前端据 `change.status` 显示对应文案。
3. **刷新与陈旧内容**（P2-2 + P2-3）：给查看器加一个刷新入口、把 `state.open` 纳入重取条件、并给 `fetchCache` 加 TTL 和按字节上限（现在它可能常驻数百 MB 的 patch）。前两条直接影响用户对"agent 改成了什么样"的判断，第三条影响手机端稳定性。

**最大未知点**：真实文件大小/数量分布。P2-3（浏览器内存）、P2-4（目录条目数）、P2-5（`ls-files` 体积）、P2-6（资源树规模）这四条的严重度全靠"典型工作区有多大"决定，我没有任何生产数据（只有本仓库：git 索引若干千条、`node_modules` 被忽略）；需要一次真机采样（比如记录 `/api/files` 各分支的入参分布与耗时 P95）才能把它们排序。第二个未知点：`authEnabled()` 的默认值决定了 `/api/fs` 全盘枚举与任意 `cwd` 读取的实际暴露面，这在 API/鉴权区域手里，不在我的链路里。
