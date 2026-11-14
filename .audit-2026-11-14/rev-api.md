# API / pair 静态审查（相对 HEAD 1d4efba 的未提交工作区）

审查日：2026-11-14。只读。范围是 `src/app/api/` 与 `src/app/pair/` 的已跟踪 diff 与未跟踪新文件；认证、路径、上传、git、配对的调用链追到写盘 / 起进程 / 套接字。未跑测试、未改业务代码。

结论摘要：没有远程未认证 RCE。有 2 条 HIGH（本机命名管道抢走启动令牌；技能/提示词跟随符号链接写出工作区）、1 条 MEDIUM（项目设置跟随 `.pi` junction）、2 条 QUESTION。

---

### [HIGH] src/lib/web-launch-token.ts:131

**问题**：Windows 上启动令牌刷新通道是全局命名管道，本仓库没有给管道设置仅当前用户可连的安全描述符。`listen` 若因 `EADDRINUSE` 失败，Windows 分支直接放弃，进程照常提供 HTTP。之后启动器会把令牌文件里的明文令牌写给「谁先占住这个管道谁」。对方拿令牌访问 `GET /?token=` 即可换成会话 Cookie（`src/proxy.ts` 的 `consumeLaunchToken`）。

**触发条件**：

1. 攻击者是另一本地用户（读不了受害者配置文件，但能创建全局管道）。
2. 在 PiWeb 监听之前占住管道。默认端口 30141（`scripts/launcher.mjs` 的 `parseLauncherArgs`：`Number(env.PORT || 30141)`）。管道名可算：`\\.\pipe\piweb-launch-` + SHA-256(小写 agent 目录实路径 + `:` + 端口) 的前 32 位十六进制（`scripts/web-auth-protocol.mjs`）。用户名通常可枚举，agent 目录默认是 `C:\Users\<user>\.pi\agent`。端口被占用时启动器会 +1，可预先占一批连续端口对应的管道。
3. 受害者用启动器打开或复用实例。启动器读 `web-launch/<port>.token`，再向该管道发送 `{token:...}`。
4. 攻击者用收到的令牌请求 `http://127.0.0.1:<port>/?token=<token>`。本机 HTTP 对其他本地用户可达。令牌在被消费前有效（默认 5 分钟，且一次成功登录后轮换）。

同一用户的恶意代码直接读令牌文件即可，不必走管道。本条是跨本地用户。Unix 域套接字在 agent 目录内且 `chmod 0600`，`EADDRINUSE` 还会核对 uid / inode，不在此条。

**期望行为**：管道只允许当前用户连接；绑定失败应拒绝启动或拒绝把令牌发给未确认的对端；启动器在对端不是自己的服务时不得发送令牌。

**实际行为**：Windows 路径是全局 `\\.\pipe\...`。`server.listen(endpoint)` 没有安全描述符。Windows 上 `EADDRINUSE` 不走 Unix 的陈旧套接字回收，只把服务器从 map 删掉。令牌文件在 `listen` 之前已经写好，内存里的令牌也已记下，所以 HTTP 兑换仍然接受该令牌。启动器不校验对端身份就把令牌写出去。

**证据**：

`scripts/web-auth-protocol.mjs`：

```js
return process.platform === "win32"
  ? `\\\\.\\pipe\\piweb-launch-${createHash("sha256").update(`${root}:${port}`).digest("hex").slice(0, 32)}`
  : path.join(root, "web-launch", `${port}.socket`);
```

`src/lib/web-launch-token.ts`（先写文件，再监听；Windows 占用则放弃）：

```js
fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
// ...
publishLocalRefreshServer(key, port);
// ...
server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && process.platform !== "win32" && !recovering) {
    // 仅 Unix 尝试回收
  } else if (ipcServers.get(endpoint) === server) ipcServers.delete(endpoint);
});
server.listen(endpoint, ready);
```

`ready` 里只对非 Windows `chmod 0600`。Node 的 `mode: 0o600` 在 Windows 上不设置 DACL。

`scripts/launcher.mjs` `readCurrentLaunchToken`：

```js
const token = readLaunchToken(port, env);
const socket = net.connect(launchTokenIpcPath(agentDirOf(env), String(port)));
socket.once("connect", () => socket.write(`${JSON.stringify({ token })}\n`));
```

调用点：已有实例时约 463 行，新进程就绪后约 556 行，锁冲突等待时约 606 行。成功结果被拼进浏览器打开的 `/?token=` 链接。

