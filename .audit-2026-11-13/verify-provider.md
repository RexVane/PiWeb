# 能力表 / 用量解析器 / 端点与市场：联网核对报告

- 日期：2026-11-13（本机时区 Asia/Shanghai）
- 执行：子代理 `verify-provider`（补审计缺口：这些"照文档写"的实现从未联网核对过）
- 结论一句话：**本机有外网，全部核对已完成。** 能力表的数据源（pi 内置目录＝models.dev 快照）本身是准的，抽样 10/10 一致；真正的问题在**解析规则覆盖面**——`catalogCapabilities` 在 opencode / opencode-go / Vercel AI Gateway / Anthropic 这四家真实目录上读不到字段，实测 opencode 86 个模型里 **85 个上下文窗口会被按 128000 落盘**、**71 个支持图片的模型会被判成纯文本**；用量侧 11 个探测里只有 3 个能在公开文档里逐字段对上，Anthropic 放着**文档化的 `anthropic-ratelimit-*` 响应头没用**，去读未文档化的 OAuth 端点；市场侧"非 pi 包混进结果"**未能复现**（250/250 都带 `pi-package`，npm 的 `keywords:` 是硬过滤）。

## 0. 边界、合规与网络环境

| 项 | 状态 |
|---|---|
| 用户真实密钥 | **未读、未用**。没打开 `~/.pi/agent/auth.json`，没读任何含 key 的环境变量（只列了 `*_PROXY` / `NPM_CONFIG_*` / `PI_WEB_*` 名字匹配的变量）。所有请求均为**未认证**请求（无 `Authorization`、无 `x-api-key`、无 `?key=`） |
| 仓库 | 未改任何源码/配置；未 `git` 写；未访问/未改 30141 服务 |
| 临时脚本 | `%TEMP%\piweb-verify-provider\` 下 12 个 `.mjs` 与抓取样本，跑完已删（回收站） |
| 外网 | **可用**。`HTTP_PROXY/HTTPS_PROXY` 环境变量为空；WinINET 系统代理为 `127.0.0.1:7897`（已启用，端口在监听），但 Node 的 `fetch`/`http.request` **默认不认系统代理**（见 §3.2） |

复现用的公开命令（不需要 key）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models            # 401
curl -s https://openrouter.ai/api/v1/models | head -c 200                            # 200（字段最全的免鉴权目录；Vercel/opencode/nvidia 也公开但字段少）
curl -s 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=3'    # 200
```

---

## 1. 能力表比对（`catalogCapabilities`）

### 1.1 它到底依赖什么（读码结论）

`src/lib/models-service.ts:117-143` 只服务一件事：把**某个 endpoint 的 `/models` 响应条目**翻译成 `DiscoveredModel`（`id/name/contextWindow/maxTokens/vision/reasoning`）。它不是读 models.dev，也不是读 pi 内置目录。

| 目标字段 | 依次尝试的字段名 | 真实世界里谁长这样 |
|---|---|---|
| `contextWindow` | `context_window` → `context_length` → `max_input_tokens` → `architecture.context_length` | Vercel AI Gateway（`context_window`）、OpenRouter（`context_length`）、Anthropic `/v1/models`（`max_input_tokens`）、本机中转（`context_window`） |
| `maxTokens` | `max_output_tokens` → `max_completion_tokens` → `top_provider.max_completion_tokens` | LiteLLM 风格（`max_output_tokens`）、OpenRouter（`top_provider.max_completion_tokens`） |
| `vision` | `modalities` / `architecture.input_modalities` / `input_modalities` 数组里**精确等于** `"image"` | OpenRouter（`architecture.input_modalities`）、models.dev 形状（`modalities.input`）、Vercel（`modalities.input`） |
| `reasoning` | `reasoning`/`supports_reasoning` 布尔 → `capabilities.reasoning` 布尔 → `capabilities.thinking.supported` 布尔 → `supported_parameters` 里有 `reasoning*` | OpenRouter（`supported_parameters`）、Anthropic（`capabilities.thinking.supported`）、部分网关（`capabilities.reasoning` 布尔） |

