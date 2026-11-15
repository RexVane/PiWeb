# PiWeb 深度功能审计报告（2026-11-13）

> 归档说明：原始证据目录 `.audit-2026-11-13/` 已在 2026-11-15 收尾清理移出工作区（跟踪文件可由 git 历史恢复）；文中路径为历史记录。

> **版本 v2（含第二轮补验）** ｜ 定稿 2026-11-13 20:45 ｜ 第一轮正文（18 份区域报告 + 2 份对抗式复核）+ **第二轮 9 份补验报告**（`verify-coverage` / `verify-body-limit` / `verify-plugin-install` / `verify-tunnel` / `review-update-release` / `verify-provider` / `verify-mobile` / `verify-uac` / `verify-scale`）。
>
> v2 的净变化：**P0 2→3**（新增 P0-3：未认证请求在鉴权前被缓冲 272MB）、**P1 24→27**（P2-96/P2-89/P2-31 升格）、**P3 27→32**、P2 总数不变（升 4 / 降 4 / 新增 8）。另**撤回 1 条担忧**（移动端 `100dvh` 与横向溢出，真 Chromium 实测撑得住）。凡是与第一轮冲突处均标了「（v2 已修正：原判…）」，未标注的段落仍是第一轮原文。

**一句话结论**：功能做得比同类项目都全，静态与单元层面是绿的（1648 测试全过），但**权限模型的承诺是假的**——「仅可查看」此刻在本机就能写盘，「只改工作区」能被一条 `file://` 路径绕过，而这两件事恰好是用户唯一会当真的两条安全承诺。所以结论是「**很能用，但现阶段不敢让它碰真实仓库**」：不是代码质量差，是**边界被宣称了却没被守住**，而且守护逻辑的失败方式全是静默的。（**v2 补一刀**：还有一条跟权限档无关的 P0——任何人只要能连上端口，就能在**没有凭据**的情况下让进程为**每条连接**缓冲最多 272MB，默认配置即成立，见 P0-3。）

---

## 0. 数据面板

### 0.1 环境事实（先看这段，它决定了本文所有 `path:line` 的可信度）

| 项 | 值 |
|---|---|
| HEAD | `1d4efba` |
| 工作区未提交改动 | **144 项**（BRIEF 采样）→ 报告成稿时 **145 项**；v2 定稿时复查：**已跟踪文件 77 项改动 + 未跟踪若干 = 145 项条目**（另一个会话提交过一部分），全过程仍在变 |
| 并发写者 | 审计期间**另一个会话在持续改这个仓库**。复核人实测 `src/lib/agent-manager.ts` 在两次命令之间 **3136 → 2964 → 3136 行**来回变；`growth-service.ts` 865→911；`.next-releases` 从 13 个目录涨到 63 个条目 |
| 因此 | 本文所有 `path:line` 都是我/复核人**读到时**的行号，可能已漂移 ≤10 行；**每条都给了可 grep 的原文片段或函数名，请以内容为准**。结论均基于当时磁盘状态 |
| 平台 | Windows x64 / Node v24.12.0 / Next 16.4.5 / pi-coding-agent 1.5.2 / koffi 3.3.8 |
| 本报告版本 | **v2（含第二轮补验）**：~~621 行~~ → **753 行**；新增 P0-3、P1-25~27、P2-108~115、P3-28~32 |

### 0.2 基线（lead 18:49–18:55 实跑）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**，无错误 |
| `npx vitest run` | **204 文件通过 / 3 跳过（共 207）；1648 测试通过 / 19 跳过 / 0 失败；312s** |
| 源码规模 | `src/` **218 文件 / 55,235 行**（含空行口径；非 `.d.ts` 模块口径为 210 个 / 46,534 行） |
| 测试规模 | `tests/` **208 文件 / 27,373 行** |
| 审计输入 | **29 份**：第一轮 20 份（18 份区域报告 + 2 份对抗式复核，`verify-wave1` 核 31 条、`verify-wave2` 核 54 条）+ **第二轮 9 份补验报告**（`verify-coverage`、`verify-body-limit`、`verify-plugin-install`、`verify-tunnel`、`review-update-release`、`verify-provider`、`verify-mobile`、`verify-uac`、`verify-scale`） |
| 复核结论 | 85 条核对中 **成立 78 / 夸大 4 / 不成立 1 / 归因错 1 / 无法静态确认 1**；另附 11 条漏报（已并入正文） |
| **覆盖率**（v2 新增，实跑） | **lines 83.56%**（15,377/18,401）/ **branches 70.45%**（14,021/19,902）/ **functions 77.82%**（3,464/4,451）/ **statements 79.28%**（17,844/22,506）。做法：`npm i --no-save @vitest/coverage-v8@5.0.5`（**未改** `package.json`/`package-lock.json`）→ `npx vitest run --coverage --coverage.provider=v8 --coverage.include=src/**` → **204 通过 / 3 跳过；1648 passed / 19 skipped / 0 失败；518.67s**（插桩比不插桩慢 206s）。数据：`.audit-2026-11-13/coverage/coverage-summary.json` |

**本报告的严重度计数**

| 级别 | 条数 | 说明 |
|---|---|---|
| **P0** | **3** | 两条「权限档承诺不成立」+ 一条「未认证请求在鉴权**之前**被缓冲 272MB」 |
| **P1** | **27** | 正常路径下功能不正确、或静默失败到用户无法自救 |
| **P2** | **99**（编号到 P2-115） | 边界/竞态/资源/供应链/测试缺口（全列，表格）。编号连续性是"升/降级后留空号"：P2-29/31/33/46/73/89/90/96 共 8 个号已改判到别的级别，表内以 `~~P2-xx~~ → Px-yy` 标去向，所以实际条目 99 条 |
| **P3** | **32** | 只列"值得修"的；纯风格类已丢弃 |

> v2 计数口径：升走 4 条（P2-90→P0-3、P2-96→P1-25、P2-89→P1-26、P2-31→P1-27）、降级 4 条（P2-29→P3-28、P2-33→P3-29、P2-73→P3-30、P2-46→P3-31）、新增 P2 8 条（P2-108~115）+ P3 1 条（P3-32）。原编号全部保留（表内以 `~~P2-xx~~ → Px-yy` 标注去向），便于与第一轮对照。

### 0.3 覆盖面

- **读到的代码**：18 份区域报告合计覆盖 `src/` 绝大多数模块（逐行读完 120+ 个文件，含 `agent-manager.ts`、`ChatWindow.tsx`、`models-service.ts`、`growth-service.ts`、`remote/supervisor.ts`、`session-import/*` 全 15 文件、`src/app/api/**` 34 个路由、`scripts/*` 全部）、`bin/`、`tests/` 24 个精读 + 其余用例清单。
- **测试真实执行率**（脚本对账，去 `vi.mock` 剪枝）：210 个非 `.d.ts` 源模块中 **191 个（91%）被至少一个测试真实执行**，19 个零执行（1.0% 行）——其中 **14 个是 API 路由**。**v2 交叉验证**：v8 行命中口径**独立**得出同样 **19 个**零覆盖文件，清单逐一吻合（19/19，含那 14 个路由 + `session-import/paths.ts`、`instrumentation.ts`、`layout.tsx`、`page.tsx`、`PiMark.tsx`）。两种方法互证，这是本报告对"覆盖缺口清单"最硬的一次确认。
- **覆盖率口径（v2 补充，修正第一轮的"未知"）**：全局 lines **83.56%** / branches **70.45%** / functions **77.82%** / statements **79.28%**。**行覆盖是健康的、洞在分支覆盖**：`agent-manager.ts` 行 86.39% 但分支 **71.25%**、`ChatWindow.tsx` 83.76%/71.14%、`usePiWeb.ts` **69.48%/53.11%**、`AppShell.tsx` 70.32%/56.87%、`ModelsSection.tsx` 68.83%/57.16%、`git-service.ts` 分支 **42.85%**、`FullDiff.tsx` 行 **5.4%**。而我们检出的 P1 家族（P1-1 abort 兜底、P1-2 单源 streaming、P1-3 提交锁、P1-17/18 静默残缺）**正好落在这些没被测到的错误/超时分支里**——"1648 全绿"与"停止按钮会卡死"可以同时成立，机理在此。
- **没做的**：没有改任何源码/测试/配置；没有装依赖；没有 `build`；没有重启或杀掉 30141 服务；没有 `git` 写操作；没有跑会污染 `~/.pi` 的东西。所有"需要运行才能确认"的结论都进了附录 B。

### 0.4 定级调整与合并（相对 18 份区域报告的差异，看正文前先读这张表）

| 处置 | 条目 | 理由 |
|---|---|---|
| **保持 P0** | sandbox P0-1（`file://`）、sandbox P0-2（Low 标签） | lead 独立确认 + 探针实测 + 写稿时磁盘复测；是 3 条 P0 里"权限档承诺不成立"的那两条（第三条 P0-3 是 v2 新增，性质不同） |
| **升格并入 P0-2** | verify-wave1 漏报 V1-漏-1（标签跨进程残留） | 与 P0-2 同一根因，且是本机**当前真实存在**的状态，不是理论窗口 |
| **降为 P1** | plugins-skills 原 P0-1（技能删除越界） | 需用户自建 junction + 链接目标根上直接有 `SKILL.md` + 用户主动点删除；**v2 已删掉"无嵌套技能"这条理由（实测不成立，见 P1-10）**；**若文档推荐"链接技能仓库"则必须升回 P0** |
| **降为 P2** | plugins-skills 原 P1-1（安装即执行） | `launcher.mjs:248` 默认注入 `PI_WEB_AUTH=1`，"未认证即 RCE"只剩"绕过启动器直启"一条窄路；保留"缺 `--ignore-scripts`""单击即装无二次确认"两个事实 |
| **降为 P2** | sessions-workspaces 原 P1-1（归档 unlink） | UI 已明确声明"归档满 30 天自动删除"（`i18n.tsx:256`、`SessionSidebar.tsx:565/1056`），是有意行为；只保留"无回收站 / 时钟前跳批量删" |
| **降为 P3** | bridge 原 P2-5（`releaseSandbox` 拆掉新 holder） | 机制描述错（`holders.delete` 同步、必然早于 `registerManaged`）；真实窗口是 temp 目录与 `markMedium` 竞争，已并入 P2-4 |
| **重写归因** | sandbox 原 P2-2（`realpathLoose` 是 `file:` 逃逸的原因） | 实测 `file:` 输入走的是 ENOENT 祖先回填分支，`:69` 一次没命中；P2-2 仍单独保留（P2-2） |
| **撤回表述** | bridge / chat-ui 的"生产已复现" | 两份区域报告都这么写，但正文标"需运行验证"且无日志；本报告只保留机制，复现步骤见附录 B #4 |
| **剔除（不成立）** | `GetLastError` 时序猜测、`fs.rm` 跟随链接、`/c/` 等三种同级写法被判为绕过 | 见附录 A 第 7/11/9 条 |
| **改为正面结论** | "存在未鉴权 `/api` 路由"、"测试污染 `~/.pi`"、"归档会误删未归档会话"、"多 bundle 重复调度" | 核对结果都是**否定**，作为正面结论写进附录 A 第 14/15/6/5 条 |
| **并入正文（不入附录）** | 6 条 V2 漏报 + 5 条 V1 漏报 | V1-漏-1→P0-2、V1-漏-2→P2-1、V1-漏-3→P3-9、V1-漏-4→P1-18、V1-漏-5→P2-33；V2-漏-1→P2-55、V2-漏-2→P2-56、V2-漏-3→P3-24、V2-漏-4→P2-71、V2-漏-5→P2-65、V2-漏-6→P2-88 |
| **升 P0（v2）** | api-auth 原 P2-90（272MB body 缓冲时机） | 实测确认缓冲发生在 `proxy()` **之前**、401 被 body 阻塞：未认证即可吃满内存。**新增 P0-3** |
| **升 P1（v2）** | P2-96（失败不回退旧 ready）、P2-89（非 Windows 更新替换在服目录）、P2-31（目录探测不跟随代理） | → **P1-25 / P1-26 / P1-27**；理由各条目内（前两条的共性：代价极低 + 官方自救路径无效 / UI 报成功时服务已在坏） |
| **降 P3（v2）** | P2-29、P2-33、P2-73、P2-46 | → **P3-28~31**。P2-29 的"没出口"改判为"pi 运行时会按 `model.input` 丢图"（只剩缺预发提示）；P2-73 的"非 pi 包混进结果"**实测未复现**（250/250 都带关键词）；P2-33 现网载荷都是小 JSON；P2-46 的 64MB 阈值需 120–180 万条目、本机最大仓库差 15 倍 |
| **维持但改写（v2）** | P1-10、P1-23、P1-24、P2-66、P2-75、P2-76、P2-22 | P1-10 删掉"嵌套技能会拦"这条降级理由（实测不成立，触发面更大）；P1-23 追加"它就是更新成功判定"；P1-24 明确**不降级**；P2-66 从"永久残留"改为"仅崩溃/强杀路径"；P2-75 升级为**已实测**；P2-76 收窄到跨进程；P2-22 撤掉 `100dvh` 那一半 |
| **撤回担忧（v2）** | 移动端 `100dvh` / 横向溢出 | 真 Chromium 390×664 实测：7 个视图 `scrollWidth == clientWidth`、注入 2349px 宽表后文档仍 390、8 档高度扫描 composer 底边恒 `innerH-40` 全部不裁切 → 已成**正面结论**，见附录 A #17 |
| **按实测补强（v2）** | P2-10（UAC）、P2-44/45/47（规模）、P2-103（隧道真链路）、P2-115（会话冷启动） | UAC 策略层已实测（`ConsentPromptBehaviorAdmin=5`+安全桌面 → 不能静默提权，维持 P2）；规模项全部换成实测数字；隧道 E2E 首次在 Windows 上跑通；会话列表冷启动 2.94s 单独立条 |

---

## 1. 先看这三件事（v2 补第四条）

