import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../package.json";

// B-04/P4: the published tarball is driven by the package.json `files` whitelist. Next
// writes build-machine diagnostics into `.next` (trace 1.36 MB in the audit tarball, plus
// diagnostics/cache), and the isolated lint toolchain under scripts/testing/lint is a
// development-only tree. All three must stay out of the package, while the license/
// third-party notice files must stay in.
describe("published package file policy", () => {
	it("excludes every build diagnostic the runtime inventory also ignores", () => {
		expect(manifest.files).toContain("!.next/cache");
		expect(manifest.files).toContain("!.next/diagnostics");
		// Covers both .next/trace and .next/trace-build.
		expect(manifest.files).toContain("!.next/trace*");
	});
	it("keeps the pinned lint toolchain out of the installed artifact", () => {
		expect(manifest.files).toContain("scripts");
		expect(manifest.files).toContain("!scripts/testing/lint");
		expect(manifest.files.indexOf("!scripts/testing/lint")).toBeGreaterThan(manifest.files.indexOf("scripts"));
	});
	it("ships the third-party license notice that the npm tarball cannot discover automatically", async () => {
		expect(manifest.files).toContain("THIRD-PARTY-NOTICES.md");
		const notice = await fs.readFile(path.join(process.cwd(), "THIRD-PARTY-NOTICES.md"), "utf8");
		expect(notice).toContain("LGPL");
	});
});