下游兜底（缺字段时的实际取值，**已核对 SDK 源码**）：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:96-114`：`contextWindow ?? 128000`、`maxTokens ?? 16384`、`input ?? ["text"]`、`reasoning ?? false`。
- `src/lib/model-draft.ts:36` 里 PiWeb 自己也写了同一组兜底常量 `PI_MODEL_FALLBACKS`。
- `reasoning=false` 的后果不是"少一个开关"：`provider-composer.js:102` + `models-service.ts:72-77` 的注释——思考档位整个消失，`thinkingLevelMap` 不生效。

### 1.2 数据源核对：pi 内置目录 = models.dev 快照

| 证据 | 观察到 |
|---|---|
| `https://models.dev/api.json`（未认证 GET） | HTTP 200，6,123,895 B，**236 个 provider / 9,136 个模型**，CF cache HIT |
| `node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json` | `generatedAt: 2026-11-10T12:05:37Z`，42 个 provider 数据文件、结构哈希齐全 |
| pi-ai README:1950 | 明写"把 models.dev 的 `type: "decision"` 映射到 `ClassifierModel`…hydrate 按 API 分组 `src/providers/data/<id>.json`"——即目录由 models.dev 生成 |
| 两边的交集逐条比对（1011 个同名模型） | 上下文窗口一致 964 条、**不一致 47 条**；输出上限不一致 22 条；vision 不一致 **3 条**；reasoning 不一致 **3 条** |

**结论：能力表的"数据"没有编造，是 3 天前的 models.dev 快照。** 差异方向值得单独说（下表），因为它决定"少算一半上下文"的锅在谁头上。

抽样 10 条（pi 内置 vs 现场 models.dev，2026-11-13）：

| provider / model | pi 内置 | models.dev 现场 | 一致？ | 谁对 |
|---|---|---|---|---|
| anthropic / claude-opus-4-5 | 200000 / 64000 / text+image / reasoning | 200000 / 64000 / text+image+pdf / true | ✅ | 一致 |
| openai / gpt-5 | 400000 / 128000 / text+image / true | 400000 / 128000（`limit.input` 272000）/ text+image / true | ✅ | 一致 |
| google / gemini-2.5-pro | 1048576 / 65536 | 1048576 / 65536 | ✅ | 一致 |
| xai / grok-4.3 | 1000000 / 30000 / text+image | 1000000 / 30000 / text+image+pdf | ✅ | 一致 |
| moonshotai / kimi-k2.6 | 262144 / 262144 / text+image | 262144 / 262144 / text+image+video | ✅ | 一致（pi 不认 video，符合其能力模型） |
| groq / llama-3.3-70b-versatile | 131072 / 32768 / text / r=false | 131072 / 32768 / text / false | ✅ | 一致 |
| deepseek / deepseek-flash | 1000000 | 1048576 | ❌ −4.6% | models.dev（1 MiB 是 2^20） |
| openai / gpt-5.4 | 272000 | 1050000（`limit.input` 922000） | ❌ −74% | models.dev；pi 明显没跟上 |
| github-copilot / claude-opus-4.8 | 1000000 | 200000（copilot 条目） | ❌ | **pi 对**：models.dev 的 `canonical_model_id=anthropic/claude-opus-4-8` 自己写的也是 1000000 |
| opencode / claude-sonnet-4-5 | 200000 | 1000000（opencode 条目） | ❌ | **pi 对**：canonical `anthropic/claude-sonnet-4-5` 是 200000，是 models.dev 的 opencode 条目写错了 |

差异归类（47 条上下文不一致）：

- **pi 偏小、可能提前压缩**：openai 系列 10 条（`gpt-5.4/5.5/5.6-*`、`gpt-6-*` 全部 pi=272000 而实际 1050000）、deepseek 2 条（1e6 vs 1048576）、mistral-large-latest 1 条（262144 vs 1048576）。
- **pi 偏大、可能上游 400**：无（github-copilot 那 6 条是 models.dev 写错，按 canonical 判断 pi 对或仅差 5%）。
- 其余是多一两个 token 的取整差（`1048575` vs `1048576`）。

→ **对审计的意义**：`P1-18` 说的"目录残缺"是**可用性/错误吞掉**问题，与"能力值对不对"是两件事；数据层面 pi 目录 ≈ models.dev，没有系统性造假。真正系统性的是下一节。

### 1.3 把解析规则套在真实公开目录上（这一节是本报告的主结论）

5 个 endpoint 都是**未认证可拿**的真实响应，逐条喂给 `catalogCapabilities` 的逐字复制品：