**① 权限两档的真实性是假的（P0-1 + P0-2）。** 这是两条"我照着文档用就会中招"的。P0-1：`workspace` 档声称"只改工作区"，但模型只要把路径写成 `file:///C:/Users/x/.ssh/authorized_keys`，闸门判"区内"放行，pi 侧 `fileURLToPath` 解析成真实绝对路径落盘——**一条 prompt 就能写到工作区外任意位置**。P0-2：`readonly` 声称"零写入"，但只读靠的是把工作区目录打上 Windows Low 完整性标签，而**标签属于磁盘、不属于沙箱实例**；我在写稿时复测：`D:\AIApp` 与 `D:\AIApp\PiWeb` 此刻都带 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，`D:\` 本身没有（说明是显式打上的），而 `~/.pi/agent/web-sandbox` 下只剩 1 个空目录、无对应活沙箱 → **重启之后标签依然在，只读档照样能写**。两条都不是"极端配置"，是默认用法的直接后果。

**② 会话卡死家族：一次点击就能让会话永久不可用，唯一出路是重启服务（P1-1 + P1-2 + P1-3）。** `await m.session.abort()` 没有超时，而唯一的复位帧排在它**后面**；`isStreaming` 只由一条 `status` 事件决定、不与每 3 秒到手的轮询数据对账；扩展 slash 命令会把整次 HTTP 提交连同提交锁一起挂住。三者叠加后的用户视角完全一致：**点了停止没反应、状态栏一直转、再发消息被拒、排队文本丢了**。这不是"某个工具不响应取消"的罕见情况，是桥层所有路径缺超时的共同结果。

**③ 不打招呼就动用户的东西：growth 已经在用户仓库里写了 218 个 commit，skills 删除能递归删掉工作区外的整个目录（P1-14 + P1-10）。** 这两条的共性不是"严重度最高"，而是**不可逆**：`refs/piweb/*` 的 218 个提交没有任何 UI 能关、能删；一次误点的技能删除把 junction 指向的整个仓库（含 `.git`）`fs.rm(recursive)`，`force:true` 不进回收站。我把 growth 排在这里、把 skills 从原报告的 P0 降到 P1，理由写在条目里：growth 是**每次提问都会发生**的默认路径（本机已 218 次），skills 需要用户自己建 junction/文件符号链接才触发——**频次差距两个数量级，而两者都是不可逆**。

> 与你给的初判相比，我只调了一处：`/api/skills` 从"三件事"里的并列降为 P1（依赖用户自建链接），把位置让给 growth 的 218 个 commit。其余一致。

**④ 第三条 P0 是另一种性质：不是"宣称了没守住"，而是"从来没被想到"（P0-3，v2 新增）。** 任何能连到端口的人，对任意 matcher 覆盖的路径 POST 一个大 body，Next 会在调用 `proxy.ts` **之前**就 `cloneBodyStream()` 把 body 读进内存（上限 272MB），而 401 要等**整个 body 收完**才发出——实测"只发头不发 body"时 `/api/health` 8 秒 0 字节。`proxyClientMaxBodySize` 不是拒绝阈值，超限只截断不 413，也没有全局上限。这一条与权限档无关、不需要任何用户操作、默认配置即成立；**档位取决于你怎么部署**：只听 `127.0.0.1` 记 P1，开了 LAN/隧道就是 P0（本报告按 P0 记，理由见条目内的"定级分档"）。顺带说明鉴权的整体面仍然站得住——34 个路由逐个查过、没有未鉴权或可绕鉴权的入口；漏的不是鉴权**逻辑**，是鉴权**之前**的缓冲。

---

## 2. P0 清单

### P0-1 `write`/`edit` 的 `file://` URL 绕过路径闸门：`workspace` 档可写任意位置（sandbox）

- **现象**：闸门自己解析路径，只做 `path.resolve`，不认 URL scheme；pi 的 `write`/`edit` 用另一套解析，**其中包含 URL → 本地路径的转换**。
- **位置**：`src/lib/permission-gate.ts:53`（`resolveModelPath` 末尾）、`src/lib/permission-gate.ts` 的 `judgeWritePath`；对照 pi `dist/utils/paths.js:119-120`、`dist/core/tools/write.js:31`。
  ```ts
  // src/lib/permission-gate.ts:43-54  —— 整段不认 URL scheme
  export function resolveModelPath(raw: string, cwd: string, home = os.homedir()): string {
      const cleaned = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").trim().replace(/^@/, "");
      ...
      return path.resolve(cwd, expanded);
  }
  ```
  ```js
  // pi dist/utils/paths.js:119  → write.js:31  const absolutePath = resolveToCwd(path, ctx?.cwd || cwd)
  if (/^file:\/\//.test(normalized)) { return fileURLToPath(normalized); }
  ```
- **用户能感知到的后果**：`workspace` 档的写入边界**完全失效**，等价于 `full`。可写 `%APPDATA%\...\Startup\*.bat`（下次登录执行）、`~\.ssh\authorized_keys`（横向移动）、`.git/hooks/*`、`C:\Users\Public\*`。用户以为"只改这个项目"。
- **证据强度**：lead 用探针实测 `permissionDenial({preset:"workspace", toolName:"write", input:{path:"file:///C:/Users/guica/.ssh/authorized_keys"}})` 返回 **`undefined`（放行）**，而 pi 侧实际落点是 `C:\Users\guica\.ssh\authorized_keys`；复核人另用 node 复刻两边解析并做了对照。**另已排除同级写法**：`/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 闸门与 pi **都判区外**（一致拒绝），所以只有 `file:` 这一个口子——这一点很重要，它说明这是**单点遗漏**而不是整套解析错，修一条就够。
- **最小修法**：`resolveModelPath` 里先 `if (/^file:\/\//i.test(cleaned)) → fileURLToPath(cleaned)`（与 pi 对齐），**并加拒绝清单**：`file:`、`\\.\`、`\\?\`、`\\`（UNC），闸门宁可假阴性。约 6 行。
- **验证方式**：单测 `judgeWritePath(ws, "file:///C:/Windows/x").inside === false`；e2e 在临时工作区让模型 `write({path:"file:///C:/Users/<u>/Desktop/probe.txt"})`，预期被拒且桌面无文件。

### P0-2 `readonly` 档不是零写入：Low 标签属于磁盘而不属于沙箱实例，重启后长期成立（sandbox + bridge）

- **现象**：只读沙箱靠"给工作区目录打 Low 完整性标签，子进程也是 Low，因此不能往 Medium 写"。但标签是**磁盘状态**，只在沙箱 `dispose()` 时还原；切档位不释放沙箱，进程异常退出则**永不还原**，且 PiWeb 在磁盘上没有任何"我标过谁"的记录，重启后无从判断该还原谁。
- **位置**：
  ```ts
  // src/lib/sandbox/manager.ts:67-68  缓存 key 只有 sessionPath\0mode
  return `${sessionPath}\u0000${mode}`;
  // src/lib/agent-manager.ts:2948-2951  切档只清授权、重算工具名单，不动 holders
  m.toolPreset = preset; m.customActiveTools = undefined; clearEscalation(m); applyToolPolicy(m, session);
  // 释放沙箱的唯一入口（全仓 grep 只有这一处调用）
  src/lib/agent-manager.ts:2167  void releaseSandbox(m.sessionPath);
  // 还原标签的唯一位置，只由 dispose() → releaseSandbox 触发
  src/lib/sandbox/windows-acl.ts:103  await run("icacls", [dir, "/setintegritylevel", "(OI)(CI)Medium"], ...);
  ```
- **用户能感知到的后果**（这条的影响不止"时序窗口"）：
  1. **切换档位无效**：同一会话先跑 `workspace` 档（标签落盘）→ 用户切「仅可查看」→ 模型 `bash` 写文件**成功**。用户切只读正是为了拦住这件事。
  2. **重启后长期成立**：进程被强杀/崩溃/断电后标签留在盘上，此后**新建的、从未跑过 workspace 档的 readonly 会话**照样能写这个工作区。**我在写稿时（19:40 采样）当场复测成立**：`icacls D:\` 无显式标签，而 `icacls D:\AIApp` / `icacls D:\AIApp\PiWeb` 都是 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`——父目录无标签→这是显式打上的；同时 `~/.pi/agent/web-sandbox` 下只剩 1 个空目录、`LastWriteTime` 早于当前 server 启动时间，说明那一代进程未收尾。
  3. **无从自动复原**：所有权只存在内存里的 `holders`（`sandbox/manager.ts:35`），磁盘无记录，`docs/workspace-isolation.md` 的兜底只能是让用户手动执行 `icacls <dir> /setintegritylevel (OI)(CI)Medium`。
  4. **放大器**：如果工作区选的是父目录（本机注册表里就有 `D:\AIApp`）或家目录（历史里有 `C:\Users\guica`），整棵树变 Low，于是 `~/.ssh/authorized_keys`、`%APPDATA%\...\Startup`、`.pi/agent/auth.json` 对**任何 Low 进程**（浏览器 low-IL 渲染进程、别的低完整性工具）都可写。
- **最小修法**（两条都做，若只做一条选后者）：
  1. `createAclSandbox` 标 Low 前把目标路径写进 `<tempDir>/marks.json`（或 `~/.pi/agent/web-sandbox/marks/<key>.json`），`dispose` 时删；**进程启动时扫一遍遗留 marks，把列出的目录 `markMedium` 并清理**——这条能同时兜住崩溃残留，而崩溃残留是本机当前真实存在的状态。
  2. `setToolPreset` 切到更严档位时 `await` 释放上一个档位的沙箱（给 `releaseSandbox` 加"只释放指定 mode"的入口）。
  3. 顺带：`markMedium` 失败改成 `console.warn`，别 `.catch(() => undefined)`。
- **验证方式**：修前先取证——当前机器上把 `D:\AIApp\PiWeb\.audit-2026-11-13` 当工作区开一个 readonly 档会话，`bash` 跑 `echo probe> ro-probe.txt`，**文件出现即证实**；修后断言：切档后 `icacls` 显示 Medium、重启后不再残留、readonly 下写入被内核拒（`EPERM/EACCES`）。

---

### P0-3 未认证请求的 272MB 请求体在鉴权**之前**被完整缓冲：远程即可吃满进程内存（api-auth + launcher-build，v2 新增；原 P2-90 升格）

- **现象**：任何能连到 PiWeb 端口的人，对任意 matcher 覆盖的路径 POST 一个大 body，Next 会在调用 `src/proxy.ts` **之前**就 `cloneBodyStream()`，把 body 逐块读进内存（上限 = `proxyClientMaxBodySize` = 272MB）——`proxy.ts` 一个 body API 都没调也照样缓冲。**而这个 401 要等整个 body 收完才发出**。`proxyClientMaxBodySize` 不是拒绝阈值：超限只截断 + `console.warn`，没有 413，也没有全局上限。
- **位置与顺序（是死的，不是推测）**：
  ```js
  // node_modules/next/dist/server/next-server.js:1215-1235 —— Node middleware 分支（本实例走的就是这条）
  body: hasRequestBody ? requestData.body.cloneBodyStream() : undefined,   // :1227 先 clone，此时 proxy 还没跑
  ...
  } finally {
    if (hasRequestBody) { await requestData.body.finalize(); }             // :1233 proxy 返回后才 finalize
  }
  // body-streams.js:52-118 —— input.on('data') 一挂上 body 就进入 flowing 模式，无条件读进 p1/p2
  // body-streams.js:95-109 —— 超限只 p1.push(null)/p2.push(null) 丢弃剩余字节：不销毁连接、不报错
  // body-streams.js:67-76  —— finalize() 第一句就是 await endPromise（'end' 在 getCloneableBody 创建时就绑上了）
  ```
  配置在构建期被归一化成 **285,212,672 字节**（`next.config.ts:53` → `next/dist/server/config.js:685-701`；默认值本来是 10MB，`config-shared.js:289`）。`resolve-routes.js:124-127` 对**每个**非 upgrade 请求都先建 clone；matcher（`src/proxy.ts:86`）只排除 `_next/`、`_piweb-dev/`、`icon.svg`、`favicon.ico` 四个前缀，`src/app/api/**` **34 个 `route.ts` 全部在内**。
- **实测**（`127.0.0.1:30141`，探测时 `start-server` 子进程 PID 21992；**口径更正（lead 复核）**：该实例当时跑的是 **dev 模式**——父进程 `bin/piweb.js --dev`（PID 6032）自 18:48:58 起、其下 `next dev --webpack -p 30141`（PID 30272）未变，不是 `next start`；dev 与 prod 走的是**同一套 Node middleware 缓冲逻辑**（`next-server.js` 的 clone/finalize 分支相同），但 dev 的 HTTP 层每个请求多约 30–45ms。单次 ≤20MB、并发 1、**未改任何源码/配置、未重启/杀该进程**；探针放 `%TEMP%`、跑完已删，每批之后 `/api/health` 仍 200）：
  1. **只发头不发 body → 8s 内 0 字节**：`Content-Length: 20971520` 但一个 body 字节都不发，`POST /api/health` 与 `POST /login` 都 **8.0s 读超时、0 字节**；同一时刻**不经过 proxy** 的 `POST /_next/nonexistent-verify.bin` **1.81s 就回 404**（证明 404 根本不需要 body，是 proxy 路径把响应扣住了）。
  2. **401 在上传结束后 2ms**：20MB 未认证 POST → 上传 **123ms**（≈160MB/s，说明服务端在主动把 body 读进内存）、401 在上传结束后 **+2ms**；2MB 慢传（先发 1MB 停 2s）**2s 内 0 字节**，补齐后 **17ms** 出 401。→ 401 不是"算得慢"，是在**等 body**。
  3. **RSS 平台 +17~19MB**：20MB hold（停 3s，10ms 采样）两次干净测量 **+18.6 / +17.1MB**，响应后 4s 仍 +17~19MB 未回收；**同尺寸 2MB 对照 +0.0MB**。把 Next 的 `getCloneableBody` 逐行搬到独立进程复现：20MB → **+21.2MB 常驻、`p1.readableLength = 20MB`**，4MB → +4.3MB，**线性**。
- **推演 272MB（不需要真发）**：单请求常驻 ≈ min(body, 272MB)（p1/p2 引用**同一 chunk**，是一份内存）；持有时间由客户端控制（Node 默认 `server.requestTimeout` 300s，Next 只覆盖了 `keepAliveTimeout`）；官方文档明说 limit 是 **per-request 不是全局** → N 条连接 = N × 272MB。本机物理内存 15.8GB、探测期间可用最低 **1.0GB**、服务自身已占 ~3.4GB private → **272MB × 10 连接 ≈ 2.7GB 常驻，OOM / 长时间换页 / 服务假死可复现**（100Mbps 链路上 272MB 约 22s 传完）。
- **定级分档（v2 明确，不用含糊）**：
  - **仅回环监听**（`127.0.0.1`；本机示例实例 `netstat` 只有回环）→ 攻击面 = 本机任意进程 → **P1**。
  - **开了 LAN（`-H/--hostname`）或隧道/远程入口** → **P0**：未认证、远程可达、默认配置即成立（与 `PI_WEB_AUTH` 无关——`proxy.ts` 不读 body，401 只是"最后才发"）、可反复触发、后果是**整进程不可用**（连带正在跑的 agent 会话）。
  - 本报告按 **P0** 记，理由：README 与默认启动都把远程/移动端当一等功能，而这只是"多一个 `-H` 参数"的档位差，不适合靠部署约定兜底。
- **为什么说这是"有意为之的过宽"**：`next.config.ts:53` 的注释明确写着这个数字是为 **268MB base64 图片粘贴**留的余量——272MB 不是保守默认，而是为了**一个功能**主动放开的**全局**阈值。这是本次少数"能直接指出改哪里"的条目之一。
- **修法（按"能不能真拦住"排序）**：
  1. `proxyClientMaxBodySize` 压回 **`12mb`** 量级（图片功能配合第 4 条）——**这是缓解不是根治**，缓冲仍在鉴权前。
  2. **唯一能"在鉴权前就拒"的位置在 Next 之前**：`scripts/launcher.mjs` / 移动端代理那一跳做 `Content-Length` 预检（超限直接 413 + 断开）。**在 `src/proxy.ts` 里加检查无效**——clone 已经发生，且 `finalize()` 会等 body 结束，攻击者不配合就一直占着。
  3. 大 body 通道**移出 matcher**：图片上传端点放到 matcher 排除的前缀下，route 内自己做会话校验 + 流式处理，这样走不到 clone（代价：该路由必须自己认证）。
  4. 前端改成压缩/分片（图片先压到几 MB），配合第 1 条之后就不再需要 272MB。
- **验证方式**：`Content-Length: 20971520` 只发头 → 期望 **<1s 收到 413 且连接断开**（现状 8s 0 字节）；修法 3 落地后，同级前缀的大 body 不应引起 RSS 上涨。
- **未做的（诚实边界）**：没有真发 272MB（>20MB 属压力型请求，超出本轮授权）。272MB 这个上限的结论来自 20MB 线性实测 + `getCloneableBody` 原样复现 + 代码里 `sizeLimit` 直接取自配置。真压测留在附录 B #19。另一条**未定的观察**：dev 的 `start-server` 子进程在探测结束后（20:04:57）换过 PID——可能是 dev 热重载（同期另一会话在改源码），也可能是内存压力，**因果未确认**，不写进结论。

---

## 3. P1 清单

> 格式：**现象 → 位置 → 后果 → 修法 → 验证**。同根因跨区域发现的已合并，括号注明来源区域。

### P1-1 点「停止」没有兜底：`await session.abort()` 无超时，复位帧排在它后面（bridge + chat-ui + api-auth）
- 位置：`src/lib/agent-manager.ts:2861-2871`；前端 `ChatInput.tsx:506` / `AppShell.tsx:744` / `usePiWeb.ts` 的 `sendCommand`（fetch 无 signal 无超时）；路由 `src/app/api/agent/[id]/route.ts` 直接 `await execute(...)`。
  ```ts
  case "abort": {
      const cleared = m.session.clearQueue();
      m.session.abortBash();
      await m.session.abort();                         // ← 无 catch、无超时
      publish(m, { type: "status", isStreaming: false, state: "aborted", ts: Date.now() });
      return { ok: true, data: cleared };
  }
  ```
  SDK 契约：`abort()` 内部 `this.agent.abort(); await this.waitForIdle();`——**等到 idle 才返回**。同文件 `abortRunAndWaitIdle` 有 5 秒上限，两处口径不一致。
- 后果：① HTTP 请求永不返回 → 前端 `restoreQueued(await onAbort())` 永不执行，而服务端 `clearQueue()` 已经把排队消息删了、`cleared` 又送不回去 → **用户排队的 steering/followUp 文本丢失**；② 浏览器一帧 `aborted` 都收不到 → 界面继续 streaming，停止键一直亮、可连点发送 N 个 abort POST；③ `m.runActive` 只在 `agent_settled` 清，`isManagedBusy` 含 `!session.isIdle` → 会话**永久判忙**：prompt 被拒、`reap` 跳过、快照 `isStreaming` 恒真；④ **归档也解不开**——`disposeSessionPath` 同一句 `await session.abort()`，`DELETE /api/sessions/<id>` 一起挂住。唯一出路是重启服务。
- 修法：`Promise.race([session.abort().catch(()=>undefined), timeout(ABORT_GRACE_MS)])`，**不管等没等到都先发状态帧、先返回 `cleared`**；超时打 warn 并记 `m.abortTimedOutAt`，让 `reap`/`isManagedBusy` 能在 N 分钟后走现成的 `shutdownSession()`（内含 5 秒上限 + `dispose()`）把会话从"永久卡死"降级为"本轮作废、可重开"；`disposeSessionPath` 同样 race 后再 dispose。前端 `stopAndRestore` 加 `stopping` 态 + 4s 未响应提示 + 对 abort 传 `AbortSignal.timeout`。
- 验证：让假 session 的 `abort()` 永不 resolve，断言 ① `execute({cmd:"abort"})` 在上限内返回 ② 必有 `status{state:"aborted"}` 帧 ③ 返回的 `data` 带被清掉的队列文本。
- **lead 的现场记录（症状已观察到，机制尚未定死）**：本日 18:0x–18:3x 有一个真实会话 `…-70aa-bd73-5fbc19029ea5.jsonl` 卡在 `streaming=true`、`lastStep="read · …/piweb-ui.ts"`，**15 分钟无任何新事件**；对它下 `abort` 返回 `ok`，服务端状态**仍是 streaming**。说明"点停止之后停在流式"这一类是真实存在的（不是纯理论）。但它同时说明**不只**是"`abort()` 不返回"这一种机制——那次 abort 明明返回了、复位帧按代码应当已发，状态却没恢复，另一种可能是收尾期的 deferred 续跑又发了 `agent_start`（或快照 `isStreaming` 另有来源）。**两种机制都要按上面修法兜住**；定性实验见附录 B #4（判读标准补一条：若 abort 返回 200 而状态未复位，则命中"复位被后续事件覆盖"而非"abort 挂住"）。

### P1-2 客户端的流式状态不能自愈：单帧丢失或一次异常就永久卡住（chat-ui）
- 位置：唯一写入口 `src/hooks/usePiWeb.ts:344` `if (s.snapshot) s.snapshot = { ...s.snapshot, isStreaming: evt.isStreaming };`；唯一读 `AppShell.tsx:534`；对账数据其实每 3 秒就在手上（`usePiWeb.ts:859-870` 的 `running` 只喂侧栏）；轮询通道 `src/lib/chat/event-stream.ts:99-103` 的 `handlers.onMessage(frame.data)` **无 try/catch**，外层 `void (async () => { while (!closed) {...} })()` 无 `.catch`。
- 后果：(a) 任何一次 `status{isStreaming:false}` 没到（代理掐断、批处理 cancel 丢帧、服务端 P1-1 没发）→ 永远显示 streaming，且流式态下 `doSend` 走 steer 分支而服务端其实空闲 → 用户收到英文报错 `session is busy; choose steer or followUp` 且消息发不出去；(b) 公网隧道（`*.trycloudflare.com`，`usesEventPolling` 为真）上一次格式漂移就让轮询循环 Promise reject 且无人处理 → 之后**再也不发任何轮询请求**，界面停在某一帧看起来"已连接"。
- 修法：(a) 在会话列表轮询里对账：当前会话连续两轮 `running[path].streaming === false` 而本地仍 true（或事件静默 >10s）→ `resync()`，最多 30s 一次；(b) `event-stream.ts` 帧循环加 `try { onMessage } catch { onError(); break }`，并把 `extensionDialogsFromSnapshot`/`toolsFromMessages` 的入参做 `Array.isArray` 防御。
- 验证：打开流式会话后不再发 `status`、让 `/api/sessions` 报 `running:{}` → 断言 N 秒后复位；`event-stream.test.ts` 加"onMessage 第一次抛错后仍继续轮询"。
- **v2 关联（拆出 P2-111 / P2-112）**：真 Chromium 390×664 把这条从"代码推断"补成了"浏览器观测"——① 断网 30s 期间界面**完全不变**（`"连接中断，正在重连…"` 文本搜索 false、`/events` 零新请求、无 `requestfailed`），恢复后 20s 内**仍无**新请求（`verify-mobile.md:222-232`）；② 把 `/events` 从建立起就 `route.abort()` → 只剩 spinner，`body.innerText` 仅 **93 字**、`EventSource` 每 ~3s 重试、**没有任何错误态或重试入口**（同文件 `:234-244`）。两者都是本条"客户端流式状态不能自愈"的直接后果，已各立一条（P2-111 / P2-112）。注意机制上仍有一条待真机确认：`usePiWeb.ts:1014` 的 SSE 分支没有心跳超时，`connected:false` 的唯一来源是 `onerror`。

### P1-3 扩展 slash 命令把整次提交（HTTP 请求）和提交锁一起挂住（bridge-tools）
- 位置：`src/lib/agent-manager.ts:2787-2810`（prompt 分支）→ `submitPrompt`（`:2687`）；SDK `agent-session.js:1705-1709` 的 `await this._tryExecuteExtensionCommand(text)` **在 preflight 之前**，`handled` 时只回 `"handled"` 不 resolve 我们的 Promise。
- 后果：`POST /api/agent/<id>` 一直不返回（路由无超时），`promptSubmitting` 为真期间新 prompt/steer/followUp/editAndResend/sendQueueNow 全被拒、`/reload` 被 `isManagedBusy` 挡住、`reap` 跳过；发起页 `isStreaming` 仍 false 所以**停止键不出现**，输入框卡在 `sending`。面板超时默认 **10 分钟**（`extension-ui.ts:44`），`/todo` 样板传 120s。影响面是**所有**耗时的扩展命令，不只是弹面板的。
- 修法：命中扩展命令时 `void session.prompt(...)` 并立即 `return { ok:true, data:{accepted:true} }`（错误仍走已有的 error 帧）；至少把 `promptSubmitting` 释放提前到"面板请求发布之后"；`status` 帧在 `promptSubmitting` 置真时也发一次，界面才能显示"等待应答"。
- 验证：装 `examples/piweb-extensions/todo-panel.ts`，空闲会话发 `/todo`，断言 `execute` 立即 resolve 且随后普通 prompt 不被 busy 拒绝。

### P1-4 `deferPublish` 的微任务抛异常 → 该会话事件流被一个 `null` 队头永久堵死（bridge）
- 位置：`src/lib/agent-manager.ts:524-531`（`while (queue.length > 0 && queue[0].events !== null)`）、`:565-574`（`queueMicrotask(() => { entry.events = events(); flushPublishes(m); })`，无 try/catch）。
- 后果：闭包里任一处抛（最可疑是 `routedModelEvent` 里没被 try 包的 `session.getAvailableThinkingLevels()`，对照 `buildSnapshot` 是包了的）→ `entry.events` 永远 `null` → 该会话之后**所有** publish 进队列再也不落地：无 delta/status/tool/usage，`m.seq` 不增长，连 `aborted` 帧也发不出。而且 `queueMicrotask` 里的异常是未捕获异常（生产 Node 默认可能退出进程）。
- 修法：微任务体 `try/catch/finally`（catch 里发一条 error 事件 + `entry.events = []`）；队头为 null 时不要无限等；顺手给 `routedModelEvent`/`publishModelState` 的 `getAvailableThinkingLevels()` 加 try。
- 验证：打桩让 `getAvailableThinkingLevels` throw，触发 `message_end`，断言之后新事件仍进 `m.buffer`。

### P1-5 `readonly` 档里用户的 `!` 命令完全没有沙箱，还会烧掉模型的一次性升权（sandbox + bridge）
- 位置：`src/lib/agent-manager.ts:1651`
  ```ts
  api.on("user_bash", () => (m.toolPreset === "workspace" ? { operations: userBashOperations } : undefined));
  ```
  `operations` 为 `undefined` 时 pi 回落到 `createLocalBashOperations()`（`agent-session.js:3268`）——**本地全权限**。
- 后果：readonly 档存在一条完整权限的 shell 通道（`!del /s /q D:\x`），与 `docs/workspace-isolation.md` 写的"`!` 走同一套 operations"不符；另外 `consumeGrant` 与模型共用 `m.escalation`（`:1649`），用户在模型刚拿到一次性授权后敲一条 `!` 会把那次授权消耗掉并写审计 → 模型随后被批准的越权操作突然被拒。
- 修法：`user_bash` 无条件返回 `{ operations: userBashOperations }`（内部已按 preset 选 readonly 模式、建不起来就拒绝执行，是安全默认）；若产品决定 readonly 下 `!` 就该不受限，则改 `tool-preset.ts` 注释并把 `consumeGrant` 传 `undefined`。
- 验证：readonly 档 `!echo x > %USERPROFILE%\Desktop\bang.txt`，预期被拒；（已确认 `{cmd:"bash"}` 端点本身受鉴权保护，故不升 P0。）

### P1-6 把工作区根整棵标 Low：工作区选得越大，`~/.ssh` / `%APPDATA%` 对整个 Low 世界开放（sandbox）
- 位置：`src/lib/sandbox/windows-acl.ts:98` `run("icacls", [dir, "/setintegritylevel", "(OI)(CI)Low"], …)`——**递归可继承**，作用于整棵树；工作区来源无黑名单（`path-security.ts:63-73` 只 `realpath + isDirectory`）。
- 后果：`D:\AIApp` 这种父目录被标 Low 后，它下面**所有项目**（本机注册表里就有 `D:\AIApp`、`D:\AIApp\harness`、`D:\AIApp\PiWeb`、`C:\Users\guica\Desktop`，全部带 Low）对整个 Low 世界可写；家目录作工作区时 `~/.ssh/authorized_keys`、`.pi/agent/auth.json`（API 密钥）从"内核禁止低完整性写"变成"任何低完整性进程都能改"。这把 P0-2 的破坏面从"工作区"扩到"用户配置与凭据"。
- 修法：`resolveWorkspacePath` 加黑名单（拒绝包含 `%USERPROFILE%`、盘符根、系统目录的路径），或在 `markLow` 前做包含性检查并在 UI 明确警告。
- 验证：把 `C:\Users\<u>` 设为工作区跑一次 workspace 档 bash，`icacls %USERPROFILE%` 应出现 Low；修后应被拒绝注册。

### P1-7 「写全被拒」不成立：`%LOCALAPPDATA%Low` 等默认 Low 目录两个档位都能写（sandbox）
- 位置：前提写在 `src/lib/sandbox/windows-acl.ts:8`（"其余目录都是 Medium"）；`bash-operations.ts:112` readonly 给空可写列表。实测 `icacls "%USERPROFILE%\AppData\LocalLow"` → `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，`(NW)` 只挡往上写，**Low 写 Low 允许**。
- 后果：readonly 档仍能在工作区外落盘（可作投放点），"零写入 / 只在工作区写"的产品承诺是假的。不是提权（仍是 Low 对象），但用户的安全预期是错的。现有测试只测了工作区目录与 `%TEMP%`（都是 Medium），所以没暴露。
- 修法：文档与 UI 措辞从"写入全被拒"改成"写不进 Medium 及以上的位置"；技术上要真零写入只能上 AppContainer 或只读挂载（属产品定位问题）。至少启动时列出本机已知可写的 Low 目录做提示。
- 验证：readonly 档 `bash` 跑 `echo x> "%USERPROFILE%\AppData\LocalLow\piweb-probe.txt"` 再 `type`。

### P1-8 一次性升权不绑定具体动作：批准"一条命令"后可以换成任意 full 命令或任意越界写入（sandbox）
- 位置：`src/lib/agent-manager.ts:1354-1357` `grant: (scope) => { clearEscalation(m); m.escalation = { scope, remaining: 1 }; }`；消费处 `:1787` `consumeEscalation(m, describeEscalatedToolCall(...))`——command **只用于审计，不比对**。
- 后果：批准卡文案写"只对下一次越界操作（一条命令或一次写入）生效"，实现是"下一次任意动作、任意目标"。模型用"需要 `git worktree add`"拿到 full，随后 `powershell -c ...` / `curl | cmd` / 写任意路径都不受检查（`escalatedPreset === "full"` → `permissionDenial` 直接 `undefined`）。配合 P0-1 等于一次点击后门。
- 修法：`grant(scope)` 一并存 `reason` 与目标提示，消费时与实际命令/路径做粗匹配（含/前缀），不匹配就要求重新申请；或至少把批准卡文案改成"下一次越界动作（可能是任何命令/任何路径）"。
- 验证：批准一次 full 后执行一条与理由无关的命令，期望被拒（当前会放行）。

### P1-9 `customActiveTools` 整体取代档位白名单，执行期闸门又只认硬编码工具名 → 插件工具在「仅可查看」档能写盘（plugins + bridge-tools + sandbox）
- 位置：
  ```ts
  // src/lib/agent-manager.ts:1804  custom 一旦存在，档位白名单完全不参与
  const allowed = m.customActiveTools ? m.customActiveTools.includes(name) : presetAllowsTool(effectivePreset, name);
  // src/lib/agent-manager.ts:2957-2965  setActiveTools 只与"已知工具全集"求交，不与档位求交
  const next = [...new Set(wanted)].filter((name) => all.includes(name));
  // src/lib/permission-gate.ts:31-38 第二道锁认的是固定名字
  const MUTATING_TOOL_NAMES = new Set([...SHELL_TOOL_NAMES, "write", "edit", "codemode", "manage_automation"]);
  ```
- 后果：readonly/workspace 档下勾一个扩展注册的工具（`my_ext_apply_patch`）后，`toolPolicyDenial` 只看这份清单放行，执行时 `permissionDenial` 不认识这个名字 → readonly 分支 `return undefined`（放行），workspace 分支 `WRITE_PATH_FIELDS.get(name)` 为 `undefined` → 也放行。该工具内部写盘/起进程**不受任何路径闸门约束**。这是除 P0-1/P0-2 之外**唯一一条模型可见的越权写盘路径**。触发需"已鉴权客户端调 setActiveTools"或"旧版 `web-tool-preferences.json` 残留"（老版本有工具开关页，`git log -S setActiveTools` 命中多个提交），模型自身没有这个工具。
- 修法：`setActiveTools` 落地时与档位求交（`next.filter(n => presetAllowsTool(preset,n) || isMcpToolName(n))`）；或在 `sanitize`/`ensureToolPreference` 里求交并丢弃空结果（`customActiveTools: []` 现在会让该会话**一个工具都没有**，含 `read`）。给扩展工具引入"声明式能力"是更彻底的解法。
- 验证：注册一个不在白名单里的写盘工具，readonly 下 `setActiveTools` 打开它，断言执行被拒。

### P1-10 技能删除的递归范围是黑名单而非"在技能根内"：junction 场景会删掉工作区外的整个目录（plugins-skills + api-auth，**原 P0 降级**）
- 位置：`src/lib/skills-service.ts:228-233`（`ownsDir` 四个条件全是"不在黑名单"）、`:189-201`（黑名单只有 7 个**精确路径**）、`path-security.ts:83-89`（授权返回 **realpath**）。
  ```ts
  const ownsDir = path.basename(authorized) === "SKILL.md"
      && path.dirname(skillDir) !== skillDir
      && !protectedRoots.has(comparableDir)                  // ← 只有黑名单
      && !others.some((other) => other !== comparableFile && within(other, comparableDir));
  const removed = ownsDir ? skillDir : authorized;
  await fs.rm(removed, { recursive: ownsDir, force: true });
  ```
- 后果：`mklink /J %USERPROFILE%\.pi\agent\skills\pack D:\repos\skill-pack`（junction 不需要管理员）→ 点「删除」→ `authorized` 已被 realpath 成 `D:\repos\skill-pack\SKILL.md`，它不在黑名单里、目标根上直接放 SKILL.md 且无嵌套技能 → `fs.rm("D:\repos\skill-pack", {recursive:true, force:true})`，**整个仓库连同 `.git` 消失，不进回收站**。确认框只显示技能名、不显示路径（`SkillsSection.tsx:101`），用户没有机会看到要删什么。SDK 确实会跟随目录链接发现技能（`skills.js:173-193`），机制已双向核实。
- **为什么是 P1 不是 P0**（v2 已按实测修正）：三条同时成立才触发——①需要**用户自己**建 junction 或文件符号链接（PiWeb 与 pi 都不会创建这种结构；junction 一条 `mklink /J` 即可，无需管理员）；②链接目标根上直接放 `SKILL.md`；③删除是用户主动点的（有确认框）。
- ~~原第②条还要求"目标根上**没有嵌套技能**，否则 `others` 拦掉、只删单个文件"~~ —— **实测不成立，已删除这条降级理由**：SDK 的发现规则是"目录里有 `SKILL.md` 就不再下钻"，`inner/SKILL.md` **根本不会进发现列表**，`others` 里不含它 → **整目录（含嵌套技能）照样被删**（`verify-plugin-install` B2）。`others` 只在"同一目录里的第二个技能被**单独发现**"时才生效（B3，例如 `settings.skills` 里显式声明了 `.../inner`）。**结果是触发面比原判更大**：任何根上有 `SKILL.md` 的外部仓库都中招，不需要是"扁平技能仓库"这个特例，也不需要那两个同名字段凑巧。
- **仍然维持 P1、不升 P0 的理由**：降级所依赖的"频次"前提没变——仍需用户自己先建链接（PiWeb/pi 都不自动创建），全仓 Markdown 搜索 `junction|mklink|符号链接` 也没有"把技能仓库链接进技能根"的推荐用法。**但若产品将来在文档/UI 里推荐这种用法（多工具共享 `~/.agents/skills` 正是这种用法），或增加"从链接仓库导入技能"，必须升回 P0 并先修。**
- 顺带核实（v2）：删除后 `<agentDir>\skills\pack` 的 **junction 仍在**（`lstat().isSymbolicLink()=true`、`existsSync=false`、`dir /AL` 仍列出 `<JUNCTION>`），留下一个 UI 里既看不到也删不掉的坏链接；机制仍**不是**"`fs.rm` 跟随链接"（对照 B0：`fs.rm(junction,{recursive:true})` 只删链接、目标文件仍在），真正跟随链接的是 `resolveDiscoveredPath` 的 `fs.realpath`。
- 修法：递归删之前要求 `comparableDir` 位于某个**技能根之内**（白名单判定，约 5 行），否则退化成只删 `authorized`；对发现时拼写的 `dirname(filePath)` 做 `lstat().isSymbolicLink()`，是链接就只删链接本身；确认框带上真实删除路径 + `danger` 样式。
- 验证：临时 `PI_CODING_AGENT_DIR` + `mklink /J`，断言目标目录仍在（或只删链接）。**v2 修正验证口径**：对照必须用**真实 SDK 发现**（不要 mock `listSkills` 造嵌套技能）——嵌套技能**不会**保护目标（B2 的形状要作为回归用例）；要构造 `others` 生效，得把内层技能单独声明为发现源（B3）。

### P1-11 `web-workspaces.json` 一旦损坏，侧栏整表不可用且所有写操作也 500，UI 无修复入口（sessions-workspaces）
- 位置：`src/lib/workspace-store.ts:64-66`
  ```ts
  } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;   // JSON.parse 的 SyntaxError 没有 .code → 直接抛
  }
  ```
  接线：`src/app/api/sessions/route.ts:18-19`（`registerCwds` + `getWorkspaceRegistry` 同一 `try`）；写路径 `mutate` 同样经 `readFile`。`tests/workspace-store.test.ts:276` 把"拒绝一切操作"固化成了预期。
- 后果：任何 tab 每 3 秒的 `GET /api/sessions` → 500 → 侧栏完全空白（工作区/会话/归档全没有）+ `sessionListError` 常亮；更糟的是**修不动**：删除工作区、取消归档、归档全部 500，`refreshWorkspacesFallback` 也 500。用户只能自己找到并手改/删这个文件。几十字节的坏 JSON = 完整功能死锁。
- 修法：读的 catch 里把"解析失败"与 ENOENT 分开——解析失败把原文件 `rename` 成 `.corrupt-<ts>`（留证据）并返回空表（fail-open，只丢别名/归档标记，不影响会话）；`/api/sessions` 把 `registerCwds`/`getWorkspaceRegistry` 各自包 try。
- 验证：把该文件写成 `{` 后刷新页面，断言侧栏仍渲染会话列表且写操作可用。

### P1-12 非 UTF-8 文本：UTF-16 被判成「二进制」，GBK 静默乱码，两者都没有提示（files-viewer）
- 位置：`src/lib/files-service.ts:293` `if (preview.includes(0)) { return { … binary: true, content: "" }; }`；`:301` `content: preview.toString("utf8")`；`text-sanitize.ts:5-11` 的 `utf8Prefix` 只处理截断边界、不剥 BOM。
- 后果：记事本「Unicode 编码」保存的 `.txt/.ps1/.ini` 每隔一字节一个 `0x00` → 界面显示「二进制文件，不提供预览」，用户无法区分"真是二进制"还是"编码不认识"；GBK/Big5 没有 NUL → 整篇 U+FFFD 乱码被当正常内容渲染。UTF-8 BOM 不被剥掉（对照 `resource-fingerprint.ts:38` 是剥的，口径不一致）。中文环境这是**最高频**的真实故障，而仓库里没有 UTF-16 文件，所以现有测试一条都碰不到。
- 修法：先按 BOM 判编码（`EF BB BF` 剥掉；`FF FE`/`FE FF` 用 `utf16le`/字节交换），无 BOM 时用 `TextDecoder("utf-8",{fatal:true})` 试解，失败再判二进制；把"编码不受支持"作为 `FilePreview` 字段交给 UI。
- 验证：三种编码各写一个文件，断言 `binary === false` 且内容与原文一致；GBK 至少断言返回"编码不受支持"而不是静默 U+FFFD。

### P1-13 合并提交 / 冲突文件的 diff 永远渲染成「没有差异」（git-project）
- 位置：`src/lib/git-service.ts:288`（`git show --format= --patch <hash>`）、`src/components/DiffView.tsx:34`（hunk 正则只认 2 路 `@@`）、`GitPanel.tsx:277`（`diff && !diff.binary && !parsed` → 显示"没有差异"）。
- 后果：`git show -p` 对 merge 提交默认**不输出 patch**，而 `--numstat` 照常输出 → `patch:""` + 非零 stats → 面板同时显示「+113 −… 统计」和「没有差异」，自相矛盾。复核人实测本仓库：`66ba291` patch 0 字符 / numstat 113 行；`ab9a571` 0 / 223；`a8e924d` 0 / 2；`git rev-list --merges --count HEAD` = **27**。冲突文件走 combined diff（hunk 头 `@@@`），正则同样不匹配。全仓 grep `@@@|diff --cc|combined diff` **零命中**。最需要看 diff 的两个场景（解决冲突、审合并）都瞎了。
- 修法：`parseUnifiedDiff` 增加 combined 分支（`/^@{3} -(\d+)(?:,\d+)? -(\d+)(?:,\d+)? \+(\d+)/`，行前缀取两列中第一个非空格）；`gitShow` 加 `--first-parent` 让 merge 有可展示的 2 路 diff，patch 为空时不要回传 stats。
- 验证：造一个 merge 与一个冲突仓库，断言 `gitShow().patch` 非空且冲突页出现删/增行。

### P1-14 只要工作区本身是 git 仓库根，就往用户 `.git` 里静默写提交，且没有任何开关（growth）
- 位置：`src/lib/growth-service.ts:316` `if ("gitDir" in existing) return existing.gitDir;`（**只有非仓库根才要同意**）；`src/lib/agent-manager.ts:2636-2641` + `:2802`（每次 prompt 前无条件 `prepareGrowthBriefly`）。
- 后果（本机实测）：`refs/piweb/rounds/d-aiapp-piweb-5511943b` 上有 **218 个 commit**；`git rev-list --all --count` = 680、`--not <该 ref>` = 462 → 任何 `git log --all` / `gitk --all` / VS Code Git Graph 的"全部分支"视图多出 218 条 `piweb: round`（作者 `PiWeb <piweb@localhost>`）。`git branch -a` 里看不到（已确认 0 条），**不碰用户 HEAD/分支/暂存区/index/config**（有真实 git 测试断言），所以不是"污染历史/丢数据"；问题是：①用户毫不知情且**没有任何 UI 能关**（`grep growthEnabled|PIWEB_GROWTH src/` 零命中，`growthInit` 只存"是否同意建仓库"，仓库根永远不会被问）；②每轮把改动文件的完整 blob 写进用户 `.git/objects` 且挂在 `refs/piweb/*` 上**永久可达**，`git gc` 回收不掉，用户清理不掉除非知道 `git update-ref -d refs/piweb/...`；③commit trailer 带会话文件名 + 提问首行，等于把提问内容复制进仓库对象库；④`gcInBackground` 在**用户仓库**里每 50 次提交跑一次 `git gc --auto`。
- 修法：consent 触发条件从"不是仓库根"改成"这个工作区第一次被记录"（`growthInit === null` 时无论是否 git 仓库都先弹窗），弹窗里写清"会产生 `refs/piweb/*` 提交与对象，可关闭/删除"；项目面板给"关闭生长记录 + 删除 refs/piweb 并 gc"的入口。
- 验证：清除 consent 记录后在一个 git 仓库根开会话发一条 prompt，断言先弹同意书、拒绝后 `.git` 里没有 `piweb/`。

### P1-15 无人值守运行里模型一问问题，整轮空转到 30 分钟超时（automations）
- 位置：`src/lib/automations/runner.ts:21`（`DEFAULT_RUN_TIMEOUT_MS = 30*60_000`）、`:309-313`；`src/lib/extension-ui.ts:378-392`（`askQuestions` 传 `waitForViewer: true`）；`src/lib/ask-user.ts:10`（`ASK_USER_TIMEOUT_MS = 30*60_000`）。
- 后果：`waitForViewer: true` 正好废掉"没有 viewer 立刻返回默认值"这条短路 → 模型调 `ask_user_question`（readonly/workspace 档都在白名单里）或 `request_permission` → 挂起直到运行总超时 → `status:"error", error:"Automation run timed out after 30m"`。真正原因（模型在等人回答）在记录里完全没有；期间该任务后续调度全被互斥挡住。**prompt 写得不自包含时这是常规路径，不是边界**。桥层注释写的是相反意图（`agent-manager.ts:508-511`："used by background automation runs so headless extension UI prompts keep using defaults"）。
- 修法：给后台运行显式 headless 标记（`Managed` 字段或 `observeManagedEvents` 的旁路），让 `askQuestions` 在 headless 下用 `waitForViewer: false`；更稳的是把 `ask_user_question`/`request_permission` 从自动化活动工具里去掉，并在运行记录写"headless：问题被自动跳过"。
- 验证：fake deps 里让模型触发 `ask`，断言后台会话立即返回 `unavailable/skipped` 而不是等满超时。

### P1-16 局域网入口起不来或没 cloudflared 时，界面完全不呈现：永远「启动中…」且没有地址可用（remote，两条合并）
- 位置：(a) `src/lib/remote/supervisor.ts:404-410` 早退时不设 `publicError`；`:438-442` 错误只进 `lanError`；`src/components/RemoteSection.tsx:169-174` 只渲染 `public.*`（`status.lan` 全文零引用）。(b) `RemoteSection.tsx:83-86` `if (!publicReady) { setPair(null); return; }`，只请求 `public` 的码；`lan.urls` 全 `src/` 内只有 `instrumentation-node.ts:42`（终端日志）与 `remote/pair` 路由用过，**没有任何 UI 渲染过**。
- 后果：(a) 30142 被占用 → EADDRINUSE 只在 `lanError` 里，界面停在"启动中…" + 二维码占位，永远没有原因、没有重试按钮，后端口令每 30 秒重试一次把问题永久藏起来；(b) 没装 cloudflared（**默认情况**，它不随 PiWeb 安装）或 trycloudflare 被墙 → `publicReady` 恒 false → 面板显示"找不到 cloudflared"（这条对）但**局域网入口其实是好的**，用户既看不到 `http://192.168.x.x:30142` 也拿不到局域网配对码，手机侧唯一出路是自己敲地址再去终端抄启动令牌。`tests/components/remote-section.test.tsx:120-130` 还把"没有公网就不显示二维码"固化成断言，等于锁死这条降级路径。
- 修法：`RemoteSection` 渲染 `lan.urls`（点击复制）与 `lan.error`；`publicReady===false && lan.running` 时向 `/api/remote/pair` 传 `base:"lan"` 取局域网码——**服务端这条路径已实现且被 `tests/remote-pair.test.ts:43-45` 覆盖，只差前端接上**。
- 验证：占住 30142 起生产模式看面板是否显示原因；把 cloudflared 改名后再看是否出现局域网地址与局域网码。

### P1-17 「网络代理」保存后对模型请求不生效，界面没有任何"重启生效"提示，而"测试连接"当场通过（settings-i18n）
- 位置：`src/components/settings/GeneralSection.tsx:322`（该 `Row` 只给 `title`、无 `desc`，同文件其它行都有）；真正生效点只在 `scripts/launcher.mjs` 起子进程时（`readHttpProxySetting` + `applyProxyEnv`）；热应用白名单 `agent-manager.ts` 的 `applySettingsToSessions` 只含 `steeringMode/followUpMode/cacheWarming`；`grep applyHttpProxySettings|configureHttpDispatcher src/` = **0**（SDK 侧这两个函数只被 pi CLI 入口调用，且未从包入口导出）。
- 后果：改代理 → 保存成功 → 点"测试连接"通过（那是另起子进程把代理塞进 env 后探测，**必然**成功）→ 回对话发消息仍走直连（仍失败）→ 用户以为"代理没配好"反复改地址。企业网络里这个功能等于完全不可用，唯一解是重启而没有任何文案提示。
- 修法：`PUT /api/pi-settings` 响应带 `restartRequired: patch.httpProxy !== undefined`；`GeneralSection` 给这一行加 `desc` 或保存后显示"重启 PiWeb 后生效"。**不要试图在 PiWeb 侧热应用**（SDK 无公开入口）。
- 验证：断言响应携带 `restartRequired`，且 `applySettingsToSessions` 不处理 `httpProxy`。
- **v2 关联**：这条与 **P1-27**（`模型目录探测`自建连接、连 `NODE_USE_ENV_PROXY` 都不看）属同一类"代理覆盖不全"，且更新路径更彻底——`update-service` **完全不读** `httpProxy` 设置，只继承服务进程启动那一刻的 env（见 P2-108）。修的时候三处一起收口，否则"改完代理仍有一半功能连不上"。

### P1-18 模型目录会静默残缺：刷新失败被完全吞掉，认证探测失败被当成"未认证"并缓存 60 秒（models，两条合并）
- 位置：(a) `src/lib/pi.ts:75-77` `catch { if (modelRuntimePromise === pending) modelRuntimePromise = null; }`——全仓 `getError()` 只有 `models-service.ts:1491` 一处消费（自己校验配置用），共享运行时的 `getError()` **从未被读过**，`GET /api/models` 也没有"目录加载失败"字段；且 `refreshModelRuntimeIfFilesChanged()` **失败也返回 true**（V1-漏-4），调用方以为"已最新"。(b) `models-service.ts:343-346` `catch { authError = … }` 后 `authCheckCache.set(pid, { ready: authReady /* 仍为 false */ })`，`AUTH_CHECK_TTL_MS = 60_000`；`ModelSelector.tsx:123` `if (authByProvider[entry.provider] === false) continue;`（**隐藏**而不是置灰）。
- 后果：用户什么都没做，那家 provider 的模型整体从选择器消失（最长 60 秒），设置页同一时刻却显示红点 tooltip 写着真实原因；手改坏 `models.json` 则自定义 provider 全部消失而设置页还显示着它们。唯一的线索是"模型不见了"。
- 修法：`listModelsUncached` 读一次 `rt.getError()` 放进响应（如 `catalogError`）；认证探测区分三态（`ready`/`unauthenticated`/`probe-failed`），`probe-failed` 不隐藏模型、把 `authError` 带进精简目录；`pi.ts` 的 catch 至少 `console.warn` 一次。
- 验证：写一份坏的 `~/.pi/agent/models.json` 后 `GET /api/models`，看是否带错误字段（现在不带）；断网后把某 OAuth provider 的 expiry 改到过去，观察 `authReady/authError`。
- **(c) v2 追加：能力值残缺（同一条"静默残缺"，但修法完全不同——不是错误传播，是字段映射）**：经 `设置 → 获取可用模型` 落盘的自定义模型，能力字段按 `contextWindow:128000 / maxTokens:16384 / input:["text"] / reasoning:false` 兜底写死（SDK `provider-composer.js:96-114`、`model-draft.ts:36`），而 `catalogCapabilities` 的规则只认 OpenRouter 那一种 JSON 形状。把规则套在**真实公开目录**上实测（`verify-provider` §1.3）：**opencode 86 个模型里 85 个上下文被低估**（`opencode/big-pickle` 自报 200,000 → 落 128,000，少 36%；`opencode-go/grok-4.7` 自报 500,000 → 落 128,000，少 74%）、**71 个真支持图片的模型被判纯文本**（它们的 `modalities.input` 写的是 `image/jpeg` 这类 MIME 而不是 `image`）、86 个的 `capabilities.reasoning` 是对象 `{supported:true}` 而解析器只认布尔 → 全部 `reasoning:false`、思考档位消失。上游后果不是"少显示一个字段"：`pi-coding-agent/dist/core/tools/read.js:59-62` 在 `model.input` 不含 `image` 时**把用户贴的图换成一行 `[Current model does not support images…]`**，图被静默丢掉且提示语归因错误。完整规则比对与 opencode-go 的 30/30 数据见 **P2-110**。

### P1-19 Codex 来源按「文件头 64KB 里有没有 response_item」判断可导入性，实测 5/22 主会话被永久隐藏（import-export）
- 位置：`src/lib/session-import/codex.ts:122,129-130` + `files.ts:5` `readHead(file, bytes = 64*1024)`。
  ```ts
  const records = [...eachJsonLine(head)].slice(0, 300);
  const hasMessage = records.some((record) => record.type === "response_item");
  if (!hasMessage) continue;      // 面板里根本不存在
  ```
- 后果：Codex 现在把 `session_meta`（含 `base_instructions`）+ 一条 `response_item/additional_tools` 写在最前面，两者就吃掉 64KB，第一条真消息落在 69KB 之后 → 头里一条 response_item 都解析不出来 → 该会话在导入面板里**不存在**，`hasMore` 也只按"已收集几条"算，用户以为"Codex 只有 17 条"。复核人独立复现：主线程 22 个里 **5 个（23%）**不出现，文件名与报告逐字相同（`…01a1b987…`/`…01a1bdbe…`/`…01a1cebc…`/`…01a1d095…`/`…_01a1b98d…`）。
- 修法：`readHead(file, 512*1024)`，或 `createReadStream` + `readline` 逐行读到第一条 `response_item`（读满 N 行/1MB 就停）；`titleFrom` 同样处理。
- 验证：造一条 `session_meta` 22KB + `additional_tools` 46KB + 首条 message 在 69KB 的文件，断言它必须被列出。

### P1-20 ZCode / opencode / dsh 在原生依赖或源库不可用时静默返回 0 条，与注释承诺相反（import-export）
- 位置：`sqlite.ts:16-24`（`openReadOnly` 三种失败全 `return null`，而 `:3-5` 注释写"这两个来源报错"）、`oc-family.ts:152-153` `if (!db) return [];`、`dsh-zstd.ts:36-38`；`index.ts` 只把**抛异常**的来源放进 `errors`。
- 后果：`node:sqlite` 载不进来 / 库路径变了 / 库被独占锁住 / dsh 文件被截断——四种情况在 UI 上都长得和"这台机器没装那个工具"一模一样（"0 条会话 / 没有找到可导入的本地会话"），`errors` 是空的，用户无法自助排查。注释让人以为已经处理了。
- 修法：`openReadOnly` 返回 `{db} | {error}`（或抛错），`oc-family.scan` 在 `!db` 时抛错走已有的 `errors` 通道（UI 已有渲染逻辑）；dsh 的 `readZstdHead` 失败同理。
- 验证：mock `openReadOnly` 返回 null、给一个非 SQLite 文件、给一个损坏 `.zstd`，断言 `scan` 结果里出现 errors 而不是静默空。

### P1-21 「退出登录」把服务端失败吞掉：用户以为已登出、Cookie 仍在、被登录页弹回首页（crosscut）
- 位置：`src/components/settings/GeneralSection.tsx:343-346`
  ```tsx
  await fetch("/api/web-auth", { method: "DELETE" }).catch(() => {});
  window.location.href = "/login";
  ```
  服务端失败时 `api/web-auth/route.ts:64-70` 返回 **500**（早退，**早于** `:72-75` 的 `clearSessionCookie`）；`login/page.tsx:38` `if (!result.data.enabled || result.data.authenticated) router.replace(next);`
- 后果：HTTP 500 是 resolve 不是 reject，`.catch()` 完全兜不住 → Cookie 未清 → `/login` 读到 `authenticated:true` → 立刻弹回 `/`。用户看到"点登出没反应"且零错误提示；如果是"登出并吊销所有设备"，被拷走的 Cookie 依旧有效——**安全语义被静默降级**。同仓正确写法就在 `RemoteSection.tsx:121-123`（读了 `response.ok` 与 `result.success`）。
- 修法：读 `response.ok` 与 JSON 的 `success`，失败留在原页并提示。
- 验证：mock fetch 返回 `500 {success:false}` → 断言**不**跳转且出现错误提示。

### P1-22 测试的「静默跳过」体系让安全边界看起来是绿的（tests-coverage，三条合并）
- 位置与事实：
  - (a) `tests/agent-resource-isolation.test.ts:748,750` `if (process.platform !== "win32") return;` / `if (!(await probeSandboxSupport())) return;` —— **vitest 里 `it` 回调正常返回即记 passed**。它守的是"workspace 档 bash 必须真进 OS 沙箱、越界写必须失败"，在 ubuntu lane（CI 一半）和 koffi 装失败的 Windows 上**零验证却显示绿色**。
  - (b) `tests/lib/sandbox/windows-acl.test.ts:14` 只 `describe.skipIf(!win32)`，`:36` `sandbox = await createAclSandbox(...)` **不判 null**，`:22` `sandbox!.exec(...)`；而 `windows-acl.ts:122-124` 在非 win32/无 koffi 时 `return null` → **`TypeError`，不是 skip**。`readonly-mode.test.ts:26,36` 同构。文件头注释写的正是"没有 koffi 时整体跳过"，与实现相反。
  - (c) 全仓 **18 处** `if (...) return;` 静默早退（`growth-service.test.ts` 12 处、`growth-tracker.test.ts` 2 处、`agent-resource-isolation` 2 处、`sandbox/manager.test.ts` 1 处、`permission-gate.test.ts` 1 处）。其中 14 条 growth 断言在无 git 环境整体消失，报告只显示 "1648 passed" 且总时长变短，没有任何信号。
- 后果：`skipped` 计数完全反映不出"这批没跑"；CI 的 ubuntu lane 上安全用例静默通过，Windows 上新克隆则整条红且报 `TypeError`（看起来像产品坏了，实际只是 optional 依赖没装）。
- 修法：18 处改成 `ctx.skip()` / `it.skipIf(...)`；`beforeAll` 里 `if (!sandbox) ctx.skip()`；CI 加一条"`skipped` 清单必须是白名单子集"的守卫。
- 验证：改后断言 skipped 列表包含该用例；`npx vitest run` 的 skipped 数进入 CI 断言。

### P1-23 生产构建完整性自检只校验 21/305 个文件，残缺构建被判「可用」并报「就绪」（launcher-build）
- 位置：`scripts/build-output.mjs:99-106` 只把 5 个 mandatory 加进 `required-server-files.json.files` 再逐个 `statSync().isFile()`。实测：ready release 目录去掉 `cache/diagnostics/types` 后仍有 **305 个文件**（`server/` 下 117 个 `.js`，含全部路由 chunk），而 `required-server-files.json.files` 只有 **21 条**（20 个清单 + `server/instrumentation.js`），**不含任何路由 chunk**；仓库根 `.next` 同样 21 条（该目录 158 个 js/mjs）。覆盖率约 7%。
- 后果：删掉 release 目录一部分（或拷贝截断）→ 自检通过 → 启动器打印 `[piweb] 就绪：…` → 用户点开某页面/接口时才 `Cannot find module`，报错指向构建产物内部路径。本机历史上真出过"release 目录被清 + MODULE_NOT_FOUND"这类事故，这条校验正是本该拦住它的闸门。
- 修法：对 `${buildDir}/server/**/*.js` 做存在性 + 大小检查（305 次 `stat` 成本可忽略），或构建期写一份 `build-files.json` 随产物一起校验；至少查 `server/app/**/route.js`、`server/chunks/*.js`、`server/webpack-runtime.js`。
- 验证：造一个清单完整但删掉 `server/app/api/health/route.js` 的目录，断言 `selectProductionBuild` 抛错并给出可操作文案。
- **v2 追加（它就是"更新成功"的判定）**：这个函数不只服务构建自检——`installFromRegistry` 的**更新成功判定**就是它（`update-service.ts:174`）。所以"下载完整性"缺口的真正落点不是"有没有哈希/签名"（全仓 `integrity|signature|sha256|sha512|checksum|provenance` 在 `scripts/**` 与 `src/**` **0 命中**，完整性完全靠 npm 自身），而是**"更新成功"的定义只有 21 个文件存在**：`npm install` 之后先读新 `package.json` 版本（`:164`），再 `readProductionBuild(…, ".next")`（`:174`）；若 npm 崩在"新 package.json 已就位、`.next` 只落一半"之间，而拷贝序里 21 个清单靠前 → **判成功**。修法建议加一条：更新成功后跑一遍仓库现成的 `scripts/runtime/check-installed.mjs`（真起 Next、真打 6 个路由 + 首页，`verify-package.mjs:44-57` 已在用），比加 305 次 `stat` 更接近"用户能不能用"。

### P1-24 一次性安装构建用「先删后拷」替换正在服务的 `.next`，失败无回滚（launcher-build）
- 位置：`scripts/install-build.mjs:185-187`
  ```js
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  fs.cpSync(path.join(staging, ".next"), target, { recursive: true });
  ```
  对照 `release.mjs` 全程"新目录 + 原子写清单"、`apply-global.mjs` 至少是 rename 三段式——只有这里是**直接删掉服务的输出目录再拷**。
- 后果：production-only 安装 + `.next` 被判不完整时（`npm rebuild -g piweb`、服务运行中再起一个 `piweb -p 30150`、postinstall）进入这行：Windows 上删成功则整目录消失；`cpSync` 中途失败（磁盘满/被杀/权限）→ 半残，而 21 个清单在拷贝序里通常较早落地 → 下次启动命中 P1-23 把半残产物当"可用"直接服务 → 运行中实例下一次懒加载 chunk 就崩。这是**唯一一处会删掉正在被运行进程使用的目录**的代码。
- 修法：`staging/.next` → `<root>/.next.new-<ts>` → `rename(.next → .next.old-<ts>)` → `rename(.next.new → .next)`，任一步失败把 `.next.old` rename 回来。
- 验证：mock `cpSync` 抛错，断言旧 `.next` 仍在且 `BUILD_ID` 未变。
- **v2 明确：不降级，而且触发面比原报告更宽**（`review-update-release` §3）：① `scripts/launcher.mjs:407-408` **每次启动**都调 `ensureInstallBuild`，不只是 `npm rebuild`/postinstall；② 异常会**击穿返回值契约**——`ensureInstallBuild` 声称只返回 `skipped|built|failed`，但 `rmSync`/`cpSync` 抛错会直接抛出去，于是 postinstall 以未捕获异常失败，启动器的 `failed` 分支**永远看不到它**（I-1）；③ `scripts/apply-global.mjs:72-74` 是同类"把正在服务的 `.next` 挪走"的第二处。

### P1-25 构建失败不回退上一个 ready 构建，两条官方自救路径在成品包上又都必然失败——一次 Ctrl+C 就把安装锁死（launcher-build，**原 P2-96 升格**）

- 位置：`scripts/build-output.mjs:125-140`（`state !== "ready"` 一律抛 `release is incomplete or failed; … (no stale-build fallback)`，旧目录明明还在盘上）；`scripts/install-build.mjs:24-32`（`hasProductionBuild` 只看 `active.json` **是否存在**，不看 `state`）。
- **为什么升 P1（代价 × 自救不可用，两者相乘）**：
  1. 进入该状态的**代价极低**：成品包上按官方文案跑一次 `npm run build:release` 再按两次 Ctrl+C（`release.mjs:166-171` 只 `process.once` 挂一次 SIGINT，第二次走默认终止、`finally` 不跑），或一次 R-2 的 600s 超时（实测单跑 vitest 就 312.5s），`active.json` 就停在 `failed`/`building`。
  2. **两条官方自救路径在成品包里都无效**：`npm run check` 跑不起来（`npm pack --dry-run --json` 实测 987 个文件，**没有** `tests/`、没有 `vitest.config.ts`、没有 `next-env.d.ts`，而 `tsconfig.json:31-41` 的 `include` 第 32 行就列着它 → tsc 直接报错；第二段 `test` 依赖 `devDependencies.vitest`，`--omit=dev` 装完不存在）；`npm rebuild -g piweb` → postinstall → `ensureInstallBuild` → `hasProductionBuild` 因 `active.json` 存在返回 true → **skipped**，什么都不修。
  3. **唯一恢复手段是手删 `.next-releases/active.json`，而这件事没写在任何文案里**——那个目录还被 `.gitignore:5` 完全忽略、本机已堆 13 个目录 / 50 个文件 / 2,926MB（P2-98），普通用户不会去那里找。
- 修法：`selectProductionBuild` 在 `state !== "ready"` 时回退到 manifest 记录的上一个 ready（或 `.next-releases/*/BUILD_ID` 中最新的完整构建）并 `warn`；`hasProductionBuild` 改读 `state`（一行）；错误文案按安装形态分流（成品包 → `npm install -g @rexvane/piweb@latest`，源码检出 → `npm run build:release`）。
- 验证：造 `active.json = failed` + 一个完整的旧 release 目录，断言 `selectProductionBuild` 回退并 warn；再造 `state:"building"` + 残缺目录，断言 `hasProductionBuild` 返回 false。

### P1-26 非 Windows 的一键更新在服务运行中删掉自己的安装目录，而 UI 报"更新成功"（settings-i18n，**原 P2-89 升格**）

- 位置：`src/lib/update-service.ts:89-100`（`if (platform !== "win32") return true;`）、`:151-175`（`npm install -g @rexvane/piweb@latest`，**无 stop、无 503、无临时目录**）；`scripts/launcher.mjs:251`（`PIWEB_BUILD_DIR` = 包目录内的 `.next`）、`:502-504`（`cwd: plan.root`）。
- **后果链三段全在代码里**：运行实例的 `cwd` 与 `PIWEB_BUILD_DIR` **都在被替换的目录内**，npm 换包瞬间这两个路径消失 → Next 生产服务器按需从磁盘加载路由 chunk，下一次懒加载或读 `public` 静态资源就 `ENOENT`；与此同时 `installFromRegistry` 的成功校验看的是**新目录**（`:163-174`），必然通过 → API 返回 `{success:true, needsRestart:true}` → `update-store.ts:129` 显示"已更新" → **用户看到"更新成功"时运行实例已经在坏，直到重启**。若该安装跑过 `build:release`，`.next-releases/active.json` 也随包目录一起消失，旧 release 目录同样被删。
- 置信度：机制已确认（代码路径 + 目录归属）；"懒加载 chunk 立刻 ENOENT"这一步**疑似**（与 Next 版本/平台有关），验证方法不改代码即可做：临时 prefix 装旧版 → `piweb -p 30199 --no-open` → 记 `PIWEB_BUILD_DIR` → 另一 shell `npm i -g …@latest` → 请求一个没访问过的路由看是否 `Cannot find module`。
- 修法：`canSelfUpdateNpmInstall` 的判据从"是否 win32"改成"**运行实例的 `PIWEB_BUILD_DIR`/cwd 是否在安装目录内**"（所有平台都返回 false，UI 退回复制命令——这条路径的代码/测试/文案全都现成，`update-service.test.ts:262-279`）；若要保留一键更新，必须在 `npm install` 前进入维护态（停收新请求 + 等当前请求结束），而不是把"请重启"当唯一手段。
- 验证：契约测试断言 `canSelfUpdateNpmInstall(platform, installation)` 在"buildDir 位于安装目录内"时对所有平台返回 false。

### P1-27 代理覆盖不全：模型目录探测走自建连接，连 `NODE_USE_ENV_PROXY` 都不看（models，**原 P2-31 升格**）

- 位置：`src/lib/models-service.ts:504-560`（`https.request` + `agent: false` 自建连接）；对照 `scripts/launcher.mjs:149-177`（`NODE_USE_ENV_PROXY=1` 只对 `fetch()` 生效）。代码里**没有任何代理分支**；私网黑名单（`:483-502`）与 DNS 重解析防 SSRF 都是对的，漏掉的**只有传输层**。
- **实测（v2，去掉原判的"疑似"）**：`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=http://127.0.0.1:9`（故意指向死端口）下，`fetch()` → **立刻 ECONNREFUSED**（证明它确实走环境代理），而 `https.request(..., {agent:false})` → **401 直连成功**（证明它完全无视环境代理）。
- 后果：在**只能走代理**的网络（企业代理 / 需代理出网）里，`设置 → 获取可用模型` **必定失败**，而同一进程里 `fetch()` 系的用量探测、市场搜索都正常 → 用户看到"用量能读、模型探索失败"的诡异组合，且没有任何错误区分（TLS 失败 / 代理不通 / 404 全是一句英文 stderr）。
- 修法：模型探测改走 `fetch()`（或显式 `new ProxyAgent`），与用量探测/市场搜索统一；`update-service` 同理（P2-108）。
- 验证：死端口代理下 `GET /api/models` 的探索分支应失败且给出网络错误，同时 `/api/provider-usage` 也应同样失败（现状一好一坏）。

