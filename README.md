# PiWeb

<p align="center">
  <strong>A modern, responsive web UI for the Pi Coding Agent — inspired by DeepSeek Harness (dsh).</strong>
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

---

<a name="english"></a>
## English

**PiWeb** brings a sleek, feature-rich web interface to the [pi coding agent](https://github.com/earendil-works/pi) with zero modifications to the core Pi engine. Built with Next.js and Tailwind CSS, it aligns visually and interactively with DeepSeek Harness (dsh).

### Key Features

- **Real-Time Streaming**: Full SSE snapshots with ordered deltas, automatic replay via `Last-Event-ID`, real-time thinking process and inline tool executions.
- **Composer & Input**: Image attachments (paste, pick, drag-and-drop), 2-level model selection, cycle models forward/backward, queue management (steering / follow-up), and `/` slash commands.
- **Decoupled Workspaces & Sessions**: Group sessions by workspace folders, native system folder picker on Windows, rename/delete workspaces with custom centered confirmation modals, preserve sessions under "Ungrouped", and maintain empty workspaces.
- **Session Exploration**: Session tree branch visualization & navigation, user message draft recovery, export session logs to JSONL / HTML, and trajectory views.
- **Comprehensive Settings**:
  - **General**: Tool presets (Read Only / Workspace Write / Full Access), language (zh/en), appearance, enter key behaviors, and auto-compact.
  - **Models**: Manage 30+ built-in providers, custom providers in `models.json`, and OAuth logins (Claude, Codex, Copilot, etc.).
  - **Plugins & Skills**: View and manage extensions and skills directly via Pi's built-in package manager.
- **Security & Sandboxing**: Optional HTTP Basic Auth via `PI_WEB_PASSWORD`, origin validation on write actions, and strict path boundary checks.

### Quick Start

**Prerequisites**: Node.js ≥ 22.

```bash
# Install dependencies
npm install

# Build frontend
npm run build

# Start PiWeb (defaults to http://127.0.0.1:30141 and auto-opens browser)
npm start
```

#### CLI Options (`bin/piweb.js`)

```
-p, --port <port>      Listen port (default 30141, env PORT; auto-increments if in use)
-H, --hostname <host>  Bind address (default 127.0.0.1, env PI_WEB_HOSTNAME)
--no-open              Do not automatically open browser (env PI_WEB_NO_OPEN=1)
-h, --help             Show help
```

#### Development

```bash
npm run dev        # Run Next.js in development mode
npm run typecheck  # TypeScript check
npm test           # Vitest security & protocol tests
npm run check      # Full check (types + tests + build)
```

### Architecture

```
Browser (React 19 + Tailwind, src/components)
   │  REST commands (POST /api/agent/[id]) + SSE streams (GET /api/agent/[id]/events)
   ▼
Next.js Server (src/app/api, src/lib)
   ├─ agent-manager    AgentSession pool: lazy startup, event translation, idle eviction
   ├─ session-reader   Direct read ~/.pi/agent/sessions/**.jsonl (cold render without running agent)
   ├─ trajectory       Trajectory ledger + server-side timing (TTFT / decode)
   ├─ skills/prompts   Skills & Prompt template discovery + frontmatter toggles
   ├─ models-service   Model catalogue, auth, OAuth bridge & models.json
   ├─ security-service Tool presets & project trust
   ├─ plugins-service  Pi package management (DefaultPackageManager) & extension registry
   ├─ workspace-store  Persistent workspaces registry & native folder picker
   ▼
@earendil-works/pi-coding-agent  (Official Pi SDK, zero engine modifications)
```

### License

[MIT License](LICENSE)

---

<a name="中文"></a>
## 中文

**PiWeb** 是为 [pi 编程智能体](https://github.com/earendil-works/pi) 打造的 **dsh 式** 现代 Web 界面：`npm start` 一键启动，提供实时流式对话、工作区会话管理、会话树分支跳转、技能/插件/模型管理，**pi 本身零改动**。

- **引擎**：官方 npm 包 `@earendil-works/pi-coding-agent`（进程内 SDK），使用精确版本锁；`npm run update:pi` 独立升级和验证上游引擎。
- **界面**：视觉与交互对齐 [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) Web 端 —— `--dsw-*` 实色面板、三栏框架（侧栏可收起为 56px 导轨 + 拖拽调宽）、22px 输入卡、ic_ds 图标与 π 官方图标。
- **原则**：工具、模型、技能和插件机制完全使用 Pi 官方原生方案；会话与工作区结构保持兼容。

### 功能亮点

- **实时流式交互**：SSE 完整快照 + 有序增量同步，支持 `Last-Event-ID` 断线补发，逐字平滑渲染；思考链（Thinking）与工具调用内联展示；多标签页 3 秒自动同步。
- **输入卡与控制**：支持图片附件（选择 / 粘贴 / 拖放）、两级模型选择与快速循环切换、上下文压缩、停止生成、清空队列及 `/` 斜杠命令面板（内置命令 + Pi 模板 + 技能）。
- **解耦的工作区与会话**：按项目文件夹分组展示，支持 Windows 原生文件夹选择器；支持空工作区独立留存；删除工作区弹出全局居中确认弹窗，文件夹与会话文件均安全保留并自动归集到“未分组”下。
- **会话管理**：支持导出会话日志为 JSONL / HTML、会话树分支可视化跳转与草稿恢复、AGENTS.md 上下文注入展示，以及轨迹性能视图（TTFT / 解码耗时）。
- **多功能设置**：
  - **通用**：工具权限预设（只读 / 工作区写入 / 完全访问）、中英双语切换、外观偏好、Enter 键行为、自动重试及自动压缩。
  - **模型**：支持 30+ 官方内置 Provider、添加自定义提供方（写入 `models.json`）及 OAuth 登录（Claude / Codex / Copilot 等）。
  - **插件与技能**：通过 Pi 原生包管理器安装、卸载、更新扩展，并支持即时开关 Skill。
- **安全防护**：可通过 `PI_WEB_PASSWORD` 开启 HTTP Basic Auth；写接口严格执行同源与路径边界校验。

### 快速开始

**环境要求**：Node.js ≥ 22。

```bash
# 安装依赖
npm install

# 构建前端
npm run build

# 启动服务（默认 http://127.0.0.1:30141，端口占用自动 +1，自动打开浏览器）
npm start
```

#### 命令行参数（bin/piweb.js）

```
-p, --port <port>      监听端口（默认 30141，env PORT；被占用自动 +1）
-H, --hostname <host>  绑定地址（默认 127.0.0.1，env PI_WEB_HOSTNAME）
--no-open              不自动打开浏览器（env PI_WEB_NO_OPEN=1）
-h, --help             帮助信息
```

#### 开发与测试

```bash
npm run dev        # 启动热重载开发服务器
npm run typecheck  # TypeScript 类型检查
npm test           # Vitest 安全边界与协议测试
npm run check      # 完整流水线校验（类型 + 测试 + 生产构建）
```

### 开源协议

[MIT License](LICENSE)
