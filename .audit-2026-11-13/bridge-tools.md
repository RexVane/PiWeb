# 桥层工具与扩展 UI（pi.ts / extension-ui / 工具定义与预设）审计报告

审计人：audit-bridge-tools　日期：2026-11-13　基线：HEAD `1d4efba` + 144 项未提交改动（按磁盘现状）

## 0. 覆盖范围

### 读了哪些文件

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/lib/pi.ts` | 518 | 全文（任务描述写 483 行，文件已变长）。TOOL_PRESETS / presetAllowsTool / 加载器与资源发现 |
| `src/lib/extension-ui.ts` | 412 | 全文（任务描述写 392） |
| `src/lib/ask-user.ts` | 114 | 全文 |
| `src/lib/ask-user-tool.ts` | 54 | 全文 |
| `src/lib/tool-preferences.ts` | 109 | 全文 |
| `src/lib/tool-preset.ts` | 39 | 全文（归一化契约，迁移判定要用） |
| `src/lib/prompt-sources.ts` | 255 | 全文 |
| `src/lib/skills-service.ts` | 237 | 全文（结论：本文件**没有**工具/命令注册代码，只有 SKILL.md 发现/开关/删除） |
| `src/lib/permission-gate.ts` | 215 | 全文（只为核对「白名单之外那道闸门」对哪些名字真的生效） |
| `src/lib/agent-manager.ts` | 3136（分段读约 1200 行） | `execute()` 全部分支(2777–3087)、`submitPrompt`(2687–2718)、`isManagedBusy`(1732)、`toolPolicyDenial/allowedToolNames/policyToolNames/applyToolPolicy`(1792–1861)、`sessionCustomTools`/`toolCatalog`/`coldActiveToolNames`(1302–1466)、`extensionCommandActions`(2011–2140)、`ensureToolPreference`(1273–1300)、快照与 SSE 订阅(2405–2620)、ensureSession 的 bindExtensions(1650–1720) |
| `src/hooks/usePiWeb.ts` | 1331（读 280–490、1045–1135、1196–1280） | 事件折叠、对话框状态、`sendCommand` 的 prompt 去重、档位迁移 effect |
| `src/components/ExtensionUI.tsx` | 468 | 全文（对话框宿主 / widget / 通知） |
| `src/components/AskUserCard.tsx` | 216 | 全文 |
| `src/components/composer/PermissionSelector.tsx` | 119 | 全文（custom 态如何显示） |
| `src/components/ChatInput.tsx` | 1143（读 340–384、420–489、1061–1084） | `runInlineExtension`、`doSend`、停止按钮条件 |
| `src/components/AppShell.tsx` | 1609（仅 grep 到的 536–537、1271–1372） | `askDialog` / `modalDialog` 的选取 |
| `src/app/api/agent/[id]/route.ts` | 24 | 全文（prompt 请求无超时） |
| `src/app/api/agent/[id]/events/route.ts` | 115 | 全文（SSE / 长轮询） |
| `src/lib/command-validation.ts` | 136 | 全文 |
| `src/lib/types.ts` | 575（读 205–284） | `extension_ui` 事件契约 |
| `docs/extension-web-ui.md` | 75 | 全文（对照实现） |
| `docs/workspace-isolation.md` | 184（读 1–50 + grep） | 三道锁的说法 |
| `examples/piweb-extensions/todo-panel.ts` | 76 | 全文（`/todo` 样板） |
| 测试 | — | `tests/lib/extension-web-ui.test.ts`(120)、`tests/extension-ui-lifecycle.test.ts`(169)、`tests/extension-surface.test.ts`(507)、`tests/agent-resource-isolation.test.ts`(1–872 分段)、`tests/ask-user.test.ts`(130)、`tests/tool-preferences.test.ts`(66)、`tests/examples/piweb-extensions.test.ts`(54)、`tests/lib/tool-preset.test.ts`(57)；`tests/components/extension-{dialog,web-dialog,notices}.test.tsx` 读了全部用例标题 + 对应组件源码 |
| pi SDK（**只核契约，不评论实现**） | — | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`(1695–1805，prompt 里扩展命令与 preflight 的先后)、`dist/core/extensions/types.d.ts`(83–216，`ExtensionUIContext` 成员表)、`dist/core/tools/*.js`（内置工具名）、`dist/extensions/{codemode,tool-search}/tool.js`、`dist/extensions/mcp/*`、`dist/core/mcp-servers.d.ts`（MCP 工具名常量） |

跳过的：本区域没有整份跳过的文件；`AppShell.tsx`、`ChatInput.tsx`、`agent-manager.ts`、`usePiWeb.ts` 只读了与本节结论相关的分段（见上表）。未跑任何测试（只读审计，`.audit-2026-11-13/vitest.log` 由 lead 跑）。`src/lib/session-model-runtime.ts`、`agent-config.ts` 属于 task-1，未读。

### 结论一览