---

## 4. 按功能区的结论表

| 功能 | 状态 | 主要问题编号 |
|---|---|---|
| 聊天与事件流（SSE/续传/折叠/Markdown/轨迹） | **脆弱** | P1-2（状态不可自愈）、P1-4（事件流黑洞）、**P2-111 / P2-112**（静默失联 / 永久 spinner，**真浏览器实测**）、P2-18~25（含 crosscut 的 P2-23~25 焦点/对比度/超时） |
| 停止 / 取消 | **有问题** | **P1-1**（abort 无上限，会话永久忙）、P1-3（扩展命令挂住提交）、P2-15（停止不取消扩展对话框）、P3-14（Esc 不是停止键） |
| 工作区与会话（侧栏/归档/持久化） | **有问题** | **P1-11**（注册表损坏即死锁）、**P2-115**（会话列表冷启动 2.94s / RSS +145MiB）、P2-34~41（只读轮询写盘 / 归档不可逆 / 无分页 / 多标签 / 无 URL / 草稿 / realpath） |
| 文件查看（预览/diff/上传/目录） | **脆弱** | **P1-12**（编码判定）、P2-42~45 / P2-47（**v2 已换成实测数字**，见 P2-45）、P3-22 / **P3-31**（原 P2-46 降级） |
| Git 面板 | **脆弱** | **P1-13**（merge/冲突 diff 恒空）、P2-48~52、P3-20/21 |
| 项目成长树（growth） | **有问题** | **P1-14**（静默写 218 commit、无开关）、P2-53~58、P3-23 |
| 模型与供应商 | **脆弱** | **P1-18**（目录残缺静默，**v2 追加 (c) 能力值残缺**）、**P1-27**（目录探测不跟随代理）、**P2-110**（能力表规则覆盖窄）、P2-26…33（其中 P2-29 / P2-33 → P3-28 / P3-29） |
| 权限档与沙箱 | **有问题** | **P0-1 / P0-2 / P1-5 / P1-6 / P1-7 / P1-8 / P1-9**、P2-1…10（P2-10 已按 UAC 策略实测维持 P2，见条目） |
| 插件与技能（含市场） | **有问题** | P1-10（删除越界，**v2 删除了一条错误的降级理由、触发面更大**）、P2-72…79（供应链；P2-73 → P3-30、P2-75 升级为已实测、P2-76 收窄到跨进程）、P3-10…13 |
| 自动化 | **有问题** | **P1-15**（无人值守空转 30 分钟）、P2-59…65 |
| 远程访问（隧道/配对/代理） | **有问题** | **P1-16**（局域网状态不呈现）、P2-66（**v2 改写**：仅崩溃/强杀路径）、P2-67…71、**P2-114**（隧道 kill 语义与更新路径不一致） |
| 设置与 i18n（主题/提示词） | **脆弱** | **P1-17**（代理假配置）、P2-86…88 |
| 更新（自更新/启动检查） | **有问题** | **P1-25**（原 P2-96：失败不回退旧版 → 安装锁死）、**P1-26**（原 P2-89：非 Windows 替换在服目录）、**P2-108**（启动令牌随 npm 脚本外泄）、**P2-109**（`update.lock` 无人读）、P3-27（pi 目标不校验 registry 输出） |
| 会话导入导出 | **脆弱** | **P1-19 / P1-20**、P2-80…85 |
| 启动与发布（launcher/构建/CI） | **脆弱** | **P1-23**（只校验 21/305，**v2：它就是更新成功判定**）/ **P1-24**（先删后拷，**v2 明确不降级**）、P2-97…101 |
| 审计与鉴权的整体面 | **路由 OK，但鉴权**之前**漏了缓冲** | **正面结论仍成立：没有找到未鉴权或可绕鉴权的 `/api` 路由**（`PUBLIC_PATHS` 仅 `/login`、`/api/web-auth`、`/pair` + `GET /api/health`，实测 8 个路由抽样全 401）。**v2 新增 P0-3**：漏的不是鉴权**逻辑**，而是鉴权**之前** Next 内部的 body 缓冲（未认证即可占 272MB/连接）。脆弱点：P0-3、P1-21（登出吞错）、P2-93（`PI_WEB_AUTH` 未设置即 fail-open）、P2-91（启动令牌永久可重放）、P2-92（全设备登出的竞态）、P3-26（500 回显绝对路径） |

