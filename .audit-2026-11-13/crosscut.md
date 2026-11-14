# 横向质量（公共组件 / 错误处理 / 泄漏 / a11y / 性能）审计报告

## 0. 覆盖范围

**通读（整文件）**：`src/components/CustomSelect.tsx`(142)、`CustomSelect.module.css`(147)、`ConfirmDialog.tsx`(193)、`DrawerPanel.tsx`(177)、`FloatingToast.tsx`(40)、`ErrorToast.tsx`(39)、`icons.tsx`(572)、`src/hooks/useSelectKeyboard.ts`(74)、`useDialog.ts`(118)、`src/components/settings/SharedControls.tsx`(262)、`ProxySettings.tsx`(64)、`src/lib/highlight.ts`(59)、`src/app/layout.tsx`(26)、`src/proxy.ts`(87)、`next.config.ts`(55)、`package.json`(103)。
**精读片段**：`src/app/globals.css`（抽查约 600/4450 行：`:root` 变量与暗色块 100–230、移动端媒体查询 313–489、滚动条 491–509、`.icon-btn` 515–540、主题块 2574–2630、`.pw-warn-text` 2552–2560、toast 4287–4384）、`ExtensionUI.tsx` 255–334、`ProjectPanel.tsx` 20–79、`ChatWindow.tsx` 845–874、`MarkdownBlock.tsx` 1–120、`PromptPanel.tsx` 65–144、`GeneralSection.tsx` 300–380、`ProviderSetupModal.tsx` 185–234 + `.module.css`（grep）、`src/app/api/web-auth/route.ts`(76)、`src/app/login/page.tsx`(59)、`src/lib/trajectory.ts` 130–199、`src/lib/proxy-status.ts`(90)、`src/lib/session-retention.ts` 95–115。
**跳过**：`agent-manager.ts`/`pi.ts`/`sandbox/*`/`app/api/**`/`models-service.ts`/`growth*`/`automations/*`/`remote/*`/`plugins-*`/`session-import/*`/`bin|scripts` 的功能级结论（归各功能区域），我只在横向模式命中处读它们，不重复其结论。

**横向 grep 扫描量**：10 类模式共约 490 处命中 —— 吞错 23、`setInterval/clearInterval` 24、`as any|as unknown as|@ts-*` 50、`JSON.parse` 43、`new Map()/new Set()` 163、`addEventListener` 69、`fetch(`（tsx）50、`AbortSignal.timeout`/`signal:` 17、`z-*`/`zIndex` 38、`key={i|index|idx}` 16。逐条回读代码后确认 **13 条**（P1×1、P2×3、P3×9）。

**结论一览**

| 横向面 | 结论 | 依据 |
|---|---|---|
| 公共组件正确性（CustomSelect/ConfirmDialog/DrawerPanel） | OK-但脆弱（P3-1、P3-3、P3-7） | 无逻辑错误；遮罩判定与两套下拉实现分叉是脆弱点 |
| 对话框栈 / 焦点陷阱（useDialog） | OK-但脆弱：**有弹层没接入** | P2-1；useDialog 本体实现正确（Esc 只关顶层、Tab 循环、返回焦点） |
| 错误处理 | **有问题** | P1-1 安全操作吞错；其余抽查无「空 catch 掩盖真实失败」 |
| 定时器 / 监听器泄漏 | OK | 24 处 `setInterval` 全部核对（都有 `clearInterval`，或是带 `started` 闸门 + `unref()` 的模块单例）；69 处 `addEventListener` 抽查了 20 处，均有成对 remove；唯一漏洞是 P3-6 的一处 `setTimeout` |
| 类型逃逸（`as any` 等 50 处） | OK-但脆弱 | 33 处集中在 `agent-manager.ts`（pi SDK 边界，归 bridge 区域）；客户端侧仅 7 处（`AppShell.tsx:833`、`ChatWindow.tsx:609/857/923`、`ProjectPanel.tsx:148`、`DirectoryPicker.tsx:63`、`trajectory.ts:382`），多为 i18n 字典与 JSON 边界断言 |
| `JSON.parse` 未包 try | OK | 抽查 12 处请求/渲染路径全部在 try 内或由调用方 catch（`trajectory.ts:139/180`、`proxy-status.ts:60` 均被外层兜住） |
| 无超时 await（客户端） | **有问题** | P2-3：客户端 fetch 0 处超时（服务端 lib 有 6 处 `AbortSignal.timeout`） |
| 并发写同一文件 | OK | 所有状态写盘走 `tmp + rename`（`atomic-file.ts`/`workspace-store.ts:122`/`models-service.ts:1515`/`session-reader.ts:195`…），无裸 `writeFile` 覆盖共享文件 |
| 服务端/客户端边界 | OK | 51 个 `"use client"` 文件无 Node API 误入；pi SDK 走 `serverExternalPackages`，大头组件全部 `next/dynamic` |
| a11y：Esc / aria / 键盘可达 | **有问题** | P2-1（aria-modal 无陷阱）、P2-2（对比度）、P3-2/3/5 |
| 性能：首屏 bundle | OK | `MarkdownBlock`(472KB)/`SettingsPanel`/`FileViewer`/`DrawerPanel` 已拆 chunk 并空闲预取；未见新增大依赖进主包 |
| 性能：重复解析 / 主线程 | OK-但脆弱 | P3-8（useDialog 全文档查询）、P3-9（`highlightAuto` 同步） |

