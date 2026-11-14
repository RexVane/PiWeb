# Git 面板与项目面板 审计报告

## 0. 覆盖范围

**读了（全文）**：`src/lib/git-service.ts`（291）、`src/app/api/git/route.ts`（32）、`src/components/GitPanel.tsx`（450）、`src/components/ProjectPanel.tsx`（543）、`src/lib/workspace-index.ts`（268）、`src/lib/process-format.ts`（341）、`src/components/DiffView.tsx`（139，GitPanel 的渲染后端）、`src/lib/path-security.ts`（93）、`src/lib/text-sanitize.ts`（32）、`src/proxy.ts`（87，确认 `/api/git` 的鉴权来源）。
**读了（片段）**：`src/lib/growth-service.ts`（85–199 `resolveGitBin`/`runGit`、400–520 `parseNumstat`/`parseNameStatus`）、`src/lib/files-service.ts`（262–331 `readWorkspaceFile`、540–581 `openInEditor`）、`src/components/AppShell.tsx`（960–1069 `panelRefreshKey`/最右列）、`src/components/DrawerPanel.tsx`（120–177 三个面板的挂载）、`src/i18n.tsx`（git 相关文案）。
**测试读了**：`tests/git-service.test.ts`（134）、`tests/components/git-panel-races.test.tsx`（78）、`tests/components/git-panel-areas.test.tsx`（88）、`tests/integration/project/tree-expansion.test.tsx`（139）、`tests/write-diff.test.ts`（82）、`tests/process-format.test.ts`（241）、`tests/components/growth-project-panel.test.tsx`（150–229，不在任务清单里但覆盖了 ProjectPanel 的 git 出错态）。
**跳过了**：`src/lib/growth-service.ts` 其余部分、`growth-tree.ts`、`useGrowth.ts`、`GrowthTree.tsx`（属 growth 区域，只在本报告第 3 节交叉引用）；`highlight.ts`（属 files-viewer）。

**两个文件名与任务描述不符（已核实，不是笔误）**：
1. `src/lib/workspace-index.ts` **没有**项目树/快照代码，它是 `@` 引用补全的纯逻辑（pi-tui 的 `getFuzzyFileSuggestions` + `extractAtPrefix` 照搬，头注释 :1–16）。项目树真实位置是 `useGrowth` + `GrowthTree`（growth 区域），我只审到 ProjectPanel 与它的边界。
2. `src/lib/process-format.ts` **没有**进程执行代码（无 `spawn`/`exec`/`child_process` 导入），它是「对话过程行」的纯文本整理（:1–3）。本区域唯一真实进程执行面是 `git-service.ts:68` 与 `growth-service.ts:162+`。

**结论一览**

| 子功能 | 结论 | 依据 |
|---|---|---|
| 状态读取（分支/上游/ahead-behind/detached） | OK | `git-service.ts:99–186`，`--porcelain=v2 --branch -z` 解析与实测输出一致 |
| 变更文件解析（porcelain v2，含 rename/conflict 分类） | OK-但脆弱（rename/冲突格式无测试） | `git-service.ts:108–157` |
| 单文件 diff（staged/worktree/untracked） | 有问题（P1-1、P2-1、P2-3） | `git-service.ts:231–277` |
| 提交内容（`git show`） | 有问题（P1-1：merge 提交永远"没有差异"） | `git-service.ts:280–291` |
| 二进制 / 截断 / 大 diff | OK-但脆弱（P2-3） | `git-service.ts:64,218–221,272–273` |
| 命令注入面（分支名/路径/提交信息/搜索词） | **OK**：全部 `execFile` + argv，无一处拼 shell 字符串 | `git-service.ts:67–69` |
| 进程管理（超时/kill/截断） | OK-但脆弱（P2-5：只杀直接子进程，无 tree kill） | `git-service.ts:68` |
| 非 git 目录降级 | 有问题（P2-2：所有失败都归为"不是仓库"） | `git-service.ts:81–91` |
| 嵌套仓库 / 父仓库串台 | 有问题（P2-4） | `git-service.ts:83,223–228` |
| 前端并发刷新竞态 | OK（version + AbortController，测试真断言） | `GitPanel.tsx:94–191`；`git-panel-races.test.tsx` |
| 服务端并发（合并/取消） | OK-但脆弱（P3-4：无合并，abort 不停 git 进程） | `api/git/route.ts` 全文 |
| 项目树渲染 / 展开状态 | OK（集成测试用真实 hook，断言 aria-expanded） | `tree-expansion.test.tsx` 全文 |
| 项目树 vs Git 状态一致性 | OK-但脆弱（P3-4：两个独立数据源，无文件监听） | `ProjectPanel.tsx:160–184` |
| diff 渲染（滚动/溢出/大文件） | 有问题（P3-2：无虚拟化、注释与实现不符） | `DiffView.tsx:97–109` |

