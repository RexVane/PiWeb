# Acknowledgements

PiWeb is released under the [MIT License](LICENSE). This file credits upstream projects PiWeb builds on, and work that comments or vendored files in this repository identify as copied or referenced.

Third-party **dependency license compliance** (including copyleft and data licenses in the npm tree) is documented separately in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Licenses below are taken from files in this repository or from the `license` field of the installed package / `package-lock.json`. Where this repository does not record a license for a referenced project, no license is guessed here.

## Upstream projects

These are direct runtime or framework foundations declared in `package.json` (or invoked as an optional external binary).

| Project | Link | License | PiWeb use |
| --- | --- | --- | --- |
| [Pi Coding Agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-telemetry`, `pi-tui`, `@earendil-works/chord`) | https://github.com/earendil-works/pi | MIT (`package-lock.json`, package `license` field, version 1.6.1) | Bundled SDK: agent runtime, tools, MCP, sessions, and related UI/server integration under `src/` |
| [Next.js](https://github.com/vercel/next.js) | https://github.com/vercel/next.js | MIT (`next@16.4.5` package.json in this install) | App framework: `src/app/`, `next.config.ts`, production build |
| [React](https://github.com/react/react) and React DOM | https://github.com/react/react | MIT (`react@19.3.0` / `react-dom@19.3.0` package.json; repository field `https://github.com/react/react.git`) | UI components under `src/components/` and `src/hooks/` |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | https://github.com/tailwindlabs/tailwindcss | MIT | Styling (`src/app/globals.css`, PostCSS config) |
| [highlight.js](https://github.com/highlightjs/highlight.js) | https://github.com/highlightjs/highlight.js | BSD-3-Clause | Syntax highlighting in the file viewer / Markdown rendering |
| [qrcode](https://www.npmjs.com/package/qrcode) | https://www.npmjs.com/package/qrcode | MIT (`package-lock.json`, `qrcode@1.5.4`) | Connection QR codes for remote access |
| cloudflared | Invoked as an optional executable (`PIWEB_CLOUDFLARED`, `<agent dir>/web-bin/cloudflared`, or `PATH`) | Not recorded in this repository | Production quick tunnel used by `src/lib/remote/` |

The `qrcode` package is recorded in this repository only as the npm dependency of that name; no GitHub URL for it is recorded here.

## Vendored assets

| Project | Link | License | PiWeb files |
| --- | --- | --- | --- |
| [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (`material-icon-theme`) | https://github.com/material-extensions/vscode-material-icon-theme | MIT (copied into `public/file-icons/LICENSE`; copyright “Material Extensions”, 2025) | `public/file-icons/*`, `src/lib/file-icons.json`, `scripts/sync-file-icons.mjs` (`npm run sync:file-icons`) |
| [Lobe Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg`) | https://github.com/lobehub/lobe-icons | MIT (dependency `package.json`) | `public/provider-icons/*`, `scripts/sync-provider-icons.mjs` (`npm run sync:provider-icons`) |

## Referenced design and source

The following items are identified in source comments or docs as the basis for a design or a port. Links are included only when this repository itself records them.

| Project or work | Link (as recorded here) | License in this repo | PiWeb files and what the comments say |
| --- | --- | --- | --- |
| dsh-bloom-theme palettes “ripple” (天青) and “dawn” (粉霞), by [@webkubor](https://github.com/webkubor) | https://github.com/webkubor/dsh-bloom-theme | Not recorded | `src/app/globals.css`, `src/lib/theme.ts`; also thanked in the READMEs |
| pebrel “Paper / Nord” (北欧纸墨) | https://github.com/Kuddev/pebrel | Not recorded | `src/app/globals.css`, `src/lib/theme.ts` |
| dsh “海与墨” appearance, and light / dark / system mode as in dsh `ui-theme` `theme-settings.ts` | No URL recorded | Not recorded | `src/lib/theme.ts`, `src/app/globals.css` (including `--dsh-*` tokens) |
| deepseek-harness launch token and browser-auth design | No URL recorded | Not recorded | `src/lib/web-launch-token.ts`, `src/lib/web-auth.ts` (and the shared cookie helpers in `scripts/web-auth-protocol.mjs`, `scripts/web-auth-constants.mjs`, `src/lib/web-auth-shared.ts`) — comments say the design is adapted from that project’s launch token and browser-auth |
| dsh-remote mobile layout (same author, per comment) | No URL recorded | Not recorded | `src/lib/remote/assets.json` (injected CSS/JS used by `src/lib/remote/mobile-proxy.ts`) — comments say values and several layout rules follow dsh-remote’s mobile adaptation for DSH, then adjust for PiWeb |
| Pi terminal `@` file completion (`@earendil-works/pi-tui` `CombinedAutocompleteProvider.getFuzzyFileSuggestions` and `extractAtPrefix`) | https://github.com/earendil-works/pi | MIT (bundled SDK) | `src/lib/workspace-index.ts`, with documented differences in `tests/mention-parity.test.ts` |

The official pi terminal is also cited in comments as the behavior to match for several chat input and agent-control details (for example stop / queue handling in `src/components/ChatInput.tsx` and abort behavior in `src/lib/agent-manager.ts`). Those comments describe parity with the same upstream SDK, not a separate vendored copy.

## Compatibility note

`PI_WEB_ALLOWED_HOSTS` is documented in the README and in [docs/operations/environment.md](docs/operations/environment.md) as a legacy environment variable name from upstream `agegr/pi-web`, merged with `PI_WEB_TRUSTED_HOSTS`. This repository does not identify specific source files as copied from that project.

## Thanks

Thanks to [@webkubor](https://github.com/webkubor) for the Ripple and Dawn palettes, and to the authors and contributors of the projects listed above.
