# 进度

## 2026-10-07 11:54 +08:00 | claude-opus-5-5 | 方向变更：开发者模式改「pi 的眼睛」+ 生长树改「每轮一个 git commit」（M0 收尾）
- 为什么改：iframe 嵌入有几个根治不了的问题——跨源碰不到 DOM、要注入或代理、X-Frame-Options/CSP 白屏、第三方上下文里应用登录 Cookie 发不出去、侧栏最宽 640px；托管 dev server 也划不来。用户拍板改方向，计划全文见 `C:\Users\guica\.claude\plans\bubbly-meandering-dream.md`
- 用户确认的决定：
  1. 生长树全面用 git：每轮结束 commit 一次（专用引用 `refs/piweb/rounds/<key>`，不动 HEAD/分支/用户暂存区），每一轮的改动 = `git diff 上一轮 这一轮`，元信息写进 commit trailers，去掉逐工具快照、`ledger.jsonl`、`fs.watch` 外部修改监听；按轮显示（头部=提问首行+文件数+行数，文件只列本轮改动，时间轴柱高=改动行数，灰柱=用户两轮之间自己的修改，对话里每条提问下加「本轮改了 N 个文件」）
  2. 开发者模式改「pi 的眼睛」：系统 Edge/Chrome 无头 + CDP，给 pi 浏览器工具；**截图只给 pi 看**（验证自己改的界面），对话流里展示；不做每轮截图存档；「截图上点选元素」放最后一批
  3. iframe 版本只保留定位内核
- M0 做了什么：
  - 提交定位内核四处修复（`46fe95f`，11 个用例）
  - iframe 面板与其测试移入 `backups/2026-10-07-iframe-dev-preview/`，AppShell/i18n/proxy 的接线改动以 `reverted-wiring.patch` 存档后还原（proxy 放行在新方案里用不上）
  - `tsconfig.json` 排除 `backups/`（`400568d`）：备份文件引用了已撤掉的文案和模块，会让类型检查失败
- 验证：`tsc --noEmit` 通过；全量 vitest 380 通过 + 1 跳过（= 385 − 撤掉的 5 项面板测试）
- 下一步：A1 生长写入改为 `commitRound`

## 2026-10-07 11:21 +08:00 | claude-opus-5-5 | 开发者模式 MVP 完成（面板 + 接线）+ 定位内核四处修复
- 改了什么：
  - 新增 `src/components/DevPreviewPanel.tsx`：地址栏（按工作区存 `piweb.devPreviewUrl:${cwd}`，补 `http://`，**只放行 http(s)**，防 `javascript:` 落进 iframe src 在 PiWeb 源执行）、iframe 直连、检查开关、未接入引导卡（片段 + 复制 + 让 pi 帮我接入 + X-Frame-Options 提示）、结果列表（查看 / 编辑器 / 发给 pi）
  - postMessage 收端三重校验：`event.origin === 预览源`、`event.source === 当前 iframe.contentWindow`、`data.source === "piweb-inspect"`；载荷当不可信输入清洗（字符串、限长、attrs ≤10 条）；页面内跳转后脚本重发 `ready` 时自动重新激活检查；Esc 在 PiWeb 侧也能退出
  - 拖拽调宽时 iframe 会吞 pointermove（AppShell 用 window 监听、无 pointer capture）：面板收 `dragging` prop，拖拽期间 iframe `pointer-events:none`
  - `AppShell.tsx` 接线：项目栏一列两用，`panelMode: "project" | "dev"`（存 `piweb.panelMode`）；顶栏新增「开发者」按钮（`IconBrowseOutline14`），与项目按钮互斥切换、再点收起；Ctrl/⌘+Shift+E 改为切到/收起项目视图；`openInEditor(path, line?)` 补行号透传给 `/api/files`
  ```ts
  // src/components/AppShell.tsx:163
  const togglePanel = useCallback((mode: "project" | "dev") => {
  	if (projectOpen && panelMode === mode) { toggleProject(false); return; }
  	setPanelMode(mode); localStorage.setItem("piweb.panelMode", mode); toggleProject(true);
  }, [projectOpen, panelMode, toggleProject]);
  ```
  - `src/proxy.ts:11`：`ASSET_PATHS` 加 `/piweb-inspect.js`（设了 `PI_WEB_PASSWORD` 时用户页面跨站加载带不上 SameSite=strict Cookie，会被 307 到 /login）
  - `dev-inspect-service.ts` 四处修复：
    1. `LOC_RE`（:66）支持 code-inspector-plugin 的 `file:line:col:tagName`——上条记的「兼容 data-insp-path」实际不成立：其源码 `transform-jsx.ts` 拼的是四段，原正则把整串当文件名后静默丢弃
    2. 源码属性相对路径对不上工作区根（monorepo 子包的 dev server）时按路径后缀找回（`relativeSuffix` :168，拒绝绝对路径与含 `..` 的路径，结果仍过 realpath 边界校验，最多 5 个候选、短路径优先）
    3. 遍历改为「先枚举（只 readdir）再扫描」：`listSearchableFiles`（:106）源码目录优先（src/app/pages/components/lib/packages/apps…）、隐藏目录殿后，新增目录数上限 2 万；i18n 两跳多个 key 合并为一轮读盘（最坏 4 次全量遍历 → 2 次）
    4. `resolveInsideFile` 只校验 realpath 后的路径：Windows 8.3 短名 / 链接别名的绝对路径不再误判越界（CI 的 Windows runner 临时目录就是短名）
  - i18n：zh/en 补 `devPreviewTruncated`
  - 测试：`dev-inspect-service.test.ts` +3（四段格式相对/绝对、monorepo 后缀找回与 `..` 拒绝、目录优先级与截断）；新增 `tests/components/dev-preview-panel.test.tsx` 5 项（URL 白名单、非 http 拒绝加载、跨源/跨窗口消息忽略、载荷清洗与三个动作、ready 后才可检查且只向预览源 postMessage、ping 超时出引导卡）；`proxy-auth.test.ts` 静态资源用例加 `/piweb-inspect.js`
