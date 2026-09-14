# PiWeb

<p align="center">
  <strong>为 Pi 编程智能体打造的现代 Web 界面 —— 对齐 DeepSeek Harness (dsh) 交互体验。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="assets/showcase.png" alt="PiWeb 界面展示" width="840" />
</p>

---

**PiWeb** 是为 [pi 编程智能体](https://github.com/earendil-works/pi) 打造的 **dsh 式** 现代 Web 界面：`npm start` 一键启动，提供实时流式对话、工作区会话管理、会话树分支跳转、技能/插件/模型管理，**pi 本身零改动**。

- **引擎**：官方 npm 包 `@earendil-works/pi-coding-agent`（进程内 SDK），使用精确版本锁；`npm run update:pi` 独立升级和验证上游引擎。
- **界面**：视觉与交互对齐 [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web 端 —— `--dsw-*` 实色面板、三栏框架（侧栏可收起为 56px 导轨 + 拖拽调宽）、22px 输入卡、ic_ds 图标与 π 官方图标。
- **原则**：工具、模型、技能和插件机制完全使用 Pi 官方原生方案；会话与工作区结构保持兼容。

## 功能亮点

- **实时流式交互**：SSE 完整快照 + 有序增量同步，支持 `Last-Event-ID` 断线补发，逐字平滑渲染；思考链（Thinking）与工具调用内联展示；多标签页 3 秒自动同步。
- **输入卡与控制**：支持图片附件（选择 / 粘贴 / 拖放）、两级模型选择与快速循环切换、上下文压缩、停止生成、清空队列及 `/` 斜杠命令面板（内置命令 + Pi 模板 + 技能）。
- **解耦的工作区与会话**：按项目文件夹分组展示，支持 Windows 原生文件夹选择器；支持空工作区独立留存；删除工作区弹出全局居中确认弹窗，文件夹与会话文件均安全保留并自动归集到“未分组”下。
- **会话管理**：支持导出会话日志为 JSONL / HTML、会话树分支可视化跳转与草稿恢复、AGENTS.md 上下文注入展示，以及轨迹性能视图（TTFT / 解码耗时）。
- **多功能设置**：
  - **通用**：工具权限预设（只读 / 工作区写入 / 完全访问）、中英双语切换、外观偏好、Enter 键行为、自动重试及自动压缩。
  - **模型**：支持 30+ 官方内置 Provider、添加自定义提供方（写入 `models.json`）及 OAuth 登录（Claude / Codex / Copilot 等）。
  - **插件与技能**：通过 Pi 原生包管理器安装、卸载、更新扩展，并支持即时开关 Skill。
- **安全防护**：可通过 `PI_WEB_PASSWORD` 开启 HTTP Basic Auth；写接口严格执行同源与路径边界校验。

## 快速开始

**环境要求**：Node.js ≥ 22.19.0（推荐 Node.js 24）；Git 与成长树功能还需要安装 Git。

### 通过 npm 全局安装（推荐）

```bash
npm install -g piweb
piweb
```

全局安装会在安装时（或首次运行时）准备一次生产产物，随后以生产模式启动；失败时会明确报错而不是回退到缺少开发依赖的开发模式，可用 `npm rebuild -g piweb` 重试。安装同时注册 `pi` 与 `piweb` 两个命令（`pi web` 启动界面，其它参数转发给官方 pi CLI）；如果同时全局安装了官方 `pi` 包，两者会争用同一个 `pi` 命令，最后安装的生效。

### 在本仓库中使用 `pi web`

支持在任何终端中输入 `pi web`（不区分大小写：`pi web`、`PI WEB`、`Pi Web`）直接启动 Web 界面：

```bash
# 全局注册 pi 与 piweb 命令（首次一次性执行）
npm link

# 任意终端直接启动（不区分大小写）
pi web
```

也可以直接通过 npm 启动：

```bash
# 启动服务（默认 http://127.0.0.1:30141，端口占用自动 +1，自动打开浏览器）
npm run web
# 或
npm start
```

### 命令行参数（bin/piweb.js）

```
-p, --port <port>      监听端口（默认 30141，env PORT；被占用自动 +1）
-H, --hostname <host>  绑定地址（默认 127.0.0.1，env PI_WEB_HOSTNAME）
--dev                  以开发模式启动（`next dev`；env PI_WEB_DEV=1；没有生产构建时也会自动走此模式）
--no-open              不自动打开浏览器（env PI_WEB_NO_OPEN=1）
-h, --help             帮助信息
```

环境变量：`PI_WEB_PASSWORD` 开启浏览器登录会话，并为 API 客户端保留 HTTP Basic Auth（用户名 `pi`）；生产模式绑定非本机地址时**必须**设置。开发模式仅允许本机回环地址，即使设置密码也不能对外监听；没有生产构建时，对外启动会明确失败，不会自动暴露开发服务器。远程访问请使用 HTTPS 或可信 VPN。`PI_WEB_EDITOR` 指定「用编辑器打开」使用的编辑器（默认 `code`）。未设密码时只接受 `Host` 为本机回环地址的请求。

`GET /api/health` 仅公开固定服务标识，让启动器无需向未知端口发送凭据。版本信息改由需要认证的 `/api/version` 返回。工具预设限制的是智能体可用工具，不是操作系统沙箱；已安装扩展使用服务进程本身的权限运行。

模型目录探测默认拒绝回环、私网及保留网段地址。如果确实使用本地模型网关，可在启动 PiWeb 前设置 `PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY=1`。此开关只放宽模型目录探测，请仅在可信的 PiWeb 实例上使用。

### 开发与测试

```bash
npm run dev        # 启动热重载开发服务器
npm run typecheck  # TypeScript 类型检查
npm test           # 服务、协议和组件回归测试
npm run check      # 完整流水线校验（类型 + 测试 + 生产构建）
npm run build:release # 校验并准备独立生产构建，不覆盖运行中的构建
```

## 状态与已知限制（2026-09-14）

审查后的修复已合入本分支并完成一次隔离发布与本地生产部署：登录页生产构建、经过 Next.js 代理的上传完整性、扩展运行时按会话隔离与重载后的工具权限、模型及设置的无损写入、输入草稿与扩展待答界面的生命周期、Git/Growth/diff 正确性，以及隔离发布构建。

最近一次本地验证通过 TypeScript 检查、**52 个测试文件中 355 项通过、1 项跳过**、`npm run build` 与 `git diff --check`。跳过项需要 Windows 符号链接权限或开发者模式。

已知限制：模型配置保存会规范化为标准 JSON（注释格式不保留，数据保留）；更新在维护窗口内原地更新依赖，不是零停机；自定义工具白名单只存在于会话生命周期内；不隔离第三方扩展模块的全局变量。

## 生产构建与更新

PiWeb 正在运行时，请使用 `npm run build:release` 准备新构建。它先校验类型与测试，再将产物写入全新的 `.next-releases/<id>`，全部成功后才发布供下次启动使用的构建记录。它不会重启服务或覆盖现有进程使用的产物。`npm start` 选择最后成功准备的发布构建；发布失败或中断后会明确报错，而不是悄悄回退旧构建。排除错误后重新运行 `npm run build:release` 即可恢复。

界面中的更新使用同一校验流程。源码和 npm 依赖仍在安装目录中更新，因此应在没有智能体运行轮次的维护窗口执行。这不是依赖完全隔离的零停机发布系统。成功更新后由用户手动重启 PiWeb；运行中的进程不会自动切换构建。

CI 在 Linux、Windows 与 Node.js 22.19.0、24 上执行完整检查。普通 `npm run build` 仍使用 `.next`；若生产进程正在使用该目录，不要直接覆盖构建。

## 发布到 npm

**每次推送到 `main` 都会自动发一个版本**，由 `.github/workflows/publish.yml` 完成：

1. 升一个 patch 版本号（`package.json` 始终是版本的唯一来源）；
2. 执行 `prepublishOnly` 门槛（`npm run check`：类型检查 + 测试 + 构建）并发布到 npm；
3. 把版本提交和 `v*` tag 推回 `main`。

npm 上已存在的版本会自动跳过（不会因重复版本号失败），工作流自己产生的发布提交不会再次触发。门槛任一环节失败都不会发布。

```bash
# 日常开发：推送即发布
git push origin main
# 之后拉取工作流提交的版本号变更
git pull --rebase origin main
```

一次性准备：在 npmjs.com 生成 **Automation Token**，存为仓库 secret `NPM_TOKEN`；没有它发布步骤会以鉴权错误失败。某次推送不想发版（例如只改文档），在提交信息里加 `[skip ci]` 即可。

用户想升级时自行执行：

```bash
npm install -g piweb@latest
```

## 架构

```
浏览器 (React 19 + Tailwind, src/components)
   │  REST 命令 (POST /api/agent/[id]) + SSE 事件流 (GET /api/agent/[id]/events)
   ▼
Next.js 服务端 (src/app/api, src/lib)
   ├─ agent-manager    AgentSession 池：惰性冷启动、事件翻译、空闲回收（10min/最多 6）
   ├─ session-reader   直读 ~/.pi/agent/sessions/**.jsonl（冷渲染不开 agent）
   ├─ trajectory       轨迹账本 + 服务端计时（TTFT/decode）
   ├─ skills/prompts   技能与 Prompt 模板发现 + SKILL.md frontmatter 开关
   ├─ models-service   模型目录/认证/OAuth 桥/models.json
   ├─ security-service 工具预设 + 项目信任
   ├─ plugins-service  pi 包安装/卸载/更新（DefaultPackageManager）+ 扩展清单
   ├─ workspace-store  手动添加的工作区（web-workspaces.json）+ 原生选文件夹
   ▼
@earendil-works/pi-coding-agent  (官方 SDK，pi 未修改)
```

## 开源协议

[MIT License](LICENSE)
