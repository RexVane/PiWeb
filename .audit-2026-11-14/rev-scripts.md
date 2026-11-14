# rev-scripts 静态审查

对象：工作区相对 `1d4efba9054909cd9c8b2788028ce704c99b03ea` 的未提交改动。只读 diff / 源码；未跑 npm、vitest、build，未改 git 状态。

## 发现

### [HIGH] scripts/launcher.mjs:118-123
**问题**： Windows 上启动令牌被发给未经验明的命名管道。另一本地用户可先占用管道，在启动器“确认令牌”时收到受害者的启动令牌，再用本机回环换到会话 Cookie。
**触发条件**： Windows；攻击者在 PiWeb 监听前创建 `\\.\pipe\piweb-launch-<hash>`（hash 为 `sha256(小写 realpath(agentDir):port)` 的前 32 位十六进制，默认 agent 目录是 `~\.pi\agent`，端口从 30141 起最多试 50 个）；受害者随后启动或再次打开已有实例，且认证开启。攻击者不必读到 `web-launch\<port>.token`（用户配置目录 ACL 通常不给其他用户），也不必先占住 TCP 端口。
**期望行为**： 只把启动令牌交给本用户持有的端点；管道应有仅创建者可连接的 DACL。占用失败时不得把文件里的令牌写到那个名字上。
**实际行为**： `readCurrentLaunchToken` 先读令牌文件，`connect` 一成功就 `socket.write(JSON.stringify({ token }))`，不核对对端身份。服务端 `src/lib/web-launch-token.ts:119` 只在非 Windows 上 `chmod 0600`；`:122-129` 的 `EADDRINUSE` 恢复也只在非 Windows 进行。Windows 上管道被占则 IPC 服务器放弃，但令牌文件已经写好（同文件 `:171-178` 先写文件再 listen）。启动器在健康检查之后仍会连接该管道（`scripts/launcher.mjs:556-557` 与 `:605-607`）。本机其他用户可以连 `127.0.0.1:<port>/?token=`（Windows 回环不按用户隔离）。
**证据**：
```118:123:scripts/launcher.mjs
const socket = net.connect(launchTokenIpcPath(agentDirOf(env), String(port)));
...
socket.once("connect", () => socket.write(`${JSON.stringify({ token })}\n`));
```
```10:12:scripts/web-auth-protocol.mjs
return process.platform === "win32"
  ? `\\\\.\\pipe\\piweb-launch-${createHash("sha256").update(`${root}:${port}`).digest("hex").slice(0, 32)}`
  : path.join(root, "web-launch", `${port}.socket`);
```
```117:131:src/lib/web-launch-token.ts
const ready = () => {
  server.unref();
  if (process.platform !== "win32") { try { fs.chmodSync(endpoint, 0o600); } catch { /* ... */ } }
};
server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && process.platform !== "win32" && !recovering) { /* recover */ }
  else if (ipcServers.get(endpoint) === server) ipcServers.delete(endpoint);
});
server.listen(endpoint, ready);
```
**修复建议**： Windows 管道用仅当前用户 SID 的 DACL 创建；listen 失败就不要再向该名字发送令牌。或改为只读令牌文件（文件已在用户配置目录），IPC 刷新改成服务器单向、客户端不送出令牌。
**最小失败测试**： 用另一个本地账号 `CreateNamedPipe(\\.\pipe\piweb-launch-<预计算 hash>)` 并读第一行；受害者账号 `node bin/piweb.js`（认证默认开）。断言管道上收到 `{"token":"..."}`，且该令牌对 `GET /?token=` 返回 303 并带 `piweb_session_`。

