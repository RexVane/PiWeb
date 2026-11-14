# 沙箱与权限 审计报告

审计对象：`src/lib/sandbox/*`、`permission-*.ts`、`tool-preset.ts`、`execution-guidance.ts`、`src/app/api/sandbox/route.ts`、`docs/workspace-isolation.md`（HEAD `1d4efba` + 未提交改动，按当前磁盘状态）。

## 0. 覆盖范围

**读了**（全文）：`src/lib/sandbox/windows-acl.ts`(404)、`manager.ts`(127)、`bash-operations.ts`(136)、`config.ts`(100)、`permission-gate.ts`(215)、`permission-audit.ts`(50)、`permission-request.ts`(19)、`permission-request-tool.ts`(104)、`tool-preset.ts`(39)、`execution-guidance.ts`(20)、`src/app/api/sandbox/route.ts`(27)、`src/lib/path-security.ts`(93，闸门依赖它)、`src/lib/pi.ts:470-518`（白名单）、`docs/workspace-isolation.md`(184)。
**读了测试**：`tests/lib/sandbox/*.test.ts`(6 个全读)、`tests/lib/permission-gate.test.ts`(237)、`permission-audit.test.ts`(31)、`tool-preset.test.ts`(57)、`tests/agent-resource-isolation.test.ts:700-829`（sandbox/e2e 段）+ 关键断言行。
**为核对调用契约读了 pi 的公开实现/类型**（不评论其内部实现，只用于验证 PiWeb 的调用假设）：`dist/core/tools/write.js`、`edit.js`、`path-utils.js`、`utils/paths.js`、`core/agent-session.js`(`executeBash`)、`extensions/codemode/tool.js`(嵌套调用注释)、`extensions/tool-search/tool.js`、`core/extensions/types.d.ts`(`tool_call` 契约)、`koffi@3.3.8`(`index.d.ts` + 实跑探针)。
**跳过了**：`agent-manager.ts` 余下 2000+ 行（只读沙箱相关：gate/`setToolPreset`/`runUserBash`/`disposeSession`/`sessionCustomTools`）；`src/lib/ask-user.ts`、automations 执行器（归 bridge/remote 区）。**没有**运行会改状态的东西：没有起沙箱、没有跑测试、没有 src 改动；只做了只读查询（`icacls`、`node -e` 纯计算、koffi 纯函数调用）。

### 结论一览

| 子功能 | 结论 | 依据 |
|---|---|---|
| `readonly` = 零写入 | **有问题** P0-2、P1-3 | `windows-acl.ts:141-144`、`manager.ts:76-98`；Low 标签不属沙箱实例而属磁盘 |
| `workspace` = 只允许 cwd + extraRoots + 私有 temp | **有问题** P0-1（write/edit 可完全绕过）、P1-2、P1-3 | `permission-gate.ts:95-118`、`config.ts:36-52`、`bash-operations.ts:112` |
| `full` = 全开 | OK（本地执行，无沙箱，符合设计） | `bash-operations.ts:108`、`permission-gate.ts:156` |
| bash 的进程级边界（cmd→node→git 整条链） | OK（令牌由内核继承；`CreateProcessAsUserW` 用 restricted 令牌免 `SeAssignPrimaryToken`）；**但 UI 不受限** → P2-11 | `windows-acl.ts:332,367`；`tests/lib/sandbox/windows-acl.test.ts:61-66` 覆盖 node 写入 |
| bash 的中断/超时 | **OK-但脆弱** P2-1（只杀直接子进程，无 Job Object） | `windows-acl.ts:393-399,220-223` |
| 令牌/结构体创建失败是否 fail-closed | OK（任何异常 → `createAclSandbox` 返回 null → `bash-operations.ts:118` 抛错拒绝执行） | `windows-acl.ts:242-245`、`bash-operations.ts:118` |
| 能力探测 | **OK-但脆弱** P2-6（只测 koffi 能否 import，不测 `icacls`/`CreateProcessAsUserW` 真能用） | `manager.ts:38-54` |
| 非 bash 工具过闸门 | **部分有问题**：write/edit 过闸门但可绕过（P0-1）；codemode 本体放行、嵌套调用确实过 `tool_call`；tool_search 只激活不执行 | `agent-manager.ts:1639-1642`、pi `codemode/tool.js:7-10`、`tool-search/tool.js:223-263` |
| readonly 下 powershell / codemode / MCP 写工具 | OK（真被拒，有测试） | `permission-gate.ts:160-176`、`permission-gate.test.ts:120-143` |
| 一次性升权（可重放/双花） | OK（无双花，`await` 后二次校验 + 同步消费）；**但完全不绑定具体动作** → P1-4 | `agent-manager.ts:1763-1789,1339-1346` |
| 沙箱缓存 key 与释放 | **有问题** P0-2、P2-4（切档不释放、release fire-and-forget） | `manager.ts:67-98,107-120`、`agent-manager.ts:2929-2956,2167` |
| 审计日志（session JSONL） | **OK-但脆弱** P2-9（不记被拒尝试；P0-1 逃逸后可改会话文件抹账） | `permission-audit.ts:40-50`、`agent-manager.ts:1344,1359` |
| Win32 结构体大小/签名 | OK（x64 逐字段核对无误，见本节末尾「Win32/koffi 核对」）；P2-7（未检查 `process.arch`） | `windows-acl.ts:317-320,333-336,350-356`；koffi 3.3.8 实测 |

### 路径闸门绕过面逐条结论

