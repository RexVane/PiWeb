# Chat layout and model scope

This note documents the chat and model-picker improvements in this branch.

## Resizable conversation column

- Drag either vertical handle at the edge of the conversation to adjust its width.
- Focus a handle and use the left/right arrow keys to resize in 24 px steps.
- The selected width is saved in browser `localStorage` (`piweb.chatContentWidth`) and restored on later visits in that browser.
- Width is constrained to a readable range and the handles are hidden on narrow viewports; narrow screens continue to use the full available width.

## Pi model scope in the picker

The normal PiWeb model-list endpoint applies Pi's agent-level `enabledModels` patterns using the Pi SDK's model-scope resolver. Models outside that scope are omitted from the normal picker, and provider model counts reflect the filtered list. If the setting is absent or invalid, the catalog is left unchanged. The full catalog remains available to the provider/model settings editor (`custom=1`).

## Copying code blocks

Rendered Markdown code blocks have a copy button. It shares the same copy component as message actions, including copied and copy-failed feedback, and copies the rendered code text. Inline code remains unchanged.

## Validation

The branch's typecheck, Vitest suite, and production build were run with:

```sh
npm run check
```