| 端点（未认证） | HTTP | 条数 | ctx 命中 | vision 命中 | reasoning 命中 | maxTokens 命中 | 备注 |
|---|---|---|---|---|---|---|---|
| `https://openrouter.ai/api/v1/models` | 200 | 472 | **472** | **472** | 355 | 466 | 规则本来就是照它写的，命中率最好 |
| `https://ai-gateway.vercel.sh/v1/models` | 200 | 511 | 372 | 511 | 281 | **0** | 输出上限字段叫 `max_tokens`（471 条有值），解析器不认；99 条非对话模型 `context_window: 0` 被 `>0` 判空（合理） |
| `https://opencode.ai/zen/v1/models` | 200 | 86 | **0** | 86（其中真为 true 的只有 2） | **0** | **0** | 形状是 models.dev 式：`limit.context` / `limit.output` / `capabilities.reasoning.supported`(对象) / `modalities.input: ["text","image/jpeg",…]` |
| `https://opencode.ai/zen/go/v1/models` | 200 | 30 | **0** | 30（true 1 个） | 0 | 0 | 同上；22 个模型用 `image/jpeg` 这类 MIME 表示视觉 |
| `https://integrate.api.nvidia.com/v1/models` | 200 | 83 | 0 | 0 | 0 | 0 | 只有 `id/object/created/owned_by`（OpenAI 规格），**四项全空**是正常的 |

把 opencode 两家的差距量化（这就是"贴图被丢掉"和"上下文少算"的实测口径）：

| provider | 模型数 | 端点自报 ctx > 128000（会被低估） | 真支持图片但被判纯文本 | 判对 |
|---|---|---|---|---|
| opencode | 86 | **85** | **71** | 2 |
| opencode-go | 30 | **30** | **21** | 1 |

例子：`opencode/big-pickle` 自报 `limit.context: 200000` → 解析器读不到 → SDK 落 128000（少 36%）；`opencode-go/grok-4.7` 自报 500000、`muse-spark-1.2-contributor` 自报 1048576 → 都落 128000（少 74%/88%），且 `modalities.input` 里是 `image/jpeg` 而非 `image` → `vision: false`。

### 1.4 与官方文档 schema 的比对（大厂目录到底给不给能力）

| 来源 | 文档 | 观察到 | 与解析器的差 |
|---|---|---|---|
| OpenAI `/v1/models` | <https://developers.openai.com/api/reference/resources/models/methods/list.md> | 返回只有 `id` / `created` / `object` / `owned_by` / `shutdown_date`，**没有任何能力字段** | 不是解析器的锅；任何照 OpenAI 规格实现的中转站（one-api/new-api 等）在 PiWeb 里探索出来都只有 ID |
| Anthropic `/v1/models` | <https://platform.claude.com/docs/en/api/models/list.md> | 稳定版文档已含 `max_input_tokens`、`max_tokens`、`capabilities.thinking.supported`、**`capabilities.image_input.supported`**、`capabilities.pdf_input`、`capabilities.effort.*` | `max_input_tokens` ✅ 命中；`thinking.supported` ✅ 命中；**`capabilities.image_input` 不认 → vision 丢**；**`max_tokens` 不认 → 输出上限丢** |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1/models`（公开，实测） | `context_window` / `max_tokens` / `modalities.input` / `reasoning_options` / `tags` | `max_tokens` 不认；其余可用 |
| opencode / opencode-go | 上面两个公开端点 | models.dev 式（`limit.*` / `capabilities.*`） | 除 `modalities.input` 外**全不认** |
| models.dev `api.json` 本体 | <https://models.dev/api.json> | 9,136 个模型全用 `limit.context`、`limit.output`、`modalities.input`、`reasoning: bool` | 套用本解析器：**ctx 命中 0 / maxTokens 命中 0**、vision 命中 9136、reasoning 命中 9136 |

### 1.5 影响判断（值得单独进审计的）

