import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sha = process.env.PIWEB_TEST_ASK_USER_SHA;
if (!sha || !/^[a-f\d]{40}$/i.test(sha)) throw new Error("Set PIWEB_TEST_ASK_USER_SHA to the complete 40-character candidate commit before running GitHub resource acceptance.");
const hostSourceRoot = path.resolve(process.env.PIWEB_TEST_HOST_ROOT ?? fileURLToPath(new URL("./src", import.meta.url)));
const inlineHostSource = new RegExp(hostSourceRoot.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/");

/** Deliberately opt-in: this acceptance acquires its resource from the real GitHub repository. */
export default defineConfig({
	resolve: { alias: { "@": hostSourceRoot } },
	test: {
		environment: "node", include: ["tests/resources/github-install.github.ts"], maxWorkers: 1, fileParallelism: false,
		// An installed tarball's TypeScript source also needs Vite transformation.
		server: { deps: { inline: [inlineHostSource] } },
		env: { NODE_ENV: "test", PIWEB_HTTP_GUARD: "0", PI_OFFLINE: "1", PIWEB_TEST_HOST_ROOT: hostSourceRoot },
		testTimeout: 240_000, hookTimeout: 90_000,
	},
});