---

## 5. P2 / P3 合并表

### 5.1 P2（全列）

| 编号 | 一句话 | 位置 | 区域 |
|---|---|---|---|
| P2-1 | `kill()` 只 `TerminateProcess` 直接子进程（无 Job Object）；`dispose()` 也不杀在跑的子进程 → 假"已中止"+句柄泄漏 | `sandbox/windows-acl.ts:393-399`、`:236-240` | sandbox |
| P2-2 | `realpathLoose` 在 ENOENT/ENOTDIR 之外的错误上 fail-open（返回未解析路径继续判定） | `permission-gate.ts:67-70` | sandbox |
| P2-3 | 检查与写入之间的 TOCTOU：工作区内可建 junction 抢窗口，闸门无锁 | `permission-gate.ts:111-117` vs pi `write.js:44,47` | sandbox |
| P2-4 | 沙箱缓存 key 不含 cwd/extraRoots；切档/换 cwd 不重建；`releaseSandbox` fire-and-forget；两会话共用工作区互踩标签 | `sandbox/manager.ts:67-68,107-120`、`agent-manager.ts:2167` | sandbox+bridge |
| P2-5 | stdout/stderr 每 50ms 全量 `readFile`：O(n²) 读放大 + 落盘无大小上限 | `sandbox/windows-acl.ts:184-198` | sandbox |
| P2-6 | 沙箱后端失败面：`createAclSandbox` 把所有错误吞进 `catch {}`、`probeSandboxSupport` 只验 koffi 能 import、未检查 `process.arch`（结构体偏移写死 x64） | `windows-acl.ts:242-245,317-356`、`manager.ts:38-54` | sandbox |
| P2-7 | `exec` 中 spawner 抛错时私有 temp 残留空 `.out`/`.err` | `windows-acl.ts:176-182,208` | sandbox |
| P2-8 | 审计只记"批准/使用"，不记被拒的越权尝试；逃逸后可改会话 JSONL 抹账 | `permission-audit.ts:21-37`、`permission-gate.ts:154` | sandbox |
| P2-9 | 硬链接边界两道锁都不管（文档只写在第三道锁） | `permission-gate.ts:60-76` vs `docs/workspace-isolation.md:103` | sandbox |
| P2-10 | `powershell -c "Start-Process cmd -Verb RunAs"` 可弹 UAC 一步跳出所有边界（沙箱不挡 UI）。**v2 已实测（策略层）**：本机 `ConsentPromptBehaviorAdmin=5` + `PromptOnSecureDesktop=1` → Low 进程**不能静默提权**（必须用户点"是"、提示在安全桌面不可伪造/代点），机制可达但属社交工程面，**维持 P2**；`docs/workspace-isolation.md` 的"不限制的东西"应显式写上这条。**例外：`EnableLUA=0` 的机器会变成静默提权，那种环境应算 P1** | `windows-acl.ts:296-330`、`verify-uac.md` | sandbox |
| P2-11 | 会话忙态是多来源布尔位：`performReload` 的 `finally` 未保护 `applyToolPolicy`（抛了 `resourceReloading` 永久真）、`prompt` 的占位在 `await` 之后 | `agent-manager.ts:1967-1976,2790-2804` | bridge |
| P2-12 | `publishImmediate`/`translate` 无异常边界：一处 `JSON.stringify` 或 SDK 调用抛错会顺着 pi 的同步 `_emit` 抛回回合 | `agent-manager.ts:533-556,1685` | bridge |
| P2-13 | 偏好文件损坏/单条非法 → 档位静默变成另一个值，且可能被浏览器 localStorage 升到 `full` | `tool-preferences.ts:65-76`、`agent-manager.ts:1273-1282`、`usePiWeb.ts:1249-1271` | bridge-tools |
| P2-14 | `TOOL_PRESETS` 硬编码、无与"SDK 实际注册工具集"的 drift 检测 → SDK 升级后受限档静默少工具 | `pi.ts:495-518` | bridge-tools |
| P2-15 | 停止（abort）不取消已挂起的扩展对话框，会话继续忙到 10 分钟超时 | `extension-ui.ts:231,248-250`、`agent-manager.ts:2861` | bridge-tools |
| P2-16 | 扩展/插件工具在 readonly、workspace 档**一律不可见**，与文档"执行期闸门管扩展工具"矛盾（静默功能缺失） | `pi.ts:515`、`agent-manager.ts:1804`、`docs/workspace-isolation.md:28-29` | bridge-tools |
| P2-17 | 会话内切模型/思考档位会**冷启动整个 agent**（跑扩展 `session_start`、拉起 MCP），而同文件切档位刻意避免冷启动 | `agent-manager.ts:2904-2928` vs `:2935-2944` | models+bridge |
| P2-18 | 用户输入与快照无尺寸上限：大粘贴/大图原样进会话，且每次快照整份回传 base64 | `ChatInput.tsx:924-930,527-553`、`agent-manager.ts:230` | chat-ui |
| P2-19 | 第 21 张图片被静默丢弃；发送/上传忙时拖放被静默忽略（无 toast 无日志） | `ChatInput.tsx:540,527,626` | chat-ui |
| P2-20 | `relativeMarkdownPath()` 允许 `..` 段，前端直接交给 `openFile`，与"只认工作区内相对路径"的注释不符 | `lib/chat/file-path.ts:57-67` | chat-ui |
| P2-21 | 长会话客户端状态无界增长（messages/tools/trajectory 全量驻留，每次快照重建并重传） | `usePiWeb.ts:979-1006`、`trajectory.ts:43-47` | chat-ui |
| P2-22 | **（v2 已修正：原判"聊天列用 `100dvh` → 键盘一弹就把输入卡顶出可视区"实测不成立，见附录 A #17，已撤回）**只剩后半条：`layout.tsx:9-17` 的 `viewport` 没声明 `interactiveWidget`，Android Chrome 默认 `resizes-visual` 只缩 visual viewport → **软键盘可能盖住固定底部输入框**。代码可确认、**真机待验** | `layout.tsx:9-17`、`globals.css:465,857` | chat-ui |
| P2-23 | 两个 `aria-modal` 弹层没接 `useDialog`：无焦点陷阱，且被 `useDialog` 的抢焦点机制顶住 → 键盘用户**按不动权限确认框** | `ExtensionUI.tsx:280`、`ProjectPanel.tsx:33`、`hooks/useDialog.ts:41` | crosscut |
| P2-24 | 语义色当正文色：浅色下 `--dsw-warn` 2.15:1、`--dsw-success` 2.28:1（WCAG 正文要 4.5:1），唯一的错误说明几乎看不清 | `globals.css:2552,13,57`、`ChatWindow.tsx:863` | crosscut |
| P2-25 | 客户端请求全无超时（`src/components/**` 50 处 fetch、0 处 `AbortSignal.timeout`）→ 提示词/设置面板可永久转圈 | `PromptPanel.tsx:82`、`ProxySettings.tsx:21` | crosscut |
| P2-26 | `enabledModels` 作用域为空时选择器一个模型都列不出，而新会话页照样给出建议模型（两套口径） | `models-service.ts:227-239`、`model-defaults.ts:68-72` | models |
| P2-27 | 通过设置页保存一次就把 `models.json` 的注释/尾逗号/BOM 永久抹掉（不可逆的用户数据丢失，语义不变） | `models-service.ts:1404-1413,1455-1462`、`ModelsSection.tsx:542` | models |
| P2-28 | 只脱敏 `apiKey`：自定义请求头里的密钥**明文回显**到浏览器 | `models-service.ts:1406-1411`、`api/models/route.ts:32,48` | models |
| ~~P2-29~~ **→ P3-28** | ~~vision/tool 能力在聊天侧完全没有出口~~ **（v2 已修正：不是"没出口"——pi 运行时会按 `model.input` 决定，`core/tools/read.js:59-62` 把图片换成 `[Current model does not support images…]`，API 层也是 `input.includes("image")` 才拼 `image_url`）**只剩"PiWeb 侧没有发送前判断/提示"；`tool` 字段从来没人解析，属 P2-110 | `api/models/route.ts:38-43`、`ChatInput.tsx:530-540` | models |
| P2-30 | `models.json` 是"配置即执行"：打开模型设置页就会执行 `apiKey`/`headers` 里的 `!command`（不经沙箱/审批） | `models-service.ts:426-450,317-351,1527-1545` | models |
| ~~P2-31~~ **→ P1-27** | 模型目录探测是全项目唯一不跟随代理的 HTTP 客户端（`agent:false` 自建连接）——**v2 已去掉"疑似"并升 P1**：死端口代理下 `fetch()` 立刻 ECONNREFUSED、`https.request({agent:false})` 直连成功 | `models-service.ts:504-516` vs `launcher.mjs:139-143`、`verify-provider.md:179-192` | models |
| P2-32 | 保存模型配置后选择器不刷新（`requiresSessionReopen` 恒 true，提示只是 2.4 秒 toast） | `api/models/route.ts:100`、`usePiWeb.ts:912-916` | models |
| ~~P2-33~~ **→ P3-29** | 用量探测没有响应体上限，与目录探测的 4 MiB 口径不一致。**v2 实测**：11 个用量端点返回均为小 JSON（无分页），现网风险低 → 纯加固项 | `models-service.ts:736-751` vs `:537-576`、`verify-provider.md:231` | models |
| P2-34 | 只读轮询 `GET /api/sessions` 里做写盘：锁/权限问题会让侧栏 500（一次新 cwd 就能触发） | `api/sessions/route.ts:18`、`workspace-store.ts:364-409` | sessions |
| P2-35 | 归档保留期用 `unlink` **永久删除**，无回收站、无开关；时钟前跳一次就批量删（UI 已声明"归档满 30 天自动删除"，故降 P2） | `session-retention.ts:76-83`、`session-reader.ts:292-297`、`i18n.tsx:256` | sessions |
| P2-36 | 会话列表无分页无虚拟化；搜索纯客户端（搜不到已归档）；服务端 `?q=` 是死代码且口径不一致 | `SessionSidebar.tsx:934-954,1024`、`session-reader.ts:266-274` | sessions |
| P2-37 | 多标签页共用 `piweb.currentSession`：后写覆盖前写，刷新串到别人的会话 | `usePiWeb.ts:1128-1171` | sessions |
| P2-38 | 完全没有 URL 状态：不可深链、前进后退无效、恢复用字符串全等比较 | `AppShell.tsx`（全文件无 `pushState`）、`usePiWeb.ts:1162` | sessions |
| P2-39 | 移动端关闭的侧栏仍在 DOM 里可 Tab 聚焦、读屏可读（无 `inert`/`aria-hidden`） | `AppShell.tsx:1061-1073` | sessions |
| P2-40 | 客户端持久化卫生：草稿不落盘（刷新即丢，含 base64 图）+ `localStorage` 全裸调用（存储被禁时挂载 effect 抛错，最坏整页白屏） | `AppShell.tsx:165-181,91-97,262-267` | sessions |
| P2-41 | 每次 3 秒轮询做 O(会话数)+2×O(工作区数) 次无缓存 `realpath`（并行但代价与数据线性相关） | `api/sessions/route.ts:18`、`workspace-store.ts:171-174,364-369` | sessions |
| P2-42 | 纯重命名/空文件/只改权限的「变更」页会显示「这一范围内此文件没有变化」+ 整篇正文 | `FileViewer.tsx:281-287`、`growth-service.ts:887` | files-viewer |
| P2-43 | 查看器没有刷新入口，关掉再打开仍是旧内容（外部改动被静默当最新，无 stale 标记） | `FileViewer.tsx:192-297`、`useGrowth.ts:303-328` | files-viewer |
| P2-44 | 模块级 `fetchCache` 长期持有最多 200 份响应（含单份上限 4 MB 的整文件 patch）。**v2 实测上界**：真实仓库 blob p99 = **88–331 KB**，>1 MB 极少，**>4 MB 全机 27 个仓库里只有 4 个文件**（最大 34 MB）→ 200 × ≤331 KB ≈ **≤66 MB**（`DiffLine[]` 副本再乘约 2，百 MB 量级），**不是"数百 MB"**。仍是 P2（手机上常驻 60 MB+ 会被系统回收；淘汰是 FIFO 不按字节），但**优先级下移一位** | `FileViewer.tsx:29-50`、`verify-scale.md:178-183` | files-viewer |
| P2-45 | 目录分页只压缩响应体：服务端仍把整目录读进内存、排序、并把所有名字塞给 `git check-ignore`。**v2 实测（本机，空闲）：单目录 20k 条目 3.74 s、10k 条目 1.02 s；`page2` 与 `page1` 同价（3,809 vs 3,744 ms）→"分页不减服务端工作量"实证成立。成本分解：`readdir` 7.9 ms + sort 1.0 ms + 2000 次 stat 191 ms + `git check-ignore` 全量 20k 名字 3,541 ms（94%），且超线性（条目×10 → 耗时×36）；只送当前页实测 3,541 → 331 ms（10.7×）——第一轮给的修法已验证有效。日常不痛（真实工作区最胖目录 396 条 / 114 ms），痛的是生成物/日志/大目录，且被 `useGrowth.listDiskEntries` 无页数上限放大成数十秒（见 P2-115 末条）**。**建议在 P2 里前移** | `files-service.ts:212-244,241`、`verify-scale.md:69-92,171-177` | files-viewer |
| ~~P2-46~~ **→ P3-31** | 超大仓库 `git ls-files` 超 64 MB `maxBuffer` 时整个 `@` 引用索引 500，无降级。**v2 实测**：64 MB 需要 **120–180 万条目**（实测 36.8–54.5 B/条），本机最大仓库 `study\Reviva` 只 79,270 条 / **4.3 MB** / 1.63 s，差 15 倍；真正先踩到的是 15 s 超时（约 26–70 万条目）→ 触发面窄，修法应从"提 maxBuffer 到 256 MB"改成"流式收集 + 超时/失败退回 `walkWorkspaceFiles` 并标 `truncated`" | `files-service.ts:112-127`、`verify-scale.md:185-190` | files-viewer |
| P2-47 | 技能文档每张受保护图片都触发一次**同步全量资源指纹**扫描（阻塞事件循环）。**v2 实测**：`resourceLoaderIsStale()`（真实参数、**同步** `fs.*Sync` 递归）**p50 40.1 ms / p95 57.3 / max 65.5**；整条 `resolvePromptSourcePath` 55.6 ms；而 `/api/skills` 本身只 1.2 ms。N 张图 = N × 40 ms（10 张 ≈ 0.4 s、25 张 > 1 s）。**维持 P2（偏下限）**，修法不变（按 cwd 的 2 s TTL 缓存） | `files-service.ts:338-340` → `prompt-sources.ts:227-233` → `resource-fingerprint.ts:13-188`、`verify-scale.md:192-196` | files-viewer |
| P2-48 | `git status` 默认 `-unormal` 把未跟踪**目录**当文件列出，点开必然 `file not found`（本机 68 项里 13 项） | `git-service.ts:108,133-135,239-243` | git-project |
| P2-49 | `repoRoot` 把「不是仓库」和「git 拒绝/说明不清」混为一谈 → 面板确定性地说"此工作区不是 Git 仓库"（`safe.directory` 极常见） | `git-service.ts:81-91` | git-project |
| P2-50 | 超过 8MB 的文本 diff 直接 500（400KB 截断机制根本不生效，因为 diff 必须先完整进内存） | `git-service.ts:64,272,218-221` | git-project |
| P2-51 | 缺 `GIT_CEILING_DIRECTORIES`：嵌套工作区会静默串到父仓库，且 diff 边界是仓库根而非工作区 | `git-service.ts:68,83,223-228` | git-project |
| P2-52 | 仓库自带 `.git/config` 会在 `git status`/`diff` 时被执行（`core.fsmonitor`），可达路径=解压别人给的压缩包（疑似） | `git-service.ts:68` | git-project |
| P2-53 | >1 MB 的文件被记成"删除"（树与统计和磁盘不符，缩回后又变"A"来回跳） | `growth-service.ts:653-661,664-666` | growth |
| P2-54 | 同工作区两个会话（或多开/自动任务）并发时，改动被记到错误的一轮 | `growth-service.ts:87-97,344,715-780` | growth |
| P2-55 | 快照无**字节**上限、`refs/piweb` 对象永不回收；`gc` 的触发计数是**进程内内存**，重启即归零 → "每 50 次提交 gc 一次"基本不生效 | `growth-service.ts:27-35,693-708,694-695,774-776` | growth |
| P2-56 | 每轮提问前全量 worktree 扫描（显式关掉 fsmonitor/untracked cache）；`MAX_CANDIDATES` 检查在 `ls-files` **全量输出之后** → 用户看到的是 64MB 缓冲/30s 超时而不是"最大目录：node_modules" | `growth-service.ts:236-246,609-673,613-624` | growth |
| P2-57 | 轮次状态与轨迹视图口径相反：provider 取消被标成"本轮出错" | `growth-tracker.ts:42-51` vs `trajectory.ts:449` | growth |
| P2-58 | 一轮 commit 失败 → 该轮从时间轴消失 → 轮号与对话错位 | `growth-service.ts:715-780`、`growth-tracker.ts:96-99`、`useGrowth.ts:88-91` | growth |
| P2-59 | `running` 记录会被 pid 复用永久锁死（不能跑、不能删、UI 每 2.5 秒轮询） | `automations/store.ts:45-53,326,353,386` | automations |
| P2-60 | 无全局并发上限：N 个到期就拉 N 个会话（各自冷启动 agent + 打满 provider 配额） | `automations/runner.ts:408-421` | automations |
| P2-61 | 一条记录不可解析 → 整个自动化功能不可用（GET 500、写全失败、调度器刷日志），无修复入口 | `automations/store.ts:160-179,105-137` | automations |
| P2-62 | 漏跑一律静默跳过（2 分钟宽限），不落记录、不提醒；宽限期是写死常量 | `automations/runner.ts:20`、`store.ts:353-359` | automations |
| P2-63 | 没有一等公民的"停止运行"（运行中删除/改都 409，只能进会话按停止且被记成 error） | `api/automations/route.ts:58-106`、`AutomationsWorkspaceView.tsx:648-690` | automations |
| P2-64 | full 档会话可无上限自建 full 档任务、可无确认删除（readonly/workspace 双闸门拦得住） | `automations/agent-tool.ts:49-53,120-147`、`store.ts:105-137` | automations |
| P2-65 | 已 claim 的到期任务被静默丢弃：launch 抛错只 `console.error`；`isCurrent()` 翻假时 `break` 直接丢（`nextRunAt` 已推进） | `automations/runner.ts:412-420,408-419` | automations |
| P2-66 | **（v2 已修正：原判"进程退出不清理 → 孤儿隧道进程常驻"高估了，已改写）** 非正常退出路径**没有**清理动作：`src/` 全域零退出钩子、`launcher.mjs:531-540` 的 Ctrl+C 只把 SIGINT 转给**直接子进程**（cloudflared 是孙进程、收不到）、`stopPublic()` 只由应用主动调用。**但优雅路径是干净的**：`POST {action:"stop"}` 后 cloudflared **123ms** 退出、域名立刻摘除（同 Host 再请求变 403）；真实 `CTRL_C_EVENT` 后 **1537ms、exit 0**；E2E 的 `afterAll stopAll()` 后进程表干净。**本机还观测不到"孤儿"**——父进程被强杀后子进程约 2s 内消失，而同一台机器上 PowerShell 派生的子进程能存活 >10s，故判为**本次会话的 Job Object** 行为，不能据此认为普通桌面不残留。危害 = 资源泄漏 + 一个仍返回 403 的公网端点（新进程白名单里没有旧域名），非鉴权绕过 → **维持 P2** | `remote/supervisor.ts:505-509,585-605`、`launcher.mjs:531-540`、`verify-tunnel.md:339-352` | remote |
| P2-67 | `/pair` 是公开路径而失败限流是**进程级全局计数**：匿名刷 30 次/分钟即锁死合法扫码 | `remote/pairing.ts:104-113`、`src/proxy.ts:9` | remote |
| P2-68 | 默认就公网暴露 + 配对一次得 30 天主人权限 + 无单设备撤销 + 无"只要局域网"开关 | `supervisor.ts:395-420`、`web-auth-shared.ts:11`、`RemoteSection.tsx:121` | remote |
| P2-69 | 局域网入口明文 HTTP，Cookie 在 LAN 权威下不带 `Secure`、30 天；文档自己写着"远程访问不要用裸 HTTP" | `supervisor.ts:383`、`web-auth.ts:153-166` | remote |
| P2-70 | `README_zh.md` 与实现相反：写"公网入口默认关闭/在设置里开关"，实际默认开启且设置页没有任何开关 | `README_zh.md:140,148,176`、`tests/components/remote-section.test.tsx:55-58` | remote |
| P2-71 | 远程入口生命周期缺口：`stopLan()` 不等 `lanStarting`（关闭成功后端口又被绑上）+ 自动重连只覆盖 `ensureRemoteAccess` 一条启动路径（`{action:"start"}` 起的隧道退出后无人重建，但界面承诺"正在等待自动重连"） | `supervisor.ts:447-454,383-392,89`、`api/remote/route.ts:50-53` | remote |
| P2-72 | 安装插件包 = 单击即装、无二次确认，且 SDK 的 `npm install` **缺 `--ignore-scripts`**（`package-manager.js:1653` 只有 `--legacy-peer-deps --no-audit --no-fund`）→ 装什么就跑什么（**原 P1 降级**，见 §0.4）。**v2 实测补强**：`npm:`/`git:` 源在**安装时**执行生命周期脚本（marker 里有 `npm_lifecycle_event=postinstall` 与包内 cwd）；而**本地目录 source 不走 npm、不执行脚本**（27–47ms 只登记 settings），但它安装后会被 loader import 其扩展代码（同权限） | `api/plugins/route.ts:41-43,59-63`、`plugins-service.ts:395-405`、`PluginMarketplace.tsx:536-550`、`verify-plugin-install.md` A1/A2 | plugins-skills |
| ~~P2-73~~ **→ P3-30** | 市场不校验结果真是 pi 包、搜索词原样拼进 npm 查询 DSL。**v2 实测：前半句的风险不成立**——`keywords:pi-package` 是 npm 端**硬过滤**，250/250 返回都带该关键词，`-keywords:`/`author:`/嵌套 `keywords:` 都逃不掉，10 组查询 0 泄漏；漏的是本地二次校验（防御性缺失），不是现网可污染。后半句属实：用户词可追加 `author:`/`keywords:` 把结果清零或换子集（自我 DoS，无跨租户影响）。`total:13697` 与分页行为不符但是死字段（UI 显示 `items.length`） | `plugins-marketplace.ts:448-453,484-488,524-526`、`verify-provider.md:194-219` | plugins-skills |
| P2-74 | 兼容性判定用的版本 ≠ 实际安装的版本（`source: npm:<name>` 不带版本），无 integrity 锁定 | `plugins-marketplace.ts:440,471`、`PluginMarketplace.tsx:130-134,549` | plugins-skills |
| P2-75 | 只读 GET 可能悄悄 `npm install`（`queueLoaderReload → loader.reload()` 的 `resolve()` 没有 onMissing → `installMissing`）。**v2 已实测确认（原来是"未实测"）**：`listSkills(cwd)`（即 `GET /api/skills` 入口）在包已配置但目录缺失时**真的**跑了 `npm install` + postinstall（**2.58 s**），之后技能以 `origin=package` 出现；安装发生在**请求线程**里，用户只看到页面变慢，失败被加载器吞成 `installFailures`、UI 不显示 | `pi.ts:339-346`、SDK `package-manager.js:1098-1126`、`verify-plugin-install.md` A7 | plugins-skills |
| P2-76 | **（v2 已按实测收窄）**只在**跨进程**时没有互斥：单进程内 user 作用域的并发 install 已被 `withSettingsWriteLock` 串行化（同 cwd A4：1–1616 / 10–2902 ms；不同 cwd A5：0–1547 / 5–2787 ms，两包都装成、settings 两条都在）；`local:true` 走不同 settings 文件不排队，但前缀也不同（`<cwd>/.pi/npm`）→ "半成品 node_modules"风险不成立。**仍成立**：两个 PiWeb 进程、或 PiWeb + `pi` CLI 同时操作同一 `agentDir/npm`（锁是进程内 `Map`，无跨进程文件锁，npm 本身也没有 prefix 互斥） | `settings-write-lock.ts:9-20`、`plugins-service.ts:395-436`、`verify-plugin-install.md:418-422` | plugins-skills |
| P2-77 | 安装失败无回滚："装上了但刷新失败"报 500，孤儿包留在盘上 | `plugins-service.ts:395-405` | plugins-skills |
| P2-78 | `SKILL.md` 非原子写（裸 `writeFile`，无 tmp+rename 无备份）+ `reloadAllLoaders` 吞错 → "假成功" | `skills-service.ts:169-180`、`pi.ts:441-449` | plugins-skills |
| P2-79 | 包作用域/`local` 由客户端给，服务端不核对包真实在哪 → 状态错乱、卸载误报 404 | `api/plugins/route.ts:49-51,64-68` | plugins-skills |
| P2-80 | 大文件防护在"读完/解完之后"才生效；200MB 闸门对 zstd 只约束压缩后体积 → 一条 200MB `.zstd` 可把整个 Node 进程 OOM（连累所有会话） | `session-import/index.ts:152-160,39,217-221`、`dsh-zstd.ts:36-38` | import-export |
| P2-81 | 导入一次就把该来源**全量重扫**进内存，且没有超时/进度/取消（`onProgress` 定义了从未调用） | `index.ts:169-181,135,247`、`api/sessions/import/route.ts:78` | import-export |
| P2-82 | HTML 导出把临时文件写在**服务进程 CWD**（仓库根），同名并发互踩，失败不清理 | `agent-manager.ts:3129-3135`、SDK `export-html/index.js:193-198` | import-export |
| P2-83 | ZCode/opencode 不过滤软删除/归档，会把用户在源工具里删掉的对话重新导进来 | `oc-family.ts:157-165` | import-export |
| P2-84 | dsh 的 `cwd` 缺失回落到"有歧义的目录名解码"（31/197 会话走这条路，路径含 `-` 会解错） | `dsh.ts:27-33,173,254` | import-export |
| P2-85 | 每条选择都做一次全 sessions 目录遍历 + 一次注册表读（500 条一批时放大到秒级无响应） | `index.ts:189,202`、`writer.ts:50-71` | import-export |
| P2-86 | 设置面板只读写全局 `settings.json`，不看项目级 `.pi/settings.json` → 显示值与实际生效值可能不同 | `pi-settings.ts:64-107,172-199` | settings-i18n |
| P2-87 | 首屏语言与主题在 effect 里才应用：英文用户每次加载先闪中文，显式选深色的先闪浅色 | `i18n.tsx:2157-2162`、`layout.tsx:19-24`、`AppShell.tsx:352-367` | settings-i18n |
| P2-88 | 提示词来源正文读取**没有大小上限**（1 MB 只覆盖"链接资源"）；`/api/skills` 的 `readSkillFile` 也没有 → 一次点击可造成数百 MB 峰值 | `prompt-sources.ts:250-255`、`skills-service.ts:182-186` | settings-i18n |
| ~~P2-89~~ **→ P1-26** | 非 Windows 的 npm 一键更新会在服务仍在服务时替换自己的安装目录（无 503 保护）——**v2 升 P1**：UI 报"成功"时运行实例已经在坏 | `update-service.ts:89-100,151-175` | settings-i18n |
| ~~P2-90~~ **→ P0-3** | `experimental.proxyClientMaxBodySize: "272mb"` 是全局的，且**缓冲发生在鉴权之前**（v2 已实测：只发头不发 body 时 401 扣住 8s、20MB body 的 RSS +17~19MB）；34 个路由里只有 2 个有自身上限，超限只静默截断 | `next.config.ts:53`、`next-server.js:1227`、`body-streams.js:95-109` | api-auth |
| P2-91 | 启动令牌在进程生命周期内**永久有效且可重复使用**，`scope=all` 也撤不掉它 | `web-launch-token.ts:17-22`、`proxy.ts:39-51` | api-auth |
| P2-92 | `revokeAllSessions` 的 `notBefore` 在**锁外**取值：等锁期间新签发的 Cookie 逃过"所有设备退出登录" | `web-secret.ts:192,176` | api-auth |
| P2-93 | `PI_WEB_AUTH` 未设置即 **fail-open**（"默认开启"完全依赖 `launcher.mjs:248` 的副作用），无失败关闭、无告警日志 | `proxy.ts:28`、`instrumentation-node.ts:12`、`web-auth.ts:44-47` | api-auth |
| P2-94 | `/api/fs`（26 个盘符 `Promise.all` 无 race，Windows 网络盘可挂死）与 `/api/github`（最坏 15+8+8s）没有超时 | `api/fs/route.ts:33-51`、`github-identity.ts:118-179` | api-auth |
| P2-95 | 有副作用的 GET 依赖 `SameSite=Strict` 兜底；`isSafeOrigin` 对"没有 Origin 头"直接放行 | `auth.ts:7-18`、`api/sessions/route.ts:18` | api-auth |
| ~~P2-96~~ **→ P1-25** | 构建失败不回到上一个 ready 清单，把完全可用的旧版本一起罚死（旧目录明明还在盘上）——**v2 升 P1**：两条官方自救路径在成品包上都无效，一次 Ctrl+C 即锁死安装 | `build-output.mjs:125-140`、`release.mjs:157-163` | launcher-build |
| P2-97 | 没有单实例保护：慢启动窗口内的第二次启动会在相邻端口静默起第二个实例（共享同一 `~/.pi/agent`） | `launcher.mjs:427-445` | launcher-build |
| P2-98 | `.next-releases` 只增不减（本机 13 个目录 / 2.86 GB；含失败构建残留与不符合命名规则的外部产物） | `release.mjs:130-133` | launcher-build |
| P2-99 | 发布闸门可被本地 `npm publish` 绕过（`prepublishOnly` 既不构建也不验包，而 `files` 里 `.next` 是整目录、缺失不报错） | `package.json:43` | launcher-build |
| P2-100 | CI 只在 Linux 上验证发布产物，而包是全平台分发（Windows 的 `.next` 是 Linux 构建机产出的） | `.github/workflows/publish.yml:25`、`check.yml:14-16` | launcher-build |
| P2-101 | 构建产物状态判定的边角：删掉某个 release 目录后只报原始 ENOENT（无 `build:release` 提示）；`hasProductionBuild` 只看 `active.json` 是否存在，会让一次性构建的自愈短路 | `build-output.mjs:79-91`、`install-build.mjs:24-32` | launcher-build |
| P2-102 | `agent-events-route` 测试把 `agent-manager` 契约整段重写（`subscribe/parseLastEventId/sseEventId/holdViewer` 都是手写第二实现），路由对齐的是这份假契约 | `tests/agent-events-route.test.ts:9-36` | tests-coverage |
| P2-103 | 隧道类真实验证：**v2 已在 Windows 上人工跑通一次**（`PIWEB_TEST_TUNNEL=1` + 真 cloudflared，`1 passed` / 31.8 s，整条 LAN 注入代理 → 真隧道 → 公网回拉 → 移动排版注入 → 配对发码 → 公网兑换 303 → Secure/HttpOnly Cookie → SIGNED-IN → 老码不可复用全部成立），**但仍无 CI 门禁**；且 Windows 上有 **16 条零执行用例**（`tunnel-status.test.ts:20` 的 11 条隧道生命周期 + `workspace-picker.test.ts:9` 的 5 条）。根因实测：假 cloudflared 是 **POSIX shebang 脚本**，Windows 上 `spawn` 报 ENOENT → 整组被 `skipIf(win32)`。**把 fixture 改成 `.cmd`+`shell` 或 `.exe` 形态就能让这 11 条在 Windows 上真正执行——本次发现的最高性价比修复项** | `remote-tunnel.integration.test.ts:24`、`integration/remote/tunnel-status.test.ts:20,62`、`verify-tunnel.md:351-423,467` | tests-coverage |
| P2-104 | 242 处 `waitFor` **全部用默认 1s 超时**（其中不少在等真 SDK 流/真子进程）→ 偶发红、重跑就绿 | 全仓（`agent-resource-isolation.test.ts:323,685-689` 等） | tests-coverage |
| P2-105 | session-import 五个适配器的坏数据 `catch` 分支 **0 命中**（测试里 "malformed/corrupt/truncat" 关键词零匹配） | `claude.ts:147,172`、`codex.ts:123,150`、`grok.ts:21,44,76,107`、`dsh.ts:54-55,146,189` | tests-coverage |
| P2-106 | 14 个 API 路由零执行，其中 `sessions/[id]` 有分支逻辑与 DELETE 三步顺序（dispose→delete→forget） | `src/app/api/sessions/[id]/route.ts:23-36` | tests-coverage |
| P2-107 | 测试进程真的在 `0.0.0.0` 上开监听（`set-plugin` 用例漏传 host）→ 开发机/CI 临时暴露代理入口 | `tests/remote-supervisor.test.ts:96-103`、`supervisor.ts:383` | tests-coverage |
| **P2-108** | **启动令牌 `PI_WEB_LAUNCH_TOKEN` 随 npm 生命周期脚本外泄**（v2 新增，`review-update-release` U-2）：`update-service.ts:114` 的 `commandEnv = { ...env }` 把服务进程 env 原样传给 `npm`/`git` 子进程，而 `npm install -g` **不带 `--ignore-scripts`** → 本包 postinstall 与**所有依赖**的 install 脚本都能读到该 token；token 可换会话 Cookie（`proxy.ts:43`）且**进程内长期有效**（P2-91）。同一处还漏了 registry 白名单（`cwd` = 安装目录 → **项目级 `.npmrc` 生效**，而 git 更新的"有本地改动"闸门用 `--untracked-files=no`，未跟踪的 `.npmrc` 不会被拦）与代理（完全不读 `httpProxy`）。**定级 P2 的理由**：要触发得先有一个"更新"动作 + 一个恶意/被替换的包，而"能跑任意 install 脚本"本身已经等于该进程权限下的代码执行——token 外泄是**权限放大**（从代码执行到劫持已登录会话），不是新的入口。**升 P1 的条件**：`commandEnv` 里同时留着 `NODE_TLS_REJECT_UNAUTHORIZED`/`NODE_OPTIONS` 之类能关掉校验的开关，或产品默认走非官方 registry | `update-service.ts:112-114,151-175,208`、`launcher.mjs:245,502-504`、`proxy.ts:43` | settings-i18n |
| **P2-109** | **`update.lock` 写了 `{pid, startedAt}` 但全仓无人读取**（v2 新增，`review-update-release` R-1）：`release.mjs:56-67` 只做 `open(...,"wx")` 存占位，`EEXIST` 就抛"an update/build is already running…"；而 `release.mjs:166-171` 只 `process.once` 挂一次 SIGINT → 断电/强杀/连按两次 Ctrl+C 时 `finally { releaseLock() }` 不跑 → **此后所有 `prepareRelease`（UI 的 piweb 更新、pi 更新、`build:release`）都在第一句失败**，恢复要手删 `.next-releases/update.lock`（该目录被 `.gitignore:5` 完全忽略、本机已 13 个目录 50 个文件）。修法 10 行：`EEXIST` 时读 `{pid}` 做 `process.kill(pid,0)` 存活探测 + `startedAt` 超 2h 兜底，或直接用仓库已有的 `proper-lockfile` | `scripts/release.mjs:39,56-67,124,163,166-191` | launcher-build |
| **P2-110** | **`catalogCapabilities` 规则覆盖窄 → 上下文窗口/图片/推理能力被低估**（v2 新增，`verify-provider` §1.3-1.5）：规则只认 OpenRouter 那一种形状，漏读 `limit.context`/`limit.output`/`max_tokens`/`capabilities.image_input`/`capabilities.reasoning`(对象)/`image/*` MIME；发现流程也不过 `type`（Vercel 511 条里 185 条是 image/video/embedding/rerank… 会被当聊天模型列出）。**实测**：opencode **86 个模型 85 个上下文被低估**（`big-pickle` 200,000→128,000；`grok-4.7` 500,000→128,000）、**71 个真支持图片的被判纯文本**、86 个 reasoning 全丢；opencode-go 30/30 低估、21 个视觉误判；连 models.dev 本体（9,136 个模型）套这套规则也是 **ctx 0 命中、maxTokens 0 命中**。用户后果：提前压缩、截图被换成 `[Current model does not support images…]` 一行占位、思考档位消失、选到不能聊的模型。**方向限定**：只影响"经 `设置 → 获取可用模型` 落盘的新模型"，内置 provider 走 pi 内置目录、值是对的 | `models-service.ts:504-576,660-672`、SDK `provider-composer.js:96-114`、`model-draft.ts:36`、`verify-provider.md:79-117` | models |
| **P2-111** | **移动端"静默失联"：SSE 断了不提示、不重建**（v2 新增，`verify-mobile` P2-1）：真 Chromium 390×664 下断网 30 s，界面**完全不变**（`"连接中断，正在重连…"` 文本搜索 false、`/events` 零新请求、无 `requestfailed`），恢复后 20 s 内**仍无**新请求。根因：`usePiWeb.ts:1014` 的 SSE 分支**没有心跳超时**，`connected:false` 的唯一来源是 `onerror`。后果：切 Wi-Fi/蜂窝或隧道掉线后，用户面对一份永不更新却"看起来在线"的对话。修法：记录最后收帧时间，超 N 秒主动 `es.close()` 重建（服务端已有 `ping`），或统一走 `pollEventStream`（它有失败计数 + 退避）。**真机触发条件待验**（离线模拟只拦新连接） | `hooks/usePiWeb.ts:1014`、`ChatWindow.tsx:2279`、`verify-mobile.md:222-232,256-260` | chat-ui |
| **P2-112** | **事件流不可用 → 永久 spinner，无错误态、无重试入口**（v2 新增，`verify-mobile` P2-2）：把 `/events` 从建立起就 `route.abort()`，会话视图**只有 spinner**，`body.innerText` 仅 **93 字**（没有任何"失败/重试"文案），`EventSource` 每 ~3 s 重试；且"连接中断"胶囊被放在**消息流末尾**，没有消息时根本不渲染。这是隧道首连失败/弱网首开时最实际的坏态 | `AppShell.tsx`（会话加载态）、`ChatWindow.tsx` 连接提示位、`verify-mobile.md:234-244,262-266` | chat-ui |
| **P2-113** | **移动端触控目标系统性 < 44×44**（v2 新增，`verify-mobile` P2-3）：实测 5 个视图——首页 **7/7** 全部小于 44、会话页 **26/26** 全部小于 44，抽屉 16 个里 14 个、设置面板 34 个里 26 个。典型尺寸：左上"工作区"菜单 **30×30**、右上抽屉 **30×30**、发送 **34×34**、复制/编辑 **28×28**、"在编辑器中打开" **22×22**、抽屉 tab **83×31**、设置 tab 高 **36**；桌面 1440 下尺寸相同（鼠标无碍）。**不是"个别按钮偏小"，是整站沿用桌面尺寸**。修法：仅在 `@media (max-width:840px)` 用透明 `::after` 把命中区抬到 44×44，不动视觉尺寸 | `AppShell.tsx`、`ChatInput.tsx`、`SessionSidebar.tsx`、`verify-mobile.md:68-82,268-271` | chat-ui |
| **P2-114** | **隧道 kill 语义与更新/构建路径不一致**（v2 新增，`verify-tunnel` §5.2）：`supervisor.ts:481,600` 用 `child.kill()`（Windows = `TerminateProcess`，**只杀一个 PID**），而 `scripts/process-runner.mjs:11` 用 `taskkill /PID <pid> /T /F`（整棵树）。实测：`taskkill /T /F` 连 detached 孙进程都能收（Y2），`child.kill()` 在无 Job Object 的环境里只杀一个 PID（Y1）；而 `spawnTunnel()` 没有 `detached`、`launcher.mjs:531-540` 只向直接子进程转 SIGINT。现在引擎是 `cloudflared.exe`（无子进程）所以碰不到；**一旦改成 `.cmd` 包装器**（Windows 上 spawn `.cmd` 需 shell，很容易变成 `cmd.exe → cloudflared.exe` 两层），单进程 kill 会留下**真正的孤儿引擎**，而且 DNS 白名单会先被摘除——"只剩一个没人管的隧道进程"。修法：隧道路径复用 `terminateProcessTree()` | `remote/supervisor.ts:481,600`、`scripts/process-runner.mjs:11`、`verify-tunnel.md:453-462` | remote |
| **P2-115** | **会话列表冷启动 2.94 s + RSS +145 MiB，且它在侧栏首次渲染的路径上**（v2 新增，`verify-scale` §5.1）：65 个会话 / 92.4 MiB JSONL → `GET /api/sessions` 冷启动 **2.94 s**，热启动 22 ms，稳态轮询 12–21 ms；会话量再翻一倍就是 ~6 s，而侧栏每 3 秒轮询一次。落点：`session-reader.ts:205-249`（`scanSessions` 冷启动全量解析）+ `:150-203`（落盘索引）。这是本机**唯一"正常路径就 >1 s"**的操作，比 P2-44/46/47 都更该有人管。同节另一条不计级：非 git 工作区的 `@` 索引每次重走磁盘遍历（`D:\AIApp` 100 万文件 → **1.09 s/次、1.2 MB 响应、RSS +134 MiB、无任何缓存**） | `session-reader.ts:205-249`、`files-service.ts:122-127`、`verify-scale.md:208-213` | sessions |