1. **上下文少算 → 提前压缩**：opencode 家族 85/86、opencode-go 30/30、任何 models.dev 式或只给 `limit.context` 的网关。`gpt-5.4/5.5/5.6` 这类内置模型也有 pi 目录自身偏小的问题（272000 vs 1050000），属另一条线。
2. **视觉误判 → 截图被静默丢掉**：证据链完整——`pi-coding-agent/dist/core/tools/read.js:59-62`：`if (!model || model.input.includes("image")) {…} return "[Current model does not support images. The image will be omitted from this request.]"`；`openai-completions` 等 API 层也是 `model.input.includes("image")` 才拼 `image_url`。所以 `input: ["text"]` 写错就是**用户贴的图被换成一行占位文字**，且提示语会说"模型不支持图像"（用户会以为是自己模型的问题）。
3. **推理能力丢失 → 思考档位消失**：opencode 的 `capabilities.reasoning` 是**对象** `{supported:true}`，解析器只认布尔 → 86 个模型全部 reasoning 未声明 → 落 `false` → 无 thinking 档位。
4. **发现流程不过滤模型类型**：`discoverModels` 只按 `id` 去重再 `slice(0,500)`（`models-service.ts:660-672`），不判 `type`。Vercel 的 511 条里 326 条是 `language`，其余 185 条是 `image/video/embedding/rerank/speech/transcription/realtime/evaluation`（实测，非推测）。用户点"获取可用模型"会拿到一批**不能聊天**的模型，选中后请求必然 400/404。（OpenAI 官方 `List models` 文档只说"当前可用模型 + owner/availability"，没有承诺只有对话模型，故不据它下结论。）

> 注意方向性：以上是"**发现/新增自定义模型**"链路的损失。内置 provider 的模型走 pi 内置目录，值是对的（§1.2）。所以定级不要写成"所有模型上下文都少算"，应限定为"经 `设置 → 获取可用模型` 落盘的新模型"。

---

## 2. 用量解析器（`provider-usage.ts` + `models-service.ts` 的探测）

先纠正一个计数：`provider-usage.ts` 只有类型与纯函数（91 行，客户端安全），**真正的解析器全在 `models-service.ts`**；探测名单是 11 个 provider（`provider-usage.ts:75-87`），对应 **10 个 JSON 载荷解析器 + 1 个响应头解析器**（xAI）。

### 2.1 逐个核对