**修复建议**：Windows 用仅当前用户（及 SYSTEM）的显式 DACL 创建管道；`EADDRINUSE` 时不要继续对外提供可兑换令牌，或启动器只连接自己刚创建且持有的管道。对端未通过身份校验前不要发送令牌。HTTP 兑换侧保持一次性消费。

**最小失败测试**：以用户 B 先 `CreateNamedPipe` 占住按用户 A 的 agent 目录和 30141 算出的管道名；用户 A 启动 PiWeb（管道 `listen` 失败但 HTTP 仍起来）；断言启动器发给该管道的 JSON 含当前 `.token` 文件内容，且用户 B 用该值 `GET /?token=` 得到 `303` 和 `piweb_session_` Cookie。管道由用户 A 先占用时，用户 B 的连接应被拒绝。

---

### [HIGH] src/app/api/skills/route.ts:32

**问题**：技能读取/开关和提示词读取把「已发现技能路径」做 `realpath` 后就当成授权边界。项目里的 `SKILL.md` 若是指向工作区外的符号链接（或技能目录是 junction，且目标里已有 `SKILL.md`），读接口返回目标内容，开关接口把改过 frontmatter 的正文写回目标文件。提示词读取还会把边界扩大到该真实文件所在目录，从而读该目录下任意文件。这不是调用方显式传入外部 `cwd`（文件 API 允许任意 cwd），而是界面按「工作区里的技能路径」操作时，服务器跟随链接改到区外。

**触发条件**：

1. 已登录会话（`proxy.ts` 校验 Cookie；这些路由不在公开路径里）。
2. 工作区被加载器发现了一条技能，其 `SKILL.md` 的 `realpath` 落在工作区外。Windows 上文件符号链接需要开发人员模式或管理员；目录 junction（`mklink /J`）不需要。Junction 只能在目标目录里已经有名为 `SKILL.md` 的文件时被加载器当成技能。Git 检出符号链接还取决于 `core.symlinks`。
3. 读：`POST /api/skills` `{action:"read", filePath:"<工作区内的 SKILL.md>", cwd:"<工作区>"}`。开关：`action:"toggle"`。提示词：`POST /api/prompts` `{action:"read", cwd, filePath:"<目标目录内绝对路径>", sourcePath:"<该 SKILL.md>"}`。图片：`GET /api/files?image=1&cwd=&path=&sourcePath=<SKILL.md>`，且扩展名/魔数通过图片校验。

**期望行为**：项目技能的真实路径必须仍在该工作区（或用户显式配置的技能根，如 agent 目录下的 skills）之内。链接指向别处则拒绝，并且不得把「真实文件的父目录」整棵当成可读根。开关只能改链接本身或确认仍在允许根内的实体文件。

**实际行为**：`resolveDiscoveredPath` 把请求路径和发现列表都 `realpath` 后按同一路径相等即授权。`readSkillFile` / `setSkillDisabled` 直接读、写这个真实路径。`resolvePromptSourcePath` 在来源是技能时把 `path.dirname(realpath(skill))` 放进允许根，于是目标文件的兄弟文件也可读。

**证据**：

`src/app/api/skills/route.ts`：

```ts
if (body.action === "read") {
  return NextResponse.json({ success: true, data: { content: await readSkillFile(body.filePath, cwd) } });
}
```

`src/lib/skills-service.ts`：

```ts
const authorized = await resolveDiscoveredPath(filePath, skills.map((skill) => skill.filePath));
const content = await readSkillBounded(authorized);
const next = toggleSkillFrontmatterDisabled(content, disabled);
await fs.writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: (await fs.stat(authorized)).mode });
await replaceFileAtomically(temporary, authorized);
```

`src/lib/prompt-sources.ts`：

```ts
const authorized = await fs.realpath(filePath);
const roots = [await fs.realpath(cwd)];
for (const candidate of sources) {
  if (candidate.kind !== "skill" || !candidate.path) continue;
  const real = await fs.realpath(candidate.path);
  if (real && samePath(real, source)) roots.push(path.dirname(real));
}
if (!roots.some((root) => isPathInside(root, authorized)) && !samePath(source, authorized)) {
  throw new BoundaryError("linked resource escapes the workspace or skill directory");
}
```

