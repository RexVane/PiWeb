# 沙箱 / 路径闸门复审（工作区相对 HEAD 1d4efba）

静态阅读当前未提交文件与 `write`/`edit`/`bash` 的 SDK 调用点。未跑 npm、vitest、build，未改 git 状态。下面只记录当前代码能对上的问题。

## 发现

### [HIGH] src/lib/confined-file-operations.ts:57
**问题**：一次性 `full` 升权绑定的是原始参数字符串，但 `full` 分支用宿主 `fs.writeFile` / `fs.mkdir` 落盘，不再走 `judgeWritePath`。SDK 对同一字符串的规范化与闸门不一致，junction/符号链接也会在这一支被跟随。批准「看起来在工作区内」的一次写入，可以写到工作区外。
**触发条件**：
1. 会话不是 `full`（`readonly` 或 `workspace`）。工作区示例：`D:\AIApp\PiWeb`。
2. 模型发起 `write` 或 `edit`，路径用 MSYS/Git Bash 形式，例如 `/mnt/c/Users/Public/piweb-pwn.txt`、`/c/Users/Public/piweb-pwn.txt` 或 `/cygdrive/c/Users/Public/piweb-pwn.txt`。闸门 `resolveModelPath` → `path.resolve` 得到 `D:\mnt\c\...` / `D:\c\...`，判定在工作区外并拒绝。
3. 模型对这次被拒绝的调用请求 `request_permission`，`scope` 为 `full`，用户点「允许一次」。
4. 或者：工作区内已有 junction/目录符号链接（非提升用户可用 `mklink /J`；workspace 档的沙箱 cmd 对工作区有 Modify，本身就能建 junction），`write`/`edit` 的 `path` 指向该链接下的文件名。闸门 realpath 后拒绝；用户仍对这条原始路径给予 `full`。
**期望行为**：升权要么拒绝，要么只打开闸门 realpath 之后的那个目标；`/mnt/c/...` 不得写成 `C:\...`；链接不得跟随到授权路径之外。`workspace` 范围的升权应继续失败。
**实际行为**：`evaluateToolCallGate` 在 `widenPreset == "full"` 时直接放行，不再调用 `permissionDenial`。`createConfinedFileOperations` 看到升权后的 `full`，对 SDK 已解析的绝对路径执行宿主 `fs.writeFile`（跟随 reparse point）。Node 24 对上述 MSYS 路径的结果：`path.resolve(cwd, "/mnt/c/Users/Public/x.txt")` 为 `D:\mnt\c\Users\Public\x.txt`，而 SDK `normalizeWindowsShellPath` 得到 `C:\Users\Public\x.txt`。`workspace` 范围会在 `operations.writeFile` 里用后者再跑 `judgeWritePath`，从而拒绝；`full` 范围没有这第二步。动作键仍是原始 JSON，不能换成另一条命令字符串，但同一次调用的落点可以越出闸门算过的路径。
**证据**：
```ts
// src/lib/confined-file-operations.ts:57-60
if (preset === "full") {
  if (operation === "mkdir") await fs.mkdir(target, { recursive: true });
  else await fs.writeFile(target, content ?? "", "utf8");
  return;
}
```
```ts
// src/lib/agent-manager.ts:1869-1871
const escalatedDenial = escalatedPreset === "full"
  ? undefined
  : await permissionDenial({ ...gateRequest, preset: escalatedPreset });
```
```ts
// src/lib/permission-gate.ts:49-56  —— 不识别 /mnt/c、/c、/cygdrive/c
if (/^file:/i.test(cleaned)) return fileURLToPath(cleaned);
...
return path.resolve(cwd, expanded);
```
SDK `dist/utils/paths.js` 的 `normalizeWindowsShellPath`（约 90-98 行）把以 `/` 开头、无反斜杠的 `/mnt/<drive>`、`/cygdrive/<drive>`、`/<drive>` 收成 `X:\...`，`resolveToCwd` 在 `write.js` / `edit.js` 里先于 `operations.writeFile` 调用。批准文案（`permission-request-tool.ts:78`）只拼接原始 `permissionActionDescription`，不含 `verdict.resolved`。
**修复建议**：`full` 升权也必须先把 SDK 最终绝对路径再送进 `judgeWritePath`（或与闸门共用同一规范化函数，含 MSYS 与 `file:`），并且只允许打开 realpath 之后、且与批准时展示的解析路径相同的目标。宿主写入改用已打开且校验过的句柄，或继续放进 AppContainer；不要对未钉住的路径调用 `fs.writeFile`。批准卡展示解析后的路径。
**最小失败测试**：工作区 `D:\AIApp\PiWeb`，档位 `workspace`。`write` 路径 `/mnt/c/Users/Public/piweb-pwn.txt`。断言未批准时文件不存在。对这次拒绝做 `scope:"full"` 并批准。断言不得创建 `C:\Users\Public\piweb-pwn.txt`。另：`mklink /J escape C:\Users\Public` 后，对 `escape\piweb-pwn.txt` 做同样的 `full` 批准，断言 `C:\Users\Public\piweb-pwn.txt` 不被创建。