| # | provider | 端点（未认证实测状态） | 读的字段 | 公开文档核对结果 |
|---|---|---|---|---|
| 1 | `xai` | **POST** `https://api.x.ai/v1/chat/completions`（405 于 GET，存在） | 4 个响应头 `x-ratelimit-{limit,remaining}-{requests,tokens}` | **xAI 官方 Rate Limits 文档（<https://docs.x.ai/developers/rate-limits.md>）通篇没有列任何 `x-ratelimit-*` 响应头**，只写 429 + 分级 RPS/TPM 表。头名与 OpenAI 文档一致（<https://developers.openai.com/api/docs/guides/rate-limits.md> 的 `x-ratelimit-limit-requests` 等）。→ 头名不算错，但**"照文档写"不成立**，只能靠 OpenAI 兼容惯例 |
| 2 | `openai-codex` | `https://chatgpt.com/backend-api/wham/usage`（401） | `rate_limit.primary_window/secondary_window` 的 `limit_window_seconds`、`used_percent`、`reset_at`、`plan_type` | **无公开文档**（ChatGPT 内部 backend-api）。`planTypeFromAccessToken` 读 JWT 的 `https://api.openai.com/auth` 声明也属未文档化 |
| 3 | `anthropic` | `https://api.anthropic.com/api/oauth/usage`（401，报"需要 x-api-key"） | `five_hour` / `seven_day` / `seven_day_opus` 的 `utilization`(0-100)、`resets_at` | **端点未文档化**，字段无从核对。但**同一份官方文档明确给了可用替代**：<https://platform.claude.com/docs/en/api/rate-limits> 的 `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` + `anthropic-priority-*` + `anthropic-fast-*`，`reset` 是 RFC3339、`remaining` 是"四舍五入到千"。代码注释（`models-service.ts:846-848`）说的 `anthropic-ratelimit-unified-*` 在这个页面里**根本不存在** |
| 4 | `deepseek` | `https://api.deepseek.com/user/balance`（401） | `balance_infos[0].{currency,total_balance,granted_balance,topped_up_balance}` | ✅ 逐字段对上：<https://api-docs.deepseek.com/api/get-user-balance>（全是 string，含 `is_available`）。**未读 `is_available`** → 余额不足时只显示 0.00、不显示"不可用"；**只取 `balance_infos[0]`** → 多币种账户会丢其它币种 |
| 5 | `openrouter` | `https://openrouter.ai/api/v1/key`（401） | `data.{limit,usage,limit_remaining}` | ✅ 字段名对：<https://openrouter.ai/docs/api_reference/limits.md>。**但文档新增了 `budgets[]` / `effective_budget`**（guardrail/workspace/组织预算，`remaining_usd`/`resets_at`）→ 现在的解析器只认 key 级额度，组织预算型账户会显示"累计已用"而不是剩余 |
| 6 | `moonshotai` / `moonshotai-cn` | `https://api.moonshot.ai/v1/users/me/balance` / `.cn` 同路径（401，两个都通） | `data.{available_balance,voucher_balance,cash_balance}`、`status===false` 判失败 | ✅ 字段名与 `status: boolean` 都对上：<https://platform.kimi.ai/docs/api/balance.md>（.ai 站单位为 USD）。**币种映射 `.cn → CNY` 无公开文档可核**（CN 站文档这次没取到正文），属未验证假设 |
| 7 | `kimi-coding` | `https://api.kimi.com/coding/v1/usages`（401） | `usages.{limit_5h,limit_7d,limit_month_total,limit_month_code}` 的 `used_ratio`(0-1)、`reset_time` | **无公开文档**（Kimi Code 订阅侧接口） |
| 8 | `github-copilot` | `https://api.github.com/copilot_internal/user`（401） | `quota_snapshots.{premium_interactions,chat,completions}.{percent_remaining,has_quota,unlimited}`、`copilot_plan`、`quota_reset_date` | **无公开文档**（GitHub 内部端点，VS Code 自用） |
| 9 | `vercel-ai-gateway` | `https://ai-gateway.vercel.sh/v1/credits`（401） | `total_used`、`balance` | 未取到公开文档正文（Vercel 站点），**字段名未验证** |
| 10 | `opencode-go` | `https://opencode.ai/zen/go/v1/usage`（401） | `usage.{rolling,weekly,monthly}.percent`、`resetsAt` | **无公开文档**；注意 `/zen/go/v1/models` 是公开的（200），只有 usage 要鉴权 |
| 11 | （helper）`planTypeFromAccessToken` | 本地解析 JWT | `chatgpt_plan_type` | 未文档化，但纯本地、无副作用 |

### 2.2 值得一提的行为细节

- **"缺一个头就整体返回 null"（`models-service.ts:1154-1159`）**：xAI 要求恰好 4 个数字头全在，任一缺失/非数字 → 整个 xAI 用量卡片消失（不是显示部分）。影响面比看起来小（卡片本来就只有 4 个数、没有窗口时长/reset），但**失败无任何提示**，与 P1-18 同一种"静默"病。更值得注意的是它**每次探测都发一次真实 `POST /v1/chat/completions`（`max_tokens: 1`）**：会消耗一次请求额度（TPM/RPM 计入），按量计费账户还会产生费用；缓存 5 分钟，每开一次设置页不一定命中缓存。
- **没有响应体上限**：`fetchUsageJson`（`:736-751`）直接 `response.json()`，与目录探测的 4 MiB 上限（`:481`、`:563-575`）不一致（P2-33 属实，但实测所有端点返回都是小 JSON，无分页，实际风险低）。
- **单位口径混乱但都有注释说明**：Anthropic `utilization` 是 0-100（`parseAnthropicUsagePayload`）、Kimi `used_ratio` 是 0-1（`parseKimiCodingUsagePayload`）、Copilot `percent_remaining` 是 0-100 剩余。逐条看**没有乘除错**，`remainingFromUsed()` 与 `Math.round(100 - used)` 处理正确。
- **窗口时长是硬编码常量**：`5*h`、7d、30d 全在代码里（`:865-867`、`:1008-1011`、`:1075-1078`）。Codex 走的是端点自报 `limit_window_seconds`（:`800`），但 Anthropic/Kimi/OpenCode 都是猜的标签；如果服务端改了周期，UI 会理直气壮地标错。
- **`quotaWithPlanOnly`（`:754-756`）是唯一的降级路径**，只用在 Codex；其它 provider 端点失败 = 整块空白。

### 2.3 对"缺一个头就整体 null"的定级建议

