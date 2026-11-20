# Independent resources and resource market (API v1)

PiWeb uses Pi's official package/resource loader. Optional extensions, skills and prompt templates are not compiled into the PiWeb package. First-party and third-party resources share the public interface documented in [the authoring guide](../public/resources/authoring.md).

The first-party catalog and source are in [RexVane/piweb-resources](https://github.com/RexVane/piweb-resources).

## Adding a resource

**Add extension ▾** has two choices:

- **Install existing**: PiWeb market, Pi package gallery link, or npm/Git/local source. The market can filter extensions, skills and templates. Installations still use Pi's package manager and personal/project scope.
- **Design your own**: choose a source directory once, create a separate workspace, open a real session and send a visible design request. No instruction is injected into unrelated sessions and unfinished code is not auto-loaded.

Static compatibility inspection acquires source without executing extension factories or npm lifecycle scripts. It may identify terminal-only UI, but cannot prove safety or complete compatibility. Adaptation works in a separate source copy, preserves provenance and does not edit installation caches or the PiWeb package.

A **passive preview** reads a declared browser view from the chosen development workspace without installing its Pi extension or starting a host service. Preview frames cannot call backend actions. Real execution must be tested separately after deliberate installation.

## One GitHub collection, independent selections

A repository may contain multiple resources:

```json
{
  "pi": { "extensions": ["packages/question/src/index.ts", "packages/tasks/src/index.ts"] },
  "piweb": { "apiVersion": 1, "resources": ["packages/question", "packages/tasks"] }
}
```

Each directory contains its own package manifest and optional `piweb` web/host declaration. Paths must remain in the containing package, including through symlinks.

A catalog item can declare `selection` using Pi's exact resource paths:

```json
{
  "source": "git:github.com/owner/resources",
  "selection": { "extensions": ["packages/question/src/index.ts"], "skills": [], "prompts": [], "themes": [] }
}
```

PiWeb acquires the containing package without briefly enabling it wholesale, validates the selected paths against Pi's declared resources and stores the filter in Pi's `settings.packages`. Installing another item from that source merges the selected resources. An individual switch edits that same Pi filter. No private enable flag or separate extension loader is involved.

Git downloads and updates the source collection together. This does **not** mean every extension runs. Pi identifies Git packages by repository URL without tag; different tags of one repository are not independent package identities.

## Web interface

Simple interfaces can use the existing JSON UI bridge. A resource may also ship its own HTML/JS/CSS bundle and declare a dialog, composer slot or panel. Installing it does not rebuild PiWeb.

The browser entry runs in an opaque-origin iframe. A per-instance message token and frame-source check protect the parent bridge. It can return an answer, cancel, request bounded height or invoke an action owned by its resource in the parent-selected workspace/session. It cannot choose arbitrary host API URLs, access the host DOM/cookies or bypass authorization.

A standard Pi select/confirm/input/editor renderer is selected explicitly by the user, not by tool name or load order. Missing or failed interfaces retain a basic fallback; a missing answer never approves an operation. Ordinary model text questions do not automatically become formal requests.

Sandboxed subresource requests do not carry SameSite login cookies. After an authenticated entry request, PiWeb issues a short-lived capability restricted to that view's static assets. It is bound to the request authority and login revocation epoch/device, and cannot authorize other API routes or mutations. Disabled resources and out-of-bounds assets remain unavailable.

## Host services and data

Only enabled, trusted Pi package members can activate host entries. Browsing resources does not execute them. Personal services start with PiWeb; project services start only after trusted session/action use. Multiple chats share one scoped service.

The public host API provides action registration, service lifecycle, namespaced atomic JSON storage, workspace validation and isolated unattended session execution. A stopped resource rejects new work and keeps its running slot until active work finishes/stops. Local helper code reloads from verified content-addressed snapshots, avoiding native ESM cache reuse. External/native dependency changes may require a safe process restart, not a rebuild.

Backend extensions still have full host OS permissions. Browser isolation is **not** a backend sandbox. Permission resources must block the real Pi tool call; an approval-looking UI alone is not enforcement.

Question and automation business code resides in the resource collection. Old automation storage is not auto-imported, erased or scheduled twice: stop the old scheduler, preview its store and explicitly confirm import. IDs, schedules and session references are retained.

## Validation

- `npm run typecheck`
- `npx vitest run tests/resources tests/components/resources`
- With the separate resource checkout available: `PIWEB_TEST_RESOURCES_DIR=/absolute/path/to/piweb-resources/packages npx vitest run tests/resources/independent-sdk.test.ts`
- In the resource repository: install development dependencies, `npm run build`, `npm test`.

Use a staging checkout for a production build; never overwrite a running service's `.next` directory.
