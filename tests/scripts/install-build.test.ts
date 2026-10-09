import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStagingDir, stagingParent } from "../../scripts/install-build.mjs";

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempBase() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-install-"));
	cleanups.push(base);
	return base;
}

describe("install-time build staging", () => {
	it("stages above every node_modules segment, so Next does not exclude the copied sources", () => {
		const base = path.resolve("/opt/x");
		expect(stagingParent(path.join(base, "lib", "node_modules", "@rexvane", "piweb"))).toBe(path.join(base, "lib"));
		expect(stagingParent(path.join(base, "lib", "node_modules", "piweb"))).toBe(path.join(base, "lib"));
		expect(stagingParent(path.join(base, "app", "node_modules", "dep", "node_modules", "@rexvane", "piweb"))).toBe(path.join(base, "app"));
		expect(stagingParent(path.join(base, "node_modules_backup", "piweb"))).toBe(path.join(base, "node_modules_backup"));
	});

	it("creates the staging directory next to the installation", () => {
		const base = tempBase();
		fs.mkdirSync(path.join(base, "lib"));
		const staging = createStagingDir(path.join(base, "lib", "node_modules", "@rexvane", "piweb"));
		expect(path.dirname(staging)).toBe(path.join(base, "lib"));
		expect(path.basename(staging)).toMatch(/^\.piweb-build-/);
	});

	it("falls back to the system temp dir when the place next to the installation is unusable", () => {
		const base = tempBase();
		fs.writeFileSync(path.join(base, "not-a-dir"), "");
		const staging = createStagingDir(path.join(base, "not-a-dir", "node_modules", "@rexvane", "piweb"));
		cleanups.push(staging);
		expect(path.dirname(staging)).toBe(os.tmpdir());
		expect(fs.statSync(staging).isDirectory()).toBe(true);
	});
});