不构成 P1：它不改变任何请求行为、不丢数据、不误导方向（不显示 vs 显示错的数字，前者更安全）。但**必须**和 P1-18 归为同一类"探测失败静默"问题，否则修了 P1-18 的三态，这里还是黑箱。建议：`probe-failed` 态下用量区显示"探测失败（端点未返回限额头）"，而不是整块不渲染。

---

## 3. 端点与市场

### 3.1 未认证可达性矩阵（全部直连、无代理、2026-11-13）

| provider | URL | 状态 | 判读 |
|---|---|---|---|
| openai | `api.openai.com/v1/models` | **401** | 通，鉴权正常（`Missing bearer authentication`） |
| anthropic | `api.anthropic.com/v1/models` | **401** | 通（`x-api-key header is required`） |
| google | `generativelanguage.googleapis.com/v1beta/models` | **403** | 通；`Method doesn't allow unregistered callers`。Key 走 `?key=`/`x-goog-api-key`，PiWeb 发的是 `Authorization: Bearer`（`models-service.ts:627-635`）→ **Google 的目录探测在实现层面就不可能成功** |
| xai | `api.x.ai/v1/models` | **401** | 通（`unauthenticated:no-credentials`） |
| deepseek | `api.deepseek.com/models` | **401** | 通 |
| moonshotai / -cn | `api.moonshot.ai|.cn/v1/models` | **401 / 401** | 通；`.ai` 曾出现 1 次 `ECONNRESET`（TLS 握手前断开），重试 3/3 成功 → 直连偶发 RST |
| openrouter | `openrouter.ai/api/v1/models` | **200** | 公开目录，472 条 |
| groq / mistral / together / fireworks / zai / kimi-coding / cerebras | `…/v1/models` | **401 / 401 / 401 / 401 / 401 / 401 / 403** | 全部通，鉴权正常 |
| github-copilot | `api.githubcopilot.com/models` | **400** | 通（`missing required Authorization header`） |
| vercel-ai-gateway | `ai-gateway.vercel.sh/v1/models` | **200** | 公开目录，511 条 |
| opencode / opencode-go | `opencode.ai/zen[/go]/v1/models` | **200 / 200** | 公开目录，86 / 30 条 |
| nvidia | `integrate.api.nvidia.com/v1/models` | **200** | 公开目录，83 条 |
| openai-codex | `chatgpt.com/backend-api/models` | **401** | 通 |
| usage: deepseek-balance / openrouter-key / moonshot-balance(±cn) / anthropic-oauth / codex-wham / copilot-internal / vercel-credits / opencode-go / kimi-coding | 见 §2.1 | **401 全数** | 全部端点存在且鉴权正常 |
| usage: xai chat | `api.x.ai/v1/chat/completions` (GET) | **405** | 端点存在（只接受 POST） |

> 没有 DNS/TLS/证书层面的不可达，也没有任何一家需要靠代理才能连。**唯一"通但没有公开目录"的是 Google**（403 是鉴权类型不匹配，不是网络问题）。

### 3.2 代理行为（实测，和 P2-31 直接相关）

| 观察 | 结果 |
|---|---|
| 环境变量 | `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` **均未设置**；只有 `PI_WEB_TRUSTED_HOSTS` |
| Windows 系统代理 | `HKCU\…\Internet Settings`：`ProxyEnable=1`、`ProxyServer=127.0.0.1:7897`、`ProxyOverride` 含内网段；`127.0.0.1:7897` 在监听；`netsh winhttp show proxy` = Direct |
| 直连 vs 系统代理（curl 对照） | `registry.npmjs.org` 200/200、`models.dev` 200/200、`api.moonshot.ai` 401/401、`api.openai.com` 401/401 —— **两者都通**，代理快 0.3–0.9 s |
| `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=http://127.0.0.1:9`（故意指向死端口） | `fetch()` → **ECONNREFUSED**（说明 fetch 确实走环境代理）；`https.request(..., { agent: false })` → **401，直连成功**（说明 `http.request` 完全无视环境代理） |

**结论（P2-31 复核：成立，且比原文更严重）**：`models-service.ts:504-560` 用 `https.request` + `agent: false` 自建连接，`scripts/launcher.mjs:149-177` 设的 `NODE_USE_ENV_PROXY=1` 对它无效。所以：

