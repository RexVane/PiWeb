# 进度

> 更早的条目：[state/archive/2026-09.md](archive/2026-09.md)

## 2026-10-07 12:17 +08:00 | claude-opus-5-5 | A 完成：生长树改为每轮一个 git commit，按轮显示改动（`7e7a501`）
- 改了什么：
  - **存储**（`growth-service.ts`）：`snapshot()` 改为 `commitRound()`（:671），每轮 commit 到 `refs/piweb/rounds/<key>`，仍用独立暂存区 `GIT_INDEX_FILE`，不动 HEAD/分支/用户暂存区；元信息写进 commit：
  ```
  把保存按钮改成红色            ← 提问首行（按码点截 72 字，控制字符清掉）

  Piweb-Kind: round           ← round / user（你的修改）/ baseline（工作区第一个 commit）
  Piweb-Session: <会话 JSONL 文件名>
  Piweb-Prompts: <用户消息 entryId,…>
  Piweb-Status: done           ← done / aborted / error
  ```
  - 删掉 `ledger.jsonl` 与逐工具快照；链头直接 `for-each-ref` 读；`update-ref <ref> new old` 带旧值校验，别的进程抢先提交时按新链头重挂（最多 3 次）
  - **读取**：`readRounds()`（:794）一次 `git log -z --raw --numstat -M` 读回整条链，`parseRoundLog()`（:482）同时解析状态字母、行数、重命名、二进制和 trailers；按 commit 缓存，链头变了只增量读；只读路径用 fs 判断引用是否存在（含 commondir / packed-refs），不建仓库；`log.showRoot/showSignature/diff.relative` 用 `-c` 关掉，防用户配置污染输出
  - **触发**（`growth-tracker.ts` 328→~130 行）：`prepare()`（发 prompt 前）调 `recordWorkspaceChanges()` 把两轮之间用户自己的修改记成「你的修改」（工作区还没提交过时记基线）；`agent_start`→`agent_settled` 为一轮（重试的第二次 agent_start 不重开），结束时从会话条目取本轮提问（`growth-turns.ts` 的 `promptsFromEntries`），没改动也提交空 commit，轮号与对话一一对应；删掉 `fs.watch`、外部修改去抖、`growth_pending` 事件
  - **接口**：`GET /api/growth` 返回 `{available, rounds}`；`POST {action:"record"}` 取代 `snapshot`；tree 相关四个接口不变
  - **前端**：`useGrowth` 改为按轮（「本轮」用 commit 自带清单、「本会话累计」= 会话起点→所选轮；基线不显示，「你的修改」不占轮号）；加 `watchRounds`：有会话就拉时间轴（对话标签要用），磁盘目录仍只在面板打开时拉；`ProjectPanel` 头部显示提问/时间/文件数/±行数/在对话里看，范围「本轮 | 本会话累计」，「只看改动」默认开；时间轴柱高 = 改动行数（对数缩放）
  - **对话**：每条提问下加「本轮改了 N 个文件 +a −d」（`ChatWindow` 的 `RoundBadge`），点击打开项目栏并选中这一轮；提问气泡带 `data-message-id`，项目栏「在对话里看」滚过去并描边闪一下
  - **顺手修的老问题**：`.pw-tl-rail` / `.pw-tl-bar` 从来没有样式定义（git 历史里也没有），旧时间轴的柱子宽度为 0、实际看不见，这次补上
  - 注册表全局键改为 `__piWebGrowthRounds`：dev 热更新后不复用旧结构（快照 + 账本）的工作区状态；`GROWTH_TRACKER_VERSION` 3→4 让旧 tracker 自动换新
  - 删除 `growth-rounds.ts`（按时间对齐轮次）与快照里的 `userTurns`；i18n 删 14 个旧键、加 13 个新键，「快照」统一改称「记录」
- 验证：`tsc --noEmit` 通过；全量 vitest **55 文件 386 通过 + 1 跳过**；真实实例（30141）冒烟：临时目录新建会话 → 立即记录得到基线 → 无改动返回 null → 改文件得到「你的修改」（变更正确）→ 接口读回 `baseline,user` → `git log` 能看到标题与 trailers、HEAD 未诞生、无账本；未在会话库留下文件
- 未验证：真的跑一轮模型后的 round commit（需要花用户的 token，没发 prompt；已由真实 git 的 tracker 单测覆盖）
- 旧数据：今天旧版留下的 `refs/piweb/growth/*` 与 `.git/piweb/ledger.jsonl` 不迁移、不删除；清理命令在 M5 写进 README
- 影响文件：`src/lib/growth-service.ts`、`src/lib/growth-tracker.ts`、`src/lib/growth-turns.ts`、`src/lib/types.ts`、`src/lib/agent-manager.ts`、`src/app/api/growth/route.ts`、`src/hooks/useGrowth.ts`、`src/hooks/usePiWeb.ts`、`src/components/ProjectPanel.tsx`、`src/components/ChatWindow.tsx`、`src/components/FileViewer.tsx`、`src/components/AppShell.tsx`、`src/app/globals.css`、`src/i18n.tsx`，及对应测试（删 `growth-rounds` 两个文件，新增 `tests/components/chat-round-badge.test.tsx`）
- 下一步：B1 浏览器内核（先做 pipe 传输在 Windows + Edge/Chrome 上的 spike）

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