### [HIGH] scripts/launcher.mjs:407-410
**问题**： Windows 用 `cmd.exe /d /c start` 打开登录 URL。`normalizePublicUrl` 去掉了查询串、片段和 userinfo，但路径里的 cmd 元字符原样进入未加引号的参数。
**触发条件**： Windows，未加 `--no-open`，`--public-url` 或 `PI_WEB_PUBLIC_URL` 的路径含 `&`、`|`、`<`、`>` 或 `^`（例如 `http://example.com/a&calc.exe`）。默认本机 URL 和 base64url 令牌不会触发：主机名被 `normalizeHostname` 限制，令牌经 `encodeURIComponent`。
**期望行为**： URL 只作为 CreateProcess 的一个 argv 交给浏览器，或先拒绝含 cmd 元字符的对外地址。`cmd /c` 会重新解析命令行，Node 仅在参数含空格或 `"` 时才加引号，`&` 不会被引用。
**实际行为**： 命令行等价于 `cmd.exe /d /c start "" http://example.com/a&calc.exe/?token=...`。`&` 后的程序被执行。`start` 的空标题参数不能挡住后续元字符。
**证据**：
```58:72:scripts/launcher.mjs
export function normalizePublicUrl(value) {
  ...
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}
```
```407:410:scripts/launcher.mjs
const command = process.platform === "win32" ? "cmd.exe" : ...
const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
```
调用点把 `tokenLoginUrl(options.publicUrl ?? url, token)` 交给 `openBrowser`（`:504-505`、`:557`）。
**修复建议**： Windows 用 `explorer.exe` 或 ShellExecuteEx 直接传 URL，不要经 `cmd /c`。在此之前拒绝 `/[&|<>^%\r\n]/` 出现在序列化后的 href 里。
**最小失败测试**： `node bin/piweb.js --public-url "http://127.0.0.1/a&notepad.exe"`，断言启动的是 notepad 而不是仅打开浏览器。URL 用 `http://127.0.0.1/a%26notepad.exe` 应被拒绝或保持为单个 argv。

### [MEDIUM] scripts/file-lock.mjs:19-37
**问题**： 锁一旦损坏或回收互斥目录残留，就永久无法再获取。`writeFileSync` 会先截断锁文件；不完整 JSON 被当成不可恢复。
**触发条件**： 持锁进程在 `childStarted` / `updateMetadata` / `trackLockChild` 的 `writeFileSync` 期间被 TerminateProcess 或断电；或在 `mkdir(file + ".recovery")` 成功之后、`finally` 的 `rmdirSync` 之前被杀掉（Windows 上杀毒/索引把刚建的空目录占住，也会让 `rmdirSync` 抛错并留下目录）。之后任意 `acquireFileLock`（`install-build` 的 `update.lock`、启动器的 `instance.lock`、`release.mjs` 的同一把锁）。
**期望行为**： 属主已死且锁文件不可解析，或 `.recovery` 没有活进程，应能清掉并重建。截断写入不能把锁永久钉死。
**实际行为**： `:23` 解析失败直接抛 `lock is incomplete`，不删除锁。`:20` 上 `.recovery` 已存在则一律抛“已在运行”，没有陈旧目录的回收。`:37` 和 `:51` 用 `writeFileSync` 覆盖，崩溃窗口里文件是空的或半截 JSON。`processAlive` 对非安全整数返回 `undefined`，而 `:24` 用 `!== false`，所以 `children` 里一旦混入非整数也会永远占锁；`trackLockChild`（`:48-51`）不像 `childStarted`（`:36`）那样过滤 `Number.isSafeInteger`。
**证据**：
```19:27:scripts/file-lock.mjs
const recovery = `${file}.recovery`;
try { fs.mkdirSync(recovery); } catch { throw new Error(`an update/build or instance is already running (${file})`); }
try {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`lock is incomplete; verify its owner before retrying (${file})`); }
  if (processAlive(owner.pid) !== false || (owner.children ?? []).some((pid) => processAlive(pid) !== false)) throw ...
  fs.unlinkSync(file);
  create();
} finally { fs.rmdirSync(recovery); }
```
```33:37:scripts/file-lock.mjs
release.childStarted = (pid) => {
  ...
  fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
};
```
未发现 Node 22 在 Windows 上把 `process.kill(pid, 0)` 的“进程不存在”报成非 `ESRCH` 的证据；死进程误判不是本条依据。
**修复建议**： 元数据用临时文件 + `rename` 覆盖，不要截断原文件。解析失败且 `processAlive` 明确为 false（或无 pid）时删除锁。`.recovery` 若存在，只在其内没有活 pid 标记时删除，或给回收目录写属主 pid 并同样走 `processAlive`。
**最小失败测试**： 取得锁后把锁文件截成空文件并杀掉持锁进程，再次 `acquireFileLock` 应成功。另：创建 `lock.recovery` 空目录、锁文件里 pid 为已退出进程，再次获取应成功而不是抛“already running”。