| 绕过面 | 结论 | 依据 |
|---|---|---|
| `..` 相对逃逸 | **被拦**（词法 `path.resolve` + `isPathInside` 前置判断） | `permission-gate.ts:100-110`；`permission-gate.test.ts:63-76` |
| 绝对路径在工作区外 | **被拦** | 同上 |
| UNC `\\server\share` | **被拦**，且刻意不碰盘（避免 SMB 挂起） | `permission-gate.ts:100-110` 注释 + 实现；测试 `:98` |
| 设备路径 `\\.\`、`\\?\`、`CON`/`NUL` | **被拦**（`\\?\` 是"假阴性"式拒绝）；`NUL`/`CON` 词法在区内 → 交给 realpath，落到设备对象时不在区内 → 拦 | `permission-gate.test.ts:99` |
| 盘符/路径大小写 | **被拦**（`comparable()` 小写化） | `path-security.ts:12-15`；测试 `:90-94` |
| 符号链接 / junction（指向工作区外） | **被拦**（`realpathLoose` 解析后比较），有测试 | `permission-gate.ts:60-76,111-117`；测试 `:78-83` |
| 硬链接 | **疑似可绕，需运行验证**（P2 边界，文档只写在第三道锁；第二道锁同样中招） | 见 P2-10 |
| 8.3 短名（`ADMINI~1`） | **不构成绕过**：词法比对按字面字符串，短名写法会直接被判"不在工作区"（假阴性拒绝） | `path-security.ts:17-20` |
| NTFS ADS（`file:stream`） | **不构成绕过**：`a.txt:stream` 词法在工作区内且真实对象也在区内 | 实测 `path.resolve` 结果 |
| 尾随空格/点 | **不构成绕过**：`..` 归一后再比；Windows 折叠尾点/空格仍落在区内 | — |
| `~` 展开 | **一致**（闸门与 pi 都用 `homedir()`，`~/`、`~\` 都展开；`~user` 都不展开） | `permission-gate.ts:48-52` vs pi `utils/paths.js` `normalizePath` |
| 大小写敏感目录（per-dir case sensitivity） | **不一致**：闸门一律小写化比较，per-dir case-sensitive 目录下两个仅大小写不同的文件会被当成同一个 → 只影响判定方向（可能误放行"改名"语义），非目录逃逸 | `path-security.ts:14` |
| **`file://` URL** | **可绕，已确认** → P0-1 | `permission-gate.ts:43-54` 不处理 `file:`；pi `utils/paths.js:119-120` 处理 |
| `@` 前缀 / 不间断空格 | **一致**（两边都归一） | `permission-gate.ts:44-47` |
| junction 的 TOCTOU（建链接早于检查、检查早于写） | **疑似可绕，需运行验证** → P2-3 | `permission-gate.ts:111-117` 与 pi 的写之间无锁 |

### Win32/koffi 核对（逐项，全部按 x64 ABI 手工对过）

| 结构体 / 调用 | 代码写的 | Win32 实际（x64） | 结论 |
|---|---|---|---|
| `STARTUPINFOW` | 104 字节，`dwFlags`@60，`hStdInput`@80 / `hStdOutput`@88 / `hStdError`@96 | cb(0)+pad(4)、lpReserved(8)、lpDesktop(16)、lpTitle(24)、6×DWORD(32..56)、dwFlags(60)、wShowWindow(64)、cbReserved2(66)、pad(68)、lpReserved2(72)、hStdInput(80)、hStdOutput(88)、hStdError(96)，共 104 | **一致** |
| `PROCESS_INFORMATION` | 24 字节，`pid`@16 | hProcess(0)、hThread(8)、dwProcessId(16)、dwThreadId(20)，24 | **一致** |
| `SECURITY_ATTRIBUTES` | 24 字节，`nLength`@0=24，`bInheritHandle`@16=1 | nLength(0)+pad(4)、lpSecurityDescriptor(8)、bInheritHandle(16)，24 | **一致** |
| `TOKEN_MANDATORY_LABEL` | 16 字节，Sid@0、Attributes@8=`SE_GROUP_INTEGRITY(0x20)` | SID_AND_ATTRIBUTES{PSID(0), DWORD(8)}+pad，16 | **一致** |
| `SetTokenInformation` 的 `infoClass` | `int` 25 (`TokenIntegrityLevel`) | 枚举 4 字节，值 25 | **一致** |
| `CreateRestrictedToken` 参数个数 | 9（token,flags,disableCount,sids,privCount,privs,restrictCount,restrictSids,out） | 9 | **一致** |
| `CreateProcessAsUserW` 参数个数 | 10 | 10 | **一致** |
| koffi 3.3.8 `void *` 返回值形态 | 代码用 `BigInt(handle)` 与 `koffi.address(handle)` | 实跑 `kernel32!GetModuleHandleW` 返 **bigint**（不是 External），`BigInt(h)`/`koffi.address(h)` 都可用，失败返 `null` | **一致**（`isValidHandle` 的 bigint 分支是对的） |
| 免 `SeAssignPrimaryToken` 的前提 | 用 `CreateRestrictedToken` 的 restricted 副本当令牌 | 微软文档：令牌是调用者主令牌的受限版本时不需要该特权 | **设计正确** |

平台风险只剩两处：**32 位架构未守卫**（P2-7）与 **`GetLastError()` 依赖 koffi 不覆盖 last-error**（现在只影响错误码文本，不影响判定；`windows-acl.ts:368` 在 `CreateProcessAsUserW` 之后立刻取，中间的 `CloseHandle` 会不会改 last-error 不确定 —— 只影响报错可读性，P3 级）。


## 1. 发现（按严重度降序）

### P0-1 `write`/`edit` 的 `file://` URL 绕过路径闸门，「工作区内修改」档可写任意位置

- **位置**：`src/lib/permission-gate.ts:43`（`resolveModelPath`）、`src/lib/permission-gate.ts:100`（`judgeWritePath`）
- **证据**：闸门自己解析路径，只做 `path.resolve`，不认 URL scheme：

```ts
// src/lib/permission-gate.ts:43-54
export function resolveModelPath(raw: string, cwd: string, home: string = os.homedir()): string {
	const cleaned = raw
		.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.trim()
		.replace(/^@/, "");
	...
	return path.resolve(cwd, expanded);
}
```

而 pi 的 `write`/`edit` 用**另一套**解析，其中包含 URL → 本地路径的转换：

```js
// node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js:119-120
if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
}
// dist/core/tools/path-utils.js:42  export function resolveToCwd(filePath, cwd)
// dist/core/tools/write.js:31       const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
// dist/core/tools/write.js:44,47    await ops.mkdir(dir); ... await ops.writeFile(absolutePath, content);
```