`src/app/api/prompts/route.ts:48` 把客户端的 `filePath` 与 `sourcePath` 交给 `readPromptSource`。`src/app/api/files/route.ts:14` 把 `sourcePath` 交给 `readWorkspaceImage`，后者在有 `sourcePath` 时同样调用 `resolvePromptSourcePath`。删除技能会沿路径 `lstat`，遇到符号链接只删链接（`skills-service.ts` 约 276–282 行），这条写/读路径没有同等限制。

**修复建议**：项目作用域技能在 `realpath` 之后必须仍位于该工作区实路径内；用户级技能必须位于 agent/skills 等固定根内。失败则 400，不要读、不要写。提示词附件的允许根用技能目录的词典路径加「不得跳出该根的 realpath」，不要用链接目标的父目录。开关写回前再 `lstat`，若是链接则拒绝或只改链接一侧。

**最小失败测试**：在临时工作区创建 `SKILL.md` 符号链接指向区外的可写文本文件（Windows 无符号链接权限时用目录 junction 指到已含 `SKILL.md` 的目录）。`POST /api/skills` `action=read` 应 400，且目标文件字节不变。现在会 200 且正文是目标文件。再 `action=toggle`，断言目标文件未被改写。提示词用例：`sourcePath` 为该链接，`filePath` 为目标父目录里的另一个文件，应 400。

---

### [MEDIUM] src/app/api/pi-settings/route.ts:25

**问题**：`PUT /api/pi-settings?cwd=` 把设置写到 `realpath(cwd)/.pi/settings.json`，但没有检查 `.pi` 本身是不是 junction/符号链接，也没有在写入前确认最终文件的 `realpath` 仍在该工作区内。`.pi` 为目录 junction 时，`settings.json` 会创建或覆盖在 junction 目标里。

**触发条件**：已登录。工作区 `D:\proj\.pi` 是指向区外可写目录的 junction（普通用户可用 `mklink /J`，不必是管理员）。`PUT /api/pi-settings?cwd=D:\proj`，正文为合法补丁，例如 `{"steeringMode":"all"}`。`cwd` 查询是这次 diff 新加上的项目级写入。

**期望行为**：最终 `settings.json` 的实路径必须位于 `resolveWorkspacePath(cwd)` 之下。`.pi` 或 `settings.json` 为链接/junction 时拒绝整次写入。

**实际行为**：只对 cwd 做了 `realpath`。随后 `path.join(root, ".pi", "settings.json")`，`mkdir` 与 `rename` 都跟随目录 junction。读接口同样会把目标里的 `settings.json` 当成项目设置解析（仅返回已知字段，不是任意文件读）。

**证据**：

`src/app/api/pi-settings/route.ts`：

```ts
const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
patch = await patchPiSettings(await req.json(), cwd);
```

`src/lib/pi-settings.ts`：

```ts
const file = cwd ? path.join(await resolveWorkspacePath(cwd), ".pi", "settings.json") : settingsFile();
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(temporary, bom + original, "utf8");
await replaceFileAtomically(temporary, file);
```

全文件没有 `lstat` / 对 `file` 的 `realpath` 与 cwd 比较。对照：`src/lib/sandbox/config.ts` 的 `resolveRoot` 会拒绝 `realpath` 与原始路径不一致的根。

**修复建议**：`lstat` 检查 `.pi` 与 `settings.json`；若任一为链接则拒绝。写入前 `realpath` 父目录，要求 `isPathInside(workspaceReal, parentReal)`。临时文件放在已确认的工作区实路径内再替换。

**最小失败测试**：临时目录 `proj`，`mklink /J proj\.pi outside`。PUT 项目设置。断言 `proj\.pi\settings.json` 的实路径仍在 `proj` 下；现在文件出现在 `outside\settings.json`。

---

### [QUESTION] src/lib/path-security.ts:41

**问题**：文件已存在且 `realpath` 已确认在会话库内时，`resolveSessionPath(..., { allowPending: true })` 仍返回解码后的原始路径，而不是 `realFile`。随后的 `fs.open` / 归档走的是这条可能含 junction 的路径。单次请求里检查和打开之间若 junction 被改指向，打开的就不是刚才校验的那个文件。