### [MEDIUM] scripts/http-request-guard.mjs:94-115
**问题**： 在途字节预算按声明的 Content-Length 预留，但真正计数只和路由上限比。声明长度小于实际上限时，预算可以被绕开。
**触发条件**： 已认证请求（上传路径还要 Cookie；公开路由上限只有 64KiB，不构成同样的问题）携带 `Content-Length: 0`（或任一小于上限的合法长度）并继续发送 body，直到 `limit`（普通 12MiB，上传 101MiB）。并发仍受 `inflightRequests >= 32` 限制。
**期望行为**： 预留量至少等于将要接受的最大字节；声明长度小于已读字节时应按 400 断开，而不是继续读到路由上限。
**实际行为**： `length = Number(rawLength)` 为 0 时 `reservedBytes` 不加，`:98` 的 `maxInflightBytes`（128MiB）检查通过。`:114-115` 仍把数据块送到 `received > limit` 才拒绝。32 个上传可各送约 101MiB，而预算以为是 0。
**证据**：
```94:100:scripts/http-request-guard.mjs
const rawLength = req.headers["content-length"];
...
const length = rawLength === undefined ? limit : Number(rawLength);
if (length > limit) return reject(...);
if (reservedBytes + length > maxInflightBytes || inflightRequests >= 32 || ...) return reject(...);
reservedBytes += length;
```
```112:116:scripts/http-request-guard.mjs
if (event === "data") {
  received += args[0].length;
  if (received > limit) { reject(...); return false; }
}
```
无 Content-Length 时 `length = limit`，预算是保守的，那条路径没有这个问题。
**修复建议**： 有 Content-Length 时 `received` 不得超过该长度；预留用 `min(声明, limit)` 且声明为 0 又出现 data 则直接 400。或者只要接受 body 就按 `limit` 预留。
**最小失败测试**： 一个已登录客户端发 `POST /api/health`，`Content-Length: 0`，正文 1MiB。断言连接在第一个 data 块被 400 掐掉，且 32 个这样的请求不能同时把进程堆到数百 MiB。

### [MEDIUM] scripts/install-build.mjs:199-202
**问题**： 安装构建提升 `active.json` 没有 `fsync`。掉电后选择器把损坏的清单当成致命错误，不会退回仍在磁盘上的上一份构建。
**触发条件**： `buildInStaging` 已通过 `readProductionBuild`，`writeFileSync(temporary)` 返回但页面缓存未落盘，随后 `renameSync` 把临时文件换成 `.next-releases/active.json`，然后断电或强杀。`release.mjs` 的 `atomicJson`（`:48-54`）有 `handle.sync()`，这条安装路径没有。
**期望行为**： 要么看到完整的旧 `active.json`，要么看到完整的新清单。清单损坏时应继续使用上一份 `state:"ready"` 的构建，而不是拒绝启动。
**实际行为**： 提升前不会改已有 `active.json`（失败路径本身不回滚指针，这点是对的）。提升本身是同目录 `rename`，但临时文件未 fsync。`selectProductionBuild`（`scripts/build-output.mjs:226`）在 `JSON.parse` 失败时直接抛 `invalid release manifest`，不会读 `previous`，也不会扫其他 release 目录。`install-build` 成功清单也不写入 `previous`。
**证据**：
```199:202:scripts/install-build.mjs
const temporary = `${active}.${randomUUID()}.tmp`;
fs.writeFileSync(assertLocalPath(root, `${buildDir}.owner.json`), JSON.stringify({ schema: 1, buildDir, state: "ready" }));
fs.writeFileSync(temporary, JSON.stringify({ schema: 1, state: "ready", ...build, finishedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
fs.renameSync(temporary, active);
```
```224:226:scripts/build-output.mjs
if (raw !== undefined) {
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error("invalid release manifest; run npm run build:release"); }
```
对比 `scripts/release.mjs:50-54`：`writeFile` 之后 `handle.sync()` 再 `rename`。
**修复建议**： 安装路径复用 `atomicJson`（写、sync、rename）。`selectProductionBuild` 在 JSON 损坏时，若目录里仍有带清单且 `readProductionBuild` 通过的 release，应继续用它，而不是只抛错。
**最小失败测试**： 把 `active.json` 换成 0 字节，旁边留下一份能通过 `readProductionBuild` 的 `.next-releases/<id>`。断言 `selectProductionBuild` 仍返回该 id，而不是抛 `invalid release manifest`。