### 5.2 P3（只列值得修的 32 条，其中 P3-28~32 为 v2 新增/降级）

| 编号 | 一句话 | 位置 | 区域 |
|---|---|---|---|
| P3-1 | `markMedium` 把工作区**原有**完整性标签覆盖成 Medium，且失败静默 | `sandbox/windows-acl.ts:102-104,135` | sandbox |
| P3-2 | 子进程继承整份 `process.env`（`echo %ANTHROPIC_API_KEY%` 就能打出父进程密钥）；readonly 的 `%TEMP%` 指向不可写目录 | `windows-acl.ts:360-366`、`bash-operations.ts:126-129` | sandbox |
| P3-3 | `resetSandboxStateForTests` 不 dispose 已建沙箱（标签残留）；`manager.test.ts` 会写真开发者的 `~/.pi/agent/web-sandbox` | `sandbox/manager.ts:101-104,123-127`、`tests/lib/sandbox/manager.test.ts:44` | sandbox |
| P3-4 | `/api/sandbox` 的 PUT 状态码三元两边都是 400 | `api/sandbox/route.ts:25` | sandbox |
| P3-5 | `MAX_ACTIVE` 名不副实：有看客或忙的会话一律不淘汰（20 个标签=20 个常驻 agent） | `agent-manager.ts:2184-2197` | bridge |
| P3-6 | `writeBases` 是全局 256 条单表，多会话并发写同一批文件时 patch 被提前淘汰（退化成"全绿新增"） | `agent-manager.ts:442,450-465` | bridge |
| P3-7 | 四处错误吞噬/生命周期卫生：`ensureSession` catch 里 release 失败会顶掉原始错误、`prepareGrowthBriefly` 的 timer 未 unref、`viewerAvailable` 是死字段、`session.dispose()` 的 catch 完全静默 | `agent-manager.ts:1712-1723,2636-2641,96,1892-1896` | bridge |
| P3-8 | 冷快照每次都重建整份工具目录（含 `createSandboxBashOperations`） | `agent-manager.ts:1395-1466` | bridge |
| P3-9 | `write` 的 diff 基线用与 pi 不同的路径解析：`~/x`、`file:` 形式的**覆盖写**会退化成"全绿新增"（落盘是对的） | `agent-manager.ts:450-465` vs pi `paths.js:100-123` | bridge |
| P3-10 | `web()`/`select()` 在"调用这一刻没有看客"时立即返回 `undefined`：浏览器重连窗口里发起的命令静默无效果 | `extension-ui.ts:230-231` | bridge-tools |
| P3-11 | `custom()` 遇到异步组件工厂（SDK 契约允许返回 Promise）静默当作"取消" | `extension-ui.ts:188-203,353-358` | bridge-tools |
| P3-12 | `setStatus(key, "")` 服务端留空值、客户端删键 → 快照与实时事件表现不同 | `extension-ui.ts:302-307`、`usePiWeb.ts:315-319` | bridge-tools |
| P3-13 | `ctx.switchSession(path)` 不校验目标路径，可把任意 JSONL 拉进 Managed 池（浏览器端被 path-security 挡住） | `agent-manager.ts:2115-2121` | bridge-tools |
| P3-14 | 运行中 Esc 不是停止键（与服务端注释"pi 终端 Esc 同款"不一致） | `ChatInput.tsx:931-1010`、`agent-manager.ts:2863` | chat-ui |
| P3-15 | 内建命令与同名 pi 模板冲突时，键入路径永远走内建（模板只能从菜单点） | `ChatInput.tsx:442-452,714-724` | chat-ui |
| P3-16 | 编辑自定义 provider 时改 ID 不校验格式：可静默覆盖同名 provider；改成 `__proto__` 会连 `apiKey` 一起静默消失 | `ModelsSection.tsx:624-647` | models |
| P3-17 | 记住的 hero 模型失效后不回退（停在"请选择模型"），思考档位反而回退到全 8 档 | `AppShell.tsx:241-258,421-428` | models |
| P3-18 | 归档**一键无确认**（紧挨着置顶）；保留期清理单条出错中断整轮；`started` 未挂 globalThis → 每个 route bundle 各起一个 sweeper | `SessionSidebar.tsx:562-575`、`session-retention.ts:51-98` | sessions |
| P3-19 | "最近工作区"实际是"最早添加"；切会话瞬间有一帧渲染上一个会话的消息与旧 `panelCwd` | `AppShell.tsx:655-662,846,1243-1245`、`usePiWeb.ts:919-931` | sessions |
| P3-20 | 输出固定按 UTF-8 解码：GBK 提交信息变乱码 | `git-service.ts:68,166-173` | git-project |
| P3-21 | diff 渲染无虚拟化、逐行全量高亮，且"可横向滚动"的注释与实现相反（`whitespace-pre-wrap`） | `DiffView.tsx:97-109`、`GitPanel.tsx:261` | git-project |
| P3-22 | diff 复制丢 `+`/`-`（`user-select:none`）；无"复制全文"与下载，>256KB 的远程文件拿不到完整内容 | `DiffView.tsx:132`、`FileViewer.tsx:509-531` | files-viewer |
| P3-23 | growth 的服务端缓存只增不减；失败提示全是英文原文直出；`percent` 未 clamp（可能显示 137%） | `growth-service.ts:87-97`、`ProjectPanel.tsx:370-374`、`session/metrics.ts:29-30` | growth |
| P3-24 | `listenLan` 的 `once("error")` 在 listen 成功后成为**死监听**：之后的监听级错误被静默吞掉，UI 仍显示"已连接" | `remote/supervisor.ts:433-445` | remote |
| P3-25 | 设置页的"打开"链接指向 `/pair?code=…`：点一下就把二维码里的一次性码用掉，还顺手给桌面浏览器种了公网权威 Cookie | `RemoteSection.tsx:165` | remote |
| P3-26 | 所有 500 把 `err.message` 原样回显（含绝对路径）；`/api/config` 下发 settings.json 且无 `no-store` | `api/config/route.ts:19-21` 等 15 处 | api-auth |
| P3-27 | 「检查更新」对 pi 目标不校验 registry 输出（piweb 目标有 `if (!latest) throw`，pi 没有），且 `parseVersion` 正则不锚定末尾（`1.2.3.4` 被当 `1.2.3`）→ 异常输出时显示"已是最新" | `update-service.ts:126-136`、`semver.ts:10-20` | settings-i18n |
| **P3-28** | （原 P2-29 降级）贴图时**没有发送前的"这个模型收不收图"判断与提示**——真正丢图的是 pi 运行时（`read.js:59-62`），这里只剩缺一条预发提示 | `api/models/route.ts:38-43`、`ChatInput.tsx:530-540` | models |
| **P3-29** | （原 P2-33 降级）用量探测没有响应体上限，与目录探测的 4 MiB 口径不一致。实测 11 个用量端点返回均为小 JSON、无分页 → 纯加固 | `models-service.ts:736-751` vs `:537-576` | models |
| **P3-30** | （原 P2-73 降级）市场搜索词原样拼进 npm 查询 DSL（可追 `author:`/`keywords:` 自我 DoS）、结果不做本地二次校验、`total` 是死字段 | `plugins-marketplace.ts:448-453,484-488,524-526` | plugins-skills |
| **P3-31** | （原 P2-46 降级）`git ls-files` 超过 64 MB `maxBuffer` 或 15 s 不返回时整个 `@` 索引 500、无降级。阈值本身需 120–180 万条目（本机最大差 15 倍），但"失败后不退回磁盘遍历"这个设计缺陷在超时路径上同样成立 | `files-service.ts:112-127` | files-viewer |
| **P3-32** | 移动端剩余小项（v2 新增，`verify-mobile` P3-1~P3-4）：① 用了 `env(safe-area-inset-*)` 但 `viewport` **没开 `viewport-fit=cover`** → iOS 报告的 inset 恒为 0，这些 padding 是空操作；② 输入框自增高后**换宽不回落**（6 行 → 高 130，390→1200 后仍 130，要等下次输入）；③ 390 宽下权限/模型 chip 被截成「完…」「grok/grok-4.7…」，移动端无 hover 拿不到 `title`；④ 全屏按钮在窄屏等价于无变化 | `layout.tsx:9-17`、`globals.css:333,465-474`、`AppShell.tsx:1401-1402` | chat-ui |