## 1. 发现（按严重度降序）

### P1-1 合并提交/冲突文件的 diff 永远渲染成「没有差异」（静默误导）

- **位置**：`src/lib/git-service.ts:287`（`git show --patch`）、`src/components/DiffView.tsx:34`（hunk 正则）、`src/components/GitPanel.tsx:277`（`diff && !diff.binary && !parsed` → 显示「没有差异」）
- **证据**：
  ```ts
  // DiffView.tsx:34 —— 只认 2 路 diff 的 hunk 头
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
  ...
  return out.some((line) => line.kind === "add" || line.kind === "del" || line.kind === "ctx") ? out : null; // :76
  ```
  ```ts
  // git-service.ts:286-290
  const [out, counts] = await Promise.all([
      runGit(root, ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", "--patch", hash], 8 * 1024 * 1024),
      fullDiffStats(root, ["show", "--no-ext-diff", "--no-textconv", "--format=", "--numstat", "-z", hash]),
  ]);
  return { title, ...truncate(out, counts.stats), binary: counts.binary && !out.includes("@@ ") };
  ```
  **实测（本机 PiWeb 仓库，只读命令）**：
  ```
  git show --format= --patch   66ba291  → 输出长度 0
  git show --format= --numstat 66ba291  → 113 行（README.md 8/4 …）
  git show --format= --patch   ab9a571  → 0        git show --numstat ab9a571 → 223 行
  git show --format= --patch   a8e924d  → 0        git show --numstat a8e924d → 2 行
  git rev-list --merges --count HEAD    → 27
  ```
  即：`git show -p` 对 merge 提交默认不输出 patch，而 `--numstat` 照常输出 → `gitShow` 返回 `patch:""` + 非零 `stats`，`GitPanel.tsx:194` 的 `parsed` 为 null，:277 命中「没有差异」，而头部 :268–272 又显示 `+113 −…`。
  全仓库 grep `@@@|diff --cc|combined diff` **零命中**（`src/`+`tests/`），说明没有任何合并/冲突 diff 处理。
- **触发路径**：Git 面板 → 「最近提交」点任一 merge commit（任何有 PR 合并的仓库都有；本仓库 27 个）；或 → 冲突组点任一文件（`areas` 把 conflict 映射成 `mode:"worktree"`，`git-service.ts:270` 走 `git diff -- <path>`，未合并路径 git 默认输出 combined diff，hunk 头是 `@@@ -1,2 -1,2 +1,2 @@@`，正则不匹配）。
- **后果**：最需要看 diff 的两个场景（解决冲突、审合并）面板显示「没有差异」，用户会以为这条提交是空的 / 冲突已解决。merge 提交还会出现「+113 −… 统计」与「没有差异」并存的自相矛盾。
- **置信度**：merge 分支**已确认**（上面实测 + 代码路径）；conflict 分支**已确认代码逻辑**，git 输出格式为疑似——验法：临时仓库造冲突后跑 `git diff -- <冲突文件>`，预期首行 `diff --cc <path>`、hunk 头 `@@@`。
- **建议修法**：`parseUnifiedDiff` 增加 combined 分支（`/^@{3} -(\d+)(?:,\d+)? -(\d+)(?:,\d+)? \+(\d+)/`，行前缀取两列中第一个非空格，`+`/`-` 判定不变）；`gitShow` 用 `--first-parent`（或 `-m --first-parent`）让 merge 有可展示的 2 路 diff，patch 为空时不要回传 `stats`。