### [MEDIUM] bin/pi.js:22-32
**问题**： `pi` / `pi web` 在 spawn 失败时可能不退出；Unix 上只给直接子进程发信号，不收进程树。Windows 上 `taskkill` 非零退出被当成已经杀掉。
**触发条件**： 1) `process.execPath` 或目标脚本无法 spawn（ENOENT/EACCES），且运行时只发 `error` 不发 `exit`（Node 文档：error 之后 exit 不一定发生）。2) Unix 上对 `bin/pi.js` 的 pid 发 SIGTERM，子进程还有孙进程（`pi` 转发给 coding-agent，agent 会起 shell）。`bin/pi.js` 的 spawn 没有 `detached`，所以不能用 `kill(-pid)`。3) Windows 上 `taskkill /T /F` 退出码非 0（pid 已退出但子进程还在，或权限不足），`process-runner.mjs:15` 只听 `close`。
**期望行为**： spawn 失败应非零退出。停止信号应结束该命令启动的整棵树。`taskkill` 失败要退回到已知的杀进程手段并向上报告，不能把非零退出当成成功。
**实际行为**： `child.once("error")` 只设置 `process.exitCode`，不 `process.exit`，也没有超时。Unix 分支 `child.kill(signal)` 只打到直接子进程。`terminateProcessTree` 在 Windows 上 `killer.once("close", done)` 不看退出码；`error` 才 `child.kill()`，而 `child.kill()` 同样不杀孙进程。
**证据**：
```22:32:bin/pi.js
function supervise(child) {
  const stop = (signal) => { if (process.platform === "win32") void terminateProcessTree(child); else child.kill(signal); };
  ...
  child.once("error", (error) => { console.error(...); process.exitCode = 1; });
  child.once("exit", (code) => { ... process.exitCode = code ?? 1; });
}
```
```10:16:scripts/process-runner.mjs
const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
const timer = setTimeout(() => { child.kill(); killer.kill(); resolve(); }, 10_000);
const done = () => { clearTimeout(timer); resolve(); };
killer.once("error", () => { child.kill(); done(); });
killer.once("close", done);
```
启动器自己的 Next 子进程在 Unix 上是 `detached: true`（`scripts/launcher.mjs:533`），SIGINT 走 `kill(-child.pid)`，这条不适用于 `bin/pi.js`。
**修复建议**： `error` 里 `process.exit(1)`。Unix 的 `pi` 子进程用 `detached: true` 再 `kill(-pid)`，或给整棵树单独的 job/group。`taskkill` 的 `close` 在 code 非 0 且子进程仍活着时不要 resolve 成成功。
**最小失败测试**： `spawn` 一个不存在的 `execPath`（把 `supervise` 的 spawn 换成缺失文件），断言父进程在 1 秒内以非零退出，而不是只把 `exitCode` 放着继续挂起。Windows：让 `taskkill` 立刻以退出码 1 结束，断言孙进程被杀掉或停止函数 reject。

