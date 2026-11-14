# 会话导入 / 导出 审计报告

审计员：audit-import　日期：2026-11-13　HEAD：`1d4efba`（按当前磁盘状态）

## 0. 覆盖范围

**读了**（全部逐行读完，非抽样）：

| 区域 | 文件（行数） |
|---|---|
| `src/lib/session-import/` 全部 15 个文件 | `index.ts`(258) `writer.ts`(264) `oc-family.ts`(275) `claude.ts`(262) `dsh.ts`(259) `codex.ts`(223) `types.ts`(171) `grok.ts`(169) `sqlite.ts`(89) `files.ts`(74) `dsh-zstd.ts`(69) `paths.ts`(37) `zcode.ts`(8) `opencode.ts`(7) `limits.ts`(4) |
| API 路由 | `src/app/api/sessions/import/route.ts`(84)、`src/app/api/sessions/[id]/export/route.ts`(37) |
| UI | `src/components/SessionImportSection.tsx`(514) |
| 关联库 | `src/lib/session-reader.ts`(320，全读) `src/lib/atomic-file.ts`(17) `src/lib/chat/task-notification.ts`(13) `src/lib/agent-manager.ts`（仅 `getManaged` 1108–1118、`exportSession` 3119–3136）`src/lib/workspace-store.ts`（190–389：archive/forget/registerCwds）`src/proxy.ts`（鉴权段） |
| 测试 | `tests/session-import-service.test.ts`(332) `session-import-sources.test.ts`(562) `session-import-writer.test.ts`(169) `tests/api/session-import-scan.test.ts`(47) `tests/api/session-export.test.ts`(32) `tests/external-session-write.test.ts`(203) `tests/components/session-import-panel.test.tsx`(435) `tests/components/import-delete-refresh.test.tsx`(101) |

**为核对 PiWeb 调用而读的 SDK/上游代码**（不算审计对象）：`pi-coding-agent/dist/core/session-manager.js:294`（会话目录编码）、`dist/core/export-html/index.js:140-199`（HTML 导出落盘）、`dist/core/export-html/ansi-to-html.js`、`dist/core/export-html/template.js:683-702`（`escapeHtml` / `sanitizeMarkdownUrl`）、`dist/core/agent-session.js:3642-3660`（`exportToHtml` 签名）。

**未读/未做**：没有真正执行导入或删除；没有跑 `npm run build`、没有重启 30141 服务。本机真实数据的结构核对是用**只读方式**做的（复制 SQLite 到 `%TEMP%` 后以 `readOnly` 打开，未碰原库；实测完已把临时目录移入回收站）。

**关键实测数据**（本机，2026-11-13）：`~/.claude/projects` 71 文件 / 280.2MB（最大 42.6MB，35 个主会话）；`~/.codex/sessions` 54 rollout / 231.9MB（22 个主线程）；`~/.grok/sessions` 96 个会话目录；`~/.dsh/sessions` 419 个 `.jsonl.zstd` / 232.8MB / 197 个会话目录；`~/.zcode/cli/db/db.sqlite` **991MB（WAL）**、`~/.local/share/opencode/opencode.db` **1.4GB（WAL）**。

### 结论一览

