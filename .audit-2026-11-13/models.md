# 模型/供应商体系 审计报告

HEAD `1d4efba`，按当前磁盘状态审计。只读，未改任何源码/配置，未运行任何写操作。

## 0. 覆盖范围

### 读了哪些文件

| 文件 | 行数 | 读法 |
|---|---|---|
| `src/lib/models-service.ts` | 1586 | 全文逐段（1–1586） |
| `src/lib/model-draft.ts` | 427 | 全文 |
| `src/lib/model-defaults.ts` | 106 | 全文 |
| `src/lib/model-endpoint.ts` | 23 | 全文 |
| `src/lib/model-files.ts` | 33 | 全文 |
| `src/lib/provider-usage.ts` | 91 | 全文 |
| `src/lib/provider-display.ts` | 57 | 全文 |
| `src/lib/hero-model-memory.ts` | 28 | 全文 |
| `src/lib/thinking-level.ts` | 39 | 全文 |
| `src/lib/models/model-scope.ts` | 15 | 全文 |
| `src/app/api/models/route.ts` | 167 | 全文 |
| `src/app/api/models/defaults/route.ts` | 18 | 全文 |
| `src/components/settings/ModelsSection.tsx` | 1164 | 全文 |
| `src/components/ModelSelector.tsx` | 338 | 全文 |
| `src/components/ProviderSetupModal.tsx` | 740 | 全文（含 `ModelCatalog`） |
| `src/components/ProviderBrand.tsx` | 28 | 全文 |
| `src/lib/session-model-runtime.ts` | 70 | 全文（调用链需要） |
| `src/lib/settings-write-lock.ts` | 45 | 全文（写盘原子性/锁） |
| `src/lib/pi.ts` | 518 | 30–150（ModelRuntime/指纹/刷新）、245–400（资源锁） |
| `src/lib/agent-manager.ts` | 3136 | 2325–2400（refreshSessionModels / reloadSessionsForCwd）、2840–2960（setModel / setThinkingLevel） |
| `src/components/AppShell.tsx` | 1683 | 215–285、395–455（hero 默认模型 / authByProvider）、grep 定位 selectSessionModel |
| `src/hooks/usePiWeb.ts` | 1331 | 880–920、grep 定位 refreshModels 的调用点 |
| `src/components/ContextMeter.tsx` | 317 | 40–110（0 窗口除零检查） |
| `src/components/ChatInput.tsx` | — | grep 图片附件路径（无能力校验） |
| `src/proxy.ts` | 87 | 全文（认证/同源闸门，用于给安全类定级） |
| `scripts/launcher.mjs` | 545 | 130–210（代理环境注入） |
| 测试 | — | 全文读了 `models-service-config`、`models-service-auth`、`models-service-discovery`、`models-service-credentials`、`models-service-context-window`、`model-draft`、`model-audit`、`model-defaults`、`model-files`、`thinking-level`、`session-model-runtime`、`hero-model-memory`、`components/settings-model-roundtrip`、`components/session-model-catalog`；用例名清单核对了 `models-service-provider-usage`、`components/model-selector`、`components/provider-setup-modal`、`model-endpoint`、`provider-display`、`components/automation-model-scope`、`lib/models/model-scope`、`models-catalog-capabilities` |

外部只读引用（核对契约，不评价其实现）：`node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js`（`!command` 语义）、`core/model-resolver.js`（`resolveModelScopeWithDiagnostics` 走 `getAvailable`）、`core/http-dispatcher.js`（代理注入只由 pi CLI 入口调用）、`node_modules/proper-lockfile/lib/lockfile.js`（锁对不存在文件的行为）。

**未读/跳过**：`src/components/ProxySettings.tsx`（属通用设置，且 `GeneralSection` 里与模型无关）；`src/lib/pi-settings.ts` 只读了 `getEnabledModelPatterns` 相关段（其余归设置区域）。

### 结论一览