### [MEDIUM] scripts/apply-global.mjs:40-71
**问题**： 全局安装的 `src/` 先被就地覆盖，构建失败时不会把源码退回去。`active.json` 只在 `ensureInstallBuild` 成功时替换，所以“构建失败保留旧构建”不覆盖已经写进去的源码。
**触发条件**： `node scripts/apply-global.mjs`（默认目标 `D:\NodeJs\node_modules\@rexvane\piweb`，或 `--out`）在 `walk` 复制了一部分或全部 `src/` 之后，`ensureInstallBuild(OUT, { force: true })` 失败或进程被杀掉。
**期望行为**： 源码与新 release 一起提交；失败时目标目录的 `src/` 仍是复制前的树。
**实际行为**： `:40-60` 直接 `copyFileSync` 到安装目录。`:67-70` 构建失败只打印“原有完整构建已保留”并以状态 1 退出，没有源码备份或回滚。下一次在该目录里构建会用到混在一起的源码。
**证据**：
```51:70:scripts/apply-global.mjs
const from = path.join(SRC, "src", child);
const to = path.join(OUT, "src", child);
...
fs.copyFileSync(from, to);
...
const status = ensureInstallBuild(OUT, { force: true });
if (status !== "built") {
  console.error("重建失败，原有完整构建已保留。");
  process.exit(1);
}
```
**修复建议**： 复制到临时目录（或与 `install-build` 的 staging 一样只在 staging 里改 src），构建并提升 `active.json` 成功后再替换安装目录的 `src/`。失败删除临时副本。
**最小失败测试**： 准备一份与仓库版本相同的假安装目录，让 `ensureInstallBuild` 返回 `failed`（例如去掉 next）。断言运行后目标 `src` 的文件哈希与运行前一致。

### [QUESTION] scripts/process-runner.mjs:30-31
**问题**： Windows 上 `command === "npm"` 时经 `cmd.exe /d /c` 再解析参数，且没有 `/s`，也没有把整条命令收进一对引号。参数里的 `&|<>^` 会变成新命令。
**触发条件**： 当前仓库调用点不满足。`release.mjs` 的 npm 参数是固定的 `run check` / `run sync:provider-icons`；`pi-packages.mjs` 把 registry 输出先交给 `exactRegistryVersion`（严格 semver）再拼进 `npm install`。没有调用点把用户字符串放进 npm argv。`cwd` 走 `spawn` 的 `cwd` 选项，不进命令行。
**期望行为**： 即使参数以后变成外部输入，也不要让 cmd 重新分词。应直接 spawn `npm.cmd` 的绝对路径，或使用 Node 自带的 `npm-cli.js`。
**实际行为**： 函数本身会把未加引号的元字符交给 cmd。`env.ComSpec`（`isolatedCommandEnv` 允许该变量）决定 cmd 可执行文件；这要求调用前环境已被人控制，不单列。
**证据**：
```29:32:scripts/process-runner.mjs
// Only npm needs cmd.exe to resolve npm.cmd. Never enable a general shell.
const npmShell = process.platform === "win32" && command === "npm";
const child = spawn(npmShell ? env.ComSpec || "cmd.exe" : command, npmShell ? ["/d", "/c", "npm", ...args] : args, {
```
**修复建议**： 与 `verify-package.mjs` 的 `npm_execpath` 分支一样，用 `process.execPath` 跑 `npm-cli.js`。不要把 npm 参数交给 `cmd /c`。
**最小失败测试**： 目前没有能失败的仓库内调用。若要锁住回归：`runCommand("npm", ["view", "x&notepad"], { cwd })` 在 Windows 上不得启动 notepad。

