# 设置 / i18n / 主题 / 提示词 / 自动更新 审计报告

## 0. 覆盖范围

**读了（全读，行号用 read 工具口径）**

- `src/components/settings/GeneralSection.tsx`（430）、`src/components/settings/SharedControls.tsx`（262）、`src/components/SettingsPanel.tsx`（109）
- `src/i18n.tsx`（2175：结构 + provider 尾部 + 设置/提示词相关词条；并对 zh(8–1081) / en(1084–2146) 两段做了程序化 key/占位符比对）
- `src/lib/theme.ts`（175）、`src/lib/pi-settings.ts`（200）、`src/lib/settings-write-lock.ts`（45）、`src/lib/enter-behavior.ts`（40）、`src/lib/clipboard.ts`（27）、`src/lib/prompt-sources.ts`（255）
- `src/components/PromptPanel.tsx`（322）、`src/components/ProxySettings.tsx`（64）、`src/lib/proxy-status.ts`（90）
- `src/app/api/config/route.ts`（22）、`pi-settings/route.ts`（25）、`prompts/route.ts`（52）、`update/route.ts`（49）、`version/route.ts`（8）、`proxy/route.ts`（22）
- `src/lib/version.ts`（6）、`src/lib/semver.ts`（39）、`src/lib/update-service.ts`（242）、`src/lib/update/startup-check.ts`（117）、`src/components/update/{UpdateNotice.tsx(130),update-store.ts(155),CopyCommand.tsx(34)}`
- 交叉核实（只为核对 PiWeb 调用是否正确）：`src/lib/pi.ts:400-460`、`src/lib/agent-manager.ts:2338-2361`、`src/app/layout.tsx`、`src/app/page.tsx`、`src/components/AppShell.tsx:330-380`、`scripts/launcher.mjs:95-164`、`scripts/process-runner.mjs:1-60`、`scripts/release.mjs`（结构 + `prepareRelease` 事务）、`src/app/globals.css` 相关块（`:root` 101-121、`@media (prefers-color-scheme: dark)` 123-145、`[data-pebrel-theme]` 2575-2800）；pi SDK 侧（per BRIEF 允许）`dist/core/settings-schema.d.ts`、`settings-defaults.js`、`settings-manager.js:117-179,405-520`、`agent-session.d.ts:479-500 / agent-session.js:1298-1303,2279-2296`、`core/http-dispatcher.js:38-90`、`dist/index.d.ts`
- 测试：`tests/pi-settings.test.ts`(257)、`tests/prompt-sources.test.ts`(220)、`tests/theme-color-meta.test.ts`(36) 全读；`tests/components/{prompt-panel,settings-typography,update-notice}.test.tsx`、`tests/{update-service,update-service-route,update-service-process,update-startup-check,semver}.test.ts` 读了用例清单

**跳过**：`ModelsSection.tsx`(54979B)、`PluginsSection.tsx`、`SkillsSection.tsx`、`PluginMarketplace.tsx`（按 BRIEF/任务边界归 models / plugins 区域）；`hooks/useDialog`、`hooks/useSelectKeyboard`、`CustomSelect`、`ConfirmDialog`（crosscut）；`~/.pi` 用户配置一个字节都没碰（测试用临时 agent 目录）。

**结论一览**

| 子功能 | 结论 | 依据文件 |
|---|---|---|
| settings.json 读改写与原子性 | OK-但脆弱（锁内重读 + temp+rename；但权限/fsync/重排见 P3-6） | `pi-settings.ts:172-199`、`settings-write-lock.ts:23-34` |
| 并发写锁（同进程 / 跨进程） | OK（与 pi 的 proper-lockfile 协议一致，测试有真子进程验证） | `settings-write-lock.ts:9-34`、pi `settings-manager.js:126-178`、`pi-settings.test.ts:104-165` |
| 写坏用户配置的风险与恢复 | OK（解析失败拒写并 500，文件不被覆盖） | `pi-settings.ts:68-77,176`、`pi-settings.test.ts:59-78` |
| 设置项 ↔ 后端读取（"假配置"） | 有问题：网络代理一行假（P1-1）；面板值可能是被项目级覆盖前的值（P2-1） | 见 P1-1 / P2-1 表 |
| i18n 覆盖度 | OK-但脆弱（类型强制 key 对齐；有残留英文与死键，P3-2） | `i18n.tsx:1082,1084,2155-2171` |
| 主题 / 暗色 / CSS 变量 | OK-但脆弱（6 套主题都有 CSS；首屏闪烁 P2-2） | `theme.ts`、`globals.css:2575-2800`、`AppShell.tsx:352-367` |
| Enter 行为 | OK（localStorage + useSyncExternalStore，输入卡即时同步） | `enter-behavior.ts`、`ChatInput.tsx:213,462,1008,1084` |
| 复制到剪贴板失败处理 | OK（异步 API 失败退回 execCommand，失败有 UI 反馈） | `clipboard.ts`、`CopyCommand.tsx:23-31` |
| 提示词来源展示的准确性 | OK（分类/排序/热冷会话/压缩摘要都有非 smoke 测试） | `prompt-sources.ts`、`prompt-sources.test.ts` |
| 提示词来源读取的性能与上限 | 有问题（无大小上限，P2-3） | `prompt-sources.ts:250-255` |
| 自动更新：检查/版本比较/渠道 | OK-但脆弱（两目标校验不一致 P3-7） | `update-service.ts:120-144`、`semver.ts` |
| 自动更新：启动检查时机 | OK（每次启动一次，globalThis 存状态，`PI_WEB_UPDATE_CHECK=0` 可关） | `startup-check.ts`、`update/route.ts:12-15` |
| 自动更新：下载/执行/回滚/提示 | OK-但脆弱（隔离构架 + 无回滚需求；非 Windows 自更新期间仍在服务 P2-4） | `update-service.ts:151-175,199-235`、`release.mjs:119-152` |

