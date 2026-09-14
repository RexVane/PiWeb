# Releasing

Maintainer notes. Users only need `npm install -g piweb`.

Every push to `main` is a release, handled by `.github/workflows/publish.yml`:

1. bump the patch version (`package.json` stays the version source of truth),
2. run the `prepublishOnly` gate (`npm run check`: typecheck + tests + build) and publish to npm,
3. push the version commit and a `v*` tag back to `main`.

A version that already exists on npm is bumped past, so re-runs and concurrent pushes never fail on a duplicate. The workflow ignores its own release commits. Nothing is published when the gate fails.

```bash
# normal development: the release happens on push
git push origin main
# afterwards, pull the version bump the workflow committed
git pull --rebase origin main
```

## One-time setup

Create an npm **Automation token** (npmjs.com → Access Tokens) and store it as the repository secret `NPM_TOKEN`:

```bash
gh secret set NPM_TOKEN     # paste the token when prompted
```

Without it the publish step fails with an authentication error; the run stops there and nothing is committed or published.

## Skipping or re-running

- Skip a release for one push (for example a docs-only commit): include `[skip ci]` in the commit message.
- Re-run a failed release: Actions → **publish** → *Run workflow* (a manual run also bumps the version).
- To release from a specific commit instead of `main`, publish locally: `npm version patch && npm publish && git push --follow-tags`.