| 功能 | 结论 | 依据文件 |
|---|---|---|
| TOOL_PRESETS 与 SDK 实际工具集一致性 | **OK-但脆弱**：当前 8 个内置 + codemode/tool_search + MCP + PiWeb 3 个工具，名字逐个对得上，无拼错、无凭空；但名单硬编码、无 drift 检测（P2-2） | `pi.ts:495-518`、`agent-manager.ts:1303-1312`、SDK `dist/core/tools/*.js` |
| `presetAllowsTool` 边界 | **OK**：未知工具名在 readonly/workspace **默认拒绝**，full 全放行；MCP 只在 workspace 放行 | `pi.ts:515-518`、`tests/lib/tool-preset.test.ts:31-56` |
| 扩展/第三方工具在各档的可见性 | **有问题**：受限档一律不可见（P2-1），与 `docs/workspace-isolation.md:29` 的说法矛盾 | `pi.ts:515`、`agent-manager.ts:1804`、`tests/agent-resource-isolation.test.ts:426` |
| 扩展 UI 桥 请求-应答配对 / 并发 / 重复应答 | **OK**：pending Map + 单次 resolve + `respond` 二次返回 false + dispose 全量取消；有测试 | `extension-ui.ts:224-254,398-408`、`tests/extension-ui-lifecycle.test.ts` |
| 扩展 UI 桥 超时 / 页面关闭悬空 | **OK-但脆弱**：单请求默认 10 分钟、`timer.unref()`、abort 监听会摘掉；但 abort/停止**不**取消已挂起的框（P2-5） | `extension-ui.ts:44,245-250` |
| 扩展 slash 命令阻塞会话（`/todo`） | **有问题（P1-1）**：命令 handler 在 `session.prompt()` 里同步跑，HTTP POST 与 `promptSubmitting` 一起被挂住 | `agent-manager.ts:2787-2810,2687-2718` |
| 扩展命令 create / fork / switch session | **OK**（有真实 SDK 测试）；`switchSession` 无路径校验为 P3-4 | `agent-manager.ts:2086-2124`、`tests/extension-surface.test.ts:404-506` |
| ask_user 工具 ↔ 卡片一致性 | **OK**：JSON 形状、标签校验、跳过/超时/中止语义两侧一致，前后端共用 `ask-user.ts` | `ask-user.ts`、`AskUserCard.tsx`、`tests/ask-user.test.ts` |
| 工具偏好持久化与迁移 | **有问题**：`standard→workspace` 本身安全；但旧 `customActiveTools` 永久压过档位（P2-3）、偏好损坏时档位静默变化（P2-4） | `tool-preferences.ts:39-53,65-76`、`agent-manager.ts:1273-1282`、`usePiWeb.ts:1249-1271` |
| `docs/extension-web-ui.md` ↔ 实现 | **有问题**：文档与实现都支持全部节点/限制（逐项核对一致），但**没写** `web()` 会阻塞提交、默认 10 分钟超时（P3-6） | `docs/extension-web-ui.md`、`extension-ui.ts` |
| prompt-sources 来源归类与读取边界 | **OK**：realpath + 白名单路径校验，链接资源限制在技能目录/工作区内、1 MB 上限 | `prompt-sources.ts:227-255` |
| skills-service 的工具/命令注册 | **不适用**：本文件不注册任何工具或命令；技能经 SDK 变成 `/skill:` 命令，开关后走 `reloadAllLoaders + reloadSessionsForCwd` | `skills-service.ts:166-180` |

## 1. 发现（按严重度降序，同级按影响降序）

### P1-1 扩展 slash 命令里 `await ctx.ui.web()` 会把整次 prompt 提交（HTTP 请求）和整个会话一起锁死

- **位置**：`src/lib/agent-manager.ts:2787`（prompt 分支）、`src/lib/agent-manager.ts:2687`（`submitPrompt`）、`src/lib/extension-ui.ts:224`（`ask()`）
- **证据**：

  提交入口在**第一个 await 之前**就占住了提交锁，并且要等 `submitPrompt` 返回才释放：
  ```ts
  // src/lib/agent-manager.ts:2787
  case "prompt": {
      const text = (cmd.text ?? "").trim();
      if (!text && !cmd.images?.length) return { ok: false, error: "empty prompt" };
      if (m.promptSubmitting || (m.resourceReloading && !reloadTasks.has(m))) return { ok: false, error: "session is busy accepting another command" };
      ...
      m.promptSubmitting = true;                       // 2796
      try {
          const session = await ensureSession(m);
          ...
          return await submitPrompt(m, session, text, { images: cmd.images, streamingBehavior: cmd.behavior }); // 2804
      } finally {
          m.promptSubmitting = false;                  // 2806
  ```

  而 `submitPrompt` 的「受理即返回」只由 SDK 的 preflight 回调触发，且**扩展命令由 SDK 在 preflight 之前同步执行完**：
  ```ts
  // src/lib/agent-manager.ts:2687
  return new Promise<CommandResult>((resolve) => {
      let accepted = false;
      const run = session.prompt(text, {
          ...options,
          source: "rpc",
          preflightResult: (success) => {          // 2698
              if (success) { accepted = true; resolve({ ok: true, data: { accepted: true } }); }
          },
      });
  ```
  ```js
  // 契约核对（pi SDK，不评论其实现）：dist/core/agent-session.js:1702-1710 / 1793
  // Handle extension commands first (execute immediately, even during streaming)
  if (expandPromptTemplates && text.startsWith("/")) {
      const handled = await this._tryExecuteExtensionCommand(text);   // ← await 整个 handler
      if (handled) { preflightResult?.("handled"); return; }          // ← preflight 在 handler 之后
  ```
  ```js
  // dist/core/agent-session.js:1793
  await command.handler(args, ctx);
  ```

  同一个文件里，`editAndResend` 已经写明这种挂住的危害，说明「受理即返回」是本项目的既定契约：
  ```ts
  // src/lib/agent-manager.ts:3028
  // 与普通 prompt 一样在受理时就返回：等整轮跑完的话，这期间 promptSubmitting 一直为真，
  // 插话 / 排队 / 新消息全被拒，HTTP 请求也一直挂着
  ```

  面板侧确实会一直等（`/todo` 传 `timeout: 120_000`，默认 `DEFAULT_TIMEOUT_MS = 10*60*1000`）：
  ```ts
  // src/lib/extension-ui.ts:44
  const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
  ```

  浏览器端把「提交」当成一次 awaited fetch，拿到结果前输入框一直是发送中：
  ```ts
  // src/components/ChatInput.tsx:351-358
  setSending(true);
  ...
  const result = await onSend(`/${entry.name}`, []);
  ```
  ```ts
  // src/hooks/usePiWeb.ts:1063
  if (isPrompt && promptRequestsRef.current.has(target)) return { success: false, error: "prompt acceptance pending" };
  ```