---

## 1. 发现（按严重度降序）

### P1-1 「网络代理」保存后对模型请求不生效，界面没有任何"重启生效"提示，而"测试连接"当场通过

- **位置**：`src/components/settings/GeneralSection.tsx:322-325`（提交口）、`src/lib/pi-settings.ts:156-168,183-186`（写盘）、`scripts/launcher.mjs:108-116,149-163`（唯一应用点）、`src/lib/proxy-status.ts:48-61`（测试口）
- **证据**：

  设置行只有标题、没有 `desc`（对比同文件里其他行都带 `desc`，且自动更新那条有 `updateRestartHint`）：

  ```tsx
  // src/components/settings/GeneralSection.tsx:322
  <Row title={t.httpProxy}>
      <ProxySettings value={textDrafts.httpProxy} disabled={!piSettings || settingsLoading || settingsSaving}
          onChange={(httpProxy) => setTextDrafts({ httpProxy })} onCommit={() => void commitText("httpProxy")} />
  </Row>
  ```

  服务端只把它写进 `~/.pi/agent/settings.json`，并只把三个"会话级"字段热应用（代理不在其中）：

  ```ts
  // src/app/api/pi-settings/route.ts:18-20
  const patch = await patchPiSettings(body);
  // 排队投递方式 / 缓存预热只在建会话时读一次：已经开着的会话当场跟上
  applySettingsToSessions(patch);
  ```

  ```ts
  // src/app/api/pi-settings/route.ts 热应用的字段（agent-manager.ts:2343-2344）
  export function applySettingsToSessions(patch: { steeringMode?: ...; followUpMode?: ...; cacheWarming?: ... }): number {
      if (!patch.steeringMode && !patch.followUpMode && !patch.cacheWarming) return 0;
  ```

  真正生效的地方是**进程启动时**的 launcher，之后不再重读：

  ```js
  // scripts/launcher.mjs:108-112
  export function readHttpProxySetting(env = process.env) {
      ... JSON.parse(fs.readFileSync(path.join(agentDirOf(env), "settings.json"), "utf8")...) ...
  ```

  ```js
  // scripts/launcher.mjs:149-163（只在拉起子进程前调用）
  export function applyProxyEnv(childEnv, { proxySetting = null, ... }) {
      if (proxySetting) { set("HTTP_PROXY", proxySetting); set("HTTPS_PROXY", proxySetting); }
  ```

  pi SDK 侧对应的应用函数**没有从包入口导出**（`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` 的 26 行 export 列表里既无 `applyHttpProxySettings` 也无 `configureHttpDispatcher`），它只做 `process.env.HTTP_PROXY ??= proxy`（`dist/core/http-dispatcher.js:38-44`），且全局 dispatcher 只在 pi CLI bootstrap 里构建。PiWeb 走 `createAgentSession`，全程没有任何一处调用它（`grep -r 'applyHttpProxySettings|configureHttpDispatcher' src/` 命中 0）。

  而"测试连接"是另起子进程、把代理塞进子进程 env 后探测（所以**一定**能成功）：`src/lib/proxy-status.ts:47-61`。

- **触发路径**：设置 → 通用 → 网络代理 → 输入 `http://127.0.0.1:7890` → 失焦/回车 → `PUT /api/pi-settings` 返回成功（设置项显示新值）→ 点"测试连接"显示"外网连通 · xx ms" → 回到对话发消息，模型请求仍走直连（仍失败/仍绕过代理），直到用户重启 `piweb`。
- **后果**：让用户"以为是代理没配好"，反复改代理地址；企业网络里这等于该功能完全不可用（唯一解是重启，而没有任何文案提示）。属于静默失败。
- **置信度**：已确认（UI → API → settings.json → launcher → env 整条链路读完；唯一的不确定是 undici `EnvHttpProxyAgent` 读 env 的确切时机，但那只影响"启动后改 env 是否有效"，不影响"运行中的请求不会因为写 settings.json 而变化"这个结论）。
- **建议修法（最小改动）**：`patchPiSettings` 之后在 `PUT /api/pi-settings` 的响应里带 `restartRequired: patch.httpProxy !== undefined`；`GeneralSection` 里给这一行加 `desc`/或保存后显示 `t.updateRestartHint` 同款提示（"重启 PiWeb 后生效"）。不要试图在 PiWeb 侧热应用——SDK 没有公开入口（真要热应用需要 pi 导出 `applyHttpProxySettings` + `configureHttpDispatcher`）。

