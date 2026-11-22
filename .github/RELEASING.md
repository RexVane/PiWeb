# Releasing

Release procedure for maintainers. For user installation and rollback, see the [operations guide](../docs/operations/README.md).

Releases are **manual**. Prepare changes on a reviewed feature branch and update the version in `package.json` and `package-lock.json` in the same commit. Merge the release PR only after its checks pass, then trigger [publish.yml](workflows/publish.yml) on `main`. The workflow does not require a particular source branch name.

The workflow:

1. validates the version already merged through the PR and refuses an existing npm version;
2. builds the production bundle and checks a real packed artifact in a clean installation;
3. checks that main still points to the tested source, then runs `prepublishOnly` (typecheck, tests, build and package verification) and publishes to npm;
4. pushes only the version tag and creates a GitHub Release with commit-history notes.

The workflow never commits or pushes to main. Pi runtime packages, including Chord, must be pinned to the same exact tested version so users receive a compatible dependency set.

```bash
# on the release feature branch, before the release commit:
npm version patch --no-git-tag-version
# commit, push the feature branch, and open/merge the PR
# after all checks pass on the merged source:
gh workflow run publish --ref main
# if the feature branch needs the merged source, preserve its history:
git fetch origin
git merge origin/main
```

## Local verification

Use a separate checkout or staging directory with its own build output. `npm run build` writes `.next`; do not run it against the installation serving an active session. Preserve existing user data and uncommitted changes. Use a separate `PI_CODING_AGENT_DIR` for checks, never a directory containing personal model credentials.

The [check workflow](workflows/check.yml) runs Ubuntu and Windows with Node 22.19.0, 22.22.2 and 24, plus a minimal macOS job on Node 24. Node 22.19.0 is the package runtime minimum and is also covered by the development-test matrix. Install with `npm ci`, prepare the SDK's real search tools with `node scripts/testing/prepare-sdk-tools.mjs` while network access is allowed, then run the offline checks. Keep the same temporary agent directory for preparation and testing.

```bash
npm ci --prefix scripts/testing/lint   # pinned lint toolchain (isolated from root TypeScript 7)
npm run typecheck
npm run lint
npm run test
npm run build
npm run verify:package
```

The check workflow also runs `npm audit --audit-level=high` and pins third-party Actions to commit SHAs. See [Operations](../docs/operations/README.md) for environment variables, data isolation, privacy behavior and release rollback guidance.

For coverage, set `PIWEB_COVERAGE=1`, `PIWEB_COVERAGE_REPORT_DIR` to an evidence directory and `PIWEB_TEST_REPORT` to the Vitest JSON report path. After testing, run `node scripts/testing/check-skips.mjs` in the same environment: it reads `PIWEB_TEST_REPORT`, not a positional filename argument. Missing required SDK tools or native Windows coverage must not be hidden by adding permissive skips. Public tunnel verification is separately enabled with `PIWEB_TEST_TUNNEL=1`; run it only against isolated fixture data, not a user's live port.

`verify:package` checks the actual packed tarball, installs it into an empty global prefix with lifecycle scripts disabled, and starts the installed copy using isolated data. It verifies the compatible Pi runtime set, authentication and first-paint APIs. It does not replace browser interaction checks, an actual public tunnel probe, or production plugin mutation checks. For installation/auth/native changes, also verify a relocated installed copy; for npm plugin transactions, verify install → update → remove through authenticated APIs with a local fixture registry and check retained generations and settings.

Record the tested source fingerprint or commit, build ID, passed/failed/skipped counts, coverage and platform. Results from a different commit do not certify the current release candidate.

## Local release builds and cleanup

`npm run build:release` prepares an isolated `.next-releases/<id>` and seals a file-hash inventory before promotion. Startup validates the selected build. A failed/in-progress selection can use its validated `previous` output, or a complete `.next` when no previous output exists; malformed active JSON can recover the separately persisted `last-ready.json`. This is distinct from the `.next` artifact packed for npm.

Before removing generated directories, identify the active selection, previous/last-ready selections, lock/process owners and any build still in use. Preserve referenced outputs and audit logs, JSON reports and recovery evidence. A directory not named by `active.json` is not automatically disposable. Follow the project's deletion/backup rules for the specific confirmed paths; do not copy CI's cleanup commands into a user's working installation. Reaching the retained-release limit stops new builds without automatically deleting prior releases.

## Credentials

Publishing uses the repository secret `NPM_TOKEN`. Refresh an expired token through `gh secret set NPM_TOKEN`; never put credentials in source or release notes.

Production authentication stays enabled by default. Installed checks must acquire their own local launch credential and cookie. The launcher does not print token-bearing login URLs, so do not scrape logs for credentials or disable authentication to make a release probe pass.

## Retrying

A failure before npm accepts the version can be retried with the same version. If npm publication succeeded but tagging or GitHub Release creation failed, complete the missing steps for that tested commit instead of republishing. Prepare subsequent version changes through another PR.