- **触发路径**：输入框选 `/todo` → `ChatInput.runInlineExtension`（ChatInput.tsx:346）→ `onSend("/todo")` → `POST /api/agent/[id]` → `execute()` 的 `prompt` 分支 → `m.promptSubmitting = true` → `ensureSession` → `submitPrompt` → SDK `session.prompt("/todo")` → `_tryExecuteExtensionCommand` → 扩展 handler `await ctx.ui.web(tree, { timeout: 120_000 })` → 桥发布 `extension_ui`（method `web`）并挂起 → **此时 POST 仍未返回**。
- **后果**（逐条可复现）：
  1. `POST /api/agent/[id]` 一直不返回（`src/app/api/agent/[id]/route.ts:14` 直接 `await execute(...)`，路由层没有任何超时），直到用户点面板按钮/取消，或 120s（样板）/10 min（默认）超时。这就是实测「挂住 >45s」的直接原因；45s 本身没有对应的常量（`remote/supervisor.ts:27` 的 45s 是隧道启动超时，无关）。
  2. 发起提交的那个页面：`isStreaming` 仍是 false（`promptSubmitting` 置真时不发 `status` 帧，只在 `finally` 里才发），所以 **停止按钮不出现**（`ChatInput.tsx:1061` 只在 `isStreaming` 时渲染停止键），输入框卡在 `sending` 且 `disabled`。
  3. 服务端会话整体不可用：`promptSubmitting` 为真 → 新的 prompt / `steer` / `followUp` / `editAndResend` / `sendQueueNow` 全部被拒（`agent-manager.ts:2791,2813,3011,2831`），`/reload` 也被 `isManagedBusy` 挡住（`isManagedBusy` 含 `promptSubmitting`，`agent-manager.ts:1732-1734`）。另一个标签页/刷新后的页面拿到快照 `isStreaming: true`（快照用的是 `isManagedBusy`，`agent-manager.ts:2449`），用户看到「在跑」却什么都没发生。
  4. 空闲回收不生效（`reap()` 跳过 busy 会话，`agent-manager.ts:2188`），面板挂着期间会话与它持有的沙箱/MCP 资源都回收不掉。
  5. **影响面是「所有扩展命令」**，不只是弹面板的：任何耗时命令（`ctx.waitForIdle()`、`ctx.newSession()`、长 git 操作用 `pi.exec` 之类）都会把这条 HTTP 请求连同提交锁一起占住。反过来说，模型正在流式生成时 `/todo` 会被 `agent-manager.ts:2801` 直接拒（"session is busy; choose steer or followUp"），所以用户只能在空闲时踩到。
  6. 唯一的自救手段是点面板上的「取消」或回答（`ExtensionUI.tsx:388` 的 Cancel 对所有 method 都渲染），或者等超时。
- **置信度**：已确认（读了完整链路 + 核对了 SDK 的调用顺序 + 项目自己的测试也按「命令挂起 → 应答它 → 命令的 execute 才 resolve」的方式写：`tests/agent-resource-isolation.test.ts:453-471`；`tests/extension-surface.test.ts:482` 注释亦为「扩展命令处理器就在一次 prompt 提交里跑」）。未实际跑复现（只读审计，无法新写探针测试）。
- **建议修法**（最小改动，按优先级）：
  1. `execute()` 的 prompt 分支里，若 `text` 是以 `/` 开头且 `session.extensionRunner.getCommand(name)` 命中，则**不等 handler**：`void session.prompt(...)` 并在 dispatch 后立即 `return { ok: true, data: { accepted: true } }`，错误仍走 `onError` 的 `error` 帧（`agent-manager.ts:1699-1701` 已有），`promptSubmitting` 只在 dispatch 期间短暂为真。
  2. 至少给路由加超时 / 把 `promptSubmitting` 的释放提前到「面板请求发布之后」。
  3. 顺带：`abort` 时把挂起的扩展对话框按 `cancelled` 结束（见 P2-5），并让 `status` 帧在 `promptSubmitting` 置真时也发一次，界面才能显示「等待应答」。

### P2-1 扩展 / 第三方工具在 readonly、workspace 档一律不可见，与文档「执行期闸门管扩展工具」的说法矛盾

