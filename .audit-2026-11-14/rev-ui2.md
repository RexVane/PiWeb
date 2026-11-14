# rev-ui2 — components 兜底分片静态审查（相对 HEAD 1d4efba 的未提交工作区）

日期：2026-11-14 · 范围：`src/components/settings/`（SharedControls/GeneralSection/ModelsSection）、`src/components/update/`、ProviderSetupModal、ProxySettings、AskUserCard、ContextMeter、DirectoryPicker、ProjectPanel、PromptPanel、SessionImportSection 及 src/components/ 下其余改动文件。只做静态分析，未运行任何构建/测试。

## 发现

### [MEDIUM] src/components/settings/ModelsSection.tsx:656
**问题**：保存失败（revision 409 冲突）后不重新载入配置，`customRevision` 永久停留在旧值，之后每次保存都撞同一个 409，编辑/删除路径陷入可预见的失败循环。
**触发条件**：编辑自定义 provider 或删除 provider 时，models.json 在别处被改动（pi CLI、另一个标签页），`saveCustom` 返回 409（errorCode `CONFIG_CHANGED`，响应不带新 revision，见 src/app/api/models/route.ts:191-194）；用户按提示重试。
**期望行为**：失败后重新 `load()` 拿新 revision（同文件 saveAuditFills 已经这么做，见 :571），或给出「重新载入」入口。
**实际行为**：`saveCustom` 失败分支只 `notify(false, …)`（:551-552）；`saveCustomEdit`（:656）与 `deleteCustom`（:702）失败后什么都不做。下一次保存前 `editBaseRevision.current !== customRevision` 检查（:634）两边同为旧值，照样放行、照样 409。唯一恢复途径是切走再切回设置分区让 ModelsSection 重挂载。
**证据**：
```
// ModelsSection.tsx:568-571（体检路径自己承认了这个坑并修复，只有这一处）
// 失败（典型是 revision 冲突：写入期间 pi 自己动过 models.json）也必须刷新本地副本与 revision。
// 否则本地一直拿着旧 revision，之后每次保存都撞同一个 409——用户看到的就是「反复填、永远不成」。
if (!result.success) await load();
```
```
// ModelsSection.tsx:551-558（saveCustom 失败分支无 load）
notify(result.success, result.error);
if (result.success) { setCustom(next); setCustomRevision(null); await Promise.all([load(), changed(result)]); }
```
**修复建议**：把「失败后 load()」下沉进 `saveCustom` 的失败分支（或抽成公共重试函数），三个调用点自动受益。
**最小失败测试**：挂载 ModelsSection → `POST saveCustomProviders` 首次返回 success、第二次返回 409 → 编辑表单里点保存两次 → 断言第二次保存前发起了 `GET /api/models?custom=1`（当前实现不发，测试失败）。

### [MEDIUM] src/components/settings/ModelsSection.tsx:713
**问题**：添加内置 provider（ProviderSetupModal 路径）时 `setKey` 用 `void request(...)` 发射后不 awaited、不 notify，而紧随其后的 `loginState` 轮询与 setKey 存在启动竞态：轮询先到服务端时 `loginState` 因尚无 pendingLogin 直接返回 `done:true`（无 error），轮询终止并把「✓ 成功」画在弹窗里；之后 setKey 真正失败（密钥无效、网络断）被静默丢弃，用户以为已配置。
**触发条件**：设置 → 添加提供方 → 选 api_key 方式提交；`/api/models` 的 loginState 轮询请求先于 setKey 请求到达服务端（一个 RTT 的竞态窗口），或 setKey 服务端失败晚于第一次轮询。
**期望行为**：轮询起点晚于 setKey 挂号（pendingLogin 由 `setApiKey` 同步创建，src/lib/models-service.ts:430），失败经 `loginState.error`（models-service.ts:1384）如实呈现；HTTP 层失败也要有提示。
**实际行为**：第一次 poll 命中 `!pl → { done: true }`（models-service.ts:1369）→ `setOauthDone({ ok: true, msg: provider + " ✓" })` 并停止轮询（ModelsSection.tsx:348-351）；`void request(...)` 的失败结果无人消费。
**证据**：
```
// ModelsSection.tsx:713-715
void request({ action: "setKey", providerId, apiKey });
setOauthDone(null);
setOauthProvider(providerId);
```
```
// models-service.ts:1368-1369
const pl = pendingLogins.get(providerId);
if (!pl) return { prompt: null, notifyLog: [], done: true };
```
**修复建议**：`saveBuiltinSetup` 改为 await 一个「setKey 完成后再开始轮询」的流程（如先 await setKey 的 HTTP 响应——多步认证部分仍走轮询），或轮询首次 `done:true` 且 `notifyLog` 为空时视为「尚未开始」继续轮询一拍。
**最小失败测试**：mock `/api/models`，让 `loginState` 立即返回 `{done:true}`（无 pendingLogin）且 `setKey` 返回 500 → 断言 UI 不出现成功标记且有一条错误提示（当前实现出现 ✓ 且无提示）。