### [QUESTION] scripts/verify-package.mjs:37-41
**问题**： 找不到 `npm-cli.js` 时，Windows 使用 `spawnSync(..., { shell: true })`。Node 会把参数拼成 `cmd /d /s /c "<整条命令>"`。参数里的 `"` 可以跳出这层引号。
**触发条件**： 未设置 `npm_execpath`，且 `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js` 不存在（官方 Node 安装通常存在，这条是退路），并且某个参数含 `"`。当前包名 `@rexvane/piweb` 和 `os.tmpdir()` 下的 `piweb-verify-*` 路径在常见布局里没有 `"`。空格会被外层引号包住，单独的空格不够。
**期望行为**： 永远不要对带路径的 npm 参数开 `shell: true`。
**实际行为**： 退路仍开着。本次 diff 把 `OFFICIAL_REGISTRY_ARGS` 和 tarball 绝对路径放进同一组参数，但没有新增含引号的参数。
**证据**：
```37:41:scripts/verify-package.mjs
function runNpm(args, options) {
  const cli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
    .find((file) => file?.endsWith(".js") && fs.existsSync(file));
  if (cli) return run(process.execPath, [cli, ...args], options);
  return run("npm", args, { ...options, shell: process.platform === "win32" });
}
```
**修复建议**： 找不到 cli 就失败，不要开 shell。
**最小失败测试**： 在没有 `npm-cli.js` 的 Windows 布局上，把 tarball 路径设成含 `"` 的临时目录，断言不会执行引号外的命令。当前环境不具备该布局，所以标 QUESTION。

## 覆盖

已读并按注入、spawn/孤儿、`active.json`、发布、file-lock、CI 核对：

- 未跟踪：`scripts/build.mjs`、`file-lock.mjs`、`http-request-guard.mjs`、`remote-engine.mjs`、`update-environment.mjs`、`web-auth-protocol.mjs`、`testing/check-skips.mjs`，以及三个 `.d.mts`（只有类型，无运行时）
- 已改：`launcher.mjs`、`process-runner.mjs`、`install-build.mjs`、`build-output.mjs`、`release.mjs`、`apply-global.mjs`、`verify-package.mjs`、`runtime/check-installed.mjs`、`runtime/pi-packages.mjs`
- 同目录其余脚本：`dev.mjs`、`entrypoint.mjs`、`postinstall.mjs`、`system-proxy.mjs`、`pick-folder.ps1`、`sync-provider-icons.mjs`、`sync-file-icons.mjs`、`testing/prepare-sdk-tools.mjs`（后两者无 shell；`sync-file-icons.mjs:109` 用清单里的 `iconPath` 做 `path.join`，本次 diff 未改该文件，清单不在本次锁文件变更的攻击面上，不单列）
- `bin/pi.js`、`bin/piweb.js`（只转调 launcher）
- `.github/workflows/check.yml`、`publish.yml`、`remote-e2e.yml`
- `next.config.ts`、`package.json`、`vitest.config.ts`
- `package-lock.json`：只统计 diff 里的 `resolved` / `integrity`，未通读全文

为确认管道抢占的服务端行为，读了范围外的 `src/lib/web-launch-token.ts` 和 `src/lib/remote/supervisor.ts`（谁 spawn `remote-engine.mjs`）、`src/proxy.ts`（应用层认证是否另有一层）。未把 `src/` 当审查范围逐文件过。

## 未追踪

无。范围内脚本和列出的 CI/配置都看过。`src/` 除上列三处证据外未审。

## 维度结论