### P2-1 设置面板只读写全局 `settings.json`，不看项目级 `.pi/settings.json`：显示值可能与实际生效值不同

- **位置**：`src/lib/pi-settings.ts:64-107`（只读 `getAgentDir()/settings.json`）、`:172-199`（只写这一份）；pi 侧是 global+project 深合并（`dist/core/settings-manager.js:474-475` `deepMergeSettings(this.globalSettings, this.projectSettings)`）
- **证据**：

  ```ts
  // src/lib/pi-settings.ts:64-66
  function settingsFile(): string {
      return path.join(getAgentDir(), "settings.json");
  }
  ```

  ```ts
  // src/lib/pi-settings.ts:175-181
  await withSettingsWriteLock(file, () => withExternalSettingsLock(file, async () => {
      const raw = await readJsonObjectFresh(file);
      if (patch.compaction) raw.compaction = { ...objectOf(raw.compaction), ...patch.compaction };
  ```

  逐项核对（"假配置"表，`✅`=UI 有→后端真读→真生效）：

  | 设置项 | UI 控件 | 落到哪 | 谁读 | 结论 |
  |---|---|---|---|---|
  | 界面语言 | `SelectOption`(GeneralSection:172-181) | `localStorage.piweb.lang` | `I18nProvider` | ✅ |
  | 配色主题（6 套） | 6 张卡(:184-210) | `localStorage.piweb.pebrelTheme` + `data-pebrel-theme` | `globals.css:2575-2800`（6 套 + 暗色变体都在） | ✅ |
  | 亮暗（light/dark/system） | 3 张卡(:214-237) | `localStorage.piweb.theme` + `data-ds-dark/light-theme` | `globals.css:123-126,168+` | ✅（system 跟随有 matchMedia 监听：`AppShell.tsx:356-357`） |
  | 界面字号 | `FontSizeStepper`(:239-241) | `localStorage.piweb.fontSize` + `--dsh-content-font-size/-delta` | `globals.css:220-221` | ✅（次级字号固定 13px，见 §3） |
  | 对话字号 | `FontSizeStepper`(:242-244) | `localStorage.piweb.chatFontSize` + `--piweb-chat-font-size` | `globals.css:105-112,1459,2022` | ✅ |
  | Enter 行为 | `SelectOption`(:245-254) | `localStorage.piweb.enterBehavior` | `ChatInput.tsx:462,1008,1084` | ✅ |
  | 自动压缩开关 | 开关(:261) | `settings.json.compaction.enabled` | pi 每次压缩前读（`agent-session.js:476,2337,2754`）+ `reloadSettingsManagers()` | ✅（对运行中会话也即时，已核实不是构造期缓存） |
  | 自动重试开关 | 开关(:268) | `settings.json.retry.enabled` | `agent-session.js:861,3193,3240` | ✅ |
  | 最大重试次数 | 数字框(:271-283) | `settings.json.retry.maxRetries` | 同上 | ✅ |
  | 压缩 token 预算 | **无 UI** | `compaction.reserveTokens/keepRecentTokens`（API 可写） | pi | ⚠️ 有接口无入口 |
  | 初始重试延迟 | **无 UI** | `retry.baseDelayMs`（API 可写） | pi | ⚠️ 有接口无入口，且 `t.baseDelayMs` 字典键无人用 |
  | 缓存预热 | `SelectOption`(:286-297) | `settings.json.cacheWarming` | pi 建会话时读 + `session.setCacheWarmingMode()` 热应用 | ✅ |
  | 运行中插话 / 结束后续发 | 两个 `SelectOption`(:298-321) | `settings.json.steeringMode/followUpMode` | `agent-session.js:2279-2296`（pi 的 setter 自己也会回写 SettingsManager）+ `applySettingsToSessions` 直改 `session.agent.*`（`agent-manager.ts:2350-2351`） | ✅ |
  | 网络代理 | 输入框(:322-325) | `settings.json.httpProxy` | **只有 launcher 启动时** | ❌ 见 P1-1 |
  | PiWeb / Pi 版本 + 检查更新 | `VersionLink`+`UpdateControl`(:326-337) | `/api/version`、`/api/update` | `update-service.ts` | ✅（P3-7 小瑕疵） |
  | 退出登录 | 按钮(:338-351) | `DELETE /api/web-auth` | API 区域 | ✅ |
  | 打开配置文件 | 按钮(SettingsPanel:93) | `GET /api/config` | — | ⚠️ 实为下载，见 P3-5 |

- **触发路径**：仓库里存在 `.pi/settings.json` 且信任该项目 → 项目里写 `{"compaction":{"enabled":false}}` → 打开 PiWeb 设置面板，开关仍显示"开"（读的是全局值）→ 用户再点一下"关"，写进全局，实际行为不变（项目级仍覆盖）→ 面板与真实行为持续对不上。
- **后果**：单项目覆盖场景下面板显示值与生效值不一致；用户改开关"没反应"，且没有任何提示说"被项目级设置覆盖"。
- **置信度**：已确认（读代码：读取路径只拼 agentDir；pi 侧确实 global→project 深合并）。
- **建议修法**：`getPiSettings()` 增加 `overriddenByProject?: string[]`（用 `getSettingsManager(cwd)` 或直接读 `cwd/.pi/settings.json` 与全局比对，列出被覆盖的键），面板在这些行显示"由项目设置覆盖"。短期最小改动：在该区域加一行说明"此处只影响全局设置"。

