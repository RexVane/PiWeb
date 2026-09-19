# Releasing

Maintainer notes. Users only need `npm install -g @rexvane/piweb`.

Releases are **manual**: pushing to `main` does not publish. Batch your fixes, merge them to `main`, and trigger a release when the batch is ready. The workflow (`.github/workflows/publish.yml`) then:

1. bumps the patch version (`package.json` stays the version source of truth),
2. builds the Windows-only niubash runtime packages from the pinned official portable ZIPs (`scripts/prepare-niubash-packages.mjs`) and publishes them **first** if that exact version is not already on npm (`@rexvane/piweb-niubash-win32-x64` / `-arm64`, currently `1.1.4-piweb.0`),
3. records their integrity in the lockfile, prebuilds `.next`, runs the tarball gate (`npm run verify:package`, which also hashes every runtime file in those platform packages), and publishes `@rexvane/piweb`,
4. pushes the version commit and a `v*` tag back to `main`,
5. creates a GitHub Release for the tag (notes = commit history since the previous tag).

The platform packages are versioned independently of PiWeb (niubash version + a PiWeb distribution suffix) so a PiWeb patch release reuses them. Bump `1.1.4-piweb.0` in `scripts/managed-niubash-assets.mjs`, both `platform-packages/*/package.json`, and the root `optionalDependencies` when the bundled niubash changes.

A version that already exists on npm is bumped past, so re-runs never fail on a duplicate. The workflow ignores its own release commits. Nothing is published when the gate fails.

```bash
# daily work: fix freely on branches / main — nothing is published
git push origin <branch>

# when the batch is ready to ship:
gh workflow run publish --ref main
# afterwards, pull the version bump the workflow committed
git pull --rebase origin main
```

## One-time setup (done)

The repository secret `NPM_TOKEN` (npm Automation token) is configured. Note it expires ~90 days after creation; when CI publishing starts failing with an auth error, generate a new token and refresh the secret:

```bash
gh secret set NPM_TOKEN     # paste the new token when prompted
```

## Skipping or re-running

- To release from a specific commit instead of `main`, publish locally: `npm version patch && npm publish && git push --follow-tags`.
- A failed release can be re-run from Actions → **publish** → *Run workflow*.
