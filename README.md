# PiWeb

<p align="center">
  <strong>A modern web UI for the Pi Coding Agent — inspired by DeepSeek Harness (dsh).</strong>
</p>

<p align="center">
  <strong>English</strong> | <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/showcase.png" alt="PiWeb UI Showcase" width="840" />
</p>

---

**PiWeb** brings a sleek, feature-rich browser interface to the [pi coding agent](https://github.com/earendil-works/pi) with zero modifications to the core Pi engine. Built with Next.js and Tailwind CSS, it aligns visually and interactively with DeepSeek Harness (dsh).

## Key Features

- **Real-Time Streaming**: Full SSE snapshots with ordered deltas, automatic replay via `Last-Event-ID`, real-time thinking process and inline tool execution cards.
- **Composer & Input**: Image attachments (paste, pick, drag-and-drop), 2-level model selector, model cycling forward/backward, queue management (steering / follow-up), and `/` slash commands.
- **Decoupled Workspaces & Sessions**: Group sessions by workspace folders, native system folder picker on Windows, rename/delete workspaces with centered confirmation modals, preserve sessions under "Ungrouped", and maintain empty workspaces independently.
- **Session Exploration**: Session tree branch visualization & navigation, user message draft recovery, export session logs to JSONL / HTML, and trajectory views.
- **Comprehensive Settings**:
  - **General**: Tool presets (Read Only / Workspace Write / Full Access), language (zh/en), appearance, enter key behaviors, and auto-compact.
  - **Models**: Manage 30+ built-in providers, custom providers in `models.json`, and OAuth logins (Claude, Codex, Copilot, etc.).
  - **Plugins & Skills**: View and manage extensions and skills directly via Pi's built-in package manager.
- **Security & Sandboxing**: Optional HTTP Basic Auth via `PI_WEB_PASSWORD`, origin validation on write actions, and strict path boundary checks.

## Quick Start

**Prerequisites**: Node.js ≥ 22.

### Launch via `pi web` (Recommended)

You can launch PiWeb directly from your terminal using `pi web` (case-insensitive: `pi web`, `PI WEB`, `Pi Web`):

```bash
# Link commands globally (one-time setup)
npm link

# Launch anywhere in your terminal (case-insensitive)
pi web
```

You can also run directly with npm:

```bash
# Start PiWeb (defaults to http://127.0.0.1:30141 and auto-opens browser)
npm run web
# or
npm start
```

### CLI Options (`bin/piweb.js`)

```
-p, --port <port>      Listen port (default 30141, env PORT; auto-increments if in use)
-H, --hostname <host>  Bind address (default 127.0.0.1, env PI_WEB_HOSTNAME)
--no-open              Do not automatically open browser (env PI_WEB_NO_OPEN=1)
-h, --help             Show help
```

### Development

```bash
npm run dev        # Run Next.js in development mode
npm run typecheck  # TypeScript check
npm test           # Vitest security & protocol tests
npm run check      # Full check (types + tests + build)
```

## Architecture

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

## License

[MIT License](LICENSE)