### P2-2 首屏语言与主题在 effect 里才应用：英文用户每次加载都先闪中文，显式选深色的用户先闪浅色

- **位置**：`src/i18n.tsx:2157-2170`、`src/app/page.tsx:4-9`、`src/app/layout.tsx:18-25`、`src/components/AppShell.tsx:352-367`
- **证据**：

  SSR 渲染时 `lang` 恒为 `"zh"`（初值写死，localStorage 在 effect 里才读）：

  ```tsx
  // src/i18n.tsx:2157-2162
  export function I18nProvider({ children }: { children: React.ReactNode }) {
      const [lang, setLangState] = useState<"zh" | "en">("zh");
      useEffect(() => {
          const saved = localStorage.getItem("piweb.lang");
          if (saved === "en" || saved === "zh") setLangState(saved);
      }, []);
  ```

  `page.tsx` 是 Server Component，直接把 provider 渲进首屏 HTML；`layout.tsx` 里**没有任何阻塞脚本**（只有 `<html lang="zh-CN" suppressHydrationWarning>`）：

  ```tsx
  // src/app/layout.tsx:19-24
  <html lang="zh-CN" suppressHydrationWarning>
      <body suppressHydrationWarning>
          {children}
      </body>
  </html>
  ```

  主题同理：属性只在 `AppShell` 的 effect 里加（`AppShell.tsx:353-355` → `syncPebrelTheme()`），CSS 只有在"跟随系统 + 系统是深色"时才靠 `@media (prefers-color-scheme: dark)`（`globals.css:123-126`）在首帧就变深；**显式**选 dark/light 或选了 pebrel 配色的人首帧一定是基础浅色。
- **触发路径**：英文用户刷新页面 / 手机浏览器从后台恢复；或"系统浅色 + 用户手动选深色"的用户每次加载。
- **后果**：整屏中文文本闪一下再变英文（`document.documentElement.lang` 也跟着从 `zh-CN` 变 `en`，影响屏幕阅读器首次朗读与浏览器翻译条）；主题闪白/闪错配色，手机上尤其明显。
- **置信度**：已确认（机制层面确定；可见程度取决于机器速度，未做真机录像）。
- **建议修法**：`layout.tsx` 里加一段 `beforeInteractive` 内联脚本，在 `<head>` 之前读 `piweb.lang` / `piweb.pebrelTheme` / `piweb.theme` / 两个字号，直接写 `document.documentElement` 的 `lang`、`data-*` 属性和 CSS 变量（theme.ts 的纯函数逻辑可以抽一个不依赖 window 的 `bootstrapTheme()` 复用）；语言更彻底的做法是把偏好同时写 cookie，SSR 直接按 cookie 选字典。

### P2-3 提示词来源正文读取没有大小上限（1 MB 限制只覆盖"链接资源"），一个巨型 AGENTS.md / 模板就能把面板和进程拖死

- **位置**：`src/lib/prompt-sources.ts:250-255`（上限只在 `sourcePath !== undefined` 时生效）、`src/app/api/prompts/route.ts:41-51`
- **证据**：

  ```ts
  // src/lib/prompt-sources.ts:250-255
  export async function readPromptSource(filePath: string, cwd: string, sourcePath?: string): Promise<string> {
      const authorized = await resolvePromptSourcePath(filePath, cwd, sourcePath);
      const stat = await fs.stat(authorized);
      if (sourcePath !== undefined && stat.size > 1024 * 1024) throw new BoundaryError("linked resource exceeds 1 MB");
      return fs.readFile(authorized, "utf8");
  }
  ```

  面板里点击"文件类来源"走的就是 `sourcePath === undefined` 这条分支（`PromptPanel.tsx:128-135` 只发 `{action:"read", filePath, cwd}`），所以 SYSTEM.md / AGENTS.md / APPEND_SYSTEM.md / 每个 SKILL.md / 每个模板都没有上限。同一路由 GET 还会把**完整组装系统提示词**（含全部工具 schema）一次性塞进 JSON（`prompt-sources.ts:219`）。

- **触发路径**：工作区放一个大文件（例如把 30 MB 日志/数据集命名成 `AGENTS.md`，或某个包提供的 SKILL.md 携带大附件）→ 打开提示词面板 → 点该项 → `fs.readFile` 整份进内存 + `NextResponse.json` 再序列化一份 → 手机端/低配机器卡死或进程 OOM；GET 时则每次刷新面板都重传一遍全部工具 schema 与系统提示词。
- **后果**：单次点击可造成数百 MB 内存峰值；移动端直接崩页。相比"链接资源"已有 1 MB 上限，这里的不一致说明上限是漏加而不是有意放宽。
- **置信度**：已确认代码路径；实际 OOM 需大文件验证（可用 `truncate -s 200M AGENTS.md` 在临时工作区验，不必碰用户目录）。
- **建议修法**：把 `stat.size` 上限提到函数开头、对所有来源统一生效（例如 1 MB，超限返回一个明确错误码，面板显示"文件过大，请用编辑器打开"）；GET 里给 `assembledSystemPrompt` 加截断标记或改成单独的按需读取动作。