- 验证：`tsc --noEmit` 通过；全量 vitest **56 文件 385 通过 + 1 跳过**（基线 369）；真实实例（30141，用户重启后的 dev 模式）冒烟：`/piweb-inspect.js` 200，「检查元素」→ `i18n-usage DevPreviewPanel.tsx` 排在字典行 `i18n.tsx:544` 前，`data-insp-path: src/proxy.ts:11:1:div` 精确命中
- 已知限制：工作区若是装着多个独立项目的父目录（如 `D:/AIApp`，15 个项目），5000 文件额度会在走到目标项目前用完，后缀找回失效（接口如实返回 `truncated`）；预览宽度受项目栏上限 640px 约束
- 未做：README 功能亮点（交接待办 4）；手工走查真实 Vite/Next 项目（交接待办 5 后半）
- 影响文件：`src/components/DevPreviewPanel.tsx`（新）、`src/components/AppShell.tsx`、`src/lib/dev-inspect-service.ts`、`src/proxy.ts`、`src/i18n.tsx`、`tests/components/dev-preview-panel.test.tsx`（新）、`tests/dev-inspect-service.test.ts`、`tests/proxy-auth.test.ts`
- 下一步：用户确认「输入地址预览」这一入口形态（可选：自动探测 dev server 候选 / PiWeb 托管启动）；代码改动待用户确认后提交

## 2026-09-28 11:40 +08:00 | deepseek-flash (DeepSeek Harness) | 开发者模式（M1 完成 + M2 半程）交接：计划与现状
> 本条是**交接条目**：用户要求把计划落到项目里，后续由别的模型接手。计划全文在下方，实现状态见「已完成 / 待办」。
- 任务目标：用 PiWeb 开发项目时，右侧面板内嵌**用户项目的 dev server 页面**（iframe），开启「检查」后悬停高亮、点击任意元素/文字 → 列出该元素在工作区里对应的源码位置（文件:行号），并可「在 PiWeb 查看 / 编辑器打开 / 发给 pi」。