---

## 1. 发现

### P1-1 「退出登录」把服务端的失败结果吞掉，用户以为已登出、其实会话还在

- **位置**：`src/components/settings/GeneralSection.tsx:343`
- **证据**：
  ```tsx
  onClick={async () => {
      await fetch("/api/web-auth", { method: "DELETE" }).catch(() => {});
      window.location.href = "/login";
  }}
  ```
  服务端特意为这种情况留了失败分支（`src/app/api/web-auth/route.ts:64`）：
  ```ts
  } catch (error) {
      // 吊销没记下来就别报「已退出」：Cookie 的副本还能用
      return NextResponse.json(
          { success: false, error: `could not revoke the session: ...` },
          { status: 500, headers: { "Cache-Control": "no-store" } },
      );
  }
  ```
  而登出页会把「仍然已认证」的用户直接送回主页（`src/app/login/page.tsx:38`）：
  ```ts
  if (!result.data.enabled || result.data.authenticated) router.replace(next);
  ```
- **触发路径**：设置 → 通用 → 网页认证 → 「登出」→ `DELETE /api/web-auth`。若吊销写盘失败（Windows 上 `EPERM/EBUSY`，见 route 里同样的 `SHARING_ERRORS` 处理思路）或网络瞬断 → 客户端不判 `response.ok`、不看 JSON、只吞网络异常 → 无条件跳 `/login`。
- **后果**：500 分支下服务端根本没发出清除 Cookie 的 `Set-Cookie`（第 66–70 行 return 早于第 72–75 行的 `response.cookies.set`），Cookie 仍在 → `/login` 读到 `authenticated:true` → 立刻 `replace("/")` 弹回应用。用户看到的是「点登出没反应」，而且**零错误提示**；如果是「登出并吊销所有设备」，被拷走的 Cookie 依旧有效。HTTP 500 不是异常，`.catch()` 完全兜不住它。
- **置信度**：已确认（客户端 + 路由 + 登录页三处链路都读过）。触发条件（吊销写盘失败或网络错误）是小概率，但代码路径确定。
- **建议修法**：
  ```tsx
  const r = await fetch("/api/web-auth", { method: "DELETE" }).catch(() => null);
  const ok = r?.ok && (await r.json().catch(() => null))?.success;
  if (!ok) { onError(t.logoutFailed); return; }   // 留在原页并提示
  window.location.href = "/login";
  ```

---

### P2-1 两个 `aria-modal` 弹层没接入 `useDialog`：无焦点陷阱，且被 `useDialog` 的抢焦点机制顶住

