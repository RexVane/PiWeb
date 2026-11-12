# Claude handoff verification

2026-11-12, Asia/Shanghai. Source based on `49bdf3d` plus the previously uncommitted Pi integration and session branch work. Version remains 0.3.30; this handoff does not authorize merging or publishing.

## Completed work

- Finished session branch navigation and labels, extension messages and user shell commands in the trajectory view, extension UI/lifecycle integration, and the additional Pi settings.
- Fixed stale branch data when changing sessions, including late completion of branch/label requests from the previous session.
- Kept the busy state while a user shell command outlives the model turn, and applied deferred resource reloads after the shell command completes.
- Repaired the dependency lock with the missing `@emnapi/runtime@1.11.3` entry, preserving all other locked versions.

## Checks

- Typecheck passed. Full local suite: 158 files and 1350 tests passed, 3 files and 18 tests conditionally skipped. The later five regressions were separately verified along with related coverage: 6 files, 88 tests passed. See `validation-20261112-142631/`.
- Production webpack build passed, including Next's TypeScript validation. Only the existing dynamic-import warnings from `scripts/release.mjs` remain. Build ID: `LuYe8CRVSzlXF-U5cn-1C`. See `production-build.log`.
- Actual packed artifact passed clean global installation, real Pi 1.5.2 SDK import, production startup, home page and first-paint API checks. Artifact: 1417 files, 22.4 MB. See `package-verification.log`.
- Clean installation with Node 22.19.0 and npm 10.9.3 passed after reproducing the original lock failure. Three representative component suites also passed on Node 22.19.0. jsdom still declares a newer engine; the complete cross-platform CI matrix must confirm compatibility. See `lock-validation/`.

## Browser verification

Used a separate agent directory and a synthetic two-branch session. No real model prompt was sent and no user's provider credentials or settings were changed.

- Registered a workspace and created a session successfully; the previous smoke script's HTTP 400 did not recur with the valid Windows path.
- Loaded the formal build, switched to the old branch and back, and saved a label visible in the branch panel.
- Displayed an injected extension message and executed `!echo piweb-handoff-ok`; successful output was stored with exit code 0 and expandable in the chat.
- The initial system-default shell selected an unusable WSL launcher on this machine. Set the test profile's Shell path to the installed Git Bash, then verified the same open session used it successfully. This is a test-environment setting, not a change to the user's configuration or SDK shell detection.
- Created a test custom provider through the development UI, confirmed it appeared in model search, and verified the formal build's custom provider dialog retained its fixed overlay, form styling and footer.
- Verified the provider dialog at the default desktop size and 390 × 844: mobile dialog width 374.4 px, no horizontal content overflow, footer visible. Restored the viewport afterward. See `provider-desktop.png` and `provider-mobile.png`.
- Verified exactly three font choices: Maple, reading preset and Noto Sans SC.

Live model/network proxy behavior against a paid external provider was not exercised. CI results will be recorded separately after the draft PR update; no release workflow is run.
