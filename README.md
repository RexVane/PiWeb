# PiWeb

<p align="center">
  <strong>A modern web UI for the Pi Coding Agent.</strong>
</p>

<p align="center">
  <strong>English</strong> | <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/main.png" alt="PiWeb main screen: session sidebar, streaming chat, and tool cards" width="840" />
</p>

---

**PiWeb** brings a sleek, feature-rich browser interface to the [pi coding agent](https://github.com/earendil-works/pi) with zero modifications to the core Pi engine. Built with Next.js and Tailwind CSS.

## Key Features

### Streaming chat

Markdown is laid out while the answer is still being written: headings, lists, tables and code blocks take shape before the reply finishes. Thinking and tool calls sit in the thread as cards. A dropped connection resumes from `Last-Event-ID`, and open tabs line up about every 3 seconds. The composer takes images (pick, paste, or drop), a two-level model picker, compaction, stop, queue clear, and `/` commands (built-ins, Pi templates, and skills).

<p align="center"><img src="assets/main.png" alt="Main screen: streaming chat and tool cards" width="840" /></p>

### Conversation outline

The rail on the right of the thread is an outline. Your own messages are bold; the rest are headings from the reply. Collapsed, it is a column of ticks, shorter for deeper headings. Hover to open the list. Scrolling highlights the current item, and a click jumps there.

<p align="center"><img src="assets/outline.png" alt="Conversation outline: your messages are bold" width="840" /></p>

### Trajectory and files

A file-changing tool card inlines the diff, green for additions and red for deletions, with a +N −M count. From the card you can open that step in the trajectory, or open the file in your editor. The trajectory puts the step on three lanes — input, model, and tools — laid out by sequence, time, or duration. The detail pane has Summary, Preview, Raw, and Source. A sent message can be edited and resent in place, or withdrawn so the thread returns to just before it. The old branch stays in the session file.

<p align="center"><img src="assets/trace-1.png" alt="Inline diff on a tool card" width="840" /></p>
<p align="center"><img src="assets/trace-2.png" alt="Open in editor, and view in the trajectory" /> <img src="assets/trace-3.png" alt="Open in editor" /> <img src="assets/trace-4.png" alt="View in the trajectory" /></p>

### Workspaces and sessions

Sessions are grouped by project folder. A system folder picker adds a workspace, and an empty workspace can stay on its own. Archived sessions sit under Archived in the sidebar, and can be opened again or unarchived. A session exports as JSONL or HTML, and the session tree jumps to another branch. Removing a workspace leaves the folder and the session files in place; the sessions move under Ungrouped.

<p align="center"><img src="assets/archive.png" alt="Archived sessions collected in the sidebar" width="400" /></p>

### Project growth, one git commit per round

Each round pi finishes is committed in the workspace's own `.git`, on `refs/piweb/rounds/<key>`. Your branches, HEAD, and the index are left alone. The project column lists the files that round changed against the previous one, with line counts, and opening a file shows that round's diff. Edits you make between rounds are recorded on their own. Each prompt in the chat links to its round.

<p align="center"><img src="assets/growth-1.png" alt="Project column: files changed in this round" width="840" /></p>
<p align="center"><img src="assets/growth-2.png" alt="Open a file to see that round's diff" width="840" /></p>

### File viewer

Project files open in the page: several tabs, and `+` to find a file. The same file can be shown as a change (the whole-file diff, with previous and next change), as content (line numbers and highlighting; a deleted file shows what it was), or rendered (Markdown). A selection can be quoted into the composer, or opened in a local editor.

<p align="center"><img src="assets/viewer-1.png" alt="File viewer: rendered Markdown" width="840" /></p>
<p align="center"><img src="assets/viewer-2.png" alt="File viewer: source with line numbers" width="840" /></p>

### Context meter

The ring beside the composer splits the context window into segments: system prompt, tools, memory (`AGENTS.md`), skills, the kinds of messages, compacted content, the auto-compact reserve, and free space. The numbers are character estimates.

### Models and providers

Thirty-plus built-in providers, with an API key or OAuth (Claude, Codex, Copilot, and others). A custom provider is written to `models.json`. A custom model can declare thinking support, which levels it offers, the value each level sends, and whether it accepts images. Thinking levels are pi's own. A new session starts from the default model and level in pi's `settings.json`, the same file the terminal uses.

<p align="center"><img src="assets/providers-1.png" alt="Provider settings: keys, OAuth, and usage" width="840" /></p>
<p align="center"><img src="assets/providers-2.png" alt="Add a provider from the built-in list" width="840" /></p>
<p align="center"><img src="assets/providers-3.png" alt="Custom provider: endpoint, protocol, and models" width="840" /></p>

### Plugins and skills

Extensions are installed, updated, and removed with Pi's package manager. A skill can be enabled, disabled, or deleted; a single-file skill removes only that file.

### pi's eyes

With Chrome, Edge, or Chromium installed, pi gains `browser_open`, `browser_screenshot`, `browser_console`, `browser_click`, and `browser_type`. It opens your dev server in a headless browser, looks at the screenshot (a text outline when the model cannot see images), reads console errors and failed requests, and keeps editing. Screenshots show up in the chat. Pick element on a screenshot, then click a piece of the page: it lands in the composer as a chip with its DOM path and source location, plus a crop when the model can see images.

### Security

`PI_WEB_PASSWORD` turns on the login page. API clients can still send HTTP Basic with the user `pi`. Repeated wrong passwords are throttled. Writes must come from the same origin, and paths cannot leave the workspace or the session directory. The tool presets (read-only, workspace write, full access) only limit which tools the agent is offered. They are not an operating-system sandbox.

## Quick Start

**Prerequisites**: Node.js ≥ 22.19.0 (Node.js 24 recommended) and Git for repository and growth-history features. Growth history lives in the workspace's own `.git`: non-git folders are `git init`-ed automatically before the first commit, and one commit per round hangs off a dedicated `refs/piweb/rounds/<key>` ref without touching your branches, HEAD or staging area. Optional: Chrome, Edge or Chromium for pi's browser tools (Edge ships with Windows).

### Install from npm (recommended)

```bash
npm install -g @rexvane/piweb
piweb
```

A global install prepares the production bundle once (during install, or on the first run if the script was skipped) and then starts in production mode. If that build fails, `piweb` reports it instead of falling back to a development server that cannot work without dev dependencies; retry with `npm rebuild -g @rexvane/piweb`. The package registers only the `piweb` command, so it never conflicts with the official `pi` CLI (`npm i -g @earendil-works/pi-coding-agent`) if you have both.

To update an npm install, stop `piweb`, run `npm install -g @rexvane/piweb@latest`, then start it again; when a newer release is out, Check for updates under Settings → General → PiWeb version shows this command. npm replaces the whole package folder, so do not update it under a running `piweb`. The pi engine is pinned by each PiWeb release and updates with it.

### Inside this repository

```bash
npm install
npm run dev        # development server with hot reload
```

Or run a production build locally:

```bash
npm install
npm run build      # or: npm run build:release (staged, does not touch a running build)
npm start          # serves on http://127.0.0.1:30141 (auto-increments if busy)
```

### CLI Options (`bin/piweb.js`)

```
-p, --port <port>      Listen port (default 30141, env PORT; auto-increments if in use)
-H, --hostname <host>  Bind address (default 127.0.0.1, env PI_WEB_HOSTNAME)
--dev                  Start in development mode (`next dev`; env PI_WEB_DEV=1; also used when no production build exists)
--no-open              Do not automatically open browser (env PI_WEB_NO_OPEN=1)
-h, --help             Show help
```

Environment variables: `PI_WEB_PASSWORD` enables a browser login session and HTTP Basic Auth for API clients (user `pi`). Wrong passwords are throttled for the whole server: after 10 new wrong ones, password checks allow one try every 30 seconds, and signed-in browsers are not affected. It is **required** for any non-loopback production bind address. Development mode is loopback-only, even with a password; if no production build exists, an external bind fails rather than falling back to an exposed development server. Use HTTPS or a trusted VPN for remote access. `PI_WEB_EDITOR` overrides the editor used by "open in editor" (default `code`). `PI_WEB_BROWSER` points pi's browser tools at a specific Chrome / Edge / Chromium executable (default: auto-detect); the tools only open loopback and private-network pages unless `PI_WEB_BROWSER_ALLOW_PUBLIC=1` is set. Without a password, PiWeb only accepts requests whose `Host` is loopback.

`GET /api/health` exposes only a fixed service identifier for credential-free startup probes. Runtime versions are available from the authenticated `/api/version` endpoint. Tool presets limit the tools offered to the agent; they are not an operating-system sandbox, and installed extensions run with the server process's permissions.

Model catalog discovery blocks loopback, private, and reserved network addresses by default. If you intentionally use a local model gateway, set `PI_WEB_ALLOW_PRIVATE_MODEL_DISCOVERY=1` before starting PiWeb. This relaxes the discovery endpoint only; use it only on a trusted PiWeb instance.

### Growth history in Git

Each round is a regular commit, so any Git tool can read the history:

```bash
git for-each-ref refs/piweb/rounds/        # this workspace's ref (one per worktree)
git log --stat refs/piweb/rounds/<key>      # one commit per round: title = your prompt, Piweb-* trailers = session / status
```

Builds before rounds kept per-tool snapshots under `refs/piweb/growth/` plus `.git/piweb/ledger.jsonl`; the current version no longer reads them. To remove them:

```bash
git for-each-ref --format="delete %(refname)" refs/piweb/growth/ | git update-ref --stdin
rm .git/piweb/ledger.jsonl
```

### Development

```bash
npm run dev        # Run Next.js in development mode
npm run typecheck  # TypeScript check
npm test           # Service, protocol and component regressions
npm run check      # Full check (types + tests + build)
npm run build:release # Validate and stage a production build without replacing the running build
```

## Status and known limitations (2026-10-07)

The audit follow-up is merged into this branch and has been through an isolated release plus a local production deployment. It covers the production login build, upload integrity through the Next.js proxy, per-session extension isolation and tool-policy reloads, lossless model/settings writes, composer and pending-extension-UI lifecycle, Git/Growth/diff correctness, and isolated release preparation.

Since then PiWeb gained element picking on pi's browser screenshots, thinking levels that follow pi's own model settings, and editing or withdrawing sent messages. Deleting a skill now follows pi's skill layout (a single-file skill removes only that file), npm installs build and check for updates correctly, and password checks are throttled. Saving the model configuration in Settings now updates sessions that are already open; answers are laid out as Markdown while they are still being written; and emptying a built-in provider override removes the whole block (it used to write an empty block that pi rejects, so the save failed).

Latest validation: TypeScript checking passes locally on Windows with **496 tests across 79 files** (one more skipped: a growth-history test that needs symlink privileges; on Linux the skipped one is a Windows-only PowerShell encoding test); CI runs the full pipeline (types, tests, production build) on Linux and Windows with Node.js 22.19.0 and 24, and passes. The real-browser tests need Chrome, Edge or Chromium and are skipped without one.

Known limitations: saving the model configuration normalizes it to plain JSON (comments are not preserved, data is); updates replace dependencies in place during a maintenance window rather than being zero-downtime; a custom tool allowlist lives only for the session lifetime; third-party extension module globals are not isolated. Editing or withdrawing a sent message rewinds the conversation, not the files the agent already changed (use the growth history for those). Password throttling is server-wide, so while someone keeps guessing, password sign-in waits for everyone. Non-image files dropped into the composer are kept in `~/.pi/agent/web-uploads/` because sessions refer to them by path; remove old ones by hand. Growth history: when two sessions run in the same workspace at once, changes can land in the other session’s round; changes made with shell commands inside a round only show up in that round’s summary (edit/write diffs are still in the conversation). Browser tools are offered only under the Workspace Write and Full access tool presets; the headless browser uses a temporary profile, so after PiWeb restarts you need to sign in to the app under test again; screenshots are stored in the session JSONL like other images; the address policy only stops the tools from opening public addresses and does not restrict what the page itself loads.

## Production builds and updates

Use `npm run build:release` when preparing a build while PiWeb is running. It validates types and tests, builds into a fresh `.next-releases/<id>` directory, and only then publishes the build selection for the next start. It does not restart the server or replace the output used by an existing process. `npm start` uses the last successfully prepared release; after a failed or interrupted release attempt it reports the problem instead of silently serving a stale build. Correct the error and run `npm run build:release` again to recover.

The in-app updater uses the same validation path. Source files and npm dependencies are still updated in the installation directory, so perform updates during a maintenance window with no running agent turns. This is not a fully isolated zero-downtime deployment system. Restart PiWeb manually after a successful update; running processes do not automatically switch to the new build. This applies to Git checkouts: for an npm install the updater only compares with the registry and shows the npm command (see Install from npm).

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
   ├─ growth-*         Project growth: one commit per round on refs/piweb/rounds/<key>, timeline via git log
   ├─ browser/*        pi's eyes: headless Chrome / Edge over a CDP pipe, browser tools + screenshots
   ▼
@earendil-works/pi-coding-agent  (Official Pi SDK, zero engine modifications)
```

## License

[MIT License](LICENSE)