- **位置**：`src/components/ExtensionUI.tsx:280`（扩展权限/输入对话框）、`src/components/ProjectPanel.tsx:33`（生长授权对话框）
- **证据**：两处都声明了模态，但只自己接了一个 `onKeyDown`：
  ```tsx
  <div ref={dialogRef} tabIndex={-1} className="fixed inset-0 z-[120] ..."
       role="dialog" aria-modal="true" aria-label={dialog.title}
       onKeyDown={(event) => { event.stopPropagation();
           if (event.key === "Escape") { event.preventDefault(); onAnswer(dialog.id, { cancelled: true }); } ... }}
  ```
  `grep useDialog\(` 的 13 个调用点（ConfirmDialog、DirectoryPicker、FileViewer×2、ImageViewer、ProviderSetupModal×2、SessionSidebar×3、SettingsPanel、PluginsSection、AutomationModal）里没有这两个组件。而 `useDialog` 会在任何弹层打开时拦截所有焦点（`src/hooks/useDialog.ts:41`）：
  ```ts
  function onFocus(event: FocusEvent): void {
      const top = dialogs.at(-1);
      if (!top) return;
      if (contains(top, event.target as Node)) top.lastFocus = event.target as HTMLElement;
      else focusInside(top);          // 焦点落在声明的对话框之外 → 强行拽回去
  }
  ```
- **触发路径**：①任意 `useDialog` 弹层（设置、目录选择、模型供应商、会话重命名…）开着时，agent 发起 `ui.web()` 权限请求或生长授权 → 该框以 `z-[120]` 画在最上层；②用户用键盘走进去。
- **后果**：a) 焦点留不住 —— Tab 会跑到背后被遮挡的页面；对屏幕阅读器用户，`aria-modal` 声称背景是惰性的，但焦点已经在背景里了。b) 更糟的是反向冲突：焦点一落到权限框按钮上，`useDialog` 的 `onFocus` 立刻把焦点拽回下面那个弹层（它们不在 `dialogs` 栈里，`contains` 永远为 false），**键盘用户无法操作一个权限确认框**，只能先关掉设置。c) 它们的 Esc 依赖焦点在框内，焦点被拽走后 Esc 只会关掉下面那个弹层。
- **置信度**：已确认（弹层未调 `useDialog` 是 grep 事实；抢焦点逻辑读了完整函数）。「两者同屏」需要运行复现：开设置 → 让 agent 触发一次权限请求 → 试 Tab/Esc。
- **建议修法**：两个组件改成
  ```tsx
  useDialog({ open: Boolean(dialog), onClose: () => onAnswer(dialog!.id, { cancelled: true }), ref: dialogRef });
  ```
  并删掉自己 `onKeyDown` 里的 Escape 分支（`useSelectKeyboard` 那种 `stopPropagation` 已有先例）。`useDialog` 的栈按「新弹层压栈、父弹层被 `root.contains` 判定为更靠下」处理，`z-index` 也应跟栈走，而不是 120/110/105/100 手写。

---

### P2-2 语义色被当正文颜色用：浅色主题下 `--dsw-warn` 2.15:1、`--dsw-success` 2.28:1

- **位置**：`src/app/globals.css:2552`（`.pw-warn-text`）、`:13`/`:57`（`--dsw-amber-500` / `--dsw-success: var(--dsw-green-500)`）；渲染点 `src/components/ChatWindow.tsx:863`
- **证据**：
  ```css
  .pw-warn-text { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis;
                  white-space:nowrap; color: var(--dsw-warn); }
  ```
  ```tsx
  <span className="pw-warn-text" title={message}>{t.modelError}: {message}{hint ? ` · ${hint}` : ""}</span>
  ```
  变量定义（默认浅色主题，`--dsw-bg-base:#ffffff`）：
  ```css
  --dsw-amber-500: rgb(245, 158, 11);   /* → 用白底算 2.15:1 */
  --dsw-green-500: rgb(34, 197, 94);    /* → 用白底算 2.28:1 */
  ```
- **触发路径**：浅色主题下对话里出现模型报错（401 / 上下文超限 / 网络失败）→ 该行正文就是 12.5px 的琥珀色字。
- **后果**：①WCAG AA 正文要求 4.5:1、大字 3:1，这两色分别只有 2.15 和 2.28，**唯一的错误说明几乎看不清**；②同一行还带 `white-space:nowrap + text-overflow:ellipsis`，完整报错只存在于 `title` 提示里 —— 手机端没有 hover，等于永远读不到完整错误。`--dsw-success` 作为文字色另有 10 处（`FloatingToast.tsx:28`、`GitPanel.tsx:270`、`ProjectPanel.tsx:303/324/527`、`ChatWindow.tsx:1282`、`GeneralSection.tsx:419`、`ModelsSection.tsx:740/1058`、`AutomationsWorkspaceView.tsx:75`、`UpdateNotice.tsx:114`），浅色下全部低于 3:1。
- **置信度**：已确认（变量值与用法都读到了；对比度按 sRGB 相对亮度手算，可复核）。注：`html[data-pebrel-theme]` 主题块（`:2591-2593`）把 success 换成 `#548c9e`（≈3.7:1），说明作者已意识到这问题，只是默认主题没改。
- **建议修法**：默认浅色主题给这两个语义色另设「文本用」变体，例如 `--dsw-warn-text: #a85a20`（白底 ≈5.2:1）、`--dsw-success-text: #15803d`（白底 ≈5.0:1），`.pw-warn-text` 改用它；富文本/日志行去掉 `nowrap`，允许两行截断。