实测（用 node 复刻闸门的三个函数，只调 `path.resolve`/`fs.realpath`，无写入）：

```
raw      = "file:///C:/Users/guica/.ssh/authorized_keys"
target   = "D:\\AIApp\\PiWeb\\file:\\C:\\Users\\guica\\.ssh\\authorized_keys"   // 闸门看到的目标
resolved = 同上（realpathLoose 原样返回）
gateInside = true                                        // ← 闸门放行
piWould  = "C:\\Users\\guica\\.ssh\\authorized_keys"      // ← 实际写入位置
```

复现命令（只读，无副作用）：

```powershell
cd D:\AIApp\PiWeb
@'
const path=require("node:path"),fsp=require("node:fs/promises");
const cmp=p=>path.resolve(p).toLowerCase();
const inside=(r,c)=>{const rel=path.relative(cmp(r),cmp(c));return rel===""||(!rel.startsWith("..")&&!path.isAbsolute(rel));};
const cwd="D:\\AIApp\\PiWeb", raw="file:///C:/Users/Public/probe.txt";
const target=path.resolve(cwd,raw.trim().replace(/^@/,""));
console.log(target, inside(cwd,target));             // 区内 → 放行
console.log(require("node:url").fileURLToPath(raw)); // C:\Users\Public\probe.txt
'@ | node --input-type=commonjs -
```

