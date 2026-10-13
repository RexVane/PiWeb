# Releasing

Maintainer notes. Users only need `npm install -g @rexvane/piweb`.

Releases are **manual**. Prepare changes on `rexvane-piweb`, update the version in `package.json` and `package-lock.json`, and append the matching entry to `docs/state/progress.md` in the same commit. Merge the release PR only after its checks pass, then trigger `.github/workflows/publish.yml` on `main`.

The workflow:

1. validates the version already merged through the PR and refuses an existing npm version;
2. builds the production bundle and checks a real packed artifact in a clean installation;
3. checks that main still points to the tested source, then runs the typecheck/test publish gate and publishes to npm;
4. pushes only the version tag and creates a GitHub Release with commit-history notes.

The workflow never commits or pushes to main. Pi runtime packages, including Chord, must be pinned to the same exact tested version so users receive a compatible dependency set.

```bash
# on rexvane-piweb, before the release commit:
npm version patch --no-git-tag-version
# update progress.md, commit, push the feature branch, and open/merge the PR
# after all checks pass on the merged source:
gh workflow run publish --ref main
# synchronize the feature branch through a merge, never rebase:
git fetch origin
git merge origin/main
```

## Credentials

Publishing uses the repository secret `NPM_TOKEN`. Refresh an expired token through `gh secret set NPM_TOKEN`; never put credentials in source or release notes.

## Retrying

A failure before npm accepts the version can be retried with the same version. If npm publication succeeded but tagging or GitHub Release creation failed, complete the missing steps for that tested commit instead of republishing. Prepare subsequent version changes through another PR.