---

### P2-3 客户端请求全无超时：服务端 `AbortSignal.timeout` 用了 6 处，`src/components/**` 一处都没有

- **位置**：`src/components/**` 全部 `fetch`（50 处命中，11 处带 `AbortController.signal`，**0 处带超时**）；典型两例：`src/components/PromptPanel.tsx:82`、`src/components/ProxySettings.tsx:21`
- **证据**：
  ```tsx
  // PromptPanel.tsx:75-92
  const response = await fetch(`/api/prompts?${query.toString()}`);   // 无 signal、无超时
  ...
  } finally { if (request === latestRequest.current) setBusy(false); }
  ```
  ```tsx
  // ProxySettings.tsx:19-26：有 signal，但只有卸载/换值时才 abort，没有时间上限
  void fetch("/api/proxy", { signal: controller.signal }).then(...)
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  ```
  对比服务端：`src/lib/models-service.ts:340/435`、`plugins-marketplace.ts:517/575`、`github-identity.ts:167`、`proxy-status.ts:52` 都写了 `AbortSignal.timeout(...)`。
- **触发路径**：隧道/移动网络下 TCP 半开（请求发出、没有响应、也没有 RST），或服务端某一层卡死（例如 pi 侧长阻塞未返回）。浏览器默认 TCP 超时是分钟级到十几分钟。
- **后果**：`busy/loading` 永不落地 —— 提示词面板、代理测试、设置各项一直转圈，且没有「重试/失败」出口；用户只能刷新页面，刷新后如果还卡在同一条挂起请求上就重复出现。`ProxySettings` 更明显：`.catch()` 之后 `automatic` 保持 `null`，输入框看起来像「空的」。
- **置信度**：已确认（代码事实）。「永久转圈」的时长由 TCP 栈决定，需模拟网络挂起才能定量。
- **建议修法**：加一个 30 行内的 `fetchJson(url, { timeoutMs })`（`AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`），全站替换裸 `fetch`；至少先覆盖「面板首屏加载」这一类（PromptPanel / SkillsSection / PluginsSection / ModelsSection / AutomationsWorkspaceView）。

---

### P3-1 ConfirmDialog 的遮罩判定用 `onClick`，拖选文字松手在遮罩上＝点遮罩＝关掉确认框

- **位置**：`src/components/ConfirmDialog.tsx:54`
- **证据**：
  ```tsx
  <div className="modal-mask fixed inset-0 z-[10000] ..."
       onClick={() => { if (!busy) onCancel(); }}>
      <div ref={dialogRef} ... onClick={(e) => e.stopPropagation()} ...>
  ```
- **触发路径**：在对话框正文里按下鼠标选一段报错文字 → 拖到遮罩上松开。`click` 派发到 mousedown/mouseup 的最近公共祖先＝遮罩，于是取消。
- **后果**：删除/覆盖类确认框会被「选字」误关。项目里已有正确写法：`FileViewer.tsx:400`、`ModelsSection.tsx:1024` 用的是 `onMouseDown={(e) => e.target === e.currentTarget && onClose()}`。
- **置信度**：已确认（浏览器事件语义 + 同仓反例）。
- **建议修法**：照抄 `FileViewer` 那行，改 `onMouseDown` + `target===currentTarget`。

### P3-2 FloatingToast 的 `role="status"` 是懒挂载的，屏幕阅读器多半不播报