| 功能 | 结论 | 依据文件 |
|---|---|---|
| 目录来源与合并（内置 ∪ models.json ∪ 远程缓存 ∪ 扩展注册） | OK-但脆弱 | `models-service.ts:306-394`、`session-model-runtime.ts:11-65`；`tests/session-model-runtime.test.ts:52-171` 用真实 SDK 验了会话隔离与合并 |
| 目录缓存 / 失效 / 并发刷新 | OK | `models-service.ts:145-224`、`pi.ts:37-86`；指纹 `model-files.ts:8-19` |
| 目录加载失败的错误可见性 | 有问题（P1-1） | `pi.ts:75-77`；全仓无 `getError()` 消费方 |
| 自定义 provider 写盘（原子性/并发/防写坏） | OK（注释与格式会丢：P2-2） | `models-service.ts:1495-1545`、`settings-write-lock.ts`；`tests/models-service-config.test.ts:208-277` |
| API key 存储（经 SDK 写 `~/.pi/agent/auth.json`） | OK | `models-service.ts:402-414`、`tests/models-service-auth.test.ts` |
| API key 回显到前端 | 有问题（P2-3：只脱敏 `apiKey`，`headers` 明文回显） | `models-service.ts:1404-1413` |
| 端点与鉴权头推断 | OK（覆盖较硬） | `models-service.ts:585-686`、`468-479`；`tests/models-service-discovery`、`-credentials` |
| 能力判定：contextWindow / reasoning / thinking | OK-但脆弱 | `models-service.ts:117-143`、`model-draft.ts:1-176`、`thinking-level.ts` |
| 能力判定：vision | 有问题（P2-4：能力不进聊天 UI，附件不校验） | `route.ts:38-40`、`ChatInput.tsx:530-540` |
| 能力判定：tool 支持 | 说不清（PiWeb 完全没有这个维度） | 无对应字段/分支（见 P2-4 末尾） |
| 默认模型（新会话） | OK-但脆弱 | `model-defaults.ts:68-105`、`tests/model-defaults.test.ts`（与 SDK 默认表逐项对表） |
| per-session 覆盖 / 切到不存在的模型 | OK | `agent-manager.ts:2904-2916`（找不到就报错，不崩） |
| 切模型时的会话状态（历史/工具/思考档位/用量） | OK | `agent-manager.ts:2909-2916`（换模型对象 + 重算档位 + 失效用量缓存 + 重发状态）；`tests/session-model-runtime.test.ts:64-65` 验了会话间模型隔离与未知模型返回 `ok:false`；"历史是否保一致"由 SDK 的 session manager 承担，未在本区域展开 |
| 用量统计口径（`provider-usage`） | OK-但脆弱（口径本身正确，见 P3-1/P3-2） | `provider-usage.ts`、`models-service.ts:688-1166`、`tests/models-service-provider-usage.test.ts` |
| 错误路径（密钥错/网络/4xx/限流/超大响应/重定向/私网） | OK | `models-service.ts:504-560`、`641-685`（错误文案逐条给人看） |
| 错误路径（代理） | 疑似有问题（P2-7） | `models-service.ts:511-516` vs `scripts/launcher.mjs:149-177` |
| OAuth 多步登录状态机（取消/超时/替换） | OK（这区域最扎实的一块） | `models-service.ts:1170-1362`、`tests/models-service-auth.test.ts`（11 个用例全断言） |

## 1. 发现（按严重度降序，同级按影响降序）

### P1-1 共享目录刷新失败被完全吞掉，模型目录会静默残缺且没有任何提示

- **位置**：`src/lib/pi.ts:64-78`（吞错处）、`src/lib/models-service.ts:1484-1493`（反证：`ModelRuntime.create()` 是"不抛错、把错误记在 `getError()` 里"的）
- **证据**：

```ts
// src/lib/pi.ts:70-77
	try {
		const runtime = await pending;
		reloadStoredCredentials(runtime);
		await runtime.refresh({ allowNetwork: false });
		await refreshSessionModelRuntimes(runtime);
	} catch {
		if (modelRuntimePromise === pending) modelRuntimePromise = null;
	}
```

```ts
// src/lib/models-service.ts:1484-1492 —— PiWeb 自己也是靠 getError() 判断配置坏没坏的
	const runtime = await ModelRuntime.create({ modelsPath: file, ... });
	const error = runtime.getError();
	if (error) throw new CustomProvidersValidationError(error);
```

全仓 grep `getError()` 只有这一处（`models-service.ts:1491`）与 `growth-tracker.ts` 的无关同名方法；**共享运行时 `getModelRuntime()` 的 `getError()` 从未被读过**，`GET /api/models` 也没有任何"目录加载失败"的字段。

- **触发路径**：用户手改 `~/.pi/agent/models.json`（或 pi 终端/其它工具写坏一份）→ 打开 PiWeb → `listModels()` 先 `refreshModelRuntimeIfFilesChanged()`（`models-service.ts:212`，指纹变了就刷）→ `pi.ts` 把刷新异常吞掉并把 promise 置空 → 下一次 `getModelRuntime()` 重建运行时 → `ModelRuntime.create()` 对坏配置**不抛错**，只把错误记进 `getError()` → `listModelsUncached` 照常返回（大概率只剩内置目录）。
- **后果**：设置页模型页顶部可能还显示着 models.json 里的自定义供应商（`readCustomProviders` 是直接读文件、不过 SDK，`models-service.ts:1455-1462`），但聊天里的模型选择器里这些模型全部消失，页面与日志都没有一句话。用户唯一的线索是"模型不见了"。反过来，如果坏得连 JSONC 都过不了，设置页会 500 并弹"models.json JSONC 无效"（`tests/models-service-config.test.ts:296-302` 覆盖），两种失败的用户体验完全不一致。
- **置信度**：已确认（吞错链与 `getError()` 无消费方都已读全）；后果的严重程度取决于 SDK 在 `modelsPath` 坏掉时保留多少目录 —— 需实测：写一份 `{"providers":{"x":{"baseUrl":1}}}` 到 `~/.pi/agent/models.json`，再看 `GET /api/models` 的返回与 `runtime.getError()`。
- **建议修法**：`listModelsUncached` 里读一次 `rt.getError()`，塞进返回的 `providers/models` 之外的字段（如 `catalogError`），由 `ModelsSection`/选择器显示一行可操作提示；`pi.ts` 的 `catch` 至少 `console.warn` 一次并保留错误文本。

### P1-2 认证探测失败被当成"未认证"并缓存 60 秒，整家 provider 的模型从选择器里静默消失

- **位置**：`src/lib/models-service.ts:317-351`（探测与缓存）、`src/app/api/models/route.ts:41-43`（精简目录只带 `authReady`）、`src/components/AppShell.tsx:400-406`、`src/components/ModelSelector.tsx:123`
- **证据**：

