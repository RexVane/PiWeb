# Releasing

Maintainer notes. Users only need `npm install -g @rexvane/piweb`.

Releases are **manual**: pushing to `main` does not publish. Batch your fixes, merge them to `main`, and trigger a release when the batch is ready. The workflow (`.github/workflows/publish.yml`) then:

1. bumps the patch version (`package.json` stays the version source of truth),
2. runs the `prepublishOnly` gate (`npm run check`: typecheck + tests + build) and publishes to npm,
3. pushes the version commit and a `v*` tag back to `main`.

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