### [HIGH] src/lib/sandbox/windows-acl.ts:333
**问题**：AppContainer 子进程的令牌只加了 `SANDBOX_INERT`，没有删除特权。父进程若已提升，子进程保留 `SeBackupPrivilege` / `SeRestorePrivilege` 等，只读档的 bash 可以改工作区（以及工作区外）的 DACL 或用备份语义直接写。
**触发条件**：PiWeb 进程令牌是提升后的管理员令牌（从提升的终端启动）。`readonly` 或 `workspace`，沙箱可用。模型执行 bash，在子进程里 `AdjustTokenPrivileges` 打开上述特权，再对工作区文件 `SetNamedSecurityInfo` 或带 `FILE_FLAG_BACKUP_SEMANTICS` 的 `CreateFile` 写入。
**期望行为**：受限令牌在 `CreateRestrictedToken` 时删除全部特权（至少删除 Backup/Restore/TakeOwnership/Debug/Impersonate/AssignPrimaryToken）。只读子进程对工作区的写与改 DACL 失败。
**实际行为**：`CreateRestrictedToken(token, 0x1, 0, null, 0, null, 0, null, ...)` 不禁用 SID、不删除特权、不设置 restricting SID。作业对象只设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（`windows-acl.ts:461`），不限制特权。只读根上的 ACE 是 `0x1200A9`（读+执行，`windows-acl.ts:146`），挡的是普通 DesiredAccess，挡不住 Restore/Backup 语义。本审查没有在提升令牌下把这条命令跑完。
**证据**：
```ts
// src/lib/sandbox/windows-acl.ts:331-333
check(OpenProcessToken(GetCurrentProcess(), 0xf01ff, original), "OpenProcessToken");
try {
  check(CreateRestrictedToken(pointer(original), 0x1, 0, null, 0, null, 0, null, restricted), "CreateRestrictedToken");
```
`0x1` 仅为 `SANDBOX_INERT`。同一函数未调用 `AdjustTokenPrivileges` 清空特权，也没有 `DisableAllPrivileges` 一类参数（`privilegeCount` 为 0）。
**修复建议**：`CreateRestrictedToken` 时删除令牌上的全部特权，或在 `CreateProcessAsUser` 之前把特权属性全部置为禁用且不可再启用。为提升与非提升各加一条只读 bash 写工作区文件的测试。
**最小失败测试**：提升的 `node` 宿主，`readonly` + 沙箱可用。只读 bash 内启用 `SeRestorePrivilege` 后向工作区已有文件写入一个标记字节。断言写入失败且文件哈希不变。

