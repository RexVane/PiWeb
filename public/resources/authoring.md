# PiWeb resource API v1

A PiWeb resource is a normal Pi package. Pi loads its `pi.extensions`, skills and prompt templates. PiWeb only reads the optional `piweb` manifest. Never import PiWeb source files or edit the host package.

```json
{
  "name": "my-resource",
  "type": "module",
  "pi": { "extensions": ["src/index.ts"] },
  "piweb": {
    "apiVersion": 1,
    "id": "my-resource",
    "views": [{ "id": "main", "title": "My resource", "entry": "web/index.html", "placement": "panel", "methods": [] }],
    "host": "src/host.mjs"
  }
}
```

`views` and `host` are optional. A view lives in a dedicated asset directory, not the package root. `placement` is `panel`, `dialog`, `aboveEditor` or `belowEditor`. `methods` can declare standard Pi `select`, `confirm`, `input`, `editor` or `web` request rendering. Users explicitly select a default renderer; load order never chooses it. The entire web/host part is active only while an associated Pi extension is enabled.

## Pi extension entry

Use Pi's `registerTool`, `registerCommand` and events normally. A backend extension detects the public web bridge as follows:

```ts
const web = (ctx.ui as unknown as { resources?: { apiVersion: number; request: Function; invoke: Function } }).resources;
if (web?.apiVersion === 1) {
  const answer = await web.request("my-resource", "main", { items: [] }, { title: "My resource", signal });
  // { status: "answered", value: JSON value } or cancelled/timeout/unavailable
} else {
  // Keep your normal Pi select/confirm/input or TUI implementation.
}
```

`web.invoke(resourceId, action, args)` calls an action owned by an enabled host entry. Tool and command calls are associated with the current workspace and session. An ordinary model text question does not automatically become a request. Register a tool or use Pi's formal UI methods.

Never assume cancellation, timeout or missing UI implies approval. Validate browser values against the options you displayed. Permission extensions must block the actual tool in `tool_call`, including nested calls, not merely display an approval card. Store branch-dependent todo/goal state in Pi entries/tool-result details and reconstruct from the active branch.

## Independent browser entry

Copy `client.js` into your resource's `web/` directory and include it as a **classic** script. Build React/Vue/etc into your own assets if desired; PiWeb is not rebuilt. Use `window.piwebResource`:

- `onContext(callback)` receives `{ viewId, resourceId, scope, cwd, sessionPath?, request?, data?, preview? }`. Passive preview cannot invoke backend actions or approve a request.
- `language` is the selected UI language. Theme variables are supplied as optional hints.
- `answer(value)` returns JSON for custom requests; standard select/input/editor answers must be strings, confirm answers must be booleans.
- `cancel()` closes a request without approval.
- `invoke("action", args)` calls a registered backend action. The parent owns the resource identity, workspace and session; the iframe cannot choose an arbitrary API URL.
- `resize(height)` requests a bounded frame height.

The frame is sandboxed without `allow-same-origin`. No host DOM/cookies, network fetch, arbitrary HTML injection into the main application or automatic permission bypass. A frame is not a sandbox for the Node extension code, which has full host OS permissions. DOM content derived from data must use safe text rendering, not unsanitized HTML.

## Optional host entry

`src/host.mjs` exports `activate(host)`, optionally returning an async cleanup function. No background work at module scope.

- `host.apiVersion`, `id`, `scope`, `cwd`, `agentDir`, `dataDir`, `signal` describe this instance.
- `host.actions.register(name, async (args, context) => value)` registers a JSON action; `context` includes validated cwd and optional sessionPath/signal.
- `host.services.register(name, start)` starts a scoped background resource. `start(signal)` returns a cleanup function. Stop new work on lifecycle abort; finish existing work before cleanup resolves.
- `host.storage.read(name)` and `write(name, JSON)` provide namespaced atomic JSON storage. Preserve data on disable/uninstall.
- `host.paths.resolveWorkspace(path)` validates a workspace through the host's configured boundary.
- `host.sessions.run({ cwd, prompt, title?, model?, timeoutMs?, signal? })` runs an isolated unattended Pi session, waits for settlement and returns `{ sessionPath, status, summary?, error? }`. Human interaction is unavailable and cannot approve work.

Personal host services start at PiWeb startup; project services only after trust and actual session/action use. Resource listing and compatibility review do not execute these entries. Multiple chats share the scoped host service rather than starting multiple schedulers. Runtime API v1 is an initial contract; declare the version and handle unavailable capabilities.

## Resource collections

One Git/npm package may hold multiple optional resources. The containing `package.json` declares all Pi entry paths and sets `piweb: { apiVersion: 1, resources: ["packages/one", "packages/two"] }`. Each member directory has the individual manifest shown above. A catalog item's `selection` chooses exact Pi paths with `extensions`, `skills`, `prompts` and `themes` arrays; later selections from the same source are merged. Enablement is persisted in Pi's own package filters, not in a private web switch. Git updates the collection together; loaded members remain independently selectable. Different tags of one repository do not form independent Pi package identities.

## Development and adaptation

Keep this workspace separate from PiWeb and installation caches. Half-written code must not be auto-loaded. Validate and preview first, then install the completed directory as a local Pi package. Test actions separately from passive preview. For CLI adaptations preserve terminal behavior, record upstream source/version in `piweb-upstream.json`, and never overwrite it on a blind update.