```ts
// src/lib/models-service.ts:331-347
			if (auth?.configured === true || authFastPath) {
				const cached = sessionRuntime ? undefined : authCheckCache.get(pid);
				if (cached && Date.now() - cached.at < AUTH_CHECK_TTL_MS) { ... }
				else {
					try {
						const checked = await rt.checkAuth(pid, { signal: AbortSignal.timeout(5000) });
						authReady = checked !== undefined;
						resolvedAuthSource = checked?.source;
					} catch (error) {
						authError = error instanceof Error ? error.message : String(error);
					}
					if (!sessionRuntime) authCheckCache.set(pid, { at: Date.now(), ready: authReady, source: resolvedAuthSource, error: authError });
				}
			}
```

```ts
// src/components/ModelSelector.tsx:120-123
		for (const entry of models) {
			if (authByProvider[entry.provider] === false) continue;
```

```ts
// src/components/AppShell.tsx:402-404
		for (const p of models?.providers ?? []) {
			auth[p.id] = p.authReady === true;
```

- **触发路径**：OAuth 型 provider（anthropic / openai-codex / github-copilot / kimi-coding 等，`checkAuth` 可能触发令牌刷新）在一次网络抖动/代理不通时进入 `catch` → `authReady` 保持 `false`，`authError` 记下原因，**这个 false 被缓存满 60 秒**（`AUTH_CHECK_TTL_MS`，`models-service.ts:159`）。精简目录（非 `full`/`custom` 请求）只回 `{id,name,authReady,builtIn,modelCount}`，`authError` 不下发（`route.ts:43`）。
- **后果**：用户什么都没做，那家 provider 的模型在选择器里整体消失（不是变灰，是不出现在列表里），最长 60 秒；同一时刻设置页里同一家 provider 的红点 tooltip 才写着真实原因。选择器里没有任何"此供应商因认证探测失败被隐藏"的说明。
- **置信度**：已确认（代码链路完整）。是否真的会因网络抖动进入 `catch`，取决于各 provider `checkAuth` 的实现；可验：断网后把某 OAuth provider 的 expiry 改到过去，观察 `GET /api/models` 里该 provider 的 `authReady/authError`。
- **建议修法**：区分三态（`ready` / `unauthenticated` / `probe-failed`）；`probe-failed` 时不隐藏模型（只降级为可选项展示），并把 `authError` 带进精简目录，让选择器分组标题显示"认证状态未知"。

### P2-1 `enabledModels` 作用域与默认模型两套口径：选择器可能空白，而新会话照样给出一个模型

- **位置**：`src/lib/models-service.ts:227-239`、`src/lib/models/model-scope.ts:6-14`、`src/lib/model-defaults.ts:68-72`
- **证据**：

```ts
// src/lib/models-service.ts:230-238 —— 过滤后不判空、不回退
	const patterns = await getEnabledModelPatterns();
	if (!patterns?.length) return data;
	const models = await filterModelsByPiScope(data.models, patterns, runtime ?? await getModelRuntime());
	const counts = new Map<string, number>();
	...
	return { models, providers: ... };
```

```ts
// src/lib/model-defaults.ts:69-72 —— 同一份 patterns，空了就往下走到默认表
	if (input.patterns.length > 0) {
		const { scopedModels } = await resolveModelScopeWithDiagnostics(input.patterns, runtime);
		if (scopedModels.length > 0) return scopedModels[0].model;
	}
```

- **触发路径**：`~/.pi/agent/settings.json` 写 `"enabledModels": ["anthropic/*"]`，而用户只有 deepseek 的密钥。`resolveModelScopeWithDiagnostics` 内部走的是 `modelRuntime.getAvailable()`（SDK `core/model-resolver.js:295`，已按凭证过滤），所以 scoped 为空：新会话页按第二步/第三步给出别的模型；而选择器因为 `filterModelsByPiScope` 返回空数组，**一个模型都列不出来**。`resolveModelScopeWithDiagnostics` 返回的 `diagnostics`（"No models match pattern …"，`core/model-resolver.js:240`）在两处都被丢掉。
- **后果**：设置页能看到全部模型、聊天里一个都选不了；也没有任何提示指向 `enabledModels`。新会话页显示"建议模型 X"，输入框却因为没有可选项而卡住，用户无从判断是配置问题还是程序坏了。
- **置信度**：已确认（两条链路都读了，SDK 语义也核对了）。
- **建议修法**：`filterModelsByPiScope` 返回 `{models, diagnostics}`；为空时在 `GET /api/models` 里带上 `scopeWarnings`，选择器/设置页各显示一条"enabledModels 未匹配到任何可用模型"。

### P2-2 通过设置页保存任何一次，`models.json` 里的注释、尾逗号与 BOM 就被永久抹掉

- **位置**：`src/lib/models-service.ts:1404-1413`（读时重排）、`1455-1462`、`src/components/settings/ModelsSection.tsx:308`、`542`
- **证据**：

```ts
// src/lib/models-service.ts:1404-1413
export function redactCustomProviderSecrets(content: string): { content: string; secretProviderIds: string[] } {
	const parsed = parseCustomProviders(content);
	...
	return { content: JSON.stringify(parsed, null, 2), secretProviderIds };
}
```

```ts
// src/components/settings/ModelsSection.tsx:542 —— 浏览器把整份文件原样写回
		const result = await request({ action: "saveCustomProviders", revision: customRevision, content: JSON.stringify(next, null, 2) });
```