### [MEDIUM] src/lib/permission-gate.ts:189
**问题**：`readonly` / `workspace` 把 MCP（以及任何带 `readOnlyHint === true` 的非变更工具）放行到宿主进程。提示来自工具自身，闸门不核对实现是否写盘。
**触发条件**：已配置的 MCP 工具注解 `readOnlyHint: true`，但实现会写文件或调用外部写接口。`readonly` 会话调用该工具。`presetAllowsTool`（`src/lib/pi.ts:545-547`）对非 `full` 档对所有 `mcp__*` 返回真；闸门只在提示不是 `true` 时拒绝。
**期望行为**：只读档不因服务器自报的布尔值在宿主里执行可能写盘的工具；要么不加载，要么放进与 bash 相同的不可写 AppContainer。
**实际行为**：`readonly` 下非 MCP 的变更工具名被拒绝；MCP 仅当 `readOnlyHint !== true` 才拒绝（`permission-gate.ts:189-195`）。提示为 `true` 时返回 `undefined`，工具以宿主身份执行，不经 `createConfinedFileOperations`。
**证据**：
```ts
// src/lib/permission-gate.ts:180-195
if (preset === "readonly") {
  if (toolName === "bash" && shellAvailable) return undefined;
  if (MUTATING_TOOL_NAMES.has(toolName)) {
    return { block: true, reason: ... };
  }
  if (isMcp && readOnlyHint !== true) {
    return { block: true, reason: ... };
  }
  return undefined;
}
```
```ts
// src/lib/agent-manager.ts:1894
const presetAllowed = presetAllowsTool(effectivePreset, name) || m.session?.getToolDefinition?.(name)?.annotations?.readOnlyHint === true;
```
**修复建议**：不要把 `readOnlyHint` 当作安全边界。只读档默认拒绝 MCP；工作区档对未证明只读的 MCP 同样拒绝，或在不可写沙箱里跑。
**最小失败测试**：注册一个 `readOnlyHint: true` 且 `writeFile` 到工作区外的 MCP 工具。`readonly` 会话调用它。断言调用被拒且目标文件不存在。

### [QUESTION] src/lib/sandbox/windows-acl.ts:220
**问题**：受限档的 shell 固定为 `cmd.exe /d /s /c`。`start` 对非可执行文件走 `ShellExecuteEx`，AppContainer 里可能被 shell broker 拉到容器外、以用户令牌启动。本仓库没有调用点证明 broker 会这么做，也没有反证。
**触发条件**：若 Windows 对 LPAC 内的 `cmd /c start ...` 使用容器外 broker：只读或 workspace bash 执行 `start` 一个可写文件的关联程序，或 `start cmd.exe`。
**期望行为**：子进程及其后代保持同一 AppContainer 与作业对象；`ShellExecute` 失败或仍在容器内。
**实际行为**：命令行是 `quoteArgument(shell.path) + ' /d /s /c "' + command + '"'`（`windows-acl.ts:220`）。进程创建属性含 AppContainer 与 LPAC opt-out，但没有禁止 `ShellExecute` 的策略。命令里的引号也未转义，只能多跑容器内命令，本身不是出箱。
**证据**：`src/lib/sandbox/bash-operations.ts:42` 与 `:118` 把 script shell 换成 `cmd.exe`；`windows-acl.ts:217-220` 用 `/c` 包裹未转义的命令文本。
**修复建议**：不要用 `cmd.exe` 作为能力边界；若必须用，拒绝 `start` / `ShellExecute` 一类命令，或换不会调用 shell broker 的启动器。补一条只读 bash `start` 后父进程外是否出现同名非 AppContainer 进程的测试。
**最小失败测试**：只读沙箱执行 `cmd /c start /wait notepad`（或一个会写标记文件的关联程序）。断言没有容器外进程，且工作区与用户目录没有新文件。未跑，故不升格。