### P2-4 非 Windows 的 npm 安装「一键更新」会在服务仍在服务的情况下替换自己的安装目录（.next 与 node_modules 被换掉），无警告、无 503 保护

- **位置**：`src/lib/update-service.ts:89-100,151-175,199-201`；UI 侧 `GeneralSection.tsx:410-414,416-423`
- **证据**：

  ```ts
  // src/lib/update-service.ts:89-96
  export function canSelfUpdateNpmInstall(platform: NodeJS.Platform = process.platform, installation?: string): boolean {
      if (platform !== "win32") return true;   // 只有 Windows 因 EBUSY 判 false
  ```

  ```ts
  // src/lib/update-service.ts:157-174
  await assertIdle();
  const command = (args: string[], timeoutMs: number) => run("npm", args, { cwd: installation, env: commandEnv, timeoutMs });
  const before = await readPackageVersion(manifestPath);
  await command(["install", "-g", `${PIWEB_PACKAGE}@latest`, "--no-audit", "--no-fund"], 600_000);
  await assertIdle();
  assertInstallation(installation);
  ```

  `assertIdle` 只看"有没有正在流式输出的会话"（`update/route.ts:34-38`），不看并发 HTTP 请求；UI 在 `updated` 阶段只提示"重启生效"（`t.updateRestartHint`），没有任何"更新期间请勿使用"的提示。
- **触发路径**：Linux/macOS 上 `npm i -g @rexvane/piweb` 安装 → 用户点"更新到 vX" → npm 把 `…/node_modules/@rexvane/piweb` 整体替换（`.next` 的 chunk 也在里面）→ 与此同时用户继续点会话/切页面，Next 按路径去读 `.next/server/app/…`。
- **后果**：旧句柄仍可读，但**按路径新打开**的 chunk 会指向新版本的哈希文件名 → 请求 404/500、页面白屏或混杂两版代码；这与 Windows 分支刻意拒绝自更新的理由（"不能替换运行中的自己"）是同一类风险，只是 Linux 上表现成"能装但服务可能崩"而非 EBUSY。
- **置信度**：疑似（需在 Linux 实机验证：更新进行中并发请求 `/api/*` 与静态 chunk 的失败率；Windows 分支已有测试，Linux 分支只有"installs the published package itself where the platform allows it"这类命令断言）。
- **建议修法**：自更新期间给所有路由加一个全局"更新中"闸门（返回 503 + 前端覆盖层提示"正在安装，完成后重启"），或在非 Windows npm 安装上降级为"给命令 + 手动停服"（与 Windows 同策略），二者都不需要改动 pi。

---

### P3-1 保存失败的反馈不准确：非法输入报"设置未保存"、草稿不回滚、服务端英文错误原样显示

- **位置**：`src/components/settings/GeneralSection.tsx:143-153`（校验）、`:111-133`（保存）、`:166-171`（提示条）
- **证据**：

  ```tsx
  // :143-153
  const commitMaxRetries = async () => {
      ...
      if (!raw || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
          setSettingsError("save");     // 用户看到的是"设置未保存，请检查输入或网络后重试"
          return;
      }
  ```

  ```tsx
  // :168 —— 服务端文案是英文（pi-settings.ts:117 / 121-123 全是英文）
  {settingsError === "save" ? `${t.settingsSaveFailed}${saveErrorDetail ? ` (${saveErrorDetail})` : ""}` : ...}
  ```

- **后果**：输入 `abc` 或 `-1` 时，数字框保留非法文本且不改回，提示条说"未保存请检查网络"，用户不知道错在哪；真正保存失败时括号里嵌一段英文（`compaction.reserveTokens must be a non-negative integer`），中文界面里混杂英文；错误提示没有"关闭"入口，只能靠下一次操作清掉。
- **置信度**：已确认（读代码）。
- **建议修法**：区分 `invalid` 与 `save` 两种状态，非法时把输入框回退到 `String(piSettings.retry.maxRetries)` 并显示本地化校验文案；`saveErrorDetail` 用一个 code→文案映射（未知 code 才显示原文）。

### P3-2 i18n：中文字典里仍有纯英文词条（聊天区可见），另有死键；两语言 key 集本身是对齐的

