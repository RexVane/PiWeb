# PiWeb

<p align="center">
  <strong>A modern web UI for the Pi Coding Agent.</strong>
</p>

<p align="center">
  <strong>English</strong> | <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/readme-chat.jpg" alt="PiWeb on desktop: workspace, conversation and tool calls" width="840" />
</p>

---

**PiWeb** brings the [pi coding agent](https://github.com/earendil-works/pi) to desktop and mobile browsers. Organize workspaces, review conversations and file changes, configure models, and import conversations from other coding tools. Your existing pi configuration and data are available after installation.

## Relationship to pi

PiWeb and pi are two separate programs, and PiWeb is not another build of pi: it is a web shell that bundles the official pi SDK, leaving the separately installed pi CLI untouched. The two **share one set of state** — the same agent directory (`~/.pi/agent`) holds your settings, models and credentials, sessions, skills and packages — so a conversation started in the pi CLI shows up in the browser right away, and the other way round. The bundled pi engine is upgraded with PiWeb releases. Only PiWeb checks for updates automatically; the pi version and a manual update entry remain in Settings. What runs underneath is native pi; plugin compatibility in the browser, interactive plugins especially, is not finished yet — for now plugins can be managed rather than fully driven from the page.

## Features

- **Chat and navigation:** Stream Markdown, reasoning and tool calls; jump through the conversation outline and steer or queue messages while pi is working. The context ring shows usage and its breakdown.
- **Workspaces and sessions:** Group conversations by project folder; rename, branch, archive, recover drafts and export to JSONL or HTML.
- **Session import:** Browse and import local history from Claude Code, Codex, Grok, ZCode, dsh and opencode. Search and select across sources, restore archived imports, and leave the original data untouched.
- **Review changes:** Explore tool trajectories, file diffs and the project growth tree. The file viewer supports content, changes and rendered Markdown, with selection quoting.
- **Models and extensions:** Manage built-in and custom providers, models, pi packages and skills; inspect prompt sources and choose Read Only, Workspace Write or Full Access tool presets.
- **Multiple devices:** Use PiWeb from desktop and mobile browsers, with built-in local-network access or a Cloudflare quick tunnel for remote access.

## Screenshots

### Desktop

<table>
  <tr>
    <td width="50%"><img src="assets/readme-chat.jpg" alt="Desktop conversation" /><br /><strong>Conversation workspace</strong><br />Stream responses and review tool calls alongside your sessions.</td>
    <td width="50%"><img src="assets/readme-desktop-project.jpg" alt="Desktop project tree" /><br /><strong>Project files</strong><br />Browse the project and changes for each round.</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-files.jpg" alt="Desktop file viewer" /><br /><strong>File viewer</strong><br />Inspect code, file contents and changes.</td>
    <td width="50%"><img src="assets/readme-desktop-import.jpg" alt="Desktop session import" /><br /><strong>Session import</strong><br />Choose conversations from other coding tools.</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/readme-desktop-models.jpg" alt="Desktop provider selection" /><br /><strong>Model providers</strong><br />Find and configure a provider.</td>
    <td width="50%"><img src="assets/readme-desktop-context.jpg" alt="Desktop context usage" /><br /><strong>Context usage</strong><br />Inspect the context window and its breakdown.</td>
  </tr>
</table>

### Mobile

<table>
  <tr>
    <td width="33%"><img src="assets/readme-mobile.jpg" alt="Mobile conversation" /><br /><strong>Chat on the go</strong><br />Continue working from your phone.</td>
    <td width="33%"><img src="assets/readme-mobile-workspaces.jpg" alt="Mobile workspaces" /><br /><strong>Workspaces</strong><br />Switch projects and sessions.</td>
    <td width="33%"><img src="assets/readme-mobile-import.jpg" alt="Mobile session import" /><br /><strong>Session import</strong><br />Select and import conversations.</td>
  </tr>
  <tr>
    <td width="33%"><img src="assets/readme-mobile-files.jpg" alt="Mobile file viewer" /><br /><strong>File viewer</strong><br />Browse project code.</td>
    <td width="33%"><img src="assets/readme-mobile-models.jpg" alt="Mobile provider selection" /><br /><strong>Model setup</strong><br />Find and configure providers.</td>
    <td width="33%"><img src="assets/readme-mobile-context.jpg" alt="Mobile context usage" /><br /><strong>Context usage</strong><br />See usage and available space.</td>
  </tr>
</table>

### Archives and data

Archived sessions can be viewed or restored from the sidebar. A background cleanup deletes archived sessions after 30 days, counting from the later of the archive time or subsequent activity; sessions currently in use are skipped. Deletion removes the session file, so export anything you need to keep beforehand.

The project growth tree stores each round of file changes as a commit under `refs/piweb/rounds/…` in the workspace's Git repository, without changing branches or the index. If the workspace is not its own Git repository, PiWeb asks before initializing one; declining disables recording there.

## Usage

### Install

```bash
npm install -g @rexvane/piweb
piweb
```

The package registers only the `piweb` command, so it never conflicts with the official `pi` CLI. Requires Node.js ≥ 22.19.0 (24 recommended); Git is needed for growth-history features.

### Update

```bash
npm install -g @rexvane/piweb@latest
```

npm replaces the installed version in place, so there is nothing to uninstall first. `latest`
is npm's default tag, so `npm install -g @rexvane/piweb` behaves identically; if your registry
is a mirror that syncs with a delay, add `--registry=https://registry.npmjs.org` to get a
release the moment it is published. Restart `piweb` afterwards to serve the new version.

Or install a specific version: `npm install -g @rexvane/piweb@0.3.29`.

**Updating from the UI**: every time PiWeb starts it checks PiWeb for new versions in the
background. When one is available it prints `[更新] 有新版本：…` in the terminal and shows a notice
in the bottom-right corner of the page (once per start). Click "Update" in the notice or in
Settings → General to install in place — no trip to the repository. Restart `piweb` when it says
so; the process never restarts itself.

- PiWeb releases include a tested pi engine version. Pi does not show automatic update notices; Settings still supports a manual check.
- On Windows a running npm install cannot replace itself (files are locked), so the PiWeb entry shows the command with a copy button: stop `piweb` first, then run the command above.
- To skip the network check, set `PI_WEB_UPDATE_CHECK=0` before starting; "Check for updates" in Settings still works.

### Uninstall

```bash
npm uninstall -g @rexvane/piweb
```

This removes PiWeb only — your pi data lives in `~/.pi/agent/` and is left untouched.

### Run

```bash
piweb                    # http://127.0.0.1:30141 (auto-increments if busy)
piweb -p 30143 --no-open # custom port, don't open the browser
piweb -H 0.0.0.0         # LAN access (launch-token login is enabled automatically)
```

| Option | Description |
| --- | --- |
| `-p, --port <port>` | Listen port (default 30141, env `PORT`) |
| `-H, --hostname <host>` | Bind address (default 127.0.0.1, env `PI_WEB_HOSTNAME`) |
| `--dev` | Development mode |
| `--no-open` | Do not auto-open the browser |
| `--public-url <url>` | Public address, used for the login link and added to the Host allowlist automatically (env `PI_WEB_PUBLIC_URL`) |

Authentication is opened by `PI_WEB_AUTH=1` (the launcher sets it by default whenever PiWeb may be reachable from
outside this machine). Login is **launch-token only**: open the printed `…/?token=…` link, which exchanges the token
for a signed cookie. `PI_WEB_PASSWORD` has been removed — setting it makes the launcher refuse to start. Do not
expose PiWeb over plain HTTP.

Scripts authenticate the same way: `GET /?token=…` once to receive the session cookie, then send that cookie with
every API request. There is no Basic Auth fallback.

### Use it on your phone: the built-in "Remote access" plugin

PiWeb ships a built-in plugin for this. Toggle it in **Settings → Remote access**; nothing is installed on the client.

It has two entry points:

**Local network (on by default)** — a reverse proxy that only adds the mobile layout, bound to `0.0.0.0:30142`.
Any device on the same Wi-Fi can open one of the addresses listed in the panel and gets the phone layout;
connecting to `127.0.0.1:30141` on this machine still serves the untouched desktop page.

**Public access (off by default)** — turning it on starts a Cloudflare quick tunnel (`cloudflared`).
Cloudflare assigns an `https://<random>.trycloudflare.com` address that any browser can open with
**nothing to install on any device**. Two costs:

- the address changes on every start, and takes about fifteen seconds to resolve worldwide
  (the panel shows "taking effect" meanwhile);
- TLS terminates at Cloudflare, so that hop sees plaintext. Use a trusted VPN if you need end-to-end encryption.

`cloudflared` is looked up as: `PIWEB_CLOUDFLARED` → `<agent dir>/web-bin/cloudflared{,.exe}` (managed by PiWeb) → `PATH`.
The panel says so explicitly when it cannot find it.

> Turning public access on makes authentication mandatory. The plugin adds the tunnel hostname to the Host
> allowlist once the tunnel is live and removes it when the tunnel stops. The launch token is never accepted
> on API paths or through the `Authorization` header.

### Bring your own reverse proxy or tunnel

You can front PiWeb yourself instead (Caddy, nginx, a named Cloudflare tunnel, a VPN). In that case:

- Point the proxy at **`127.0.0.1:30142`** (the local-network entry) to get the mobile layout, or at
  `127.0.0.1:30141` if you only want the desktop page.
- Set `PI_WEB_AUTH=1`. A loopback bind cannot tell PiWeb that it is exposed, so authentication must be explicit.
- A reverse proxy passes the external hostname through unchanged, so allowlist it or requests are rejected
  with 403 `untrusted host`:

  ```bash
  PI_WEB_TRUSTED_HOSTS=<your-domain> piweb
  ```

- Use `--public-url https://your-address/` to tell PiWeb its public address: the hostname joins the allowlist
  automatically, and the login link printed at startup uses it instead of the loopback address.

> Disable the local-network entry with `PIWEB_REMOTE_LAN=0`; disable authentication entirely with `PI_WEB_AUTH=0`
> (only safe when PiWeb is used strictly on this machine).

## License

[MIT](LICENSE)