### [MEDIUM] src/lib/client-fetch.ts:9（症状落在 src/components/settings/ModelsSection.tsx:678）
**问题**：`clientFetch` 的 30s 超时白名单含 `/api/update`、`/api/sessions/import`、`/api/plugins`、`/api/files/upload`，但不含 `/api/models`。而 `POST /api/models {action:"setKey"}` 在服务端 `await setApiKey → await runLogin`（models-service.ts:429-433）上阻塞到整个认证流程结束——Vertex/Bedrock 等多步认证（select 提示经 pendingLogin 桥接）耗时以分钟计。30 秒一到客户端收到「请求超时」假失败，服务端登录却还在继续并最终成功。
**触发条件**：编辑内置 provider 填密钥保存（ModelsSection.tsx:678 `void call({action:"setKey"…})`），多步提示之间用户操作超过 30 秒。
**期望行为**：长挂起的认证类请求要么进 120s/无超时白名单，要么像 `loginStart` 一样服务端立即返回、流程走轮询。
**实际行为**：30s 后 `request()` 捕获超时 → `call` → `notify(false, "请求超时，请检查连接后重试。")`（ModelsSection.tsx:510），与随后 OAuth 弹窗里的「✓ 成功」自相矛盾；`call` 失败分支不 load()，provider 列表短暂陈旧（轮询 done 后的 load 自愈）。
**证据**：
```
// client-fetch.ts:9
const timeoutMs = /\/api\/(plugins|sessions\/import|update|files\/upload)(?:[/?]|$)/.test(url) && init.method && init.method !== "GET" ? 120_000 : 30_000;
```
```
// ModelsSection.tsx:677-679
if (j.success && keyDraft.trim()) {
    void call({ action: "setKey", providerId: provider.id, apiKey: keyDraft.trim() });
```
**修复建议**：把 `/api/models` 的非 GET 请求纳入 120s 白名单（setKey/discover 均可能远超 30s），或服务端把 setKey 改造成 loginStart 式的立即返回 + 轮询。
**最小失败测试**：clientFetch 单测：对 `/api/models` POST 一个 45s 才返回的 mock → 断言 120s 内不 abort（当前实现 30s abort，测试失败）。