- **触发路径**：文件是 JSONC（`parseCustomProviders` 特意 `allowTrailingComma: true`，错误文案也自称 "models.json JSONC 无效"，`models-service.ts:1383-1387`）→ `GET /api/models?custom=1` 返回的 `customProviders.content` 已经被 `JSON.stringify` 重排 → 用户在设置页改任一字段并保存 → 落盘是纯 JSON。注释、尾逗号、BOM、键序全部丢失。
- **后果**：用户在 `models.json` 里手写的注释（"这个 baseUrl 是公司内网"之类）在一次无关保存后消失；这是不可逆的用户数据丢失，但文件语义不变。注意 `tests/models-service-config.test.ts:85` 的用例标题写着 "round-trips BOM, comments, trailing commas…"，而断言只检查了 `opaque` 字段与密钥不被执行（第 98-102 行）——**用例名承诺的东西没有被断言**，容易让人误以为注释是保留的。
- **置信度**：已确认（读路径与写路径都读了，测试也核对了）。
- **建议修法**：要么在读路径上用 `jsonc-parser` 的 `applyEdits` 保留原文只做点补丁（改动大）；要么在设置页首次保存前明确告知"将以标准 JSON 重写 models.json，注释会丢失"，并把测试名改成它真正断言的内容。

### P2-3 只脱敏 `apiKey`：自定义请求头里的密钥明文回显到浏览器

- **位置**：`src/lib/models-service.ts:1404-1413`、`src/app/api/models/route.ts:32`+`48`、`src/lib/model-draft.ts:183-186`
- **证据**：

```ts
// src/lib/models-service.ts:1406-1411 —— 只删 apiKey 一个字段
	for (const [id, provider] of Object.entries(parsed.providers)) {
		if (!Object.prototype.hasOwnProperty.call(provider, "apiKey")) continue;
		delete provider.apiKey;
		secretProviderIds.push(id);
	}
```

```ts
// src/app/api/models/route.ts:32+48
		const customProviders = custom ? await readCustomProviders() : null;
		...
		{ success: true, data: { providers, models, customProviders, ...(catalogModelIds ? { catalogModelIds } : {}) } }
```

```ts
// src/lib/model-draft.ts:183-186
	/** Blank means unchanged. Redacted secrets are restored by the server, never invented here. */
	apiKey?: string;
	/** 自定义请求头（models.json 的 `headers`）。undefined = 未加载/不表态，{} = 明确清空 */
	headers?: Record<string, string>;
```

- **触发路径**：网关类自定义供应商常把密钥放在 `headers`（`Authorization: Bearer sk-…`、`x-api-key: …`），这在本功能里是被支持的（`ProviderSetupModal.tsx:318-350` 就是给用户填"自定义请求头"的；`models-service.ts:609-621` 还会把它们发给上游做目录探测）。`GET /api/models?custom=1` 把整份（已重排的）`models.json` 原样下发，`headers` 的值不在脱敏范围内。
- **后果**：密钥进入浏览器内存、DevTools 的 Network 面板，以及任何能读页面响应的浏览器扩展；同一份文件里同样敏感的值却被特意删掉了——两把同类钥匙一把上锁一把没上，说明这是遗漏而非设计。
- **置信度**：已确认（脱敏函数与响应体都读了；`tests/models-service-discovery.test.ts:174-185` 只断言 `apiKey`，没有 `headers` 用例）。
- **建议修法**：`redactCustomProviderSecrets` 同时收集 `headers` 里的值（至少对 `authorization`/`*-key`/`*-token` 之类名字）打码，回写时沿用现有"缺失即保留旧值"的合并策略；或至少给 `secretProviderIds` 加一个 `secretHeaderNames`。

### P2-4 vision / tool 能力在聊天侧完全没有出口：贴图时没人知道这个模型收不收图

- **位置**：`src/app/api/models/route.ts:38-43`（精简目录）、`src/lib/models-service.ts:29-40`（`ModelView.input` 存在但不下发）、`src/components/ChatInput.tsx:530-540`（贴图不判能力）
- **证据**：

```ts
// src/app/api/models/route.ts:38-43
		const models = full
			? data.models
			: data.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevels: m.thinkingLevels, contextWindow: m.contextWindow }));
```

```ts
// src/components/ChatInput.tsx:530-540
		if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) {
			...
			changeDraft((previous) => previous.images.length >= 20 ? previous : { ...previous, images: [...previous.images, image] });
```

- **触发路径**：用户在自定义供应商下加一个只声明 `input: ["text"]`（或干脆不写 `input`）的模型 → 在聊天里贴图发送。PiWeb 侧没有任何"该模型不支持图片"的检查：精简目录里根本没有 `input`/`vision` 字段，选择器组件 `ModelChoice`（`ModelSelector.tsx:10-17`）也没有这个概念。
- **后果**：PiWeb 自己的注释（`model-draft.ts:8-9`、`21-23`）说得很清楚：`input` 没写时 "pi 会当成只文本、把贴图换成占位文字"，提示语还会说"模型不支持图像"。也就是说图片被静默丢弃、模型只能看到占位文字，用户会以为是模型能力问题。若上游自行拒绝，则是 400。工具支持同理：PiWeb 对"这个模型能不能调工具"零建模，给不支持 tool 的模型挂上工具集时没有任何前置提示（后果未确认，见"说不清"）。
- **置信度**：已确认代码缺口；具体症状（占位文字 vs 400）依赖 pi 内核，属**疑似**，验证方法：自定义一个 `{"id":"x","input":["text"]}` 的模型，贴图后看落库消息里的 content 是否被替换。
- **建议修法**：精简目录加 `vision: boolean`（`input.includes("image")`），`ChatInput` 在附件按钮/发送前禁用并提示；`tool` 同理至少给一条"该模型未声明工具支持"的提示。