- 在**只能走代理**的网络（企业代理、需科学上网的环境）里，`设置 → 获取可用模型` 必定失败，而同一进程里 `fetch()` 系的用量探测、市场搜索都正常 → 用户会看到"用量能读、模型探索失败"的诡异组合。
- 代码里没有任何代理分支；私网黑名单（`:483-502`）是对的、DNS 重解析防 SSRF 也是对的，但**代理是唯一被漏掉的传输层**。
- 定级：与 P1-17（配了 `httpProxy` 但模型请求不生效）**同源同后果**。建议合并为一条 P1「代理覆盖不全」：热应用不生效（P1-17）+ 目录探测不跟随（P2-31），或者至少把 P2-31 升 P1。

### 3.3 插件市场：非 pi 包能否混进结果

`plugins-marketplace.ts:484-488` 拼的查询是 `keywords:pi-package <分类词> <用户词>`，`:513` 直接打 `registry.npmjs.org/-/v1/search`，`:522-528` **不做任何本地校验**（`:452` 反而把 `pi-package` 从关键词里删掉）。

实测（默认 `all` 分类，size=24，各查询的返回集）：

| 查询 text | 返回条数 | 其中**没有** `pi-package` 关键词的 |
|---|---|---|
| `keywords:pi-package` | 24 | **0** |
| `keywords:pi-package mcp` | 24 | **0** |
| `keywords:pi-package theme` | 24 | **0** |
| `keywords:pi-package react` | 24 | **0** |
| `keywords:pi-package keywords:react` | 12 | **0** |
| `keywords:pi-package author:sindresorhus` | 0 | — |
| `keywords:pi-package -keywords:pi-package` | 24 | **0**（负向 qualifier 无效） |
| `keywords:pi-package`（size=250） | 250 | **0** |
| 反证：`keywords:zzzznotakeyword` | 0 | — |
| 反证：`pi-package`（**无** qualifier） | 24 | **1** |

→ **npm 的 `keywords:` qualifier 是硬过滤，"非 pi 包混进结果"这次复现不出来**（翻到 250 条仍是 0 泄漏）。P2-73 的前半句（"把 pi-package 从关键词里删掉却从不校验"）描述的实现事实正确，但**推出的风险不成立**：漏的是本地二次校验，不是结果可以脏。

另外三点实测：

1. **分类词与用户词只影响排序/收窄，不破坏过滤**：`react` 仍返回 pi 包；`author:`、`keywords:` 这类 DSL 片段会被原样接受——`author:sindresorhus` 直接把结果清零。所以"搜索词原样拼进 DSL"属实、可利用（能自我 DoS、能把结果换成别的关键词子集），但**逃不出 `pi-package` 过滤**。
2. **`total` 不可信但没人看**：`keywords:pi-package` 报 `total: 13697`，而 `from=13700` 仍返回 250 条（分页被忽略）→ 这个数字是模糊计数。`MarketplaceSearchResult.total` 一路透传到前端，但 `PluginMarketplace.tsx:268` 显示的是 `count: items.length`，**用户看不到 13697**，属于死字段。
3. **兼容性检测走的是"搜索时的 latest 版本"**：`:572` 拉 `registry.npmjs.org/<name>/<version>`，`source: npm:<name>`（`:471`）安装时解析最新 → 若两次之间发了新版，判定版本 ≠ 安装版本（P2-74 属实，本节未做安装实测）。

---

## 4. 对审计报告（`PiWeb_Audit_2026-11-13.md`）措辞与定级修正