- **位置**：`src/lib/pi.ts:515`、`src/lib/agent-manager.ts:1804`（`toolPolicyDenial`）、`docs/workspace-isolation.md:28-29`
- **证据**：
  ```ts
  // src/lib/pi.ts:515
  export function presetAllowsTool(preset: keyof typeof TOOL_PRESETS, name: string): boolean {
      if (preset === "full") return true;
      return TOOL_PRESETS[preset].includes(name) || (preset === "workspace" && isMcpToolName(name));
  }
  ```
  ```ts
  // src/lib/agent-manager.ts:1804
  const allowed = m.customActiveTools ? m.customActiveTools.includes(name) : presetAllowsTool(effectivePreset, name);
  if (!allowed) return `Tool "${name}" is blocked by the current permission level (${m.customActiveTools ? "custom" : m.toolPreset}).`;
  ```
  文档却说这些工具由第二道闸门处理：
  ```
  docs/workspace-isolation.md:28-29
     │    MCP 只放只读，manage_automation 拒绝。挂在 pi 的 tool_call 上，
     │    对扩展新注册的工具、MCP、codemode 嵌套调用同样生效。
  ```
- **触发路径**：用户装一个提供工具的扩展/插件（`.pi/extensions/*`、npm 包、个人扩展目录）→ 会话档位是默认的 `workspace` → `toolCatalog` 会把这工具列进全集，但 `presetAllowsTool` 对未知名字返回 false → 永远不进激活集。
- **后果**：插件提供的工具在 `readonly`/`workspace` 下对模型完全不可见（不是被闸门拒绝，而是压根没声明），插件功能静默缺失、没有任何提示或日志；只有切到 `full` 才能用。这跟「扩展工具会过执行期闸门」的设计说明不一致，也和产品装了插件市场这件事矛盾。测试把现状钉成了「预期」但没有解释：`tests/agent-resource-isolation.test.ts:426` `expect(session.getActiveToolNames()).not.toContain("probe_tool")`。
- **置信度**：已确认（代码路径 + 测试断言）。
- **建议修法**：三选一并写进文档：①按 `readOnlyHint` 注解放行扩展的只读工具；②保留默认拒绝，但在 `docs/workspace-isolation.md` 与插件页明说「受限档只开放内置工具 + MCP 只读工具，插件工具需要完全权限」；③给扩展工具加显式白名单入口（扩展在 `registerTool` 时声明需要的档位）。

### P2-2 白名单是硬编码名单，没有任何与「SDK 实际注册工具集」的核对 → SDK 升级新增工具会在受限档静默消失

- **位置**：`src/lib/pi.ts:495-501`
- **证据**：
  ```ts
  export const TOOL_PRESETS: Record<"readonly" | "workspace" | "full", string[]> = {
      readonly: ["read", "grep", "find", "ls", "bash", "ask_user_question", "request_permission"],
      workspace: ["read", "grep", "find", "ls", "edit", "write", "bash", "codemode", "tool_search", "ask_user_question", "request_permission"],
      full: [], // 空 = 不限制（全部可用工具）
  };
  ```
  当前与实际注册集逐个核对的结果（本轮按 SDK dist 枚举）：内置工具 `read / grep / find / ls / edit / write / bash / powershell`（`dist/core/tools/*.js: name:`）、内置扩展 `codemode`、`tool_search`（`dist/extensions/codemode/tool.d.ts:30`、`dist/extensions/tool-search/tool.d.ts:12`）、MCP `mcp__*` + `list_mcp_resources / list_mcp_resource_templates / read_mcp_resource`（`dist/core/mcp-servers.d.ts:13-15`）、PiWeb 自有 `ask_user_question / request_permission / manage_automation`（`ask-user.ts:9`、`permission-request.ts:8`、`automations/agent-tool.ts:17`）——**没有拼错的名字，也没有列出来的不存在名字**。`powershell`、`manage_automation` 的缺席是刻意的（注释与 `docs/workspace-isolation.md:104` 都这么说）。
- **触发路径**：升级 `@earendil-works/pi-coding-agent`（当前 1.5.2）后 SDK 新增一个内置工具（历史上就有过新增/改名，例如 `powershell`）→ 不在名单里 → readonly/workspace 档静默少一个工具，没有任何告警，测试也不会红。
- **后果**：权限档会随时间「悄悄变窄」；反过来若 SDK 改名（如 `tool_search` → 别的名字），名单里的旧名失效、新名被拒，`codemode`/`tool_search` 之类的功能会静默消失。
- **置信度**：已确认（现状一致）/ 疑似（未来升级触发，无法预判具体版本）。
- **建议修法**：加一个单测：`session.getAllTools()` 的名字集合必须被「三个预设名单的并集 + 已知故意排除集」覆盖（故意排除集= `powershell`、`manage_automation`、MCP 写工具、扩展工具），漏项就失败；或改成从 SDK 导出的工具名常量拼名单，而不是手写字符串。

### P2-3 旧版「逐项工具开关」残留的 `customActiveTools` 会永久压过档位白名单（且能让扩展工具真的执行）

- **位置**：`src/lib/tool-preferences.ts:39-53`、`src/lib/agent-manager.ts:1444,1769,1804,1826`
- **证据**：
  ```ts
  // src/lib/tool-preferences.ts:39
  function sanitize(value: unknown): ToolPreference | undefined {
      ...
      const toolPreset = normalizeToolPreset(raw.toolPreset);
      if (!toolPreset) return undefined;
      const custom = Array.isArray(raw.customActiveTools)
          ? [...new Set(raw.customActiveTools.filter((name): name is string => typeof name === "string" && name.length > 0))]
          : undefined;
      return { toolPreset, ...(custom ? { customActiveTools: custom } : {}), ... };
  ```
  `customActiveTools` 只做了去重和非空过滤，**没有与档位名单求交**；而消费侧一律让它优先：
  ```ts
  // src/lib/agent-manager.ts:1804（toolPolicyDenial）
  const allowed = m.customActiveTools ? m.customActiveTools.includes(name) : presetAllowsTool(effectivePreset, name);
  // src/lib/agent-manager.ts:1769（tool_call 闸门的升权判断）
  if (m.customActiveTools ? !m.customActiveTools.includes(event.toolName) : !presetAllowsTool(escalatedPreset, event.toolName)) return baseDenial;
  // src/lib/agent-manager.ts:1826（policyToolNames）
  if (m.customActiveTools) return allowed;
  ```
