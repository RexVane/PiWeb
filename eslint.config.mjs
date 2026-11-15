/**
 * Thin root config: the pinned lint toolchain (and its plugins/TypeScript 6 parser) lives
 * in scripts/testing/lint so it cannot conflict with the root TypeScript 7 build toolchain.
 * `npm run lint` installs that toolchain on demand; plain `npx eslint` also works once
 * `npm ci --prefix scripts/testing/lint` has run.
 */
export { default } from "./scripts/testing/lint/eslint.config.mjs";
