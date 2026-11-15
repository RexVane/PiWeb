# GitHub Actions 跑 CI 记录：push 后首轮（run 43724228000）

- 触发：2026-11-15 22:24 push `1d4efba..66c7c44`（含本轮 7 个 commit + 此前 6 个未推本地 commit）
- run：https://github.com/RexVane/PiWeb/actions/runs/43724228000
- 结论：**failure**。macOS、Ubuntu×3、Windows×3 全部失败；失败主要来自**既有 WIP 提交在 CI 环境下的跨平台问题**，不是本轮审计修复本身（本地 Windows 全量在相同代码上仅 1 例环境相关失败）。

## windows-latest 的 windows-acl 复跑结果（用户点名项）

- `tests/lib/sandbox/windows-acl.test.ts`：**23 tests | 23 skipped**，原因日志：
  `[piweb] Windows file-write isolation unavailable: Writable root must be a physical directory.`
- 跳过随后触发 `node scripts/testing/check-skips.mjs` 的 `Unexpected skipped tests`（23 条全部列为 unexpected）→ job 失败。
- 根因：`src/lib/sandbox/windows-acl.ts:188` 用 `path.resolve(root).toLowerCase() !== (await fs.realpath(root)).toLowerCase()` 判断“物理目录”；CI 上 `os.tmpdir()` 是 8.3 短路径 `C:\Users\RUNNER~1\AppData\Local\Temp`，`realpath` 返回长路径 `C:\Users\runneradmin\...`，两者被误判为不同 → 沙箱 `create()` 返回 null → 全部 sandbox 用例跳过/失败。
- 结论：**windows-acl 在 CI 上执行了，但因为探测误判而全部 skip；修复该判定后可真正运行**（本机修复后已能跑通，待下一轮 CI 验证）。

## 各 job 结果

| job | 结论 | 主要失败 |
|---|---|---|
| macos | failure | `tests/update-service-process.test.ts`（npmCommand 找不到 npm-cli.js，macOS 布局缺少 `../lib/node_modules/npm` 候选） |
| check (ubuntu-latest, 22.19.0 / 22.22.2 / 24) | failure | `tests/update-service-process.test.ts`（同上）、`launcher-graceful-stop`（新增测试平台假设）、`path-security-boundary`（新增测试平台假设）、`security-route-errors`（400 vs 500）、`settings-effective-scope`、`files-index-bounds`、`web-secret` 等 |
| check (windows-latest, 22.19.0 / 22.22.2 / 24) | failure | 28 个测试文件失败（154 条 FAIL）：大量 `recycleFixture` 短/长路径误判、沙箱物理目录误判连带、tmpdir 短/长路径断言、runtime-proxy 在 Node 22.19 期望不符、pipe-token/launcher 新 IPC 断言、部分 WIP 行为断言等 |
| remote connection (run 43724227991) | 由 push 触发 | 与本轮审计修复无关，另记 |

## 修复计划（ci-repair / task-13 执行中）

1. `windows-acl.ts`：不再用字符串相等判断物理目录，改用 `lstat`（目录且非 symlink/junction）并兼容 8.3 短路径别名；
2. `tests/lib/sandbox/fixtures.ts`：用 `realpathSync.native` 规范化后再比较 tmpdir 边界；
3. `scripts/npm-command.mjs`：补 POSIX `../lib/node_modules/npm/bin/npm-cli.js` 等候选；
4. `runtime-proxy` 测试按 Node 版本（24 / 22.21+）判定 supported；
5. 新增测试 `launcher-graceful-stop`、`path-security-boundary` 改为平台感知；
6. 其余 Windows/Linux 失败：tmpdir 规范化断言、pipe-token 测试期望、security/settings/files-index 的确定性修复；
7. 修完后本地 CI 同环境全量回归 → 重新 commit+push → 观察新 run，记录 windows-acl 最终结果。

（本文件随修复进展更新，最终结果见文末追加。）

## 修复后第二轮 CI（2026-11-15 23:14 push 1c17c43）

- 修复 commit：`1c17c43 test(ci): make cross-platform checks robust on hosted runners`（24 文件，含新增 `src/lib/sandbox/physical-path.ts`）
- 新 run：https://github.com/RexVane/PiWeb/actions/runs/43728621225 （id `43728621225`）状态：in_progress
- 本地修复后验证（CI 同款环境：8.3 短名 TEMP + coverage）：全量 314 文件/2507 用例通过（唯一 launcher.test 偶发，单跑 46/46，且首轮 CI 该用例通过）；tsc/lint/skip-guard exit 0；定向回归 8 文件/66 用例通过（含 windows-acl 的 8.3 短名用例、sandbox config、launcher-graceful-stop、path-security-boundary、update-service-process、runtime-proxy 等）。
- 待验证（只能靠本轮 CI）：Node 22.19/22.22 矩阵、Linux/macOS 专有分支、Windows 无回收站回退、以及 **windows-acl 在 windows-latest 是否从“全跳过”变为“真正执行并通过”**。