### P2-1 `git status` 默认 `-unormal` 会把未跟踪**目录**当文件列出来，点开必然报 `file not found`

- **位置**：`src/lib/git-service.ts:108`（`git status --porcelain=v2 --branch -z`，未指定 `--untracked-files`）、`:133–135`（`?` 记录整条当 path）、`:239–243`（untracked 分支对目录直接抛错）
- **证据**：
  ```ts
  // git-service.ts:133-135
  if (type === "?") {
      files.push({ path: line.slice(2), indexStatus: " ", workStatus: "?", kind: "untracked" });
  }
  // :240-243
  const realFile = await fs.realpath(abs).catch(() => { throw new BoundaryError("file not found"); });
  const stat = await fs.stat(realFile).catch(() => null);
  if (!stat?.isFile()) throw new BoundaryError("file not found");
  ```
  **实测（本机，`status.showUntrackedFiles` 未配置 = 默认 `normal`）**：
  ```
  untracked total=68  dirs=13  files=55
  ? .audit-2026-11-13/        ? examples/               ? src/app/api/automations/
  ? src/app/api/plugins/marketplace/  ? src/app/api/remote/pair/  ? src/app/api/sandbox/
  ? src/app/pair/             ? src/components/settings/  ? src/components/workspace/
  ? src/lib/automations/      ? src/lib/sandbox/        ? tests/examples/  ? tests/lib/sandbox/
  ```
- **触发路径**：工作区里有新建目录（本仓库 13 个）→ Git 面板「工作区」组把它列成一行带 `?` 的文件 → 点击 → `/api/git?diff=<dir>/&mode=untracked` → `git-service.ts:243` 抛 `BoundaryError` → 路由 400（`api/git/route.ts:29`）→ 红条显示 `file not found`。
- **后果**：68 个未跟踪项里 13 个是不可用入口；错误文案「file not found」是英文原文、且真实文件明明存在（用户无法理解）。新增目录里的文件也无法从 Git 面板查看（只有一个目录行）。ProjectPanel 的「未跟踪 N」也把这个目录算成 1 个文件。
- **置信度**：已确认（git 实测输出 + 线性代码路径，无分支）。
- **建议修法**：`git status` 加 `--untracked-files=all`（每个文件一行，`?` 不再出现尾斜杠）；若想保留目录聚合，则在 `kind` 里区分 `untracked-dir` 且 GitPanel 不把它渲染成可点的 diff 行。

### P2-2 `repoRoot` 把「不是仓库」和「git 说明不清/拒绝」混为一谈——面板确定性地撒谎且无诊断信息

- **位置**：`src/lib/git-service.ts:81–91`
- **证据**：
  ```ts
  export async function repoRoot(cwd: string): Promise<{ available: boolean; root: string | null }> {
      try {
          const out = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
          return { available: true, root: out ? path.resolve(out) : null };
      } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return { available: false, root: null };
          // exit 128：不是仓库
          return { available: true, root: null };
      }
  }
  ```