- **命令注入**：有。Windows 打开浏览器走 `cmd /c start`（HIGH）。`runCommand` 的 npm/`cmd.exe` 和 `verify-package` 的 `shell:true` 是同一类问题，但当前参数到不了元字符（QUESTION）。其余 spawn 使用 argv 数组，`cwd` 不进命令行。`pick-folder.ps1` 的标题只传给 `IFileDialog.SetTitle`，没有 `Invoke-Expression`。
- **spawn 失败与孤儿**：`bin/pi.js` 的 `error` 不退出；Unix 不收孙进程；`taskkill` 忽略退出码（MEDIUM）。启动器的 Next 在 Unix 上 `detached` 后用进程组杀掉，这条是对的。`remote-engine.mjs` 在非 Windows 上 `kill(-process.pid)`，调用方 `supervisor.ts:550` 确实 `detached: true`，不会打到 Next 父进程。Windows 上引擎靠 `taskkill /T`，受上面退出码问题影响。
- **active.json 原子性**：`release.mjs` 失败会把清单写成 `state:"failed"` 并带上 `previous`；`selectProductionBuild`（`build-output.mjs:228-230`）在 `building`/`failed` 且 `previous.state==="ready"` 时改用上一份。构建过程中替换指针是故意的，读路径能退回。`install-build` 在 `rename` 成功前不改旧清单，但提升没有 fsync，损坏的 JSON 会被选择器直接抛掉（MEDIUM）。`apply-global` 先改 `src/`（MEDIUM）。没有看到失败路径把半份构建目录指成 active。
- **发布**：`publish.yml` 仍只有 `workflow_dispatch`，`github.ref == refs/heads/main`，`git push origin v<版本>` 无 `--force`。版本来自 `package.json` 且经 `^\d+\.\d+\.\d+$`。`npm publish` 没有 `--ignore-scripts`，因此会跑加强后的 `prepublishOnly`（typecheck、test、build、verify），不是绕过检查。diff 只把预构建从直接调用 `next build` 改成 `npm run build`。`NPM_TOKEN` 只出现在 Publish 步骤的 `NODE_AUTH_TOKEN` 环境里，没有写进 `run:` 脚本文本；同一步里的 prepublish 脚本能读到它，这是原 workflow 就有的，不是这次新开的步骤。
- **file-lock / Windows**：互斥目录和截断写会把锁永久钉死（MEDIUM）。`wx` 创建和“非 ESRCH 即视为存活”没有单独的反证。没有发现 signal 0 在 Windows 上会真正杀掉进程。
- **CI**：三个 workflow 都没有 `pull_request_target`。`check.yml` / `remote-e2e.yml` 是 `pull_request` + `contents: read`。`run:` 里没有 `github.event.*` / `github.head_ref`。`remote-e2e.yml` 的 cloudflared URL 和 SHA256 是字面量；写 `GITHUB_ENV` 的路径来自 `RUNNER_TEMP` 加固定文件名。矩阵 `node` / `os` 来自 workflow 文件本身。
- **package-lock.json**：diff 中新增 `resolved` 50 条主机为 `registry.npmmirror.com`，11 条为 `registry.npmjs.org`；删除 1 条，主机本来就是 `registry.npmmirror.com`。没有“把已有 registry.npmjs.org 改到其他主机”的成对 `-`/`+`。抽查 `koffi@3.3.8` 与 `@koromix/koffi-win32-x64@3.3.8` 的 `integrity` 与 `https://registry.npmjs.org` 上的官方值相同（`sha512-CTDlV3BDh8...` 与 `sha512-Ef9XpIn/AfnZWM...`）。这是沿用仓库里已有的镜像 URL，不是改掉哈希的投毒。未发现 `http://`、`git+`、`file:` 的新增 `resolved`，抽到的新增条目都有 `sha512` integrity。不单列漏洞。`npm ci` 仍会向镜像请求这些 URL，完整性校验能挡住镜像事后换包。
- **认证守卫**：`next.config.ts` 在 dev/生产服务阶段要求 `requestGuardInstalled`，否则抛错（`PI_WEB_AUTH=0` 可关）。GET 不在这个守卫里做 Cookie 检查；`src/proxy.ts` 对非健康检查的 API 仍要会话，所以不把“GET 未在守卫里认证”算绕过。上传路由被 proxy matcher 排除，但守卫对带 body 的非公开路径仍要 Cookie。任意 IP 的 Host 会被守卫接受，这是给局域网地址用的，应用层仍有 Host/Cookie 检查，没有单独的越权链。