- **位置**：`src/i18n.tsx:97-99`（zh 侧英文）、`:814` 之类调用点、`:1082,1084`（类型约束）、死键示例 `:270`(baseDelayMs)、`:358`(toolReadonly)
- **证据**：

  ```tsx
  // src/i18n.tsx:97-99（这在 zh 字典里）
  runningTool: "Running {name}…",
  thinkingLive: "Thinking",
  stepRunning: "Running",
  ```

  ```tsx
  // src/components/ChatWindow.tsx:693 / :814（中文界面下会渲染出来）
  {running ? <span className="pw-shimmer">{name === ASK_USER_TOOL ? t.stepAskWaiting : t.stepRunning}</span> : ...}
  <span className="pw-shimmer">{t.thinkingLive}…</span>
  ```

  对齐性方面是好的：`type Dict = { [K in keyof typeof zh]: string }`（:1082）+ `const en: Dict`（:1084）→ 缺键/多键都是 typecheck 错误（typecheck 绿即证明对齐）；程序化比对结果：两段逐键比对无单边缺失、无重复键、无多余键，占位符唯一差异 `sumSearched1`（zh 带 `{n}`、en 用 "searched once"，而该键仅在 `run.searches === 1` 时使用，属刻意，不是 bug）。死键（全库 `t.X` 引用扫描后仍未被使用）**151 个 / 1058 个词条（约 14%）**，其中本区域相关：`baseDelayMs`、`toolReadonly/toolStandard/toolFull`、`runningTool`。
  运行时缺失键：`t` 的类型就是 `Dict`，`useContext` 默认值也是 `zh`（:2155），因此**不存在**"缺 key 显示 undefined"的路径；未包 provider 的子树会静默回落中文（当前只有 `page.tsx` / `login/page.tsx` 两个入口，都包了）。
- **后果**：中文界面的"思考中/执行中"状态显示英文；字典体积里约 14% 是死键，删掉 UI 后残留。
- **置信度**：已确认（程序化比对 + 调用点核对）。
- **建议修法**：把 `thinkingLive/stepRunning` 补中文（或确认刻意保留并在字典里分组标注"品牌/状态词不翻译"）；用类型收窄清理死键（`const en: Dict` 已能防漏，死键需要引用扫描）。

### P3-3 字号步进器的无障碍标签硬编码英文，`px` 也硬编码

- **位置**：`src/components/settings/SharedControls.tsx:152-183`
- **证据**：

  ```tsx
  // :161-168
  aria-label="decrease font size"  ...
  title="reset"  ...  {value} px
  // :177
  aria-label="increase font size"
  ```

- **后果**：中文界面下屏幕阅读器读英文；`aria-label`/`title` 是用户唯一能听到的控件说明（可见内容只有 `−  14 px  ＋`）。
- **置信度**：已确认。
- **建议修法**：加 `fontDecrease/fontIncrease/fontReset` 三个键（zh/en 各一份），`px` 保持（单位不译）。

### P3-4 提示词面板三处交互/显示缺陷

- **位置**：`src/components/PromptPanel.tsx:48-50,123-141,199`
- **证据**：

  ```tsx
  // :48-50 —— 0 字节文件显示为空
  function formatBytes(bytes: number | undefined): string { return bytes ? fmtBytes(bytes) : ""; }
  ```

  ```tsx
  // :123-126 —— 没有 onOpenContent 也照样渲染成可点按钮，点了静默无效
  const openFile = async (source: PromptSource) => {
      if (!source.path || !onOpenContent) return;
  ```

  ```tsx
  // :128-135 —— 连点两个文件时，先点的请求后回来会覆盖后点的内容（无 latestRequest 守卫，
  // 而同一个文件的列表请求 load() 是有的，:73-92）
  const response = await fetch("/api/prompts", { method: "POST", ... });
  onOpenContent(source.path, body.data.content as string);
  ```

- **后果**：0 字节来源占位为空（用户以为是加载失败）；宿主没传 `onOpenContent` 时列表项长得像链接但没反应；快速点两个来源会看到"不是最后点的那个文件"的内容。
- **置信度**：已确认（读代码；竞态需人为延迟网络才明显）。
- **建议修法**：`bytes === 0` 显示 "0 B"；`onOpenContent` 缺失时不渲染为按钮（或 `disabled` + `title` 说明）；给 `openFile` 复用 `latestRequest` 的思路做请求去序。

### P3-5 「打开配置文件」实际是下载，且原样导出可能含代理账号密码

- **位置**：`src/components/SettingsPanel.tsx:93`、`src/app/api/config/route.ts:9-22`、`src/lib/pi-settings.ts:156-167`（允许 `user:pass@`）
- **证据**：

  ```tsx
  // SettingsPanel.tsx:93
  <button className="btn-outline" ... onClick={() => window.open("/api/config", "_blank")}>
  ```

  ```ts
  // api/config/route.ts:12-18
  const content = await fs.readFile(file, "utf8");
  return new Response(content, { headers: { "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="settings.json"' } });
  ```

  而 `httpProxy` 是允许带凭据的（校验只要求是 http/https/socks URL 且有 hostname），launcher 自己打日志时会脱敏（`scripts/launcher.mjs:125-137` `redactProxy`），这里却不脱敏。
- **后果**：按钮文案说"打开"、行为是下载（手机上是下载到文件App，桌面是落到下载目录）；`httpProxy` 形如 `https://user:pass@proxy:8443` 时凭据原样落盘并进入浏览器下载历史（launcher 反而做了脱敏，说明团队知道这是敏感字段）。
- **置信度**：已确认（代码）；实际风险取决于用户是否在代理 URL 里写账号。
- **建议修法**：改文案为"下载 settings.json"；导出前把 `httpProxy` 的 `username/password` 清空并加一行 `"_redactedFields": ["httpProxy"]` 说明（或干脆去掉该项）。

### P3-6 settings.json 写入的残余风险：整份重排、权限/ACL 继承变化、无 fsync（原子性本身没问题）