### [QUESTION] src/lib/sandbox/windows-acl.ts:500
**问题**：包目录 ACL 在 `ResumeThread` 之前收紧。若 AppContainer 在线程恢复后才创建 `AC\Temp\...`，新目录会带默认的包 SID 完全控制，只读 bash 能写包目录（不是工作区）。代码注释认为 provision 发生在恢复之前，没有后置复核。
**触发条件**：只读沙箱里第一次访问临时目录时，系统在 `denyProfile` 之后创建子目录。
**期望行为**：只读进程对包目录及其后创建的子目录都没有写权限。
**实际行为**：`denyProfile` 在 `CreateProcessAsUser` 返回后、`ResumeThread` 之前跑一次（`windows-acl.ts:500-504`）。`writableTemp` 在只读模式为假（`createAclSandbox` 把 `writableDirs.length > 0 && tempDir !== null` 传给后端，只读两者皆空）。已存在的目录被设成 `0x1200A9`。恢复之后新建的目录不会再走 `denyProfile`。
**证据**：
```ts
// src/lib/sandbox/windows-acl.ts:500-504
// AppContainer startup provisions protected Temp subdirectories. Reapply
// the deny after provisioning, while no child instruction has run.
denyProfile(path.dirname(profilePath!));
check(AssignProcessToJobObject(job, child), "AssignProcessToJobObject");
check(ResumeThread(thread) !== 0xffffffff, "ResumeThread");
```
**修复建议**：子进程启动并完成已知的目录 provision 之后、执行用户命令之前再扫一次包目录；或对包根加不可继承的拒绝写 ACE。用只读 bash 写 `%LOCALAPPDATA%\Packages\<profile>\Temp` 做负向测试。
**最小失败测试**：只读 bash 将标记写入包 Temp。断言失败。未跑，故不升格。

## 覆盖清单

| 目标 | 结果 |
| --- | --- |
| `src/lib/sandbox/windows-acl.ts` `manager.ts` `bash-operations.ts` `config.ts` | 已读全文 |
| `src/lib/permission-gate.ts` `permission-action.ts` `permission-audit.ts` `permission-request.ts` `permission-request-tool.ts` | 已读全文 |
| `src/lib/confined-file-operations.ts` `read-file-bounded.ts` `recoverable-remove.ts` `recycle-temporary.ts` `atomic-file.ts` `api-error.ts` `public-diagnostic.ts` | 已读全文 |
| `src/lib/agent-manager.ts` 升权、`tool_call`、`guardToolExecution`、自定义 write/edit/bash、用户 `!` | 已读对应段 |
| `src/lib/pi.ts` `TOOL_PRESETS` / `presetAllowsTool` | 已读 |
| SDK `write.js` `edit.js` `bash.js` `path-utils.js` `utils/paths.js` `agent-loop.js` `agent-session.js`（工具覆盖与 `tool_call`） | 已读调用链 |
| Node 24.12.0 `path.win32.resolve` 与 `fileURLToPath` | 只读探针，未写盘 |

## 未追踪

1. 未在真实 AppContainer 里执行只读/工作区 bash 或 `write`（含提升令牌与 junction）。
2. SDK 的 read/grep/find/ls 是否限制读取路径（写闸门不管读）。
3. 扩展进程内直接 `fs`（闸门注释已声明同进程扩展不是边界）；未逐个扩展审计。
4. `recoverable-remove` / `recycle-temporary` 的全部调用方是否只传入可信路径（读了定义、`files-service` / `skills-service` / 导出回收的调用，未追完每个参数来源）。
5. `koffi` 结构体布局未对照调试器；`EXPLICIT_ACCESS_W` / `STARTUPINFOEXW` 仅按公开 x64 布局核对。

未追踪数量：5。

## 各维度结论