**触发条件**：未能在不依赖时间窗的情况下构造稳定失败。需要本地攻击者在 `realpath` 返回之后、`fs.open` 之前把父级 junction 改到会话库外，且叶名仍是同一个 `.jsonl`。窗口是同一条请求内的几次 await。调用方包括 `src/app/api/models/route.ts:43`（读会话头）、`src/app/api/workspaces/route.ts` 的归档/置顶（`allowPending: true`）、`src/app/api/growth/route.ts` 的 consent/record。

**期望行为**：文件已存在时一律返回并使用 `realFile`。后续 IO 打开的是已校验的实路径，而不是调用方传来的拼写。

**实际行为**：

```ts
if (!isPathInside(realRoot, realFile)) throw new BoundaryError("session path escapes the Pi session store");
const stat = await fs.stat(realFile);
if (!stat.isFile()) throw new BoundaryError("session is not a file");
return options?.allowPending ? decoded : realFile;
```

注释说明短路径和 junction 可以是会话库的合法别名，所以 pending 创建要保留原始拼写。文件已经存在时没有这个必要。

**证据**：见上。`models/route.ts` 接着 `fs.open(sessionPath, "r")` 读前 16KB 当会话头。

**修复建议**：`realFile` 非空时返回 `realFile`。仅在 ENOENT 且 `allowPending` 时返回尚未创建的 `decoded`（父目录实路径已在下方循环里检查）。

**最小失败测试**：会话文件已存在。id 使用指向会话库的 junction 路径。在 `realpath` 与 `open` 之间改 junction 目标。期望打开失败或仍读到原 inode；当前实现会打开新目标。测试需注入延迟，否则只证明竞态存在、不能稳定红。

---

### [QUESTION] src/app/api/plugins/route.ts:64

**问题**：`action:"install"` / `"update"` / `"remove"` 把客户端字符串 `source` 交给 `DefaultPackageManager.installAndPersist` / `removeAndPersist` / `update`（`src/lib/pi.ts` 构造 SDK 的 `DefaultPackageManager`）。本仓库路由没有 shell 拼接。SDK 是否把 `source` 放进 `npm`/`git` 的 shell 命令字符串，这次没有读到实现，不能下结论。

**触发条件**：未构造。若 SDK 使用 `execFile` 参数数组且 `--` 之后才放 source，则没有 shell 注入。若使用 `cmd /c` 拼接 source，则已登录用户可注入。源码不在本仓库已读范围内。

**期望行为**：包源只作为参数数组的一项，不经过 `cmd.exe` 命令行拼接；来源字符集再收窄一层（拒绝换行与 `&|<>`）。

**实际行为**：路由仅限制长度 4096，然后 `installPackage(body.source, body.local === true, cwd)`。`cwd` 经 `resolveWorkspacePath`。

**证据**：

```ts
if (body.action === "install") {
  if (!body.source) return NextResponse.json({ success: false, error: "missing source" }, { status: 400 });
  await installPackage(body.source, body.local === true, cwd);
}
```

`src/lib/plugins-service.ts`：`await pm.installAndPersist(source, { local });`

**修复建议**：在路由或 `plugins-service` 对 source 做与 UI 一致的允许形式校验（`npm:` 包名、git URL、本地绝对路径实路径）。确认 SDK 调用方式；若是 shell，改为参数数组。

**最小失败测试**：在能观察子进程 argv 的替身 `DefaultPackageManager` 上安装 `npm:foo & calc`。断言 argv 中 source 是单独一项且没有 `cmd.exe /c`。目前没有这种测试钩子，不能当成已失败。

---

## 覆盖文件清单

已跟踪（相对 HEAD 的 diff 加工作区上下文）：

- `src/app/api/agent/[id]/events/route.ts`（仅 SSE ping 格式）
- `src/app/api/agent/[id]/route.ts`（命令仍经 `parseAgentCommand`；错误改走 `apiError`）
- `src/app/api/agent/[id]/tree/route.ts`
- `src/app/api/agent/new/route.ts`（补了对象校验；`cwd` 走 `resolveWorkspacePath`）
- `src/app/api/agent/resources/route.ts`
- `src/app/api/config/route.ts`（失败不再回传异常文本）
- `src/app/api/files/route.ts`
- `src/app/api/fs/route.ts`
- `src/app/api/git/route.ts`
- `src/app/api/growth/route.ts`
- `src/app/api/models/defaults/route.ts`
- `src/app/api/models/route.ts`
- `src/app/api/pi-settings/route.ts`
- `src/app/api/plugins/route.ts`
- `src/app/api/prompts/route.ts`
- `src/app/api/remote/route.ts`
- `src/app/api/security/route.ts`
- `src/app/api/sessions/[id]/export/route.ts`
- `src/app/api/sessions/[id]/route.ts`
- `src/app/api/sessions/import/route.ts`
- `src/app/api/sessions/route.ts`
- `src/app/api/skills/route.ts`
- `src/app/api/update/route.ts`（`target`/`action` 仍是枚举）
- `src/app/api/web-auth/route.ts`
- `src/app/api/workspaces/route.ts`