## 第二轮结果（run 43728621225）与第三轮（2026-11-15 23:2x）

- 第二轮：macOS 的 3 个平台敏感测试 **全部通过**（Test Files 3 passed (3)、Tests 24 passed | 1 skipped；update-service-process 的 POSIX npm 布局修复生效），但 job 在后续 **lint 步骤失败**：PIWEB_LINT_SKIP_INSTALL=1 下 wrapper 因 CI 直接 
pm ci --prefix 没有写缓存 stamp 而报 "toolchain is missing or stale"。
- 修复：commit `513e422 fix(ci): trust direct npm ci lint installs without the cache stamp`（run.mjs：无 stamp 且 eslint 二进制存在时信任安装并记录 lock hash，仅在 stamp 陈旧时重装）。
- 第三轮 check run：https://github.com/RexVane/PiWeb/actions/runs/43728766188（$(@{databaseId=43728766188; headSha=513e42293cb737095255c5b349d34ba66d9409ce; status=in_progress; workflowName=check}.databaseId)，in_progress）。
- windows-acl 最终结果（第二轮/第三轮）：待后台监控追加；本地已通过新增的 8.3 短名用例与整套 windows-acl（23 tests）。

### 第二轮 CI：check (windows-latest, 22.19.0) => failure（log `check_windows-latest__22.19.0.log`）
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:15:39.6296286Z [90mstderr[2m | tests/lib/sandbox/windows-acl.test.ts[2m > [22m[2mWindows AppContainer isolation[2m > [22m[2mfails closed for a missing or nonphysical writable root
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:15:39.6299306Z [22m[39m[piweb] Windows file-write isolation unavailable: Writable root must be a physical directory.
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:15:41.9817402Z [90mstderr[2m | tests/lib/sandbox/windows-acl.test.ts[2m > [22m[2mWindows AppContainer isolation[2m > [22m[2mfails closed for a native Bash runtime instead of weakening global object isolation
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:15:43.2340557Z  [31m❯[39m tests/lib/sandbox/windows-acl.test.ts [2m([22m[2m24 tests[22m[2m | [22m[31m1 failed[39m[2m)[22m[33m 19780[2mms[22m[39m
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7163319Z [41m[1m FAIL [22m[49m tests/files-service.test.ts[2m > [22mindexes git-visible files for @ references, honoring .gitignore
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7188931Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mtruncated patches with multi-byte text[2m > [22mshows non-ASCII file names verbatim in patch headers
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7209004Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mGit audit regressions[2m > [22mrenders merge commits and unresolved conflicts as ordinary unified patches
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7227612Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mGit audit regressions[2m > [22mretains a bounded preview for a diff larger than execFile's former 8 MiB limit
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7244724Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mdecodes BOM text and rejects malformed encodings in snapshot previews
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7263163Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mkeeps truncated UTF8 and UTF16 snapshot previews on character boundaries
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7281830Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mcommits one round per call with trailers, records user edits separately and serves diffs
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7299567Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mreads the same timeline back from git log in a fresh process
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7325823Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mre-parents onto a head another process committed first
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7356603Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mindexes a workspace across multiple bounded batches
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7506821Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22minitializes a non-git workspace only with consent and keeps HEAD unborn
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7524756Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mnested-initializes a workspace that is a subdirectory of another repository
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7560584Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mpreserves the workspace Git index across non-empty file/directory replacements
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7577652Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves all type conflicts before adding paths across multiple batches
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7595572Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mforce-removes tracked paths replaced by symbolic links
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7613382Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves a file replaced by a linked directory without snapshotting its target
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7627650Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves tracked content when a file becomes a directory
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7638828Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mcontinues recording beyond 2000 history entries and retains the complete prior chain
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7648617Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mretains the prior snapshot when a recorded file grows past the file limit
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7658743Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mcommits the user's edits before a prompt and exactly one commit per round
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7668176Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mretries a failed baseline and clears the visible error after recovery
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7682782Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mautomatically initializes and records an unset workspace without a dialog event
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7695614Z [41m[1m FAIL [22m[49m tests/lib/sandbox/readonly-mode.test.ts[2m > [22mreadonly sandbox mode[2m > [22mstill runs read-only commands
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7701957Z [41m[1m FAIL [22m[49m tests/lib/sandbox/windows-acl.test.ts[2m > [22mWindows AppContainer isolation[2m > [22mterminates detached descendants on shell-exit
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7704292Z [36m [2m❯[22m tests/lib/sandbox/windows-acl.test.ts:[2m171:54[22m[39m
```
```
check (windows-latest, 22.19.0)	Run npm run check	2026-11-15T15:20:43.7708944Z [2m Test Files [22m [1m[31m6 failed[39m[22m[2m | [22m[1m[32m309 passed[39m[22m[2m | [22m[33m1 skipped[39m[90m (316)[39m
```

### 第二轮 CI：check (windows-latest, 24) => failure（log `check_windows-latest__24.log`）
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:15:33.5875749Z [90mstderr[2m | tests/lib/sandbox/windows-acl.test.ts[2m > [22m[2mWindows AppContainer isolation[2m > [22m[2mfails closed for a missing or nonphysical writable root
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:15:33.5885070Z [22m[39m[piweb] Windows file-write isolation unavailable: Writable root must be a physical directory.
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:15:36.8778316Z [90mstderr[2m | tests/lib/sandbox/windows-acl.test.ts[2m > [22m[2mWindows AppContainer isolation[2m > [22m[2mfails closed for a native Bash runtime instead of weakening global object isolation
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:15:37.7295866Z  [31m❯[39m tests/lib/sandbox/windows-acl.test.ts [2m([22m[2m24 tests[22m[2m | [22m[31m1 failed[39m[2m)[22m[33m 17720[2mms[22m[39m
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1088397Z [41m[1m FAIL [22m[49m tests/files-service.test.ts[2m > [22mindexes git-visible files for @ references, honoring .gitignore
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1110260Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mtruncated patches with multi-byte text[2m > [22mshows non-ASCII file names verbatim in patch headers
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1128933Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mGit audit regressions[2m > [22mrenders merge commits and unresolved conflicts as ordinary unified patches
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1146171Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mGit audit regressions[2m > [22mretains a bounded preview for a diff larger than execFile's former 8 MiB limit
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1164608Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mdecodes BOM text and rejects malformed encodings in snapshot previews
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1184128Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mkeeps truncated UTF8 and UTF16 snapshot previews on character boundaries
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1203333Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mcommits one round per call with trailers, records user edits separately and serves diffs
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1221741Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mreads the same timeline back from git log in a fresh process
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1240120Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mre-parents onto a head another process committed first
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1257473Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mindexes a workspace across multiple bounded batches
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1267518Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22minitializes a non-git workspace only with consent and keeps HEAD unborn
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1279560Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mnested-initializes a workspace that is a subdirectory of another repository
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1294637Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mpreserves the workspace Git index across non-empty file/directory replacements
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1309521Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves all type conflicts before adding paths across multiple batches
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1323764Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mforce-removes tracked paths replaced by symbolic links
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1357409Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves a file replaced by a linked directory without snapshotting its target
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1374855Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves tracked content when a file becomes a directory
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1386625Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mcontinues recording beyond 2000 history entries and retains the complete prior chain
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1396742Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mretains the prior snapshot when a recorded file grows past the file limit
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1406657Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mcommits the user's edits before a prompt and exactly one commit per round
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1416685Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mretries a failed baseline and clears the visible error after recovery
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1426491Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mautomatically initializes and records an unset workspace without a dialog event
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1439900Z [41m[1m FAIL [22m[49m tests/lib/sandbox/readonly-mode.test.ts[2m > [22mreadonly sandbox mode[2m > [22mstill runs read-only commands
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1446236Z [41m[1m FAIL [22m[49m tests/lib/sandbox/windows-acl.test.ts[2m > [22mWindows AppContainer isolation[2m > [22mterminates detached descendants on shell-exit
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1448734Z [36m [2m❯[22m tests/lib/sandbox/windows-acl.test.ts:[2m171:54[22m[39m
```
```
check (windows-latest, 24)	Run npm run check	2026-11-15T15:19:54.1453412Z [2m Test Files [22m [1m[31m6 failed[39m[22m[2m | [22m[1m[32m309 passed[39m[22m[2m | [22m[33m1 skipped[39m[90m (316)[39m
```

### 第二轮 CI：check (windows-latest, 22.22.2) => failure（log `check_windows-latest__22.22.2.log`）
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:17:27.6629279Z [90mstderr[2m | tests/lib/sandbox/windows-acl.test.ts[2m > [22m[2mWindows AppContainer isolation[2m > [22m[2mfails closed for a missing or nonphysical writable root
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:17:27.6698885Z [22m[39m[piweb] Windows file-write isolation unavailable: Writable root must be a physical directory.
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:17:29.9919491Z [90mstderr[2m | tests/lib/sandbox/windows-acl.test.ts[2m > [22m[2mWindows AppContainer isolation[2m > [22m[2mfails closed for a native Bash runtime instead of weakening global object isolation
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:17:31.0473557Z  [31m❯[39m tests/lib/sandbox/windows-acl.test.ts [2m([22m[2m24 tests[22m[2m | [22m[31m1 failed[39m[2m)[22m[33m 21440[2mms[22m[39m
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4236314Z [41m[1m FAIL [22m[49m tests/files-service.test.ts[2m > [22mindexes git-visible files for @ references, honoring .gitignore
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4260248Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mtruncated patches with multi-byte text[2m > [22mshows non-ASCII file names verbatim in patch headers
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4281612Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mGit audit regressions[2m > [22mrenders merge commits and unresolved conflicts as ordinary unified patches
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4300250Z [41m[1m FAIL [22m[49m tests/git-service.test.ts[2m > [22mGit audit regressions[2m > [22mretains a bounded preview for a diff larger than execFile's former 8 MiB limit
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4319860Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mdecodes BOM text and rejects malformed encodings in snapshot previews
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4339228Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mkeeps truncated UTF8 and UTF16 snapshot previews on character boundaries
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4358455Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mcommits one round per call with trailers, records user edits separately and serves diffs
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4377923Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mreads the same timeline back from git log in a fresh process
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4405172Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mre-parents onto a head another process committed first
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4422797Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mindexes a workspace across multiple bounded batches
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4463292Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22minitializes a non-git workspace only with consent and keeps HEAD unborn
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4493885Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mnested-initializes a workspace that is a subdirectory of another repository
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4511721Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mpreserves the workspace Git index across non-empty file/directory replacements
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4529870Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves all type conflicts before adding paths across multiple batches
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4547665Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mforce-removes tracked paths replaced by symbolic links
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4623332Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves a file replaced by a linked directory without snapshotting its target
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4642148Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mremoves tracked content when a file becomes a directory
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4660733Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mcontinues recording beyond 2000 history entries and retains the complete prior chain
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4678758Z [41m[1m FAIL [22m[49m tests/growth-service.test.ts[2m > [22mgrowth-service rounds (real git)[2m > [22mretains the prior snapshot when a recorded file grows past the file limit
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4695621Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mcommits the user's edits before a prompt and exactly one commit per round
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4714888Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mretries a failed baseline and clears the visible error after recovery
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4732613Z [41m[1m FAIL [22m[49m tests/growth-tracker.test.ts[2m > [22mgrowth-tracker (real git)[2m > [22mautomatically initializes and records an unset workspace without a dialog event
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4750185Z [41m[1m FAIL [22m[49m tests/lib/sandbox/readonly-mode.test.ts[2m > [22mreadonly sandbox mode[2m > [22mstill runs read-only commands
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4761219Z [41m[1m FAIL [22m[49m tests/lib/sandbox/windows-acl.test.ts[2m > [22mWindows AppContainer isolation[2m > [22mterminates detached descendants on shell-exit
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4765499Z [36m [2m❯[22m tests/lib/sandbox/windows-acl.test.ts:[2m171:54[22m[39m
```
```
check (windows-latest, 22.22.2)	Run npm run check	2026-11-15T15:22:27.4774497Z [2m Test Files [22m [1m[31m6 failed[39m[22m[2m | [22m[1m[32m309 passed[39m[22m[2m | [22m[33m1 skipped[39m[90m (316)[39m
```

## 最终状态（2026-11-15 23:4x，用户决定停止继续修复，收尾整理）

- **已确认绿**：run 43729179839（fc80b45）的 **ubuntu-latest 22.19.0 / 22.22.2 / 24 全部 success、macOS success** —— 说明审计修复与跨平台测试修复在 Linux/macOS 已通过。
- **Windows 遗留**：同一 run 的 windows-latest 24 仍 failure（该 run 尚未包含 7802ba4 的夹具清理兜底）；失败仍集中在 ecycleFixture 的 hosted-runner 清理（无回收站 + 只读 ACL/git 夹具）和 2 条宿主环境相关沙箱断言。7802ba4 已推送、由 run 43729556067 验证，但因用户叫停未等待最终结果。
- **windows-acl 结论**：首轮“23/23 skipped”已修复 → run3/run4 中 **24 tests / 23 passed / 1 flaky**（shell-exit 退出码受 hosted runner job-object 收尾影响，run5 已放宽该断言并在本地 29 tests 全过）。**说明该测试在 windows-latest 上已能真正执行且基本通过**；最后一条 flaky 与产品逻辑无关。
- 停止时后台 monitor 已取消；run5 未等待完成，可用链接自行查看：https://github.com/RexVane/PiWeb/actions/runs/43729556067