1. **write/edit 的 `file://` 未批准越界写**：未发现问题。`resolveModelPath`（`permission-gate.ts:49`）与 SDK `normalizePath` 的 `file://` 都走 `fileURLToPath`。工作区档在 `operations.writeFile` 上再判一次。探针：`file:///C:/Windows/win.ini` 与 `FILE:///C:/Windows/win.ini` 都得到 `C:\Windows\win.ini`，闸门判外。`file:/C:/...`（单斜杠）在 `full` 宿主写入时 SDK 不认，落成工作区内的怪异文件名，不是写出工作区。
2. **只读档写工作区（旧的 Low 强制标签）**：未发现仍靠磁盘 Low 标签。只读 `writableDirs` 为空，可读根与 scratch 为 `0x1200A9`，包目录在启动前被收成 RX。普通 CreateFile 写工作区应失败。提升令牌保留特权见 HIGH `windows-acl.ts:333`。包 Temp 延迟创建见 QUESTION `windows-acl.ts:500`。
3. **一次性升权是否绑定动作**：命令字符串已绑定。`permissionActionKey` 覆盖工具名与完整参数；`guardToolExecution` 在执行前比对并 `clearEscalation`；bash 的 `consumeEscalation` 还比对前缀之后的命令文本，不匹配则不开 `local.exec`。不能把已批准的命令换成另一条命令。`full` 范围不对解析后的路径再检查，见 HIGH `confined-file-operations.ts:57`。
4. **`realpathLoose` 非 ENOENT**：未发现问题。`permission-gate.ts:72` 非 `ENOENT` 即抛；`judgeWritePath` 的 `catch`（132-133 行）返回 `inside: false`。`EACCES` / `ELOOP` / `ENOTDIR` 是拒绝，不是放行。
5. **junction / 符号链接 TOCTOU**：未发现工作区档能把竞态变成成功的越界写。检查与 `runNode` 之间父目录仍可被换成 junction，但写入发生在 AppContainer 内，打开的是目标对象的 DACL；未授予的目标没有包 SID 的写 ACE。Windows 路径没有 Linux `linuxOperation` 那种 `O_NOFOLLOW` 目录句柄（`confined-file-operations.ts:66` 仅 linux）。`full` 升权不在沙箱内，见 HIGH。
6. **硬链接把工作区外文件写进来**：未发现模型单独能完成。`judgeWritePath` 对 `nlink > 1` 拒绝（`permission-gate.ts:131`）；沙箱脚本 `lstat` 同样拒绝；工作区根扫描到硬链接则不建沙箱（`windows-acl.ts:110`）。`write`/`edit` 用临时文件 `rename` 替换目录项，不原地写共享数据。已存在且没有包 SID ACE 的文件，沙箱也打不开来写。沙箱没有工作区外目录的 `FILE_ADD_FILE`，不能自行把硬链接名建到区外。
7. **闸门是否接上**：已接上。`sessionCustomTools` 用带 `createConfinedFileOperations` 的 write/edit 和 `createSandboxBashOperations` 的 bash 覆盖同名内置工具（SDK `agent-session.js` 后注册的 custom 工具覆盖 builtin）。`tool_call` 调用 `evaluateToolCallGate`，`guardToolExecution` 在真正 `execute` 时再查一次。codemode 走 WASM，嵌套 `executeTool` 仍经 `beforeToolCall`。用户 `!`（`agent-manager.ts:3042` 的 `runUserBash`）在没有 `user_bash` 钩子时使用 `createLocalBashOperations`，不受沙箱约束；代码写明这是用户命令而不是模型工具。同一用户可以改档位，未单列为模型越界。
8. **`realpath` / 额外可写根 / 原子替换 / 回收**：`additionalWritableRoots` 拒绝非绝对路径、不存在路径和 realpath 与输入不一致的链接根。`atomic-file.ts` 只重试 `rename`。`recycle-temporary.ts` 限制在 `os.tmpdir()` 下且目录名以 `piweb-export-` 开头，PowerShell 单引号转义。`recoverable-remove.ts` 对符号链接只重建链接或改名，不把回收遍历进链接目标。`api-error.ts` / `public-diagnostic.ts` 对非校验错误只回固定文案。这些路径上未发现新的写越界。