- **触发路径**：①老版本 PiWeb 有「工具开关」页面（`git log -S setActiveTools -- src/components` 命中 `3016f92`、`cf73086`、`b7e1a6a` 等提交），当时写进 `~/.pi/agent/web-tool-preferences.json` 的逐项列表在升级后被继续读进来（现在 UI 只剩三档选择器，见 `tests/components/settings-tools-session.test.tsx:72`「without … exposing a tools settings page」）；②或任何已鉴权客户端直接 `POST /api/agent/[id] {cmd:"setActiveTools",names:[...]}`。
- **后果**：
  1. 档位文案与真实能力不一致：选择器显示「自定义」（`PermissionSelector.tsx:42`），`toolPreset` 显示 `readonly`，但 `write`/`bash` 仍在激活集里 —— `write` 会在执行期闸门被拒（模型反复失败、用户看到一堆看不懂的拒绝），但**扩展工具会被真的执行**：`permissionDenial` 对非 MCP、非 shell、非 write/edit、非 manage_automation 的名字一律返回 `undefined`（`permission-gate.ts:160-206`），所以一个旧列表里的 `probe_tool` 这类会写盘的扩展工具在 `readonly` 档照样跑。测试已把这个语义固化：`tests/agent-resource-isolation.test.ts:250-252`（readonly 下 `setActiveTools(["read","probe_tool"])` 成功并生效）。
  2. `customActiveTools: []`（空数组）也会被当成「有自定义」：`[]` 是 truthy → `[].includes(name)` 恒 false → 该会话**一个工具都没有**（含 `read`），报错文案还是 "blocked by the current permission level (custom)"。API 层挡住了（`agent-manager.ts:2964` "cannot disable all tools"、`command-validation.ts:99`），但手改/旧版残留文件可以造出来。
- **置信度**：代码路径已确认；「用户机器上是否真有残留值」未确认（无法读别人的 `~/.pi`）。这是本区域我判断最需要产品决策的一条。
- **建议修法**：`sanitize`/`ensureToolPreference` 里把 `customActiveTools` 与 `presetAllowsTool(preset, name)` 求交（并丢弃空结果 → 视为跟随 preset）；UI 上给「清除自定义」。迁移本身没问题的部分也要说明：`standard → workspace`（`tool-preset.ts:36-39`）是**降权**方向（旧的 `standard` 没有任何路径约束），不会误升权；v1（按工作区保存）的偏好被整份忽略（`tool-preferences.ts:70-71`），落到默认 `readonly`（`agent-manager.ts:1256`），也是安全方向。

### P2-4 偏好文件读不出来（损坏 / 单条非法）时，该会话的档位会静默变成另一个值，且可能被浏览器 localStorage 升到 full

- **位置**：`src/lib/tool-preferences.ts:65-76`、`src/lib/agent-manager.ts:1273-1282`、`src/hooks/usePiWeb.ts:1249-1271`
- **证据**：
  ```ts
  // src/lib/agent-manager.ts:1273
  function ensureToolPreference(m: Managed): Promise<void> {
      m.toolPreferenceLoaded ??= readToolPreference(m.sessionPath).then((preference) => {
          if (!preference || m.disposed) return;
          m.toolPreset = preference.toolPreset;
          m.customActiveTools = preference.customActiveTools;
          m.toolPreferenceSaved = true;
      }).catch(() => {
          /* 偏好文件坏掉 / 读不了：本次按默认档位跑，不影响会话本身 */
      });
  ```
  ```ts
  // src/hooks/usePiWeb.ts:1249（旧用户迁移 effect）
  useEffect(() => {
      if (!currentId || !state.connected || !state.snapshot || state.snapshot.isStreaming) return;
      if (state.snapshot.customActiveTools != null || state.snapshot.toolPreferenceSaved === true) return;
      const preset = storedToolPreset();          // localStorage["piweb.toolPreset"]
      if (preset === null) return;
      if (state.snapshot.toolPreset === preset && state.snapshot.toolPreferenceSaved !== false) return;
      ...
      const restore = sendCommand({ cmd: "setToolPreset", preset })   // ← 写回服务端并持久化
  ```
- **触发路径**：`web-tool-preferences.json` 被写坏（半行 JSON、磁盘满、杀进程）→ `readFile()` 抛 `SyntaxError` → `readToolPreference` 抛 → `ensureToolPreference` 吞掉 → `m.toolPreset` 停在默认 `readonly`、`toolPreferenceSaved` 仍为 `undefined` → 浏览器端迁移 effect 看到 `toolPreferenceSaved !== true` → 用 `localStorage` 里的档位覆盖并持久化。同理，`sanitize` 对单条非法条目返回 `undefined`（`tool-preferences.ts:44`），效果等价于「这个会话从来没存过偏好」。
- **后果**：这个会话原来的档位（可能是 `readonly`）被换成浏览器上一次「新会话」选的档位——如果那是 `full`，这个会话就被静默升到完全权限，用户看不到任何提示。反之也可能是误降（`full` → `readonly` 导致任务莫名其妙做不动）。
- **置信度**：已确认（代码路径；迁移 effect 的触发条件逐条对照过）。
- **建议修法**：读失败/部分条目丢弃时把 `toolPreferenceSaved` 置真（表示「服务端已就这个会话表过态」），或返回一个 `unavailable` 标志让前端跳过迁移；并把 `catch` 里的静默变成一次性 `resourceDiagnostics` / 界面提示。

