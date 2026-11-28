# 发布、降级与回滚

维护日期：2026-11-28。本文是**用户/部署者**的升级、降级与故障回滚手册；维护者发布流程见 [.github/RELEASING.md](../../.github/RELEASING.md)。数据目录与备份约定见[数据目录、隐私与留存](data-and-privacy.md)。

## 先记住三件事

1. **升级/降级前先停 `piweb`**。运行中的实例不要直接替换安装目录或 `.next`。
2. **先备份数据**：复制整个 agent 目录（默认 `~/.pi/agent`，或 `PI_CODING_AGENT_DIR` 指向的目录）以及 `~/.agents/skills`、`~/.agents/backups`。升级不迁移数据，但降级可能遇到旧版本不认识的字段。
3. **以 npm 安装形态为准**：本文件默认你通过 `npm install -g @rexvane/piweb` 安装。源码检出的自动更新另见“源码检出的自动更新”一节，风险更高。

## 版本确认

```bash
npm ls -g --depth=0 @rexvane/piweb    # 已安装版本（推荐）
```

`/api/version` 返回运行中的 PiWeb/pi/Node 版本，但和其余 API 一样需要认证（启动令牌或会话 Cookie），不适合用来做匿名探针。Windows 上用 `npm ls -g --depth=0 @rexvane/piweb` 或安装目录 `package.json` 的 `version` 核对。

## 升级（正常路径）

```bash
# 1) 停掉正在运行的 piweb（Windows 尤其必须，运行中的文件不能替换）
# 2) 升级
npm install -g @rexvane/piweb@latest
# 3) 重新启动
piweb
```

- 指定版本：`npm install -g @rexvane/piweb@0.3.35`。
- 应用内更新（设置 → 通用中的「PiWeb 版本」/ 右下角提示条；内置 Pi 内核随 PiWeb 发版升级）：
  - 在 macOS / Linux 上通过 `piweb` 启动器运行的全局 npm 安装或 Git 检出，点击「更新」后会自动安装新版本、优雅停机（退出码 `75`）、在原端口自动拉起新实例（不重复打开浏览器）并在就绪后自动刷新页面；
  - Windows 上因为运行中的文件被占用，面板仍会给出“先停 `piweb` 再运行”的命令和复制按钮。
- 发布包自带已封存的 `.next`，正常升级不需要本机编译；只有安装不完整或跳过生命周期脚本时，首次启动才会现场构建一次（见[安装与构建机制](install-and-build.md)）。

## 降级（回滚到旧版本）

```bash
# 1) 停掉 piweb
# 2) 安装明确的历史版本（不要写 @latest）
npm install -g @rexvane/piweb@0.3.34
# 3) 启动并确认版本
piweb
```

- **版本必须精确**：`@latest` 会把你带回最新版，`@0.3` 这类范围也只会解析到最新补丁。
- 降级后如果界面/设置报错，用升级前的 agent 目录备份覆盖当前数据目录，再启动（数据文件格式以旧版本为准）。
- 若不确定该退到哪个版本：`npm view @rexvane/piweb versions --json` 查看列表；`npm view @rexvane/piweb time --json` 看发布时间。

## 应用内更新失败怎么办

按失败阶段处理：

| 现象 | 处理 |
| --- | --- |
| 面板提示先停止 `piweb` 再运行命令（Windows 文件占用） | 停掉 `piweb`，在终端执行面板给出的 `npm install -g @rexvane/piweb@latest`，再启动。 |
| 更新命令失败（网络/registry 报错） | 直接重试；国内镜像同步延迟时加 `--registry=https://registry.npmjs.org`。 |
| 更新完成但版本没变 | `npm ls -g --depth=0 @rexvane/piweb` 确认是否更新到了其它副本；当前安装若是项目依赖而非全局包，按当初安装方式更新。 |
| 更新后无法启动、构建校验失败 | 先重装当前版本：`npm install -g @rexvane/piweb@latest`；仍失败则重装上一个已知可用版本（降级）。 |
| 安装目录里构建产物不完整 | `npm rebuild -g @rexvane/piweb` 触发一次安装后构建（约 6–15 分钟）；或 `npm install -g @rexvane/piweb@<version>` 重装。 |
| 启动报“属主不是当前用户” | 此前可能用 `sudo` 安装过：按提示 `sudo chown -R $(whoami) <安装目录>` 后重试。 |
| 数据/设置报错 | 停止 `piweb`，用备份恢复 agent 目录后重启；保留坏副本供排查。 |