### P2-5 `models.json` 是"配置即执行"的文件：PiWeb 打开模型设置页时就会执行它里面的 `!command`

- **位置**：`src/lib/models-service.ts:426-450`（凭证解析）、`317-351`（每次建目录都 `checkAuth`）、`1527-1545`（整份文件由客户端内容覆盖）
- **证据**：

```ts
// src/lib/models-service.ts:426-431
/**
 * 该 provider 当前生效的凭证，和 SDK 发请求时同一套解析（ModelRuntime.getAuth）：运行时 key → auth.json
 * （OAuth 快过期会先刷新并写回）→ models.json 的 apiKey（$ENV / ${ENV} / !command 照样解析）→ 环境变量。
 */
```

SDK 侧核对（`node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js:66-69,123-127,130-171`）：值以 `!` 开头时走 `executeCommand`，Windows 用配置的 shell，其它平台 `execSync(command)`，`timeout: 10000`。

- **触发路径**：`models.json` 里 `providers.gw.apiKey = "!op read op://x/key"`（1Password 这类用法是 SDK 明确支持的）或某个 `headers` 值以 `!` 开头 → 打开设置-模型页 `GET /api/models?custom=1` → `listModelsUncached` 对每个已配置 provider `checkAuth`（`models-service.ts:340`）→ SDK 解析凭证 → **在 PiWeb 的 node 进程里执行那条命令**。`configuredCredentialFor`（用量探测）同样走 `getAuth`。
- **后果**：① 打开设置页/点"刷新额度"就等于执行用户配置里的任意 shell 命令，这条路径不经过 pi 的工具权限、沙箱、审批（对比工具调用的 `permission-*.ts`/`sandbox/*`）；② `saveCustomProviders` 接受浏览器给的整份 `content` 并落盘（`models-service.ts:1527-1545`），等于给这个执行面开了一个 HTTP 写入口。当前有同源校验（`src/proxy.ts:24-26`，非只读方法必须同源）与可选 Cookie 认证，所以不是可被第三方页面利用的洞；但在 `PI_WEB_AUTH` 未开启（默认，`src/lib/web-auth.ts:44-47`）时，任何能连到该端口的本地进程都能写入 —— 它们本来也能通过 agent 跑命令，所以不算提权，**但"写配置文件"这条后门绕过了沙箱与确认流程**。
- **置信度**：已确认（PiWeb 注释 + SDK 源码双向核对）。命令是否在 `checkAuth` 里触发，取决于 provider 的 auth 实现是否调用 `resolve`；`configuredCredentialFor` 那条是确定的。
- **建议修法**：在设置页对 `apiKey`/`headers` 里的 `!` 前缀给出明确提示（"保存后会在本机执行该命令"），并在 `writeCustomProviders` 里对新增的 `!` 值要求二次确认；把这条通道写进沙箱/权限区域的威胁模型（见第 3 节）。

### P2-6 会话内点一下模型下拉就会冷启动 agent（起扩展 / MCP / session_start）

- **位置**：`src/lib/agent-manager.ts:2904-2909`，对照 `2929-2945` 的相反设计
- **证据**：

```ts
// src/lib/agent-manager.ts:2904-2909
			case "setModel": {
				const session = await ensureSession(m);
				const rt = session.modelRuntime;
				const model = rt.getModels(cmd.provider).find((x) => x.id === cmd.modelId) as any;
				if (!model) return { ok: false, error: `unknown model ${cmd.provider}/${cmd.modelId}` };
				await session.setModel(model, { persist: false });
```

```ts
// src/lib/agent-manager.ts:2935-2939 —— 同文件里换工具档位刻意避免冷启动
				if (!m.session && !m.creating) {
					// 冷会话只记下选择，等真正启动时（ensureSession → applyToolPolicy）再生效。
					// 不能为了切个档位就冷启动 agent：打开会话时前端会恢复保存的档位，
					// 若这里 ensureSession，光是浏览历史会话就会跑一遍扩展的 session_start。
```

- **触发路径**：打开一个**未启动**的历史会话（`m.session` 为空），在顶部 `ModelSelector` 里选一个模型 → `AppShell.tsx:747` `sendCommand({cmd:"setModel"})` → `ensureSession(m)`。
- **后果**：仅浏览历史会话、只想换个模型，就会创建 AgentSession：跑扩展 `session_start`、可能拉起 MCP 服务器、读工作区资源，可能耗时数秒到数十秒，且会触发扩展的副作用（工作区未信任时还会走信任流程）。同一文件里换工具档位为了同一个理由刻意不冷启动，两条路径行为不一致。
- **置信度**：已确认（`ensureSession` 的语义在同文件 2935-2941 的注释里被作者自己解释过）。实际耗时/副作用规模需 bridge 区域确认（见第 3 节）。
- **建议修法**：冷会话只记 `m.pendingModel`（像 `toolPreset` 那样），真正发消息时再 `ensureSession` 并应用；前端选择器可以照常立刻回显。

### P2-7 模型目录探测是全项目唯一不跟随代理的 HTTP 客户端（疑似）