- **触发路径**：git 返回非 0 的**任何**原因 —— 最常见的是 `safe.directory`（Windows 上管理员克隆的仓库、共享盘、CI 复制的目录、`git config --global safe.directory` 缺失时 `fatal: detected dubious ownership`）、`.git` 损坏、目录权限被拒、`.git` 文件指向不存在的 worktree。都会走到 `git-service.ts:97 return EMPTY`（`isRepo:false`）。
- **后果**：GitPanel 显示「此工作区不是 Git 仓库。」（`i18n.tsx:189`）——一个**确定性的错误结论**；ProjectPanel 更糟：`!isRepo` 时 `ProjectPanel.tsx:294` 整块不渲染，连提示都没有，用户只看到项目树是空的。真实原因（stderr）在 `repoRoot` 里被丢弃，而同文件的 `git status` 分支（:158–162）却会把 stderr 存进 `statusError` 展示——同一个文件两种口径。
- **置信度**：已确认（代码路径确定；具体触发哪种 git 失败需现场，`safe.directory` 是可复现的常见来源）。
- **建议修法**：`repoRoot` 返回 `{ available, root, error?: string }`，非 128 的真实语义错误把 `stderr` 透传；`gitInfo` 把它并入 `statusError`；UI 在 `statusError` 时显示「Git 无法读取此目录：<原因>」而不是「不是仓库」。

### P2-3 超过 8MB 的文本 diff 直接 500，400KB 截断机制根本不生效

- **位置**：`src/lib/git-service.ts:64`（`MAX_DIFF_BYTES = 400 * 1024`）、`:272`（`maxBuffer: 8MB`）、`:218–221`（`truncate`）
- **证据**：
  ```ts
  const MAX_DIFF_BYTES = 400 * 1024;
  ...
  runGit(root, ["diff", ...scope, "--no-color", "--no-ext-diff", "--no-textconv", "--", rel], 8 * 1024 * 1024),
  ```
  `execFile` 在 stdout 超过 `maxBuffer` 时抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 并 kill 子进程 → `Promise.all` 整体 reject → `api/git/route.ts:26–31` 返回 500，`error` 是 Node 原文（`stdout maxBuffer length exceeded`），`GitPanel.tsx:254–259` 把它原样贴进红色 alert。
- **触发路径**：任一文件 diff 文本 > 8MB（重新生成的 `package-lock.json`、压缩产物、代码生成器输出、`docs/*.md` 大改）。截断逻辑设计为 400KB 就够，但 diff 必须先完整进内存才能走到 `truncate`。
- **后果**：用户看到英文内部错误而不是「差异过长，已截断」（`i18n.tsx:175` 早就写好了这句文案，但这条路径永远用不上）；同时瞬间多分配 8MB+ 字符串。
- **置信度**：已确认（Node `execFile` 语义 + 代码路径）。
- **建议修法**：`maxBuffer` 改为 `MAX_DIFF_BYTES + 64KB`；`runGit` 捕获 `code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` 时用 `error.stdout` 里的部分输出返回 `{ truncated: true }`（`execFile` 的错误对象带已收集的 stdout）。

### P2-4 缺 `GIT_CEILING_DIRECTORIES`：嵌套工作区会静默串到父仓库，且 diff 边界是仓库根而不是工作区

- **位置**：`src/lib/git-service.ts:83`（`rev-parse --show-toplevel`）、`:68`（env 只有 `GIT_OPTIONAL_LOCKS`/`GIT_TERMINAL_PROMPT`）、`:223–228`（`assertRepoRelative` 以 `root` 为边界）
- **证据**：
  ```ts
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }   // :68
  ...
  function assertRepoRelative(root: string, relPath: unknown): string {       // :223
      const abs = path.resolve(root, relPath);
      if (!isPathInside(root, abs)) throw new BoundaryError("path escapes the repository");
      return abs;
  }
  ```
- **触发路径**：用户把会话工作区设成大仓库的子目录（`D:\bigrepo\packages\app`）。`rev-parse --show-toplevel` 会一路向上找到 `D:\bigrepo`，于是：① Git 面板列出**整个 bigrepo** 的 144 项变更（与当前工作区无关）；② 点开的是工作区之外的文件；③ `?diff=../../.env&mode=untracked` 只需落在仓库内即被放行，且 untracked 模式**直接读盘**（`:244–259`），不经 `.gitignore`。ProjectPanel 的「Git 详情/让 pi 提交」也基于这个父仓库结论。
  注意这**不是新的越权原语**（`/api/git?cwd=` 本身接受任意存在的目录，与 `/api/files?cwd=` 同一口径），真正的问题是口径不一致：`path-security.ts:63–73` 把「工作区」定义为调用方传入的 `cwd`，growth 侧对嵌套仓库还专门弹了一次同意书（`ProjectPanel.tsx:31` `request.reason === "nested"` 配 `parent` 文案），而 Git 面板什么都不问。