### [MEDIUM] src/components/settings/ModelsSection.tsx:645-655（服务端落点 src/lib/models-service.ts:1461-1480）
**问题**：重命名自定义 provider（改 ID）会静默丢掉 models.json 里该 provider 的 `apiKey` 与敏感 `headers`：客户端副本里密钥已被抹掉（由服务端保存时回填），改名后新 ID 在旧文件里查不到，`mergeCustomProviderApiKeys` 只按同 ID 回填。
**触发条件**：编辑一个把 apiKey（或 Authorization 类 header、`!command` 值）存在 models.json 的自定义 provider，修改 Provider ID 并保存。
**期望行为**：密钥跟随改名的 provider 迁移，或改名时明确提示需要重录密钥。
**实际行为**：客户端 `delete next[previousId]; next[cId.trim()] = serializeProviderDraft(previous /* 无 apiKey */, …)`；服务端回填循环 `previous.providers[id]` 以新 ID 取值为 undefined → 不回填。保存成功，provider 变成未认证（卡片红点），无任何解释。
**证据**：
```
// ModelsSection.tsx:646-649
const previousId = editing ?? cId.trim();
const previous = next[previousId] ?? {};
if (previousId !== cId.trim()) delete next[previousId];
next[cId.trim()] = serializeProviderDraft(previous, { … apiKey: cKey … });
```
```
// models-service.ts:1462-1463, 1475-1478
for (const [id, provider] of Object.entries(parsed.providers)) {
    const previousProvider = previous.providers[id];          // 改名后取不到
    …
    } else if (provider.apiKey === undefined) {
        if (previousProvider && Object.prototype.hasOwnProperty.call(previousProvider, "apiKey")) {
            provider.apiKey = previousProvider.apiKey;        // 不会执行
```
**修复建议**：在 `saveCustomEdit` 检测到改名且 `secretProviderIds.has(previousId)` 时拒绝保存并提示「改名需重录密钥」，或请求体带 `renameFrom` 让服务端按旧 ID 迁移密钥。
**最小失败测试**：models-service 测试：旧文件 `{providers:{a:{apiKey:"k"}}}`，提交 `{providers:{b:{}}}`（无 apiKey）→ 断言结果中 b 不带 apiKey 时必须报错/要求显式迁移（当前实现静默写成功且丢钥）。

### [MEDIUM] src/components/settings/ModelsSection.tsx:694-702
**问题**：删除内置 provider 先 `removeKey`（不可逆地清掉 auth.json 凭证）再 `saveCustom` 写 models.json；后者失败（典型 409）时密钥已没了、配置条目还在，留下「有配置无凭证」的部分失败状态，且与 M1 同样不刷新 revision。
**触发条件**：删除带存储密钥的内置 provider 时 `saveCustom` 失败（revision 冲突或网络错误）。
**期望行为**：先写配置成功，再删密钥；或删除密钥失败/后续失败时把结果如实上报并刷新。
**实际行为**：`await call({action:"removeKey"…})` 成功后 `saveCustom(next)` 若失败，try/catch（:698-700）吞掉的只是「无已存密钥」场景，失败只弹 toast；重试删除时 `removeKey` 再空跑一次，models.json 条目因 revision 陈旧始终删不掉。
**证据**：
```
// ModelsSection.tsx:690-703
const next = { ...custom.providers };
delete next[id];
const target = providers.find((provider) => provider.id === id);
if (target?.builtIn) {
    try { await call({ action: "removeKey", providerId: id }); }
    catch { /* 无已存密钥时忽略 */ }
}
const j = await saveCustom(next);
```
**修复建议**：调整顺序：`saveCustom` 成功后再 `removeKey`；内置 provider 删除失败的提示里说明密钥仍保留、可重试。
**最小失败测试**：mock `saveCustomProviders` 返回 409 → 点击删除带密钥的内置 provider → 断言未发出 `removeKey` 请求（当前实现已发出，测试失败）。

### [MEDIUM] src/components/SessionImportSection.tsx:187-190
**问题**：导入进行中切换界面语言会中止导入：`scan` 的 useCallback 依赖 `[t]`（:185），语言切换重建 `scan` → `useEffect(..., [scan])`（:187-190）的 cleanup 把 `importController` 一并 abort。进行中的 NDJSON 导入流被掐断，失败被 `!controller.signal.aborted` 守卫吞掉（:327），不弹任何提示；服务端可能已导入一部分会话，客户端既无报告也不 `notifySessionsChanged`，侧栏与会话列表陈旧。
**触发条件**：进度条可见（导入中）时切换中文/English。
**期望行为**：i18n 变化不影响在途写操作；abort 清理只挂在组件卸载（或独立的 unmount-only effect）上。
**实际行为**：请求被 abort，`run` 的 finally 复位 `importing`，选中项保留（:324 只在成功时清空），用户看到导入进度无声消失。
**证据**：
```
// SessionImportSection.tsx:185-190
	}, [t]);

	useEffect(() => {
		void scan();
		return () => { scanController.current?.abort(); importController.current?.abort(); };
	}, [scan]);
```
```
// SessionImportSection.tsx:326-327
} catch (error) {
    if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
```
**修复建议**：把两个 controller 的 abort 清理移入独立的 `useEffect(() => () => {…}, [])` 卸载钩子；`scan` 的语言相关文案从渲染层取，避免 `scan` 随 `t` 重建。
**最小失败测试**：渲染组件 → 开始导入（流挂起中）→ 重挂 I18n Provider 换语言 → 断言导入请求未被 abort（当前实现 abort，测试失败）。

