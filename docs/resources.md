# Pi extensions and optional web interfaces (API v1)

PiWeb uses Pi's official package/resource loader. Optional extensions, skills and prompt templates are not compiled into the PiWeb package. First-party and third-party resources share the public interface documented in [the authoring guide](../public/resources/authoring.md).

The structure is **Pi native capabilities + PiWeb's generic web bridge + user-selected enhancements**. An extension owns its tools, prompts, behavior and optional web assets. With no enhancement installed, Pi's standard interactions use the basic web interface. A resource catalog is only an optional installation list; direct Git/npm installation uses the same package manager.

The first-party catalog is [`resources/catalog/index.json`](../resources/catalog/index.json) in this repository; the optional question resource lives in [RexVane/piweb-ask-user](https://github.com/RexVane/piweb-ask-user).

## Adding a resource

**Add extension ▾** has two choices:

- **Install existing**: use a catalog entry or give Pi an npm, Git or local source. Pi's package manager installs the original source. Personal Git and npm packages go under `~/.pi/agent/git/` and `~/.pi/agent/npm/node_modules/`; project packages go under the current workspace's `.pi/git/` and `.pi/npm/node_modules/`. Local packages are referenced in place.
- **Design your own**: choose a source directory once, create a separate workspace, open a real session and send a visible design request. No instruction is injected into unrelated sessions and unfinished code is not auto-loaded.

Paste a Git repository link or an npm package page link, or choose a local folder from the PiWeb host. Local connections use the system folder picker when available; remote connections use the in-app browser. The install form links to the Pi package gallery and keeps inspection and adaptation under **Advanced options**. Static compatibility inspection acquires source without executing extension factories or npm lifecycle scripts. It may identify terminal-only UI, but cannot prove safety or complete compatibility. Inspection and adaptation use a separate source copy; neither changes the source or destination of the **Install** action. Install a completed adaptation explicitly by giving Pi its local path.

A **passive preview** reads a declared browser view from the chosen development workspace without installing its Pi extension or starting a host service. Preview frames cannot call backend actions. Real execution must be tested separately after deliberate installation.

## Separate resources and optional collections

The first-party optional question resource lives in its own repository ([RexVane/piweb-ask-user](https://github.com/RexVane/piweb-ask-user)). Multi-resource repositories are also supported by declaring member directories:

```json
{
  "pi": { "extensions": ["packages/question/src/index.ts", "packages/service/src/index.ts"] },
  "piweb": { "apiVersion": 1, "resources": ["packages/question", "packages/service"] }
}
```

Each resource directory contains its own package manifest and optional `piweb` web/host declaration. Paths must remain in the containing package, including through symlinks.

A catalog item can declare `selection` using Pi's exact resource paths (for either a standalone package like `src/index.ts` or selected members of a collection):

```json
{
  "source": "git:github.com/owner/resources",
  "selection": { "extensions": ["packages/question/src/index.ts"], "skills": [], "prompts": [], "themes": [] }
}
```

PiWeb acquires the package without briefly enabling extra entries wholesale, validates the selected paths against Pi's declared resources and stores the filter in Pi's `settings.packages`. Installing another item from the same source merges the selected resources. An individual switch edits that same Pi filter. No private enable flag or separate extension loader is involved.

Git downloads and updates a source repository together. This does **not** mean every member extension in a collection runs. Pi identifies Git packages by repository URL without tag; different tags of one repository are not independent package identities.

## Web interface

Simple interfaces can use the existing JSON UI bridge. A resource may also ship its own HTML/JS/CSS bundle and declare a dialog, composer slot or panel. Installing it does not rebuild PiWeb.

The browser entry runs in an opaque-origin iframe. A per-instance message token and frame-source check protect the parent bridge. It can return an answer, cancel, request bounded height or invoke an action owned by its resource in the parent-selected workspace/session. It cannot choose arbitrary host API URLs, access the host DOM/cookies or bypass authorization.

The Extensions screen manages installed Pi packages through their package rows. Standard Pi select/confirm/input/editor interactions use the built-in interface by default; the bridge honors an explicit renderer preference when configured and falls back if that renderer is unavailable or fails. A missing answer never approves an operation. Ordinary model text questions do not automatically become formal requests.

Each new standard request checks renderer compatibility. An active request retains its selected view and placement while discovery refreshes, preserving drafts. Disabling/uninstalling a resource revokes its requests. Theme, language and outer viewport updates do not recreate a frame. Optional focus requests are granted only while the page focus is idle or already belongs to the requesting frame.

Installation and switches persist through Pi settings. Busy sessions reload after their current turn. Returning to an older conversation branch no longer drops currently registered, default-active package tools just because that branch recorded an earlier tool list. A failed runtime refresh is reported as **configuration saved, refresh incomplete**, retains a bounded retry, and prevents a new model turn from using stale tools or prompts. Existing conversation history is retained; disabling removes the extension's contributions from subsequent runtime prompts rather than erasing past messages.

Sandboxed subresource requests do not carry SameSite login cookies. After an authenticated entry request, PiWeb issues a short-lived capability restricted to that view's static assets. It is bound to the request authority and login revocation epoch/device, and cannot authorize other API routes or mutations. Disabled resources and out-of-bounds assets remain unavailable.

## Host services and data

Only enabled, trusted Pi package members can activate host entries. Browsing resources does not execute them. Personal services start with PiWeb; project services start only after trusted session/action use. Within one PiWeb process, multiple chats share the same scoped host service instance.

The public host API provides action registration, service lifecycle, namespaced atomic JSON storage, workspace validation and isolated unattended session execution. A stopped resource rejects new work and keeps its running slot until active work finishes/stops. Local helper code reloads from verified content-addressed snapshots, avoiding native ESM cache reuse. External/native dependency changes may require a safe process restart, not a rebuild.

Backend extensions still have full host OS permissions. Browser isolation is **not** a backend sandbox. Permission resources must block the real Pi tool call; an approval-looking UI alone is not enforcement.

Question business code lives in the independent `piweb-ask-user` repository and uses the same public API as third-party resources.

## Validation

- `npm run typecheck`
- `npx vitest run tests/resources tests/components/resources`
- With the standalone ask-user checkout available, set `PIWEB_TEST_RESOURCES_DIR` to its repository root (containing `src/index.ts`): `PIWEB_TEST_RESOURCES_DIR=/absolute/path/to/piweb-ask-user npx vitest run tests/resources/independent-sdk.test.ts`
- In the `piweb-ask-user` repository: install development dependencies and run `npm test`.

Use a staging checkout for a production build; never overwrite a running service's `.next` directory.