- **后果**：小工作区里显示一堆陌生文件；用户以为「我的项目有 144 项改动」；「让 pi 提交」可能把工作区之外的改动一起提交（提示词是自然语言，由模型决定 `git add` 范围）。
- **置信度**：已确认（git 语义确定；本机 PiWeb 仓库本身就是「修改 145 项」的实例）。影响面取决于用户是否把工作区设在仓库子目录——无法从代码判断频率，故列 P2 而非 P1。
- **建议修法**：`runGit` 注入 `GIT_CEILING_DIRECTORIES: path.dirname(cwd)`（只对 `repoRoot` 那次探测），并在 `gitInfo` 里比较 `--show-toplevel` 与 `cwd`：不相等时返回 `root`=cwd 的实际仓库 + 一个 `nestedIn` 字段让 UI 明示「当前工作区属于父仓库 X，显示的是整个仓库」；`assertRepoRelative` 的边界应改为 `cwd`（或至少取两者交集）。

### P2-5 仓库自带配置会在 `git status`/`git diff` 时被执行（供应链面），且超时只杀直接子进程

- **位置**：`src/lib/git-service.ts:68`
- **证据**：`runGit` 只设了 `GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`，没有 `-c core.fsmonitor=false`、没有 `GIT_CEILING_DIRECTORIES`、也没有对 `filter.*`/`core.fsmonitor` 的任何约束；而 `execFile` 的 `timeout` 在 Windows 上是 `TerminateProcess`，**只杀 git.exe 本身**，git 拉起的孙进程不在同一 Job 里。
- **触发路径**：把 `/api/git?cwd=` 指向一个带 `.git/config` 的目录，其中 `core.fsmonitor = <任意程序>`（v1 hook 形式）。`git status` 会执行该程序。可达场景：解压别人给的仓库压缩包（压缩包是带 `.git/` 的，`git clone` 不会传 config，但 zip/tar 会）、`.git/config` 被其他工具写入。`git diff` 侧的等价面是 `filter.<name>.clean`（`.gitattributes` 由仓库提供，filter 定义在本机 config）。
- **后果**：用户点开 Git 面板（页面一挂载就拉 `/api/git`）即触发执行；若该程序挂住，15s 后 git.exe 被杀，孙进程残留。
- **置信度**：疑似（机制来自 git 文档语义，需一条命令验证：`git init t && git -C t config core.fsmonitor <脚本> && git -C t status` 看脚本是否执行）。风险等级受限于「需要 `.git/config` 被污染」，故列 P2 而非 P0/P1。
- **建议修法**：`runGit` 的 argv 前置 `-c core.fsmonitor=false`（git 2.37+ 支持布尔），`repoRoot` 那次另加 `-c core.hooksPath=` 不使用；Windows 上改用 `taskkill /T /F /PID` 或 `detached:false` + `child.kill()` 后按 pid 树清理（与 remote 区域的进程清理同一需求）。

### P3-1 输出固定按 UTF-8 解码：GBK 提交信息会变乱码

- **位置**：`src/lib/git-service.ts:68`（`execFile(...).then(r => r.stdout)`，encoding 默认 utf8）、`:166–173`（`%s/%an` 直接 split）
- **证据**：`exec` 是 `promisify(execFile)`，未传 `encoding`，Node 按 UTF-8 解码；git 对 v2 状态用 `-z` 时输出**原始字节**，对 `git log --pretty=%s` 输出**提交里的原始字节**。Windows 上 Git for Windows 会把文件名转成 UTF-8（所以路径基本安全），但老仓库里 `encoding GBK` 或直接写入 GBK 字节的提交信息会被解成 U+FFFD 方块。
- **触发路径**：打开一个中文老仓库（TortoiseGit/SourceTree 早期的 GBK 提交）→ 最近提交列表出现乱码。
- **后果**：只影响展示，不影响操作；但乱码后无法用标题辨认提交。
- **置信度**：机制已确认（解码方式确定），命中率疑似（取决于仓库历史编码）。
- **建议修法**：`git log` 加 `-c i18n.logOutputEncoding=UTF-8`（对声明了 encoding 的提交生效），并在字符串含 U+FFFD 时用 `sanitizeToolOutput`（`text-sanitize.ts:23`）标记而不是静默显示方块。