---

## 6. 测试缺口（v2：原 Top 15 + 补验新增 4 条）

> **v2 的覆盖率基线（先看这段，它改变了"哪块最该补"的判断）**：全局 lines **83.56%** / branches **70.45%** / functions **77.82%** / statements **79.28%**。**行覆盖是健康的，洞在分支覆盖**：`agent-manager.ts` 86.39%/**71.25%**、`ChatWindow.tsx` 83.76%/**71.14%**、`usePiWeb.ts` **69.48%/53.11%**、`AppShell.tsx` 70.32%/**56.87%**、`SessionSidebar.tsx` 70.00%/58.25%、`ModelsSection.tsx` 68.83%/57.16%、`git-service.ts` 76.51%/**42.85%**、`FullDiff.tsx` **行 5.4% / 分支 0%**、`api/models/route.ts` 48.71%/49.12%。**"三个巨型模块覆盖未知"这个担忧可以撤掉一半**——行覆盖 82–86% 是健康的；真正的洞在下面这些错误/超时/降级分支里，而 P1 家族（P1-1 abort、P1-2 单源 streaming、P1-3 提交锁、P1-17/18 静默残缺）**正好全长在这些分支上**。
> **零覆盖清单已经交叉验证**：v8 行命中口径与第一轮的"import 图 + 剪 `vi.mock`"口径**独立**得出同一批 **19 个文件**（19/19 吻合，其中 14 个是 API 路由）——这就是下面第 6/7 条那类缺口的可信底座。
> **v2 还实测出一类新的"零覆盖"**：Windows 上有 **16 条用例从不执行**（`tunnel-status.test.ts:20` 的 11 条隧道生命周期 + `workspace-picker.test.ts:9` 的 5 条），根因是假 cloudflared 写成 POSIX shebang 脚本（`spawn` 在 Windows 报 ENOENT）→ 整组 `skipIf(win32)`。而隧道进程生命周期恰恰是平台差异 bug 的高发区。

| # | 缺什么 | 为什么重要 |
|---|---|---|
| 1 | **`file://` / URL 形式路径的闸门测试** | P0-1 就是因为没有这条；一行测试就能永久钉住 |
| 2 | **readonly 在"目录已被标 Low"时的行为**（+ 切档是否释放沙箱） | P0-2 的全部机制没有任何用例，现有 readonly 测试用的是全新 Medium 目录 |
| 3 | **abort 在真正 streaming 中**（超时 / 复位帧 / 队列文本回传 / 连点只发一次） | 现有唯一 abort 用例跑在**空闲**会话上，`abort()` 立刻 resolve，P1-1 完全没被覆盖 |
| 4 | **`deferPublish` 微任务抛异常后的队列自愈** | "一次抛错永久黑洞"，修法只有 3 行，但没用例防回归 |
| 5 | **沙箱 e2e 显式 skip + CI 的 skipped 基线校验** | 现在 ubuntu lane 上安全边界静默绿、Windows 缺 koffi 时崩（P1-22） |
| 6 | **`reap()` / `BUFFER_CAP=400` / `holdViewer` 真实实现** | 三者全仓 **0 次引用**，而它们是"空闲回收 + 断线续传"的正确性基础 |
| 7 | **`sessions/[id]` DELETE 路由** | 用户高频操作、含分支与调用顺序；14 个零执行路由里唯一带逻辑的 |
| 8 | **session-import 五个适配器的坏数据容错** | 用户本机历史"坏一行"是常态；语义（跳过 vs 整条失败）无人钉住 |
| 9 | **`session-import/paths.ts` 真实路径** | 被两个测试文件整体 mock → "扫不到任何会话"这类故障永远不会在测试里出现 |
| 10 | **`/api/skills` delete 的链接逃逸 + `setActiveTools` 与档位求交** | P1-10 / P1-9 两条权限边界的唯一防线；现有 `skills-delete.test.ts:193-214` 恰好把危险路径当期望行为锁死了 |
| 11 | **`listModels` / `listModelsUncached` 的目录组装** | 本区域最核心的聚合逻辑零直接测试（缓存失效、三态 authReady、并发只探测一次） |
| 12 | **`startPublic` 真子进程生命周期（Windows 可跑）** | 现在只有 fake child；ENOENT/kill 后 3s 收尾/exit 后重连全无真实覆盖，而这正是平台差异 bug 的高发区 |
| 13 | **撤销 cookie 的竞态窗口 + 撤销后立刻 401** | "所有设备退出登录"的安全语义没有任何"撤销即失效"的断言 |
| 14 | **`createAclSandbox` 的失败分支（fail-closed）** | 只有"目录不存在"一条被测；`catch { return null }` 覆盖的令牌创建失败分支无测试 |
| 15 | **UTF-16 / UTF-8 BOM / GBK 文本预览** | 中文环境最高频的真实故障，现有测试一条都碰不到（仓库里没有这类文件） |

**v2 补验新增的 4 条缺口（按风险排序，接上表编号）**

| # | 缺什么 | 为什么重要 |
|---|---|---|
| 16 | **鉴权前 body 缓冲的回归**（`Content-Length` 预检 + 413 + 断开；只发头不发 body 时必须在 1 s 内被拒） | P0-3 的唯一有效防线在 Next **之前**，而现有测试全部停在"401 是否正确"这一层，测不到"401 之前内存已经被吃"。一条 20 MB 的 headers-only 用例就能钉住 |
| 17 | **分支覆盖门槛 + 三个最差文件**（`git-service` 42.85%、`usePiWeb` 53.11%、`FullDiff` 5.4%/0%） | 覆盖率已经能量了（`@vitest/coverage-v8`），缺的是**门槛**：CI 不设 `branches` 阈值，等于允许错误分支继续裸奔。建议先设 70%（现状 70.45%）防回退，再对 `usePiWeb`/`git-service` 单文件设底线 |
| 18 | **Windows 上 16 条隧道/选择器用例真的执行**（把假 cloudflared 从 shebang 改成 `.cmd`+shell 或 `.exe`） | 这 16 条现在是 `skipIf(win32)` 全跳过，而"隧道崩溃/重连/超时/停止竞态"是平台差异最集中的地方；改动只在 fixture 形态，收益是 11 条生命周期用例在 Windows 上复活 |
| 19 | **浏览器级事件流坏态**（SSE 静默断开后重建、`/events` 一直失败时出现错误态与重试） | P2-111/P2-112 全是真浏览器才暴露的（jsdom 里没有真 EventSource 生命周期、也没有 spinner 到死的观感）；现有 `event-stream.test.ts` 只测帧解析 |

---

## 7. 建议修复顺序

### 第 1 批：安全边界（1–2 天，风险最低、收益最高）

| 内容 | 影响文件 | 消除什么 |
|---|---|---|
| P0-1：`resolveModelPath` 对齐 pi 的 `file:` 处理 + 拒绝清单 | `src/lib/permission-gate.ts`（+1 测试文件） | 「只改工作区」从谎话变成真话；一条 prompt 写出工作区的路径消失 |
| P0-2：遗留 marks 落盘 + 启动时复原（+ 切档释放旧沙箱） | `src/lib/sandbox/manager.ts`、`sandbox/windows-acl.ts`、`agent-manager.ts:2948` | 「仅可查看」第一次真的成立；顺带修掉本机当前残留的 4 处 Low 标签 |
| P0-3（v2 新增）：① `proxyClientMaxBodySize` 压到 `12mb` —— **1 行配置**，立刻把单请求上限从 272MB 降到 12MB；② launcher 的 `Content-Length` 预检 + 413 断开 —— 约 20 行 | `next.config.ts:53`、`scripts/launcher.mjs`（移动端代理那一跳同批） | 未认证请求能吃到 272MB/连接这件事；**注意 ① 是缓解不是根治**，根治只能靠 ②（`proxy.ts` 里加检查无效），而"把图片端点移出 matcher"需要该路由自建认证，放第 3 批 |
| P1-5：`user_bash` 无条件接管 | `agent-manager.ts:1651`（1 行） | readonly 下的全权限 shell 通道 |
| P1-8：批准卡文案与 action 绑定（先改文案，绑定可随后） | `agent-manager.ts:1354`、`permission-request-tool.ts:69` | 用户对"一次性授权"的错误预期 |
| P1-9：`setActiveTools` / `sanitize` 与档位求交 | `agent-manager.ts:2957`、`tool-preferences.ts:39` | 插件工具穿过只读档写盘的唯一模型可见路径 |

**工作量**：P0-1 约 20 行 + 2 条测试；P0-2 的"marks 落盘 + 启动复原"约 60 行 + 1 条集成测试（这是本批唯一有设计选择的：我只做这一个方向即可，切档释放可以第二批）；**P0-3 的 ①是一行配置、②约 20 行，是整份报告里"单位改动消除风险"最高的一处**，所以放第 1 批；它的第 ③ 步（图片端点移出 matcher）不在此批，因为那个 route 要自己实现会话校验，属于一次独立改造。

### 第 2 批：会话可用性 + 静默失败（3–5 天，改 8–10 个文件）

1. **P1-1 + P1-2**：abort 加 `Promise.race` 兜底与 `stopping` 态；客户端用每 3 秒到手的 `running` 做对账 + 轮询帧循环加 try/catch。→ 消除"点停止没反应、只能重启"整类问题。
2. **P1-3 + P1-4**：扩展命令不再占用 `promptSubmitting`；`deferPublish` 微任务加 try/catch/finally。→ 消除另外两条"会话永久不可用"的路径。
3. **P1-11 / P1-18 / P1-16 / P1-17 / P1-20 / P1-21 / P1-27**：都是"静默失败"——注册表损坏 fail-open、模型目录错误下传（含 (c) 能力值残缺）、远程状态渲染、代理"重启生效"提示、导入来源错误通道、登出检查 `response.ok`、模型探测跟随代理。每条改动都在 3–20 行，**这一组是整份报告里性价比最高的部分**。
4. **P1-22**：18 处 `return` 改 `ctx.skip()` + CI skipped 白名单。→ 不改一行产品代码，让后续所有修复的验证有意义。
5. **P2-111 / P2-112 / P2-113（v2 新增，纯前端）**：SSE 心跳超时 + `es.close()` 重建、首连超时后的错误态与重试入口、44×44 命中区。三条都在 `usePiWeb.ts` / `ChatWindow.tsx` / 一份 `@media` 里，与 P1-2 同一处改动顺手做掉。

**影响文件**：`agent-manager.ts`、`hooks/usePiWeb.ts`、`lib/chat/event-stream.ts`、`ChatInput.tsx`、`workspace-store.ts`、`models-service.ts`/`pi.ts`、`RemoteSection.tsx`、`GeneralSection.tsx`、`session-import/sqlite.ts`+`oc-family.ts`、`tests/**`（18 处）。

### 第 3 批：不可逆操作与供应链（1–2 周，跨 6 个区域）

1. **P1-14**：growth 的 consent 提前到"第一次记录"+ 关闭开关 + 删除 `refs/piweb/*` 的入口。→ 唯一一条"用户不知道也关不掉"的写盘行为收口；顺带解决 P2-53/55/56。
2. **P1-10**：技能删除改成"必须在技能根 realpath 集合内"的包含判定 + 确认框显示真实路径。→ 不可逆目录删除的口子（**v2 修正：别再用"嵌套技能会拦"当防线，那条实测不成立**）。
3. **P2-72 / P2-74（P2-73 已降 P3-30）**：安装二次确认 + 版本锁定 + `--ignore-scripts`（供应链加固）。**P2-108 与这条同根**：`commandEnv` 剔掉 `PI_WEB_LAUNCH_TOKEN`/`NODE_TLS_REJECT_UNAUTHORIZED`、更新加 `--ignore-scripts`、显式 `--registry` —— 三处共用同一个"受控 npm 调用"工具函数，一次消掉安装与自更新两条。
4. **P1-23 / P1-24 / P1-25 / P1-26 / P2-109**：构建自检覆盖 `server/**`；一次性构建改 rename 原子切换；`state !== "ready"` 时回退上一个 ready + `hasProductionBuild` 读 `state` + 错误文案按安装形态分流；非 Windows 不再一边服务一边替换安装目录；`update.lock` 加 pid 存活探测。→ 本机真实发生过的"构建残缺却报就绪""一次 Ctrl+C 锁死安装""UI 报更新成功时服务已在坏"三个类别的收口。
5. **P2-80 / P2-81**：导入的"读的时候就拦"+ 超时/取消。→ 一条 200MB zstd 能把整个进程 OOM（连累正在跑的会话）。
6. **P0-3 的第 ③ 步 + P2-45 / P2-115（v2 新增）**：图片上传端点移出 matcher（自建认证 + 流式）；`check-ignore` 只送当前页（实测 10.7×）；会话列表冷启动索引。→ 三个都是"正常路径就会疼"的性能/资源项。

**影响文件**：`growth-service.ts`/`growth-tracker.ts`、`skills-service.ts`、`plugins-service.ts`/`plugins-marketplace.ts`/`PluginMarketplace.tsx`、`update-service.ts`、`scripts/build-output.mjs`/`install-build.mjs`/`release.mjs`、`session-import/*`、`files-service.ts`、`session-reader.ts`。

---

## 附录 A：已排除（"看着像 bug 其实不是"）

1. **扩展 `@路径` 不展开文件内容**——PiWeb 只把 `@path` 拼成正文文本随 prompt 发出（`compose-prompt.ts`）；`@file` 展开只发生在 pi 的 CLI 参数处理上。不是缺陷。
2. **mermaid 不存在**——全仓 `src/` 无 mermaid 依赖与用法（`package.json` 核对过），审计项不适用。
3. **`src/lib/workspace-index.ts` 不是工作区索引**——它是 `@` 引用补全的纯匹配逻辑（`getFuzzyFileSuggestions` + `extractAtPrefix` 照搬 pi-tui）。同类：`src/lib/process-format.ts` **没有**进程执行代码，是"对话过程行"的文本整理。任务书里的归类错了。
4. **"自动化会话默认落在 readonly 档"不成立**——`DEFAULT_TOOL_PRESET = "workspace"`，运行器在提交 prompt **之前**显式 `setToolPreset` 且失败即中止（`runner.ts:329-332`），有断言透传的用例。`registerManaged` 的 `readonly` 只是"未下发前的初值"。
5. **"Next 多 bundle 各起一份 `started` 标记导致重复执行"不成立**——启动器只起一个 Next 进程；运行期状态挂 `globalThis[Symbol.for(...)]` 且按 store 路径分键；`claimDueTasks` 在**一次** `mutateStore` 里"判定到期 + 推进 `nextRunAt`"，第二份 ticker 再进来时已不可认领；`recordRunStarted` 用 `ownerPid` 拦第二份，有多进程用例。
6. **"归档保留期会误删未归档会话"不成立**——`getArchivedEntries()` 只返回 `archivedSessions` 里的路径，`deleteSession` 还有 `isPathInside` + `.jsonl` + realpath 三重边界，有专门用例。（本报告只保留"归档会话的删除不可逆 / 无回收站 / 时钟前跳批量删"。）
7. **`GetLastError` 被 `CloseHandle` 覆盖**——不成立。取错误码在三个 `CloseHandle` **之前**（`windows-acl.ts:367-372`）。原报告里的一句顺带猜测，不进正文。
8. **`file:` 逃逸不是靠 `realpathLoose` 的 fail-open 那一支**——归因错。实测 `fs.realpath` 一路 ENOENT 到 `D:\AIApp\PiWeb`（存在）后走**祖先回填**分支，`:69` 一次都没命中。P0-1 与 P2-2 无因果关系（P2-2 仍单独值得修）。
9. **`/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 攻不破**——闸门与 pi 都判区外、一致拒绝。这反过来加固了 P0-1 的可信度：只有 `file:` 一个口子。
10. **"`releaseSandbox` 会拆掉新会话的沙箱 holder"**——不成立。`holders.delete` 在第一个 `await` 之前**同步**执行、必然早于 `registerManaged`；真实残留窗口是 temp 目录与 `markMedium` 的竞争（已并入 P2-4）。
11. **"`fs.rm` 跟随链接导致删除越界"**——机制描述错。真正跟随链接的是 `resolveDiscoveredPath` 的 `fs.realpath`：删除目标在进入 `fs.rm` **之前**就已经是链接指向的真实目录。结论（会删到区外）成立，机制已按 P1-10 改写。
12. **"abort 挂死、点停止后仍 streaming"**——两份区域报告都写"生产已复现"但无日志，本报告**不声称 `abort()` 挂死已复现**；但"点停止后仍停在流式"这个**症状**是 lead 本日现场观察到的（会话 `…5fbc19029ea5`，15 分钟无事件，`abort` 返回 ok 后状态仍 streaming），见 P1-1 末段的现场记录。机制分两种（abort 不返回 / 复位被后续事件覆盖），附录 B #4 定性。
13. **`piweb-runtime-*.mjs` 这个文件名无法复核**——全仓（含被 gitignore 的目录）只有两个探针 `.json/.log`，本机 release 产物里 `.mjs` 数量为 0（Webpack 只产 `.js`）。凡涉及 MODULE_NOT_FOUND 的结论只声明**机制**（P1-23），不指认具体文件名。
14. **"存在未鉴权或可绕鉴权的 `/api` 路由"——没找到。** 34 个 `src/app/api/**/route.ts`（52 个方法处理器）逐个读完：`PUBLIC_PATHS` 只有 `/login`、`/api/web-auth`、`/pair`，外加 `GET/HEAD /api/health`；静态资源前缀不映射到任何 API。实测抽样 8 个路由，无 Cookie 全部 401。这是本次审计里最重要的一条**正面**结论。
15. **"测试污染了用户 `~/.pi`"——没找到。** 逐个核对：凡要落盘的测试都显式指到 `os.tmpdir()` 子目录（`PI_CODING_AGENT_DIR` 与 `HOME` 都 stub 过）。
16. **`presetAllowsTool` 的边界是 Ok 的**——未知工具名在 readonly/workspace 默认拒绝、full 全放行、MCP 只在 workspace 放行，有真断言测试（问题在 `customActiveTools` 绕过，见 P1-9，不在这条）。

**以下是 v2（第二轮补验）新增的"已排除"**

17. **移动端 `100dvh` 与横向溢出——撤掉（真 Chromium 390×664 实测）**。① 横向：7 个视图（首页/会话页 195 条消息/设置/右侧抽屉/文件查看器/`.pw-chat-scroll`/桌面 1440×900）全部 `scrollWidth == clientWidth`；按"元素右边界 > 视口+1"扫全部 DOM **0 个被裁元素**。注入一个内宽 **2349px** 的 8 列宽表和 600 字符长代码行后，`.md-table-wrap`（`clientWidth 316 / scrollWidth 2349`）与 `pre`（316/4815）各自 `overflow-x:auto` 内部横滑，**文档 `scrollWidth` 仍是 390**。第一轮 P2-22 里"390px 下表格 442px 超出视口"这句来自 remote 代理页的另一套 DOM，本机直连页由 `globals.css:1813` 的 `.md-table-wrap` 兜住了。② `100dvh`：把视口高度从 900 逐档压到 844/664/560/480/400/320/240，**composer 底边恒等于 `innerH - 40`、`.pw-app-shell` 高度恒等于 `innerHeight`、8 档全部 `clipped=false`**；首页同样全部不裁。→ 地址栏显隐这条风险**划掉**（P2-22 只剩 `interactive-widget` 未声明那半条，真机待验）。
18. **"非 pi 包会混进插件市场结果"——没复现**。`keywords:pi-package` 是 npm 端的**硬过滤**：10 组查询（含 `keywords:pi-package mcp`、`keywords:pi-package keywords:react`、负向 `-keywords:pi-package`、`author:sindresorhus`、size=250）**全部 0 泄漏**；反证也是对的（去掉 qualifier 的裸 `pi-package` 就出现 1 个非 pi 包，`keywords:zzzznotakeyword` 返回 0）。所以 P2-73 的前半句只是"本地缺二次校验"（防御性缺失），已降 P3-30；`total:13697` 是死字段（UI 显示 `items.length`）。
19. **"目标里有嵌套技能，`others` 会拦住删除"——不成立**。SDK 发现到 `SKILL.md` 就**停止下钻**，`inner/SKILL.md` 不进发现列表，`others` 不含它 → 整目录（含嵌套技能）照样被 `fs.rm(recursive)` 删掉。`others` 只在"同一目录里第二个技能被单独发现"时才生效。P1-10 的这条降级理由已删（同时触发面比原判更大）。
20. **"孤儿 cloudflared 在本机可复现"——观测不到，但机制成立**。三组实测都是干净的：显式 stop → 123ms 退出 + 域名立刻摘（同 Host 变 403）、真实 `CTRL_C_EVENT` → 1537ms / exit 0、E2E `afterAll stopAll()` 后进程表干净。父进程被强杀后子进程约 2s 内消失，而同一台机器上 PowerShell 派生的子进程存活 >10s → 判为**本次会话的 Job Object** 行为。代码层缺陷（零退出钩子、SIGINT 只到直接子进程）不受影响，故 P2-66 改写而非撤销。
21. **"UAC 一步跳出所有边界"——策略层已排除静默提权**。本机 `EnableLUA=1`、`ConsentPromptBehaviorAdmin=5`、`PromptOnSecureDesktop=1`、`ConsentPromptBehaviorUser=3`；当前进程是管理员账户的**非提权**进程（Medium，Administrators 为 deny-only）。→ Low 进程**不能无人值守提权**（必须真人点"是"，且提示在安全桌面不可被普通进程代点/遮挡）；`runas` 通道本身可达（不要求调用方持权），但那属于**社交工程面**，P2-10 维持 P2。**例外**：`EnableLUA=0` 的机器会退化成静默提权，那种环境应算 P1。
22. **"没有覆盖率、三个巨型模块覆盖未知"——已实测**。`npm i --no-save @vitest/coverage-v8` 全量跑出 lines 83.56% / branches 70.45%；`agent-manager` 86.39%/71.25%、`ChatWindow` 83.76%/71.14%、`models-service` 81.61%/69.80% → **行覆盖健康**。这条担忧只剩一半：**分支覆盖是洞**（见 §6 开头）。
23. **隧道 Host 白名单在运行时真的生效，而且真链路在 Windows 上跑通了——正面结论（v2）**。① 同一个 Next 进程里 `allowTunnelHost()` 之后，带隧道域名的 `Host` 得到 **401 `authentication required`**（说明 `isSafeHost()` 通过了），未登记域名得到 **403 `untrusted host`**；`POST {action:"stop"}` 之后同一 Host 立刻变 **403**（`disallowTunnelHost()` 真的摘了）——这同时裁决了 `remote.md:486` 那个未知点：**Next 16.4.5 的 proxy 与路由处理共享同一个 `process.env`，不是启动快照**。② `PIWEB_TEST_TUNNEL=1` + 真 cloudflared 在 **Windows 上首次跑通**：`1 passed`/31.8s，整条"LAN 注入代理 → 真隧道 → 公网回拉 → 移动排版注入 → 配对发码 → 公网兑换 303 → Secure/HttpOnly Cookie → SIGNED-IN → 老码不可复用"成立。③ 公网根 `GET /` → **307 到 `/login?next=%2F`**、公网 `GET /api/remote` → **401**：鉴权在隧道下没有失效。

---

## 附录 B：待运行验证清单（v2：已验的打 ✅，未验的保留）

> 前 3 条是"结论已经站得住、只差一个落盘/现场证据"。建议在**一次性临时工作区/临时 agentDir** 里做。**v2 已关掉 #8、#9 两条**（都换成了实测结果），并把新增的未验项放在 **#19**。

| # | 要验的结论 | 最小步骤 | 预期差异（判读标准） |
|---|---|---|---|
| 1 | **P0-2 此刻是否真能写** | 把 `D:\AIApp\PiWeb\.audit-2026-11-13` 当工作区开 readonly 会话，`bash` 跑 `echo probe > ro-probe.txt` | 文件出现=证实（结合已观测的残留标签，几乎必然）；失败=说明标记判断错，需重看 `icacls` |
| 2 | **P0-1 端到端落盘** | 临时目录建 workspace，workspace 档让模型 `write({path:"file:///C:/Users/<u>/AppData/Local/Temp/piweb-escape.txt", content:"x"})` | 文件出现在 `%TEMP%`=证实；被拒=pi 的 `resolveToCwd` 与我们读到的版本不同 |
| 3 | **P1-7 readonly 能写 LocalLow** | readonly 档 `bash`: `echo x> "%USERPROFILE%\AppData\LocalLow\piweb-probe.txt"` 然后 `type` | 成功=证实；`Access is denied`=ACL 推断错 |
| 4 | **P1-1 的触发场景（决定它是不是 P0）** | 会话里 `!` 跑 `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`，点停止；同时 `curl -m 60 -X POST /api/agent/<id> -d '{"cmd":"abort"}'`（带 Cookie） | 60s 未返回 + UI 仍 streaming=证实"abort 能永久挂住"；正常 200=P1-1 只剩理论。**v2 仍无结论**（本机只观察到"abort 返回 ok 但状态仍 streaming"的现场，机制未定死） |
| 5 | **P1-3 扩展命令阻塞** | 装 `examples/piweb-extensions/todo-panel.ts` 到某工作区 `.pi/extensions/`，空闲会话发 `/todo` | `POST` 挂住到面板被应答=证实；秒回 200=SDK 顺序判断错（可能性极低，已逐行核 `agent-session.js:1705-1709`） |
| 6 | **P1-18 的症状（模型会不会真的静默消失）** | 备份 `~/.pi/agent/models.json` 后写入 `{"providers":{"x":{"baseUrl":1}}}`，`GET /api/models`，完事还原 | 内置模型仍在、自定义全消失=证实"静默残缺"；整个 500 并提示 JSONC 无效=P1-18 应改写 |
| 7 | **P1-13 的 conflict 分支** | 临时仓库造冲突后跑 `git diff --no-color -- <冲突文件>` | 首行 `diff --cc` + `@@@`=证实 `DiffView.tsx:34` 正则不匹配；普通 `diff --git`=冲突分支不成立（merge 分支已实测成立，不受影响） |
| **8 ✅** | ~~P2-90 的缓冲时机（唯一未排除的 P0 可能）~~ **已验证，见 `.audit-2026-11-13/verify-body-limit.md`** | 已完成：20MB 未认证 POST + headers-only（只发头不发 body）+ 2MB/20MB hold 期 RSS 采样；未发 300MB，按代码线性推演 | **缓冲在鉴权之前 → 升 P0（新增 P0-3）**。决定性证据：只发头不发 body 时 `/api/health`、`/login` **8s 内 0 字节**；发完 body 后 **2ms** 出 401；20MB body 的 WS 平台 **+17.1/+18.6MB**（2MB 对照 **+0.0MB**）；`/_next/` 这类不走 proxy 的路径 **1.8s** 就回 404 |
| **9 ✅** | ~~P1-10 的触发条件~~ **已验证，见 `.audit-2026-11-13/verify-plugin-install.md` §3** | 已完成：临时 `PI_CODING_AGENT_DIR` + `mklink /J`（目标根上放 `SKILL.md`+`.git`+`scripts/`），调 `deleteSkill(...)`；外加"多技能仓库"对照 | **目标被整目录递归删**（含 `.git`、`scripts`、`README.md`），`force:true` 不进回收站，**junction 残留成坏链接**（`isSymbolicLink=true`、`existsSync=false`）；对照组（B2）**嵌套技能不保护**、`others` 只在第二技能被单独发现时生效（B3） |
| 10 | **P1-16 静默失败** | `node -e "require('net').createServer().listen(30142)"` 占端口 → 生产模式启动 → 看远程面板 30s；同时 `curl /api/remote` 看 `lan.error` | 面板停在"启动中…"且 `lan.error` 有 EADDRINUSE 但不显示=证实 |
| 11 | **P1-16 的局域网兜底** | 改名 cloudflared → 生产启动 → 看是否出现 `http://192.168.x.x:30142` 与局域网码 | 不出现；但手工 `POST /api/remote/pair {base:"lan"}` 能拿到码=证实服务端已就绪、只差前端 |
| 12 | **P2-23 键盘按不动权限框** | 开设置弹窗 → 让 agent 触发一次权限请求 → 试 Tab / Esc | 焦点被拽回下层弹层=证实 |
| 13 | **P2-59 pid 复用** | 杀掉运行中的 PiWeb 让记录留在 `running`，重启后观察该任务是否永久卡死 | 卡死（不能跑/不能删）=证实 |
| 14 | **P1-15 30 分钟空转** | fake deps 里让模型触发 `ask`；把 `ASK_USER_TIMEOUT_MS` 临时调小 | 不返回 `unavailable/skipped`、直到运行超时=证实 |
| 15 | **P1-22(b) koffi 缺失崩** | 临时把 `node_modules/koffi` 改名 → `npx vitest run tests/lib/sandbox/windows-acl.test.ts` | 整文件红 + `TypeError: Cannot read properties of null`（不是 skip）=证实 |
| 16 | **P1-23 残缺构建被判可用** | 复制 `.next` 到临时目录 → 删掉 `server/app/api/health/route.js`（保留 21 个清单）→ 跑 `readProductionBuild` | 通过=证实；启动后访问该路由才 `MODULE_NOT_FOUND` |
| 17 | **P2-52 仓库 config 被执行** | `git init t && git -C t config core.fsmonitor <脚本> && git -C t status` | 脚本被执行=证实（机制） |
| 18 | **P2-71 双实例共享 `~/.pi/agent`** | 慢启动窗口里连点两次 `piweb` → 两个实例同时打开同一条会话各发一条消息 | 需 bridge 区域裁定 JSONL 并发追加是否安全（我只确认了全库只有一处 `proper-lockfile`） |
| **19 ⏳** | **P0-3 的真 272MB 单连接压测（v2 新增，未做）** | 一次受控压测：向 `/api/health` POST 272MB（或 272MB×N 并发），采样 RSS 峰值与可用内存 | 预期 RSS ≈ +272MB/连接、可用内存跌破 1GB；**属压力型请求，需要单独批准**（本轮只做到 20MB + 代码线性推演） |