### 用户已批准的方案（要点，勿擅自改方向）
- 不代理用户 dev server：iframe **直连**用户地址，跨域通信全走 `postMessage`（避免 WebSocket/HMR/URL 重写复杂度）
- 不解析 React fiber；精确 file:line 依赖构建期注入的 `data-source` 类属性，无注入时**退化为文本搜索**
- 三级定位（`locateSource()`）：① `data-source`/`data-insp-path` 等属性直读（行列精确，必须过工作区边界校验）→ ② 精确文本搜索（有界 fs 遍历）→ ③ i18n 两跳（字典行命中 `"key": "文本"` → 提取 key → 搜使用处）
- 排序：`source-attr`(0) > 组件内文本/i18n 使用处(1) > 其他文本(2) > 字典命中(3)；结果上限 20 条

### postMessage 协议（已定，双端实现需一致）
- PiWeb → iframe：`{ source:"piweb", type:"inspect-activate" | "inspect-deactivate" | "inspect-ping" }`
- iframe → PiWeb：`{ source:"piweb-inspect", type:"ready" | "inspect-deactivated" | "element", payload? }`
- `payload = { text, tag, attrs, domPath, pageUrl }`；PiWeb 侧 `text + attrs` 送 `/api/dev-inspect`
- 双向 origin 校验：脚本用 `document.currentScript.src` 推导 PiWeb origin；PiWeb 用 iframe URL 的 origin 校验 `event.origin`

### 已完成（已验证）
1. **Phase 0 善后**：停掉旧全局实例（PID 37284 及其子进程）；发现全局安装 `D:\NodeJs\node_modules\@rexvane\piweb` **本来就是指向本仓库的 junction**，无需再装；已用 `bin/piweb.js --no-open` 重启，30141 端口 `/api/health` 正常（当前跑 dev 模式）
2. **M1 定位内核**（`npm run typecheck` 通过，`npx vitest run tests/dev-inspect-service.test.ts` **8 个测试全过**）：
   - `src/lib/dev-inspect-service.ts`：`locateSource(cwd, {text, attrs})` + `normalizeInspectText()`；常量 `MAX_TEXT=200`、`MAX_RESULTS=20`、`MAX_FILE_BYTES=1MB`、`MAX_FILES=5000`；`DICT_PATH_RE` 限定只有 locales/i18n/lang/messages/translations 类路径才做两跳（避免普通对象字面量误触发）
   - `src/app/api/dev-inspect/route.ts`：POST，body 手写 32KB 上限读取（照抄 `api/files/route.ts` 模式），`export const dynamic = "force-dynamic"`
   - `tests/dev-inspect-service.test.ts`：8 个用例（文本直中 / i18n 两跳排序 / 对象字面量不两跳 / 属性命中与越界拒绝 / 排除目录与二进制跳过 / 缺参报错 / 文本规范化 / 大小写敏感）
3. **M2 半程**：
   - `src/i18n.tsx`：zh（:540-561）+ en（:1089-1110）已加 `devMode`/`devPreview*`/`devInspectKind*` 共 22 个键（`Dict` 类型由 zh 推导，两边必须同步）
   - `public/piweb-inspect.js`：接入脚本已完成（惰性、只在被 iframe 嵌入时工作、hover 高亮 overlay、click 捕获、ESC 退出、ping/ready）

### 待办（接手者从这里继续）
1. **`src/components/DevPreviewPanel.tsx`（未创建）** —— 预览面板：
   - props 建议：`{ cwd, onClose, onViewFile(path), onSendPrompt(text) }`
   - URL 输入（`localStorage` 键 `piweb.devPreviewUrl:${cwd}`，无协议时补 `http://`）；iframe 直连不 sandbox
   - 监听 `message`：校验 `event.origin === new URL(loadedUrl).origin && data.source === "piweb-inspect"`；`ready`→脚本就绪；`element`→POST `/api/dev-inspect {cwd,text,attrs}`；`inspect-deactivated`→关检查态
   - iframe `onLoad` 后发 `inspect-ping`，约 1.2s 无 `ready` → 判定未接入 → 显示接入引导卡（snippet 为 `<script src="${location.origin}/piweb-inspect.js"></script>` + 复制按钮 + 「让 pi 帮我接入」→ `onSendPrompt(t.devPreviewAskPiPrompt.replace("{origin}", location.origin))`）
   - 结果列表每行：[查看]→`onViewFile(path)`、[编辑器]→POST `/api/files {action:"open",cwd,path,line}`、[发给 pi]→`onSendPrompt(\`${path}:${line}\`)`；空白预览时提示 `t.devPreviewFrameHint`（X-Frame-Options/CSP 限制）
   - 复用样式：Tailwind 布局 + `icon-btn` / `pw-chip` / `pw-seg` 类 + `--dsw-*` CSS 变量；图标从 `src/components/icons.tsx` 取（如 `IconSearchOutline16`、`IconRefreshOutline14`、`IconCloseOutline14`）