- **位置**：`src/lib/models-service.ts:504-516`
- **证据**：

```ts
// src/lib/models-service.ts:511-516
	return new Promise<Response>((resolve, reject) => {
		const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
			headers,
			signal,
			agent: false,
			lookup: allowed ? undefined : (hostname, options, callback) => { ... },
```

```js
// scripts/launcher.mjs:139-143,168-171 —— 让 Node 的 fetch / http 认代理环境变量
 *  2. 让 Node 的 fetch / http 认这些变量（NODE_USE_ENV_PROXY）——默认它们是被忽略的。
		if (supported) {
			if (!String(childEnv.NODE_USE_ENV_PROXY ?? "").trim()) childEnv.NODE_USE_ENV_PROXY = "1";
```

- **触发路径**：用户只能经代理出网（PiWeb 已在 `applyProxyEnv` 里给服务进程设了 `HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY=1`）→ 设置页点"获取可用模型" → `discoverModels` → `requestModelCatalog` 显式 `agent: false`（自己建连接、且绕开 Node 内置代理 agent 的默认路径）。
- **后果**：若该组合确实绕过代理，则"获取可用模型"恒定失败并提示"无法连接模型目录，请检查 API 地址和网络"（`models-service.ts:678-681`），而聊天与用量探测都正常——用户完全无法理解。注意用量探测走的是全局 `fetch`（`models-service.ts:736-751`），在 `NODE_USE_ENV_PROXY=1` 下是跟着代理走的，两条探测路径不一致本身也是隐患。
- **置信度**：疑似。验证方法：设 `HTTPS_PROXY` 指向一个必须经代理的地址（或无代理环境下访问被墙主机），对比 `discoverModels` 与 `providerUsage` 的成功率；或直接看 Node 版本对 `agent:false` + `NODE_USE_ENV_PROXY` 的行为。另外要请 bridge 区域确认 SDK 侧模型请求是否也依赖同一套环境变量。
- **建议修法**：`requestModelCatalog` 改用全局 `fetch`（和用量探测一致），或显式从 pi 设置读 `httpProxy` 并传 `agent`；至少在两处探测失败文案里加一句"若需代理，请检查设置里的代理"。

### P2-8 保存模型配置后，选择器不会刷新（提示只是一条 2.4 秒的 toast）

- **位置**：`src/app/api/models/route.ts:100`、`src/components/settings/ModelsSection.tsx:502-505`、`src/hooks/usePiWeb.ts:912-916`+`1008`
- **证据**：

```ts
// src/app/api/models/route.ts:100
			return NextResponse.json({ success: true, data: { requiresSessionReopen: true } });
```

```ts
// src/hooks/usePiWeb.ts:912-916 —— 只在切会话时主动拉目录；否则等 SSE 的 "model"/"resources" 事件
	useEffect(() => {
		setModels(null);
		void refreshModels();
		return () => { modelRequestRef.current += 1; };
	}, [refreshModels]);
```

- **触发路径**：设置页保存自定义 provider → 服务端 `writeCustomProviders` 已 `refreshModelRuntime` + `reloadSessionsForCwd`（`models-service.ts:1540-1544`）→ 前端只重置自己的 `customRevision` 并 `load()`（设置页数据），聊天侧 `usePiWeb.models` 依赖 SSE `model`/`resources` 事件才会重拉（`usePiWeb.ts:1008`）。
- **后果**：`requiresSessionReopen` 恒为 `true`（不管改的是不是需要重开的东西），toast 只显示 2.4 秒；若 SSE 事件因为会话正忙/未订阅而没到（`reloadSessionsForCwd` 对忙会话只置 `resourceReloadPending`，`agent-manager.ts:2372-2377`），用户会以为新模型没保存成功。等不到事件时只能靠刷新页面。
- **置信度**：已确认（两条刷新链路都读了）；"事件到不到"取决于会话状态，属边界。
- **建议修法**：`saveCustomProviders` 成功后让前端主动 `refreshModels()`（`usePiWeb` 已导出它，`usePiWeb.ts:1317`）；`requiresSessionReopen` 只在确实需要的场景返回 `true`。

### P3-1 用量面板不显示探测时间

- **位置**：`src/lib/models-service.ts:691-706`（服务端算了 `probedAt`）、`src/components/settings/ModelsSection.tsx:443-475`（渲染时不用）
- **证据**：`ProviderUsage` 三个变体都带 `probedAt: number`（`provider-usage.ts:28/46/57`），全仓 grep `probedAt` 的每一处命中都在服务端或类型定义里，`ModelsSection` 一次都没读。
- **后果**：服务端缓存 5 分钟、前端只在挂载时自动取一次（`ModelsSection.tsx:396-404`），面板开着不动时余额/配额可以无限陈旧，但界面上没有任何时间戳，用户会当成实时数据。xAI 那条（会真实发一次计费请求）尤其容易误导。
- **置信度**：已确认。**建议修法**：在配额行尾显示 `probedAt` 的相对时间。

### P3-2 「哪些 provider 支持用量探测」有两份硬编码名单