### P2-5 停止（abort）不取消已挂起的扩展对话框，会话继续忙

- **位置**：`src/lib/extension-ui.ts:231,248-250`（只挂调用方传进来的 `signal`）、`src/lib/agent-manager.ts:2861-2871`（`abort` 分支）
- **证据**：
  ```ts
  // src/lib/extension-ui.ts:231
  if (disposed || (!dialogOpts?.waitForViewer && !opts.hasViewers()) || dialogOpts?.signal?.aborted) return Promise.resolve(fallback);
  ...
  const onAbort = () => finish(null);
  dialogOpts?.signal?.addEventListener("abort", onAbort, { once: true });
  ```
  `select/confirm/input/editor/web/custom` 只用扩展自己传的 `options.signal`；桥没有会话级信号。只有 `askQuestions` 由工具执行拿到 `signal`（`agent-manager.ts:1351`）。abort 分支也不碰 `m.ui`：
  ```ts
  case "abort": {
      const cleared = m.session.clearQueue();
      m.session.abortBash();
      await m.session.abort();
      publish(m, { type: "status", isStreaming: false, state: "aborted", ts: Date.now() });
      return { ok: true, data: cleared };
  }
  ```
- **触发路径**：扩展工具/命令 `await ctx.ui.confirm(...)` → 用户点停止 → `abort` → agent 停了，但 pending 里的对话框还在 → 工具/命令永挂到超时（默认 10 分钟）。
- **后果**：点了停止面板不消失、会话仍是 busy（P1-1 里这条会让「停止」变成无效操作），用户只能去点面板的取消。
- **置信度**：已确认（代码路径）。`ask_user` 不受影响（有 signal、abort 会变 `skipped`，`extension-ui.ts:391`）。
- **建议修法**：桥内持一个会话级 `AbortController`，`abort` / `dispose` 时 abort 它并给所有 pending 补 `extension_ui_resolved`；或在 `abort` 分支里遍历 `m.ui.getPendingRequests()` 逐个 `respond(id, {cancelled:true})`。

### P3-1 `web()` / `select()` 在「调用这一刻没有看客」时立即返回 undefined，浏览器重连窗口里发起的命令会静默无效果

- **位置**：`src/lib/extension-ui.ts:230-231`
- **证据**：`if (disposed || (!dialogOpts?.waitForViewer && !opts.hasViewers()) || ...) return Promise.resolve(fallback);`，配合 `agent-manager.ts:2619-2621`（`hasViewers = subscribers.size > 0 || viewerGraceUntil > now`）与 `holdViewer`（只有长轮询结束时才续命 30s，`events/route.ts:52`）。
- **触发路径**：页面刷新 / 手机切后台导致 SSE 断开 → 2 秒重连窗口内用户提交 `/todo` → 命令 handler 调 `web()` 时 `subscribers.size === 0` 且没有 `viewerGraceUntil` → 立即返回 `undefined`。
- **后果**：命中窗口时：POST 秒回 200、面板不出现、命令什么都没做，用户以为命令跑了（且没有任何提示）。这与 pi 的 noOp 语义一致，但对「用户主动提交的命令」不合适。
- **置信度**：已确认（代码路径；未实际制造断线窗口验证）。
- **建议修法**：命令上下文里的 `web()` 用 `waitForViewer: true`（或至少等 `POLL_VIEWER_GRACE_MS` 那么久再放弃）。

### P3-2 `custom()` 遇到异步组件工厂会静默当作「取消」

- **位置**：`src/lib/extension-ui.ts:188-203,353-358`
- **证据**：
  ```ts
  if (typeof instance === "function") {
      try {
          instance = (instance as (...args: unknown[]) => unknown)({ requestRender: () => {}, invalidate: () => {}, stop: () => {} }, PLAIN_THEME, {}, () => {});
      } catch { return null; }
  }
  const render = (instance as { render?: unknown } | null)?.render;
  if (typeof render !== "function") return null;
  ```
  pi 的契约允许工厂返回 `Promise<Component>`（`dist/core/extensions/types.d.ts:132-135`），这里没有 await → `render` 取不到 → 返回 null → `custom()` 返回 undefined（等同用户取消）。
- **触发路径**：未适配 PiWeb 的扩展调 `ctx.ui.custom(async () => builder())`（SDK 契约允许返回 Promise）→ `terminalComponentLines` 拿到 Promise 对象 → 取不到 `render` → 返回 null。
- **后果**：异步初始化的终端组件在 PiWeb 里「点了没反应」，也不报错（等同用户取消）。
- **置信度**：已确认（代码 + SDK 契约 `types.d.ts:132-135`）。
- **建议修法**：`await Promise.resolve(instance)` 一次再取 `render`。

### P3-3 `setStatus(key, "")` 服务端留空值、客户端删键，快照与事件不一致

