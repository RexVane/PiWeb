# Pi extensions and optional web interfaces (API v1)

PiWeb uses Pi's official package/resource loader. Optional extensions, skills and prompt templates are not compiled into the PiWeb package. First-party and third-party resources share the public interface documented in [the authoring guide](../public/resources/authoring.md).

The structure is **Pi native capabilities + PiWeb's generic web bridge + user-selected enhancements**. An extension owns its tools, prompts, behavior and optional web assets. With no enhancement installed, Pi's standard interactions use the basic web interface. A resource catalog is only an optional installation list; direct Git/npm installation uses the same package manager.

The Extensions page shows first-party recommendations from [`resources/catalog/index.json`](../resources/catalog/index.json), starting with the optional [Ask user extension](https://github.com/RexVane/piweb-ask-user). Opening the page does not download or install anything. Choose **Install** and confirm to install through Pi; the **Project** tab targets the current workspace, while **All** and **Personal** target all workspaces. To publish another recommendation, add its description and a published Pi install source to the catalog. Pin Git recommendations to a verified commit or release tag.

## Adding a resource

The Extensions toolbar has only **Refresh**. For packages not listed in Recommendations, run `pi install <source>` with an npm, Git, or local source, then use **Refresh** in PiWeb. Personal Git and npm packages go under `~/.pi/agent/git/` and `~/.pi/agent/npm/node_modules/`; project packages go under the current workspace's `.pi/git/` and `.pi/npm/node_modules/`. Local packages are referenced in place.

For an existing extension development workspace, select it on the Extensions page to continue its latest conversation or preview its Web interface. Source is not installed automatically; install the finished directory explicitly through Pi.

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