**不需要再验的**（已实证，别再排期）：对比度 2.148/2.279（按 WCAG 公式算死）、19 条零执行模块清单（19/19 可复现，且 v8 覆盖率独立复现同一批）、18 处静默早退、`~/.codex` 的 5/22、本仓库 `refs/piweb` 的 218 个 commit、`D:\AIApp` 与 `D:\AIApp\PiWeb` 带 Low 标签（写稿时复测）。

**v2 关掉的新增项**（对应附录 C）：覆盖率（lines 83.56% / branches 70.45%）、真 cloudflared 链路（含 Host 白名单运行时生效、优雅 stop 123ms）、插件安装端到端（postinstall 真的执行、本地路径源不跑 npm）、provider 目录与市场（opencode 86/85 等）、移动端真浏览器（390×664，`100dvh`/横向溢出已撤）、UAC 策略层（不能静默提权）、规模采样（20k 条目 3.74s 等）。**仍然没有的**：真 272MB 压测（#19）、真手机（软键盘/iOS 安全区/WebKit）、真机断网重连、CI 门禁。

---

## 附录 C：本次审计没覆盖到的面（v2：逐条标注状态）

> 图例：**✅ 已关闭**（第二轮补验已补上，后缀为一句结论）/ **⏳ 仍在**（没做或只能部分做）。