排查时先看启动终端的 `[piweb]` 行与退出码；生产构建的选择/校验日志在安装目录 `.next-releases/active.json` 与 `last-ready.json`。

## 源码检出的自动更新（风险更高）

通过应用内“更新”更新 Git 检出时，实际步骤是：`git pull --ff-only` → `npm install` → 构建隔离发布（`prepareRelease`）→校验通过后切换 `active.json`。注意：

- 旧构建会保留并有回退记录，但 **`git pull` 与 `npm install` 已经改了源码和共享的 `node_modules`**，它们不会随旧构建一起回退。不要更新有未提交改动的源码检出；更新失败后不要继续在该工作区运行旧代码。
- 回滚源码检出：

  ```bash
  # 1) 停掉 piweb
  git status                        # 确认没有需要保留的未提交改动，先自行备份
  git checkout <上一个已知可用的提交或标签>
  npm ci                            # 按旧 lockfile 重装依赖
  npm run build:release             # 重建隔离发布并封存校验
  piweb
  ```

  回滚会丢弃当前工作区的未提交改动，操作前按项目规则备份。
- `npm run build:release` 失败时不会替换正在服务的构建：`active.json` 会记录 `failed`，启动器用其中的 `previous`（或完整 `.next`）继续启动，旧构建仍可服务。修复失败原因后重跑即可。

## 用 `.next-releases` 回退到上一个构建

适用于源码检出/自建发布：`npm run build:release` 每次把新构建放进 `.next-releases/<id>`，`active.json` 记录当前构建并把上一个可用构建放在 `previous` 字段。若新构建能启动但行为有问题，而旧构建目录还在：

1. 停掉 `piweb`；
2. 备份 `.next-releases/active.json`；
3. 打开 `.next-releases/active.json`，找到 `previous` 里的 `buildDir`、`buildId`；
4. 把 `active.json` 改写成（保留 JSON 数字/字符串原样）：

   ```json
   { "schema": 1, "state": "ready", "buildDir": "<previous.buildDir>", "buildId": "<previous.buildId>" }
   ```

5. 启动 `piweb`。启动器会重新校验该构建的 `BUILD_ID`、必需清单与文件哈希；校验失败就说明旧构建已被改动/清理，只能按上一节从旧提交重建。

不要删除 `active.json` 指向的构建目录；不要把 `.next` 与 `.next-releases` 混用（`PIWEB_BUILD_DIR` 与活动发布冲突会拒绝启动）。达到保留上限（默认成功 10 个、失败 3 个，见[环境变量](environment.md#构建与发布)）时先归档再构建。

## 维护者紧急处置（npm 侧）

- 确认最新版本有问题后，先 **deprecate** 而不是 unpublish（unpublish 会破坏已锁定的用户）：

  ```bash
  npm deprecate @rexvane/piweb@0.3.35 "Regression in 0.3.35; install 0.3.34 instead."
  ```

- 把 `latest` 指回已知可用版本（用户再执行 `@latest` 会拿到正确版本）：

  ```bash
  npm dist-tag add @rexvane/piweb@0.3.34 latest
  ```

- 删除/改造 `latest` 标签前先确认旧版本仍可安装；发布流程、版本与 tag 规则见 [.github/RELEASING.md](../../.github/RELEASING.md)，仓库 tag/GitHub Release 的补救按该文件“Retrying”一节处理。

## 数据兼容与恢复

- 升级/降级不会自动迁移或删除用户数据；会话 JSONL 追加写入，设置/模型文件采用保留注释的 JSONC 事务写入。**但降级不保证旧版本认识新版本写入的全部字段/事件**，因此降级前必须备份 agent 目录。
- 降级后需要“回到升级前的数据”时：停 `piweb` → 用备份覆盖 agent 目录 → 启动。覆盖前保留当前目录副本，便于再次升级时排查。
- 本版手动确认删除的会话、技能、模板和独占附件进入运行 PiWeb 的电脑的系统回收站；恢复时先停掉 PiWeb，再从回收站恢复到原位置。旧恢复副本和后台清理的副本仍按相应 `backups/INDEX.md` 恢复，详见[数据目录、隐私与留存](data-and-privacy.md#删除归档与恢复副本)。
- 回滚后建议跑一次最小验收：启动、登录、`/api/health`、会话列表、设置读取；真实发消息会消耗模型额度，按需执行。