- **位置**：`src/lib/provider-usage.ts:74-91`（`USAGE_PROBE_PROVIDER_IDS`，被测）、`src/lib/models-service.ts:709-724`（`usageProbeFor` 的 switch，实际执行方，无对照测试）
- **证据**：前者是数组 + `supportsUsageProbe`，后者是 `switch (providerId)`，两处都要手工同步；`tests/models-service-provider-usage.test.ts:231-243` 只测了数组。
- **后果**：加/删一家时若只改一处，会出现"UI 显示用量行但服务端返回 null（永远空白）"或"服务端能探测但 UI 不显示"。**建议修法**：让 `usageProbeFor` 直接从同一张表派生（表里放探测函数），或加一条对照测试。

### P3-3 编辑自定义 provider 时改 ID 不校验格式、可静默覆盖同名 provider

- **位置**：`src/components/settings/ModelsSection.tsx:624-647`（编辑保存），对照创建时 `src/components/ProviderSetupModal.tsx:109-110`（`CUSTOM_PROVIDER_ID_PATTERN` + 查重）
- **证据**：

```ts
// src/components/settings/ModelsSection.tsx:631-641
			const next = { ...custom.providers };
			const previousId = editing ?? cId.trim();
			const previous = next[previousId] ?? {};
			if (previousId !== cId.trim()) delete next[previousId];
			next[cId.trim()] = serializeProviderDraft(previous, { ... });
```

`ModelsSection` 的 import 里没有 `CUSTOM_PROVIDER_ID_PATTERN`（第 10-14 行）。
- **后果**：把 A 改名成 B（已存在的另一家）时，B 的配置（含 `apiKey`、models）被整条覆盖且无确认；改名成 `__proto__` 时 `next["__proto__"] = …` 走的是 `Object.prototype` 的访问器（此时 `next` 上没有这个自有键），写进的是原型而不是数据键 —— 随后 `JSON.stringify` 看不到它，**该 provider 连同它在 models.json 里的 `apiKey` 一起静默消失**（`mergeCustomProviderApiKeys` 只对存在于 incoming 里的 id 恢复旧密钥，`models-service.ts:1415-1427`）。改成含空格之类的非法 ID 则由 SDK 校验拒绝（保存失败但不损坏文件）。**置信度**：已确认（代码）；触发需要用户手改 ID，概率低。**建议修法**：复用 `CUSTOM_PROVIDER_ID_PATTERN` + 与 `existingIds` 查重，`__proto__` 用 `Object.defineProperty` 或 Map 中转。

### P3-4 落盘失败的原始错误直出，崩溃会残留含密钥的 `.tmp`

- **位置**：`src/lib/models-service.ts:1506-1524`、`165`（route 的错误直出）、`1571-1574`
- **证据**：临时文件名 `${file}.${process.pid}.${uuid}.tmp` 写在 agent 目录里，`finally` 里 `fs.rm` 清理（1506/1523）；进程被强杀时清理不会执行。路由统一 `String(err?.message ?? err)` 返回。
- **后果**：① `EPERM: operation not permitted, rename 'C:\Users\…\models.json.1234.….tmp'` 这类原文会直接显示在中文界面里；② 崩溃残留的 `.tmp` 含 `apiKey`（`mode 0o600`，但 Windows 上 mode 基本无效）。**建议修法**：对 `rename/EPERM/EACCES` 给一句中文可操作文案；启动时清理同 pattern 的 `.tmp`。另外 `setModelContextWindow` 在加锁前先用共享运行时查模型（1574），手改 `models.json` 后立刻调用会误报"找不到模型"，补一次 `refreshModelRuntimeIfFilesChanged()` 即可。

### P3-5 记住的 hero 模型失效后不回退，思考档位回退到全档位

- **位置**：`src/components/AppShell.tsx:241-258`（记忆与兜底）、`421-428`
- **证据**：

```ts
// src/components/AppShell.tsx:254-258
	useEffect(() => {
		const suggested = heroDefaults?.model;
		if (!heroCwd || !suggested) return;
		setHeroModel((current) => current ?? suggested);
	}, [heroCwd, heroDefaults]);
```

- **后果**：工作区记住的模型被删/改名后，`heroChoice` 为 `undefined`（`421-423`），但 `current ?? suggested` 不会覆盖一条"非空但已失效"的记忆，新会话页停在"请选择模型"，`heroDefaults.model` 这条兜底对它无效；同时 `heroModelLevels` 会回退到全 8 档（`425-428`），让用户以为这个不存在的模型支持 `xhigh`/`max`。**建议修法**：`heroChoice` 为空时调用 `setHeroModel(suggested ?? null)`，`heroModelLevels` 回退到 `["off"]`。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| `listModels()` / `listModelsUncached()` 的目录组装 | 本区域最核心的聚合逻辑，**零直接测试**：provider 排序、`apisByUsage` 顺序、`builtIn` 判定、`authReady/authError` 三态、5 秒 listCache 与 60 秒 authCheckCache 的失效 | 用假 runtime + 冻结时钟测：缓存命中/失效、`invalidateModelList` 后重建、并发两次请求只探测一次 |
| `models.json` 坏掉时的用户可见行为 | P1-1 的后果完全没测 | 写坏文件后 `GET /api/models` 返回什么、是否带错误字段 |
| `enabledModels` 作用域为空时的行为 | P2-1 | `filterModelsByPiScope` 空结果、以及它与 `pickInitialModel` 的口径差异 |
| JSONC 注释保留 | P2-2，现有用例名与断言不符 | 保存后断言 `models.json` 文本里仍有 `// 注释` |
| `headers` 里的密钥脱敏 | P2-3 | `redactCustomProviderSecrets` 对 `headers.Authorization` 的处理 |
| vision 能力到聊天 UI 的通路 | P2-4 | `GET /api/models`（精简）是否带 `vision`；贴图给 text-only 模型时的行为 |
| `requestModelCatalog` 与代理的交互 | P2-7 | 设 `HTTPS_PROXY` 后目录探测是否走代理（或明确断言"不走"并文档化） |
| `setModelContextWindow` 的并发/陈旧目录 | `contextWindowOf` 在加锁前读共享运行时（`models-service.ts:1574`），手改 models.json 后立刻调用会误报"找不到模型" | 手改文件 → 不刷新 → 直接 `setModelContextWindow` |
| 配额/余额探测的 `probedAt` 新鲜度 | 服务端 5 分钟缓存 + 前端只在挂载时取一次，界面无时间戳 | 断言 UI 显示"探测时间"，或断言超过 TTL 会重取 |