- **位置**：`src/lib/pi-settings.ts:187-194`
- **证据**：

  ```ts
  // :187-192
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
      await fs.writeFile(temporary, JSON.stringify(raw, null, "\t"), "utf8");
      await fs.rename(temporary, file);
  ```

  对照 pi 自己写的是 `JSON.stringify(mergedSettings, null, 2)`（`dist/core/settings-manager.js:471`）且直接 `writeFileSync`（同文件 :170）。
- **后果**：① 每次在面板里改一个开关，用户整份 settings.json 会被重新格式化成 tab 缩进（与 pi 的 2 空格不一致）→ 与 pi 交替写入时形成"整文件 diff 抖动"，也让手写排版失效；② `rename` 产生新 inode，原文件上的显式权限/ACL（例如用户自己 `chmod 600`、或 Windows 上给该文件的单独 ACL/EFS）不会被继承，新文件按 `umask`/目录继承来；③ 没有 `fsync` 就 rename，断电场景下可能留下空文件（pi 自己更差，所以不算回归，但不能算"原子"）。
- **置信度**：①已确认；②③属平台行为推断（未实机验证 ACL/断电）。
- **建议修法**：改成与 pi 相同的 `JSON.stringify(raw, null, 2) + "\n"`；写盘后 `filehandle.sync()` 再 rename；rename 前 `stat` 原文件权限并用 `chmod` 应用到临时文件（POSIX）。

### P3-7 「检查更新」对 pi 目标不校验 registry 输出；semver 解析失败一律"不比新"

- **位置**：`src/lib/update-service.ts:126-129`（pi 目标）对照 `:130-136`（piweb 目标有 `if (!latest) throw`）、`src/lib/semver.ts:10-13,17-20`
- **证据**：

  ```ts
  // update-service.ts:126-129 —— latest 没做任何校验
  if (target === "pi") {
      const latest = (await command("npm", ["view", PI_PACKAGE, "version"], 30_000)).trim().split(/\r?\n/)[0];
      return { current: piEngine, latest, canUpdate: isNewer(latest, piEngine), selfUpdate: true };
  }
  ```

  ```ts
  // semver.ts:17-20 —— 任一方解析失败就 false
  export function isNewer(a: string, b: string): boolean {
      const pa = parseVersion(a); const pb = parseVersion(b);
      if (!pa || !pb) return false;
  ```

  `parseVersion` 的正则 `/^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/` 不锚定末尾，`"1.2.3.4"`、`"1.2.3abc"` 都会被当成 `1.2.3` 接受。
- **后果**：镜像源返回异常内容但 exit 0（或本地版本号不是 semver）时，界面显示"已是最新"（`update-store.ts:62-67` `phase: "latest"`），用户失去唯一的手动发现渠道；`1.2.3.4` 这类畸形版本号被静默当成 `1.2.3` 比较。
- **置信度**：已确认（代码）；触发需要非常规 registry 输出。
- **建议修法**：pi 目标复用 piweb 目标的 `if (!latest) throw`，并加 `if (parseVersion(latest) === null) throw`；`parseVersion` 正则补 `$`（允许 `+build` 后缀）。

### P3-8 客户端小问题：设置面板切节重建导致重复请求、两处 localStorage 写入未做异常保护

- **位置**：`src/components/SettingsPanel.tsx:101-103`、`src/components/settings/GeneralSection.tsx:67-76,90-104`、`src/i18n.tsx:2166-2168`、`src/lib/enter-behavior.ts:20-23`
- **证据**：

  ```tsx
  // SettingsPanel.tsx:101-103 —— 条件渲染，切走即卸载，切回重新挂载
  {section === "general" && <GeneralSection lang={lang} setLang={setLang} />}
  ```

  ```ts
  // i18n.tsx:2166-2168 —— 没有 try/catch（theme.ts 里所有 localStorage 写入都有）
  const setLang = useCallback((l: "zh" | "en") => { setLangState(l); localStorage.setItem("piweb.lang", l); }, []);
  ```

- **后果**：每次切回"通用"都会重发 `security/pi-settings/version/web-auth` 四个请求（`GeneralSection.tsx:48-53`），设置面板开关频繁时明显；隐私模式/存储配额满时 `setLang`/`setEnterBehavior` 会在点击回调里抛异常（语言或 Enter 行为点了没反应，控制台报错）。
- **置信度**：已确认（代码）。
- **建议修法**：`: 111` 里把四个请求提到 SettingsPanel 或做 SWR 缓存；两处 `localStorage.setItem` 包 try/catch（与 theme.ts 一致，失败仍更新内存态）。