### P3-2 diff 渲染：无虚拟化、逐行全量高亮，且「可横向滚动」的注释与实现相反

- **位置**：`src/components/DiffView.tsx:97–107`（`useMemo` 里对**全部**行调 `highlightLine`）、`:109`（`whitespace-pre-wrap`）、`:131`（每行 `margin: "0 -8px"`）；`src/components/GitPanel.tsx:261` 注释「diff 自身仍可横向滚动」、`:279`（`overflow-x-auto`）
- **证据**：
  ```tsx
  const html = useMemo(() => { ... return lines.map((l) => { ... return highlightLine(l.text, lang); }); }, [lines, language]); // :97-107
  <pre className="hljs whitespace-pre-wrap" ...>                                        // :109 长行换行，不横向滚
  <div key={i} style={{ ..., padding: "0 8px", margin: "0 -8px" }}>                       // :131 比容器宽 16px
  ```
- **触发路径**：打开 400KB 截断后的 diff（`git-service.test.ts` 用它造了 7000 行）→ 一次性 7000 次 `highlightLine` + 7000 个 div 同步渲染；`whitespace-pre-wrap` 让压缩过的单行文件（minified js、单行 JSON）折成几百行，`overflow-x-auto` 实际只提供 8px 的横向滚动条（负边距造成的多余溢出），与注释描述不符。
- **后果**：手机上打开大 diff 直接卡顿/掉帧；每行 `-8px` 让容器永远有一条 8px 可滚动余量（视觉上像没对齐）。
- **置信度**：已确认（纯静态可判定）。
- **建议修法**：行数 > ~800 时改用「只渲染前后各 400 行 + 中间折叠」或虚拟列表；长行改用 `whitespace-pre` + 真横向滚动（去掉 `whitespace-pre-wrap`），或给 `<pre>` 加 `overflow-x:auto` 并去掉行内负边距。

### P3-3 `EMPTY` 常量被直接返回，`files`/`commits` 是共享数组引用

- **位置**：`src/lib/git-service.ts:50–61`、`:96–97`
- **证据**：`return { ...EMPTY, available: false }` 是浅拷贝（`files`/`commits` 仍是同一数组）；`if (!root) return EMPTY;` 更是把整个对象交出去。当前没有任何调用方 push，但 `GitInfo.files` 是可变类型，将来任一处 `info.files.sort()`/`push` 就会污染所有 "not a repo" 的响应。
- **建议修法**：`EMPTY` 改成 `emptyInfo()` 工厂函数。

### P3-4 每次工具完成都全量 `git status`；前端 abort 不会停掉服务端 git 进程

- **位置**：`src/components/AppShell.tsx:853–866`（`panelRefreshKey`：每个 `edit/write/bash/powershell/pwsh` 工具 done 时 +1，每轮结束 +1）、`ProjectPanel.tsx:166–184`（250ms 防抖后拉一次）、`GitPanel.tsx:97–116`；`api/git/route.ts`（无请求级超时/合并）
- **证据**：`panelRefreshKey` 递增 → 打开着的 ProjectPanel/GitPanel 各自再拉一次 `/api/git`（`git status` 会遍历整个工作区）。前端 `controller.abort()` 只取消浏览器请求，Next.js 路由里的 `execFile` 继续跑完（最长 15s）。`gitInfo` 最坏串行 4 次 git（`rev-parse` + `status` + `log` + 兜底 `rev-parse`）≈ 60s。
- **后果**：Windows 上 10 万文件的仓库，一次 `git status` 常 1–3s；多轮工具调用期间面板持续扫盘；快速点刷新按钮会留下多个跑完即弃的 git 进程。
- **建议修法**：路由层按 `cwd` 做 1–2s 的 in-flight 合并（同一 cwd 复用同一个 Promise），`GIT_OPTIONAL_LOCKS=0` 已经避免了 index.lock 争用（这点做得对，值得保留）。