## 3. 与其他区域的可能交叉点

1. **bridge（`agent-manager.ts` / `pi.ts`）**：P2-6 的 `setModel → ensureSession` 冷启动规模、`reloadSessionsForCwd` 对忙会话只置 pending（`agent-manager.ts:2372-2377`）导致 P2-8 的模型目录不刷新，都需要 bridge 确认；另外请确认 PiWeb 服务进程是否真的让 SDK 的模型请求走了代理（`http-dispatcher.js` 的 `applyHttpProxySettings/configureHttpDispatcher` 只由 pi CLI 的 `main.js` 调用，`src/` 里无人调用，`bin/`/`scripts/` 也只设了环境变量）——这决定 P2-7 的实际影响面。
2. **sandbox/权限**：P2-5 的 `!command` 通道（`models.json` 的 `apiKey`/`headers`）由 SDK 在宿主 node 进程直接 `execSync`，不经过 pi 的工具权限与沙箱。请把"写配置文件"当作一条命令执行通道纳入威胁模型。
3. **API/鉴权**：`POST /api/models` 的 12 个 action 全部无内建鉴权，全靠 `src/proxy.ts` 的 Host/同源/Cookie 三道闸门；`saveCustomProviders` 接受整份任意 JSON（只过 SDK schema）。我按"同源闸门有效"给它定级；若 API 区域认为 `allowPrivate` 类参数或整文件写入还需要额外的入参约束，请裁定。另外 `GET /api/models?full=1` 会返回约 400KB 全量目录（含 `baseUrl`/`cost`），目前无按需限制。
4. **crosscut（i18n / 错误提示）**：`ModelsSection` 里多处直接显示原始异常文本（`String(err.message)`，如 `route.ts:52/165`），落盘失败时会露出英文 Node 错误原文（如 `EPERM: operation not permitted, rename 'C:\Users\…\models.json.1234.tmp'`），包含绝对路径。是否统一包装归 crosscut/API 区域。
5. **remote/automation**：`listWorkspaceModelsForPiWeb`（`models-service.ts:242-271`）为自动化工作区每次请求创建一个临时 `ModelRuntime` 再释放，`AutomationModal.tsx:122` 会调它；高频打开自动化面板时是否会积累句柄，请 automation 区域确认（`createSessionModelRuntime` 内部有 `active` Map，只有 `release` 才算干净）。

## 4. 建议优先修的 3 件事

1. **让目录加载失败可见（P1-1 + P1-2）**：把 `runtime.getError()` 和认证探测的 `probe-failed` 三态带到 `GET /api/models` 的响应里，选择器/设置页各显示一行可操作提示。这两条都是"用户什么都没做，模型就不见了"的静默失败，且都不需要改动 SDK 契约，是投入产出比最高的一修。
2. **补齐密钥与能力的出口口径（P2-3 + P2-4 + P2-2）**：`headers` 的密钥按 `apiKey` 同一套规则脱敏；精简目录补 `vision` 字段并在贴图时拦住；保存前明确告知 `models.json` 会被重写成纯 JSON（或改用 `applyEdits` 保留注释）。这三条都是"已经写了防护/文档，但只覆盖了一半"的一致性问题，改动局部。
3. **把 `models.json` 当执行面处理（P2-5）**：对 `apiKey`/`headers` 的 `!` 前缀给出保存前确认与显式文案，并在文档/威胁模型里登记这条绕过沙箱的命令通道；顺带把 P2-6 的冷启动换模型改成"先记下、发消息时生效"，避免浏览历史会话就拉起 MCP 与扩展。

## 附：本区域最大的未知点

- **pi 内核对能力的实际兜底**：`input` 不含 `image` 时到底是"换成占位文字"（PiWeb 注释的说法）还是上游 400；`tool` 不支持时是拒绝还是忽略。这两点决定了 P2-4 的最终严重度，需要一次真实发消息验证。
- **各家的 `/models` 与用量端点真实字段**：`catalogCapabilities`（`models-service.ts:117-143`）与 12 个用量解析器都是照各家文档/实测写的，本环境无法联网核对；尤其 xAI 的 `x-ratelimit-*` 只认 4 个头全在，缺一个就整体返回 `null`（`models-service.ts:1159`），一次 header 改名就静默失去整块面板。
- **`models.json` 的并发写者**：PiWeb 用 `models.json.lock`（proper-lockfile）串行化自己人，但 SDK dist 里没有任何写 `models.json` 的入口（只在 `config.js:522` 暴露了路径），pi 终端若有第三方扩展写这个文件，不会认这把锁；这条只能靠实际运行观察。