- **位置**：`src/lib/extension-ui.ts:302-307`、`src/hooks/usePiWeb.ts:315-319`
- **证据**：服务端 `if (shown === undefined) statuses.delete(key); else statuses.set(key, shown);` —— 空串会 set；客户端 `if (evt.statusText === undefined || evt.statusText === "") delete next[evt.statusKey];` —— 空串会删。于是 `buildSnapshot().extensionStatuses`（`agent-manager.ts:2551`）里可能带着 `{"git": ""}`，重连后的快照与实时事件表现不同。
- **触发路径**：扩展用 `setStatus("git", "")` 或把值算成空串来「清空」状态（文档语义是「传 undefined 清除」，但空串很常见）。
- **后果**：轻微，界面多一个空状态项（或页脚渲染空 span），重连后的快照与实时事件表现不同。
- **置信度**：已确认（代码两侧对照）。
- **建议修法**：服务端把 `""` 也当作清除。

### P3-4 `ctx.switchSession(path)` 不校验目标路径，把任意 JSONL 拉进 Managed 池

- **位置**：`src/lib/agent-manager.ts:2115-2121`、`getManaged`（`agent-manager.ts:1108` 起）
- **证据**：`const target = getManaged(path.resolve(sessionPath));`，而 `getManaged` 只做 `existsSync` + `SessionManager.open`，没有会话目录/工作区边界检查。
- **触发路径**：扩展命令/工具里调 `await ctx.switchSession("D:/别处/会话.jsonl")`（或指向 `~/.pi/agent/sessions` 之外的路径）。
- **后果**：扩展可以把浏览器领到别的会话（跨工作区），或让服务端为一个任意 JSONL 建 Managed 并 `ensureSession`（`adoptReplacement` → `ensureSession`，`agent-manager.ts:2077`）。浏览器端会被 `resolveSessionPath` 挡住（`events/route.ts:25` → `path-security.ts:38` "session path escapes the Pi session store"），所以拿不到内容；但 `sessions` 池会被塞进一个 API 寻址不到的条目，且若那个文件是真会话，会按它自己的 `cwd` 跑一次扩展发现。扩展本身是可信代码（同进程、同权限），所以不算越权，只是健壮性问题。
- **置信度**：已确认（代码路径）。
- **建议修法**：`switchSession` 里要求目标路径在已知会话目录内（复用 `resolveSessionPath` 的边界），否则抛错。

### P3-5 `web-tool-preferences.json` 只增不减

- **位置**：`src/lib/tool-preferences.ts:96-108`
- **证据**：`data.sessions[key] = value`，没有任何 prune；`updatedAt` 写了但没被读过。
- **触发路径**：同一个服务长期使用、会话被删除/归档后重新创建；每次 `setToolPreset`/`setActiveTools`/扩展命令换会话都会写整份文件。
- **后果**：长年使用后文件里堆满已删除会话的条目（每条两个字段），并可能夹带 P2-3 说的旧 `customActiveTools`；文件越大每次切换档位读写的成本越高（每次都是全量读写）。
- **置信度**：已确认（代码）。
- **建议修法**：写入时按 `updatedAt` 保留最近 N 条，或按会话存在性定期清理。

### P3-6 `docs/extension-web-ui.md` 没写 `web()` 的两个关键约束

- **位置**：`docs/extension-web-ui.md:29-33`
- **证据**：文档只写「返回用户的选择……用户取消/超时/没有浏览器在看 → undefined」，既没写默认超时是 **10 分钟**（`extension-ui.ts:44`），也没写 **`await ctx.ui.web()` 会把发起它的那次提交（以及整个会话）挂住** —— 而这正是 P1-1 的成因，也是 `/todo` 样板（`examples/piweb-extensions/todo-panel.ts:63`）会让人踩坑的地方。节点表、上限表与实现逐项核对是**一致**的（`box/text/list/table/progress/code/form`、深 10 / 节点 400 / 文本 4000 / code 8000 / 子节点 60 / list 200 / table 200×12），`custom()` 的只读文本降级也与实现一致。
- **触发路径**：扩展作者照 `docs/extension-web-ui.md` 写命令（文档示例就是 `await ctx.ui.web({...})`），上线后在 Web 里表现为「命令点了半天没反应」。
- **后果**：文档与实现的契约不完整，直接把作者引到 P1-1 的坑里；样板 `todo-panel.ts` 也没在注释里提「这期间会话是忙的」。
- **置信度**：已确认（逐句对照文档与实现）。
- **建议修法**：在「用法」里加一段：命令里 `await web()` 期间会话处于忙态、默认 10 分钟超时、建议显式传 `timeout` 并在循环里检查 `undefined`；同时在 `examples/piweb-extensions/README.md` 里提一句。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 扩展 slash 命令不阻塞提交 | P1-1 的核心，现在**没有**测试能防止它回来 | 起一个 `registerCommand("ask", … await ctx.ui.confirm)` 的扩展，`await execute(m,{cmd:"prompt",text:"/ask"})` **应当立即** resolve 成 `accepted`；随后再发一条普通 prompt 不应被 "busy" 拒绝；断言面板仍待答 |
| abort / 停止会结束挂起的扩展对话框 | P2-5，否则「停止」是假按钮 | `confirm()` 挂起 → `execute({cmd:"abort"})` → 断言 `getPendingRequests()` 为空、`handler` 收到 `false`/`undefined` |
| 白名单 ⊇ SDK 实际注册工具集 | P2-2，SDK 升级会让功能静默消失 | `session.getAllTools()` 的名字集合 vs `TOOL_PRESETS` 并集 + 故意排除集，逐个断言；再加一条「名单里不存在 SDK 里没有的名字」 |
| 受限档下扩展工具/插件工具的预期 | P2-1，现在只有一句 `not.toContain` 没有任何解释 | 明确断言各档 `getActiveToolNames()` 对扩展工具的取舍，并在测试注释里写清是有意的 |
| `standard → workspace` 迁移与非法 `customActiveTools` | P2-3/P2-4，权限模型 | 直接写一份含 `toolPreset:"standard"` 的旧文件断言读成 `workspace`；写 `customActiveTools:["write"]` + `readonly` 断言不会让 write 进激活集；写 `customActiveTools: []` 断言不会把工具全关 |
| 偏好文件损坏时的档位 | P2-4，可能误升到 full | 写坏 JSON → 断言快照 `toolPreferenceSaved` 为真或明确 `unavailable`，且前端迁移 effect 不发 `setToolPreset` |
| 多个对话框并发时的队列行为 | 桥支持多 pending，UI 一次只显示一个（`AppShell.tsx:536-537`） | 同时开两个 `select`（并行工具调用），断言两个都能依次答完、第二个在第一个答完后出现 |
| 浏览器刷新后 `web`/`questions` 面板恢复并解除忙态 | 现在只测了「快照里能恢复对话框」（`tests/use-piweb-events.test.ts:286`），没测「恢复后能答、答完会话回到空闲」 | 伪造 snapshot 里带 `web` 请求 → 应答 → 断言下一次 prompt 被受理 |
| `subscribe()` 的陈旧对话框护栏对 6 种可应答方法一致 | `agent-manager.ts:2600` 只列了 `select/confirm/input/editor`，`web`/`questions` 靠 resolved 帧同窗兜底 | 断言重放窗口里只有请求没有 resolved 时（构造 buffer/buffer-cap 边界）不会弹出无法应答的面板 |
| `web()` 在无看客时的行为 | P3-1，命令静默无效果 | `hasViewers:false` 下调用命令级的 `web()`，断言要么等看客、要么把「没人在看」如实告诉调用方 |