### [QUESTION] src/components/ProviderSetupModal.tsx:331-336
**问题**：自定义请求头的 value 输入框是明文 `type="text"`（apiKey 输入框是 `type="password"`，:269/:317）。用户常在此填 `Authorization: Bearer …` 一类机密头，屏幕共享/截图即泄露；且「编辑已存 header」场景下这些值经 `startEdit` 之外的路径不会回显，但添加场景是明文。
**触发条件**：添加自定义 provider 时填写任何含机密的 header。
**期望行为**：与 apiKey 同口径（password 型 + 可切换明文），或至少文档说明。
**实际行为**：明文回显到 DOM。
**证据**：`:331-336 <input className={styles.input} value={entry.value} …>` 无 type 属性（默认 text）。
**修复建议**：header 值输入框改 `type="password"` 并加显示切换。
**最小失败测试**：渲染 custom 模式弹窗，添加 header 行，断言 value 输入框 `type === "password"`。

### [QUESTION] src/components/ProxySettings.tsx:52
**问题**：代理地址输入框在「未保存任何值」时直接把自动探测到的系统代理地址显示为输入框内容（`value || address || ""`），但它只是显示兜底：不编辑就不提交（textDrafts 仍为空，PUT 不会发生），用户可能误以为已生效。改动后失焦才 commit（:54），显示值与已保存值可能长期不一致。
**触发条件**：从未保存过 httpProxy 且系统存在自动代理；用户只看不动输入框。
**期望行为**：探测地址以占位符或旁注呈现，与「已保存值」区分。
**实际行为**：探测地址填进输入框本体。
**证据**：`:52 <input … value={draft ?? (value || address || "")}`；GeneralSection.tsx:158-163 commitText 只比较 `textDrafts[field]` 与 `piSettings[field]`。
**修复建议**：改用 `placeholder={address}`，value 只绑已保存/草稿值。
**最小失败测试**：渲染无保存值 + 有探测地址的场景 → 断言 PUT /api/pi-settings 未被调用且输入框为空、placeholder 显示探测地址。
（注：该行为为 HEAD 既有代码，工作区 diff 仅替换 fetch 导入；列在此处因属指定审查点。）

### [QUESTION] src/components/settings/ModelsSection.tsx:621-630
**问题**：内置 provider 存了密钥（`secretProviderIds.has` 为真）时，用户在编辑表单里清空全部模型覆盖与 baseUrl 后保存，`withBuiltinEntry` 会写入空条目 `{}`——代码自注释承认 SDK 拒绝空条目且会令整份 models.json 写入失败（model-draft.ts:274-277）。用户卡在「清空 → 保存报错」的死角，除非先删密钥或补回一行。
**触发条件**：keyManaged 的内置 provider，清空高级设置里所有覆盖后保存。
**期望行为**：此场景等价于「清除全部覆盖」，应删除条目（密钥在 auth.json，不随条目丢失）而不是写空对象。
**实际行为**：`isInertProviderConfig({}) === true` 但 `secretProviderIds.has(providerId)` 为真 → 走 else 分支写 `{}` → 服务端 400。
**证据**：
```
// ModelsSection.tsx:623-628
if (isInertProviderConfig(config) && !secretProviderIds.has(providerId)) {
    if (!Object.prototype.hasOwnProperty.call(next, providerId)) return null;
    delete next[providerId];
} else { next[providerId] = config; }
```
**修复建议**：`secretProviderIds` 只应阻止「误删仍被密钥引用的覆盖条目」，不应阻止删除真空条目；密钥存在与否不影响 SDK 对空条目的拒绝，可改为：inert 时删除条目，密钥由服务端按「条目不存在但密钥存在」的快照逻辑保留。
**最小失败测试**：构造 secretProviderIds 含该 provider、custom.providers 无该条目 → 清空保存 → 断言请求体不含该 provider 键且保存成功。

