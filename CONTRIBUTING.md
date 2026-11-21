# Contributing to PiWeb

Thanks for your interest in contributing. This guide describes how to work on the repository as it exists today. It is a reference, not a formal policy.

Issues and pull requests are welcome at [github.com/RexVane/PiWeb](https://github.com/RexVane/PiWeb). For a large change, open an issue first so the approach can be discussed.

## Development environment

- **Node.js ≥ 22.19.0** is required (`engines` in `package.json`). Node 24 is recommended. CI in [`.github/workflows/check.yml`](.github/workflows/check.yml) runs 22.19.0, 22.22.2, and 24 on Ubuntu and Windows, plus a smaller Node 24 job on macOS.
- **npm** is the package manager used in this repo (`package-lock.json`, `npm ci` in CI).
- **Git** is needed for project growth-history features and for the usual clone/PR workflow.

Clone the repository and install development dependencies from a source checkout:

```bash
git clone https://github.com/RexVane/PiWeb.git
cd PiWeb
npm ci
```

`npm ci` is the command CI uses. A source checkout's `postinstall` hook is a no-op; it only prepares a sealed production build for production package installs.

Use a **separate checkout or staging directory** when you also run a production `piweb` instance: `npm run build` writes `.next` and must not overwrite the build directory of a running server.

To keep experiments out of your real agent data (`~/.pi/agent` by default), point the process at a temporary directory:

```bash
export PI_CODING_AGENT_DIR="$PWD/.piweb-dev-agent"
```

See [docs/operations/data-and-privacy.md](docs/operations/data-and-privacy.md) for the full data map.

## Running locally

The published command is `piweb`. In a source checkout the same entry is `npm start` (`node bin/piweb.js`).

Development mode starts the Next.js dev server through the launcher, bound to loopback only (`--dev` / `PI_WEB_DEV=1`). `npm run dev` is the documented script; it calls `scripts/dev.mjs`, which invokes the launcher with `--dev --no-open` so the dev server does not auto-open a browser:

```bash
npm run dev
```

Equivalent forms:

```bash
npx piweb --dev --no-open
# or, after a global/package install:
piweb --dev
```

The default URL is `http://127.0.0.1:30141` (the port auto-increments if busy). The launcher opens a login URL with a one-time launch token when it is allowed to open a browser; with `--no-open`, use the URL the launcher prints or run `piweb` again on the same port to sign in. Development mode **rejects a non-loopback bind**, because the Next.js dev endpoints are not protected by the launch-token scheme.

Useful launcher flags are listed in the [README](README.md#usage-and-remote-access): `-p` / `--port`, `-H` / `--hostname`, `--public-url`, `--dev`, `--no-open`, `-h` / `--help`.

## Project structure

| Path | Role |
| --- | --- |
| `bin/piweb.js` | Published CLI entry. Delegates to `scripts/launcher.mjs`. |
| `bin/pi.js` | Source-tree helper (`pi web` forwards to `piweb.js`). Not registered in `package.json` `bin`. |
| `scripts/` | Launcher, `dev.mjs`, production build, `postinstall`, release, package verification, proxy/auth helpers, and the pinned lint toolchain under `scripts/testing/lint/`. |
| `src/app/` | Next.js App Router pages, login/pair routes, and `src/app/api/` route handlers. |
| `src/components/` | React UI (chat, composer, settings, workspace, and related views). |
| `src/hooks/` | Client hooks. |
| `src/lib/` | Server and domain logic: auth, remote access, sessions, import, resources, git, models, updates, and related modules. |
| `src/i18n.tsx`, `src/i18n-locales/` | UI strings (English, Simplified Chinese, Traditional Chinese, Japanese, Russian). |
| `src/instrumentation.ts`, `src/instrumentation-node.ts` | Server startup: publish the launch token, prepare the LAN entry, update check, first-page warmup. |
| `tests/` | Vitest tests (`tests/**/*.test.{ts,tsx}`). |
| `docs/` | Product and operations documentation; start at [docs/README.md](docs/README.md). |
| `examples/piweb-extensions/` | Runnable extension examples. |
| `public/` | Static assets, including vendored file and provider icons. |
| `assets/` | Screenshots used by the READMEs. |
| `.github/workflows/` | `check.yml` (required-style CI), `publish.yml` (npm release), `remote-e2e.yml` (public tunnel / pairing tests). |

## Architecture

PiWeb is a Next.js 16 + React 19 TypeScript web shell around the official `@earendil-works/pi-*` SDK. The short runtime picture:

`piweb` → `bin/piweb.js` → `scripts/launcher.mjs` (port, launch token, child env) → Next.js server → `src/instrumentation-node.ts` (token, LAN/tunnel preparation when auth is on, update check, warmup).

Authentication exchanges a one-time launch token for an HMAC-signed HttpOnly session cookie. Production startup can prepare a LAN proxy and a Cloudflare quick tunnel for remote access. PiWeb shares the agent directory (`~/.pi/agent` or `PI_CODING_AGENT_DIR`) with a separately installed `pi` CLI; it does not replace that CLI.

The [README “How it works”](README.md#how-it-works) and [usage and remote access](README.md#usage-and-remote-access) sections describe this in more detail. Extension UI behavior is documented in [docs/extension-web-ui.md](docs/extension-web-ui.md).

## Coding conventions

These are the conventions that are actually encoded in the repository:

- **TypeScript, strict mode.** `tsconfig.json` sets `"strict": true`, `target` ES2022, `module` / `moduleResolution` for the Next.js bundler, and the `@/*` path alias to `src/*`.
- **Lint.** `npm run lint` runs the pinned toolchain in `scripts/testing/lint/` (root `eslint.config.mjs` re-exports it so the lint TypeScript parser does not conflict with the TypeScript 7 build toolchain). In `src/`, `react-hooks/rules-of-hooks` is an error; `react-hooks/exhaustive-deps` and `@next/next/no-img-element` are warnings. Several recommended rules are explicitly left off in that config because of a recorded backlog — do not “clean up” those rule exceptions in an unrelated PR unless you are also fixing the backlog they describe.
- **EditorConfig.** [`.editorconfig`](.editorconfig) uses UTF-8, LF, a final newline, and trimmed trailing whitespace (trailing whitespace is kept in Markdown).
- There is **no Prettier (or other formatter) config** in the repository. Match the surrounding file’s style.

UI strings for new user-visible text should be added to the existing i18n dictionaries so all five interface languages stay in sync.

## Checks to run before a pull request

From `package.json`, these scripts are the ones to run locally:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

`npm run check` is `typecheck && test && build` (it does not include lint). `npm run verify:package` packs the production build, installs it in an empty prefix, and starts that copy with temporary data — CI runs it as well.

The `check` workflow additionally:

- installs the pinned lint toolchain and runs `npm run lint` with `PIWEB_LINT_SKIP_INSTALL=1`;
- runs `npm audit --omit=dev --audit-level=high` on Linux / Node 24;
- prepares SDK search tools;
- enables coverage with `PIWEB_COVERAGE=1` and rejects unexpected skipped tests;
- runs a narrower path-sensitive test subset on macOS rather than a full production build.

Public tunnel testing lives in `.github/workflows/remote-e2e.yml` and is separate from the main `check` job. Build times and timeouts are in [docs/operations/install-and-build.md](docs/operations/install-and-build.md).

Please run at least `typecheck`, `lint`, and `test` before opening a PR. Include tests when you change behavior.

## Branches, commits, and pull requests

There is no required branch-name or commit-message format in this repository. In general:

- Branch off the default branch (`main`) and open a pull request against it.
- Use a short, descriptive branch name and commit messages that say what changed and why.
- Keep the PR focused. Documentation-only changes should not mix in unrelated code edits, and the reverse is also easier to review when separated.
- Do not force-push to `main`. Releases are documented in [`.github/RELEASING.md`](.github/RELEASING.md).

## Bugs and security reports

- **Bugs and feature requests:** open a [GitHub Issue](https://github.com/RexVane/PiWeb/issues). Include the PiWeb version, Node.js version, operating system, and steps to reproduce when you can. This repository does not currently ship issue templates.
- **Security issues:** there is no `SECURITY.md` and no dedicated security contact in the repository. Please do not open a public issue that includes secrets, credentials, or a working exploit. Prefer GitHub’s private vulnerability reporting for this repository if it is available, or contact a maintainer privately.

## Documentation and credits

- [README](README.md) — install, features, configuration, and remote access.
- [docs/README.md](docs/README.md) — documentation index.
- [docs/operations/install-and-build.md](docs/operations/install-and-build.md)
- [docs/operations/environment.md](docs/operations/environment.md)
- [docs/operations/data-and-privacy.md](docs/operations/data-and-privacy.md)
- [docs/operations/release-and-rollback.md](docs/operations/release-and-rollback.md)
- [docs/extension-web-ui.md](docs/extension-web-ui.md)
- [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) — upstream projects and referenced work.
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — third-party dependency licenses.

## License

PiWeb is released under the [MIT License](LICENSE).