### P3-5 GitHub 身份的 `url` 未校验协议就当作 href

- **位置**：`src/components/GitPanel.tsx:311–320`
- **证据**：`<a href={identity.url ?? \`https://github.com/${identity.login}\`} target="_blank" rel="noreferrer">`。服务端 `github-identity.ts:155,193` 来自 `gh api user` 的 `html_url`，正常是 https；但前端没有 `/^https?:/` 兜底，若上游被替换成 `javascript:` 链接则点击即执行。
- **建议修法**：`href={/^https?:\/\//.test(identity.url ?? "") ? identity.url : \`https://github.com/${identity.login}\`}`（一行）。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| porcelain v2 **rename** 记录解析（`git-service.ts:146–148` 的 `i += 1`） | 这段"跳过原路径记录"依赖 `-z` 下的 NUL 分隔格式；写错会吞掉下一条变更（我实测确认格式是 `0\t0\t<NUL>old<NUL>new<NUL>`，但测试里没有 rename 用例） | 造 `git mv a b` → 断言 `files` 恰好一条 `{path:"b", kind:"renamed"}`，且紧随其后的另一条变更没被吞 |
| **冲突**文件的 diff | 冲突组是本面板显式功能，现在落到「没有差异」（P1-1） | 造冲突 → 点冲突文件 → 断言不出现「没有差异」且出现删/增行 |
| **merge 提交** 的 `git show` | 本仓库 27 个 merge；现在 patch 空、stats 非空（P1-1，已实测） | 造 merge → `gitShow` → 断言 `patch` 非空或 `binary/title` 表明「合并提交」；断言 patch 为空时不回传 stats |
| 未跟踪**目录** | 68 项里 13 项点开就 400（P2-1） | 造 `mkdir newdir && touch newdir/a.txt` → 断言 `gitInfo.files` 无尾斜杠条目（或标记为 dir），`gitDiff` 不抛 BoundaryError |
| `git status` 之外的失败（`safe.directory`/`.git` 损坏） | 现在统一被报成「不是仓库」（P2-2） | 把 `.git/config` 改坏 → 断言 `gitInfo` 带 `statusError` 且 UI 显示原因 |
| 大 diff > `maxBuffer` | 现在 500 且抛 Node 内部错误串（P2-3） | 造 >8MB 的文本 diff → 断言 `truncated:true` 而不是 reject |
| detached HEAD / 空仓库 / bare / 浅克隆 / submodule | 状态解析的五个边界都只靠肉眼推断 | `detached` 时 `branch===null && detached===true`；空仓库 `commits:[]` 且 `files:[]`；`git clone --depth 1` 下 ahead/behind 不 NaN；submodule 目录不崩 |
| 非 UTF-8 提交信息 | Windows 中文老仓库常见（P3-1） | 用 `-c i18n.commitEncoding=GBK` 提交 → 断言不出现 U+FFFD（或带 encodingLoss 标记） |
| 服务端并发/取消 | `route.ts` 没有任何测试 | 同一 cwd 并发两次 GET → 断言两次都成功且不互相污染；abort 后 git 进程被回收 |
| `ProjectPanel` 的 git 摘要分组计数 | 与 GitPanel 的分组口径必须一致（两处各写了一遍 filter） | 同一 fixture 下断言两处「暂存/未暂存/未跟踪/冲突」计数相同 |