---

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| i18n provider 行为 | 语言切换是全局副作用（`document.lang`、localStorage、SSR 首帧默认 zh），现在**零测试** | 用 jsdom 渲 `I18nProvider`：默认 zh、读 localStorage 后切 en、`documentElement.lang` 变化、provider 外 `useI18n` 回落 zh |
| 通用设置的保存失败路径 | P3-1 的三种分支（非法输入 / 服务端 400 / 网络错误）现在无测试，靠人肉 | 用 `GeneralSection` + mock fetch：非法 maxRetries 时输入框回退、提示文案区分 invalid/save、重试按钮重新拉取 |
| 代理设置的"需重启"语义 | P1-1 是本区域最严重的问题，测试里一行都没有 | 断言 `PUT /api/pi-settings {httpProxy}` 响应携带 `restartRequired`（修完后），且 `applySettingsToSessions` 不处理 httpProxy |
| `/api/pi-settings` 路由层 | 只有 lib 单测，400/500 分类（`SyntaxError`/`PiSettingsValidationError`→400）没有路由测试 | POST 非法 JSON → 400；未知字段 → 400；写盘失败（mock rename EPERM）→ 500 且文件不变 |
| 主题/字号持久化与系统跟随 | `theme-color-meta.test.ts` 只测 meta 和 CSS token 存在；`applyFontSize`、`mode` 持久化、`syncPebrelTheme` 无测试 | 断言 `applyPebrelTheme('nord-paper','system')` 后 localStorage/attribute 双写；`matchMedia` 变化后重放 |
| 提示词来源读取上限 | P2-3 的上限现在只对链接生效，测试也没有任何大文件用例 | 在临时工作区放 2 MB `AGENTS.md`，断言 `readPromptSource` 抛 BoundaryError（修完后） |
| `checkForUpdate('pi')` 的异常输出 | P3-7：两目标处理不一致，测试只覆盖了 piweb 分支的空输出 | mock run 返回 `""` 或 `"1.2.3.4"`，断言抛错或视为不可比较而不是 `canUpdate:false` |
| 非 Windows 自更新期间的服务可用性 | P2-4 只能在 Linux 实机/CI 上验 | 用一个假 installation 同时触发 `runUpdate` 与并发 GET，断言要么 503 要么不被截断 |

---

## 3. 与其他区域的可能交叉点

1. **API/鉴权区域**：`PUT /api/pi-settings`（会改写用户 `~/.pi/agent/settings.json`）、`GET /api/config`（导出配置文件）、`POST /api/prompts`（读任意"已发现来源"内容）、`POST /api/update`（执行 npm/git）都只在这几个 route 内部做参数校验，`update/route.ts:17` 明确写着"Runtime authorization and origin checks live in proxy"。请 API/鉴权区域裁定这几个写/读口是否与其它 `/api/*` 一样受 origin/令牌保护；我按 BRIEF 未越界，只提示"写用户配置 + 执行安装命令"这两个口如果漏保护，后果比只读接口严重。
2. **bridge / 路径安全区域**：`/api/prompts` 用 `resolveSessionPath(sessionId, {allowPending:true})` + `getManaged(sessionPath)` 取热会话（`api/prompts/route.ts:15-26`），我读到的路径校验都在 `path-security` 里，未发现越权，但 `cwd` 与 `session` 两个参数是否可以来自不同工作区（导致"看到别的工作区的组装提示词"）需要他们确认。
3. **models / plugins 区域**：`ModelsSection`、`PluginsSection`、`SkillsSection` 的开关真假我没审（按边界）；`getEnabledModelPatterns()`（`pi-settings.ts:73-77`）只读全局 `enabledModels`，与 P2-1 是同一类"忽略项目级覆盖"的问题，请 models 区域注意。
4. **crosscut / 视觉区域**：`globals.css:103` 的 `--dsh-content-font-size-secondary: 13px` 是固定值、`:2068` 直接用它，所以"界面字号"只放大正文与行高，次级文字不跟着变（14→18 时正文 18 / 次级仍 13，比例失真）。属视觉/令牌层，不在我的写权限内。
5. **crosscut / AppShell**：P2-2 的修复点在 `layout.tsx` + `theme.ts` + `i18n.tsx` 三处，`AppShell.tsx:352-367` 的媒体查询/storage 监听逻辑要跟着改造，需与负责 AppShell 的区域协调，避免双份 theme 应用。
6. **构建/发布区域**（若有人审）：我只核对了 `scripts/release.mjs` 的隔离构建目录 + 构建锁 + "只在重启时提升"这一层（结论 OK，失败不需要回滚）；`build-output.mjs` 的 `assertInstallation/readProductionBuild` 与 `runtime/pi-packages.mjs` 的细节归他们。

---

## 4. 建议优先修的 3 件事

1. **P1-1：给"网络代理"补上"重启生效"的反馈（最小改动在 `PUT /api/pi-settings` 响应 + 一行 desc）**。这是本区域唯一的"改完完全没效果、界面还报成功"的功能，且旁边就有"测试连接"按钮把人往错的方向带；企业网络/必须走代理的用户会直接认为 PiWeb 坏了。
2. **P2-3：把 1 MB 上限推广到所有提示词来源读取**。一行判断的改动量，挡住的是"点一下面板 → 进程 OOM / 手机端崩页"的确定性风险；顺带给 GET 的 `assembledSystemPrompt` 一个截断或按需加载。
3. **P2-2：首屏语言/主题用阻塞脚本提前应用**。影响每一个英文用户、每一次加载（先闪中文再变），且修法成熟（写入 `layout.tsx` 的 beforeInteractive 脚本 + 语言偏好落 cookie 供 SSR 读取）；顺带能消除换主题时的白闪。