| 编号 | 原文措辞 | 建议改成 | 定级 |
|---|---|---|---|
| **P1-18** | "模型目录会静默残缺：刷新失败被完全吞掉，认证探测失败被当成未认证并缓存 60 秒" | **保留**（代码事实已复核：`:334-346` 失败仍写缓存、`AUTH_CHECK_TTL_MS=60_000`）。**追加 (c) 一条**：能力字段解析覆盖面窄导致的"值残缺"——经发现流程落盘的模型按 `128000/16384/text-only/reasoning=false` 写死（SDK `provider-composer.js:96-114`、PiWeb `model-draft.ts:36`），实测 opencode 85/86 上下文低估、71 个视觉模型被判纯文本。两者都是"静默"，但修复点完全不同（一个是错误传播，一个是字段映射） | **P1 保持**；把能力字段作为 P1-18(c) 或另立 **P2「能力字段映射覆盖窄」** |
| 新增（本节建议） | — | "`catalogCapabilities` 漏读 `limit.context`/`limit.output`/`max_tokens`/`capabilities.image_input`/`capabilities.reasoning`(对象)/`image/*` MIME；发现流程不过滤 `type`（Vercel 511 条里 185 条非对话模型会被当聊天模型列出）" | **P2**（有明确用户可见后果：提前压缩、截图被丢弃、思考档位消失、选到不能用的模型） |
| **P2-29** | "vision/tool 能力在聊天侧完全没有出口：贴图时不判'这个模型收不收图'" | 改成："**PiWeb 侧**没有发送前判断/提示；**pi 运行时会**按 `model.input` 决定——`core/tools/read.js:59-62` 把图片换成 `[Current model does not support images…]`，API 层也是 `input.includes("image")` 才拼 `image_url`。所以能力值错了的后果是**静默丢图 + 提示语归因错误**，不是'没出口'"。删掉"tool"（`tool` 字段从来没人解析，属另一条：`catalogCapabilities` 根本不产出 tool 能力） | **P2 → P3**（能力值错配的风险已在新条目里覆盖；这里只剩"缺少预发提示"） |
| **P2-31** | "模型目录探测是全项目唯一不跟随代理的 HTTP 客户端（`agent:false` 自建连接，**疑似**）" | 去掉"疑似"，给实测：`NODE_USE_ENV_PROXY=1` + 死端口代理下 `fetch()` 立刻 ECONNREFUSED 而 `https.request({agent:false})` 直连成功。补充"后果分裂"：同进程里用量探测/市场搜索走 `fetch` 跟随代理，只有模型探索不跟随 → 只走代理的网络里功能半残 | **P2 → P1**（或与 P1-17 合并为一条"代理覆盖不全" P1） |
| **P2-33** | "用量探测没有响应体上限，与目录探测的 4 MiB 口径不一致" | 保留事实，补一句实测：11 个用量端点返回均为小 JSON（无分页），现网风险低，属加固项 | **P2 → P3** |
| **P2-73** | "市场不校验结果真是 pi 包（把 `pi-package` 从关键词里删掉却从不校验），搜索词原样拼进 npm 查询 DSL" | 拆开：①"非 pi 包混进结果"**未复现**——`keywords:` 是 npm 端硬过滤，250/250 返回都带关键词，`-keywords:`/`author:`/嵌套 `keywords:` 都逃不掉，本地不校验属"防御性缺失"不是"现网泄漏"；②"搜索词原样进 DSL"属实——用户词可追加 `author:`/`keywords:` 等 qualifier 把结果清零或换子集（自行 DoS，无跨租户影响）；③`total:13697` 与分页行为不符但是死字段（UI 显示 `items.length`） | **P2 → P3** |
| **P2-74** | "兼容性判定用的版本 ≠ 实际安装的版本" | 本节未做安装实测，不修正措辞；仅补充证据点：兼容性拉的是 `registry/<name>/<version>`（搜索时的 latest），安装 spec 是 `npm:<name>`，中间发版即漂移 | 维持 **P2** |
| 用量相关（新增建议） | — | "Anthropic 放着**文档化**的 `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` 不用（且注释里引用的 `anthropic-ratelimit-unified-*` 在官方页面不存在），去读未文档化的 `/api/oauth/usage`，导致 API-key 用户（`probeAnthropicUsage` 要求 `oauth`）永远没有用量；xAI 每次探测发一次真实 chat 请求（计入配额/费用）且 4 个头缺一即整体不显示" | **P2**（功能缺口清晰、修法确定：直接解析响应头、零额外请求） |

### 附：本次核对**没有**覆盖到的（不要当成已验证）

- 任何需要鉴权的响应**体**（`/models` 成功形态、`/wham/usage`、`/api/oauth/usage`、`/copilot_internal/user`、`/v1/credits`、`/zen/go/v1/usage`、`/coding/v1/usages`）——按边界不发带 key 的请求，字段只能靠文档或留空说明。
- `moonshotai-cn` 的 CNY 币种假设（CN 站余额文档正文这次没取到）。
- 市场"安装后真实装上哪个版本"的端到端行为。
- 30141 服务的任何接口（未访问）。