- **位置**：`src/components/FloatingToast.tsx:10-15`
- **证据**：`if (!toast) return null;` → 整个 `role="status"` 节点是「有消息才出现」。live region 必须在内容变化**之前**就在 DOM 里，动态插入的节点多数读屏器不朗读。
- **后果**：扩展安装/更新的成功/失败反馈对读屏用户静默。
- **建议修法**：在 AppShell 常驻一个 `<div role="status" aria-live="polite" className="sr-only">`，把 `toast.msg` 塞进去；视觉那个仍可懒挂载。
- **置信度**：已确认（结构）；具体播报与否依赖读屏器，属公认限制。

### P3-3 CustomSelect：三处同名可访问名称 + 隐藏 select 未 `aria-hidden`，`flip` 不随窗口变化重算

- **位置**：`src/components/CustomSelect.tsx:72`（原生 select）、`:105`（trigger）、`:117`（listbox）、`:48-55`（flip）
- **证据**：`<select tabIndex={-1} ... aria-label={ariaLabel}>` 与 `<button ... aria-label={ariaLabel}>`、`<div role="listbox" aria-label={ariaLabel}>` 共用同一个 `aria-label`；隐藏 select 只靠 `clip: rect(0,0,0,0)` + `pointerEvents:none` 藏起来，**没有 `aria-hidden`**，仍在无障碍树里。
- **后果**：虚拟光标模式下会读到一个同名的、点不动的原生 select；同名三控件也让「表单控件列表」变噪音。`flip` 只在 `open` 变化时算一次（`useEffect(..., [open])`），打开菜单后旋转屏幕/改窗口高度不会重算，菜单继续朝屏幕外展开。
- **建议修法**：原生 select 加 `aria-hidden="true"`（`tabIndex=-1` 已保证不可聚焦）；`aria-label` 只留在 trigger 上，listbox 用 `aria-labelledby` 指 trigger；flip 用 `resize` 监听或 CSS `@supports (anchor-name:)` 兜底。

### P3-4 `icons.tsx` 的 SVG `mask` 用了固定 id，同一图标渲染两次就有重复 DOM id

- **位置**：`src/components/icons.tsx:334`
- **证据**：`<mask id="piw-agent-preset-mask" ...>` + `mask="url(#piw-agent-preset-mask)"`（同一文件 341 行引用），id 是写死的字面量，不是 `useId()`。
- **后果**：`IconAgentPresetOutline16` 同时出现在抽屉入口、设置页、插件列表时产生重复 id（HTML 非法，`url(#id)` 只解析到第一个）。目前两份 mask 内容相同所以视觉无差异，但一旦有人给某个实例改 mask，改的是全站。
- **建议修法**：`useId()` 生成 id，或把 mask 抽成只渲染一次的 `<defs>`。

### P3-5 `ScopeWorkspaceFilterBar` 声明了 tablist 但没有 tab 的键盘契约；`FontSizeStepper` 复位按钮无 aria-label

- **位置**：`src/components/settings/SharedControls.tsx:220-245`、`:165-180`
- **证据**：`role="tablist"` 里 4 个 `role="tab"` 全都可 Tab 聚焦（无 roving `tabIndex`），没有方向键处理，也没有 `aria-controls`。对照 `DrawerPanel.tsx:114-125` 是完整实现（`tabIndex={active?0:-1}` + ←/→/Home/End）。
  ```tsx
  <button style={{ minWidth: 48, ... }} title="reset" onClick={() => onChange(14)}>{value} px</button>
  ```
  该按钮的可访问名是「14 px」，`title="reset"` 只有 tooltip；同级 ± 按钮的 `aria-label="decrease font size"` 是英文硬编码，全站中文界面下读屏会中英混播。
- **后果**：读屏用户听到「tab」却按方向键没反应，行为与视觉暗示不符；字号复位按钮的目的不可知。
- **建议修法**：抄 DrawerPanel 的 roving tabindex + 方向键；复位按钮 `aria-label={t.fontSizeReset}`；± 按钮用 `t.` 键。

### P3-6 `MarkdownBlock.CopyButton` 的 `setTimeout` 没有清理

- **位置**：`src/components/MarkdownBlock.tsx:71`
- **证据**：`setTimeout(() => { setCopied(false); setCopyFailed(false); }, 1200);` —— 无 ref 保存、无 unmount 清理。流式回答里代码块会随时被替换/卸载。
- **后果**：React 18 之后不会再报警告，属残留定时器；但同文件其它 effect 都做了清理，这里漏了，容易被照抄。
- **建议修法**：`const timer = useRef<number>(); useEffect(() => () => clearTimeout(timer.current), [])`，或直接存到 state 里靠 `useEffect` 依赖驱动。