### [QUESTION] src/components/settings/GeneralSection.tsx:165-175
**问题**：最大重试次数保存失败（网络/服务端 500）后草稿不回滚（httpProxy 的 commitText 失败会回滚，:162），输入框继续显示未保存的值，与后端真实状态漂移；非法输入只置 `settingsError("save")`，同样不还原。
**触发条件**：改最大重试次数 → 保存失败（断网/500），或输入负数/超大数后失焦。
**期望行为**：失败时把草稿回滚为 `piSettings.retry.maxRetries`，与 httpProxy 路径一致。
**实际行为**：`await patchPiSettings(...)` 返回 false 无后续处理。
**证据**：`:174 await patchPiSettings({ retry: { maxRetries: value } });`（无回滚）；对照 `:162 if (!(await patchPiSettings({ [field]: value }))) setTextDrafts(...)`。
**修复建议**：`if (!(await patchPiSettings({ retry: { maxRetries: value } }))) setMaxRetriesDraft(String(piSettings.retry.maxRetries));`
**最小失败测试**：mock PUT 返回 500 → 修改重试数并失焦 → 断言输入框恢复为服务端旧值。

## 覆盖清单

已审（diff 全读 / 文件全读）：
- 全读（未跟踪新文件）：settings/SharedControls.tsx、settings/GeneralSection.tsx、settings/ModelsSection.tsx（1178 行全文）
- 全读（diff 极小，按审查点读现文件）：update/update-store.ts、update/UpdateNotice.tsx、ProxySettings.tsx、DirectoryPicker.tsx、ProviderSetupModal.tsx（含 ModelCatalog 全文）
- diff 全读：AskUserCard.tsx（另全文核对提交/跳过路径与 AppShell `answerExtensionDialog`、usePiWeb.ts:1317-1325 的去竞争语境）、SessionImportSection.tsx + .module.css（含 run/readImportResponse 全文）、SettingsPanel.tsx（壳 + modelNotice/applyModels 状态机；删出的 2492 行确认落进 settings/*）、ProjectPanel.tsx、RemoteSection.tsx（449±，QR 配对轮询状态机全文）、DiffView.tsx（虚拟化重写）、MarkdownBlock.tsx、OutlineRail.tsx、ImageViewer.tsx、PreviewImage.tsx、DrawerPanel.tsx、FullDiff.tsx、ModelSelector.tsx、ContextMeter.tsx、PromptPanel.tsx、chat/markdown-actions.tsx、composer/PermissionSelector.tsx + .module.css、icons.tsx、TrajectoryView.tsx、TrajectoryAnalyzer.module.css
- 交叉验证后端：src/app/api/pi-settings/route.ts + src/lib/pi-settings.ts（原子写/锁/合并语义）、src/app/api/models/route.ts + src/lib/models-service.ts（409/revision/setKey/loginState/mergeCustomProviderApiKeys）、src/lib/model-draft.ts（serializeProviderDraft/fillModelFields）、src/lib/client-fetch.ts、src/lib/chat/file-path.ts、i18n key 齐备性、/api/version 路由存在性

## 未追踪清单（未完成逐行审查，共 5 项）

1. settings/SkillsSection.tsx、settings/PluginMarketplace.tsx、settings/PluginsSection.tsx — 指派给其他审查者，未读。
2. SessionImportSection.tsx 渲染尾部（约 :376-539 的报告/分组渲染区）— 仅经 diff 覆盖，未全文精读。
3. DiffView 虚拟化的交互边缘（选区跨窗口、滚动抖动、行高与字体实际渲染差异）— 读过实现，未穷举验证。
4. RemoteSection 配对后端契约（/api/remote connect、/api/remote/pair、设备吊销）— 落在 src/lib/remote/supervisor.ts、src/lib/remote/pairing.ts，属 lib 分片。
5. 更新流程的下载校验与事务回滚本体 — src/lib/update-service.ts、scripts/update-environment.mjs 等，属 lib/scripts 分片；本片只审了客户端状态机（update-store/UpdateNotice/UpdateControl），其状态机本身未发现问题。

## 各维度结论

- 设置写入路径（pi-settings）：**未发现问题**。PUT 走写锁 + 临时文件原子替换 + JSONC 结构化改写（pi-settings.ts:205-236）；compaction/retry 为节内浅合并，开关/数字单字段提交不会清掉兄弟字段（:210-211），与 GeneralSection 的 `{ compaction: { enabled } }`、`{ retry: { maxRetries } }` 补丁语义吻合；部分失败（会话刷新失败/读回失败）以 warning + readError 如实上报（route.ts:25-37）。scope 切换有 requestId + URL 双守卫（GeneralSection.tsx:71,142,148,153），且保存期间 scope 选择器被禁用，无中途改靶。
- 设置写入路径（models.json）：revision 乐观锁 + 服务端原子替换 + 密钥回填设计正确，但有 M1（409 死循环）、M4（改名丢密钥）、M5（先删密钥后写配置的部分失败）三处一致性问题。
- 更新流程（UpdateNotice/update-store 状态机）：**未发现问题**。offered 快照只在 loaded 后取一次；loadUpdates 不覆盖非 idle 项；updateAll 串行且失败即停；dismiss 按 startId 每启动提醒一次；diff 仅 localStorage→safeLocalStorage。下载校验/回滚本体未追踪（见上）。
- ProxySettings：**未发现问题**（竞态/中止）。generation 计数 + AbortController + `[value]` 变更即作废在途测试（:31-47），clientFetch 双层超时语义一致；手动地址去向 = textDrafts → PUT /api/pi-settings httpProxy（服务端 URL 校验、restartRequired 标记）；仅 Q3 显示兜底歧义。
- AskUserCard 提交竞态：**未发现问题**。提交/跳过无本地防重，但 `answerExtensionDialog` 同步把 dialog 从 state 移除（usePiWeb.ts:1319）→ 卡片卸载，双击窗口实际不存在；超时后跳过提交到已失效 id 由服务端忽略；本次 diff 为纯 UI 重排（tab→pager），未触及提交逻辑。
- SessionImportSection 部分导入一致性：流式协议设计良好（error 事件并入 warning、无 result 显式提示「请刷新查看已导入会话」、选中项仅在确认成功后清空、进度数值有边界校验）；缺陷为 M6（语言切换中止导入）。兜底工作区选择器整体移除与服务端「只导回仍存在的原项目目录」语义一致。
- ProviderSetupModal 校验与密钥回显：apiKey 均为 password 型且从不回显（编辑时 keyDraft/cKey 恒空、占位符提示已存）；ID 正则 + existingIds + validateModelDrafts + savingRef 防重提交齐备；唯一例外是自定义 header 值明文（Q2）。
- DirectoryPicker 路径处理：**未发现问题**。客户端不自拼路径（roots/list/parent 全由服务端给，选定的 path 仍由服务端 resolveWorkspacePath 校验）；`request` 自增 id + 卸载时再自增使在途响应全部作废（:60-72,89）。
- 数字输入/开关 commit 语义：pi-settings 节内合并确保不清兄弟字段（见上）；ModelsSection 容量字段 NaN 即禁存（validateModelDrafts）、体检补空只填缺失字段（fillModelFields 按位置+ID 定位、已写值不改）；GeneralSection 仅 Q5（失败不回滚草稿）。
- 其余组件（DiffView/MarkdownBlock/OutlineRail/PermissionSelector/icons/Trajectory/ImageViewer/PreviewImage/DrawerPanel/FullDiff/ModelSelector/ContextMeter/PromptPanel/markdown-actions）：**未发现问题**。PermissionSelector 的 standard→workspace 重命名有 tool-preset.ts:37 的迁移兜底；`allowDocumentParents` 仅 FileViewer 文档预览启用且服务端仍有文档根边界；clientFetch 全量替换在这些组件中均经 `.json()`/`.getReader()` 消费体，计时器会被正常清除。