（`git-panel-races.test.tsx` 已经真断言了 abort + 迟到响应丢弃，`tree-expansion.test.tsx` 用真实 `useGrowth` 断言 `aria-expanded` 与删除文件祖先自动展开——这两处质量明显高于平均，不需重写。）

## 3. 与其他区域的可能交叉点

1. **growth 区域**：嵌套仓库的处理两边不一致——`ProjectPanel.tsx:31`（`growthConsentNested`，带 `parent`）对「工作区在父仓库里」专门弹同意书，Git 面板却直接把父仓库当自己的仓库展示（P2-4）。请 growth 区域确认 `reason:"nested"` 的判定（是"父目录是仓库"，还是"自身不是仓库"），我按前者理解。
2. **growth 区域**：`parseNumstat`/`parseNameStatus`（`growth-service.ts:430,405`）被 my 区域复用（`git-service.ts:10` 从 growth-service 导入 `parseNumstat`、`resolveGitBin`）。我实测确认 `-z` 下 rename 是 `add\tdel\t<NUL>old<NUL>new<NUL>`，`parseNumstat` 的"`rest===""` 取后两个 token"分支与之相符——这个函数改名/搬家的成本请感知。
3. **files-viewer 区域**：`readWorkspaceFile`（`files-service.ts:267–303`）**不**按 `.gitignore` 过滤，而 `listWorkspaceDir`（:239–242）和图片接口（:353–354）过滤。Git 面板的 untracked diff 同样不过滤，且能读 `diff=.env`。是否要把"被忽略的文件不可预览"推广到所有读路径，需要 files 区域裁定。
4. **api-auth 区域**：`/api/git` 自身没有任何鉴权代码，全靠 `src/proxy.ts:28`（`authEnabled()` 为 false 时 `return NextResponse.next()` 直接放行，只剩 Host 校验）。另外 `cwd` 没有工作区白名单（`resolveWorkspacePath` 只要求"存在且是目录"，`path-security.ts:63–73`）——严格说，任何能访问该端口的本机进程都能读任意仓库内容。这与 `/api/files` 同构，请 API 区域统一裁定是否设计内；我区域只记录"git 侧边界=仓库根而非工作区"这一额外一层的差异。
5. **crosscut 区域**：`DrawerPanel.tsx:150–173` 三个面板是条件渲染，**一挂载就各拉一次 `/api/git`**；`GitPanel` 切 `cwd` 时 reset 在 `useEffect`（`GitPanel.tsx:135–148`）里，首帧会先画出上一个仓库的分支/文件列表（一帧脏数据）。
6. **remote/launcher**：`resolveGitBin`（`growth-service.ts:134–160`）只对 macOS 做 PATH 兜底，Windows 直接 `"git"`；失败时面板文案是「未找到 git 命令，请确认已安装并加入 PATH」。若 Windows 上用户装的是 Git for Windows 但服务以无 PATH 的服务方式启动，这条兜底缺失会让面板与生长记录一起不可用。
7. **chat-ui 区域**：`DiffView.parseUnifiedDiff` 被对话里的 edit/write patch 复用（`write-diff.test.ts:13` 直接 import 它）。P1-1 的 combined diff 缺陷将来若扩展到"展示 git 冲突补丁"会同样命中。

## 4. 建议优先修的 3 件事

1. **P1-1**：让 `parseUnifiedDiff` 支持 combined diff（`@@@`），并给 `gitShow` 加 `--first-parent`；否则「冲突」「合并提交」这两个最需要 diff 的入口永远显示「没有差异」，而且和头部统计自相矛盾。
2. **P2-1**：`git status` 加 `--untracked-files=all`（或把尾斜杠目录单列一类不可点行）；本机 68 个未跟踪项里 13 个一点就弹 `file not found`，是当前面板最容易撞到的坏路径。
3. **P2-2**：`repoRoot` 不要再把所有失败折叠成 `isRepo:false`——把 stderr 透传成 `statusError`。`safe.directory`（Windows 上极常见）现在会让 Git 面板确定地说「此工作区不是 Git 仓库」，把可修的问题变成无从下手的死路。