未跟踪新文件（全文）：

- `src/app/api/automations/route.ts`
- `src/app/api/automations/preview/route.ts`
- `src/app/api/files/download/route.ts`
- `src/app/api/files/upload/route.ts`
- `src/app/api/plugins/marketplace/route.ts`
- `src/app/api/remote/pair/route.ts`
- `src/app/api/sandbox/route.ts`
- `src/app/api/sessions/[id]/history/route.ts`
- `src/app/api/sessions/[id]/images/route.ts`
- `src/app/pair/route.ts`

调用链读过、但不在「路由覆盖」计数里：`src/proxy.ts`，`src/lib/auth.ts`，`src/lib/web-auth.ts`，`src/lib/web-launch-token.ts`，`scripts/web-auth-protocol.mjs`，`scripts/launcher.mjs`（令牌发送段），`src/lib/web-devices.ts`，`src/lib/remote/pairing.ts`，`src/lib/path-security.ts`，`src/lib/api-error.ts`，`src/lib/public-diagnostic.ts`，`src/lib/files-service.ts`（列表/读/上传/编辑器段），`src/lib/prompt-sources.ts`（`resolvePromptSourcePath`），`src/lib/skills-service.ts`（读/开关/删除计划），`src/lib/pi-settings.ts`，`src/lib/sandbox/config.ts`，`src/lib/git-service.ts`（`gitDiff`/`gitShow`/`assertRepoRelative`），`src/lib/growth-service.ts`（`assertRelPath`/`assertHash`/`shadow`/`fileContent`），`src/lib/models-service.ts`（`discoverModels`/`requestModelCatalog`），`src/lib/automations/store.ts` 与 `schedule.ts`，`src/lib/plugins-marketplace.ts`，`src/lib/agent-manager.ts` 的 `readSessionImage`，`src/app/api/remote/route.ts` 所用的 `remoteBlocked`/`ensureRemoteAccess`。

## 未追踪清单

下列调用链没有逐行读完，报告不把它们说成已审：

- `src/lib/automations/runner.ts`（只确认本文件没有 `spawn`/`execFile`；调度如何启动 agent 未读完）
- `src/lib/update-service.ts` 的 `runUpdate` / `checkForUpdate`（路由只放行固定 `target`/`action`）
- `node_modules` 内 `DefaultPackageManager`（见 QUESTION `plugins/route.ts:64`）
- `src/lib/session-import/` 下各来源解析器（路由侧确认选择项只有 `source`+`externalId`，`fallbackCwd` 已删除；`writer.ts` 的 `safeId`/`encodeSessionDir` 读过，解析器未逐个读完）
- `src/lib/agent-manager.ts` 除 `readSessionImage` / `getSessionHistory` 以外的执行路径
- `src/lib/sandbox/windows-acl.ts`、`bash-operations.ts`（只确认可写根在使用时再次拒绝非实路径；ACL 实现未审完）

## 各维度

**认证 / 鉴权**：未发现未认证远程绕过。`authEnabled` 改为默认开（仅 `PI_WEB_AUTH=0` 关）。`/pair` 在公开路径中，凭据是 32 字节 `base64url` 一次性短码（120 秒，失败 30 次/分钟）；兑换后 Cookie 为 HttpOnly、SameSite=Strict，并绑定 Host。`/api/remote/pair` 在认证关闭或 `remoteBlocked` 时 409，不在公开路径。`/api/files/upload` 被 `proxy.ts` matcher 排除，路由内自行做了与网关相同的 Host、Origin、`validSessionCookie`（吊销清单不可用时 `validSessionCookie` 返回 false，失败关闭）。`web-auth` 的 `devices` 与按设备吊销要求有效 Cookie；`scope=all` 会 `await revokeAllSessions` 并轮换启动令牌。启动令牌 HTTP 兑换改为一次性 `consumeLaunchToken`。跨用户令牌窃取见 HIGH 管道条。`isSafeOrigin` 在没有 Origin 时放行，但会话 Cookie 是 SameSite=Strict，且 `Sec-Fetch-Site: cross-site` 会 403，未构成浏览器跨站写。