### P3-7 两套功能重叠的下拉控件，行为已分叉

- **位置**：`src/components/CustomSelect.tsx` 与 `src/components/settings/SharedControls.tsx:9` 的 `SelectOption`；现状是 13 处已迁到 `<SelectOption>`，`ProviderSetupModal.tsx:252/306/641/659` 4 处仍用 `<CustomSelect>`
- **证据**：`SelectOption`（`SharedControls.tsx:9`）是后写的一套：portal 到 `document.body` + `fixed` + 自己的翻转算法 + `data-dialog-owner` 加入焦点栈 + `aria-haspopup="listbox"`；`CustomSelect` 是 `position:absolute` 留在原地 + `window.innerHeight` 翻转。两者共用 `useSelectKeyboard`，但外部行为（被裁/不被裁、是否算进弹层焦点域）不同。`SharedControls.tsx:32` 的注释直说「设置对话框 overflow-hidden 会裁掉 absolute 弹层」，`ProviderSetupModal.module.css:18` 的 `.dialog { overflow: hidden }` 正是同一处境。
- **后果**：新增页面随手选错就复现「下拉被裁一半」；两个实现各自演化，a11y 修复要做两遍。
- **建议修法**：让 `CustomSelect` 内部改用与 `SelectOption` 相同的 portal 实现（保留 props 不变），或把 `CustomSelect` 标 `@deprecated` 并迁移剩下 4 处。

### P3-8 `useDialog` 每次焦点变化都可能全文档查询 + 逐祖先 `getComputedStyle`

- **位置**：`src/hooks/useDialog.ts:16`（`scopes`）、`:24-33`（`focusable`）
- **证据**：
  ```ts
  return [entry.root, ...[...document.querySelectorAll<HTMLElement>("[data-dialog-owner]")].filter(...)];
  ...
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);   // 每个可聚焦元素 × 每个祖先
      if (style.display === "none" || style.visibility === "hidden") return false;
  }
  ```
  `focusin` 每次都会走 `scopes()`；每次 Tab 都走 `focusable()`。
- **后果**：设置弹窗里可聚焦元素上百个、DOM 数千节点时，一次 Tab 要几百次 style 计算；长会话（侧栏上百条）打开任何弹窗后键盘操作会有可感知延迟。不崩，但属可避免的抖动。
- **建议修法**：`focusable()` 结果按「DOM 版本号 + Tab 键」缓存一次（弹层内容不变时复用）；`scopes` 的 `[data-dialog-owner]` 查询改为只查 `entry.owner` 对应的少数节点（`document.querySelectorAll('[data-dialog-owner="x"]')`）。

### P3-9 `highlightCode` 在未知语言时对 <30KB 全文跑 `highlightAuto`，同步阻塞主线程

