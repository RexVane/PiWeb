#!/usr/bin/env node
/**
 * npm postinstall hook: prepare the production build for production-only installs.
 * The same helper also runs from the first `piweb` start, so installs that skip
 * lifecycle scripts heal themselves on first use.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInstallBuild } from "./install-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
ensureInstallBuild(root);