**路径穿越与工作区禁闭**：`openWorkspaceFile` / `readWorkspaceFile` / git `assertRepoRelative` 使用 `path.resolve` + `isPathInside`（Windows 小写比较）+ `realpath` 再检查。`../`、绝对路径、盘符相对路径（`C:foo` 会被 `path.win32.resolve` 甩到另一盘，随后 `isPathInside` 失败）未发现绕过。工作区 `cwd` 本身可以是任意已存在目录，这是远程文件选择器/文件 API 的设计，不单独记缺陷。技能链接与 `.pi` junction 见 HIGH/MEDIUM。会话 id 的 `allowPending` 见 QUESTION。`fs` 的 `list` 对任意绝对路径 `realpath` 后列目录，注释写明是已登录设备的工作区选择器；本次 diff 没有放宽这条边界。沙箱额外可写根拒绝「原始路径 ≠ realpath」的链接根。

**方法与 body**：新路由和改过的 POST/PUT 多数先拒绝非对象 body。`automations` 按 `action` 校验 id/mode/hash，`cwd` 走 `resolveWorkspacePath`，日程走 `validateSchedule`（cron 只解析，不进 shell）。`update` 只允许 `piweb|pi` 与 `check|update`。`import` 只接受 `{source, externalId}`，已去掉客户端 `fallbackCwd`。`web-auth` POST 固定 410。未发现漏掉的写方法旁路。

**上传 Content-Type 与大小**：`/api/files/upload` 与 `/api/files?action=upload` 都要求十进制大小头（`x-upload-size` 或 `Content-Length`），上限 100MB，流式计数与声明不一致即删临时文件。不检查 Content-Type。文件名去掉 `\/` 和控制字符，再加时间戳前缀，落在 `web-uploads`。下载强制 `application/octet-stream`、`nosniff`、`Content-Disposition` 去掉引号、反斜杠和非 ASCII。未发现凭借 Content-Type 把上传内容当成页面执行的路径。Windows 保留设备名（`CON` 等）和文件名里的 `:`（NTFS 备用流）没有单独拒绝；前缀后不是单独的设备路径分量，不能据此声称写出 `web-uploads` 之外，故不单列发现。

**命令 / git 注入**：`gitDiff`/`gitShow` 用 `execFile`/`spawn` 参数数组；用户路径在 `--` 之后，且先做仓库内检查；commit 限定 `[0-9a-f]{4,40}`。`openInEditor` 在 Windows 上拒绝 `&|^<>()%!"` 和控制字符后再 `cmd.exe /d /c`。growth 的 `cat-file` 参数是 `assertHash`（40 或 64 位十六进制）加 `assertRelPath`（拒绝绝对路径和 `..`），走参数数组。插件 `source` 见 QUESTION。未在已读代码里看到把请求字符串拼进 shell 的地方。

**共享存储竞态**：配对短码的 Map 增删在同步函数里，单进程内一次消费。启动令牌 `consumeLaunchToken` 同步轮换。自动化 `mutateStore` 有设置写锁。上传使用 `wx` 独占创建。见 QUESTION 的会话路径 TOCTOU。命名管道与 HTTP 进程之间没有「管道必须由本进程持有」的绑定，见 HIGH。

**漏 await**：`web-auth` 吊销已 `await`。`pair` 的 `rememberWebDevice` 有 `await` 且失败只打日志，Cookie 仍会种下（登记失败不等于未登录）。`proxy.ts` 里同名调用是 `void`（网关文件，不在路由清单）。未发现因此跳过鉴权的路径。

**错误处理与信息泄露**：`apiError` 对非校验错误只返回固定中文或已知 errno，不回传 `error.message`。`BoundaryError` / `validation=true` 会回传经过路径替换的 message。`config` 改为固定句。`web-auth` 吊销失败不再拼接异常文本。growth 默认 code `failed` 走 500，git stderr 不会进 body（除非 message 里带 ENOENT 等词，那时也只换成固定句）。`publicDiagnostic` 会把非命令类原文做路径替换后最多回 2048 字；导入/插件加载用它。未看到已构造的密钥回传。`/api/remote` GET 已不再返回 `loginToken`。