2. **`src/proxy.ts`**：`ASSET_PATHS`（:10）加 `"/piweb-inspect.js"` —— 否则设了 `PI_WEB_PASSWORD` 时用户页面跨域取不到脚本（matcher 只放行 `_next/`、`_piweb-dev/`、icon）
3. **`src/components/AppShell.tsx` 集成**：顶栏加「开发者」开关，右侧栏在 `ProjectPanel`（挂载点 :589）与 `DevPreviewPanel` 间切换（复用现有宽度/拖拽设施）；接线：
   - `insertIntoComposer`（已有，GitPanel 的 `onAskCommit` 同款）→ `onSendPrompt`
   - 文件查看器：`useFileViewer().open(path, { lazy: true })`（`src/hooks/useFileViewer.ts:28`，`lazy` = 直接读磁盘当前内容）→ `onViewFile`
   - 编辑器打开：`openInEditor()`（`src/lib/files-service.ts:237`，支持 `path:line`，VS Code 系走 `-g`）
4. **README.md / README_zh.md**：功能亮点补一条
5. **验收**：`npm run typecheck` + `npx vitest run`（改造前基线 54 文件 369 通过 + 1 跳过，加新用例后应 ≥377）+ 手工走查（起一个 Vite/Next 项目 → 面板填入地址 → 点文字 → 命中正确文件:行 → 编辑器/查看/发给 pi 三个动作）

### 关键调研结论（接手者不必重查）
- 鉴权在 `src/proxy.ts`（Next 16 的 proxy 约定，替代 middleware），新 API 自动受保护；**只有静态资源白名单需要手工加**
- 用户项目的源码属性格式兼容 `code-inspector-plugin` 的 `data-insp-path`
- 工作区边界统一用 `resolveWorkspacePath` + `isPathInside`（`src/lib/path-security.ts`）
- Next 16 路由处理器就是仓库现有写法（已查 `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`，与现有 22 个路由一致）
- 验证命令：`npx vitest run <file>`；本会话文件策略为 danger-full-access，vitest 可直接跑

### 影响文件（本次在途改动）
- 新增：`src/lib/dev-inspect-service.ts`、`src/app/api/dev-inspect/route.ts`、`tests/dev-inspect-service.test.ts`、`public/piweb-inspect.js`
- 修改：`src/i18n.tsx`
- 下一步：按上面「待办」1→5 顺序继续，完成后补一条 progress 并提交

