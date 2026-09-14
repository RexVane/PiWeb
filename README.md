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

**Prerequisites**: Node.js ≥ 22.19.0 (Node.js 24 recommended) and Git for repository and growth-history features.

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
--dev                  Start in development mode (`next dev`; env PI_WEB_DEV=1; also used when no production build exists)
--no-open              Do not automatically open browser (env PI_WEB_NO_OPEN=1)
-h, --help             Show help
```

Environment variables: `PI_WEB_PASSWORD` enables a browser login session and HTTP Basic Auth for API clients (user `pi`). It is **required** for any non-loopback production bind address. Development mode is loopback-only, even with a password; if no production build exists, an external bind fails rather than falling back to an exposed development server. Use HTTPS or a trusted VPN for remote access. `PI_WEB_EDITOR` overrides the editor used by "open in editor" (default `code`). Without a password, PiWeb only accepts requests whose `Host` is loopback.

`GET /api/health` exposes only a fixed service identifier for credential-free startup probes. Runtime versions are available from the authenticated `/api/version` endpoint. Tool presets limit the tools offered to the agent; they are not an operating-system sandbox, and installed extensions run with the server process's permissions.

Model catalog discovery blocks loopback, private, and reserved network addresses by default. If you intentionally use a local model gateway, set `PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY=1` before starting PiWeb. This relaxes the discovery endpoint only; use it only on a trusted PiWeb instance.

### Development

```bash
npm run dev        # Run Next.js in development mode
npm run typecheck  # TypeScript check
npm test           # Service, protocol and component regressions
npm run check      # Full check (types + tests + build)
npm run build:release # Validate and stage a production build without replacing the running build
```

## Remediation status (2026-09-14)

The audit follow-up is implemented in the current **uncommitted** worktree. It covers the production login build, upload integrity through the Next.js proxy, per-session extension isolation and tool-policy reloads, lossless model/settings writes, composer and pending-extension-UI lifecycle, Git/Growth/diff correctness, and isolated release preparation. An isolated production integration run passed the 11 MiB upload, extension isolation, readonly reload, pending UI reconnect, and prompt acceptance/follow-up checks.

The latest local validation passed TypeScript checking, **355 tests across 52 files** (one additional test skipped), `npm run build`, and `git diff --check`. The skipped test requires Windows symlink privileges or Developer Mode. The build still emits a non-fatal webpack dynamic-dependency warning from `scripts/release.mjs`.

This is not a live-deployment sign-off: real OAuth, an actual external update/install, and restarting the existing PiWeb service were not performed. The isolated release check passed, but the running service will continue using its current build until restarted during a maintenance window.

## Production builds and updates

Use `npm run build:release` when preparing a build while PiWeb is running. It validates types and tests, builds into a fresh `.next-releases/<id>` directory, and only then publishes the build selection for the next start. It does not restart the server or replace the output used by an existing process. `npm start` uses the last successfully prepared release; after a failed or interrupted release attempt it reports the problem instead of silently serving a stale build. Correct the error and run `npm run build:release` again to recover.

The in-app updater uses the same validation path. Source files and npm dependencies are still updated in the installation directory, so perform updates during a maintenance window with no running agent turns. This is not a fully isolated zero-downtime deployment system. Restart PiWeb manually after a successful update; running processes do not automatically switch to the new build.

CI runs the full checks on Linux and Windows with Node.js 22.19.0 and 24. Ordinary `npm run build` still uses `.next`, so do not run it against an installation whose active production process is using that directory.

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