| 子功能 | 结论 | 依据 |
|---|---|---|
| Claude Code 解析（拆行合并、侧链、合成输入、stop_reason） | OK | `claude.ts` 全读；`tests/session-import-sources.test.ts:69-197` 5 例含并行调用/用量/refusal |
| Codex 解析 | **有问题 P1-1** | `codex.ts:122,129-130`；本机实测 5/22 主会话不出现 |
| Grok 解析 | OK-但脆弱 P3-5 | `grok.ts:73-78`；实测 1/96 缺 `summary.json` 被丢弃 |
| ZCode / opencode 解析（oc-family） | **有问题 P2-4** | `oc-family.ts:157-165`；实测两库 schema/part 类型/用量字段都对得上 |
| dsh 解析（多帧 zstd、tool-call 去重、注入消息） | OK-但脆弱 P2-5 | `dsh.ts` + `dsh-zstd.ts`；实测 31/197 header 无 `cwd` |
| 扫描范围（是否扫家目录、符号链接、深度） | OK | `paths.ts:10-37` 只有 6 个固定根；`files.ts:31-52` 不跟随符号链接 |
| 扫描上限 / 分页 / hasMore | OK | `index.ts:75-99`；`tests/session-import-service.test.ts:74-92` |
| 原生依赖缺失时的降级 | **有问题 P1-2** | `sqlite.ts:20-28` + `oc-family.ts:152-153`；与 `sqlite.ts:8-9` 注释承诺相反 |
| 写入落点 / 不覆盖已有会话 | OK | `writer.ts:240-246`；`tests/session-import-service.test.ts:135-155,259-267` |
| 重复导入幂等（含归档恢复） | OK（性能见 P2-6） | `writer.ts:44-71,107-109`；`tests/session-import-service.test.ts:210-257` |
| 失败回滚 / 半写文件 | OK-但脆弱 P3-1 | `writer.ts:242-246`（临时文件失败不清理、未用 `atomic-file.ts`） |
| 导出 JSONL | OK | `agent-manager.ts:3125-3128` + `route.ts:24-30` |
| 导出 HTML | **有问题 P2-3** | `agent-manager.ts:3129-3135` + SDK `export-html/index.js:193-198` |
| HTML 转义 / XSS | OK（PiWeb 侧不做转义也不引入风险；pi 侧抽查两条主要路径正确） | SDK `template.js:683-702`、`ansi-to-html.js:58-65` |
| 下载文件名 / Content-Disposition（中文名） | OK | `route.ts:11-15`；`tests/api/session-export.test.ts:14-24` |
| Windows / 非 ASCII 路径 | OK-但脆弱 P3-2 | `writer.ts:34-36` 与 SDK `session-manager.js:294` 逐字一致；`\\?\` 为双方共有缺陷 |
| UI 选择 / 搜索 / 全选 / 上限 / 归档恢复 | OK | `SessionImportSection.tsx` 全读；`tests/components/session-import-panel.test.tsx` 20 例 |
| UI 进度与中断 | **有问题 P2-2** | `index.ts:135,247` 定义了 `onProgress` 但 `route.ts:78` 没传；无取消 |
| 删除后刷新（误删防线） | OK | `tests/components/import-delete-refresh.test.tsx`；`api/sessions/[id]/route.ts:28-29` 同时 `forgetSession` |

## 1. 发现

### P0

无。理由：写入路径只能落在 `<agentDir>/sessions/<编码 cwd>/` 内且文件名固定可预测（`writer.ts:34-41` 把 `/ \ :` 全部换成 `-`，`safeId` 过滤非法字符，`cwd` 先 `path.resolve`），不构成任意路径写；导出是读操作；两条 API 都在 `src/proxy.ts` 的鉴权 matcher 内（`PUBLIC_PATHS` 仅 `/login`、`/api/web-auth`、`/pair`，其余 `/api/*` 401）。

### P1-1 Codex 来源按"文件头 64KB 里有没有 response_item"判断会话是否可导入，实测 5/22 个主会话被永久隐藏

- **位置**：`src/lib/session-import/codex.ts:122`、`src/lib/session-import/codex.ts:129-130`，配合 `src/lib/session-import/files.ts:5`
- **证据**：
  ```ts
  // files.ts:5 —— 默认只读 64KB
  export async function readHead(file: string, bytes = 64 * 1024): Promise<string> {
  ```
  ```ts
  // codex.ts:120-130
  let head: string;
  try {
      head = await readHead(file);
  } catch {
      continue;
  }
  const records = [...eachJsonLine(head)].slice(0, 300);
  const meta = metaFrom(records);
  if (meta.subagent) continue; // 主代理派给子代理的活，不算会话
  const hasMessage = records.some((record) => record.type === "response_item");
  if (!hasMessage) continue;
  ```
- **触发路径**：打开"导入会话"面板 → `GET /api/sessions/import` → `scanAllSources` → `codexSource.scan({limit: 51})`。Codex 现在把 `session_meta`（含 `base_instructions`）和一条 `response_item/additional_tools` 写在文件最前面，两者合起来就吃掉 64KB 预算，第一条真正的 `message` 落在 69KB 之后 → 头部一条 `response_item` 都解析不出来（被切断的那行 `JSON.parse` 失败被 `eachJsonLine` 丢掉）→ `hasMessage` 为 false → 直接 `continue`，该会话在面板里根本不存在。
- **后果**：本机实测（只读解析真实 rollout 文件）**22 个主线程 rollout 里有 5 个（23%）不出现**，且 `hasMore` 也只按"已经收集到几条"计算，用户没有任何提示以为"Codex 只有 17 条"：
  ```
  rollout-2026-11-08T13-00-55-01a1b987-…jsonl size=160889 firstMessageByte=69727
     head kinds: session_meta/@0 | event_msg/task_started@22857 | response_item/additional_tools@23357 | response_item/message@69727
  rollout-2026-11-08T13-07-27-01a1b987-…_01a1b98d-….jsonl size=7878031 firstMessageByte=79937
  rollout-2026-11-09T08-39-32-01a1bdbe-…jsonl size=7253565 firstMessageByte=69294
  rollout-2026-11-12T15-50-20-01a1cebc-…jsonl size=1463840 firstMessageByte=69022
  rollout-2026-11-13T00-26-42-01a1d095-…jsonl size=230591 firstMessageByte=69061
  ```
  （顺带：这些会话的 `title` 也取不到，因为 `titleFrom` 同样只看头部 300 条。）
- **置信度**：已确认（代码链路 + 本机真实文件字节级核对；`read()` 那段没有同样的问题，只影响"列不出来"）。
- **建议修法**：codex 别用固定头部判据。最小改动二选一：(a) codex 扫描时 `readHead(file, 512 * 1024)`；(b) 用 `fs.createReadStream` + `readline` 逐行读，直到出现第一条 `response_item`（或读满 N 行/1MB）就停——既不多读，也不受单行超大影响。同时给 `titleFrom` 同样的窗口。

### P1-2 ZCode / opencode / dsh 在原生依赖或源库不可用时**静默返回 0 条**，与代码注释承诺的"只有这两个来源报错"相反

- **位置**：`src/lib/session-import/oc-family.ts:152-153`（`if (!db) return [];`）、`src/lib/session-import/sqlite.ts:20-28`（`openReadOnly` 失败返回 `null`）、`src/lib/session-import/dsh-zstd.ts:50-56` + `dsh.ts:143-148`（zstd 解不开就 `continue`）
- **证据**：
  ```ts
  // sqlite.ts:7-9（注释承诺）
   * `node:sqlite` 是实验特性，所以**按需**动态载入：载不进来（Node 太老）时只有 ZCode/opencode
   * 这两个来源报错，文件类的四个来源照常可用——scanAllSources 会把单来源失败隔离掉。
  ```
  ```ts
  // oc-family.ts:151-155（实际行为：不抛错，返回空数组）
  async scan(scanOptions?: ScanOptions): Promise<ExternalSessionSummary[]> {
      const db = await open();
      if (!db) return [];
      try {
          if (!db.hasTable("session") || !db.hasTable("message")) return [];
  ```
  ```ts
  // sqlite.ts:24-28 —— 覆盖了"文件不存在 / 不是 SQLite / 被占用到无法只读打开"三种情况，全部吞成 null
  try {
      db = new DatabaseSyncClass(file, { readOnly: true });
  } catch {
      return null;
  ```
- **触发路径**：`scanAllSources` 只会把**抛异常**的来源放进 `errors`（`index.ts:92-94`）；`openReadOnly` 返回 `null` 时 `scan()` 正常返回 `[]`。于是 `route.ts:28-38` 的 `errors` 是空的，UI 显示"0 条会话 / 没有找到可导入的本地会话"（`SessionImportSection.tsx:449-450`）。dsh 同构：`readZstdHead` 对非 zstd / 损坏文件返回 `{text:"", complete:false}`，`parseRecords` 拿不到 `header.id` → `continue`，一条错误都没有。
- **后果**：Node 版本/编译差异导致 `node:sqlite` 载不进来、opencode 换了库路径、ZCode 库被独占锁住、dsh 文件被截断——这四种情况在 UI 上都长得和"这台机器没装那个工具"一模一样，用户无法自助排查，且**注释让人以为已经处理了**。同理 `read()` 里 `openReadOnly` 返回 null 只会给出"源会话读不出可导入的消息"（`index.ts:217-219`），看起来像源会话内容坏了。
- **置信度**：已确认（读了 `sqlite.ts` → `oc-family.ts` → `index.ts` → `route.ts` → UI 的完整链路）。触发条件（Node 22.x 上 `node:sqlite` 是否需要 `--experimental-sqlite`）未在本机验证：`package.json` 的 `engines` 是 `>=22.19.0`，本机是 v24.12.0（`node:sqlite` 可用，已实测两个真库都能只读打开、扫描查询 105ms/80ms）。
- **建议修法**：`openReadOnly` 返回 `{ db } | { error }`（或抛错），`oc-family.scan` 在 `!db` 时抛 `new Error("ZCode 库无法只读打开（…）")`，让它走已有的 `errors` 通道；dsh 的 `readZstdHead` 失败同理。

### P2-1 大文件防护在"读完/解完之后"才生效；`200MB` 闸门对 zstd 只约束压缩后体积

- **位置**：`src/lib/session-import/index.ts:152-160`（`oversize`）、`index.ts:39`（`MAX_SOURCE_BYTES`）、`index.ts:220`（`MAX_ENTRIES` 检查在 `read()` 返回之后）、`src/lib/session-import/dsh-zstd.ts:36-38`
- **证据**：
  ```ts
  // index.ts:152-160
  async function oversize(location: string): Promise<boolean> {
      if (location.includes("|")) return false;   // SQLite 位置直接放行
      try {
          return (await fs.stat(location)).size > MAX_SOURCE_BYTES;
  ```
  ```ts
  // index.ts:217-221 —— 先完整 read 进内存，再判断条数
  const session = await IMPORT_SOURCE_MODULES[source].read(summary);
  if (!session) { … } else if (session.entries.length > MAX_ENTRIES) {
      outcome.reason = `消息过多（${session.entries.length} 条），已跳过`;
  ```
  ```ts
  // dsh-zstd.ts:36-38 —— 200MB 的 .zstd 会在这里被整体解压进内存（无输出上限）
  export async function readZstdJsonl(file: string): Promise<string> {
      return decodeZstdFrames(await fs.readFile(file)).toString("utf8");
  ```
- **触发路径**：`POST /api/sessions/import` 带 `{source:"dsh", externalId:"session-…"}`（externalId 可从 GET 面板拿到）→ `importSessions` → `oversize` 只看压缩文件 ≤200MB 就放行 → `readZstdJsonl` 把整份解压并 `Buffer.concat` → `parseRecords` 再 `split("\n")`。`claude`/`codex`/`grok` 同理：`fs.readFile` 成 200MB 字符串 → `split("\n")` 复制成行数组 → `lines.join("\n")` 输出再复制一份。
- **后果**：一条 200MB 的 zstd 解压后可达 GB 级，Node 进程 OOM 会被整个杀掉——不只是这次导入失败，**同进程里所有会话（含正在跑的 agent 轮次）一起挂**。`MAX_ENTRIES` 此时也来不及拦。本机没有超过 200MB 的会话（claude 最大 42.6MB、dsh 最大 17.2MB），所以是"边界条件"，但闸门本身量错了对象。
- **置信度**：已确认（读了代码路径）；未实际触发 OOM（不作运行验证）。
- **建议修法**：`decodeZstdFrames` 支持"最多解出 N 字节"并在超限时抛错；`MAX_ENTRIES` 前移进 `read()` 的循环（每 1000 条检查一次并中止）；`oversize` 对压缩来源按"压缩比上限 × 压缩体积"估一个解压上限。

### P2-2 导入一次就会把该来源**全量重扫**进内存，且没有超时/进度/取消

- **位置**：`src/lib/session-import/index.ts:169-181`（`resolveSummary` 用 `limit: 0` 且**没有** `withTimeout`）、`src/lib/session-import/dsh-zstd.ts:47-48`（`readZstdHead` 也是整文件读）、`index.ts:135,247`（`onProgress` 从未被调用）、`src/app/api/sessions/import/route.ts:78`
- **证据**：
  ```ts
  // index.ts:169-181
  let cache = scanned.get(source);
  if (!cache) {
      const module = IMPORT_SOURCE_MODULES[source];
      if (!module) return undefined;
      cache = new Map();
      // limit: 0 = 不限 …
      for (const summary of await module.scan({ limit: 0 })) cache.set(summary.externalId, summary);
  ```
  ```ts
  // route.ts:78 —— 没有 onProgress
  const report = await importSessions(selection, { agentDir: getAgentDir(), fallbackCwd: typeof fallbackCwd === "string" ? fallbackCwd : undefined });
  ```
- **后果**：代价极不对称。本机一次 dsh 导入 = 整读 **419 个文件 / 232.8MB**（`readZstdHead` 对每个候选文件都 `fs.readFile` 全量读，只为解前 40 帧）+ 逐个解压；而 claude/codex/grok 走 `readHead` 只读 64KB/文件（71 + 54 + 96 个文件 ≈ 14MB），代价可以忽略。另外 `scanAllSources` 里那个 `SCAN_TIMEOUT_MS = 30_000` 的 `withTimeout` **只保护扫描接口，不保护导入接口**：`resolveSummary` 完全没有超时。UI 侧只有一个转圈（`SessionImportSection.tsx:507-510`），`importInFlight` 期间所有按钮禁用，**无法取消**（`importSessions` 没有 abort 入口），浏览器断开也不会停。
- **置信度**：已确认（代码 + 上表实测体积）。耗时未实测（不跑导入）。
- **建议修法**：`resolveSummary` 复用 `withTimeout`；按 id 反查时给来源加上"只扫最近 N 条 + 全量兜底"或让 `scan` 支持 `id` 过滤（文件类来源可以直接 stat 对应文件）；把 `onProgress` 接到 `ReadableStream` 或 SSE 上，并加 abort signal。

### P2-3 HTML 导出把临时文件写在**服务进程的 CWD（仓库根）**，同名并发会互相踩，失败不清理

- **位置**：`src/lib/agent-manager.ts:3129-3135`（调用方没传 `outputPath`），落盘逻辑由 SDK 决定：`node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js:193-198`
- **证据**：
  ```ts
  // agent-manager.ts:3129-3135
  const session = await ensureSession(m);
  // exportToHtml 返回的是写入磁盘的路径，不是内容；读回后删掉临时副本
  const outPath = await session.exportToHtml();
  const { readFile, rm } = await import("node:fs/promises");
  const content = await readFile(outPath, "utf8");
  await rm(outPath, { force: true }).catch(() => undefined);
  ```
  ```js
  // SDK export-html/index.js:193-198 —— 不传 outputPath 时按会话 basename 生成相对路径，writeFileSync 相对 process.cwd()
  let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
  if (!outputPath) {
      const sessionBasename = basename(sessionFile, ".jsonl");
      outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
  }
  writeFileSync(outputPath, html, "utf8");
  ```
  （SDK 里 `exportToHtml` 的注释写的是 "defaults to session directory"，实际是 CWD——这也是个容易踩的坑。）
- **触发路径**：`GET /api/sessions/<id>/export?format=html` → `getManaged` → `exportSession(m,"html")` → `session.exportToHtml()`。
- **后果**：(1) 同一个会话被并发点两次下载（或两个标签页）→ 两个请求写同一个 `pi-session-<basename>.html`：A 读的时候可能读到 B 写了一半的内容，或者 A 已经 `rm` 掉而 B `readFile` 报 ENOENT → 500；(2) 临时文件落在**仓库根**（dev 下会被 watcher 看到、git status 里多一个未跟踪文件）；(3) `rm` 失败被 `.catch(() => undefined)` 吞掉，残留文件没有任何提示（我检查了仓库根当前没有残留 `*session*.html`，说明正常路径会删掉）。
- **置信度**：已确认（PiWeb 调用 + SDK 落盘逻辑都读了）。
- **建议修法**：`exportToHtml(path.join(os.tmpdir(), \`piweb-export-${randomUUID()}.html\`))`，`try/finally` 删；`exportSession` 属于 bridge 区域，改动请交 bridge 修。

### P2-4 ZCode / opencode 不过滤软删除与归档会话，会把用户在源工具里删掉的对话重新导进来

- **位置**：`src/lib/session-import/oc-family.ts:157-165`
- **证据**：
  ```ts
  const rows = db.all(
      `SELECT s.id AS id, s.title AS title, s.directory AS directory, s.time_created AS created, s.time_updated AS updated,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
       FROM session s
       WHERE s.parent_id IS NULL AND (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) > 0
       ORDER BY COALESCE(s.time_updated, s.time_created) DESC${limit > 0 ? " LIMIT ?" : ""}`,
  ```
  真实 schema（本机实测，只读打开副本）：ZCode `session` 有 `time_deleted`、`time_archived`、`last_outcome` 等列；opencode `session` 有 `time_archived`、**没有** `time_deleted`。
- **触发路径**：用户在 ZCode 里删除会话（ZCode 做的是软删除，行还在、`time_deleted` 非空）→ 打开 PiWeb 导入面板 → 这条会话照常列出、可勾选、可导入。
- **后果**：把用户明确删除的对话重新落成 pi 会话（隐私 + 困惑），还会把它注册成工作区。本机现状：ZCode 软删 2 条、归档 0 条，且都不在"顶层 + 有消息"集合里，所以**当前不会触发**；一旦用户删过一条有消息的会话就会。
- **置信度**：已确认（schema 与 SQL 都实测/读全）；触发需源端删除动作。
- **建议修法**：`WHERE s.parent_id IS NULL AND COALESCE(s.time_deleted, 0) = 0 AND COALESCE(s.time_archived, 0) = 0 …`，并用已有的 `db.hasColumn("session","time_deleted")` 包一层兼容 opencode。

### P2-5 dsh 的 `cwd` 缺失回落到"有歧义的目录名解码"：31/197 个会话走这条路

- **位置**：`src/lib/session-import/dsh.ts:27-33`（`decodeCwdDir`）、`dsh.ts:173`、`dsh.ts:254`
- **证据**：
  ```ts
  export function decodeCwdDir(name: string): string | undefined {
      const match = /^--(.+)--$/.exec(name);
      if (!match) return undefined;
      const body = match[1].replace(/~([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      if (!/^[A-Za-z]-/.test(body)) return undefined; // 只有盘符风格能可靠还原
      return `${body[0]}:\\${body.slice(2).split("-").filter(Boolean).join("\\")}`;
  }
  ```
  实测（本机 197 个 dsh 会话目录，逐帧解出 header）：`{"total":197,"noId":0,"noCwd":31,"noDepth":0}` —— **31 个 header 里没有 `cwd`**，`projectPath` 只能靠目录名还原；而目录名把路径分隔符和 `-` 编成了同一个字符。
- **触发路径**：勾选这 31 条之一 → `index.ts:224-227` 用 `session.summary.projectPath` 判 `isDirectory`。
- **后果**：源路径含 `-` 的（例如 `D:\AIApp\Ordo-前端页面` 被编码成 `--D-AIApp-Ordo-~524D~7AEF~9875~9762--`）会解成 `D:\AIApp\Ordo\前端页面` —— 若该目录恰巧存在就**导到错误的工作区**，不存在就落兜底工作区（静默改变归属），测试里已经承认这个歧义（`tests/session-import-sources.test.ts:363-367`）。本机当前 31 条里能解对的居多数（如 `--B-~68AF~5B50--` → `B:\梯子`），但这是运气不是保证。
- **置信度**：已确认（代码 + 真实 header 统计）。
- **建议修法**：`noCwd` 时不要猜：`projectPath` 留空 → 要求用户选兜底工作区（UI 已有这个流程），或读该会话里后续记录的 `cwd`（如 `request/header` 外层字段）再兜底解码。

### P2-6 每条选择都做一次全 sessions 目录遍历 + 一次注册表读，500 条一批时会放大

- **位置**：`src/lib/session-import/index.ts:189`（`findImported` 在循环里）、`index.ts:202`（循环里再读一次 `getArchivedSessions`）、`src/lib/session-import/writer.ts:50-71`（`findImported` 要 `readdir` 每个会话目录）
- **证据**：
  ```ts
  const existing = IMPORT_SOURCE_MODULES[source] && !seen.has(identity) ? await findImported(options.agentDir, source, externalId) : null;
  ```
  ```ts
  // writer.ts:59-69
  for (const dir of dirs) {
      let files: string[] = [];
      try { files = await fs.readdir(path.join(root, dir)); } catch { continue; }
      const hit = files.find((name) => name.endsWith(suffix));
      if (hit) return path.join(root, dir, hit);
  }
  ```
- **后果**：`MAX_IMPORT_SELECTION = 500`（`limits.ts:4`）。每个 item 一次 `readdir(sessions root)` + 每个子目录一次 `readdir` + 一次注册表 JSON 读（`getArchivedSessions`）。本机 `~/.pi/agent/sessions` 实测 43 个会话目录 / 65 个 jsonl → 500 × 44 ≈ 2.2 万次 `readdir` + 500 次注册表读。本身不算致命，但与 P2-2 的全量重扫叠加，整批可能几十秒无响应。`listImportedKeys` 已经提供了"一次列目录拿全部键"的能力（`writer.ts:77-79`），循环里没用。
- **置信度**：已确认（代码）。绝对耗时未实测。
- **建议修法**：`importSessions` 开头 `listImportedSessions(agentDir)` 建一次 Map，循环里查表；`getArchivedSessions` 同理提前读一次。

### P3-1 写文件的临时文件失败不清理，且没复用项目自带的 Windows 重试助手

- **位置**：`src/lib/session-import/writer.ts:242-246`
- **证据**：
  ```ts
  const target = path.join(dir, importedFileName(summary.source, summary.externalId, createdAt));
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${lines.join("\n")}\n`, "utf8");
  await fs.rename(temporary, target);
  ```
  对比 `src/lib/atomic-file.ts:7-16`（专门做 Windows `EPERM/EACCES/EBUSY` 重试），已被 `src/lib/automations/store.ts:190` 与 `src/lib/web-secret.ts:166` 使用——导入这里没用。
- **后果**：`writeFile` 成功而 `rename` 失败时（Windows 上有杀软/索引器短暂持有目标名，或同名目标已存在）会留下 `<name>.jsonl.<pid>.tmp` 永久垃圾在 sessions 目录里（不会被会话列表当成会话，因为扩展名不是 `.jsonl`，只是没人清）。失败对用户的表现是"导入失败 + 原始 EPERM 文案"。
- **置信度**：已确认（代码）；未构造复现。
- **建议修法**：`try { await replaceFileAtomically(temporary, target) } catch (e) { await fs.rm(temporary, {force:true}); throw e }`。

### P3-2 `\\?\` / UNC 路径会生成含 `?` 的非法会话目录名（与 SDK 共有）

- **位置**：`src/lib/session-import/writer.ts:34-36`
- **证据**：
  ```ts
  export function encodeSessionDir(cwd: string): string {
      return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  }
  ```
  与 SDK 逐字一致（`node_modules/…/dist/core/session-manager.js:294`：`` const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`; ``）——所以非 ASCII 路径（中文用户名）两侧完全一致，**这条没问题**。但 `\\?\C:\x` 里的 `?`、UNC `\\server\share\x` 的第二个前导 `\` 都不在替换字符集里：前者生成含 `?` 的目录名（Windows 建不出来 → 导入失败，错误是 `EINVAL`），后者生成 `----server-share-x--`（能建，但语义丢了）。测试只断言了 `D:\AIApp\PiWeb` 与临时 ASCII 目录两条（`tests/session-import-writer.test.ts:151`）。
- **后果**：仅当源工具的 `cwd` 是 `\\?\` 形式时触发（罕见）。
- **置信度**：已确认（代码 + 测试覆盖范围）。因为 SDK 侧同样如此，判为共有缺陷，不计更高等级。
- **建议修法**：`encodeSessionDir` 里把 `?` 也加入替换集，并在 VS 到 SDK 不一致时以 SDK 为准（这条改动会与 SDK 分叉，需要 bridge/上游一起定）。

### P3-3 导出 HTML 会冷启动会话，可能反写 JSONL

- **位置**：`src/lib/agent-manager.ts:3129`（`const session = await ensureSession(m);`）
- **证据**：现有测试自己承认了这一点：`tests/external-session-write.test.ts:124-126`
  ```ts
  // SDK 启动可追加 thinking_level_change；快照投影本身不应再改写 JSONL。
  const started = await fs.readFile(file, "utf8");
  expect(started.startsWith(original)).toBe(true);
  ```
- **后果**：一个"下载"动作会让会话文件多一条 `thinking_level_change`，`modified` 可能变化从而把会话顶到侧栏最前；如果会话的 cwd 已被删除，`ensureSession` 会抛 `MissingSessionCwdError` → 导出返回 500（JSONL 格式不受影响，它直接读文件）。
- **置信度**：已确认（测试断言 + 调用链）。
- **建议修法**：属 bridge 区域；至少把错误映射成 400 并提示"会话工作区已不存在"。

### P3-4 非 UTF-8 / 坏行会被静默丢弃（消息级丢失，无计数）

- **位置**：`src/lib/session-import/files.ts:17-28`（`eachJsonLine` 吞掉 `JSON.parse` 失败）、`src/lib/session-import/claude.ts:171`（`fs.readFile(…,"utf8")`）、`codex.ts:149`、`grok.ts:106`
- **证据**：
  ```ts
  export function* eachJsonLine(text: string): Generator<Record<string, unknown>> {
      for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
              const parsed = JSON.parse(trimmed);
              if (parsed && typeof parsed === "object") yield parsed as Record<string, unknown>;
          } catch {
              // 单行损坏（写入中断等）：跳过
          }
      }
  }
  ```
- **后果**：截断的最后一行被跳过是对的；但"文件中间某行坏了/含非法 UTF-8 字节"（`readFile(…,"utf8")` 会把坏字节替换成 U+FFFD，整行 `JSON.parse` 失败）也一并静默跳过，`skipped[]` 里**不计这个数**（`claude.ts:257-258` 只统计侧链与合成输入）。导入结果看起来"成功"，但对话中间断了一截，而且没有任何提示。
- **置信度**：已确认（代码）。实际概率未知——这些工具都写 UTF-8，主要是"写入中断/磁盘满"场景。
- **建议修法**：`eachJsonLine` 顺带返回丢弃行数，累加进 `skipped`（"跳过 N 行无法解析的记录"）。

### P3-5 grok 缺 `summary.json` 的会话直接不列（即使 `chat_history` 完整）

- **位置**：`src/lib/session-import/grok.ts:73-78`
- **证据**：
  ```ts
  let summary: Record<string, unknown>;
  try {
      summary = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")) as Record<string, unknown>;
  } catch {
      continue;
  }
  ```
  实测本机 96 个 grok 会话目录里 **1 个**没有（或损坏）`summary.json`。
- **后果**：这类会话完全不可见，也不进 `errors`。`mtime`/`projectPath` 本来都可以从目录名和 `chat_history` 兜底。
- **置信度**：已确认（代码 + 实测计数）。
- **建议修法**：`summary.json` 读失败时用 `{}` 继续，靠 `importable()` 判断是否值得列。

### P3-6 来源凭据条目把源会话的绝对路径写进会话文件

- **位置**：`src/lib/session-import/writer.ts:238`
- **证据**：
  ```ts
  push({ type: "custom", customType: PROVENANCE_TYPE, data: { source: summary.source, externalId: summary.externalId, sourcePath: summary.location, projectPath: summary.projectPath ?? null, importedAt: new Date(now).toISOString() } }, lastAt);
  ```
- **后果**：`sourcePath` 是服务端本地绝对路径（`C:\Users\<用户名>\.claude\projects\…`）。这条会话被导出成 JSONL / HTML 分享出去时会带上用户名与本机目录结构。API 层已经刻意把 `location` 从响应里剥掉（`route.ts:11-15`），这里等于又写回了磁盘。
- **置信度**：已确认（代码）。
- **建议修法**：只留 `source` + `externalId`（可追溯已足够），或对 `sourcePath` 做家目录脱敏。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| codex 的头部判据（P1-1） | 现有 fixture 的 `session_meta` 只有 20KB 且紧跟 `response_item`，掩盖了真实形状 | 造一条 `session_meta` 22KB + `response_item/additional_tools` 46KB + 第一条 message 在 69KB 的文件，断言它必须被列出 |
| 原生依赖/源库不可用时的降级（P1-2） | 现在断言的是"另一种来源照常"（`session-import-service.test.ts:107-118` 用的是 mock 抛错），没有覆盖 `openReadOnly → null → 空数组` 这条路 | mock `openReadOnly` 返回 null、给一个非 SQLite 文件、给一个损坏的 `.zstd`，断言 **scan 结果里出现 errors** 而不是静默空 |
| 超大源 / 条数上限（P2-1） | `oversize` 与 `MAX_ENTRIES` 两条分支完全没有测试 | 用 `fs.stat` mock 出 >200MB；造 `MAX_ENTRIES+1` 条 entry，断言返回 `skipped` 且**没有**写出文件 |
| 导入的幂等并发（同一 `{source,externalId}` 两个 POST 并发） | 现在只有串行幂等测试（`session-import-service.test.ts:259-267`） | 并发 `Promise.all([importSessions(x), importSessions(x)])`，断言最终只有一个文件、内容完整 |
| 导入超时/取消（P2-2） | `withTimeout` 只测了扫描侧，导入侧没有 | 让 `scan` 挂住，断言导入在超时后带原因失败而不是永远 pending |
| 导出 HTML 的临时文件路径（P2-3） | 导出测试全部 mock 掉了 `exportSession`（`tests/api/session-export.test.ts:4`） | 真跑一次 `exportSession(m,"html")`，断言临时文件不在 `process.cwd()`、且导出后不残留 |
| 编码/坏行（P3-4） | 只有"单行坏掉跳过"的间接覆盖 | 在正常 JSONL 中间插一行坏 JSON / 一段非法 UTF-8，断言 `skipped` 里有计数 |
| Windows 路径边界（P3-2） | 只有 `D:\AIApp\PiWeb` 一条 | `\\?\C:\…`、UNC、中文目录名各一条（与 SDK 的 `getSessionDir()` 对比） |
| 软删除过滤（P2-4） | 没有 | 造 `time_deleted` 非空的行，断言不出现；opencode 无该列时不报错 |
| 导出 `.jsonl` 的内容正确性 | 只测了文件名头，正文是 raw 直传 | 断言导出的行数与源文件一致、含 header/custom 条目 |

## 3. 与其他区域的可能交叉点

1. **bridge（`src/lib/agent-manager.ts`）**：P2-3（`exportToHtml()` 不传 `outputPath` → 写进 process CWD）和 P3-3（`ensureSession` 冷启动会反写 JSONL）都在 bridge 区域，本区域只是调用方。`exportSession` 是唯一把"导出"和"启动会话"耦合在一起的地方，建议 bridge 统一修。
2. **API/鉴权**：`src/proxy.ts` 的 matcher 覆盖了 `/api/sessions/import` 与 `/api/sessions/[id]/export`（`PUBLIC_PATHS` 仅 `/login`、`/api/web-auth`、`/pair`），所以本区域不需要自带鉴权——但请 API 区域确认：(a) 导入/导出没有额外的速率限制；(b) P2-1 的 OOM 与 P2-2 的长时间请求，是否需要在 API 层加并发闸门（目前没有，一个认证用户可以并发若干次导入把进程内存打满）。
3. **session-reader / 索引**：导入是**直接写 JSONL**、绕过 `SessionManager`。`session-reader.summarize` 是按"首行必须是 `{type:"session"}` + mtime/size 缓存"来工作的（`session-reader.ts:58-112,205-249`），写入器保证了这个前提（`writer.ts:184`），索引不会被写坏（`saveIndex` 用 tmp + rename，`session-reader.ts:191-199`）。但**导入没有主动失效 `listCache`（1.2s TTL）与 `summaryCache`**：导入后第一个侧栏请求可能还看到旧列表（≤1.2s），靠 `notifySessionsChanged()` 兜。若 session-reader 区域以后改缓存策略，这里要一起看。
4. **crosscut**：`ImportProjectPicker`（项目筛选下拉）在 UI 区域，本区域只按调用方看待；搜索/全选的焦点与 aria 行为由它承担。
5. **pi 上游**：`exportToHtml` 不带 `outputPath` 时写 CWD 这个行为（SDK 注释说 "defaults to session directory" 是错的）建议反馈上游；本区域已按"调用方应显式传路径"处理。

## 4. 建议优先修的 3 件事

1. **P1-1：修 codex 的头部判据**。这是唯一"正常路径下功能直接不对"的问题，实测本机 23% 的 Codex 主会话根本不出现在导入面板里，用户完全无感。改动小（`readHead(file, 512*1024)` 或逐行读到第一条 `response_item`），且可以立刻用真实样本做回归测试。
2. **P1-2：让"依赖/源库不可用"变成可见错误**。现在 `node:sqlite` 缺失、库被锁、库路径不存在、zstd 文件损坏这四种情况在 UI 上都是"这个来源 0 条会话"，与注释承诺的"会报错"相反；改成抛错就能复用已有的 `errors` 通道，UI 已经有渲染逻辑（`SessionImportSection.tsx:376-378`），成本极低。
3. **P2-1 + P2-2：把"读完才拦"改成"读的时候就拦"，并给导入加超时**。一条 200MB 的 zstd 足以把整个 Node 进程 OOM 掉（连累所有正在跑的会话），而 `MAX_ENTRIES` 与 `SCAN_TIMEOUT_MS` 现在都拦不住它；顺带把 `resolveSummary` 接上已有的 `withTimeout`，导入就不再是"点了没反应也不能取消"。