1. **覆盖率 —— ✅ 已关闭**。`npm i --no-save @vitest/coverage-v8@5.0.5`（**未改** `package.json`/`package-lock.json`）+ `npx vitest run --coverage --coverage.include=src/**` → **lines 83.56% / branches 70.45% / functions 77.82% / statements 79.28%**，518.67s。**结论：行覆盖健康、分支覆盖是洞**（`git-service` 42.85%、`usePiWeb` 53.11%、`FullDiff` 行 5.4%），而 P1 家族正好长在这些没测到的错误/超时分支上。数据：`.audit-2026-11-13/coverage/coverage-summary.json`，做法见 §0.2 的"覆盖率"行与 `.audit-2026-11-13/verify-coverage.md`。
2. **真实 cloudflared —— ✅ 已关闭（但仍无 CI 门禁）**。cloudflared 2026.11.0 下载后真实跑通：quick tunnel 9s 注册连接、公网地址返回的是 PiWeb 自己的 JSON、`/` → **307 到 /login**、`/api/*` → **401 authentication required**；**`allowTunnelHost()` 的运行时注入确实生效**（隧道域名 → 401，未登记域名 → **403 untrusted host**），即 Next 16.4.5 的 proxy 与路由处理**共享同一个 `process.env`**；stop 后 cloudflared **123ms** 退出且域名立刻变 403；真实 `CTRL_C_EVENT` → **1537ms / exit 0**；`PIWEB_TEST_TUNNEL=1` 的 E2E 在 **Windows 上首次跑通（1 passed / 31.8s）**。残留：Windows 上 **16 条生命周期用例仍零执行**（P2-103），且 `PIWEB_TEST_TUNNEL` 仍无 CI 门禁。
3. **插件安装链 —— ✅ 已关闭**。真 `installAndPersist` 跑过：user 作用域装到 `<agentDir>\npm\node_modules\<包>`、settings 只多一条 `packages`；**缺 `--ignore-scripts` 时第三方 `postinstall` 真的执行**（marker 里有 `npm_lifecycle_event=postinstall` 与包内 cwd）；npm 级失败由 npm 自己回滚 `node_modules`（无解包孤儿，但 postinstall 已跑过）；单进程内两路并发被 `withSettingsWriteLock` 串行；**只读 `GET /api/skills` 真的触发了 `npm install`（2.58s）**。**方法学修正**：本地目录 source **不走 npm、不执行脚本**（27–47ms 只登记 settings），所以"用 `file:` 本地包测 postinstall"是错的测法，要用 `npm:` 源 + `hasInstallScript:true`。
4. **`proxyClientMaxBodySize: 272mb` 的缓冲时机 —— ✅ 已关闭（并升 P0-3）**。缓冲发生在 `proxy()` **之前**（`next-server.js:1227` 先 `cloneBodyStream()`，`adapter.js:303` 才调 handler），且 401 要等整个 body 收完才发（`body-streams.js:67-76` 的 `await endPromise`）；`body-streams.js:95-109` 超限只截断、**不 413**。实测：只发头不发 body 时 `/api/health`/`/login` **8s 内 0 字节**；20MB 未认证 POST 上传 123ms、401 在上传结束后 **2ms**；RSS **+17.1/+18.6MB**（2MB 对照 +0.0MB）。**未做的只剩"真发 272MB"**（附录 B #19）。
5. **UAC 提权 —— ✅ 已关闭（策略层）**。本机 `EnableLUA=1`、`ConsentPromptBehaviorAdmin=5`、`PromptOnSecureDesktop=1`、`ConsentPromptBehaviorUser=3`；当前进程是管理员账户的**非提权**进程（Medium，Administrators deny-only）。→ **Low 进程不能静默提权**（必须真人点"是"，提示在安全桌面不可代点/伪造）；`runas` 通道本身可达，属社交工程面 → **P2-10 维持 P2**。未实测的是"实际弹框并点是"（会打断用户）；**`EnableLUA=0` 的机器会退化成静默提权，那种环境应算 P1**。
6. **provider 联网核对 —— ✅ 已关闭（有明确剩下的）**。5 个公开 `/models` 端点 + 官方文档逐字段核对完：`catalogCapabilities` 规则覆盖窄已量化（opencode **86/85** 上下文低估、**71** 个视觉误判，见 P2-110）；marketplace 的 `keywords:pi-package` 是 npm **硬过滤**，"非 pi 包混进结果"**未复现**（250/250 干净，P2-73 降 P3-30）；用量解析器 10 个 JSON + 1 个头解析器逐个对文档核过（xAI 的 `x-ratelimit-*` 在官方文档里**查不到**、Anthropic 放着文档化的 `anthropic-ratelimit-*` 不用）。**仍未验证**：所有需要鉴权的响应**体**（按边界不发带 key 的请求）。
7. **pi 内核 —— ⏳ 保持"按要求未审"**。只读其类型声明/公开 API 核对 PiWeb 的调用是否正确；`abort()` 无超时、`exportToHtml` 默认写 CWD、`resolveToCwd` 的 `file:` 处理都是**内核行为**，结论始终是"PiWeb 对它的假设错了/没校验"，不是"内核有 bug"。（v2 新增的一处相关事实：`core/tools/read.js:59-62` 会在 `model.input` 不含 `image` 时**把用户的图换成一行占位文字**——这解释了 P2-110 的后果链。）
8. **移动端没有真机 —— ⏳ 部分关闭（真浏览器已做，真机仍缺）**。Playwright Chromium 143 的 iPhone 13 档（390×664 / DPR 3 / touch）真加载了被测服务：**横向溢出与 `100dvh` 两条担忧已实测否定**（见附录 A #17）；抽屉/侧栏/遮罩/z 序/滚动锁/设置面板/文件查看器全部按预期；**新发现**静默失联（P2-111）、永久 spinner（P2-112）、触控目标系统性 <44×44（P2-113）。**真机仍缺**：软键盘（`interactive-widget`）、iOS 安全区（`viewport-fit` 未开）、触摸惯性/橡皮筋、地址栏折叠动画、真实隧道下 `?poll=1` 的耗电与首开、真机断网重连、WebKit/Safari 而非 Chromium。
9. **规模数据 —— ✅ 已关闭**。i7-14700HX/15.8GB/NVMe、Node 24、git 2.54、`next dev` 下真采样：工作区 PiWeb 53,140 文件 / 6,357 目录 / 6.18GiB、git 索引 1,168 条；`D:\AIApp` 999,998 文件 / 130.6GiB / 非 git / 下有 27 个仓库（最大 `study\Reviva` 79,270 条）。**目录列举 20k 条目 3.74s**、`check-ignore` 占 94% 且超线性、只送当前页 331ms（**10.7×**）；`@` 索引 PiWeb 83ms / Reviva 1.63s / 非 git 的 `D:\AIApp` 每次 1.09s+1.2MB+RSS+135MB 无缓存；技能指纹同步 **40.1ms/次**；会话列表冷启动 **2.94s / RSS +145MiB**（→ P2-115）；真实仓库 blob p99 **88–331KB**、>4MB 全机仅 4 个文件（→ P2-44 口径改写）。**两条限定**：指标对机器负载极敏感（同一指标忙/闲差 4×，全部采用**空闲**数字，请按数量级看）；dev 模式 HTTP 层比生产多约 30–45ms（`/api/health` p50 44.9ms）。
10. **`update-service.ts` 的下载完整性与发布细节 —— ✅ 已关闭（结论比预期糟）**。全仓 `integrity|signature|sha256|sha512|checksum|provenance` 在 `src/**` 与 `scripts/**` **0 命中** → 完整性完全靠 npm 自身（无 registry 白名单、`npm install -g` 无 `--ignore-scripts`、`commandEnv` 把 `PI_WEB_LAUNCH_TOKEN` 传给所有生命周期脚本 → **P2-108**）；"更新成功"= 子进程 exit 0 + 21 个清单存在（→ P1-23 追记）；非 Windows 在服务运行中替换安装目录（**P1-26**）；失败不回退旧 ready 且自救路径在成品包上必失败（**P1-25**）；`update.lock` 写 pid 无人读（**P2-109**）。发布事务本身（新目录 + 原子清单 + 文件锁 + 失败不发布）是 OK 的，`npm pack` 实测 987 文件、`.next/cache` 已排除。
11. **行号会漂 —— ✅ 已改口径**。v2 已对所有引用位置**按内容复核**（函数名/代码原文/`grep` 片段），行号仍以**代码原文为准**：审计期间另一个会话在持续改这个仓库（`agent-manager.ts` 3136↔2964、`.next-releases` 13→63）。**规则**：v2 新增/改写的条目都同时给出"文件 + 函数名/代码特征 + 实测数值"，行号只作定位参考。