## 2026-09-28 11:05 +08:00 | k3 (DeepSeek Harness) | 清理旧影子仓库数据
- 改了什么：用户明确指示后，删除已成孤儿的 `C:\Users\guica\.pi\agent\web-growth\`（7 个工作区 / 43.6 MB 旧快照历史）
- 注意：本机还有一个运行中的全局安装旧版 PiWeb（PID 37284，`D:\NodeJs\...\@rexvane\piweb`），它仍是影子仓库代码——若它再触发生长快照会重建该目录；本次去影子仓库改造尚未发布到 npm，待新版本发布并升级全局安装后才会彻底不再出现
- 影响文件：无代码改动

## 2026-09-28 10:55 +08:00 | k3 (DeepSeek Harness) | 生长树去影子仓库：快照直入工作区 .git
- 改了什么：
  - 重写 `growth-service.ts` 存储层：删除 `~/.pi/agent/web-growth/<key>/` 影子裸仓库与 `growthRoot()`/`meta.json`，快照对象直接写入工作区自己的 `.git/objects`
  - 非 git 工作区在首次快照前自动 `git init`；工作区若只是别的仓库的子目录（`rev-parse --show-toplevel` 不等于 cwd），在工作区根嵌套 init，保证快照范围恰好等于工作区；裸仓库拒绝并停用
  - 每步 `commit-tree` 挂到专用引用 `refs/piweb/growth/<workspaceKey>`（带 key 后缀，多 worktree 互不覆盖），不碰 HEAD / 用户 index / 任何分支；不再在用户仓库里跑 `gc`
  - PiWeb 私有文件全部收进 `<gitdir>/piweb/`：独立暂存区 `index`（`GIT_INDEX_FILE` 传入）、排除文件 `exclude`（`--exclude-from` 叠加，不改写用户 `info/exclude`）、账本 `ledger.jsonl`
  - 快照命令新增 LFS 过滤禁用，保证快照存原始字节而非指针文本：
  ```ts
  // src/lib/growth-service.ts:200
  "-c", "filter.lfs.clean=",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.required=false",
  ```
  - 读取侧 `readSteps` 快速路径改为纯 fs 解析 `.git`（目录或 worktree gitfile），无账本直接返回空，不为读取创建仓库
  - 导出签名全部不变，`growth-tracker` / API 路由 / 前端零改动
  - 测试：`growth-service.test.ts` 账本路径断言改指 `.git/piweb/ledger.jsonl`；「用户仓库零改动」用例的 `.git` 目录断言改为只允许新增 `objects/`、`refs/piweb/`、`piweb/`；新增「非 git 工作区自动 init 且 HEAD 保持未诞生」「别的仓库子目录嵌套 init 且父仓库零改动」两个用例
  - 清理 agent-manager / growth-tracker / growth-tree / types / route 里 5 处「影子仓库」过时注释；README 中英双语的环境要求补充新存储说明
- 验证：`tsc --noEmit` 通过；全量 vitest 54 文件 369 通过 + 1 跳过（Windows 符号链接权限用例）
- 影响文件：`src/lib/growth-service.ts`（重写）、`src/lib/growth-tracker.ts`、`src/lib/growth-tree.ts`、`src/lib/agent-manager.ts`、`src/lib/types.ts`、`src/app/api/growth/route.ts`、`tests/growth-service.test.ts`、`tests/growth-tracker.test.ts`、`README.md`、`README_zh.md`
- 旧数据：`~/.pi/agent/web-growth/`（本机 7 个工作区 / 43.6 MB）已是孤儿目录，新版本不读不写；按 backups 原则不代为删除，由用户手动清理
- 下一步：用户手动确认后可删除旧目录；观察真实会话中生长树表现

## 2026-09-28 10:40 +08:00 | k3 (DeepSeek Harness) | 开工登记：远端锁定 + 现状快照
- 远端锁定：
  - `origin = https://github.com/RexVane/PiWeb.git`（本人仓库，可 fetch/push）
  - 无 `upstream`（非 fork 场景），无需 `no_push` 锁定
- 现状快照：
  - HEAD = `4d0f96c chore(release): v0.3.4`，工作区干净
  - 本项目是 pi coding agent 的 Web UI（Next.js 16 + React 19 + Tailwind v4），通过 `@earendil-works/pi-coding-agent` SDK 驱动，零修改引擎
  - 生长树（Growth）现状：每工作区在 `~/.pi/agent/web-growth/<key>/` 建影子裸仓库 + `ledger.jsonl`，快照 = update-index → write-tree → commit-tree 到 `refs/piweb/growth`
- 下一步：生长树去影子仓库改造——快照直接存工作区自身 `.git`（非 git 目录自动 init），提交挂 `refs/piweb/growth/<key>` 专用引用，不碰 HEAD/暂存区/分支；账本挪到 `.git/piweb/ledger.jsonl`；放弃旧影子历史（旧目录保留不删）
- 影响文件：本次仅新增 `state/progress.md`、`.gitignore` 增加 `backups/`

## 方案备忘（本次改造已确认的决策）
- 提交位置：`refs/piweb/growth/<workspaceKey>` 专用引用；独立临时 index（`GIT_INDEX_FILE=<gitdir>/piweb/index`），绝不动用户 index
- 元信息：保留精简 JSONL 索引（`<gitdir>/piweb/ledger.jsonl`），commit message 保持人类可读摘要
- 旧数据：`~/.pi/agent/web-growth/` 放弃迁移，原样保留
- 工作区是某仓库子目录时：在工作区根单独 `git init`（嵌套仓库），保证快照范围恰好等于工作区