- **位置**：`src/lib/highlight.ts:44`
- **证据**：`if (content.length < 30 * 1024) return hljs.highlightAuto(content).value;` —— `highlightAuto` 会用 ~40 条语法逐条试跑。`highlight.ts` 被 `FileViewer.tsx:23`、`DiffView.tsx:9`、`GitPanel.tsx:10`、`FullDiff.tsx:11`、`ChatWindow.tsx:32` 静态引入（都在 client）。
- **后果**：打开后缀不认识、大小 20–29KB 的文件，主线程会停顿约 1–3 秒（无 Worker、无 `requestIdleCallback`）；`DiffView` 是按行调用 `highlightLine`，超大 diff 是 N 次同步调用。
- **建议修法**：无 `languageForPath()` 结果时直接返回 `null`（纯文本显示），把 `highlightAuto` 降级为可选开关；`highlightCode` 走 `requestIdleCallback` 或 Worker。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| 登出/吊销失败的处理 | P1-1 是「正常代码看着对、失败路径静默」的典型 | mock `fetch` 返回 `500 {success:false}` → 断言**不**跳转 `/login` 且出现错误提示；再测网络 reject 同样分支 |
| `aria-modal` 弹层的键盘闭环 | P2-1：两个弹层没接 `useDialog`，无测试就没人知道 | 渲染「设置弹窗 + ExtensionUI 权限框」→ 断言 Tab 焦点在权限框内循环、Esc 只关权限框 |
| `useDialog` 嵌套栈 | 这是全站 Esc/焦点唯一实现，现有测试只覆盖单层 | 父子弹层同时 open：Esc 关子层；关子层后焦点回到子层打开前的元素；父层仍在 `dialogs` 里 |
| 两套下拉的键盘全路径 | `useSelectKeyboard` 有单测但两套 wrapper 的差异没测 | 对 `CustomSelect` 与 `SelectOption` 各跑：打开 → ↓↓ → Enter → Esc → Tab 离开后焦点回 trigger |
| 语义色对比度 | P2-2 是「改一个变量就能全局回归」的低成本护栏 | 一个小单测：解析 `:root` 的 `--dsw-warn`/`--dsw-success`（及 `[data-pebrel-theme]` 覆盖）与 `--dsw-bg-base`，断言对比度 ≥ 4.5 |
| 客户端请求超时 | P2-3 一旦有人加 `fetchJson` 没有超时，就是静默回归 | 注入一个永不 resolve 的 fetch → 断言面板在 N 秒后进入 error 态而不是永久 busy |
| `ConfirmDialog` 遮罩交互 | P3-1 只有真实鼠标操作才暴露 | `fireEvent.mouseDown(dialog body)` + `mouseUp(mask)` + `click(mask)` → 断言未取消 |

## 3. 与其他区域的可能交叉点

1. **chat-ui**：`ChatWindow.tsx:861-867` 的错误行是「单行 `nowrap` + 11 个未验证的中文模型错误映射」。我判的是**色板**问题（P2-2）与**布局截断**问题；「错误分类是否准确、提示文案是否覆盖真实报错」请 chat 区域裁定。
2. **settings-i18n / api-auth**：P1-1 的契约是 `/api/web-auth` DELETE 的 500 语义（`src/app/api/web-auth/route.ts:64-70` 注释写得很清楚「别报已退出」）。请 api-auth 确认：除 `GeneralSection.tsx:344` 外还有没有别处调用 DELETE（我只找到 `RemoteSection.tsx:121`，那处读了 JSON，行为正确）。
3. **bridge-tools**：`ExtensionUI` 的权限/输入对话框是否应该整体改成 `useDialog` 客户端（P2-1）。它是扩展 UI 桥的唯一出口，改这里等于改扩展协议的超时/取消语义，需与 bridge-tools 的结论合并看。
4. **models**：`ProviderSetupModal` 仍用不 portal 的 `CustomSelect`（4 处），而弹窗容器 `.dialog` 是 `overflow: hidden`（`ProviderSetupModal.module.css:18`）。我没跑起来验证，怀疑下拉会被裁或被容器的滚动带走。请 models 区域在真实渲染下确认。
5. **launcher-build**：`next.config.ts:53` `experimental.proxyClientMaxBodySize: "272mb"` + `src/proxy.ts` 没读 body —— 中间件层是否真会收 272MB，属于构建/发布面，我不敢下结论，请 launcher 区域评估（若是真的，未认证请求就能让进程吃下 272MB）。
6. **sessions-nav**：`useDialog.ts` 在 task-7 范围里；我这份只覆盖「焦点栈/a11y/性能」视角，功能级结论以它为准（我们对同一文件的 P3-8 可能重复，取其一即可）。

## 4. 建议优先修的 3 件事

1. **P1-1 登出失败静默** —— 改 3 行、零风险、直接消除「点登出没反应还被弹回首页」且暴露吊销失败（安全语义）。顺带把 `fetch` 的 `response.ok` 检查做成习惯。
2. **P2-1 两个 aria-modal 弹层接入 `useDialog`** —— 权限确认框是 agent 能不能继续干活的关键路径，键盘用户现在可能完全按不动；改动是把已有的 3 个组件里各加一行 `useDialog(...)` 并删自带 Esc 分支，同时把 `z-[120]/z-[105]/z-[100]` 统一交给栈序。
3. **P2-2 语义色拆出「文本用」变体** —— 一处 CSS 变量改动，覆盖全站 12 个渲染点（含对话里唯一的错误说明行），并顺手去掉 `.pw-warn-text` 的 `nowrap`，手机端才能读全报错。