## 3. 与其他区域的可能交叉点

- **bridge（task-1，`agent-manager.ts`）**：P1-1 的修法要动 `execute()` 的 prompt 分支与 `promptSubmitting` 语义；P2-5 要在 `abort` 分支里清理 `m.ui`；P3-4 涉及 `getManaged` 的边界。请 task-1 确认「扩展命令执行不应占用提交锁」是否有其他依赖（`performReload` 的 `fromCommand` 分支就是为「命令处理器也在一次提交里」专门开的例外，`agent-manager.ts:1943-1951`）。
- **API/鉴权（task-4）**：`POST /api/agent/[id]` 直接 `await execute(...)`，**路由层没有任何超时/取消**（`src/app/api/agent/[id]/route.ts:14`），P1-1 的挂起因此能无限期占着连接；`extensionUiResponse` 只校验 `requestId` 非空（`command-validation.ts:120`），任何人拿到 id 就能应答（同源鉴权内可接受，但和「谁打开的面板谁应答」无关）。请以 API 区域为准裁定是否需要服务端超时。
- **沙箱/权限（task-3）**：①`TOOL_PRESETS` 在 `pi.ts`（我的区域）但权限语义归你；②`permission-gate.ts:32` 的 `MUTATING_TOOL_NAMES` 只覆盖内置名字，P2-3 里「扩展工具经 `customActiveTools` 绕过白名单后不受闸门约束」需要你确认是有意还是遗漏；③`tests/lib/tool-preset.test.ts:7` 的注释写「workspace 档的工具名单里不能出现 bash / manage_automation」，但 `:33` 断言 workspace **必须**允许 bash —— 注释与断言相反（P3 级，属你的文件）。
- **聊天 UI（task-5）**：P1-1 的用户可见症状在 `ChatInput`：`sending` 卡死、`isStreaming` 为 false 所以没有停止按钮（`ChatInput.tsx:1061`）；同标签页第二次发送会被 `prompt acceptance pending`（英文原文，`usePiWeb.ts:1063`）挡下并原样显示在输入框下方（`ChatInput.tsx:468`），这条串未翻译，属界面文案问题。
- **插件/技能（task-13）**：P2-1 决定「插件工具只有完全权限可用」；插件页/市场若宣传「装了就能用工具」，需要跟这条对齐。
- **自动化（task-11）**：`automations/runner.ts:222` 用 `execute(m,{cmd:"prompt"})` 跑任务 prompt，若任务 prompt 是 `/命令`，会踩到同一个 P1-1（自动化运行会一直挂到面板超时）；建议自动化侧禁止或特判以 `/` 开头的 prompt。

## 4. 建议优先修的 3 件事

1. **P1-1**：扩展 slash 命令不再占用 `promptSubmitting` / 不再让 HTTP 请求等 handler —— 这是唯一能稳定复现「整个会话挂住」的缺陷，且 `/todo` 样板就是官方示例。
2. **P2-3 + P2-4**：把 `customActiveTools` 与档位求交（并把读失败标记为「已表态」），消除「档位显示 readonly、实际工具集/扩展工具越权」和「偏好损坏被浏览器升到 full」这两条权限模型漏洞。
3. **P2-2**（配 P2-1 的文档口径）：给「白名单 vs SDK 实际注册集」加一条漂移检测测试，并把「受限档不给扩展工具」写进 `docs/workspace-isolation.md` —— 让权限档不会随 SDK 升级悄悄变窄，也不会让插件工具有一天突然消失而没人知道。