- **触发路径**：会话档位 = `workspace`；模型发起 `write({path:"file:///C:/Users/<u>/.ssh/authorized_keys", content:"ssh-ed25519 AAAA…"})`（或 `edit`，或 codemode 里 `tools.write({...})`）→ `evaluateToolCallGate`(`agent-manager.ts:1736`) → `permissionDenial`(`permission-gate.ts:205-214`) → `judgeWritePath` 判 `inside:true` → 放行 → pi 的 `write` 用 `resolveToCwd` 解析到工作区外并落盘。
- **后果**：`workspace` 档的写入边界**完全失效**——能写的位置只受"PiWeb 进程自身权限"限制，等于 `full` 档的写能力。可写入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\*.bat`（下次登录以完整用户权限执行）、`~\.ssh\authorized_keys`（横向移动）、`.git/hooks/*`、`C:\Users\Public\*`（实测该目录对交互用户可写，`NT AUTHORITY\INTERACTIVE:(RX,WD,AD)`）。用户以为"只改工作区"。
- **置信度**：**已确认**（读完整链路 + 用 node 复刻两边解析并对比；未做真实落盘验证，验证方法：workspace 档会话里让模型 `write` 到 `file:///C:/Users/<u>/Desktop/piweb-escape.txt`，应成功并可读）。
- **建议修法**：`resolveModelPath` 补上与 pi 完全一致的归一：先 `if (/^file:\/\//i.test(cleaned)) → fileURLToPath(cleaned)`，并且**再加一条拒绝清单**（`file:`、`\\.\`、`\\?\`、`\\`）——闸门宁可假阴性也别猜；`edit`/`write` 的 `path` 一旦含 `:` 且不是盘符就拒绝。测试补 `judgeWritePath(ws,"file:///C:/Windows/x")===false`。

### P0-2 `readonly` 档不是零写入：工作区的 Low 标签属于磁盘而不属于沙箱实例，只读沙箱的子进程照样能写

- **位置**：`src/lib/sandbox/manager.ts:76`（`sandboxFor` 按 `sessionPath\0mode` 缓存）、`src/lib/agent-manager.ts:2948`（`setToolPreset` 不释放沙箱）、`src/lib/sandbox/windows-acl.ts:141`（打标签）、`src/lib/sandbox/windows-acl.ts:135`（只在 dispose 时还原）
- **证据**：沙箱创建时把 cwd 永久改成 Low（只在自己 dispose 时还原）：`windows-acl.ts:141-144` 的 `for (const dir of [...options.writableDirs, ...]) await markLow(dir)`；还原只发生在 `cleanup()`（`windows-acl.ts:132-137`），而 `cleanup` 只由 `dispose()` 触发，`dispose` 只由 `releaseSandbox` 触发（`manager.ts:117`），`releaseSandbox` 只在 `disposeSession` 里被调用（`agent-manager.ts:2167`）。**切档位不走这条路**：

```ts
// src/lib/agent-manager.ts:2948-2951  case "setToolPreset"
m.toolPreset = preset;
m.customActiveTools = undefined;
clearEscalation(m);          // 只清一次性授权
applyToolPolicy(m, session); // 只重算工具名单，不动 holders
```

readonly 档另建一个 `writableDirs: []` 的沙箱（`manager.ts:82-84`），但**磁盘上 cwd 还是 Low**；Low 进程写 Low 目录被允许 → 只读沙箱的子进程写入成功。
- **触发路径**（同一会话内，最常见）：默认/已存档位 = `workspace` → 跑过任意 bash（例如 `npm test`）→ 用户切到「仅可查看」以防模型乱改 → 模型调 bash 写文件 → **成功**。跨会话同理：同一工作区开着两个会话，一个 workspace、一个 readonly，readonly 那个的 `bash` 也能写。
- **后果**：`readonly`（"零写入"，文档第 76-77 行明确承诺"任何写入都被内核拒"）实际上可写整个工作区，包括 `.git/hooks`、`node_modules`、源码。用户切到只读档正是为了阻止这件事。
- **置信度**：**已确认**（代码链路完整；结论只依赖 Low→Low 允许写这一 ACL 语义）。运行验证：workspace 档会话 `bash` 跑 `echo a> inside.txt` 成功后切 readonly，再让模型 `bash` 跑 `echo b> inside2.txt`，若 `inside2.txt` 出现即证实。
- **建议修法**：给 `releaseSandbox` 加"只释放指定 mode"的入口，`setToolPreset` 切到更严档位时先 `await` 释放 workspace 沙箱（并还原标签）；或把标签改成按目录引用计数（见 P2-4）。同时把 `BashOperations.exec` 在 readonly 下改成"进入前确认 cwd 不是 Low"。

### P1-1 `readonly` 档里用户的 `!` 命令完全没有沙箱（与文档矛盾）

- **位置**：`src/lib/agent-manager.ts:1651`
- **证据**：

```ts
// src/lib/agent-manager.ts:1651
api.on("user_bash", () => (m.toolPreset === "workspace" ? { operations: userBashOperations } : undefined));
```

```ts
// src/lib/agent-manager.ts:2752,2761（runUserBash）
const hooked = await session.extensionRunner.emitUserBash({...});
...
}, { excludeFromContext, operations: hooked?.operations });
```

pi 侧 `operations` 为 undefined 时回落到本地不受限执行：`dist/core/agent-session.js:3268` `options?.operations ?? createLocalBashOperations({ shellPath })`。
- **触发路径**：readonly 档 → 用户（或任何能发 `{cmd:"bash"}` 的客户端）输入 `!del /s /q D:\x` → `runUserBash` → 本地全权限执行。
- **后果**：`readonly` 档存在一条完整权限的 shell 通道；`docs/workspace-isolation.md:55-56` 写的是"`!` 用户命令走 `user_bash` 扩展事件返回同一套 operations"，与实际不符（只在 workspace 档成立）。用户把 readonly 理解成"这个会话不会动我的盘"。
- **置信度**：已确认（读了 hook 注册点 + 调用点 + pi 的回落实现）。验证：readonly 档在输入框跑 `!echo x > %USERPROFILE%\Desktop\bang.txt`，文件出现即证实。
- **建议修法**：`api.on("user_bash")` 无条件返回 `{ operations: userBashOperations }`（readonly 时它内部就是只读沙箱；`full` 档时 `bash-operations.ts:108` 本来就走本地）。一行改动，语义立刻与文档一致。

### P1-2 把工作区根整棵标 Low：工作区是主目录/盘符祖先时，`~/.ssh`、`%APPDATA%` 对整个 Low 世界开放

- **位置**：`src/lib/sandbox/windows-acl.ts:98`（`icacls <dir> /setintegritylevel (OI)(CI)Low`）
- **证据**：标记是**递归可继承**的，作用对象是整个目录树，而"工作区"来自用户随手选的目录（`web-workspaces.json` 里本机就出现过 `D:\AIApp`（本项目的父目录）与历史工作区 `C:\Users\guica`）：

```ts
// src/lib/sandbox/windows-acl.ts:97-99
async function markLow(dir: string): Promise<void> {
	await run("icacls", [dir, "/setintegritylevel", "(OI)(CI)Low"], { windowsHide: true });
}
```

- **触发路径**：把 `C:\Users\<u>` 或 `D:\AIApp` 设为工作区 → 该会话在 workspace 档跑一次 bash → 整棵树变 Low，直到会话被回收（`reap()` 的 IDLE_MS / 归档 / 关标签）。
- **后果**：Low 目录里的文件对**任何** Low 进程可写：别的会话的 readonly 沙箱子进程、浏览器 low-IL 渲染进程、其它低完整性工具。也就是说"工作区"选得越大，`~/.ssh/authorized_keys`、`%APPDATA%\...\Startup`、`.pi/agent/auth.json`（API 密钥）就从"内核禁止低完整性写"变成"任何低完整性进程都能改"。这把 P0-2 的破坏面从"工作区"扩大到"用户配置与凭据"。
- **置信度**：已确认（ACL 语义 + 标记范围）；危害大小取决于用户选了多大的工作区。
- **建议修法**：拒绝把"包含 `%USERPROFILE%` / 盘符根 / 系统目录"的目录当 workspace（`resolveWorkspacePath` 里加黑名单），或在 `markLow` 前对 `writableDirs` 做同样的包含性检查并在 UI 上明确警告。

### P1-3 「写全被拒」不成立：`%LOCALAPPDATA%Low` 等 Low 目录永远可写（两个档位都会写出工作区）

- **位置**：`src/lib/sandbox/windows-acl.ts:8`（设计前提"其余目录都是 Medium"）、`src/lib/sandbox/bash-operations.ts:112`（readonly 只给空可写列表）
- **证据**：设计前提是"其余目录都是 Medium，低完整性不能往高写"。这句在本机不成立——`%USERPROFILE%\AppData\LocalLow` 默认就是 Low：

```
> icacls "$env:USERPROFILE\AppData\LocalLow" | Select-String Mandatory
                                Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

`(NW)` = no-write-up，只挡 Medium 及以上；Low 写 Low 是允许的。`readonly-mode.test.ts:43-58` 只测了工作区目录和 `%TEMP%`（两者都是 Medium），所以没暴露。
- **触发路径**：任意档位的 `bash`：`echo x> "%USERPROFILE%\AppData\LocalLow\piweb-probe.txt"`。
- **后果**：`readonly` 档仍能在工作区外落盘（可作暂存/投放点）；`workspace` 档的"只写工作区"同样不成立。不是提权（仍是 Low 对象），但"零写入/只在工作区写"的产品承诺是假的。
- **置信度**：**已确认（ACL 语义）**，未做落盘验证。验证：readonly 档 `bash` 跑上面那条命令，`type` 出来即证实。
- **建议修法**：文档与 UI 把措辞从"写入全被拒"改成"写不进 Medium 及以上的位置"；技术上要真正零写入只能上 AppContainer（低盒）或只读挂载。至少让 `readonly` 在启动时列出"本机已知可写的 Low 目录"做提示。

### P1-4 一次性升权不绑定具体动作：批准"一条命令"后可以换成任意 full 命令或任意越界写入

- **位置**：`src/lib/agent-manager.ts:1354-1357`（`grant` 只存 scope）、`src/lib/agent-manager.ts:1787`（消费时不比对）
- **证据**：

```ts
// src/lib/agent-manager.ts:1354-1357
grant: (scope) => { clearEscalation(m); m.escalation = { scope, remaining: 1 }; },
// src/lib/agent-manager.ts:1787
consumeEscalation(m, describeEscalatedToolCall(event.toolName, event.input)); // command 只用于审计
```

批准卡上写的是"只对下一次越界操作（一条命令或一次写入）生效"（`permission-request-tool.ts:69`），但 `m.escalation` 只有 `{scope, remaining}`：模型用"需要 `git worktree add`"拿到 `full`，随后跑 `powershell -c ...`/`curl | cmd`／写任意路径，都不受任何检查（`escalatedPreset === "full"` → `permissionDenial` 直接 `undefined`，`bash-operations.ts:108` 走 `local.exec`）。
- **触发路径**：任何一次批准 → 下一步任意越界动作。
- **后果**：用户批准的是"动机"，执行的是"任意动作"。配合 §1 P0-1（写路径可绕）与自动化任务，等于一次点击后门。审计里能看出来（`used` 记了命令原文），但拦不住。
- **置信度**：已确认（代码）；这是**设计取舍**，不是编码 bug——但 `docs/workspace-isolation.md:84` 与提示词（`execution-guidance.ts:18`）都宣称"covers exactly one command"，实际是"one action any target"。
- **建议修法**：`grant(scope)` 里一并存 `reason` 与可选的目标提示，消费时把实际命令/路径与原申请做一次粗匹配（含/前缀匹配即可），不匹配就要求重新申请；或至少把批准卡文案改成"下一次越界动作（可能是任何命令/任何路径）"。

### P2-1 中断/超时不杀进程树：`kill()` 只 `TerminateProcess` 直接子进程

- **位置**：`src/lib/sandbox/windows-acl.ts:393-399`（kill）、`src/lib/sandbox/windows-acl.ts:220-223`（超时只调 `handle.kill()`）
- **证据**：`TerminateProcess(processHandle, 1)` + `WaitForSingleObject`，没有 Job Object（`CreateJobObject`/`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 全程未出现），`child_process` 的 `detached/tree-kill` 也没用。
- **触发路径**：`bash: start /b node server.js` 或 `node -e "require('child_process').spawn('x',{detached:true})"` → 超时/用户 abort → cmd.exe 被杀，孙子进程继续以 Low 令牌跑（还能写工作区）。
- **后果**：假"已中止"；进程与文件句柄泄漏；工作区被后台进程持续改写；审计/轨迹与实际不符（`aborted` 已回给模型）。
- **置信度**：已确认（代码）；建议修法：把子进程放进 Job Object，`kill` 时 `TerminateJobObject`。

### P2-2 `realpathLoose` 在 ENOENT/ENOTDIR 之外的错误上 fail-open（返回未解析路径继续判定）

- **位置**：`src/lib/permission-gate.ts:67-70`
- **证据**：

```ts
} catch (error) {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code !== "ENOENT" && code !== "ENOTDIR") return path.resolve(target); // ← 不解析链接就返回
```

- **触发路径**：目标路径的 realpath 因 `EACCES`/`EINVAL`/`ELOOP`/路径非法字符等失败（例如 `file:` 逃逸正是靠这一支走到"原样返回"，P0-1 的一半原因在此）；此时任何链接都不解析，`isPathInside` 只比值字符 → 判"区内"。
- **后果**：安全判定上的 fail-open。当前能被利用的具体形式见 P0-1；单独看它是一颗随时会被下一种路径语法引爆的雷。
- **置信度**：已确认（代码 + 实测 `file:` 输入走的就是这一支）。建议修法：非 ENOENT/ENOTDIR 一律视为"不在区内"（fail-closed），并在错误信息里带上 code。

### P2-3 检查与写入之间的 TOCTOU：junction 可以在工作区内建，闸门无锁

- **位置**：`src/lib/permission-gate.ts:111-117`（`realpathLoose` 之后直接放行）与 pi 的 `write`（`write.js:44,47` 之间只有 `mkdir`）之间没有任何串行化。
- **触发路径**：同一回合并行两个工具调用：`write({path:"escape/evil.txt"})` 与 `bash({command:"mklink /J escape C:\\Users\\x\\.ssh"})`。若 bash 先建好 junction、而 write 的 realpath 在链接建立前完成，则写入落到 `.ssh`。`mklink /J` 不需要管理员，工作区内建目录对 Low 进程也允许。
- **后果**：workspace 档存在窗口期逃逸（需要模型主动构造并行）。
- **置信度**：**疑似，需运行验证**。验证方法：先在工作区建 `escape` junction 指向 `C:\Users\<u>\Desktop`（同一会话用 bash），同时用 `write` 写 `escape/probe.txt`，跑 100 次记录是否有一次落到 Desktop；或直接用 `while(1){mklink /J; rmdir}` 抢窗口。建议修法：闸门通过后把目标路径以 **句柄（已打开）** 形式交给写入（pi 不支持则退而求其次：写入前再 realpath 一次 + 拒绝区内的 reparse point（`fs.lstat` 的 `isSymbolicLink`））。

### P2-4 切档/换工作区不重建沙箱；release 是 fire-and-forget；额外的可写目录也只对新建生效

- **位置**：`src/lib/agent-manager.ts:2167`、`src/lib/sandbox/manager.ts:74-76`（注释承认首次创建即固定）
- **证据**：`void releaseSandbox(m.sessionPath);`（不 await，失败静默），`sandboxFor` 的缓存 key 只有 `sessionPath\0mode`，**不含 cwd 与 extraRoots**。`/api/sandbox` 的 PUT 也明确说"新目录在下一次建沙箱时生效"（`route.ts:21`）。
- **后果**：(a) 同一会话若换工作区（fork/切 workspace），旧目录仍 Low 且仍可写，新目录不可写 → 静默错；(b) `releaseSandbox` 失败时 Low 标签残留，只能照文档 §六 手动 `icacls`；(c) 两个会话共用同一工作区时互相踩标签：一个 dispose 把目录还原成 Medium，另一个 workspace 档的 shell 突然写不了（功能性故障，且表现为"内核拒绝"这种反直觉错误）。
- **置信度**：已确认（a 取决于是否存在切 cwd 的路径，`m.cwd` 我没找到改写点 → 更可能只是 (b)(c)）。
- **建议修法**：key 加 cwd；`releaseSandbox` 用 `await` 并在失败时打日志；给"目录引用计数"（谁标的 Low 谁减一，归零才 `markMedium`）。

### P2-5 stdout/stderr 每 50ms 全量 `readFile`：O(n²) 读放大 + 无大小上限

- **位置**：`src/lib/sandbox/windows-acl.ts:184-198`
- **证据**：`const full = await fs.readFile(file);` 每次 flush 读**整个**文件，只在内存里 `subarray(from)`；`POLL_MS = 50`（`:29`）。落盘文件无上限，也没有 pi 那种截断参与。
- **后果**：`yes`/`type bigfile`/`while true; do echo x; done` 这类命令会让 PiWeb 主进程每秒 20 次读取越来越大的文件 → CPU 飙、内存峰值等于输出大小、磁盘被写满（私有 temp 在 `~/.pi/agent/web-sandbox/<key>`）；超时后文件到 dispose 才删。
- **置信度**：已确认（代码）。建议修法：用 `fs.open` + `read(len, from)` 只读增量；在写满 N MB 时 kill 并在结果里标 truncated（pi 的 `truncate.js` 有现成策略）。

### P2-6 `createAclSandbox` 把所有错误吞进 `catch {}`；`probeSandboxSupport` 只验证 koffi 能 import

- **位置**：`src/lib/sandbox/windows-acl.ts:242-245`、`src/lib/sandbox/manager.ts:38-54`
- **证据**：

```ts
} catch {
	await cleanup();
	return null;    // 失败原因（icacls 的 stderr、GetLastError）全丢
}
```

- **后果**：`sandbox unavailable: refusing to run a shell command unconfined`（`bash-operations.ts:99`）是用户能看到的唯一信息；`GET /api/sandbox` 会把 `supported: true` 报给 UI，而每次 bash 都失败（FAT 卷、icacls 被拒、非管理员受限环境）。用户看到"支持沙箱"却被拒，无从排查（文档 §六 只能让他猜）。
- **置信度**：已确认。建议修法：`catch (error)` 存最近一次失败原因，`GET /api/sandbox` 一并返回 `lastError`；或探测阶段就真建一次沙箱（在私有 temp 里）验证。

### P2-7 未检查 `process.arch`：结构体偏移写死 x64

- **位置**：`src/lib/sandbox/windows-acl.ts:122`（只判 `platform`）、`:317-320`、`:333-336`、`:350-356`
- **证据**：`STARTUPINFOW` 104 字节、句柄偏移 80/88/96、`PROCESS_INFORMATION` 24、`SECURITY_ATTRIBUTES` 24、`TOKEN_MANDATORY_LABEL` 16 全部按 **x64** 手写；`readPointer` 固定读 8 字节。32 位 Node（ia32）下这些偏移全错，而 `CreateProcessAsUserW` 仍可能返回成功。
- **后果**：32 位运行时上得到的不是一个"失败"的沙箱，而是一个参数被错读的进程创建——最坏情况是子进程没拿到 Low 令牌却"看起来启动了"。目前 Node ≥22 的官方 Windows 构建都是 x64/arm64，实际风险低，但这是唯一一处"平台假设没有守卫"的地方。
- **置信度**：已确认（代码）；风险为潜在。建议修法：`if (process.arch !== "x64" && process.arch !== "arm64") return null;`（arm64 的指针/结构体尺寸与 x64 相同）。

### P2-8 `exec` 中 spawner 抛错时 `.out`/`.err` 残留

- **位置**：`src/lib/sandbox/windows-acl.ts:176-182`（spawner 调用在 `try` 之外）与 `:208`（`try` 从这里才开始）
- **后果**：`CreateFileW`/`CreateProcessAsUserW` 失败（例如命令行为空、cwd 不存在）时，每次尝试都在私有 temp 留两个空文件，到 dispose 才清；长会话里是可见的垃圾积累。
- **置信度**：已确认。建议修法：把 spawner 调用挪进 `try`。

### P2-9 审计只记"批准/使用"，不记被拒的越权尝试

- **位置**：`src/lib/permission-audit.ts:21-37`（只有 `decision`/`used` 两种事件）、`src/lib/permission-gate.ts:154`（拒绝时不落审计）
- **后果**：模型在 readonly 档连续尝试 20 次越界写入（或提示注入驱动的探测）在会话 JSONL 里**没有任何痕迹**，只有被拒的工具结果消息（模型侧可被压缩/截断丢掉）。审计的用途是"事后看谁在试探边界"，现在只能看到"谁被批准过"。
- **加固相关**：`write` 的审计只有升权用过的那一次；配合 P0-1，逃逸动作可以顺手改会话 JSONL（`~/.pi/agent/sessions/**.jsonl` 在 Medium 区，`full` 档 bash 可写；`file://` 逃逸后 `write` 也能写），审计不再是防篡改的。
- **置信度**：已确认（设计如此）。建议修法：`permissionDenial` 返回拒绝时也写一条 `denied` 事件（同一 customType，附 tool+路径+理由），并对会话 JSONL 做只追加校验（写入前记录大小/哈希）。

### P2-10 硬链接边界只写在第三道锁，第二道锁（write/edit 进程内写）同样中招

- **位置**：`docs/workspace-isolation.md:103`（"硬链接 能绕过目录边界"）vs `permission-gate.ts:60-76`（完全不考虑硬链接，`realpath` 也解决不了别名）
- **触发路径**：工作区里存在（或由沙箱内 bash 造出）指向工作区外**用户可写文件**的硬链接 → `write` 闸门判"区内"→ 进程内写落到真实对象 → 工作区外文件被改。`write` 的 `content` 是全量覆盖，破坏性直接。
- **置信度**：**疑似，需运行验证**（未验证 Low 完整性进程能否对 Medium 文件建硬链接；`runas /trustlevel` 给的是受限令牌而非 Low 完整性，不能用它验证）。验证方法：在 PiWeb 里开一个 workspace 档会话，先用模型的 `bash` 跑
  `mklink /H <工作区>\probe.txt %USERPROFILE%\Documents\seed.txt`（沙箱子进程就是 Low 完整性），
  看命令是否成功且 `dir /a <工作区>` 出现 `probe.txt`；成功后再让模型 `write probe.txt`（内容为标记串），
  最后检查 `Documents\seed.txt` 是否被改。若第一步就被拒，则本向量不成立（但也说明"硬链接"这一行应写明只影响第三道锁）。
- **建议修法**：文档把这一条从"第三道锁的边界"改成"两道锁都不管"；代码上 `judgeWritePath` 里加 `fs.stat` 后比对 `nlink > 1` 就拒绝（把"链数>1"当可疑）。

### P2-11 令牌能挡住 `icacls`/`takeown`/计划任务，但挡不住 `Start-Process -Verb RunAs`（UAC 弹窗）走出沙箱

- **位置**：`src/lib/sandbox/windows-acl.ts:296-330`（令牌只有 `DISABLE_MAX_PRIVILEGE` + Low 标签，没有 AppContainer/Job 限制）
- **逐条结论**（均为"被拦"的依据）：Low + `NO_WRITE_UP` 对 Medium 及以上对象禁止 `WRITE_DAC`/`WRITE_OWNER`/`DELETE`/`WRITE_DATA`，因此
  - `icacls <外部目录> /setintegritylevel …`：改 SACL 要 `WRITE_OWNER`+`SeRelabelPrivilege` → 拒；
  - `takeown`：要 `WRITE_OWNER` → 拒；
  - `schtasks /create`：写 `%SystemRoot%\System32\Tasks`（Medium，SYSTEM 拥有）→ 拒（工作区内的 `<task>.xml` 也要再导入一次，同样拒）；
  - `Start-Process <任意程序>`（不带 `-RunAs`）：能起，但子进程继承 Low 令牌 → 仍在笼子里。
- **唯一走得通的一条**：`bash` 里 `powershell -c "Start-Process cmd -Verb RunAs"` —— 沙箱**不挡 UI**，Low 进程照样能 `ShellExecute(runas)` 弹出 UAC 同意框；用户在框上点"是"就得到一个 **High 完整性**的进程，与沙箱无关。`workspace`/`readonly` 只是不提供 `powershell` **工具**，bash 里手写 `powershell.exe` 不受影响。
- **后果**：模型（或提示注入）可以主动弹 UAC 骗用户点"是"，一步跳出所有边界；这也是"沙箱不是安全边界"里最容易被低估的一条（文档 §4 的"明确不拦"清单没写）。
- **置信度**：**疑似，需运行验证**（UAC 弹窗是否被策略/低完整性拦截取决于本机 UAC 设置；未实测）。验证：workspace 档 `bash` 跑 `powershell -NoProfile -c "Start-Process cmd -ArgumentList '/c whoami /groups > %TEMP%\\uac.txt' -Verb RunAs"`，看是否弹框；点"是"后检查 `%TEMP%\uac.txt` 是否出现且带 High 完整性。
- **建议修法**：文档第 4 节补一行；技术上只能靠 AppContainer + 无 UI（或强制 `ConsentPromptBehaviorAdmin`/"不显示 UAC"策略）解决，属于产品定位问题（不要宣称"挡住了提权"）。

### P3-1 `markMedium` 会把工作区原有完整性标签覆盖成 Medium，且失败静默

- **位置**：`src/lib/sandbox/windows-acl.ts:102-104`、`:135`
- **证据**：`for (const dir of marked) await markMedium(dir).catch(() => undefined);` —— 只还原本次自己标过的目录，值写死 `Medium`，失败被吞。注释自己承认"不复原调用方原先可能有的显式标签"。
- **后果**：工作区原本若是 High/带显式标签，释放后被永久改成 Medium；还原失败时 Low 残留且零日志。建议：`console.warn` 记下失败，或先读出原标签再写回。

### P3-2 子进程继承整份 `process.env`（含密钥）；readonly 的 `TMP` 指向不可写目录

- **位置**：`src/lib/sandbox/windows-acl.ts:360-366`；`src/lib/sandbox/bash-operations.ts:126-129`
- **证据**：环境块由 `process.env` 全量构造（只做大小写归并）；只有 workspace 档覆盖 `TMP`/`TEMP`。readonly 档的 `%TEMP%` 仍是 `%LOCALAPPDATA%\Temp`（Medium）→ 命令写临时文件报 `Access is denied`，用户看不出是"没有可写临时目录"。
- **后果**：`bash: echo %ANTHROPIC_API_KEY%` 在 readonly 也能打出父进程密钥（与 `read ~/.pi/agent/auth.json` 同级，但文档没提）。建议：环境块改成白名单（PATH/SystemRoot/ComSpec/PATHEXT/…），readonly 下把 TMP 指向不可写时给一句明确错误。

### P3-3 `hasSandbox` 只有测试在用；测试状态清理不全；`manager.test.ts` 会写到真实 agent 目录

- **位置**：`src/lib/sandbox/manager.ts:101-104,123-127`、`tests/lib/sandbox/manager.test.ts:44`
- **证据**：`resetSandboxStateForTests()` 只清 `support/probing/holders`，**不 dispose 已建沙箱**（标签残留到进程结束）；`manager.test.ts` 用字面量 `"session-a"` 当 sessionPath 且没 stub `PI_CODING_AGENT_DIR`，`tempDirFor("session-a")` 落到开发者真实的 `~/.pi/agent/web-sandbox/c2Vzc2lvbi1h` 并在那里 `icacls`。
- **后果**：测试互相污染，开发者机器上出现莫名被标 Low 的目录。建议：`resetSandboxStateForTests` 改成 async 并 dispose；测试照 `config.test.ts:24` 那样 stub `PI_CODING_AGENT_DIR`。

### P3-4 `tempDirFor` 用 `base64url(sessionPath).slice(-24)` 当目录名

- **位置**：`src/lib/sandbox/manager.ts:61-65`
- **后果**：截断后碰撞概率虽低但没必要（`.jsonl` 名本身已唯一），且把会话路径片段明文写进 agent 目录列表。建议 `sha256(sessionPath).slice(0,16)`。

### P3-5 `/api/sandbox` 的 PUT 状态码分支恒为 400

- **位置**：`src/app/api/sandbox/route.ts:25`
- **证据**：`status: err instanceof SyntaxError ? 400 : 400` —— 三元两边一样。建议直接 `400`，或 JSON 解析失败 400 / 校验失败 422。

## 2. 缺失的测试

| 行为 | 为什么重要 | 建议测什么 |
|---|---|---|
| `file://` / URL 形式路径 | **P0-1 就是因为没有这条测试** | `judgeWritePath(ws,"file:///C:/Windows/x").inside===false`；e2e：workspace 档 `write` 到 `file://` 必须被拒 |
| readonly 在"目录已被标 Low"的情况下 | P0-2 是缓存/标签生命周期问题，现有 readonly 测试用的是全新 Medium 目录 | 先建 workspace 沙箱 → `dispose` 前再建 readonly 沙箱 → 断言只读子进程写 cwd 失败；或断言"切档位会释放上一个沙箱" |
| 跨会话共用同一工作区 | 标签是磁盘状态，两个会话会互相踩 | `sandboxFor("s1",ws,{workspace})` + `sandboxFor("s2",ws,{readonly})` → s2 写必须失败；`releaseSandbox("s1")` 后 s1 的 shell 不能**静默**失去写权限 |
| Low 完整性可写目录（`AppData\LocalLow`） | 决定"零写入"承诺的真伪 | readonly 沙箱子进程写 `%USERPROFILE%\AppData\LocalLow\probe` 的期望行为（现在会成功） |
| `!` 用户命令在各档位 | P1-1 的实际行为与文档不符 | mock `emitUserBash` 断言 readonly/full 档也返回 `operations` |
| 升权授权的"动作绑定" | P1-4 | 批准 `full` 后执行一条与理由无关的命令，期望被拒（当前会放行）——先定语义再写测试 |
| 进程树终止 | P2-1 | 沙箱里起一个孙进程，abort/超时后断言孙进程消失 |
| 输出放大 | P2-5 | 沙箱里 `ping -n 100000 127.0.0.1`，断言内存/文件大小有上限、结果标 truncated |
| 硬链接 | P2-10 | 工作区内硬链接指向外部文件时 `write` 必须被拒 |
| 结构体/架构守卫 | P2-7 | 断言非 x64/arm64 时 `createAclSandbox` 返回 null |
| UAC 诱导 | P2-11 | 沙箱里 `Start-Process -Verb RunAs` 是否弹框（期望：不该有弹框能力，或至少在文档里声明） |

现有测试质量评价：`permission-gate.test.ts`（237 行）对字符串/realpath 面覆盖扎实（UNC、`\\?\`、盘符大小写、junction、`src/../../outside`、additionalWritableRoots 都有断言，且断言的是**解析后的真实目标**而非布尔），`windows-acl.test.ts` 的 cmd+node 两条写路径与"读不受限"也是真断言；`escalation.test.ts` 用 mock 断言"选了哪个模式"而不是真起进程，这是合理的。弱的是**状态生命周期**（标签/缓存/释放）与**路径语法全集**（`file:`、ADS、8.3、硬链接），恰好是出问题的地方。

## 3. 与其他区域的可能交叉点

1. **API/鉴权（`src/app/api/**`）**：`cmd: "bash"` 的通道是谁能调？P1-1 把 readonly 的 `!` 变成全权限 shell，如果这个命令端点对"非本机/非活跃 viewer"也开放，P1-1 直接升级成 P0（远程任意命令）。请 API 区确认该端点的鉴权与来源校验（本会话只看 `agent-manager.execute` 的 `case "bash"`，`agent-manager.ts:2872-2894`）。
2. **API/鉴权（`/api/sandbox`）**：`PUT` 能改 `additionalWritableRoots`（= 沙箱的可写白名单）。`route.ts` 里没有任何本地鉴权检查（依赖全局中间件）。如果该路由可被跨站/未授权调用，等于让攻击者直接扩大沙箱可写范围。请 API 区裁定。
3. **bridge（`agent-manager.ts` 归 bridge）**：我在这里只做了"闸门是否真的挂上"的核对（`tool_call` + `guardToolExecution` 双层，`agent-manager.ts:1639-1642,1835-1855`）。`m.escalation` 的状态机、`setToolPreset` 与 `holders` 的交互建议 bridge 区一并看；另外 `customActiveTools` 会**整体取代**档位白名单（`:1804`），目前靠第二道锁兜底，这个耦合值得 bridge 区确认是有意设计。
4. **remote/automations**：自动化任务"自带权限档位"（`permission-gate.ts:191-198` 因此拒绝 `manage_automation`）。请 remote 区确认：自动化运行时构造的 `Managed` 是否也装了同一个 `tool_call` 闸门，以及它的 `toolPreset=full` 是否会与用户当前档位冲突（我只看到 `registerManaged` 默认 `readonly`，`agent-manager.ts:1256`）。
5. **crosscut/UI**：权限档位切换的 UI 文案（"仅可查看"）与实际能力差距（P1-1/P1-3）需要 UI 区一起改措辞，否则用户的安全预期仍然是错的。

## 4. 建议优先修的 3 件事

1. **堵 P0-1**：`resolveModelPath` 与 pi 的 `normalizePath` 对齐 + `permission-gate` 明确拒绝 `file:`/`\\`/`\\.\`/`\\?\` 形式的路径。改动小、测试好写，但这是当前唯一"一条 prompt 就能写出工作区"的路。
2. **修 P0-2**：切到更严档位时释放上一档的沙箱（或给 Low 标签做引用计数）。不做这个，`readonly` 在真实使用序列（workspace 跑过命令 → 切只读）里等于没开。
3. **顺手修 P1-1**：`user_bash` 无条件接管（一行），让 `!` 也进沙箱。顺带把 P1-3 的措辞（"零写入"→"写不进 Medium 及以上"）在文档与 UI 里改掉，避免继续给用户错误的边界感。
